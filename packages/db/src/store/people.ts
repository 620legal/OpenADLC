import type { PoolClient } from 'pg';
import { query, queryOne, withTransaction } from '../client.js';
import { isEmail, normalizeEmail, ROLES, UserChangeRefused, type AddedHow, type Role, type User } from './users.js';

/**
 * The install's people: one row each, holding the console sign-in, the GitHub
 * account, whether they approve, and (through `personRoles`) the roles they
 * hold. See `migrations/0162_people.sql` and
 * docs/adr/0034-one-list-of-people.md.
 */
export interface Person {
  id: string;
  name: string;
  /** The console sign-in, lower-cased; null for someone listed only by GitHub. */
  email: string | null;
  /** Null: they cannot sign in to the console. */
  consoleRole: Role | null;
  githubLogin: string | null;
  /** The pin: the account the login resolved to when named, or the one the person linked. */
  githubUserId: number | null;
  /** Set only by the person's own device-code link: the account is confirmed. */
  githubLinkedAt: string | null;
  approves: boolean;
  addedBy: string;
  addedHow: AddedHow;
  addedAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  name: string;
  email: string | null;
  console_role: Role | null;
  github_login: string | null;
  github_user_id: string | number | null;
  github_linked_at: Date | null;
  approves: boolean;
  added_by: string;
  added_how: AddedHow;
  added_at: Date;
  updated_at: Date;
}

const COLUMNS =
  'id, name, email, console_role, github_login, github_user_id, github_linked_at, approves, added_by, added_how, added_at, updated_at';

export function fromRow(row: Row): Person {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    consoleRole: row.console_role,
    githubLogin: row.github_login,
    // bigint comes back as a string; a GitHub account id fits a number.
    githubUserId: row.github_user_id === null ? null : Number(row.github_user_id),
    githubLinkedAt: row.github_linked_at ? row.github_linked_at.toISOString() : null,
    approves: row.approves,
    addedBy: row.added_by,
    addedHow: row.added_how,
    addedAt: row.added_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** A person as a console user, for `Roles`; null for someone who cannot sign in. */
export function asUser(person: Person): User | null {
  if (!person.email || !person.consoleRole) return null;
  return {
    email: person.email,
    role: person.consoleRole,
    addedBy: person.addedBy,
    addedHow: person.addedHow,
    addedAt: person.addedAt,
    updatedAt: person.updatedAt,
  };
}

/**
 * Every change to `people` takes this lock inside its transaction: the lock
 * `users` took, so two admins demoting each other at once cannot both pass the
 * last-admin check, and two first visitors cannot both become admin.
 */
const LOCK = 'openadlc:users';

async function locked<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTransaction(async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [LOCK]);
    return fn(client);
  });
}

/** Written in the same transaction as the change, so a change is never unaudited. */
async function audit(client: PoolClient, actor: string, action: string, target: string, payload: Record<string, unknown>): Promise<void> {
  await client.query('insert into audit (actor, action, target, payload) values ($1,$2,$3,$4)', [actor, action, target, JSON.stringify(payload)]);
}

/** What an audit row calls a person: their email, else `@login`, else their id. */
export function personLabel(person: Pick<Person, 'id' | 'name' | 'email' | 'githubLogin'>): string {
  return person.email ?? (person.githubLogin ? `@${person.githubLogin}` : person.name || person.id);
}

async function rowFor(client: PoolClient, id: string): Promise<Row> {
  const result = await client.query<Row>(`select ${COLUMNS} from people where id = $1 for update`, [id]);
  const row = result.rows[0];
  if (!row) throw new UserChangeRefused('not-found', 'there is no such person: reload People');
  return row;
}

async function adminCount(client: PoolClient): Promise<number> {
  const result = await client.query<{ count: string }>("select count(*) as count from people where console_role = 'admin'");
  return Number(result.rows[0]?.count ?? 0);
}

