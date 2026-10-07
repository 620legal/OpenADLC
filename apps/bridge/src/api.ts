import { signInKind } from './sign-in.js';
import { aggregateInsights, withoutIgnored } from './insights.js';
import { insights } from '@fleetadlc/db';
import { heldForPerson } from './merge-line.js';
import { monthStart, parseCap, summarize as summarizeCi } from './ci-usage.js';
import { readHolds } from './item-hold.js';
import type { Attribution } from './attribution.js';
import { abandonRequest } from './request-lifecycle.js';
import {
  acknowledgements,
  attachments,
  audit,
  bots,
  ciUsage,
  costs,
  spendingLimits,
  credentials,
  deployRuns,
  issues,
  leases,
  listAudit,
  mergeLines,
  recordEvent,
  repos,
  requests,
  sessions,
  settings,
  stageMoves,
  tasks,
  threads,
  withAdvisoryLock,
} from '@fleetadlc/db';
import {
  ADDABLE_SEAT_ROLES,
  STAGE_COLUMN_TITLES,
  STAGE_KEYS,
  STAGE_MODES,
  builderOf,
  canAddSeatOf,
  isBackwardMove,
  AVATARS,
  CREW_COLORS,
  holdsCredential,
  isAvatar,
  isCrewColor,
  isRepoColor,
  MAX_TASKS_PER_SEAT,
  maxTasksOf,
  mayBeUntouched,
  normaliseStageModes,
  untouchedRefusal,
  REPO_COLORS,
  roleLabel,
  type Avatar,
  type Bot,
  type BotRole,
  type CrewColor,
  type StageKey,
  type TaskState,
} from '@fleetadlc/shared';
import type { Actors } from './actors.js';
import type { Automation } from './automation.js';
import type { BridgeConfig } from './config.js';
import type { DispatchGate } from './dispatch-gate.js';
import { subjectClosed, type Gates } from './gates.js';
import { botProbe, type WatermarkStream } from './thread-stream.js';
import type { HostdClient } from './hostd-client.js';
import type { Onboarding } from './onboarding.js';
import {
  appClientSecretRef,
  appPrivateKeyRef,
  getSecretStore,
  installedRepositories,
  pendingInvitationsFrom,
  redeliverLatestFailure,
  rulesAppliedPayload,
} from '@fleetadlc/github';
import { REPO_DEFAULTS, buildAppManifest, hasNextLabel, hasPausedLabel, isGitHubLogin, loginCandidates, manifestPostUrl, sameLogin } from '@fleetadlc/shared';
import { refuseWhilePaused } from './pause-work.js';
import { HttpFailure, Router, STREAMING, WithStatus } from './router.js';
import { RequestQueue, stillTried, withPositions } from './request-queue.js';
import type { Started } from './build-start.js';
import { effectiveConfig, storeWebhookSecret } from './effective-config.js';
import { automationBotName } from './automation-bot.js';
import type { EngineReadiness } from './hostd-client.js';
import type { WebhookSetup } from './webhook-setup.js';
import { APP_API, acceptable, NotOurRepository, worksIn } from './invitation-service.js';
import type { RepoSetup } from './repo-setup.js';
import { acrossRepositories, type CrewAccessKeeper } from './crew-access.js';
import { loginAvailable, lookUpAccount } from './github-accounts.js';
import { checkApp } from './app-checks.js';
import { AppManifestStates } from './app-manifest-state.js';
import type { InvitationService } from './invitation-service.js';
import { authorizationOf, buildStatus } from './status.js';
import type { TaskService } from './task-service.js';
import type { BotNames } from './bot-names.js';
import { defaultAssignmentDeps, registerAssignmentRoutes } from './assignment.js';
import { configuredFirstOfRole, configuredFor, configuredSeats } from './configured-crew.js';
import { defaultModelAccountDeps, registerModelAccountRoutes } from './model-accounts.js';
import { onAccountsWorkedIn, registerAppReachRoutes, repositoryFrom, type AppReach } from './app-reach.js';
import { engineUpdatesFor, registerEngineUpdateRoutes } from './engine-updates.js';
import { ATTENTION_WINDOW_DAYS, ClosedSubjects, registerAttentionRoutes, STOPPED_BY_A_PERSON, type HeldPromote } from './attention.js';
import { asAutomation } from './automation-bot.js';
import { DeployKnowledge, isTestingDeployChoice, testingDeployChoice, testingDeployStored } from './deploys.js';
import { startBuild } from './build-start.js';
import type { HealthRegistry } from './health/registry.js';
import { registerHealthRoutes } from './health/routes.js';
import { SubjectTitles } from './subject-titles.js';
import { retryTask } from './task-retry.js';
import { readBoardWork } from './board-work.js';
import { describeSubject } from './thread-view.js';
import { sendThreadMessage } from './thread-messages.js';
import { repinHumans } from './human-ids.js';
import { registerItemRoutes } from './item-routes.js';
import { itemOf, requestSubject } from './items.js';
import { readSeatPauses } from './seat-pause.js';
import type { HealthAction } from '@fleetadlc/shared';
import { attachmentIds, claimableFor, claimWindowStart, registerAttachmentRoutes } from './attachment-routes.js';
import { registerDesignMemoryRoutes } from './design-memory.js';
import { ignoredSubjects, issueForSubject, parseRef, taskSummary } from './work.js';
import { endedWithoutPullRequest, readBranch } from './build-left.js';
import { SpendingLimitRejected, applySpendingLimits, spendingView } from './spending-limits.js';
import { DEFAULT_REMOVAL, RepoRemoval, appOnRepository, appStanding, configuredLabelNames } from './repo-removal.js';
import type { SendBack } from './send-back.js';
import type { DeliveryKnowledge } from './delivery-rules.js';

export interface ApiDeps {
  config: BridgeConfig;
  hostd: HostdClient;
  actors: Actors;
  automation: Automation;
  gates: Gates;
  taskService: TaskService;
  onboarding: Onboarding;
  invitations: InvitationService;
  threadStream: WatermarkStream;
  webhookSetup: WebhookSetup;
  repoSetup: RepoSetup;
  /** The one routine that renames a bot; absent where nothing is renamed. */
  names?: BotNames;
  /**
   * What keeps the crew able to work in every repository, and what it last
   * found there. Absent where nothing lets the crew in.
   */
  crewAccess?: CrewAccessKeeper;
  /** The health checks; absent where none run. See `health/`. */
  health?: HealthRegistry;
  /** Pauses the dispatcher's leases, as a restore into this install does while it writes. */
  dispatchGate?: DispatchGate;
  /** Where the app is installed and whether it reaches a repository; absent where nothing asks GitHub. */
  appReach?: AppReach;
  /** GitHub's default branch for a repository, or null when GitHub could not be asked (`default-branch.ts`); absent where nothing asks GitHub. */
  defaultBranchOf?(fullName: string): Promise<string | null>;
  /** Signs and checks what the crew posts; absent where nothing is signed. See `attribution.ts`. */
  attribution?: Attribution;
  /** Console requests waiting for the intake bot; one is made where none is given. See `request-queue.ts`. */
  requestQueue?: RequestQueue;
  /** Taking a repository out of OpenADLC; one is made where none is given. See `repo-removal.ts`. */
  removal?: RepoRemoval;
  /** Sends work back to an earlier stage, a task's or a person's; see `send-back.ts`. Absent, a card moves only forward. */
  sendBack?: SendBack;
  /** Each repository's delivery rules, and where they came from; see `delivery-rules.ts`. Absent, the testing-deploy choice alone. */
  delivery?: DeliveryKnowledge;
}

/**
 * A bot's sessions as this person may see them. The last line a session
 * printed is its screen, which the screen routes keep for admins; the crew
 * page, which any user reads, carried it for every session all the same.
 */
function sessionsFor<T extends { lastLine?: unknown }>(role: string, rows: T[]): T[] | Omit<T, 'lastLine'>[] {
  if (role === 'admin') return rows;
  return rows.map(({ lastLine: _screen, ...rest }) => rest);
}

/**
 * A bot by the name it goes by, or by its seat. A page opened before a bot's
 * account connected still says `builder` after the bot has become
 * `fleetadlc-atlas-janedoe`, and that is the same bot, not an unknown one.
 */
async function botNamed(reference: string): Promise<Bot | null> {
  return (await bots.getBotByName(reference)) ?? (await bots.getBotBySlot(reference));
}

/**
 * Triage started from the queue, or the request's place in it.
 *
 * `task` is null in one case only: another bridge started it between the
 * drain and the read-back, so it is under way, not waiting.
 */
export type TriageStart =
  | { request: requests.RequestRecord & { queuePosition: number | null }; task: Started | null; bot: string; queued?: false }
  | { request: requests.RequestRecord & { queuePosition: number | null }; queued: true; position: number | null; bot: string };

/**
 * Starts what the queue can start, and says what became of this request:
 * started now, when intake is free and nothing waits ahead of it, or waiting
 * with its place in line. See `request-queue.ts`.
 */
async function triageFromQueue(queue: RequestQueue, requestId: string, bot: string): Promise<TriageStart> {
  // The request is saved and in line whatever happens here: a drain that
  // fails is said, and the sweep starts it. Answering 500 told the person it
  // was not filed, and the one they sent again was a second request.
  const drained = await queue.drain().catch((error: unknown) => {
    console.warn(`[bridge] request ${requestId.slice(0, 8)} is queued; starting the queue failed, and the sweep will: ${error instanceof Error ? error.message : error}`);
    return [];
  });
  const started = drained.find((one) => one.requestId === requestId);
  const [request] = await withPositions([(await requests.getRequest(requestId))!]);
  if (!request) throw new HttpFailure(404, 'unknown request');
  if (started) return { request, task: started.task, bot: started.bot };
  if (request.state !== 'queued') return { request, task: null, bot };
  return { request, queued: true, position: request.queuePosition, bot };
}

/**
 * A queued answer is 202, with its place in line, and why it waits when work
 * is paused; one that started is as it always was.
 */
function answered(start: TriageStart, paused: string | null = null) {
  // The work item the request is from now on: the console links "Open the
  // conversation" to it, which is the request's own and nobody else's.
  const subject = requestSubject(start.request.id);
  if (start.queued) {
    return new WithStatus(202, { request: start.request, subject, queued: true, position: start.position, bot: start.bot, ...(paused ? { paused } : {}) });
  }
  return { request: start.request, subject, task: start.task, bot: start.bot };
}

/**
 * Triage a request again.
 *
 * A request's triage can fail before it asks anything — an engine its
 * session could not find, a credential GitHub refused — and the request is
 * then a draft that nothing will pick up again. This puts it back in line and
 * starts it as the queue does: at once when intake is free and nothing waits
 * ahead of it, otherwise when its turn comes, which was a 409 while intake was
 * busy. A request already filed as an issue, or abandoned, is not triaged
 * again. "Try again" on a failed triage's card is this too.
 */
export async function startTriage(deps: Pick<ApiDeps, 'taskService' | 'requestQueue' | 'dispatchGate'>, requestId: string): Promise<TriageStart> {
  refuseWhilePaused(deps.dispatchGate);
  const record = await requests.getRequest(requestId);
  if (!record) throw new HttpFailure(404, 'unknown request');
  if (record.issueNumber !== null || record.state === 'filed') {
    throw new HttpFailure(409, `that request is already issue #${record.issueNumber ?? '?'}`);
  }
  if (record.state === 'abandoned') throw new HttpFailure(409, 'that request was abandoned');
  // A request for a paused repository waits, as the queue holds it; one with
  // no repository yet is triaged, and what it files waits instead.
  if (record.repoId) {
    const repo = (await repos.listRepos()).find((one) => one.id === record.repoId);
    refuseWhilePaused(deps.dispatchGate, repo?.name ?? null);
  }

  const intake = (await bots.listBots()).find((bot) => bot.role === 'intake');
  if (!intake) throw new HttpFailure(409, NO_INTAKE);

  // Its triage under way — running, or paused on a question — is not tried
  // again beside itself.
  const subject = `request:${record.id.slice(0, 8)}`;
  const going = (await tasks.listTasksOnSubjects([subject])).find((task) => ['queued', 'running', 'paused'].includes(task.state));
  if (going) throw new HttpFailure(409, `its triage is ${going.state === 'paused' ? 'waiting on an answer' : 'under way'}`);

  // Through the queue, under its lock, like a new request: one already
  // waiting keeps its place and is tried afresh; the queue's claim is what
  // keeps it from starting twice.
  await requests.queueAgain(record.id);
  return triageFromQueue(deps.requestQueue ?? new RequestQueue({ taskService: deps.taskService, paused: (repo) => deps.dispatchGate?.paused(repo) ?? null }), record.id, intake.name);
}

/**
 * What running a failed or stopped task again is made of: a build started the
 * way the dispatcher's lease starts one, and a triage started the way its route
 * does. Shared by "Try again" on a card and by the retry a recovered health
 * check triggers.
 *
 * A build refused before it began (its seat cannot sign in, say) leaves the
 * lease `retryTask` just took holding the issue for its whole length, with
 * nothing running on it. The dispatcher gives its lease back when the route
 * throws; this does the same.
 */
export function retryDepsFor(
  deps: Pick<ApiDeps, 'taskService' | 'automation' | 'requestQueue' | 'dispatchGate'>,
): Parameters<typeof retryTask>[2] {
  return {
    taskService: deps.taskService,
    paused: (repo) => deps.dispatchGate?.paused(repo) ?? null,
    startBuild: async (input) => {
      try {
        return await startBuild(deps, input);
      } catch (error) {
        const lease = await leases.getLease(input.leaseId).catch(() => null);
        if (lease?.state === 'leased') await leases.setLeaseState(lease.id, 'released').catch(() => undefined);
        throw error;
      }
    },
    startTriage: (requestId) => startTriage(deps, requestId),
    // A patch round run again may write the pull request's files, as a fresh
    // one may; read as the automation account, as the webhook reads them.
    pullFiles: async (repoFullName, prNumber) => {
      const client = await asAutomation(deps.automation['actors'], deps.automation['config']);
      if (!client) throw new Error(`${await automationBotName(deps.automation['config'])} is not connected to GitHub`);
      return client.listPullFilesAsNamed(repoFullName, prNumber);
    },
    // Work whose issue or pull request has closed is not run again.
    subjectClosed: async (repoFullName, number) => {
      const client = await asAutomation(deps.automation['actors'], deps.automation['config']);
      return client ? subjectClosed(client, repoFullName, number) : false;
    },
    // A build that ended `done` is gone on with only while its branch has no pull request.
    branchOf: async (repoFullName, branch, base) => {
      const client = await asAutomation(deps.automation['actors'], deps.automation['config']);
      return client ? readBranch(client, repoFullName, branch, base) : null;
    },
  };
}

/**
 * Takes a failed or stopped task's card off the board without running it
 * again, as a person decided: kept in `acknowledgements` under `task:<id>`,
 * with the ending the card showed, so the card stays away until the task
 * ends again (the rule for any notice a person dismisses), and audited as
 * `task.dismissed`.
 */
