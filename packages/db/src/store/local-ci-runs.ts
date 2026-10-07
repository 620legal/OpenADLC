import { query, queryOne } from '../client.js';

/**
 * The repository's checks as hostd ran them on a task's exact head; see
 * `migrations/0032_local_ci_runs.sql`. Written by the bridge only, from what
 * hostd reported with the install's secret.
 */
export interface LocalCiRun {
  id: string;
  runId: string;
  taskId: string | null;
  repoId: string;
  branch: string | null;
  headSha: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number | null;
  logTail: string | null;
  createdAt: string;
}

interface Row {
  id: string;
  run_id: string;
  task_id: string | null;
  repo_id: string;
  branch: string | null;
  head_sha: string;
  ok: boolean;
  exit_code: number | null;
  duration_ms: number | null;
  log_tail: string | null;
  created_at: Date;
}

function toRun(row: Row): LocalCiRun {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    repoId: row.repo_id,
    branch: row.branch,
    headSha: row.head_sha,
    ok: row.ok,
    exitCode: row.exit_code,
    durationMs: row.duration_ms,
    logTail: row.log_tail,
    createdAt: row.created_at.toISOString(),
  };
}

/** Records a run hostd finished; the same run reported again changes nothing. */
export async function record(input: {
  runId: string;
  taskId: string | null;
  repoId: string;
  branch: string | null;
  headSha: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number | null;
  logTail: string | null;
}): Promise<LocalCiRun | null> {
  const row = await queryOne<Row>(
    `insert into local_ci_runs (run_id, task_id, repo_id, branch, head_sha, ok, exit_code, duration_ms, log_tail)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (run_id) do nothing
     returning *`,
    [input.runId, input.taskId, input.repoId, input.branch, input.headSha, input.ok, input.exitCode, input.durationMs, input.logTail],
  );
  return row ? toRun(row) : null;
}

/**
 * The newest run on a commit in a repository, passed or not, or null. A
 * commit is its content, so a pass on it by any task holds for every task.
 */
export async function latestFor(repoId: string, headSha: string): Promise<LocalCiRun | null> {
  const row = await queryOne<Row>(
    `select * from local_ci_runs where repo_id = $1 and head_sha = $2 order by created_at desc, id desc limit 1`,
    [repoId, headSha],
  );
  return row ? toRun(row) : null;
}

/** A pass on a commit in a repository, or null when none was recorded. */
export async function passFor(repoId: string, headSha: string): Promise<LocalCiRun | null> {
  const row = await queryOne<Row>(
    `select * from local_ci_runs where repo_id = $1 and head_sha = $2 and ok order by created_at desc, id desc limit 1`,
    [repoId, headSha],
  );
  return row ? toRun(row) : null;
}
