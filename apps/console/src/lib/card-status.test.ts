import { describe, expect, it } from 'vitest';
import type { BoardCard, CardTask } from './api';
import { cardBot, cardCost, cardStatus, heldApprovalsOf, nextUp, type CardContext } from './card-status';
import { ago, duration, money, ordinal } from './when';

const NOW = '2026-09-24T12:00:00.000Z';
const minutesAgo = (minutes: number): string => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();

function card(partial: Partial<BoardCard> = {}): BoardCard {
  return {
    repo: 'openadlc',
    ref: 'openadlc#16',
    title: 'Let the board filter by label',
    stage: 'build',
    assignees: [],
    gateOpen: false,
    url: null,
    labels: ['adlc:build', 'start:now'],
    updatedAt: minutesAgo(30),
    number: 16,
    prNumber: null,
    costUsd: 0,
    active: [],
    last: null,
    reviewRound: null,
    stalledAfterRounds: null,
    approval: false,
    shippedAt: null,
    ...partial,
  };
}

function task(partial: Partial<CardTask> & Pick<CardTask, 'kind' | 'state'>): CardTask {
  return { bot: 'openadlc-atlas-janedoe', round: 0, startedAt: null, endedAt: null, exitReason: null, ...partial };
}

/** Each bot's role in words, as `labelIn` gives it; a bot the crew does not know has none. */
const ROLES: Record<string, string> = {
  'openadlc-atlas-janedoe': 'builder',
  noraexampleco: 'lead reviewer',
  irisexampleco: 'second reviewer',
  ottoexampleco: 'intake',
};

const CONTEXT: CardContext = { now: NOW, said: (bot) => bot, role: (bot) => ROLES[bot] ?? '' };

