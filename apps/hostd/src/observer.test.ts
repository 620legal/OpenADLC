import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecDriver, ObservedSession } from './drivers/types.js';

vi.mock('@fleetadlc/db', () => ({
  audit: vi.fn(async () => undefined),
  bots: { listBots: vi.fn(async () => [{ id: 'bot-1', name: 'atlas' }]) },
  hosts: { heartbeat: vi.fn(async () => undefined) },
  leases: { getLease: vi.fn(async () => null), setLeaseState: vi.fn(async () => undefined) },
  repos: { listRepos: vi.fn(async () => []) },
  sessions: {
    observeSession: vi.fn(async () => ({ id: 'session-row-1' })),
    appendSessionLog: vi.fn(async () => undefined),
    listSessions: vi.fn(async () => []),
    removeSession: vi.fn(async () => undefined),
  },
  tasks: {
    getTask: vi.fn(async () => null),
    listTasks: vi.fn(async () => []),
    stopIfRunning: vi.fn(async () => null),
  },
}));

const db = await import('@fleetadlc/db');
const { stateFromPane } = await import('./drivers/local.js');
const { newPaneLines, SessionObserver } = await import('./observer.js');

const TOKEN = 'ghs_0123456789abcdefghijABCDEFGHIJ';

function session(name: string, pane: string[]): ObservedSession {
  return { bot: 'atlas', name, cmd: 'node', state: 'working', pid: 42, lastLine: pane.at(-1) ?? null, pane } as ObservedSession;
}

function observing(listSessions: () => Promise<ObservedSession[]>) {
  const driver = { kind: 'local', listSessions: vi.fn(listSessions) } as unknown as ExecDriver;
  return new SessionObserver(driver, 'host-a', 10_000);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('what the observer stores of a pane', () => {
  it('masks a credential in a pane line and in the last line before either is stored', async () => {
    const pane = ['reading the issue', `export GH_TOKEN=${TOKEN}`];
    await observing(async () => [session('implement-task1', pane)]).tick();

    expect(db.sessions.observeSession).toHaveBeenCalledWith(expect.objectContaining({ lastLine: 'export GH_TOKEN=ghs_***' }));
    expect(db.sessions.appendSessionLog).toHaveBeenCalledWith('session-row-1', ['reading the issue', 'export GH_TOKEN=ghs_***']);
    expect(JSON.stringify(vi.mocked(db.sessions.appendSessionLog).mock.calls)).not.toContain(TOKEN);
  });

  it('stores only the new lines on the next tick, a redacted line before them included', async () => {
    const first = ['reading the issue', `echo ${TOKEN}`];
    let pane = first;
    const observer = observing(async () => [session('implement-task1', pane)]);
    await observer.tick();
    pane = [...first, 'running make ci'];
    await observer.tick();

    expect(vi.mocked(db.sessions.appendSessionLog).mock.calls.at(-1)).toEqual(['session-row-1', ['running make ci']]);
  });
});

describe('a running task whose session the observer does not see', () => {
  const TASK = { id: 'task-1', botId: 'bot-1', state: 'running', tmuxSession: 'atlas/implement-task1', leaseId: 'lease-1', subjectRef: 'widgets#7', branch: 'agent/atlas/7' };

  beforeEach(() => {
    vi.mocked(db.tasks.listTasks).mockResolvedValue([TASK] as never);
    vi.mocked(db.tasks.stopIfRunning).mockResolvedValue(TASK as never);
  });

  afterEach(() => {
    vi.mocked(db.tasks.listTasks).mockResolvedValue([]);
    vi.mocked(db.tasks.stopIfRunning).mockResolvedValue(null as never);
    vi.mocked(db.sessions.listSessions).mockResolvedValue([]);
  });

  it('is not stopped when the listing could not be read, and its session row is kept', async () => {
    vi.mocked(db.sessions.listSessions).mockResolvedValue([{ name: 'implement-task1' }] as never);
    const observer = observing(async () => {
      throw new Error('could not read sessions in task-3f2a9c1e: OCI runtime exec failed');
    });

    for (let tick = 0; tick < 5; tick += 1) await observer.tick();

    expect(db.tasks.stopIfRunning).not.toHaveBeenCalled();
    expect(db.leases.setLeaseState).not.toHaveBeenCalled();
    expect(db.sessions.removeSession).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('atlas: could not read its sessions'));
  });

  it('is stopped only once its session has been missing from three listings in a row', async () => {
    let sessions: ObservedSession[] = [];
    const observer = observing(async () => sessions);

    await observer.tick();
    await observer.tick();
    expect(db.tasks.stopIfRunning).not.toHaveBeenCalled();
    expect(db.leases.setLeaseState).not.toHaveBeenCalled();

    // Seen again: the count starts over.
    sessions = [session('implement-task1', ['working'])];
    await observer.tick();
    sessions = [];
    await observer.tick();
    await observer.tick();
    expect(db.tasks.stopIfRunning).not.toHaveBeenCalled();

    await observer.tick();
    expect(db.tasks.stopIfRunning).toHaveBeenCalledWith('task-1', expect.any(String));
    expect(db.leases.setLeaseState).toHaveBeenCalledWith('lease-1', 'released');
  });
});

