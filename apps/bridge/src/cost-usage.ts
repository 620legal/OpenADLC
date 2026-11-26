import { cacheReadSavingsUsd } from '@openadlc/engines';
import type { LedgerEntry } from '@openadlc/shared';

/**
 * What the Costs page shows for a range: `GET /v1/costs/usage?range=`
 * (docs/adr/0091-the-costs-page-reads-usage-by-range-and-the-header-chip-follows-the-budget-state.md).
 *
 * Billed and estimated are never summed into one figure, anywhere in it: a
 * subscription run is priced as if billed and shown beside billed spend, and
 * one total of both would read as spend it is not (docs/adr/0050). For the
 * same reason a breakdown's share is taken within its own kind. Nothing here
 * feeds a cap: those read `monthSpend` and `refreshBudget`.
 */

export const USAGE_RANGES = ['24h', '7d', '30d', '90d', 'all'] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];
export type UsageBucket = 'hour' | 'day';

/** Tokens by how they are billed. `input` is the uncached part of what the ledger calls tokens in. */
export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** 0..1 of its own kind's total, and 0 when that kind's total is 0. */
export interface Share {
  billed: number;
  estimate: number;
}

export interface Usage {
  billedUsd: number;
  estimateUsd: number;
  invocations: number;
  tokens: Tokens;
  /** Always an estimate: cache-read tokens at the input rate less the cache-read rate, at today's prices. */
  cacheSavings: { billedUsd: number; estimateUsd: number };
}

export interface CostUsage {
  range: UsageRange;
  /** ISO; null for all. */
  since: string | null;
  /** ISO: the bridge's now. */
  until: string;
  bucket: UsageBucket;
  totals: Usage;
  /** Dearest first, by billed and estimated together, which only orders and is never shown. */
  byModel: (Usage & { model: string; engines: string[]; share: Share })[];
  byEngine: (Usage & { engine: string; share: Share })[];
  byBot: { bot: string; billedUsd: number; estimateUsd: number; tasks: number }[];
  /** Every bucket of the range, a quiet one zeros. */
  series: { at: string; billedUsd: number; estimateUsd: number; tokens: Tokens }[];
  /** The latest in the range. */
  ledger: LedgerEntry[];
}

/** One row of `costs.usageByModel`: the ledger summed per model, engine and billed. */
export interface UsageInputRow {
  model: string;
  engine: string;
  billed: boolean;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  invocations: number;
}

/** One row of `costs.usageSeries`. */
export interface SeriesInputRow {
  at: string;
  billedUsd: number;
  estimateUsd: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
}

/** The range a request names; none is `30d`, and anything else is null, which the route refuses. */
export function parseRange(value: string | null | undefined): UsageRange | null {
  if (value === null || value === undefined || value === '') return '30d';
  return (USAGE_RANGES as readonly string[]).includes(value) ? (value as UsageRange) : null;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SPAN: Record<Exclude<UsageRange, 'all'>, number> = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, '90d': 90 * DAY };

/** Where a range starts, counted back from `now`; null for all. */
export function sinceOf(range: UsageRange, now: Date): Date | null {
  return range === 'all' ? null : new Date(now.getTime() - SPAN[range]);
}

/** An hour a bar for a day; a UTC day a bar otherwise, as the month's chart counts days. */
export function bucketOf(range: UsageRange): UsageBucket {
  return range === '24h' ? 'hour' : 'day';
}

/** Tokens in less what was read from and written to the cache, never below 0 (docs/adr/0092). */
export function uncachedInput(tokensIn: number, cacheRead: number, cacheWrite: number): number {
  return Math.max(0, tokensIn - cacheRead - cacheWrite);
}

function emptyUsage(): Usage {
  return {
    billedUsd: 0,
    estimateUsd: 0,
    invocations: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cacheSavings: { billedUsd: 0, estimateUsd: 0 },
  };
}

function add(into: Usage, row: UsageInputRow): void {
  const savings = cacheReadSavingsUsd(row.model, row.cacheRead);
  if (row.billed) {
    into.billedUsd += row.costUsd;
    into.cacheSavings.billedUsd += savings;
  } else {
    into.estimateUsd += row.costUsd;
    into.cacheSavings.estimateUsd += savings;
  }
  into.invocations += row.invocations;
  into.tokens.input += uncachedInput(row.tokensIn, row.cacheRead, row.cacheWrite);
  into.tokens.output += row.tokensOut;
  into.tokens.cacheRead += row.cacheRead;
  into.tokens.cacheWrite += row.cacheWrite;
}

function shareOf(part: Usage, total: Usage): Share {
  return {
    billed: total.billedUsd > 0 ? part.billedUsd / total.billedUsd : 0,
    estimate: total.estimateUsd > 0 ? part.estimateUsd / total.estimateUsd : 0,
  };
}

function dearestFirst(a: Usage & { name: string }, b: Usage & { name: string }): number {
  return b.billedUsd + b.estimateUsd - (a.billedUsd + a.estimateUsd) || a.name.localeCompare(b.name);
}

export function summarizeUsage(input: {
  range: UsageRange;
  now: Date;
  rows: readonly UsageInputRow[];
  series: readonly SeriesInputRow[];
  bots: readonly { bot: string; billedUsd: number; estimateUsd: number; tasks: number }[];
  ledger: readonly LedgerEntry[];
}): CostUsage {
  const totals = emptyUsage();
  const models = new Map<string, Usage & { name: string; engines: Set<string> }>();
  const engines = new Map<string, Usage & { name: string }>();
  for (const row of input.rows) {
    add(totals, row);
    const model = models.get(row.model) ?? { ...emptyUsage(), name: row.model, engines: new Set<string>() };
    add(model, row);
    model.engines.add(row.engine);
    models.set(row.model, model);
    const engine = engines.get(row.engine) ?? { ...emptyUsage(), name: row.engine };
    add(engine, row);
    engines.set(row.engine, engine);
  }
  const since = sinceOf(input.range, input.now);

  return {
    range: input.range,
    since: since ? since.toISOString() : null,
    until: input.now.toISOString(),
    bucket: bucketOf(input.range),
    totals,
    byModel: [...models.values()].sort(dearestFirst).map(({ name, engines: used, ...usage }) => ({
      ...usage,
      model: name,
      engines: [...used].sort(),
      share: shareOf(usage, totals),
    })),
    byEngine: [...engines.values()].sort(dearestFirst).map(({ name, ...usage }) => ({
      ...usage,
      engine: name,
      share: shareOf(usage, totals),
    })),
    byBot: input.bots.map((bot) => ({ ...bot })),
    series: input.series.map((bucket) => ({
      at: bucket.at,
      billedUsd: bucket.billedUsd,
      estimateUsd: bucket.estimateUsd,
      tokens: {
        input: uncachedInput(bucket.tokensIn, bucket.cacheRead, bucket.cacheWrite),
        output: bucket.tokensOut,
        cacheRead: bucket.cacheRead,
        cacheWrite: bucket.cacheWrite,
      },
    })),
    ledger: [...input.ledger],
  };
}
