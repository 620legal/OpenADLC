import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({ query: vi.fn(), queryOne: vi.fn() }));

import { queryOne } from '../client.js';
import { passFor, record } from './local-ci-runs.js';

const row = {
  id: 'r1',
  run_id: 'run-1',
  task_id: 't1',
  repo_id: 'repo-1',
  branch: 'agent/builder/7-issue-7',
  head_sha: 'a'.repeat(40),
  ok: true,
  exit_code: 0,
  duration_ms: 1200,
  log_tail: 'ci: green',
  created_at: new Date('2026-09-30T10:00:00Z'),
};

beforeEach(() => {
  vi.mocked(queryOne).mockReset();
});

describe('local CI runs', () => {
  it('records a run once, however often hostd reports it', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(row).mockResolvedValueOnce(null);
    const input = { runId: 'run-1', taskId: 't1', repoId: 'repo-1', branch: row.branch, headSha: row.head_sha, ok: true, exitCode: 0, durationMs: 1200, logTail: 'ci: green' };

    expect(await record(input)).toMatchObject({ runId: 'run-1', ok: true, createdAt: '2026-09-30T10:00:00.000Z' });
    expect(await record(input)).toBeNull();
    expect(String(vi.mocked(queryOne).mock.calls[0]![0])).toContain('on conflict (run_id) do nothing');
  });

  it('finds a pass on a commit in a repository, and only a pass', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(row);
    expect(await passFor('repo-1', row.head_sha)).toMatchObject({ headSha: row.head_sha, ok: true });
    const [sql, params] = vi.mocked(queryOne).mock.calls[0]!;
    expect(String(sql)).toMatch(/where repo_id = \$1 and head_sha = \$2 and ok/);
    expect(params).toEqual(['repo-1', row.head_sha]);
  });
});
