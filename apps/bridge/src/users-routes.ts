import { personAccounts, users as usersStore, UserChangeRefused, type Role, type User } from '@openadlc/db';
import type { IdentityMode } from './identity.js';
import { iapAccess, type IapAccess, type Roles } from './roles.js';
import { HttpFailure, type Router } from './router.js';

/** The store's changes, injected so the routes can be tested without a database. */
export interface UsersRouteDeps {
  roles: Pick<Roles, 'list' | 'invalidate'>;
  add: (email: string, role: Role, by: string) => Promise<User>;
  setRole: (email: string, role: Role, by: string) => Promise<User>;
  remove: (email: string, by: string) => Promise<void>;
  /** On a local install every console request is one identity, so demoting it locks Settings for good. */
  identityMode: IdentityMode;
  /**
   * Whether IAP admits an address (`roles.ts`), so Settings → Users can say a
   * person it names will be turned away before the console loads. Undefined on
   * a local install, where there is no IAP and nothing to say.
   */
  access?: (email: string) => IapAccess;
  /**
   * The GitHub account a person linked by signing in as it (`person-github.ts`),
   * for Settings' "Your GitHub account" and the pull panel. Absent, none is said.
   */
  githubOf?: (identity: string) => Promise<{ login: string } | null>;
}

export function liveUsersDeps(roles: UsersRouteDeps['roles'], identityMode: IdentityMode, consoleMembers: readonly string[]): UsersRouteDeps {
  return {
    roles,
    identityMode,
    add: (email, role, by) => usersStore.addUser(email, role, by),
    setRole: (email, role, by) => usersStore.setRole(email, role, by),
    remove: (email, by) => usersStore.removeUser(email, by),
    githubOf: async (identity) => {
      const linked = await personAccounts.ofIdentity(usersStore.normalizeEmail(identity));
      return linked ? { login: linked.githubLogin } : null;
    },
    ...(identityMode === 'iap' ? { access: (email: string) => iapAccess(email, consoleMembers) } : {}),
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
  // Each user as the console sees them: behind IAP, with whether IAP admits
  // them at all, so the page can warn about an address it will turn away.
  const said = (user: User): User & { iapAccess?: IapAccess } => {
    const access = deps.access?.(user.email);
    return access ? { ...user, iapAccess: access } : user;
  };

  router.get('/v1/me', async ({ identity, role }) => ({
    email: usersStore.normalizeEmail(identity),
    role,
    identityMode: deps.identityMode,
    // A link that cannot be read is said as none: every page reads this.
    ...(deps.githubOf ? { github: await deps.githubOf(identity).catch(() => null) } : {}),
  }));

  router.get('/v1/users', async () => ({ users: (await deps.roles.list()).map(said) }));

  router.post('/v1/users', async ({ body, identity }) => {
    const input = await body<{ email?: unknown; role?: unknown }>();
    const role = roleIn(input.role ?? 'user');
    if (typeof input.email !== 'string') throw new HttpFailure(400, 'email is required');
    const email = input.email;
    return { user: said(await change(deps, () => deps.add(email, role, identity))) };
  });

  router.patch('/v1/users/:email', async ({ params, body, identity }) => {
    const role = roleIn((await body<{ role?: unknown }>()).role);
    // A local console sends OPENADLC_IDENTITY, or `console`, on every request
    // and can send nothing else: demoted, it could never open Settings again,
    // and no other admin could ever sign in to undo it. Behind IAP another
    // admin can, so there the last-admin rule is enough.
    const self = usersStore.normalizeEmail(identity);
    if (deps.identityMode === 'local' && role === 'user' && usersStore.normalizeEmail(params.email ?? '') === self) {
      throw new HttpFailure(
        409,
        `${self} is who this console says it is (OPENADLC_IDENTITY, or console when unset); as a user it could not open ` +
          `Settings again. Leave it an admin, or set OPENADLC_IDENTITY to another admin's address and run openadlc up first.`,
        { code: 'self-demote' },
      );
    }
    return { user: said(await change(deps, () => deps.setRole(params.email ?? '', role, identity))) };
  });

  router.post('/v1/users/:email/remove', async ({ params, identity }) => {
    await change(deps, () => deps.remove(params.email ?? '', identity));
    return { ok: true };
  });
}
