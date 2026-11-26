import type { TaskState } from '@openadlc/shared';
import { query, queryOne } from '../client.js';

/**
 * What the board's event feed reads (`apps/bridge/src/board-events.ts`), each
 * from the table the event already happens in: nothing here writes, and no
 * writer has to remember to tell the feed. See
 * docs/adr/0021-board-events-are-read-from-the-tables-they-happen-in.md and,
 * for the history, docs/adr/0081-board-event-history-is-a-read-of-the-tables-events-happen-in.md.
 *
 * Every read is over a window (`EventWindow`). The live feed reads from ten
 * seconds before where its last probe got to, since a row written with
 * `now()` in a transaction can commit after a probe has moved past its
 * timestamp; the history reads back from a cursor, page by page.
 */

/** The database's clock, which every window below is compared with: the bridge's may differ. */
export async function dbNow(): Promise<Date> {
  const row = await queryOne<{ now: Date }>('select now() as now');
  return row?.now ?? new Date();
}

/**
 * The stretch of time a read covers: rows at or after `from`, and at or
 * before `to` when it is set, newest first. With `limit`, at most that many
 * rows and every further row tied at the last one's time.
 *
 * The tie rule is what makes the history's cursor exact: a page cut through
 * rows sharing one time would leave the rest of them on neither side of it.
 * `to` and the ties are compared to the millisecond, which is all a
 * JavaScript `Date`, and so a cursor, holds: compared by the microsecond, a
 * row at 12:00:00.000500 fell outside a window ending at its own time as the
 * bridge wrote it, 12:00:00.000.
 */
export interface EventWindow {
  from: Date;
  to?: Date;
  limit?: number;
}

/**
 * `inner` selects its rows with their time as `at` and their key as `id`,
 * bounded by `windowWhere`, which reads `$1` (from) and `$2` (to). `$3` is the
 * limit, and anything else `inner` needs is `$4` on.
 */
async function windowed<T>(inner: string, window: EventWindow, extra: unknown[] = []): Promise<(T & { at: Date })[]> {
  return query<T & { at: Date }>(
    `select * from (
       select x.*, rank() over (order by date_trunc('milliseconds', x.at) desc) as event_rank
       from (${inner}) x
     ) y
     where ($3::int is null or y.event_rank <= $3)
     order by date_trunc('milliseconds', y.at) desc, y.id desc`,
    [window.from, window.to ?? null, window.limit ?? null, ...extra],
  );
}

/** The window's bounds on a column, for `windowed`'s inner select. */
function windowWhere(column: string): string {
  return `${column} >= $1 and ($2::timestamptz is null or date_trunc('milliseconds', ${column}) <= $2)`;
}

export interface StartedRow {
  taskId: string;
  at: string;
  bot: string | null;
  subjectRef: string;
  kind: string;
  skill: string | null;
}

/** Tasks that began running in the window. A resume keeps its first `started_at`, so it is not a second start. */
export async function startedIn(window: EventWindow): Promise<StartedRow[]> {
  const rows = await windowed<{ id: string; bot: string | null; subject_ref: string; kind: string; skill: string | null }>(
    `select t.id, t.started_at as at, b.name as bot, t.subject_ref, t.kind, t.skill
     from tasks t left join bots b on b.id = t.bot_id
     where ${windowWhere('t.started_at')}`,
    window,
  );
  return rows.map((row) => ({ taskId: row.id, at: row.at.toISOString(), bot: row.bot, subjectRef: row.subject_ref, kind: row.kind, skill: row.skill }));
}

export interface AskedRow {
  gateId: string;
  at: string;
  bot: string | null;
  /** The task's subject, else its thread's; null for a gate on neither. */
  subjectRef: string | null;
  question: string;
  /** Its choices, which tell a task stopped at its cost cap (`isCostCapGate`) from a question. */
  options: string[];
}

