import { describe, expect, it } from 'vitest';
import type { BoardCard, CardTask, CardWaiting, WaitingReason } from './api';
import { cardBot, cardCost, cardStatus, heldApprovalsOf, nextUp, type CardContext } from './card-status';
import { ago, duration, money, ordinal, untilIn } from './when';

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

  // Its repository ships by release: no deploy is coming, and "waiting to
  // deploy" said one was.
  it('says a card in Ship where a release ships it waits for the next release', () => {
    expect(cardStatus(card({ stage: 'merged', labels: ['adlc:merged'], prNumber: 52, shipsByRelease: true }), CONTEXT)).toEqual({
      text: 'Merged · ships with the next release',
      tone: 'muted',
      mark: null,
    });
    // Nor waiting for production: nothing is promoted where a release ships it.
    expect(cardStatus(card({ stage: 'merged', labels: ['adlc:merged', 'deployed:testing'], shipsByRelease: true }), CONTEXT).text).toBe('Merged · ships with the next release');
  });

  // Its repository's rules name no production deploy: a green smoke on
  // testing takes it to Done, and "waiting for production" said one was coming.
  it('says a card live on testing where testing is as far as it goes waits for its smoke there', () => {
    expect(cardStatus(card({ stage: 'merged', labels: ['adlc:merged', 'deployed:testing'], prNumber: 13, shipsOnTesting: true }), CONTEXT)).toEqual({
      text: 'Live on testing · waiting for its smoke',
      tone: 'muted',
      mark: null,
    });
    // Before its deploy, it waits for the deploy to testing as any merge does.
    expect(cardStatus(card({ stage: 'merged', labels: ['adlc:merged'], prNumber: 13, shipsOnTesting: true }), CONTEXT).text).toBe('Merged · waiting to deploy');
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

  it('names each issue by its repository when it was filed in several, and links the first', () => {
    const filed = request({
      requestState: 'filed',
      issueNumber: 12,
      url: 'https://github.com/exampleco/api/issues/12',
      issues: [
        { repo: 'api', number: 12, url: 'https://github.com/exampleco/api/issues/12' },
        { repo: 'web', number: 4, url: 'https://github.com/exampleco/web/issues/4' },
      ],
    });
    expect(say(filed)).toEqual({ text: 'Filed as api#12, web#4', tone: 'muted', mark: 'check', href: 'https://github.com/exampleco/api/issues/12' });
  });

  it('says one issue as it always did', () => {
    const filed = request({ requestState: 'filed', issueNumber: 42, url: 'https://github.com/exampleco/api/issues/42', issues: [{ repo: 'api', number: 42, url: 'https://github.com/exampleco/api/issues/42' }] });
    expect(say(filed)).toMatchObject({ text: 'Filed #42' });
  });

  it('names one issue by its repository when it is not the card’s, as for “use web instead of api”', () => {
    const filed = request({ requestState: 'filed', issueNumber: 4, url: 'https://github.com/exampleco/web/issues/4', issues: [{ repo: 'web', number: 4, url: 'https://github.com/exampleco/web/issues/4' }] });
    expect(say(filed)).toEqual({ text: 'Filed web#4', tone: 'muted', mark: 'check', href: 'https://github.com/exampleco/web/issues/4' });
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

/**
 * A card with nothing going on it says why it waits, on what, and for how
 * long, from what the bridge worked out (#144). #141 said "Waiting for a
 * design pass" for half an hour, and nothing said what it waited on.
 */
describe('a card waiting with nothing going on it', () => {
  const DESIGNER = { name: 'system-engineer', role: 'spec', maxTasks: 1 };
  const BUILDER = { name: 'openadlc-atlas-janedoe', role: 'implement', maxTasks: 1 };
  const inAWhile = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();
  const waits = (reason: WaitingReason, extra: Partial<CardWaiting> = {}, on: Partial<BoardCard> = {}) =>
    cardStatus(card({ stage: 'spec', labels: ['adlc:spec'], waiting: { reason, since: minutesAgo(32), stuck: false, ...extra }, ...on }), CONTEXT);

  it('names the busy seat and what is on it', () => {
    expect(waits({ kind: 'seat', seat: DESIGNER, seats: 1, holders: [{ ref: 'openadlc#137', number: 137, kind: 'spec', state: 'running', waitingOnYou: false }] })).toEqual({
      text: 'Waiting for system-engineer · busy with #137 · 32 min',
      tone: 'muted',
      mark: null,
    });
    const holders = [
      { ref: 'openadlc#12', number: 12, kind: 'implement', state: 'running', waitingOnYou: false },
      { ref: 'openadlc#14', number: 14, kind: 'implement', state: 'running', waitingOnYou: false },
      { ref: 'request:abcd1234', number: null, kind: 'intake', state: 'running', waitingOnYou: false },
      { ref: 'openadlc#15', number: 15, kind: 'implement', state: 'queued', waitingOnYou: false },
    ];
    expect(waits({ kind: 'seat', seat: BUILDER, seats: 2, holders }).text).toBe('Waiting for openadlc-atlas-janedoe and 1 more · busy with #12, #14 and 2 more · 32 min');
  });

  it('says what starts it when its seat is free: the sweep, and when, or the seat’s room, or the dispatcher', () => {
    expect(untilIn(inAWhile(24), NOW)).toBe('in 24 min');
    expect(waits({ kind: 'free', seat: DESIGNER, by: 'sweep', nextAt: inAWhile(24) }).text).toBe('Not started · system-engineer is free · next sweep in 24 min · 32 min');
    expect(waits({ kind: 'free', seat: DESIGNER, by: 'sweep', nextAt: null }).text).toBe('Not started · system-engineer is free · no sweep is scheduled · 32 min');
    expect(waits({ kind: 'free', seat: DESIGNER, by: 'runner' }, { since: minutesAgo(2) }).text).toBe('Not started · system-engineer is free · starts within a minute · 2 min');
    expect(waits({ kind: 'free', seat: BUILDER, by: 'dispatcher' }, {}, { stage: 'build' }).text).toBe('Next up · openadlc-atlas-janedoe is free · 32 min');
  });

  it('looks stuck once it has waited past the limit with its seat free', () => {
    expect(waits({ kind: 'free', seat: DESIGNER, by: 'sweep', nextAt: inAWhile(24) }, { since: minutesAgo(41), stuck: true })).toEqual({
      text: 'Stuck · system-engineer is free and nothing started it · next sweep in 24 min · 41 min',
      tone: 'alarm',
      mark: 'dot',
      stuck: true,
    });
    // What needs the person still comes first, and an older bridge's card says its stage's line.
    const free: CardWaiting = { reason: { kind: 'free', seat: DESIGNER, by: 'sweep', nextAt: null }, since: minutesAgo(32), stuck: true };
    expect(cardStatus(card({ stage: 'spec', waiting: free, last: task({ kind: 'spec', state: 'failed' }) }), CONTEXT).text).toBe('Could not finish · needs you');
    expect(cardStatus(card({ stage: 'spec', waiting: free, gateOpen: true }), CONTEXT).text).toBe('Waiting for your answer');
    expect(cardStatus(card({ stage: 'spec' }), CONTEXT).text).toBe('Waiting for a design pass');
    expect(cardStatus(card({ stage: 'spec', waiting: null }), CONTEXT).text).toBe('Waiting for a design pass');
  });

  it('says what the issue it depends on is doing now', () => {
    const on = (extra: Record<string, unknown>) => ({ number: 141, stage: 'spec', abandoned: false, task: null, waits: null, ...extra });
    const build = { stage: 'build', labels: ['adlc:build', 'blocked'] };
    expect(waits({ kind: 'dependency', on: [on({ task: { bot: 'system-engineer', kind: 'spec', state: 'running', waitingOnYou: false, activity: null } })] }, {}, build).text).toBe(
      'Waiting on #141 (system-engineer writing the design) · 32 min',
    );
    expect(waits({ kind: 'dependency', on: [on({ task: { bot: 'openadlc-atlas-janedoe', kind: 'implement', state: 'running', waitingOnYou: false, activity: 'running tests' } })] }, {}, build).text).toBe(
      'Waiting on #141 (builder running tests) · 32 min',
    );
    expect(waits({ kind: 'dependency', on: [on({ waits: { kind: 'seat', seat: 'system-engineer' } })] }, {}, build).text).toBe('Waiting on #141 (waiting for system-engineer) · 32 min');
    expect(waits({ kind: 'dependency', on: [on({ task: { bot: 'system-engineer', kind: 'spec', state: 'paused', waitingOnYou: true, activity: null } }), on({ number: 150, stage: 'review' })] }, {}, build).text).toBe(
      'Waiting on #141 (waiting for your answer) and #150 (in review) · 32 min',
    );
    expect(waits({ kind: 'dependency', on: [on({ stage: 'done', abandoned: true }), on({ number: 404, stage: null })] }, {}, build).text).toBe(
      'Waiting on #141 (closed without merging) and #404 (not on the board) · 32 min',
    );
    expect(waits({ kind: 'dependency', on: [] }, {}, build).text).toBe('Blocked by another issue · 32 min');
  });

  it('names a dependency in another repository as the bridge wrote it', () => {
    const build = { stage: 'build', labels: ['adlc:build', 'blocked'] };
    const on = (extra: Record<string, unknown>) => ({ number: 2, stage: 'build', abandoned: false, task: null, waits: null, ...extra });
    expect(waits({ kind: 'dependency', on: [on({ ref: '#1', number: 1 }), on({ ref: 'owner/a#2', stage: null })] }, {}, build).text).toBe(
      'Waiting on #1 and owner/a#2 (not on the board) · 32 min',
    );
  });

  it('says each other thing it waits on, and for how long', () => {
    const lines: [WaitingReason, string, string?][] = [
      [{ kind: 'turn', seat: DESIGNER, after: ['openadlc#141', 'web#3'] }, 'Waiting its turn, after #141 and web#3 · 32 min'],
      [{ kind: 'lease', on: [44], paths: ['apps/bridge/src/api.ts', 'README.md'] }, 'Waiting for #44 to let go of apps/bridge/src/api.ts and 1 more · 32 min'],
      [{ kind: 'concurrency', limit: 1, holders: [{ ref: 'openadlc#40', number: 40, kind: 'implement', state: 'paused', waitingOnYou: true }] }, 'Waiting: openadlc builds 1 at a time · busy with #40 (waiting for your answer) · 32 min'],
      [{ kind: 'paused', words: 'work is paused by janedoe' }, 'Waiting until work is resumed · 32 min'],
      [{ kind: 'seat_paused', seat: DESIGNER, words: 'system-engineer is paused by janedoe' }, 'Waiting for system-engineer · paused on Crew · 32 min'],
      [{ kind: 'blocked', seat: DESIGNER, why: 'system-engineer cannot sign in to GitHub', instruction: 'Reconnect it.' }, 'Waiting: system-engineer cannot sign in to GitHub · 32 min', 'attention'],
      [{ kind: 'cap', words: "this month's spend is $500.00 of the $500.00 monthly cap" }, 'Held at the spending cap · 32 min', 'attention'],
      [{ kind: 'held' }, 'On hold · 32 min'],
      [{ kind: 'no_seat', role: 'spec' }, 'Nobody staffs Design · add a seat on Crew · 32 min', 'attention'],
      [{ kind: 'not_staffed' }, 'Design is left to a person in openadlc · move it on by hand · 32 min'],
      [{ kind: 'triage' }, 'Waiting for triage · 32 min'],
      [{ kind: 'not_ready' }, 'Not ready to build yet · 32 min'],
      [{ kind: 'for_person' }, 'Left for a person · 32 min'],
      [{ kind: 'no_dispatcher' }, 'Waiting: the dispatcher isn’t running · 32 min', 'attention'],
    ];
    for (const [reason, text, tone] of lines) expect(waits(reason), reason.kind).toMatchObject({ text, tone: tone ?? 'muted' });
    // A repository a person paused on its own is named.
    expect(cardStatus(card({ stage: 'spec', waiting: { reason: { kind: 'paused', words: 'x' }, since: minutesAgo(32), stuck: false } }), { ...CONTEXT, pausedRepos: ['openadlc'] }).text).toBe(
      'Waiting until openadlc is resumed · 32 min',
    );
  });

  // A Build card its own lease holds, with nothing running, read as "Next up"
  // and then "Stuck", though the dispatcher never leases an issue a lease
  // holds; and one only the hosts held back read the same (#153).
  it('says what its own lease waits for, and that the hosts are full, never as stuck', () => {
    const build = { stage: 'build', labels: ['adlc:build', 'start:now'] };
    const leased = (state: string, pr: number | null = null, merged = false): WaitingReason => ({ kind: 'leased', bot: 'openadlc-atlas-janedoe', state, pr, merged });
    const lines: [WaitingReason, string][] = [
      [leased('leased'), 'Leased to openadlc-atlas-janedoe · its build hasn’t started · 32 min'],
      [leased('paused'), 'Leased to openadlc-atlas-janedoe · paused after its task ended · 32 min'],
      [leased('in_task', 57), 'Leased to openadlc-atlas-janedoe · held for pull request #57 · 32 min'],
      [leased('in_task', 57, true), 'Leased to openadlc-atlas-janedoe · held by merged #57 until its verification ends · 32 min'],
      [leased('in_task'), 'Leased to openadlc-atlas-janedoe · its build ended, waiting for its pull request · 32 min'],
      [{ kind: 'host', running: 4, capacity: 4 }, 'Waiting for a host with room (4 of 4 running) · 32 min'],
    ];
    for (const [reason, text] of lines) expect(waits(reason, {}, build), text).toEqual({ text, tone: 'muted', mark: null });
  });

  it('says on a build paused on a question that it holds its repository’s build while others wait for one', () => {
    const asking = task({ kind: 'implement', state: 'paused', holds: { repo: 'openadlc', limit: 1, waiting: 2 } });
    expect(cardStatus(card({ gateOpen: true, active: [asking] }), CONTEXT).text).toBe('Waiting for your answer · holds openadlc’s build slot (2 waiting)');
    expect(cardStatus(card({ gateOpen: true, active: [{ ...asking, holds: { repo: 'openadlc', limit: 3, waiting: 1 } }] }), CONTEXT).text).toBe(
      'Waiting for your answer · holds one of openadlc’s 3 build slots',
    );
    expect(cardStatus(card({ gateOpen: true, active: [{ ...asking, holds: null }] }), CONTEXT).text).toBe('Waiting for your answer');
  });
});
