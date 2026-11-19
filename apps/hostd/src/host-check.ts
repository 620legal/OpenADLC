import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { internalSecretRef, getSecretStore, type SecretStore } from '@openadlc/github';
import { accountEnv, asAccount, nodeProcesses, probeAccount, type AccountProbe, type HostProcesses } from './account-probe.js';
import { KILL_AFTER_MS } from './drivers/types.js';

// The probe and the processes it runs moved to `account-probe.ts`, shared
// with the release account (docs/adr/0068); re-exported for the callers and
// tests that imported them from here.
export { HOST_CHECK_PATH, dockerSocketsOf, nodeProcesses, type AccountProbe, type HostProcesses, type ProcessResult } from './account-probe.js';

/**
 * A repository's host check: a command an admin set on the repository's row,
 * such as `make host-ci`, run on the install's own machine, outside every
 * container, on a head the crew approved (#327,
 * docs/adr/0064-a-host-check-runs-as-its-own-account-and-the-merge-reads-the-bridges-record.md).
 *
 * It exists for a build only the machine can do — a macOS app needs Xcode,
 * which no container has — and it runs the pull request's own Makefile. So it
 * never runs as hostd's user, which can read `OPENADLC_HOME`, the secret store
 * and the person's files, but as an OS account of its own that a person made
 * (`OPENADLC_HOST_CHECK_ACCOUNT`), through `sudo -n -u <account>`:
 *
 * - `probe` proves before every run that the account exists, is neither root
 *   nor hostd's own user, that hostd may run a command as it, and that the
 *   command reaches nothing the install guards: it cannot read
 *   `OPENADLC_HOME`, `install.json`, the work root or hostd's home, nor enter
 *   any of those folders, nor connect to a Docker socket, is not in the
 *   `docker` group, and cannot run `sudo` without a password (#335). A
 *   failed probe refuses the run with the fix as its reason.
 * - The code reaches the account without a credential: hostd fetches the head
 *   into a mirror of its own with the token, then writes it as a git bundle to
 *   the account's stdin; the account fetches that into its working folder,
 *   which it owns and keeps between runs so a build can be incremental. No
 *   path is shared between the two users.
 * - The command runs with a cleared environment (`env -i`) and only the
 *   variables `HOST_CHECK_ENV` names: nothing from hostd's environment, the
 *   secret store or a task token reaches it.
 * - One run at a time on this hostd. A start for a pull request whose run is
 *   going cancels it, and a start queued for it is replaced.
 * - Every run ends by sending TERM and then KILL to every process the account
 *   runs, a pass included. On a cancel or the time limit the KILL waits up to
 *   `KILL_AFTER_MS` for the command to exit; once it has, it goes at once.
 *   The account runs nothing but host checks, one at a time, so that is
 *   exactly the run, and a daemon the build left in the background goes with
 *   it. The account is cleared the same way before each run, after the probe.
 *   The run ends only once its KILL has been sent, so the next run starts
 *   after it: a KILL still waiting when the next run began reached that
 *   run's build too, being sent to the whole account, and failed a head that
 *   never failed.
 * - The git steps the account runs read no system or global git config and
 *   no `~/.config/git/attributes`, run no hook and no fsmonitor, and start
 *   from the folder's `.git` emptied to its objects, refs and index, with a
 *   fresh config: an earlier run, of any repository, could have written any
 *   of them, and git ran what they named (`RECEIVE`). Each submodule's git
 *   dir is kept and cleaned the same way, so a repository with submodules
 *   still builds incrementally (docs/adr/0079).
 *
 * No model runs it, so it spends nothing. What it printed reaches hostd
 * through a pipe, and its last `LOG_TAIL_BYTES` are reported to the bridge,
 * which records the run and posts the `host-check` status.
 */

/** The end of what the command printed that is reported; the bridge keeps the same. */
export const LOG_TAIL_BYTES = 64_000;

/** How long the git steps before the command may take, apart from its own time limit. */
const PREPARE_TIMEOUT_MS = 30 * 60_000;

/** How long a finished run is kept here for the bridge to read. */
const KEPT_MS = 60 * 60 * 1000;

