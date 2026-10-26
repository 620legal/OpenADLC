import { describe, expect, it } from 'vitest';
import config from '../../next.config';

/**
 * Listed under `env`, a variable is written into the build. The bridge's
 * address was, so a console built beside a live install talked to that
 * install's bridge whatever it was started with.
 */
describe('the console’s configuration', () => {
  it('leaves the bridge’s address to be read when the console starts', () => {
    expect(Object.keys(config.env ?? {})).not.toContain('OPENADLC_BRIDGE_URL');
  });

  it('lets middleware pass a restore body as large as the bridge accepts', () => {
    // Ten megabytes by default: a backup with history reached the bridge cut short.
    expect(config.experimental?.middlewareClientMaxBodySize).toBe('96mb');
  });
});
