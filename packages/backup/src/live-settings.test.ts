import { describe, expect, it, vi } from 'vitest';

const allSettings = vi.hoisted(() => vi.fn());
vi.mock('@openadlc/db', async (importOriginal) => {
  const original = await importOriginal<typeof import('@openadlc/db')>();
  return { ...original, settings: { ...original.settings, allSettings } };
});

import { effectiveSettings, storedSettings } from './live.js';

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

describe('the settings a backup reads from the table', () => {
  it('include the large ones the bridge leaves out of every request, so a restore brings the logo back', async () => {
    allSettings.mockResolvedValueOnce({ consoleName: 'Acme Legal', consoleLogo: 'data:image/png;base64,iVBORw0KGgo=' });
    expect(await storedSettings()).toEqual({ consoleName: 'Acme Legal', consoleLogo: 'data:image/png;base64,iVBORw0KGgo=' });
    expect(allSettings).toHaveBeenCalledWith({ large: true });
  });
});
