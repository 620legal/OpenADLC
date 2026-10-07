import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitAuthEnv, readSlotTask, SCRATCH_DIR, SET_ASIDE_DAYS, SET_ASIDE_LOG, SLOT_FILE, setAsideBrief, slotRecordPath, Worktrees, writeSlotTask } from './worktree.js';

const run = promisify(execFile);

/**
 * A worktree is only ever removed by `TaskRunner.end`, so every task that ended
 * any other way left one behind — and each holds its branch checked out, which
 * is what made `git checkout -B agent/<bot>/<n>-…` fail with "already used by
 * worktree" and stopped the same issue ever being worked twice on one bot. 167
 * had accumulated on a development install.
 *
 * No mirror is passed, so these exercise the filesystem path rather than git's:
 * what is being pinned is which directories are chosen, not how they are
 * unregistered.
 */
describe('clearing worktrees left by tasks that ended', () => {
  let root: string;
  let worktrees: Worktrees;

  const seed = (bot: string, taskId: string): string => {
    const path = join(root, bot, 'wt', taskId);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'file.txt'), 'work in progress');
    return path;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fleetadlc-wt-'));
    worktrees = new Worktrees(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('lists what is on disk by task id', () => {
    seed('atlas', 'task-a');
    seed('atlas', 'task-b');

    expect(worktrees.listWorktreeTaskIds('atlas').sort()).toEqual(['task-a', 'task-b']);
  });

  it('is empty rather than throwing for a bot that has never run anything', () => {
    expect(worktrees.listWorktreeTaskIds('nobody')).toEqual([]);
  });

  it('removes the dead ones and keeps what is still running', async () => {
    seed('atlas', 'finished-1');
    seed('atlas', 'finished-2');
    seed('atlas', 'still-running');

    const removed = await worktrees.pruneAbandoned('atlas', (taskId) => taskId === 'still-running');

    expect(removed).toBe(2);
    expect(worktrees.listWorktreeTaskIds('atlas')).toEqual(['still-running']);
  });

  it('removes nothing while everything is live', async () => {
    seed('atlas', 'a');
    seed('atlas', 'b');

    expect(await worktrees.pruneAbandoned('atlas', () => true)).toBe(0);
    expect(worktrees.listWorktreeTaskIds('atlas').sort()).toEqual(['a', 'b']);
  });

  it('does not touch another bot, whose tasks it knows nothing about', async () => {
    seed('atlas', 'atlas-task');
    seed('mira', 'mira-task');

    // `isLive` is the runner's own map, which only covers this host's tasks for
    // this bot — so pruning has to stay inside the bot it was asked about.
    await worktrees.pruneAbandoned('atlas', () => false);

    expect(worktrees.listWorktreeTaskIds('atlas')).toEqual([]);
    expect(worktrees.listWorktreeTaskIds('mira')).toEqual(['mira-task']);
  });

  it('clears a backlog in one pass, which is how it is met at startup', async () => {
    for (let index = 0; index < 167; index += 1) seed('atlas', `leaked-${index}`);

    expect(await worktrees.pruneAbandoned('atlas', () => false)).toBe(167);
    expect(worktrees.listWorktreeTaskIds('atlas')).toEqual([]);
  });
});

/**
 * Two tasks in one repository at once, which a seat running several tasks
 * makes ordinary.
 *
 * Under worktrees of one mirror per bot, a branch checked out in one worktree
 * could not be checked out in another ("already used by worktree"), and the
 * mirror's branches were the tasks' own: a fetch for one task, with `--prune`
 * and `+`, deleted another task's unpushed branch or reset it to the remote.
 * Each task now has a clone of its own, and the mirror's branches are only
 * ever the remote's.
 */
