import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PATH_POLICY } from '@openadlc/shared';
import { activityOf, boardWork, FILED_SHOWN_MS, itemCards, lonePulls, loosePulls, readBoardActivity, readBoardWork, requestsOnCards, withItemPulls, type BoardLink } from './board-work.js';
import type { IssueFacts, TaskFacts } from './work.js';

/** What `readBoardWork` and `readBoardActivity` read, for the tests of them that read anything. */
const store = vi.hoisted(() => ({
  issues: [] as IssueFacts[],
  tasks: [] as TaskFacts[],
  sessions: [] as { id: string; taskId: string | null; lastLine: string | null }[],
  panes: {} as Record<string, string[]>,
  /** Each read of the sessions' lines, by the sessions it asked for. */
  lineReads: [] as string[][],
  /** Each read of when tasks last began running, by the tasks it asked for. */
  sinceReads: [] as string[][],
  since: {} as Record<string, string | null>,
  running: 0,
  /** Whether the install is numbered, and its work items' links. */
  numbered: false,
  links: [] as BoardLink[],
  /** Each read of the issues: `*` for every repository's, a repository's name for its own, `repo#n` for one row. */
  issueReads: [] as string[],
  /** Each read of links: `all`, or the things the poll asked for the items of. */
  linkReads: [] as string[],
  /** The settings and the month's budget, for what a waiting card waits on. */
  settings: {} as Record<string, string>,
  budget: null as { period: string; capUsd: number; spentUsd: number; state: 'ok' | 'warning' | 'stopped' } | null,
  /** Each read of a repository's work in flight, by its id. */
  flightReads: [] as string[],
}));
vi.mock('@openadlc/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openadlc/db')>()),
  listEventsOfType: vi.fn(async () => []),
  stageMoves: { sendBackCounts: vi.fn(async () => new Map()) },
  workItems: {
    isNumbered: vi.fn(async () => store.numbered),
    allLinks: vi.fn(async () => {
      store.linkReads.push('all');
      return store.links;
    }),
    // Every link of the items holding any of these, as the store reads it.
    linksOfItemsHolding: vi.fn(async (things: readonly ({ repoId: string; number: number } | { requestId: string })[]) => {
      store.linkReads.push(things.map((thing) => ('requestId' in thing ? thing.requestId : `${thing.repoId}#${thing.number}`)).join(','));
      const held = new Set(
        store.links
          .filter((link) => things.some((thing) => ('requestId' in thing ? link.requestId === thing.requestId : link.repoId === thing.repoId && link.number === thing.number)))
          .map((link) => link.itemId),
      );
      return store.links.filter((link) => held.has(link.itemId));
    }),
  },
  bots: { listBots: vi.fn(async () => [{ id: 'bot-builder', name: 'openadlc-atlas-janedoe' }, { id: 'bot-lead', name: 'noraexampleco' }]) },
  costs: { currentPeriod: () => '2026-09', getBudget: vi.fn(async () => store.budget) },
  settings: { getSetting: vi.fn(async (key: string) => store.settings[key] ?? null) },
  issues: {
    workInFlight: vi.fn(async (repoId: string) => {
      store.flightReads.push(repoId);
      return [{ number: 44, paths: ['src/prices.ts'], building: true }];
    }),
    listIssues: vi.fn(async (repoName?: string) => {
      store.issueReads.push(repoName ?? '*');
      return store.issues.filter((issue) => !repoName || issue.repoName === repoName);
    }),
    getIssue: vi.fn(async (repoId: string, number: number) => {
      store.issueReads.push(`${repoId}#${number}`);
      return store.issues.find((issue) => issue.repoId === repoId && issue.number === number) ?? null;
    }),
  },
  repos: {
    listRepos: vi.fn(async () => [
      { id: 'repo-1', name: 'api', fullName: 'exampleco/api', stageModes: {} },
      { id: 'repo-2', name: 'web', fullName: 'exampleco/web', stageModes: {} },
    ]),
  },
  requests: { listRequests: vi.fn(async () => []) },
  tasks: {
    listTasksOnSubjects: vi.fn(async (refs: readonly string[]) => store.tasks.filter((task) => refs.includes(task.subjectRef))),
    listTasks: vi.fn(async (filter: { states?: string[] }) => store.tasks.filter((task) => !filter.states || filter.states.includes(task.state))),
    countRunning: vi.fn(async () => store.running),
    runningSince: vi.fn(async (ids: readonly string[]) => {
      store.sinceReads.push([...ids]);
      return new Map(ids.filter((id) => id in store.since).map((id) => [id, store.since[id]!]));
    }),
  },
  sessions: {
    listSessions: vi.fn(async () => store.sessions),
    recentLines: vi.fn(async (ids: readonly string[]) => {
      store.lineReads.push([...ids]);
      return new Map(ids.filter((id) => store.panes[id]).map((id) => [id, store.panes[id]!]));
    }),
  },
}));

/**
 * A request's card in Intake says where the request is: waiting its
 * turn, intake on it, waiting on the person, or filed, with the issue.
 */

const NOW = new Date('2026-09-29T12:00:00.000Z');
const minutesAgo = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();

let count = 0;
function triage(subjectRef: string, state: TaskFacts['state']): TaskFacts {
  count += 1;
  return {
    id: `task-${count}`,
    botId: 'bot-intake',
    repoId: 'repo-1',
    kind: 'intake',
    subjectRef,
    state,
    round: 0,
    costUsd: 0,
    startedAt: minutesAgo(2),
    endedAt: null,
    exitReason: null,
    createdAt: minutesAgo(2),
  } as TaskFacts;
}

function request(id: string, state: string, extra: Record<string, unknown> = {}) {
  return { id: `${id}-0000-4000-8000-000000000000`, repoId: 'repo-1', issueNumber: null, text: `Request ${id}`, state, createdAt: minutesAgo(10), ...extra };
}

const read = (requests: ReturnType<typeof request>[], tasks: TaskFacts[] = [], gates: { taskId: string }[] = []) =>
  boardWork({
    issues: [],
    tasks,
    bots: [{ id: 'bot-intake', name: 'ottoexampleco' }],
    repos: [{ id: 'repo-1', name: 'api', fullName: 'exampleco/api', stageModes: {} }],
    gates,
    stallEvents: [],
    requests,
    now: NOW,
  }).requests;

