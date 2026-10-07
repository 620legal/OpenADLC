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
  moves: { repoId: string; issueNumber: number; from: string | null; to: string; kind: string; at: string }[];
  builds: { repoId: string | null; kind: string; state: string; startedAt: string | null; endedAt: string | null }[];
  requests: { repoId: string | null; issueNumber: number; createdAt: string }[];
  landed: { repoId: string; prNumber: number; enteredAt: string; mergedAt: string }[];
  events: { type: string; at: string; payload: unknown }[];
}

/** The event types the dispatcher and the merge line write about overlap and conflicts. */
export const INSIGHT_EVENTS = ['overlap.waited', 'overlap.cleared', 'conflict.resolving', 'conflict.resolved', 'conflict.sent_back'] as const;

export async function readInsightData(since: Date): Promise<InsightData> {
  // Requests and moves from before the window too: a cycle that ends in the
  // window began before it.
  const lookBack = new Date(since.getTime() - 60 * 24 * 60 * 60 * 1000);
  const [repos, moves, builds, requests, landed, events] = await Promise.all([
    query<{ id: string; name: string }>(`select id, name from repos where removed_at is null order by name`),
    query<{ repo_id: string; issue_number: number; from_stage: string | null; to_stage: string; kind: string; created_at: Date }>(
      `select repo_id, issue_number, from_stage, to_stage, kind, created_at from stage_moves where created_at >= $1 order by created_at`,
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
  ]);
  const iso = (date: Date | null) => (date ? date.toISOString() : null);
  return {
    repos,
    moves: moves.map((row) => ({ repoId: row.repo_id, issueNumber: row.issue_number, from: row.from_stage, to: row.to_stage, kind: row.kind, at: row.created_at.toISOString() })),
    builds: builds.map((row) => ({ repoId: row.repo_id, kind: row.kind, state: row.state, startedAt: iso(row.started_at), endedAt: iso(row.ended_at) })),
    requests: requests.map((row) => ({ repoId: row.repo_id, issueNumber: row.issue_number, createdAt: row.created_at.toISOString() })),
    landed: landed.map((row) => ({ repoId: row.repo_id, prNumber: row.pr_number, enteredAt: row.entered_at.toISOString(), mergedAt: row.updated_at.toISOString() })),
    events: events.map((row) => ({ type: row.type, at: row.at.toISOString(), payload: row.payload })),
  };
}
