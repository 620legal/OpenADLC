import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecDriver, FoundComputer, TaskComputer } from './drivers/types.js';

/**
 * The reaper squares the computers on a host with the tasks they are for.
 * A container outlives whatever forgot it — hostd restarting mid-task, a
 * release that failed — so what is found is decided by the task's row.
 */

const ROWS: Record<
  string,
  { id: string; state: string; kind: string; branch: string | null; tmuxSession: string | null; repoId: string | null; subjectRef: string; container?: string | null; worktree?: string | null }
> = {};

vi.mock('@fleetadlc/db', () => ({
  audit: vi.fn(async () => undefined),
  bots: { listBots: vi.fn(async () => []) },
  hosts: { heartbeat: vi.fn(async () => undefined) },
  leases: { getLease: vi.fn(async () => null), setLeaseState: vi.fn() },
  repos: { listRepos: vi.fn(async () => [{ id: 'repo-1', fullName: 'acme/widgets' }]) },
  sessions: { observeSession: vi.fn(), appendSessionLog: vi.fn(), listSessions: vi.fn(async () => []), removeSession: vi.fn() },
  tasks: {
    getTask: vi.fn(async (id: string) => ROWS[id] ?? null),
    listTasks: vi.fn(async () => []),
    stopIfRunning: vi.fn(async () => null),
  },
}));

const db = await import('@fleetadlc/db');
const { SessionObserver } = await import('./observer.js');

function found(taskId: string | null, name = `task-${(taskId ?? 'xxxxxxxx').slice(0, 8)}`): FoundComputer {
  return { name, kind: 'task', taskId, bot: taskId ? 'atlas' : null, slotDir: taskId ? `/work/slots/${taskId}` : null, running: true, image: null, repoKey: null };
}

function computerFor(entry: FoundComputer): TaskComputer {
  return { taskId: entry.taskId!, bot: entry.bot!, container: entry.name, databaseUrl: null, slotDir: entry.slotDir! };
}

function host(computers: FoundComputer[], held: string[] = []) {
  const driver = {
    kind: 'docker',
    listSessions: vi.fn(async () => []),
    computers: vi.fn(async () => computers),
    computerOf: vi.fn(() => null),
    adopt: vi.fn(async (entry: FoundComputer) => computerFor(entry)),
    release: vi.fn(async () => undefined),
    discard: vi.fn(async () => undefined),
  } as unknown as ExecDriver & { adopt: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn>; discard: ReturnType<typeof vi.fn> };
  const runner = {
    activeTaskIds: () => held,
    end: vi.fn(async () => undefined),
    adopt: vi.fn(),
    releasePausedPast: vi.fn(async () => []),
    pruneAbandonedSlots: vi.fn(async () => 0),
    dropFinishedTaskRefs: vi.fn(async () => 0),
    slotsRoot: () => '/work/slots',
  };
  return { driver, runner, observer: new SessionObserver(driver, 'host-a', 10_000, runner, 15 * 60_000) };
}

