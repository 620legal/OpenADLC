import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, fstatSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';

/**
 * Keeps one of OpenADLC's services running.
 *
 * `fleetadlc up` started each service and walked away, so a service that died
 * stayed dead. The console went offline overnight with nothing in its log —
 * the process had simply gone — and the first anybody knew was a page that
 * would not load. Each service now runs under a keeper: when it ends without
 * being asked to, the keeper writes how it ended, the exit code or the signal
 * that stopped it, and starts it again, waiting longer each time.
 *
 * A service that dies straight away, again and again, will not be fixed by
 * starting it: the keeper gives up and exits, so `fleetadlc up` and `fleetadlc doctor`
 * see it down rather than a loop that looks alive.
 *
 * `fleetadlc down` signals the whole process group, the service included. The
 * keeper hears it too and stops starting anything; it passes the signal on
 * only if the service is still there a while later, which is the case where
 * somebody signalled the keeper alone. Passing it on at once would have given
 * every service two shutdowns at the same time.
 */

export interface KeepOptions {
  /** What the log calls it: `console`, `bridge`. */
  name: string;
  command: string[];
  /** The first wait before starting it again, doubled each time up to `maxDelayMs`. */
  delayMs?: number;
  maxDelayMs?: number;
  /** A run shorter than this counts as dying straight away. */
  quickMs?: number;
  /** How many of those in a row before the keeper gives up. */
  quickLimit?: number;
  /** How long a stop waits for the service to go on its own before passing the signal on. */
  forwardAfterMs?: number;
  log?: (line: string) => void;
  spawnChild?: (command: string[]) => ChildProcess;
  /** Where the service's output goes; without it, the keeper's own stdout and stderr. */
  output?: (chunk: Buffer | string) => void;
}

export interface Keeper {
  /** Stops it for good: nothing is started again. */
  stop(signal?: NodeJS.Signals): void;
  /** What the keeper exits with: 0 when it was stopped, 1 when it gave up. */
  done: Promise<number>;
}

/** Settles once these streams have all been read to the end, or after two seconds. */
function readToEnd(streams: NodeJS.ReadableStream[]): Promise<void> {
  return new Promise<void>((resolve) => {
    let open = streams.length;
    const timer = setTimeout(resolve, 2000);
    timer.unref();
    for (const stream of streams) {
      stream.once('close', () => {
        open -= 1;
        if (open > 0) return;
        clearTimeout(timer);
        resolve();
      });
    }
  });
}

/** Rotate a service's log past this size. */
export const LOG_LIMIT_BYTES = 20 * 1024 * 1024;

/**
 * A service's log that keeps itself to about twice `limit`: past it, the file
 * becomes `<path>.1`, replacing the one before, and a new one is started.
 *
 * Every service appended to `run/<name>.log` for as long as it ran, and a
 * service can run for months between restarts, so rotating at `fleetadlc up`
 * would not have been enough; a long-running install filled its disk. Writes
 * are synchronous, so nothing is lost when the keeper exits straight after.
 */
export function rotatingLog(path: string, limit = LOG_LIMIT_BYTES): (chunk: Buffer | string) => void {
  let fd = openSync(path, 'a', 0o600);
  let size = fstatSync(fd).size;
  return (chunk) => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    if (size > 0 && size + bytes.length > limit) {
      closeSync(fd);
      renameSync(path, `${path}.1`);
      fd = openSync(path, 'a', 0o600);
      size = 0;
    }
    writeSync(fd, bytes);
    size += bytes.length;
  };
}

