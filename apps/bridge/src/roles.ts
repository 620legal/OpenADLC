import { audit, users as usersStore, type AddedHow, type Role, type User } from '@fleetadlc/db';
import type { IdentityMode } from './identity.js';
import { HttpFailure } from './router.js';

export type { Role } from '@fleetadlc/db';

/**
 * The role each `/v1` route needs, by method and the path it was registered
 * under. Everything a person does in the console is one of these.
 *
 * A route missing here needs an admin: a new route is safe by default, and
 * `roles.test.ts` fails for one nobody classified, so it is also decided on
 * purpose. A user creates and runs work — files a request, answers the crew's
 * questions and gates, posts in a thread, stops a task and tries it again —
 * and reads the board, the threads, the crew and the costs. Moving a card
 * changes what the crew builds next, and changing a spending limit, a
 * repository, a bot, a model account or any setting changes the install, so
 * those are an admin's.
 */
export const ROUTE_ROLES: Readonly<Record<string, Role>> = {
  // Who is asking, which every page reads.
  'GET /v1/me': 'user',

  // The board, the crew, the threads and the costs, to read.
  'GET /v1/board': 'user',
  'GET /v1/bots': 'user',
  'GET /v1/bots/:name': 'user',
  'GET /v1/threads/:bot': 'user',
  'GET /v1/threads/:bot/stream': 'user',
  // A work item: a request, its issue and its pull request, as one conversation.
  'GET /v1/items/:subject': 'user',
  'GET /v1/items/:subject/stream': 'user',
  'GET /v1/gates': 'user',
  'GET /v1/requests': 'user',
  'GET /v1/requests/:id': 'user',
  'GET /v1/tasks': 'user',
  'GET /v1/repos': 'user',
  'GET /v1/attention': 'user',
  'GET /v1/health': 'user',
  'GET /v1/costs': 'user',
  'GET /v1/insights': 'user',
  'GET /v1/spending/limits': 'user',
  'GET /v1/work/pause': 'user',
  // The crew page names the account each bot thinks with; no key is in it.
  'GET /v1/model-accounts': 'user',

  // Creating and running work.
  'POST /v1/requests': 'user',
  'POST /v1/requests/:id/triage': 'user',
  // Dropping a request the person no longer wants, which nothing starts again.
  'POST /v1/requests/:id/abandon': 'user',
  'POST /v1/tasks/:id/retry': 'user',
  'POST /v1/tasks/:id/stop': 'user',
  'POST /v1/tasks/:id/dismiss': 'user',
  'POST /v1/gates/:id/answer': 'user',
  'POST /v1/threads/:bot/messages': 'user',
  'POST /v1/items/:subject/messages': 'user',
  // A file given with a request or a message, and looking at one.
  'POST /v1/attachments': 'user',
  'GET /v1/attachments/:id': 'user',
  // Removing one for good is an admin's, and audited.
  'DELETE /v1/attachments/:id': 'admin',

  // Moving a card between stages.
  'POST /v1/board/move': 'admin',

  // A bot's computer: its sessions, its screen, its worktree, the terminal.
  'GET /v1/sessions/:bot': 'admin',
  'GET /v1/sessions/:bot/:session/pane': 'admin',
  'GET /v1/worktree/:bot': 'admin',
  'POST /v1/sessions/:bot/:session/kill': 'admin',
  'POST /v1/bots/:name/restart': 'admin',
  'POST /v1/terminal/:bot/:session/token': 'admin',

  // Reading what only Settings, onboarding and the operator's tools show.
  'GET /v1/leases': 'admin',
  'GET /v1/audit': 'admin',
  'GET /v1/status': 'admin',
  'GET /v1/onboarding': 'admin',
  // As the walkthrough it stands for: a user's board was never sent to a walkthrough it could not use.
  'GET /v1/onboarding/complete': 'admin',
  'GET /v1/onboarding/repositories': 'admin',
  'GET /v1/onboarding/bots/:bot/connect': 'admin',
  'GET /v1/github/accounts': 'admin',
  'GET /v1/github/identities': 'admin',
  'GET /v1/github/installations': 'admin',
  'GET /v1/github/reach': 'admin',
  'GET /v1/github/suggest-login': 'admin',
  'GET /v1/github/accounts/connect/:flowId': 'admin',
  'GET /v1/invitations': 'admin',
  'GET /v1/app-manifest': 'admin',
  'GET /v1/app-checks': 'admin',
  'GET /v1/install': 'admin',
  'GET /v1/webhook': 'admin',
  'GET /v1/engines': 'admin',
  'GET /v1/engines/updates': 'admin',
  'GET /v1/repo-setup': 'admin',
  'GET /v1/model-accounts/:id/models': 'admin',
  'GET /v1/model-accounts/:id/login': 'admin',
  'GET /v1/backup': 'admin',
  'GET /v1/restore': 'admin',
  'GET /v1/restore/into': 'admin',
  'GET /v1/users': 'admin',

  // Changing the install.
  'PATCH /v1/install': 'admin',
  'PATCH /v1/spending/limits': 'admin',
  'PUT /v1/costs/ci-cap': 'admin',
  'PUT /v1/spending/limits': 'admin',
  'PATCH /v1/repos/:name': 'admin',
  // What removing one would do: its work, its leases, the crew's access to it.
  'GET /v1/repos/:name/removal': 'admin',
  'POST /v1/repos/:name/remove': 'admin',
  'POST /v1/repos/:name/access': 'admin',
  'POST /v1/repos/:name/pulls/:number/hold': 'admin',
  // A repository's design memory, read and corrected in Settings.
  'GET /v1/repos/:name/design-memory': 'admin',
  'PATCH /v1/repos/:name/design-memory': 'admin',
  'POST /v1/repos/:name/design-memory/:id/revert': 'admin',
  'PATCH /v1/bots/:name/assignment': 'admin',
  // A bot's colour, from Settings → Appearance.
  'PATCH /v1/crew/:bot': 'admin',
  // How many tasks a seat runs at once, from Crew.
  'PATCH /v1/crew/:bot/tasks-at-once': 'admin',
  // A seat paused and resumed, from Crew.
  'POST /v1/crew/:bot/pause': 'admin',
  'POST /v1/crew/:bot/resume': 'admin',
  // One piece of work held, let go on, put next or cancelled, from its card (`item-controls.ts`).
  'POST /v1/items/:subject/pause': 'admin',
  'POST /v1/items/:subject/resume': 'admin',
  'POST /v1/items/:subject/next': 'admin',
  'GET /v1/items/:subject/cancel': 'admin',
  'POST /v1/items/:subject/cancel': 'admin',
  // A person's decision about issues OpenADLC will not take on its own.
  'POST /v1/repos/:repo/unowned/intake': 'admin',
  'POST /v1/repos/:repo/unowned/ignore': 'admin',
  'POST /v1/repos/:repo/unowned/close': 'admin',
  // A promote held for a person, released to production; or the repository
  // switched to automatic delivery instead (`deploy-routes.ts`).
  'POST /v1/repos/:repo/deploys/:sha/release': 'admin',
  'POST /v1/repos/:repo/delivery/automatic': 'admin',
  'POST /v1/crew/seats': 'admin',
  'POST /v1/crew/seats/:seat/remove': 'admin',
  'POST /v1/model-accounts': 'admin',
  'POST /v1/model-accounts/:id/key': 'admin',
  'POST /v1/model-accounts/:id/remove': 'admin',
  'POST /v1/model-accounts/:id/login': 'admin',
  'POST /v1/model-accounts/:id/verify': 'admin',
  'POST /v1/github/accounts/assign': 'admin',
  'POST /v1/github/accounts/connect': 'admin',
  'POST /v1/github/accounts/disconnect': 'admin',
  'POST /v1/invitations/invite': 'admin',
  'POST /v1/invitations/accept': 'admin',
  'POST /v1/app-manifest/prepare': 'admin',
  'POST /v1/app-manifest/exchange': 'admin',
  'POST /v1/webhook/configure': 'admin',
  'POST /v1/webhook/stop-tunnel': 'admin',
  // A new key for signing the crew's posts, as after a leaked backup (`fleetadlc attribution rotate`).
  'POST /v1/attribution/rotate': 'admin',
  'POST /v1/onboarding/repository': 'admin',
  // Lets the app's installation on another account count; see `app-reach.ts`.
  'POST /v1/github/allowed-accounts': 'admin',
  'POST /v1/onboarding/bots/:bot/connect': 'admin',
  'POST /v1/onboarding/bots/:bot/cancel': 'admin',
  'POST /v1/engines/updates': 'admin',
  'PATCH /v1/engines/updates': 'admin',
  'POST /v1/engines/updates/rollback': 'admin',
  'POST /v1/repo-setup/labels': 'admin',
  'POST /v1/repo-setup/rules': 'admin',
  'POST /v1/repo-setup/production': 'admin',
  'POST /v1/work/pause': 'admin',
  'POST /v1/work/resume': 'admin',
  'POST /v1/backup': 'admin',
  'POST /v1/restore/preview': 'admin',
  'POST /v1/restore': 'admin',
  'POST /v1/restore/into/preview': 'admin',
  'POST /v1/restore/into': 'admin',
  'POST /v1/restore/undo': 'admin',
  // A health check is the install's setup: running one again, and dismissing
  // or acknowledging its card, is what fixing the install looks like.
  'POST /v1/health/run': 'admin',
  'POST /v1/health/checks/:checkId/run': 'admin',
  'POST /v1/health/:id/dismiss': 'admin',
  'POST /v1/health/:id/acknowledge': 'admin',
  'POST /v1/users': 'admin',
  'PATCH /v1/users/:email': 'admin',
  'POST /v1/users/:email/remove': 'admin',
};

