import { afterEach, describe, expect, it } from 'vitest';
import { hostdDriverFromEnv, leaseExpiryFrom } from './env.js';

const CURRENT = ['OPENADLC_HOSTD_DRIVER', 'OPENADLC_LEASE_HOURS'];

describe('settings left unset', () => {
  const kept = Object.fromEntries(CURRENT.map((name) => [name, process.env[name]]));
  afterEach(() => {
    for (const [name, value] of Object.entries(kept)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  });

  it('run tasks under the local driver, on twelve-hour leases', () => {
    for (const name of CURRENT) delete process.env[name];
    expect(hostdDriverFromEnv()).toBe('local');
    const now = new Date('2026-10-01T00:00:00Z');
    expect(leaseExpiryFrom(now).getTime() - now.getTime()).toBe(12 * 3600 * 1000);
  });
});
