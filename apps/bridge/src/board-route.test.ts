import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The board and the crew as the console reads them: what a card has cost and
 * who is on it now, and what each bot is doing — from the tasks, never from the
 * `status` column nothing updates.
 */

const ISSUES = [
  {
    id: 'issue-16',
    repoId: 'repo-1',
    repoName: 'fleetadlc-testbed',
    number: 16,
    title: 'Let the board filter by label',
    stage: 'build',
    labels: ['adlc:build', 'start:now'],
    declaredPaths: [],
    prChangedPaths: [],
    body: '',
    url: 'https://github.com/janedoe/fleetadlc-testbed/issues/16',
    prNumber: null,
    updatedAt: '2026-09-24T11:00:00.000Z',
    createdAt: '2026-09-24T10:00:00.000Z',
  },
  {
    id: 'issue-12',
    repoId: 'repo-1',
    repoName: 'fleetadlc-testbed',
    number: 12,
    title: 'Record which model each review used',
    stage: 'review',
    labels: ['adlc:review'],
    declaredPaths: [],
    prChangedPaths: [],
    body: '',
    url: 'https://github.com/janedoe/fleetadlc-testbed/issues/12',
    prNumber: 31,
    updatedAt: '2026-09-24T11:00:00.000Z',
    createdAt: '2026-09-23T10:00:00.000Z',
  },
];

/** An issue in a repository removed from OpenADLC: its row stays, as history. */
const RETIRED = { ...ISSUES[0]!, id: 'issue-3', repoId: 'repo-old', repoName: 'retired', number: 3, title: 'Something from before' };

/** A finished task whose own send-back moved its card; none of these. */
const SENT_BACK = 'no-such-task';

const TASKS: {
  id: string;
  botId: string;
  repoId: string;
  kind: string;
  subjectType: string;
  subjectRef: string;
  state: string;
  round: number;
  costUsd: number;
  startedAt: string | null;
  endedAt: string | null;
  exitReason: string | null;
  createdAt: string;
}[] = [
  {
    id: 'task-build',
    botId: 'bot-builder',
    repoId: 'repo-1',
    kind: 'implement',
    subjectType: 'issue',
    subjectRef: 'fleetadlc-testbed#16',
    state: 'running',
    round: 0,
    costUsd: 0.84,
    startedAt: '2026-09-24T11:48:00.000Z',
    endedAt: null,
    exitReason: null,
    createdAt: '2026-09-24T11:47:00.000Z',
  },
  {
    id: 'task-review',
    botId: 'bot-second',
    repoId: 'repo-1',
    kind: 'review',
    subjectType: 'pr',
    subjectRef: 'fleetadlc-testbed#31',
    state: 'running',
    round: 0,
    costUsd: 0.38,
    startedAt: '2026-09-24T11:54:00.000Z',
    endedAt: null,
    exitReason: null,
    createdAt: '2026-09-24T11:53:00.000Z',
  },
  {
    id: 'task-patch',
    botId: 'bot-builder',
    repoId: 'repo-1',
    kind: 'patch',
    subjectType: 'pr',
    subjectRef: 'fleetadlc-testbed#31',
    state: 'done',
    round: 1,
    costUsd: 0.98,
    startedAt: '2026-09-24T11:30:00.000Z',
    endedAt: '2026-09-24T11:40:00.000Z',
    exitReason: null,
    createdAt: '2026-09-24T11:29:00.000Z',
  },
];