describe('a request in Intake', () => {
  it('is queued with its place in line, as the queue gives it', () => {
    const cards = read([
      request('bbbbbbbb', 'queued', { createdAt: minutesAgo(3), queuePosition: 2 }),
      request('aaaaaaaa', 'queued', { createdAt: minutesAgo(5), queuePosition: 1 }),
    ]);
    expect(cards.map((card) => [card.ref, card.requestState, card.queuePosition])).toEqual([
      ['request:aaaaaaaa', 'queued', 1],
      ['request:bbbbbbbb', 'queued', 2],
    ]);
  });

  it('is not queued once the queue gave up on it: Needs you has it, with Try again', () => {
    const cards = read([
      request('aaaaaaaa', 'queued', { queueAttempts: 5, queuePosition: null }),
      request('bbbbbbbb', 'queued', { queueAttempts: 1, queuePosition: 1 }),
    ]);
    expect(cards.map((card) => [card.ref, card.requestState, card.queuePosition])).toEqual([['request:bbbbbbbb', 'queued', 1]]);
  });

  it('is intake working while its triage runs, and waiting for you while its question is open', () => {
    const running = triage('request:cccccccc', 'running');
    const asking = triage('request:dddddddd', 'paused');
    const cards = read([request('cccccccc', 'draft'), request('dddddddd', 'questions')], [running, asking], [{ taskId: asking.id }]);
    expect(cards.map((card) => [card.ref, card.requestState, card.gateOpen])).toEqual([
      ['request:dddddddd', 'waiting', true],
      ['request:cccccccc', 'working', false],
    ]);
  });

  it('is filed, linking the issue, only until its issue is on the board', () => {
    // Between filing and the issue's first read there is no other card for it.
    const filed = read([request('eeeeeeee', 'filed', { issueNumber: 42, updatedAt: minutesAgo(2) })]);
    expect(filed).toEqual([
      expect.objectContaining({ requestState: 'filed', issueNumber: 42, url: 'https://github.com/exampleco/api/issues/42', queuePosition: null }),
    ]);
    const old = read([request('eeeeeeee', 'filed', { issueNumber: 42, updatedAt: new Date(NOW.getTime() - FILED_SHOWN_MS - 1).toISOString() })]);
    expect(old).toEqual([]);
    // An issue closed before it was ever on the board never arrives: its
    // request does not sit in Intake as work that is still to happen.
    expect(read([request('eeeeeeee', 'filed', { issueNumber: 42, updatedAt: minutesAgo(60) })])).toEqual([]);
  });

  it('is one card with its issue: once the issue is on the board, the request is not a card of its own', () => {
    // It stayed in Intake for a day saying "Filed #42" beside #42's own card in
    // Build, so every piece of work was on the board twice.
    const triaged = { ...triage('request:eeeeeeee', 'done'), costUsd: 0.4 };
    const work = boardWork({
      issues: [
        { repoId: 'repo-1', repoName: 'api', number: 42, title: 'Request eeeeeeee', stage: 'build', url: null, prNumber: null, labels: ['adlc:build'], updatedAt: minutesAgo(5) },
      ],
      tasks: [triaged],
      bots: [{ id: 'bot-intake', name: 'ottoexampleco' }],
      repos: [{ id: 'repo-1', name: 'api', fullName: 'exampleco/api', stageModes: {} }],
      gates: [],
      stallEvents: [],
      requests: [request('eeeeeeee', 'filed', { issueNumber: 42, updatedAt: minutesAgo(30) })],
      now: NOW,
    });
    expect(work.requests).toEqual([]);
    // The issue's card is the one card, and the triage it took still counts on it.
    expect(work.byRef.get('api#42')?.costUsd).toBe(0.4);
  });

  it('is gone when its triage ended without filing it, or it was abandoned', () => {
    const ended = triage('request:ffffffff', 'failed');
    expect(read([request('ffffffff', 'draft'), request('abababab', 'abandoned')], [ended])).toEqual([]);
  });

  it('puts what needs you first, then what intake is on, then the line, then what was filed', () => {
    const running = triage('request:22222222', 'running');
    const asking = triage('request:33333333', 'paused');
    const cards = read(
      [
        request('11111111', 'filed', { issueNumber: 7, updatedAt: minutesAgo(1) }),
        request('22222222', 'draft'),
        request('33333333', 'questions'),
        request('44444444', 'queued'),
      ],
      [running, asking],
      [{ taskId: asking.id }],
    );
    expect(cards.map((card) => card.requestState)).toEqual(['waiting', 'working', 'queued', 'filed']);
  });
});

describe('an issue whose work was sent back', () => {
  it('says on its card how many times', () => {
    const issue = {
      repoId: 'repo-1',
      repoName: 'api',
      number: 7,
      title: 'Cache the price list',
      stage: 'spec' as const,
      url: null,
      prNumber: null,
      labels: ['adlc:spec'],
      updatedAt: minutesAgo(5),
    };
    const work = boardWork({
      issues: [issue, { ...issue, number: 8 }],
      tasks: [],
      bots: [],
      repos: [{ id: 'repo-1', name: 'api', fullName: 'exampleco/api', stageModes: {} }],
      gates: [],
      stallEvents: [],
      requests: [],
      now: NOW,
      sendBacks: new Map([['repo-1#7', 2]]),
    });
    expect(work.byRef.get('api#7')?.sentBack).toBe(2);
    expect(work.byRef.get('api#8')?.sentBack).toBe(0);
  });
});

