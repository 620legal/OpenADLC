import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The internal routes a rename reaches: a lease the dispatcher asked for under
 * the name it read, and the reconcile `fleetadlc auth login` asks for once it has
 * stored a credential. The store is a fake and the HTTP is real, like the
 * other route tests.
 */

const crew = vi.hoisted(() => [
  { id: 'bot-builder', name: 'fleetadlc-atlas-janedoe', slot: 'builder', githubLogin: 'fleetadlc-atlas-janedoe' },
]);

vi.mock('@fleetadlc/db', () => ({
  audit: vi.fn(async () => undefined),
  bots: {
    listBots: vi.fn(async () => crew),
    getBotById: vi.fn(async (id: string) => crew.find((bot) => bot.id === id) ?? null),
    getBotByName: vi.fn(async (name: string) => crew.find((bot) => bot.name === name) ?? null),
  },
  costs: { currentPeriod: vi.fn(() => '2026-09') },
  spendingLimits: { refusal: vi.fn(async () => null) },
  credentials: {},
  issues: {},
  leases: { setLeaseState: vi.fn(async () => undefined) },
  listAudit: vi.fn(),
  mergeLines: {},
  recordEvent: vi.fn(),
  repos: { getRepoByName: vi.fn(async () => ({ id: 'repo-1', name: 'testbed', fullName: 'janedoe/testbed' })) },
  requests: {},
  sessions: {},
  settings: { allSettings: vi.fn(async () => ({})) },
  tasks: {},
  threads: {},
}));

const SECRET = 'install-secret-for-the-test';
let bridge: Server;
let bridgeUrl: string;
const opened: Record<string, unknown>[] = [];
const assigned: string[] = [];
const comments: string[] = [];
const reconciled: string[] = [];
let startup: Promise<void>;
let finishStartup: () => void;
let gate: import('./dispatch-gate.js').DispatchGate;

beforeEach(async () => {
  const { registerInternalApi } = await import('./internal-api.js');
  const { Router } = await import('./router.js');
  const { DispatchGate } = await import('./dispatch-gate.js');
  gate = new DispatchGate();
  opened.length = 0;
  assigned.length = 0;
  comments.length = 0;
  reconciled.length = 0;
  startup = new Promise((resolve) => (finishStartup = resolve));

  const router = new Router();
  registerInternalApi(router, {
    config: { automationBot: null, costs: { monthlyCapUsd: 500, perTaskCapUsd: 25 } } as never,
    webhooks: {} as never,
    scheduler: {} as never,
    stages: {} as never,
    internalSecret: SECRET,
    alertsSecret: '',
    hostd: {} as never,
    actors: {} as never,
    automation: {
      assignIssue: async (_repo: string, _issue: number, bot: string) => void assigned.push(bot),
      comment: async (_repo: string, _issue: number, body: string) => void comments.push(body),
    } as never,
    gates: {} as never,
    taskService: {
      open: async (input: Record<string, unknown>) => {
        opened.push(input);
        return { taskId: 'task-1', session: 's' };
      },
    } as never,
    onboarding: {} as never,
    invitations: {} as never,
    threadStream: {} as never,
    webhookSetup: {} as never,
    repoSetup: {} as never,
    names: {
      settled: () => startup,
      reconcile: async (actor: string) => {
        reconciled.push(actor);
        return [{ botId: 'bot-builder', from: 'builder', to: 'fleetadlc-atlas-janedoe', state: 'renamed' }];
      },
    } as never,
    dispatchGate: gate,
  });

  bridge = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  bridgeUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => bridge.close(() => resolve()));
});

