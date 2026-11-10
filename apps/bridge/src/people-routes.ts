import { people as peopleStore, personAccounts, settings, users as usersStore, UserChangeRefused, type Person, type PersonInput, type Role } from '@openadlc/db';
import { parsePersonRoles, type StoredPersonRoles } from '@openadlc/shared';
import type { BridgeConfig } from './config.js';
import { effectiveConfig } from './effective-config.js';
import { resolveGithubAccount } from './human-ids.js';
import type { IdentityMode } from './identity.js';
import { databasePushStore, forgetDevices } from './push-devices.js';
import { iapAccess, type IapAccess, type Roles } from './roles.js';
import { HttpFailure, type Router } from './router.js';

/**
 * Settings → People: the install's one list of people
 * (docs/adr/0034-one-list-of-people.md). A person is their console sign-in,
 * their GitHub account, whether they approve, and the roles they hold.
 *
 * An admin names a login, which is checked on GitHub and pinned to the
 * account it resolves to now; only the person's own device-code link
 * (`person-github.ts`) confirms it, and no route here can. Approves is the one
 * switch that puts a login in `humans`; adding someone or giving them a role
 * never does.
 */

/** A person as Settings shows them. */
export interface PersonView {
  id: string;
  name: string;
  email: string | null;
  consoleRole: Role | null;
  github: { login: string; id: number | null; confirmed: boolean } | null;
  approves: boolean;
  /** `environment`: approves because `OPENADLC_HUMANS` names them, which Settings cannot change. */
  approvesFrom: 'people' | 'environment' | null;
  /** The ids of the person roles they hold. */
  roles: string[];
  addedBy: string;
  addedAt: string;
  /** Behind IAP, whether it admits their email at all. */
  iapAccess?: IapAccess;
  /** A row only `OPENADLC_HUMANS` names, with no person behind it: shown, never changed. */
  virtual?: boolean;
}

export interface PeopleView {
  people: PersonView[];
  /** The logins `OPENADLC_HUMANS` (install.json's `humans`) names, and whether they are what approves now. */
  environment: { logins: string[]; inEffect: boolean };
  identityMode: IdentityMode;
}

/** The store's changes, injected so the routes can be tested without a database. */
export interface PeopleRouteDeps {
  roles: Pick<Roles, 'invalidate'>;
  identityMode: IdentityMode;
  access?: (email: string) => IapAccess;
  store: {
    list(): Promise<Person[]>;
    add(input: PersonInput, by: string): Promise<Person>;
    update(id: string, input: PersonInput, by: string): Promise<Person>;
    setApproves(id: string, on: boolean, by: string): Promise<Person>;
    merge(id: string, into: string, by: string): Promise<Person>;
    remove(id: string, by: string): Promise<void>;
  };
  /** `OPENADLC_HUMANS`, and whether it is what approves now (nobody in People does). */
  environment(): Promise<{ logins: string[]; inEffect: boolean }>;
  /** The account behind a login: false when GitHub says there is none, null when it did not say. */
  lookup(login: string): Promise<{ login: string; id: number } | false | null>;
  personRoles(): Promise<StoredPersonRoles>;
  /** The GitHub account the signed-in person linked, for `GET /v1/me`. */
  githubOf?: (identity: string) => Promise<{ login: string } | null>;
  /**
   * Takes away a person's push devices and their subscriptions, once they are
   * removed or merged into someone else: left, the secrets outlived them.
   */
  forgetChannel?: (personId: string, by: string) => Promise<void>;
}

