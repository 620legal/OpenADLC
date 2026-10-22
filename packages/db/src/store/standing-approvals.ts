import { query, queryOne } from '../client.js';

/**
 * A person's standing approval of one issue's plan changes for the rest of
 * its build: later requests from its builder are approved as they are asked,
 * except a path under Human review, which always asks a person. See
 * `migrations/0148_standing_plan_approvals.sql` and the bridge's
 * `plan-changes.ts`.
 */
export interface StandingApproval {
  id: string;
  repoId: string;
  issueNumber: number;
  setBy: string;
  setAt: string;
  /** The plan-change question it was turned on from, when it was. */
  gateId: string | null;
  endedAt: string | null;
  endedBy: string | null;
  endedWhy: string | null;
}

interface Row {
  id: string;
  repo_id: string;
  issue_number: number;
  set_by: string;
  set_at: Date;
  gate_id: string | null;
  ended_at: Date | null;
  ended_by: string | null;
  ended_why: string | null;
}

const COLUMNS = 'id, repo_id, issue_number, set_by, set_at, gate_id, ended_at, ended_by, ended_why';

function toApproval(row: Row): StandingApproval {
  return {
    id: row.id,
    repoId: row.repo_id,
    issueNumber: row.issue_number,
    setBy: row.set_by,
    setAt: row.set_at.toISOString(),
    gateId: row.gate_id,
    endedAt: row.ended_at?.toISOString() ?? null,
    endedBy: row.ended_by,
    endedWhy: row.ended_why,
  };
}

/** The standing approval on an issue, while it is on. */
export async function activeFor(repoId: string, issueNumber: number): Promise<StandingApproval | null> {
  const row = await queryOne<Row>(
    `select ${COLUMNS} from standing_plan_approvals where repo_id = $1 and issue_number = $2 and ended_at is null`,
    [repoId, issueNumber],
  );
  return row ? toApproval(row) : null;
}

/** Every standing approval that is on, oldest first: what the board and the cards read. */
export async function listActive(): Promise<StandingApproval[]> {
  const rows = await query<Row>(`select ${COLUMNS} from standing_plan_approvals where ended_at is null order by set_at`);
  return rows.map(toApproval);
}

/**
 * Turns one on, or answers the one already on: two people pressing it at
 * once leave one, by whoever was first, which is the one each is told about.
 */
export async function turnOn(input: { repoId: string; issueNumber: number; setBy: string; gateId?: string | null }): Promise<StandingApproval> {
  const row = await queryOne<Row>(
    `insert into standing_plan_approvals (repo_id, issue_number, set_by, gate_id)
     values ($1, $2, $3, $4)
     on conflict (repo_id, issue_number) where ended_at is null do nothing
     returning ${COLUMNS}`,
    [input.repoId, input.issueNumber, input.setBy, input.gateId ?? null],
  );
  if (row) return toApproval(row);
  const on = await activeFor(input.repoId, input.issueNumber);
  if (!on) throw new Error(`the standing approval on #${input.issueNumber} could not be turned on or read; try again`);
  return on;
}

/** Ends the one on, saying who and why; null when none was on. */
export async function turnOff(input: { repoId: string; issueNumber: number; by: string; why: string }): Promise<StandingApproval | null> {
  const row = await queryOne<Row>(
    `update standing_plan_approvals set ended_at = now(), ended_by = $3, ended_why = $4
      where repo_id = $1 and issue_number = $2 and ended_at is null
      returning ${COLUMNS}`,
    [input.repoId, input.issueNumber, input.by, input.why],
  );
  return row ? toApproval(row) : null;
}