describe('two tasks in one repository at once', () => {
  let root: string;
  let origin: string;
  let worktrees: Worktrees;

  const sh = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();
  const request = (taskId: string, branch: string) => ({
    bot: 'atlas',
    taskId,
    repoFullName: 'example/repo',
    remote: origin,
    baseRef: 'refs/heads/main',
    branch,
    token: null,
    keepUnpushed: true,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fleetadlc-wt-git-'));
    origin = join(root, 'origin');
    mkdirSync(origin, { recursive: true });
    sh(origin, 'init', '-q', '-b', 'main');
    writeFileSync(join(origin, 'README.md'), 'hello\n');
    sh(origin, 'add', 'README.md');
    sh(origin, 'commit', '-qm', 'first');
    worktrees = new Worktrees(join(root, 'work'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('copies the mirror’s objects rather than linking them, so a task cannot rewrite the mirror through its clone', async () => {
    const one = await worktrees.create(request('task-one', 'agent/atlas/1-issue-1'));
    const head = sh(one.path, 'rev-parse', 'HEAD');
    const object = join('objects', head.slice(0, 2), head.slice(2));
    const inMirror = join(one.mirror, object);
    const inClone = join(one.path, '.git', object);
    // A loose object in both: a link would be one file with two names.
    expect(existsSync(inMirror) && existsSync(inClone)).toBe(true);
    expect(statSync(inClone).ino).not.toBe(statSync(inMirror).ino);
  });

  it('starts both from one mirror at once, each in a clone of its own', async () => {
    // Two fetches into one mirror at once failed on its ref locks; the mirror
    // lock queues them.
    const [one, two] = await Promise.all([
      worktrees.create(request('task-one', 'agent/atlas/1-issue-1')),
      worktrees.create(request('task-two', 'agent/atlas/2-issue-2')),
    ]);

    expect(one.mirror).toBe(worktrees.mirrorPath('example/repo'));
    expect(two.mirror).toBe(one.mirror);
    expect(one.path).not.toBe(two.path);
    // A real `.git` directory, not a file naming the mirror: nothing in the
    // clone depends on where the mirror is.
    expect(statSync(join(one.path, '.git')).isDirectory()).toBe(true);
    expect(sh(one.path, 'branch', '--show-current')).toBe('agent/atlas/1-issue-1');
    expect(sh(two.path, 'branch', '--show-current')).toBe('agent/atlas/2-issue-2');
    expect(sh(one.path, 'remote', 'get-url', 'origin')).toBe(origin);
  }, 30_000);

  it('gives the same branch to a second task while the first still has it', async () => {
    // "already used by worktree" kept an issue from being worked again on a
    // bot whose earlier task had ended badly.
    await worktrees.create(request('task-one', 'agent/atlas/924-issue-924'));
    const second = await worktrees.create(request('task-two', 'agent/atlas/924-issue-924'));
    expect(sh(second.path, 'branch', '--show-current')).toBe('agent/atlas/924-issue-924');
  }, 30_000);

  it('leaves one task’s unpushed commits alone when another task fetches the mirror', async () => {
    const branch = 'agent/atlas/5-issue-5';
    const first = await worktrees.create(request('task-one', branch));
    writeFileSync(join(first.path, 'work.ts'), 'unpushed\n');
    sh(first.path, 'add', 'work.ts');
    sh(first.path, 'commit', '-qm', 'the work');
    const work = sh(first.path, 'rev-parse', 'HEAD');
    // Paused: its computer goes, and its branch is kept in the mirror.
    expect(await worktrees.harvest({ path: first.path, taskId: 'task-one', repoFullName: 'example/repo', branch })).toBe(true);
    await worktrees.remove(first.path);

    // Another task's fetch, which prunes every branch the remote lacks.
    sh(origin, 'commit', '--allow-empty', '-qm', 'main moves on');
    await worktrees.create(request('task-two', 'agent/atlas/6-issue-6'));
    expect(sh(first.mirror, 'for-each-ref', '--format=%(refname)', `refs/heads/${branch}`)).toBe('');

    const resumed = await worktrees.checkoutExisting({ ...request('task-one', branch), branch, startFromBaseIfMissing: true });
    expect(sh(resumed.path, 'rev-parse', 'HEAD')).toBe(work);
    expect(readFileSync(join(resumed.path, 'work.ts'), 'utf8')).toBe('unpushed\n');
  }, 30_000);

  it('removes a dead task’s clone, keeping its branch, and leaves a live one alone', async () => {
    const branch = 'agent/atlas/7-issue-7';
    const dead = await worktrees.create(request('task-dead', branch));
    writeFileSync(join(dead.path, 'work.ts'), 'left behind\n');
    sh(dead.path, 'add', 'work.ts');
    sh(dead.path, 'commit', '-qm', 'left behind');
    const work = sh(dead.path, 'rev-parse', 'HEAD');
    await worktrees.create(request('task-live', 'agent/atlas/8-issue-8'));

    const removed = await worktrees.pruneAbandoned('atlas', (taskId) => taskId === 'task-live', async (taskId) =>
      taskId === 'task-dead' ? { repoFullName: 'example/repo', branch } : null,
    );

    expect(removed).toBe(1);
    expect(worktrees.listWorktreeTaskIds('atlas')).toEqual(['task-live']);
    // What a paused task's resume after a restart reads back.
    expect(sh(dead.mirror, 'rev-parse', 'refs/fleetadlc/tasks/task-dead/head')).toBe(work);
  }, 30_000);

  it('drops the kept branch of a task once it has ended for good, and keeps a paused one’s', async () => {
    for (const id of ['task-done', 'task-paused']) {
      const made = await worktrees.create(request(id, `agent/atlas/${id}`));
      await worktrees.harvest({ path: made.path, taskId: id, repoFullName: 'example/repo', branch: `agent/atlas/${id}` });
    }

    const mirror = worktrees.mirrorPath('example/repo');
    const done = sh(mirror, 'rev-parse', 'refs/fleetadlc/tasks/task-done/head');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await worktrees.dropTaskRefs(async (taskId) => taskId === 'task-done')).toBe(1);

    expect(sh(mirror, 'for-each-ref', '--format=%(refname)', 'refs/fleetadlc/tasks/')).toBe(
      'refs/fleetadlc/tasks/task-paused/head',
    );
    // What an operator needs to put it back with `git update-ref`.
    const dropped = log.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('dropped the kept branch'));
    expect(dropped).toEqual([`[hostd] dropped the kept branch of task task-done in ${mirror}: head ${done}, pushed none`]);
    log.mockRestore();
  }, 30_000);

  it('keeps the kept branch of a task the database could not answer for', async () => {
    const made = await worktrees.create(request('task-paused', 'agent/atlas/task-paused'));
    await worktrees.harvest({ path: made.path, taskId: 'task-paused', repoFullName: 'example/repo', branch: 'agent/atlas/task-paused' });

    expect(await worktrees.dropTaskRefs(async () => Promise.reject(new Error('connect ECONNREFUSED')))).toBe(0);

    expect(sh(worktrees.mirrorPath('example/repo'), 'for-each-ref', '--format=%(refname)', 'refs/fleetadlc/tasks/')).toBe(
      'refs/fleetadlc/tasks/task-paused/head',
    );
  }, 30_000);
});

/**
 * A task's directory is mounted read-write into its computer, so anything in
 * it — the record of whose it is, its clone's config — is the task's to
 * write. A task that named a paused victim there had its commits harvested
 * into the victim's kept branch, in the repository and branch it chose.
 */
describe('a leftover task directory, harvested', () => {
  let root: string;
  let origin: string;
  let worktrees: Worktrees;
  const BRANCH = 'agent/atlas/30-issue-30';

  const sh = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();
  const later = () => Date.now() + 3 * 60_000;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fleetadlc-wt-slots-'));
    origin = join(root, 'origin');
    mkdirSync(origin, { recursive: true });
    sh(origin, 'init', '-q', '-b', 'main');
    writeFileSync(join(origin, 'README.md'), 'hello\n');
    sh(origin, 'add', 'README.md');
    sh(origin, 'commit', '-qm', 'first');
    worktrees = new Worktrees(join(root, 'work'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  /** A task's directory with a clone that committed, as a computer leaves it. */
  async function slotWithWork(taskId: string, dir: string) {
    const made = await worktrees.create({
      bot: 'atlas',
      taskId,
      repoFullName: 'example/repo',
      remote: origin,
      baseRef: 'refs/heads/main',
      branch: BRANCH,
      token: null,
      keepUnpushed: true,
      path: join(dir, 'wt'),
    });
    writeFileSync(join(made.path, 'work.ts'), 'work\n');
    sh(made.path, 'add', 'work.ts');
    sh(made.path, 'commit', '-qm', 'work');
    return { mirror: made.mirror, path: made.path, work: sh(made.path, 'rev-parse', 'HEAD') };
  }

  it('keeps its record beside the directory, out of the computer’s reach, and reads an old one inside only as a claim', () => {
    const dir = join(root, 'work', 'slots', 'task-a-1');
    writeSlotTask(dir, { taskId: 'task-a', bot: 'atlas' });
    expect(slotRecordPath(dir)).toBe(join(root, 'work', 'slots', 'task-a-1.json'));
    expect(existsSync(join(dir, SLOT_FILE))).toBe(false);
    expect(readSlotTask(dir)).toEqual({ taskId: 'task-a', bot: 'atlas' });

    // What the task writes in its own directory does not change what hostd wrote.
    writeFileSync(join(dir, SLOT_FILE), JSON.stringify({ taskId: 'task-victim', bot: 'atlas' }));
    expect(readSlotTask(dir)).toEqual({ taskId: 'task-a', bot: 'atlas' });

    const old = join(root, 'work', 'slots', 'task-b-1');
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, SLOT_FILE), JSON.stringify({ taskId: 'task-b', bot: 'atlas' }));
    expect(readSlotTask(old)).toEqual({ taskId: 'task-b', bot: 'atlas', inDirectory: true });
  });

  it('goes into the repository and branch the task’s row has, whatever its clone’s config says', async () => {
    const dir = join(root, 'work', 'slots', 'task-a-1');
    const { mirror, path, work } = await slotWithWork('task-a', dir);
    writeSlotTask(dir, { taskId: 'task-a', bot: 'atlas' });
    // Written by the task: another repository and another task's branch.
    sh(path, 'config', 'fleetadlc.repo', 'example/other');
    sh(path, 'config', 'fleetadlc.branch', 'agent/atlas/99-victim');
    sh(path, 'config', 'fleetadlc.keep', 'true');
    const asked: string[] = [];
    const keptBranchOf = async (taskId: string) => {
      asked.push(taskId);
      return taskId === 'task-a' ? { repoFullName: 'example/repo', branch: BRANCH } : null;
    };

    expect(await worktrees.pruneSlots(join(root, 'work', 'slots'), () => false, { now: later(), keptBranchOf })).toBe(1);

    expect(asked).toEqual(['task-a']);
    expect(sh(mirror, 'rev-parse', 'refs/fleetadlc/tasks/task-a/head')).toBe(work);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(slotRecordPath(dir))).toBe(false);
  }, 30_000);

  it('is kept for no task when only the record inside it says whose it is, and says so', async () => {
    const dir = join(root, 'work', 'slots', 'task-attacker-1');
    const { mirror } = await slotWithWork('task-attacker', dir);
    writeFileSync(join(dir, SLOT_FILE), JSON.stringify({ taskId: 'task-victim', bot: 'atlas' }));
    const keptBranchOf = vi.fn(async (taskId: string) => (taskId === 'task-victim' ? { repoFullName: 'example/repo', branch: BRANCH } : null));

    expect(await worktrees.pruneSlots(join(root, 'work', 'slots'), () => false, { now: later(), keptBranchOf })).toBe(1);

    expect(keptBranchOf).not.toHaveBeenCalledWith('task-victim');
    expect(sh(mirror, 'for-each-ref', '--format=%(refname)', 'refs/fleetadlc/tasks/')).toBe('');
    expect(vi.mocked(console.log).mock.calls.map((call) => String(call[0]))).toContain(
      `[hostd] ${dir} says it is task task-victim only from inside itself; its clone is kept for no task but task-attacker-1's, if that is one`,
    );
  }, 30_000);

  it('still leaves alone a directory a live task’s old record claims, and clears a record whose directory is gone', async () => {
    const slots = join(root, 'work', 'slots');
    const old = join(slots, 'task-live-1');
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, SLOT_FILE), JSON.stringify({ taskId: 'task-live', bot: 'atlas' }));
    writeSlotTask(join(slots, 'task-gone-1'), { taskId: 'task-gone', bot: 'atlas' });
    rmSync(join(slots, 'task-gone-1'), { recursive: true });

    expect(await worktrees.pruneSlots(slots, (taskId) => taskId === 'task-live', { now: later() })).toBe(0);

    expect(existsSync(old)).toBe(true);
    expect(existsSync(slotRecordPath(join(slots, 'task-gone-1')))).toBe(false);
  });
});

