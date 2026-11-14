import { redactSecrets } from '@openadlc/shared';
import { query, queryOne } from '../client.js';
import { withoutNul } from './local-ci-runs.js';

/**
 * A repository's host check as hostd ran it on one head of a pull request;
 * see `migrations/0168_host_check_runs.sql` and
 * docs/adr/0064-a-host-check-runs-as-its-own-account-and-the-merge-reads-the-bridges-record.md.
 *
 * Only the bridge writes it: `start` when it asks hostd for a run, `finish`
 * from hostd's report with the install's secret. The merge reads this, never
 * the `host-check` commit status, which any crew token could set.
 */
export type HostCheckState = 'running' | 'passed' | 'failed' | 'cancelled' | 'refused' | 'lost' | 'carried';

export const HOST_CHECK_STATES: readonly HostCheckState[] = ['running', 'passed', 'failed', 'cancelled', 'refused', 'lost', 'carried'];

/** The end of what the command printed that is kept. */
export const HOST_CHECK_LOG_TAIL_BYTES = 64_000;

export interface HostCheckRun {
  id: string;
  runId: string;
  repoId: string;
  /** The repository's short name. */
  repoName: string;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  state: HostCheckState;
  /** For `carried`: the head whose pass it is. */
  carriedFrom: string | null;
  command: string;
  timeoutMinutes: number;
  exitCode: number | null;
  durationMs: number | null;
  logTail: string | null;
  reason: string | null;
  startedAt: string;
  finishedAt: string | null;
}

interface Row {
  id: string;
  run_id: string;
  repo_id: string;
  repo_name: string;
  repo_full_name: string;
  pr_number: number;
  head_sha: string;
  state: HostCheckState;
  carried_from: string | null;
  command: string;
  timeout_minutes: number;
  exit_code: number | null;
  duration_ms: string | number | null;
  log_tail: string | null;
  reason: string | null;
  started_at: Date;
  finished_at: Date | null;
}

const COLUMNS = `h.id, h.run_id, h.repo_id, r.name as repo_name, r.full_name as repo_full_name, h.pr_number, h.head_sha, h.state,
  h.carried_from, h.command, h.timeout_minutes, h.exit_code, h.duration_ms, h.log_tail, h.reason, h.started_at, h.finished_at`;
const FROM = 'host_check_runs h join repos r on r.id = h.repo_id';

function toRun(row: Row): HostCheckRun {
  return {
    id: row.id,
    runId: row.run_id,
    repoId: row.repo_id,
    repoName: row.repo_name,
    repoFullName: row.repo_full_name,
    prNumber: row.pr_number,
    headSha: row.head_sha,
    state: row.state,
    carriedFrom: row.carried_from ?? null,
    command: row.command,
    timeoutMinutes: row.timeout_minutes,
    exitCode: row.exit_code,
    // `bigint` comes back as a string.
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    logTail: row.log_tail,
    reason: row.reason,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
  };
}

/**
 * A log tail as it may be kept and shown: the last `HOST_CHECK_LOG_TAIL_BYTES`,
 * without NUL, which Postgres refuses in `text`, and with anything shaped like
 * a credential masked. The account holds none, but a build can print one it
 * found on the machine, and the tail is shown on a card and a page.
 */
export function keptTail(text: string): string {
  return redactSecrets(withoutNul(text)).slice(-HOST_CHECK_LOG_TAIL_BYTES);
}

/** Records a run the bridge asked hostd for; the same `runId` again answers the row already there. */
export async function start(input: {
  runId: string;
  repoId: string;
  prNumber: number;
  headSha: string;
  command: string;
  timeoutMinutes: number;
  /** A run that never reached hostd starts finished: `refused`, with its reason. */
  state?: 'running' | 'refused';
  reason?: string | null;
}): Promise<HostCheckRun> {
  const state = input.state ?? 'running';
  await query(
    `insert into host_check_runs (run_id, repo_id, pr_number, head_sha, state, command, timeout_minutes, reason, finished_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, case when $5 = 'running' then null else now() end)
     on conflict (run_id) do nothing`,
    [input.runId, input.repoId, input.prNumber, input.headSha, state, input.command, input.timeoutMinutes, input.reason ?? null],
  );
  const row = await byRunId(input.runId);
  if (!row) throw new Error(`the host check run ${input.runId} could not be recorded or read; try again`);
  return row;
}

