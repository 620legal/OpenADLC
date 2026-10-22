import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The console API as `main.ts` builds it: the account routes have to reach the
// hostd the bridge was given, or Sign in and Verify answer that there is none.
const SEAT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const GROK_SEAT = '9f1c2a3b-4d5e-4f60-8a7b-1c2d3e4f5a6b';

/** The crew every test but the seat ones reads: an automation bot and an intake bot. */
const { DEFAULT_CREW } = vi.hoisted(() => ({
  DEFAULT_CREW: [
    { id: 'bot-flow', name: 'janedoe-openadlc-flow', role: 'automation' },
    { id: 'bot-intake', name: 'ottoexampleco', role: 'intake' },
  ],
}));

/** The requests table, as far as the request routes and the queue read it, and whether intake is busy. */
const stored = vi.hoisted(() => ({
  requests: [] as { id: string; state: string; createdAt: string; [key: string]: unknown }[],
  intakeBusy: false,
  settings: {} as Record<string, string>,
}));

const prerequisites = vi.hoisted(() => ({
  lease: { id: 'lease-1', state: 'leased' } as { id: string; state: string } | null,
  startBuildError: null as Error | null,
}));

vi.mock('./build-start.js', () => ({
  startBuild: vi.fn(async () => {
    if (prerequisites.startBuildError) throw prerequisites.startBuildError;
    return { taskId: 'task-2' };
  }),
}));

vi.mock('@openadlc/db', () => ({
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

  acknowledgements: { acknowledge: vi.fn(async () => undefined), forgetBefore: vi.fn(async () => undefined) },
  audit: vi.fn(async () => undefined),
  AccountInUse: class AccountInUse extends Error {},
  modelAccounts: {
    list: vi.fn(async () => []),
    get: vi.fn(async (id: string) =>
      id === SEAT
        ? { id: SEAT, provider: 'openai', kind: 'subscription', label: 'ChatGPT Pro', createdAt: '2026-09-24T00:00:00Z' }
        : id === GROK_SEAT
          ? { id: GROK_SEAT, provider: 'xai', kind: 'subscription', label: 'SuperGrok', createdAt: '2026-09-24T00:00:00Z' }
          : null,
    ),
    create: vi.fn(),
    remove: vi.fn(),
    recordVerification: vi.fn(async (id: string, check: { checkedAt: string; error: string | null }) => ({
      id,
      provider: 'openai',
      kind: 'subscription',
      label: 'ChatGPT Pro',
      createdAt: '2026-09-24T00:00:00Z',
      verifiedAt: check.checkedAt,
      verifyError: check.error,
    })),
    clearVerification: vi.fn(async () => undefined),
  },
  bots: {
    listBots: vi.fn(async () => DEFAULT_CREW),
    getBotByName: vi.fn(async () => null),
    getBotBySlot: vi.fn(async () => null),
    getBotById: vi.fn(async () => null),
    addSeat: vi.fn(),
    removeSeat: vi.fn(),
    seatRemovalRefusal: vi.fn(async () => null),
    setAppearance: vi.fn(),
    setMaxTasks: vi.fn(),
  },
  costs: {},
  ciUsage: { listSince: vi.fn(async () => []) },
  credentials: {},
  issues: { listIssues: vi.fn(async () => []), getIssue: vi.fn(async () => null) },
  leases: {
    getLease: vi.fn(async () => prerequisites.lease),
    getActiveLease: vi.fn(async () => null),
    setLeaseState: vi.fn(async () => undefined),
    releaseUnlessWorkedUnder: vi.fn(async () => true),
    planChangeOfGate: vi.fn(async () => null),
  },
  listAudit: vi.fn(),
  mergeLines: {},
  recordEvent: vi.fn(),
  repos: {
    addRepo: vi.fn(async (input: Record<string, unknown>) => ({ repo: { ...input, color: 'blue' }, outcome: 'added' })),
    listRepos: vi.fn(async () => [{ id: 'repo-1', name: 'openadlc-testbed' }]),
    getRepoByName: vi.fn(async (name: string) => ({ id: 'repo-1', name })),
    setProductionChoice: vi.fn(async () => undefined),
    updateRepoSettings: vi.fn(async (name: string) => ({ name, fullName: `janedoe/${name}` })),
    RepoNameTaken: class RepoNameTaken extends Error {},
  },
  requests: {
    createRequest: vi.fn(async (input: Record<string, unknown>) => {
      const record = { id: `req-${stored.requests.length + 1}`, state: 'draft', createdAt: new Date(stored.requests.length).toISOString(), ...input };
      stored.requests.push(record);
      return { ...record };
    }),
    getRequest: vi.fn(async (id: string) => {
      const found = stored.requests.find((one) => one.id === id);
      return found ? { ...found } : null;
    }),
    findRequestByPrefix: vi.fn(async (prefix: string) => {
      const found = stored.requests.find((one) => one.id.toLowerCase().startsWith(prefix.toLowerCase()));
      return found ? { ...found } : null;
    }),
    listRequests: vi.fn(async () => [...stored.requests].reverse().map((one) => ({ ...one }))),
    listQueued: vi.fn(async () => stored.requests.filter((one) => one.state === 'queued').map((one) => ({ ...one }))),
    // Nothing here is left claimed by a restart.
    listDraftsSince: vi.fn(async () => []),
    claimQueued: vi.fn(async (id: string) => {
      const found = stored.requests.find((one) => one.id === id && one.state === 'queued');
      if (!found) return null;
      found.state = 'draft';
      return { ...found };
    }),
    updateRequest: vi.fn(async (id: string, patch: { state?: string }) => {
      const found = stored.requests.find((one) => one.id === id);
      if (!found) return null;
      if (patch.state) found.state = patch.state;
      return { ...found };
    }),
    requeue: vi.fn(async (id: string) => {
      const found = stored.requests.find((one) => one.id === id && one.state === 'draft');
      if (found) found.state = 'queued';
    }),
  },
  withAdvisoryLock: vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
  sessions: {},
  settings: {
    isSettingKey: vi.fn(() => true),
    getSetting: vi.fn(async (key: string) => stored.settings[key] ?? null),
    setSetting: vi.fn(async (key: string, value: string) => {
      if (value.length === 0) delete stored.settings[key];
      else stored.settings[key] = value;
    }),
    setSettings: vi.fn(async (values: Record<string, string>) => {
      for (const [key, value] of Object.entries(values)) {
        if (value.length === 0) delete stored.settings[key];
        else stored.settings[key] = value;
      }
    }),
    allSettings: vi.fn(async () => ({ ...stored.settings })),
  },
  tasks: {
    STOPPED_BY_PERSON: 'stopped by a person',
    countActiveTasksForBot: vi.fn(async () => (stored.intakeBusy ? 1 : 0)),
    seatHasRoom: vi.fn(async () => !stored.intakeBusy),
    getTask: vi.fn(async () => null),
    listTasks: vi.fn(async () => []),
    listTasksOnSubjects: vi.fn(async () => []),
    updateTaskState: vi.fn(async (id: string, state: string) => ({ id, state })),
    claimAutoRetry: vi.fn(async () => true),
  },
  threads: {
    listOpenGates: vi.fn(async () => []),
    listOpenGatesOnSubject: vi.fn(async () => []),
    listGatesForTasks: vi.fn(async () => []),
    expireGatesOfTask: vi.fn(async () => []),
    getGate: vi.fn(async () => null),
    answerGate: vi.fn(async () => null),
    reopenGate: vi.fn(async () => false),
    ensureThread: vi.fn(async () => ({ id: 'thread-1' })),
    addMessage: vi.fn(async (message: Record<string, unknown>) => message),
    listThreadsForSubject: vi.fn(async () => []),
  },
}));

import { acknowledgements, audit, bots, costs, credentials, issues, leases, modelAccounts, repos, requests, sessions, settings, tasks, threads, withAdvisoryLock } from '@openadlc/db';

let hostd: Server;
let bridge: Server;
let bridgeUrl: string;
/** The bridge's dispatch gate, which a test pauses. */
let pauseGate: import('./dispatch-gate.js').DispatchGate;
let asked: { method: string; url: string; secret: string | undefined }[];
/** What the hostd answers with; a test sets 500 for a hostd that is up and refuses. */
let hostdStatus: number;
const assertReady = vi.fn(async (_bot: unknown, _repo: unknown): Promise<void> => undefined);
const open = vi.fn(async (_input: Record<string, unknown>) => ({ taskId: 'task-1', session: 's' }));
/** The GitHub client a bot acts through; a test gives one. */
const asBot = vi.fn(async (_bot: string): Promise<unknown> => null);
/** What the console's routes leave running once they have answered; a test waits for it. */
let afterwards: import('./api.js').Afterwards;

beforeEach(async () => {
  const { HostdClient } = await import('./hostd-client.js');
  const { Afterwards, registerConsoleApi } = await import('./api.js');
  const { Router } = await import('./router.js');
  afterwards = new Afterwards();
  asked = [];
  hostdStatus = 200;
  prerequisites.lease = { id: 'lease-1', state: 'leased' };
  prerequisites.startBuildError = null;
  assertReady.mockReset().mockResolvedValue(undefined);
  open.mockClear();
  stored.requests = [];
  stored.intakeBusy = false;
  stored.settings = {};
  vi.mocked(settings.setSetting).mockClear();
  vi.mocked(settings.setSettings).mockClear();
  vi.mocked(requests.createRequest).mockClear();
  // Blocks below give these their own answers; each test starts from the
  // factory's. mockReset puts back the implementation vi.fn was made with.
  for (const shared of [
    leases.getLease,
    leases.getActiveLease,
    leases.setLeaseState,
    leases.releaseUnlessWorkedUnder,
    tasks.getTask,
    tasks.claimAutoRetry,
    tasks.listTasks,
    tasks.listTasksOnSubjects,
    tasks.updateTaskState,
    threads.listOpenGates,
    threads.listOpenGatesOnSubject,
    threads.expireGatesOfTask,
    threads.addMessage,
    bots.getBotById,
    repos.updateRepoSettings,
    repos.getRepoByName,
    repos.listRepos,
  ]) {
    vi.mocked(shared).mockReset();
  }

  hostd = createServer((request, response) => {
    asked.push({
      method: request.method ?? '',
      url: request.url ?? '',
      secret: request.headers['x-openadlc-internal-secret'] as string | undefined,
    });
    response.writeHead(hostdStatus, { 'content-type': 'application/json' });
    if (hostdStatus !== 200) {
      response.end(JSON.stringify({ error: 'boom' }));
      return;
    }
    const answer = request.url?.endsWith('/models')
      ? { models: [{ id: 'grok-4.7', createdAt: null, isDefault: true }] }
      : { ok: true, message: 'answered: OK', checkedAt: '2026-09-24T08:00:00.000Z' };
    response.end(JSON.stringify(answer));
  });
  await new Promise<void>((resolve) => hostd.listen(0, '127.0.0.1', resolve));
  const hostdPort = (hostd.address() as AddressInfo).port;

  const router = new Router();
  pauseGate = new (await import('./dispatch-gate.js')).DispatchGate();
  registerConsoleApi(router, {
    afterwards,
    dispatchGate: pauseGate,
    config: {} as never,
    hostd: new HostdClient(`http://127.0.0.1:${hostdPort}`, 'install-secret-for-the-test'),
    actors: { asBot } as never,
    invitations: {} as never,
    automation: {} as never,
    gates: {} as never,
    taskService: { assertReady, open } as never,
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

describe('the console’s account routes', () => {
  it('check an account on the hostd the bridge was given, and keep the answer', async () => {
    const response = await fetch(`${bridgeUrl}/v1/model-accounts/${SEAT}/verify`, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(asked).toEqual([
      { method: 'POST', url: `/model-accounts/${SEAT}/verify`, secret: 'install-secret-for-the-test' },
    ]);
    expect(vi.mocked(modelAccounts.recordVerification)).toHaveBeenCalledWith(SEAT, {
      checkedAt: '2026-09-24T08:00:00.000Z',
      error: null,
    });
  });

  it('list an xAI seat’s models from that hostd, which runs grok with the seat’s login', async () => {
    const response = await fetch(`${bridgeUrl}/v1/model-accounts/${GROK_SEAT}/models`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      models: [{ id: 'grok-4.7', createdAt: null, isDefault: true }],
      aliases: ['newest:grok'],
    });
    expect(asked).toEqual([
      { method: 'GET', url: `/model-accounts/${GROK_SEAT}/models`, secret: 'install-secret-for-the-test' },
    ]);
  });
});

describe('a repository the app cannot reach', () => {
  const NEEDS = {
    need: 'make-public',
    title: 'The OpenADLC app is private to janedoe',
    detail: 'GitHub installs a private app only on the account that owns it, so it cannot go on exampleco yet.',
    action: { label: 'Make the app public', url: 'https://github.com/settings/apps/openadlc-janedoe/advanced' },
    steps: [{ text: 'Make the app public — only janedoe can', action: { label: 'Make the app public', url: 'https://github.com/settings/apps/openadlc-janedoe/advanced' } }],
  };
  let server: Server;
  let url: string;
  const reach = vi.fn();

  beforeEach(async () => {
    const { registerConsoleApi } = await import('./api.js');
    const { Router } = await import('./router.js');
    const { HostdClient } = await import('./hostd-client.js');
    reach.mockReset();
    vi.mocked(repos.addRepo).mockClear();
    const router = new Router();
    registerConsoleApi(router, {
      config: {} as never,
      hostd: new HostdClient('http://127.0.0.1:1', 'secret'),
      actors: {} as never,
      invitations: {} as never,
      automation: {} as never,
      gates: {} as never,
      taskService: {} as never,
      threadStream: { subscribe: () => () => undefined, watching: 0 } as never,
      onboarding: {} as never,
      webhookSetup: {} as never,
      repoSetup: {} as never,
      appReach: {
        reach,
        clear: vi.fn(),
        installationsView: vi.fn(async () => ({ app: null, accounts: [], reason: 'no key yet' })),
      } as never,
    });
    server = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const add = (fullName: string) =>
    fetch(`${url}/v1/onboarding/repository`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fullName }) });

  it('is not added, and the refusal says what to do and where', async () => {
    // exampleco/infra was added, and then could only fail; the app goes on first now.
    reach.mockResolvedValue({ state: 'blocked', repository: 'exampleco/infra', account: 'exampleco', ...NEEDS });

    const response = await add('https://github.com/exampleco/infra');

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'The OpenADLC app is private to janedoe', needs: NEEDS });
    expect(reach).toHaveBeenCalledWith('exampleco/infra');
    expect(vi.mocked(repos.addRepo)).not.toHaveBeenCalled();
  });

  it('is refused, with how to allow it, on an account the install does not work in', async () => {
    const { allowFix } = await import('./app-reach.js');
    const fix = allowFix('examp1eco');
    reach.mockResolvedValue({ state: 'blocked', repository: 'examp1eco/infra', account: 'examp1eco', ...fix });

    const response = await add('examp1eco/infra');

    expect(response.status).toBe(409);
    expect(((await response.json()) as { needs: { need: string } }).needs).toMatchObject({ need: 'allow-account', title: 'examp1eco is not an account this install works in' });
    expect(vi.mocked(repos.addRepo)).not.toHaveBeenCalled();
  });

  it('lets an admin allow an account, only once they have been told what it means, and audits it', async () => {
    vi.mocked(audit).mockClear();
    const allow = (body: Record<string, unknown>) =>
      fetch(`${url}/v1/github/allowed-accounts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    const warned = await allow({ account: 'partnerco' });
    expect(warned.status).toBe(400);
    expect(((await warned.json()) as { error: string }).error).toContain('the crew is invited to them');
    expect(vi.mocked(settings.setSetting)).not.toHaveBeenCalledWith('allowedAccounts', expect.anything(), expect.anything());

    expect((await allow({ account: 'not a login', understood: true })).status).toBe(400);

    const allowed = await allow({ account: 'PartnerCo', understood: true });
    expect(allowed.status).toBe(200);
    expect(vi.mocked(settings.setSetting)).toHaveBeenCalledWith('allowedAccounts', 'partnerco', expect.any(String));
    expect(vi.mocked(audit)).toHaveBeenCalledWith(expect.objectContaining({ action: 'github.account_allowed', target: 'PartnerCo' }));
    stored.settings = {};
  });

  it('is added as before when GitHub could not say, which is what the typed field is for', async () => {
    reach.mockResolvedValue({ state: 'unknown', repository: 'exampleco/infra', reason: 'no key yet' });

    const response = await add('exampleco/infra');

    expect(response.status).toBe(200);
    expect(vi.mocked(repos.addRepo)).toHaveBeenCalledWith(expect.objectContaining({ fullName: 'exampleco/infra', name: 'infra' }));
  });

  it('can be asked about while somebody installs the app, by the same name the field takes', async () => {
    reach.mockResolvedValue({ state: 'reachable', repository: 'exampleco/infra', account: 'exampleco', installationId: 8 });

    const response = await fetch(`${url}/v1/github/reach?repo=${encodeURIComponent('https://github.com/exampleco/infra.git')}`);

    expect(await response.json()).toEqual({ state: 'reachable', repository: 'exampleco/infra', account: 'exampleco', installationId: 8 });
    expect(reach).toHaveBeenCalledWith('exampleco/infra');
    expect((await fetch(`${url}/v1/github/reach?repo=infra`)).status).toBe(400);
  });

  it('says where the app is installed, and nothing where the bridge does not look', async () => {
    expect(await (await fetch(`${url}/v1/github/installations`)).json()).toEqual({ app: null, accounts: [], reason: 'no key yet' });
    // The bridge the other tests start was given no way to ask.
    expect((await fetch(`${bridgeUrl}/v1/github/installations`)).status).toBe(501);
  });
});

function ask(repo = 'openadlc-testbed') {
  return fetch(`${bridgeUrl}/v1/requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Add a hello world page', repo }),
  });
}

describe('abandoning a request', () => {
  // Nothing let a person drop a request: it sat in Needs you for a week, or
  // waited in the queue to be started again later.
  const abandon = (id: string) => fetch(`${bridgeUrl}/v1/requests/${id}/abandon`, { method: 'POST' });

  beforeEach(() => {
    vi.mocked(audit).mockClear();
  });

  it('takes one out of the queue for good: the queue never starts it, and starts the next', async () => {
    stored.intakeBusy = true;
    await ask();

    const response = await abandon('req-1');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ request: { id: 'req-1', state: 'abandoned' }, stopped: 0 });
    expect(vi.mocked(audit)).toHaveBeenCalledWith(expect.objectContaining({ action: 'request.abandoned', payload: expect.objectContaining({ requestId: 'req-1', from: 'queued' }) }));

    // Intake is free again: the next request starts, and the abandoned one does not.
    stored.intakeBusy = false;
    await ask();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]?.[0]).toMatchObject({ subjectRef: 'request:req-2' });
    expect(stored.requests.find((one) => one.id === 'req-1')?.state).toBe('abandoned');
    expect(await requests.claimQueued('req-1')).toBeNull();
  });

  it('refuses one that is filed or already abandoned, and one it does not know', async () => {
    stored.requests.push(
      { id: 'req-filed', state: 'filed', createdAt: new Date(0).toISOString() },
      { id: 'req-gone', state: 'abandoned', createdAt: new Date(0).toISOString() },
    );

    const filed = await abandon('req-filed');
    expect(filed.status).toBe(409);
    expect(((await filed.json()) as { error: string }).error).toBe('that request is filed, so there is nothing to abandon');
    expect((await abandon('req-gone')).status).toBe(409);
    expect((await abandon('req-none')).status).toBe(404);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });
});

