import type { TaskState } from '@openadlc/shared';
import { query, queryOne } from '../client.js';

/**
 * What the board's event feed reads (`apps/bridge/src/board-events.ts`), each
 * from the table the event already happens in: nothing here writes, and no
 * writer has to remember to tell the feed. See
 * docs/adr/0021-board-events-are-read-from-the-tables-they-happen-in.md.
 *
 * Every read is "since a time", which the feed sets back ten seconds each
 * probe: a row written with `now()` in a transaction can commit after a probe
 * has moved past its timestamp.
 */

/** The database's clock, which every `since` below is compared with: the bridge's may differ. */
export async function dbNow(): Promise<Date> {
  const row = await queryOne<{ now: Date }>('select now() as now');
  return row?.now ?? new Date();
}

export interface StartedRow {
  taskId: string;
  at: string;
  bot: string | null;
  subjectRef: string;
  kind: string;
  skill: string | null;
}

/** Tasks that began running at or after `since`. A resume keeps its first `started_at`, so it is not a second start. */
export async function startedSince(since: Date): Promise<StartedRow[]> {
  const rows = await query<{ id: string; started_at: Date; bot: string | null; subject_ref: string; kind: string; skill: string | null }>(
    `select t.id, t.started_at, b.name as bot, t.subject_ref, t.kind, t.skill
     from tasks t left join bots b on b.id = t.bot_id
     where t.started_at >= $1
     order by t.started_at, t.id`,
    [since],
  );
  return rows.map((row) => ({ taskId: row.id, at: row.started_at.toISOString(), bot: row.bot, subjectRef: row.subject_ref, kind: row.kind, skill: row.skill }));
}

export interface AskedRow {
  gateId: string;
  at: string;
  bot: string | null;
  /** The task's subject, else its thread's; null for a gate on neither. */
  subjectRef: string | null;
  question: string;
}

/** Questions opened at or after `since`, with the seat that asked and what about. */
export async function askedSince(since: Date): Promise<AskedRow[]> {
  const rows = await query<{ id: string; created_at: Date; bot: string | null; subject_ref: string | null; question: string }>(
    `select g.id, g.created_at, coalesce(tb.name, hb.name) as bot,
            coalesce(t.subject_ref, h.subject_ref) as subject_ref, g.question
     from gates g
     left join tasks t on t.id = g.task_id
     left join bots tb on tb.id = t.bot_id
     left join threads h on h.id = g.thread_id
     left join bots hb on hb.id = h.bot_id
     where g.created_at >= $1
     order by g.created_at, g.id`,
    [since],
  );
  return rows.map((row) => ({ gateId: row.id, at: row.created_at.toISOString(), bot: row.bot, subjectRef: row.subject_ref, question: row.question }));
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
 * Merges recorded at or after `since`: a forward move into Merged, or into
 * Done from anywhere but Merged, since a repository that ships by merging
 * goes straight to Done and a later Merged → Done is the deploy. This is the
 * move `moveClosedByMerge` makes for every merge, whoever merged.
 *
 * An issue closed without merging moves forward into Done too, with a reason
 * starting `Abandoned: ` (`abandonMoveReason`, apps/bridge/src/abandoned.ts):
 * read as a merge, `watch` said abandoned work had merged.
 *
 * `moveClosedByMerge` records no pull request number and sets the issue's
 * after, so the issue's is the fallback.
 */
export async function mergedSince(since: Date): Promise<MergedRow[]> {
  const rows = await query<{ id: string; created_at: Date; repo_name: string; issue_number: number; pr_number: number | null; actor: string; bot: string | null }>(
    `select m.id, m.created_at, r.name as repo_name, m.issue_number,
            coalesce(m.pr_number, i.pr_number) as pr_number, m.actor, b.name as bot
     from stage_moves m
     join repos r on r.id = m.repo_id
     left join issues i on i.repo_id = m.repo_id and i.number = m.issue_number
     left join bots b on b.name = m.actor
     where m.created_at >= $1 and m.kind = 'forward'
       and (m.to_stage = 'merged' or (m.to_stage = 'done' and m.from_stage is distinct from 'merged'))
       and coalesce(m.reason, '') not like 'Abandoned: %'
     order by m.created_at, m.id`,
    [since],
  );
  return rows.map((row) => ({
    moveId: row.id,
    at: row.created_at.toISOString(),
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

/** Pull requests a person held from the console (`pull.held`) at or after `since`. */
export async function heldAuditSince(since: Date): Promise<HeldAuditRow[]> {
  const rows = await query<{ id: string; at: Date; actor: string; target: string; why: string | null }>(
    `select id::text as id, at, actor, target, payload->>'why' as why
     from audit
     where action = 'pull.held' and at >= $1
     order by at, id`,
    [since],
  );
  return rows.map((row) => ({ auditId: row.id, at: row.at.toISOString(), actor: row.actor, target: row.target, why: row.why }));
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
