// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountsStep } from './accounts-step';
import type { AccountRef } from '@/lib/model-onboarding';

const CODEX_SEAT: AccountRef = { id: 'acct-codex', provider: 'openai', kind: 'subscription', label: 'ChatGPT Pro' };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('a sign-in started as the step goes', () => {
  it('is not followed once the step has gone', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let started: (response: Response) => void = () => undefined;
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const line = `${init?.method ?? 'GET'} ${String(url)}`;
        asked.push(line);
        if (line === 'POST /api/model-accounts/acct-codex/login') return new Promise<Response>((resolve) => (started = resolve));
        // Nothing under way when the step mounts.
        return Promise.resolve(new Response(JSON.stringify({ state: 'signed-out' }), { status: 200 }));
      }),
    );
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(<AccountsStep accounts={[CODEX_SEAT]} crew={[]} onAccounts={() => undefined} onCrew={() => undefined} />),
    );
    const signIn = [...host.querySelectorAll('button')].find((one) => one.textContent === 'Sign in')!;
    await act(async () => signIn.click());

    // The step goes while hostd is still starting the sign-in.
    vi.useFakeTimers();
    act(() => root.unmount());
    await act(async () => started(new Response(JSON.stringify({ state: 'waiting', url: 'https://auth.example.test/device', code: 'ABCD-1234' }), { status: 200 })));
    const before = asked.length;
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(asked.slice(before).filter((line) => line.startsWith('GET /api/model-accounts/acct-codex/login'))).toEqual([]);
  });
});

describe('the step when hostd does not answer', () => {
  it('says what hostd is and what to run, rather than only that it is not answering', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        new Response(JSON.stringify(String(url) === '/api/engines' ? { reachable: false, bots: [] } : { accounts: [] }), { status: 200 }),
      ),
    );
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<AccountsStep accounts={[]} crew={[]} onAccounts={() => undefined} onCrew={() => undefined} />));
    expect(host.textContent).toContain('OpenADLC’s host service (hostd), which runs the bots, is not answering');
    expect(host.textContent).toContain('Run fleetadlc up on the machine OpenADLC runs on (fleetadlc doctor says why it stopped), then reload this page.');
    act(() => root.unmount());
  });
});

// The form starts on an API key, so the Claude subscription's path is only
// reached by choosing it: that choice still has to lead to the setup-token
// steps and the button that adds the account.
describe('choosing a subscription in the add form', () => {
  it('turns the key step into the setup-token steps, with the label and button for a subscription', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ accounts: [] }), { status: 200 })));
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<AccountsStep accounts={[]} crew={[]} onAccounts={() => undefined} onCrew={() => undefined} />));
    const titles = () => [...host.querySelectorAll('form li p:first-child')].map((one) => one.textContent);
    expect(titles()).toContain('Paste the API key');

    const subscription = [...host.querySelectorAll<HTMLInputElement>('input[name="account-kind"]')].find((one) =>
      one.parentElement?.textContent?.startsWith('a subscription'),
    )!;
    await act(async () => subscription.click());

    expect(subscription.checked).toBe(true);
    expect(titles()).toEqual(expect.arrayContaining(['Copy the command', 'Paste the token it printed']));
    expect(titles()).not.toContain('Paste the API key');
    expect(host.querySelector<HTMLInputElement>('input[aria-label="A label"]')!.value).toBe('Anthropic — Max');
    expect([...host.querySelectorAll('button')].some((one) => one.textContent === 'Add and verify')).toBe(true);
    act(() => root.unmount());
  });
});
