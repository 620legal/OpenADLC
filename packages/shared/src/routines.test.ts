import { describe, expect, it } from 'vitest';
import { describeCadence, nextRunAt, ROUTINE_TEMPLATES, validateRoutine, type RoutineCadence } from './routines.js';

const at = (iso: string) => new Date(iso);
const next = (from: string, cadence: RoutineCadence, time: string, zone: string) => nextRunAt(at(from), cadence, time, zone).toISOString();

describe('when a routine next falls due', () => {
  it('is read on the wall clock of its zone, the day after a spring change included', () => {
    expect(next('2026-03-28T10:00:00Z', { every: 'day' }, '09:00', 'Europe/Berlin')).toBe('2026-03-29T07:00:00.000Z');
    expect(next('2026-03-27T06:00:00Z', { every: 'day' }, '09:00', 'Europe/Berlin')).toBe('2026-03-27T08:00:00.000Z');
  });

  it('fires a time the spring change skips the gap’s length later, at 03:30 CEST for 02:30', () => {
    expect(next('2026-03-29T00:00:00Z', { every: 'day' }, '02:30', 'Europe/Berlin')).toBe('2026-03-29T01:30:00.000Z');
  });

  it('fires a time the autumn change repeats once, at its first occurrence', () => {
    const first = next('2026-11-01T00:00:00Z', { every: 'day' }, '01:30', 'America/New_York');
    expect(first).toBe('2026-11-01T05:30:00.000Z');
    // From the minute after it fired, the repeated 01:30 EST is not a slot.
    expect(next('2026-11-01T05:31:00Z', { every: 'day' }, '01:30', 'America/New_York')).toBe('2026-11-02T06:30:00.000Z');
  });

  it('falls on the last day of a month that lacks the day, February in a leap year included', () => {
    expect(next('2027-02-01T00:00:00Z', { every: 'month', day: 31 }, '09:00', 'UTC')).toBe('2027-02-28T09:00:00.000Z');
    expect(next('2028-02-01T00:00:00Z', { every: 'month', day: 31 }, '09:00', 'UTC')).toBe('2028-02-29T09:00:00.000Z');
    expect(next('2027-03-01T00:00:00Z', { every: 'month', day: 31 }, '09:00', 'UTC')).toBe('2027-03-31T09:00:00.000Z');
    expect(next('2027-04-15T00:00:00Z', { every: 'month', day: 30 }, '09:00', 'UTC')).toBe('2027-04-30T09:00:00.000Z');
    // Past this month's slot: next month's.
    expect(next('2027-01-31T10:00:00Z', { every: 'month', day: 31 }, '09:00', 'UTC')).toBe('2027-02-28T09:00:00.000Z');
  });

  it('is the next Monday from a Monday after the time, and today’s slot before it', () => {
    // 2026-11-30 is a Monday.
    expect(next('2026-11-30T10:00:00Z', { every: 'week', weekday: 1 }, '09:00', 'UTC')).toBe('2026-12-07T09:00:00.000Z');
    expect(next('2026-11-30T08:00:00Z', { every: 'week', weekday: 1 }, '09:00', 'UTC')).toBe('2026-11-30T09:00:00.000Z');
    expect(next('2026-11-26T08:00:00Z', { every: 'week', weekday: 7 }, '09:00', 'UTC')).toBe('2026-11-29T09:00:00.000Z');
  });

  it('counts the slot of the current minute as due, seconds aside', () => {
    expect(next('2026-11-26T09:00:42Z', { every: 'day' }, '09:00', 'UTC')).toBe('2026-11-26T09:00:00.000Z');
    expect(next('2026-11-26T09:01:00Z', { every: 'day' }, '09:00', 'UTC')).toBe('2026-11-27T09:00:00.000Z');
  });

  it('reads the date in the zone, not in UTC', () => {
    // 23:30 UTC on the 26th is 08:30 on the 27th in Tokyo: 09:00 there is half an hour away.
    expect(next('2026-11-26T23:30:00Z', { every: 'day' }, '09:00', 'Asia/Tokyo')).toBe('2026-11-27T00:00:00.000Z');
    // And just after it, the 28th's.
    expect(next('2026-11-27T00:01:00Z', { every: 'day' }, '09:00', 'Asia/Tokyo')).toBe('2026-11-28T00:00:00.000Z');
  });
});

