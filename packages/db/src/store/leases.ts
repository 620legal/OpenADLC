import type { Lease, LeaseState } from '@fleetadlc/shared';
import { query, queryOne } from '../client.js';

interface LeaseRow {
  id: string;
  repo_id: string;
  issue_number: number;
  bot_id: string;
  declared_paths: string[];
  state: LeaseState;
  expires_at: Date | null;
  pr_number: number | null;
  updated_at?: Date | null;
}

const SELECT = `
  select id, repo_id, issue_number, bot_id, declared_paths, state, expires_at, pr_number, updated_at
  from leases
`;

function toLease(row: LeaseRow): Lease {
  return {
    id: row.id,
    repoId: row.repo_id,
    issueNumber: row.issue_number,
    botId: row.bot_id,
    declaredPaths: row.declared_paths,
    state: row.state,
    expiresAt: row.expires_at?.toISOString() ?? null,
    prNumber: row.pr_number,
    ...(row.updated_at ? { updatedAt: row.updated_at.toISOString() } : {}),
  };
}

const ACTIVE: LeaseState[] = ['leased', 'in_task', 'paused'];

export async function listActiveLeases(repoId?: string): Promise<Lease[]> {
  const rows = await query<LeaseRow>(
    `${SELECT} where state = any($1) and ($2::uuid is null or repo_id = $2) order by created_at`,
    [ACTIVE, repoId ?? null],
  );
  return rows.map(toLease);
}

export async function getActiveLease(repoId: string, issueNumber: number): Promise<Lease | null> {
  const row = await queryOne<LeaseRow>(
    `${SELECT} where repo_id = $1 and issue_number = $2 and state = any($3)`,
    [repoId, issueNumber, ACTIVE],
  );
  return row ? toLease(row) : null;
}

/**
 * The lease that holds an issue, or when none does, the last one that did:
 * what OpenADLC granted the issue's work, widened only by approved plan
 * changes. The merge line holds a crew pull request to it, and it has to be
 * there when the lease has been let go of while the pull request waits.
 */
export async function latestLease(repoId: string, issueNumber: number): Promise<Lease | null> {
  const row = await queryOne<LeaseRow>(
    `${SELECT} where repo_id = $1 and issue_number = $2
      order by (state = any($3)) desc, created_at desc limit 1`,
    [repoId, issueNumber, ACTIVE],
  );
  return row ? toLease(row) : null;
}

export async function createLease(input: {
  repoId: string;
  issueNumber: number;
  botId: string;
  declaredPaths: string[];
  expiresAt: Date | null;
}): Promise<Lease> {
  const row = await queryOne<LeaseRow>(
    `insert into leases (repo_id, issue_number, bot_id, declared_paths, state, expires_at)
     values ($1,$2,$3,$4,'leased',$5)
     returning id, repo_id, issue_number, bot_id, declared_paths, state, expires_at, pr_number, updated_at`,
    [input.repoId, input.issueNumber, input.botId, input.declaredPaths, input.expiresAt],
  );
  if (!row) throw new Error('failed to create lease');
  return toLease(row);
}

export async function setLeaseState(
  id: string,
  state: LeaseState,
  patch: { prNumber?: number | null; expiresAt?: Date | null } = {},
): Promise<Lease | null> {
  const row = await queryOne<LeaseRow>(
    `update leases set
       state = $2,
       pr_number = coalesce($3, pr_number),
       expires_at = case when $4::timestamptz is not null then $4 else expires_at end,
       updated_at = now()
     where id = $1
     returning id, repo_id, issue_number, bot_id, declared_paths, state, expires_at, pr_number, updated_at`,
    [id, state, patch.prNumber ?? null, patch.expiresAt ?? null],
  );
  return row ? toLease(row) : null;
}

/**
 * Releases a lease nothing is working under, in one statement that checks it
 * still is: no pull request, not paused, and no task going on it. The health
 * check decides from reads taken a moment earlier, and a release by id alone
 * overwrote a retry that had started under it since, so the issue could be
 * leased to a second builder beside the first. True when it was released.
 */
export async function releaseIfIdle(id: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `update leases set state = 'released', updated_at = now()
     where id = $1 and state in ('leased','in_task') and pr_number is null
       and not exists (select 1 from tasks t where t.lease_id = $1 and t.state in ('queued','running','paused'))
     returning id`,
    [id],
  );
  return row !== null;
}

