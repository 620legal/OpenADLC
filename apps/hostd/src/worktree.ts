import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { redactSecrets } from '@fleetadlc/shared';

const run = promisify(execFile);

async function git(args: string[], cwd?: string, env: Record<string, string> = {}): Promise<string> {
  try {
    const { stdout } = await run('git', args, {
      ...(cwd ? { cwd } : {}),
      // A fetch whose connection stalls fails after a minute below 1 KB/s
      // rather than holding the mirror's lock, and every start in the
      // repository behind it, until hostd restarts. No wall-clock limit: a
      // large first clone can rightly take a long time.
      env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0', GIT_HTTP_LOW_SPEED_LIMIT: '1000', GIT_HTTP_LOW_SPEED_TIME: '60' },
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    // The command is in the message. A remote with the bot's token in its
    // URL once put it there, and it reached a task's reason and the board.
    const failed = error as Error & { cmd?: string; stderr?: string };
    const clean = new Error(redactSecrets(failed.message ?? String(error)));
    Object.assign(clean, {
      ...(failed.cmd ? { cmd: redactSecrets(failed.cmd) } : {}),
      ...(failed.stderr ? { stderr: redactSecrets(String(failed.stderr)) } : {}),
    });
    throw clean;
  }
}

/**
 * Where a task writes what it posts to GitHub: a comment, a pull request's
 * body, a review, an issue.
 *
 * A body passed on the command line is refused by the engine's own shell
 * checks when a line starts with `#`, which every Markdown heading does, and a
 * heredoc when braces sit beside quotes, which every marker does. A builder
 * dropped its plan's heading to get past them, and outside its worktree it may
 * write nothing. So it writes here, in the worktree, and the clone's own
 * excludes list the directory: nothing in it is ever committed.
 */
export const SCRATCH_DIR = '.fleetadlc-scratch';

/** Adds the scratch directory to a repository's excludes (`<git dir>/info/exclude`). */
function excludeScratch(gitDir: string): void {
  const info = join(gitDir, 'info');
  const exclude = join(info, 'exclude');
  mkdirSync(info, { recursive: true });
  const listed = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (listed.split('\n').includes(`/${SCRATCH_DIR}/`)) return;
  appendFileSync(exclude, `${listed && !listed.endsWith('\n') ? '\n' : ''}/${SCRATCH_DIR}/\n`);
}

export interface WorktreeRequest {
  bot: string;
  taskId: string;
  repoFullName: string;
  /** Clone URL; a file path is accepted so the integration suites need no network. */
  remote: string;
  baseRef: string;
  branch: string | null;
  token: string | null;
  /**
   * Only for resuming a task that paused before its first push: its branch
   * was named and never pushed, so a missing branch means "start from the
   * base". For anything else — a review, a patch round — a missing branch is a
   * pull request whose head OpenADLC cannot see (a fork, a deleted branch), and a
   * worktree of the base under its name would be reviewed as an empty change.
   */
  startFromBaseIfMissing?: boolean;
  /** A task that commits to the branch: its commits the remote lacks outlive the fetch. See `Worktrees.ensureMirror`. */
  keepUnpushed?: boolean;
  /** Where the task's clone goes; `worktreePath(bot, taskId)` when absent. */
  path?: string;
}

/**
 * The bot's token for one git call against an https remote, as git config in
 * the child's environment (`GIT_CONFIG_COUNT`), after any the environment
 * already sets. It was in the remote's URL, which `git clone` writes into the
 * mirror's config before it fetches: a hostd stopped mid-clone left the token
 * on disk for good. Empty for any other remote, and with no token.
 */
export function gitAuthEnv(remote: string, token: string | null): Record<string, string> {
  if (!token || !remote.startsWith('https://')) return {};
  const index = Math.max(0, Number.parseInt(process.env.GIT_CONFIG_COUNT ?? '0', 10) || 0);
  return {
    GIT_CONFIG_COUNT: String(index + 1),
    [`GIT_CONFIG_KEY_${index}`]: `http.${new URL(remote).origin}/.extraheader`,
    [`GIT_CONFIG_VALUE_${index}`]: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  };
}

/** A remote's URL with any `user:password@` taken out; a path is returned as it is. */
export function withoutCredentials(remote: string): string {
  try {
    const url = new URL(remote);
    if (!url.username && !url.password) return remote;
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return remote;
  }
}

/** Where a mirror records what the remote has, from a fetch. */
const TRACKED = '+refs/heads/*:refs/remotes/origin/*';

/** How long commits set aside are kept for a task to apply again: see `Worktrees.dropOldSetAsides`. */
export const SET_ASIDE_DAYS = 5;

/**
 * What a task is stopped with when its pull request was merged or closed while
 * it was paused. It is the task's exit reason, so the next resume reads it
 * there: by then the fetch has pruned the branch, and nothing in the mirror
 * says the task had pushed it.
 */
export const BRANCH_GONE = 'its pull request was merged or closed, so the task is not started again';

/** Thrown by `Worktrees.checkoutExisting` for a task whose branch is gone; see `BRANCH_GONE`. */
export class BranchGoneError extends Error {}

/** Whether a task was stopped because its pull request was merged or closed. */
export function stoppedForGoneBranch(task: { exitReason: string | null }): boolean {
  return (task.exitReason ?? '').includes(BRANCH_GONE);
}

/** When each set-aside ref was written, in the mirror: see `Worktrees.dropOldSetAsides`. */
export const SET_ASIDE_LOG = 'fleetadlc-set-asides.json';

/**
 * Where a task's own branch is kept in its repository's mirror between its
 * computers: `head` is its branch's tip, `pushed` the last tip it knew the
 * remote had. Written when a task's computer goes (`Worktrees.harvest`), read
 * when it starts again (`Worktrees.ensureMirror`), deleted once the task has
 * ended for good (`Worktrees.dropTaskRefs`). No fetch refspec names this
 * namespace, so `--prune` never touches it.
 */
export function taskRefs(taskId: string): { head: string; pushed: string; prefix: string } {
  const prefix = `refs/fleetadlc/tasks/${taskId}`;
  return { head: `${prefix}/head`, pushed: `${prefix}/pushed`, prefix };
}

function readSetAsideLog(mirror: string): Record<string, number> {
  try {
    return JSON.parse(readFileSync(join(mirror, SET_ASIDE_LOG), 'utf8')) as Record<string, number>;
  } catch {
    return {};
  }
}

function writeSetAsideLog(mirror: string, log: Record<string, number>): void {
  writeFileSync(join(mirror, SET_ASIDE_LOG), `${JSON.stringify(log, null, 2)}\n`);
}

/**
 * Which set-asides hold the unpushed commits of a task that ended for good,
 * and whose they were: the next task on the branch is told of these
 * (`Worktrees.endedSetAside`). A set-aside a resumed task was already told of
 * is not listed, so it is not told again as somebody else's.
 */
const ENDED_LOG = 'fleetadlc-ended-set-asides.json';

function readEndedLog(mirror: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(join(mirror, ENDED_LOG), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeEndedLog(mirror: string, log: Record<string, string>): void {
  writeFileSync(join(mirror, ENDED_LOG), `${JSON.stringify(log, null, 2)}\n`);
}

/**
 * One git operation at a time on each mirror, within this hostd.
 *
 * With one task per bot, each bot's mirror had one writer. A repository's
 * mirror is now every task's in that repository, and two fetches into one
 * repository at once fail on its ref locks ("cannot lock ref"), while a clone
 * taken during a fetch's repack can link a pack the repack is about to delete.
 * hostd is the only thing that touches a mirror — no container mounts one —
 * so an in-process queue per path is the whole of the lock.
 */
const mirrorQueues = new Map<string, Promise<unknown>>();

export async function withMirrorLock<T>(mirror: string, work: () => Promise<T>): Promise<T> {
  const before = mirrorQueues.get(mirror) ?? Promise.resolve();
  const mine = before.then(work, work);
  const settled = mine.then(
    () => undefined,
    () => undefined,
  );
  mirrorQueues.set(mirror, settled);
  try {
    return await mine;
  } finally {
    if (mirrorQueues.get(mirror) === settled) mirrorQueues.delete(mirror);
  }
}

/** Mirrors whose stale locks this process has already cleared; see `clearStaleLocks`. */
const lockSwept = new Set<string>();

/**
 * Git lock files a killed git left in a mirror: `*.lock` under `refs/` and at
 * its top level (`packed-refs.lock`, `HEAD.lock`). A hostd killed while a stop
 * harvested into a mirror (`update-ref`) left one, and every later fetch of
 * that repository failed with "cannot lock ref" until a person deleted it.
 * hostd is the mirror's only writer and `withMirrorLock` is in-process, so a
 * lock older than this process can only be such debris; a newer one is
 * never touched. Once per mirror per process, under the mirror's lock, so
 * `refs/` is not walked on every fetch.
 */
export function clearStaleLocks(mirror: string, startedAt: number, log: (line: string) => void = console.warn): string[] {
  if (lockSwept.has(mirror)) return [];
  lockSwept.add(mirror);
  const found: string[] = [];
  const walk = (dir: string, deep: boolean): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (deep) walk(path, true);
      } else if (entry.name.endsWith('.lock')) {
        found.push(path);
      }
    }
  };
  walk(mirror, false);
  walk(join(mirror, 'refs'), true);
  const removed: string[] = [];
  for (const path of found) {
    try {
      if (statSync(path).mtimeMs >= startedAt) continue;
      rmSync(path, { force: true });
      removed.push(path);
      log(`[hostd] removed ${path}, a git lock left in the mirror before hostd started`);
    } catch {
      // Gone already.
    }
  }
  return removed;
}

/** A resumed task's own commits, taken off its branch because the remote's moved on; see `Worktrees.ensureMirror`. */
export interface SetAside {
  /** Where they are, reachable from the task's worktree. */
  ref: string;
  tip: string;
  /** Oldest first: the order to apply them again. */
  commits: string[];
  /**
   * `moved`: the remote's branch moved on without them. `gone`: the remote's
   * branch was deleted after the task had pushed to it — its pull request was
   * merged or closed — so there is nothing to put them back on, and the task
   * is not started again (`Worktrees.checkoutExisting`). `ended`: an earlier
   * task on the branch ended for good — failed, stopped, or done — with them
   * never pushed (`Worktrees.dropTaskRefs`), and this task is the next on it.
   */
  reason: 'moved' | 'gone' | 'ended';
}

export interface WorktreeResult {
  mirror: string;
  path: string;
  branch: string | null;
  baseSha: string;
  setAside?: SetAside;
}

/** What a task is told when its commits were set aside, so it applies them again rather than forcing its branch back. */
export function setAsideBrief(branch: string, setAside: SetAside): string {
  if (setAside.reason === 'ended') {
    return [
      `An earlier task on \`${branch}\` ended before it pushed ${setAside.commits.length} commit(s). They are not on the branch; they are kept at \`${setAside.ref}\`:`,
      '',
      ...setAside.commits.map((sha) => `- ${sha}`),
      '',
      `Read them before you start. Whatever of them the work still needs, apply on top of the branch as it is, oldest first: \`git cherry-pick ${setAside.commits.join(' ')}\`, resolving any conflict, then push as usual.`,
      'Never force-push the branch to them: that would throw away what the remote has.',
    ].join('\n');
  }
  return [
    `Your branch \`${branch}\` moved on the remote while you were paused: someone rebased it, or the merge line brought it up to date with the base.`,
    `You had ${setAside.commits.length} commit(s) on it that were never pushed. They are not on the branch now; they are kept at \`${setAside.ref}\`:`,
    '',
    ...setAside.commits.map((sha) => `- ${sha}`),
    '',
    `Apply them again on top of the branch as it is, oldest first: \`git cherry-pick ${setAside.commits.join(' ')}\`, resolving any conflict, then push as usual.`,
    'Never force-push the branch back to them: that would throw away what the remote has.',
  ].join('\n');
}

/** A paused task's branch in a bot's own mirror from before mirrors were per repository; see `importLegacyMirrors`. */
export interface LegacyTask {
  taskId: string;
  bot: string;
  repoFullName: string;
  branch: string;
}

/**
 * Which task a task's directory is for, and which seat. A container's labels
 * are fixed when it is made, so a computer made before its task was known — a
 * warm one — is told its task here, and hostd reads it back after a restart.
 *
 * Kept beside the directory (`<slots>/<dir>.json`), never in it: the
 * directory is mounted read-write into the task's own computer, and a record
 * in it was one the task could rewrite. A task that wrote a paused task's id
 * there was adopted as that task after a restart, and its commits harvested
 * into the other task's kept branch. `SLOT_FILE` is where it was before; one
 * is read only as a claim (`inDirectory`), never as proof.
 */
export const SLOT_FILE = '.fleetadlc-task.json';

export interface SlotRecord {
  taskId: string;
  bot: string;
  /** Read from `SLOT_FILE` inside the directory, which the task could write: a claim, not a record. */
  inDirectory?: boolean;
}

/** Where a task directory's record is: beside it, out of the computer's reach. */
export function slotRecordPath(dir: string): string {
  return `${dir.replace(/[\\/]+$/, '')}.json`;
}

function parseSlotRecord(path: string): SlotRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SlotRecord>;
    return typeof parsed.taskId === 'string' && typeof parsed.bot === 'string' ? { taskId: parsed.taskId, bot: parsed.bot } : null;
  } catch {
    return null;
  }
}

