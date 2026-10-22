import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A database as far as the work items go: the sequence, which a rollback does
 * not wind back, the two unique indexes on links, a rollback of everything
 * else, and the advisory lock, held until the transaction ends.
 */
const db = vi.hoisted(() => {
  type Item = { id: string; number: number; merged_into: string | null };
  type Link = {
    id: number;
    work_item_id: string;
    kind: string;
    repo_id: string | null;
    number: number | null;
    request_id: string | null;
    linked_by: string | null;
    title: string;
    state: string;
    url: string | null;
    opened_at: string;
  };
  type Backfill = { id: number; repo_id: string | null; issues_page: number; pulls_page: number; read_at: Date | null; numbered_at: Date | null; caught_up_at: Date | null; last_error: string | null };
  type BackfillRow = { repo_id: string; number: number; kind: string; title: string; state: string; url: string; opened_at: string; head_ref: string | null; head_repo: string | null; base_ref: string | null; closes: number[] };
  type State = {
    items: Item[];
    links: Link[];
    backfill: Backfill[];
    rows: BackfillRow[];
    repos: { id: string; full_name: string }[];
    issues: { repo_id: string; number: number; title: string; stage: string; url: string | null; created_at: Date }[];
    requests: { id: string; repo_id: string | null; issue_number: number | null; text: string; state: string; created_at: Date }[];
  };
  const empty = (): State => ({ items: [], links: [], backfill: [], rows: [], repos: [], issues: [], requests: [] });
  const fake = {
    state: empty(),
    seq: 0,
    linkSeq: 0,
    sent: [] as string[],
    tail: Promise.resolve() as Promise<void>,
    reset() {
      fake.state = empty();
      fake.seq = 0;
      fake.linkSeq = 0;
      fake.sent = [];
      fake.tail = Promise.resolve();
    },
    unique(constraint: string): Error {
      return Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), { code: '23505', constraint });
    },
    async exec(raw: string, params: unknown[] = [], tx?: { release?: () => void }): Promise<{ rows: unknown[] }> {
      const text = raw.replace(/\s+/g, ' ').trim();
      fake.sent.push(text);
      const s = fake.state;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = params as any[];
      if (/pg_advisory_xact_lock/.test(text)) {
        if (!tx) throw new Error('an advisory transaction lock outside a transaction does nothing');
        const before = fake.tail;
        let release!: () => void;
        fake.tail = new Promise<void>((resolve) => (release = resolve));
        tx.release = release;
        await before;
        return { rows: [] };
      }
      if (text === 'select numbered_at from work_item_backfill where repo_id is null') {
        return { rows: s.backfill.filter((row) => row.repo_id === null) };
      }
      if (text === 'select numbered_at from work_item_backfill where repo_id = $1') {
        return { rows: s.backfill.filter((row) => row.repo_id === p[0]) };
      }
      if (text === 'select id, number, merged_into from work_items where id = $1') {
        return { rows: s.items.filter((item) => item.id === p[0]).map((item) => ({ ...item })) };
      }
      if (/^select id, work_item_id, linked_by, kind from work_item_links where request_id = \$1$/.test(text)) {
        return { rows: s.links.filter((link) => link.request_id === p[0]).map((link) => ({ ...link })) };
      }
      if (/^select id, work_item_id, linked_by, kind from work_item_links where repo_id = \$1 and number = \$2$/.test(text)) {
        return { rows: s.links.filter((link) => link.repo_id === p[0] && link.number === p[1]).map((link) => ({ ...link })) };
      }
      if (/^insert into work_items \(number\) values \(nextval/.test(text)) {
        fake.seq += 1;
        const item = { id: `item-${fake.seq}`, number: fake.seq, merged_into: null };
        s.items.push(item);
        return { rows: [{ ...item, number: String(item.number) }] };
      }
      if (/^insert into work_item_links/.test(text)) {
        const [work_item_id, kind, repo_id, number, request_id, linked_by, title, state, url, opened_at] = p;
        if (repo_id !== null && s.links.some((link) => link.repo_id === repo_id && link.number === number)) throw fake.unique('work_item_links_thing');
        if (request_id !== null && s.links.some((link) => link.request_id === request_id)) throw fake.unique('work_item_links_request');
        fake.linkSeq += 1;
        s.links.push({ id: fake.linkSeq, work_item_id, kind, repo_id, number, request_id, linked_by, title, state, url, opened_at });
        return { rows: [] };
      }
      if (/^update work_item_links set title = \$2/.test(text)) {
        const link = s.links.find((one) => one.id === p[0])!;
        link.title = p[1];
        if (link.state !== 'merged') link.state = p[2];
        link.url = p[3] ?? link.url;
        return { rows: [] };
      }
      if (text === 'update work_item_links set work_item_id = $2 where id = $1') {
        s.links.find((one) => one.id === p[0])!.work_item_id = p[1];
        return { rows: [] };
      }
      if (text === 'update work_item_links set work_item_id = $2 where work_item_id = $1') {
        for (const link of s.links) if (link.work_item_id === p[0]) link.work_item_id = p[1];
        return { rows: [] };
      }
      if (/^select count\(\*\)::int as links from work_item_links where work_item_id = \$1$/.test(text)) {
        return { rows: [{ links: s.links.filter((link) => link.work_item_id === p[0]).length }] };
      }
      if (/count\(\*\) filter \(where kind = 'issue'\)/.test(text)) {
        const of = s.links.filter((link) => link.work_item_id === p[0]);
        return { rows: [{ issues: of.filter((link) => link.kind === 'issue').length, by_hand: of.filter((link) => link.linked_by !== null).length }] };
      }
      if (text === 'update work_items set merged_into = $2 where id = $1') {
        s.items.find((item) => item.id === p[0])!.merged_into = p[1];
        return { rows: [] };
      }
      if (/^insert into work_item_backfill_rows/.test(text)) {
        const [repo_id, number, kind, title, state, url, opened_at, head_ref, head_repo, base_ref, closes] = p;
        const at = s.rows.find((row) => row.repo_id === repo_id && row.number === number);
        if (at) Object.assign(at, { title, state, url, head_ref: head_ref ?? at.head_ref, head_repo: head_repo ?? at.head_repo, base_ref: base_ref ?? at.base_ref, closes: (closes as number[]).length ? closes : at.closes });
        else s.rows.push({ repo_id, number, kind, title, state, url, opened_at, head_ref, head_repo, base_ref, closes });
        return { rows: [] };
      }
      if (/^insert into work_item_backfill \(repo_id\) values \(\$1\)/.test(text)) {
        if (!s.backfill.some((row) => row.repo_id === p[0])) {
          s.backfill.push({ id: s.backfill.length + 1, repo_id: p[0], issues_page: 1, pulls_page: 1, read_at: null, numbered_at: null, caught_up_at: null, last_error: null });
        }
        return { rows: [] };
      }
      if (/^update work_item_backfill set (issues_page|pulls_page) = \$2, last_error = null where repo_id = \$1$/.test(text)) {
        const row = s.backfill.find((one) => one.repo_id === p[0])!;
        if (text.includes('issues_page')) row.issues_page = Number(params[1]);
        else row.pulls_page = Number(params[1]);
        row.last_error = null;
        return { rows: [] };
      }
      if (/^update work_item_backfill set read_at = now\(\)/.test(text)) {
        s.backfill.find((one) => one.repo_id === p[0])!.read_at = new Date();
        return { rows: [] };
      }
      if (/^select repo_id from work_item_backfill where repo_id is not null and read_at is not null and numbered_at is null$/.test(text)) {
        return { rows: s.backfill.filter((row) => row.repo_id && row.read_at && !row.numbered_at) };
      }
      if (/^select b\.kind/.test(text)) {
        const ready = p[0] as unknown as string[];
        const linkedThing = (repo: string | null, number: number | null) => s.links.some((link) => link.repo_id === repo && link.number === number);
        const fullName = (id: string | null) => s.repos.find((repo) => repo.id === id)?.full_name ?? null;
        const fromRows = s.rows
          .filter((row) => ready.includes(row.repo_id) && !linkedThing(row.repo_id, row.number))
          .map((row) => ({ ...row, repo_full_name: fullName(row.repo_id), request_id: null, issue_number: null, item_id: null, opened_at: new Date(row.opened_at) }));
        const fromIssues = s.issues
          .filter((issue) => ready.includes(issue.repo_id) && !s.rows.some((row) => row.repo_id === issue.repo_id && row.number === issue.number) && !linkedThing(issue.repo_id, issue.number))
          .map((issue) => ({
            kind: 'issue', repo_id: issue.repo_id, repo_full_name: fullName(issue.repo_id), number: issue.number, request_id: null, issue_number: null, item_id: null,
            title: issue.title, state: ['merged', 'done'].includes(issue.stage) ? 'closed' : 'open', url: issue.url, opened_at: issue.created_at,
            head_ref: null, head_repo: null, base_ref: null, closes: null,
          }));
        const fromRequests = s.requests
          .map((request) => ({ request, link: s.links.find((link) => link.request_id === request.id) }))
          .filter(({ request, link }) => !link || (request.issue_number !== null && ready.includes(request.repo_id!) && !linkedThing(request.repo_id, request.issue_number)))
          .map(({ request, link }) => ({
            kind: 'request', repo_id: request.repo_id, repo_full_name: null, number: null, request_id: request.id, issue_number: request.issue_number, item_id: link?.work_item_id ?? null,
            title: request.text, state: request.state === 'abandoned' ? 'closed' : 'open', url: null, opened_at: request.created_at,
            head_ref: null, head_repo: null, base_ref: null, closes: null,
          }));
        return { rows: [...fromRows, ...fromIssues, ...fromRequests] };
      }
      if (/^select repo_id, number, work_item_id from work_item_links where kind = 'issue'/.test(text)) {
        const ready = p[0] as unknown as string[];
        return { rows: s.links.filter((link) => link.kind === 'issue' && ready.includes(link.repo_id!)) };
      }
      if (/^delete from work_item_backfill_rows where repo_id = any/.test(text)) {
        const ready = p[0] as unknown as string[];
        s.rows = s.rows.filter((row) => !ready.includes(row.repo_id));
        return { rows: [] };
      }
      if (/^update work_item_backfill set numbered_at = now\(\) where repo_id = any/.test(text)) {
        const ready = p[0] as unknown as string[];
        for (const row of s.backfill) if (row.repo_id && ready.includes(row.repo_id)) row.numbered_at = new Date();
        return { rows: [] };
      }
      if (/^insert into work_item_backfill \(repo_id, numbered_at\) values \(null, now\(\)\)/.test(text)) {
        const install = s.backfill.find((row) => row.repo_id === null);
        if (install) install.numbered_at ??= new Date();
        else s.backfill.push({ id: s.backfill.length + 1, repo_id: null, issues_page: 1, pulls_page: 1, read_at: null, numbered_at: new Date(), caught_up_at: null, last_error: null });
        return { rows: [] };
      }
      if (/^select l\.work_item_id from requests q join work_item_links l on l\.request_id = q\.id/.test(text)) {
        const first = s.requests
          .filter((request) => request.repo_id === p[0] && request.issue_number === p[1] && request.id !== p[2])
          .sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id))
          .map((request) => s.links.find((link) => link.request_id === request.id))
          .find(Boolean);
        return { rows: first ? [{ work_item_id: first.work_item_id }] : [] };
      }
      if (/^select l\.kind = 'pull' and l\.linked_by is null/.test(text)) {
        const link = s.links.find((one) => one.repo_id === p[0] && one.number === p[1]);
        if (!link) return { rows: [] };
        const alone = link.kind === 'pull' && link.linked_by === null && !s.links.some((other) => other.work_item_id === link.work_item_id && other.kind === 'issue');
        return { rows: [{ alone }] };
      }
      throw new Error(`the fake database does not know: ${text}`);
    },
    async transaction<T>(fn: (client: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<T>): Promise<T> {
      const saved = structuredClone(fake.state);
      const tx: { release?: () => void } = {};
      try {
        return await fn({ query: (text, params) => fake.exec(text, params, tx) });
      } catch (error) {
        // Everything but the sequence goes back.
        fake.state = saved;
        throw error;
      } finally {
        tx.release?.();
      }
    },
  };
  return fake;
});

