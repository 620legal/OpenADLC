import { describe, expect, it } from 'vitest';
import type { CrewMember, TaskSummary } from './api';
import {
  countWords,
  crewCounts,
  crewLine,
  crewState,
  inPipelineOrder,
  initials,
  monthLine,
  needsYouLine,
  nowLine,
  thinksWith,
} from './crew';

const NOW = '2026-09-24T12:00:00.000Z';
const minutesAgo = (minutes: number): string => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();

function member(partial: Partial<CrewMember> & Pick<CrewMember, 'name'>): CrewMember {
  return {
    slot: 'builder',
    displayName: partial.name,
    role: 'implement',
    engine: 'claude',
    model: 'newest:opus',
    status: 'stopped',
    container: `bot-${partial.name}`,
    githubLogin: partial.name,
    authorization: 'active',
    tokenExpiresAt: null,
    now: 'nothing running',
    paused: false,
    sessions: [],
    task: null,
    lastTask: null,
    ...partial,
  };
}

function summary(partial: Partial<TaskSummary> & Pick<TaskSummary, 'kind' | 'state'>): TaskSummary {
  return {
    subjectRef: 'fleetadlc#16',
    issue: { repo: 'fleetadlc', number: 16, title: 'Let the board filter by label' },
    startedAt: null,
    endedAt: null,
    round: null,
    waitingOnYou: false,
    ...partial,
  };
}

describe('what a bot is doing', () => {
  it('comes from its task, never from the status column nothing updates', () => {
    const writing = member({ name: 'fleetadlc-atlas-janedoe', status: 'stopped', task: summary({ kind: 'implement', state: 'running', startedAt: minutesAgo(12) }) });
    expect(crewState(writing)).toBe('working');
    expect(nowLine(writing, NOW)).toBe('Writing #16 · 12 min');

    const idle = member({ name: 'noraexampleco', status: 'running', slot: 'lead-reviewer', role: 'review_lead' });
    expect(crewState(idle)).toBe('idle');
  });

  it('says a bot is waiting for the person only when its question is open', () => {
    const asking = member({
      name: 'ottoexampleco',
      slot: 'intake',
      role: 'intake',
      task: summary({ kind: 'intake', state: 'paused', subjectRef: 'fleetadlc#15', issue: { repo: 'fleetadlc', number: 15, title: 'x' }, waitingOnYou: true }),
    });
    expect(crewState(asking)).toBe('waiting');
    expect(nowLine(asking, NOW)).toBe('Asked you about #15');

    const shipping = member({
      name: 'tessexampleco',
      slot: 'sre',
      role: 'deploy',
      task: summary({ kind: 'deploy', state: 'paused', subjectRef: 'fleetadlc#33', issue: { repo: 'fleetadlc', number: 14, title: 'x' }, waitingOnYou: true, approval: true }),
    });
    expect(crewState(shipping)).toBe('waiting');
    expect(nowLine(shipping, NOW)).toBe('Asked you about #14');
  });

  it('gives a review its round, and says what was done last when nothing is running', () => {
    const reviewing = member({
      name: 'irisexampleco',
      slot: 'second-reviewer',
      role: 'review_second',
      task: summary({ kind: 'review', state: 'running', subjectRef: 'fleetadlc#31', issue: { repo: 'fleetadlc', number: 12, title: 'x' }, round: 2 }),
    });
    expect(nowLine(reviewing, NOW)).toBe('Reviewing #12 · round 2');

    const reviewed = member({
      name: 'noraexampleco',
      slot: 'lead-reviewer',
      role: 'review_lead',
      lastTask: summary({ kind: 'review', state: 'done', issue: { repo: 'fleetadlc', number: 12, title: 'x' }, endedAt: minutesAgo(120) }),
    });
    expect(nowLine(reviewed, NOW)).toBe('Reviewed #12 2 hours ago');

    const failed = member({ name: 'x', lastTask: summary({ kind: 'implement', state: 'failed', endedAt: minutesAgo(3) }) });
    expect(nowLine(failed, NOW)).toBe('Could not finish #16 3 min ago');
    expect(nowLine(member({ name: 'y' }), NOW)).toBe('Nothing yet');
  });

  it('says of a bot with no account that it cannot work, and of the automation bot what it does', () => {
    const unconnected = member({ name: 'lead-reviewer', slot: 'lead-reviewer', role: 'review_lead', githubLogin: null, authorization: 'unauthorized' });
    expect(crewState(unconnected)).toBe('not-connected');
    expect(nowLine(unconnected, NOW)).toBe('Cannot work until its account is connected');

    const flow = member({ name: 'janedoe-fleetadlc-flow', slot: 'automation', role: 'automation', engine: 'none', model: 'none' });
    expect(crewState(flow)).toBe('on-duty');
    expect(nowLine(flow, NOW)).toBe('Labels issues and sets the review gate');
    expect(thinksWith(flow, [])).toBe('No model, by design');
    expect(monthLine(flow, [])).toBe('Free');
  });
});

