import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

import { query, queryOne } from '../client.js';
import {
  attemptsWithoutPullRequest,
  heldLeases,
  holdPlanChange,
  lastForPullRequest,
  latestLease,
  listHeldPlanChanges,
  narrowPaths,
  notePlanChange,
  planChangeOfDesignerTask,
  planChangeOfGate,
  planChangesOfGates,
  reacquireForPullRequest,
  releaseForClosedPull,
  releaseForPullRequest,
  releaseForRepo,
  releaseIdleForIssue,
  releaseIfIdle,
  releaseUnlessWorkedUnder,
  settlePausedLeases,
  widenPaths,
} from './leases.js';

const ROW = {
  id: 'lease-1',
  repo_id: 'repo-1',
  issue_number: 78,
  bot_id: 'bot-1',
  declared_paths: ['apps/bridge/src/gates.ts', 'apps/hostd/src/skill-runner.ts'],
  state: 'paused',
  expires_at: null,
  pr_number: null,
  updated_at: new Date('2026-09-28T23:00:00.000Z'),
};

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(queryOne).mockReset();
});

describe('the lease an issue was granted', () => {
  it('is the one holding it, or else the newest that did, never read from the issue', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ ...ROW, state: 'released' });

    const lease = await latestLease('repo-1', 78);

    const [sql, params] = vi.mocked(queryOne).mock.calls[0] ?? [];
    expect(String(sql)).toMatch(/from leases/);
    expect(String(sql)).toMatch(/order by \(state = any\(\$3\)\) desc, created_at desc limit 1/);
    expect(String(sql)).not.toMatch(/issues/);
    expect(params).toEqual(['repo-1', 78, ['leased', 'in_task', 'paused']]);
    expect(lease).toMatchObject({ issueNumber: 78, state: 'released', declaredPaths: ROW.declared_paths });
  });
});

describe('the leases the board reads', () => {
  it('are every one still holding an issue, each saying whether its pull request merged, in one read (#153)', async () => {
    vi.mocked(query).mockResolvedValueOnce([
      { ...ROW, state: 'in_task', pr_number: 57, pull_merged: true },
      { ...ROW, id: 'lease-2', issue_number: 79, state: 'leased', pull_merged: false },
    ]);

    const held = await heldLeases();

    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    const flat = String(sql).replace(/\s+/g, ' ');
    expect(flat).toContain('from leases l where l.state = any($1)');
    // Merged as the merge line or the pull request's link heard it.
    expect(flat).toContain("exists (select 1 from merge_lines m where m.repo_id = l.repo_id and m.pr_number = l.pr_number and m.state = 'merged')");
    expect(flat).toContain("exists (select 1 from work_item_links w where w.kind = 'pull' and w.repo_id = l.repo_id and w.number = l.pr_number and w.state = 'merged')");
    expect(params).toEqual([['leased', 'in_task', 'paused']]);
    expect(held).toEqual([
      expect.objectContaining({ id: 'lease-1', issueNumber: 78, state: 'in_task', prNumber: 57, pullMerged: true }),
      expect.objectContaining({ id: 'lease-2', issueNumber: 79, state: 'leased', prNumber: null, pullMerged: false }),
    ]);
  });
});

describe('widening a lease', () => {
  it('updates the lease and its issue in one statement, so neither can be widened without the other', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(ROW);

    const lease = await widenPaths('lease-1', ['apps/hostd/src/skill-runner.ts']);

    expect(queryOne).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
    const [sql, params] = vi.mocked(queryOne).mock.calls[0] ?? [];
    expect(String(sql)).toMatch(/update leases set/);
    expect(String(sql)).toMatch(/update issues set/);
    expect(params).toEqual(['lease-1', ['apps/hostd/src/skill-runner.ts'], ['leased', 'in_task', 'paused']]);
    expect(lease).toMatchObject({ id: 'lease-1', issueNumber: 78, declaredPaths: ROW.declared_paths });
  });

  it('finds the issue from the lease, so the two cannot name different issues', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(ROW);
    await widenPaths('lease-1', ['a.ts']);

    const sql = String(vi.mocked(queryOne).mock.calls[0]?.[0]);
    expect(sql).toMatch(/issues\.repo_id = widened\.repo_id and issues\.number = widened\.issue_number/);
  });

  it('adds only a path that is not already there, and keeps the order it had', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(ROW);
    await widenPaths('lease-1', ['a.ts']);

    const sql = String(vi.mocked(queryOne).mock.calls[0]?.[0]);
    expect(sql.match(/group by path order by min\(position\)/g)).toHaveLength(2);
  });

  it('widens only a lease still held', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(null);

    await expect(widenPaths('lease-1', ['a.ts'])).resolves.toBeNull();
    const sql = String(vi.mocked(queryOne).mock.calls[0]?.[0]);
    expect(sql).toMatch(/where id = \$1 and state = any\(\$3\)/);
  });
});

