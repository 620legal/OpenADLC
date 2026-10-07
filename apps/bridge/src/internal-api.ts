import { timingSafeEqual } from 'node:crypto';
import { registerInternalAttachmentRoutes } from './attachment-routes.js';
import type { IncomingMessage } from 'node:http';
import { audit, bots, costs, issues, leases, localCiRuns, recordEvent, repos, spendingLimits, stageMoves, tasks, threads } from '@fleetadlc/db';
import {
  TASK_TOKEN_HEADER,
  TASK_TOKEN_MIN_LIFETIME_MS,
  taskTokenMatches,
  verifyWebhookSignature,
} from '@fleetadlc/github';
import {
  FLEETADLC_EVENTS,
  botAtStart,
  headlineFor,
  messageKindFor,
  type FleetEventType,
  type Task,
  type TaskState,
  dedupeMarker,
  hasIgnoreLabel,
  redactSecrets,
  resolveBotRef,
  seatTagOf,
  SIGNED_BODY_MAX,
  stepNamed,
  unreadablePathLines,
} from '@fleetadlc/shared';
import type { ApiDeps } from './api.js';
import { asAutomation, automationBotName, automationLogin, findOwnOpenIssue } from './automation-bot.js';
import { subjectClosed } from './gates.js';
import { startBuild } from './build-start.js';
import { effectiveConfig } from './effective-config.js';
import { requestFor, requestPrefixOf } from './request-context.js';
import { missingReview } from './review-left.js';
import { RequestFiling } from './request-lifecycle.js';
import { NotOurRepository, worksIn } from './invitation-service.js';
import { HttpFailure, readBytes, Router, type Handler } from './router.js';
import { Scheduler } from './scheduler.js';
import { WEBHOOK_BODY_MAX } from './webhook-gateway.js';
import { settleLeaseAfter, usageProblem } from './task-service.js';
import type { StageHandoff } from './stage-handoff.js';
import { sentBackReason } from './send-back.js';
import { issueNumberFromBranch, parseRef } from './work.js';
import type { Webhooks } from './webhooks.js';

export const INTERNAL_SECRET_HEADER = 'x-fleetadlc-internal-secret';
/** What a task's own session presents, in place of the install's secret. */
export { TASK_TOKEN_HEADER };

/**
 * The kinds of task whose session runs the repository's checks
 * (`fleetadlc-ci`): each opens pull requests, and the lead approves a crew
 * pull request only on a pass recorded for its head. A QA task changing a
 * suite, a design task recording an ADR, or the SRE fixing a broken deploy
 * workflow was refused one, so its pull request could never be approved.
 */
const RUNS_LOCAL_CI: ReadonlySet<string> = new Set(['implement', 'patch', 'qa', 'spec', 'deploy']);

/**
 * Refuses a caller that does not hold the install's shared secret.
 *
 * This used to guard the token service alone, and the private network was the
 * whole of the protection on every other `/internal` route — which meant an
 * unauthenticated request could start a real task on any bot with arbitrary
 * declared paths, force a task to `done`, open a gate as a bot, write thread
 * messages, or push the monthly budget to `stopped`. It now guards all of them.
 */
export function requireInternalSecret(request: IncomingMessage, expected: string): void {
  if (!presents(request, INTERNAL_SECRET_HEADER, expected)) {
    throw new HttpFailure(401, 'this route needs the install\'s internal secret');
  }
}

/** What an outside monitor presents to `/internal/alerts`; see `alertsSecretRef`. */
export const ALERTS_SECRET_HEADER = 'x-fleetadlc-alerts-secret';

/**
 * Refuses a caller of `/internal/alerts` that holds neither the alerts secret
 * nor the install's. The alerts secret is checked here and nowhere else, so it
 * opens this route and no other.
 */
export function requireAlertsSecret(request: IncomingMessage, alertsSecret: string, internalSecret: string): void {
  if (presents(request, ALERTS_SECRET_HEADER, alertsSecret) || presents(request, INTERNAL_SECRET_HEADER, internalSecret)) return;
  throw new HttpFailure(401, `this route needs the alerts secret in ${ALERTS_SECRET_HEADER}, or the install's internal secret in ${INTERNAL_SECRET_HEADER}`);
}

/** Whether a header carries the expected secret. An empty expected secret matches nothing. */
function presents(request: IncomingMessage, header: string, expected: string): boolean {
  const presented = request.headers[header];
  const offered = typeof presented === 'string' ? Buffer.from(presented) : Buffer.alloc(0);
  const wanted = Buffer.from(expected);
  return expected.length > 0 && offered.length === wanted.length && timingSafeEqual(offered, wanted);
}

/**
 * What /healthz and the bridge's start-up log say when the install has no
 * GitHub App client id, in the environment or stored by the console. Not
 * `fleetadlc init` or `fleetadlc auth login`, which these used to name: init
 * sets only the driver and the database url, and auth login refuses without
 * one. The same remedy `fleetadlc doctor` and `auth login` give.
 */
export const NO_CLIENT_ID = `no GitHub App client id: create the app on ${stepNamed('app')} of the console walkthrough, or set FLEETADLC_GITHUB_CLIENT_ID`;

/**
 * The surfaces only the platform itself calls: the skill runner reporting what it
 * did, GitHub delivering webhooks, and the scheduler ticking the recurring work
 * that has no webhook.
 *
 * Every `/internal` route is registered through something that applies its
 * check: the local `post` below (the install's secret), `taskPost` (the
 * task's own token, or the install's secret), the attachment routes with the
 * secret's guard passed in, and `/internal/alerts` (the alerts secret, or the
 * install's) — so the guard is part of registering a route rather than
 * something each handler has to remember. `/webhooks/github` deliberately
 * is not one of them: GitHub cannot hold the install's secret, and a delivery is
 * authenticated by its HMAC signature instead. That check is not optional. The
 * handler attributes a gate answer to the login in the body, so an unverified
 * body would be that person.
 */
