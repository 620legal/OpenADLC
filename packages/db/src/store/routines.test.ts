import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

import { query, queryOne } from '../client.js';
import { claimSlot, create, due, get, list, previousOpen, recordRun, remove, setPaused, update } from './routines.js';

const ID = '0b6f1d1c-6c55-4c1c-9a59-1f4a4b8f2a10';
const REQUEST = 'a4b02784-3ae8-450b-abe9-0c93eb4d67dc';
const NEXT = new Date('2026-11-30T08:00:00.000Z');

const ROW = {
  id: ID,
  repo_id: 'repo-1',
  repo_name: 'app',
  repo_full_name: 'acme/app',
  text: 'Review the dependencies',
  details: 'One change per pull request.',
  kind: 'chore',
  cadence: 'weekly',
  cadence_day: 1,
  time_of_day: '09:00',
  time_zone: 'Europe/Berlin',
  paused: false,
  owner_identity: 'ada@example.com',
  owner_login: 'ada',
  // A bigint comes back from pg as a string.
  owner_github_id: '4242',
  created_by: 'ada@example.com',
  updated_by: 'ada@example.com',
  created_at: new Date('2026-11-26T10:00:00.000Z'),
  updated_at: new Date('2026-11-26T10:00:00.000Z'),
  next_run_at: NEXT,
  last_run_at: null,
  last_request_id: null,
  last_request_state: null,
  last_outcome: null,
  last_skip_reason: null,
};

const FIELDS = {
  repoId: 'repo-1',
  text: 'Review the dependencies',
  details: 'One change per pull request.',
  kind: 'chore' as const,
  cadence: { every: 'week' as const, weekday: 1 },
  time: '09:00',
  timeZone: 'Europe/Berlin',
};
const OWNER = { identity: 'ada@example.com', login: 'ada', githubId: 4242 };

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(queryOne).mockReset();
});