/** A lease with no PR expires; the issue returns to the board for the next run. */
export async function expireStaleLeases(now = new Date()): Promise<Lease[]> {
  const rows = await query<LeaseRow>(
    `update leases set state = 'expired', updated_at = now()
     where state in ('leased','in_task')
       and pr_number is null
       and expires_at is not null
       and expires_at < $1
     returning id, repo_id, issue_number, bot_id, declared_paths, state, expires_at, pr_number, updated_at`,
    [now],
  );
  return rows.map(toLease);
}

/** One lease by id, for a caller deciding whether it may be released. */
export async function getLease(id: string): Promise<Lease | null> {
  const rows = await query<LeaseRow>(`${SELECT} where id = $1`, [id]);
  return rows[0] ? toLease(rows[0]) : null;
}

/**
 * Releases the lease a pull request was holding.
 *
 * Called when the pull request closes unmerged, or when the verification after
 * a merge ends — the two moments the work stops being in flight. Until then the
 * lease is what stops a second, overlapping issue going out. The release is
 * audited as the bridge's `lease.released`, with `why`, in the same statement.
 */
export async function releaseForPullRequest(repoId: string, prNumber: number, why: string): Promise<Lease | null> {
  const rows = await query<LeaseRow>(
    `with released as (
       update leases set state = 'released', updated_at = now()
        where repo_id = $1 and pr_number = $2 and state = any($3)
        returning id, repo_id, issue_number, bot_id, declared_paths, state, expires_at, pr_number, updated_at
     ), logged as (
       insert into audit (actor, action, target, payload)
       select 'bridge', 'lease.released',
              coalesce((select r.name from repos r where r.id = released.repo_id), 'issue') || '#' || released.issue_number,
              jsonb_build_object('leaseId', released.id, 'reason', $4::text, 'pullRequest', $2::int)
         from released
     )
     select * from released`,
    [repoId, prNumber, ACTIVE, why],
  );
  return rows[0] ? toLease(rows[0]) : null;
}

/** The newest lease a pull request was linked to, in any state: what a re-take would copy. */
export async function lastForPullRequest(repoId: string, prNumber: number): Promise<Lease | null> {
  const row = await queryOne<LeaseRow>(`${SELECT} where repo_id = $1 and pr_number = $2 order by created_at desc limit 1`, [repoId, prNumber]);
  return row ? toLease(row) : null;
}

/**
 * Takes an issue's lease again for its pull request, after the pull request
 * was closed unmerged (which released it) and then reopened, or after the
 * reconciler let it go while the pull request stayed open.
 *
 * Without one, a request for changes, a red CI run or a conflict on the
 * reopened pull request found no lease and opened no patch round, and the
 * work stopped with nothing on the board to say so.
 *
 * One statement: the new lease copies the builder and the paths of the newest
 * lease linked to that pull request, only when that one was released and no
 * lease on the issue is active; it is linked to the pull request in the state
 * a lease waiting on its pull request in review is in (`in_task`, no expiry,
 * as `settlePausedLeases` leaves one), and audited as `lease.reacquired` with
 * `reason`. Null when nothing was taken. Whether the builder is still in the
 * crew and whether another lease now holds the paths is the caller's to check.
 */
export async function reacquireForPullRequest(input: {
  repoId: string;
  issueNumber: number;
  prNumber: number;
  actor: string;
  reason: string;
}): Promise<Lease | null> {
  const row = await queryOne<LeaseRow>(
    `with last as (
       select bot_id, declared_paths, state from leases
        where repo_id = $1 and issue_number = $2 and pr_number = $3
        order by created_at desc limit 1
     ), taken as (
       insert into leases (repo_id, issue_number, bot_id, declared_paths, state, expires_at, pr_number)
       select $1, $2, last.bot_id, last.declared_paths, 'in_task', null, $3
         from last
        where last.state = 'released'
          and not exists (select 1 from leases l where l.repo_id = $1 and l.issue_number = $2 and l.state = any($4))
       on conflict do nothing
       returning id, repo_id, issue_number, bot_id, declared_paths, state, expires_at, pr_number, updated_at
     ), logged as (
       insert into audit (actor, action, target, payload)
       select $5::text, 'lease.reacquired',
              coalesce((select r.name from repos r where r.id = taken.repo_id), 'issue') || '#' || taken.issue_number,
              jsonb_build_object('leaseId', taken.id, 'reason', $6::text, 'pullRequest', taken.pr_number)
         from taken
     )
     select * from taken`,
    [input.repoId, input.issueNumber, input.prNumber, ACTIVE, input.actor, input.reason],
  );
  return row ? toLease(row) : null;
}