describe('one card per work item', () => {
  const REPOS = [
    { id: 'repo-1', name: 'api' },
    { id: 'repo-2', name: 'web' },
  ];
  let linkId = 0;
  const link = (itemId: string, itemNumber: number, kind: BoardLink['kind'], repoId: string | null, number: number | null, extra: Partial<BoardLink> = {}): BoardLink => {
    linkId += 1;
    return { id: linkId, itemId, itemNumber, kind, repoId, number, requestId: null, title: `${kind} ${number}`, state: 'open', url: null, openedAt: minutesAgo(60), ...extra };
  };
  const card = (repo: string, number: number, stage: string, extra: Record<string, unknown> = {}) => ({
    repo,
    ref: `${repo}#${number}`,
    stage,
    assignees: [] as string[],
    gateOpen: false,
    costUsd: 1,
    ...extra,
  });
  const keyOf = (number: number) => `acme-${number}`;

  it('is the first-linked issue’s card, in its column, with the cost and people of every linked card', () => {
    linkId = 0;
    const links = [
      link('w-7', 7, 'issue', 'repo-2', 3),
      link('w-7', 7, 'issue', 'repo-1', 12),
      link('w-7', 7, 'pull', 'repo-1', 31),
      link('w-8', 8, 'issue', 'repo-1', 15),
    ];
    const { cards } = itemCards({
      cards: [card('api', 12, 'review', { assignees: ['lead-reviewer'], gateOpen: true }), card('web', 3, 'build', { assignees: ['builder'] }), card('api', 15, 'spec')],
      requests: [],
      links,
      repos: REPOS,
      keyOf,
    });
    expect(cards.map((one) => [one.ref, one.stage, one.item?.key, one.repos, one.costUsd, one.assignees, one.gateOpen])).toEqual([
      // #3 in web was linked first: its column stands, though #12 is in Review.
      ['web#3', 'build', 'acme-7', ['web', 'api'], 2, ['builder', 'lead-reviewer'], true],
      ['api#15', 'spec', 'acme-8', ['api'], 1, [], false],
    ]);
  });

  it('keeps a request card in Intake with its key until its item has an issue on the board', () => {
    linkId = 0;
    const requestId = 'abcdef01-0000-4000-8000-000000000000';
    const links = [link('w-9', 9, 'request', null, null, { requestId }), link('w-10', 10, 'request', null, null, { requestId: '12345678-0000-4000-8000-000000000000' }), link('w-10', 10, 'issue', 'repo-1', 20)];
    const { requests } = itemCards({
      cards: [card('api', 20, 'build')],
      requests: [
        { repo: 'api', ref: 'request:abcdef01' },
        { repo: 'api', ref: 'request:12345678' },
      ],
      links,
      repos: REPOS,
      keyOf,
    });
    expect(requests).toEqual([{ repo: 'api', ref: 'request:abcdef01', item: { number: 9, key: 'acme-9' }, repos: ['api'] }]);
  });

  it('leaves a card as it was, with no key, where nothing is numbered yet', () => {
    const { cards } = itemCards({ cards: [card('api', 12, 'build')], requests: [], links: [], repos: REPOS, keyOf });
    expect(cards).toEqual([{ ...card('api', 12, 'build'), item: null, repos: ['api'] }]);
  });

  it('makes a pull request no issue claims a card in Review while open, and in Done once merged or closed, however long ago it was opened', () => {
    linkId = 0;
    const links = [
      link('w-1', 1, 'pull', 'repo-1', 40, { title: 'A person’s fix' }),
      link('w-2', 2, 'pull', 'repo-1', 41, { state: 'merged' }),
      link('w-3', 3, 'pull', 'repo-1', 42, { state: 'closed', openedAt: new Date(NOW.getTime() - 400 * 86_400_000).toISOString(), closedAt: NOW.toISOString() }),
      link('w-4', 4, 'issue', 'repo-1', 5),
      link('w-4', 4, 'pull', 'repo-1', 43),
      // Two pulls on one item: Done counts from the later close.
      link('w-8', 8, 'pull', 'repo-1', 45, { state: 'merged', closedAt: '2026-10-01T00:00:00.000Z' }),
      link('w-8', 8, 'pull', 'repo-1', 46, { state: 'closed', closedAt: '2026-10-03T00:00:00.000Z' }),
    ];
    expect(lonePulls(links, REPOS).map((pull) => [pull.ref, pull.stage, pull.title, pull.closedAt])).toEqual([
      ['api#40', 'review', 'A person’s fix', null],
      ['api#41', 'done', 'pull 41', null],
      ['api#42', 'done', 'pull 42', NOW.toISOString()],
      ['api#45', 'done', 'pull 45', '2026-10-03T00:00:00.000Z'],
    ]);
  });

  it('sums into an item’s card the work on a pull linked beside its issue, and on a second pull of an item with none', () => {
    linkId = 0;
    const links = [
      link('w-5', 5, 'issue', 'repo-1', 12),
      link('w-5', 5, 'pull', 'repo-1', 31),
      link('w-5', 5, 'pull', 'repo-2', 9),
      link('w-6', 6, 'pull', 'repo-1', 40),
      link('w-6', 6, 'pull', 'repo-1', 44),
    ];
    // #31 is #12's own pull request, which `cardWork` already counts on #12's card.
    const loose = loosePulls(links, REPOS, [{ repoName: 'api', prNumber: 31 }]);
    expect(loose.map((pull) => pull.ref)).toEqual(['web#9', 'api#40', 'api#44']);

    const work = boardWork({
      issues: [],
      tasks: [
        { ...triage('web#9', 'paused'), id: 'review-web', botId: 'bot-review', costUsd: 0.25 },
        { ...triage('api#44', 'running'), id: 'review-44', botId: 'bot-security', costUsd: 0.5 },
      ],
      bots: [
        { id: 'bot-review', name: 'lead-reviewer' },
        { id: 'bot-security', name: 'security-reviewer' },
      ],
      repos: [{ id: 'repo-1', name: 'api', fullName: 'exampleco/api', stageModes: {} }],
      gates: [{ taskId: 'review-web' }],
      stallEvents: [],
      requests: [],
      now: NOW,
      pulls: loose,
    });
    const members = loose.map((pull) => {
      const extras = work.byRef.get(pull.ref)!;
      return { ref: pull.ref, repo: pull.ref.split('#')[0]!, assignees: extras.assignees, gateOpen: extras.gateOpen ?? false, costUsd: extras.costUsd, active: extras.active };
    });
    const { cards } = itemCards({
      cards: [card('api', 12, 'build'), { ...card('api', 40, 'review', { costUsd: 0 }), pull: true }],
      members,
      requests: [],
      links,
      repos: REPOS,
      keyOf,
    });
    expect(cards.map((one) => [one.ref, one.costUsd, one.assignees, one.gateOpen, (one as { active?: unknown[] }).active?.length ?? 0])).toEqual([
      ['api#12', 1.25, ['lead-reviewer'], true, 1],
      ['api#40', 0.5, ['security-reviewer'], false, 1],
    ]);
  });

  it('sums a pull linked onto an item that is still only a request into the request’s card', () => {
    linkId = 0;
    const requestId = 'abcdef01-0000-4000-8000-000000000000';
    const links = [link('w-9', 9, 'request', null, null, { requestId }), link('w-9', 9, 'pull', 'repo-1', 60)];
    expect(lonePulls(links, REPOS)).toEqual([]);
    const { requests } = itemCards({
      cards: [],
      members: [{ ref: 'api#60', repo: 'api', assignees: ['lead-reviewer'], gateOpen: true, costUsd: 0.5, active: [] }],
      requests: [{ repo: 'api', ref: 'request:abcdef01', assignees: ['intake'], gateOpen: false, costUsd: 0.25, active: [] }],
      links,
      repos: REPOS,
      keyOf,
    });
    expect(requests.map((one) => [one.ref, one.item?.key, one.costUsd, one.assignees, one.gateOpen])).toEqual([
      ['request:abcdef01', 'acme-9', 0.75, ['intake', 'lead-reviewer'], true],
    ]);
  });

  it('gives a lone pull request’s card the cost and people of its own tasks', () => {
    const task = { ...triage('api#40', 'running'), botId: 'bot-intake', costUsd: 0.5 };
    const work = boardWork({
      issues: [],
      tasks: [task],
      bots: [{ id: 'bot-intake', name: 'lead-reviewer' }],
      repos: [{ id: 'repo-1', name: 'api', fullName: 'exampleco/api', stageModes: {} }],
      gates: [],
      stallEvents: [],
      requests: [],
      now: NOW,
      pulls: [{ ref: 'api#40', number: 40 }],
    });
    expect(work.byRef.get('api#40')).toMatchObject({ number: 40, prNumber: 40, costUsd: 0.5, assignees: ['lead-reviewer'] });
  });
});

