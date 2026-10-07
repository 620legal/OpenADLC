/**
 * Time and money as the console says them.
 *
 * Every relative time is worked out from a `now` the page was given rather than
 * the clock at the moment of drawing: the server draws the page first and the
 * browser draws it again, and two clocks a second apart would disagree about
 * "12 min" and throw the second drawing away.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type Moment = string | number | Date;

function ms(moment: Moment): number {
  return moment instanceof Date ? moment.getTime() : typeof moment === 'number' ? moment : Date.parse(moment);
}

/** How long something has been going: "12 min", "1 h 5 min", "3 days". Null when it never started. */
export function duration(since: string | null | undefined, now: Moment): string | null {
  if (!since) return null;
  const elapsed = ms(now) - Date.parse(since);
  if (!Number.isFinite(elapsed)) return null;
  if (elapsed < MINUTE) return 'under a minute';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min`;
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR);
    const minutes = Math.floor((elapsed % HOUR) / MINUTE);
    return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  }
  const days = Math.floor(elapsed / DAY);
  return days === 1 ? '1 day' : `${days} days`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** When something happened, from now: "just now", "2 min ago", "2 hours ago", "yesterday", "on 12 Sep". */
export function ago(at: string | null | undefined, now: Moment): string {
  if (!at) return '';
  const when = Date.parse(at);
  const elapsed = ms(now) - when;
  if (!Number.isFinite(elapsed)) return '';
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR);
    return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
  }
  if (elapsed < 2 * DAY) return 'yesterday';
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)} days ago`;
  const date = new Date(when);
  return `on ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/** Whether a moment is within the last `days` days of `now`. */
export function within(at: string | null | undefined, days: number, now: Moment): boolean {
  if (!at) return false;
  const elapsed = ms(now) - Date.parse(at);
  return Number.isFinite(elapsed) && elapsed <= days * DAY;
}

/**
 * Dollars, the way the header and the cards say them: cents where they matter,
 * none on a round cap. A fraction of a cent is still something spent, so it is
 * not "$0.00".
 */
export function money(usd: number, options: { whole?: boolean } = {}): string {
  if (!Number.isFinite(usd)) return '$0';
  if (usd > 0 && usd < 0.005) return '<$0.01';
  const whole = options.whole ?? false;
  return `$${usd.toLocaleString('en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  })}`;
}

/** "1st", "2nd", "3rd", "4th" — a place in the line. */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}
