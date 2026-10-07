import { audit, bots, issues, leases, repos, requests, spendingLimits, tasks } from '@fleetadlc/db';
import { botAtStart, envInt, type TaskKind, type TaskState } from '@fleetadlc/shared';
import type { Started } from './build-start.js';
import { continuesBranch, type BranchFacts } from './build-left.js';
import { requestPrefixOf } from './request-context.js';
import { resolutionRetry } from './conflict-round.js';
import { HttpFailure } from './router.js';
import { endsWithSubject } from './gates.js';
import { RECOVERY_ACTOR } from './scheduler.js';
import { BotBusyError, PrerequisiteNotReadyError, isRevert, type TaskService } from './task-service.js';
import { issueNumberFromBranch } from './webhooks.js';
import { parseRef } from './work.js';

/** The skill each kind of task runs, for a row that did not record one. */
const SKILL: Record<TaskKind, string> = {
  intake: 'triage',
  request: 'triage',
  spec: 'spec',
  implement: 'implement',
  patch: 'implement',
  review: 'pr-review',
  deploy: 'deploy',
  qa: 'qa',
};

const ACTIVE: readonly TaskState[] = ['queued', 'running', 'paused'];

export interface RetryDeps {
  /**
   * Why nothing new may start now (work paused, a restore), or null; about a
   * repository, its own pause as well. See `pause-work.ts`.
   */
  paused?: (repo?: string | null) => string | null;
  taskService: Pick<TaskService, 'open'>;
  /** A build, started the way the dispatcher's lease starts one. See `build-start.ts`. */
  startBuild(input: {
    leaseId: string;
    repo: { name: string; fullName: string };
    issue: number;
    bot: { id: string; name: string };
    declaredPaths: string[];
    expiresAt: string | null;
    continueBranch?: string | null;
  }): Promise<Started>;
  /**
   * A console request's triage, started the way `POST /v1/requests/:id/triage`
   * starts it: now, or when its turn in the queue comes.
   */
  startTriage(requestId: string): Promise<{ task: Started | null; bot: string } | { queued: true; position: number | null; bot: string }>;
  /** How long a lease taken for a build run again holds its issue. */
  leaseHours?: number;
  /**
   * Every file a pull request changes, as GitHub lists it. A patch round run
   * again may write them, as a fresh one may (`Webhooks.onReview`). Absent, or
   * failing, the round gets the lease's paths alone.
   */
  pullFiles?(repoFullName: string, prNumber: number): Promise<string[]>;
  /**
   * Whether GitHub says an issue or pull request is closed. Absent, or
   * failing, nothing is refused for it.
   */
  subjectClosed?(repoFullName: string, number: number): Promise<boolean>;
  /**
   * What GitHub says of a build's branch (`readBranch`), asked before going
   * on from a build that ended `done`: a pull request opened without
   * `Closes #n` is not on the issue's row. Absent, or null, the row decides.
   */
  branchOf?(repoFullName: string, branch: string, base: string): Promise<BranchFacts | null>;
}

export interface Retried {
  /** The task that failed or was stopped, or the build that ended without its pull request. */
  retried: string;
  /** Null while a request's triage waits its turn for intake, or was started by another bridge. */
  task: Started | null;
  bot: string;
  /** A request's triage tried again while intake is busy: waiting in line, at this place. */
  queued?: true;
  position?: number | null;
}