/** Questions opened in the window, with the seat that asked and what about. */
export async function askedIn(window: EventWindow): Promise<AskedRow[]> {
  const rows = await windowed<{ id: string; bot: string | null; subject_ref: string | null; question: string; options: string[] | null }>(
    `select g.id, g.created_at as at, coalesce(tb.name, hb.name) as bot,
            coalesce(t.subject_ref, h.subject_ref) as subject_ref, g.question, g.options
     from gates g
     left join tasks t on t.id = g.task_id
     left join bots tb on tb.id = t.bot_id
     left join threads h on h.id = g.thread_id
     left join bots hb on hb.id = h.bot_id
     where ${windowWhere('g.created_at')}`,
    window,
  );
  return rows.map((row) => ({
    gateId: row.id,
    at: row.at.toISOString(),
    bot: row.bot,
    subjectRef: row.subject_ref,
    question: row.question,
    options: row.options ?? [],
  }));
}

export interface MergedRow {
  moveId: string;
  at: string;
  repoName: string;
  issueNumber: number;
  prNumber: number | null;
  /** Who moved it: a seat's name, a person, or `openadlc`. */
  actor: string;
  /** The actor when it is a seat, else null. */
  bot: string | null;
}

/**
 * Merges recorded in the window: a forward move into Merged, or into Done
 * from anywhere but Merged, since a repository that ships by merging goes
 * straight to Done and a later Merged → Done is the deploy. This is the move
 * `moveClosedByMerge` makes for every merge, whoever merged.
 *
 * An issue closed without merging moves forward into Done too, with a reason
 * starting `Abandoned: ` (`abandonMoveReason`, apps/bridge/src/abandoned.ts):
 * read as a merge, `watch` said abandoned work had merged.
 *
 * `moveClosedByMerge` records no pull request number and sets the issue's
 * after, so the issue's is the fallback.
 */
export async function mergedIn(window: EventWindow): Promise<MergedRow[]> {
  const rows = await windowed<{ id: string; repo_name: string; issue_number: number; pr_number: number | null; actor: string; bot: string | null }>(
    `select m.id, m.created_at as at, r.name as repo_name, m.issue_number,
            coalesce(m.pr_number, i.pr_number) as pr_number, m.actor, b.name as bot
     from stage_moves m
     join repos r on r.id = m.repo_id
     left join issues i on i.repo_id = m.repo_id and i.number = m.issue_number
     left join bots b on b.name = m.actor
     where ${windowWhere('m.created_at')} and m.kind = 'forward'
       and (m.to_stage = 'merged' or (m.to_stage = 'done' and m.from_stage is distinct from 'merged'))
       and coalesce(m.reason, '') not like 'Abandoned: %'`,
    window,
  );
  return rows.map((row) => ({
    moveId: row.id,
    at: row.at.toISOString(),
    repoName: row.repo_name,
    issueNumber: row.issue_number,
    prNumber: row.pr_number,
    actor: row.actor,
    bot: row.bot,
  }));
}

export interface HeldAuditRow {
  auditId: string;
  at: string;
  actor: string;
  /** `owner/name#n`, as the hold wrote it. */
  target: string;
  why: string | null;
}

/** Pull requests a person held from the console (`pull.held`) in the window. */
export async function heldAuditIn(window: EventWindow): Promise<HeldAuditRow[]> {
  const rows = await windowed<{ id: string; actor: string; target: string; why: string | null }>(
    `select id::text as id, at, actor, target, payload->>'why' as why
     from audit
     where action = 'pull.held' and ${windowWhere('at')}`,
    window,
  );
  return rows.map((row) => ({ auditId: row.id, at: row.at.toISOString(), actor: row.actor, target: row.target, why: row.why }));
}

export interface HeldLineRow {
  id: string;
  at: string;
  repoName: string;
  prNumber: number;
  state: string;
  detail: string | null;
}

/**
 * Merge-line entries in `merging` whose row last changed in the window. A
 * hold is a state, not a row with a time, so the history can show one only
 * while it is held, timed when its row last changed; which of these wait on a
 * person is the bridge's `heldForPerson`.
 */
export async function heldLineIn(window: EventWindow): Promise<HeldLineRow[]> {
  const rows = await windowed<{ id: string; repo_name: string; pr_number: number; state: string; detail: string | null }>(
    `select m.id, m.updated_at as at, r.name as repo_name, m.pr_number, m.state, m.detail
     from merge_lines m join repos r on r.id = m.repo_id
     where m.state = 'merging' and ${windowWhere('m.updated_at')}`,
    window,
  );
  return rows.map((row) => ({ id: row.id, at: row.at.toISOString(), repoName: row.repo_name, prNumber: row.pr_number, state: row.state, detail: row.detail }));
}