describe('a request for a bot that cannot start yet', () => {
  it('is written and triaged when the intake bot is ready', async () => {
    const response = await ask();

    expect(response.status).toBe(200);
    expect(assertReady).toHaveBeenCalledWith(expect.objectContaining({ name: 'ottoexampleco' }), 'openadlc-testbed');
    expect(requests.createRequest).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ bot: 'ottoexampleco', kind: 'intake' }));
  });

  it('waits its turn while intake is busy: 202, with its place in line', async () => {
    stored.intakeBusy = true;

    const first = await ask();
    const second = await ask();

    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ request: { id: 'req-1', state: 'queued', queuePosition: 1 }, queued: true, position: 1, bot: 'ottoexampleco' });
    expect(await second.json()).toMatchObject({ queued: true, position: 2 });
    expect(open).not.toHaveBeenCalled();

    // The list the console reads says the same.
    const listed = (await (await fetch(`${bridgeUrl}/v1/requests`)).json()) as { requests: { id: string; queuePosition: number | null }[] };
    expect(listed.requests.map((one) => [one.id, one.queuePosition])).toEqual([
      ['req-2', 2],
      ['req-1', 1],
    ]);
  });

  it('is kept and waits in line while work is paused, saying why, and nothing starts', async () => {
    pauseGate.pauseWork('work is paused, by janedoe since 2026-09-29T10:00:00.000Z; resume it in Settings → Pause work');

    const response = await ask();

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      request: { id: 'req-1', state: 'queued' },
      queued: true,
      position: 1,
      paused: expect.stringMatching(/^work is paused, by janedoe/),
    });
    expect(open).not.toHaveBeenCalled();
  });

  it('waits in line while its repository is paused, saying whose pause, and one for another repository is triaged meanwhile', async () => {
    pauseGate.pauseRepo('openadlc-testbed', 'work is paused in openadlc-testbed, by janedoe since 2026-09-29T10:00:00.000Z; resume it in Settings → Pause work');
    const both = async () => [
      { id: 'repo-1', name: 'openadlc-testbed' },
      { id: 'repo-2', name: 'openadlc-other' },
    ];
    vi.mocked(repos.listRepos).mockImplementation(both as never);
    vi.mocked(repos.getRepoByName).mockImplementation((async (name: string) => (name === 'openadlc-other' ? { id: 'repo-2', name } : { id: 'repo-1', name })) as never);
    try {
      const held = await ask();
      expect(held.status).toBe(202);
      expect(await held.json()).toMatchObject({
        request: { id: 'req-1', state: 'queued' },
        queued: true,
        paused: expect.stringMatching(/^work is paused in openadlc-testbed, by janedoe/),
      });
      expect(open).not.toHaveBeenCalled();

      // Behind it in line, and started all the same: the paused one keeps its place.
      const other = await ask('openadlc-other');
      expect(other.status).toBe(200);
      expect(open).toHaveBeenCalledTimes(1);
      expect(open.mock.calls[0]?.[0]).toMatchObject({ repo: 'openadlc-other', subjectRef: 'request:req-2' });
      expect(stored.requests.find((one) => one.id === 'req-1')?.state).toBe('queued');
    } finally {
      vi.mocked(repos.listRepos).mockImplementation((async () => [{ id: 'repo-1', name: 'openadlc-testbed' }]) as never);
      vi.mocked(repos.getRepoByName).mockImplementation((async (name: string) => ({ id: 'repo-1', name })) as never);
    }
  });

  it('is not triaged again while its repository is paused', async () => {
    stored.requests.push({ id: 'req-9', state: 'draft', createdAt: new Date(0).toISOString(), repoId: 'repo-1', issueNumber: null });
    pauseGate.pauseRepo('openadlc-testbed', 'work is paused in openadlc-testbed, by janedoe since 2026-09-29T10:00:00.000Z; resume it in Settings → Pause work');

    const response = await fetch(`${bridgeUrl}/v1/requests/req-9/triage`, { method: 'POST' });

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/^nothing new starts: work is paused in openadlc-testbed/);
    expect(open).not.toHaveBeenCalled();
  });

  it('is saved and waits for the sweep when starting the queue fails, rather than answering 500', async () => {
    // A 500 after the row was written told the person it was not filed, and
    // the one they sent again was a second request.
    const { withAdvisoryLock } = await import('@openadlc/db');
    vi.mocked(withAdvisoryLock).mockRejectedValueOnce(new Error('the database blinked'));
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const response = await ask();

      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ request: { id: 'req-1', state: 'queued' }, queued: true, position: 1 });
      expect(warned).toHaveBeenCalledWith(expect.stringContaining('starting the queue failed, and the sweep will'));
    } finally {
      warned.mockRestore();
    }
  });

  it('starts at once, as before, when intake is free and nothing waits ahead of it', async () => {
    const response = await ask();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ request: { id: 'req-1', state: 'draft' }, task: { taskId: 'task-1' }, bot: 'ottoexampleco' });
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ subjectRef: 'request:req-1', kind: 'intake', skill: 'triage' }));
  });

  it('is refused before it is written, so no draft is left that nothing will triage', async () => {
    const { PrerequisiteNotReadyError } = await import('./task-service.js');
    assertReady.mockRejectedValue(
      new PrerequisiteNotReadyError('ottoexampleco', [
        { row: 'bot-sign-in:bot-intake', kind: 'sign-in', why: 'ottoexampleco cannot sign in to GitHub', instruction: 'Reconnect it.' },
      ]),
    );

    const response = await ask();

    expect(response.status).toBe(409);
    expect(await response.text()).toContain('ottoexampleco cannot sign in to GitHub');
    expect(requests.createRequest).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});

describe('a build a retry could not start', () => {
  async function retryDeps() {
    const { retryDepsFor } = await import('./api.js');
    return retryDepsFor({ taskService: {} as never, automation: {} as never });
  }
  const input = { leaseId: 'lease-1' } as never;

  it('gives back the lease it was to run under, and says why', async () => {
    prerequisites.startBuildError = new Error('ottoexampleco was not started: it cannot sign in to GitHub.');
    const deps = await retryDeps();

    await expect(deps.startBuild(input)).rejects.toThrow('cannot sign in to GitHub');

    expect(leases.setLeaseState).toHaveBeenCalledWith('lease-1', 'released');
  });

  it('leaves a lease that is no longer freshly leased alone', async () => {
    prerequisites.startBuildError = new Error('boom');
    prerequisites.lease = { id: 'lease-1', state: 'running' };
    const deps = await retryDeps();

    await expect(deps.startBuild(input)).rejects.toThrow('boom');

    expect(leases.setLeaseState).not.toHaveBeenCalled();
  });

  it('keeps the lease when the build started', async () => {
    const deps = await retryDeps();

    await expect(deps.startBuild(input)).resolves.toEqual({ taskId: 'task-2' });

    expect(leases.setLeaseState).not.toHaveBeenCalled();
  });
});

describe('adding a seat to a running install', () => {
  const BUILDER = {
    id: 'bot-1',
    name: 'openadlc-atlas-janedoe',
    slot: 'builder',
    displayName: 'Builder',
    role: 'implement',
    engine: 'grok',
    model: 'grok-4.7',
    githubLogin: 'openadlc-atlas-janedoe',
    hostId: 'host-1',
    skills: ['implement'],
    sidecarDb: true,
  };
  const SECOND = { ...BUILDER, id: 'bot-2', name: 'builder-2', slot: 'builder-2', githubLogin: 'openadlc-crew-janedoe' };
  let server: Server;
  let url: string;
  let configRoot: string;
  const assignAccount = vi.fn(async () => ({ bot: 'builder-2', login: null }));

  beforeEach(async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    configRoot = mkdtempSync(join(tmpdir(), 'openadlc-seats-'));
    writeFileSync(
      join(configRoot, 'bots.yaml'),
      [
        'bots:',
        '  - { slot: builder, displayName: Builder, role: implement, engine: claude, model: claude-sonnet-5, skills: [implement], sidecarDb: true }',
        '  - { slot: lead-reviewer, displayName: Lead reviewer, role: review_lead, engine: claude, model: claude-opus-5, skills: [pr-review] }',
      ].join('\n'),
    );
    const { registerConsoleApi } = await import('./api.js');
    const { Router } = await import('./router.js');
    const { HostdClient } = await import('./hostd-client.js');
    vi.mocked(bots.addSeat).mockReset();
    vi.mocked(bots.removeSeat).mockReset();
    vi.mocked(bots.seatRemovalRefusal).mockReset().mockResolvedValue(null);
    vi.mocked(bots.listBots).mockResolvedValue([BUILDER] as never);
    vi.mocked(bots.getBotByName).mockImplementation(async (name: string) => ([BUILDER, SECOND].find((bot) => bot.name === name) ?? null) as never);
    assignAccount.mockClear();
    const router = new Router();
    registerConsoleApi(router, {
      config: { configRoot } as never,
      hostd: new HostdClient('http://127.0.0.1:1', 'secret'),
      actors: {} as never,
      invitations: {} as never,
      automation: {} as never,
      gates: {} as never,
      taskService: {} as never,
      threadStream: { subscribe: () => () => undefined, watching: 0 } as never,
      onboarding: { assignAccount } as never,
      webhookSetup: {} as never,
      repoSetup: {} as never,
    });
    server = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.mocked(bots.listBots).mockResolvedValue(DEFAULT_CREW as never);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = (path: string, body?: unknown) =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  it('adds a builder beside the first, with the engine and model the file gives the role', async () => {
    vi.mocked(bots.addSeat).mockResolvedValue({ ...SECOND, githubLogin: null } as never);

    const response = await post('/v1/crew/seats', { role: 'implement' });

    expect(response.status).toBe(200);
    // The builder was moved onto grok in the console; a new seat starts from
    // the file, and is put on an account and a model in the crew table.
    expect(vi.mocked(bots.addSeat)).toHaveBeenCalledWith({
      like: 'builder',
      displayName: 'Builder',
      role: 'implement',
      engine: 'claude',
      model: 'claude-sonnet-5',
      hostId: 'host-1',
      skills: ['implement'],
      sidecarDb: true,
      actor: expect.any(String),
    });
    expect(((await response.json()) as { bot: { slot: string } }).bot.slot).toBe('builder-2');
  });

  it('refuses a role whose seats are found by name, where a second would sit idle', async () => {
    const response = await post('/v1/crew/seats', { role: 'review_lead' });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('only for the');
    expect(vi.mocked(bots.addSeat)).not.toHaveBeenCalled();
  });

  it('removes an added seat after taking it off its account, which stays OpenADLC’s', async () => {
    vi.mocked(bots.removeSeat).mockResolvedValue(SECOND as never);

    const response = await post('/v1/crew/seats/builder-2/remove');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removed: 'builder-2' });
    expect(assignAccount).toHaveBeenCalledWith({ bot: 'builder-2', login: null, actor: expect.any(String) });
    expect(assignAccount.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(bots.removeSeat).mock.invocationCallOrder[0] ?? 0);
  });

  it('keeps a seat that has a reason to stay, connected as it was', async () => {
    // What `bots.SeatRefused` is: an error that carries its status.
    vi.mocked(bots.seatRemovalRefusal).mockResolvedValue(
      Object.assign(new Error('builder-2 has a task that has not ended'), { status: 409 }) as never,
    );

    const response = await post('/v1/crew/seats/builder-2/remove');

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe('builder-2 has a task that has not ended');
    expect(assignAccount).not.toHaveBeenCalled();
    expect(vi.mocked(bots.removeSeat)).not.toHaveBeenCalled();
  });

  it('refuses a seat config/bots.yaml names, which openadlc up would seed again', async () => {
    const response = await post('/v1/crew/seats/openadlc-atlas-janedoe/remove');

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain('config/bots.yaml');
    expect(vi.mocked(bots.removeSeat)).not.toHaveBeenCalled();
  });
});

describe('a repository’s stage modes, as settings sends them', () => {
  const patch = (stageModes: Record<string, string>) =>
    fetch(`${bridgeUrl}/v1/repos/openadlc-testbed`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stageModes }),
    });

  beforeEach(() => {
  });

  it('stores an older console’s assist as autonomous, which is all it ever did', async () => {
    const response = await patch({ merged: 'assist', spec: 'conditional' });
    expect(response.status).toBe(200);
    expect(vi.mocked(repos.updateRepoSettings)).toHaveBeenCalledWith('openadlc-testbed', { stageModes: { merged: 'autonomous', spec: 'conditional' } });
  });

  it('refuses a mode that is not one', async () => {
    const response = await patch({ merged: 'sometimes' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('is not a stage mode');
    expect(vi.mocked(repos.updateRepoSettings)).not.toHaveBeenCalled();
  });

  it.each(['build', 'review', 'merged', 'done'])('refuses untouched for %s, which no bot reads there, and names the pause', async (stage) => {
    const response = await patch({ [stage]: 'untouched' });
    expect(response.status).toBe(400);
    const { error } = (await response.json()) as { error: string };
    expect(error).toContain(`${stage} cannot be untouched`);
    expect(error).toContain('Pause work');
    expect(vi.mocked(repos.updateRepoSettings)).not.toHaveBeenCalled();
  });

  it('stores untouched for intake and spec', async () => {
    const response = await patch({ intake: 'untouched', spec: 'untouched' });
    expect(response.status).toBe(200);
    expect(vi.mocked(repos.updateRepoSettings)).toHaveBeenCalledWith('openadlc-testbed', { stageModes: { intake: 'untouched', spec: 'untouched' } });
  });

  it('refuses a mode that is not a string, and a stage that is not one, rather than wiping every stage', async () => {
    for (const modes of [{ merged: 5 }, { merged: null }, { shipping: 'autonomous' }]) {
      const response = await patch(modes as never);
      expect(response.status).toBe(400);
    }
    expect(vi.mocked(repos.updateRepoSettings)).not.toHaveBeenCalled();
  });
});

