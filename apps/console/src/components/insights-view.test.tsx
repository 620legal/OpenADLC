import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { InsightSummary, InsightsView } from '@/lib/api';
import { duration, InsightsBody, kTokens, sentBackFrom } from './insights-view';

const H = 60 * 60 * 1000;

function summary(over: Partial<InsightSummary> = {}): InsightSummary {
  return {
    merged: 0,
    perDay: 0,
    cycleMs: null,
    stages: { intake: null, design: null, build: null, review: null, mergeLine: null },
    overlap: { waits: 0, byKind: { exclusive: 0, building: 0 }, totalWaitMs: 0, medianWaitMs: null, hotFiles: [] },
    conflicts: { resolvedLeadOnly: 0, resolvedFull: 0, sentBack: 0, resolving: 0 },
    sendBacks: {},
    parallel: { max: 0, average: 0 },
    implementInput: [],
    ...over,
  };
}

function view(over: Partial<InsightsView> = {}, overall = summary()): InsightsView {
  return { days: 7, since: '2026-09-25T12:00:00.000Z', overall, repos: [{ repo: 'api', ...overall }], suggestions: [], ...over };
}

const render = (insights: InsightsView, repo: string | null = null) =>
  renderToStaticMarkup(<InsightsBody insights={insights} repos={['api', 'web']} repo={repo} />).replace(/<!-- -->/g, '');

describe('the Insights page', () => {
  it('says plainly when nothing waited, and shows no numbers it does not have', () => {
    const html = render(view());
    expect(html).toContain('No waiting on overlap in the last 7 days.');
    expect(html).toContain('Request to merge');
    expect(html).toContain('>—<');
    expect(html).not.toContain('aria-label="Suggestions"');
  });

  it('lists the files work waited on with how often and how long, and suggests splitting one', () => {
    const busy = summary({
      merged: 4,
      perDay: 0.57,
      cycleMs: 5 * H,
      stages: { intake: H, design: null, build: 2 * H, review: H, mergeLine: 0.5 * H },
      overlap: {
        waits: 5,
        byKind: { exclusive: 1, building: 4 },
        totalWaitMs: 2 * H + 10 * 60_000,
        medianWaitMs: 20 * 60_000,
        hotFiles: [{ path: 'Makefile', waits: 5, waitedMs: 2 * H + 10 * 60_000 }],
      },
      conflicts: { resolvedLeadOnly: 2, resolvedFull: 0, sentBack: 1, resolving: 0 },
      sendBacks: { review: 2 },
      parallel: { max: 2, average: 1.4 },
    });
    const html = render(
      view({ suggestions: [{ repo: 'api', path: 'Makefile', waits: 5, text: 'Makefile held up 5 builds this week — consider splitting it (include mk/*.mk, one file per feature)' }] }, busy),
    );
    expect(html).toContain('Makefile');
    expect(html).toContain('blocked 5 builds, 2h 10m waiting');
    expect(html).toContain('Makefile held up 5 builds this week — consider splitting it');
    expect(html).toContain('5h');
    expect(html).toContain('sent back to build');
    expect(html).toContain('from review');
  });

  it('names where a send-back came from as the board names the stage', () => {
    expect(sentBackFrom('spec')).toBe('from design');
    expect(sentBackFrom('merged')).toBe('from ship');
    expect(sentBackFrom('unknown')).toBe('from a stage not recorded');
  });

  it('offers every repository and both periods as links, the chosen one marked', () => {
    const html = render(view({ days: 30 }), 'web');
    expect(html).toMatch(/<a[^>]*aria-current="true"[^>]*href="\/insights\?repo=web&amp;days=30"[^>]*>web<\/a>/);
    expect(html).toMatch(/<a[^>]*href="\/insights\?repo=web"[^>]*>7 days<\/a>/);
    expect(html).toContain('href="/insights?days=30"');
  });

  it('shows each week’s input tokens per implement task, and no figure for a week under 5 tasks', () => {
    const week = (weekStart: string, over: Partial<InsightSummary['implementInput'][number]>) => ({
      weekStart,
      tasks: 0,
      byRun: { billed: 0, subscription: 0, mixed: 0 },
      p25: null,
      median: null,
      p75: null,
      ...over,
    });
    const html = render(
      view(
        {},
        summary({
          implementInput: [
            week('2026-09-14T00:00:00.000Z', {}),
            week('2026-09-21T00:00:00.000Z', { tasks: 4, byRun: { billed: 4, subscription: 0, mixed: 0 } }),
            week('2026-09-28T00:00:00.000Z', { tasks: 7, byRun: { billed: 2, subscription: 5, mixed: 0 }, p25: 182_400, median: 251_000, p75: 1_420_000 }),
          ],
        }),
      ),
    );
    expect(html).toContain('Input tokens per implement task');
    expect(html).toMatch(/data-week="2026-09-28"[^]*?7 \(2 billed, 5 subscription\)[^]*?182k · 251k · 1,420k/);
    expect(html).toMatch(/data-week="2026-09-21"[^]*?>4<[^]*?fewer than 5 tasks/);
    // The newest week first.
    expect(html.indexOf('2026-09-28')).toBeLessThan(html.indexOf('2026-09-21'));
    expect(html).toContain('docs/runbooks/compare-implement-input-tokens.md');
  });

  it('reads a token count in thousands', () => {
    expect(kTokens(1_240)).toBe('1.2k');
    expect(kTokens(350_400)).toBe('350k');
    expect(kTokens(2_140_000)).toBe('2,140k');
  });

  it('reads a length of time as a person does', () => {
    expect(duration(null)).toBe('—');
    expect(duration(30_000)).toBe('30s');
    expect(duration(12 * 60_000)).toBe('12m');
    expect(duration(2 * H + 10 * 60_000)).toBe('2h 10m');
    expect(duration(76 * H)).toBe('3d 4h');
  });
});
