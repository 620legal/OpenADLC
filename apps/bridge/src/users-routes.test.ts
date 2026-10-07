import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Role, User } from '@fleetadlc/db';
import type { IdentityMode } from './identity.js';
import { Router } from './router.js';
import { registerUsersRoutes } from './users-routes.js';

/**
 * On a local install every console request is one identity, so the console
 * demoting itself would leave Settings saying it needs an admin for good.
 */

const user = (email: string, role: Role): User => ({ email, role, addedBy: 'x', addedHow: 'added', addedAt: '', updatedAt: '' });

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

/** The users routes in this mode over a store of two admins, and what each change did to it. */
async function serve(identityMode: IdentityMode) {
  const roles = new Map<string, Role>([
    ['console', 'admin'],
    ['me@example.com', 'admin'],
  ]);
  const removed: string[] = [];
  const router = new Router(undefined, undefined, undefined, async () => 'admin');
  registerUsersRoutes(router, {
    roles: { list: async () => [...roles].map(([email, role]) => user(email, role)), invalidate: () => undefined },
    add: async (email, role) => (roles.set(email, role), user(email, role)),
    setRole: async (email, role) => (roles.set(email, role), user(email, role)),
    remove: async (email) => void (roles.delete(email), removed.push(email)),
    identityMode,
  });
  server = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const as = (identity: string) => ({ 'x-fleetadlc-identity': identity, 'content-type': 'application/json' });
  const setRole = (identity: string, email: string, role: Role) =>
    fetch(`${url}/v1/users/${encodeURIComponent(email)}`, { method: 'PATCH', headers: as(identity), body: JSON.stringify({ role }) });
  return { url, as, roles, removed, setRole };
}

describe('the console’s own identity', () => {
  it('says which identity mode the bridge runs in', async () => {
    const local = await serve('local');
    expect(await (await fetch(`${local.url}/v1/me`, { headers: local.as('Console') })).json()).toEqual({
      email: 'console',
      role: 'admin',
      identityMode: 'local',
    });
  });

  it('is not demoted on a local install, and the refusal says FLEETADLC_IDENTITY is the way round', async () => {
    const { roles, setRole } = await serve('local');
    const refused = await setRole('Console', 'console', 'user');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'self-demote', error: expect.stringContaining('FLEETADLC_IDENTITY') });
    expect(roles.get('console')).toBe('admin');

    // Someone else, promoting itself, and removing itself all go through.
    expect((await setRole('console', 'me@example.com', 'user')).status).toBe(200);
    expect((await setRole('console', 'console', 'admin')).status).toBe(200);
    expect(roles.get('me@example.com')).toBe('user');
  });

  it('may still be removed on a local install, since a name the install does not know is an admin there', async () => {
    const { url, as, removed } = await serve('local');
    const response = await fetch(`${url}/v1/users/console/remove`, { method: 'POST', headers: as('console') });
    expect(response.status).toBe(200);
    expect(removed).toEqual(['console']);
  });

  it('may demote itself behind IAP, where another admin can undo it', async () => {
    const { roles, setRole } = await serve('iap');
    expect((await setRole('Me@Example.com', 'me@example.com', 'user')).status).toBe(200);
    expect(roles.get('me@example.com')).toBe('user');
  });
});
