import { query } from '../client.js';

/** One workflow run attempt's minutes; see `0036_ci_usage.sql`. */
export interface CiUsageRow {
  repoId: string;
  repoName: string;
  runId: number;
  runAttempt: number;
  workflow: string;
  event: string | null;
  headBranch: string | null;
  prNumber: number | null;
  conclusion: string | null;
  minutes: number;
  billed: boolean;
  completedAt: string;
}

/** Writes a run attempt's minutes; a redelivered event writes the same row again. */
export async function record(row: Omit<CiUsageRow, 'repoName'>): Promise<void> {
  await query(
    `insert into ci_usage (repo_id, run_id, run_attempt, workflow, event, head_branch, pr_number, conclusion, minutes, billed, completed_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (repo_id, run_id, run_attempt) do update set
       conclusion = excluded.conclusion, minutes = excluded.minutes, billed = excluded.billed, completed_at = excluded.completed_at`,
    [
      row.repoId,
      row.runId,
      row.runAttempt,
      row.workflow,
      row.event,
      row.headBranch,
      row.prNumber,
      row.conclusion,
      row.minutes,
      row.billed,
      row.completedAt,
    ],
  );
}

/** Every run attempt completed since `since`, with its repository's name. The counting is the bridge's. */
export async function listSince(since: Date): Promise<CiUsageRow[]> {
  const rows = await query<{
    repo_id: string;
    repo_name: string;
    run_id: string;
    run_attempt: number;
    workflow: string;
    event: string | null;
    head_branch: string | null;
    pr_number: number | null;
    conclusion: string | null;
    minutes: number;
    billed: boolean;
    completed_at: Date;
  }>(
    `select u.*, r.name as repo_name
       from ci_usage u join repos r on r.id = u.repo_id
      where u.completed_at >= $1
      order by u.completed_at`,
    [since],
  );
  return rows.map((row) => ({
    repoId: row.repo_id,
    repoName: row.repo_name,
    runId: Number(row.run_id),
    runAttempt: row.run_attempt,
    workflow: row.workflow,
    event: row.event,
    headBranch: row.head_branch,
    prNumber: row.pr_number,
    conclusion: row.conclusion,
    minutes: row.minutes,
    billed: row.billed,
    completedAt: row.completed_at.toISOString(),
  }));
}
