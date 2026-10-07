import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Passed through, so a test can fail one write the way a full disk does.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, writeSync: vi.fn(actual.writeSync) };
});

import {
  alertsSecretRef,
  appClientSecretRef,
  appPrivateKeyRef,
  consoleSecretRef,
  ensureAlertsSecret,
  ensureConsoleSecret,
  ensureInternalSecret,
  FileSecretStore,
  internalSecretRef,
  modelAccountRef,
  webhookSecretRef,
} from './secrets.js';

describe('a model account ref', () => {
  it('is one ref per account, and a uuid is a legal secret name', async () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    const ref = modelAccountRef(id);
    expect(ref).toBe(`model-account-${id}`);

    const dir = mkdtempSync(join(tmpdir(), 'fleetadlc-secrets-'));
    try {
      const store = new FileSecretStore(dir);
      await store.set(ref, 'sk-shared-by-the-crew');
      expect(await store.get(ref)).toBe('sk-shared-by-the-crew');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the secrets named after a bot', () => {
  it('are every per-bot ref, so a rename carries all of them', async () => {
    const { BOT_SECRET_REFS } = await import('./secrets.js');
    expect(BOT_SECRET_REFS.map((ref) => ref('atlas'))).toEqual([
      'github-refresh-atlas',
      'github-token-atlas',
      'ssh-signing-atlas',
      'engine-key-atlas',
    ]);
  });
});

describe('the console secret', () => {
  it('is made once, as 32 random bytes in hex, and read back after that', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fleetadlc-secrets-'));
    const store = new FileSecretStore(root);
    expect(consoleSecretRef()).toBe('console-api-secret');

    const first = await ensureConsoleSecret(store);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await ensureConsoleSecret(store)).toBe(first);
    expect(await ensureConsoleSecret(new FileSecretStore(root))).toBe(first);

    // The file compose's setup writes and the console mounts, readable by its owner only.
    const file = join(root, 'console-api-secret.secret');
    expect(readFileSync(file, 'utf8').trim()).toBe(first);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('is not the internal secret, which also opens the dispatch lease', async () => {
    const store = new FileSecretStore(mkdtempSync(join(tmpdir(), 'fleetadlc-secrets-')));
    expect(consoleSecretRef()).not.toBe(internalSecretRef());
    await ensureConsoleSecret(store);
    expect(await store.list()).toEqual(['console-api-secret']);
  });
});

describe('the alerts secret', () => {
  it('is made once, under its own ref, and is not the internal secret', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fleetadlc-secrets-'));
    const store = new FileSecretStore(root);
    expect(alertsSecretRef()).toBe('alerts-secret');
    expect(alertsSecretRef()).not.toBe(internalSecretRef());

    const internal = await ensureInternalSecret(store);
    const first = await ensureAlertsSecret(store);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(internal);
    expect(await ensureAlertsSecret(store)).toBe(first);
    expect(await ensureAlertsSecret(new FileSecretStore(root))).toBe(first);
    expect(readFileSync(join(root, 'alerts-secret.secret'), 'utf8').trim()).toBe(first);
  });
});

describe('writing a secret to a file', () => {
  it('replaces the file whole, readable by its owner only, and leaves no temporary file behind', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fleetadlc-secrets-'));
    try {
      const store = new FileSecretStore(root);
      await store.set('github-refresh-atlas', 'r1');
      await store.set('github-refresh-atlas', 'r2');

      expect(await store.get('github-refresh-atlas')).toBe('r2');
      expect(readdirSync(root)).toEqual(['github-refresh-atlas.secret']);
      expect(statSync(join(root, 'github-refresh-atlas.secret')).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the old secret whole when a write fails part way', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fleetadlc-secrets-'));
    try {
      const store = new FileSecretStore(root);
      await store.set('github-refresh-atlas', 'r1');
      // A full disk, or the process killed, mid-write.
      vi.mocked(writeSync).mockImplementationOnce(() => {
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      });

      await expect(store.set('github-refresh-atlas', 'r2')).rejects.toThrow(/ENOSPC/);

      expect(await store.get('github-refresh-atlas')).toBe('r1');
      expect(readdirSync(root)).toEqual(['github-refresh-atlas.secret']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the app’s client secret', () => {
  it('is kept in the secret store under one ref of the install’s, not a bot’s, so a rename never moves it', async () => {
    const { BOT_SECRET_REFS } = await import('./secrets.js');
    expect(appClientSecretRef()).toBe('github-app-client-secret');
    expect(BOT_SECRET_REFS.some((ref) => ref('atlas') === appClientSecretRef())).toBe(false);

    const root = mkdtempSync(join(tmpdir(), 'fleetadlc-secrets-'));
    try {
      const store = new FileSecretStore(root);
      await store.set(appClientSecretRef(), 'zzz-client-secret-zzz');
      expect(await store.get(appClientSecretRef())).toBe('zzz-client-secret-zzz');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});


describe('the webhook secret', () => {
  it('is kept in the secret store under a ref of the install’s, beside the app’s key and not a bot’s', async () => {
    const { BOT_SECRET_REFS } = await import('./secrets.js');
    expect(webhookSecretRef()).toBe('github-webhook-secret');
    expect(webhookSecretRef()).not.toBe(appPrivateKeyRef());
    expect(BOT_SECRET_REFS.some((ref) => ref('atlas') === webhookSecretRef())).toBe(false);

    const root = mkdtempSync(join(tmpdir(), 'fleetadlc-secrets-'));
    try {
      const store = new FileSecretStore(root);
      await store.set(webhookSecretRef(), 'zzz-hook-zzz');
      expect(await store.get(webhookSecretRef())).toBe('zzz-hook-zzz');
      expect(await store.list()).toEqual(['github-webhook-secret']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
