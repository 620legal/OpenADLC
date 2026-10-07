import { GitHubApiError, type GitHubClient } from './client.js';

/**
 * Whether a login can be asked for a review in a repository, as GitHub says.
 *
 * `unknown` is no answer: GitHub could not be asked, or answered with
 * something other than yes or no. Nothing is called missing on it. A rate
 * limit or an outage calling a real reviewer "no such account" would put a
 * blocking card on the board and fail every gate that waits on them.
 */
export type ReviewerStanding =
  | { state: 'can-review' }
  | { state: 'no-account'; reason: string }
  | { state: 'cannot-review'; reason: string }
  | { state: 'not-a-person'; reason: string }
  | { state: 'unknown'; reason: string };

type Asks = Pick<GitHubClient, 'request'>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The account behind a login, as `GET /users/<login>` says: its `type`
 * (`User`, `Organization`, `Bot`) and its numeric `id` when GitHub gave one,
 * false when there is none, and null when GitHub did not say, so the caller
 * can tell "no" from "not asked". The id is what an environment's reviewers
 * take: GitHub refuses a login there.
 */
export async function accountOf(github: Asks, login: string): Promise<{ type: string; id?: number } | false | null> {
  try {
    const user = await github.request<{ type?: unknown; id?: unknown } | null>('GET', `/users/${encodeURIComponent(login)}`);
    const type = typeof user?.type === 'string' ? user.type : 'User';
    return Number.isInteger(user?.id) ? { type, id: user?.id as number } : { type };
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return false;
    return null;
  }
}

/** Whether a GitHub account by this login exists, of any kind; null when GitHub did not say. */
export async function accountExists(github: Asks, login: string): Promise<boolean | null> {
  const account = await accountOf(github, login);
  return account === null ? null : account !== false;
}

/**
 * Asks GitHub whether `login` exists and can review in `repo`.
 *
 * "Can review" is GitHub's own test for a review request: the account is a
 * person, and a collaborator, which for an organization's repository includes
 * its members who reach it through a team or the organization's base
 * permission (`GET /repos/<repo>/collaborators/<login>/permission`). The
 * account is asked about first because that 404 says nothing about why: a
 * login with no account behind it, an organization, and a person nobody
 * invited all answer the same there, and their fixes differ. An organization
 * in particular is never invited: offering to was the advice for `@owner`,
 * the template's placeholder, which GitHub has as an organization.
 *
 * On a public repository anyone can post a review, and the Human review gate
 * reads approvals by login, so a person who is not a collaborator could still
 * approve there. They are called "cannot review" anyway: GitHub will not
 * request their review, and their approval does not count for a code owner or
 * a branch rule, so a gate waiting on them waits until somebody tells them.
 */
