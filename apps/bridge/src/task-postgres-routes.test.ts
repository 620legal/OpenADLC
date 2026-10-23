import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { Role } from '@openadlc/db';
import { Identity } from './identity.js';
import { authorize, type RoleLookup } from './roles.js';
import { Router } from './router.js';
import { registerTaskPostgresRoutes, taskPostgresSupport, type TaskPostgresRouteDeps } from './task-postgres-routes.js';

/** 620legal/core's local Postgres, as its docker-compose.yml and Makefile name it. */
const CORE = { port: 55432, superuser: 'core', password: 'core', database: 'core_db', image: 'pgvector/pgvector:pg16' };
const REPO = { id: 'repo-core', name: 'core', fullName: '620legal/core' };
const NOW = Date.parse('2026-10-23T12:00:00Z');
const seen = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();

function world(over: Partial<TaskPostgresRouteDeps> = {}, stored: unknown = null) {
  const store = { value: stored };
  const audited: { actor: string; action: string; target: string; payload?: Record<string, unknown> }[] = [];
  const deps: TaskPostgresRouteDeps = {
    repo: async (name) => (name === REPO.name ? REPO : null),
    read: async () => store.value,
    write: vi.fn(async (_repoId, setting) => void (store.value = setting)),
    hosts: async () => [{ name: 'host-1', driver: 'docker', status: 'up', lastSeenAt: seen(5) }],
    audit: async (entry) => void audited.push(entry),
    now: () => NOW,
    ...over,
  };
  return { deps, store, audited };
}

/** The routes behind the bridge's own checks: who is asking, and what their role lets them do. */
async function serve(
  deps: TaskPostgresRouteDeps,
  options: { people?: Record<string, Role>; consoleSecret?: string } = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const people = options.people ?? { 'or@example.com': 'admin' };
  const lookup: RoleLookup = {
    roleOf: async (identity) => people[identity] ?? null,
    admins: async () => Object.keys(people).filter((person) => people[person] === 'admin'),
    refused: async () => undefined,
  };
  const identity = options.consoleSecret !== undefined ? new Identity('local', '', options.consoleSecret) : undefined;
  const router = new Router(identity, [], undefined, (method, path, who) => authorize(lookup, method, path, who));
  registerTaskPostgresRoutes(router, deps);
  const server = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function call(
  deps: TaskPostgresRouteDeps,
  method: 'GET' | 'PUT',
  body?: unknown,
  headers: Record<string, string> = { 'x-openadlc-identity': 'or@example.com' },
  options: Parameters<typeof serve>[1] = {},
) {
  const { url, close } = await serve(deps, options);
  try {
    const response = await fetch(`${url}/v1/repos/core/task-postgres`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  } finally {
    await close();
  }
}

describe('a repository’s Postgres servers for its tasks, set by a person', () => {
  it('saves core’s server, and answers what is stored and that this install can give it', async () => {
    const { deps, store } = world();

    const saved = await call(deps, 'PUT', { servers: [CORE] });

    expect(saved.status).toBe(200);
    expect(store.value).toEqual({ servers: [CORE], sharedDatabase: false });
    expect(saved.body).toMatchObject({
      taskPostgres: { servers: [CORE], sharedDatabase: false },
      unreadable: null,
      supported: { ok: true, why: null },
      images: ['pgvector/pgvector:<tag>', 'postgres:<tag>'],
      env: 'OPENADLC_TASK_POSTGRES',
    });
    expect((await call(deps, 'GET')).body).toMatchObject({ taskPostgres: { servers: [CORE] } });
  });

  it('audits who set it and to what, with no password in the log', async () => {
    const { deps, audited } = world();

    await call(deps, 'PUT', { servers: [{ ...CORE, password: 'local-default' }] });

    expect(audited).toEqual([
      {
        actor: 'or@example.com',
        action: 'repo.task_postgres',
        target: '620legal/core',
        payload: { setting: { servers: [{ port: 55432, superuser: 'core', database: 'core_db', image: 'pgvector/pgvector:pg16' }], sharedDatabase: false } },
      },
    ]);
    expect(JSON.stringify(audited)).not.toContain('local-default');
  });

  it('refuses an image outside the allowlist with what to do, and writes nothing', async () => {
    const { deps, store } = world({}, { servers: [CORE] });

    const refused = await call(deps, 'PUT', { servers: [{ ...CORE, image: 'someone/postgres:16' }] });

    expect(refused.status).toBe(400);
    expect(String(refused.body.error)).toBe(
      "someone/postgres:16 is not an image a task's server may run: use pgvector/pgvector:<tag> or postgres:<tag>, such as pgvector/pgvector:pg16, " +
        'and pin it by adding @sha256:<digest> (docker buildx imagetools inspect <image> prints it)',
    );
    expect(deps.write).not.toHaveBeenCalled();
    expect(store.value).toEqual({ servers: [CORE] });
  });

  it('takes the servers away when sent none', async () => {
    const { deps, store } = world({}, { servers: [CORE], sharedDatabase: false });

    const cleared = await call(deps, 'PUT', { servers: [] });

    expect(cleared.status).toBe(200);
    expect(store.value).toBeNull();
    expect(cleared.body.taskPostgres).toBeNull();
  });

  it('shows a stored setting that no longer reads as that, so it can be corrected', async () => {
    const { deps } = world({}, { servers: [{ ...CORE, image: 'evil/pg:1' }] });

    const read = await call(deps, 'GET');

    expect(read.body.taskPostgres).toBeNull();
    expect(String(read.body.unreadable)).toContain('evil/pg:1 is not an image');
  });

  it('answers 404 for a repository OpenADLC does not work in', async () => {
    const { deps } = world({ repo: async () => null });
    expect((await call(deps, 'GET')).status).toBe(404);
  });
});

describe('who may set it', () => {
  it('refuses a user who is not an admin, and writes nothing', async () => {
    const { deps } = world();

    const refused = await call(deps, 'PUT', { servers: [CORE] }, { 'x-openadlc-identity': 'jane@example.com' }, { people: { 'jane@example.com': 'user' } });

    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: 'this needs an admin', code: 'needs-admin' });
    expect(deps.write).not.toHaveBeenCalled();
  });

  it('refuses a caller without the console secret — what a task’s container would be — whatever name it gives', async () => {
    const { deps } = world();

    const refused = await call(deps, 'PUT', { servers: [CORE] }, { 'x-openadlc-identity': 'or@example.com' }, { consoleSecret: 'the-console-secret' });
    expect(refused.status).toBe(401);
    expect(deps.write).not.toHaveBeenCalled();

    const person = await call(
      deps,
      'PUT',
      { servers: [CORE] },
      { 'x-openadlc-identity': 'or@example.com', 'x-openadlc-console-secret': 'the-console-secret' },
      { consoleSecret: 'the-console-secret' },
    );
    expect(person.status).toBe(200);
  });
});