/**
 * Each delivered thing at its first delivery, then the window. The window
 * goes outside: inside, a redelivery after the window's start whose first
 * delivery was before it read as news, and the live feed sent it again.
 */
function firstDeliveries(distinct: string): string {
  return `select * from (${distinct}) d where ${windowWhere('d.at')}`;
}

export interface PullOpenedRow {
  /** The first delivery's row, of however many GitHub sent. */
  eventId: string;
  at: string;
  login: string;
  repoName: string;
  repoFullName: string;
  prNumber: number;
  headRef: string | null;
  title: string;
  url: string | null;
}

/**
 * The managed repository a delivery is for. A delivery for a repository the
 * install does not manage keeps only its name, as a string rather than an
 * object (`receive` in apps/bridge/src/webhooks.ts), and so joins none.
 */
const MANAGED_REPO = `join repos r on r.removed_at is null
       and jsonb_typeof(e.payload->'repository') = 'object'
       and r.full_name = e.payload->'repository'->>'full_name'`;

/**
 * Pull requests one of `crewLogins` opened in a repository this install
 * manages, read from GitHub's `pull_request.opened` deliveries. Only the
 * fields the event needs come out of each payload, never the payload.
 *
 * A redelivery is the same pull request opened once, so each is read at its
 * first delivery. Deliveries are pruned after `OPENADLC_EVENT_RETENTION_DAYS`,
 * so this reaches back no further, and a pull request reconcile opened, whose
 * delivery never came, is not here.
 */
export async function pullsOpenedIn(window: EventWindow, crewLogins: readonly string[]): Promise<PullOpenedRow[]> {
  const logins = crewLogins.map((login) => login.toLowerCase());
  if (logins.length === 0) return [];
  const rows = await windowed<{
    id: string;
    login: string;
    repo_name: string;
    repo_full_name: string;
    pr_number: number;
    head_ref: string | null;
    title: string | null;
    url: string | null;
  }>(
    firstDeliveries(`select distinct on (r.full_name, (e.payload->'pull_request'->>'number')::int)
            e.id::text as id, e.at,
            e.payload->'pull_request'->'user'->>'login' as login,
            r.name as repo_name, r.full_name as repo_full_name,
            (e.payload->'pull_request'->>'number')::int as pr_number,
            e.payload->'pull_request'->'head'->>'ref' as head_ref,
            e.payload->'pull_request'->>'title' as title,
            e.payload->'pull_request'->>'html_url' as url
     from events e
     ${MANAGED_REPO}
     where e.source = 'github' and e.type = 'pull_request.opened'
       and lower(e.payload->'pull_request'->'user'->>'login') = any($4::text[])
     order by r.full_name, (e.payload->'pull_request'->>'number')::int, e.at, e.id`),
    window,
    [logins],
  );
  return rows.map((row) => ({
    eventId: row.id,
    at: row.at.toISOString(),
    login: row.login,
    repoName: row.repo_name,
    repoFullName: row.repo_full_name,
    prNumber: row.pr_number,
    headRef: row.head_ref,
    title: row.title ?? '',
    url: row.url,
  }));
}

export interface ApprovalRow {
  reviewId: string;
  at: string;
  login: string;
  /** The review's body, for the seat its marker names on a shared account (`seatOf`). */
  body: string | null;
  repoName: string;
  repoFullName: string;
  prNumber: number;
  url: string | null;
}

/**
 * Approving reviews one of `crewLogins` submitted in a repository this
 * install manages, from GitHub's `pull_request_review.submitted` deliveries,
 * each review once however often it was delivered. Which seat approved, and
 * whether it is the lead, is the bridge's to say. Pruned with every delivery,
 * as `pullsOpenedIn` is.
 */
