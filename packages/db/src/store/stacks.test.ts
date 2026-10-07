import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({ query: vi.fn(), queryOne: vi.fn() }));

import { query, queryOne } from '../client.js';
import { listStacks, markPaused, recordStack, removeStack, stackOf } from './stacks.js';

const row = {
  repo_id: 'repo-1',
  issue_number: 5,
  on_issue: 4,
  on_pr: 30,
  on_branch: 'agent/atlas/4-issue-4',
  on_head_sha: 'a'.repeat(40),
  started_at: new Date('2026-08-01T12:00:00Z'),
  paused_at: null,
};

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(queryOne).mockReset();
});

describe('a stack', () => {
  it('is recorded once per stacked issue, a new stacking replacing the old and its hold', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(row);
    const stack = await recordStack({ repoId: 'repo-1', issue: 5, onIssue: 4, onPr: 30, onBranch: row.on_branch, onHeadSha: row.on_head_sha });
    expect(stack).toEqual({
      repoId: 'repo-1',
      issue: 5,
      onIssue: 4,
      onPr: 30,
      onBranch: row.on_branch,
      onHeadSha: row.on_head_sha,
      startedAt: '2026-08-01T12:00:00.000Z',
      pausedAt: null,
    });
    const sql = String(vi.mocked(queryOne).mock.calls[0]![0]);
    expect(sql).toContain('on conflict (repo_id, issue_number) do update');
    expect(sql).toContain('paused_at = null');
  });

  it('refuses to say it was recorded when no row came back', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(null);
    await expect(recordStack({ repoId: 'repo-1', issue: 5, onIssue: 4, onPr: 30, onBranch: 'b', onHeadSha: null })).rejects.toThrow(/could not record/);
  });

  it('is read with no window, however long ago it started', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(row).mockResolvedValueOnce(null);
    expect((await stackOf('repo-1', 5))?.onIssue).toBe(4);
    expect(await stackOf('repo-1', 6)).toBeNull();
    expect(String(vi.mocked(queryOne).mock.calls[0]![0])).not.toMatch(/started_at\s*>=/);
  });

  it('is listed, removed, and held once', async () => {
    vi.mocked(query).mockResolvedValueOnce([row]).mockResolvedValue([]);
    expect((await listStacks('repo-1')).map((stack) => stack.issue)).toEqual([5]);
    await removeStack('repo-1', 5);
    await markPaused('repo-1', 5);
    expect(String(vi.mocked(query).mock.calls[1]![0])).toContain('delete from stacks');
    expect(String(vi.mocked(query).mock.calls[2]![0])).toContain('and paused_at is null');
  });
});
