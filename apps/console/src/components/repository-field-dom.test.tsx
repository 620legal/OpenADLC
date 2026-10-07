// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReachFix } from '@/lib/app-reach';
import { RepositoryField } from './repository-field';

const FIX: ReachFix = {
  need: 'install',
  title: 'Install the app on exampleco',
  detail: 'The app is not installed on exampleco.',
  action: { label: 'Install it', url: 'https://github.com/apps/fleetadlc/installations/new' },
  steps: [{ text: 'Install the app on exampleco', action: { label: 'Install it', url: 'https://github.com/apps/fleetadlc/installations/new' } }],
};

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('a repository typed in that waits on the app', () => {
  it('keeps waiting while another repository is added, and stops once it is added itself', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const reachable = new Set<string>();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/onboarding/repository') {
          const { fullName } = JSON.parse(String(init?.body)) as { fullName: string };
          const name = fullName.replace(/^https:\/\/github\.com\//, '');
          if (!reachable.has(name)) return new Response(JSON.stringify({ error: FIX.title, needs: FIX }), { status: 409 });
          return new Response(JSON.stringify({ repository: name }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      }),
    );
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <RepositoryField
          added={[]}
          installUrl={null}
          onAdded={() => undefined}
          initial={{ repositories: [{ fullName: 'exampleco/other', private: false, defaultBranch: 'main' }], installations: null }}
        />,
      ),
    );
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Repository, as owner/name"]')!;
    const button = (text: string) => [...host.querySelectorAll('button')].find((one) => one.textContent === text)!;

    // Typed as an address, which the app cannot reach yet.
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'https://github.com/exampleco/private');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('add it').click());
    expect(host.textContent).toContain('The app cannot reach https://github.com/exampleco/private yet.');

    // Another one from the list is added: the typed one still waits.
    reachable.add('exampleco/other');
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => button('Add 1 repository').click());
    expect(host.textContent).toContain('The app cannot reach https://github.com/exampleco/private yet.');
    expect(input.value).toBe('https://github.com/exampleco/private');

    // Then it can be reached, and is added under its owner/name.
    reachable.add('exampleco/private');
    await act(async () => button('add it').click());
    expect(host.textContent).not.toContain('The app cannot reach');
    expect(input.value).toBe('');
  });
});
