import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setSecretStore, webhookSecretRef, type SecretStore } from '@fleetadlc/github';
import type { BridgeConfig } from './config.js';
import { settings } from '@fleetadlc/db';
import { effectiveConfig, moveWebhookSecretToStore, storeWebhookSecret } from './effective-config.js';

/** The settings table, as rows by key. */
const table = vi.hoisted(() => ({ rows: {} as Record<string, string> }));

vi.mock('@fleetadlc/db', () => ({
  settings: {
    allSettings: vi.fn(async () => ({ ...table.rows })),
    getSetting: vi.fn(async (key: string) => table.rows[key] ?? null),
    setSetting: vi.fn(async (key: string, value: string) => {
      if (value === '') delete table.rows[key];
      else table.rows[key] = value;
    }),
  },
}));

let secrets: Record<string, string>;

function memoryStore(): SecretStore {
  return {
    get: async (ref) => secrets[ref] ?? null,
    set: async (ref, value) => {
      secrets[ref] = value;
    },
    delete: async (ref) => {
      delete secrets[ref];
    },
    list: async () => Object.keys(secrets),
  };
}

const config = { organization: 'janedoe', gitHubClientId: '', webhookSecret: '', humans: [], publicUrl: '' } as unknown as BridgeConfig;

beforeEach(() => {
  table.rows = {};
  secrets = {};
  setSecretStore(memoryStore());
});

describe('the webhook secret the bridge checks deliveries against', () => {
  it('is the secret store’s, ahead of the environment’s', async () => {
    secrets[webhookSecretRef()] = 'zzz-from-the-store-zzz';

    const live = await effectiveConfig({ ...config, webhookSecret: 'zzz-from-the-environment-zzz' });

    expect(live.webhookSecret).toBe('zzz-from-the-store-zzz');
    expect(live.webhookSecretConfigured).toBe(true);
  });

  it('falls back to the environment, and is configured when only that has one', async () => {
    const live = await effectiveConfig({ ...config, webhookSecret: 'zzz-from-the-environment-zzz' });

    expect(live.webhookSecret).toBe('zzz-from-the-environment-zzz');
    expect(live.webhookSecretConfigured).toBe(true);
    expect((await effectiveConfig(config)).webhookSecretConfigured).toBe(false);
  });

  it('takes a secret written to the store on the next call, with no restart', async () => {
    expect((await effectiveConfig(config)).webhookSecret).toBe('');

    await storeWebhookSecret('zzz-new-zzz', 'janedoe');

    expect((await effectiveConfig(config)).webhookSecret).toBe('zzz-new-zzz');
  });

  it('is written to the store and never to the settings table, whose old copy goes', async () => {
    table.rows.webhookSecret = 'zzz-old-row-zzz';

    await storeWebhookSecret('zzz-new-zzz', 'janedoe');

    expect(secrets[webhookSecretRef()]).toBe('zzz-new-zzz');
    expect(table.rows).not.toHaveProperty('webhookSecret');
  });
});

describe('an older install’s webhook secret, when the bridge starts', () => {
  it('is moved from the settings table into the secret store', async () => {
    table.rows.webhookSecret = 'zzz-old-row-zzz';

    expect(await moveWebhookSecretToStore()).toBe('moved');

    expect(secrets[webhookSecretRef()]).toBe('zzz-old-row-zzz');
    expect(table.rows).not.toHaveProperty('webhookSecret');
    expect((await effectiveConfig(config)).webhookSecret).toBe('zzz-old-row-zzz');
  });

  it('leaves the store’s own secret as it is, and still deletes the row', async () => {
    table.rows.webhookSecret = 'zzz-old-row-zzz';
    secrets[webhookSecretRef()] = 'zzz-in-the-store-zzz';

    expect(await moveWebhookSecretToStore()).toBe('dropped');

    expect(secrets[webhookSecretRef()]).toBe('zzz-in-the-store-zzz');
    expect(table.rows).not.toHaveProperty('webhookSecret');
  });

  it('does nothing when there is no row', async () => {
    expect(await moveWebhookSecretToStore()).toBe('none');
    expect(secrets).toEqual({});
  });
});

describe('the install’s settings as they are now', () => {
  const fromEnvironment = { ...config, organization: 'exampleco', gitHubClientId: 'Iv1.fromtheenvironment', humans: ['janedoe'], automationBot: null } as unknown as BridgeConfig;

  it('falls back to the environment when the settings cannot be read, and says they were not', async () => {
    vi.mocked(settings.allSettings).mockRejectedValueOnce(new Error('connection terminated'));

    const live = await effectiveConfig(fromEnvironment);

    expect(live.settingsRead).toBe(false);
    expect(live.bridgeMergeOff).toEqual([]);
    expect(live.gitHubClientId).toBe('Iv1.fromtheenvironment');
  });

  it('says the settings were read when they were', async () => {
    table.rows.bridgeMergeOff = 'App';

    const live = await effectiveConfig(fromEnvironment);

    expect(live.settingsRead).toBe(true);
    expect(live.bridgeMergeOff).toEqual(['app']);
  });
});