vi.mock('../client.js', () => ({
  query: vi.fn(async (text: string, params?: unknown[]) => (await db.exec(text, params)).rows),
  queryOne: vi.fn(async (text: string, params?: unknown[]) => (await db.exec(text, params)).rows[0] ?? null),
  withTransaction: vi.fn((fn: never) => db.transaction(fn)),
}));

import { withTransaction } from '../client.js';
import {
  ensureLink,
  firstFiledItem,
  isNumbered,
  itemOf,
  markRead,
  mergeInto,
  numberPending,
  saveBackfillPage,
  standsAlone,
  startBackfill,
  type Pending,
  type Plan,
  type Snapshot,
} from './work-items.js';

const REPO = 'repo-1';
const snap = (title: string, openedAt = '2026-10-01T00:00:00.000Z', state: Snapshot['state'] = 'open'): Snapshot => ({ title, state, url: `https://github.test/${title}`, openedAt });

/** Each pending thing its own item, in opened order. */
const alone: Plan = (pending) =>
  [...pending].sort((a, b) => a.openedAt.localeCompare(b.openedAt)).map((member: Pending) => ({ members: [member], claim: null }));

/** An install whose first numbering has committed, with `REPO` numbered. */
function numbered() {
  db.state.backfill.push(
    { id: 1, repo_id: null, issues_page: 1, pulls_page: 1, read_at: null, numbered_at: new Date(), caught_up_at: null, last_error: null },
    { id: 2, repo_id: REPO, issues_page: 1, pulls_page: 1, read_at: new Date(), numbered_at: new Date(), caught_up_at: null, last_error: null },
  );
}

