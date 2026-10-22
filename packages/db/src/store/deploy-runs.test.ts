import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({ query: vi.fn(), queryOne: vi.fn() }));

import { query, queryOne } from '../client.js';
import {
  claim,
  claimPromote,
  dispatchedRollbacks,
  duePromotes,
  ensure,
  heldForPerson,
  holdForPerson,
  laterTestingDeploy,
  holdPromote,
  newestTestingEnd,
  oweRollback,
  recordRollback,
  recordSmoke,
  recordTesting,
  releaseHeld,
  rollbackDidNotRun,
  rollbackOutstanding,
  supersededBefore,
  unfinishedRollbacks,
  undispatchedPromotes,
  undispatchedRollbacks,
  undispatchedSince,
  unsettledTesting,
} from './deploy-runs.js';

const row = {
  id: 'd1',
  repo_id: 'repo-1',
  sha: 'a'.repeat(40),
  pr_number: 40,
  testing_dispatched_at: null,
  smoke_conclusion: null,
  smoke_at: null,
  promote_after: new Date('2026-09-30T12:30:00Z'),
  promote_dispatched_at: null,
  production_conclusion: null,
  production_at: null,
  rollback_dispatched_at: null,
  rollback_due_at: null,
  rollback_conclusion: null,
  rollback_at: null,
  rollback_trouble: null,
  sent_back_at: null,
  detail: null,
  created_at: new Date('2026-09-30T12:00:00Z'),
};

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(queryOne).mockReset();
});

