import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

import { query, queryOne } from '../client.js';
import { activeFor, listActive, turnOff, turnOn } from './standing-approvals.js';

const ROW = {
  id: 'standing-1',
  repo_id: 'repo-1',
  issue_number: 77,
  set_by: 'orzelig',
  set_at: new Date('2026-10-22T10:00:00.000Z'),
  gate_id: 'gate-1',
  ended_at: null,
  ended_by: null,
  ended_why: null,
};

const ON = {
  id: 'standing-1',
  repoId: 'repo-1',
  issueNumber: 77,
  setBy: 'orzelig',
  setAt: '2026-10-22T10:00:00.000Z',
  gateId: 'gate-1',
  endedAt: null,
  endedBy: null,
  endedWhy: null,
};

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(queryOne).mockReset();
});

describe('a standing approval of an issue’s plan changes', () => {
  it('is turned on once per issue: a second turn-on is the one already on', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(ROW);
    await expect(turnOn({ repoId: 'repo-1', issueNumber: 77, setBy: 'orzelig', gateId: 'gate-1' })).resolves.toEqual(ON);
    const [sql, params] = vi.mocked(queryOne).mock.calls[0] ?? [];
    expect(String(sql)).toMatch(/on conflict \(repo_id, issue_number\) where ended_at is null do nothing/);
    expect(params).toEqual(['repo-1', 77, 'orzelig', 'gate-1']);

    // Already on, by someone else: the insert returns nothing, and the row on is read.
    vi.mocked(queryOne).mockResolvedValueOnce(null).mockResolvedValueOnce({ ...ROW, set_by: 'janedoe' });
    await expect(turnOn({ repoId: 'repo-1', issueNumber: 77, setBy: 'orzelig' })).resolves.toMatchObject({ setBy: 'janedoe' });
  });

  it('is read only while it is on', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(ROW);
    await expect(activeFor('repo-1', 77)).resolves.toEqual(ON);
    expect(String(vi.mocked(queryOne).mock.calls[0]?.[0])).toMatch(/ended_at is null/);
    vi.mocked(query).mockResolvedValueOnce([ROW]);
    await expect(listActive()).resolves.toEqual([ON]);
  });

  it('ends with who ended it and why, and ending one that is off changes nothing', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ ...ROW, ended_at: new Date('2026-10-23T00:00:00.000Z'), ended_by: 'openadlc', ended_why: '#80 merged' });
    await expect(turnOff({ repoId: 'repo-1', issueNumber: 77, by: 'openadlc', why: '#80 merged' })).resolves.toMatchObject({
      endedBy: 'openadlc',
      endedWhy: '#80 merged',
      endedAt: '2026-10-23T00:00:00.000Z',
    });
    const [sql, params] = vi.mocked(queryOne).mock.calls[0] ?? [];
    expect(String(sql)).toMatch(/update standing_plan_approvals set ended_at = now\(\)/);
    expect(String(sql)).toMatch(/ended_at is null/);
    expect(params).toEqual(['repo-1', 77, 'openadlc', '#80 merged']);

    vi.mocked(queryOne).mockResolvedValueOnce(null);
    await expect(turnOff({ repoId: 'repo-1', issueNumber: 77, by: 'openadlc', why: 'again' })).resolves.toBeNull();
  });
});
