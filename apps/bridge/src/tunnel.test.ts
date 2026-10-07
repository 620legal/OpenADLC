import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { openQuickTunnel, TunnelError, TunnelKeeper, type Spawner, type TunnelProcess } from './tunnel.js';

/**
 * cloudflared, as it actually behaves: the address arrives on stderr, inside a
 * box, some time after the process starts.
 */
const BANNER = `2026-09-20T21:00:00Z INF Thank you for trying Cloudflare Tunnel.
2026-09-20T21:00:00Z INF +--------------------------------------------------------------------------------------------+
2026-09-20T21:00:00Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-09-20T21:00:00Z INF |  https://calm-badger-42-quick.trycloudflare.com                                             |
2026-09-20T21:00:00Z INF +--------------------------------------------------------------------------------------------+
`;

interface Fake extends TunnelProcess {
  emitStderr: (text: string) => void;
  emitExit: (code: number) => void;
  emitError: (cause: Error) => void;
  killed: NodeJS.Signals[];
  args: string[];
}

function fakeCloudflared(): { spawner: Spawner; child: () => Fake } {
  let made: Fake | null = null;

  const spawner: Spawner = (_command, args) => {
    const events = new EventEmitter();
    const stderr = new Readable({ read() {} });
    const killed: NodeJS.Signals[] = [];

    const fake: Fake = {
      stderr,
      stdout: null,
      once: (event, listener) => events.once(event, listener as (...args: unknown[]) => void),
      kill: (signal = 'SIGTERM') => {
        killed.push(signal);
        return true;
      },
      pid: 4242,
      args,
      killed,
      emitStderr: (text) => stderr.push(text),
      // A real child emits `exit` before its stdio has necessarily drained, and
      // `close` after. Both are emitted here so the code cannot rely on the
      // convenient one.
      emitExit: (code) => {
        events.emit('exit', code);
        events.emit('close', code);
      },
      emitError: (cause) => events.emit('error', cause),
    };
    made = fake;
    return fake;
  };

  return { spawner, child: () => made! };
}

describe('starting a tunnel', () => {
  it('resolves with the address cloudflared printed', async () => {
    const { spawner, child } = fakeCloudflared();
    const pending = openQuickTunnel({ port: 47399, spawner });

    child().emitStderr(BANNER);

    await expect(pending).resolves.toMatchObject({
      url: 'https://calm-badger-42-quick.trycloudflare.com',
    });
  });

  it('points the tunnel at the port it was given', async () => {
    const { spawner, child } = fakeCloudflared();
    const pending = openQuickTunnel({ port: 47399, spawner });
    child().emitStderr(BANNER);
    await pending;

    expect(child().args).toEqual(['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:47399']);
  });

  it('waits for the address rather than for the process', async () => {
    // A tunnel whose address nobody knows is no use, and cloudflared starts
    // several seconds before it has one.
    const { spawner, child } = fakeCloudflared();
    const pending = openQuickTunnel({ port: 47399, spawner });

    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    child().emitStderr('2026-09-20T21:00:00Z INF Requesting new quick Tunnel...\n');
    await Promise.resolve();
    expect(settled).toBe(false);

    child().emitStderr(BANNER);
    await pending;
    expect(settled).toBe(true);
  });
});