/**
 * The record beside a task's directory; or, for a directory made before
 * records moved out of it, the one inside, marked `inDirectory`. Null when
 * there is neither or it does not read.
 */
export function readSlotTask(dir: string): SlotRecord | null {
  const outside = parseSlotRecord(slotRecordPath(dir));
  if (outside) return outside;
  const inside = parseSlotRecord(join(dir, SLOT_FILE));
  return inside ? { ...inside, inDirectory: true } : null;
}

export function writeSlotTask(dir: string, record: SlotRecord): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(slotRecordPath(dir), `${JSON.stringify({ taskId: record.taskId, bot: record.bot })}\n`);
}

/** A task's directory removed, and its record with it. */
export function removeSlot(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  rmSync(slotRecordPath(dir), { force: true });
}

/**
 * Where a task's commits go when its clone is harvested with nothing held for
 * it: the repository and branch on the task's row, or null for a task with
 * none, one that does not write its branch, or one there is no row for. Never
 * what the clone says about itself, which the task could have written.
 */
export type KeptBranchOf = (taskId: string) => Promise<{ repoFullName: string; branch: string } | null>;

/** Marks a bot's old mirror whose set-asides have been copied into its repository's mirror. */
const IMPORTED_MARK = 'fleetadlc-imported';

/** A path segment a bot or task id may be, and nothing that walks out of a directory. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** How long a new task folder is left alone by `pruneSlots`. */
export const SLOT_GRACE_MS = 2 * 60_000;

