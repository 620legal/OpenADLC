import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({
  query: vi.fn(async () => []),
}));

import { query } from '../client.js';
import { forget, get, listForRepos, record } from './ignored-issues.js';

describe('the record of an issue labelled openadlc:ignore', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.mocked(query).mockResolvedValue([] as never);
  });

  it('is written as GitHub says it now, over what was there', async () => {
    await record('repo-1', 18, { state: 'closed', stateReason: 'completed', closedAt: '2026-10-20T10:00:00Z' });
    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toContain('insert into ignored_issues');
    expect(String(sql)).toContain('on conflict (repo_id, number) do update');
    expect(String(sql)).toContain('state_reason = excluded.state_reason');
    expect(params).toEqual(['repo-1', 18, 'closed', 'completed', '2026-10-20T10:00:00Z']);
  });

  it('keeps no close reason or time GitHub did not give: reopened, it no longer counts', async () => {
    await record('repo-1', 18, { state: 'open' });
    expect(vi.mocked(query).mock.calls[0]?.[1]).toEqual(['repo-1', 18, 'open', null, null]);
  });

  it('is forgotten by repository and number', async () => {
    await forget('repo-1', 18);
    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toContain('delete from ignored_issues');
    expect(params).toEqual(['repo-1', 18]);
  });

  it('is read back as the rule takes it', async () => {
    vi.mocked(query).mockResolvedValueOnce([
      { repo_id: 'repo-1', number: 18, state: 'closed', state_reason: 'not_planned', closed_at: new Date('2026-10-20T10:00:00Z') },
    ] as never);
    expect(await get('repo-1', 18)).toEqual({ repoId: 'repo-1', number: 18, state: 'closed', stateReason: 'not_planned', closedAt: '2026-10-20T10:00:00.000Z' });
    expect(await get('repo-1', 19)).toBeNull();
  });

  it('is listed for the repositories asked, and asks nothing for none', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ repo_id: 'repo-1', number: 4, state: 'open', state_reason: null, closed_at: null }] as never);
    expect(await listForRepos(['repo-1', 'repo-2'])).toEqual([{ repoId: 'repo-1', number: 4, state: 'open', stateReason: null, closedAt: null }]);
    expect(vi.mocked(query).mock.calls[0]?.[1]).toEqual([['repo-1', 'repo-2']]);
    vi.mocked(query).mockClear();
    expect(await listForRepos([])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