describe('the plan change a gate asked for', () => {
  it('is read from the gate’s message in the thread', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({
      payload: { gateId: 'gate-1', planChange: { paths: ['a.ts', 7, 'b.ts'], reason: 'needs them' } },
    });

    await expect(planChangeOfGate('gate-1')).resolves.toEqual({ paths: ['a.ts', 'b.ts'], reason: 'needs them', held: null });

    const [sql, params] = vi.mocked(queryOne).mock.calls[0] ?? [];
    expect(String(sql)).toMatch(/kind = 'gate' and payload->>'gateId' = \$1/);
    expect(params).toEqual(['gate-1']);
  });

  it('is nothing for a gate that asked an ordinary question', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ payload: { gateId: 'gate-1', options: ['yes', 'no'] } });
    await expect(planChangeOfGate('gate-1')).resolves.toBeNull();

    vi.mocked(queryOne).mockResolvedValueOnce(null);
    await expect(planChangeOfGate('gate-2')).resolves.toBeNull();
  });

  it('says who approved it and which issues it waits on, once held', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({
      payload: { planChange: { paths: ['a.ts'], reason: 'r' }, held: { approvedBy: 'alexsmith', blockedBy: [12, 'x', 30] } },
    });

    await expect(planChangeOfGate('gate-1')).resolves.toEqual({
      paths: ['a.ts'],
      reason: 'r',
      held: { approvedBy: 'alexsmith', blockedBy: [12, 30] },
    });
  });

  it('remembers an approval on the gate’s message, beside the request, only while the hold is the one read', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ id: 'message-1' }]);
    await expect(holdPlanChange('gate-1', { approvedBy: 'alexsmith', blockedBy: [12] }, null)).resolves.toBe(true);

    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toMatch(/update messages set payload = payload \|\| jsonb_build_object\('held'/);
    // Two approvals at once both read no hold, and both told the issue.
    expect(String(sql)).toMatch(/\(payload->'held'\) is not distinct from \$3::jsonb/);
    expect(params).toEqual(['gate-1', JSON.stringify({ approvedBy: 'alexsmith', blockedBy: [12] }), null]);

    vi.mocked(query).mockResolvedValueOnce([]);
    const was = { approvedBy: 'alexsmith', blockedBy: [12] };
    await expect(holdPlanChange('gate-1', { approvedBy: 'alexsmith', blockedBy: [], failed: 'not connected' }, was)).resolves.toBe(false);
    expect(vi.mocked(query).mock.calls[1]?.[1]).toEqual([
      'gate-1',
      JSON.stringify({ approvedBy: 'alexsmith', blockedBy: [], failed: 'not connected' }),
      JSON.stringify(was),
    ]);
  });

  it('says why adding the paths failed, once nothing held them', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({
      payload: { planChange: { paths: ['a.ts'], reason: 'r' }, held: { approvedBy: 'alexsmith', blockedBy: [], failed: 'not connected' } },
    });
    await expect(planChangeOfGate('gate-1')).resolves.toMatchObject({ held: { approvedBy: 'alexsmith', blockedBy: [], failed: 'not connected' } });
  });

  it('lists the open gates whose approval is waiting, oldest first, and not one that was never approved', async () => {
    vi.mocked(query).mockResolvedValueOnce([
      { gate_id: 'gate-1', payload: { planChange: { paths: ['a.ts'], reason: 'r' }, held: { approvedBy: 'alexsmith', blockedBy: [12] } } },
      { gate_id: 'gate-2', payload: { planChange: { paths: ['b.ts'], reason: 'r' } } },
      { gate_id: 'gate-3', payload: { options: ['yes'], held: { approvedBy: 'x', blockedBy: [] } } },
    ]);

    const held = await listHeldPlanChanges();

    expect(String(vi.mocked(query).mock.calls[0]?.[0])).toMatch(/g\.state = 'open' and m\.payload \? 'held'[\s\S]*order by g\.created_at/);
    expect(held.map((entry) => entry.gateId)).toEqual(['gate-1']);
    expect(held[0]?.request).toEqual({ paths: ['a.ts'], reason: 'r', held: { approvedBy: 'alexsmith', blockedBy: [12] } });
  });
});

