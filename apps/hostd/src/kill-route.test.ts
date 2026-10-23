import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObservedSession } from './drivers/types.js';

/**
 * `POST /bots/:bot/sessions/:session/kill` on a task's session that ends by
 * itself around the time of the kill, through the runner's own bookkeeping.
 *
 * The store writes as the database does: each statement changes the row only
 * from the states its SQL allows (`noteStoppedByPerson` and `stopIfRunning`
 * a running task, `updateTaskState` by `TASK_STATE_FROM`), so whichever of
 * the kill and the session's own end comes second meets what the first left.
 * A kill used to leave the row `running` until the observer's third missed
 * listing, twenty to thirty seconds on (`MISSES_BEFORE_STOP`), and then the
 * task held its place on the host until the observer's next look.
 */

const INSTALL_SECRET = 'install-secret-for-the-test';
const PLATFORM = { 'x-openadlc-internal-secret': INSTALL_SECRET, 'x-openadlc-on-behalf-of': 'ada' };
const SESSION = 'implement-task1';

interface Row {
  id: string;
  botId: string;
  hostId: string | null;
  state: string;
  exitReason: string | null;
  tmuxSession: string;
  leaseId: string;
  subjectRef: string;
  branch: string;
}

const store = vi.hoisted(() => ({
  task: null as unknown as Row,
  lease: { id: 'lease-1', state: 'in_task', prNumber: null as number | null },
  stoppedBy: '',
  stateFrom: {} as Record<string, readonly string[]>,
}));

vi.mock('@openadlc/db', async () => {
  const actual = await vi.importActual<typeof import('@openadlc/db')>('@openadlc/db');
  store.stoppedBy = actual.tasks.STOPPED_BY_PERSON;
  store.stateFrom = actual.tasks.TASK_STATE_FROM;
  const row = () => ({ ...store.task });
  return {
    audit: vi.fn(async () => undefined),
    bots: { getBotByName: vi.fn(async () => null), listBots: vi.fn(async () => [{ id: 'bot-atlas', name: 'atlas' }]), setBotStatus: vi.fn() },
    hosts: { heartbeat: vi.fn(async () => undefined) },
    repos: { listRepos: vi.fn(async () => []) },
    // What the observer's look writes of the sessions it lists.
    sessions: {
      removeSessionsForBot: vi.fn(),
      observeSession: vi.fn(async () => ({ id: 'session-1' })),
      appendSessionLog: vi.fn(),
      listSessions: vi.fn(async () => []),
      removeSession: vi.fn(),
    },
    leases: {
      getLease: vi.fn(async (id: string) => (id === store.lease.id ? { ...store.lease } : null)),
      setLeaseState: vi.fn(async (id: string, state: string) => {
        if (id === store.lease.id) store.lease.state = state;
        return { ...store.lease };
      }),
    },
    tasks: {
      getTask: vi.fn(async (id: string) => (id === store.task.id ? row() : null)),
      listTasks: vi.fn(async ({ states }: { states: string[] }) => (states.includes(store.task.state) ? [row()] : [])),
      noteStoppedByPerson: vi.fn(async (tmuxSession: string, actor: string) => {
        if (store.task.tmuxSession !== tmuxSession || store.task.state !== 'running') return null;
        store.task.exitReason = `${store.stoppedBy} (${actor}): its session was killed`;
        return row();
      }),
      forgetStoppedByPerson: vi.fn(async (id: string) => {
        if (id === store.task.id && store.task.state === 'running' && store.task.exitReason?.startsWith(store.stoppedBy)) store.task.exitReason = null;
      }),
      stopIfRunning: vi.fn(async (id: string, exitReason: string) => {
        if (id !== store.task.id || store.task.state !== 'running') return null;
        store.task.state = 'stopped';
        if (!store.task.exitReason?.startsWith(store.stoppedBy)) store.task.exitReason = exitReason;
        return row();
      }),
      updateTaskState: vi.fn(async (id: string, state: string, patch: { exitReason?: string | null } = {}) => {
        if (id !== store.task.id || !(store.stateFrom[state] ?? []).includes(store.task.state)) return null;
        store.task.state = state;
        store.task.exitReason = patch.exitReason ?? store.task.exitReason;
        return row();
      }),
    },
  };
});