function onlyAdmin(row: Row): UserChangeRefused {
  return new UserChangeRefused('last-admin', `${row.email ?? row.name ?? row.id} is the only admin. Make someone else an admin first`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listPeople(): Promise<Person[]> {
  const rows = await query<Row>(`select ${COLUMNS} from people order by added_at, id`);
  return rows.map(fromRow);
}

export async function personById(id: string): Promise<Person | null> {
  if (!UUID.test(id)) return null;
  const row = await queryOne<Row>(`select ${COLUMNS} from people where id = $1`, [id]);
  return row ? fromRow(row) : null;
}

export async function personByEmail(email: string): Promise<Person | null> {
  const row = await queryOne<Row>(`select ${COLUMNS} from people where email = $1`, [normalizeEmail(email)]);
  return row ? fromRow(row) : null;
}

/** The person a GitHub delivery's account is: by its numeric id, never by login. */
export async function personByGithubId(githubUserId: number): Promise<Person | null> {
  const row = await queryOne<Row>(`select ${COLUMNS} from people where github_user_id = $1`, [githubUserId]);
  return row ? fromRow(row) : null;
}

/**
 * On a local install every console identity is the operator: the person who
 * was the first to arrive, or else the earliest admin.
 */
export async function operator(): Promise<Person | null> {
  const row = await queryOne<Row>(
    `select ${COLUMNS} from people where console_role = 'admin'
      order by (added_how = 'first') desc, added_at, id limit 1`,
  );
  return row ? fromRow(row) : null;
}

/** The people who approve, in the order they were added: what `humans` is. */
export async function approvers(): Promise<Person[]> {
  const rows = await query<Row>(`select ${COLUMNS} from people where approves order by added_at, id`);
  return rows.map(fromRow);
}

/** The console users, for `Roles`: every person with an email and a console role. */
export async function listUsers(): Promise<User[]> {
  const rows = await query<Row>(`select ${COLUMNS} from people where console_role is not null and email is not null order by console_role, email`);
  return rows.map(fromRow).map(asUser).filter((user): user is User => user !== null);
}

/**
 * The first admins, while there are none: every email given, as admin, and
 * only if nobody can sign in to the console yet once the lock is held. What a
 * second bridge or a second first visitor finds is the rows the first one
 * wrote, and it adds nothing. A person already listed by that email (someone
 * GitHub-only who linked from it) is made admin rather than added twice.
 */
export async function bootstrapAdmins(emails: readonly string[], how: 'first' | 'admin-emails' | 'console-members', actor: string): Promise<User[]> {
  const wanted = [...new Set(emails.map(normalizeEmail).filter(Boolean))];
  if (wanted.length === 0) return [];
  return locked(async (client) => {
    const existing = await client.query<{ count: string }>('select count(*) as count from people where console_role is not null');
    if (Number(existing.rows[0]?.count ?? 0) > 0) return [];
    const added: User[] = [];
    for (const email of wanted) {
      const result = await client.query<Row>(
        `insert into people (email, console_role, added_by, added_how) values ($1, 'admin', $2, $3)
         on conflict (email) do update set console_role = 'admin', updated_at = now()
         returning ${COLUMNS}`,
        [email, actor, how],
      );
      const row = result.rows[0];
      if (!row) continue;
      const user = asUser(fromRow(row));
      if (user) added.push(user);
      await audit(client, actor, 'user.bootstrap_admin', email, { role: 'admin', how });
    }
    return added;
  });
}

export interface PersonInput {
  name?: string;
  email?: string | null;
  consoleRole?: Role | null;
  /** A login and the account it resolves to now, as the bridge asked GitHub. */
  github?: { login: string; id: number } | null;
}

function cleanEmail(email: string | null | undefined): string | null {
  if (email === null || email === undefined) return null;
  const address = normalizeEmail(email);
  if (!address) return null;
  if (!isEmail(address)) throw new UserChangeRefused('invalid', `${JSON.stringify(email)} is not an email address`);
  return address;
}

function cleanRole(role: Role | null | undefined): Role | null {
  if (role === null || role === undefined) return null;
  if (!ROLES.includes(role)) throw new UserChangeRefused('invalid', `a console role is admin or user, not ${JSON.stringify(role)}`);
  return role;
}

/** A unique email or account held by someone else, said as a refusal. */
function clash(error: unknown, input: { email: string | null; login?: string | null }): never {
  const pg = error as { code?: string; constraint?: string } | null;
  if (pg?.code === '23505') {
    if (pg.constraint?.includes('email')) throw new UserChangeRefused('exists', `${input.email} is already in People; change that entry instead`);
    throw new UserChangeRefused('exists', `@${input.login ?? ''} is already someone's in People; change that entry, or merge the two`);
  }
  throw error;
}

/**
 * Adds a person. A login an admin names is pinned to the account it resolves
 * to now and is never confirmed: only the person's own link confirms it.
 */
export async function addPerson(input: PersonInput, by: string): Promise<Person> {
  const email = cleanEmail(input.email);
  const role = cleanRole(input.consoleRole);
  const name = (input.name ?? '').trim();
  if (!email && !input.github && !name) throw new UserChangeRefused('invalid', 'a person needs an email or a GitHub login');
  if (role && !email) throw new UserChangeRefused('invalid', 'a console role needs an email to sign in with');
  return locked(async (client) => {
    const result = await client
      .query<Row>(
        `insert into people (name, email, console_role, github_login, github_user_id, added_by, added_how)
         values ($1, $2, $3, $4, $5, $6, 'added') returning ${COLUMNS}`,
        [name, email, role, input.github?.login ?? null, input.github?.id ?? null, by],
      )
      .catch((error: unknown) => clash(error, { email, login: input.github?.login }));
    const person = fromRow(result.rows[0] as Row);
    await audit(client, by, 'person.added', person.id, {
      name,
      email,
      consoleRole: role,
      githubLogin: input.github?.login ?? null,
    });
    return person;
  });
}

/**
 * Changes a person's name, email, console role or GitHub login. A new login
 * is not the account the person confirmed, nor the one an admin approved: the
 * link is cleared and Approves turned off.
 */
export async function updatePerson(id: string, input: PersonInput, by: string): Promise<Person> {
  return locked(async (client) => {
    const row = await rowFor(client, id);
    const before = fromRow(row);
    const next = { ...before };
    if (input.name !== undefined) next.name = input.name.trim();
    if (input.email !== undefined) next.email = cleanEmail(input.email);
    if (input.consoleRole !== undefined) next.consoleRole = cleanRole(input.consoleRole);
    let accountChanged = false;
    if (input.github !== undefined) {
      const login = input.github?.login ?? null;
      const accountId = input.github?.id ?? null;
      if (accountId !== before.githubUserId || (login ?? '').toLowerCase() !== (before.githubLogin ?? '').toLowerCase()) {
        accountChanged = accountId !== before.githubUserId;
        next.githubLogin = login;
        next.githubUserId = accountId;
        if (accountChanged) next.githubLinkedAt = null;
      }
    }
    if (next.consoleRole && !next.email) throw new UserChangeRefused('invalid', 'a console role needs an email to sign in with');
    if (before.consoleRole === 'admin' && next.consoleRole !== 'admin' && (await adminCount(client)) <= 1) throw onlyAdmin(row);
    const approves = before.approves && !accountChanged && next.githubLogin !== null;
    const result = await client
      .query<Row>(
        `update people set name = $2, email = $3, console_role = $4, github_login = $5, github_user_id = $6,
                github_linked_at = $7, approves = $8, updated_at = now()
          where id = $1 returning ${COLUMNS}`,
        [id, next.name, next.email, next.consoleRole, next.githubLogin, next.githubUserId, next.githubLinkedAt, approves],
      )
      .catch((error: unknown) => clash(error, { email: next.email, login: next.githubLogin }));
    const after = fromRow(result.rows[0] as Row);
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    for (const field of ['name', 'email', 'consoleRole', 'githubLogin', 'githubUserId'] as const) {
      if (before[field] !== after[field]) changed[field] = { from: before[field], to: after[field] };
    }
    if (Object.keys(changed).length > 0) await audit(client, by, 'person.changed', id, changed);
    if (before.approves && !after.approves) await audit(client, by, 'person.approves_off', id, { login: before.githubLogin, why: 'account changed' });
    return after;
  });
}

/** Turns Approves on or off. Refused for someone with no resolved GitHub account. */
export async function setApproves(id: string, on: boolean, by: string, why?: string): Promise<Person> {
  return locked(async (client) => {
    const row = await rowFor(client, id);
    if (row.approves === on) return fromRow(row);
    if (on && (!row.github_login || row.github_user_id === null)) {
      throw new UserChangeRefused('invalid', `Give ${personLabel(fromRow(row))} a GitHub login first`);
    }
    const result = await client.query<Row>(`update people set approves = $2, updated_at = now() where id = $1 returning ${COLUMNS}`, [id, on]);
    await audit(client, by, on ? 'person.approves_on' : 'person.approves_off', id, { login: row.github_login, ...(why ? { why } : {}) });
    return fromRow(result.rows[0] as Row);
  });
}

/**
 * Makes exactly these accounts approve: each is turned on, a GitHub-only
 * person added for one nobody holds, and every other person turned off. What
 * `PATCH /v1/install {humans}` and the walkthrough's "Who approves" step write.
 */
export async function setApprovers(accounts: readonly { login: string; id: number }[], by: string): Promise<Person[]> {
  return locked(async (client) => {
    const kept = new Set<string>();
    for (const account of accounts) {
      const found = await client.query<Row>(`select ${COLUMNS} from people where github_user_id = $1 for update`, [account.id]);
      let row = found.rows[0];
      if (!row) {
        const added = await client.query<Row>(
          `insert into people (github_login, github_user_id, approves, added_by, added_how) values ($1, $2, true, $3, 'added') returning ${COLUMNS}`,
          [account.login, account.id, by],
        );
        row = added.rows[0] as Row;
        await audit(client, by, 'person.added', row.id, { githubLogin: account.login });
        await audit(client, by, 'person.approves_on', row.id, { login: account.login, why: 'humans' });
      } else if (!row.approves) {
        await client.query('update people set approves = true, updated_at = now() where id = $1', [row.id]);
        await audit(client, by, 'person.approves_on', row.id, { login: row.github_login, why: 'humans' });
      }
      kept.add(row.id);
    }
    const others = await client.query<{ id: string; github_login: string | null }>('select id, github_login from people where approves');
    for (const other of others.rows) {
      if (kept.has(other.id)) continue;
      await client.query('update people set approves = false, updated_at = now() where id = $1', [other.id]);
      await audit(client, by, 'person.approves_off', other.id, { login: other.github_login, why: 'humans' });
    }
    const rows = await client.query<Row>(`select ${COLUMNS} from people where approves order by added_at, id`);
    return rows.rows.map(fromRow);
  });
}

/**
 * Takes a person's id out of every person role, in the caller's transaction,
 * so a person removed and later added again (with a new id) does not regain
 * their old roles (ADR 0032, kept by 0034).
 */
async function pruneFromRoles(client: PoolClient, ids: readonly string[], by: string, into?: string): Promise<void> {
  const result = await client.query<{ value: string }>("select value from settings where key = 'personRoles' for update");
  const raw = result.rows[0]?.value;
  if (!raw) return;
  let parsed: { roles?: { id?: string; name?: string; members?: unknown }[] };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return;
  }
  if (!Array.isArray(parsed?.roles)) return;
  const removed: { role: string; person: string }[] = [];
  const roles = parsed.roles.map((role) => {
    const members = Array.isArray(role.members) ? role.members.filter((member): member is string => typeof member === 'string') : [];
    const next: string[] = [];
    for (const member of members) {
      const gone = ids.includes(member);
      if (gone) removed.push({ role: role.name ?? role.id ?? '', person: member });
      const kept = gone ? into : member;
      if (kept && !next.includes(kept)) next.push(kept);
    }
    return { ...role, members: next };
  });
  if (removed.length === 0) return;
  await client.query("update settings set value = $1, updated_at = now(), updated_by = $2 where key = 'personRoles'", [JSON.stringify({ ...parsed, roles }), by]);
  if (!into) await audit(client, by, 'people_roles.pruned', 'install', { removed });
}

/** Removes a person, and takes them off every role. The last admin cannot be removed. */
export async function removePerson(id: string, by: string): Promise<void> {
  await locked(async (client) => {
    const row = await rowFor(client, id);
    if (row.console_role === 'admin' && (await adminCount(client)) <= 1) throw onlyAdmin(row);
    await client.query('delete from people where id = $1', [id]);
    await audit(client, by, 'person.removed', id, { email: row.email, githubLogin: row.github_login, approves: row.approves });
    await pruneFromRoles(client, [id], by);
  });
}

/**
 * Merges one person into another: an email and a login that are the same
 * person but could not be matched. Refused when both have an email, or both
 * hold different accounts. The kept row takes the other's missing fields, and
 * the roles of both.
 */
export async function mergePeople(id: string, into: string, by: string, how: 'admin' | 'link' = 'admin'): Promise<Person> {
  if (id === into) throw new UserChangeRefused('invalid', 'a person cannot be merged into themselves');
  return locked(async (client) => mergeIn(client, id, into, by, how));
}

async function mergeIn(client: PoolClient, id: string, into: string, by: string, how: 'admin' | 'link'): Promise<Person> {
  const gone = await rowFor(client, id);
  const kept = await rowFor(client, into);
  if (gone.email && kept.email) {
    throw new UserChangeRefused('exists', `${gone.email} and ${kept.email} both sign in to the console: remove one instead`);
  }
  if (gone.github_user_id !== null && kept.github_user_id !== null && String(gone.github_user_id) !== String(kept.github_user_id)) {
    throw new UserChangeRefused('exists', `@${gone.github_login} and @${kept.github_login} are different GitHub accounts: they cannot be one person`);
  }
  const takeAccount = kept.github_user_id === null && gone.github_user_id !== null;
  await client.query('delete from people where id = $1', [id]);
  const result = await client.query<Row>(
    `update people set
        name = case when name = '' then $2 else name end,
        email = coalesce(email, $3),
        console_role = coalesce(console_role, $4),
        github_login = case when $5 then $6 else coalesce(github_login, $6) end,
        github_user_id = coalesce(github_user_id, $7),
        github_linked_at = coalesce(github_linked_at, $8),
        approves = approves or $9,
        updated_at = now()
      where id = $1 returning ${COLUMNS}`,
    [into, gone.name, gone.email, gone.console_role, takeAccount, gone.github_login, gone.github_user_id, gone.github_linked_at, gone.approves],
  );
  await audit(client, by, 'person.merged', into, { from: id, fromLabel: personLabel(fromRow(gone)), how });
  await pruneFromRoles(client, [id], by, into);
  return fromRow(result.rows[0] as Row);
}

/** Thrown when the account is already another person's. */
export class AccountLinkedElsewhere extends Error {
  constructor(readonly login: string) {
    super(`@${login} is already linked to another person here. They unlink it in Settings first.`);
    this.name = 'AccountLinkedElsewhere';
  }
}

/**
 * The device-code link: the signed-in person proved they are this account.
 * A GitHub-only person holding it with no email and no link of their own
 * (brought over from `humans`) is merged in, since the person has just proved
 * they are that account. One held by a person with an email, or linked, is
 * refused. A link that changes an approving person's account turns Approves
 * off: an admin approved that account, not whatever the person links later.
 */
export async function linkAccount(input: { identity: string; githubLogin: string; githubUserId: number; personId?: string }, by: string): Promise<Person> {
  const email = normalizeEmail(input.identity);
  return locked(async (client) => {
    let selfRow: Row | undefined;
    if (input.personId) selfRow = await rowFor(client, input.personId);
    else selfRow = (await client.query<Row>(`select ${COLUMNS} from people where email = $1 for update`, [email])).rows[0];
    if (!selfRow) {
      const added = await client.query<Row>(
        `insert into people (email, added_by, added_how) values ($1, $2, 'linked') returning ${COLUMNS}`,
        [email, by],
      );
      selfRow = added.rows[0] as Row;
    }
    const holder = (await client.query<Row>(`select ${COLUMNS} from people where github_user_id = $1 for update`, [input.githubUserId])).rows[0];
    if (holder && holder.id !== selfRow.id) {
      if (holder.email || holder.github_linked_at) throw new AccountLinkedElsewhere(input.githubLogin);
      // The account moves with the merge; clear it on the kept row first so
      // the unique id is not held twice.
      if (selfRow.github_user_id !== null) {
        await client.query('update people set github_user_id = null, github_linked_at = null where id = $1', [selfRow.id]);
        if (selfRow.approves) {
          await client.query('update people set approves = false where id = $1', [selfRow.id]);
          await audit(client, by, 'person.approves_off', selfRow.id, { login: selfRow.github_login, why: 'account changed' });
        }
      }
      await mergeIn(client, holder.id, selfRow.id, by, 'link');
    } else if (selfRow.approves && selfRow.github_user_id !== null && String(selfRow.github_user_id) !== String(input.githubUserId)) {
      await client.query('update people set approves = false where id = $1', [selfRow.id]);
      await audit(client, by, 'person.approves_off', selfRow.id, { login: selfRow.github_login, why: 'account changed' });
    }
    const result = await client.query<Row>(
      `update people set github_login = $2, github_user_id = $3, github_linked_at = now(), updated_at = now()
        where id = $1 returning ${COLUMNS}`,
      [selfRow.id, input.githubLogin, input.githubUserId],
    );
    return fromRow(result.rows[0] as Row);
  });
}

/**
 * Forgets a person's confirmation. The named login and its pin stay, so an
 * admin's approval of that account is not undone by the person unlinking.
 */
export async function unlinkAccount(input: { identity?: string; personId?: string }): Promise<Person | null> {
  const row = input.personId
    ? await queryOne<Row>(
        `update people set github_linked_at = null, updated_at = now() where id = $1 and github_linked_at is not null returning ${COLUMNS}`,
        [input.personId],
      )
    : await queryOne<Row>(
        `update people set github_linked_at = null, updated_at = now() where email = $1 and github_linked_at is not null returning ${COLUMNS}`,
        [normalizeEmail(input.identity ?? '')],
      );
  return row ? fromRow(row) : null;
}

/**
 * Pins an approving person's login on its first use, as `humanIds` was for a
 * login saved before pins were kept. Only fills an empty pin.
 */
export async function pinAccount(id: string, githubUserId: number): Promise<void> {
  await query('update people set github_user_id = $2, updated_at = now() where id = $1 and github_user_id is null', [id, githubUserId]).catch(
    () => undefined,
  );
}