export async function dismissTask(
  taskId: string,
  actor: string,
  occurrence: string | undefined,
  deps: { acknowledge: typeof acknowledgements.acknowledge; forgetBefore: typeof acknowledgements.forgetBefore; audit: typeof audit } = {
    acknowledge: acknowledgements.acknowledge,
    forgetBefore: acknowledgements.forgetBefore,
    audit,
  },
): Promise<{ task: string; dismissed: string }> {
  const task = await tasks.getTask(taskId);
  if (!task) throw new HttpFailure(404, 'there is no such task');
  if (task.state !== 'failed' && task.state !== 'stopped') {
    throw new HttpFailure(409, `that task is ${task.state}; only one that failed or was stopped has a card to dismiss`);
  }
  // The ending the card showed. Without one, the task's own: a card read
  // before this route existed sends none.
  const ended = task.endedAt ?? task.startedAt ?? task.createdAt;
  const seen = occurrence?.trim() || new Date(ended).toISOString();
  await deps.acknowledge(`task:${task.id}`, seen, actor);
  // A dismissal older than the week a failure is read for hides nothing, and
  // every read of what needs you reads them all: dismissing is when they are
  // added, so it is when the old ones go. Losing that race costs nothing.
  await deps.forgetBefore('task:', new Date(Date.now() - ATTENTION_WINDOW_DAYS * 24 * 60 * 60 * 1000)).catch(() => undefined);
  await deps.audit({
    actor,
    action: 'task.dismissed',
    target: task.subjectRef,
    payload: { task: task.id, kind: task.kind, state: task.state, occurrence: seen },
  });
  return { task: task.id, dismissed: seen };
}

/** The states a task can be stopped from: the ones whose card offers "Try again", and a pause nobody is asked about. */
/** A request with no intake seat to triage it: the crew's to change, not the bridge failing. */
const NO_INTAKE = 'no intake bot is configured; add an intake seat to config/bots.yaml and run fleetadlc up';

const STOPPABLE: readonly string[] = ['failed', 'stopped', 'paused'];
const HELD_LEASE: readonly string[] = ['leased', 'in_task', 'paused'];
const UNFINISHED: readonly TaskState[] = ['queued', 'running', 'paused'];

/**
 * Ends a task for good, as a person decided: hostd's cancel ends whatever
 * is left of its session and marks it stopped with the reason, its lease is
 * released, and the stop is audited. The reason starts with
 * `STOPPED_BY_A_PERSON`, which is what takes its card off the board.
 *
 * A retry reuses the lease of the task it retries (`task-retry.ts`), and the
 * dispatcher may lease the issue to the same bot again, so a stale card in
 * another tab could otherwise stop an old task and release the lease a newer
 * one is working under — letting a second bot onto the issue. So the same
 * work going again is refused, as `retryTask` refuses it, and a lease another
 * unfinished task on the subject holds is left where it is.
 *
 * `unfinished` is the same stop for work that has not ended — queued,
 * running, or paused on a question — which is what removing a repository from
 * OpenADLC does to every task there (`repo-removal.ts`). A task paused on a
 * question is stopped rather than refused, and its question is closed so it
 * leaves Needs you; the same work going again is not a reason to refuse,
 * because that task is stopped too; and a task that ended on its own in the
 * meantime is left as it ended.
 */
export async function stopTask(
  taskId: string,
  actor: string,
  note: string,
  hostd: Pick<HostdClient, 'cancelTask'>,
  options: { unfinished?: boolean } = {},
): Promise<{ task: string; state: string; releasedLease: string | null; questionsClosed: number }> {
  const task = await tasks.getTask(taskId);
  if (!task) throw new HttpFailure(404, 'there is no such task');
  const ended = (state: string): boolean => Boolean(options.unfinished) && !UNFINISHED.includes(state as TaskState);
  if (ended(task.state)) return { task: task.id, state: task.state, releasedLease: null, questionsClosed: 0 };
  const refuse = async (state: string): Promise<void> => {
    if (options.unfinished) return;
    if (!STOPPABLE.includes(state)) {
      throw new HttpFailure(409, `that task is ${state}; only one that failed, was stopped, or is paused can be stopped here`);
    }
    if (state === 'paused' && (await threads.listOpenGates()).some((gate) => gate.taskId === task.id)) {
      throw new HttpFailure(409, 'that task is waiting on a question; answer it in its thread instead');
    }
  };
  await refuse(task.state);

  const others = (await tasks.listTasksOnSubjects([task.subjectRef])).filter(
    (other) => other.id !== task.id && UNFINISHED.includes(other.state),
  );
  const again = others.find(
    (other) => other.kind === task.kind && (task.kind !== 'review' || other.botId === task.botId),
  );
  if (again && !options.unfinished) {
    throw new HttpFailure(409, 'that work is going again in a newer task; stop that one from its card instead');
  }

  // Read again just before hostd is asked: hostd's cancel stops a task whatever
  // state it is in, and a question can open, or an answer resume the task,
  // between the checks above and here. What is left is the time one request
  // to hostd takes.
  const now = await tasks.getTask(task.id);
  if (now && ended(now.state)) return { task: task.id, state: now.state, releasedLease: null, questionsClosed: 0 };
  await refuse(now?.state ?? task.state);

  const reason = `${STOPPED_BY_A_PERSON} (${actor})${note ? `: ${note}` : ''}`;
  try {
    await hostd.cancelTask(task.id, reason);
  } catch (error) {
    throw new HttpFailure(502, `hostd did not stop it: ${error instanceof Error ? error.message : String(error)}`);
  }

  // A question the task was waiting on is one nobody can act on now: an answer
  // would resume nothing. hostd's cancel closes it only for a task whose lease
  // a gate paused, and a triage has no lease.
  let questionsClosed = 0;
  let questionError: string | null = null;
  if (options.unfinished) {
    try {
      questionsClosed = (await threads.expireGatesOfTask(task.id, actor, note || reason)).length;
    } catch (error) {
      questionError = error instanceof Error ? error.message : String(error);
    }
  }

  // The task's own lease, or, for a build that recorded none, the one its bot
  // holds on the issue: what the dispatcher would otherwise wait on until the
  // idle-lease check let it go. Not one another unfinished task works under.
  let releasing: { id: string } | null = null;
  let leaseError: string | null = null;
  try {
    let lease = task.leaseId ? await leases.getLease(task.leaseId) : null;
    if (!lease && task.repoId && task.kind === 'implement') {
      const parsed = parseRef(task.subjectRef);
      const held = parsed ? await leases.getActiveLease(task.repoId, parsed.number) : null;
      if (held?.botId === task.botId) lease = held;
    }
    // Any unfinished task under the same lease, on whatever subject: a patch
    // task works on the pull request's ref, not the issue's, and a retry
    // reuses the lease it retries.
    const underLease = lease
      ? (await tasks.listTasks({ states: [...UNFINISHED], limit: 500 })).some(
          (other) => other.id !== task.id && other.leaseId === lease.id,
        )
      : false;
    const heldElsewhere = lease && (underLease || others.some((other) => other.botId === lease.botId));
    if (lease && HELD_LEASE.includes(lease.state) && !heldElsewhere) {
      await leases.setLeaseState(lease.id, 'released');
      releasing = lease;
    }
  } catch (error) {
    leaseError = error instanceof Error ? error.message : String(error);
  }

  // Written whatever happened to the lease: hostd has stopped the task already.
  const bot = await bots.getBotById(task.botId).catch(() => null);
  await audit({
    actor,
    action: 'task.stopped',
    target: task.subjectRef,
    payload: {
      task: task.id,
      bot: bot?.name ?? null,
      kind: task.kind,
      was: task.state,
      reason,
      lease: releasing?.id ?? null,
      ...(options.unfinished ? { questionsClosed } : {}),
      ...(leaseError ? { leaseError } : {}),
      ...(questionError ? { questionError } : {}),
    },
  });
  // A removal goes on to release what is left of the repository's leases and
  // close what is left of its questions, and says what it could not; a
  // person's Stop has nothing after it.
  if (leaseError && !options.unfinished) {
    throw new HttpFailure(500, `it is stopped, but its lease could not be released: ${leaseError}. The idle-lease check lets it go within minutes`);
  }
  return { task: task.id, state: 'stopped', releasedLease: releasing?.id ?? null, questionsClosed };
}

