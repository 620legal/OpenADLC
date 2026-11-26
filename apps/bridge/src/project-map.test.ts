import { describe, expect, it, vi } from 'vitest';
import type { ProjectMapView } from './hostd-client.js';
import { MAP_CONTEXT_BYTES, PROJECT_MAP_FORCE_EVERY_MS, ProjectMapRefresher, mapDocument, readProjectMap, type ProjectMapRead } from './project-map.js';

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

  it('forces the next pass again when hostd did not answer the forced one', async () => {
    const { refresher, hostd, advance } = setup({ repos: [{ fullName: 'acme/one', defaultBranch: 'main' }] });
    const forced = () => hostd.refreshProjectMap.mock.calls.map((call) => Boolean(call[1].force));
    hostd.refreshProjectMap.mockRejectedValueOnce(new Error('hostd is not running'));

    const lines = await refresher.refreshAll();
    expect(lines[0]).toContain('could not ask hostd');
    advance(15 * 60_000);
    await refresher.refreshAll();
    advance(15 * 60_000);
    await refresher.refreshAll();

    expect(forced()).toEqual([true, true, false]);
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

describe('readProjectMap', () => {
  it('passes hostd’s view and the map’s text through', async () => {
    const hostd = { projectMap: vi.fn(async () => ({ map: view('acme/one', 'unchanged', { builtAt: '2026-11-25T10:00:00.000Z' }), content: '# map\n' })) };
    await expect(readProjectMap(hostd as never, 'acme/one')).resolves.toEqual({
      repo: 'acme/one',
      commit: SHA,
      builtAt: '2026-11-25T10:00:00.000Z',
      state: 'unchanged',
      error: null,
      triedAt: null,
      content: '# map\n',
    });
    expect(hostd.projectMap).toHaveBeenCalledWith('acme/one');
  });
});

describe('mapDocument', () => {
  const read = (content: string | null): ProjectMapRead => ({
    repo: 'acme/one',
    commit: SHA,
    builtAt: '2026-11-25T10:00:00.000Z',
    state: 'written',
    error: null,
    triedAt: null,
    content,
  });

  it('is nothing where there is no map', () => {
    expect(mapDocument(read(null))).toBeNull();
    expect(mapDocument(read(''))).toBeNull();
  });

  it('gives a small map whole, after a line naming the commit', () => {
    const document = mapDocument(read('# Project map: acme/one\n\n## Areas and packages\n'))!;
    expect(document.name).toBe('project-map.md');
    expect(document.title).toBe('The project map of acme/one, built from abcdef1 at 2026-11-25T10:00:00.000Z');
    expect(document.content.split('\n')[0]).toBe(
      `A summary of acme/one's default branch at ${SHA}, generated by OpenADLC. Read it to find your way; open the files it names before you rely on them.`,
    );
    expect(document.content).toContain('# Project map: acme/one\n\n## Areas and packages\n');
    expect(document.content).not.toContain('continues past here');
  });

  it('cuts a 100 KiB map on a whole line at 48 KiB, and counts the lines it left out', () => {
    // Two-byte characters, so a cut on bytes that split one would show.
    const lines = Array.from({ length: 2000 }, (_, n) => `- line ${String(n).padStart(5, '0')} ${'é'.repeat(40)}`);
    const content = `${lines.join('\n')}\n`;
    expect(Buffer.byteLength(content)).toBeGreaterThan(100 * 1024);
    const document = mapDocument(read(content), { consoleUrl: 'http://console.test/' })!;

    const [summary, blank, ...rest] = document.content.split('\n');
    expect(summary).toContain('generated by OpenADLC');
    expect(blank).toBe('');
    const body = rest.join('\n');
    const noteAt = body.indexOf('\n_The map continues past here');
    const kept = body.slice(0, noteAt);
    expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(MAP_CONTEXT_BYTES);
    const keptLines = kept.replace(/\n$/, '').split('\n');
    // Every kept line is a whole line of the map, in order.
    expect(keptLines).toEqual(lines.slice(0, keptLines.length));
    expect(body.slice(noteAt)).toBe(
      `\n_The map continues past here: ${2000 - keptLines.length} more lines, on the Map page (http://console.test/map/acme%2Fone)._\n`,
    );
  });

  it('names no URL when the console’s is unset', () => {
    const content = `${'x'.repeat(100)}\n`.repeat(1000);
    expect(mapDocument(read(content))!.content).toMatch(/on the Map page\._\n$/);
  });
});
