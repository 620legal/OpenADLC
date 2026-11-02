import { timeOf } from '@/lib/thread';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "14:02", or "1 Nov, 14:02" when it was not today, on the reader's clock. */
export function sinceWords(since: number, now: number, timeZone?: string): string {
  const day = (at: number) => new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
  const time = timeOf(new Date(since).toISOString(), timeZone);
  if (day(since) === day(now)) return time;
  const [date, month] = day(since).split('/');
  return `${Number(date)} ${MONTHS[Number(month) - 1]}, ${time}`;
}

/**
 * Says that what the page shows is what the bridge last said: the live
 * refresh could not reach it, and keeps the page as it was rather than
 * reading itself into "cannot reach the bridge" (`readUnlessUpdated`). It
 * goes on the first tick the bridge answers. `since` is the last read the
 * bridge answered.
 */
export function BridgeOfflineBanner({ since, now = Date.now(), timeZone }: { since: number; now?: number; timeZone?: string }) {
  return (
    <div role="status" className="shrink-0 border-b border-alarm/30 bg-alarm/5 px-4 py-2 md:px-6">
      <p className="text-[12.5px] text-soft">
        <span className="font-medium text-alarm">Can&apos;t reach OpenADLC since {sinceWords(since, now, timeZone)}.</span> What you see may be out of date.
      </p>
    </div>
  );
}
