/**
 * Up to a week, every bar carries its own date and amount. Past that there is
 * no room for a label per bar on a phone, so the ends of the period and the
 * busiest day are named instead.
 */
export const LABELLED_DAYS = 7;

function dollars(value: number): string {
  return value >= 100 ? `$${value.toFixed(0)}` : `$${value.toFixed(2)}`;
}

/** `2026-09-18` as `09-18`: the period is one month, so the year says nothing. */
function shortDay(day: string): string {
  return day.slice(5);
}

/**
 * Spend per day as bars.
 *
 * The figures are written on the page, not only in a `title`. A tooltip is
 * nothing on touch, and a single day of data drawn as one bar the width of the
 * panel with nothing written on it read as a broken element rather than as a
 * chart. The bars are also capped in width, so a few days are a few bars.
 */
export function DayBars({ days }: { days: { day: string; costUsd: number }[] }) {
  const peak = days.reduce((top, day) => (day.costUsd > top.costUsd ? day : top), days[0] ?? { day: '', costUsd: 0 });
  const scale = Math.max(peak.costUsd, 0.01);
  const labelled = days.length <= LABELLED_DAYS;
  // Leaves room above the tallest bar for its amount.
  const tallest = labelled ? 72 : 92;

  return (
    <div className="mt-3">
      <div className="flex h-24 items-end gap-1">
        {days.map((day) => (
          <div
            key={day.day}
            className="flex h-full min-w-0 max-w-10 flex-1 flex-col items-center justify-end gap-1"
            title={`${day.day}: $${day.costUsd.toFixed(2)}`}
          >
            {labelled && (
              <span className="whitespace-nowrap text-[10px] tabular-nums text-soft">{dollars(day.costUsd)}</span>
            )}
            {/* Every day of the month is a bar, a quiet one a hairline: never
                narrower than 4px, a $0 day drew like a few cents. */}
            {day.costUsd > 0 ? (
              <div
                className="w-full rounded-t bg-signal/70"
                style={{ height: `${Math.max(4, (day.costUsd / scale) * tallest)}px` }}
              />
            ) : (
              <div data-quiet className="h-px w-full bg-edge" />
            )}
          </div>
        ))}
      </div>

      {labelled ? (
        <div className="mt-1 flex gap-1">
          {days.map((day) => (
            <span
              key={day.day}
              className="min-w-0 max-w-10 flex-1 text-center font-mono text-[10px] text-muted"
            >
              {shortDay(day.day)}
            </span>
          ))}
        </div>
      ) : (
        <div className="mt-1 flex items-baseline justify-between gap-2 font-mono text-[10px] text-muted">
          <span>{shortDay(days[0]?.day ?? '')}</span>
          <span className="font-sans text-soft">
            most on {shortDay(peak.day)}: <span className="tabular-nums">{dollars(peak.costUsd)}</span>
          </span>
          <span>{shortDay(days[days.length - 1]?.day ?? '')}</span>
        </div>
      )}
    </div>
  );
}
