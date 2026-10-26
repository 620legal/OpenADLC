import { describe, expect, it } from 'vitest';
import { DEFAULT_PATH_POLICY } from '@openadlc/shared';
import { buildCandidates, STUCK_AFTER_MS, waitingCards, waitingOf, type LeaseFacts, type WaitingInput } from './waiting.js';
import { isActive, type IssueFacts, type TaskFacts } from './work.js';

/**
 * Why a card with nothing running on it waits, since when, and on what. On
 * 2026-10-23 #141 said "Waiting for a design pass" for half an hour after the
 * design seat had turned it away busy with #137, and #137 "Waiting on #141";
 * nothing on the board said either.
 */

const NOW = new Date('2026-10-23T14:02:00.000Z');
const ago = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const INTAKE = { id: 'bot-intake', name: 'ottoexampleco', role: 'intake', maxTasks: 1 };
const DESIGNER = { id: 'bot-spec', name: 'system-engineer', role: 'spec', maxTasks: 1 };
const BUILDER = { id: 'bot-builder', name: 'openadlc-atlas-janedoe', role: 'implement', maxTasks: 1 };
const CREW = [INTAKE, DESIGNER, BUILDER];
const REPOS = [{ id: 'repo-1', name: 'OpenADLC', stageModes: {} as Record<string, string>, concurrency: 2 }];

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
    updatedAt: ago(16),
    body: '',
    createdAt: ago(600 - number),
    ...extra,
  };
}

/** A ready build: what the dispatcher leases. */
const ready = (number: number, extra: Partial<IssueFacts> = {}) => issue(number, 'build', { labels: ['adlc:build', 'start:now'], ...extra });

let count = 0;
function task(subjectRef: string, botId: string, kind: TaskFacts['kind'], state: TaskFacts['state'], extra: Partial<TaskFacts> = {}): TaskFacts {
  count += 1;
  return {
    id: `task-${count}`,
    botId,
    repoId: 'repo-1',
    kind,
    subjectRef,
    state,
    round: 0,
    costUsd: 0,
    startedAt: ago(90),
    endedAt: isActive({ state }) ? null : ago(30),
    exitReason: null,
    createdAt: ago(90),
    ...extra,
  };
}

function read(issues: IssueFacts[], tasks: TaskFacts[] = [], extra: Partial<WaitingInput> = {}) {
  return waitingOf({
    now: NOW,
    cards: waitingCards(issues, tasks),
    live: tasks.filter(isActive),
    bots: CREW,
    repos: REPOS,
    gated: new Set(),
    nextSweepAt: '2026-10-23T14:26:00.000Z',
    ...extra,
  });
}

describe('a card waiting for a seat', () => {
  it('names the busy seat and the task running on it, and since when', () => {
    // #137's design, on the design seat's one slot.
    const designing = task('OpenADLC#137', 'bot-spec', 'spec', 'running');
    const waiting = read([issue(137, 'spec'), issue(141, 'spec')], [designing]);

    expect(waiting.cards.get('OpenADLC#141')).toEqual({
      reason: {
        kind: 'seat',
        seat: { name: 'system-engineer', role: 'spec', maxTasks: 1 },
        seats: 1,
        holders: [{ ref: 'OpenADLC#137', number: 137, kind: 'spec', state: 'running', waitingOnYou: false }],
      },
      since: ago(16),
      stuck: false,
    });
    // A queued one takes its slot too.
    const queued = task('OpenADLC#137', 'bot-spec', 'spec', 'queued');
    expect(read([issue(141, 'spec')], [queued]).cards.get('OpenADLC#141')?.reason).toMatchObject({ kind: 'seat', holders: [{ number: 137, state: 'queued' }] });
  });

  it('does not count a task paused on a person’s answer against its seat, its computer kept or not (#148)', () => {
    const asking = task('OpenADLC#137', 'bot-spec', 'spec', 'paused');
    const waiting = read([issue(141, 'spec')], [asking], { gated: new Set([asking.id]) });
    expect(waiting.cards.get('OpenADLC#141')?.reason.kind).toBe('free');
    expect(waiting.holds.size).toBe(0);
  });

  it('has room on a seat that runs more than one at once', () => {
    const designing = task('OpenADLC#137', 'bot-spec', 'spec', 'running');
    const waiting = read([issue(141, 'spec')], [designing], { bots: [INTAKE, { ...DESIGNER, maxTasks: 2 }, BUILDER] });
    expect(waiting.cards.get('OpenADLC#141')?.reason.kind).toBe('free');
  });
});

