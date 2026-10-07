import type { GitHubClient } from '@fleetadlc/github';
import { STAGE_KEYS, type TaskKind, type TaskState } from '@fleetadlc/shared';
import { endedBySendingBack, stageOfTask, type IssueFacts } from './work.js';

/**
 * Whether a build that ended `done` left the pull request it was for.
 *
 * A builder's task ends when its engine does, and an engine can end one step
 * short: once, the builder pushed three commits, started the test
 * suites in the background, said it would open the pull request once they
 * reported back, and its session ended six seconds later. The task read
 * `done`, the recovery takes a `done` task at its word, the lease waited
 * twelve hours for a pull request that was never coming, and nothing on the
 * board said so.
 *
 * So a finished build is looked at again once GitHub has had time to say a
 * pull request opened (`PULL_REQUEST_GRACE_MS`). One with commits on its
 * branch and no pull request is continued on that branch, once; one with no
 * commits failed. See `continueBuildsWithoutPullRequest` in `scheduler.ts`.
 */

/**
 * How long after a build ends its pull request may still be on its way: the
 * webhook that links it to the issue can land a little after the session
 * ended.
 */
export const PULL_REQUEST_GRACE_MS = 2 * 60 * 1000;

/** How the reason begins for a build continued once that still ended without its pull request; the card knows it by this. */
export const NO_PULL_REQUEST = 'finished without opening a pull request';

/** How the reason begins for a build that ended with nothing pushed and no pull request. */
export const NOTHING_PUSHED = 'finished without pushing a commit or opening a pull request';

/** The reason a continued build that still left no pull request failed with. */
export function noPullRequest(branch: string): string {
  return `${NO_PULL_REQUEST}: its commits are on ${branch}, and a second try on that branch did not open one either`;
}

/** The reason a build that pushed nothing failed with. */
export function nothingPushed(branch: string): string {
  return `${NOTHING_PUSHED}: ${branch} has no commits beyond the base`;
}

/** What GitHub says of a build's branch. */
export interface BranchFacts {
  /** A pull request from the branch, open or not; null when there is none. */
  pullRequest: number | null;
  /** How many commits the branch has beyond the base; 0 when the branch was never pushed. */
  ahead: number;
}

/**
 * Reads a build's branch from GitHub: its pull request, and how far it is
 * ahead of the base. Null when GitHub cannot be asked, so a build is never
 * failed or run again on a guess.
 */
export async function readBranch(
  client: Pick<GitHubClient, 'request'>,
  repoFullName: string,
  branch: string,
  base: string,
): Promise<BranchFacts | null> {
  const owner = repoFullName.split('/')[0] ?? '';
  try {
    const pulls = await client.request<{ number: number }[]>(
      'GET',
      `/repos/${repoFullName}/pulls?state=all&per_page=1&head=${encodeURIComponent(`${owner}:${branch}`)}`,
    );
    if (pulls[0]) return { pullRequest: pulls[0].number, ahead: 0 };
    const comparison = await client
      .request<{ ahead_by: number }>('GET', `/repos/${repoFullName}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}`)
      .catch((error: unknown) => {
        // A branch never pushed is not there to compare: nothing was pushed.
        // Read by its status rather than `instanceof GitHubApiError`, so the
        // board's and the retry's modules, which import this, do not load the
        // GitHub client for it.
        if ((error as { status?: unknown } | null)?.status === 404) return { ahead_by: 0 };
        throw error;
      });
    return { pullRequest: null, ahead: comparison.ahead_by };
  } catch {
    return null;
  }
}

/**
 * Where a person opens the pull request the builder did not: GitHub's compare
 * page for the pushed branch, against the base when it is known.
 */
export function openPullRequestUrl(repoFullName: string, branch: string, base?: string | null): string {
  return `https://github.com/${repoFullName}/compare/${base ? `${base}...` : ''}${branch}?expand=1`;
}

/**
 * Whether running a build again goes on from the branch it pushed: it ended
 * `done` without opening its pull request, or failed for that once it had
 * been continued (`continueBuildsWithoutPullRequest`). Either way its commits are on the branch,
 * and a build started from the base would redo them.
 */
export function continuesBranch(task: { kind: TaskKind; state: TaskState; branch?: string | null; exitReason?: string | null }): boolean {
  if (task.kind !== 'implement' || !task.branch || endedBySendingBack(task.exitReason)) return false;
  return task.state === 'done' || (task.state === 'failed' && Boolean(task.exitReason?.startsWith(NO_PULL_REQUEST)));
}

/**
 * Whether a build's thread offers Try again although it ended `done`: its
 * issue has no pull request a grace period after it ended, and is still at
 * building or before. The console's thread panel reads this; the board has
 * the card once the sweep has looked (`continueBuildsWithoutPullRequest`).
 */
export function endedWithoutPullRequest(
  task: { kind: TaskKind; state: TaskState; branch?: string | null; endedAt: string | null; exitReason?: string | null },
  issue: Pick<IssueFacts, 'prNumber' | 'stage'> | null | undefined,
  now = Date.now(),
): boolean {
  if (task.kind !== 'implement' || task.state !== 'done' || !task.branch || !task.endedAt || !issue || issue.prNumber) return false;
  if (endedBySendingBack(task.exitReason)) return false;
  if (now - Date.parse(task.endedAt) < PULL_REQUEST_GRACE_MS) return false;
  return (STAGE_KEYS as readonly string[]).indexOf(issue.stage) <= (STAGE_KEYS as readonly string[]).indexOf(stageOfTask(task.kind));
}