export function routeKey(method: string, path: string): string {
  return `${method} ${path}`;
}

/** What a route needs; admin for one nobody classified. */
export function roleFor(method: string, path: string): Role {
  return ROUTE_ROLES[routeKey(method, path)] ?? 'admin';
}

/** Why someone with no role is refused: unknown here, or nobody is an admin yet. */
export type Refusal = 'not-a-user' | 'no-admin';

/** What the router asks about the person behind a request. */
export interface RoleLookup {
  /** Their role, or null for someone this install does not know. */
  roleOf(identity: string): Promise<Role | null>;
  /** Whom to ask, for the page an unknown person sees. */
  admins(): Promise<string[]>;
  /** Why someone `roleOf` gave no role is refused. `not-a-user` when absent. */
  refusal?(): Promise<Refusal>;
  /** Records a refusal, once a day for each person and reason. */
  refused(identity: string, reason?: Refusal): Promise<void>;
}

/** What a cloud install with no admin, and no list to make one from, says to everyone. */
export const NO_ADMIN_WORDS =
  'no admin is configured for this install. Set admin_emails (FLEETADLC_ADMIN_EMAILS on the bridge) to the first admins\' emails and deploy again';

/**
 * Refuses a request its person may not make, or says their role.
 *
 * Someone unknown is told whom to ask: the refusal carries the admins' emails,
 * which is what the console's "ask an admin" page shows. Only people IAP
 * already let in reach this, and they have no other way to find out.
 */
