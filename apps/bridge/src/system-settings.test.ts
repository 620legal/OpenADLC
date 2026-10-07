import { describe, expect, it } from 'vitest';
import { isIanaTimeZone, timeZoneFrom } from './system-settings.js';

describe('the system timezone', () => {
  it('accepts an IANA name and refuses what Intl will not format in', () => {
    expect(isIanaTimeZone('UTC')).toBe(true);
    expect(isIanaTimeZone('Asia/Jerusalem')).toBe(true);
    expect(isIanaTimeZone('Europe/Warsaw')).toBe(true);
    expect(isIanaTimeZone('Not/AZone')).toBe(false);
    expect(isIanaTimeZone('')).toBe(false);
    expect(isIanaTimeZone(' UTC')).toBe(false);
  });

  it('uses a stored zone, and the fallback when nothing usable is stored', () => {
    expect(timeZoneFrom('Europe/Warsaw', 'UTC')).toBe('Europe/Warsaw');
    expect(timeZoneFrom(null, 'Asia/Jerusalem')).toBe('Asia/Jerusalem');
    expect(timeZoneFrom('Not/AZone', 'UTC')).toBe('UTC');
    expect(timeZoneFrom('', 'UTC')).toBe('UTC');
  });
});