/**
 * A paused builder whose computer was given back keeps its unpushed commits
 * only under `refs/fleetadlc/tasks/<id>/head`. When its resume failed, or a
 * person stopped it, the reaper deleted those refs within a minute, and Try
 * again starts a new task id that could not reach them: the work was
 * garbage-collected later, and nobody was told it had existed.
 */
describe('the unpushed commits of a task that ended for good', () => {
  let root: string;
  let origin: string;
  let worktrees: Worktrees;
  const BRANCH = 'agent/atlas/31-issue-31';

  const sh = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();
  const commitIn = (cwd: string, file: string, text: string) => {
    writeFileSync(join(cwd, file), text);
    sh(cwd, 'add', file);
    sh(cwd, 'commit', '-qm', `write ${file}`);
    return sh(cwd, 'rev-parse', 'HEAD');
  };
  const request = (taskId: string) => ({
    bot: 'atlas',
    taskId,
    repoFullName: 'example/repo',
    remote: origin,
    baseRef: 'refs/heads/main',
    branch: BRANCH,
    token: null,
    keepUnpushed: true,
  });
  const ended = async (taskId: string) => (taskId === 'task-failed' ? { branch: BRANCH } : false);
  const unpushedRefs = (mirror: string) => sh(mirror, 'for-each-ref', '--format=%(refname)', 'refs/fleetadlc/unpushed/');

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fleetadlc-wt-ended-'));
    origin = join(root, 'origin');
    mkdirSync(origin, { recursive: true });
    sh(origin, 'init', '-q', '-b', 'main');
    commitIn(origin, 'README.md', 'hello\n');
    worktrees = new Worktrees(join(root, 'work'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  /** A task that commits, is harvested as a released paused task is, and then fails. */
  async function failedWith(pushFirst: boolean) {
    const made = await worktrees.create(request('task-failed'));
    let pushed: string | null = null;
    if (pushFirst) {
      pushed = commitIn(made.path, 'change.ts', 'A\n');
      sh(made.path, 'push', '-q', 'origin', BRANCH);
    }
    const work = commitIn(made.path, 'other.ts', 'B\n');
    await worktrees.harvest({ path: made.path, taskId: 'task-failed', repoFullName: 'example/repo', branch: BRANCH });
    await worktrees.remove(made.path);
    return { mirror: made.mirror, work, pushed };
  }

  it('keeps them as a set-aside on its branch, logged and dated, when its kept branch is dropped', async () => {
    const { mirror, work } = await failedWith(false);

    expect(await worktrees.dropTaskRefs(ended)).toBe(1);

    expect(sh(mirror, 'for-each-ref', '--format=%(refname)', 'refs/fleetadlc/tasks/')).toBe('');
    expect(sh(mirror, 'rev-parse', `refs/fleetadlc/unpushed/${BRANCH}`)).toBe(work);
    expect(Object.keys(JSON.parse(readFileSync(join(mirror, SET_ASIDE_LOG), 'utf8')))).toEqual([`refs/fleetadlc/unpushed/${BRANCH}`]);
    const said = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
    expect(said).toContain(
      `[hostd] task task-failed ended with 1 commit(s) on ${BRANCH} never pushed; they are kept at refs/fleetadlc/unpushed/${BRANCH} in ${mirror} for ${SET_ASIDE_DAYS} days`,
    );
  }, 30_000);

  it('keeps them under the task’s own name when its branch is not known', async () => {
    const { mirror, work } = await failedWith(false);

    expect(await worktrees.dropTaskRefs(async (taskId) => taskId === 'task-failed')).toBe(1);

    expect(sh(mirror, 'rev-parse', 'refs/fleetadlc/unpushed/task-task-failed')).toBe(work);
  }, 30_000);

  it('writes no set-aside for a task that had pushed everything, and drops its refs as before', async () => {
    const made = await worktrees.create(request('task-failed'));
    commitIn(made.path, 'change.ts', 'A\n');
    sh(made.path, 'push', '-q', 'origin', BRANCH);
    await worktrees.harvest({ path: made.path, taskId: 'task-failed', repoFullName: 'example/repo', branch: BRANCH });

    expect(await worktrees.dropTaskRefs(ended)).toBe(1);

    expect(unpushedRefs(made.mirror)).toBe('');
    expect(sh(made.mirror, 'for-each-ref', '--format=%(refname)', 'refs/fleetadlc/tasks/')).toBe('');
  }, 30_000);

  it('does not overwrite an earlier set-aside on the branch', async () => {
    const { mirror, work } = await failedWith(false);
    const base = sh(mirror, 'rev-parse', 'refs/heads/main');
    sh(mirror, 'update-ref', `refs/fleetadlc/unpushed/${BRANCH}`, base);

    await worktrees.dropTaskRefs(ended);

    expect(sh(mirror, 'rev-parse', `refs/fleetadlc/unpushed/${BRANCH}`)).toBe(work);
    expect(sh(mirror, 'rev-parse', `refs/fleetadlc/unpushed/${BRANCH}-${base.slice(0, 12)}`)).toBe(base);
  }, 30_000);

  it('tells the next task that builds the branch, from the base, which commits were left', async () => {
    const { work } = await failedWith(false);
    await worktrees.dropTaskRefs(ended);

    const next = await worktrees.create(request('task-again'));

    expect(next.setAside).toEqual({ ref: `refs/fleetadlc/unpushed/${BRANCH}`, tip: work, commits: [work], reason: 'ended' });
    // Reachable from its clone, as the brief says.
    expect(sh(next.path, 'rev-parse', `refs/fleetadlc/unpushed/${BRANCH}`)).toBe(work);
    const brief = setAsideBrief(BRANCH, next.setAside!);
    expect(brief).toContain('An earlier task');
    expect(brief).toContain(`git cherry-pick ${work}`);
    // A review is never told: it does not write the branch.
    expect((await worktrees.create({ ...request('task-review'), keepUnpushed: false })).setAside).toBeUndefined();
  }, 30_000);

  it('tells the next round on a pushed branch only of what the remote lacks', async () => {
    const { work, pushed } = await failedWith(true);
    await worktrees.dropTaskRefs(ended);

    const next = await worktrees.checkoutExisting({ ...request('task-again'), branch: BRANCH });

    expect(sh(next.path, 'rev-parse', 'HEAD')).toBe(pushed);
    expect(next.setAside).toEqual({ ref: `refs/fleetadlc/unpushed/${BRANCH}`, tip: work, commits: [work], reason: 'ended' });
  }, 30_000);

  it('ages them out with every other set-aside', async () => {
    const { mirror } = await failedWith(false);
    await worktrees.dropTaskRefs(ended);

    await worktrees.dropOldSetAsides(mirror, Date.now() + (SET_ASIDE_DAYS + 1) * 24 * 3600 * 1000);

    expect(unpushedRefs(mirror)).toBe('');
    expect((await worktrees.create(request('task-again'))).setAside).toBeUndefined();
  }, 30_000);
});

/**
 * Bots kept a mirror each of every repository they worked in, and a paused
 * task's unpushed commits were in its bot's mirror and nowhere else: its
 * worktree committed straight into it. Resumed after the upgrade from the
 * repository's mirror, it would have started from its last push.
 */
describe('a paused task from before mirrors were one per repository', () => {
  let root: string;
  let origin: string;

  const sh = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fleetadlc-wt-legacy-'));
    origin = join(root, 'origin');
    mkdirSync(origin, { recursive: true });
    sh(origin, 'init', '-q', '-b', 'main');
    writeFileSync(join(origin, 'README.md'), 'hello\n');
    sh(origin, 'add', 'README.md');
    sh(origin, 'commit', '-qm', 'first');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resumes from the commits its bot’s own mirror held, and keeps that mirror’s set-asides', async () => {
    const branch = 'agent/builder/12-issue-12';
    const work = join(root, 'work');
    // The old layout: `<bot>/repos/<owner>__<repo>.git`, a worktree off it
    // under `<bot>/wt/<task>`, committing into the mirror's own branch.
    const legacy = join(work, 'builder', 'repos', 'acme__widgets.git');
    mkdirSync(join(work, 'builder', 'repos'), { recursive: true });
    sh(root, 'clone', '-q', '--bare', origin, legacy);
    const old = join(work, 'builder', 'wt', 'task-12');
    sh(legacy, 'worktree', 'add', '-q', '--detach', old, 'refs/heads/main');
    sh(old, 'checkout', '-q', '-B', branch);
    writeFileSync(join(old, 'work.ts'), 'never pushed\n');
    sh(old, 'add', 'work.ts');
    sh(old, 'commit', '-qm', 'the work');
    const tip = sh(old, 'rev-parse', 'HEAD');
    sh(legacy, 'update-ref', `refs/fleetadlc/unpushed/${branch}`, tip);
    writeFileSync(join(legacy, SET_ASIDE_LOG), JSON.stringify({ [`refs/fleetadlc/unpushed/${branch}`]: 1_700_000_000_000 }));

    const worktrees = new Worktrees(work);
    const imported = await worktrees.importLegacyMirrors([{ taskId: 'task-12', bot: 'builder', repoFullName: 'acme/widgets', branch }]);
    expect(imported).toEqual({ tasks: 1, mirrors: 1 });
    // Once is enough: a second start finds both already carried.
    expect(await worktrees.importLegacyMirrors([{ taskId: 'task-12', bot: 'builder', repoFullName: 'acme/widgets', branch }])).toEqual({ tasks: 0, mirrors: 0 });

    const mirror = worktrees.mirrorPath('acme/widgets');
    expect(sh(mirror, 'rev-parse', `refs/fleetadlc/unpushed/${branch}`)).toBe(tip);
    expect(JSON.parse(readFileSync(join(mirror, SET_ASIDE_LOG), 'utf8'))).toMatchObject({ [`refs/fleetadlc/unpushed/${branch}`]: 1_700_000_000_000 });

    const resumed = await worktrees.checkoutExisting({
      bot: 'builder',
      taskId: 'task-12',
      repoFullName: 'acme/widgets',
      remote: origin,
      baseRef: 'refs/heads/main',
      branch,
      token: null,
      startFromBaseIfMissing: true,
      keepUnpushed: true,
    });
    expect(sh(resumed.path, 'rev-parse', 'HEAD')).toBe(tip);
    expect(readFileSync(join(resumed.path, 'work.ts'), 'utf8')).toBe('never pushed\n');
  }, 30_000);
  it('carries no credential an old mirror’s URL held into the new one', async () => {
    const work = join(root, 'work');
    const legacy = join(work, 'builder', 'repos', 'acme__widgets.git');
    mkdirSync(join(work, 'builder', 'repos'), { recursive: true });
    sh(root, 'clone', '-q', '--bare', origin, legacy);
    sh(legacy, 'remote', 'set-url', 'origin', 'https://x-access-token:ghu_OLDTOKEN@github.com/acme/widgets.git');

    const worktrees = new Worktrees(work);
    expect(await worktrees.importLegacyMirrors([])).toEqual({ tasks: 0, mirrors: 1 });

    expect(sh(worktrees.mirrorPath('acme/widgets'), 'config', '--get', 'remote.origin.url')).toBe('https://github.com/acme/widgets.git');
  }, 30_000);
});

