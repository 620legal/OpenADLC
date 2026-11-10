import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({ query: vi.fn(), queryOne: vi.fn() }));

import { query, queryOne } from '../client.js';
import { listForIssue, newestMoves, record, sendBackCounts } from './stage-moves.js';

const row = {
  id: 'm1',
  repo_id: 'r1',
  issue_number: 7,
  pr_number: null,
  from_stage: 'build',
  to_stage: 'spec',
  kind: 'send_back',
  actor: 'builder',
  task_id: 't1',
  reason: 'the design names no migration',
  comment_url: null,
  created_at: new Date('2026-09-30T10:00:00Z'),
};

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(queryOne).mockReset();
});

describe('stage moves', () => {
  it('records a send-back with who sent it and why', async () => {
    vi.mocked(queryOne).mockResolvedValue(row);
    const move = await record({ repoId: 'r1', issueNumber: 7, from: 'build', to: 'spec', kind: 'send_back', actor: 'builder', taskId: 't1', reason: 'the design names no migration' });
    expect(vi.mocked(queryOne).mock.calls[0]![1]).toEqual(['r1', 7, null, 'build', 'spec', 'send_back', 'builder', 't1', 'the design names no migration', null]);
    expect(move).toMatchObject({ from: 'build', to: 'spec', kind: 'send_back', createdAt: '2026-09-30T10:00:00.000Z' });
  });

  it('reads an issue’s moves oldest first', async () => {
    vi.mocked(query).mockResolvedValue([row]);
    const moves = await listForIssue('r1', 7);
    expect(String(vi.mocked(query).mock.calls[0]![0])).toMatch(/order by created_at, id/);
    expect(moves[0]).toMatchObject({ issueNumber: 7, reason: 'the design names no migration' });
  });

  it('reads each issue’s newest move in one query, ties broken by id', async () => {
    vi.mocked(query).mockResolvedValue([{ ...row, to_stage: 'build', from_stage: 'review', pr_number: 281 }]);
    const moves = await newestMoves([
      { repoId: 'r1', issueNumber: 7 },
      { repoId: 'r2', issueNumber: 9 },
    ]);
    const [sql, params] = vi.mocked(query).mock.calls[0]!;
    expect(String(sql)).toMatch(/distinct on \(repo_id, issue_number\)/);
    expect(String(sql)).toMatch(/order by repo_id, issue_number, created_at desc, id desc/);
    expect(params).toEqual([['r1', 'r2'], [7, 9]]);
    expect(moves.get('r1#7')).toMatchObject({ from: 'review', to: 'build', prNumber: 281 });
    expect(moves.has('r2#9')).toBe(false);
  });

  it('makes no query for no issues', async () => {
    expect((await newestMoves([])).size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it('counts each issue’s send-backs for the board', async () => {
    vi.mocked(query).mockResolvedValue([{ repo_id: 'r1', issue_number: 7, count: '2' }]);
    expect((await sendBackCounts()).get('r1#7')).toBe(2);
  });
});
