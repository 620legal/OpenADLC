import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The table as far as these statements read it: each test says what the
 * `users` rows are, and the fake client answers the statements the store
 * sends from them, recording each one.
 */
const db = vi.hoisted(() => ({
  rows: [] as { email: string; role: 'admin' | 'user' }[],
  sent: [] as { sql: string; params: unknown[] }[],
}));

function row(email: string, role: string) {
  return { email, role, added_by: 'janedoe@example.com', added_how: 'added', added_at: new Date('2026-09-30T10:00:00Z'), updated_at: new Date('2026-09-30T10:00:00Z') };
}

const client = {
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    db.sent.push({ sql, params });
    if (sql.includes("count(*) as count from users where role = 'admin'")) {
      return { rows: [{ count: String(db.rows.filter((one) => one.role === 'admin').length) }] };
    }
    if (sql.includes('count(*) as count from users')) return { rows: [{ count: String(db.rows.length) }] };
    if (sql.includes('for update')) {
      const found = db.rows.find((one) => one.email === params[0]);
      return { rows: found ? [row(found.email, found.role)] : [] };
    }
    if (sql.startsWith('insert into users')) {
      const [email, second] = params as string[];
      if (db.rows.some((one) => one.email === email)) return { rows: [] };
      const role = sql.includes("'admin'") ? 'admin' : (second as 'admin' | 'user');
      db.rows.push({ email: email!, role });
      return { rows: [row(email!, role)] };
    }
    if (sql.startsWith('update users')) {
      const found = db.rows.find((one) => one.email === params[0])!;
      found.role = params[1] as 'admin' | 'user';
      return { rows: [row(found.email, found.role)] };
    }
    if (sql.startsWith('delete from users')) {
      db.rows = db.rows.filter((one) => one.email !== params[0]);
      return { rows: [] };
    }
    return { rows: [] };
  }),
};

vi.mock('../client.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(async (fn: (c: typeof client) => Promise<unknown>) => fn(client)),
}));

import { addUser, bootstrapAdmins, normalizeEmail, removeUser, setRole, UserChangeRefused } from './users.js';

beforeEach(() => {
  db.rows = [];
  db.sent = [];
});

const audited = () => db.sent.filter((one) => one.sql.startsWith('insert into audit')).map((one) => [one.params[1], one.params[2]]);
const locked = () => db.sent[0]?.sql.includes('pg_advisory_xact_lock');

async function refusal(promise: Promise<unknown>): Promise<UserChangeRefused> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(UserChangeRefused);
  return error as UserChangeRefused;
}

describe('the first admins', () => {
  it('are added only while nobody is a user yet, each audited as a bootstrap admin', async () => {
    const added = await bootstrapAdmins(['JaneDoe@Example.com', 'janedoe@example.com'], 'first', 'janedoe@example.com');
    expect(added.map((user) => [user.email, user.role])).toEqual([['janedoe@example.com', 'admin']]);
    expect(locked()).toBe(true);
    expect(audited()).toEqual([['user.bootstrap_admin', 'janedoe@example.com']]);

    // A second visitor, or a second bridge, finds the first one's row and adds nothing.
    db.sent = [];
    expect(await bootstrapAdmins(['bob@example.com'], 'first', 'bob@example.com')).toEqual([]);
    expect(db.rows.map((one) => one.email)).toEqual(['janedoe@example.com']);
    expect(audited()).toEqual([]);
  });
});

describe('changing who may use the console', () => {
  it('adds a person lower-cased, audited, and refuses the same person twice', async () => {
    const user = await addUser(' Bob@Example.com ', 'user', 'janedoe@example.com');
    expect(user).toMatchObject({ email: 'bob@example.com', role: 'user' });
    expect(audited()).toEqual([['user.added', 'bob@example.com']]);
    expect((await refusal(addUser('bob@example.com', 'admin', 'janedoe@example.com'))).reason).toBe('exists');
  });

  it('refuses what is not an email or a role', async () => {
    expect((await refusal(addUser('bob', 'user', 'janedoe@example.com'))).reason).toBe('invalid');
    expect((await refusal(addUser('bob@example.com', 'owner' as never, 'janedoe@example.com'))).reason).toBe('invalid');
  });

  it('changes a role and audits from what to what', async () => {
    db.rows = [{ email: 'janedoe@example.com', role: 'admin' }, { email: 'bob@example.com', role: 'user' }];
    expect(await setRole('bob@example.com', 'admin', 'janedoe@example.com')).toMatchObject({ role: 'admin' });
    const change = db.sent.find((one) => one.sql.startsWith('insert into audit'))!;
    expect(change.params.slice(1, 3)).toEqual(['user.role_changed', 'bob@example.com']);
    expect(JSON.parse(change.params[3] as string)).toEqual({ from: 'user', to: 'admin' });
  });

  it('never leaves the install with no admin: the last one is neither demoted nor removed', async () => {
    db.rows = [{ email: 'janedoe@example.com', role: 'admin' }, { email: 'bob@example.com', role: 'user' }];
    expect((await refusal(setRole('janedoe@example.com', 'user', 'janedoe@example.com'))).reason).toBe('last-admin');
    expect((await refusal(removeUser('JaneDoe@example.com', 'janedoe@example.com'))).reason).toBe('last-admin');
    expect(db.rows).toHaveLength(2);
    expect(audited()).toEqual([]);

    // With a second admin, either may go.
    db.rows.push({ email: 'carol@example.com', role: 'admin' });
    await removeUser('janedoe@example.com', 'carol@example.com');
    expect(db.rows.map((one) => one.email)).toEqual(['bob@example.com', 'carol@example.com']);
    expect(audited()).toEqual([['user.removed', 'janedoe@example.com']]);
  });

  it('says a person who is not there is not there', async () => {
    expect((await refusal(removeUser('nobody@example.com', 'janedoe@example.com'))).reason).toBe('not-found');
    expect((await refusal(setRole('nobody@example.com', 'user', 'janedoe@example.com'))).reason).toBe('not-found');
  });

  it('takes the lock before it reads, so two changes cannot both pass the last-admin check', async () => {
    db.rows = [{ email: 'janedoe@example.com', role: 'admin' }, { email: 'bob@example.com', role: 'admin' }];
    await setRole('bob@example.com', 'user', 'janedoe@example.com');
    expect(locked()).toBe(true);
  });

  it('keys a person on one spelling', () => {
    expect(normalizeEmail('accounts.google.com:JaneDoe@Example.com')).toBe('janedoe@example.com');
    // As `console_members` writes it, pasted into Add or into admin_emails.
    expect(normalizeEmail(' user:JaneDoe@Example.com')).toBe('janedoe@example.com');
  });
});
