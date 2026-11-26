import { describe, expect, it, vi } from 'vitest';
import type { UnfixedFinding } from '@openadlc/db';
import { PAGE_LEVEL, readSecurityFindings, recordSecurityReview, reviewLink, type ReviewDelivery } from './security-findings.js';

const FINDING = { severity: 'blocker', summary: 'The webhook route skips the HMAC check', file: 'apps/bridge/src/webhooks.ts', line: 412 };
const marker = (fields: Record<string, unknown>) => `Findings below.\n\n<!-- openadlc:${JSON.stringify({ event: 'review_posted', verdict: 'request_changes', lens: 'security', ...fields })} -->`;

function delivery(overrides: Partial<ReviewDelivery> = {}): ReviewDelivery {
  return {
    action: 'submitted',
    repo: { id: 'repo-1', name: 'app', fullName: 'acme/app' },
    fork: false,
    prNumber: 7,
    review: {
      id: 901,
      body: marker({ findings: [FINDING] }),
      html_url: 'https://github.com/acme/app/pull/7#pullrequestreview-901',
      submitted_at: '2026-11-20T10:00:00Z',
      commit_id: 'a'.repeat(40),
    },
    signature: { verified: true, seat: 'Sentinel', task: 'task-1' },
    ...overrides,
  };
}

describe('recording the security seat’s findings', () => {
  it('records a valid list under a verified signature from the security seat', async () => {
    const record = vi.fn(async () => undefined);
    expect(await recordSecurityReview(delivery(), { record, securitySeat: 'sentinel' })).toBe(true);
    expect(record).toHaveBeenCalledWith({
      repoId: 'repo-1',
      prNumber: 7,
      reviewId: 901,
      headSha: 'a'.repeat(40),
      seat: 'sentinel',
      url: 'https://github.com/acme/app/pull/7#pullrequestreview-901',
      submittedAt: new Date('2026-11-20T10:00:00Z'),
      findings: [FINDING],
    });
  });

  it('records an empty list, which is what clears an earlier one', async () => {
    const record = vi.fn(async () => undefined);
    await recordSecurityReview(delivery({ review: { ...delivery().review, body: marker({ verdict: 'approve', findings: [] }) } }), { record, securitySeat: 'sentinel' });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ findings: [] }));
  });

  const refused: [string, Partial<ReviewDelivery>][] = [
    ['an unverified signature', { signature: { verified: false, seat: 'sentinel', task: null } }],
    ['no signature checked', { signature: null }],
    ['a verified signature from the lead’s seat', { signature: { verified: true, seat: 'warden', task: 'task-2' } }],
    ['a fork’s pull request', { fork: true }],
    ['a repository this install does not manage', { repo: null }],
    ['a dismissal', { action: 'dismissed' }],
    ['a marker with no findings', { review: { ...delivery().review, body: marker({}) } }],
    ['a malformed list', { review: { ...delivery().review, body: marker({ findings: [{ ...FINDING, severity: 'high' }] }) } }],
    ['a findings list quoted above the review’s own marker', { review: { ...delivery().review, body: `${marker({ findings: [FINDING] })}\n\nThen I looked again.` } }],
  ];
  it.each(refused)('records nothing for %s', async (_name, overrides) => {
    const record = vi.fn(async () => undefined);
    const warn = vi.fn();
    expect(await recordSecurityReview(delivery(overrides), { record, securitySeat: 'sentinel', warn })).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });

  it('says once that a malformed list was not recorded', async () => {
    const warn = vi.fn();
    await recordSecurityReview(delivery({ review: { ...delivery().review, body: marker({ findings: {} }) } }), { record: vi.fn(), securitySeat: 'sentinel', warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("app#7: the security review's findings list is malformed; nothing recorded");
  });

  it('records nothing when no seat has the security lens', async () => {
    const record = vi.fn(async () => undefined);
    expect(await recordSecurityReview(delivery(), { record, securitySeat: null })).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });
});

describe('the page’s level for each of the seat’s grades', () => {
  it('files blocker, major and minor as high, medium and low, and nothing as critical', () => {
    expect(PAGE_LEVEL).toEqual({ blocker: 'high', major: 'medium', minor: 'low' });
  });
});

describe('the link a finding shows', () => {
  it('keeps the review’s own link on this pull request', () => {
    expect(reviewLink('https://github.com/acme/app/pull/7#pullrequestreview-901', 'acme/app', 7)).toBe('https://github.com/acme/app/pull/7#pullrequestreview-901');
  });

  it('builds the pull request’s link for anything else', () => {
    expect(reviewLink('javascript:alert(1)', 'acme/app', 7)).toBe('https://github.com/acme/app/pull/7');
    expect(reviewLink('https://github.com/acme/app/pull/70#x', 'acme/app', 7)).toBe('https://github.com/acme/app/pull/7');
    expect(reviewLink('https://github.com/acme/app/pull/7.evil.example', 'acme/app', 7)).toBe('https://github.com/acme/app/pull/7');
  });
});

describe('reading the findings for the Security page', () => {
  const repositories = async () => [
    { id: 'repo-1', name: 'app', fullName: 'acme/app' },
    { id: 'repo-2', name: 'site', fullName: 'acme/site' },
  ];
  const row = (severity: string): UnfixedFinding => ({
    repoId: 'repo-1',
    repoName: 'app',
    prNumber: 7,
    prState: 'merged',
    reviewId: 901,
    url: 'https://github.com/acme/app/pull/7#pullrequestreview-901',
    submittedAt: '2026-11-20T10:00:00.000Z',
    finding: { ...FINDING, severity } as UnfixedFinding['finding'],
  });

  it('answers every managed repository, with an empty list for one with none, and the page’s level for each', async () => {
    const unfixed = vi.fn(async () => [row('blocker'), row('major')]);
    const view = await readSecurityFindings({ repositories, unfixed }, null);
    expect(unfixed).toHaveBeenCalledWith(['repo-1', 'repo-2']);
    expect(view.repos.map((entry) => [entry.repo, entry.findings.map((finding) => [finding.severity, finding.seatSeverity])])).toEqual([
      ['app', [['high', 'blocker'], ['medium', 'major']]],
      ['site', []],
    ]);
    expect(view.repos[0]?.findings[0]).toEqual({
      repo: 'app',
      pr: 7,
      prState: 'merged',
      reviewId: 901,
      reviewUrl: 'https://github.com/acme/app/pull/7#pullrequestreview-901',
      reviewedAt: '2026-11-20T10:00:00.000Z',
      severity: 'high',
      seatSeverity: 'blocker',
      summary: FINDING.summary,
      file: FINDING.file,
      line: 412,
    });
  });

  it('narrows to one repository, and answers 404 for one it does not manage', async () => {
    const unfixed = vi.fn(async () => []);
    expect((await readSecurityFindings({ repositories, unfixed }, 'site')).repos).toEqual([{ repo: 'site', findings: [] }]);
    expect(unfixed).toHaveBeenCalledWith(['repo-2']);
    await expect(readSecurityFindings({ repositories, unfixed }, 'nope')).rejects.toMatchObject({ status: 404 });
  });
});
