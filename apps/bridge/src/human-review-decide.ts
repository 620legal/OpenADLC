import { reviewRequestRefusal, type PullHistoryEntry } from '@openadlc/github';
import { inertMarkup } from '@openadlc/shared';
import { personKey, type FlowView, type GitHubViewer, type PersonFlows } from './person-github.js';
import type { PullRepo } from './pull-commands.js';
import { HttpFailure } from './router.js';

/**
 * A person deciding a crew pull request held for their approval under
 * AGENTS.md's Human review, from the console: Approve, Reject or Discuss. See
 * docs/adr/0036-a-person-decides-a-held-human-review-approval-from-the-console.md.
 *
 * Approve is the person's own GitHub review, posted with the one-post token of
 * ADR 0018 from the account their sign-in linked, pinned to the head they saw:
 * `mergeDecision` counts it exactly as one submitted on GitHub, and nothing
 * about the merge gate changes. Reject needs no sign-in: it is a request for
 * changes, which a console person could already make by messaging the
 * builder, so the bridge checks the linked account and opens the patch round
 * as a person's request for changes on GitHub does. Discuss is the item's
 * message box (`item-routes.ts`), and decides nothing.
 *
 * Hiding a button is not the check. Each decision here is refused unless the
 * viewer's linked account id is the awaited login's, and the head is still the
 * one they saw.
 */

/** Where a console person links their GitHub account. */
export const LINK_ACCOUNT_URL = '/settings#your-github';

/** How long a reason may be: a finding the builder reads, not a document. */
export const REJECT_REASON_LIMIT = 2000;

/** What the console says about the viewer and one held approval. */
export type MayDecide = { yours: true; linkedId: number } | { yours: false; why: string; settingsUrl?: string; status: number };

export interface HumanReviewDeps {
  /** The viewer's linked GitHub account (`person_accounts`), or null. */
  linkOf(identity: string): Promise<{ githubLogin: string; githubUserId: number } | null>;
  /** A login's GitHub account id; null when GitHub could not say. */
  userIdOf(login: string): Promise<number | null>;
  /** The head a pull request waits on `login`'s approval of (`standingPersonAwaits`, `standingPersonAsks`), or null when it no longer does. */
  standing(repo: string, pr: number, login: string): Promise<{ head: string } | null>;
  /** The pull request as GitHub has it now. */
  pull(repo: PullRepo, number: number): Promise<{ open: boolean; head: string; url: string }>;
  flows: Pick<PersonFlows, 'start' | 'state'>;
  isCrew(login: string): Promise<boolean>;
  /** Posts a review with the person's token; the token goes nowhere else. */
  postReviewAsPerson(accessToken: string, fullName: string, number: number, review: { commitId: string; body: string }): Promise<{ id: number; htmlUrl: string }>;
  /** Comments as the app; null when it is not installed on the repository. */
  commentAsApp(fullName: string, number: number, body: string): Promise<{ htmlUrl: string } | null>;
  /** Whether a Reject already sent this pull request's head back (a row with `sentBack: true`). */
  rejected(repo: string, pr: number, head: string): Promise<boolean>;
  audit(entry: { actor: string; action: string; target: string; payload: Record<string, unknown> }): Promise<void>;
  /** Where a record that could not be written is said; `console.warn` when not given. */
  warn?(message: string): void;
  /** Opens the patch round (`SendBack.reviewRound`): null once the builder has it, else why it did not open. */
  sendBack(input: { repo: PullRepo; number: number; by: string; reason: string }): Promise<string | null>;
  /** The pull request's timeline, oldest first, read as the automation account (`listPullHistory`); null when too long to read. */
  history(repo: PullRepo, number: number): Promise<PullHistoryEntry[] | null>;
  /** Asks GitHub to request these reviewers, as the automation account. */
  requestReviewers(fullName: string, number: number, logins: string[]): Promise<void>;
  /** Takes these reviewers' pending requests away, as the automation account. */
  removeReviewRequest(fullName: string, number: number, logins: string[]): Promise<void>;
  /** The newest Remind of `login` on this pull request (`pull.human_review_reminded` at `remindTarget`), from anyone. */
  lastReminded(repo: string, pr: number, login: string): Promise<{ at: string; byName: string } | null>;
  /** How a presser is named on the card: their People name, else null. */
  nameOf(identity: string): Promise<string | null>;
  /** The clock; `Date.now` when not given. */
  now?(): number;
}

/** The audit target a decision is kept under. */
export function decisionTarget(repo: string, pr: number): string {
  return `${repo}#${pr}`;
}

