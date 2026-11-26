import { describe, expect, it } from 'vitest';
import type { CrewMember, TaskSummary } from './api';
import { crewState, type CrewState } from './crew';
import { bubbleText, BUBBLE_MAX, deskName, deskOpens, deskTask, OFFICE_STATE_WORDS, officePose, type OfficePose } from './crew-office';

const NOW = '2026-09-24T12:00:00.000Z';

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

function task(partial: Partial<TaskSummary> & Pick<TaskSummary, 'kind' | 'state'>): TaskSummary {
  return {
    subjectRef: 'o/r#16',
    issue: { repo: 'o/r', number: 16, title: 'Let the board filter by label' },
    startedAt: null,
    endedAt: null,
    round: null,
    waitingOnYou: false,
    ...partial,
  };
}

const LONG = 'Let the board filter by label, by repository, and by who is working on each item';

const working = member({ name: 'atlas', task: task({ kind: 'implement', state: 'running', issue: { repo: 'o/r', number: 16, title: LONG } }) });
const waiting = member({
  name: 'otto',
  role: 'intake',
  task: task({ kind: 'intake', state: 'running', waitingOnYou: true, subjectRef: 'o/r#15', issue: { repo: 'o/r', number: 15, title: 'Pick a threshold' } }),
});
const failed = member({
  name: 'iris',
  role: 'review_second',
  lastTask: task({ kind: 'review', state: 'failed', subjectRef: 'o/r#12', issue: { repo: 'o/r', number: 12, title: 'x' } }),
});
const blocked = member({ name: 'vera', role: 'review_lead', checks: [{ id: 'bot-sign-in', title: 'Its GitHub sign-in stopped working', severity: 'blocking' }] });
const unconnected = member({ name: 'lead-reviewer', slot: 'lead-reviewer', role: 'review_lead', githubLogin: null, authorization: 'unauthorized' });
const idle = member({ name: 'quinn', role: 'qa' });
const onDuty = member({ name: 'flow', role: 'automation', engine: 'none', model: 'none' });

describe('a desk’s pose and words', () => {
  const table: [CrewState, OfficePose, string][] = [
    ['idle', 'rest', 'idle'],
    ['on-duty', 'rest', 'on duty'],
    ['working', 'busy', 'working'],
    ['waiting', 'hand-up', 'waiting for your answer'],
    ['attention', 'stopped', 'needs attention'],
    ['not-connected', 'empty', 'not connected'],
  ];

  it.each(table)('%s is drawn %s and said as “%s”', (state, pose, words) => {
    expect(officePose(state)).toBe(pose);
    expect(OFFICE_STATE_WORDS[state]).toBe(words);
  });

  it('covers every state the crew has', () => {
    expect(Object.keys(OFFICE_STATE_WORDS).sort()).toEqual(table.map(([state]) => state).sort());
  });

  it('never words attention as a cap, since it may be a failed task or a check', () => {
    for (const words of Object.values(OFFICE_STATE_WORDS)) expect(words).not.toMatch(/cap/i);
    for (const bot of [working, waiting, failed, blocked, unconnected, idle, onDuty]) expect(deskName(bot, NOW)).not.toMatch(/\bcap\b/i);
  });

  it('reads each fixture as the state it stands for', () => {
    expect([working, waiting, failed, blocked, unconnected, idle, onDuty].map(crewState)).toEqual([
      'working',
      'waiting',
      'attention',
      'attention',
      'not-connected',
      'idle',
      'on-duty',
    ]);
  });
});

describe('the bubble', () => {
  it('keeps text that fits, at and under its limit', () => {
    expect(bubbleText('short')).toBe('short');
    const exact = 'x'.repeat(BUBBLE_MAX);
    expect(bubbleText(exact)).toBe(exact);
  });

  it('cuts text over its limit with an ellipsis', () => {
    const cut = bubbleText(LONG);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(BUBBLE_MAX + 1);
    expect(LONG.startsWith(cut.slice(0, -1))).toBe(true);
  });
});

describe('what a desk is about', () => {
  it('is the task’s title while it works or waits', () => {
    expect(deskTask(working, NOW)).toBe(`#16 ${LONG}`);
    expect(deskTask(waiting, NOW)).toBe('#15 Pick a threshold');
  });

  it('is what it said in Now for a task with no issue', () => {
    const request = member({ name: 'otto', role: 'intake', task: task({ kind: 'intake', state: 'running', subjectRef: 'request:a4b02784', issue: null }) });
    expect(deskTask(request, NOW)).toBe('Shaping a request');
  });

  it('is what failed, or the blocking checks, while it needs attention', () => {
    expect(deskTask(failed, NOW)).toBe('Could not finish #12');
    expect(deskTask(blocked, NOW)).toBe('Its GitHub sign-in stopped working');
  });

  it('is nothing at rest or when not connected', () => {
    expect(deskTask(idle, NOW)).toBeNull();
    expect(deskTask(onDuty, NOW)).toBeNull();
    expect(deskTask(unconnected, NOW)).toBeNull();
  });
});

describe('a desk’s accessible name', () => {
  it('holds the full title of a working bot’s task, uncut', () => {
    expect(deskName(working, NOW)).toBe(`atlas, Builder: working — #16 ${LONG}`);
  });

  it('says a bot is waiting, needs attention, or is not connected', () => {
    expect(deskName(waiting, NOW)).toMatch(/^otto, .+: waiting for your answer — #15 Pick a threshold$/);
    expect(deskName(failed, NOW)).toMatch(/^iris, .+: needs attention — Could not finish #12$/);
    expect(deskName(blocked, NOW)).toMatch(/^vera, .+: needs attention — Its GitHub sign-in stopped working$/);
    expect(deskName(unconnected, NOW)).toMatch(/: not connected$/);
  });
});

describe('what pressing a desk’s character opens', () => {
  it('opens the item a waiting bot asked about, on its role', () => {
    expect(deskOpens(waiting)).toEqual({ item: 'o/r#15', role: 'intake' });
  });

  it('opens the item whose task failed', () => {
    expect(deskOpens(failed)).toEqual({ item: 'o/r#12', role: 'review_second' });
  });

  it('opens the seat for a check alone, and for a waiting task about nothing', () => {
    expect(deskOpens(blocked)).toEqual({ seat: 'vera' });
    const aboutNothing = member({ name: 'otto', task: task({ kind: 'intake', state: 'running', waitingOnYou: true, subjectRef: '', issue: null }) });
    expect(deskOpens(aboutNothing)).toEqual({ seat: 'otto' });
    expect(deskOpens(idle)).toEqual({ seat: 'quinn' });
  });
});
