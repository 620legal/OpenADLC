import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
}));

import { query, queryOne, withTransaction } from '../client.js';
import { claim, claimable, listForSubjects, readAttachment, sweepUnclaimed } from './attachments.js';

const ID = '0b6a7e4c-2f1d-4c0a-9a55-3d2e1f0a9b8c';
const SAME_BYTES = '7c1d9e2a-4b3f-4e5d-8a6b-1f2e3d4c5b6a';

/** Statements `claim` sends inside its transaction, in order. */
let statements: { text: string; params: unknown[] }[] = [];

beforeEach(() => {
  vi.mocked(query).mockReset().mockResolvedValue([]);
  vi.mocked(queryOne).mockReset().mockResolvedValue(null);
  statements = [];
  const client = {
    query: vi.fn(async (text: string, params: unknown[] = []) => {
      statements.push({ text, params });
      return { rows: [] };
    }),
  };
  vi.mocked(withTransaction).mockReset().mockImplementation(async (fn) => fn(client as never));
});

describe('attachments in the database', () => {
  it('never reads the bytes to list an item’s files, only to serve one', async () => {
    // An item can carry 25 MB; a list of names should not pull it through the pool.
    await listForSubjects(['request:a4b02784', 'api#12']);
    expect(String(vi.mocked(query).mock.calls[0]?.[0])).not.toMatch(/\bcontent\b/);
    await readAttachment(ID);
    expect(String(vi.mocked(queryOne).mock.calls[0]?.[0])).toMatch(/, content from attachments/);
  });

  it('claims only the uploader’s own unclaimed uploads, within the day, and keeps one row per file on a subject', async () => {
    const since = new Date('2026-09-29T12:00:00Z');
    await claim([ID, 'not-an-id'], { uploadedBy: 'jane@acme.test', since, subjectRef: 'request:a4b02784', repoId: null, requestId: 'r-1' });
    const [dedupe, , update] = statements;
    expect(dedupe?.text).toMatch(/delete from attachments a[\s\S]*b\.subject_ref = \$3 and b\.sha256 = a\.sha256/);
    expect(update?.text).toMatch(/subject_ref is null and uploaded_by = \$2 and created_at > \$7/);
    // A malformed id is never sent to Postgres, where it would be an error rather than "no such file".
    expect(update?.params).toEqual([[ID], 'jane@acme.test', 'request:a4b02784', null, 'r-1', null, since]);
    expect(vi.mocked(query)).not.toHaveBeenCalled();
  });

  it('collapses two uploads of the same bytes in one batch to one file, keeping the smaller id, before claiming', async () => {
    // Claiming both put two rows with one sha256 on the subject: a unique violation, a 500,
    // and a request already queued without its screenshot.
    const since = new Date('2026-09-29T12:00:00Z');
    await claim([SAME_BYTES, ID], { uploadedBy: 'jane@acme.test', since, subjectRef: 'request:a4b02784', repoId: null, requestId: 'r-1' });
    expect(vi.mocked(withTransaction)).toHaveBeenCalledTimes(1);
    expect(statements).toHaveLength(3);
    const [, withinBatch, update] = statements;
    expect(withinBatch?.text).toMatch(/delete from attachments a/);
    expect(withinBatch?.text).toMatch(/b\.id = any\(\$1::uuid\[\]\) and b\.subject_ref is null and b\.uploaded_by = \$2/);
    expect(withinBatch?.text).toMatch(/b\.sha256 = a\.sha256 and b\.id < a\.id/);
    expect(withinBatch?.params).toEqual([[SAME_BYTES, ID], 'jane@acme.test']);
    expect(update?.text).toMatch(/^\s*update attachments/);
  });

  it('reads nothing for an id that is not one', async () => {
    expect(await readAttachment('../../etc/passwd')).toBeNull();
    expect(await claimable(['x'], 'jane', new Date())).toEqual([]);
    expect(vi.mocked(queryOne)).not.toHaveBeenCalled();
    expect(vi.mocked(query)).not.toHaveBeenCalled();
  });

  it('sweeps only uploads nobody sent with anything', async () => {
    vi.mocked(query).mockResolvedValue([{ id: ID }]);
    expect(await sweepUnclaimed(new Date('2026-09-29T12:00:00Z'))).toBe(1);
    expect(String(vi.mocked(query).mock.calls[0]?.[0])).toBe('delete from attachments where subject_ref is null and created_at < $1 returning id');
  });
});
