import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Try again" on a failed or stopped task's card: the same work, by the same
 * bot, on the same subject — refused while that work is already going, or the
 * bot is busy with something else.
 */

interface TaskRow {
  id: string;
  botId: string;
  repoId: string | null;
  kind: string;
  subjectType: string;
  subjectRef: string;
  leaseId: string | null;
  state: string;
  skill: string | null;
  branch: string | null;
  round: number;
  createdAt: string;
  exitReason?: string | null;
}

const store = vi.hoisted(() => ({
  tasks: [] as TaskRow[],
  leases: [] as { id: string; repoId: string; issueNumber: number; botId: string; declaredPaths: string[]; state: string; expiresAt: string | null; prNumber: number | null }[],
  issuePr: null as number | null,
  audits: [] as { action: string; payload?: Record<string, unknown> }[],
  released: [] as string[],
  /** Tasks claimed as a retry OpenADLC made by itself; see `claimAutoRetry`. */
  claimed: [] as string[],
  /** Where each commit's authorisation past a cap stands, as its newest audit row says. */
  revert: {} as Record<string, { state: 'held' | 'spent'; taskId: string }>,
  /** The console request the intake tasks here were triaging. */
  request: { id: 'a4b02784-1111-2222-3333-444444444444', state: 'draft', repoId: null as string | null, issueNumber: null as number | null, createdAt: '2026-09-25T09:00:00.000Z' },
  /** Platform events, as `listEventsOfTypeWith` answers: a conflict resolution round's. */
  events: [] as { type: string; at: string; payload: unknown }[],
}));

vi.mock('@fleetadlc/db', () => {
  const BOTS = [
    { id: 'bot-lead', name: 'noraexampleco', slot: 'lead-reviewer', role: 'review_lead', githubLogin: 'noraexampleco' },
    { id: 'bot-builder', name: 'fleetadlc-atlas-janedoe', slot: 'builder', role: 'implement', githubLogin: 'fleetadlc-atlas-janedoe' },
    { id: 'bot-intake', name: 'ottoexampleco', slot: 'intake', role: 'intake', githubLogin: 'ottoexampleco' },
  ];
  const REPO = { id: 'repo-1', name: 'fleetadlc-testbed', fullName: 'janedoe/fleetadlc-testbed', defaultBranch: 'main', stageModes: {} };
  return {
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
      spendHeldRevert: vi.fn(async (subjectRef: string, taskId: string) => {
        const row = store.revert[subjectRef];
        if (row?.state !== 'held' || row.taskId !== taskId) return false;
        store.revert[subjectRef] = { state: 'spent', taskId };
        return true;
      }),
      holdRevert: vi.fn(async (subjectRef: string, taskId: string, from?: string) => {
        const row = store.revert[subjectRef];
        if (row?.state !== 'spent' || row.taskId !== from || taskId !== from) return false;
        store.revert[subjectRef] = { state: 'held', taskId };
        return true;
      }),
    },

    AccountInUse: class AccountInUse extends Error {},
    audit: vi.fn(async (entry: { action: string; payload?: Record<string, unknown> }) => {
      store.audits.push(entry);
    }),
    bots: {
      getBotById: vi.fn(async (id: string) => BOTS.find((bot) => bot.id === id) ?? null),
      listBots: vi.fn(async () => BOTS),
    },
    costs: {},
    credentials: {},
    issues: {
      getIssue: vi.fn(async (_repoId: string, number: number) => ({
        number,
        title: 'Add a health endpoint',
        declaredPaths: ['apps/api/'],
        prNumber: store.issuePr,
      })),
    },
    lastGithubDelivery: vi.fn(async () => null),
    leases: {
      getActiveLease: vi.fn(async (_repoId: string, number: number) =>
        store.leases.find((lease) => lease.issueNumber === number && ['leased', 'in_task', 'paused'].includes(lease.state)) ?? null,
      ),
      getLease: vi.fn(async (id: string) => store.leases.find((lease) => lease.id === id) ?? null),
      createLease: vi.fn(async (input: { repoId: string; issueNumber: number; botId: string; declaredPaths: string[]; expiresAt: Date }) => {
        const lease = { id: `lease-${store.leases.length + 1}`, ...input, state: 'leased', expiresAt: input.expiresAt.toISOString(), prNumber: null };
        store.leases.push(lease);
        return lease;
      }),
      setLeaseState: vi.fn(async (id: string, state: string) => {
        const lease = store.leases.find((one) => one.id === id);
        if (lease) lease.state = state;
        if (state === 'released') store.released.push(id);
        return lease ?? null;
      }),
    },
    listAudit: vi.fn(async () => []),
    listEventsOfType: vi.fn(async () => []),
    listEventsOfTypeWith: vi.fn(async (type: string) => store.events.filter((event) => event.type === type)),
    markEventProcessed: vi.fn(),
    mergeLines: {},
    modelAccounts: { list: vi.fn(async () => []) },
    recordEvent: vi.fn(),
    repos: {
      listRepos: vi.fn(async () => [REPO]),
      getRepoByName: vi.fn(async (name: string) => (name === REPO.name ? REPO : null)),
    },
    requests: {
      findRequestByPrefix: vi.fn(async (prefix: string) => (prefix === 'a4b02784' ? { id: 'a4b02784-1111-2222-3333-444444444444' } : null)),
      getRequest: vi.fn(async (id: string) => (id === store.request.id ? { ...store.request } : null)),
      listRequests: vi.fn(async () => []),
      queueAgain: vi.fn(async (id: string) => {
        if (id !== store.request.id || !['draft', 'questions'].includes(store.request.state)) return null;
        store.request.state = 'queued';
        return { ...store.request };
      }),
      listQueued: vi.fn(async () => (store.request.state === 'queued' ? [{ ...store.request }] : [])),
      claimQueued: vi.fn(async (id: string) => {
        if (id !== store.request.id || store.request.state !== 'queued') return null;
        store.request.state = 'draft';
        return { ...store.request };
      }),
      requeue: vi.fn(async () => undefined),
    },
    withAdvisoryLock: vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
    sessions: {},
    settings: { allSettings: vi.fn(async () => ({})) },
    tasks: {
      getTask: vi.fn(async (id: string) => store.tasks.find((task) => task.id === id) ?? null),
      listTasksOnSubjects: vi.fn(async (refs: string[]) => store.tasks.filter((task) => refs.includes(task.subjectRef))),
      countActiveTasksForBot: vi.fn(
        async (botId: string) => store.tasks.filter((task) => task.botId === botId && ['queued', 'running', 'paused'].includes(task.state)).length,
      ),
      seatHasRoom: vi.fn(
        async (botId: string) => store.tasks.filter((task) => task.botId === botId && ['queued', 'running', 'paused'].includes(task.state)).length < 1,
      ),
      claimAutoRetry: vi.fn(async (id: string) => {
        store.claimed.push(id);
        return true;
      }),
    },
    threads: {},
  };
});