/**
 * Lets go of every lease a repository still holds, when it leaves OpenADLC.
 *
 * Removing a repository used to leave its leases `in_task` on its issues: the
 * dispatcher leases nothing there any more, so nothing ever came back for
 * them, and a person released them in the database. Each is audited as
 * `lease.released` with `reason`, in the same statement.
 *
 * A lease an unfinished task still works under is left held: its task could
 * not be stopped, and it is released with it when the removal is run again.
 */
export async function releaseForRepo(input: { repoId: string; actor: string; reason: string }): Promise<Lease[]> {
  const rows = await query<LeaseRow>(
    `with released as (
       update leases l set state = 'released', updated_at = now()
        where l.repo_id = $1
          and l.state = any($2)
          and not exists (select 1 from tasks t where t.lease_id = l.id and t.state in ('queued', 'running', 'paused'))
        returning l.id, l.repo_id, l.issue_number, l.bot_id, l.declared_paths, l.state, l.expires_at, l.pr_number, l.updated_at
     ), logged as (
       insert into audit (actor, action, target, payload)
       select $3::text, 'lease.released',
              coalesce((select r.name from repos r where r.id = released.repo_id), 'issue') || '#' || released.issue_number,
              jsonb_build_object('leaseId', released.id, 'reason', $4::text)
         from released
     )
     select * from released`,
    [input.repoId, ACTIVE, input.actor, input.reason],
  );
  return rows.map(toLease);
}

/**
 * Holds a lease with no expiry while a person is being waited on.
 *
 * A gate can stay open for a day. Expiring the lease under it would hand the
 * issue back to the board while the bot is still holding the branch.
 */
export async function pauseIndefinitely(id: string): Promise<void> {
  await query(`update leases set state = 'paused', expires_at = null, updated_at = now() where id = $1`, [id]);
}

/**
 * Lets go of paused leases whose work has ended: one lease, or every one when
 * no id is given, which is the reconciler's sweep.
 *
 * A gate pauses its task's lease with no expiry, and nothing set it back when
 * the question was answered. So a task that ended afterwards — done, failed,
 * stopped — left its lease paused, and a paused lease is outside every other
 * rule: the idle-lease check leaves it alone as a question to a person, and
 * `expireStaleLeases` has no expiry to go by. One held an issue's paths after its
 * task ended, and every issue that overlapped them waited for nothing until a
 * person released it in the database.
 *
 * A lease is settled only when no task under it is unfinished: a task paused
 * on a person's answer holds the issue by design, and is resumed on it. A gate
 * still open on a task that has already ended is a question nobody can act on
 * any more — answering it would resume nothing — so it is closed (`expired`),
 * audited with `reason`, rather than holding the lease for ever. Then:
 *
 * - **A pull request is open for the issue**, on the lease or only on the
 *   issue (the lease's link is best-effort: a webhook that failed, or the
 *   scheduler's recovery, which writes only the issue): the lease is put back
 *   in task with that pull request, whose closing or merge releases it
 *   (`releaseForPullRequest`). Releasing it would leave a patch round and QA
 *   with no lease to find. The issue's number is taken only while the issue is
 *   in review. That is not the same as its pull request being open — a pull
 *   request closed unmerged leaves the stage alone — so the close handler
 *   releases an unlinked lease on the issue itself (`webhooks.ts`), and
 *   nothing is left for this to attach it to. `issues.pr_number` is
 *   never cleared, so an issue whose pull request closed unmerged and went back
 *   to build still names it, and a lease linked to a closed pull request is let
 *   go by nothing — no close is coming, it has no expiry, and the idle check
 *   passes over a lease with a pull request. Past review, the issue's number is
 *   ignored and the rules below decide.
 * - **Its last task finished**: back in task with `holdUntil` as its expiry,
 *   because a finished build's pull request may not have been linked yet, and
 *   releasing would hand the issue out twice.
 * - **Its last task failed or stopped**, or it has none: released.
 *
 * The usual rules — the link, the idle check, the expiry — take it from there.
 *
 * One statement, so each lease is checked and written together and every
 * change is audited with `reason`. It is not a lock: under read committed, a
 * task inserted under the lease while the statement runs is not seen by its
 * checks. The window is that statement's length, and a task already started
 * is never missed.
 */