describe('deploy runs', () => {
  it('makes a commit’s row once, keeping the pull request it first heard', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(row);
    expect(await ensure('repo-1', row.sha, 40)).toMatchObject({ sha: row.sha, prNumber: 40, promoteAfter: '2026-09-30T12:30:00.000Z' });
    const sql = String(vi.mocked(queryOne).mock.calls[0]![0]);
    expect(sql).toContain('on conflict (repo_id, sha)');
    expect(sql).toContain('coalesce(deploy_runs.pr_number, excluded.pr_number)');
  });

  it('takes a step once: the second claim of it is refused', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ id: 'd1' }).mockResolvedValueOnce(null);
    expect(await claim('repo-1', row.sha, 'promote_dispatched_at', 'dispatching')).toBe(true);
    expect(await claim('repo-1', row.sha, 'promote_dispatched_at', 'dispatching')).toBe(false);
    expect(String(vi.mocked(queryOne).mock.calls[0]![0])).toContain('and promote_dispatched_at is null');
  });

  it('finds the promotes whose soak is over and that nothing dispatched', async () => {
    vi.mocked(query).mockResolvedValueOnce([row]);
    const due = await duePromotes(new Date('2026-09-30T13:00:00Z'));
    expect(due.map((run) => run.sha)).toEqual([row.sha]);
    expect(String(vi.mocked(query).mock.calls[0]![0])).toMatch(/promote_after <= \$1 and promote_dispatched_at is null/);
  });

  it('finds a promote whose dispatch failed for the sweep, only the repository’s newest commit', async () => {
    const green = { ...row, promote_after: null, smoke_conclusion: 'success', smoke_at: new Date('2026-09-30T12:10:00Z') };
    vi.mocked(query).mockResolvedValueOnce([green]);
    expect((await undispatchedPromotes(new Date('2026-09-23T12:00:00Z'))).map((run) => run.sha)).toEqual([row.sha]);
    const sql = String(vi.mocked(query).mock.calls[0]![0]).replace(/\s+/g, ' ');
    expect(sql).toContain('r.promote_dispatched_at is null and r.promote_after is null');
    // Never a commit whose smoke went red, or that was sent back or rolled back.
    expect(sql).toContain("smoke_conclusion = 'success' and sent_back_at is null and rollback_dispatched_at is null");
    // A newer merge in the same repository supersedes it: promoting this one after it would move production backwards.
    expect(sql).toContain('not exists (select 1 from deploy_runs n where n.repo_id = r.repo_id and n.created_at > r.created_at)');
  });

  it('finds an owed rollback nothing dispatched, unless a newer commit has been promoted since', async () => {
    const owed = { ...row, rollback_due_at: new Date('2026-09-30T13:00:00Z') };
    vi.mocked(query).mockResolvedValueOnce([owed]);
    expect(await undispatchedRollbacks()).toEqual([expect.objectContaining({ rollbackDueAt: '2026-09-30T13:00:00.000Z' })]);
    const sql = String(vi.mocked(query).mock.calls[0]![0]).replace(/\s+/g, ' ');
    expect(sql).toContain('r.rollback_due_at is not null and r.rollback_dispatched_at is null');
    expect(sql).toContain('n.created_at > r.created_at and n.promote_dispatched_at is not null');
  });

  it('marks a rollback owed once, keeping when it first was', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    await oweRollback('repo-1', row.sha);
    expect(String(vi.mocked(query).mock.calls[0]![0])).toContain('rollback_due_at = coalesce(rollback_due_at, now())');
  });

  it('says which promotes and rollbacks are still undispatched past when they were due', async () => {
    const promote = { ...row, sha: 'b'.repeat(40), promote_after: null, smoke_conclusion: 'success', detail: 'promote-production not dispatched: 502' };
    const early = { ...row, rollback_due_at: new Date('2026-09-30T12:00:00Z') };
    const recent = { ...row, sha: 'c'.repeat(40), rollback_due_at: new Date('2026-09-30T12:50:00Z') };
    vi.mocked(query).mockResolvedValueOnce([promote]).mockResolvedValueOnce([early, recent]);
    const stuck = await undispatchedSince(new Date('2026-09-30T12:45:00Z'), new Date('2026-09-23T12:00:00Z'));
    expect(stuck.map((one) => [one.step, one.run.sha])).toEqual([
      ['promote', promote.sha],
      ['rollback', row.sha],
    ]);
    expect(String(vi.mocked(query).mock.calls[0]![0])).toContain("r.detail like '% not dispatched%'");
  });

  it('claims a promote only for a commit whose smoke passed and that nothing sent back or rolled back', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ id: 'd1' });
    expect(await claimPromote('repo-1', row.sha, 'dispatching promote-production')).toBe(true);
    const sql = String(vi.mocked(queryOne).mock.calls[0]![0]).replace(/\s+/g, ' ');
    expect(sql).toContain(
      "and promote_dispatched_at is null and smoke_conclusion = 'success' and sent_back_at is null and rollback_dispatched_at is null",
    );
  });

  it('finds no due promote for a commit whose smoke went red or that was sent back', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    await duePromotes(new Date('2026-09-30T13:00:00Z'));
    const sql = String(vi.mocked(query).mock.calls[0]![0]).replace(/\s+/g, ' ');
    expect(sql).toContain("smoke_conclusion = 'success' and sent_back_at is null and rollback_dispatched_at is null");
  });

  it('drops a held soak when the smoke goes red, and keeps a red smoke red through a green re-run', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    await recordSmoke('repo-1', row.sha, 'failure');
    const [sql, params] = vi.mocked(query).mock.calls[0]!;
    const flat = String(sql).replace(/\s+/g, ' ');
    expect(flat).toContain("promote_after = case when $3 = 'failure' then null else promote_after end");
    expect(flat).toContain("smoke_conclusion = case when smoke_conclusion = 'failure' then 'failure' else $3 end");
    expect(params).toEqual(['repo-1', row.sha, 'failure']);
    // A person's hold goes too: the commit is being reverted, not promoted.
    expect(flat).toContain("promote_held_at = case when $3 = 'failure' then null else promote_held_at end");
  });

  it('holds a promote for a person only while it is not dispatched, in place of a soak', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    await holdForPerson('repo-1', row.sha, 'waits in Needs you');
    const sql = String(vi.mocked(query).mock.calls[0]![0]);
    expect(sql).toContain('promote_held_at = coalesce(promote_held_at, now())');
    expect(sql).toContain('promote_after = null');
    expect(sql).toContain('and promote_dispatched_at is null');
  });

  it('lists the held promotes nothing has dispatched, in a repository or all', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ ...row, promote_after: null, promote_held_at: new Date('2026-09-30T12:40:00Z') }]).mockResolvedValueOnce([]);
    expect(await heldForPerson()).toEqual([expect.objectContaining({ sha: row.sha, promoteHeldAt: '2026-09-30T12:40:00.000Z', promoteReleasedBy: null })]);
    await heldForPerson('repo-1');
    expect(String(vi.mocked(query).mock.calls[0]![0])).toMatch(/promote_held_at is not null and promote_dispatched_at is null and smoke_conclusion = 'success'/);
    expect(vi.mocked(query).mock.calls[1]![1]).toEqual(['repo-1']);
  });

  it('releases a held promote once: a second release, or one of a promote not held, is refused', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ id: 'd1' }).mockResolvedValueOnce(null);
    expect(await releaseHeld('repo-1', row.sha, 'released by janedoe')).toBe(true);
    expect(await releaseHeld('repo-1', row.sha, 'released by janedoe')).toBe(false);
    expect(String(vi.mocked(queryOne).mock.calls[0]![0])).toContain('and promote_held_at is not null and promote_dispatched_at is null');
  });

  it('turns a person’s hold into a soak when the soak is set', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    await holdPromote('repo-1', row.sha, new Date('2026-09-30T13:30:00Z'), 'soaking');
    expect(String(vi.mocked(query).mock.calls[0]![0])).toContain('promote_held_at = null');
  });

  it('records how a rollback ended, and when, and a success clears the trouble before it', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    await recordRollback('repo-1', row.sha, 'success');
    const sql = String(vi.mocked(query).mock.calls[0]![0]).replace(/\s+/g, ' ');
    expect(sql).toContain('set rollback_conclusion = $3, rollback_at = now()');
    expect(sql).toContain("rollback_trouble = case when $3 = 'success' then null else rollback_trouble end");
    expect(vi.mocked(query).mock.calls[0]![1]).toEqual(['repo-1', row.sha, 'success']);
  });

  it('gives back a rollback that did not run, keeping why', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    await rollbackDidNotRun('repo-1', row.sha, 'its run was cancelled');
    const sql = String(vi.mocked(query).mock.calls[0]![0]).replace(/\s+/g, ' ');
    expect(sql).toContain('set rollback_dispatched_at = null, rollback_trouble = $3');
    expect(sql).toContain('and rollback_conclusion is null');
  });

  it('lists the rollbacks that did not finish well, unless a newer commit was promoted since', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ ...row, rollback_due_at: new Date('2026-09-30T12:50:00Z'), rollback_trouble: 'its run was cancelled' }]);
    expect(await unfinishedRollbacks(new Date('2026-09-23T12:00:00Z'))).toEqual([expect.objectContaining({ rollbackTrouble: 'its run was cancelled' })]);
    const sql = String(vi.mocked(query).mock.calls[0]![0]).replace(/\s+/g, ' ');
    expect(sql).toContain("r.rollback_conclusion = 'failure' or (r.rollback_conclusion is null and r.rollback_trouble is not null)");
    expect(sql).toContain('n.promote_dispatched_at is not null');
  });

  it('reads back a rollback’s outcome', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ ...row, rollback_conclusion: 'failure', rollback_at: new Date('2026-09-30T13:05:00Z') });
    expect(await rollbackOutstanding('repo-1')).toMatchObject({ rollbackConclusion: 'failure', rollbackAt: '2026-09-30T13:05:00.000Z' });
  });

  it('finds a rollback owed in a repository that has not ended, unless a newer commit was promoted since', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(null);
    expect(await rollbackOutstanding('repo-1')).toBeNull();
    const sql = String(vi.mocked(queryOne).mock.calls[0]![0]).replace(/\s+/g, ' ');
    expect(sql).toContain('r.repo_id = $1 and r.rollback_due_at is not null and r.rollback_conclusion is null');
    expect(sql).toContain('n.created_at > r.created_at and n.promote_dispatched_at is not null');
  });

  it('lists the rollbacks dispatched lately whose run has not been seen to end, unless a newer commit was promoted since', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ ...row, rollback_due_at: new Date('2026-09-30T12:50:00Z'), rollback_dispatched_at: new Date('2026-09-30T12:51:00Z') }]);
    expect(await dispatchedRollbacks(new Date('2026-09-23T12:00:00Z'))).toEqual([
      expect.objectContaining({ sha: row.sha, rollbackDispatchedAt: '2026-09-30T12:51:00.000Z', rollbackConclusion: null }),
    ]);
    const sql = String(vi.mocked(query).mock.calls[0]![0]).replace(/\s+/g, ' ');
    expect(sql).toContain('r.rollback_dispatched_at >= $1 and r.rollback_conclusion is null');
    expect(sql).toContain('n.promote_dispatched_at is not null');
  });

  // A testing deploy whose run skipped left its row dispatched and nothing
  // else, so the deploy sweep said "already started (running)" for good.
  it('records how a dispatched testing deploy ended once, and a run that deployed after one that did not', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ id: 'd1' }).mockResolvedValueOnce(null);
    expect(await recordTesting('repo-1', row.sha, 'skipped', 'deploy-testing run 9 was skipped')).toBe(true);
    expect(await recordTesting('repo-1', row.sha, 'skipped', 'deploy-testing run 9 was skipped')).toBe(false);
    const sql = String(vi.mocked(queryOne).mock.calls[0]![0]).replace(/\s+/g, ' ');
    expect(sql).toContain('set testing_conclusion = $3, testing_at = now(), detail = coalesce($4, detail)');
    expect(sql).toContain('and testing_dispatched_at is not null');
    expect(sql).toContain("and (testing_conclusion is null or testing_conclusion = 'superseded' or ($3 = 'success' and testing_conclusion <> 'success'))");
    expect(vi.mocked(queryOne).mock.calls[0]![1]).toEqual(['repo-1', row.sha, 'skipped', 'deploy-testing run 9 was skipped']);
  });

  // A waiting run cancelled when a newer merge's queues is carried by that
  // deploy: B's lease was let go before C's deploy verified B.
  it('finds a later testing deploy of the repository still to end or deployed, which carries a cancelled one', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ ...row, sha: 'c'.repeat(40), testing_dispatched_at: new Date('2026-09-30T12:05:00Z') });
    expect(await laterTestingDeploy('repo-1', row.sha)).toMatchObject({ sha: 'c'.repeat(40) });
    const sql = String(vi.mocked(queryOne).mock.calls[0]![0]).replace(/\s+/g, ' ');
    expect(sql).toContain('n.testing_dispatched_at > r.testing_dispatched_at');
    expect(sql).toContain("(n.testing_conclusion is null or n.testing_conclusion = 'success')");
    expect(vi.mocked(queryOne).mock.calls[0]![1]).toEqual(['repo-1', row.sha]);
  });

  it('lists the superseded testing deploys dispatched before a commit’s, oldest first', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ ...row, testing_conclusion: 'superseded' }]);
    expect(await supersededBefore('repo-1', 'c'.repeat(40))).toEqual([expect.objectContaining({ testingConclusion: 'superseded' })]);
    const sql = String(vi.mocked(query).mock.calls[0]![0]).replace(/\s+/g, ' ');
    expect(sql).toContain("r.testing_conclusion = 'superseded' and r.testing_dispatched_at < n.testing_dispatched_at");
    expect(sql).toContain('order by r.testing_dispatched_at');
  });

  it('lists the testing deploys dispatched lately that nothing has seen end, nor smoked', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ ...row, testing_dispatched_at: new Date('2026-09-30T12:01:00Z'), testing_conclusion: null }]);
    expect(await unsettledTesting(new Date('2026-09-23T12:00:00Z'))).toEqual([
      expect.objectContaining({ sha: row.sha, testingDispatchedAt: '2026-09-30T12:01:00.000Z', testingConclusion: null }),
    ]);
    const sql = String(vi.mocked(query).mock.calls[0]![0]).replace(/\s+/g, ' ');
    expect(sql).toContain('testing_dispatched_at >= $1 and testing_conclusion is null and smoke_conclusion is null');
  });

  // Settings said a repository's merges wait on testing while its
  // deploy-testing skipped every one: the newest that ended is what it reads.
  it('reads the repository’s newest testing deploy whose end is recorded, leaving out one a later deploy superseded', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ ...row, testing_dispatched_at: new Date('2026-10-22T16:57:00Z'), testing_conclusion: 'skipped', detail: 'deploy-testing run 9 was skipped' });
    expect(await newestTestingEnd('repo-1')).toMatchObject({ testingConclusion: 'skipped', detail: 'deploy-testing run 9 was skipped' });
    const sql = String(vi.mocked(queryOne).mock.calls[0]![0]).replace(/\s+/g, ' ');
    expect(sql).toContain("repo_id = $1 and testing_dispatched_at is not null and testing_conclusion is not null and testing_conclusion <> 'superseded'");
    expect(sql).toContain('order by testing_dispatched_at desc limit 1');
    expect(vi.mocked(queryOne).mock.calls[0]![1]).toEqual(['repo-1']);

    vi.mocked(queryOne).mockResolvedValueOnce(null);
    expect(await newestTestingEnd('repo-1')).toBeNull();
  });
});
