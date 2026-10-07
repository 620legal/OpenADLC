import { createHmac } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two routes a plan change passes through: the gate a task opens to ask for
 * paths, and the state a task ends in, which is when a path another lease was
 * holding may have been let go.
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
  bots: {
    getBotById: vi.fn(async () => ({ id: 'bot-builder', name: 'builder', displayName: 'Builder', engine: 'codex' })),
    getBotByName: vi.fn(async () => null),
    listBots: vi.fn(async () => [{ id: 'bot-builder', name: 'builder', slot: 'builder', githubLogin: null }]),
  },
  costs: { currentPeriod: vi.fn(() => '2026-09') },
  credentials: {},
  issues: {},
  leases: {
    releaseForPullRequest: vi.fn(async () => null),
    settlePausedLeases: vi.fn(async () => ({ released: [], held: [] })),
  },
  listAudit: vi.fn(),
  mergeLines: {},
  recordEvent: vi.fn(),
  repos: {
    getRepoByName: vi.fn(async () => null),
    listRepos: vi.fn(async () => [{ id: 'repo-1', name: 'fleetadlc', fullName: 'exampleco/fleetadlc' }]),
  },
  requests: { findRequestByPrefix: vi.fn(async () => null) },
  sessions: {},
  settings: { allSettings: vi.fn(async () => ({})) },
  localCiRuns: {
    record: vi.fn(async (input: Record<string, unknown>) => ({ id: 'row-1', ...input })),
    latestFor: vi.fn(async () => ({ runId: 'run-1', ok: true, createdAt: '2026-09-30T10:00:00.000Z' })),
    passFor: vi.fn(async (_repo: string, sha: string) => (sha === 'a'.repeat(40) ? { runId: 'run-1', ok: true, createdAt: '2026-09-30T10:00:00.000Z' } : null)),
  },
  stageMoves: {
    sendBackOfTask: vi.fn(async (taskId: string) => (taskId === 'task-sent' ? { repoId: 'repo-1', issueNumber: 78, from: 'build', to: 'spec', kind: 'send_back' } : null)),
  },
  tasks: {
    getTask: vi.fn(async (id: string) => (id === 'task-gone' ? null : { id, state: id === 'task-done' ? 'done' : id === 'task-paused' ? 'paused' : 'running', kind: id === 'task-review' ? 'review' : id === 'task-qa' ? 'qa' : id === 'task-spec' ? 'spec' : id === 'task-deploy' ? 'deploy' : 'implement', repoId: 'repo-1', branch: 'agent/builder/78-issue-78', subjectRef: 'fleetadlc#78' })),
    updateTaskState: vi.fn(async (id: string, state: string, extra: { exitReason: string | null }) => ({
      id,
      botId: 'bot-builder',
      repoId: 'repo-1',
      kind: 'implement',
      subjectType: 'issue',
      subjectRef: 'fleetadlc#78',
      leaseId: 'lease-78',
      state,
      exitReason: extra.exitReason,
    })),
  },
  threads: {
    ensureThread: vi.fn(async () => ({ id: 'thread-1' })),
    addMessage: vi.fn(async () => ({ id: 'message-1' })),
    listMessages: vi.fn(async () => []),
  },
}));

