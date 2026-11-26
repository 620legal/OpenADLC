/**
 * Routines (#369,
 * docs/adr/0090-a-routine-files-a-console-request-as-its-owner-from-a-claimed-slot.md):
 * a console request the bridge files as its owner each time it falls due, on
 * a daily, weekly or monthly cadence at a time of day in an IANA time zone.
 *
 * Pure code: what a routine may say, when it next falls due, and the
 * templates the console starts one from. The store keeps it, and the bridge's
 * `routines` job files it (`apps/bridge/src/routines.ts`).
 */

export const ROUTINE_KINDS = ['feature', 'defect', 'chore', 'question'] as const;
export type RoutineKind = (typeof ROUTINE_KINDS)[number];

/** Weekday is ISO: 1 is Monday, 7 is Sunday. A monthly day a month lacks falls on its last day. */
export type RoutineCadence = { every: 'day' } | { every: 'week'; weekday: number } | { every: 'month'; day: number };

/** What a person sets on a routine, as `validateRoutine` gives it back cleaned. */
export interface RoutineInput {
  /** The managed repository's name, as the install lists it. */
  repo: string;
  text: string;
  details: string | null;
  kind: RoutineKind;
  cadence: RoutineCadence;
  /** `HH:MM`, 24-hour, on the wall clock of `timeZone`. */
  time: string;
  timeZone: string;
}

/**
 * Why a due routine filed nothing, in the order they are checked: work is
 * paused, the monthly cap is reached, its owner no longer has Approves, or
 * the request it filed last is still open.
 */
export type RoutineSkipReason = 'paused' | 'cap' | 'approves' | 'open';

export type RoutineValidation = { ok: true; routine: RoutineInput } | { ok: false; field: keyof RoutineInput; error: string };

export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/**
 * What `Intl` accepts as a zone, and is a name rather than an offset. Node
 * takes `+05:00` too, which has no DST rules and so is not what a person
 * means by "my time zone".
 */
export function isRoutineTimeZone(zone: string): boolean {
  if (!zone || zone.length > 100 || zone !== zone.trim() || /^[+-]/.test(zone)) return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function cadenceOf(value: unknown): RoutineCadence | { error: string } {
  const raw = (value ?? {}) as { every?: unknown; weekday?: unknown; day?: unknown };
  if (raw.every === 'day') return { every: 'day' };
  if (raw.every === 'week') {
    const weekday = Number(raw.weekday);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) return { error: 'Weekly routines need a day from Monday to Sunday' };
    return { every: 'week', weekday };
  }
  if (raw.every === 'month') {
    const day = Number(raw.day);
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      return { error: 'Monthly routines need a day of the month from 1 to 31 (29 to 31 fall on the last day of a shorter month)' };
    }
    return { every: 'month', day };
  }
  return { error: 'The cadence is daily, weekly on a day, or monthly on a day: pick one' };
}

/**
 * The routine a person set, cleaned, or the first thing wrong with it, said
 * so they know what to fix. `managedRepos` is the names of the repositories
 * this install manages.
 */
export function validateRoutine(input: unknown, managedRepos: readonly string[]): RoutineValidation {
  const raw = (input ?? {}) as Record<string, unknown>;
  const repo = text(raw.repo).trim();
  if (!repo) return { ok: false, field: 'repo', error: 'Pick the repository the routine files its request in' };
  const managed = managedRepos.find((name) => name.toLowerCase() === repo.toLowerCase());
  if (!managed) {
    return { ok: false, field: 'repo', error: `The repository ${repo} is not managed by this install: pick one it manages, or add it in Settings → Repositories` };
  }
  const body = text(raw.text).trim();
  if (!body) return { ok: false, field: 'text', error: 'Write what the routine asks the crew to do: the request text is empty' };
  const details = text(raw.details).trim() || null;
  const kind = text(raw.kind);
  if (!(ROUTINE_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, field: 'kind', error: `The kind is one of ${ROUTINE_KINDS.join(', ')}: pick one` };
  }
  const cadence = cadenceOf(raw.cadence);
  if ('error' in cadence) return { ok: false, field: 'cadence', error: cadence.error };
  const time = text(raw.time).trim();
  if (!TIME.test(time)) return { ok: false, field: 'time', error: `The time "${time}" is not a time of day: write it as HH:MM, 00:00 to 23:59` };
  const timeZone = text(raw.timeZone).trim();
  if (!isRoutineTimeZone(timeZone)) {
    return { ok: false, field: 'timeZone', error: `Time zone "${timeZone}" is not an IANA zone: pick one like Europe/Paris or America/New_York` };
  }
  return { ok: true, routine: { repo: managed, text: body, details, kind: kind as RoutineKind, cadence, time, timeZone } };
}

// --- When a routine falls due -------------------------------------------------

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formats = new Map<string, Intl.DateTimeFormat>();

