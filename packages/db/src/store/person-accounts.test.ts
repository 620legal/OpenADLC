import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

import { query, queryOne } from '../client.js';
import { AccountLinkedElsewhere, link, ofIdentity, ofUserId, unlink } from './person-accounts.js';

const ROW = { identity: 'jane@example.com', github_login: 'janedoe', github_user_id: '583231', linked_at: new Date('2026-10-29T10:00:00.000Z') };
const LINKED = { identity: 'jane@example.com', githubLogin: 'janedoe', githubUserId: 583231, linkedAt: '2026-10-29T10:00:00.000Z' };

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(queryOne).mockReset();
});

describe("a person's GitHub account", () => {
  it('links the account they signed in as, keeping only its login and id', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(ROW);
    expect(await link({ identity: 'jane@example.com', githubLogin: 'janedoe', githubUserId: 583231 })).toEqual(LINKED);
    const [sql, params] = vi.mocked(queryOne).mock.calls[0]!;
    expect(sql).toMatch(/insert into person_github_accounts \(identity, github_login, github_user_id\)/);
    expect(params).toEqual(['jane@example.com', 'janedoe', 583231]);
  });

  it('refuses an account another person has linked, on a first link or a change', async () => {
    vi.mocked(queryOne).mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));
    await expect(link({ identity: 'bob@example.com', githubLogin: 'janedoe', githubUserId: 583231 })).rejects.toBeInstanceOf(AccountLinkedElsewhere);
    // The person already had a row: the update's guard returns nothing.
    vi.mocked(queryOne).mockResolvedValueOnce(null);
    await expect(link({ identity: 'bob@example.com', githubLogin: 'janedoe', githubUserId: 583231 })).rejects.toThrow(/already linked to another person/);
  });

  it('unlinks, and says whether there was a link', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ identity: 'jane@example.com' }]);
    expect(await unlink('jane@example.com')).toBe(true);
    vi.mocked(query).mockResolvedValueOnce([]);
    expect(await unlink('jane@example.com')).toBe(false);
  });

  it('reads a link by person and by account id', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(ROW).mockResolvedValueOnce(null);
    expect(await ofIdentity('jane@example.com')).toEqual(LINKED);
    expect(await ofUserId(1)).toBeNull();
  });
});
