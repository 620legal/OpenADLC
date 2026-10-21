import { describe, expect, it, vi } from 'vitest';
import { GitHubApiError } from '@openadlc/github';
import { continuesBranch, endedWithoutPullRequest, openPullRequestUrl, readBranch, workLanded } from './build-left.js';

const BRANCH = 'agent/openadlc-atlas-janedoe/216-issue-216';

/** A client that answers the pulls and compare calls from what it is given. */
function client(answers: { pulls?: { number: number }[]; compare?: { ahead_by: number } | Error }) {
  const request = vi.fn(async (_method: string, path: string) => {
    if (path.includes('/pulls?')) return answers.pulls ?? [];
    if (answers.compare instanceof Error) throw answers.compare;
    return answers.compare ?? { ahead_by: 0 };
  });
  return { request: request as never, calls: request.mock.calls };
}

describe('what GitHub says of a build’s branch', () => {
  it('finds a pull request from the branch, open or not, by its owner and name', async () => {
    const github = client({ pulls: [{ number: 230 }] });
    expect(await readBranch(github, 'janedoe/openadlc-testbed', BRANCH, 'main')).toEqual({ pullRequest: 230, ahead: 0 });
    expect(github.calls[0]?.[1]).toBe(`/repos/janedoe/openadlc-testbed/pulls?state=all&per_page=1&head=${encodeURIComponent(`janedoe:${BRANCH}`)}`);
  });

  it('counts the commits beyond the base when there is none', async () => {
    const github = client({ compare: { ahead_by: 3 } });
    expect(await readBranch(github, 'janedoe/openadlc-testbed', BRANCH, 'main')).toEqual({ pullRequest: null, ahead: 3 });
  });

  it('reads a branch never pushed as no commits', async () => {
    const github = client({ compare: new GitHubApiError(404, '/compare', 'Not Found') });
    expect(await readBranch(github, 'janedoe/openadlc-testbed', BRANCH, 'main')).toEqual({ pullRequest: null, ahead: 0 });
  });

  it('says nothing when GitHub cannot be asked, so nothing is done on a guess', async () => {
    const github = client({ compare: new GitHubApiError(502, '/compare', 'Bad Gateway') });
    expect(await readBranch(github, 'janedoe/openadlc-testbed', BRANCH, 'main')).toBeNull();
  });
});

describe('a build that ended without its pull request', () => {
  const NOW = Date.parse('2026-09-30T20:30:00.000Z');
  const done = { kind: 'implement' as const, state: 'done' as const, branch: BRANCH, endedAt: '2026-09-30T19:56:30.000Z' };

  it('is offered Try again in its thread once the grace period is over, while its issue has no pull request and is still building', () => {
    expect(endedWithoutPullRequest(done, { prNumber: null, stage: 'build' }, NOW)).toBe(true);
    expect(endedWithoutPullRequest({ ...done, endedAt: '2026-09-30T20:29:00.000Z' }, { prNumber: null, stage: 'build' }, NOW)).toBe(false);
    expect(endedWithoutPullRequest(done, { prNumber: 230, stage: 'build' }, NOW)).toBe(false);
    expect(endedWithoutPullRequest(done, { prNumber: null, stage: 'done' }, NOW)).toBe(false);
    expect(endedWithoutPullRequest({ ...done, kind: 'review' }, { prNumber: null, stage: 'build' }, NOW)).toBe(false);
    expect(endedWithoutPullRequest(done, null, NOW)).toBe(false);
  });

  it('goes on from its branch when it ended done, or failed after its second try', () => {
    expect(continuesBranch(done)).toBe(true);
    expect(continuesBranch({ ...done, state: 'failed', exitReason: `finished without opening a pull request: its commits are on ${BRANCH}` })).toBe(true);
    expect(continuesBranch({ ...done, state: 'failed', exitReason: 'engine exited 1' })).toBe(false);
    expect(continuesBranch({ ...done, branch: null })).toBe(false);
  });

  it('is opened from GitHub’s compare page for the branch', () => {
    expect(openPullRequestUrl('janedoe/openadlc-testbed', BRANCH, 'main')).toBe(`https://github.com/janedoe/openadlc-testbed/compare/main...${BRANCH}?expand=1`);
    expect(openPullRequestUrl('janedoe/openadlc-testbed', BRANCH)).toBe(`https://github.com/janedoe/openadlc-testbed/compare/${BRANCH}?expand=1`);
  });
});

describe('work that has landed', () => {
  const failed = { kind: 'implement' as const, subjectRef: 'openadlc-testbed#18', exitReason: 'engine exited 1' };

  it('is work that ends with its subject, on an issue that merged or is done', () => {
    expect(workLanded(failed, { stage: 'merged' })).toBe(true);
    expect(workLanded(failed, { stage: 'done' })).toBe(true);
    for (const kind of ['intake', 'request', 'spec', 'patch', 'review'] as const) {
      expect(workLanded({ ...failed, kind, subjectRef: 'openadlc-testbed#19' }, { stage: 'merged' }), kind).toBe(true);
    }
  });

  it('is work stopped because its subject had closed, whatever stage its issue reads', () => {
    const stopped = { ...failed, exitReason: 'already landed: openadlc-testbed#18 is closed, so the work it was for is finished' };
    expect(workLanded(stopped, { stage: 'build' })).toBe(true);
    expect(workLanded(stopped, null)).toBe(true);
  });

  it('is not work whose issue is still being built or reviewed, or that the board does not know', () => {
    expect(workLanded(failed, { stage: 'build' })).toBe(false);
    expect(workLanded({ ...failed, kind: 'review', subjectRef: 'openadlc-testbed#19' }, { stage: 'review' })).toBe(false);
    expect(workLanded(failed, null)).toBe(false);
  });

  it('is not a deploy or QA task on a merged issue, whose work starts at the merge', () => {
    for (const kind of ['deploy', 'qa'] as const) {
      expect(workLanded({ ...failed, kind, subjectRef: 'openadlc-testbed#19' }, { stage: 'merged' }), kind).toBe(false);
      expect(workLanded({ ...failed, kind, subjectRef: 'openadlc-testbed#19' }, { stage: 'done' }), kind).toBe(false);
    }
  });

  it('is not work on a console request, which has no issue or pull request to close', () => {
    expect(workLanded({ ...failed, kind: 'request', subjectRef: 'request:a4b02784' }, { stage: 'merged' })).toBe(false);
  });
});
