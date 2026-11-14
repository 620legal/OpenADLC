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
 *
 * On a person's own pull request GitHub refuses the review: its author cannot
 * approve it. When the person awaited is its author, Approve is their sign-off
 * instead (docs/adr/0063-an-author-who-is-the-named-person-signs-off-in-the-console.md):
 * the same sign-in proves it is them, People must have Approves on for that
 * account, and it is recorded in `person_sign_offs` and audited, which
 * `review-gate` and `mergeDecision` count for their login only. Nothing is
 * posted. When the person awaited is not its author, the card is for
 * information only and they approve it on GitHub, as before.
 */

/** Where a console person links their GitHub account. */
export const LINK_ACCOUNT_URL = '/settings#your-github';

/** Where an admin turns Approves on for a person. */
export const PEOPLE_URL = '/settings#people';

/** Why an author's sign-off is refused when People does not let them approve. */
export const APPROVES_OFF = 'Approves is off for you in People; an admin turns it on in Settings → People, or a reviewer approves it on GitHub.';

/** How long a reason may be: a finding the builder reads, not a document. */
export const REJECT_REASON_LIMIT = 2000;

/** The audit action of a refused Approve (#328): seen afterwards, and read by nothing that decides. */
export const APPROVAL_REFUSED = 'pull.human_review_approval_refused';

/** Why an Approve was refused, as its `pull.human_review_approval_refused` row says. */
export type ApprovalRefusalReason =
  | 'not_linked'
  | 'not_awaited'
  | 'not_waiting'
  | 'not_open'
  | 'head_moved'
  | 'on_github'
  | 'approves_off'
  | 'other_account'
  | 'crew_account'
  | 'author_changed';

/** What an Approve learned before it was refused, for its audit row. */
interface ApproveSeen {
  linkedLogin: string | null;
  linkedId: number | null;
  how: 'review' | 'sign_off' | null;
}

/** What the console says about the viewer and one held approval. */
export type MayDecide = { yours: true; linkedId: number } | { yours: false; why: string; settingsUrl?: string; status: number };

export interface HumanReviewDeps {
  /** The viewer's linked GitHub account (`person_accounts`), or null. */
  linkOf(identity: string): Promise<{ githubLogin: string; githubUserId: number } | null>;
  /** A login's GitHub account id; null when GitHub could not say. */
  userIdOf(login: string): Promise<number | null>;
  /** The head a pull request waits on `login`'s approval of (`standingPersonAwaits`, `standingPersonAsks`), or null when it no longer does. */
  standing(repo: string, pr: number, login: string): Promise<{ head: string } | null>;
  /**
   * The pull request as GitHub has it now, with who opened it: its login and
   * account id, null when GitHub did not say, which is decided as a crew pull
   * request's was.
   */
  pull(repo: PullRepo, number: number): Promise<{ open: boolean; head: string; url: string; author?: { login: string; id: number } | null }>;
  flows: Pick<PersonFlows, 'start' | 'state'>;
  isCrew(login: string): Promise<boolean>;
  /** Whether People has Approves on for the person this account is linked to (`people.approves`); false for nobody in People. */
  approves(githubUserId: number): Promise<boolean>;
  /**
   * The author's sign-off of their own pull request (`person_sign_offs`), the
   * only writer of it, written with its audit entry in one transaction: both
   * land or neither does. It answers the row already there for a head and
   * account with `created: false`.
   */
  signOff: {
    record(
      input: { repo: string; pr: number; head: string; githubUserId: number; githubLogin: string; identity: string },
      audit: { actor: string; action: string; target: string; payload: Record<string, unknown> },
    ): Promise<{ id: string; created: boolean }>;
  };
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

  /**
   * A refusal's reason, kept beside the error rather than in it, so the person
   * is refused with the very error they were before (#328). An error with no
   * entry is a failure, not a decision about who or what, and is not audited.
   */
  private readonly refusals = new WeakMap<Error, { reason: ApprovalRefusalReason; extra: Record<string, unknown> }>();

  constructor(private readonly deps: HumanReviewDeps) {}

  private refused<E extends Error>(error: E, reason: ApprovalRefusalReason, extra: Record<string, unknown> = {}): E {
    this.refusals.set(error, { reason, extra });
    return error;
  }

