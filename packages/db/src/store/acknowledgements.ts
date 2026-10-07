import { query } from '../client.js';

/**
 * A person's "Dismiss" on a notice that has nothing to fix: which occurrences
 * they have seen, so the card stays away until one they have not arrives. See
 * `migrations/0020_acknowledgements.sql`.
 */
export interface Acknowledgement {
  id: string;
  /** The occurrence the card led with at the last press. */
  occurrence: string;
  /** Every occurrence dismissed so far, the last press's added to the ones before. */
  covers: string[];
  acknowledgedBy: string;
  acknowledgedAt: string;
}

interface Row {
  id: string;
  occurrence: string;
  covers: string[] | null;
  acknowledged_by: string;
  acknowledged_at: Date;
}

/**
 * Records that `by` has seen `occurrence` of `id`, and every occurrence in
 * `covers` with it (what else the card was showing), adding to what was seen
 * before rather than replacing it.
 */
export async function acknowledge(id: string, occurrence: string, by: string, at = new Date(), covers: readonly string[] = [occurrence]): Promise<void> {
  const seen = [...new Set([occurrence, ...covers])];
  await query(
    `insert into acknowledgements (id, occurrence, covers, acknowledged_by, acknowledged_at)
     values ($1, $2, $5, $3, $4)
     on conflict (id) do update set
       occurrence = excluded.occurrence,
       covers = array(select distinct unnest(acknowledgements.covers || excluded.covers)),
       acknowledged_by = excluded.acknowledged_by,
       acknowledged_at = excluded.acknowledged_at`,
    [id, occurrence, by, at, seen],
  );
}

/** Every acknowledgement, by what was acknowledged. */
export async function listAcknowledgements(): Promise<Map<string, Acknowledgement>> {
  const rows = await query<Row>('select id, occurrence, covers, acknowledged_by, acknowledged_at from acknowledgements');
  return new Map(
    rows.map((row) => [
      row.id,
      { id: row.id, occurrence: row.occurrence, covers: row.covers ?? [row.occurrence], acknowledgedBy: row.acknowledged_by, acknowledgedAt: row.acknowledged_at.toISOString() },
    ]),
  );
}

/**
 * Forgets the acknowledgements under `prefix` made before `before`. A failed
 * task's card is read for a week, so a dismissal older than that hides
 * nothing any more, and every read of what needs you reads them all.
 */
export async function forgetBefore(prefix: string, before: Date): Promise<void> {
  await query(`delete from acknowledgements where starts_with(id, $1) and acknowledged_at < $2`, [prefix, before]);
}