export async function reviewerStandingOf(github: Asks, repo: string, login: string): Promise<ReviewerStanding> {
  const account = await accountOf(github, login);
  if (account === null) return { state: 'unknown', reason: `GitHub did not say whether ${login} exists` };
  if (account === false) return { state: 'no-account', reason: 'there is no such GitHub account' };
  if (account.type !== 'User') {
    const kind = account.type === 'Organization' ? 'an organization' : `a ${account.type} account`;
    return { state: 'not-a-person', reason: `${login} is ${kind}, not a person` };
  }
  try {
    // The permission, not `/collaborators/<login>`: that one answered 404 for
    // an organization's owner, who reaches the repository through the
    // organization, and it is answered only to an account that can push —
    // the automation account holds triage, so every answer was "unknown" and
    // a card about a CODEOWNERS already fixed stayed up for good.
    const { permission, role_name: role } = await github.request<{ permission?: string; role_name?: string }>(
      'GET',
      `/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
    );
    if (permission === 'admin' || permission === 'write' || role === 'maintain') return { state: 'can-review' };
    if (!permission || permission === 'none') {
      return { state: 'cannot-review', reason: `${login} is not a collaborator on ${repo}` };
    }
    return {
      state: 'cannot-review',
      reason: `${login} has ${role ?? permission} on ${repo}, and an approval counts only from write or more`,
    };
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      return { state: 'cannot-review', reason: `${login} is not a collaborator on ${repo}` };
    }
    return { state: 'unknown', reason: `GitHub did not say whether ${login} can review in ${repo}: ${messageOf(error).slice(0, 200)}` };
  }
}

/** GitHub's message, out of the body it answered a refused request with. */
function githubWords(error: GitHubApiError): string {
  try {
    const parsed = JSON.parse(error.body) as { message?: unknown; errors?: { message?: unknown }[] };
    const inner = (parsed.errors ?? []).map((entry) => entry.message).filter((entry): entry is string => typeof entry === 'string');
    const words = [typeof parsed.message === 'string' ? parsed.message : '', ...inner].filter(Boolean).join(' ');
    return words || error.body;
  } catch {
    return error.body;
  }
}

const NO_SUCH_USER = /could not resolve (?:to a )?user with (?:the )?login(?: of)? '([^']+)'/i;
const NOT_COLLABORATOR = /not a collaborator|may only be requested from collaborators/i;

/**
 * What a refused review request says about who was asked, or null when the
 * refusal is about something else — a permission the token lacks, the
 * author asked to review their own pull request — which says nothing about
 * whether the login can review.
 *
 * GitHub refuses the whole request for one bad login and names it only when
 * it does not exist; "not a collaborator" says only that one of them is not.
 */
export function reviewRequestRefusal(
  error: unknown,
): { login: string | null; standing: Extract<ReviewerStanding, { state: 'no-account' | 'cannot-review' }>; words: string } | null {
  if (!(error instanceof GitHubApiError) || error.status !== 422) return null;
  const words = githubWords(error);
  const missing = NO_SUCH_USER.exec(words);
  if (missing) return { login: missing[1] ?? null, standing: { state: 'no-account', reason: 'there is no such GitHub account' }, words };
  if (NOT_COLLABORATOR.test(words)) {
    return { login: null, standing: { state: 'cannot-review', reason: 'GitHub says they are not a collaborator' }, words };
  }
  return null;
}

/** How long an answer is trusted before it is asked again: the configuration check refreshes it sooner. */
export const REVIEWER_STANDING_MAX_AGE_MS = 60 * 60_000;

/**
 * How long GitHub is not asked again about a login it gave no answer for.
 * During a rate limit every gate asking again only spends what is left of it.
 */
export const REVIEWER_STANDING_RETRY_MS = 5 * 60_000;

/**
 * GitHub's answers about who can review where, kept for an hour.
 *
 * A pull request's gate is worked out on every review and every sweep; asking
 * GitHub about each named reviewer each time would spend the rate limit on
 * an answer that changes when a person invites someone, which is rare. The
 * repository configuration check asks afresh on its own schedule and writes
 * here, so a fix is seen at its next run. `unknown` is never kept as an
 * answer: an outage neither replaces a known answer nor stands in for one. It
 * only stops `of` asking again for a few minutes, and says `unknown` meanwhile.
 */
export class ReviewerStandings {
  private readonly answers = new Map<string, { standing: ReviewerStanding; at: number }>();
  private readonly unanswered = new Map<string, { standing: ReviewerStanding; at: number }>();

  constructor(private readonly options: { maxAgeMs?: number; retryMs?: number; now?: () => number } = {}) {}

  private key(repo: string, login: string): string {
    return `${repo.toLowerCase()} ${login.toLowerCase()}`;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  /** What is known now, without asking: null when nothing is, or it is too old. */
  known(repo: string, login: string): ReviewerStanding | null {
    const kept = this.answers.get(this.key(repo, login));
    if (!kept) return null;
    if (this.now() - kept.at > (this.options.maxAgeMs ?? REVIEWER_STANDING_MAX_AGE_MS)) return null;
    return kept.standing;
  }

  /** Keeps an answer; an `unknown` one changes nothing that is known. */
  record(repo: string, login: string, standing: ReviewerStanding): void {
    const key = this.key(repo, login);
    if (standing.state === 'unknown') {
      this.unanswered.set(key, { standing, at: this.now() });
      return;
    }
    this.unanswered.delete(key);
    this.answers.set(key, { standing, at: this.now() });
  }

  /**
   * Drops what is kept about a login, in every repository: something changed
   * that the kept answer would not see, such as a bot let into a repository.
   */
  forget(login: string): void {
    const suffix = ` ${login.toLowerCase()}`;
    for (const kept of [this.answers, this.unanswered]) {
      for (const key of [...kept.keys()]) if (key.endsWith(suffix)) kept.delete(key);
    }
  }

  /** Drops everything kept. */
  clear(): void {
    this.answers.clear();
    this.unanswered.clear();
  }

  /** The kept answer, or GitHub's when there is none or `fresh` asks again; kept either way. */
  async of(
    repo: string,
    login: string,
    ask: (repo: string, login: string) => Promise<ReviewerStanding>,
    options: { fresh?: boolean } = {},
  ): Promise<ReviewerStanding> {
    if (!options.fresh) {
      const known = this.known(repo, login);
      if (known) return known;
      const recent = this.unanswered.get(this.key(repo, login));
      if (recent && this.now() - recent.at < (this.options.retryMs ?? REVIEWER_STANDING_RETRY_MS)) return recent.standing;
    }
    const standing = await ask(repo, login).catch((error: unknown): ReviewerStanding => ({ state: 'unknown', reason: messageOf(error) }));
    this.record(repo, login, standing);
    return standing;
  }
}
