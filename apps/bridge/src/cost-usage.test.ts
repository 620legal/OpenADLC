import { resetModelPrices, setModelPrice } from '@openadlc/engines';
import { beforeEach, describe, expect, it } from 'vitest';
import { bucketOf, parseRange, sinceOf, summarizeUsage, uncachedInput, USAGE_RANGES, type UsageInputRow, type UsageRange } from './cost-usage.js';

const NOW = new Date('2026-11-25T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Three models on two engines, billed and unbilled, with cache and without,
 * spread over the ranges. A row with both cache counts at 0 is one from before
 * the ledger recorded them (docs/adr/0092).
 */
const LEDGER = [
  { ago: 2 * HOUR, model: 'claude-opus-5', engine: 'claude', billed: true, costUsd: 1, tokensIn: 1_000_000, tokensOut: 1000, cacheRead: 600_000, cacheWrite: 100_000 },
  { ago: 2 * HOUR, model: 'gpt-5-codex', engine: 'codex', billed: false, costUsd: 0.5, tokensIn: 2_000_000, tokensOut: 2000, cacheRead: 1_000_000, cacheWrite: 0 },
  { ago: 3 * DAY, model: 'claude-sonnet-5', engine: 'claude', billed: true, costUsd: 2, tokensIn: 500_000, tokensOut: 500, cacheRead: 0, cacheWrite: 0 },
  { ago: 20 * DAY, model: 'claude-opus-5', engine: 'claude', billed: false, costUsd: 4, tokensIn: 1_000_000, tokensOut: 0, cacheRead: 1_000_000, cacheWrite: 0 },
  { ago: 60 * DAY, model: 'gpt-5-codex', engine: 'codex', billed: true, costUsd: 8, tokensIn: 100, tokensOut: 10, cacheRead: 0, cacheWrite: 0 },
  { ago: 200 * DAY, model: 'claude-sonnet-5', engine: 'claude', billed: true, costUsd: 16, tokensIn: 1000, tokensOut: 10, cacheRead: 0, cacheWrite: 0 },
];

/** What `costs.usageByModel` returns for a range: the fixture held to its start and summed per model, engine and billed. */
function rowsFor(range: UsageRange): UsageInputRow[] {
  const since = sinceOf(range, NOW);
  const groups = new Map<string, UsageInputRow>();
  for (const { ago, ...row } of LEDGER) {
    if (since && NOW.getTime() - ago < since.getTime()) continue;
    const key = `${row.model}|${row.engine}|${row.billed}`;
    const group = groups.get(key) ?? { ...row, costUsd: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, invocations: 0 };
    group.costUsd += row.costUsd;
    group.tokensIn += row.tokensIn;
    group.tokensOut += row.tokensOut;
    group.cacheRead += row.cacheRead;
    group.cacheWrite += row.cacheWrite;
    group.invocations += 1;
    groups.set(key, group);
  }
  return [...groups.values()];
}

function summaryFor(range: UsageRange) {
  return summarizeUsage({ range, now: NOW, rows: rowsFor(range), series: [], bots: [], ledger: [] });
}

beforeEach(() => resetModelPrices());

describe('the range a request names', () => {
  it('is one of the five, 30 days when none is named, and null for anything else', () => {
    expect(USAGE_RANGES).toEqual(['24h', '7d', '30d', '90d', 'all']);
    for (const range of USAGE_RANGES) expect(parseRange(range)).toBe(range);
    expect(parseRange(null)).toBe('30d');
    expect(parseRange('')).toBe('30d');
    for (const bad of ['1y', '30', 'All', '24H']) expect(parseRange(bad), bad).toBeNull();
  });

  it('starts that long before now, or never for all, in hours for a day and days otherwise', () => {
    expect(sinceOf('24h', NOW)?.toISOString()).toBe('2026-11-24T12:00:00.000Z');
    expect(sinceOf('7d', NOW)?.toISOString()).toBe('2026-11-18T12:00:00.000Z');
    expect(sinceOf('90d', NOW)?.toISOString()).toBe('2026-08-27T12:00:00.000Z');
    expect(sinceOf('all', NOW)).toBeNull();
    expect(bucketOf('24h')).toBe('hour');
    for (const range of ['7d', '30d', '90d', 'all'] as const) expect(bucketOf(range)).toBe('day');
  });
});

describe('a range’s totals', () => {
  // Savings per million cache-read tokens: opus $5 in less $0.50, codex $1.25 less $0.125.
  const expected: Record<UsageRange, { billed: number; estimate: number; savedBilled: number; savedEstimate: number; input: number; invocations: number }> = {
    '24h': { billed: 1, estimate: 0.5, savedBilled: 2.7, savedEstimate: 1.125, input: 1_300_000, invocations: 2 },
    '7d': { billed: 3, estimate: 0.5, savedBilled: 2.7, savedEstimate: 1.125, input: 1_800_000, invocations: 3 },
    '30d': { billed: 3, estimate: 4.5, savedBilled: 2.7, savedEstimate: 5.625, input: 1_800_000, invocations: 4 },
    '90d': { billed: 11, estimate: 4.5, savedBilled: 2.7, savedEstimate: 5.625, input: 1_800_100, invocations: 5 },
    all: { billed: 27, estimate: 4.5, savedBilled: 2.7, savedEstimate: 5.625, input: 1_801_100, invocations: 6 },
  };

  for (const range of USAGE_RANGES) {
    it(`are exact for ${range}, billed and estimated apart`, () => {
      const want = expected[range];
      const { totals, range: said } = summaryFor(range);
      expect(said).toBe(range);
      expect(totals.billedUsd).toBeCloseTo(want.billed, 10);
      expect(totals.estimateUsd).toBeCloseTo(want.estimate, 10);
      expect(totals.cacheSavings.billedUsd).toBeCloseTo(want.savedBilled, 10);
      expect(totals.cacheSavings.estimateUsd).toBeCloseTo(want.savedEstimate, 10);
      expect(totals.tokens.input).toBe(want.input);
      expect(totals.invocations).toBe(want.invocations);
    });
  }

  it('split tokens into uncached input, output, cache read and cache write', () => {
    expect(summaryFor('24h').totals.tokens).toEqual({ input: 1_300_000, output: 3000, cacheRead: 1_600_000, cacheWrite: 100_000 });
  });

  it('price the savings at the install’s prices once they are set', () => {
    setModelPrice('claude-opus-5', { inPerMtok: 10, outPerMtok: 50, cachedInPerMtok: 2 });
    expect(summaryFor('24h').totals.cacheSavings.billedUsd).toBeCloseTo(0.6 * 8, 10);
  });
});

describe('a range by model and by engine', () => {
  it('ranks the models dearest first, with each share taken within its own kind', () => {
    const { byModel } = summaryFor('30d');
    expect(byModel.map((row) => [row.model, row.engines, row.billedUsd, row.estimateUsd])).toEqual([
      ['claude-opus-5', ['claude'], 1, 4],
      ['claude-sonnet-5', ['claude'], 2, 0],
      ['gpt-5-codex', ['codex'], 0, 0.5],
    ]);
    expect(byModel.map((row) => row.share.billed)).toEqual([1 / 3, 2 / 3, 0]);
    expect(byModel.map((row) => row.share.estimate)).toEqual([4 / 4.5, 0, 0.5 / 4.5]);
  });

  it('gives shares that sum to 1 within each kind, for every range', () => {
    for (const range of USAGE_RANGES) {
      const { byModel, byEngine } = summaryFor(range);
      for (const rows of [byModel, byEngine]) {
        expect(rows.reduce((sum, row) => sum + row.share.billed, 0), range).toBeCloseTo(1, 3);
        expect(rows.reduce((sum, row) => sum + row.share.estimate, 0), range).toBeCloseTo(1, 3);
      }
    }
  });

  it('sums by engine', () => {
    const { byEngine } = summaryFor('all');
    expect(byEngine.map((row) => [row.engine, row.billedUsd, row.estimateUsd])).toEqual([
      ['claude', 19, 4],
      ['codex', 8, 0.5],
    ]);
  });

  it('gives a kind with nothing in it shares of 0, not a division by 0', () => {
    const rows = rowsFor('30d').filter((row) => !row.billed);
    const { byModel, totals } = summarizeUsage({ range: '30d', now: NOW, rows, series: [], bots: [], ledger: [] });
    expect(totals.billedUsd).toBe(0);
    expect(byModel.every((row) => row.share.billed === 0)).toBe(true);
    expect(byModel.map((row) => row.model)).toEqual(['claude-opus-5', 'gpt-5-codex']);
  });
});

describe('a row from before the cache columns', () => {
  it('counts all its input as uncached and saves $0', () => {
    const { byModel } = summaryFor('7d');
    const sonnet = byModel.find((row) => row.model === 'claude-sonnet-5');
    expect(sonnet?.tokens).toEqual({ input: 500_000, output: 500, cacheRead: 0, cacheWrite: 0 });
    expect(sonnet?.cacheSavings).toEqual({ billedUsd: 0, estimateUsd: 0 });
  });

  it('never makes uncached input negative', () => {
    expect(uncachedInput(10, 8, 5)).toBe(0);
    expect(uncachedInput(10, 0, 0)).toBe(10);
  });
});

describe('the range’s series', () => {
  it('keeps every bucket, a quiet one zeros, with tokens split the same way', () => {
    const { series } = summarizeUsage({
      range: '24h',
      now: NOW,
      rows: [],
      series: [
        { at: '2026-11-25T10:00:00Z', billedUsd: 1, estimateUsd: 0.5, tokensIn: 3_000_000, tokensOut: 3000, cacheRead: 1_600_000, cacheWrite: 100_000 },
        { at: '2026-11-25T11:00:00Z', billedUsd: 0, estimateUsd: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 },
      ],
      bots: [],
      ledger: [],
    });
    expect(series).toEqual([
      { at: '2026-11-25T10:00:00Z', billedUsd: 1, estimateUsd: 0.5, tokens: { input: 1_300_000, output: 3000, cacheRead: 1_600_000, cacheWrite: 100_000 } },
      { at: '2026-11-25T11:00:00Z', billedUsd: 0, estimateUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ]);
  });

  it('has no field anywhere that adds the estimate into billed spend', () => {
    const body = JSON.stringify(summaryFor('all'));
    expect(body).not.toMatch(/"(totalUsd|costUsd|spentUsd)"/);
  });
});
