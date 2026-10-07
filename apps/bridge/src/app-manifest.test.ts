import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Spawner, TunnelProcess } from './tunnel.js';

/**
 * Creating the app with its webhook switched on.
 *
 * GitHub makes an app's webhook active only when the manifest it is created
 * from gives it an address; afterwards only a person on the app's settings
 * page can switch it on — `PATCH /app/hook/config` cannot. The walkthrough
 * created the app before the install had an address, so the app it made on a
 * real install was switched off, and GitHub sent it nothing while every
 * setting said it should.
 *
 * These drive the console's routes over a real `WebhookSetup`, with a fake
 * cloudflared and a fake GitHub, and watch what the manifest carries.
 */

let STORED: Record<string, string> = {};
const SECRETS: Record<string, string> = {};

vi.mock('@fleetadlc/db', () => ({
  spendingLimits: {
    SPENDING_PROVIDERS: ['anthropic', 'openai', 'xai'],
    GLOBAL_SCOPE: 'global',
    seedGlobal: vi.fn(async () => false),
    effectiveTaskCap: vi.fn(async (_repoId: string | null, fallback: number) => fallback),
    amountOf: vi.fn(async () => null),
    refusal: vi.fn(async () => null),
    listLimits: vi.fn(async () => []),
    setLimit: vi.fn(async () => undefined),
    dollars: (amount: number) => (Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`),
    botKind: (id: string) => `month_bot:${id}`,
    providerKind: (provider: string) => `month_provider:${provider}`,
    repoScope: (id: string) => `repo:${id}`,
    repoIdOf: (scope: string) => (scope.startsWith('repo:') ? scope.slice(5) : null),
  },

  audit: vi.fn(async () => undefined),
  AccountInUse: class AccountInUse extends Error {},
  bots: { listBots: vi.fn(async () => []) },
  costs: {},
  credentials: {},
  issues: {},
  leases: {},
  listAudit: vi.fn(),
  mergeLines: {},
  modelAccounts: {},
  recordEvent: vi.fn(),
  repos: {},
  requests: {},
  sessions: {},
  settings: {
    isSettingKey: (key: string) => ['appPrivateKey', 'appClientSecret', 'webhookSecret', 'humans'].includes(key),
    allSettings: vi.fn(async () => STORED),
    setSetting: vi.fn(async (key: string, value: string) => {
      // An empty value deletes the row, as the real store does.
      if (value === '') delete STORED[key];
      else STORED[key] = value;
    }),
  },
  tasks: {},
  threads: {},
}));

vi.mock('@fleetadlc/github', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fleetadlc/github')>()),
  getSecretStore: () => ({
    get: async (ref: string) => SECRETS[ref] ?? null,
    set: async (ref: string, value: string) => {
      SECRETS[ref] = value;
    },
    delete: async (ref: string) => {
      delete SECRETS[ref];
    },
    list: async () => [],
  }),
}));

const TUNNEL = 'https://calm-badger-42.trycloudflare.com';

/** How many tunnels were raised, so a test can say when one was. */
let raised = 0;

const cloudflared: Spawner = () => {
  raised += 1;
  const events = new EventEmitter();
  const stderr = new Readable({ read() {} });
  setTimeout(() => stderr.push(`INF |  ${TUNNEL}  |\n`), 0);
  const child: TunnelProcess = {
    stderr,
    stdout: null,
    once: (event, listener) => events.once(event, listener as (...a: unknown[]) => void),
    kill: () => true,
  };
  return child;
};

let bridge: Server;
let bridgeUrl: string;
let setup: { shutdown(): Promise<void> } | null = null;

async function start(options: { hasCloudflared?: boolean } = {}): Promise<void> {
  const { registerConsoleApi } = await import('./api.js');
  const { Router } = await import('./router.js');
  const { WebhookSetup } = await import('./webhook-setup.js');
  const config = {
    port: 47311,
    consoleUrl: 'http://127.0.0.1:47300',
    organization: '',
    gitHubClientId: '',
    automationBot: null,
    humans: [],
    publicUrl: '',
    webhookSecret: '',
  } as never;

  const webhookSetup = new WebhookSetup({
    config,
    spawner: cloudflared,
    startGateway: async () => ({ port: 59999, close: async () => undefined }),
    hasCloudflared: () => options.hasCloudflared ?? true,
    api: { request: async () => ({}) as never },
  });
  setup = webhookSetup;

  const router = new Router();
  registerConsoleApi(router, {
    config,
    hostd: {} as never,
    actors: {} as never,
    invitations: {} as never,
    automation: {} as never,
    gates: {} as never,
    taskService: {} as never,
    threadStream: { subscribe: () => () => undefined, watching: 0 } as never,
    onboarding: {} as never,
    webhookSetup,
    repoSetup: {} as never,
  });
  bridge = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  bridgeUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
}

beforeEach(() => {
  STORED = {};
  raised = 0;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await setup?.shutdown();
  await new Promise<void>((resolve) => bridge.close(() => resolve()));
});

interface Prepared {
  postUrl: string;
  address: 'have' | 'tunnel' | 'none';
  manifest: { hook_attributes: { url: string; active: boolean } };
}

describe('the app the walkthrough creates', () => {
  it('raises the tunnel before the manifest is made, so the webhook is created switched on', async () => {
    await start();

    // Looking is free: it says a tunnel would be raised, and raises none.
    const looked = (await (await fetch(`${bridgeUrl}/v1/app-manifest`)).json()) as Prepared;
    expect(looked.address).toBe('tunnel');
    expect(raised).toBe(0);

    const response = await fetch(`${bridgeUrl}/v1/app-manifest/prepare`, { method: 'POST' });
    expect(response.status).toBe(200);
    const prepared = (await response.json()) as Prepared;

    expect(raised).toBe(1);
    expect(prepared.manifest.hook_attributes).toEqual({ url: `${TUNNEL}/webhooks/github`, active: true });
    expect(STORED.publicUrl).toBe(TUNNEL);
    expect(prepared.postUrl).toMatch(/^https:\/\/github\.com\/settings\/apps\/new\?state=[0-9a-f]{64}$/);
  });

  it('proposes a new name on every look, short enough for GitHub', async () => {
    await start({ hasCloudflared: false });

    const names: string[] = [];
    for (let index = 0; index < 2; index++) {
      const looked = (await (await fetch(`${bridgeUrl}/v1/app-manifest`)).json()) as { manifest: { name: string } };
      names.push(looked.manifest.name);
    }

    expect(names[0]).not.toBe(names[1]);
    for (const name of names) expect(name.length).toBeLessThanOrEqual(34);
  });

  it('carries a new state on every create, and none when only looked at', async () => {
    await start({ hasCloudflared: false });

    const looked = (await (await fetch(`${bridgeUrl}/v1/app-manifest`)).json()) as Prepared;
    const one = (await (await fetch(`${bridgeUrl}/v1/app-manifest/prepare`, { method: 'POST' })).json()) as Prepared;
    const two = (await (await fetch(`${bridgeUrl}/v1/app-manifest/prepare`, { method: 'POST' })).json()) as Prepared;

    expect(looked.postUrl).toBe('https://github.com/settings/apps/new');
    expect(one.postUrl).not.toBe(two.postUrl);
  });

  it('raises no tunnel when asked to create it without an address, and still carries a state', async () => {
    await start();

    const response = await fetch(`${bridgeUrl}/v1/app-manifest/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ withoutAddress: true }),
    });
    const prepared = (await response.json()) as Prepared;

    expect(raised).toBe(0);
    expect(prepared.address).toBe('none');
    expect(prepared.postUrl).toMatch(/\?state=[0-9a-f]{64}$/);
  });

  it('uses an address the install already has, with no tunnel', async () => {
    STORED = { publicUrl: 'https://fleetadlc.example.com' };
    await start();

    const looked = (await (await fetch(`${bridgeUrl}/v1/app-manifest`)).json()) as Prepared;

    expect(looked.address).toBe('have');
    expect(looked.manifest.hook_attributes).toEqual({ url: 'https://fleetadlc.example.com/webhooks/github', active: true });
    expect(raised).toBe(0);
  });

  it('creates it switched off only when there is no address to be had', async () => {
    await start({ hasCloudflared: false });

    const prepared = (await (await fetch(`${bridgeUrl}/v1/app-manifest/prepare`, { method: 'POST' })).json()) as Prepared;

    expect(prepared.address).toBe('none');
    expect(prepared.manifest.hook_attributes.active).toBe(false);
    expect(raised).toBe(0);
  });
});