beforeEach(() => {
  for (const key of Object.keys(ROWS)) delete ROWS[key];
  vi.mocked(db.tasks.getTask).mockImplementation(async (id: string) => (ROWS[id] ?? null) as never);
  vi.mocked(db.hosts.heartbeat).mockImplementation(async () => undefined as never);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('computers the reaper finds', () => {
  it('takes back a running task’s computer after a restart, so its session ends and is watched as before', async () => {
    ROWS['task-run'] = { id: 'task-run', state: 'running', kind: 'implement', branch: 'agent/atlas/7-issue-7', tmuxSession: 'atlas/implement-taskrun', repoId: 'repo-1', subjectRef: 'widgets#7', container: 'task-task-run' };
    const entry = found('task-run');
    const { driver, runner, observer } = host([entry]);

    await observer.reapComputers();

    expect(driver.adopt).toHaveBeenCalledWith(entry);
    expect(runner.adopt).toHaveBeenCalledWith(ROWS['task-run'], computerFor(entry), 'acme/widgets');
    expect(driver.release).not.toHaveBeenCalled();
  });

  it('takes back a paused one too, so take-over works until its computer is given back', async () => {
    ROWS['task-paused'] = { id: 'task-paused', state: 'paused', kind: 'implement', branch: null, tmuxSession: 'atlas/implement-taskpaus', repoId: null, subjectRef: 'request:abcd1234', container: 'task-task-pau' };
    const { runner, observer } = host([found('task-paused')]);

    await observer.reapComputers();

    expect(runner.adopt).toHaveBeenCalledWith(ROWS['task-paused'], expect.objectContaining({ taskId: 'task-paused' }), null);
    expect(runner.releasePausedPast).toHaveBeenCalledWith(15 * 60_000, expect.any(Function));
  });

  it('does not take back a computer whose slot claims a paused task the row says is in another computer', async () => {
    // The slot's record was in the directory the task has mounted read-write:
    // a task that wrote a paused victim's id there was adopted as the victim,
    // so the victim's terminal and local CI ran in the attacker's container.
    ROWS['task-victim'] = { id: 'task-victim', state: 'paused', kind: 'implement', branch: 'agent/atlas/7-issue-7', tmuxSession: 'atlas/implement-taskvict', repoId: 'repo-1', subjectRef: 'widgets#7', container: 'task-task-vic' };
    const attacker = { ...found('task-victim', 'task-attacker'), slotDir: '/work/slots/task-attacker-abc' };
    const { driver, runner, observer } = host([attacker]);

    await observer.reapComputers();

    expect(driver.adopt).not.toHaveBeenCalled();
    expect(runner.adopt).not.toHaveBeenCalled();
    expect(driver.discard).toHaveBeenCalledWith('task-attacker');
    expect(vi.mocked(console.log).mock.calls.map((call) => String(call[0]))).toContain(
      '[hostd] removed task-attacker: it claims task task-victim, whose row names task-task-vic, not it',
    );
  });

  it('does not take back a computer whose task’s computer was given back while it was paused', async () => {
    ROWS['task-victim'] = { id: 'task-victim', state: 'paused', kind: 'implement', branch: 'agent/atlas/7-issue-7', tmuxSession: null, repoId: 'repo-1', subjectRef: 'widgets#7', container: null, worktree: '/work/slots/task-victim-old/wt' };
    const { driver, runner, observer } = host([{ ...found('task-victim', 'task-attacker'), slotDir: '/work/slots/task-attacker-abc' }]);

    await observer.reapComputers();

    expect(runner.adopt).not.toHaveBeenCalled();
    expect(driver.discard).toHaveBeenCalledWith('task-attacker');
  });

  it('takes back only a computer whose directory is one hostd made task directories in', async () => {
    ROWS['task-run'] = { id: 'task-run', state: 'running', kind: 'implement', branch: null, tmuxSession: null, repoId: null, subjectRef: 'widgets#7', container: 'task-task-run' };
    const { runner, observer } = host([{ ...found('task-run'), slotDir: '/elsewhere/task-run' }]);

    await observer.reapComputers();

    expect(runner.adopt).not.toHaveBeenCalled();
  });

  it('takes back a local driver’s directory by the worktree its row names, as there is no container', async () => {
    ROWS['task-run'] = { id: 'task-run', state: 'running', kind: 'implement', branch: null, tmuxSession: null, repoId: null, subjectRef: 'widgets#7', container: null, worktree: '/work/slots/task-run-abc/wt' };
    const { runner, observer } = host([{ ...found('task-run', 'task-run-abc'), slotDir: '/work/slots/task-run-abc' }]);

    await observer.reapComputers();

    expect(runner.adopt).toHaveBeenCalled();
  });

  it('does not take back a computer whose task is being started, which would race the start', async () => {
    // The container is up before the driver records it: the sweep found it in
    // that window, for a task that was being resumed.
    ROWS['task-start'] = { id: 'task-start', state: 'paused', kind: 'triage', branch: null, tmuxSession: null, repoId: null, subjectRef: 'request:abcd1234' };
    const { driver, runner, observer } = host([found('task-start')]);
    Object.assign(runner, { isStarting: (taskId: string) => taskId === 'task-start' });

    await observer.reapComputers();

    expect(driver.adopt).not.toHaveBeenCalled();
    expect(runner.adopt).not.toHaveBeenCalled();
  });

  it('releases the computer of a task that is over, or that no task names', async () => {
    ROWS['task-done'] = { id: 'task-done', state: 'done', kind: 'review', branch: null, tmuxSession: null, repoId: null, subjectRef: 'widgets#8' };
    const { driver, runner, observer } = host([found('task-done'), found('task-gone')]);

    await observer.reapComputers();

    expect(driver.release.mock.calls).toEqual([
      ['task-done', 'its task is done'],
      ['task-gone', 'no task names it'],
    ]);
    expect(runner.adopt).not.toHaveBeenCalled();
  });

  it('leaves what is held to the runner, and removes a container that says nothing about whose it is', async () => {
    ROWS['task-held'] = { id: 'task-held', state: 'done', kind: 'implement', branch: null, tmuxSession: null, repoId: null, subjectRef: 'widgets#9' };
    const { driver, runner, observer } = host([found('task-held'), found(null, 'task-deadbeef')], ['task-held']);

    await observer.reapComputers();

    // `forgetFinishedTasks` ends a held task, with its branch kept first.
    expect(driver.release).not.toHaveBeenCalled();
    expect(driver.discard).toHaveBeenCalledWith('task-deadbeef');
    expect(runner.pruneAbandonedSlots).toHaveBeenCalled();
    expect(runner.dropFinishedTaskRefs).toHaveBeenCalled();
  });

  it('names the branch of a task over for good when its kept branch goes, so what it never pushed is set aside there', async () => {
    ROWS['task-failed'] = { id: 'task-failed', state: 'failed', kind: 'implement', branch: 'agent/atlas/7-issue-7', tmuxSession: null, repoId: 'repo-1', subjectRef: 'widgets#7' };
    ROWS['task-paused'] = { id: 'task-paused', state: 'paused', kind: 'implement', branch: 'agent/atlas/8-issue-8', tmuxSession: null, repoId: 'repo-1', subjectRef: 'widgets#8' };
    const { runner, observer } = host([]);

    await observer.reapComputers();

    const isOver = (vi.mocked(runner.dropFinishedTaskRefs).mock.calls as unknown as [(taskId: string) => Promise<unknown>][])[0]![0];
    expect(await isOver('task-failed')).toEqual({ branch: 'agent/atlas/7-issue-7' });
    expect(await isOver('task-paused')).toBe(false);
    expect(await isOver('task-nobody')).toEqual({ branch: null });
  });

  it('drains a warm computer a hostd before this one made, keeps the pool’s own, then fills the pool', async () => {
    const theirs: FoundComputer = { name: 'warm-0ld0ld00', kind: 'warm', taskId: null, bot: null, slotDir: '/work/slots/warm-0ld0ld00', running: true, image: null, repoKey: null };
    const ours: FoundComputer = { ...theirs, name: 'warm-a1b2c3d4', slotDir: '/work/slots/warm-a1b2c3d4' };
    const { driver, observer } = host([theirs, ours]);
    const refreshWarm = vi.fn(async () => undefined);
    Object.assign(driver, { isWarm: (name: string) => name === ours.name, refreshWarm });

    await observer.reapComputers();

    expect(driver.discard).toHaveBeenCalledWith('warm-0ld0ld00');
    expect(driver.discard).not.toHaveBeenCalledWith('warm-a1b2c3d4');
    expect(refreshWarm).toHaveBeenCalled();
  });

  it('does not race a start: a computer acquired for a task not held yet is left alone', async () => {
    ROWS['task-starting'] = { id: 'task-starting', state: 'queued', kind: 'implement', branch: null, tmuxSession: null, repoId: null, subjectRef: 'widgets#10' };
    const { driver, runner, observer } = host([found('task-starting')]);
    vi.mocked(driver.computerOf).mockReturnValue(computerFor(found('task-starting')));

    await observer.reapComputers();

    expect(runner.adopt).not.toHaveBeenCalled();
  });
});

/**
 * A lookup that failed was read as "no row", and no row counts as over: one
 * reap during a database outage deleted every paused task's kept branch, the
 * only copy of its unpushed commits.
 */
describe('while the database cannot be read', () => {
  const down = () => vi.mocked(db.tasks.getTask).mockRejectedValue(new Error('connect ECONNREFUSED'));

  /** A runner whose kept branches answer to `isOver` the way `Worktrees.dropTaskRefs` asks it. */
  function withKeptBranches(computers: FoundComputer[], held: string[], kept: string[]) {
    const made = host(computers, held);
    const answers: Array<boolean | { branch: string | null } | 'rejected'> = [];
    const pausedAnswers: boolean[] = [];
    const dropFinishedTaskRefs = vi.fn(async (isOver: (taskId: string) => Promise<boolean | { branch: string | null }>) => {
      let dropped = 0;
      for (const taskId of kept) {
        const over = await isOver(taskId).catch(() => 'rejected' as const);
        answers.push(over);
        if (over && over !== 'rejected') dropped += 1;
      }
      return dropped;
    });
    const releasePausedPast = vi.fn(async (_keepMs: number, isPaused: (taskId: string) => Promise<boolean>) => {
      for (const taskId of kept) pausedAnswers.push(await isPaused(taskId));
      return [];
    });
    return { ...made, runner: Object.assign(made.runner, { dropFinishedTaskRefs, releasePausedPast }), answers, pausedAnswers };
  }

  it('drops no kept branch, gives back or removes no computer, and ends no held task', async () => {
    ROWS['task-paused'] = { id: 'task-paused', state: 'paused', kind: 'implement', branch: 'agent/atlas/7-issue-7', tmuxSession: null, repoId: 'repo-1', subjectRef: 'widgets#7' };
    const { driver, runner, observer, answers } = withKeptBranches([found('task-paused'), found('task-other')], ['task-held'], ['task-paused', 'task-other']);
    down();

    await observer.tick();

    expect(runner.dropFinishedTaskRefs).toHaveBeenCalled();
    expect(answers).toEqual(['rejected', 'rejected']);
    expect(driver.release).not.toHaveBeenCalled();
    expect(driver.discard).not.toHaveBeenCalled();
    expect(driver.adopt).not.toHaveBeenCalled();
    expect(runner.adopt).not.toHaveBeenCalled();
    expect(runner.end).not.toHaveBeenCalled();
  });

  it('gives back no paused task’s computer', async () => {
    const { observer, pausedAnswers } = withKeptBranches([], [], ['task-paused']);
    down();

    await observer.reapComputers();

    expect(pausedAnswers).toEqual([false]);
  });

  it('does not reap at all when the tick’s own database work failed', async () => {
    const { driver, runner, observer } = withKeptBranches([found('task-gone')], [], ['task-gone']);
    vi.mocked(db.hosts.heartbeat).mockRejectedValue(new Error('connect ECONNREFUSED'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await observer.tick();

    expect(driver.computers).not.toHaveBeenCalled();
    expect(runner.dropFinishedTaskRefs).not.toHaveBeenCalled();
    expect(driver.release).not.toHaveBeenCalled();
  });

  it('still drops the kept branch of a task that is over or has no row, once the database answers', async () => {
    ROWS['task-done'] = { id: 'task-done', state: 'done', kind: 'implement', branch: null, tmuxSession: null, repoId: null, subjectRef: 'widgets#8' };
    ROWS['task-paused'] = { id: 'task-paused', state: 'paused', kind: 'implement', branch: null, tmuxSession: null, repoId: null, subjectRef: 'widgets#9' };
    const { observer, answers } = withKeptBranches([], [], ['task-done', 'task-gone', 'task-paused']);

    await observer.reapComputers();

    expect(answers).toEqual([{ branch: null }, { branch: null }, false]);
  });
});

describe('a computer whose task is over', () => {
  it('is left to a start that holds it or is making it', async () => {
    const { driver, runner, observer } = host([found('task-gone'), found('task-other')]);
    vi.mocked(driver.computerOf).mockImplementation(((taskId: string) => (taskId === 'task-gone' ? computerFor(found('task-gone')) : null)) as never);
    Object.assign(runner, { isStarting: (taskId: string) => taskId === 'task-other' });

    await observer.reapComputers();

    expect(driver.release).not.toHaveBeenCalled();
    expect(driver.discard).not.toHaveBeenCalled();
  });
});
