import { GitHubApiError, type GitHubClient } from '@openadlc/github';
import { ABANDONED_LABEL } from '@openadlc/shared';
import { issueNumberFromBranch } from './work.js';

/**
 * An issue closed without its change merging: closed by a person, or its own
 * pull request closed unmerged. Its card goes to Done labelled
 * `openadlc:abandoned`, so it leaves the columns work is in and nothing reads
 * it as shipped (docs/adr/0006-abandoned-is-a-label.md). The reconciler used
 * to forget such an issue, and the webhook left its row where it was: the
 * card sat in Review with a "Review stopped without agreeing" in Needs you for
 * a pull request that was gone.
 */

/** Why a task on an abandoned issue, or on its pull request, was stopped. */
export const ABANDONED_STOP = 'its issue was closed without merging';

/**
 * What an abandon's stage move records as its reason. A move from Review to
 * Done is otherwise how a merge that ships records itself, and Insights
 * counted an abandon as a merge, with a cycle time; a reopened pull request
 * reads it to tell whether its own close was what abandoned the issue.
 */
export function abandonMoveReason(why: string): string {
  return `${ABANDON_MOVE}${why}`;
}

const ABANDON_MOVE = 'Abandoned: ';

export function isAbandonMove(move: { reason?: string | null }): boolean {
  return Boolean(move.reason?.startsWith(ABANDON_MOVE));
}

/**
 * How a closed issue closed. `merged`: a pull request of this repository
 * merged, its own or one that closed it. `commit`: GitHub closed it with a
 * commit, a push that says `fixes #N` or a pull request of another
 * repository, and no pull request here is known to have merged. `abandoned`:
 * nothing closed it but a person or a bot, however they called the close.
 */
export type HowClosed = { merged: number } | { commit: string } | 'abandoned';

type Asker = Pick<GitHubClient, 'getPullRequest' | 'request'>;

/**
 * Tells an abandon from a merge. GitHub closes an issue at the merge of a pull
 * request that says `Closes #N`, and that `issues.closed` delivery can arrive
 * before the pull request's, with the card still in Review. The close says
 * what closed it in GitHub's timeline (`ClosedEvent.closer`): the merged pull
 * request, or the commit. REST's close event does not: its `commit_id` is null
 * for a pull request's merge too (#33, closed by #42, says nothing else), and
 * a close "as completed" is as much a person's as one "as not planned". The
 * closer covers a person's pull request on a branch not named for the issue,
 * which `mergedPullOf` alone would miss. Undefined when GitHub could not say,
 * which moves nothing: the reconciler asks again.
 */
export async function howClosed(client: Asker, repoFullName: string, known: { number: number; prNumber: number | null }): Promise<HowClosed | undefined> {
  const pull = await mergedPullOf(client, repoFullName, known);
  if (pull === undefined) return undefined;
  if (pull !== null) return { merged: pull };
  return closerOf(client, repoFullName, known.number);
}

/**
 * The pull request that merged a closed issue's change: the one recorded on
 * it, or else one whose branch was cut for it, among the latest closed ones.
 * Null when none did; undefined when GitHub could not be asked, which is no
 * reason to take the issue for abandoned.
 */
export async function mergedPullOf(client: Asker, repoFullName: string, known: { number: number; prNumber: number | null }): Promise<number | null | undefined> {
  try {
    if (known.prNumber) {
      const pull = await client.getPullRequest(repoFullName, known.prNumber).catch((error: unknown) => {
        if (error instanceof GitHubApiError && error.status === 404) return null;
        throw error;
      });
      if (pull?.merged) return pull.number;
    }
    const closed = await client.request<{ number: number; merged_at?: string | null; head?: { ref?: string } }[]>(
      'GET',
      `/repos/${repoFullName}/pulls?state=closed&sort=updated&direction=desc&per_page=100`,
    );
    const found = closed.find((pull) => pull.merged_at && pull.head?.ref && issueNumberFromBranch(pull.head.ref) === known.number);
    return found ? found.number : null;
  } catch {
    return undefined;
  }
}