describe('a repository’s testing deploy', () => {
  beforeEach(() => {
    vi.mocked(settings.setSetting).mockClear();
  });

  const patch = (body: Record<string, unknown>, name = 'openadlc-testbed') =>
    fetch(`${bridgeUrl}/v1/repos/${name}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('stores has and none, lists them, and forgets automatic', async () => {
    const accepted = await patch({ testingDeploy: 'none' });
    expect(accepted.status).toBe(200);
    expect(JSON.parse(stored.settings.testingDeploy ?? '')).toEqual({ 'openadlc-testbed': 'none' });
    expect(vi.mocked(repos.updateRepoSettings)).not.toHaveBeenCalled();

    const listed = (await (await fetch(`${bridgeUrl}/v1/repos`)).json()) as {
      repos: { name: string; testingDeploy: string; shipsByMerging: boolean | null }[];
    };
    expect(listed.repos[0]).toMatchObject({ name: 'openadlc-testbed', testingDeploy: 'none', shipsByMerging: true });

    expect((await patch({ testingDeploy: 'has' })).status).toBe(200);
    const again = (await (await fetch(`${bridgeUrl}/v1/repos`)).json()) as {
      repos: { testingDeploy: string; shipsByMerging: boolean | null }[];
    };
    expect(again.repos[0]).toMatchObject({ testingDeploy: 'has', shipsByMerging: false });

    expect((await patch({ testingDeploy: 'automatic' })).status).toBe(200);
    expect(stored.settings.testingDeploy).toBeUndefined();
    const back = (await (await fetch(`${bridgeUrl}/v1/repos`)).json()) as {
      repos: { testingDeploy: string; shipsByMerging: boolean | null }[];
    };
    expect(back.repos[0]).toMatchObject({ testingDeploy: 'automatic', shipsByMerging: null });
  });

  it('refuses a value that is not one of the three, and does not store it', async () => {
    const response = await patch({ testingDeploy: 'skip' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('testingDeploy is one of automatic, has, none');
    expect(vi.mocked(settings.setSetting)).not.toHaveBeenCalled();
    expect(stored.settings.testingDeploy).toBeUndefined();
  });

  it('keeps both repositories when two choices are saved at once', async () => {
    // The first read is held until the other save has had a chance to read the
    // same row. Without the lock both reads see the empty map and the later
    // write drops the earlier choice. The shared mock runs the lock's function
    // immediately and does not exclude, so this test brings its own.
    let reads = 0;
    let releaseFirst: () => void = () => undefined;
    const firstRead = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let chain: Promise<unknown> = Promise.resolve();
    vi.mocked(withAdvisoryLock).mockImplementation(async (_key: string, fn: () => Promise<unknown>) => {
      const previous = chain;
      let release: () => void = () => undefined;
      chain = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await fn();
      } finally {
        release();
      }
    });
    vi.mocked(settings.getSetting).mockImplementation(async (key: string) => {
      if (key !== 'testingDeploy') return stored.settings[key] ?? null;
      const value = stored.settings[key] ?? null;
      reads += 1;
      if (reads === 1) await firstRead;
      return value;
    });
    try {
      const one = patch({ testingDeploy: 'none' }, 'openadlc');
      const two = patch({ testingDeploy: 'has' }, 'other');
      await vi.waitFor(() => expect(reads).toBe(1));
      await new Promise((resolve) => setTimeout(resolve, 30));
      // The second save is waiting on the lock, not on a second read of the old row.
      expect(reads).toBe(1);
      releaseFirst();
      const first = await one;
      const second = await two;
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(await first.json()).toMatchObject({ testingDeploy: 'none', shipsByMerging: true });
      expect(await second.json()).toMatchObject({ testingDeploy: 'has', shipsByMerging: false });
      expect(JSON.parse(stored.settings.testingDeploy ?? '')).toEqual({ openadlc: 'none', other: 'has' });
    } finally {
      vi.mocked(settings.getSetting).mockImplementation(async (key: string) => stored.settings[key] ?? null);
      vi.mocked(withAdvisoryLock).mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn());
    }
  });

  it('refuses a repository OpenADLC does not work in, and does not store the choice', async () => {
    vi.mocked(repos.getRepoByName).mockResolvedValueOnce(null);
    const response = await patch({ testingDeploy: 'none' }, 'missing');
    expect(response.status).toBe(404);
    expect(vi.mocked(settings.setSetting)).not.toHaveBeenCalled();
  });
});

describe('stopping a task that could not finish', () => {
  const FAILED = {
    id: 'task-81',
    botId: 'bot-intake',
    kind: 'intake',
    state: 'failed',
    subjectRef: 'openadlc#81',
    repoId: 'repo-openadlc',
    leaseId: 'lease-81',
    exitReason: 'engine exited 1',
  };
  let task: Record<string, unknown> | null;
  let lease: { id: string; state: string; botId: string } | null;
  let openGates: { taskId: string }[];
  let onSubject: Record<string, unknown>[];
  let active: { id: string; state: string; botId: string } | null;
  /** Unfinished tasks on other subjects, such as a patch on the pull request. */
  let elsewhere: Record<string, unknown>[];

  beforeEach(() => {
    task = { ...FAILED };
    lease = { id: 'lease-81', state: 'in_task', botId: 'bot-intake' };
    openGates = [];
    onSubject = [];
    elsewhere = [];
    active = null;
    vi.mocked(tasks.getTask).mockImplementation(async () => task as never);
    vi.mocked(tasks.listTasksOnSubjects).mockImplementation(async () => [task, ...onSubject] as never);
    vi.mocked(tasks.listTasks).mockImplementation(async () => [task, ...onSubject, ...elsewhere] as never);
    vi.mocked(leases.getLease).mockImplementation(async () => lease as never);
    vi.mocked(leases.getActiveLease).mockImplementation(async () => active as never);
    vi.mocked(threads.listOpenGates).mockImplementation(async () => openGates as never);
    // The questions it closes are the open ones of this task.
    vi.mocked(threads.expireGatesOfTask).mockImplementation(async (id: string) => openGates.filter((gate) => gate.taskId === id).map((_, n) => `gate-${n}`) as never);
    vi.mocked(bots.getBotById).mockImplementation(async () => ({ id: 'bot-intake', name: 'intake' }) as never);
    vi.mocked(audit).mockClear();
  });

  // The route answers once the stop is recorded; hostd, the lease and the
  // label come after, and each test looks once those are done too.
  const stop = async (reason?: string) => {
    const response = await fetch(`${bridgeUrl}/v1/tasks/task-81/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(reason ? { reason } : {}),
    });
    await afterwards.settled();
    return response;
  };
  /** What the task's thread was told after the answer. */
  const said = () => vi.mocked(threads.addMessage).mock.calls.map(([message]) => message);

  it('cancels it through hostd with a reason, releases its lease and audits it', async () => {
    const response = await stop('the operator takes over');

    expect(response.status).toBe(200);
    // The lease goes after the answer, so the answer names none it let go.
    expect(await response.json()).toEqual({ task: 'task-81', state: 'stopped', releasedLease: null, questionsClosed: 0, stopped: true });
    expect(asked).toEqual([{ method: 'POST', url: '/tasks/task-81/cancel', secret: 'install-secret-for-the-test' }]);
    expect(vi.mocked(leases.releaseUnlessWorkedUnder)).toHaveBeenCalledWith('lease-81');
    expect(vi.mocked(leases.setLeaseState)).not.toHaveBeenCalled();
    // A failed task that asked nothing may have put needs-human on itself, so
    // GitHub's timeline is asked after the answer (`labelledByTask`).
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'task.stopped',
        target: 'openadlc#81',
        payload: expect.objectContaining({ task: 'task-81', bot: 'intake', was: 'failed', lease: null, afterAnswer: { cancel: true, lease: 'lease-81', needsHuman: true } }),
      }),
    );
    expect(vi.mocked(audit)).toHaveBeenCalledWith(expect.objectContaining({ action: 'lease.released', payload: expect.objectContaining({ leaseId: 'lease-81', task: 'task-81' }) }));
    const reason = String(vi.mocked(audit).mock.calls[0]![0].payload?.reason);
    // Recorded by the bridge before it answers, not left to hostd's cancel.
    expect(vi.mocked(tasks.updateTaskState)).toHaveBeenCalledWith('task-81', 'stopped', { exitReason: reason });
    // What takes its card off the board.
    const { STOPPED_BY_A_PERSON } = await import('./attention.js');
    expect(reason.startsWith(STOPPED_BY_A_PERSON)).toBe(true);
    // And what the task store calls a person's stop, so the deploy sweep leaves it stopped.
    const { tasks: store } = await vi.importActual<typeof import('@openadlc/db')>('@openadlc/db');
    expect(store.stoppedByPerson({ state: 'stopped', exitReason: reason })).toBe(true);
    expect(reason).toContain('the operator takes over');
  });

  it('leaves a lease alone that no longer holds anything', async () => {
    lease = { id: 'lease-81', state: 'released', botId: 'bot-intake' };
    const response = await stop();
    expect(await response.json()).toMatchObject({ releasedLease: null });
    expect(vi.mocked(leases.releaseUnlessWorkedUnder)).not.toHaveBeenCalled();
  });

  it('refuses a task that is still working, without asking hostd', async () => {
    task = { ...FAILED, state: 'running' };
    const response = await stop();
    expect(response.status).toBe(409);
    expect(asked).toEqual([]);
  });

  it('stops one paused on a question, and closes the question unanswered so it leaves Needs you', async () => {
    // Intake 28ac028c sat paused on a question after its issue merged, its
    // computer running, and this route refused to stop it.
    task = { ...FAILED, state: 'paused' };
    openGates = [{ taskId: 'task-81' }];
    const response = await stop('its issue merged');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ task: 'task-81', state: 'stopped', releasedLease: null, questionsClosed: 1, stopped: true });
    expect(asked).toEqual([{ method: 'POST', url: '/tasks/task-81/cancel', secret: 'install-secret-for-the-test' }]);
    expect(vi.mocked(leases.releaseUnlessWorkedUnder)).toHaveBeenCalledWith('lease-81');
    expect(vi.mocked(threads.expireGatesOfTask)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(threads.expireGatesOfTask)).toHaveBeenCalledWith('task-81', expect.any(String), 'its issue merged');
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'task.stopped', payload: expect.objectContaining({ was: 'paused', questionsClosed: 1 }) }),
    );
  });

  describe('needs-human, which the question put on its issue', () => {
    let labels: string[];
    const removeLabel = vi.fn(async () => undefined);
    beforeEach(() => {
      task = { ...FAILED, state: 'paused' };
      openGates = [{ taskId: 'task-81' }];
      labels = ['needs-human'];
      removeLabel.mockClear();
      vi.mocked(repos.listRepos).mockImplementation((async () => [{ id: 'repo-openadlc', name: 'openadlc', fullName: 'janedoe/openadlc' }]) as never);
      asBot.mockReset().mockImplementation(async () => ({ getIssue: async () => ({ labels }), removeLabel }));
    });

    it('comes off when the question this stop closed put it there and none other waits', async () => {
      // Left on, the dispatcher would not lease the issue again and the merge
      // line would hold its pull request, with no card saying why.
      vi.mocked(threads.listOpenGatesOnSubject).mockResolvedValue([{ id: 'gate-0', taskId: 'task-81', addedNeedsHuman: true }] as never);
      expect((await stop()).status).toBe(200);
      expect(asBot).toHaveBeenCalledWith('intake');
      expect(removeLabel).toHaveBeenCalledWith('janedoe/openadlc', 81, 'needs-human', { timeoutMs: 5_000 });
      // Audited before the answer, with what is still to be done after it.
      expect(vi.mocked(audit)).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'task.stopped', payload: expect.objectContaining({ afterAnswer: expect.objectContaining({ needsHuman: true }) }) }),
      );
    });

    it('stays when another question waits on the subject', async () => {
      vi.mocked(threads.listOpenGatesOnSubject).mockResolvedValue([
        { id: 'gate-0', taskId: 'task-81', addedNeedsHuman: true },
        { id: 'gate-other', taskId: 'task-90', addedNeedsHuman: false },
      ] as never);
      expect((await stop()).status).toBe(200);
      expect(removeLabel).not.toHaveBeenCalled();
    });

    it('stays when a person put it there before the question was asked', async () => {
      vi.mocked(threads.listOpenGatesOnSubject).mockResolvedValue([{ id: 'gate-0', taskId: 'task-81', addedNeedsHuman: false }] as never);
      expect((await stop()).status).toBe(200);
      expect(removeLabel).not.toHaveBeenCalled();
    });

    it('stays on an issue labelled openadlc:ignore, which the crew leaves alone', async () => {
      labels = ['needs-human', 'openadlc:ignore'];
      vi.mocked(threads.listOpenGatesOnSubject).mockResolvedValue([{ id: 'gate-0', taskId: 'task-81', addedNeedsHuman: true }] as never);
      expect((await stop()).status).toBe(200);
      expect(removeLabel).not.toHaveBeenCalled();
    });

    it('does not undo the stop when GitHub refuses, and says so in the thread', async () => {
      removeLabel.mockRejectedValueOnce(new Error('GitHub 502') as never);
      vi.mocked(threads.listOpenGatesOnSubject).mockResolvedValue([{ id: 'gate-0', taskId: 'task-81', addedNeedsHuman: true }] as never);
      const response = await stop();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ questionsClosed: 1, stopped: true });
      expect(said()).toContainEqual(expect.objectContaining({ kind: 'sys', text: expect.stringContaining('needs-human is still on openadlc#81'), note: 'GitHub 502' }));
    });
  });

  /**
   * A `needs-human` no question recorded as its own: a bot put it on itself,
   * and the question it asked after found it on. On 2026-10-22 a person's Stop
   * on #74's intake closed its question and left the label on: the dispatcher
   * would not lease the issue again, and no card said why. GitHub's timeline
   * says who put it on and when.
   */
  describe('needs-human the task’s own account put on while it ran', () => {
    const BOT_LOGIN = 'fleet-atlas-orzelig';
    let labels: string[];
    let labelled: { actor: { login: string } | null; createdAt: string; label: { name: string } }[];
    const removeLabel = vi.fn(async () => undefined);
    const request = vi.fn(async (_method: string, _path: string, _body?: unknown): Promise<unknown> => ({
      data: { repository: { issueOrPullRequest: { timelineItems: { nodes: labelled } } } },
    }));
    const by = (login: string, createdAt: string, name = 'needs-human', databaseId?: number) => ({
      actor: { login, ...(databaseId !== undefined ? { databaseId } : {}) },
      createdAt,
      label: { name },
    });
    const getIssue = vi.fn(async (_repo: string, _number: number, _options?: unknown) => ({ labels }));

    beforeEach(() => {
      task = { ...FAILED, state: 'paused', createdAt: '2026-10-22T16:32:00.000Z', startedAt: '2026-10-22T16:32:52.000Z' };
      openGates = [{ taskId: 'task-81' }];
      labels = ['needs-human', 'adlc:intake', 'do:ai'];
      labelled = [by('orzelig-fleet-flow', '2026-10-22T16:32:51Z', 'adlc:intake'), by(BOT_LOGIN, '2026-10-22T16:33:55Z')];
      removeLabel.mockClear();
      request.mockClear();
      vi.mocked(repos.listRepos).mockImplementation((async () => [{ id: 'repo-openadlc', name: 'openadlc', fullName: 'janedoe/openadlc' }]) as never);
      vi.mocked(bots.getBotById).mockImplementation(async () => ({ id: 'bot-intake', name: 'intake', role: 'intake', githubLogin: BOT_LOGIN }) as never);
      vi.mocked(bots.listBots).mockImplementation(async () =>
        [
          { id: 'bot-flow', name: 'janedoe-openadlc-flow', role: 'automation', githubLogin: 'orzelig-fleet-flow' },
          { id: 'bot-intake', name: 'intake', role: 'intake', githubLogin: BOT_LOGIN },
        ] as never,
      );
      // The label was on when the question was asked, so the question did not
      // record it as its own.
      vi.mocked(threads.listOpenGatesOnSubject).mockResolvedValue([{ id: 'gate-0', taskId: 'task-81', addedNeedsHuman: false }] as never);
      vi.mocked(threads.listGatesForTasks).mockResolvedValue([{ id: 'gate-0', taskId: 'task-81', addedNeedsHuman: false }] as never);
      asBot.mockReset().mockImplementation(async () => ({ getIssue, removeLabel, request }));
      getIssue.mockClear();
    });

    afterEach(() => {
      vi.mocked(bots.listBots).mockImplementation(async () => DEFAULT_CREW as never);
      vi.mocked(threads.listGatesForTasks).mockResolvedValue([] as never);
      delete (credentials as Record<string, unknown>).getCredential;
    });

    it('comes off when the newest labelling is the task’s own account’s, since the task started', async () => {
      expect((await stop()).status).toBe(200);
      // Each of the Stop's GitHub calls is bounded, after the answer too: a
      // shutdown waits only ten seconds for what is left.
      expect(getIssue).toHaveBeenCalledWith('janedoe/openadlc', 81, { timeoutMs: 5_000 });
      expect(request).toHaveBeenCalledWith(
        'POST',
        '/graphql',
        expect.objectContaining({ variables: { owner: 'janedoe', name: 'openadlc', number: 81 } }),
        { timeoutMs: 5_000 },
      );
      expect(removeLabel).toHaveBeenCalledWith('janedoe/openadlc', 81, 'needs-human', { timeoutMs: 5_000 });
      // Audited before the answer, which leaves GitHub's timeline to after it.
      expect(vi.mocked(audit)).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'task.stopped', payload: expect.objectContaining({ afterAnswer: expect.objectContaining({ needsHuman: true }) }) }),
      );
    });

    it('comes off a task that asked nothing, which put it on itself and failed', async () => {
      task = { ...FAILED, createdAt: '2026-10-22T16:32:00.000Z', startedAt: '2026-10-22T16:32:52.000Z' };
      openGates = [];
      vi.mocked(threads.listOpenGatesOnSubject).mockResolvedValue([] as never);
      expect((await stop()).status).toBe(200);
      expect(removeLabel).toHaveBeenCalledWith('janedoe/openadlc', 81, 'needs-human', { timeoutMs: 5_000 });
    });

    it('stays when a person put it on last', async () => {
      labelled = [by(BOT_LOGIN, '2026-10-22T16:33:55Z'), by('janedoe', '2026-10-22T16:40:00Z')];
      expect((await stop()).status).toBe(200);
      expect(removeLabel).not.toHaveBeenCalled();
    });

    it('stays when another crew account put it on, as the automation account does to hold work for a person', async () => {
      // "Hold this PR", a send-back past its limit, an unreviewed merge: each
      // labels as the automation account, on purpose.
      labelled = [by('orzelig-fleet-flow', '2026-10-22T16:40:00Z')];
      expect((await stop()).status).toBe(200);
      expect(removeLabel).not.toHaveBeenCalled();
    });

    it('stays when the task’s account is the automation account’s too, whose labels hold work on purpose', async () => {
      // The fixture's logins must be one account for this to mean anything.
      vi.mocked(bots.getBotById).mockImplementation(async () => ({ id: 'bot-intake', name: 'intake', role: 'intake', githubLogin: 'orzelig-fleet-flow' }) as never);
      vi.mocked(bots.listBots).mockImplementation(async () =>
        [
          { id: 'bot-flow', name: 'janedoe-openadlc-flow', role: 'automation', githubLogin: 'orzelig-fleet-flow' },
          { id: 'bot-intake', name: 'intake', role: 'intake', githubLogin: 'orzelig-fleet-flow' },
        ] as never,
      );
      labelled = [by('orzelig-fleet-flow', '2026-10-22T16:40:00Z')];
      expect((await stop()).status).toBe(200);
      expect(removeLabel).not.toHaveBeenCalled();
    });

    it('compares accounts by the id GitHub gives, so a renamed account is still the task’s and a reused login is not', async () => {
      Object.assign(credentials, {
        getCredential: vi.fn(async (botId: string) => ({ githubUserId: botId === 'bot-intake' ? 501 : 900 })),
      });
      labelled = [by('fleet-atlas-renamed', '2026-10-22T16:33:55Z', 'needs-human', 501)];
      expect((await stop()).status).toBe(200);
      expect(removeLabel).toHaveBeenCalledTimes(1);

      removeLabel.mockClear();
      task = { ...FAILED, state: 'paused', createdAt: '2026-10-22T16:32:00.000Z', startedAt: '2026-10-22T16:32:52.000Z' };
      labelled = [by(BOT_LOGIN, '2026-10-22T16:33:55Z', 'needs-human', 777)];
      expect((await stop()).status).toBe(200);
      expect(removeLabel).not.toHaveBeenCalled();
    });

    it.each([
      ['a refused plan change', 'plan change refused by janedoe'],
      ['a hand-off at the cost cap', 'stopped at the cost cap: hand it to a person (janedoe)'],
    ])('stays on a task %s ended, which kept the label so the issue is not leased again', async (_what, exitReason) => {
      // The thread still offers Stop on it, and the timeline names the task's
      // own account: the question that put the label on was answered.
      task = { ...FAILED, state: 'stopped', exitReason, createdAt: '2026-10-22T16:32:00.000Z', startedAt: '2026-10-22T16:32:52.000Z' };
      openGates = [];
      vi.mocked(threads.listOpenGatesOnSubject).mockResolvedValue([] as never);
      vi.mocked(threads.listGatesForTasks).mockResolvedValue([] as never);
      expect((await stop()).status).toBe(200);
      expect(request).not.toHaveBeenCalled();
      expect(removeLabel).not.toHaveBeenCalled();
    });

    it('stays when a question the task asked, answered since, recorded putting it on: that question’s rule decides', async () => {
      openGates = [];
      vi.mocked(threads.listOpenGatesOnSubject).mockResolvedValue([] as never);
      vi.mocked(threads.listGatesForTasks).mockResolvedValue([{ id: 'gate-old', taskId: 'task-81', state: 'answered', addedNeedsHuman: true }] as never);
      expect((await stop()).status).toBe(200);
      expect(request).not.toHaveBeenCalled();
      expect(removeLabel).not.toHaveBeenCalled();
    });

    it('stays when it was put on before the task started', async () => {
      labelled = [by(BOT_LOGIN, '2026-10-22T16:00:00Z')];
      expect((await stop()).status).toBe(200);
      expect(removeLabel).not.toHaveBeenCalled();
    });

    it.each(['do:legal', 'do:human', 'do:product'])('stays on a %s issue, which triage gives it on purpose because a person owes the work', async (owed) => {
      labels = ['needs-human', owed];
      expect((await stop()).status).toBe(200);
      expect(removeLabel).not.toHaveBeenCalled();
    });

    it('stays when another question still waits on the subject', async () => {
      vi.mocked(threads.listOpenGatesOnSubject).mockResolvedValue([
        { id: 'gate-0', taskId: 'task-81', addedNeedsHuman: false },
        { id: 'gate-other', taskId: 'task-90', addedNeedsHuman: true },
      ] as never);
      expect((await stop()).status).toBe(200);
      expect(removeLabel).not.toHaveBeenCalled();
    });

    it('stays, and the stop stands, when GitHub’s timeline cannot be read', async () => {
      request.mockRejectedValueOnce(new Error('GitHub 502'));
      const response = await stop();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ stopped: true });
      expect(removeLabel).not.toHaveBeenCalled();
    });
  });

  it.each(['questions', 'draft'])('abandons a console request in %s whose triage a person stopped, which was left hidden and never ended', async (state) => {
    // Stop on a request's question card ended the task and left the request in
    // `questions`: off the board, out of Needs you, and never started again.
    stored.requests = [{ id: 'a4b02784-0000-0000-0000-000000000000', state, createdAt: '2026-10-22T00:00:00.000Z' }];
    task = { ...FAILED, state: 'paused', subjectRef: 'request:a4b02784', leaseId: null };
    openGates = [{ taskId: 'task-81' }];
    const response = await stop();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ questionsClosed: 1, stopped: true });
    expect(stored.requests[0]!.state).toBe('abandoned');
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'task.stopped', payload: expect.objectContaining({ requestAbandoned: true }) }),
    );
  });

  it('leaves a request alone when the stop is for unfinished work, which abandonRequest moves itself', async () => {
    stored.requests = [{ id: 'a4b02784-0000-0000-0000-000000000000', state: 'questions', createdAt: '2026-10-22T00:00:00.000Z' }];
    task = { ...FAILED, state: 'paused', subjectRef: 'request:a4b02784', leaseId: null };
    const { stopTask } = await import('./api.js');
    const result = await stopTask('task-81', 'bridge', 'its issue merged', { cancelTask: async () => undefined } as never, { unfinished: true });
    expect(result.stopped).toBe(true);
    expect(stored.requests[0]!.state).toBe('questions');
  });

  it('leaves an issue alone, which has no request to move', async () => {
    task = { ...FAILED, state: 'paused' };
    vi.mocked(requests.updateRequest).mockClear();
    const response = await stop();
    expect(response.status).toBe(200);
    expect(vi.mocked(requests.updateRequest)).not.toHaveBeenCalled();
  });

  it('is stopped all the same when hostd refuses after the answer, keeps the lease, and says so in the thread', async () => {
    hostdStatus = 500;
    const response = await stop();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: 'stopped', stopped: true });
    expect(asked).toEqual([{ method: 'POST', url: '/tasks/task-81/cancel', secret: 'install-secret-for-the-test' }]);
    // hostd keeps what was not pushed as it ends the session; a build leased
    // the issue before that would start without it.
    expect(vi.mocked(leases.releaseUnlessWorkedUnder)).not.toHaveBeenCalled();
    expect(said()).toContainEqual(
      expect.objectContaining({
        kind: 'sys',
        // An in-task lease is the idle-lease check's; a paused one is not.
        text: expect.stringMatching(/hostd did not end its session, so its lease is kept.*A Stop sent again asks hostd again.*idle-lease check lets it go about 15 minutes after the stop/),
      }),
    );
  });

  it('says a paused lease it kept is the reconciler’s, and one with a pull request stays while that is open', async () => {
    hostdStatus = 500;
    task = { ...FAILED, state: 'paused' };
    lease = { id: 'lease-81', state: 'paused', botId: 'bot-intake' };
    await stop();
    expect(said()).toContainEqual(expect.objectContaining({ text: expect.stringContaining('the reconciler lets it go on its next pass') }));

    vi.mocked(threads.addMessage).mockClear();
    lease = { id: 'lease-81', state: 'in_task', botId: 'bot-intake', prNumber: 95 } as never;
    task = { ...FAILED };
    await stop();
    expect(said()).toContainEqual(expect.objectContaining({ text: expect.stringContaining('it stays while pull request #95 is open') }));
  });

  it('asks hostd again on a second Stop when the first cancel was not taken, and lets the lease go then', async () => {
    hostdStatus = 500;
    expect(await (await stop()).json()).toMatchObject({ stopped: true });
    expect(vi.mocked(leases.releaseUnlessWorkedUnder)).not.toHaveBeenCalled();
    // As the database has it now: stopped, by this person.
    task = { ...FAILED, state: 'stopped', exitReason: String(vi.mocked(audit).mock.calls[0]![0].payload?.reason) };

    hostdStatus = 200;
    const again = await stop();

    expect(await again.json()).toMatchObject({ state: 'stopped', stopped: true, releasedLease: null });
    expect(asked).toHaveLength(2);
    expect(vi.mocked(leases.releaseUnlessWorkedUnder)).toHaveBeenCalledWith('lease-81');
    // Stopped once: the second press is not audited as another stop.
    expect(vi.mocked(audit).mock.calls.filter(([entry]) => entry.action === 'task.stopped')).toHaveLength(1);

    // Done now: a third press changes nothing.
    expect(await (await stop()).json()).toMatchObject({ stopped: false });
    expect(asked).toHaveLength(2);
  });

  it('does not let go of a lease a Try again took up between the answer and the release', async () => {
    // Stop let the lease go by id once hostd had ended the session, seconds
    // after its checks; a Try again in between reused the lease, and the
    // release freed it under the new build.
    task = { ...FAILED, kind: 'implement' };
    active = { id: 'lease-81', state: 'in_task', botId: 'bot-intake' };
    const working: { id: string; leaseId: string; state: string }[] = [];
    // As the guarded statement does: refused while a task works under the lease.
    vi.mocked(leases.releaseUnlessWorkedUnder).mockImplementation(async (id: string) => !working.some((one) => one.leaseId === id));
    const { startBuild } = await import('./build-start.js');
    vi.mocked(startBuild).mockImplementationOnce(async (_deps, input) => {
      working.push({ id: 'task-2', leaseId: input.leaseId, state: 'queued' });
      return { taskId: 'task-2', session: 's' };
    });
    let release: () => void = () => undefined;
    const cancelling = { cancelTask: vi.fn(() => new Promise<void>((resolve) => (release = resolve))) };
    const { stopTask } = await import('./api.js');

    expect(await stopTask('task-81', 'janedoe', '', cancelling, { afterwards })).toMatchObject({ stopped: true });
    const retried = await fetch(`${bridgeUrl}/v1/tasks/task-81/retry`, { method: 'POST' });
    expect(retried.status).toBe(200);
    expect(working).toEqual([{ id: 'task-2', leaseId: 'lease-81', state: 'queued' }]);

    release();
    await afterwards.settled();

    expect(vi.mocked(leases.releaseUnlessWorkedUnder)).toHaveBeenCalledWith('lease-81');
    expect(vi.mocked(leases.setLeaseState)).not.toHaveBeenCalledWith('lease-81', 'released');
    expect(vi.mocked(audit)).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'lease.released' }));
  });

  it('answers before hostd has ended its session, which follows', async () => {
    // Stop waited for hostd's cancel and GitHub's label before it answered.
    let release: () => void = () => undefined;
    const cancelling = { cancelTask: vi.fn(() => new Promise<void>((resolve) => (release = resolve))) };
    const { stopTask } = await import('./api.js');
    const answered = await stopTask('task-81', 'janedoe', '', cancelling, { afterwards });

    expect(answered).toMatchObject({ state: 'stopped', releasedLease: null, stopped: true });
    expect(vi.mocked(tasks.updateTaskState)).toHaveBeenCalledWith('task-81', 'stopped', expect.anything());
    expect(vi.mocked(audit)).toHaveBeenCalledWith(expect.objectContaining({ action: 'task.stopped' }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(cancelling.cancelTask).toHaveBeenCalledTimes(1);
    // The lease goes once hostd has kept the branch and given the computer back.
    expect(vi.mocked(leases.releaseUnlessWorkedUnder)).not.toHaveBeenCalled();

    release();
    await afterwards.settled();
    expect(vi.mocked(leases.releaseUnlessWorkedUnder)).toHaveBeenCalledWith('lease-81');
  });

  it('does nothing again when pressed twice: a task a person stopped is not stopped again', async () => {
    expect((await stop()).status).toBe(200);
    task = { ...FAILED, state: 'stopped', exitReason: String(vi.mocked(audit).mock.calls[0]![0].payload?.reason) };

    const again = await stop();

    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ state: 'stopped', stopped: false, releasedLease: null });
    expect(asked).toHaveLength(1);
    expect(vi.mocked(audit).mock.calls.filter(([entry]) => entry.action === 'task.stopped')).toHaveLength(1);
    expect(vi.mocked(leases.releaseUnlessWorkedUnder)).toHaveBeenCalledTimes(1);
  });

  it('stops a task paused on nothing a person is asked', async () => {
    task = { ...FAILED, state: 'paused' };
    const response = await stop();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ questionsClosed: 0, stopped: true });
    expect(asked).toHaveLength(1);
  });

  it('refuses when the same work is going again, from a stale card', async () => {
    // Try again reuses the lease; stopping the old task must not pull it from under the new one.
    onSubject = [{ ...FAILED, id: 'task-82', state: 'running' }];
    const response = await stop();
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain('going again');
    expect(asked).toEqual([]);
    expect(vi.mocked(leases.setLeaseState)).not.toHaveBeenCalled();
  });

  it('releases the lease its bot holds on the issue, for a build that recorded none', async () => {
    task = { ...FAILED, kind: 'implement', subjectRef: 'openadlc#81', leaseId: null };
    lease = null;
    active = { id: 'lease-build', state: 'in_task', botId: 'bot-intake' };
    const response = await stop();
    expect(await response.json()).toMatchObject({ stopped: true });
    expect(vi.mocked(leases.releaseUnlessWorkedUnder)).toHaveBeenCalledWith('lease-build');
  });

  it('leaves a lease another unfinished task on the subject works under', async () => {
    // Its bot was leased the issue again, and is building under the same lease.
    task = { ...FAILED, kind: 'implement', leaseId: null };
    lease = null;
    active = { id: 'lease-build', state: 'in_task', botId: 'bot-intake' };
    onSubject = [{ ...FAILED, id: 'task-83', kind: 'patch', state: 'running', leaseId: 'lease-build' }];
    const response = await stop();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ releasedLease: null });
    expect(vi.mocked(leases.releaseUnlessWorkedUnder)).not.toHaveBeenCalled();
  });

  it('leaves a lease a task on another subject works under, such as a patch on the pull request', async () => {
    elsewhere = [{ ...FAILED, id: 'task-patch', kind: 'patch', subjectRef: 'openadlc#95', state: 'running', botId: 'bot-builder', leaseId: 'lease-81' }];
    const response = await stop();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ releasedLease: null });
    expect(vi.mocked(leases.releaseUnlessWorkedUnder)).not.toHaveBeenCalled();
  });

  it('audits the stop, and says so in the thread, when the lease cannot be let go after the answer', async () => {
    vi.mocked(leases.releaseUnlessWorkedUnder).mockRejectedValueOnce(new Error('connection reset'));
    const response = await stop();
    expect(response.status).toBe(200);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'task.stopped', payload: expect.objectContaining({ afterAnswer: expect.objectContaining({ lease: 'lease-81' }) }) }),
    );
    expect(vi.mocked(audit)).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'lease.released' }));
    expect(said()).toContainEqual(
      expect.objectContaining({ kind: 'sys', text: expect.stringContaining('its lease could not be let go; otherwise the idle-lease check lets it go'), note: 'connection reset' }),
    );
  });

  it('says it is stopped, and that its lease was not looked at, when the lease cannot be read', async () => {
    vi.mocked(leases.getLease).mockRejectedValueOnce(new Error('connection reset'));
    const response = await stop();
    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: string }).error).toContain('it is stopped, but its lease could not be released');
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'task.stopped', payload: expect.objectContaining({ lease: null, leaseError: 'connection reset' }) }),
    );
  });

  describe('when its repository is removed from OpenADLC', () => {
    const cancelled: { id: string; reason: string }[] = [];
    const cancelling = { cancelTask: vi.fn(async (id: string, reason: string) => void cancelled.push({ id, reason })) };
    const removing = async (id = 'task-81') => {
      const { stopTask } = await import('./api.js');
      return stopTask(id, 'janedoe', 'repository removed from OpenADLC by janedoe', cancelling, { unfinished: true });
    };

    beforeEach(() => {
      cancelled.length = 0;
      vi.mocked(threads.expireGatesOfTask).mockImplementation(async () => ['gate-9'] as never);
    });

    it('stops one paused on a question, and closes the question so it leaves Needs you', async () => {
      task = { ...FAILED, state: 'paused' };
      openGates = [{ taskId: 'task-81' }];

      expect(await removing()).toEqual({ task: 'task-81', state: 'stopped', releasedLease: 'lease-81', questionsClosed: 1, stopped: true });
      // Guarded, as the console's is: a task started under it since is not left without it.
      expect(vi.mocked(leases.releaseUnlessWorkedUnder)).toHaveBeenCalledWith('lease-81');
      expect(cancelled).toEqual([{ id: 'task-81', reason: 'stopped by a person from the console (janedoe): repository removed from OpenADLC by janedoe' }]);
      expect(threads.expireGatesOfTask).toHaveBeenCalledWith('task-81', 'janedoe', 'repository removed from OpenADLC by janedoe');
      expect(vi.mocked(audit)).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'task.stopped',
          target: 'openadlc#81',
          payload: expect.objectContaining({ was: 'paused', questionsClosed: 1, reason: expect.stringContaining('repository removed from OpenADLC by janedoe') }),
        }),
      );
    });

    it('stops one running or queued, which a card’s Stop refuses', async () => {
      for (const state of ['running', 'queued']) {
        task = { ...FAILED, state };
        expect(await removing()).toMatchObject({ state: 'stopped' });
      }
      expect(cancelled).toHaveLength(2);
    });

    it('stops it even with the same work going again, since that task is stopped too', async () => {
      task = { ...FAILED, state: 'running' };
      onSubject = [{ ...FAILED, id: 'task-82', state: 'running' }];
      expect(await removing()).toMatchObject({ state: 'stopped' });
    });

    it('leaves a task that ended on its own as it ended, without asking hostd', async () => {
      task = { ...FAILED, state: 'done' };
      // `stopped: false`, so a close that says what it stopped says nothing of it.
      expect(await removing()).toEqual({ task: 'task-81', state: 'done', releasedLease: null, questionsClosed: 0, stopped: false });
      expect(cancelled).toEqual([]);
      expect(vi.mocked(audit)).not.toHaveBeenCalled();
    });

    it('says a stop the bridge made is the bridge’s, with why, and not a person’s', async () => {
      // A review its pull request's merge stopped (`Webhooks.stopReviewsOf`)
      // was recorded "stopped by a person from the console (bridge): its pull
      // request merged", and the crew page counted it as a person's stop.
      task = { ...FAILED, state: 'running' };
      const { stopTask } = await import('./api.js');
      expect(await stopTask('task-81', 'bridge', 'its pull request merged', cancelling, { unfinished: true })).toMatchObject({ state: 'stopped', stopped: true });
      expect(cancelled).toEqual([{ id: 'task-81', reason: 'stopped by the bridge: its pull request merged' }]);
      expect(vi.mocked(audit)).toHaveBeenCalledWith(
        expect.objectContaining({ actor: 'bridge', action: 'task.stopped', payload: expect.objectContaining({ reason: 'stopped by the bridge: its pull request merged' }) }),
      );
      const { STOPPED_BY_A_PERSON } = await import('./attention.js');
      const { stoppedByTheBridge } = await import('./bridge-stops.js');
      expect(cancelled[0]!.reason.startsWith(STOPPED_BY_A_PERSON)).toBe(false);
      expect(stoppedByTheBridge({ state: 'stopped', exitReason: cancelled[0]!.reason })).toBe(true);
    });

    it('says so when hostd does not stop it, and closes nothing', async () => {
      task = { ...FAILED, state: 'paused' };
      cancelling.cancelTask.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
      await expect(removing()).rejects.toThrow('hostd did not stop it: connect ECONNREFUSED');
      expect(threads.expireGatesOfTask).not.toHaveBeenCalled();
    });

    it('does not fail for a lease or a question it could not let go: the removal goes on to those', async () => {
      task = { ...FAILED, state: 'running' };
      vi.mocked(leases.releaseUnlessWorkedUnder).mockRejectedValueOnce(new Error('connection reset'));
      vi.mocked(threads.expireGatesOfTask).mockRejectedValueOnce(new Error('connection reset'));
      expect(await removing()).toMatchObject({ state: 'stopped', releasedLease: null, questionsClosed: 0 });
      expect(vi.mocked(audit)).toHaveBeenCalledWith(
        expect.objectContaining({ payload: expect.objectContaining({ leaseError: 'connection reset', questionError: 'connection reset' }) }),
      );
    });
  });

  it('does not stop a task that an answer resumed since the card was drawn', async () => {
    task = { ...FAILED, state: 'paused' };
    let reads = 0;
    vi.mocked(tasks.getTask).mockImplementation(async () => (++reads === 1 ? task : { ...FAILED, state: 'running' }) as never);
    const response = await stop();
    expect(response.status).toBe(409);
    expect(asked).toEqual([]);
  });
});

