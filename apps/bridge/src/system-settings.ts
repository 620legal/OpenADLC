/**
 * The install's clock.
 *
 * Schedules used to read the bridge process's `TZ` and nothing stored it, so
 * a Settings page could not say what "Sunday at 18:00" meant, and moving the
 * container's zone moved every schedule with no record. `systemTimeZone` is
 * that clock. Empty means the process zone, which is what an install already
 * running has been using.
 */

/** What `Intl` accepts as a time zone. Anything else throws, which is the check. */
export function isIanaTimeZone(zone: string): boolean {
  if (!zone || zone.length > 100 || zone !== zone.trim()) return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The process zone, when the install has not chosen one. `UTC` if the process has none. */
export function processTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone && isIanaTimeZone(zone) ? zone : 'UTC';
}

/**
 * The zone schedules read. A stored name that `Intl` rejects is ignored —
 * a row written by hand, or from a backup of another OS — and the fallback
 * stands, rather than every schedule throwing the next time it is asked.
 */
export function timeZoneFrom(stored: string | null | undefined, fallback: string): string {
  const zone = (stored ?? '').trim();
  if (zone && isIanaTimeZone(zone)) return zone;
  return isIanaTimeZone(fallback) ? fallback : processTimeZone();
}