/**
 * Runs a failed or stopped task again: the same kind of work, by the same bot,
 * on the same subject — a review is reviewed again, a build is leased and
 * built again, a console request is triaged again.
 *
 * Refused when the same work is already going, and when the bot is busy with
 * something else: one running task per container is the collision guarantee.
 * The card the failure put on the board goes as soon as the new task exists,
 * because a later task of the same kind on the same subject is what "tried
 * again" means there.
 *
 * `byAdmin` is an admin's Try again from the card. A revert after a red
 * smoke test run again that way starts past a monthly cap, audited under
 * their name (`CapBypass`): they have looked at it, and spending past a cap
 * is theirs to decide. A user's Try again runs the revert too, but it waits
 * for the cap like anything else, since a user may not change what the
 * install spends (`roles.ts`). The recovery's automatic retry does not pass
 * it either — except for the revert a red smoke authorised past the cap
 * that was recorded without starting (`spendingLimits.holdRevert`). That
 * authorisation was never spent, and the recovery's retry of the task it is
 * held for spends it (`spendingLimits.spendHeldRevert`): held by the cap
 * there, a broken testing deploy stayed live until an admin pressed Try
 * again. Spent once, a later retry of the same task has nothing to spend,
 * and a retry recorded without starting again leaves it spent: the recovery
 * never runs the task it started again, and an admin's Try again starts it.
 */
