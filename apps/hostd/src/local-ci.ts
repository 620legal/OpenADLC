import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { internalSecretRef, getSecretStore, type SecretStore } from '@fleetadlc/github';
import { KILL_AFTER_MS, type ExecDriver, type TaskComputer } from './drivers/types.js';
import { DEFAULT_LOCAL_CI_TIMEOUT_MINUTES } from './config.js';

/**
 * The repository's checks, run by hostd on a task's exact head.
 *
 * GitHub's CI ran on every push of every crew pull request, reviewed or not,
 * and was paid for by the minute; the builder was told to run `make ci` first
 * and nothing knew whether it had. Now `fleetadlc-ci` in the session asks the
 * bridge, the bridge asks hostd, and hostd runs `make ci` in the worktree
 * itself — with the task's own database and its repository's home, as `make
 * setup` was run — and reports what happened. The session can start a run and
 * read its outcome; it never reports one, so a pass cannot be written by the
 * work it vouches for.
 *
 * A pass is a pass on a commit: HEAD is read before and after, and so is the
 * tree. A run on uncommitted changes, or one whose HEAD moved or whose tree it
 * changed while it ran, is refused rather than recorded, since what passed is
 * not then any commit that could be pushed.
 *
 * The session controls the worktree's `.git`, so what it says is proved before
 * it is believed (`unproven`): a skip-worktree or assume-unchanged entry hid a
 * changed file from `git status`, and replace refs, grafts, alternates, hooks
 * or a `.git` pointing elsewhere could make HEAD name a commit other than the
 * one `make ci` ran on, which was then recorded as passing. Every git command
 * here runs with the system and global config, replace objects, fsmonitor and
 * the untracked cache turned off (`GIT_ENV`, `GIT_OVERRIDES`). When the proof
 * holds, `make ci` runs in the worktree as before. When it does not, it runs
 * in a clean checkout of the commit in the task's own directory, made with
 * `git clone --no-local` so objects are copied and hashed, and the result is
 * that commit's. What this does not cover: a session changing files while
 * `make ci` runs, and ignored files, which `make setup` and `make ci` create.
 */

/** The end of what `make ci` printed, kept for the lead reviewer and a person. */
const LOG_TAIL_BYTES = 16_000;

/**
 * `make ci` with its output held in a file and only its end printed: the local
 * driver's exec buffers what a command prints, and a full test run can be
 * larger than the buffer. Its exit status is the checks'.
 */
export const LOCAL_CI_COMMAND = [
  'sh',
  '-c',
  `log=$(mktemp); make ci >"$log" 2>&1; code=$?; tail -c ${LOG_TAIL_BYTES} "$log"; rm -f "$log"; exit $code`,
];

/** Git's own settings that could change what it reports, off for every command here; see the header. */
const GIT_ENV: Record<string, string> = { GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const GIT_OVERRIDES = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'status.showUntrackedFiles=all'];

/**
 * What of the worktree's `.git` is files rather than git's answers: its real
 * path first, then a line per thing that makes it not the commit's own. A
 * fresh clone has git's `*.sample` hooks, which run nothing.
 */
const FILES_PROBE = [
  'sh',
  '-c',
  [
    'cd "$1" || exit 1',
    'pwd -P',
    '{ [ -d .git ] && [ ! -L .git ]; } || echo "has a .git that is not a directory of its own"',
    '[ -s .git/objects/info/alternates ] && echo "has an alternate object store"',
    '[ -e .git/info/grafts ] && echo "has a grafts file"',
    '[ -d .git/hooks ] && [ -n "$(find .git/hooks -mindepth 1 ! -name \'*.sample\' -print | head -n 1)" ] && echo "has hooks"',
    'exit 0',
  ].join('\n'),
  'probe',
];

/** How long a finished run is kept here for the session to read its outcome. */
const KEPT_MS = 60 * 60 * 1000;

export type LocalCiState = 'running' | 'passed' | 'failed' | 'refused';

export interface LocalCiRun {
  id: string;
  taskId: string;
  state: LocalCiState;
  /** The commit it ran on, once read. */
  headSha: string | null;
  branch: string | null;
  exitCode: number | null;
  durationMs: number | null;
  logTail: string;
  /** Why it was refused, in words that say what to do. */
  reason: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/**
 * Where a task's checks run: the task's own computer, its worktree, and the
 * environment `make setup` had. The computer, not the bot: a seat runs several
 * tasks at once, each in a container of its own, and the bot names none of them.
 */
export interface LocalCiTarget {
  bot: string;
  computer: TaskComputer;
  worktree: string;
  branch: string | null;
  env: Record<string, string>;
}

export class LocalCiRefused extends Error {
  readonly status = 409;
}

export class LocalCi {
  private readonly runs = new Map<string, LocalCiRun & { done: Promise<void> }>();