/** Every variable the command is given; `env -i` clears the rest. */
export function hostCheckEnv(account: string, home: string): Record<string, string> {
  return {
    ...accountEnv(account, home),
    CI: '1',
    OPENADLC_HOST_CHECK: '1',
  };
}

export type HostCheckState = 'queued' | 'running' | 'passed' | 'failed' | 'cancelled' | 'refused';

export interface HostCheckRequest {
  /** The bridge's id for it, which the report carries back. */
  runId: string;
  /** `owner/name`. */
  repo: string;
  pr: number;
  head: string;
  /** From the repository's row, set by an admin; never from the pull request. */
  command: string;
  timeoutMinutes: number;
  /** The crew account whose token fetches the head into hostd's mirror. */
  bot: string | null;
}

export interface HostCheckRun extends HostCheckRequest {
  state: HostCheckState;
  exitCode: number | null;
  durationMs: number | null;
  logTail: string;
  /** Why it was refused, cancelled or stopped, in words that say what to do. */
  reason: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/**
 * A start as the bridge sends it, or what is wrong with it. Only the bridge
 * calls this route, with the install's secret, and the command is the
 * repository row's; checked all the same, since it runs on the machine.
 */
export function hostCheckRequestFrom(body: Record<string, unknown>): HostCheckRequest | string {
  const { runId, repo, pr, head, command, timeoutMinutes, bot } = body;
  if (typeof runId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(runId)) return 'runId must be an id';
  if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.includes('..')) return 'repo must be owner/name';
  if (typeof pr !== 'number' || !Number.isInteger(pr) || pr < 1) return 'pr must be a pull request number';
  if (typeof head !== 'string' || !/^[0-9a-f]{40}$/.test(head)) return 'head must be a full commit sha';
  if (typeof command !== 'string' || !command.trim() || command.length > 500 || /[\u0000\n\r]/.test(command)) return 'command must be one line of at most 500 characters';
  if (typeof timeoutMinutes !== 'number' || !Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 1440) return 'timeoutMinutes must be 1 to 1440';
  if (bot !== undefined && bot !== null && (typeof bot !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(bot))) return 'bot must be a bot name';
  return { runId, repo, pr, head, command, timeoutMinutes, bot: typeof bot === 'string' ? bot : null };
}

export interface HostCheckDeps {
  /** The account the command runs as. */
  account: string;
  /** This install's id, so two installs' folders in the account's home are apart. */
  installId: string;
  /** hostd's own `OPENADLC_HOME`, and its `install.json`, which the account must not read. */
  openadlcHome: string;
  /** hostd's own home, which the account must not read either. */
  hostdHome?: string;
  /**
   * Where hostd keeps worktrees and mirrors (`OPENADLC_WORK_ROOT`), which the
   * account must not enter: it can be set outside `OPENADLC_HOME`. Required,
   * like `dockerSockets`, because the probe passes on what it is not given:
   * a caller that left either out would let a work root elsewhere, or a
   * reachable Docker socket, through without a word.
   */
  workRoot: string;
  /** The Docker sockets the account must not connect to; see `dockerSocketsOf`. */
  dockerSockets: string[];
  /** Where hostd keeps its mirrors for host checks. */
  mirrorRoot: string;
  /** The clone URL for a repository. */
  remote(repoFullName: string): string;
  /** The git environment that carries a bot's token for one fetch; `{}` for none. */
  fetchAuth(bot: string | null, repoFullName: string, remote: string): Promise<Record<string, string>>;
  /** Tells the bridge a run ended; see `hostCheckReporter`. */
  report(run: HostCheckRun): Promise<void>;
  processes?: HostProcesses;
  /** hostd's own uid; the account must not be it. */
  uid?: number;
  now?: () => number;
  killAfterMs?: number;
  /** How long a minute of the time limit is; only a test shortens it. */
  msPerMinute?: number;
}

type Held = HostCheckRun & { stop?: (reason: string, state: 'cancelled' | 'failed') => void };
type Stopped = { reason: string; state: 'cancelled' | 'failed' };
type Started = ReturnType<HostProcesses['start']>;

export class HostChecks {
  private readonly runs = new Map<string, Held>();
  private readonly queue: Held[] = [];
  private current: Held | null = null;
  /** The head last given to each repository's working folder, so the next bundle carries only what is new. */
  private readonly sent = new Map<string, string>();
  private readonly processes: HostProcesses;
  private readonly now: () => number;
  private idle: Promise<void> = Promise.resolve();