/**
 * A bot works in every repository OpenADLC does, the way an engineer keeps a
 * clone of each project they work on. Each repository has its own mirror,
 * and each task a clone of the mirror of its repository —
 * so issue #1 in one and issue #1 in another can be worked on at once, on a
 * branch each of the same name, which one shared copy would refuse.
 */
describe('one bot working in two repositories', () => {
  let root: string;
  let worktrees: Worktrees;

  const origin = (name: string, file: string): string => {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    const run = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'ignore' });
    run('init', '-q', '-b', 'main');
    writeFileSync(join(path, file), `${name}\n`);
    run('add', file);
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'first'], { cwd: path, stdio: 'ignore' });
    return path;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fleetadlc-wt-two-'));
    worktrees = new Worktrees(join(root, 'work'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps a separate copy of each, and starts each task from the copy of its own', async () => {
    const task = (taskId: string, repoFullName: string, remote: string) => ({
      bot: 'atlas',
      taskId,
      repoFullName,
      remote,
      baseRef: 'refs/heads/main',
      branch: 'agent/atlas/1-issue-1',
      token: null,
    });

    const api = await worktrees.create(task('task-api', 'acme/api', origin('api', 'API.md')));
    const web = await worktrees.create(task('task-web', 'acme/web', origin('web', 'WEB.md')));

    expect(api.mirror).toBe(worktrees.mirrorPath('acme/api'));
    expect(web.mirror).toBe(worktrees.mirrorPath('acme/web'));
    expect(api.mirror).not.toBe(web.mirror);
    expect(existsSync(join(api.path, 'API.md'))).toBe(true);
    expect(existsSync(join(web.path, 'WEB.md'))).toBe(true);
    expect(existsSync(join(web.path, 'API.md'))).toBe(false);
    expect(worktrees.listWorktreeTaskIds('atlas').sort()).toEqual(['task-api', 'task-web']);
  }, 30_000);

  it('says what to do when the branch it is asked to start from is not there', async () => {
    // A repository whose default is `master`, stored as `main`.
    const remote = origin('legacy', 'README.md');
    execFileSync('git', ['branch', '-m', 'main', 'master'], { cwd: remote, stdio: 'ignore' });

    const failure = (await worktrees
      .create({ bot: 'atlas', taskId: 'task-legacy', repoFullName: 'acme/legacy', remote, baseRef: 'refs/heads/main', branch: 'agent/atlas/1-issue-1', token: null })
      .then(() => null, (error: unknown) => error)) as Error;

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain('refs/heads/main is not in acme/legacy');
    expect(failure.message).toContain('the one OpenADLC has stored is wrong');
    expect(failure.message).toContain('PATCH /v1/repos/legacy {"defaultBranch": "<branch>"}');
    expect(failure.message).toContain('or let the next reconcile correct it from GitHub');
  }, 30_000);
});