describe('a card with work running', () => {
  const issue = {
    repoId: 'repo-1',
    repoName: 'api',
    number: 7,
    title: 'Cache the price list',
    stage: 'build' as const,
    url: null,
    prNumber: 31,
    labels: ['adlc:build'],
    updatedAt: minutesAgo(5),
  };
  const task = (id: string, subjectRef: string, state: TaskFacts['state'], extra: Partial<TaskFacts> = {}): TaskFacts =>
    ({ ...triage(subjectRef, state), id, botId: 'bot-builder', kind: 'implement', ...extra }) as TaskFacts;
  const read = (tasks: TaskFacts[], steps: Map<string, string[]>, requests: ReturnType<typeof request>[] = [], since?: Map<string, string | null>) =>
    boardWork({
      issues: [issue],
      tasks,
      bots: [
        { id: 'bot-builder', name: 'openadlc-atlas-janedoe' },
        { id: 'bot-intake', name: 'ottoexampleco' },
      ],
      repos: [{ id: 'repo-1', name: 'api', fullName: 'exampleco/api', stageModes: {} }],
      gates: [],
      stallEvents: [],
      requests,
      now: NOW,
      steps,
      since,
    });

  it('says what its bot is doing now, from the step its session printed last', () => {
    const building = task('task-build', 'api#7', 'running');
    const work = read(
      [building],
      new Map([['task-build', ['[skill] openadlc-atlas-janedoe starting implement on api#7', '[tool] Read: src/prices.ts', '[tool] Bash: pnpm --filter @exampleco/api test']]]),
    );
    expect(work.byRef.get('api#7')?.active).toEqual([expect.objectContaining({ bot: 'openadlc-atlas-janedoe', state: 'running', activity: 'running tests' })]);
  });

  it('reads the step of a task on the card’s pull request as the card’s too, and a request’s triage on its own card', () => {
    const reviewing = task('task-review', 'api#31', 'running', { kind: 'review' });
    const triaging = { ...triage('request:cccccccc', 'running'), id: 'task-triage' } as TaskFacts;
    const work = read(
      [reviewing, triaging],
      new Map([
        ['task-review', ['[tool] Bash: gh pr diff 31']],
        ['task-triage', ['[tool] Grep: Grep']],
      ]),
      [request('cccccccc', 'draft')],
    );
    expect(work.byRef.get('api#7')?.active[0]?.activity).toBe('reading the diff');
    expect(work.requests[0]?.active[0]?.activity).toBe('searching the code');
  });

  it('says no step for a task queued or paused, nor for one that has printed none yet', () => {
    const waiting = task('task-queued', 'api#7', 'queued');
    const asking = task('task-paused', 'api#31', 'paused');
    const starting = task('task-starting', 'api#7', 'running', { botId: 'bot-intake' });
    const work = read(
      [waiting, asking, starting],
      new Map([
        ['task-queued', ['[tool] Bash: pnpm test']],
        ['task-paused', ['[skill] waiting on a person: Which cache?']],
        ['task-starting', ['[skill] ottoexampleco starting implement on api#7']],
      ]),
    );
    expect(work.byRef.get('api#7')?.active.map((one) => [one.state, one.activity])).toEqual([
      ['queued', null],
      ['paused', null],
      ['running', null],
    ]);
  });

  it('counts the tasks running across the install, on a card or not, and only those running', () => {
    const work = read(
      [
        task('task-build', 'api#7', 'running'),
        // A deploy of a commit has no card; it is running all the same.
        task('task-deploy', 'api@3f2c1a9', 'running', { kind: 'deploy' }),
        task('task-queued', 'api#9', 'queued'),
        task('task-paused', 'api#31', 'paused'),
        task('task-done', 'api#7', 'done'),
      ],
      new Map(),
    );
    expect(work.runningTasks).toBe(2);
    expect(read([], new Map()).runningTasks).toBe(0);
  });

  it('says since when each running task has been running: from its resume, not its start, when it paused', () => {
    // Started a day ago, asked, answered two minutes ago: "1 day" was the time it waited on a person.
    const resumed = task('task-resumed', 'api#7', 'running', { startedAt: minutesAgo(24 * 60) });
    const fresh = task('task-fresh', 'api#31', 'running', { startedAt: minutesAgo(6) });
    const unrecorded = task('task-unrecorded', 'api#31', 'running', { startedAt: minutesAgo(90) });
    const waiting = task('task-queued', 'api#7', 'queued');
    const since = new Map<string, string | null>([
      ['task-resumed', minutesAgo(2)],
      ['task-unrecorded', null],
    ]);
    const work = read([resumed, fresh, unrecorded, waiting], new Map(), [], since);
    expect(work.byRef.get('api#7')?.active.map((one) => [one.state, one.since])).toEqual([
      ['running', minutesAgo(2)],
      // Not in what was read: its start, as before.
      ['running', minutesAgo(6)],
      // Resumed at a time nothing recorded: no time, rather than a wrong one.
      ['running', null],
      ['queued', null],
    ]);
  });
});