describe('what a bot thinks with', () => {
  it('is its model in words and the account it is on', () => {
    const accounts = [{ id: 'acct-1', provider: 'anthropic', kind: 'subscription', label: 'Anthropic — Max' }];
    expect(thinksWith(member({ name: 'a', model: 'newest:opus', modelAccountId: 'acct-1' }), accounts)).toBe(
      'Newest Opus · Anthropic — Max',
    );
    expect(thinksWith(member({ name: 'b', model: 'claude-opus-5-5', modelAccountId: null }), accounts)).toBe('Claude Opus 5.5');
  });
});

describe('what a bot spent this month', () => {
  it('is its row of the ledger, and nothing when it has none', () => {
    expect(monthLine(member({ name: 'irisexampleco' }), [{ bot: 'irisexampleco', costUsd: 0.38 }])).toBe('$0.38');
    expect(monthLine(member({ name: 'other' }), [{ bot: 'irisexampleco', costUsd: 0.38 }])).toBe('$0.00');
  });
});

describe('the header’s line about the crew', () => {
  const crew = [
    member({ name: 'fleetadlc-atlas-janedoe', task: summary({ kind: 'implement', state: 'running' }) }),
    member({ name: 'irisexampleco', slot: 'second-reviewer', role: 'review_second' }),
    member({ name: 'janedoe-fleetadlc-flow', slot: 'automation', role: 'automation', engine: 'none' }),
  ];

  it('counts who is working and who is idle while anything is working', () => {
    expect(crewLine(crewCounts(crew))).toBe('1 working · 2 idle');
  });

  it('says the crew is ready when nothing is working, and how much of it when some cannot act', () => {
    const resting = crew.map((bot) => ({ ...bot, task: null }));
    expect(crewLine(crewCounts(resting))).toBe('3 ready');
    const unconnected = member({ name: 'lead-reviewer', slot: 'lead-reviewer', role: 'review_lead', githubLogin: null, authorization: 'unauthorized' });
    expect(crewLine(crewCounts([...resting, unconnected]))).toBe('3 of 4 ready');
    expect(crewLine(crewCounts([]))).toBe('No crew yet');
  });

  it('counts the bots whose GitHub sign-in was revoked or expired, or that the sign-in check fails, as needing reconnecting', () => {
    const lost = [
      member({ name: 'fleetadlc-atlas-janedoe', authorization: 'revoked' }),
      member({ name: 'irisexampleco', slot: 'second-reviewer', role: 'review_second', authorization: 'expired' }),
      member({ name: 'noraexampleco', slot: 'lead-reviewer', role: 'review_lead', checks: [{ id: 'bot-sign-in', title: 'cannot sign in', severity: 'blocking' }] }),
      member({ name: 'janedoe-fleetadlc-flow', slot: 'automation', role: 'automation', engine: 'none' }),
    ];
    expect(crewCounts(lost)).toMatchObject({ total: 4, connected: 4, needsReconnecting: 3 });
  });

  it('does not call a bot ready whose last task failed or that a check says is broken', () => {
    // The header said "9 ready" over two reviewers whose reviews had just failed.
    const nine = [
      ...Array.from({ length: 7 }, (_, index) => member({ name: `bot-${index}`, slot: `seat-${index}`, role: 'review_second' })),
      member({ name: 'noraexampleco', slot: 'lead-reviewer', role: 'review_lead', lastTask: summary({ kind: 'review', state: 'failed' }) }),
      member({ name: 'irisexampleco', slot: 'second-reviewer', role: 'review_second', checks: [{ id: 'model-account:acct-grok', title: 'Grok — SuperGrok is signed out', severity: 'blocking' }] }),
    ];
    expect(crewLine(crewCounts(nine))).toBe('7 ready · 2 need attention');
    expect(crewState(nine[7]!)).toBe('attention');

    const working = [...nine.slice(0, 6), member({ name: 'fleetadlc-atlas-janedoe', task: summary({ kind: 'implement', state: 'running' }) }), ...nine.slice(7)];
    expect(crewLine(crewCounts(working))).toBe('1 working · 6 idle · 2 need attention');
    expect(crewLine(crewCounts(nine.slice(0, 8)))).toBe('7 ready · 1 needs attention');
  });

  it('counts a bot back as ready once it did its next piece of work, and a warning as nothing to act on', () => {
    const recovered = member({ name: 'noraexampleco', lastTask: summary({ kind: 'review', state: 'done' }) });
    const warned = member({ name: 'irisexampleco', checks: [{ id: 'signing-key:b', title: 'Unverified commits', severity: 'warning' }] });
    expect(crewLine(crewCounts([recovered, warned]))).toBe('2 ready');
  });

  it('says what needs the person as a count, and says so when nothing does', () => {
    expect(needsYouLine(3)).toBe('3 need you');
    expect(needsYouLine(1)).toBe('1 needs you');
    expect(needsYouLine(0)).toBe('Nothing needs you');
    expect(countWords(9, 'bot')).toBe('Nine bots');
    expect(countWords(1, 'bot')).toBe('One bot');
  });
});

