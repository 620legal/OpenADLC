import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { audit } from '@fleetadlc/db';
import { ATTACH_SUBPROTOCOL_PREFIX, DEFAULT_TERMINAL_SIZE, TerminalGateway } from './terminal-gateway.js';

// The gateway writes an audit row once the pty is open. Nothing here has a database.
vi.mock('@fleetadlc/db', () => ({
  audit: vi.fn(async () => undefined),
}));

interface Spawned {
  cols: number;
  rows: number;
  written: string[];
  resized: [number, number][];
  killed: number;
  /** Output, delivered as node-pty does: only to the listeners there at the time. */
  emit(chunk: string): void;
  exit(exitCode: number): void;
}

// `tmux attach` gets a pty that records what it was opened at and what it was
// sent, because a real tmux reports its size only through timing a test cannot
// rely on. Anything else is a real pty, for the one test that reads the size
// back from inside.
const pty = vi.hoisted(() => ({
  spawned: [] as Spawned[],
  /** What the attach does the moment it is opened, before anything awaited after the spawn. */
  onSpawn: null as ((spawned: Spawned) => void) | null,
  /** What `resize` throws, as node-pty's does on a pty whose fd is gone. */
  resizeThrows: null as string | null,
}));
vi.mock('node-pty', async () => {
  const actual = await vi.importActual<typeof import('node-pty')>('node-pty');
  return {
    spawn: (command: string, args: string[], options: import('node-pty').IPtyForkOptions) => {
      if (command !== 'tmux') return actual.spawn(command, args, options);
      const onData: ((chunk: string) => void)[] = [];
      const onExit: ((event: { exitCode: number }) => void)[] = [];
      const record: Spawned = {
        cols: options.cols ?? 0,
        rows: options.rows ?? 0,
        written: [],
        resized: [],
        killed: 0,
        emit: (chunk) => onData.forEach((listener) => listener(chunk)),
        exit: (exitCode) => onExit.forEach((listener) => listener({ exitCode })),
      };
      pty.spawned.push(record);
      // tmux paints its first screen within milliseconds of the attach.
      const onSpawn = pty.onSpawn;
      if (onSpawn) queueMicrotask(() => onSpawn(record));
      return {
        onData: (listener: (chunk: string) => void) => (onData.push(listener), { dispose: () => undefined }),
        onExit: (listener: (event: { exitCode: number }) => void) => (onExit.push(listener), { dispose: () => undefined }),
        // As node-pty's own: anything but a string throws.
        write: (data: unknown) => {
          if (typeof data !== 'string') throw new TypeError(`The "chunk" argument must be of type string. Received type ${typeof data}`);
          if (data === 'throw') throw new Error('the pty is gone');
          record.written.push(data);
        },
        resize: (cols: number, rows: number) => {
          if (pty.resizeThrows) throw new Error(pty.resizeThrows);
          record.resized.push([cols, rows]);
        },
        kill: () => {
          record.killed += 1;
        },
      };
    },
  };
});

const TOKEN = 'attach-token';
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
  pty.spawned.length = 0;
  pty.onSpawn = null;
  pty.resizeThrows = null;
  vi.mocked(audit).mockReset().mockImplementation(async () => undefined);
});