  constructor(private readonly deps: HostCheckDeps) {
    this.processes = deps.processes ?? nodeProcesses();
    this.now = deps.now ?? Date.now;
  }

  get account(): string {
    return this.deps.account;
  }

  /**
   * Queues a run. One already going for the same pull request is cancelled
   * first, and one queued for it is replaced: only the newest head of a pull
   * request is worth a build that can take hours.
   */
  start(request: HostCheckRequest): HostCheckRun {
    this.forgetOld();
    const same = (run: Held) => run.repo.toLowerCase() === request.repo.toLowerCase() && run.pr === request.pr;
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const queued = this.queue[index] as Held;
      if (!same(queued)) continue;
      this.queue.splice(index, 1);
      this.end(queued, 'cancelled', { reason: `a newer head, ${request.head.slice(0, 7)}, replaced it before it started` });
    }
    if (this.current && same(this.current)) this.current.stop?.(`a newer head, ${request.head.slice(0, 7)}, was pushed, so this run was stopped`, 'cancelled');
    const run: Held = {
      ...request,
      state: 'queued',
      exitCode: null,
      durationMs: null,
      logTail: '',
      reason: null,
      startedAt: new Date(this.now()).toISOString(),
      finishedAt: null,
    };
    this.runs.set(run.runId, run);
    this.queue.push(run);
    this.next();
    return view(run);
  }

  /** Stops the pull request's run, going or queued; false when it has none here. */
  cancel(repo: string, pr: number, reason = 'the pull request was closed, merged or moved on, so its run was stopped'): boolean {
    let found = false;
    const same = (run: Held) => run.repo.toLowerCase() === repo.toLowerCase() && run.pr === pr;
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const queued = this.queue[index] as Held;
      if (!same(queued)) continue;
      this.queue.splice(index, 1);
      this.end(queued, 'cancelled', { reason });
      found = true;
    }
    if (this.current && same(this.current)) {
      this.current.stop?.(reason, 'cancelled');
      found = true;
    }
    return found;
  }

  get(runId: string): HostCheckRun | null {
    const run = this.runs.get(runId);
    return run ? view(run) : null;
  }

  /** Waits until nothing is running or queued; for tests. */
  async settled(): Promise<void> {
    for (;;) {
      const idle = this.idle;
      await idle;
      if (idle === this.idle && !this.current && this.queue.length === 0) return;
    }
  }

  /**
   * Whether the account is fit to run a host check, proved by its effect:
   * see the header. Run before every run, and answered to the bridge's health
   * check (`GET /host-check/account`). The checks are `probeAccount`'s,
   * shared with the release account (`account-probe.ts`).
   */
  async probe(): Promise<AccountProbe> {
    return probeAccount(this.deps.account, 'OPENADLC_HOST_CHECK_ACCOUNT', this.deps, this.processes, (home) => hostCheckEnv(this.deps.account, home));
  }

  /** `argv` as the account, with nothing of hostd's environment but `hostCheckEnv`. */
  asAccount(argv: string[], home: string): string[] {
    return asAccount(this.deps.account, hostCheckEnv(this.deps.account, home), argv);
  }

  private next(): void {
    if (this.current) return;
    const run = this.queue.shift();
    if (!run) return;
    this.current = run;
    this.idle = this.execute(run)
      .catch((error: unknown) => {
        if (run.state === 'queued' || run.state === 'running') {
          this.end(run, 'refused', { reason: `the host check could not be run: ${error instanceof Error ? error.message : String(error)}` });
        }
      })
      .finally(() => {
        this.current = null;
        this.next();
      });
  }

  private async execute(run: Held): Promise<void> {
    run.state = 'running';
    const started = this.now();
    const halt: { stopped: Stopped | null; child: Started | null; killing: Promise<void> | null } = { stopped: null, child: null, killing: null };
    const terminate = () => {
      if (halt.stopped && halt.child && !halt.killing) halt.killing = this.kill(halt.child);
    };
    const stop = (reason: string, state: Stopped['state']) => {
      if (halt.stopped) return;
      halt.stopped = { reason, state };
      terminate();
    };
    run.stop = stop;
    // Read through a call: TypeScript keeps a property narrowed across an
    // await, though the closures above may have set it meanwhile.
    const stoppedNow = (): Stopped | null => halt.stopped;
    const limit = setTimeout(() => {
      const minutes = run.timeoutMinutes;
      stop(`it did not finish within ${minutes} minute${minutes === 1 ? '' : 's'}, so it was stopped: find what keeps it running, or raise the repository's host check time limit`, 'failed');
    }, run.timeoutMinutes * (this.deps.msPerMinute ?? 60_000));
    limit.unref?.();
    /** The account's home once the probe passed: from then on the run ends by clearing the account. */
    let home: string | null = null;
    try {
      const fit = await this.probe();
      if (!fit.ok) return this.end(run, 'refused', { reason: `${fit.detail}. ${ACCOUNT_FIX}` }, true);
      home = fit.home;
      // Whatever the account still runs — left by a run hostd did not see
      // end, as across its restart, or started by something other than a
      // host check — goes before this head reaches the folder.
      await this.clearAccount(home);
      if (halt.stopped) return this.end(run, halt.stopped.state, { reason: halt.stopped.reason }, true);

      const folder = await this.prepare(run, fit.home);
      const early = stoppedNow();
      if (early) return this.end(run, early.state, { reason: early.reason }, true);

      let tail = '';
      const child = this.processes.start(this.asAccount(['/bin/sh', '-c', 'cd "$1" && shift && exec /bin/sh -c "$1"', 'sh', folder, run.command], fit.home), (chunk) => {
        tail = `${tail}${chunk}`.slice(-LOG_TAIL_BYTES);
      });
      halt.child = child;
      terminate();
      const code = await child.exited;
      // TERM and KILL to everything the account runs, on every end, a pass
      // included: a Makefile that started `nohup … &` and exited 0 left a
      // process running as the account through every later run, of every
      // repository, free to change their folders and pass a broken head. The
      // KILL goes before the run ends, so it cannot reach the next one.
      halt.killing ??= this.kill(child);
      await halt.killing;
      const durationMs = this.now() - started;
      const end = stoppedNow();
      if (end) return this.end(run, end.state, { exitCode: code, durationMs, logTail: tail, reason: end.reason }, true);
      return this.end(run, code === 0 ? 'passed' : 'failed', { exitCode: code, durationMs, logTail: tail }, true);
    } catch (error) {
      return this.end(run, 'refused', { reason: `the host check could not be run: ${error instanceof Error ? error.message : String(error)}` }, true);
    } finally {
      clearTimeout(limit);
      delete run.stop;
      if (halt.killing) await halt.killing;
      // A run that ended before its command did — stopped, or its folder
      // could not be given the head — still clears the account: the git
      // steps ran as it.
      else if (home) await this.clearAccount(home).catch(() => undefined);
    }
  }

  /**
   * TERM, then KILL, to every process the account runs (`kill -1` as it),
   * with no wait between: nothing should be running, since each run ends by
   * killing what it left, and anything that is gets no grace.
   */
  private async clearAccount(home: string): Promise<void> {
    for (const signal of ['TERM', 'KILL'] as const) {
      await this.processes.run(this.asAccount(['/bin/kill', `-${signal}`, '-1'], home), { timeoutMs: 30_000 });
    }
  }

  /**
   * TERM to everything the account runs, then KILL once `killAfterMs` has
   * passed or the command has exited, whichever is first: what the build left
   * behind is killed at once, and nothing waits on a timer that could outlast
   * the run.
   */
  private async kill(child: Started): Promise<void> {
    await child.signalAll('TERM').catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([child.exited, new Promise((resolve) => (timer = setTimeout(resolve, this.deps.killAfterMs ?? KILL_AFTER_MS)))]);
    clearTimeout(timer);
    await child.signalAll('KILL').catch(() => undefined);
  }

  /**
   * The head in the account's working folder, checked out detached; the
   * folder's path. hostd fetches it into its own mirror with the token, and
   * hands it over as a bundle on stdin, holding only what the folder lacks
   * when it was given an earlier head; one it no longer has gets all of it.
   */
  private async prepare(run: HostCheckRun, home: string): Promise<string> {
    const key = run.repo.toLowerCase();
    const mirror = join(this.deps.mirrorRoot, `${run.repo.replace('/', '__')}.git`);
    mkdirSync(this.deps.mirrorRoot, { recursive: true });
    const git = (args: string[], env: Record<string, string> = {}) =>
      this.processes.run(['git', ...args], { env: { ...env, ...GIT_ENV }, timeoutMs: PREPARE_TIMEOUT_MS });
    if (!existsSync(mirror)) {
      const made = await git(['init', '--bare', '--quiet', mirror]);
      if (made.code !== 0) throw new Error(`hostd could not make its mirror for ${run.repo}: ${made.stderr.trim()}`);
    }
    const remote = this.deps.remote(run.repo);
    const auth = await this.deps.fetchAuth(run.bot, run.repo, remote);
    const ref = `refs/openadlc/host-check/${run.pr}`;
    let fetched = await git(['-C', mirror, 'fetch', '--quiet', remote, `+${run.head}:${ref}`], auth);
    if (fetched.code !== 0) fetched = await git(['-C', mirror, 'fetch', '--quiet', remote, `+refs/pull/${run.pr}/head:${ref}`], auth);
    const at = await git(['-C', mirror, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (fetched.code !== 0 || at.stdout.trim() !== run.head) {
      throw new Error(`hostd could not fetch ${run.head.slice(0, 7)} of ${run.repo}#${run.pr}: ${fetched.stderr.trim().slice(0, 300) || `it found ${at.stdout.trim().slice(0, 7) || 'nothing'}`}`);
    }

    const folder = join(home, 'openadlc', this.deps.installId, run.repo.replace('/', '__'));
    const give = async (since: string | null) =>
      this.processes.pipe(
        { argv: ['git', '-C', mirror, 'bundle', 'create', '-', ref, ...(since ? [`^${since}`] : [])], env: GIT_ENV },
        { argv: this.asAccount(['/bin/sh', '-c', RECEIVE, 'sh', folder, run.head], home) },
        PREPARE_TIMEOUT_MS,
      );
    const last = this.sent.get(key) ?? null;
    let given = last && last !== run.head ? await give(last) : null;
    if (!given || given.code !== 0) given = await give(null);
    if (given.code !== 0) throw new Error(`the head could not be given to ${this.deps.account}'s working folder ${folder}: ${(given.stderr || given.stdout).trim().slice(0, 300)}`);
    this.sent.set(key, run.head);
    return folder;
  }

  private end(
    run: Held,
    state: Exclude<HostCheckState, 'queued' | 'running'>,
    detail: { exitCode?: number; durationMs?: number; logTail?: string; reason?: string },
    report = true,
  ): void {
    if (run.finishedAt) return;
    run.state = state;
    run.exitCode = detail.exitCode ?? null;
    run.durationMs = detail.durationMs ?? null;
    if (detail.logTail !== undefined) run.logTail = detail.logTail;
    run.reason = detail.reason ?? null;
    run.finishedAt = new Date(this.now()).toISOString();
    if (!report) return;
    void this.deps.report(view(run)).catch((error: unknown) => {
      console.warn(
        `[hostd] host check ${run.runId} on ${run.repo}#${run.pr} at ${run.head.slice(0, 7)} ${state}, but the bridge did not record it: ` +
          `${error instanceof Error ? error.message : String(error)}. The bridge's sweep finds it lost and asks again.`,
      );
    });
  }

  private forgetOld(): void {
    const cutoff = this.now() - KEPT_MS;
    for (const [id, run] of this.runs) {
      if (run.finishedAt && Date.parse(run.finishedAt) < cutoff) this.runs.delete(id);
    }
  }
}

/** What to do when the probe fails; the health check's card says the same. */
export const ACCOUNT_FIX = 'Make the account and its sudo rule as docs/self-hosting.md#host-checks says, then run openadlc doctor';

/** Git's own settings that could run something of the mirror's, off for hostd's git. */
const GIT_ENV: Record<string, string> = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };

