import { closingKeywords, hasIgnoreLabel, isFleetLogin, parseDependencies, sameLogin, type StageKey, type StageMode, type TaskKind, type TaskState } from '@fleetadlc/shared';

/**
 * What the crew is doing to each piece of work, read from the rows the bridge
 * already keeps.
 *
 * The board, "needs you" and the crew page all ask the same questions of the
 * same tasks — which issue is this subject, is anybody on it, which review round
 * is it in, did the review loop give up — so the answers live here, once, as
 * plain functions over plain rows. Nothing here reads the database.
 */

/** The exit reason of a task that ended by sending its work back (`send-back.ts`). */
export function sentBackReason(to: StageKey): string {
  return `sent back to ${to}`;
}

/**
 * Whether a task ended by sending its work back. It ends `done`, and is not
 * its stage finishing: a build that sent its issue back to design opened no
 * pull request on purpose, and is neither continued nor offered Try again.
 */
export function endedBySendingBack(exitReason: string | null | undefined): boolean {
  return /^sent back to /.test(exitReason ?? '');
}

/** Recorded when a send-back is refused at its limit, for Needs you (`send-back.ts`, `attention.ts`). */
export const SEND_BACK_STALLED = 'send_back.stalled';
/** Recorded when work went back to a stage nobody staffs, so a person takes it. */
export const SEND_BACK_TO_PERSON = 'send_back.to_person';

/** The event the bridge records when a review loop stops without the reviewers agreeing. */
export const REVIEW_STALLED = 'review.stalled';

/**
 * A round of reviews opened on a pull request's diff: `{ subjectRef, sha }`,
 * recorded before any seat is asked, so every review of the round was opened
 * at or after it. It is when the current diff began.
 */
export const REVIEW_ROUND_OPENED = 'review.round_opened';

/**
 * A review the bridge dismissed itself, a superseded approval:
 * `{ repo, pr, reviewId }` (the repository's full name; all strings),
 * recorded before GitHub is asked. It dismisses as the automation account,
 * by default the shared crew account, so its delivery names a crew login and
 * was taken for a bot breaking the rule that a bot never dismisses a review.
 */
export const REVIEW_DISMISSED_BY_BRIDGE = 'review.dismissed_by_bridge';

/**
 * A seat asked to review again because a bot dismissed its review:
 * `{ subjectRef, seat, reviewId }`, all strings. A review task the seat had
 * before it no longer counts as asked, so the gate sweep asks again when the
 * seat was busy; and one dismissal asks once, however often it is delivered.
 */
export const REVIEW_ASKED_AGAIN = 'review.asked_again';

/** A task as these functions need it. The store's rows have all of it. */
export interface TaskFacts {
  id: string;
  botId: string;
  repoId: string | null;
  kind: TaskKind;
  subjectRef: string;
  state: TaskState;
  round: number;
  costUsd: number;
  startedAt: string | null;
  endedAt: string | null;
  exitReason: string | null;
  createdAt: string;
  /** The skill it ran, where it was not its kind's own: `resolve-conflict` for a conflict round. */
  skill?: string | null;
}

/** An issue as these functions need it. */
export interface IssueFacts {
  repoId: string;
  repoName: string;
  number: number;
  title: string;
  stage: StageKey;
  url: string | null;
  prNumber: number | null;
  labels: string[];
  updatedAt: string;
  /** Where its Dependencies are written, for saying what a blocked card waits on. */
  body?: string | null;
}

export const ACTIVE_STATES: readonly TaskState[] = ['queued', 'running', 'paused'];

export function isActive(task: Pick<TaskFacts, 'state'>): boolean {
  return ACTIVE_STATES.includes(task.state);
}

/** The stage a task's kind is the work of: a fix is part of the build, QA part of shipping. */
export function stageOfTask(kind: TaskKind): StageKey {
  switch (kind) {
    case 'intake':
    case 'request':
      return 'intake';
    case 'spec':
      return 'spec';
    case 'implement':
    case 'patch':
      return 'build';
    case 'review':
      return 'review';
    case 'deploy':
    case 'qa':
      return 'merged';
  }
}