describe('when there is no tunnel to be had', () => {
  it('says how to install cloudflared, because that is the likely cause', async () => {
    const { spawner, child } = fakeCloudflared();
    const pending = openQuickTunnel({ port: 47399, spawner });

    child().emitError(new Error('spawn cloudflared ENOENT'));

    await expect(pending).rejects.toThrow(/brew install cloudflared/);
    // Linux too, and the way round a tunnel altogether.
    await expect(pending).rejects.toThrow(/Linux: Cloudflare's cloudflared package .*or give the bridge a public address instead/);
  });

  it('quotes what cloudflared said when it exits without an address', async () => {
    const { spawner, child } = fakeCloudflared();
    const pending = openQuickTunnel({ port: 47399, spawner });

    child().emitStderr('2026-09-20T21:00:00Z ERR failed to dial to edge: connection refused\n');
    child().emitExit(1);

    // The message has to carry the reason: "it failed" sends somebody to a
    // terminal to find out what this already knew.
    await expect(pending).rejects.toThrow(/connection refused/);
  });

  it('gives up rather than hanging, and kills what it started', async () => {
    vi.useFakeTimers();
    try {
      const { spawner, child } = fakeCloudflared();
      const pending = openQuickTunnel({ port: 47399, spawner, timeoutMs: 5_000 });
      const settled = expect(pending).rejects.toThrow(/did not report an address within 5s/);

      await vi.advanceTimersByTimeAsync(5_001);
      await settled;

      expect(child().killed).toEqual(['SIGTERM']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the spawn error, not the exit that follows it', async () => {
    const { spawner, child } = fakeCloudflared();
    const pending = openQuickTunnel({ port: 47399, spawner });
    const settled = expect(pending).rejects.toThrow(/cloudflared is not installed/);

    child().emitError(new Error('spawn cloudflared ENOENT'));
    // An exit follows an error in real life; the error is what explains it, so
    // it is the one reported.
    child().emitExit(1);
    await settled;
  });
});

describe('the tunnel this process is responsible for', () => {
  it('reports nothing running before one is started', () => {
    expect(new TunnelKeeper().state()).toMatchObject({ running: false, url: '' });
  });

  it('reports the address once one is', async () => {
    const { spawner, child } = fakeCloudflared();
    const keeper = new TunnelKeeper();
    const started = keeper.start(47399, { spawner });
    child().emitStderr(BANNER);
    await started;

    expect(keeper.state()).toMatchObject({
      running: true,
      url: 'https://calm-badger-42-quick.trycloudflare.com',
    });
    expect(keeper.state().since).not.toBeNull();
  });

  it('replaces a running tunnel rather than leaving two', async () => {
    // Two tunnels are two addresses and GitHub is pointed at one of them. The
    // orphan would go on running until the machine was rebooted.
    const first = fakeCloudflared();
    const keeper = new TunnelKeeper();
    const one = keeper.start(47399, { spawner: first.spawner });
    first.child().emitStderr(BANNER);
    await one;

    const second = fakeCloudflared();
    const two = keeper.start(47399, { spawner: second.spawner });
    second.child().emitStderr(BANNER.replace('calm-badger-42-quick', 'other-name-99'));
    await two;

    expect(first.child().killed).toEqual(['SIGTERM']);
    expect(keeper.state().url).toBe('https://other-name-99.trycloudflare.com');
  });

  it('says it stopped when cloudflared exits after giving its address', async () => {
    // It was watched only until the address came, so the page went on saying
    // cloudflared was serving an address GitHub could no longer reach.
    const { spawner, child } = fakeCloudflared();
    const keeper = new TunnelKeeper();
    const started = keeper.start(47399, { spawner });
    child().emitStderr(BANNER);
    await started;

    child().emitExit(1);
    await new Promise((resolve) => setImmediate(resolve));

    expect(keeper.state()).toMatchObject({ running: false, url: '' });
    expect(keeper.state().detail).toContain('cloudflared stopped (exit 1)');
  });

  it('starts one cloudflared when asked twice at once, and both hear its address', async () => {
    const { spawner, child } = fakeCloudflared();
    const spawned = vi.fn(spawner);
    const keeper = new TunnelKeeper();
    const one = keeper.start(47399, { spawner: spawned });
    const two = keeper.start(47399, { spawner: spawned });
    child().emitStderr(BANNER);

    expect(await Promise.all([one, two])).toEqual(['https://calm-badger-42-quick.trycloudflare.com', 'https://calm-badger-42-quick.trycloudflare.com']);
    expect(spawned).toHaveBeenCalledTimes(1);
    expect(child().killed).toEqual([]);
  });

  it('stops reporting an address once stopped', async () => {
    const { spawner, child } = fakeCloudflared();
    const keeper = new TunnelKeeper();
    const started = keeper.start(47399, { spawner });
    child().emitStderr(BANNER);
    await started;

    keeper.stop();

    expect(keeper.state()).toMatchObject({ running: false, url: '' });
    expect(child().killed).toEqual(['SIGTERM']);
  });
});
