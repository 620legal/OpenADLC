import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@openadlc/db', () => ({
  audit: vi.fn(async () => undefined),
  bots: { listBots: vi.fn(async () => []), getBotByName: vi.fn(async () => null) },
  modelAccounts: { get: vi.fn(async () => null) },
  costs: {},
  sessions: {},
  tasks: { getTask: vi.fn(async () => null) },
}));

import { audit, tasks } from '@openadlc/db';
import { ImageRestart, imageFileFrom, mirrorDigestProblem, releaseSourceFrom, RESTART_EXIT_CODE, writeImageFile } from './restart-onto-image.js';

/**
 * hostd moving onto a release's `service` image on a cloud host: it writes
 * the file the host's `openadlc-hostd` unit reads before it starts hostd, and
 * exits so systemd starts it again on it. The bridge's self-update asks for
 * it (`apps/bridge/src/cloud-update.ts`) once no task runs.
 */

const INSTALL_SECRET = 'install-secret-for-the-test';
const PLATFORM = { 'x-openadlc-internal-secret': INSTALL_SECRET, 'x-openadlc-on-behalf-of': 'openadlc self-update', 'content-type': 'application/json' };
const MIRROR = 'europe-west1-docker.pkg.dev/acme-openadlc/openadlc-ghcr';
const digest = (c: string) => `sha256:${c.repeat(64)}`;
const SERVICE = `${MIRROR}/620legal/openadlc/service@${digest('a')}`;
const OLD_SERVICE = `${MIRROR}/620legal/openadlc/service@${digest('0')}`;