export async function settlePausedLeases(input: {
  leaseId?: string | null;
  actor: string;
  reason: string;
  holdUntil: Date;
}): Promise<{ released: Lease[]; held: Lease[] }> {
  const rows = await query<LeaseRow>(
    `with ended as (
       select l.id,
              (select t.state from tasks t where t.lease_id = l.id
                order by coalesce(t.ended_at, t.created_at) desc limit 1) as last_state,
              coalesce(l.pr_number,
                (select i.pr_number from issues i
                  where i.repo_id = l.repo_id and i.number = l.issue_number and i.stage = 'review')) as pr
         from leases l
        where l.state = 'paused'
          and ($1::uuid is null or l.id = $1)
          and not exists (select 1 from tasks t where t.lease_id = l.id and t.state in ('queued', 'running', 'paused'))
     ), closed as (
       update gates g set state = 'expired', updated_at = now()
       from tasks t, ended
       where g.task_id = t.id and t.lease_id = ended.id and g.state = 'open'
       returning g.id, t.subject_ref
     ), closed_logged as (
       insert into audit (actor, action, target, payload)
       select $3::text, 'gate.expired', closed.subject_ref,
              jsonb_build_object('gateId', closed.id, 'reason', 'its task had ended, so an answer would resume nothing')
         from closed
     ), settled as (
       update leases l set
         state = case when ended.pr is not null or ended.last_state = 'done' then 'in_task' else 'released' end,
         pr_number = ended.pr,
         expires_at = case when ended.pr is null and ended.last_state = 'done' then $2::timestamptz else l.expires_at end,
         updated_at = now()
       from ended
       where l.id = ended.id and l.state = 'paused'
       returning l.id, l.repo_id, l.issue_number, l.bot_id, l.declared_paths, l.state, l.expires_at, l.pr_number, l.updated_at
     ), logged as (
       insert into audit (actor, action, target, payload)
       select $3::text,
              case when settled.state = 'released' then 'lease.released' else 'lease.unpaused' end,
              coalesce((select r.name from repos r where r.id = settled.repo_id), 'issue') || '#' || settled.issue_number,
              jsonb_build_object('leaseId', settled.id, 'reason', $4::text, 'pullRequest', settled.pr_number)
         from settled
     )
     select * from settled`,
    [input.leaseId ?? null, input.holdUntil, input.actor, input.reason],
  );
  const settled = rows.map(toLease);
  return {
    released: settled.filter((lease) => lease.state === 'released'),
    held: settled.filter((lease) => lease.state !== 'released'),
  };
}

/**
 * How many times this issue has been built and come back with no pull request.
 *
 * Counts only leases that are over: one in flight is not a failed attempt, it is
 * the current one. And only leases a build ran under and ended on its own: a
 * lease the bridge refused, or whose task never started (hostd down, the bot
 * out of the repository, the host full), is released with nothing tried, and
 * a build that was stopped — by a person, or by its session going away with
 * its host — said nothing about the issue. Every one of those counted, so a
 * few refused passes sent a ready issue to triage with a comment blaming the
 * issue. `started_at` is set only once hostd has the session running.
 *
 * Only leases taken since the issue was last sent to triage count: a person
 * who puts `start:now` back has reshaped it, and the old count sent it straight
 * back to triage on the next pass, for good.
 */