describe('a card’s status line', () => {
  it('says which bot is working, what it is doing now, and for how long, with a mark that is live', () => {
    const testing = card({ active: [task({ kind: 'implement', state: 'running', startedAt: minutesAgo(12), activity: 'running tests' })] });
    expect(cardStatus(testing, CONTEXT)).toEqual({ text: 'Builder · running tests · 12 min', tone: 'signal', mark: 'dot', live: true });
  });

  it('says the kind of work for a running task that has not printed a step, or from an older bridge', () => {
    const writing = card({ active: [task({ kind: 'implement', state: 'running', startedAt: minutesAgo(12) })] });
    expect(cardStatus(writing, CONTEXT)).toEqual({ text: 'Builder · writing the change · 12 min', tone: 'signal', mark: 'dot', live: true });
    // A bot the crew does not know is said by its name.
    const stranger = card({ active: [task({ kind: 'spec', state: 'running', bot: 'someone-else', startedAt: minutesAgo(0.5) })] });
    expect(cardStatus(stranger, CONTEXT).text).toBe('someone-else · writing the design · under a minute');
  });

  it('gives a review its reviewer, its step and its round, and says when more than one reviewer is at it', () => {
    const one = card({ stage: 'review', prNumber: 31, reviewRound: 2, active: [task({ kind: 'review', state: 'running', bot: 'noraexampleco', startedAt: minutesAgo(6), activity: 'reading the diff' })] });
    expect(cardStatus(one, CONTEXT)).toEqual({ text: 'Lead reviewer · reading the diff · round 2 · 6 min', tone: 'signal', mark: 'dot', live: true });
    const unsaid = card({ stage: 'review', prNumber: 31, reviewRound: 2, active: [task({ kind: 'review', state: 'running', bot: 'irisexampleco' })] });
    expect(cardStatus(unsaid, CONTEXT).text).toBe('Second reviewer · reviewing · round 2');

    const two = card({
      stage: 'review',
      prNumber: 31,
      reviewRound: 1,
      active: [
        task({ kind: 'review', state: 'running', bot: 'noraexampleco', startedAt: minutesAgo(2) }),
        task({ kind: 'review', state: 'running', bot: 'irisexampleco', startedAt: minutesAgo(4) }),
      ],
    });
    expect(cardStatus(two, CONTEXT)).toEqual({ text: '2 reviewers reviewing · round 1 · 4 min', tone: 'signal', mark: 'dot', live: true });
  });

  it('counts the time from when the task last began running, not from a start before it paused', () => {
    // Started a day ago, asked, and answered two minutes ago: "1 day" was the wait on a person.
    const resumed = card({ active: [task({ kind: 'implement', state: 'running', startedAt: minutesAgo(24 * 60), since: minutesAgo(2), activity: 'running tests' })] });
    expect(cardStatus(resumed, CONTEXT).text).toBe('Builder · running tests · 2 min');
    // Resumed at a time nothing recorded: no time rather than a wrong one.
    const unrecorded = card({ active: [task({ kind: 'implement', state: 'running', startedAt: minutesAgo(24 * 60), since: null, activity: 'running tests' })] });
    expect(cardStatus(unrecorded, CONTEXT).text).toBe('Builder · running tests');
    // Two reviewers: since the first of them began, each from its own resume.
    const two = card({
      stage: 'review',
      prNumber: 31,
      reviewRound: 1,
      active: [
        task({ kind: 'review', state: 'running', bot: 'noraexampleco', startedAt: minutesAgo(600), since: minutesAgo(3) }),
        task({ kind: 'review', state: 'running', bot: 'irisexampleco', startedAt: minutesAgo(5), since: minutesAgo(5) }),
      ],
    });
    expect(cardStatus(two, CONTEXT).text).toBe('2 reviewers reviewing · round 1 · 5 min');
  });

  it('shows a still mark, not a live one, for work that waits: on your answer, in the queue, or paused', () => {
    const asking = card({ gateOpen: true, active: [task({ kind: 'implement', state: 'paused', startedAt: minutesAgo(9) })] });
    expect(cardStatus(asking, CONTEXT)).toEqual({ text: 'Waiting for your answer', tone: 'attention', mark: 'dot' });
    const queued = card({ active: [task({ kind: 'implement', state: 'queued' })] });
    expect(cardStatus(queued, CONTEXT)).toEqual({ text: 'Queued', tone: 'muted', mark: null });
    // Answered, and not started again yet: nothing is waiting on the person.
    const resuming = card({ active: [task({ kind: 'implement', state: 'paused' })] });
    expect(cardStatus(resuming, CONTEXT)).toEqual({ text: 'Paused', tone: 'muted', mark: null });
    // Nothing on it at all.
    expect(cardStatus(card(), CONTEXT).live).toBeUndefined();
  });

  it('says a review failed rather than that the reviewers are being waited for', () => {
    // The board said "Waiting for the reviewers" over two reviews that had failed.
    const failed = card({ stage: 'review', prNumber: 2, reviewRound: 1, reviewFailed: true });
    expect(cardStatus(failed, CONTEXT)).toEqual({ text: 'Review failed · needs you', tone: 'alarm', mark: 'dot' });

    // Whatever another reviewer is doing, the failed one waits on the person.
    const meanwhile = card({ ...failed, active: [task({ kind: 'review', state: 'running', bot: 'b' })] });
    expect(cardStatus(meanwhile, CONTEXT).text).toBe('Review failed · needs you');
    expect(cardStatus(card({ stage: 'review', prNumber: 2, reviewFailed: false }), CONTEXT).text).toBe('Waiting for the reviewers');
  });

  it('says an approved plan change waits for the work that holds its paths, not for the person', () => {
    // Needs you said the builder waited for #44; the card said "Waiting for your answer" (#100).
    const asking = card({ gateOpen: true, active: [task({ kind: 'implement', state: 'paused' })] });
    expect(cardStatus(asking, { ...CONTEXT, heldApproval: { blockedBy: [44], paths: ['a.ts'] } })).toEqual({
      text: 'Approved · waits for #44 to let go of the path',
      tone: 'muted',
      mark: null,
    });
    expect(cardStatus(asking, { ...CONTEXT, heldApproval: { blockedBy: [11, 15, 44], paths: ['a.ts', 'b.ts'] } }).text).toBe(
      'Approved · waits for #11, #15 and #44 to let go of the paths',
    );
    expect(cardStatus(asking, { ...CONTEXT, heldApproval: null }).text).toBe('Waiting for your answer');
  });

  it('reads each card’s waiting approval from Needs you, and none for a card with a question of its own', () => {
    const subject = (ref: string) => ({ repo: 'openadlc', number: Number(ref.split('#')[1]), title: null, ref, url: null, item: ref });
    const waiting = (ref: string, blockedBy: number[]) => ({
      id: `plan-change:${ref}`,
      kind: 'plan_change_waiting' as const,
      headline: '',
      subject: subject(ref),
      bot: null,
      since: NOW,
      detail: '',
      actions: [],
      heldApproval: { blockedBy, paths: ['a.ts'] },
    });
    const held = heldApprovalsOf([
      waiting('openadlc#60', [44]),
      waiting('openadlc#60', [12]),
      waiting('openadlc#61', [44]),
      { ...waiting('openadlc#61', []), id: 'gate:g', kind: 'question' as const, heldApproval: undefined },
    ]);
    expect(held.get('openadlc#60')).toEqual({ blockedBy: [12, 44], paths: ['a.ts'] });
    expect(held.has('openadlc#61')).toBe(false);
  });

  it('puts what needs the person first: a question, an OK, a review loop that gave up', () => {
    const asking = card({ gateOpen: true, active: [task({ kind: 'intake', state: 'paused' })] });
    expect(cardStatus(asking, CONTEXT)).toEqual({ text: 'Waiting for your answer', tone: 'attention', mark: 'dot' });

    const approval = card({ stage: 'merged', gateOpen: true, approval: true, active: [task({ kind: 'deploy', state: 'paused' })] });
    expect(cardStatus(approval, CONTEXT).text).toBe('Waiting for your answer');

    const stalled = card({ stage: 'review', prNumber: 29, stalledAfterRounds: 3, gateOpen: true });
    expect(cardStatus(stalled, CONTEXT)).toEqual({ text: 'Stopped after 3 rounds · needs you', tone: 'alarm', mark: 'dot' });
  });

  it('says a card whose last task failed needs the person, once nothing is on it', () => {
    const failed = card({ last: task({ kind: 'implement', state: 'failed', endedAt: minutesAgo(5) }) });
    expect(cardStatus(failed, CONTEXT)).toEqual({ text: 'Could not finish · needs you', tone: 'alarm', mark: 'dot' });
  });

  it('names the builder a card is next in line for, while it is busy', () => {
    expect(
      cardStatus(card(), { ...CONTEXT, queue: { next: true, builder: 'openadlc-atlas-janedoe', builderBusy: true } }).text,
    ).toBe('Next up, when openadlc-atlas-janedoe is free');
    expect(cardStatus(card(), { ...CONTEXT, queue: { next: true, builder: 'x', builderBusy: false } }).text).toBe('Next up');
    expect(cardStatus(card(), { ...CONTEXT, queue: { next: false, builder: 'x', builderBusy: true } }).text).toBe(
      'Waiting its turn',
    );
    expect(cardStatus(card({ labels: ['adlc:build', 'blocked'] }), CONTEXT).text).toBe('Blocked by another issue');
    // Named, when the bridge says which: a person should not have to open the issue to find out.
    expect(cardStatus(card({ labels: ['adlc:build', 'blocked'], waitingOn: ['#1'] }), CONTEXT).text).toBe('Waiting on #1');
    expect(cardStatus(card({ labels: ['adlc:build', 'blocked'], waitingOn: ['#1', '#4', '#7'] }), CONTEXT).text).toBe('Waiting on #1, #4 and #7');
    expect(cardStatus(card({ labels: ['adlc:build', 'blocked'], waitingOn: ['#1', 'owner/a#2'] }), CONTEXT).text).toBe('Waiting on #1 and owner/a#2');
  });

  it('says where an approved pull request is in the line to merge', () => {
    const approved = card({ stage: 'review', prNumber: 31 });
    const line = [
      { repo: 'openadlc', ref: 'openadlc#30', position: 1, state: 'merging', detail: null },
      { repo: 'openadlc', ref: 'openadlc#31', position: 2, state: 'waiting', detail: null },
    ];
    expect(cardStatus(approved, { ...CONTEXT, mergeLine: line }).text).toBe('Approved · 2nd in line to merge');
    expect(cardStatus(approved, { ...CONTEXT, mergeLine: line.slice(1) }).text).toBe('Approved · next to merge');
    expect(cardStatus(approved, CONTEXT).text).toBe('Waiting for the reviewers');
  });

  it('says a pull request only a person can land waits for them, not that it is merging', () => {
    const approved = card({ stage: 'review', prNumber: 30 });
    const line = [{ repo: 'openadlc', ref: 'openadlc#30', position: 1, state: 'merging', detail: 'green', heldFor: 'it changes how CI runs (Makefile)' }];
    expect(cardStatus(approved, { ...CONTEXT, mergeLine: line })).toMatchObject({ text: 'Approved · waiting for you to merge it', tone: 'attention' });
  });

  // No pull request is recorded for it, so no deploy carries it to Done: it
  // said "Merged · waiting to deploy" for good.
  it('says a card in Ship with no merge to deploy is for the person to move to Done', () => {
    expect(cardStatus(card({ stage: 'merged', labels: ['adlc:merged'], noMerge: true }), CONTEXT)).toEqual({
      text: 'No merge to deploy · move it to Done by hand',
      tone: 'attention',
      mark: 'dot',
    });
    expect(cardStatus(card({ stage: 'merged', labels: ['adlc:merged'], prNumber: 52 }), CONTEXT).text).toBe('Merged · waiting to deploy');
    // A card names no pull request linked to another item, one closing two
    // issues say, nor does an older bridge's: only the bridge's word counts.
    expect(cardStatus(card({ stage: 'merged', labels: ['adlc:merged'], prNumber: null }), CONTEXT).text).toBe('Merged · waiting to deploy');
    expect(cardStatus(card({ stage: 'merged', labels: ['adlc:merged', 'deployed:testing'], noMerge: true }), CONTEXT).text).toBe('Live on testing · waiting for production');
  });

  it('says when a finished card shipped, with a tick', () => {
    const shipped = card({ stage: 'done', shippedAt: minutesAgo(120) });
    expect(cardStatus(shipped, CONTEXT)).toEqual({ text: 'Shipped 2 hours ago', tone: 'muted', mark: 'check' });
    expect(cardStatus(card({ stage: 'done', shippedAt: minutesAgo(60 * 30) }), CONTEXT).text).toBe('Shipped yesterday');
  });

  it('says a card in Done that was closed without merging was abandoned, with no tick', () => {
    // In Done so it leaves the columns work is in; nothing of it shipped.
    const abandoned = card({ stage: 'done', labels: ['adlc:done', 'openadlc:abandoned'], shippedAt: minutesAgo(120) });
    expect(cardStatus(abandoned, CONTEXT)).toEqual({ text: 'Abandoned 2 hours ago', tone: 'muted', mark: null });
    expect(cardStatus({ ...abandoned, shippedAt: null, updatedAt: 'not a date' }, CONTEXT).text).toBe('Abandoned');
  });

  it('reads a card from a bridge that sends no work as nothing known, not as an error', () => {
    const bare: BoardCard = {
      repo: 'openadlc',
      ref: 'openadlc#3',
      title: 'Old bridge',
      stage: 'intake',
      assignees: [],
      gateOpen: false,
      url: null,
      labels: [],
      updatedAt: NOW,
    };
    expect(cardStatus(bare, CONTEXT).text).toBe('Waiting for intake');
    expect(cardCost(bare, money)).toBeNull();
    expect(cardBot(bare)).toBeNull();
  });
});

