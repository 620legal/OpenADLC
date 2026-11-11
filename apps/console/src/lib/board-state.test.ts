import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttentionItem, BoardCard, CardTask } from './api';
import { liveLine, onViewChange, saveView, spendLine, STALE_AFTER_MS, stateColumns, stateOf, storedView, VIEW_EVENT, VIEW_KEY, type StateContext, type ViewName } from './board-state';
import type { HeldApproval } from './card-status';

const NOW = '2026-09-24T12:00:00.000Z';

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
    updatedAt: NOW,
    number: 16,
    prNumber: null,
    costUsd: 0,
    active: [],
    last: null,
    ...partial,
  };
}

function task(state: string, partial: Partial<CardTask> = {}): CardTask {
  return { bot: 'openadlc-atlas-janedoe', kind: 'implement', state, round: 0, startedAt: '2026-09-24T11:48:00.000Z', endedAt: null, exitReason: null, ...partial };
}

function item(kind: AttentionItem['kind'], subject: Partial<AttentionItem['subject']>, partial: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: `${kind}-${subject.ref ?? subject.item}`,
    kind,
    subject: { repo: 'openadlc', number: null, title: null, ref: null, url: null, ...subject },
    bot: null,
    since: NOW,
    detail: '',
    actions: [],
    ...partial,
  } as AttentionItem;
}

const context = (partial: Partial<StateContext> = {}): StateContext => ({ attention: [], heldApprovals: new Map(), now: NOW, ...partial });

/** A local time on the day `NOW` falls on, in the time zone the test runs in, as By state counts its day. */
function localToday(hours: number, minutes: number): string {
  const at = new Date(NOW);
  at.setHours(hours, minutes, 0, 0);
  return at.toISOString();
}

describe('the column a card goes in', () => {
  it('puts a card in each of the four', () => {
    const question = item('question', { ref: 'openadlc#1' });
    const on = context({ attention: [question], now: localToday(12, 0) });
    expect(stateOf(card({ ref: 'openadlc#1' }), on)).toBe('needs_you');
    expect(stateOf(card({ active: [task('running')] }), on)).toBe('working');
    expect(stateOf(card({ waiting: { since: NOW, reason: { kind: 'triage' } } as BoardCard['waiting'] }), on)).toBe('waiting');
    expect(stateOf(card({ stage: 'done', shippedAt: localToday(9, 0) }), on)).toBe('done_today');
  });

  it('takes the first that fits: a card a question waits on is Needs you though its task runs', () => {
    const both = card({ active: [task('running')] });
    expect(stateOf(both, context({ attention: [item('question', { ref: both.ref })] }))).toBe('needs_you');
    expect(stateOf({ ...both, gateOpen: true }, context())).toBe('needs_you');
  });

  it('puts a card that fits none in Waiting: queued, paused after an answer, or idle', () => {
    expect(stateOf(card({ active: [task('queued')] }), context())).toBe('waiting');
    expect(stateOf(card({ active: [task('paused')] }), context())).toBe('waiting');
    expect(stateOf(card(), context())).toBe('waiting');
    expect(stateOf(card({ stage: 'merged' }), context())).toBe('waiting');
  });

  it('is not Needs you for an approved plan change waiting on other work, alone or as the open gate', () => {
    const plan = item('plan_change_waiting', { ref: 'openadlc#16' }, { heldApproval: { blockedBy: [44], paths: ['a.ts'] } } as Partial<AttentionItem>);
    const held = new Map<string, HeldApproval>([['openadlc#16', { blockedBy: [44], paths: ['a.ts'] }]]);
    expect(stateOf(card(), context({ attention: [plan] }))).toBe('waiting');
    expect(stateOf(card({ gateOpen: true }), context({ attention: [plan], heldApprovals: held }))).toBe('waiting');
  });

  it('is not Needs you for a notice that a check was fixed, nor for a system item', () => {
    expect(stateOf(card(), context({ attention: [item('check_fixed', { ref: 'openadlc#16' })] }))).toBe('waiting');
    expect(stateOf(card(), context({ attention: [item('check_failed', { ref: 'openadlc#16' })] }))).toBe('waiting');
  });

  it('finds the card a Needs-you item names by its work item’s key or by its pull request', () => {
    const keyed = card({ item: { number: 7, key: 'OA-7' } });
    expect(stateOf(keyed, context({ attention: [item('task_failed', { item: 'OA-7' })] }))).toBe('needs_you');
    const pulled = card({ stage: 'review', prNumber: 31 });
    expect(stateOf(pulled, context({ attention: [item('merge_waiting', { ref: 'openadlc#31' })] }))).toBe('needs_you');
    // Another card's pull request is not this one's.
    expect(stateOf(card({ stage: 'review', prNumber: 32 }), context({ attention: [item('merge_waiting', { ref: 'openadlc#31' })] }))).toBe('waiting');
  });

  it('counts Done today from local midnight, and leaves out what shipped before it', () => {
    const now = localToday(12, 0);
    const yesterday = new Date(localToday(0, 0));
    yesterday.setMinutes(-1);
    expect(stateOf(card({ stage: 'done', shippedAt: localToday(0, 1) }), context({ now }))).toBe('done_today');
    expect(stateOf(card({ stage: 'done', shippedAt: yesterday.toISOString() }), context({ now }))).toBeNull();
    // Closed without merging, from its last change, as Done keeps it.
    expect(stateOf(card({ stage: 'done', shippedAt: null, updatedAt: localToday(8, 0), labels: ['openadlc:abandoned'] }), context({ now }))).toBe('done_today');
  });
});

