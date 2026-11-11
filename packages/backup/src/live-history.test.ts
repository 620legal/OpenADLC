import { beforeEach, describe, expect, it, vi } from 'vitest';

const attachments = vi.hoisted(() => ({ error: null as (Error & { code?: string }) | null }));

vi.mock('@openadlc/db', () => ({
  bots: { listBots: vi.fn(async () => []) },
  credentials: { listCredentials: vi.fn(async () => []) },
  identities: { listIdentities: vi.fn(async () => []) },
  modelAccounts: { list: vi.fn(async () => []) },
  query: vi.fn(async (sql: string) => {
    if (attachments.error && /from attachments/.test(sql)) throw attachments.error;
    return [];
  }),
  repos: { listRepos: vi.fn(async () => []) },
  settings: { allSettings: vi.fn(async () => ({})) },
  spendingLimits: { listLimits: vi.fn(async () => []) },
  withTransaction: vi.fn(),
}));

import { query } from '@openadlc/db';
import type { SecretStore } from '@openadlc/github';
import { readHistoryHere, readInstall, restoreDb } from './live.js';
import { HISTORY } from './test-fixtures.js';
import { EVERYTHING } from './selection.js';

const store: SecretStore = {
  list: async () => [],
  get: async () => null,
  set: async () => undefined,
  delete: async () => undefined,
};

/**
 * A backup with history carries the files sent with things. A read of them
 * that failed used to be written as none, and the backup said it succeeded.
 */
describe('reading the attachments into a backup with history', () => {
  it('fails the backup when they cannot be read, rather than archiving none', async () => {
    attachments.error = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    await expect(readInstall({ ...EVERYTHING, history: true }, { store })).rejects.toThrow('statement timeout');
  });

  it('reads none from a database that has no attachments table yet', async () => {
    attachments.error = Object.assign(new Error('relation "attachments" does not exist'), { code: '42P01' });
    const found = await readInstall({ ...EVERYTHING, history: true }, { store });
    expect(found.history?.attachments).toEqual([]);
  });
});

/**
 * An archive keeps `at` to the millisecond and Postgres to the microsecond, so
 * a row already here is found within the millisecond starting at the
 * archived time. An exact match almost never held: restoring a backup into
 * its own install wrote every audit line and cost a second time.
 */
describe('whether a cost was billed, across a backup and a restore', () => {
  beforeEach(() => {
    attachments.error = null;
  });

  it('reads the flag into the archive', async () => {
    vi.mocked(query).mockImplementation((async (sql: string) =>
      /from ledger l/.test(sql)
        ? [
            { seat: 'builder', engine: 'claude', model: 'claude-opus-5', model_alias: null, prompt_hash: null, tokens_in: 1, tokens_out: 1, cost_usd: '2', billed: false, at: new Date('2026-11-01T00:00:00Z') },
            { seat: 'builder', engine: 'claude', model: 'claude-opus-5', model_alias: null, prompt_hash: null, tokens_in: 1, tokens_out: 1, cost_usd: '3', billed: true, at: new Date('2026-11-01T00:00:01Z') },
          ]
        : []) as never);
    try {
      const found = await readInstall({ ...EVERYTHING, history: true }, { store });
      expect(String(vi.mocked(query).mock.calls.find(([text]) => /from ledger l/.test(String(text)))?.[0])).toContain('l.billed');
      expect(found.history?.ledger.map((row) => row.billed)).toEqual([false, true]);
    } finally {
      vi.mocked(query).mockImplementation((async () => []) as never);
    }
  });

  it('restores a subscription row as not billed, and a row from an older archive as billed', async () => {
    const params: unknown[][] = [];
    const sql = {
      query: vi.fn(async (text: string, values: unknown[] = []) => {
        if (/insert into ledger/.test(text)) params.push(values);
        if (/select id, slot from bots/.test(text)) return { rows: [{ id: 'b0b0b0b0-0000-4000-8000-000000000001', slot: 'builder' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
    };
    const [row] = HISTORY.ledger;
    const { billed: _none, ...old } = row!;
    await restoreDb(sql).putHistory({
      ...HISTORY,
      threads: [],
      messages: [],
      requests: [],
      ledger: [{ ...row!, billed: false }, old],
    });
    expect(params.map((values) => values[9])).toEqual([false, true]);
  });
});

describe('recognising audit lines and costs already here', () => {
  beforeEach(() => {
    attachments.error = null;
    vi.mocked(query).mockClear();
  });

  it('matches them within the archived millisecond when a restore writes history', async () => {
    const sent: string[] = [];
    const sql = {
      query: vi.fn(async (text: string) => {
        sent.push(text);
        if (/select id, slot from bots/.test(text)) return { rows: [{ id: 'b0b0b0b0-0000-4000-8000-000000000001', slot: 'builder' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
    };
    await restoreDb(sql).putHistory({ ...HISTORY, threads: [], messages: [], requests: [] });
    const audit = sent.find((text) => /insert into audit/.test(text));
    const ledger = sent.find((text) => /insert into ledger/.test(text));
    expect(audit).toMatch(/at >= \$5::timestamptz and at < \$5::timestamptz \+ interval '1 millisecond'/);
    expect(ledger).toMatch(/at >= \$9::timestamptz and at < \$9::timestamptz \+ interval '1 millisecond'/);
    for (const text of [audit, ledger]) expect(text).not.toMatch(/\bat = \$/);
  });

  it('matches them within the archived millisecond when it counts what is here', async () => {
    await readHistoryHere(HISTORY);
    const sent = vi.mocked(query).mock.calls.map(([text]) => String(text));
    const audit = sent.find((text) => /from audit a/.test(text));
    const ledger = sent.find((text) => /from ledger l/.test(text));
    expect(audit).toMatch(/a\.at >= line\.at and a\.at < line\.at \+ interval '1 millisecond'/);
    expect(ledger).toMatch(/l\.at >= spend\.at and l\.at < spend\.at \+ interval '1 millisecond'/);
    for (const text of [audit, ledger]) expect(text).not.toMatch(/\.at = (line|spend)\.at/);
  });
});
