import { query, queryOne } from '../client.js';

/**
 * What the deploy pipeline did with one merged commit; see
 * `migrations/0034_deploy_runs.sql`. Each step is written once, so a
 * redelivered event or a sweep that asks again does nothing twice.
 */
export interface DeployRun {
  id: string;
  repoId: string;
  sha: string;
  prNumber: number | null;
  testingDispatchedAt: string | null;
  smokeConclusion: string | null;
  smokeAt: string | null;
  promoteAfter: string | null;
  /** When the promote was held for a person (`holdForPerson`); null when it is not. */
  promoteHeldAt: string | null;
  /** Who released a held promote, once its dispatch went through. */
  promoteReleasedBy: string | null;
  promoteDispatchedAt: string | null;
  productionConclusion: string | null;
  productionAt: string | null;
  rollbackDispatchedAt: string | null;
  /** When a rollback became owed (a traffic shift failed), whether or not it was dispatched. */
  rollbackDueAt: string | null;
  /** How the dispatched rollback's run ended, `success` or `failure`; null until the deploy sweep has seen it end. */
  rollbackConclusion: string | null;
  rollbackAt: string | null;
  /** Why the last rollback dispatched did not run (cancelled, or never started); cleared when one succeeds. */
  rollbackTrouble: string | null;
  sentBackAt: string | null;
  detail: string | null;
  createdAt: string;
}

interface Row {
  id: string;
  repo_id: string;
  sha: string;
  pr_number: number | null;
  testing_dispatched_at: Date | null;
  smoke_conclusion: string | null;
  smoke_at: Date | null;
  promote_after: Date | null;
  promote_held_at?: Date | null;
  promote_released_by?: string | null;
  promote_dispatched_at: Date | null;
  production_conclusion: string | null;
  production_at: Date | null;
  rollback_dispatched_at: Date | null;
  rollback_due_at: Date | null;
  rollback_conclusion: string | null;
  rollback_at: Date | null;
  rollback_trouble: string | null;
  sent_back_at: Date | null;
  detail: string | null;
  created_at: Date;
}

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

function toRun(row: Row): DeployRun {
  return {
    id: row.id,
    repoId: row.repo_id,
    sha: row.sha,
    prNumber: row.pr_number,
    testingDispatchedAt: iso(row.testing_dispatched_at),
    smokeConclusion: row.smoke_conclusion,
    smokeAt: iso(row.smoke_at),
    promoteAfter: iso(row.promote_after),
    promoteHeldAt: iso(row.promote_held_at ?? null),
    promoteReleasedBy: row.promote_released_by ?? null,
    promoteDispatchedAt: iso(row.promote_dispatched_at),
    productionConclusion: row.production_conclusion,
    productionAt: iso(row.production_at),
    rollbackDispatchedAt: iso(row.rollback_dispatched_at),
    rollbackDueAt: iso(row.rollback_due_at),
    rollbackConclusion: row.rollback_conclusion,
    rollbackAt: iso(row.rollback_at),
    rollbackTrouble: row.rollback_trouble,
    sentBackAt: iso(row.sent_back_at),
    detail: row.detail,
    createdAt: row.created_at.toISOString(),
  };
}

export async function get(repoId: string, sha: string): Promise<DeployRun | null> {
  const row = await queryOne<Row>('select * from deploy_runs where repo_id = $1 and sha = $2', [repoId, sha]);
  return row ? toRun(row) : null;
}

/** The commit's row, made when there is none. */
export async function ensure(repoId: string, sha: string, prNumber: number | null): Promise<DeployRun> {
  const row = await queryOne<Row>(
    `insert into deploy_runs (repo_id, sha, pr_number) values ($1, $2, $3)
     on conflict (repo_id, sha) do update set pr_number = coalesce(deploy_runs.pr_number, excluded.pr_number)
     returning *`,
    [repoId, sha, prNumber],
  );
  if (!row) throw new Error(`could not record the deploy of ${sha}`);
  return toRun(row);
}

/** The steps that may be taken once: true when this call took it, false when it was already taken. */
export type Step = 'testing_dispatched_at' | 'promote_dispatched_at' | 'rollback_dispatched_at' | 'sent_back_at';

