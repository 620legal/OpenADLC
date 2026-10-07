import { attachments, audit, bots, costs, credentials, deployRuns, health, issues, lastGithubDelivery, leases, pruneGithubDeliveries, recordEvent, repos, settings, spendingLimits, tasks, threads } from '@fleetadlc/db';
import { claimWindowStart } from './attachment-routes.js';
import { sweepDesignMemory } from './design-memory.js';
import { leadOnlyResolutionTo, resolutionCheckBrief } from './conflict-round.js';
import type { Stacking } from './stacking.js';
import type { UnlabeledIntake } from './unlabeled-intake.js';
import { actsForOn } from './people.js';
import { DEFAULT_PATH_POLICY, REVIEW_GATE_CHECK, actsFor, deliveryRulesFrom, envInt, type PathPolicy, type TaskKind, type TaskState, dedupeMarker, hasIgnoreLabel } from '@fleetadlc/shared';
import { blockingOverlaps, type WorkInFlight } from '@fleetadlc/dispatcher';
import { ATTENTION_WINDOW_DAYS, triedAgain } from './attention.js';
import { subjectClosed, wasRefused } from './gates.js';
import type { Automation } from './automation.js';
import { causeOfFailure, isPrerequisiteRow } from './health/checks/crew.js';
import { endedBySendingBack, issueForSubject, issueNumberFromBranch, parseRef, stageOfTask } from './work.js';
import { asAutomation, automationBotName, findOwnOpenIssue } from './automation-bot.js';
import { shipsByMerging, testingDeployChoice, type TestingDeployChoice } from './deploys.js';
import type { DeployPipeline } from './deploy-pipeline.js';
import type { DeliveryKnowledge } from './delivery-rules.js';
import { PULL_REQUEST_GRACE_MS, continuesBranch, nothingPushed, noPullRequest, readBranch, type BranchFacts } from './build-left.js';
import type { BridgeConfig } from './config.js';
import { driftLine, renderDrift, type Reconciler } from './reconciler.js';
import type { CrewAccessKeeper } from './crew-access.js';
import { buildStatus, renderStatusMarkdown, statusDrift, statusIssueTarget } from './status.js';
import type { MergeLine } from './merge-line.js';
import type { StageHandoff } from './stage-handoff.js';
import type { HostdClient } from './hostd-client.js';
import { heldAtCap, type TaskService } from './task-service.js';
import type { Notifier } from './notify.js';
import type { EngineUpdates } from './engine-updates.js';

export interface JobResult {
  job: string;
  actions: string[];
}

/** Every job the scheduler knows, so `fleetadlc status` can list them. */
export const SCHEDULED_JOBS = [
  'reconcile',
  'status',
  'budget',
  'stages',
  'merge',
  'qa',
  'credentials',
  'deps',
  'deploy',
  'engines',
  'attachments',
  'events',
] as const;

/**
 * The one line worth a notification, or null when nothing needs a person.
 *
 * Deliberately narrow. The status issue's body carries everything; a comment is
 * for the cases where waiting for someone to look would be too late.
 */