beforeEach(() => {
  db.reset();
  vi.mocked(withTransaction).mockClear();
});

describe('a work item number', () => {
  beforeEach(numbered);

  it('taken by a transaction that rolled back is never handed out', async () => {
    await expect(
      withTransaction(async (client) => {
        await ensureLink({ repoId: REPO, number: 1, kind: 'issue' }, snap('first'), null, client);
        throw new Error('the delivery failed after it');
      }),
    ).rejects.toThrow('the delivery failed after it');
    expect(db.state.items).toEqual([]);

    const next = await ensureLink({ repoId: REPO, number: 1, kind: 'issue' }, snap('first'), null);
    expect(next?.number).toBe(2);
  });

  it('of an item merged into another, or emptied by a moved pull request, stays with it and is not handed out again', async () => {
    const request = await ensureLink({ requestId: 'req-1' }, snap('a request'), null);
    const issue = await ensureLink({ repoId: REPO, number: 5, kind: 'issue' }, snap('its issue'), null);
    expect(await mergeInto(issue!.id, request!.id)).toBe(true);
    expect(db.state.items.find((item) => item.id === issue!.id)).toEqual({ id: issue!.id, number: 2, merged_into: request!.id });
    expect((await itemOf({ repoId: REPO, number: 5 }))?.number).toBe(1);

    const pull = await ensureLink({ repoId: REPO, number: 9, kind: 'pull' }, snap('a pull request'), null);
    expect(pull?.number).toBe(3);
    // Its body now closes #5: the link moves, and the item it left points where it went.
    expect((await ensureLink({ repoId: REPO, number: 9, kind: 'pull' }, snap('a pull request'), issue!.id))?.number).toBe(1);
    expect(db.state.items.find((item) => item.id === pull!.id)?.merged_into).toBe(request!.id);

    expect((await ensureLink({ repoId: REPO, number: 10, kind: 'issue' }, snap('next'), null))?.number).toBe(4);
    expect(db.state.items).toHaveLength(4);
  });
});

