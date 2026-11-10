import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `people` as far as the store's statements read it: each test says what the
 * rows are, and the fake client answers the statements the store sends from
 * them, recording each one.
 */
interface FakeRow {
  id: string;
  name: string;
  email: string | null;
  console_role: 'admin' | 'user' | null;
  github_login: string | null;
  github_user_id: number | null;
  github_linked_at: Date | null;
  approves: boolean;
  added_by: string;
  added_how: string;
  added_at: Date;
  updated_at: Date;
}

const db = vi.hoisted(() => ({
  rows: [] as FakeRow[],
  roles: null as string | null,
  sent: [] as { sql: string; params: unknown[] }[],
  next: 0,
}));

const AT = new Date('2026-11-09T10:00:00Z');

function person(fields: Partial<FakeRow> & { id: string }): FakeRow {
  return {
    name: '',
    email: null,
    console_role: null,
    github_login: null,
    github_user_id: null,
    github_linked_at: null,
    approves: false,
    added_by: 'jane@example.com',
    added_how: 'added',
    added_at: AT,
    updated_at: AT,
    ...fields,
  };
}

const byId = (id: unknown) => db.rows.find((one) => one.id === id);
const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const client = {
  query: vi.fn(async (raw: string, params: unknown[] = []) => {
    const sql = flat(raw);
    db.sent.push({ sql, params });
    if (sql.startsWith('select pg_advisory_xact_lock') || sql.startsWith('insert into audit')) return { rows: [] };
    if (sql.includes("count(*) as count from people where console_role = 'admin'")) {
      return { rows: [{ count: String(db.rows.filter((one) => one.console_role === 'admin').length) }] };
    }
    if (sql.includes('count(*) as count from people where console_role is not null')) {
      return { rows: [{ count: String(db.rows.filter((one) => one.console_role !== null).length) }] };
    }
    if (sql.includes('from people where id = $1 for update')) return { rows: byId(params[0]) ? [{ ...byId(params[0]) }] : [] };
    if (sql.includes('from people where email = $1 for update')) return { rows: db.rows.filter((one) => one.email === params[0]) };
    if (sql.includes('from people where github_user_id = $1 for update')) return { rows: db.rows.filter((one) => one.github_user_id === params[0]) };
    if (sql.includes('from people where github_user_id is null and lower(github_login) = lower($1)')) {
      const login = String(params[0]).toLowerCase();
      return { rows: db.rows.filter((one) => one.github_user_id === null && one.github_login?.toLowerCase() === login).slice(0, 1) };
    }
    if (sql.startsWith('update people set github_login = $2, github_user_id = $3, approves = true')) {
      const row = byId(params[0])!;
      Object.assign(row, { github_login: params[1], github_user_id: params[2], approves: true });
      return { rows: [{ ...row }] };
    }
    if (sql.startsWith('insert into people (github_login, github_user_id, approves')) {
      const row = person({ id: `p-${++db.next}`, github_login: params[0] as string, github_user_id: params[1] as number, approves: true });
      db.rows.push(row);
      return { rows: [row] };
    }
    if (sql === 'select id, github_login from people where approves') return { rows: db.rows.filter((one) => one.approves) };
    if (sql.startsWith('update people set approves = false, updated_at = now() where id = $1')) {
      byId(params[0])!.approves = false;
      return { rows: [] };
    }
    if (sql.includes('from people where approves order by')) return { rows: db.rows.filter((one) => one.approves) };
    if (sql.startsWith("insert into people (email, console_role, added_by, added_how) values ($1, 'admin'")) {
      const row = person({ id: `p-${++db.next}`, email: params[0] as string, console_role: 'admin', added_how: params[2] as string });
      db.rows.push(row);
      return { rows: [row] };
    }
    if (sql.startsWith('insert into people (name, email, console_role, github_login, github_user_id')) {
      const [name, email, role, login, id] = params as [string, string | null, FakeRow['console_role'], string | null, number | null];
      if (email && db.rows.some((one) => one.email === email)) throw Object.assign(new Error('dup'), { code: '23505', constraint: 'people_email_key' });
      const row = person({ id: `p-${++db.next}`, name, email, console_role: role, github_login: login, github_user_id: id });
      db.rows.push(row);
      return { rows: [row] };
    }
    if (sql.startsWith("insert into people (email, added_by, added_how) values ($1, $2, 'linked')")) {
      const row = person({ id: `p-${++db.next}`, email: params[0] as string, added_how: 'linked' });
      db.rows.push(row);
      return { rows: [row] };
    }
    if (sql.startsWith('update people set name = $2, email = $3')) {
      const row = byId(params[0])!;
      [row.name, row.email, row.console_role, row.github_login, row.github_user_id, row.github_linked_at, row.approves] = params.slice(1) as [
        string, string | null, FakeRow['console_role'], string | null, number | null, Date | null, boolean,
      ];
      return { rows: [row] };
    }
    if (sql.startsWith('update people set approves = $2')) {
      const row = byId(params[0])!;
      row.approves = params[1] as boolean;
      return { rows: [row] };
    }
    if (sql.startsWith('update people set approves = false where id = $1')) {
      byId(params[0])!.approves = false;
      return { rows: [] };
    }
    if (sql.startsWith('update people set github_user_id = null')) {
      Object.assign(byId(params[0])!, { github_user_id: null, github_linked_at: null });
      return { rows: [] };
    }
    if (sql.startsWith('update people set name = case')) {
      const row = byId(params[0])!;
      const [, name, email, role, takeAccount, login, id, linked, approves] = params as [
        string, string, string | null, FakeRow['console_role'], boolean, string | null, number | null, Date | null, boolean,
      ];
      if (row.name === '') row.name = name;
      row.email ??= email;
      row.console_role ??= role;
      row.github_login = takeAccount ? login : (row.github_login ?? login);
      row.github_user_id ??= id;
      row.github_linked_at ??= linked;
      row.approves ||= approves;
      return { rows: [row] };
    }
    if (sql.startsWith('update people set github_login = $2, github_user_id = $3, github_linked_at = now()')) {
      const row = byId(params[0])!;
      Object.assign(row, { github_login: params[1], github_user_id: params[2], github_linked_at: AT });
      return { rows: [row] };
    }
    if (sql.startsWith('delete from people where id = $1')) {
      db.rows = db.rows.filter((one) => one.id !== params[0]);
      return { rows: [] };
    }
    if (sql.startsWith("select value from settings where key = 'personRoles'")) return { rows: db.roles ? [{ value: db.roles }] : [] };
    if (sql.startsWith('update settings set value = $1')) {
      db.roles = params[0] as string;
      return { rows: [] };
    }
    return { rows: [] };
  }),
};