/**
 * What of the folder's `.git` RECEIVE keeps between runs: the objects, so the
 * thin bundle hostd sends still has its prerequisites, the refs, and the index,
 * whose stat data lets `checkout --force` leave unchanged files and their
 * mtimes alone, so `make` stays incremental. Nothing here can name a program.
 */
export const RECEIVE_KEEPS = ['objects', 'refs', 'packed-refs', 'HEAD', 'index', 'sharedindex.*', 'shallow'] as const;

/**
 * What RECEIVE keeps of every git dir in the folder, the top-level `.git` and
 * each submodule's: `RECEIVE_KEEPS` and `modules`, the submodules' own git
 * dirs, which are kept only to be cleaned the same way in turn. Without them a
 * repository with a submodule could not build twice: its folder's gitfile
 * pointed at a git dir that was gone, and only a Clean build got past it
 * (#365, docs/adr/0079-a-submodules-git-dir-is-kept-and-cleaned-like-the-top-level-git.md).
 */
export const MODULE_KEEPS = [...RECEIVE_KEEPS, 'modules'] as const;

/**
 * The submodule pass, `modules <gitdir> <worktree> <staging>`, run once the
 * head is checked out: for every gitlink in `<gitdir>`'s index, the module's
 * kept git dir, found by its name in `<worktree>/.gitmodules`, is cleaned to
 * `MODULE_KEEPS`, moved back under `<gitdir>/modules`, and given a config and
 * a gitfile this script writes, then the pass goes into its own submodules.
 * A module it cannot vouch for — no valid name, no kept git dir, a symlink on
 * the way to it, a path that is not a folder — is emptied instead, so the
 * repository's own `submodule update --init` clones it again. What is left
 * in `<staging>` afterwards is modules the head no longer has, and goes.
 *
 * - A module's index is the earlier run's, so a nested level's gitlinks are
 *   only what it says: one it left out would keep a planted `.git` at its
 *   path, which the repository's `submodule update --recursive` runs in. So
 *   every `.git` inside a kept module's folder goes before its gitfile is
 *   written, and the pass writes back the ones it vouches for.
 * - A path git would never check out (`..`, `.`, an empty or `.git` part) or
 *   one with a symlink on the way stops the receive: only a planted index
 *   holds one, and a Clean build starts the folder again.
 * - The old config is read as data (`config --file`, which follows no
 *   `include`), and only `remote.origin.url` is carried over, only in a shape
 *   that names no remote helper and no option.
 *
 * Before the fetch, `unpin` removes the `.git` of every gitlink the kept
 * index names, and the fetch does not recurse: git's on-demand fetch ran
 * `git fetch` inside a populated submodule whose gitlink changed, with
 * whatever config its `.git` held, and the checkout opened each one through
 * a gitfile left dangling once `.git/modules` was staged away.
 *
 * Each call is a subshell, so the recursion's variables are its own.
 */