/**
 * Every task starts from a clone of its own, taken from its repository's
 * mirror, with a clean context. The mirror is kept warm so a fetch is cheap;
 * nothing a task leaves behind in its clone can affect the next one.
 *
 * The clone is a repository in its own right, not a `git worktree`. A
 * worktree's `.git` is a file naming its mirror by absolute path, so the
 * mirror had to be mounted into the container at the path hostd built it at,
 * and the mirror's own branches were the task's: a fetch for one task, with
 * `--prune` and `+`, deleted or reset another task's unpushed branch, which
 * with one task per bot happened only between that bot's own tasks. A clone
 * (`git clone --local --no-hardlinks`, objects copied: see `cloneAt`) has its
 * own refs and its own `.git` directory: the mirror never leaves hostd, and one
 * mirror serves every task in the repository.
 */
export class Worktrees {
  constructor(
    private readonly workRoot: string,
    /** When this hostd started: a lock in a mirror older than it is debris (`clearStaleLocks`). */
    private readonly startedAt: number = Date.now() - process.uptime() * 1000,
  ) {}

  private botRoot(bot: string): string {
    return join(this.workRoot, bot);
  }

  /** The repository's one mirror, shared by every task in it on this host. */
  mirrorPath(repoFullName: string): string {
    return join(this.workRoot, 'mirrors', `${repoFullName.replace('/', '__')}.git`);
  }

  worktreePath(bot: string, taskId: string): string {
    return join(this.botRoot(bot), 'wt', taskId);
  }

  private pathOf(request: WorktreeRequest): string {
    return request.path ?? this.worktreePath(request.bot, request.taskId);
  }

  /** The files a branch already changes against its base: what a round on it may keep changing. */
  async changedFiles(path: string, baseRef: string): Promise<string[]> {
    const listed = await git(['diff', '--name-only', `${inClone(baseRef)}...HEAD`], path).catch(() => '');
    return listed.split('\n').map((line) => line.trim()).filter(Boolean);
  }

