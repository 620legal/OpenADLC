import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ReleaseReadiness, ReleaseRunView, ReleaseView } from '@/lib/api';
import { BridgeAnswered } from '@/lib/bridge-answered';
import { headerData } from '@/lib/header';

/** A repository's releases page (#345): the pinned view, Cut release, and the runs. */

const SHA = 'abc1234def5678abc1234def5678abc1234def56';

const VIEW: ReleaseView = {
  viewId: 'view-1',
  repo: 'mac-app',
  fullName: 'acme/mac-app',
  releaseRepo: 'acme/mac-app',
  sha: SHA,
  defaultBranch: 'main',
  last: { version: '1.4.0', tag: 'v1.4.0', url: 'https://github.com/acme/mac-app/releases/tag/v1.4.0' },
  version: { text: '1.5.0', after: '1.4.0' },
  compare: {
    first: false,
    status: 'ahead',
    aheadBy: 3,
    totalCommits: 3,
    commits: [
      { sha7: 'ddddddd', title: 'Add the export menu', author: 'ann' },
      { sha7: 'ccccccc', title: 'Fix the crash on open', author: null },
    ],
    files: 7,
    htmlUrl: 'https://github.com/acme/mac-app/compare/v1.4.0...abc1234',
  },
  mayCut: true,
  inFlight: null,
  expiresInSeconds: 900,
};

const RUN: ReleaseRunView = {
  id: 'r-1',
  runId: 'run-1',
  repo: 'mac-app',
  sha: '1'.repeat(40),
  state: 'published',
  clean: false,
  version: '1.4.0',
  previousVersion: '1.3.0',
  reason: null,
  logTail: null,
  tag: 'v1.4.0',
  releaseUrl: 'https://github.com/acme/mac-app/releases/tag/v1.4.0',
  requestedBy: 'jane',
  startedAt: '2026-11-14T10:00:00.000Z',
  finishedAt: '2026-11-14T10:30:00.000Z',
  publishedAt: '2026-11-14T10:31:00.000Z',
};

/** Six items, every check passing or failing alike; the last build is informational. */
function readiness(status: 'pass' | 'fail'): ReleaseReadiness {
  const ids = ['account', 'signing_key', 'recipe', 'release_tag', 'version', 'last_build'] as const;
  const titles = ['Release account', 'Signing key', 'Release recipe', 'Release tag', 'Next version', 'Last build'];
  return {
    repo: 'mac-app',
    fullName: 'acme/mac-app',
    checkedAt: '2026-11-26T08:00:00.000Z',
    items: ids.map((id, index) => ({
      id,
      title: titles[index] ?? id,
      status,
      says: `${titles[index]} ${status === 'pass' ? 'is fine' : 'is not'}`,
      ...(status === 'fail'
        ? { fix: id === 'signing_key' ? 'Run on the host: openadlc release-key import --repo acme/mac-app --file <path>' : `Fix the ${id}` }
        : {}),
      ...(id === 'last_build' ? { informational: true as const } : {}),
    })),
  };
}

const bridge = vi.hoisted(() => ({ view: null as unknown, runs: [] as unknown, readiness: null as unknown }));

