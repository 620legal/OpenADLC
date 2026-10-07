import { query, queryOne } from '../client.js';

export interface RequestRecord {
  id: string;
  text: string;
  context: string | null;
  repoId: string | null;
  kind: string | null;
  requestedBy: string;
  issueNumber: number | null;
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
}

const COLUMNS = 'id, text, context, repo_id, kind, requested_by, issue_number, state, created_at, queue_attempts, queue_reason, updated_at';

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
      const row = await queryOne<RequestRow>(
        `insert into requests (text, context, repo_id, kind, requested_by, state)
         values ($1,$2,$3,$4,$5,$6)
         returning ${COLUMNS}`,
        [input.text, input.context, input.repoId, input.kind, input.requestedBy, input.state ?? 'draft'],
      );
      if (!row) throw new Error('failed to create request');
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
 * is two, and both are the item's.
 */
export async function listRequestsForIssue(repoId: string, issueNumber: number): Promise<RequestRecord[]> {
  const rows = await query<RequestRow>(`${SELECT} where repo_id = $1 and issue_number = $2 order by created_at`, [repoId, issueNumber]);
  return rows.map(toRequest);
}

export async function updateRequest(
  id: string,
  patch: {
    state?: RequestRecord['state'];
    issueNumber?: number | null;
    /**
     * The repository it was filed in, for a request that named none: intake
     * chose it. A repository the request already names is kept.
     */
    repoId?: string | null;
  },
): Promise<RequestRecord | null> {
  const row = await queryOne<RequestRow>(
    `update requests set
       state = coalesce($2, state),
       issue_number = coalesce($3, issue_number),
       repo_id = coalesce(repo_id, $4),
       updated_at = now()
     where id = $1
     returning ${COLUMNS}`,
    [id, patch.state ?? null, patch.issueNumber ?? null, patch.repoId ?? null],
  );
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