function post(path: string, body: unknown, secret = SECRET) {
  return fetch(`${bridgeUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fleetadlc-internal-secret': secret },
    body: JSON.stringify(body),
  });
}

describe('a lease for a bot renamed since the dispatcher read it', () => {
  it('waits for the start-up renames, then works under the name the bot has now', async () => {
    // The dispatcher read `builder`; the bot has since connected and is
    // `fleetadlc-atlas-janedoe`. Its id is what finds it.
    const leased = post('/internal/dispatch/lease', {
      leaseId: 'lease-1',
      repo: 'testbed',
      issue: 12,
      bot: 'builder',
      botId: 'bot-builder',
      declaredPaths: ['src/**'],
      expiresAt: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(opened).toEqual([]);

    finishStartup();
    const response = await leased;

    expect(response.status).toBe(200);
    expect(opened).toEqual([
      expect.objectContaining({
        bot: 'fleetadlc-atlas-janedoe',
        botId: 'bot-builder',
        branch: 'agent/fleetadlc-atlas-janedoe/12-issue-12',
      }),
    ]);
    expect(assigned).toEqual(['fleetadlc-atlas-janedoe']);
    expect(comments[0]).toContain('Leased to `fleetadlc-atlas-janedoe`');
  });
});

describe('a lease while a backup is restored into the install', () => {
  it('is refused in the restore’s words, starting nothing, and taken again once the restore lets go', async () => {
    const release = gate.hold('paused while a backup is restored into this install; it starts again once that is done');
    finishStartup();
    const lease = {
      leaseId: 'lease-2',
      repo: 'testbed',
      issue: 13,
      bot: 'fleetadlc-atlas-janedoe',
      botId: 'bot-builder',
      declaredPaths: ['src/**'],
      expiresAt: null,
    };

    const refused = await post('/internal/dispatch/lease', lease);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe(
      'paused while a backup is restored into this install; it starts again once that is done',
    );
    expect(opened).toEqual([]);

    release();
    expect((await post('/internal/dispatch/lease', lease)).status).toBe(200);
    expect(opened).toHaveLength(1);
  });
});

describe('a lease while a person has paused work', () => {
  it('is refused in the pause’s words, starting nothing, and taken again once work is resumed', async () => {
    gate.pauseWork('work is paused, by janedoe since 2026-09-29T10:00:00.000Z; resume it in Settings → Pause work');
    finishStartup();
    const lease = { leaseId: 'lease-3', repo: 'testbed', issue: 14, bot: 'fleetadlc-atlas-janedoe', botId: 'bot-builder', declaredPaths: ['src/**'], expiresAt: null };

    const refused = await post('/internal/dispatch/lease', lease);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain('work is paused, by janedoe');
    expect(opened).toEqual([]);

    gate.pauseWork(null);
    expect((await post('/internal/dispatch/lease', lease)).status).toBe(200);
  });
});

describe('a lease in a repository a person paused', () => {
  it('is refused in that pause’s words, and a lease in another repository is taken', async () => {
    const words = 'work is paused in testbed, by janedoe since 2026-09-29T10:00:00.000Z (a migration is running); resume it in Settings → Pause work';
    gate.pauseRepo('testbed', words);
    finishStartup();
    const lease = { leaseId: 'lease-4', repo: 'testbed', issue: 15, bot: 'fleetadlc-atlas-janedoe', botId: 'bot-builder', declaredPaths: ['src/**'], expiresAt: null };

    const refused = await post('/internal/dispatch/lease', lease);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe(words);
    expect(opened).toEqual([]);

    const { repos } = await import('@fleetadlc/db');
    vi.mocked(repos.getRepoByName).mockResolvedValueOnce({ id: 'repo-2', name: 'other', fullName: 'janedoe/other' } as never);
    expect((await post('/internal/dispatch/lease', { ...lease, leaseId: 'lease-5', repo: 'other' })).status).toBe(200);
    expect(opened).toHaveLength(1);
    gate.pauseRepo('testbed', null);
  });
});

describe('asking the bridge to bring the crew’s names up to date', () => {
  it('reconciles as whoever asked, and answers with each bot’s name and seat', async () => {
    const response = await post('/internal/bots/reconcile', { actor: 'fleetadlc auth login' });

    expect(response.status).toBe(200);
    expect(reconciled).toEqual(['fleetadlc auth login']);
    expect(await response.json()).toEqual({
      outcomes: [{ botId: 'bot-builder', from: 'builder', to: 'fleetadlc-atlas-janedoe', state: 'renamed' }],
      bots: [{ bot: 'fleetadlc-atlas-janedoe', slot: 'builder', githubLogin: 'fleetadlc-atlas-janedoe' }],
    });
  });

  it('is refused without the install’s secret', async () => {
    expect((await post('/internal/bots/reconcile', {}, 'wrong')).status).toBe(401);
    expect(reconciled).toEqual([]);
  });
});
