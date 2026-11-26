import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBoardPanel, registerBoardPanelRoute, RECENT_LIMIT, RECENT_WINDOW_MS, type BoardPanelDeps } from './board-panel.js';
import { Router } from './router.js';
import type { TaskFacts } from './work.js';

const NOW = new Date('2026-11-25T12:00:00.000Z');
const minutesAgo = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();

function task(id: string, state: TaskFacts['state'], extra: Partial<TaskFacts> & { billed?: boolean; pausedAt?: string | null } = {}) {
  return {
    id,
    botId: 'bot-builder',
    repoId: 'repo-1',
    kind: 'implement',
    subjectRef: 'api#7',
    state,
    round: 0,
    costUsd: 1.2,
    billed: true,
    startedAt: minutesAgo(60),
    endedAt: null,
    exitReason: null,
    createdAt: minutesAgo(61),
    pausedAt: null,
    ...extra,
  } as TaskFacts & { billed: boolean; pausedAt: string | null };
}

const NAMING = {
  bots: [{ id: 'bot-builder', name: 'openadlc-atlas-janedoe' }],
  repos: [{ id: 'repo-1', name: 'api' }],
  requests: [{ id: 'b4378305-aaaa-4bbb-8ccc-dddddddddddd', repoId: 'repo-1', text: 'Open the running count into a list' }],
  issues: [{ repoName: 'api', number: 7, prNumber: 31, title: 'Cache the prices' }],
};

function deps(over: Partial<BoardPanelDeps> & { going?: ReturnType<typeof task>[]; finished?: ReturnType<typeof task>[]; gates?: { taskId: string | null }[]; since?: Record<string, string | null> } = {}) {
  const base: BoardPanelDeps = {
    listTasks: vi.fn(async () => over.going ?? []),
    listFinishedSince: vi.fn(async () => over.finished ?? []),
    listOpenGates: vi.fn(async () => over.gates ?? []),
    runningSince: vi.fn(async (ids: readonly string[]) => new Map(ids.filter((id) => over.since && id in over.since).map((id) => [id, over.since![id] ?? null]))),
    namingFacts: vi.fn(async () => NAMING),
  };
  return { ...base, ...over } as BoardPanelDeps;
}

describe('the side panel’s tasks (#376)', () => {
  it('says each running or paused task’s state: working, waiting on a person’s gate, or paused for anything else', async () => {
    const read = deps({
      going: [
        task('task-working', 'running', { startedAt: minutesAgo(40) }),
        task('task-asking', 'paused', { subjectRef: 'request:b4378305', pausedAt: minutesAgo(30), costUsd: 0.4, billed: false }),
        task('task-restart', 'paused', { subjectRef: 'api@3f2c1a9', pausedAt: minutesAgo(5) }),
      ],
      gates: [{ taskId: 'task-asking' }, { taskId: null }],
      // Resumed twelve minutes ago after a question: that is how long it has been working.
      since: { 'task-working': minutesAgo(12) },
    });

    const panel = await readBoardPanel(NOW, read);

    expect(panel.running.map((row) => [row.id, row.state, row.since, row.costUsd, row.billed])).toEqual([
      ['task-asking', 'waiting', minutesAgo(30), 0.4, false],
      ['task-working', 'working', minutesAgo(12), 1.2, true],
      ['task-restart', 'paused', minutesAgo(5), 1.2, true],
    ]);
    // Named as the board names its rows: through the issue a pull request is on, or the request.
    expect(panel.running.map((row) => [row.bot, row.title, row.repo, row.opens])).toEqual([
      ['openadlc-atlas-janedoe', 'Open the running count into a list', 'api', 'request:b4378305'],
      ['openadlc-atlas-janedoe', 'Cache the prices', 'api', 'api#7'],
      ['openadlc-atlas-janedoe', null, 'api', null],
    ]);
    // Since when is asked only for the running ones.
    expect(read.runningSince).toHaveBeenCalledWith(['task-working']);
  });

  it('times a running task from its start when nothing says it resumed', async () => {
    const panel = await readBoardPanel(NOW, deps({ going: [task('task-working', 'running', { startedAt: minutesAgo(40) })] }));
    expect(panel.running[0]?.since).toBe(minutesAgo(40));
  });

  it('asks for the tasks that ended in the last 24 hours, 20 at most, and lists them newest first', async () => {
    const read = deps({
      finished: [
        task('task-a', 'stopped', { endedAt: minutesAgo(300) }),
        task('task-b', 'done', { endedAt: minutesAgo(10), billed: false }),
        task('task-c', 'failed', { endedAt: minutesAgo(60) }),
      ],
    });

    const panel = await readBoardPanel(NOW, read);

    expect(RECENT_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
    expect(RECENT_LIMIT).toBe(20);
    expect(read.listFinishedSince).toHaveBeenCalledWith(new Date(NOW.getTime() - 24 * 60 * 60 * 1000), 20);
    expect(read.listTasks).toHaveBeenCalledWith({ states: ['running', 'paused'], limit: 200 });
    expect(panel.recent.map((row) => [row.id, row.outcome, row.endedAt, row.billed, row.title])).toEqual([
      ['task-b', 'done', minutesAgo(10), false, 'Cache the prices'],
      ['task-c', 'failed', minutesAgo(60), true, 'Cache the prices'],
      ['task-a', 'stopped', minutesAgo(300), true, 'Cache the prices'],
    ]);
  });

  it('names every row, running and recent, from one read of the naming facts', async () => {
    const read = deps({ going: [task('task-working', 'running')], finished: [task('task-b', 'done', { endedAt: minutesAgo(10) })] });
    await readBoardPanel(NOW, read);
    expect(read.namingFacts).toHaveBeenCalledTimes(1);
    expect(vi.mocked(read.namingFacts).mock.calls[0]?.[0].map((one) => one.id)).toEqual(['task-working', 'task-b']);
  });

  it('reads nothing more for a quiet install', async () => {
    const read = deps();
    expect(await readBoardPanel(NOW, read)).toEqual({ running: [], recent: [] });
    expect(read.namingFacts).not.toHaveBeenCalled();
    expect(read.runningSince).not.toHaveBeenCalled();
  });

  it('fails as a whole when a read fails, rather than answering a tab short', async () => {
    const read = deps({ listOpenGates: vi.fn(async () => Promise.reject(new Error('down'))) });
    await expect(readBoardPanel(NOW, read)).rejects.toThrow('down');
  });
});

describe('GET /v1/board/panel', () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it('answers the panel’s tasks as JSON', async () => {
    const router = new Router();
    registerBoardPanelRoute(router, deps({ going: [task('task-working', 'running')] }));
    server = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/board/panel`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { running: { id: string; state: string }[]; recent: unknown[] };
    expect(body.running.map((row) => [row.id, row.state])).toEqual([['task-working', 'working']]);
    expect(body.recent).toEqual([]);
  });
});
