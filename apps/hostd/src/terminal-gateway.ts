import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { audit } from '@fleetadlc/db';
import type { ExecDriver } from './drivers/types.js';

/**
 * How the browser presents an attach token.
 *
 * Not a query parameter: the request line is what a proxy writes to its access
 * log, and this token is a shell. A subprotocol is a header. The characters are
 * a token as the WebSocket spec defines one, which base64url is.
 */
export const ATTACH_SUBPROTOCOL_PREFIX = 'fleetadlc-attach.';

export interface AttachGrant {
  bot: string;
  session: string;
  identity: string;
  expiresAt: number;
}

interface Frame {
  type: 'input' | 'resize' | 'detach';
  data?: string;
  cols?: number;
  rows?: number;
}

/** What a pty opens at when the client has not said how big it is. */
export const DEFAULT_TERMINAL_SIZE = { cols: 120, rows: 32 } as const;

/**
 * How long the gateway waits for the client's first frame before opening the
 * pty at the default size. The console sends its size as that frame, the moment
 * the socket opens, so this bounds a client that never does; it is not a delay
 * the console's attach sits through.
 */
export const FIRST_FRAME_WAIT_MS = 1000;

/** The frame a message carries, or null for anything that is not one. */
function parseFrame(text: string): Frame | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' ? (value as Frame) : null;
  } catch {
    return null;
  }
}

/**
 * The size a resize frame asks for, or null if it does not ask for one a pty
 * can take. Bounded, because the numbers come from a browser.
 */
function requestedSize(frame: Frame | null): { cols: number; rows: number } | null {
  if (frame?.type !== 'resize') return null;
  const { cols, rows } = frame;
  if (typeof cols !== 'number' || typeof rows !== 'number') return null;
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return null;
  if (cols < 1 || rows < 1 || cols > 1000 || rows > 1000) return null;
  return { cols, rows };
}

/**
 * Take-over is a `tmux attach` inside the bot's own computer, bridged to the
 * browser over a WebSocket. A person gets the keyboard; detaching leaves the
 * session running, because detaching a tmux client never kills what it was
 * attached to. Every attach and detach is written to the audit log with the
 * identity that did it.
 *
 * The gateway holds no authority of its own: it only redeems a short-lived
 * attach token that hostd minted for one bot and one session.
 *
 * The token arrives as the subprotocol `fleetadlc-attach.<token>`. A value in the
 * query string is ignored, and ignoring it does not redeem it: a proxy that
 * logged the old URL must not be handed a working shell, and a probe must not
 * burn the operator's token.
 */
export class TerminalGateway {
  /** What each accepted handshake redeemed, from `verifyClient` to the socket. */
  private readonly grants = new WeakMap<IncomingMessage, AttachGrant>();
  private readonly sockets = new WebSocketServer({
    noServer: true,
    // ws calls this after it has checked the handshake is well formed, so a
    // request it would refuse anyway never gets as far as spending a token.
    // Refusing here is a 401: an expired token is the common case, and a person
    // should not have to read a log to find that out.
    verifyClient: ({ req }: { req: IncomingMessage }) => {
      const token = tokenFromSubprotocol(req.headers['sec-websocket-protocol']);
      const grant = token ? this.redeem(token) : null;
      if (!grant) return false;
      this.grants.set(req, grant);
      return true;
    },
    // The same choice the token was read with, so the protocol echoed back is
    // the one that was redeemed.
    handleProtocols: (protocols) => attachProtocol(protocols) ?? false,
    // Frames are keystrokes and resizes. ws's default of 100 MiB let a client
    // make hostd buffer that much for one message; a larger one closes its
    // socket with 1009.
    maxPayload: 1024 * 1024,
  });
  private readonly allowedOrigins: readonly string[];

  private readonly firstFrameWaitMs: number;