// The build a lease starts; what it does is `build-start.test.ts`'s.
const startBuild = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ taskId: 'task-build', session: 'build-1' })));
vi.mock('./build-start.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('./build-start.js')>()), startBuild }));

/** The automation account's client, when a test gives the bridge one. */
let automationGithub: unknown = null;

const SECRET = 'install-secret-for-the-test';
const ALERTS_SECRET = 'alerts-secret-for-the-test';
const applyHeld = vi.fn(async (): Promise<string[]> => []);
const resume = vi.fn(async (_taskId: string) => undefined);
const headroom = vi.fn(async (_taskId: string, _estimate: number) => ({ ok: true }));
const open = vi.fn(async (_input: unknown) => ({ gateId: 'gate-1', commentUrl: null }));
const drain = vi.fn(async () => []);
const ensureLabel = vi.fn(async (_repo: string, _label: string) => true);
const afterBuildEnded = vi.fn();
const setBlocked = vi.fn(async (_repo: string, _number: number, _blocked: boolean) => undefined);
const sendBackRequest = vi.fn(async (_input: unknown) => ({ sent: true, from: 'build', to: 'spec', staffed: true, round: 1, commentUrl: null }));
const fromBridge = vi.fn(async (_input: unknown): Promise<unknown> => ({ sent: true, from: 'build', to: 'intake', staffed: true, round: 1, commentUrl: null }));
const sendToTriage = vi.fn(async (_repo: string, _number: number, _reason: string) => undefined);
const onTaskDone = vi.fn(async (_input: unknown) => undefined);
const afterIntake = vi.fn(async (_input: unknown) => 'build');
const startLocalCi = vi.fn(async (taskId: string) => ({ run: { id: 'run-1', taskId, state: 'running', headSha: null } }));
const sign = vi.fn(async (body: string, fields: { seat: string }) => `${body}\n\n<!-- signed as ${fields.seat} -->`);
const receive = vi.fn(async (_event: string, _payload: unknown, _delivery: string | null) => undefined);
const connect = vi.fn(async (_input: unknown): Promise<unknown> => ({ login: 'janedoe-crew', bot: 'builder', joined: 'janedoe-crew' }));
const tokenFor = vi.fn(async (name: string, options: { repository?: string }) => ({
  token: options.repository ? `ghu_for_${options.repository}` : 'ghu_account',
  expiresAt: null,
  login: name,
  ...(options.repository ? { scoped: true } : {}),
}));
const recordUsage = vi.fn(async (_input: { taskId: string }) => ({ stop: false, spent: 1.25, cap: 15, stepUsd: 15 }));
const localCiRun = vi.fn(async (taskId: string, runId: string) => ({ run: { id: runId, taskId, state: 'passed', headSha: 'a'.repeat(40) } }));


let bridge: Server;
let bridgeUrl: string;

beforeEach(async () => {
  const { registerInternalApi } = await import('./internal-api.js');
  const { Router } = await import('./router.js');
  const router = new Router();
  registerInternalApi(router, {
    config: { automationBot: null, costs: { monthlyCapUsd: 1500, perTaskCapUsd: 15 }, organization: 'exampleco', webhookSecret: '', gitHubClientId: '', humans: [] } as never,
    webhooks: { receive } as never,
    scheduler: { afterBuildEnded } as never,
    stages: { onTaskDone, afterIntake } as never,
    sendBack: { request: sendBackRequest, fromBridge } as never,
    internalSecret: SECRET,
    alertsSecret: ALERTS_SECRET,
    hostd: { cleanupTask: async () => undefined, startLocalCi, localCiRun, health: async () => ({ ok: true }) } as never,
    actors: { asBot: async () => automationGithub, tokenFor } as never,
    attribution: { sign } as never,
    automation: { setBlocked, sendToTriage, actors: { asBot: async () => automationGithub } } as never,
    gates: { open, applyHeld } as never,
    taskService: { resume, recordUsage, headroom } as never,
    onboarding: { connect } as never,
    invitations: {} as never,
    threadStream: {} as never,
    webhookSetup: {} as never,
    repoSetup: { ensureLabel } as never,
    names: { settled: async () => undefined } as never,
    dispatchRuns: { soon: () => undefined },
    requestQueue: { drain } as never,
  });
  bridge = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  bridgeUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
});

afterEach(async () => {
  automationGithub = null;
  vi.clearAllMocks();
  await new Promise<void>((resolve) => bridge.close(() => resolve()));
});

function post(path: string, body: unknown) {
  return fetch(`${bridgeUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fleetadlc-internal-secret': SECRET },
    body: JSON.stringify(body),
  });
}

describe('a task asking for paths', () => {
  it('has its request passed to the gate it opens, as data', async () => {
    const planChange = { paths: ['apps/hostd/src/skill-runner.ts'], reason: 'the runner drops the field' };

    const response = await post('/internal/tasks/task-1/gate', {
      question: 'Add `apps/hostd/src/skill-runner.ts` to this issue’s Expected paths?',
      options: ['Approve', 'Refuse'],
      context: 'It drops the field.',
      planChange,
    });

    expect(response.status).toBe(200);
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-1', options: ['Approve', 'Refuse'], planChange }),
    );
  });

  it('opens an ordinary question with no request behind it', async () => {
    await post('/internal/tasks/task-1/gate', { question: 'Which one?', options: ['a', 'b'] });

    expect(open).toHaveBeenCalledWith(expect.objectContaining({ question: 'Which one?', planChange: null }));
  });
});

describe('a task ending, which may let go of paths a plan change was waiting for', () => {
  it.each(['done', 'failed', 'stopped'])('resumes the tasks whose paths are free once one is %s', async (state) => {
    applyHeld.mockResolvedValueOnce(['task-7', 'task-8']);

    const response = await post('/internal/tasks/task-1/state', { state, reason: 'because' });

    expect(response.status).toBe(200);
    expect(applyHeld).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls.map((call) => call[0])).toEqual(['task-7', 'task-8']);
  });

  it('looks at nothing when the task is still going', async () => {
    for (const state of ['running', 'paused']) await post('/internal/tasks/task-1/state', { state });

    expect(applyHeld).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it('answers the task’s own state anyway when the waiting requests cannot be looked at', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    applyHeld.mockRejectedValueOnce(new Error('the database is down'));

    const response = await post('/internal/tasks/task-1/state', { state: 'done' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ task: { id: 'task-1', state: 'done' } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the database is down'));
    warn.mockRestore();
  });

  it('goes on to the next task when one cannot be resumed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    applyHeld.mockResolvedValueOnce(['task-7', 'task-8']);
    resume.mockRejectedValueOnce(new Error('hostd refused'));

    const response = await post('/internal/tasks/task-1/state', { state: 'done' });

    expect(response.status).toBe(200);
    expect(resume.mock.calls.map((call) => call[0])).toEqual(['task-7', 'task-8']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('hostd refused'));
    warn.mockRestore();
  });
});

describe('a state the task may not move to', () => {
  it('answers 409 with the task’s state when the store refuses the move, and 404 for a task there is not', async () => {
    const { tasks } = await import('@fleetadlc/db');
    vi.mocked(tasks.updateTaskState).mockResolvedValueOnce(null);

    const refused = await post('/internal/tasks/task-done/state', { state: 'running' });

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'the task is done and cannot become running', state: 'done' });

    vi.mocked(tasks.updateTaskState).mockResolvedValueOnce(null);
    expect((await post('/internal/tasks/task-gone/state', { state: 'running' })).status).toBe(404);
  });

  it('writes a review that left no review failed in one write, since a done task is not changed again', async () => {
    const { tasks, repos, bots } = await import('@fleetadlc/db');
    vi.mocked(repos.getRepoByName).mockResolvedValueOnce({ id: 'repo-1', name: 'fleetadlc', fullName: 'exampleco/fleetadlc' } as never);
    vi.mocked(bots.getBotById).mockResolvedValueOnce({ id: 'bot-lead', name: 'lead-reviewer', githubLogin: 'lead-exampleco' } as never);
    automationGithub = { listReviews: async () => [] };

    const response = await post('/internal/tasks/task-review/state', { state: 'done' });

    expect(response.status).toBe(200);
    expect(vi.mocked(tasks.updateTaskState).mock.calls).toEqual([['task-review', 'failed', { exitReason: expect.stringMatching(/review/i) }]]);
  });
});

describe('a build ending', () => {
  it('asks for its pull request to be looked for once it ended done, and not when it failed', async () => {
    await post('/internal/tasks/task-1/state', { state: 'failed', reason: 'engine exited 1' });
    expect(afterBuildEnded).not.toHaveBeenCalled();

    await post('/internal/tasks/task-1/state', { state: 'done' });
    expect(afterBuildEnded).toHaveBeenCalledTimes(1);
  });
});

describe('a task ending, which settles the lease a question paused', () => {
  it.each([
    ['done', 'finished'],
    ['failed', 'failed'],
    ['stopped', 'stopped'],
  ])('settles its lease once it is %s', async (state, said) => {
    const { leases } = await import('@fleetadlc/db');

    const response = await post('/internal/tasks/task-1/state', { state, reason: 'why' });

    expect(response.status).toBe(200);
    expect(vi.mocked(leases.settlePausedLeases)).toHaveBeenCalledWith({
      leaseId: 'lease-78',
      actor: 'bridge',
      reason: `its task on fleetadlc#78 ${said}`,
      holdUntil: expect.any(Date),
    });
  });

  it('leaves it while the task is only running, or paused on a person', async () => {
    const { leases } = await import('@fleetadlc/db');

    await post('/internal/tasks/task-1/state', { state: 'running' });
    await post('/internal/tasks/task-1/state', { state: 'paused', reason: 'waiting on a person' });

    expect(vi.mocked(leases.settlePausedLeases)).not.toHaveBeenCalled();
  });
});

