import { describe, expect, it, vi } from 'vitest';
import type { Slept } from '../../keep-awake.js';
import { SLEPT_DOC_URL, inFlightWords, sleptCheck, sleptFor } from './slept.js';

const NOW = new Date('2026-11-02T11:00:00.000Z');

const sleep = (wokeMinutesAgo: number, overrides: Partial<Slept> = {}): { at: string; payload: Slept } => {
  const wokeAt = new Date(NOW.getTime() - wokeMinutesAgo * 60_000).toISOString();
  return {
    at: wokeAt,
    payload: {
      sleptAt: new Date(Date.parse(wokeAt) - 47 * 60_000).toISOString(),
      wokeAt,
      seconds: 47 * 60,
      inFlight: { tasks: 2, merges: 1, deploys: 0 },
      keepAwake: 'holding',
      ...overrides,
    },
  };
};

/** The check over the events an hour back from `NOW` would return, as `listEventsOfType` does. */
function check(events: { at: string; payload: unknown }[], available = true) {
  const read = vi.fn(async (since: Date) => events.filter((event) => Date.parse(event.at) >= since.getTime()));
  return { read, check: sleptCheck({ events: read, available: () => available }) };
}

describe('the machine slept with work in flight', () => {
  it('passes with no sleep in the last hour, so a card clears itself', async () => {
    const { read, check: slept } = check([]);
    expect(await slept.run(NOW)).toEqual([{ ok: true }]);
    expect(read).toHaveBeenCalledWith(new Date('2026-11-02T10:00:00.000Z'));
  });

  it('is a dismissable warning for a sleep 10 minutes ago, with how long and what was in flight', async () => {
    const event = sleep(10);
    const { check: slept } = check([event]);
    expect(slept.history).toBe(true);
    const [result] = await slept.run(NOW);
    expect(result).toMatchObject({
      ok: false,
      severity: 'warning',
      title: 'This machine slept for 47 min with work in flight',
      action: { label: 'Open Settings', href: '/settings#keep-awake' },
      facts: { occurrence: event.payload.wokeAt, seconds: 2820, inFlight: { tasks: 2, merges: 1, deploys: 0 } },
    });
    const detail = result?.ok === false ? result.detail : '';
    expect(detail).toContain('2 tasks, 1 merge waiting on CI');
    expect(detail).toContain(event.payload.sleptAt);
    expect(detail).toContain(event.payload.wokeAt);
    expect(detail).toContain('a closed lid or Sleep from the Apple menu still sleeps a Mac');
  });

  it('says when keep-awake is off', async () => {
    const { check: slept } = check([sleep(10, { keepAwake: 'off' })]);
    const [result] = await slept.run(NOW);
    expect(result?.ok === false && result.detail).toContain('keep-awake is off');
  });

  it('sends a host that cannot be held awake to the docs instead of Settings', async () => {
    const { check: slept } = check([sleep(10, { keepAwake: 'unavailable' })], false);
    const [result] = await slept.run(NOW);
    expect(result).toMatchObject({ ok: false, action: { label: 'Read why', url: SLEPT_DOC_URL } });
    expect(result?.ok === false && result.detail).toContain('this host cannot be kept awake by OpenADLC');
    expect(SLEPT_DOC_URL).toMatch(/docs\/troubleshooting\.md#the-machine-slept-while-the-crew-worked$/);
  });

  it('passes once the sleep is over an hour old', async () => {
    const { check: slept } = check([sleep(61)]);
    expect(await slept.run(NOW)).toEqual([{ ok: true }]);
  });

  it('names the newest sleep, so a later one is a new occurrence to dismiss', async () => {
    const newer = sleep(5, { seconds: 600 });
    const { check: slept } = check([newer, sleep(30)]);
    const [result] = await slept.run(NOW);
    expect(result).toMatchObject({ title: 'This machine slept for 10 min with work in flight', facts: { occurrence: newer.payload.wokeAt } });
  });

  it('says durations and counts as a person reads them', () => {
    expect(sleptFor(90)).toBe('2 min');
    expect(sleptFor(45)).toBe('45 s');
    expect(sleptFor(2 * 3600 + 5 * 60)).toBe('2 h 5 min');
    expect(sleptFor(3600)).toBe('1 h');
    expect(inFlightWords({ tasks: 1, merges: 0, deploys: 2 })).toBe('1 task, 2 deploys waiting or running');
  });
});
