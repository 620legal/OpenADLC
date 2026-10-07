import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

import { queryOne } from '../client.js';
import { enter } from './merge-lines.js';

beforeEach(() => {
  vi.mocked(queryOne).mockReset();
});

describe('a pull request entering the merge line again', () => {
  it('goes to the back once it had failed, and keeps its place while it is still in the line', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce({ first: 2, last: 3 })
      .mockResolvedValueOnce({
        id: 'entry-1',
        repo_id: 'repo-1',
        repo_name: 'api',
        pr_number: 1,
        position: 4,
        state: 'waiting',
        head_sha: 'abc',
        detail: null,
        entered_at: new Date('2026-10-01T00:00:00.000Z'),
      });

    await enter({ repoId: 'repo-1', prNumber: 1, headSha: 'abc' });

    const [sql, params] = vi.mocked(queryOne).mock.calls[1] ?? [];
    const text = String(sql).replace(/\s+/g, ' ');
    expect(text).toContain("position = case when merge_lines.state in ('failed', 'merged') then excluded.position else merge_lines.position end");
    expect(text).toContain("entered_at = case when merge_lines.state in ('failed', 'merged') then now() else merge_lines.entered_at end");
    expect(params).toEqual(['repo-1', 1, 4, 'abc']);
  });
});
