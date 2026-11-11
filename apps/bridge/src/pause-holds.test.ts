import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  tasks: new Map<string, Record<string, unknown>>(),
  events: [] as { type: string; payload: Record<string, unknown> }[],
}));

vi.mock('@openadlc/db', () => ({
  tasks: {
    getTask: vi.fn(async (id: string) => store.tasks.get(id) ?? null),
    listTasks: vi.fn(async (filter: { states?: string[] }) => [...store.tasks.values()].filter((task) => !filter.states || filter.states.includes(String(task.state)))),
  },
  recordEvent: vi.fn(async (input: { type: string; payload: Record<string, unknown> }) => {
    store.events.push({ type: input.type, payload: input.payload });
    return String(store.events.length);
  }),
  listEventsOfTypeWith: vi.fn(async (type: string, fields: Record<string, unknown>) =>
    store.events
      .filter((event) => event.type === type && Object.entries(fields).every(([key, value]) => event.payload[key] === value))
      .map((event, id) => ({ id, at: '2026-11-10T22:00:00.000Z', payload: event.payload })),
  ),
}));

import { PauseHolds, REVIEW_PAUSE_HELD, REVIEW_PAUSE_HOLD_LAPSED } from './pause-holds.js';
import { PAUSED_BUILDER_HOLD_MS } from './task-service.js';

// #287: on 2026-11-10 a CI send-back's round paused to ask for a path, and
// the pause itself asked the lead to review the head the round then replaced.
const PAUSED_AT = '2026-11-10T22:05:00.000Z';
const T = Date.parse(PAUSED_AT);
const patchRound = (overrides: Record<string, unknown> = {}) => ({
  id: 'task-patch',
  kind: 'patch',
  state: 'paused',
  subjectRef: 'openadlc#31',
  branch: 'agent/builder/78-issue-78',
  pausedAt: PAUSED_AT,
  ...overrides,
});

const builderEnded = vi.fn(async (_input: unknown) => undefined);
let clock = T;

function holds() {
  return new PauseHolds({ stages: { builderEnded }, now: () => clock });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T);
  clock = T;
  store.tasks.clear();
  store.events = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

async function advance(ms: number) {
  clock += ms;
  await vi.advanceTimersByTimeAsync(ms);
}