describe('a routine kept in the database', () => {
  it('is written with its owner and next run, and read back whole through a fresh query, as after a restart', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(ROW);
    const created = await create({ ...FIELDS, owner: OWNER, by: 'ada@example.com', nextRunAt: NEXT });
    const [sql, params] = vi.mocked(queryOne).mock.calls[0] ?? [];
    expect(String(sql)).toMatch(/insert into routines/);
    expect(params).toEqual(['repo-1', 'Review the dependencies', 'One change per pull request.', 'chore', 'weekly', 1, '09:00', 'Europe/Berlin', 'ada@example.com', 'ada', 4242, 'ada@example.com', NEXT]);

    // The store holds nothing in memory: a read is a query of the row.
    vi.mocked(queryOne).mockResolvedValueOnce(ROW);
    const read = await get(ID);
    expect(String(vi.mocked(queryOne).mock.calls[1]?.[0])).toMatch(/from routines t\s+join repos r/);
    expect(read).toEqual(created);
    expect(read).toEqual({
      id: ID,
      repoId: 'repo-1',
      repo: 'app',
      repoFullName: 'acme/app',
      text: 'Review the dependencies',
      details: 'One change per pull request.',
      kind: 'chore',
      cadence: { every: 'week', weekday: 1 },
      time: '09:00',
      timeZone: 'Europe/Berlin',
      paused: false,
      owner: OWNER,
      createdBy: 'ada@example.com',
      updatedBy: 'ada@example.com',
      createdAt: '2026-11-26T10:00:00.000Z',
      updatedAt: '2026-11-26T10:00:00.000Z',
      nextRunAt: '2026-11-30T08:00:00.000Z',
      lastRunAt: null,
      lastRequestId: null,
      lastRequestState: null,
      lastOutcome: null,
      lastSkipReason: null,
    });
  });

  it('keeps each cadence in its two columns', async () => {
    vi.mocked(queryOne).mockResolvedValue({ ...ROW, cadence: 'daily', cadence_day: null });
    expect((await create({ ...FIELDS, cadence: { every: 'day' }, owner: OWNER, by: 'x', nextRunAt: NEXT })).cadence).toEqual({ every: 'day' });
    expect(vi.mocked(queryOne).mock.calls[0]?.[1]?.slice(4, 6)).toEqual(['daily', null]);

    vi.mocked(queryOne).mockResolvedValue({ ...ROW, cadence: 'monthly', cadence_day: 31 });
    expect((await create({ ...FIELDS, cadence: { every: 'month', day: 31 }, owner: OWNER, by: 'x', nextRunAt: NEXT })).cadence).toEqual({ every: 'month', day: 31 });
    expect(vi.mocked(queryOne).mock.calls[1]?.[1]?.slice(4, 6)).toEqual(['monthly', 31]);
  });

  it('makes whoever edits it its owner, and leaves a paused one without a next run', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ ...ROW, owner_login: 'bea', owner_github_id: '7', owner_identity: 'bea@example.com', updated_by: 'bea@example.com' });
    const edited = await update(ID, { ...FIELDS, owner: { identity: 'bea@example.com', login: 'bea', githubId: 7 }, by: 'bea@example.com', nextRunAt: NEXT });
    expect(edited?.owner).toEqual({ identity: 'bea@example.com', login: 'bea', githubId: 7 });
    const sql = String(vi.mocked(queryOne).mock.calls[0]?.[0]);
    expect(sql).toMatch(/owner_identity = \$10, owner_login = \$11, owner_github_id = \$12, updated_by = \$13/);
    expect(sql).toMatch(/next_run_at = case when paused then null else \$14::timestamptz end/);
  });

  it('pauses with no next run, and resumes with one', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ ...ROW, paused: true, next_run_at: null });
    expect(await setPaused(ID, true, NEXT, 'ada@example.com')).toMatchObject({ paused: true, nextRunAt: null });
    // Paused, whatever next run was given, none is written.
    expect(vi.mocked(queryOne).mock.calls[0]?.[1]).toEqual([ID, true, null, 'ada@example.com']);

    vi.mocked(queryOne).mockResolvedValueOnce(ROW);
    expect(await setPaused(ID, false, NEXT, 'ada@example.com')).toMatchObject({ paused: false, nextRunAt: NEXT.toISOString() });
    expect(vi.mocked(queryOne).mock.calls[1]?.[1]).toEqual([ID, false, NEXT, 'ada@example.com']);
  });

  it('is deleted alone, and says so', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ id: ID }]);
    expect(await remove(ID)).toBe(true);
    expect(String(vi.mocked(query).mock.calls[0]?.[0])).toBe('delete from routines where id = $1 returning id');
    vi.mocked(query).mockResolvedValueOnce([]);
    expect(await remove(ID)).toBe(false);
  });

  it('never reaches the database with an id that is not one', async () => {
    expect(await get('nope')).toBeNull();
    expect(await remove("x' or 1=1")).toBe(false);
    expect(await setPaused('nope', true, null, 'x')).toBeNull();
    expect(await update('nope', { ...FIELDS, owner: OWNER, by: 'x', nextRunAt: NEXT })).toBeNull();
    expect(query).not.toHaveBeenCalled();
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('lists every routine with its repository and its last request’s state', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ ...ROW, last_request_id: REQUEST, last_request_state: 'draft', last_outcome: 'filed' }]);
    expect(await list()).toMatchObject([{ repo: 'app', lastRequestId: REQUEST, lastRequestState: 'draft', lastOutcome: 'filed' }]);
    expect(String(vi.mocked(query).mock.calls[0]?.[0])).toMatch(/left join requests q on q.id = t.last_request_id/);
  });
});

