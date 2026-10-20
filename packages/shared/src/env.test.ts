import { afterEach, describe, expect, it, vi } from 'vitest';

const CURRENT = ['OPENADLC_HOME', 'OPENADLC_HOSTD_DRIVER', 'OPENADLC_LEASE_HOURS', 'NEXT_PUBLIC_OPENADLC_TERMINAL_URL'];

describe('settings named before the rename', () => {
  const set: string[] = [];
  const kept = Object.fromEntries(CURRENT.map((name) => [name, process.env[name]]));
  afterEach(() => {
    for (const name of set.splice(0)) delete process.env[name];
    for (const [name, value] of Object.entries(kept)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    vi.resetModules();
  });

  it('reads no FLEET_* variable: only its OPENADLC_* name counts', async () => {
    for (const [name, value] of Object.entries({ FLEET_HOME: '/srv/fleet', FLEET_HOSTD_DRIVER: 'docker', FLEET_LEASE_HOURS: '1', NEXT_PUBLIC_FLEET_TERMINAL_URL: 'wss://t.example' })) {
      process.env[name] = value;
      set.push(name);
    }
    for (const name of CURRENT) delete process.env[name];
    vi.resetModules();
    const shared = await import('./index.js');
    expect(process.env.OPENADLC_HOME).toBeUndefined();
    expect(process.env.NEXT_PUBLIC_OPENADLC_TERMINAL_URL).toBeUndefined();
    expect(shared.hostdDriverFromEnv()).toBe('local');
    const now = new Date('2026-10-01T00:00:00Z');
    expect(shared.leaseExpiryFrom(now).getTime() - now.getTime()).toBe(12 * 3600 * 1000);
  });
});

describe('FLEETADLC_* settings, adopted at start', () => {
  it('moves each to its OPENADLC_* name unless that name is set, and says which', async () => {
    const { adoptLegacyEnv, legacyEnvNote } = await import('./env.js');
    const env: NodeJS.ProcessEnv = {
      FLEETADLC_HOME: '/srv/adlc',
      NEXT_PUBLIC_FLEETADLC_TERMINAL_URL: 'wss://t.example',
      FLEETADLC_BOT_PREFIX: 'their-',
      OPENADLC_BOT_PREFIX: 'kept-',
      FLEET_HOME: '/srv/fleet',
      PATH: '/bin',
    };
    const adopted = adoptLegacyEnv(env);
    expect(env.OPENADLC_HOME).toBe('/srv/adlc');
    expect(env.NEXT_PUBLIC_OPENADLC_TERMINAL_URL).toBe('wss://t.example');
    // A set OPENADLC_* always wins over the old spelling.
    expect(env.OPENADLC_BOT_PREFIX).toBe('kept-');
    // FLEET_* stays unread, as the first rename left it.
    expect(env.OPENADLC_HOME).not.toBe('/srv/fleet');
    expect(adopted).toEqual(['FLEETADLC_HOME', 'NEXT_PUBLIC_FLEETADLC_TERMINAL_URL']);
    expect(legacyEnvNote(adopted)).toContain('FLEETADLC_HOME');
    expect(legacyEnvNote(adopted)).toContain('OPENADLC_*');
    expect(legacyEnvNote([])).toBeNull();
  });
});