describe('a card whose seat is free and nothing started it', () => {
  it('says the next sweep starts it, and when', () => {
    const waiting = read([issue(141, 'spec', { updatedAt: ago(2) })]);
    expect(waiting.cards.get('OpenADLC#141')).toEqual({
      reason: { kind: 'free', seat: { name: 'system-engineer', role: 'spec', maxTasks: 1 }, by: 'sweep', nextAt: '2026-10-23T14:26:00.000Z' },
      since: ago(2),
      stuck: false,
    });
  });

  it('is stuck once it has waited past the limit, and not before', () => {
    expect(STUCK_AFTER_MS).toBe(3 * 60_000);
    expect(read([issue(141, 'spec', { updatedAt: ago(4) })]).cards.get('OpenADLC#141')?.stuck).toBe(true);
    expect(read([issue(141, 'spec', { updatedAt: ago(2) })]).cards.get('OpenADLC#141')?.stuck).toBe(false);
  });

  it('waits from its last task’s end when that is later than its row’s change', () => {
    const triaged = task('OpenADLC#141', 'bot-intake', 'intake', 'done', { endedAt: ago(2) });
    const waiting = read([issue(141, 'spec', { updatedAt: ago(40) })], [triaged]);
    expect(waiting.cards.get('OpenADLC#141')).toMatchObject({ since: ago(2), stuck: false });
  });

  it('is not stuck behind a seat that freed a moment ago', () => {
    const finished = task('OpenADLC#137', 'bot-spec', 'spec', 'done', { endedAt: ago(1) });
    const waiting = read([issue(137, 'build'), issue(141, 'spec', { updatedAt: ago(40) })], [finished]);
    expect(waiting.cards.get('OpenADLC#141')).toMatchObject({ reason: { kind: 'free' }, stuck: false });
  });

  it('says no sweep is coming on a bridge whose stage sweep is off', () => {
    const waiting = read([issue(141, 'spec')], [], { nextSweepAt: null });
    expect(waiting.cards.get('OpenADLC#141')?.reason).toMatchObject({ kind: 'free', nextAt: null });
  });

  it('puts the cards after the first in their turn, behind it', () => {
    const waiting = read([issue(141, 'spec'), issue(150, 'spec')]);
    expect(waiting.cards.get('OpenADLC#141')?.reason.kind).toBe('free');
    expect(waiting.cards.get('OpenADLC#150')?.reason).toEqual({ kind: 'turn', seat: expect.objectContaining({ name: 'system-engineer' }), after: ['OpenADLC#141'] });
    // Only the first can be stuck: the rest wait for it.
    expect(waiting.cards.get('OpenADLC#150')?.stuck).toBe(false);
  });

  it('is a build the dispatcher leases on its next pass, and stuck past the limit', () => {
    const waiting = read([ready(160)]);
    expect(waiting.cards.get('OpenADLC#160')).toMatchObject({ reason: { kind: 'free', by: 'dispatcher', seat: { name: 'openadlc-atlas-janedoe' } }, stuck: true });
    expect(waiting.cards.get('OpenADLC#160')?.reason).not.toHaveProperty('nextAt');
  });
});

/**
 * A start its seat turned away while full is recorded (#143), and starts
 * within a minute of the seat having room: the card says since when it was
 * turned away, and that it starts once the seat has room, not on the sweep.
 */
