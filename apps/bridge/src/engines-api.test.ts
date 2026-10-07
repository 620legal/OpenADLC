import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// What the assignment step reads to fill its rows: the crew from the
// database, and what hostd says each bot can run. The store is a fake and the
// HTTP is real, the same shape as the worktree route's tests.
const ACCOUNT = '550e8400-e29b-41d4-a716-446655440000';

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
  modelAccounts: { list: vi.fn(async () => []), get: vi.fn(async () => null), create: vi.fn(), remove: vi.fn() },
  bots: {
    listBots: vi.fn(async () => [
      // Connected, so it goes by its account's handle.
      {
        id: 'bot-builder',
        name: 'fleetadlc-atlas-janedoe',
        slot: 'builder',
        role: 'implement',
        engine: 'claude',
        model: 'newest:opus',
        modelAccountId: ACCOUNT,
      },
      { id: 'bot-automation', name: 'automation', slot: 'automation', role: 'automation', engine: 'none', model: 'none', modelAccountId: null },
    ]),
  },
  costs: {},
  credentials: {
    getCredential: vi.fn(async (id: string) => (id === 'bot-builder' ? { status: 'active' } : null)),
  },
  issues: {},
  leases: {},
  listAudit: vi.fn(),
  mergeLines: {},
  recordEvent: vi.fn(),
  repos: {},
  requests: {},
  sessions: {},
  tasks: {},
  threads: {},
}));

const READY = {
  engine: 'claude',
  ready: true,
  confidence: 'certain',
  detail: '`claude` is here and has a key',
  remedy: '',
  keySource: null,
  hasKey: true,
  needsCommand: 'claude',
  hasCommand: true,
};

let hostd: Server;
let bridge: Server;
let bridgeUrl: string;
/** Whether the stand-in hostd answers at all. */
let answering: boolean;

beforeEach(async () => {
  const { HostdClient } = await import('./hostd-client.js');
  const { registerConsoleApi } = await import('./api.js');
  const { Router } = await import('./router.js');
  answering = true;

  hostd = createServer((request, response) => {
    if (!answering) return; // Holds the request open, as a stuck probe does.
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ host: 'local', bots: [{ bot: 'fleetadlc-atlas-janedoe', readiness: READY }] }));
  });
  await new Promise<void>((resolve) => hostd.listen(0, '127.0.0.1', resolve));
  const hostdPort = (hostd.address() as AddressInfo).port;

  const router = new Router();
  registerConsoleApi(router, {
    // The repository's own config/bots.yaml, which the page proposes from.
    config: { configRoot: join(__dirname, '..', '..', '..', 'config') } as never,
    hostd: new HostdClient(`http://127.0.0.1:${hostdPort}`, 'install-secret-for-the-test', { enginesTimeoutMs: 100 }),
    actors: {} as never,
    invitations: {} as never,
    automation: {} as never,
    gates: {} as never,
    taskService: {} as never,
    threadStream: { subscribe: () => () => undefined, watching: 0 } as never,
    onboarding: {} as never,
    webhookSetup: {} as never,
    repoSetup: {} as never,
  });

  bridge = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  bridgeUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
});

afterEach(async () => {
  hostd.closeAllConnections();
  await new Promise<void>((resolve) => bridge.close(() => resolve()));
  await new Promise<void>((resolve) => hostd.close(() => resolve()));
});

async function engines() {
  const response = await fetch(`${bridgeUrl}/v1/engines`);
  return {
    status: response.status,
    body: (await response.json()) as {
      reachable: boolean;
      bots: {
        bot: string;
        slot: string;
        connected: boolean;
        model: string;
        modelAccountId: string | null;
        readiness: unknown;
      }[];
    },
  };
}

describe('what the assignment step reads about the crew', () => {
  it('says which account each bot is on, beside what it runs and whether it can', async () => {
    // Without the account, the step cannot show a stored assignment, and
    // coming back to it opens a blank form over one that is already made.
    const { status, body } = await engines();

    expect(status).toBe(200);
    expect(body.reachable).toBe(true);
    expect(body.bots.find((one) => one.bot === 'fleetadlc-atlas-janedoe')).toMatchObject({
      model: 'newest:opus',
      modelAccountId: ACCOUNT,
      readiness: { ready: true, confidence: 'certain' },
    });
    expect(body.bots.find((one) => one.bot === 'automation')).toMatchObject({ modelAccountId: null, readiness: null });
  });

  it('says each bot’s seat and whether an account is connected to it, beside the name it goes by', async () => {
    // The name is a handle once an account connects and the seat until then,
    // so a page that keyed its rows by name would lose one mid-connect.
    const { body } = await engines();

    expect(body.bots.map(({ bot, slot, connected }) => ({ bot, slot, connected }))).toEqual([
      { bot: 'fleetadlc-atlas-janedoe', slot: 'builder', connected: true },
      { bot: 'automation', slot: 'automation', connected: false },
    ]);
  });

  it('answers that hostd is not answering, rather than waiting on it', async () => {
    answering = false;

    const started = Date.now();
    const { status, body } = await engines();

    expect(status).toBe(200);
    expect(body.reachable).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(body.bots.map((one) => one.bot)).toEqual(['fleetadlc-atlas-janedoe', 'automation']);
  });

  it('proposes for a seat added from settings what the file gives its role’s first seat', async () => {
    // builder-2 has no entry in config/bots.yaml, and the step proposed nothing for it.
    const { bots } = await import('@fleetadlc/db');
    vi.mocked(bots.listBots).mockResolvedValueOnce([
      { id: 'bot-b2', name: 'builder-2', slot: 'builder-2', role: 'implement', engine: 'claude', model: 'm', modelAccountId: null },
    ] as never);

    const response = await fetch(`${bridgeUrl}/v1/engines`);
    const body = (await response.json()) as { bots: { slot: string; configuredEngine?: string; configuredModel?: string }[] };

    expect(body.bots.find((one) => one.slot === 'builder-2')).toMatchObject({
      configuredEngine: 'claude',
      configuredModel: 'newest:opus',
    });
  });
});

describe('a model key for one bot', () => {
  it('is no longer taken: keys are model accounts', async () => {
    // The per-bot key route outlived the console page that called it. A bot
    // with no account still reads a per-bot key stored before model accounts
    // existed, but nothing writes a new one.
    const response = await fetch(`${bridgeUrl}/v1/engines/key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bot: 'fleetadlc-atlas-janedoe', key: 'sk-test' }),
    });

    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe('no route for POST /v1/engines/key');
  });
});