describe('the four columns', () => {
  it('holds every card By stage draws once, in order, by the column it is drawn from, but a Done card from before today', () => {
    const now = localToday(12, 0);
    const question = card({ ref: 'openadlc#1', stage: 'spec', gateOpen: true });
    const building = card({ ref: 'openadlc#2', active: [task('running')] });
    const queued = card({ ref: 'openadlc#3', active: [task('queued')] });
    const reviewing = card({ ref: 'openadlc#4', stage: 'review', active: [task('running', { kind: 'review' })] });
    const shipped = card({ ref: 'openadlc#5', stage: 'done', shippedAt: localToday(10, 0) });
    const old = card({ ref: 'openadlc#6', stage: 'done', shippedAt: '2026-09-20T10:00:00.000Z' });
    // Moved into Ship by the person, still Build in the bridge's answer.
    const moving = card({ ref: 'openadlc#7' });
    const columns = stateColumns(
      [
        { stage: 'spec', cards: [question] },
        { stage: 'build', cards: [building, queued] },
        { stage: 'review', cards: [reviewing] },
        { stage: 'merged', cards: [moving] },
        { stage: 'done', cards: [shipped, old] },
      ],
      context({ now }),
    );
    expect(columns.map((column) => column.title)).toEqual(['Needs you', 'Working', 'Waiting', 'Done today']);
    expect(columns.map((column) => column.cards.map(({ card }) => card.ref))).toEqual([
      ['openadlc#1'],
      ['openadlc#2', 'openadlc#4'],
      ['openadlc#3', 'openadlc#7'],
      ['openadlc#5'],
    ]);
    expect(columns[2]!.cards[1]!.stage).toBe('merged');
  });

  it('says what an empty one has nothing of', () => {
    expect(stateColumns([], context()).map((column) => [column.cards.length, column.empty])).toEqual([
      [0, 'Nothing waits on you'],
      [0, 'Nothing running'],
      [0, 'Nothing waiting'],
      [0, 'Nothing shipped today'],
    ]);
  });
});

