import { query, queryOne, withTransaction } from '../client.js';
import { ensureLink, requestTitle } from './work-items.js';

export interface RequestRecord {
  id: string;
  text: string;
  context: string | null;
  /** The repository the person named, or, when they named none, the first one it was filed in. */
  repoId: string | null;
  kind: string | null;
  requestedBy: string;
  /** The first issue filed in `repoId`; null while there is none there. `issues` has every one. */
  issueNumber: number | null;
  /**
   * Every issue it was filed as, oldest first, in whichever managed
   * repositories intake filed it (`request_issues`, migration 0153).
   */
  issues: RequestIssue[];
  /**
   * `queued` while it waits for the intake bot to be free, `draft` while
   * triage works on it, `questions` while it waits on its person, and then
   * `filed` or `abandoned`. See apps/bridge/src/request-lifecycle.ts.
   */
  state: 'queued' | 'draft' | 'questions' | 'filed' | 'abandoned';
  createdAt: string;
  /** How many times the queue could not start its triage since it last joined the line. */
  queueAttempts: number;
  /** Why the queue last could not start it, while it waits; null otherwise. */
  queueReason: string | null;
  /** When it last changed: when it was claimed, put back, or moved on. */
  updatedAt: string;
}

/** One issue a request was filed as. */
export interface RequestIssue {
  repoId: string;
  /** `owner/name`; null for a repository no longer on record. */
  repoFullName: string | null;
  number: number;
  filedAt: string;
}

interface RequestRow {
  id: string;
  text: string;
  context: string | null;
  repo_id: string | null;
  kind: string | null;
  requested_by: string;
  issue_number: number | null;
  state: RequestRecord['state'];
  created_at: Date;
  queue_attempts: number;
  queue_reason: string | null;
  updated_at: Date;
  issues?: { repoId: string; repoFullName: string | null; number: number; filedAt: string }[] | null;
}

/** Its issues, read with the row, in a select or a `returning`. */
const ISSUES = `(
  select coalesce(json_agg(json_build_object(
           'repoId', ri.repo_id, 'repoFullName', r.full_name, 'number', ri.issue_number, 'filedAt', ri.filed_at
         ) order by ri.filed_at, ri.issue_number), '[]'::json)
    from request_issues ri left join repos r on r.id = ri.repo_id
   where ri.request_id = requests.id
) as issues`;

const COLUMNS = `id, text, context, repo_id, kind, requested_by, issue_number, state, created_at, queue_attempts, queue_reason, updated_at, ${ISSUES}`;

const SELECT = `
  select ${COLUMNS} from requests
`;

function toRequest(row: RequestRow): RequestRecord {
  return {
    id: row.id,
    text: row.text,
    context: row.context,
    repoId: row.repo_id,
    kind: row.kind,
    requestedBy: row.requested_by,
    issueNumber: row.issue_number,
    issues: (row.issues ?? []).map((issue) => ({
      repoId: issue.repoId,
      repoFullName: issue.repoFullName ?? null,
      number: Number(issue.number),
      // json_agg writes a timestamp as Postgres prints it, with an offset rather than a Z.
      filedAt: new Date(issue.filedAt).toISOString(),
    })),
    state: row.state,
    createdAt: row.created_at.toISOString(),
    queueAttempts: row.queue_attempts ?? 0,
    queueReason: row.queue_reason ?? null,
    updatedAt: (row.updated_at ?? row.created_at).toISOString(),
  };
}

/**
 * A console request exists before an issue does; intake turns it into one.
 * Its id never shares its first eight characters with another request's, so
 * its subject (`request:<id8>`) names it alone.
 */
export async function createRequest(input: {
  text: string;
  context: string | null;
  repoId: string | null;
  kind: string | null;
  requestedBy: string;
  /** `queued` to wait its turn; `draft`, the default, when triage starts on it now. */
  state?: 'queued' | 'draft';
}): Promise<RequestRecord> {
  // The id is the column's default, so the same insert again draws a fresh one.
  for (let attempt = 1; ; attempt += 1) {
    try {
      // Its work item in the same transaction, so a request is never seen
      // without its number once numbering has begun; before then the history
      // numbering gives it one (`numberPending`).
      const row = await withTransaction(async (client) => {
        const inserted = (
          await client.query<RequestRow>(
            `insert into requests (text, context, repo_id, kind, requested_by, state)
             values ($1,$2,$3,$4,$5,$6)
             returning ${COLUMNS}`,
            [input.text, input.context, input.repoId, input.kind, input.requestedBy, input.state ?? 'draft'],
          )
        ).rows[0];
        if (!inserted) throw new Error('failed to create request');
        await ensureLink(
          { requestId: inserted.id },
          { title: requestTitle(inserted.text), state: 'open', url: null, openedAt: inserted.created_at.toISOString() },
          null,
          client,
        );
        return inserted;
      });
      return toRequest(row);
    } catch (error) {
      if (attempt >= ID8_ATTEMPTS || !sharesId8(error)) throw error;
    }
  }
}

