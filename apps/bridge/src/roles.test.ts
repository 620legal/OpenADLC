import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AddedHow, Role, User } from '@fleetadlc/db';
import { registerConsoleApi, type ApiDeps } from './api.js';
import { registerBackupRoutes, type BackupRouteDeps } from './backup.js';
import { DispatchGate } from './dispatch-gate.js';
import { registerInternalApi } from './internal-api.js';
import { registerPauseRoutes } from './pause-work.js';
import { authorize, firstAdmins, memberEmail, ROUTE_ROLES, roleFor, routeKey, Roles, type RoleLookup, type UsersStore } from './roles.js';
import { HttpFailure, Router } from './router.js';
import { registerUsersRoutes } from './users-routes.js';

const here = dirname(fileURLToPath(import.meta.url));

/** The console routes as `main.ts` registers them, handlers never run. */
function everyRoute(every = false): string[] {
  const router = new Router();
  registerConsoleApi(router, { config: {} } as unknown as ApiDeps);
  registerPauseRoutes(router, new DispatchGate());
  registerBackupRoutes(router, {} as BackupRouteDeps);
  registerUsersRoutes(router, { roles: { list: async () => [], invalidate: () => undefined }, add: async () => ({}) as User, setRole: async () => ({}) as User, remove: async () => undefined, identityMode: 'local' });
  // Its routes are `/internal/*` behind the install's secret, but a `/v1`
  // route registered through its own `post` helper would be served all the same.
  registerInternalApi(router, { config: {}, internalSecret: 'x' } as unknown as Parameters<typeof registerInternalApi>[1]);
  return router
    .table()
    .filter((route) => every || route.path.startsWith('/v1/'))
    .map((route) => routeKey(route.method, route.path));
}

/** Every `/v1` route written anywhere in the bridge's source, registered by the walk above or not. */
function everyRouteInSource(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        const source = readFileSync(path, 'utf8');
        // `router.post(`, and a module's own helper around it (`post(`, `taskPost(`).
        for (const match of source.matchAll(/\b(?:router\.)?(?:task)?(get|post|patch|Post|Get|Patch)\(\s*'(\/v1\/[^']*)'/g)) found.push(routeKey(match[1]!.toUpperCase(), match[2]!));
        for (const match of source.matchAll(/router\.add\(\s*'([A-Z]+)',\s*'(\/v1\/[^']*)'/g)) found.push(routeKey(match[1]!, match[2]!));
      }
    }
  };
  walk(here);
  return [...new Set(found)];
}

describe('every console route says who may call it', () => {
  it('has a role in ROUTE_ROLES for each route the router serves', () => {
    const routes = everyRoute();
    expect(routes.length).toBeGreaterThan(80);
    const unclassified = routes.filter((key) => !(key in ROUTE_ROLES));
    // A route added without a role here still needs an admin, but the choice
    // should be made, not inherited: add it to ROUTE_ROLES in roles.ts.
    expect(unclassified).toEqual([]);
  });

  it('walks the internal API as well as the console’s routes', () => {
    expect(everyRoute(true)).toEqual(expect.arrayContaining(['POST /webhooks/github', 'GET /healthz']));
  });

  it('classifies routes written in any file, including one main.ts registers that this walk does not', () => {
    const unclassified = everyRouteInSource().filter((key) => !(key in ROUTE_ROLES));
    expect(unclassified).toEqual([]);
  });

  it('names no route the bridge does not have, so the table cannot drift into fiction', () => {
    const served = new Set([...everyRoute(), ...everyRouteInSource()]);
    expect(Object.keys(ROUTE_ROLES).filter((key) => !served.has(key))).toEqual([]);
  });

  it('needs an admin for a route nobody classified', () => {
    expect(roleFor('POST', '/v1/something/new')).toBe('admin');
  });

  it('lets a user create and run work, and keeps the install and card moves an admin’s', () => {
    for (const key of ['POST /v1/requests', 'POST /v1/gates/:id/answer', 'POST /v1/tasks/:id/stop', 'POST /v1/tasks/:id/retry', 'GET /v1/costs', 'GET /v1/work/pause']) {
      expect(ROUTE_ROLES[key], key).toBe('user');
    }
    for (const key of [
      'POST /v1/board/move',
      'PATCH /v1/install',
      'PATCH /v1/spending/limits',
      'POST /v1/work/pause',
      'POST /v1/work/resume',
      'POST /v1/backup',
      'POST /v1/terminal/:bot/:session/token',
      'POST /v1/users',
      'POST /v1/repos/:repo/deploys/:sha/release',
      'POST /v1/repos/:repo/delivery/automatic',
    ]) {
      expect(ROUTE_ROLES[key], key).toBe('admin');
    }
  });
});

