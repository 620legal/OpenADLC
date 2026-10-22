import { describe, expect, it } from 'vitest';
import { boardWork, FILED_SHOWN_MS, itemCards, lonePulls, loosePulls, type BoardLink } from './board-work.js';
import type { TaskFacts } from './work.js';

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
      link('w-3', 3, 'pull', 'repo-1', 42, { state: 'closed', openedAt: new Date(NOW.getTime() - 400 * 86_400_000).toISOString() }),
      link('w-4', 4, 'issue', 'repo-1', 5),
      link('w-4', 4, 'pull', 'repo-1', 43),
    ];
    expect(lonePulls(links, REPOS).map((pull) => [pull.ref, pull.stage, pull.title])).toEqual([
      ['api#40', 'review', 'A person’s fix'],
      ['api#41', 'done', 'pull 41'],
      ['api#42', 'done', 'pull 42'],
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