describe('settling a paused lease whose work has ended', () => {
  const HOLD = new Date('2026-09-29T11:00:00.000Z');
  /** A lease the read found: paused, nothing unfinished under it. */
  const candidate = (input: { id?: string; pr?: number | null; issueMerged?: boolean; knownClosed?: boolean } = {}) => ({
    id: input.id ?? 'lease-1',
    repo_id: 'repo-1',
    pr: input.pr ?? null,
    issue_merged: input.issueMerged ?? false,
    known_closed: input.knownClosed ?? false,
  });
  const readSql = () => String(vi.mocked(query).mock.calls[0]?.[0]).replace(/\s+/g, ' ');
  const writeSql = () => String(vi.mocked(query).mock.calls[1]?.[0]).replace(/\s+/g, ' ');
  const writeParams = () => vi.mocked(query).mock.calls[1]?.[1];

  it('reads, then closes, writes and audits in one statement', async () => {
    vi.mocked(query).mockResolvedValueOnce([candidate()]).mockResolvedValueOnce([]);

    await settlePausedLeases({ leaseId: 'lease-1', actor: 'bridge', reason: 'its task on openadlc#78 failed', holdUntil: HOLD });

    expect(query).toHaveBeenCalledTimes(2);
    expect(vi.mocked(query).mock.calls[0]?.[1]).toEqual(['lease-1']);
    expect(writeSql()).toMatch(/update leases l set/);
    expect(writeSql()).toMatch(/insert into audit/);
    expect(writeParams()).toEqual(['lease-1', HOLD, 'bridge', 'its task on openadlc#78 failed', [], []]);
  });

  it('writes nothing when no paused lease has ended', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);

    await expect(settlePausedLeases({ actor: 'reconciler', reason: 'sweep', holdUntil: HOLD })).resolves.toEqual({ released: [], held: [] });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('takes only a paused lease with no unfinished task, in the read and again in the write, the sweep taking every one', async () => {
    vi.mocked(query).mockResolvedValueOnce([candidate()]).mockResolvedValueOnce([]);

    await settlePausedLeases({ actor: 'reconciler', reason: 'sweep', holdUntil: HOLD });

    for (const text of [readSql(), writeSql()]) {
      expect(text).toContain("l.state = 'paused'");
      // A task paused on a person's answer is one of these, and holds the issue.
      expect(text).toContain("t.state in ('queued', 'running', 'paused')");
    }
    // No id is every lease: the reconciler's sweep.
    expect(vi.mocked(query).mock.calls[0]?.[1]).toEqual([null]);
    expect(writeParams()?.[0]).toBeNull();
  });

  it('counts a pull request the issue has as well as the lease’s own, and keeps the lease in task with it', async () => {
    // The lease's link is best-effort: a webhook that failed, or the
    // scheduler's recovery, writes only the issue. Released, a patch round
    // and QA would find no lease.
    vi.mocked(query).mockResolvedValueOnce([candidate({ pr: 77 })]).mockResolvedValueOnce([{ ...ROW, state: 'in_task', pr_number: 77 }]);
    const pullOpen = vi.fn(async () => true);

    const settled = await settlePausedLeases({ actor: 'reconciler', reason: 'sweep', holdUntil: HOLD, pullOpen });

    const pr = "coalesce(l.pr_number, (select i.pr_number from issues i where i.repo_id = l.repo_id and i.number = l.issue_number and i.stage = 'review')) as pr";
    expect(readSql()).toContain(pr);
    expect(writeSql()).toContain(pr);
    expect(writeSql()).toContain("state = case when ended.pr is not null or ended.last_state = 'done' then 'in_task' else 'released' end");
    expect(writeSql()).toContain('pr_number = case when ended.closed_pr is null then ended.pr');
    expect(pullOpen).toHaveBeenCalledWith('repo-1', 77);
    expect(writeParams()?.slice(4)).toEqual([[], []]);
    expect(settled.held).toEqual([expect.objectContaining({ state: 'in_task', prNumber: 77 })]);
  });

  it('knows a pull request closed from its link or the merge line, but not one merged while its issue is in Merged', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);

    await settlePausedLeases({ actor: 'reconciler', reason: 'sweep', holdUntil: HOLD });

    expect(readSql()).toContain("exists (select 1 from merge_lines m where m.repo_id = ended.repo_id and m.pr_number = ended.pr and m.state = 'merged')");
    expect(readSql()).toContain(
      "exists (select 1 from work_item_links w where w.kind = 'pull' and w.repo_id = ended.repo_id and w.number = ended.pr and w.state in ('closed', 'merged'))",
    );
    expect(readSql()).toContain('ended.pr is not null and not ended.issue_merged and');
  });

  describe('when the pull request the issue names is closed (OpenADLC#329)', () => {
    it('releases a lease whose last task failed, and does not link it to the closed pull request', async () => {
      vi.mocked(query).mockResolvedValueOnce([candidate({ pr: 334 })]).mockResolvedValueOnce([{ ...ROW, state: 'released', pr_number: null }]);
      const pullOpen = vi.fn(async () => false);

      const settled = await settlePausedLeases({ actor: 'bridge', reason: 'its task failed', holdUntil: HOLD, pullOpen });

      // Set aside, by lease and pull request, so a write that finds another
      // pull request on the issue by then judges that one afresh.
      expect(writeParams()?.slice(4)).toEqual([['lease-1'], [334]]);
      expect(writeSql()).toContain('unnest($5::uuid[], $6::int[]) as c(lease_id, pr)');
      expect(writeSql()).toContain('left join closed_pulls c on c.lease_id = found.id and c.pr = found.pr');
      expect(writeSql()).toContain('case when c.lease_id is null then found.pr end as pr');
      // Released keeps the lease's own link, never the issue's.
      expect(writeSql()).toContain("when ended.last_state = 'done' then null else l.pr_number end");
      // The audit says which one was set aside.
      expect(writeSql()).toContain("jsonb_build_object('closedPull', settled.closed_pull)");
      expect(settled.released).toEqual([expect.objectContaining({ id: 'lease-1', state: 'released', prNumber: null })]);
    });

    it('holds a lease whose last task finished until the expiry, linked to nothing', async () => {
      vi.mocked(query).mockResolvedValueOnce([candidate({ pr: 334 })]).mockResolvedValueOnce([{ ...ROW, state: 'in_task', pr_number: null, expires_at: HOLD }]);

      const settled = await settlePausedLeases({ actor: 'bridge', reason: 'its task finished', holdUntil: HOLD, pullOpen: async () => false });

      expect(writeSql()).toContain("expires_at = case when ended.pr is null and ended.last_state = 'done' then $2::timestamptz");
      expect(writeParams()?.slice(4)).toEqual([['lease-1'], [334]]);
      expect(settled.held).toEqual([expect.objectContaining({ state: 'in_task', prNumber: null, expiresAt: HOLD.toISOString() })]);
    });

    it('takes a closed link or merge line as closed without asking GitHub', async () => {
      vi.mocked(query).mockResolvedValueOnce([candidate({ pr: 334, knownClosed: true })]).mockResolvedValueOnce([]);
      const pullOpen = vi.fn(async () => true);

      await settlePausedLeases({ actor: 'reconciler', reason: 'sweep', holdUntil: HOLD, pullOpen });

      expect(pullOpen).not.toHaveBeenCalled();
      expect(writeParams()?.slice(4)).toEqual([['lease-1'], [334]]);
    });

    it('releases a lease linked itself to a pull request closed unmerged', async () => {
      // The read's pr is the lease's own first; the rule is the same.
      vi.mocked(query).mockResolvedValueOnce([candidate({ pr: 12 })]).mockResolvedValueOnce([{ ...ROW, state: 'released', pr_number: 12 }]);

      const settled = await settlePausedLeases({ actor: 'bridge', reason: 'its task failed', holdUntil: HOLD, pullOpen: async () => false });

      expect(writeParams()?.slice(4)).toEqual([['lease-1'], [12]]);
      expect(settled.released).toHaveLength(1);
    });
  });

  it('adopts the pull request as before when its state is unknown: no reader, or GitHub could not tell', async () => {
    // Released while its pull request is in fact open, a patch round would
    // find no lease; the reconciler sweeps a closed one up (ADR 0073).
    for (const pullOpen of [undefined, async () => null, async () => Promise.reject(new Error('rate limited'))]) {
      vi.mocked(query).mockReset();
      vi.mocked(query).mockResolvedValueOnce([candidate({ pr: 334 })]).mockResolvedValueOnce([{ ...ROW, state: 'in_task', pr_number: 334 }]);

      const settled = await settlePausedLeases({ actor: 'reconciler', reason: 'sweep', holdUntil: HOLD, pullOpen });

      expect(writeParams()?.slice(4)).toEqual([[], []]);
      expect(settled.held).toEqual([expect.objectContaining({ state: 'in_task', prNumber: 334 })]);
    }
  });

  it('keeps the verification hold: a merged pull request whose issue is in Merged is never asked about or set aside', async () => {
    vi.mocked(query).mockResolvedValueOnce([candidate({ pr: 57, issueMerged: true })]).mockResolvedValueOnce([{ ...ROW, state: 'in_task', pr_number: 57 }]);
    const pullOpen = vi.fn(async () => false);

    const settled = await settlePausedLeases({ actor: 'reconciler', reason: 'sweep', holdUntil: HOLD, pullOpen });

    expect(pullOpen).not.toHaveBeenCalled();
    expect(writeParams()?.slice(4)).toEqual([[], []]);
    expect(settled.held).toEqual([expect.objectContaining({ state: 'in_task', prNumber: 57 })]);
  });

  it('asks GitHub once for a pull request two leases name', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce([candidate({ id: 'lease-1', pr: 40 }), candidate({ id: 'lease-2', pr: 40 })])
      .mockResolvedValueOnce([]);
    const pullOpen = vi.fn(async () => false);

    await settlePausedLeases({ actor: 'reconciler', reason: 'sweep', holdUntil: HOLD, pullOpen });

    expect(pullOpen).toHaveBeenCalledTimes(1);
    expect(writeParams()?.slice(4)).toEqual([['lease-1', 'lease-2'], [40, 40]]);
  });

  it('closes a question still open on a task that has already ended, and says why', async () => {
    // Answering it would resume nothing, and it held the lease for ever.
    vi.mocked(query).mockResolvedValueOnce([candidate()]).mockResolvedValueOnce([]);

    await settlePausedLeases({ actor: 'reconciler', reason: 'sweep', holdUntil: HOLD });

    expect(writeSql()).toContain("update gates g set state = 'expired'");
    expect(writeSql()).toContain("g.task_id = t.id and t.lease_id = ended.id and g.state = 'open'");
    expect(writeSql()).toContain("'gate.expired'");
  });

  it('releases one whose last task failed or stopped, and puts one whose task finished back in task until the expiry', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce([candidate({ id: 'lease-78' }), candidate({ id: 'lease-79' })])
      .mockResolvedValueOnce([
        { ...ROW, id: 'lease-78', state: 'released' },
        { ...ROW, id: 'lease-79', issue_number: 79, state: 'in_task', expires_at: HOLD },
      ]);

    const settled = await settlePausedLeases({ actor: 'reconciler', reason: 'sweep', holdUntil: HOLD });

    expect(writeSql()).toContain("expires_at = case when ended.pr is null and ended.last_state = 'done' then $2::timestamptz");
    expect(settled.released.map((lease) => lease.id)).toEqual(['lease-78']);
    expect(settled.held).toEqual([expect.objectContaining({ id: 'lease-79', state: 'in_task', expiresAt: HOLD.toISOString() })]);
  });
});