describe('a lease the month cap refuses', () => {
  it('answers 409 and starts nothing', async () => {
    const { repos, bots, spendingLimits } = await import('@fleetadlc/db');
    vi.mocked(repos.getRepoByName).mockResolvedValueOnce({ id: 'repo-api', name: 'api', fullName: 'exampleco/api' } as never);
    vi.mocked(bots.getBotByName).mockResolvedValueOnce({ id: 'bot-builder', name: 'builder', engine: 'codex' } as never);
    vi.mocked(spendingLimits.refusal).mockResolvedValueOnce('exampleco/api has spent $200 of its $200 this month');

    const response = await post('/internal/dispatch/lease', {
      leaseId: 'lease-1',
      repo: 'api',
      issue: 12,
      bot: 'builder',
      declaredPaths: ['apps/bridge/src/task-service.ts'],
      expiresAt: null,
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'exampleco/api has spent $200 of its $200 this month' });
    expect(spendingLimits.refusal).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: 'repo-api',
        repoLabel: 'exampleco/api',
        botId: 'bot-builder',
        botName: 'builder',
        engine: 'codex',
        period: '2026-09',
      }),
    );
  });
});

describe('a lease on an issue closed on GitHub', () => {
  const lease = { leaseId: 'lease-7', repo: 'testbed', issue: 7, bot: 'builder', declaredPaths: ['rub.html'], expiresAt: null };

  beforeEach(async () => {
    const { repos, bots } = await import('@fleetadlc/db');
    vi.mocked(repos.getRepoByName).mockResolvedValueOnce({ id: 'repo-testbed', name: 'testbed', fullName: 'exampleco/testbed' } as never);
    vi.mocked(bots.getBotByName).mockResolvedValueOnce({ id: 'bot-builder', name: 'builder', engine: 'codex' } as never);
  });

  it('answers 409 naming the issue, and builds nothing', async () => {
    // Cancelled from its card a moment ago: the board's row still said build
    // and start:now, and the dispatcher leased it again.
    automationGithub = { getIssue: vi.fn(async () => ({ state: 'closed' })) };

    const response = await post('/internal/dispatch/lease', lease);

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain('exampleco/testbed#7 is closed on GitHub');
    expect(startBuild).not.toHaveBeenCalled();
  });

  it('builds an open one, and one whose state could not be read', async () => {
    automationGithub = { getIssue: vi.fn(async () => ({ state: 'open' })), getPullRequest: vi.fn(async () => null) };
    expect((await post('/internal/dispatch/lease', lease)).status).toBe(200);

    const { repos, bots } = await import('@fleetadlc/db');
    vi.mocked(repos.getRepoByName).mockResolvedValueOnce({ id: 'repo-testbed', name: 'testbed', fullName: 'exampleco/testbed' } as never);
    vi.mocked(bots.getBotByName).mockResolvedValueOnce({ id: 'bot-builder', name: 'builder', engine: 'codex' } as never);
    automationGithub = { getIssue: vi.fn(async () => Promise.reject(new Error('GitHub is down'))) };
    expect((await post('/internal/dispatch/lease', lease)).status).toBe(200);
    expect(startBuild).toHaveBeenCalledTimes(2);
  });
});

describe('an intake task that frees intake', () => {
  it('starts the next request in line when it ends or waits on a person, and no other task does', async () => {
    const { tasks } = await import('@fleetadlc/db');
    const intakeTask = (state: string) => ({ id: 'task-9', botId: 'bot-intake', repoId: null, kind: 'intake', subjectType: 'request', subjectRef: 'request:aaaaaaaa', state, exitReason: null, startedAt: null });

    for (const state of ['done', 'failed', 'stopped', 'paused']) {
      vi.mocked(tasks.updateTaskState).mockResolvedValueOnce(intakeTask(state) as never);
      drain.mockClear();
      await post('/internal/tasks/task-9/state', { state, reason: 'why' });
      expect(drain, state).toHaveBeenCalledTimes(1);
    }

    drain.mockClear();
    vi.mocked(tasks.updateTaskState).mockResolvedValueOnce(intakeTask('running') as never);
    await post('/internal/tasks/task-9/state', { state: 'running' });
    await post('/internal/tasks/task-1/state', { state: 'done' });
    expect(drain).not.toHaveBeenCalled();
  });
});

describe('the end of a console request’s triage', () => {
  it('hands the issue it filed to Design or Build by the spec rule, whichever delivery linked it', async () => {
    const { requests, tasks } = await import('@fleetadlc/db');
    // Linked already by the issue's own `opened` delivery, so `triageEnded` answers nothing.
    vi.mocked(requests.findRequestByPrefix).mockResolvedValue({ id: 'aaaaaaaa-1', state: 'filed', repoId: 'repo-1', issueNumber: 12 } as never);
    vi.mocked(tasks.updateTaskState).mockResolvedValueOnce({ id: 'task-9', botId: 'bot-intake', repoId: null, kind: 'intake', subjectType: 'request', subjectRef: 'request:aaaaaaaa', state: 'done', exitReason: null } as never);
    try {
      expect((await post('/internal/tasks/task-9/state', { state: 'done' })).status).toBe(200);

      expect(afterIntake).toHaveBeenCalledWith({ repoName: 'fleetadlc', issueNumber: 12 });
    } finally {
      vi.mocked(requests.findRequestByPrefix).mockResolvedValue(null);
    }
  });

  it('hands nothing on when the triage filed no issue', async () => {
    const { tasks } = await import('@fleetadlc/db');
    vi.mocked(tasks.updateTaskState).mockResolvedValueOnce({ id: 'task-9', botId: 'bot-intake', repoId: null, kind: 'intake', subjectType: 'request', subjectRef: 'request:aaaaaaaa', state: 'done', exitReason: null } as never);

    await post('/internal/tasks/task-9/state', { state: 'done' });

    expect(afterIntake).not.toHaveBeenCalled();
  });
});

describe('unblocking an issue whose dependencies shipped', () => {
  async function stored(labels: string[]) {
    const db = await import('@fleetadlc/db');
    vi.mocked(db.repos.getRepoByName).mockResolvedValue({ id: 'repo-1', name: 'fleetadlc', fullName: 'janedoe/fleetadlc' } as never);
    const setBlockedLabel = vi.fn(async () => undefined);
    Object.assign(db.issues, { getIssue: vi.fn(async () => ({ number: 12, labels })), setBlockedLabel });
    return setBlockedLabel;
  }

  it('swaps blocked for start:now on an issue the crew works on', async () => {
    const setBlockedLabel = await stored(['blocked', 'adlc:build']);

    const response = await post('/internal/issues/fleetadlc/12/unblock', { dependencies: [11] });

    expect(await response.json()).toMatchObject({ changed: true });
    expect(setBlocked).toHaveBeenCalledWith('janedoe/fleetadlc', 12, false);
    expect(setBlockedLabel).toHaveBeenCalledWith('repo-1', 12, false);
  });

  it('leaves an issue labelled fleetadlc:ignore blocked, and adds no start:now', async () => {
    // Unblocking adds start:now: the crew changing an issue it was told to leave alone.
    const setBlockedLabel = await stored(['blocked', 'adlc:build', 'fleetadlc:ignore']);

    const response = await post('/internal/issues/fleetadlc/12/unblock', { dependencies: [11] });

    expect(await response.json()).toMatchObject({ changed: false });
    expect(setBlocked).not.toHaveBeenCalled();
    expect(setBlockedLabel).not.toHaveBeenCalled();
  });
});