describe('what a running task is doing, in words', () => {
  it('names the step it is on from the tool it called, in a word a person reads', () => {
    const cases: [string, string | null][] = [
      ['[tool] Bash: cd /workspace/api && pnpm --filter @exampleco/api exec vitest run src/prices.test.ts', 'running tests'],
      ['[tool] shell: go test ./...', 'running tests'],
      ['[tool] Bash: openadlc-ci', 'running CI locally'],
      ['[tool] Bash: make ci', 'running CI locally'],
      ['[tool] Bash: pnpm install --frozen-lockfile', 'installing dependencies'],
      ['[tool] Bash: pnpm build', 'building'],
      ['[tool] Bash: pnpm exec tsc --noEmit', 'type-checking'],
      ['[tool] Bash: git commit -m "Add the test for prices"', 'committing'],
      // Words in a message are not the command.
      ['[tool] Bash: git commit -m "Keep make ci green"', 'committing'],
      ['[tool] Bash: cd /workspace/api && make build', 'building'],
      ['[tool] Bash: git push -u origin agent/builder/7-cache', 'pushing the branch'],
      ['[tool] Bash: gh pr create --title "Cache the price list" --body "Closes #7"', 'opening the pull request'],
      ['[tool] Bash: gh pr diff 31', 'reading the diff'],
      ['[tool] Bash: git diff origin/main...HEAD', 'reading the diff'],
      ['[tool] Bash: gh pr review 31 --approve --body-file review.md', 'writing the review'],
      ['[tool] Bash: gh issue comment 7 --body-file note.md', 'writing a comment'],
      ['[tool] Bash: rg -n "priceList" src', 'searching the code'],
      ['[tool] Bash: sed -n 1,80p src/prices.ts', 'reading the code'],
      ['[tool] Bash: echo done', 'running a command'],
      ['[tool] Read: /workspace/api/src/prices.ts', 'reading the code'],
      ['[tool] Grep: Grep', 'searching the code'],
      ['[tool] Glob: Glob', 'searching the code'],
      ['[tool] Edit: /workspace/api/src/prices.ts', 'editing files'],
      ['[tool] search_replace: src/prices.ts', 'editing files'],
      ['[wrote] src/prices.ts', 'editing files'],
      ['[tool] TodoWrite: TodoWrite', 'planning the work'],
      // Codex runs each command inside a login shell; the command is what is inside it.
      ['[tool] shell: bash -lc "make ci"', 'running CI locally'],
      ["[tool] shell: /bin/bash -lc 'cd /workspace/api && rg -n priceList src'", 'searching the code'],
      // Its older events give the words as a list, joined, with no quotes.
      ['[tool] shell: bash -lc make ci', 'running CI locally'],
      ['[tool] shell: sh -c "git push origin HEAD"', 'pushing the branch'],
      // Starting, its briefing, a question, finishing: no step to name, so the card says its kind of work.
      ['[skill] openadlc-atlas-janedoe starting implement on api#7', null],
      ['[skill] waiting on a person: Which cache?', null],
      ['[tool] SomethingNew: x', null],
    ];
    for (const [line, words] of cases) expect(activityOf(['[skill] starting', line]), line).toBe(words);
    expect(activityOf([])).toBeNull();
  });

  it('reads a command tmux wrapped onto the rows below it', () => {
    // A detached session is 80 columns wide: the last row of the pane was
    // the end of the command, and the tool's name was the row above. The
    // row breaks inside the word that says what the command is.
    const start = '[tool] Bash: cd /workspace/';
    const head = `${start}${'a'.repeat(80 - start.length - ' && pnpm exec vit'.length)} && pnpm exec vit`;
    expect(head).toHaveLength(80);
    expect(activityOf(['[tool] Read: src/prices.ts', head])).toBe('running a command');
    expect(activityOf(['[tool] Read: src/prices.ts', head, 'est run src/prices.test.ts'])).toBe('running tests');
  });

  it('puts back the space tmux trims from a wrapped row’s last column', () => {
    // A row one short of the width ended in a space tmux left off.
    const start = '[tool] Bash: cd /workspace/';
    const head = `${start}${'a'.repeat(79 - start.length - ' && pnpm'.length)} && pnpm`;
    expect(head).toHaveLength(79);
    expect(activityOf([head, 'test'])).toBe('running tests');
  });

  it('glues no other output onto a step that did not fill its row', () => {
    // The runner's next real line is not the rest of the command.
    expect(activityOf(['[tool] Bash: echo starting', ' RUN  v4.1.11 vitest'])).toBe('running a command');
  });

  it('says only its own words, never what the session printed', () => {
    // The screen is an admin's (`sessionsFor`); the board is anybody's.
    const said = [
      activityOf(['[tool] Bash: curl -H "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789" https://api.example.com']),
      activityOf(['[tool] Read: /home/janedoe/.ssh/id_ed25519']),
      activityOf(['[tool] Bash: export TOKEN=hunter2 && ./deploy.sh']),
    ];
    expect(said).toEqual(['reading the web', 'reading the code', 'running a command']);
  });
});