/**
 * How many ids a new request draws before it gives up. Two in a row sharing
 * eight characters with an existing request is about one in 10^14 at 10,000
 * requests, so five is never the limit in practice.
 */
const ID8_ATTEMPTS = 5;

/**
 * Whether an insert was refused by `requests_id8` (migration 0144): its id
 * shares its first eight characters, and so its subject, with another request.
 */
function sharesId8(error: unknown): boolean {
  const failure = error as { code?: string; constraint?: string } | null;
  return failure?.code === '23505' && failure.constraint === 'requests_id8';
}

export async function getRequest(id: string): Promise<RequestRecord | null> {
  const row = await queryOne<RequestRow>(`${SELECT} where id = $1`, [id]);
  return row ? toRequest(row) : null;
}

/** A prefix two requests share names neither of them. */
export class AmbiguousRequestPrefix extends Error {
  constructor(readonly prefix: string) {
    super(`request:${prefix} matches more than one request`);
    this.name = 'AmbiguousRequestPrefix';
  }
}

/**
 * The request a task's subject names.
 *
 * A subject carries the first eight characters of the request's id
 * (`request:a4b02784`), because that is what a person reads in a thread, so the
 * request is found by that prefix. A prefix that matches two requests is
 * refused rather than answered with whichever came first: a bot briefed with
 * somebody else's request files somebody else's issue.
 */
export async function findRequestByPrefix(prefix: string): Promise<RequestRecord | null> {
  const wanted = prefix.trim().toLowerCase();
  // An id is hex and hyphens. Anything else names no request, and would be a
  // pattern rather than a prefix by the time it reached `like`.
  if (!/^[0-9a-f-]+$/.test(wanted)) return null;

  const rows = await query<RequestRow>(`${SELECT} where id::text like $1 order by created_at limit 2`, [`${wanted}%`]);
  if (rows.length > 1) throw new AmbiguousRequestPrefix(wanted);
  return rows[0] ? toRequest(rows[0]) : null;
}

export async function listRequests(limit = 50): Promise<RequestRecord[]> {
  const rows = await query<RequestRow>(`${SELECT} order by created_at desc limit $1`, [limit]);
  return rows.map(toRequest);
}

/**
 * The console requests filed as one issue, oldest first: what a work item
 * started as. Usually one; a request sent twice and filed into the same issue
 * is two, and both are the item's. Read from every issue a request was filed
 * as, so the design of a request's second issue, in another repository, is
 * given the request too.
 */
export async function listRequestsForIssue(repoId: string, issueNumber: number): Promise<RequestRecord[]> {
  const rows = await query<RequestRow>(
    `${SELECT} where exists (
       select 1 from request_issues ri where ri.request_id = requests.id and ri.repo_id = $1 and ri.issue_number = $2
     ) order by created_at`,
    [repoId, issueNumber],
  );
  return rows.map(toRequest);
}

/** Filing a request that was abandoned: nothing files it again. */
export class RequestAbandoned extends Error {
  constructor(readonly requestId: string) {
    super(`request ${requestId.slice(0, 8)} was abandoned, so no issue is filed for it`);
    this.name = 'RequestAbandoned';
  }
}

/**
 * Records an issue a request was filed as, in one transaction, and marks the
 * request `filed`. `added` is false when that issue was recorded already, so a
 * redelivery says nothing twice.
 *
 * The request keeps the repository the person named, or takes this one when
 * they named none; `issue_number` is the first issue in that repository, and
 * stays null when intake filed only elsewhere ("use b instead of a"), so the
 * readers that join on the pair keep their meaning.
 */
