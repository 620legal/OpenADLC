import { query, queryOne } from '../client.js';

/**
 * A hands-off window on one repository: while it is open, `Gates.open`
 * answers a plan change with no path under Human review, and a question
 * whose recommended option is one of its options, as they are asked
 * (`apps/bridge/src/hands-off.ts`). See `migrations/0175_hands_off_windows.sql`
 * and docs/adr/0093.
 */
export type HandsOffDuration = '1h' | '8h' | '24h' | 'until_off';
export type HandsOffEnd = 'expired' | 'cap' | 'turned_off';

export const HANDS_OFF_DURATIONS: readonly HandsOffDuration[] = ['1h', '8h', '24h', 'until_off'];

/** How long each duration lasts, in milliseconds; null for until turned off. */
export const DURATION_MS: Record<HandsOffDuration, number | null> = {
  '1h': 60 * 60_000,
  '8h': 8 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  until_off: null,
};

export interface HandsOffWindow {
  id: string;
  repoId: string;
  setBy: string;
  setByLogin: string;
  setByGithubId: number;
  duration: HandsOffDuration;
  setAt: string;
  /** Null: until turned off. */
  endsAt: string | null;
  endedAt: string | null;
  endedBy: string | null;
  endedWhy: HandsOffEnd | null;
  endedNote: string | null;
}

interface Row {
  id: string;
  repo_id: string;
  set_by: string;
  set_by_login: string;
  set_by_github_id: string | number;
  duration: HandsOffDuration;
  set_at: Date;
  ends_at: Date | null;
  ended_at: Date | null;
  ended_by: string | null;
  ended_why: HandsOffEnd | null;
  ended_note: string | null;
}

const COLUMNS = 'id, repo_id, set_by, set_by_login, set_by_github_id, duration, set_at, ends_at, ended_at, ended_by, ended_why, ended_note';

/**
 * Open, and not past its end. A row whose time has passed is not open even
 * before the sweep ends it: between the end and the next sweep, a gate it
 * answered would be one nobody had left it on for.
 */
const OPEN = 'ended_at is null and (ends_at is null or ends_at > now())';

/** Past its end: what `end` records as expired, whoever asked. */
const LAPSED = 'ends_at is not null and ends_at <= now()';

function toWindow(row: Row): HandsOffWindow {
  return {
    id: row.id,
    repoId: row.repo_id,
    setBy: row.set_by,
    setByLogin: row.set_by_login,
    setByGithubId: Number(row.set_by_github_id),
    duration: row.duration,
    setAt: row.set_at.toISOString(),
    endsAt: row.ends_at?.toISOString() ?? null,
    endedAt: row.ended_at?.toISOString() ?? null,
    endedBy: row.ended_by,
    endedWhy: row.ended_why,
    endedNote: row.ended_note,
  };
}

/** The window open on a repository now, or null. */
export async function openFor(repoId: string): Promise<HandsOffWindow | null> {
  const row = await queryOne<Row>(`select ${COLUMNS} from hands_off_windows where repo_id = $1 and ${OPEN}`, [repoId]);
  return row ? toWindow(row) : null;
}

/** Every window open now, soonest end first, until-off last. */
export async function listOpen(): Promise<HandsOffWindow[]> {
  const rows = await query<Row>(`select ${COLUMNS} from hands_off_windows where ${OPEN} order by ends_at asc nulls last, set_at`);
  return rows.map(toWindow);
}

/**
 * Opens a window, or opens none when one is already open on the repository:
 * two people turning it on at once leave one, and the second is told whose.
 * `created` says which. A row whose time has passed but that the sweep has
 * not ended yet still holds the one open slot; it is ended here first, so a
 * window that ran out a moment ago does not refuse a new one, and answered
 * in `expired`: an end the caller does not audit would be the one end of a
 * window that left no `hands_off.off` row (review of #409).
 */
export async function turnOn(input: {
  repoId: string;
  setBy: string;
  setByLogin: string;
  setByGithubId: number;
  duration: HandsOffDuration;
}): Promise<{ window: HandsOffWindow; created: boolean; expired: HandsOffWindow[] }> {
  const expired = (
    await query<Row>(
      `update hands_off_windows set ended_at = now(), ended_by = 'openadlc', ended_why = 'expired'
        where repo_id = $1 and ended_at is null and ends_at is not null and ends_at <= now()
        returning ${COLUMNS}`,
      [input.repoId],
    )
  ).map(toWindow);
  const ms = DURATION_MS[input.duration];
  const row = await queryOne<Row>(
    `insert into hands_off_windows (repo_id, set_by, set_by_login, set_by_github_id, duration, ends_at)
     values ($1, $2, $3, $4, $5, case when $6::bigint is null then null else now() + ($6::bigint * interval '1 millisecond') end)
     on conflict (repo_id) where ended_at is null do nothing
     returning ${COLUMNS}`,
    [input.repoId, input.setBy, input.setByLogin, input.setByGithubId, input.duration, ms],
  );
  if (row) return { window: toWindow(row), created: true, expired };
  const on = await openFor(input.repoId);
  if (!on) throw new Error('a hands-off window could not be turned on or read; try again');
  return { window: on, created: false, expired };
}

/**
 * Ends the window open on a repository, saying who and why; null when none
 * was open, so two enders at once record it once. One whose time has already
 * passed, but that the sweep has not reached, is recorded as expired by
 * OpenADLC whoever ends it: it was already off for every gate, and a Turn off
 * pressed a moment after its end would otherwise read as that person's.
 */
export async function end(input: { repoId: string; by: string; why: HandsOffEnd; note?: string | null }): Promise<HandsOffWindow | null> {
  const row = await queryOne<Row>(
    `update hands_off_windows
        set ended_at = now(),
            ended_by = case when ${LAPSED} then 'openadlc' else $2 end,
            ended_why = case when ${LAPSED} then 'expired' else $3 end,
            ended_note = case when ${LAPSED} then null else $4 end
      where repo_id = $1 and ended_at is null
      returning ${COLUMNS}`,
    [input.repoId, input.by, input.why, input.note ?? null],
  );
  return row ? toWindow(row) : null;
}

/** Ends every window whose time has passed, as OpenADLC, and answers them. */
export async function endExpired(): Promise<HandsOffWindow[]> {
  const rows = await query<Row>(
    `update hands_off_windows set ended_at = now(), ended_by = 'openadlc', ended_why = 'expired'
      where ended_at is null and ends_at is not null and ends_at <= now()
      returning ${COLUMNS}`,
  );
  return rows.map(toWindow);
}
