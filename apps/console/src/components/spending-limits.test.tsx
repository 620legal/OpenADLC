import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { changesOf, limitKey, notAnAmount, SpendingLimits, SpendingLimitsPanel, SpendingSummary } from './spending-limits';
import type { SpendingLimitsView } from '@/lib/api';

/**
 * Settings summarises the two global caps and links to the page that edits
 * them. A blank repository field is "use the global one"; the monthly total
 * and the per-task cap are never blank.
 */

function view(): SpendingLimitsView {
  return {
    period: '2026-09',
    global: {
      monthTotal: { amountUsd: 1500, spentUsd: 7.51 },
      task: { amountUsd: 15, spentUsd: null },
      bots: [
        { botId: 'bot-1', name: 'builder', amountUsd: null, spentUsd: 2 },
        { botId: 'bot-2', name: 'builder-2', amountUsd: 40, spentUsd: 0 },
      ],
      providers: [{ provider: 'openai', amountUsd: null, spentUsd: 2 }],
    },
    repos: [
      {
        repoId: 'repo-1',
        name: 'api',
        fullName: 'exampleco/api',
        monthTotal: { amountUsd: 200, spentUsd: 1, globalUsd: 1500 },
        task: { amountUsd: null, spentUsd: null, globalUsd: 15 },
        bots: [
          { botId: 'bot-1', name: 'builder', amountUsd: null, spentUsd: 1, globalUsd: null },
          { botId: 'bot-2', name: 'builder-2', amountUsd: null, spentUsd: 0, globalUsd: 40 },
        ],
        providers: [{ provider: 'openai', amountUsd: null, spentUsd: 1, globalUsd: null }],
      },
    ],
  };
}

describe('what a save sends', () => {
  it('sends only a field that changed, and a cleared one as no cap', () => {
    const current = view();
    const drafts: Record<string, string> = {};
    const fill = (scope: string, kind: string, amount: number | null) => {
      drafts[limitKey(scope, kind)] = amount == null ? '' : String(amount);
    };
    fill('global', 'month_total', 100);
    fill('global', 'task', 15);
    fill('global', 'month_bot:bot-1', null);
    fill('global', 'month_bot:bot-2', null);
    fill('global', 'month_provider:openai', null);
    fill('repo:repo-1', 'month_total', 200);
    fill('repo:repo-1', 'task', null);
    fill('repo:repo-1', 'month_bot:bot-1', null);
    fill('repo:repo-1', 'month_bot:bot-2', null);
    fill('repo:repo-1', 'month_provider:openai', null);

    expect(changesOf(current, drafts)).toEqual({
      changes: [
        { scope: 'global', kind: 'month_total', amountUsd: 100 },
        { scope: 'global', kind: 'month_bot:bot-2', amountUsd: null },
      ],
      invalid: [],
    });
  });
});

describe('an amount that is not one', () => {
  it('is said, by the field’s name, with what to write instead, rather than skipped', () => {
    const current = view();
    const drafts: Record<string, string> = {
      [limitKey('global', 'month_bot:bot-1')]: '$500',
      [limitKey('global', 'task')]: '200',
    };
    // Skipped, the bot's cap was not saved, and its field went back to blank: no cap.
    expect(changesOf(current, drafts)).toEqual({
      changes: [{ scope: 'global', kind: 'task', amountUsd: 200 }],
      invalid: [{ id: limitKey('global', 'month_bot:bot-1'), text: '$500' }],
    });
    expect(notAnAmount('builder', '$1,500')).toBe('builder: $1,500 is not an amount in dollars; write 1500');
    expect(notAnAmount('Each task', 'lots')).toBe('Each task: lots is not an amount in dollars; write a number of dollars, such as 500');
  });
});

describe('the settings summary', () => {
  it('shows the global month and the per-task cap, a spend bar, and the link to edit them', () => {
    const html = renderToStaticMarkup(<SpendingSummary initial={view()} />);
    expect(html).toContain('id="spending-limits"');
    expect(html).toContain('Each month');
    expect(html).toContain('$1,500');
    expect(html).toContain('$7.51 spent this month');
    expect(html).toContain('Each task');
    expect(html).toContain('$15');
    expect(html).toContain('role="meter"');
    expect(html).toMatch(/<a [^>]*href="\/settings\/spending"[^>]*>Edit limits<\/a>/);
    expect(html).not.toContain('<input');
    expect(html).not.toContain('>Save<');
  });
});

describe('limits that could not be read', () => {
  it('says what happened and what to do, on the summary and on the page', () => {
    for (const html of [renderToStaticMarkup(<SpendingSummary initial={null} />), renderToStaticMarkup(<SpendingLimits initial={null} />)]) {
      expect(html).toContain('OpenADLC could not read the spending limits from the bridge. Reload the page; if it keeps happening, run fleetadlc doctor.');
    }
  });
});

describe('the spending page', () => {
  it('has a Global tab and a Repositories tab, and this month’s spend beside each value', () => {
    const html = renderToStaticMarkup(
      <SpendingLimitsPanel view={view()} busy={false} notice={null} error={null} onSave={() => undefined} />,
    );
    expect(html).toContain('first time OpenADLC starts');
    expect([...html.matchAll(/role="tab"[^>]*>([^<]+)<\/button>/g)].map((match) => match[1])).toEqual(['Global', 'Repositories']);
    expect(html).toContain('Each bot');
    expect(html).toContain('Each provider');
    expect(html).toContain('$7.51 spent this month');
    expect(html).toContain('exampleco/api');
    expect(html).toContain('Blank uses the global cap');
    expect(html).toContain('aria-label="Each month"');
    expect(html).toContain('value="1500"');
    expect(html).toContain('value="15"');
    expect(html).toContain('aria-label="builder"');
    expect(html).toContain('aria-label="builder-2"');
    expect(html).toContain('value="40"');
    expect(html).toContain('placeholder="uses $1,500"');
    expect(html).toContain('placeholder="uses $40"');
    expect(html).toContain('placeholder="no cap"');
    expect(html).toContain('>Save<');
    expect(html).not.toContain('id="spending-limits"');
  });
});
