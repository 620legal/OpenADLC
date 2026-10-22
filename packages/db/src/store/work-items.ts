import type { PoolClient } from 'pg';
import { query, queryOne, withTransaction } from '../client.js';

/**
 * Work items: the install's own number for every issue, pull request and
 * console request it has seen, and the links that group them. See
 * `migrations/0146_work_items.sql` and docs/adr/0009-work-items.md.
 *
 * Every write runs in one transaction under one advisory transaction lock.
 * Two deliveries for the same pull request, a webhook and the sweep, would
 * otherwise each find no link and each draw an item; one row per delivery is
 * cheap to serialize.
 */

/** What runs a statement: the pool, or a transaction's client. */
export type Sql = Pick<PoolClient, 'query'>;

/** A thing a link names: a request, or an issue or pull request by its repository and number. */
export type ThingRef = { requestId: string } | { repoId: string; number: number };

/** A thing to link, with what kind it is. */
export type Thing = { requestId: string } | { repoId: string; number: number; kind: 'issue' | 'pull' };

export type LinkState = 'open' | 'closed' | 'merged';

/** What the board shows of a linked thing, as last seen. */
export interface Snapshot {
  title: string;
  state: LinkState;
  url: string | null;
  openedAt: string;
  /** A pull request's, kept by the history read until it is numbered. */
  headRef?: string | null;
  headRepo?: string | null;
  baseRef?: string | null;
  closes?: readonly number[];
}

export interface WorkItem {
  id: string;
  number: number;
  mergedInto: string | null;
}

const LOCK = `select pg_advisory_xact_lock(hashtext('work_items'))`;

/** How far `merged_into` is followed: far past any real chain, short of a loop. */
const MOST_HOPS = 64;

interface ItemRow {
  id: string;
  number: string | number;
  merged_into: string | null;
}

function toItem(row: ItemRow): WorkItem {
  return { id: row.id, number: Number(row.number), mergedInto: row.merged_into };
}

/**
 * Runs `fn` holding the work items' lock: inside the caller's transaction
 * when one is given (`createRequest` links in its own), else in one of its own.
 */
async function locked<T>(client: Sql | undefined, fn: (sql: Sql) => Promise<T>): Promise<T> {
  if (client) {
    await client.query(LOCK);
    return fn(client);
  }
  return withTransaction(async (sql) => {
    await sql.query(LOCK);
    return fn(sql);
  });
}

async function one<T extends object>(sql: Sql, text: string, params: unknown[]): Promise<T | null> {
  const result = await sql.query(text, params);
  return (result.rows[0] as T | undefined) ?? null;
}

const pool: Sql = {
  query: (async (text: string, params?: unknown[]) => ({ rows: await query(text, params ?? []) })) as unknown as Sql['query'],
};

/** The item at the end of `merged_into`, from `id`. */
async function resolve(sql: Sql, id: string): Promise<WorkItem | null> {
  let at = id;
  for (let hop = 0; hop < MOST_HOPS; hop += 1) {
    const row = await one<ItemRow>(sql, 'select id, number, merged_into from work_items where id = $1', [at]);
    if (!row) return null;
    if (!row.merged_into) return toItem(row);
    at = row.merged_into;
  }
  throw new Error(`work item ${id} is merged into itself further than ${MOST_HOPS} times; its merged_into makes a loop`);
}

/**
 * Whether live numbering has begun for a thing: for an issue or pull request,
 * once its repository's history was numbered; for a request, once the
 * install's first numbering committed.
 */
async function numberedFor(sql: Sql, thing: ThingRef): Promise<boolean> {
  const row =
    'requestId' in thing
      ? await one<{ numbered_at: Date | null }>(sql, 'select numbered_at from work_item_backfill where repo_id is null', [])
      : await one<{ numbered_at: Date | null }>(sql, 'select numbered_at from work_item_backfill where repo_id = $1', [thing.repoId]);
  return Boolean(row?.numbered_at);
}

/** Whether the install's first numbering has committed: before it, nothing is numbered live. */
export async function isNumbered(): Promise<boolean> {
  const row = await queryOne<{ numbered_at: Date | null }>('select numbered_at from work_item_backfill where repo_id is null');
  return Boolean(row?.numbered_at);
}

interface LinkRow {
  id: string;
  work_item_id: string;
  linked_by: string | null;
  kind: 'issue' | 'pull' | 'request';
}

