import { query, queryOne } from '../client.js';
import { keptReason, keptTail } from './host-check-runs.js';

/**
 * A release build hostd ran of one pinned commit in the release account; see
 * `migrations/0169_release_runs.sql` and
 * docs/adr/0070-a-release-recipe-is-an-admins-and-its-artifact-stays-with-hostd.md.
 *
 * Only the bridge writes it (`release-service.ts`): `start` when it asks hostd
 * for a run, `finish` from hostd's report with the install's secret. The
 * version, sha256, bytes and artifact name are hostd's, never the account's.
 * One row per repository may be in flight (`running`, `built` or
 * `publishing`); the database holds that with a partial unique index, so two
 * starts at once cannot both build, and two cuts cannot race for one tag.
 *
 * After `built`, the publish (#344, `release-publish.ts`,
 * docs/adr/0071-a-release-is-tagged-and-published-as-the-app-only-after-it-is-signed.md)
 * moves it with conditional updates on the state each step expects, so a
 * second publisher of the same run changes nothing: `toPublishing`,
 * `setReleaseId`, `markTagged`, then `published` or `publishFailed`.
 */
export type ReleaseRunState = 'running' | 'built' | 'failed' | 'cancelled' | 'refused' | 'lost' | 'publishing' | 'published' | 'publish_failed';

export const RELEASE_RUN_STATES: readonly ReleaseRunState[] = ['running', 'built', 'failed', 'cancelled', 'refused', 'lost', 'publishing', 'published', 'publish_failed'];

/**
 * The states a release is in flight in: building, built and waiting to be
 * published, or publishing. One per repository (`release_runs_one_in_flight`,
 * migration 0170), so two cuts cannot race for one tag, and the host is held
 * awake through each (`in-flight.ts`).
 */
export const RELEASE_IN_FLIGHT: readonly ReleaseRunState[] = ['running', 'built', 'publishing'];

export interface ReleaseRun {
  id: string;
  runId: string;
  repoId: string;
  repoName: string;
  repoFullName: string;
  /** The pinned commit. */
  sha: string;
  clean: boolean;
  command: string;
  artifact: string;
  versionFile: string;
  versionKey: string | null;
  releaseRepo: string | null;
  timeoutMinutes: number;
  previousVersion: string | null;
  state: ReleaseRunState;
  version: string | null;
  sha256: string | null;
  bytes: number | null;
  artifactName: string | null;
  exitCode: number | null;
  durationMs: number | null;
  logTail: string | null;
  reason: string | null;
  requestedByLogin: string;
  requestedById: number;
  startedAt: string;
  finishedAt: string | null;
  /** `v<version>`, set when publishing starts (#344, docs/adr/0071). */
  tag: string | null;
  /** The GitHub release's id, draft or published. */
  releaseId: number | null;
  /** The published release's page. */
  releaseUrl: string | null;
  /** The artifact's download URL: the one the manifest signs. */
  assetUrl: string | null;
  /** Whether the tag was made, or found, on the pinned commit. */
  tagged: boolean;
  publishedAt: string | null;
}

interface Row {
  id: string;
  run_id: string;
  repo_id: string;
  repo_name: string;
  repo_full_name: string;
  sha: string;
  clean: boolean;
  command: string;
  artifact: string;
  version_file: string;
  version_key: string | null;
  release_repo: string | null;
  timeout_minutes: number;
  previous_version: string | null;
  state: ReleaseRunState;
  version: string | null;
  sha256: string | null;
  bytes: string | number | null;
  artifact_name: string | null;
  exit_code: number | null;
  duration_ms: string | number | null;
  log_tail: string | null;
  reason: string | null;
  requested_by_login: string;
  requested_by_id: string | number;
  started_at: Date;
  finished_at: Date | null;
  tag?: string | null;
  release_id?: string | number | null;
  release_url?: string | null;
  asset_url?: string | null;
  tagged?: boolean | null;
  published_at?: Date | null;
}

const COLUMNS = `x.id, x.run_id, x.repo_id, r.name as repo_name, r.full_name as repo_full_name, x.sha, x.clean, x.command, x.artifact,
  x.version_file, x.version_key, x.release_repo, x.timeout_minutes, x.previous_version, x.state, x.version, x.sha256, x.bytes,
  x.artifact_name, x.exit_code, x.duration_ms, x.log_tail, x.reason, x.requested_by_login, x.requested_by_id, x.started_at, x.finished_at,
  x.tag, x.release_id, x.release_url, x.asset_url, x.tagged, x.published_at`;
const FROM = 'release_runs x join repos r on r.id = x.repo_id';

// `bigint` comes back as a string.
const num = (value: string | number | null): number | null => (value === null ? null : Number(value));