describe('dismissing a failed task’s card', () => {
  let task: Record<string, unknown> | null;

  beforeEach(() => {
    task = { id: 'task-81', botId: 'bot-intake', kind: 'review', state: 'failed', subjectRef: 'openadlc#81', endedAt: '2026-09-30T00:44:00.000Z' };
    vi.mocked(tasks.getTask).mockImplementation(async () => task as never);
    vi.mocked(audit).mockClear();
    vi.mocked(acknowledgements.acknowledge).mockClear();
  });

  const dismiss = (body: Record<string, unknown>) =>
    fetch(`${bridgeUrl}/v1/tasks/task-81/dismiss`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('keeps the ending the card showed, audits who dismissed which task, and stops nothing', async () => {
    const response = await dismiss({ occurrence: '2026-09-30T00:44:00.000Z' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ task: 'task-81', dismissed: '2026-09-30T00:44:00.000Z' });
    expect(acknowledgements.acknowledge).toHaveBeenCalledWith('task:task-81', '2026-09-30T00:44:00.000Z', expect.any(String));
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'task.dismissed', target: 'openadlc#81', payload: expect.objectContaining({ task: 'task-81', occurrence: '2026-09-30T00:44:00.000Z' }) }),
    );
    // Not hostd's: nothing is cancelled or run again.
    expect(asked).toEqual([]);
  });

  it('forgets task dismissals older than the week a failure is read for', async () => {
    vi.mocked(acknowledgements.forgetBefore).mockClear();
    const before = Date.now();
    await dismiss({});
    const [prefix, cutoff] = vi.mocked(acknowledgements.forgetBefore).mock.calls[0]!;
    expect(prefix).toBe('task:');
    expect(before - cutoff.getTime()).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000 - 1000);
    expect(before - cutoff.getTime()).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000 + 1000);
  });

  it('is dismissed even when old dismissals cannot be forgotten', async () => {
    vi.mocked(acknowledgements.forgetBefore).mockRejectedValueOnce(new Error('database gone'));
    expect((await dismiss({})).status).toBe(200);
  });

  it('takes the task’s own ending when the card sent none', async () => {
    await dismiss({});
    expect(acknowledgements.acknowledge).toHaveBeenCalledWith('task:task-81', '2026-09-30T00:44:00.000Z', expect.any(String));
  });

  it('is refused for a task that is still going, or is not there', async () => {
    task = { ...task, state: 'running' };
    expect((await dismiss({})).status).toBe(409);
    task = null;
    expect((await dismiss({})).status).toBe(404);
    expect(acknowledgements.acknowledge).not.toHaveBeenCalled();
  });
});