describe('a lease left on a closed pull request', () => {
  it('is released and audited in one statement, only while still linked to it and with nothing working under it', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ ...ROW, state: 'released', pr_number: 334 }]);

    const released = await releaseForClosedPull({ leaseId: 'lease-1', prNumber: 334, actor: 'reconciler', reason: '#334 is closed' });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    const text = String(sql).replace(/\s+/g, ' ');
    expect(text).toContain('where l.id = $1 and l.pr_number = $2 and l.state = any($3)');
    expect(text).toContain("not exists (select 1 from tasks t where t.lease_id = l.id and t.state in ('queued', 'running', 'paused'))");
    expect(text).toContain("select $4::text, 'lease.released'");
    expect(text).toContain("jsonb_build_object('leaseId', released.id, 'reason', $5::text, 'pullRequest', $2::int)");
    expect(params).toEqual(['lease-1', 334, ['leased', 'in_task', 'paused'], 'reconciler', '#334 is closed']);
    expect(released).toEqual(expect.objectContaining({ id: 'lease-1', state: 'released', prNumber: 334 }));
  });

  it('is nothing when the statement let nothing go: another link, a task under it, or no longer held', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);

    await expect(releaseForClosedPull({ leaseId: 'lease-1', prNumber: 334, actor: 'reconciler', reason: 'r' })).resolves.toBeNull();
  });
});