export function livePeopleDeps(config: BridgeConfig, roles: PeopleRouteDeps['roles'], consoleMembers: readonly string[]): PeopleRouteDeps {
  return {
    roles,
    identityMode: config.identityMode,
    store: {
      list: () => peopleStore.listPeople(),
      add: (input, by) => peopleStore.addPerson(input, by),
      update: (id, input, by) => peopleStore.updatePerson(id, input, by),
      setApproves: (id, on, by) => peopleStore.setApproves(id, on, by),
      merge: (id, into, by) => peopleStore.mergePeople(id, into, by),
      remove: (id, by) => peopleStore.removePerson(id, by),
    },
    environment: async () => {
      const live = await effectiveConfig(config);
      return { logins: config.humans, inEffect: live.humansFrom === 'environment' };
    },
    lookup: (login) => resolveGithubAccount(login),
    personRoles: async () => parsePersonRoles(await settings.getSetting('personRoles').catch(() => null)),
    githubOf: async (identity) => {
      const linked =
        config.identityMode === 'local'
          ? await peopleStore.operator().then((person) => (person ? personAccounts.ofPerson(person.id) : null))
          : await personAccounts.ofIdentity(usersStore.normalizeEmail(identity));
      return linked ? { login: linked.githubLogin } : null;
    },
    forgetChannel: (personId) => forgetDevices(databasePushStore(), personId),
    ...(config.identityMode === 'iap' ? { access: (email: string) => iapAccess(email, consoleMembers) } : {}),
  };
}

/** Forgets a person's devices; a failure is said and leaves the person's change done, since devices are read only for people who exist. */
async function forgetChannel(deps: PeopleRouteDeps, personId: string, by: string): Promise<void> {
  await deps.forgetChannel?.(personId, by).catch((error: unknown) => {
    console.warn(`[bridge] could not remove the push devices of person ${personId}: ${error instanceof Error ? error.message : error}`);
  });
}

const STATUS: Record<UserChangeRefused['reason'], number> = { 'last-admin': 409, exists: 409, 'not-found': 404, invalid: 400 };

/** A refusal said as its status, and the roles cache cleared after anything that could change who signs in. */
async function change<T>(deps: PeopleRouteDeps, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof UserChangeRefused) throw new HttpFailure(STATUS[error.reason], error.message, { code: error.reason });
    throw error;
  } finally {
    deps.roles.invalidate();
  }
}

/** A GitHub login as GitHub allows one. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/**
 * The account a login an admin typed resolves to, or a refusal saying why:
 * a login that is no account, or GitHub not answering.
 */
async function resolved(deps: PeopleRouteDeps, login: string): Promise<{ login: string; id: number }> {
  const typed = login.trim().replace(/^@/, '');
  if (!LOGIN.test(typed)) throw new HttpFailure(400, `${JSON.stringify(login)} is not a GitHub login`);
  const account = await deps.lookup(typed).catch(() => null);
  if (account === false) throw new HttpFailure(400, `GitHub has no account @${typed}: check the spelling`, { code: 'no-such-login' });
  if (account === null) throw new HttpFailure(503, `GitHub did not say who @${typed} is. Try again in a moment.`, { code: 'github-unreachable' });
  return account;
}

function roleIn(value: unknown): Role | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (value === 'admin' || value === 'user') return value;
  throw new HttpFailure(400, 'consoleRole is admin, user, or none');
}

function textIn(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new HttpFailure(400, `${field} is text`);
  return value;
}

async function personInput(deps: PeopleRouteDeps, body: Record<string, unknown>): Promise<PersonInput> {
  const input: PersonInput = {};
  const name = textIn(body.name, 'name');
  if (name !== undefined) input.name = name ?? '';
  const email = textIn(body.email, 'email');
  if (email !== undefined) input.email = email;
  const role = roleIn(body.consoleRole);
  if (role !== undefined) input.consoleRole = role;
  const login = textIn(body.githubLogin, 'githubLogin');
  if (login !== undefined) input.github = login && login.trim() ? await resolved(deps, login) : null;
  return input;
}

const ENVIRONMENT_ID = 'env:';

