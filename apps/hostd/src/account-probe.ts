import { spawn as spawnChild, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Whether an OS account hostd runs something as reaches nothing the install
 * guards, proved by its effect: the one probe behind both the host check's
 * account (`host-check.ts`, docs/adr/0064, docs/adr/0066) and the release
 * account (`release-account.ts`, docs/adr/0068).
 *
 * One function, not a copy per account: #335 and #340 each widened what the
 * host check's probe tries, and a second copy would have missed both. A new
 * reach the install guards goes here once, for every account.
 */

/** A name `useradd` and `sysadminctl` would make, so it is safe as an argument and in `~name`. */
export const ACCOUNT_NAME = /^[a-z_][a-z0-9_-]{0,31}$/i;

/** Where the account finds its tools: the system's, then Homebrew's on Apple silicon and Intel. */
export const HOST_CHECK_PATH = '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin';

/** The variables every command as an account is given; `env -i` clears the rest. */
export function accountEnv(account: string, home: string): Record<string, string> {
  return {
    PATH: HOST_CHECK_PATH,
    HOME: home,
    USER: account,
    LOGNAME: account,
    LANG: 'en_US.UTF-8',
  };
}

export type AccountProblem = 'no_account' | 'not_dedicated' | 'no_sudo' | 'can_read' | 'can_enter' | 'docker' | 'can_sudo';

/** What the probe found: `ok`, or the first thing wrong and what to do about it. */
export type AccountProbe =
  | { ok: true; account: string; uid: number; home: string }
  | { ok: false; account: string; problem: AccountProblem; path?: string; detail: string };

/** What the account must not reach, and who hostd is. */
export interface AccountPlaces {
  /** hostd's own `OPENADLC_HOME`, and its `install.json`. */
  openadlcHome: string;
  /**
   * Where hostd keeps worktrees and mirrors (`OPENADLC_WORK_ROOT`): it can be
   * set outside `OPENADLC_HOME`. Required, like `dockerSockets`, because the
   * probe passes on what it is not given: a caller that left either out would
   * let a work root elsewhere, or a reachable Docker socket, through without a
   * word.
   */
  workRoot: string;
  /** hostd's own home; `homedir()` when absent. */
  hostdHome?: string;
  /** The Docker sockets the account must not connect to; see `dockerSocketsOf`. */
  dockerSockets: string[];
  /** hostd's own uid; the account must not be it. `process.getuid()` when absent. */
  uid?: number;
}

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

/** `argv` as the account, with nothing of hostd's environment but `env`. */
export function asAccount(account: string, env: Record<string, string>, argv: string[]): string[] {
  const vars = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  return ['sudo', '-n', '-u', account, '--', '/usr/bin/env', '-i', ...vars, ...argv];
}

/** The account's home as the machine has it, or `null` when it has none. */
export async function homeOf(account: string, processes: HostProcesses): Promise<string | null> {
  const home = (await processes.run(['/bin/sh', '-c', 'eval "echo ~$1"', 'sh', account])).stdout.trim();
  return !home || home.startsWith('~') ? null : home;
}

/**
 * Whether `account` is fit to run what hostd gives it: it exists, is neither
 * root nor hostd's own user, hostd may run a command as it, and that command
 * cannot read `OPENADLC_HOME`, `install.json`, the work root or hostd's home,
 * nor enter any of those folders, nor connect to a Docker socket; the account
 * is not in the `docker` group, and cannot run `sudo` without a password
 * (#335). `settingName` is the variable a person sets to name another
 * account; `env(home)` is what every command as the account runs with.
 */
export async function probeAccount(
  account: string,
  settingName: string,
  places: AccountPlaces,
  processes: HostProcesses,
  env: (home: string) => Record<string, string>,
): Promise<AccountProbe> {
  const fail = (problem: AccountProblem, detail: string, path?: string): AccountProbe => ({
    ok: false,
    account,
    problem,
    detail,
    ...(path ? { path } : {}),
  });
  if (!ACCOUNT_NAME.test(account)) return fail('no_account', `${account} is not an account name; set ${settingName} to the account you made`);
  const id = await processes.run(['id', '-u', account]);
  const uid = Number.parseInt(id.stdout.trim(), 10);
  if (id.code !== 0 || !Number.isInteger(uid)) return fail('no_account', `there is no account named ${account} on this machine`);
  if (uid === 0) return fail('not_dedicated', `${account} is root, which can read everything; make an account of its own`);
  const own = places.uid ?? process.getuid?.();
  if (own !== undefined && uid === own) return fail('not_dedicated', `${account} is the account hostd runs as, which can read OPENADLC_HOME; make an account of its own`);
  const home = await homeOf(account, processes);
  if (!home) return fail('no_account', `${account} has no home folder to keep its working folders in`);
  const as = (argv: string[]) => asAccount(account, env(home), argv);
  const can = await processes.run(as(['/usr/bin/true']), { timeoutMs: 30_000 });
  if (can.code !== 0) return fail('no_sudo', `hostd cannot run a command as ${account} without a password: ${(can.stderr || can.stdout).trim().slice(0, 200) || `sudo exited ${can.code}`}`);
  const hostdHome = places.hostdHome ?? homedir();
  const folders = [...new Set([places.openadlcHome, places.workRoot, hostdHome])];
  const asIt = (script: string, path: string) => processes.run(as(['/bin/sh', '-c', script, 'sh', path]), { timeoutMs: 30_000 });
  for (const path of [places.openadlcHome, join(places.openadlcHome, 'install.json'), ...folders.slice(1)]) {
    if ((await asIt(READABLE, path)).code === 0) return fail('can_read', `${account} can read ${path}`, path);
  }
  // A folder it cannot list but may pass through, as a home at 0711, still
  // opens every file in it whose name is known — `install.json` is one.
  // `test -x` asks access(2), so an ACL that lets it through counts too.
  for (const path of folders) {
    if ((await asIt(ENTERABLE, path)).code === 0) return fail('can_enter', `${account} can enter ${path} (a file in it whose name it knows can be opened)`, path);
  }
  // The Docker socket is root on the machine: any container, with any of
  // its folders mounted. Connecting to a unix socket takes write on it.
  for (const path of places.dockerSockets) {
    if ((await asIt(CONNECTABLE, path)).code === 0) return fail('docker', `${account} can connect to ${path}, which controls Docker as root`, path);
  }
  // Asked as hostd, of the account's groups: a socket not listed above, as
  // one a group opens on Linux, is reached through the group.
  const groups = await processes.run(['id', '-Gn', account], { timeoutMs: 30_000 });
  if (groups.code === 0 && groups.stdout.trim().split(/\s+/).includes('docker')) return fail('docker', `${account} is in the docker group`);
  // `-l` without a password passes when any rule is NOPASSWD, one limited
  // to a single command included, which `sudo -n true` would miss.
  const sudo = await processes.run(as(['sudo', '-n', '-l']), { timeoutMs: 30_000 });
  if (sudo.code === 0) {
    const listed = sudo.stdout.trim().replace(/\s+/g, ' ').slice(0, 200);
    return fail('can_sudo', `${account} can run sudo without a password${listed ? ` (${listed})` : ''}`);
  }
  return { ok: true, account, uid, home };
}

/** Whether the account can read a path, or list a folder. */
export const READABLE = 'test -r "$1" || ls "$1" >/dev/null 2>&1';
/** Whether the account can pass through a folder. */
export const ENTERABLE = 'test -d "$1" && test -x "$1"';
/** Whether the account can connect to a socket: one there, and writable to it. */
export const CONNECTABLE = '[ -S "$1" ] && [ -w "$1" ]';

/**
 * The Docker sockets on this machine the account must not reach: `DOCKER_HOST`'s
 * when it is a unix socket, the system's, Docker Desktop's and OrbStack's in
 * hostd's home, and rootless Docker's. One that is not there passes. A list
 * rather than `docker context`, which hostd runs without a `HOME`.
 */
export function dockerSocketsOf(env: Record<string, string | undefined>, home: string): string[] {
  const sockets: string[] = [];
  const host = env.DOCKER_HOST ?? '';
  if (host.startsWith('unix://')) sockets.push(host.slice('unix://'.length));
  sockets.push('/var/run/docker.sock', '/run/docker.sock', join(home, '.docker', 'run', 'docker.sock'), join(home, '.orbstack', 'run', 'docker.sock'));
  if (env.XDG_RUNTIME_DIR) sockets.push(join(env.XDG_RUNTIME_DIR, 'docker.sock'));
  return [...new Set(sockets.filter(Boolean))];
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
 * A command as the account gets its own variables through `env -i`.
 */
function minimalEnv(): Record<string, string> {
  return { PATH: HOST_CHECK_PATH, LANG: 'en_US.UTF-8' };
}