describe('the lease a pull request held', () => {
  it('is released and audited in one statement, with why', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ ...ROW, state: 'released', pr_number: 12 }]);

    const released = await releaseForPullRequest('repo-1', 12, 'the pull request closed unmerged');

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    const text = String(sql).replace(/\s+/g, ' ');
    expect(text).toContain("update leases set state = 'released'");
    expect(text).toContain("select 'bridge', 'lease.released'");
    expect(text).toContain("jsonb_build_object('leaseId', released.id, 'reason', $4::text, 'pullRequest', $2::int)");
    expect(params).toEqual(['repo-1', 12, ['leased', 'in_task', 'paused'], 'the pull request closed unmerged']);
    expect(released).toEqual(expect.objectContaining({ id: 'lease-1', state: 'released', prNumber: 12 }));
  });
});

describe('taking a pull request’s lease again', () => {
  // Closed unmerged released it; reopened, nothing took it back, and the next
  // request for changes found no lease and opened no patch round.
  it('copies the builder and the paths of the last lease released for that pull request, linked to it, and audits it', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ ...ROW, id: 'lease-2', state: 'in_task', pr_number: 12 });

    const lease = await reacquireForPullRequest({ repoId: 'repo-1', issueNumber: 78, prNumber: 12, actor: 'bridge', reason: '#12 was reopened' });

    expect(queryOne).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
    const [sql, params] = vi.mocked(queryOne).mock.calls[0] ?? [];
    const text = String(sql).replace(/\s+/g, ' ');
    expect(text).toContain('select bot_id, declared_paths, state from leases where repo_id = $1 and issue_number = $2 and pr_number = $3 order by created_at desc limit 1');
    expect(text).toContain("select $1, $2, last.bot_id, last.declared_paths, 'in_task', null, $3 from last where last.state = 'released'");
    expect(text).toContain("'lease.reacquired'");
    expect(text).toContain("jsonb_build_object('leaseId', taken.id, 'reason', $6::text, 'pullRequest', taken.pr_number)");
    expect(params).toEqual(['repo-1', 78, 12, ['leased', 'in_task', 'paused'], 'bridge', '#12 was reopened']);
    expect(lease).toEqual(expect.objectContaining({ id: 'lease-2', state: 'in_task', prNumber: 12, botId: 'bot-1', declaredPaths: ROW.declared_paths }));
  });

  it('takes none while a lease on the issue is active, which the one-active index also refuses', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(null);

    expect(await reacquireForPullRequest({ repoId: 'repo-1', issueNumber: 78, prNumber: 12, actor: 'bridge', reason: 'r' })).toBeNull();

    const text = String(vi.mocked(queryOne).mock.calls[0]?.[0]).replace(/\s+/g, ' ');
    expect(text).toContain('and not exists (select 1 from leases l where l.repo_id = $1 and l.issue_number = $2 and l.state = any($4))');
    expect(text).toContain('on conflict do nothing');
  });

  it('reads the last lease a pull request was linked to, whatever its state', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ ...ROW, state: 'released', pr_number: 12 });

    expect(await lastForPullRequest('repo-1', 12)).toEqual(expect.objectContaining({ state: 'released', prNumber: 12 }));
    const [sql, params] = vi.mocked(queryOne).mock.calls[0] ?? [];
    expect(String(sql)).toContain('where repo_id = $1 and pr_number = $2 order by created_at desc limit 1');
    expect(params).toEqual(['repo-1', 12]);
  });
});