describe('a link', () => {
  beforeEach(numbered);

  it('is made once, and a second sighting refreshes its title and state', async () => {
    const first = await ensureLink({ repoId: REPO, number: 3, kind: 'issue' }, snap('old title'), null);
    const again = await ensureLink({ repoId: REPO, number: 3, kind: 'issue' }, snap('new title', undefined, 'closed'), null);
    expect(again).toEqual(first);
    expect(db.state.links).toHaveLength(1);
    expect(db.state.links[0]).toMatchObject({ title: 'new title', state: 'closed' });
  });

  it('is made once when two deliveries for the same thing arrive together', async () => {
    const [a, b, c] = await Promise.all([
      ensureLink({ repoId: REPO, number: 4, kind: 'pull' }, snap('pr'), null),
      ensureLink({ repoId: REPO, number: 4, kind: 'pull' }, snap('pr'), null),
      ensureLink({ requestId: 'req-2' }, snap('request'), null),
    ]);
    expect(a).toEqual(b);
    expect(c?.number).not.toBe(a?.number);
    expect(db.state.links).toHaveLength(2);
    expect(db.state.items).toHaveLength(2);
  });

  it('of a merged pull request stays merged when the sweep reads it as closed', async () => {
    await ensureLink({ repoId: REPO, number: 4, kind: 'pull' }, snap('pr', undefined, 'merged'), null);
    await ensureLink({ repoId: REPO, number: 4, kind: 'pull' }, snap('pr', undefined, 'closed'), null);
    expect(db.state.links[0]?.state).toBe('merged');
  });

  it('a person made is never moved, and an issue’s never moves automatically', async () => {
    const target = await ensureLink({ repoId: REPO, number: 5, kind: 'issue' }, snap('#5'), null);
    const own = await ensureLink({ repoId: REPO, number: 9, kind: 'pull' }, snap('pr'), null);
    db.state.links.find((link) => link.number === 9)!.linked_by = 'alex';
    expect(await ensureLink({ repoId: REPO, number: 9, kind: 'pull' }, snap('pr'), target!.id)).toEqual(own);

    const issue = await ensureLink({ repoId: REPO, number: 6, kind: 'issue' }, snap('#6'), null);
    expect(await ensureLink({ repoId: REPO, number: 6, kind: 'issue' }, snap('#6'), target!.id)).toEqual(issue);
  });
});