describe('an issue whose Expected paths have a line that is not a path', () => {
  const BODY = '## Expected paths\n\n- packages/db/migrations/0037_x.sql and its test\n- docs/\n';

  async function stored() {
    const db = await import('@fleetadlc/db');
    vi.mocked(db.repos.getRepoByName).mockResolvedValue({ id: 'repo-1', name: 'fleetadlc', fullName: 'exampleco/fleetadlc' } as never);
    const setTriageLabel = vi.fn(async () => undefined);
    Object.assign(db.issues, { getIssue: vi.fn(async () => ({ number: 12, stage: 'build', labels: ['adlc:build', 'start:now'], body: BODY })), setTriageLabel });
    return { setTriageLabel, audit: vi.mocked(db.audit) };
  }
  const ask = () => post('/internal/issues/fleetadlc/12/expected-paths', { reason: 'not ready to be worked on: an Expected paths line that is not a path: …' });

  it('is sent back to the stage that wrote them, the line quoted, and not to triage', async () => {
    // needs-triage waits for a person, and nothing in the crew picks it up.
    const { setTriageLabel, audit } = await stored();

    expect(await (await ask()).json()).toMatchObject({ changed: true, outcome: 'sent', reason: 'sent back to intake to rewrite its Expected paths' });
    expect(fromBridge).toHaveBeenCalledWith(
      expect.objectContaining({ repoName: 'fleetadlc', issueNumber: 12, from: 'build', reason: expect.stringContaining('- packages/db/migrations/0037_x.sql and its test') }),
    );
    expect((fromBridge.mock.calls[0]?.[0] as { reason: string }).reason).toMatch(/one file per line/);
    expect(sendToTriage).not.toHaveBeenCalled();
    expect(setTriageLabel).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'issue.paths_sent_back', target: 'fleetadlc#12' }));
  });

  it('goes to triage only when the send-back is refused, and says why', async () => {
    const { setTriageLabel, audit } = await stored();
    fromBridge.mockResolvedValueOnce({ sent: false, reason: 'Build has no stage before it to send work back to' });

    expect(await (await ask()).json()).toMatchObject({ changed: true, outcome: 'triaged', reason: expect.stringMatching(/not sent back: Build has no stage before it/) });
    expect(sendToTriage).toHaveBeenCalledWith('exampleco/fleetadlc', 12, expect.stringMatching(/^not ready to be worked on/));
    expect(setTriageLabel).toHaveBeenCalledWith('repo-1', 12);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'issue.triaged', target: 'fleetadlc#12', payload: expect.objectContaining({ sendBackRefused: 'Build has no stage before it to send work back to' }) }),
    );
  });

  it('stops at needs-human, as the send-back does past its limits, and is not triaged as well', async () => {
    const { setTriageLabel } = await stored();
    fromBridge.mockResolvedValueOnce({ sent: false, stalled: true, reason: 'fleetadlc#12 has gone back 3 times in all already; a person decides now' });

    expect(await (await ask()).json()).toMatchObject({ changed: true, outcome: 'stalled', reason: expect.stringMatching(/a person decides now$/) });
    expect(sendToTriage).not.toHaveBeenCalled();
    expect(setTriageLabel).not.toHaveBeenCalled();
  });
});

describe('a task sending its work back', () => {
  it('passes the stage and the reason to the send-back as this task’s, and answers what it decided', async () => {
    const response = await post('/internal/tasks/task-1/send-back', { to: ' spec ', reason: 'the design names no migration' });

    expect(await response.json()).toMatchObject({ sent: true, to: 'spec' });
    expect(sendBackRequest).toHaveBeenCalledWith({ taskId: 'task-1', to: 'spec', reason: 'the design names no migration' });
  });

  it('takes the task’s own token, and no other task’s', async () => {
    const { taskTokenFor } = await import('@fleetadlc/github');
    const as = (task: string) =>
      fetch(`${bridgeUrl}/internal/tasks/task-1/send-back`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-fleetadlc-task-token': taskTokenFor(task, SECRET) },
        body: JSON.stringify({ to: 'spec', reason: 'x' }),
      });

    expect((await as('task-1')).status).toBe(200);
    expect((await as('task-2')).status).toBe(401);
    expect(sendBackRequest).toHaveBeenCalledTimes(1);
  });

  it('ends a task that sent its work back with where it went, and tells the handoff which task it was', async () => {
    const { tasks } = await import('@fleetadlc/db');

    await post('/internal/tasks/task-sent/state', { state: 'done', reason: 'complete' });

    expect(vi.mocked(tasks.updateTaskState)).toHaveBeenCalledWith('task-sent', 'done', { exitReason: 'sent back to spec' });
    expect(onTaskDone).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-sent', kind: 'implement' }));
  });
});