describe('a card its seat turned away', () => {
  const turnedAway = (minutes: number, number = 141) => ({
    at: ago(minutes),
    payload: { subjectRef: `OpenADLC#${number}`, repo: 'OpenADLC', issue: number, stage: 'spec', seat: 'system-engineer', botId: 'bot-spec', maxTasks: 1 },
  });

  it('waits for the seat from when it was turned away', () => {
    const designing = task('OpenADLC#137', 'bot-spec', 'spec', 'running');
    const waiting = read([issue(141, 'spec', { updatedAt: ago(3) })], [designing], { seatWaitEvents: [turnedAway(16)] });
    expect(waiting.cards.get('OpenADLC#141')).toMatchObject({ reason: { kind: 'seat', holders: [{ number: 137 }] }, since: ago(16) });
  });

  it('starts within a minute of the seat having room, not on the sweep, and is stuck when it does not', () => {
    const waiting = read([issue(141, 'spec')], [], { seatWaitEvents: [turnedAway(16)] });
    expect(waiting.cards.get('OpenADLC#141')).toEqual({
      reason: { kind: 'free', seat: { name: 'system-engineer', role: 'spec', maxTasks: 1 }, by: 'runner' },
      since: ago(16),
      stuck: true,
    });
  });

  it('no longer counts a wait once a task started on it after', () => {
    const tried = task('OpenADLC#141', 'bot-spec', 'spec', 'failed', { createdAt: ago(10), endedAt: ago(9) });
    const waiting = read([issue(141, 'spec', { updatedAt: ago(30) })], [tried], { seatWaitEvents: [turnedAway(16)] });
    expect(waiting.cards.get('OpenADLC#141')).toMatchObject({ reason: { kind: 'free', by: 'sweep' }, since: ago(9) });
  });
});

describe('a card waiting on another issue', () => {
  const blocked = (on: number) => issue(137, 'build', { labels: ['adlc:build', 'blocked'], body: `## Dependencies\n\n- #${on}\n` });

  it('says what that issue is waiting for itself', () => {
    const designing = task('OpenADLC#99', 'bot-spec', 'spec', 'running');
    const waiting = read([blocked(141), issue(141, 'spec'), issue(99, 'spec', { labels: ['adlc:spec'] })], [designing]);
    expect(waiting.cards.get('OpenADLC#137')?.reason).toEqual({
      kind: 'dependency',
      on: [{ ref: '#141', number: 141, stage: 'spec', abandoned: false, task: null, waits: { kind: 'seat', seat: 'system-engineer' } }],
    });
  });

  it('says what is running on it now, in the board’s words', () => {
    const designing = task('OpenADLC#141', 'bot-spec', 'spec', 'running');
    const waiting = read([blocked(141), issue(141, 'spec')], [designing], { activity: (id) => (id === designing.id ? 'editing files' : null) });
    expect(waiting.cards.get('OpenADLC#137')?.reason).toEqual({
      kind: 'dependency',
      on: [{ ref: '#141', number: 141, stage: 'spec', abandoned: false, task: { bot: 'system-engineer', kind: 'spec', state: 'running', waitingOnYou: false, activity: 'editing files' }, waits: null }],
    });
  });

  it('names only the dependencies that have not shipped, and one closed without merging as such', () => {
    const waiting = read([
      issue(137, 'build', { labels: ['adlc:build', 'blocked'], body: '## Dependencies\n\n- #120\n- #121\n' }),
      issue(120, 'done', { labels: ['adlc:done'] }),
      issue(121, 'done', { labels: ['adlc:done', 'openadlc:abandoned'] }),
    ]);
    expect(waiting.cards.get('OpenADLC#137')?.reason).toEqual({ kind: 'dependency', on: [expect.objectContaining({ ref: '#121', number: 121, stage: 'done', abandoned: true })] });
  });

  it('does not wait on a dependency that shipped before the week the board reads, once the dispatcher took the label off', () => {
    const waiting = read([ready(160, { body: '## Dependencies\n\n- #5\n' })]);
    expect(waiting.cards.get('OpenADLC#160')?.reason).toMatchObject({ kind: 'free', by: 'dispatcher' });
  });

  it('says it waits on one the board does not know', () => {
    const waiting = read([blocked(404)]);
    expect(waiting.cards.get('OpenADLC#137')?.reason).toEqual({ kind: 'dependency', on: [{ ref: '#404', number: 404, stage: null, abandoned: false, task: null, waits: null }] });
  });

  describe('in another repository', () => {
    const repos = [
      { ...REPOS[0]!, fullName: '620legal/OpenADLC' },
      { id: 'repo-2', name: 'a', fullName: 'owner/a', stageModes: {} as Record<string, string> },
    ];
    const blockedOn = (body: string) => issue(137, 'build', { labels: ['adlc:build', 'blocked'], body });

    it('names it as written, and keeps waiting on it after this repository’s issue of the same number shipped', () => {
      const theirs = issue(2, 'build', { repoId: 'repo-2', repoName: 'a', labels: ['adlc:build'] });
      const building = task('a#2', 'bot-builder', 'implement', 'running', { repoId: 'repo-2' });
      const waiting = read([blockedOn('## Dependencies\n\n- owner/a#2\n'), issue(2, 'done', { labels: ['adlc:done'] }), theirs], [building], { repos });
      expect(waiting.cards.get('OpenADLC#137')?.reason).toEqual({
        kind: 'dependency',
        on: [{ ref: 'owner/a#2', number: 2, stage: 'build', abandoned: false, task: expect.objectContaining({ bot: 'openadlc-atlas-janedoe', kind: 'implement' }), waits: null }],
      });
    });

    it('does not wait on it once it shipped', () => {
      const waiting = read([blockedOn('## Dependencies\n\n- owner/a#2\n- #5\n'), issue(2, 'done', { repoId: 'repo-2', repoName: 'a', labels: ['adlc:done'] })], [], { repos });
      expect(waiting.cards.get('OpenADLC#137')?.reason).toEqual({ kind: 'dependency', on: [expect.objectContaining({ ref: '#5', number: 5 })] });
    });

    it('names one in a repository the install does not manage, or that spells out its own', () => {
      const waiting = read([blockedOn('## Dependencies\n\n- other/b#3\n- 620legal/openadlc#4\n'), issue(4, 'review')], [], { repos });
      expect(waiting.cards.get('OpenADLC#137')?.reason).toEqual({
        kind: 'dependency',
        on: [
          { ref: 'other/b#3', number: 3, stage: null, abandoned: false, task: null, waits: null },
          expect.objectContaining({ ref: '#4', number: 4, stage: 'review' }),
        ],
      });
    });
  });
});