describe('the install’s people, written through PATCH /v1/install', () => {
  it('refuses an entry that is not a GitHub login, before it reaches AGENTS.md or CODEOWNERS', async () => {
    for (const humans of ['janedoe, jane doe', '@janedoe', 'janedoe;bob']) {
      const response = await fetch(`${bridgeUrl}/v1/install`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ humans }),
      });
      expect(response.status, humans).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain('is not a GitHub username');
    }
    expect(vi.mocked(settings.setSetting)).not.toHaveBeenCalled();
  });

  it('refuses the accounts they are pinned to, which only the bridge writes, from GitHub’s answer', async () => {
    const response = await fetch(`${bridgeUrl}/v1/install`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ humanIds: JSON.stringify({ janedoe: 999 }) }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('kept by the bridge');
    expect(vi.mocked(settings.setSetting)).not.toHaveBeenCalled();
  });
});

describe('the webhook’s address, written through PATCH /v1/install', () => {
  const patch = (body: Record<string, string>) =>
    fetch(`${bridgeUrl}/v1/install`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('refuses who made it, which only the webhook step writes', async () => {
    // `tunnel` written here beside a person's own quick tunnel had the next
    // start replace it; `address` beside the bridge's, never raise it again.
    for (const webhookMode of ['tunnel', 'address', '']) {
      const response = await patch({ webhookMode });
      expect(response.status, webhookMode).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain('POST /v1/webhook/configure');
    }
    expect(vi.mocked(settings.setSetting)).not.toHaveBeenCalled();
    expect(vi.mocked(settings.setSettings)).not.toHaveBeenCalled();
  });

  it('is stored as one a person gave, so the mode of the address before is never left beside it', async () => {
    stored.settings = { publicUrl: 'https://calm-badger-42.trycloudflare.com', webhookMode: 'tunnel' };

    await patch({ publicUrl: ' https://persons-own-1.trycloudflare.com ' });
    expect(stored.settings).toEqual({ publicUrl: 'https://persons-own-1.trycloudflare.com', webhookMode: 'address' });

    // Cleared with it, as a take-down clears the two.
    await patch({ publicUrl: '' });
    expect(stored.settings).toEqual({});
  });
});

describe('the appPrivateKey, written through PATCH /v1/install', () => {
  const KEY = '-----BEGIN RSA PRIVATE KEY-----\nzzz-old-zzz\n-----END RSA PRIVATE KEY-----';
  let secrets: Map<string, string>;

  beforeEach(async () => {
    const { setSecretStore } = await import('@openadlc/github');
    secrets = new Map([['github-app-private-key', KEY]]);
    setSecretStore({
      get: async (ref) => secrets.get(ref) ?? null,
      set: async (ref, value) => void secrets.set(ref, value),
      delete: async (ref) => void secrets.delete(ref),
      list: async () => [...secrets.keys()],
    });
  });

  const patch = (appPrivateKey: string) =>
    fetch(`${bridgeUrl}/v1/install`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appPrivateKey }),
    });

  it('refuses an empty or blank one and keeps the stored key, since GitHub never shows it again', async () => {
    for (const blank of ['', ' ', ' \n', '\t\n ']) {
      const response = await patch(blank);
      expect(response.status, JSON.stringify(blank)).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain('paste the PEM private key');
    }
    expect(secrets.get('github-app-private-key')).toBe(KEY);
  });

  it('still stores a PEM', async () => {
    const next = '-----BEGIN RSA PRIVATE KEY-----\nzzz-new-zzz\n-----END RSA PRIVATE KEY-----';
    // The answer is read from the effective config, which this test's bridge
    // has none of; what matters is the store.
    await patch(`${next}\n`);
    expect(secrets.get('github-app-private-key')).toBe(next);
  });
});

describe('the organization, written through PATCH /v1/install', () => {
  const patch = (organization: string) =>
    fetch(`${bridgeUrl}/v1/install`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organization }),
    });

  afterEach(() => {
    delete stored.settings.organization;
  });

  it('is stored without the @ the console’s lookup ignores', async () => {
    await patch(' @acme ');
    expect(vi.mocked(settings.setSetting)).toHaveBeenCalledWith('organization', 'acme', expect.anything());
    expect(stored.settings.organization).toBe('acme');
  });

  it('keeps an Enterprise Managed User’s _, and an empty value still clears it', async () => {
    await patch('acme_emu');
    expect(stored.settings.organization).toBe('acme_emu');
    await patch('');
    expect(stored.settings.organization).toBeUndefined();
  });

  it('refuses what cannot be a GitHub login, and says what one looks like', async () => {
    for (const organization of ['acme/repo', 'acme labs', 'acme@labs']) {
      const response = await patch(organization);
      expect(response.status, organization).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain('is not a GitHub login');
    }
    expect(vi.mocked(settings.setSetting)).not.toHaveBeenCalled();
  });
});