async function linkOf(sql: Sql, thing: ThingRef): Promise<LinkRow | null> {
  return 'requestId' in thing
    ? one<LinkRow>(sql, 'select id, work_item_id, linked_by, kind from work_item_links where request_id = $1', [thing.requestId])
    : one<LinkRow>(sql, 'select id, work_item_id, linked_by, kind from work_item_links where repo_id = $1 and number = $2', [thing.repoId, thing.number]);
}

/** The item a thing is linked to, following merges to the end; null when it has none. */
export async function itemOf(thing: ThingRef, client?: Sql): Promise<WorkItem | null> {
  const sql = client ?? pool;
  const link = await linkOf(sql, thing);
  return link ? resolve(sql, link.work_item_id) : null;
}

/**
 * Whether a pull request's link is automatic and its item holds no issue:
 * the one whose claim can still change, once its branch's issue has an item.
 */
export async function standsAlone(thing: { repoId: string; number: number }): Promise<boolean> {
  const row = await queryOne<{ alone: boolean }>(
    `select l.kind = 'pull' and l.linked_by is null
            and not exists (select 1 from work_item_links o where o.work_item_id = l.work_item_id and o.kind = 'issue') as alone
       from work_item_links l where l.repo_id = $1 and l.number = $2`,
    [thing.repoId, thing.number],
  );
  return Boolean(row?.alone);
}

/** A new item, with the next number. `nextval` never rolls back, so a number drawn by a transaction that failed is skipped, never handed out. */
async function newItem(sql: Sql): Promise<WorkItem> {
  const row = await one<ItemRow>(sql, `insert into work_items (number) values (nextval('work_item_number_seq')) returning id, number, merged_into`, []);
  if (!row) throw new Error('failed to create a work item');
  return toItem(row);
}

/**
 * `closedAt` is when a thing first linked already closed was seen so: now,
 * for a delivery or a person's link; null for history, whose close time
 * nobody read, so the board falls back to when it opened.
 */