describe('a build waiting for room', () => {
  it('waits for a lease another change holds on its files, and lets the next card have the builder', () => {
    const waiting = read([ready(160, { declaredPaths: ['apps/bridge/src/api.ts'] }), ready(161, { declaredPaths: ['apps/console/src/lib/when.ts'] })], [], {
      inFlight: new Map([['repo-1', { work: [{ number: 44, paths: ['apps/bridge/src/api.ts'], building: true }], policy: DEFAULT_PATH_POLICY }]]),
    });
    expect(waiting.cards.get('OpenADLC#160')?.reason).toEqual({ kind: 'lease', on: [44], paths: ['apps/bridge/src/api.ts'] });
    expect(waiting.cards.get('OpenADLC#161')?.reason).toMatchObject({ kind: 'free', by: 'dispatcher' });
  });

  it('waits for the builder, busy with another build', () => {
    const building = task('OpenADLC#40', 'bot-builder', 'implement', 'running');
    const waiting = read([issue(40, 'build'), ready(160)], [building]);
    expect(waiting.cards.get('OpenADLC#160')?.reason).toMatchObject({ kind: 'seat', seat: { name: 'openadlc-atlas-janedoe' }, holders: [{ number: 40, kind: 'implement' }] });
  });

  it('waits for its repository’s concurrency, a build paused on a person counting, and the paused build says it holds it', () => {
    const asking = task('OpenADLC#40', 'bot-builder', 'implement', 'paused');
    const waiting = read([issue(40, 'build'), ready(160), ready(161)], [asking], { repos: [{ ...REPOS[0]!, concurrency: 1 }], gated: new Set([asking.id]) });
    expect(waiting.cards.get('OpenADLC#160')?.reason).toEqual({
      kind: 'concurrency',
      limit: 1,
      holders: [{ ref: 'OpenADLC#40', number: 40, kind: 'implement', state: 'paused', waitingOnYou: true }],
    });
    expect(waiting.holds.get(asking.id)).toEqual({ repo: 'OpenADLC', limit: 1, waiting: 2 });
    // A running build takes it too, and holds nothing on its card: it is working.
    const building = task('OpenADLC#40', 'bot-builder', 'implement', 'running');
    const busy = read([issue(40, 'build'), ready(160)], [building], { repos: [{ ...REPOS[0]!, concurrency: 1 }], bots: [INTAKE, DESIGNER, { ...BUILDER, maxTasks: 2 }] });
    expect(busy.cards.get('OpenADLC#160')?.reason).toMatchObject({ kind: 'concurrency', holders: [{ number: 40, state: 'running' }] });
    expect(busy.holds.size).toBe(0);
  });

  it('takes the one a person put next first', () => {
    const waiting = read([ready(160), ready(161, { labels: ['adlc:build', 'start:now', 'openadlc:next'] })]);
    expect(waiting.cards.get('OpenADLC#161')?.reason.kind).toBe('free');
    expect(waiting.cards.get('OpenADLC#160')?.reason).toMatchObject({ kind: 'turn', after: ['OpenADLC#161'] });
  });

  it('says why a build is not ready to lease', () => {
    const waiting = read(
      [
        issue(170, 'build', { labels: ['adlc:build', 'needs-triage'] }),
        issue(171, 'build'),
        ready(172, { labels: ['adlc:build', 'start:now', 'needs-human'] }),
      ],
      [],
    );
    expect(waiting.cards.get('OpenADLC#170')?.reason).toEqual({ kind: 'triage' });
    expect(waiting.cards.get('OpenADLC#171')?.reason).toEqual({ kind: 'not_ready' });
    expect(waiting.cards.get('OpenADLC#172')?.reason).toEqual({ kind: 'for_person' });
  });

  it('says nothing leases it on a bridge with no dispatcher', () => {
    expect(read([ready(160)], [], { dispatching: false }).cards.get('OpenADLC#160')?.reason).toEqual({ kind: 'no_dispatcher' });
  });

  it('reads work in flight only for a repository with a build that could start', () => {
    expect([...buildCandidates(waitingCards([ready(160, { declaredPaths: ['a.ts'] }), issue(141, 'spec')], []))]).toEqual(['OpenADLC']);
    expect([...buildCandidates(waitingCards([ready(160), issue(141, 'spec')], []))]).toEqual([]);
    expect([...buildCandidates(waitingCards([ready(160, { declaredPaths: ['a.ts'] })], [task('OpenADLC#160', 'bot-builder', 'implement', 'running')]))]).toEqual([]);
  });
});

