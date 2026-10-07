import { permissionOn, theApp } from './people.js';
import { audit, bots, hasEventOfType, issues, lastEventAt, leases, listEventsOfTypeWith, recordEvent, repos, stageMoves } from '@fleetadlc/db';
import { REVIEW_DISMISSED_BY_BRIDGE, REVIEW_ROUND_OPENED, issueNumberFromBranch, scopeLabelAcceptedFrom } from './work.js';
import { ReviewerStandings, isTemplatePlaceholder, reviewRequestRefusal, reviewerStandingOf, type GitHubClient, type PullCommit, type ReviewerStanding } from '@fleetadlc/github';
import {
  STAGE_LABELS,
  isBackwardMove,
  isForwardMove,
  leadReviewer,
  resolveBotRef,
  reviewRulesSchema,
  type ReviewRules,
  type ReviewerSeat,
  type StageKey,
  CI_LABEL,
  HUMAN_REVIEW_LABEL_COLOR,
  HUMAN_REVIEW_LABEL_PREFIX,
  REQUIRED_CHECK,
  REVIEW_GATE_CHECK,
  accountsThatNeverAuthor,
  findForbiddenAuthors,
  everyHumanReviewer,
  humanReviewLabelFor,
  humanReviewSectionChanged,
  humanReviewersFor,
  parseHumanReviewPaths,
  sameLogin,
  seatsAskingForChanges,
  seatOf,
  seatsThatPosted,
  whoWrote,
  type HumanReviewRule,
  isStageLabel,
  hasIgnoreLabel,
  ownReviewMarker,
  PAUSED_LABEL,
  CROSS_CUTTING_LABEL,
  closingKeywords,
  filesOutsideScope,
} from '@fleetadlc/shared';
import type { Actors } from './actors.js';
import type { AppGate } from './app-gate.js';
import type { BridgeConfig } from './config.js';
import { asAutomation, automationBot } from './automation-bot.js';
import { effectiveConfig } from './effective-config.js';
import { latestByName, verdictFor } from './merge-line.js';
import { REVERT_BRANCH_PREFIX } from './task-service.js';

export interface ReviewerDecision {
  /** Every seat asked, the lead among them. */
  reviewers: string[];
  /** The seat that reviews last and decides. */
  lead: string;
  /** The seats whose approval a merge needs: the lead, and any seat marked `blocking` that was asked. */
  approvers: string[];
  reasons: Record<string, string>;
  humanReviewRequired: boolean;
}

/**
 * `review-gate` as it is published. The reviews hold it or release it; it fails
 * when it can never pass as things stand: a commit by an account that must
 * never author (`checkAuthors`), or a reviewer GitHub will not ask
 * (`computeReviewGate`).
 */
export interface ReviewGate {
  state: 'pending' | 'success' | 'failure';
  description: string;
}

/**
 * GitHub's answers about who can review where, shared by every pull request's
 * gate and the repository configuration check (`health/checks/repo-config.ts`),
 * which asks afresh on its schedule and so is how a fix reaches the gates.
 */
export const reviewerStandings = new ReviewerStandings();

/** A reviewer GitHub refused to ask, and why, in its words. */
export interface RefusedReviewer {
  seat: string;
  login: string;
  reason: string;
  words: string;
}

/** A commit status's description is at most this long. */
const STATUS_DESCRIPTION_MAX = 140;

function fitStatus(text: string): string {
  return text.length <= STATUS_DESCRIPTION_MAX ? text : `${text.slice(0, STATUS_DESCRIPTION_MAX - 1)}…`;
}

/** What a push may invalidate: the latest approval each reviewer left standing. */
export function standingApprovals(
  reviews: { id: number; user: string; state: string; submittedAt: string | null }[],
): { id: number; user: string }[] {
  const latest = new Map<string, { id: number; user: string; state: string; submittedAt: string | null }>();
  for (const review of reviews) {
    // GitHub returns reviews oldest first, and a reviewer may have several: only
    // their last one is their position.
    if (review.state === 'COMMENTED') continue;
    latest.set(review.user, review);
  }
  return [...latest.values()]
    .filter((review) => review.state === 'APPROVED')
    .map((review) => ({ id: review.id, user: review.user }));
}

/**
 * Whether a push changed what the pull request proposes.
 *
 * `null` on either side means the comparison could not be made, and that is
 * treated as changed: keeping an approval requires knowing the work is the
 * same, and not knowing is not the same as knowing it is.
 */
export function contentChanged(before: string | null, after: string | null): boolean {
  if (before === null || after === null) return true;
  return before !== after;
}

/** One approval a merge landed on: who, of what, and whether it was of the head itself. */
export interface LandedApproval {
  /** A seat, or a person's login. */
  reviewer: string;
  person: boolean;
  commitId: string;
  /** False when it was given on an earlier head whose diff against the base is the same. */
  ofHead: boolean;
}

/** The app whose check runs are CI's: GitHub Actions. */
export const CI_APP = 'github-actions';

/** What the bridge reads before it merges, gathered by `Automation.mergeFacts`. */
export interface MergeFacts {
  repoFullName: string;
  /** Held for a person: labelled `needs-human` (which "Hold this PR" on an unsigned post's card sets) or `fleetadlc:paused`. */
  held?: boolean;
  /** The repository the head branch is in; another one's for a fork. */
  headRepoFullName: string | null;
  baseRef: string;
  defaultBranch: string;
  draft: boolean;
  /** GitHub's `mergeable_state`: `clean`, `unstable`, `dirty`, `behind`, `blocked`… */
  mergeableState: string | null;
  headSha: string;
  /** False when GitHub stopped listing the files before the end (3000), so the paths are not all known. */
  filesComplete: boolean;
  /** The seats whose approval the review rules need on this pull request: the lead, and any seat marked blocking. */
  requestedReviewers: readonly string[];
  /** People and teams asked for a review on GitHub who have not given one. */
  pendingOnGitHub: readonly string[];
  /** The people the repository's AGENTS.md, on its default branch, names for the paths it touches. */
  humansRequired: readonly string[];
  humanRulesUnknown: boolean;
  /** Its reviews, every page, oldest first, those that count only (`countableReviews`). */
  reviews: readonly { id: number; user: string; state: string; body?: string | null; commitId: string | null; association?: string | null }[];
  /**
   * What each person whose latest verdict asks for changes, and each person
   * the rules require, may do here, by lower-cased login: GitHub's answer, or
   * `unknown`.
   */
  askingPermission: ReadonlyMap<string, string>;
  /** Every file it changes, when `filesComplete`. */
  files: readonly string[];
  /** Files whose part that decides how CI runs changed: a package's `scripts`, a tsconfig's `include`. */
  ciKeysChanged: readonly string[];
  /** People and teams whose review request someone without the say took away; null when that cannot be read. */
  requestsTakenAway: readonly string[] | null;
  crew: readonly { name: string; slot?: string; githubLogin: string | null }[];
  /** Whether every crew review counts only when its signature checks (`attributionMode: enforce`). */
  signaturesEnforced: boolean;
  /**
   * Its crew reviews whose signature checked, comments included, or null when
   * nothing here can check one. A change to how CI runs lands on the security
   * reviewer's verdict from these only, and a required seat on an account
   * other seats use too is that seat's only from these (`checkedForSharedSeats`).
   */
  checkedReviews: readonly { id: number; user: string; state: string; body?: string | null; commitId: string | null }[] | null;
  /** Who merges a change to how CI runs here: OpenADLC once the security reviewer approves (the default), or a person. */
  ciMergedBy: 'fleetadlc' | 'person';
  /** The seat that reviews for security, by bot name, or null when the rules name none. */
  securitySeat: string | null;
  /** The check runs on the head, with the app that set each and, for CI's, the workflow run behind it. */
  checkRuns: readonly { name: string; status: string; conclusion: string | null; app: string | null; headSha: string; workflow: string | null; id?: number }[];
  /** The commit statuses on the head, which any token that may write statuses can set. */
  statuses: readonly { context: string; state: string }[];
  /** `review-gate` as OpenADLC published it on the head, or null when it cannot be read. */
  gate: 'pending' | 'success' | 'failure' | null;
  /** Earlier heads whose diff against the base is the head's own. */
  sameDiffAs: ReadonlySet<string>;
  /**
   * Earlier heads a lead-only resolution of a conflict, or the line's stacked
   * update, carried the reviews from, and heads with one of their diffs
   * (`ConflictRounds.carriedTo`). They stand for the seats' approvals, never
   * for a person's.
   */
  carriedFrom: ReadonlySet<string>;
  /**
   * The lead seat when a lead-only resolution of a conflict led to the head:
   * the lead re-checks that resolution, so only its approval of this diff
   * counts, never one carried from before it. Null otherwise.
   */
  leadRechecks: string | null;
  /**
   * What a crew pull request (an `agent/` branch of this repository) may
   * change, which the merge holds it to. Absent, or `crewBranch` false, for
   * anybody else's: a person's, or the deploy skill's `system/revert-*`.
   */
  scope?: ScopeFacts;
}

/** A crew pull request's scope, as `mergeFacts` reads it for `mergeDecision`. */
export interface ScopeFacts {
  /** Whether the head is an `agent/` branch of this repository. */
  crewBranch: boolean;
  /** The issue the branch was cut for, from its name. */
  issue: number | null;
  /** The issues it closes: GitHub's closing references, or the closing keywords in its body when those cannot be read. */
  closes: readonly number[];
  /**
   * The paths OpenADLC's lease for that issue declared, widened only by an
   * approved plan change (`leases.widenPaths`), or null when there is no
   * lease. Never the issue's body, which anyone who can edit it can widen.
   */
  declared: readonly string[] | null;
  /** Whether `scope:cross-cutting` is on, last put on by someone `scopeLabelAcceptedFrom` accepts. */
  crossCutting: boolean;
}

/**
 * Files that decide how CI runs rather than what it tests: the workflows, the
 * actions and scripts they call, the entry points they run by name — every
 * name GNU make reads first, since a new `makefile` beats a protected
 * `Makefile` — and what decides which packages are installed and tested and
 * how (`pnpm-workspace.yaml`, dropping a package from which shrinks what
 * `pnpm -r test` runs, `.npmrc`, `.pnpmfile.cjs`, which runs at install).
 */
const CI_DEFINITION = [
  /^\.github\//,
  /^package\.json$/,
  /^(GNUmakefile|makefile|Makefile)$/,
  /^pnpm-workspace\.yaml$/,
  /^\.npmrc$/,
  /^\.pnpmfile\.cjs$/,
  /^\.(nvmrc|node-version)$/,
  // Test runners' own configuration, at any depth: `include: []` or a
  // `passWithNoTests` makes a package's tests pass by not running them.
  /(^|\/)(vitest|vite)\.(config|workspace)\.[cm]?[jt]s$/,
  /(^|\/)vitest\.workspace\.json$/,
  /(^|\/)jest\.config\.([cm]?[jt]s|json)$/,
  /(^|\/)\.mocharc(\.[a-z]+)?$/,
  /(^|\/)playwright\.config\.[cm]?[jt]s$/,
];

/**
 * Files that change how CI runs only in part, and the part: a package's own
 * `package.json` decides what `pnpm -r test` runs in it through `scripts`, and
 * a dependency bump there is ordinary work; a `tsconfig` decides what is
 * compiled and type-checked through these keys.
 */
const CI_KEYS: { path: RegExp; keys: readonly string[] }[] = [
  { path: /(^|\/)package\.json$/, keys: ['scripts'] },
  { path: /(^|\/)tsconfig[^/]*\.json$/, keys: ['references', 'include', 'files', 'exclude', 'extends'] },
];

/** JSON, or JSON with the comments and trailing commas a tsconfig may have; null when it is neither. */
function looseJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    try {
      const stripped = text
        .replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match, quoted: string | undefined) => quoted ?? '')
        .replace(/,(\s*[}\]])/g, '$1');
      return JSON.parse(stripped) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

/** A value as one string, its object keys in order, so two readings of one value compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Of the files a pull request changes, those whose CI part (`CI_KEYS`)
 * differs between the base and the head — or cannot be told not to: a file
 * that cannot be read or parsed on either side counts as changed.
 */
export async function ciKeysChanged(
  files: readonly string[],
  read: (path: string, ref: string) => Promise<string | null>,
  refs: { base: string; head: string },
): Promise<string[]> {
  const changed: string[] = [];
  for (const path of files) {
    if (changesCi(path)) continue;
    const rule = CI_KEYS.find((one) => one.path.test(path));
    if (!rule) continue;
    try {
      const [before, after] = await Promise.all([read(path, refs.base), read(path, refs.head)]);
      const parsed = [before, after].map((text) => (text === null ? {} : looseJson(text)));
      if (parsed.some((one) => one === null)) {
        changed.push(path);
        continue;
      }
      if (rule.keys.some((key) => canonical(parsed[0]?.[key]) !== canonical(parsed[1]?.[key]))) changed.push(path);
    } catch {
      changed.push(path);
    }
  }
  return changed;
}

/**
 * The people and teams whose review request was taken away by someone who
 * could not decide that — a crew account, an app, anyone without write
 * access — and who have not reviewed since: GitHub no longer lists them as
 * asked, but they still are. A request taken back by a person who can write
 * is theirs to take back. Null when the history is too long to read.
 */
export function requestsTakenAway(
  history: readonly { event: string; actor: string | null; viaApp: boolean; subject?: string | null }[] | null,
  /** Whether `actor` may take back the request of `subject`. */
  mayDecide: (actor: string | null, viaApp: boolean, subject: string) => boolean,
): string[] | null {
  if (!history) return null;
  const held = new Map<string, boolean>();
  for (const entry of history) {
    if (entry.event === 'review_requested' && entry.subject) held.set(entry.subject.toLowerCase(), false);
    if (entry.event === 'review_request_removed' && entry.subject) held.set(entry.subject.toLowerCase(), !mayDecide(entry.actor, entry.viaApp, entry.subject));
    if (entry.event === 'reviewed' && entry.actor) held.set(entry.actor.toLowerCase(), false);
  }
  return [...held.entries()].filter(([, still]) => still).map(([subject]) => (subject.startsWith('team ') ? subject : `@${subject}`));
}

/**
 * The ids of requests for changes that were dismissed by someone who could
 * not decide that — a crew account, an app, anyone without write access —
 * and so still hold the pull request.
 *
 * A builder's session can dismiss a person's review with its own token, round
 * OpenADLC's `gh`. The dismissed review then read as that person's latest
 * verdict, nobody was asking for changes any more, and the merge line merged
 * on the lead's approval alone. Read from the timeline every time, so a
 * delivery the bridge missed cannot release it. A later review by the same
 * person is still their verdict: the caller keeps each person's latest.
 */