interface ClosedEventsAnswer {
  data?: {
    repository?: {
      issue?: {
        timelineItems?: {
          nodes?: ({
            closer?:
              | { __typename: 'PullRequest'; number?: number; merged?: boolean; repository?: { nameWithOwner?: string }; mergeCommit?: { oid?: string } | null }
              | { __typename: 'Commit'; oid?: string }
              | { __typename: string }
              | null;
          } | null)[];
        };
      } | null;
    } | null;
  };
  errors?: { message?: string }[];
}

/**
 * What GitHub's timeline says closed the issue at its newest close. A merged
 * pull request of this repository is a merge; one of another repository, or
 * a commit, is a landing by that commit. Anything else is abandoned: no
 * closer, and a closer that ships nothing, such as a Projects board that
 * closes what reaches its Done column (`ProjectV2`). Read as "could not say",
 * that card never moved, and the reconciler said so on every pass. Undefined
 * only when it could not be read, or GitHub lists no close yet.
 */
async function closerOf(client: Pick<GitHubClient, 'request'>, repoFullName: string, issueNumber: number): Promise<HowClosed | undefined> {
  const [owner, name] = repoFullName.split('/');
  try {
    const answer = await client.request<ClosedEventsAnswer>('POST', '/graphql', {
      query:
        'query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { ' +
        'timelineItems(itemTypes: [CLOSED_EVENT], last: 1) { nodes { ... on ClosedEvent { closer { __typename ' +
        '... on PullRequest { number merged repository { nameWithOwner } mergeCommit { oid } } ... on Commit { oid } } } } } } } }',
      variables: { owner, name, number: issueNumber },
    });
    if (answer.errors?.length) return undefined;
    const close = answer.data?.repository?.issue?.timelineItems?.nodes?.filter((node) => node !== null).at(-1);
    if (!close) return undefined;
    const closer = close.closer;
    if (closer?.__typename === 'PullRequest' && 'merged' in closer && closer.merged) {
      const here = closer.repository?.nameWithOwner?.toLowerCase() === repoFullName.toLowerCase();
      if (here && closer.number) return { merged: closer.number };
      return { commit: closer.mergeCommit?.oid ?? '' };
    }
    if (closer?.__typename === 'Commit' && 'oid' in closer) return { commit: closer.oid ?? '' };
    return 'abandoned';
  } catch {
    return undefined;
  }
}

/**
 * Whether GitHub refused a label because the repository does not have it.
 * Adding a missing label creates it, which a triage account may not do: 422,
 * or 403 "You do not have permission to create labels on this repository".
 */
function labelMissing(error: unknown): boolean {
  const status = error instanceof GitHubApiError ? error.status : null;
  return status === 422 || (status === 403 && /create labels/i.test(error instanceof Error ? error.message : String(error)));
}

/**
 * Puts `openadlc:abandoned` on an issue, before the card moves: a dependent
 * that reads the row between the two must never see Done without it, which is
 * shipped. A repository set up before the label existed lacks it, and the app
 * makes it (`RepoSetup.ensureLabel`) for one more try, as Pause does with
 * `openadlc:paused`. Null once it is on; otherwise why it is not, and the card
 * stays where it is for the reconciler to try again.
 */
export async function putAbandonedLabel(
  client: Pick<GitHubClient, 'addLabels'>,
  ensureLabel: ((repoFullName: string, label: string) => Promise<boolean>) | null,
  repoFullName: string,
  issueNumber: number,
): Promise<string | null> {
  const refused = (error: unknown) =>
    `GitHub did not take ${ABANDONED_LABEL} on ${repoFullName}#${issueNumber}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
  try {
    await client.addLabels(repoFullName, issueNumber, [ABANDONED_LABEL]);
    return null;
  } catch (error) {
    if (!labelMissing(error)) return refused(error);
    const made = ensureLabel ? await ensureLabel(repoFullName, ABANDONED_LABEL).catch(() => false) : false;
    if (!made) {
      return `${repoFullName} has no ${ABANDONED_LABEL} label, and OpenADLC could not make it. Set the repository up again from Settings → Repositories.`;
    }
  }
  try {
    await client.addLabels(repoFullName, issueNumber, [ABANDONED_LABEL]);
    return null;
  } catch (error) {
    return refused(error);
  }
}