describe('what holds every card in a stage back', () => {
  it('a person’s hold on the card', () => {
    expect(read([issue(141, 'spec', { labels: ['adlc:spec', 'openadlc:paused'] })]).cards.get('OpenADLC#141')?.reason).toEqual({ kind: 'held' });
  });

  it('work paused, in the pause’s words', () => {
    const waiting = read([issue(141, 'spec')], [], { paused: (repo) => (repo === 'OpenADLC' ? 'work is paused in OpenADLC by janedoe' : null) });
    expect(waiting.cards.get('OpenADLC#141')).toMatchObject({ reason: { kind: 'paused', words: 'work is paused in OpenADLC by janedoe' }, stuck: false });
  });

  it('a repository that leaves the stage to a person', () => {
    const waiting = read([issue(141, 'spec')], [], { repos: [{ ...REPOS[0]!, stageModes: { spec: 'untouched' } }] });
    expect(waiting.cards.get('OpenADLC#141')?.reason).toEqual({ kind: 'not_staffed' });
  });

  it('no seat with the role', () => {
    expect(read([issue(141, 'spec')], [], { bots: [INTAKE, BUILDER] }).cards.get('OpenADLC#141')?.reason).toEqual({ kind: 'no_seat', role: 'spec' });
  });

  it('the month’s spend at the cap', () => {
    const waiting = read([issue(141, 'spec')], [], { cap: "this month's spend is $500.00 of the $500.00 monthly cap" });
    expect(waiting.cards.get('OpenADLC#141')).toMatchObject({ reason: { kind: 'cap', words: "this month's spend is $500.00 of the $500.00 monthly cap" }, stuck: false });
  });

  it('its seat paused from Crew', () => {
    const waiting = read([issue(141, 'spec')], [], { seatPaused: new Map([['system-engineer', 'system-engineer is paused by janedoe: changing its model']]) });
    expect(waiting.cards.get('OpenADLC#141')?.reason).toEqual({
      kind: 'seat_paused',
      seat: { name: 'system-engineer', role: 'spec', maxTasks: 1 },
      words: 'system-engineer is paused by janedoe: changing its model',
    });
  });

  it('a check that holds its seat back', () => {
    const health = [{ id: 'bot-sign-in:bot-spec', state: 'failing', title: 'system-engineer cannot sign in', detail: 'Reconnect it from Settings → Crew.' }];
    const waiting = read([issue(141, 'spec')], [], { health });
    expect(waiting.cards.get('OpenADLC#141')).toMatchObject({
      reason: { kind: 'blocked', seat: { name: 'system-engineer' }, why: 'system-engineer cannot sign in to GitHub', instruction: 'Reconnect it from Settings → Crew.' },
      stuck: false,
    });
  });
});