describe('reading the board’s work', () => {
  const issue = (repoName: string, number: number, extra: Partial<IssueFacts> = {}): IssueFacts => ({
    repoId: repoName === 'api' ? 'repo-1' : 'repo-2',
    repoName,
    number,
    title: `Issue ${number}`,
    stage: 'build',
    url: null,
    prNumber: null,
    labels: [],
    updatedAt: minutesAgo(5),
    ...extra,
  });
  const running = (id: string, subjectRef: string, extra: Partial<TaskFacts> = {}): TaskFacts =>
    ({ ...triage(subjectRef, 'running'), id, botId: 'bot-builder', kind: 'implement', ...extra }) as TaskFacts;

  function install(): void {
    store.issues = [issue('api', 7, { prNumber: 31 }), issue('api', 8, { labels: ['openadlc:ignore'] }), issue('web', 3), issue('api', 9)];
    store.tasks = [
      running('task-review', 'api#31', { kind: 'review', botId: 'bot-lead', startedAt: minutesAgo(40) }),
      { ...triage('api#7', 'queued'), id: 'task-queued', botId: 'bot-builder', kind: 'patch' } as TaskFacts,
      { ...triage('api#7', 'paused'), id: 'task-asking', botId: 'bot-builder', kind: 'patch' } as TaskFacts,
      // On an issue the console leaves out, and with no card at all: not on the board, so not read.
      running('task-ignored', 'api#8'),
      running('task-deploy', 'api@3f2c1a9', { kind: 'deploy' }),
      running('task-web', 'web#3'),
      { ...triage('api#9', 'done'), id: 'task-done', botId: 'bot-builder' } as TaskFacts,
    ];
    store.sessions = [
      { id: 'session-review', taskId: 'task-review', lastLine: 'ter @exampleco/api test' },
      { id: 'session-asking', taskId: 'task-asking', lastLine: '[skill] waiting on a person: Which cache?' },
      { id: 'session-ignored', taskId: 'task-ignored', lastLine: '[tool] Bash: pnpm test' },
      { id: 'session-deploy', taskId: 'task-deploy', lastLine: '[tool] Bash: gh run watch' },
      { id: 'session-web', taskId: 'task-web', lastLine: '[tool] Read: src/app.ts' },
      { id: 'session-shell', taskId: null, lastLine: '$' },
    ];
    store.panes = {
      'session-review': ['[tool] Bash: gh pr diff 31'],
      'session-ignored': ['[tool] Bash: pnpm test'],
      'session-deploy': ['[tool] Bash: gh run watch'],
      'session-web': ['[tool] Read: src/app.ts'],
    };
    // Resumed two minutes ago after a question, forty minutes after it started.
    store.since = { 'task-review': minutesAgo(2) };
    // More than the listing of 200 a page of tasks holds.
    store.running = 231;
    store.lineReads = [];
    store.sinceReads = [];
    store.issueReads = [];
    store.linkReads = [];
  }

  it('reads, in one query each, the latest output and the resume of only the running tasks on the cards it shows', async () => {
    install();
    const work = await readBoardWork(
      {
        issues: store.issues,
        bots: [
          { id: 'bot-builder', name: 'openadlc-atlas-janedoe' },
          { id: 'bot-lead', name: 'noraexampleco' },
        ],
        repos: [
          { id: 'repo-1', name: 'api', fullName: 'exampleco/api', stageModes: {} },
          { id: 'repo-2', name: 'web', fullName: 'exampleco/web', stageModes: {} },
        ],
        gates: [],
        requests: [],
        sessions: store.sessions,
      },
      NOW,
    );
    expect(store.lineReads).toEqual([['session-review', 'session-web']]);
    expect(store.sinceReads.map((ids) => [...ids].sort())).toEqual([['task-review', 'task-web']]);
    expect(work.byRef.get('api#7')?.active.map((one) => [one.state, one.activity, one.since])).toEqual([
      ['running', 'reading the diff', minutesAgo(2)],
      ['queued', null, null],
      ['paused', null, null],
    ]);
    // Counted by the database: every running task in the install.
    expect(work.runningTasks).toBe(231);
  });

  it('reads, for the few-second poll, only each running card shown, with all its work and its step, and the count', async () => {
    install();
    const activity = await readBoardActivity(undefined, NOW);
    expect(activity.running).toBe(231);
    expect(activity.cards.map((card) => card.ref)).toEqual(['api#7', 'web#3']);
    expect(activity.cards[0]?.active.map((one) => [one.bot, one.state, one.activity, one.since])).toEqual([
      ['noraexampleco', 'running', 'reading the diff', minutesAgo(2)],
      ['openadlc-atlas-janedoe', 'queued', null, null],
      ['openadlc-atlas-janedoe', 'paused', null, null],
    ]);
    expect(store.lineReads).toEqual([['session-review', 'session-web']]);

    // A board of one repository polls for its own cards; the count is still the install's.
    install();
    const api = await readBoardActivity('api', NOW);
    expect(api.cards.map((card) => card.ref)).toEqual(['api#7']);
    expect(api.running).toBe(231);
    expect(store.lineReads).toEqual([['session-review']]);
  });

  it('says a running card by its work item’s card, as the board shows it, with the work on every link', async () => {
    install();
    const link = (id: number, itemId: string, kind: BoardLink['kind'], repoId: string, number: number): BoardLink => ({
      id, itemId, itemNumber: id, kind, repoId, number, requestId: null, title: `${kind} ${number}`, state: 'open', url: null, openedAt: minutesAgo(60),
    });
    store.numbered = true;
    store.links = [
      link(1, 'w-1', 'issue', 'repo-2', 3),
      link(2, 'w-1', 'issue', 'repo-1', 9),
      // Linked by hand beside the issues: its review is the item's.
      link(3, 'w-1', 'pull', 'repo-1', 40),
      // Two pull requests and no issue: one card, the first's.
      link(4, 'w-2', 'pull', 'repo-1', 50),
      link(5, 'w-2', 'pull', 'repo-1', 51),
    ];
    store.tasks.push(running('task-40', 'api#40', { kind: 'review', botId: 'bot-lead' }), running('task-51', 'api#51', { kind: 'review', botId: 'bot-lead' }));
    try {
      const all = await readBoardActivity(undefined, NOW);
      // Without grouping these were web#3, api#9's nothing, api#40 and api#51: refs the board does not show.
      expect(all.cards.map((card) => [card.ref, card.active.map((task) => task.state)])).toEqual([
        ['api#50', ['running']],
        ['api#7', ['running', 'queued', 'paused']],
        ['web#3', ['running', 'running']],
      ]);
      // The item with a link in api is on api's board, its card web#3's.
      expect((await readBoardActivity('api', NOW)).cards.map((card) => card.ref)).toEqual(['api#50', 'api#7', 'web#3']);
    } finally {
      store.numbered = false;
      store.links = [];
    }
  });

  it('reads nothing but the running tasks and their count when nothing runs', async () => {
    install();
    store.tasks = store.tasks.filter((task) => task.state !== 'running');
    store.numbered = true;
    try {
      expect(await readBoardActivity(undefined, NOW)).toEqual({ running: 231, cards: [] });
      // It read every link and every repository's issues before finding nothing ran.
      expect(store.issueReads).toEqual([]);
      expect(store.linkReads).toEqual([]);
    } finally {
      store.numbered = false;
    }
  });

  it('reads, numbered, only the links of the items with work running, and their issues one by one', async () => {
    install();
    const link = (id: number, itemId: string, kind: BoardLink['kind'], repoId: string, number: number): BoardLink => ({
      id, itemId, itemNumber: id, kind, repoId, number, requestId: null, title: `${kind} ${number}`, state: 'open', url: null, openedAt: minutesAgo(60),
    });
    store.numbered = true;
    store.links = [
      link(1, 'w-1', 'issue', 'repo-2', 3),
      link(2, 'w-1', 'issue', 'repo-1', 9),
      // Nothing runs on it: none of it is read.
      link(3, 'w-3', 'issue', 'repo-1', 70),
      link(4, 'w-3', 'pull', 'repo-1', 71),
    ];
    try {
      const all = await readBoardActivity(undefined, NOW);
      expect(all.cards.map((card) => card.ref)).toEqual(['api#7', 'web#3']);
      expect(store.linkReads).toHaveLength(1);
      expect(store.linkReads[0]).not.toBe('all');
      // web#3 and api#9 by their rows; api, for the running review on api#31 that no link names yet.
      expect([...store.issueReads].sort()).toEqual(['api', 'repo-1#9', 'repo-2#3']);
    } finally {
      store.numbered = false;
      store.links = [];
    }
  });

  it('takes from a linked issue the pull its row records when that pull is not linked to the same item, read or not', () => {
    const link = (id: number, itemId: string, kind: BoardLink['kind'], number: number): BoardLink => ({
      id, itemId, itemNumber: id, kind, repoId: 'repo-1', number, requestId: null, title: `${kind} ${number}`, state: 'open', url: null, openedAt: minutesAgo(60),
    });
    const repos = [{ id: 'repo-1', name: 'api' }];
    // Pull 31's item is outside the links the board read, its link closed long ago.
    expect(withItemPulls([issue('api', 12, { prNumber: 31 })], [link(1, 'w-1', 'issue', 12)], repos)[0]?.prNumber).toBeNull();
    // An issue with no link, in a repository not numbered yet, keeps its row's.
    expect(withItemPulls([issue('api', 12, { prNumber: 31 })], [link(1, 'w-1', 'issue', 40)], repos)[0]?.prNumber).toBe(31);
  });

  it('puts a request’s work on its item’s card by its link, and not on the issue it was filed as once unlinked', () => {
    const repos = [{ id: 'repo-1', name: 'api', fullName: 'exampleco/api', stageModes: {} }];
    const filed = { id: 'abcdef01-0000-4000-8000-000000000000', repoId: 'repo-1', issueNumber: 12, text: 'Request', state: 'filed', createdAt: minutesAgo(60), updatedAt: minutesAgo(50) };
    const links: BoardLink[] = [
      { id: 1, itemId: 'w-2', itemNumber: 2, kind: 'request', repoId: null, number: null, requestId: filed.id, title: 'Request', state: 'open', url: null, openedAt: minutesAgo(60) },
      { id: 2, itemId: 'w-1', itemNumber: 1, kind: 'issue', repoId: 'repo-1', number: 12, requestId: null, title: 'Issue 12', state: 'open', url: null, openedAt: minutesAgo(50) },
      { id: 3, itemId: 'w-3', itemNumber: 3, kind: 'issue', repoId: 'repo-1', number: 13, requestId: null, title: 'Issue 13', state: 'open', url: null, openedAt: minutesAgo(50) },
      { id: 4, itemId: 'w-3', itemNumber: 3, kind: 'issue', repoId: 'repo-1', number: 14, requestId: null, title: 'Issue 14', state: 'open', url: null, openedAt: minutesAgo(50) },
      { id: 5, itemId: 'w-3', itemNumber: 3, kind: 'request', repoId: null, number: null, requestId: 'fedcba98-0000-4000-8000-000000000000', title: 'Another', state: 'open', url: null, openedAt: minutesAgo(40) },
    ];
    const issues = [issue('api', 12, { stage: 'review' }), issue('api', 13), issue('api', 14)];
    const itemRequests = requestsOnCards(links, repos, issues);
    // W-3's request on its first issue's card only, so it is counted once.
    expect(Object.fromEntries(itemRequests)).toEqual({ 'api#12': [], 'api#13': ['request:fedcba98'], 'api#14': [] });
    const work = boardWork({
      issues,
      tasks: [{ ...triage('request:abcdef01', 'done'), costUsd: 0.25 } as TaskFacts],
      bots: [],
      repos,
      gates: [],
      stallEvents: [],
      requests: [filed],
      now: NOW,
      itemRequests,
    });
    expect(work.byRef.get('api#12')?.costUsd).toBe(0);
    // Joined by `issue_number`, as before work items, it was #12's.
    expect(boardWork({ issues, tasks: [{ ...triage('request:abcdef01', 'done'), costUsd: 0.25 } as TaskFacts], bots: [], repos, gates: [], stallEvents: [], requests: [filed], now: NOW }).byRef.get('api#12')?.costUsd).toBe(0.25);
  });

  it('counts a pull unlinked from its issue on its own card, and no longer on the issue’s, though the issue still records it', () => {
    const link = (id: number, itemId: string, kind: BoardLink['kind'], number: number): BoardLink => ({
      id, itemId, itemNumber: id, kind, repoId: 'repo-1', number, requestId: null, title: `${kind} ${number}`, state: 'open', url: null, openedAt: minutesAgo(60),
    });
    // #12's row still has `prNumber: 31`; a person unlinked #31 into an item of its own.
    const links = [link(1, 'w-1', 'issue', 12), link(2, 'w-2', 'pull', 31)];
    const repos = [{ id: 'repo-1', name: 'api', fullName: 'exampleco/api', stageModes: {} }];
    const issues = withItemPulls([issue('api', 12, { prNumber: 31, stage: 'review' })], links, repos);
    expect(issues[0]?.prNumber).toBeNull();
    // While it is on #12's item, it stays #12's own.
    expect(withItemPulls([issue('api', 12, { prNumber: 31 })], [link(1, 'w-1', 'issue', 12), link(2, 'w-1', 'pull', 31)], repos)[0]?.prNumber).toBe(31);

    const loose = loosePulls(links, repos, issues);
    expect(loose).toEqual([{ ref: 'api#31', number: 31 }]);
    const work = boardWork({
      issues,
      tasks: [running('review-31', 'api#31', { kind: 'review', botId: 'bot-lead', costUsd: 0.5 })],
      bots: [{ id: 'bot-lead', name: 'noraexampleco' }],
      repos,
      gates: [{ taskId: 'review-31' }],
      stallEvents: [],
      requests: [],
      now: NOW,
      pulls: loose,
    });
    expect(work.byRef.get('api#31')).toMatchObject({ costUsd: 0.5, gateOpen: true, assignees: ['noraexampleco'] });
    expect(work.byRef.get('api#12')).toMatchObject({ costUsd: 0, prNumber: null, assignees: [] });
  });

  it('says a triage still running on its request as the card of the issue it was filed as', async () => {
    install();
    const { requests } = await import('@openadlc/db');
    const filed = { id: 'abcdef01-0000-4000-8000-000000000000', repoId: 'repo-1', issueNumber: 9, text: 'Request', state: 'filed', createdAt: minutesAgo(30), updatedAt: minutesAgo(20) };
    vi.mocked(requests.listRequests).mockResolvedValue([filed] as never);
    store.numbered = true;
    store.links = [
      { id: 1, itemId: 'w-1', itemNumber: 1, kind: 'request', repoId: null, number: null, requestId: filed.id, title: 'Request', state: 'open', url: null, openedAt: minutesAgo(30) },
      { id: 2, itemId: 'w-1', itemNumber: 1, kind: 'issue', repoId: 'repo-1', number: 9, requestId: null, title: 'Issue 9', state: 'open', url: null, openedAt: minutesAgo(20) },
    ];
    store.tasks.push(running('task-triage', 'request:abcdef01', { kind: 'intake', botId: 'bot-builder' }));
    store.sessions.push({ id: 'session-triage', taskId: 'task-triage', lastLine: null });
    store.panes['session-triage'] = ['[tool] Read: src/app.ts'];
    try {
      const all = await readBoardActivity(undefined, NOW);
      // Said as request:abcdef01, it named a card the board had dropped once #9 was on it.
      expect(all.cards.map((card) => card.ref)).toEqual(['api#7', 'api#9', 'web#3']);
      expect(all.cards.find((card) => card.ref === 'api#9')?.active.map((task) => [task.state, task.activity])).toEqual([['running', 'reading the code']]);
    } finally {
      vi.mocked(requests.listRequests).mockResolvedValue([]);
      store.numbered = false;
      store.links = [];
    }
  });
});

