import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { Role } from '@openadlc/db';
import { Identity } from './identity.js';
import { authorize, type RoleLookup } from './roles.js';
import { Router } from './router.js';
import { registerTaskPostgresRoutes, taskPostgresSupport, type TaskPostgresGitHub, type TaskPostgresRouteDeps } from './task-postgres-routes.js';

/** acme/app's docker-compose.yml on main. */
const APP_COMPOSE = `services:
  postgres:
    image: pgvector/pgvector:pg16
    environment: { POSTGRES_USER: app, POSTGRES_PASSWORD: app, POSTGRES_DB: app_db }
    ports: ['55432:5432']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U app -d app_db']
      interval: 2s
      timeout: 3s
      retries: 30
`;

/** acme/app's local Postgres, as its docker-compose.yml and Makefile name it. */
const APP = { port: 55432, superuser: 'app', password: 'app', database: 'app_db', image: 'pgvector/pgvector:pg16' };
const REPO = { id: 'repo-app', name: 'app', fullName: 'acme/app', defaultBranch: 'main' };
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
  options: Parameters<typeof serve>[1] & { path?: string } = {},
) {
  const { url, close } = await serve(deps, options);
  try {
    const response = await fetch(`${url}${options.path ?? '/v1/repos/app/task-postgres'}`, {
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
  it('saves app’s server, and answers what is stored and that this install can give it', async () => {
    const { deps, store } = world();

    const saved = await call(deps, 'PUT', { servers: [APP] });

    expect(saved.status).toBe(200);
    expect(store.value).toEqual({ servers: [APP], databaseUrl: 'none' });
    expect(saved.body).toMatchObject({
      taskPostgres: { servers: [APP], databaseUrl: 'none' },
      unreadable: null,
      supported: { ok: true, why: null },
      images: ['pgvector/pgvector:<tag>', 'postgres:<tag>'],
      env: 'OPENADLC_TASK_POSTGRES',
    });
    expect((await call(deps, 'GET')).body).toMatchObject({ taskPostgres: { servers: [APP] } });
  });

  it('audits who set it and to what, with no password in the log', async () => {
    const { deps, audited } = world();

    await call(deps, 'PUT', { servers: [{ ...APP, password: 'local-default' }] });

    expect(audited).toEqual([
      {
        actor: 'or@example.com',
        action: 'repo.task_postgres',
        target: 'acme/app',
        payload: { setting: { servers: [{ port: 55432, superuser: 'app', database: 'app_db', image: 'pgvector/pgvector:pg16' }], databaseUrl: 'none' } },
      },
    ]);
    expect(JSON.stringify(audited)).not.toContain('local-default');
  });

  it('refuses an image outside the allowlist with what to do, and writes nothing', async () => {
    const { deps, store } = world({}, { servers: [APP] });

    const refused = await call(deps, 'PUT', { servers: [{ ...APP, image: 'someone/postgres:16' }] });

    expect(refused.status).toBe(400);
    expect(String(refused.body.error)).toBe(
      "someone/postgres:16 is not an image a task's server may run: use pgvector/pgvector:<tag> or postgres:<tag>, such as pgvector/pgvector:pg16, " +
        'and pin it by adding @sha256:<digest> (docker buildx imagetools inspect <image> prints it)',
    );
    expect(deps.write).not.toHaveBeenCalled();
    expect(store.value).toEqual({ servers: [APP] });
  });

  it('takes the servers away when sent none', async () => {
    const { deps, store } = world({}, { servers: [APP], databaseUrl: 'none' });

    const cleared = await call(deps, 'PUT', { servers: [] });

    expect(cleared.status).toBe(200);
    expect(store.value).toBeNull();
    expect(cleared.body.taskPostgres).toBeNull();
  });

  it('shows a stored setting that no longer reads as that, so it can be corrected', async () => {
    const { deps } = world({}, { servers: [{ ...APP, image: 'evil/pg:1' }] });

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

    const refused = await call(deps, 'PUT', { servers: [APP] }, { 'x-openadlc-identity': 'jane@example.com' }, { people: { 'jane@example.com': 'user' } });

    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: 'this needs an admin', code: 'needs-admin' });
    expect(deps.write).not.toHaveBeenCalled();
  });

  it('refuses a caller without the console secret — what a task’s container would be — whatever name it gives', async () => {
    const { deps } = world();

    const refused = await call(deps, 'PUT', { servers: [APP] }, { 'x-openadlc-identity': 'or@example.com' }, { consoleSecret: 'the-console-secret' });
    expect(refused.status).toBe(401);
    expect(deps.write).not.toHaveBeenCalled();

    const person = await call(
      deps,
      'PUT',
      { servers: [APP] },
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

    const saved = await call(deps, 'PUT', { servers: [APP] });

    expect(saved.status).toBe(200);
    expect(saved.body.supported).toMatchObject({ ok: false });
  });
});

describe('where a task’s DATABASE_URL comes from, as the bridge answers it', () => {
  /** A second server of app's, for its vector store, as a docker-compose.yml with two Postgres services has it. */
  const VECTORS = { ...APP, port: 55433, password: 'vectors-local', database: 'vectors' };

  it('is nothing for a repository with nothing set, and for a stored row with no servers whatever it says', async () => {
    expect((await call(world().deps, 'GET')).body).toMatchObject({ taskPostgres: null, unreadable: null });
    // A row written by hand: no servers is no setting, so it gives no DATABASE_URL.
    expect((await call(world({}, { servers: [], sharedDatabase: true }).deps, 'GET')).body).toMatchObject({ taskPostgres: null, unreadable: null });
  });

  it('reads a row stored before there was a choice of server as it did, and stores an old client’s box as the choice it means', async () => {
    expect((await call(world({}, { servers: [APP], sharedDatabase: true }).deps, 'GET')).body).toMatchObject({ taskPostgres: { databaseUrl: 'shared' } });
    expect((await call(world({}, { servers: [APP], sharedDatabase: false }).deps, 'GET')).body).toMatchObject({ taskPostgres: { databaseUrl: 'none' } });

    const { deps, store } = world();
    const saved = await call(deps, 'PUT', { servers: [APP], sharedDatabase: true });
    expect(saved.status).toBe(200);
    expect(store.value).toEqual({ servers: [APP], databaseUrl: 'shared' });
  });

  it('saves one of the repository’s own servers as it, answers it back, and audits it with no password', async () => {
    const { deps, store, audited } = world();

    const saved = await call(deps, 'PUT', { servers: [APP, VECTORS], databaseUrl: { port: 55433 } });

    expect(saved.status).toBe(200);
    expect(store.value).toEqual({ servers: [APP, VECTORS], databaseUrl: { port: 55433 } });
    expect(saved.body.taskPostgres).toEqual({ servers: [APP, VECTORS], databaseUrl: { port: 55433 } });
    expect((await call(deps, 'GET')).body.taskPostgres).toEqual({ servers: [APP, VECTORS], databaseUrl: { port: 55433 } });
    expect(audited[0]?.payload).toEqual({
      setting: {
        servers: [APP, VECTORS].map(({ password: _password, ...rest }) => rest),
        databaseUrl: { port: 55433 },
      },
    });
    expect(JSON.stringify(audited)).not.toContain('vectors-local');
  });

  it('refuses one that names none of the servers, with what to send, and writes nothing', async () => {
    const { deps, store } = world({}, { servers: [APP], sharedDatabase: true });

    const refused = await call(deps, 'PUT', { servers: [APP], databaseUrl: { port: 55433 } });

    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe(
      "DATABASE_URL is to come from the server on 55433, and none of the servers listens there: name one of theirs (55432), or send databaseUrl 'shared' or 'none'",
    );
    expect(deps.write).not.toHaveBeenCalled();
    expect(store.value).toEqual({ servers: [APP], sharedDatabase: true });
  });

  it('says beside it, under the local driver, that a task gets no such DATABASE_URL either', async () => {
    const { deps } = world({ hosts: async () => [{ name: 'laptop', driver: 'local', status: 'up', lastSeenAt: seen(1) }] }, { servers: [APP], databaseUrl: { port: 55432 } });

    const read = await call(deps, 'GET');

    expect(read.body.supported).toMatchObject({ ok: false });
    expect(String((read.body.supported as { why: string }).why)).toContain('a task here starts without one, and without the DATABASE_URL one of them would give');
  });
});

describe('filling the form from the repository’s Compose file', () => {
  /** GitHub as the automation account reads it: the files on each ref, and what it throws for one. */
  function github(files: Record<string, string>, throws: Record<string, Error> = {}) {
    const asked: { repo: string; path: string; ref: string }[] = [];
    const client: TaskPostgresGitHub['client'] = {
      readFileIfPresent: async (repo, path, ref) => {
        asked.push({ repo, path, ref });
        if (throws[path]) throw throws[path];
        return files[`${ref}:${path}`] ?? null;
      },
    };
    return { asked, github: async (): Promise<TaskPostgresGitHub> => ({ account: 'openadlc-flow-janedoe', client }) };
  }
  const compose = (deps: TaskPostgresRouteDeps, headers?: Record<string, string>, options: Parameters<typeof serve>[1] = {}) =>
    call(deps, 'GET', undefined, headers, { ...options, path: '/v1/repos/app/task-postgres/compose' });

  it('reads app’s docker-compose.yml from its default branch and suggests its server, saving and auditing nothing', async () => {
    const reads = github({ 'main:docker-compose.yml': APP_COMPOSE });
    const { deps, store, audited } = world({ github: reads.github });

    const read = await compose(deps);

    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      ok: true,
      file: 'docker-compose.yml',
      branch: 'main',
      servers: [{ service: 'postgres', ...APP, notes: [], refusal: null }],
      notes: [],
    });
    expect(reads.asked.map((one) => `${one.repo}@${one.ref}:${one.path}`)).toEqual([
      'acme/app@main:compose.yaml',
      'acme/app@main:compose.yml',
      'acme/app@main:docker-compose.yml',
      'acme/app@main:docker-compose.yaml',
    ]);
    expect(deps.write).not.toHaveBeenCalled();
    expect(store.value).toBeNull();
    expect(audited).toEqual([]);
  });

  it('reads the branch GitHub says is the default, and the file Compose prefers there', async () => {
    const reads = github({
      'trunk:compose.yaml': APP_COMPOSE.replace('55432:5432', '55440:5432'),
      'trunk:docker-compose.yml': APP_COMPOSE,
      'main:compose.yaml': APP_COMPOSE.replace('55432:5432', '1:5432'),
    });
    const { deps } = world({ github: reads.github, repo: async () => ({ ...REPO, defaultBranch: 'trunk' }) });

    const read = await compose(deps);

    expect(read.body).toMatchObject({ ok: true, file: 'compose.yaml', branch: 'trunk', servers: [{ port: 55440 }] });
  });

  it('suggests an image outside the allowlist with the refusal a save would give', async () => {
    const reads = github({ 'main:docker-compose.yml': APP_COMPOSE.replace('pgvector/pgvector:pg16', 'ankane/pgvector:latest') });
    const { deps } = world({ github: reads.github });

    const read = await compose(deps);
    const saved = await call(deps, 'PUT', { servers: [{ ...APP, image: 'ankane/pgvector:latest' }] });

    expect(read.body).toMatchObject({ ok: true, servers: [{ image: 'ankane/pgvector:latest' }] });
    expect((read.body.servers as { refusal: string }[])[0]?.refusal).toBe(saved.body.error);
  });

  it('says a file with no Postgres service has none', async () => {
    const reads = github({ 'main:docker-compose.yml': 'services:\n  cache:\n    image: redis:7\n' });
    const read = await compose(world({ github: reads.github }).deps);
    expect(read.body).toEqual({
      ok: false,
      file: 'docker-compose.yml',
      branch: 'main',
      why: 'docker-compose.yml has no Postgres service: none of its services runs pgvector/pgvector or postgres (cache (redis:7))',
    });
  });

  it('says a file that does not read cannot be filled from', async () => {
    const reads = github({ 'main:docker-compose.yml': 'services:\n  db: [unclosed\n' });
    const read = await compose(world({ github: reads.github }).deps);
    expect(read.body).toMatchObject({ ok: false, file: 'docker-compose.yml', branch: 'main' });
    expect(String(read.body.why)).toMatch(/^docker-compose\.yml does not read as YAML: /);
  });

  it('says a file GitHub would not give could not be read, rather than taking one Compose prefers less', async () => {
    const reads = github({ 'main:docker-compose.yml': APP_COMPOSE }, { 'compose.yaml': new Error('GitHub answered 502') });
    const read = await compose(world({ github: reads.github }).deps);
    expect(read.body).toEqual({ ok: false, file: 'compose.yaml', branch: 'main', why: 'compose.yaml on main could not be read from GitHub (GitHub answered 502): try again' });
  });

  it('says a repository with no Compose file has none', async () => {
    const read = await compose(world({ github: github({}).github }).deps);
    expect(read.body).toEqual({
      ok: false,
      file: null,
      branch: 'main',
      why: 'acme/app has no Compose file on main: none of compose.yaml, compose.yml, docker-compose.yml, docker-compose.yaml',
    });
  });

  it('says what to run when the account the bridge reads GitHub with is not connected', async () => {
    const read = await compose(world({ github: async () => ({ account: 'openadlc-flow-janedoe', client: null }) }).deps);
    expect(read.body).toMatchObject({
      ok: false,
      why: "openadlc-flow-janedoe is not connected to GitHub, so the repository's Compose file cannot be read. Run: openadlc auth login --bot openadlc-flow-janedoe",
    });
  });

  it('is an admin’s, since it shows the file’s passwords', async () => {
    const reads = github({ 'main:docker-compose.yml': APP_COMPOSE });
    const refused = await compose(world({ github: reads.github }).deps, { 'x-openadlc-identity': 'jane@example.com' }, { people: { 'jane@example.com': 'user' } });
    expect(refused.status).toBe(403);
    expect(reads.asked).toEqual([]);
  });
});
