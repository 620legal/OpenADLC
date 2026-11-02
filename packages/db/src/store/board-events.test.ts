import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({ query: vi.fn(), queryOne: vi.fn() }));

import { query, queryOne } from '../client.js';
import { askedSince, dbNow, heldAuditSince, liveTasks, mergedSince, startedSince } from './board-events.js';

const since = new Date('2026-11-02T00:00:00Z');
const sql = (): string => String(vi.mocked(query).mock.calls[0]![0]);

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(queryOne).mockReset();
});

describe('the board feed’s reads', () => {
  it('takes now from the database, whose clock every since is compared with', async () => {
    vi.mocked(queryOne).mockResolvedValue({ now: since });
    expect(await dbNow()).toEqual(since);
    expect(String(vi.mocked(queryOne).mock.calls[0]![0])).toMatch(/select now\(\)/);
  });

  it('reads tasks started since, with the seat’s name', async () => {
    vi.mocked(query).mockResolvedValue([{ id: 't1', started_at: since, bot: 'builder', subject_ref: 'OpenADLC#227', kind: 'implement', skill: 'implement' }]);
    expect(await startedSince(since)).toEqual([{ taskId: 't1', at: since.toISOString(), bot: 'builder', subjectRef: 'OpenADLC#227', kind: 'implement', skill: 'implement' }]);
    expect(sql()).toMatch(/t\.started_at >= \$1/);
    expect(vi.mocked(query).mock.calls[0]![1]).toEqual([since]);
  });

  it('reads questions asked since, about their task’s subject or else their thread’s', async () => {
    vi.mocked(query).mockResolvedValue([{ id: 'g1', created_at: since, bot: 'system-engineer', subject_ref: 'OpenADLC#227', question: 'Which?' }]);
    expect(await askedSince(since)).toEqual([{ gateId: 'g1', at: since.toISOString(), bot: 'system-engineer', subjectRef: 'OpenADLC#227', question: 'Which?' }]);
    expect(sql()).toMatch(/coalesce\(t\.subject_ref, h\.subject_ref\)/);
    expect(sql()).toMatch(/g\.created_at >= \$1/);
  });

  it('reads merges as forward moves into Merged, or into Done from anywhere but Merged', async () => {
    vi.mocked(query).mockResolvedValue([{ id: 'm1', created_at: since, repo_name: 'OpenADLC', issue_number: 227, pr_number: 231, actor: 'orzelig', bot: null }]);
    expect(await mergedSince(since)).toEqual([{ moveId: 'm1', at: since.toISOString(), repoName: 'OpenADLC', issueNumber: 227, prNumber: 231, actor: 'orzelig', bot: null }]);
    // A Merged → Done move is the deploy, not a second merge.
    expect(sql()).toMatch(/m\.kind = 'forward'/);
    expect(sql()).toMatch(/m\.to_stage = 'merged' or \(m\.to_stage = 'done' and m\.from_stage is distinct from 'merged'\)/);
    // `moveClosedByMerge` records no number; the issue's is the fallback.
    expect(sql()).toMatch(/coalesce\(m\.pr_number, i\.pr_number\)/);
  });

  it('reads the pull requests a person held', async () => {
    vi.mocked(query).mockResolvedValue([{ id: '42', at: since, actor: 'orzelig', target: '620legal/OpenADLC#231', why: 'an unsigned crew post' }]);
    expect(await heldAuditSince(since)).toEqual([{ auditId: '42', at: since.toISOString(), actor: 'orzelig', target: '620legal/OpenADLC#231', why: 'an unsigned crew post' }]);
    expect(sql()).toMatch(/action = 'pull\.held'/);
  });

  it('reads live tasks oldest first, each since it came into its state', async () => {
    vi.mocked(query).mockResolvedValue([
      { id: 't1', bot: 'builder', kind: 'implement', skill: 'implement', subject_ref: 'OpenADLC#227', state: 'running', since, cost_usd: '1.2000', cost_cap_usd: '15.0000' },
      { id: 't2', bot: 'builder', kind: 'implement', skill: null, subject_ref: 'OpenADLC#228', state: 'running', since: null, cost_usd: '0', cost_cap_usd: '15' },
    ]);
    const live = await liveTasks();
    expect(live[0]).toEqual({ id: 't1', bot: 'builder', kind: 'implement', skill: 'implement', subjectRef: 'OpenADLC#227', state: 'running', since: since.toISOString(), costUsd: 1.2, capUsd: 15 });
    expect(live[1]!.since).toBeNull();
    expect(sql()).toMatch(/t\.state in \('queued', 'running', 'paused'\)/);
    // runningSince's rule: the newest answer after its pause, once it paused.
    expect(sql()).toMatch(/g\.answered_at > t\.paused_at/);
    expect(sql()).toMatch(/when 'paused' then t\.paused_at/);
    expect(sql()).toMatch(/when 'queued' then t\.created_at/);
    expect(sql()).toMatch(/order by t\.created_at/);
  });
});