export async function claim(repoId: string, sha: string, step: Step, detail: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `update deploy_runs set ${step} = now(), detail = $3, updated_at = now()
     where repo_id = $1 and sha = $2 and ${step} is null returning id`,
    [repoId, sha, detail],
  );
  return row !== null;
}

/**
 * What a promote may be dispatched for: a commit whose smoke on testing
 * passed, and that nothing has sent back or rolled back. Held for a soak, a
 * commit whose smoke was run again and went red was promoted when the soak
 * ended, and one sent back was promoted by a green re-run.
 */
const PROMOTABLE = `smoke_conclusion = 'success' and sent_back_at is null and rollback_dispatched_at is null`;

/** Takes the promote step, once, and only for a commit that may be promoted (`PROMOTABLE`). */
export async function claimPromote(repoId: string, sha: string, detail: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `update deploy_runs set promote_dispatched_at = now(), detail = $3, updated_at = now()
     where repo_id = $1 and sha = $2 and promote_dispatched_at is null and ${PROMOTABLE} returning id`,
    [repoId, sha, detail],
  );
  return row !== null;
}

/** Gives a claimed step back, when what it was claimed for did not happen. */
export async function release(repoId: string, sha: string, step: Step, detail: string): Promise<void> {
  await query(`update deploy_runs set ${step} = null, detail = $3, updated_at = now() where repo_id = $1 and sha = $2`, [repoId, sha, detail]);
}

/**
 * A smoke run on testing, for a commit. A red one stays red: the commit is
 * being reverted, and a green re-run after it is not a reason to promote it.
 * It also drops a soak, or a hold for a person, the bridge was keeping for
 * the commit: neither is a promote any more.
 */
export async function recordSmoke(repoId: string, sha: string, conclusion: string): Promise<void> {
  await query(
    `update deploy_runs set
       smoke_conclusion = case when smoke_conclusion = 'failure' then 'failure' else $3 end,
       promote_after = case when $3 = 'failure' then null else promote_after end,
       promote_held_at = case when $3 = 'failure' then null else promote_held_at end,
       smoke_at = now(), updated_at = now()
     where repo_id = $1 and sha = $2`,
    [repoId, sha, conclusion],
  );
}

export async function recordProduction(repoId: string, sha: string, conclusion: string): Promise<void> {
  await query(
    `update deploy_runs set production_conclusion = $3, production_at = now(), updated_at = now() where repo_id = $1 and sha = $2`,
    [repoId, sha, conclusion],
  );
}

/** Marks the commit's rollback as owed, once: its promote's traffic shift failed. */
export async function oweRollback(repoId: string, sha: string): Promise<void> {
  await query(
    `update deploy_runs set rollback_due_at = coalesce(rollback_due_at, now()), updated_at = now() where repo_id = $1 and sha = $2`,
    [repoId, sha],
  );
}

/** How the commit's rollback ended, from its workflow run: `success` or `failure`. A success clears the trouble before it. */
export async function recordRollback(repoId: string, sha: string, conclusion: 'success' | 'failure'): Promise<void> {
  await query(
    `update deploy_runs set rollback_conclusion = $3, rollback_at = now(),
       rollback_trouble = case when $3 = 'success' then null else rollback_trouble end, updated_at = now()
     where repo_id = $1 and sha = $2`,
    [repoId, sha, conclusion],
  );
}

/**
 * A dispatched rollback that did not run — its run was cancelled, or none
 * appeared — given back, so the deploy sweep dispatches it again, with why
 * kept for the board until one succeeds.
 */
export async function rollbackDidNotRun(repoId: string, sha: string, why: string): Promise<void> {
  await query(
    `update deploy_runs set rollback_dispatched_at = null, rollback_trouble = $3, detail = $3, updated_at = now()
     where repo_id = $1 and sha = $2 and rollback_conclusion is null`,
    [repoId, sha, why],
  );
}

/**
 * Rollbacks since `since` that did not finish well: the last one dispatched
 * was cancelled or never started, or one ran and failed. Not once a newer
 * commit was promoted: production has moved on from the one that failed.
 */
export async function unfinishedRollbacks(since: Date): Promise<DeployRun[]> {
  const rows = await query<Row>(
    `select * from deploy_runs r
     where r.rollback_due_at is not null and r.created_at >= $1
       and (r.rollback_conclusion = 'failure' or (r.rollback_conclusion is null and r.rollback_trouble is not null))
       and not exists (
         select 1 from deploy_runs n where n.repo_id = r.repo_id and n.created_at > r.created_at and n.promote_dispatched_at is not null
       )
     order by r.rollback_due_at`,
    [since],
  );
  return rows.map(toRun);
}

