import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CostsView, CostUsageView, UsageFigures } from '@/lib/api';

const read = vi.hoisted(() => ({ costs: null as CostsView | null, usage: null as CostUsageView | null, ranges: [] as string[] }));

const answer = vi.hoisted(() => ({ error: null as Error | null }));

vi.mock('@/lib/api', () => ({
  USAGE_RANGES: ['24h', '7d', '30d', '90d', 'all'],
  api: {
    costs: async () => {
      if (!read.costs) throw answer.error ?? new Error('fetch failed');
      return read.costs;
    },
    costUsage: async (range: string) => {
      read.ranges.push(range);
      if (!read.usage) throw new Error('the bridge answered 404 to /v1/costs/usage');
      return { ...read.usage, range };
    },
    crew: async () => ({ bots: [] }),
    repos: async () => ({ repos: [] }),
    attention: async () => ({ items: [] }),
  },
  waitingCount: () => 0,
}));

function figures(partial: Partial<UsageFigures> = {}): UsageFigures {
  return {
    billedUsd: 0,
    estimateUsd: 0,
    invocations: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cacheSavings: { billedUsd: 0, estimateUsd: 0 },
    ...partial,
  };
}

/** A range with a billed model, a subscription one, and a row from before the cache columns. */
function usage(): CostUsageView {
  const opus = figures({
    billedUsd: 3,
    estimateUsd: 4,
    invocations: 3,
    tokens: { input: 300_000, output: 1000, cacheRead: 1_600_000, cacheWrite: 100_000 },
    cacheSavings: { billedUsd: 2.7, estimateUsd: 4.5 },
  });
  return {
    range: '30d',
    since: '2026-10-26T12:00:00.000Z',
    until: '2026-11-25T12:00:00.000Z',
    bucket: 'day',
    totals: figures({ ...opus, billedUsd: 5, estimateUsd: 4, invocations: 4 }),
    byModel: [
      { ...opus, model: 'claude-opus-5', engines: ['claude'], share: { billed: 0.6, estimate: 1 } },
      { ...figures({ billedUsd: 2, invocations: 1 }), model: 'claude-sonnet-5', engines: ['claude'], share: { billed: 0.4, estimate: 0 } },
    ],
    byEngine: [{ ...opus, billedUsd: 5, engine: 'claude', share: { billed: 1, estimate: 1 } }],
    byBot: [{ bot: 'builder', billedUsd: 5, estimateUsd: 4, tasks: 2 }],
    series: [
      { at: '2026-11-24T00:00:00Z', billedUsd: 0, estimateUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { at: '2026-11-25T00:00:00Z', billedUsd: 5, estimateUsd: 4, tokens: { input: 300_000, output: 1000, cacheRead: 1_600_000, cacheWrite: 100_000 } },
    ],
    ledger: [
      { id: 2, botId: 'b', engine: 'claude', model: 'claude-opus-5', tokensIn: 1_000_000, tokensOut: 10, cacheRead: 600_000, cacheWrite: 100_000, costUsd: 1, billed: true, at: '2026-11-25T10:00:00Z' },
      // Written before the ledger kept cache counts: both 0.
      { id: 1, botId: 'b', engine: 'claude', model: 'claude-sonnet-5', tokensIn: 500, tokensOut: 5, cacheRead: 0, cacheWrite: 0, costUsd: 2, billed: false, at: '2026-11-20T10:00:00Z' },
    ],
  };
}

async function render(params: Record<string, string> = {}): Promise<string> {
  const { default: CostsPage } = await import('./page');
  return renderToStaticMarkup(await CostsPage({ searchParams: Promise.resolve(params) })).replace(/<!-- -->/g, '');
}

function costs(budget: CostsView['budget']): CostsView {
  return { period: budget.period, budget, perTaskCapUsd: 5, byBot: [], byRepo: [], byDay: [], ledger: [], stoppedAtCap: [] };
}

describe('the costs page', () => {
  it('says the bridge is not answering, as every other page does, when the costs cannot be read', async () => {
    read.costs = null;
    const { default: CostsPage } = await import('./page');
    const html = renderToStaticMarkup(await CostsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('The console cannot reach the bridge');
    expect(html).toContain('fetch failed');
  });

  it('says the bridge answered with an error, and where to look, rather than to start a stack that is up', async () => {
    const { BridgeAnswered } = await import('@/lib/bridge-answered');
    answer.error = new BridgeAnswered('/v1/costs', 500, 'the database is not answering');
    try {
      const { default: CostsPage } = await import('./page');
      const html = renderToStaticMarkup(await CostsPage({ searchParams: Promise.resolve({}) })).replace(/<!-- -->/g, '');
      expect(html).toContain('The bridge answered with an error');
      expect(html).toContain('the bridge answered 500 to /v1/costs: the database is not answering');
      expect(html).toContain('openadlc logs bridge');
      expect(html).not.toContain('cannot reach the bridge');
    } finally {
      answer.error = null;
    }
  });

  it('colours the bar by the budget’s state, and says leasing stops at the cap', async () => {
    // An install that warns at 75 percent: at 80 the bridge says warning, which
    // a bar that turned only at 90 would have shown as fine.
    read.costs = costs({ period: '2026-10', capUsd: 1000, spentUsd: 800, state: 'warning' });
    const { default: CostsPage } = await import('./page');
    const html = renderToStaticMarkup(await CostsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('class="h-full bg-attention" style="width:80%"');
    expect(html).toContain('At the monthly cap the dispatcher stops leasing new work');
    expect(html).not.toContain('At 90 percent');
  });

  it('opens with what counts toward the caps, open, and a link to its ADR (#373)', async () => {
    read.costs = costs({ period: '2026-10', capUsd: 1000, spentUsd: 10, state: 'ok' });
    const { default: CostsPage } = await import('./page');
    const html = renderToStaticMarkup(await CostsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toMatch(/data-how-this-works="costs"[\s\S]*<button[^>]*aria-expanded="true"[^>]*>[\s\S]*What counts toward the caps/);
    expect(html).toContain('A run on a subscription is an estimate');
    expect(html).toContain('href="https://github.com/620legal/OpenADLC/blob/main/docs/adr/0050-a-subscription-run-is-estimated-not-billed.md"');
    expect(html.indexOf('data-how-this-works')).toBeLessThan(html.indexOf('month to date'));
  });
});

describe('the costs page’s range (#368)', () => {
  const month = () => costs({ period: '2026-11', capUsd: 1000, spentUsd: 10, state: 'ok' });

  it('reads 30 days by default and the range the URL names, and keeps an unknown one at 30 days', async () => {
    read.costs = month();
    read.usage = usage();
    read.ranges = [];
    await render();
    await render({ range: '24h' });
    await render({ range: 'all' });
    await render({ range: '1y' });
    expect(read.ranges).toEqual(['30d', '24h', 'all', '30d']);
  });

  it('offers the five ranges, each keeping the chart’s mode, and the toggle keeping the range', async () => {
    read.costs = month();
    read.usage = usage();
    const html = await render({ range: '7d', show: 'tokens' });
    const picker = /<nav aria-label="Range"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '';
    expect([...picker.matchAll(/href="([^"]+)"[^>]*>([^<]+)</g)].map((match) => `${match[2]} ${match[1]!.replace(/&amp;/g, '&')}`)).toEqual([
      '24 hours /costs?range=24h&show=tokens',
      '7 days /costs?range=7d&show=tokens',
      '30 days /costs?range=30d&show=tokens',
      '90 days /costs?range=90d&show=tokens',
      'All time /costs?range=all&show=tokens',
    ]);
    expect(picker).toMatch(/aria-current="true"[^>]*href="\/costs\?range=7d&amp;show=tokens"/);
    const toggle = /<nav aria-label="Chart"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '';
    expect(toggle).toContain('href="/costs?range=7d&amp;show=cost"');
    expect(toggle).toMatch(/aria-current="true"[^>]*href="\/costs\?range=7d&amp;show=tokens"/);
    expect(html).toContain('data-usage-chart="tokens"');
    expect(await render({ range: '7d' })).toContain('data-usage-chart="cost"');
  });

  it('puts this month — the cap, CI minutes and stopped at the cap — above the picker', async () => {
    read.costs = { ...month(), stoppedAtCap: [{ id: 't', subjectRef: 'api#1', costUsd: 15 }] };
    read.usage = usage();
    const html = await render();
    const picker = html.indexOf('aria-label="Range"');
    expect(html.indexOf('data-this-month')).toBeGreaterThan(-1);
    expect(html.indexOf('data-this-month')).toBeLessThan(html.indexOf('month to date'));
    expect(html.indexOf('month to date')).toBeLessThan(picker);
    expect(html.indexOf('Stopped at the cap')).toBeLessThan(picker);
    expect(html.indexOf('data-range-totals')).toBeGreaterThan(picker);
  });

  it('labels every estimated figure, and never adds it into billed', async () => {
    read.costs = month();
    read.usage = usage();
    const html = await render();
    const totals = /<section data-range-totals[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    expect(totals).toContain('$5.00');
    expect(totals).toContain('$4.00 est.');
    expect(totals).not.toContain('$9.00');
    expect(html).toContain('Cache savings (estimate)');
    expect(html).toContain('$2.70');
    expect(html).toContain('$4.50 est.');
    expect(html).toContain("title=\"cache-read tokens priced at the input rate less the cache-read rate, at today&#x27;s prices\"");
    const byModel = /<section data-breakdown="By model"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    expect(byModel).toContain('claude-opus-5');
    expect(byModel).toContain('60%');
    expect(byModel).toContain('$4.00 est.');
    expect(html).toContain('data-breakdown="By engine"');
  });

  it('splits tokens four ways, and shows each invocation’s cache read and write', async () => {
    read.costs = month();
    read.usage = usage();
    const html = await render();
    const tokens = /<section data-tokens[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    for (const label of ['input (uncached)', 'output', 'cache read', 'cache write']) expect(tokens).toContain(label);
    expect(tokens).toContain('300k');
    expect(tokens).toContain('1.6M');
    const ledger = /<table data-ledger[\s\S]*?<\/table>/.exec(html)?.[0] ?? '';
    expect(ledger).toContain('<th class="py-1 pr-3 text-right font-medium">cache read</th>');
    expect(ledger).toContain('600,000');
  });

  it('renders a range of rows from before the cache columns, with $0 of savings', async () => {
    read.costs = month();
    const old = usage();
    old.totals = figures({ billedUsd: 2, invocations: 1, tokens: { input: 500, output: 5, cacheRead: 0, cacheWrite: 0 } });
    old.byModel = [old.byModel[1]!];
    old.ledger = [old.ledger[1]!];
    read.usage = old;
    const html = await render();
    const savings = /<section data-cache-savings[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    expect(savings).toContain('$0.00');
    expect(savings).toContain('$0.00 est.');
    expect(html).toContain('claude-sonnet-5');
    // A subscription row on the ledger is marked as an estimate.
    expect(/<table data-ledger[\s\S]*?<\/table>/.exec(html)?.[0]).toContain('$2.0000<span class="text-dim"> est.</span>');
  });

  it('still shows the month when the range cannot be read', async () => {
    read.costs = month();
    read.usage = null;
    const html = await render();
    expect(html).toContain('month to date');
    expect(html).toContain('The usage for this range could not be read: the bridge answered 404 to /v1/costs/usage');
  });
});