function task(partial: Partial<TaskRow> & Pick<TaskRow, 'id' | 'botId' | 'kind' | 'subjectRef' | 'state'>): TaskRow {
  return {
    repoId: 'repo-1',
    subjectType: 'issue',
    leaseId: null,
    skill: null,
    branch: null,
    round: 0,
    createdAt: '2026-09-25T10:00:00.000Z',
    ...partial,
  };
}

const opened: Record<string, unknown>[] = [];
const builds: Record<string, unknown>[] = [];
const triages: string[] = [];

async function deps() {
  return {
    taskService: {
      open: vi.fn(async (input: Record<string, unknown>) => {
        opened.push(input);
        return { taskId: 'task-new', session: 'fleetadlc-1' };
      }),
    },
    startBuild: vi.fn(async (input: Record<string, unknown>) => {
      builds.push(input);
      return { taskId: 'task-build', session: 'fleetadlc-2' };
    }),
    startTriage: vi.fn(async (requestId: string) => {
      triages.push(requestId);
      return { task: { taskId: 'task-triage', session: 'fleetadlc-3' }, bot: 'ottoexampleco' };
    }),
    leaseHours: 12,
  };
}

beforeEach(() => {
  store.tasks = [];
  store.leases = [];
  store.issuePr = null;
  store.audits = [];
  store.released = [];
  store.claimed = [];
  store.revert = {};
  opened.length = 0;
  builds.length = 0;
  triages.length = 0;
});

