import { users as usersStore, UserChangeRefused, type Role, type User } from '@fleetadlc/db';
import type { IdentityMode } from './identity.js';
import type { Roles } from './roles.js';
import { HttpFailure, type Router } from './router.js';

/** The store's changes, injected so the routes can be tested without a database. */
export interface UsersRouteDeps {
  roles: Pick<Roles, 'list' | 'invalidate'>;
  add: (email: string, role: Role, by: string) => Promise<User>;
  setRole: (email: string, role: Role, by: string) => Promise<User>;
  remove: (email: string, by: string) => Promise<void>;
  /** On a local install every console request is one identity, so demoting it locks Settings for good. */
  identityMode: IdentityMode;
}

export function liveUsersDeps(roles: UsersRouteDeps['roles'], identityMode: IdentityMode): UsersRouteDeps {
  return {
    roles,
    identityMode,
    add: (email, role, by) => usersStore.addUser(email, role, by),
    setRole: (email, role, by) => usersStore.setRole(email, role, by),
    remove: (email, by) => usersStore.removeUser(email, by),
  };
}

const STATUS: Record<UserChangeRefused['reason'], number> = { 'last-admin': 409, exists: 409, 'not-found': 404, invalid: 400 };

/** A refusal said as its status, and the cache cleared after anything that changed `users`. */
async function change<T>(deps: UsersRouteDeps, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof UserChangeRefused) throw new HttpFailure(STATUS[error.reason], error.message, { code: error.reason });
    throw error;
  } finally {
    deps.roles.invalidate();
  }
}

function roleIn(value: unknown): Role {
  if (value === 'admin' || value === 'user') return value;
  throw new HttpFailure(400, 'role is admin or user');
}

/**
 * Settings → Users, and who is asking.
 *
 * `GET /v1/me` is what the console reads on every page to know which controls
 * to show. Someone this install does not know never reaches it: the router
 * refuses them with `not-a-user` first, and that refusal is what the console
 * draws its "ask an admin" page from.
 */
export function registerUsersRoutes(router: Router, deps: UsersRouteDeps): void {
  router.get('/v1/me', async ({ identity, role }) => ({
    email: usersStore.normalizeEmail(identity),
    role,
    identityMode: deps.identityMode,
  }));

  router.get('/v1/users', async () => ({ users: await deps.roles.list() }));

  router.post('/v1/users', async ({ body, identity }) => {
    const input = await body<{ email?: unknown; role?: unknown }>();
    const role = roleIn(input.role ?? 'user');
    if (typeof input.email !== 'string') throw new HttpFailure(400, 'email is required');
    const email = input.email;
    return { user: await change(deps, () => deps.add(email, role, identity)) };
  });

  router.patch('/v1/users/:email', async ({ params, body, identity }) => {
    const role = roleIn((await body<{ role?: unknown }>()).role);
    // A local console sends FLEETADLC_IDENTITY, or `console`, on every request
    // and can send nothing else: demoted, it could never open Settings again,
    // and no other admin could ever sign in to undo it. Behind IAP another
    // admin can, so there the last-admin rule is enough.
    const self = usersStore.normalizeEmail(identity);
    if (deps.identityMode === 'local' && role === 'user' && usersStore.normalizeEmail(params.email ?? '') === self) {
      throw new HttpFailure(
        409,
        `${self} is who this console says it is (FLEETADLC_IDENTITY, or console when unset); as a user it could not open ` +
          `Settings again. Leave it an admin, or set FLEETADLC_IDENTITY to another admin's address and run fleetadlc up first.`,
        { code: 'self-demote' },
      );
    }
    return { user: await change(deps, () => deps.setRole(params.email ?? '', role, identity)) };
  });

  router.post('/v1/users/:email/remove', async ({ params, identity }) => {
    await change(deps, () => deps.remove(params.email ?? '', identity));
    return { ok: true };
  });
}