describe('resuming a task that paused before it pushed', () => {
  let root: string;

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('starts from the base when its branch was never pushed, rather than failing "invalid reference"', async () => {
    // A builder asked its question before its first commit, and was resumed
    // with the answer: its branch name was recorded, the branch was not.
    root = mkdtempSync(join(tmpdir(), 'fleetadlc-wt-resume-'));
    const origin = join(root, 'origin');
    mkdirSync(origin, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: origin, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(origin, 'README.md'), 'hello\n');
    git('add', 'README.md');
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'first'], { cwd: origin, stdio: 'ignore' });

    const worktrees = new Worktrees(join(root, 'work'));
    const resumed = await worktrees.checkoutExisting({
      bot: 'builder',
      taskId: 'task-66',
      repoFullName: 'exampleco/fleetadlc',
      remote: origin,
      baseRef: 'refs/heads/main',
      branch: 'agent/builder/66-issue-66',
      token: null,
      startFromBaseIfMissing: true,
    });

    expect(existsSync(join(resumed.path, 'README.md'))).toBe(true);
    expect(execFileSync('git', ['branch', '--show-current'], { cwd: resumed.path, encoding: 'utf8' }).trim()).toBe(
      'agent/builder/66-issue-66',
    );
  }, 30_000);

  it('refuses a missing branch for anything but that resume, rather than handing over the base under its name', async () => {
    // A review of a pull request from a fork, or of a branch deleted since, would
    // otherwise get a worktree of main and review an empty change.
    root = mkdtempSync(join(tmpdir(), 'fleetadlc-wt-missing-'));
    const origin = join(root, 'origin');
    mkdirSync(origin, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: origin, stdio: 'ignore' });
    writeFileSync(join(origin, 'README.md'), 'hello\n');
    execFileSync('git', ['add', 'README.md'], { cwd: origin, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'first'], { cwd: origin, stdio: 'ignore' });

    const worktrees = new Worktrees(join(root, 'work'));
    await expect(
      worktrees.checkoutExisting({
        bot: 'second-reviewer',
        taskId: 'review-7',
        repoFullName: 'exampleco/fleetadlc',
        remote: origin,
        baseRef: 'refs/heads/main',
        branch: 'from-a-fork',
        token: null,
      }),
    ).rejects.toThrow(/is not a branch of exampleco\/fleetadlc.*Push the branch to the repository itself, or start the work again from the issue/);
  }, 30_000);

  it('resumes over its own worktree from before a restart, which holds its branch', async () => {
    // hostd restarted while the task was paused, so it no longer knew the
    // worktree was the task's; the fetch then refused to update the branch the
    // worktree had checked out.
    root = mkdtempSync(join(tmpdir(), 'fleetadlc-wt-restart-'));
    const origin = join(root, 'origin');
    mkdirSync(origin, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: origin, stdio: 'ignore' });
    const commit = (message: string) =>
      execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', message], { cwd: origin, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(origin, 'README.md'), 'hello\n');
    git('add', 'README.md');
    commit('first');
    git('checkout', '-q', '-b', 'agent/builder/70-issue-66');
    writeFileSync(join(origin, 'change.txt'), 'one\n');
    git('add', 'change.txt');
    commit('the change');
    git('checkout', '-q', 'main');

    const worktrees = new Worktrees(join(root, 'work'));
    const request = {
      bot: 'builder',
      taskId: 'task-70',
      repoFullName: 'exampleco/fleetadlc',
      remote: origin,
      baseRef: 'refs/heads/main',
      branch: 'agent/builder/70-issue-66',
      token: null,
    };
    await worktrees.checkoutExisting(request);
    // The branch moves on GitHub while the task is paused.
    git('checkout', '-q', 'agent/builder/70-issue-66');
    writeFileSync(join(origin, 'change.txt'), 'two\n');
    git('add', 'change.txt');
    commit('a newer commit');
    git('checkout', '-q', 'main');

    const again = await worktrees.checkoutExisting(request);
    expect(readFileSync(join(again.path, 'change.txt'), 'utf8')).toBe('two\n');
  }, 30_000);

  it('fetches past a worktree an ended task left registered, its folder already gone', async () => {
    root = mkdtempSync(join(tmpdir(), 'fleetadlc-wt-stale-'));
    const origin = join(root, 'origin');
    mkdirSync(origin, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: origin, stdio: 'ignore' });
    const commit = (message: string) =>
      execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', message], { cwd: origin, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(origin, 'README.md'), 'hello\n');
    git('add', 'README.md');
    commit('first');
    git('checkout', '-q', '-b', 'agent/builder/70-issue-66');
    writeFileSync(join(origin, 'change.txt'), 'one\n');
    git('add', 'change.txt');
    commit('the change');
    git('checkout', '-q', 'main');

    const worktrees = new Worktrees(join(root, 'work'));
    const task = (taskId: string) => ({
      bot: 'builder',
      taskId,
      repoFullName: 'exampleco/fleetadlc',
      remote: origin,
      baseRef: 'refs/heads/main',
      branch: 'agent/builder/70-issue-66',
      token: null,
    });
    await worktrees.checkoutExisting(task('round-1'));
    git('checkout', '-q', 'agent/builder/70-issue-66');
    writeFileSync(join(origin, 'change.txt'), 'two\n');
    git('add', 'change.txt');
    commit('a newer commit');
    git('checkout', '-q', 'main');

    // Round 1 ended with its folder gone but git still holding it registered —
    // the state a second review round met on a real install.
    rmSync(join(root, 'work', 'builder', 'wt', 'round-1'), { recursive: true, force: true });
    const next = await worktrees.checkoutExisting(task('round-2'));
    expect(readFileSync(join(next.path, 'change.txt'), 'utf8')).toBe('two\n');
  }, 30_000);
});