describe('what a routine may say', () => {
  const good = { repo: 'app', text: 'Review the dependencies', details: '', kind: 'chore', cadence: { every: 'week', weekday: 1 }, time: '09:00', timeZone: 'Europe/Paris' };
  const refused = (patch: Record<string, unknown>) => {
    const result = validateRoutine({ ...good, ...patch }, ['app', 'api']);
    if (result.ok) throw new Error('expected a refusal');
    return result;
  };

  it('is cleaned and kept when it is whole', () => {
    expect(validateRoutine({ ...good, repo: 'APP', text: '  Review the dependencies \n' }, ['app'])).toEqual({
      ok: true,
      routine: { repo: 'app', text: 'Review the dependencies', details: null, kind: 'chore', cadence: { every: 'week', weekday: 1 }, time: '09:00', timeZone: 'Europe/Paris' },
    });
  });

  it('refuses a repository the install does not manage, saying where to add one', () => {
    expect(refused({ repo: 'acme/x' })).toMatchObject({ field: 'repo', error: expect.stringContaining('acme/x is not managed by this install') });
    expect(refused({ repo: '' })).toMatchObject({ field: 'repo' });
  });

  it('refuses empty request text', () => {
    expect(refused({ text: '   ' })).toMatchObject({ field: 'text', error: expect.stringContaining('request text is empty') });
  });

  it('refuses a zone that is not IANA, or an offset', () => {
    expect(refused({ timeZone: 'Europe/Pariss' })).toMatchObject({ field: 'timeZone', error: expect.stringContaining('"Europe/Pariss" is not an IANA zone') });
    expect(refused({ timeZone: 'Mars/Base' })).toMatchObject({ field: 'timeZone' });
    expect(refused({ timeZone: '+05:00' })).toMatchObject({ field: 'timeZone' });
  });

  it('refuses a cadence it cannot keep', () => {
    expect(refused({ cadence: { every: 'month', day: 0 } })).toMatchObject({ field: 'cadence', error: expect.stringContaining('from 1 to 31') });
    expect(refused({ cadence: { every: 'month', day: 32 } })).toMatchObject({ field: 'cadence' });
    expect(refused({ cadence: { every: 'week' } })).toMatchObject({ field: 'cadence', error: expect.stringContaining('Monday to Sunday') });
    expect(refused({ cadence: { every: 'hour' } })).toMatchObject({ field: 'cadence' });
    expect(refused({ cadence: undefined })).toMatchObject({ field: 'cadence' });
  });

  it('refuses a time or a kind it does not know', () => {
    expect(refused({ time: '24:00' })).toMatchObject({ field: 'time' });
    expect(refused({ time: '9:00' })).toMatchObject({ field: 'time' });
    expect(refused({ kind: 'epic' })).toMatchObject({ field: 'kind' });
  });
});

describe('the templates', () => {
  it('are the three the requester asked for and Blank, without a Discover run', () => {
    expect(ROUTINE_TEMPLATES.map((template) => template.id)).toEqual(['dependency-review', 'docs-drift', 'project-health', 'blank']);
  });

  it('fill a whole routine, each valid as it stands but Blank, which has no text', () => {
    for (const template of ROUTINE_TEMPLATES) {
      const result = validateRoutine({ ...template, repo: 'app', timeZone: 'UTC' }, ['app']);
      expect(result.ok).toBe(template.id !== 'blank');
    }
    expect(ROUTINE_TEMPLATES.find((template) => template.id === 'dependency-review')).toMatchObject({ cadence: { every: 'week', weekday: 1 }, time: '09:00', kind: 'chore' });
    expect(ROUTINE_TEMPLATES.find((template) => template.id === 'docs-drift')).toMatchObject({ cadence: { every: 'day' }, time: '02:00' });
    expect(ROUTINE_TEMPLATES.find((template) => template.id === 'project-health')).toMatchObject({ cadence: { every: 'week', weekday: 1 }, time: '08:00' });
  });
});

describe('a cadence in words', () => {
  it('names the day, the time and the zone', () => {
    expect(describeCadence({ every: 'week', weekday: 1 }, '09:00', 'Europe/Berlin')).toBe('Every Monday at 09:00 (Europe/Berlin)');
    expect(describeCadence({ every: 'day' }, '02:00', 'UTC')).toBe('Every day at 02:00 (UTC)');
    expect(describeCadence({ every: 'month', day: 31 }, '09:00', 'UTC')).toBe('Monthly on day 31 at 09:00 (UTC)');
  });
});