describe('merging two items', () => {
  beforeEach(numbered);

  it('is refused when each holds an issue, or when the one merged holds a person’s link', async () => {
    const a = await ensureLink({ repoId: REPO, number: 1, kind: 'issue' }, snap('#1'), null);
    const b = await ensureLink({ repoId: REPO, number: 2, kind: 'issue' }, snap('#2'), null);
    expect(await mergeInto(a!.id, b!.id)).toBe(false);

    const request = await ensureLink({ requestId: 'req-1' }, snap('request'), null);
    db.state.links.find((link) => link.request_id === 'req-1')!.linked_by = 'alex';
    expect(await mergeInto(request!.id, a!.id)).toBe(false);
    expect(db.state.items.every((item) => item.merged_into === null)).toBe(true);
  });
});

describe('a repository added after the first numbering', () => {
  const LATER = 'repo-later';
  /** Every request with an item already, and the issue they were filed as, in one group: as the bridge's plan groups them. */
  const together: Plan = (pending) => {
    const earliest = pending
      .filter((member): member is Extract<Pending, { kind: 'request' }> => member.kind === 'request' && member.itemId !== null)
      .sort((a, b) => a.openedAt.localeCompare(b.openedAt))[0];
    return [{ members: pending, claim: earliest?.itemId ?? null }];
  };

  beforeEach(() => {
    numbered();
    db.state.repos.push({ id: LATER, full_name: 'acme/later' });
  });

  it('puts two requests numbered live and filed as one of its issues on the earlier request’s item when it is numbered', async () => {
    const first = await ensureLink({ requestId: 'req-1' }, snap('first'), null);
    const second = await ensureLink({ requestId: 'req-2' }, snap('second'), null);
    db.state.requests.push(
      { id: 'req-1', repo_id: LATER, issue_number: 4, text: 'first', state: 'filed', created_at: new Date('2026-10-01T00:00:00.000Z') },
      { id: 'req-2', repo_id: LATER, issue_number: 4, text: 'second', state: 'filed', created_at: new Date('2026-10-02T00:00:00.000Z') },
    );
    expect((await firstFiledItem(LATER, 4, 'req-2'))?.id).toBe(first!.id);
    await startBackfill(LATER);
    await saveBackfillPage(LATER, 'issues', 2, [{ number: 4, kind: 'issue', title: '#4', state: 'open', url: 'u4', openedAt: '2026-10-01T00:00:00.000Z' }]);
    await markRead(LATER);

    await numberPending(together);
    expect((await itemOf({ requestId: 'req-1' }))?.id).toBe(first!.id);
    expect((await itemOf({ requestId: 'req-2' }))?.id).toBe(first!.id);
    expect((await itemOf({ repoId: LATER, number: 4 }))?.id).toBe(first!.id);
    // The later request's item keeps its number, and points where it went.
    expect(db.state.items.find((one) => one.id === second!.id)).toMatchObject({ number: 2, merged_into: first!.id });
  });

  it('leaves a request a person linked where they put it', async () => {
    const first = await ensureLink({ requestId: 'req-1' }, snap('first'), null);
    const second = await ensureLink({ requestId: 'req-2' }, snap('second'), null);
    db.state.links.find((link) => link.request_id === 'req-2')!.linked_by = 'alex';
    db.state.requests.push(
      { id: 'req-1', repo_id: LATER, issue_number: 4, text: 'first', state: 'filed', created_at: new Date('2026-10-01T00:00:00.000Z') },
      { id: 'req-2', repo_id: LATER, issue_number: 4, text: 'second', state: 'filed', created_at: new Date('2026-10-02T00:00:00.000Z') },
    );
    await startBackfill(LATER);
    await saveBackfillPage(LATER, 'issues', 2, [{ number: 4, kind: 'issue', title: '#4', state: 'open', url: 'u4', openedAt: '2026-10-01T00:00:00.000Z' }]);
    await markRead(LATER);

    await numberPending(together);
    expect((await itemOf({ repoId: LATER, number: 4 }))?.id).toBe(first!.id);
    expect((await itemOf({ requestId: 'req-2' }))?.id).toBe(second!.id);
  });
});

