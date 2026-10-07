import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keepRunning, main, removeOwnPidFile, rotatingLog, type KeepOptions } from './keep-running.js';

/**
 * The console went offline overnight and stayed offline: nothing started it
 * again, and nothing wrote down how it had ended.
 */

class FakeChild extends EventEmitter {
  readonly kill = vi.fn((_signal?: NodeJS.Signals) => true);
  end(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal);
  }
}

function keeper(overrides: Partial<KeepOptions> = {}) {
  const children: FakeChild[] = [];
  const lines: string[] = [];
  const kept = keepRunning({
    name: 'console',
    command: ['pnpm', 'start'],
    delayMs: 1000,
    maxDelayMs: 4000,
    quickMs: 10_000,
    quickLimit: 3,
    forwardAfterMs: 8000,
    log: (line) => lines.push(line),
    spawnChild: () => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
    ...overrides,
  });
  return { kept, children, lines };
}

describe('a service that ends without being asked to', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is started again, and the log says how it ended', async () => {
    const { children, lines } = keeper();
    vi.advanceTimersByTime(60_000);
    children[0]?.end(null, 'SIGKILL');

    expect(lines).toEqual(['[fleetadlc] console was stopped by SIGKILL after 1m; starting it again in 1s']);
    vi.advanceTimersByTime(1000);
    expect(children).toHaveLength(2);
  });

  it('waits longer each time it dies straight away, and gives up rather than loop', async () => {
    const { kept, children, lines } = keeper();

    children[0]?.end(1);
    vi.advanceTimersByTime(1000);
    children[1]?.end(1);
    vi.advanceTimersByTime(2000);
    children[2]?.end(1);

    expect(lines[0]).toContain('starting it again in 1s');
    expect(lines[1]).toContain('starting it again in 2s');
    expect(lines[2]).toContain('exited with code 1 3 times in a row');
    expect(lines[2]).toContain('Run `fleetadlc up`');
    await expect(kept.done).resolves.toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(children).toHaveLength(3);
  });

  it('counts afresh after a run that lasted', async () => {
    const { children, lines } = keeper();

    children[0]?.end(1);
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(30_000);
    children[1]?.end(1);

    expect(lines[1]).toContain('after 30s; starting it again in 1s');
    vi.advanceTimersByTime(1000);
    expect(children).toHaveLength(3);
  });
});

describe('stopping', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts nothing again, and leaves the signal to the group it already reached', async () => {
    // `fleetadlc down` signals the whole group. Passing it on at once would give
    // hostd two drains at the same time.
    const { kept, children } = keeper();

    kept.stop('SIGTERM');
    expect(children[0]?.kill).not.toHaveBeenCalled();
    children[0]?.end(0);

    await expect(kept.done).resolves.toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(children).toHaveLength(1);
  });

  it('passes the signal on when only the keeper was signalled and the service is still there', async () => {
    const { kept, children } = keeper();

    kept.stop('SIGTERM');
    vi.advanceTimersByTime(8000);

    expect(children[0]?.kill).toHaveBeenCalledWith('SIGTERM');
    children[0]?.end(null, 'SIGTERM');
    await expect(kept.done).resolves.toBe(0);
  });

  it('while waiting to start it again, ends there', async () => {
    const { kept, children } = keeper();

    children[0]?.end(1);
    kept.stop();

    await expect(kept.done).resolves.toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(children).toHaveLength(1);
  });
});

describe('a real process', () => {
  it('is kept, and its exit code written down', async () => {
    const lines: string[] = [];
    const kept = keepRunning({
      name: 'dispatcher',
      command: [process.execPath, '-e', 'process.exit(3)'],
      delayMs: 10,
      quickLimit: 2,
      log: (line) => lines.push(line),
    });

    await expect(kept.done).resolves.toBe(1);
    expect(lines[0]).toMatch(/^\[fleetadlc\] dispatcher exited with code 3 after \d+s; starting it again in 0s$/);
    expect(lines[1]).toContain('exited with code 3 2 times in a row');
  });

  it('refuses to run without a command', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(main(['console'])).resolves.toBe(2);
    await expect(main(['console', '--'])).resolves.toBe(2);
    error.mockRestore();
  });
});

describe('the keeper’s pid file', () => {
  it('is removed when the keeper exits, but only while it still holds that keeper’s pid', async () => {
    // Left behind, the number came to name some other program, and `up` took
    // it for the service and started nothing.
    const { existsSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'fleetadlc-pid-'));
    try {
      const path = join(dir, 'bridge.pid');
      writeFileSync(path, '4242');
      removeOwnPidFile(path, 4243);
      expect(existsSync(path)).toBe(true);
      removeOwnPidFile(path, 4242);
      expect(existsSync(path)).toBe(false);
      removeOwnPidFile(path, 4242);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a service’s log', () => {
  it('is rotated past its limit, so a service that runs for months does not fill the disk', async () => {
    const { mkdtempSync, readFileSync, rmSync, statSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'fleetadlc-log-'));
    try {
      const path = join(dir, 'bridge.log');
      const write = rotatingLog(path, 10);
      write('123456\n');
      write('abcdef\n');
      write('ABCDEF\n');
      expect(readFileSync(`${path}.1`, 'utf8')).toBe('abcdef\n');
      expect(readFileSync(path, 'utf8')).toBe('ABCDEF\n');
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gets everything the service printed, its last lines included, when the keeper writes it', async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'fleetadlc-log-'));
    try {
      const path = join(dir, 'bridge.log');
      const output = rotatingLog(path);
      const kept = keepRunning({
        name: 'bridge',
        command: [process.execPath, '-e', 'console.log("up"); console.error("crashed"); process.exit(3)'],
        delayMs: 10,
        quickLimit: 1,
        output,
        log: (line) => output(`${line}\n`),
      });
      await expect(kept.done).resolves.toBe(1);
      const log = readFileSync(path, 'utf8');
      expect(log).toContain('up\n');
      expect(log).toContain('crashed\n');
      expect(log.trim().split('\n').at(-1)).toContain('bridge exited with code 3 1 times in a row');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