describe('the pause, where it is not the pause’s own route', () => {
  it('cannot be written through PATCH /v1/install, which would skip the gate and the audit', async () => {
    const response = await fetch(`${bridgeUrl}/v1/install`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workPaused: JSON.stringify({ by: 'janedoe', at: '2026-09-29T10:00:00.000Z' }) }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('/v1/work/pause');
    expect(vi.mocked(settings.setSetting)).not.toHaveBeenCalled();
  });

  it('nor can a repository’s pause', async () => {
    const response = await fetch(`${bridgeUrl}/v1/install`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workPausedRepos: '{}' }),
    });
    expect(response.status).toBe(400);
    expect(vi.mocked(settings.setSetting)).not.toHaveBeenCalled();
  });

  it('nor a seat’s pause, an item’s hold or the unowned issues, which would skip their audit and their resume', async () => {
    for (const [key, route] of [
      ['workPausedSeats', '/v1/crew/<bot>/resume'],
      ['heldItems', '/v1/items/<subject>/resume'],
      ['unownedIssues', '/v1/repos/<repo>/unowned/intake'],
    ] as const) {
      const response = await fetch(`${bridgeUrl}/v1/install`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [key]: '' }),
      });
      expect(response.status, key).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain(route);
    }
    expect(vi.mocked(settings.setSetting)).not.toHaveBeenCalled();
  });

  it('stops a triage from starting again while work is paused', async () => {
    const { registerConsoleApi } = await import('./api.js');
    const { Router } = await import('./router.js');
    const { DispatchGate } = await import('./dispatch-gate.js');
    const gate = new DispatchGate();
    gate.pauseWork('work is paused, by janedoe since 2026-09-29T10:00:00.000Z; resume it in Settings → Pause work');
    const router = new Router();
    registerConsoleApi(router, {
      config: {} as never,
      hostd: {} as never,
      actors: {} as never,
      invitations: {} as never,
      automation: {} as never,
      gates: {} as never,
      taskService: { assertReady, open } as never,
      threadStream: { subscribe: () => () => undefined, watching: 0 } as never,
      onboarding: {} as never,
      webhookSetup: {} as never,
      repoSetup: {} as never,
      dispatchGate: gate,
    });
    const server = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/requests/req-1/triage`, { method: 'POST' });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toMatch(/^nothing new starts: work is paused/);
      expect(open).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('whether setup is complete, as the board asks it', () => {
  it('answers from the walkthrough’s cheap check, and never builds the walkthrough', async () => {
    const { registerConsoleApi } = await import('./api.js');
    const { Router } = await import('./router.js');
    const complete = vi.fn(async () => true);
    const view = vi.fn(async () => ({ complete: false }));
    const router = new Router();
    registerConsoleApi(router, {
      config: {} as never,
      hostd: {} as never,
      actors: {} as never,
      invitations: {} as never,
      automation: {} as never,
      gates: {} as never,
      taskService: {} as never,
      threadStream: { subscribe: () => () => undefined, watching: 0 } as never,
      onboarding: { complete, view } as never,
      webhookSetup: {} as never,
      repoSetup: {} as never,
    });
    const server = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const response = await fetch(`${base}/v1/onboarding/complete`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ complete: true });
      expect(view).not.toHaveBeenCalled();
      // The walkthrough page itself is as it was.
      expect(await (await fetch(`${base}/v1/onboarding?email=op%40example.com`)).json()).toEqual({ complete: false });
      expect(view).toHaveBeenCalledWith('op@example.com');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('holding a pull request an unsigned post was on', () => {
  let server: Server;
  let url: string;
  const labelled: [string, number][] = [];

  beforeEach(async () => {
    const { registerConsoleApi } = await import('./api.js');
    const { Router } = await import('./router.js');
    const { HostdClient } = await import('./hostd-client.js');
    labelled.length = 0;
    vi.mocked(audit).mockClear();
    vi.mocked(repos.getRepoByName).mockImplementation((async (name: string) => (name === 'openadlc-testbed' ? { id: 'repo-1', name, fullName: 'janedoe/openadlc-testbed' } : null)) as never);
    vi.mocked(repos.listRepos).mockImplementation((async () => [{ id: 'repo-1', name: 'openadlc-testbed', fullName: 'janedoe/openadlc-testbed' }]) as never);
    const router = new Router();
    registerConsoleApi(router, {
      config: { automationBot: 'janedoe-openadlc-flow' } as never,
      hostd: new HostdClient('http://127.0.0.1:1', 'secret'),
      actors: {} as never,
      invitations: {} as never,
      automation: {
        holdPull: async (repo: string, n: number) => (labelled.push([repo, n]), { autoMergeOff: true, gate: { state: 'pending', description: 'held' } }),
      } as never,
      gates: {} as never,
      taskService: {} as never,
      threadStream: { subscribe: () => () => undefined, watching: 0 } as never,
      onboarding: {} as never,
      webhookSetup: {} as never,
      repoSetup: {} as never,
    });
    server = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('labels it needs-human, which holds the merge line, and audits who held it', async () => {
    const response = await fetch(`${url}/v1/repos/openadlc-testbed/pulls/31/hold`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(labelled).toEqual([['janedoe/openadlc-testbed', 31]]);
    expect(await response.json()).toEqual({ held: 'janedoe/openadlc-testbed#31', autoMergeOff: true, gate: 'pending' });
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'pull.held', target: 'janedoe/openadlc-testbed#31', payload: expect.objectContaining({ autoMergeOff: true, gate: 'pending' }) }),
    );
  });

  it('finds the repository by its full name, as the card sends it', async () => {
    const response = await fetch(`${url}/v1/repos/${encodeURIComponent('janedoe/openadlc-testbed')}/pulls/31/hold`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(labelled).toEqual([['janedoe/openadlc-testbed', 31]]);
  });

  it('refuses a repository OpenADLC does not work in, and a number that is not one', async () => {
    expect((await fetch(`${url}/v1/repos/elsewhere/pulls/31/hold`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${url}/v1/repos/openadlc-testbed/pulls/abc/hold`, { method: 'POST' })).status).toBe(400);
    expect(labelled).toEqual([]);
  });
});