describe('a task token for an ended task', () => {
  const asTask = (task: string, route: string, body: unknown) =>
    import('@fleetadlc/github').then(({ taskTokenFor }) =>
      fetch(`${bridgeUrl}/internal/tasks/${task}/${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-fleetadlc-task-token': taskTokenFor(task, SECRET) },
        body: JSON.stringify(body),
      }),
    );
  const GATE = { question: 'Which one?', options: ['a', 'b'] };
  const USAGE = { tokensIn: 10, tokensOut: 5, costUsd: 0.01, engine: 'codex', model: 'gpt' };

  it('opens no gate, and leaves the lease alone', async () => {
    const response = await asTask('task-done', 'gate', GATE);

    expect(response.status).toBe(409);
    expect(await response.text()).toContain('task is done; a gate is opened only by a task that is running');
    expect(open).not.toHaveBeenCalled();
  });

  it('asks for no headroom', async () => {
    expect((await asTask('task-done', 'headroom', { estimateUsd: 1 })).status).toBe(409);
    expect(headroom).not.toHaveBeenCalled();
  });

  it('records no usage', async () => {
    expect((await asTask('task-done', 'usage', USAGE)).status).toBe(409);
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('posts no message', async () => {
    const { threads } = await import('@fleetadlc/db');

    expect((await asTask('task-done', 'message', { text: 'still here' })).status).toBe(409);
    expect(threads.addMessage).not.toHaveBeenCalled();
  });

  it('changes no state, and hands nothing on', async () => {
    const { tasks } = await import('@fleetadlc/db');

    expect((await asTask('task-done', 'state', { state: 'done', reason: 'complete' })).status).toBe(409);
    expect(tasks.updateTaskState).not.toHaveBeenCalled();
    expect(onTaskDone).not.toHaveBeenCalled();
  });

  it('is not known for a task that does not exist', async () => {
    expect((await asTask('task-gone', 'gate', GATE)).status).toBe(404);
    expect(open).not.toHaveBeenCalled();
  });

  it('holds hostd, with the install’s secret, to none of it', async () => {
    const { tasks } = await import('@fleetadlc/db');

    expect((await post('/internal/tasks/task-done/state', { state: 'failed', reason: 'gone' })).status).toBe(200);
    expect(tasks.updateTaskState).toHaveBeenCalledWith('task-done', 'failed', { exitReason: 'gone' });
  });

  it('still works for a task that is running, or paused on a person’s question', async () => {
    const { threads } = await import('@fleetadlc/db');

    expect((await asTask('task-1', 'gate', GATE)).status).toBe(200);
    expect(open).toHaveBeenCalledTimes(1);
    expect((await asTask('task-paused', 'usage', USAGE)).status).toBe(200);
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect((await asTask('task-paused', 'message', { text: 'waiting on a person' })).status).toBe(200);
    expect(threads.addMessage).toHaveBeenCalledTimes(1);
    // A resume.
    expect((await asTask('task-paused', 'state', { state: 'running' })).status).toBe(200);
  });
});

describe('the repository’s checks on a task’s head', () => {
  const asTask = (task: string, path: string, body: unknown) =>
    import('@fleetadlc/github').then(({ taskTokenFor }) =>
      fetch(`${bridgeUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-fleetadlc-task-token': taskTokenFor(task, SECRET) },
        body: JSON.stringify(body),
      }),
    );

  it('are started by the build’s own session, and only for a build or a patch round that is running', async () => {
    expect((await asTask('task-1', '/internal/tasks/task-1/local-ci', {})).status).toBe(200);
    expect(startLocalCi).toHaveBeenCalledWith('task-1');
    const review = await asTask('task-review', '/internal/tasks/task-review/local-ci', {});
    expect(review.status).toBe(409);
    expect(await review.text()).toMatch(/a review task does not run local CI/);
    expect((await asTask('task-done', '/internal/tasks/task-done/local-ci', {})).status).toBe(409);
  });

  it('are started by a QA task changing a suite, whose pull request needs a recorded pass like a build’s', async () => {
    expect((await asTask('task-qa', '/internal/tasks/task-qa/local-ci', {})).status).toBe(200);
    expect(startLocalCi).toHaveBeenCalledWith('task-qa');
    expect((await asTask('task-review', '/internal/tasks/task-review/local-ci', {})).status).toBe(409);
  });

  it('are started by a design task recording an ADR in a pull request of its own', async () => {
    expect((await asTask('task-spec', '/internal/tasks/task-spec/local-ci', {})).status).toBe(200);
    expect(startLocalCi).toHaveBeenCalledWith('task-spec');
  });

  it('are started by the SRE fixing a broken deploy workflow, and still never by a review', async () => {
    expect((await asTask('task-deploy', '/internal/tasks/task-deploy/local-ci', {})).status).toBe(200);
    expect(startLocalCi).toHaveBeenCalledWith('task-deploy');
    expect((await asTask('task-review', '/internal/tasks/task-review/local-ci', {})).status).toBe(409);
  });

  it('are read back with whether the bridge recorded the result', async () => {
    const response = await asTask('task-1', '/internal/tasks/task-1/local-ci/status', { run: 'run-1' });
    expect(await response.json()).toMatchObject({ run: { id: 'run-1', state: 'passed' }, recorded: true });
  });

  it('answer whether a commit passed, in the task’s own repository', async () => {
    const yes = await asTask('task-1', '/internal/tasks/task-1/local-ci/pass', { sha: 'a'.repeat(40) });
    expect(await yes.json()).toMatchObject({ passed: true });
    const no = await asTask('task-1', '/internal/tasks/task-1/local-ci/pass', { sha: 'b'.repeat(40) });
    expect(await no.json()).toMatchObject({ passed: false });
    expect((await asTask('task-1', '/internal/tasks/task-1/local-ci/pass', { sha: 'HEAD' })).status).toBe(400);
  });

  it('are recorded from what hostd reports with the install’s secret, never from a session', async () => {
    const { localCiRuns } = await import('@fleetadlc/db');
    const result = { runId: 'run-1', taskId: 'task-1', headSha: 'a'.repeat(40), branch: 'something-else', ok: true, exitCode: 0, durationMs: 1200, logTail: 'ci: green' };

    // The task's own token opens nothing here.
    expect((await asTask('task-1', '/internal/local-ci', result)).status).toBe(401);
    expect(localCiRuns.record).not.toHaveBeenCalled();

    const recorded = await post('/internal/local-ci', result);
    expect(await recorded.json()).toEqual({ recorded: true });
    // The repository and branch are the task's, not the report's.
    expect(localCiRuns.record).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-1', taskId: 'task-1', repoId: 'repo-1', branch: 'agent/builder/78-issue-78', ok: true }));
  });

  it('are stored with a credential the run printed masked', async () => {
    const { localCiRuns } = await import('@fleetadlc/db');
    const logTail = 'fetching https://x-access-token:ghs_0123456789abcdefghijABCDEFGHIJ@github.com/exampleco/app.git\nci: red';
    await post('/internal/local-ci', { runId: 'run-2', taskId: 'task-1', headSha: 'a'.repeat(40), ok: false, logTail });

    const stored = vi.mocked(localCiRuns.record).mock.calls.at(-1)?.[0] as { logTail: string };
    expect(stored.logTail).not.toContain('ghs_0123456789');
    expect(stored.logTail).toBe('fetching https://x-access-token:***@github.com/exampleco/app.git\nci: red');
  });
});

