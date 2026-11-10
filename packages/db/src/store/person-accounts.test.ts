import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('./people.js', async (original) => ({
  ...(await original<typeof import('./people.js')>()),
  linkAccount: vi.fn(),
  unlinkAccount: vi.fn(),
}));

import { queryOne } from '../client.js';
import { linkAccount, unlinkAccount } from './people.js';
import { link, ofIdentity, ofUserId, unlink } from './person-accounts.js';

const ROW = { id: 'p-1', email: 'jane@example.com', github_login: 'janedoe', github_user_id: '583231', github_linked_at: new Date('2026-10-29T10:00:00.000Z') };
const LINKED = { identity: 'jane@example.com', githubLogin: 'janedoe', githubUserId: 583231, linkedAt: '2026-10-29T10:00:00.000Z' };

beforeEach(() => {
  vi.mocked(queryOne).mockReset();
  vi.mocked(linkAccount).mockReset();
  vi.mocked(unlinkAccount).mockReset();
});

describe("a person's GitHub account, kept on their row in People", () => {
  it('links through the person, as the person who signed in', async () => {
    vi.mocked(linkAccount).mockResolvedValue({
      id: 'p-1', name: '', email: 'jane@example.com', consoleRole: 'user', githubLogin: 'janedoe', githubUserId: 583231,
      githubLinkedAt: LINKED.linkedAt, approves: false, addedBy: 'x', addedHow: 'added', addedAt: LINKED.linkedAt, updatedAt: LINKED.linkedAt,
    });
    expect(await link({ identity: 'jane@example.com', githubLogin: 'janedoe', githubUserId: 583231 })).toEqual(LINKED);
    expect(linkAccount).toHaveBeenCalledWith({ identity: 'jane@example.com', githubLogin: 'janedoe', githubUserId: 583231 }, 'jane@example.com');
  });

  it('unlinks, and says whether there was a link', async () => {
    vi.mocked(unlinkAccount).mockResolvedValueOnce(null);
    expect(await unlink('jane@example.com')).toBe(false);
  });

  it('reads only a confirmed link, by person and by account id: a login an admin named is not one', async () => {
    vi.mocked(queryOne).mockResolvedValue(ROW);
    expect(await ofIdentity('Jane@Example.com')).toEqual(LINKED);
    expect(await ofUserId(583231)).toEqual(LINKED);
    for (const [sql] of vi.mocked(queryOne).mock.calls) expect(String(sql)).toContain('github_linked_at is not null');
    expect(vi.mocked(queryOne).mock.calls[0]![1]).toEqual(['jane@example.com']);
  });
});
