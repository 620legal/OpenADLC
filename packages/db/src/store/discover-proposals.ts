import { query, queryOne, withTransaction } from '../client.js';

/**
 * Discover runs and the proposals each stored; see
 * `migrations/0173_discover_runs.sql` and
 * docs/adr/0089-a-discover-run-is-an-intake-task-whose-proposals-hostd-checks-against-its-snapshot.md.
 *
 * Only the bridge writes it (`apps/bridge/src/discover.ts`): `startRun` when
 * a person starts one, `attachTask` once its intake task exists, `record` from
 * the proposals hostd posted for the task, `finish` when the task ends. A run
 * records its result once: a second report, or one for a run that has ended,
 * changes nothing.
 */

export type DiscoverRunState = 'running' | 'done' | 'failed';

export interface DiscoverRun {
  id: string;
  repoId: string;
  taskId: string | null;
  lenses: string[];
  state: DiscoverRunState;
  commit: string | null;
  proposalCount: number;
  droppedCount: number;
  note: string | null;
  reason: string | null;
  startedBy: string;
  createdAt: string;
  endedAt: string | null;
}

export interface StoredProposal {
  id: string;
  runId: string;
  repoId: string;
  lens: string;
  key: string;
  fingerprint: string;
  title: string;
  description: string;
  status: string;
  evidence: { file: string; line: number }[];
  createdAt: string;
}

/** A proposal as the bridge records it: checked, with its fingerprint. */
export interface ProposalInput {
  lens: string;
  key: string;
  fingerprint: string;
  title: string;
  description: string;
  status: string;
  evidence: { file: string; line: number }[];
}

interface RunRow {
  id: string;
  repo_id: string;
  task_id: string | null;
  lenses: string[];
  state: DiscoverRunState;
  commit_sha: string | null;
  proposal_count: number;
  dropped_count: number;
  note: string | null;
  reason: string | null;
  started_by: string;
  created_at: Date;
  ended_at: Date | null;
}

interface ProposalRow {
  id: string;
  run_id: string;
  repo_id: string;
  lens: string;
  key: string;
  fingerprint: string;
  title: string;
  description: string;
  status: string;
  evidence: { file: string; line: number }[];
  created_at: Date;
}

const RUN_COLUMNS = `id, repo_id, task_id, lenses, state, commit_sha, proposal_count, dropped_count, note, reason, started_by, created_at, ended_at`;
const PROPOSAL_COLUMNS = `id, run_id, repo_id, lens, key, fingerprint, title, description, status, evidence, created_at`;

/** How long a reason or a note is kept; what the bridge stores is said in a thread and on a page. */
const TEXT_CHARS = 1000;
const kept = (text: string | null | undefined): string | null => (text ? text.replaceAll('\u0000', '').slice(0, TEXT_CHARS) : null);

function toRun(row: RunRow): DiscoverRun {
  return {
    id: row.id,
    repoId: row.repo_id,
    taskId: row.task_id,
    lenses: row.lenses,
    state: row.state,
    commit: row.commit_sha,
    proposalCount: row.proposal_count,
    droppedCount: row.dropped_count,
    note: row.note,
    reason: row.reason,
    startedBy: row.started_by,
    createdAt: row.created_at.toISOString(),
    endedAt: row.ended_at ? row.ended_at.toISOString() : null,
  };
}

function toProposal(row: ProposalRow): StoredProposal {
  return {
    id: row.id,
    runId: row.run_id,
    repoId: row.repo_id,
    lens: row.lens,
    key: row.key,
    fingerprint: row.fingerprint,
    title: row.title,
    description: row.description,
    status: row.status,
    evidence: row.evidence,
    createdAt: row.created_at.toISOString(),
  };
}

/** Whether an insert was refused by the one-live-run index. */
function secondRunning(error: unknown): boolean {
  const failure = error as { code?: string; constraint?: string; message?: string } | null;
  return failure?.code === '23505' && /discover_runs_one_running/.test(String(failure.constraint ?? failure.message ?? ''));
}

/** The repository's live run, if it has one. */
export async function runningRun(repoId: string): Promise<DiscoverRun | null> {
  const row = await queryOne<RunRow>(`select ${RUN_COLUMNS} from discover_runs where repo_id = $1 and state = 'running'`, [repoId]);
  return row ? toRun(row) : null;
}

/**
 * A new run, `running`, or the live run the repository already has: one per
 * repository, which the partial index holds even for two starts at once.
 */
export async function startRun(input: { repoId: string; lenses: string[]; startedBy: string }): Promise<{ run: DiscoverRun } | { conflict: DiscoverRun }> {
  try {
    const row = await queryOne<RunRow>(
      `insert into discover_runs (repo_id, lenses, state, started_by) values ($1, $2, 'running', $3) returning ${RUN_COLUMNS}`,
      [input.repoId, input.lenses, input.startedBy],
    );
    if (!row) throw new Error('the Discover run could not be recorded; try again');
    return { run: toRun(row) };
  } catch (error) {
    if (!secondRunning(error)) throw error;
    const live = await runningRun(input.repoId);
    if (!live) throw new Error('a Discover run was already running on this repository and has just ended; start it again');
    return { conflict: live };
  }
}