describe('whether this install can give a task a server of its own', () => {
  it('can when a live host runs the docker driver', () => {
    expect(taskPostgresSupport([{ name: 'host-1', driver: 'docker', status: 'up', lastSeenAt: seen(10) }], NOW)).toEqual({ ok: true, why: null });
  });

  it('says it cannot, and what to do, when every live host runs the local driver', () => {
    const support = taskPostgresSupport(
      [
        { name: 'laptop', driver: 'local', status: 'up', lastSeenAt: seen(10) },
        { name: 'old-vm', driver: 'docker', status: 'up', lastSeenAt: seen(3600) },
      ],
      NOW,
    );
    expect(support.ok).toBe(false);
    expect(support.why).toContain('laptop runs the local driver, which has no containers to make a server in');
    expect(support.why).toContain('openadlc init --driver docker');
  });

  it('does not say either way when no host is live', () => {
    expect(taskPostgresSupport([{ name: 'old-vm', driver: 'docker', status: 'up', lastSeenAt: seen(3600) }], NOW).ok).toBeNull();
    expect(taskPostgresSupport([], NOW).ok).toBeNull();
  });

  it('is said beside the setting the install cannot honour, not in silence', async () => {
    const { deps } = world({ hosts: async () => [{ name: 'laptop', driver: 'local', status: 'up', lastSeenAt: seen(1) }] });

    const saved = await call(deps, 'PUT', { servers: [CORE] });

    expect(saved.status).toBe(200);
    expect(saved.body.supported).toMatchObject({ ok: false });
  });
});
