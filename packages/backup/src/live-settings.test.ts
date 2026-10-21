import { describe, expect, it } from 'vitest';
import { effectiveSettings } from './live.js';

/**
 * The settings a backup takes, the environment's among them: a restored
 * install does not depend on the old one's install.json.
 */
describe('the webhook’s address a backup takes from the environment', () => {
  const PERSONS = 'https://persons-own-1.trycloudflare.com';

  it('is one a person gave, and goes with that, as the bridge reads it', () => {
    // Taken alone, it was stored on the new install with no mode, read as a
    // tunnel the bridge raised, and replaced at its first start.
    expect(effectiveSettings({}, { OPENADLC_PUBLIC_URL: PERSONS })).toEqual({ publicUrl: PERSONS, webhookMode: 'address' });
  });

  it('leaves a stored address with the mode stored beside it, or none', () => {
    const stored = { publicUrl: 'https://calm-badger-42.trycloudflare.com' };
    expect(effectiveSettings(stored, { OPENADLC_PUBLIC_URL: PERSONS })).toEqual(stored);
    expect(effectiveSettings({ ...stored, webhookMode: 'tunnel' }, { OPENADLC_PUBLIC_URL: PERSONS })).toEqual({ ...stored, webhookMode: 'tunnel' });
  });
});