describe('signing what a task’s session posts', () => {
  const asTask = (task: string, body: unknown) =>
    import('@fleetadlc/github').then(({ taskTokenFor }) =>
      fetch(`${bridgeUrl}/internal/tasks/${task}/stamp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-fleetadlc-task-token': taskTokenFor(task, SECRET) },
        body: JSON.stringify(body),
      }),
    );

  it('refuses a body whose end names another seat, rather than signing it as the task’s', async () => {
    // A seat on an account the reviewers share, ending its approval in the
    // lead's tag: signed, the tag would have been the word on whose it was.
    const response = await asTask('task-1', { body: 'Approved.\n\n<!-- fleetadlc-seat:lead-reviewer -->', kind: 'review', number: 78 });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain('lead-reviewer');
    expect(text).toContain('builder');
    expect(sign).not.toHaveBeenCalled();
  });

  it('signs a body with no tag, or with the task’s own, as the task’s seat', async () => {
    for (const body of ['Done.', 'Done.\n\n<!-- fleetadlc-seat:builder -->', 'It keeps `<!-- fleetadlc-seat:lead-reviewer -->` as it was.']) {
      const response = await asTask('task-1', { body, kind: 'comment', number: 78 });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ body: `${body}\n\n<!-- signed as builder -->` });
    }
    expect(sign).toHaveBeenCalledWith('Done.', expect.objectContaining({ seat: 'builder', task: 'task-1', repo: 'exampleco/fleetadlc', kind: 'comment', n: 78 }));
  });

  it('refuses to stamp a body longer than GitHub holds, naming the limit', async () => {
    const response = await asTask('task-1', { body: 'x'.repeat(65_537), kind: 'comment', number: 78 });
    expect(response.status).toBe(413);
    expect(await response.text()).toContain('65,536');
    expect(sign).not.toHaveBeenCalled();

    expect((await asTask('task-1', { body: 'x'.repeat(65_536), kind: 'comment', number: 78 })).status).toBe(200);
  });
});

describe('a task signing what it posts', () => {
  it('signs a review only of the pull request its review task is on', async () => {
    // task-review reviews fleetadlc#78.
    const own = await post('/internal/tasks/task-review/stamp', { body: 'Approved.', kind: 'review', number: 78 });
    expect(own.status).toBe(200);
    expect(sign).toHaveBeenCalledWith('Approved.', expect.objectContaining({ kind: 'review', n: 78, repo: 'exampleco/fleetadlc' }));

    sign.mockClear();
    const another = await post('/internal/tasks/task-review/stamp', { body: 'Approved.', kind: 'review', number: 5 });
    expect(another.status).toBe(403);
    expect(sign).not.toHaveBeenCalled();
  });

  it('signs no review for a task that is not a review', async () => {
    const response = await post('/internal/tasks/task-1/stamp', { body: 'Approved.', kind: 'review', number: 78 });
    expect(response.status).toBe(403);
    expect(sign).not.toHaveBeenCalled();
  });

  it('signs a post on the task’s issue or its pull request, and on nothing else', async () => {
    // task-1 builds fleetadlc#78, whose pull request is #90.
    const db = await import('@fleetadlc/db');
    Object.assign(db.issues, {
      getIssue: vi.fn(async (_repoId: string, number: number) => (number === 78 ? { number: 78, prNumber: 90 } : null)),
      listIssues: vi.fn(async () => [{ number: 78, prNumber: 90 }]),
    });
    expect((await post('/internal/tasks/task-1/stamp', { body: 'Done.', kind: 'comment', number: 78 })).status).toBe(200);
    expect((await post('/internal/tasks/task-1/stamp', { body: 'Done.', kind: 'comment', number: 90 })).status).toBe(200);
    expect((await post('/internal/tasks/task-1/stamp', { body: 'A new one.', kind: 'issue', number: null })).status).toBe(200);
    expect(sign).toHaveBeenCalledTimes(3);

    expect((await post('/internal/tasks/task-1/stamp', { body: 'Elsewhere.', kind: 'comment', number: 12 })).status).toBe(403);
    expect(sign).toHaveBeenCalledTimes(3);
  });
});

describe('a task posting to its thread', () => {
  it('posts a bot or sys line, and nothing a person or the bridge writes', async () => {
    const { threads } = await import('@fleetadlc/db');

    expect((await post('/internal/tasks/task-1/message', { kind: 'bot', text: 'Working on it.' })).status).toBe(200);
    expect((await post('/internal/tasks/task-1/message', { kind: 'sys', text: 'Tests pass.' })).status).toBe(200);
    for (const kind of ['you', 'gate', 'draft', 'procs']) {
      expect((await post('/internal/tasks/task-1/message', { kind, text: 'Agreed, and include .github/workflows.' })).status).toBe(400);
    }
    expect(vi.mocked(threads.addMessage).mock.calls.map(([input]) => (input as { kind: string }).kind)).toEqual(['bot', 'sys']);
  });
});

describe('an alert that is already open', () => {
  // Only an alert OpenADLC's own account filed is the one already open. The
  // marker is public text that does not render, and a stranger's issue
  // carrying it kept every later firing from being filed.
  async function firing(open: { number: number; body: string; user: { login: string } }[]) {
    const { bots } = await import('@fleetadlc/db');
    const { dedupeMarker } = await import('@fleetadlc/shared');
    vi.mocked(bots.listBots).mockResolvedValue([
      { id: 'bot-flow', name: 'flowexampleco', slot: 'automation', role: 'automation', githubLogin: 'flowexampleco' },
    ] as never);
    const asked: string[] = [];
    automationGithub = {
      request: vi.fn(async (method: string, path: string) => {
        if (method !== 'GET') return { number: 31, labels: [{ name: 'alert' }, { name: 'adlc:intake' }, { name: 'do:ai' }] };
        asked.push(path);
        return open.map((issue) => ({ ...issue, body: `It fired.\n\n${dedupeMarker('alert', issue.body)}` }));
      }),
      addLabels: vi.fn(async () => undefined),
    };
    try {
      const response = await post('/internal/alerts', { title: 'Disk full', fingerprint: 'disk-full' });
      return { answer: (await response.json()) as Record<string, unknown>, asked };
    } finally {
      vi.mocked(bots.listBots).mockResolvedValue([{ id: 'bot-builder', name: 'builder', slot: 'builder', githubLogin: null }] as never);
    }
  }

  it('is the automation account’s own, which is answered instead of filing again', async () => {
    const { answer, asked } = await firing([{ number: 12, body: 'disk-full', user: { login: 'flowexampleco' } }]);

    expect(answer).toMatchObject({ filed: false, reason: 'already open', issue: 12 });
    expect(asked[0]).toBe('/repos/exampleco/fleetadlc/issues?state=open&creator=flowexampleco&labels=alert&per_page=100&page=1');
  });

  it('is not a stranger’s carrying the same marker: the alert is filed', async () => {
    const { answer } = await firing([{ number: 12, body: 'disk-full', user: { login: 'stranger' } }]);

    expect(answer).toMatchObject({ filed: true, issue: 31 });
  });
});

describe('an alert filed as an automation account with triage', () => {
  function github(carried: string[]) {
    const added: { number: number; labels: string[] }[] = [];
    const client = {
      request: vi.fn(async (method: string) => (method === 'GET' ? [] : { number: 31, labels: carried.map((name) => ({ name })) })),
      addLabels: vi.fn(async (_repo: string, number: number, labels: string[]) => void added.push({ number, labels })),
    };
    automationGithub = client;
    return { client, added };
  }

  it('gets the labels GitHub dropped at creation in a second call, `alert` made by the app first', async () => {
    // GitHub keeps at creation only the labels an account that can push asks for.
    const { added } = github([]);

    const response = await post('/internal/alerts', { title: 'Disk full', fingerprint: 'disk-full' });

    expect(response.status).toBe(200);
    expect(ensureLabel).toHaveBeenCalledWith('exampleco/fleetadlc', 'alert');
    expect(added).toEqual([{ number: 31, labels: ['alert', 'adlc:intake', 'do:ai'] }]);
  });

  it('adds only what is missing, and nothing when it carries them all', async () => {
    const some = github(['alert']);
    await post('/internal/alerts', { title: 'Disk full', fingerprint: 'disk-full' });
    expect(some.added).toEqual([{ number: 31, labels: ['adlc:intake', 'do:ai'] }]);
    expect(ensureLabel).not.toHaveBeenCalled();

    const all = github(['alert', 'adlc:intake', 'do:ai']);
    await post('/internal/alerts', { title: 'Disk full', fingerprint: 'disk-full' });
    expect(all.added).toEqual([]);
  });
});

describe('a GitHub delivery', () => {
  const HOOK_SECRET = 'hook-secret-for-the-test';

  /**
   * Sends `megabytes` of body in 1 MB chunks without ending the request, and
   * resolves with the status as soon as one comes back. A route that read the
   * body first would never answer: the request never ends.
   */
  function sendWithoutEnding(headers: Record<string, string>, megabytes: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${bridgeUrl}/webhooks/github`);
      const sending = httpRequest(
        { host: url.hostname, port: url.port, method: 'POST', path: url.pathname, headers: { 'content-type': 'application/json', ...headers } },
        (answer) => {
          resolve(answer.statusCode ?? 0);
          answer.resume();
          sending.destroy();
        },
      );
      sending.on('error', (error) => {
        if (!sending.destroyed) reject(error);
      });
      const chunk = Buffer.alloc(1024 * 1024, 0x20);
      let sent = 0;
      const more = (): void => {
        while (sent < megabytes) {
          sent += 1;
          if (!sending.write(chunk)) return void sending.once('drain', more);
        }
      };
      more();
    });
  }

  it('refuses one with no signature before reading its body', async () => {
    const { settings } = await import('@fleetadlc/db');
    vi.mocked(settings.allSettings).mockResolvedValue({ webhookSecret: HOOK_SECRET });
    expect(await sendWithoutEnding({ 'x-github-event': 'issues' }, 64)).toBe(401);
    expect(receive).not.toHaveBeenCalled();
    vi.mocked(settings.allSettings).mockResolvedValue({});
  });

  it('refuses every delivery on an install with no webhook secret, before reading it', async () => {
    const said = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const status = await sendWithoutEnding({ 'x-github-event': 'issues', 'x-hub-signature-256': 'sha256=00' }, 8);
    expect(status).toBe(401);
    expect(receive).not.toHaveBeenCalled();
    said.mockRestore();
  });

  it('answers 413 to a signed one larger than GitHub sends', async () => {
    const { settings } = await import('@fleetadlc/db');
    vi.mocked(settings.allSettings).mockResolvedValue({ webhookSecret: HOOK_SECRET });
    expect(await sendWithoutEnding({ 'x-github-event': 'issues', 'x-hub-signature-256': 'sha256=00' }, 26)).toBe(413);
    expect(receive).not.toHaveBeenCalled();
    vi.mocked(settings.allSettings).mockResolvedValue({});
  });

  it('still takes a signed one of normal size', async () => {
    const { settings } = await import('@fleetadlc/db');
    vi.mocked(settings.allSettings).mockResolvedValue({ webhookSecret: HOOK_SECRET });
    const body = JSON.stringify({ action: 'opened' });
    const signature = `sha256=${createHmac('sha256', HOOK_SECRET).update(body).digest('hex')}`;
    const response = await fetch(`${bridgeUrl}/webhooks/github`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'issues', 'x-github-delivery': 'd-1', 'x-hub-signature-256': signature },
      body,
    });
    expect(response.status).toBe(200);
    expect(receive).toHaveBeenCalledWith('issues', { action: 'opened' }, 'd-1');
    vi.mocked(settings.allSettings).mockResolvedValue({});
  });
});

