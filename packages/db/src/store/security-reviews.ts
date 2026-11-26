import type { ReviewFinding } from '@openadlc/shared';
import { query } from '../client.js';

/**
 * The security seat's signed reviews that carried a findings list, and which
 * of their findings still stand. See `migrations/0172_security_reviews.sql`
 * and docs/adr/0087-security-review-findings-are-stored-from-the-seats-signed-marker.md.
 *
 * Only the review webhook writes here, once the review's signature verifies
 * to the security seat; the merge line reads nothing from it.
 */
export interface SecurityReviewInput {
  repoId: string;
  prNumber: number;
  reviewId: number;
  headSha: string | null;
  seat: string;
  url: string;
  submittedAt: Date;
  findings: ReviewFinding[];
}

/** A pull request's state as `work_item_links` keeps it; null when no link row names it. */
export type PullState = 'open' | 'closed' | 'merged';

/** The latest stored review of one pull request, with that pull request's state. */
export interface LatestReview {
  repoId: string;
  repoName: string;
  prNumber: number;
  prState: PullState | null;
  reviewId: number;
  url: string;
  submittedAt: string;
  findings: ReviewFinding[];
}

/** One finding that still stands, on a pull request that merged or was closed. */
export interface UnfixedFinding {
  repoId: string;
  repoName: string;
  prNumber: number;
  prState: 'merged' | 'closed';
  reviewId: number;
  url: string;
  submittedAt: string;
  finding: ReviewFinding;
}

/** The most findings listed for one repository, newest review first. */
export const UNFIXED_PER_REPO = 200;

/**
 * Stores a review's list, or on an edit of the same review — which re-signs
 * it — overwrites the list with what the edit says.
 */
export async function record(input: SecurityReviewInput): Promise<void> {
  await query(
    `insert into security_reviews (repo_id, pr_number, review_id, head_sha, seat, url, submitted_at, findings)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (review_id) do update
       set findings = excluded.findings, head_sha = excluded.head_sha, url = excluded.url, submitted_at = excluded.submitted_at`,
    [input.repoId, input.prNumber, input.reviewId, input.headSha, input.seat, input.url, input.submittedAt, JSON.stringify(input.findings)],
  );
}

interface Row {
  repo_id: string;
  repo_name: string;
  pr_number: number;
  pr_state: string | null;
  review_id: string | number;
  url: string;
  submitted_at: Date;
  findings: unknown;
}

function toLatest(row: Row): LatestReview {
  const state = row.pr_state === 'open' || row.pr_state === 'closed' || row.pr_state === 'merged' ? row.pr_state : null;
  return {
    repoId: row.repo_id,
    repoName: row.repo_name,
    prNumber: row.pr_number,
    prState: state,
    // `bigint` comes back as a string.
    reviewId: Number(row.review_id),
    url: row.url,
    submittedAt: row.submitted_at.toISOString(),
    findings: Array.isArray(row.findings) ? (row.findings as ReviewFinding[]) : [],
  };
}

function later(a: LatestReview, b: LatestReview): boolean {
  if (a.submittedAt !== b.submittedAt) return a.submittedAt > b.submittedAt;
  return a.reviewId > b.reviewId;
}

/**
 * The rule for which findings are unfixed, over stored reviews in any order:
 *
 * - For each pull request, only its latest stored review counts (by
 *   submission time, then review id). That list is the seat's whole current
 *   judgement: a later list that leaves a finding out is what clears it.
 *   Findings are not matched one by one, because the seat rewords them
 *   between rounds. A review with no list has no row, so it clears nothing.
 * - Its findings are listed only when the pull request merged or was closed.
 *   One still open, reopened, or with no link row is not listed: it may yet
 *   be fixed before it lands.
 * - At most `UNFIXED_PER_REPO` per repository, newest review first.
 */
export function unfixedFrom(reviews: readonly LatestReview[]): UnfixedFinding[] {
  const latest = new Map<string, LatestReview>();
  for (const review of reviews) {
    const key = `${review.repoId}#${review.prNumber}`;
    const held = latest.get(key);
    if (!held || later(review, held)) latest.set(key, review);
  }
  const standing = [...latest.values()]
    .filter((review) => review.prState === 'merged' || review.prState === 'closed')
    .sort((a, b) => (later(a, b) ? -1 : later(b, a) ? 1 : 0));
  const perRepo = new Map<string, number>();
  const out: UnfixedFinding[] = [];
  for (const review of standing) {
    for (const finding of review.findings) {
      const count = perRepo.get(review.repoId) ?? 0;
      if (count >= UNFIXED_PER_REPO) break;
      perRepo.set(review.repoId, count + 1);
      out.push({
        repoId: review.repoId,
        repoName: review.repoName,
        prNumber: review.prNumber,
        prState: review.prState as 'merged' | 'closed',
        reviewId: review.reviewId,
        url: review.url,
        submittedAt: review.submittedAt,
        finding,
      });
    }
  }
  return out;
}

/**
 * The findings still standing, on pull requests that merged or were closed,
 * for the repositories named, or every repository. The query takes each pull
 * request's latest stored review with its state from `work_item_links`;
 * `unfixedFrom` applies the rule.
 */
export async function unfixed(repoIds?: readonly string[]): Promise<UnfixedFinding[]> {
  if (repoIds && repoIds.length === 0) return [];
  const rows = await query<Row>(
    `select distinct on (s.repo_id, s.pr_number)
            s.repo_id, r.name as repo_name, s.pr_number, l.state as pr_state, s.review_id, s.url, s.submitted_at, s.findings
       from security_reviews s
       join repos r on r.id = s.repo_id
       left join work_item_links l on l.kind = 'pull' and l.repo_id = s.repo_id and l.number = s.pr_number
      where ($1::uuid[] is null or s.repo_id = any($1::uuid[]))
      order by s.repo_id, s.pr_number, s.submitted_at desc, s.review_id desc`,
    [repoIds ? [...repoIds] : null],
  );
  return unfixedFrom(rows.map(toLatest));
}