export function registerConsoleApi(router: Router, deps: ApiDeps): void {
  const { config, hostd } = deps;
  const removal =
    deps.removal ??
    new RepoRemoval({
      stop: (taskId, actor, note) => stopTask(taskId, actor, note, hostd, { unfinished: true }),
      github: (repository) => appOnRepository(config, repository),
      ...(deps.invitations ? { invitations: (repository: string) => deps.invitations.discover(repository) } : {}),
      ...(deps.crewAccess ? { crewAccess: deps.crewAccess } : {}),
      ...(deps.appReach ? { app: (repository: string) => appStanding(deps.appReach!, repository) } : {}),
      labelNames: () => configuredLabelNames(config.repoRoot),
    });
  const queue = deps.requestQueue ?? new RequestQueue({ taskService: deps.taskService, paused: (repo) => deps.dispatchGate?.paused(repo) ?? null });
  // Which repositories ship by merging, for the Ship column; see `deploys.ts`.
  const deploys = new DeployKnowledge(() => asAutomation(deps.actors, config));
  // hostd signs a subscription in and checks an account, where the bots think.
  registerModelAccountRoutes(router, {
    ...defaultModelAccountDeps(hostd),
    // An account signed in again, verified or given a new key is its check
    // passing: asked now, so its card goes now.
    changed: () => deps.health?.runSoon(['model-account']),
  });
  registerAssignmentRoutes(router, defaultAssignmentDeps(deps.config?.configRoot));
  registerEngineUpdateRoutes(router, engineUpdatesFor(hostd));
  registerAppReachRoutes(router, deps.appReach);
  // What needs a person: a failed engine update and every failing health check
  // among it, and the pull requests the board has no row for named by title.
  const titles = new SubjectTitles({
    client: () => asAutomation(deps.actors, config),
    fullName: async (name) => (await repos.getRepoByName(name))?.fullName ?? null,
  });
  // Which subjects of failed work have closed, so a card on work that landed
  // is not one.
  const closed = new ClosedSubjects({
    client: () => asAutomation(deps.actors, config),
    fullName: async (name) => (await repos.getRepoByName(name))?.fullName ?? null,
  });
  registerAttentionRoutes(router, {
    engineUpdates: engineUpdatesFor(hostd),
    ...(deps.health ? { health: deps.health } : {}),
    titles: (refs) => titles.lookup(refs),
    closed: (refs) => closed.lookup(refs),
    // Only on an install without per-repository delivery rules: there the
    // deprecated variable is empty, and it said nothing deploys to testing.
    ...(deps.delivery ? {} : { testingDeploy: (config.testingUrl ?? '').trim().length > 0 }),
    shipsByMerging: async (repo) => {
      const found = deps.delivery ? await repos.getRepoByName(repo.name).catch(() => null) : null;
      if (deps.delivery && found) return (await deps.delivery.get(found)).rules.testing.on === 'none';
      return deploys.shipsByMerging(repo.fullName, testingDeployChoice(await settings.getSetting('testingDeploy').catch(() => null), repo.name));
    },
    // Promotes held for a person, and whether the file sets the rules that held them.
    heldPromotes: async () => {
      const [held, list] = await Promise.all([deployRuns.heldForPerson(), repos.listRepos()]);
      const out: HeldPromote[] = [];
      for (const run of held) {
        const repo = list.find((one) => one.id === run.repoId);
        if (!repo) continue;
        const source = deps.delivery ? (await deps.delivery.get(repo).catch(() => null))?.source : null;
        out.push({
          repo: repo.name,
          sha: run.sha,
          since: run.promoteHeldAt ?? run.createdAt,
          fileGoverned: source === 'file',
          reason: run.detail ?? '',
        });
      }
      return out;
    },
  });
  if (deps.health) registerHealthRoutes(router, deps.health);

  router.get('/v1/board', async ({ query }) => {
    const repoFilter = query.get('repo');
    const repoName = !repoFilter || repoFilter === 'all' ? undefined : repoFilter;
    const [cards, crew, repoList, openGates, issueList, requestList] = await Promise.all([
      issues.boardCards(repoName),
      bots.listBots(),
      repos.listRepos(),
      threads.listOpenGates(),
      issues.listIssues(repoName),
      requests.listRequests(200),
    ]);

    // What each card has cost and who is on it now, and which bots are working
    // or waiting on a person: what a card and a column say in words.
    const work = await readBoardWork({
      issues: issueList,
      bots: crew,
      repos: repoList,
      gates: openGates,
      // Each queued request's place as the queue walks it: one source for the number the 202 gave.
      requests: await withPositions(requestList),
    });

    // What is waiting to land, and what the bridge is doing about it. A person
    // looking at the board should not have to guess why a green pull request
    // has not merged yet.
    const named = repoName ? repoList.find((entry) => entry.name === repoName) : null;
    // The repositories OpenADLC works in. One removed keeps its issues and its
    // pull requests as history; they are not the board's any more.
    const workedIn = new Set(repoList.map((entry) => entry.name));
    // Nor is an issue labelled `fleetadlc:ignore`, nor its pull request, nor
    // the request it was filed from: the board is the crew's work.
    const ignored = ignoredSubjects(issueList);
    const landing = (await mergeLines.line(named?.id)).filter(
      (entry) => workedIn.has(entry.repoName) && !ignored.has(`${entry.repoName}#${entry.prNumber}`),
    );
    const onBoard = cards.filter((card) => workedIn.has(card.repo) && !ignored.has(card.ref));
    // A request nobody has named a repository for yet is only on the board of all of them.
    const inFlight = work.requests
      .filter((card) => (repoName ? card.repo === repoName : !card.repo || workedIn.has(card.repo)))
      .filter((card) => !(card.issueNumber !== null && ignored.has(`${card.repo}#${card.issueNumber}`)));

    const staffing: Record<string, string[]> = {
      intake: crew.filter((bot) => bot.role === 'intake').map((bot) => bot.name),
      spec: crew.filter((bot) => bot.role === 'spec').map((bot) => bot.name),
      build: crew.filter((bot) => bot.role === 'implement').map((bot) => bot.name),
      review: crew
        .filter((bot) => bot.role.startsWith('review'))
        .map((bot) => bot.name),
      merged: crew.filter((bot) => bot.role === 'deploy').map((bot) => bot.name),
      done: [],
    };

    const activeSessions = await sessions.listSessions();
    const working = new Set(
      activeSessions.filter((session) => session.state === 'working').map((session) => session.botId),
    );

    // Ship is skipped where merging is shipping: the column says so, rather
    // than "Deploys what was approved · waits for you" over a stage that never
    // happens. Only when every repository in view deploys nothing.
    const inView = repoName ? repoList.filter((entry) => entry.name === repoName) : repoList;
    const testingDeploy = (await settings.allSettings().catch(() => null))?.testingDeploy ?? null;
    const byMerging = await Promise.all(
      inView.map(async (entry) =>
        deps.delivery
          ? (await deps.delivery.get(entry)).rules.testing.on === 'none'
          : deploys.shipsByMerging(entry.fullName, testingDeployChoice(testingDeploy, entry.name)),
      ),
    );
    const shipsByMerging = inView.length > 0 && byMerging.every((answer) => answer === true);
    const holds = await readHolds();

    const columns = STAGE_KEYS.map((stage) => ({
      stage,
      title: STAGE_COLUMN_TITLES[stage],
      mode: modeForStage(repoList, repoName, stage),
      ...(stage === 'merged' ? { shipsByMerging } : {}),
      bots: (staffing[stage] ?? []).map((name) => {
        const bot = crew.find((entry) => entry.name === name);
        return {
          name,
          displayName: bot?.displayName ?? name,
          working: bot ? working.has(bot.id) || work.running.has(bot.id) : false,
          waiting: bot ? work.waiting.has(bot.id) : false,
        };
      }),
      cards: [
        // What intake is asking about or writing up, before it is an issue.
        ...(stage === 'intake' ? inFlight : []),
        ...onBoard
          .filter((card) => card.stage === stage)
          .map((card) => {
            const extras = work.byRef.get(card.ref);
            // Held from the board, and who did; the one its repository builds next.
            const marks = {
              held: hasPausedLabel(card.labels) ? (holds[card.ref] ?? { by: 'a person on GitHub', at: '', why: null }) : null,
              next: hasNextLabel(card.labels),
            };
            // Who is on it now, the pull request's reviewers included; the store
            // only knew the tasks filed under the issue itself.
            return extras ? { ...card, ...extras, assignees: extras.assignees, ...marks } : { ...card, ...marks };
          }),
      ],
    }));

    return {
      repo: repoName ?? 'all',
      repos: repoList.map((repo) => repo.name),
      // Each with the colour the board tells it apart by, when it shows them all.
      repositories: repoList.map((repo) => ({ name: repo.name, fullName: repo.fullName, color: repo.color })),
      columns,
      mergeLine: landing.map((entry) => ({
        repo: entry.repoName,
        ref: `${entry.repoName}#${entry.prNumber}`,
        position: entry.position,
        state: entry.state,
        detail: entry.detail,
        heldFor: heldForPerson(entry),
      })),
      waitingOnYou: openGates.length,
      working: activeSessions.filter((session) => session.state === 'working').length,
      idle: activeSessions.filter((session) => session.state === 'idle').length,
    };
  });

  router.get('/v1/bots', async ({ role }) => {
    const [crew, issueList, openGates, repoList, checks, seatPauses, requestList] = await Promise.all([
      bots.listBots(),
      issues.listIssues(),
      threads.listOpenGates(),
      // A bot's task may be in a repository since removed: it still names it.
      repos.listRepos({ includeRemoved: true }),
      // A table not there yet is no checks, not a crew page that fails.
      (async () => (deps.health ? deps.health.rows() : []))().catch(() => []),
      readSeatPauses(),
      // For what a request's task is about, and the work item it is part of.
      (async () => requests.listRequests(100))().catch(() => [] as Awaited<ReturnType<typeof requests.listRequests>>),
    ]);
    const itemFacts = { issues: issueList, repos: repoList, requests: requestList.map((one) => ({ ...one, issueNumber: one.issueNumber ?? null })) };
    // What a subject is called on the Crew page: its issue's title, or its request's first line.
    const titleOf = (subjectRef: string): string | null => {
      const issue = issueForSubject(subjectRef, issueList);
      if (issue) return issue.title;
      const request = itemOf(subjectRef, itemFacts)?.request;
      return request ? (request.text.split('\n')[0] ?? '').slice(0, 120) || null : null;
    };
    const gated = new Set(openGates.map((gate) => gate.taskId).filter((id): id is string => Boolean(id)));
    // Work on an issue labelled `fleetadlc:ignore`, or its pull request, is not
    // the console's: not in a seat's queue or its history. What the seat is
    // doing now still is, since that is the seat's state, and its card is where
    // a person stops a task that was running when the label went on.
    const ignored = ignoredSubjects(issueList);
    const shown = (task: { subjectRef: string }): boolean => !ignored.has(task.subjectRef);
    const repoNames = new Map(repoList.map((repo) => [repo.id, repo.name]));
    // What a task is, in the words the crew page uses: the issue it is about, and
    // for a review the round it is in, which is one more than the fixes so far,
    // out of how many rounds the loop runs before it stops and asks.
    const summarise = async (task: Awaited<ReturnType<typeof tasks.listTasks>>[number] | undefined) =>
      task
        ? {
            // The thread's Stop acts on it by id, and offers it for a task a
            // person did not stop already.
            id: task.id,
            stoppedByAPerson: task.state === 'stopped' && Boolean(task.exitReason?.startsWith(STOPPED_BY_A_PERSON)),
            // A build that ended `done` with no pull request: the thread offers
            // Try again for it, which goes on from its branch.
            endedWithoutPullRequest: endedWithoutPullRequest(task, issueForSubject(task.subjectRef, issueList)),
            ...taskSummary(task, {
              issues: issueList,
              gated,
              patches: task.kind === 'review' ? await tasks.listTasksForSubjects('patch', [task.subjectRef]) : [],
              maxRounds: config?.review?.maxRounds ?? null,
              repoNames,
            }),
          }
        : null;

    return {
      bots: await Promise.all(
        crew.map(async (bot) => {
          const [botSessions, running, ended, credential, unfinished, finished] = await Promise.all([
            sessions.listSessions(bot.id),
            tasks.listTasks({ botId: bot.id, states: ['running', 'paused', 'queued'], limit: 1 }),
            tasks.listTasks({ botId: bot.id, states: ['done', 'failed', 'stopped'], limit: 1 }),
            credentials.getCredential(bot.id),
            tasks.listTasks({ botId: bot.id, states: ['running', 'paused', 'queued'], limit: 50 }),
            tasks.listTasks({ botId: bot.id, states: ['done', 'failed', 'stopped'], limit: 3 }),
          ]);
          const current = running[0];
          const failing = checks.filter((row) => row.state === 'failing' && aboutBot(row.facts, bot.id));
          return {
            ...bot,
            authorization: await authorizationOf(bot, credential?.status),
            tokenExpiresAt: credential?.tokenExpiresAt ?? null,
            now: current
              ? `${current.skill ?? current.kind} on ${current.subjectRef}`
              : botSessions.length > 0
                ? 'idle in a shell'
                : 'nothing running',
            paused: current?.state === 'paused',
            sessions: sessionsFor(role, botSessions),
            // Live state, read from the tasks. `status` above is the column
            // nothing updates, and every bot reads "stopped" in it.
            task: await summarise(current),
            lastTask: await summarise([...ended, ...finished].find(shown)),
            // What the health checks say is wrong with this bot: its sign-in,
            // its signing key, the account it thinks with.
            checks: failing.map((row) => ({ id: row.id, title: row.title ?? row.checkId, severity: row.severity ?? 'blocking' })),
            // For the Crew page's cards and table: the seat's pause, its work
            // in hand and waiting, what it last finished and how, and its
            // health as one state with each reason and the way to fix it.
            seatPaused: seatPauses[bot.name] ?? null,
            queue: await queueOf(bot, unfinished.filter((task) => shown(task) || task.id === current?.id), gated, titleOf),
            recent: await Promise.all(
              finished.filter(shown).map(async (task) => ({
                ref: task.subjectRef,
                title: titleOf(task.subjectRef),
                kind: task.kind,
                outcome: await outcomeOf(task),
                at: task.endedAt ?? task.startedAt ?? task.createdAt,
                item: itemOf(task.subjectRef, itemFacts)?.key ?? null,
                // The seat panel's History says what each cost; the row has it.
                costUsd: task.costUsd,
              })),
            ),
            health: healthOf(failing),
          };
        }),
      ),
    };
  });

  router.get('/v1/bots/:name', async ({ params, role }) => {
    const bot = await botNamed(params.name ?? '');
    if (!bot) throw new HttpFailure(404, 'unknown bot');
    const [botSessions, botTasks, credential] = await Promise.all([
      sessions.listSessions(bot.id),
      tasks.listTasks({ botId: bot.id, limit: 20 }),
      credentials.getCredential(bot.id),
    ]);
    return { bot, sessions: sessionsFor(role, botSessions), tasks: botTasks, authorization: credential };
  });

  router.get('/v1/threads/:bot', async ({ params, query }) => {
    const bot = await botNamed(params.bot ?? '');
    if (!bot) throw new HttpFailure(404, 'unknown bot');

    const all = await threads.listThreadsForBot(bot.id);
    const subject = query.get('subject');
    const selected = subject ? all.filter((thread) => thread.subject_ref === subject) : all;
    const [messages, gates, issueList, repoList, requestList] = await Promise.all([
      threads.listMessages(selected.map((thread) => thread.id)),
      threads.listOpenGates(),
      issues.listIssues(),
      // What a thread was about stays what it was about after its repository
      // is removed from OpenADLC.
      repos.listRepos({ includeRemoved: true }),
      requests.listRequests(200),
    ]);
    const openGates = gates.filter((gate) => selected.some((thread) => thread.id === gate.threadId));
    const subjectOf = new Map(all.map((thread) => [thread.id, thread.subject_ref]));
    // Every question the bot has open, on whatever it is about, with what it
    // is about: the panel lists them all. One on another request was
    // reachable only by picking that request from the Show list.
    const everyOpen = gates
      .filter((gate) => all.some((thread) => thread.id === gate.threadId))
      .map((gate) => ({ ...gate, subjectRef: (gate.threadId ? subjectOf.get(gate.threadId) : null) ?? null }));

    return {
      bot: { name: bot.name, displayName: bot.displayName, role: bot.role, engine: bot.engine, container: bot.container, status: bot.status, color: bot.color ?? null, avatar: bot.avatar ?? null },
      subjects: all.map((thread) => thread.subject_ref).filter(Boolean),
      // Each subject as a person picks it — by the issue's title, or what a
      // request asked for — newest first, as the threads are.
      // And the work item each is part of, which the console groups a bot's
      // topics by and opens in full: a request, its issue and its pull
      // request are one item. Null for a thread about nothing.
      topics: all.map((thread) => ({
        ...describeSubject(thread.subject_ref, { issues: issueList, repos: repoList, requests: requestList }),
        item: itemOf(thread.subject_ref, { issues: issueList, repos: repoList, requests: requestList })?.key ?? null,
      })),
      // Which subject each message is about, so everything at once can still say.
      messages: messages.map((message) => ({ ...message, subjectRef: subjectOf.get(message.threadId) ?? '' })),
      openGate: openGates[0] ?? null,
      openGates: everyOpen,
    };
  });

  /**
   * Tells an open panel when to re-read, over one connection that stays open.
   *
   * Deliberately an event saying *that* something changed, not the thread
   * itself: the panel already has a loader, and sending the messages down two
   * paths is two shapes to keep in step. The panel re-reads on the nudge, which
   * is also what makes a reconnect self-healing — it fetches on connect, so
   * anything that arrived while the socket was down is simply there.
   *
   * `retry` tells the browser how long to wait before reconnecting; without it
   * the default is three seconds and a bridge restart looks like a dead panel
   * for that long. The comment ping keeps proxies from closing an idle stream.
   */
  router.get('/v1/threads/:bot/stream', async ({ params, res }) => {
    const bot = await botNamed(params.bot ?? '');
    if (!bot) throw new HttpFailure(404, 'unknown bot');

    const key = `bot:${bot.id}`;
    const stop = deps.threadStream.subscribe(key, botProbe(bot.id), (watermark) => {
      res.write(`event: changed\ndata: ${JSON.stringify({ watermark })}\n\n`);
    });

    // A comment line is a valid event-stream frame that carries nothing. It
    // exists so an idle connection is still a connection to anything in between.
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);
    keepAlive.unref?.();

    const close = (): void => {
      clearInterval(keepAlive);
      stop();
    };
    res.on('close', close);
    res.on('error', close);

    // The 200 is what the panel re-reads on, so the baseline is taken first.
    await deps.threadStream.ready(key);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    res.write('retry: 1000\n\n');

    return STREAMING;
  });

  /** A person's message to a bot, about one of its subjects. See `sendThreadMessage`. */
  router.post('/v1/threads/:bot/messages', async ({ params, body, identity, role }) => {
    const bot = await botNamed(params.bot ?? '');
    if (!bot) throw new HttpFailure(404, 'unknown bot');
    const input = await body<{ text: string; subject?: unknown }>();
    const subject = typeof input.subject === 'string' ? input.subject.trim() : null;
    return sendThreadMessage(deps, { bot, subject, text: input.text, identity, role });
  });

  registerItemRoutes(router, deps);
  registerAttachmentRoutes(router);
  registerDesignMemoryRoutes(router);

  router.get('/v1/gates', async () => ({ gates: await threads.listOpenGates() }));

  router.post('/v1/gates/:id/answer', async ({ params, body, identity, role }) => {
    const input = await body<{ answer: string }>();
    const result = await deps.gates.answer({
      gateId: params.id ?? '',
      reply: input.answer,
      answeredBy: identity,
      // Only an admin's continue goes past a spent monthly cap (`Gates.answer`).
      role,
      via: 'console-gate',
    });
    if (result.taskId) {
      await deps.taskService.resume(result.taskId).catch((error) => {
        console.warn(`[bridge] resume after answer failed: ${error.message}`);
      });
    }
    // Audited where the gate is claimed (`Gates.answer`), as every route's answer is.
    return result;
  });

  router.get('/v1/sessions/:bot', async ({ params }) => {
    const bot = await botNamed(params.bot ?? '');
    if (!bot) throw new HttpFailure(404, 'unknown bot');
    const live = await hostd.sessions(bot.name).catch(() => ({ sessions: [] }));
    return { stored: await sessions.listSessions(bot.id), live: live.sessions };
  });

  // This, kill and restart resolve the bot before hostd is asked, and ask by
  // the name it goes by: the path is a person's input, and hostd hears only
  // about a bot OpenADLC has.
  router.get('/v1/sessions/:bot/:session/pane', async ({ params, query }) => {
    const lines = Number(query.get('lines') ?? '60');
    const bot = await botNamed(params.bot ?? '');
    if (!bot) throw new HttpFailure(404, 'unknown bot');
    const result = await hostd.pane(bot.name, params.session ?? '', lines).catch(() => ({ pane: [] }));
    if (result.pane.length > 0) return result;

    const stored = await sessions.getSession(bot.id, params.session ?? '');
    return { pane: stored ? await sessions.readSessionPane(stored.id, lines) : [] };
  });

  /**
   * What a bot has actually written, read-only, without taking its keyboard.
   *
   * The Computer tab is a bot's tab and a worktree belongs to a task, so the
   * bridge resolves one to the other rather than making the console know a task
   * id. A bot between tasks has no worktree and that is not a failure — the
   * console says so where a tree would be, which is why this answers 200 with no
   * task rather than a 404 the tab would have to render as an error.
   */
  router.get('/v1/worktree/:bot', async ({ params, query }) => {
    const bot = await botNamed(params.bot ?? '');
    if (!bot) throw new HttpFailure(404, 'unknown bot');

    // A seat can run several tasks at once, so a caller that knows which one
    // names it; it has to be this bot's and running, or there is no worktree
    // to show. Without one, the bot's newest running task.
    const named = query.get('task');
    const running = named
      ? await tasks.getTask(named).then((task) => (task && task.botId === bot.id && task.state === 'running' ? task : null))
      : (await tasks.listTasks({ botId: bot.id, states: ['running'], limit: 1 }))[0];
    if (!running) return { task: null };

    const view = await hostd.worktree(running.id, query.get('path') ?? '');
    return {
      task: { id: running.id, subjectRef: running.subjectRef, branch: running.branch },
      ...view,
    };
  });

  router.post('/v1/sessions/:bot/:session/kill', async ({ params, identity }) => {
    const bot = await botNamed(params.bot ?? '');
    if (!bot) throw new HttpFailure(404, 'unknown bot');
    await hostd.killSession(bot.name, params.session ?? '', identity);
    return { ok: true };
  });

  router.post('/v1/bots/:name/restart', async ({ params, identity }) => {
    const bot = await botNamed(params.name ?? '');
    if (!bot) throw new HttpFailure(404, 'unknown bot');
    await hostd.restartBot(bot.name, identity);
    return { ok: true };
  });

  router.post('/v1/terminal/:bot/:session/token', async ({ params, identity }) => {
    // Any admin may mint a token for any bot and any session, including one
    // that is not running; a user is refused before this runs (`roles.ts`),
    // and hostd's gateway opens nothing without a token minted here, so
    // take-over is an admin's. There is no per-bot grant; docs/security.md
    // states it. The gateway is what finds out the session is not there.
    // By the task the session was started for, when one was: a computer is
    // a task's, and hostd says plainly when the task no longer has one.
    const task = await tasks.findTaskBySession?.(`${params.bot ?? ''}/${params.session ?? ''}`).catch(() => null);
    const minted = await hostd.attachToken(params.bot ?? '', params.session ?? '', identity, task?.id ?? null);
    // The console opens the socket with the token as a subprotocol. Anything
    // else hostd attached — in particular a path that puts the token in the
    // query string — stays here. A query string is the request line, and the
    // request line is what a proxy writes down.
    return { token: minted.token, expiresInSeconds: minted.expiresInSeconds };
  });

  router.post('/v1/requests', async ({ body, identity }) => {
    const input = await body<{ text: string; context?: string; repo?: string; kind?: string; attachments?: unknown }>();
    if (!input.text?.trim()) throw new HttpFailure(400, 'a request needs a line of text');
    const files = attachmentIds(input.attachments);

    const repo = input.repo ? await repos.getRepoByName(input.repo) : null;
    const intake = (await bots.listBots()).find((bot) => bot.role === 'intake');
    if (!intake) throw new HttpFailure(409, NO_INTAKE);
    // Before the request is written: a request whose triage cannot start is
    // refused whole, or it would sit as a draft nothing picks up.
    await deps.taskService.assertReady(intake, repo?.name ?? null);
    // And before it is written: a request whose files cannot be sent with it
    // is refused whole, rather than triaged without the screenshot it is about.
    await claimableFor(files, { identity, itemSubjects: [] });

    // Written to wait its turn, and started from the queue: with intake free
    // and nothing ahead of it, at once. A request sent while intake is busy
    // was refused as busy after it had been written, and nothing started it
    // again; one sent while others wait goes behind them.
    const record = await requests.createRequest({
      text: input.text,
      context: input.context ?? null,
      repoId: repo?.id ?? null,
      kind: input.kind ?? null,
      requestedBy: identity,
      state: 'queued',
    });
    await recordEvent({ source: 'console', type: 'request.created', payload: { requestId: record.id } });
    // Claimed before its triage can start, which reads them (`context.ts`).
    if (files.length > 0) {
      await attachments.claim(files, {
        uploadedBy: identity,
        since: claimWindowStart(),
        subjectRef: requestSubject(record.id),
        repoId: repo?.id ?? null,
        requestId: record.id,
      });
    }

    // While work is paused, across the install or in its repository, it is
    // kept and waits in line, started when work resumes.
    return answered(await triageFromQueue(queue, record.id, intake.name), deps.dispatchGate?.paused(repo?.name) ?? null);
  });

  router.post('/v1/requests/:id/triage', async ({ params }) => answered(await startTriage({ ...deps, requestQueue: queue }, params.id ?? '')));

  /**
   * Ends a request its person no longer wants, from its Needs you card: its
   * triage stopped, its questions closed, and never started again, whether it
   * was triaged or still waiting in the queue. See `abandonRequest`.
   */
  router.post('/v1/requests/:id/abandon', async ({ params, identity }) => {
    const done = await abandonRequest({
      requestId: params.id ?? '',
      actor: identity,
      note: 'the request was abandoned',
      stop: (taskId, actor, note) => stopTask(taskId, actor, note, hostd, { unfinished: true }),
    });
    if (done.outcome === 'unknown') throw new HttpFailure(404, 'unknown request');
    if (done.outcome === 'finished') throw new HttpFailure(409, `that request is ${done.state}, so there is nothing to abandon`);
    return { request: done.request, stopped: done.stopped, questionsClosed: done.questionsClosed };
  });

  /**
   * Runs a failed or stopped task again, from its card: the same work, by the
   * same bot, on the same subject. See `task-retry.ts`.
   */
  router.post('/v1/tasks/:id/retry', async ({ params, identity, role }) => {
    // A user may try a task again, but only an admin's Try again lets a revert
    // past a spending cap; see `retryTask`.
    const retried = await retryTask(params.id ?? '', identity, retryDepsFor({ ...deps, requestQueue: queue }), { byAdmin: role === 'admin' });
    deps.health?.runSoon(['idle-lease']);
    // A request's triage tried again while intake is busy waits its turn.
    return retried.queued ? new WithStatus(202, retried) : retried;
  });

  /**
   * Ends for good a task that failed, was stopped, or is paused with no
   * question open, from its card: its session and worktree go through hostd's
   * own cancel, its lease is let go, and the card with it. Before this the only
   * way was hostd's internal route by hand, which left the lease holding the
   * issue and the card offering "Try again" on work somebody had decided not to
   * finish.
   */
  router.post('/v1/tasks/:id/stop', async ({ params, identity, body }) => {
    const input = await body<{ reason?: string }>().catch(() => ({}) as { reason?: string });
    const stopped = await stopTask(params.id ?? '', identity, (input.reason ?? '').trim().slice(0, 300), hostd);
    deps.health?.runSoon(['idle-lease']);
    return stopped;
  });

  /**
   * Takes a failed or stopped task's card off without trying it again or
   * stopping anything: the work is left as it is. See `dismissTask`.
   */
  router.post('/v1/tasks/:id/dismiss', async ({ params, identity, body }) => {
    const input = await body<{ occurrence?: string }>().catch(() => ({}) as { occurrence?: string });
    return dismissTask(params.id ?? '', identity, typeof input.occurrence === 'string' ? input.occurrence.slice(0, 64) : undefined);
  });

  // Each request with its place in line while it is `queued` (1 is next), and
  // null otherwise, so the console can say "Queued (#2)".
  router.get('/v1/requests', async () => ({ requests: await withPositions(await requests.listRequests()) }));

  router.get('/v1/requests/:id', async ({ params }) => {
    const record = await requests.getRequest(params.id ?? '');
    if (!record) throw new HttpFailure(404, 'unknown request');
    const [request] = await withPositions([record]);
    return { request };
  });

  // How fast work moves and what holds it up, over the last `days` (7 or 30):
  // throughput, time per stage, waiting on overlap and its hot files, and
  // conflicts resolved at merge. See insights.ts.
  router.get('/v1/insights', async ({ query }) => {
    const days = query.get('days') === '30' ? 30 : 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const [data, issueList] = await Promise.all([insights.readInsightData(since), issues.listIssues()]);
    return aggregateInsights(withoutIgnored(data, issueList), { days, repo: query.get('repo') || null });
  });

  router.get('/v1/costs', async ({ query }) => {
    const period = query.get('period') ?? costs.currentPeriod();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new HttpFailure(400, 'period is a month, as YYYY-MM');
    await spendingLimits.seedGlobal(config.costs.monthlyCapUsd, config.costs.perTaskCapUsd);
    // Only this month's budget is made here. Any other was a row written for
    // whatever a caller named, by a GET anybody may send.
    const budget =
      (await costs.getBudget(period)) ??
      (period === costs.currentPeriod() ? await costs.ensureBudget(period, config.costs.monthlyCapUsd, config.costs.warningAt) : null);
    const taskCap = (await spendingLimits.amountOf('global', 'task')) ?? config.costs.perTaskCapUsd;
    const ciSince = monthStart(new Date());
    const [byBot, byRepo, byDay, ledger, all, ciRuns, ciCap, issueList] = await Promise.all([
      costs.spendByBot(period),
      costs.spendByRepo(period),
      costs.spendByDay(period),
      costs.listLedger(50),
      tasks.listTasks({ limit: 200 }),
      // GitHub Actions minutes this month, beside the model's spend; an
      // install whose database predates the table reads none.
      ciUsage.listSince(ciSince).catch(() => []),
      settings.getSetting('ciMinutesCap').catch(() => null),
      issues.listIssues(),
    ]);
    // What was spent stays in the totals, whatever it was spent on; a task on
    // an issue labelled `fleetadlc:ignore` is not listed as one to look at.
    const ignored = ignoredSubjects(issueList);

    return {
      period,
      budget,
      perTaskCapUsd: taskCap,
      byBot,
      byRepo,
      byDay,
      ledger,
      stoppedAtCap: all
        .filter((task) => task.costUsd >= task.costCapUsd && !ignored.has(task.subjectRef))
        .map((task) => ({ id: task.id, subjectRef: task.subjectRef, costUsd: task.costUsd })),
      ci: summarizeCi(ciRuns, { since: ciSince, cap: parseCap(ciCap) }),
    };
  });

  // The month's cap on GitHub Actions minutes: a whole number, or null for none.
  router.add('PUT', '/v1/costs/ci-cap', async ({ body, identity }) => {
    const input = await body<{ minutes?: unknown } | null>();
    const minutes = input?.minutes;
    if (minutes !== null && !(typeof minutes === 'number' && Number.isInteger(minutes) && minutes >= 0)) {
      throw new HttpFailure(400, 'the cap is a whole number of minutes, or null for none');
    }
    // Empty is no cap (`parseCap`).
    await settings.setSetting('ciMinutesCap', minutes === null ? '' : String(minutes), identity);
    await audit({ actor: identity, action: 'ci.cap', target: 'install', payload: { minutes } });
    return { cap: minutes };
  });

  // Any user may read the limits; saving them is an admin's (roles.ts).
  router.get('/v1/spending/limits', async () => spendingView(config.costs));

  // The console sends PUT. PATCH stays on the same handler so a page loaded
  // before that change, which sends only the fields it changed, still saves.
  const saveSpendingLimits = async ({
    body,
    identity,
  }: {
    body: <T>() => Promise<T>;
    identity: string;
  }) => {
    const input = await body<{ changes?: unknown } | null>();
    try {
      return await applySpendingLimits({ costs: config.costs, actor: identity, changes: input?.changes });
    } catch (error) {
      if (error instanceof SpendingLimitRejected) throw new HttpFailure(400, error.message);
      throw error;
    }
  };
  router.patch('/v1/spending/limits', saveSpendingLimits);
  router.add('PUT', '/v1/spending/limits', saveSpendingLimits);

  router.get('/v1/repos', async () => {
    const repoList = await repos.listRepos();
    const crew = await bots.listBots();
    const testingDeploy = (await settings.allSettings().catch(() => null))?.testingDeploy ?? null;
    return {
      repos: await Promise.all(
        repoList.map(async (repo) => {
          const choice = testingDeployChoice(testingDeploy, repo.name);
          return {
            ...repo,
            owner: crew.find((bot) => bot.id === repo.ownerBotId)?.name ?? null,
            // Whether the crew can work there: what the last look found, or null
            // before anything has looked.
            access: deps.crewAccess?.view(repo.fullName) ?? null,
            // Automatic unless this repository has chosen. shipsByMerging is what
            // Automatic resolved to, or the explicit answer, so the page can say it.
            testingDeploy: choice,
            shipsByMerging: await deploys.shipsByMerging(repo.fullName, choice),
            // How it ships by its rules, and where they came from: its
            // `.github/fleetadlc.yml`, its row, or the choice above.
            delivery: deps.delivery ? await deps.delivery.get(repo).catch(() => null) : null,
          };
        }),
      ),
      // How many rounds a review runs before it stops and asks: what the
      // Review stage does on its own, in settings' words. From config/review.yaml.
      maxReviewRounds: config?.review?.maxRounds ?? null,
    };
  });

  /**
   * "Hold this PR", from the steps for a post OpenADLC did not sign: the
   * pull request it was on gets `needs-human`, which the merge line reads as
   * a person's to decide (`mergeDecision`), GitHub's auto-merge is turned
   * off, and `review-gate` is held pending while the label is on, so nothing
   * the post changed lands on its own while someone looks. Taking the label
   * off lets it go again. The repository is named by its full name
   * (`owner/name`, encoded) or by OpenADLC's short name for it.
   */
  router.post('/v1/repos/:name/pulls/:number/hold', async ({ params, identity }) => {
    const named = params.name ?? '';
    const repo = named.includes('/')
      ? ((await repos.listRepos()).find((one) => one.fullName.toLowerCase() === named.toLowerCase()) ?? null)
      : await repos.getRepoByName(named);
    if (!repo) throw new HttpFailure(404, `OpenADLC does not work in ${named}`);
    const number = Number(params.number);
    if (!Number.isInteger(number) || number <= 0) throw new HttpFailure(400, 'say which pull request, by its number');
    const held = await deps.automation.holdPull(repo.fullName, number);
    if (!held) throw new HttpFailure(409, `${await automationBotName(config)} is not connected to GitHub, so nothing can be labelled. Connect it in Settings → Crew`);
    await audit({
      actor: identity,
      action: 'pull.held',
      target: `${repo.fullName}#${number}`,
      payload: { why: 'an unsigned crew post', autoMergeOff: held.autoMergeOff, gate: held.gate?.state ?? null },
    });
    return { held: `${repo.fullName}#${number}`, autoMergeOff: held.autoMergeOff, gate: held.gate?.state ?? null };
  });

  router.patch('/v1/repos/:name', async ({ params, body, identity }) => {
    const input = await body<{ concurrency?: number; stageModes?: Record<string, string>; color?: unknown; testingDeploy?: unknown; testingUrl?: unknown; defaultBranch?: unknown }>();
    // The branch every task starts from and every merge lands on. The
    // reconcile keeps it in step with GitHub; this is for a person who knows
    // better sooner.
    if (input.defaultBranch !== undefined && (typeof input.defaultBranch !== 'string' || !/^[^\s]+$/.test(input.defaultBranch))) {
      throw new HttpFailure(400, 'defaultBranch is a branch name, with no spaces');
    }
    if (input.testingDeploy !== undefined && !isTestingDeployChoice(input.testingDeploy)) {
      throw new HttpFailure(400, 'testingDeploy is one of automatic, has, none');
    }
    // Where testing is served, for a repository whose rules do not say. An
    // address the QA bot is sent to, so only http(s), and empty clears it.
    if (input.testingUrl !== undefined && input.testingUrl !== null && (typeof input.testingUrl !== 'string' || (input.testingUrl.trim() !== '' && !/^https?:\/\/\S+$/.test(input.testingUrl.trim())))) {
      throw new HttpFailure(400, 'testingUrl is an http(s) address, or empty to clear it');
    }
    // A name from the palette, never a value: the console decides what each
    // looks like in each mode, and anything else would be drawn as nothing.
    if (input.color !== undefined && !isRepoColor(input.color)) {
      throw new HttpFailure(400, `a repository's color is one of ${REPO_COLORS.join(', ')}`);
    }
    // An older console still sends `assist`, which is `autonomous` now. Anything
    // else that is not a stage and a mode is refused before it is normalised:
    // `normaliseStageModes` drops a value that is not a string, and when the
    // store replaced every stage's mode with what it was given, `{ merged: 5 }`
    // stored `{}` and wiped them all. It merges the stages given now.
    if (input.stageModes !== undefined) {
      if (!input.stageModes || typeof input.stageModes !== 'object' || Array.isArray(input.stageModes)) {
        throw new HttpFailure(400, 'stageModes is an object of a mode for each stage');
      }
      for (const [stage, mode] of Object.entries(input.stageModes as Record<string, unknown>)) {
        if (!(STAGE_KEYS as readonly string[]).includes(stage)) {
          throw new HttpFailure(400, `${stage} is not a stage; a stage is one of ${STAGE_KEYS.join(', ')}`);
        }
        // Checked before it is normalised, which reads it as `autonomous` and
        // would store that in silence.
        if (mode === 'untouched' && !mayBeUntouched(stage)) throw new HttpFailure(400, untouchedRefusal(stage));
        const read = typeof mode === 'string' ? normaliseStageModes({ [stage]: mode })[stage] : null;
        if (!read || !(STAGE_MODES as readonly string[]).includes(read)) {
          throw new HttpFailure(400, `${String(mode)} is not a stage mode; a stage's mode is one of ${STAGE_MODES.join(', ')}`);
        }
      }
    }
    const stageModes = input.stageModes ? normaliseStageModes(input.stageModes) : null;
    const name = params.name ?? '';
    // A choice on its own is not a column of the repository row. Asking the
    // update for an empty patch would still touch updated_at, and a repository
    // OpenADLC does not work in is refused before the setting is written.
    const choiceOnly =
      (input.testingDeploy !== undefined || input.testingUrl !== undefined) &&
      input.concurrency === undefined &&
      input.stageModes === undefined &&
      input.color === undefined &&
      input.defaultBranch === undefined;
    const updated = choiceOnly
      ? await repos.getRepoByName(name)
      : await repos.updateRepoSettings(name, {
          ...(input.concurrency ? { concurrency: input.concurrency } : {}),
          ...(stageModes ? { stageModes } : {}),
          ...(input.color !== undefined ? { color: input.color } : {}),
          ...(typeof input.defaultBranch === 'string' ? { defaultBranch: input.defaultBranch } : {}),
        });
    if (!updated) throw new HttpFailure(404, 'unknown repository');
    // One JSON map for every repository. Two saves at once each read the old
    // row and the write that finished last dropped the other repository's
    // choice — the same loss `workPausedRepos` had, which holds this lock.
    let shipsByMerging: boolean | null | undefined;
    if (isTestingDeployChoice(input.testingDeploy)) {
      const choice = input.testingDeploy;
      await withAdvisoryLock('bridge:testing-deploy', async () => {
        const stored = testingDeployStored(await settings.getSetting('testingDeploy'), updated.name, choice);
        await settings.setSetting('testingDeploy', stored, identity);
      });
      shipsByMerging = await deploys.shipsByMerging(updated.fullName, choice);
    }
    if (input.testingUrl !== undefined) {
      const url = typeof input.testingUrl === 'string' && input.testingUrl.trim() ? input.testingUrl.trim() : null;
      await repos.setDelivery(updated.id, { testingUrl: url });
    }
    // What the rules were read as is read again on the next ask.
    if (input.testingDeploy !== undefined || input.testingUrl !== undefined) deps.delivery?.forget(updated.fullName);
    await audit({
      actor: identity,
      action: 'repo.settings',
      target: params.name ?? '',
      payload: input as Record<string, unknown>,
    });
    return {
      repo: updated,
      // What this save resolved to, so Automatic's line updates without a reload.
      ...(shipsByMerging !== undefined ? { testingDeploy: input.testingDeploy, shipsByMerging } : {}),
    };
  });

  /**
   * What removing a repository from OpenADLC would do, as it is now: its work in
   * flight and open questions, its leases, the crew's accounts on it, OpenADLC's
   * labels there, and whether the app still reaches it. The console's review
   * step, before anything is pressed. Changes nothing.
   */
  router.get('/v1/repos/:name/removal', async ({ params }) => {
    const preview = await removal.preview(params.name ?? '');
    if (!preview) throw new HttpFailure(404, 'unknown repository');
    return { removal: preview };
  });

  /**
   * Takes a repository out of OpenADLC, and ends what OpenADLC had going there: its
   * tasks are stopped, its questions closed and its leases released, and,
   * as the review step chose, the crew's accounts come off it and OpenADLC's
   * labels are deleted. See `repo-removal.ts`.
   *
   * Nothing else is deleted: its issues, pull requests, workflows and
   * environments stay on GitHub, and its tasks, threads and costs stay in
   * OpenADLC as history. Adding it again brings it back with its settings.
   * What could not be done is in `notDone`, and running this again does it.
   */
  router.post('/v1/repos/:name/remove', async ({ params, identity, body }) => {
    type Choices = { crewAccess?: unknown; labels?: unknown; maybeTheirs?: unknown };
    const input = await body<Choices>().catch(() => ({}) as Choices);
    for (const key of ['crewAccess', 'labels', 'maybeTheirs'] as const) {
      if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new HttpFailure(400, `${key} is true or false`);
    }
    const report = await removal.remove(params.name ?? '', identity, {
      crewAccess: (input.crewAccess as boolean | undefined) ?? DEFAULT_REMOVAL.crewAccess,
      labels: (input.labels as boolean | undefined) ?? DEFAULT_REMOVAL.labels,
      maybeTheirs: (input.maybeTheirs as boolean | undefined) ?? DEFAULT_REMOVAL.maybeTheirs,
    });
    if (!report) throw new HttpFailure(404, 'unknown repository');
    deps.health?.runSoon(['idle-lease']);
    return report;
  });

  /**
   * Lets the crew into one repository now, and says how it went: settings'
   * "Try again". Each bot that can already work there is left as it is; the
   * others are invited with their role's access and accept their own
   * invitation where they are connected.
   */
  router.post('/v1/repos/:name/access', async ({ params, identity }) => {
    const repo = await repos.getRepoByName(params.name ?? '');
    if (!repo) throw new HttpFailure(404, 'unknown repository');
    if (!deps.crewAccess) throw new HttpFailure(501, 'this bridge does not let the crew into repositories');
    return { access: await deps.crewAccess.ensure(repo.fullName, 'retry', { actor: identity }) };
  });

  router.get('/v1/tasks', async ({ query }) => {
    const limit = Number(query.get('limit') ?? '50');
    return { tasks: await tasks.listTasks({ limit }) };
  });

  router.get('/v1/leases', async () => ({ leases: await leases.listActiveLeases() }));

  router.get('/v1/audit', async ({ query }) => ({
    audit: await listAudit(Number(query.get('limit') ?? '100')),
  }));

  router.get('/v1/status', async () => buildStatus(config, hostd));

  router.get('/v1/onboarding', async ({ query }) => deps.onboarding.view(query.get('email')));

  // What the board asks on every load and every refresh, to decide whether to
  // send someone to the walkthrough. The walkthrough itself asks GitHub about
  // every bot in every repository, which an open board did every 15 seconds.
  router.get('/v1/onboarding/complete', async () => ({ complete: await deps.onboarding.complete() }));

  /**
   * Who that name belongs to on GitHub, while somebody is still typing it.
   *
   * Unauthenticated when nothing is connected yet, which at the first step of
   * onboarding is always — so it is rate-limited, cached, and never the reason
   * a step cannot be finished.
   */
  router.get('/v1/github/accounts', async ({ query }) => {
    // An authenticated search gets a larger budget, so use a bot's token when
    // there is one. There will not be on a fresh install, which is the case
    // this endpoint exists for.
    const token = await deps.actors
      .tokenFor(await automationBotName(config))
      .then((minted) => minted?.token ?? null)
      .catch(() => null);

    return lookUpAccount(query.get('q') ?? '', { token });
  });

  // Before anything is asked of GitHub: the app reaches more repositories than
  // OpenADLC works in, and `gh` runs as the person for whatever name it is given.
  const ourRepository = (name: string): Promise<string> =>
    worksIn(name).catch((error: unknown) => {
      throw error instanceof NotOurRepository ? new HttpFailure(400, error.message) : error;
    });

  /**
   * What is waiting to be accepted, and accepting it.
   *
   * Split because the two halves need different identities: seeing an invitation
   * needs admin on the repository, accepting one needs to *be* the invitee. The
   * console shows the first and OpenADLC performs the second.
   */
  router.get('/v1/invitations', async ({ query }) => {
    const named = query.get('repo');
    if (named) {
      const repository = await ourRepository(named);
      return { repository, ...(await deps.invitations.discover(repository)) };
    }

    // Every repository OpenADLC works in, each with what is waiting in it. The
    // first one's is also said the way it always was, for an older console.
    const repoList = await repos.listRepos();
    if (repoList.length === 0) return { repository: null, pending: [], reason: 'no repository is configured yet', repositories: [] };
    const repositories = [];
    for (const repo of repoList) repositories.push({ repository: repo.fullName, ...(await deps.invitations.discover(repo.fullName)) });
    return {
      repository: repositories[0]!.repository,
      pending: repositories.flatMap((one) => one.pending),
      reason: repositories.find((one) => one.reason)?.reason ?? null,
      repositories,
    };
  });

  /**
   * Invites the crew and lets them in, in one act.
   *
   * The app sends the invitations — the only identity that can, since inviting
   * needs admin — and each reply carries the id the matching bot then presents
   * to accept it.
   */
  router.post('/v1/invitations/invite', async ({ body, identity }) => {
    const input = await body<{ repo?: string }>();
    const repoList = await repos.listRepos();
    // The one named, or every repository OpenADLC works in: the crew is let into
    // all of them, not only the first.
    const targets = input.repo ? [await ourRepository(input.repo)] : repoList.map((repo) => repo.fullName);
    if (targets.length === 0) throw new HttpFailure(400, 'no repository is configured yet');

    const repositories: { repository: string; results: Awaited<ReturnType<InvitationService['inviteAndAccept']>>['results']; error: string | null }[] = [];
    for (const target of targets) {
      if (deps.crewAccess) {
        // Through what keeps the crew in, so settings says what this found.
        const access = await deps.crewAccess.ensure(target, 'invite', { actor: identity });
        repositories.push({ repository: target, results: access.error ? [] : access.bots, error: access.error });
      } else {
        const result = await deps.invitations
          .inviteAndAccept(target)
          .then((found) => ({ results: found.results, error: null }))
          .catch((error: unknown) => ({ results: [], error: error instanceof Error ? error.message : String(error) }));
        repositories.push({ repository: target, ...result });
      }
    }

    // One repository that could not be looked at is the refusal it always was.
    if (repositories.length === 1 && repositories[0]!.error) throw new HttpFailure(400, repositories[0]!.error);

    for (const one of repositories) {
      await audit({
        actor: identity,
        action: 'invitations.invited',
        target: one.repository,
        payload: one.error ? { error: one.error } : { results: one.results.map((bot) => ({ bot: bot.bot, state: bot.state })) },
      });
    }
    deps.health?.runSoon(['bot-access']);
    return {
      results: acrossRepositories(repositories.filter((one) => !one.error).map((one) => ({ repository: one.repository, bots: one.results }))),
      repositories,
    };
  });

  router.post('/v1/invitations/accept', async ({ body, identity }) => {
    const input = await body<{ pending?: unknown; json?: string; repo?: string }>();

    // Either the console hands back what `discover` found, or a person pasted
    // the output of `gh api` because this install has no `gh` to ask.
    // Both through the same check (`acceptable`): an id goes into the path
    // GitHub is asked on, and the list the console sent was passed on unread.
    const pending = acceptable(input.json ? pendingInvitationsFrom(input.json) : Array.isArray(input.pending) ? input.pending : []);

    if (pending.length === 0) throw new HttpFailure(400, 'nothing to accept');

    const results = await deps.invitations.accept(pending);
    // Each invitation's own repository: a paste can hold several, and the one
    // the console named is only the first.
    const repositoryOf = (id: number): string | null => pending.find((one) => one.id === id)?.repository || null;
    await audit({
      actor: identity,
      action: 'invitations.accepted',
      target: input.repo ?? 'repository',
      payload: { results: results.map((r) => ({ bot: r.bot, action: r.outcome.action, repository: repositoryOf(r.id) })) },
    });
    return { results };
  });

  /**
   * The manifest for an app whose webhook is `publicUrl` — switched on — or,
   * without one, a placeholder switched off, and where to post it.
   */
  // One per create the walkthrough starts (`app-manifest-state.ts`).
  const manifestStates = new AppManifestStates();

  const manifestFor = async (publicUrl: string | null) => {
    const live = await effectiveConfig(config);
    const isOrg = live.organization
      ? await lookUpAccount(live.organization)
          .then((found) => found.exact?.type === 'Organization')
          .catch(() => false)
      : false;

    return {
      /** Whose app a code from this form may be: the organization, or null for a person's form. */
      owner: isOrg ? live.organization : null,
      postUrl: manifestPostUrl(live.organization || null, isOrg),
      manifest: buildAppManifest({
        consoleUrl: config.consoleUrl,
        webhookUrl: publicUrl ? `${publicUrl.replace(/\/$/, '')}/webhooks/github` : '',
        organization: live.organization || null,
      }),
    };
  };

  /**
   * The manifest GitHub should create this install's app from, and where to post
   * it. The console renders a form; GitHub shows its own create page with all of
   * this already filled in.
   *
   * Asked without doing anything, so it also says what creating the app will
   * take: `have` an address, so the manifest here is the one to post; a
   * `tunnel` to raise first, which `POST /v1/app-manifest/prepare` does; or
   * `none`, and the app is created with its webhook switched off.
   */
  router.get('/v1/app-manifest', async () => {
    const address = await deps.webhookSetup.newAppAddress();
    const live = await effectiveConfig(config);
    // Looking issues no state: only a create, through `prepare`, does.
    const { postUrl, manifest } = await manifestFor(address === 'have' ? live.publicUrl : null);
    return { postUrl, manifest, address };
  });

  /**
   * The manifest to create the app from now, with an address raised for it
   * first when there is none and one can be.
   *
   * An app created without an address is created with its webhook switched
   * off, and no API can switch it on: `PATCH /app/hook/config` writes the
   * address and the secret and leaves it off. That is how an install came to
   * have every setting right and GitHub sending it nothing. The manifest's
   * `active` is the one switch OpenADLC can reach, and only while the app is
   * being made — so the tunnel comes first, when the person presses create.
   */
  router.post('/v1/app-manifest/prepare', async ({ body, identity }) => {
    // "Create it without an address" asks for no tunnel, and still needs a state.
    const { withoutAddress } = await body<{ withoutAddress?: unknown }>().catch(() => ({ withoutAddress: undefined }));
    let publicUrl: string | null = null;
    if (withoutAddress !== true) {
      try {
        publicUrl = await deps.webhookSetup.addressForNewApp();
      } catch (cause) {
        // cloudflared's own reason, which is usually what to do about it.
        throw new HttpFailure(400, cause instanceof Error ? cause.message : 'could not give this bridge an address');
      }
    }

    if (publicUrl) {
      await audit({ actor: identity, action: 'install.app_address', target: 'install', payload: { publicUrl } });
    }
    const { owner, postUrl, manifest } = await manifestFor(publicUrl);
    // GitHub sends `state` back beside the code, and only a code that comes
    // back with one issued here is exchanged.
    const state = manifestStates.issue(owner);
    return { postUrl: `${postUrl}?state=${state}`, manifest, address: publicUrl ? ('have' as const) : ('none' as const) };
  });

  /**
   * Exchanges the one-time code GitHub redirects back with.
   *
   * This is the whole point of the manifest flow: the reply carries the client
   * id, the private key, the webhook secret and the client secret, so none of
   * them is ever copied between two browser tabs. All are stored here and none
   * is returned. The client secret used to be dropped; it is what narrows each
   * task's token to its own repository (`createScopedToken`).
   *
   * Only with a state `prepare` issued, used once and within the hour: a GET
   * of the console's app-created page with any code — one an attacker minted
   * from a manifest of their own — replaced the install's app, its key and its
   * secrets. The state is spent before GitHub is asked, so a replay fails even
   * when the first exchange did.
   */
  router.post('/v1/app-manifest/exchange', async ({ body, identity }) => {
    const { code, state } = await body<{ code?: string; state?: string }>();
    const started = manifestStates.consume(typeof state === 'string' ? state : null);
    if (!started) {
      throw new HttpFailure(
        400,
        'this app was not created from this install’s walkthrough just now, or that link was already used or is over an hour old; press create again on the onboarding page',
      );
    }
    if (!code) throw new HttpFailure(400, 'no code to exchange');

    const response = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: 'POST',
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });
    const text = await response.text();
    if (!response.ok) {
      // The likeliest one by far: the code is good for an hour and somebody came
      // back to a stale tab.
      throw new HttpFailure(
        400,
        response.status === 404
          ? 'that registration code is expired or already used; start the app again'
          : `GitHub answered ${response.status}: ${text.slice(0, 160)}`,
      );
    }

    const created = JSON.parse(text) as {
      client_id?: string;
      client_secret?: string | null;
      pem?: string;
      webhook_secret?: string | null;
      slug?: string;
      html_url?: string;
      owner?: { login?: string } | null;
    };
    if (!created.client_id || !created.pem) throw new HttpFailure(400, 'GitHub returned no client id or key');
    // Posted to an organization's form, the app is that organization's; one
    // any other account owns is not this install's.
    const ownedBy = created.owner?.login ?? null;
    if (started.expectedOwner && (!ownedBy || !sameLogin(ownedBy, started.expectedOwner))) {
      throw new HttpFailure(
        400,
        `that app belongs to ${ownedBy ?? 'an account GitHub did not name'}, not ${started.expectedOwner}, which this install creates its app in; press create again on the onboarding page`,
      );
    }

    await settings.setSetting('githubClientId', created.client_id, identity);
    await getSecretStore().set(appPrivateKeyRef(), created.pem);
    if (created.client_secret) await getSecretStore().set(appClientSecretRef(), created.client_secret);
    if (created.webhook_secret) {
      await storeWebhookSecret(created.webhook_secret, identity);

      // An app created with its webhook on sends a ping as it is made, and it
      // arrives while this exchange is still on its way — signed with the
      // secret just stored, which the bridge did not hold yet, so it was
      // refused. Asked for again now, it goes through, and GitHub's record of
      // the first delivery is one that shows the whole path works. Best effort:
      // an app created with its webhook off has nothing to send again.
      await redeliverLatestFailure(APP_API, { clientId: created.client_id, privateKey: created.pem }).catch(() => false);
    }

    await audit({
      actor: identity,
      action: 'install.app_created',
      target: created.slug ?? 'github-app',
      // The names of what was stored, never the values: all but the client id
      // are credentials.
      payload: {
        stored: [
          'githubClientId',
          'appPrivateKey',
          ...(created.client_secret ? ['appClientSecret'] : []),
          ...(created.webhook_secret ? ['webhookSecret'] : []),
        ],
      },
    });

    // A new app is what every app check is about.
    deps.health?.runSoon(['app-installed', 'app-permissions', 'device-flow', 'webhook', 'app-client-secret']);
    return { slug: created.slug ?? null, htmlUrl: created.html_url ?? null };
  });

  /**
   * A name for this bot's account that nobody already holds.
   *
   * Candidates are tried in order and the first free one wins, so what the page
   * shows is a name that will still be free when somebody types it into the
   * sign-up form. A suggested login was already taken by a stranger and an
   * install ran pointed at their account; this is the check that was missing.
   */
  router.get('/v1/github/suggest-login', async ({ query }) => {
    const bot = query.get('bot') ?? '';
    if (!bot) throw new HttpFailure(400, 'say which bot: ?bot=<seat>');

    const live = await effectiveConfig(config);

    // Any connected bot's token will do, and an authenticated lookup has a far
    // larger budget than sixty an hour — which nine bots and a repeated invite
    // exhaust quickly, and an exhausted budget is why this could not confirm
    // anything and fell back to suggesting a name it knew was taken.
    let token: string | null = null;
    for (const candidate of await bots.listBots()) {
      token = await deps.actors
        .tokenFor(candidate.name)
        .then((minted) => minted?.token ?? null)
        .catch(() => null);
      if (token) break;
    }

    const candidates = loginCandidates(bot, live.organization || null);
    const checked: { login: string; available: boolean | null }[] = [];

    for (const candidate of candidates) {
      const available = await loginAvailable(candidate, { token });
      checked.push({ login: candidate, available });
      // Stop at the first free one rather than checking them all.
      if (available === true) break;
    }

    const free = checked.find((one) => one.available === true);
    // Never suggest one that is known to be taken, even when nothing could be
    // confirmed: an unconfirmed guess is worth offering, a known collision is
    // not. Suggesting it and then saying it was taken, in the same breath, is
    // what this did.
    const usable = free ?? checked.find((one) => one.available === null);

    return {
      suggestion: usable?.login ?? null,
      /** False when nothing could be checked, or every candidate is taken. */
      confirmedFree: Boolean(free),
      /** True when GitHub answered for everything and all of it was taken. */
      allTaken: checked.length > 0 && checked.every((one) => one.available === false),
      checked,
    };
  });

  /**
   * Whether the two settings the manifest cannot set were actually ticked.
   *
   * Asked of GitHub rather than of the person, because both fail late: a missing
   * device flow surfaces as a connect button that errors, and a missing token
   * expiry as credentials that never rotate.
   */
  router.get('/v1/app-checks', async () => {
    const live = await effectiveConfig(config);
    const crew = await bots.listBots();

    let anyConnected = false;
    let anyRefreshToken = false;
    for (const bot of crew) {
      const kind = await signInKind(bot);
      if (kind) anyConnected = true;
      if (kind === 'refresh') anyRefreshToken = true;
    }

    const repoList = await repos.listRepos();
    // The first repository the app cannot reach, if there is one, rather than
    // the first repository: an install that works in two named the one that was
    // fine and offered an install button for it, while the one that was not
    // said nothing. And what to do comes from app-reach, which knows a private
    // app cannot be installed on another account — the plain install button
    // this used to offer went to a page that could only show its owner.
    let blocked: Awaited<ReturnType<AppReach['reach']>> | null = null;
    if (deps.appReach) {
      for (const repo of repoList) {
        const reached = await deps.appReach.reach(repo.fullName);
        if (reached.state === 'blocked') {
          blocked = reached;
          break;
        }
      }
    }
    const checks = await checkApp({
      clientId: live.gitHubClientId,
      privateKey: await getSecretStore().get(appPrivateKeyRef()),
      repoFullName: blocked?.repository ?? repoList[0]?.fullName ?? null,
      account: live.organization || null,
      anyConnected,
      anyRefreshToken,
    });
    // The walkthrough asks this when the person comes back from GitHub, having
    // just changed something there. The cards on the page come from the health
    // checks, which ran on their own schedule, so the card said Device Flow was
    // off minutes after this panel had seen it on. Asked now, they agree.
    deps.health?.runSoon(['device-flow', 'app-installed', 'app-permissions']);
    return {
      ...checks,
      fix:
        blocked?.state === 'blocked'
          ? { need: blocked.need, title: blocked.title, detail: blocked.detail, action: blocked.action, steps: blocked.steps }
          : null,
    };
  });

  /**
   * The install's own settings, so a person can finish a setup without a shell.
   *
   * Everything here used to live in `~/.fleetadlc/install.json`, written by
   * `fleetadlc init` and read into the environment once at start-up. The console
   * could therefore say "no GitHub App client id" and offer no way to give it
   * one, which is the single thing standing between a running stack and a
   * working install.
   */
  router.get('/v1/install', async () => {
    const stored = await settings.allSettings();
    const live = await effectiveConfig(config);
    return {
      organization: live.organization,
      installName: live.installName,
      attributionMode: live.attributionMode,
      githubClientId: live.gitHubClientId,
      // The bot that is the automation account now — its handle once one is
      // connected — rather than whatever an override said to look for.
      automationBot: await automationBotName(config),
      humans: live.humans.join(', '),
      operatorEmail: live.operatorEmail,
      publicUrl: live.publicUrl,
      // Never the value. Whether one is set is what a person needs to know, and
      // returning it would put a webhook signing key in a browser.
      webhookSecretConfigured: live.webhookSecretConfigured,
      // Whether OpenADLC can invite the crew itself, or somebody must do it by hand.
      appPrivateKeyConfigured: Boolean(await getSecretStore().get(appPrivateKeyRef())),
      // Whether each task's token can be narrowed to its repository. Never the value.
      appClientSecretConfigured: Boolean(await getSecretStore().get(appClientSecretRef())),
      // So the page can say which of these the environment is supplying and
      // would go back to if the field were cleared.
      storedKeys: Object.keys(stored),
      webhookUrl: `${live.publicUrl || 'https://your-bridge.example.com'}/webhooks/github`,
    };
  });

  /**
   * Where GitHub should deliver, and whether it currently does.
   *
   * Reported rather than remembered: the app's webhook can be changed from
   * GitHub's own settings page, and a quick tunnel's address dies with the
   * process that raised it — so an install can be configured on Monday and
   * receiving nothing on Tuesday with no setting having changed.
   */
  router.get('/v1/webhook', async () => deps.webhookSetup.status());

  /**
   * Does the step. `tunnel` for a bridge on somebody's machine, `address` for one
   * that already has a public name.
   *
   * A tunnel is a public address for this install, so it is only ever raised by
   * somebody asking for it here — never on start-up, and never as a side effect
   * of anything else.
   */
  router.post('/v1/webhook/configure', async ({ body, identity }) => {
    const input = await body<{ mode?: string; url?: string }>();
    if (input.mode !== 'tunnel' && input.mode !== 'address') {
      throw new HttpFailure(400, 'mode must be tunnel or address');
    }

    let status;
    try {
      status = await deps.webhookSetup.configure({ mode: input.mode, url: input.url });
    } catch (cause) {
      // The reason reaches the page. "Could not configure" sends somebody to a
      // terminal to find out what this already knew.
      throw new HttpFailure(400, cause instanceof Error ? cause.message : 'could not configure the webhook');
    }

    await audit({
      actor: identity,
      action: 'install.webhook_configured',
      target: 'install',
      // The address, never the secret.
      payload: { mode: input.mode, publicUrl: status.publicUrl, ready: status.ready },
    });

    deps.health?.runSoon(['webhook']);
    return status;
  });

  /**
   * The repositories the app was installed on, for the picker.
   *
   * Empty before the app exists or before it is installed anywhere, which is
   * not an error — it is the ordinary state of the step before this one, and
   * the page offers a text field instead.
   */
  router.get('/v1/onboarding/repositories', async () => {
    const live = await effectiveConfig(config);
    const privateKey = await getSecretStore().get(appPrivateKeyRef());

    if (!privateKey || !live.gitHubClientId) {
      return { repositories: [], reason: 'the app is not set up yet' };
    }

    // A failure is said as itself: read as an empty list, a wrong key or
    // client id looked like an app installed nowhere.
    const found = await installedRepositories(APP_API, {
      clientId: live.gitHubClientId,
      privateKey,
    }).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
    if (found instanceof Error) {
      return { repositories: [], reason: `GitHub would not list the app's installations: ${found.message.slice(0, 200)}` };
    }

    // Only the accounts the install works in. A public app can be installed
    // by anyone, and "Select all" offered a stranger's repositories beside
    // the install's own. Those accounts are named, for an admin to allow.
    const known = deps.appReach ? await deps.appReach.accountsWorkedIn().catch(() => null) : null;
    const { offered, unknownAccounts } = known ? onAccountsWorkedIn(found, known) : { offered: found, unknownAccounts: [] };

    return {
      repositories: offered,
      unknownAccounts,
      reason: offered.length > 0 ? '' : found.length === 0 ? 'the app is not installed on any repository yet' : 'the app is installed only on accounts this install does not work in',
    };
  });

  /**
   * Allows an account beyond those the install works in, so the app's
   * installation there counts and its repositories can be added. An admin's,
   * after the warning the console shows: the crew is invited to its
   * repositories, and whoever can write there can answer the crew's
   * questions. Asked without `understood`, it answers with that warning.
   */
  router.post('/v1/github/allowed-accounts', async ({ body, identity }) => {
    const input = await body<{ account?: unknown; understood?: unknown }>();
    const account = typeof input.account === 'string' ? input.account.trim().replace(/^@/, '') : '';
    if (!isGitHubLogin(account)) throw new HttpFailure(400, `“${account || 'that'}” is not a GitHub account: give its login, without an @`);
    if (input.understood !== true) {
      throw new HttpFailure(
        400,
        `Allowing ${account} lets OpenADLC work in repositories there: the crew is invited to them, and whoever can write there can answer the crew’s questions. ` +
          'Check it is an account you work in, not a look-alike, then allow it again with understood set.',
      );
    }
    const already = ((await settings.getSetting('allowedAccounts')) ?? '').split(',').map((one) => one.trim().toLowerCase()).filter(Boolean);
    const allowed = [...new Set([...already, account.toLowerCase()])];
    await settings.setSetting('allowedAccounts', allowed.join(','), identity);
    await audit({ actor: identity, action: 'github.account_allowed', target: account, payload: { allowed } });
    deps.appReach?.clear();
    return { allowed };
  });

  /**
   * Adds a repository for the crew to work in: the walkthrough's step, one
   * repository at a time, and settings' "Add a repository".
   *
   * Which repositories an install works in used to come only from
   * `config/repos.yaml`, committed into the repository — so a clone arrived
   * pointed at whatever that file said, the walkthrough presented it as
   * settled, and the app step offered to install a GitHub App on somebody
   * else's repository. Nobody was ever asked.
   *
   * Everything but the name, the full name and the owning bot has a default, so
   * this takes one field. A repository already here keeps its settings, and one
   * removed comes back with them. Configuring it in `config/repos.yaml` still
   * works and is the reviewable way to do it; this is the way that does not
   * require editing a file and restarting.
   */
  router.post('/v1/onboarding/repository', async ({ body, identity }) => {
    const input = await body<{ fullName?: string }>();
    const repository = repositoryFrom(input.fullName ?? '');
    if (!repository) {
      throw new HttpFailure(400, `${(input.fullName ?? '').trim() || 'that'} is not a repository — give it as owner/name`);
    }
    const { owner, name } = repository;

    // The app goes on first. A repository it cannot reach is one no invitation,
    // rule or webhook can be set up in, and adding it anyway left a line in
    // settings that could only fail. What to do is sent with the refusal, so
    // the page can show it; no answer from GitHub is no reason to refuse.
    const reached = await deps.appReach?.reach(repository.fullName);
    if (reached?.state === 'blocked') {
      const { need, title, detail, action, steps } = reached;
      throw new HttpFailure(409, title, { needs: { need, title, detail, action, steps } });
    }
    // The bot that owns the work in it: its builder, which the dispatcher
    // leases the repository's implementation to. `config/repos.yaml` can name
    // another. It was the automation account once, as the one bot every
    // install has — and that account thinks with no model.
    const ownerBot = builderOf(await bots.listBots());
    // The branch every task starts from, as GitHub has it: a `main` assumed
    // here failed every task in a repository whose default is `master`. What
    // the request says is not asked. Unanswered, it is no reason to refuse
    // either: the reconcile asks again.
    const defaultBranch = (await deps.defaultBranchOf?.(repository.fullName).catch(() => null)) ?? null;
    if (!defaultBranch) {
      console.warn(`[bridge] ${repository.fullName}: GitHub did not say its default branch, so it is unconfirmed; the next reconcile checks it`);
    }

    let added: Awaited<ReturnType<typeof repos.addRepo>>;
    try {
      added = await repos.addRepo({
        name,
        fullName: `${owner}/${name}`,
        ownerBotId: ownerBot?.id ?? null,
        // The defaults a repository seeded from config/repos.yaml starts with too.
        concurrency: REPO_DEFAULTS.concurrency,
        stageModes: { ...REPO_DEFAULTS.stageModes },
        specRequiredLabels: [...REPO_DEFAULTS.specRequiredLabels],
        humanReviewPaths: [...REPO_DEFAULTS.humanReviewPaths],
        defaultBranch,
      });
    } catch (error) {
      if (error instanceof repos.RepoNameTaken) throw new HttpFailure(409, error.message);
      throw error;
    }

    await audit({
      actor: identity,
      action: 'install.repository_set',
      target: added.repo.fullName,
      payload: { outcome: added.outcome, color: added.repo.color },
    });

    // The crew is let in straight away, for this repository as much as the
    // first: settings says how it went, and the next reconcile tries again.
    if (deps.crewAccess) void deps.crewAccess.ensure(added.repo.fullName, 'added', { actor: identity }).catch(() => undefined);

    return {
      repository: added.repo.fullName,
      outcome: added.outcome,
      repo: added.repo,
      access: deps.crewAccess?.view(added.repo.fullName) ?? null,
    };
  });

  /**
   * Whether the crew can think.
   *
   * Nothing in setup asked for this, so an install could finish every step and
   * report itself complete with no engine configured at all — and find out when
   * a task failed on the host, after a request had been filed and a board
   * watched. Asked of hostd, because the CLIs and keys are in *its* environment.
   */
  router.get('/v1/engines', async () => {
    const crew = await bots.listBots();
    // By seat, or for a seat the file does not name (builder-2, added from
    // settings) its role's first seat's, as the assignment route reads it.
    const configuredOf = (bot: { slot: string; role: BotRole }) => {
      const entry = configuredFor(deps.config?.configRoot, bot);
      return entry ? { configuredEngine: entry.engine, configuredModel: entry.model } : {};
    };

    const reported = await deps.hostd
      .engines()
      .catch((cause: unknown) => ({
        host: undefined,
        bots: [] as { bot: string; readiness: EngineReadiness }[],
        error: cause instanceof Error ? cause.message.slice(0, 200) : 'hostd did not answer',
      }));

    const byBot = new Map((reported.bots ?? []).map((one) => [one.bot, one.readiness]));
    // Whether each holds a GitHub credential, the walkthrough's own test. The
    // name is its handle once it does, and its seat until then.
    const connected = new Map(
      await Promise.all(
        crew.map(
          async (bot) =>
            [
              bot.id,
              holdsCredential(
                await signInKind(bot).catch(() => null),
                await credentials.getCredential(bot.id).catch(() => null),
              ),
            ] as const,
        ),
      ),
    );

    return {
      host: reported.host ?? null,
      // Unreachable is not the same as unready, and the page must not read one
      // as the other: a stopped hostd means unknown, not "no models".
      reachable: !('error' in reported && reported.error),
      detail: 'error' in reported ? reported.error : '',
      bots: crew.map((bot) => ({
        bot: bot.name,
        slot: bot.slot,
        connected: connected.get(bot.id) ?? false,
        role: bot.role,
        roleLabel: roleLabel(bot.role),
        engine: bot.engine,
        model: bot.model,
        modelAccountId: bot.modelAccountId,
        // What the configuration gives the bot, which the console proposes
        // from; `engine` and `model` are what is saved, which an operator may
        // have changed. Absent when the file cannot be read.
        ...configuredOf(bot),
        readiness: byBot.get(bot.name) ?? null,
      })),
    };
  });

  /**
   * What the last step would change, before it changes anything.
   *
   * This ended the walkthrough as two commands to paste into a shell, on the
   * grounds that both act on the repository and should not happen without being
   * asked for. True, and not an argument for a terminal — a button that lists
   * what it will do is a better asking than a command that acts sight-unseen.
   * This is the listing; the two routes below are the doing.
   */
  router.get('/v1/repo-setup', async ({ query }) => ({
    repositories: await deps.repoSetup.plan(query.get('repo') ?? undefined),
  }));

  /** The board's columns. Additive — nothing on the repository is ever deleted. */
  router.post('/v1/repo-setup/labels', async ({ body, identity }) => {
    const input = await body<{ repo?: string }>();
    if (!input.repo) throw new HttpFailure(400, 'say which repository');

    const changes = await deps.repoSetup.applyLabels(input.repo).catch((cause: unknown) => {
      throw new HttpFailure(400, cause instanceof Error ? cause.message : 'could not write the labels');
    });

    await audit({
      actor: identity,
      action: 'repo.labels_synced',
      target: input.repo,
      payload: { written: changes.filter((one) => one.action !== 'unchanged').length },
    });

    return { repository: input.repo, changes };
  });

  /**
   * The containment: rulesets where the plan supports them, the environments, a
   * CODEOWNERS where there is none, and the templates a repository is missing.
   *
   * Runs as the app. A bot's token is the app's permissions intersected with
   * that account's own access and the crew hold `write` at most, so the
   * admin-gated half of this was out of reach of the account the CLI used.
   */
  router.post('/v1/repo-setup/rules', async ({ body, identity }) => {
    const input = await body<{ repo?: string; force?: boolean }>();
    if (!input.repo) throw new HttpFailure(400, 'say which repository');

    // "Apply again": forget what GitHub's plan refused here and ask it again.
    if (input.force === true) {
      await audit({ actor: identity, action: 'repo.plan_limits_cleared', target: input.repo, payload: { by: 'apply again' } });
    }

    const outcomes = await deps.repoSetup.applyRules(input.repo, { force: input.force === true }).catch((cause: unknown) => {
      throw new HttpFailure(400, cause instanceof Error ? cause.message : 'could not apply the rules');
    });

    await audit({
      actor: identity,
      action: 'repo.rules_applied',
      target: input.repo,
      payload: rulesAppliedPayload(outcomes),
    });

    // `repo-config` too: the files this writes — AGENTS.md naming who approves
    // — are what it reads, and its card stayed up for its whole half hour
    // after the step had fixed the file.
    deps.health?.runSoon(['repo-rules', 'signing-key', 'repo-config']);
    return { repository: input.repo, outcomes };
  });

  /**
   * How a repository's production ships, chosen in repository setup:
   * automatically after a soak on testing, or after a named person approves.
   * Recorded on the repository (`repos.production_*`), it fills what the
   * delivery rules leave out. `reviewers` names people: nobody, a crew
   * account or the organization is refused, since production would then be
   * written for nobody, for a bot, or for an account that cannot review.
   */
  router.post('/v1/repo-setup/production', async ({ body, identity }) => {
    const input = await body<{ repo?: unknown; approval?: unknown; soakMinutes?: unknown; reviewers?: unknown }>();
    const name = typeof input.repo === 'string' ? input.repo.trim() : '';
    if (!name) throw new HttpFailure(400, 'say which repository');
    const repo = (await repos.listRepos()).find((one) => one.fullName.toLowerCase() === name.toLowerCase() || one.name === name);
    if (!repo) throw new HttpFailure(404, `OpenADLC does not work in a repository named ${name}`);

    const approval = input.approval;
    if (approval !== 'auto' && approval !== 'reviewers') {
      throw new HttpFailure(400, 'say how production ships: `approval` is `auto` (after a soak on testing) or `reviewers` (after a named person approves)');
    }
    const soakMinutes = input.soakMinutes === undefined || input.soakMinutes === null ? (approval === 'auto' ? 30 : 0) : input.soakMinutes;
    if (typeof soakMinutes !== 'number' || !Number.isInteger(soakMinutes) || soakMinutes < 0 || soakMinutes > 43_200) {
      throw new HttpFailure(400, 'the soak is a whole number of minutes from 0 to 43200 (30 days)');
    }
    const reviewers = [
      ...new Set(
        (Array.isArray(input.reviewers) ? input.reviewers : [])
          .filter((one): one is string => typeof one === 'string')
          .map((one) => one.trim().replace(/^@/, ''))
          .filter(Boolean),
      ),
    ];
    if (approval === 'reviewers') {
      if (reviewers.length === 0) {
        throw new HttpFailure(400, 'name at least one person, by GitHub login, who approves production, or choose to ship automatically after testing');
      }
      const crew = (await bots.listBots()).map((bot) => bot.githubLogin).filter((login): login is string => Boolean(login));
      const bot = reviewers.find((login) => crew.some((one) => one.toLowerCase() === login.toLowerCase()));
      if (bot) throw new HttpFailure(400, `@${bot} is one of the crew's accounts, and a bot never approves a deploy. Name a person`);
      const organization = ((await effectiveConfig(config).catch(() => null))?.organization ?? '').toLowerCase();
      const org = organization ? reviewers.find((login) => login.toLowerCase() === organization) : undefined;
      if (org) throw new HttpFailure(400, `@${org} is the organization, which cannot review a deployment. Name a person in it`);
    }

    const choice = { approval, soakMinutes, reviewers: approval === 'reviewers' ? reviewers : [] } as const;
    await repos.setProductionChoice(repo.id, { ...choice, reviewers: [...choice.reviewers] });
    // Remembered for minutes otherwise; the board and the deploy pipeline read it now.
    deps.delivery?.forget(repo.fullName);
    await audit({ actor: identity, action: 'repo.production_choice', target: repo.fullName, payload: { ...choice } });
    return { repository: repo.fullName, production: choice };
  });

  // A new key for signing the crew's posts (`fleetadlc attribution rotate`).
  // Through this bridge's own instance, which holds the ring in memory: a key
  // written to the store from outside would not be used until a restart. Key
  // ids only, here and in the audit entry; never the key.
  router.post('/v1/attribution/rotate', async ({ body, identity }) => {
    if (!deps.attribution) throw new HttpFailure(503, 'this bridge signs nothing');
    const input = (await body<{ dropOld?: unknown } | null>()) ?? {};
    if (input.dropOld !== undefined && typeof input.dropOld !== 'boolean') throw new HttpFailure(400, 'dropOld is true or false');
    const droppedOld = input.dropOld === true;
    const rotated = await deps.attribution.rotate({ dropOld: droppedOld });
    await audit({
      actor: identity,
      action: 'attribution.rotated',
      target: 'install',
      payload: { kid: rotated.kid, retiredKid: rotated.retiredKid, droppedOld },
    });
    return { kid: rotated.kid, retiredKid: rotated.retiredKid, oldKeyChecksUntil: rotated.checksUntil };
  });

  /** Takes the install off the internet again, which is worth being one click. */
  router.post('/v1/webhook/stop-tunnel', async ({ identity }) => {
    const status = await deps.webhookSetup.takeDown();
    await audit({ actor: identity, action: 'install.tunnel_stopped', target: 'install', payload: {} });
    return status;
  });

  // PATCH, not PUT: the page sends only the fields it changed, and a PUT that
  // dropped the rest would clear a setting nobody touched.
  router.patch('/v1/install', async ({ body, identity }) => {
    const input = await body<Record<string, unknown>>();
    const written: string[] = [];

    for (const [key, value] of Object.entries(input)) {
      if (!settings.isSettingKey(key)) throw new HttpFailure(400, `${key} is not a setting`);
      // The bridge's own: written from GitHub's answer when humans is saved,
      // so a login is never pinned to an account somebody typed in.
      if (key === 'humanIds') throw new HttpFailure(400, 'humanIds is kept by the bridge: it pins each of humans to its GitHub account when humans is saved');
      // Allowed one at a time, after its warning, and audited by name.
      if (key === 'allowedAccounts') throw new HttpFailure(400, 'an account is allowed with POST /v1/github/allowed-accounts, which says what allowing it means');
      // Written here it would skip the gate and the audit trail: the live
      // gate and the setting would disagree until the next restart.
      if (key === 'workPaused' || key === 'workPausedRepos') throw new HttpFailure(400, 'pause and resume work with POST /v1/work/pause and /v1/work/resume, which are audited');
      // The same for a seat's pause, an item's hold and the unowned issues: a
      // resume written here skipped its audit and what a resume starts.
      if (key === 'workPausedSeats') throw new HttpFailure(400, 'pause and resume a seat with POST /v1/crew/<bot>/pause and /v1/crew/<bot>/resume, which are audited');
      if (key === 'heldItems') throw new HttpFailure(400, 'hold and release a work item with POST /v1/items/<subject>/pause and /v1/items/<subject>/resume, which are audited');
      if (key === 'unownedIssues') throw new HttpFailure(400, 'unownedIssues is kept by the intake sweep; answer each issue with POST /v1/repos/<repo>/unowned/intake, /ignore or /close');
      if (typeof value !== 'string') throw new HttpFailure(400, `${key} must be a string`);

      if (key === 'appPrivateKey') {
        // Into the secret store rather than the settings table. It is the widest
        // credential an install holds — it mints tokens that can administer the
        // repository — and it belongs where the refresh tokens are.
        //
        // An empty value used to delete it. A space typed into the setup
        // field and saved did that on a working install, and GitHub never
        // shows a private key again.
        const trimmed = value.trim();
        if (trimmed.length === 0) {
          throw new HttpFailure(400, 'appPrivateKey is empty — paste the PEM private key, or choose the .pem file');
        }
        if (!trimmed.includes('PRIVATE KEY')) {
          throw new HttpFailure(400, 'that does not look like a PEM private key');
        }
        await getSecretStore().set(appPrivateKeyRef(), trimmed);
        written.push(key);
        continue;
      }

      if (key === 'webhookSecret') {
        // Into the secret store as well: it is what makes a delivery trusted,
        // and a row here was in every dump of the database.
        await storeWebhookSecret(value, identity);
        written.push(key);
        continue;
      }

      if (key === 'appClientSecret') {
        // Into the secret store too: with the client id it narrows a bot's
        // token to one repository, and it is a credential of the app's. For an
        // app made by hand, or before the manifest exchange kept it.
        const trimmed = value.trim();
        if (trimmed.length === 0) await getSecretStore().delete(appClientSecretRef());
        else await getSecretStore().set(appClientSecretRef(), trimmed);
        written.push(key);
        continue;
      }

      if (key === 'attributionMode' && value !== 'audit' && value !== 'enforce') {
        throw new HttpFailure(400, 'attributionMode is audit or enforce');
      }
      // Written into AGENTS.md, CODEOWNERS and the production reviewers as it
      // is: an entry that is not a login breaks those, or names someone else.
      if (key === 'humans') {
        const wrong = value.split(',').map((entry) => entry.trim()).filter(Boolean).find((entry) => !isGitHubLogin(entry));
        if (wrong !== undefined) {
          throw new HttpFailure(400, `“${wrong}” is not a GitHub username: give each person’s login, separated by commas, without an @`);
        }
      }
      if (key === 'organization') {
        // Stored as the login GitHub knows. The console's lookup ignores a
        // leading `@`, so "@acme" was confirmed as acme and then stored as
        // typed: `GET /orgs/@acme` failed, and the app manifest went to the
        // person's own account. `_` stays allowed: Enterprise Managed Users have it.
        const login = value.trim().replace(/^@/, '');
        if (login !== '' && !/^[A-Za-z0-9_-]+$/.test(login)) {
          throw new HttpFailure(400, `“${value.trim()}” is not a GitHub login: give the organization or account name alone, such as acme, with no repository, spaces or @`);
        }
        await settings.setSetting(key, login, identity);
        written.push(key);
        continue;
      }
      await settings.setSetting(key, value.trim(), identity);
      written.push(key);
    }

    await audit({
      actor: identity,
      action: 'install.configured',
      target: 'install',
      // The keys, never the values: one of them is a webhook signing secret.
      payload: { keys: written },
    });

    const live = await effectiveConfig(config);
    // Each person added is pinned to the account their login names now, and
    // one taken out is forgotten (`human-ids.ts`). A login GitHub cannot
    // resolve yet is pinned on its first use.
    if (written.includes('humans')) {
      await repinHumans(live.humans, identity).catch((error: unknown) =>
        console.warn(`[bridge] the install's people were not pinned to their accounts: ${error instanceof Error ? error.message : error}`),
      );
    }
    deps.health?.runSoon(['app-installed', 'app-permissions', 'device-flow', 'webhook', 'app-client-secret']);
    // Who the install's people are decides what a Human review line may name.
    if (written.includes('humans')) deps.health?.runSoon(['repo-config']);
    return { written, clientIdConfigured: live.clientIdConfigured };
  });

  /**
   * Adds a seat of a role that can have more than one — a second builder, so
   * a repository can run two tasks at once — while the install runs:
   * settings' "Add a builder".
   *
   * It starts from what config/bots.yaml gives the role (its engine and
   * model, as a fresh install's builder gets them) and sits on the host the
   * role's first seat does. It has no account: the crew table puts it on one
   * OpenADLC already holds, with no sign-in, and hostd makes its container when
   * its first task starts.
   */
  router.post('/v1/crew/seats', async ({ body, identity }) => {
    const input = await body<{ role?: unknown }>();
    const role = typeof input.role === 'string' ? input.role : '';
    if (!canAddSeatOf(role)) {
      throw new HttpFailure(400, `a seat can be added only for the ${ADDABLE_SEAT_ROLES.map(roleLabel).join(', ')} role`);
    }
    const like = firstSeatOf(await bots.listBots(), role);
    const configured = configuredFirstOfRole(config?.configRoot, role);
    const base = configured ?? like;
    if (!base) {
      throw new HttpFailure(409, `this install has no ${roleLabel(role)} seat to add one beside; add one to config/bots.yaml and run fleetadlc up`);
    }
    const bot = await bots.addSeat({
      like: like?.slot ?? base.slot ?? role,
      displayName: base.displayName,
      role,
      engine: base.engine,
      model: base.model,
      hostId: like?.hostId ?? null,
      skills: base.skills,
      sidecarDb: base.sidecarDb,
      actor: identity,
    });
    return { bot };
  });

  /**
   * How a crew member looks in the console: the color of its avatar, from
   * Settings → Appearance, and which avatar it shows, from there or /crew.
   * Each is a name from its list, or null for the default (the role's tint,
   * the engine's mark), and never a value: the console decides what each
   * looks like in each mode. Anything else is refused before either is
   * stored, rather than stored and drawn as nothing. Both are one write, and
   * each change is audited on its own, so the trail says which one a person
   * made.
   */
  router.patch('/v1/crew/:bot', async ({ params, body, identity }) => {
    const input = await body<unknown>();
    if (typeof input !== 'object' || input === null || Array.isArray(input) || !('color' in input || 'avatar' in input)) {
      throw new HttpFailure(400, 'send an object with the color or the avatar: a name from its list, or null for the default');
    }
    const fields = input as { color?: unknown; avatar?: unknown };
    const color = fields.color;
    if ('color' in fields && color !== null && !isCrewColor(color)) {
      throw new HttpFailure(400, `a crew member's color is one of ${CREW_COLORS.join(', ')}, or null for its role's tint`);
    }
    const avatar = fields.avatar;
    if ('avatar' in fields && avatar !== null && !isAvatar(avatar)) {
      throw new HttpFailure(400, `a crew member's avatar is one of ${AVATARS.join(', ')}, or null for its engine's`);
    }
    const bot = await botNamed(params.bot ?? '');
    if (!bot) throw new HttpFailure(404, `unknown bot ${params.bot ?? ''}`);
    // One write for both, so a request that changes both never stores half.
    const updated = await bots.setAppearance(bot.id, {
      ...('color' in fields ? { color: (color ?? null) as CrewColor | null } : {}),
      ...('avatar' in fields ? { avatar: (avatar ?? null) as Avatar | null } : {}),
    });
    if (!updated) throw new HttpFailure(404, `unknown bot ${params.bot ?? ''}`);
    if ('color' in fields) {
      await audit({ actor: identity, action: 'bot.color_changed', target: bot.name, payload: { color: color ?? null, previous: bot.color ?? null } });
    }
    if ('avatar' in fields) {
      await audit({ actor: identity, action: 'bot.avatar_changed', target: bot.name, payload: { avatar: avatar ?? null, previous: bot.avatar ?? null } });
    }
    return { bot: updated };
  });

  /**
   * How many tasks a seat runs at once, from Crew → "tasks at once": 1 to 16.
   * Each task has a computer of its own; the seat is the one GitHub identity
   * they all act as, so raising this is how a repository builds more at once
   * without another account. Admin only, and audited with what it was.
   */
  router.patch('/v1/crew/:bot/tasks-at-once', async ({ params, body, identity }) => {
    const input = await body<{ maxTasks?: unknown }>();
    const maxTasks = input?.maxTasks;
    if (typeof maxTasks !== 'number' || !Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > MAX_TASKS_PER_SEAT) {
      throw new HttpFailure(400, `send maxTasks: a whole number from 1 to ${MAX_TASKS_PER_SEAT}`);
    }
    const bot = await botNamed(params.bot ?? '');
    if (!bot) throw new HttpFailure(404, `unknown bot ${params.bot ?? ''}`);
    const updated = await bots.setMaxTasks(bot.id, maxTasks);
    if (!updated) throw new HttpFailure(404, `unknown bot ${params.bot ?? ''}`);
    await audit({ actor: identity, action: 'bot.max_tasks_changed', target: bot.name, payload: { maxTasks, previous: maxTasksOf(bot) } });
    return { bot: updated };
  });

  /**
   * Removes a seat added beside another of its role, when nothing depends on
   * it (`bots.removeSeat` says what does). A seat config/bots.yaml names is
   * refused, since the next `fleetadlc up` would seed it again.
   *
   * The seat is taken off its GitHub account first, as the crew table's "Not
   * connected" does: the account stays OpenADLC's, listed as used by no bot, and
   * its sign-in moves out from under the seat's name, where a seat added later
   * with the same name would otherwise find it.
   *
   * The refusals are asked before the seat leaves its account, and again as
   * the row is deleted. Work that reaches the seat between the two keeps it,
   * disconnected: the second answer wins, and the seat is put back on an
   * account from its row. `assignAccount` does nothing for a seat on none.
   */
  router.post('/v1/crew/seats/:seat/remove', async ({ params, identity }) => {
    const seat = await botNamed(params.seat ?? '');
    if (!seat) throw new HttpFailure(404, `unknown bot ${params.seat ?? ''}`);
    if (!canAddSeatOf(seat.role)) {
      throw new HttpFailure(400, `${seat.name} is a ${roleLabel(seat.role)}, and only a seat added beside another builder can be removed`);
    }
    if (configuredSeats(config?.configRoot).some((entry) => entry.slot === seat.slot)) {
      throw new HttpFailure(409, `${seat.slot} is in config/bots.yaml, and fleetadlc up would add it again; take it out of the file first`);
    }
    const refusal = await bots.seatRemovalRefusal(seat.id);
    if (refusal) throw refusal;
    await deps.onboarding.assignAccount({ bot: seat.name, login: null, actor: identity });
    const removed = await bots.removeSeat({ id: seat.id, actor: identity });
    return { removed: removed.slot };
  });

  /**
   * The GitHub accounts OpenADLC holds, the seats on each, and which account each
   * seat may be put on — with the reason where it may not. Not
   * `/v1/github/accounts`, which is the walkthrough's lookup of a login.
   */
  router.get('/v1/github/identities', async () => deps.onboarding.accounts());

  /**
   * Puts a seat on one of those accounts, or takes it off its own with
   * `login: null`. The rules are the bridge's: a reviewer and a crew seat never
   * share an account, and the account must be one OpenADLC can sign in as.
   */
  router.post('/v1/github/accounts/assign', async ({ body, identity }) => {
    const input = await body<{ bot?: unknown; login?: unknown }>();
    if (typeof input.bot !== 'string' || !input.bot) throw new HttpFailure(400, 'bot names the seat to put on an account');
    if (input.login !== null && (typeof input.login !== 'string' || !input.login)) {
      throw new HttpFailure(400, 'login names the GitHub account to use, or is null to take the seat off its account');
    }
    return deps.onboarding.assignAccount({ bot: input.bot, login: input.login, actor: identity });
  });

  /**
   * Connects a GitHub account on its own, for no bot: the device flow, with
   * the code for the console to show. Whichever account approves it is the
   * one OpenADLC holds — reconnected, when it holds it already.
   */
  router.post('/v1/github/accounts/connect', async ({ identity }) => deps.onboarding.startAccountConnect(identity));

  /** How that went, asked by the id the start answered with; the bridge does the polling. */
  router.get('/v1/github/accounts/connect/:flowId', async ({ params }) =>
    deps.onboarding.accountConnectState(params.flowId ?? ''),
  );

  /** Forgets an account and its sign-in; refused while any bot uses it. */
  router.post('/v1/github/accounts/disconnect', async ({ body, identity }) => {
    const input = await body<{ login?: unknown }>();
    if (typeof input.login !== 'string' || !input.login) throw new HttpFailure(400, 'login names the GitHub account to disconnect');
    return deps.onboarding.disconnectAccount({ login: input.login, actor: identity });
  });

  /**
   * Starting the device flow from the console means the code appears where the
   * person is already working. The refresh token never leaves the bridge.
   */
  router.post('/v1/onboarding/bots/:bot/connect', async ({ params, identity }) => {
    const started = await deps.onboarding.startAuthorization(params.bot ?? '', identity);
    return {
      bot: started.bot,
      login: started.login,
      userCode: started.userCode,
      verificationUri: started.verificationUri,
      expiresInSeconds: Math.max(0, Math.round((started.expiresAt - Date.now()) / 1000)),
    };
  });

  // Asked under the name the connect was started with — one is started
  // under the seat — even after the bot has taken its account's handle.
  router.get('/v1/onboarding/bots/:bot/connect', async ({ params }) =>
    deps.onboarding.authorizationState(params.bot ?? ''),
  );

  router.post('/v1/onboarding/bots/:bot/cancel', async ({ params }) => {
    await deps.onboarding.cancel(params.bot ?? '');
    return { ok: true };
  });

  /**
   * A person moving a card. A person may move it anywhere — on, past a stage,
   * or back — and every move is theirs, audited and recorded. Back takes a
   * reason, because the stage it goes to works from it: it is said on the
   * issue, the work of the stage it left is stopped and let go of, and the
   * stage it went to is started (`SendBack.fromPerson`).
   */
  router.post('/v1/board/move', async ({ body, identity }) => {
    const input = await body<{ repo: string; issue: number; to: StageKey; reason?: string }>();
    if (!(STAGE_KEYS as readonly string[]).includes(input.to)) throw new HttpFailure(400, `${String(input.to)} is not a stage`);
    const repo = await repos.getRepoByName(input.repo);
    const current = repo ? await issues.getIssue(repo.id, input.issue) : null;
    const back = current ? isBackwardMove(current.stage, input.to) : false;
    const reason = (input.reason ?? '').trim();
    if (back && !reason) {
      throw new HttpFailure(400, `say why ${input.repo}#${input.issue} goes back to ${STAGE_COLUMN_TITLES[input.to]}: the stage it goes to works from your reason`);
    }
    const result =
      back && deps.sendBack
        ? await deps.sendBack.fromPerson({ repoName: input.repo, issueNumber: input.issue, to: input.to, actor: identity, reason })
        : await deps.automation
            .moveStage({ repoName: input.repo, issueNumber: input.issue, to: input.to, actor: identity, direction: 'person', reason: reason || null })
            .then((moved) => (moved.moved ? { sent: true as const } : { sent: false as const, reason: moved.reason ?? 'that move is not allowed' }));
    await audit({
      actor: identity,
      action: 'board.move',
      target: `${input.repo}#${input.issue}`,
      payload: { to: input.to, moved: result.sent, ...(back ? { back: true, reason } : {}) },
    });
    if (!result.sent) throw new HttpFailure(409, result.reason);
    return { moved: true };
  });
}

