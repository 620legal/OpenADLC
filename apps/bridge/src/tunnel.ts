import { spawn } from 'node:child_process';

/**
 * A public address for a bridge running on somebody's laptop.
 *
 * GitHub delivers webhooks; it cannot reach `127.0.0.1`. That left the operator
 * doing the one genuinely awkward part of setup by hand — find a tunnel, run it
 * in a terminal you must not close, copy the address it printed into a form, and
 * do it again tomorrow because the address changed.
 *
 * OpenADLC runs on the same machine, so it can run the tunnel itself. `cloudflared`
 * needs no account for a quick tunnel and prints the address on stderr; that
 * address is what the app's webhook is then pointed at, so nothing is copied.
 *
 * The address is temporary by nature — a quick tunnel is a new hostname every
 * time — which is a fact about the tool and not a defect to hide. It is why this
 * reports whether a tunnel is *currently* running rather than only what it once
 * was, and why the stored URL is re-written on GitHub each time one starts.
 */

/** cloudflared announces a quick tunnel in a box on stderr. This is the line inside it. */
const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;

export interface TunnelProcess {
  stderr: NodeJS.ReadableStream | null;
  stdout: NodeJS.ReadableStream | null;
  once: (event: string, listener: (...args: unknown[]) => void) => unknown;
  kill: (signal?: NodeJS.Signals) => boolean;
  pid?: number;
}

export type Spawner = (command: string, args: string[]) => TunnelProcess;

const realSpawner: Spawner = (command, args) =>
  spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as TunnelProcess;

export interface OpenTunnel {
  /** The tunnel's public address, without a path; the webhook path is added where GitHub is told. */
  url: string;
  /** Ends the cloudflared process, and with it the address. */
  stop: () => void;
  pid?: number;
  /** Settles with the exit code when cloudflared stops, after it gave its address. */
  ended: Promise<unknown>;
}

export class TunnelError extends Error {}

/**
 * Starts a quick tunnel to a local port and resolves once its address is known.
 *
 * Resolving on the printed address rather than on the process starting is the
 * point: a tunnel whose address nobody knows is no use, and cloudflared exits
 * zero-ish in several situations where it never prints one.
 */
export function openQuickTunnel(options: {
  port: number;
  spawner?: Spawner;
  timeoutMs?: number;
  command?: string;
}): Promise<OpenTunnel> {
  const spawner = options.spawner ?? realSpawner;
  const command = options.command ?? 'cloudflared';
  const timeoutMs = options.timeoutMs ?? 30_000;

  return new Promise<OpenTunnel>((resolve, reject) => {
    let child: TunnelProcess;
    try {
      child = spawner(command, [
        'tunnel',
        '--no-autoupdate',
        '--url',
        `http://127.0.0.1:${options.port}`,
      ]);
    } catch (cause) {
      reject(new TunnelError(describeSpawnFailure(cause)));
      return;
    }

    /** Kept for the error message: cloudflared explains itself on stderr and nowhere else. */
    let output = '';
    let settled = false;
    let markEnded: (code: unknown) => void = () => undefined;
    const ended = new Promise<unknown>((resolve) => {
      markEnded = resolve;
    });

    const finish = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outcome();
    };

    const timer = setTimeout(() => {
      finish(() => {
        child.kill('SIGTERM');
        reject(
          new TunnelError(
            `cloudflared did not report an address within ${Math.round(timeoutMs / 1000)}s. ${lastLine(output)}`,
          ),
        );
      });
    }, timeoutMs);

    const watch = (stream: NodeJS.ReadableStream | null): void => {
      // Still read once the address is known, or cloudflared blocks on a full
      // pipe; but no longer kept, or it grew for as long as the tunnel ran.
      stream?.on('data', (chunk: Buffer) => {
        if (settled) return;
        output += chunk.toString('utf8');
        const found = output.match(QUICK_TUNNEL_URL);
        if (found) {
          finish(() => resolve({ url: found[0], stop: () => child.kill('SIGTERM'), pid: child.pid, ended }));
        }
      });
    };
    watch(child.stderr);
    watch(child.stdout);

    child.once('error', (cause) => {
      finish(() => reject(new TunnelError(describeSpawnFailure(cause))));
    });

    /**
     * `close` rather than `exit`: `exit` can arrive before stderr has drained,
     * and stderr is the only place cloudflared says why it stopped — rejecting
     * on `exit` threw away the reason and reported "it printed nothing".
     *
     * Deferred a turn even so, because the last chunk of stderr may still be
     * queued behind this event. If it carries the address, `finish` has already
     * settled by the time this runs and this does nothing.
     */
    const stopped = (code: unknown): void => {
      markEnded(code);
      setImmediate(() => {
        finish(() =>
          reject(
            new TunnelError(
              `cloudflared stopped before it had an address (exit ${String(code)}). ${lastLine(output)}`,
            ),
          ),
        );
      });
    };
    child.once('close', stopped);
    child.once('exit', stopped);
  });
}

function describeSpawnFailure(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/ENOENT/.test(message)) {
    // The one failure with an obvious remedy, so it names it.
    return "cloudflared is not installed. Install it (macOS: brew install cloudflared; Linux: Cloudflare's cloudflared package for your distribution), or give the bridge a public address instead.";
  }
  return `cloudflared could not be started: ${message}`;
}

/** The most recent thing cloudflared said, which is usually why it stopped. */
function lastLine(output: string): string {
  const lines = output.trim().split('\n').filter(Boolean);
  return lines.length ? lines[lines.length - 1]!.slice(0, 300) : 'It printed nothing.';
}

export interface TunnelState {
  running: boolean;
  url: string;
  /** When it started, so the page can say how long this address has been good for. */
  since: string | null;
  detail: string;
}

/**
 * The single tunnel this process is responsible for.
 *
 * One at a time: a second tunnel to the same port is a second address, and only
 * one of them can be the one GitHub is pointed at. Starting one while another
 * runs replaces it.
 */
export class TunnelKeeper {
  private open: OpenTunnel | null = null;
  private startedAt: Date | null = null;
  /** How the last tunnel ended on its own, for `state()`; null once another starts or it was stopped. */
  private exited: string | null = null;
  /** A start under way, which a second caller joins rather than starting a second cloudflared. */
  private starting: Promise<string> | null = null;

  start(port: number, options: { spawner?: Spawner; timeoutMs?: number } = {}): Promise<string> {
    // Two at once — the start-up raise and a person's Configure — started two
    // cloudflareds, and the first, overwritten here, was never stopped.
    if (this.starting) return this.starting;
    this.starting = (async () => {
      this.stop();
      const opened = await openQuickTunnel({ port, ...options });
      this.open = opened;
      this.startedAt = new Date();
      // Watched after the address too: cloudflared exiting went unnoticed, and
      // the page said a tunnel was serving that GitHub could no longer reach.
      void opened.ended.then((code) => {
        if (this.open !== opened) return;
        this.open = null;
        this.startedAt = null;
        this.exited = `cloudflared stopped (exit ${String(code)}); GitHub cannot deliver until a tunnel is raised again`;
      });
      return opened.url;
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  stop(): void {
    this.open?.stop();
    this.open = null;
    this.startedAt = null;
    this.exited = null;
  }

  state(): TunnelState {
    if (!this.open) {
      return { running: false, url: '', since: null, detail: this.exited ?? 'no tunnel is running' };
    }
    return {
      running: true,
      url: this.open.url,
      since: this.startedAt?.toISOString() ?? null,
      detail: `cloudflared is serving ${this.open.url}`,
    };
  }
}