const MODULES_FUNCTIONS = [
  `clean() { find "$1" -mindepth 1 -maxdepth 1 ${MODULE_KEEPS.map((name) => `! -name '${name}'`).join(' ')} -exec rm -rf {} +; rm -f "$1/objects/info/alternates" "$1/objects/info/http-alternates"; }`,
  'stage() { rm -rf "$1/openadlc-modules"; if [ -L "$1/modules" ] || { [ -e "$1/modules" ] && [ ! -d "$1/modules" ]; }; then rm -f "$1/modules"; elif [ -d "$1/modules" ]; then mv "$1/modules" "$1/openadlc-modules"; fi; }',
  'up() { u=../; q=$1; while :; do case $q in */*) q=${q#*/}; u=../$u;; *) break;; esac; done; printf %s "$u"; }',
  'nolink() { b=$1; r=$2; while :; do b=$b/${r%%/*}; [ ! -L "$b" ] || return 1; case $r in */*) r=${r#*/};; *) return 0;; esac; done; }',
  'refuse() { printf \'the receive script cannot keep the submodule at %s: %s\\n\' "$1" "$2" >&2; exit 1; }',
  'gitlinks() { g -c core.quotePath=false --git-dir="$1" ls-files --stage > "$2.all"; grep \'^160000 \' "$2.all" > "$2" || [ $? -eq 1 ]; rm -f "$2.all"; }',
  'unpin() (',
  '  gitlinks .git .git/openadlc-gitlinks',
  '  tab=$(printf \'\\t\')',
  '  while IFS="$tab" read -r meta p <&3; do',
  '    case $p in \'"\'*) continue;; esac',
  '    case /$p/ in */../*|*/./*|*//*|*/[.][gG][iI][tT]/*) continue;; esac',
  '    if nolink . "$p"; then rm -rf "$p/.git"; fi',
  '  done 3< .git/openadlc-gitlinks',
  '  rm -f .git/openadlc-gitlinks',
  ')',
  'modules() (',
  '  gd=$1; wt=$2; st=$3; links=$1/openadlc-gitlinks; names=$1/openadlc-names',
  '  gitlinks "$gd" "$links"',
  '  : > "$names"',
  '  if [ -f "$wt/.gitmodules" ] && [ ! -L "$wt/.gitmodules" ]; then g config --file "$wt/.gitmodules" --get-regexp \'^submodule\\..*\\.path$\' > "$names" || :; fi',
  '  tab=$(printf \'\\t\')',
  '  while IFS="$tab" read -r meta p <&3; do',
  '    case $wt in .) P=$p;; *) P=$wt/$p;; esac',
  '    case $p in \'"\'*) refuse "$P" "its path has a tab, newline, quote or backslash in it; rename it";; esac',
  '    case /$p/ in */../*|*/./*|*//*|*/[.][gG][iI][tT]/*) refuse "$P" "git would not check out that path; cut a Clean build";; esac',
  '    if [ -L "$P" ] || { [ -e "$P" ] && [ ! -d "$P" ]; }; then rm -f "$P"; fi',
  '    nolink . "$P" || refuse "$P" "a symbolic link is on the way to it; cut a Clean build"',
  '    rm -rf "$P/.git"',
  '    name=',
  '    while read -r key val <&4; do',
  '      [ "$val" = "$p" ] || continue',
  '      n=${key#submodule.}; n=${n%.path}',
  '      if [ "submodule.$n.path" = "$key" ]; then name=$n; break; fi',
  '    done 4< "$names"',
  "    case $name in ''|/*|*[!_.@+/0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-]*) name=;; esac",
  '    case /$name/ in */./*|*/../*|*//*) name=;; esac',
  '    m=$gd/modules/$name; old=$st/$name',
  '    if [ -n "$name" ] && [ -d "$P" ] && [ -d "$st" ] && nolink "$st" "$name" && [ -d "$old" ] && [ ! -e "$m" ] && [ ! -L "$m" ]; then',
  '      url=',
  '      if [ -f "$old/config" ] && [ ! -L "$old/config" ]; then url=$(g config --file "$old/config" --get remote.origin.url || :); fi',
  '      case $url in *::*|-*) url=;; esac',
  "      if [ -n \"$(printf %s \"$url\" | LC_ALL=C tr -d '\\041-\\176')\" ]; then url=; fi",
  '      case $url in https://*|ssh://*|git://*|file://*|/*) ;; *:*) case ${url%%:*} in \'\'|*/*) url=;; esac;; *) url=;; esac',
  '      clean "$old"',
  '      mkdir -p "${m%/*}"',
  '      mv "$old" "$m"',
  '      g --git-dir="$m" init --quiet --template=',
  '      g config --file "$m/config" core.bare false',
  '      g config --file "$m/config" core.worktree "$(up "$m")$P"',
  '      if [ -n "$url" ]; then g config --file "$m/config" remote.origin.url "$url"; g config --file "$m/config" remote.origin.fetch \'+refs/heads/*:refs/remotes/origin/*\'; fi',
  '      find "$P" -mindepth 2 -iname .git -prune -exec rm -rf {} +',
  '      printf \'gitdir: %s%s\\n\' "$(up "$P")" "$m" > "$P/.git"',
  '      stage "$m"',
  '      modules "$m" "$P" "$m/openadlc-modules"',
  '    else',
  '      rm -rf "$P"; mkdir -p "$P"',
  '    fi',
  '  done 3< "$links"',
  '  rm -rf "$st" "$links" "$names"',
  ')',
];

