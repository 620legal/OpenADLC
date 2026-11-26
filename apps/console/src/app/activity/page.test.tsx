import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { headerData } from '@/lib/header';

/** Activity (#374): the crew's last thirty days, in the shell, its filters from the address. */

const bridge = vi.hoisted(() => ({ down: false }));

vi.mock('@/lib/read-header', () => ({
  readHeader: async () => {
    if (bridge.down) throw new Error('fetch failed');
    return headerData({ repos: ['OpenADLC', 'website'], crew: [], budget: { spentUsd: 0, capUsd: 1500 }, needsYou: 0 });
  },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
  usePathname: () => '/activity',
}));

async function page(searchParams: Record<string, string | string[]> = {}): Promise<string> {
  const { default: ActivityPage } = await import('./page');
  return renderToStaticMarkup(await ActivityPage({ searchParams: Promise.resolve(searchParams) })).replace(/<!-- -->/g, '');
}

describe('the Activity page', () => {
  it('draws the list in the shell, with Activity as the page on screen', async () => {
    const html = await page();
    expect(html).toContain('<h1 class="text-[16px] font-semibold text-body">Activity</h1>');
    expect(html).toContain('data-activity-feed');
    expect(html).toMatch(/<a aria-current="page"[^>]*href="\/activity">Activity<\/a>/);
  });

  it('starts from the repository and bot the address names, so a narrowed view can be shared', async () => {
    const html = await page({ repo: 'website', bot: 'builder' });
    expect(html).toMatch(/data-activity-feed[\s\S]*<option value="website" selected="">website<\/option>/);
  });

  it('ignores a filter named twice rather than guessing which', async () => {
    const html = await page({ repo: ['website', 'OpenADLC'] });
    expect(html).toMatch(/data-activity-feed[\s\S]*<option value="" selected="">All repositories<\/option>/);
  });

  it('says the bridge is down when the header cannot be read', async () => {
    bridge.down = true;
    try {
      expect(await page()).toContain('fetch failed');
    } finally {
      bridge.down = false;
    }
  });
});
