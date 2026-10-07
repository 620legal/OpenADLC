import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);

const WRAPPER = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'infra',
  'local',
  'fleetadlc-install',
);

/**
 * The wrapper is what makes "refreshes before each install" true, so it is
 * tested the way it runs: the real script, against a hostd that answers the way
 * hostd answers, installing with a command that records what it was given.
 */
let hostd: Server;
let url: string;
let answer: { status: number; body: unknown };
let requests: Array<{ path: string; token: string | undefined }>;
let dir: string;

/** A stand-in for `pnpm install` that writes down the npmrc it would have read, and the token it was given. */
function recorder(): string {
  const path = join(dir, 'record');
  const script = join(dir, 'fake-install');
  writeFileSync(
    script,
    `#!/usr/bin/env bash\nprintf '%s\\n' "\${npm_config_userconfig:-none}" > ${path}\n` +
      `if [ -f "\${npm_config_userconfig:-/nonexistent}" ]; then cat "\${npm_config_userconfig}" >> ${path}; fi\n` +
      `printf 'args:%s\\n' "$*" >> ${path}\n` +
      `printf 'token:%s\\n' "\${FLEETADLC_REGISTRY_TOKEN:-none}" >> ${path}\n`,
    { mode: 0o755 },
  );
  return script;
}

async function install(extraEnv: Record<string, string> = {}) {
  const script = recorder();
  const env = {
    PATH: process.env.PATH ?? '',
    FLEETADLC_HOSTD_URL: url,
    FLEETADLC_TASK_ID: 'task-live',
    FLEETADLC_TASK_TOKEN: 'the-task-token',
    ...extraEnv,
  };
  try {
    const { stdout, stderr } = await run(WRAPPER, [script, 'install', '--frozen-lockfile'], { env });
    return { code: 0, stdout, stderr, record: readFileSync(join(dir, 'record'), 'utf8') };
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    return { code: failure.code ?? 1, stdout: '', stderr: failure.stderr ?? '', record: '' };
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fleetadlc-install-test-'));
  requests = [];
  answer = { status: 200, body: { host: 'npm.internal.example', token: 'npm_secret', maxAgeSeconds: 300 } };

  hostd = createServer((request, response) => {
    requests.push({ path: request.url ?? '', token: request.headers['x-fleetadlc-task-token'] as string | undefined });
    response.writeHead(answer.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => hostd.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(hostd.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => hostd.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe('installing with a credential from hostd', () => {
  it('asks for this task’s token and runs the command', async () => {
    const result = await install();
    expect(result.code).toBe(0);
    expect(requests).toEqual([{ path: '/tasks/task-live/registry-token', token: 'the-task-token' }]);
    expect(result.record).toContain('args:install --frozen-lockfile');
  });

  it('scopes the token to the registry hostd named', async () => {
    // A bare `_authToken=` is sent to whatever registry a dependency resolves
    // to. Scoping it to one host is what stops the credential leaving.
    const result = await install();
    expect(result.record).toContain('//npm.internal.example/:_authToken=${FLEETADLC_REGISTRY_TOKEN}');
    expect(result.record).toContain('registry=https://npm.internal.example/');
  });

  it('keeps the token out of the npmrc, and gives it to the one command in its environment', async () => {
    // npm and pnpm expand `${FLEETADLC_REGISTRY_TOKEN}` in an npmrc. Written
    // into the file, in the container's /tmp, the token outlived an install
    // killed before the cleanup ran.
    const result = await install();
    const [npmrcPath, ...rest] = result.record.split('\n');
    const npmrc = rest.filter((line) => !line.startsWith('token:')).join('\n');
    expect(npmrcPath).not.toBe('none');
    expect(npmrc).not.toContain('npm_secret');
    expect(result.record).toContain('token:npm_secret');
  });

  it('asks again on the next install, which is the entire point', async () => {
    await install();
    answer = { status: 200, body: { host: 'npm.internal.example', token: 'rotated', maxAgeSeconds: 300 } };
    const second = await install();

    expect(requests).toHaveLength(2);
    expect(second.record).toContain('token:rotated');
    expect(second.record).not.toContain('npm_secret');
  });

  it('removes the credential file when the command is done', async () => {
    const result = await install();
    // The command ran and was handed a file; a wrapper that died first left an
    // empty record, and reading '' throws too.
    expect(result.code).toBe(0);
    const npmrc = result.record.split('\n')[0] ?? '';
    expect(npmrc).toMatch(/^\//);
    expect(() => readFileSync(npmrc, 'utf8')).toThrow();
  });

  it('removes it after a failing install too', async () => {
    const script = join(dir, 'failing');
    writeFileSync(script, '#!/usr/bin/env bash\necho "$npm_config_userconfig" > ' + join(dir, 'leaked') + '\nexit 1\n', {
      mode: 0o755,
    });
    await run(WRAPPER, [script], {
      env: {
        PATH: process.env.PATH ?? '',
        FLEETADLC_HOSTD_URL: url,
        FLEETADLC_TASK_ID: 'task-live',
        FLEETADLC_TASK_TOKEN: 'the-task-token',
      },
    }).catch(() => undefined);

    const leaked = readFileSync(join(dir, 'leaked'), 'utf8').trim();
    expect(() => readFileSync(leaked, 'utf8')).toThrow();
  });
});

describe('installing when there is nothing to install with', () => {
  it('runs the command unchanged on 501, because that is every install today', async () => {
    answer = { status: 501, body: { error: 'this install has no private package registry' } };
    const result = await install();

    expect(result.code).toBe(0);
    expect(result.record).toContain('args:install --frozen-lockfile');
    expect(result.record.split('\n')[0]).toBe('none');
  });

  it('runs the command unchanged outside an OpenADLC session', async () => {
    // `tmux attach` and a person typing it by hand.
    const result = await install({ FLEETADLC_TASK_TOKEN: '' });
    expect(result.code).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it('refuses when hostd names a registry but the task’s variables are missing', async () => {
    // hostd's own `make setup` and local CI used to run with none of them, and
    // the wrapper took that for a person in `tmux attach`.
    const result = await install({ FLEETADLC_REGISTRY_CONFIGURED: '1', FLEETADLC_TASK_TOKEN: '', FLEETADLC_TASK_ID: '' });

    expect(result.code).toBe(78);
    expect(result.stderr).toContain('FLEETADLC_TASK_ID FLEETADLC_TASK_TOKEN');
    expect(requests).toHaveLength(0);
    expect(() => readFileSync(join(dir, 'record'), 'utf8')).toThrow();
  });

  it('refuses to install rather than installing without a credential it should have', async () => {
    // A 401 means the task token is wrong, not that the registry is public.
    // Installing anyway resolves private packages against the public registry,
    // which is how a dependency-confusion package gets in.
    answer = { status: 401, body: { error: 'nope' } };
    const result = await install();

    expect(result.code).toBe(77);
    expect(result.stderr).toContain('hostd refused a registry token (401)');
  });

  it('refuses on 503, a registry named with no token stored, and prints hostd’s message', async () => {
    answer = {
      status: 503,
      body: { error: 'a registry is configured (npm.internal.example) but no token is stored for it', remedy: 'store one' },
    };
    const result = await install();

    expect(result.code).toBe(77);
    expect(result.stderr).toContain('no token is stored for it');
    expect(() => readFileSync(join(dir, 'record'), 'utf8')).toThrow();
  });

  it('refuses when hostd cannot be reached', async () => {
    const result = await install({ FLEETADLC_HOSTD_URL: 'http://127.0.0.1:1' });
    expect(result.code).toBe(69);
    expect(result.stderr).toContain('unreachable');
  });
});