export function registerInternalApi(
  router: Router,
  deps: ApiDeps & {
    webhooks: Webhooks;
    scheduler: Scheduler;
    stages: StageHandoff;
    internalSecret: string;
    /** What an outside monitor holds to file an alert, and nothing more; see `alertsSecretRef`. */
    alertsSecret: string;
    /** Asked for a dispatch when a task ends; see `DispatchRunner`. Absent where the bridge does not dispatch. */
    dispatchRuns?: { soon(reason: string): void } | null;
    /** Links a console request to the issue its triage filed; shared with the webhooks, which link it first. */
    requestFiling?: RequestFiling;
  },
): void {
  /**
   * Registers an internal route behind the install's secret. These are the
   * routes that start work or hand out a credential, so only the platform's own
   * components may reach them: hostd, the CLI, and the dispatcher the bridge
   * runs, which is handed the secret at start. A bot's session must never
   * hold it — that secret also opens `/internal/dispatch/lease`.
   */
  const post = (path: string, handler: Handler): void => {
    router.post(path, async (context) => {
      requireInternalSecret(context.raw, deps.internalSecret);
      return handler(context);
    });
  };

  // A file a task is given, fetched by hostd as it starts the task.
  registerInternalAttachmentRoutes(router, (raw) => requireInternalSecret(raw, deps.internalSecret));

  /**
   * Registers a route a task's own session may reach, about itself.
   *
   * The skill runner is the session's command, so these calls come from inside
   * the bot's computer and cannot carry the install's secret. They carry an HMAC
   * of the task id under it instead, which hostd minted when it started the
   * task: enough to speak for that task, useless for any other and for every
   * route above. The install secret is accepted too, because hostd and the
   * integration suites drive these directly.
   *
   * A task token never expires, so it speaks for its task only while the task
   * is in one of `only.states`: a token copied out of a session went on opening
   * gates on a finished task, and posting `done` after a person pressed Stop.
   * The install secret is not held to this, because hostd settles a task's
   * state after its session has gone.
   */
  const taskPost = (path: string, ...args: [Handler] | [{ states: readonly TaskState[]; refusal: string }, Handler]): void => {
    const [only, handler] = args.length === 1 ? [null, args[0]] : args;
    router.post(path, async (context) => {
      const id = context.params.id ?? '';
      const presented = context.raw.headers[TASK_TOKEN_HEADER];
      const token = typeof presented === 'string' ? presented : '';

      if (!taskTokenMatches(id, deps.internalSecret, token)) {
        // Falls back to the install secret rather than the other way round, so
        // a wrong task token is never quietly upgraded by one.
        requireInternalSecret(context.raw, deps.internalSecret);
      } else {
        const task = await tasks.getTask(id);
        if (!task) throw new HttpFailure(404, 'unknown task');
        if (only && !only.states.includes(task.state)) throw new HttpFailure(409, `task is ${task.state}; ${only.refusal}`);
      }
      return handler(context);
    });
  };

  /**
   * Whether the refusal for a missing secret has been logged. The router logs
   * only a 5xx, so an install upgraded without a secret would stop receiving
   * GitHub and say nothing. Once per process, because every delivery after the
   * first would repeat it.
   */
  let saidNoSecret = false;

  /** Links a console request to the issue its triage filed. */
  const filing = deps.requestFiling ?? new RequestFiling(deps.actors, deps.config);

  router.post('/webhooks/github', async ({ raw }) => {
    const signature = (raw.headers['x-hub-signature-256'] as string | undefined) ?? null;
    const event = (raw.headers['x-github-event'] as string | undefined) ?? '';
    const delivery = (raw.headers['x-github-delivery'] as string | undefined) ?? null;

    /**
     * The secret as it is *now*, not as the environment had it at start-up.
     *
     * A secret configured from the console went into the settings table, and
     * this read `deps.config` — so the console could report the webhook as
     * configured while the verifier still held an empty string and skipped the
     * check entirely. Worse in combination with a tunnel: the one publicly
     * reachable route was the one not verifying.
     */
    const live = await effectiveConfig(deps.config);

    /**
     * Always. There is no configuration in which this is skipped.
     *
     * An empty secret is not a secret: an HMAC under the empty string is a
     * signature anybody can compute, so "verify against whatever is configured"
     * would accept a forged delivery on an install that had not set one. The
     * body is parsed only after this succeeds, because the handler attributes a
     * gate answer to `comment.user.login` inside it.
     */
    if (live.webhookSecret.length === 0) {
      if (!saidNoSecret) {
        saidNoSecret = true;
        console.warn(
          '[bridge] refusing every GitHub delivery: this install has no webhook secret. ' +
            'Run `fleetadlc init` or set FLEETADLC_WEBHOOK_SECRET, and give the GitHub webhook the same value.',
        );
      }
      raw.resume();
      throw new HttpFailure(401, 'this install has no webhook secret, so a delivery cannot be trusted');
    }

    // Refused before a byte of the body is held. This route needs no login,
    // and it used to read whatever arrived, however large, before asking
    // whether it was signed at all: a few unsigned gigabyte posts ran the
    // bridge out of memory.
    if (!signature) {
      raw.resume();
      throw new HttpFailure(401, 'webhook signature did not verify');
    }

    // Bytes, not text: the signature is over what GitHub sent, and a decoding
    // that replaced an invalid sequence would hash to something else.
    const payload = await readBytes(raw, { limit: WEBHOOK_BODY_MAX });
    const valid = verifyWebhookSignature({
      payload,
      signatureHeader: signature,
      secret: live.webhookSecret,
    });
    if (!valid) throw new HttpFailure(401, 'webhook signature did not verify');

    await deps.webhooks.receive(event, JSON.parse(payload.toString('utf8') || '{}'), delivery);
    // A delivery is the webhook's check passing; a card saying GitHub is
    // silent goes now rather than at the next run.
    deps.health?.heard();
    return { ok: true, event };
  });

  /**
   * The token service. While the bridge runs, every bot's GitHub credential is
   * refreshed here: GitHub rotates a refresh token on use, so a second component
   * refreshing the same one invalidates both and the account needs a person at
   * a browser to recover. hostd asks for a token when it starts a task instead
   * of holding a refresh token of its own; the CLI refreshes one itself only
   * when the bridge does not answer, under the broker's lock.
   */
  post('/internal/tokens/:bot', async ({ params, body }) => {

    const input = await body<{ purpose?: 'task' | 'call'; repository?: string }>();
    const name = params.bot ?? '';

    // A task's token is narrowed to its repository, which comes from the
    // request body: the internal secret admits hostd, but the name is still
    // checked against the repositories OpenADLC works in before anything is
    // minted for it. A removed one is let through: a paused task in it can
    // still be resumed (`TaskRunner.begin`), and its token reaches only it.
    let repository: string | undefined;
    if (input.purpose === 'task' && typeof input.repository === 'string' && input.repository.trim() !== '') {
      repository = await worksIn(input.repository, { includeRemoved: true }).catch((error: unknown) => {
        throw error instanceof NotOurRepository ? new HttpFailure(403, error.message) : error;
      });
    }

    const minted = await deps.actors
      .tokenFor(name, {
        ...(input.purpose === 'task' ? { minLifetimeMs: TASK_TOKEN_MIN_LIFETIME_MS } : {}),
        ...(repository ? { repository } : {}),
      })
      .catch((error: unknown) => {
        // A revoked or expired authorization is the bot's problem to fix, not a
        // fault in the bridge, so it must not read as one in the caller's log.
        throw new HttpFailure(409, error instanceof Error ? error.message : String(error));
      });
    if (!minted) throw new HttpFailure(404, `${name} has no connected GitHub account`);
    return minted;
  });

  /** Why a finished review task failed, when it left no review; see `review-left.ts`. */
  const missingReviewOf = async (task: Task): Promise<string | null> => {
    const [repoName] = task.subjectRef.split('#');
    const [repo, bot, client] = await Promise.all([
      repoName ? repos.getRepoByName(repoName) : null,
      bots.getBotById(task.botId),
      asAutomation(deps.actors, deps.config),
    ]);
    if (!repo || !bot || !client) return null;
    return missingReview({
      task,
      login: bot.githubLogin,
      seat: bot.name,
      reviews: (number) => client.listReviews(repo.fullName, number),
      lastSaid: async () => {
        const thread = (await threads.listThreadsForSubject(task.subjectRef)).find((row) => row.bot_id === bot.id);
        const since = task.startedAt ? Date.parse(task.startedAt) : Number.NEGATIVE_INFINITY;
        // What the bot itself said last: its words, or a message its marker
        // made a review — not OpenADLC's lines, nor the runner's "reading …".
        const said = thread
          ? (await threads.listMessages([thread.id], 50)).filter(
              (message) =>
                message.author === bot.name &&
                (message.kind === 'bot' || (Boolean(message.payload?.event) && message.payload?.event !== 'stopped')) &&
                Date.parse(message.at) >= since,
            )
          : [];
        return said.at(-1)?.text ?? null;
      },
    });
  };

  taskPost('/internal/tasks/:id/state', { states: ['queued', 'running', 'paused'], refusal: 'a task that has ended keeps the state it ended in' }, async ({ params, body }) => {
    const input = await body<{ state: TaskState; reason?: string }>();
    let state = input.state;
    let reason = input.reason ?? null;
    // A task that sent its work back ends `done`, and is not its stage
    // finishing: its reason says where the work went, whatever the session
    // said, so the card, the recovery and the handoff read it the same way.
    const sentBack = state === 'done' ? await (async () => stageMoves.sendBackOfTask(params.id ?? ''))().catch(() => null) : null;
    if (sentBack) reason = sentBackReason(sentBack.to);

    // A review task is done when its review is on the pull request, not when
    // its engine stopped. One that left none failed; see `review-left.ts`.
    // Settled before the write: a task written done is not changed again.
    if (state === 'done') {
      const current = await tasks.getTask(params.id ?? '');
      if (current?.kind === 'review') {
        const missing = await missingReviewOf(current).catch(() => null);
        if (missing) {
          state = 'failed';
          reason = missing;
        }
      }
    }
    const task = await tasks.updateTaskState(params.id ?? '', state, { exitReason: reason });
    if (!task) {
      // No such task, or one whose state does not allow this one: a task
      // that has ended stays ended (`TASK_STATE_FROM`).
      const current = await tasks.getTask(params.id ?? '');
      if (!current) throw new HttpFailure(404, 'unknown task');
      throw new HttpFailure(409, `the task is ${current.state} and cannot become ${state}`, { state: current.state });
    }
    const ended = task;

    // An intake task that ended or waits on a person frees intake for the
    // next request in line; see `request-queue.ts`. A question is `paused`
    // here, posted once the session has stopped. Starting the next triage when
    // the question itself arrived could have killed the session that asked it,
    // which is named for its skill, before it reported its usage.
    if (ended.kind === 'intake' && ['done', 'failed', 'stopped', 'paused'].includes(state)) {
      void deps.requestQueue?.drain().catch(() => undefined);
    }

    if (['done', 'failed', 'stopped'].includes(state)) {
      await deps.hostd.cleanupTask(ended.id, reason ?? state).catch(() => undefined);
      // A lease a gate paused is not let go by anything else once its task ends.
      await settleLeaseAfter(ended);
      // A builder is free, or a build ended: either can let the next piece of work start.
      deps.dispatchRuns?.soon(`${ended.kind} task ${state}`);
    }

    // Said in the bot's thread, where its start was said. A task that failed
    // before doing anything — an engine the session could not find — left the
    // thread at "started triage" and "reading intake.md", which reads as work
    // still going on, and the person who filed the request waited for it.
    if (state === 'failed' || (state === 'stopped' && reason)) {
      const how = state;
      await sayTaskEnded(ended, how, reason).catch((error: unknown) =>
        console.warn(`[bridge] could not say in its thread that ${ended.id} ${how}: ${error instanceof Error ? error.message : error}`),
      );
      // Why it failed is often one of the things the checks watch — an
      // account signed out, a host service gone — and a lease it leaves
      // holding its issue is one of them too.
      deps.health?.runSoon(['model-account', 'hostd', 'idle-lease']);
    }

    // A stage ends because its own work ended. Only a task that finished cleanly
    // hands the issue on; one that stopped or failed leaves it where it is.
    if (state === 'done') {
      // A build is finished when its pull request is open, not when its
      // engine stopped; it is looked for once the webhook has had time to
      // arrive (`Scheduler.afterBuildEnded`, `build-left.ts`).
      if (ended.kind === 'implement') deps.scheduler.afterBuildEnded?.();

      await deps.stages
        .onTaskDone({ kind: ended.kind, subjectRef: ended.subjectRef, taskId: ended.id, branch: ended.branch })
        .catch((error: unknown) =>
          console.warn(`[bridge] no handoff for ${ended.subjectRef}: ${error instanceof Error ? error.message : error}`),
        );

      // The verification after a merge is the other moment a lease stops holding
      // ground — the change has landed and been checked, so a second issue
      // touching the same files may go out.
      if ((ended.kind === 'deploy' || ended.kind === 'qa') && ended.repoId) {
        const number = Number(ended.subjectRef.split('#')[1] ?? '');
        if (Number.isFinite(number)) {
          const released = await leases
            .releaseForPullRequest(ended.repoId, number, 'the verification after the merge ended')
            .catch(() => null);
          if (released) {
            console.log(`[bridge] released the lease on #${released.issueNumber}: verification of #${number} ended`);
          }
        }
      }

      // A console request's triage ends by filing an issue of its own, which
      // is the one thing that links the request to it.
      if (ended.kind === 'intake' && requestPrefixOf(ended.subjectRef)) {
        await filing
          .triageEnded(ended)
          .catch((error: unknown) =>
            console.warn(`[bridge] could not link ${ended.subjectRef} to an issue: ${error instanceof Error ? error.message : error}`),
          );
        // Then the issue it filed goes to Design or Build by the spec rule, as
        // an issue opened on GitHub does when its triage ends. Read from the
        // request: the issue's own delivery may have linked it first, and then
        // `triageEnded` answers nothing.
        const filed = await requestFor(ended.subjectRef).catch(() => null);
        const repoName = filed?.issueNumber && filed.repoId ? (await repos.listRepos()).find((repo) => repo.id === filed.repoId)?.name : undefined;
        if (filed?.issueNumber && repoName) {
          await deps.stages
            .afterIntake({ repoName, issueNumber: filed.issueNumber })
            .catch((error: unknown) =>
              console.warn(`[bridge] no handoff for ${repoName}#${filed.issueNumber}: ${error instanceof Error ? error.message : error}`),
            );
        }
      }
    }

    // Work that ended may have been holding a path an approved plan change
    // asked for, so the ones waiting on it look again.
    if (['done', 'failed', 'stopped'].includes(state)) {
      try {
        for (const id of await deps.gates.applyHeld()) {
          await deps.taskService.resume(id).catch((error: Error) => console.warn(`[bridge] resume after a plan change failed: ${error.message}`));
        }
      } catch (error) {
        console.warn(`[bridge] could not look at the plan changes waiting on paths: ${error instanceof Error ? error.message : error}`);
      }
    }

    return { task: ended };
  });

  /**
   * A task's session sending its work back to the stage before (`send-back.ts`).
   * The runner reads the `send_back` marker from its own session's output and
   * posts it here with the task's token, so a session speaks only for its own
   * task; a marker in a comment on GitHub is never acted on. Refused, the
   * answer says why, and the session ends on it.
   */
  taskPost('/internal/tasks/:id/send-back', async ({ params, body }) => {
    const input = await body<{ to?: unknown; reason?: unknown }>();
    if (!deps.sendBack) throw new HttpFailure(503, 'this bridge takes no send-backs');
    return deps.sendBack.request({
      taskId: params.id ?? '',
      to: typeof input.to === 'string' ? input.to.trim() : '',
      reason: typeof input.reason === 'string' ? input.reason : '',
    });
  });

  /**
   * The repository's checks on a task's head (`fleetadlc-ci` in the session).
   *
   * A builder told to run `make ci` before it opened its pull request was
   * taken at its word, and GitHub's CI ran on every push to find out. Now the
   * session asks, hostd runs `make ci` in the task's worktree itself, and the
   * result reaches the bridge from hostd with the install's secret
   * (`/internal/local-ci`), never from the session: its token starts a run and
   * reads one, and nothing more. Only a task that opens pull requests runs
   * them (`RUNS_LOCAL_CI`); never a review, whose session holds the account
   * that approves.
   */
  taskPost('/internal/tasks/:id/local-ci', async ({ params }) => {
    const task = await tasks.getTask(params.id ?? '');
    if (!task) throw new HttpFailure(404, 'unknown task');
    if (task.state !== 'running') throw new HttpFailure(409, `the task is ${task.state}; local CI runs for a task that is running`);
    if (!RUNS_LOCAL_CI.has(task.kind)) {
      throw new HttpFailure(409, `a ${task.kind} task does not run local CI; only ${[...RUNS_LOCAL_CI].join(', ')} tasks do, as they open pull requests`);
    }
    return deps.hostd.startLocalCi(task.id).catch((error: unknown) => {
      throw new HttpFailure(409, error instanceof Error ? error.message : String(error));
    });
  });

  taskPost('/internal/tasks/:id/local-ci/status', async ({ params, body }) => {
    const input = await body<{ run?: unknown }>();
    if (typeof input.run !== 'string' || !input.run) throw new HttpFailure(400, 'name the run: { "run": "<id>" }');
    const answer = await deps.hostd.localCiRun(params.id ?? '', input.run).catch((error: unknown) => {
      throw new HttpFailure(404, error instanceof Error ? error.message : String(error));
    });
    const task = await tasks.getTask(params.id ?? '');
    const recorded =
      task?.repoId && answer.run.headSha && answer.run.state !== 'running' && answer.run.state !== 'refused'
        ? await localCiRuns.latestFor(task.repoId, answer.run.headSha).catch(() => null)
        : null;
    return { run: answer.run, recorded: recorded?.runId === answer.run.id };
  });

  /**
   * Whether a commit passed local CI in this task's repository: what
   * OpenADLC's `gh` and `git` ask before a pull request opens or a branch is
   * pushed. Read-only, and about the task's own repository.
   */
  taskPost('/internal/tasks/:id/local-ci/pass', async ({ params, body }) => {
    const input = await body<{ sha?: unknown }>();
    const sha = typeof input.sha === 'string' ? input.sha.trim() : '';
    if (!/^[0-9a-f]{40}$/i.test(sha)) throw new HttpFailure(400, 'give the full commit: { "sha": "<40 hex characters>" }');
    const task = await tasks.getTask(params.id ?? '');
    if (!task?.repoId) throw new HttpFailure(404, 'unknown task, or one in no repository');
    const pass = await localCiRuns.passFor(task.repoId, sha);
    const latest = pass ?? (await localCiRuns.latestFor(task.repoId, sha));
    return { passed: Boolean(pass), run: latest ? { runId: latest.runId, ok: latest.ok, at: latest.createdAt } : null };
  });

  /**
   * A task's session reporting an engine call. Booked to the task in the
   * path, field by field: spreading the body let a `taskId` in it book the
   * usage to another task. `TaskService.recordUsage` refuses the rest.
   */
  taskPost('/internal/tasks/:id/usage', { states: ['running', 'paused'], refusal: 'usage is recorded only for a task that is running or paused' }, async ({ params, body }) => {
    const input = await body<Record<string, unknown>>();
    // A session reports its own figures. One negative row took the month's
    // spend below zero and switched off every monthly cap, so a report no
    // real engine call could make is refused, and nothing is recorded.
    const problem = usageProblem(input ?? {});
    if (problem) throw new HttpFailure(400, problem);
    return deps.taskService.recordUsage({
      taskId: params.id ?? '',
      tokensIn: input.tokensIn as number,
      tokensOut: input.tokensOut as number,
      costUsd: input.costUsd as number,
      engine: input.engine as string,
      model: input.model as string,
      modelAlias: (input.modelAlias as string | null | undefined) ?? null,
    });
  });

  taskPost('/internal/tasks/:id/headroom', { states: ['running'], refusal: 'headroom is asked only by a task that is running' }, async ({ params, body }) => {
    const input = await body<{ estimateUsd?: number }>();
    return deps.taskService.headroom(params.id ?? '', input.estimateUsd ?? 0);
  });

  /**
   * Signs what a task's session is about to post, as the task's own seat:
   * OpenADLC's `gh` sends every body here before it posts (see apps/hostd/bin/gh).
   * The seat and the repository are the task's, never the caller's, and only a
   * task that is running is signed for — so a session can speak only as itself,
   * only while it works. A body whose end names another seat is refused, not
   * signed: the signature would be the task's seat's and the tag another's, and
   * on an account the reviewers share the tag is what says whose review it is.
   */
  taskPost('/internal/tasks/:id/stamp', async ({ params, body }) => {
    const input = await body<{ body?: string; kind?: string; number?: number | null }>();
    if (typeof input.body !== 'string') throw new HttpFailure(400, 'no body to sign');
    // GitHub holds no longer post, and a long enough one kept the bridge busy
    // reading it; verifying reads a longer body as unsigned in any case.
    if (input.body.length > SIGNED_BODY_MAX) {
      throw new HttpFailure(413, `this body is ${input.body.length} characters; a post is signed only up to ${SIGNED_BODY_MAX.toLocaleString('en-US')}, GitHub's limit`);
    }
    if (!deps.attribution) throw new HttpFailure(503, 'this bridge signs nothing');
    const task = await tasks.getTask(params.id ?? '');
    if (!task) throw new HttpFailure(404, 'unknown task');
    if (task.state !== 'running') throw new HttpFailure(409, `task is ${task.state}, not running`);
    const bot = await bots.getBotById(task.botId);
    if (!bot) throw new HttpFailure(404, 'task has no bot');
    const tagged = seatTagOf(input.body);
    if (tagged && tagged !== bot.name.toLowerCase()) {
      throw new HttpFailure(400, `this body is tagged as ${tagged}, and this task is ${bot.name}'s; a task signs only as its own seat, so end it with <!-- fleetadlc-seat:${bot.name.toLowerCase()} --> or no tag`);
    }
    const repo = task.repoId ? (await repos.listRepos({ includeRemoved: true })).find((entry) => entry.id === task.repoId) : null;
    const kind = typeof input.kind === 'string' ? input.kind.slice(0, 20) : 'post';
    const n = typeof input.number === 'number' && input.number > 0 ? input.number : null;
    // The target is the task's too. A signed review for a number the caller
    // named is the seat's verdict on that pull request (attribution.ts), so a
    // reviewer led astray on one pull request could approve another as the
    // lead. The gh shim reads the number from the command line; only this
    // route can hold it to the task.
    const subject = parseRef(task.subjectRef);
    if (kind === 'review') {
      if (task.kind !== 'review' || !subject || n !== subject.number) {
        throw new HttpFailure(403, `a ${task.kind} task on ${task.subjectRef} may sign a review only of the pull request it reviews`);
      }
    } else if (n !== null && n !== subject?.number && !(await targetsOfTask(task, subject, repo?.name ?? null)).includes(n)) {
      throw new HttpFailure(403, `a task on ${task.subjectRef} may sign a post only on its own issue or pull request, not #${n}`);
    }
    const signed = await deps.attribution.sign(input.body, {
      seat: bot.name,
      task: task.id,
      repo: repo?.fullName ?? null,
      kind,
      n,
    });
    return { body: signed };
  });

  taskPost('/internal/tasks/:id/gate', { states: ['running'], refusal: 'a gate is opened only by a task that is running' }, async ({ params, body }) => {
    const input = await body<{
      question: string;
      options?: string[];
      context?: string;
      addressedTo?: string;
      /** A task asking to widen its paths, which `Gates.open` reads as data. */
      planChange?: { paths?: unknown; reason?: unknown };
    }>();
    return deps.gates.open({
      taskId: params.id ?? '',
      question: input.question,
      options: input.options ?? [],
      context: typeof input.context === 'string' ? input.context : null,
      addressedTo: input.addressedTo ?? null,
      planChange: input.planChange ?? null,
    });
  });

  taskPost('/internal/tasks/:id/message', { states: ['running', 'paused'], refusal: 'a message is posted only by a task that is running or paused' }, async ({ params, body }) => {
    const input = await body<{
      kind?: 'bot' | 'sys';
      text: string;
      note?: string;
      /** A `fleetadlc:` event the skill declared, which decides how this reads. */
      event?: FleetEventType;
    }>();
    // A person's words, a question and the bridge's own rows are the bridge's
    // to write: a session that could post 'you' put words in the requester's
    // mouth, which the console and later stages read as theirs.
    if (input.kind !== undefined && input.kind !== 'bot' && input.kind !== 'sys') {
      throw new HttpFailure(400, `a task posts a bot or sys message, not ${JSON.stringify(input.kind)}`);
    }
    const task = await tasks.getTask(params.id ?? '');
    if (!task) throw new HttpFailure(404, 'unknown task');
    const bot = await bots.getBotById(task.botId);
    if (!bot) throw new HttpFailure(404, 'task has no bot');

    const thread = await threads.ensureThread({
      botId: bot.id,
      repoId: task.repoId,
      subjectRef: task.subjectRef,
    });

    // An event decides the kind; without one the caller's choice stands, so a
    // plain narration line still arrives as narration.
    const event = input.event && FLEETADLC_EVENTS.includes(input.event) ? input.event : null;
    const message = await threads.addMessage({
      threadId: thread.id,
      kind: event ? messageKindFor(event) : (input.kind ?? 'bot'),
      author: bot.name,
      text: input.text,
      note: input.note ?? (event ? headlineFor(event) : null),
      // The task too, so the bridge can tell that the runner already said
      // why it stopped and not say it a second time when the state arrives.
      ...(event ? { payload: { event, taskId: task.id } } : {}),
    });
    if (event) {
      await recordEvent({ source: 'platform', type: event, payload: { taskId: task.id, bot: bot.name } });
    }
    return { message };
  });

  /**
   * A local CI run hostd finished, with the install's secret: the one way a
   * result is written. Its task's repository and branch are the task's, not
   * the report's.
   */
  post('/internal/local-ci', async ({ body }) => {
    const input = await body<{
      runId?: string;
      taskId?: string;
      headSha?: string;
      branch?: string | null;
      ok?: boolean;
      exitCode?: number | null;
      durationMs?: number | null;
      logTail?: string;
    }>();
    if (!input.runId || !input.taskId || !input.headSha || typeof input.ok !== 'boolean') {
      throw new HttpFailure(400, 'a local CI result names its run, its task, its commit and whether it passed');
    }
    const task = await tasks.getTask(input.taskId);
    if (!task?.repoId) throw new HttpFailure(404, `unknown task ${input.taskId}, or one in no repository`);
    const recorded = await localCiRuns.record({
      runId: input.runId,
      taskId: task.id,
      repoId: task.repoId,
      branch: task.branch ?? input.branch ?? null,
      headSha: input.headSha,
      ok: input.ok,
      exitCode: typeof input.exitCode === 'number' ? input.exitCode : null,
      durationMs: typeof input.durationMs === 'number' ? Math.round(input.durationMs) : null,
      // Redacted after the cut, so the cut cannot split a token past the pattern;
      // CI output can print one (`redactSecrets`).
      logTail: typeof input.logTail === 'string' ? redactSecrets(input.logTail.slice(-16_000)) : null,
    });
    await audit({
      actor: 'hostd',
      action: input.ok ? 'local_ci.passed' : 'local_ci.failed',
      target: task.subjectRef,
      payload: { task: task.id, sha: input.headSha, run: input.runId, exitCode: input.exitCode ?? null },
    }).catch(() => undefined);
    return { recorded: Boolean(recorded) };
  });

  /**
   * The dispatcher decides who gets the work; the bridge is what tells GitHub and
   * starts the session, so every lease leaves the same trail: an assignment, a
   * comment carrying the expiry, and one running task.
   */
  post('/internal/dispatch/lease', async ({ body }) => {
    const input = await body<{
      leaseId: string;
      repo: string;
      issue: number;
      bot: string;
      /** The same bot by id, which stays put if it was renamed after the dispatcher read it. */
      botId?: string;
      declaredPaths: string[];
      expiresAt: string | null;
    }>();

    // While a restore is writing into this install, or a person has paused all
    // work from Settings, nothing new starts. The dispatcher lets the issue go
    // and asks again next pass.
    const paused = deps.dispatchGate?.paused();
    if (paused) throw new HttpFailure(409, paused);

    const repo = await repos.getRepoByName(input.repo);
    if (!repo) throw new HttpFailure(404, `unknown repository ${input.repo}`);

    // A person paused this repository. The dispatcher skips one it
    // knows is paused before asking; this is the authority, and says whose
    // pause it is and where to resume it.
    const pausedHere = deps.dispatchGate?.paused(repo.name);
    if (pausedHere) throw new HttpFailure(409, pausedHere);

    // At start-up the crew may still be taking their accounts' handles. A
    // lease asked for meanwhile waits for that, rather than starting work
    // under a name the bot is about to lose.
    await deps.names?.settled();
    const bot = (input.botId ? await bots.getBotById(input.botId) : null) ?? (await bots.getBotByName(input.bot));
    if (!bot) throw new HttpFailure(404, `unknown bot ${input.bot}`);

    // The dispatcher checks too. This is the authority: a lease the dispatcher
    // already took is released when this refuses, and nothing starts.
    const blocked = await spendingLimits.refusal({
      monthlyCapUsd: deps.config.costs.monthlyCapUsd,
      onCap: deps.config.costs.onCap,
      period: costs.currentPeriod(),
      repoId: repo.id,
      repoLabel: repo.fullName,
      botId: bot.id,
      botName: bot.name,
      engine: bot.engine,
    });
    if (blocked) throw new HttpFailure(409, blocked);

    // A closed issue is never built. The board's row can still say it is
    // routable for a while after a person closed or cancelled it, and any path
    // that lists it (an unblock, a stale row) ends here. A read that fails
    // counts as open, as `subjectClosed` says.
    const github = await asAutomation(deps.actors, deps.config).catch(() => null);
    if (github && (await subjectClosed(github, repo.fullName, input.issue))) {
      throw new HttpFailure(409, `${repo.fullName}#${input.issue} is closed on GitHub, so nothing is built for it. Reopen it to have it built.`);
    }

    // An issue whose pull request is still open goes on from that pull
    // request's branch, where its commits are: work sent back to design with
    // its pull request parked as a draft, and back in build now. Started from
    // the base, the build would redo them, and could not push over them.
    const open = await openPullOf(deps, repo, input.issue);
    const started = await startBuild(deps, {
      leaseId: input.leaseId,
      repo,
      issue: input.issue,
      bot,
      declaredPaths: input.declaredPaths,
      expiresAt: input.expiresAt,
      ...(open ? { continueBranch: open.branch, continuePull: open.number } : {}),
    });
    if (started.error) throw new HttpFailure(409, started.error);
    return { task: started };
  });

  /**
   * Brings every bot's name in line with its account, now rather than at the
   * next start: what `fleetadlc auth login` asks for once it has stored a
   * credential, so the bot it connected takes its handle without a restart.
   */
  post('/internal/bots/reconcile', async ({ body }) => {
    const input = await body<{ actor?: string }>();
    if (!deps.names) throw new HttpFailure(503, 'this bridge renames nothing');
    const outcomes = await deps.names.reconcile(input.actor?.trim() || 'fleetadlc');
    const crew = await bots.listBots();
    return {
      outcomes,
      bots: crew.map((bot) => ({ bot: bot.name, slot: bot.slot, githubLogin: bot.githubLogin })),
    };
  });

  /**
   * Connects a seat with a sign-in `fleetadlc auth login` got from GitHub's
   * device flow, exactly as the console's connect does (`Onboarding.connect`):
   * joining an account the seat's group already holds, refusing one the other
   * group holds, leaving the seat's old account first. The CLI used to do this
   * itself, and refused every seat after the first on a shared account.
   * The token arrives over loopback, is written only to the secret store, and
   * is never in the answer.
   */
  post('/internal/bots/connect', async ({ body }) => {
    const input = await body<{
      bot?: string;
      actor?: string;
      token?: { accessToken?: string; refreshToken?: string | null; expiresAt?: string | null; refreshExpiresAt?: string | null; scopes?: string[]; tokenType?: string };
    }>();
    const token = input.token;
    if (!input.bot || !token?.accessToken) throw new HttpFailure(400, 'name the seat and give the sign-in GitHub returned');
    const bot = resolveBotRef(await bots.listBots(), input.bot);
    if (!bot) throw new HttpFailure(404, `no bot named ${input.bot}`);
    const at = (value: string | null | undefined): Date | null => (value ? new Date(value) : null);
    return deps.onboarding.connect({
      botId: bot.id,
      actor: input.actor?.trim() || 'fleetadlc auth login',
      token: {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken ?? null,
        expiresAt: at(token.expiresAt),
        refreshExpiresAt: at(token.refreshExpiresAt),
        scopes: Array.isArray(token.scopes) ? token.scopes : [],
        tokenType: token.tokenType ?? 'bearer',
      },
    });
  });

  post('/internal/schedule/:job', async ({ params }) => {
    await recordEvent({ source: 'schedule', type: params.job ?? 'unknown', payload: {} });
    return deps.scheduler.run(params.job ?? '');
  });

  /**
   * Turns a monitoring alert into an issue in the owning repository.
   *
   * There was nowhere for one to land, so an alert from outside the platform
   * had no way of becoming work. Deduplicated by fingerprint, because an alert
   * that fires every minute must produce one issue and not a minute's worth:
   * the fingerprint goes in the body, and an open issue carrying it is the
   * answer rather than a new one.
   *
   * An outside monitor holds the alerts secret (`alertsSecretRef`), sent as
   * `x-fleetadlc-alerts-secret`, never the internal secret: that one mints
   * every bot's GitHub token and starts work. The internal secret is accepted
   * too, for the platform's own callers.
   */
  router.post('/internal/alerts', async (context) => {
    requireAlertsSecret(context.raw, deps.alertsSecret, deps.internalSecret);
    const { body } = context;
    const input = await body<{
      fingerprint?: string;
      title?: string;
      description?: string;
      repo?: string;
      severity?: string;
      url?: string;
    }>();

    const title = (input.title ?? '').trim();
    if (!title) throw new HttpFailure(400, 'an alert needs a title');

    // Falls back to the title, so an alert that does not fingerprint itself is
    // still deduplicated rather than repeating.
    const fingerprint = (input.fingerprint ?? title).trim();
    const repoList = await repos.listRepos();
    const target = input.repo ? repoList.find((entry) => entry.name === input.repo || entry.fullName === input.repo) : repoList[0];
    if (!target) throw new HttpFailure(404, `no repository named ${input.repo ?? '(none configured)'}`);

    const marker = dedupeMarker('alert', fingerprint);
    const client = await asAutomation(deps.automation['actors'], deps.config);
    if (!client) {
      return { filed: false, reason: 'no connected account to file it with', fingerprint, repo: target.fullName };
    }

    // Only an open alert OpenADLC filed, every page of them; unread, it is filed.
    const existing = await findOwnOpenIssue(client, target.fullName, await automationLogin(deps.config), 'alert', fingerprint, { label: 'alert' }).catch(
      () => null,
    );
    if (existing) return { filed: false, reason: 'already open', issue: existing, fingerprint };

    const created = await client
      .request<{ number: number; labels?: (string | { name?: string })[] }>('POST', `/repos/${target.fullName}/issues`, {
        title: `Alert: ${title}`,
        body: [
          input.description ?? 'No description was given.',
          '',
          input.url ? `Source: ${input.url}` : '',
          input.severity ? `Severity: ${input.severity}` : '',
          '',
          marker,
        ]
          .filter(Boolean)
          .join('\n'),
        labels: ['alert', 'adlc:intake', 'do:ai'],
      })
      .catch(() => null);

    if (!created) throw new HttpFailure(502, 'GitHub refused the issue');

    // GitHub drops, without a word, the labels an account without push access
    // asks for at creation, and the automation account usually holds triage.
    // Without `alert` the next firing is not found and files a second issue;
    // without `adlc:intake` nobody picks it up. What it lacks is added after,
    // which triage may do, once the app has made `alert` where the repository
    // was never set up with it.
    const carried = new Set((created.labels ?? []).map((label) => (typeof label === 'string' ? label : (label.name ?? ''))));
    const lacking = ['alert', 'adlc:intake', 'do:ai'].filter((label) => !carried.has(label));
    if (lacking.length > 0) {
      if (lacking.includes('alert')) await deps.repoSetup.ensureLabel?.(target.fullName, 'alert').catch(() => false);
      await client.addLabels(target.fullName, created.number, lacking).catch((error: unknown) => {
        console.warn(`[bridge] alert ${target.fullName}#${created.number} is without ${lacking.join(', ')}: ${error instanceof Error ? error.message : error}`);
      });
    }
    return { filed: true, issue: created.number, fingerprint, repo: target.fullName };
  });

  /**
   * Removes `blocked` and applies `start:now`, as the automation account.
   *
   * The dispatcher decides — it is the component that knows what is waiting on
   * what — and this is where the decision becomes a label. Every label the
   * platform writes goes through the automation account, and it is audited,
   * because an issue becoming routable is a thing somebody may need to explain.
   */
  post('/internal/issues/:repo/:number/unblock', async ({ params, body }) => {
    const input = await body<{ dependencies?: number[] }>();
    const repo = await repos.getRepoByName(params.repo ?? '');
    if (!repo) throw new HttpFailure(404, `no repository named ${params.repo ?? ''}`);

    const number = Number(params.number ?? '');
    if (!Number.isFinite(number)) throw new HttpFailure(400, 'the issue number is not a number');

    const issue = await issues.getIssue(repo.id, number);
    if (!issue) throw new HttpFailure(404, `${repo.name}#${number} is not on the board`);
    if (!issue.labels.includes('blocked')) return { changed: false, reason: 'it was not blocked' };
    // Unblocking adds `start:now`. The dispatcher's list leaves ignored issues
    // out, and this refuses them too, whoever asks.
    if (hasIgnoreLabel(issue.labels)) return { changed: false, reason: 'it is labelled fleetadlc:ignore' };

    await deps.automation.setBlocked(repo.fullName, number, false);
    // And on the board, so it does not keep showing as blocked until the
    // webhook comes back — the same as a stage move.
    await issues.setBlockedLabel(repo.id, number, false);

    const waited = (input.dependencies ?? []).map((entry) => `#${entry}`).join(', ');
    await audit({
      actor: await automationBotName(deps.config),
      action: 'issue.unblocked',
      target: `${repo.name}#${number}`,
      payload: { dependencies: input.dependencies ?? [] },
    });

    return { changed: true, issue: number, waitedFor: waited };
  });

  /**
   * Labels an issue `needs-triage`, so intake can shape it.
   *
   * The dispatcher decides not to lease; this is where that becomes something a
   * person and the intake bot can see. `start:now` comes off with it — an issue
   * that is not ready must not be routable, or the next pass reaches the same
   * conclusion and says it again.
   */
  post('/internal/issues/:repo/:number/triage', async ({ params, body }) => {
    const input = await body<{ reason?: string }>();
    const { repo, number, issue } = await issueOnBoard(params);
    if (issue.labels.includes('needs-triage')) return { changed: false, reason: 'already in triage' };

    await sendToTriage(repo, number, input.reason ?? null);
    return { changed: true, issue: number, reason: input.reason ?? null };
  });

  /**
   * Sends an issue whose Expected paths have a line that is not a path back
   * to the stage that wrote them: intake for an issue intake sent to build,
   * design for one whose paths design wrote. `needs-triage` waits for a
   * person, and a line to rewrite from the code is no question for one.
   *
   * The stage is `previousStage`'s, from the issue's own history, as for any
   * send-back. Only when the issue cannot be sent back does it go to triage
   * instead; past the repository's send-back limits it stops at `needs-human`,
   * as every send-back does.
   */
  post('/internal/issues/:repo/:number/expected-paths', async ({ params, body }) => {
    const input = await body<{ reason?: string }>();
    const { repo, number, issue } = await issueOnBoard(params);
    if (issue.labels.includes('needs-triage')) return { changed: false, outcome: 'triaged', reason: 'already in triage' };

    const lines = unreadablePathLines(issue.body ?? '');
    const why = [
      'Its Expected paths have lines that are not paths, so the lease would not claim the files they mean:',
      '',
      ...(lines.length > 0 ? lines.map((line) => `- ${line}`) : [input.reason ?? 'no line there reads as a path']),
      '',
      'Rewrite the section from the code: one file per line, a path in the repository and nothing else on it, then set the stage again.',
    ].join('\n');

    const sent = deps.sendBack
      ? await deps.sendBack.fromBridge({ repoName: repo.name, issueNumber: number, from: 'build', reason: why })
      : { sent: false as const, reason: 'this bridge takes no send-backs' };
    const target = `${repo.name}#${number}`;
    if (sent.sent) {
      await audit({ actor: await automationBotName(deps.config), action: 'issue.paths_sent_back', target, payload: { to: sent.to, lines } });
      return { changed: true, outcome: 'sent', reason: `sent back to ${sent.to} to rewrite its Expected paths` };
    }
    // Past its limits the send-back has put needs-human on, and said so.
    if (sent.stalled) return { changed: true, outcome: 'stalled', reason: sent.reason };

    await sendToTriage(repo, number, input.reason ?? null, { sendBackRefused: sent.reason, lines });
    return { changed: true, outcome: 'triaged', reason: `${input.reason ?? 'its Expected paths do not read'}; not sent back: ${sent.reason}` };
  });

  /** The repository and the issue a route under `/internal/issues/:repo/:number` names. */
  async function issueOnBoard(params: Record<string, string | undefined>) {
    const repo = await repos.getRepoByName(params.repo ?? '');
    if (!repo) throw new HttpFailure(404, `no repository named ${params.repo ?? ''}`);

    const number = Number(params.number ?? '');
    if (!Number.isFinite(number)) throw new HttpFailure(400, 'the issue number is not a number');

    const issue = await issues.getIssue(repo.id, number);
    if (!issue) throw new HttpFailure(404, `${repo.name}#${number} is not on the board`);
    return { repo, number, issue };
  }

  async function sendToTriage(repo: { id: string; name: string; fullName: string }, number: number, reason: string | null, more: Record<string, unknown> = {}) {
    await deps.automation.sendToTriage(repo.fullName, number, reason ?? 'it is not ready to be worked on');
    await issues.setTriageLabel(repo.id, number);

    await audit({
      actor: await automationBotName(deps.config),
      action: 'issue.triaged',
      target: `${repo.name}#${number}`,
      payload: { reason, ...more },
    });
  }

  post('/internal/events', async ({ body }) => {
    const input = await body<{ type: string; payload?: unknown }>();
    await recordEvent({ source: 'platform', type: input.type, payload: input.payload ?? {} });
    return { ok: true };
  });

  router.get('/healthz', async () => {
    // Report what the platform can actually do as an account, not what is configured.
    const automation = await automationBotName(deps.config);
    const acting = await deps.actors.asBot(automation);
    return {
      ok: true,
      // Whether the engines are scripted: the integration suites run only
      // against an install that says so, since they write into its board.
      scripted: process.env.FLEETADLC_SCRIPTED_ENGINES === '1',
      hostd: await deps.hostd.health(),
      // Decided on the client id, the console's stored one included. It was
      // `Actors.configured`, which is true on every install, so a missing
      // client id was never reported.
      github: acting
        ? `acting as ${automation}`
        : (await effectiveConfig(deps.config)).gitHubClientId
          ? `no credential for ${automation}: run fleetadlc auth login --bot ${automation}`
          : NO_CLIENT_ID,
    };
  });
}

