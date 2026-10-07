import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CostsView } from '@/lib/api';

const read = vi.hoisted(() => ({ costs: null as CostsView | null }));

const answer = vi.hoisted(() => ({ error: null as Error | null }));

vi.mock('@/lib/api', () => ({
  api: {
    costs: async () => {
      if (!read.costs) throw answer.error ?? new Error('fetch failed');
      return read.costs;
    },
    crew: async () => ({ bots: [] }),
    repos: async () => ({ repos: [] }),
    attention: async () => ({ items: [] }),
  },
  waitingCount: () => 0,
}));

function costs(budget: CostsView['budget']): CostsView {
  return { period: budget.period, budget, perTaskCapUsd: 5, byBot: [], byRepo: [], byDay: [], ledger: [], stoppedAtCap: [] };
}

describe('the costs page', () => {
  it('says the bridge is not answering, as every other page does, when the costs cannot be read', async () => {
    read.costs = null;
    const { default: CostsPage } = await import('./page');
    const html = renderToStaticMarkup(await CostsPage());
    expect(html).toContain('The console cannot reach the bridge');
    expect(html).toContain('fetch failed');
  });

  it('says the bridge answered with an error, and where to look, rather than to start a stack that is up', async () => {
    const { BridgeAnswered } = await import('@/lib/bridge-answered');
    answer.error = new BridgeAnswered('/v1/costs', 500, 'the database is not answering');
    try {
      const { default: CostsPage } = await import('./page');
      const html = renderToStaticMarkup(await CostsPage()).replace(/<!-- -->/g, '');
      expect(html).toContain('The bridge answered with an error');
      expect(html).toContain('the bridge answered 500 to /v1/costs: the database is not answering');
      expect(html).toContain('fleetadlc logs bridge');
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
    const html = renderToStaticMarkup(await CostsPage());
    expect(html).toContain('class="h-full bg-attention" style="width:80%"');
    expect(html).toContain('At the monthly cap the dispatcher stops leasing new work');
    expect(html).not.toContain('At 90 percent');
  });
});
