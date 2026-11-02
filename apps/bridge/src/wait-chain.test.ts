import { describe, expect, it } from 'vitest';
import { attentionItems, type AttentionInput } from './attention.js';
import { followWaits, MAX_WAIT_DEPTH, personWaitsOf, type FollowInput, type WaitChain, type WaitFacts } from './wait-chain.js';
import { waitingCards, waitingOf, type CardWaiting, type WaitingContext } from './waiting.js';
import { isActive, type IssueFacts, type TaskFacts } from './work.js';

/**
 * A waiting card's wait followed to its root: on 2026-10-30 four cards sat for
 * hours behind one approval, each saying only the step in front of it.
 */

const NOW = new Date('2026-10-30T12:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const REPO = { id: 'repo-1', name: 'OpenADLC', fullName: '620legal/OpenADLC', stageModes: {} as Record<string, string>, concurrency: 1 };
const BOTS = [
  { id: 'bot-builder', name: 'builder', slot: 'builder', role: 'implement', githubLogin: 'builder', maxTasks: 2 },
  { id: 'bot-spec', name: 'system-engineer', slot: 'system-engineer', role: 'spec', githubLogin: null, maxTasks: 1 },
];

function issue(number: number, stage: IssueFacts['stage'], extra: Partial<IssueFacts> = {}): IssueFacts {
  return {
    repoId: 'repo-1',
    repoName: 'OpenADLC',
    number,
    title: `Issue ${number}`,
    stage,
    url: `https://github.com/620legal/OpenADLC/issues/${number}`,
    prNumber: null,
    labels: [`adlc:${stage}`],
    updatedAt: ago(90),
    ...extra,
  };
}

/** In Build, waiting on the issues its Dependencies name. */
const blocked = (number: number, ...on: (number | string)[]) =>
  issue(number, 'build', { labels: ['adlc:build', 'blocked'], body: `## Dependencies\n\n${on.map((one) => `- ${typeof one === 'number' ? `#${one}` : one}`).join('\n')}\n` });

function task(id: string, subjectRef: string, state: TaskFacts['state'], kind: TaskFacts['kind'] = 'implement'): TaskFacts {
  return { id, botId: kind === 'spec' ? 'bot-spec' : 'bot-builder', repoId: 'repo-1', kind, subjectRef, state, round: 0, costUsd: 0, startedAt: null, endedAt: null, exitReason: null, createdAt: ago(60) };
}

const gate = (id: string, taskId: string) => ({ id, taskId, question: 'Add the paths?', options: ['Approve', 'Refuse'], githubCommentUrl: null, createdAt: ago(45) });

/** What `waitingOf` says of each card, as both reads work it out. */
function waitsOf(issues: readonly IssueFacts[], tasks: readonly TaskFacts[], gates: readonly { taskId: string }[], context: WaitingContext = {}): Map<string, CardWaiting> {
  return waitingOf({
    ...context,
    now: NOW,
    cards: waitingCards(issues, tasks),
    issues,
    live: tasks.filter(isActive),
    bots: BOTS,
    repos: [REPO],
    gated: new Set(gates.map((one) => one.taskId)),
  }).cards;
}

function follow(issues: IssueFacts[], tasks: TaskFacts[] = [], gates: ReturnType<typeof gate>[] = [], facts: WaitFacts = {}, context: WaitingContext = {}): Map<string, WaitChain> {
  return followWaits({
    ...facts,
    issues,
    waiting: waitsOf(issues, tasks, gates, context),
    tasks,
    gates,
    persons: personWaitsOf({ ...facts, issues, tasks, gates, stallEvents: [], repos: [REPO] }),
  });
}

/**
 * 2026-10-30: #216 and #214 wait for the one build slot; the paused #217
 * holds it, its approved plan change waiting for files #207 holds; #207 is in
 * review, stacked on #206; and #206's pull request #213 waits for @orzelig.
 */
function tenThirty() {
  const issues = [
    issue(216, 'build', { labels: ['adlc:build', 'start:now'] }),
    issue(214, 'build', { labels: ['adlc:build', 'start:now'] }),
    issue(217, 'build', { labels: ['adlc:build', 'start:now'] }),
    issue(207, 'review', { prNumber: 212 }),
    issue(206, 'review', { prNumber: 213 }),
  ];
  const tasks = [task('task-217', 'OpenADLC#217', 'paused')];
  const gates = [gate('gate-217', 'task-217')];
  const facts: Required<Pick<WaitFacts, 'heldPlanChanges' | 'stackLinks' | 'personAwaits'>> = {
    heldPlanChanges: [{ gateId: 'gate-217', paths: ['apps/bridge/src/stacking.ts'], approvedBy: 'orzelig', blockedBy: [207] }],
    stackLinks: [{ repoId: 'repo-1', issue: 207, onIssue: 206, onPr: 213 }],
    personAwaits: [{ at: ago(120), payload: { repo: 'OpenADLC', pr: 213, issue: 206, login: 'orzelig', head: 'abc1234def', paths: ['config/'] } }],
  };
  return { issues, tasks, gates, facts };
}

const ROOT = {
  kind: 'person',
  ref: 'OpenADLC#206',
  action: 'approve',
  number: 213,
  attentionId: 'approval:OpenADLC#213@orzelig',
  url: 'https://github.com/620legal/OpenADLC/pull/213',
} as const;

describe('the 10-30 chain', () => {
  it('follows all four cards to the one approval, through the build slot, the plan change and the stack', () => {
    const { issues, tasks, gates, facts } = tenThirty();
    const chains = follow(issues, tasks, gates, facts);
    for (const ref of ['OpenADLC#216', 'OpenADLC#214', 'OpenADLC#217', 'OpenADLC#207']) {
      expect(chains.get(ref), ref).toMatchObject({ end: ROOT, behind: 4 });
    }
    expect(chains.get('OpenADLC#216')?.links).toEqual([
      { from: 'OpenADLC#216', to: 'OpenADLC#217', kind: 'concurrency' },
      { from: 'OpenADLC#217', to: 'OpenADLC#207', kind: 'plan_change' },
      { from: 'OpenADLC#207', to: 'OpenADLC#206', kind: 'stack' },
    ]);
    expect(chains.get('OpenADLC#207')?.links).toEqual([{ from: 'OpenADLC#207', to: 'OpenADLC#206', kind: 'stack' }]);
  });

  it('gives the root itself no chain: its own card says what it waits on', () => {
    const { issues, tasks, gates, facts } = tenThirty();
    expect(follow(issues, tasks, gates, facts).has('OpenADLC#206')).toBe(false);
  });

  it('stops at the paused build when its gate is a question, not an approved plan change', () => {
    const { issues, tasks, gates, facts } = tenThirty();
    const chains = follow(issues, tasks, gates, { ...facts, heldPlanChanges: [] });
    expect(chains.get('OpenADLC#216')).toMatchObject({ end: { kind: 'person', ref: 'OpenADLC#217', action: 'answer', attentionId: 'gate:gate-217' }, behind: 2 });
    // The question is #217's own: its card asks it already.
    expect(chains.has('OpenADLC#217')).toBe(false);
  });

  it('lets the stack go once what it was built on shipped', () => {
    const { issues, tasks, gates, facts } = tenThirty();
    const merged = issues.map((one) => (one.number === 206 ? { ...one, stage: 'merged' as const, labels: ['adlc:merged'] } : one));
    const chains = follow(merged, tasks, gates, facts);
    expect(chains.has('OpenADLC#207')).toBe(false);
    expect(chains.get('OpenADLC#216')?.end).toEqual({ kind: 'self', ref: 'OpenADLC#207', words: 'which is in review' });
  });
});

describe('a chain nobody can end', () => {
  it('names a loop, from each side', () => {
    const chains = follow([blocked(1, 2), blocked(2, 1)]);
    expect(chains.get('OpenADLC#1')?.end).toEqual({ kind: 'dead', ref: 'OpenADLC#1', why: 'loop', loop: ['OpenADLC#1', 'OpenADLC#2'] });
    expect(chains.get('OpenADLC#2')?.end).toEqual({ kind: 'dead', ref: 'OpenADLC#2', why: 'loop', loop: ['OpenADLC#2', 'OpenADLC#1'] });
  });

  it('names a dependency closed without merging', () => {
    const chains = follow([blocked(3, 4), issue(4, 'done', { labels: ['adlc:done', 'openadlc:abandoned'] })]);
    expect(chains.get('OpenADLC#3')).toEqual({ links: [{ from: 'OpenADLC#3', to: 'OpenADLC#4', kind: 'dependency' }], end: { kind: 'dead', ref: 'OpenADLC#4', why: 'abandoned' }, behind: 1 });
  });

  it('names an ignored one closed as not planned, and one outside the install', () => {
    const ignored = new Map([['repo-1#18', { state: 'closed' as const, stateReason: 'not_planned' }]]);
    expect(follow([blocked(5, 18)], [], [], {}, { ignored }).get('OpenADLC#5')?.end).toEqual({ kind: 'dead', ref: 'OpenADLC#18', why: 'closed' });
    expect(follow([blocked(6, 'other/b#3')]).get('OpenADLC#6')?.end).toEqual({ kind: 'dead', ref: 'other/b#3', why: 'outside' });
  });

  it('keeps a person over a dead end, whichever comes first', () => {
    const chains = follow([blocked(7, 8, 9), issue(8, 'done', { labels: ['adlc:done', 'openadlc:abandoned'] }), issue(9, 'build', { labels: ['adlc:build', 'needs-triage'] })]);
    expect(chains.get('OpenADLC#7')?.end).toMatchObject({ kind: 'person', ref: 'OpenADLC#9', action: 'triage', attentionId: 'parked:OpenADLC#9' });
  });
});

describe('a chain with no person at the end', () => {
  it('ends on the task running, two links on, and needs no one', () => {
    const chains = follow([blocked(10, 11), blocked(11, 12), issue(12, 'spec')], [task('task-12', 'OpenADLC#12', 'running', 'spec')]);
    expect(chains.get('OpenADLC#10')).toEqual({
      links: [
        { from: 'OpenADLC#10', to: 'OpenADLC#11', kind: 'dependency' },
        { from: 'OpenADLC#11', to: 'OpenADLC#12', kind: 'dependency' },
      ],
      end: { kind: 'self', ref: 'OpenADLC#12', words: 'which is running now' },
      behind: 2,
    });
  });

  it('gives a card with work going, or one that waits on nothing, no chain', () => {
    // #15 is next in line for a free seat: a wait on nothing.
    const chains = follow([blocked(13, 14), issue(14, 'review'), issue(15, 'spec')], [task('task-13', 'OpenADLC#13', 'running')]);
    expect(waitsOf([issue(15, 'spec')], [], []).get('OpenADLC#15')?.reason.kind).toBe('free');
    expect(chains.has('OpenADLC#13')).toBe(false);
    expect(chains.has('OpenADLC#15')).toBe(false);
  });
});

describe('following terminates', () => {
  it(`stops a chain of 20 at link ${MAX_WAIT_DEPTH}, on the last node it reached`, () => {
    const issues = Array.from({ length: 20 }, (_, index) => (index < 19 ? blocked(101 + index, 102 + index) : issue(120, 'spec')));
    const chain = follow(issues).get('OpenADLC#101')!;
    expect(chain.links).toHaveLength(MAX_WAIT_DEPTH);
    expect(chain.end).toEqual({ kind: 'deep', ref: `OpenADLC#${101 + MAX_WAIT_DEPTH}` });
  });

  it('on any graph, cycles and all', () => {
    // A seeded generator, so a failure is the same graph every run.
    let seed = 221;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let round = 0; round < 50; round++) {
      const size = 2 + Math.floor(random() * 30);
      const refs = Array.from({ length: size }, (_, index) => `OpenADLC#${index + 1}`);
      const issues = refs.map((_, index) => issue(index + 1, 'build'));
      const waiting = new Map<string, CardWaiting>();
      for (const ref of refs) {
        if (random() < 0.2) continue;
        const on = Array.from({ length: 1 + Math.floor(random() * 3) }, () => refs[Math.floor(random() * size)]!);
        waiting.set(ref, { reason: { kind: 'turn', seat: { name: 'builder', role: 'implement', maxTasks: 1 }, after: on }, since: ago(5), stuck: false });
      }
      const input: FollowInput = { issues, waiting, tasks: [], gates: [], persons: [] };
      const chains = followWaits(input);
      for (const chain of chains.values()) {
        expect(chain.links.length).toBeLessThanOrEqual(MAX_WAIT_DEPTH);
        chain.links.forEach((link, index) => index > 0 && expect(link.from).toBe(chain.links[index - 1]!.to));
        expect(['dead', 'deep', 'self']).toContain(chain.end.kind);
      }
    }
  });
});