function toRun(row: Row): ReleaseRun {
  return {
    id: row.id,
    runId: row.run_id,
    repoId: row.repo_id,
    repoName: row.repo_name,
    repoFullName: row.repo_full_name,
    sha: row.sha,
    clean: row.clean,
    command: row.command,
    artifact: row.artifact,
    versionFile: row.version_file,
    versionKey: row.version_key,
    releaseRepo: row.release_repo,
    timeoutMinutes: row.timeout_minutes,
    previousVersion: row.previous_version,
    state: row.state,
    version: row.version,
    sha256: row.sha256,
    bytes: num(row.bytes),
    artifactName: row.artifact_name,
    exitCode: row.exit_code,
    durationMs: num(row.duration_ms),
    logTail: row.log_tail,
    reason: row.reason,
    requestedByLogin: row.requested_by_login,
    requestedById: Number(row.requested_by_id),
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
    tag: row.tag ?? null,
    releaseId: num(row.release_id ?? null),
    releaseUrl: row.release_url ?? null,
    assetUrl: row.asset_url ?? null,
    tagged: row.tagged === true,
    publishedAt: row.published_at ? row.published_at.toISOString() : null,
  };
}

/** A reason as stored: redacted and capped (`keptReason`, the host check's), or null. */
function storedReason(reason: string | null | undefined): string | null {
  return reason === undefined || reason === null ? null : keptReason(reason);
}

/** A log tail as stored: redacted and the last 64 KB (`keptTail`), or null. */
function storedTail(tail: string | null | undefined): string | null {
  return tail === undefined || tail === null ? null : keptTail(tail);
}

/** A second release in flight for a repository, which the partial unique index refused. */
export class ReleaseAlreadyRunning extends Error {
  constructor(readonly repoId: string) {
    super('a release of this repository is building or publishing already; wait for it to end, or cancel it');
  }
}

/**
 * Records a run the bridge is about to ask hostd for; the same `runId` again
 * answers the row already there. A run that never reached hostd starts
 * finished: `refused`, with its reason. A second `running` row for the same
 * repository throws `ReleaseAlreadyRunning`.
 */
export async function start(input: {
  runId: string;
  repoId: string;
  sha: string;
  clean: boolean;
  command: string;
  artifact: string;
  versionFile: string;
  versionKey: string | null;
  releaseRepo: string | null;
  timeoutMinutes: number;
  previousVersion: string | null;
  requestedByLogin: string;
  requestedById: number;
  state?: 'running' | 'refused';
  reason?: string | null;
  logTail?: string | null;
}): Promise<ReleaseRun> {
  const state = input.state ?? 'running';
  try {
    await query(
      `insert into release_runs (run_id, repo_id, sha, clean, command, artifact, version_file, version_key, release_repo, timeout_minutes,
         previous_version, state, reason, log_tail, requested_by_login, requested_by_id, finished_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, case when $12 = 'running' then null else now() end)
       on conflict (run_id) do nothing`,
      [
        input.runId,
        input.repoId,
        input.sha,
        input.clean,
        input.command,
        input.artifact,
        input.versionFile,
        input.versionKey,
        input.releaseRepo,
        input.timeoutMinutes,
        input.previousVersion,
        state,
        storedReason(input.reason),
        storedTail(input.logTail),
        input.requestedByLogin,
        input.requestedById,
      ],
    );
  } catch (error) {
    if ((error as { code?: string }).code === '23505' && /release_runs_one_(running|in_flight)/.test(String((error as { constraint?: string }).constraint ?? (error as Error).message))) {
      throw new ReleaseAlreadyRunning(input.repoId);
    }
    throw error;
  }
  const row = await byRunId(input.runId);
  if (!row) throw new Error(`the release run ${input.runId} could not be recorded or read; try again`);
  return row;
}

/**
 * Ends a run with what hostd reported, or what the bridge decided. Only a
 * `running` row moves: a report sent twice, or one for a run the sweep
 * already called lost, changes nothing, and null says so.
 */
export async function finish(
  runId: string,
  outcome: {
    state: Exclude<ReleaseRunState, 'running'>;
    version?: string | null;
    sha256?: string | null;
    bytes?: number | null;
    artifactName?: string | null;
    exitCode?: number | null;
    durationMs?: number | null;
    logTail?: string | null;
    reason?: string | null;
  },
): Promise<ReleaseRun | null> {
  const row = await queryOne<{ id: string }>(
    `update release_runs set
       state = $2, version = $3, sha256 = $4, bytes = $5, artifact_name = $6, exit_code = $7, duration_ms = $8,
       log_tail = $9, reason = $10, finished_at = now()
     where run_id = $1 and state = 'running'
     returning id`,
    [
      runId,
      outcome.state,
      outcome.version ?? null,
      outcome.sha256 ?? null,
      outcome.bytes ?? null,
      outcome.artifactName ?? null,
      outcome.exitCode ?? null,
      outcome.durationMs ?? null,
      storedTail(outcome.logTail),
      storedReason(outcome.reason),
    ],
  );
  return row ? get(row.id) : null;
}

