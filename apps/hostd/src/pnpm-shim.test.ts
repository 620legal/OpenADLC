import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * OpenADLC's `pnpm`, in a session whose repository's store is read-only. A
 * command that changes the dependencies would write to it; the wrapper has
 * hostd fill it from the lockfile first, or runs the command against the
 * task's own store and says so. Both the real pnpm and hostd are stand-ins
 * that write down what they were asked.
 */

const SHIM = join(import.meta.dirname, '..', 'bin', 'pnpm');
const STORE = '/pnpm-store';

let dir: string;
let home: string;
let log: string;
let hostd: Server;
let hostdUrl: string;
let refills: { path: string; token: string | undefined }[];
let refillStatus: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'openadlc-pnpm-shim-'));
  home = join(dir, 'home');
  mkdirSync(home);
  mkdirSync(join(dir, 'wt', 'node_modules'), { recursive: true });
  writeFileSync(join(dir, 'wt', 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  writeFileSync(join(dir, 'wt', 'node_modules', '.modules.yaml'), 'storeDir: /pnpm-store/v10\n');
  log = join(dir, 'calls');
  // The real pnpm: writes down its arguments and the store it was given, and
  // fails an offline install when told to, as one the store lacks a package for.
  const real = join(dir, 'real');
  mkdirSync(real);
  writeFileSync(
    join(real, 'pnpm'),
    [
      '#!/bin/sh',
      `echo "$* | store=$PNPM_STORE_DIR | retries=\${npm_config_fetch_retries:-}" >> ${JSON.stringify(log)}`,
      'case "$*" in *--lockfile-only*) echo "storeDir: $PNPM_STORE_DIR" > node_modules/.modules.yaml ;; esac',
      'case "$*" in *--offline*) [ -n "$FAKE_OFFLINE_FAILS" ] && exit 1 ;; esac',
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(join(real, 'pnpm'), 0o755);

  refills = [];
  refillStatus = 200;
  hostd = createServer((request, response) => {
    refills.push({ path: request.url ?? '', token: request.headers['x-openadlc-task-token'] as string | undefined });
    response.writeHead(refillStatus, { 'content-type': 'application/json' });
    response.end(JSON.stringify(refillStatus === 200 ? { filled: true } : { error: 'the registry did not answer' }));
  });
  await new Promise<void>((resolve) => hostd.listen(0, '127.0.0.1', resolve));
  hostdUrl = `http://127.0.0.1:${(hostd.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => hostd.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

function pnpm(args: string[], extra: Record<string, string> = {}): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(SHIM, args, {
      cwd: join(dir, 'wt'),
      env: {
        PATH: [join(import.meta.dirname, '..', 'bin'), join(dir, 'real'), '/usr/bin', '/bin'].join(':'),
        HOME: home,
        OPENADLC_PNPM_STORE: STORE,
        PNPM_STORE_DIR: STORE,
        npm_config_store_dir: STORE,
        OPENADLC_HOSTD_URL: hostdUrl,
        OPENADLC_TASK_ID: 'task-1',
        OPENADLC_TASK_TOKEN: 'task-1-token',
        ...extra,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.stdout.resume();
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);

describe('OpenADLC’s pnpm beside another copy of itself', () => {
  it('runs the real pnpm, not the other copy, which it once exec’d back and forth with for good', () => {
    const bin = join(import.meta.dirname, '..', 'bin');
    const other = join(dir, 'other-shims');
    cpSync(bin, other, { recursive: true });
    const ran = spawnSync(SHIM, ['--version'], {
      cwd: join(dir, 'wt'),
      env: { PATH: [bin, other, join(dir, 'real'), '/usr/bin', '/bin'].join(':'), HOME: home },
      encoding: 'utf8',
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    expect(ran.error).toBeUndefined();
    expect(ran.status).toBe(0);
    expect(calls()).toEqual([`--version | store= | retries=`]);
  });
});

describe('OpenADLC’s pnpm behind a stand-in pnpm that runs it', () => {
  it('runs the pnpm after it on PATH, not the stand-in before it, which it exec’d back and forth with for good', () => {
    // A test's pnpm first on PATH that runs the one it found there before,
    // which in a task's container is this one. The stand-in gives up after a
    // few runs, so a loop fails here at once.
    const bin = join(import.meta.dirname, '..', 'bin');
    const stand = join(dir, 'stand-in');
    const runs = join(dir, 'stand-in-runs');
    mkdirSync(stand);
    writeFileSync(
      join(stand, 'pnpm'),
      [
        '#!/bin/sh',
        `[ -f '${runs}' ] && [ "$(wc -l < '${runs}')" -ge 5 ] && { echo 'the stand-in was run again' >&2; exit 97; }`,
        `echo "$*" >> '${runs}'`,
        `exec '${SHIM}' "$@"`,
        '',
      ].join('\n'),
    );
    chmodSync(join(stand, 'pnpm'), 0o755);
    const ran = spawnSync(join(stand, 'pnpm'), ['--version'], {
      cwd: join(dir, 'wt'),
      env: { PATH: [stand, bin, join(dir, 'real'), '/usr/bin', '/bin'].join(':'), HOME: home },
      encoding: 'utf8',
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    expect(ran.error).toBeUndefined();
    expect(ran.stderr).toBe('');
    expect(ran.status).toBe(0);
    expect(readFileSync(runs, 'utf8')).toBe('--version\n');
    expect(calls()).toEqual([`--version | store= | retries=`]);
  });

  it('says there is no pnpm after it on PATH, rather than that pnpm is not installed, when one is only before it', () => {
    const bin = join(import.meta.dirname, '..', 'bin');
    const tools = join(dir, 'tools');
    mkdirSync(tools);
    // What the wrapper itself runs, and no pnpm.
    symlinkSync(execFileSync('sh', ['-c', 'command -v dirname'], { encoding: 'utf8' }).trim(), join(tools, 'dirname'));
    const ran = spawnSync(SHIM, ['--version'], { cwd: join(dir, 'wt'), env: { PATH: [join(dir, 'real'), bin, tools].join(':'), HOME: home }, encoding: 'utf8', timeout: 10_000 });
    expect(ran.status).toBe(127);
    expect(ran.stderr).toBe(`pnpm: no pnpm after OpenADLC's (${bin}) on PATH; put the real pnpm's directory after it\n`);
    expect(calls()).toEqual([]);
  });
});

describe('a dependency added in a session on the shared store', () => {
  it('is worked out off the store, filled into it by hostd from this task’s lockfile, then installed from it', async () => {
    const { code, stderr } = await pnpm(['add', '-D', 'left-pad']);

    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(calls()).toEqual([
      `add -D left-pad --lockfile-only | store=${home}/.pnpm-resolve-store | retries=`,
      `add -D left-pad | store=${STORE} | retries=0`,
    ]);
    expect(refills).toEqual([{ path: '/tasks/task-1/pnpm-store', token: 'task-1-token' }]);
    // Working it out wrote which store built node_modules; that is put back.
    expect(readFileSync(join(dir, 'wt', 'node_modules', '.modules.yaml'), 'utf8')).toBe('storeDir: /pnpm-store/v10\n');
  });

  it('runs against the task’s own store, and says so, when hostd cannot fill the shared one, and stays there', async () => {
    refillStatus = 503;

    const { code, stderr } = await pnpm(['add', 'left-pad']);

    expect(code).toBe(0);
    expect(stderr).toMatch(/hostd could not add what it needs to the repository's shared store \(503\); running it against this task's own store/);
    expect(calls().at(-1)).toBe(`add left-pad | store=${home}/.pnpm-store | retries=`);

    // `make ci` and the rest of the session install from the same store now.
    await pnpm(['install', '--frozen-lockfile']);
    expect(calls().at(-1)).toBe(`install --frozen-lockfile | store=${home}/.pnpm-store | retries=`);
    expect(refills).toHaveLength(1);
  });
});

describe('an install on the shared store', () => {
  it('installs from it with nothing asked of hostd when the store holds everything', async () => {
    expect((await pnpm(['install', '--frozen-lockfile'])).code).toBe(0);

    expect(calls()).toEqual([`install --frozen-lockfile --offline | store=${STORE} | retries=`]);
    expect(refills).toEqual([]);
  });

  it('has hostd fill it first when the store lacks something the lockfile names', async () => {
    expect((await pnpm(['install'], { FAKE_OFFLINE_FAILS: '1' })).code).toBe(0);

    expect(calls()).toEqual([`install --offline | store=${STORE} | retries=`, `install | store=${STORE} | retries=0`]);
    expect(refills).toHaveLength(1);
  });
});

describe('everything else', () => {
  it('runs untouched, and so does a session with no shared store', async () => {
    await pnpm(['-C', 'packages/a', 'test']);
    await pnpm(['add', 'left-pad'], { OPENADLC_PNPM_STORE: '', PNPM_STORE_DIR: `${home}/.pnpm-store` });

    expect(calls()).toEqual([`-C packages/a test | store=${STORE} | retries=`, `add left-pad | store=${home}/.pnpm-store | retries=`]);
    expect(refills).toEqual([]);
  });
});