export function attentionIn(status: {
  budget: { state: string; spentUsd: number; capUsd: number };
  openGates: number;
  crew: { name: string; authorization: string }[];
}): string | null {
  if (status.budget.state === 'stopped') {
    return `Spending is stopped: $${status.budget.spentUsd.toFixed(2)} of $${status.budget.capUsd.toFixed(0)}. Nothing new will be leased until the cap moves or the period rolls.`;
  }

  const locked = status.crew.filter((bot) => bot.authorization === 'revoked' || bot.authorization === 'expired');
  if (locked.length > 0) {
    // A command per bot: `fleetadlc auth login` alone names none, and refuses.
    return `${locked.map((bot) => bot.name).join(', ')} cannot act on GitHub any more. Run: ${locked.map((bot) => `\`fleetadlc auth login --bot ${bot.name}\``).join(', ')}.`;
  }

  if (status.openGates > 0) {
    return `${status.openGates} ${status.openGates === 1 ? 'question is' : 'questions are'} waiting on a person.`;
  }

  return null;
}

export interface RecoveryDeps {
  /** `retryTask`, bound to what it needs; it refuses a task that cannot be run again. */
  retry(taskId: string, actor: string): Promise<{ task: { taskId: string; error?: string } | null; bot: string; queued?: true }>;
  now?: () => Date;
  /**
   * The install's caps, which the sweep reads to start work a spending cap
   * held (`heldAtCap`) once that cap allows it. Absent — a health run's
   * call — such work is left for the sweep.
   */
  costs?: { monthlyCapUsd: number; onCap: { stopLeasing: boolean } };
  /**
   * Which overlapping changes may be built side by side in a repository, as
   * the dispatcher is given it. Absent, the repository's stored rules, as a
   * dispatcher of its own reads them.
   */
  pathPolicy?: (repo: { id: string; name: string; fullName: string; defaultBranch: string }) => Promise<PathPolicy>;
}

/** Labels the dispatcher leases no issue under (`listRoutableIssues`): a person has it, or it is not the crew's to do. */
function heldFromTheCrew(labels: readonly string[] | undefined): boolean {
  return (labels ?? []).some((label) => label === 'needs-human' || label === 'needs-triage' || (label.startsWith('do:') && label !== 'do:ai'));
}

/**
 * Whether the card holds this work back: it is not in the stage the work is
 * for, or it carries a label the dispatcher leases nothing under.
 */
function cardHoldsIt(task: { kind: TaskKind; skill?: string | null }, issue: { stage: string; labels: string[] }): boolean {
  // A conflict resolution round is a patch the merge line opens on a pull
  // request in Review: read as Build work, it was never run again.
  const stage = task.kind === 'patch' && task.skill === 'resolve-conflict' ? 'review' : stageOfTask(task.kind);
  // Moved on, there is nothing for it to hold up; moved back, a person or a
  // send-back wants the earlier stage done first.
  return issue.stage !== stage || heldFromTheCrew(issue.labels);
}

/** What a sweep has started in each repository this pass, which the store may not show yet. */
type StartedThisPass = Map<string, WorkInFlight[]>;

/**
 * Whether the dispatcher would start this work now, asked before a run it
 * did not start is claimed. `retryTask` leases and starts a build with no
 * stage, label, concurrency or overlap check: it is also a person's Try
 * again, which may mean to override. Run again on its own, a build started on
 * a card a person had moved back to Design or labelled `needs-human`, beside
 * a build the dispatcher started meanwhile on the same files, or past the
 * repository's concurrency. Passed over unclaimed, it is run by a later
 * sweep once what held it is gone.
 */
async function dispatcherWouldStart(
  task: { kind: TaskKind; skill?: string | null },
  issue: { number: number; stage: string; labels: string[]; declaredPaths?: string[] } | null,
  repo: { id: string; name: string; fullName: string; defaultBranch: string; concurrency: number } | null,
  pass: { started: StartedThisPass; pathPolicy?: RecoveryDeps['pathPolicy'] },
): Promise<boolean> {
  if (issue && cardHoldsIt(task, issue)) return false;
  if (task.kind !== 'implement') return true;
  if (!issue || !repo) return false;

  const started = pass.started.get(repo.id) ?? [];
  if ((await tasks.countUnfinishedImplementTasks(repo.id)) + started.length >= repo.concurrency) return false;
  const inFlight = [...(await issues.workInFlight(repo.id)), ...started];
  if (inFlight.some((work) => work.number === issue.number && work.building)) return false;
  const declared = issue.declaredPaths ?? [];
  if (declared.length === 0) return true;
  const policy = pass.pathPolicy
    ? await pass.pathPolicy(repo).catch(() => DEFAULT_PATH_POLICY)
    : deliveryRulesFrom(null, (await (async () => repos.getDelivery(repo.id))().catch(() => null))?.deliveryRules ?? null).paths;
  return blockingOverlaps(declared, inFlight.filter((work) => work.number !== issue.number), policy).length === 0;
}

/** Counts a build started this pass as the dispatcher counts one: in flight, and being built. */
function startedBuild(pass: StartedThisPass, repoId: string | null, issue: { number: number; declaredPaths?: string[] } | null): void {
  if (!repoId || !issue) return;
  pass.set(repoId, [...(pass.get(repoId) ?? []), { number: issue.number, paths: issue.declaredPaths ?? [], building: true }]);
}

/** The cause the audit trail names for work run again once a spending cap allowed it. */
export const SPENDING_CAP_CAUSE = 'spending-cap';

/**
 * Whether a spending cap would let this task's bot start in its repository
 * now: raised in Settings, or a new month begun. Asked with the same check
 * that held it, so it is the same caps and the same words.
 */
async function capAllows(
  task: { botId: string; repoId: string | null },
  repo: { id: string; fullName: string } | null,
  caps: NonNullable<RecoveryDeps['costs']>,
): Promise<boolean> {
  const bot = await bots.getBotById(task.botId);
  if (!bot) return false;
  const refused = await spendingLimits.refusal({
    monthlyCapUsd: caps.monthlyCapUsd,
    onCap: caps.onCap,
    period: costs.currentPeriod(),
    repoId: repo?.id ?? null,
    repoLabel: repo?.fullName ?? '',
    botId: bot.id,
    botName: bot.name,
    engine: bot.engine,
  });
  return refused == null;
}

/** Who the audit trail says ran a task again after its cause was put right. */
export const RECOVERY_ACTOR = 'health-recovery';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Runs again, once, the tasks that failed for something a health check proves
 * and that check now passes: a seat's sign-in, its place in the repository, or
 * the host service.
 *
 * A task that failed on one of those waited for a person to press Try again
 * after fixing it, though OpenADLC was the one to see it fixed. Only a failure
 * whose own words name the cause is run again; a model account signed out, a
 * build that failed or a permission the app lacks stay for a person. Each
 * failure is run again at most once: the claim on it is one statement, so two
 * recoveries at once cannot both have it, and the task started for it is
 * claimed too, or a task that failed again for the same cause would be run
 * again for good. A retry refused (the check that passed is not the only one
 * failing) gives the claim back.
 *
 * `fixed` is the ids of the health rows that just went from failing to
 * passing, when a health run calls this. Null is the scheduler's sweep, which
 * is what comes back for a task the first pass could not run: a bot with two
 * failed tasks from one outage can run one of them at a time, and the check
 * that let the second go does not turn green a second time. The sweep runs a
 * task again only when its cause row passes now and was fixed after the task
 * ended — a check that never failed proves nothing was put right.
 *
 * The sweep also starts work a spending cap held (`TaskService.open`,
 * `whenBlocked: 'record'`): a patch round, a verification after a deploy.
 * No health row passes for those; what put them right is the cap itself,
 * raised in Settings or reset by a new month, so the sweep asks the cap
 * again and starts the work when it answers yes. Like any failure, it is
 * looked for within the board's window (`ATTENTION_WINDOW_DAYS`): older than
 * that, it has left the board and waits for a person.
 */
export async function retryAfterRecovery(fixed: readonly string[] | null, deps: RecoveryDeps): Promise<string[]> {
  const justFixed = fixed ? new Set(fixed.filter(isPrerequisiteRow)) : null;
  if (justFixed?.size === 0) return [];

  const now = deps.now?.() ?? new Date();
  const windowStart = now.getTime() - ATTENTION_WINDOW_DAYS * DAY_MS;
  const [recent, repoList, issueList, rows] = await Promise.all([
    tasks.listTasksSince(new Date(windowStart)),
    repos.listRepos(),
    issues.listIssues(),
    justFixed ? Promise.resolve<Awaited<ReturnType<typeof health.listHealth>>>([]) : health.listHealth(),
  ]);
  // When each prerequisite row that passes now last turned from failing.
  const fixedAt = new Map(
    rows.filter((row) => isPrerequisiteRow(row.id) && row.state === 'ok' && row.fixedAt).map((row) => [row.id, Date.parse(row.fixedAt ?? '')]),
  );
  const putRight = (cause: string, endedAt: number): boolean =>
    justFixed ? justFixed.has(cause) : (fixedAt.get(cause) ?? Number.NEGATIVE_INFINITY) > endedAt;

  const actions: string[] = [];
  // A seat runs as many tasks at once as its "tasks at once" setting
  // (`bots.max_tasks`) allows, so of its failures that many are run again per
  // pass, counting what is running; the rest wait for the next sweep, unclaimed. Asking anyway was refused as
  // busy, every time, with a line in the log for each.
  const startedFor = new Map<string, number>();
  const startedIn: StartedThisPass = new Map();
  for (const task of recent) {
    if (task.state !== 'failed' && task.state !== 'stopped') continue;
    if (task.autoRetriedAt) continue;
    const endedAt = Date.parse(task.endedAt ?? task.startedAt ?? task.createdAt);
    if (endedAt < windowStart) continue;
    if (triedAgain(task, recent)) continue;

    const parsed = parseRef(task.subjectRef);
    const repoName = repoList.find((repo) => repo.id === task.repoId)?.name ?? parsed?.repo ?? null;
    const healthCause = causeOfFailure(task.exitReason, { botId: task.botId, repoName });
    const capHeld = !healthCause && !justFixed && Boolean(deps.costs) && heldAtCap(task.exitReason);
    if (healthCause ? !putRight(healthCause, endedAt) : !capHeld) continue;
    const cause = healthCause ?? SPENDING_CAP_CAUSE;

    // The card has moved past the stage this work was for: whatever failed no
    // longer holds anything up, and running it again would start a review of a
    // merged pull request. Nor is it started where the dispatcher would not
    // start it now (`dispatcherWouldStart`). A task with no issue row, a
    // request's triage, is not held by one.
    const issue = issueForSubject(task.subjectRef, issueList);
    const repo = repoList.find((entry) => entry.id === task.repoId) ?? null;
    // `fleetadlc:ignore` is a person telling the crew to leave the issue alone, and
    // running its failed work again is the crew starting a task there.
    // It is passed over before the claim, so taking the label off lets a later
    // sweep run it again as it would have.
    if (hasIgnoreLabel(issue?.labels)) continue;
    if (!(await dispatcherWouldStart(task, issue, repo, { started: startedIn, pathPolicy: deps.pathPolicy }))) continue;

    if (!(await tasks.seatHasRoom(task.botId, startedFor.get(task.botId) ?? 0))) continue;
    if (capHeld && deps.costs) {
      if (!(await capAllows(task, repo, deps.costs))) continue;
    }
    if (!(await tasks.claimAutoRetry(task.id))) continue;
    try {
      const retried = await deps.retry(task.id, RECOVERY_ACTOR);
      startedFor.set(task.botId, (startedFor.get(task.botId) ?? 0) + 1);
      if (task.kind === 'implement') startedBuild(startedIn, task.repoId, issue);
      // A request's triage may be waiting its turn for intake; it starts from the queue.
      if (retried.task) await tasks.claimAutoRetry(retried.task.taskId);
      await audit({
        actor: RECOVERY_ACTOR,
        action: 'task.auto_retried',
        target: task.subjectRef,
        payload: { retried: task.id, task: retried.task?.taskId ?? null, bot: retried.bot, kind: task.kind, cause, ...(retried.queued ? { queued: true } : {}) },
      });
      actions.push(
        capHeld
          ? `${task.subjectRef}: ${retried.bot}’s ${task.kind} started, now that the spending cap allows it`
          : `${task.subjectRef}: ${retried.bot}’s ${task.kind} run again, now that ${cause} passes`,
      );
    } catch (error) {
      await tasks.releaseAutoRetry(task.id).catch(() => undefined);
      const why = error instanceof Error ? error.message : String(error);
      actions.push(`${task.subjectRef}: not run again (${why})`);
    }
  }
  return actions;
}

/** Who the audit trail says went on with a build that ended without its pull request. */
export const CONTINUE_ACTOR = 'bridge';

export interface ContinueDeps {
  /** `retryTask`, bound to what it needs: it goes on from the branch of a build that ended `done` (`continuesBranch`). */
  retry: RecoveryDeps['retry'];
  /** What GitHub says of a build's branch; null when it cannot be asked. See `readBranch`. */
  branch(repoFullName: string, branch: string, base: string): Promise<BranchFacts | null>;
  /** Whether GitHub says the issue is closed; a build on a closed issue is left alone. Absent, or failing, it is taken as open. */
  closed?(repoFullName: string, number: number): Promise<boolean>;
  /** The repository's path policy, as the dispatcher is given it; see `RecoveryDeps.pathPolicy`. */
  pathPolicy?: RecoveryDeps['pathPolicy'];
  /**
   * The earliest end a build is looked at for: when this bridge started, or
   * a lease's length ago (`FLEETADLC_LEASE_HOURS`), whichever is later. Absent,
   * a lease's length ago.
   */
  since?: Date;
  now?: () => Date;
}

/** How far back a build that ended without its pull request is still looked at: a lease's length, `FLEETADLC_LEASE_HOURS`. */
function leaseWindowMs(): number {
  return envInt('FLEETADLC_LEASE_HOURS', 12) * 60 * 60 * 1000;
}

/**
 * Looks again at every build that ended `done` at least a grace period ago
 * (`PULL_REQUEST_GRACE_MS`), and whose issue has no pull request.
 *
 * A builder whose session ended before it opened its pull request left a
 * `done` task, and nothing ran it again: the recovery takes `done` at its
 * word, and the lease waited out its twelve hours for a pull request that was
 * not coming. So, asking GitHub about the branch first:
 *
 * - a pull request from it after all (its webhook missed) is left alone;
 * - no commits beyond the base: nothing was built, and the task failed, with
 *   a reason saying so, which puts it on the board;
 * - commits and no pull request: the build is continued on its branch, once,
 *   to run the checks and open the pull request (`retryTask`). The claim is
 *   `tasks.auto_retried_at`, as the recovery's; the build started for it is
 *   claimed too, so one that also ends without its pull request fails
 *   instead, with a card that offers to open it from the branch.
 *
 * A build a later build took over from, one whose issue has moved past
 * building or that a person marked `fleetadlc:ignore`, and one GitHub cannot be
 * asked about are left as they are. Never failed or run again on a guess.
 */
export async function continueBuildsWithoutPullRequest(deps: ContinueDeps): Promise<string[]> {
  const now = deps.now?.() ?? new Date();
  // Builds from before this bridge started, or older than a lease, are left
  // as they are: the first sweep after a deploy would otherwise run week-old
  // builds again, or put their cards up, long after anyone was waiting.
  const windowStart = Math.max(now.getTime() - leaseWindowMs(), deps.since?.getTime() ?? Number.NEGATIVE_INFINITY);
  // Read over the board's week, so the build a continuation went on from is
  // found even when it ended before the window: that is what makes it the
  // second try.
  const [recent, repoList, issueList] = await Promise.all([
    tasks.listTasksSince(new Date(now.getTime() - ATTENTION_WINDOW_DAYS * DAY_MS)),
    repos.listRepos(),
    issues.listIssues(),
  ]);

  const actions: string[] = [];
  // Builds continued this pass, per seat and per repository, which the table does not show yet.
  const startedFor = new Map<string, number>();
  const startedIn: StartedThisPass = new Map();
  for (const task of recent) {
    if (task.kind !== 'implement' || task.state !== 'done' || !task.branch) continue;
    // Sent back on purpose: the stage it went to has the issue now.
    if (endedBySendingBack(task.exitReason)) continue;
    const endedAt = Date.parse(task.endedAt ?? task.startedAt ?? task.createdAt);
    if (endedAt < windowStart || now.getTime() - endedAt < PULL_REQUEST_GRACE_MS) continue;
    if (triedAgain(task, recent)) continue;

    const issue = issueForSubject(task.subjectRef, issueList);
    if (!issue || issue.prNumber) continue;
    if (cardHoldsIt(task, issue) || hasIgnoreLabel(issue.labels)) continue;
    const repo = repoList.find((entry) => entry.id === task.repoId);
    if (!repo) continue;

    const facts = await deps.branch(repo.fullName, task.branch, repo.defaultBranch).catch(() => null);
    if (!facts || facts.pullRequest) continue;
    // Closed on GitHub, by a person or as already done: nothing is left to
    // build, and a failed task would be a card about nothing.
    if (await (deps.closed?.(repo.fullName, issue.number) ?? Promise.resolve(false)).catch(() => false)) continue;

    // Itself the second try: claimed when it started, and going on from a
    // build that also ended without its pull request. A build the recovery
    // started is claimed too, and gets its second try all the same.
    const before = recent
      .filter((other) => other.subjectRef === task.subjectRef && other.kind === task.kind && Date.parse(other.createdAt) < Date.parse(task.createdAt))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    const secondTry = Boolean(task.autoRetriedAt) && before !== undefined && continuesBranch(before);
    if (facts.ahead === 0 || secondTry) {
      // Nothing built, or built and continued once already: failed, which is
      // what puts it in front of a person.
      const reason = facts.ahead === 0 ? nothingPushed(task.branch) : noPullRequest(task.branch);
      await failBuild(task, reason);
      actions.push(`${task.subjectRef}: the build ${reason}`);
      continue;
    }

    // Only where the dispatcher would start the build now (`dispatcherWouldStart`):
    // with no room for it, or beside a build on the same files, it waits,
    // unclaimed, for a later sweep.
    if (!(await dispatcherWouldStart(task, issue, repo, { started: startedIn, pathPolicy: deps.pathPolicy }))) continue;
    if (!(await tasks.seatHasRoom(task.botId, startedFor.get(task.botId) ?? 0))) continue;
    const claimed = !task.autoRetriedAt;
    if (claimed && !(await tasks.claimAutoRetry(task.id))) continue;
    try {
      const continued = await deps.retry(task.id, CONTINUE_ACTOR);
      startedFor.set(task.botId, (startedFor.get(task.botId) ?? 0) + 1);
      startedBuild(startedIn, task.repoId, issue);
      await audit({
        actor: CONTINUE_ACTOR,
        action: 'task.continued',
        target: task.subjectRef,
        payload: { continued: task.id, task: continued.task?.taskId ?? null, bot: continued.bot, branch: task.branch, ahead: facts.ahead },
      });
      actions.push(`${task.subjectRef}: ${continued.bot}’s build ended without its pull request, so it goes on from ${task.branch}`);
    } catch (error) {
      if (claimed) await tasks.releaseAutoRetry(task.id).catch(() => undefined);
      actions.push(`${task.subjectRef}: the build without its pull request was not continued (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return actions;
}

