import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({ query: vi.fn() }));

import type { ReviewFinding } from '@openadlc/shared';
import { query } from '../client.js';
import { record, unfixed, unfixedFrom, UNFIXED_PER_REPO, type LatestReview } from './security-reviews.js';

const HMAC: ReviewFinding = { severity: 'blocker', summary: 'The webhook skips the HMAC check', file: 'apps/bridge/src/webhooks.ts', line: 412 };
const LOG: ReviewFinding = { severity: 'minor', summary: 'Logs the token length', file: 'apps/bridge/src/log.ts', line: null };

function review(prNumber: number, prState: LatestReview['prState'], at: string, findings: ReviewFinding[], reviewId = prNumber * 10): LatestReview {
  return {
    repoId: 'repo-1',
    repoName: 'app',
    prNumber,
    prState,
    reviewId,
    url: `https://github.com/acme/app/pull/${prNumber}#pullrequestreview-${reviewId}`,
    submittedAt: `2026-11-20T${at}:00.000Z`,
    findings,
  };
}

const prs = (list: { prNumber: number; finding: ReviewFinding }[]) => list.map((entry) => [entry.prNumber, entry.finding.summary]);

beforeEach(() => vi.mocked(query).mockReset());

describe('0172, the security seat’s reviews', () => {
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations', '0172_security_reviews.sql'), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
    .toLowerCase();

  it('adds one table, keyed by GitHub’s review id, and changes nothing that exists', () => {
    expect(sql).toContain('create table if not exists security_reviews');
    expect(sql).toContain('review_id bigint not null unique');
    expect(sql).toContain('findings jsonb not null');
    expect(sql).not.toMatch(/alter table|drop |update |delete from/);
    // The state is read from work_item_links, never copied.
    expect(sql).not.toContain('state');
  });
});

describe('recording a security review', () => {
  it('upserts on the review id, so an edit leaves one row with the edit’s list', async () => {
    vi.mocked(query).mockResolvedValue([]);
    const input = { repoId: 'repo-1', prNumber: 7, reviewId: 901, headSha: 'a'.repeat(40), seat: 'sentinel', url: 'https://github.com/acme/app/pull/7', submittedAt: new Date('2026-11-20T10:00:00Z') };
    await record({ ...input, findings: [HMAC, LOG] });
    await record({ ...input, findings: [LOG] });
    const [first, second] = vi.mocked(query).mock.calls;
    expect(second?.[0]).toContain('on conflict (review_id) do update');
    expect(second?.[0]).toContain('findings = excluded.findings');
    expect(first?.[1]?.[2]).toBe(901);
    expect(JSON.parse(second?.[1]?.[7] as string)).toEqual([LOG]);
  });
});

describe('which findings are unfixed', () => {
  it('lists the latest review’s findings on a merged pull request', () => {
    expect(prs(unfixedFrom([review(1, 'merged', '10:00', [HMAC])]))).toEqual([[1, HMAC.summary]]);
  });

  it('lists them on one closed without merging', () => {
    expect(prs(unfixedFrom([review(2, 'closed', '10:00', [HMAC])]))).toEqual([[2, HMAC.summary]]);
  });

  it('lists nothing for one still open, or reopened', () => {
    expect(unfixedFrom([review(3, 'open', '10:00', [HMAC, LOG])])).toEqual([]);
  });

  it('lists nothing for one with no link row', () => {
    expect(unfixedFrom([review(4, null, '10:00', [HMAC])])).toEqual([]);
  });

  it('lists nothing once a later review’s list is empty', () => {
    expect(unfixedFrom([review(5, 'merged', '11:00', [], 52), review(5, 'merged', '10:00', [HMAC, LOG], 51)])).toEqual([]);
  });

  it('lists only what a later review still lists', () => {
    expect(prs(unfixedFrom([review(6, 'merged', '10:00', [HMAC, LOG], 61), review(6, 'merged', '11:00', [LOG], 62)]))).toEqual([[6, LOG.summary]]);
  });

  it('breaks a tie in time by the review id', () => {
    expect(prs(unfixedFrom([review(8, 'merged', '10:00', [LOG], 82), review(8, 'merged', '10:00', [HMAC], 81)]))).toEqual([[8, LOG.summary]]);
  });

  it('lists newest first, and at most the cap for one repository', () => {
    const many = Array.from({ length: UNFIXED_PER_REPO + 5 }, () => LOG);
    const listed = unfixedFrom([review(9, 'merged', '09:00', [HMAC]), review(10, 'closed', '12:00', many)]);
    expect(listed).toHaveLength(UNFIXED_PER_REPO);
    expect(listed.every((entry) => entry.prNumber === 10)).toBe(true);
  });

  it('reads each pull request’s latest stored review with its state, and leaves a later review with no list out of it', async () => {
    // A review with no list has no row, so the query answers the earlier one.
    vi.mocked(query).mockResolvedValue([
      {
        repo_id: 'repo-1',
        repo_name: 'app',
        pr_number: 7,
        pr_state: 'merged',
        review_id: '901',
        url: 'https://github.com/acme/app/pull/7#pullrequestreview-901',
        submitted_at: new Date('2026-11-20T10:00:00Z'),
        findings: [HMAC],
      },
    ]);
    const listed = await unfixed(['repo-1']);
    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(sql).toContain('distinct on (s.repo_id, s.pr_number)');
    expect(sql).toContain('order by s.repo_id, s.pr_number, s.submitted_at desc, s.review_id desc');
    expect(sql).toContain("left join work_item_links l on l.kind = 'pull'");
    expect(params).toEqual([['repo-1']]);
    expect(listed).toEqual([
      { repoId: 'repo-1', repoName: 'app', prNumber: 7, prState: 'merged', reviewId: 901, url: 'https://github.com/acme/app/pull/7#pullrequestreview-901', submittedAt: '2026-11-20T10:00:00.000Z', finding: HMAC },
    ]);
  });

  it('asks nothing for an empty list of repositories', async () => {
    expect(await unfixed([])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