describe('the bridge enforces the role on every route', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  /** Every classified route, answering 200 when it runs, behind the real check. */
  async function serve(people: Record<string, Role>): Promise<{ url: string; ran: string[] }> {
    const ran: string[] = [];
    const lookup: RoleLookup = {
      roleOf: async (identity) => people[identity] ?? null,
      admins: async () => Object.keys(people).filter((person) => people[person] === 'admin'),
      refused: async () => undefined,
    };
    const router = new Router(undefined, undefined, undefined, (method, path, identity) => authorize(lookup, method, path, identity));
    for (const key of Object.keys(ROUTE_ROLES)) {
      const [method, path] = key.split(' ') as [string, string];
      router.add(method, path, async ({ role }) => {
        ran.push(key);
        return { ok: true, role };
      });
    }
    server = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ran };
  }

  const concrete = (path: string) => path.replace(/:[a-zA-Z]+/g, 'x');
  const call = (url: string, key: string, identity: string) => {
    const [method, path] = key.split(' ') as [string, string];
    return fetch(`${url}${concrete(path)}`, {
      method,
      headers: { 'x-fleetadlc-identity': identity, 'content-type': 'application/json' },
      ...(method === 'GET' ? {} : { body: '{}' }),
    });
  };

  it('refuses a user every admin route with "this needs an admin", before its handler runs, and serves every user route', async () => {
    const { url, ran } = await serve({ 'jane@example.com': 'user' });
    for (const [key, needed] of Object.entries(ROUTE_ROLES)) {
      const response = await call(url, key, 'jane@example.com');
      if (needed === 'admin') {
        expect(response.status, key).toBe(403);
        expect(await response.json(), key).toMatchObject({ error: 'this needs an admin', code: 'needs-admin' });
      } else {
        expect(response.status, key).toBe(200);
        expect(await response.json(), key).toMatchObject({ role: 'user' });
      }
    }
    expect(ran.sort()).toEqual(Object.keys(ROUTE_ROLES).filter((key) => ROUTE_ROLES[key] === 'user').sort());
  });

  it('serves an admin every route', async () => {
    const { url } = await serve({ 'admin@example.com': 'admin' });
    for (const key of Object.keys(ROUTE_ROLES)) expect((await call(url, key, 'admin@example.com')).status, key).toBe(200);
  });

  it('refuses someone unknown everything, as not-a-user, naming whom to ask', async () => {
    const { url, ran } = await serve({ 'admin@example.com': 'admin' });
    for (const key of ['GET /v1/me', 'GET /v1/board', 'PATCH /v1/install']) {
      const response = await call(url, key, 'stranger@example.com');
      expect(response.status, key).toBe(403);
      expect(await response.json()).toMatchObject({
        code: 'not-a-user',
        email: 'stranger@example.com',
        admins: ['admin@example.com'],
        error: expect.stringContaining('Ask an admin to add you in Settings → Users'),
      });
    }
    expect(ran).toEqual([]);
  });
});

/** `users` in memory, with the store's rule: the first admins only while it is empty. */
function memoryStore(initial: User[] = []): UsersStore & { rows: User[]; bootstraps: number } {
  const store = {
    rows: [...initial],
    bootstraps: 0,
    listUsers: async () => [...store.rows],
    bootstrapAdmins: async (emails: readonly string[], how: Exclude<AddedHow, 'added'>, actor: string) => {
      store.bootstraps += 1;
      if (store.rows.length > 0) return [];
      const added = emails.map((email) => ({ email, role: 'admin' as const, addedBy: actor, addedHow: how, addedAt: '', updatedAt: '' }));
      store.rows.push(...added);
      return added;
    },
  };
  return store;
}