describe('a builder round paused on a question', () => {
  it('records its hold, and asks the seats once when the window lapses with it still waiting', async () => {
    const task = patchRound();
    store.tasks.set(task.id, task);
    const pauseHolds = holds();

    await pauseHolds.paused(task);
    expect(store.events).toEqual([
      { type: REVIEW_PAUSE_HELD, payload: { task: 'task-patch', pausedAt: PAUSED_AT, until: '2026-11-10T22:20:00.000Z', subjectRef: 'openadlc#31' } },
    ]);

    await advance(PAUSED_BUILDER_HOLD_MS - 1);
    expect(builderEnded).not.toHaveBeenCalled();

    await advance(2_000);
    expect(builderEnded).toHaveBeenCalledTimes(1);
    expect(builderEnded).toHaveBeenCalledWith({ kind: 'patch', subjectRef: 'openadlc#31', branch: 'agent/builder/78-issue-78' });
    expect(store.events.at(-1)).toEqual({ type: REVIEW_PAUSE_HOLD_LAPSED, payload: { task: 'task-patch', pausedAt: PAUSED_AT, subjectRef: 'openadlc#31' } });

    await advance(PAUSED_BUILDER_HOLD_MS * 2);
    expect(builderEnded).toHaveBeenCalledTimes(1);
  });

  it('asks nothing at the lapse when it was answered and resumed: its end asks them', async () => {
    const task = patchRound();
    store.tasks.set(task.id, task);
    const pauseHolds = holds();
    await pauseHolds.paused(task);

    store.tasks.set(task.id, { ...task, state: 'running' });
    await advance(PAUSED_BUILDER_HOLD_MS + 2_000);

    expect(builderEnded).not.toHaveBeenCalled();
    expect(store.events.map((event) => event.type)).toEqual([REVIEW_PAUSE_HELD]);
  });

  it('asks nothing at the first lapse when it paused again since: the new pause has its own window', async () => {
    const task = patchRound();
    store.tasks.set(task.id, task);
    const pauseHolds = holds();
    await pauseHolds.paused(task);

    await advance(5 * 60_000);
    const again = { ...task, pausedAt: new Date(clock).toISOString() };
    store.tasks.set(task.id, again);
    await pauseHolds.paused(again);

    await advance(PAUSED_BUILDER_HOLD_MS - 5 * 60_000 + 2_000);
    expect(builderEnded).not.toHaveBeenCalled();

    await advance(5 * 60_000);
    expect(builderEnded).toHaveBeenCalledTimes(1);
  });

  it('asks nothing once the task ended and was forgotten', async () => {
    const task = patchRound({ kind: 'implement', subjectRef: 'openadlc#78' });
    store.tasks.set(task.id, task);
    const pauseHolds = holds();
    await pauseHolds.paused(task);

    pauseHolds.forget(task.id);
    await advance(PAUSED_BUILDER_HOLD_MS + 2_000);

    expect(builderEnded).not.toHaveBeenCalled();
  });

  it('holds nothing for a task that is no builder, or does not say when it paused', async () => {
    const pauseHolds = holds();
    await pauseHolds.paused(patchRound({ kind: 'review' }));
    await pauseHolds.paused(patchRound({ pausedAt: null }));

    expect(store.events).toEqual([]);
  });

  it('sets nothing off after stop', async () => {
    const task = patchRound();
    store.tasks.set(task.id, task);
    const pauseHolds = holds();
    await pauseHolds.paused(task);

    pauseHolds.stop();
    await advance(PAUSED_BUILDER_HOLD_MS + 2_000);

    expect(builderEnded).not.toHaveBeenCalled();
  });
});

describe('the holds a restart finds', () => {
  it('sets one still open for what is left of it', async () => {
    store.tasks.set('task-patch', patchRound());
    store.events.push({ type: REVIEW_PAUSE_HELD, payload: { task: 'task-patch', pausedAt: PAUSED_AT } });
    clock = T + 10 * 60_000;
    vi.setSystemTime(clock);

    expect(await holds().load()).toBe(1);
    await advance(4 * 60_000);
    expect(builderEnded).not.toHaveBeenCalled();
    await advance(60_000 + 2_000);
    expect(builderEnded).toHaveBeenCalledTimes(1);
  });

  it('lapses at once one held that ended while the bridge was down', async () => {
    store.tasks.set('task-patch', patchRound());
    store.events.push({ type: REVIEW_PAUSE_HELD, payload: { task: 'task-patch', pausedAt: PAUSED_AT } });
    clock = T + PAUSED_BUILDER_HOLD_MS + 60_000;

    expect(await holds().load()).toBe(1);
    expect(builderEnded).toHaveBeenCalledTimes(1);
    expect(store.events.at(-1)?.type).toBe(REVIEW_PAUSE_HOLD_LAPSED);
  });

  it('leaves alone one that already lapsed, and one paused before holds were recorded, whose pause asked the seats', async () => {
    store.tasks.set('task-patch', patchRound());
    store.events.push(
      { type: REVIEW_PAUSE_HELD, payload: { task: 'task-patch', pausedAt: PAUSED_AT } },
      { type: REVIEW_PAUSE_HOLD_LAPSED, payload: { task: 'task-patch', pausedAt: PAUSED_AT } },
    );
    store.tasks.set('task-old', patchRound({ id: 'task-old', subjectRef: 'openadlc#12', pausedAt: '2026-11-01T09:00:00.000Z' }));
    clock = T + PAUSED_BUILDER_HOLD_MS + 60_000;

    expect(await holds().load()).toBe(0);
    await advance(PAUSED_BUILDER_HOLD_MS * 2);
    expect(builderEnded).not.toHaveBeenCalled();
  });
});