describe('the leases of a repository removed from OpenADLC', () => {
  it('are released and audited in one statement, each with why', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ ...ROW, state: 'released' }]);

    const released = await releaseForRepo({ repoId: 'repo-1', actor: 'janedoe', reason: 'repository removed from OpenADLC by janedoe' });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    const text = String(sql).replace(/\s+/g, ' ');
    expect(text).toContain("update leases l set state = 'released'");
    expect(text).toContain("'lease.released'");
    expect(params).toEqual(['repo-1', ['leased', 'in_task', 'paused'], 'janedoe', 'repository removed from OpenADLC by janedoe']);
    expect(released).toEqual([expect.objectContaining({ id: 'lease-1', state: 'released', issueNumber: 78 })]);
  });

  it('leaves one an unfinished task still works under: that task could not be stopped', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);

    await releaseForRepo({ repoId: 'repo-1', actor: 'janedoe', reason: 'r' });

    const text = String(vi.mocked(query).mock.calls[0]?.[0]).replace(/\s+/g, ' ');
    expect(text).toContain("not exists (select 1 from tasks t where t.lease_id = l.id and t.state in ('queued', 'running', 'paused'))");
  });
});

describe('the lease of an issue that reached Done', () => {
  // OpenADLC#71's card was moved to Done by its label, and reconcile put it
  // there on the board; nothing let go of its lease, which held two files a
  // stacked issue's plan change waited on until the lease ran out.
  it('is let go, whatever pull request it names, and audited with why, in the statement that checks no task works under it', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ ...ROW, state: 'released', pr_number: 72 }]);

    const released = await releaseIdleForIssue({ repoId: 'repo-1', issueNumber: 71, actor: 'reconciler', reason: 'moved to Done on GitHub' });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    const text = String(sql).replace(/\s+/g, ' ');
    expect(text).toContain("update leases l set state = 'released'");
    expect(text).toContain('where l.repo_id = $1 and l.issue_number = $2 and l.state = any($3)');
    expect(text).toContain("not exists (select 1 from tasks t where t.lease_id = l.id and t.state in ('queued', 'running', 'paused'))");
    expect(text).not.toContain('pr_number is null');
    expect(text).toContain("'lease.released'");
    expect(params).toEqual(['repo-1', 71, ['leased', 'in_task', 'paused'], 'reconciler', 'moved to Done on GitHub']);
    expect(released).toEqual(expect.objectContaining({ id: 'lease-1', state: 'released', prNumber: 72 }));
  });

  it('is kept while a task still works under it, and none held is nothing', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);

    expect(await releaseIdleForIssue({ repoId: 'repo-1', issueNumber: 71, actor: 'bridge', reason: 'r' })).toBeNull();
  });
});

