import { parseMarker, postedBySeat, withoutMarker, type Task } from '@fleetadlc/shared';

/**
 * Whether a review task left the review it was for.
 *
 * A reviewer's task ends when its engine does, and an engine can end having
 * done nothing: a Codex reviewer that could not run a single command in its
 * container said so and stopped, and its task read "done". Nothing moves a
 * pull request on when a review task ends — the review gate waits on the
 * review itself — so the pull request sat at "Waiting for the reviewers", and
 * nothing on the board said anybody had anything to do.
 *
 * A review task that ends without a review from its bot, posted while it ran,
 * has failed, and says so with what the bot last said.
 */

/** How far this machine's clock may be from GitHub's before a review is misplaced in time. */
const CLOCK_SLACK_MS = 2 * 60 * 1000;

/** What the reason quotes of the bot, at most: the card shows a sentence of it, Details the rest. */
const SAID_LIMIT = 600;

export interface PostedReview {
  user: string;
  body?: string | null;
  submittedAt: string | null;
}

export interface ReviewLeftInput {
  task: Pick<Task, 'kind' | 'subjectRef' | 'startedAt'>;
  /** The bot's GitHub login, which its reviews are posted under; null when it has none. */
  login: string | null;
  /** The bot's seat: on an account the reviewers share, another reviewer's review is not this one's. */
  seat?: string | null;
  /** The pull request's reviews, as GitHub lists them. */
  reviews: (number: number) => Promise<PostedReview[]>;
  /** The last thing the bot said in its thread while the task ran. */
  lastSaid: () => Promise<string | null>;
}

/**
 * The reason a finished review task failed, or null when it left its review —
 * or when that cannot be told: a task is never failed on a guess, so a GitHub
 * that cannot be asked leaves it done.
 */
export async function missingReview(input: ReviewLeftInput): Promise<string | null> {
  if (input.task.kind !== 'review' || !input.login) return null;
  const number = Number(input.task.subjectRef.split('#')[1] ?? '');
  if (!Number.isInteger(number) || number <= 0) return null;

  let reviews: PostedReview[];
  try {
    reviews = await input.reviews(number);
  } catch {
    return null;
  }

  const since = input.task.startedAt ? Date.parse(input.task.startedAt) - CLOCK_SLACK_MS : Number.NEGATIVE_INFINITY;
  const left = reviews.some(
    (review) =>
      postedBySeat(review, input.login, input.seat) && review.submittedAt !== null && Date.parse(review.submittedAt) >= since,
  );
  if (left) return null;

  const lastSaid = (await input.lastSaid().catch(() => null)) ?? '';
  // Its review, written in its answer and marked as posted, when nothing was:
  // a Codex reviewer ran the checks, wrote "Verdict: approve" and stopped.
  const claimed = parseMarker(lastSaid)?.event === 'review_posted';
  const said = withoutMarker(lastSaid).trim();
  const head = claimed ? NOT_POSTED : NO_REVIEW;
  if (!said) return head;
  const clipped = said.length > SAID_LIMIT ? `${said.slice(0, SAID_LIMIT - 1).trimEnd()}…` : said;
  return `${head}. It said: “${clipped}”`;
}

/** How the reason begins, which is how the words for its card know it. */
export const NO_REVIEW = 'ended without posting its review';

/** The same, when the bot wrote its review and never put it on the pull request. */
export const NOT_POSTED = `${NO_REVIEW}: it wrote one in its answer and did not post it`;
