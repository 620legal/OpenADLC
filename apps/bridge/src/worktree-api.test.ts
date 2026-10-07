import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The console API reads the crew and the task list to turn "atlas" into "the
// worktree of the task atlas is running", which is the only decision this route
// makes. Same shape as hostd's route tests: the store is a fake, the HTTP is real.
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
  // The console router now registers model-account routes, which import these.
  AccountInUse: class AccountInUse extends Error {},
  modelAccounts: { list: vi.fn(async () => []), get: vi.fn(async () => null), create: vi.fn(), remove: vi.fn() },
  bots: {
    getBotByName: vi.fn(async (name: string) => (name === 'atlas' ? { id: 'bot-atlas', name } : null)),
    getBotBySlot: vi.fn(async () => null),
  },
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
  tasks: {
    listTasks: vi.fn(async () => RUNNING_TASKS),
    getTask: vi.fn(async (id: string) => ALL_TASKS.find((task) => task.id === id) ?? null),
  },
  threads: {},
}));

let RUNNING_TASKS: { id: string; subjectRef: string; branch: string | null }[] = [];
let ALL_TASKS: { id: string; botId: string; state: string; subjectRef: string; branch: string | null }[] = [];

let hostd: Server;
let bridge: Server;
let bridgeUrl: string;
let askedFor: string[];

beforeEach(async () => {
  const { HostdClient } = await import('./hostd-client.js');
  const { registerConsoleApi } = await import('./api.js');
  const { Router } = await import('./router.js');

  RUNNING_TASKS = [{ id: 'task-live', subjectRef: 'janedoe/FleetADLC#63', branch: 'agent/atlas/63' }];
  ALL_TASKS = [
    { id: 'task-live', botId: 'bot-atlas', state: 'running', subjectRef: 'janedoe/FleetADLC#63', branch: 'agent/atlas/63' },
    { id: 'task-other', botId: 'bot-atlas', state: 'running', subjectRef: 'janedoe/FleetADLC#64', branch: 'agent/atlas/64' },
    { id: 'task-done', botId: 'bot-atlas', state: 'done', subjectRef: 'janedoe/FleetADLC#60', branch: 'agent/atlas/60' },
    { id: 'task-theirs', botId: 'bot-nova', state: 'running', subjectRef: 'janedoe/FleetADLC#65', branch: 'agent/nova/65' },
  ];
  askedFor = [];

  hostd = createServer((request, response) => {
    askedFor.push(request.url ?? '');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        kind: 'directory',
        path: '',
        entries: [{ name: 'README.md', kind: 'file', size: 21 }],
        truncated: false,
      }),
    );
  });
  await new Promise<void>((resolve) => hostd.listen(0, '127.0.0.1', resolve));
  const hostdPort = (hostd.address() as AddressInfo).port;

  const router = new Router();
  registerConsoleApi(router, {
    config: {} as never,
    hostd: new HostdClient(`http://127.0.0.1:${hostdPort}`, 'install-secret-for-the-test'),
    actors: {} as never,
    invitations: {} as never,
    automation: {} as never,
    gates: {} as never,
    taskService: {} as never,
    // Nothing here subscribes; the stream is another route's business.
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
  await new Promise<void>((resolve) => bridge.close(() => resolve()));
  await new Promise<void>((resolve) => hostd.close(() => resolve()));
});

async function browse(bot: string, path = '', task?: string) {
  const named = task ? `&task=${encodeURIComponent(task)}` : '';
  const response = await fetch(`${bridgeUrl}/v1/worktree/${bot}?path=${encodeURIComponent(path)}${named}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('the Computer tab asking for a bot’s worktree', () => {
  it('answers with the worktree of the task that bot is running', async () => {
    const result = await browse('atlas');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      task: { id: 'task-live', subjectRef: 'janedoe/FleetADLC#63', branch: 'agent/atlas/63' },
      kind: 'directory',
    });
  });

  it('names the task to hostd, because a worktree belongs to a task and the tab is a bot’s', async () => {
    await browse('atlas', 'src/server.ts');
    expect(askedFor[0]).toBe('/tasks/task-live/worktree?path=src%2Fserver.ts');
  });

  it('says there is no task rather than failing, when the bot is between them', async () => {
    // The tab polls. A bot that finished a minute ago is the ordinary state, and
    // rendering it as an error would put a red box in the panel every time.
    RUNNING_TASKS = [];
    const result = await browse('atlas');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ task: null });
    expect(askedFor).toHaveLength(0);
  });

  it('is 404 for a bot that does not exist', async () => {
    expect((await browse('nobody')).status).toBe(404);
  });
});

describe('a seat running several tasks at once', () => {
  it('shows the worktree of the task an item’s tab names, not the bot’s newest', async () => {
    const result = await browse('atlas', '', 'task-other');
    expect(result.body).toMatchObject({ task: { id: 'task-other', subjectRef: 'janedoe/FleetADLC#64' } });
    expect(askedFor[0]).toBe('/tasks/task-other/worktree');
  });

  it('shows nothing for a task that is not this bot’s, or not running', async () => {
    expect((await browse('atlas', '', 'task-theirs')).body).toEqual({ task: null });
    expect((await browse('atlas', '', 'task-done')).body).toEqual({ task: null });
    expect(askedFor).toHaveLength(0);
  });
});