  /** The commit a ref names in a repository, or null when there is no such ref. */
  private async commitOf(repository: string, ref: string): Promise<string | null> {
    return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repository).catch(() => null);
  }

  private async contains(mirror: string, later: string, earlier: string): Promise<boolean> {
    return git(['merge-base', '--is-ancestor', earlier, later], mirror)
      .then(() => true)
      .catch(() => false);
  }

  /**
   * The repository's mirror, fetched, and what the task's branch starts from.
   * Called under `withMirrorLock`.
   *
   * `keep`: the branch of a task that commits to it (`keepUnpushed`), whose
   * commits must outlive the fetch. They are read from where its last computer
   * left them (`taskRefs`), which the fetch does not touch, and the tip is
   * decided by what the remote has now:
   *
   * - no such branch and never pushed, or a commit the task's tip already
   *   contains: the task's tip, which is a fast forward of the remote's;
   * - no such branch, though the task had pushed it: its pull request was
   *   merged or closed and the branch deleted. Not put back, since the task
   *   would push it again; what it had not pushed is set aside, as below, and
   *   `gone` says so, so the task is not started again;
   * - a commit that contains the task's tip: the remote's, as before;
   * - neither — the remote moved on while the task had commits of its own, a
   *   person's rebase or the merge line bringing the branch up to date: the
   *   remote's, because the task may not force-push over it, with the task's
   *   tip set aside under `refs/fleetadlc/unpushed/` and returned, so the task is
   *   told to apply those commits again.
   *
   * `tip` is null when neither the remote nor the task has the branch.
   */
  async ensureMirror(
    request: WorktreeRequest,
    keep: string | null = null,
  ): Promise<{ mirror: string; tip: string | null; setAside: SetAside | null; gone: boolean }> {
    const mirror = this.mirrorPath(request.repoFullName);
    mkdirSync(dirname(mirror), { recursive: true });
    // The token goes to git in its environment, never in a URL or on disk.
    const auth = gitAuthEnv(request.remote, request.token);
    const branchTip = async (): Promise<string | null> =>
      request.branch ? this.commitOf(mirror, `refs/heads/${request.branch}`) : null;

    if (!existsSync(mirror)) {
      // Made beside where it goes and moved into place once it holds the
      // remote, so a hostd stopped part way leaves no half-made mirror that a
      // later start would take as whole. A leftover from such a stop goes first.
      const making = `${mirror}.making`;
      rmSync(making, { recursive: true, force: true });
      await git(['init', '--bare', '--quiet', making]);
      await git(['remote', 'add', 'origin', request.remote], making);
      await git(['config', 'remote.origin.fetch', TRACKED], making);
      await git(['fetch', '--quiet', request.remote, '+refs/heads/*:refs/heads/*'], making, auth);
      // HEAD names the remote's default branch, as a clone's would.
      const head = (await git(['ls-remote', '--symref', request.remote, 'HEAD'], making, auth).catch(() => '')).match(/^ref: (refs\/heads\/\S+)\tHEAD/m)?.[1];
      if (head) await git(['symbolic-ref', 'HEAD', head], making);
      await git(['fetch', '--quiet', '.', TRACKED], making);
      renameSync(making, mirror);
      return { mirror, tip: await branchTip(), setAside: null, gone: false };
    }
    clearStaleLocks(mirror, this.startedAt);
    // Every time: a mirror made by an earlier hostd may hold the token in it.
    await git(['remote', 'set-url', 'origin', request.remote], mirror);
    await git(['config', 'remote.origin.fetch', TRACKED], mirror);

    // The mirror's branches are the remote's and nobody else's: a task commits
    // in its own clone. Pruning them is safe for every task, which a mirror
    // whose branches were also the tasks' could never be.
    const fetch = () =>
      git(['fetch', '--quiet', '--prune', '--update-head-ok', request.remote, '+refs/heads/*:refs/heads/*', TRACKED], mirror, auth);
    const own = taskRefs(request.taskId);
    const local = keep ? await this.commitOf(mirror, own.head) : null;
    const pushed = keep && local ? await this.commitOf(mirror, own.pushed) : null;
    await fetch();
    if (!keep || !local) return { mirror, tip: await branchTip(), setAside: null, gone: false };

    const fetched = await this.commitOf(mirror, `refs/heads/${keep}`);
    let setAside: SetAside | null = null;
    let gone = false;
    let tip: string | null = fetched;
    if (fetched === null && pushed !== null) {
      // It was on the remote once and is not now: its pull request was
      // merged or closed and the branch deleted. Put back, it would be
      // pushed again and reopen finished work.
      gone = true;
      tip = null;
      setAside = await this.setAside(mirror, keep, local, [local, `^${pushed}`], 'gone');
    } else if (fetched === null || (await this.contains(mirror, local, fetched))) {
      tip = local;
      if (fetched !== local) {
        console.warn(`[hostd] ${request.bot}: kept ${keep} at ${local.slice(0, 12)}, which has commits ${request.repoFullName} does not`);
      }
    } else if (!(await this.contains(mirror, fetched, local))) {
      // Only what the remote lacks in substance: a rebase keeps a commit as
      // a new one with the same change, and applying it again would only
      // conflict with itself.
      const range = ['--right-only', '--cherry-pick', `${fetched}...${local}`, ...(pushed ? [`^${pushed}`] : [])];
      setAside = await this.setAside(mirror, keep, local, range, 'moved');
    }
    if (setAside) {
      console.warn(
        `[hostd] ${request.bot}: ${keep} ${setAside.reason === 'gone' ? 'is gone from' : 'moved on'} ${request.repoFullName} while it had ${setAside.commits.length} commit(s) of its own; ` +
          `they are set aside at ${setAside.ref}`,
      );
    }
    return { mirror, tip, setAside, gone };
  }

  /**
   * The task's own commits, kept under `refs/fleetadlc/unpushed/<branch>` in the
   * mirror, and fetched into the task's clone so its brief names a ref it can
   * reach. One set aside before and not applied again keeps its commits under a
   * name of its own rather than being overwritten. Null when the task had
   * nothing of its own in substance.
   *
   * What it had pushed is not its own any more: a person who rewrote the
   * branch replaced those commits on purpose. Where the mirror does not know
   * what was pushed, every commit the remote lacks is set aside, and the task
   * is told of more than it strictly has to apply.
   */
  private async setAside(
    mirror: string,
    branch: string,
    local: string,
    range: string[],
    reason: SetAside['reason'],
  ): Promise<SetAside | null> {
    const listed = await git(['rev-list', '--reverse', '--no-merges', ...range], mirror).catch(() => '');
    const commits = listed.split('\n').filter(Boolean);
    if (commits.length === 0) return null;

    const ref = `refs/fleetadlc/unpushed/${branch}`;
    const earlier = await this.commitOf(mirror, ref);
    const log = readSetAsideLog(mirror);
    if (earlier && earlier !== local) {
      const moved = `${ref}-${earlier.slice(0, 12)}`;
      await git(['update-ref', moved, earlier], mirror);
      log[moved] = log[ref] ?? Date.now();
    }
    await git(['update-ref', ref, local], mirror);
    log[ref] = Date.now();
    writeSetAsideLog(mirror, log);
    const ended = readEndedLog(mirror);
    if (earlier && earlier !== local && ended[ref]) ended[`${ref}-${earlier.slice(0, 12)}`] = ended[ref];
    if (reason === 'ended') ended[ref] = 'ended';
    else delete ended[ref];
    writeEndedLog(mirror, ended);
    return { ref, tip: local, commits, reason };
  }

  /**
   * The commits an ended task left unpushed on `branch` (`dropTaskRefs`), for
   * the next task that writes it, when any of them are still not on `tip` in
   * substance. With no `tip`, a branch starting from the base, those on none
   * of the remote's branches. Called under the mirror's lock.
   */
  private async endedSetAside(mirror: string, branch: string, tip: string | null): Promise<SetAside | null> {
    const ref = `refs/fleetadlc/unpushed/${branch}`;
    if (!readEndedLog(mirror)[ref]) return null;
    const kept = await this.commitOf(mirror, ref);
    if (!kept) return null;
    const range = tip ? ['--right-only', '--cherry-pick', `${tip}...${kept}`] : [kept, '--not', '--branches'];
    const listed = await git(['rev-list', '--reverse', '--no-merges', ...range], mirror).catch(() => '');
    const commits = listed.split('\n').filter(Boolean);
    return commits.length > 0 ? { ref, tip: kept, commits, reason: 'ended' } : null;
  }

  /**
   * What a task that is over had committed and never pushed, set aside under
   * `refs/fleetadlc/unpushed/<branch>` before its kept refs go: a failed resume
   * or a stop deleted them, and with them the only name for that work. Only
   * what the remote's branch lacks in substance, and what the task had not
   * pushed. Called under the mirror's lock.
   */
  private async keepEnded(mirror: string, taskId: string, branch: string | null, head: string, pushed: string | null): Promise<void> {
    const remote = branch ? await this.commitOf(mirror, `refs/heads/${branch}`) : null;
    const notPushed = pushed ? [`^${pushed}`] : [];
    // `--not` turns every ref after it around, so what was pushed goes before it.
    const range = remote
      ? ['--right-only', '--cherry-pick', `${remote}...${head}`, ...notPushed]
      : [head, ...notPushed, '--not', '--branches'];
    const kept = await this.setAside(mirror, branch ?? `task-${taskId}`, head, range, 'ended');
    if (kept) {
      console.log(
        `[hostd] task ${taskId} ended with ${kept.commits.length} commit(s) on ${branch ?? 'no branch'} never pushed; ` +
          `they are kept at ${kept.ref} in ${mirror} for ${SET_ASIDE_DAYS} days`,
      );
    }
  }

  /**
   * A clone of the mirror at `path`, its `origin` the remote rather than the
   * mirror, its HEAD detached at `start`. Called under the mirror's lock, so
   * no fetch repacks the mirror while it is being copied.
   *
   * `--no-hardlinks`: the objects are copied, not linked. A hard-linked clone
   * shares each object file with the mirror, and git writes them read-only but
   * never checks them again on read — so a task that changed a file's mode and
   * rewrote it would have changed that object in the mirror for every later
   * task in the repository, whichever seat ran it, and a builder could have
   * tampered with the base a reviewer's checks run against. A copy costs the
   * repository's size in disk and time per task; that is the price of a clone
   * nothing in a task can reach back through.
   *
   * Nothing about which repository or branch it is goes in its own config: a
   * clone found on disk with no task held for it is harvested into what the
   * task's row says (`harvestLeftover`), since the task can write its clone.
   */
  private async cloneAt(
    mirror: string,
    path: string,
    request: WorktreeRequest,
    start: string,
  ): Promise<void> {
    mkdirSync(dirname(path), { recursive: true });
    await git(['clone', '--quiet', '--local', '--no-hardlinks', '--no-checkout', mirror, path]);
    await git(['remote', 'set-url', 'origin', request.remote], path);
    excludeScratch(join(path, '.git'));
    await git(['checkout', '--quiet', '--detach', start], path);
  }

  /**
   * This task's own clone from before — a paused task being resumed after
   * hostd restarted and forgot it — harvested and cleared before the mirror is
   * read, so the commits it holds are the ones the resume starts from.
   */
  private async clearOwn(request: WorktreeRequest): Promise<void> {
    const path = this.pathOf(request);
    if (!existsSync(path)) return;
    const target = request.keepUnpushed && request.branch ? { repoFullName: request.repoFullName, branch: request.branch } : null;
    await this.harvestLeftover(path, request.taskId, target).catch(() => false);
    rmSync(path, { recursive: true, force: true });
  }

  async create(request: WorktreeRequest): Promise<WorktreeResult> {
    await this.clearOwn(request);
    const path = this.pathOf(request);
    const mirror = this.mirrorPath(request.repoFullName);
    const started = await withMirrorLock(mirror, async () => {
      await this.ensureMirror(request);
      const sha = await this.commitOf(mirror, request.baseRef);
      // Usually the default branch OpenADLC has stored for the repository,
      // which was once assumed to be `main` rather than asked of GitHub.
      if (!sha) {
        const name = request.repoFullName.split('/').pop() ?? request.repoFullName;
        throw new Error(
          `${request.baseRef} is not in ${request.repoFullName}; nothing to start the task from. ` +
            `If that is meant to be its default branch, the one OpenADLC has stored is wrong: set the right one with ` +
            `PATCH /v1/repos/${name} {"defaultBranch": "<branch>"}, or let the next reconcile correct it from GitHub.`,
        );
      }
      await this.cloneAt(mirror, path, request, sha);
      const ended = request.keepUnpushed && request.branch ? await this.endedSetAside(mirror, request.branch, null) : null;
      return { sha, ended };
    });
    if (request.branch) await git(['checkout', '--quiet', '-B', request.branch], path);
    const { sha: baseSha, ended } = started;
    if (ended) await git(['fetch', '--quiet', mirror, `+${ended.ref}:${ended.ref}`], path);
    return { mirror, path, branch: request.branch, baseSha, ...(ended ? { setAside: ended } : {}) };
  }

  async checkoutExisting(request: WorktreeRequest & { branch: string }): Promise<WorktreeResult> {
    await this.clearOwn(request);
    const path = this.pathOf(request);
    // Only a task that commits to the branch has commits of its own to keep. A
    // review's copy of the branch is only ever what it was given, and one a
    // person rewrote is theirs to take as it is.
    const mirror = this.mirrorPath(request.repoFullName);
    const decided = await withMirrorLock(mirror, async () => {
      const found = await this.ensureMirror(request, request.keepUnpushed ? request.branch : null);
      if (found.tip && !found.gone) await this.cloneAt(mirror, path, request, found.tip);
      // Its own set-aside first; otherwise what an ended task left on the branch.
      const ended =
        request.keepUnpushed && found.tip && !found.gone && !found.setAside ? await this.endedSetAside(mirror, request.branch, found.tip) : null;
      return { ...found, setAside: found.setAside ?? ended };
    });
    const { setAside, gone, tip } = decided;

    // Its pull request was merged or closed while it was paused. Started again
    // from the base under the same name, as a branch never pushed is, the
    // builder redid the issue and pushed a second pull request for work that
    // had landed or been turned down. Whether anything is left to do is a
    // person's call.
    if (gone) {
      throw new BranchGoneError(
        `${request.branch} was deleted on ${request.repoFullName} after this task pushed it: ${BRANCH_GONE}. ` +
          (setAside
            ? `The ${setAside.commits.length} commit(s) it had not pushed are kept at ${setAside.ref}.`
            : 'Everything it had committed had been pushed.'),
      );
    }

    // A task paused before it pushed — a builder that asked a question before
    // its first commit — has a branch name and no branch. Resumed, it failed
    // "invalid reference" and nothing picked it up again; it starts from the
    // base instead, as it did the first time.
    if (!tip) {
      if (!request.startFromBaseIfMissing) {
        throw new Error(
          `${request.branch} is not a branch of ${request.repoFullName} — a pull request from a fork, or a branch deleted since; ` +
            'nothing to check out, so nothing is started on the base in its place. ' +
            'Push the branch to the repository itself, or start the work again from the issue',
        );
      }
      console.warn(
        `[hostd] ${request.bot}: task ${request.taskId} resumes with ${request.branch} never pushed, so it starts from ${request.baseRef}`,
      );
      return this.create(request);
    }

    await git(['checkout', '--quiet', '-B', request.branch, tip], path);
    if (setAside) await git(['fetch', '--quiet', mirror, `+${setAside.ref}:${setAside.ref}`], path);

    const baseSha = await git(['rev-parse', 'HEAD'], path);
    return { mirror, path, branch: request.branch, baseSha, ...(setAside ? { setAside } : {}) };
  }

  /**
   * Keeps what a task's clone holds of its branch in the repository's mirror,
   * under `taskRefs`, before the clone goes: its branch's tip, and the last
   * tip it knew the remote had (its own push records it in the clone, and so
   * did the clone being made). The next computer the task gets starts from
   * there. Nothing to keep is not a failure: a branch never made, or a task
   * that does not write its branch, harvests nothing.
   */
  async harvest(input: { path: string; taskId: string; repoFullName: string; branch: string }): Promise<boolean> {
    if (!existsSync(join(input.path, '.git')) || !SEGMENT.test(input.taskId)) return false;
    const head = await this.commitOf(input.path, `refs/heads/${input.branch}`);
    if (!head) return false;
    const pushed = await this.commitOf(input.path, `refs/remotes/origin/${input.branch}`);
    const mirror = this.mirrorPath(input.repoFullName);
    if (!existsSync(mirror)) return false;
    const refs = taskRefs(input.taskId);
    await withMirrorLock(mirror, async () => {
      clearStaleLocks(mirror, this.startedAt);
      // By commit, not by refspec: the clone's commits arrive with them, and a
      // name the task chose for its branch is never a refspec here.
      await git(['fetch', '--quiet', '--no-tags', input.path, head, ...(pushed ? [pushed] : [])], mirror);
      await git(['update-ref', refs.head, head], mirror);
      if (pushed) await git(['update-ref', refs.pushed, pushed], mirror);
      else await git(['update-ref', '-d', refs.pushed], mirror).catch(() => '');
    });
    return true;
  }

  /**
   * `harvest` for a clone found on disk with nothing held for it, into the
   * repository and branch hostd has for `taskId` (`target`), never the ones
   * the clone's own config names: that is in a directory the task could
   * write, and a task that named another repository or branch there had its
   * commits kept as that branch's. Only into a mirror this host keeps.
   */
  async harvestLeftover(path: string, taskId: string, target: { repoFullName: string; branch: string } | null): Promise<boolean> {
    if (!target || !existsSync(join(path, '.git'))) return false;
    const { repoFullName, branch } = target;
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repoFullName) || !branch) return false;
    const valid = await git(['check-ref-format', '--branch', branch]).then(() => true, () => false);
    if (!valid) return false;
    return this.harvest({ path, taskId, repoFullName, branch });
  }

  /** Removes a task's clone. Its branch's commits are harvested first by whoever calls this. */
  async remove(path: string): Promise<void> {
    rmSync(path, { recursive: true, force: true });
  }

  /** Task ids this bot has worktrees for, whether or not anything still runs them. */
  listWorktreeTaskIds(bot: string): string[] {
    const root = join(this.botRoot(bot), 'wt');
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  }

  /**
   * Removes the clones of tasks that are over, keeping their branches' commits
   * in the mirror first (`harvestLeftover`).
   *
   * A clone is only ever removed by `TaskRunner.end`, so every task that ended
   * without it left one behind — 167 had accumulated on one bot here, under
   * the worktrees this replaced. They are named by task id, so which ones are
   * dead is not a guess. A paused task's clone is one of them after hostd
   * restarts, and its unpushed commits are what its resume starts from.
   */
  async pruneAbandoned(bot: string, isLive: (taskId: string) => boolean, keptBranchOf: KeptBranchOf = async () => null): Promise<number> {
    let removed = 0;
    for (const taskId of this.listWorktreeTaskIds(bot)) {
      if (isLive(taskId)) continue;
      const path = this.worktreePath(bot, taskId);
      await this.harvestLeftover(path, taskId, await keptBranchOf(taskId).catch(() => null)).catch(() => false);
      await this.remove(path);
      removed += 1;
    }
    for (const each of this.mirrors()) await this.dropOldSetAsides(each).catch(() => 0);
    return removed;
  }

  /**
   * Removes the task directories under `root` whose task nothing holds,
   * keeping the branch each one's clone (`<dir>/wt`) holds first. A directory
   * is its task's id, or its record beside it says which task it is
   * (`readSlotTask`); `isLive` is asked by that id. Its commits are kept
   * only under an id hostd wrote — the record beside it, or the name it gave
   * the directory — and into the branch `keptBranchOf` has for that task. A
   * directory whose only record is the one inside it is not harvested for
   * any task. A record whose directory is gone goes too.
   */
  async pruneSlots(
    root: string,
    isLive: (taskId: string) => boolean,
    options: { youngerThanMs?: number; now?: number; keptBranchOf?: KeptBranchOf } = {},
  ): Promise<number> {
    if (!existsSync(root)) return 0;
    // A folder made in the last two minutes is a start under way, whatever the
    // runner says: the sweep deleted one between its making and its computer
    // being recorded, and the task could not see its own clone.
    const young = options.youngerThanMs ?? SLOT_GRACE_MS;
    const now = options.now ?? Date.now();
    const keptBranchOf = options.keptBranchOf ?? (async () => null);
    let removed = 0;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.json') && !existsSync(join(root, entry.name.slice(0, -'.json'.length)))) {
        rmSync(join(root, entry.name), { force: true });
        continue;
      }
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      const record = readSlotTask(dir);
      // A claim from inside still keeps a directory a live task may be using:
      // a computer started before records moved out has only that.
      if ((record && isLive(record.taskId)) || isLive(entry.name)) continue;
      const made = statSync(dir, { throwIfNoEntry: false })?.birthtimeMs || statSync(dir, { throwIfNoEntry: false })?.mtimeMs || 0;
      if (now - made < young) continue;
      const taskId = record && !record.inDirectory ? record.taskId : entry.name;
      if (record?.inDirectory && record.taskId !== entry.name) {
        console.log(`[hostd] ${dir} says it is task ${record.taskId} only from inside itself; its clone is kept for no task but ${entry.name}'s, if that is one`);
      }
      if (SEGMENT.test(taskId)) {
        await this.harvestLeftover(join(dir, 'wt'), taskId, await keptBranchOf(taskId).catch(() => null)).catch(() => false);
      }
      removeSlot(dir);
      removed += 1;
    }
    return removed;
  }

  /** Every repository's mirror on this host, and the per-bot ones from before (`legacyMirrors`). */
  mirrors(): string[] {
    const root = join(this.workRoot, 'mirrors');
    const current = existsSync(root)
      ? readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name.endsWith('.git'))
          .map((entry) => join(root, entry.name))
      : [];
    return [...current, ...this.legacyMirrors().map((legacy) => legacy.path)];
  }

  /**
   * The bare mirrors bots kept under `<bot>/repos/` before there was one per
   * repository. Left in place for a release, so a person can still reach
   * anything in them; `fleetadlc doctor` says when they can go.
   */
  legacyMirrors(): { bot: string; repoFullName: string; path: string }[] {
    if (!existsSync(this.workRoot)) return [];
    const found: { bot: string; repoFullName: string; path: string }[] = [];
    for (const bot of readdirSync(this.workRoot, { withFileTypes: true })) {
      if (!bot.isDirectory() || !SEGMENT.test(bot.name) || ['mirrors', 'slots', 'cache'].includes(bot.name)) continue;
      const repos = join(this.workRoot, bot.name, 'repos');
      if (!existsSync(repos)) continue;
      for (const entry of readdirSync(repos, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.endsWith('.git')) continue;
        const name = entry.name.slice(0, -'.git'.length);
        const cut = name.indexOf('__');
        if (cut <= 0) continue;
        found.push({ bot: bot.name, repoFullName: `${name.slice(0, cut)}/${name.slice(cut + 2)}`, path: join(repos, entry.name) });
      }
    }
    return found;
  }

  /**
   * Carries what the per-bot mirrors held into the per-repository ones, once,
   * at hostd's start after the upgrade.
   *
   * A paused task's branch lived in its bot's own mirror — the worktree
   * committed straight into it — and nowhere else when it had not been
   * pushed. Its resume now reads `taskRefs` in its repository's mirror, so
   * without this it started from its last push and its later commits were as
   * good as gone. Each one is copied there, and every set-aside
   * (`refs/fleetadlc/unpushed/*`, and `refs/fleet/*` from before the rename)
   * with when it was set aside, so `dropOldSetAsides` ages it out as before.
   * A repository's mirror that does not exist yet is made from the old one,
   * which saves the first task there a full clone.
   */
  async importLegacyMirrors(paused: readonly LegacyTask[]): Promise<{ tasks: number; mirrors: number }> {
    let tasks = 0;
    let mirrors = 0;
    for (const legacy of this.legacyMirrors()) {
      const mirror = this.mirrorPath(legacy.repoFullName);
      const own = paused.filter((task) => task.bot === legacy.bot && task.repoFullName === legacy.repoFullName);
      const marked = existsSync(join(legacy.path, IMPORTED_MARK));
      if (marked && own.length === 0) continue;
      try {
        await withMirrorLock(mirror, async () => {
          if (!existsSync(mirror)) {
            mkdirSync(dirname(mirror), { recursive: true });
            await git(['clone', '--bare', '--quiet', '--local', legacy.path, mirror]);
            // An old mirror's URL may hold the bot's token; the new one never does.
            const url = withoutCredentials(await git(['config', '--get', 'remote.origin.url'], legacy.path).catch(() => ''));
            if (url) await git(['remote', 'set-url', 'origin', url], mirror);
            await git(['config', 'remote.origin.fetch', TRACKED], mirror);
          }
          if (!marked) {
            await git(
              ['fetch', '--quiet', '--no-tags', legacy.path, '+refs/fleetadlc/unpushed/*:refs/fleetadlc/unpushed/*', '+refs/fleet/*:refs/fleet/*'],
              mirror,
            );
            const log = { ...readSetAsideLog(legacy.path), ...readSetAsideLog(mirror) };
            writeSetAsideLog(mirror, log);
            writeFileSync(join(legacy.path, IMPORTED_MARK), `${new Date().toISOString()}\n`);
            mirrors += 1;
          }
          for (const task of own) {
            if (!SEGMENT.test(task.taskId)) continue;
            const refs = taskRefs(task.taskId);
            if (await this.commitOf(mirror, refs.head)) continue;
            const head = await this.commitOf(legacy.path, `refs/heads/${task.branch}`);
            if (!head) continue;
            const pushed = await this.commitOf(legacy.path, `refs/remotes/origin/${task.branch}`);
            await git(['fetch', '--quiet', '--no-tags', legacy.path, head, ...(pushed ? [pushed] : [])], mirror);
            await git(['update-ref', refs.head, head], mirror);
            if (pushed) await git(['update-ref', refs.pushed, pushed], mirror);
            tasks += 1;
          }
        });
      } catch (error) {
        console.warn(
          `[hostd] could not carry ${legacy.bot}'s copy of ${legacy.repoFullName} into its repository's mirror: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
    return { tasks, mirrors };
  }

  /**
   * Deletes the kept branch of each task that has ended for good, in every
   * mirror. A paused task's stays, since its resume starts from it; one that
   * is done, failed or stopped will not start again under its id. One `isOver`
   * cannot answer for stays too. Each drop is logged with the commits its refs
   * named, so one dropped wrongly can be put back with `git update-ref` until
   * gc prunes them.
   *
   * What it had committed and never pushed is set aside first (`keepEnded`),
   * on the branch `isOver` names, or under `task-<id>` when it names none: a
   * failed resume or a stop used to take that work with it, and Try again is
   * a new task id that could not reach it. A set-aside that cannot be written
   * keeps the task's refs for the next pass.
   */
  async dropTaskRefs(isOver: (taskId: string) => Promise<boolean | { branch: string | null }>): Promise<number> {
    let dropped = 0;
    for (const mirror of this.mirrors()) {
      const listed = await git(['for-each-ref', '--format=%(refname)', 'refs/fleetadlc/tasks/'], mirror).catch(() => '');
      const ids = new Set(
        listed
          .split('\n')
          .filter(Boolean)
          .map((ref) => ref.split('/')[3] ?? '')
          .filter(Boolean),
      );
      for (const taskId of ids) {
        const over = await isOver(taskId).catch(() => false);
        if (!over) continue;
        const branch = over === true ? null : over.branch;
        const refs = taskRefs(taskId);
        const done = await withMirrorLock(mirror, async () => {
          const head = await git(['rev-parse', '--verify', '-q', refs.head], mirror).catch(() => '');
          const pushed = await git(['rev-parse', '--verify', '-q', refs.pushed], mirror).catch(() => '');
          if (head) {
            try {
              await this.keepEnded(mirror, taskId, branch, head, pushed || null);
            } catch (error) {
              console.warn(`[hostd] kept the branch of task ${taskId} in ${mirror}: its unpushed commits could not be set aside: ${error instanceof Error ? error.message : error}`);
              return false;
            }
          }
          await git(['update-ref', '-d', refs.head], mirror).catch(() => '');
          await git(['update-ref', '-d', refs.pushed], mirror).catch(() => '');
          console.log(`[hostd] dropped the kept branch of task ${taskId} in ${mirror}: head ${head || 'none'}, pushed ${pushed || 'none'}`);
          return true;
        });
        if (done) dropped += 1;
      }
    }
    return dropped;
  }

  /**
   * Deletes commits set aside (`refs/fleetadlc/unpushed/*`) more than
   * `SET_ASIDE_DAYS` ago. Nothing else ever removed them, so each one kept its
   * commits from being collected for as long as the mirror lived.
   *
   * The age is when the ref was written, kept in `SET_ASIDE_LOG` beside the
   * refs, not the ref file's time or its commit's date: `gc` packs refs, which
   * takes the file away, and the commits set aside are often days old because
   * the task was paused. Read either way, a set-aside written minutes before
   * could be dropped before the task had applied it. A ref the log does not
   * know is dated from the first time it is seen here.
   */
  async dropOldSetAsides(mirror: string, now = Date.now()): Promise<number> {
    return withMirrorLock(mirror, async () => {
      // `refs/fleet/unpushed/` is where commits were set aside before the rename;
      // they age out the same way rather than staying in the mirror for ever.
      const listed = await git(
        ['for-each-ref', '--format=%(refname)', 'refs/fleetadlc/unpushed/', 'refs/fleet/unpushed/'],
        mirror,
      );
      const written = readSetAsideLog(mirror);
      const kept: Record<string, number> = {};
      let dropped = 0;
      for (const ref of listed.split('\n').filter(Boolean)) {
        const at = written[ref] ?? now;
        if (now - at < SET_ASIDE_DAYS * 24 * 3600 * 1000) {
          kept[ref] = at;
          continue;
        }
        await git(['update-ref', '-d', ref], mirror);
        dropped += 1;
      }
      writeSetAsideLog(mirror, kept);
      const ended = readEndedLog(mirror);
      if (Object.keys(ended).length > 0) {
        writeEndedLog(mirror, Object.fromEntries(Object.entries(ended).filter(([ref]) => ref in kept)));
      }
      return dropped;
    });
  }
}

/**
 * A ref as a task's clone names it. The mirror's branches are the remote's,
 * and in a clone of it they are `origin`'s: `refs/heads/main` in the mirror is
 * `refs/remotes/origin/main` in the clone, which is also what a person in the
 * session would type as `origin/main`.
 */
export function inClone(ref: string): string {
  return ref.startsWith('refs/heads/') ? `refs/remotes/origin/${ref.slice('refs/heads/'.length)}` : ref;
}