async function startGateway(firstFrameWaitMs: number, command = ['tmux', 'attach']): Promise<number> {
  const server = createServer();
  const gateway = new TerminalGateway(
    { attachCommand: () => command } as never,
    (token) => (token === TOKEN ? { bot: 'atlas', session: 'shell', identity: 'operator', expiresAt: Infinity } : null),
    [],
    { firstFrameWaitMs },
  );
  gateway.attachTo(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
}

/** Opens a socket and sends `frames` the moment it opens, as the console does. */
async function attach(port: number, frames: string[]): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal`, [`${ATTACH_SUBPROTOCOL_PREFIX}${TOKEN}`]);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => {
      for (const frame of frames) ws.send(frame);
      resolve();
    });
    ws.once('error', reject);
  });
  closers.push(async () => {
    ws.terminate();
  });
  return ws;
}

const resize = (cols: unknown, rows: unknown): string => JSON.stringify({ type: 'resize', cols, rows });
const input = (data: string): string => JSON.stringify({ type: 'input', data });

async function opened(within = 2000): Promise<Spawned> {
  await vi.waitFor(() => expect(pty.spawned).toHaveLength(1), { timeout: within, interval: 5 });
  return pty.spawned[0]!;
}

describe('the size a take-over opens at', () => {
  it('is the size the client sends first, not a default it is resized from', async () => {
    const port = await startGateway(5_000);
    await attach(port, [resize(69, 19)]);
    const spawned = await opened();
    expect([spawned.cols, spawned.rows]).toEqual([69, 19]);
    // Already that size, so there is no second paint to cause.
    expect(spawned.resized).toEqual([]);
  });

  it('is what a program in the pty sees from its first line', async () => {
    const port = await startGateway(5_000, ['/bin/sh', '-c', 'stty size']);
    const ws = await attach(port, [resize(69, 19)]);
    let printed = '';
    ws.on('message', (chunk) => (printed += chunk.toString()));
    await new Promise((resolve) => ws.once('close', resolve));
    // `rows cols`. Opened at the default and resized after, this said `32 120`.
    expect(printed).toMatch(/^19 69\r?\n/);
  });

  it('is the default for a client that says nothing in time', async () => {
    const port = await startGateway(50);
    await attach(port, []);
    const spawned = await opened();
    expect([spawned.cols, spawned.rows]).toEqual([DEFAULT_TERMINAL_SIZE.cols, DEFAULT_TERMINAL_SIZE.rows]);
  });

  it('does not wait on a client whose first frame is keystrokes, and keeps them', async () => {
    // The wait is far longer than the test's own bound, so a gateway that sat
    // it out would fail here rather than pass slowly.
    const port = await startGateway(60_000);
    await attach(port, [input('ls\r')]);
    const spawned = await opened(1000);
    expect([spawned.cols, spawned.rows]).toEqual([DEFAULT_TERMINAL_SIZE.cols, DEFAULT_TERMINAL_SIZE.rows]);
    await vi.waitFor(() => expect(spawned.written).toEqual(['ls\r']));
  });

  it('keeps what was typed while the pty was opening, in order', async () => {
    const port = await startGateway(5_000);
    await attach(port, [resize(100, 30), input('echo one\r'), resize(90, 25), input('echo two\r')]);
    const spawned = await opened();
    expect([spawned.cols, spawned.rows]).toEqual([100, 30]);
    await vi.waitFor(() => expect(spawned.written).toEqual(['echo one\r', 'echo two\r']));
    expect(spawned.resized).toEqual([[90, 25]]);
  });

  it('ignores a size a pty cannot take', async () => {
    for (const [cols, rows] of [
      [0, 20],
      [80.5, 24],
      [100_000, 24],
      ['80', '24'],
    ]) {
      const port = await startGateway(5_000);
      await attach(port, [resize(cols, rows)]);
      const spawned = await opened();
      expect([spawned.cols, spawned.rows]).toEqual([DEFAULT_TERMINAL_SIZE.cols, DEFAULT_TERMINAL_SIZE.rows]);
      pty.spawned.length = 0;
    }
  });

  it('treats JSON that is not a frame as keystrokes rather than throwing', async () => {
    const port = await startGateway(5_000);
    const ws = await attach(port, [resize(80, 24)]);
    const spawned = await opened();
    ws.send('null');
    ws.send('42');
    await vi.waitFor(() => expect(spawned.written).toEqual(['null', '42']));
  });

  it('writes only text from an input frame, so a number or an object cannot take hostd down', async () => {
    const port = await startGateway(5_000);
    const ws = await attach(port, [resize(80, 24), JSON.stringify({ type: 'input', data: 123 })]);
    const spawned = await opened();
    ws.send(JSON.stringify({ type: 'input', data: { text: 'ls' } }));
    ws.send(JSON.stringify({ type: 'input', data: true }));
    ws.send(input('ls\r'));
    await vi.waitFor(() => expect(spawned.written).toEqual(['ls\r']));
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it('drops the one frame that throws, says so, and keeps the socket', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const port = await startGateway(5_000);
    const ws = await attach(port, [resize(80, 24)]);
    const spawned = await opened();
    ws.send(input('throw'));
    ws.send(input('ls\r'));

    await vi.waitFor(() => expect(spawned.written).toEqual(['ls\r']));
    expect(warn).toHaveBeenCalledWith('[hostd] terminal frame dropped on atlas/shell: the pty is gone');
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it('drops a resize the live pty throws on, and keeps the socket', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const port = await startGateway(5_000);
    const ws = await attach(port, [resize(80, 24)]);
    const spawned = await opened();
    pty.resizeThrows = 'ioctl(2) failed, EBADF';
    ws.send(resize(100, 40));
    ws.send(input('ls\r'));

    await vi.waitFor(() => expect(spawned.written).toEqual(['ls\r']));
    expect(warn).toHaveBeenCalledWith('[hostd] terminal frame dropped on atlas/shell: ioctl(2) failed, EBADF');
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it('leaves the pty alone once the attach client has exited, while the socket waits to close', async () => {
    const port = await startGateway(5_000);
    const ws = await attach(port, [resize(80, 24)]);
    const spawned = await opened();
    // Live: the attach row is written and a keystroke goes through.
    ws.send(input('ls\r'));
    await vi.waitFor(() => expect(spawned.written).toEqual(['ls\r']));
    const closed = new Promise((resolve) => ws.once('close', resolve));

    // The session ends, and a resize already on its way arrives before the
    // client has answered the server's close.
    spawned.exit(0);
    ws.send(resize(100, 40));
    ws.send(input('pwd\r'));
    await closed;

    expect(spawned.resized).toEqual([]);
    expect(spawned.written).toEqual(['ls\r']);
  });

  it('closes a socket that sends invalid UTF-8 with 1007, says so, and serves the next attach', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const port = await startGateway(5_000);
    const ws = await attach(port, [resize(80, 24)]);
    const spawned = await opened();
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));

    // A text frame the client does not check, as a broken proxy or a hand-made client sends.
    ws.send(Buffer.from([0xff, 0xfe]), { binary: false });

    expect(await closed).toBe(1007);
    await vi.waitFor(() => expect(spawned.killed).toBeGreaterThan(0));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[hostd\] terminal socket error on atlas\/shell: /));
    await attach(port, [resize(80, 24)]);
    await vi.waitFor(() => expect(pty.spawned).toHaveLength(2));
  });

  it('closes a socket whose message is larger than any terminal needs with 1009', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const port = await startGateway(5_000);
    const ws = await attach(port, [resize(80, 24)]);
    const spawned = await opened();
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));

    ws.send(input('x'.repeat(2 * 1024 * 1024)));

    expect(await closed).toBe(1009);
    expect(spawned.written).toEqual([]);
  });

  it('opens nothing for a client that leaves before it says anything', async () => {
    const port = await startGateway(100);
    const ws = await attach(port, []);
    ws.close();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(pty.spawned).toEqual([]);
  });
});

/** The audit rows written, by action. */
const audited = (action: string) => vi.mocked(audit).mock.calls.filter(([row]) => (row as { action: string }).action === action);

/** Fails the test if a rejection reaches the process, as it would take hostd down. */
function watchUnhandled(): unknown[] {
  const seen: unknown[] = [];
  const listener = (reason: unknown) => seen.push(reason);
  process.on('unhandledRejection', listener);
  closers.push(async () => void process.off('unhandledRejection', listener));
  return seen;
}

describe('an audit row that cannot be written', () => {
  it('refuses the attach: says so, closes with 1011 and kills the attach, and hostd stays up', async () => {
    const unhandled = watchUnhandled();
    vi.mocked(audit).mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:5432'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const port = await startGateway(5_000);
    const ws = await attach(port, [resize(80, 24)]);
    let printed = '';
    ws.on('message', (chunk) => (printed += chunk.toString()));
    const code = await new Promise<number>((resolve) => ws.once('close', resolve));

    expect(code).toBe(1011);
    expect(printed).toContain('could not attach: the attach could not be recorded');
    expect(pty.spawned[0]?.killed).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unhandled).toEqual([]);
  });

  it('still lets a detach finish, with a warning, and hostd stays up', async () => {
    const unhandled = watchUnhandled();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const port = await startGateway(5_000);
    const ws = await attach(port, [resize(80, 24)]);
    const spawned = await opened();
    await vi.waitFor(() => expect(audited('terminal.attach')).toHaveLength(1));

    vi.mocked(audit).mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:5432'));
    ws.close();

    await vi.waitFor(() => expect(spawned.killed).toBeGreaterThan(0));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[hostd] terminal detach not recorded:', 'connect ECONNREFUSED 127.0.0.1:5432'));
    expect(unhandled).toEqual([]);
  });
});

describe('a client that leaves while its attach is being recorded', () => {
  it('kills the attach, and records the detach once the attach is recorded', async () => {
    let written: () => void = () => undefined;
    vi.mocked(audit).mockImplementationOnce(() => new Promise<void>((resolve) => (written = resolve)) as never);
    const port = await startGateway(5_000);
    const ws = await attach(port, [resize(80, 24)]);
    const spawned = await opened();
    await vi.waitFor(() => expect(audited('terminal.attach')).toHaveLength(1));

    ws.close();
    await vi.waitFor(() => expect(spawned.killed).toBeGreaterThan(0));
    expect(audited('terminal.detach')).toHaveLength(0);

    written();
    await vi.waitFor(() => expect(audited('terminal.detach')).toHaveLength(1));
  });
});

describe('what the attach shows before its row is written', () => {
  /** An attach row that is written only when the test says so. */
  function slowAttachRow(): () => void {
    let written: () => void = () => undefined;
    vi.mocked(audit).mockImplementationOnce(() => new Promise<void>((resolve) => (written = resolve)) as never);
    return () => written();
  }

  it('sends the session’s first screen, in order, once the attach is recorded', async () => {
    pty.onSpawn = (spawned) => {
      spawned.emit('\u001b[H first line');
      spawned.emit(' second line');
    };
    const write = slowAttachRow();
    const port = await startGateway(5_000);
    const ws = await attach(port, [resize(80, 24)]);
    let printed = '';
    ws.on('message', (chunk) => (printed += chunk.toString()));
    await opened();
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Nobody sees the session before its attach is recorded.
    expect(printed).toBe('');

    write();
    await vi.waitFor(() => expect(printed).toBe('\u001b[H first line second line'));
    expect(audited('terminal.attach')).toHaveLength(1);
  });

  it('says it detached and closes when the session ended before the attach was recorded', async () => {
    pty.onSpawn = (spawned) => {
      spawned.emit('bye');
      spawned.exit(1);
    };
    const write = slowAttachRow();
    const port = await startGateway(5_000);
    const ws = await attach(port, [resize(80, 24)]);
    let printed = '';
    ws.on('message', (chunk) => (printed += chunk.toString()));
    const closed = new Promise((resolve) => ws.once('close', resolve));
    await opened();
    await new Promise((resolve) => setTimeout(resolve, 30));

    write();
    await closed;
    expect(printed).toMatch(/^bye\r\n.*detached \(1\)/);
  });
});