export function dismissalsThatHold(
  history: readonly { event: string; actor: string | null; viaApp: boolean; dismissedReviewId?: number | null; dismissedState?: string | null }[] | null,
  mayDecide: (actor: string | null, viaApp: boolean) => boolean,
): Set<number> {
  const held = new Set<number>();
  for (const entry of history ?? []) {
    if (entry.event !== 'review_dismissed' || typeof entry.dismissedReviewId !== 'number') continue;
    if (entry.dismissedState?.toUpperCase() !== 'CHANGES_REQUESTED') continue;
    if (!mayDecide(entry.actor, entry.viaApp)) held.add(entry.dismissedReviewId);
  }
  return held;
}

export function changesCi(path: string): boolean {
  return CI_DEFINITION.some((pattern) => pattern.test(path));
}

/**
 * Whether a file can decide how CI runs, in whole or in part: anything
 * `changesCi` names, and a `package.json` or `tsconfig*.json` at any depth,
 * whose CI keys (`CI_KEYS`) are part of it. A conflict resolution in one of
 * these is reviewed in full (`conflict-round.ts`): the lead alone re-checking
 * a Makefile let the security reviewer's earlier verdict stand for it.
 */
export function mayDefineCi(path: string): boolean {
  return changesCi(path) || CI_KEYS.some((rule) => rule.path.test(path));
}

/**
 * The security seat's latest verdict on this diff: an `APPROVED` review, or
 * the verdict in the `review_posted` marker the review ends with. Reviews
 * come oldest first, so the last one on this diff wins. Null when none of
 * them is that seat's. The same reading `mergeDecision` and the review gate use.
 */
export function securityVerdictOn(
  reviews: readonly { user: string | null; state: string; body?: string | null; commitId?: string | null }[],
  crew: readonly { name: string; slot?: string; githubLogin: string | null }[],
  seat: string,
  onThisDiff: (commitId: string | null) => boolean,
): string | null {
  let verdict: string | null = null;
  for (const review of reviews) {
    const author = whoWrote(review.user, crew, { bot: seatOf(review.body) });
    if (author.kind !== 'fleetadlc' || author.bot?.name !== seat || !onThisDiff(review.commitId ?? null)) continue;
    const said = ownReviewMarker(review.body);
    verdict = review.state === 'APPROVED' ? 'approve' : typeof said?.verdict === 'string' ? said.verdict : verdict;
  }
  return verdict;
}

/** Each login's latest verdict, a comment being none. */
function latestByLogin<R extends { user: string; state: string }>(reviews: readonly R[]): R[] {
  const latest = new Map<string, R>();
  for (const review of reviews) {
    if (review.state === 'COMMENTED' || review.state === 'PENDING') continue;
    latest.set(review.user.toLowerCase(), review);
  }
  return [...latest.values()];
}

/** Of `seats`, those whose latest verdict is an approval; a comment is no verdict. By seat, from each review's own seat tag. */
export function seatsApproving<M extends { name: string; slot?: string; githubLogin: string | null }>(
  reviews: readonly { user: string | null; state: string; body?: string | null }[],
  crew: readonly M[],
  seats: readonly string[],
): string[] {
  const latest = new Map<string, string>();
  for (const review of reviews) {
    const state = review.state.toUpperCase();
    if (state === 'COMMENTED' || state === 'PENDING') continue;
    const author = whoWrote(review.user, crew, { bot: seatOf(review.body) });
    if (author.kind === 'fleetadlc' && author.bot) latest.set(author.bot.name, state);
  }
  return seats.filter((seat) => latest.get(seat) === 'APPROVED');
}

/**
 * The reviews, less those a required seat on a shared account is only said to
 * have written.
 *
 * Seats that share a GitHub account are told apart by the seat tag at the end
 * of a post, which anything holding the account's token can write. With the
 * lead the only required seat, a second or security reviewer's session could
 * post an approval tagged as the lead's around OpenADLC's `gh`, and in audit
 * mode it counted: the gate went green, the lead was never asked, and the
 * bridge merged on it. So on a login more than one seat uses, a review that
 * names one of `seats` — the lead and the blocking seats — stays only when its
 * id is among `checked`, the reviews whose signature checked and was made for
 * this pull request and this review (`Attribution.reviewsThatCount`); with
 * `checked` null, nothing can say so and none stays. A person's review, one on
 * an account only one seat uses, and an advisory seat's are left as they are.
 */
export function checkedForSharedSeats<R extends { id: number; user: string | null; body?: string | null }>(
  reviews: readonly R[],
  checked: readonly { id: number }[] | null,
  crew: readonly { name: string; slot?: string; githubLogin: string | null }[],
  seats: readonly string[],
): R[] {
  const ids = new Set((checked ?? []).map((review) => review.id));
  return reviews.filter((review) => {
    const author = whoWrote(review.user, crew, { bot: seatOf(review.body) });
    if (author.kind !== 'fleetadlc' || !author.shared || !author.bot || !seats.includes(author.bot.name)) return true;
    return ids.has(review.id);
  });
}

/** When the last of `seats` posted among these reviews, or null when none did. */
function lastPostedBy<M extends { name: string; slot?: string; githubLogin: string | null }>(
  reviews: readonly { user: string | null; body?: string | null; submittedAt?: string | null }[],
  crew: readonly M[],
  seats: readonly string[],
): string | null {
  let last: string | null = null;
  for (const review of reviews) {
    const author = whoWrote(review.user, crew, { bot: seatOf(review.body) });
    if (author.kind !== 'fleetadlc' || !author.bot || !seats.includes(author.bot.name) || !review.submittedAt) continue;
    if (!last || Date.parse(review.submittedAt) > Date.parse(last)) last = review.submittedAt;
  }
  return last;
}

/** Conclusions, and status states, that mean a check found something wrong or broke. */
const RED = new Set(['failure', 'timed_out', 'action_required', 'startup_failure', 'error']);

/** Merge states in which GitHub will land a pull request as it is. */
const LANDABLE = new Set(['clean', 'unstable', 'has_hooks']);

/** Permissions that may decide who is asked for a review, and take a request back. */
const CAN_DECIDE = new Set(['admin', 'maintain', 'write']);

/** Permissions whose request for changes does not hold a merge: they cannot change the repository. */
const NO_SAY = new Set(['none', 'read', 'triage', '']);

/**
 * Permissions whose approval counts for a person a Human review rule names.
 * Not the complement of `NO_SAY`: there the question is whether a request for
 * changes holds, and here whether an approval lands, so `unknown` refuses.
 */
const MAY_APPROVE = new Set(['admin', 'maintain', 'write']);

/**
 * Whether the bridge may merge a pull request now, and on whose approvals.
 *
 * On GitHub's free plan a private repository has no branch protection, so
 * nothing but this stands between a green gate and a merge, and no bot may
 * merge (OpenADLC's `gh` refuses it). So every rule is checked here, from
 * what GitHub says now, and anything that cannot be known — a list GitHub cut
 * short, a diff too long to compare, a seat nobody can prove — refuses:
 *
 * - the head is this repository's, and it lands on the default branch, whose
 *   `AGENTS.md` is where the human paths were read;
 * - it carries neither `needs-human` nor `fleetadlc:paused`;
 * - the lead's latest verdict, and each `blocking` seat's, is an approval, of
 *   this head or of an earlier one whose diff against the base is the same
 *   (the merge line's update from the base moves the head and changes nothing
 *   about the work), signed by OpenADLC for this pull request whatever the
 *   attribution mode, and seats sharing one account are told apart only by
 *   that signature; the other seats are advisory, and the lead read them;
 * - each person `AGENTS.md` names has approved the same way, nobody asked on
 *   GitHub is still to answer or had the request taken away by someone who
 *   cannot decide that, and nobody who can write to it still asks for
 *   changes, named or not;
 * - a change to how CI runs is also approved on this diff by the security
 *   reviewer, in a signed review, unless a person merges those here;
 * - `ci` is GitHub Actions' own check run of the `ci` workflow on this head,
 *   never a status anyone can set; `review-gate` as OpenADLC published it is
 *   green; and no check or status is red.
 */