  constructor(
    private readonly driver: ExecDriver,
    private readonly redeem: (token: string) => AttachGrant | null,
    allowedOrigins?: readonly string[],
    options: { firstFrameWaitMs?: number } = {},
  ) {
    this.allowedOrigins = allowedOrigins ?? configuredConsoleOrigins();
    this.firstFrameWaitMs = options.firstFrameWaitMs ?? FIRST_FRAME_WAIT_MS;
  }

  /** Wires `/terminal` on an existing HTTP server. */
  attachTo(server: Server): void {
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      // This listener is synchronous, so anything it throws is an uncaught
      // exception and hostd exits. It also runs ahead of every authentication
      // check, which made a malformed Host header an unauthenticated way to
      // stop the runner. The base is a constant and the parse is guarded.
      let url: URL;
      try {
        url = new URL(request.url ?? '/', 'http://fleetadlc.invalid');
      } catch {
        socket.destroy();
        return;
      }

      if (url.pathname !== '/terminal') {
        socket.destroy();
        return;
      }

      // Before the token is redeemed, so a page on another origin cannot spend
      // a token it does not get to use. A browser cannot omit Origin. A client
      // that sends none is not a browser and still has to present the token.
      const origin = singleHeader(request.headers.origin);
      if (
        origin === REJECT_HEADER ||
        !upgradeOriginAllowed(typeof origin === 'string' ? origin : undefined, this.allowedOrigins)
      ) {
        refuseUpgrade(socket);
        return;
      }

      this.sockets.handleUpgrade(request, socket, head, (ws) => {
        const grant = this.grants.get(request);
        this.grants.delete(request);
        if (!grant) {
          // Not reached: ws calls this only after `verifyClient` accepted.
          ws.terminate();
          return;
        }
        // Nothing `serve` throws may reach the process: hostd has no
        // unhandledRejection handler, and under Node 22 a rejection here ended
        // hostd and every task it supervises.
        void this.serve(ws, grant).catch((error: unknown) => {
          console.error('[hostd] terminal attach failed:', error instanceof Error ? error.message : error);
          ws.close(1011);
        });
      });
    });
  }

  private async serve(ws: WebSocket, grant: AttachGrant): Promise<void> {
    const { bot, session, identity } = grant;

    // Before anything is awaited. ws reports a frame it rejects (invalid
    // UTF-8, a reserved opcode, one over maxPayload) as an 'error' on the
    // socket, and an 'error' nobody listens for is an uncaught exception: one
    // bad frame ended hostd and every task on the host. ws closes the socket
    // itself after it, and the close handlers below kill the attach.
    ws.on('error', (error) => {
      console.warn(`[hostd] terminal socket error on ${bot}/${session}: ${error.message}`);
    });

    // Listening starts before anything is awaited. ws emits a message whether or
    // not anything listens for it, and the console sends its size the moment
    // the socket opens, so a frame that arrives while the pty is being opened
    // is held here rather than lost.
    const held: string[] = [];
    let deliver: ((text: string) => void) | null = null;
    let left = false;
    const firstFrame = new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), this.firstFrameWaitMs);
      ws.on('message', (raw) => {
        const text = raw.toString();
        if (deliver) return deliver(text);
        held.push(text);
        clearTimeout(timer);
        resolve(text);
      });
      ws.once('close', () => {
        left = true;
        clearTimeout(timer);
        resolve(null);
      });
    });

    // The pty opens at the size the client says it is. Opened at a fixed size
    // and resized a beat later, tmux painted the pane at 120x32 into a smaller
    // xterm and then redrew it at the real size — a visible reflow on every
    // attach. A client whose first frame is not a size, or that says nothing in
    // time, gets the default and can resize later, as before.
    const first = await firstFrame;
    if (left) return;
    const asked = first === null ? null : requestedSize(parseFrame(first));
    if (asked) held.shift();
    const size = asked ?? DEFAULT_TERMINAL_SIZE;

    let pty: import('node-pty').IPty;
    try {
      const nodePty = await import('node-pty');
      const [command, ...args] = this.driver.attachCommand(bot, session);
      if (!command) throw new Error('the driver gave no attach command');

      pty = nodePty.spawn(command, args, {
        name: 'xterm-256color',
        cols: size.cols,
        rows: size.rows,
        env: { ...process.env, TERM: 'xterm-256color' },
      });
    } catch (error) {
      ws.send(
        `\r\n\u001b[31mcould not attach: ${error instanceof Error ? error.message : String(error)}\u001b[0m\r\n`,
      );
      ws.close();
      return;
    }

    // Subscribed the moment it is spawned. node-pty gives output only to the
    // listeners there at the time, and tmux paints its whole first screen
    // within milliseconds, so listening after the attach row was written lost
    // that screen: a blank terminal until the pane changed, and an exit before
    // then left the socket open and silent. Until the row is written, output
    // and an exit are held, and sent in order after it.
    const early: string[] = [];
    let exited = null as number | null;
    let live = false;
    // Set the moment the attach client exits. ws waits up to 30 s for the
    // browser's close frame and still delivers what arrives meanwhile, and a
    // resize on the exited pty threw EBADF.
    let gone = false;
    const detached = (exitCode: number): void => {
      if (ws.readyState === ws.OPEN) {
        ws.send(`\r\n\u001b[90mdetached (${exitCode})\u001b[0m\r\n`);
        ws.close();
      }
    };
    pty.onData((chunk) => {
      if (!live) early.push(chunk);
      else if (ws.readyState === ws.OPEN) ws.send(chunk);
    });
    pty.onExit(({ exitCode }) => {
      gone = true;
      if (!live) exited = exitCode;
      else detached(exitCode);
    });

    // The attach client goes with the socket, whenever the socket goes: a
    // browser that left while the attach row was being written left `tmux
    // attach` running, because this was registered only after that write.
    let recorded = false;
    const recordDetach = (): void => {
      void audit({
        actor: identity,
        action: 'terminal.detach',
        target: `${bot}/${session}`,
      }).catch((error: unknown) => {
        console.warn('[hostd] terminal detach not recorded:', error instanceof Error ? error.message : error);
      });
    };
    ws.on('close', () => {
      // Killing the attach client leaves the tmux session, and the task, alive.
      try {
        pty.kill();
      } catch {
        // already gone
      }
      if (recorded) recordDetach();
    });

    // Audited before anyone sees the session: an attach whose row cannot be
    // written is refused rather than let through unrecorded. Unhandled, a
    // database restarting at that moment took hostd down.
    try {
      await audit({
        actor: identity,
        action: 'terminal.attach',
        target: `${bot}/${session}`,
        payload: { via: 'gateway' },
      });
    } catch (error) {
      console.warn('[hostd] terminal attach not recorded:', error instanceof Error ? error.message : error);
      if (ws.readyState === ws.OPEN) {
        ws.send('\r\n\u001b[31mcould not attach: the attach could not be recorded; try again in a moment\u001b[0m\r\n');
      }
      ws.close(1011);
      try {
        pty.kill();
      } catch {
        // already gone
      }
      return;
    }
    recorded = true;
    // A client that left during the write: its close already killed the pty,
    // and the detach is recorded now that the attach is.
    if (left) {
      recordDetach();
      return;
    }

    live = true;
    for (const chunk of early.splice(0)) if (ws.readyState === ws.OPEN) ws.send(chunk);
    if (exited !== null) {
      detached(exited);
      return;
    }

    const handle = (text: string): void => {
      const frame = parseFrame(text);
      if (!frame) {
        // Anything that is not a frame is treated as keystrokes.
        pty.write(text);
        return;
      }

      switch (frame.type) {
        case 'input':
          // A frame is any JSON object. node-pty throws on data that is not
          // a string, and from a socket's listener that took hostd down.
          if (typeof frame.data === 'string' && frame.data.length > 0) pty.write(frame.data);
          break;
        case 'resize': {
          const size = requestedSize(frame);
          if (size) pty.resize(size.cols, size.rows);
          break;
        }
        case 'detach':
          // ctrl-b d: tmux's own detach, so the session keeps running.
          pty.write('\u0002d');
          break;
        default:
          break;
      }
    };
    // A frame that still throws is dropped, and nothing else: thrown out of
    // ws's listener, it was an uncaught exception, and hostd exited with every
    // task on the host.
    deliver = (text) => {
      if (gone) return;
      try {
        handle(text);
      } catch (error) {
        console.warn(`[hostd] terminal frame dropped on ${bot}/${session}: ${error instanceof Error ? error.message : error}`);
      }
    };
    // Whatever arrived while the pty was opening, in the order it was sent.
    for (const text of held.splice(0)) deliver(text);
  }
}