const db = await import('@openadlc/db');
const { SessionObserver } = await import('./observer.js');

/** What the bridge writes when a session reports how it ended (`/internal/tasks/:id/state`). */
const reportsDone = () => db.tasks.updateTaskState('task-1', 'done', { exitReason: 'complete' });

/** The bot's tmux sessions: a kill removes one, as `tmux kill-session` does, unless told it does not land. */
function sessionsOf(names: string[], kills = true) {
  const live = new Set(names);
  return {
    live,
    driver: {
      kind: 'local',
      loginPath: (id: string) => join(loginRoot, id),
      listSessions: vi.fn(async (bot: string): Promise<ObservedSession[]> =>
        [...live].map((name) => ({ bot, name, pid: 7, cmd: 'node', state: 'working', lastLine: null, pane: [] }) as ObservedSession),
      ),
      killSession: vi.fn(async (_bot: string, name: string) => {
        if (kills) live.delete(name);
      }),
      release: vi.fn(async (_taskId: string, _reason: string) => undefined),
    },
  };
}

let loginRoot: string;
let server: Awaited<ReturnType<typeof start>> | undefined;

/** `capacityTasks` is the host's room (`OPENADLC_HOST_CAPACITY_TASKS`); without it the host is never full. */
async function start(driver: object, { held = true, capacityTasks }: { held?: boolean; capacityTasks?: number } = {}) {
  const { createHostdServer } = await import('./server.js');
  const { RegistryCredentials } = await import('./registry.js');
  const { AttachTokens } = await import('./attach-tokens.js');
  const { TaskRunner } = await import('./task-runner.js');

  const config = { hostName: 'test', driver: 'local', loginRoot, workRoot: join(loginRoot, 'work'), capacityTasks } as never;
  const runner = new TaskRunner(config, driver as never, null);
  // Held as hostd holds a task it runs, which is what the kill looks for.
  if (held) {
    runner.adopt(
      { id: store.task.id, kind: 'implement', branch: store.task.branch, tmuxSession: store.task.tmuxSession },
      { taskId: store.task.id, bot: 'atlas', container: null, databaseUrl: null, slotDir: join(loginRoot, 'slots', store.task.id) },
      null,
    );
  }
  const http = createHostdServer({
    config,
    driver: driver as never,
    runner,
    attachTokens: new AttachTokens(),
    registry: new RegistryCredentials(null),
    perTaskCapUsd: 10,
    secret: async () => INSTALL_SECRET,
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  return {
    runner,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
    kill: async () => (await fetch(`http://127.0.0.1:${port}/bots/atlas/sessions/${SESSION}/kill`, { method: 'POST', headers: PLATFORM, body: '{}' })).status,
    /** The bridge starting another of atlas's tasks here (`HostdClient.startTask`). */
    startTask: async (taskId: string) => {
      const answer = await fetch(`http://127.0.0.1:${port}/tasks`, {
        method: 'POST',
        headers: PLATFORM,
        body: JSON.stringify({ taskId, bot: 'atlas', subjectRef: 'widgets#8', skill: 'implement' }),
      });
      return { status: answer.status, error: ((await answer.json()) as { error?: string }).error ?? '' };
    },
  };
}

/** How many times hostd said it gave back what it held for `taskId` (`forgetIfOver`). */
function givenBack(log: { mock: { calls: unknown[][] } }, taskId: string): number {
  return log.mock.calls.filter(([line]) => String(line).startsWith(`[hostd] released what was held for ${taskId}:`)).length;
}

beforeEach(() => {
  loginRoot = mkdtempSync(join(tmpdir(), 'openadlc-kill-route-'));
  store.task = {
    id: 'task-1',
    botId: 'bot-atlas',
    hostId: null,
    state: 'running',
    exitReason: null,
    tmuxSession: `atlas/${SESSION}`,
    leaseId: 'lease-1',
    subjectRef: 'widgets#7',
    branch: 'agent/atlas/7-issue-7',
  };
  store.lease = { id: 'lease-1', state: 'in_task', prNumber: null };
  vi.clearAllMocks();
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  rmSync(loginRoot, { recursive: true, force: true });
});

describe('a task whose session is killed while it runs', () => {
  it('is stopped by the kill, with the person’s reason, and its lease let go, before the kill answers', async () => {
    const { driver } = sessionsOf([SESSION]);
    server = await start(driver);

    expect(await server.kill()).toBe(200);

    expect(store.task.state).toBe('stopped');
    expect(store.task.exitReason).toBe(`${store.stoppedBy} (ada via platform): its session was killed`);
    expect(store.lease.state).toBe('released');
    expect(db.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'task.stopped', target: 'widgets#7', payload: expect.objectContaining({ reason: 'session killed' }) }));
  });

  it('keeps that ending when the session’s own end is reported after the kill', async () => {
    const { driver } = sessionsOf([SESSION]);
    server = await start(driver);
    await server.kill();

    expect(await reportsDone()).toBeNull();
    expect(store.task.state).toBe('stopped');
    expect(store.task.exitReason?.startsWith(store.stoppedBy)).toBe(true);
  });

  it('keeps the lease a pull request still holds', async () => {
    store.lease.prNumber = 31;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { driver } = sessionsOf([SESSION]);
    server = await start(driver);

    await server.kill();

    expect(store.task.state).toBe('stopped');
    expect(store.lease.state).toBe('in_task');
    log.mockRestore();
  });
});