/** `repo#12` as its parts, or null for a subject that is not one (`request:…`, `repo@sha`). */
export function parseRef(subjectRef: string): { repo: string; number: number } | null {
  const match = /^([^#\s]+)#(\d+)$/.exec(subjectRef);
  if (!match) return null;
  return { repo: match[1]!, number: Number(match[2]) };
}

/**
 * The repository a subject names: `api` for `api#12`, and for a deploy of a
 * commit, `api@3f2c1a9`. A console request names none; which repository it is
 * for is on the request.
 */
export function repoOfSubject(subjectRef: string): string | null {
  return parseRef(subjectRef)?.repo ?? /^([^@#:\s]+)@\S+$/.exec(subjectRef)?.[1] ?? null;
}

/**
 * The issue a subject is about: the issue itself, or the issue whose pull
 * request it is. Review, fix and deploy tasks are filed under the pull request,
 * and a person thinks of all of them as the issue's.
 */
export function issueForSubject<T extends Pick<IssueFacts, 'repoName' | 'number' | 'prNumber'>>(
  subjectRef: string,
  issues: readonly T[],
): T | null {
  const parsed = parseRef(subjectRef);
  if (!parsed) return null;
  const inRepo = issues.filter((issue) => issue.repoName === parsed.repo);
  return (
    inRepo.find((issue) => issue.number === parsed.number) ??
    inRepo.find((issue) => issue.prNumber === parsed.number) ??
    null
  );
}

/** The subjects a card's work is filed under: the issue, and its pull request once there is one. */
export function subjectsOf(issue: Pick<IssueFacts, 'repoName' | 'number' | 'prNumber'>): string[] {
  const own = `${issue.repoName}#${issue.number}`;
  return issue.prNumber ? [own, `${issue.repoName}#${issue.prNumber}`] : [own];
}

/**
 * What the console leaves out: every issue labelled `fleetadlc:ignore`, and
 * the pull request recorded on it, as the subjects their work is filed under
 * (`repo#12`, `repo#40`). The console is for the work the crew does; an
 * ignored issue is a person's, and so is its pull request. The board, Needs
 * you, the item view and every count read this one rule. Taking the label off
 * brings the issue back, with whatever is still open on it.
 */
export function ignoredSubjects(issues: readonly Pick<IssueFacts, 'repoName' | 'number' | 'prNumber' | 'labels'>[]): Set<string> {
  return new Set(issues.filter((issue) => hasIgnoreLabel(issue.labels)).flatMap(subjectsOf));
}

/** The issues the console shows: every one but those `ignoredSubjects` leaves out. */
export function shownIssues<T extends Pick<IssueFacts, 'labels'>>(issues: readonly T[]): T[] {
  return issues.filter((issue) => !hasIgnoreLabel(issue.labels));
}

/**
 * Which review round a pull request is in: its first, and one more for every
 * fix the builder made. A conflict resolution is a patch too, but no review
 * asked for it, and the review loop's limit does not count it (`SendBack.reviewRound`).
 */
export function reviewRound(tasksOnPullRequest: readonly Pick<TaskFacts, 'kind' | 'skill'>[]): number {
  return 1 + tasksOnPullRequest.filter((task) => task.kind === 'patch' && task.skill !== 'resolve-conflict').length;
}

/** A review loop that stopped without agreeing, as the event recorded it. */
export interface Stall {
  repo: string;
  pr: number;
  issue: number | null;
  rounds: number;
  botId: string | null;
  bot: string | null;
  /**
   * The blocking seats still asking for changes on a head the lead approved;
   * empty for a loop that ran out of rounds. Nothing sends that work back, so
   * without a card the pull request sat in Review with nobody on it.
   */
  heldBy: string[];
  /** Why the loop could not go on, when it stopped for want of a lease or a builder rather than a verdict. */
  reason: string | null;
  at: string;
}

export function stallFrom(event: { at: string; payload: unknown }): Stall | null {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const repo = typeof payload.repo === 'string' ? payload.repo : null;
  const pr = typeof payload.pr === 'number' ? payload.pr : null;
  if (!repo || !pr) return null;
  return {
    repo,
    pr,
    issue: typeof payload.issue === 'number' ? payload.issue : null,
    rounds: typeof payload.rounds === 'number' ? payload.rounds : 0,
    botId: typeof payload.botId === 'string' ? payload.botId : null,
    bot: typeof payload.bot === 'string' ? payload.bot : null,
    heldBy: Array.isArray(payload.heldBy) ? payload.heldBy.filter((seat): seat is string => typeof seat === 'string') : [],
    reason: typeof payload.reason === 'string' && payload.reason.trim() ? payload.reason.trim() : null,
    at: event.at,
  };
}

/**
 * The review loops that stopped and are still stopped, by pull request.
 *
 * One per pull request, the newest: every further request for changes past the
 * cap says the same thing again. A stop stands until something moves — the
 * issue leaves Review (merged by a person, or sent back), or any task is opened
 * on the pull request after it (a push that started another review, or a fix).
 */
export function standingStalls(
  events: readonly { at: string; payload: unknown }[],
  issues: readonly Pick<IssueFacts, 'repoName' | 'number' | 'prNumber' | 'stage'>[],
  tasks: readonly Pick<TaskFacts, 'subjectRef' | 'createdAt'>[],
): Map<string, Stall> {
  const newest = new Map<string, Stall>();
  for (const event of events) {
    const stall = stallFrom(event);
    if (!stall) continue;
    const key = `${stall.repo}#${stall.pr}`;
    const seen = newest.get(key);
    if (!seen || Date.parse(stall.at) > Date.parse(seen.at)) newest.set(key, stall);
  }

  const standing = new Map<string, Stall>();
  for (const [key, stall] of newest) {
    const issue =
      (stall.issue !== null
        ? issues.find((one) => one.repoName === stall.repo && one.number === stall.issue)
        : undefined) ?? issueForSubject(key, issues);
    if (issue && issue.stage !== 'review') continue;
    const movedSince = tasks.some(
      (task) => task.subjectRef === key && Date.parse(task.createdAt) > Date.parse(stall.at),
    );
    if (movedSince) continue;
    standing.set(key, { ...stall, issue: issue?.number ?? stall.issue });
  }
  return standing;
}

/** A task as a card carries it: who, doing what, since when. */
export interface CardTask {
  bot: string;
  kind: TaskKind;
  state: TaskState;
  round: number;
  startedAt: string | null;
  endedAt: string | null;
  exitReason: string | null;
}

/** What a card says about the work on it, beyond what the issue itself says. */
export interface CardWork {
  number: number;
  prNumber: number | null;
  /** Everything spent on the issue so far: its own tasks, its pull request's, and the request it came from. */
  costUsd: number;
  /** Queued, running or paused, newest first. */
  active: CardTask[];
  /** The newest task that ended, whatever is active. */
  last: CardTask | null;
  /** The review round, once there is a pull request. */
  reviewRound: number | null;
  /** How many rounds the review loop ran before it stopped without agreeing, while it is still stopped. */
  stalledAfterRounds: number | null;
  /**
   * Whether a reviewer's last review of the pull request failed or was
   * stopped, and it has not reviewed since. The card said "Waiting for the
   * reviewers" over two reviews that had failed, which nothing was waiting for.
   */
  reviewFailed: boolean;
  /** When a finished card shipped: its last deploy, or failing that when it last changed. */
  shippedAt: string | null;
  /**
   * What a blocked card waits on, from its Dependencies: the card said
   * "Blocked by another issue" and left a person to open it to find out which.
   */
  waitingOn: number[];
}

export function asCardTask(task: TaskFacts, botName: (botId: string) => string): CardTask {
  return {
    bot: botName(task.botId),
    kind: task.kind,
    state: task.state,
    round: task.round,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    exitReason: task.exitReason,
  };
}

const newestFirst = (a: TaskFacts, b: TaskFacts): number => Date.parse(b.createdAt) - Date.parse(a.createdAt);

/**
 * Whether any reviewer's newest review of a pull request ended without
 * finishing. Each reviewer's own newest: another reviewer finishing after one
 * failed does not make the failed review happen.
 */
export function reviewFailedOn(tasksOnPullRequest: readonly TaskFacts[]): boolean {
  const newest = new Map<string, TaskFacts>();
  for (const task of [...tasksOnPullRequest].filter((one) => one.kind === 'review').sort(newestFirst)) {
    if (!newest.has(task.botId)) newest.set(task.botId, task);
  }
  return [...newest.values()].some((task) => task.state === 'failed' || task.state === 'stopped');
}

export function cardWork(
  issue: IssueFacts,
  input: {
    /** Tasks on any subject; only this card's are read. */
    tasks: readonly TaskFacts[];
    botName: (botId: string) => string;
    stalls: ReadonlyMap<string, Stall>;
    /** Extra subjects that are this card's too: the console request it was filed from. */
    requestSubjects?: readonly string[];
  },
): CardWork {
  const subjects = new Set([...subjectsOf(issue), ...(input.requestSubjects ?? [])]);
  const mine = input.tasks.filter((task) => subjects.has(task.subjectRef)).sort(newestFirst);
  const prRef = issue.prNumber ? `${issue.repoName}#${issue.prNumber}` : null;
  const onPullRequest = prRef ? mine.filter((task) => task.subjectRef === prRef) : [];
  const active = mine.filter(isActive);
  const ended = mine.filter((task) => !isActive(task));
  const stall = prRef ? input.stalls.get(prRef) : undefined;
  const lastDeploy = ended.find((task) => task.kind === 'deploy' && task.state === 'done');

  return {
    number: issue.number,
    prNumber: issue.prNumber,
    costUsd: Math.round(mine.reduce((total, task) => total + task.costUsd, 0) * 10_000) / 10_000,
    active: active.map((task) => asCardTask(task, input.botName)),
    last: ended[0] ? asCardTask(ended[0], input.botName) : null,
    reviewRound: prRef ? reviewRound(onPullRequest) : null,
    stalledAfterRounds: stall ? stall.rounds : null,
    reviewFailed: issue.stage === 'review' && reviewFailedOn(onPullRequest),
    shippedAt: issue.stage === 'done' ? (lastDeploy?.endedAt ?? issue.updatedAt) : null,
    waitingOn: issue.labels.includes('blocked') ? parseDependencies(issue.body ?? '') : [],
  };
}

/** A bot's task as the crew page reads it: what, on which issue, since when, and whether it waits on you. */
export interface TaskSummary {
  kind: TaskKind;
  state: TaskState;
  subjectRef: string;
  /**
   * The repository the work is in, by name: a bot works in any of them, and
   * "#16" alone does not say which. Null for work in none, such as a request
   * nobody named a repository for.
   */
  repo: string | null;
  /** The issue the work is about, as the board numbers it. Null for a request or a deploy of a commit. */
  issue: { repo: string; number: number; title: string } | null;
  startedAt: string | null;
  endedAt: string | null;
  /** The review round a review is in, or the fix round a fix answers. Null for other work. */
  round: number | null;
  /** How many rounds a review runs before it stops and asks a person. Null for other work. */
  maxRounds: number | null;
  /** Paused behind a question nobody has answered yet. */
  waitingOnYou: boolean;
  /** What this task alone has cost so far. A card's cost is the whole issue's. */
  costUsd: number;
}

export function taskSummary(
  task: TaskFacts,
  context: {
    issues: readonly Pick<IssueFacts, 'repoName' | 'number' | 'prNumber' | 'title'>[];
    /** Tasks with an open gate. */
    gated: ReadonlySet<string>;
    /** The fixes made on the task's subject so far, for a review's round. */
    patches?: readonly Pick<TaskFacts, 'kind' | 'skill'>[];
    /** How many rounds the review loop runs before it stops, from config/review.yaml. */
    maxRounds?: number | null;
    /** Each repository's name by its id, removed ones included: a task is history too. */
    repoNames?: ReadonlyMap<string, string>;
  },
): TaskSummary {
  const issue = issueForSubject(task.subjectRef, context.issues);
  const waitingOnYou = task.state === 'paused' && context.gated.has(task.id);
  const inLoop = task.kind === 'review' || task.kind === 'patch';
  return {
    kind: task.kind,
    state: task.state,
    subjectRef: task.subjectRef,
    repo: (task.repoId ? context.repoNames?.get(task.repoId) : undefined) ?? issue?.repoName ?? repoOfSubject(task.subjectRef),
    issue: issue ? { repo: issue.repoName, number: issue.number, title: issue.title } : null,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    round: task.kind === 'review' ? reviewRound(context.patches ?? []) : task.kind === 'patch' ? task.round : null,
    maxRounds: inLoop ? (context.maxRounds ?? null) : null,
    waitingOnYou,
    costUsd: Math.round(task.costUsd * 10_000) / 10_000,
  };
}

/**
 * The branch the SRE works on after a failed testing deploy,
 * `system/deploy-path-<first 8 of the commit>` (`Webhooks.reportDeployFailure`):
 * a broken deploy workflow is fixed from it, and the commit it names is the
 * change a send-back from that task goes to (`SendBack.request`).
 */
export const DEPLOY_PATH_BRANCH_PREFIX = 'system/deploy-path-';

/** The issue a pull request's branch was cut for: `agent/<bot>/<issue>-…`. */
export function issueNumberFromBranch(ref: string): number | null {
  const match = /^agent\/[^/]+\/(\d+)-/.exec(ref);
  return match?.[1] ? Number(match[1]) : null;
}

/**
 * Whether a pull request's head branch lives in the repository itself. A
 * builder always pushes there, so only such a branch can be an issue's: an
 * outside contributor can name a fork's branch `agent/x/12-fix`, and it was
 * taken for #12's pull request, its lease re-linked and released, its card
 * moved. GitHub gives no head repository once the fork is deleted, and that is
 * not the repository itself either.
 */
export function headInRepository(headRepoFullName: string | null | undefined, repoFullName: string): boolean {
  return Boolean(headRepoFullName) && headRepoFullName!.toLowerCase() === repoFullName.toLowerCase();
}

/** `issueNumberFromBranch`, for a pull request whose branch is in the repository itself; null for a fork's. */
export function ownIssueOf(pr: { head: { ref: string; repo?: { full_name?: string } | null } }, repoFullName: string): number | null {
  return headInRepository(pr.head.repo?.full_name, repoFullName) ? issueNumberFromBranch(pr.head.ref) : null;
}

/**
 * The issues a merged pull request finishes: `own`, the one its branch was cut
 * for, and `closes`, every other one it closes, each once. A fork's pull
 * request (`sameRepository` false) has no `own`, whatever its branch is
 * called; the issues it closes are still GitHub's to say.
 *
 * `closing` is GitHub's own list of closing references. It is null when it
 * could not be read, and then the keywords in the body stand in — but only on a
 * pull request into the default branch, since GitHub counts a keyword nowhere
 * else, and never naming the pull request itself.
 */
export function issuesMergedBy(pull: {
  number: number;
  branch: string;
  body: string;
  intoDefaultBranch: boolean;
  closing: readonly number[] | null;
  sameRepository: boolean;
}): { own: number | null; closes: number[] } {
  const own = pull.sameRepository ? issueNumberFromBranch(pull.branch) : null;
  const listed = pull.closing ?? (pull.intoDefaultBranch ? closingKeywords(pull.body) : []);
  const closes = [...new Set(listed)].filter((number) => number !== own && number !== pull.number);
  return { own, closes };
}

/**
 * Whether `scope:cross-cutting` counts, by who put it on: the OpenADLC app,
 * the automation account the bridge acts as when there is no app, or a
 * person. A crew account's never does — the builder whose work the scope
 * check bounds could otherwise waive it for itself. A widening a builder
 * needs is asked for with a `plan_change` marker, and the lead can accept a
 * genuine one in its signed approval, which the bridge applies as the app.
 *
 * `viaApp` is a timeline entry the app made; a webhook's sender says the same
 * with its `[bot]` login.
 */
export function scopeLabelAcceptedFrom(
  actor: { login: string | null; viaApp?: boolean },
  context: { crew: readonly { githubLogin: string | null }[]; automationLogin: string | null },
): boolean {
  if (actor.viaApp) return true;
  if (!actor.login) return false;
  if (sameLogin(actor.login, context.automationLogin)) return true;
  return !isFleetLogin(context.crew, actor.login);
}