/**
 * A card with nothing running on it says why it waits, since when, and on
 * what; a build paused on a question says it holds one of its repository's
 * builds while cards wait for one (#144). #141 said "Waiting for a design
 * pass" for half an hour, and nothing said what it waited on.
 */
describe('a card with nothing going on it', () => {
  const card = (number: number, stage: IssueFacts['stage'], extra: Partial<IssueFacts> = {}): IssueFacts => ({
    repoId: 'repo-1',
    repoName: 'api',
    number,
    title: `Issue ${number}`,
    stage,
    url: null,
    prNumber: null,
    labels: [`adlc:${stage}`],
    updatedAt: minutesAgo(20),
    ...extra,
  });
  const crew = [
    { id: 'bot-spec', name: 'system-engineer', role: 'spec', maxTasks: 1 },
    { id: 'bot-builder', name: 'openadlc-atlas-janedoe', role: 'implement', maxTasks: 2 },
  ];
  const repos = [{ id: 'repo-1', name: 'api', fullName: 'exampleco/api', stageModes: {}, defaultBranch: 'main', concurrency: 1 }];
  const designing = { ...triage('api#137', 'running'), id: 'task-design', botId: 'bot-spec', kind: 'spec' } as TaskFacts;
  const asking = { ...triage('api#40', 'paused'), id: 'task-asking', botId: 'bot-builder', kind: 'implement' } as TaskFacts;
  const read = (waiting?: Parameters<typeof boardWork>[0]['waiting']) =>
    boardWork({
      issues: [card(137, 'spec'), card(141, 'spec'), card(40, 'build', { labels: ['adlc:build', 'start:now'] }), card(160, 'build', { labels: ['adlc:build', 'start:now'] })],
      tasks: [designing, asking],
      bots: crew,
      repos,
      gates: [{ taskId: 'task-asking' }],
      stallEvents: [],
      requests: [],
      now: NOW,
      ...(waiting ? { waiting } : {}),
    });

  it('says the seat it waits for and the task on it, and on a paused build that it holds its repository’s one build', () => {
    const work = read({ nextSweepAt: '2026-09-29T12:24:00.000Z' });
    expect(work.byRef.get('api#141')?.waiting).toEqual({
      reason: {
        kind: 'seat',
        seat: { name: 'system-engineer', role: 'spec', maxTasks: 1 },
        seats: 1,
        holders: [{ ref: 'api#137', number: 137, kind: 'spec', state: 'running', waitingOnYou: false }],
      },
      since: minutesAgo(20),
      stuck: false,
    });
    expect(work.byRef.get('api#160')?.waiting?.reason).toEqual({
      kind: 'concurrency',
      limit: 1,
      holders: [{ ref: 'api#40', number: 40, kind: 'implement', state: 'paused', waitingOnYou: true }],
    });
    expect(work.byRef.get('api#40')?.active[0]?.holds).toEqual({ repo: 'api', limit: 1, waiting: 1 });
    // Work is going on #137 and #40, so they wait for nothing.
    expect(work.byRef.get('api#137')?.waiting).toBeNull();
    expect(work.byRef.get('api#40')?.waiting).toBeNull();
  });

  it('says nothing of waiting where nothing was asked to work it out: the activity poll', () => {
    const work = read();
    expect(work.byRef.get('api#141')).not.toHaveProperty('waiting');
    expect(work.byRef.get('api#40')?.active[0]).not.toHaveProperty('holds');
  });

  it('reads what a waiting card waits on, and a repository’s work in flight only where a build could start', async () => {
    store.issues = [card(141, 'spec'), card(160, 'build', { labels: ['adlc:build', 'start:now'], declaredPaths: ['src/prices.ts'] })];
    store.tasks = [];
    store.sessions = [];
    store.flightReads = [];
    store.settings = { workPausedSeats: JSON.stringify({ 'system-engineer': { by: 'orzelig', at: minutesAgo(30), why: 'changing its model' } }) };
    store.budget = null;
    const work = await readBoardWork(
      {
        issues: store.issues,
        bots: crew,
        repos,
        gates: [],
        requests: [],
        waiting: { nextSweepAt: () => new Date('2026-09-29T12:24:00.000Z'), pathPolicy: async () => DEFAULT_PATH_POLICY },
      },
      NOW,
    );
    expect(store.flightReads).toEqual(['repo-1']);
    expect(work.byRef.get('api#141')?.waiting?.reason).toEqual({
      kind: 'seat_paused',
      seat: { name: 'system-engineer', role: 'spec', maxTasks: 1 },
      words: 'system-engineer is paused by orzelig: changing its model',
    });
    expect(work.byRef.get('api#160')?.waiting?.reason).toEqual({ kind: 'lease', on: [44], paths: ['src/prices.ts'] });

    // At the month's cap, nothing new starts, and the card says so.
    store.settings = {};
    store.budget = { period: '2026-09', capUsd: 500, spentUsd: 512.5, state: 'stopped' };
    const capped = await readBoardWork({ issues: [card(141, 'spec')], bots: crew, repos, gates: [], requests: [], waiting: {} }, NOW);
    expect(capped.byRef.get('api#141')?.waiting?.reason).toEqual({ kind: 'cap', words: "this month's spend is $512.50 of the $500.00 monthly cap" });
    // Unless the costs file lets work go on past it.
    const past = await readBoardWork({ issues: [card(141, 'spec')], bots: crew, repos, gates: [], requests: [], waiting: { stopLeasing: false } }, NOW);
    expect(past.byRef.get('api#141')?.waiting?.reason.kind).toBe('free');
    store.budget = null;
  });
});
