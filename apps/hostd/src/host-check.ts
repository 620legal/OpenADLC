import { spawn as spawnChild, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { internalSecretRef, getSecretStore, type SecretStore } from '@openadlc/github';
import { KILL_AFTER_MS } from './drivers/types.js';

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
 *   command cannot read `OPENADLC_HOME`, `install.json` or hostd's home. A
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
 * - A cancel, or the time limit, sends TERM and then KILL after
 *   `KILL_AFTER_MS` to every process the account runs. The account runs
 *   nothing but host checks, one at a time, so that is exactly the run, and a
 *   daemon the build left in the background goes with it.
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

/** A name `useradd` and `sysadminctl` would make, so it is safe as an argument and in `~name`. */
const ACCOUNT_NAME = /^[a-z_][a-z0-9_-]{0,31}$/i;

/** Where the build finds its tools: the system's, then Homebrew's on Apple silicon and Intel. */
export const HOST_CHECK_PATH = '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin';

/** Every variable the command is given; `env -i` clears the rest. */
export function hostCheckEnv(account: string, home: string): Record<string, string> {
  return {
    PATH: HOST_CHECK_PATH,
    HOME: home,
    USER: account,
    LOGNAME: account,
    LANG: 'en_US.UTF-8',
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

/** What the probe found: `ok`, or the first thing wrong and what to do about it. */
export type AccountProbe =
  | { ok: true; account: string; uid: number; home: string }
  | { ok: false; account: string; problem: 'no_account' | 'not_dedicated' | 'no_sudo' | 'can_read'; path?: string; detail: string };

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

/**
 * How hostd runs things on the machine: a command to its end, one command's
 * output piped into another's input, and the long one, whose output is
 * streamed. Injected so the tests can see every argv and environment.
 */
export interface HostProcesses {
  run(argv: string[], options?: { env?: Record<string, string>; timeoutMs?: number }): Promise<ProcessResult>;
  pipe(from: { argv: string[]; env?: Record<string, string> }, to: { argv: string[] }, timeoutMs: number): Promise<ProcessResult>;
  start(argv: string[], onOutput: (chunk: string) => void): { exited: Promise<number>; signalAll(signal: 'TERM' | 'KILL'): Promise<void> };
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
   * check (`GET /host-check/account`).
   */
  async probe(): Promise<AccountProbe> {
    const account = this.deps.account;
    const fail = (problem: Exclude<AccountProbe, { ok: true }>['problem'], detail: string, path?: string): AccountProbe => ({
      ok: false,
      account,
      problem,
      detail,
      ...(path ? { path } : {}),
    });
    if (!ACCOUNT_NAME.test(account)) return fail('no_account', `${account} is not an account name; set OPENADLC_HOST_CHECK_ACCOUNT to the account you made`);
    const id = await this.processes.run(['id', '-u', account]);
    const uid = Number.parseInt(id.stdout.trim(), 10);
    if (id.code !== 0 || !Number.isInteger(uid)) return fail('no_account', `there is no account named ${account} on this machine`);
    if (uid === 0) return fail('not_dedicated', `${account} is root, which can read everything; make an account of its own`);
    const own = this.deps.uid ?? process.getuid?.();
    if (own !== undefined && uid === own) return fail('not_dedicated', `${account} is the account hostd runs as, which can read OPENADLC_HOME; make an account of its own`);
    const home = (await this.processes.run(['/bin/sh', '-c', 'eval "echo ~$1"', 'sh', account])).stdout.trim();
    if (!home || home.startsWith('~')) return fail('no_account', `${account} has no home folder to keep its working folders in`);
    const can = await this.processes.run(this.asAccount(['/usr/bin/true'], home), { timeoutMs: 30_000 });
    if (can.code !== 0) return fail('no_sudo', `hostd cannot run a command as ${account} without a password: ${(can.stderr || can.stdout).trim().slice(0, 200) || `sudo exited ${can.code}`}`);
    const hostdHome = this.deps.hostdHome ?? homedir();
    for (const path of [this.deps.openadlcHome, join(this.deps.openadlcHome, 'install.json'), hostdHome]) {
      const read = await this.processes.run(this.asAccount(['/bin/sh', '-c', 'test -r "$1" || ls "$1" >/dev/null 2>&1', 'sh', path], home), { timeoutMs: 30_000 });
      if (read.code === 0) return fail('can_read', `${account} can read ${path}`, path);
    }
    return { ok: true, account, uid, home };
  }

  /** `argv` as the account, with nothing of hostd's environment but `hostCheckEnv`. */
  asAccount(argv: string[], home: string): string[] {
    const env = Object.entries(hostCheckEnv(this.deps.account, home)).map(([key, value]) => `${key}=${value}`);
    return ['sudo', '-n', '-u', this.deps.account, '--', '/usr/bin/env', '-i', ...env, ...argv];
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
    let stopped: { reason: string; state: 'cancelled' | 'failed' } | null = null;
    let signal: ((which: 'TERM' | 'KILL') => Promise<void>) | null = null;
    const stop = (reason: string, state: 'cancelled' | 'failed') => {
      if (stopped) return;
      stopped = { reason, state };
      if (signal) void this.kill(signal);
    };
    run.stop = stop;
    const limit = setTimeout(() => {
      const minutes = run.timeoutMinutes;
      stop(`it did not finish within ${minutes} minute${minutes === 1 ? '' : 's'}, so it was stopped: find what keeps it running, or raise the repository's host check time limit`, 'failed');
    }, run.timeoutMinutes * (this.deps.msPerMinute ?? 60_000));
    limit.unref?.();
    try {
      const fit = await this.probe();
      if (!fit.ok) return this.end(run, 'refused', { reason: `${fit.detail}. ${ACCOUNT_FIX}` }, true);
      if (stopped) return this.end(run, (stopped as { state: 'cancelled' | 'failed' }).state, { reason: (stopped as { reason: string }).reason }, true);

      const folder = await this.prepare(run, fit.home);
      if (stopped) return this.end(run, (stopped as { state: 'cancelled' | 'failed' }).state, { reason: (stopped as { reason: string }).reason }, true);

      let tail = '';
      const child = this.processes.start(this.asAccount(['/bin/sh', '-c', 'cd "$1" && shift && exec /bin/sh -c "$1"', 'sh', folder, run.command], fit.home), (chunk) => {
        tail = `${tail}${chunk}`.slice(-LOG_TAIL_BYTES);
      });
      signal = (which) => child.signalAll(which);
      if (stopped) void this.kill(signal);
      const code = await child.exited;
      const durationMs = this.now() - started;
      const end = stopped as { reason: string; state: 'cancelled' | 'failed' } | null;
      if (end) return this.end(run, end.state, { exitCode: code, durationMs, logTail: tail, reason: end.reason }, true);
      return this.end(run, code === 0 ? 'passed' : 'failed', { exitCode: code, durationMs, logTail: tail }, true);
    } catch (error) {
      return this.end(run, 'refused', { reason: `the host check could not be run: ${error instanceof Error ? error.message : String(error)}` }, true);
    } finally {
      clearTimeout(limit);
      delete run.stop;
    }
  }

  /** TERM to everything the account runs, then KILL once `killAfterMs` has passed. */
  private async kill(signal: (which: 'TERM' | 'KILL') => Promise<void>): Promise<void> {
    await signal('TERM').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, this.deps.killAfterMs ?? KILL_AFTER_MS));
    await signal('KILL').catch(() => undefined);
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
 * Run as the account, with the bundle on stdin: the folder made once and kept,
 * the bundle written inside it, fetched, the head checked out detached and
 * forced over what a build changed in tracked files, and the bundle removed.
 * Untracked and ignored files stay, so the next build is incremental; the
 * repository's own `host-ci` target decides what a clean build is.
 */
const RECEIVE = [
  'set -e',
  'dir="$1"; head="$2"',
  'mkdir -p "$dir"',
  'cd "$dir"',
  '[ -d .git ] || git init --quiet .',
  'bundle=.git/openadlc-incoming.bundle',
  'cat > "$bundle"',
  'trap \'rm -f "$bundle"\' EXIT',
  "git fetch --quiet \"$bundle\" '+refs/openadlc/host-check/*:refs/openadlc/host-check/*'",
  'git -c advice.detachedHead=false checkout --quiet --force --detach "$head"',
].join('\n');

function view(run: HostCheckRun): HostCheckRun {
  const { stop: _stop, ...rest } = run as Held;
  return { ...rest };
}

/** `HostProcesses` on this machine, with node's `child_process`. */
export function nodeProcesses(spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess = spawnChild): HostProcesses {
  const collect = (child: ChildProcess, timeoutMs: number | undefined): Promise<ProcessResult> =>
    new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = `${stdout}${chunk.toString('utf8')}`.slice(-1_000_000);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString('utf8')}`.slice(-100_000);
      });
      const timer = timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, timeoutMs)
        : null;
      child.on('error', (error) => {
        if (timer) clearTimeout(timer);
        resolve({ code: 127, stdout, stderr: `${stderr}${error.message}`, timedOut });
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr, timedOut });
      });
    });
  return {
    run(argv, options = {}) {
      const [command = '', ...args] = argv;
      const child = spawn(command, args, { env: { ...minimalEnv(), ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] });
      return collect(child, options.timeoutMs);
    },
    async pipe(from, to, timeoutMs) {
      const [fromCommand = '', ...fromArgs] = from.argv;
      const [toCommand = '', ...toArgs] = to.argv;
      const source = spawn(fromCommand, fromArgs, { env: { ...minimalEnv(), ...from.env }, stdio: ['ignore', 'pipe', 'pipe'] });
      const sink = spawn(toCommand, toArgs, { env: minimalEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
      if (source.stdout && sink.stdin) source.stdout.pipe(sink.stdin);
      sink.stdin?.on('error', () => undefined);
      const [made, taken] = await Promise.all([collect(source, timeoutMs), collect(sink, timeoutMs)]);
      return made.code !== 0 ? { ...made, stderr: `the bundle could not be made: ${made.stderr}` } : taken;
    },
    start(argv, onOutput) {
      const [command = '', ...args] = argv;
      // A process group of its own, which hostd may signal: `sudo` keeps
      // hostd's user as its real one. What the command starts runs as the
      // account, so `signalAll` also reaches it as the account.
      const child = spawn(command, args, { env: minimalEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      child.stdout?.on('data', (chunk: Buffer) => onOutput(chunk.toString('utf8')));
      child.stderr?.on('data', (chunk: Buffer) => onOutput(chunk.toString('utf8')));
      const exited = new Promise<number>((resolve) => {
        child.on('error', (error) => {
          onOutput(`\n${error.message}\n`);
          resolve(127);
        });
        child.on('close', (code, signal) => resolve(code ?? (signal ? 128 + 15 : 1)));
      });
      return {
        exited,
        async signalAll(signal) {
          try {
            if (child.pid) process.kill(-child.pid, `SIG${signal}`);
          } catch {
            // Gone already, or not ours to signal.
          }
          const asAccount = argv.slice(0, argv.indexOf('/usr/bin/env'));
          if (asAccount[0] === 'sudo') {
            // Every process the account runs, the build's background ones and
            // any that left the group included: the account runs nothing else.
            await new Promise<void>((resolve) => {
              const killer = spawn(asAccount[0] as string, [...asAccount.slice(1), '/bin/kill', `-${signal}`, '-1'], { env: minimalEnv(), stdio: 'ignore' });
              killer.on('close', () => resolve());
              killer.on('error', () => resolve());
            });
          }
        },
      };
    },
  };
}

/**
 * The environment hostd's own `sudo` and `git` run with: a path and a locale,
 * and nothing of hostd's — no task token, no `GH_TOKEN`, no `DATABASE_URL`.
 * The command itself gets `hostCheckEnv` through `env -i`.
 */
function minimalEnv(): Record<string, string> {
  return { PATH: HOST_CHECK_PATH, LANG: 'en_US.UTF-8' };
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