/**
 * Run as the account, with the bundle on stdin: the folder made once and kept,
 * the bundle written inside it, fetched, the head checked out detached and
 * forced over what a build changed in tracked files, and the bundle removed.
 * Untracked and ignored files stay, so the next build is incremental; the
 * repository's own `host-ci` target decides what a clean build is.
 *
 * An earlier run, of any repository, wrote this folder as the same account,
 * and git ran what it left: a `filter.<name>.smudge` in `.git/config` with
 * `* filter=<name>` in `.git/info/attributes` ran at checkout, and so did one
 * reached through a `.git` that is a gitfile or symlink, or a
 * `.git/commondir`. Git has no switch that stops it reading a repository's
 * own config, so it is removed rather than overridden: `.git` that is not a
 * plain directory goes, everything under it but `RECEIVE_KEEPS` goes, and
 * `init --template=` writes a fresh config with no hooks. Every git here is
 * `g`, which then reads only that config, its own `-c` flags and the head's
 * tracked `.gitattributes`, which can name a filter but not define one: no
 * system or global config, no `~/.config/git/attributes`, no hook and no
 * fsmonitor. The fetch writes no `FETCH_HEAD` and git no reflog, so the run
 * leaves `.git` with only what it keeps and what `init` wrote
 * (docs/adr/0067-a-host-checks-working-folder-keeps-only-gits-objects-refs-and-index.md).
 *
 * A submodule's git dir under `.git/modules` is kept and cleaned the same
 * way, and its config and its folder's gitfile are written here, never
 * trusted from the earlier run: a filter or hook there ran at the
 * repository's own `submodule update`, and removing the dirs instead left
 * every gitfile dangling, so a second build failed (`MODULES_FUNCTIONS`,
 * docs/adr/0079-a-submodules-git-dir-is-kept-and-cleaned-like-the-top-level-git.md).
 *
 * `namespace` is the refs the bundle carries, `refs/openadlc/<namespace>/*`:
 * a host check's, or a release's (`release-run.ts`), which runs the same
 * script as its own account.
 */