describe('what a card has cost', () => {
  it('says "so far" while work is on it, and nothing when nothing was spent', () => {
    expect(cardCost(card({ costUsd: 0.84, active: [task({ kind: 'implement', state: 'running' })] }), money)).toBe(
      '$0.84 so far',
    );
    expect(cardCost(card({ costUsd: 1.74 }), money)).toBe('$1.74');
    // Waiting on the person is not spending.
    expect(cardCost(card({ costUsd: 0.12, gateOpen: true, active: [task({ kind: 'intake', state: 'paused' })] }), money)).toBe('$0.12');
    expect(cardCost(card({ costUsd: 0 }), money)).toBeNull();
  });
});

describe('the card the builder takes next', () => {
  it('is the first routable one nothing is on, in the column’s order', () => {
    const column = {
      stage: 'build',
      cards: [
        card({ ref: 'openadlc#16', active: [task({ kind: 'implement', state: 'running' })] }),
        card({ ref: 'openadlc#18', labels: ['adlc:build', 'blocked'] }),
        card({ ref: 'openadlc#17' }),
        card({ ref: 'openadlc#19' }),
      ],
    };
    expect(nextUp(column).get('openadlc')).toBe('openadlc#17');
    expect(nextUp({ ...column, stage: 'review' }).size).toBe(0);
  });

  it('passes over a card a person holds, one for a person, and one the dispatcher ignores', () => {
    const column = {
      stage: 'build',
      cards: [
        card({ ref: 'openadlc#16', held: { by: 'janedoe', at: minutesAgo(5), why: null } }),
        card({ ref: 'openadlc#17', labels: ['adlc:build', 'start:now', 'openadlc:paused'] }),
        card({ ref: 'openadlc#18', labels: ['adlc:build', 'start:now', 'do:human'] }),
        card({ ref: 'openadlc#19', labels: ['adlc:build', 'start:now', 'openadlc:ignore'] }),
        card({ ref: 'openadlc#20' }),
      ],
    };
    expect(nextUp(column).get('openadlc')).toBe('openadlc#20');
  });

  it('is one card in each repository, on the board of all of them', () => {
    const column = {
      stage: 'build',
      cards: [card({ ref: 'openadlc#17' }), card({ ref: 'openadlc#18' }), card({ repo: 'website', ref: 'website#3' })],
    };
    expect([...nextUp(column)]).toEqual([
      ['openadlc', 'openadlc#17'],
      ['website', 'website#3'],
    ]);
  });
});