describe('trying a failed task again', () => {
  it('reviews again: the same reviewer, the same pull request, on its branch, with the issue it closes', async () => {
    const { retryTask } = await import('./task-retry.js');
    store.tasks = [
      task({
        id: 'task-review',
        botId: 'bot-lead',
        kind: 'review',
        subjectType: 'pr',
        subjectRef: 'fleetadlc-testbed#2',
        state: 'failed',
        skill: 'pr-review',
        branch: 'agent/fleetadlc-atlas-janedoe/1-issue-1',
      }),
    ];

    const retried = await retryTask('task-review', 'janedoe', await deps());

    expect(retried).toMatchObject({ retried: 'task-review', bot: 'noraexampleco', task: { taskId: 'task-new' } });
    expect(opened).toEqual([
      {
        bot: 'noraexampleco',
        botId: 'bot-lead',
        repo: 'fleetadlc-testbed',
        kind: 'review',
        subjectType: 'pr',
        subjectRef: 'fleetadlc-testbed#2',
        skill: 'pr-review',
        branch: 'agent/fleetadlc-atlas-janedoe/1-issue-1',
        issueNumber: 1,
        checkoutExistingBranch: true,
        round: 0,
      },
    ]);
    expect(store.audits.at(-1)).toMatchObject({ action: 'task.retried', payload: { retried: 'task-review', task: 'task-new' } });
  });

  it('builds again under a lease it takes for the same builder, the way the dispatcher does', async () => {
    const { retryTask } = await import('./task-retry.js');
    store.tasks = [task({ id: 'task-build-failed', botId: 'bot-builder', kind: 'implement', subjectRef: 'fleetadlc-testbed#1', state: 'failed' })];

    await retryTask('task-build-failed', 'janedoe', await deps());

    expect(store.leases).toMatchObject([{ id: 'lease-1', issueNumber: 1, botId: 'bot-builder', declaredPaths: ['apps/api/'] }]);
    expect(builds).toEqual([
      {
        leaseId: 'lease-1',
        repo: expect.objectContaining({ name: 'fleetadlc-testbed', fullName: 'janedoe/fleetadlc-testbed' }),
        issue: 1,
        bot: expect.objectContaining({ id: 'bot-builder', name: 'fleetadlc-atlas-janedoe' }),
        declaredPaths: ['apps/api/'],
        expiresAt: expect.any(String),
      },
    ]);
  });

  it('keeps the builder’s own lease when it still holds one, and refuses one another bot holds', async () => {
    const { retryTask } = await import('./task-retry.js');
    store.tasks = [task({ id: 'task-build-failed', botId: 'bot-builder', kind: 'implement', subjectRef: 'fleetadlc-testbed#1', state: 'failed' })];
    store.leases = [{ id: 'lease-held', repoId: 'repo-1', issueNumber: 1, botId: 'bot-builder', declaredPaths: [], state: 'in_task', expiresAt: null, prNumber: null }];

    await retryTask('task-build-failed', 'janedoe', await deps());
    expect(builds[0]).toMatchObject({ leaseId: 'lease-held' });

    store.leases = [{ id: 'lease-other', repoId: 'repo-1', issueNumber: 1, botId: 'bot-lead', declaredPaths: [], state: 'in_task', expiresAt: null, prNumber: null }];
    await expect(retryTask('task-build-failed', 'janedoe', await deps())).rejects.toMatchObject({
      status: 409,
      message: 'noraexampleco holds #1 now',
    });
  });

  it('lets go of a lease it took for a build that did not start', async () => {
    const { retryTask } = await import('./task-retry.js');
    store.tasks = [task({ id: 'task-build-failed', botId: 'bot-builder', kind: 'implement', subjectRef: 'fleetadlc-testbed#1', state: 'failed' })];
    const refusing = await deps();
    refusing.startBuild = vi.fn(async () => ({ taskId: 'task-build', session: null as unknown as string, error: 'hostd refused' }));

    const retried = await retryTask('task-build-failed', 'janedoe', refusing);
    expect(retried.task?.error).toBe('hostd refused');
    expect(store.released).toEqual(['lease-1']);
  });

  it('triages a console request again the way its own route does', async () => {
    const { retryTask } = await import('./task-retry.js');
    store.tasks = [
      task({ id: 'task-triage-failed', botId: 'bot-intake', kind: 'intake', subjectType: 'request', subjectRef: 'request:a4b02784', state: 'stopped', repoId: null }),
    ];
    const retried = await retryTask('task-triage-failed', 'janedoe', await deps());
    expect(triages).toEqual(['a4b02784-1111-2222-3333-444444444444']);
    expect(retried.task?.taskId).toBe('task-triage');
  });
});