describe('the routines that fall due', () => {
  it('are the unpaused ones whose next run has come, in repositories the install still manages', async () => {
    const now = new Date('2026-11-30T08:00:30.000Z');
    vi.mocked(query).mockResolvedValueOnce([ROW]);
    expect(await due(now)).toHaveLength(1);
    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toMatch(/where not t.paused and t.next_run_at <= \$1 and r.removed_at is null/);
    expect(params).toEqual([now]);
  });

  it('are claimed by a conditional update, so of two ticks only the one that read the slot gets it', async () => {
    const after = new Date('2026-12-07T08:00:00.000Z');
    vi.mocked(query).mockResolvedValueOnce([{ id: ID }]).mockResolvedValueOnce([]);
    expect(await claimSlot(ID, NEXT, after)).toBe(true);
    // The second tick read the same slot; the row has moved on, so its update matches nothing.
    expect(await claimSlot(ID, NEXT, after)).toBe(false);
    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toBe('update routines set next_run_at = $3 where id = $1 and not paused and next_run_at = $2 returning id');
    expect(params).toEqual([ID, NEXT, after]);
  });

  it('record a filed run with its request and no skip, and a skip without losing the request filed before', async () => {
    vi.mocked(query).mockResolvedValue([]);
    const at = new Date('2026-11-30T08:00:30.000Z');
    await recordRun(ID, { at, outcome: 'filed', requestId: REQUEST });
    await recordRun(ID, { at, outcome: 'skipped', skipReason: 'Work is paused: a person paused it' });
    const sql = String(vi.mocked(query).mock.calls[0]?.[0]);
    expect(sql).toMatch(/last_request_id = case when \$3 = 'filed' then \$4::uuid else last_request_id end/);
    expect(sql).toMatch(/last_skip_reason = case when \$3 = 'filed' then null else \$5 end/);
    expect(vi.mocked(query).mock.calls[0]?.[1]).toEqual([ID, at, 'filed', REQUEST, null]);
    expect(vi.mocked(query).mock.calls[1]?.[1]).toEqual([ID, at, 'skipped', null, 'Work is paused: a person paused it']);
  });
});

describe('whether the request a routine filed last is still open', () => {
  const answer = (row: { state: string; open_link?: boolean; unlinked_issue?: boolean } | null) =>
    vi.mocked(queryOne).mockResolvedValueOnce(row ? { open_link: false, unlinked_issue: false, ...row } : null);

  it('is open while it is queued, a draft or waits on questions', async () => {
    for (const state of ['queued', 'draft', 'questions']) {
      answer({ state });
      expect(await previousOpen(REQUEST)).toBe(true);
    }
  });

  it('is open once filed while an issue or pull request of its item is open, and closed once none is', async () => {
    answer({ state: 'filed', open_link: true });
    expect(await previousOpen(REQUEST)).toBe(true);
    answer({ state: 'filed', open_link: false });
    expect(await previousOpen(REQUEST)).toBe(false);
  });

  it('counts a filed issue the board has no row for yet as open', async () => {
    answer({ state: 'filed', unlinked_issue: true });
    expect(await previousOpen(REQUEST)).toBe(true);
  });

  it('is not open once abandoned, or once it is gone', async () => {
    answer({ state: 'abandoned', open_link: true });
    expect(await previousOpen(REQUEST)).toBe(false);
    answer(null);
    expect(await previousOpen(REQUEST)).toBe(false);
  });

  it('reads the item’s links from the bridge’s own records', async () => {
    answer({ state: 'filed' });
    await previousOpen(REQUEST);
    const sql = String(vi.mocked(queryOne).mock.calls[0]?.[0]);
    expect(sql).toMatch(/join work_item_links l on l.work_item_id = mine.work_item_id/);
    expect(sql).toMatch(/l.kind in \('issue', 'pull'\) and l.state = 'open'/);
  });
});

describe('0174, routines', () => {
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../migrations/0174_routines.sql'), 'utf8');

  it('holds a weekly or monthly day to its cadence, and a time of day to 00:00–23:59', () => {
    // A null day is refused outright: `null between 1 and 7` is null, which a check passes.
    expect(sql).toMatch(/when 'weekly' then cadence_day is not null and cadence_day between 1 and 7/);
    expect(sql).toMatch(/when 'monthly' then cadence_day is not null and cadence_day between 1 and 31/);
    expect(sql).toMatch(/when 'daily' then cadence_day is null/);
    expect(sql).toContain("check (time_of_day ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')");
  });

  it('has no next run exactly while paused', () => {
    expect(sql).toMatch(/check \(paused = \(next_run_at is null\)\)/);
  });

  it('adds a nullable pointer on requests that a deleted routine clears, and backfills nothing', () => {
    expect(sql).toMatch(/alter table requests add column if not exists routine_id uuid references routines\(id\) on delete set null;/);
    const statements = sql.replace(/--.*$/gm, '');
    expect(statements).not.toMatch(/\bupdate\b/i);
  });
});
