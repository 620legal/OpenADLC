import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Whether a delivery is believed, and on what grounds.
 *
 * The secret is configured from the console, which writes it to the settings
 * table — and the verifier read the *start-up* environment, so on every install
 * set up through the browser the check was skipped and the console said it was
 * configured. Same shape as the other route tests: the store is a fake, the HTTP
 * is real, and the signature is a real HMAC.
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

  audit: vi.fn(async () => undefined),
  bots: {},
  costs: {},
  credentials: {},
  issues: {},
  leases: {},
  listAudit: vi.fn(),
  mergeLines: {},
  recordEvent: vi.fn(),
  repos: {},
  requests: {},
  sessions: {},
  settings: { allSettings: vi.fn(async () => STORED) },
  tasks: {},
  threads: {},
}));

let STORED: Record<string, string> = {};

let bridge: Server;
let bridgeUrl: string;
let received: { event: string }[];

/** Every field `effectiveConfig` falls back to, since it reads all of them. */
function config(overrides: Record<string, unknown> = {}) {
  return {
    webhookSecret: '',
    publicUrl: '',
    organization: 'janedoe',
    gitHubClientId: '',
    automationBot: 'atlas',
    humans: [],
    ...overrides,
  } as never;
}

async function startBridge(configured: Record<string, unknown> = {}) {
  const { registerInternalApi } = await import('./internal-api.js');
  const { Router } = await import('./router.js');

  received = [];
  const router = new Router();
  registerInternalApi(router, {
    config: config(configured),
    webhooks: {
      receive: async (event: string) => {
        received.push({ event });
      },
    } as never,
    scheduler: {} as never,
    stages: {} as never,
    internalSecret: 'install-secret-for-the-test',
    alertsSecret: '',
    hostd: {} as never,
    actors: {} as never,
    automation: {} as never,
    gates: {} as never,
    taskService: {} as never,
    onboarding: {} as never,
    invitations: {} as never,
    threadStream: {} as never,
    webhookSetup: {} as never,
    repoSetup: {} as never,
  });

  bridge = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  bridgeUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
}

function signed(payload: string | Uint8Array, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

function deliver(payload: string | Uint8Array, headers: Record<string, string> = {}) {
  return fetch(`${bridgeUrl}/webhooks/github`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': 'issues', ...headers },
    body: payload,
  });
}

beforeEach(() => {
  STORED = {};
});

afterEach(async () => {
  await new Promise<void>((resolve) => bridge.close(() => resolve()));
});

describe('a secret configured from the console', () => {
  it('is the one a delivery is verified against', async () => {
    // The bug: this secret exists only in the settings table, because that is
    // where the console put it. The process started without one.
    STORED = { webhookSecret: 'from-the-console' };
    await startBridge();

    const payload = '{"action":"opened"}';
    const response = await deliver(payload, { 'x-hub-signature-256': signed(payload, 'from-the-console') });

    expect(response.status).toBe(200);
    expect(received).toEqual([{ event: 'issues' }]);
  });

  it('refuses a delivery signed with the wrong one', async () => {
    STORED = { webhookSecret: 'from-the-console' };
    await startBridge();

    const payload = '{"action":"opened"}';
    const response = await deliver(payload, { 'x-hub-signature-256': signed(payload, 'not-it') });

    expect(response.status).toBe(401);
    expect(received).toEqual([]);
  });

  it('refuses an unsigned delivery, rather than skipping the check', async () => {
    STORED = { webhookSecret: 'from-the-console' };
    await startBridge();

    expect((await deliver('{"action":"opened"}')).status).toBe(401);
    expect(received).toEqual([]);
  });

  it('is checked against the bytes GitHub sent, not a decoding of them', async () => {
    // 0xff is not UTF-8. Decoded first, it became U+FFFD, and the HMAC of that
    // text is not the one GitHub computed over the body it sent.
    STORED = { webhookSecret: 'from-the-console' };
    await startBridge();

    const payload = new Uint8Array([...Buffer.from('{"action":"opened","note":"'), 0xff, ...Buffer.from('"}')]);
    const response = await deliver(payload, { 'x-hub-signature-256': signed(payload, 'from-the-console') });

    expect(response.status).toBe(200);
    expect(received).toEqual([{ event: 'issues' }]);
  });

  it('wins over a different one in the environment', async () => {
    // Saving a new secret has to take effect without a restart, or the console
    // is reporting something that is not true yet.
    STORED = { webhookSecret: 'the-new-one' };
    await startBridge({ webhookSecret: 'the-old-one' });

    const payload = '{"action":"opened"}';
    expect((await deliver(payload, { 'x-hub-signature-256': signed(payload, 'the-new-one') })).status).toBe(200);
  });
});

describe('an install with no secret at all', () => {
  it('refuses an unsigned delivery even when nothing but this machine can reach it', async () => {
    // Local was not a reason to skip the check. The body names the person a
    // gate answer is attributed to, and a laptop's port is still an HTTP server.
    await startBridge();

    const response = await deliver('{"action":"opened"}');

    expect(response.status).toBe(401);
    expect(await response.text()).toMatch(/no webhook secret/);
    expect(received).toEqual([]);
  });

  it('says so in the log once, with what to do about it', async () => {
    // A 401 is not logged by the router, so an upgraded install with no secret
    // stopped receiving GitHub without a line anywhere saying why.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await startBridge();

    await deliver('{"action":"opened"}');
    await deliver('{"action":"opened"}');

    const lines = warn.mock.calls.map((call) => String(call[0])).filter((line) => /webhook secret/.test(line));
    warn.mockRestore();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/fleetadlc init/);
    expect(lines[0]).toMatch(/FLEETADLC_WEBHOOK_SECRET/);
  });

  it('refuses a delivery signed with the empty string', async () => {
    // HMAC-SHA256 under an empty key is a signature anybody can compute. A
    // missing secret must not be treated as "verify against nothing".
    await startBridge();

    const payload = '{"action":"opened"}';
    const response = await deliver(payload, { 'x-hub-signature-256': signed(payload, '') });

    expect(response.status).toBe(401);
    expect(received).toEqual([]);
  });

  it('refuses one once an address has been published, and says the secret is missing', async () => {
    STORED = { publicUrl: 'https://calm-badger-42.trycloudflare.com' };
    await startBridge();

    const response = await deliver('{"action":"opened"}');

    expect(response.status).toBe(401);
    expect(await response.text()).toMatch(/no webhook secret/);
    expect(received).toEqual([]);
  });
});