/**
 * A rollback owed in the repository that has not ended: dispatched and still
 * running or waiting, or given back and not yet dispatched again. A promote
 * waits for it: both shift production's traffic, in one GitHub concurrency
 * group that keeps one run and one pending, so a promote dispatched now
 * would cancel the pending rollback. Not once a newer commit was promoted
 * anyway, as `undispatchedRollbacks` reads it. Null when there is none.
 */
export async function rollbackOutstanding(repoId: string): Promise<DeployRun | null> {
  const row = await queryOne<Row>(
    `select * from deploy_runs r
     where r.repo_id = $1 and r.rollback_due_at is not null and r.rollback_conclusion is null
       and not exists (
         select 1 from deploy_runs n where n.repo_id = r.repo_id and n.created_at > r.created_at and n.promote_dispatched_at is not null
       )
     order by r.rollback_due_at desc limit 1`,
    [repoId],
  );
  return row ? toRun(row) : null;
}

/**
 * Rollbacks dispatched since `since` whose run has not been seen to end, for
 * the deploy sweep to look at. Not once a newer commit was promoted: one given
 * back then is not dispatched again (`undispatchedRollbacks`), and production
 * has moved on from the one that failed.
 */
export async function dispatchedRollbacks(since: Date): Promise<DeployRun[]> {
  const rows = await query<Row>(
    `select * from deploy_runs r
     where r.rollback_due_at is not null and r.rollback_dispatched_at >= $1 and r.rollback_conclusion is null
       and not exists (
         select 1 from deploy_runs n where n.repo_id = r.repo_id and n.created_at > r.created_at and n.promote_dispatched_at is not null
       )
     order by r.rollback_dispatched_at`,
    [since],
  );
  return rows.map(toRun);
}

/**
 * Holds the promote until `after`: a soak the bridge keeps for a repository
 * whose plan has no wait timer. It takes the place of a person's hold, which
 * is what switching a held repository to automatic delivery does.
 */
export async function holdPromote(repoId: string, sha: string, after: Date, detail: string): Promise<void> {
  await query(
    `update deploy_runs set promote_after = $3, promote_held_at = null, detail = $4, updated_at = now()
     where repo_id = $1 and sha = $2 and promote_dispatched_at is null`,
    [repoId, sha, after, detail],
  );
}

/**
 * Holds the promote for a person: the rules say a person approves production
 * and GitHub's plan cannot hold a reviewer on the environment. It takes the
 * place of a soak, and a promote already dispatched is not held.
 */
export async function holdForPerson(repoId: string, sha: string, detail: string): Promise<void> {
  await query(
    `update deploy_runs set promote_held_at = coalesce(promote_held_at, now()), promote_after = null, detail = $3, updated_at = now()
     where repo_id = $1 and sha = $2 and promote_dispatched_at is null`,
    [repoId, sha, detail],
  );
}

/** The promotes held for a person and not yet dispatched, in one repository or all, oldest first. */
export async function heldForPerson(repoId?: string): Promise<DeployRun[]> {
  const rows = await query<Row>(
    `select * from deploy_runs where promote_held_at is not null and promote_dispatched_at is null and ${PROMOTABLE}
     ${repoId ? 'and repo_id = $1' : ''} order by promote_held_at`,
    repoId ? [repoId] : [],
  );
  return rows.map(toRun);
}

/**
 * Takes a held promote's dispatch step, once: false when it is not held, or
 * another release took it first. The hold itself stays until the dispatch
 * went through (`recordRelease`), so a dispatch GitHub refused, which gives
 * the step back (`release`), leaves it held for the person to try again.
 */
export async function releaseHeld(repoId: string, sha: string, detail: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `update deploy_runs set promote_dispatched_at = now(), detail = $3, updated_at = now()
     where repo_id = $1 and sha = $2 and promote_held_at is not null and promote_dispatched_at is null and ${PROMOTABLE} returning id`,
    [repoId, sha, detail],
  );
  return row !== null;
}

