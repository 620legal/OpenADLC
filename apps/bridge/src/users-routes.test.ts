import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Role, User } from '@openadlc/db';
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
async function serve(
  identityMode: IdentityMode,
  access?: (email: string) => 'member' | 'absent' | 'unknown',
  githubOf?: (identity: string) => Promise<{ login: string } | null>,
) {
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
    ...(access ? { access } : {}),
    ...(githubOf ? { githubOf } : {}),
  });
  server = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const as = (identity: string) => ({ 'x-openadlc-identity': identity, 'content-type': 'application/json' });
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

  it('says the GitHub account the person linked, or none, and none when the link cannot be read', async () => {
    const linked = await serve('local', undefined, async (identity) => (identity === 'Console' ? { login: 'janedoe' } : null));
    expect(await (await fetch(`${linked.url}/v1/me`, { headers: linked.as('Console') })).json()).toMatchObject({ github: { login: 'janedoe' } });
    server?.close();
    const broken = await serve('local', undefined, async () => {
      throw new Error('database down');
    });
    expect(await (await fetch(`${broken.url}/v1/me`, { headers: broken.as('Console') })).json()).toMatchObject({ github: null });
  });

  it('is not demoted on a local install, and the refusal says OPENADLC_IDENTITY is the way round', async () => {
    const { roles, setRole } = await serve('local');
    const refused = await setRole('Console', 'console', 'user');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'self-demote', error: expect.stringContaining('OPENADLC_IDENTITY') });
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

describe('whether IAP admits each user', () => {
  it('rides along behind IAP, so Settings → Users can warn about an address IAP turns away', async () => {
    const { url, as } = await serve('iap', (email) => (email === 'me@example.com' ? 'member' : 'absent'));
    const listed = (await (await fetch(`${url}/v1/users`, { headers: as('me@example.com') })).json()) as {
      users: { email: string; iapAccess?: string }[];
    };
    expect(listed.users.map((one) => [one.email, one.iapAccess])).toEqual([
      ['console', 'absent'],
      ['me@example.com', 'member'],
    ]);

    // The answer to an add carries it too, so the warning shows the moment they are added.
    const added = await fetch(`${url}/v1/users`, {
      method: 'POST',
      headers: as('me@example.com'),
      body: JSON.stringify({ email: 'bob@example.com', role: 'user' }),
    });
    expect(await added.json()).toMatchObject({ user: { email: 'bob@example.com', iapAccess: 'absent' } });
  });

  it('is not said on a local install, where there is no IAP', async () => {
    const { url, as } = await serve('local');
    const listed = (await (await fetch(`${url}/v1/users`, { headers: as('console') })).json()) as { users: Record<string, unknown>[] };
    expect(listed.users.length).toBeGreaterThan(0);
    for (const one of listed.users) expect('iapAccess' in one).toBe(false);
  });
});