describe('what is refused', () => {
  it('is work that is already going again, a busy bot, and a task that did not fail', async () => {
    const { retryTask } = await import('./task-retry.js');
    const failed = task({ id: 'task-review', botId: 'bot-lead', kind: 'review', subjectType: 'pr', subjectRef: 'fleetadlc-testbed#2', state: 'failed' });

    store.tasks = [failed, task({ id: 'task-again', botId: 'bot-lead', kind: 'review', subjectType: 'pr', subjectRef: 'fleetadlc-testbed#2', state: 'running' })];
    await expect(retryTask('task-review', 'janedoe', await deps())).rejects.toMatchObject({ status: 409, message: 'it is already running again' });

    store.tasks = [failed, task({ id: 'task-else', botId: 'bot-lead', kind: 'review', subjectType: 'pr', subjectRef: 'fleetadlc-testbed#9', state: 'running' })];
    await expect(retryTask('task-review', 'janedoe', await deps())).rejects.toMatchObject({
      status: 409,
      message:
        'The lead reviewer (noraexampleco) is running all the tasks it may at once; try again once one is done, or raise its tasks at once on the Crew page',
    });

    store.tasks = [{ ...failed, state: 'done' }];
    await expect(retryTask('task-review', 'janedoe', await deps())).rejects.toMatchObject({ status: 409 });
    await expect(retryTask('no-such-task', 'janedoe', await deps())).rejects.toMatchObject({ status: 404 });
    expect(opened).toEqual([]);
  });

  it('is anything at all while work is paused, before it looks at the task', async () => {
    const { retryTask } = await import('./task-retry.js');
    store.tasks = [task({ id: 'task-review', botId: 'bot-lead', kind: 'review', subjectType: 'pr', subjectRef: 'fleetadlc-testbed#2', state: 'failed' })];
    const paused = { ...(await deps()), paused: () => 'work is paused, by janedoe since 2026-09-29T10:00:00.000Z; resume it in Settings → Pause work' };
    await expect(retryTask('task-review', 'janedoe', paused)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/^nothing new starts: work is paused/) });
    expect(opened).toEqual([]);
  });

  it('is work in a repository a person paused, whoever asks, and work in another goes ahead', async () => {
    const { retryTask } = await import('./task-retry.js');
    const { RECOVERY_ACTOR } = await import('./scheduler.js');
    store.tasks = [
      task({ id: 'task-review', botId: 'bot-lead', kind: 'review', subjectType: 'pr', subjectRef: 'fleetadlc-testbed#2', state: 'failed' }),
      task({ id: 'task-build-failed', botId: 'bot-builder', kind: 'implement', subjectRef: 'fleetadlc-testbed#1', state: 'failed' }),
    ];
    const words = 'work is paused in fleetadlc-testbed, by janedoe since 2026-09-29T10:00:00.000Z; resume it in Settings → Pause work';
    const inTestbed = { ...(await deps()), paused: (repo?: string | null) => (repo === 'fleetadlc-testbed' ? words : null) };

    // Try again on a card, and the retry a recovered health check asks for.
    await expect(retryTask('task-review', 'janedoe', inTestbed)).rejects.toMatchObject({ status: 409, message: `nothing new starts: ${words}` });
    await expect(retryTask('task-build-failed', RECOVERY_ACTOR, inTestbed)).rejects.toMatchObject({ status: 409, message: `nothing new starts: ${words}` });
    expect(opened).toEqual([]);

    const elsewhere = { ...(await deps()), paused: (repo?: string | null) => (repo === 'fleetadlc-other' ? 'work is paused in fleetadlc-other' : null) };
    await expect(retryTask('task-review', 'janedoe', elsewhere)).resolves.toMatchObject({ retried: 'task-review' });
  });

  it('is building again an issue that has a pull request now', async () => {
    const { retryTask } = await import('./task-retry.js');
    store.tasks = [task({ id: 'task-build-failed', botId: 'bot-builder', kind: 'implement', subjectRef: 'fleetadlc-testbed#1', state: 'failed' })];
    store.issuePr = 2;
    await expect(retryTask('task-build-failed', 'janedoe', await deps())).rejects.toMatchObject({ status: 409 });
  });
});

describe('a build that ended without its pull request', () => {
  const BRANCH = 'agent/fleetadlc-atlas-janedoe/216-issue-216';
  const done = () =>
    task({ id: 'task-built', botId: 'bot-builder', kind: 'implement', subjectRef: 'fleetadlc-testbed#216', state: 'done', branch: BRANCH, exitReason: 'complete' });

  it('goes on from its branch under the builder’s lease, and the build started is not continued again by the sweep', async () => {
    const { retryTask } = await import('./task-retry.js');
    store.tasks = [done()];
    store.leases = [{ id: 'lease-held', repoId: 'repo-1', issueNumber: 216, botId: 'bot-builder', declaredPaths: ['apps/api/'], state: 'in_task', expiresAt: null, prNumber: null }];

    const retried = await retryTask('task-built', 'janedoe', await deps());

    expect(retried).toMatchObject({ retried: 'task-built', task: { taskId: 'task-build' } });
    expect(builds).toEqual([expect.objectContaining({ leaseId: 'lease-held', issue: 216, continueBranch: BRANCH })]);
    expect(store.claimed).toEqual(['task-build']);
  });

  it('goes on from its branch when its card is tried again, after the second try also opened none', async () => {
    const { retryTask } = await import('./task-retry.js');
    store.tasks = [{ ...done(), state: 'failed', exitReason: `finished without opening a pull request: its commits are on ${BRANCH}, and a second try on that branch did not open one either` }];

    await retryTask('task-built', 'janedoe', await deps());
    expect(builds).toEqual([expect.objectContaining({ continueBranch: BRANCH })]);
  });

  it('builds a failed build again from the base, as before', async () => {
    const { retryTask } = await import('./task-retry.js');
    store.tasks = [{ ...done(), state: 'failed', exitReason: 'engine exited 1' }];

    await retryTask('task-built', 'janedoe', await deps());
    expect(builds[0]).not.toHaveProperty('continueBranch');
    expect(store.claimed).toEqual([]);
  });

  it('is refused once its issue has a pull request, or a later build has run', async () => {
    const { retryTask } = await import('./task-retry.js');
    store.tasks = [done()];
    store.issuePr = 230;
    await expect(retryTask('task-built', 'janedoe', await deps())).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/has a pull request now/) });

    store.issuePr = null;
    store.tasks = [done(), task({ id: 'task-later', botId: 'bot-builder', kind: 'implement', subjectRef: 'fleetadlc-testbed#216', state: 'failed', createdAt: '2026-09-25T11:00:00.000Z' })];
    await expect(retryTask('task-built', 'janedoe', await deps())).rejects.toMatchObject({
      status: 409,
      message: 'a later build of the issue has run since, so there is nothing to go on from here',
    });
    expect(builds).toEqual([]);
  });

  it('is refused when GitHub has a pull request from its branch that the issue does not know of', async () => {
    const { retryTask } = await import('./task-retry.js');
    store.tasks = [done()];
    const branchOf = vi.fn(async () => ({ pullRequest: 230, ahead: 3 }));

    await expect(retryTask('task-built', 'janedoe', { ...(await deps()), branchOf })).rejects.toMatchObject({
      status: 409,
      message: `${BRANCH} has pull request #230, so its review is where the work goes on`,
    });
    expect(branchOf).toHaveBeenCalledWith('janedoe/fleetadlc-testbed', BRANCH, 'main');
    expect(builds).toEqual([]);
  });
});

