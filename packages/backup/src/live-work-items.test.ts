import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A database as far as work items go in a backup: repositories, requests,
 * work items and their links, and the sequence. The backup's reads go through
 * `query`, the restore's through the transaction's client; both land here.
 */
const db = vi.hoisted(() => {
  type Item = { id: string; number: number; merged_into: string | null };
  type Link = { id: number; work_item_id: string; kind: string; repo_id: string | null; number: number | null; request_id: string | null; linked_by: string | null; title: string; state: string; url: string | null; opened_at: string };
  const state = {
    repos: [] as { id: string; full_name: string; removed_at: string | null }[],
    requests: [] as string[],
    items: [] as Item[],
    links: [] as Link[],
    seq: { last_value: 1, is_called: false },
  };
  const exec = async (raw: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> => {
    const text = raw.replace(/\s+/g, ' ').trim();
    const ok = (rows: Record<string, unknown>[] = []) => ({ rows, rowCount: rows.length });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = params as any[];
    if (text === 'select id, number, merged_into from work_items order by number') return ok([...state.items].sort((a, b) => a.number - b.number));
    if (text.startsWith('select l.work_item_id, l.kind, r.full_name as repo')) {
      return ok(state.links.map((link) => ({ ...link, repo: state.repos.find((repo) => repo.id === link.repo_id)?.full_name ?? null })));
    }
    if (text === 'select id, full_name from repos where removed_at is null') return ok(state.repos.filter((repo) => !repo.removed_at));
    if (text === 'select id from work_items where id = $1') return ok(state.items.filter((item) => item.id === p[0]));
    if (text.startsWith('select 1 from requests q where q.id = $1')) {
      return ok(state.requests.includes(p[0]) && !state.links.some((link) => link.request_id === p[0]) ? [{ one: 1 }] : []);
    }
    if (text === 'select 1 from work_item_links where repo_id = $1 and number = $2') {
      return ok(state.links.filter((link) => link.repo_id === p[0] && link.number === p[1]));
    }
    if (text === 'select 1 from work_items where number = $1') return ok(state.items.filter((item) => item.number === p[0]));
    if (text.startsWith("insert into work_items (id, number) values ($1, nextval('work_item_number_seq'))")) {
      state.seq.last_value = state.seq.is_called ? state.seq.last_value + 1 : state.seq.last_value;
      state.seq.is_called = true;
      if (state.items.some((item) => item.number === state.seq.last_value)) throw new Error(`work_items_number_key: ${state.seq.last_value} is taken`);
      state.items.push({ id: p[0], number: state.seq.last_value, merged_into: null });
      return ok([{ id: p[0] }]);
    }
    if (text === 'insert into work_items (id, number) values ($1, $2) returning id') {
      if (state.items.some((item) => item.number === p[1])) throw new Error(`work_items_number_key: ${p[1]} is taken`);
      state.items.push({ id: p[0], number: p[1], merged_into: null });
      return ok([{ id: p[0] }]);
    }
    if (text.startsWith('insert into work_item_links')) {
      const [work_item_id, kind, repo_id, number, request_id, linked_by, title, link_state, url, opened_at] = p;
      state.links.push({ id: state.links.length + 1, work_item_id, kind, repo_id, number, request_id, linked_by, title, state: link_state, url, opened_at });
      return ok();
    }
    if (text === 'update work_items set merged_into = $2 where id = $1') {
      state.items.find((item) => item.id === p[0])!.merged_into = p[1];
      return ok();
    }
    if (text.startsWith("select setval('work_item_number_seq', m.top)")) {
      const top = Math.max(0, ...state.items.map((item) => item.number));
      const at = state.seq.is_called ? state.seq.last_value : state.seq.last_value - 1;
      if (top > at) state.seq = { last_value: top, is_called: true };
      return ok();
    }
    if (text === 'delete from work_item_links where work_item_id = any($1::uuid[])') {
      state.links = state.links.filter((link) => !p[0].includes(link.work_item_id));
      return ok();
    }
    if (text.startsWith('update work_items set merged_into = null where merged_into = any')) {
      for (const item of state.items) if (item.merged_into && p[0].includes(item.merged_into) && !p[0].includes(item.id)) item.merged_into = null;
      return ok();
    }
    if (text === 'delete from work_items where id = any($1::uuid[])') {
      state.items = state.items.filter((item) => !p[0].includes(item.id));
      return ok();
    }
    if (/work_item/.test(text)) throw new Error(`the fake database does not know: ${text}`);
    return ok();
  };
  return {
    state,
    exec,
    reset() {
      state.repos = [];
      state.requests = [];
      state.items = [];
      state.links = [];
      state.seq = { last_value: 1, is_called: false };
    },
    nextval() {
      state.seq.last_value = state.seq.is_called ? state.seq.last_value + 1 : state.seq.last_value;
      state.seq.is_called = true;
      return state.seq.last_value;
    },
  };
});

vi.mock('@openadlc/db', () => ({
  bots: { listBots: vi.fn(async () => []) },
  credentials: { listCredentials: vi.fn(async () => []) },
  identities: { listIdentities: vi.fn(async () => []) },
  modelAccounts: { list: vi.fn(async () => []) },
  query: vi.fn(async (text: string, params?: unknown[]) => (await db.exec(text, params)).rows),
  repos: { listRepos: vi.fn(async () => []) },
  settings: { allSettings: vi.fn(async () => ({})) },
  spendingLimits: { listLimits: vi.fn(async () => []) },
  withTransaction: vi.fn(),
}));

import type { ArchivedHistory, ArchivedWorkItem, ArchivedWorkItemLink } from './archive.js';
import { readHistory, restoreDb } from './live.js';

const APP = { id: 'repo-app', full_name: 'acme/app', removed_at: null };
const REQUEST = 'cccccccc-0000-4000-8000-000000000001';
const id = (n: number) => `eeeeeeee-0000-4000-8000-${String(n).padStart(12, '0')}`;

const link = (patch: Partial<ArchivedWorkItemLink>): ArchivedWorkItemLink => ({
  kind: 'issue',
  repo: 'acme/app',
  number: 1,
  requestId: null,
  linkedBy: null,
  title: 'Add a dark mode',
  state: 'open',
  url: 'https://github.com/acme/app/issues/1',
  openedAt: '2026-09-01T09:30:00.000Z',
  ...patch,
});

const history = (workItems?: ArchivedWorkItem[]): ArchivedHistory => ({
  threads: [],
  messages: [],
  audit: [],
  ledger: [],
  requests: [],
  ...(workItems ? { workItems } : {}),
});

/** What a person reads back: each link's item number, kind and thing. */
const numbers = () =>
  db.state.links
    .map((one) => [db.state.items.find((item) => item.id === one.work_item_id)!.number, one.kind, one.number ?? one.request_id] as const)
    .sort((a, b) => a[0] - b[0] || String(a[2]).localeCompare(String(b[2])));

beforeEach(() => db.reset());

describe('restoring work items', () => {
  const ARCHIVE: ArchivedWorkItem[] = [
    {
      id: id(1),
      number: 1,
      mergedInto: null,
      links: [
        link({ kind: 'request', repo: null, number: null, requestId: REQUEST, url: null }),
        link({ kind: 'issue', number: 7 }),
        link({ kind: 'pull', number: 8, state: 'merged', linkedBy: 'janedoe' }),
      ],
    },
    // Merged into #1: no links of its own, kept for its number.
    { id: id(2), number: 2, mergedInto: id(1), links: [] },
    { id: id(4), number: 4, mergedInto: null, links: [link({ number: 9 })] },
    // Only in a repository this install does not manage: left out.
    { id: id(5), number: 5, mergedInto: null, links: [link({ repo: 'acme/elsewhere', number: 3 })] },
  ];

  it('into an empty install reads back the same numbers and merges, with the sequence past them', async () => {
    db.state.repos = [APP];
    db.state.requests = [REQUEST];

    const counts = await restoreDb({ query: db.exec }).putHistory(history(ARCHIVE));

    expect(db.state.items.map((item) => item.number)).toEqual([1, 2, 4]);
    expect(counts).toMatchObject({ workItems: 3, renumbered: 0 });
    expect(counts.ids?.workItems).toEqual([id(1), id(2), id(4)]);
    expect(numbers()).toEqual([
      [1, 'issue', 7],
      [1, 'pull', 8],
      [1, 'request', REQUEST],
      [4, 'issue', 9],
    ]);
    expect(db.state.items.find((item) => item.number === 2)?.merged_into).toBe(id(1));
    expect(db.nextval()).toBe(5);

    // And a backup of it carries them as they were.
    const read = await readHistory();
    expect(read.workItems?.map((item) => [item.number, item.mergedInto, item.links.length])).toEqual([
      [1, null, 3],
      [2, id(1), 0],
      [4, null, 1],
    ]);
    expect(read.workItems?.[0]?.links.find((one) => one.kind === 'pull')).toMatchObject({ repo: 'acme/app', linkedBy: 'janedoe', state: 'merged' });
  });

  it('gives an item whose number is taken here the next free one, counts it, and keeps the sequence past the highest', async () => {
    db.state.repos = [APP];
    db.state.items = [{ id: 'here-1', number: 1, merged_into: null }, { id: 'here-3', number: 3, merged_into: null }];
    db.state.links = [{ id: 1, work_item_id: 'here-3', kind: 'issue', repo_id: APP.id, number: 50, request_id: null, linked_by: null, title: 'x', state: 'open', url: null, opened_at: '2026-01-01' }];
    db.state.seq = { last_value: 3, is_called: true };

    const counts = await restoreDb({ query: db.exec }).putHistory(
      history([
        { id: id(3), number: 3, mergedInto: null, links: [link({ number: 11 })] },
        { id: id(4), number: 4, mergedInto: null, links: [link({ number: 12 })] },
        // Already linked here: nothing of it comes back.
        { id: id(6), number: 6, mergedInto: null, links: [link({ number: 50 })] },
      ]),
    );

    expect(counts).toMatchObject({ workItems: 2, renumbered: 1 });
    // #12 keeps 4, which was free; #11's 3 was taken, so it is 5, past 4.
    expect(numbers()).toEqual([
      [3, 'issue', 50],
      [4, 'issue', 12],
      [5, 'issue', 11],
    ]);
    expect(db.nextval()).toBe(6);
  });

  it('is undone with its links, and the numbers it used are not handed out again', async () => {
    db.state.repos = [APP];
    db.state.requests = [REQUEST];
    const restore = restoreDb({ query: db.exec });
    const counts = await restore.putHistory(history(ARCHIVE));

    await restore.deleteHistory(counts.ids!);

    expect(db.state.items).toEqual([]);
    expect(db.state.links).toEqual([]);
    expect(db.nextval()).toBe(5);
  });

  it('leaves the work items alone for an archive written before them', async () => {
    db.state.repos = [APP];
    const counts = await restoreDb({ query: db.exec }).putHistory(history());
    expect(counts).not.toHaveProperty('workItems');
    expect(counts.ids).not.toHaveProperty('workItems');
    expect(db.state.items).toEqual([]);
  });
});