/** What a wall clock in `timeZone` reads at `at`. */
function wallClock(at: number, timeZone: string): Wall {
  let format = formats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formats.set(timeZone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** How far `timeZone`'s wall clock is ahead of UTC at `at`. */
function offsetAt(at: number, timeZone: string): number {
  const second = Math.floor(at / 1000) * 1000;
  const wall = wallClock(second, timeZone);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - second;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * The instant a wall clock in `timeZone` reads this date and time, once.
 *
 * Read with the offsets a day either side, since a zone changes its clock at
 * most once in that span. When both read it — an autumn hour that happens
 * twice — the first is the slot, so a routine fires once and not again an
 * hour later. When neither does — a spring hour that is skipped — it is read
 * with the offset before the change, which lands it the gap's length later
 * (02:30 in Berlin on the spring change day is 03:30 CEST).
 */
function instantOf(date: { year: number; month: number; day: number }, hour: number, minute: number, timeZone: string): number {
  const naive = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const before = naive - offsetAt(naive - DAY, timeZone);
  const after = naive - offsetAt(naive + DAY, timeZone);
  const reads = (at: number) => at + offsetAt(at, timeZone) === naive;
  const valid = [before, after].filter(reads);
  return valid.length > 0 ? Math.min(...valid) : before;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function falls(cadence: RoutineCadence, date: { year: number; month: number; day: number }): boolean {
  if (cadence.every === 'day') return true;
  if (cadence.every === 'week') {
    const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
    return (weekday === 0 ? 7 : weekday) === cadence.weekday;
  }
  return date.day === Math.min(cadence.day, daysInMonth(date.year, date.month));
}

/**
 * The first slot at or after `from`, taken to the minute, on the wall clock
 * of `timeZone`: correct across a change of the clock, and a monthly day a
 * month lacks (29 to 31) falls on that month's last day.
 */
export function nextRunAt(from: Date, cadence: RoutineCadence, time: string, timeZone: string): Date {
  const start = Math.floor(from.getTime() / 60_000) * 60_000;
  const [hour = 0, minute = 0] = time.split(':').map(Number);
  const wall = wallClock(start, timeZone);
  // A monthly routine is the longest wait: at most 31 days ahead. Two more
  // for the day either side a zone's offset can move the wall date.
  for (let ahead = -1; ahead <= 33; ahead += 1) {
    const day = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + ahead));
    const date = { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate() };
    if (!falls(cadence, date)) continue;
    const at = instantOf(date, hour, minute, timeZone);
    if (at >= start) return new Date(at);
  }
  throw new Error(`no slot within a month for ${JSON.stringify(cadence)} at ${time} in ${timeZone}`);
}

// --- Templates ------------------------------------------------------------------

export interface RoutineTemplate {
  id: 'dependency-review' | 'docs-drift' | 'project-health' | 'blank';
  label: string;
  /** What it fills in; every field stays editable. Blank fills nothing but a cadence. */
  text: string;
  details: string | null;
  kind: RoutineKind;
  cadence: RoutineCadence;
  time: string;
}

/**
 * What a routine can start from. The monthly Discover run was left out: a
 * Discover run starts only from its own route, and a routine only files a
 * request (answered on #369).
 */
export const ROUTINE_TEMPLATES: readonly RoutineTemplate[] = [
  {
    id: 'dependency-review',
    label: 'Weekly dependency review',
    text: 'Review this repository’s dependencies',
    details:
      'List the dependencies that are out of date, deprecated or have a published security advisory, and propose the updates worth making, one change per pull request. Leave a dependency alone when updating it would need code changes beyond the update itself, and say so instead.',
    kind: 'chore',
    cadence: { every: 'week', weekday: 1 },
    time: '09:00',
  },
  {
    id: 'docs-drift',
    label: 'Nightly docs-drift check',
    text: 'Find docs that no longer match the code',
    details:
      'Compare the documentation with the code on the default branch: commands, flags, settings, routes and behaviour it describes that have changed or gone. Fix what is wrong in one pull request, or report that nothing drifted.',
    kind: 'chore',
    cadence: { every: 'day' },
    time: '02:00',
  },
  {
    id: 'project-health',
    label: 'Monday project-health report',
    text: 'Write this week’s project-health report',
    details:
      'Report on open issues (new, closed and stale this week), work that is stuck or waiting on a person, checks that failed and then passed on the same commit (flaky), and this month’s spend so far. It is a report: no code changes.',
    kind: 'chore',
    cadence: { every: 'week', weekday: 1 },
    time: '08:00',
  },
  {
    id: 'blank',
    label: 'Blank',
    text: '',
    details: null,
    kind: 'chore',
    cadence: { every: 'week', weekday: 1 },
    time: '09:00',
  },
];

/** "Every Monday at 09:00 (Europe/Berlin)", as an audit row or a log line says a routine's cadence. */
export function describeCadence(cadence: RoutineCadence, time: string, timeZone: string): string {
  const when =
    cadence.every === 'day'
      ? 'Every day'
      : cadence.every === 'week'
        ? `Every ${WEEKDAY_NAMES[cadence.weekday - 1] ?? 'week'}`
        : `Monthly on day ${cadence.day}`;
  return `${when} at ${time} (${timeZone})`;
}
