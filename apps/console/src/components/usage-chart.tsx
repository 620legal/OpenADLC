import type { CostUsageView, UsageTokens } from '@/lib/api';

export type UsageChartMode = 'cost' | 'tokens';

/**
 * Past this many buckets there is no room for a label per bar, so the ends
 * of the range and the busiest bucket are named instead, as `DayBars` does.
 */
export const LABELLED_BUCKETS = 8;

/** The token types in the order they stack, bottom up, each with its fixed colour: never re-coloured by rank. */
export const TOKEN_SERIES: readonly { key: keyof UsageTokens; label: string; fill: string }[] = [
  { key: 'input', label: 'input', fill: 'bg-repo-blue' },
  { key: 'output', label: 'output', fill: 'bg-repo-orange' },
  { key: 'cacheRead', label: 'cache read', fill: 'bg-repo-teal' },
  { key: 'cacheWrite', label: 'cache write', fill: 'bg-repo-violet' },
];

/** An estimate is the billed colour, hatched: it reads apart without colour, in print and to a colour-blind eye. */
const HATCH = 'repeating-linear-gradient(135deg, var(--color-link) 0 2px, transparent 2px 5px)';

function dollars(value: number): string {
  return value >= 100 ? `$${value.toFixed(0)}` : `$${value.toFixed(2)}`;
}

export function tokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

/** An hour bucket as `14:00`, a day as `11-18`, both in UTC as the bridge counts them. */
export function bucketLabel(at: string, bucket: CostUsageView['bucket']): string {
  return bucket === 'hour' ? at.slice(11, 16) : at.slice(5, 10);
}

function tokensOf(tokens: UsageTokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

/**
 * The range's series as bars: one per hour for 24 hours and per UTC day
 * otherwise, a quiet one a hairline. In cost mode billed and estimated stand
 * beside each other, never stacked into one figure (docs/adr/0050); in tokens
 * mode the four types stack. Every bar says its figures on hover, and the
 * legend names every series, so nothing is told by colour alone.
 */
export function UsageChart({ usage, mode }: { usage: Pick<CostUsageView, 'series' | 'bucket'>; mode: UsageChartMode }) {
  const { series, bucket } = usage;
  const valueOf = (point: CostUsageView['series'][number]) =>
    mode === 'cost' ? Math.max(point.billedUsd, point.estimateUsd) : tokensOf(point.tokens);
  const peak = series.reduce((top, point) => (valueOf(point) > valueOf(top) ? point : top), series[0]);
  const scale = Math.max(peak ? valueOf(peak) : 0, mode === 'cost' ? 0.01 : 1);
  const labelled = series.length <= LABELLED_BUCKETS;
  const tallest = 88;
  const say = (value: number) => (mode === 'cost' ? dollars(value) : tokenCount(value));

  if (series.length === 0 || series.every((point) => valueOf(point) === 0)) {
    return (
      <p data-usage-chart="empty" className="mt-2 text-[11px] text-dim">
        {mode === 'cost' ? 'nothing spent in this range' : 'no tokens in this range'}
      </p>
    );
  }

  return (
    <div data-usage-chart={mode} className="mt-3">
      <ul aria-label="Legend" className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-[10.5px] text-muted">
        {mode === 'cost' ? (
          <>
            <li className="flex items-center gap-1">
              <span className="inline-block size-2 rounded-sm bg-link" /> billed
            </li>
            <li className="flex items-center gap-1">
              <span className="inline-block size-2 rounded-sm" style={{ backgroundImage: HATCH }} /> estimated, not billed
            </li>
          </>
        ) : (
          TOKEN_SERIES.map((one) => (
            <li key={one.key} className="flex items-center gap-1">
              <span className={`inline-block size-2 rounded-sm ${one.fill}`} /> {one.label}
            </li>
          ))
        )}
      </ul>

      <div className="flex h-24 items-end gap-0.5">
        {series.map((point) => {
          const label = bucketLabel(point.at, bucket);
          const title =
            mode === 'cost'
              ? `${label}: ${dollars(point.billedUsd)} billed · ${dollars(point.estimateUsd)} est.`
              : `${label}: ${TOKEN_SERIES.map((one) => `${tokenCount(point.tokens[one.key])} ${one.label}`).join(' · ')}`;
          const total = valueOf(point);
          return (
            <div
              key={point.at}
              data-bucket={point.at}
              className="flex h-full min-w-0 max-w-10 flex-1 items-end justify-center gap-0.5"
              title={title}
            >
              {total === 0 ? (
                <div data-quiet className="h-px w-full bg-edge" />
              ) : mode === 'cost' ? (
                <>
                  <div
                    data-kind="billed"
                    className="w-1/2 rounded-t bg-link"
                    style={{ height: point.billedUsd > 0 ? `${Math.max(2, (point.billedUsd / scale) * tallest)}px` : '1px' }}
                  />
                  <div
                    data-kind="estimate"
                    className="w-1/2 rounded-t"
                    style={{
                      height: point.estimateUsd > 0 ? `${Math.max(2, (point.estimateUsd / scale) * tallest)}px` : '1px',
                      backgroundImage: HATCH,
                    }}
                  />
                </>
              ) : (
                <div className="flex w-full flex-col-reverse gap-px" style={{ height: `${Math.max(2, (total / scale) * tallest)}px` }}>
                  {TOKEN_SERIES.map((one) =>
                    point.tokens[one.key] > 0 ? (
                      <div
                        key={one.key}
                        data-kind={one.key}
                        className={`w-full basis-0 last:rounded-t ${one.fill}`}
                        style={{ flexGrow: point.tokens[one.key] }}
                      />
                    ) : null,
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {labelled ? (
        <div className="mt-1 flex gap-0.5">
          {series.map((point) => (
            <span key={point.at} className="min-w-0 max-w-10 flex-1 text-center font-mono text-[10px] text-muted">
              {bucketLabel(point.at, bucket)}
            </span>
          ))}
        </div>
      ) : (
        <div className="mt-1 flex items-baseline justify-between gap-2 font-mono text-[10px] text-muted">
          <span>{bucketLabel(series[0]!.at, bucket)}</span>
          {peak && (
            <span className="font-sans text-soft">
              most at {bucketLabel(peak.at, bucket)}: <span className="tabular-nums">{say(valueOf(peak))}</span>
            </span>
          )}
          <span>{bucketLabel(series[series.length - 1]!.at, bucket)}</span>
        </div>
      )}
    </div>
  );
}