export async function authorize(lookup: RoleLookup, method: string, path: string, identity: string): Promise<Role> {
  const role = await lookup.roleOf(identity);
  if (!role && (await lookup.refusal?.()) === 'no-admin') {
    await lookup.refused(identity, 'no-admin').catch(() => undefined);
    throw new HttpFailure(403, NO_ADMIN_WORDS, { code: 'no-admin', email: identity });
  }
  if (!role) {
    await lookup.refused(identity, 'not-a-user').catch(() => undefined);
    throw new HttpFailure(
      403,
      `you're signed in as ${identity}, which this install doesn't know. Ask an admin to add you in Settings → Users`,
      { code: 'not-a-user', email: identity, admins: await lookup.admins().catch(() => []) },
    );
  }
  if (roleFor(method, path) === 'admin' && role !== 'admin') {
    throw new HttpFailure(403, 'this needs an admin', { code: 'needs-admin', role });
  }
  return role;
}

/** The part of the store roles read and bootstrap through, injected so a test needs no database. */
export interface UsersStore {
  listUsers(): Promise<User[]>;
  bootstrapAdmins(emails: readonly string[], how: Exclude<AddedHow, 'added'>, actor: string): Promise<User[]>;
}

export interface RolesDeps {
  mode: IdentityMode;
  /** `FLEETADLC_ADMIN_EMAILS`: the first admins, when it says any. */
  adminEmails: readonly string[];
  /** The console's IAP members, `FLEETADLC_CONSOLE_MEMBERS`: the first admins when there is no list of them. */
  consoleMembers: readonly string[];
  store?: UsersStore;
  audit?: (entry: { actor: string; action: string; target: string; payload?: Record<string, unknown> }) => Promise<void>;
  /** How long a read of `users` is used for. Every change through the bridge clears it. */
  cacheMs?: number;
  now?: () => Date;
}

