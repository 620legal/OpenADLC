import { describe, expect, it, vi } from 'vitest';

vi.mock('@fleetadlc/db', () => ({
  bots: { listBots: vi.fn(async () => []) },
  credentials: { listCredentials: vi.fn(async () => []) },
  identities: { listIdentities: vi.fn(async () => []) },
  modelAccounts: { list: vi.fn(async () => []) },
  query: vi.fn(async () => []),
  repos: { listRepos: vi.fn(async () => []) },
  settings: { allSettings: vi.fn(async () => ({})) },
  spendingLimits: { listLimits: vi.fn(async () => []) },
  withTransaction: vi.fn(),
}));

import type { ArchivedHistory, ArchivedRequest } from './archive.js';
import { restoreDb } from './live.js';

const DRAFT = 'cccccccc-0000-4000-8000-000000000001';
const QUEUED = 'cccccccc-0000-4000-8000-000000000002';

function request(id: string, state: string): ArchivedRequest {
  return {
    id,
    text: 'Add a health check',
    context: null,
    repo: null,
    kind: 'feature',
    requestedBy: 'alex@example.test',
    issueNumber: null,
    state,
    createdAt: '2026-09-01T09:30:00.000Z',
    updatedAt: '2026-09-01T09:40:00.000Z',
  };
}

/**
 * A database as far as `putHistory` goes: the requests it holds, so an
 * attachment's `(select id from requests where id = $4)` finds one only if
 * it was written.
 */
function fakeDatabase() {
  const requests = new Map<string, unknown[]>();
  const attachments: { id: unknown; requestId: unknown }[] = [];
  const sent: string[] = [];
  const sql = {
    query: vi.fn(async (text: string, params: unknown[] = []) => {
      sent.push(text);
      if (/insert into requests/.test(text)) {
        requests.set(String(params[0]), params);
        return { rows: [{ id: params[0] }], rowCount: 1 };
      }
      if (/insert into attachments/.test(text)) {
        attachments.push({ id: params[0], requestId: requests.has(String(params[3])) ? params[3] : null });
        return { rows: [{ id: params[0] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
  return { sql, requests, attachments, sent };
}

describe('restoring the requests in a history backup', () => {
  it('brings back a request that was queued, queued, with its attachment on it', async () => {
    // Queued came with migration 0021 and the restore still listed the four
    // states before it: a queued request was dropped, with what the person
    // wrote, and its file came back attached to nothing.
    const db = fakeDatabase();
    const history: ArchivedHistory = {
      threads: [],
      messages: [],
      audit: [],
      ledger: [],
      requests: [request(DRAFT, 'draft'), request(QUEUED, 'queued')],
      attachments: [
        {
          id: 'dddddddd-0000-4000-8000-000000000001',
          subjectRef: `request:${QUEUED.slice(0, 8)}`,
          repo: null,
          requestId: QUEUED,
          messageId: null,
          source: 'console',
          sourceUrl: null,
          name: 'screenshot.png',
          mediaType: 'image/png',
          sizeBytes: 3,
          sha256: 'a'.repeat(64),
          content: 'AAAA',
          uploadedBy: 'alex@example.test',
          createdAt: '2026-09-01T09:30:00.000Z',
        },
      ],
    };

    const counts = await restoreDb(db.sql).putHistory(history);

    expect(counts.requests).toBe(2);
    expect(db.requests.get(QUEUED)?.[7]).toBe('queued');
    // A restored queued request is a fresh place in the line: the column
    // defaults give it no passes and no reason.
    const insert = db.sent.find((text) => /insert into requests/.test(text));
    expect(insert).not.toMatch(/queue_attempts|queue_reason/);
    expect(db.attachments).toEqual([{ id: 'dddddddd-0000-4000-8000-000000000001', requestId: QUEUED }]);
  });

  it('leaves out a request in a state the table does not take', async () => {
    const db = fakeDatabase();
    const counts = await restoreDb(db.sql).putHistory({
      threads: [],
      messages: [],
      audit: [],
      ledger: [],
      requests: [request(DRAFT, 'draft'), request(QUEUED, 'shelved')],
    });
    expect(counts.requests).toBe(1);
    expect([...db.requests.keys()]).toEqual([DRAFT]);
  });
});