describe('work that has already landed', () => {
  it('is not run again: a reviewer on a merged pull request, by a person or by the recovery', async () => {
    const { retryTask } = await import('./task-retry.js');
    const { RECOVERY_ACTOR } = await import('./scheduler.js');
    store.tasks = [task({ id: 'task-review', botId: 'bot-lead', kind: 'review', subjectType: 'pr', subjectRef: 'fleetadlc-testbed#2', state: 'failed' })];
    const subjectClosed = vi.fn(async () => true);
    const landed = { ...(await deps()), subjectClosed };

    for (const actor of ['janedoe', RECOVERY_ACTOR]) {
      await expect(retryTask('task-review', actor, landed)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/^already landed: fleetadlc-testbed#2 is closed/) });
    }
    expect(subjectClosed).toHaveBeenCalledWith('janedoe/fleetadlc-testbed', 2);
    expect(opened).toEqual([]);
  });

  it('is run again while the subject is open, or cannot be read', async () => {
    const { retryTask } = await import('./task-retry.js');
    store.tasks = [task({ id: 'task-review', botId: 'bot-lead', kind: 'review', subjectType: 'pr', subjectRef: 'fleetadlc-testbed#2', state: 'failed' })];
    await expect(retryTask('task-review', 'janedoe', { ...(await deps()), subjectClosed: async () => false })).resolves.toMatchObject({ retried: 'task-review' });
    await expect(
      retryTask('task-review', 'janedoe', { ...(await deps()), subjectClosed: async () => Promise.reject(new Error('GitHub is down')) }),
    ).resolves.toMatchObject({ retried: 'task-review' });
  });
});

describe('POST /v1/tasks/:id/retry', () => {
  let bridge: Server;
  let bridgeUrl: string;
  const asked: string[][] = [];

  beforeEach(async () => {
    const { registerConsoleApi } = await import('./api.js');
    const { Router } = await import('./router.js');
    asked.length = 0;
    // Bob is a user; anyone else, the local operator included, an admin.
    const router = new Router(undefined, undefined, undefined, async (_method, _path, identity) => (identity === 'bob@example.com' ? 'user' : 'admin'));
    registerConsoleApi(router, {
      config: { gitHubClientId: '', webhookSecret: '', humans: [] } as never,
      hostd: {} as never,
      actors: {} as never,
      invitations: {} as never,
      automation: {} as never,
      gates: {} as never,
      taskService: { open: async (input: Record<string, unknown>) => (opened.push(input), { taskId: 'task-new', session: 'fleetadlc-1' }) } as never,
      threadStream: { subscribe: () => () => undefined, watching: 0 } as never,
      onboarding: {} as never,
      webhookSetup: {} as never,
      repoSetup: {} as never,
      health: { runSoon: (ids: string[]) => asked.push(ids), rows: async () => [] } as never,
    });
    bridge = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
    bridgeUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => bridge.close(() => resolve()));
  });

  it('puts a failed triage back in line while intake is busy: 202, with its place, not a refusal', async () => {
    store.request.state = 'draft';
    store.tasks = [
      task({ id: 'task-triage-failed', botId: 'bot-intake', kind: 'intake', subjectType: 'request', subjectRef: 'request:a4b02784', state: 'failed', repoId: null }),
      // Intake is triaging another request.
      task({ id: 'task-other', botId: 'bot-intake', kind: 'intake', subjectType: 'request', subjectRef: 'request:bbbbbbbb', state: 'running', repoId: null }),
    ];

    const response = await fetch(`${bridgeUrl}/v1/tasks/task-triage-failed/retry`, { method: 'POST' });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ retried: 'task-triage-failed', task: null, queued: true, position: 1 });
    expect(store.request.state).toBe('queued');
    expect(opened).toEqual([]);
    expect(store.audits.at(-1)).toMatchObject({ action: 'task.retried', payload: { retried: 'task-triage-failed', task: null, queued: true, position: 1 } });
  });

  it('starts the review again and answers with the new task, or says why it will not', async () => {
    store.tasks = [task({ id: 'task-review', botId: 'bot-lead', kind: 'review', subjectType: 'pr', subjectRef: 'fleetadlc-testbed#2', state: 'failed' })];

    const response = await fetch(`${bridgeUrl}/v1/tasks/task-review/retry`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ retried: 'task-review', bot: 'noraexampleco', task: { taskId: 'task-new' } });
    expect(opened[0]).toMatchObject({ kind: 'review', subjectRef: 'fleetadlc-testbed#2', bot: 'noraexampleco' });

    const refused = await fetch(`${bridgeUrl}/v1/tasks/no-such-task/retry`, { method: 'POST' });
    expect(refused.status).toBe(404);
  });

  it('runs a revert again past a spending cap for an admin, in their name', async () => {
    store.tasks = [
      task({
        id: 'task-revert',
        botId: 'bot-builder',
        kind: 'deploy',
        subjectType: 'merge',
        subjectRef: 'fleetadlc-testbed@deadbeef',
        state: 'failed',
        skill: 'deploy',
        branch: 'system/revert-deadbeef',
      }),
    ];

    const response = await fetch(`${bridgeUrl}/v1/tasks/task-revert/retry`, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(opened[0]).toMatchObject({
      subjectRef: 'fleetadlc-testbed@deadbeef',
      branch: 'system/revert-deadbeef',
      bypassCap: { by: expect.any(String), why: 'an admin ran the revert again' },
    });
  });

  it('runs a revert again for a user, but not past a spending cap', async () => {
    store.tasks = [
      task({
        id: 'task-revert',
        botId: 'bot-builder',
        kind: 'deploy',
        subjectType: 'merge',
        subjectRef: 'fleetadlc-testbed@deadbeef',
        state: 'failed',
        skill: 'deploy',
        branch: 'system/revert-deadbeef',
      }),
    ];

    const response = await fetch(`${bridgeUrl}/v1/tasks/task-revert/retry`, { method: 'POST', headers: { 'x-fleetadlc-identity': 'bob@example.com' } });

    expect(response.status).toBe(200);
    expect(opened[0]).toMatchObject({ subjectRef: 'fleetadlc-testbed@deadbeef', branch: 'system/revert-deadbeef' });
    expect(opened[0]).not.toHaveProperty('bypassCap');
  });
});

