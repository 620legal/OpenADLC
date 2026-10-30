import type { IgnoredState } from '@openadlc/shared';
import { query } from '../client.js';

/**
 * An issue labelled `openadlc:ignore`, as GitHub last said: kept so that what
 * names it under Dependencies can be judged (`dependencyIsSatisfied`), with
 * nothing of it on the board's columns. See `migrations/0157_ignored_issues.sql`.
 */
export interface IgnoredIssue extends IgnoredState {
  repoId: string;
  number: number;
  closedAt: string | null;
}

interface Row {
  repo_id: string;
  number: number;
  state: 'open' | 'closed';
  state_reason: string | null;
  closed_at: Date | null;
}

function toIgnored(row: Row): IgnoredIssue {
  return {
    repoId: row.repo_id,
    number: row.number,
    state: row.state,
    stateReason: row.state_reason,
    closedAt: row.closed_at ? row.closed_at.toISOString() : null,
  };
}

/**
 * Records what GitHub says of it now. Open, its close reason and time are
 * kept only as GitHub gives them: reopened, GitHub says `reopened` and no
 * time, which no longer counts as shipped.
 */
export async function record(
  repoId: string,
  number: number,
  state: { state: 'open' | 'closed'; stateReason?: string | null; closedAt?: string | null },
): Promise<void> {
  await query(
    `insert into ignored_issues (repo_id, number, state, state_reason, closed_at, seen_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (repo_id, number) do update set
       state = excluded.state,
       state_reason = excluded.state_reason,
       closed_at = excluded.closed_at,
       seen_at = excluded.seen_at`,
    [repoId, number, state.state, state.stateReason ?? null, state.closedAt ?? null],
  );
}

/** Forgets it: the label came off, or the issue left the repository. */
export async function forget(repoId: string, number: number): Promise<void> {
  await query('delete from ignored_issues where repo_id = $1 and number = $2', [repoId, number]);
}

export async function get(repoId: string, number: number): Promise<IgnoredIssue | null> {
  const rows = await query<Row>(
    'select repo_id, number, state, state_reason, closed_at from ignored_issues where repo_id = $1 and number = $2',
    [repoId, number],
  );
  return rows[0] ? toIgnored(rows[0]) : null;
}

/** Every record in these repositories, for a read of the whole board. */
export async function listForRepos(repoIds: readonly string[]): Promise<IgnoredIssue[]> {
  if (repoIds.length === 0) return [];
  const rows = await query<Row>(
    'select repo_id, number, state, state_reason, closed_at from ignored_issues where repo_id = any($1::uuid[])',
    [[...repoIds]],
  );
  return rows.map(toIgnored);
}
