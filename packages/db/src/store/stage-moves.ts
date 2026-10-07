import type { StageKey } from '@fleetadlc/shared';
import { query, queryOne } from '../client.js';

/**
 * An issue's stage moves, as `migrations/0031_stage_moves.sql` keeps them:
 * where a send-back goes is worked out from them (`previousStage`), and the
 * send-back limits count them.
 */
export type StageMoveKind = 'forward' | 'send_back' | 'person';

export interface StageMove {
  id: string;
  repoId: string;
  issueNumber: number;
  prNumber: number | null;
  from: StageKey | null;
  to: StageKey;
  kind: StageMoveKind;
  actor: string;
  taskId: string | null;
  reason: string | null;
  commentUrl: string | null;
  createdAt: string;
}

interface Row {
  id: string;
  repo_id: string;
  issue_number: number;
  pr_number: number | null;
  from_stage: StageKey | null;
  to_stage: StageKey;
  kind: StageMoveKind;
  actor: string;
  task_id: string | null;
  reason: string | null;
  comment_url: string | null;
  created_at: Date;
}

function toMove(row: Row): StageMove {
  return {
    id: row.id,
    repoId: row.repo_id,
    issueNumber: row.issue_number,
    prNumber: row.pr_number,
    from: row.from_stage,
    to: row.to_stage,
    kind: row.kind,
    actor: row.actor,
    taskId: row.task_id,
    reason: row.reason,
    commentUrl: row.comment_url,
    createdAt: row.created_at.toISOString(),
  };
}

export async function record(input: {
  repoId: string;
  issueNumber: number;
  prNumber?: number | null;
  from: StageKey | null;
  to: StageKey;
  kind: StageMoveKind;
  actor: string;
  taskId?: string | null;
  reason?: string | null;
  commentUrl?: string | null;
}): Promise<StageMove> {
  const row = await queryOne<Row>(
    `insert into stage_moves (repo_id, issue_number, pr_number, from_stage, to_stage, kind, actor, task_id, reason, comment_url)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning *`,
    [
      input.repoId,
      input.issueNumber,
      input.prNumber ?? null,
      input.from,
      input.to,
      input.kind,
      input.actor,
      input.taskId ?? null,
      input.reason ?? null,
      input.commentUrl ?? null,
    ],
  );
  if (!row) throw new Error(`could not record the move of issue #${input.issueNumber} to ${input.to}`);
  return toMove(row);
}

/** An issue's moves, oldest first. */
export async function listForIssue(repoId: string, issueNumber: number): Promise<StageMove[]> {
  const rows = await query<Row>(
    `select * from stage_moves where repo_id = $1 and issue_number = $2 order by created_at, id`,
    [repoId, issueNumber],
  );
  return rows.map(toMove);
}

/** The send-back a task made, if it made one: how its end is told from finishing its stage. */
export async function sendBackOfTask(taskId: string): Promise<StageMove | null> {
  const row = await queryOne<Row>(
    `select * from stage_moves where task_id = $1 and kind = 'send_back' order by created_at desc limit 1`,
    [taskId],
  );
  return row ? toMove(row) : null;
}

/** How many times each issue was sent back, by `repoId#number`, for the board's "sent back ×N". */
export async function sendBackCounts(repoId?: string): Promise<Map<string, number>> {
  const rows = await query<{ repo_id: string; issue_number: number; count: string }>(
    `select repo_id, issue_number, count(*) as count from stage_moves
     where kind = 'send_back' and ($1::uuid is null or repo_id = $1)
     group by repo_id, issue_number`,
    [repoId ?? null],
  );
  return new Map(rows.map((row) => [`${row.repo_id}#${row.issue_number}`, Number(row.count)]));
}