vi.mock('../client.js', () => ({
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  withTransaction: vi.fn(async (fn: (c: typeof client) => Promise<unknown>) => fn(client)),
}));

import { AccountLinkedElsewhere, addPerson, bootstrapAdmins, linkAccount, mergePeople, removePerson, setApprovers, setApproves, updatePerson } from './people.js';
import { UserChangeRefused } from './users.js';

beforeEach(() => {
  db.rows = [];
  db.roles = null;
  db.sent = [];
  db.next = 0;
});

const audited = () => db.sent.filter((one) => one.sql.startsWith('insert into audit')).map((one) => [one.params[0], one.params[1], one.params[2]]);
const lockedFirst = () => db.sent[0]?.sql.startsWith('select pg_advisory_xact_lock') === true;

describe('the first admins', () => {
  it('are added only while nobody can sign in yet, each audited', async () => {
    const added = await bootstrapAdmins(['Jane@Example.com'], 'first', 'jane@example.com');
    expect(added.map((user) => [user.email, user.role])).toEqual([['jane@example.com', 'admin']]);
    expect(lockedFirst()).toBe(true);
    expect(await bootstrapAdmins(['bob@example.com'], 'first', 'bob@example.com')).toEqual([]);
    expect(audited()).toEqual([['jane@example.com', 'user.bootstrap_admin', 'jane@example.com']]);
  });

  it('do not count a GitHub-only person, who cannot sign in', async () => {
    db.rows = [person({ id: 'p-gh', github_login: 'carol', github_user_id: 7, approves: true, added_how: 'humans' })];
    expect(await bootstrapAdmins(['jane@example.com'], 'first', 'jane@example.com')).toHaveLength(1);
  });
});

