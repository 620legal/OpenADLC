import type { HealthRow } from '@fleetadlc/db';
import type { ManualStep } from '@fleetadlc/shared';
import type { CheckResult, HealthCheck } from './types.js';

/**
 * How a check's answers become what the board, the notifications and the
 * walkthrough say. Plain functions over rows: the registry reads and writes,
 * these decide.
 */

/** A blocking check has to have been failing this long before anybody is interrupted about it. */
export const NOTIFY_AFTER_MS = 5 * 60_000;
/** And then not again for a day, if it is still failing. */
export const NOTIFY_AGAIN_MS = 24 * 60 * 60_000;
/** How long the board says something was fixed, unless somebody dismisses it first. */
export const FIXED_SHOWN_MS = 24 * 60 * 60_000;

/**
 * - `new`: failing, and was not.
 * - `still`: failing, as it was.
 * - `fixed`: passing, and was failing.
 * - `passing`: passing, as it was or as it has never been asked.
 * - `unknown`: no answer; nothing changes.
 */
export type Transition = 'new' | 'still' | 'fixed' | 'passing' | 'unknown';

/** Since when a failing row's check has had no answer, and why; see `nextRow`. */
export function unconfirmedOf(row: Pick<HealthRow, 'facts'>): { since: string; reason: string } | null {
  const value = row.facts.unconfirmed as { since?: unknown; reason?: unknown } | undefined;
  return value && typeof value.since === 'string' && typeof value.reason === 'string'
    ? { since: value.since, reason: value.reason }
    : null;
}

/** A row's id: the check, and what it is about. */
export function rowId(checkId: string, subject?: string | null): string {
  return subject ? `${checkId}:${subject}` : checkId;
}

function blank(checkId: string, subject: string | null, now: Date): HealthRow {
  return {
    id: rowId(checkId, subject),
    checkId,
    subject,
    state: 'unknown',
    severity: null,
    title: null,
    detail: null,
    action: null,
    facts: {},
    waitingFor: [],
    failingSince: null,
    checkedAt: now.toISOString(),
    notifiedAt: null,
    fixedAt: null,
    fixedTitle: null,
    fixedDismissedAt: null,
  };
}

/**
 * The row after one answer, and what kind of change that was. `write` is false
 * when there is nothing to store: an answer of "unknown" about something whose
 * state is already known.
 */
export function nextRow(
  previous: HealthRow | null,
  checkId: string,
  result: CheckResult,
  now: Date,
): { row: HealthRow; transition: Transition; write: boolean } {
  const subject = result.subject ?? null;
  const at = now.toISOString();

  if (result.ok === null) {
    // No answer is never a verdict. A known state stands until a check can
    // say otherwise, so a GitHub that did not answer neither raises a card nor
    // clears one.
    // Except that a failing card says it could not be confirmed, and why: a
    // CODEOWNERS already fixed kept its card for good, because every run after
    // the fix asked GitHub something it would not answer, and the card said
    // nothing of it. Still failing, never cleared on a guess; `checkedAt` stays
    // the last answer, and the next real one replaces the note.
    if (previous?.state === 'failing') {
      const was = unconfirmedOf(previous);
      if (was?.reason === result.reason) return { row: previous, transition: 'unknown', write: false };
      return {
        row: { ...previous, facts: { ...previous.facts, unconfirmed: { since: was?.since ?? at, reason: result.reason } } },
        transition: 'unknown',
        write: true,
      };
    }
    if (previous && previous.state !== 'unknown') return { row: previous, transition: 'unknown', write: false };
    return {
      row: { ...blank(checkId, subject, now), detail: result.reason, facts: result.facts ?? {} },
      transition: 'unknown',
      write: true,
    };
  }

  if (result.ok) {
    const wasFailing = previous?.state === 'failing';
    const notice = wasFailing
      ? { fixedAt: at, fixedTitle: result.fixed ?? `Fixed: ${previous?.title ?? checkId}`, fixedDismissedAt: null }
      : result.note && result.note !== previous?.fixedTitle
        ? { fixedAt: at, fixedTitle: result.note, fixedDismissedAt: null }
        : {
            fixedAt: previous?.fixedAt ?? null,
            fixedTitle: previous?.fixedTitle ?? null,
            fixedDismissedAt: previous?.fixedDismissedAt ?? null,
          };
    return {
      row: { ...blank(checkId, subject, now), state: 'ok', facts: result.facts ?? {}, ...notice },
      transition: wasFailing ? 'fixed' : 'passing',
      write: true,
    };
  }

  const still = previous?.state === 'failing';
  return {
    row: {
      ...blank(checkId, subject, now),
      state: 'failing',
      severity: result.severity,
      title: result.title,
      detail: result.detail,
      action: result.action,
      facts: result.facts ?? {},
      waitingFor: result.waitingFor ?? [],
      // How long a person has been waited on is from the first failure, and
      // whether they have been told is kept with it.
      failingSince: still ? (previous?.failingSince ?? at) : at,
      notifiedAt: still ? (previous?.notifiedAt ?? null) : null,
    },
    transition: still ? 'still' : 'new',
    write: true,
  };
}

