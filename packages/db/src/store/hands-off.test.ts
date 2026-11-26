import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

import { query, queryOne } from '../client.js';
import { end, endExpired, listOpen, openFor, turnOn } from './hands-off.js';

const ROW = {
  id: 'window-1',
  repo_id: 'repo-1',
  set_by: 'jane@example.com',
  set_by_login: 'janedoe',
  set_by_github_id: '4242',
  duration: '8h',
  set_at: new Date('2026-11-25T10:00:00.000Z'),
  ends_at: new Date('2026-11-25T18:00:00.000Z'),
  ended_at: null,
  ended_by: null,
  ended_why: null,
  ended_note: null,
};

const OPEN = {
  id: 'window-1',
  repoId: 'repo-1',
  setBy: 'jane@example.com',
  setByLogin: 'janedoe',
  setByGithubId: 4242,
  duration: '8h',
  setAt: '2026-11-25T10:00:00.000Z',
  endsAt: '2026-11-25T18:00:00.000Z',
  endedAt: null,
  endedBy: null,
  endedWhy: null,
  endedNote: null,
};

const INPUT = { repoId: 'repo-1', setBy: 'jane@example.com', setByLogin: 'janedoe', setByGithubId: 4242 } as const;

beforeEach(() => {
  vi.mocked(query).mockReset().mockResolvedValue([]);
  vi.mocked(queryOne).mockReset();
});

describe('a hands-off window', () => {
  it('is opened once per repository, ending at its duration, and a second turn-on is the one already open', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(ROW);
    await expect(turnOn({ ...INPUT, duration: '8h' })).resolves.toEqual({ window: OPEN, created: true, expired: [] });
    const [sql, params] = vi.mocked(queryOne).mock.calls[0] ?? [];
    expect(String(sql)).toMatch(/on conflict \(repo_id\) where ended_at is null do nothing/);
    expect(params).toEqual(['repo-1', 'jane@example.com', 'janedoe', 4242, '8h', 8 * 60 * 60_000]);

    // Already open, by someone else: nothing is inserted, and the open one is read.
    vi.mocked(queryOne).mockResolvedValueOnce(null).mockResolvedValueOnce({ ...ROW, set_by_login: 'sam' });
    await expect(turnOn({ ...INPUT, duration: '1h' })).resolves.toMatchObject({ created: false, window: { setByLogin: 'sam' } });
  });

  it('has no end when it is until turned off', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ ...ROW, duration: 'until_off', ends_at: null });
    await expect(turnOn({ ...INPUT, duration: 'until_off' })).resolves.toMatchObject({ window: { endsAt: null, duration: 'until_off' } });
    expect(vi.mocked(queryOne).mock.calls[0]?.[1]?.[5]).toBeNull();
  });

  it('ends one whose time has passed before opening another, so a lapsed one never refuses a new one, and answers it to be audited', async () => {
    const lapsed = { ...ROW, id: 'window-0', ended_at: new Date('2026-11-25T18:00:30.000Z'), ended_by: 'openadlc', ended_why: 'expired' };
    vi.mocked(query).mockResolvedValueOnce([lapsed]);
    vi.mocked(queryOne).mockResolvedValueOnce(ROW);
    const opened = await turnOn({ ...INPUT, duration: '1h' });
    expect(String(vi.mocked(query).mock.calls[0]?.[0])).toMatch(/ended_why = 'expired'[\s\S]*ends_at <= now\(\)[\s\S]*returning/);
    expect(opened).toMatchObject({ created: true, expired: [{ id: 'window-0', endedWhy: 'expired', endedBy: 'openadlc' }] });

    vi.mocked(queryOne).mockResolvedValueOnce(ROW);
    await expect(turnOn({ ...INPUT, duration: '1h' })).resolves.toMatchObject({ expired: [] });
  });

  it('records one ended after its time as expired by OpenADLC, whoever pressed Turn off', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ ...ROW, ended_at: new Date('2026-11-25T18:00:30.000Z'), ended_by: 'openadlc', ended_why: 'expired' });
    await expect(end({ repoId: 'repo-1', by: 'sam', why: 'turned_off' })).resolves.toMatchObject({ endedBy: 'openadlc', endedWhy: 'expired' });
    const sql = String(vi.mocked(queryOne).mock.calls[0]?.[0]);
    expect(sql).toMatch(/ended_by = case when ends_at is not null and ends_at <= now\(\) then 'openadlc' else \$2 end/);
    expect(sql).toMatch(/ended_why = case when ends_at is not null and ends_at <= now\(\) then 'expired' else \$3 end/);
  });

  it('is read as open only while its time has not passed, even before the sweep ends it', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(ROW);
    await expect(openFor('repo-1')).resolves.toEqual(OPEN);
    expect(String(vi.mocked(queryOne).mock.calls[0]?.[0])).toMatch(/ended_at is null and \(ends_at is null or ends_at > now\(\)\)/);

    vi.mocked(queryOne).mockResolvedValueOnce(null);
    await expect(openFor('repo-1')).resolves.toBeNull();

    vi.mocked(query).mockResolvedValueOnce([ROW]);
    await expect(listOpen()).resolves.toEqual([OPEN]);
    expect(String(vi.mocked(query).mock.calls.at(-1)?.[0])).toMatch(/ends_at > now\(\)/);
  });

  it('ends with who ended it, why and the cap’s words, and ending one that is off records nothing', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ ...ROW, ended_at: new Date('2026-11-25T12:00:00.000Z'), ended_by: 'openadlc', ended_why: 'cap', ended_note: 'the month is spent' });
    await expect(end({ repoId: 'repo-1', by: 'openadlc', why: 'cap', note: 'the month is spent' })).resolves.toMatchObject({
      endedBy: 'openadlc',
      endedWhy: 'cap',
      endedNote: 'the month is spent',
    });
    const [sql, params] = vi.mocked(queryOne).mock.calls[0] ?? [];
    expect(String(sql)).toMatch(/where repo_id = \$1 and ended_at is null/);
    expect(params).toEqual(['repo-1', 'openadlc', 'cap', 'the month is spent']);

    vi.mocked(queryOne).mockResolvedValueOnce(null);
    await expect(end({ repoId: 'repo-1', by: 'sam', why: 'turned_off' })).resolves.toBeNull();
  });

  it('ends every window whose time has passed, as OpenADLC', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ ...ROW, ended_at: new Date('2026-11-25T18:00:30.000Z'), ended_by: 'openadlc', ended_why: 'expired' }]);
    await expect(endExpired()).resolves.toEqual([expect.objectContaining({ endedWhy: 'expired', endedBy: 'openadlc' })]);
    expect(String(vi.mocked(query).mock.calls[0]?.[0])).toMatch(/ended_at is null and ends_at is not null and ends_at <= now\(\)/);
  });
});
