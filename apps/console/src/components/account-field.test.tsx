// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountField } from './account-field';
import type { InstallSettings } from './install-settings';

const SETTINGS = (organization: string): InstallSettings => ({
  organization,
  githubClientId: '',
  automationBot: '',
  humans: '',
  publicUrl: '',
  operatorEmail: '',
  webhookSecretConfigured: false,
  appPrivateKeyConfigured: false,
  storedKeys: [],
  webhookUrl: '',
});

const NOBODY = { exact: null, suggestions: [], rateLimited: false };

async function mount(stored: string, accounts: Record<string, unknown> = {}) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const q = new URL(url, 'http://x').searchParams.get('q') ?? '';
      return new Response(JSON.stringify(accounts[q.toLowerCase()] ?? NOBODY));
    }),
  );
  const saved: [string, string][] = [];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <AccountField
        settings={SETTINGS(stored)}
        save={async (key, value) => {
          saved.push([key, value]);
        }}
      />,
    ),
  );
  const input = host.querySelector<HTMLInputElement>('input')!;
  const type = async (text: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Past the lookup's debounce, and its answer.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 450)));
  };
  const button = () => [...host.querySelectorAll('button')].find((one) => /^(save|saved|saving…)$/.test(one.textContent ?? ''))!;
  return { host, type, button, saved };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('the organization field', () => {
  it('saves the name without the @ the lookup ignores', async () => {
    const { type, button, saved } = await mount('');
    await type('@acme');
    await act(async () => button().click());
    expect(saved).toEqual([['organization', 'acme']]);
  });

  it('saves a name without the spaces around it', async () => {
    const { type, button, saved } = await mount('');
    await type(' acme ');
    await act(async () => button().click());
    expect(saved).toEqual([['organization', 'acme']]);
  });

  it("saves GitHub's own casing once GitHub found the account", async () => {
    const acme = { login: 'Acme', type: 'Organization', avatarUrl: '', htmlUrl: 'https://github.com/Acme' };
    const { host, type, button, saved } = await mount('', { acme: { exact: acme, suggestions: [], rateLimited: false } });
    await type('@acme');
    expect(host.textContent).toContain('organization');
    await act(async () => button().click());
    expect(saved).toEqual([['organization', 'Acme']]);
  });

  it('shows nothing unsaved when the field and the stored name differ only by the @', async () => {
    const { type, button } = await mount('acme');
    await type('@acme');
    expect(button().textContent).toBe('saved');
    expect(button().disabled).toBe(true);
  });
});