export async function approvalsIn(window: EventWindow, crewLogins: readonly string[]): Promise<ApprovalRow[]> {
  const logins = crewLogins.map((login) => login.toLowerCase());
  if (logins.length === 0) return [];
  const rows = await windowed<{
    id: string;
    login: string;
    body: string | null;
    repo_name: string;
    repo_full_name: string;
    pr_number: number;
    url: string | null;
  }>(
    firstDeliveries(`select distinct on (e.payload->'review'->>'id')
            e.payload->'review'->>'id' as id, e.at,
            e.payload->'review'->'user'->>'login' as login,
            e.payload->'review'->>'body' as body,
            r.name as repo_name, r.full_name as repo_full_name,
            (e.payload->'pull_request'->>'number')::int as pr_number,
            e.payload->'pull_request'->>'html_url' as url
     from events e
     ${MANAGED_REPO}
     where e.source = 'github' and e.type = 'pull_request_review.submitted'
       and lower(e.payload->'review'->>'state') = 'approved'
       and lower(e.payload->'review'->'user'->>'login') = any($4::text[])
     order by e.payload->'review'->>'id', e.at, e.id`),
    window,
    [logins],
  );
  return rows.map((row) => ({
    reviewId: row.id,
    at: row.at.toISOString(),
    login: row.login,
    body: row.body,
    repoName: row.repo_name,
    repoFullName: row.repo_full_name,
    prNumber: row.pr_number,
    url: row.url,
  }));
}

export interface ReleasePublishedRow {
  runId: string;
  at: string;
  repoName: string;
  repoFullName: string;
  tag: string | null;
  version: string | null;
  url: string | null;
  /** The login of the person who cut it. */
  cutBy: string;
}

/** Releases published in the window, timed when they were published. */
export async function releasesPublishedIn(window: EventWindow): Promise<ReleasePublishedRow[]> {
  const rows = await windowed<{
    id: string;
    repo_name: string;
    repo_full_name: string;
    tag: string | null;
    version: string | null;
    release_url: string | null;
    requested_by_login: string;
  }>(
    `select x.id, x.published_at as at, r.name as repo_name, r.full_name as repo_full_name,
            x.tag, x.version, x.release_url, x.requested_by_login
     from release_runs x join repos r on r.id = x.repo_id
     where x.state = 'published' and x.published_at is not null and ${windowWhere('x.published_at')}`,
    window,
  );
  return rows.map((row) => ({
    runId: row.id,
    at: row.at.toISOString(),
    repoName: row.repo_name,
    repoFullName: row.repo_full_name,
    tag: row.tag,
    version: row.version,
    url: row.release_url,
    cutBy: row.requested_by_login,
  }));
}

export interface LiveTaskRow {
  id: string;
  bot: string | null;
  kind: string;
  skill: string | null;
  subjectRef: string;
  state: Extract<TaskState, 'queued' | 'running' | 'paused'>;
  /**
   * When it came into its state: a running one's start, or the newest answer
   * after its pause once it paused (`tasks.runningSince`), a paused one's
   * pause, a queued one's creation. Null for a running one that paused and
   * went on with no answer, whose resume nothing records.
   */
  since: string | null;
  costUsd: number;
  capUsd: number;
}

/** Every task queued, running or paused, oldest first. */
export async function liveTasks(): Promise<LiveTaskRow[]> {
  const rows = await query<{
    id: string;
    bot: string | null;
    kind: string;
    skill: string | null;
    subject_ref: string;
    state: LiveTaskRow['state'];
    since: Date | null;
    cost_usd: string;
    cost_cap_usd: string;
  }>(
    `select t.id, b.name as bot, t.kind, t.skill, t.subject_ref, t.state,
            case t.state
              when 'queued' then t.created_at
              when 'paused' then t.paused_at
              else case when t.paused_at is null then t.started_at
                        else (select max(g.answered_at) from gates g where g.task_id = t.id and g.answered_at > t.paused_at) end
            end as since,
            t.cost_usd, t.cost_cap_usd
     from tasks t left join bots b on b.id = t.bot_id
     where t.state in ('queued', 'running', 'paused')
     order by t.created_at, t.id`,
  );
  return rows.map((row) => ({
    id: row.id,
    bot: row.bot,
    kind: row.kind,
    skill: row.skill,
    subjectRef: row.subject_ref,
    state: row.state,
    since: row.since?.toISOString() ?? null,
    costUsd: Number(row.cost_usd),
    capUsd: Number(row.cost_cap_usd),
  }));
}