/**
 * The seat a new one of this role is numbered after and placed beside: the
 * role's seat without a number, else its first. `builder`, then `builder-2`.
 */
function firstSeatOf(crew: readonly Bot[], role: BotRole): Bot | null {
  const ofRole = crew
    .filter((bot) => bot.role === role)
    .sort((a, b) => a.slot.localeCompare(b.slot, 'en', { numeric: true }));
  return ofRole.find((bot) => !/-\d+$/.test(bot.slot)) ?? ofRole[0] ?? null;
}

/** How a task the Crew page lists as recent ended: sent back is a task whose own send-back moved its card. */
async function outcomeOf(task: { id: string; state: string }): Promise<'done' | 'sent_back' | 'failed' | 'stopped'> {
  if (task.state === 'failed') return 'failed';
  if (task.state === 'stopped') return 'stopped';
  // A record that cannot be read says nothing was sent back, not a failed crew page.
  const sentBack = await (async () => stageMoves.sendBackOfTask(task.id))().catch(() => null);
  return sentBack ? 'sent_back' : 'done';
}

/**
 * A seat's work in hand: running (a task paused with its computer kept is
 * still in hand), waiting on a person, and queued. Next is its oldest queued
 * task, or for intake the oldest request in line when it has none.
 */
export async function queueOf(
  bot: { role: string },
  unfinished: readonly { id: string; state: string; subjectRef: string; createdAt: string }[],
  gated: ReadonlySet<string>,
  titleOf: (subjectRef: string) => string | null,
): Promise<{ running: number; waiting: number; queued: number; next: { ref: string; title: string | null } | null }> {
  const waiting = unfinished.filter((task) => task.state === 'paused' && gated.has(task.id)).length;
  const queued = unfinished.filter((task) => task.state === 'queued');
  const running = unfinished.length - waiting - queued.length;
  const oldest = [...queued].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
  let next: { ref: string; title: string | null } | null = oldest ? { ref: oldest.subjectRef, title: titleOf(oldest.subjectRef) } : null;
  if (!next && bot.role === 'intake') {
    const line = await (async () => requests.listQueued())().catch(() => []);
    // Not one the queue gave up on: it is not next, it waits for a person.
    const first = line.find(stillTried);
    if (first) next = { ref: requestSubject(first.id), title: (first.text.split('\n')[0] ?? '').slice(0, 120) || null };
  }
  return { running, waiting, queued: queued.length, next };
}