describe('the bot a card opens', () => {
  it('is whoever is on it now, else whoever last was', () => {
    expect(cardBot(card({ active: [task({ kind: 'review', state: 'running', bot: 'irisexampleco' })] }))).toBe('irisexampleco');
    expect(cardBot(card({ last: task({ kind: 'implement', state: 'done', bot: 'openadlc-atlas-janedoe' }) }))).toBe(
      'openadlc-atlas-janedoe',
    );
  });
});

describe('time and money, in words', () => {
  it('says how long, and how long ago', () => {
    expect(duration(minutesAgo(12), NOW)).toBe('12 min');
    expect(duration(minutesAgo(65), NOW)).toBe('1 h 5 min');
    expect(duration(null, NOW)).toBeNull();
    expect(ago(minutesAgo(2), NOW)).toBe('2 min ago');
    expect(ago(minutesAgo(0.2), NOW)).toBe('just now');
    expect(ago(minutesAgo(60 * 24 * 3), NOW)).toBe('3 days ago');
    expect(ago('2026-09-01T10:00:00.000Z', NOW)).toBe('on 1 Sep');
  });

  it('says money in cents, a cap in whole dollars, and a fraction of a cent as something', () => {
    expect(money(7.5099)).toBe('$7.51');
    expect(money(1500, { whole: true })).toBe('$1,500');
    expect(money(0.001)).toBe('<$0.01');
    expect(money(0)).toBe('$0.00');
    expect(ordinal(2)).toBe('2nd');
    expect(ordinal(11)).toBe('11th');
  });
});

