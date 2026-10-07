import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppApi } from '@fleetadlc/github';
import type { Spawner, TunnelProcess } from './tunnel.js';

/**
 * The whole of the webhook step, with nothing real behind it: no GitHub, no
 * cloudflared, no database. What is being tested is the order things happen in and what is
 * reported when one of them does not.
 */
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

  settings: {
    allSettings: vi.fn(async () => STORED),
    setSetting: vi.fn(async (key: string, value: string) => {
      // An empty value deletes the row, as the real store does.
      if (value === '') delete STORED[key];
      else STORED[key] = value;
    }),
  },
  // What reconcile recorded of activity GitHub never delivered, and when the
  // bridge last took a delivery: the two local facts the webhook's report reads.
  listEventsOfType: vi.fn(async (type: string, since: Date) =>
    UNHEARD_EVENTS.filter((event) => type === 'webhook.unheard' && Date.parse(event.at) >= since.getTime()),
  ),
  lastGithubDelivery: vi.fn(async () => HEARD),
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

let STORED: Record<string, string> = {};
let SECRETS: Record<string, string> = {};
/** Where the webhook secret is kept: the secret store, never the settings table. */
const HOOK_SECRET = 'github-webhook-secret';
let UNHEARD_EVENTS: { id: number; at: string; payload: unknown }[] = [];
let HEARD: { at: string; type: string } | null = null;
/** Who owns the app, as `GET /app` says. */
let OWNER: { login: string; type: 'User' | 'Organization' } = { login: 'janedoe', type: 'User' };
/** What GitHub's hook config holds, and every call made against it. */
let HOOK: { url: string; secret?: string };
let CALLS: { method: string; path: string; body?: unknown }[];

/**
 * A real key, because a fake one is not inert: the app JWT is signed with it
 * before any request is made, and `createSign` throws on a PEM it cannot parse.
 * With the error swallowed by a `catch`, that presented as GitHub being
 * unreachable in every case.
 */
