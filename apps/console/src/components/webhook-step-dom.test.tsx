// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebhookStep, type WebhookStatus } from './webhook-step';
import { BRIDGE_NOT_ANSWERING } from '@/lib/reach';

const READY: WebhookStatus = {
  ready: true,
  publicUrl: 'https://example-tunnel.trycloudflare.com',
  webhookUrl: 'https://example-tunnel.trycloudflare.com/webhooks/github',
  secretStored: true,
  tunnel: { running: true, url: 'https://example-tunnel.trycloudflare.com', since: '2026-09-24T17:43:52Z', detail: '' },
  github: { url: 'https://example-tunnel.trycloudflare.com/webhooks/github', secretSet: true },
  stale: false,
  canAutomate: true,
  tunnelAvailable: true,
  detail: '',
  lastDelivery: null,
};

async function stopWith(stop: () => Promise<Response>) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const reads: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return stop();
      reads.push(url);
      return new Response(JSON.stringify(READY), { status: 200 });
    }),
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<WebhookStep />));
  const button = [...host.querySelectorAll('button')].find((one) => one.textContent === 'take it off the internet')!;
  const before = reads.length;
  await act(async () => button.click());
  return { host, readAgain: reads.length > before };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('taking the install off the internet', () => {
  it('says the bridge’s refusal, and reads the status again', async () => {
    const { host, readAgain } = await stopWith(async () =>
      new Response(JSON.stringify({ error: 'only an admin can stop the tunnel' }), { status: 403 }),
    );
    expect(host.textContent).toContain('only an admin can stop the tunnel');
    expect(readAgain).toBe(true);
  });

  it('says the bridge did not answer, rather than failing in silence', async () => {
    const { host } = await stopWith(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(host.textContent).toContain(BRIDGE_NOT_ANSWERING);
  });
});

describe('setting it up', () => {
  it('says the bridge’s refusal as its sentence, not as the JSON it came in', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const unset: WebhookStatus = { ...READY, ready: false, configured: false, publicUrl: '', webhookUrl: '', tunnel: { running: false, url: '', since: null, detail: '' }, github: null };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === 'POST'
          ? new Response(JSON.stringify({ error: 'cloudflared is not installed. On a Mac: brew install cloudflared' }, null, 2), { status: 400 })
          : new Response(JSON.stringify(unset), { status: 200 }),
      ),
    );
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<WebhookStep />));
    const pick = (text: string) => [...host.querySelectorAll('button')].find((one) => one.textContent?.includes(text))!;
    await act(async () => pick('This bridge runs on my machine').click());
    await act(async () => pick('set it up for me').click());
    expect(host.textContent).toContain('cloudflared is not installed. On a Mac: brew install cloudflared');
    expect(host.textContent).not.toContain('"error"');
  });
});

describe('a machine without cloudflared', () => {
  it('says how to install it on a Mac and on Linux, not Homebrew alone', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const unset: WebhookStatus = { ...READY, ready: false, configured: false, publicUrl: '', webhookUrl: '', tunnelAvailable: false, tunnel: { running: false, url: '', since: null, detail: '' }, github: null };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(unset), { status: 200 })));
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<WebhookStep />));
    expect(host.textContent).toContain('Needs cloudflared (macOS: brew install cloudflared; on Linux, Cloudflare’s package), then come back to this step.');
  });
});