describe('resuming a task whose commits are not all on the remote', () => {
  // The mirror's fetch mirrors the remote's branches with `--prune` and `+`,
  // and a task commits into the mirror's own branch. A branch never pushed was
  // deleted as stale on resume, and one pushed and then built on was reset to
  // the push: the task's commits were gone.
  let root: string;
  let origin: string;
  let worktrees: Worktrees;
  const BRANCH = 'agent/builder/92-keep-work';

  const sh = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();
  const commitIn = (cwd: string, file: string, text: string) => {
    writeFileSync(join(cwd, file), text);
    sh(cwd, 'add', file);
    sh(cwd, 'commit', '-qm', `write ${file}`);
  };
  const resume = () =>
    worktrees.checkoutExisting({
      bot: 'builder',
      taskId: 'task-92',
      repoFullName: 'exampleco/fleetadlc',
      remote: origin,
      baseRef: 'refs/heads/main',
      branch: BRANCH,
      token: null,
      startFromBaseIfMissing: true,
      keepUnpushed: true,
    });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fleetadlc-wt-keep-'));
    origin = join(root, 'origin');
    mkdirSync(origin, { recursive: true });
    sh(origin, 'init', '-q', '-b', 'main');
    commitIn(origin, 'README.md', 'hello\n');
    worktrees = new Worktrees(join(root, 'work'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps a branch that was never pushed, with its commit, and still prunes what the remote deleted', async () => {
    sh(origin, 'branch', 'agent/builder/7-merged');
    const first = await resume();
    commitIn(first.path, 'change.ts', 'the work\n');
    const work = sh(first.path, 'rev-parse', 'HEAD');
    // Merged and deleted on GitHub while the task was paused.
    sh(origin, 'branch', '-D', 'agent/builder/7-merged');

    const again = await resume();

    expect(sh(again.path, 'rev-parse', 'HEAD')).toBe(work);
    expect(readFileSync(join(again.path, 'change.ts'), 'utf8')).toBe('the work\n');
    expect(sh(again.mirror, 'for-each-ref', '--format=%(refname)', 'refs/heads/agent/builder/7-merged')).toBe('');
    // Only the task's own kept branch, which no fetch prunes.
    expect(sh(again.mirror, 'for-each-ref', '--format=%(refname)', 'refs/fleetadlc')).toBe('refs/fleetadlc/tasks/task-92/head');
  }, 30_000);

  it('keeps the commits made after its last push', async () => {
    const first = await resume();
    commitIn(first.path, 'change.ts', 'pushed\n');
    sh(first.path, 'push', '-q', 'origin', BRANCH);
    commitIn(first.path, 'change.ts', 'not pushed yet\n');
    const work = sh(first.path, 'rev-parse', 'HEAD');

    const again = await resume();

    expect(sh(again.path, 'rev-parse', 'HEAD')).toBe(work);
  }, 30_000);

  it('takes what the remote has when a person rewrote the branch after the task pushed', async () => {
    const first = await resume();
    commitIn(first.path, 'change.ts', 'the task’s\n');
    sh(first.path, 'push', '-q', 'origin', BRANCH);
    // Rebased by a person: the task's commit is replaced, not built on.
    sh(origin, 'checkout', '-q', '-B', BRANCH, 'main');
    commitIn(origin, 'change.ts', 'the person’s\n');
    sh(origin, 'checkout', '-q', 'main');

    const again = await resume();

    expect(readFileSync(join(again.path, 'change.ts'), 'utf8')).toBe('the person’s\n');
    // What it had pushed was replaced on purpose: nothing to apply again.
    expect(again.setAside).toBeUndefined();
    expect(sh(again.mirror, 'for-each-ref', '--format=%(refname)', 'refs/fleetadlc/unpushed')).toBe('');
  }, 30_000);

  it('keeps what the remote moved on to, and sets its own later commits aside to apply again', async () => {
    // Pushed A, committed B, and meanwhile the merge line brought the branch
    // up to date (C). Putting B back would drop C, and the task may not force
    // its branch over it.
    const first = await resume();
    commitIn(first.path, 'change.ts', 'A\n');
    sh(first.path, 'push', '-q', 'origin', BRANCH);
    commitIn(first.path, 'other.ts', 'B\n');
    const b = sh(first.path, 'rev-parse', 'HEAD');
    sh(origin, 'checkout', '-q', BRANCH);
    commitIn(origin, 'README.md', 'C\n');
    const c = sh(origin, 'rev-parse', 'HEAD');
    sh(origin, 'checkout', '-q', 'main');

    const again = await resume();

    expect(sh(again.path, 'rev-parse', 'HEAD')).toBe(c);
    expect(again.setAside).toEqual({ ref: `refs/fleetadlc/unpushed/${BRANCH}`, tip: b, commits: [b], reason: 'moved' });
    expect(sh(again.path, 'rev-parse', `refs/fleetadlc/unpushed/${BRANCH}`)).toBe(b);
    const brief = setAsideBrief(BRANCH, again.setAside!);
    expect(brief).toContain(`git cherry-pick ${b}`);
    expect(brief).toContain('Never force-push');
    // Applied again the way the brief says, it lands on top of C.
    sh(again.path, 'cherry-pick', b);
    expect(readFileSync(join(again.path, 'other.ts'), 'utf8')).toBe('B\n');
    expect(readFileSync(join(again.path, 'README.md'), 'utf8')).toBe('C\n');
  }, 30_000);

  it('does not put back a branch its pull request took away, and sets aside what was never pushed', async () => {
    // Merged or closed while the task was paused, and the branch deleted. Put
    // back, the task would push it again and reopen finished work.
    const first = await resume();
    commitIn(first.path, 'change.ts', 'A\n');
    sh(first.path, 'push', '-q', 'origin', BRANCH);
    commitIn(first.path, 'other.ts', 'B\n');
    const b = sh(first.path, 'rev-parse', 'HEAD');
    sh(origin, 'branch', '-D', BRANCH);

    // Started again from the base under the same name, the builder redid the
    // issue and opened a second pull request for work that had landed.
    await expect(resume()).rejects.toThrow(
      new RegExp(`${BRANCH} was deleted .* merged or closed, so the task is not started again\\. .*kept at refs/fleetadlc/unpushed/${BRANCH}`),
    );
    expect(sh(first.mirror, 'rev-parse', `refs/fleetadlc/unpushed/${BRANCH}`)).toBe(b);
    expect(sh(first.mirror, 'for-each-ref', '--format=%(refname)', `refs/heads/${BRANCH}`)).toBe('');
  }, 30_000);

  it('does not start again when everything on the deleted branch had been pushed', async () => {
    const first = await resume();
    commitIn(first.path, 'change.ts', 'A\n');
    sh(first.path, 'push', '-q', 'origin', BRANCH);
    sh(origin, 'branch', '-D', BRANCH);

    await expect(resume()).rejects.toThrow(/merged or closed, so the task is not started again\. Everything it had committed had been pushed/);
    expect(sh(first.mirror, 'for-each-ref', '--format=%(refname)', 'refs/fleetadlc/unpushed')).toBe('');
  }, 30_000);

  it('drops commits set aside more than a few days ago, in every mirror, by when they were set aside', async () => {
    const first = await resume();
    const other = await worktrees.checkoutExisting({
      bot: 'builder',
      taskId: 'task-other',
      repoFullName: 'exampleco/other',
      remote: origin,
      baseRef: 'refs/heads/main',
      branch: 'main',
      token: null,
    });
    const head = sh(first.path, 'rev-parse', 'HEAD');
    const old = Date.now() - (SET_ASIDE_DAYS + 1) * 24 * 3600 * 1000;
    for (const mirror of [first.mirror, other.mirror]) {
      for (const name of ['old', 'new', 'unlogged']) sh(mirror, 'update-ref', `refs/fleetadlc/unpushed/agent/${name}`, head);
      writeFileSync(
        join(mirror, SET_ASIDE_LOG),
        JSON.stringify({ 'refs/fleetadlc/unpushed/agent/old': old, 'refs/fleetadlc/unpushed/agent/new': Date.now() }),
      );
      // Packed, as `gc` would: no ref file is left to date them by, and the
      // commit they name is as old as the task that made it.
      sh(mirror, 'pack-refs', '--all');
    }

    // The tasks are over, so their worktrees go too; the other repository's
    // mirror is cleaned as well, though no task is starting on it.
    await worktrees.pruneAbandoned('builder', () => false);

    for (const mirror of [first.mirror, other.mirror]) {
      expect(sh(mirror, 'for-each-ref', '--format=%(refname)', 'refs/fleetadlc/unpushed').split('\n')).toEqual([
        'refs/fleetadlc/unpushed/agent/new',
        'refs/fleetadlc/unpushed/agent/unlogged',
      ]);
    }
    expect(worktrees.listWorktreeTaskIds('builder')).toEqual([]);
  }, 30_000);

  it('keeps the task’s commits in the mirror when the fetch fails', async () => {
    const first = await resume();
    commitIn(first.path, 'change.ts', 'the work\n');
    const work = sh(first.path, 'rev-parse', 'HEAD');
    rmSync(origin, { recursive: true, force: true });

    await expect(resume()).rejects.toThrow();

    // Its old clone was harvested before it was cleared, so the next resume
    // that can reach the remote starts from the work.
    expect(sh(first.mirror, 'rev-parse', 'refs/fleetadlc/tasks/task-92/head')).toBe(work);
  }, 30_000);
});

