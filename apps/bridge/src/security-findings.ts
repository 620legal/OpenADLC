import { ownReviewMarker, reviewFindings, type SeatSeverity } from '@openadlc/shared';
import type { SecurityReviewInput, UnfixedFinding } from '@openadlc/db';
import type { CommentSignature } from './design-memory.js';
import { HttpFailure } from './router.js';

/**
 * The security seat's findings: stored from its signed review, and read back
 * for the Security page as the findings of merged or closed pull requests
 * that no later review cleared (#378,
 * docs/adr/0087-security-review-findings-are-stored-from-the-seats-signed-marker.md).
 *
 * Nothing here reaches the merge line or the review gate: storing a list
 * never delays or fails either, and a malformed list changes no verdict.
 */

/** The page's level for each of the seat's grades; `critical` stays for GitHub's alerts (answered on #378). */
export const PAGE_LEVEL: Record<SeatSeverity, 'high' | 'medium' | 'low'> = { blocker: 'high', major: 'medium', minor: 'low' };

export interface SecurityFinding {
  repo: string;
  pr: number;
  prState: 'merged' | 'closed';
  reviewId: number;
  reviewUrl: string;
  reviewedAt: string;
  /** The page's scale, `PAGE_LEVEL` of the seat's word. */
  severity: 'high' | 'medium' | 'low';
  /** The seat's own word, shown beside it. */
  seatSeverity: SeatSeverity;
  summary: string;
  file: string;
  line: number | null;
}

export interface SecurityFindingsView {
  repos: { repo: string; findings: SecurityFinding[] }[];
}

export interface ReviewDelivery {
  action: string | undefined;
  /** The managed repository the review is on, or null when none is. */
  repo: { id: string; name: string; fullName: string } | null;
  fork: boolean;
  prNumber: number;
  review: { id?: number; body?: string | null; html_url?: string; submitted_at?: string; commit_id?: string };
  signature: CommentSignature | null;
}

export interface RecordDeps {
  record: (input: SecurityReviewInput) => Promise<void>;
  /** The crew's name for the seat whose lens is security, or null when no seat has it. */
  securitySeat: string | null;
  warn?: (line: string) => void;
}

/**
 * Stores the findings list a security review ends with, and answers whether
 * it did.
 *
 * Only a review whose signature verifies to the security seat counts, in
 * every attribution mode. Anyone who can comment on a pull request can write
 * a marker, and an unsigned list would let them plant findings on the page or
 * clear the seat's real ones with an empty list.
 */
export async function recordSecurityReview(input: ReviewDelivery, deps: RecordDeps): Promise<boolean> {
  if (input.action !== 'submitted' && input.action !== 'edited') return false;
  if (!input.repo || input.fork) return false;
  const seat = input.signature?.verified ? input.signature.seat : null;
  if (!seat || !deps.securitySeat || seat.toLowerCase() !== deps.securitySeat.toLowerCase()) return false;
  if (input.review.id === undefined) return false;
  const findings = reviewFindings(ownReviewMarker(input.review.body));
  if (findings === 'malformed') {
    (deps.warn ?? console.warn)(`[bridge] ${input.repo.name}#${input.prNumber}: the security review's findings list is malformed; nothing recorded`);
    return false;
  }
  if (findings === null) return false;
  const submitted = input.review.submitted_at ? new Date(input.review.submitted_at) : new Date();
  await deps.record({
    repoId: input.repo.id,
    prNumber: input.prNumber,
    reviewId: input.review.id,
    headSha: input.review.commit_id ?? null,
    seat: deps.securitySeat,
    url: input.review.html_url ?? pullUrl(input.repo.fullName, input.prNumber),
    submittedAt: Number.isNaN(submitted.getTime()) ? new Date() : submitted,
    findings,
  });
  return true;
}

function pullUrl(fullName: string, pr: number): string {
  return `https://github.com/${fullName}/pull/${pr}`;
}

/**
 * The link a finding shows: the review's own, when it is on this pull request
 * on GitHub, or else the pull request's. A stored URL is what the delivery
 * said, and the page puts it in an `href`.
 */
export function reviewLink(url: string, fullName: string, pr: number): string {
  const base = pullUrl(fullName, pr);
  if (url === base) return url;
  return url.startsWith(base) && /^[#/?]/.test(url.slice(base.length)) ? url : base;
}

export interface ReadDeps {
  repositories: () => Promise<{ id: string; name: string; fullName: string }[]>;
  unfixed: (repoIds: string[]) => Promise<UnfixedFinding[]>;
}

/**
 * Every managed repository with its unfixed findings, `[]` for one with none;
 * `repo` narrows the answer to one, and one this install does not manage is
 * a 404, as the repository routes answer.
 */
export async function readSecurityFindings(deps: ReadDeps, repo: string | null): Promise<SecurityFindingsView> {
  const all = await deps.repositories();
  const listed = repo ? all.filter((one) => one.name === repo) : all;
  if (repo && listed.length === 0) throw new HttpFailure(404, `${repo} is not a repository this install manages.`);
  const found = listed.length > 0 ? await deps.unfixed(listed.map((one) => one.id)) : [];
  return {
    repos: listed.map((one) => ({
      repo: one.name,
      findings: found
        // A row is what `reviewFindings` accepted; one edited by hand to a grade the page has no level for is left out.
        .filter((row) => row.repoId === one.id && Object.prototype.hasOwnProperty.call(PAGE_LEVEL, row.finding.severity))
        .map((row) => ({
          repo: one.name,
          pr: row.prNumber,
          prState: row.prState,
          reviewId: row.reviewId,
          reviewUrl: reviewLink(row.url, one.fullName, row.prNumber),
          reviewedAt: row.submittedAt,
          severity: PAGE_LEVEL[row.finding.severity],
          seatSeverity: row.finding.severity,
          summary: row.finding.summary,
          file: row.finding.file,
          line: row.finding.line,
        })),
    })),
  };
}
