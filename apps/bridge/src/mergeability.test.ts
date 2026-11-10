import { describe, expect, it, vi } from 'vitest';
import {
  MERGEABILITY_DECIDED,
  MERGEABILITY_RECHECK_MS,
  MERGEABILITY_WAIT_MS,
  MERGEABILITY_WAITING,
  MergeabilityWait,
  mergeabilityOf,
  type PullNow,
} from './mergeability.js';

describe('mergeabilityOf', () => {
  it('calls a head conflicting when GitHub says it is not mergeable, or its state is dirty', () => {
    expect(mergeabilityOf({ mergeable: false, mergeableState: 'dirty' })).toBe('conflicting');
    expect(mergeabilityOf({ mergeable: false, mergeableState: null })).toBe('conflicting');
    expect(mergeabilityOf({ mergeable: null, mergeableState: 'dirty' })).toBe('conflicting');
  });

  it('calls it unknown only while GitHub has computed nothing for it', () => {
    expect(mergeabilityOf({ mergeable: null, mergeableState: 'unknown' })).toBe('unknown');
    expect(mergeabilityOf({ mergeable: null, mergeableState: null })).toBe('unknown');
    expect(mergeabilityOf({})).toBe('unknown');
  });

  it('calls every other state mergeable: blocked, behind, unstable and the rest are not conflicts', () => {
    for (const state of ['clean', 'blocked', 'behind', 'unstable', 'has_hooks']) {
      expect(mergeabilityOf({ mergeable: true, mergeableState: state })).toBe('mergeable');
    }
    expect(mergeabilityOf({ mergeable: null, mergeableState: 'blocked' })).toBe('mergeable');
  });
});

const HOLD = { repo: 'openadlc-testbed', repoFullName: 'janedoe/openadlc-testbed', pr: 7, head: 'abc1234' };

function pull(overrides: Partial<PullNow> = {}): PullNow {
  return {
    number: 7,
    state: 'open',
    draft: false,
    headRef: 'agent/builder/3-x',
    headSha: 'abc1234',
    baseRef: 'main',
    labels: [],
    mergeable: null,
    mergeableState: 'unknown',
    ...overrides,
  };
}

/** A clock and timers the test moves by hand. */
function harness(answers: (PullNow | null)[], events: { type: string; at: string; payload: unknown }[] = []) {
  let clock = Date.parse('2026-11-10T12:00:00.000Z');
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let ids = 0;
  const recorded: { type: string; payload: Record<string, unknown> }[] = [];
  const read = vi.fn(async () => (answers.length > 1 ? answers.shift()! : answers[0]!));
  const wait = new MergeabilityWait({
    read,
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = ++ids;
      timers.push({ at: clock + ms, fn, id });
      return id;
    },
    clearTimer: (id) => {
      const at = timers.findIndex((timer) => timer.id === id);
      if (at >= 0) timers.splice(at, 1);
    },
    record: async (type, payload) => {
      recorded.push({ type, payload: payload as Record<string, unknown> });
    },
    events: async (type) => events.filter((event) => event.type === type),
    log: () => undefined,
  });
  /** Moves the clock on, firing each timer due, and lets what it started settle. */
  const advance = async (ms: number) => {
    const until = clock + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const due = timers[0];
      if (!due || due.at > until) break;
      timers.shift();
      clock = due.at;
      due.fn();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    }
    clock = until;
  };
  return { wait, read, recorded, timers, advance, now: () => clock };
}