export async function retryTask(taskId: string, actor: string, deps: RetryDeps, options: { byAdmin?: boolean } = {}): Promise<Retried> {
  // Running it again is new work, which a pause stops like any other.
  const paused = deps.paused?.();
  if (paused) throw new HttpFailure(409, `nothing new starts: ${paused}`);
  const task = await tasks.getTask(taskId);
  if (!task) throw new HttpFailure(404, 'there is no such task');
  // A build that ended `done` without opening its pull request is not
  // finished, whatever its state says: Try again, a person's comment
  // and the sweep after it ended all go on from its branch. Whether it has a
  // pull request after all is asked below, with the issue.
  const continuing = continuesBranch(task);
  if (task.state !== 'failed' && task.state !== 'stopped' && !continuing) {
    throw new HttpFailure(409, `that task is ${task.state}, so there is nothing to run again`);
  }
  const bot = await bots.getBotById(task.botId);
  if (!bot) throw new HttpFailure(404, 'the bot that ran it is no longer in the crew');

  const onSubject = await tasks.listTasksOnSubjects([task.subjectRef]);
  const going = onSubject.find(
    (other) =>
      other.id !== task.id &&
      ACTIVE.includes(other.state) &&
      other.kind === task.kind &&
      (task.kind !== 'review' || other.botId === task.botId),
  );
  if (going) throw new HttpFailure(409, 'it is already running again');
  // A later build of the issue took over from this one, whether it is still
  // going or not: going on from this one's branch would undo what it did.
  if (
    task.state === 'done' &&
    onSubject.some(
      (other) => other.id !== task.id && other.kind === task.kind && Date.parse(other.createdAt) > Date.parse(task.createdAt),
    )
  ) {
    throw new HttpFailure(409, 'a later build of the issue has run since, so there is nothing to go on from here');
  }
  const prefix = requestPrefixOf(task.subjectRef);
  // A request's triage waits its turn for a busy intake (`request-queue.ts`);
  // anything else is refused while its bot runs all it may at once.
  if (!prefix && !(await tasks.seatHasRoom(bot.id))) {
    throw new HttpFailure(
      409,
      `${botAtStart(bot)} is running all the tasks it may at once; try again once one is done, or raise its tasks at once on the Crew page`,
    );
  }

  let started: Started | null;
  let queued: { position: number | null } | null = null;
  if (prefix) {
    const request = await requests.findRequestByPrefix(prefix).catch(() => null);
    if (!request) throw new HttpFailure(404, 'the request it was triaging is gone');
    const result = await deps.startTriage(request.id);
    if ('queued' in result && result.queued) {
      started = null;
      queued = { position: result.position };
    } else {
      started = 'task' in result ? result.task : null;
    }
  } else {
    const parsed = parseRef(task.subjectRef);
    const repo =
      (task.repoId ? (await repos.listRepos()).find((one) => one.id === task.repoId) : undefined) ??
      (parsed ? await repos.getRepoByName(parsed.repo) : null);
    if (!repo) throw new HttpFailure(404, 'the repository it was working in is not managed here any more');
    // Work in a repository a person paused is new work there, whether a
    // person pressed Try again or a check that passed asked for it: refused,
    // the recovery gives its claim back and comes again after the resume.
    const held = deps.paused?.(repo.name);
    if (held) throw new HttpFailure(409, `nothing new starts: ${held}`);

    // Work whose issue or pull request has closed is finished: a reviewer
    // run again on a merged pull request fails with "not a branch of", and
    // the recovery ran such work again whenever a sign-in came back.
    if (parsed && endsWithSubject(task) && (await deps.subjectClosed?.(repo.fullName, parsed.number).catch(() => false))) {
      throw new HttpFailure(409, `already landed: ${task.subjectRef} is closed, so there is nothing to run again`);
    }

    if (task.kind === 'implement') {
      if (!parsed) throw new HttpFailure(400, `${task.subjectRef} is not an issue`);
      const issue = await issues.getIssue(repo.id, parsed.number);
      if (issue?.prNumber) {
        throw new HttpFailure(409, `#${parsed.number} has a pull request now, so its review is where the work goes on`);
      }
      if (continuing && task.state === 'done' && task.branch) {
        const branch = await deps.branchOf?.(repo.fullName, task.branch, repo.defaultBranch).catch(() => null);
        if (branch?.pullRequest) {
          throw new HttpFailure(409, `${task.branch} has pull request #${branch.pullRequest}, so its review is where the work goes on`);
        }
      }
      let lease = await leases.getActiveLease(repo.id, parsed.number);
      if (lease && lease.botId !== bot.id) {
        const holder = (await bots.getBotById(lease.botId))?.name ?? 'another bot';
        throw new HttpFailure(409, `${holder} holds #${parsed.number} now`);
      }
      const taken = !lease;
      lease ??= await leases.createLease({
        repoId: repo.id,
        issueNumber: parsed.number,
        botId: bot.id,
        declaredPaths: issue?.declaredPaths ?? [],
        expiresAt: new Date(Date.now() + (deps.leaseHours ?? envInt('FLEETADLC_LEASE_HOURS', 12)) * 3600 * 1000),
      });
      started = await deps.startBuild({
        leaseId: lease.id,
        repo,
        issue: parsed.number,
        bot,
        declaredPaths: lease.declaredPaths,
        expiresAt: lease.expiresAt,
        ...(continuing ? { continueBranch: task.branch } : {}),
      });
      // A lease taken for a build that did not start holds nothing.
      if (started.error && taken) await leases.setLeaseState(lease.id, 'released').catch(() => undefined);
      // A continuation is the second try the sweep gives a build, and is not
      // continued again by it: one that also ends without its pull request is
      // a card for a person (`continueBuildsWithoutPullRequest`).
      if (continuing && !started.error) await tasks.claimAutoRetry(started.taskId).catch(() => false);
    } else {
      const onBranch = task.subjectType === 'pr';
      const lease = task.leaseId ? await leases.getLease(task.leaseId).catch(() => null) : null;
      const leaseHeld = lease && ['leased', 'in_task', 'paused'].includes(lease.state);
      // What a patch round may write: the lease's paths and every file the
      // pull request already changes, as when the review opened it. Run again
      // with the lease alone, the round could write only tests and docs, and
      // asked for the very files the review was about (found live).
      // A conflict resolution round is the exception: run again with every
      // file and no brief, it was a patch round of its own, free to rework the
      // change it was only meant to merge the base into.
      const resolution =
        task.kind === 'patch' && onBranch && parsed && task.skill === 'resolve-conflict'
          ? await resolutionRetry(repo.name, parsed.number, repo.defaultBranch)
          : null;
      const declaredPaths = resolution
        ? resolution.files
        : task.kind === 'patch' && onBranch && parsed
          ? await patchPaths(leaseHeld ? lease.declaredPaths : [], repo.fullName, parsed.number, deps)
          : undefined;
      const held = options.byAdmin ? false : await spendHold(task, actor);
      const bypass =
        options.byAdmin && isRevert(task)
          ? { bypassCap: { by: actor, why: 'an admin ran the revert again' } }
          : // The bridge's authorisation, as when the red smoke asked (`CapBypass`).
            held
            ? { bypassCap: { by: 'bridge', why: 'the first revert of a commit, run again once it could start' } }
            : {};
      started = await deps.taskService
        .open({
        bot: bot.name,
        botId: bot.id,
        repo: repo.name,
        kind: task.kind,
        subjectType: task.subjectType,
        subjectRef: task.subjectRef,
        skill: task.skill ?? SKILL[task.kind],
        branch: task.branch,
        ...(onBranch ? { issueNumber: issueNumberFromBranch(task.branch ?? ''), checkoutExistingBranch: true } : {}),
        ...(leaseHeld ? { leaseId: lease.id } : {}),
        ...(declaredPaths ? { declaredPaths } : {}),
        ...(resolution ? { extraContext: [resolution.brief] } : {}),
        round: task.round,
        ...bypass,
        })
        .catch(async (error: unknown) => {
          // Refused before anything was recorded: this task is still the one
          // the recovery comes back for, so the authorisation stays with it.
          if (held && (error instanceof BotBusyError || error instanceof PrerequisiteNotReadyError)) {
            const why = await spendingLimits
              .holdRevert(task.subjectRef, task.id, task.id)
              .then((holds) => (holds ? null : 'it was not spent on this task'))
              .catch((holdError: unknown) => (holdError instanceof Error ? holdError.message : String(holdError)));
            if (why) console.warn(`[bridge] ${task.subjectRef}: the revert's authorisation past a cap was not held again for ${task.id}, so it is spent: ${why}`);
          }
          throw error;
        });
      // Recorded without starting again, the retry spent the authorisation
      // all the same. It is not held for the new task: the recovery claims
      // the task it started (`retryAfterRecovery`, `claimAutoRetry`) and never
      // comes back for it, so a hold there would be stranded. An admin's Try
      // again is what starts that revert past the cap.
    }
  }

  await audit({
    actor,
    action: 'task.retried',
    target: task.subjectRef,
    payload: {
      retried: task.id,
      task: started?.taskId ?? null,
      bot: bot.name,
      kind: task.kind,
      ...(started?.error ? { error: started.error } : {}),
      ...(queued ? { queued: true, position: queued.position } : {}),
    },
  });
  return { retried: task.id, task: started, bot: bot.name, ...(queued ? { queued: true as const, position: queued.position } : {}) };
}

