import { describe, expect, it, vi } from 'vitest';
import config from '../../next.config';

/**
 * Listed under `env`, a variable is written into the build. The bridge's
 * address was, so a console built beside a live install talked to that
 * install's bridge whatever it was started with.
 */
describe('the console’s configuration', () => {
  it('leaves the bridge’s address to be read when the console starts', () => {
    expect(Object.keys(config.env ?? {})).not.toContain('FLEETADLC_BRIDGE_URL');
  });

  it('lets middleware pass a restore body as large as the bridge accepts', () => {
    // Ten megabytes by default: a backup with history reached the bridge cut short.
    expect(config.experimental?.middlewareClientMaxBodySize).toBe('96mb');
  });

  it('reads no FLEET_* variable, the names from before the rename', async () => {
    const kept = { bridge: process.env.FLEETADLC_BRIDGE_URL, terminal: process.env.NEXT_PUBLIC_FLEETADLC_TERMINAL_URL };
    delete process.env.FLEETADLC_BRIDGE_URL;
    delete process.env.NEXT_PUBLIC_FLEETADLC_TERMINAL_URL;
    process.env.FLEET_BRIDGE_URL = 'http://old.example';
    process.env.NEXT_PUBLIC_FLEET_TERMINAL_URL = 'wss://old.example';
    try {
      vi.resetModules();
      await import('../../next.config');
      expect(process.env.FLEETADLC_BRIDGE_URL).toBeUndefined();
      expect(process.env.NEXT_PUBLIC_FLEETADLC_TERMINAL_URL).toBeUndefined();
    } finally {
      delete process.env.FLEET_BRIDGE_URL;
      delete process.env.NEXT_PUBLIC_FLEET_TERMINAL_URL;
      if (kept.bridge !== undefined) process.env.FLEETADLC_BRIDGE_URL = kept.bridge;
      if (kept.terminal !== undefined) process.env.NEXT_PUBLIC_FLEETADLC_TERMINAL_URL = kept.terminal;
    }
  });
});
