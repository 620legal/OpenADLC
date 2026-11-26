import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectMapRead } from '@/lib/api';
import { BridgeAnswered } from '@/lib/bridge-answered';
import { headerData } from '@/lib/header';

/** A repository's Map page (#380): its project map, the commit it was built from and when. */

const SHA = 'abc1234def5678abc1234def5678abc1234def56';

const MAP: ProjectMapRead = {
  repo: 'acme/widgets',
  commit: SHA,
  builtAt: '2026-11-25T10:00:00.000Z',
  state: 'written',
  error: null,
  triedAt: '2026-11-25T10:00:00.000Z',
  content: [
    '<!-- openadlc-project-map v1 -->',
    '# Project map: acme/widgets',
    '',
    `- Commit: ${SHA} (default branch \`main\`)`,
    '- Built at: 2026-11-25T10:00:00.000Z',
    '',
    '## Areas and packages',
    '',
    '### `apps/api` — @acme/api',
    '- Owns: The HTTP API',
    '',
  ].join('\n'),
};

const bridge = vi.hoisted(() => ({ map: null as unknown, asked: [] as string[] }));

vi.mock('@/lib/api', () => ({
  api: {
    projectMap: async (repo: string) => {
      bridge.asked.push(repo);
      if (bridge.map instanceof Error) throw bridge.map;
      return bridge.map;
    },
  },
}));
vi.mock('@/lib/read-header', () => ({
  readHeader: async () => headerData({ repos: ['acme/widgets'], crew: [], budget: { spentUsd: 0, capUsd: 1500 }, needsYou: 0 }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
  usePathname: () => '/map/acme%2Fwidgets',
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));

async function page(repo = 'acme%2Fwidgets'): Promise<{ html: string; text: string }> {
  const { default: MapPage } = await import('./page');
  const html = renderToStaticMarkup(await MapPage({ params: Promise.resolve({ repo }) })).replace(/<!-- -->/g, '');
  return { html, text: html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ') };
}

describe('a repository’s Map page', () => {
  it('shows the map, the commit it was built from with its link, and when', async () => {
    bridge.map = MAP;
    bridge.asked = [];
    const { html, text } = await page();
    expect(bridge.asked).toEqual(['acme/widgets']);
    expect(text).toContain('Map of acme/widgets');
    expect(text).toContain('Built from abc1234 on 2026-11-25 at 10:00 UTC');
    expect(html).toContain(`href="https://github.com/acme/widgets/commit/${SHA}"`);
    expect(html).toContain('<p class="font-semibold">Areas and packages</p>');
    expect(text).toContain('The HTTP API');
    // The format line is hostd's, not the reader's.
    expect(html).not.toContain('openadlc-project-map');
    expect(html).not.toContain('data-map-failed');
    expect(html).not.toContain('data-map-none');
  });

  it('says plainly when there is no map yet', async () => {
    bridge.map = { ...MAP, commit: null, builtAt: null, state: 'never', triedAt: null, content: null };
    const { html, text } = await page();
    expect(text).toContain('acme/widgets has no project map yet. It is built within 15 minutes of the repository being added, by the maps job.');
    expect(html).not.toContain('data-map-built');
    expect(html).not.toContain('data-map-failed');
  });

  it('gives the reason when there is no map because building it failed', async () => {
    bridge.map = { ...MAP, commit: null, builtAt: null, state: 'failed', error: 'git fetch failed: could not read from remote', content: null };
    const { text } = await page();
    expect(text).toContain('has no project map yet');
    expect(text).toContain('The last attempt failed: git fetch failed: could not read from remote');
  });

  it('says the last rebuild failed above a map kept from an earlier commit', async () => {
    bridge.map = { ...MAP, state: 'failed', error: 'git fetch failed' };
    const { html, text } = await page();
    expect(text).toContain('The last rebuild failed (git fetch failed); this is the map built from abc1234.');
    expect(html.indexOf('data-map-failed')).toBeLessThan(html.indexOf('data-map='));
    expect(html).toContain('<p class="font-semibold">Areas and packages</p>');
  });

  it('is not found for a repository the bridge does not manage', async () => {
    bridge.map = new BridgeAnswered('/v1/repos/nope/map', 404, 'not a repository OpenADLC manages: nope');
    await expect(page('nope')).rejects.toThrow('NOT_FOUND');
  });

  it('says the bridge is down when it cannot be read', async () => {
    bridge.map = new Error('fetch failed');
    const { html } = await page();
    expect(html).not.toContain('Map of');
    expect(html).toContain('fetch failed');
  });
});