  constructor(
    private readonly driver: Pick<ExecDriver, 'exec'>,
    /** The task's target while it runs on this host, or null. */
    private readonly target: (taskId: string) => LocalCiTarget | null,
    /** Tells the bridge a run finished, with the install's secret; see `bridgeReporter`. */
    private readonly report: (run: LocalCiRun) => Promise<void>,
    private readonly now: () => number = Date.now,
    /**
     * How long `make ci` may run. With no limit a hung suite stayed "running"
     * for the life of the task, every later `fleetadlc-ci` joined it, and the
     * builder could never record a pass.
     */
    private readonly timeoutMs: number = DEFAULT_LOCAL_CI_TIMEOUT_MINUTES * 60_000,
  ) {}

  /**
   * Starts a run for a task, or answers the one already going for it: two
   * `make ci` at once in one worktree share its build output and its database.
   * Only while it is within its deadline: one past it has been killed, so a
   * new run cannot share the worktree with it.
   */
  start(taskId: string): LocalCiRun {
    const target = this.target(taskId);
    if (!target) throw new LocalCiRefused(`task ${taskId} is not running on this host, so there is no worktree to run make ci in`);
    this.forgetOld();
    const deadline = this.now() - this.timeoutMs - KILL_AFTER_MS;
    const going = [...this.runs.values()].find(
      (run) => run.taskId === taskId && run.state === 'running' && Date.parse(run.startedAt) > deadline,
    );
    if (going) return view(going);
    const run: LocalCiRun = {
      id: randomUUID(),
      taskId,
      state: 'running',
      headSha: null,
      branch: target.branch,
      exitCode: null,
      durationMs: null,
      logTail: '',
      reason: null,
      startedAt: new Date(this.now()).toISOString(),
      finishedAt: null,
    };
    const entry = Object.assign(run, { done: Promise.resolve() });
    this.runs.set(run.id, entry);
    entry.done = this.execute(entry, target).catch((error: unknown) => {
      this.finish(entry, 'refused', { reason: `make ci could not be run: ${error instanceof Error ? error.message : String(error)}` });
    });
    return view(entry);
  }

  /** A run as it stands, or null when this host has no such run for the task. */
  get(taskId: string, runId: string): LocalCiRun | null {
    const run = this.runs.get(runId);
    return run && run.taskId === taskId ? view(run) : null;
  }

  /** Waits for a run to finish; for tests. */
  async settled(runId: string): Promise<LocalCiRun | null> {
    const run = this.runs.get(runId);
    if (!run) return null;
    await run.done;
    return view(run);
  }

  private async execute(run: LocalCiRun, target: LocalCiTarget): Promise<void> {
    const before = await this.commit(target, target.worktree);
    if (!before.head) {
      this.finish(run, 'refused', { reason: `could not read HEAD in the worktree: ${before.error}` });
      return;
    }
    run.headSha = before.head;
    if (before.changed.length > 0) {
      this.finish(run, 'refused', {
        reason:
          `the worktree has changes that are not committed (${shown(before.changed)}): commit them, then run fleetadlc-ci again. ` +
          'A pass is recorded for a commit, and these are not one.',
      });
      return;
    }

    // Hidden state is not the builder's mistake to fix: the run goes to a
    // clean checkout of the commit instead, and says so first in its log.
    const why = await this.unproven(target);
    if (!why) return this.check(run, target, target.worktree, before.head, '');
    const dir = join(target.computer.slotDir, `ci-${run.id}`);
    try {
      await this.cleanCheckout(target, dir, before.head);
      // As task-runner.ts runs it at a task's start; a repository with no
      // such target needs nothing done, so its exit is not the run's.
      await this.driver.exec(target.computer, ['make', '-s', 'setup'], { cwd: dir, env: target.env, timeoutMs: this.timeoutMs });
      return await this.check(run, target, dir, before.head, `ran in a clean checkout of ${before.head.slice(0, 7)}: ${why}\n`);
    } finally {
      await this.driver.exec(target.computer, ['rm', '-rf', dir]).catch(() => undefined);
    }
  }