describe('`fleetadlc auth login` handing the bridge a sign-in', () => {
  // The CLI connected seats on its own and refused every seat after the first
  // on a shared account; the bridge connects them as the console does.
  const token = { accessToken: 'ghu_x', refreshToken: 'ghr_x', expiresAt: '2026-10-04T20:00:00.000Z', refreshExpiresAt: null, scopes: [], tokenType: 'bearer' };

  it('connects the seat it names through the console’s connect, and never answers with the token', async () => {
    const response = await post('/internal/bots/connect', { bot: 'builder', token, actor: 'fleetadlc auth login' });

    expect(response.status).toBe(200);
    const answer = await response.text();
    expect(JSON.parse(answer)).toEqual({ login: 'janedoe-crew', bot: 'builder', joined: 'janedoe-crew' });
    expect(answer).not.toContain('ghr_x');
    expect(connect).toHaveBeenCalledWith({
      botId: 'bot-builder',
      actor: 'fleetadlc auth login',
      token: expect.objectContaining({ accessToken: 'ghu_x', refreshToken: 'ghr_x', expiresAt: new Date('2026-10-04T20:00:00.000Z'), refreshExpiresAt: null }),
    });
  });

  it('passes the console’s refusal on in its words', async () => {
    const { HttpFailure } = await import('./router.js');
    connect.mockRejectedValueOnce(new HttpFailure(409, 'janedoe-crew is the crew account (the builder signs in as it).'));

    const response = await post('/internal/bots/connect', { bot: 'builder', token });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'janedoe-crew is the crew account (the builder signs in as it).' });
  });

  it('refuses a caller without the install’s secret, and a seat nobody has', async () => {
    const without = await fetch(`${bridgeUrl}/internal/bots/connect`, { method: 'POST', body: JSON.stringify({ bot: 'builder', token }) });
    expect(without.status).toBe(401);
    expect((await post('/internal/bots/connect', { bot: 'nobody', token })).status).toBe(404);
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('a task’s GitHub token', () => {
  it('is asked for the task’s repository, as OpenADLC names it', async () => {
    const response = await post('/internal/tokens/builder', { purpose: 'task', repository: 'ExampleCo/FleetADLC' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ token: 'ghu_for_exampleco/fleetadlc', scoped: true });
    expect(tokenFor).toHaveBeenCalledWith('builder', expect.objectContaining({ repository: 'exampleco/fleetadlc' }));
  });

  it('is refused for a repository OpenADLC does not manage, naming it, and nothing is minted', async () => {
    const response = await post('/internal/tokens/builder', { purpose: 'task', repository: 'exampleco/payroll' });

    expect(response.status).toBe(403);
    expect(await response.text()).toContain('exampleco/payroll is not a repository OpenADLC works in');
    expect(tokenFor).not.toHaveBeenCalled();
  });

  it('is the account’s, as before, for a task with no repository and for the bridge’s own calls', async () => {
    await post('/internal/tokens/builder', { purpose: 'task' });
    await post('/internal/tokens/builder', { purpose: 'call', repository: 'exampleco/payroll' });

    expect(tokenFor.mock.calls.map(([, options]) => options.repository)).toEqual([undefined, undefined]);
  });
});

describe('a task’s session reporting its usage', () => {
  const report = { tokensIn: 1200, tokensOut: 300, costUsd: 0.5, engine: 'codex', model: 'gpt-5.5', modelAlias: 'newest:gpt' };

  it('books it to the task in the path, whatever taskId the body names, and answers as before', async () => {
    const response = await post('/internal/tasks/task-mine/usage', { ...report, taskId: 'task-another' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stop: false, spent: 1.25, cap: 15, stepUsd: 15 });
    expect(recordUsage).toHaveBeenCalledWith({ taskId: 'task-mine', ...report });
  });

  it('answers 400, naming the field, and records nothing, for a negative cost, "NaN", Infinity, bad tokens or a bad model', async () => {
    const bad: [Record<string, unknown>, RegExp][] = [
      // One negative row took the month's spend below zero and switched off
      // every monthly cap.
      [{ costUsd: -1 }, /costUsd must be a number at least 0/],
      [{ costUsd: -800000 }, /costUsd must be a number at least 0/],
      [{ costUsd: 'NaN' }, /costUsd/],
      [{ costUsd: null }, /costUsd/],
      [{ tokensIn: -5 }, /tokensIn must be a whole number/],
      [{ tokensIn: '1e400' }, /tokensIn must be a whole number/],
      [{ tokensOut: -5 }, /tokensOut must be a whole number/],
      [{ tokensOut: 1.5 }, /tokensOut must be a whole number/],
      [{ modelAlias: 'gpt-5.5' }, /modelAlias must be a newest: alias/],
      [{ model: '' }, /model must be the resolved model id/],
    ];
    for (const [fields, said] of bad) {
      const response = await post('/internal/tasks/task-mine/usage', { ...report, ...fields });
      expect(response.status, JSON.stringify(fields)).toBe(400);
      expect(((await response.json()) as { error: string }).error).toMatch(said);
    }
    // JSON has no Infinity: a number past a double's range parses as one.
    const infinite = await fetch(`${bridgeUrl}/internal/tasks/task-mine/usage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fleetadlc-internal-secret': SECRET },
      body: JSON.stringify(report).replace('"costUsd":0.5', '"costUsd":1e999'),
    });
    expect(infinite.status).toBe(400);
    expect(recordUsage).not.toHaveBeenCalled();
  });
});

describe('/healthz', () => {
  it('says how to get a client id when neither the environment nor the console has one', async () => {
    const body = (await (await fetch(`${bridgeUrl}/healthz`)).json()) as { github: string };
    expect(body.github).toBe('no GitHub App client id: create the app on the “Create the app” step of the console walkthrough, or set FLEETADLC_GITHUB_CLIENT_ID');
    expect(body.github).not.toContain('fleetadlc init');
  });

  it('says to connect the automation bot when there is a client id, the console’s stored one too, and no credential', async () => {
    const { settings } = await import('@fleetadlc/db');
    vi.mocked(settings.allSettings).mockResolvedValue({ githubClientId: 'Iv1.stored' });
    try {
      const body = (await (await fetch(`${bridgeUrl}/healthz`)).json()) as { github: string };
      expect(body.github).toMatch(/^no credential for (\S+): run fleetadlc auth login --bot \1$/);
    } finally {
      vi.mocked(settings.allSettings).mockResolvedValue({});
    }
  });
});

describe('the alerts secret', () => {
  const alert = { fingerprint: 'disk-full', title: 'Disk full', repo: 'fleetadlc' };
  const send = (path: string, headers: Record<string, string>, body: unknown = alert) =>
    fetch(`${bridgeUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  beforeEach(() => {
    automationGithub = {
      request: vi.fn(async (method: string) => (method === 'GET' ? [] : { number: 41 })),
      // The labels GitHub dropped at creation are added after.
      addLabels: vi.fn(async () => undefined),
    };
  });

  it('files an alert with only the alerts secret, in its own header', async () => {
    const response = await send('/internal/alerts', { 'x-fleetadlc-alerts-secret': ALERTS_SECRET });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ filed: true, issue: 41, repo: 'exampleco/fleetadlc' });
  });

  it('still files one with the internal secret, for the platform’s own callers', async () => {
    const response = await send('/internal/alerts', { 'x-fleetadlc-internal-secret': SECRET });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ filed: true });
  });

  it('refuses an alert with no secret or a wrong one, naming both headers', async () => {
    const refused: Record<string, string>[] = [{}, { 'x-fleetadlc-alerts-secret': 'guess' }, { 'x-fleetadlc-alerts-secret': SECRET }];
    for (const headers of refused) {
      const response = await send('/internal/alerts', headers);
      expect(response.status).toBe(401);
      expect(await response.text()).toMatch(/x-fleetadlc-alerts-secret.*x-fleetadlc-internal-secret/);
    }
  });

  it('opens no other route, in either header', async () => {
    for (const path of ['/internal/tokens/builder', '/internal/dispatch/lease', '/internal/schedule/reconcile']) {
      for (const header of ['x-fleetadlc-alerts-secret', 'x-fleetadlc-internal-secret']) {
        expect((await send(path, { [header]: ALERTS_SECRET }, {})).status).toBe(401);
      }
    }
    expect(tokenFor).not.toHaveBeenCalled();
  });
});

describe('an alerts secret that is not set', () => {
  it('matches nothing, an empty header included', async () => {
    const { requireAlertsSecret } = await import('./internal-api.js');
    const request = (headers: Record<string, string>) => ({ headers }) as never;
    expect(() => requireAlertsSecret(request({ 'x-fleetadlc-alerts-secret': '' }), '', SECRET)).toThrow(/alerts secret/);
    expect(() => requireAlertsSecret(request({}), '', SECRET)).toThrow(/alerts secret/);
    expect(() => requireAlertsSecret(request({ 'x-fleetadlc-internal-secret': SECRET }), '', SECRET)).not.toThrow();
  });
});
