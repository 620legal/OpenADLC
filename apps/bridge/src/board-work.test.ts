import { describe, expect, it } from 'vitest';
import { boardWork, FILED_SHOWN_MS } from './board-work.js';
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