const user = (email: string, role: Role): User => ({ email, role, addedBy: 'x', addedHow: 'added', addedAt: '', updatedAt: '' });

describe('the first admin', () => {
  it('in the cloud with neither list is nobody: everyone is refused with no-admin, told to set admin_emails, and audited', async () => {
    const store = memoryStore();
    const audited: string[] = [];
    const roles = new Roles({ mode: 'iap', adminEmails: [], consoleMembers: ['group:crew@example.com'], store, audit: async (entry) => void audited.push(`${entry.action} ${entry.target} ${String(entry.payload?.reason)}`) });
    for (const person of ['JaneDoe@Example.com', 'bob@example.com', 'janedoe@example.com']) {
      const refusal = await authorize(roles, 'GET', '/v1/me', person).then(() => null, (error: unknown) => error as HttpFailure);
      expect(refusal?.status).toBe(403);
      expect(refusal?.details).toMatchObject({ code: 'no-admin' });
      expect(refusal?.message).toContain('Set admin_emails');
    }
    expect(store.rows).toEqual([]);
    // Once a day each, not once a request.
    expect(audited).toEqual(['user.refused janedoe@example.com no-admin', 'user.refused bob@example.com no-admin']);
  });

  it('on a local install is the first identity to arrive; a second one is not added', async () => {
    const store = memoryStore();
    const roles = new Roles({ mode: 'local', adminEmails: [], consoleMembers: [], store, audit: async () => undefined });
    expect(await roles.roleOf('console')).toBe('admin');
    expect(await roles.roleOf('integration test')).toBe('admin');
    expect(store.rows.map((row) => [row.email, row.addedHow])).toEqual([['console', 'first']]);
    expect(store.bootstraps).toBe(1);
  });

  it('is everyone in FLEETADLC_ADMIN_EMAILS when it names anyone, written with user: or not, and not whoever arrives first', async () => {
    const store = memoryStore();
    const roles = new Roles({ mode: 'iap', adminEmails: ['user:Jane@Example.com', 'carol@example.com'], consoleMembers: ['user:bob@example.com'], store, audit: async () => undefined });
    expect(await roles.roleOf('bob@example.com')).toBeNull();
    expect(store.rows.map((row) => [row.email, row.addedHow])).toEqual([['jane@example.com', 'admin-emails'], ['carol@example.com', 'admin-emails']]);
    expect(await roles.roleOf('jane@example.com')).toBe('admin');
    expect(await roles.roleOf('carol@example.com')).toBe('admin');
    // Refused as a stranger now that there is an admin to ask.
    expect(await roles.refusal()).toBe('not-a-user');
  });

  it("is every person among the console's IAP members when there is no list, and no group", async () => {
    expect(firstAdmins({ mode: 'iap', adminEmails: [], consoleMembers: ['user:Jane@Example.com', 'group:crew@example.com', 'domain:example.com'] }, 'bob@example.com')).toEqual([
      ['jane@example.com'],
      'console-members',
    ]);
    // Only groups: nobody named. The cloud adds nobody; a local install its first visitor.
    expect(firstAdmins({ mode: 'iap', adminEmails: [], consoleMembers: ['group:crew@example.com'] }, 'bob@example.com')).toBeNull();
    expect(firstAdmins({ mode: 'local', adminEmails: [], consoleMembers: [] }, 'bob')).toEqual([['bob'], 'first']);
    expect(memberEmail('serviceAccount:ci@exampleco.iam.gserviceaccount.com')).toBeNull();
    expect(firstAdmins({ mode: 'iap', adminEmails: ['group:admins@example.com'], consoleMembers: [] }, 'bob@example.com')).toBeNull();
  });

  it('is decided once, even when the first requests arrive together', async () => {
    const store = memoryStore();
    const roles = new Roles({ mode: 'local', adminEmails: [], consoleMembers: [], store, audit: async () => undefined });
    await Promise.all([roles.roleOf('jane'), roles.roleOf('bob')]);
    expect(store.rows.map((row) => row.email)).toEqual(['jane']);
    expect(store.bootstraps).toBe(1);
  });
});

