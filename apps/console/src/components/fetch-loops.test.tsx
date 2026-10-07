// @vitest-environment happy-dom
import { useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountRef, CrewBot } from '@/lib/model-onboarding';
import type { WebhookStatus } from './webhook-step';

/**
 * Components that read the bridge when they mount, mounted in a DOM with a
 * parent that re-renders on every read, and counted.
 *
 * `ModelAccountsCard` passed `AccountsStep` a new `onAccounts` on every
 * render, and the step's `load` followed it: each read re-rendered the card,
 * which made a new `load`, which read again. Settings asked for the accounts
 * and the engines about 140 times a minute, and each engines read started a
 * docker probe on the host. Rendered to static markup, as the other
 * tests here are, no effect runs, so nothing could see it. A read that stops
 * is a bounded number of calls however long the page is left open.
 */

// A router the same object on every render, as Next's is: a mock that made a
// new one each time would itself look like a loop to anything keyed on it.
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const ACCOUNT: AccountRef = { id: 'acct-max', provider: 'anthropic', kind: 'key', label: 'Anthropic — Max', verifiedAt: '2026-09-28T08:00:00.000Z', verifyError: null };

const WEBHOOK: WebhookStatus = {
  ready: true,
  publicUrl: 'https://fleetadlc.example.com',
  webhookUrl: 'https://fleetadlc.example.com/webhooks/github',
  secretStored: true,
  tunnel: { running: false, url: '', since: null, detail: '' },
  github: { url: 'https://github.com/settings/apps/fleetadlc-exampleco', secretSet: true },
  stale: false,
  canAutomate: false,
  tunnelAvailable: false,
  detail: '',
};

/** Every read the page made, by path. */
let reads: string[] = [];

function answer(path: string): unknown {
  if (path.startsWith('/api/model-accounts') && path.endsWith('/models')) return { models: [{ id: 'claude-opus-5', createdAt: null }], aliases: [] };
  if (path.startsWith('/api/model-accounts')) return { accounts: [ACCOUNT] };
  if (path.startsWith('/api/engines')) return { reachable: true, bots: [] };
  if (path.startsWith('/api/webhook')) return WEBHOOK;
  if (path.startsWith('/api/app-checks')) return { deviceFlow: 'enabled', tokenExpiry: 'enabled', installed: 'yes', repository: null, settingsUrl: null, installUrl: null, app: null, detail: '' };
  return {};
}

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  reads = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
      reads.push(path);
      return new Response(JSON.stringify(answer(path)), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  root.unmount();
  container.remove();
  vi.unstubAllGlobals();
});

/**
 * Mounts, then lets effects, reads and re-renders run on their own for a
 * while. Not inside `act`: it waits for the work to settle, and work that
 * never settles would hang the test rather than fail it on the count.
 */
async function mountAndWait(node: React.ReactNode): Promise<void> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  root.render(node);
  await new Promise((resolve) => setTimeout(resolve, 150));
}

const count = (prefix: string) => reads.filter((path) => path === prefix).length;

describe('a page that reads when it mounts', () => {
  it('settings’ AI models reads the accounts and the engines once, not in a loop', async () => {
    const { ModelAccountsCard } = await import('./model-accounts-card');
    await mountAndWait(<ModelAccountsCard initial={null} />);

    expect(count('/api/model-accounts')).toBe(1);
    expect(count('/api/engines')).toBe(1);
  });

  it('the accounts step reads once under a parent that passes new callbacks and re-renders on every read', async () => {
    const { AccountsStep } = await import('./accounts-step');
    function Parent() {
      const [accounts, setAccounts] = useState<AccountRef[] | null>(null);
      const [crew, setCrew] = useState<CrewBot[] | null>(null);
      // New functions every render, and new state from every read: the shape
      // that looped.
      return (
        <AccountsStep
          accounts={accounts}
          crew={crew}
          onAccounts={(next) => setAccounts([...next])}
          onCrew={(next) => setCrew([...next])}
          place="settings"
        />
      );
    }
    await mountAndWait(<Parent />);

    expect(count('/api/model-accounts')).toBe(1);
    expect(count('/api/engines')).toBe(1);
  });

  it('the webhook step reads once under a parent that passes a new onStatus and re-renders on every status', async () => {
    const { WebhookStep } = await import('./webhook-step');
    function Parent() {
      const [, setStatus] = useState<WebhookStatus | null>(null);
      return <WebhookStep onStatus={(status) => setStatus({ ...status })} onChanged={() => undefined} />;
    }
    await mountAndWait(<Parent />);

    expect(count('/api/webhook')).toBe(1);
  });

  it('the app checks read once under a parent that passes a new onChecked and re-renders on every answer', async () => {
    const { AppChecksPanel } = await import('./app-checks');
    function Parent() {
      const [, setChecks] = useState<unknown>(null);
      return <AppChecksPanel onChecked={(checks) => setChecks({ ...checks })} />;
    }
    await mountAndWait(<Parent />);

    expect(count('/api/app-checks')).toBe(1);
  });
});
