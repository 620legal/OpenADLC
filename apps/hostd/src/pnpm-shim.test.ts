import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  dir = mkdtempSync(join(tmpdir(), 'fleetadlc-pnpm-shim-'));
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
    refills.push({ path: request.url ?? '', token: request.headers['x-fleetadlc-task-token'] as string | undefined });
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
        FLEETADLC_PNPM_STORE: STORE,
        PNPM_STORE_DIR: STORE,
        npm_config_store_dir: STORE,
        FLEETADLC_HOSTD_URL: hostdUrl,
        FLEETADLC_TASK_ID: 'task-1',
        FLEETADLC_TASK_TOKEN: 'task-1-token',
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
    await pnpm(['add', 'left-pad'], { FLEETADLC_PNPM_STORE: '', PNPM_STORE_DIR: `${home}/.pnpm-store` });

    expect(calls()).toEqual([`-C packages/a test | store=${STORE} | retries=`, `add left-pad | store=${home}/.pnpm-store | retries=`]);
    expect(refills).toEqual([]);
  });
});