describe('a pull request standing alone', () => {
  beforeEach(numbered);

  it('is one whose automatic link is on an item with no issue', async () => {
    await ensureLink({ repoId: REPO, number: 9, kind: 'pull' }, snap('pr'), null);
    expect(await standsAlone({ repoId: REPO, number: 9 })).toBe(true);

    const issue = await ensureLink({ repoId: REPO, number: 5, kind: 'issue' }, snap('#5'), null);
    await ensureLink({ repoId: REPO, number: 10, kind: 'pull' }, snap('pr'), issue!.id);
    expect(await standsAlone({ repoId: REPO, number: 10 })).toBe(false);

    db.state.links.find((link) => link.number === 9)!.linked_by = 'alex';
    expect(await standsAlone({ repoId: REPO, number: 9 })).toBe(false);
    expect(await standsAlone({ repoId: REPO, number: 99 })).toBe(false);
  });
});

describe('before the first numbering', () => {
  it('a delivery or a new request draws no number, and the history numbering gives them one in opened order', async () => {
    expect(await isNumbered()).toBe(false);
    db.state.repos.push({ id: REPO, full_name: 'acme/app' });
    await startBackfill(REPO);

    expect(await ensureLink({ repoId: REPO, number: 7, kind: 'issue' }, snap('#7', '2026-10-03T00:00:00.000Z'), null)).toBeNull();
    expect(await ensureLink({ requestId: 'req-1' }, snap('request'), null)).toBeNull();
    db.state.requests.push({ id: 'req-1', repo_id: null, issue_number: null, text: 'Add a dark mode\nso it is easier at night', state: 'draft', created_at: new Date('2026-10-02T00:00:00.000Z') });
    expect(db.state.items).toEqual([]);

    // The delivery is kept for the history numbering, beside what the read found.
    expect(db.state.rows.map((row) => row.number)).toEqual([7]);
    await saveBackfillPage(REPO, 'issues', 2, [{ number: 1, kind: 'issue', title: '#1', state: 'closed', url: 'u1', openedAt: '2026-09-01T00:00:00.000Z' }]);
    expect(db.state.backfill.find((row) => row.repo_id === REPO)?.issues_page).toBe(2);
    await markRead(REPO);

    expect(await numberPending(alone)).toMatchObject({ items: 3, links: 3, repos: [REPO] });
    expect(await isNumbered()).toBe(true);
    expect((await itemOf({ repoId: REPO, number: 1 }))?.number).toBe(1);
    expect((await itemOf({ requestId: 'req-1' }))?.number).toBe(2);
    expect((await itemOf({ repoId: REPO, number: 7 }))?.number).toBe(3);
    expect(db.state.links.find((link) => link.request_id === 'req-1')?.title).toBe('Add a dark mode');
    expect(db.state.rows).toEqual([]);
  });
});
