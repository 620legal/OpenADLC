import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

import { query, withTransaction } from '../client.js';
import { forPull, listSince, record } from './person-sign-offs.js';

const HEAD = 'a'.repeat(40);

const ROW = {
  id: 'sign-off-1',
  repo_id: 'repo-1',
  repo_name: 'app',
  pr_number: 46,
  head: HEAD,
  // `bigint` comes back from the driver as a string.
  github_user_id: '583231',
  github_login: 'janedoe',
  identity: 'jane@example.com',
  signed_at: new Date('2026-11-14T10:00:00.000Z'),
};

const SIGNED = {
  id: 'sign-off-1',
  repoId: 'repo-1',
  repoName: 'app',
  prNumber: 46,
  head: HEAD,
  githubUserId: 583231,
  githubLogin: 'janedoe',
  identity: 'jane@example.com',
  signedAt: '2026-11-14T10:00:00.000Z',
};

const INPUT = { repoId: 'repo-1', prNumber: 46, head: HEAD, githubUserId: 583231, githubLogin: 'janedoe', identity: 'jane@example.com' };

const AUDIT = {
  actor: 'jane@example.com',
  action: 'pull.human_review_signed_off',
  target: 'app#46',
  payload: { repo: 'app', pr: 46, login: 'janedoe', head: HEAD },
};

/**
 * A transaction as the database keeps one: its statements are kept only when
 * it commits, and none of them when any throws. `answer` gives each
 * statement's rows, or throws for it.
 */
function transaction(answer: (sql: string) => unknown[]) {
  const committed: { sql: string; params: unknown[] }[] = [];
  vi.mocked(withTransaction).mockImplementation(async (fn) => {
    const pending: { sql: string; params: unknown[] }[] = [];
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        const rows = answer(sql);
        pending.push({ sql, params });
        return { rows };
      },
    };
    const result = await fn(client as never);
    committed.push(...pending);
    return result;
  });
  return committed;
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(withTransaction).mockReset();
});

describe('an author’s sign-off of their own pull request', () => {
  it('is recorded with its audit entry in one transaction', async () => {
    const committed = transaction((sql) => (sql.includes('insert into person_sign_offs') ? [ROW] : []));
    await expect(record(INPUT, AUDIT)).resolves.toEqual({ signOff: SIGNED, created: true });
    expect(committed).toHaveLength(2);
    expect(committed[0]?.sql).toMatch(/on conflict \(repo_id, pr_number, head, github_user_id\) do nothing/);
    expect(committed[0]?.params).toEqual(['repo-1', 46, HEAD, 583231, 'janedoe', 'jane@example.com']);
    expect(committed[1]).toEqual({
      sql: 'insert into audit (actor, action, target, payload) values ($1, $2, $3, $4)',
      params: ['jane@example.com', 'pull.human_review_signed_off', 'app#46', JSON.stringify(AUDIT.payload)],
    });
  });

  it('keeps no sign-off when its audit entry cannot be written: neither lands', async () => {
    const committed = transaction((sql) => {
      if (sql.startsWith('insert into audit')) throw new Error('the audit table is full');
      return sql.includes('insert into person_sign_offs') ? [ROW] : [];
    });
    await expect(record(INPUT, AUDIT)).rejects.toThrow('the audit table is full');
    expect(committed).toEqual([]);
  });

  it('answers the one already there on a second press, and audits that press too', async () => {
    const committed = transaction((sql) => (sql.includes('insert into person_sign_offs') ? [] : sql.startsWith('select') ? [ROW] : []));
    await expect(record(INPUT, AUDIT)).resolves.toEqual({ signOff: SIGNED, created: false });
    expect(committed.map((one) => one.sql.split(' ')[0])).toEqual(['with', 'select', 'insert']);
  });

  it('says so when it can be neither recorded nor read, and audits nothing', async () => {
    const committed = transaction(() => []);
    await expect(record(INPUT, AUDIT)).rejects.toThrow(/could not be recorded or read; try again/);
    expect(committed).toEqual([]);
  });

  it('is read by pull request, and since a moment, with the repository’s name', async () => {
    vi.mocked(query).mockResolvedValueOnce([ROW]);
    await expect(forPull('repo-1', 46)).resolves.toEqual([SIGNED]);
    expect(vi.mocked(query).mock.calls[0]?.[1]).toEqual(['repo-1', 46]);
    expect(String(vi.mocked(query).mock.calls[0]?.[0])).toMatch(/join repos r on r\.id = s\.repo_id/);

    const since = new Date('2026-11-07T00:00:00.000Z');
    vi.mocked(query).mockResolvedValueOnce([ROW]);
    await expect(listSince(since)).resolves.toEqual([SIGNED]);
    expect(vi.mocked(query).mock.calls[1]?.[1]).toEqual([since]);
  });
});

describe('0167, the sign-offs’ table', () => {
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations', '0167_person_sign_offs.sql'), 'utf8')
    .replace(/--.*$/gm, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();

  it('keeps one row per pull request, head and account, with a full commit for the head', () => {
    expect(sql).toContain('create table if not exists person_sign_offs');
    expect(sql).toContain('unique (repo_id, pr_number, head, github_user_id)');
    expect(sql).toContain("check (head ~ '^[0-9a-f]{40}$')");
    expect(sql).toContain('github_user_id bigint not null');
  });
});