vi.mock('@/lib/api', () => ({
  api: {
    releaseView: async () => {
      if (bridge.view instanceof Error) throw bridge.view;
      return bridge.view;
    },
    releaseRuns: async () => {
      if (bridge.runs instanceof Error) throw bridge.runs;
      return bridge.runs;
    },
    releaseReadiness: async () => {
      if (bridge.readiness instanceof Error) throw bridge.readiness;
      return bridge.readiness;
    },
  },
}));
vi.mock('@/lib/read-header', () => ({
  readHeader: async () => headerData({ repos: ['mac-app'], crew: [], budget: { spentUsd: 0, capUsd: 1500 }, needsYou: 0 }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
  usePathname: () => '/releases/mac-app',
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));

async function page(repo = 'mac-app'): Promise<{ html: string; text: string }> {
  const { default: ReleasePage } = await import('./page');
  const html = renderToStaticMarkup(await ReleasePage({ params: Promise.resolve({ repo }) })).replace(/<!-- -->/g, '');
  return { html, text: html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ') };
}

describe('a repository’s releases page', () => {
  it('shows the head it would cut in full, the last release, the compare and the version', async () => {
    bridge.view = VIEW;
    bridge.runs = [RUN];
    const { html, text } = await page();
    expect(text).toContain('Releases of mac-app');
    expect(text).toContain(`main at abc1234`);
    expect(html).toContain(SHA);
    expect(html).toContain('href="https://github.com/acme/mac-app/releases/tag/v1.4.0"');
    expect(text).toContain('3 commits and 7 files changed since v1.4.0.');
    expect(text).toContain('Add the export menu');
    expect(text).toContain('@ann');
    expect(text).toContain('and 1 more');
    expect(html).toContain('Open the compare on GitHub');
    expect(text).toContain('1.5.0, after 1.4.0');
    expect(html).toMatch(/<button[^>]*data-cut[^>]*>Cut release<\/button>/);
    expect(text).toContain('Clean build');
    // The runs below, a published one with its release.
    expect(text).toContain('Published');
    expect(html).toMatch(/data-release-link[^>]*>v1.4.0 on GitHub/);
  });

  it('shows the reason and no button when the view may not be cut', async () => {
    bridge.view = { ...VIEW, mayCut: false, why: '1.4.0 is not above the last release, 1.4.0: raise it in VERSION', version: null };
    bridge.runs = [];
    const { html, text } = await page();
    expect(html).not.toMatch(/<button[^>]*data-cut=/);
    expect(text).toContain('1.4.0 is not above the last release, 1.4.0: raise it in VERSION');
    expect(text).toContain('No release has been cut here yet.');
  });

  it('offers Prepare next version with the suggestion in an editable field when the version is not above (#363)', async () => {
    bridge.view = {
      ...VIEW,
      mayCut: false,
      why: '1.4.0 is not above the last release, 1.4.0: raise it in VERSION',
      version: { text: '1.4.0', after: '1.4.0' },
      prepare: { suggested: '1.4.1', last: { version: '1.4.0', tag: 'v1.4.0' }, versionFile: 'VERSION', versionKey: null },
      preparing: null,
    };
    bridge.runs = [];
    const { html, text } = await page();
    expect(html).toMatch(/<input[^>]*data-prepare-version[^>]*value="1.4.1"/);
    expect(html).toMatch(/<button[^>]*data-prepare-send[^>]*>Send<\/button>/);
    expect(text).toContain('Prepare next version');
    expect(text).toContain('Once it merges, Cut release offers 1.4.1 after 1.4.0.');
    expect(html).not.toMatch(/<button[^>]*data-cut=/);
    expect(html).not.toContain('data-preparing');
  });

  it('shows the open preparation, its issue and pull request, instead of offering it again', async () => {
    bridge.view = {
      ...VIEW,
      mayCut: false,
      why: '1.4.0 is not above the last release, 1.4.0: raise it in VERSION',
      prepare: null,
      preparing: {
        requestId: 'abcdef12-0000-4000-8000-000000000001',
        subject: 'request:abcdef12',
        state: 'filed',
        version: '1.4.1',
        issue: { number: 400, url: 'https://github.com/acme/mac-app/issues/400' },
        pullRequest: { number: 401, url: 'https://github.com/acme/mac-app/pull/401', state: 'unknown' },
        unknown: true,
      },
    };
    bridge.runs = [];
    const { html, text } = await page();
    expect(html).not.toContain('data-prepare-send');
    expect(text).toContain('Preparing 1.4.1');
    expect(html).toContain('href="/?item=request%3Aabcdef12"');
    expect(html).toContain('href="https://github.com/acme/mac-app/issues/400"');
    expect(text).toContain('Pull request #401, state unknown');
    expect(text).toContain('State unknown');
  });

  it('offers neither on a view without them, as from an older bridge', async () => {
    bridge.view = { ...VIEW, mayCut: false, why: 'aaaaaaa does not contain v1.4.0, so it cannot be released after it.' };
    bridge.runs = [];
    const { html } = await page();
    expect(html).not.toContain('data-prepare');
  });

  it('says a first release', async () => {
    bridge.view = { ...VIEW, last: null, compare: { first: true }, version: { text: '1.0.0', after: null } };
    bridge.runs = [];
    const { text } = await page();
    expect(text).toContain('No release yet; this cuts the first one from abc1234.');
    expect(text).toContain('1.0.0, the first release');
  });

  it('says the bridge’s refusal of the view, with the runs still shown', async () => {
    bridge.view = new BridgeAnswered('/v1/repos/mac-app/release/views', 404, 'mac-app has no release recipe; an admin sets it in Settings → mac-app → Release.');
    bridge.runs = [{ ...RUN, state: 'publish_failed', reason: 'GitHub refused the tag: a ruleset blocks it', releaseUrl: null }];
    const { html, text } = await page();
    expect(text).toContain('mac-app has no release recipe');
    expect(html).not.toMatch(/<button[^>]*data-cut=/);
    expect(text).toContain('Publish failed');
    expect(text).toContain('GitHub refused the tag: a ruleset blocks it');
  });

  it('opens with how a release is cut, open, and a link to its ADR (#373)', async () => {
    bridge.view = VIEW;
    bridge.runs = [];
    const { html, text } = await page();
    expect(html).toMatch(/data-how-this-works="releases"[\s\S]*<button[^>]*aria-expanded="true"[^>]*>[\s\S]*How a release is cut/);
    expect(text).toContain('You approve a device code with your own GitHub account.');
    expect(html).toContain(
      'href="https://github.com/620legal/OpenADLC/blob/main/docs/adr/0072-a-release-is-cut-by-an-approver-from-a-pinned-view-with-a-fresh-device-code-proof.md"',
    );
    expect(html.indexOf('data-how-this-works')).toBeLessThan(html.indexOf('data-cut'));
  });

  it('shows the readiness checklist above Cut release, with each failing item’s fix (#371)', async () => {
    bridge.view = VIEW;
    bridge.runs = [];
    bridge.readiness = readiness('fail');
    const { html, text } = await page();
    expect(html.indexOf('data-readiness')).toBeGreaterThan(-1);
    expect(html.indexOf('data-readiness')).toBeLessThan(html.indexOf('data-cut'));
    expect(text).toContain('Signing key');
    expect(text).toContain('Run on the host: openadlc release-key import --repo acme/mac-app --file <path>'.replace('<', '&lt;').replace('>', '&gt;'));
    expect(html).toMatch(/data-readiness-item="last_build"/);
    expect(text).toContain('For information');
  });

  it('draws Cut release the same whether every item passes or fails (#371)', async () => {
    bridge.view = VIEW;
    bridge.runs = [RUN];
    const cutOf = (html: string) => html.slice(html.indexOf('<h2 class="text-[13px] font-semibold text-body">Cut release'));
    bridge.readiness = readiness('fail');
    const failing = (await page()).html;
    bridge.readiness = readiness('pass');
    const passing = (await page()).html;
    bridge.readiness = new BridgeAnswered('/v1/repos/mac-app/release/readiness', 503, 'hostd is down');
    const unread = (await page()).html;
    expect(cutOf(failing)).toMatch(/<button[^>]*data-cut[^>]*>Cut release<\/button>/);
    expect(cutOf(failing)).toBe(cutOf(passing));
    expect(cutOf(unread)).toBe(cutOf(passing));
  });

  it('shows the checklist beside a refused view too', async () => {
    bridge.view = new BridgeAnswered('/v1/repos/mac-app/release/views', 404, 'mac-app has no release recipe; an admin sets it in Settings → mac-app → Release.');
    bridge.runs = [];
    bridge.readiness = readiness('fail');
    const { html } = await page();
    expect(html).toContain('data-readiness-item="recipe"');
  });

  it('is not found for a repository the bridge does not have', async () => {
    bridge.view = new BridgeAnswered('/v1/repos/nope/release/views', 404, 'nope is not a repository this install manages.');
    bridge.runs = new BridgeAnswered('/v1/repos/nope/releases', 404, 'nope is not a repository this install manages.');
    await expect(page('nope')).rejects.toThrow('NOT_FOUND');
  });
});