export function mergeDecision(facts: MergeFacts): {
  land: boolean;
  reason: string;
  approvals: LandedApproval[];
  /** Set when the pull request goes back to its builder rather than wait for a person: the files it should not have changed. */
  sendBack?: { files: string[] };
} {
  const refuse = (reason: string) => ({ land: false, reason, approvals: [] });
  if (facts.headRepoFullName?.toLowerCase() !== facts.repoFullName.toLowerCase()) {
    return refuse(`its head is in ${facts.headRepoFullName ?? 'a repository that is gone'}, not ${facts.repoFullName}`);
  }
  if (facts.baseRef !== facts.defaultBranch) return refuse(`it would land on ${facts.baseRef}, not the default branch ${facts.defaultBranch}`);
  if (facts.held) return refuse('it is held for a person (needs-human or fleetadlc:paused)');
  if (facts.draft) return refuse('it is a draft');
  if (!facts.mergeableState || !LANDABLE.has(facts.mergeableState)) {
    return refuse(`GitHub says it is ${facts.mergeableState ?? 'not yet known to be mergeable'}`);
  }
  if (!facts.filesComplete) return refuse('it changes more files than GitHub lists (3000), so the paths a person must review are not all known');
  // A crew pull request lands only inside the paths its lease declared. A
  // managed repository's CI has no scope check, and one shipped in its
  // workflow could be edited out by the very pull request it checks; the
  // merge reads the lease instead. A builder that strayed — `src/billing/`
  // for an issue about a button — landed once the reviewers approved.
  const scope = facts.scope;
  if (scope?.crewBranch) {
    if (scope.closes.length === 0) {
      return refuse('it is a crew pull request that closes no issue, so nothing declared what it may change; a person decides');
    }
    if (!scope.declared || scope.declared.length === 0) {
      return refuse(`OpenADLC has no lease for ${scope.issue ? `#${scope.issue}` : 'the issue its branch was cut for'} saying what it may change; a person decides`);
    }
    const verdict = filesOutsideScope([...facts.files], [...scope.declared]);
    if (!verdict.inScope && !scope.crossCutting) {
      const listed = verdict.outside.slice(0, 20).map((file) => `\`${file}\``).join(', ');
      const more = verdict.outside.length > 20 ? ` and ${verdict.outside.length - 20} more` : '';
      return {
        land: false,
        reason:
          `it changes ${verdict.outside.length === 1 ? 'a file' : `${verdict.outside.length} files`} outside the paths its lease declared: ${listed}${more}. ` +
          'Take them out of the branch, or ask for them with a `plan_change` marker',
        approvals: [],
        sendBack: { files: verdict.outside },
      };
    }
  }
  // CI runs the head's own workflow, so a pull request that changes how CI
  // runs grades itself: an edited `ci` job that exits 0 is a genuine, green
  // run of the `ci` workflow. In every repository, whatever its AGENTS.md
  // says, the lead's approval alone does not merge one.
  //
  // So a change like that needs more than the lead: unless the repository has
  // a person merge them (`ciMergeByPerson`), the security reviewer has to have
  // read it and approved it on this diff, by a review whose signature checks —
  // a verdict in a body anyone signed in as the account could have written is
  // not one. It is a second, security-focused review rather than a second
  // model: by default (`config/bots.yaml`) that seat runs on the lead's
  // provider. Held for a person, the pull request was left "merging" with
  // nobody told, and the first change to a new repository's Makefile never
  // landed.
  const definesCi = [...facts.files.filter(changesCi), ...facts.ciKeysChanged];
  if (definesCi.length > 0) {
    const what = `it changes how CI runs (${definesCi.slice(0, 3).join(', ')}${definesCi.length > 3 ? ', …' : ''})`;
    if (facts.ciMergedBy === 'person') return refuse(`${what}, and in this repository a person merges those`);
    if (!facts.securitySeat) return refuse(`${what}, and no security reviewer is set up to check it, so a person merges it`);
    if (!facts.checkedReviews) return refuse(`${what}, and the security reviewer's verdict cannot be checked without signatures, so a person merges it`);
    const onThisDiff = (commitId: string | null) =>
      Boolean(commitId) && (commitId === facts.headSha || facts.sameDiffAs.has(commitId as string) || facts.carriedFrom.has(commitId as string));
    // Its verdict is the marker its review ends with: one it quotes from the
    // diff it reviews is the builder's words, not the reviewer's.
    const verdict = securityVerdictOn(facts.checkedReviews, facts.crew, facts.securitySeat, onThisDiff);
    if (verdict !== 'approve') {
      return refuse(`${what}, so the security reviewer must approve it as well, and has not approved this head${verdict ? ` (its verdict: ${verdict})` : ''}`);
    }
  }

  // CI is GitHub Actions' check run of the `ci` workflow on this head. A
  // commit status named `ci` can be set by any token with write access, a
  // bot's included, so one is a forgery, not a pass.
  if (facts.statuses.some((status) => status.context === REQUIRED_CHECK)) return refuse(`a commit status named ${REQUIRED_CHECK} is on the head, and only GitHub Actions' check run counts`);
  // The newest check run of each name: a rerun that passed answers the
  // failure it reran.
  const runs = latestByName(facts.checkRuns);
  const ci = runs.filter((run) => run.name === REQUIRED_CHECK);
  if (ci.some((run) => run.app !== CI_APP || run.workflow?.toLowerCase() !== REQUIRED_CHECK || run.headSha !== facts.headSha)) {
    return refuse(`a ${REQUIRED_CHECK} check run on the head is not GitHub Actions' run of the ${REQUIRED_CHECK} workflow`);
  }
  const red = [
    ...runs.filter((run) => run.status === 'completed' && RED.has(run.conclusion ?? '')).map((run) => run.name),
    ...facts.statuses.filter((status) => RED.has(status.state)).map((status) => status.context),
  ];
  if (red.length > 0) return refuse(`${[...new Set(red)].join(', ')} failed on the head`);
  if (verdictFor([...ci], [REQUIRED_CHECK]) !== 'green') return refuse(`${REQUIRED_CHECK} has not passed on the head`);
  if (facts.gate !== 'success') return refuse('review-gate as OpenADLC published it is not green on the head');
  if (facts.humanRulesUnknown) return refuse('the human review rules cannot be read from AGENTS.md on the default branch');
  if (facts.requestsTakenAway === null) return refuse('its history is too long to read, so who was asked for a review is not known');
  if (facts.requestsTakenAway.length > 0) {
    return refuse(`${facts.requestsTakenAway.join(', ')} ${facts.requestsTakenAway.length === 1 ? 'was' : 'were'} asked for a review and had the request taken away by someone who cannot decide that`);
  }
  if (facts.pendingOnGitHub.length > 0) return refuse(`${facts.pendingOnGitHub.join(', ')} ${facts.pendingOnGitHub.length === 1 ? 'is asked for a review on GitHub and has' : 'are asked for a review on GitHub and have'} not given one`);

  // A required seat on an account other seats use too is the seat that wrote
  // a review only by a checked signature (`checkedForSharedSeats`). With
  // nothing here to check one, no review there is that seat's.
  const loginOf = (seat: string) => facts.crew.find((bot) => bot.name === seat)?.githubLogin ?? null;
  const shares = (seat: string) => {
    const login = loginOf(seat);
    return Boolean(login) && facts.crew.filter((bot) => sameLogin(bot.githubLogin, login)).length > 1;
  };
  const onShared = facts.requestedReviewers.filter(shares);
  if (onShared.length > 0 && !facts.checkedReviews) {
    return refuse(
      `${onShared.join(', ')} ${onShared.length === 1 ? 'signs' : 'sign'} in as an account other seats use too, and nothing here can check a signature to tell which seat wrote a review there, so a person merges it, or each of them gets a GitHub account of its own`,
    );
  }
  const reviews = checkedForSharedSeats(facts.reviews, facts.checkedReviews, facts.crew, facts.requestedReviewers);
  // The seats whose verdict on a shared account was left out as unsigned, so
  // the refusal says that rather than that they never reviewed.
  const unsigned = new Set(
    facts.reviews
      .filter((review) => !reviews.includes(review) && review.state !== 'COMMENTED' && review.state !== 'PENDING')
      .map((review) => whoWrote(review.user, facts.crew, { bot: seatOf(review.body) }))
      .flatMap((author) => (author.kind === 'fleetadlc' && author.bot ? [author.bot.name] : [])),
  );

  // A carried head stands for a seat, but not for the lead re-checking the
  // resolution it led to, nor for a person: the lead's approval carried, and
  // a builder's resolution of the Makefile landed with nobody having read it.
  const approved = (review: { state: string; commitId: string | null } | undefined, seat: string | null): 'head' | 'same diff' | null => {
    if (review?.state !== 'APPROVED' || !review.commitId) return null;
    if (review.commitId === facts.headSha) return 'head';
    if (facts.sameDiffAs.has(review.commitId)) return 'same diff';
    return seat !== null && seat !== facts.leadRechecks && facts.carriedFrom.has(review.commitId) ? 'same diff' : null;
  };

  // Latest verdict by seat, and by person: a comment is no verdict.
  const bySeat = new Map<string, (typeof facts.reviews)[number]>();
  const byPerson = new Map<string, (typeof facts.reviews)[number]>();
  for (const review of reviews) {
    if (review.state === 'COMMENTED' || review.state === 'PENDING') continue;
    const author = whoWrote(review.user, facts.crew, { bot: seatOf(review.body) });
    if (author.kind === 'fleetadlc' && author.bot) bySeat.set(author.bot.name, review);
    else if (author.kind === 'person') byPerson.set(review.user.toLowerCase(), review);
  }

  // Anyone who can write to it and still asks for changes holds it, whether
  // the rules named them or not: the owner saying no is a no. Access is what
  // GitHub answers for them — an association can read as a contributor's when
  // it is not — and not knowing holds it too. Reading is not enough: on a
  // public repository everyone can read, and a passer-by would hold every
  // pull request.
  const asking = [...byPerson.entries()].filter(
    ([login, review]) => review.state === 'CHANGES_REQUESTED' && !NO_SAY.has(facts.askingPermission.get(login) ?? 'unknown'),
  );
  if (asking.length > 0) return refuse(`${asking.map(([login]) => `@${login}`).join(', ')} still asks for changes`);
  // An advisory seat's verdict is its marker's, read by the lead; only a seat
  // whose approval lands it holds it by asking.
  const seatsAsking = [...bySeat.entries()]
    .filter(([seat, review]) => review.state === 'CHANGES_REQUESTED' && facts.requestedReviewers.includes(seat))
    .map(([seat]) => seat);
  if (seatsAsking.length > 0) return refuse(`${seatsAsking.join(', ')} still asks for changes`);

  // A required seat's approval lands a merge only when its signature checks
  // for this pull request and this review, in `audit` mode as in `enforce`.
  // A review session holds the account's own token, so anything that runs in
  // it — a test planted in the code under review included — could post an
  // approval tagged as the lead's around OpenADLC's gh, and in audit mode the
  // merge counted it. Comments and people's reviews count as the mode says.
  const signed = new Set((facts.checkedReviews ?? []).map((review) => review.id));
  const approvals: LandedApproval[] = [];
  for (const seat of facts.requestedReviewers) {
    const review = bySeat.get(seat);
    if (!review && unsigned.has(seat)) {
      return refuse(
        `${seat}'s review on ${loginOf(seat)}, an account other seats use too, is not signed by OpenADLC, so it may be another seat's; ${seat} reviews it again with OpenADLC's gh (gh pr review), which signs it, or a person merges it`,
      );
    }
    if (!review) return refuse(`${seat} has not reviewed it`);
    const of = approved(review, seat);
    if (!of) {
      return refuse(
        review.state === 'APPROVED' && seat === facts.leadRechecks && review.commitId && facts.carriedFrom.has(review.commitId)
          ? `${seat} re-checks the resolution of a conflict, and has approved only the version before it`
          : review.state === 'APPROVED'
            ? `${seat} approved an earlier version whose diff is not known to be this one`
            : `${seat}'s latest verdict is ${review.state.toLowerCase().replace('_', ' ')}`,
      );
    }
    if (!facts.checkedReviews) {
      return refuse(`${seat}'s approval cannot be checked: nothing here can check an OpenADLC signature, so a person merges it`);
    }
    if (!signed.has(review.id)) {
      return refuse(
        `${seat}'s approval is not signed by OpenADLC for this pull request, so it does not count; check the post (docs/runbooks/unsigned-post.md), then ${seat} reviews it again with OpenADLC's gh (gh pr review), which signs it, or a person merges it`,
      );
    }
    approvals.push({ reviewer: seat, person: false, commitId: review.commitId ?? '', ofHead: of === 'head' });
  }
  for (const login of facts.humansRequired) {
    const review = byPerson.get(login.toLowerCase());
    const of = approved(review, null);
    if (!review || !of) return refuse(`@${login} has not approved this version`);
    // A login is only a name, free for anyone to register once its account is
    // renamed or deleted, and anyone can review a public repository. So the
    // approval counts only from an account GitHub says can write here, the
    // same question a request for changes is asked.
    const permission = facts.askingPermission.get(login.toLowerCase()) ?? 'unknown';
    if (!MAY_APPROVE.has(permission)) {
      return refuse(`@${login} approved, but lacks write access to ${facts.repoFullName} (GitHub says ${permission}), so the approval does not count`);
    }
    approvals.push({ reviewer: login, person: true, commitId: review.commitId ?? '', ofHead: of === 'head' });
  }
  if (approvals.length === 0) return refuse('nobody was asked to review it');
  return { land: true, reason: 'every requested reviewer approved this version, and its checks are green', approvals };
}

/** A run of the CI workflow, as the review loop reads it. */
export interface CiRun {
  id: number;
  attempt: number;
  status: string;
  conclusion: string | null;
}

interface RawRun {
  id: number;
  name: string;
  run_attempt?: number;
  status: string;
  conclusion: string | null;
}

function ciRunOf(run: RawRun): CiRun {
  return { id: run.id, attempt: run.run_attempt ?? 1, status: run.status, conclusion: run.conclusion };
}

/**
 * Where a pull request falls in 0–100 for the sampled security review — the
 * same place every time it is asked.
 *
 * It was `Math.random()`, drawn again every time the gate was worked out: on
 * fleetadlc-testbed#2 the draw at opening said no security review, so none was
 * started, and the draw when the lead reviewer approved said yes — the gate
 * then waited on a security review nobody was doing, and the next draw could
 * have taken it away again. A hash of the pull request decides it once.
 */
export function reviewSample(repoFullName: string, prNumber: number): number {
  let hash = 0x811c9dc5;
  for (const char of `${repoFullName.toLowerCase()}#${prNumber}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % 10_000) / 100;
}

/**
 * The review rules as the bridge reads them. A config loaded from
 * review.yaml is already the list; one built some other way in the shape the
 * file had before (`lead`, `second`, `security`, `workflows`) is read as the
 * list it means (`legacyReviewRules`).
 */
export function reviewRulesOf(raw: unknown): ReviewRules {
  if (raw && typeof raw === 'object' && Array.isArray((raw as { reviewers?: unknown }).reviewers)) return raw as ReviewRules;
  return reviewRulesSchema.parse(raw);
}

/**
 * How far the loops go before a person is asked: review rounds, and
 * send-backs on the other edges. Read without the reviewers, which a loop
 * does not need, so a configuration that names none still has its limits.
 */
export function reviewLimits(raw: unknown): Pick<ReviewRules, 'maxRounds' | 'sendBack'> {
  const given = (raw ?? {}) as { maxRounds?: number; sendBack?: { maxPerEdge?: number; maxPerIssue?: number } };
  return {
    maxRounds: given.maxRounds ?? 3,
    sendBack: { maxPerEdge: given.sendBack?.maxPerEdge ?? 2, maxPerIssue: given.sendBack?.maxPerIssue ?? 6 },
  };
}

/** Why a reviewer seat is asked on a pull request, or null when it is not. */
function triggeredBy(
  entry: ReviewerSeat,
  input: { labels: readonly string[]; changedFiles: readonly string[]; sample: number },
): string | null {
  // The lead decides every pull request, whatever trigger it was given.
  if (entry.lead) return 'lead review is required on every pull request';
  if (entry.trigger === 'always') return `the ${entry.lens} lens reviews every pull request`;
  if (entry.trigger.labels.some((label) => input.labels.includes(label))) return `labels put this in the ${entry.lens} lens`;
  if (entry.trigger.paths.some((path) => input.changedFiles.some((file) => file.startsWith(path)))) {
    return `touches a path in the ${entry.lens} lens`;
  }
  if (input.sample < entry.trigger.samplePercent) return `sampled for a ${entry.lens} review`;
  return null;
}

/** Whether a seat is asked only by default: on every pull request, or by the sample. */
function askedByDefault(entry: ReviewerSeat, input: { labels: readonly string[]; changedFiles: readonly string[] }): boolean {
  if (entry.trigger === 'always') return true;
  const byLabel = entry.trigger.labels.some((label) => input.labels.includes(label));
  const byPath = entry.trigger.paths.some((path) => input.changedFiles.some((file) => file.startsWith(path)));
  return !byLabel && !byPath;
}

/**
 * Whether a pull request takes the fast path: the SRE's revert of a red
 * smoke, labelled `revert` on the branch that revert is opened on
 * (`REVERT_BRANCH_PREFIX`). The label on any other pull request neither drops
 * its reviewers nor jumps the merge line. A dependency bump is not one: `deps`
 * is a label the security seat is asked by. Who may put `revert` or `deps` on
 * is checked when it is put on (`Webhooks.guardFastPathLabel`).
 */
export function fastPathOf(labels: readonly string[], headRef: string | null | undefined): boolean {
  return labels.includes('revert') && Boolean(headRef?.startsWith(REVERT_BRANCH_PREFIX));
}

/**
 * How long the bridge's own dismissal is known as its own. The delivery comes
 * in seconds; a redelivery, or one GitHub held back, can come days later.
 */
const OWN_DISMISSAL_MS = 7 * 24 * 60 * 60_000;

/**
 * The GitHub automation the platform performs as one account: stage labels,
 * reviewer requests, `review:human:<login>`, and the `review-gate` status. This lives in
 * the bridge rather than in workflows because actions taken with a workflow's
 * token fire no further events, so a chain of workflows breaks at its first link.
 * Every decision here is re-derived from GitHub's current state, so a missed
 * webhook is repaired by the next one.
 */
export class Automation {
  constructor(
    private readonly config: BridgeConfig,
    private readonly actors: Actors,
    /** Publishes `review-gate` as the app's check run, where the app can; see `app-gate.ts`. */
    private readonly appGate: AppGate | null = null,
    /** Who can review where, as GitHub last said; shared with the configuration check. */
    private readonly standings: ReviewerStandings = reviewerStandings,
  ) {}

  private async automationClient() {
    return asAutomation(this.actors, this.config);
  }

  /**
   * The review rules with each bot named as it is now.
   *
   * config/review.yaml names seats — `lead-reviewer`, not whoever holds it —
   * because a bot takes its account's handle when one connects, and a file
   * naming handles would need editing every time an account changed. A rule
   * naming a bot this crew does not have is left as it is written, so what
   * reaches a request or a status still says what was asked for.
   */
  reviewRules(crew: readonly { name: string; slot: string }[]): ReviewRules {
    const rules = reviewRulesOf(this.config.review);
    const who = (reference: string): string => resolveBotRef(crew, reference)?.name ?? reference;
    return { ...rules, reviewers: rules.reviewers.map((entry) => ({ ...entry, seat: who(entry.seat) })) };
  }

  /**
   * Decides who reviews a pull request, from the rules, not from a bot's choice.
   *
   * Given the crew, the reviewers come back as the names those bots go by, so
   * a request, a task and the gate's "waiting on" all name the account that
   * will actually review.
   */
  decideReviewers(
    input: {
      labels: string[];
      changedFiles: string[];
      /** Labelled `revert`: the one change the lead may review alone. */
      isRevert: boolean;
      humanReviewPaths: string[];
      /**
       * Where this pull request falls in 0–100, for the sampled reviews:
       * `reviewSample`, the same answer every time it is asked.
       */
      sample: number;
      /**
       * Of the changed files that decide how CI runs only in part, those whose
       * CI part changed (`ciKeysChanged`). Absent, every such file counts, as
       * `ciKeysChanged` counts one it cannot read.
       */
      ciKeysChanged?: readonly string[];
    },
    crew: readonly { name: string; slot: string }[] = [],
  ): ReviewerDecision {
    const rules = this.reviewRules(crew);
    const lead = leadReviewer(rules);
    const reasons: Record<string, string> = {};

    const reviewers: string[] = [];
    for (const entry of rules.reviewers) {
      const why = triggeredBy(entry, input);
      if (!why || reviewers.includes(entry.seat)) continue;
      // A revert drops only the seats there by default. One its own label or
      // path asked for still reads it — the security seat on its paths — and
      // so does a blocking seat: the revert went to the lead alone whatever it
      // touched, and the label was one a session could put on its own pull
      // request to choose one-model review.
      if (input.isRevert && !entry.lead && !entry.blocking && askedByDefault(entry, input)) continue;
      reviewers.push(entry.seat);
      reasons[entry.seat] = entry.lead && input.isRevert ? 'fast path: revert' : why;
    }

    // A change to how CI runs grades itself, so the security reviewer reads
    // it too, whatever its own trigger says. `mergeDecision` counts its
    // signed verdict, including the one an advisory seat posts as a comment.
    // The same files `mergeDecision` counts: a package.json whose `scripts`
    // changed was not asked about, and waited at the front of the merge
    // line for a person.
    const security = rules.reviewers.find((entry) => entry.lens === 'security');
    const ciFiles = [
      ...input.changedFiles.filter(changesCi),
      ...(input.ciKeysChanged ?? input.changedFiles.filter((file) => !changesCi(file) && mayDefineCi(file))),
    ];
    if (security && ciFiles.length > 0 && !reviewers.includes(security.seat)) {
      reviewers.push(security.seat);
      reasons[security.seat] = `changes how CI runs (${ciFiles.slice(0, 3).join(', ')})`;
    }

    const humanReviewRequired = input.humanReviewPaths.some((path) =>
      input.changedFiles.some((file) => file.startsWith(path)),
    );

    // Not an approver just because this pull request changes CI. The default
    // security seat is advisory: its gh refuses --approve, so a gate that
    // waited for an APPROVED review never finished, and the pull request
    // never reached the merge line. `mergeDecision` already reads the signed
    // verdict in the comment that seat can post. A seat marked blocking is
    // an approver, as any other blocking seat is.
    const approvers = rules.reviewers
      .filter((entry) => (entry.lead || entry.blocking) && reviewers.includes(entry.seat))
      .map((entry) => entry.seat);
    return { reviewers, lead: lead.seat, approvers, reasons, humanReviewRequired };
  }

  /**
   * `review-gate` as the reviews stand on this diff.
   *
   * Pending while the pull request is a draft; while a seat asked before the
   * lead has not posted; then while the lead has not; while a seat whose
   * approval a merge needs asks for changes or has not approved; and while a
   * person the repository names has not approved. A seat that cannot be asked
   * is not waited on, and a gate that can never pass because of one fails.
   *
   * The lead reviews last: every other seat posts first, on this diff, and the
   * lead reads them all and decides. Given no `lead`, every seat asked is
   * waited on together, as before reviewers were a list.
   */
  computeReviewGate(input: {
    draft: boolean;
    requestedReviewers: string[];
    /** Seats that posted a review on this diff, a comment included. */
    postedReviewers: string[];
    /** The seat that reviews last and decides. */
    lead?: string;
    /** Of the requested reviewers, those whose approval a merge needs; absent, all of them. */
    approvers?: string[];
    /** Of the approvers, those whose latest verdict asks for changes. */
    changesRequestedBy?: string[];
    /** Of the approvers, those whose latest verdict on this diff approves; absent, posting is enough. */
    approvedBy?: string[];
    /** Logins whose approval this change needs, from the repository's own rules. */
    humansRequired: string[];
    /** Of those, who has approved the head that would land. */
    humansApproved: string[];
    /** True when the rules could not be read at all, which holds rather than releases. */
    humanRulesUnknown?: boolean;
    /** True when GitHub would not list every file the pull request changes, which holds rather than releases. */
    filesUnknown?: boolean;
    /**
     * Seats and logins GitHub will not ask for a review here, by lower-cased
     * name, with why: `cannotReviewHere`. Absent or unknown is "can", so an
     * outage never changes the gate's words.
     */
    cannotReview?: ReadonlyMap<string, string>;
  }): ReviewGate {
    if (input.draft) return { state: 'pending', description: 'pull request is still a draft' };

    const never = (name: string): string | undefined => input.cannotReview?.get(name.toLowerCase());
    const outstanding = input.requestedReviewers.filter((reviewer) => !input.postedReviewers.includes(reviewer));
    // A seat GitHub refused to ask is not waited on: "waiting on" someone who
    // can never review was a gate that never finished and said nothing why.
    const waiting = outstanding.filter((reviewer) => !never(reviewer));
    // The others first: the lead's review is the one that reads theirs.
    const before = input.lead ? waiting.filter((reviewer) => reviewer !== input.lead) : waiting;
    if (before.length > 0) return { state: 'pending', description: `waiting on ${before.join(', ')}` };
    if (waiting.length > 0) return { state: 'pending', description: `waiting on ${waiting.join(', ')}` };

    // Posted is not approved. Every review in, with one asking for changes, is
    // a pull request that is not done — and where no ruleset holds the merge,
    // this gate is the only thing that says so.
    const approvers = (input.approvers ?? input.requestedReviewers).filter((reviewer) => input.requestedReviewers.includes(reviewer));
    const asking = (input.changesRequestedBy ?? []).filter((reviewer) => approvers.includes(reviewer));
    if (asking.length > 0) {
      return { state: 'pending', description: `changes requested by ${asking.join(', ')}` };
    }
    const unapproved = input.approvedBy ? approvers.filter((reviewer) => !input.approvedBy!.includes(reviewer) && !never(reviewer)) : [];
    if (unapproved.length > 0) {
      return { state: 'pending', description: fitStatus(`not approved yet by ${unapproved.join(', ')}`) };
    }

    // Not knowing who has to approve is not the same as nobody having to, and
    // the safe reading of an unreadable rule is that it applies.
    if (input.humanRulesUnknown) {
      return { state: 'pending', description: 'cannot read the human review rules from AGENTS.md on the base branch' };
    }

    // Nor is a file list GitHub refused, or cut off at 3000, a pull request
    // that changes nothing: read as one, it named nobody for `config/` and
    // the gate went green on the bots' approvals, which is all a repository
    // that merges by ruleset or by hand waits for.
    if (input.filesUnknown) {
      return { state: 'pending', description: 'cannot read every file this pull request changes' };
    }

    const waitingOn = input.humansRequired.filter((login) => !input.humansApproved.includes(login));
    // What is left is a reviewer who cannot review here. That is a pull
    // request that can never pass as things stand, so it fails, which is what
    // makes it show as needing a person rather than as one more that waits.
    const stuck = [
      ...outstanding.filter((reviewer) => never(reviewer)).map((reviewer) => ({ shown: reviewer, reason: never(reviewer)! })),
      // One that cannot be asked but posted something other than an approval
      // — a comment — is stuck too: left out of `unapproved` above, it let the
      // gate go green with no approval from it.
      ...(input.approvedBy
        ? approvers
            .filter((reviewer) => never(reviewer) && !outstanding.includes(reviewer) && !input.approvedBy!.includes(reviewer))
            .map((reviewer) => ({ shown: reviewer, reason: never(reviewer)! }))
        : []),
      ...waitingOn.filter((login) => never(login)).map((login) => ({ shown: `@${login}`, reason: never(login)! })),
    ];
    const first = stuck[0];
    if (first) {
      const more = stuck.length > 1 ? ` (+${stuck.length - 1} more)` : '';
      return { state: 'failure', description: fitStatus(`${first.shown} cannot be asked for a review: ${first.reason}${more}`) };
    }
    if (waitingOn.length > 0) {
      // Naming them is the point: `waiting on a human reviewer` is what let one
      // person's approval stand in for another's.
      return { state: 'pending', description: `waiting on ${waitingOn.map((login) => `@${login}`).join(', ')}` };
    }

    return { state: 'success', description: 'every requested review has been posted' };
  }

  /**
   * Which of the named people have approved the change that would land: the
   * head, or an earlier head whose diff against the base is the same
   * (`sameDiff`), as `mergeDecision` counts them.
   *
   * The merge line brings an approved pull request up to date with the base,
   * which moves the head without changing the work. Counting only the exact
   * head, the gate went back to waiting on the person after every update, and
   * the line stood at the front until they approved the same diff again. An
   * approval of a different diff is not one of this change. GitHub omits the
   * commit on some older reviews; a review with none recorded is not counted,
   * because the alternative is treating an unknown as the current head.
   * Logins are matched without case, as GitHub's are.
   *
   * Nor is one from a login GitHub says cannot review here (`cannot`, by
   * lower-cased login, from `cannotReviewHere`): a login is free for anyone to
   * register once its account is renamed or deleted, and anyone can review a
   * public repository. The merge asks for write access itself.
   */
  approvedTheHead(
    required: string[],
    reviews: { user: string; state: string; commitId: string | null }[],
    headSha: string,
    sameDiff: ReadonlySet<string> = new Set(),
    cannot: ReadonlyMap<string, string> = new Map(),
  ): string[] {
    const latest = new Map<string, { state: string; commitId: string | null }>();
    for (const review of reviews) {
      if (review.state === 'COMMENTED' || review.state === 'PENDING') continue;
      latest.set(review.user.toLowerCase(), review);
    }
    return required.filter((login) => {
      const review = latest.get(login.toLowerCase());
      if (review?.state !== 'APPROVED' || !review.commitId || cannot.has(login.toLowerCase())) return false;
      return review.commitId === headSha || sameDiff.has(review.commitId);
    });
  }

  /**
   * The gate as it stands, read from GitHub rather than assumed.
   *
   * Used when a push moved the head without changing the diff: the reviews that
   * were already posted still count, so the status on the new head has to say
   * what is actually true rather than resetting to pending and asking for a
   * round that nothing invalidated.
   */
  async reviewGateFor(
    repoFullName: string,
    pr: { number: number; draft: boolean; labels: { name: string }[]; head: { sha: string; ref?: string }; baseRef: string },
  ): Promise<ReviewGate> {
    return (await this.reviewStanding(repoFullName, pr)).gate;
  }

  /**
   * The reviews on this diff, and what they leave to do: the gate, and whether
   * the lead's review is due.
   *
   * On this diff: a review of the head, or of an earlier head whose diff
   * against the base is the head's own — the merge line's update from the base
   * moves the head and changes nothing about the work. A review of an earlier
   * diff is of work that is no longer there.
   *
   * The lead's review is due once every other seat asked has posted on this
   * diff, or cannot be asked, and the lead has not. `since` is the later of
   * when the last of them posted and when this diff's round began
   * (`REVIEW_ROUND_OPENED`): a lead task opened since then is already that
   * review, so asking again is never twice for one diff. A pull request the
   * lead alone reviews has only the round's start; with neither, it is null,
   * and only a lead task under way counts.
   *
   * After a lead-only resolution of a conflict, the other seats' reviews of
   * the head it led from stand, but the lead's do not: the lead re-checks the
   * resolution, on the head itself or a head with its diff, and `since` is
   * no earlier than the resolution, so the lead's review from before it is
   * not taken for that re-check.
   */
  async reviewStanding(
    repoFullName: string,
    pr: { number: number; draft: boolean; labels: { name: string }[]; head: { sha: string; ref?: string }; baseRef: string },
  ): Promise<{
    gate: ReviewGate;
    decision: ReviewerDecision;
    /** Seats that posted on this diff. */
    posted: string[];
    /** Of the approvers, those whose latest verdict on this diff approves. */
    approved: string[];
    /** Of the approvers, those whose latest verdict on this diff asks for changes. */
    changesRequested: string[];
    /**
     * The security seat, when this changes how CI runs and its signed verdict
     * on this diff asks for changes. Not an approver, so not in
     * `changesRequested`, but the merge waits on it all the same.
     */
    securityAsks: string | null;
    leadDue: { seat: string; since: string | null } | null;
  }> {
    const client = await this.automationClient();
    const labels = pr.labels.map((label) => label.name);
    // A list that could not be read, or stopped at GitHub's 3000, holds the
    // gate (`filesUnknown`); what it did list is still used.
    let changedFiles: string[] = [];
    let filesUnknown = false;
    if (client) {
      try {
        const listed = await client.listEveryPullFile(repoFullName, pr.number);
        changedFiles = listed.files;
        filesUnknown = !listed.complete;
      } catch {
        filesUnknown = true;
      }
    }
    const reviews = client ? await client.listReviews(repoFullName, pr.number).catch(() => []) : [];
    // As `mergeFacts` reads them, so the gate waits on whom the merge will.
    const ciKeys = client
      ? await ciKeysChanged(changedFiles, (path, ref) => client.readFileIfPresent(repoFullName, path, ref), { base: pr.baseRef, head: pr.head.sha })
      : undefined;

    const crew = await bots.listBots();
    const decision = this.decideReviewers(
      {
        labels,
        changedFiles,
        isRevert: fastPathOf(labels, pr.head.ref),
        humanReviewPaths: [],
        sample: reviewSample(repoFullName, pr.number),
        ciKeysChanged: ciKeys,
      },
      crew,
    );

    // A seat with no account connected is asked for nothing, and the gate
    // does not wait on it — except the lead and a blocking seat, whose
    // approval the merge needs whoever holds them.
    const asked = decision.reviewers.filter(
      (seat) => decision.approvers.includes(seat) || Boolean(crew.find((bot) => bot.name === seat)?.githubLogin),
    );
    // A dismissed review stands for nothing: counted as posted, a seat whose
    // review a bot dismissed was never asked again, and a dismissed lead was
    // never due, so the pull request waited for a person.
    const standing = reviews.filter((review) => review.state.toUpperCase() !== 'DISMISSED');
    const counted = await this.countableReviews(standing, crew);
    const carried = await this.carriedTo(repoFullName, pr.number, pr.head.sha);
    // Whatever the attribution mode: on a shared account, a lead-tagged post
    // that is not checked is neither the lead's review nor a reason not to ask
    // the lead for one. A check that could not run holds rather than counts.
    const checked = this.actors.attribution
      ? await this.actors.attribution.reviewsThatCount(repoFullName, pr.number, reviews, crew).catch(() => null)
      : null;
    const resolution = await this.resolvedAt(repoFullName, pr.number, pr.head.sha);
    let reviewed = client ? await this.onThisDiff(client, repoFullName, pr.baseRef, pr.head.sha, counted, carried) : counted;
    if (client && resolution.rechecks && carried.size > 0) {
      const own = new Set(await this.onThisDiff(client, repoFullName, pr.baseRef, pr.head.sha, counted));
      reviewed = reviewed.filter((review) => {
        const author = whoWrote(review.user, crew, { bot: seatOf(review.body) });
        return own.has(review) || author.kind !== 'fleetadlc' || author.bot?.name !== decision.lead;
      });
    }
    const onDiff = checkedForSharedSeats(reviewed, checked, crew, decision.approvers);
    const posted = seatsThatPosted(onDiff, crew, asked);
    const asking = seatsAskingForChanges(onDiff, crew, decision.approvers);
    const approving = seatsApproving(onDiff, crew, decision.approvers);

    const { rules, required } = await this.humansRequiredFor(repoFullName, pr.baseRef, pr.head.sha, changedFiles);
    const cannot = await this.cannotReviewHere(repoFullName, { seats: asked, humans: required });
    // The named people's reviews of this diff, compared from the reviews
    // themselves: not `reviewed`, which a lead-only conflict resolution
    // carried to this head without the person having seen it. With no client
    // to compare with, only the head counts.
    const theirs = reviews.filter((review) => required.some((login) => sameLogin(login, review.user)));
    const peopleOnDiff = new Set(
      client && theirs.length > 0
        ? (await this.onThisDiff(client, repoFullName, pr.baseRef, pr.head.sha, theirs)).flatMap((review) => (review.commitId ? [review.commitId] : []))
        : [],
    );

    let gate = this.computeReviewGate({
      draft: pr.draft,
      requestedReviewers: asked,
      postedReviewers: posted,
      lead: decision.lead,
      approvers: decision.approvers,
      changesRequestedBy: asking,
      approvedBy: approving,
      humansRequired: required,
      humansApproved: this.approvedTheHead(required, reviews, pr.head.sha, peopleOnDiff, cannot),
      humanRulesUnknown: rules === null,
      filesUnknown,
      cannotReview: cannot,
    });
    // An advisory security seat is not an approver: its gh refuses --approve,
    // and the gate used to go green on the lead's approval whatever that
    // seat's comment said. On a change to how CI runs the merge line reads
    // the signed verdict, and the gate does too.
    const security = this.reviewRules(crew).reviewers.find((entry) => entry.lens === 'security');
    const securitySeat = security ? (resolveBotRef(crew, security.seat)?.name ?? security.seat) : null;
    const ciFiles = [
      ...changedFiles.filter(changesCi),
      ...(ciKeys ?? changedFiles.filter((file) => !changesCi(file) && mayDefineCi(file))),
    ];
    let securityAsks: string | null = null;
    if (securitySeat && ciFiles.length > 0) {
      const signed = new Set((checked ?? []).map((review) => review.id));
      const verdict = checked ? securityVerdictOn(reviewed.filter((review) => signed.has(review.id)), crew, securitySeat, () => true) : null;
      if (verdict === 'request_changes') securityAsks = securitySeat;
      if (gate.state === 'success' && verdict !== 'approve') {
        gate = {
          state: 'pending',
          description: securityAsks ? `changes requested by ${securitySeat}` : fitStatus(`not approved yet by ${securitySeat}`),
        };
      }
    }

    const others = asked.filter((seat) => seat !== decision.lead);
    const othersIn = others.every((seat) => posted.includes(seat) || cannot.has(seat.toLowerCase()));
    const due = !pr.draft && othersIn && !posted.includes(decision.lead) && !cannot.has(decision.lead.toLowerCase());
    const leadDue = due
      ? { seat: decision.lead, since: await this.leadAskedSince(repoFullName, pr.number, lastPostedBy(onDiff, crew, others), resolution.at) }
      : null;
    return { gate, decision, posted, approved: approving, changesRequested: asking, securityAsks, leadDue };
  }

  /**
   * The latest of when the others last posted, when this diff's round began
   * and when a lead-only resolution that led to the head was pushed; null when
   * none is known.
   */
  private async leadAskedSince(repoFullName: string, prNumber: number, lastPosted: string | null, resolved: string | null): Promise<string | null> {
    const name = repoFullName.split('/')[1] ?? repoFullName;
    const began = await lastEventAt(REVIEW_ROUND_OPENED, { subjectRef: `${name}#${prNumber}` }).catch(() => null);
    const known = [began, lastPosted, resolved].filter((at): at is string => Boolean(at));
    return known.length > 0 ? known.reduce((latest, at) => (Date.parse(at) > Date.parse(latest) ? at : latest)) : null;
  }

  /**
   * The reviews of this diff: of the head, or of an earlier head whose diff
   * against the base is the same. A comparison GitHub cannot make leaves the
   * review out, as `contentChanged` reads not knowing.
   */
  async onThisDiff<R extends { commitId?: string | null }>(
    client: Pick<GitHubClient, 'diffFingerprint'>,
    repoFullName: string,
    baseRef: string,
    headSha: string,
    reviews: readonly R[],
    /**
     * Earlier heads a lead-only resolution of a conflict led from
     * (`ConflictRounds.carriedTo`): their reviews stand, but the lead's own
     * has to be of the resolution (`reviewStanding` drops it).
     */
    carried: ReadonlySet<string> = new Set(),
  ): Promise<R[]> {
    const earlier = [...new Set(reviews.map((review) => review.commitId).filter((sha): sha is string => Boolean(sha) && sha !== headSha))];
    const same = new Set<string>([headSha, ...carried]);
    if (earlier.length > 0) {
      // The diff now, and the diff of each head a resolution carried from: a
      // review of any of them is of the change as it was approved.
      const nows = [await client.diffFingerprint(repoFullName, baseRef, headSha).catch(() => null)];
      for (const sha of carried) nows.push(await client.diffFingerprint(repoFullName, baseRef, sha).catch(() => null));
      for (const sha of earlier) {
        if (same.has(sha)) continue;
        const then = await client.diffFingerprint(repoFullName, baseRef, sha).catch(() => null);
        if (nows.some((now) => !contentChanged(then, now))) same.add(sha);
      }
    }
    return reviews.filter((review) => Boolean(review.commitId) && same.has(review.commitId as string));
  }

  /** The earlier heads whose reviews a lead-only conflict resolution or a stacked update carried to a head; set once at start-up (`main.ts`). */
  private carriedHeads: ((repoName: string, prNumber: number, head: string) => Promise<Set<string>>) | null = null;

  useCarriedHeads(carried: (repoName: string, prNumber: number, head: string) => Promise<Set<string>>): void {
    this.carriedHeads = carried;
  }

  private async carriedTo(repoFullName: string, prNumber: number, head: string): Promise<Set<string>> {
    const name = repoFullName.split('/')[1] ?? repoFullName;
    return this.carriedHeads ? await this.carriedHeads(name, prNumber, head).catch(() => new Set<string>()) : new Set<string>();
  }

  /** When the lead-only resolution of a conflict that led to a head was pushed (`ConflictRounds.resolvedAt`); set once at start-up (`main.ts`). */
  private resolutions: ((repoName: string, prNumber: number, head: string) => Promise<string | null>) | null = null;

  useResolutions(resolvedAt: (repoName: string, prNumber: number, head: string) => Promise<string | null>): void {
    this.resolutions = resolvedAt;
  }

  /**
   * Whether the lead re-checks a resolution that led to this head, and when
   * it was pushed. A read that fails is taken as a resolution of unknown time:
   * the lead's carried approval is not counted on a guess.
   */
  private async resolvedAt(repoFullName: string, prNumber: number, head: string): Promise<{ rechecks: boolean; at: string | null }> {
    if (!this.resolutions) return { rechecks: false, at: null };
    const name = repoFullName.split('/')[1] ?? repoFullName;
    return this.resolutions(name, prNumber, head).then(
      (at) => ({ rechecks: at !== null, at }),
      () => ({ rechecks: true, at: null }),
    );
  }

  /**
   * GitHub's answer about one login in one repository: as the app, which can
   * read any collaborator's permission, else as the automation account, which
   * holds triage and is told nothing; `unknown` when there is neither.
   */
  async askStanding(repoFullName: string, login: string): Promise<ReviewerStanding> {
    const client = (await theApp(repoFullName)) ?? (await this.automationClient().catch(() => null));
    if (!client) return { state: 'unknown', reason: 'there is no automation account to ask GitHub as' };
    return reviewerStandingOf(client, repoFullName, login);
  }

  /** The kept answer about one login, or GitHub's when there is none; `fresh` asks again. */
  standingOf(repoFullName: string, login: string, options: { fresh?: boolean } = {}): Promise<ReviewerStanding> {
    return this.standings.of(repoFullName, login, (repo, who) => this.askStanding(repo, who), options);
  }

  /**
   * Of the seats and people a gate could wait on, those GitHub will not ask
   * for a review in this repository, by lower-cased name, with why.
   *
   * A person is asked about through the kept answers, which the configuration
   * check refreshes, so a pull request costs GitHub a call only for someone
   * nobody has asked about this hour. A seat is never asked about here: its
   * access is the crew's check, and what is known of it is a request GitHub
   * refused (`requestReviewers`). Anything not known is left out, so the gate
   * keeps its usual words rather than calling somebody missing on a guess.
   *
   * `@owner` is not asked about: it is the placeholder from OpenADLC's AGENTS.md
   * template, and the gate says so rather than "not a collaborator" or "an
   * organization", either of which sends a person to the wrong fix.
   */
  async cannotReviewHere(repoFullName: string, input: { seats: readonly string[]; humans: readonly string[] }): Promise<Map<string, string>> {
    const cannot = new Map<string, string>();
    const refused = (standing: ReviewerStanding | null): string | null =>
      standing && standing.state !== 'can-review' && standing.state !== 'unknown' ? standing.reason : null;
    if (input.seats.length > 0) {
      const crew = await bots.listBots().catch(() => []);
      for (const seat of input.seats) {
        const login = crew.find((bot) => bot.name === seat)?.githubLogin;
        const reason = login ? refused(this.standings.known(repoFullName, login)) : null;
        if (reason) cannot.set(seat.toLowerCase(), reason);
      }
    }
    for (const login of input.humans) {
      if (isTemplatePlaceholder(login)) {
        cannot.set(login.toLowerCase(), 'it is the AGENTS.md template’s placeholder; name who must approve');
        continue;
      }
      const reason = refused(await this.standingOf(repoFullName, login).catch(() => null));
      if (reason) cannot.set(login.toLowerCase(), reason);
    }
    return cannot;
  }

  /**
   * Drops what is kept about the crew's own accounts. A seat GitHub refused
   * once — not yet let into the repository — read as "cannot be asked" for the
   * hour its answer was kept, after the crew's access was put right and while
   * nothing asked again. Called when the crew's access changes or its check
   * recovers, so the next gate waits on the seat again rather than failing.
   */
  async forgetCrewStandings(): Promise<void> {
    for (const bot of await bots.listBots().catch(() => [])) {
      if (bot.githubLogin) this.standings.forget(bot.githubLogin);
    }
  }

  /**
   * The reviews that count toward the gate: every one, unless the install
   * enforces signatures, when a crew review counts only if its signature checks
   * (`attribution.ts`) — a review written around OpenADLC's `gh`, or by anything
   * else signed in as the reviewer account, is then nobody's.
   */
  async countableReviews<R extends { user: string | null; body?: string | null }>(
    reviews: readonly R[],
    crew: readonly { githubLogin: string | null }[],
  ): Promise<R[]> {
    const attribution = this.actors.attribution;
    if (!attribution) return [...reviews];
    const mode = (await effectiveConfig(this.config).catch(() => null))?.attributionMode ?? 'audit';
    return attribution.countable(reviews, crew, mode).catch(() => [...reviews]);
  }

  /** One workflow run as it is now: its attempt moves on when it is run again. */
  async ciRunById(repoFullName: string, runId: number): Promise<CiRun | null> {
    const client = await this.automationClient();
    if (!client) return null;
    return ciRunOf(await client.request<RawRun>('GET', `/repos/${repoFullName}/actions/runs/${runId}`));
  }

  /**
   * Runs a workflow run's failed jobs again, as the app. False when the app
   * cannot be asked; a refusal — the app lacks "Actions: write", which its
   * permissions card then asks for — is thrown, for the caller to say.
   *
   * As the app and not the automation account: on an install whose crew shares
   * one GitHub account, that account is the builder's too, and a bot re-running
   * its own CI until it passes is not what a rerun of a flaky test is for.
   */
  async rerunFailedJobs(repoFullName: string, runId: number): Promise<boolean> {
    const app = await this.appGate?.client(repoFullName).catch(() => null);
    if (!app) return false;
    await app.request('POST', `/repos/${repoFullName}/actions/runs/${runId}/rerun-failed-jobs`);
    return true;
  }

  /**
   * What `mergeDecision` reads, from GitHub as it is now. Every list is read
   * to its end, and a read that fails fails this — the merge then waits —
   * rather than deciding on part of it. Diffs are compared only for heads a
   * reviewer approved that are not the head. Null when the automation account
   * cannot read GitHub.
   */
  async mergeFacts(
    repo: { fullName: string; defaultBranch: string },
    pull: {
      number: number;
      draft: boolean;
      headSha: string;
      /**
       * The head branch: `revert` takes the fast path only on the SRE's
       * (`fastPathOf`), and an `agent/` one is the crew's, held to its lease's paths.
       */
      headRef?: string;
      baseRef: string;
      labels: string[];
      mergeableState: string | null;
      headRepoFullName: string | null;
      requestedReviewers: string[];
      requestedTeams: string[];
    },
  ): Promise<MergeFacts | null> {
    const client = await this.automationClient();
    if (!client) return null;
    const repoFullName = repo.fullName;
    const [files, reviews, runs, statuses, crew, gate, mode] = await Promise.all([
      client.listEveryPullFile(repoFullName, pull.number),
      client.listReviews(repoFullName, pull.number),
      client.checkRunsFor(repoFullName, pull.headSha),
      client.statusesFor(repoFullName, pull.headSha),
      bots.listBots(),
      this.publishedGate(repoFullName, pull.headSha),
      // Unreadable, it is not `enforce`, which is the reading that refuses.
      effectiveConfig(this.config)
        .then((live) => live.attributionMode)
        .catch(() => 'audit' as const),
    ]);
    // From the default branch: a pull request into another branch could have
    // been opened against a copy with the human paths taken out.
    const humans = await this.humansRequiredFor(repoFullName, repo.defaultBranch, pull.headSha, files.files);
    // What changed in the files that decide how CI runs only in part, base
    // against head; who was asked for a review and had it taken away; and
    // whose request for changes was dismissed, and by whom.
    const [ciKeys, history] = await Promise.all([
      ciKeysChanged(files.files, (path, ref) => client.readFileIfPresent(repoFullName, path, ref), { base: repo.defaultBranch, head: pull.headSha }),
      client.listPullHistory(repoFullName, pull.number),
    ]);
    const decision = this.decideReviewers(
      {
        labels: pull.labels,
        changedFiles: files.files,
        isRevert: fastPathOf(pull.labels, pull.headRef),
        humanReviewPaths: [],
        sample: reviewSample(repoFullName, pull.number),
        ciKeysChanged: ciKeys,
      },
      crew,
    );
    // Signatures enforced, a review whose signature does not check is nobody's.
    // Its failure is not a reason to count them all, as the gate would.
    const attribution = this.actors.attribution;
    const signaturesEnforced = mode === 'enforce' && Boolean(attribution);
    // Checked whether or not they are enforced: a change to how CI runs lands
    // on the security reviewer's verdict, and only a checked one.
    const checked = attribution ? await attribution.reviewsThatCount(repoFullName, pull.number, reviews, crew) : null;

    const writers = new Map<string, boolean>();
    for (const entry of history ?? []) {
      if (entry.event !== 'review_request_removed' && entry.event !== 'review_dismissed') continue;
      if (!entry.actor || entry.viaApp || crew.some((bot) => sameLogin(bot.githubLogin, entry.actor))) continue;
      const login = entry.actor.toLowerCase();
      if (!writers.has(login)) writers.set(login, CAN_DECIDE.has(await permissionOn(client, repoFullName, entry.actor)));
    }
    const mayDecide = (actor: string | null, viaApp: boolean) => !viaApp && Boolean(actor) && (writers.get(actor?.toLowerCase() ?? '') ?? false);
    // The bridge withdraws, as the automation account, the request of each of
    // the install's people this change does not need (`dropUnneededHumanRequests`):
    // CODEOWNERS asks for a person on every pull request. Read as a crew
    // account taking a request away, that held every such pull request for
    // that person, and the merge line behind it. Only that withdrawal is the
    // bridge's to make: a person the rules need, any other crew account, and
    // rules that cannot be read still hold. Whether GitHub marks it as made
    // through an app depends on how the account's token was issued, so that
    // is not read here; only the bridge holds the automation account's token.
    const automationLogin = (await automationBot(this.config))?.githubLogin ?? null;
    const withdrawnByBridge = (actor: string | null, subject: string) =>
      humans.rules !== null &&
      Boolean(automationLogin && actor && sameLogin(automationLogin, actor)) &&
      (this.config.humans ?? []).some((login) => sameLogin(login, subject)) &&
      !humans.required.some((login) => sameLogin(login, subject));
    const takenAway = requestsTakenAway(history, (actor, viaApp, subject) => mayDecide(actor, viaApp) || withdrawnByBridge(actor, subject));
    // A request for changes dismissed by someone who may not is still one.
    const stillAsking = dismissalsThatHold(history, mayDecide);
    const counted = (signaturesEnforced && checked ? checked : reviews).map((review) =>
      review.state === 'DISMISSED' && stillAsking.has(review.id) ? { ...review, state: 'CHANGES_REQUESTED' } : review,
    );

    // What each person still asking for changes may do here, asked of GitHub:
    // their association can read as a contributor's when it is not. Asked as
    // the app first (`permissionOn`): GitHub answers this only to an account
    // that can push, and the automation account may hold triage. Unknown is
    // kept as unknown, which holds the merge.
    const asking = new Map<string, string>();
    for (const review of latestByLogin(counted)) {
      if (review.state !== 'CHANGES_REQUESTED' || crew.some((bot) => sameLogin(bot.githubLogin, review.user))) continue;
      asking.set(review.user.toLowerCase(), await permissionOn(client, repoFullName, review.user));
    }
    // And each person the rules require, whose approval counts only with
    // write access or more (`mergeDecision`).
    for (const login of humans.required) {
      if (asking.has(login.toLowerCase())) continue;
      asking.set(login.toLowerCase(), await permissionOn(client, repoFullName, login));
    }

    // Which workflow each of CI's check runs belongs to, from the run behind it.
    const checkRuns = await Promise.all(
      runs.map(async (run) => ({
        ...run,
        workflow:
          run.name === REQUIRED_CHECK && run.app === CI_APP && run.suiteId !== null
            ? ((await client.workflowRunOfSuite(repoFullName, run.suiteId))?.name ?? null)
            : null,
      })),
    );

    const security = this.reviewRules(crew).reviewers.find((entry) => entry.lens === 'security');
    const securitySeat = security ? (resolveBotRef(crew, security.seat)?.name ?? security.seat) : null;
    const live = await effectiveConfig(this.config).catch(() => null);
    // Unreadable settings may be the ones that asked for a person: a person.
    const ciMergedBy = !live || !live.settingsRead || live.ciMergeByPerson.includes(repoFullName.split('/')[1]?.toLowerCase() ?? '') ? 'person' : 'fleetadlc';

    // The earlier heads an approval, or the security reviewer's verdict, was on.
    const earlier = [
      ...new Set(
        [...counted, ...(checked ?? [])]
          .filter((review) => (review.state === 'APPROVED' || (() => { const author = whoWrote(review.user, crew, { bot: seatOf(review.body) }); return author.kind === 'fleetadlc' && author.bot?.name === securitySeat; })()) && review.commitId && review.commitId !== pull.headSha)
          .map((review) => review.commitId as string),
      ),
    ];
    // Heads a lead-only resolution of a conflict carried from, and any whose
    // diff is one of theirs, are kept apart from heads with this diff: they
    // stand for the seats, but the lead re-checks the resolution on this diff
    // and a person approves this one (`ConflictRounds`).
    const carried = await this.carriedTo(repoFullName, pull.number, pull.headSha);
    const resolution = await this.resolvedAt(repoFullName, pull.number, pull.headSha);
    const sameDiffAs = new Set<string>();
    const carriedFrom = new Set<string>(carried);
    if (earlier.length > 0) {
      const now = await client.diffFingerprint(repoFullName, pull.baseRef, pull.headSha);
      const ofCarried = new Map<string, string | null>();
      for (const sha of carried) ofCarried.set(sha, await client.diffFingerprint(repoFullName, pull.baseRef, sha).catch(() => null));
      for (const sha of earlier) {
        const then = ofCarried.has(sha) ? (ofCarried.get(sha) ?? null) : await client.diffFingerprint(repoFullName, pull.baseRef, sha);
        if (!contentChanged(then, now)) sameDiffAs.add(sha);
        else if ([...ofCarried.values()].some((one) => !contentChanged(then, one))) carriedFrom.add(sha);
      }
    }

    const crewBranch = Boolean(pull.headRef?.startsWith('agent/')) && pull.headRepoFullName?.toLowerCase() === repoFullName.toLowerCase();
    const scope = crewBranch ? await this.scopeFacts(client, repoFullName, pull, history, crew) : { crewBranch: false, issue: null, closes: [], declared: null, crossCutting: false };

    return {
      repoFullName,
      headRepoFullName: pull.headRepoFullName,
      held: pull.labels.includes('needs-human') || pull.labels.includes(PAUSED_LABEL),
      baseRef: pull.baseRef,
      defaultBranch: repo.defaultBranch,
      draft: pull.draft,
      mergeableState: pull.mergeableState,
      headSha: pull.headSha,
      filesComplete: files.complete,
      files: files.files,
      ciKeysChanged: ciKeys,
      requestsTakenAway: takenAway,
      // Whose approval lands it: the lead, and any seat marked blocking. The
      // others are advisory: their reviews are comments the lead read.
      requestedReviewers: decision.approvers.filter((name) => crew.find((bot) => bot.name === name)?.githubLogin),
      pendingOnGitHub: [...pull.requestedReviewers.map((login) => `@${login}`), ...pull.requestedTeams.map((team) => `team ${team}`)],
      humansRequired: humans.required,
      humanRulesUnknown: humans.rules === null,
      reviews: counted,
      askingPermission: asking,
      crew,
      signaturesEnforced,
      checkedReviews: checked,
      ciMergedBy,
      securitySeat,
      checkRuns,
      statuses,
      gate,
      sameDiffAs,
      carriedFrom,
      leadRechecks: resolution.rechecks ? decision.lead : null,
      scope,
    };
  }

  /**
   * A crew pull request's scope: the issues it closes, its lease's paths, and
   * whether `scope:cross-cutting` counts. The paths come from OpenADLC's own
   * lease row, never the issue's body: a builder could edit that, and its
   * skill let it. The label counts by who last put it on, from the timeline.
   */
  private async scopeFacts(
    client: GitHubClient,
    repoFullName: string,
    pull: { number: number; labels: string[]; headRef?: string },
    history: Awaited<ReturnType<GitHubClient['listPullHistory']>>,
    crew: Awaited<ReturnType<typeof bots.listBots>>,
  ): Promise<ScopeFacts> {
    const closes =
      (await client.closingIssues(repoFullName, pull.number).catch(() => null)) ??
      closingKeywords((await client.getIssue(repoFullName, pull.number))?.body ?? '');
    const issue = issueNumberFromBranch(pull.headRef ?? '');
    const repo = (await repos.listRepos({ includeRemoved: true })).find((one) => one.fullName.toLowerCase() === repoFullName.toLowerCase());
    const lease = repo && issue ? await leases.latestLease(repo.id, issue) : null;
    const automationLogin = (await automationBot(this.config))?.githubLogin ?? null;
    const labelled = (history ?? []).filter((entry) => entry.event === 'labeled' && entry.label === CROSS_CUTTING_LABEL).at(-1);
    const crossCutting =
      pull.labels.includes(CROSS_CUTTING_LABEL) &&
      Boolean(labelled) &&
      scopeLabelAcceptedFrom({ login: labelled?.actor ?? null, viaApp: labelled?.viaApp }, { crew, automationLogin });
    return { crewBranch: true, issue, closes, declared: lease?.declaredPaths ?? null, crossCutting };
  }

  /**
   * `review-gate` on a head as OpenADLC published it, the most restrictive of
   * what it set: the app's check run, and the status set by the app or by the
   * automation account. A commit status by that name can be set by any token
   * that may write statuses, the builder's included, so one by anybody else is
   * never read.
   *
   * Both, because either can be stale. An app without "Checks: write" sets
   * only the status, and reading only the automation account's refused every
   * merge there with the gate green on GitHub. And a check run that failed to
   * update left an older success standing over a newer pending status.
   *
   * The bridge's watch on merges reads it too (`noticeUnreviewedMerge`): a
   * crew token that set its own green status just before merging went
   * unnoticed.
   */
  async publishedGate(repoFullName: string, sha: string): Promise<'pending' | 'success' | 'failure' | null> {
    const readings: ('pending' | 'success' | 'failure')[] = [];
    const standing = await this.appGate?.standing(repoFullName, sha).catch(() => null);
    if (standing) readings.push(standing.state);
    const client = await this.automationClient();
    if (client) {
      const [statuses, account, appLogin] = await Promise.all([
        (async () =>
          client.request<{ statuses: { context: string; state: string; creator?: { login?: string } | null }[] }>(
            'GET',
            `/repos/${repoFullName}/commits/${sha}/status`,
          ))().catch(() => null),
        (async () => client.viewer())().catch(() => null),
        (async () => (this.appGate ? this.appGate.botLogin() : null))().catch(() => null),
      ]);
      const ours = (login: string | undefined) => sameLogin(login, account?.login) || sameLogin(login, appLogin);
      for (const status of statuses?.statuses ?? []) {
        if (status.context !== REVIEW_GATE_CHECK || !ours(status.creator?.login)) continue;
        readings.push(status.state === 'success' ? 'success' : status.state === 'pending' ? 'pending' : 'failure');
      }
    }
    if (readings.length === 0) return null;
    return readings.includes('failure') ? 'failure' : readings.includes('pending') ? 'pending' : 'success';
  }

  /**
   * Merges as the app, never with a bot's token, which OpenADLC's `gh` refuses to
   * merge with, and only the head that was checked. Null when the app
   * cannot be asked.
   */
  async mergeAsApp(repoFullName: string, prNumber: number, headSha: string): Promise<{ sha: string } | null> {
    const app = await this.appGate?.client(repoFullName).catch(() => null);
    if (!app) return null;
    return app.mergePullRequest(repoFullName, prNumber, headSha);
  }

  /** Rewrites the status issue in place, as the automation account. */
  async updateStatusIssue(repoFullName: string, issueNumber: number, body: string): Promise<boolean> {
    const client = await this.automationClient();
    if (!client) return false;
    return client
      .updateIssueBody(repoFullName, issueNumber, body)
      .then(() => true)
      .catch(() => false);
  }

  async dismissStaleApprovals(input: {
    repoFullName: string;
    prNumber: number;
    reason: string;
  }): Promise<string[]> {
    const client = await this.automationClient();
    if (!client) return [];

    const reviews = await client.listReviews(input.repoFullName, input.prNumber).catch(() => []);
    // Only the approval that is currently standing. A `CHANGES_REQUESTED` or a
    // comment is not something a push invalidates, and GitHub refuses to
    // dismiss anything that is not approved.
    const dismissed: string[] = [];
    for (const review of standingApprovals(reviews)) {
      // Before the call: GitHub's delivery of the dismissal can arrive before
      // it answers. Recorded, so a restart in between does not forget it; and
      // kept here too, for when the record could not be written.
      this.ownDismissals.set(review.id, Date.now());
      await recordEvent({
        source: 'platform',
        type: REVIEW_DISMISSED_BY_BRIDGE,
        payload: { repo: input.repoFullName, pr: String(input.prNumber), reviewId: String(review.id) },
      }).catch((error: Error) => console.warn(`[bridge] could not record dismissing ${review.user}'s approval: ${error.message.slice(0, 120)}`));
      await client
        .dismissReview(input.repoFullName, input.prNumber, review.id, input.reason)
        .then(() => dismissed.push(review.user))
        .catch((error: Error) => {
          this.ownDismissals.delete(review.id);
          console.warn(`[bridge] could not dismiss ${review.user}'s approval: ${error.message.slice(0, 120)}`);
        });
    }
    return dismissed;
  }

  /**
   * Whether the bridge itself dismissed this review, a stale approval. It
   * dismisses as the automation account, which is a crew login, so GitHub's
   * delivery of the dismissal named a crew account and every push to an
   * approved pull request was reported as a bot dismissing a review. Known by
   * the review's id, whichever account GitHub names as the sender.
   */
  async dismissedByBridge(repoFullName: string, reviewId: number): Promise<boolean> {
    const now = Date.now();
    for (const [id, at] of this.ownDismissals) if (now - at > OWN_DISMISSAL_MS) this.ownDismissals.delete(id);
    if (this.ownDismissals.has(reviewId)) return true;
    return hasEventOfType(REVIEW_DISMISSED_BY_BRIDGE, new Date(now - OWN_DISMISSAL_MS), {
      repo: repoFullName,
      reviewId: String(reviewId),
    }).catch(() => false);
  }

  /** The approvals `dismissStaleApprovals` dismissed, by review id, with when. */
  private readonly ownDismissals = new Map<number, number>();

  /**
   * Publishes `review-gate` on a head, once the pull request's commits have
   * been checked for an author that must never author.
   *
   * The check is here because every path that sets the gate comes through
   * here, so none of them can set it without the check. What comes back is the
   * gate as it was set, and that is what a caller acts on: a pull request whose
   * reviews are all in is still not eligible when a reviewer wrote one of its
   * commits. Null when there is no automation account to set it as.
   */
  async setReviewGate(input: {
    repoFullName: string;
    prNumber: number;
    sha: string;
    state: ReviewGate['state'];
    description: string;
  }): Promise<ReviewGate | null> {
    const client = await this.automationClient();
    if (!client) return null;

    // Held for a person (`needs-human`), or paused (`fleetadlc:paused`): the
    // gate stays pending, whatever the reviews say, so nothing lands it until
    // the label comes off. A paused one used to go green, and GitHub's
    // auto-merge or a person reading the gate could land it.
    // A label that cannot be read holds too: going green on a pull request a
    // person may have held would let it land, and the next event asks again.
    const held = input.state === 'success' ? await this.heldForPerson(client, input.repoFullName, input.prNumber) : 'clear';
    const gate = await this.checkAuthors(
      client,
      input.repoFullName,
      input.prNumber,
      input.sha,
      held === 'held'
        ? { state: 'pending', description: HELD_GATE }
        : held === 'paused'
          ? { state: 'pending', description: PAUSED_GATE }
          : held === 'unknown'
            ? { state: 'pending', description: HELD_UNREAD_GATE }
            : { state: input.state, description: input.description },
    );
    // The app's check run is what a pinned ruleset requires, and nothing but
    // the app can set it. The status is set beside it, the same, so what reads
    // the gate by its status — and a repository not yet pinned — agrees.
    const published = (await this.appGate?.publish(input.repoFullName, input.sha, gate.state, gate.description)) ?? false;
    if (!published && (await (async () => this.appGate?.appId())().catch(() => null))) {
      // The check run on this head is now behind the status; the merge line
      // reads the more restrictive of the two, so an older success does not win.
      console.warn(`[bridge] review-gate check run not updated on ${input.repoFullName}@${input.sha.slice(0, 7)}; the status below still is`);
    }
    const byApp = (await this.appGate?.publishStatus(input.repoFullName, input.sha, gate.state, gate.description)) ?? false;
    if (!byApp) {
      await client.setCommitStatus(input.repoFullName, input.sha, {
        state: gate.state,
        context: REVIEW_GATE_CHECK,
        description: gate.description,
      });
    }
    return gate;
  }

  /** Whether a pull request is labelled `needs-human` or `fleetadlc:paused`, or `unknown` when its labels cannot be read. */
  private async heldForPerson(
    client: GitHubClient,
    repoFullName: string,
    prNumber: number,
  ): Promise<'held' | 'paused' | 'clear' | 'unknown'> {
    try {
      const { labels } = await client.getPullRequest(repoFullName, prNumber);
      return labels.includes('needs-human') ? 'held' : labels.includes(PAUSED_LABEL) ? 'paused' : 'clear';
    } catch {
      return 'unknown';
    }
  }

  /**
   * "Hold this PR": labels it `needs-human`, turns GitHub's auto-merge
   * off (as the app, which may; the automation account where it cannot), and
   * sets `review-gate` pending on its head, which it stays while the label is
   * on. The merge line refuses it too (`mergeDecision`). Null when there is
   * no automation account to label it as.
   */
  async holdPull(repoFullName: string, prNumber: number): Promise<{ autoMergeOff: boolean; gate: ReviewGate | null } | null> {
    const client = await this.automationClient();
    if (!client) return null;
    await client.addLabels(repoFullName, prNumber, ['needs-human']);
    return this.holdGate(client, repoFullName, prNumber, HELD_GATE);
  }

  /**
   * A paused item's pull request, held now as "Hold this PR" holds one:
   * auto-merge off and `review-gate` pending. `setReviewGate` keeps it
   * pending while the label is on, but only from its next write, so a gate
   * already green when the pause landed stayed green until then. The label
   * is the caller's. Null when there is no automation account.
   */
  async pausePull(repoFullName: string, prNumber: number): Promise<{ autoMergeOff: boolean; gate: ReviewGate | null } | null> {
    const client = await this.automationClient();
    if (!client) return null;
    return this.holdGate(client, repoFullName, prNumber, PAUSED_GATE);
  }

  private async holdGate(
    client: GitHubClient,
    repoFullName: string,
    prNumber: number,
    description: string,
  ): Promise<{ autoMergeOff: boolean; gate: ReviewGate | null }> {
    const pull = await client.getPullRequest(repoFullName, prNumber);
    let autoMergeOff = !pull.autoMerge;
    if (pull.autoMerge) {
      const asApp = (await this.appGate?.client(repoFullName).catch(() => null)) ?? client;
      autoMergeOff = await disableAutoMerge(asApp, repoFullName, prNumber).catch((error: Error) => {
        console.warn(`[bridge] ${repoFullName}#${prNumber}: could not turn auto-merge off: ${error.message.slice(0, 200)}`);
        return false;
      });
    }
    const gate = await this.setReviewGate({ repoFullName, prNumber, sha: pull.headSha, state: 'pending', description });
    return { autoMergeOff, gate };
  }

  /**
   * Parks the open pull request of work sent back before build: a draft again,
   * as the app where it can, and without `adlc:ci`, so neither the reviewers
   * nor GitHub's CI spend anything on it while an earlier stage decides. The
   * merge line is the caller's. False when it is not open or nothing could
   * act on it; a refusal is thrown, for the caller to say.
   */
  async parkPull(repoFullName: string, prNumber: number): Promise<boolean> {
    const client = await this.automationClient();
    if (!client) return false;
    const pull = await client.getPullRequest(repoFullName, prNumber).catch(() => null);
    if (!pull || pull.state !== 'open') return false;
    const asApp = (await this.appGate?.client(repoFullName).catch(() => null)) ?? client;
    if (!pull.draft) await asApp.convertToDraft(repoFullName, prNumber);
    if (pull.labels.includes(CI_LABEL)) await asApp.removeLabel(repoFullName, prNumber, CI_LABEL).catch(() => undefined);
    return true;
  }

  /**
   * Puts `adlc:ci` on a pull request, or takes it off, as the app where it
   * can. The label is what lets GitHub's CI run on a crew pull request, so it
   * has to come from a token whose events start workflows: the app's
   * installation token does, and so does the automation account's, which is
   * the fallback. A workflow's own token would not.
   */
  async setCiLabel(repoFullName: string, prNumber: number, present: boolean): Promise<'app' | 'automation' | null> {
    return this.setPullLabel(repoFullName, prNumber, CI_LABEL, present);
  }

  /** Puts a label on a pull request, or takes it off, as the app, or as the automation account when there is no app. */
  async setPullLabel(repoFullName: string, prNumber: number, label: string, present: boolean): Promise<'app' | 'automation' | null> {
    const app = await this.appGate?.client(repoFullName).catch(() => null);
    const client = app ?? (await this.automationClient());
    if (!client) return null;
    if (present) await client.addLabels(repoFullName, prNumber, [label]);
    else await client.removeLabel(repoFullName, prNumber, label);
    return app ? 'app' : 'automation';
  }

  /** Reopens an issue as the automation account; false when there is none to act as. */
  async reopenIssue(repoFullName: string, issueNumber: number): Promise<boolean> {
    const client = await this.automationClient();
    if (!client) return false;
    await client.reopenIssue(repoFullName, issueNumber);
    return true;
  }

  /** Adds labels as the automation account. */
  async addLabels(repoFullName: string, number: number, labels: string[]): Promise<void> {
    const client = await this.automationClient();
    if (!client) return;
    await client.addLabels(repoFullName, number, labels);
  }

  /**
   * The gate once it is known who wrote the pull request's commits.
   *
   * Reviewers hold write access because GitHub only counts approvals from
   * accounts that have it, and the automation account holds it on a personal
   * repository, whose access page has no triage. That they never land code cannot rest on their own good
   * behaviour, so a commit any of them authored fails the gate, whatever the
   * reviews say. The accounts are the install's own crew: the configuration
   * names none.
   *
   * Commits that cannot be listed hold the gate. Not knowing who wrote a change
   * is not knowing that nobody forbidden did.
   *
   * A commit's author is whatever its committer typed, so a reviewer session,
   * which holds a token and may run git, can push a commit to a builder's
   * branch with the builder named as author. Who pushed is the one fact the
   * pusher cannot choose: the synchronize handler records a forbidden
   * account's push that changed the diff (`FORBIDDEN_PUSH`), and that head
   * fails here every time its gate is set.
   */
  private async checkAuthors(
    client: GitHubClient,
    repoFullName: string,
    prNumber: number,
    sha: string,
    gate: ReviewGate,
  ): Promise<ReviewGate> {
    const forbidden = accountsThatNeverAuthor(await bots.listBots());
    // Nobody in the crew is barred from authoring, so there is nobody to look for.
    if (forbidden.length === 0) return gate;

    let pushed: { login?: unknown; why?: unknown } | null;
    try {
      // `payload @>` compares the repository's name as text, so `Acme/widgets`
      // on the row and `acme/widgets` on the event were not the same push. The
      // push is recorded in lower case now, but one recorded before that has
      // the name as GitHub sent it, and asking under the row's spelling and
      // its lower case still missed it when the row was the lower-case one.
      // The head and the number find the push; the name is compared here.
      const repo = repoFullName.toLowerCase();
      const event = (await listEventsOfTypeWith(FORBIDDEN_PUSH, { pr: String(prNumber), sha })).find(
        (one) => String((one.payload as { repo?: unknown } | null)?.repo ?? '').toLowerCase() === repo,
      );
      pushed = event ? ((event.payload ?? {}) as { login?: unknown; why?: unknown }) : null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[bridge] ${repoFullName}#${prNumber}: review-gate held; could not read who pushed ${sha.slice(0, 7)}: ${message.slice(0, 200)}`);
      return { state: 'pending', description: fitStatus(`who pushed this head could not be checked; ${gate.description}`) };
    }
    if (pushed) {
      return { state: 'failure', description: forbiddenPushGate({ login: String(pushed.login ?? 'an account'), why: String(pushed.why ?? 'it may never author'), sha }) };
    }

    let commits: PullCommit[];
    try {
      commits = await client.listPullCommits(repoFullName, prNumber);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[bridge] ${repoFullName}#${prNumber}: review-gate held; could not list the commits to check who wrote them: ${message.slice(0, 200)}`,
      );
      return { state: 'pending', description: fitStatus(`commit authors could not be checked; ${gate.description}`) };
    }

    const findings = findForbiddenAuthors(commits, forbidden);
    const first = findings[0];
    if (!first) return gate;

    for (const finding of findings) {
      console.warn(
        `[bridge] ${repoFullName}#${prNumber}: ${finding.sha} was authored by ${finding.login} — ${finding.reason}`,
      );
    }
    const named = `${first.sha.slice(0, 7)} was authored by ${first.login} — ${first.reason}`;
    const more = findings.length > 1 ? ` (+${findings.length - 1} more)` : '';
    return {
      state: 'failure',
      description: fitStatus(named.length + more.length <= STATUS_DESCRIPTION_MAX ? `${named}${more}` : named),
    };
  }

  /**
   * Asks GitHub for each seat's review, and returns the ones it refused to ask
   * because the account does not exist or cannot review in the repository.
   *
   * A refusal used to throw out of the pull request's handler before the gate
   * was set, and the gate then said "waiting on" a reviewer GitHub had already
   * said it would never ask. It is now kept (`cannotReviewHere` reads it), said
   * in the bridge's log and the audit in GitHub's own words, and the others are
   * still asked. Any other failure throws as before.
   */
  async requestReviewers(repoFullName: string, prNumber: number, reviewers: string[]): Promise<RefusedReviewer[]> {
    const client = await this.automationClient();
    if (!client) return [];

    // Reviewers sharing an account are one request, and GitHub refuses to
    // request a review from the pull request's own author.
    const author = await client.getPullRequest(repoFullName, prNumber).then((pull) => pull.author).catch(() => null);
    const logins: string[] = [];
    const seatOfLogin = new Map<string, string>();
    for (const name of reviewers) {
      const bot = await bots.getBotByName(name);
      const login = bot?.githubLogin;
      if (!login || sameLogin(login, author) || logins.some((seen) => sameLogin(seen, login))) continue;
      logins.push(login);
      seatOfLogin.set(login, name);
    }
    if (logins.length === 0) return [];
    try {
      await client.requestReviewers(repoFullName, prNumber, logins);
      return [];
    } catch (error) {
      if (!reviewRequestRefusal(error)) throw error;
    }

    // GitHub refuses the whole request for one login, and names it only when
    // it does not exist, so each is asked alone: the others are still asked,
    // and the one refused is known by name.
    const refused: RefusedReviewer[] = [];
    for (const login of logins) {
      try {
        await client.requestReviewers(repoFullName, prNumber, [login]);
      } catch (error) {
        const refusal = reviewRequestRefusal(error);
        if (!refusal) {
          console.warn(`[bridge] ${repoFullName}#${prNumber}: could not ask ${login} for a review: ${error instanceof Error ? error.message.slice(0, 200) : error}`);
          continue;
        }
        const seat = seatOfLogin.get(login) ?? login;
        this.standings.record(repoFullName, login, refusal.standing);
        refused.push({ seat, login, reason: refusal.standing.reason, words: refusal.words });
        console.warn(`[bridge] ${repoFullName}#${prNumber}: GitHub refused to ask ${login} (${seat}) for a review: ${refusal.words}`);
        await audit({
          actor: 'fleetadlc',
          action: 'review.request_refused',
          target: `${repoFullName}#${prNumber}`,
          payload: { seat, login, standing: refusal.standing.state, github: refusal.words },
        }).catch(() => undefined);
      }
    }
    return refused;
  }

  /**
   * Marks an issue as needing intake, and says why on the issue itself.
   *
   * The comment is the point: `needs-triage` on its own tells somebody to look
   * without telling them what at, and the thing that decided already knows.
   */
  async sendToTriage(repoFullName: string, issueNumber: number, reason: string): Promise<void> {
    const client = await this.automationClient();
    if (!client) return;

    await client.addLabels(repoFullName, issueNumber, ['needs-triage']);
    await client.removeLabel(repoFullName, issueNumber, 'start:now');
    await client
      .comment(repoFullName, issueNumber, `**Not routable yet.** ${reason}`)
      .catch(() => undefined);
  }

  /**
   * Turns `blocked` into `start:now`, or back.
   *
   * The two are a pair: an issue that is no longer waiting is not merely
   * unlabelled, it is ready, and leaving it neither blocked nor routable would
   * strand it between states where nothing looks at it.
   */
  async setBlocked(repoFullName: string, issueNumber: number, blocked: boolean): Promise<void> {
    const client = await this.automationClient();
    if (!client) return;

    if (blocked) {
      await client.addLabels(repoFullName, issueNumber, ['blocked']);
      await client.removeLabel(repoFullName, issueNumber, 'start:now');
      return;
    }
    await client.removeLabel(repoFullName, issueNumber, 'blocked');
    await client.addLabels(repoFullName, issueNumber, ['start:now']);
  }

  /**
   * Labels the pull request with who it is waiting for, one label per person,
   * and clears any that no longer apply. The old single `review:human` is
   * removed wherever it is found, because it named nobody.
   *
   * A label is made first, as the app. Adding one a repository does not have
   * makes GitHub create it as whoever adds it, and an automation account with
   * triage is refused that ("You do not have permission to create labels").
   * A person's label cannot be listed in `config/labels.json` beforehand, so
   * repository setup never makes it.
   */
  async setHumanReviewLabels(repoFullName: string, prNumber: number, logins: string[]): Promise<void> {
    const client = await this.automationClient();
    if (!client) return;

    const wanted = logins.map(humanReviewLabelFor);
    const pr = await client.getPullRequest(repoFullName, prNumber).catch(() => null);
    const present = (pr?.labels ?? []).filter((name) => name.startsWith(HUMAN_REVIEW_LABEL_PREFIX));

    for (const label of present) {
      if (!wanted.includes(label)) await client.removeLabel(repoFullName, prNumber, label);
    }
    const missing = logins.filter((login) => !present.includes(humanReviewLabelFor(login)));
    if (missing.length === 0) return;
    const app = await theApp(repoFullName);
    if (app) {
      for (const login of missing) {
        try {
          await app.request('POST', `/repos/${repoFullName}/labels`, {
            name: humanReviewLabelFor(login),
            color: HUMAN_REVIEW_LABEL_COLOR,
            description: `Waiting on ${login}'s review: AGENTS.md names them for a path this changes`.slice(0, 100),
          });
        } catch (cause) {
          // There already, from an earlier pull request or a person: that is the point.
          if (!/already_exists/.test(cause instanceof Error ? cause.message : String(cause))) throw cause;
        }
      }
    }
    await client.addLabels(repoFullName, prNumber, missing.map(humanReviewLabelFor));
  }

  /**
   * Withdraws the review request from any configured human this change does not
   * need.
   *
   * CODEOWNERS makes GitHub request the owner on every pull request touching an
   * owned path, and the owner is `*` for the lead reviewer — so a person ended
   * up a requested reviewer on all of them. The ones a change actually needs
   * are the ones its `AGENTS.md` rules name; the rest are withdrawn, so a
   * person's review queue is the set of pull requests that genuinely wait on
   * them.
   */
  async dropUnneededHumanRequests(repoFullName: string, prNumber: number, needed: string[]): Promise<void> {
    const client = await this.automationClient();
    if (!client) return;

    // By `sameLogin`: `JaneDoe` in FLEETADLC_HUMANS and `@janedoe` in AGENTS.md
    // are one person, who was withdrawn though needed.
    const unneeded = this.config.humans.filter((login) => !needed.some((one) => sameLogin(one, login)));
    if (unneeded.length === 0) return;
    await client.removeReviewRequest(repoFullName, prNumber, unneeded);
  }

  /**
   * The rules the repository itself declares, read from `AGENTS.md` on the base
   * branch. `null` means they could not be read, which holds the gate.
   */
  async humanReviewRules(repoFullName: string, baseRef: string): Promise<HumanReviewRule[] | null> {
    const client = await this.automationClient();
    if (!client) return null;
    // From the base, never from the pull request's own copy.
    const agents = await client.readFileAtRef(repoFullName, 'AGENTS.md', baseRef);
    return parseHumanReviewPaths(agents);
  }

  /**
   * The base's rules, and every person this change needs: those the paths it
   * touches name, and, when it changes the `## Human review` section itself,
   * everyone the base's section names. One answer for the gate at open, the
   * gate as the reviews stand and the merge, so they cannot drift apart.
   *
   * `AGENTS.md` is not among the paths the section lists, and builders edit
   * it on ordinary work, so a pull request could take a rule out and merge on
   * the lead alone; every later one under that path then needed nobody. The
   * head's copy is read only when `AGENTS.md` is among the changed files, so
   * an ordinary pull request asks GitHub for nothing more. A head copy that
   * cannot be read counts as changed.
   */
  async humansRequiredFor(
    repoFullName: string,
    baseRef: string,
    headSha: string,
    changedFiles: readonly string[],
  ): Promise<{ rules: HumanReviewRule[] | null; required: string[] }> {
    const client = await this.automationClient();
    if (!client) return { rules: null, required: [] };
    const baseAgents = await client.readFileAtRef(repoFullName, 'AGENTS.md', baseRef);
    const rules = parseHumanReviewPaths(baseAgents);
    if (!rules) return { rules: null, required: [] };
    const required = humanReviewersFor([...changedFiles], rules);
    if (changedFiles.includes('AGENTS.md')) {
      const headAgents = await client.readFileAtRef(repoFullName, 'AGENTS.md', headSha);
      if (humanReviewSectionChanged(baseAgents, headAgents)) {
        for (const login of everyHumanReviewer(rules)) if (!required.includes(login)) required.push(login);
      }
    }
    return { rules, required };
  }

  /**
   * Moves an issue to a stage, and records the move (`stage_moves`).
   *
   * `forward`, the default, is a stage handing on: only to the next stage.
   * `send_back` goes to an earlier one, and only `SendBack` asks for it, once
   * it has checked the stage is the one `previousStage` names and the limits
   * allow it. `person` goes anywhere: a person moving a card. A bot that
   * reached for a backward move any other way is refused here.
   *
   * An issue labelled `fleetadlc:ignore` is never moved, by anyone: the board
   * is for the work the crew does, and a person said the crew leaves this one
   * alone. Not the move that begins crew work, not a merge reaching Merged or
   * Done. Taking the label off brings it back where its stage label says.
   */
  async moveStage(input: {
    repoName: string;
    issueNumber: number;
    to: StageKey;
    actor: string;
    direction?: 'forward' | 'send_back' | 'person';
    /**
     * The move records a merge. It goes to Merged or Done from any earlier
     * stage, not only from Review: a person who merged while the card was in
     * Build had the move refused, the reconciler then forgot the closed issue,
     * and whatever depended on it waited for good. Never back, so Done stays
     * Done. A production promote does not set this: that move keeps the
     * forward rules, so a card sent back to Build after a revert stays there.
     * Stored as a forward move. Bots' own moves keep the forward rules.
     */
    recordsOutcome?: boolean;
    /** Kept with the move: why it went back, the task that asked, the comment that says so. */
    reason?: string | null;
    taskId?: string | null;
    prNumber?: number | null;
    commentUrl?: string | null;
  }): Promise<{ moved: boolean; reason?: string; ignored?: boolean }> {
    const repo = await repos.getRepoByName(input.repoName);
    if (!repo) return { moved: false, reason: 'unknown repository' };
    const direction = input.direction ?? 'forward';

    const existing = (await issues.listIssues(repo.name)).find((entry) => entry.number === input.issueNumber);
    if (existing && existing.stage !== input.to) {
      const allowed =
        direction === 'person' ||
        (direction === 'send_back'
          ? isBackwardMove(existing.stage, input.to)
          : isForwardMove(existing.stage, input.to) ||
            (Boolean(input.recordsOutcome) && (input.to === 'merged' || input.to === 'done') && !isBackwardMove(existing.stage, input.to)));
      if (!allowed) {
        return {
          moved: false,
          reason:
            direction === 'send_back'
              ? `${input.actor} tried to send ${input.repoName}#${input.issueNumber} from ${existing.stage} on to ${input.to}; a send-back goes to an earlier stage`
              : `${input.actor} tried to move ${input.repoName}#${input.issueNumber} from ${existing.stage} ${isBackwardMove(existing.stage, input.to) ? 'back' : 'on'} to ${input.to}`,
        };
      }
    }

    // One write of the whole set, built from the labels GitHub has now. Built
    // from the stored row, it erased a label the row had not seen yet: an
    // intake task finishing just after a person added `fleetadlc:ignore`, before
    // that delivery was processed, took the label off again. Removing
    // the old stage and adding the new one as two calls is no better: GitHub
    // sends an `unlabeled` delivery in between with no stage label at all,
    // which the webhook reads as intake, and the row is put back there. When
    // GitHub's labels cannot be read the move fails, before the stored stage
    // changes: falling back on the stored row brought that loss back. The
    // read is tried three times first, since a failed move also stops what the
    // caller does after it — the lease let go and the testing deploy after a
    // merge, the reviewers asked for a new pull request, intake staffed — and
    // one GitHub blip should not cost all of that.
    const client = await this.automationClient();
    let live: string[] | null = null;
    let closed = false;
    if (client) {
      for (let attempt = 0; live === null; attempt += 1) {
        try {
          const read = await client.getIssue(repo.fullName, input.issueNumber);
          live = read.labels;
          closed = read.state === 'closed';
        } catch (error) {
          const wait = LABEL_READ_BACKOFF_MS[attempt];
          if (wait === undefined) {
            throw new Error(
              `${input.repoName}#${input.issueNumber} was not moved to ${input.to}: its labels could not be read from GitHub ` +
                `(${error instanceof Error ? error.message : error}). Move it again once GitHub answers.`,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
      }
    }

    // A closed issue's work is over. Intake resumed on a closed issue moved
    // it to Build, where the board showed it as work to do. A move that
    // records how it ended still goes: GitHub closes an issue as the pull
    // request that closes it merges, and that merge is what reaches Merged or
    // Done.
    if (closed && input.to !== 'merged' && input.to !== 'done') {
      return {
        moved: false,
        reason: `${input.actor} tried to move ${input.repoName}#${input.issueNumber} to ${input.to}, but it is closed; reopen it on GitHub first`,
      };
    }

    // The stored labels can be behind GitHub's. An issue opened first and
    // labelled in a second call is delivered as `opened` with no labels, and
    // the `labeled` delivery can still be in flight when this runs. Reading
    // only the stored row, intake was staffed on it. The labels read above
    // are GitHub's own, so they are what is checked. They are also stored,
    // so the sweep and `StageHandoff.staff` leave the issue alone too.
    if (hasIgnoreLabel(live ?? existing?.labels)) {
      if (live) await issues.setIssueLabels(repo.id, input.issueNumber, live);
      return {
        moved: false,
        ignored: true,
        reason: `${input.repoName}#${input.issueNumber} is labelled fleetadlc:ignore, which the crew leaves alone`,
      };
    }

    // As it was before this move: what a failed label write puts back, and the move's `from`.
    const from = existing?.stage ?? null;
    await issues.setIssueStage(repo.id, input.issueNumber, input.to);

    // Read once more just before the write. The write replaces the whole set,
    // so a label added since the read above (the `fleetadlc:ignore` of an issue
    // created and then labelled in a second call, landing while the stage and
    // lease were written) was dropped by it. This narrows that window to one
    // round trip; it does not close it, since GitHub has no conditional label
    // write. A failed read here falls back on the first one, which is known.
    //
    // The stored stage is written first, so the bridge's own `labeled`
    // delivery finds the board already agreeing. A write that still fails
    // after the read's retries puts the stored stage back: left moved, the
    // board was ahead of GitHub's label, and the reconciler and the webhook
    // read the older label as a person moving the card back — a public
    // comment, a person's move nobody made, later work stopped, a lease let go.
    if (client && live) {
      const latest = await client
        .getIssue(repo.fullName, input.issueNumber)
        .then((issue) => issue.labels)
        .catch(() => live);
      const labels = [...latest.filter((label) => !isStageLabel(label)), STAGE_LABELS[input.to]];
      for (let attempt = 0; ; attempt += 1) {
        try {
          await client.setLabels(repo.fullName, input.issueNumber, labels);
          break;
        } catch (error) {
          const wait = LABEL_READ_BACKOFF_MS[attempt];
          if (wait !== undefined) {
            await new Promise((resolve) => setTimeout(resolve, wait));
            continue;
          }
          const why = error instanceof Error ? error.message : String(error);
          if (from) {
            await issues.setIssueStage(repo.id, input.issueNumber, from).catch((failure: unknown) =>
              console.error(
                `[bridge] ${input.repoName}#${input.issueNumber}: the stage was not put back to ${from} either: ${failure instanceof Error ? failure.message : failure}`,
              ),
            );
          }
          console.warn(`[bridge] ${input.repoName}#${input.issueNumber} was not moved to ${input.to}: its stage label could not be written (${why})`);
          throw new Error(
            `${input.repoName}#${input.issueNumber} was not moved to ${input.to}: its stage label could not be written on GitHub (${why}). ` +
              'Move it again once GitHub answers.',
          );
        }
      }
    }

    // Where a send-back goes is read from these, and its limits count them,
    // so every move that changed the stage is one. Never a reason for the move
    // to fail: the label is the record, and a lost row costs only the history
    // a later send-back is worked out from. Written once the label is, so a
    // move put back above leaves no row.
    if (from !== input.to) {
      try {
        await stageMoves.record({
          repoId: repo.id,
          issueNumber: input.issueNumber,
          prNumber: input.prNumber ?? null,
          from,
          to: input.to,
          kind: direction,
          actor: input.actor,
          taskId: input.taskId ?? null,
          reason: input.reason ?? null,
          commentUrl: input.commentUrl ?? null,
        });
      } catch (error) {
        console.warn(`[bridge] the move of ${input.repoName}#${input.issueNumber} to ${input.to} was not recorded: ${error instanceof Error ? error.message : error}`);
      }
    }

    // Done is the end of the work, however it got there — a merge that ships,
    // a production deploy, a person — and a lease still holding the issue's
    // files would keep the next change to them waiting for nothing.
    if (input.to === 'done') {
      const lease = await leases.getActiveLease(repo.id, input.issueNumber).catch(() => null);
      if (lease) await leases.setLeaseState(lease.id, 'released').catch(() => undefined);
    }

    return { moved: true };
  }

  async assignIssue(repoFullName: string, issueNumber: number, botName: string): Promise<void> {
    const client = await this.automationClient();
    const bot = await bots.getBotByName(botName);
    if (!client || !bot?.githubLogin) return;
    await client.assign(repoFullName, issueNumber, [bot.githubLogin]);
  }

  async comment(repoFullName: string, issueNumber: number, body: string): Promise<string | null> {
    const client = await this.automationClient();
    if (!client) return null;
    const comment = await client.comment(repoFullName, issueNumber, body);
    return comment.htmlUrl;
  }
}

/** The waits between reads of an issue's labels, and between writes of them, before a stage move gives up: three tries in all. */
export const LABEL_READ_BACKOFF_MS = [1_000, 3_000] as const;

/**
 * A push by an account that may never author, which changed a pull request's
 * diff: `{ repo, pr, sha, login, why }`, every field a string. Recorded by the
 * synchronize handler; `checkAuthors` fails that head's gate for as long as it
 * is the head.
 */
export const FORBIDDEN_PUSH = 'pr.forbidden_push';

/** What `review-gate` says on a head a forbidden account pushed. */
export function forbiddenPushGate(push: { login: string; why: string; sha: string }): string {
  return fitStatus(`${push.login} pushed ${push.sha.slice(0, 7)}, which changed the diff — ${push.why}`);
}

/** What `review-gate` says while a pull request is held for a person. */
export const HELD_GATE = 'held for a person (needs-human); take the label off to let it go';
/** What `review-gate` says while its work is paused (`fleetadlc:paused`), a person's hold on the item. */
export const PAUSED_GATE = 'paused by a person (fleetadlc:paused); resume it to let it go';
/** Said while the labels could not be read: held rather than risk landing a pull request a person held. */
export const HELD_UNREAD_GATE = 'could not read the pull request’s labels; held until the next check can';

/**
 * Turns GitHub's auto-merge off on a pull request. REST has no call for it,
 * so this is the GraphQL mutation, by the pull request's node id; GraphQL
 * answers a refusal with 200 and an `errors` list, which is what says so.
 */
export async function disableAutoMerge(client: GitHubClient, repoFullName: string, prNumber: number): Promise<boolean> {
  const pull = await client.request<{ node_id: string }>('GET', `/repos/${repoFullName}/pulls/${prNumber}`);
  const answer = await client.request<{ errors?: { message?: string }[] }>('POST', '/graphql', {
    query: 'mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { pullRequest { number } } }',
    variables: { id: pull.node_id },
  });
  const refused = answer.errors?.map((error) => error.message ?? 'refused').join('; ');
  if (refused) throw new Error(refused);
  return true;
}