describe('MergeabilityWait', () => {
  it('decides as soon as a re-read answers, and records the wait and the answer', async () => {
    const { wait, recorded, advance, timers } = harness([pull({ mergeable: true, mergeableState: 'clean' })]);
    const decide = vi.fn(async () => undefined);

    expect(await wait.hold(HOLD, decide)).toBe(true);
    expect(decide).not.toHaveBeenCalled();
    expect(recorded.map((event) => event.type)).toEqual([MERGEABILITY_WAITING]);

    await advance(MERGEABILITY_RECHECK_MS);
    expect(decide).toHaveBeenCalledWith('mergeable', expect.objectContaining({ headSha: 'abc1234' }), expect.objectContaining({ pr: 7 }));
    expect(recorded[1]).toMatchObject({ type: MERGEABILITY_DECIDED, payload: { answer: 'mergeable', waitedMs: MERGEABILITY_RECHECK_MS, head: 'abc1234' } });
    expect(timers).toHaveLength(0);
    expect(wait.holding(HOLD)).toBe(false);
  });

  it('keeps re-reading while GitHub says nothing, and decides on a conflict once it does', async () => {
    const { wait, read, recorded, advance } = harness([pull(), pull(), pull({ mergeable: false, mergeableState: 'dirty' })]);
    const decide = vi.fn(async () => undefined);

    await wait.hold(HOLD, decide);
    await advance(MERGEABILITY_RECHECK_MS * 2);
    expect(decide).not.toHaveBeenCalled();
    await advance(MERGEABILITY_RECHECK_MS);

    expect(read).toHaveBeenCalledTimes(3);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledWith('conflicting', expect.anything(), expect.objectContaining({ pr: 7 }));
    expect(recorded.at(-1)?.payload).toMatchObject({ answer: 'conflicting' });
  });

  it('gives up after a minute, starting the reviews, and leaves no timer behind', async () => {
    const { wait, recorded, advance, timers } = harness([pull()]);
    const decide = vi.fn(async () => undefined);

    await wait.hold(HOLD, decide);
    await advance(MERGEABILITY_WAIT_MS - 1);
    expect(decide).not.toHaveBeenCalled();
    await advance(MERGEABILITY_RECHECK_MS);

    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledWith('unknown', expect.anything(), expect.objectContaining({ pr: 7 }));
    expect(recorded.at(-1)?.payload).toMatchObject({ answer: 'unknown', waitedMs: MERGEABILITY_WAIT_MS });
    expect(timers).toHaveLength(0);
  });

  it('treats a read that fails as not yet known', async () => {
    const { wait, advance } = harness([null]);
    const decide = vi.fn(async () => undefined);

    await wait.hold(HOLD, decide);
    await advance(MERGEABILITY_WAIT_MS);

    expect(decide).toHaveBeenCalledWith('unknown', null, expect.objectContaining({ pr: 7 }));
  });

  it('decides nothing for a head the pull request has moved on from, closed, or gone to draft', async () => {
    for (const now of [pull({ headSha: 'def5678' }), pull({ state: 'closed' }), pull({ draft: true })]) {
      const { wait, recorded, advance, timers } = harness([now]);
      const decide = vi.fn(async () => undefined);

      await wait.hold(HOLD, decide);
      await advance(MERGEABILITY_RECHECK_MS);

      expect(decide).not.toHaveBeenCalled();
      expect(recorded.at(-1)?.payload).toMatchObject({ answer: 'moved' });
      expect(timers).toHaveLength(0);
    }
  });

  it('holds a head once: a redelivery of the same push adds no second timer', async () => {
    const { wait, timers, advance, read } = harness([pull({ mergeable: true, mergeableState: 'clean' })]);
    const decide = vi.fn(async () => undefined);

    expect(await wait.hold(HOLD, decide)).toBe(true);
    expect(await wait.hold(HOLD, decide)).toBe(false);
    expect(timers).toHaveLength(1);
    await advance(MERGEABILITY_RECHECK_MS);

    expect(read).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('decides at once, from one read, a wait a restart cut short', async () => {
    const waiting = { type: MERGEABILITY_WAITING, at: '2026-11-10T11:59:30.000Z', payload: { ...HOLD, at: '2026-11-10T11:59:30.000Z' } };
    // An older wait on the same pull request is passed over for the newest.
    const older = { type: MERGEABILITY_WAITING, at: '2026-11-10T11:50:00.000Z', payload: { ...HOLD, head: 'old0000', at: '2026-11-10T11:50:00.000Z' } };
    // And one already decided is not decided again.
    const other = { type: MERGEABILITY_WAITING, at: '2026-11-10T11:59:00.000Z', payload: { ...HOLD, pr: 8, head: 'fff0000', at: '2026-11-10T11:59:00.000Z' } };
    const decided = { type: MERGEABILITY_DECIDED, at: '2026-11-10T11:59:10.000Z', payload: { repo: HOLD.repo, pr: 8, head: 'fff0000', answer: 'mergeable' } };
    const { wait, read, timers } = harness([pull()], [waiting, older, other, decided]);
    const decide = vi.fn(async () => undefined);

    const lines = await wait.resume(decide);

    expect(read).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledWith('unknown', expect.objectContaining({ headSha: 'abc1234' }), expect.objectContaining({ pr: 7 }));
    expect(lines).toHaveLength(1);
    expect(timers).toHaveLength(0);
  });
});