/**
 * The numbers a task's posts may name: its subject, and the issue's pull
 * request or the pull request's issue. A subject with no number names none.
 */
async function targetsOfTask(task: Task, subject: { repo: string; number: number } | null, repoName: string | null): Promise<number[]> {
  if (!subject) return [];
  const own = [subject.number];
  if (!task.repoId) return own;
  const issue = await issues.getIssue(task.repoId, subject.number).catch(() => null);
  if (issue?.prNumber) own.push(issue.prNumber);
  const pulledFrom = (await issues.listIssues(repoName ?? subject.repo).catch(() => [])).find((one) => one.prNumber === subject.number);
  if (pulledFrom) own.push(pulledFrom.number);
  return own;
}

/**
 * The line a bot's thread gets when its task ends without finishing: what
 * stopped, and why, in the reason the task gave.
 */
async function sayTaskEnded(task: Task, state: 'failed' | 'stopped', reason: string | null): Promise<void> {
  const bot = await bots.getBotById(task.botId);
  const who = botAtStart(bot);
  const thread = await threads.ensureThread({ botId: task.botId, repoId: task.repoId, subjectRef: task.subjectRef });
  // A runner that lived to the end says it stopped, and why, before it sends
  // the state. Then the thread has it already; this is for the task that died
  // before it could — an engine it could not find, a container that went.
  const recent = await threads.listMessages([thread.id], 20);
  if (recent.some((message) => message.payload?.event === 'stopped' && message.payload?.taskId === task.id)) return;
  await threads.addMessage({
    threadId: thread.id,
    kind: 'sys',
    author: 'fleetadlc',
    text: state === 'failed' ? `${who} could not finish ${task.subjectRef}` : `${who} stopped work on ${task.subjectRef}`,
    note: reason ?? state,
    payload: { taskId: task.id, state },
  });
}

/**
 * The open pull request an issue's work is in, when its branch is a builder's
 * for this issue in this repository; null when there is none, or GitHub
 * cannot be asked, which starts the build from the base as before.
 */
async function openPullOf(
  deps: Pick<ApiDeps, 'actors' | 'config'>,
  repo: { id: string; fullName: string },
  issueNumber: number,
): Promise<{ number: number; branch: string } | null> {
  const issue = await (async () => issues.getIssue(repo.id, issueNumber))().catch(() => null);
  if (!issue?.prNumber) return null;
  const client = await asAutomation(deps.actors, deps.config).catch(() => null);
  const pull = client ? await client.getPullRequest(repo.fullName, issue.prNumber).catch(() => null) : null;
  if (!pull || pull.state !== 'open' || pull.headRepoFullName?.toLowerCase() !== repo.fullName.toLowerCase()) return null;
  return issueNumberFromBranch(pull.headRef) === issueNumber ? { number: pull.number, branch: pull.headRef } : null;
}