  /**
   * Audits a refused Approve, for the caller to throw unchanged. Before #328
   * only an Approve that went through was audited, so who tried to approve
   * what, and why it did not count, was in no record. A row that cannot be
   * written is said in the log: the person is refused all the same.
   */
  private async auditRefusal(
    error: unknown,
    at: {
      repo: PullRepo;
      number: number;
      login: string;
      head: string;
      identity: string;
      seen: ApproveSeen;
      stage: 'before_sign_in' | 'after_sign_in';
      viewer?: GitHubViewer;
    },
  ): Promise<void> {
    const refusal = error instanceof Error ? this.refusals.get(error) : undefined;
    if (!refusal) return;
    const { repo, number, login, head, identity, seen, stage, viewer } = at;
    await this.deps
      .audit({
        actor: identity,
        action: APPROVAL_REFUSED,
        target: decisionTarget(repo.name, number),
        payload: {
          repo: repo.name,
          pr: number,
          awaited: login,
          head,
          reason: refusal.reason,
          why: (error as Error).message,
          how: seen.how,
          linkedLogin: seen.linkedLogin,
          linkedId: seen.linkedId,
          stage,
          by: identity,
          ...(viewer ? { login: viewer.login, githubUserId: viewer.id } : {}),
          ...refusal.extra,
        },
      })
      .catch((failure: unknown) =>
        this.warn(`[bridge] ${identity}'s refused Approve of ${repo.name}#${number} at ${short(head)} was not audited: ${failure instanceof Error ? failure.message : failure}`),
      );
  }

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
    return (await this.decide(identity, login)).may;
  }

  /** `mayDecide`, with the linked account it read, so a refused Approve's audit row names it without a second read. */
  private async decide(identity: string, login: string): Promise<{ may: MayDecide; link: { githubLogin: string; githubUserId: number } | null }> {
    const link = await this.deps.linkOf(personKey(identity)).catch(() => null);
    return { may: await this.decided(link, login), link };
  }

  private async decided(link: { githubUserId: number } | null, login: string): Promise<MayDecide> {
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

  /**
   * How a held approval is given, from who opened the pull request: a review
   * posted as the person on a crew pull request (or one whose author GitHub
   * did not say); the author's sign-off when the person awaited opened it;
   * and on GitHub only when someone else did, which this refuses.
   */
  private async howDecided(pull: { author?: { login: string; id: number } | null }, linkedId: number): Promise<'review' | 'sign_off' | 'on_github'> {
    const author = pull.author ?? null;
    if (!author || (await this.deps.isCrew(author.login))) return 'review';
    return author.id === linkedId ? 'sign_off' : 'on_github';
  }

  /** Everything both decisions check before anything is posted, in the order a person can act on. */
  private async check(input: {
    repo: PullRepo;
    number: number;
    login: string;
    head: string;
    identity: string;
  }, seen?: ApproveSeen): Promise<{ linkedId: number; url: string; how: 'review' | 'sign_off' }> {
    const { repo, number, login, head } = input;
    if (!/^[0-9a-f]{40}$/i.test(head)) throw new HttpFailure(400, 'head is the commit the decision was shown for');
    const { may, link } = await this.decide(input.identity, login);
    if (seen) {
      seen.linkedLogin = link?.githubLogin ?? null;
      seen.linkedId = link?.githubUserId ?? null;
    }
    if (!may.yours) {
      const failure = new HttpFailure(may.status, may.why, may.settingsUrl ? { url: may.settingsUrl } : {});
      // A 503 is GitHub not saying who the login is: a failure, not a refusal.
      if (!link) throw this.refused(failure, 'not_linked');
      throw may.status === 403 ? this.refused(failure, 'not_awaited') : failure;
    }
    const standing = await this.deps.standing(repo.name, number, login);
    if (!standing) throw this.refused(new HttpFailure(409, `Pull request #${number} no longer waits on @${login}'s approval; reload. Nothing was posted.`), 'not_waiting');
    const pull = await this.deps.pull(repo, number);
    if (!pull.open) throw this.refused(new HttpFailure(409, `Pull request #${number} is not open; reload. Nothing was posted.`), 'not_open');
    if (pull.head !== head || standing.head !== head) {
      throw this.refused(
        new HttpFailure(409, `Pull request #${number} moved to ${short(pull.head)} since you looked; reload and decide on the new head. Nothing was posted.`, {
          url: pull.url,
        }),
        'head_moved',
        { movedTo: pull.head !== head ? pull.head : standing.head },
      );
    }
    const how = await this.howDecided(pull, may.linkedId);
    // Out of scope by design: a named person who did not open a person's pull
    // request approves it on GitHub, which takes their review (#322).
    if (how === 'on_github') {
      throw this.refused(
        new HttpFailure(409, `@${login} approves pull request #${number} on GitHub; the console signs off only for its author. Nothing was posted.`, {
          url: `${pull.url}/files`,
        }),
        'on_github',
      );
    }
    if (seen) seen.how = how;
    return { linkedId: may.linkedId, url: pull.url, how };
  }

  /**
   * Starts the person's sign-in to approve `head`. Once they approve the code,
   * their own `APPROVE` review is posted with `commit_id` at that head, only if
   * the account that approved is the one linked to them, is no crew account,
   * and the head has not moved meanwhile. Each refusal on the way is audited
   * as `pull.human_review_approval_refused` before it is thrown (#328).
   */
  async approve(input: { repo: PullRepo; number: number; login: string; head: string; identity: string }): Promise<{ flow: Omit<FlowView<unknown>, 'state' | 'result' | 'error'> }> {
    const { repo, number, login, head, identity } = input;
    const seen: ApproveSeen = { linkedLogin: null, linkedId: null, how: null };
    let checked: { linkedId: number; url: string; how: 'review' | 'sign_off' };
    try {
      checked = await this.check(input, seen);
      // Said before the sign-in, so nobody approves a code for a sign-off that
      // would be refused; asked again once they have, below.
      if (checked.how === 'sign_off' && !(await this.deps.approves(checked.linkedId).catch(() => false))) {
        throw this.refused(new HttpFailure(403, APPROVES_OFF, { url: PEOPLE_URL }), 'approves_off');
      }
    } catch (error) {
      await this.auditRefusal(error, { ...input, seen, stage: 'before_sign_in' });
      throw error;
    }
    const { linkedId, url, how } = checked;
    const key = `${repo.name}#${number}@${head}#${identity}`;
    const waiting = this.signing.get(key);
    if (waiting && this.deps.flows.state(waiting.flowId, waiting.identity).state === 'waiting') {
      throw new HttpFailure(409, `A sign-in to approve #${number} is still waiting for you; approve that code, or let it expire. Nothing was posted.`);
    }
    const flow = await this.deps.flows.start(
      identity,
      async (viewer: GitHubViewer, accessToken: string) => {
        try {
          if (viewer.id !== linkedId) {
            throw this.refused(new Error(`You approved the code as @${viewer.login}, which is not the GitHub account linked to you here; nothing was posted.`), 'other_account');
          }
          if (await this.deps.isCrew(viewer.login)) throw this.refused(new Error(`@${viewer.login} is an account the crew uses; nothing was posted.`), 'crew_account');
          const now = await this.deps.pull(repo, number);
          if (now.head !== head) {
            throw this.refused(new Error(`Pull request #${number} moved to ${short(now.head)} while you signed in; nothing was posted. Reload and approve the new head.`), 'head_moved', {
              movedTo: now.head,
            });
          }
          if (how === 'sign_off') return await this.signOff({ repo, number, login, head, identity, viewer, pull: now });
        } catch (error) {
          await this.auditRefusal(error, { ...input, seen, stage: 'after_sign_in', viewer });
          throw error;
        }
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
      {
        noClientId:
          how === 'sign_off'
            ? 'OpenADLC cannot sign in as a person on this install: no GitHub App client id is configured, so it cannot take your sign-off. An admin adds the client id in Settings.'
            : `OpenADLC cannot sign in as a person on this install: no GitHub App client id is configured. Approve it on GitHub: ${url}/files`,
      },
    );
    for (const [held, one] of this.signing) if (this.deps.flows.state(one.flowId, one.identity).state !== 'waiting') this.signing.delete(held);
    this.signing.set(key, { flowId: flow.flowId, identity });
    return { flow: { flowId: flow.flowId, userCode: flow.userCode, verificationUri: flow.verificationUri, expiresInSeconds: flow.expiresInSeconds } };
  }

  /**
   * The author's sign-off, once their sign-in proved it is them: recorded,
   * never posted, with nothing done with their token. The account that
   * approved the code is the pull request's author as GitHub says now, and
   * People has Approves on for it. The row and its audit entry are written in
   * one transaction, so there is never a sign-off the gate counts that nobody
   * can trace: written one after the other, an audit that failed left the row
   * to be taken back by a second write, and when that failed too the sign-off
   * counted with no audit entry (#322).
   */
  private async signOff(input: {
    repo: PullRepo;
    number: number;
    login: string;
    head: string;
    identity: string;
    viewer: GitHubViewer;
    pull: { url: string; author?: { login: string; id: number } | null };
  }): Promise<{ commentUrl: string }> {
    const { repo, number, login, head, identity, viewer, pull } = input;
    if (pull.author?.id !== viewer.id) {
      throw this.refused(
        new Error(`@${viewer.login} did not open pull request #${number}, so the console cannot sign it off for you; approve it on GitHub. Nothing was recorded.`),
        'author_changed',
        { author: pull.author ? { login: pull.author.login, id: pull.author.id } : null },
      );
    }
    if (!(await this.deps.approves(viewer.id).catch(() => false))) throw this.refused(new Error(`${APPROVES_OFF} Nothing was recorded.`), 'approves_off');
    const audit = {
      actor: identity,
      action: 'pull.human_review_signed_off',
      target: decisionTarget(repo.name, number),
      payload: { repo: repo.name, pr: number, login: viewer.login, awaited: login, githubUserId: viewer.id, head, by: identity },
    };
    try {
      await this.deps.signOff.record({ repo: repo.name, pr: number, head, githubUserId: viewer.id, githubLogin: viewer.login, identity }, audit);
    } catch (error) {
      this.warn(`[bridge] @${viewer.login}'s sign-off of ${repo.name}#${number} at ${short(head)} was not recorded: ${error instanceof Error ? error.message : error}`);
      throw new Error('OpenADLC could not record your sign-off and its audit entry, so it does not count. Nothing was posted; sign off again in a moment.');
    }
    return { commentUrl: pull.url };
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
      const { how } = await this.check(input);
      // A person's own pull request has no builder to send it back to.
      if (how !== 'review') throw new HttpFailure(409, `Pull request #${number} is @${login}'s own, with no builder to send it back to; nothing was done. Push the change to it yourself, or Discuss it.`);
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