export async function peopleView(deps: PeopleRouteDeps): Promise<PeopleView> {
  const [list, environment, stored] = await Promise.all([deps.store.list(), deps.environment(), deps.personRoles()]);
  const envLower = new Set(environment.logins.map((login) => login.toLowerCase()));
  const rolesOf = (id: string) => stored.roles.filter((role) => role.members.includes(id)).map((role) => role.id);
  const views: PersonView[] = list.map((person) => {
    const named = Boolean(person.githubLogin && envLower.has(person.githubLogin.toLowerCase()));
    const fromEnvironment = named && environment.inEffect;
    const access = person.email ? deps.access?.(person.email) : undefined;
    return {
      id: person.id,
      name: person.name,
      email: person.email,
      consoleRole: person.consoleRole,
      github: person.githubLogin ? { login: person.githubLogin, id: person.githubUserId, confirmed: person.githubLinkedAt !== null } : null,
      approves: person.approves || fromEnvironment,
      approvesFrom: fromEnvironment ? 'environment' : person.approves ? 'people' : null,
      roles: rolesOf(person.id),
      addedBy: person.addedBy,
      addedAt: person.addedAt,
      ...(access ? { iapAccess: access } : {}),
    };
  });
  // A login only the environment names, which no person holds: shown so
  // Settings says who approves, never changed there.
  for (const login of environment.logins) {
    if (list.some((person) => person.githubLogin?.toLowerCase() === login.toLowerCase())) continue;
    views.push({
      id: `${ENVIRONMENT_ID}${login.toLowerCase()}`,
      name: '',
      email: null,
      consoleRole: null,
      github: { login, id: null, confirmed: false },
      approves: environment.inEffect,
      approvesFrom: environment.inEffect ? 'environment' : null,
      roles: [],
      addedBy: 'OPENADLC_HUMANS',
      addedAt: '',
      virtual: true,
    });
  }
  return { people: views, environment, identityMode: deps.identityMode };
}

function refuseEnvironment(id: string): void {
  if (id.startsWith(ENVIRONMENT_ID)) {
    throw new HttpFailure(409, `@${id.slice(ENVIRONMENT_ID.length)} is set in OPENADLC_HUMANS (install.json's humans), not in People: change it there, or add them here`, {
      code: 'environment',
    });
  }
}

