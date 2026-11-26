import { describe, expect, it } from 'vitest';
import type { ProjectMapView } from '../../hostd-client.js';
import { PROJECT_MAP_DOCS_URL, projectMapCheck } from './project-map.js';

const SHA = 'abcdef1234567890abcdef1234567890abcdef12';

function view(repo: string, state: ProjectMapView['state'], extra: Partial<ProjectMapView> = {}): ProjectMapView {
  return { repo, path: '/w/maps/x.md', commit: SHA, builtAt: '2026-11-25T10:00:00.000Z', state, error: null, triedAt: null, ...extra };
}

const run = (repos: string[], maps: () => Promise<ProjectMapView[]>) =>
  projectMapCheck({ repositories: { listRepos: async () => repos.map((fullName) => ({ fullName })) }, maps }).run(new Date());

describe('the project map check', () => {
  it('raises a warning naming the repository and the reason, and says the old map is kept', async () => {
    const [result] = await run(['acme/one'], async () => [view('acme/one', 'failed', { error: 'fatal: could not read from remote' })]);
    expect(result).toMatchObject({
      subject: 'acme/one',
      ok: false,
      severity: 'warning',
      title: 'The project map of acme/one could not be rebuilt',
      action: { label: 'Open how the map is built', url: PROJECT_MAP_DOCS_URL },
    });
    expect(result && 'detail' in result ? result.detail : '').toContain('fatal: could not read from remote');
    expect(result && 'detail' in result ? result.detail : '').toContain('The map built from abcdef1 at 2026-11-25T10:00:00.000Z is kept');
  });

  it('says there is no map yet when the first build failed', async () => {
    const [result] = await run(['acme/one'], async () => [view('acme/one', 'failed', { commit: null, builtAt: null, error: 'boom' })]);
    expect(result && 'detail' in result ? result.detail : '').toContain('It has no map yet.');
  });

  it('passes for a map written or unchanged, and clears the card', async () => {
    const results = await run(['acme/one', 'acme/two'], async () => [view('acme/one', 'written'), view('acme/two', 'unchanged')]);
    expect(results).toEqual([
      expect.objectContaining({ subject: 'acme/one', ok: true, fixed: 'The project map is current again' }),
      expect.objectContaining({ subject: 'acme/two', ok: true }),
    ]);
  });

  it('has no answer before hostd has tried, or when hostd cannot be asked', async () => {
    expect(await run(['acme/one', 'acme/two'], async () => [view('acme/one', 'never')])).toEqual([
      expect.objectContaining({ subject: 'acme/one', ok: null }),
      expect.objectContaining({ subject: 'acme/two', ok: null }),
    ]);
    expect(
      await run(['acme/one'], async () => {
        throw new Error('hostd is not answering');
      }),
    ).toEqual([expect.objectContaining({ subject: 'acme/one', ok: null, reason: expect.stringContaining('hostd is not answering') })]);
  });
});