/** The audit target a Remind is kept under: one person on one pull request, the login in lower case. */
export function remindTarget(repo: string, pr: number, login: string): string {
  return `${repo}#${pr}@${login.toLowerCase()}`;
}

/** How often anyone may remind one person about one pull request. */
export const REMIND_EVERY_MS = 60 * 60_000;

/** How long a read of whether GitHub asked the person is kept: a list of cards, and several viewers, read it once. */
export const REQUEST_READ_MS = 60_000;

/** Whether GitHub has a review request out to a person, as read from the pull request's timeline. */
export type ReviewRequest = { state: 'requested'; since: string | null } | { state: 'none' } | { state: 'unknown'; why: string };

/** What a held approval's card says about GitHub's request, and the last Remind. */
export interface ReviewRequestView {
  login: string;
  request: ReviewRequest;
  reminded: { at: string; by: string } | null;
  /** When Remind may be pressed again; null when it may now. */
  remindAfter: string | null;
}

/**
 * Whether GitHub's request to `login` still stands, from the timeline: the
 * newest `review_requested` of them, with no `review_request_removed` of them
 * and no review by them after it. GitHub takes the request away when they
 * review, and the timeline says so only as their review.
 */
export function reviewRequestOf(history: readonly PullHistoryEntry[] | null, login: string): ReviewRequest {
  if (!history) return { state: 'unknown', why: 'the pull request’s timeline is too long to read' };
  const who = login.toLowerCase();
  let since: string | null | undefined;
  for (const entry of history) {
    if (entry.event === 'review_requested' && entry.subject?.toLowerCase() === who) since = entry.at ?? null;
    else if (entry.event === 'review_request_removed' && entry.subject?.toLowerCase() === who) since = undefined;
    else if (entry.event === 'reviewed' && entry.actor?.toLowerCase() === who) since = undefined;
  }
  return since === undefined ? { state: 'none' } : { state: 'requested', since };
}

function minutes(ms: number): number {
  return Math.max(1, Math.ceil(ms / 60_000));
}

export function short(sha: string): string {
  return sha.slice(0, 7);
}

export class HumanReviewDecisions {
  private readonly userIds = new Map<string, number>();
  /** Approve's sign-ins still waiting, by `repo#pr@head#identity`: a second press while one waits posted twice. */
  private readonly signing = new Map<string, { flowId: string; identity: string }>();
  /**
   * Rejects still running, by `repo#pr@head`. The audit row is read before
   * anything is posted and written after, so two quick presses (two tabs)
   * both passed it and posted two comments and opened two rounds.
   */
  private readonly rejecting = new Set<string>();
  /** Reminds still running, by `remindTarget`: taken before the first await, as `rejecting` is. */
  private readonly reminding = new Set<string>();
  /**
   * GitHub's request to a person, as last read, by `remindTarget`: every card
   * and every viewer reading the timeline spent the automation account's rate
   * limit for an answer a minute old would give.
   */
  private readonly requests = new Map<string, { read: number; request: ReviewRequest }>();

  constructor(private readonly deps: HumanReviewDeps) {}