const CREW = [
  { id: 'bot-builder', name: 'fleetadlc-atlas-janedoe', slot: 'builder', displayName: 'builder', role: 'implement', status: 'stopped' },
  { id: 'bot-second', name: 'irisexampleco', slot: 'second-reviewer', displayName: 'second reviewer', role: 'review_second', status: 'stopped' },
  { id: 'bot-intake', name: 'ottoexampleco', slot: 'intake', displayName: 'intake', role: 'intake', status: 'stopped' },
];

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
  bots: { listBots: vi.fn(async () => CREW) },
  costs: {},
  credentials: { getCredential: vi.fn(async () => ({ status: 'active', tokenExpiresAt: null })) },
  issues: {
    boardCards: vi.fn(async () =>
      [...ISSUES, RETIRED].map((issue) => ({
        repo: issue.repoName,
        ref: `${issue.repoName}#${issue.number}`,
        title: issue.title,
        stage: issue.stage,
        assignees: issue.number === 16 ? ['fleetadlc-atlas-janedoe'] : [],
        gateOpen: false,
        url: issue.url,
        labels: issue.labels,
        updatedAt: issue.updatedAt,
      })),
    ),
    listIssues: vi.fn(async () => ISSUES),
  },
  leases: {},
  listAudit: vi.fn(),
  listEventsOfType: vi.fn(async () => []),
  mergeLines: { line: vi.fn(async () => []) },
  modelAccounts: {},
  recordEvent: vi.fn(),
  repos: {
    listRepos: vi.fn(async () => [
      { id: 'repo-1', name: 'fleetadlc-testbed', fullName: 'janedoe/fleetadlc-testbed', stageModes: { merged: 'autonomous' }, color: 'teal' },
      { id: 'repo-2', name: 'website', fullName: 'janedoe/website', stageModes: {}, color: 'amber' },
    ]),
  },
  requests: { listRequests: vi.fn(async () => []) },
  sessions: { listSessions: vi.fn(async () => []) },
  settings: {
    allSettings: vi.fn(async () => ({})),
    // The builder paused from Crew.
    getSetting: vi.fn(async (key: string) =>
      key === 'workPausedSeats' ? JSON.stringify({ 'fleetadlc-atlas-janedoe': { by: 'janedoe', at: '2026-10-02T10:00:00.000Z', why: 'changing its model' } }) : null,
    ),
  },
  stageMoves: { sendBackOfTask: vi.fn(async (taskId: string) => (taskId === SENT_BACK ? { kind: 'send_back' } : null)) },
  tasks: {
    listTasksOnSubjects: vi.fn(async (refs: readonly string[]) => TASKS.filter((task) => refs.includes(task.subjectRef))),
    listTasks: vi.fn(async (filter: { botId?: string; states?: string[] }) =>
      TASKS.filter(
        (task) => (!filter.botId || task.botId === filter.botId) && (!filter.states || filter.states.includes(task.state)),
      ),
    ),
    listTasksForSubjects: vi.fn(async (kind: string, refs: readonly string[]) =>
      TASKS.filter((task) => task.kind === kind && refs.includes(task.subjectRef)),
    ),
  },
  threads: { listOpenGates: vi.fn(async () => []) },
}));

let bridge: Server;
let bridgeUrl: string;

