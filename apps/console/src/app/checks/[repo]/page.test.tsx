import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CheckRow, ChecksView } from '@/lib/api';
import { BridgeAnswered } from '@/lib/bridge-answered';
import { headerData } from '@/lib/header';

/** A repository's Checks page (#372): flaky jobs first, the differs mark, and every state said. */

const row = (key: string, over: Partial<CheckRow> = {}): CheckRow => ({
  key,
  name: key,
  runsOn: 'github',
  covered: true,
  last: { result: 'pass', url: `https://github.com/acme/api/actions/runs/1/job/${key}`, at: null, detail: null },
  flaky: null,
  ...over,
});

const VIEW: ChecksView = {
  repo: 'api',
  fullName: 'acme/api',
  defaultBranch: 'main',
  workflow: { state: 'read', detail: null, path: '.github/workflows/ci.yml' },
  makefile: { state: 'read', detail: null },
  runs: { state: 'read', detail: null },
  flakes: { state: 'read', detail: null },
  rows: [
    row('integration', { covered: false, flaky: { count: 2, heads: [{ sha: 'c'.repeat(40), runUrl: 'https://github.com/acme/api/actions/runs/105', passedAt: null }, { sha: 'a'.repeat(40), runUrl: 'https://github.com/acme/api/actions/runs/101', passedAt: null }] } }),
    row('check'),
    row('host-check', { name: 'host check', runsOn: 'this machine', covered: undefined, command: 'make e2e', last: { result: 'fail', url: '/host-checks/hc1', at: null, detail: null } }),
  ],
  localCi: { sha: 'd'.repeat(40), ok: true, at: '2026-11-20T08:00:00Z' },
  readAt: '2026-11-20T10:00:00.000Z',
};

const bridge = vi.hoisted(() => ({ view: null as unknown }));

vi.mock('@/lib/api', () => ({
  api: {
    checks: async () => {
      if (bridge.view instanceof Error) throw bridge.view;
      return bridge.view;
    },
    repos: async () => ({ repos: [{ name: 'api' }] }),
  },
}));
vi.mock('@/lib/read-header', () => ({
  readHeader: async () => headerData({ repos: ['api'], crew: [], budget: { spentUsd: 0, capUsd: 1500 }, needsYou: 0 }),
}));
vi.mock('@/app/actions', () => ({ fileRequest: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
  usePathname: () => '/checks/api',
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));

async function page(repo = 'api'): Promise<{ html: string; text: string }> {
  const { default: ChecksPage } = await import('./page');
  const html = renderToStaticMarkup(await ChecksPage({ params: Promise.resolve({ repo }) })).replace(/<!-- -->/g, '');
  return { html, text: html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ') };
}

describe('a repository’s Checks page', () => {
  it('shows the flaky job first, with its heads, and the rows in the order the bridge ranked', async () => {
    bridge.view = VIEW;
    const { html, text } = await page();
    expect([...html.matchAll(/data-check="([^"]+)"/g)].map((match) => match[1])).toEqual(['integration', 'check', 'host-check']);
    expect(text).toContain('Checks of api');
    expect(text).toContain('2 heads: ccccccc , aaaaaaa');
    expect(html).toMatch(/data-file-task[^>]*>File as task/);
    expect(text).toContain('Local CI ( make ci ) on ddddddd : passed');
  });

  it('marks a job that never reaches make ci, and never the host check', async () => {
    bridge.view = VIEW;
    const { html } = await page();
    const rowOf = (key: string) => html.split(`data-check="${key}"`)[1]!.split('</tr>')[0]!;
    expect(rowOf('integration')).toContain('differs from GitHub');
    expect(rowOf('check')).not.toContain('differs from GitHub');
    expect(rowOf('host-check')).not.toContain('differs from GitHub');
    expect(rowOf('host-check')).toContain('this machine');
    expect(rowOf('host-check')).toContain('href="/host-checks/hc1"');
    expect(rowOf('check')).toContain('GitHub');
  });

  it('says a missing workflow rather than showing an empty table', async () => {
    bridge.view = { ...VIEW, workflow: { state: 'missing', detail: 'No `ci` workflow on main', path: null }, rows: [], localCi: null };
    const { html, text } = await page();
    expect(html).toContain('data-state="workflow"');
    expect(text).toContain('No `ci` workflow on main');
    expect(html).not.toContain('data-checks');
  });

  it('says an unparseable workflow and that coverage cannot be told', async () => {
    bridge.view = {
      ...VIEW,
      workflow: { state: 'unparseable', detail: 'The ci workflow could not be read: bad indentation (line 4)', path: '.github/workflows/ci.yml' },
      rows: [row('check', { covered: 'unknown' })],
    };
    const { text } = await page();
    expect(text).toContain('The ci workflow could not be read: bad indentation (line 4)');
    expect(text).toContain('cannot tell: workflow not read');
  });

  it('says GitHub could not be reached, and a partial flake scan', async () => {
    bridge.view = {
      ...VIEW,
      workflow: { state: 'unreachable', detail: 'getaddrinfo ENOTFOUND api.github.com', path: null },
      makefile: { state: 'unreachable', detail: 'x' },
      runs: { state: 'unreachable', detail: 'x' },
      flakes: { state: 'unreachable', detail: 'x' },
      rows: [VIEW.rows[2]!],
    };
    expect((await page()).text).toContain('GitHub could not be reached: getaddrinfo ENOTFOUND api.github.com');
    bridge.view = { ...VIEW, flakes: { state: 'partial', detail: 'Only part of the last 30 runs was read for flaky jobs' } };
    expect((await page()).text).toContain('Only part of the last 30 runs was read for flaky jobs');
  });

  it('is not found for a repository the install does not manage', async () => {
    bridge.view = new BridgeAnswered('/v1/repos/x/checks', 404, 'not managed');
    await expect(page('x')).rejects.toThrow('NOT_FOUND');
  });
});
