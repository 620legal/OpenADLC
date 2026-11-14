import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

import { query, queryOne } from '../client.js';
import { forPull, listSince, record, remove } from './person-sign-offs.js';

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

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(queryOne).mockReset();
});

describe('an author’s sign-off of their own pull request', () => {
  it('is recorded once per head and account: a second press answers the one already there', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(ROW);
    await expect(record(INPUT)).resolves.toEqual({ signOff: SIGNED, created: true });
    const [sql, params] = vi.mocked(queryOne).mock.calls[0] ?? [];
    expect(String(sql)).toMatch(/on conflict \(repo_id, pr_number, head, github_user_id\) do nothing/);
    expect(params).toEqual(['repo-1', 46, HEAD, 583231, 'janedoe', 'jane@example.com']);

    vi.mocked(queryOne).mockResolvedValueOnce(null).mockResolvedValueOnce(ROW);
    await expect(record(INPUT)).resolves.toEqual({ signOff: SIGNED, created: false });
  });

  it('says so when it can be neither recorded nor read', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await expect(record(INPUT)).rejects.toThrow(/could not be recorded or read; try again/);
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

  it('is removed by id, for one whose audit row could not be written', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    await remove('sign-off-1');
    expect(vi.mocked(query).mock.calls[0]).toEqual(['delete from person_sign_offs where id = $1', ['sign-off-1']]);
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
