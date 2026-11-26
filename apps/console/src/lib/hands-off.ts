/**
 * Hands-off mode in the console (#383, ADR 0093): what the header's badge
 * says about each open window. Pure, so the badge and its tests share it.
 */

export type HandsOffDuration = '1h' | '8h' | '24h' | 'until_off';

/** A window as the bridge lists it (`GET /v1/hands-off`). */
export interface HandsOffWindowView {
  repo: string;
  fullName: string;
  setByLogin: string;
  setAt: string;
  /** Null: until turned off. */
  endsAt: string | null;
  duration: HandsOffDuration;
}

/** What the header reads: the open windows, and whether this person may turn one on. */
export interface HandsOffView {
  windows: HandsOffWindowView[];
  /** The repositories one may be turned on for. */
  repos: string[];
  mayTurnOn: boolean;
  /** Why not, and where to act on it. */
  why?: string;
  url?: string;
}

/**
 * A read of `/api/hands-off` as a view, or null when it is not one: an error,
 * or anything a proxy answered that has no list of windows.
 */
export function handsOffViewOf(read: unknown): HandsOffView | null {
  if (!read || typeof read !== 'object') return null;
  const body = read as Partial<HandsOffView>;
  if (!Array.isArray(body.windows)) return null;
  return {
    windows: body.windows,
    repos: Array.isArray(body.repos) ? body.repos : [],
    mayTurnOn: body.mayTurnOn === true,
    ...(typeof body.why === 'string' ? { why: body.why } : {}),
    ...(typeof body.url === 'string' ? { url: body.url } : {}),
  };
}

/** The choices the dialog offers, in its order. */
export const DURATIONS: readonly { value: HandsOffDuration; label: string }[] = [
  { value: '1h', label: '1 hour' },
  { value: '8h', label: '8 hours' },
  { value: '24h', label: '24 hours' },
  { value: 'until_off', label: 'Until turned off' },
];

const MINUTE = 60_000;

/**
 * The time a window has left, as the badge says it: `6h 12m`, `12m`, or
 * `until turned off`. Null once it has passed, when the badge drops it.
 * Rounded up to the minute, so a window with seconds left still says `1m`.
 */
export function timeLeft(endsAt: string | null, now: number): string | null {
  if (endsAt === null) return 'until turned off';
  const left = Date.parse(endsAt) - now;
  if (!Number.isFinite(left) || left <= 0) return null;
  const minutes = Math.ceil(left / MINUTE);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours}h ${rest}m` : `${rest}m`;
}

/** The windows still open at `now`, soonest end first, until-off last. */
export function badgeOrder(windows: readonly HandsOffWindowView[], now: number): HandsOffWindowView[] {
  return windows
    .filter((window) => timeLeft(window.endsAt, now) !== null)
    .sort((a, b) => {
      const ends = (window: HandsOffWindowView) => (window.endsAt === null ? Number.POSITIVE_INFINITY : Date.parse(window.endsAt));
      return ends(a) - ends(b) || a.repo.localeCompare(b.repo);
    });
}

/** What the badge says: the soonest window, and how many more. */
export function badgeText(windows: readonly HandsOffWindowView[], now: number): { label: string; more: number } | null {
  const open = badgeOrder(windows, now);
  const first = open[0];
  if (!first) return null;
  return { label: `Hands-off · ${first.repo} · ${timeLeft(first.endsAt, now)}`, more: open.length - 1 };
}
