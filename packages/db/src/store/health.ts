import type { HealthAction, HealthSeverity, HealthState } from '@fleetadlc/shared';
import { query } from '../client.js';

/**
 * The latest answer of each health check about each subject. See
 * `migrations/0013_health_checks.sql` for why it is kept, and
 * `apps/bridge/src/health/` for the checks and what moves a row from one
 * state to another. This module only reads and writes rows; it decides
 * nothing.
 */
export interface HealthRow {
  /** The check and its subject: `signing-key:<bot id>`, or `webhook`. */
  id: string;
  checkId: string;
  subject: string | null;
  state: HealthState;
  severity: HealthSeverity | null;
  title: string | null;
  detail: string | null;
  action: HealthAction | null;
  /** What the check found that something other than the card reads: the dispatcher, the walkthrough. */
  facts: Record<string, unknown>;
  /** Rows whose fix comes first; this one's card waits for them. */
  waitingFor: string[];
  failingSince: string | null;
  checkedAt: string;
  notifiedAt: string | null;
  fixedAt: string | null;
  /** What the board says once when it passes again: "GitHub is delivering again". */
  fixedTitle: string | null;
  fixedDismissedAt: string | null;
}

interface Row {
  id: string;
  check_id: string;
  subject: string | null;
  state: HealthState;
  severity: HealthSeverity | null;
  title: string | null;
  detail: string | null;
  action: HealthAction | null;
  facts: Record<string, unknown> | null;
  waiting_for: string[] | null;
  failing_since: Date | null;
  checked_at: Date;
  notified_at: Date | null;
  fixed_at: Date | null;
  fixed_title: string | null;
  fixed_dismissed_at: Date | null;
}

const COLUMNS = `id, check_id, subject, state, severity, title, detail, action, facts, waiting_for,
  failing_since, checked_at, notified_at, fixed_at, fixed_title, fixed_dismissed_at`;

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

function toRow(row: Row): HealthRow {
  return {
    id: row.id,
    checkId: row.check_id,
    subject: row.subject,
    state: row.state,
    severity: row.severity,
    title: row.title,
    detail: row.detail,
    action: row.action,
    facts: row.facts ?? {},
    waitingFor: row.waiting_for ?? [],
    failingSince: iso(row.failing_since),
    checkedAt: row.checked_at.toISOString(),
    notifiedAt: iso(row.notified_at),
    fixedAt: iso(row.fixed_at),
    fixedTitle: row.fixed_title,
    fixedDismissedAt: iso(row.fixed_dismissed_at),
  };
}

export async function listHealth(): Promise<HealthRow[]> {
  const rows = await query<Row>(`select ${COLUMNS} from health_checks order by check_id, id`);
  return rows.map(toRow);
}

/** Writes a row whole: the bridge decides every column, so there is nothing to merge. */
export async function saveHealth(row: HealthRow): Promise<void> {
  await query(
    `insert into health_checks (${COLUMNS})
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     on conflict (id) do update set
       check_id = excluded.check_id,
       subject = excluded.subject,
       state = excluded.state,
       severity = excluded.severity,
       title = excluded.title,
       detail = excluded.detail,
       action = excluded.action,
       facts = excluded.facts,
       waiting_for = excluded.waiting_for,
       failing_since = excluded.failing_since,
       checked_at = excluded.checked_at,
       notified_at = excluded.notified_at,
       fixed_at = excluded.fixed_at,
       fixed_title = excluded.fixed_title,
       fixed_dismissed_at = excluded.fixed_dismissed_at`,
    [
      row.id,
      row.checkId,
      row.subject,
      row.state,
      row.severity,
      row.title,
      row.detail,
      row.action ? JSON.stringify(row.action) : null,
      JSON.stringify(row.facts ?? {}),
      row.waitingFor,
      row.failingSince,
      row.checkedAt,
      row.notifiedAt,
      row.fixedAt,
      row.fixedTitle,
      row.fixedDismissedAt,
    ],
  );
}

/** Rows whose subject is gone: a bot removed from the crew, a repository no longer managed. */
export async function deleteHealth(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await query('delete from health_checks where id = any($1)', [ids]);
}

/**
 * Stops the board saying a fixed check was fixed. False when there is no such
 * row, or it has nothing to say.
 */
export async function dismissFixed(id: string, at = new Date()): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `update health_checks set fixed_dismissed_at = $2
      where id = $1 and fixed_at is not null and fixed_dismissed_at is null
      returning id`,
    [id, at],
  );
  return rows.length > 0;
}