export function receiveScript(namespace: 'host-check' | 'release'): string {
  return [
  'set -e',
  'export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1',
  'g() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.attributesFile=/dev/null -c core.logAllRefUpdates=false "$@"; }',
  ...MODULES_FUNCTIONS,
  'dir="$1"; head="$2"',
  'mkdir -p "$dir"',
  'cd "$dir"',
  'if [ -L .git ] || { [ -e .git ] && [ ! -d .git ]; }; then rm -rf .git; fi',
  'if [ -d .git ]; then clean .git; stage .git; fi',
  'g init --quiet --template= .',
  'unpin',
  'bundle=.git/openadlc-incoming.bundle',
  'cat > "$bundle"',
  'trap \'rm -f "$bundle"\' EXIT',
  `g fetch --quiet --no-write-fetch-head --no-recurse-submodules "$bundle" '+refs/openadlc/${namespace}/*:refs/openadlc/${namespace}/*'`,
  'g -c advice.detachedHead=false checkout --quiet --force --detach "$head"',
  'modules .git . .git/openadlc-modules',
  ].join('\n');
}

/**
 * The host check's receive, shared with the release run (`release-run.ts`):
 * only the namespace of the refs it fetches is a parameter, so the `.git`
 * cleaning of ADR 0067, and of each submodule's git dir (ADR 0079), is one
 * script.
 */
export const RECEIVE = receiveScript('host-check');

function view(run: HostCheckRun): HostCheckRun {
  const { stop: _stop, ...rest } = run as Held;
  return { ...rest };
}

/**
 * Tells the bridge a run ended, with the install's secret: the one way a host
 * check result is written (`POST /internal/host-check`).
 */
export function hostCheckReporter(bridgeUrl: string, store: SecretStore = getSecretStore()): (run: HostCheckRun) => Promise<void> {
  return async (run) => {
    const secret = await store.get(internalSecretRef());
    if (!secret) throw new Error('hostd has no internal secret yet, so it cannot report the run. Start the bridge, which generates it: openadlc up');
    const response = await fetch(`${bridgeUrl}/internal/host-check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openadlc-internal-secret': secret },
      body: JSON.stringify({
        runId: run.runId,
        repo: run.repo,
        pr: run.pr,
        head: run.head,
        state: run.state,
        exitCode: run.exitCode,
        durationMs: run.durationMs,
        logTail: run.logTail,
        reason: run.reason,
      }),
    });
    if (!response.ok) throw new Error(`the bridge answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  };
}