describe('what a task writes to post on GitHub', () => {
  // A builder's plan lost its heading because a body on the command line is
  // refused when a line starts with `#`. It writes the body to a file instead,
  // in its worktree, and that file must never become part of the change.
  let root: string;
  let origin: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'fleetadlc-wt-scratch-'));
    origin = join(root, 'origin');
    mkdirSync(origin);
    const git = (args: string[]) => run('git', args, { cwd: origin });
    await git(['init', '-q', '-b', 'main']);
    writeFileSync(join(origin, 'README.md'), '# a repository\n');
    await git(['add', '-A']);
    await git(['-c', 'user.email=t@example.test', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('goes under .fleetadlc-scratch/, which no commit takes, however the change is staged', async () => {
    const worktrees = new Worktrees(join(root, 'work'));
    const request = { bot: 'builder', repoFullName: 'acme/widgets', remote: origin, baseRef: 'main', branch: 'agent/builder/7-issue-7', token: null };
    const { path } = await worktrees.create({ ...request, taskId: 'task-1' });

    mkdirSync(join(path, SCRATCH_DIR));
    writeFileSync(join(path, SCRATCH_DIR, 'pr.md'), '## What changed\n\n<!-- fleetadlc:{"event":"pr_opened"} -->\n');
    writeFileSync(join(path, 'page.html'), '<h1>Hello</h1>\n');
    await run('git', ['add', '-A'], { cwd: path });

    const { stdout } = await run('git', ['status', '--porcelain'], { cwd: path });
    expect(stdout.trim().split('\n')).toEqual(['A  page.html']);

    // In the clone's own excludes, listed once.
    const exclude = readFileSync(join(path, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n').filter((line) => line === `/${SCRATCH_DIR}/`)).toHaveLength(1);
  });
});

describe('the sweep of task folders nobody holds', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fleetadlc-slots-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('leaves a folder made in the last two minutes, which is a start under way, and takes an older one', async () => {
    // Deleted between its making and its computer being recorded, a resumed
    // intake's container kept the deleted folder and could not see its clone.
    const worktrees = new Worktrees(root);
    const slots = join(root, 'slots');
    mkdirSync(join(slots, 'task-old', 'wt'), { recursive: true });
    const oldMade = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const newMade = Date.now();
    mkdirSync(join(slots, 'task-new', 'wt'), { recursive: true });
    const nobody = () => false;

    expect(await worktrees.pruneSlots(slots, nobody)).toBe(0);
    expect(existsSync(join(slots, 'task-new'))).toBe(true);

    // A minute on from the new folder, with a grace that falls between the
    // two: the older is past it and the newer is not, however busy the host.
    const now = newMade + 60_000;
    expect(now - oldMade).toBeGreaterThan(60_200);
    expect(await worktrees.pruneSlots(slots, nobody, { now, youngerThanMs: 60_200 })).toBe(1);
    expect(existsSync(join(slots, 'task-old'))).toBe(false);
    expect(existsSync(join(slots, 'task-new'))).toBe(true);
  });
});

/**
 * The bot's token was in the remote's URL, and `git clone` writes that URL
 * into the mirror's config before it fetches: a hostd stopped mid-clone left
 * the token on disk, and no later start took it out.
 *
 * The remote here is a GitHub URL that git is told to read from a local
 * repository (`insteadOf`), and git itself is a wrapper that writes down what
 * it was asked, and the config of the repository it was asked in, before it
 * runs: what is on disk while a fetch is still going.
 */
describe('the bot’s token and the mirror', () => {
  const TOKEN = 'ghu_TESTTOKEN';
  const REMOTE = 'https://github.com/acme/widgets.git';
  let root: string;
  let origin: string;
  let log: string;

  const sh = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();
  const request = (taskId: string) => ({
    bot: 'atlas',
    taskId,
    repoFullName: 'acme/widgets',
    remote: REMOTE,
    baseRef: 'refs/heads/main',
    branch: `agent/atlas/${taskId}`,
    token: TOKEN,
    startFromBaseIfMissing: true,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fleetadlc-wt-token-'));
    origin = join(root, 'origin');
    mkdirSync(origin, { recursive: true });
    sh(origin, 'init', '-q', '-b', 'main');
    writeFileSync(join(origin, 'README.md'), 'hello\n');
    sh(origin, 'add', 'README.md');
    sh(origin, 'commit', '-qm', 'first');
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const bin = join(root, 'bin');
    mkdirSync(bin);
    log = join(root, 'git.log');
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nprintf 'low speed: %s %s\\n' "$GIT_HTTP_LOW_SPEED_LIMIT" "$GIT_HTTP_LOW_SPEED_TIME" >> '${log}'\n[ -f config ] && cat config >> '${log}'\nexec '${real}' "$@"\n`,
    );
    chmodSync(join(bin, 'git'), 0o755);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', `url.${origin}.insteadOf`);
    vi.stubEnv('GIT_CONFIG_VALUE_0', REMOTE);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('never writes the token into the mirror’s config, nor hands it to git as an argument', async () => {
    const worktrees = new Worktrees(join(root, 'work'));

    const made = await worktrees.create(request('task-one'));

    const config = readFileSync(join(made.mirror, 'config'), 'utf8');
    expect(config).toContain(`url = ${REMOTE}`);
    const seen = readFileSync(log, 'utf8');
    // Every git call's arguments, and each config as it stood while git ran.
    expect(seen).toContain('fetch');
    expect(seen).not.toContain(TOKEN);
    expect(seen).not.toContain('x-access-token');
    expect(existsSync(`${made.mirror}.making`)).toBe(false);
  }, 30_000);

  it('takes a token an earlier hostd left in a mirror out the next time the mirror is used', async () => {
    const worktrees = new Worktrees(join(root, 'work'));
    const first = await worktrees.create(request('task-one'));
    sh(first.mirror, 'remote', 'set-url', 'origin', `https://x-access-token:ghu_OLDTOKEN@github.com/acme/widgets.git`);

    await worktrees.create(request('task-two'));

    const config = readFileSync(join(first.mirror, 'config'), 'utf8');
    expect(config).not.toContain('ghu_OLDTOKEN');
    expect(config).toContain(`url = ${REMOTE}`);
  }, 30_000);

  it('throws away a mirror a stopped hostd left half made, and makes it again', async () => {
    const worktrees = new Worktrees(join(root, 'work'));
    const mirror = worktrees.mirrorPath('acme/widgets');
    mkdirSync(`${mirror}.making`, { recursive: true });
    writeFileSync(join(`${mirror}.making`, 'config'), '[remote "origin"]\n\turl = https://x-access-token:ghu_OLDTOKEN@github.com/acme/widgets.git\n');

    const made = await worktrees.create(request('task-one'));

    expect(existsSync(`${mirror}.making`)).toBe(false);
    expect(sh(made.path, 'log', '--format=%s')).toBe('first');
    expect(readFileSync(join(mirror, 'config'), 'utf8')).not.toContain('ghu_OLDTOKEN');
  }, 30_000);

  it('has every git call fail on a connection that stalls, rather than hold the mirror’s lock forever', async () => {
    await new Worktrees(join(root, 'work')).create(request('task-one'));

    const seen = readFileSync(log, 'utf8').split('\n').filter((line) => line.startsWith('low speed:'));
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(['low speed: 1000 60']));
  }, 30_000);

  it('hands git the token in its environment, after what the environment already sets, and only for an https remote', () => {
    expect(gitAuthEnv(REMOTE, TOKEN)).toEqual({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_1: `Authorization: Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`,
    });
    expect(gitAuthEnv(origin, TOKEN)).toEqual({});
    expect(gitAuthEnv(REMOTE, null)).toEqual({});
  });
});

