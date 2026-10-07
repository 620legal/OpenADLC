import { describe, expect, it, vi } from 'vitest';
import { readDefaultBranch, syncDefaultBranches } from './default-branch.js';

const answering = (answer: unknown) => async () => ({ request: vi.fn(async () => answer) }) as never;
const failing = async () => ({ request: vi.fn(async () => Promise.reject(new Error('404'))) }) as never;

describe('reading a repository’s default branch', () => {
  it('is GitHub’s default_branch, asked as the app first', async () => {
    const asApp = vi.fn(answering({ default_branch: 'master' }));
    const asAutomation = vi.fn(answering({ default_branch: 'trunk' }));

    expect(await readDefaultBranch('acme/legacy', [asApp, asAutomation])).toBe('master');
    expect(asAutomation).not.toHaveBeenCalled();
  });

  it('asks the next client when the app cannot be asked or does not answer', async () => {
    expect(await readDefaultBranch('acme/legacy', [async () => null, answering({ default_branch: 'develop' })])).toBe('develop');
    expect(await readDefaultBranch('acme/legacy', [failing, answering({ default_branch: 'develop' })])).toBe('develop');
  });

  it('is null, never a guess, when nobody answers', async () => {
    expect(await readDefaultBranch('acme/legacy', [])).toBeNull();
    expect(await readDefaultBranch('acme/legacy', [failing, async () => Promise.reject(new Error('no token'))])).toBeNull();
    expect(await readDefaultBranch('acme/legacy', [answering({ default_branch: '' })])).toBeNull();
  });
});

describe('keeping the stored default branch in step with GitHub', () => {
  it('corrects the ones that differ, says so, and leaves the rest', async () => {
    const store = vi.fn(async () => undefined);
    const github: Record<string, string | null> = { 'acme/legacy': 'master', 'acme/api': 'main', 'acme/quiet': null };

    const actions = await syncDefaultBranches({
      repositories: async () => [
        { fullName: 'acme/legacy', defaultBranch: 'main' },
        { fullName: 'acme/api', defaultBranch: 'main' },
        { fullName: 'acme/quiet', defaultBranch: 'main' },
      ],
      read: async (fullName) => github[fullName] ?? null,
      store,
    });

    expect(store).toHaveBeenCalledTimes(1);
    expect(store).toHaveBeenCalledWith('acme/legacy', 'master');
    expect(actions).toEqual(['acme/legacy: its default branch is master on GitHub, not main; corrected']);
  });

  it('says when a correction could not be stored, and goes on to the next', async () => {
    const store = vi.fn(async (fullName: string) => (fullName === 'acme/one' ? Promise.reject(new Error('the database went away')) : undefined));

    const actions = await syncDefaultBranches({
      repositories: async () => [
        { fullName: 'acme/one', defaultBranch: 'main' },
        { fullName: 'acme/two', defaultBranch: 'main' },
      ],
      read: async () => 'trunk',
      store,
    });

    expect(actions).toEqual([
      'acme/one: its default branch is trunk on GitHub, not main, and could not be corrected: the database went away',
      'acme/two: its default branch is trunk on GitHub, not main; corrected',
    ]);
  });
});
