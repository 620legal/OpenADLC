import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GapTask } from '@openadlc/db';
import { BRIDGE_HEARTBEAT_MS, startGap, startHeartbeat, type GapStore } from './bridge-gap.js';
import type { Drift } from './reconciler.js';

const BACK = '2026-11-02T10:05:00.000Z';
const ago = (ms: number) => new Date(Date.parse(BACK) - ms).toISOString();

function fakeStore(lastUpAt: string | null) {
  const gaps: { id: string; lastUpAt: string; backAt: string; tasks: GapTask[] }[] = [];
  const store: GapStore = {
    beat: vi.fn(async () => ({ lastUpAt, backAt: BACK })),
    openGap: vi.fn(async (last: string, back: string) => {
      gaps.push({ id: 'gap-1', lastUpAt: last, backAt: back, tasks: [] });
      return { id: 'gap-1' };
    }),
    addTasks: vi.fn(async (id: string, tasks: readonly GapTask[]) => {
      gaps.find((gap) => gap.id === id)!.tasks.push(...tasks);
    }),
  };
  return { store, gaps };
}

const ORPHAN: Drift = { kind: 'orphaned_task', subject: 'openadlc#50', taskId: 'task-50', detail: 'the task was marked running but its host has stopped reporting', repaired: true };

function deps(options: { resumed?: { id: string; subjectRef: string }[]; drift?: Drift[] | Error } = {}) {
  return {
    resume: vi.fn(async (onResumed: (task: { id: string; subjectRef: string }, line: string) => void) => {
      const lines = (options.resumed ?? []).map((task) => `resumed implement on ${task.subjectRef}`);
      (options.resumed ?? []).forEach((task, index) => onResumed(task, lines[index]!));
      return lines;
    }),
    reconcile: vi.fn(async () => {
      if (options.drift instanceof Error) throw options.drift;
      return options.drift ?? [];
    }),
    log: vi.fn(),
    warn: vi.fn(),
  };
}

describe('the bridge start after a gap', () => {
  it('stores no report on an install’s first start, and resumes as before without reconciling', async () => {
    const { store, gaps } = fakeStore(null);
    const start = deps({ resumed: [{ id: 'task-1', subjectRef: 'openadlc#7' }] });

    expect(await startGap(store, start)).toEqual({ gapId: null });

    expect(gaps).toEqual([]);
    expect(start.resume).toHaveBeenCalledTimes(1);
    expect(start.log).toHaveBeenCalledWith('resumed implement on openadlc#7');
    expect(start.reconcile).not.toHaveBeenCalled();
  });

  it('stores no report when the last beat is within one interval', async () => {
    const { store, gaps } = fakeStore(ago(10_000));
    const start = deps({ drift: [ORPHAN] });
    await startGap(store, start);
    expect(gaps).toEqual([]);
    expect(start.reconcile).not.toHaveBeenCalled();

    const exactly = fakeStore(ago(BRIDGE_HEARTBEAT_MS));
    await startGap(exactly.store, deps());
    expect(exactly.gaps).toEqual([]);
  });

  it('stores the gap with the tasks it resumed and the orphans reconcile ended, each with why', async () => {
    const { store, gaps } = fakeStore(ago(5 * 60_000));
    const start = deps({
      resumed: [{ id: 'task-1', subjectRef: 'openadlc#7' }],
      drift: [
        ORPHAN,
        // Reported but not ended: nothing this start did to it.
        { kind: 'orphaned_task', subject: 'openadlc#51', taskId: 'task-51', detail: 'the task was recorded but never handed to a host', repaired: false },
        { kind: 'stale_labels', subject: 'openadlc#52', detail: 'labels differ', repaired: true },
      ],
    });

    expect(await startGap(store, start)).toEqual({ gapId: 'gap-1' });

    expect(gaps).toEqual([
      {
        id: 'gap-1',
        lastUpAt: ago(5 * 60_000),
        backAt: BACK,
        tasks: [
          { taskId: 'task-1', subject: 'openadlc#7', outcome: 'resumed', why: 'resumed implement on openadlc#7', backAt: BACK },
          { taskId: 'task-50', subject: 'openadlc#50', outcome: 'orphaned', why: ORPHAN.detail, backAt: BACK },
        ],
      },
    ]);
    // Stored before anything else, so a start that dies part way still says how long.
    expect(vi.mocked(store.openGap).mock.invocationCallOrder[0]).toBeLessThan(start.resume.mock.invocationCallOrder[0]!);
  });

  it('stores a gap that cost nothing, with no tasks', async () => {
    const { store, gaps } = fakeStore(ago(5 * 60_000));
    await startGap(store, deps());
    expect(gaps).toEqual([{ id: 'gap-1', lastUpAt: ago(5 * 60_000), backAt: BACK, tasks: [] }]);
    expect(store.addTasks).not.toHaveBeenCalled();
  });

  it('keeps the stored gap when reconcile throws, and says so', async () => {
    const { store, gaps } = fakeStore(ago(5 * 60_000));
    const start = deps({ resumed: [{ id: 'task-1', subjectRef: 'openadlc#7' }], drift: new Error('GitHub is down') });

    await startGap(store, start);

    expect(gaps[0]?.tasks.map((task) => task.taskId)).toEqual(['task-1']);
    expect(start.warn).toHaveBeenCalledWith('could not list the orphaned tasks in the gap report: GitHub is down');
  });

  it('still resumes when the heartbeat cannot be read', async () => {
    const { store } = fakeStore(null);
    vi.mocked(store.beat).mockRejectedValueOnce(new Error('the database is not answering'));
    const start = deps({ resumed: [{ id: 'task-1', subjectRef: 'openadlc#7' }] });

    expect(await startGap(store, start)).toEqual({ gapId: null });

    expect(start.resume).toHaveBeenCalledTimes(1);
    expect(start.warn).toHaveBeenCalledWith('could not record when it was last running: the database is not answering');
  });
});

describe('the bridge heartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('beats every interval, and once more when stopped', async () => {
    vi.useFakeTimers();
    const touch = vi.fn(async () => undefined);
    const heartbeat = startHeartbeat(touch);

    await vi.advanceTimersByTimeAsync(BRIDGE_HEARTBEAT_MS * 2);
    expect(touch).toHaveBeenCalledTimes(2);

    await heartbeat.stop();
    expect(touch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(BRIDGE_HEARTBEAT_MS * 2);
    expect(touch).toHaveBeenCalledTimes(3);
  });
});
