import { afterEach, describe, expect, it, vi } from 'vitest';

const CURRENT = ['FLEETADLC_HOME', 'FLEETADLC_HOSTD_DRIVER', 'FLEETADLC_LEASE_HOURS', 'NEXT_PUBLIC_FLEETADLC_TERMINAL_URL'];

describe('settings named before the rename', () => {
  const set: string[] = [];
  const kept = Object.fromEntries(CURRENT.map((name) => [name, process.env[name]]));
  afterEach(() => {
    for (const name of set.splice(0)) delete process.env[name];
    for (const [name, value] of Object.entries(kept)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    vi.resetModules();
  });

  it('reads no FLEET_* variable: only its FLEETADLC_* name counts', async () => {
    for (const [name, value] of Object.entries({ FLEET_HOME: '/srv/fleet', FLEET_HOSTD_DRIVER: 'docker', FLEET_LEASE_HOURS: '1', NEXT_PUBLIC_FLEET_TERMINAL_URL: 'wss://t.example' })) {
      process.env[name] = value;
      set.push(name);
    }
    for (const name of CURRENT) delete process.env[name];
    vi.resetModules();
    const shared = await import('./index.js');
    expect(process.env.FLEETADLC_HOME).toBeUndefined();
    expect(process.env.NEXT_PUBLIC_FLEETADLC_TERMINAL_URL).toBeUndefined();
    expect(shared.hostdDriverFromEnv()).toBe('local');
    const now = new Date('2026-10-01T00:00:00Z');
    expect(shared.leaseExpiryFrom(now).getTime() - now.getTime()).toBe(12 * 3600 * 1000);
  });
});
