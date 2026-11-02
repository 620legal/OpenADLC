import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GapTask } from '@openadlc/db';
import { BRIDGE_HEARTBEAT_MS, startGap, startHeartbeat, type GapStore } from './bridge-gap.js';
import type { Drift } from './reconciler.js';

const BACK = '2026-11-02T10:05:00.000Z';
const ago = (ms: number) => new Date(Date.parse(BACK) - ms).toISOString();

function fakeStore(lastUpAt: string | null, left?: { backAt: string; tasks: GapTask[] }) {
  const gaps: { id: string; lastUpAt: string; backAt: string; tasks: GapTask[] }[] = left ? [{ id: 'gap-0', lastUpAt: ago(5 * 60_000), ...left }] : [];
  // A report left by a start that died before it finished listing.
  const state = { filling: Boolean(left), dismissed: false };
  const store: GapStore = {
    beat: vi.fn(async () => ({ lastUpAt, backAt: BACK })),
    openGap: vi.fn(async (last: string, back: string) => {
      gaps.push({ id: 'gap-1', lastUpAt: last, backAt: back, tasks: [] });
      state.filling = true;
      return { id: 'gap-1' };
    }),
    addTasks: vi.fn(async (id: string, tasks: readonly GapTask[]) => {
      gaps.find((gap) => gap.id === id)!.tasks.push(...tasks);
    }),
    finish: vi.fn(async () => {
      state.filling = false;
    }),
    current: vi.fn(async () => {
      const gap = gaps.at(-1);
      return gap && !state.dismissed ? { id: gap.id, backAt: gap.backAt, filling: state.filling } : null;
    }),
  };
  // As `bridgeGaps.dismiss` answers: refused while the start is still listing.
  const dismiss = () => {
    if (state.filling) return 'filling';
    state.dismissed = true;
    return 'dismissed';
  };
  return { store, gaps, state, dismiss };
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
    expect(store.finish).toHaveBeenCalledTimes(1);
  });

  it('is filling, and cannot be dismissed, until the start has listed every task', async () => {
    const { store, gaps, state, dismiss } = fakeStore(ago(5 * 60_000));
    const answers: string[] = [];
    const start = deps({ resumed: [{ id: 'task-1', subjectRef: 'openadlc#7' }] });
    start.reconcile.mockImplementation(async () => {
      // Someone reads the board while reconcile runs, and presses Dismiss.
      answers.push(dismiss());
      return [ORPHAN];
    });

    await startGap(store, start);

    expect(answers).toEqual(['filling']);
    expect(state).toEqual({ filling: false, dismissed: false });
    expect(gaps[0]?.tasks.map((task) => task.taskId)).toEqual(['task-1', 'task-50']);
    expect(vi.mocked(store.finish).mock.invocationCallOrder[0]).toBeGreaterThan(start.reconcile.mock.invocationCallOrder[0]!);
    expect(dismiss()).toBe('dismissed');
  });

  it('finishes the report even when resuming throws', async () => {
    const { store, state } = fakeStore(ago(5 * 60_000));
    const start = deps();
    start.resume.mockRejectedValueOnce(new Error('the database is not answering'));

    await startGap(store, start);

    expect(state.filling).toBe(false);
    expect(start.warn).toHaveBeenCalledWith('could not resume answered tasks: the database is not answering');
  });

  it('finishes a report a start that died part way left filling, on a start with no gap', async () => {
    const { store } = fakeStore(ago(10_000));
    await startGap(store, deps());
    expect(store.finish).toHaveBeenCalledTimes(1);
    expect(store.openGap).not.toHaveBeenCalled();
  });

  it('lists what it resumed and orphaned in a report a start that died part way left filling, before finishing it', async () => {
    // That start opened the report, resumed task-1, and died before reconcile;
    // this one is back inside an interval, so it has no gap of its own.
    const earlier = ago(20_000);
    const kept: GapTask = { taskId: 'task-1', subject: 'openadlc#7', outcome: 'resumed', why: 'resumed implement on openadlc#7', backAt: earlier };
    const { store, gaps, state, dismiss } = fakeStore(ago(10_000), { backAt: earlier, tasks: [kept] });
    const answers: string[] = [];
    const start = deps({ resumed: [{ id: 'task-2', subjectRef: 'openadlc#8' }] });
    start.reconcile.mockImplementation(async () => {
      answers.push(dismiss());
      return [ORPHAN];
    });

    expect(await startGap(store, start)).toEqual({ gapId: 'gap-0' });

    expect(store.openGap).not.toHaveBeenCalled();
    expect(answers).toEqual(['filling']);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.backAt).toBe(earlier);
    expect(gaps[0]?.tasks).toEqual([
      kept,
      { taskId: 'task-2', subject: 'openadlc#8', outcome: 'resumed', why: 'resumed implement on openadlc#8', backAt: BACK },
      { taskId: 'task-50', subject: 'openadlc#50', outcome: 'orphaned', why: ORPHAN.detail, backAt: BACK },
    ]);
    expect(state.filling).toBe(false);
  });

  it('does not reconcile on a start with no gap when the open report is already finished', async () => {
    const { store, state } = fakeStore(ago(10_000), { backAt: ago(20_000), tasks: [] });
    state.filling = false;
    const start = deps({ resumed: [{ id: 'task-2', subjectRef: 'openadlc#8' }], drift: [ORPHAN] });

    expect(await startGap(store, start)).toEqual({ gapId: null });

    expect(start.reconcile).not.toHaveBeenCalled();
    expect(store.addTasks).not.toHaveBeenCalled();
  });

  it('still resumes when the open report cannot be read', async () => {
    const { store } = fakeStore(ago(10_000));
    vi.mocked(store.current).mockRejectedValueOnce(new Error('the database is not answering'));
    const start = deps({ resumed: [{ id: 'task-2', subjectRef: 'openadlc#8' }] });

    expect(await startGap(store, start)).toEqual({ gapId: null });

    expect(start.resume).toHaveBeenCalledTimes(1);
    expect(start.warn).toHaveBeenCalledWith('could not read the gap report, so this start’s tasks are not listed in it: the database is not answering');
  });

  it('tries the gap once more, and says so when it still cannot be stored', async () => {
    const { store, gaps } = fakeStore(ago(5 * 60_000));
    const openGap = vi.mocked(store.openGap).getMockImplementation()!;
    vi.mocked(store.openGap).mockRejectedValueOnce(new Error('deadlock detected'));
    expect(await startGap(store, deps())).toEqual({ gapId: 'gap-1' });
    expect(gaps).toHaveLength(1);

    vi.mocked(store.openGap).mockReset().mockRejectedValue(new Error('the database is not answering'));
    const start = deps({ resumed: [{ id: 'task-1', subjectRef: 'openadlc#7' }] });
    expect(await startGap(store, start)).toEqual({ gapId: null });
    expect(store.openGap).toHaveBeenCalledTimes(2);
    expect(start.warn).toHaveBeenCalledWith(
      `could not store the gap since ${ago(5 * 60_000)}, so the board will not report it: the database is not answering`,
    );
    // Not the heartbeat's warning: the beat was written.
    expect(start.warn).not.toHaveBeenCalledWith(expect.stringContaining('could not record when it was last running'));
    expect(start.resume).toHaveBeenCalledTimes(1);
    vi.mocked(store.openGap).mockImplementation(openGap);
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

  it('beats on demand at the start of a shutdown, and says when the last beat fails', async () => {
    vi.useFakeTimers();
    const touch = vi.fn(async () => undefined);
    const warn = vi.fn();
    const heartbeat = startHeartbeat(touch, BRIDGE_HEARTBEAT_MS, warn);

    await heartbeat.beat();
    expect(touch).toHaveBeenCalledTimes(1);

    touch.mockRejectedValueOnce(new Error('the pool is closing'));
    await heartbeat.stop();
    expect(warn).toHaveBeenCalledWith('could not beat: the pool is closing');
  });
});