const REJECT_HEADER = Symbol('reject-header');

function singleHeader(value: string | string[] | undefined): string | typeof REJECT_HEADER | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.length === 1 ? value[0] : REJECT_HEADER;
  return value;
}

function refuseUpgrade(socket: Duplex): void {
  socket.write(`HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/**
 * The first offered subprotocol that carries a well-formed attach token, or
 * null. The token redeemed and the protocol echoed are both this one.
 */
export function attachProtocol(offered: Iterable<string>): string | null {
  for (const part of offered) {
    const protocol = part.trim();
    if (!protocol.startsWith(ATTACH_SUBPROTOCOL_PREFIX)) continue;
    if (/^[A-Za-z0-9_-]+$/.test(protocol.slice(ATTACH_SUBPROTOCOL_PREFIX.length))) return protocol;
  }
  return null;
}

/**
 * The token from `Sec-WebSocket-Protocol`, or null when the client did not
 * offer one. The query string is not consulted.
 */
export function tokenFromSubprotocol(header: string | string[] | undefined): string | null {
  if (!header || Array.isArray(header)) return null;
  const protocol = attachProtocol(header.split(','));
  return protocol ? protocol.slice(ATTACH_SUBPROTOCOL_PREFIX.length) : null;
}

/**
 * Origins the console is served from. Same rule as the bridge: a loopback
 * install is opened under more than one name, and those names of the same port
 * are the console. Kept beside the bridge's copy on purpose — the two
 * processes do not share a module, and a test checks they still agree.
 */
export function consoleOrigins(consoleUrl: string): string[] {
  let url: URL;
  try {
    url = new URL(consoleUrl);
  } catch {
    return [];
  }
  const origins = new Set<string>([url.origin]);
  const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (loopback.has(url.hostname)) {
    for (const host of loopback) {
      if (host === url.hostname) continue;
      const alias = new URL(url.origin);
      alias.hostname = host;
      origins.add(alias.origin);
    }
  }
  return [...origins];
}

/** The console this process was configured with. An unparseable URL allows no browser. */
export function configuredConsoleOrigins(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const configured = env.FLEETADLC_CONSOLE_URL;
  const port = env.FLEETADLC_CONSOLE_PORT && env.FLEETADLC_CONSOLE_PORT.length > 0 ? env.FLEETADLC_CONSOLE_PORT : '47300';
  const url = configured && configured.length > 0 ? configured : `http://127.0.0.1:${port}`;
  return consoleOrigins(url);
}

/**
 * Whether this upgrade's `Origin` may attach.
 *
 * Missing means the caller is not a browser: `tests/terminal.mjs` and any
 * other non-browser client. `null` is an opaque origin, a sandboxed frame, and
 * is not the console. An origin on the allowlist is the console, including the
 * other loopback names of its port. Nothing else is.
 *
 * The `Host` header is not consulted. An origin that matches the host the
 * socket was reached on proves nothing: a name someone else controls can be
 * rebound to this machine, and then their page and this socket share a host. A
 * console served under a name of its own — a cloud domain, a LAN address, a
 * tunnel — is admitted by setting `FLEETADLC_CONSOLE_URL` for hostd.
 */
export function upgradeOriginAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  if (origin === undefined || origin.trim() === '') return true;
  const value = origin.trim();
  if (value === 'null') return false;
  return allowed.includes(value);
}