function seconds(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`;
}

export function keepRunning(options: KeepOptions): Keeper {
  const log = options.log ?? ((line: string) => console.log(line));
  const delayMs = options.delayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const quickMs = options.quickMs ?? 10_000;
  const quickLimit = options.quickLimit ?? 5;
  const forwardAfterMs = options.forwardAfterMs ?? 8000;
  const output = options.output;
  const spawnChild =
    options.spawnChild ??
    ((command: string[]) => {
      if (!output) return spawn(command[0] as string, command.slice(1), { stdio: 'inherit', env: process.env });
      const child = spawn(command[0] as string, command.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
      child.stdout?.on('data', output);
      child.stderr?.on('data', output);
      return child;
    });

  let stopping = false;
  let child: ChildProcess | null = null;
  let restart: NodeJS.Timeout | null = null;
  let wait = delayMs;
  let quick = 0;
  let finish: (code: number) => void = () => undefined;
  const done = new Promise<number>((resolve) => {
    finish = resolve;
  });

  const start = (): void => {
    restart = null;
    if (stopping) {
      finish(0);
      return;
    }
    const startedAt = Date.now();
    const running = spawnChild(options.command);
    child = running;
    let ended = false;
    const onEnd = (how: string): void => {
      if (ended) return;
      ended = true;
      child = null;
      if (stopping) {
        finish(0);
        return;
      }
      const ran = Date.now() - startedAt;
      if (ran < quickMs) {
        quick += 1;
      } else {
        quick = 0;
        wait = delayMs;
      }
      if (quick >= quickLimit) {
        log(
          `[fleetadlc] ${options.name} ${how} ${quick} times in a row, each within ${seconds(quickMs)} of starting; ` +
            'not starting it again. Run `fleetadlc up` once whatever stops it is fixed.',
        );
        finish(1);
        return;
      }
      log(`[fleetadlc] ${options.name} ${how} after ${seconds(ran)}; starting it again in ${seconds(wait)}`);
      restart = setTimeout(start, wait);
      wait = Math.min(wait * 2, maxDelayMs);
    };
    running.once('exit', (code, signal) => {
      const how = signal ? `was stopped by ${signal}` : `exited with code ${code}`;
      // Piped output can still be on its way when the exit is heard, and a
      // crash's last lines are the ones worth having.
      const piped = [running.stdout, running.stderr].flatMap((stream) => (stream && !stream.destroyed ? [stream] : []));
      if (piped.length === 0) onEnd(how);
      else void readToEnd(piped).then(() => onEnd(how));
    });
    running.once('error', (error) => onEnd(`could not be started (${error.message})`));
  };

  const stop = (signal: NodeJS.Signals = 'SIGTERM'): void => {
    if (stopping) return;
    stopping = true;
    if (restart) {
      clearTimeout(restart);
      restart = null;
    }
    const running = child;
    if (!running) {
      finish(0);
      return;
    }
    setTimeout(() => {
      if (child === running) running.kill(signal);
    }, forwardAfterMs).unref();
  };

  start();
  return { stop, done };
}

/** Where `startService` tells the keeper its pid file is. */
export const KEEPER_PID_FILE = 'FLEETADLC_KEEPER_PID_FILE';

/**
 * Removes the keeper's pid file when it still names this keeper. A keeper that
 * gave up, or died with the machine, left its pid behind, and a later program
 * given that number was taken for the service. A newer `up` may have written
 * its own keeper's pid there since; that one is left alone.
 */
export function removeOwnPidFile(path: string, pid: number): void {
  try {
    if (readFileSync(path, 'utf8').trim() === String(pid)) rmSync(path, { force: true });
  } catch {
    // Already gone.
  }
}

/** `node keep.js <name> [--log <path>] -- <command…>`, as `startService` runs every service. */
export async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  const logPath = rest[0] === '--log' ? rest[1] : undefined;
  const [separator, ...command] = logPath === undefined ? rest : rest.slice(2);
  if (!name || separator !== '--' || command.length === 0) {
    console.error('usage: keep.js <name> [--log <path>] -- <command…>');
    return 2;
  }
  // Read, then taken out of the environment the service inherits.
  const pidFile = process.env[KEEPER_PID_FILE];
  delete process.env[KEEPER_PID_FILE];
  const output = logPath ? rotatingLog(logPath) : undefined;
  const keeper = keepRunning({ name, command, ...(output ? { output, log: (line: string) => output(`${line}\n`) } : {}) });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => keeper.stop(signal));
  const code = await keeper.done;
  if (pidFile) removeOwnPidFile(pidFile, process.pid);
  return code;
}