describe('accepting invitations a person pasted', () => {
  let server: Server;
  let url: string;
  const accepted: unknown[] = [];

  beforeEach(async () => {
    const { registerConsoleApi } = await import('./api.js');
    const { Router } = await import('./router.js');
    const { HostdClient } = await import('./hostd-client.js');
    accepted.length = 0;
    vi.mocked(audit).mockClear();
    const router = new Router();
    registerConsoleApi(router, {
      config: { automationBot: 'janedoe-openadlc-flow' } as never,
      hostd: new HostdClient('http://127.0.0.1:1', 'secret'),
      actors: {} as never,
      invitations: {
        accept: async (pending: { id: number; invitee: string }[]) => {
          accepted.push(...pending);
          return pending.map((one) => ({ bot: one.invitee, invitee: one.invitee, id: one.id, outcome: { action: 'accepted' } }));
        },
      } as never,
      automation: {} as never,
      gates: {} as never,
      taskService: {} as never,
      threadStream: { subscribe: () => () => undefined, watching: 0 } as never,
      onboarding: {} as never,
      webhookSetup: {} as never,
      repoSetup: {} as never,
    });
    server = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('takes one gh output per repository pasted together, and audits each invitation’s own repository', async () => {
    const one = JSON.stringify([{ id: 1, invitee: { login: 'openadlc-atlas' }, repository: { full_name: 'janedoe/api' } }]);
    const two = JSON.stringify([{ id: 2, invitee: { login: 'openadlc-vega' }, repository: { full_name: 'janedoe/site' } }]);
    const response = await fetch(`${url}/v1/invitations/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: `${one}\n${two}`, repo: 'janedoe/api' }),
    });
    // Two outputs were not JSON to one parse, and the answer was "nothing to accept".
    expect(response.status).toBe(200);
    expect(accepted).toHaveLength(2);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'invitations.accepted',
        payload: {
          results: [
            { bot: 'openadlc-atlas', action: 'accepted', repository: 'janedoe/api' },
            { bot: 'openadlc-vega', action: 'accepted', repository: 'janedoe/site' },
          ],
        },
      }),
    );
  });
});

describe('applying a repository’s rules again', () => {
  let server: Server;
  let url: string;
  const applyRules = vi.fn(async () => [{ name: 'environment testing', action: 'created', detail: '' }]);
  const runSoon = vi.fn();

  beforeEach(async () => {
    const { registerConsoleApi } = await import('./api.js');
    const { Router } = await import('./router.js');
    const { HostdClient } = await import('./hostd-client.js');
    applyRules.mockClear();
    runSoon.mockClear();
    vi.mocked(audit).mockClear();
    const router = new Router();
    registerConsoleApi(router, {
      config: {} as never,
      hostd: new HostdClient('http://127.0.0.1:1', 'secret'),
      actors: {} as never,
      invitations: {} as never,
      automation: {} as never,
      gates: {} as never,
      taskService: {} as never,
      threadStream: { subscribe: () => () => undefined, watching: 0 } as never,
      onboarding: {} as never,
      webhookSetup: {} as never,
      repoSetup: { applyRules } as never,
      health: { runSoon } as never,
    });
    server = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = (body: unknown) =>
    fetch(`${url}/v1/repo-setup/rules`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('forgets what the plan refused, and says who asked', async () => {
    const response = await post({ repo: 'exampleco/app', force: true });

    expect(response.status).toBe(200);
    expect(applyRules).toHaveBeenCalledWith('exampleco/app', { force: true });
    expect(vi.mocked(audit)).toHaveBeenCalledWith(expect.objectContaining({ action: 'repo.plan_limits_cleared', target: 'exampleco/app' }));
  });

  it('keeps it on an ordinary apply', async () => {
    await post({ repo: 'exampleco/app' });

    expect(applyRules).toHaveBeenCalledWith('exampleco/app', { force: false });
    expect(vi.mocked(audit)).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'repo.plan_limits_cleared' }));
  });

  it('checks the repository’s files again at once, so a card about a file it just fixed goes', async () => {
    // AGENTS.md naming the template's @owner stayed a card for half an hour
    // after the step had written the approvers in.
    await post({ repo: 'exampleco/app' });
    expect(runSoon).toHaveBeenCalledWith(expect.arrayContaining(['repo-config']));
  });
});

describe('choosing how a repository’s production ships', () => {
  let server: Server;
  let url: string;
  const forget = vi.fn();

  beforeEach(async () => {
    const { registerConsoleApi } = await import('./api.js');
    const { Router } = await import('./router.js');
    const { HostdClient } = await import('./hostd-client.js');
    forget.mockClear();
    vi.mocked(audit).mockClear();
    vi.mocked(repos.setProductionChoice).mockClear();
    vi.mocked(repos.listRepos).mockResolvedValue([{ id: 'repo-1', name: 'app', fullName: 'exampleco/app' }] as never);
    vi.mocked(bots.listBots).mockResolvedValue([...DEFAULT_CREW, { id: 'bot-lead', name: 'sydney', role: 'review_lead', githubLogin: 'openadlc-sydney' }] as never);
    const router = new Router();
    registerConsoleApi(router, {
      config: { organization: 'exampleco', gitHubClientId: '', webhookSecret: '', humans: [] } as never,
      hostd: new HostdClient('http://127.0.0.1:1', 'secret'),
      actors: {} as never,
      invitations: {} as never,
      automation: {} as never,
      gates: {} as never,
      taskService: {} as never,
      threadStream: { subscribe: () => () => undefined, watching: 0 } as never,
      onboarding: {} as never,
      webhookSetup: {} as never,
      repoSetup: {} as never,
      delivery: { get: vi.fn(), forget } as never,
    });
    server = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.mocked(repos.listRepos).mockResolvedValue([{ id: 'repo-1', name: 'openadlc-testbed' }] as never);
    vi.mocked(bots.listBots).mockResolvedValue(DEFAULT_CREW as never);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = (body: unknown) =>
    fetch(`${url}/v1/repo-setup/production`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const said = async (response: Response) => ((await response.json()) as { error?: string }).error ?? '';

  it('records automatic with its soak, forgets the cached rules, and audits it', async () => {
    const response = await post({ repo: 'exampleco/app', approval: 'auto', soakMinutes: 45 });
    expect(response.status).toBe(200);
    expect(repos.setProductionChoice).toHaveBeenCalledWith('repo-1', { approval: 'auto', soakMinutes: 45, reviewers: [] });
    expect(forget).toHaveBeenCalledWith('exampleco/app');
    expect(vi.mocked(audit)).toHaveBeenCalledWith(expect.objectContaining({ action: 'repo.production_choice', target: 'exampleco/app' }));
  });

  it('records the people who approve, by login', async () => {
    expect((await post({ repo: 'exampleco/app', approval: 'reviewers', reviewers: ['@janedoe', 'janedoe'] })).status).toBe(200);
    expect(repos.setProductionChoice).toHaveBeenCalledWith('repo-1', { approval: 'reviewers', soakMinutes: 0, reviewers: ['janedoe'] });
  });

  it('refuses reviewers with nobody named, a crew account or the organization, saying what to do', async () => {
    const nobody = await post({ repo: 'exampleco/app', approval: 'reviewers', reviewers: [] });
    expect(nobody.status).toBe(400);
    expect(await said(nobody)).toContain('name at least one person');

    const bot = await post({ repo: 'exampleco/app', approval: 'reviewers', reviewers: ['openadlc-sydney'] });
    expect(bot.status).toBe(400);
    expect(await said(bot)).toContain('a bot never approves a deploy');

    const org = await post({ repo: 'exampleco/app', approval: 'reviewers', reviewers: ['exampleco'] });
    expect(org.status).toBe(400);
    expect(await said(org)).toContain('is the organization');

    expect(repos.setProductionChoice).not.toHaveBeenCalled();
  });

  it('refuses a soak out of range, an approval it does not know, and a repository OpenADLC does not work in', async () => {
    expect((await post({ repo: 'exampleco/app', approval: 'auto', soakMinutes: 50_000 })).status).toBe(400);
    expect((await post({ repo: 'exampleco/app', approval: 'maybe' })).status).toBe(400);
    expect((await post({ repo: 'exampleco/elsewhere', approval: 'auto' })).status).toBe(404);
  });
});

describe('a crew member’s color, from Settings → Appearance', () => {
  const BUILDER = { id: 'bot-1', name: 'openadlc-atlas-janedoe', slot: 'builder', role: 'implement', color: null };
  const patch = (body: unknown, bot = 'openadlc-atlas-janedoe') =>
    fetch(`${bridgeUrl}/v1/crew/${bot}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    vi.mocked(bots.getBotByName).mockImplementation(async (name: string) => (name === BUILDER.name ? (BUILDER as never) : null));
    vi.mocked(bots.setAppearance).mockReset().mockImplementation(async (_id: string, change: Record<string, unknown>) => ({ ...BUILDER, ...change }) as never);
    vi.mocked(audit).mockClear();
  });

  afterEach(() => {
    vi.mocked(bots.getBotByName).mockReset().mockResolvedValue(null);
  });

  it('stores a name from the palette, and audits who changed it from what', async () => {
    const response = await patch({ color: 'rose' });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { bot: { color: string } }).bot.color).toBe('rose');
    expect(vi.mocked(bots.setAppearance)).toHaveBeenCalledWith('bot-1', { color: 'rose' });
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'bot.color_changed', target: 'openadlc-atlas-janedoe', payload: { color: 'rose', previous: null } }),
    );
  });

  it('goes back to the role’s tint with null', async () => {
    const response = await patch({ color: null });
    expect(response.status).toBe(200);
    expect(vi.mocked(bots.setAppearance)).toHaveBeenCalledWith('bot-1', { color: null });
  });

  it('refuses a color that is not in the palette, and a body that names none, storing nothing', async () => {
    for (const body of [{ color: 'chartreuse' }, { color: '#ff0000' }, { color: 3 }, {}, ['rose']]) {
      const response = await patch(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    const refused = await patch({ color: 'chartreuse' });
    expect(((await refused.json()) as { error: string }).error).toContain('sand, blue, mint, violet, rose, sky, olive, green');
    expect(vi.mocked(bots.setAppearance)).not.toHaveBeenCalled();
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it('says which bot it does not know', async () => {
    const response = await patch({ color: 'rose' }, 'nobody');
    expect(response.status).toBe(404);
    expect(vi.mocked(bots.setAppearance)).not.toHaveBeenCalled();
  });
});

describe('how many tasks a seat runs at once, from Crew', () => {
  const BUILDER = { id: 'bot-1', name: 'openadlc-atlas-janedoe', slot: 'builder', role: 'implement', maxTasks: 1 };
  const patch = (body: unknown, bot = 'openadlc-atlas-janedoe') =>
    fetch(`${bridgeUrl}/v1/crew/${bot}/tasks-at-once`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  beforeEach(() => {
    vi.mocked(bots.getBotByName).mockImplementation(async (name: string) => (name === BUILDER.name ? (BUILDER as never) : null));
    vi.mocked(bots.setMaxTasks).mockReset().mockImplementation(async (_id: string, maxTasks: number) => ({ ...BUILDER, maxTasks }) as never);
    vi.mocked(audit).mockClear();
  });

  afterEach(() => {
    vi.mocked(bots.getBotByName).mockReset().mockResolvedValue(null);
  });

  it('stores the number, and audits who changed it from what', async () => {
    const response = await patch({ maxTasks: 3 });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { bot: { maxTasks: number } }).bot.maxTasks).toBe(3);
    expect(vi.mocked(bots.setMaxTasks)).toHaveBeenCalledWith('bot-1', 3);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'bot.max_tasks_changed', target: 'openadlc-atlas-janedoe', payload: { maxTasks: 3, previous: 1 } }),
    );
  });

  it('refuses anything but a whole number from 1 to 16, storing nothing', async () => {
    for (const body of [{ maxTasks: 0 }, { maxTasks: 17 }, { maxTasks: 2.5 }, { maxTasks: '2' }, {}]) {
      const response = await patch(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(vi.mocked(bots.setMaxTasks)).not.toHaveBeenCalled();
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it('says which bot it does not know', async () => {
    expect((await patch({ maxTasks: 2 }, 'nobody')).status).toBe(404);
  });
});

describe('a crew member’s avatar, from /crew or Settings → Appearance', () => {
  const BUILDER = { id: 'bot-1', name: 'openadlc-atlas-janedoe', slot: 'builder', role: 'implement', engine: 'claude', avatar: null };
  const patch = (body: unknown) =>
    fetch(`${bridgeUrl}/v1/crew/openadlc-atlas-janedoe`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  beforeEach(() => {
    vi.mocked(bots.getBotByName).mockImplementation(async (name: string) => (name === BUILDER.name ? (BUILDER as never) : null));
    vi.mocked(bots.setAppearance).mockReset().mockImplementation(async (_id: string, change: Record<string, unknown>) => ({ ...BUILDER, ...change }) as never);
    vi.mocked(audit).mockClear();
  });

  afterEach(() => {
    vi.mocked(bots.getBotByName).mockReset().mockResolvedValue(null);
  });

  it('stores a design or the initials, and audits it as its own change', async () => {
    for (const avatar of ['initials', 'dots', null]) {
      const response = await patch({ avatar });
      expect(response.status).toBe(200);
      expect(vi.mocked(bots.setAppearance)).toHaveBeenLastCalledWith('bot-1', { avatar });
    }
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'bot.avatar_changed', target: 'openadlc-atlas-janedoe', payload: { avatar: 'initials', previous: null } }),
    );
  });

  it('stores a color and an avatar sent together in one write, and audits each', async () => {
    const response = await patch({ color: 'sky', avatar: 'initials' });
    expect(response.status).toBe(200);
    expect(vi.mocked(bots.setAppearance)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(bots.setAppearance)).toHaveBeenCalledWith('bot-1', { color: 'sky', avatar: 'initials' });
    expect(vi.mocked(audit).mock.calls.map(([entry]) => (entry as { action: string }).action)).toEqual(['bot.color_changed', 'bot.avatar_changed']);
  });

  it('refuses an avatar it does not draw, and stores neither field of a body that has one', async () => {
    for (const body of [{ avatar: 'claude' }, { avatar: 'https://example.com/a.gif' }, { avatar: 1 }, { avatar: 'initials', color: 'chartreuse' }, { color: 'rose', avatar: 'nope' }]) {
      const response = await patch(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    const refused = await patch({ avatar: 'claude' });
    expect(((await refused.json()) as { error: string }).error).toContain('petals, dots, orbit, gear, initials');
    expect(vi.mocked(bots.setAppearance)).not.toHaveBeenCalled();
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });
});

describe('a bot’s sessions, as the screen routes reach hostd', () => {
  const BUILDER = { id: 'bot-1', name: 'openadlc-atlas-janedoe', slot: 'builder', role: 'implement' };

  beforeEach(() => {
    vi.mocked(bots.getBotByName).mockImplementation(async (name: string) => (name === BUILDER.name ? (BUILDER as never) : null));
    vi.mocked(bots.getBotBySlot).mockImplementation(async (slot: string) => (slot === BUILDER.slot ? (BUILDER as never) : null));
  });

  afterEach(() => {
    vi.mocked(bots.getBotByName).mockReset().mockResolvedValue(null);
    vi.mocked(bots.getBotBySlot).mockReset().mockResolvedValue(null);
  });

  it('asks hostd nothing about a bot OpenADLC does not have, such as a path that climbs out', async () => {
    const escape = encodeURIComponent('../../engines/rollback#');
    for (const [method, path] of [
      ['POST', `/v1/sessions/${escape}/x/kill`],
      ['POST', `/v1/bots/${escape}/restart`],
      ['GET', `/v1/sessions/${escape}/x/pane`],
    ] as const) {
      const response = await fetch(`${bridgeUrl}${path}`, {
        method,
        ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
      });
      expect(response.status, path).toBe(404);
    }
    expect(asked).toEqual([]);
  });

  it('asks by the name the bot goes by, when the page still says its seat', async () => {
    const kill = await fetch(`${bridgeUrl}/v1/sessions/builder/main/kill`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(kill.status).toBe(200);
    expect(asked.map((one) => one.url)).toEqual(['/bots/openadlc-atlas-janedoe/sessions/main/kill']);
  });
});

describe('the month’s costs, as the console reads them', () => {
  let server: Server;
  let url: string;
  const ensureBudget = vi.fn(async (period: string) => ({ period, capUsd: 1500, spentUsd: 0, state: 'ok' }));

  beforeEach(async () => {
    const { HostdClient } = await import('./hostd-client.js');
    const { registerConsoleApi } = await import('./api.js');
    const { Router } = await import('./router.js');
    ensureBudget.mockClear();
    Object.assign(costs, {
      currentPeriod: () => '2026-10',
      getBudget: vi.fn(async () => null),
      ensureBudget,
      spendByBot: vi.fn(async () => []),
      spendByRepo: vi.fn(async () => []),
      spendByDay: vi.fn(async () => []),
      listLedger: vi.fn(async () => []),
    });
    const router = new Router();
    registerConsoleApi(router, {
      config: { costs: { monthlyCapUsd: 1500, perTaskCapUsd: 15, warningAt: 0.8 } } as never,
      hostd: new HostdClient('http://127.0.0.1:1', 'secret'),
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
    server = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('makes this month’s budget when there is none', async () => {
    const response = await fetch(`${url}/v1/costs`);
    expect(response.status).toBe(200);
    expect(ensureBudget).toHaveBeenCalledWith('2026-10', 1500, 0.8);
  });

  it('writes no budget for another month a caller names, and refuses one that is not a month', async () => {
    const past = await fetch(`${url}/v1/costs?period=2026-01`);
    expect(past.status).toBe(200);
    expect(((await past.json()) as { budget: unknown }).budget).toBeNull();
    for (const period of ['junk', '2026-13', '2026-1', `${'x'.repeat(500)}`]) {
      expect((await fetch(`${url}/v1/costs?period=${period}`)).status, period).toBe(400);
    }
    expect(ensureBudget).not.toHaveBeenCalled();
  });
});

describe('a bot’s sessions on the crew page', () => {
  const BUILDER = { id: 'bot-1', name: 'openadlc-atlas-janedoe', slot: 'builder', role: 'implement' };
  const SESSION = { id: 's-1', name: 'implement-1', cmd: 'claude', state: 'working', pid: 7, lastLine: 'export GH_TOKEN=ghp_secret', observedAt: '2026-10-04T10:00:00Z' };

  async function asRole(role: 'admin' | 'user') {
    const { HostdClient } = await import('./hostd-client.js');
    const { registerConsoleApi } = await import('./api.js');
    const { Router } = await import('./router.js');
    const router = new Router(undefined, undefined, undefined, async () => role);
    registerConsoleApi(router, {
      config: {} as never,
      hostd: new HostdClient('http://127.0.0.1:1', 'secret'),
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
    const server = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/bots/${BUILDER.name}`);
      return (await response.json()) as { sessions: Record<string, unknown>[] };
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  beforeEach(() => {
    vi.mocked(bots.getBotByName).mockImplementation(async (name: string) => (name === BUILDER.name ? (BUILDER as never) : null));
    Object.assign(sessions, { listSessions: vi.fn(async () => [SESSION]) });
    Object.assign(credentials, { getCredential: vi.fn(async () => null) });
  });

  afterEach(() => {
    vi.mocked(bots.getBotByName).mockReset().mockResolvedValue(null);
  });

  it('leaves out the last line a session printed for a user, which is its screen', async () => {
    const seen = await asRole('user');
    expect(seen.sessions).toEqual([{ id: 's-1', name: 'implement-1', cmd: 'claude', state: 'working', pid: 7, observedAt: '2026-10-04T10:00:00Z' }]);
  });

  it('shows it to an admin, who may watch the screen itself', async () => {
    expect((await asRole('admin')).sessions[0]?.lastLine).toBe('export GH_TOKEN=ghp_secret');
  });
});

describe('whether a bot’s last task landed, as the crew list says it for its thread', () => {
  // #18 merged as #19; #16 is still being built.
  const ISSUE = { repoId: 'repo-1', repoName: 'openadlc-testbed', title: 'Let the board filter by label', labels: [], url: null, updatedAt: '2026-10-04T09:00:00Z' };
  const MERGED = { ...ISSUE, id: 'issue-18', number: 18, stage: 'merged', prNumber: 19 };
  const BUILDING = { ...ISSUE, id: 'issue-16', number: 16, stage: 'build', prNumber: null };
  const CREW = [
    { id: 'bot-builder', name: 'openadlc-atlas-janedoe', slot: 'builder', role: 'implement' },
    { id: 'bot-second-builder', name: 'openadlc-bolt-janedoe', slot: 'second-builder', role: 'implement' },
    { id: 'bot-sre', name: 'openadlc-sre-janedoe', slot: 'sre', role: 'sre' },
  ];
  const failed = (botId: string, kind: string, subjectRef: string) => ({
    id: `task-${botId}`,
    botId,
    repoId: 'repo-1',
    kind,
    subjectRef,
    state: 'failed',
    exitReason: 'engine exited 1',
    branch: null,
    round: 0,
    costUsd: 0.42,
    createdAt: '2026-10-04T09:00:00Z',
    startedAt: '2026-10-04T09:01:00Z',
    endedAt: '2026-10-04T09:30:00Z',
  });
  const LAST = [
    failed('bot-builder', 'implement', 'openadlc-testbed#18'),
    failed('bot-second-builder', 'implement', 'openadlc-testbed#16'),
    // Filed under the merged pull request, where a deploy's work starts.
    failed('bot-sre', 'deploy', 'openadlc-testbed#19'),
  ];

  beforeEach(() => {
    vi.mocked(bots.listBots).mockResolvedValueOnce(CREW as never);
    vi.mocked(issues.listIssues).mockResolvedValue([MERGED, BUILDING] as never);
    vi.mocked(tasks.listTasks).mockImplementation((async (filter: { botId?: string; states?: string[] }) =>
      LAST.filter((task) => task.botId === filter.botId && (filter.states ?? []).includes(task.state))) as never);
    Object.assign(sessions, { listSessions: vi.fn(async () => []) });
    Object.assign(credentials, { getCredential: vi.fn(async () => ({ status: 'active', tokenExpiresAt: null })) });
  });

  afterEach(() => {
    vi.mocked(issues.listIssues).mockReset();
  });

  async function lastTasks(): Promise<Record<string, { landed?: boolean } | null>> {
    const body = (await (await fetch(`${bridgeUrl}/v1/bots`)).json()) as { bots: { name: string; lastTask: { landed?: boolean } | null }[] };
    return Object.fromEntries(body.bots.map((bot) => [bot.name, bot.lastTask]));
  }

  it('says a build that failed on an issue that merged since has landed', async () => {
    expect((await lastTasks())['openadlc-atlas-janedoe']).toMatchObject({ kind: 'implement', state: 'failed', landed: true });
  });

  it('says a build that failed on an issue still in Build has not', async () => {
    expect((await lastTasks())['openadlc-bolt-janedoe']).toMatchObject({ kind: 'implement', state: 'failed', landed: false });
  });

  it('says a deploy that failed on a merged issue has not, since the merge is where its work starts', async () => {
    expect((await lastTasks())['openadlc-sre-janedoe']).toMatchObject({ kind: 'deploy', state: 'failed', issue: { number: 18 }, landed: false });
  });
});

describe('who stopped a bot’s last task, as the crew list says it for its thread', () => {
  const CREW = [
    { id: 'bot-lead', name: 'openadlc-lead-janedoe', slot: 'lead-reviewer', role: 'review_lead' },
    { id: 'bot-second', name: 'openadlc-second-janedoe', slot: 'second-reviewer', role: 'review_second' },
    { id: 'bot-builder', name: 'openadlc-atlas-janedoe', slot: 'builder', role: 'implement' },
  ];
  const stopped = (botId: string, exitReason: string) => ({
    id: `task-${botId}`,
    botId,
    repoId: 'repo-1',
    kind: 'review',
    subjectRef: 'openadlc-testbed#19',
    state: 'stopped',
    exitReason,
    branch: null,
    round: 1,
    costUsd: 0.2,
    createdAt: '2026-10-22T09:00:00Z',
    startedAt: '2026-10-22T09:01:00Z',
    endedAt: '2026-10-22T09:30:00Z',
  });
  const LAST = [
    stopped('bot-lead', 'stopped by the bridge: its pull request merged'),
    // As a bridge before it recorded its own stops.
    stopped('bot-second', 'stopped by a person from the console (bridge): its pull request closed'),
    stopped('bot-builder', 'stopped by a person from the console (janedoe@example.com): taking it over'),
  ];

  beforeEach(() => {
    vi.mocked(bots.listBots).mockResolvedValueOnce(CREW as never);
    vi.mocked(issues.listIssues).mockResolvedValue([] as never);
    vi.mocked(tasks.listTasks).mockImplementation((async (filter: { botId?: string; states?: string[] }) =>
      LAST.filter((task) => task.botId === filter.botId && (filter.states ?? []).includes(task.state))) as never);
    // A review's summary counts the fixes its round answers.
    Object.assign(tasks, { listTasksForSubjects: vi.fn(async () => []) });
    Object.assign(sessions, { listSessions: vi.fn(async () => []) });
    Object.assign(credentials, { getCredential: vi.fn(async () => ({ status: 'active', tokenExpiresAt: null })) });
  });

  afterEach(() => {
    vi.mocked(issues.listIssues).mockReset();
    delete (tasks as { listTasksForSubjects?: unknown }).listTasksForSubjects;
  });

  async function lastTasks(): Promise<Record<string, { stoppedByAPerson?: boolean; stoppedByTheBridge?: boolean } | null>> {
    const body = (await (await fetch(`${bridgeUrl}/v1/bots`)).json()) as { bots: { name: string; lastTask: { stoppedByAPerson?: boolean } | null }[] };
    return Object.fromEntries(body.bots.map((bot) => [bot.name, bot.lastTask]));
  }

  it('does not count a stop the bridge made, when a pull request merged or closed, as a person’s', async () => {
    const last = await lastTasks();
    expect(last['openadlc-lead-janedoe']).toMatchObject({ state: 'stopped', stoppedByAPerson: false, stoppedByTheBridge: true });
    expect(last['openadlc-second-janedoe']).toMatchObject({ state: 'stopped', stoppedByAPerson: false, stoppedByTheBridge: true });
  });

  it('still counts a person’s Stop as theirs', async () => {
    expect((await lastTasks())['openadlc-atlas-janedoe']).toMatchObject({ state: 'stopped', stoppedByAPerson: true, stoppedByTheBridge: false });
  });
});

describe('what intake does next, on the crew page', () => {
  it('is the oldest request still tried, not one the queue gave up on', async () => {
    // A request the queue stopped trying waits for a person's Try again, in
    // Needs you; named as intake's next, it sat there as if it would start.
    const { queueOf } = await import('./api.js');
    stored.requests = [
      { id: 'aaaaaaaa-1111', state: 'queued', createdAt: '2026-10-04T09:00:00Z', text: 'Add a header', queueAttempts: 5, queueReason: 'intake is not ready' },
      { id: 'bbbbbbbb-2222', state: 'queued', createdAt: '2026-10-04T09:05:00Z', text: 'Add a footer\nWith the year', queueAttempts: 1, queueReason: 'no such repository' },
    ];

    const queue = await queueOf({ role: 'intake' }, [], new Set(), () => null);

    expect(queue.next).toEqual({ ref: 'request:bbbbbbbb', title: 'Add a footer' });
    stored.requests = [];
  });
});

describe('rotating the key the crew’s posts are signed with', () => {
  const rotate = vi.fn(async (options: { dropOld?: boolean }) => ({
    kid: 'newkid01',
    retiredKid: 'oldkid01',
    checksUntil: options.dropOld ? null : '2026-11-03T00:00:00.000Z',
  }));

  async function serve(attribution: unknown): Promise<{ url: string; close: () => Promise<void> }> {
    const { registerConsoleApi } = await import('./api.js');
    const { Router } = await import('./router.js');
    const { HostdClient } = await import('./hostd-client.js');
    const { authorize } = await import('./roles.js');
    const people: Record<string, 'admin' | 'user'> = { 'admin@exampleco.test': 'admin', 'user@exampleco.test': 'user' };
    const lookup = { roleOf: async (identity: string) => people[identity] ?? null, admins: async () => ['admin@exampleco.test'], refused: async () => undefined };
    const router = new Router(undefined, undefined, undefined, (method, path, identity) => authorize(lookup, method, path, identity));
    registerConsoleApi(router, {
      config: {} as never,
      hostd: new HostdClient('http://127.0.0.1:1', 'secret'),
      actors: {} as never,
      invitations: {} as never,
      automation: {} as never,
      gates: {} as never,
      taskService: {} as never,
      threadStream: { subscribe: () => () => undefined, watching: 0 } as never,
      onboarding: {} as never,
      webhookSetup: {} as never,
      repoSetup: {} as never,
      attribution: attribution as never,
    });
    const server = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  const call = (url: string, identity: string, body?: unknown) =>
    fetch(`${url}/v1/attribution/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openadlc-identity': identity },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeEach(() => {
    rotate.mockClear();
    vi.mocked(audit).mockClear();
  });

  it('is refused to a user', async () => {
    const bridge = await serve({ rotate });
    try {
      expect((await call(bridge.url, 'user@exampleco.test')).status).toBe(403);
      expect(rotate).not.toHaveBeenCalled();
      expect(vi.mocked(audit)).not.toHaveBeenCalled();
    } finally {
      await bridge.close();
    }
  });

  it('rotates for an admin and records who did it, by key id only', async () => {
    const bridge = await serve({ rotate });
    try {
      const routine = await call(bridge.url, 'admin@exampleco.test');
      expect(routine.status).toBe(200);
      expect(await routine.json()).toEqual({ kid: 'newkid01', retiredKid: 'oldkid01', oldKeyChecksUntil: '2026-11-03T00:00:00.000Z' });
      expect(rotate).toHaveBeenLastCalledWith({ dropOld: false });
      expect(vi.mocked(audit)).toHaveBeenLastCalledWith({
        actor: 'admin@exampleco.test',
        action: 'attribution.rotated',
        target: 'install',
        payload: { kid: 'newkid01', retiredKid: 'oldkid01', droppedOld: false },
      });

      const leak = await call(bridge.url, 'admin@exampleco.test', { dropOld: true });
      expect(await leak.json()).toEqual({ kid: 'newkid01', retiredKid: 'oldkid01', oldKeyChecksUntil: null });
      expect(rotate).toHaveBeenLastCalledWith({ dropOld: true });
      expect(vi.mocked(audit)).toHaveBeenLastCalledWith(expect.objectContaining({ payload: { kid: 'newkid01', retiredKid: 'oldkid01', droppedOld: true } }));

      expect((await call(bridge.url, 'admin@exampleco.test', { dropOld: 'yes' })).status).toBe(400);
    } finally {
      await bridge.close();
    }
  });

  it('says so where the bridge signs nothing', async () => {
    const bridge = await serve(undefined);
    try {
      const response = await call(bridge.url, 'admin@exampleco.test');
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'this bridge signs nothing' });
    } finally {
      await bridge.close();
    }
  });
});

/**
 * Only an admin's "continue" at a cost cap goes past a spent monthly cap
 * (`Gates.answer`), so each console route that answers a gate passes on the
 * role the router gave the person. The item route's is in item-routes.test.ts.
 */
describe('the console role reaching a gate answer', () => {
  async function answerAs(role: 'admin' | 'user', path: string, body: Record<string, unknown>) {
    const { HostdClient } = await import('./hostd-client.js');
    const { registerConsoleApi } = await import('./api.js');
    const { Router } = await import('./router.js');
    const answers: Record<string, unknown>[] = [];
    const router = new Router(undefined, undefined, undefined, async () => role);
    registerConsoleApi(router, {
      config: {} as never,
      hostd: new HostdClient('http://127.0.0.1:1', 'secret'),
      actors: {} as never,
      invitations: {} as never,
      automation: {} as never,
      gates: {
        answer: async (input: Record<string, unknown>) => {
          answers.push(input);
          // As `Gates.answer` does where it claims the gate, whatever the route.
          await audit({ actor: String(input.answeredBy), action: 'gate.answer', target: String(input.gateId), payload: { channel: input.via } });
          return { answer: String(input.reply), taskId: null, held: true };
        },
      } as never,
      taskService: {} as never,
      threadStream: { subscribe: () => () => undefined, watching: 0 } as never,
      onboarding: {} as never,
      webhookSetup: {} as never,
      repoSetup: {} as never,
    });
    const server = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      return answers;
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  // The route wrote its own row as well as the one `Gates` writes, so every
  // answer from the console's gate route was audited twice.
  it('is audited once from the gate answer route, by Gates, as the console gate', async () => {
    vi.mocked(audit).mockClear();

    expect(await answerAs('user', '/v1/gates/gate-1/answer', { answer: '1' })).toEqual([expect.objectContaining({ via: 'console-gate' })]);

    const rows = vi.mocked(audit).mock.calls.filter(([entry]) => entry.action === 'gate.answer');
    expect(rows).toHaveLength(1);
  });

  it('passes it from the gate answer route', async () => {
    expect(await answerAs('user', '/v1/gates/gate-1/answer', { answer: '1' })).toEqual([expect.objectContaining({ gateId: 'gate-1', role: 'user' })]);
    expect(await answerAs('admin', '/v1/gates/gate-1/answer', { answer: '1' })).toEqual([expect.objectContaining({ role: 'admin' })]);
  });

  it("passes it from a bot panel's message that answers the open question", async () => {
    vi.mocked(bots.getBotByName).mockResolvedValue({ id: 'bot-intake', name: 'ottoexampleco' } as never);
    vi.mocked(threads.listOpenGates).mockResolvedValue([{ id: 'gate-1', taskId: 'task-1' }] as never);
    vi.mocked(tasks.getTask).mockResolvedValue({ id: 'task-1', botId: 'bot-intake', subjectRef: 'openadlc-testbed#5' } as never);
    try {
      expect(await answerAs('user', '/v1/threads/ottoexampleco/messages', { text: '1', subject: 'openadlc-testbed#5' })).toEqual([
        expect.objectContaining({ gateId: 'gate-1', role: 'user', via: 'thread' }),
      ]);
    } finally {
      vi.mocked(bots.getBotByName).mockResolvedValue(null);
      vi.mocked(threads.listOpenGates).mockResolvedValue([]);
      vi.mocked(tasks.getTask).mockResolvedValue(null);
    }
  });
});

describe('a refusal says what to do', () => {
  it('refuses a request with no intake seat as the crew’s to change, and says how', async () => {
    vi.mocked(bots.listBots).mockResolvedValueOnce([] as never);
    const response = await fetch(`${bridgeUrl}/v1/requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Add a dark mode' }),
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe(
      'no intake bot is configured; add an intake seat to config/bots.yaml and run openadlc up',
    );
  });

  it('asks for the bot by its query parameter', async () => {
    const response = await fetch(`${bridgeUrl}/v1/github/suggest-login`);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('say which bot: ?bot=<seat>');
  });
});

/**
 * A console action answers once its decision is in the database, and what is
 * left — GitHub's comment and label, hostd's resume or start — runs after.
 * An answer to #27's builder took 30 seconds on a live install, and the
 * person pressed Approve again and again while nothing changed.
 */
describe('a console action, answered before GitHub and hostd', () => {
  describe('an answer to a question', () => {
    const TASK = {
      id: 'task-27',
      botId: 'bot-builder',
      kind: 'implement',
      state: 'paused',
      subjectRef: 'openadlc#27',
      repoId: 'repo-openadlc',
      leaseId: 'lease-27',
      branch: 'agent/builder/27-issue-27',
      createdAt: '2026-10-22T00:00:00.000Z',
    };
    let gate: Record<string, unknown>;
    let release: () => void;
    let order: string[];
    const comment = vi.fn();
    const removeLabel = vi.fn(async () => void order.push('needs-human off'));
    const resume = vi.fn(async (taskId: string) => void order.push(`resume ${taskId}`));
    let server: Server;
    let url: string;

    beforeEach(async () => {
      order = [];
      gate = { id: 'gate-27', taskId: 'task-27', threadId: 'thread-27', question: 'Per round or per task?', options: ['per round', 'per task'], state: 'open', answer: null, answeredBy: null, addedNeedsHuman: true };
      vi.mocked(threads.getGate).mockImplementation(async () => ({ ...gate }) as never);
      vi.mocked(threads.answerGate).mockImplementation((async (_id: string, answer: string, answeredBy: string) => {
        if (gate.state !== 'open') return null;
        gate = { ...gate, state: 'answered', answer, answeredBy };
        return { ...gate };
      }) as never);
      vi.mocked(tasks.getTask).mockImplementation(async () => ({ ...TASK }) as never);
      vi.mocked(repos.listRepos).mockImplementation((async () => [{ id: 'repo-openadlc', name: 'openadlc', fullName: 'janedoe/openadlc' }]) as never);
      vi.mocked(bots.getBotById).mockImplementation(async () => ({ id: 'bot-builder', name: 'builder' }) as never);
      vi.mocked(threads.listOpenGatesOnSubject).mockImplementation(async () => [{ ...gate }] as never);
      // GitHub's comment takes as long as the test says.
      comment.mockReset().mockImplementation(
        () =>
          new Promise((resolve) => {
            release = () => {
              order.push('answer posted');
              resolve({ htmlUrl: 'https://github.com/janedoe/openadlc/issues/27#issuecomment-1' });
            };
          }),
      );
      removeLabel.mockClear();
      resume.mockClear();
      asBot.mockReset().mockImplementation(async () => ({ getIssue: async () => ({ state: 'open', labels: ['needs-human'] }), comment, removeLabel }));

      const { HostdClient } = await import('./hostd-client.js');
      const { registerConsoleApi } = await import('./api.js');
      const { Gates } = await import('./gates.js');
      const { Router } = await import('./router.js');
      const router = new Router();
      registerConsoleApi(router, {
        afterwards,
        config: {} as never,
        hostd: new HostdClient('http://127.0.0.1:1', 'secret'),
        actors: { asBot } as never,
        invitations: {} as never,
        automation: {} as never,
        gates: new Gates({ asBot } as never),
        taskService: { resume } as never,
        threadStream: { subscribe: () => () => undefined, watching: 0 } as never,
        onboarding: {} as never,
        webhookSetup: {} as never,
        repoSetup: {} as never,
      });
      server = createServer((request, response) => void router.handle(request, response));
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
      release?.();
      await afterwards.settled();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    /** The route's answer, or `waiting` when it is still waiting after a second. */
    const answer = async (text: string): Promise<{ status: number; body: Record<string, unknown> } | 'waiting'> => {
      const asked = fetch(`${url}/v1/gates/gate-27/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer: text }),
      }).then(async (response) => ({ status: response.status, body: (await response.json()) as Record<string, unknown> }));
      return Promise.race([asked, new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 1000))]);
    };

    it('answers once the question is claimed, before its comment is on GitHub, and resumes the task after it', async () => {
      const answered = await answer('per round');

      expect(answered).toEqual({ status: 200, body: { answer: 'per round', taskId: 'task-27' } });
      // The answer is the record: in the thread already, as the person's.
      expect(vi.mocked(threads.addMessage)).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-27', kind: 'you', text: 'per round' }));
      await vi.waitFor(() => expect(comment).toHaveBeenCalledTimes(1));
      expect(resume).not.toHaveBeenCalled();

      release();
      await afterwards.settled();
      // A resumed session reads the answer from the issue, so it goes on once that is posted.
      expect(order).toEqual(['answer posted', 'needs-human off', 'resume task-27']);
    });

    it('says in the thread what GitHub would not take after the answer, and still goes on', async () => {
      comment.mockReset().mockRejectedValue(new Error('GitHub answered 502'));

      expect(await answer('per round')).toMatchObject({ status: 200 });
      await afterwards.settled();

      expect(vi.mocked(threads.addMessage)).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: 'thread-27', kind: 'sys', text: expect.stringContaining('the answer was not posted'), note: 'GitHub answered 502' }),
      );
      expect(resume).toHaveBeenCalledWith('task-27');
    });

    it('takes the same answer pressed twice as the one it gave, and posts and resumes once', async () => {
      expect(await answer('per round')).toMatchObject({ status: 200 });
      release();
      await afterwards.settled();

      expect(await answer('per round')).toEqual({ status: 200, body: { answer: 'per round', taskId: null, again: true } });
      await afterwards.settled();

      expect(comment).toHaveBeenCalledTimes(1);
      expect(resume).toHaveBeenCalledTimes(1);
    });

    it('says an answer stopped its task, when it did, so the card does not say it goes on', async () => {
      // An answer on work whose issue has closed stops the task instead.
      let state = 'paused';
      vi.mocked(tasks.getTask).mockImplementation(async () => ({ ...TASK, state }) as never);
      vi.mocked(tasks.updateTaskState).mockImplementation((async (_id: string, to: string) => ((state = to), { ...TASK, state })) as never);
      asBot.mockReset().mockImplementation(async () => ({ getIssue: async () => ({ state: 'closed', labels: [] }), comment: vi.fn(async () => ({ htmlUrl: 'u' })), removeLabel }));

      expect(await answer('per round')).toEqual({ status: 200, body: { answer: 'per round', taskId: 'task-27', ended: true } });
    });

    it('refuses another answer to a question already answered, saying who answered it', async () => {
      expect(await answer('per round')).toMatchObject({ status: 200 });

      const other = await answer('per task');

      expect(other).toMatchObject({ status: 409, body: { error: expect.stringContaining('that question was answered already') } });
    });
  });

  describe('Try again', () => {
    const FAILED_REVIEW = {
      id: 'task-31',
      botId: 'bot-iris',
      kind: 'review',
      state: 'failed',
      subjectType: 'pr',
      subjectRef: 'openadlc#31',
      repoId: 'repo-openadlc',
      leaseId: null,
      branch: 'agent/builder/27-issue-27',
      skill: 'pr-review',
      createdAt: '2026-10-22T00:00:00.000Z',
    };
    let onSubject: Record<string, unknown>[];
    let started: () => void;

    beforeEach(() => {
      onSubject = [{ ...FAILED_REVIEW }];
      vi.mocked(tasks.getTask).mockImplementation(async () => ({ ...FAILED_REVIEW }) as never);
      vi.mocked(tasks.listTasksOnSubjects).mockImplementation(async () => onSubject as never);
      vi.mocked(bots.getBotById).mockImplementation(async () => ({ id: 'bot-iris', name: 'irisexampleco' }) as never);
      vi.mocked(repos.listRepos).mockImplementation((async () => [{ id: 'repo-openadlc', name: 'openadlc', fullName: 'janedoe/openadlc' }]) as never);
      vi.mocked(audit).mockClear();
      // The row is recorded at once; reading its context and hostd's start
      // take as long as the test says.
      open.mockReset().mockImplementation(async (input: Record<string, unknown>) => {
        (input.recorded as (task: { taskId: string; bot: string }) => void)({ taskId: 'task-90', bot: 'irisexampleco' });
        await new Promise<void>((resolve) => (started = resolve));
        return { taskId: 'task-90', session: 's' };
      });
    });

    const retry = () => fetch(`${bridgeUrl}/v1/tasks/task-31/retry`, { method: 'POST' });
    const retried = () => vi.mocked(audit).mock.calls.filter(([entry]) => entry.action === 'task.retried');

    it('answers once the new task is recorded, before hostd has started it', async () => {
      const response = await retry();

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ retried: 'task-31', task: { taskId: 'task-90', session: null }, bot: 'irisexampleco', starting: true });
      expect(retried()).toEqual([]);

      started();
      await afterwards.settled();
      expect(retried()).toEqual([[expect.objectContaining({ payload: expect.objectContaining({ retried: 'task-31', task: 'task-90' }) })]]);
    });

    it('says in the thread when the start fails after the answer', async () => {
      open.mockReset().mockImplementation(async (input: Record<string, unknown>) => {
        (input.recorded as (task: { taskId: string; bot: string }) => void)({ taskId: 'task-90', bot: 'irisexampleco' });
        throw new Error('irisexampleco was not started: every host is running all the tasks it has room for');
      });

      expect((await retry()).status).toBe(200);
      await afterwards.settled();

      expect(vi.mocked(threads.addMessage)).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'sys', text: 'Starting it again did not finish', note: expect.stringContaining('every host is running all the tasks') }),
      );
    });

    it('still refuses before it answers', async () => {
      stored.intakeBusy = true;

      const response = await retry();

      expect(response.status).toBe(409);
      expect(open).not.toHaveBeenCalled();
    });

    it('writes a build’s lease in a task and its one continuation before it answers, so a crash after loses neither', async () => {
      // Without the claim, a bridge that ended after the answer let the sweep
      // give a build gone on from its branch a third try.
      const { retryDepsFor } = await import('./api.js');
      const { startBuild } = await import('./build-start.js');
      vi.mocked(startBuild).mockImplementationOnce(async (deps, input) => deps.taskService.open({ bot: 'builder', kind: 'implement', branch: input.continueBranch } as never));
      let answered: (row: { taskId: string; bot: string }) => void = () => undefined;
      const told = new Promise<{ taskId: string; bot: string }>((resolve) => (answered = resolve));
      const deps = retryDepsFor({ taskService: { open } as never, automation: {} as never }, answered);

      const building = deps.startBuild({ leaseId: 'lease-9', continueBranch: 'agent/builder/9-issue-9' } as never);
      expect(await told).toEqual({ taskId: 'task-90', bot: 'irisexampleco' });

      expect(vi.mocked(leases.setLeaseState)).toHaveBeenCalledWith('lease-9', 'in_task');
      expect(vi.mocked(tasks.claimAutoRetry)).toHaveBeenCalledWith('task-90');
      started();
      await building;
    });

    it('starts nothing twice when pressed twice', async () => {
      expect((await retry()).status).toBe(200);
      onSubject = [{ ...FAILED_REVIEW }, { ...FAILED_REVIEW, id: 'task-90', state: 'queued' }];

      const again = await retry();

      expect(again.status).toBe(409);
      expect(open).toHaveBeenCalledTimes(1);
      started();
    });
  });
});