describe('a running task on another host', () => {
  const TASK = { id: 'task-1', botId: 'bot-1', state: 'running', tmuxSession: 'atlas/implement-task1', leaseId: 'lease-1', subjectRef: 'widgets#7', branch: 'agent/atlas/7', hostId: 'host-a-id' };

  /** hostd on host B, whose driver sees none of host A's sessions. */
  function onHost(hostId: string | null) {
    const driver = { kind: 'docker', listSessions: vi.fn(async () => []) } as unknown as ExecDriver;
    const runner = { hostId, activeTaskIds: () => [], end: vi.fn(async () => undefined) };
    return new SessionObserver(driver, 'host-b', 10_000, runner);
  }

  beforeEach(() => {
    vi.mocked(db.tasks.listTasks).mockResolvedValue([TASK] as never);
    vi.mocked(db.tasks.stopIfRunning).mockResolvedValue(TASK as never);
    vi.mocked(db.sessions.listSessions).mockResolvedValue([{ name: 'implement-task1', taskId: 'task-1' }] as never);
  });

  afterEach(() => {
    vi.mocked(db.tasks.listTasks).mockResolvedValue([]);
    vi.mocked(db.tasks.stopIfRunning).mockResolvedValue(null as never);
    vi.mocked(db.sessions.listSessions).mockResolvedValue([]);
  });

  it('does not stop a task running on another host, release its lease or remove its session row', async () => {
    const observer = onHost('host-b-id');

    for (let tick = 0; tick < 5; tick += 1) await observer.tick();

    expect(db.tasks.stopIfRunning).not.toHaveBeenCalled();
    expect(db.leases.setLeaseState).not.toHaveBeenCalled();
    expect(db.audit).not.toHaveBeenCalled();
    expect(db.sessions.removeSession).not.toHaveBeenCalled();
  });

  it('stops it as before when this hostd knows no host of its own', async () => {
    const observer = onHost(null);

    for (let tick = 0; tick < 3; tick += 1) await observer.tick();

    expect(db.sessions.removeSession).toHaveBeenCalledWith('bot-1', 'implement-task1');
    expect(db.tasks.stopIfRunning).toHaveBeenCalledWith('task-1', expect.any(String));
  });

  it('stops one of its own whose session is gone', async () => {
    const observer = onHost('host-a-id');

    for (let tick = 0; tick < 3; tick += 1) await observer.tick();

    expect(db.tasks.stopIfRunning).toHaveBeenCalledWith('task-1', expect.any(String));
  });
});

describe('a tick that does not finish', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is not joined by another: a hung listing is asked once, however many intervals pass', async () => {
    vi.useFakeTimers();
    const listSessions = vi.fn(() => new Promise<ObservedSession[]>(() => undefined));
    const driver = { kind: 'docker', listSessions } as unknown as ExecDriver;
    const observer = new SessionObserver(driver, 'host-a', 10_000);

    observer.start();
    await vi.advanceTimersByTimeAsync(60_000);
    observer.stop();

    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.log).mock.calls.filter(([line]) => String(line).includes('skipped'))).toHaveLength(1);
  });

  it('lets the next tick run once it has finished', async () => {
    let answer: (sessions: ObservedSession[]) => void = () => undefined;
    const listSessions = vi.fn(() => new Promise<ObservedSession[]>((resolve) => (answer = resolve)));
    const observer = new SessionObserver({ kind: 'docker', listSessions } as unknown as ExecDriver, 'host-a', 10_000);

    const first = observer.tick();
    await vi.waitFor(() => expect(listSessions).toHaveBeenCalledTimes(1));
    await observer.tick();
    answer([]);
    await first;
    const second = observer.tick();
    await vi.waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2));
    answer([]);
    await second;
  });
});

describe('what the session log stores', () => {
  it('stores everything the first time it looks', () => {
    expect(newPaneLines([], ['reading the issue', 'posting the plan'])).toEqual([
      'reading the issue',
      'posting the plan',
    ]);
  });

  it('stores only what appeared since the last look', () => {
    const previous = ['reading the issue', 'posting the plan'];
    const current = [...previous, 'running make ci'];
    expect(newPaneLines(previous, current)).toEqual(['running make ci']);
  });

  it('stores nothing when the pane has not moved', () => {
    const pane = ['reading the issue', 'posting the plan'];
    expect(newPaneLines(pane, pane)).toEqual([]);
  });

  it('handles a pane that scrolled its oldest lines away', () => {
    const previous = ['line one', 'line two', 'line three'];
    const current = ['line two', 'line three', 'line four'];
    expect(newPaneLines(previous, current)).toEqual(['line four']);
  });
});

describe('reading a session state off its pane', () => {
  it('calls a shell prompt idle', () => {
    expect(stateFromPane('bash', 'bot@container:/work$', false)).toBe('idle');
  });

  it('calls a running skill working', () => {
    expect(stateFromPane('node', '[skill] implementing inside the declared paths', false)).toBe('working');
  });

  it('calls a session that is waiting on a person paused', () => {
    expect(stateFromPane('node', '[skill] waiting on a person: which table owns the join?', false)).toBe('paused');
  });

  it('calls a session paused at its cap paused', () => {
    expect(stateFromPane('node', '[skill] paused at the $15 cap after $15.02', false)).toBe('paused');
  });

  it('calls a dead pane stopped', () => {
    expect(stateFromPane('node', 'anything', true)).toBe('stopped');
  });
});