/**
 * A run that ended before it started: a repository whose default branch has
 * no commit, which has nothing to read. Written `done` with no task and its
 * note, as one row.
 */
export async function recordEmpty(input: { repoId: string; lenses: string[]; startedBy: string; note: string }): Promise<{ run: DiscoverRun } | { conflict: DiscoverRun }> {
  try {
    const row = await queryOne<RunRow>(
      `insert into discover_runs (repo_id, lenses, state, started_by, note, ended_at) values ($1, $2, 'done', $3, $4, now()) returning ${RUN_COLUMNS}`,
      [input.repoId, input.lenses, input.startedBy, kept(input.note)],
    );
    if (!row) throw new Error('the Discover run could not be recorded; try again');
    return { run: toRun(row) };
  } catch (error) {
    if (!secondRunning(error)) throw error;
    const live = await runningRun(input.repoId);
    if (!live) throw error;
    return { conflict: live };
  }
}

/** Names the task that runs it, once that task's row exists. */
export async function attachTask(runId: string, taskId: string): Promise<void> {
  await query(`update discover_runs set task_id = $2 where id = $1`, [runId, taskId]);
}

/**
 * Stores the run's proposals, its counts and the commit they were checked
 * against, in one transaction. Only once, and only for a run still
 * `running`: false says nothing was written.
 */
export async function record(
  runId: string,
  input: { commit: string; proposals: readonly ProposalInput[]; dropped: number; note: string | null },
): Promise<boolean> {
  return withTransaction(async (client) => {
    const claimed = await client.query<{ repo_id: string }>(
      `update discover_runs set commit_sha = $2, proposal_count = $3, dropped_count = $4, note = $5
        where id = $1 and state = 'running' and commit_sha is null
        returning repo_id`,
      [runId, input.commit, input.proposals.length, Math.max(0, Math.trunc(input.dropped)), kept(input.note)],
    );
    const repoId = claimed.rows[0]?.repo_id;
    if (!repoId) return false;
    for (const proposal of input.proposals) {
      await client.query(
        `insert into discover_proposals (run_id, repo_id, lens, key, fingerprint, title, description, status, evidence)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [runId, repoId, proposal.lens, proposal.key, proposal.fingerprint, proposal.title, proposal.description, proposal.status, JSON.stringify(proposal.evidence)],
      );
    }
    return true;
  });
}

/** Ends a run, once: a run already ended keeps how it ended, and null says so. */
export async function finish(runId: string, state: 'done' | 'failed', reason?: string | null): Promise<DiscoverRun | null> {
  const row = await queryOne<RunRow>(
    `update discover_runs set state = $2, reason = $3, ended_at = now() where id = $1 and state = 'running' returning ${RUN_COLUMNS}`,
    [runId, state, kept(reason)],
  );
  return row ? toRun(row) : null;
}

export async function getRun(id: string): Promise<DiscoverRun | null> {
  const row = await queryOne<RunRow>(`select ${RUN_COLUMNS} from discover_runs where id = $1`, [id]);
  return row ? toRun(row) : null;
}

/** The run a `discover:<id8>` subject names, by the first eight of its id. */
export async function runByPrefix(prefix: string): Promise<DiscoverRun | null> {
  if (!/^[0-9a-f]{8}$/.test(prefix)) return null;
  const row = await queryOne<RunRow>(
    `select ${RUN_COLUMNS} from discover_runs where replace(id::text, '-', '') like $1 || '%' order by created_at desc limit 1`,
    [prefix],
  );
  return row ? toRun(row) : null;
}

export async function runOfTask(taskId: string): Promise<DiscoverRun | null> {
  const row = await queryOne<RunRow>(`select ${RUN_COLUMNS} from discover_runs where task_id = $1`, [taskId]);
  return row ? toRun(row) : null;
}

export async function proposalsOf(runId: string): Promise<StoredProposal[]> {
  const rows = await query<ProposalRow>(`select ${PROPOSAL_COLUMNS} from discover_proposals where run_id = $1 order by created_at, id`, [runId]);
  return rows.map(toProposal);
}

/** The proposals of the repository's last `done` run, at most `limit`: what the next run reuses keys from. */
export async function latestDoneProposals(repoId: string, limit: number): Promise<StoredProposal[]> {
  const rows = await query<ProposalRow>(
    `select ${PROPOSAL_COLUMNS} from discover_proposals
      where run_id = (select id from discover_runs where repo_id = $1 and state = 'done' and commit_sha is not null order by created_at desc limit 1)
      order by created_at, id limit $2`,
    [repoId, limit],
  );
  return rows.map(toProposal);
}

/** Every proposal of a repository with this fingerprint, newest first: what issue 2's dismissal and "seen before" read. */
export async function proposalsWithFingerprint(repoId: string, fingerprint: string): Promise<StoredProposal[]> {
  const rows = await query<ProposalRow>(
    `select ${PROPOSAL_COLUMNS} from discover_proposals where repo_id = $1 and fingerprint = $2 order by created_at desc`,
    [repoId, fingerprint],
  );
  return rows.map(toProposal);
}

/** A run whose start never became a task: it goes, so it holds the repository's one live run no longer. */
export async function removeRun(id: string): Promise<void> {
  await query(`delete from discover_runs where id = $1 and task_id is null`, [id]);
}