describe('a card that is not waiting for a seat', () => {
  it('has work going on it, is in a stage review or shipping starts, or has a question open', () => {
    const designing = task('OpenADLC#141', 'bot-spec', 'spec', 'running');
    const ended = task('OpenADLC#142', 'bot-spec', 'spec', 'stopped');
    const waiting = read([issue(141, 'spec'), issue(142, 'spec'), issue(30, 'review'), issue(31, 'merged'), issue(32, 'done')], [designing, ended], { gated: new Set([ended.id]) });
    expect([...waiting.cards.keys()]).toEqual([]);
  });

  it('a request’s triage on the issue’s card is work going on it', () => {
    const triage = task('request:abcd1234', 'bot-intake', 'intake', 'running');
    const cards = waitingCards([issue(15, 'intake')], [triage], () => ['request:abcd1234']);
    const waiting = waitingOf({ now: NOW, cards, live: [triage], bots: CREW, repos: REPOS, gated: new Set() });
    expect(waiting.cards.has('OpenADLC#15')).toBe(false);
  });
});

/**
 * A Build card whose issue holds a lease with nothing running under it: the
 * dispatcher never leases an issue a lease holds, so it read as free, was
 * marked stuck after three minutes, and Needs you offered Start it now, which
 * could not move it (#153).
 */
