import { describe, expect, it, vi } from 'vitest';
import type { ProjectMapView } from './hostd-client.js';
import { PROJECT_MAP_FORCE_EVERY_MS, ProjectMapRefresher } from './project-map.js';

const SHA = 'abcdef1234567890abcdef1234567890abcdef12';

function view(repo: string, state: ProjectMapView['state'], extra: Partial<ProjectMapView> = {}): ProjectMapView {
  return { repo, path: `/w/maps/${repo.replace('/', '__')}.md`, commit: SHA, builtAt: null, state, error: null, triedAt: null, ...extra };
}

function setup(options: { repos?: { fullName: string; defaultBranch: string | null }[]; listed?: ProjectMapView[] } = {}) {
  let clock = Date.parse('2026-11-25T00:00:00Z');
  const repos = options.repos ?? [
    { fullName: 'acme/one', defaultBranch: 'main' },
    { fullName: 'acme/two', defaultBranch: 'trunk' },
  ];
  const hostd = {
    refreshProjectMap: vi.fn(async (repo: string, _input: { defaultBranch: string; bot: string; force?: boolean }) => ({ map: view(repo, 'unchanged') })),
    projectMaps: vi.fn(async () => ({ maps: options.listed ?? [] })),
    removeProjectMap: vi.fn(async () => ({ deleted: true })),
  };
  const refresher = new ProjectMapRefresher({
    repositories: { listRepos: async () => repos },
    hostd: hostd as never,
    bot: async () => 'automation-bot',
    now: () => new Date(clock),
  });
  return { refresher, hostd, advance: (ms: number) => (clock += ms) };
}

describe('ProjectMapRefresher', () => {
  it('asks hostd once per managed repository, with its default branch and the automation bot', async () => {
    const { refresher, hostd } = setup();
    await refresher.refreshAll();
    expect(hostd.refreshProjectMap.mock.calls).toEqual([
      ['acme/one', { defaultBranch: 'main', bot: 'automation-bot', force: true }],
      ['acme/two', { defaultBranch: 'trunk', bot: 'automation-bot', force: true }],
    ]);
  });

  it('forces the first pass and one a day after it, not the ones between', async () => {
    const { refresher, hostd, advance } = setup({ repos: [{ fullName: 'acme/one', defaultBranch: null }] });
    const forced = () => hostd.refreshProjectMap.mock.calls.map((call) => Boolean(call[1].force));

    await refresher.refreshAll();
    advance(15 * 60_000);
    await refresher.refreshAll();
    advance(PROJECT_MAP_FORCE_EVERY_MS - 15 * 60_000);
    await refresher.refreshAll();
    advance(15 * 60_000);
    await refresher.refreshAll({ force: true });

    expect(forced()).toEqual([true, false, true, true]);
    expect(hostd.refreshProjectMap.mock.calls[0]?.[1]).toMatchObject({ defaultBranch: 'main' });
  });

  it('says which maps were rebuilt and which failed, and nothing for one unchanged', async () => {
    const { refresher, hostd } = setup({
      repos: [
        { fullName: 'acme/one', defaultBranch: 'main' },
        { fullName: 'acme/two', defaultBranch: 'main' },
        { fullName: 'acme/three', defaultBranch: 'main' },
        { fullName: 'acme/four', defaultBranch: 'main' },
      ],
    });
    hostd.refreshProjectMap
      .mockResolvedValueOnce({ map: view('acme/one', 'written') })
      .mockResolvedValueOnce({ map: view('acme/two', 'failed', { error: 'fetch failed' }) })
      .mockResolvedValueOnce({ map: view('acme/three', 'unchanged') })
      .mockRejectedValueOnce(new Error('hostd is not answering'));

    expect(await refresher.refreshAll()).toEqual([
      'acme/one: project map rebuilt at abcdef1',
      'acme/two: project map could not be rebuilt: fetch failed',
      'acme/four: could not ask hostd for its project map: hostd is not answering',
    ]);
  });

  it('removes the map of a repository no longer managed', async () => {
    const { refresher, hostd } = setup({ listed: [view('acme/one', 'never'), view('gone/old', 'never')] });
    const lines = await refresher.refreshAll();
    expect(hostd.removeProjectMap.mock.calls).toEqual([['gone/old']]);
    expect(lines).toContain('gone/old: removed its project map, since it is no longer managed');
  });

  it('joins a pass already going rather than starting a second', async () => {
    const { refresher, hostd } = setup({ repos: [{ fullName: 'acme/one', defaultBranch: 'main' }] });
    let release: () => void = () => undefined;
    hostd.refreshProjectMap.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ map: view('acme/one', 'written') }))),
    );

    const first = refresher.refreshAll();
    const second = refresher.refreshAll();
    await vi.waitFor(() => expect(hostd.refreshProjectMap).toHaveBeenCalledTimes(1));
    release();

    expect(await first).toEqual(await second);
    expect(hostd.refreshProjectMap).toHaveBeenCalledTimes(1);
  });
});