export async function fileIssue(
  requestId: string,
  repoId: string,
  issueNumber: number,
): Promise<{ request: RequestRecord; added: boolean } | null> {
  return withTransaction(async (client) => {
    const current = (
      await client.query<{ state: RequestRecord['state'] }>('select state from requests where id = $1 for update', [requestId])
    ).rows[0];
    if (!current) return null;
    if (current.state === 'abandoned') throw new RequestAbandoned(requestId);
    const inserted = await client.query(
      `insert into request_issues (request_id, repo_id, issue_number) values ($1, $2, $3)
       on conflict do nothing
       returning issue_number`,
      [requestId, repoId, issueNumber],
    );
    // A row already there changes nothing: a redelivered `opened` event that
    // touched `updated_at` started the filed card's window on the board again.
    if (inserted.rows.length === 0) {
      const unchanged = (await client.query<RequestRow>(`select ${COLUMNS} from requests where id = $1`, [requestId])).rows[0];
      return unchanged ? { request: toRequest(unchanged), added: false } : null;
    }
    const row = (
      await client.query<RequestRow>(
        `update requests set
           state = 'filed',
           repo_id = coalesce(repo_id, $2::uuid),
           issue_number = case
             when issue_number is null and coalesce(repo_id, $2::uuid) = $2::uuid then $3::integer
             else issue_number
           end,
           updated_at = now()
         where id = $1
         returning ${COLUMNS}`,
        [requestId, repoId, issueNumber],
      )
    ).rows[0];
    if (!row) return null;
    return { request: toRequest(row), added: true };
  });
}

/**
 * A request's state. Filing goes through `fileIssue`, which records the issue
 * with it.
 */
export async function updateRequest(
  id: string,
  patch: {
    state?: RequestRecord['state'];
  },
): Promise<RequestRecord | null> {
  const row = await queryOne<RequestRow>(
    `update requests set
       state = coalesce($2, state),
       updated_at = now()
     where id = $1
     returning ${COLUMNS}`,
    [id, patch.state ?? null],
  );
  // An abandoned request's work item shows it closed.
  if (row && patch.state === 'abandoned') {
    await query(`update work_item_links set state = 'closed', seen_at = now() where request_id = $1`, [id]);
  }
  return row ? toRequest(row) : null;
}

/** The requests waiting their turn, oldest first: the order they start in. */
export async function listQueued(): Promise<RequestRecord[]> {
  const rows = await query<RequestRow>(`${SELECT} where state = 'queued' order by created_at, id`);
  return rows.map(toRequest);
}

/** Requests in one state, oldest first. */
export async function listInState(state: RequestRecord['state'], limit = 200): Promise<RequestRecord[]> {
  const rows = await query<RequestRow>(`${SELECT} where state = $1 order by created_at, id limit $2`, [state, limit]);
  return rows.map(toRequest);
}

/** Drafts changed since `since`, however many older ones there are. */
export async function listDraftsSince(since: Date): Promise<RequestRecord[]> {
  const rows = await query<RequestRow>(`${SELECT} where state = 'draft' and updated_at >= $1 order by updated_at, id`, [since]);
  return rows.map(toRequest);
}

/**
 * Takes a queued request for triage, in one statement: of two bridges asking
 * at once, one gets it. Null when it was not queued any more.
 */
export async function claimQueued(id: string): Promise<RequestRecord | null> {
  const row = await queryOne<RequestRow>(
    `update requests set state = 'draft', updated_at = now()
     where id = $1 and state = 'queued'
     returning ${COLUMNS}`,
    [id],
  );
  return row ? toRequest(row) : null;
}

/**
 * Puts a claimed request back at its place in the queue, when its triage
 * could not start after all. With a reason it says why; it counts as an
 * attempt when the request itself is what could not start, not when something
 * outside it (hostd) failed. Without one (intake turned busy) it only waits.
 */
export async function requeue(id: string, failure?: string, options: { counts?: boolean } = {}): Promise<void> {
  const counts = failure !== undefined && (options.counts ?? true);
  await query(
    `update requests set state = 'queued',
       queue_attempts = queue_attempts + case when $3 then 1 else 0 end,
       queue_reason = coalesce($2, queue_reason),
       updated_at = now()
     where id = $1 and state = 'draft'`,
    [id, failure ?? null, counts],
  );
}

/**
 * Puts a request back in line to be triaged again: "Try again" on its card.
 * One whose triage ended without filing joins the line again; one already
 * waiting keeps its place, and is tried afresh however often it failed. Null
 * when it is filed or abandoned.
 */
export async function queueAgain(id: string): Promise<RequestRecord | null> {
  const row = await queryOne<RequestRow>(
    `update requests set state = 'queued', queue_attempts = 0, queue_reason = null, updated_at = now()
     where id = $1 and state in ('queued', 'draft', 'questions')
     returning ${COLUMNS}`,
    [id],
  );
  return row ? toRequest(row) : null;
}
