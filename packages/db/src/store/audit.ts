import { query } from '../client.js';

export interface AuditEntry {
  id: number;
  actor: string;
  action: string;
  target: string;
  payload: Record<string, unknown> | null;
  at: string;
}

/** Attach, detach, kill, restart, cap changes, lease overrides, console label moves. */
export async function audit(input: {
  actor: string;
  action: string;
  target: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await query('insert into audit (actor, action, target, payload) values ($1,$2,$3,$4)', [
    input.actor,
    input.action,
    input.target,
    input.payload ? JSON.stringify(input.payload) : null,
  ]);
}

export async function listAudit(limit = 100): Promise<AuditEntry[]> {
  const rows = await query<{
    id: string;
    actor: string;
    action: string;
    target: string;
    payload: Record<string, unknown> | null;
    at: Date;
  }>('select id, actor, action, target, payload, at from audit order by at desc limit $1', [limit]);
  return rows.map((row) => ({
    id: Number(row.id),
    actor: row.actor,
    action: row.action,
    target: row.target,
    payload: row.payload,
    at: row.at.toISOString(),
  }));
}

export async function recordEvent(input: {
  source: 'github' | 'platform' | 'alert' | 'console' | 'schedule';
  type: string;
  deliveryId?: string | null;
  payload: unknown;
}): Promise<string> {
  const rows = await query<{ id: string }>(
    'insert into events (source, type, delivery_id, payload) values ($1,$2,$3,$4) returning id',
    [input.source, input.type, input.deliveryId ?? null, JSON.stringify(input.payload)],
  );
  return rows[0]?.id ?? '';
}

export async function markEventProcessed(id: string, error?: string): Promise<void> {
  await query('update events set processed_at = now(), error = $2 where id = $1', [id, error ?? null]);
}

/**
 * When GitHub was last heard from, or null if it never has been.
 *
 * A cloud install's entire event path runs on the GitHub App's webhook reaching
 * the bridge, and when it does not, nothing is obviously broken: the board is
 * simply always empty and no bot ever starts. `fleetadlc doctor` asks this so the
 * answer is "GitHub has never delivered anything here" rather than silence.
 */
export async function lastGithubDelivery(): Promise<{ at: string; type: string } | null> {
  const rows = await query<{ at: Date; type: string }>(
    "select at, type from events where source = 'github' order by at desc limit 1",
  );
  const row = rows[0];
  return row ? { at: row.at.toISOString(), type: row.type } : null;
}

/**
 * Removes the processed GitHub deliveries recorded before a moment, and says
 * how many. Nothing ever deleted from `events`, so every delivery's payload,
 * issue and comment bodies included, stayed in the database and its backups
 * for good.
 *
 * Only `github` rows: the platform's own events are read back over windows
 * (stalled reviews, overlap waits, deploys), `schedule` rows say when each
 * job last ran, and an unprocessed delivery is still to be acted on. The
 * newest delivery stays whatever its age, because `lastGithubDelivery` reads
 * it, and without it a quiet install would say GitHub never delivered at all.
 */
export async function pruneGithubDeliveries(before: Date): Promise<number> {
  const rows = await query<{ removed: string }>(
    `with gone as (
       delete from events
        where source = 'github' and processed_at is not null and at < $1
          and id <> (select id from events where source = 'github' order by at desc limit 1)
        returning 1
     )
     select count(*) as removed from gone`,
    [before],
  );
  return Number(rows[0]?.removed ?? 0);
}

export async function listEvents(limit = 50): Promise<
  { id: number; source: string; type: string; at: string; processedAt: string | null; error: string | null }[]
> {
  const rows = await query<{
    id: string;
    source: string;
    type: string;
    at: Date;
    processed_at: Date | null;
    error: string | null;
  }>('select id, source, type, at, processed_at, error from events order by at desc limit $1', [limit]);
  return rows.map((row) => ({
    id: Number(row.id),
    source: row.source,
    type: row.type,
    at: row.at.toISOString(),
    processedAt: row.processed_at?.toISOString() ?? null,
    error: row.error,
  }));
}

/**
 * The events of one type since a moment, newest first, with what they carried.
 *
 * For a fact the bridge has no row of its own for — a review loop that stopped
 * without agreeing is a comment on GitHub and this event, nothing else — and
 * that a person still has to act on.
 */
export async function listEventsOfType(
  type: string,
  since: Date,
): Promise<{ id: number; at: string; payload: unknown }[]> {
  const rows = await query<{ id: string; at: Date; payload: unknown }>(
    'select id, at, payload from events where type = $1 and at >= $2 order by at desc',
    [type, since],
  );
  return rows.map((row) => ({ id: Number(row.id), at: row.at.toISOString(), payload: row.payload }));
}

/**
 * The events of one type that carried at least these fields, at any age,
 * newest first.
 *
 * For a fact that stays true for as long as its subject is open: a conflict
 * resolution's carried approvals were read from the last three days only, so
 * a pull request that waited longer to land lost them and stalled in review.
 */
export async function listEventsOfTypeWith(
  type: string,
  fields: Record<string, string | number>,
): Promise<{ id: number; at: string; payload: unknown }[]> {
  const rows = await query<{ id: string; at: Date; payload: unknown }>(
    'select id, at, payload from events where type = $1 and payload @> $2::jsonb order by at desc',
    [type, JSON.stringify(fields)],
  );
  return rows.map((row) => ({ id: Number(row.id), at: row.at.toISOString(), payload: row.payload }));
}

/**
 * Whether an event of one type since a moment carried at least these fields.
 *
 * The question a red smoke's revert asks of the testing deployments
 * (`deploy.testing_live`): reading every one of them back to look for a
 * commit grew with every deploy, and the database can answer it alone.
 */
export async function hasEventOfType(type: string, since: Date, fields: Record<string, string>): Promise<boolean> {
  const rows = await query<{ found: number }>(
    'select 1 as found from events where type = $1 and at >= $2 and payload @> $3::jsonb limit 1',
    [type, since, JSON.stringify(fields)],
  );
  return rows.length > 0;
}

/**
 * When the newest event of one type that carried at least these fields was
 * recorded, or null when there is none.
 *
 * For a moment the bridge keeps no column for: when a pull request's current
 * round of reviews began (`review.round_opened`). Without it, a seat busy at
 * the push was never asked again, because its review of the earlier round
 * looked like this one's.
 */
export async function lastEventAt(type: string, fields: Record<string, string | number>): Promise<string | null> {
  const rows = await query<{ at: Date }>('select at from events where type = $1 and payload @> $2::jsonb order by at desc limit 1', [
    type,
    JSON.stringify(fields),
  ]);
  return rows[0]?.at.toISOString() ?? null;
}

/**
 * The events of one type nothing has finished yet, oldest first.
 *
 * An event recorded unprocessed is work queued for later: the delivery that
 * recorded it has already been answered, and whatever takes it up marks it
 * processed (`markEventProcessed`) once it is done.
 */
export async function listUnprocessedEventsOfType(
  type: string,
): Promise<{ id: string; at: string; deliveryId: string | null; payload: unknown }[]> {
  const rows = await query<{ id: string; at: Date; delivery_id: string | null; payload: unknown }>(
    'select id, at, delivery_id, payload from events where type = $1 and processed_at is null order by at asc, id asc',
    [type],
  );
  return rows.map((row) => ({ id: String(row.id), at: row.at.toISOString(), deliveryId: row.delivery_id, payload: row.payload }));
}

/**
 * When each scheduled job last ran.
 *
 * Read from the event log rather than a column, because a job run is already an
 * event and a second record of the same fact drifts from the first.
 */
export async function lastJobRuns(): Promise<{ job: string; at: string }[]> {
  const rows = await query<{ type: string; at: string }>(
    `select type, max(at) as at
       from events
      where source = 'schedule' and type like 'job.%'
      group by type
      order by type`,
  );
  return rows.map((row) => ({ job: row.type.replace(/^job\./, ''), at: row.at }));
}

/** The newest entry of one action on one target, however much else was audited since; null when there is none. */
export async function lastAudit(action: string, target: string): Promise<AuditEntry | null> {
  const [row] = await query<{
    id: string;
    actor: string;
    action: string;
    target: string;
    payload: Record<string, unknown> | null;
    at: Date;
  }>('select id, actor, action, target, payload, at from audit where action = $1 and target = $2 order by at desc limit 1', [action, target]);
  return row ? { id: Number(row.id), actor: row.actor, action: row.action, target: row.target, payload: row.payload, at: row.at.toISOString() } : null;
}
