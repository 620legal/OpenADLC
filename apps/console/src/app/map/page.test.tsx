import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { headerData } from '@/lib/header';

/** Map (#380): the managed repositories, each linking to its project map. */

const bridge = vi.hoisted(() => ({ repos: [] as string[], down: false, asked: 0 }));

vi.mock('@/lib/api', () => ({
  api: {
    projectMap: async () => {
      bridge.asked += 1;
      return null;
    },
  },
}));
vi.mock('@/lib/read-header', () => ({
  readHeader: async () => {
    if (bridge.down) throw new Error('fetch failed');
    return headerData({ repos: bridge.repos, crew: [], budget: { spentUsd: 0, capUsd: 1500 }, needsYou: 0 });
  },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
  usePathname: () => '/map',
}));

async function page(): Promise<{ html: string; text: string }> {
  const { default: MapsPage } = await import('./page');
  const html = renderToStaticMarkup(await MapsPage()).replace(/<!-- -->/g, '');
  return { html, text: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') };
}

describe('the Map page', () => {
  it('lists every managed repository as a link to its map, reading no map itself', async () => {
    bridge.repos = ['widgets', 'my web'];
    bridge.down = false;
    bridge.asked = 0;
    const { html, text } = await page();
    expect(html).toContain('href="/map/widgets"');
    expect(html).toContain('href="/map/my%20web"');
    expect(text).toContain('widgets');
    expect(bridge.asked).toBe(0);
  });

  it('says when no repository is managed yet', async () => {
    bridge.repos = [];
    const { html, text } = await page();
    expect(text).toContain('No repository is managed yet.');
    expect(html).not.toContain('data-maps');
  });

  it('says the bridge is down when the header cannot be read', async () => {
    bridge.down = true;
    try {
      const { html } = await page();
      expect(html).toContain('fetch failed');
    } finally {
      bridge.down = false;
    }
  });
});