/**
 * Says that a pass on `from` holds for `head`, whose diff against the base is
 * the same: no run, so `passesFor` never answers it, and the merge decides
 * the same carry itself. Once per head.
 */
export async function carry(input: { repoId: string; prNumber: number; headSha: string; from: string; command: string; timeoutMinutes: number }): Promise<HostCheckRun> {
  const runId = `carried:${input.repoId}:${input.prNumber}:${input.headSha}`;
  await query(
    `insert into host_check_runs (run_id, repo_id, pr_number, head_sha, state, carried_from, command, timeout_minutes, finished_at)
     values ($1, $2, $3, $4, 'carried', $5, $6, $7, now())
     on conflict (run_id) do nothing`,
    [runId, input.repoId, input.prNumber, input.headSha, input.from, input.command, input.timeoutMinutes],
  );
  const row = await byRunId(runId);
  if (!row) throw new Error(`the carried pass on ${input.headSha.slice(0, 7)} could not be recorded or read; try again`);
  return row;
}

/**
 * Ends a run with what hostd reported. Only a `running` row moves: a report
 * sent twice, or one for a run the sweep already called lost, changes
 * nothing, and null says so.
 */
export async function finish(
  runId: string,
  outcome: {
    state: Exclude<HostCheckState, 'running'>;
    exitCode?: number | null;
    durationMs?: number | null;
    logTail?: string | null;
    reason?: string | null;
  },
): Promise<HostCheckRun | null> {
  const row = await queryOne<{ id: string }>(
    `update host_check_runs set
       state = $2, exit_code = $3, duration_ms = $4, log_tail = $5, reason = $6, finished_at = now()
     where run_id = $1 and state = 'running'
     returning id`,
    [
      runId,
      outcome.state,
      outcome.exitCode ?? null,
      outcome.durationMs ?? null,
      outcome.logTail === undefined || outcome.logTail === null ? null : keptTail(outcome.logTail),
      outcome.reason ?? null,
    ],
  );
  return row ? byId(row.id) : null;
}

/** The newest run on a pull request, whatever its head, or null. */
export async function latestFor(repoId: string, prNumber: number): Promise<HostCheckRun | null> {
  const row = await queryOne<Row>(`select ${COLUMNS} from ${FROM} where h.repo_id = $1 and h.pr_number = $2 order by h.started_at desc, h.id desc limit 1`, [
    repoId,
    prNumber,
  ]);
  return row ? toRun(row) : null;
}

/** Every run on a pull request, newest first. */
export async function forPull(repoId: string, prNumber: number): Promise<HostCheckRun[]> {
  const rows = await query<Row>(`select ${COLUMNS} from ${FROM} where h.repo_id = $1 and h.pr_number = $2 order by h.started_at desc, h.id desc`, [repoId, prNumber]);
  return rows.map(toRun);
}

/** The heads of a pull request a run passed on, newest first, each once: what the merge reads. */
export async function passesFor(repoId: string, prNumber: number): Promise<string[]> {
  const rows = await query<{ head_sha: string }>(
    `select head_sha from host_check_runs where repo_id = $1 and pr_number = $2 and state = 'passed'
     group by head_sha order by max(finished_at) desc nulls last`,
    [repoId, prNumber],
  );
  return rows.map((row) => row.head_sha);
}

export async function byId(id: string): Promise<HostCheckRun | null> {
  // An id that is no uuid is no row, rather than Postgres' error.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const row = await queryOne<Row>(`select ${COLUMNS} from ${FROM} where h.id = $1`, [id]);
  return row ? toRun(row) : null;
}

export async function byRunId(runId: string): Promise<HostCheckRun | null> {
  const row = await queryOne<Row>(`select ${COLUMNS} from ${FROM} where h.run_id = $1`, [runId]);
  return row ? toRun(row) : null;
}

/** Every run still `running`, oldest first: what the sweep checks against hostd. */
export async function running(): Promise<HostCheckRun[]> {
  const rows = await query<Row>(`select ${COLUMNS} from ${FROM} where h.state = 'running' order by h.started_at, h.id`);
  return rows.map(toRun);
}