describe('adding and changing a person', () => {
  it('adds one with an email and a named login, never confirmed, audited by who added them', async () => {
    const added = await addPerson({ name: 'Jane', email: 'Jane@Example.com', consoleRole: 'user', github: { login: 'janedoe', id: 583231 } }, 'admin@example.com');
    expect(added).toMatchObject({ email: 'jane@example.com', consoleRole: 'user', githubLogin: 'janedoe', githubUserId: 583231, githubLinkedAt: null, approves: false });
    expect(audited()).toEqual([['admin@example.com', 'person.added', added.id]]);
  });

  it('refuses a console role with no email, and a person with nothing to know them by', async () => {
    await expect(addPerson({ consoleRole: 'user', github: { login: 'x', id: 1 } }, 'a')).rejects.toBeInstanceOf(UserChangeRefused);
    await expect(addPerson({}, 'a')).rejects.toThrow(/an email or a GitHub login/);
  });

  it('says the same email twice as already in People', async () => {
    await addPerson({ email: 'jane@example.com' }, 'a');
    await expect(addPerson({ email: 'jane@example.com' }, 'a')).rejects.toThrow(/already in People/);
  });

  it('never leaves the install with no admin: the last one is neither demoted nor removed', async () => {
    db.rows = [person({ id: 'p-1', email: 'jane@example.com', console_role: 'admin' })];
    await expect(updatePerson('p-1', { consoleRole: 'user' }, 'jane@example.com')).rejects.toMatchObject({ reason: 'last-admin' });
    await expect(removePerson('p-1', 'jane@example.com')).rejects.toMatchObject({ reason: 'last-admin' });
    expect(db.rows).toHaveLength(1);
  });

  it('turns Approves off and clears the link when the account changes, audited with why', async () => {
    db.rows = [person({ id: 'p-1', email: 'jane@example.com', github_login: 'janedoe', github_user_id: 5, github_linked_at: AT, approves: true })];
    const after = await updatePerson('p-1', { github: { login: 'someoneelse', id: 9 } }, 'admin@example.com');
    expect(after).toMatchObject({ githubLogin: 'someoneelse', githubUserId: 9, githubLinkedAt: null, approves: false });
    expect(audited().map(([, action]) => action)).toEqual(['person.changed', 'person.approves_off']);
  });
});

describe('Approves', () => {
  it('is turned on and off, each audited with who did it', async () => {
    db.rows = [person({ id: 'p-1', github_login: 'carol', github_user_id: 7 })];
    expect((await setApproves('p-1', true, 'admin@example.com')).approves).toBe(true);
    expect((await setApproves('p-1', false, 'admin@example.com')).approves).toBe(false);
    expect(audited()).toEqual([
      ['admin@example.com', 'person.approves_on', 'p-1'],
      ['admin@example.com', 'person.approves_off', 'p-1'],
    ]);
  });

  it('is refused for someone with no GitHub account', async () => {
    db.rows = [person({ id: 'p-1', email: 'jane@example.com' })];
    await expect(setApproves('p-1', true, 'a')).rejects.toThrow('Give jane@example.com a GitHub login first');
  });
});

describe('setting the approvers from a list of logins', () => {
  it('pins a migrated approver that had no pin, rather than adding them twice', async () => {
    // What 0162 makes of a `humans` login with no `humanIds` pin.
    db.rows = [person({ id: 'p-gh', github_login: 'carol', github_user_id: null, approves: true, added_how: 'humans' })];
    const approving = await setApprovers([{ login: 'Carol', id: 7 }], 'admin@example.com');
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ id: 'p-gh', github_login: 'Carol', github_user_id: 7, approves: true });
    expect(approving.map((one) => one.id)).toEqual(['p-gh']);
    expect(audited()).toEqual([['admin@example.com', 'person.changed', 'p-gh']]);
  });

  it('turns an unpinned, non-approving person on by login, audited', async () => {
    db.rows = [person({ id: 'p-1', email: 'jane@example.com', github_login: 'janedoe' })];
    await setApprovers([{ login: 'janedoe', id: 5 }], 'admin@example.com');
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ github_user_id: 5, approves: true });
    expect(audited().map(([, action]) => action)).toEqual(['person.changed', 'person.approves_on']);
  });

  it('takes the login GitHub spells now for a pinned account that was renamed', async () => {
    db.rows = [person({ id: 'p-1', github_login: 'oldname', github_user_id: 5, approves: true })];
    await setApprovers([{ login: 'newname', id: 5 }], 'admin@example.com');
    expect(db.rows[0]).toMatchObject({ github_login: 'newname', github_user_id: 5, approves: true });
    expect(audited().map(([, action]) => action)).toEqual(['person.changed']);
  });

  it('does not take a pinned row by login: that login now belongs to another account', async () => {
    db.rows = [person({ id: 'p-old', github_login: 'carol', github_user_id: 5, approves: true })];
    await setApprovers([{ login: 'carol', id: 9 }], 'admin@example.com');
    expect(db.rows).toHaveLength(2);
    expect(db.rows.find((one) => one.id === 'p-old')).toMatchObject({ github_user_id: 5, approves: false });
    expect(db.rows.find((one) => one.id !== 'p-old')).toMatchObject({ github_login: 'carol', github_user_id: 9, approves: true });
  });

  it('changes nothing for an approver already pinned under the same login', async () => {
    db.rows = [person({ id: 'p-1', github_login: 'carol', github_user_id: 7, approves: true })];
    await setApprovers([{ login: 'carol', id: 7 }], 'admin@example.com');
    expect(audited()).toEqual([]);
    expect(db.sent.some((one) => one.sql.startsWith('update people'))).toBe(false);
  });
});

