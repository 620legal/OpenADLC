import type { PoolClient } from 'pg';
import { query, withTransaction } from '../client.js';

/**
 * The people who may use the console, and what each may do there. See
 * `migrations/0025_users.sql`; the bridge enforces the role (`roles.ts`).
 */
export type Role = 'admin' | 'user';

export const ROLES: readonly Role[] = ['admin', 'user'];

/** How a row came to be: added by an admin, or one of the first admins, and from where. */
export type AddedHow = 'added' | 'first' | 'admin-emails' | 'console-members';

export interface User {
  email: string;
  role: Role;
  addedBy: string;
  addedHow: AddedHow;
  addedAt: string;
  updatedAt: string;
}

interface Row {
  email: string;
  role: Role;
  added_by: string;
  added_how: AddedHow;
  added_at: Date;
  updated_at: Date;
}

/**
 * A change refused for what it would do, not because the database failed:
 * the route says it as a 409 or a 404 a person can act on.
 */
export class UserChangeRefused extends Error {
  constructor(
    readonly reason: 'last-admin' | 'exists' | 'not-found' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'UserChangeRefused';
  }
}

/**
 * One spelling per person. IAP's claim can carry `accounts.google.com:` in
 * front, an address copied from `console_members` carries `user:`, and a
 * person typing one capitalises it however they like; the row is keyed on
 * none of them, or it would never match the email IAP asserts.
 */
export function normalizeEmail(email: string): string {
  return email.trim().replace(/^accounts\.google\.com:/i, '').replace(/^user:/i, '').trim().toLowerCase();
}

/** Something an admin can type that could be the email IAP asserts. */
export function isEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+$/.test(email);
}

/**
 * Every change to `users` takes this lock inside its transaction. Two admins
 * demoting each other at once would each see the other still an admin, and
 * both would pass the last-admin check; two first visitors arriving at once
 * would each find the table empty and both become admin.
 */
const LOCK = 'fleetadlc:users';

const COLUMNS = 'email, role, added_by, added_how, added_at, updated_at';

function fromRow(row: Row): User {
  return {
    email: row.email,
    role: row.role,
    addedBy: row.added_by,
    addedHow: row.added_how,
    addedAt: row.added_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

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

async function adminCount(client: PoolClient): Promise<number> {
  const result = await client.query<{ count: string }>("select count(*) as count from users where role = 'admin'");
  return Number(result.rows[0]?.count ?? 0);
}

async function current(client: PoolClient, email: string): Promise<Row | null> {
  const result = await client.query<Row>(`select ${COLUMNS} from users where email = $1 for update`, [email]);
  return result.rows[0] ?? null;
}

export async function listUsers(): Promise<User[]> {
  const rows = await query<Row>(`select ${COLUMNS} from users order by role, email`);
  return rows.map(fromRow);
}

/**
 * The first admins, while there are none: every email given, as admin, and
 * only if `users` is still empty once the lock is held. What a second bridge
 * or a second first visitor finds is the rows the first one wrote, and it adds
 * nothing. Returns what was added, which is nothing when someone was first.
 */
export async function bootstrapAdmins(emails: readonly string[], how: Exclude<AddedHow, 'added'>, actor: string): Promise<User[]> {
  const wanted = [...new Set(emails.map(normalizeEmail).filter(Boolean))];
  if (wanted.length === 0) return [];
  return locked(async (client) => {
    const existing = await client.query<{ count: string }>('select count(*) as count from users');
    if (Number(existing.rows[0]?.count ?? 0) > 0) return [];
    const added: User[] = [];
    for (const email of wanted) {
      const result = await client.query<Row>(
        `insert into users (email, role, added_by, added_how) values ($1, 'admin', $2, $3) returning ${COLUMNS}`,
        [email, actor, how],
      );
      const row = result.rows[0];
      if (!row) continue;
      added.push(fromRow(row));
      await audit(client, actor, 'user.bootstrap_admin', email, { role: 'admin', how });
    }
    return added;
  });
}

export async function addUser(email: string, role: Role, by: string): Promise<User> {
  const address = normalizeEmail(email);
  if (!isEmail(address)) throw new UserChangeRefused('invalid', `${JSON.stringify(email)} is not an email address`);
  if (!ROLES.includes(role)) throw new UserChangeRefused('invalid', `a role is admin or user, not ${JSON.stringify(role)}`);
  return locked(async (client) => {
    const result = await client.query<Row>(
      `insert into users (email, role, added_by, added_how) values ($1, $2, $3, 'added')
       on conflict (email) do nothing returning ${COLUMNS}`,
      [address, role, by],
    );
    const row = result.rows[0];
    if (!row) throw new UserChangeRefused('exists', `${address} is already a user; change their role instead`);
    await audit(client, by, 'user.added', address, { role });
    return fromRow(row);
  });
}

/**
 * Gives someone another role. Demoting the last admin is refused: nobody could
 * then add an admin, or change any setting, without the database.
 */
export async function setRole(email: string, role: Role, by: string): Promise<User> {
  const address = normalizeEmail(email);
  if (!ROLES.includes(role)) throw new UserChangeRefused('invalid', `a role is admin or user, not ${JSON.stringify(role)}`);
  return locked(async (client) => {
    const row = await current(client, address);
    if (!row) throw new UserChangeRefused('not-found', `${address} is not a user`);
    if (row.role === role) return fromRow(row);
    if (row.role === 'admin' && (await adminCount(client)) <= 1) {
      throw new UserChangeRefused('last-admin', `${address} is the only admin. Make someone else an admin first`);
    }
    const result = await client.query<Row>(
      `update users set role = $2, updated_at = now() where email = $1 returning ${COLUMNS}`,
      [address, role],
    );
    await audit(client, by, 'user.role_changed', address, { from: row.role, to: role });
    return fromRow(result.rows[0] ?? { ...row, role });
  });
}

/** Removes someone. The last admin cannot be, for the reason `setRole` gives. */
export async function removeUser(email: string, by: string): Promise<void> {
  const address = normalizeEmail(email);
  await locked(async (client) => {
    const row = await current(client, address);
    if (!row) throw new UserChangeRefused('not-found', `${address} is not a user`);
    if (row.role === 'admin' && (await adminCount(client)) <= 1) {
      throw new UserChangeRefused('last-admin', `${address} is the only admin. Make someone else an admin first`);
    }
    await client.query('delete from users where email = $1', [address]);
    await audit(client, by, 'user.removed', address, { role: row.role });
  });
}
