import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SecretStore } from '@fleetadlc/github';
import { buildBackup, classifySecret } from './contents.js';
import { EVERYTHING } from './selection.js';
import { VALUES, sourceInstall } from './test-fixtures.js';
import { UNDO_KEY_REF, fileUndoStore } from './undo-store.js';
import type { RestoreJournal } from './undo.js';

/** Where the backup an undo puts back is kept, and how it goes when the undo does. */

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function memoryStore(): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (ref) => data.get(ref) ?? null,
    set: async (ref, value) => void data.set(ref, value),
    delete: async (ref) => void data.delete(ref),
    list: async () => [...data.keys()],
  };
}

const JOURNAL: RestoreJournal = {
  id: 'r1',
  restoredAt: '2026-09-25T10:00:00.000Z',
  until: '2026-09-26T10:00:00.000Z',
  actor: 'alex@example.test',
  backupMadeAt: '2026-09-24T12:00:00.000Z',
  settings: ['engineUpdates'],
  install: [],
  seats: [],
  repositories: [],
  accounts: [],
  accountCredentials: [],
  history: null,
};

describe('the backup an undo puts back', () => {
  it('is sealed with a key of its own, readable by this install alone, and opens again', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'fleetadlc-undo-')), 'restore-undo');
    made.push(join(root, '..'));
    const store = memoryStore();
    const undo = fileUndoStore({ root, store });
    const snapshot = buildBackup(sourceInstall(), { ...EVERYTHING, history: true }, new Date(JOURNAL.restoredAt)).contents;

    await undo.begin(snapshot, JOURNAL);

    expect(readdirSync(root).sort()).toEqual(['backup.fleetbak', 'journal.json']);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, 'backup.fleetbak')).mode & 0o777).toBe(0o600);
    const onDisk = readFileSync(join(root, 'backup.fleetbak'));
    for (const value of [VALUES.appKey, VALUES.builderRefresh, VALUES.apiKey]) expect(onDisk.includes(Buffer.from(value))).toBe(false);
    expect(store.data.get(UNDO_KEY_REF)).toMatch(/^[0-9a-f]{64}$/);

    await undo.update({ ...JOURNAL, history: { threads: ['t'], messages: [], requests: [], audit: [], ledger: [] } });
    const loaded = await undo.load();
    expect(loaded?.journal.history?.threads).toEqual(['t']);
    expect(loaded?.snapshot.secrets['github-app-private-key']).toBe(VALUES.appKey);
  });

  it('is gone, key and all, once cleared', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'fleetadlc-undo-')), 'restore-undo');
    made.push(join(root, '..'));
    const store = memoryStore();
    const undo = fileUndoStore({ root, store });
    await undo.begin(buildBackup(sourceInstall(), EVERYTHING, new Date()).contents, JOURNAL);

    await undo.clear();

    expect(existsSync(join(root, 'backup.fleetbak'))).toBe(false);
    expect(await undo.journal()).toBeNull();
    expect(await undo.load()).toBeNull();
    expect(store.data.has(UNDO_KEY_REF)).toBe(false);
  });

  it('keeps the earlier restore’s undo when the next snapshot cannot be sealed', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'fleetadlc-undo-')), 'restore-undo');
    made.push(join(root, '..'));
    const store = memoryStore();
    const undo = fileUndoStore({ root, store });
    await undo.begin(buildBackup(sourceInstall(), EVERYTHING, new Date()).contents, JOURNAL);
    const key = store.data.get(UNDO_KEY_REF);

    // What sealing an install too large for one string does.
    const spy = vi.spyOn(JSON, 'stringify').mockImplementationOnce(() => {
      throw new RangeError('Invalid string length');
    });
    try {
      await expect(undo.begin(buildBackup(sourceInstall(), EVERYTHING, new Date()).contents, { ...JOURNAL, id: 'r2' })).rejects.toThrow(/too large/);
    } finally {
      spy.mockRestore();
    }

    expect(store.data.get(UNDO_KEY_REF)).toBe(key);
    const loaded = await undo.load();
    expect(loaded?.journal.id).toBe('r1');
    expect(loaded?.snapshot.secrets['github-app-private-key']).toBe(VALUES.appKey);
  });

  it('is never carried into a backup itself', () => {
    expect(classifySecret(UNDO_KEY_REF, [])).toEqual({ group: 'never', reason: 'it opens this install’s own undo of its last restore' });
  });
});
