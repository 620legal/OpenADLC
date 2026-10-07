import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A task that ends without finishing says so in its bot's thread.
 *
 * Its start was said there and its end was not, so a triage that failed three
 * seconds in — its engine could not be found — left the thread at "started
 * triage" and "reading intake.md", and the person who filed the request waited
 * for work that had already stopped.
 */

const said = vi.hoisted(() => ({
  /** What asked for a dispatch: a task ending frees a builder. */
  asked: [] as string[],
  messages: [] as { kind?: string; author?: string; text?: string; at?: string; payload: Record<string, unknown> | null }[],
  /** What GitHub lists as the pull request's reviews; an Error when it cannot be asked. */
  reviews: [] as { user: string; submittedAt: string | null }[] | Error,
}));

const REASON =
  'engine claude is not available on this host, so triage cannot run. Install it, or change this bot’s engine in config/bots.yaml.';

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
    getBotById: vi.fn(async (id: string) =>
      id === 'bot-intake'
        ? { id, name: 'ottoexampleco', slot: 'intake', role: 'intake', displayName: 'Intake' }
        : id === 'bot-lead'
          ? { id, name: 'noraexampleco', slot: 'lead-reviewer', role: 'review_lead', displayName: 'Lead reviewer', githubLogin: 'noraexampleco' }
          : null,
    ),
  },
  costs: {},
  credentials: {},
  issues: {},
  leases: {},
  listAudit: vi.fn(),
  mergeLines: {},
  recordEvent: vi.fn(),
  repos: {
    getRepoByName: vi.fn(async (name: string) => (name === 'fleetadlc-testbed' ? { name, fullName: 'janedoe/fleetadlc-testbed' } : null)),
  },
  // No request behind the subject: what a finished triage says about the
  // request it filed is `request-lifecycle.test.ts`'s to show.
  requests: { findRequestByPrefix: vi.fn(async () => null) },
  sessions: {},
  settings: { allSettings: vi.fn(async () => ({})) },
  tasks: {
    updateTaskState: vi.fn(async (id: string, state: string, extra: { exitReason: string | null }) =>
      id === 'task-review'
        ? {
            id,
            botId: 'bot-lead',
            repoId: 'repo-1',
            kind: 'review',
            subjectType: 'pr',
            subjectRef: 'fleetadlc-testbed#2',
            state,
            exitReason: extra.exitReason,
            startedAt: '2026-09-25T07:31:12.000Z',
          }
        : {
            id,
            botId: 'bot-intake',
            repoId: 'repo-1',
            kind: 'intake',
            subjectType: 'request',
            subjectRef: 'request:a4b02784',
            state,
            exitReason: extra.exitReason,
          },
    ),
    // What the task is before it ends: a review's verdict is settled before
    // the one write, since a task written done is not changed again.
    getTask: vi.fn(async (id: string) =>
      id === 'task-review'
        ? { id, botId: 'bot-lead', repoId: 'repo-1', kind: 'review', subjectType: 'pr', subjectRef: 'fleetadlc-testbed#2', state: 'running', exitReason: null, startedAt: '2026-09-25T07:31:12.000Z' }
        : { id, botId: 'bot-intake', repoId: 'repo-1', kind: 'intake', subjectType: 'request', subjectRef: 'request:a4b02784', state: 'running', exitReason: null },
    ),
  },
  threads: {
    ensureThread: vi.fn(async () => ({ id: 'thread-1' })),
    addMessage: vi.fn(async () => ({ id: 'message-1' })),
    listMessages: vi.fn(async () => said.messages),
    listThreadsForSubject: vi.fn(async () => [{ id: 'thread-1', bot_id: 'bot-lead', repo_id: 'repo-1', subject_ref: 'fleetadlc-testbed#2' }]),
  },
}));

import { tasks, threads } from '@fleetadlc/db';

const handedOn = vi.fn(async () => undefined);
const github = {
  listReviews: vi.fn(async () => {
    if (said.reviews instanceof Error) throw said.reviews;
    return said.reviews;
  }),
};

const SECRET = 'install-secret-for-the-test';
let bridge: Server;
let bridgeUrl: string;

beforeEach(async () => {
  const { registerInternalApi } = await import('./internal-api.js');
  const { Router } = await import('./router.js');
  const router = new Router();
  registerInternalApi(router, {
    config: { automationBot: null } as never,
    webhooks: {} as never,
    scheduler: {} as never,
    stages: { onTaskDone: handedOn } as never,
    internalSecret: SECRET,
    alertsSecret: '',
    hostd: { cleanupTask: async () => undefined } as never,
    actors: { asBot: async () => github } as never,
    automation: {} as never,
    gates: {} as never,
    taskService: {} as never,
    onboarding: {} as never,
    invitations: {} as never,
    threadStream: {} as never,
    webhookSetup: {} as never,
    repoSetup: {} as never,
    names: {} as never,
    dispatchRuns: { soon: (reason: string) => said.asked.push(reason) },
  });
  bridge = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  bridgeUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
});