/** One state for a seat's health, from its failing checks, with each reason and where it is fixed. */
export function healthOf(
  failing: readonly { title: string | null; checkId: string; severity: string | null; action: HealthAction | null }[],
): { state: 'ok' | 'warning' | 'failing'; reasons: { title: string; action: { label: string; href?: string; url?: string } | null }[] } {
  if (failing.length === 0) return { state: 'ok', reasons: [] };
  const blocking = (row: { severity: string | null }) => (row.severity ?? 'blocking') === 'blocking';
  const state = failing.some(blocking) ? 'failing' : 'warning';
  return {
    state,
    // What stops the seat first: the crew page offers the first reason's fix
    // as the seat's, and a warning's fix there sent a person to the wrong page.
    reasons: [...failing.filter(blocking), ...failing.filter((row) => !blocking(row))].map((row) => ({
      title: row.title ?? row.checkId,
      // A command is said on the board's card, where it can be copied; here there is no link to give.
      action: row.action && 'href' in row.action ? { label: row.action.label, href: row.action.href } : row.action && 'url' in row.action ? { label: row.action.label, url: row.action.url } : null,
    })),
  };
}

/** Whether a check's row is about this bot: its own sign-in or key, or an account it thinks with. */
function aboutBot(facts: Record<string, unknown>, botId: string): boolean {
  if (facts.botId === botId) return true;
  return Array.isArray(facts.botIds) && facts.botIds.includes(botId);
}

function modeForStage(
  repoList: Awaited<ReturnType<typeof repos.listRepos>>,
  repoName: string | undefined,
  stage: StageKey,
): string {
  if (repoName) {
    const repo = repoList.find((entry) => entry.name === repoName);
    return repo?.stageModes?.[stage] ?? 'autonomous';
  }
  const modes = new Set(repoList.map((repo) => repo.stageModes?.[stage] ?? 'autonomous'));
  return modes.size === 1 ? [...modes][0] ?? 'autonomous' : 'mixed';
}