describe('a Working card’s spend', () => {
  it('is the card’s spend against the cap, the cap whole when it is', () => {
    expect(spendLine({ costUsd: 4.1 }, 15)).toBe('$4.10 of $15');
    expect(spendLine({ costUsd: 4.1 }, 7.5)).toBe('$4.10 of $7.50');
  });

  it('is the spend alone with no cap, or one of zero, and nothing with no spend', () => {
    expect(spendLine({ costUsd: 4.1 }, 0)).toBe('$4.10');
    expect(spendLine({ costUsd: 4.1 }, undefined)).toBe('$4.10');
    expect(spendLine({ costUsd: 4.1 }, Number.NaN)).toBe('$4.10');
    expect(spendLine({}, 15)).toBeNull();
  });
});

describe('the view this browser chose', () => {
  afterEach(() => vi.unstubAllGlobals());

  const storage = (values: Record<string, string>) => ({
    getItem: (key: string) => values[key] ?? null,
    setItem: (key: string, value: string) => {
      values[key] = value;
    },
  });

  it('is By stage on a first visit and for a value it does not know, and what was saved otherwise', () => {
    const values: Record<string, string> = {};
    vi.stubGlobal('localStorage', storage(values));
    expect(storedView()).toBe('stage');
    values[VIEW_KEY] = 'columns';
    expect(storedView()).toBe('stage');
    saveView('state');
    expect(values[VIEW_KEY]).toBe('state');
    expect(storedView()).toBe('state');
  });

  it('is By stage where storage throws, and saving there throws nothing', () => {
    const refusing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    };
    vi.stubGlobal('localStorage', refusing);
    expect(storedView()).toBe('stage');
    expect(() => saveView('state')).not.toThrow();
  });

  /** This page's window, as an event target the tests can dispatch on. */
  function page(): EventTarget {
    const target = new EventTarget();
    vi.stubGlobal('addEventListener', target.addEventListener.bind(target));
    vi.stubGlobal('removeEventListener', target.removeEventListener.bind(target));
    vi.stubGlobal('dispatchEvent', target.dispatchEvent.bind(target));
    return target;
  }

  /** A `storage` event as another tab's write fires it. */
  function storageEvent(key: string, newValue: string | null): Event {
    return Object.assign(new Event('storage'), { key, newValue });
  }

  it('tells the page what was saved, even where storage throws', () => {
    const target = page();
    const heard: unknown[] = [];
    target.addEventListener(VIEW_EVENT, (event) => heard.push((event as CustomEvent).detail));
    vi.stubGlobal('localStorage', storage({}));
    saveView('state');
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('SecurityError');
      },
    });
    saveView('stage');
    expect(heard).toEqual(['state', 'stage']);
  });

  it('hears a view chosen in this page and in another tab, not another key, and nothing once unsubscribed', () => {
    const target = page();
    vi.stubGlobal('localStorage', storage({}));
    const heard: ViewName[] = [];
    const stop = onViewChange((view) => heard.push(view));

    saveView('state');
    target.dispatchEvent(storageEvent(VIEW_KEY, 'stage'));
    target.dispatchEvent(storageEvent('openadlc.theme', 'state'));
    // Another tab's value it does not know, or a cleared key, is By stage as storage reads it.
    target.dispatchEvent(storageEvent(VIEW_KEY, 'columns'));
    target.dispatchEvent(storageEvent(VIEW_KEY, null));
    expect(heard).toEqual(['state', 'stage', 'stage', 'stage']);

    stop();
    saveView('state');
    target.dispatchEvent(storageEvent(VIEW_KEY, 'state'));
    expect(heard).toHaveLength(4);
  });
});

describe('the Live dot', () => {
  it('counts up while live, and turns stale once a refresh and five seconds have passed', () => {
    const at = 1_000_000;
    expect(liveLine(at, at + 4_000)).toEqual({ text: 'Live · 4s ago', stale: false });
    expect(liveLine(at, at + 19_000)).toEqual({ text: 'Live · 19s ago', stale: false });
    expect(STALE_AFTER_MS).toBe(20_000);
    expect(liveLine(at, at + 21_000)).toEqual({ text: 'Not updated · 21s ago', stale: true });
    expect(liveLine(at, at + 90_000)).toEqual({ text: 'Not updated · 1 min ago', stale: true });
  });
});
