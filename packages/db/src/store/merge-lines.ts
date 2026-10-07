import { query, queryOne } from '../client.js';

export type MergeLineState = 'waiting' | 'updating' | 'testing' | 'merging' | 'failed' | 'merged';

/** The states a pull request passes through while it still holds its place. */
export const OPEN_STATES: MergeLineState[] = ['waiting', 'updating', 'testing', 'merging'];

export interface MergeLineEntry {
  id: string;
  repoId: string;
  repoName: string;
  prNumber: number;
  position: number;
  state: MergeLineState;
  headSha: string | null;
  detail: string | null;
  enteredAt: string;
}

interface MergeLineRow {
  id: string;
  repo_id: string;
  repo_name: string;
  pr_number: number;
  position: number;
  state: MergeLineState;
  head_sha: string | null;
  detail: string | null;
  entered_at: Date;
}

const SELECT = `
  select m.id, m.repo_id, r.name as repo_name, m.pr_number, m.position, m.state,
         m.head_sha, m.detail, m.entered_at
  from merge_lines m join repos r on r.id = m.repo_id
`;

function toEntry(row: MergeLineRow): MergeLineEntry {
  return {
    id: row.id,
    repoId: row.repo_id,
    repoName: row.repo_name,
    prNumber: row.pr_number,
    position: row.position,
    state: row.state,
    headSha: row.head_sha,
    detail: row.detail,
    enteredAt: row.entered_at.toISOString(),
  };
}

/**
 * Takes a place in the line, or keeps the one it already has. A revert enters
 * ahead of everything ordinary: when testing is broken, nothing else should land
 * in front of the change that fixes it.
 */
export async function enter(input: {
  repoId: string;
  prNumber: number;
  headSha: string | null;
  revert?: boolean;
}): Promise<MergeLineEntry> {
  const bounds = await queryOne<{ first: number | null; last: number | null }>(
    `select min(position) as first, max(position) as last
     from merge_lines where repo_id = $1 and state = any($2)`,
    [input.repoId, OPEN_STATES],
  );

  const position = input.revert ? (bounds?.first ?? 0) - 1 : (bounds?.last ?? 0) + 1;

  const row = await queryOne<MergeLineRow>(
    `with entered as (
       insert into merge_lines (repo_id, pr_number, position, head_sha)
       values ($1, $2, $3, $4)
       on conflict (repo_id, pr_number) do update set
         head_sha = excluded.head_sha,
         -- A pull request that failed and became eligible again waits its turn:
         -- at the back, as it would on entering. With the place it first had it
         -- went ahead of the one being tested, which then needed another update
         -- and another CI run once it landed. One still in the line keeps its place.
         state = case when merge_lines.state in ('failed', 'merged') then 'waiting' else merge_lines.state end,
         position = case when merge_lines.state in ('failed', 'merged') then excluded.position else merge_lines.position end,
         entered_at = case when merge_lines.state in ('failed', 'merged') then now() else merge_lines.entered_at end,
         updated_at = now()
       returning *
     )
     select e.id, e.repo_id, r.name as repo_name, e.pr_number, e.position, e.state,
            e.head_sha, e.detail, e.entered_at
     from entered e join repos r on r.id = e.repo_id`,
    [input.repoId, input.prNumber, position, input.headSha],
  );
  if (!row) throw new Error(`could not enter ${input.prNumber} into the merge line`);
  return toEntry(row);
}

/** Everything still holding a place, in the order it will land. */
export async function line(repoId?: string): Promise<MergeLineEntry[]> {
  const rows = await query<MergeLineRow>(
    `${SELECT}
     where ($1::uuid is null or m.repo_id = $1) and m.state = any($2)
     order by m.position, m.entered_at`,
    [repoId ?? null, OPEN_STATES],
  );
  return rows.map(toEntry);
}

/** The one the bridge is working on, or the next to start. */
export async function head(repoId: string): Promise<MergeLineEntry | null> {
  const entries = await line(repoId);
  return entries[0] ?? null;
}

export async function setState(
  id: string,
  state: MergeLineState,
  patch: { headSha?: string | null; detail?: string | null } = {},
): Promise<MergeLineEntry | null> {
  const row = await queryOne<MergeLineRow>(
    `with changed as (
       update merge_lines set
         state = $2,
         head_sha = coalesce($3, head_sha),
         detail = $4,
         updated_at = now()
       where id = $1
       returning *
     )
     select c.id, c.repo_id, r.name as repo_name, c.pr_number, c.position, c.state,
            c.head_sha, c.detail, c.entered_at
     from changed c join repos r on r.id = c.repo_id`,
    [id, state, patch.headSha ?? null, patch.detail ?? null],
  );
  return row ? toEntry(row) : null;
}

/** Gives up a place: the pull request closed, or is no longer eligible. */
export async function leave(repoId: string, prNumber: number): Promise<void> {
  await query('delete from merge_lines where repo_id = $1 and pr_number = $2', [repoId, prNumber]);
}
