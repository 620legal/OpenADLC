import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({ query: vi.fn(async () => []), queryOne: vi.fn() }));

import { query, queryOne } from '../client.js';
import { bindNonce, listUnattributed, recordUnattributed, resolveUnattributed } from './attributions.js';

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(query).mockResolvedValue([]);
  vi.mocked(queryOne).mockReset();
});

describe('a signature nonce', () => {
  it('still belongs to the post when it was bound under the repository’s old casing', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ bound_to: 'Acme/widgets:review:12' });
    expect(
      await bindNonce({
        nonce: 'n-1',
        seat: 'lead-reviewer',
        taskId: null,
        repo: 'acme/widgets',
        kind: 'review',
        boundTo: 'acme/widgets:review:12',
      }),
    ).toBe(true);

    vi.mocked(queryOne).mockResolvedValueOnce({ bound_to: 'other/widgets:review:9' });
    expect(
      await bindNonce({
        nonce: 'n-2',
        seat: 'lead-reviewer',
        taskId: null,
        repo: 'acme/widgets',
        kind: 'review',
        boundTo: 'acme/widgets:review:12',
      }),
    ).toBe(false);
  });
});

describe('a post recorded as not signed by OpenADLC', () => {
  it('is resolved when it verifies after all, once', async () => {
    const at = new Date('2026-09-29T10:00:00Z');
    vi.mocked(query).mockResolvedValueOnce([{ id: 40 }]);
    expect(await resolveUnattributed(40, at)).toBe(true);
    const [sql, params] = vi.mocked(query).mock.calls[0]!;
    expect(String(sql)).toContain('set resolved_at = $2 where id = $1 and resolved_at is null');
    expect(params).toEqual([40, at]);
    // Already resolved: nothing changed, so nothing to say.
    expect(await resolveUnattributed(40, at)).toBe(false);
  });

  it('is open again when it fails again after it was resolved', async () => {
    await recordUnattributed({ repo: 'exampleco/api', kind: 'comment', objectId: '7', login: 'crew', reason: 'bad signature', url: null, seat: 'builder', bodySha256: null });
    const text = String(vi.mocked(query).mock.calls[0]![0]).replace(/\s+/g, ' ');
    expect(text).toContain('on conflict (repo, kind, object_id, reason) do update set created_at = now(), resolved_at = null');
  });

  it('is listed only while it is not resolved', async () => {
    await listUnattributed(new Date('2026-09-28T10:00:00Z'));
    expect(String(vi.mocked(query).mock.calls[0]![0])).toContain('resolved_at is null');
  });
});
