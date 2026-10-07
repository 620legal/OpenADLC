import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

import { query, queryOne } from '../client.js';
import { acceptFor, propose, revertSupersede, updateEntry } from './design-memory.js';

const ROW = {
  id: '0b6a7e4c-2f1d-4c0a-9a55-3d2e1f0a9b8c',
  repo_id: 'repo-1',
  kind: 'decision',
  title: 'Costs per round',
  body: 'One row per round.',
  state: 'accepted',
  supersedes: '11111111-2222-4333-8444-555555555555',
  source_subject: 'api#12',
  source_url: null,
  source_task: '22222222-3333-4444-8555-666666666666',
  adr_path: null,
  proposed_by: 'acme-crew',
  decided_by: 'jane',
  decided_at: new Date('2026-09-30T10:00:00Z'),
  created_at: new Date('2026-09-30T09:00:00Z'),
  updated_at: new Date('2026-09-30T10:00:00Z'),
};

beforeEach(() => {
  vi.mocked(query).mockReset().mockResolvedValue([]);
  vi.mocked(queryOne).mockReset().mockResolvedValue(null);
});

describe('a repository’s design memory', () => {
  it('keeps one proposal per title per issue: a design posted again updates it rather than adding a second', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ ...ROW, state: 'proposed' });
    await propose('repo-1', [{ kind: 'decision', title: 'Costs per round', body: 'Changed.' }], {
      subject: 'api#12',
      url: null,
      by: 'system-engineer',
      task: ROW.source_task,
    });
    const [sql] = vi.mocked(queryOne).mock.calls[0]!;
    expect(String(sql)).toMatch(/update design_memory[\s\S]*source_subject = \$2 and lower\(title\) = lower\(\$3\) and state = 'proposed'/);
    // Updated, so nothing is inserted.
    expect(vi.mocked(queryOne)).toHaveBeenCalledTimes(1);
  });

  it('records which design task proposed an entry, and its seat', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(null).mockResolvedValueOnce({ ...ROW, state: 'proposed', proposed_by: 'system-engineer' });
    const [saved] = await propose('repo-1', [{ kind: 'decision', title: 'New', body: 'B.' }], {
      subject: 'api#12',
      url: 'https://github.com/acme/api/issues/12#c',
      by: 'system-engineer',
      task: ROW.source_task,
    });
    const [sql, params] = vi.mocked(queryOne).mock.calls[1]!;
    expect(String(sql)).toMatch(/insert into design_memory \([^)]*proposed_by, source_task\)/);
    expect(params?.slice(-2)).toEqual(['system-engineer', ROW.source_task]);
    expect(saved).toMatchObject({ sourceTask: ROW.source_task, proposedBy: 'system-engineer' });
  });

  it('accepts what a design task proposed on an issue, and says what each accepted entry superseded', async () => {
    const replaced = { ...ROW, id: '11111111-2222-4333-8444-555555555555', state: 'superseded', supersedes: null, title: 'Costs per task' };
    vi.mocked(query).mockResolvedValueOnce([ROW]).mockResolvedValueOnce([replaced]);
    const { accepted, superseded } = await acceptFor('repo-1', ['api#12'], 'jane');
    expect(accepted.map((one) => [one.state, one.decidedBy])).toEqual([['accepted', 'jane']]);
    expect(superseded.map((one) => one.title)).toEqual(['Costs per task']);
    const [accepting, superseding] = vi.mocked(query).mock.calls;
    // An entry no design task proposed (from before) is left for a person.
    expect(String(accepting?.[0])).toMatch(/source_task is not null/);
    expect(String(superseding?.[0])).toMatch(/set state = 'superseded'[\s\S]*returning/);
    expect(superseding?.[1]).toEqual(['repo-1', ['11111111-2222-4333-8444-555555555555']]);
  });

  it('accepts only one task’s entries, or only the ids one comment proposed, when asked', async () => {
    await acceptFor('repo-1', ['api#12'], 'jane', { sourceTask: ROW.source_task, ids: [ROW.id] });
    const [sql, params] = vi.mocked(query).mock.calls[0]!;
    expect(String(sql)).toMatch(/source_task = \$4::uuid[\s\S]*id = any\(\$5::uuid\[\]\)/);
    expect(params?.slice(3)).toEqual([ROW.source_task, [ROW.id]]);
  });

  it('reverts a supersede: the replaced entry is in effect again, and the one that replaced it is retired', async () => {
    const replaced = { ...ROW, id: '11111111-2222-4333-8444-555555555555', state: 'superseded', supersedes: null };
    vi.mocked(queryOne)
      .mockResolvedValueOnce(ROW)
      .mockResolvedValueOnce({ ...replaced, state: 'accepted', decided_by: 'admin' })
      .mockResolvedValueOnce({ ...ROW, state: 'retired' });
    const reverted = await revertSupersede(ROW.id, 'admin');
    expect(reverted?.restored).toMatchObject({ id: replaced.id, state: 'accepted', decidedBy: 'admin' });
    expect(reverted?.retired).toMatchObject({ id: ROW.id, state: 'retired' });

    vi.mocked(queryOne).mockReset().mockResolvedValueOnce({ ...ROW, supersedes: null });
    expect(await revertSupersede(ROW.id, 'admin')).toBeNull();
  });

  it('records who accepted one by hand, and changes nothing for an id that is not one', async () => {
    expect(await updateEntry('nope', { state: 'accepted' }, 'admin')).toBeNull();
    expect(vi.mocked(queryOne)).not.toHaveBeenCalled();
    vi.mocked(queryOne).mockResolvedValueOnce(ROW);
    await updateEntry(ROW.id, { state: 'accepted' }, 'admin@acme.test');
    const [sql, params] = vi.mocked(queryOne).mock.calls[0]!;
    expect(String(sql)).toMatch(/decided_by = case when \$5 = 'accepted' and state <> 'accepted' then \$8/);
    expect(params?.at(-1)).toBe('admin@acme.test');
  });
});