/** Whether a fixed or done-by-OpenADLC notice is still worth saying. */
export function showsNotice(row: HealthRow, now: Date): boolean {
  return (
    row.state !== 'failing' &&
    row.fixedAt !== null &&
    row.fixedTitle !== null &&
    row.fixedDismissedAt === null &&
    now.getTime() - Date.parse(row.fixedAt) < FIXED_SHOWN_MS
  );
}

/**
 * The rows of one check that its latest run no longer mentions: the subject
 * is gone. A notice not yet read stays until it is, or until it is old.
 */
export function forgotten(previous: readonly HealthRow[], returned: ReadonlySet<string>, now: Date): string[] {
  return previous.filter((row) => !returned.has(row.id) && !showsNotice(row, now)).map((row) => row.id);
}

/** The ids of every failing row, waiting or not: `isWaiting` asks this set whether what a row waits for still fails, and a card is hidden only while it does. */
export function failingIds(rows: readonly HealthRow[]): Set<string> {
  return new Set(rows.filter((row) => row.state === 'failing').map((row) => row.id));
}

export function isWaiting(row: HealthRow, failing: ReadonlySet<string>): boolean {
  return row.waitingFor.some((id) => id !== row.id && failing.has(id));
}

/**
 * The blocking failures somebody should be told about now: failing for five
 * minutes, not waiting on another fix, and not already told within a day.
 */
export function notificationsDue(rows: readonly HealthRow[], now: Date): HealthRow[] {
  const failing = failingIds(rows);
  return rows.filter(
    (row) =>
      row.state === 'failing' &&
      row.severity === 'blocking' &&
      row.failingSince !== null &&
      now.getTime() - Date.parse(row.failingSince) >= NOTIFY_AFTER_MS &&
      !isWaiting(row, failing) &&
      (row.notifiedAt === null || now.getTime() - Date.parse(row.notifiedAt) >= NOTIFY_AGAIN_MS),
  );
}

export interface StepVerdict {
  /**
   * True when no blocking check on the step fails and at least one has
   * answered: one passes, or one fails only as a warning. False when a
   * blocking one fails. Null when no check has an answer yet, and the
   * walkthrough goes by what it knew before.
   */
  done: boolean | null;
  /** What is wrong on this step, blocking first. */
  failing: HealthRow[];
}

/** What the checks say about each walkthrough step a person does. */
export function stepVerdicts(
  rows: readonly HealthRow[],
  checks: readonly Pick<HealthCheck, 'id' | 'steps'>[],
  steps: readonly ManualStep[],
): Record<ManualStep, StepVerdict> {
  const failing = failingIds(rows);
  const verdicts = {} as Record<ManualStep, StepVerdict>;
  for (const step of steps) {
    const answering = new Set(checks.filter((check) => check.steps.includes(step)).map((check) => check.id));
    const mine = rows.filter((row) => answering.has(row.checkId));
    const wrong = mine
      .filter((row) => row.state === 'failing')
      .sort((a, b) => Number(isWaiting(a, failing)) - Number(isWaiting(b, failing)) || (a.severity === 'blocking' ? -1 : 1) - (b.severity === 'blocking' ? -1 : 1));
    const blocking = wrong.some((row) => row.severity === 'blocking');
    const passing = mine.some((row) => row.state === 'ok');
    verdicts[step] = { done: blocking ? false : passing || wrong.length > 0 ? true : null, failing: wrong };
  }
  return verdicts;
}
