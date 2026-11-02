import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({
  query: vi.fn(async () => []),
}));

import { query } from '../client.js';
import { addTasks, beat, current, dismiss, openGap, touch, type GapTask } from './bridge-gaps.js';

const RESUMED: GapTask = { taskId: 'task-1', subject: 'openadlc#7', outcome: 'resumed', why: 'resumed implement on openadlc#7', backAt: '2026-11-02T10:05:00.000Z' };

describe('the bridge heartbeat', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.mocked(query).mockResolvedValue([] as never);
  });

  it('says there was no beat before on a first start', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ last_up_at: null, back_at: new Date('2026-11-02T10:05:00Z') }] as never);
    expect(await beat()).toEqual({ lastUpAt: null, backAt: '2026-11-02T10:05:00.000Z' });
    const [sql] = vi.mocked(query).mock.calls[0] ?? [];
    // Read and replaced in one statement, on the database's clock.
    expect(String(sql)).toContain('with old as (select seen_at from bridge_heartbeat');
    expect(String(sql)).toContain('values (true, now())');
  });

  it('gives the beat it replaced on a later start', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ last_up_at: new Date('2026-11-02T10:00:00Z'), back_at: new Date('2026-11-02T10:05:00Z') }] as never);
    expect(await beat()).toEqual({ lastUpAt: '2026-11-02T10:00:00.000Z', backAt: '2026-11-02T10:05:00.000Z' });
  });

  it('beats while running on the database clock', async () => {
    await touch();
    expect(String(vi.mocked(query).mock.calls[0]?.[0])).toContain('on conflict (id) do update set seen_at = excluded.seen_at');
  });
});

describe('the gap report', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.mocked(query).mockResolvedValue([] as never);
  });

  it('is opened, or the open one moved to the latest gap with its tasks kept', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ id: 'gap-1' }] as never);
    expect(await openGap('2026-11-02T10:00:00.000Z', '2026-11-02T10:05:00.000Z')).toEqual({ id: 'gap-1' });
    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toContain('on conflict ((true)) where dismissed_at is null do update set');
    expect(String(sql)).toContain('back_at = excluded.back_at');
    // Tasks are not in the update: the earlier gap's stay.
    expect(String(sql)).not.toContain('tasks');
    expect(params).toEqual(['2026-11-02T10:00:00.000Z', '2026-11-02T10:05:00.000Z']);
  });

  it('adds tasks, each task and outcome once', async () => {
    await addTasks('gap-1', [RESUMED, { ...RESUMED, why: 'again' }, { ...RESUMED, outcome: 'orphaned', why: 'its host stopped' }]);
    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toContain("listed->>'taskId' = entry->>'taskId' and listed->>'outcome' = entry->>'outcome'");
    expect(params?.[0]).toBe('gap-1');
    expect(JSON.parse(String(params?.[1]))).toEqual([
      { ...RESUMED, why: 'again' },
      { ...RESUMED, outcome: 'orphaned', why: 'its host stopped' },
    ]);
  });

  it('asks nothing to add no task', async () => {
    await addTasks('gap-1', []);
    expect(query).not.toHaveBeenCalled();
  });

  it('is read back while open, and is nothing once dismissed', async () => {
    vi.mocked(query).mockResolvedValueOnce([
      { id: 'gap-1', last_up_at: new Date('2026-11-02T10:00:00Z'), back_at: new Date('2026-11-02T10:05:00Z'), tasks: [RESUMED] },
    ] as never);
    expect(await current()).toEqual({ id: 'gap-1', lastUpAt: '2026-11-02T10:00:00.000Z', backAt: '2026-11-02T10:05:00.000Z', tasks: [RESUMED] });
    expect(String(vi.mocked(query).mock.calls[0]?.[0])).toContain('where dismissed_at is null');
    expect(await current()).toBeNull();
  });

  it('is dismissed for everyone only as the gap the person read', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ open: 1, dismissed: 1 }] as never);
    expect(await dismiss('2026-11-02T10:05:00.000Z', 'janedoe')).toBe('dismissed');
    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toContain('open.back_at = $1::timestamptz');
    expect(params).toEqual(['2026-11-02T10:05:00.000Z', 'janedoe']);

    vi.mocked(query).mockResolvedValueOnce([{ open: 1, dismissed: 0 }] as never);
    expect(await dismiss('2026-11-02T09:00:00.000Z', 'janedoe')).toBe('replaced');

    vi.mocked(query).mockResolvedValueOnce([{ open: 0, dismissed: 0 }] as never);
    expect(await dismiss('2026-11-02T10:05:00.000Z', 'janedoe')).toBe('none');
  });
});