async function insertLink(
  sql: Sql,
  itemId: string,
  thing: Thing,
  snapshot: Snapshot,
  linkedBy: string | null = null,
  closedAt: 'now' | null = 'now',
): Promise<void> {
  const byRequest = 'requestId' in thing;
  await sql.query(
    `insert into work_item_links (work_item_id, kind, repo_id, number, request_id, linked_by, title, state, url, opened_at, closed_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      itemId,
      byRequest ? 'request' : thing.kind,
      byRequest ? null : thing.repoId,
      byRequest ? null : thing.number,
      byRequest ? thing.requestId : null,
      linkedBy,
      snapshot.title,
      snapshot.state,
      snapshot.url,
      snapshot.openedAt,
      snapshot.state !== 'open' && closedAt === 'now' ? new Date().toISOString() : null,
    ],
  );
}

/**
 * A link's close time as its state changes: set when it goes from open to
 * closed or merged, cleared when it reopens, kept otherwise. `$3` is the new
 * state; a merged link stays merged, as the `state` beside it says.
 */
const CLOSED_AT = `closed_at = case
             when state = 'merged' then closed_at
             when $3 = 'open' then null
             when state = 'open' then now()
             else closed_at end`;

/**
 * An item whose last link moved away keeps its row and its number, and points
 * at where the link went, so its key still resolves.
 */
async function settleEmptied(sql: Sql, itemId: string, into: string): Promise<void> {
  const left = await one<{ links: number }>(sql, 'select count(*)::int as links from work_item_links where work_item_id = $1', [itemId]);
  if (Number(left?.links ?? 0) === 0) await sql.query('update work_items set merged_into = $2 where id = $1', [itemId, into]);
}

/** A pull request's or issue's snapshot, kept for the history numbering while its repository is not numbered yet. */
async function recordUnnumbered(sql: Sql, thing: { repoId: string; number: number; kind: 'issue' | 'pull' }, snapshot: Snapshot): Promise<void> {
  await sql.query(
    `insert into work_item_backfill_rows (repo_id, number, kind, title, state, url, opened_at, head_ref, head_repo, base_ref, closes)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (repo_id, number) do update set
       title = excluded.title, state = excluded.state, url = excluded.url,
       head_ref = coalesce(excluded.head_ref, work_item_backfill_rows.head_ref),
       head_repo = coalesce(excluded.head_repo, work_item_backfill_rows.head_repo),
       base_ref = coalesce(excluded.base_ref, work_item_backfill_rows.base_ref),
       closes = case when cardinality(excluded.closes) > 0 then excluded.closes else work_item_backfill_rows.closes end`,
    [
      thing.repoId,
      thing.number,
      thing.kind,
      snapshot.title,
      snapshot.state,
      snapshot.url ?? '',
      snapshot.openedAt,
      snapshot.headRef ?? null,
      snapshot.headRepo ?? null,
      snapshot.baseRef ?? null,
      [...(snapshot.closes ?? [])],
    ],
  );
}

/**
 * Makes sure a thing has its link, and brings the link's snapshot up to date.
 *
 * - With a link already, the snapshot is refreshed. A merged pull request
 *   stays merged: the sweep reads only `closed`.
 * - With none, it joins the item `claim` names, or a new item when `claim` is null.
 * - A pull request's automatic link to another item than `claim` moves to it;
 *   the item it left, if now empty, points where it went. A link a person
 *   made (`linked_by`) is never moved, and neither is an issue's or a request's.
 * - Before its numbering has begun (`numberedFor`), an issue or pull request
 *   is only recorded for the history numbering, and nothing is returned.
 *
 * The item the thing is in afterwards.
 */
export async function ensureLink(thing: Thing, snapshot: Snapshot, claim: string | null, client?: Sql): Promise<WorkItem | null> {
  return locked(client, async (sql) => {
    if (!(await numberedFor(sql, thing))) {
      if (!('requestId' in thing)) await recordUnnumbered(sql, thing, snapshot);
      return null;
    }
    const claimed = claim ? await resolve(sql, claim) : null;
    const link = await linkOf(sql, thing);
    if (link) {
      await sql.query(
        `update work_item_links set
           title = $2,
           state = case when state = 'merged' then state else $3 end,
           url = coalesce($4, url),
           ${CLOSED_AT},
           seen_at = now()
         where id = $1`,
        [link.id, snapshot.title, snapshot.state, snapshot.url],
      );
      const current = await resolve(sql, link.work_item_id);
      if (claimed && current && claimed.id !== current.id && link.kind === 'pull' && link.linked_by === null) {
        await sql.query('update work_item_links set work_item_id = $2 where id = $1', [link.id, claimed.id]);
        await settleEmptied(sql, link.work_item_id, claimed.id);
        return claimed;
      }
      return current;
    }
    const item = claimed ?? (await newItem(sql));
    await insertLink(sql, item.id, thing, snapshot);
    return item;
  });
}

/**
 * Moves every link of `from` into `into`, and points `from` at it. Refused
 * (false) when each holds an issue, so no item ever holds two issues by
 * itself, and when `from` holds a link a person made, which automatic
 * linking never moves. The only automatic merge: a request filed as an
 * issue that already had an item of its own.
 */
export async function mergeInto(from: string, into: string, client?: Sql): Promise<boolean> {
  return locked(client, (sql) => merge(sql, from, into));
}

/** `mergeInto`, under the lock its caller holds. */
async function merge(sql: Sql, from: string, into: string): Promise<boolean> {
  const source = await resolve(sql, from);
  const target = await resolve(sql, into);
  if (!source || !target) return false;
  if (source.id === target.id) return true;
  const held = async (id: string) =>
    (await one<{ issues: number; by_hand: number }>(
      sql,
      `select count(*) filter (where kind = 'issue')::int as issues, count(*) filter (where linked_by is not null)::int as by_hand
       from work_item_links where work_item_id = $1`,
      [id],
    )) ?? { issues: 0, by_hand: 0 };
  const [a, b] = [await held(source.id), await held(target.id)];
  if (Number(a.by_hand) > 0) return false;
  if (Number(a.issues) > 0 && Number(b.issues) > 0) return false;
  await sql.query('update work_item_links set work_item_id = $2 where work_item_id = $1', [source.id, target.id]);
  await sql.query('update work_items set merged_into = $2 where id = $1', [source.id, target.id]);
  return true;
}

/**
 * The item of the earliest request filed as an issue, other than `except`:
 * what a later request filed as the same issue joins while the issue itself
 * has no item, its repository not numbered yet. Null when there is none.
 */
export async function firstFiledItem(repoId: string, issueNumber: number, except: string): Promise<WorkItem | null> {
  const row = await queryOne<{ work_item_id: string }>(
    `select l.work_item_id from requests q join work_item_links l on l.request_id = q.id
      where q.repo_id = $1 and q.issue_number = $2 and q.id <> $3
      order by q.created_at, q.id limit 1`,
    [repoId, issueNumber, except],
  );
  return row ? resolve(pool, row.work_item_id) : null;
}

/** Something without a link yet, as the history numbering sees it. */
export type Pending =
  | {
      kind: 'issue' | 'pull';
      repoId: string;
      repoFullName: string;
      number: number;
      title: string;
      state: LinkState;
      url: string | null;
      openedAt: string;
      headRef: string | null;
      headRepo: string | null;
      baseRef: string | null;
      /** The issues of its own repository it closes, for a pull request. */
      closes: number[];
    }
  | {
      kind: 'request';
      requestId: string;
      /** Where it was filed, once it was. */
      repoId: string | null;
      issueNumber: number | null;
      title: string;
      state: LinkState;
      openedAt: string;
      /** Its item, for a request already numbered whose issue has none yet. */
      itemId: string | null;
    };

/** An issue already linked in a repository being numbered, which a pull request or request may join. */
export interface LinkedIssue {
  repoId: string;
  number: number;
  itemId: string;
}

/** Things to number as one item, earliest-opened group first; `claim` is an existing item they join instead. */
export interface PlannedGroup {
  members: Pending[];
  claim: string | null;
}

export type Plan = (pending: Pending[], linked: LinkedIssue[]) => PlannedGroup[];

interface PendingRow {
  kind: 'issue' | 'pull' | 'request';
  repo_id: string | null;
  repo_full_name: string | null;
  number: number | null;
  request_id: string | null;
  issue_number: number | null;
  item_id: string | null;
  title: string;
  state: string;
  url: string | null;
  opened_at: Date;
  head_ref: string | null;
  head_repo: string | null;
  base_ref: string | null;
  closes: number[] | null;
}

function asState(state: string): LinkState {
  return state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : 'open';
}

function toPending(row: PendingRow): Pending {
  if (row.kind === 'request') {
    return {
      kind: 'request',
      requestId: row.request_id!,
      repoId: row.repo_id,
      issueNumber: row.issue_number,
      title: row.title,
      state: asState(row.state),
      openedAt: row.opened_at.toISOString(),
      itemId: row.item_id,
    };
  }
  return {
    kind: row.kind,
    repoId: row.repo_id!,
    repoFullName: row.repo_full_name ?? '',
    number: row.number!,
    title: row.title,
    state: asState(row.state),
    url: row.url,
    openedAt: row.opened_at.toISOString(),
    headRef: row.head_ref,
    headRepo: row.head_repo,
    baseRef: row.base_ref,
    closes: (row.closes ?? []).map(Number),
  };
}

/** A request's title on the board: its first line, as long as a title. */
export function requestTitle(text: string): string {
  const first = text.trim().split('\n')[0]?.trim() ?? '';
  return (first.length > 200 ? `${first.slice(0, 199)}…` : first) || 'Request';
}

/**
 * Numbers everything without a link in the repositories whose history has
 * been read and not yet numbered, and every request without a link, in one
 * transaction: `plan` says what goes together, in opened order, and each
 * group gets the next number. The numbered repositories' read rows are
 * deleted, and they, and the install, are marked numbered: from then on
 * their things are numbered live. What it numbered.
 */
export async function numberPending(plan: Plan): Promise<{ items: number; links: number; repos: string[] }> {
  return locked(undefined, async (sql) => {
    const ready = (
      await sql.query(`select repo_id from work_item_backfill where repo_id is not null and read_at is not null and numbered_at is null`)
    ).rows.map((row: { repo_id: string }) => row.repo_id);
    const pending = (
      await sql.query(
        `select b.kind, b.repo_id, r.full_name as repo_full_name, b.number, null::uuid as request_id, null::int as issue_number,
                null::uuid as item_id, b.title, b.state, b.url, b.opened_at, b.head_ref, b.head_repo, b.base_ref, b.closes
           from work_item_backfill_rows b join repos r on r.id = b.repo_id
          where b.repo_id = any($1::uuid[])
            and not exists (select 1 from work_item_links l where l.repo_id = b.repo_id and l.number = b.number)
         union all
         select 'issue', i.repo_id, r.full_name, i.number, null, null, null, i.title,
                case when i.stage in ('merged', 'done') then 'closed' else 'open' end, i.url, i.created_at, null, null, null, null
           from issues i join repos r on r.id = i.repo_id
          where i.repo_id = any($1::uuid[])
            and not exists (select 1 from work_item_backfill_rows b where b.repo_id = i.repo_id and b.number = i.number)
            and not exists (select 1 from work_item_links l where l.repo_id = i.repo_id and l.number = i.number)
         union all
         select 'request', q.repo_id, null, null, q.id, q.issue_number, l.work_item_id, q.text,
                case when q.state = 'abandoned' then 'closed' else 'open' end, null, q.created_at, null, null, null, null
           from requests q left join work_item_links l on l.request_id = q.id
          where l.id is null
             or (q.issue_number is not null and q.repo_id = any($1::uuid[])
                 and not exists (select 1 from work_item_links i where i.repo_id = q.repo_id and i.number = q.issue_number))`,
        [ready],
      )
    ).rows.map((row: PendingRow) => toPending(row.kind === 'request' ? { ...row, title: requestTitle(row.title) } : row));
    const linked = (
      await sql.query(`select repo_id, number, work_item_id from work_item_links where kind = 'issue' and repo_id = any($1::uuid[])`, [ready])
    ).rows.map((row: { repo_id: string; number: number; work_item_id: string }) => ({ repoId: row.repo_id, number: row.number, itemId: row.work_item_id }));

    let items = 0;
    let links = 0;
    for (const group of plan(pending, linked)) {
      const unlinked = group.members.filter((member) => member.kind !== 'request' || !member.itemId);
      const numbered = group.members.flatMap((member) => (member.kind === 'request' && member.itemId ? [member.itemId] : []));
      if (unlinked.length === 0 && numbered.length < 2) continue;
      const claimed = group.claim ? await resolve(sql, group.claim) : null;
      const item = claimed ?? (await newItem(sql));
      if (!claimed) items += 1;
      for (const member of unlinked) {
        const thing: Thing = member.kind === 'request' ? { requestId: member.requestId } : { repoId: member.repoId, number: member.number, kind: member.kind };
        await insertLink(sql, item.id, thing, {
          title: member.title,
          state: member.state,
          url: member.kind === 'request' ? null : member.url,
          openedAt: member.openedAt,
        }, null, null);
        links += 1;
      }
      // Requests numbered live, filed as one issue while its repository was
      // still being read: each had drawn an item of its own at create, and
      // only the issue joined the earliest's, leaving the later requests on
      // numbers of their own. They join the group's item, on `mergeInto`'s
      // terms: never a person's link moved, never two issues in one item.
      for (const itemId of numbered) await merge(sql, itemId, item.id);
    }
    await sql.query('delete from work_item_backfill_rows where repo_id = any($1::uuid[])', [ready]);
    await sql.query('update work_item_backfill set numbered_at = now() where repo_id = any($1::uuid[])', [ready]);
    await sql.query(
      `insert into work_item_backfill (repo_id, numbered_at) values (null, now())
       on conflict ((repo_id is null)) where repo_id is null do update set numbered_at = coalesce(work_item_backfill.numbered_at, excluded.numbered_at)`,
    );
    return { items, links, repos: ready };
  });
}

/** A link as the board and an item's page read it. */
export interface Link {
  /** The order things were linked in: an item's first issue is its lowest. */
  id: number;
  itemId: string;
  /** The item's number, when read with every link (`allLinks`). */
  itemNumber?: number;
  kind: 'issue' | 'pull' | 'request';
  repoId: string | null;
  number: number | null;
  requestId: string | null;
  linkedBy: string | null;
  title: string;
  state: LinkState;
  url: string | null;
  openedAt: string;
  /** When it was last seen to close or merge; null while open, or when nobody saw it close (history). */
  closedAt: string | null;
}

interface FullLinkRow {
  id: string | number;
  work_item_id: string;
  item_number?: string | number;
  kind: 'issue' | 'pull' | 'request';
  repo_id: string | null;
  number: number | null;
  request_id: string | null;
  linked_by: string | null;
  title: string;
  state: string;
  url: string | null;
  opened_at: Date | string;
  closed_at: Date | string | null;
}

const isoOf = (at: Date | string): string => (at instanceof Date ? at.toISOString() : String(at));

function toLink(row: FullLinkRow): Link {
  return {
    id: Number(row.id),
    itemId: row.work_item_id,
    ...(row.item_number !== undefined ? { itemNumber: Number(row.item_number) } : {}),
    kind: row.kind,
    repoId: row.repo_id,
    number: row.number === null ? null : Number(row.number),
    requestId: row.request_id,
    linkedBy: row.linked_by,
    title: row.title,
    state: asState(row.state),
    url: row.url,
    openedAt: isoOf(row.opened_at),
    closedAt: row.closed_at === null || row.closed_at === undefined ? null : isoOf(row.closed_at),
  };
}

const LINK_COLUMNS = 'l.id, l.work_item_id, l.kind, l.repo_id, l.number, l.request_id, l.linked_by, l.title, l.state, l.url, l.opened_at, l.closed_at';

/** The item numbered `number`, or the one it was merged into; null for a number never handed out. */
export async function byNumber(number: number): Promise<WorkItem | null> {
  const row = await queryOne<ItemRow>('select id, number, merged_into from work_items where number = $1', [number]);
  return row ? resolve(pool, row.id) : null;
}

/** An item's links, in the order they were linked. */
export async function linksOf(itemId: string): Promise<Link[]> {
  const rows = await query<FullLinkRow>(`select ${LINK_COLUMNS} from work_item_links l where l.work_item_id = $1 order by l.id`, [itemId]);
  return rows.map(toLink);
}

/**
 * Every link, with its item's number, in the order they were linked: what
 * the board groups its cards by. A link is always on an item not merged
 * away, since a merge and an emptying move the links with them.
 */
export async function allLinks(): Promise<Link[]> {
  const rows = await query<FullLinkRow>(
    `select ${LINK_COLUMNS}, w.number as item_number from work_item_links l join work_items w on w.id = l.work_item_id order by l.id`,
  );
  return rows.map(toLink);
}

/**
 * A person links a thing to an item. One linked elsewhere moves, whoever
 * linked it, and the item it left, if now empty, points here. The link is
 * theirs afterwards (`linked_by`): no automatic pass moves it back. The item
 * it came from, or null for a thing with no link before.
 */
export async function linkByHand(itemId: string, thing: Thing, snapshot: Snapshot, by: string): Promise<{ item: WorkItem; from: WorkItem | null }> {
  return locked(undefined, async (sql) => {
    const item = await resolve(sql, itemId);
    if (!item) throw new Error(`work item ${itemId} does not exist`);
    const link = await linkOf(sql, thing);
    if (!link) {
      await insertLink(sql, item.id, thing, snapshot, by);
      return { item, from: null };
    }
    const from = await resolve(sql, link.work_item_id);
    // The snapshot the route just read from GitHub, refreshed as `ensureLink`
    // refreshes it: a pull merged since its last delivery stayed in Review.
    await sql.query(
      `update work_item_links set
         title = $2,
         state = case when state = 'merged' then state else $3 end,
         url = coalesce($4, url),
         ${CLOSED_AT},
         work_item_id = $5,
         linked_by = $6,
         seen_at = now()
       where id = $1`,
      [link.id, snapshot.title, snapshot.state, snapshot.url, item.id, by],
    );
    if (from && from.id !== item.id) await settleEmptied(sql, from.id, item.id);
    return { item, from };
  });
}

/**
 * A person takes a thing out of an item: it gets a new item of its own,
 * which it keeps (`linked_by`) against any automatic pass. Refused (null)
 * when it is not linked to `itemId`, and refused with `only` when it is the
 * item's one link: an item is never left empty by hand, it is merged.
 */
export async function unlinkByHand(itemId: string, thing: ThingRef, by: string): Promise<WorkItem | 'only' | null> {
  return locked(undefined, async (sql) => {
    const item = await resolve(sql, itemId);
    const link = await linkOf(sql, thing);
    if (!item || !link) return null;
    const current = await resolve(sql, link.work_item_id);
    if (current?.id !== item.id) return null;
    const left = await one<{ links: number }>(sql, 'select count(*)::int as links from work_item_links where work_item_id = $1', [item.id]);
    if (Number(left?.links ?? 0) <= 1) return 'only';
    const fresh = await newItem(sql);
    await sql.query('update work_item_links set work_item_id = $2, linked_by = $3 where id = $1', [link.id, fresh.id, by]);
    return fresh;
  });
}

/**
 * A person merges one item into another: every link moves, and `from`
 * points at `into`, so its key still resolves. Unlike `mergeInto`, nothing
 * is refused: two issues in one item, or a person's links, are theirs to
 * put together. Null when either is missing or they are one item already.
 */
export async function mergeByHand(from: string, into: string): Promise<WorkItem | null> {
  return locked(undefined, async (sql) => {
    const source = await resolve(sql, from);
    const target = await resolve(sql, into);
    if (!source || !target || source.id === target.id) return null;
    await sql.query('update work_item_links set work_item_id = $2 where work_item_id = $1', [source.id, target.id]);
    await sql.query('update work_items set merged_into = $2 where id = $1', [source.id, target.id]);
    return target;
  });
}

/** How far one repository's history read has got. */
export interface BackfillState {
  repoId: string | null;
  issuesPage: number;
  pullsPage: number;
  readAt: string | null;
  numberedAt: string | null;
  caughtUpAt: string | null;
  lastError: string | null;
}

interface BackfillRow {
  repo_id: string | null;
  issues_page: number;
  pulls_page: number;
  read_at: Date | null;
  numbered_at: Date | null;
  caught_up_at: Date | null;
  last_error: string | null;
}

/** Every repository's read, and the install's (repoId null). */
export async function backfillState(): Promise<BackfillState[]> {
  const rows = await query<BackfillRow>(
    'select repo_id, issues_page, pulls_page, read_at, numbered_at, caught_up_at, last_error from work_item_backfill order by id',
  );
  return rows.map((row) => ({
    repoId: row.repo_id,
    issuesPage: row.issues_page,
    pullsPage: row.pulls_page,
    readAt: row.read_at?.toISOString() ?? null,
    numberedAt: row.numbered_at?.toISOString() ?? null,
    caughtUpAt: row.caught_up_at?.toISOString() ?? null,
    lastError: row.last_error,
  }));
}

/** A repository's read begins: its row, if it has none. */
export async function startBackfill(repoId: string): Promise<void> {
  await query('insert into work_item_backfill (repo_id) values ($1) on conflict (repo_id) do nothing', [repoId]);
}

/** A row the history read found. */
export interface BackfillRowInput {
  number: number;
  kind: 'issue' | 'pull';
  title: string;
  state: LinkState;
  url: string;
  openedAt: string;
  headRef?: string | null;
  headRepo?: string | null;
  baseRef?: string | null;
  closes?: readonly number[];
}

/**
 * One page of the read, and the page after it, in one transaction: a restart
 * never skips half a page, nor reads one twice into the count.
 */
export async function saveBackfillPage(repoId: string, which: 'issues' | 'pulls', nextPage: number, rows: readonly BackfillRowInput[]): Promise<void> {
  await locked(undefined, async (sql) => {
    for (const row of rows) {
      await recordUnnumbered(sql, { repoId, number: row.number, kind: row.kind }, {
        title: row.title,
        state: row.state,
        url: row.url,
        openedAt: row.openedAt,
        headRef: row.headRef ?? null,
        headRepo: row.headRepo ?? null,
        baseRef: row.baseRef ?? null,
        closes: row.closes ?? [],
      });
    }
    await sql.query(
      `update work_item_backfill set ${which === 'issues' ? 'issues_page' : 'pulls_page'} = $2, last_error = null where repo_id = $1`,
      [repoId, nextPage],
    );
  });
}

/** Both listings of a repository are read to the end. */
export async function markRead(repoId: string): Promise<void> {
  await query('update work_item_backfill set read_at = now(), last_error = null where repo_id = $1', [repoId]);
}

/** A catch-up read finished, as of `at`, by GitHub's clock or the bridge's a little before it. */
export async function markCaughtUp(repoId: string, at: string): Promise<void> {
  await query('update work_item_backfill set caught_up_at = $2, last_error = null where repo_id = $1', [repoId, at]);
}

/** Why the read stopped, for the next run and a person reading the table. */
export async function recordBackfillError(repoId: string, error: string): Promise<void> {
  await query('update work_item_backfill set last_error = $2 where repo_id = $1', [repoId, error.slice(0, 1000)]);
}