  private warn(message: string): void {
    (this.deps.warn ?? console.warn)(message);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private async userId(login: string): Promise<number | null> {
    const key = login.toLowerCase();
    const kept = this.userIds.get(key);
    if (kept !== undefined) return kept;
    // Only an id GitHub returned is kept, as `PullCommands.userId` keeps it: a
    // failed lookup cached as null refused the person until a restart.
    const id = await this.deps.userIdOf(login).catch(() => null);
    if (typeof id !== 'number') return null;
    this.userIds.set(key, id);
    return id;
  }

  /**
   * Whether the viewer is the person a held approval waits on: their linked
   * account's id is the login's. Matched by id, never by login, as #251's
   * People link is: a login can be renamed and taken by somebody else.
   */
  async mayDecide(identity: string, login: string): Promise<MayDecide> {
    const link = await this.deps.linkOf(personKey(identity)).catch(() => null);
    if (!link) {
      return {
        yours: false,
        status: 409,
        why: `You have not linked a GitHub account. Link it in Settings → Your GitHub account; this is @${login}'s to decide.`,
        settingsUrl: LINK_ACCOUNT_URL,
      };
    }
    const id = await this.userId(login);
    if (id === null) {
      return { yours: false, status: 503, why: `OpenADLC could not ask GitHub who @${login} is just now. Reload in a moment, or decide it on GitHub.` };
    }
    if (link.githubUserId === id) return { yours: true, linkedId: id };
    return { yours: false, status: 403, why: `This is @${login}'s to decide; you can Discuss it.` };
  }

  /** Everything both decisions check before anything is posted, in the order a person can act on. */
  private async check(input: { repo: PullRepo; number: number; login: string; head: string; identity: string }): Promise<{ linkedId: number; url: string }> {
    const { repo, number, login, head } = input;
    if (!/^[0-9a-f]{40}$/i.test(head)) throw new HttpFailure(400, 'head is the commit the decision was shown for');
    const may = await this.mayDecide(input.identity, login);
    if (!may.yours) throw new HttpFailure(may.status, may.why, may.settingsUrl ? { url: may.settingsUrl } : {});
    const standing = await this.deps.standing(repo.name, number, login);
    if (!standing) throw new HttpFailure(409, `Pull request #${number} no longer waits on @${login}'s approval; reload. Nothing was posted.`);
    const pull = await this.deps.pull(repo, number);
    if (!pull.open) throw new HttpFailure(409, `Pull request #${number} is not open; reload. Nothing was posted.`);
    if (pull.head !== head || standing.head !== head) {
      throw new HttpFailure(409, `Pull request #${number} moved to ${short(pull.head)} since you looked; reload and decide on the new head. Nothing was posted.`, {
        url: pull.url,
      });
    }
    return { linkedId: may.linkedId, url: pull.url };
  }

  /**
   * Starts the person's sign-in to approve `head`. Once they approve the code,
   * their own `APPROVE` review is posted with `commit_id` at that head, only if
   * the account that approved is the one linked to them, is no crew account,
   * and the head has not moved meanwhile.
   */
  async approve(input: { repo: PullRepo; number: number; login: string; head: string; identity: string }): Promise<{ flow: Omit<FlowView<unknown>, 'state' | 'result' | 'error'> }> {
    const { repo, number, login, head, identity } = input;
    const { linkedId, url } = await this.check(input);
    const key = `${repo.name}#${number}@${head}#${identity}`;
    const waiting = this.signing.get(key);
    if (waiting && this.deps.flows.state(waiting.flowId, waiting.identity).state === 'waiting') {
      throw new HttpFailure(409, `A sign-in to approve #${number} is still waiting for you; approve that code, or let it expire. Nothing was posted.`);
    }
    const flow = await this.deps.flows.start(
      identity,
      async (viewer: GitHubViewer, accessToken: string) => {
        if (viewer.id !== linkedId) {
          throw new Error(`You approved the code as @${viewer.login}, which is not the GitHub account linked to you here; nothing was posted.`);
        }
        if (await this.deps.isCrew(viewer.login)) throw new Error(`@${viewer.login} is an account the crew uses; nothing was posted.`);
        const now = await this.deps.pull(repo, number);
        if (now.head !== head) throw new Error(`Pull request #${number} moved to ${short(now.head)} while you signed in; nothing was posted. Reload and approve the new head.`);
        const posted = await this.deps.postReviewAsPerson(accessToken, repo.fullName, number, { commitId: head, body: 'Approved from the OpenADLC console.' });
        // The review is posted and counts in `mergeDecision` from here on. A
        // record that cannot be written is said in the log, not to the person:
        // told it failed, they would approve again for nothing.
        await this.deps
          .audit({
            actor: identity,
            action: 'pull.human_review_approved',
            target: decisionTarget(repo.name, number),
            payload: { repo: repo.name, pr: number, login: viewer.login, awaited: login, head, reviewId: posted.id, reviewUrl: posted.htmlUrl, by: identity },
          })
          .catch((error: unknown) =>
            this.warn(`[bridge] @${viewer.login}'s approval of ${repo.name}#${number} at ${short(head)} was posted but not audited: ${error instanceof Error ? error.message : error}`),
          );
        return { commentUrl: posted.htmlUrl };
      },
      { noClientId: `OpenADLC cannot sign in as a person on this install: no GitHub App client id is configured. Approve it on GitHub: ${url}/files` },
    );
    for (const [held, one] of this.signing) if (this.deps.flows.state(one.flowId, one.identity).state !== 'waiting') this.signing.delete(held);
    this.signing.set(key, { flowId: flow.flowId, identity });
    return { flow: { flowId: flow.flowId, userCode: flow.userCode, verificationUri: flow.verificationUri, expiresInSeconds: flow.expiresInSeconds } };
  }

  /**
   * Sends the pull request back to Build with the person's reason as the
   * finding: said on the pull request as the app, audited, and the patch round
   * opened with `by: '@login'`, as their request for changes on GitHub opens it.
   * Once per head that went back: the audit row, written with whether the
   * round opened, is the guard, since the round's own opening clears the item
   * only once it is recorded. A Reject whose round did not open can be tried
   * again: guarded by the row alone, the person was left with a reason posted
   * that nobody acted on and a 409 on every retry.
   */
  async reject(input: { repo: PullRepo; number: number; login: string; head: string; identity: string; reason: string }): Promise<{ state: 'sent_back'; commentUrl: string } | { state: 'not_sent_back'; commentUrl: string; why: string }> {
    const { repo, number, login, head, identity } = input;
    const reason = input.reason.trim();
    if (!reason) throw new HttpFailure(400, 'A reason is required; it is what the builder fixes.');
    if (reason.length > REJECT_REASON_LIMIT) throw new HttpFailure(400, `A reason is at most ${REJECT_REASON_LIMIT} characters; say the finding, and put the rest on the pull request.`);
    // Taken before the first await, so a second press finds it.
    const key = `${repo.name}#${number}@${head}`;
    if (this.rejecting.has(key)) throw new HttpFailure(409, `Pull request #${number} at ${short(head)} is being sent back already; nothing was done again.`);
    this.rejecting.add(key);
    try {
      await this.check(input);
      const already = await this.deps.rejected(repo.name, number, head).catch(() => {
        throw new HttpFailure(503, `OpenADLC cannot tell whether #${number} was already sent back; nothing was done. Try again in a moment.`);
      });
      if (already) throw new HttpFailure(409, `Pull request #${number} at ${short(head)} was already sent back from the console; nothing was done again.`);
      // The person's words go out as the app. Posted as typed, a
      // `<!-- openadlc:{...} -->` in them reached the webhook as the app's own
      // marker (`inertMarkup`, packages/shared/src/markers.ts).
      const quoted = inertMarkup(reason)
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
      const posted = await this.deps.commentAsApp(repo.fullName, number, `@${login} rejected \`${short(head)}\` from the OpenADLC console:\n\n${quoted}`);
      if (!posted) {
        throw new HttpFailure(
          503,
          `OpenADLC cannot post as its app on ${repo.fullName}: the app is not installed there, or its key cannot be read. Nothing was done; request changes on GitHub instead.`,
        );
      }
      const refused = await this.deps
        .sendBack({ repo, number, by: `@${login}`, reason })
        .catch((error: unknown) => (error instanceof Error ? error.message : String(error)) || 'the patch round could not be opened');
      const sentBack = refused === null;
      await this.deps
        .audit({
          actor: identity,
          action: 'pull.human_review_rejected',
          target: decisionTarget(repo.name, number),
          payload: { repo: repo.name, pr: number, login, head, reason, commentUrl: posted.htmlUrl, sentBack, ...(sentBack ? {} : { why: refused }), by: identity },
        })
        .catch((error: unknown) =>
          this.warn(`[bridge] @${login}'s Reject of ${repo.name}#${number} at ${short(head)} was not audited: ${error instanceof Error ? error.message : error}`),
        );
      if (sentBack) return { state: 'sent_back', commentUrl: posted.htmlUrl };
      return {
        state: 'not_sent_back',
        commentUrl: posted.htmlUrl,
        why: `Your reason is on the pull request, but it did not go back to the builder: ${refused}. Reject it again once that is fixed, or request changes on GitHub.`,
      };
    } finally {
      this.rejecting.delete(key);
    }
  }

  /** GitHub's request to the person, read from the timeline at most once a minute per pull request and person. */
  private async request(repo: PullRepo, number: number, login: string): Promise<ReviewRequest> {
    const key = remindTarget(repo.name, number, login);
    const kept = this.requests.get(key);
    if (kept && this.now() - kept.read < REQUEST_READ_MS) return kept.request;
    const read = await this.deps.history(repo, number).then(
      (history) => reviewRequestOf(history, login),
      (error: unknown): ReviewRequest => ({ state: 'unknown', why: `GitHub did not answer (${error instanceof Error ? error.message : String(error)})` }),
    );
    // A failed read is not kept: the next card asks again.
    if (read.state !== 'unknown') this.requests.set(key, { read: this.now(), request: read });
    return read;
  }

  private async reminded(repo: string, pr: number, login: string): Promise<{ at: string; by: string } | null> {
    const last = await this.deps.lastReminded(repo, pr, login);
    return last ? { at: last.at, by: last.byName } : null;
  }

  private remindAfter(reminded: { at: string } | null): string | null {
    if (!reminded) return null;
    const after = Date.parse(reminded.at) + REMIND_EVERY_MS;
    return Number.isFinite(after) && after > this.now() ? new Date(after).toISOString() : null;
  }

  /**
   * What a held approval's card says beside its buttons: whether GitHub has a
   * review request out to the person and since when, and the last Remind. Read
   * by the card on its own route, so `GET /v1/attention` still makes no GitHub
   * call (ADR 0036, ADR 0057).
   */
  async requestStatus(input: { repo: PullRepo; number: number; login: string }): Promise<ReviewRequestView> {
    const { repo, number, login } = input;
    const [request, reminded] = await Promise.all([
      this.request(repo, number, login),
      this.reminded(repo.name, number, login).catch((error: unknown) => {
        this.warn(`[bridge] the last Remind of @${login} on ${repo.name}#${number} could not be read: ${error instanceof Error ? error.message : error}`);
        return null;
      }),
    ]);
    return { login, request, reminded, remindAfter: this.remindAfter(reminded) };
  }

  /**
   * Asks GitHub to request the awaited person's review again, as the
   * automation account, so GitHub notifies them: the one way to reach someone
   * People does not have. It decides nothing, so anyone the card reaches may
   * press it; once an hour per pull request and person, from anyone, so ten
   * approvers do not send ten requests. GitHub adds nothing, and notifies no
   * one, for a reviewer already requested, so a pending request is taken away
   * first. Should the request then fail, the person reads as no longer asked
   * on GitHub while OpenADLC still holds the pull request for them: it fails
   * closed.
   */
  async remind(input: { repo: PullRepo; number: number; login: string; identity: string }): Promise<{ reminded: { at: string; by: string }; remindAfter: string }> {
    const { repo, number, login, identity } = input;
    const key = remindTarget(repo.name, number, login);
    if (this.reminding.has(key)) throw new HttpFailure(409, `@${login} is being reminded about #${number} already; nothing was sent again.`);
    this.reminding.add(key);
    try {
      const standing = await this.deps.standing(repo.name, number, login);
      if (!standing) throw new HttpFailure(409, `Pull request #${number} no longer waits on @${login}'s approval; reload. Nothing was sent.`);
      const last = await this.deps.lastReminded(repo.name, number, login).catch(() => {
        throw new HttpFailure(503, `OpenADLC cannot tell when @${login} was last reminded; nothing was sent. Try again in a moment.`);
      });
      if (last) {
        const since = this.now() - Date.parse(last.at);
        if (since < REMIND_EVERY_MS) {
          const ago = Math.max(0, Math.floor(since / 60_000));
          throw new HttpFailure(
            429,
            `@${login} was reminded ${ago === 0 ? 'just now' : `${ago} min ago`} by ${last.byName}. You can remind them again in ${minutes(REMIND_EVERY_MS - since)} min.`,
            { remindAfter: new Date(Date.parse(last.at) + REMIND_EVERY_MS).toISOString() },
          );
        }
      }
      const pull = await this.deps.pull(repo, number);
      if (!pull.open) throw new HttpFailure(409, `Pull request #${number} is not open; reload. Nothing was sent.`);
      // Read now, not from the minute's copy: a request someone took away on
      // GitHub meanwhile would be removed for nothing.
      this.requests.delete(key);
      const pending = (await this.request(repo, number, login)).state === 'requested';
      try {
        if (pending) await this.deps.removeReviewRequest(repo.fullName, number, [login]);
        await this.deps.requestReviewers(repo.fullName, number, [login]);
      } catch (error) {
        const refusal = reviewRequestRefusal(error);
        if (refusal) {
          throw new HttpFailure(409, `GitHub would not ask @${login}: ${refusal.words}. They need write access to ${repo.fullName}; see Troubleshooting.`);
        }
        throw new HttpFailure(502, `GitHub did not take the request to @${login}: ${error instanceof Error ? error.message : String(error)}. Nothing was recorded; try again in a moment.`);
      } finally {
        this.requests.delete(key);
      }
      const byName = (await this.deps.nameOf(identity).catch(() => null)) ?? personKey(identity);
      const at = new Date(this.now()).toISOString();
      // GitHub already asked. A record that cannot be written is said in the
      // log, not to the person: told it failed, they would press it again.
      await this.deps
        .audit({
          actor: identity,
          action: 'pull.human_review_reminded',
          target: key,
          payload: { repo: repo.name, pr: number, login, head: standing.head, by: identity, byName, removedFirst: pending },
        })
        .catch((error: unknown) => this.warn(`[bridge] the Remind of @${login} on ${repo.name}#${number} was sent but not audited: ${error instanceof Error ? error.message : error}`));
      return { reminded: { at, by: byName }, remindAfter: new Date(Date.parse(at) + REMIND_EVERY_MS).toISOString() };
    } finally {
      this.reminding.delete(key);
    }
  }
}

