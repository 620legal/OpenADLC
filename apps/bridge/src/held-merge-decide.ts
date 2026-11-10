import { createHash } from 'node:crypto';
import { personMayMergeOver, type MergeBlocker } from './automation.js';
import { LINK_ACCOUNT_URL, short } from './human-review-decide.js';
import { REQUIRED_CHECKS } from './merge-line.js';
import { personKey, type FlowView, type GitHubViewer, type PersonFlows } from './person-github.js';
import type { PullRepo } from './pull-commands.js';
import { HttpFailure } from './router.js';

/**
 * A person deciding a pull request the merge line holds for them, from the
 * console: Merge, Leave it or Discuss. See
 * docs/adr/0037-a-person-merges-a-held-pull-request-from-the-console.md.
 *
 * Merge is the person's own merge on GitHub, posted with the one-post token of
 * ADR 0018 from the account their sign-in linked, pinned to the head they saw.
 * The app never merges on a person's say: only the merge line merges as the
 * app. Two checks stand before it, both here and not in the console: GitHub
 * must say the linked account may write to the repository, and every rule
 * still unmet on the head (`mergeBlockers`) must be one a person may merge
 * over. A required check, a crew review or a named person's Human-review
 * approval is never one; their holds are decided elsewhere. GitHub's branch
 * rules still apply to the merge after both.
 */

/** How long GitHub's answer about a login's permission on a repository is kept. */
export const PERMISSION_KEPT_MS = 10 * 60_000;

/** The roles GitHub gives an account that may merge. */
const MAY_MERGE = new Set(['admin', 'maintain', 'write']);

/** What a card offers on a held merge: Merge, or why not. */
export type MergeOffer = { merge: true } | { merge: false; why: string };

/** What the console says about the viewer and Merge. */
export type MayMerge = { yours: true; linkedId: number; login: string } | { yours: false; why: string; settingsUrl?: string; status: number };

/** What else stands on a held merge, for `offer`. */
export interface HeldMergeStanding {
  /** The login a Human-review approval of this pull request still waits on (an `approval:` or `approve-again:` item), or null. */
  humanReview: string | null;
  /** The reasons a Merge of this head was refused (`pull.person_merge_refused`), or null when none was. */
  refusedOnHead: string[] | null;
}

/**
 * What a held merge's card offers, from what the bridge already holds and no
 * GitHub call. Merge never stands in for a named person's approval: while one
 * is awaited, that card decides it. The stored reason is only the merge
 * line's first, so a press checks every rule again.
 */
export function offer(held: { reason: string; head: string | null }, standing: HeldMergeStanding): MergeOffer {
  if (standing.humanReview) {
    return { merge: false, why: `There is no Merge: this waits for @${standing.humanReview}'s approval under AGENTS.md's Human review, which is decided on its own card.` };
  }
  if (!personMayMergeOver(held.reason)) {
    if (namesRequiredCheck(held.reason)) return { merge: false, why: 'There is no Merge: a required check has not passed on this head. Open it on GitHub, or Discuss it.' };
    return { merge: false, why: `There is no Merge: OpenADLC does not offer one over this hold (${held.reason}). Open it on GitHub, or Discuss it.` };
  }
  if (standing.refusedOnHead && held.head) {
    return { merge: false, why: `Merge was refused on ${short(held.head)}: ${standing.refusedOnHead.join('; ')}.` };
  }
  // A head the line did not record cannot be pinned, and a merge of whatever
  // is there when GitHub gets it is not the version the person saw.
  if (!held.head) return { merge: false, why: 'There is no Merge: OpenADLC did not record which commit is held. Open it on GitHub, or Discuss it.' };
  return { merge: true };
}

/**
 * Whether a held merge's reason names `ci` or `review-gate` as a word of its
 * own. It reads no more of `mergeDecision`'s prose than the names: "changes how
 * CI runs" and "visual-review failed" do not name either. Nor does a path: a
 * person-merges hold lists `.github/workflows/ci.yml`, and read as `ci` it
 * lost the sentence saying the checks passed, so `-`, `/` and a `.` inside a
 * name stay part of the word.
 */
export function namesRequiredCheck(reason: string): boolean {
  return REQUIRED_CHECKS.some((name) => new RegExp(`(?<![\\w./-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/-]|\\.\\w)`).test(reason));
}

/**
 * What a Leave it covers: the head, the reason and the newest review on the
 * pull request. A change to any of them is something new about the pull
 * request, and brings the card back.
 */
export function occurrence(held: { head: string | null; reason: string }, reviewsSeen: string | number | null): string {
  const digest = createHash('sha256').update(held.reason).digest('hex').slice(0, 12);
  return `${held.head ?? 'none'}|${digest}|${reviewsSeen ?? 'none'}`;
}