describe('the code GitHub sends back', () => {
  const { privateKey: pem } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  /** GitHub, as the exchange and the lookups before it see it. */
  function github(owner = 'janedoe') {
    const calls: { method: string; path: string }[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith('https://api.github.com/')) return realFetch(input, init);
      const path = url.slice('https://api.github.com'.length);
      calls.push({ method: init?.method ?? 'GET', path });
      const answer = path.startsWith('/app-manifests/')
        ? { client_id: 'Iv23liNEW', pem, webhook_secret: 'secret-from-github', slug: 'fleetadlc-janedoe', owner: { login: owner } }
        : path.startsWith('/app/hook/deliveries?')
          ? [{ id: 4242, event: 'ping', status_code: 401, delivered_at: '2026-09-25T02:00:00Z' }]
          : path.startsWith('/search/users')
            ? { items: [{ login: 'exampleco', type: 'Organization' }] }
            : {};
      return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    return calls;
  }

  async function prepare(): Promise<string> {
    const prepared = (await (await fetch(`${bridgeUrl}/v1/app-manifest/prepare`, { method: 'POST' })).json()) as Prepared;
    return new URL(prepared.postUrl).searchParams.get('state') ?? '';
  }

  const exchange = (body: Record<string, unknown>) =>
    fetch(`${bridgeUrl}/v1/app-manifest/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const conversions = (calls: { path: string }[]) => calls.filter((call) => call.path.startsWith('/app-manifests/'));

  it('stores the secret, then asks GitHub to send again the ping the bridge refused without it', async () => {
    // GitHub pings an app with its webhook on as it creates it, signed with a
    // secret OpenADLC only learns from this exchange — so the ping was refused.
    const calls = github();
    await start({ hasCloudflared: false });
    const state = await prepare();

    const response = await exchange({ code: 'one-time-code', state });

    expect(response.status).toBe(200);
    // In the secret store, never the settings table, which is in every dump of the database.
    expect(SECRETS['github-webhook-secret']).toBe('secret-from-github');
    expect(STORED).not.toHaveProperty('webhookSecret');
    expect(calls).toEqual([
      { method: 'POST', path: '/app-manifests/one-time-code/conversions' },
      { method: 'GET', path: '/app/hook/deliveries?per_page=1' },
      { method: 'POST', path: '/app/hook/deliveries/4242/attempts' },
    ]);
  });

  it('is not exchanged with no state, an unknown one, or one already used, and nothing is stored', async () => {
    const calls = github();
    await start({ hasCloudflared: false });

    for (const body of [{ code: 'attackers-code' }, { code: 'attackers-code', state: 'f'.repeat(64) }]) {
      const response = await exchange(body);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain('press create again on the onboarding page');
    }
    expect(conversions(calls)).toEqual([]);

    // Used once, it is gone, even though that first exchange worked.
    const state = await prepare();
    expect((await exchange({ code: 'one-time-code', state })).status).toBe(200);
    STORED = {};
    expect((await exchange({ code: 'another-code', state })).status).toBe(400);
    expect(conversions(calls)).toEqual([{ method: 'POST', path: '/app-manifests/one-time-code/conversions' }]);
    expect(STORED).toEqual({});
  });

  it('is not exchanged with a state over an hour old', async () => {
    const calls = github();
    await start({ hasCloudflared: false });
    const state = await prepare();
    const later = Date.now() + 60 * 60 * 1000 + 1;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      expect((await exchange({ code: 'one-time-code', state })).status).toBe(400);
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
    expect(conversions(calls)).toEqual([]);
  });

  it('refuses an app another account owns when it was created in the organization’s form, and keeps the install’s', async () => {
    STORED = { organization: 'exampleco', githubClientId: 'Iv23liOLD', webhookSecret: 'old-secret' };
    for (const ref of Object.keys(SECRETS)) delete SECRETS[ref];
    SECRETS.old = 'kept';
    github('mallory');
    await start({ hasCloudflared: false });
    const prepared = (await (await fetch(`${bridgeUrl}/v1/app-manifest/prepare`, { method: 'POST' })).json()) as Prepared;
    expect(prepared.postUrl).toMatch(/^https:\/\/github\.com\/organizations\/exampleco\/settings\/apps\/new\?state=/);

    const response = await exchange({ code: 'one-time-code', state: new URL(prepared.postUrl).searchParams.get('state') });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('belongs to mallory, not exampleco');
    expect(STORED).toMatchObject({ githubClientId: 'Iv23liOLD', webhookSecret: 'old-secret' });
    expect(Object.keys(SECRETS)).toEqual(['old']);
  });
});

describe('the app’s client secret', () => {
  it('is kept from the code GitHub sends back, in the secret store only, and named, never shown', async () => {
    // It used to be dropped, and without it no task's token can be narrowed to its repository.
    const { audit } = await import('@fleetadlc/db');
    const { privateKey: pem } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith('https://api.github.com/')) return realFetch(input, init);
      const answer = url.includes('/app-manifests/')
        ? { client_id: 'Iv23liNEW', client_secret: 'zzz-client-secret-zzz', pem, slug: 'fleetadlc-janedoe' }
        : {};
      return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    await start({ hasCloudflared: false });
    const prepared = (await (await fetch(`${bridgeUrl}/v1/app-manifest/prepare`, { method: 'POST' })).json()) as Prepared;

    const response = await fetch(`${bridgeUrl}/v1/app-manifest/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'one-time-code', state: new URL(prepared.postUrl).searchParams.get('state') }),
    });

    expect(response.status).toBe(200);
    expect(SECRETS['github-app-client-secret']).toBe('zzz-client-secret-zzz');
    expect(JSON.stringify(STORED)).not.toContain('zzz-client-secret-zzz');
    expect(await response.text()).not.toContain('zzz-client-secret-zzz');
    const said = JSON.stringify(vi.mocked(audit).mock.calls);
    expect(said).toContain('appClientSecret');
    expect(said).not.toContain('zzz-client-secret-zzz');
  });

  it('is written to the secret store by PATCH /v1/install, and cleared by an empty one', async () => {
    await start();
    const patch = (value: string) =>
      fetch(`${bridgeUrl}/v1/install`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appClientSecret: value }),
      });

    expect((await patch('  zzz-pasted-zzz  ')).status).toBe(200);
    expect(SECRETS['github-app-client-secret']).toBe('zzz-pasted-zzz');
    expect(STORED).not.toHaveProperty('appClientSecret');

    expect((await patch('')).status).toBe(200);
    expect(SECRETS).not.toHaveProperty('github-app-client-secret');
  });
});

describe('the webhook secret, written through PATCH /v1/install', () => {
  it('goes to the secret store, takes an older install’s row with it, and is cleared by an empty one', async () => {
    await start();
    STORED.webhookSecret = 'zzz-old-row-zzz';
    const patch = (value: string) =>
      fetch(`${bridgeUrl}/v1/install`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ webhookSecret: value }),
      });

    expect((await patch('zzz-pasted-zzz')).status).toBe(200);
    expect(SECRETS['github-webhook-secret']).toBe('zzz-pasted-zzz');
    expect(STORED).not.toHaveProperty('webhookSecret');

    expect((await patch('')).status).toBe(200);
    expect(SECRETS).not.toHaveProperty('github-webhook-secret');
  });
});

