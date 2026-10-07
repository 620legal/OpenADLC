import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fleetHome, getSecretStore, type SecretStore } from '@fleetadlc/github';
import { BackupError, decryptBackup, encryptBackup, type BackupContents } from './archive.js';
import type { RestoreJournal } from './undo.js';

/**
 * Where the backup an undo puts back is kept: beside the install's other
 * state, sealed like any backup, with a passphrase nobody chose — made for it,
 * kept in the secret store and in no archive (`classifySecret` leaves it out).
 * One at a time: a second restore replaces the first one's undo. Once used it
 * is gone; a day old, it stops being offered, and the bridge's hourly sweep
 * (`sweepExpiredUndo`) removes it. The store has no clock of its own.
 */

/** The secret that opens the undo's backup. */
export const UNDO_KEY_REF = 'restore-undo-key';

export interface UndoStore {
  /** The backup taken before a restore, and what the restore is about to touch. */
  begin(snapshot: BackupContents, journal: RestoreJournal): Promise<void>;
  /** What the restore touched, once it has written what it adds. */
  update(journal: RestoreJournal): Promise<void>;
  load(): Promise<{ journal: RestoreJournal; snapshot: BackupContents } | null>;
  /** The journal alone, without opening the backup: what a page shows. */
  journal(): Promise<RestoreJournal | null>;
  clear(): Promise<void>;
}

function writePrivate(path: string, bytes: Buffer | string): void {
  const next = `${path}.new`;
  writeFileSync(next, bytes, { mode: 0o600 });
  chmodSync(next, 0o600);
  renameSync(next, path);
}

export function fileUndoStore(options: { root?: string; store?: SecretStore } = {}): UndoStore {
  const root = options.root ?? join(fleetHome(), 'restore-undo');
  const store = (): SecretStore => options.store ?? getSecretStore();
  const journalPath = join(root, 'journal.json');
  const backupPath = join(root, 'backup.fleetbak');

  const readJournal = (): RestoreJournal | null => {
    if (!existsSync(journalPath)) return null;
    try {
      return JSON.parse(readFileSync(journalPath, 'utf8')) as RestoreJournal;
    } catch {
      return null;
    }
  };

  return {
    async begin(snapshot, journal) {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      chmodSync(root, 0o700);
      const passphrase = randomBytes(32).toString('hex');
      // Sealed before the key is replaced: a snapshot that cannot be sealed
      // used to leave the earlier restore's backup behind a key that no
      // longer opened it, so that restore's Undo was lost too.
      const sealed = await encryptBackup(snapshot, passphrase);
      await store().set(UNDO_KEY_REF, passphrase);
      writePrivate(backupPath, sealed);
      writePrivate(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    },

    async update(journal) {
      if (!existsSync(backupPath)) throw new BackupError('there is no backup to undo with');
      writePrivate(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    },

    async load() {
      const journal = readJournal();
      const passphrase = await store().get(UNDO_KEY_REF);
      if (!journal || !passphrase || !existsSync(backupPath)) return null;
      return { journal, snapshot: await decryptBackup(readFileSync(backupPath), passphrase) };
    },

    journal: async () => readJournal(),

    async clear() {
      rmSync(journalPath, { force: true });
      rmSync(backupPath, { force: true });
      await store().delete(UNDO_KEY_REF);
    },
  };
}