export async function attemptsWithoutPullRequest(repoId: string, issueNumber: number): Promise<number> {
  const rows = await query<{ count: string }>(
    `select count(*) as count from leases l
      where l.repo_id = $1 and l.issue_number = $2 and l.pr_number is null
        and l.state in ('released', 'expired')
        and exists (select 1 from tasks t
                     where t.lease_id = l.id and t.kind = 'implement' and t.started_at is not null and t.state <> 'stopped')
        and l.created_at > coalesce(
          (select max(a.at) from audit a, repos r
            where r.id = $1 and a.action = 'issue.triaged' and a.target = r.name || '#' || $2::int),
          '-infinity')`,
    [repoId, issueNumber],
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Widens a lease's paths and its issue's together, in one statement.
 *
 * The lease is what a task's session may write and the issue's paths are what
 * the dispatcher compares other issues against. Two updates could stop between
 * them, and an issue claiming less than its builder may write is the collision
 * the overlap check exists to prevent. The issue is found from the lease, so
 * the two cannot name different issues. Only a lease still held is widened, and
 * a path already there is not added again.
 */
export async function widenPaths(leaseId: string, paths: readonly string[]): Promise<Lease | null> {
  const row = await queryOne<LeaseRow>(
    `with widened as (
       update leases set
         declared_paths = array(
           select path from unnest(declared_paths || $2::text[]) with ordinality as entry(path, position)
            group by path order by min(position)),
         updated_at = now()
       where id = $1 and state = any($3)
       returning id, repo_id, issue_number, bot_id, declared_paths, state, expires_at, pr_number, updated_at
     ), issue as (
       update issues set
         declared_paths = array(
           select path from unnest(issues.declared_paths || $2::text[]) with ordinality as entry(path, position)
            group by path order by min(position)),
         updated_at = now()
       from widened
       where issues.repo_id = widened.repo_id and issues.number = widened.issue_number
       returning issues.id
     )
     select * from widened`,
    [leaseId, [...paths], ACTIVE],
  );
  return row ? toLease(row) : null;
}

/** A plan-change request as its gate holds it. */
export interface PlanChangeRecord {
  paths: string[];
  reason: string;
  /** Approved, but waiting for another lease to let go of a path it asked for. */
  held: { approvedBy: string; blockedBy: number[] } | null;
}

interface PlanChangePayload {
  planChange?: { paths?: unknown; reason?: unknown };
  held?: { approvedBy?: unknown; blockedBy?: unknown };
}

function toPlanChange(payload: PlanChangePayload | null): PlanChangeRecord | null {
  const request = payload?.planChange;
  if (!request || !Array.isArray(request.paths)) return null;
  const held = payload?.held;
  return {
    paths: request.paths.filter((path): path is string => typeof path === 'string'),
    reason: typeof request.reason === 'string' ? request.reason : '',
    held: held
      ? {
          approvedBy: typeof held.approvedBy === 'string' ? held.approvedBy : '',
          blockedBy: Array.isArray(held.blockedBy) ? held.blockedBy.filter((n): n is number => typeof n === 'number') : [],
        }
      : null,
  };
}

/**
 * The plan-change request a gate asked, or null when it asked an ordinary
 * question. It rides in the payload of the gate's message in the thread, which
 * is written when the gate opens.
 */
export async function planChangeOfGate(gateId: string): Promise<PlanChangeRecord | null> {
  const row = await queryOne<{ payload: PlanChangePayload | null }>(
    `select payload from messages where kind = 'gate' and payload->>'gateId' = $1 order by at desc limit 1`,
    [gateId],
  );
  return toPlanChange(row?.payload ?? null);
}

/** Remembers that a person approved a request that another lease is holding up. */
export async function holdPlanChange(gateId: string, held: { approvedBy: string; blockedBy: number[] }): Promise<void> {
  await query(
    `update messages set payload = payload || jsonb_build_object('held', $2::jsonb)
      where kind = 'gate' and payload->>'gateId' = $1`,
    [gateId, JSON.stringify(held)],
  );
}

/** The open gates whose request was approved and is waiting on another lease, oldest first. */
export async function listHeldPlanChanges(): Promise<{ gateId: string; request: PlanChangeRecord }[]> {
  const rows = await query<{ gate_id: string; payload: PlanChangePayload }>(
    `select g.id as gate_id, m.payload
       from gates g join messages m on m.kind = 'gate' and m.payload->>'gateId' = g.id::text
      where g.state = 'open' and m.payload ? 'held'
      order by g.created_at`,
  );
  return rows.flatMap((row) => {
    const request = toPlanChange(row.payload);
    return request?.held ? [{ gateId: row.gate_id, request }] : [];
  });
}
