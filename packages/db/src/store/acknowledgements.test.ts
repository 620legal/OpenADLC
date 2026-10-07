import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({ query: vi.fn(), queryOne: vi.fn() }));

import { query } from '../client.js';
import { acknowledge, forgetBefore, listAcknowledgements } from './acknowledgements.js';

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe('a notice a person dismissed', () => {
  it('keeps the occurrence they saw, and who, adding what the card showed to what was dismissed before', async () => {
    vi.mocked(query).mockResolvedValue([]);
    const at = new Date('2026-09-29T10:00:00Z');
    await acknowledge('unattributed-post', 'post:42', 'janedoe', at, ['post:42', 'post:41']);
    const [sql, params] = vi.mocked(query).mock.calls[0]!;
    expect(String(sql)).toMatch(/on conflict \(id\) do update set/);
    // Added to, never replaced: a dismissed post stays dismissed.
    expect(String(sql)).toContain('acknowledgements.covers || excluded.covers');
    expect(params).toEqual(['unattributed-post', 'post:42', 'janedoe', at, ['post:42', 'post:41']]);
  });

  it('covers at least the occurrence pressed', async () => {
    vi.mocked(query).mockResolvedValue([]);
    await acknowledge('unattributed-post', 'post:41', 'janedoe');
    expect(vi.mocked(query).mock.calls[0]![1]![4]).toEqual(['post:41']);
  });

  it('reads them back by what was acknowledged', async () => {
    vi.mocked(query).mockResolvedValue([
      { id: 'unattributed-post', occurrence: 'post:41', covers: ['post:41', 'post:40'], acknowledged_by: 'janedoe', acknowledged_at: new Date('2026-09-29T10:00:00Z') },
    ]);
    const all = await listAcknowledgements();
    expect(all.get('unattributed-post')).toEqual({
      id: 'unattributed-post',
      occurrence: 'post:41',
      covers: ['post:41', 'post:40'],
      acknowledgedBy: 'janedoe',
      acknowledgedAt: '2026-09-29T10:00:00.000Z',
    });
  });
});

describe('forgetting old dismissals', () => {
  it('deletes only those under the prefix made before the time', async () => {
    vi.mocked(query).mockResolvedValue([]);
    const before = new Date('2026-09-23T10:00:00Z');
    await forgetBefore('task:', before);
    const [sql, params] = vi.mocked(query).mock.calls[0]!;
    expect(String(sql)).toContain('delete from acknowledgements where starts_with(id, $1) and acknowledged_at < $2');
    expect(params).toEqual(['task:', before]);
  });
});
