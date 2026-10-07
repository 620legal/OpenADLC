import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { headerData } from '@/lib/header';

/**
 * `/settings/spending` is where a cap is changed. Settings only summarises the
 * two global amounts and links here.
 */

type Me = { known: true; email: string; role: 'admin' | 'user'; identityMode: 'local' | 'iap' };
const ADMIN: Me = { known: true, email: 'janedoe@example.com', role: 'admin', identityMode: 'iap' };
const who = vi.hoisted(() => ({ me: null as unknown as Me }));
who.me = ADMIN;

vi.mock('@/lib/api', () => ({
  readMe: async () => who.me,
  api: {
    repos: async () => ({
      repos: [{ name: 'api', fullName: 'exampleco/api', concurrency: 1, owner: null, stageModes: {}, specRequiredLabels: [], color: 'blue' }],
      maxReviewRounds: 3,
    }),
    crew: async () => ({ bots: [] }),
    costs: async () => ({ budget: { period: '2026-09', capUsd: 1500, spentUsd: 7.51, state: 'ok' }, perTaskCapUsd: 15 }),
    spendingLimits: async () => ({
      period: '2026-09',
      global: {
        monthTotal: { amountUsd: 1500, spentUsd: 7.51 },
        task: { amountUsd: 15, spentUsd: null },
        bots: [{ botId: 'bot-1', name: 'builder', amountUsd: null, spentUsd: 2 }],
        providers: [{ provider: 'openai', amountUsd: null, spentUsd: 2 }],
      },
      repos: [
        {
          repoId: 'repo-1',
          name: 'api',
          fullName: 'exampleco/api',
          monthTotal: { amountUsd: 200, spentUsd: 1, globalUsd: 1500 },
          task: { amountUsd: null, spentUsd: null, globalUsd: 15 },
          bots: [{ botId: 'bot-1', name: 'builder', amountUsd: null, spentUsd: 1, globalUsd: null }],
          providers: [{ provider: 'openai', amountUsd: null, spentUsd: 1, globalUsd: null }],
        },
      ],
    }),
  },
}));
vi.mock('@/lib/read-header', () => ({
  readHeader: async () => headerData({ repos: ['api'], crew: [], budget: { spentUsd: 7.51, capUsd: 1500 }, needsYou: 0 }),
}));

describe('the spending limits page', () => {
  it('edits the caps under Global and Repositories, and links back to the summary', async () => {
    const { default: SpendingSettingsPage } = await import('./page');
    const html = renderToStaticMarkup(await SpendingSettingsPage()).replace(/<!-- -->/g, '');
    expect(html).toMatch(/<a [^>]*href="\/settings#spending-limits"[^>]*>/);
    expect([...html.matchAll(/role="tab"[^>]*>([^<]+)<\/button>/g)].map((match) => match[1])).toEqual(['Global', 'Repositories']);
    expect(html).toContain('Each bot');
    expect(html).toContain('Each provider');
    expect(html).toContain('exampleco/api');
    expect(html).toContain('$7.51 spent this month');
    expect(html).toContain('placeholder="uses $1,500"');
    expect(html).toContain('>Save<');
    expect(html).not.toContain('id="spending-limits"');
  });

  it('is an admin’s: a user is told so, and shown no caps to change', async () => {
    who.me = { known: true, email: 'bob@example.com', role: 'user', identityMode: 'iap' };
    try {
      const { default: SpendingSettingsPage } = await import('./page');
      const html = renderToStaticMarkup(await SpendingSettingsPage()).replace(/<!-- -->/g, '');
      expect(html).toContain('Spending limits need an admin');
      expect(html).toContain('bob@example.com');
      expect(html).not.toContain('>Save<');
    } finally {
      who.me = ADMIN;
    }
  });
});