describe('a revert run again', () => {
  const revert = () =>
    task({
      id: 'task-revert',
      botId: 'bot-builder',
      kind: 'deploy',
      subjectType: 'merge',
      subjectRef: 'fleetadlc-testbed@deadbeef',
      state: 'failed',
      skill: 'deploy',
      branch: 'system/revert-deadbeef',
    });

  it('is let past a cap by an admin, named in the audit', async () => {
    const { retryTask } = await import('./task-retry.js');
    store.tasks = [revert()];

    await retryTask('task-revert', 'janedoe', await deps(), { byAdmin: true });

    expect(opened[0]).toMatchObject({ bypassCap: { by: 'janedoe', why: 'an admin ran the revert again' } });
  });

  it('is run again for a user, but waits for the cap: spending past it is an admin’s', async () => {
    const { retryTask } = await import('./task-retry.js');
    store.tasks = [revert()];

    await retryTask('task-revert', 'bob@example.com', await deps(), { byAdmin: false });

    expect(opened[0]).toMatchObject({ subjectRef: 'fleetadlc-testbed@deadbeef' });
    expect(opened[0]).not.toHaveProperty('bypassCap');
  });

  it('is not let past a cap by the recovery’s automatic retry', async () => {
    const { retryTask } = await import('./task-retry.js');
    store.tasks = [revert()];

    await retryTask('task-revert', 'health-recovery', await deps());

    expect(opened[0]).toMatchObject({ subjectRef: 'fleetadlc-testbed@deadbeef' });
    expect(opened[0]).not.toHaveProperty('bypassCap');
  });

  const BYPASS = { by: 'bridge', why: 'the first revert of a commit, run again once it could start' };

  it('is let past a cap by the automatic retry when it holds its commit’s authorisation, which that spends', async () => {
    // A red smoke's revert recorded for a missing prerequisite never started,
    // so the commit's one start past a cap was not spent. Held by the cap on
    // the recovery's retry, a broken testing deploy stayed live until
    // somebody pressed Try again.
    const { retryTask } = await import('./task-retry.js');
    store.tasks = [revert()];
    store.revert = { 'fleetadlc-testbed@deadbeef': { state: 'held', taskId: 'task-revert' } };

    await retryTask('task-revert', 'health-recovery', await deps());

    expect(opened[0]).toMatchObject({ bypassCap: BYPASS });
    expect(store.revert['fleetadlc-testbed@deadbeef']).toEqual({ state: 'spent', taskId: 'task-revert' });
  });

  it('is not let past a cap by a second retry of the same task: the authorisation was spent', async () => {
    const { retryTask } = await import('./task-retry.js');
    store.tasks = [revert()];
    store.revert = { 'fleetadlc-testbed@deadbeef': { state: 'held', taskId: 'task-revert' } };

    await retryTask('task-revert', 'health-recovery', await deps());
    await retryTask('task-revert', 'health-recovery', await deps());

    expect(opened[0]).toMatchObject({ bypassCap: BYPASS });
    expect(opened[1]).not.toHaveProperty('bypassCap');
  });

  it('is not let past a cap by a user’s Try again on a held revert, which leaves the hold for the recovery', async () => {
    const { retryTask } = await import('./task-retry.js');
    store.tasks = [revert()];
    store.revert = { 'fleetadlc-testbed@deadbeef': { state: 'held', taskId: 'task-revert' } };

    await retryTask('task-revert', 'bob@example.com', await deps(), { byAdmin: false });

    expect(opened[0]).not.toHaveProperty('bypassCap');
    expect(store.revert['fleetadlc-testbed@deadbeef']).toEqual({ state: 'held', taskId: 'task-revert' });
  });

  it('is not let past a cap by the automatic retry when another task holds the authorisation', async () => {
    const { retryTask } = await import('./task-retry.js');
    store.tasks = [revert()];
    store.revert = { 'fleetadlc-testbed@deadbeef': { state: 'held', taskId: 'task-other' } };

    await retryTask('task-revert', 'health-recovery', await deps());

    expect(opened[0]).not.toHaveProperty('bypassCap');
  });

  it('keeps the hold on the task when the retry is refused before anything is recorded', async () => {
    const { retryTask } = await import('./task-retry.js');
    const { PrerequisiteNotReadyError } = await import('./task-service.js');
    store.tasks = [revert()];
    store.revert = { 'fleetadlc-testbed@deadbeef': { state: 'held', taskId: 'task-revert' } };
    const refusing = await deps();
    refusing.taskService.open.mockRejectedValueOnce(new PrerequisiteNotReadyError('fleetadlc-atlas-janedoe', []));

    await expect(retryTask('task-revert', 'health-recovery', refusing)).rejects.toThrow('was not started');

    expect(store.revert['fleetadlc-testbed@deadbeef']).toEqual({ state: 'held', taskId: 'task-revert' });
  });

  it('leaves the authorisation spent when the retry is recorded without starting again: the recovery never runs that task', async () => {
    const { retryTask } = await import('./task-retry.js');
    store.tasks = [
      revert(),
      task({ id: 'task-new', botId: 'bot-builder', kind: 'deploy', subjectRef: 'fleetadlc-testbed@deadbeef', state: 'failed', exitReason: 'fleetadlc-atlas-janedoe was not started: its sign-in' }),
    ];
    store.revert = { 'fleetadlc-testbed@deadbeef': { state: 'held', taskId: 'task-revert' } };
    const recorded = await deps();
    recorded.taskService.open.mockResolvedValueOnce({ taskId: 'task-new', session: null, error: 'fleetadlc-atlas-janedoe was not started' } as never);

    await retryTask('task-revert', 'health-recovery', recorded);

    expect(store.revert['fleetadlc-testbed@deadbeef']).toEqual({ state: 'spent', taskId: 'task-revert' });
  });

  it('spends the authorisation on a start hostd refused, which may have begun', async () => {
    const { retryTask } = await import('./task-retry.js');
    store.tasks = [
      revert(),
      task({ id: 'task-new', botId: 'bot-builder', kind: 'deploy', subjectRef: 'fleetadlc-testbed@deadbeef', state: 'failed', exitReason: 'hostd refused: fetch failed' }),
    ];
    store.revert = { 'fleetadlc-testbed@deadbeef': { state: 'held', taskId: 'task-revert' } };
    const refused = await deps();
    refused.taskService.open.mockResolvedValueOnce({ taskId: 'task-new', session: null, error: 'fetch failed' } as never);

    await retryTask('task-revert', 'health-recovery', refused);

    expect(store.revert['fleetadlc-testbed@deadbeef']).toEqual({ state: 'spent', taskId: 'task-revert' });
  });

  it('lets nothing but a revert past a cap, whoever asks', async () => {
    const { retryTask } = await import('./task-retry.js');
    store.tasks = [task({ id: 'task-review', botId: 'bot-lead', kind: 'review', subjectType: 'pr', subjectRef: 'fleetadlc-testbed#2', state: 'failed' })];

    await retryTask('task-review', 'janedoe', await deps(), { byAdmin: true });

    expect(opened[0]).not.toHaveProperty('bypassCap');
  });
});

