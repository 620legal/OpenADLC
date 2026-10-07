// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useGitHubLookup, type GitHubLookup } from './github-lookup';

const FOUND = (login: string): GitHubLookup => ({
  exact: { login, type: 'User', avatarUrl: '', htmlUrl: `https://github.com/${login}` },
  suggestions: [],
  rateLimited: false,
});
const NOBODY: GitHubLookup = { exact: null, suggestions: [], rateLimited: false };

/** A fetch whose answers are released by hand, one per term asked. */
function heldFetch() {
  const release = new Map<string, (body: GitHubLookup) => void>();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string) =>
        new Promise<Response>((resolve) => {
          const q = new URL(url, 'http://x').searchParams.get('q') ?? '';
          release.set(q, (body) => resolve(new Response(JSON.stringify(body))));
        }),
    ),
  );
  return release;
}

async function mount() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const seen: { lookup: GitHubLookup | null; looking: boolean } = { lookup: null, looking: false };
  function Probe({ value }: { value: string }) {
    Object.assign(seen, useGitHubLookup(value));
    return null;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const type = async (value: string) => {
    await act(async () => root.render(<Probe value={value} />));
    // Past the debounce, so the lookup is asked.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 450)));
  };
  return { seen, type };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('looking a name up on GitHub as it is typed', () => {
  it('ignores a slow answer for a term no longer typed', async () => {
    const release = heldFetch();
    const { seen, type } = await mount();
    await type('jane');
    await type('janedoe');
    await act(async () => release.get('janedoe')!(FOUND('janedoe')));
    expect(seen.lookup?.exact?.login).toBe('janedoe');
    await act(async () => release.get('jane')!(NOBODY));
    expect(seen.lookup?.exact?.login).toBe('janedoe');
    expect(seen.looking).toBe(false);
  });

  it('stays looking while the newer term is still out', async () => {
    const release = heldFetch();
    const { seen, type } = await mount();
    await type('jane');
    await type('janedoe');
    await act(async () => release.get('jane')!(NOBODY));
    expect(seen.looking).toBe(true);
    expect(seen.lookup).toBeNull();
  });
});