describe('looking a person up', () => {
  it('reads the role by a lower-cased email, and sees a change once it is cleared', async () => {
    const store = memoryStore([user('admin@example.com', 'admin'), user('jane@example.com', 'user')]);
    const roles = new Roles({ mode: 'iap', adminEmails: [], consoleMembers: [], store, audit: async () => undefined, cacheMs: 60_000 });
    expect(await roles.roleOf('accounts.google.com:Jane@Example.com')).toBe('user');
    store.rows[1] = user('jane@example.com', 'admin');
    expect(await roles.roleOf('jane@example.com')).toBe('user');
    roles.invalidate();
    expect(await roles.roleOf('jane@example.com')).toBe('admin');
    expect(await roles.admins()).toEqual(['admin@example.com', 'jane@example.com']);
  });

  it('does not keep a read a change overtook: the admin who made the change sees it at once', async () => {
    let release: () => void = () => undefined;
    const rows = [user('admin@example.com', 'admin'), user('jane@example.com', 'admin')];
    let slow = true;
    const store: UsersStore = {
      listUsers: async () => {
        const snapshot = rows.map((row) => ({ ...row }));
        if (slow) await new Promise<void>((resolve) => (release = resolve));
        return snapshot;
      },
      bootstrapAdmins: async () => [],
    };
    const roles = new Roles({ mode: 'iap', adminEmails: [], consoleMembers: [], store, audit: async () => undefined, cacheMs: 60_000 });
    // A read starts before Jane is demoted and finishes after.
    const before = roles.roleOf('jane@example.com');
    await Promise.resolve();
    rows[1] = user('jane@example.com', 'user');
    roles.invalidate();
    slow = false;
    expect(await roles.roleOf('jane@example.com')).toBe('user');
    release();
    expect(await before).toBe('admin');
    // The stale read answered its own request and was not cached.
    expect(await roles.roleOf('jane@example.com')).toBe('user');
  });

  it('audits a refused stranger once a day, not on every request', async () => {
    const audited: string[] = [];
    let now = new Date('2026-09-30T10:00:00Z');
    const roles = new Roles({ mode: 'iap', adminEmails: [], consoleMembers: [], store: memoryStore([user('admin@example.com', 'admin')]), audit: async (entry) => void audited.push(`${entry.action} ${entry.target}`), now: () => now });
    await roles.refused('Stranger@example.com');
    await roles.refused('stranger@example.com');
    expect(audited).toEqual(['user.refused stranger@example.com']);
    now = new Date('2026-10-01T09:00:00Z');
    await roles.refused('stranger@example.com');
    expect(audited).toHaveLength(2);
  });
});

describe('Settings → Users', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it('says who is asking, and says a refused change as a status, clearing what roles read either way', async () => {
    const { UserChangeRefused } = await import('@fleetadlc/db');
    let cleared = 0;
    const router = new Router(undefined, undefined, undefined, async () => 'admin');
    registerUsersRoutes(router, {
      roles: { list: async () => [user('jane@example.com', 'admin')], invalidate: () => void (cleared += 1) },
      add: async (email, role) => user(email, role),
      setRole: async (email) => {
        throw new UserChangeRefused('last-admin', `${email} is the only admin. Make someone else an admin first`);
      },
      remove: async () => undefined,
      identityMode: 'iap',
    });
    server = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const as = { 'x-fleetadlc-identity': 'Jane@Example.com', 'content-type': 'application/json' };

    expect(await (await fetch(`${url}/v1/me`, { headers: as })).json()).toEqual({ email: 'jane@example.com', role: 'admin', identityMode: 'iap' });

    const demoted = await fetch(`${url}/v1/users/jane%40example.com`, { method: 'PATCH', headers: as, body: JSON.stringify({ role: 'user' }) });
    expect(demoted.status).toBe(409);
    expect(await demoted.json()).toMatchObject({ code: 'last-admin', error: expect.stringContaining('only admin') });

    const bad = await fetch(`${url}/v1/users`, { method: 'POST', headers: as, body: JSON.stringify({ email: 'bob@example.com', role: 'owner' }) });
    expect(bad.status).toBe(400);

    const added = await fetch(`${url}/v1/users`, { method: 'POST', headers: as, body: JSON.stringify({ email: 'bob@example.com', role: 'user' }) });
    expect(await added.json()).toMatchObject({ user: { email: 'bob@example.com', role: 'user' } });
    expect(cleared).toBe(2);
  });
});
