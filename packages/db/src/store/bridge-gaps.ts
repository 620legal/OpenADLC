import { query } from '../client.js';

/**
 * A task the bridge resumed or ended as orphaned on the start after a gap.
 * `backAt` is the start that did it: a report merged across gaps keeps each.
 */
export interface GapTask {
  taskId: string;
  subject: string;
  outcome: 'resumed' | 'orphaned';
  why: string;
  backAt: string;
}

/**
 * The open gap report: when the bridge was last up, when it came back, and
 * what the starts since cost. See `migrations/0158_bridge_gaps.sql`.
 */
export interface BridgeGap {
  id: string;
  lastUpAt: string;
  backAt: string;
  tasks: GapTask[];
  /** The start that opened or last moved it is still listing its tasks: not yet a finished account. */
  filling: boolean;
}

interface Row {
  id: string;
  last_up_at: Date;
  back_at: Date;
  tasks: GapTask[] | null;
  filled_at: Date | null;
}

/**
 * Beats at start: sets the heartbeat to the database's now and says what it
 * was before, `null` on an install's first start. One statement, so the old
 * value read is the one replaced.
 */
export async function beat(): Promise<{ lastUpAt: string | null; backAt: string }> {
  const rows = await query<{ last_up_at: Date | null; back_at: Date }>(
    `with old as (select seen_at from bridge_heartbeat where id),
     beat as (
       insert into bridge_heartbeat (id, seen_at) values (true, now())
       on conflict (id) do update set seen_at = excluded.seen_at
       returning seen_at
     )
     select (select seen_at from old) as last_up_at, (select seen_at from beat) as back_at`,
  );
  const row = rows[0];
  if (!row) throw new Error('the bridge heartbeat was not written');
  return { lastUpAt: row.last_up_at ? row.last_up_at.toISOString() : null, backAt: row.back_at.toISOString() };
}

/** The beat while running. */
export async function touch(): Promise<void> {
  await query(
    `insert into bridge_heartbeat (id, seen_at) values (true, now())
     on conflict (id) do update set seen_at = excluded.seen_at`,
  );
}

/**
 * Opens the report for a gap, or moves the one still open to it, keeping the
 * tasks it holds: a second outage before anyone dismissed the first must not
 * lose what the first one cost. Either way it is filling until `finish`.
 */
export async function openGap(lastUpAt: string, backAt: string): Promise<{ id: string }> {
  const rows = await query<{ id: string }>(
    `insert into bridge_gaps (last_up_at, back_at) values ($1, $2)
     on conflict ((true)) where dismissed_at is null do update set
       last_up_at = excluded.last_up_at,
       back_at = excluded.back_at,
       filled_at = null
     returning id`,
    [lastUpAt, backAt],
  );
  const row = rows[0];
  if (!row) throw new Error('the gap report was not written');
  return { id: row.id };
}

/** Adds to the report's tasks, leaving out one it already lists with that outcome. */
export async function addTasks(id: string, tasks: readonly GapTask[]): Promise<void> {
  const fresh = [...new Map(tasks.map((task) => [`${task.taskId}:${task.outcome}`, task])).values()];
  if (fresh.length === 0) return;
  await query(
    `update bridge_gaps set tasks = tasks || coalesce((
       select jsonb_agg(entry) from jsonb_array_elements($2::jsonb) entry
       where not exists (
         select 1 from jsonb_array_elements(bridge_gaps.tasks) listed
         where listed->>'taskId' = entry->>'taskId' and listed->>'outcome' = entry->>'outcome'
       )
     ), '[]'::jsonb)
     where id = $1`,
    [id, JSON.stringify(fresh)],
  );
}

/**
 * Says the open report's tasks are all listed. Not by id: a start with no gap
 * also finishes a report that a start which died part way left filling, and
 * that nobody could otherwise dismiss.
 */
export async function finish(): Promise<void> {
  await query('update bridge_gaps set filled_at = now() where dismissed_at is null and filled_at is null');
}

/** The report nobody has dismissed yet, if there is one. */
export async function current(): Promise<BridgeGap | null> {
  const rows = await query<Row>('select id, last_up_at, back_at, tasks, filled_at from bridge_gaps where dismissed_at is null limit 1');
  const row = rows[0];
  return row
    ? {
        id: row.id,
        lastUpAt: row.last_up_at.toISOString(),
        backAt: row.back_at.toISOString(),
        tasks: row.tasks ?? [],
        filling: row.filled_at === null,
      }
    : null;
}

/**
 * Dismisses the open report for everyone, when it is still the one read:
 * `backAt` is the gap the person saw, and one merged in since is not theirs
 * to dismiss unseen (`replaced`). Not while its start is still listing tasks
 * (`filling`): a task written after the dismissal would never be shown.
 * `none` when nothing is open.
 */
export async function dismiss(backAt: string, by: string): Promise<'dismissed' | 'replaced' | 'filling' | 'none'> {
  const rows = await query<{ open: number; filling: number; dismissed: number }>(
    `with open as (select id, back_at, filled_at from bridge_gaps where dismissed_at is null),
     done as (
       update bridge_gaps set dismissed_at = now(), dismissed_by = $2
       from open where bridge_gaps.id = open.id and open.back_at = $1::timestamptz and open.filled_at is not null
       returning bridge_gaps.id
     )
     select (select count(*) from open)::int as open,
       (select count(*) from open where filled_at is null)::int as filling,
       (select count(*) from done)::int as dismissed`,
    [backAt, by],
  );
  const row = rows[0];
  if (!row || row.open === 0) return 'none';
  if (row.dismissed > 0) return 'dismissed';
  return row.filling > 0 ? 'filling' : 'replaced';
}