describe('letting an idle lease go', () => {
  it('checks it is still idle in the statement that releases it, and says whether it did', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ id: 'lease-1' });
    expect(await releaseIfIdle('lease-1')).toBe(true);
    const [sql, params] = vi.mocked(queryOne).mock.calls[0] ?? [];
    expect(String(sql)).toMatch(/state in \('leased','in_task'\) and pr_number is null/);
    expect(String(sql)).toMatch(/not exists \(select 1 from tasks t where t\.lease_id = \$1 and t\.state in \('queued','running','paused'\)\)/);
    expect(params).toEqual(['lease-1']);

    vi.mocked(queryOne).mockResolvedValueOnce(null);
    expect(await releaseIfIdle('lease-1')).toBe(false);
  });
});

describe('the lease a person’s Stop lets go', () => {
  it('is released whatever holds it, paused or with a pull request, only while no task works under it', async () => {
    // Stop lets it go once hostd has ended the session; a Try again in
    // between reuses the lease, and a release by id let it go under that.
    vi.mocked(queryOne).mockResolvedValueOnce({ id: 'lease-1' });
    expect(await releaseUnlessWorkedUnder('lease-1')).toBe(true);
    const [sql, params] = vi.mocked(queryOne).mock.calls[0] ?? [];
    const text = String(sql).replace(/\s+/g, ' ');
    expect(text).toContain("where id = $1 and state in ('leased','in_task','paused') and not exists");
    expect(text).not.toContain('pr_number');
    expect(text).toContain("not exists (select 1 from tasks t where t.lease_id = $1 and t.state in ('queued','running','paused'))");
    expect(params).toEqual(['lease-1']);

    vi.mocked(queryOne).mockResolvedValueOnce(null);
    expect(await releaseUnlessWorkedUnder('lease-1')).toBe(false);
  });
});

describe('an issue’s attempts without a pull request', () => {
  it('count only leases a build started under, so a lease the bridge refused costs the issue nothing', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ count: '1' }]);
    expect(await attemptsWithoutPullRequest('repo-1', 78)).toBe(1);

    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    const text = String(sql).replace(/\s+/g, ' ');
    expect(text).toContain("l.pr_number is null and l.state in ('released', 'expired')");
    expect(text).toContain('exists (select 1 from tasks t where t.lease_id = l.id and t.kind = \'implement\' and t.started_at is not null');
    expect(params).toEqual(['repo-1', 78]);
  });

  it('leave out a build that was stopped, by a person or by its host going away', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ count: '0' }]);
    await attemptsWithoutPullRequest('repo-1', 78);
    const text = String(vi.mocked(query).mock.calls[0]?.[0]).replace(/\s+/g, ' ');
    expect(text).toContain("t.started_at is not null and t.state <> 'stopped')");
  });

  it('count only leases taken since the issue was last sent to triage, so putting start:now back gives it fresh ones', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ count: '0' }]);
    expect(await attemptsWithoutPullRequest('repo-1', 78)).toBe(0);

    const text = String(vi.mocked(query).mock.calls[0]?.[0]).replace(/\s+/g, ' ');
    // The triage route's audit row names the issue `<repo name>#<number>`.
    expect(text).toContain("a.action = 'issue.triaged' and a.target = r.name || '#' || $2::int");
    expect(text).toMatch(/l\.created_at > coalesce\( \(select max\(a\.at\) from audit a, repos r where r\.id = \$1 /);
    expect(text).toContain("'-infinity')");
  });
});