/** Read when a `Roles` is built, not when this module loads: a test that mocks `@fleetadlc/db` whole still imports it. */
function liveStore(): UsersStore {
  return { listUsers: () => usersStore.listUsers(), bootstrapAdmins: (emails, how, actor) => usersStore.bootstrapAdmins(emails, how, actor) };
}

/** How many refused people are remembered, so a stream of new ones cannot grow it without end. */
const REFUSALS_KEPT = 1000;

/**
 * Every `/v1` request's person, as a role.
 *
 * `users` is read at most every few seconds rather than on each request — the
 * board alone makes several — and a change made here clears what was read, so
 * the admin who made it sees it at once. Another bridge sees it within
 * `cacheMs`.
 *
 * While `users` is empty the install has no admin, and the first request makes
 * them: every address in `FLEETADLC_ADMIN_EMAILS`; failing that, every `user:` in
 * the console's IAP members. Nobody else is added implicitly, and the store
 * adds nothing once someone has been.
 *
 * With neither list, a cloud install adds nobody and refuses everyone with
 * `no-admin`, saying to set `admin_emails`. Making the first visitor the admin
 * there would hand the install to whoever loaded a page first: access granted
 * to a group or a domain only, at project level outside the module, or a new
 * image rolled out before the Terraform that sets the lists all leave both
 * empty, and the operator would then be locked out with only the database to
 * turn to. A local install makes its first visitor the admin, below.
 *
 * In `local` mode the identity is a header, and only a caller holding the
 * install's console secret gets this far (`identity.ts`): the console's server
 * and the `fleetadlc` CLI, both of which the operator runs. A name this install
 * does not know is not refused, because that would only refuse the CLI, which
 * names itself `$USER`. A known name still has its role, which is what lets a
 * person try the console as a user. The cloud, where the identity is IAP's
 * signature, refuses a name it does not know.
 */
export class Roles implements RoleLookup {
  private cached: { users: Map<string, User>; at: number } | null = null;
  private reading: Promise<Map<string, User>> | null = null;
  /**
   * Bumped by every `invalidate()`. A read that started before a change and
   * finished after it would otherwise cache the roles from before, and the
   * admin who demoted someone would see them keep their role for `cacheMs`.
   */
  private generation = 0;
  private bootstrapping: Promise<void> | null = null;
  private readonly refusals = new Set<string>();
  private readonly store: UsersStore;
  private readonly audit: NonNullable<RolesDeps['audit']>;
  private readonly cacheMs: number;
  private readonly now: () => Date;

  constructor(private readonly deps: RolesDeps) {
    this.store = deps.store ?? liveStore();
    this.audit = deps.audit ?? audit;
    this.cacheMs = deps.cacheMs ?? 10_000;
    this.now = deps.now ?? (() => new Date());
  }

  async roleOf(identity: string): Promise<Role | null> {
    const email = usersStore.normalizeEmail(identity);
    let known = await this.users();
    if (known.size === 0) {
      await this.bootstrap(email);
      known = await this.users();
    }
    const found = known.get(email);
    if (found) return found.role;
    return this.deps.mode === 'local' ? 'admin' : null;
  }