/** Marks a finished build failed, and says so in its bot's thread, where it said it had finished. */
async function failBuild(task: { id: string; botId: string; repoId: string | null; subjectRef: string }, reason: string): Promise<void> {
  await tasks.updateTaskState(task.id, 'failed', { exitReason: reason });
  await audit({ actor: CONTINUE_ACTOR, action: 'task.failed_without_pull_request', target: task.subjectRef, payload: { task: task.id, reason } }).catch(
    () => undefined,
  );
  try {
    const thread = await threads.ensureThread({ botId: task.botId, repoId: task.repoId, subjectRef: task.subjectRef });
    await threads.addMessage({ threadId: thread.id, kind: 'sys', author: 'fleetadlc', text: `the build on ${task.subjectRef} ${reason}`, payload: { taskId: task.id, state: 'failed' } });
  } catch (error) {
    console.warn(`[bridge] could not say in its thread that ${task.id} failed: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * The label a testing deploy leaves on the issue. The dependency check reads
 * this, not the workflow run, so a merged issue without it has not reached
 * testing — whatever a bot may have said.
 */
export const TESTING_DEPLOY_LABEL = 'deployed:testing';

export interface AwaitingDeploy {
  repo: string;
  number: number;
  prNumber: number | null;
}

/** Merged work the board does not yet show as on testing. */
export function awaitingTestingDeploy(
  rows: readonly {
    repoName: string;
    number: number;
    prNumber: number | null;
    labels: readonly string[];
    stage: string;
  }[],
): AwaitingDeploy[] {
  return rows
    .filter((issue) => issue.stage === 'merged' && !issue.labels.includes(TESTING_DEPLOY_LABEL))
    .map((issue) => ({ repo: issue.repoName, number: issue.number, prNumber: issue.prNumber }));
}

export type DeploySweepPlan =
  | { kind: 'idle' }
  | { kind: 'no-target'; waiting: AwaitingDeploy[] }
  | { kind: 'no-bot'; waiting: AwaitingDeploy[] }
  | {
      kind: 'work';
      /** The one deploy this firing starts, if any. */
      start: {
        subjectRef: string;
        repo: string;
        /** Why this is another try — the last one failed, or was interrupted — when it is one. */
        retry?: string;
      } | null;
      /** What this firing leaves alone, and why. */
      hold: string[];
    };

function describeWaiting(waiting: readonly AwaitingDeploy[]): string {
  return waiting
    .map((item) =>
      item.prNumber
        ? `${item.repo}#${item.number} (pull request #${item.prNumber})`
        : `${item.repo}#${item.number} (no pull request recorded)`,
    )
    .join(', ');
}

/** How far a redelivery pass reads past the last one, for GitHub's clock against the bridge's. */
const REDELIVERY_SLACK_MS = 60_000;

/**
 * How many deploy tasks may fail or stop on one pull request before the sweep
 * leaves it for a person. A deploy that hostd refused is worth another try; one
 * that fails on every firing is a broken deploy path spending the per-task cap.
 */
export const MAX_DEPLOY_ATTEMPTS = 3;

/**
 * A task that ended without doing its work, which may be tried again: a deploy
 * the sweep retries, or a QA run a promote asks for a second time.
 */
export function taskGaveUp(state: TaskState): boolean {
  return state === 'failed' || state === 'stopped';
}

/** A deploy task as the sweep weighs it: how it ended, and why. */
export interface PriorDeploy {
  subjectRef: string;
  state: TaskState;
  exitReason?: string | null;
}

/**
 * Whether a task ended because a person meant it to: they killed its session
 * (`tasks.stoppedByPerson`), or refused the plan change it asked for. Either is
 * a decision about the work, and starting it again would overrule it. A task
 * whose session went away on its own — a crash, a host that stopped — was
 * interrupted, which is what the sweep is a backstop for.
 */
export function stoppedOnPurpose(task: PriorDeploy): boolean {
  return (
    task.state === 'stopped' &&
    (tasks.stoppedByPerson({ state: task.state, exitReason: task.exitReason ?? null }) || wasRefused(task.exitReason))
  );
}

/** How a deploy that gave up ended, in the words the sweep's report uses. */
function howItEnded(task: PriorDeploy): string {
  const why = task.exitReason?.trim() ? `: ${task.exitReason.trim().slice(0, 120)}` : '';
  return task.state === 'failed' ? `failed${why}` : `was interrupted${why}`;
}

/**
 * What a deploy sweep will do, decided before it does anything.
 *
 * The same board, the same branch tips and the same prior tasks produce the
 * same plan, which is what makes firing the job twice safe.
 *
 * It starts at most one deploy, of the newest merge on a repository's default
 * branch. A deploy task deploys its pull request's own merge commit, so the
 * newest carries every merge before it, and an older one would put testing
 * back on a revision without the newer work. The bridge labels only the pull
 * request a deployed commit came from, so the older ones stay unlabelled once
 * the newest is live; they are reported as carried and never deployed. That is
 * why "newest" is the branch tip and not the newest of the waiting ones: once
 * the tip is labelled, the next waiting one is older than what testing has.
 *
 * A start also needs a testing URL and no deploy task on that pull request that
 * is still going or finished: the sweep is the backstop for a merge webhook
 * that never arrived, not a second way to deploy. A deploy that failed or was
 * interrupted is exactly what a backstop is for, so it is tried again, up to
 * `MAX_DEPLOY_ATTEMPTS`, and the report says which it was. One a person
 * stopped is not: when the newest deploy of a pull request was stopped on
 * purpose (`stoppedOnPurpose`), the sweep leaves it until a person starts
 * another.
 */
export function planDeploySweep(input: {
  waiting: readonly AwaitingDeploy[];
  testingUrl: string;
  deployBot: string | null;
  /** The pull request each repository's default branch is at; null or absent when unknown. */
  newest: Readonly<Record<string, number | null>>;
  /** The deploy tasks already opened on these pull requests, newest first, as `tasks.listTasksForSubjects` answers. */
  priorDeploys: readonly PriorDeploy[];
}): DeploySweepPlan {
  if (input.waiting.length === 0) return { kind: 'idle' };
  // Same refusal as the QA job. A deploy with nowhere to land would either
  // skip the workflow or run the stub targets, and a green result of that
  // would label a pull request as live somewhere it is not.
  if (!input.testingUrl.trim()) return { kind: 'no-target', waiting: [...input.waiting] };
  if (!input.deployBot) return { kind: 'no-bot', waiting: [...input.waiting] };

  let start: (DeploySweepPlan & { kind: 'work' })['start'] = null;
  const hold: string[] = [];
  for (const item of input.waiting) {
    if (!item.prNumber) {
      hold.push(`${item.repo}#${item.number} is merged with no pull request recorded; not deploying it`);
    }
  }

  for (const repo of new Set(input.waiting.map((item) => item.repo))) {
    const recorded = input.waiting.filter((item) => item.repo === repo && item.prNumber);
    if (recorded.length === 0) continue;
    const refs = (items: readonly AwaitingDeploy[]) => items.map((item) => `${repo}#${item.prNumber}`).join(', ');

    const newest = input.newest[repo] ?? null;
    if (newest === null) {
      hold.push(
        `${refs(recorded)}: cannot tell which merge is newest on ${repo}, and an older one would take testing backwards; not deploying`,
      );
      continue;
    }
    const older = recorded.filter((item) => item.prNumber !== newest);
    if (older.length > 0) {
      hold.push(`${refs(older)}: older than ${repo}#${newest}, the newest merge, whose deploy carries them`);
    }
    if (older.length === recorded.length) continue;

    const subjectRef = `${repo}#${newest}`;
    const prior = input.priorDeploys.filter((task) => task.subjectRef === subjectRef);
    const live = prior.find((task) => !taskGaveUp(task.state));
    if (live) {
      hold.push(`${subjectRef}: a testing deploy was already started (${live.state})`);
      continue;
    }
    const last = prior[0];
    if (last && stoppedOnPurpose(last)) {
      hold.push(
        `${subjectRef}: its last testing deploy was stopped on purpose (${last.exitReason ?? 'stopped'}); not starting another until a person does`,
      );
      continue;
    }
    if (prior.length >= MAX_DEPLOY_ATTEMPTS) {
      hold.push(
        `${subjectRef}: ${prior.length} testing deploys failed or were interrupted; not trying again until a person looks`,
      );
      continue;
    }
    // One deploy bot runs one task. A second repository's newest merge is the
    // next firing's, not a task that would be refused as busy.
    if (start) {
      hold.push(`${subjectRef}: next, after the deploy this firing started`);
      continue;
    }
    start = last
      ? {
          subjectRef,
          repo,
          retry: `its last testing deploy ${howItEnded(last)}; attempt ${prior.length + 1} of ${MAX_DEPLOY_ATTEMPTS}`,
        }
      : { subjectRef, repo };
  }
  return { kind: 'work', start, hold };
}

/** The one line a plan reports when it is not going to start anything. */
export function deploySweepRefusal(plan: DeploySweepPlan): string | null {
  switch (plan.kind) {
    case 'idle':
      return 'nothing merged is waiting on a testing deploy';
    case 'no-target':
      return `no testing deploy target is configured: set testing.url in the repository's .github/fleetadlc.yml (FLEETADLC_TESTING_URL is the deprecated fallback); not deploying ${describeWaiting(plan.waiting)}`;
    case 'no-bot':
      return `${describeWaiting(plan.waiting)} ${plan.waiting.length === 1 ? 'needs' : 'need'} a testing deploy, and no bot has the deploy role`;
    case 'work':
      return null;
  }
}

/** Who runs a QA task, and the environment it runs against. */
export interface QaTarget {
  bot: string;
  testingUrl: string;
}

/** Why no QA task opens without a testing URL, in the same words wherever it is refused. */
export const NO_TESTING_URL =
  "no testing environment is configured: set testing.url in the repository's .github/fleetadlc.yml (FLEETADLC_TESTING_URL is the deprecated fallback); not opening a QA task";

/**
 * Who would run QA, or why nobody can.
 *
 * The nightly job and a production promote both ask, so they refuse for the same
 * reasons in the same words. Refusing is the right answer for both: a QA task
 * with no environment to point at would report a green readiness against
 * nothing.
 */
export async function qaTarget(testingUrl: string): Promise<QaTarget | { refusal: string }> {
  const qaBot = (await bots.listBots()).find((bot) => bot.role === 'qa');
  if (!qaBot) return { refusal: 'no bot has the qa role; nothing to start' };
  if (!testingUrl) return { refusal: NO_TESTING_URL };
  return { bot: qaBot.name, testingUrl };
}

/**
 * Opens one QA task against testing, and says what happened in one line.
 *
 * `taskId` is null when nothing is running — the bot was busy, or hostd refused
 * and the task was saved as failed — so a caller that tells a person about it
 * does not claim a run that never started.
 */
export async function openQaRun(
  taskService: TaskService,
  target: QaTarget,
  input: { repo: string; subjectRef: string },
): Promise<{ taskId: string | null; line: string }> {
  try {
    const started = await taskService.open({
      bot: target.bot,
      repo: input.repo,
      kind: 'qa',
      subjectType: 'request',
      subjectRef: input.subjectRef,
      skill: 'qa',
      declaredPaths: ['tests/**'],
    });
    if (started.error) return { taskId: null, line: `${input.subjectRef}: ${started.error.slice(0, 120)}` };
    return {
      taskId: started.taskId,
      line: `opened a QA run on ${input.subjectRef} against ${target.testingUrl} (task ${started.taskId})`,
    };
  } catch (error) {
    // One container, one task: a QA run already going is not a failure of the
    // caller, it is the previous one still working.
    return {
      taskId: null,
      line: `${input.subjectRef}: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`,
    };
  }
}

/** How close a refresh token may get to expiry before a person is told. */
const CREDENTIAL_WARNING_MS = 21 * 86_400_000;

/**
 * The recurring work that has no webhook: reconciling what the platform believes
 * against what GitHub says, regenerating the status view, and keeping the budget
 * state current.
 */
export class Scheduler {
  constructor(
    private readonly config: BridgeConfig,
    private readonly hostd: HostdClient,
    private readonly automation: Automation,
    private readonly reconciler: Reconciler,
    private readonly stages: StageHandoff,
    private readonly mergeLine: MergeLine,
    private readonly taskService: TaskService,
    private readonly notifier: Notifier | null = null,
    /** The weekly engine update's clock; see `engine-updates.ts`. */
    private readonly engineUpdates: Pick<EngineUpdates, 'tick'> | null = null,
    /** Lets the crew into every repository; see `crew-access.ts`. */
    private readonly crewAccess: Pick<CrewAccessKeeper, 'ensureAll'> | null = null,
    /** Runs a failed task again once its cause passes; see `retryAfterRecovery`. */
    private readonly recovery: RecoveryDeps | null = null,
    /**
     * Builds that ended without their pull request (`continueBuildsWithoutPullRequest`):
     * whether anything dispatches here (`anythingDispatches`), and when this
     * bridge started, which is as far back as they are looked at. Absent,
     * they are not looked at.
     */
    private readonly builds: { dispatching: boolean; startedAt: Date } | null = null,
  ) {}

  private buildsLooking: Promise<string[]> | null = null;

  /**
   * Looks at builds that ended without their pull request, once at a time:
   * the merge job and the look a build's end asks for can arrive together.
   * Nothing is continued where nothing dispatches: a continued build is a
   * lease the dispatcher would have handed out, and with it off a person runs
   * builds by hand.
   */
  async continueBuilds(): Promise<string[]> {
    if (!this.recovery || !this.builds) return [];
    if (!this.builds.dispatching) return [];
    if (this.buildsLooking) return this.buildsLooking;
    const recovery = this.recovery;
    const since = this.builds.startedAt;
    const client = async () => asAutomation(this.automation['actors'], this.config);
    this.buildsLooking = continueBuildsWithoutPullRequest({
      retry: recovery.retry,
      branch: async (repoFullName, branch, base) => {
        const github = await client();
        return github ? readBranch(github, repoFullName, branch, base) : null;
      },
      closed: async (repoFullName, number) => {
        const github = await client();
        return github ? subjectClosed(github, repoFullName, number) : false;
      },
      since,
      ...(recovery.pathPolicy ? { pathPolicy: recovery.pathPolicy } : {}),
    })
      .catch((error: unknown) => [`could not look at builds that ended without a pull request: ${error instanceof Error ? error.message : error}`])
      .finally(() => {
        this.buildsLooking = null;
      });
    return this.buildsLooking;
  }

  /**
   * Asked when a build ends `done`: its pull request is looked for once its
   * webhook has had time to arrive (`PULL_REQUEST_GRACE_MS`), rather than on
   * the merge job up to ten minutes later. The timer does not hold the
   * process open.
   */
  afterBuildEnded(): void {
    if (!this.recovery || !this.builds?.dispatching) return;
    const timer = setTimeout(() => {
      void this.continueBuilds().then((actions) => {
        for (const action of actions) console.log(`[bridge] ${action}`);
      });
    }, PULL_REQUEST_GRACE_MS + 5_000);
    timer.unref?.();
  }

  /**
   * Works out again the gate of every pull request in review.
   *
   * The gate is worked out when something happens to a pull request — a
   * review, a push — and only then. One whose reviewers changed after its
   * last event sat at pending with every review it needed in: fleetadlc-testbed#2
   * was held on a sampled security review that a later decision no longer
   * asked for, and no event was ever coming to ask again. The same is true of
   * a review that arrived while the bridge was down. A pull request whose
   * gate passes now takes its place in the merge line.
   */
  async settleGates(): Promise<string[]> {
    const client = await asAutomation(this.automation['actors'], this.config);
    if (!client) return [];
    const actions: string[] = [];
    const crew = await bots.listBots().catch(() => []);

    for (const repo of await repos.listRepos()) {
      // GitHub's list, not the issues' own record of their pull requests: that
      // record was never written, and a sweep that trusted it found nothing.
      const open = await client
        .request<
          {
            number: number;
            draft: boolean;
            head: { ref: string; sha: string; repo?: { full_name: string } | null };
            base: { ref: string };
            labels: { name: string }[];
            user?: { login: string } | null;
            author_association?: string;
          }[]
        >('GET', `/repos/${repo.fullName}/pulls?state=open&per_page=100`)
        .catch(() => null);
      if (!open) continue;
      let inReview: Map<number, issues.IssueRecord>;
      try {
        inReview = new Map(
          (await issues.listIssues(repo.name)).filter((issue) => issue.stage === 'review').map((issue) => [issue.number, issue]),
        );
      } catch (error) {
        actions.push(`${repo.name}: could not settle the review gates: ${error instanceof Error ? error.message : error}`);
        continue;
      }

      for (const opened of open) {
        try {
          // A branch named like a builder's is not enough. A builder pushes to the
          // repository itself, so a pull request from a fork is never an issue's,
          // and one by somebody without access is nobody's OpenADLC acts for; see
          // `actsFor`. Either would otherwise be recorded as the issue's pull
          // request, and its gate worked out and its place taken in the line.
          const fork = opened.head.repo?.full_name && opened.head.repo.full_name.toLowerCase() !== repo.fullName.toLowerCase();
          if (fork) continue;
          if (!(await actsForOn({ client, repoFullName: repo.fullName, author: { login: opened.user?.login, association: opened.author_association }, crew }))) continue;
          const issueNumber = issueNumberFromBranch(opened.head.ref);
          const issue = issueNumber ? inReview.get(issueNumber) : undefined;
          if (!issue || !issueNumber) continue;
          if (issue.prNumber !== opened.number) {
            await issues.setPullRequestNumber(repo.id, issueNumber, opened.number).catch(() => undefined);
          }
          const pull = {
            number: opened.number,
            draft: opened.draft,
            headSha: opened.head.sha,
            baseRef: opened.base.ref,
            labels: opened.labels.map((label) => label.name),
          };

          const reviewed = await this.automation.reviewStanding(repo.fullName, {
            number: pull.number,
            draft: pull.draft,
            labels: pull.labels.map((name) => ({ name })),
            head: { sha: pull.headSha, ref: opened.head.ref },
            baseRef: pull.baseRef,
          });
          const computed = reviewed.gate;
          // "waiting on the reviewer account" when a seat it waits on cannot work.
          const gate = { ...computed, description: await this.taskService.gateDescription(computed.description, repo.name) };

          // Said again only when it changed: a status a minute on every pull
          // request would bury the one a person is looking for.
          const standing = await client
            .request<{ statuses?: { context: string; state: string; description: string | null }[] }>(
              'GET',
              `/repos/${repo.fullName}/commits/${pull.headSha}/status`,
            )
            .then((combined) => combined.statuses?.find((status) => status.context === REVIEW_GATE_CHECK) ?? null)
            .catch(() => null);
          let state = standing?.state === 'success' ? 'success' : 'pending';
          // GitHub keeps 140 characters of a description, and `fitStatus` posts
          // a longer one as 139 characters and an ellipsis, so only the first
          // 139 are compared.
          const same = (standing?.description ?? '').slice(0, 139) === gate.description.slice(0, 139);
          if (!standing || standing.state !== gate.state || !same) {
            const published = await this.automation.setReviewGate({
              repoFullName: repo.fullName,
              prNumber: pull.number,
              sha: pull.headSha,
              state: gate.state,
              description: gate.description,
            });
            state = published?.state ?? state;
            if (published && published.state !== standing?.state) {
              actions.push(`${repo.name}#${pull.number}: review gate is ${published.state} (${published.description})`);
            }
          }

          // A lead-only conflict resolution pushed as this head is the lead's to
          // re-check, whatever the gate says: a lead busy at the push is asked
          // here, with the same brief, and only once for that resolution.
          const resolution = await leadOnlyResolutionTo(repo.name, pull.number, pull.headSha);
          if (resolution) {
            const line = await this.taskService.openLeadReview({
              repo,
              prNumber: pull.number,
              branch: opened.head.ref,
              issueNumber,
              seat: reviewed.decision.lead,
              since: resolution.at,
              extraContext: [resolutionCheckBrief({ before: resolution.from, after: resolution.to, files: resolution.files })],
            });
            if (line) actions.push(line);
          }

          if (state === 'success') {
            await this.mergeLine.enter({ repoName: repo.name, prNumber: pull.number, headSha: pull.headSha });
          } else {
            // A seat the gate waits on with no review under way — its account was
            // connected after the pull request opened, or it could not work when
            // the review was asked for — is started once it can. No event is
            // coming for it: the account's coming back is not one GitHub sends.
            const waitingOn = /^waiting on (.+)$/.exec(computed.description)?.[1]?.split(', ') ?? [];
            actions.push(
              ...(await this.taskService.openMissingReviews({
                repo,
                prNumber: pull.number,
                branch: opened.head.ref,
                issueNumber,
                waitingOn: waitingOn.filter((seat) => seat !== reviewed.decision.lead),
              })),
            );
            // The lead's turn, when the review that completed the others found
            // it busy: no other event is coming for it.
            if (reviewed.leadDue && !resolution) {
              const line = await this.taskService.openLeadReview({
                repo,
                prNumber: pull.number,
                branch: opened.head.ref,
                issueNumber,
                seat: reviewed.leadDue.seat,
                since: reviewed.leadDue.since,
              });
              if (line) actions.push(line);
            }
          }
        } catch (error) {
          // One pull request whose gate cannot be set — the fallback status refused
          // on an organisation's repository, say — stopped the sweep for every one
          // after it, and with it the lead reviews only this sweep starts again.
          actions.push(`${repo.name}#${opened.number}: could not settle the review gate: ${error instanceof Error ? error.message : error}`);
        }
      }
    }
    return actions;
  }

  /** A merged change's way to production by its repository's rules; see `deploy-pipeline.ts`. */
  private pipeline: DeployPipeline | null = null;
  private delivery: DeliveryKnowledge | null = null;

  /** Set once both exist (`main.ts`); absent, the sweep and the QA job read the install's settings as before. */
  useDelivery(pipeline: DeployPipeline, delivery: DeliveryKnowledge): void {
    this.pipeline = pipeline;
    this.delivery = delivery;
  }

  private unlabeled: Pick<UnlabeledIntake, 'sweepOnce'> | null = null;

  /** The sweep that sends issues nobody labelled to intake, run with reconcile (`main.ts`). */
  useUnlabeledIntake(sweep: Pick<UnlabeledIntake, 'sweepOnce'>): void {
    this.unlabeled = sweep;
  }

  private defaultBranches: (() => Promise<string[]>) | null = null;

  /** Brings each repository's stored default branch in step with GitHub's (`default-branch.ts`); run with reconcile. */
  useDefaultBranches(sync: () => Promise<string[]>): void {
    this.defaultBranches = sync;
  }

  private stacking: Pick<Stacking, 'sweep'> | null = null;

  /** Starts work that depends on work in review from its branch, and holds it when that is sent back (`stacking.ts`); run with the merge job. */
  useStacking(stacking: Pick<Stacking, 'sweep'>): void {
    this.stacking = stacking;
  }

  /**
   * Has GitHub send again the app's deliveries since a time that never went
   * through (`redeliverFailedSince`), wired with the app's credentials in
   * `main.ts`: the ids it redelivered, or null without app credentials.
   */
  private redeliver: ((since: number) => Promise<number[] | null>) | null = null;
  /** When the last redelivery pass that read GitHub started; the next one reads back to it. */
  private redeliveredThrough: number | null = null;
  private redelivering: Promise<string | null> | null = null;

  /** Redelivers failed webhook deliveries when the bridge starts and on every reconcile (`main.ts`). */
  useRedelivery(redeliver: (since: number) => Promise<number[] | null>): void {
    this.redeliver = redeliver;
  }

  /**
   * Asks GitHub to send again what it could not deliver, and says how many it
   * asked for, or null when there was nothing to say. GitHub does not retry a
   * failed delivery by itself, so a gate answered on GitHub while the bridge
   * was down was lost, and its task waited for good.
   *
   * Reads back to the start of the last pass that read GitHub, or, before
   * any, to the last delivery the bridge took; a pass that failed moves
   * nothing, so the next one reads its stretch again. A minute's slack for
   * GitHub's clock against this one.
   */
  async redeliverFailed(now = Date.now()): Promise<string | null> {
    if (!this.redeliver) return null;
    if (this.redelivering) return this.redelivering;
    const redeliver = this.redeliver;
    const pass = (async (): Promise<string | null> => {
      try {
        const heard = this.redeliveredThrough ?? Date.parse((await lastGithubDelivery().catch(() => null))?.at ?? '');
        const since = Number.isNaN(heard) ? 0 : heard - REDELIVERY_SLACK_MS;
        const ids = await redeliver(since);
        if (ids === null) return null;
        this.redeliveredThrough = now;
        return ids.length > 0 ? `redelivered ${ids.length} webhook deliver${ids.length === 1 ? 'y' : 'ies'} GitHub recorded as failed` : null;
      } catch (error) {
        return `could not redeliver the webhook deliveries GitHub recorded as failed: ${error instanceof Error ? error.message : error}`;
      }
    })();
    this.redelivering = pass.finally(() => {
      this.redelivering = null;
    });
    return this.redelivering;
  }

  /** What the last run told a person, so the same thing is not said twice. */
  private lastAttention: string | null = null;
  /** So crossing the warning line notifies once, not on every budget run. */
  private lastBudgetState: string | null = null;
  /** Each job's run that has not finished, so a second firing joins it. */
  private readonly inFlight = new Map<string, Promise<JobResult>>();

  /**
   * Opens a QA task per repository, against the testing environment.
   *
   * The `qa` skill was written and the QA seat configured with it, and nothing ever
   * started one — so the journeys, the smoke suites and the readiness report
   * were unreachable. This is the thing that starts it.
   *
   * Nothing here decides *when*: the job is fired through
   * `POST /internal/schedule/qa`, and `JobTimer` is what fires it nightly. That
   * keeps "the QA bot can be started" separate from "something starts it on a
   * timer", which are different failures.
   *
   * The jobs were built first, to be fired by hand, and for a while nothing
   * fired them: the comment said a timer did, and none ran.
   *
   * A production promote opens the same task through the same two functions;
   * see `Webhooks.qaBeforePromote`.
   */
  private async runQa(): Promise<string[]> {
    // Without the rules, the install's one URL for every repository, as before.
    const shared = this.delivery ? null : await qaTarget(this.config.testingUrl);
    if (shared && 'refusal' in shared) return [shared.refusal];

    const actions: string[] = [];
    for (const repo of await repos.listRepos()) {
      // Each repository's own testing URL, by its rules; the install's
      // FLEETADLC_TESTING_URL where none says (deprecated, read in `delivery-rules.ts`).
      const target = shared ?? (await qaTarget((await this.delivery?.get(repo).catch(() => null))?.testingUrl ?? ''));
      if ('refusal' in target) {
        actions.push(`${repo.name}: ${target.refusal}`);
        continue;
      }
      const opened = await openQaRun(this.taskService, target, {
        repo: repo.name,
        subjectRef: `${repo.name}#testing`,
      });
      actions.push(opened.line);
    }
    return actions;
  }

  /**
   * Notices a credential aging out before a bot discovers it mid-task.
   *
   * A refresh token lasts six months and a task finds out it has gone by
   * failing at the end, where the work is. This is the job that asks first.
   *
   * The issue asks for anything in `reauth_needed`; there is no such status.
   * The states a credential actually has are `unauthorized`, `active`,
   * `expired` and `revoked`, so the check is over the two that mean a person has
   * to repeat the device flow, plus the refresh token running down.
   */
  private async checkCredentials(): Promise<string[]> {
    const actions: string[] = [];
    const crew = await bots.listBots();
    const failing: string[] = [];

    for (const bot of crew) {
      const credential = await credentials.getCredential(bot.id);
      if (!credential) continue;

      if (credential.status === 'expired' || credential.status === 'revoked') {
        failing.push(`${bot.name} is ${credential.status}`);
        continue;
      }

      const refreshExpiry = credential.refreshExpiresAt ? new Date(credential.refreshExpiresAt) : null;
      if (refreshExpiry && refreshExpiry.getTime() - Date.now() < CREDENTIAL_WARNING_MS) {
        const days = Math.max(0, Math.round((refreshExpiry.getTime() - Date.now()) / 86_400_000));
        failing.push(`${bot.name}'s refresh token expires in ${days} day(s)`);
      }
    }

    if (failing.length === 0) return ['every connected credential is current'];

    for (const line of failing) actions.push(line);

    // Filed where a person will see it, once. Firing this job hourly must not
    // produce an issue an hour.
    const opened = await this.fileOperatorIssue({
      title: 'Credentials need a person',
      body: [
        'These credentials will stop a task if nothing is done:',
        '',
        ...failing.map((line) => `- ${line}`),
        '',
        'Reconnect each with `fleetadlc auth login --bot <name>`.',
      ].join('\n'),
      marker: 'credential-health',
    });
    actions.push(opened);
    return actions;
  }

  /**
   * Files the dependency update as an issue rather than doing it.
   *
   * The issue goes to intake, as an alert's does, and triage shapes it for
   * Build: the sections the dispatcher routes on, an area, the repository's
   * actual manifests and lockfiles as Expected paths, and `start:now`
   * (crew/skills/triage/SKILL.md, for an issue the platform filed). It used to
   * be filed straight into Build with a one-line body that nothing could
   * route, and no bot staffs Build to add what is missing, so it sat there for
   * good. From there it is ordinary work: built, reviewed and landed by the
   * merge line. A job that updated dependencies itself would be a second path
   * to a change, which is the thing the platform does not have.
   */
  private async runDependencyUpdate(): Promise<string[]> {
    const actions: string[] = [];
    for (const repo of await repos.listRepos()) {
      actions.push(
        await this.fileOperatorIssue({
          title: 'Weekly dependency update',
          body: [
            `Update the dependency manifests and lockfiles of ${repo.fullName} to current versions.`,
            '',
            'Acceptance: `make ci` green, no major version taken without a note on why.',
          ].join('\n'),
          marker: 'dependency-update',
          labels: ['deps', 'adlc:intake', 'do:ai', 'priority:p3'],
          repoFullName: repo.fullName,
        }),
      );
    }
    return actions;
  }

  /**
   * Notices merged work that never reached testing.
   *
   * A merge webhook dispatches `deploy-testing` by the repository's rules
   * (`DeployPipeline.onMerged`), as the app or, where the app cannot act on the
   * repository, as the automation account; the workflow runs only when
   * dispatched. On an install without the pipeline, it starts the deploy bot
   * instead. The webhook can be missed, and this job does not invent a deploy:
   * it dispatches the same workflow. OpenADLC does not read
   * `FLEETADLC_DEPLOY_TESTING`. A repository set to no testing deploy — or
   * automatic, with no `deploy-testing` workflow — has nothing to run, so an
   * issue already in Ship is moved to Done here. That is what clears one left
   * behind after a merge, open or closed: GitHub closes the issue at
   * `Closes #N` before a deploy, and a repository that does have a testing
   * deploy is left in Ship for that reason.
   *
   * So the sweep looks, and then either says there is nothing to do, or
   * dispatches the testing deploy of the newest merge, when that merge has no
   * deploy dispatched. Older merges are never deployed on their own: see
   * `planDeploySweep`. Then it checks on the pipeline's rollbacks, soaks,
   * undispatched promotes and owed send-backs.
   *
   * Without a pipeline wired (a test, or a bridge built without one), the
   * older path stays as the fallback: it refuses while the install has no
   * testing URL, or starts the deploy bot's task, which a later firing finds
   * and does not start again, and a firing after it failed tries again, up to
   * `MAX_DEPLOY_ATTEMPTS`.
   */
  private async runDeploySweep(): Promise<string[]> {
    const board = await issues.listIssues();
    const found = awaitingTestingDeploy(board);
    // Every issue in Ship is asked about, not only those still waiting on a
    // testing deploy: one that reached testing before its repository was set
    // to no testing deploy has no promote coming either, and would sit there.
    const inShip = board
      .filter((issue) => issue.stage === 'merged')
      .map((issue) => ({ repo: issue.repoName, number: issue.number, prNumber: issue.prNumber }));
    const { waiting: kept, moved } = await this.shippedByMerging(inShip);
    const stays = new Set(kept.map((item) => `${item.repo}#${item.number}`));
    const waiting = found.filter((item) => stays.has(`${item.repo}#${item.number}`));
    // With the pipeline, the testing deploy is dispatched as the app (or the
    // automation account) by the repository's rules, and what was dispatched is `deploy_runs`; without
    // it, the deploy bot's tasks, against the install's testing URL, as before.
    const deployBot = this.pipeline ? null : ((await bots.listBots()).find((bot) => bot.role === 'deploy') ?? null);
    const priorDeploys = this.pipeline
      ? await this.dispatchedDeploys(waiting)
      : await tasks.listTasksForSubjects(
          'deploy',
          waiting.flatMap((item) => (item.prNumber ? [`${item.repo}#${item.prNumber}`] : [])),
        );
    const testingUrl = this.pipeline ? 'the repository’s rules' : this.config.testingUrl;
    const dispatcher = this.pipeline ? 'the OpenADLC app' : (deployBot?.name ?? null);
    // The tip of the default branch is asked only when a deploy could start,
    // so an install with no testing target costs nothing but the board read.
    // Whether the repository ships by merging was already asked, above.
    const couldStart = waiting.length > 0 && testingUrl.trim().length > 0 && dispatcher !== null;
    const newest = couldStart ? await this.newestMerges([...new Set(waiting.map((item) => item.repo))]) : {};
    const plan = planDeploySweep({
      waiting,
      testingUrl,
      deployBot: dispatcher,
      newest,
      priorDeploys,
    });

    const actions: string[] = [...moved];
    const refusal = deploySweepRefusal(plan);
    if (refusal) {
      actions.push(refusal);
    } else if (plan.kind === 'work') {
      actions.push(...plan.hold);
      const item = plan.start;
      if (item && this.pipeline) {
        actions.push(await this.dispatchTesting(item.repo, item.subjectRef));
      } else if (item) {
        try {
          const started = await this.taskService.open({
            bot: deployBot?.name ?? '',
            repo: item.repo,
            kind: 'deploy',
            subjectType: 'merge',
            subjectRef: item.subjectRef,
            skill: 'deploy',
          });
          actions.push(
            started.error
              ? `${item.subjectRef}: ${started.error.slice(0, 120)}`
              : `started a testing deploy of ${item.subjectRef} against ${this.config.testingUrl} (task ${started.taskId})${item.retry ? `: ${item.retry}` : ''}`,
          );
        } catch (error) {
          // Nothing was recorded, so this is not an attempt: a busy deploy bot
          // is not a failed deploy, and the next firing tries again. A deploy
          // hostd refused is different — its task is saved as failed, and
          // counts towards MAX_DEPLOY_ATTEMPTS.
          actions.push(`${item.subjectRef}: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`);
        }
      }
    }

    // A rollback dispatched: how its run ended, first, so a promote it held
    // goes in this sweep, and one cancelled or never started is dispatched
    // again below.
    if (this.pipeline) actions.push(...(await this.pipeline.checkRollbacks().catch(() => [])));
    // A soak the bridge holds, for a repository whose plan keeps no wait timer.
    if (this.pipeline) actions.push(...(await this.pipeline.promoteDue().catch(() => [])));
    // A promote or rollback whose dispatch GitHub refused or did not answer.
    if (this.pipeline) actions.push(...(await this.pipeline.retryUndispatched().catch(() => [])));
    // A change a failed smoke or production deploy owes a send-back, given back
    // when GitHub could not be asked.
    if (this.pipeline) actions.push(...(await this.pipeline.sendBackDue().catch(() => [])));

    // The event log says the job ran. This says what it decided, including the
    // run that deployed nothing, which is the one a person has to be able to
    // tell from a job that never fired.
    await audit({
      actor: 'schedule',
      action: 'deploy.sweep',
      target: 'testing',
      payload: {
        waiting: found.length,
        testingTarget: testingUrl.trim().length > 0,
        actions,
      },
    }).catch(() => undefined);

    return actions;
  }

  /**
   * Issues in Ship that have nothing to deploy, moved to Done, and the rest.
   *
   * A repository that ships by merging is not given a deploy task. An explicit
   * "no testing deploy" does not ask GitHub; automatic does, and a failed ask
   * is not taken as a yes — those issues stay in Ship. "Has a testing deploy"
   * stays on the deploy path and is not asked either.
   */
  private async shippedByMerging(found: readonly AwaitingDeploy[]): Promise<{ waiting: AwaitingDeploy[]; moved: string[] }> {
    const raw = await settings.getSetting('testingDeploy').catch(() => null);
    const byRepo = new Map<string, boolean>();
    for (const repoName of new Set(found.map((item) => item.repo))) {
      // By the repository's rules where they are read here.
      const repo = this.delivery ? await repos.getRepoByName(repoName).catch(() => null) : null;
      // Rules that could not be read are only a fallback, and not taken as a yes.
      const delivery = this.delivery && repo ? await this.delivery.get(repo) : null;
      const answer = delivery
        ? !delivery.readError && delivery.rules.testing.on === 'none'
        : await this.repoShipsByMerging(repoName, testingDeployChoice(raw, repoName));
      byRepo.set(repoName, answer === true);
    }
    const waiting: AwaitingDeploy[] = [];
    const moved: string[] = [];
    for (const item of found) {
      if (!byRepo.get(item.repo)) {
        waiting.push(item);
        continue;
      }
      const line = `${item.repo}#${item.number} moved to Done: no testing deploy for this repository`;
      try {
        const result = await this.automation.moveStage({
          repoName: item.repo,
          issueNumber: item.number,
          to: 'done',
          actor: 'bridge',
        });
        moved.push(result.moved ? line : `${item.repo}#${item.number}: not moved to Done (${result.reason ?? 'the move was refused'})`);
      } catch (error) {
        moved.push(`${item.repo}#${item.number}: not moved to Done (${error instanceof Error ? error.message.slice(0, 120) : String(error)})`);
      }
    }
    return { waiting, moved };
  }

  /** True when this repository ships by merging; null when automatic could not be asked. */
  private async repoShipsByMerging(repoName: string, choice: TestingDeployChoice): Promise<boolean | null> {
    if (choice !== 'automatic') return shipsByMerging(null, '', choice);
    const repo = await repos.getRepoByName(repoName);
    if (!repo) return null;
    const client = await asAutomation(this.automation['actors'], this.config).catch(() => null);
    return shipsByMerging(client, repo.fullName, 'automatic');
  }

  /** The testing deploys the pipeline dispatched for these pull requests, as the sweep's plan weighs prior deploys. */
  private async dispatchedDeploys(waiting: readonly AwaitingDeploy[]): Promise<PriorDeploy[]> {
    const prior: PriorDeploy[] = [];
    for (const name of new Set(waiting.map((item) => item.repo))) {
      const repo = await repos.getRepoByName(name);
      if (!repo) continue;
      const numbers = waiting.filter((item) => item.repo === name && item.prNumber).map((item) => item.prNumber as number);
      for (const run of await deployRuns.forPullRequests(repo.id, numbers).catch(() => [])) {
        if (run.testingDispatchedAt) prior.push({ subjectRef: `${name}#${run.prNumber}`, state: 'running' });
      }
    }
    return prior;
  }

  /** Dispatches the testing deploy of a pull request's merge commit, through the pipeline. */
  private async dispatchTesting(repoName: string, subjectRef: string): Promise<string> {
    // Each cause on its own: "could not be dispatched from here" stood for
    // all four, and said nothing a person could act on.
    const repo = await repos.getRepoByName(repoName);
    if (!repo) return `${subjectRef}: no testing deploy was dispatched, because OpenADLC does not manage ${repoName} any more`;
    if (!this.pipeline) return `${subjectRef}: no testing deploy was dispatched, because this bridge has no deploy pipeline to dispatch it with`;
    const prNumber = Number(subjectRef.split('#')[1] ?? '');
    if (!Number.isInteger(prNumber) || prNumber <= 0) return `${subjectRef}: no testing deploy was dispatched, because it names no pull request`;
    const client = await asAutomation(this.automation['actors'], this.config).catch(() => null);
    if (!client) {
      const name = await automationBotName(this.config);
      return `${subjectRef}: no testing deploy was dispatched, because ${name} is not connected to GitHub. Run: fleetadlc auth login --bot ${name}`;
    }
    const merged = await client
      .request<{ merge_commit_sha?: string | null }>('GET', `/repos/${repo.fullName}/pulls/${prNumber}`)
      .then((pull) => pull.merge_commit_sha ?? null)
      .catch(() => null);
    if (!merged) return `${subjectRef}: its merge commit could not be read, so no testing deploy was dispatched`;
    return this.pipeline.deployTesting(repo, merged, prNumber).catch((error: unknown) => `${subjectRef}: ${error instanceof Error ? error.message : String(error)}`);
  }

  /**
   * The pull request each repository's default branch is at, by name.
   *
   * The board has no merge time, and a pull request's number says when it was
   * opened, not when it landed, so the tip of the default branch is the one
   * answer that cannot be out of order. Null when there is no account to ask
   * with, GitHub did not answer, or the tip came from no pull request — and the
   * plan deploys nothing it cannot place.
   */
  private async newestMerges(repoNames: readonly string[]): Promise<Record<string, number | null>> {
    const client = await asAutomation(this.automation['actors'], this.config);
    const newest: Record<string, number | null> = {};
    for (const name of repoNames) {
      const repo = await repos.getRepoByName(name);
      if (!client || !repo) {
        newest[name] = null;
        continue;
      }
      const pulls = await client
        .request<{ object: { sha: string } }>('GET', `/repos/${repo.fullName}/git/ref/heads/${repo.defaultBranch}`)
        .then((tip) => client.listPullsForCommit(repo.fullName, tip.object.sha))
        .catch(() => []);
      newest[name] = pulls[0]?.number ?? null;
    }
    return newest;
  }

  /**
   * Opens an issue unless one this job filed is already open.
   *
   * The marker is what makes every job here safe to fire twice, which is the
   * difference between a schedule and a nuisance.
   */
  private async fileOperatorIssue(input: {
    title: string;
    body: string;
    marker: string;
    labels?: string[];
    repoFullName?: string;
  }): Promise<string> {
    const client = await asAutomation(this.automation['actors'], this.config);
    const target = input.repoFullName ?? (await repos.listRepos())[0]?.fullName;
    if (!client || !target) {
      // Without a connected account there is nowhere to file. Saying so beats
      // failing the job, because the finding above is still worth reporting.
      if (!target) return `would file "${input.title}" (OpenADLC manages no repository to file it in)`;
      const name = await automationBotName(this.config);
      return `would file "${input.title}" (${name} is not connected to GitHub. Run: fleetadlc auth login --bot ${name})`;
    }

    const marker = dedupeMarker('job', input.marker);
    // Only what this account filed, every page of it (`findOwnOpenIssue`).
    let existing: number | null;
    try {
      const login = (await client.viewer()).login;
      existing = await findOwnOpenIssue(client, target, login, 'job', input.marker);
    } catch {
      // Unread is not none open: filing now could be the duplicate this check is for.
      return `${input.title}: not filed, because the open issues of ${target} could not be read`;
    }
    if (existing) return `${input.title}: already open as #${existing}`;

    // GitHub's own refusal, its status and first line: "could not be filed"
    // alone left nobody able to tell a missing label from a lost sign-in.
    const created = await client
      .request<{ number: number }>('POST', `/repos/${target}/issues`, {
        title: input.title,
        body: `${input.body}\n\n${marker}`,
        labels: input.labels ?? [],
      })
      .catch((error: unknown) => ({ refused: refusalOf(error) }));
    return 'number' in created ? `${input.title}: filed as #${created.number}` : `${input.title}: could not be filed in ${target}: ${created.refused}`;
  }

  /**
   * Runs a job, or answers with the run of it that is already going.
   *
   * The timer and `POST /internal/schedule/:job` both fire jobs, and a slow run
   * can outlast its own interval. Two deploy sweeps reading the board at once
   * would each find no deploy task and each start one, so a second firing
   * waits for the first and returns what it did.
   */
  run(job: string): Promise<JobResult> {
    const running = this.inFlight.get(job);
    if (running) return running;
    const run = this.runOnce(job).finally(() => this.inFlight.delete(job));
    this.inFlight.set(job, run);
    return run;
  }

  private async runOnce(job: string): Promise<JobResult> {
    const result = await this.dispatch(job);
    // Recorded so `fleetadlc status` can say when each job last ran. A schedule
    // nobody can see the last run of is a schedule nobody knows has stopped.
    if (SCHEDULED_JOBS.includes(job as (typeof SCHEDULED_JOBS)[number])) {
      await recordEvent({
        source: 'schedule',
        type: `job.${job}`,
        payload: {
          actions: result.actions.length,
          // What the deploy sweep decided, so a firing that deployed nothing
          // can be told from one that never ran. Only that job, and bounded:
          // reconcile says its lines every quarter hour, and a board with many
          // merges waiting makes long ones.
          ...(job === 'deploy' ? { detail: result.actions.slice(0, 20).map((line) => line.slice(0, 300)) } : {}),
        },
      }).catch(() => undefined);
    }
    return result;
  }

  private async dispatch(job: string): Promise<JobResult> {
    switch (job) {
      case 'reconcile':
        return { job, actions: await this.reconcile() };
      case 'status':
        return { job, actions: await this.refreshStatus() };
      case 'budget':
        return { job, actions: await this.refreshBudget() };
      case 'stages':
        return { job, actions: await this.stages.sweep() };
      case 'merge': {
        // Before the gates, so a review run again is under way when the gate
        // looks for one, and is not started a second time beside it.
        const recovered = this.recovery
          ? await retryAfterRecovery(null, { ...this.recovery, costs: this.config.costs }).catch((error: unknown) => [
              `could not run failed tasks again: ${error instanceof Error ? error.message : error}`,
            ])
          : [];
        // A build that ended without opening its pull request, continued on
        // its branch or failed; see `continueBuilds`.
        const continued = await this.continueBuilds();
        const stacked = this.stacking
          ? await this.stacking.sweep().catch((error: unknown) => [`could not stack work: ${error instanceof Error ? error.message : error}`])
          : [];
        // A task answered while every host was full, whose retry a restart
        // lost; see `TaskService.resumeAnswered`.
        const resumed = await this.taskService.resumeAnswered().catch((error: unknown) => [
          `could not resume answered tasks: ${error instanceof Error ? error.message : error}`,
        ]);
        const settled = await this.settleGates().catch((error: unknown) => [
          `could not settle the review gates: ${error instanceof Error ? error.message : error}`,
        ]);
        const merged = [...recovered, ...continued, ...stacked, ...resumed, ...settled, ...(await this.mergeLine.advanceAll())];
        // The plan has the status view regenerate on a merge, not only on the
        // clock: a board that is a quarter of an hour stale after something
        // landed is the moment it is most looked at.
        const refreshed = merged.some((line) => line.includes('merged')) ? await this.refreshStatus() : [];
        return { job, actions: [...merged, ...refreshed] };
      }
      case 'qa':
        return { job, actions: await this.runQa() };
      case 'credentials':
        return { job, actions: await this.checkCredentials() };
      case 'deps':
        return { job, actions: await this.runDependencyUpdate() };
      case 'deploy':
        return { job, actions: await this.runDeploySweep() };
      case 'engines':
        // Looks every few minutes, runs once a week: whether this week's
        // slot has passed and not run is the job's question, so a laptop
        // asleep at the hour runs it when it wakes.
        return {
          job,
          actions: this.engineUpdates ? await this.engineUpdates.tick() : ['engine updates are not wired into this bridge'],
        };
      case 'attachments':
        return { job, actions: await this.sweepAttachments() };
      case 'events':
        return { job, actions: await this.pruneEvents() };
      default:
        return { job, actions: [`no job named ${job}`] };
    }
  }

  /**
   * Removes uploads nobody sent with a request or a message within a day. A
   * file is uploaded before what it goes with is sent, so a dialog closed
   * half-way leaves one behind, and its bytes are in the database.
   */
  private async sweepAttachments(): Promise<string[]> {
    const swept = await attachments.sweepUnclaimed(claimWindowStart());
    return swept > 0 ? [`removed ${swept} upload${swept === 1 ? '' : 's'} nobody sent with anything within a day`] : [];
  }

  /**
   * Removes the processed GitHub deliveries older than
   * `FLEETADLC_EVENT_RETENTION_DAYS`. Nothing deleted them before, so every
   * payload stayed in the database and its backups for good. 0 keeps them.
   */
  private async pruneEvents(): Promise<string[]> {
    const days = this.config.eventRetentionDays;
    if (days === 0) return ['GitHub deliveries are kept for good (FLEETADLC_EVENT_RETENTION_DAYS=0)'];
    const removed = await pruneGithubDeliveries(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
    return removed > 0 ? [`removed ${removed} GitHub ${removed === 1 ? 'delivery' : 'deliveries'} older than ${days} days`] : [];
  }

  /**
   * Compares what the platform believes against what GitHub says, repairs what it
   * safely can, and reports the rest where a person will see it.
   */
  private async reconcile(): Promise<string[]> {
    const actions: string[] = [];

    // Named by repository: with several, `issue #12` alone says nothing.
    const expired = await leases.expireStaleLeases();
    if (expired.length > 0) {
      const repoNames = new Map((await repos.listRepos().catch(() => [])).map((repo) => [repo.id, repo.name]));
      for (const lease of expired) {
        actions.push(`expired the lease on ${repoNames.get(lease.repoId) ?? 'issue'}#${lease.issueNumber}: it ran out with no pull request`);
      }
    }

    const drift = await this.reconciler.run({ repair: true });
    for (const entry of drift) actions.push(driftLine(entry));

    const needsPerson = drift.filter((entry) => !entry.repaired);
    if (needsPerson.length > 0) {
      const target = statusIssueTarget(process.env.FLEETADLC_STATUS_ISSUE, await repos.listRepos());
      if (target && 'refusal' in target) {
        actions.push(`did not post the drift to the status issue: ${target.refusal}`);
      } else if (target) {
        // Only the issue's own repository's drift: the others may be private.
        const { entries, others } = statusDrift(drift, target);
        const body = [
          ...(entries.length > 0 ? [renderDrift(entries)] : []),
          ...(others > 0 ? [`${others} more need a person in other repositories or on the install; the console lists them.`] : []),
        ].join('\n\n');
        await this.automation
          .comment(target.repo, target.number, `### Reconciliation\n\n${body}`)
          .catch(() => undefined);
      }
    }

    if (drift.length === 0) actions.push('nothing has drifted: the board matches GitHub');

    // A delivery GitHub could not make while the bridge was down: a gate
    // answered on GitHub then is taken now.
    const redelivered = await this.redeliverFailed();
    if (redelivered) actions.push(redelivered);

    // Design memory a delivery missed: proposals on issues past design, and
    // the ADR a merged decision was written in.
    actions.push(
      ...(await sweepDesignMemory().catch((error: unknown) => [`could not sweep the design memory: ${error instanceof Error ? error.message : error}`])),
    );

    // The crew's own access drifts too: a repository added since, an
    // invitation a bot could not accept until it connected. What is already
    // right is left alone, so this says only what changed.
    if (this.crewAccess) {
      const access = await this.crewAccess
        .ensureAll('reconcile')
        .catch((error: unknown) => [`could not check the crew's access: ${error instanceof Error ? error.message : error}`]);
      actions.push(...access);
    }

    // The branch each repository's tasks start from and its merges land on:
    // one added before GitHub was asked, or renamed on GitHub since. Says only
    // what it changed.
    if (this.defaultBranches) {
      actions.push(
        ...(await this.defaultBranches().catch((error: unknown) => [`could not check the repositories' default branches: ${error instanceof Error ? error.message : error}`])),
      );
    }

    // An issue a person filed that OpenADLC never looked at: the oldest in
    // each repository goes to intake (`unlabeled-intake.ts`).
    if (this.unlabeled) {
      actions.push(
        ...(await this.unlabeled.sweepOnce().catch((error: unknown) => [`could not send unlabeled issues to intake: ${error instanceof Error ? error.message : error}`])),
      );
    }
    return actions;
  }

  private async refreshStatus(): Promise<string[]> {
    const status = await buildStatus(this.config, this.hostd);
    const target = statusIssueTarget(process.env.FLEETADLC_STATUS_ISSUE, await repos.listRepos());

    if (!target) {
      return ['status rebuilt (no status issue configured)'];
    }
    if ('refusal' in target) {
      return [`status rebuilt, and no status issue written: ${target.refusal}`];
    }

    const actions: string[] = [];
    const edited = await this.automation.updateStatusIssue(target.repo, target.number, renderStatusMarkdown(status, target));
    actions.push(
      edited
        ? `rewrote the status issue in ${target.repo}`
        : `could not rewrite the status issue in ${target.repo}`,
    );

    // A comment is a notification. One is worth sending when something needs a
    // person and nothing has already told them; sending one every quarter hour
    // is how a notification stops meaning anything.
    const attention = attentionIn(status);
    if (attention && attention !== this.lastAttention) {
      await this.automation.comment(target.repo, target.number, `**${attention}**`);
      actions.push(`said so in a comment: ${attention}`);
    }
    this.lastAttention = attention;

    return actions;
  }

  private async refreshBudget(): Promise<string[]> {
    const period = costs.currentPeriod();
    // First start copies the file in. A later start leaves a saved cap alone;
    // ensureBudget then reads that cap rather than the file.
    await spendingLimits.seedGlobal(this.config.costs.monthlyCapUsd, this.config.costs.perTaskCapUsd);
    const budget = await costs.ensureBudget(period, this.config.costs.monthlyCapUsd, this.config.costs.warningAt);
    const crew = await bots.listBots();

    if (budget.state === 'stopped') {
      return [`month-to-date spend reached the $${budget.capUsd} cap; leasing is stopped for ${crew.length} bot${crew.length === 1 ? '' : 's'}`];
    }
    if (budget.state === 'warning') {
      const line = `spend is at ${Math.round((budget.spentUsd / budget.capUsd) * 100)}% of the monthly cap`;
      // One of the notifiable events (`cap_warning`; see `NOTIFIABLE` in
      // notify.ts). The board shows the number all the time; this is for the
      // moment it becomes worth a decision.
      if (this.lastBudgetState !== 'warning') {
        await this.notifier?.send({
          event: 'cap_warning',
          to: null,
          text: `${line} ($${budget.spentUsd.toFixed(2)} of $${budget.capUsd.toFixed(0)}).`,
          link: `${this.config.consoleUrl.replace(/\/+$/, '')}/costs`,
        });
      }
      this.lastBudgetState = budget.state;
      return [line];
    }
    this.lastBudgetState = budget.state;
    return [`spend is $${budget.spentUsd.toFixed(2)} of $${budget.capUsd.toFixed(2)}`];
  }
}

/** GitHub's status and the first line of what it said, for a job's output line. */
function refusalOf(error: unknown): string {
  const status = (error as { status?: unknown } | null)?.status;
  const said = (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 200);
  return typeof status === 'number' && !said.includes(String(status)) ? `GitHub answered ${status}: ${said}` : said;
}