/**
 * A hostd killed while a stop harvested into a mirror can leave git's lock
 * files there, and every later fetch of that repository failed with "cannot
 * lock ref" until a person deleted them.
 */
describe('git locks a killed hostd left in a mirror', () => {
  let root: string;
  let origin: string;

  const sh = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();
  const request = (taskId: string, branch: string) => ({
    bot: 'atlas',
    taskId,
    repoFullName: 'example/locked',
    remote: origin,
    baseRef: 'refs/heads/main',
    branch,
    token: null,
    keepUnpushed: true,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fleetadlc-wt-locks-'));
    origin = join(root, 'origin');
    mkdirSync(origin, { recursive: true });
    sh(origin, 'init', '-q', '-b', 'main');
    writeFileSync(join(origin, 'README.md'), 'hello\n');
    sh(origin, 'add', 'README.md');
    sh(origin, 'commit', '-qm', 'first');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('removes the ones from before this hostd started, so the fetch works, and leaves a newer one', async () => {
    const work = join(root, 'work');
    const first = await new Worktrees(work).create(request('task-one', 'agent/atlas/1-issue-1'));
    // The remote moves on, so the next fetch has to write refs/heads/main.
    writeFileSync(join(origin, 'README.md'), 'hello again\n');
    sh(origin, 'commit', '-qam', 'second');

    const stale = [join(first.mirror, 'refs', 'heads', 'main.lock'), join(first.mirror, 'packed-refs.lock')];
    const fresh = join(first.mirror, 'refs', 'tags', 'fresh.lock');
    mkdirSync(join(first.mirror, 'refs', 'tags'), { recursive: true });
    for (const path of [...stale, fresh]) writeFileSync(path, '');
    const anHourAgo = new Date(Date.now() - 3_600_000);
    for (const path of stale) utimesSync(path, anHourAgo, anHourAgo);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // A hostd that started a minute ago: the hour-old locks are from before it.
      const restarted = new Worktrees(work, Date.now() - 60_000);
      const second = await restarted.create(request('task-two', 'agent/atlas/2-issue-2'));

      expect(sh(second.path, 'log', '-1', '--format=%s', 'origin/main')).toBe('second');
      for (const path of stale) expect(existsSync(path)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
      expect(warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('git lock'))).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  }, 30_000);
});