describe('what was decided about a plan change, beside its request (#77)', () => {
  it('reads who was asked to judge it, who decided it and whether it was taken back', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({
      payload: {
        planChange: { paths: ['a.ts'], reason: 'r' },
        designer: { taskId: 'task-9', askedBy: 'janedoe', at: '2026-10-22T10:00:00.000Z', verdict: 'approve', reason: 'named', counted: false, outside: [{ path: 'a.ts', why: 'w' }] },
        decided: { by: 'designer', seat: 'architect', at: '2026-10-22T10:05:00.000Z' },
        takenBack: { by: 'janedoe', at: '2026-10-22T11:00:00.000Z' },
        standing: { setBy: 'janedoe', humanReview: ['config/x.yaml', 3] },
      },
    });

    await expect(planChangeOfGate('gate-1')).resolves.toEqual({
      paths: ['a.ts'],
      reason: 'r',
      held: null,
      designer: { taskId: 'task-9', askedBy: 'janedoe', at: '2026-10-22T10:00:00.000Z', verdict: 'approve', reason: 'named', counted: false, outside: [{ path: 'a.ts', why: 'w' }] },
      decided: { by: 'designer', seat: 'architect', at: '2026-10-22T10:05:00.000Z' },
      takenBack: { by: 'janedoe', at: '2026-10-22T11:00:00.000Z' },
      standing: { setBy: 'janedoe', humanReview: ['config/x.yaml'] },
    });
  });

  it('reads why a standing approval did not cover it when the Human-review rules could not be read', async () => {
    // Not a Human-review path: the card said one was, in a repository whose
    // AGENTS.md had no `## Human review` section (#100).
    const why = 'OpenADLC could not read the Human-review rules in AGENTS.md on `main`, so it does not cover this one';
    vi.mocked(queryOne).mockResolvedValueOnce({ payload: { planChange: { paths: ['a.ts'], reason: 'r' }, standing: { setBy: 'janedoe', humanReview: [], rulesUnread: why } } });
    await expect(planChangeOfGate('gate-1')).resolves.toMatchObject({ standing: { setBy: 'janedoe', humanReview: [], rulesUnread: why } });
    vi.mocked(queryOne).mockResolvedValueOnce({ payload: { planChange: { paths: ['a.ts'], reason: 'r' }, standing: { setBy: 'janedoe', humanReview: [], rulesUnread: 7 } } });
    expect((await planChangeOfGate('gate-1'))?.standing).toEqual({ setBy: 'janedoe', humanReview: [] });
  });

  it('writes a note on the gate’s message, one key at a time, beside what is there', async () => {
    await notePlanChange('gate-1', 'designer', { taskId: 'task-9', askedBy: 'janedoe' });
    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toMatch(/update messages set payload = payload \|\| jsonb_build_object\(\$2::text, \$3::jsonb\)/);
    expect(params).toEqual(['gate-1', 'designer', JSON.stringify({ taskId: 'task-9', askedBy: 'janedoe' })]);
    await expect(notePlanChange('gate-1', 'planChange' as never, {})).rejects.toThrow(/not a note/);
  });

  it('finds the plan change a designer’s task was asked to judge', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ gate_id: 'gate-1', payload: { planChange: { paths: ['a.ts'], reason: 'r' }, designer: { taskId: 'task-9', askedBy: 'x', at: 't' } } });
    await expect(planChangeOfDesignerTask('task-9')).resolves.toMatchObject({ gateId: 'gate-1', request: { paths: ['a.ts'] } });
    const [sql, params] = vi.mocked(queryOne).mock.calls[0] ?? [];
    expect(String(sql)).toMatch(/payload->'designer'->>'taskId' = \$1/);
    expect(params).toEqual(['task-9']);
  });

  it('reads the plan changes of many gates in one read', async () => {
    vi.mocked(query).mockResolvedValueOnce([
      { gate_id: 'gate-1', payload: { planChange: { paths: ['a.ts'], reason: 'r' } } },
      { gate_id: 'gate-2', payload: { options: ['yes'] } },
    ]);
    const read = await planChangesOfGates(['gate-1', 'gate-2']);
    expect([...read.keys()]).toEqual(['gate-1']);
    await expect(planChangesOfGates([])).resolves.toEqual(new Map());
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('takes paths back out of a lease and its issue, whatever state the lease is in', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ ...ROW, state: 'released', declared_paths: ['apps/bridge/src/gates.ts'] });
    const lease = await narrowPaths('lease-1', ['apps/hostd/src/skill-runner.ts']);
    const [sql, params] = vi.mocked(queryOne).mock.calls[0] ?? [];
    expect(String(sql)).toMatch(/update leases set/);
    expect(String(sql)).toMatch(/update issues set/);
    expect(String(sql)).not.toMatch(/state = any/);
    expect(params).toEqual(['lease-1', ['apps/hostd/src/skill-runner.ts']]);
    expect(lease?.declaredPaths).toEqual(['apps/bridge/src/gates.ts']);
  });
});
