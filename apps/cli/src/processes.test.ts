import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runtimeDir } from './install.js';
import { isKeeperOf, isRunning, keeperPid, psCommand, readPid, stopGraceMs, stopService, waitForHealth } from './processes.js';

let scratch = '';
let before: string | undefined;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'openadlc-processes-'));
  before = process.env.OPENADLC_HOME;
  process.env.OPENADLC_HOME = scratch;
});

afterEach(() => {
  if (before === undefined) delete process.env.OPENADLC_HOME;
  else process.env.OPENADLC_HOME = before;
  rmSync(scratch, { recursive: true, force: true });
});

describe('stopping a service by its pid file', () => {
  it('says a pid that is gone was not running, and removes the file', async () => {
    // `down` called this "would not stop" after every reboot.
    const pidFile = join(runtimeDir(), 'bridge.pid');
    writeFileSync(pidFile, '999999');
    expect(await stopService('bridge')).toBe('not-running');
    expect(existsSync(pidFile)).toBe(false);
  });

  it('reads a command line from /proc where there is no ps, as the crew’s slim task image has none', () => {
    // There a missing ps read as "cannot say", the stale pid was kept, and
    // `make ci` failed "never signals an unrelated process a stale pid file
    // names" on every branch.
    const proc = join(scratch, 'proc');
    mkdirSync(join(proc, '4242'), { recursive: true });
    writeFileSync(join(proc, '4242', 'cmdline'), 'node\0/x/apps/cli/dist/keep.js\0bridge\0--log\0/x/run/bridge.log\0');
    const command = (pid: number) => psCommand(pid, 'openadlc-no-such-ps', proc);
    expect(command(4242)).toBe('node /x/apps/cli/dist/keep.js bridge --log /x/run/bridge.log');
    expect(isKeeperOf('bridge', 4242, command)).toBe(true);
    expect(isKeeperOf('hostd', 4242, command)).toBe(false);
    // A pid /proc does not list is nobody's keeper; with no /proc either, nothing can say.
    expect(command(4243)).toBe('');
    expect(psCommand(4242, 'openadlc-no-such-ps', join(scratch, 'no-proc'))).toBeNull();
  });

  it('leaves alone a live pid that is not this service’s keeper', async () => {
    // The number in a stale pid file is some other program's after a reboot.
    // This test's own process stands in for it: signalling it would end the run.
    const pidFile = join(runtimeDir(), 'bridge.pid');
    writeFileSync(pidFile, String(process.pid));
    expect(await stopService('bridge', () => '/usr/bin/vim notes.txt')).toBe('not-running');
    expect(existsSync(pidFile)).toBe(false);
  });

  it('never signals an unrelated process a stale pid file names', async () => {
    // A pid file naming somebody's `sleep` made `stopService('bridge')` kill it.
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    try {
      const pidFile = join(runtimeDir(), 'bridge.pid');
      writeFileSync(pidFile, String(child.pid));
      expect(keeperPid('bridge')).toBeNull();
      expect(await stopService('bridge')).toBe('not-running');
      expect(isRunning(child.pid as number)).toBe(true);
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('gives hostd a minute to stop its tasks, the bridge twenty seconds, and the rest five', () => {
    expect(stopGraceMs('hostd')).toBe(60_000);
    expect(stopGraceMs('bridge')).toBe(20_000);
    expect(stopGraceMs('console')).toBe(5000);
    expect(stopGraceMs('anything')).toBe(5000);
  });

  it('still kills a service that is running at the end of its grace period, and says it stopped', async () => {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: 'ignore',
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      writeFileSync(join(runtimeDir(), 'hostd.pid'), String(child.pid));
      const keeper = () => 'node /x/apps/cli/dist/keep.js hostd --log /x/run/hostd.log -- node dist/main.js';
      expect(await stopService('hostd', keeper, 200)).toBe('stopped');
      expect(isRunning(child.pid as number)).toBe(false);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('reads no pid from a file holding 1, 0, a negative or a fraction', () => {
    // `kill(-1, …)` signals every process this user owns.
    for (const content of ['1', '0', '-1', '-42', '12.5', 'bridge']) {
      writeFileSync(join(runtimeDir(), 'bridge.pid'), content);
      expect(readPid('bridge')).toBeNull();
    }
    expect(isRunning(1)).toBe(false);
  });

  it('takes a live keeper for the service, and only that', () => {
    writeFileSync(join(runtimeDir(), 'bridge.pid'), String(process.pid));
    expect(keeperPid('bridge', () => 'node /x/apps/cli/dist/keep.js bridge --log /x/run/bridge.log -- node dist/main.js')).toBe(process.pid);
    expect(keeperPid('bridge', () => '/usr/bin/vim notes.txt')).toBeNull();
    expect(keeperPid('console', () => 'node /x/keep.js console -- pnpm start')).toBeNull();
  });

  it('knows a keeper by its command line, and says when it cannot tell', () => {
    expect(isKeeperOf('bridge', 1, () => 'node /opt/openadlc/apps/cli/dist/keep.js bridge --log /x/run/bridge.log -- node dist/main.js')).toBe(true);
    expect(isKeeperOf('bridge', 1, () => 'node /opt/openadlc/apps/cli/dist/keep.js bridge -- node dist/main.js')).toBe(true);
    expect(isKeeperOf('bridge', 1, () => 'node /opt/openadlc/apps/cli/dist/keep.js console -- pnpm start')).toBe(false);
    expect(isKeeperOf('bridge', 1, () => null)).toBeNull();
  });
});

describe('waiting for a service to answer', () => {
  let server: Server | null = null;

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    server = null;
  });

  it('gives up on a service that takes the connection and never answers', async () => {
    // Without a timeout each attempt waited undici's five minutes.
    server = createServer(() => undefined);
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };

    const started = Date.now();
    expect(await waitForHealth(`http://127.0.0.1:${port}/healthz`, 40, 10, { timeoutMs: 100, deadlineMs: 600 })).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