describe('a request’s card', () => {
  const request = (extra: Partial<BoardCard>): BoardCard =>
    ({ repo: 'api', ref: 'request:aaaa1111', title: 'A request', stage: 'intake', assignees: [], gateOpen: false, url: null, labels: [], updatedAt: '2026-09-29T11:50:00.000Z', request: true, ...extra }) as BoardCard;
  const say = (card: BoardCard) => cardStatus(card, { now: '2026-09-29T12:00:00.000Z', said: (bot) => bot });

  it('says where the request is', () => {
    expect(say(request({ requestState: 'queued', queuePosition: 3 }))).toMatchObject({ text: 'Queued (#3)', tone: 'muted' });
    expect(say(request({ requestState: 'working' }))).toMatchObject({ text: 'Intake working', tone: 'signal', mark: 'dot' });
    // Its triage running: what intake is doing now, as any card says it.
    const triaging = request({ requestState: 'working', active: [task({ kind: 'intake', state: 'running', bot: 'ottoexampleco', startedAt: '2026-09-29T11:57:00.000Z', activity: 'reading the code' })] });
    expect(cardStatus(triaging, { ...CONTEXT, now: '2026-09-29T12:00:00.000Z' })).toEqual({ text: 'Intake · reading the code · 3 min', tone: 'signal', mark: 'dot', live: true });
    expect(say(request({ requestState: 'waiting', gateOpen: true }))).toMatchObject({ text: 'Waiting for you', tone: 'attention' });
    expect(say(request({ requestState: 'filed', issueNumber: 42, url: 'https://github.com/exampleco/api/issues/42' }))).toEqual({
      text: 'Filed #42',
      tone: 'muted',
      mark: 'check',
      href: 'https://github.com/exampleco/api/issues/42',
    });
  });

  it('reads as before from an older bridge, which says no state', () => {
    expect(say(request({ gateOpen: true }))).toMatchObject({ text: 'Waiting for your answer' });
  });
});