  /** `make ci` in `dir` on `head`, and the run finished from what it did. */
  private async check(run: LocalCiRun, target: LocalCiTarget, dir: string, head: string, note: string): Promise<void> {
    const started = this.now();
    const result = await this.driver.exec(target.computer, LOCAL_CI_COMMAND, { cwd: dir, env: target.env, timeoutMs: this.timeoutMs });
    const durationMs = this.now() - started;
    const logTail = `${note}${`${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`.slice(-LOG_TAIL_BYTES)}`;

    // Failed, on the commit it ran on: what a killed run left in the
    // worktree says nothing about that commit.
    if (result.timedOut) {
      const minutes = Math.round(this.timeoutMs / 60_000);
      this.finish(run, 'failed', {
        exitCode: result.code,
        durationMs,
        logTail,
        reason: `make ci did not finish within ${minutes} minute${minutes === 1 ? '' : 's'}, so it was stopped: find what keeps it running (an open handle, a watcher, a test waiting on a port), fix it, commit, and run fleetadlc-ci again`,
      });
      await this.report(view(run)).catch((error: unknown) =>
        console.warn(`[hostd] local CI ${run.id} for ${run.taskId} timed out but the bridge was not told: ${error instanceof Error ? error.message : error}`),
      );
      return;
    }

    const after = await this.commit(target, dir);
    if (after.head !== head) {
      this.finish(run, 'refused', {
        durationMs,
        logTail,
        reason: `HEAD moved from ${head.slice(0, 7)} to ${(after.head ?? 'nothing').slice(0, 7)} while make ci ran: run fleetadlc-ci again on the commit you mean to push.`,
      });
      return;
    }
    if (after.changed.length > 0) {
      this.finish(run, 'refused', {
        durationMs,
        logTail,
        reason:
          `make ci changed the worktree (${shown(after.changed)}), so what passed is not the commit: ` +
          'commit what it generates, or have the repository ignore it, then run fleetadlc-ci again.',
      });
      return;
    }

    this.finish(run, result.code === 0 ? 'passed' : 'failed', { exitCode: result.code, durationMs, logTail });
    await this.report(view(run)).catch((error: unknown) =>
      console.warn(`[hostd] local CI ${run.id} for ${run.taskId} finished but the bridge was not told: ${error instanceof Error ? error.message : error}`),
    );
  }

  /** Git in the task's computer, with what could change its answers turned off. */
  private git(target: LocalCiTarget, dir: string | null, args: string[]) {
    return this.driver.exec(target.computer, ['git', ...GIT_OVERRIDES, ...(dir ? ['-C', dir] : []), ...args], { env: GIT_ENV });
  }

  /** HEAD, and what `git status` says differs from it, in `dir`. */
  private async commit(target: LocalCiTarget, dir: string): Promise<{ head: string | null; changed: string[]; error: string }> {
    const head = await this.git(target, dir, ['rev-parse', 'HEAD']);
    if (head.code !== 0) return { head: null, changed: [], error: head.stderr.trim() || `git exited ${head.code}` };
    const status = await this.git(target, dir, ['status', '--porcelain=v1', '--untracked-files=all']);
    const changed =
      status.code === 0
        ? status.stdout.split('\n').map((line) => line.slice(3).trim()).filter(Boolean)
        : [`git status failed: ${status.stderr.trim() || status.code}`];
    return { head: head.stdout.trim(), changed, error: '' };
  }

  /**
   * Why the worktree cannot be taken for its commit's own tree, or null when it
   * can; see the header. Asked only once its status is clean.
   */
  private async unproven(target: LocalCiTarget): Promise<string | null> {
    const reasons: string[] = [];
    const files = await this.driver.exec(target.computer, [...FILES_PROBE, target.worktree]);
    const [real = '', ...found] = files.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    if (files.code !== 0 || !real) return `the worktree's files could not be read: ${files.stderr.trim() || `exit ${files.code}`}`;
    reasons.push(...found);

    const where = await this.git(target, target.worktree, ['rev-parse', '--show-toplevel', '--absolute-git-dir']);
    const [top, gitDir] = where.stdout.split('\n').map((line) => line.trim());
    if (where.code !== 0 || top !== real || gitDir !== `${real}/.git`) reasons.push('has its repository somewhere else');

    const config = await this.git(target, target.worktree, ['config', '--local', '--get-regexp', '^core\\.(worktree|hookspath)$']);
    for (const line of config.stdout.split('\n').filter(Boolean)) reasons.push(`sets ${line.split(' ')[0]}`);

    const replace = await this.git(target, target.worktree, ['for-each-ref', 'refs/replace/']);
    if (replace.code !== 0 || replace.stdout.trim()) reasons.push('has replace refs');

    const index = await this.git(target, target.worktree, ['ls-files', '-v']);
    // `H` is a plain entry; `S` is skip-worktree, and a lowercase tag is
    // assume-unchanged. Both hide a changed file from `git status`.
    const tags = new Set(index.stdout.split('\n').filter(Boolean).map((line) => line[0] ?? ''));
    if (index.code !== 0) reasons.push('has an index git could not read');
    if (tags.has('S') || tags.has('s')) reasons.push('has skip-worktree entries');
    if ([...tags].some((tag) => tag !== tag.toUpperCase())) reasons.push('has assume-unchanged entries');

    return reasons.length > 0 ? `the worktree ${reasons.join(', and ')}` : null;
  }

  /** A detached checkout of `sha` at `dir`, cloned from the worktree with every object copied and hashed. */
  private async cleanCheckout(target: LocalCiTarget, dir: string, sha: string): Promise<void> {
    const cloned = await this.git(target, null, ['clone', '--no-local', '--no-checkout', '--quiet', target.worktree, dir]);
    if (cloned.code !== 0) throw new Error(`a clean checkout of ${sha.slice(0, 7)} could not be made: ${cloned.stderr.trim() || `git exited ${cloned.code}`}`);
    const checkout = await this.git(target, dir, ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', sha]);
    if (checkout.code !== 0) throw new Error(`${sha.slice(0, 7)} could not be checked out cleanly: ${checkout.stderr.trim() || `git exited ${checkout.code}`}`);
    const head = await this.git(target, dir, ['rev-parse', 'HEAD']);
    if (head.stdout.trim() !== sha) throw new Error(`the clean checkout is at ${head.stdout.trim().slice(0, 7) || 'nothing'}, not ${sha.slice(0, 7)}`);
  }

  private finish(
    run: LocalCiRun,
    state: Exclude<LocalCiState, 'running'>,
    detail: { exitCode?: number; durationMs?: number; logTail?: string; reason?: string },
  ): void {
    run.state = state;
    run.exitCode = detail.exitCode ?? null;
    run.durationMs = detail.durationMs ?? null;
    if (detail.logTail !== undefined) run.logTail = detail.logTail;
    run.reason = detail.reason ?? null;
    run.finishedAt = new Date(this.now()).toISOString();
  }

  private forgetOld(): void {
    const cutoff = this.now() - KEPT_MS;
    for (const [id, run] of this.runs) {
      if (run.finishedAt && Date.parse(run.finishedAt) < cutoff) this.runs.delete(id);
    }
  }
}

function view(run: LocalCiRun): LocalCiRun {
  const { done: _done, ...rest } = run as LocalCiRun & { done?: unknown };
  return { ...rest };
}

function shown(paths: readonly string[]): string {
  return `${paths.slice(0, 3).join(', ')}${paths.length > 3 ? `, and ${paths.length - 3} more` : ''}`;
}

/**
 * Tells the bridge a run finished, with the install's secret: the one way a
 * local CI result is written (`POST /internal/local-ci`). A refusal is not
 * reported — nothing passed or failed on a commit.
 */
export function bridgeReporter(bridgeUrl: string, store: SecretStore = getSecretStore()): (run: LocalCiRun) => Promise<void> {
  return async (run) => {
    const secret = await store.get(internalSecretRef());
    if (!secret) {
      throw new Error('hostd has no internal secret yet, so it cannot report the run. Start the bridge, which generates it, then retry: fleetadlc up');
    }
    const response = await fetch(`${bridgeUrl}/internal/local-ci`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fleetadlc-internal-secret': secret },
      body: JSON.stringify({
        runId: run.id,
        taskId: run.taskId,
        headSha: run.headSha,
        branch: run.branch,
        ok: run.state === 'passed',
        exitCode: run.exitCode,
        durationMs: run.durationMs,
        logTail: run.logTail,
      }),
    });
    if (!response.ok) throw new Error(`the bridge answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  };
}