describe('a root names its Needs you card', () => {
  const base = (extra: Partial<AttentionInput>): AttentionInput => ({
    now: NOW,
    gates: [],
    tasks: [],
    bots: BOTS,
    repos: [REPO],
    issues: [],
    requests: [],
    stallEvents: [],
    ...extra,
  });
  const cases: [string, AttentionInput][] = [
    ['a question', base({ issues: [issue(30, 'build')], tasks: [task('task-30', 'OpenADLC#30', 'paused')], gates: [gate('gate-30', 'task-30')] })],
    ['a merge held for a person', base({ issues: [issue(31, 'review', { prNumber: 40 })], heldMerges: [{ repo: 'OpenADLC', prNumber: 40, reason: 'only a person merges here', since: ago(30) }] })],
    [
      'an approval again',
      base({ issues: [issue(32, 'review', { prNumber: 41 })], personAsks: [{ at: ago(30), payload: { repo: 'OpenADLC', pr: 41, issue: 32, login: 'Orzelig', head: 'abc1234def' } }] }),
    ],
    [
      'a first approval',
      base({ issues: [issue(33, 'review', { prNumber: 42 })], personAwaits: [{ at: ago(30), payload: { repo: 'OpenADLC', pr: 42, issue: 33, login: 'orzelig', head: 'abc1234def', paths: [] } }] }),
    ],
    ['a stalled review', base({ issues: [issue(34, 'review', { prNumber: 43 })], stallEvents: [{ at: ago(30), payload: { repo: 'OpenADLC', pr: 43, issue: 34, rounds: 3 } }] })],
    [
      'a stack held for a person',
      base({
        issues: [issue(35, 'build', { labels: ['adlc:build', 'openadlc:paused'] }), issue(36, 'review', { prNumber: 44 })],
        heldStacks: [{ repo: 'OpenADLC', issue: 35, on: 36, onPr: 44, since: ago(30), why: null, needsPerson: 'its builder could not take it' }],
      }),
    ],
    ['a parked issue', base({ issues: [issue(37, 'build', { labels: ['adlc:build', 'needs-triage'] })] })],
  ];

  it.each(cases)('%s, by the id Needs you gives it', (_name, input) => {
    const waits = personWaitsOf(input);
    expect(waits).toHaveLength(1);
    expect(attentionItems(input).map((item) => item.id)).toContain(waits[0]!.attentionId);
  });

  it('names no question for an approved plan change waiting on other work', () => {
    const { issues, tasks, gates, facts } = tenThirty();
    const input = base({ issues, tasks, gates, ...facts });
    expect(personWaitsOf(input).map((wait) => wait.attentionId)).toEqual(['approval:OpenADLC#213@orzelig']);
    expect(attentionItems(input).map((item) => item.id)).toContain('plan-change:gate-217');
  });
});
