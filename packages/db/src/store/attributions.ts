import { query, queryOne } from '../client.js';

/**
 * The nonces of signatures seen, and the posts whose signature did not check.
 * See migration 0016 and packages/shared/src/signature.ts.
 */

/**
 * Binds a signature's nonce to the post it was seen on. True when it is that
 * post's — the first sighting, or the same post again (an edit, a redelivery);
 * false when another post already took it, which makes this one a copy.
 */
export async function bindNonce(input: {
  nonce: string;
  seat: string;
  taskId: string | null;
  repo: string | null;
  kind: string;
  boundTo: string;
}): Promise<boolean> {
  await query(
    `insert into attributions (nonce, seat, task_id, repo, kind, bound_to)
     values ($1, $2, $3, $4, $5, $6) on conflict (nonce) do nothing`,
    [input.nonce, input.seat, input.taskId, input.repo, input.kind, input.boundTo],
  );
  const row = await queryOne<{ bound_to: string }>('select bound_to from attributions where nonce = $1', [input.nonce]);
  // A nonce bound before the key was lower-cased still belongs to this post:
  // `Acme/widgets:review:12` and `acme/widgets:review:12` are one review.
  return row?.bound_to.toLowerCase() === input.boundTo.toLowerCase();
}

export interface UnattributedPost {
  id: number;
  repo: string;
  kind: string;
  objectId: string;
  login: string;
  reason: string;
  url: string | null;
  seat: string | null;
  /** The sha256 of the body it had when it was recorded; null for one recorded before that was kept. */
  bodySha256: string | null;
  at: string;
}

interface Row {
  id: string;
  repo: string;
  kind: string;
  object_id: string;
  login: string;
  reason: string;
  url: string | null;
  seat: string | null;
  body_sha256: string | null;
  created_at: Date;
}

/**
 * A post that failed again is open again: one resolved when it verified on a
 * re-read, then edited so it no longer does, only had its time refreshed, and
 * stayed off Needs you while the audit log was the only sign of it.
 */
export async function recordUnattributed(input: Omit<UnattributedPost, 'id' | 'at'>): Promise<void> {
  await query(
    `insert into unattributed_posts (repo, kind, object_id, login, reason, url, seat, body_sha256)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (repo, kind, object_id, reason) do update set
       created_at = now(), resolved_at = null, login = excluded.login, url = excluded.url, seat = excluded.seat,
       body_sha256 = excluded.body_sha256`,
    [input.repo, input.kind, input.objectId, input.login, input.reason, input.url, input.seat, input.bodySha256],
  );
}

/** Those seen since `since`, newest first. */
export async function listUnattributed(since: Date, limit = 50): Promise<UnattributedPost[]> {
  const rows = await query<Row>(
    `select id, repo, kind, object_id, login, reason, url, seat, body_sha256, created_at
       from unattributed_posts where created_at >= $1 and resolved_at is null order by created_at desc limit $2`,
    [since, limit],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    repo: row.repo,
    kind: row.kind,
    objectId: row.object_id,
    login: row.login,
    reason: row.reason,
    url: row.url,
    seat: row.seat,
    bodySha256: row.body_sha256,
    at: row.created_at.toISOString(),
  }));
}

/** Resolves a post that verifies after all; true only for the call that resolved it, so it is said once. */
export async function resolveUnattributed(id: number, at = new Date()): Promise<boolean> {
  const rows = await query<{ id: number }>('update unattributed_posts set resolved_at = $2 where id = $1 and resolved_at is null returning id', [id, at]);
  return rows.length > 0;
}