/** The lease's paths and every file the pull request changes, once each. */
async function patchPaths(leasePaths: readonly string[], repoFullName: string, prNumber: number, deps: RetryDeps): Promise<string[]> {
  const inDiff = await (deps.pullFiles?.(repoFullName, prNumber) ?? Promise.resolve([])).catch((error: unknown) => {
    console.warn(
      `[bridge] ${repoFullName}#${prNumber}: its files could not be read, so the patch round run again may write only its lease's paths: ${error instanceof Error ? error.message : error}`,
    );
    return [] as string[];
  });
  return [...new Set([...leasePaths, ...inDiff])];
}

/**
 * Spends the authorisation a red smoke's revert holds past a monthly cap,
 * when the recovery's automatic retry runs the task it is held for, and says
 * whether it did. Only that retry may: a user's Try again waits for the cap,
 * and an admin's passes it on its own (`byAdmin`). Spent under the commit's
 * lock, so two retries of the task at once cannot both start past the cap,
 * and a failed write is no authorisation, so it fails closed.
 */
async function spendHold(task: { id: string; kind: TaskKind; subjectType: string; subjectRef: string; branch?: string | null }, actor: string): Promise<boolean> {
  if (actor !== RECOVERY_ACTOR || !isRevert(task)) return false;
  return spendingLimits.spendHeldRevert(task.subjectRef, task.id).catch(() => false);
}