describe('a card in a repository a person paused', () => {
  const PAUSED: CardContext = { ...CONTEXT, pausedRepos: ['openadlc'] };

  it('says a request filed there waits, with a link to the issue, until the repository is resumed', () => {
    const filed = card({ ref: 'request:1a2b3c4d', stage: 'intake', request: true, requestState: 'filed', issueNumber: 31, url: 'https://github.com/exampleco/openadlc/issues/31', labels: [] });
    expect(cardStatus(filed, PAUSED)).toEqual({
      text: 'Filed #31 · waits until openadlc is resumed',
      tone: 'muted',
      mark: 'check',
      href: 'https://github.com/exampleco/openadlc/issues/31',
    });
    expect(cardStatus(filed, CONTEXT).text).toBe('Filed #31');
  });

  it('says a request for it waits in the queue until it is resumed', () => {
    const queued = card({ ref: 'request:1a2b3c4d', stage: 'intake', request: true, requestState: 'queued', queuePosition: 2, labels: [] });
    expect(cardStatus(queued, PAUSED).text).toBe('Queued · waits until openadlc is resumed');
    expect(cardStatus(queued, CONTEXT).text).toBe('Queued (#2)');
  });

  it('says an issue ready to build waits for the resume, and one elsewhere does not', () => {
    expect(cardStatus(card(), { ...PAUSED, queue: { next: true, builder: 'x', builderBusy: false } }).text).toBe('Waiting until openadlc is resumed');
    expect(cardStatus(card({ repo: 'web' }), { ...PAUSED, queue: { next: true, builder: 'x', builderBusy: false } }).text).toBe('Next up');
  });
});

describe('a card on a bridge without the dispatcher', () => {
  const OFF: CardContext = { ...CONTEXT, dispatching: false };

  it('says a card ready to build waits because nothing dispatches, not its turn or next up', () => {
    expect(cardStatus(card(), { ...OFF, queue: { next: true, builder: 'x', builderBusy: false } })).toEqual({
      text: 'Waiting: the dispatcher isn’t running',
      tone: 'attention',
      mark: null,
    });
    expect(cardStatus(card(), { ...OFF, queue: { next: false, builder: 'x', builderBusy: true } }).text).toBe('Waiting: the dispatcher isn’t running');
  });

  it('reads as before with the dispatcher on, or when the bridge does not say', () => {
    expect(cardStatus(card(), { ...CONTEXT, dispatching: true, queue: { next: true, builder: 'x', builderBusy: false } }).text).toBe('Next up');
    expect(cardStatus(card(), { ...CONTEXT, queue: { next: false, builder: 'x', builderBusy: false } }).text).toBe('Waiting its turn');
  });

  it('lets a repository’s pause win, and leaves other statuses as they were', () => {
    expect(cardStatus(card(), { ...OFF, pausedRepos: ['openadlc'] }).text).toBe('Waiting until openadlc is resumed');
    expect(cardStatus(card({ labels: ['adlc:build', 'blocked'], waitingOn: ['#1'] }), OFF).text).toBe('Waiting on #1');
    expect(cardStatus(card({ labels: ['adlc:build'] }), OFF).text).toBe('Not ready to build yet');
    expect(cardStatus(card({ labels: ['adlc:build', 'start:now', 'needs-triage'] }), OFF).text).toBe('Waiting for triage');
    const writing = card({ active: [task({ kind: 'implement', state: 'running', startedAt: minutesAgo(12) })] });
    expect(cardStatus(writing, OFF).text).toBe('Builder · writing the change · 12 min');
  });
});
