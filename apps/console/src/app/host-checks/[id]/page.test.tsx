import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { headerData } from '@/lib/header';

/** A host check run's own page, which its `host-check` status and its card link to (#327). */
const RUN = {
  id: '0b6f1d1c-6c55-4c1c-9a59-1f4a4b8f2a10',
  runId: 'run-1',
  repoName: 'mac-app',
  repoFullName: 'acme/mac-app',
  prNumber: 7,
  headSha: 'abc1234def5678abc1234def5678abc1234def56',
  state: 'failed',
  carriedFrom: null,
  command: 'make host-ci',
  timeoutMinutes: 90,
  exitCode: 65,
  durationMs: 42 * 60_000,
  logTail: "xcodebuild: error: no such module 'Foo'",
  reason: null,
  startedAt: '2026-11-14T10:00:00.000Z',
  finishedAt: '2026-11-14T10:42:00.000Z',
};

const bridge = vi.hoisted(() => ({ answer: null as unknown }));

vi.mock('@/lib/api', () => ({
  api: {
    hostCheck: async () => {
      if (bridge.answer instanceof Error) throw bridge.answer;
      return bridge.answer;
    },
  },
}));
vi.mock('@/lib/read-header', () => ({
  readHeader: async () => headerData({ repos: ['mac-app'], crew: [], budget: { spentUsd: 0, capUsd: 1500 }, needsYou: 0 }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
  usePathname: () => '/host-checks/x',
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));

async function page(id: string): Promise<string> {
  const { default: HostCheckPage } = await import('./page');
  return renderToStaticMarkup(await HostCheckPage({ params: Promise.resolve({ id }) })).replace(/<!-- -->/g, '');
}

describe('a host check run’s page', () => {
  it('says what ran, on which head, how it ended, and the end of its log', async () => {
    bridge.answer = RUN;
    const html = await page(RUN.id);
    const text = html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
    expect(text).toContain('Host check on mac-app#7');
    expect(text).toContain('acme/mac-app#7');
    expect(text).toContain('abc1234');
    expect(text).toContain('Failed');
    expect(text).toContain('make host-ci');
    expect(text).toContain('90 min');
    expect(text).toContain('42 min');
    expect(text).toContain('Exit code 65');
    expect(html).toContain('data-log');
    expect(text).toContain("xcodebuild: error: no such module 'Foo'");
  });

  it('opens with how a host check works, open, and a link to its ADR (#373)', async () => {
    bridge.answer = RUN;
    const html = await page(RUN.id);
    expect(html).toMatch(/data-how-this-works="host-checks"[\s\S]*<button[^>]*aria-expanded="true"[^>]*>[\s\S]*How a host check works/);
    expect(html).toContain('The merge reads the bridge’s own record of the run');
    expect(html).toContain(
      'href="https://github.com/620legal/OpenADLC/blob/main/docs/adr/0064-a-host-check-runs-as-its-own-account-and-the-merge-reads-the-bridges-record.md"',
    );
    expect(html.indexOf('data-how-this-works')).toBeLessThan(html.indexOf('data-host-check-facts'));
  });

  it('is not found for a run the bridge does not know', async () => {
    const { BridgeAnswered } = await import('@/lib/bridge-answered');
    bridge.answer = new BridgeAnswered('/v1/host-checks/nope', 404, 'no such host check run');
    await expect(page('nope')).rejects.toThrow('NOT_FOUND');
  });
});