export interface HeldMergeDeps {
  /** The viewer's linked GitHub account (`person_accounts`), or null. */
  linkOf(identity: string): Promise<{ githubLogin: string; githubUserId: number } | null>;
  /** GitHub's `role_name` for a login on a repository; null when it could not say. */
  permissionOf(fullName: string, login: string): Promise<string | null>;
  isCrew(login: string): Promise<boolean>;
  /** The merge line's hold on the pull request, or null when it no longer holds it for a person. */
  held(repo: string, pr: number): Promise<{ head: string | null; reason: string } | null>;
  /** The pull request as GitHub has it now. */
  pull(repo: PullRepo, number: number): Promise<{ open: boolean; head: string; url: string }>;
  /**
   * Every rule still unmet on the pull request as GitHub has it now
   * (`mergeBlockers` on `Automation.mergeFacts`), or null when GitHub could
   * not be read in full.
   */
  blockers(repo: PullRepo, number: number): Promise<MergeBlocker[] | null>;
  flows: Pick<PersonFlows, 'start' | 'state'>;
  /** Merges with the person's token, squashed, only if the head is still `head`; the token goes nowhere else. */
  mergeAsPerson(accessToken: string, fullName: string, number: number, head: string): Promise<{ sha: string }>;
  audit(entry: { actor: string; action: string; target: string; payload: Record<string, unknown> }): Promise<void>;
  warn?(message: string): void;
  now?(): number;
}

/** A failure GitHub answered with, as its status and its words; null for anything else. */
function gitHubRefusal(error: unknown): { status: number; message: string } | null {
  if (!error || typeof error !== 'object') return null;
  const status = (error as { status?: unknown }).status;
  if (typeof status !== 'number') return null;
  const message = error instanceof Error ? error.message : String(error);
  return { status, message };
}

export class HeldMergeDecisions {
  private readonly permissions = new Map<string, { at: number; role: string }>();
  /** Merges still waiting for their code, by `repo#pr@head#identity`: a second press while one waits merged nothing but asked twice. */
  private readonly signing = new Map<string, { flowId: string; identity: string }>();

