import { describe, expect, it, vi } from 'vitest';

const PERSON = {
  id: '6f1c8a52-0d4e-4c3b-9a2f-1b7e5d9c0a11',
  name: 'Jane',
  email: 'jane@example.com',
  consoleRole: 'admin' as const,
  githubLogin: 'janedoe',
  githubUserId: 583231,
  githubLinkedAt: '2026-11-01T10:00:00.000Z',
  approves: true,
  addedBy: 'jane@example.com',
  addedHow: 'first',
  addedAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
};

vi.mock('@openadlc/db', () => ({
  bots: { listBots: vi.fn(async () => []) },
  credentials: { listCredentials: vi.fn(async () => []) },
  identities: { listIdentities: vi.fn(async () => []) },
  modelAccounts: { list: vi.fn(async () => []) },
  people: { listPeople: vi.fn(async () => [PERSON]) },
  query: vi.fn(async () => []),
  repos: { listRepos: vi.fn(async () => []) },
  settings: { allSettings: vi.fn(async () => ({})) },
  spendingLimits: { SAVE_LOCK: 'spending-limits:save', listLimits: vi.fn(async () => []) },
  withTransaction: vi.fn(),
}));

import type { SecretStore } from '@openadlc/github';
import { readPlain, writePlain, type BackupContents } from './archive.js';
import { readInstall, restoreDb } from './live.js';
import { EVERYTHING } from './selection.js';

const store: SecretStore = { list: async () => [], get: async () => null, set: async () => undefined, delete: async () => undefined };

/** `people` as far as a restore writes it, and what else was said, in order. */
function peopleTable(rows: Record<string, unknown>[]) {
  const said: { text: string; params: unknown[] }[] = [];
  const sql = {
    async query(text: string, params: unknown[] = []) {
      const flat = text.replace(/\s+/g, ' ').trim();
      said.push({ text: flat, params });
      const answer = (list: Record<string, unknown>[]) => ({ rows: list, rowCount: list.length });
      if (flat.startsWith('select id from people where github_user_id')) return answer(rows.filter((row) => row.github_user_id === params[0]));
      if (flat.startsWith('select id from people where lower(github_login)')) {
        return answer(rows.filter((row) => String(row.github_login ?? '').toLowerCase() === String(params[0]).toLowerCase()));
      }
      if (flat.startsWith('update people set approves = true')) {
        const row = rows.find((one) => one.id === params[0])!;
        row.approves = true;
      }
      if (flat.startsWith('insert into people (github_login')) rows.push({ id: `new-${rows.length}`, github_login: params[0], github_user_id: params[1], approves: true });
      return answer([]);
    },
  };
  return { sql, rows, said };
}

describe('the install’s people in a backup', () => {
  it('are read with the install, every column', async () => {
    const snapshot = await readInstall(EVERYTHING, { store });
    expect(snapshot.people).toEqual([PERSON]);
  });

  it('come back out of the archive as they went in, and an archive without them has none', () => {
    const contents = {
      manifest: {
        version: 3,
        createdAt: '2026-11-09T10:00:00.000Z',
        counts: { secrets: 0, settings: 0, bots: 0 },
        includes: { install: true, repositories: false, bots: 'all', botSignIns: false, accounts: 'none', accountSignIns: false, history: false },
      },
      secrets: {},
      settings: {},
      bots: [],
    } as unknown as BackupContents;
    expect(readPlain(writePlain({ ...contents, people: [PERSON] })).people).toEqual([PERSON]);
    expect(readPlain(writePlain(contents))).not.toHaveProperty('people');
  });

  it('are written by id, over a row here that is the same person under another id', async () => {
    const { sql, said } = peopleTable([]);
    await restoreDb(sql).putPeople?.([PERSON]);
    expect(said[0]?.params).toEqual(['openadlc:users']);
    expect(said[1]).toEqual({ text: 'delete from people where id <> $1 and (email = $2 or github_user_id = $3)', params: [PERSON.id, PERSON.email, PERSON.githubUserId] });
    expect(said[2]?.text).toMatch(/^insert into people \(id, name, email/);
    expect(said[2]?.params.slice(0, 8)).toEqual([PERSON.id, 'Jane', 'jane@example.com', 'admin', 'janedoe', 583231, PERSON.githubLinkedAt, true]);
  });
});

describe('an archive from before People', () => {
  it('leaves the logins its humans named approving, pinned as they were, and the row gone', async () => {
    const { sql, rows, said } = peopleTable([{ id: 'p-1', github_login: null, github_user_id: 101, approves: false }]);
    await restoreDb(sql).approveArchivedHumans?.('alice, Bob,alice', JSON.stringify({ alice: 101 }));
    expect(rows).toEqual([
      { id: 'p-1', github_login: null, github_user_id: 101, approves: true },
      { id: 'new-1', github_login: 'Bob', github_user_id: null, approves: true },
    ]);
    expect(said.at(-1)?.text).toBe("delete from settings where key = 'humans'");
  });
});