describe('a bot’s avatar', () => {
  it('takes two letters from its handle, the last two parts of a long one', () => {
    expect(initials({ name: 'ottoexampleco', slot: 'intake', role: 'intake' })).toBe('OT');
    expect(initials({ name: 'fleetadlc-atlas', slot: 'system-engineer', role: 'spec' })).toBe('FA');
    expect(initials({ name: 'fleetadlc-atlas-janedoe', slot: 'builder', role: 'implement' })).toBe('AJ');
    expect(initials({ name: 'janedoe-fleetadlc-flow', slot: 'automation', role: 'automation' })).toBe('FF');
    expect(initials({ name: 'fleetadlc-cipher-janedoe', slot: 'security-reviewer', role: 'review_security' })).toBe('CJ');
  });

  it('takes its role’s letters before an account connects, never its seat’s', () => {
    expect(initials({ name: 'lead-reviewer', slot: 'lead-reviewer', role: 'review_lead', authorization: 'unauthorized' })).toBe('LR');
    expect(initials({ name: 'sre', slot: 'sre', role: 'deploy', authorization: 'unauthorized' })).toBe('SR');
  });
});

describe('the crew in order', () => {
  it('is the order a request meets them, a second builder beside the first', () => {
    const shuffled = [
      member({ name: 'flow', role: 'automation' }),
      member({ name: 'lead', role: 'review_lead' }),
      member({ name: 'builder-a', role: 'implement' }),
      member({ name: 'intake', role: 'intake' }),
      member({ name: 'builder-b', role: 'implement' }),
    ];
    expect(inPipelineOrder(shuffled).map((bot) => bot.name)).toEqual(['intake', 'builder-a', 'builder-b', 'lead', 'flow']);
  });
});