beforeEach(async () => {
  const { registerConsoleApi } = await import('./api.js');
  const { Router } = await import('./router.js');
  const router = new Router();
  registerConsoleApi(router, {
    config: { gitHubClientId: '', webhookSecret: '', humans: [], review: { maxRounds: 3 } } as never,
    hostd: {} as never,
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
  await new Promise<void>((resolve) => bridge.close(() => resolve()));
});

interface Column {
  stage: string;
  bots: { name: string; working: boolean; waiting: boolean }[];
  cards: Record<string, unknown>[];
}

describe('GET /v1/board', () => {
  it('gives each card what it has cost so far and who is on it now', async () => {
    const response = await fetch(`${bridgeUrl}/v1/board`);
    expect(response.status).toBe(200);
    const board = (await response.json()) as { columns: Column[] };

    const build = board.columns.find((column) => column.stage === 'build');
    expect(build?.cards[0]).toMatchObject({
      ref: 'fleetadlc-testbed#16',
      number: 16,
      costUsd: 0.84,
      assignees: ['fleetadlc-atlas-janedoe'],
      active: [{ bot: 'fleetadlc-atlas-janedoe', kind: 'implement', state: 'running', startedAt: '2026-09-24T11:48:00.000Z' }],
    });

    // The reviewer is on the pull request, and the card is the issue's: the
    // store's own assignees missed it.
    const review = board.columns.find((column) => column.stage === 'review');
    expect(review?.cards[0]).toMatchObject({
      ref: 'fleetadlc-testbed#12',
      prNumber: 31,
      costUsd: 1.36,
      assignees: ['irisexampleco'],
      reviewRound: 2,
      stalledAfterRounds: null,
    });
  });

  it('names each repository with the colour it is told apart by', async () => {
    const board = (await (await fetch(`${bridgeUrl}/v1/board`)).json()) as { repos: string[]; repositories: unknown[] };
    expect(board.repos).toEqual(['fleetadlc-testbed', 'website']);
    expect(board.repositories).toEqual([
      { name: 'fleetadlc-testbed', fullName: 'janedoe/fleetadlc-testbed', color: 'teal' },
      { name: 'website', fullName: 'janedoe/website', color: 'amber' },
    ]);
  });

  it('leaves off the cards of a repository removed from OpenADLC, which are history now', async () => {
    const board = (await (await fetch(`${bridgeUrl}/v1/board`)).json()) as { columns: Column[] };
    const refs = board.columns.flatMap((column) => column.cards.map((card) => card.ref));
    expect(refs).toContain('fleetadlc-testbed#16');
    expect(refs).not.toContain('retired#3');
  });

  it('leaves off an issue labelled fleetadlc:ignore and its pull request in the merge line, and brings them back without it', async () => {
    const { issues, mergeLines } = await import('@fleetadlc/db');
    const entry = (prNumber: number) => ({ repoName: 'fleetadlc-testbed', prNumber, position: prNumber === 31 ? 1 : 2, state: 'queued', detail: null, enteredAt: '2026-09-24T11:00:00.000Z' });
    const read = async (labels: string[]) => {
      const labelled = ISSUES.map((one) => (one.number === 12 ? { ...one, labels } : one));
      vi.mocked(issues.listIssues).mockResolvedValueOnce(labelled as never);
      vi.mocked(mergeLines.line).mockResolvedValueOnce([entry(31), entry(40)] as never);
      const board = (await (await fetch(`${bridgeUrl}/v1/board`)).json()) as { columns: Column[]; mergeLine: { ref: string }[] };
      return { cards: board.columns.flatMap((column) => column.cards.map((card) => card.ref)), line: board.mergeLine.map((one) => one.ref) };
    };

    const ignored = await read(['adlc:review', 'fleetadlc:ignore']);
    expect(ignored.cards).toContain('fleetadlc-testbed#16');
    expect(ignored.cards).not.toContain('fleetadlc-testbed#12');
    expect(ignored.line).toEqual(['fleetadlc-testbed#40']);

    const back = await read(['adlc:review']);
    expect(back.cards).toContain('fleetadlc-testbed#12');
    expect(back.line).toEqual(['fleetadlc-testbed#31', 'fleetadlc-testbed#40']);
  });

  it('puts a request intake is asking about in Intake, on its repository’s board and not another’s', async () => {
    const { requests, threads } = await import('@fleetadlc/db');
    const asking = {
      ...TASKS[0]!,
      id: 'task-intake',
      botId: 'bot-intake',
      kind: 'intake',
      subjectType: 'request',
      subjectRef: 'request:57796b82',
      state: 'paused',
      costUsd: 0.41,
    };
    TASKS.push(asking);
    const request = {
      id: '57796b82-0000-4000-8000-000000000000',
      text: 'Add a keyboard-controlled snake game at snake.html',
      context: null,
      repoId: 'repo-1',
      kind: 'feature',
      requestedBy: 'janedoe',
      issueNumber: null,
      state: 'questions',
      createdAt: '2026-09-25T18:35:23.000Z',
    };
    vi.mocked(requests.listRequests).mockResolvedValue([request] as never);
    vi.mocked(threads.listOpenGates).mockResolvedValue([{ taskId: 'task-intake' }] as never);
    try {
      const intakeOf = async (query: string) => {
        const board = (await (await fetch(`${bridgeUrl}/v1/board${query}`)).json()) as { columns: Column[] };
        return board.columns.find((column) => column.stage === 'intake')?.cards ?? [];
      };

      expect(await intakeOf('')).toEqual([
        expect.objectContaining({
          ref: 'request:57796b82',
          repo: 'fleetadlc-testbed',
          title: 'Add a keyboard-controlled snake game at snake.html',
          request: true,
          gateOpen: true,
          costUsd: 0.41,
        }),
      ]);
      expect(await intakeOf('?repo=fleetadlc-testbed')).toHaveLength(1);
      expect(await intakeOf('?repo=website')).toEqual([]);
    } finally {
      TASKS.pop();
      vi.mocked(requests.listRequests).mockResolvedValue([]);
      vi.mocked(threads.listOpenGates).mockResolvedValue([]);
    }
  });

  it('says a staffing bot is working when its task is, whatever the sessions say', async () => {
    const board = (await (await fetch(`${bridgeUrl}/v1/board`)).json()) as { columns: Column[] };
    const review = board.columns.find((column) => column.stage === 'review');
    expect(review?.bots).toEqual([{ name: 'irisexampleco', displayName: 'second reviewer', working: true, waiting: false }]);
  });
});

describe('GET /v1/bots', () => {
  it('says what each bot is doing from its tasks', async () => {
    const body = (await (await fetch(`${bridgeUrl}/v1/bots`)).json()) as {
      bots: { name: string; task: Record<string, unknown> | null; lastTask: Record<string, unknown> | null }[];
    };

    const reviewer = body.bots.find((bot) => bot.name === 'irisexampleco');
    expect(reviewer?.task).toMatchObject({
      kind: 'review',
      state: 'running',
      // Which repository, since a bot works in any of them.
      repo: 'fleetadlc-testbed',
      issue: { repo: 'fleetadlc-testbed', number: 12, title: 'Record which model each review used' },
      round: 2,
      // Round two of the three config/review.yaml allows, and this review's own cost.
      maxRounds: 3,
      costUsd: 0.38,
      waitingOnYou: false,
    });

    const builder = body.bots.find((bot) => bot.name === 'fleetadlc-atlas-janedoe');
    expect(builder?.task).toMatchObject({ kind: 'implement', issue: { number: 16 }, costUsd: 0.84 });
    expect(builder?.lastTask).toMatchObject({ kind: 'patch', state: 'done', issue: { number: 12 } });
  });

  it('says each seat’s pause, its work in hand, what it last finished and how, and its health, for the Crew page', async () => {
    const body = (await (await fetch(`${bridgeUrl}/v1/bots`)).json()) as { bots: Record<string, unknown>[] };
    const builder = body.bots.find((bot) => bot.name === 'fleetadlc-atlas-janedoe');
    const reviewer = body.bots.find((bot) => bot.name === 'irisexampleco');

    expect(builder?.seatPaused).toEqual({ by: 'janedoe', at: '2026-10-02T10:00:00.000Z', why: 'changing its model' });
    expect(reviewer?.seatPaused).toBeNull();
    expect(builder?.queue).toMatchObject({ running: 1, waiting: 0, queued: 0, next: null });
    expect(builder?.recent).toEqual([
      // With what it cost: the seat panel's History says so beside each.
      expect.objectContaining({ ref: 'fleetadlc-testbed#31', kind: 'patch', outcome: 'done', title: 'Record which model each review used', item: 'fleetadlc-testbed#12', costUsd: 0.98 }),
    ]);
    expect(builder?.health).toEqual({ state: 'ok', reasons: [] });
  });

  it('says a seat’s health as one state, failing over warning, with the way to fix each, what stops it first', async () => {
    const { healthOf } = await import('./api.js');
    expect(healthOf([])).toEqual({ state: 'ok', reasons: [] });
    expect(
      healthOf([
        { title: 'Its key expires soon', checkId: 'token-expiry', severity: 'warning', action: null },
        { title: 'It cannot sign in', checkId: 'bot-sign-in', severity: 'blocking', action: { label: 'Reconnect it', href: '/settings#github' } },
        { title: 'Run a command', checkId: 'x', severity: 'warning', action: { label: 'Copy', command: 'fleetadlc up' } },
      ]),
    ).toEqual({
      state: 'failing',
      // Blocking first: its fix is the one the crew page offers.
      reasons: [
        { title: 'It cannot sign in', action: { label: 'Reconnect it', href: '/settings#github' } },
        { title: 'Its key expires soon', action: null },
        { title: 'Run a command', action: null },
      ],
    });
    expect(healthOf([{ title: 'Soon', checkId: 'token-expiry', severity: 'warning', action: null }]).state).toBe('warning');
  });
});

describe('GET /v1/repos', () => {
  it('says how many rounds a review runs before it stops, for settings to say it', async () => {
    const body = (await (await fetch(`${bridgeUrl}/v1/repos`)).json()) as { maxReviewRounds: number | null };
    expect(body.maxReviewRounds).toBe(3);
  });
});
