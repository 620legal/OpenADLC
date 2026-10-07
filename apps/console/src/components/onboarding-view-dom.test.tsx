// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OnboardingView, type OnboardingData } from './onboarding-view';
import type { InstallSettings } from './install-settings';

/**
 * The walkthrough in a browser: where a link on Ready goes, and what a read
 * that fails leaves on screen.
 */

const DATA: OnboardingData = {
  organization: 'acme',
  organizationIsOrg: false,
  repositories: ['acme/widgets'],
  clientIdConfigured: true,
  webhookSecretConfigured: true,
  webhookReady: false,
  operatorEmail: 'op@example.com',
  steps: [],
  bots: [],
  links: {
    signup: 'https://github.com/signup',
    emailSettings: 'https://github.com/settings/emails',
    device: 'https://github.com/login/device',
    newApp: 'https://github.com/settings/apps/new',
    yourApps: 'https://github.com/settings/apps',
    invite: null,
  },
  appSettings: [],
  appPermissions: [],
  webhookEvents: [],
  webhookUrl: 'https://example.test/webhooks/github',
  complete: false,
};

const SETTINGS: InstallSettings = {
  organization: 'acme',
  githubClientId: 'Iv1.test',
  automationBot: '',
  humans: '',
  publicUrl: '',
  operatorEmail: 'op@example.com',
  webhookSecretConfigured: true,
  appPrivateKeyConfigured: true,
  storedKeys: [],
  webhookUrl: 'https://example.test/webhooks/github',
};

/** A bridge that answers each path from `routes`, and records what it was asked. */
function bridge(routes: Record<string, () => Response | Promise<Response>>) {
  const asked: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = String(url).split('?')[0]!;
      asked.push(path);
      const route = routes[path];
      return route ? route() : new Response(JSON.stringify({ error: 'not in this test' }), { status: 404 });
    }),
  );
  return asked;
}

async function mount(props: { step: string; email?: string; settings?: InstallSettings | null }) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <OnboardingView
        initialEmail={props.email ?? 'op@example.com'}
        initialData={DATA}
        initialChecks={null}
        initialAccounts={[]}
        initialCrew={[]}
        initialStep={props.step}
        initialSettings={props.settings === undefined ? SETTINGS : props.settings}
      />,
    );
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  const heading = () => host.querySelector('h2')?.textContent;
  const button = (text: string) => [...host.querySelectorAll('button')].find((one) => one.textContent === text);
  return { host, heading, button };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('the walkthrough in the browser', () => {
  it('goes to a step Ready says is still open, rather than changing only the address', async () => {
    bridge({});
    const { host, heading } = await mount({ step: 'done' });
    expect(heading()).toBe('Ready');

    const open = [...host.querySelectorAll('ul a')].find((one) => one.textContent === 'GitHub accounts')!;
    await act(async () => (open as HTMLAnchorElement).click());
    expect(heading()).toBe('GitHub accounts');
  });

  it('keeps the step on screen when a reload fails, says so, and offers to try again', async () => {
    const asked = bridge({
      '/api/onboarding': () => {
        throw new TypeError('Failed to fetch');
      },
    });
    // No address in the URL: the stored one arrives with the settings and is loaded.
    const { host, heading, button } = await mount({ step: 'owner', email: '' });

    expect(host.textContent).toContain('Could not refresh from the bridge — retrying.');
    expect(heading()).toBe('GitHub owner');
    expect(host.querySelector('input')).not.toBeNull();

    const before = asked.filter((path) => path === '/api/onboarding').length;
    await act(async () => button('Try again')!.click());
    expect(asked.filter((path) => path === '/api/onboarding').length).toBe(before + 1);
  });

  it('says the install’s settings could not be read on a step drawn from them, with a way to read them again', async () => {
    const asked = bridge({ '/api/install': () => new Response('{"error":"bridge restarting"}', { status: 503 }) });
    const { host, button } = await mount({ step: 'owner', settings: null });

    expect(host.textContent).toContain('Could not read the install’s settings, which this step needs.');
    const before = asked.filter((path) => path === '/api/install').length;
    await act(async () => button('Try again')!.click());
    expect(asked.filter((path) => path === '/api/install').length).toBe(before + 1);
  });
});