describe('a Build card its own lease holds with nothing running', () => {
  const lease = (number: number, extra: Partial<LeaseFacts> = {}): LeaseFacts => ({
    repoId: 'repo-1',
    issueNumber: number,
    botId: 'bot-builder',
    state: 'leased',
    prNumber: null,
    pullMerged: false,
    updatedAt: ago(40),
    ...extra,
  });

  it('says its lease is taken and its build not started, and is not stuck however long it waits', () => {
    const waiting = read([ready(160, { updatedAt: ago(60) })], [], { leases: [lease(160)] });
    expect(waiting.cards.get('OpenADLC#160')).toEqual({
      reason: { kind: 'leased', bot: 'openadlc-atlas-janedoe', state: 'leased', pr: null, merged: false },
      // Since the lease last changed, which is later than the row.
      since: ago(40),
      stuck: false,
    });
  });

  it('says a lease paused after its task ended, one for its open pull request, and one held by a merged pull request', () => {
    const waiting = read([ready(160), ready(161), ready(162), ready(163)], [], {
      leases: [
        lease(160, { state: 'paused' }),
        lease(161, { state: 'in_task', prNumber: 57 }),
        lease(162, { state: 'in_task', prNumber: 58, pullMerged: true }),
        lease(163, { state: 'in_task' }),
      ],
    });
    expect(waiting.cards.get('OpenADLC#160')).toMatchObject({ reason: { kind: 'leased', state: 'paused', pr: null, merged: false }, stuck: false });
    expect(waiting.cards.get('OpenADLC#161')).toMatchObject({ reason: { kind: 'leased', state: 'in_task', pr: 57, merged: false }, stuck: false });
    expect(waiting.cards.get('OpenADLC#162')).toMatchObject({ reason: { kind: 'leased', state: 'in_task', pr: 58, merged: true }, stuck: false });
    expect(waiting.cards.get('OpenADLC#163')).toMatchObject({ reason: { kind: 'leased', state: 'in_task', pr: null, merged: false }, stuck: false });
  });

  it('takes no builder’s room: the next card is the one the dispatcher leases', () => {
    const waiting = read([ready(160), ready(161)], [], { leases: [lease(160)] });
    expect(waiting.cards.get('OpenADLC#160')?.reason.kind).toBe('leased');
    expect(waiting.cards.get('OpenADLC#161')).toMatchObject({ reason: { kind: 'free', by: 'dispatcher' }, stuck: true });
  });

  it('is not said of a card with its build going, of a lease let go, or of a card in another stage', () => {
    const building = task('OpenADLC#160', 'bot-builder', 'implement', 'running');
    const waiting = read([ready(160), ready(161), issue(141, 'spec')], [building], {
      leases: [lease(160, { state: 'in_task' }), lease(161, { state: 'released' }), lease(141)],
      bots: [INTAKE, DESIGNER, { ...BUILDER, maxTasks: 2 }],
    });
    expect(waiting.cards.has('OpenADLC#160')).toBe(false);
    expect(waiting.cards.get('OpenADLC#161')?.reason.kind).toBe('free');
    expect(waiting.cards.get('OpenADLC#141')?.reason.kind).toBe('free');
  });
});

/**
 * A card with nothing else in its way and every live host running all it has
 * room for waits for a host, said with the hosts' count, and is not stuck:
 * every start is refused until a task ends (#153).
 */
describe('a card waiting only for a host’s room', () => {
  it('says the hosts are full, how full, and is not stuck while they are', () => {
    const waiting = read([ready(160, { updatedAt: ago(30) })], [], { hosts: { running: 4, capacity: 4 } });
    expect(waiting.cards.get('OpenADLC#160')).toEqual({ reason: { kind: 'host', running: 4, capacity: 4 }, since: ago(30), stuck: false });
  });

  it('shares what room the hosts have across every seat, and the cards behind wait their turn', () => {
    const waiting = read([issue(141, 'spec'), ready(160), ready(161)], [], { hosts: { running: 3, capacity: 4 }, bots: [INTAKE, DESIGNER, { ...BUILDER, maxTasks: 2 }] });
    // The design takes the last room; the first build waits for a host, and the next behind it.
    expect(waiting.cards.get('OpenADLC#141')?.reason.kind).toBe('free');
    expect(waiting.cards.get('OpenADLC#160')?.reason).toEqual({ kind: 'host', running: 3, capacity: 4 });
    expect(waiting.cards.get('OpenADLC#161')?.reason).toEqual({ kind: 'host', running: 3, capacity: 4 });
  });

  it('is only what is left: a busy seat is said first, and hosts nobody knows hold nothing back', () => {
    const designing = task('OpenADLC#137', 'bot-spec', 'spec', 'running');
    expect(read([issue(141, 'spec')], [designing], { hosts: { running: 4, capacity: 4 } }).cards.get('OpenADLC#141')?.reason.kind).toBe('seat');
    expect(read([ready(160)], [], { hosts: null }).cards.get('OpenADLC#160')?.reason.kind).toBe('free');
    expect(read([ready(160)], [], { hosts: { running: 3, capacity: 4 } }).cards.get('OpenADLC#160')?.reason.kind).toBe('free');
  });
});