describe('a task whose session ended by itself just before the kill', () => {
  it('is stopped by the kill when its end was never reported', async () => {
    // The session has gone, and the row still says running: its report was
    // lost with it, or is still on its way.
    const { driver } = sessionsOf([]);
    server = await start(driver);

    expect(await server.kill()).toBe(200);

    expect(store.task.state).toBe('stopped');
    expect(store.task.exitReason?.startsWith(store.stoppedBy)).toBe(true);
    expect(store.lease.state).toBe('released');
    // And the report, arriving now, does not undo it.
    expect(await reportsDone()).toBeNull();
    expect(store.task.state).toBe('stopped');
  });

  it('keeps the ending it reported, and its lease, which waits for its pull request', async () => {
    await reportsDone();
    const { driver } = sessionsOf([]);
    server = await start(driver);

    expect(await server.kill()).toBe(200);

    expect(store.task).toMatchObject({ state: 'done', exitReason: 'complete' });
    expect(store.lease.state).toBe('in_task');
    expect(db.audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'task.stopped' }));
  });

  it('keeps the ending it reported while the kill was landing', async () => {
    const { driver, live } = sessionsOf([SESSION]);
    driver.killSession.mockImplementation(async (_bot: string, name: string) => {
      await reportsDone();
      live.delete(name);
    });
    server = await start(driver);

    expect(await server.kill()).toBe(200);

    expect(store.task).toMatchObject({ state: 'done', exitReason: 'complete' });
    expect(store.lease.state).toBe('in_task');
  });
});

describe('a kill that does not take the session', () => {
  it('leaves the task to the observer while the session is still listed', async () => {
    const { driver } = sessionsOf([SESSION], false);
    server = await start(driver);

    expect(await server.kill()).toBe(200);

    expect(store.task.state).toBe('running');
    expect(store.lease.state).toBe('in_task');
  });

  it('leaves alone a task this hostd does not run, whose session it cannot see', async () => {
    // Another host's, sharing the database: its session is not in this
    // driver's listing, and the kill here took nothing of it.
    const { driver } = sessionsOf([]);
    server = await start(driver, { held: false });

    expect(await server.kill()).toBe(200);

    expect(store.task.state).toBe('running');
    expect(store.lease.state).toBe('in_task');
  });

  it('leaves the task to the observer when the sessions cannot be listed', async () => {
    const { driver } = sessionsOf([SESSION]);
    driver.listSessions.mockRejectedValue(new Error('tmux did not answer within 30 s'));
    server = await start(driver);

    expect(await server.kill()).toBe(200);

    expect(store.task.state).toBe('running');
    expect(store.lease.state).toBe('in_task');
  });
});

