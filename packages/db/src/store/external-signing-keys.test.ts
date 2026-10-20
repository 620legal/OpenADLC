import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({ query: vi.fn(), queryOne: vi.fn() }));

import { query } from '../client.js';
import { listExternal, markExternal, unmarkExternal } from './external-signing-keys.js';

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe('a signing key dismissed as used elsewhere', () => {
  it('keeps who said so and when, and a later press replaces the earlier', async () => {
    vi.mocked(query).mockResolvedValue([]);
    const at = new Date('2026-10-19T08:00:00Z');
    await markExternal('abner620legal', 6, 'or@example.com', 'laptop', at);
    const [sql, params] = vi.mocked(query).mock.calls[0]!;
    expect(String(sql)).toMatch(/on conflict \(login, key_id\) do update set/);
    expect(params).toEqual(['abner620legal', 6, 'laptop', 'or@example.com', at]);
  });

  it('keeps a key with no title all the same', async () => {
    vi.mocked(query).mockResolvedValue([]);
    await markExternal('abner620legal', 6, 'or@example.com');
    expect(vi.mocked(query).mock.calls[0]![1]![2]).toBeNull();
  });

  it('reads back one account’s keys, oldest dismissal first, with GitHub’s id as a number', async () => {
    vi.mocked(query).mockResolvedValue([
      { login: 'abner620legal', key_id: '6', title: 'laptop', dismissed_by: 'or@example.com', dismissed_at: new Date('2026-10-19T08:00:00Z') },
    ]);
    expect(await listExternal('abner620legal')).toEqual([
      { login: 'abner620legal', keyId: 6, title: 'laptop', dismissedBy: 'or@example.com', dismissedAt: '2026-10-19T08:00:00.000Z' },
    ]);
    expect(String(vi.mocked(query).mock.calls[0]![0])).toMatch(/order by dismissed_at, key_id/);
  });
});

describe('the undo', () => {
  it('forgets the key and says it did', async () => {
    vi.mocked(query).mockResolvedValue([{ login: 'abner620legal' }]);
    expect(await unmarkExternal('abner620legal', 6)).toBe(true);
    const [sql, params] = vi.mocked(query).mock.calls[0]!;
    expect(String(sql)).toMatch(/^delete from external_signing_keys/);
    expect(params).toEqual(['abner620legal', 6]);
  });

  it('says when there was nothing to undo', async () => {
    vi.mocked(query).mockResolvedValue([]);
    expect(await unmarkExternal('abner620legal', 6)).toBe(false);
  });
});