const made: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hostd-image-'));
  made.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('a mirror digest', () => {
  const source = releaseSourceFrom({ OPENADLC_RELEASE_MIRROR: MIRROR });
  const unnamed = releaseSourceFrom({});

  it('is exactly the mirror, the release repository’s service image and a sha256 digest, as the unit takes it', () => {
    expect(source).toEqual({ mirror: MIRROR, repo: '620legal/openadlc' });
    expect(mirrorDigestProblem(SERVICE, source)).toBeNull();
    expect(mirrorDigestProblem(SERVICE, unnamed)).toBeNull();
    // A tag is a name that can move; only a digest is what was checked.
    expect(mirrorDigestProblem(`${MIRROR}/620legal/openadlc/service:v0.2.0`, source)).toMatch(/digest/);
    expect(mirrorDigestProblem(`ghcr.io/620legal/openadlc/service@${digest('a')}`, source)).toMatch(/mirror/);
    expect(mirrorDigestProblem(`ghcr.io/620legal/openadlc/service@${digest('a')}`, unnamed)).toMatch(/mirror/);
    expect(mirrorDigestProblem(`${MIRROR}/620legal/openadlc/console@${digest('a')}`, source)).toMatch(/service image/);
    // Another repository's image, another path into the mirror, another mirror.
    expect(mirrorDigestProblem(`${MIRROR}/someone/fork/service@${digest('a')}`, source)).toMatch(/620legal\/openadlc's service image/);
    expect(mirrorDigestProblem(`${MIRROR}/x/620legal/openadlc/service@${digest('a')}`, source)).toMatch(/mirror/);
    expect(mirrorDigestProblem(`${MIRROR}/620legal/../openadlc/service@${digest('a')}`, source)).not.toBeNull();
    expect(mirrorDigestProblem(`${MIRROR.replace('acme', 'other')}/620legal/openadlc/service@${digest('a')}`, source)).toMatch(/mirror/);
    expect(mirrorDigestProblem(`${SERVICE}\nExecStart=/bin/sh`, source)).not.toBeNull();
    expect(mirrorDigestProblem(42, source)).not.toBeNull();
    expect(mirrorDigestProblem(`${MIRROR}/someone/fork/service@${digest('a')}`, releaseSourceFrom({ OPENADLC_RELEASE_MIRROR: MIRROR, OPENADLC_RELEASE_REPO: 'Someone/Fork' }))).toBeNull();
  });
});

describe('the image file', () => {
  it('is written whole, with nothing left beside it', () => {
    const dir = scratch();
    const file = join(dir, 'hostd-image');
    writeFileSync(file, `${OLD_SERVICE}\n`);
    writeImageFile(file, SERVICE);
    expect(readFileSync(file, 'utf8')).toBe(`${SERVICE}\n`);
    expect(readdirSync(dir)).toEqual(['hostd-image']);
  });

  it('is written in place, flushed, where hostd may write it but not the directory it is in', () => {
    const dir = scratch();
    const file = join(dir, 'hostd-image');
    writeFileSync(file, `${OLD_SERVICE}\n`);
    // The host's /var/lib/openadlc is root's; the file is hostd's.
    chmodSync(dir, 0o555);
    try {
      writeImageFile(file, SERVICE);
    } finally {
      chmodSync(dir, 0o755);
    }
    expect(readFileSync(file, 'utf8')).toBe(`${SERVICE}\n`);
    expect(readdirSync(dir)).toEqual(['hostd-image']);
  });

  it('is left as it was when it cannot be written', () => {
    const dir = scratch();
    const file = join(dir, 'hostd-image');
    mkdirSync(file);
    expect(() => writeImageFile(file, SERVICE)).toThrow();
    expect(readdirSync(dir)).toEqual(['hostd-image']);
    expect(() => writeImageFile(join(dir, 'gone', 'hostd-image'), SERVICE)).toThrow();
  });

  it('names the image hostd runs only as the unit says it started it, never from the file', () => {
    const dir = scratch();
    // A fresh install's unit starts the module's hostd_image, a tag.
    const env = { OPENADLC_HOSTD_IMAGE_FILE: join(dir, 'hostd-image'), OPENADLC_RELEASE_MIRROR: MIRROR, OPENADLC_HOSTD_IMAGE: 'europe-west1-docker.pkg.dev/acme-openadlc/openadlc/service:v0.1.0' };
    const file = imageFileFrom(env)!;
    writeFileSync(file, `${SERVICE}\n`);
    expect(new ImageRestart({ file, env, exit: () => undefined }).inUse().service).toBe(env.OPENADLC_HOSTD_IMAGE);
    expect(new ImageRestart({ file, env: { ...env, OPENADLC_HOSTD_IMAGE: '' }, exit: () => undefined }).inUse().service).toBeNull();
    expect(imageFileFrom({})).toBeNull();
  });
});

describe('POST /internal/restart-onto-image', () => {
  let file: string;
  let active: string[];
  let exit: ReturnType<typeof vi.fn<(code: number) => void>>;
  let server: { close: () => Promise<void>; call: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: Record<string, unknown> }> };

  beforeEach(async () => {
    file = join(scratch(), 'hostd-image');
    writeFileSync(file, `${OLD_SERVICE}\n`);
    active = [];
    exit = vi.fn<(code: number) => void>();
    vi.mocked(audit).mockClear();
    vi.mocked(tasks.getTask).mockReset().mockResolvedValue(null);
    const { createHostdServer } = await import('./server.js');
    const { RegistryCredentials } = await import('./registry.js');
    const { AttachTokens } = await import('./attach-tokens.js');
    const http = createHostdServer({
      config: { hostName: 'openadlc-host', driver: 'docker', loginRoot: '/nowhere' } as never,
      driver: { kind: 'docker' } as never,
      runner: { activeTaskIds: () => active, startingTaskIds: () => [], sessionOf: () => null, start: vi.fn() } as never,
      attachTokens: new AttachTokens(),
      registry: new RegistryCredentials(null),
      perTaskCapUsd: 10,
      secret: async () => INSTALL_SECRET,
      restartOntoImage: new ImageRestart({ file, env: { OPENADLC_RELEASE_MIRROR: MIRROR, OPENADLC_HOSTD_IMAGE: OLD_SERVICE }, exit, startedAt: '2026-10-21T09:00:00.000Z' }),
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const { port } = http.address() as AddressInfo;
    server = {
      close: () => new Promise<void>((resolve) => http.close(() => resolve())),
      async call(method, path, body, headers = PLATFORM) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
        });
        return { status: response.status, body: (await response.json()) as Record<string, unknown> };
      },
    };
  });

  afterEach(async () => {
    await server.close();
  });

  it('refuses a caller without the install’s secret, like every other route', async () => {
    expect((await server.call('POST', '/internal/restart-onto-image', { service: SERVICE }, {})).status).toBe(401);
    expect((await server.call('GET', '/internal/restart-onto-image', undefined, {})).status).toBe(401);
    expect(readFileSync(file, 'utf8')).toBe(`${OLD_SERVICE}\n`);
    expect(exit).not.toHaveBeenCalled();
  });

  it('writes the file, answers, and only then exits for systemd to start it on it', async () => {
    const answer = await server.call('POST', '/internal/restart-onto-image', { service: SERVICE });
    expect(answer).toEqual({ status: 202, body: { restarting: true, service: SERVICE } });
    expect(readFileSync(file, 'utf8')).toBe(`${SERVICE}\n`);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(RESTART_EXIT_CODE));
    expect(RESTART_EXIT_CODE).toBe(75);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(expect.objectContaining({ action: 'hostd.restart_onto_image', target: 'openadlc-host', payload: expect.objectContaining({ service: SERVICE }) }));
    // A start between the answer and the exit would be ended with the process.
    expect((await server.call('POST', '/tasks', { taskId: 't1', bot: 'builder' })).status).toBe(503);
  });

  it('refuses while a task runs here, changing nothing, and says so when asked first', async () => {
    active = ['task-1'];
    vi.mocked(tasks.getTask).mockResolvedValue({ id: 'task-1', state: 'running' } as never);
    expect((await server.call('GET', '/internal/restart-onto-image')).body).toMatchObject({ busy: ['task-1'] });
    const answer = await server.call('POST', '/internal/restart-onto-image', { service: SERVICE });
    expect(answer.status).toBe(409);
    expect(String(answer.body.error)).toMatch(/task-1/);
    expect(readFileSync(file, 'utf8')).toBe(`${OLD_SERVICE}\n`);
    expect(exit).not.toHaveBeenCalled();
  });

  it('is not held by a task paused on a person, which keeps its computer but is not running', async () => {
    active = ['task-paused'];
    vi.mocked(tasks.getTask).mockResolvedValue({ id: 'task-paused', state: 'paused' } as never);
    expect((await server.call('GET', '/internal/restart-onto-image')).body).toMatchObject({ busy: [] });
    expect((await server.call('POST', '/internal/restart-onto-image', { service: SERVICE })).status).toBe(202);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(RESTART_EXIT_CODE));
  });

  it('answers before the audit entry is written, and goes once it is or a few seconds pass', async () => {
    let finish: () => void = () => undefined;
    vi.mocked(audit).mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    expect((await server.call('POST', '/internal/restart-onto-image', { service: SERVICE })).status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(exit).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(RESTART_EXIT_CODE));
  });

  it('refuses a reference that is not a mirror digest, changing nothing', async () => {
    for (const body of [
      { service: `${MIRROR}/620legal/openadlc/service:v0.2.0` },
      { service: `docker.io/library/debian@${digest('c')}` },
      { service: `${MIRROR}/620legal/openadlc/console@${digest('a')}` },
      // The bots' image is the host's own, which the engine update keeps.
      { service: SERVICE, bot: `${MIRROR}/620legal/openadlc/bot@${digest('b')}` },
      {},
      'not json',
    ]) {
      expect((await server.call('POST', '/internal/restart-onto-image', body)).status).toBe(400);
    }
    expect(readFileSync(file, 'utf8')).toBe(`${OLD_SERVICE}\n`);
    expect(exit).not.toHaveBeenCalled();
  });

  it('reports the image it runs and when it started, which the bridge waits to see change', async () => {
    expect(await server.call('GET', '/internal/restart-onto-image')).toEqual({ status: 200, body: { service: OLD_SERVICE, startedAt: '2026-10-21T09:00:00.000Z', busy: [] } });
    await server.call('POST', '/internal/restart-onto-image', { service: SERVICE });
    // Still this process's image: the new one runs once systemd has started it again.
    expect((await server.call('GET', '/internal/restart-onto-image')).body).toMatchObject({ service: OLD_SERVICE });
  });
});

describe('a hostd not started from an image file', () => {
  it('says it cannot restart onto an image', async () => {
    const { createHostdServer } = await import('./server.js');
    const { RegistryCredentials } = await import('./registry.js');
    const { AttachTokens } = await import('./attach-tokens.js');
    const http = createHostdServer({
      config: { hostName: 'laptop', driver: 'docker', loginRoot: '/nowhere' } as never,
      driver: { kind: 'docker' } as never,
      runner: { activeTaskIds: () => [], sessionOf: () => null } as never,
      attachTokens: new AttachTokens(),
      registry: new RegistryCredentials(null),
      perTaskCapUsd: 10,
      secret: async () => INSTALL_SECRET,
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const { port } = http.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/internal/restart-onto-image`, { method: 'POST', headers: PLATFORM, body: JSON.stringify({ service: SERVICE }) });
    expect(response.status).toBe(501);
    expect(((await response.json()) as { error: string }).error).toMatch(/OPENADLC_HOSTD_IMAGE_FILE/);
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
});