export function registerPeopleRoutes(router: Router, deps: PeopleRouteDeps): void {
  // What the console reads on every page to know which controls to show.
  // Someone this install does not know never reaches it: the router refuses
  // them with `not-a-user` first, and the console draws its "ask an admin"
  // page from that.
  router.get('/v1/me', async ({ identity, role }) => ({
    email: usersStore.normalizeEmail(identity),
    role,
    identityMode: deps.identityMode,
    // A link that cannot be read is said as none: every page reads this.
    ...(deps.githubOf ? { github: await deps.githubOf(identity).catch(() => null) } : {}),
  }));

  router.get('/v1/people', async (): Promise<PeopleView> => peopleView(deps));

  // Checks a login as an admin types it. Not a confirmation: only the person's
  // own link confirms an account.
  router.get('/v1/people/github/:login', async ({ params }) => {
    const typed = (params.login ?? '').trim().replace(/^@/, '');
    if (!LOGIN.test(typed)) return { exists: false };
    const account = await deps.lookup(typed).catch(() => null);
    if (account === null) throw new HttpFailure(503, 'GitHub did not answer. Try again in a moment.', { code: 'github-unreachable' });
    return account === false ? { exists: false } : { exists: true, login: account.login, id: account.id };
  });

  router.post('/v1/people', async ({ body, identity }) => {
    const raw = await body<Record<string, unknown>>();
    const input = await personInput(deps, raw ?? {});
    // Behind IAP a console role is a sign-in, which takes the email IAP asserts.
    if (deps.identityMode === 'iap' && input.consoleRole && !input.email) throw new HttpFailure(400, 'a console role needs an email to sign in with');
    const person = await change(deps, () => deps.store.add(input, identity));
    return { person: (await peopleView(deps)).people.find((one) => one.id === person.id) };
  });

  router.patch('/v1/people/:id', async ({ params, body, identity }) => {
    const id = params.id ?? '';
    refuseEnvironment(id);
    const input = await personInput(deps, (await body<Record<string, unknown>>()) ?? {});
    // A local console is one identity: demoted, it could never open Settings
    // again, and no other admin could sign in to undo it.
    if (deps.identityMode === 'local' && input.consoleRole !== undefined && input.consoleRole !== 'admin') {
      const self = usersStore.normalizeEmail(identity);
      const person = (await deps.store.list()).find((one) => one.id === id);
      if (person?.consoleRole === 'admin' && person.email === self) {
        throw new HttpFailure(
          409,
          `${person.email ?? 'this person'} is who this console says it is (OPENADLC_IDENTITY, or console when unset); without admin it could not open ` +
            `Settings again. Leave it an admin, or set OPENADLC_IDENTITY to another admin's address and run openadlc up first.`,
          { code: 'self-demote' },
        );
      }
    }
    const person = await change(deps, () => deps.store.update(id, input, identity));
    return { person: (await peopleView(deps)).people.find((one) => one.id === person.id) };
  });

  router.post('/v1/people/:id/approves', async ({ params, body, identity }) => {
    const id = params.id ?? '';
    refuseEnvironment(id);
    const { on } = (await body<{ on?: unknown }>()) ?? {};
    if (typeof on !== 'boolean') throw new HttpFailure(400, 'on is true or false');
    const person = await change(deps, () => deps.store.setApproves(id, on, identity));
    return { person: (await peopleView(deps)).people.find((one) => one.id === person.id) };
  });

  router.post('/v1/people/:id/merge', async ({ params, body, identity }) => {
    const id = params.id ?? '';
    refuseEnvironment(id);
    const { into } = (await body<{ into?: unknown }>()) ?? {};
    if (typeof into !== 'string' || !into) throw new HttpFailure(400, 'into is the id of the person to keep');
    refuseEnvironment(into);
    const person = await change(deps, () => deps.store.merge(id, into, identity));
    if (person.id !== id) await forgetChannel(deps, id, identity);
    return { person: (await peopleView(deps)).people.find((one) => one.id === person.id) };
  });

  router.post('/v1/people/:id/remove', async ({ params, identity }) => {
    const id = params.id ?? '';
    refuseEnvironment(id);
    await change(deps, () => deps.store.remove(id, identity));
    await forgetChannel(deps, id, identity);
    return { ok: true };
  });
}

/**
 * `PATCH /v1/install {humans}`: the walkthrough's "Who approves" step, the
 * health card's instructions and the CLI. Turns Approves on for exactly these
 * logins, adding a GitHub-only person for one nobody holds, and off for every
 * other person. Every login is resolved on GitHub first, and one that is no
 * account, or that GitHub did not answer for, refuses the whole change: it
 * used to be saved unpinned, and admitted nobody.
 */
export async function setApproversFromLogins(
  logins: readonly string[],
  by: string,
  lookup: PeopleRouteDeps['lookup'] = resolveGithubAccount,
  store: Pick<typeof peopleStore, 'setApprovers'> = peopleStore,
): Promise<string[]> {
  const accounts: { login: string; id: number }[] = [];
  for (const raw of logins) {
    const login = raw.trim().replace(/^@/, '');
    if (!login) continue;
    const account = await lookup(login).catch(() => null);
    if (account === false) throw new HttpFailure(400, `humans: GitHub has no account @${login}. Check the spelling, or take it out.`, { code: 'no-such-login' });
    if (account === null) throw new HttpFailure(503, `humans: GitHub did not say who @${login} is. Try again in a moment.`, { code: 'github-unreachable' });
    if (!accounts.some((one) => one.id === account.id)) accounts.push(account);
  }
  const approving = await store.setApprovers(accounts, by);
  return approving.map((person) => person.githubLogin).filter((login): login is string => Boolean(login));
}
