import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { headerData } from '@/lib/header';

/** Releases (#345): the repositories set to release, each with its latest run. */

const bridge = vi.hoisted(() => ({ repos: [] as unknown }));

vi.mock('@/lib/api', () => ({
  api: { releases: async () => bridge.repos },
}));
vi.mock('@/lib/read-header', () => ({
  readHeader: async () => headerData({ repos: ['mac-app'], crew: [], budget: { spentUsd: 0, capUsd: 1500 }, needsYou: 0 }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
  usePathname: () => '/releases',
}));

async function page(): Promise<{ html: string; text: string }> {
  const { default: ReleasesPage } = await import('./page');
  const html = renderToStaticMarkup(await ReleasesPage()).replace(/<!-- -->/g, '');
  return { html, text: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') };
}

describe('the releases page', () => {
  it('lists each releasing repository, its latest run, and links to its page', async () => {
    bridge.repos = [
      {
        name: 'mac-app',
        fullName: 'acme/mac-app',
        releaseRepo: 'acme/mac-app-releases',
        latest: { id: 'r-1', state: 'running', version: null, sha: 'abc1234def5678abc1234def5678abc1234def56' },
      },
      { name: 'cli', fullName: 'acme/cli', releaseRepo: null, latest: { id: 'r-2', state: 'published', version: '2.1.0', sha: '1'.repeat(40) } },
      { name: 'docs', fullName: 'acme/docs', releaseRepo: null, latest: null },
    ];
    const { html, text } = await page();
    expect(html).toContain('href="/releases/mac-app"');
    expect(html).toContain('href="/releases/cli"');
    expect(text).toContain('publishes to acme/mac-app-releases');
    expect(text).toContain('Building · abc1234');
    expect(text).toContain('Published 2.1.0 · 1111111');
    expect(text).toContain('no release cut yet');
  });

  it('says how a repository is set to release when none is', async () => {
    bridge.repos = [];
    const { text } = await page();
    expect(text).toContain('No repository is set to release.');
  });
});