describe('removing and merging', () => {
  it('takes a removed person off every role in the same change', async () => {
    db.rows = [person({ id: 'p-1', email: 'jane@example.com' }), person({ id: 'p-2', email: 'bob@example.com' })];
    db.roles = JSON.stringify({ roles: [{ id: 'product', members: ['p-1', 'p-2'] }, { id: 'legal', members: ['p-2'] }] });
    await removePerson('p-2', 'jane@example.com');
    expect(JSON.parse(db.roles).roles.map((role: { members: string[] }) => role.members)).toEqual([['p-1'], []]);
    expect(audited().map(([, action]) => action)).toEqual(['person.removed', 'people_roles.pruned']);
  });

  it('merges a GitHub-only person into the email they are, keeping Approves and their roles', async () => {
    db.rows = [
      person({ id: 'p-1', email: 'jane@example.com', console_role: 'admin' }),
      person({ id: 'p-2', github_login: 'janedoe', github_user_id: 5, approves: true }),
    ];
    db.roles = JSON.stringify({ roles: [{ id: 'product', members: ['p-2'] }] });
    const kept = await mergePeople('p-2', 'p-1', 'jane@example.com');
    expect(kept).toMatchObject({ id: 'p-1', email: 'jane@example.com', githubLogin: 'janedoe', githubUserId: 5, approves: true });
    expect(JSON.parse(db.roles).roles[0].members).toEqual(['p-1']);
    expect(db.rows.map((row) => row.id)).toEqual(['p-1']);
  });

  it('refuses two emails, and two different accounts', async () => {
    db.rows = [
      person({ id: 'p-1', email: 'jane@example.com' }),
      person({ id: 'p-2', email: 'bob@example.com' }),
      person({ id: 'p-3', github_login: 'a', github_user_id: 1 }),
      person({ id: 'p-4', github_login: 'b', github_user_id: 2 }),
    ];
    await expect(mergePeople('p-2', 'p-1', 'x')).rejects.toThrow(/both sign in/);
    await expect(mergePeople('p-4', 'p-3', 'x')).rejects.toThrow(/different GitHub accounts/);
  });
});

describe("a person's own link", () => {
  it('confirms the account on the signed-in person', async () => {
    db.rows = [person({ id: 'p-1', email: 'jane@example.com', github_login: 'janedoe', github_user_id: 5 })];
    const linked = await linkAccount({ identity: 'jane@example.com', githubLogin: 'janedoe', githubUserId: 5 }, 'jane@example.com');
    expect(linked.githubLinkedAt).not.toBeNull();
  });

  it('merges in the GitHub-only person who held that account, keeping Approves', async () => {
    db.rows = [person({ id: 'p-1', email: 'jane@example.com' }), person({ id: 'p-2', github_login: 'janedoe', github_user_id: 5, approves: true, added_how: 'humans' })];
    const linked = await linkAccount({ identity: 'jane@example.com', githubLogin: 'janedoe', githubUserId: 5 }, 'jane@example.com');
    expect(linked).toMatchObject({ id: 'p-1', githubUserId: 5, approves: true });
    expect(db.rows.map((row) => row.id)).toEqual(['p-1']);
    expect(audited().map(([, action]) => action)).toContain('person.merged');
  });

  it('refuses an account another person with an email holds', async () => {
    db.rows = [person({ id: 'p-1', email: 'jane@example.com' }), person({ id: 'p-2', email: 'bob@example.com', github_user_id: 5, github_login: 'bob' })];
    await expect(linkAccount({ identity: 'jane@example.com', githubLogin: 'bob', githubUserId: 5 }, 'jane@example.com')).rejects.toBeInstanceOf(
      AccountLinkedElsewhere,
    );
  });

  it('turns Approves off when it changes an approving person’s account', async () => {
    db.rows = [person({ id: 'p-1', email: 'jane@example.com', github_login: 'janedoe', github_user_id: 5, approves: true })];
    const linked = await linkAccount({ identity: 'jane@example.com', githubLogin: 'other', githubUserId: 6 }, 'jane@example.com');
    expect(linked).toMatchObject({ githubUserId: 6, approves: false });
    expect(audited()).toEqual([['jane@example.com', 'person.approves_off', 'p-1']]);
  });
});