export async function get(id: string): Promise<ReleaseRun | null> {
  // An id that is no uuid is no row, rather than Postgres' error.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const row = await queryOne<Row>(`select ${COLUMNS} from ${FROM} where x.id = $1`, [id]);
  return row ? toRun(row) : null;
}

export async function byRunId(runId: string): Promise<ReleaseRun | null> {
  const row = await queryOne<Row>(`select ${COLUMNS} from ${FROM} where x.run_id = $1`, [runId]);
  return row ? toRun(row) : null;
}

/** A repository's runs, newest first. */
export async function forRepo(repoId: string, limit = 50): Promise<ReleaseRun[]> {
  const rows = await query<Row>(`select ${COLUMNS} from ${FROM} where x.repo_id = $1 order by x.started_at desc, x.id desc limit $2`, [repoId, limit]);
  return rows.map(toRun);
}

/** Every run still `running`, oldest first: what the sweep checks against hostd. */
export async function running(): Promise<ReleaseRun[]> {
  const rows = await query<Row>(`select ${COLUMNS} from ${FROM} where x.state = 'running' order by x.started_at, x.id`);
  return rows.map(toRun);
}

/** Whether a repository has a run `running`. */
export async function anyRunning(repoId: string): Promise<boolean> {
  const row = await queryOne<{ any: boolean }>(`select exists (select 1 from release_runs where repo_id = $1 and state = 'running') as any`, [repoId]);
  return Boolean(row?.any);
}

/**
 * Whether a repository has a release in flight: building, built and not yet
 * published, or publishing. A second cut waits for it to end.
 */
export async function anyInFlight(repoId: string): Promise<boolean> {
  const row = await queryOne<{ any: boolean }>(`select exists (select 1 from release_runs where repo_id = $1 and state = any($2::text[])) as any`, [
    repoId,
    [...RELEASE_IN_FLIGHT],
  ]);
  return Boolean(row?.any);
}

// ---------------------------------------------------------------------------
// Publishing (#344). Each moves only from the state it expects and answers the
// row it changed, or null when it changed nothing: another publisher got there
// first, or the row had already ended.
// ---------------------------------------------------------------------------

async function moved(sql: string, params: unknown[]): Promise<ReleaseRun | null> {
  const row = await queryOne<{ id: string }>(sql, params);
  return row ? get(row.id) : null;
}

/** `built` → `publishing`, with the tag it will take. */
export async function toPublishing(runId: string, tag: string): Promise<ReleaseRun | null> {
  return moved(`update release_runs set state = 'publishing', tag = $2, reason = null where run_id = $1 and state = 'built' returning id`, [runId, tag]);
}

/** The draft's id, while publishing, so a failure can delete it. */
export async function setReleaseId(runId: string, releaseId: number): Promise<ReleaseRun | null> {
  return moved(`update release_runs set release_id = $2 where run_id = $1 and state = 'publishing' returning id`, [runId, releaseId]);
}

/** The tag is on the pinned commit, while publishing. */
export async function markTagged(runId: string): Promise<ReleaseRun | null> {
  return moved(`update release_runs set tagged = true where run_id = $1 and state = 'publishing' returning id`, [runId]);
}

/** `publishing` → `published`, with its page and the signed asset's URL. */
export async function published(runId: string, input: { releaseUrl: string; assetUrl: string }): Promise<ReleaseRun | null> {
  return moved(
    `update release_runs set state = 'published', release_url = $2, asset_url = $3, published_at = now(), reason = null
     where run_id = $1 and state = 'publishing' returning id`,
    [runId, input.releaseUrl, input.assetUrl],
  );
}

/**
 * `built` or `publishing` → `publish_failed`, with a reason that says what
 * was left — a draft, a tag, a public release — and what to do. It is
 * redacted and capped, as every reason is.
 */
export async function publishFailed(runId: string, reason: string): Promise<ReleaseRun | null> {
  return moved(`update release_runs set state = 'publish_failed', reason = $2 where run_id = $1 and state in ('built', 'publishing') returning id`, [
    runId,
    storedReason(reason),
  ]);
}

/** `built` rows that no publisher in this bridge holds (`held`), oldest first: the sweep publishes them. */
export async function builtUnheld(held: readonly string[] = []): Promise<ReleaseRun[]> {
  const rows = await query<Row>(`select ${COLUMNS} from ${FROM} where x.state = 'built' and not (x.run_id = any($1::text[])) order by x.started_at, x.id`, [[...held]]);
  return rows.map(toRun);
}

/** `publishing` rows that no publisher in this bridge holds, as after a restart: the sweep cleans them up and fails them. */
export async function publishingUnheld(held: readonly string[] = []): Promise<ReleaseRun[]> {
  const rows = await query<Row>(`select ${COLUMNS} from ${FROM} where x.state = 'publishing' and not (x.run_id = any($1::text[])) order by x.started_at, x.id`, [[...held]]);
  return rows.map(toRun);
}
