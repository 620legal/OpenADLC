import { describe, expect, it } from 'vitest';
import { BackupError, readPlain, writePlain, type ArchivedRepository, type BackupContents } from './archive.js';
import { restoreDb } from './live.js';

/**
 * A repository as a restore writes it: with the colour the board told it
 * apart by, working in it again if this install had removed it, and never
 * over another repository that has its name. The rows are written through
 * one transaction's client, which is all this needs.
 */

const ARCHIVED: ArchivedRepository = {
  name: 'api',
  fullName: 'acme/api',
  ownerSeat: 'builder',
  concurrency: 1,
  stageModes: { merged: 'autonomous' },
  specRequiredLabels: [],
  humanReviewPaths: [],
  defaultBranch: 'main',
  color: 'teal',
};

type Row = {
  id: string;
  name: string;
  full_name: string;
  color: string;
  removed_at: string | null;
};

/**
 * A `repos` table as far as `putRepository` reads and writes it: rows by id,
 * with the unique name the real table has. Each statement is applied to the
 * rows, so what a restore did is read back from them rather than guessed
 * from its SQL.
 */
function table(rows: Row[]) {
  const writes: { text: string; params: unknown[] }[] = [];
  let serial = rows.length;
  const sql = {
    async query(text: string, params: unknown[] = []) {
      const flat = text.replace(/\s+/g, ' ').trim();
      const found = (list: Row[]) => ({ rows: list, rowCount: list.length });
      if (flat.startsWith('select id, color from repos where lower(full_name)')) {
        return found(rows.filter((row) => row.full_name.toLowerCase() === String(params[0]).toLowerCase()));
      }
      if (flat.startsWith('select name, full_name, removed_at from repos where lower(name)')) {
        return found(rows.filter((row) => row.name.toLowerCase() === String(params[0]).toLowerCase()));
      }
      if (flat.startsWith('select id, color from repos where removed_at is null')) return found(rows.filter((row) => !row.removed_at));
      writes.push({ text: flat, params });
      if (flat.startsWith('update repos set')) {
        const row = rows.find((one) => one.id === params[0]);
        if (row) Object.assign(row, { full_name: params[1], color: params[8], removed_at: null });
        return { rows: [], rowCount: row ? 1 : 0 };
      }
      if (flat.startsWith('insert into repos')) {
        if (rows.some((one) => one.name === params[0])) throw new Error('duplicate key value violates unique constraint "repos_name_key"');
        rows.push({ id: `r${++serial}`, name: String(params[0]), full_name: String(params[1]), color: String(params[8]), removed_at: null });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`the table has no answer for ${flat}`);
    },
  };
  return { sql, rows, writes };
}

describe('restoring a repository', () => {
  it('gives it the colour it had, and brings it back if this install had removed it', async () => {
    const { sql, rows } = table([
      { id: 'r1', name: 'api', full_name: 'acme/api', color: 'blue', removed_at: '2026-09-20T00:00:00.000Z' },
      { id: 'r2', name: 'web', full_name: 'acme/web', color: 'teal', removed_at: null },
    ]);
    await restoreDb(sql).putRepository(ARCHIVED, 'fleetadlc-atlas-janedoe');

    expect(rows[0]).toMatchObject({ id: 'r1', full_name: 'acme/api', color: 'teal', removed_at: null });
  });

  it('keeps the colour a row here has, from an archive written before repositories had one', async () => {
    const { sql, rows } = table([{ id: 'r1', name: 'api', full_name: 'acme/api', color: 'violet', removed_at: null }]);
    await restoreDb(sql).putRepository({ ...ARCHIVED, color: undefined }, null);
    expect(rows[0]?.color).toBe('violet');
  });

  it('gives a new one from such an archive the next colour nobody has, rather than the column’s default', async () => {
    const { sql, rows } = table([
      { id: 'r1', name: 'web', full_name: 'acme/web', color: 'blue', removed_at: null },
      { id: 'r2', name: 'docs', full_name: 'acme/docs', color: 'amber', removed_at: null },
    ]);
    await restoreDb(sql).putRepository({ ...ARCHIVED, color: undefined }, null);
    expect(rows.find((row) => row.full_name === 'acme/api')?.color).toBe('pink');
  });
});

describe('restoring a repository whose name another repository here has', () => {
  const OTHER: ArchivedRepository = { ...ARCHIVED, name: 'widgets', fullName: 'other/widgets' };
  const ACME: Row = { id: 'r1', name: 'widgets', full_name: 'acme/widgets', color: 'blue', removed_at: null };

  it('refuses, naming the one here, and writes nothing over its row', async () => {
    const { sql, rows, writes } = table([{ ...ACME }]);

    const put = restoreDb(sql).putRepository(OTHER, null);

    await expect(put).rejects.toThrow(BackupError);
    await expect(restoreDb(sql).putRepository(OTHER, null)).rejects.toThrow(
      'this install already has a repository called widgets (acme/widgets), and OpenADLC names each repository by its name alone, so other/widgets cannot be restored beside it',
    );
    expect(writes).toEqual([]);
    expect(rows).toEqual([ACME]);
  });

  it('refuses the same when the one here was removed from OpenADLC', async () => {
    const { sql, writes } = table([{ ...ACME, removed_at: '2026-09-20T00:00:00.000Z' }]);
    await expect(restoreDb(sql).putRepository(OTHER, null)).rejects.toThrow(/widgets \(acme\/widgets, removed from OpenADLC\)/);
    expect(writes).toEqual([]);
  });

  it('writes the same repository by its full name, whatever case GitHub gave it', async () => {
    const { sql, rows } = table([{ ...ACME }]);
    await restoreDb(sql).putRepository({ ...OTHER, fullName: 'Acme/Widgets' }, null);
    expect(rows).toEqual([{ ...ACME, full_name: 'Acme/Widgets', color: 'teal' }]);
  });

  it('goes back into the row a restore wrote it over, when Undo says which', async () => {
    // What an older restore left: acme/widgets' row holding other/widgets.
    const { sql, rows } = table([{ ...ACME, full_name: 'other/widgets' }]);
    await restoreDb(sql).putRepository({ ...ARCHIVED, name: 'widgets', fullName: 'acme/widgets', color: 'blue' }, null, { over: 'other/widgets' });
    expect(rows).toEqual([ACME]);
  });
});

describe('a repository’s colour in an archive', () => {
  const contents = (repositories: unknown[]): BackupContents =>
    ({
      manifest: {
        version: 2,
        createdAt: '2026-09-25T09:00:00.000Z',
        counts: { secrets: 0, settings: 0, bots: 0 },
        includes: { install: false, repositories: true, bots: 'none', botSignIns: false, accounts: 'none', accountSignIns: false, history: false },
      },
      secrets: {},
      settings: {},
      bots: [],
      repositories,
    }) as unknown as BackupContents;

  it('is read back as it was written', () => {
    const back = readPlain(writePlain(contents([ARCHIVED])));
    expect(back.repositories?.[0]?.color).toBe('teal');
  });

  it('is simply absent from an archive written before there were colours', () => {
    const { color: _none, ...before } = ARCHIVED;
    const back = readPlain(writePlain(contents([before])));
    expect(back.repositories?.[0]).not.toHaveProperty('color');
  });
});
