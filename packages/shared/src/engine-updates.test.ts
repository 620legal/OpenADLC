import { describe, expect, it } from 'vitest';
import { DEFAULT_MIN_RELEASE_AGE_DAYS, isMinReleaseAgeDays, minReleaseAgeDaysFrom } from './engine-updates.js';

describe('how long an engine CLI release must have been out', () => {
  it('is three days unless the install says otherwise', () => {
    expect(DEFAULT_MIN_RELEASE_AGE_DAYS).toBe(3);
    expect(minReleaseAgeDaysFrom(undefined)).toBe(3);
    expect(minReleaseAgeDaysFrom(null)).toBe(3);
    expect(minReleaseAgeDaysFrom('')).toBe(3);
  });

  it('is a whole number of days from 0 to 90', () => {
    for (const days of [0, 1, 3, 90]) expect(isMinReleaseAgeDays(days)).toBe(true);
    for (const days of [-1, 91, 2.5, Number.NaN, '3', null, undefined]) expect(isMinReleaseAgeDays(days)).toBe(false);
  });

  it('reads a stored value, and the default for one that is not a valid age', () => {
    expect(minReleaseAgeDaysFrom('0')).toBe(0);
    expect(minReleaseAgeDaysFrom('14')).toBe(14);
    expect(minReleaseAgeDaysFrom(7)).toBe(7);
    expect(minReleaseAgeDaysFrom('91')).toBe(3);
    expect(minReleaseAgeDaysFrom('soon')).toBe(3);
    expect(minReleaseAgeDaysFrom(1.5)).toBe(3);
  });
});