/** Who released a held promote, once its dispatch went through. */
export async function recordRelease(repoId: string, sha: string, by: string): Promise<void> {
  await query(`update deploy_runs set promote_released_by = $3, updated_at = now() where repo_id = $1 and sha = $2`, [repoId, sha, by]);
}

/** Promotes whose soak is over and that nothing has dispatched. */
export async function duePromotes(now = new Date()): Promise<DeployRun[]> {
  const rows = await query<Row>(
    `select * from deploy_runs
     where promote_after is not null and promote_after <= $1 and promote_dispatched_at is null and ${PROMOTABLE}
     order by promote_after`,
    [now],
  );
  return rows.map(toRun);
}

/**
 * Promotes a green smoke called for that nothing dispatched — one GitHub
 * refused or did not answer, given back — for the deploy sweep to dispatch
 * again. Only a repository's newest commit, and only since `since`: a newer
 * merge is promoted itself once its smoke passes, and promoting an older one
 * after it would move production backwards. A soak the bridge holds is
 * `duePromotes`', and one held for a person is a person's to release.
 */
export async function undispatchedPromotes(since: Date): Promise<DeployRun[]> {
  const rows = await query<Row>(
    `select * from deploy_runs r
     where r.promote_dispatched_at is null and r.promote_after is null and r.promote_held_at is null and r.smoke_at >= $1 and ${PROMOTABLE}
       and not exists (select 1 from deploy_runs n where n.repo_id = r.repo_id and n.created_at > r.created_at)
     order by r.smoke_at`,
    [since],
  );
  return rows.map(toRun);
}

/**
 * Rollbacks owed (`oweRollback`) that nothing dispatched, for the deploy sweep
 * to dispatch again. Not once a newer commit of the repository has been
 * promoted: production has moved past the one that failed, and a rollback
 * now would take the newer one off.
 */
export async function undispatchedRollbacks(): Promise<DeployRun[]> {
  const rows = await query<Row>(
    `select * from deploy_runs r
     where r.rollback_due_at is not null and r.rollback_dispatched_at is null
       and not exists (
         select 1 from deploy_runs n where n.repo_id = r.repo_id and n.created_at > r.created_at and n.promote_dispatched_at is not null
       )
     order by r.rollback_due_at`,
  );
  return rows.map(toRun);
}

/**
 * Promote and rollback steps still not dispatched though they were due
 * before `before`, for the health check: a promote the sweep tries again
 * whose last dispatch failed (its `detail` says why, as `release` wrote it),
 * whether or not the bridge held its soak, and any rollback owed.
 */
export async function undispatchedSince(before: Date, since: Date): Promise<{ step: 'promote' | 'rollback'; run: DeployRun }[]> {
  const promotes = await query<Row>(
    `select * from deploy_runs r
     where r.promote_dispatched_at is null and r.promote_held_at is null and r.smoke_at >= $2 and ${PROMOTABLE}
       and coalesce(r.promote_after, r.smoke_at) <= $1 and r.detail like '% not dispatched%'
       and not exists (select 1 from deploy_runs n where n.repo_id = r.repo_id and n.created_at > r.created_at)
     order by r.smoke_at`,
    [before, since],
  );
  const rollbacks = (await undispatchedRollbacks()).filter((run) => run.rollbackDueAt !== null && Date.parse(run.rollbackDueAt) <= before.getTime());
  return [...promotes.map((row) => ({ step: 'promote' as const, run: toRun(row) })), ...rollbacks.map((run) => ({ step: 'rollback' as const, run }))];
}

/**
 * Commits since `since` whose smoke or production deploy failed and that
 * nothing has sent back to build: a send-back given back, for the sweep to
 * try again.
 */
export async function unsentBack(since: Date): Promise<DeployRun[]> {
  const rows = await query<Row>(
    `select * from deploy_runs
     where sent_back_at is null and (smoke_conclusion = 'failure' or production_conclusion = 'failure') and created_at >= $1
     order by created_at`,
    [since],
  );
  return rows.map(toRun);
}

/** The rows for these pull requests in a repository, newest first. */
export async function forPullRequests(repoId: string, prNumbers: readonly number[]): Promise<DeployRun[]> {
  if (prNumbers.length === 0) return [];
  const rows = await query<Row>(
    `select * from deploy_runs where repo_id = $1 and pr_number = any($2) order by created_at desc`,
    [repoId, prNumbers],
  );
  return rows.map(toRun);
}