  constructor(private readonly deps: HeldMergeDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private warn(message: string): void {
    (this.deps.warn ?? console.warn)(message);
  }

  private async role(fullName: string, login: string): Promise<string | null> {
    const key = `${fullName.toLowerCase()}#${login.toLowerCase()}`;
    const kept = this.permissions.get(key);
    if (kept && this.now() - kept.at < PERMISSION_KEPT_MS) return kept.role;
    // Only an answer GitHub gave is kept: an unreadable one refuses now and asks again next time.
    const role = await this.deps.permissionOf(fullName, login).catch(() => null);
    if (typeof role !== 'string') return null;
    this.permissions.set(key, { at: this.now(), role });
    return role;
  }

  /**
   * Whether the viewer may press Merge: a linked account, not the crew's,
   * that GitHub lets write to the repository. Hiding the button is not the
   * check; `merge` asks this again.
   */
  async mayMerge(identity: string, repo: Pick<PullRepo, 'fullName'>): Promise<MayMerge> {
    const link = await this.deps.linkOf(personKey(identity)).catch(() => null);
    if (!link) return { yours: false, status: 409, why: 'You have not linked a GitHub account. Link it in Settings → Your GitHub account.', settingsUrl: LINK_ACCOUNT_URL };
    const login = link.githubLogin;
    if (await this.deps.isCrew(login).catch(() => true)) return { yours: false, status: 403, why: `@${login} is an account the crew uses; a person merges it.` };
    const role = await this.role(repo.fullName, login);
    if (role === null) return { yours: false, status: 503, why: `OpenADLC could not ask GitHub whether @${login} can merge in ${repo.fullName} just now. Reload in a moment, or merge it on GitHub.` };
    if (!MAY_MERGE.has(role)) return { yours: false, status: 403, why: `@${login} cannot merge in ${repo.fullName} (GitHub says ${role}); someone who can merges it.` };
    return { yours: true, linkedId: link.githubUserId, login };
  }

  /** Every rule still unmet that a person may not merge over, or a 503 when GitHub could not be read. */
  private async refusals(repo: PullRepo, number: number): Promise<MergeBlocker[]> {
    const blockers = await this.deps.blockers(repo, number).catch(() => null);
    if (!blockers) throw new HttpFailure(503, 'GitHub could not be read in full; nothing was merged. Try again.');
    return blockers.filter((one) => one.kind !== 'person');
  }

  /**
   * Starts the person's sign-in to merge `head`. Before it starts, and again
   * once they approve the code, the head must be the one they saw and every
   * rule still unmet must be one a person may merge over; their own merge is
   * then posted, pinned to that head. Nothing is merged otherwise.
   */
  async merge(input: { repo: PullRepo; number: number; head: string; identity: string }): Promise<{ flow: Omit<FlowView<unknown>, 'state' | 'result' | 'error'> }> {
    const { repo, number, head, identity } = input;
    if (!/^[0-9a-f]{40}$/i.test(head)) throw new HttpFailure(400, 'head is the commit the decision was shown for');
    const target = `${repo.name}#${number}`;
    const may = await this.mayMerge(identity, repo);
    if (!may.yours) throw new HttpFailure(may.status, may.why, may.settingsUrl ? { url: may.settingsUrl } : {});
    const held = await this.deps.held(repo.name, number);
    if (!held) throw new HttpFailure(409, `#${number} is no longer held for a person; reload. Nothing was merged.`);
    const pull = await this.deps.pull(repo, number);
    if (!pull.open) throw new HttpFailure(409, `Pull request #${number} is not open; reload. Nothing was merged.`);
    if (pull.head !== head || (held.head && held.head !== head)) {
      throw new HttpFailure(409, `Pull request #${number} moved to ${short(pull.head)} since you looked; reload. Nothing was merged.`, { url: pull.url });
    }
    const refused = await this.refusals(repo, number);
    if (refused.length > 0) {
      const reasons = refused.map((one) => one.reason);
      await this.deps
        .audit({ actor: identity, action: 'pull.person_merge_refused', target, payload: { repo: repo.name, pr: number, head, blockers: refused, by: identity } })
        .catch((error: unknown) => this.warn(`[bridge] the refused Merge of ${target} at ${short(head)} was not audited: ${error instanceof Error ? error.message : error}`));
      throw new HttpFailure(409, `There is no Merge on ${short(head)}: ${reasons.join('; ')}. Nothing was merged.`, { reasons });
    }
    const key = `${target}@${head}#${identity}`;
    const waiting = this.signing.get(key);
    if (waiting && this.deps.flows.state(waiting.flowId, waiting.identity).state === 'waiting') {
      throw new HttpFailure(409, `A sign-in to merge #${number} is still waiting for you; approve that code, or let it expire. Nothing was merged.`);
    }
    const linkedId = may.linkedId;
    const flow = await this.deps.flows.start(
      identity,
      async (viewer: GitHubViewer, accessToken: string) => {
        if (viewer.id !== linkedId) {
          throw new Error(`You approved the code as @${viewer.login}, which is not the GitHub account linked to you here; nothing was merged.`);
        }
        if (await this.deps.isCrew(viewer.login)) throw new Error(`@${viewer.login} is an account the crew uses; nothing was merged.`);
        const now = await this.deps.pull(repo, number);
        if (!now.open || now.head !== head) throw new Error(`Pull request #${number} moved to ${short(now.head)} while you signed in; nothing was merged. Reload.`);
        // Time has passed since the press: a review, a check or a label may
        // have come meanwhile, and none of them is merged over.
        const blockers = await this.deps.blockers(repo, number).catch(() => null);
        if (!blockers) throw new Error('GitHub could not be read in full; nothing was merged. Try again.');
        const late = blockers.filter((one) => one.kind !== 'person');
        if (late.length > 0) {
          await this.deps
            .audit({ actor: identity, action: 'pull.person_merge_refused', target, payload: { repo: repo.name, pr: number, head, blockers: late, by: identity } })
            .catch(() => undefined);
          throw new Error(`There is no Merge on ${short(head)} any more: ${late.map((one) => one.reason).join('; ')}. Nothing was merged.`);
        }
        let merged: { sha: string };
        try {
          merged = await this.deps.mergeAsPerson(accessToken, repo.fullName, number, head);
        } catch (error) {
          const refusal = gitHubRefusal(error);
          const message = refusal?.message ?? (error instanceof Error ? error.message : String(error));
          await this.deps
            .audit({ actor: identity, action: 'pull.person_merge_failed', target, payload: { repo: repo.name, pr: number, head, login: viewer.login, status: refusal?.status ?? null, message, by: identity } })
            .catch(() => undefined);
          throw new Error(`GitHub refused the merge: ${message}. Nothing changed.`);
        }
        // Merged on GitHub; the pull request's closed delivery takes it out of
        // the line. A record that cannot be written is said in the log.
        await this.deps
          .audit({ actor: identity, action: 'pull.person_merged', target, payload: { repo: repo.name, pr: number, head, sha: merged.sha, login: viewer.login, by: identity } })
          .catch((error: unknown) => this.warn(`[bridge] @${viewer.login}'s merge of ${target} at ${short(head)} landed as ${merged.sha} but was not audited: ${error instanceof Error ? error.message : error}`));
        return { commentUrl: pull.url, mergedSha: merged.sha };
      },
      { noClientId: `OpenADLC cannot sign in as a person on this install: no GitHub App client id is configured. Merge it on GitHub: ${pull.url}` },
    );
    for (const [one, kept] of this.signing) if (this.deps.flows.state(kept.flowId, kept.identity).state !== 'waiting') this.signing.delete(one);
    this.signing.set(key, { flowId: flow.flowId, identity });
    return { flow: { flowId: flow.flowId, userCode: flow.userCode, verificationUri: flow.verificationUri, expiresInSeconds: flow.expiresInSeconds } };
  }
}