afterEach(async () => {
  said.asked = [];
  said.messages = [];
  said.reviews = [];
  vi.mocked(threads.addMessage).mockClear();
  vi.mocked(tasks.updateTaskState).mockClear();
  handedOn.mockClear();
  await new Promise<void>((resolve) => bridge.close(() => resolve()));
});

function end(state: string, reason?: string, task = 'task-1') {
  return fetch(`${bridgeUrl}/internal/tasks/${task}/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fleetadlc-internal-secret': SECRET },
    body: JSON.stringify({ state, ...(reason ? { reason } : {}) }),
  });
}

describe('a task that ends without finishing', () => {
  it('says in its bot’s thread that it failed, and why', async () => {
    expect((await end('failed', REASON)).status).toBe(200);
    // Its builder is free: the next piece of work may start.
    expect(said.asked).toEqual(['intake task failed']);

    expect(vi.mocked(threads.ensureThread)).toHaveBeenCalledWith({
      botId: 'bot-intake',
      repoId: 'repo-1',
      subjectRef: 'request:a4b02784',
    });
    expect(vi.mocked(threads.addMessage)).toHaveBeenCalledWith({
      threadId: 'thread-1',
      kind: 'sys',
      author: 'fleetadlc',
      text: 'The intake bot (ottoexampleco) could not finish request:a4b02784',
      note: REASON,
      payload: { taskId: 'task-1', state: 'failed' },
    });
  });

  it('says it was stopped when something stopped it, and what stopped it', async () => {
    await end('stopped', 'hostd shutting down');

    expect(vi.mocked(threads.addMessage)).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'The intake bot (ottoexampleco) stopped work on request:a4b02784', note: 'hostd shutting down' }),
    );
  });

  it('says nothing more for a task that finished', async () => {
    await end('done');

    expect(vi.mocked(threads.addMessage)).not.toHaveBeenCalled();
  });

  it('says it once when the runner already said why it stopped', async () => {
    // The runner posts "triage stopped on request:…" with the engine's error,
    // then the state. Saying it again from here put two lines in the thread
    // for one failure.
    said.messages = [{ payload: { event: 'stopped', taskId: 'task-1' } }];
    await end('failed', 'engine exited 1: API Error: 400');

    expect(vi.mocked(threads.addMessage)).not.toHaveBeenCalled();
  });

  it('still says it when the line in the thread was about another task', async () => {
    said.messages = [{ payload: { event: 'stopped', taskId: 'an-earlier-task' } }];
    await end('failed', REASON);

    expect(vi.mocked(threads.addMessage)).toHaveBeenCalledTimes(1);
  });
});

describe('a review task that ends without its review', () => {
  const BLOCKED = 'I’m blocked from running any repo commands in this environment because the shell sandbox cannot start.';

  it('fails with what the reviewer last said, rather than reading done while the pull request waits on it', async () => {
    said.messages = [
      // The runner's own line, under the bot's name: not something it said.
      { kind: 'sys', author: 'noraexampleco', text: 'reading review_lead.md, AGENTS.md', at: '2026-09-25T07:31:13.000Z', payload: null },
      { kind: 'bot', author: 'noraexampleco', text: BLOCKED, at: '2026-09-25T07:31:18.000Z', payload: null },
      // OpenADLC's, in the same thread.
      { kind: 'sys', author: 'fleetadlc', text: 'Lead reviewer started pr-review', at: '2026-09-25T07:31:19.000Z', payload: null },
    ];

    expect((await end('done', 'complete', 'task-review')).status).toBe(200);

    // One write, failed: done then failed would have the second refused.
    expect(vi.mocked(tasks.updateTaskState).mock.calls).toEqual([
      ['task-review', 'failed', { exitReason: `ended without posting its review. It said: “${BLOCKED}”` }],
    ]);
    expect(vi.mocked(threads.addMessage)).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'The lead reviewer (noraexampleco) could not finish fleetadlc-testbed#2', payload: { taskId: 'task-review', state: 'failed' } }),
    );
    expect(handedOn).not.toHaveBeenCalled();
  });

  it('is done when its review is on the pull request', async () => {
    said.reviews = [{ user: 'noraexampleco', submittedAt: '2026-09-25T07:40:00.000Z' }];

    expect((await end('done', 'complete', 'task-review')).status).toBe(200);

    expect(vi.mocked(tasks.updateTaskState)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(tasks.updateTaskState)).toHaveBeenCalledWith('task-review', 'done', { exitReason: 'complete' });
    expect(vi.mocked(threads.addMessage)).not.toHaveBeenCalled();
    expect(handedOn).toHaveBeenCalledWith(expect.objectContaining({ kind: 'review', subjectRef: 'fleetadlc-testbed#2' }));
  });

  it('stays done when GitHub cannot be asked', async () => {
    said.reviews = new Error('GitHub answered 502');

    expect((await end('done', 'complete', 'task-review')).status).toBe(200);

    expect(vi.mocked(tasks.updateTaskState)).toHaveBeenCalledTimes(1);
    expect(handedOn).toHaveBeenCalled();
  });
});
