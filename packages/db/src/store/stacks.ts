import { query, queryOne } from '../client.js';

/**
 * Which issue a stacked issue was built on; see `migrations/0077_stacks.sql`
 * and `apps/bridge/src/stacking.ts`. One row per stacked issue, kept for as
 * long as the issue is, with no window: a dependency can be in review for
 * months, and the stacked pull request waits for it all that time.
 */
export interface Stack {
  repoId: string;
  issue: number;
  onIssue: number;
  onPr: number;
  onBranch: string;
  /** The dependency's head when the stacked build started; null for a stack recorded before the table. */
  onHeadSha: string | null;
  startedAt: string;
  /** When it was held because what it was built on changed; null while it is not. */
  pausedAt: string | null;
}

interface Row {
  repo_id: string;
  issue_number: number;
  on_issue: number;
  on_pr: number;
  on_branch: string;
  on_head_sha: string | null;
  started_at: Date;
  paused_at: Date | null;
}

function toStack(row: Row): Stack {
  return {
    repoId: row.repo_id,
    issue: row.issue_number,
    onIssue: row.on_issue,
    onPr: row.on_pr,
    onBranch: row.on_branch,
    onHeadSha: row.on_head_sha,
    startedAt: row.started_at.toISOString(),
    pausedAt: row.paused_at ? row.paused_at.toISOString() : null,
  };
}

/** Records a stacked build about to start; a stack the issue had before is replaced, held or not. */
export async function recordStack(input: {
  repoId: string;
  issue: number;
  onIssue: number;
  onPr: number;
  onBranch: string;
  onHeadSha: string | null;
}): Promise<Stack> {
  const row = await queryOne<Row>(
    `insert into stacks (repo_id, issue_number, on_issue, on_pr, on_branch, on_head_sha)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (repo_id, issue_number) do update set
       on_issue = excluded.on_issue, on_pr = excluded.on_pr, on_branch = excluded.on_branch,
       on_head_sha = excluded.on_head_sha, started_at = now(), paused_at = null
     returning *`,
    [input.repoId, input.issue, input.onIssue, input.onPr, input.onBranch, input.onHeadSha],
  );
  if (!row) throw new Error(`could not record that #${input.issue} is stacked on #${input.onIssue}`);
  return toStack(row);
}

/** The stack an issue was built on, or null when it was not stacked. */
export async function stackOf(repoId: string, issue: number): Promise<Stack | null> {
  const row = await queryOne<Row>('select * from stacks where repo_id = $1 and issue_number = $2', [repoId, issue]);
  return row ? toStack(row) : null;
}

/** Forgets a stack whose build did not start. */
export async function removeStack(repoId: string, issue: number): Promise<void> {
  await query('delete from stacks where repo_id = $1 and issue_number = $2', [repoId, issue]);
}

/** Every stack in a repository, oldest first. */
export async function listStacks(repoId: string): Promise<Stack[]> {
  const rows = await query<Row>('select * from stacks where repo_id = $1 order by started_at', [repoId]);
  return rows.map(toStack);
}

/** Marks a stack held: what it was built on changed, and a person decides. Held once per stacking. */
export async function markPaused(repoId: string, issue: number): Promise<void> {
  await query('update stacks set paused_at = now() where repo_id = $1 and issue_number = $2 and paused_at is null', [repoId, issue]);
}