  /** `no-admin` while `users` is still empty: a cloud install with no list to make its first admins from. */
  async refusal(): Promise<Refusal> {
    return (await this.users()).size === 0 ? 'no-admin' : 'not-a-user';
  }

  async admins(): Promise<string[]> {
    return [...(await this.users()).values()].filter((user) => user.role === 'admin').map((user) => user.email);
  }

  async refused(identity: string, reason: Refusal = 'not-a-user'): Promise<void> {
    const email = usersStore.normalizeEmail(identity);
    const key = `${reason} ${email} ${this.now().toISOString().slice(0, 10)}`;
    if (this.refusals.has(key)) return;
    if (this.refusals.size >= REFUSALS_KEPT) this.refusals.clear();
    this.refusals.add(key);
    if (reason === 'no-admin') console.warn(`[bridge] refused ${email}: ${NO_ADMIN_WORDS}`);
    await this.audit({ actor: email, action: 'user.refused', target: email, payload: { reason } });
  }

  /** After a change to `users`, so the next request on this bridge reads it again, including one already reading. */
  invalidate(): void {
    this.generation += 1;
    this.cached = null;
    this.reading = null;
  }

  /** Every user, for Settings → Users. */
  async list(): Promise<User[]> {
    return [...(await this.users()).values()];
  }

  private async users(): Promise<Map<string, User>> {
    if (this.cached && Date.now() - this.cached.at < this.cacheMs) return this.cached.users;
    const generation = this.generation;
    const reading = (this.reading ??= this.store
      .listUsers()
      .then((list) => {
        const users = new Map(list.map((user) => [user.email, user]));
        // Only a read no change has overtaken is kept for the next request.
        if (generation === this.generation) this.cached = { users, at: Date.now() };
        return users;
      })
      .finally(() => {
        if (this.reading === reading) this.reading = null;
      }));
    return reading;
  }

  private async bootstrap(first: string): Promise<void> {
    this.bootstrapping ??= (async () => {
      const chosen = firstAdmins(this.deps, first);
      // A cloud install with neither list adds nobody; see the class comment.
      if (!chosen) return;
      const [emails, how] = chosen;
      const added = await this.store.bootstrapAdmins(emails, how, first);
      for (const user of added) console.log(`[bridge] ${user.email} is an admin: ${BOOTSTRAP_WORDS[how]}`);
      this.invalidate();
    })().finally(() => {
      this.bootstrapping = null;
    });
    return this.bootstrapping;
  }
}

const BOOTSTRAP_WORDS: Record<Exclude<AddedHow, 'added'>, string> = {
  'admin-emails': 'named in FLEETADLC_ADMIN_EMAILS',
  'console-members': "one of the console's IAP members",
  first: 'the first to reach this local install',
};

/**
 * Who the first admins are, and why, in the order `Roles` says; null for a
 * cloud install with neither list. `admin_emails` is read the way the members
 * are, so `user:jane@example.com` — how `console_members` is written, and
 * easily copied from it — is Jane, not a row IAP's email never matches.
 */
export function firstAdmins(
  deps: Pick<RolesDeps, 'adminEmails' | 'consoleMembers' | 'mode'>,
  first: string,
): [string[], Exclude<AddedHow, 'added'>] | null {
  const present = (email: string | null): email is string => email !== null;
  const named = deps.adminEmails.map(memberEmail).filter(present);
  if (named.length > 0) return [named, 'admin-emails'];
  const members = deps.consoleMembers.map(memberEmail).filter(present);
  if (members.length > 0) return [members, 'console-members'];
  return deps.mode === 'local' ? [[first], 'first'] : null;
}

/**
 * The email in an IAM member, `user:someone@example.com`. A group, a domain or
 * a service account names no one person, so it makes nobody an admin.
 */
export function memberEmail(member: string): string | null {
  const trimmed = member.trim();
  const email = trimmed.startsWith('user:') ? trimmed.slice(5) : trimmed.includes(':') ? '' : trimmed;
  const address = usersStore.normalizeEmail(email);
  return usersStore.isEmail(address) ? address : null;
}

/** A comma-separated list from the environment. */
export function listFromEnv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
