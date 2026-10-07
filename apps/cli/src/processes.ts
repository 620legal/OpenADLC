import { execFileSync, spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeDir } from './install.js';
import { KEEPER_PID_FILE } from './keep-running.js';

export interface ServiceSpec {
  name: string;
  command: string[];
  cwd: string;
  env: Record<string, string>;
  /** Polled until it answers, so `fleetadlc up` only reports what is really running. */
  health?: string;
}

function pidFile(name: string): string {
  return join(runtimeDir(), `${name}.pid`);
}

export function logFile(name: string): string {
  return join(runtimeDir(), `${name}.log`);
}

export function readPid(name: string): number | null {
  const path = pidFile(name);
  if (!existsSync(path)) return null;
  const pid = Number(readFileSync(path, 'utf8').trim());
  return isProcessId(pid) ? pid : null;
}

// `kill(-1, …)` signals every process this user owns, and 0 or 1 are never a
// keeper; a pid file holding one is as good as empty.
function isProcessId(pid: number | null): pid is number {
  return pid !== null && Number.isInteger(pid) && pid > 1;
}

export function isRunning(pid: number | null): boolean {
  if (!isProcessId(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The keeper every service runs under, which starts it again if it dies; see `keep-running.ts`. */
const KEEPER = join(dirname(fileURLToPath(import.meta.url)), 'keep.js');

export function startService(spec: ServiceSpec): number {
  // The keeper writes the service's output itself, rotating the log as it
  // grows; this is for anything the keeper says should it fail on its own.
  const out = openSync(logFile(spec.name), 'a', 0o600);
  const [binary] = spec.command;
  if (!binary) throw new Error(`service ${spec.name} has no command`);

  // The keeper leads the group, with the service inside it: `stopService`
  // signals the group and both hear it.
  const child = spawn(process.execPath, [KEEPER, spec.name, '--log', logFile(spec.name), '--', ...spec.command], {
    cwd: spec.cwd,
    // The keeper removes its pid file when it exits, so a file left behind is rare.
    env: { ...process.env, ...spec.env, [KEEPER_PID_FILE]: pidFile(spec.name) },
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();

  if (!child.pid) throw new Error(`could not start ${spec.name}`);
  writeFileSync(pidFile(spec.name), String(child.pid));
  return child.pid;
}

/**
 * Signals the whole process group. `startService` spawns detached, which makes
 * the child a group leader, so the negative pid reaches what it started too.
 * That matters for the console: it runs Next through a shell, and killing only
 * the shell leaves the server holding the port — after which `fleetadlc up` refuses
 * to start, correctly, and `fleetadlc down` has lied about stopping it.
 */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // No group (or already gone): fall back to the process itself.
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isRunning(pid);
}

/**
 * Whether a pid is this service's keeper, by its command line. A pid file
 * outlives a reboot, and the number can be some other program's by then;
 * signalling its group would stop that program instead. Null when `ps` cannot
 * say, which is left to the pid file as before.
 */
export function isKeeperOf(name: string, pid: number, commandLine: (pid: number) => string | null = psCommand): boolean | null {
  const line = commandLine(pid);
  if (line === null) return null;
  return line.includes(`keep.js ${name} `);
}

function psCommand(pid: number): string | null {
  try {
    return execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) {
    // ps exits 1 when there is no such process: then it is nobody's keeper.
    return (error as { status?: number }).status === 1 ? '' : null;
  }
}

/**
 * The pid of this service's keeper, or null when the pid file is missing,
 * names a process that is gone, or names one that is not the keeper. `up` used
 * to say "already running" for a stale pid some other program had taken, and
 * start nothing.
 */
export function keeperPid(name: string, commandLine?: (pid: number) => string | null): number | null {
  const pid = readPid(name);
  if (!isRunning(pid)) return null;
  return isKeeperOf(name, pid as number, commandLine) === false ? null : pid;
}

export type StopOutcome = 'stopped' | 'not-running' | 'still-running';

/**
 * Stops a service and waits to find out whether it worked. Reporting "stopped"
 * on the strength of having sent a signal is how an install ends up half up.
 * A pid file whose process is gone, or is not this service's keeper, is
 * removed and reported as not running: `down` used to call that "would not stop".
 */
/**
 * How long a service has between SIGTERM and SIGKILL. Five seconds was
 * everyone's, and hostd stops each running task in it — kills its session,
 * harvests its branch into the mirror, drops its database, removes its
 * container — so with more than a task or two it was killed mid-drain: the
 * rest kept running unsupervised, and a git killed inside `update-ref` left a
 * lock that broke every fetch of that repository. The bridge drains its
 * database pool. The keeper forwards a second signal after 8 s, which both
 * shut down once (their `main.ts`).
 */
const STOP_GRACE_MS: Readonly<Record<string, number>> = { hostd: 60_000, bridge: 20_000 };

export function stopGraceMs(name: string): number {
  return STOP_GRACE_MS[name] ?? 5000;
}

export async function stopService(
  name: string,
  commandLine?: (pid: number) => string | null,
  graceMs: number = stopGraceMs(name),
): Promise<StopOutcome> {
  const pid = keeperPid(name, commandLine);
  if (pid === null) {
    rmSync(pidFile(name), { force: true });
    return 'not-running';
  }

  signalGroup(pid, 'SIGTERM');

  if (!(await waitForExit(pid, graceMs))) {
    signalGroup(pid, 'SIGKILL');
    await waitForExit(pid, 2000);
  }

  if (isRunning(pid)) return 'still-running';
  rmSync(pidFile(name), { force: true });
  return 'stopped';
}

/**
 * Polls until the service answers. Each attempt has a timeout and the whole a
 * deadline: a service that took the connection and never answered used to hold
 * `fleetadlc up` for undici's five minutes an attempt, hours in all. Ten seconds,
 * not two, because the console's `/` renders the whole board and a slow first
 * render is not a service that is down.
 */
export async function waitForHealth(
  url: string,
  attempts = 40,
  delayMs = 500,
  options: { timeoutMs?: number; deadlineMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadline = Date.now() + (options.deadlineMs ?? 90_000);
  for (let attempt = 0; attempt < attempts && Date.now() < deadline; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(timeoutMs, Math.max(1, deadline - Date.now()))) });
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}