describe('a patch round run again', () => {
  const PATCH = {
    id: 'task-patch',
    botId: 'bot-builder',
    kind: 'patch',
    subjectType: 'pr',
    subjectRef: 'fleetadlc-testbed#2',
    state: 'failed',
    skill: 'implement',
    branch: 'agent/fleetadlc-atlas-janedoe/1-issue-1',
    leaseId: 'lease-9',
    round: 2,
  };

  beforeEach(() => {
    store.leases = [
      { id: 'lease-9', repoId: 'repo-1', issueNumber: 1, botId: 'bot-builder', declaredPaths: ['apps/api/', 'apps/api/src/route.ts'], state: 'in_task', expiresAt: null, prNumber: 2 },
    ];
  });

  it('may write the lease’s paths and every file the pull request changes, as a fresh round may', async () => {
    // Found live: a round opened with the lease alone could write only tests and
    // docs, and asked for the very files the review was about.
    const { retryTask } = await import('./task-retry.js');
    store.tasks = [task(PATCH)];
    const pullFiles = vi.fn(async () => ['apps/api/src/route.ts', 'apps/web/src/page.tsx']);

    await retryTask('task-patch', 'janedoe', { ...(await deps()), pullFiles });

    expect(pullFiles).toHaveBeenCalledWith('janedoe/fleetadlc-testbed', 2);
    expect(opened).toEqual([
      expect.objectContaining({
        kind: 'patch',
        leaseId: 'lease-9',
        round: 2,
        declaredPaths: ['apps/api/', 'apps/api/src/route.ts', 'apps/web/src/page.tsx'],
      }),
    ]);
  });

  it('still starts, with the lease’s paths, when the pull request’s files cannot be read', async () => {
    const { retryTask } = await import('./task-retry.js');
    store.tasks = [task(PATCH)];
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await retryTask('task-patch', 'janedoe', { ...(await deps()), pullFiles: vi.fn(async () => Promise.reject(new Error('502'))) });
    } finally {
      quiet.mockRestore();
    }

    expect(opened).toEqual([expect.objectContaining({ kind: 'patch', declaredPaths: ['apps/api/', 'apps/api/src/route.ts'] })]);
  });

  it('keeps a conflict resolution round’s brief, and only its conflicted files', async () => {
    // Run again as an ordinary patch round, it had no brief and could write
    // every file in the pull request: a rework, not a merge of the base.
    const { retryTask } = await import('./task-retry.js');
    store.tasks = [task({ ...PATCH, skill: 'resolve-conflict', round: 0 })];
    store.events = [
      {
        type: 'conflict.resolving',
        at: '2026-10-02T12:00:00.000Z',
        payload: { repo: 'fleetadlc-testbed', pr: 2, issue: 1, files: ['Makefile'], review: 'lead-only', head: 'abc', prFiles: ['Makefile', 'apps/api/src/route.ts'], base: 'main', pending: 'blocked', at: '2026-10-02T12:00:00.000Z' },
      },
    ];
    const pullFiles = vi.fn(async () => ['Makefile', 'apps/api/src/route.ts']);

    try {
      await retryTask('task-patch', 'janedoe', { ...(await deps()), pullFiles });
    } finally {
      store.events = [];
    }

    expect(opened).toEqual([
      expect.objectContaining({
        skill: 'resolve-conflict',
        declaredPaths: ['Makefile'],
        extraContext: [expect.objectContaining({ name: 'resolve-conflict.md', content: expect.stringContaining('- `Makefile`') })],
      }),
    ]);
    expect(pullFiles).not.toHaveBeenCalled();
  });

  it('is given the pull request’s files alone once its lease is let go', async () => {
    const { retryTask } = await import('./task-retry.js');
    store.tasks = [task(PATCH)];
    store.leases[0]!.state = 'released';

    await retryTask('task-patch', 'janedoe', { ...(await deps()), pullFiles: vi.fn(async () => ['apps/web/src/page.tsx']) });

    expect(opened[0]).not.toHaveProperty('leaseId');
    expect(opened[0]).toMatchObject({ declaredPaths: ['apps/web/src/page.tsx'] });
  });
});

describe('the retry the console and the recovery share', () => {
  it('reads a pull request’s files as the automation account, for a patch round run again', async () => {
    const { retryDepsFor } = await import('./api.js');
    const listPullFilesAsNamed = vi.fn(async () => ['apps/web/src/page.tsx']);
    const automation = { actors: { asBot: vi.fn(async () => ({ listPullFilesAsNamed })) }, config: { automationBot: null } };

    const retry = retryDepsFor({ taskService: {} as never, automation: automation as never });

    expect(await retry.pullFiles?.('janedoe/fleetadlc-testbed', 2)).toEqual(['apps/web/src/page.tsx']);
    expect(listPullFilesAsNamed).toHaveBeenCalledWith('janedoe/fleetadlc-testbed', 2);
  });

  it('says what to do when the automation account is not connected', async () => {
    const { retryDepsFor } = await import('./api.js');
    const automation = { actors: { asBot: vi.fn(async () => null) }, config: { automationBot: null } };

    await expect(retryDepsFor({ taskService: {} as never, automation: automation as never }).pullFiles?.('janedoe/fleetadlc-testbed', 2)).rejects.toThrow(
      /is not connected to GitHub/,
    );
  });
});
