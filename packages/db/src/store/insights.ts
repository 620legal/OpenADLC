import { query } from '../client.js';

/**
 * What the Insights page is counted from, read once for a window: the moves
 * between stages, the builds and their times, the requests behind issues, the
 * merge line's entries that landed, and the events the dispatcher and the
 * merge line write about waiting on overlap and resolving conflicts.
 *
 * Plain rows: the counting is the bridge's (`insights.ts`), where it can be
 * tested without a database.
 */
export interface InsightData {
  repos: { id: string; name: string }[];
  /** `reason` is why the move was made, which tells an abandon's move to Done from a merge's. */
  moves: { repoId: string; issueNumber: number; from: string | null; to: string; kind: string; reason?: string | null; at: string }[];
  builds: { repoId: string | null; kind: string; state: string; startedAt: string | null; endedAt: string | null }[];
  requests: { repoId: string | null; issueNumber: number; createdAt: string }[];
  landed: { repoId: string; prNumber: number; enteredAt: string; mergedAt: string }[];
  events: { type: string; at: string; payload: unknown }[];
  /**
   * Completed implement tasks that started in the last 13 weeks, whatever the
   * window, with the sum of their ledger rows' `tokens_in` (all input, cache
   * reads and writes included: docs/adr/0092). `billed` is whether every row
   * was billed, none was, or some were. A task with no ledger row is absent.
   */
  implementTasks: { repoId: string | null; startedAt: string; tokensIn: number; billed: 'billed' | 'subscription' | 'mixed' }[];
}

/** How far back `implementTasks` reads: the 12 weeks Insights shows, and the one they start in. */
export const IMPLEMENT_INPUT_LOOKBACK_MS = 13 * 7 * 24 * 60 * 60 * 1000;

/** The event types the dispatcher and the merge line write about overlap and conflicts. */
export const INSIGHT_EVENTS = ['overlap.waited', 'overlap.cleared', 'conflict.resolving', 'conflict.resolved', 'conflict.sent_back'] as const;

export async function readInsightData(since: Date): Promise<InsightData> {
  // Requests and moves from before the window too: a cycle that ends in the
  // window began before it.
  const lookBack = new Date(since.getTime() - 60 * 24 * 60 * 60 * 1000);
  const implementSince = new Date(Date.now() - IMPLEMENT_INPUT_LOOKBACK_MS);
  const [repos, moves, builds, requests, landed, events, implementTasks] = await Promise.all([
    query<{ id: string; name: string }>(`select id, name from repos where removed_at is null order by name`),
    query<{ repo_id: string; issue_number: number; from_stage: string | null; to_stage: string; kind: string; reason: string | null; created_at: Date }>(
      `select repo_id, issue_number, from_stage, to_stage, kind, reason, created_at from stage_moves where created_at >= $1 order by created_at`,
      [lookBack],
    ),
    query<{ repo_id: string | null; kind: string; state: string; started_at: Date | null; ended_at: Date | null }>(
      `select repo_id, kind, state, started_at, ended_at from tasks
        where kind in ('implement', 'patch') and started_at is not null and coalesce(ended_at, now()) >= $1`,
      [since],
    ),
    query<{ repo_id: string | null; issue_number: number; created_at: Date }>(
      `select repo_id, issue_number, created_at from requests where issue_number is not null and created_at >= $1`,
      [lookBack],
    ),
    query<{ repo_id: string; pr_number: number; entered_at: Date; updated_at: Date }>(
      `select repo_id, pr_number, entered_at, updated_at from merge_lines where state = 'merged' and updated_at >= $1`,
      [since],
    ),
    query<{ type: string; at: Date; payload: unknown }>(
      `select type, at, payload from events where type = any($1) and at >= $2 order by at`,
      [[...INSIGHT_EVENTS], since],
    ),
    // The same per-task sum as docs/runbooks/compare-implement-input-tokens.md,
    // so the page and the runbook's query count one task the same way.
    query<{ repo_id: string | null; started_at: Date; tokens_in: string; all_billed: boolean; any_billed: boolean }>(
      `select t.repo_id, t.started_at, sum(l.tokens_in)::bigint as tokens_in,
              bool_and(l.billed) as all_billed, bool_or(l.billed) as any_billed
         from tasks t join ledger l on l.task_id = t.id
        where t.kind = 'implement' and t.state = 'done'
          and t.started_at is not null and t.started_at >= $1
        group by t.id`,
      [implementSince],
    ),
  ]);
  const iso = (date: Date | null) => (date ? date.toISOString() : null);
  return {
    repos,
    moves: moves.map((row) => ({
      repoId: row.repo_id,
      issueNumber: row.issue_number,
      from: row.from_stage,
      to: row.to_stage,
      kind: row.kind,
      reason: row.reason,
      at: row.created_at.toISOString(),
    })),
    builds: builds.map((row) => ({ repoId: row.repo_id, kind: row.kind, state: row.state, startedAt: iso(row.started_at), endedAt: iso(row.ended_at) })),
    requests: requests.map((row) => ({ repoId: row.repo_id, issueNumber: row.issue_number, createdAt: row.created_at.toISOString() })),
    landed: landed.map((row) => ({ repoId: row.repo_id, prNumber: row.pr_number, enteredAt: row.entered_at.toISOString(), mergedAt: row.updated_at.toISOString() })),
    events: events.map((row) => ({ type: row.type, at: row.at.toISOString(), payload: row.payload })),
    implementTasks: implementTasks.map((row) => ({
      repoId: row.repo_id,
      startedAt: row.started_at.toISOString(),
      // A bigint comes back from pg as a string.
      tokensIn: Number(row.tokens_in),
      billed: row.all_billed ? 'billed' : row.any_billed ? 'mixed' : 'subscription',
    })),
  };
}
