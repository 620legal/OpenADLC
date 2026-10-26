import { describe, expect, it } from 'vitest';
import type { Board, BoardCard, CardTask, RunningTask } from './api';
import { needsFullRead, runningRefs, withActivity, type BoardActivity } from './board-activity';

const NOW = '2026-09-24T12:00:00.000Z';

function task(state: string, extra: Partial<CardTask> = {}): CardTask {
  return { bot: 'openadlc-atlas-janedoe', kind: 'implement', state, round: 0, startedAt: NOW, endedAt: null, exitReason: null, ...extra };
}

function card(ref: string, active: CardTask[]): BoardCard {
  return { repo: 'openadlc', ref, title: ref, stage: 'build', assignees: [], gateOpen: false, url: null, labels: [], updatedAt: NOW, active, last: null };
}

const BOARD: Board = {
  repo: 'all',
  repos: ['openadlc'],
  columns: [
    { stage: 'build', title: 'Build', mode: 'autonomous', bots: [], cards: [card('openadlc#16', [task('running', { activity: 'running tests' })]), card('openadlc#17', [])] },
    { stage: 'review', title: 'Review', mode: 'autonomous', bots: [], cards: [card('openadlc#12', [task('running', { kind: 'review' }), task('queued')])] },
  ],
  mergeLine: [],
  waitingOnYou: 0,
  working: 2,
  idle: 0,
  running: 2,
};

describe('the running cards of a board', () => {
  it('are the ones with a task running, whatever else is on them', () => {
    expect(runningRefs(BOARD)).toEqual(['openadlc#12', 'openadlc#16']);
  });
});

describe('a poll of the running cards', () => {
  const activity = (cards: BoardActivity['cards'], running = 2): BoardActivity => ({ running, cards });

  it('changes only the running cards’ tasks, and the count, in place', () => {
    const read = activity([
      { ref: 'openadlc#12', active: [task('running', { kind: 'review', activity: 'reading the diff' })] },
      { ref: 'openadlc#16', active: [task('running', { activity: 'committing' })] },
    ], 5);
    expect(needsFullRead(BOARD, read)).toBe(false);
    const live = withActivity(BOARD, read);
    expect(live.running).toBe(5);
    const cards = live.columns.flatMap((column) => column.cards);
    expect(cards.find((one) => one.ref === 'openadlc#16')?.active?.[0]?.activity).toBe('committing');
    // The queued fix finished starting, or went: the card has what the poll says it has now.
    expect(cards.find((one) => one.ref === 'openadlc#12')?.active).toEqual([task('running', { kind: 'review', activity: 'reading the diff' })]);
    expect(cards.find((one) => one.ref === 'openadlc#17')).toBe(BOARD.columns[0]!.cards[1]);
    expect(BOARD.columns[0]!.cards[0]!.active?.[0]?.activity).toBe('running tests');
  });

  it('asks for the whole board when a card on it started running, or one stopped', () => {
    const started = activity([
      { ref: 'openadlc#12', active: [task('running')] },
      { ref: 'openadlc#16', active: [task('running')] },
      { ref: 'openadlc#17', active: [task('running')] },
    ]);
    expect(needsFullRead(BOARD, started)).toBe(true);
    // Paused on a question, or ended: its card has to say so, from what only a full read has.
    expect(needsFullRead(BOARD, activity([{ ref: 'openadlc#16', active: [task('running')] }]))).toBe(true);
  });

  it('does not for a running card this board does not show', () => {
    const elsewhere = activity([
      { ref: 'openadlc#12', active: [task('running')] },
      { ref: 'openadlc#16', active: [task('running')] },
      { ref: 'openadlc#3', active: [task('running')] },
    ]);
    expect(needsFullRead(BOARD, elsewhere)).toBe(false);
  });

  it('lists the running tasks as the poll names them, and keeps the board’s own list from a poll that names none', () => {
    const triage: RunningTask = {
      id: 'task-1', bot: 'intake', kind: 'intake', skill: null, round: 0, subject: 'request:b4378305', repo: null,
      title: 'Open the running count', opens: 'request:b4378305', since: NOW,
    };
    const listed: Board = { ...BOARD, runningTasks: [] };
    // A triage on a request is on no card: no card's news, and no reason to read the whole board.
    const named: BoardActivity = { ...activity(BOARD.columns.flatMap((column) => column.cards).filter((one) => one.ref !== 'openadlc#17').map((one) => ({ ref: one.ref, active: one.active ?? [] })), 3), runningTasks: [triage] };
    expect(needsFullRead(listed, named)).toBe(false);
    expect(withActivity(listed, named).runningTasks).toEqual([triage]);
    // An older bridge's poll says no list: the board's own stays.
    expect(withActivity({ ...BOARD, runningTasks: [triage] }, activity([], 1)).runningTasks).toEqual([triage]);
  });
});
