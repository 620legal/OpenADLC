/**
 * What a signature is, and what counting only signed posts changes.
 *
 * Settings → GitHub and an unsigned post's steps both tell a person whether
 * to turn enforcement on. They used to say it differently — one "still
 * counts", the other "counts for nothing" — so the choice depended on which
 * page was open. Both read these words.
 */

/** One line under Signed posts: why a signature is there at all. */
export const SIGNED_POSTS_LINE =
  'Proves each crew post was written by OpenADLC for the seat it names, so reviews and answers can’t be forged by anyone signed in as a crew account.';

/** The (i) beside that line, for someone who cannot see the mark. */
export const ABOUT_SIGNED_POSTS = 'About signed posts';

export const SIGNATURE_PROVES_TITLE = 'What a signature proves';

/** What the bridge's HMAC actually covers. See `packages/shared/src/signature.ts`. */
export const SIGNATURE_PROVES = [
  'The post came through OpenADLC, for that seat and task, and for the task’s repository when it has one.',
  'A comment or review names the issue or pull request it is on, and checks nowhere else.',
  'A new issue or pull request has no number yet: it is tied to the first place it is seen.',
  'The body has not changed since.',
  'It is not a copy of another post.',
] as const;

export const SIGNATURE_DOES_NOT_TITLE = 'What it does not prove';

export const SIGNATURE_DOES_NOT =
  'That the content is correct, or who at the keyboard started the task.';

export const COUNT_ONLY_SIGNED_TITLE = 'What “Count only signed posts” changes';

/** An unsigned crew post, once the install counts only what it signed. */
export const UNSIGNED_IGNORED =
  'An unsigned crew post is ignored: no review toward the gate, no answer to a question, no stage change.';

/** Enforcement does not hide the post. The board still shows it. */
export const UNSIGNED_SHOWN = 'It is shown on the board.';

/**
 * Reviewer seats on one GitHub account. A seat tag alone is the account's own
 * word, which any seat's session could write, so on that account the lead's
 * review and a blocking seat's count only when their signature checks, in
 * either mode (`checkedForSharedSeats` in the bridge's `automation.ts`).
 */
export const SHARED_REVIEWER_RULE =
  'Reviewer seats sharing one GitHub account are told apart by signature: on that account, the lead’s review and a blocking reviewer’s count only when signed, whether or not this is on.';

/** What the switch does, in the same words the unsigned-post steps use. */
export const COUNT_ONLY_SIGNED_CHANGES = `${UNSIGNED_IGNORED} ${UNSIGNED_SHOWN} ${SHARED_REVIEWER_RULE}`;

export const RECORDING_ONLY_TITLE = 'Recording only';

/** The default: `attributionMode` `audit`. */
export const RECORDING_ONLY = 'The default. Unsigned posts are shown and still count.';

/**
 * Whether the post the card is about counted. Audit still counts it; enforce
 * does not. The card and the steps say which, in these words.
 */
export function thisPostCounted(counted: boolean): string {
  return counted
    ? 'It counted: this install still counts unsigned posts.'
    : 'It did not count: this install counts only what OpenADLC signed.';
}

export const TRADEOFFS_TITLE = 'Trade-offs';

export const TRADEOFFS = [
  'Editing a bot’s post by hand on GitHub makes it unsigned.',
  'Posting by hand as a bot account doesn’t count.',
  'Keep the signing key in backups. A restore needs the attribution-key secret, or earlier posts stop checking.',
  'The key is in this install’s secret store and its backups: anyone who can read either can sign as the crew.',
  'A rotated key keeps checking old posts for 30 days, unless it was dropped after a leak (fleetadlc attribution rotate --drop-old).',
] as const;

export const WHEN_TO_TURN_ON_TITLE = 'When to turn it on';

export const WHEN_TO_TURN_ON =
  'When reviewers share an account, when bot accounts’ credentials are shared with people, or after an unsigned post appears on the board.';

/** Reviewer seats: what is counted when the bridge does not say which seats approve. */
const REVIEWER_ROLES = new Set(['review_lead', 'review_second', 'review_security']);

/** Two or more reviewer seats signing in as one GitHub account. */
export interface SharedReviewers {
  /** The account, as GitHub spells it. */
  login: string;
  /** How many reviewer seats sign in as it. */
  count: number;
  /**
   * Counted from the seats whose approval the merge needs, as the bridge
   * said. Absent when it did not say, and every reviewer seat was counted.
   */
  required?: true;
}

const COUNT_WORD = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];

/**
 * The account the most reviewer seats share, if any two do.
 *
 * A crew account several builders share is not this: only reviewer seats
 * approve, and the lead's or a blocking seat's approval on a shared login
 * counts only when signed. When the bridge says which seats approve (the lead
 * and any marked `blocking` in config/review.yaml), only those are counted.
 */
export function sharedReviewersFromAccounts(
  accounts: readonly { login: string; seats: readonly { role: string; approves?: boolean }[] }[],
): SharedReviewers | null {
  const told = accounts.some((account) => account.seats.some((seat) => typeof seat.approves === 'boolean'));
  let best: SharedReviewers | null = null;
  for (const account of accounts) {
    const count = account.seats.filter((seat) => (told ? seat.approves === true : REVIEWER_ROLES.has(seat.role))).length;
    if (count < 2) continue;
    if (!best || count > best.count) best = { login: account.login, count, ...(told ? { required: true as const } : {}) };
  }
  return best;
}

/**
 * Whether shared reviewers apply to this install, after the accounts have
 * been read. `unknown` is a read that failed: saying they do not share would
 * be the wrong advice on the install where they do.
 */
export function sharedReviewerConsequence(shared: SharedReviewers | null | 'unknown' | 'loading'): string {
  if (shared === 'loading') return `${SHARED_REVIEWER_RULE} Whether that applies to this install is still being read.`;
  if (shared === 'unknown') return `${SHARED_REVIEWER_RULE} Whether that applies to this install could not be read.`;
  if (!shared) return `${SHARED_REVIEWER_RULE} This install’s reviewers do not share an account, so that does not apply today.`;
  const how = COUNT_WORD[shared.count] ?? String(shared.count);
  if (shared.required) {
    return `${SHARED_REVIEWER_RULE} ${how} reviewers whose approval the merge needs sign in as ${shared.login}. Their approvals from that account count only when OpenADLC signed them.`;
  }
  const who = shared.count === 3 ? 'The three reviewers' : `${how} reviewers`;
  return `${SHARED_REVIEWER_RULE} ${who} sign in as ${shared.login}. That matters only for the lead and seats marked blocking in config/review.yaml: the lead’s review from that account counts only when OpenADLC signed it.`;
}
