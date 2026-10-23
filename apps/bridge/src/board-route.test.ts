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
    repoName: 'openadlc-testbed',
    number: 16,
    title: 'Let the board filter by label',
    stage: 'build',
    labels: ['adlc:build', 'start:now'],
    declaredPaths: [],
    prChangedPaths: [],
    body: '',
    url: 'https://github.com/janedoe/openadlc-testbed/issues/16',
    prNumber: null,
    updatedAt: '2026-09-24T11:00:00.000Z',
    createdAt: '2026-09-24T10:00:00.000Z',
  },
  {
    id: 'issue-12',
    repoId: 'repo-1',
    repoName: 'openadlc-testbed',
    number: 12,
    title: 'Record which model each review used',
    stage: 'review',
    labels: ['adlc:review'],
    declaredPaths: [],
    prChangedPaths: [],
    body: '',
    url: 'https://github.com/janedoe/openadlc-testbed/issues/12',
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
    subjectRef: 'openadlc-testbed#16',
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
    subjectRef: 'openadlc-testbed#31',
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
    subjectRef: 'openadlc-testbed#31',
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
  { id: 'bot-builder', name: 'openadlc-atlas-janedoe', slot: 'builder', displayName: 'builder', role: 'implement', status: 'stopped' },
  { id: 'bot-second', name: 'irisexampleco', slot: 'second-reviewer', displayName: 'second reviewer', role: 'review_second', status: 'stopped' },
  { id: 'bot-intake', name: 'ottoexampleco', slot: 'intake', displayName: 'intake', role: 'intake', status: 'stopped' },
];

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

  audit: vi.fn(async () => undefined),
  AccountInUse: class AccountInUse extends Error {},
  bots: { listBots: vi.fn(async () => CREW) },
  costs: {},
  credentials: { getCredential: vi.fn(async () => ({ status: 'active', tokenExpiresAt: null })) },
  // The testbed's deploy-testing skipped its newest run; the website's deployed.
  deployRuns: {
    newestTestingEnd: vi.fn(async (repoId: string) =>
      repoId === 'repo-1'
        ? { testingConclusion: 'skipped', detail: 'deploy-testing run 39836758586 was skipped' }
        : { testingConclusion: 'success', detail: 'dispatching deploy-testing' },
    ),
  },
  issues: {
    boardCards: vi.fn(async () =>
      [...ISSUES, RETIRED].map((issue) => ({
        repo: issue.repoName,
        ref: `${issue.repoName}#${issue.number}`,
        title: issue.title,
        stage: issue.stage,
        assignees: issue.number === 16 ? ['openadlc-atlas-janedoe'] : [],
        gateOpen: false,
        url: issue.url,
        labels: issue.labels,
        updatedAt: issue.updatedAt,
      })),
    ),
    listIssues: vi.fn(async () => ISSUES),
    // What the board reads: the issues not in Done and the week's (`boardIssues`).
    boardIssues: vi.fn(async () => ISSUES),
    getIssues: vi.fn(async () => []),
    anyDoneBefore: vi.fn(async () => false),
    byNextFirst: (a: { createdAt: string; number: number }, b: { createdAt: string; number: number }) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.number - b.number,
  },
  leases: {},
  listAudit: vi.fn(),
  listEventsOfType: vi.fn(async () => []),
  mergeLines: { line: vi.fn(async () => []) },
  modelAccounts: {},
  recordEvent: vi.fn(),
  repos: {
    listRepos: vi.fn(async () => [
      { id: 'repo-1', name: 'openadlc-testbed', fullName: 'janedoe/openadlc-testbed', stageModes: { merged: 'autonomous' }, color: 'teal' },
      { id: 'repo-2', name: 'website', fullName: 'janedoe/website', stageModes: {}, color: 'amber' },
    ]),
  },
  requests: { listRequests: vi.fn(async () => []) },
  sessions: { listSessions: vi.fn(async () => []) },
  settings: {
    allSettings: vi.fn(async () => ({})),
    // The builder paused from Crew.
    getSetting: vi.fn(async (key: string) =>
      key === 'workPausedSeats' ? JSON.stringify({ 'openadlc-atlas-janedoe': { by: 'janedoe', at: '2026-10-02T10:00:00.000Z', why: 'changing its model' } }) : null,
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
  // Not numbered: the board as it was before work items, unless a test numbers it.
  workItems: { isNumbered: vi.fn(async () => false), boardLinks: vi.fn(async () => []) },
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
      ref: 'openadlc-testbed#16',
      number: 16,
      costUsd: 0.84,
      assignees: ['openadlc-atlas-janedoe'],
      active: [{ bot: 'openadlc-atlas-janedoe', kind: 'implement', state: 'running', startedAt: '2026-09-24T11:48:00.000Z' }],
    });

    // The reviewer is on the pull request, and the card is the issue's: the
    // store's own assignees missed it.
    const review = board.columns.find((column) => column.stage === 'review');
    expect(review?.cards[0]).toMatchObject({
      ref: 'openadlc-testbed#12',
      prNumber: 31,
      costUsd: 1.36,
      assignees: ['irisexampleco'],
      reviewRound: 2,
      stalledAfterRounds: null,
    });
  });

  it('says why a card with nothing going on it waits, since when, and that it is stuck, and nothing of waiting on a card with work going', async () => {
    // A design nothing has started since it arrived, with the design seat free.
    const design = { ...ISSUES[0]!, id: 'issue-141', number: 141, title: 'Say on a waiting card who it waits for', stage: 'spec', labels: ['adlc:spec'] };
    ISSUES.push(design);
    CREW.push({ id: 'bot-spec', name: 'system-engineer', slot: 'system-engineer', displayName: 'system engineer', role: 'spec', status: 'stopped' });
    try {
      const board = (await (await fetch(`${bridgeUrl}/v1/board`)).json()) as { columns: Column[] };
      const card = board.columns.find((column) => column.stage === 'spec')?.cards[0];
      expect(card).toMatchObject({
        ref: 'openadlc-testbed#141',
        waiting: { reason: { kind: 'free', seat: { name: 'system-engineer', role: 'spec', maxTasks: 1 }, by: 'sweep' }, since: '2026-09-24T11:00:00.000Z', stuck: true },
      });
      expect(board.columns.find((column) => column.stage === 'build')?.cards[0]).toMatchObject({ ref: 'openadlc-testbed#16', waiting: null });
    } finally {
      ISSUES.pop();
      CREW.pop();
    }
  });

  it('shows one card per work item, on the board of every repository it has a link in and once on all of them', async () => {
    const { workItems } = await import('@openadlc/db');
    const link = (id: number, itemId: string, itemNumber: number, kind: string, repoId: string, number: number, extra: Record<string, unknown> = {}) => ({
      id, itemId, itemNumber, kind, repoId, number, requestId: null, linkedBy: null, title: `${kind} ${number}`, state: 'open', url: null, openedAt: new Date().toISOString(), ...extra,
    });
    const links = [
      link(1, 'w-5', 5, 'issue', 'repo-1', 12),
      link(2, 'w-5', 5, 'pull', 'repo-1', 31),
      // A pull request in a second repository, linked by hand to the same work.
      link(3, 'w-5', 5, 'pull', 'repo-2', 9, { linkedBy: 'janedoe' }),
      link(4, 'w-6', 6, 'issue', 'repo-1', 16),
      // A person's pull request that closes no issue.
      link(5, 'w-7', 7, 'pull', 'repo-2', 50, { title: 'Fix a typo', state: 'open' }),
    ];
    const read = async (repo: string) => {
      vi.mocked(workItems.isNumbered).mockResolvedValueOnce(true);
      vi.mocked(workItems.boardLinks).mockResolvedValueOnce(links as never);
      const board = (await (await fetch(`${bridgeUrl}/v1/board?repo=${repo}`)).json()) as { columns: { stage: string; cards: { ref: string; item?: { key: string } | null; repos?: string[] }[] }[] };
      return board.columns.flatMap((column) => column.cards.map((card) => [column.stage, card.ref, card.item?.key ?? null, card.repos ?? []]));
    };

    expect(await read('all')).toEqual([
      ['build', 'openadlc-testbed#16', 'W-6', ['openadlc-testbed']],
      ['review', 'openadlc-testbed#12', 'W-5', ['openadlc-testbed', 'website']],
      ['review', 'website#50', 'W-7', ['website']],
    ]);
    expect(await read('website')).toEqual([
      ['review', 'openadlc-testbed#12', 'W-5', ['openadlc-testbed', 'website']],
      ['review', 'website#50', 'W-7', ['website']],
    ]);
  });

  it('sums into an item’s card the work on a pull request linked by hand in a second repository', async () => {
    const { workItems, threads } = await import('@openadlc/db');
    const link = (id: number, itemId: string, itemNumber: number, kind: string, repoId: string, number: number) => ({
      id, itemId, itemNumber, kind, repoId, number, requestId: null, linkedBy: null, title: `${kind} ${number}`, state: 'open', url: null, openedAt: new Date().toISOString(),
    });
    const review = { ...TASKS[1]!, id: 'task-website', botId: 'bot-intake', repoId: 'repo-2', subjectRef: 'website#9', state: 'paused', costUsd: 0.5 };
    TASKS.push(review);
    try {
      vi.mocked(workItems.isNumbered).mockResolvedValueOnce(true);
      vi.mocked(workItems.boardLinks).mockResolvedValueOnce([link(1, 'w-5', 5, 'issue', 'repo-1', 12), link(2, 'w-5', 5, 'pull', 'repo-1', 31), link(3, 'w-5', 5, 'pull', 'repo-2', 9)] as never);
      vi.mocked(threads.listOpenGates).mockResolvedValueOnce([{ taskId: 'task-website' }] as never);
      const board = (await (await fetch(`${bridgeUrl}/v1/board`)).json()) as { columns: Column[] };
      const card = board.columns.flatMap((column) => column.cards).find((one) => one.ref === 'openadlc-testbed#12');
      // 1.36 on the issue and its own pull request, and the review of website#9 besides.
      expect(card).toMatchObject({ costUsd: 1.86, gateOpen: true });
      expect(card?.assignees).toEqual(expect.arrayContaining(['irisexampleco', 'ottoexampleco']));
      expect(board.columns.flatMap((column) => column.cards).map((one) => one.ref)).not.toContain('website#9');
    } finally {
      TASKS.pop();
    }
  });

  it('keeps a lone pull request in Done for the week from when it closed, however long it was open', async () => {
    const { workItems } = await import('@openadlc/db');
    const closedAt = new Date().toISOString();
    const opened = new Date(Date.now() - 400 * 86_400_000).toISOString();
    const pull = (id: number, number: number, extra: Record<string, unknown>) => ({
      id, itemId: `w-${id}`, itemNumber: id, kind: 'pull', repoId: 'repo-2', number, requestId: null, linkedBy: null, title: `pull ${number}`, url: null, ...extra,
    });
    vi.mocked(workItems.isNumbered).mockResolvedValueOnce(true);
    vi.mocked(workItems.boardLinks).mockResolvedValueOnce([
      pull(1, 60, { state: 'merged', openedAt: opened, closedAt }),
      // Closed before anything recorded when: its week counts from when it opened.
      pull(2, 61, { state: 'closed', openedAt: opened, closedAt: null }),
    ] as never);
    const board = (await (await fetch(`${bridgeUrl}/v1/board`)).json()) as { columns: { stage: string; cards: { ref: string; updatedAt: string }[] }[] };
    const done = board.columns.find((column) => column.stage === 'done')?.cards ?? [];
    expect(done.find((card) => card.ref === 'website#60')?.updatedAt).toBe(closedAt);
    expect(done.find((card) => card.ref === 'website#61')?.updatedAt).toBe(opened);
  });

  /**
   * A card in Ship whose issue records no pull request has no merge for a
   * deploy to carry, and nothing that finishes a merge moves it: it said
   * "Merged · waiting to deploy" for good.
   */
  describe('a card in Ship with no merge recorded', () => {
    type Row = (typeof ISSUES)[number];
    const inShip = (number: number, prNumber: number | null): Row => ({
      ...ISSUES[0]!, id: `issue-${number}`, number, title: `#${number}`, stage: 'merged', labels: ['adlc:merged'], prNumber,
      url: `https://github.com/janedoe/openadlc-testbed/issues/${number}`,
    });
    const ROWS = [inShip(44, null), inShip(43, 52)];
    const read = async () => {
      const { issues } = await import('@openadlc/db');
      vi.mocked(issues.boardIssues).mockResolvedValueOnce(ROWS as never);
      vi.mocked(issues.boardCards).mockResolvedValueOnce(
        ROWS.map((issue) => ({ repo: issue.repoName, ref: `openadlc-testbed#${issue.number}`, title: issue.title, stage: issue.stage, assignees: [], gateOpen: false, url: issue.url, labels: issue.labels, updatedAt: issue.updatedAt })) as never,
      );
      const board = (await (await fetch(`${bridgeUrl}/v1/board`)).json()) as { columns: Column[] };
      return board.columns.find((column) => column.stage === 'merged')?.cards.map((card) => [card.ref, card.prNumber ?? null, card.noMerge ?? false]);
    };

    it('says so, from the issue’s row, and not of one whose pull request is another work item’s', async () => {
      expect(await read()).toEqual([
        ['openadlc-testbed#44', null, true],
        ['openadlc-testbed#43', 52, false],
      ]);

      // Pull request #52 closes #43 and #44, and is linked to #43's item:
      // #44's card names no pull request, though its row records #52.
      const { workItems } = await import('@openadlc/db');
      const link = (id: number, itemId: string, kind: string, number: number) => ({
        id, itemId, itemNumber: id, kind, repoId: 'repo-1', number, requestId: null, linkedBy: null, title: `${kind} ${number}`, state: 'open', url: null, openedAt: new Date().toISOString(),
      });
      ROWS[0] = inShip(44, 52);
      try {
        vi.mocked(workItems.isNumbered).mockResolvedValueOnce(true);
        vi.mocked(workItems.boardLinks).mockResolvedValueOnce([link(1, 'w-1', 'issue', 43), link(2, 'w-1', 'pull', 52), link(3, 'w-2', 'issue', 44)] as never);
        expect(await read()).toEqual([
          ['openadlc-testbed#44', null, false],
          ['openadlc-testbed#43', 52, false],
        ]);
      } finally {
        ROWS[0] = inShip(44, null);
      }
    });

    it('says nothing of it where merging ships, since the deploy sweep moves it to Done', async () => {
      const { settings } = await import('@openadlc/db');
      vi.mocked(settings.allSettings).mockResolvedValueOnce({ testingDeploy: JSON.stringify({ 'openadlc-testbed': 'none' }) } as never);
      expect(await read()).toEqual([
        ['openadlc-testbed#44', null, false],
        ['openadlc-testbed#43', 52, false],
      ]);
    });
  });

  it('names each repository with the colour it is told apart by', async () => {
    const board = (await (await fetch(`${bridgeUrl}/v1/board`)).json()) as { repos: string[]; repositories: unknown[] };
    expect(board.repos).toEqual(['openadlc-testbed', 'website']);
    expect(board.repositories).toEqual([
      { name: 'openadlc-testbed', fullName: 'janedoe/openadlc-testbed', color: 'teal' },
      { name: 'website', fullName: 'janedoe/website', color: 'amber' },
    ]);
  });

  it('leaves off the cards of a repository removed from OpenADLC, which are history now', async () => {
    const board = (await (await fetch(`${bridgeUrl}/v1/board`)).json()) as { columns: Column[] };
    const refs = board.columns.flatMap((column) => column.cards.map((card) => card.ref));
    expect(refs).toContain('openadlc-testbed#16');
    expect(refs).not.toContain('retired#3');
  });

  it('leaves off an issue labelled openadlc:ignore and its pull request in the merge line, and brings them back without it', async () => {
    const { issues, mergeLines } = await import('@openadlc/db');
    const entry = (prNumber: number) => ({ repoName: 'openadlc-testbed', prNumber, position: prNumber === 31 ? 1 : 2, state: 'queued', detail: null, enteredAt: '2026-09-24T11:00:00.000Z' });
    const read = async (labels: string[]) => {
      const labelled = ISSUES.map((one) => (one.number === 12 ? { ...one, labels } : one));
      vi.mocked(issues.boardIssues).mockResolvedValueOnce(labelled as never);
      vi.mocked(mergeLines.line).mockResolvedValueOnce([entry(31), entry(40)] as never);
      const board = (await (await fetch(`${bridgeUrl}/v1/board`)).json()) as { columns: Column[]; mergeLine: { ref: string }[] };
      return { cards: board.columns.flatMap((column) => column.cards.map((card) => card.ref)), line: board.mergeLine.map((one) => one.ref) };
    };

    const ignored = await read(['adlc:review', 'openadlc:ignore']);
    expect(ignored.cards).toContain('openadlc-testbed#16');
    expect(ignored.cards).not.toContain('openadlc-testbed#12');
    expect(ignored.line).toEqual(['openadlc-testbed#40']);

    const back = await read(['adlc:review']);
    expect(back.cards).toContain('openadlc-testbed#12');
    expect(back.line).toEqual(['openadlc-testbed#31', 'openadlc-testbed#40']);
  });

  it('puts a request intake is asking about in Intake, on its repository’s board and not another’s', async () => {
    const { requests, threads } = await import('@openadlc/db');
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
          repo: 'openadlc-testbed',
          title: 'Add a keyboard-controlled snake game at snake.html',
          request: true,
          gateOpen: true,
          costUsd: 0.41,
        }),
      ]);
      expect(await intakeOf('?repo=openadlc-testbed')).toHaveLength(1);
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

  /**
   * Three years of work shipped, one card a day, under the board's fifteen-
   * second read: `boardIssues` here selects as the store does, and
   * `listIssues` is every one of them. The board read them all, twice, with
   * every task on each, for the console to show the week of Done.
   */
  describe('over a long history of Done', () => {
    const day = 86_400_000;
    const ago = (days: number) => new Date(Date.now() - days * day).toISOString();
    type Row = (typeof ISSUES)[number];
    const row = (number: number, stage: string, updatedAt: string, labels = [`adlc:${stage}`]): Row => ({
      ...ISSUES[0]!, id: `issue-${number}`, number, title: `#${number}`, stage, labels, updatedAt, createdAt: ago(1200),
      url: `https://github.com/janedoe/openadlc-testbed/issues/${number}`,
    });
    const HISTORY: Row[] = [
      ...Array.from({ length: 1095 }, (_, index) => row(1000 + index, 'done', ago(7.01 + index))),
      // Shipped by a deploy a day and a half ago; its row changed since.
      row(20, 'done', ago(1)),
      // On the week's first day.
      row(21, 'done', ago(6.99)),
      // Closed without merging two days ago: in the week, and counted with nothing.
      row(22, 'done', ago(2), ['adlc:done', 'openadlc:abandoned']),
      ...ISSUES,
    ];
    let later: Row[] = [];
    const table = () => [...HISTORY, ...later];
    const toCard = (issue: Row) => ({
      repo: issue.repoName, ref: `${issue.repoName}#${issue.number}`, title: issue.title, stage: issue.stage, assignees: [] as string[],
      gateOpen: false, url: issue.url, labels: issue.labels, updatedAt: issue.updatedAt,
    });
    const DEPLOY = { ...TASKS[2]!, id: 'task-deploy-20', botId: 'bot-intake', kind: 'deploy', subjectType: 'merge', subjectRef: 'openadlc-testbed#20', state: 'done', costUsd: 0.1, startedAt: ago(1.6), endedAt: ago(1.5), createdAt: ago(1.6) };
    type Card = { ref: string; stage: string; updatedAt: string; shippedAt?: string | null; item?: { key: string } | null; active?: { kind: string }[] };
    const read = async (query = '') => (await (await fetch(`${bridgeUrl}/v1/board${query}`)).json()) as { columns: { stage: string; cards: Card[] }[]; doneBefore?: boolean };
    const inTheWeek = (at: string) => Date.now() - Date.parse(at) <= 7 * day;

    beforeEach(async () => {
      const { issues } = await import('@openadlc/db');
      later = [];
      TASKS.push(DEPLOY);
      vi.mocked(issues.boardIssues).mockImplementation((async (since: Date, repoName?: string) =>
        table().filter((one) => (one.stage !== 'done' || Date.parse(one.updatedAt) >= since.getTime()) && (!repoName || one.repoName === repoName))) as never);
      vi.mocked(issues.getIssues).mockImplementation((async (refs: readonly { repoId: string; number: number }[]) =>
        table().filter((one) => refs.some((ref) => ref.repoId === one.repoId && ref.number === one.number))) as never);
      vi.mocked(issues.listIssues).mockImplementation((async () => table()) as never);
      // The cards of the issues it is given; it read every issue itself before.
      vi.mocked(issues.boardCards).mockImplementation((async (listed: unknown) => (Array.isArray(listed) ? (listed as Row[]) : table()).map(toCard)) as never);
      vi.mocked(issues.listIssues).mockClear();
      vi.mocked(issues.boardIssues).mockClear();
    });

    afterEach(async () => {
      const { issues } = await import('@openadlc/db');
      TASKS.splice(TASKS.indexOf(DEPLOY), 1);
      vi.mocked(issues.boardIssues).mockImplementation((async () => ISSUES) as never);
      vi.mocked(issues.getIssues).mockImplementation((async () => []) as never);
      vi.mocked(issues.listIssues).mockImplementation((async () => ISSUES) as never);
      vi.mocked(issues.boardCards).mockImplementation((async () => [...ISSUES, RETIRED].map((issue) => ({ ...toCard(issue), assignees: issue.number === 16 ? ['openadlc-atlas-janedoe'] : [] }))) as never);
    });

    it('reads only the issues not in Done and those Done in the week, and the tasks of those alone', async () => {
      const { issues, tasks } = await import('@openadlc/db');
      vi.mocked(tasks.listTasksOnSubjects).mockClear();
      const board = await read();

      expect(issues.listIssues).not.toHaveBeenCalled();
      expect(issues.boardIssues).toHaveBeenCalledTimes(1);
      const [since, repoName] = vi.mocked(issues.boardIssues).mock.calls[0]!;
      expect(Math.abs(Date.now() - 7 * day - since.getTime())).toBeLessThan(60_000);
      expect(repoName).toBeUndefined();
      // Not one of the three years before the week, on the board or asked for its tasks.
      const sent = board.columns.flatMap((column) => column.cards.map((card) => card.ref));
      expect(sent.filter((ref) => Number(ref.split('#')[1]) >= 1000)).toEqual([]);
      const asked = vi.mocked(tasks.listTasksOnSubjects).mock.calls.flatMap(([refs]) => [...refs]);
      expect(asked.filter((ref) => Number(ref.split('#')[1]) >= 1000)).toEqual([]);
      expect(sent).toEqual(expect.arrayContaining(['openadlc-testbed#16', 'openadlc-testbed#12']));
    });

    it('keeps in Done every card it shows this week, from when it shipped, as it was with every issue read', async () => {
      const done = (await read()).columns.find((column) => column.stage === 'done')?.cards ?? [];
      // What Done shows of the whole history: each issue in Done from its
      // last deploy, or else when its row last changed, within the week.
      const shipped = (one: Row) => (one.number === 20 ? DEPLOY.endedAt : one.updatedAt);
      const shown = HISTORY.filter((one) => one.stage === 'done' && inTheWeek(shipped(one))).map((one) => `openadlc-testbed#${one.number}`);
      expect(shown).toEqual(['openadlc-testbed#20', 'openadlc-testbed#21', 'openadlc-testbed#22']);
      expect(done.filter((card) => inTheWeek(card.shippedAt ?? card.updatedAt)).map((card) => card.ref).sort()).toEqual(shown);
      expect(done.find((card) => card.ref === 'openadlc-testbed#20')?.shippedAt).toBe(DEPLOY.endedAt);
      expect(done).toHaveLength(3);
    });

    it('lets a card go once it leaves the week, and has it back when it is reopened', async () => {
      const refs = async () => (await read()).columns.flatMap((column) => column.cards.map((card) => [column.stage, card.ref]));
      later = [row(30, 'done', ago(6.9))];
      expect(await refs()).toContainEqual(['done', 'openadlc-testbed#30']);
      later = [row(30, 'done', ago(7.01))];
      expect((await refs()).map(([, ref]) => ref)).not.toContain('openadlc-testbed#30');
      // Reopened, and back in Build, however long ago it shipped.
      later = [row(30, 'build', ago(7.01))];
      expect(await refs()).toContainEqual(['build', 'openadlc-testbed#30']);
    });

    it('keeps an item’s card its first issue’s when that issue went to Done before the week, with the work of the rest', async () => {
      const { issues, workItems } = await import('@openadlc/db');
      const link = (id: number, number: number) => ({
        id, itemId: 'w-9', itemNumber: 9, kind: 'issue', repoId: 'repo-1', number, requestId: null, linkedBy: id === 2 ? 'janedoe' : null,
        title: `issue ${number}`, state: id === 1 ? 'closed' : 'open', url: null, openedAt: ago(40), closedAt: id === 1 ? ago(30) : null,
      });
      vi.mocked(workItems.isNumbered).mockResolvedValueOnce(true);
      vi.mocked(workItems.boardLinks).mockResolvedValueOnce([link(1, 1010), link(2, 16)] as never);
      const cards = (await read()).columns.flatMap((column) => column.cards.map((card) => ({ ...card, column: column.stage })));

      // Its first issue's row, read by itself: the week's read has not got it.
      expect(issues.getIssues).toHaveBeenCalledWith([{ repoId: 'repo-1', number: 1010 }]);
      const card = cards.find((one) => one.item?.key === 'W-9');
      expect(card).toMatchObject({ ref: 'openadlc-testbed#1010', column: 'done' });
      expect(card?.active?.map((task) => task.kind)).toEqual(['implement']);
      expect(cards.map((one) => one.ref)).not.toContain('openadlc-testbed#16');
    });

    it('says, of a board with nothing on it, whether anything went to Done before the week, and asks nothing of one with cards', async () => {
      const { issues } = await import('@openadlc/db');
      vi.mocked(issues.anyDoneBefore).mockClear();
      expect((await read()).doneBefore).toBeUndefined();
      expect(issues.anyDoneBefore).not.toHaveBeenCalled();

      vi.mocked(issues.anyDoneBefore).mockResolvedValueOnce(true);
      const quiet = await read('?repo=website');
      expect(quiet.columns.every((column) => column.cards.length === 0)).toBe(true);
      expect(quiet.doneBefore).toBe(true);
      const [since, repoName] = vi.mocked(issues.anyDoneBefore).mock.calls[0]!;
      expect(Math.abs(Date.now() - 7 * day - since.getTime())).toBeLessThan(60_000);
      expect(repoName).toBe('website');
    });
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
      repo: 'openadlc-testbed',
      issue: { repo: 'openadlc-testbed', number: 12, title: 'Record which model each review used' },
      round: 2,
      // Round two of the three config/review.yaml allows, and this review's own cost.
      maxRounds: 3,
      costUsd: 0.38,
      waitingOnYou: false,
    });

    const builder = body.bots.find((bot) => bot.name === 'openadlc-atlas-janedoe');
    expect(builder?.task).toMatchObject({ kind: 'implement', issue: { number: 16 }, costUsd: 0.84 });
    expect(builder?.lastTask).toMatchObject({ kind: 'patch', state: 'done', issue: { number: 12 } });
  });

  it('says each seat’s pause, its work in hand, what it last finished and how, and its health, for the Crew page', async () => {
    const body = (await (await fetch(`${bridgeUrl}/v1/bots`)).json()) as { bots: Record<string, unknown>[] };
    const builder = body.bots.find((bot) => bot.name === 'openadlc-atlas-janedoe');
    const reviewer = body.bots.find((bot) => bot.name === 'irisexampleco');

    expect(builder?.seatPaused).toEqual({ by: 'janedoe', at: '2026-10-02T10:00:00.000Z', why: 'changing its model' });
    expect(reviewer?.seatPaused).toBeNull();
    expect(builder?.queue).toMatchObject({ running: 1, waiting: 0, queued: 0, next: null });
    expect(builder?.recent).toEqual([
      // With what it cost: the seat panel's History says so beside each.
      expect.objectContaining({ ref: 'openadlc-testbed#31', kind: 'patch', outcome: 'done', title: 'Record which model each review used', item: 'openadlc-testbed#12', costUsd: 0.98 }),
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
        { title: 'Run a command', checkId: 'x', severity: 'warning', action: { label: 'Copy', command: 'openadlc up' } },
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

  // 620legal/OpenADLC's rules name deploy-testing, which skips: Settings said
  // a merge runs it and a smoke, while every merge went to Done.
  it('says why a repository’s newest testing deploy had nothing to deploy, for settings to say its merges ship by merging', async () => {
    const body = (await (await fetch(`${bridgeUrl}/v1/repos`)).json()) as { repos: { name: string; deploysNothing: string | null }[] };
    expect(body.repos.map((repo) => [repo.name, repo.deploysNothing])).toEqual([
      ['openadlc-testbed', 'deploy-testing run 39836758586 was skipped'],
      ['website', null],
    ]);
  });
});

/**
 * A repository that ships by release: 620legal/OpenADLC, whose installs take
 * a change only from a release. Its merged card waits in Ship for the next
 * one, and says so rather than "Merged · waiting to deploy" over a deploy
 * that never comes; Settings says whether the app hears a release published.
 */
describe('a repository that ships by release', () => {
  let server: Server;
  let url: string;
  const IN_SHIP = { ...ISSUES[0]!, id: 'issue-45', number: 45, title: 'A merged change', stage: 'merged', labels: ['adlc:merged'], prNumber: 145 };
  const NO_PULL = { ...IN_SHIP, id: 'issue-44', number: 44, prNumber: null };

  beforeEach(async () => {
    const { registerConsoleApi } = await import('./api.js');
    const { Router } = await import('./router.js');
    const { DEFAULT_DELIVERY_RULES } = await import('@openadlc/shared');
    const router = new Router();
    const byRelease = { ...DEFAULT_DELIVERY_RULES, testing: { ...DEFAULT_DELIVERY_RULES.testing, on: 'release' as const } };
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
      // The testbed ships by release; the website deploys on merge.
      delivery: {
        get: async (repo: { name: string }) => ({
          rules: repo.name === 'openadlc-testbed' ? byRelease : DEFAULT_DELIVERY_RULES,
          source: 'repository',
          testingUrl: null,
          fileError: null,
        }),
        forget: () => undefined,
      } as never,
      // The app made before OpenADLC asked for Release events.
      health: {
        rows: async () => [
          {
            checkId: 'ships-by-release',
            subject: 'janedoe/openadlc-testbed',
            state: 'failing',
            action: { label: 'Open the app’s permissions and events', url: 'https://github.com/settings/apps/openadlc-janedoe/permissions' },
            facts: {},
          },
        ],
      } as never,
    });
    server = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('marks its cards in Ship as shipping with the next release, and not one with no merge to match a release to', async () => {
    const { issues } = await import('@openadlc/db');
    const rows = [IN_SHIP, NO_PULL];
    vi.mocked(issues.boardIssues).mockResolvedValueOnce(rows as never);
    vi.mocked(issues.boardCards).mockResolvedValueOnce(
      rows.map((issue) => ({ repo: issue.repoName, ref: `openadlc-testbed#${issue.number}`, title: issue.title, stage: issue.stage, assignees: [], gateOpen: false, url: issue.url, labels: issue.labels, updatedAt: issue.updatedAt })) as never,
    );
    const board = (await (await fetch(`${url}/v1/board`)).json()) as { columns: { stage: string; cards: { ref: string; shipsByRelease?: boolean; noMerge?: boolean }[] }[] };
    const ship = board.columns.find((column) => column.stage === 'merged')?.cards ?? [];
    expect(ship.map((card) => [card.ref, card.shipsByRelease ?? false, card.noMerge ?? false])).toEqual([
      ['openadlc-testbed#45', true, false],
      ['openadlc-testbed#44', false, true],
    ]);
  });

  it('says on GET /v1/repos whether the app hears a release published, for Settings to say', async () => {
    const body = (await (await fetch(`${url}/v1/repos`)).json()) as { repos: { name: string; releaseEvents: unknown; delivery: { rules: { testing: { on: string } } } }[] };
    expect(body.repos.map((repo) => [repo.name, repo.delivery.rules.testing.on, repo.releaseEvents])).toEqual([
      ['openadlc-testbed', 'release', { subscribed: false, url: 'https://github.com/settings/apps/openadlc-janedoe/permissions' }],
      ['website', 'merge', null],
    ]);
  });
});