describe('the place a killed task held on the host', () => {
  it('is given back before the kill answers, so a full host starts the next task at once', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { driver } = sessionsOf([SESSION]);
    // Room for one, and the task being killed holds it.
    server = await start(driver, { capacityTasks: 1 });
    expect(await server.startTask('task-2')).toEqual({ status: 503, error: expect.stringContaining('all it has room for') });
    expect(db.bots.getBotByName).not.toHaveBeenCalled();

    expect(await server.kill()).toBe(200);

    // Admitted: past the host's room, the start goes on to read its bot,
    // which this test has none of.
    const next = await server.startTask('task-2');
    expect(next.status).not.toBe(503);
    expect(next.error).toMatch(/^there is no bot atlas/);
    expect(db.bots.getBotByName).toHaveBeenCalledWith('atlas');
    // Given back as the observer gives it back: its session, its computer.
    expect(server.runner.activeTaskIds()).toEqual([]);
    expect(driver.release).toHaveBeenCalledWith('task-1', 'the task is stopped');
    log.mockRestore();
    warn.mockRestore();
  });

  it('is given back for a task whose own end was reported while the kill was landing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { driver, live } = sessionsOf([SESSION]);
    driver.killSession.mockImplementation(async (_bot: string, name: string) => {
      await reportsDone();
      live.delete(name);
    });
    server = await start(driver, { capacityTasks: 1 });

    expect(await server.kill()).toBe(200);

    expect(store.task.state).toBe('done');
    expect(server.runner.activeTaskIds()).toEqual([]);
    expect(driver.release).toHaveBeenCalledWith('task-1', 'the task is done');
    log.mockRestore();
  });

  it('is left held while the kill did not take the session', async () => {
    const { driver } = sessionsOf([SESSION], false);
    server = await start(driver, { capacityTasks: 1 });

    expect(await server.kill()).toBe(200);

    expect(server.runner.activeTaskIds()).toEqual(['task-1']);
    expect(driver.release).not.toHaveBeenCalled();
  });

  it('is not stopped or given back again by the observer’s next look', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { driver } = sessionsOf([SESSION]);
    server = await start(driver, { capacityTasks: 1 });
    await server.kill();
    expect(driver.release).toHaveBeenCalledTimes(1);

    await new SessionObserver(driver as never, 'test', 10_000, server.runner).tick();

    expect(driver.release).toHaveBeenCalledTimes(1);
    expect(givenBack(log, 'task-1')).toBe(1);
    expect(db.tasks.stopIfRunning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.audit).mock.calls.filter(([entry]) => entry.action === 'task.stopped')).toHaveLength(1);
    expect(store.lease.state).toBe('released');
    log.mockRestore();
  });

  it('is given back once when the observer’s look found it held just before the kill', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { driver } = sessionsOf([SESSION]);
    server = await start(driver, { capacityTasks: 1 });
    // The look reads the task's row to see whether it is over, and the kill
    // lands while that read is out.
    let reached!: () => void;
    const atLookup = new Promise<void>((resolve) => (reached = resolve));
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    vi.mocked(db.tasks.getTask).mockImplementationOnce(async (id: string) => {
      reached();
      await answered;
      return (id === store.task.id ? { ...store.task } : null) as never;
    });
    const look = new SessionObserver(driver as never, 'test', 10_000, server.runner).tick();
    await atLookup;

    expect(await server.kill()).toBe(200);
    answer();
    await look;

    expect(driver.release).toHaveBeenCalledTimes(1);
    expect(givenBack(log, 'task-1')).toBe(1);
    log.mockRestore();
  });
});