const { privateKey: PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const BANNER = 'INF |  https://calm-badger-42.trycloudflare.com  |\n';
let DELIVERIES: unknown[] = [];
/** Set to make GitHub's list of deliveries fail rather than answer. */
let DELIVERIES_FAIL = false;

function fakeGitHub(options: { refuse?: boolean } = {}): AppApi {
  return {
    request: async <T>(method: string, path: string, _token: string, body?: unknown): Promise<T> => {
      CALLS.push({ method, path, body });
      if (path.startsWith('/app/hook/deliveries')) {
        if (DELIVERIES_FAIL) throw new Error('/app/hook/deliveries → 502');
        return DELIVERIES as T;
      }
      if (path === '/app') return { slug: 'fleetadlc-janedoe', id: 7, owner: OWNER } as T;
      if (options.refuse) throw new Error('/app/hook/config → 422: url is invalid');
      if (method === 'PATCH') {
        const sent = body as { url?: string; secret?: string };
        HOOK = { url: sent.url ?? HOOK.url, secret: sent.secret ?? HOOK.secret };
      }
      return { url: HOOK.url, ...(HOOK.secret ? { secret: '********' } : {}) } as T;
    },
  };
}

function fakeCloudflared(): { spawner: Spawner; killed: () => number } {
  let kills = 0;
  const spawner: Spawner = () => {
    const events = new EventEmitter();
    const stderr = new Readable({ read() {} });
    setTimeout(() => stderr.push(BANNER), 0);
    const child: TunnelProcess = {
      stderr,
      stdout: null,
      once: (event, listener) => events.once(event, listener as (...a: unknown[]) => void),
      kill: () => {
        kills += 1;
        return true;
      },
      pid: 1234,
    };
    return child;
  };
  return { spawner, killed: () => kills };
}

const CONFIG = {
  port: 47311,
  organization: 'janedoe',
  gitHubClientId: 'Iv23liTEST',
  automationBot: 'atlas',
  humans: [],
  publicUrl: '',
  webhookSecret: '',
} as never;

async function subject(overrides: Record<string, unknown> = {}) {
  const { WebhookSetup } = await import('./webhook-setup.js');
  const { spawner } = fakeCloudflared();
  return new WebhookSetup({
    config: CONFIG,
    api: fakeGitHub(),
    spawner,
    startGateway: async () => ({ port: 59999, close: async () => undefined }),
    generateSecret: () => 'generated-secret',
    hasCloudflared: () => true,
    ...overrides,
  });
}

beforeEach(async () => {
  STORED = {};
  SECRETS = {};
  CALLS = [];
  DELIVERIES = [];
  DELIVERIES_FAIL = false;
  UNHEARD_EVENTS = [];
  HEARD = null;
  OWNER = { login: 'janedoe', type: 'User' };
  HOOK = { url: 'https://example.invalid/webhooks/github' };
  const { appPrivateKeyRef } = await import('@fleetadlc/github');
  SECRETS[appPrivateKeyRef()] = PRIVATE_KEY;
});

describe('a laptop, with a tunnel OpenADLC raises itself', () => {
  it('asks the operator for nothing but the choice', async () => {
    const setup = await subject();

    const status = await setup.configure({ mode: 'tunnel' });

    // The address, the secret and GitHub's hook: all three set, none typed.
    expect(status.publicUrl).toBe('https://calm-badger-42.trycloudflare.com');
    expect(status.webhookUrl).toBe('https://calm-badger-42.trycloudflare.com/webhooks/github');
    expect(status.configured).toBe(true);
    expect(STORED.publicUrl).toBe('https://calm-badger-42.trycloudflare.com');
    expect(SECRETS[HOOK_SECRET]).toBe('generated-secret');
  });

  it('starts one gateway when two raise a tunnel at once', async () => {
    const startGateway = vi.fn(async () => ({ port: 59999, close: async () => undefined }));
    const setup = await subject({ startGateway });

    await Promise.all([setup.configure({ mode: 'tunnel' }), setup.configure({ mode: 'tunnel' })]);

    expect(startGateway).toHaveBeenCalledTimes(1);
  });

  it('writes the same secret to GitHub that it stored', async () => {
    // The two halves disagreeing is the classic failure of doing this by hand,
    // and it presents as deliveries that arrive and are all refused.
    const setup = await subject();
    await setup.configure({ mode: 'tunnel' });

    const patch = CALLS.find((call) => call.method === 'PATCH');
    expect((patch?.body as { secret?: string }).secret).toBe(SECRETS[HOOK_SECRET]);
  });

  it('points the tunnel at the gateway, never at the bridge', async () => {
    // The bridge believes `x-fleetadlc-identity`. A tunnel onto its port would let a
    // stranger answer a gate as the operator.
    const ports: number[] = [];
    const setup = await subject({
      startGateway: async () => ({ port: 59999, close: async () => undefined }),
      spawner: ((_command: string, args: string[]) => {
        ports.push(Number(args[args.length - 1]?.split(':').pop()));
        const events = new EventEmitter();
        const stderr = new Readable({ read() {} });
        setTimeout(() => stderr.push(BANNER), 0);
        return {
          stderr,
          stdout: null,
          once: (event: string, listener: unknown) => events.once(event, listener as () => void),
          kill: () => true,
        };
      }) as Spawner,
    });

    await setup.configure({ mode: 'tunnel' });

    expect(ports).toEqual([59999]);
    expect(ports).not.toContain(47311);
  });

  it('keeps a secret it already had rather than rotating it', async () => {
    // Rotating on every address change opens a window where GitHub signs with
    // one value and the bridge checks another.
    STORED.webhookSecret = 'the-existing-one';
    const setup = await subject();

    await setup.configure({ mode: 'tunnel' });

    expect(SECRETS[HOOK_SECRET]).toBe('the-existing-one');
    // An older install's row is moved, not left behind in the database.
    expect(STORED.webhookSecret).toBeUndefined();
  });

  it('keeps the secret in the secret store, and never in the settings table', async () => {
    const setup = await subject();
    await setup.configure({ mode: 'tunnel' });

    expect(SECRETS[HOOK_SECRET]).toBe('generated-secret');
    expect(STORED).not.toHaveProperty('webhookSecret');
  });
});

describe('an install that already has an address', () => {
  it('takes the address and points GitHub at it', async () => {
    const setup = await subject();

    const status = await setup.configure({ mode: 'address', url: 'https://fleetadlc.example.com' });

    expect(status.webhookUrl).toBe('https://fleetadlc.example.com/webhooks/github');
    expect(status.configured).toBe(true);
    expect(status.tunnel.running).toBe(false);
  });

  it('refuses an address GitHub could never deliver to', async () => {
    const setup = await subject();

    await expect(setup.configure({ mode: 'address', url: 'http://127.0.0.1:47311' })).rejects.toThrow(
      /cannot reach|https/,
    );
    // Nothing stored, so the install does not claim to be configured.
    expect(STORED.publicUrl).toBeUndefined();
  });

  it('stops a tunnel it had raised, so it is not left orphaned', async () => {
    const cloudflared = fakeCloudflared();
    const setup = await subject({ spawner: cloudflared.spawner });

    await setup.configure({ mode: 'tunnel' });
    await setup.configure({ mode: 'address', url: 'https://fleetadlc.example.com' });

    expect(cloudflared.killed()).toBeGreaterThan(0);
  });

  it('kills its tunnel before stopping awaits anything, as a bridge exiting without shutting down needs', async () => {
    const cloudflared = fakeCloudflared();
    const setup = await subject({ spawner: cloudflared.spawner });

    await setup.configure({ mode: 'tunnel' });
    const stopping = setup.stopTunnel();

    expect(cloudflared.killed()).toBe(1);
    expect((await stopping).tunnel.running).toBe(false);
  });
});

describe('when something will not work', () => {
  it('stores nothing if GitHub refuses the hook', async () => {
    // Otherwise the install records an address GitHub never accepted and then
    // reports itself as configured.
    const setup = await subject({ api: fakeGitHub({ refuse: true }) });

    await expect(setup.configure({ mode: 'address', url: 'https://fleetadlc.example.com' })).rejects.toThrow(
      /422/,
    );
    expect(STORED.publicUrl).toBeUndefined();
    expect(SECRETS[HOOK_SECRET]).toBeUndefined();
  });

  it('still saves both values when OpenADLC holds no app key, and says so', async () => {
    // The fallback path. The person edits the app's settings themselves, which is
    // the old behaviour — kept, but no longer the default.
    SECRETS = {};
    const setup = await subject();

    const status = await setup.configure({ mode: 'address', url: 'https://fleetadlc.example.com' });

    expect(status.canAutomate).toBe(false);
    expect(STORED.publicUrl).toBe('https://fleetadlc.example.com');
    expect(SECRETS[HOOK_SECRET]).toBe('generated-secret');
    expect(status.ready).toBe(false);
    expect(status.detail).toMatch(/could not be asked/);
  });

  it('says a tunnel cannot be raised on a machine without cloudflared', async () => {
    const setup = await subject({ hasCloudflared: () => false });
    expect((await setup.status()).tunnelAvailable).toBe(false);
  });
});

describe('after the bridge restarts', () => {
  it('calls a stored tunnel address stale rather than showing it as working', async () => {
    // A quick tunnel's hostname dies with the process that raised it. The stored
    // address survives, so the install looks configured and receives nothing.
    STORED = {
      publicUrl: 'https://calm-badger-42.trycloudflare.com',
      webhookSecret: 'generated-secret',
    };
    HOOK = { url: 'https://calm-badger-42.trycloudflare.com/webhooks/github', secret: 'generated-secret' };

    const setup = await subject();
    const status = await setup.status();

    expect(status.stale).toBe(true);
    expect(status.ready).toBe(false);
    expect(status.detail).toMatch(/no longer running/);
  });

  it('does not call a real address stale, since nothing about it expired', async () => {
    STORED = { publicUrl: 'https://fleetadlc.example.com', webhookSecret: 'generated-secret' };
    HOOK = { url: 'https://fleetadlc.example.com/webhooks/github', secret: 'generated-secret' };
    DELIVERIES = [{ event: 'issues', action: 'labeled', status_code: 200, delivered_at: '2026-09-24T17:58:00Z', redelivery: false }];

    const status = await (await subject()).status();

    expect(status.stale).toBe(false);
    expect(status.ready).toBe(true);
  });

  it('reports a hook somebody repointed from GitHub instead of trusting what it stored', async () => {
    STORED = { publicUrl: 'https://fleetadlc.example.com', webhookSecret: 'generated-secret' };
    HOOK = { url: 'https://somewhere-else.example/webhooks/github', secret: 'generated-secret' };

    const status = await (await subject()).status();

    expect(status.ready).toBe(false);
    expect(status.detail).toMatch(/pointed at https:\/\/somewhere-else\.example/);
  });
});

describe('the tick in the step list', () => {
  /**
   * Rendered on the server, so it must be right without asking GitHub — and it
   * was computed from "a secret is stored", which stays true after the tunnel
   * that made the install reachable has gone. The walkthrough opened on the last
   * step with the webhook shown as done and nothing being delivered.
   */
  it('is not earned by a stored secret alone', async () => {
    STORED = { webhookSecret: 'generated-secret' };
    expect(await (await subject()).localReadiness()).toEqual({ ready: false, stale: false });
  });

  it('is withdrawn when the tunnel behind the address is gone', async () => {
    STORED = {
      publicUrl: 'https://calm-badger-42.trycloudflare.com',
      webhookSecret: 'generated-secret',
    };

    expect(await (await subject()).localReadiness()).toEqual({ ready: false, stale: true });
  });

  it('is given while that tunnel is still running', async () => {
    const setup = await subject();
    await setup.configure({ mode: 'tunnel' });

    expect(await setup.localReadiness()).toEqual({ ready: true, stale: false });
  });

  it('is given to a fixed address, which nothing about expires', async () => {
    STORED = { publicUrl: 'https://fleetadlc.example.com', webhookSecret: 'generated-secret' };

    expect(await (await subject()).localReadiness()).toEqual({ ready: true, stale: false });
  });

  it('costs no call to GitHub, since the page renders on every load', async () => {
    STORED = { publicUrl: 'https://fleetadlc.example.com', webhookSecret: 'generated-secret' };
    await (await subject()).localReadiness();

    expect(CALLS).toEqual([]);
  });
});

describe('what GitHub last delivered', () => {
  it('reports GitHub’s own record of its last delivery beside where the hook points', async () => {
    DELIVERIES = [{ event: 'ping', action: null, status_code: 200, delivered_at: '2026-09-24T17:58:00Z', redelivery: false }];
    const setup = await subject();

    const status = await setup.status();

    expect(status.lastDelivery).toEqual({ event: 'ping', action: null, statusCode: 200, deliveredAt: '2026-09-24T17:58:00Z', redelivery: false });
  });

  it('asks nothing about deliveries when OpenADLC cannot speak as the app', async () => {
    const { appPrivateKeyRef } = await import('@fleetadlc/github');
    delete SECRETS[appPrivateKeyRef()];
    const setup = await subject();

    const status = await setup.status();

    expect(status.lastDelivery).toBeNull();
    expect(CALLS.some((call) => call.path.startsWith('/app/hook/deliveries'))).toBe(false);
  });
});

describe('a restart', () => {
  it('raises a new tunnel and repoints the app, keeping the secret', async () => {
    // The last run's quick tunnel died with that bridge; GitHub still points
    // at its address, and its last delivery there got no answer.
    STORED = { publicUrl: 'https://old-dead-name.trycloudflare.com', webhookSecret: 'kept-secret' };
    HOOK = { url: 'https://old-dead-name.trycloudflare.com/webhooks/github', secret: 'kept-secret' };
    DELIVERIES = [{ event: 'issue_comment', action: 'created', status_code: 0, delivered_at: '2026-09-24T09:00:00Z', redelivery: false }];
    const setup = await subject();

    const status = await setup.resume();

    expect(status?.ready).toBe(true);
    expect(status?.webhookUrl).toBe('https://calm-badger-42.trycloudflare.com/webhooks/github');
    expect(STORED.publicUrl).toBe('https://calm-badger-42.trycloudflare.com');
    const patch = CALLS.find((call) => call.method === 'PATCH');
    expect(patch?.body).toMatchObject({ url: 'https://calm-badger-42.trycloudflare.com/webhooks/github', secret: 'kept-secret' });
  });

  it('leaves a fixed address, and an install whose app key it lacks, alone', async () => {
    STORED = { publicUrl: 'https://fleetadlc.example.com', webhookSecret: 'kept-secret' };
    expect(await (await subject()).resume()).toBeNull();

    STORED = { publicUrl: 'https://old-dead-name.trycloudflare.com', webhookSecret: 'kept-secret' };
    const { appPrivateKeyRef } = await import('@fleetadlc/github');
    delete SECRETS[appPrivateKeyRef()];
    expect(await (await subject()).resume()).toBeNull();
    expect(CALLS.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('does not call the tunnel stopped while it is being brought back', async () => {
    // The health check runs at start, before cloudflared has said where the new
    // tunnel is: it read "GitHub is delivering to a tunnel that has stopped"
    // there at every restart, and the card was wrong seconds later.
    STORED = { publicUrl: 'https://old-dead-name.trycloudflare.com', webhookSecret: 'kept-secret' };
    HOOK = { url: 'https://old-dead-name.trycloudflare.com/webhooks/github', secret: 'kept-secret' };
    const stderr = new Readable({ read() {} });
    const spawner: Spawner = () => ({
      stderr,
      stdout: null,
      once: () => undefined,
      kill: () => true,
      pid: 1234,
    });
    const setup = await subject({ spawner });

    const resuming = setup.resume();
    const during = await setup.status();
    expect(during).toMatchObject({ stale: false, resuming: true });
    expect((await setup.localReadiness()).stale).toBe(false);

    stderr.push(BANNER);
    expect((await resuming)?.publicUrl).toBe('https://calm-badger-42.trycloudflare.com');
    expect(await setup.status()).toMatchObject({ stale: false, resuming: false });
  });

  it('calls it stopped once bringing it back has not worked', async () => {
    STORED = { publicUrl: 'https://old-dead-name.trycloudflare.com', webhookSecret: 'kept-secret' };
    const setup = await subject({ hasCloudflared: () => false });

    expect(await setup.resume()).toBeNull();
    expect(await setup.status()).toMatchObject({ stale: true, resuming: false });
    expect((await setup.localReadiness()).stale).toBe(true);
  });

  it('does not raise again a tunnel a person took down', async () => {
    const setup = await subject();
    await setup.configure({ mode: 'tunnel' });

    const status = await setup.takeDown();

    expect(status.tunnel.running).toBe(false);
    expect(STORED.publicUrl).toBeUndefined();
    const patches = CALLS.filter((call) => call.method === 'PATCH').length;
    expect(await (await subject()).resume()).toBeNull();
    expect(CALLS.filter((call) => call.method === 'PATCH').length).toBe(patches);
  });

  it('keeps a fixed address when taking down', async () => {
    STORED = { publicUrl: 'https://fleetadlc.example.com', webhookSecret: 'kept-secret' };
    await (await subject()).takeDown();
    expect(STORED.publicUrl).toBe('https://fleetadlc.example.com');
  });

  it('does not raise a second tunnel over one already running', async () => {
    const setup = await subject();
    await setup.configure({ mode: 'tunnel' });
    const patches = CALLS.filter((call) => call.method === 'PATCH').length;

    expect(await setup.resume()).toBeNull();
    expect(CALLS.filter((call) => call.method === 'PATCH').length).toBe(patches);
  });
});

/** A moment `minutes` ago, by this machine's clock, which is what the window is measured against. */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

/** What reconcile records when it finds an issue whose webhook never came. */
function unheardEvent(found: { subject: string; happenedAt: string; foundAt: string; what?: string }) {
  return {
    id: 1,
    at: found.foundAt,
    payload: {
      subject: found.subject,
      what: found.what ?? 'imported',
      title: 'Document the webhook step',
      url: 'https://github.com/janedoe/fleetadlc-testbed/issues/1',
      happenedAt: found.happenedAt,
    },
  };
}

/** Everything OpenADLC can set, set: the hook points here and both halves hold the secret. */
function configuredHere(): void {
  STORED = { publicUrl: 'https://fleetadlc.example.com', webhookSecret: 'generated-secret' };
  HOOK = { url: 'https://fleetadlc.example.com/webhooks/github', secret: 'generated-secret' };
}

/**
 * Whether GitHub sends at all.
 *
 * Measured on a real install: the app was created from the manifest before the
 * install had an address, so GitHub made its webhook switched off. The webhook
 * step then wrote the address and the secret — which `PATCH /app/hook/config`
 * can do, and which does not switch it on — and this said `ready: true` while
 * GitHub's list of deliveries was empty and stayed empty. The intake bot's
 * first issue never reached the board.
 */
describe('whether GitHub sends at all', () => {
  it('is not ready on an address and a secret alone', async () => {
    configuredHere();

    const status = await (await subject()).status();

    expect(status.configured).toBe(true);
    expect(status.hearing).toBe('never');
    expect(status.ready).toBe(false);
    expect(status.detail).toMatch(/has not delivered anything yet/);
  });

  it('says GitHub is not sending once reconcile has found what it never delivered', async () => {
    configuredHere();
    UNHEARD_EVENTS = [unheardEvent({ subject: 'fleetadlc-testbed#1', happenedAt: minutesAgo(40), foundAt: minutesAgo(30) })];

    const status = await (await subject()).status();

    const { NOT_SENDING } = await import('./webhook-setup.js');
    expect(status.hearing).toBe('silent');
    expect(status.ready).toBe(false);
    expect(status.detail).toBe(NOT_SENDING);
    expect(NOT_SENDING).toBe('GitHub is not sending events to OpenADLC. Open the app’s settings and turn on Active under Webhook');
    expect(status.unheard.map((entry) => entry.subject)).toEqual(['fleetadlc-testbed#1']);
    // The one page where Active can be switched on.
    expect(status.settingsUrl).toBe('https://github.com/settings/apps/fleetadlc-janedoe');
  });

  it('links an organization’s app under the organization’s settings', async () => {
    configuredHere();
    OWNER = { login: 'acme', type: 'Organization' };

    expect((await (await subject()).status()).settingsUrl).toBe(
      'https://github.com/organizations/acme/settings/apps/fleetadlc-janedoe',
    );
  });

  it('is ready once GitHub lists a delivery, whatever reconcile found', async () => {
    // A delivery on record means GitHub sends. What reconcile found was a
    // delivery that failed — a tunnel down, a laptop asleep — not a switch off.
    configuredHere();
    UNHEARD_EVENTS = [unheardEvent({ subject: 'fleetadlc-testbed#1', happenedAt: minutesAgo(40), foundAt: minutesAgo(30) })];
    DELIVERIES = [{ event: 'issues', action: 'opened', status_code: 0, delivered_at: minutesAgo(40), redelivery: false }];

    const status = await (await subject()).status();

    expect(status.hearing).toBe('heard');
    expect(status.ready).toBe(true);
  });

  it('does not read a list it could not get as an empty one', async () => {
    // "Could not ask" said as "GitHub sends nothing" would send somebody to a
    // switch that is already on.
    configuredHere();
    UNHEARD_EVENTS = [unheardEvent({ subject: 'fleetadlc-testbed#1', happenedAt: minutesAgo(40), foundAt: minutesAgo(30) })];
    DELIVERIES_FAIL = true;

    const status = await (await subject()).status();

    expect(status.hearing).toBe('unknown');
    expect(status.detail).not.toMatch(/not sending/);
  });

  it('does not count what happened too long ago to still be in GitHub’s list', async () => {
    // GitHub keeps three days of deliveries. An issue from four days ago may
    // have been delivered and aged out; it says nothing about the switch.
    configuredHere();
    UNHEARD_EVENTS = [unheardEvent({ subject: 'fleetadlc-testbed#1', happenedAt: minutesAgo(4 * 24 * 60), foundAt: minutesAgo(30) })];

    expect((await (await subject()).status()).hearing).toBe('never');
  });

  it('asks GitHub what it delivered after writing the hook, rather than calling it done', async () => {
    const status = await (await subject()).configure({ mode: 'address', url: 'https://fleetadlc.example.com' });

    expect(CALLS.some((call) => call.path.startsWith('/app/hook/deliveries'))).toBe(true);
    expect(status.ready).toBe(false);
    expect(status.hearing).toBe('never');
  });
});

/**
 * The app about to be created.
 *
 * GitHub makes an app's webhook switched on only when the manifest gives it an
 * address, and nothing but a person on the app's settings page can switch it
 * on afterwards. The walkthrough created the app before it had one, so every
 * app it made was switched off for good.
 */
describe('an address for the app about to be created', () => {
  it('raises the tunnel first when there is no address, and keeps it as the install’s', async () => {
    const cloudflared = fakeCloudflared();
    let spawned = 0;
    const setup = await subject({
      spawner: ((command: string, args: string[]) => {
        spawned += 1;
        return cloudflared.spawner(command, args);
      }) as Spawner,
    });

    expect(await setup.newAppAddress()).toBe('tunnel');
    // Asking what it would take raises nothing.
    expect(spawned).toBe(0);

    const address = await setup.addressForNewApp();

    expect(spawned).toBe(1);
    expect(address).toBe('https://calm-badger-42.trycloudflare.com');
    // Where `resume()` raises a new tunnel and repoints the app from, on every start.
    expect(STORED.publicUrl).toBe('https://calm-badger-42.trycloudflare.com');
    // No app yet, so nothing to write to on GitHub; and the secret is GitHub's to make.
    expect(CALLS).toEqual([]);
    expect(SECRETS[HOOK_SECRET]).toBeUndefined();
  });

  it('uses the address the install already answers on, raising nothing', async () => {
    STORED = { publicUrl: 'https://fleetadlc.example.com' };
    const setup = await subject({ spawner: (() => { throw new Error('no tunnel was asked for'); }) as Spawner });

    expect(await setup.newAppAddress()).toBe('have');
    expect(await setup.addressForNewApp()).toBe('https://fleetadlc.example.com');
  });

  it('does not create the app at a tunnel address that died with the last bridge', async () => {
    STORED = { publicUrl: 'https://old-dead-name.trycloudflare.com' };
    const setup = await subject();

    expect(await setup.newAppAddress()).toBe('tunnel');
    expect(await setup.addressForNewApp()).toBe('https://calm-badger-42.trycloudflare.com');
  });

  it('says there is none to be had without cloudflared, and raises nothing', async () => {
    const setup = await subject({
      hasCloudflared: () => false,
      spawner: (() => { throw new Error('no tunnel was asked for'); }) as Spawner,
    });

    expect(await setup.newAppAddress()).toBe('none');
    expect(await setup.addressForNewApp()).toBeNull();
    expect(STORED.publicUrl).toBeUndefined();
  });
});

describe('an app created before there was an address', () => {
  it('is known by the placeholder GitHub still holds, which pointing it here replaces', async () => {
    // The manifest gives such an app `https://example.invalid/…`, switched off.
    // The step says so before the person chooses, because pointing it here will
    // not switch it on and one more box will need ticking.
    const setup = await subject();
    expect((await setup.status()).placeholderHook).toBe(true);

    const configured = await setup.configure({ mode: 'address', url: 'https://fleetadlc.example.com' });
    expect(configured.placeholderHook).toBe(false);
    // Still switched off, which is what the step goes on to say.
    expect(configured.hearing).toBe('never');
  });
});
