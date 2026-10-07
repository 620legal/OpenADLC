import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Triage again, for a request whose triage failed before it asked anything:
 * without it, the request is a draft that nothing picks up again.
 */

const REQUEST_ID = 'a4b02784-3ae8-450b-abe9-0c93eb4d67dc';
const stored = vi.hoisted(() => ({
  request: {
    id: 'a4b02784-3ae8-450b-abe9-0c93eb4d67dc',
    text: 'Create html hello world and a readme file.',
    context: null,
    repoId: 'repo-1',
    kind: 'feature',
    requestedBy: 'console',
    issueNumber: null as number | null,
    state: 'draft',
    createdAt: '2026-09-24T20:44:22.945Z',
  },
  /** Requests already waiting their turn, ahead of this one. */
  ahead: [] as { id: string; state: string; createdAt: string }[],
  intakeBusy: false,
  /** Intake becomes busy with the first triage it starts, as a real one does. */
  busyOnceOpened: false,
  /** Tasks on the request's subject: its triage, when one is under way. */
  onSubject: [] as { subjectRef: string; state: string }[],
}));

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
  bots: {
    listBots: vi.fn(async () => [
      { id: 'bot-flow', name: 'janedoe-fleetadlc-flow', role: 'automation' },
      { id: 'bot-intake', name: 'ottoexampleco', role: 'intake' },
    ]),
  },
  costs: {},
  credentials: {},
  issues: {},
  leases: {},
  listAudit: vi.fn(),
  mergeLines: {},
  modelAccounts: {},
  recordEvent: vi.fn(),
  repos: { listRepos: vi.fn(async () => [{ id: 'repo-1', name: 'fleetadlc-testbed' }]) },
  requests: {
    listDraftsSince: vi.fn(async () => []),
    getRequest: vi.fn(async (id: string) => (id === stored.request.id ? { ...stored.request } : null)),
    queueAgain: vi.fn(async (id: string) => {
      if (id !== stored.request.id || !['queued', 'draft', 'questions'].includes(stored.request.state)) return null;
      stored.request.state = 'queued';
      return { ...stored.request };
    }),
    listQueued: vi.fn(async () =>
      [...stored.ahead, stored.request].filter((one) => one.state === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    ),
    claimQueued: vi.fn(async (id: string) => {
      const found = [...stored.ahead, stored.request].find((one) => one.id === id && one.state === 'queued');
      if (!found) return null;
      found.state = 'draft';
      return { ...found };
    }),
    requeue: vi.fn(async (id: string) => {
      const found = [...stored.ahead, stored.request].find((one) => one.id === id && one.state === 'draft');
      if (found) found.state = 'queued';
    }),
  },
  withAdvisoryLock: vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
  sessions: {},
  settings: { allSettings: vi.fn(async () => ({})) },
  tasks: {
    countActiveTasksForBot: vi.fn(async () => (stored.intakeBusy ? 1 : 0)),
    seatHasRoom: vi.fn(async () => !stored.intakeBusy),
    listTasksOnSubjects: vi.fn(async () => stored.onSubject),
  },
  threads: {},
}));

let bridge: Server;
let bridgeUrl: string;
const opened: Record<string, unknown>[] = [];

beforeEach(async () => {
  const { registerConsoleApi } = await import('./api.js');
  const { Router } = await import('./router.js');
  opened.length = 0;
  stored.request.issueNumber = null;
  stored.request.state = 'draft';
  stored.ahead = [];
  stored.intakeBusy = false;
  stored.busyOnceOpened = false;
  stored.onSubject = [];
  const router = new Router();
  registerConsoleApi(router, {
    config: { gitHubClientId: '', webhookSecret: '', humans: [] } as never,
    hostd: {} as never,
    actors: {} as never,
    invitations: {} as never,
    automation: {} as never,
    gates: {} as never,
    taskService: {
      open: async (input: Record<string, unknown>) => {
        opened.push(input);
        if (stored.busyOnceOpened) stored.intakeBusy = true;
        return { taskId: 'task-2', session: 's' };
      },
    } as never,
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
});

function triage(id = REQUEST_ID) {
  return fetch(`${bridgeUrl}/v1/requests/${id}/triage`, { method: 'POST' });
}

describe('triaging a request again', () => {
  it('starts the intake bot on the same request, in its repository', async () => {
    const response = await triage();

    expect(response.status).toBe(200);
    expect(opened).toEqual([
      {
        bot: 'ottoexampleco',
        botId: 'bot-intake',
        repo: 'fleetadlc-testbed',
        kind: 'intake',
        subjectType: 'request',
        subjectRef: 'request:a4b02784',
        skill: 'triage',
      },
    ]);
  });

  it('waits its turn while intake is busy, rather than being refused: 202, with its place in line', async () => {
    stored.intakeBusy = true;

    const response = await triage();

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ request: { id: REQUEST_ID, state: 'queued', queuePosition: 1 }, queued: true, position: 1 });
    expect(opened).toEqual([]);
  });

  it('goes behind a request already waiting: the one ahead starts, and this one waits next', async () => {
    stored.ahead = [{ id: 'bbbbbbbb-0000-0000-0000-000000000000', state: 'queued', createdAt: '2026-09-24T00:00:00.000Z' }];
    stored.busyOnceOpened = true;

    const response = await triage();

    expect(opened.map((one) => one.subjectRef)).toEqual(['request:bbbbbbbb']);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ queued: true, position: 1 });
  });

  it('refuses a request whose triage is under way, or waiting on an answer, rather than starting a second', async () => {
    for (const state of ['running', 'paused']) {
      stored.onSubject = [{ subjectRef: 'request:a4b02784', state }];
      const response = await triage();
      expect(response.status, state).toBe(409);
    }
    expect(opened).toEqual([]);
  });

  it('starts a request already waiting once, through the queue, however often it is tried again', async () => {
    stored.request.state = 'queued';
    stored.intakeBusy = true;
    expect((await triage()).status).toBe(202);
    expect((await triage()).status).toBe(202);

    stored.intakeBusy = false;
    stored.busyOnceOpened = true;
    expect((await triage()).status).toBe(200);
    // Tried again while its own triage now runs.
    stored.onSubject = [{ subjectRef: 'request:a4b02784', state: 'running' }];
    expect((await triage()).status).toBe(409);

    expect(opened).toHaveLength(1);
  });

  it('refuses a request that is already an issue, and one nobody knows', async () => {
    stored.request.issueNumber = 15;
    stored.request.state = 'filed';
    expect((await triage()).status).toBe(409);
    expect((await triage('00000000-0000-0000-0000-000000000000')).status).toBe(404);
    expect(opened).toEqual([]);
  });
});
