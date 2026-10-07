import { describe, expect, it, vi } from 'vitest';

vi.mock('@fleetadlc/db', () => ({
  bots: { listBots: vi.fn(async () => []) },
  credentials: { listCredentials: vi.fn(async () => []) },
  identities: { listIdentities: vi.fn(async () => []) },
  modelAccounts: { list: vi.fn(async () => []) },
  query: vi.fn(async () => []),
  repos: { listRepos: vi.fn(async () => []) },
  settings: { allSettings: vi.fn(async () => ({})) },
  spendingLimits: {
    SAVE_LOCK: 'spending-limits:save',
    listLimits: vi.fn(async () => {
      throw new Error('spending_limits cannot be read');
    }),
  },
  withTransaction: vi.fn(),
}));

import type { SecretStore } from '@fleetadlc/github';
import { BackupError } from './archive.js';
import { readInstall, restoreDb } from './live.js';
import { EVERYTHING } from './selection.js';

/**
 * An empty spending list in an archive is "replace the table with nothing".
 * A read that failed used to be written that way, and restoring it wiped
 * every cap.
 */
describe('reading the spending caps into a backup', () => {
  it('fails the backup when the caps cannot be read, rather than archiving none', async () => {
    const store: SecretStore = {
      list: async () => [],
      get: async () => null,
      set: async () => undefined,
      delete: async () => undefined,
    };
    await expect(readInstall(EVERYTHING, { store })).rejects.toThrow('spending_limits cannot be read');
  });
});

/**
 * The table as far as a restore writes the caps: rows by scope and kind, the
 * repositories and bots the archive's caps are found by, and what else was
 * said to the database, in order.
 */
function capsTable(rows: { scope: string; kind: string; amountUsd: number }[]) {
  const said: { text: string; params: unknown[] }[] = [];
  const sql = {
    async query(text: string, params: unknown[] = []) {
      const flat = text.replace(/\s+/g, ' ').trim();
      const answer = (list: Record<string, unknown>[]) => ({ rows: list, rowCount: list.length });
      if (flat.startsWith('select id, full_name from repos')) return answer([{ id: 'r1', full_name: 'janedoe/widgets' }]);
      if (flat.startsWith('select id, name, slot from bots')) return answer([]);
      if (flat.startsWith('select scope, kind, amount_usd')) {
        return answer(rows.map((row) => ({ scope: row.scope, kind: row.kind, amount_usd: String(row.amountUsd) })));
      }
      said.push({ text: flat, params });
      if (flat.startsWith('delete from spending_limits')) rows.splice(0);
      if (flat.startsWith('insert into spending_limits')) {
        const [scope, kind, amountUsd] = params as [string, string, number];
        const at = rows.findIndex((row) => row.scope === scope && row.kind === kind);
        if (at >= 0) rows[at] = { scope, kind, amountUsd };
        else rows.push({ scope, kind, amountUsd });
      }
      return answer([]);
    },
  };
  return { sql, rows, said };
}

describe('writing the archive’s caps into an install that is set up', () => {
  const here = () => [
    { scope: 'global', kind: 'month_total', amountUsd: 300 },
    { scope: 'global', kind: 'task', amountUsd: 10 },
    { scope: 'repo:r1', kind: 'month_total', amountUsd: 25 },
  ];

  it('sets the caps it names, under the save lock, audits each, and deletes none', async () => {
    const { sql, rows, said } = capsTable(here());

    await restoreDb(sql).mergeSpendingLimits([{ scope: 'global', kind: 'month_total', amountUsd: 5000 }], 'alex@example.test');

    expect(rows).toEqual([
      { scope: 'global', kind: 'month_total', amountUsd: 5000 },
      { scope: 'global', kind: 'task', amountUsd: 10 },
      { scope: 'repo:r1', kind: 'month_total', amountUsd: 25 },
    ]);
    expect(said[0]).toEqual({ text: 'select pg_advisory_xact_lock(hashtext($1))', params: ['spending-limits:save'] });
    expect(said.some((one) => one.text.startsWith('delete'))).toBe(false);
    const audit = said.filter((one) => one.text.startsWith('insert into audit'));
    expect(audit).toHaveLength(1);
    expect(audit[0]?.params.slice(0, 3)).toEqual(['alex@example.test', 'spending.limit_changed', 'global month_total']);
    expect(JSON.parse(String(audit[0]?.params[3]))).toEqual({ scope: 'global', kind: 'month_total', old: 300, new: 5000 });
  });

  it('refuses caps that would leave a repository’s above the global one, naming it, and writes nothing', async () => {
    const { sql, rows, said } = capsTable(here());

    const merge = restoreDb(sql).mergeSpendingLimits([{ scope: 'global', kind: 'month_total', amountUsd: 5 }], 'alex@example.test');

    await expect(merge).rejects.toThrow(BackupError);
    await expect(merge).rejects.toThrow('janedoe/widgets, a month at $25, above the global $5');
    expect(rows).toEqual(here());
    expect(said.filter((one) => !one.text.startsWith('select pg_advisory'))).toEqual([]);
  });

  it('still replaces the table onto a clean install', async () => {
    const { sql, rows } = capsTable(here());
    await restoreDb(sql).replaceSpendingLimits([{ scope: 'global', kind: 'month_total', amountUsd: 5000 }]);
    expect(rows).toEqual([{ scope: 'global', kind: 'month_total', amountUsd: 5000 }]);
  });
});
