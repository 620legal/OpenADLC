import { resolutionCheckBrief, type ConflictRounds } from './conflict-round.js';
import { builderOfBranch, type Stacking } from './stacking.js';
import {
  audit,
  bots,
  hasEventOfType,
  issues,
  lastAudit,
  leases,
  listEventsOfType,
  localCiRuns,
  listUnprocessedEventsOfType,
  markEventProcessed,
  recordEvent,
  repos,
  settings,
  spendingLimits,
  tasks,
  threads,
  withAdvisoryLock,
} from '@fleetadlc/db';
import {
  CI_LABEL,
  CROSS_CUTTING_LABEL,
  acceptsCrossCutting,
  REQUIRED_CHECK,
  REVIEW_GATE_CHECK,
  accountsThatNeverAuthor,
  actsFor,
  closingKeywords,
  declaredPathsFrom,
  isFleetLogin,
  parseMarker,
  sameLogin,
  stageFromLabels,
  isBackwardMove,
  whoWrote,
  type StageKey,
  headlineFor,
  messageKindFor,
  seatOf,
  withoutMarker,
  type FleetMarker,
  dedupeMarker,
  hasIgnoreLabel,
  isIgnoreLabel,
} from '@fleetadlc/shared';
import { touchesConfig, type GitHubClient } from '@fleetadlc/github';
import type { Attribution } from './attribution.js';
import type { Automation } from './automation.js';
import { effectiveConfig } from './effective-config.js';
import { actsForOn, permissionOn, repoAccess, type PermissionAsker } from './people.js';
import { isPinnedHuman } from './human-ids.js';
import { asAutomation, automationBotName, findOwnOpenIssue } from './automation-bot.js';
import type { BridgeConfig } from './config.js';
import { alreadyLanded, type Gates } from './gates.js';
import { askedForCi, type MergeLine } from './merge-line.js';
import { itemLink, type Notifier } from './notify.js';
import { recordDesignMemory, type CommentSignature } from './design-memory.js';
import { NO_TESTING_URL, openQaRun, qaTarget, taskGaveUp } from './scheduler.js';
import { stageAfterIntake, type StageHandoff } from './stage-handoff.js';
import { retakeLease, SendBack } from './send-back.js';
import { chooseIssueText, editNotTaken } from './vouched-text.js';
import { workflowFile, type DeployPipeline, type RevertOutcome } from './deploy-pipeline.js';
import type { DeliveryKnowledge } from './delivery-rules.js';
import { BotBusyError, REVERT_BRANCH_PREFIX, type TaskService } from './task-service.js';
import { FORBIDDEN_PUSH, ciKeysChanged, contentChanged, fastPathOf, forbiddenPushGate, reviewSample } from './automation.js';
import { continuesBranch } from './build-left.js';
import { DEPLOY_PATH_BRANCH_PREFIX, headInRepository, issueNumberFromBranch, issuesMergedBy, ownIssueOf, REVIEW_ROUND_OPENED, REVIEW_STALLED, scopeLabelAcceptedFrom } from './work.js';
import { shipsByMerging, testingDeployChoice } from './deploys.js';
import type { RequestFiling } from './request-lifecycle.js';

/**
 * The pull requests the bridge put `scope:cross-cutting` on for the lead, by
 * `owner/repo#n`, until the label guard sees that add: on an account the crew
 * shares, the guard cannot tell the bridge's add from a session's otherwise.
 */
const scopeAccepted = new Set<string>();

/** How long an app client is kept for a repository; its installation token lasts an hour. */
const APP_CLIENT_MS = 10 * 60 * 1000;

/** The deliveries that can change what may start, each of which asks for a dispatch. */
const STARTS_WORK = new Set(['issues', 'pull_request', 'deployment_status']);
import { PAUSED_LABEL } from '@fleetadlc/shared';
import { forgetHold } from './item-hold.js';

/** Why an app's reply is not an answer. */
const APP_ACCOUNT = 'it is an app’s account, not a person';
const IGNORED_ISSUE = 'the issue is labelled fleetadlc:ignore, which the crew leaves alone; take the label off and reply again, or answer in the console';

/**
 * An app's account, such as `renovate[bot]`. A machine user a person created
 * is type `User` and cannot be told apart from a person; see docs/security.md.
 */
function isAppAccount(user: { login: string; type?: string } | undefined): boolean {
  return Boolean(user && (user.type === 'Bot' || /\[bot\]$/i.test(user.login)));
}

/**
 * Whether a pull request's branch is in another repository: a fork, or one
 * deleted since (`null`, which the merge line takes as foreign too). A
 * builder's branch is always in the repository itself, so a head that names
 * no repository is not taken for one either (`headInRepository`).
 */
function fromFork(pr: { head: { repo?: { full_name?: string } | null } }, repoFullName: string): boolean {
  return !headInRepository(pr.head.repo?.full_name, repoFullName);
}

/**
 * What a pull request's head branch's owner can cause, whoever GitHub names as
 * the sender: a push, an open or reopen, a draft toggled, an edit. On a fork
 * that is the fork's owner, a second account they added, or an app running
 * there, and none of them needs a role on this repository.
 */
const BY_THE_BRANCH = new Set(['synchronize', 'opened', 'reopened', 'ready_for_review', 'converted_to_draft', 'edited']);

/** An edit by an author OpenADLC does not act for, to an issue a person vouched for: recorded, and not read. */
export const ISSUE_EDIT_NOT_READ = 'issue.edit_not_read';

interface WebhookPayload {
  action?: string;
  issue?: {
    number: number;
    title: string;
    id?: number;
    body: string | null;
    html_url: string;
    labels: { name: string }[];
    pull_request?: unknown;
    state?: string;
    /** `id` is the account's, which a login in `humans` is pinned to (`human-ids.ts`). */
    user?: { login: string; id?: number };
    author_association?: string;
  };
  pull_request?: {
    id?: number;
    number: number;
    title: string;
    body?: string | null;
    draft: boolean;
    merged?: boolean;
    /** `repo` is the repository the branch is in: another one's for a fork, null for a fork since deleted. */
    head: { sha: string; ref: string; repo?: { full_name?: string } | null };
    base?: { ref: string };
    /** Once merged: the commit the merge made on the base branch, which is what deploys. */
    merge_commit_sha?: string | null;
    merged_by?: { login: string } | null;
    labels: { name: string }[];
    html_url: string;
    user?: { login: string; id?: number };
    author_association?: string;
  };
  comment?: {
    id?: number;
    body: string;
    html_url: string;
    /** When it was written, by GitHub's clock. */
    created_at?: string;
    /** `Bot` for an app's account, such as `renovate[bot]`; `User` for a person. */
    user: { login: string; type?: string; id?: number };
    path?: string;
    line?: number | null;
    author_association?: string;
  };
  review?: { id?: number; state: string; body?: string | null; html_url?: string; user: { login: string; id?: number }; author_association?: string; commit_id?: string };
  /** On `labeled` and `unlabeled`: the label. */
  label?: { name: string };
  repository?: { name: string; full_name: string; default_branch?: string };
  /** On `installation` and `installation_repositories`, the whole installation; on anything else, its id. */
  installation?: { id?: number; account?: { login?: string; type?: string } | null };
  sender?: { login: string; type?: string; id?: number };
  requested_reviewer?: { login: string };
  workflow_run?: {
    id?: number;
    name: string;
    conclusion: string | null;
    head_sha: string;
    html_url?: string;
    /** What started the run: `push`, `workflow_run`, `pull_request`… */
    event?: string;
    /** The branch the run ran on. */
    head_branch?: string | null;
    /** 1 for the run as it first ran; each re-run of it adds one. */
    run_attempt?: number;
    pull_requests?: { number: number; head?: { ref?: string; sha?: string } }[];
    /** The run's `run-name`, which the promote sets to the candidate it deploys. */
    display_title?: string | null;
    /** Where the run's commit lives: a fork's, for a pull request from one. */
    head_repository?: { full_name?: string } | null;
    /** The workflow file the run is of, `.github/workflows/<file>`. */
    path?: string;
    /**
     * Who started the run. For a run another run started (`workflow_run`),
     * GitHub names the starter of that one: whoever's run named deploy-testing
     * set a smoke going.
     */
    triggering_actor?: { login: string; type?: string; id?: number } | null;
  };
  deployment?: { sha?: string; ref?: string; environment?: string };
  deployment_status?: {
    state?: string;
    environment?: string;
    /** The deployed revision's own URL, from the job's `environment.url`. */
    environment_url?: string | null;
    target_url?: string | null;
  };
}

/** What settling a merge reads of its pull request, from a delivery or from GitHub. */
type MergedPull = { number: number; head: { ref: string; repo?: { full_name?: string } | null }; base?: { ref: string }; body?: string | null };

/**
 * The `issues` actions that may put an issue on the board and start its
 * stage's bot. Reconcile, which has no action, may too.
 */
const LEARNING_ACTIONS = new Set(['opened', 'reopened', 'labeled', 'unlabeled', 'edited']);

/**
 * The bridge's event loop. Handlers re-derive what should be true from the
 * payload plus current state. A delivery GitHub could not make is sent again
 * when the bridge starts and on every reconciliation, every 15 minutes
 * (`Scheduler.redeliverFailed`); what is still missed is repaired by the next
 * event or that reconciliation. A duplicate delivery is not harmless
 * everywhere: a handler that starts work can start it again. A reply on GitHub
 * answers a question once, whatever is redelivered (`gate_replies`).
 */
export class Webhooks {
  constructor(
    private readonly config: BridgeConfig,
    private readonly automation: Automation,
    private readonly gates: Gates,
    private readonly taskService: TaskService,
    private readonly stages: StageHandoff,
    private readonly mergeLine: MergeLine,
    /** Optional so a caller that never reaches a promote need not wire one. */
    private readonly notifier: Notifier | null = null,
    /** Asked for a dispatch after anything that can let work start; see `DispatchRunner`. */
    private readonly dispatchRuns: { soon(reason: string): void } | null = null,
    /** Files a console request as the issue that names it; see `RequestFiling.issueOpened`. */
    private readonly requestFiling: Pick<RequestFiling, 'issueOpened'> | null = null,
    /** Checks the signature on what the crew posts; absent, nothing is checked. See `attribution.ts`. */
    private readonly attribution: Attribution | null = null,
    /**
     * `retryTask`, bound to what it needs: a person's comment on an issue
     * whose build ended without its pull request goes on from its branch.
     * Absent, such a comment is recorded and starts nothing.
     */
    private readonly continueBuild: ((taskId: string, actor: string) => Promise<unknown>) | null = null,
    /**
     * Sends work back to an earlier stage: the review loop's rounds, and a
     * person moving a label back. See `send-back.ts`. Absent, one is made from
     * what this has: it starts the stage a person moved work back to, but stops
     * none of the tasks that move left behind (no `stopTask`), and has no
     * `client` for the merge line's and CI's send-backs.
     */
    sendBack: SendBack | null = null,
  ) {
    this.sendBack = sendBack ?? new SendBack({ config, automation, mergeLine, taskService, stages, dispatchRuns });
  }

  private readonly sendBack: SendBack;

  /** A merged change's way to production by its repository's rules; see `deploy-pipeline.ts`. */
  private pipeline: DeployPipeline | null = null;
  private delivery: DeliveryKnowledge | null = null;

  /** Set once both exist (`main.ts`); absent, a merge starts no deploy here. */
  useDelivery(pipeline: DeployPipeline, delivery: DeliveryKnowledge): void {
    this.pipeline = pipeline;
    this.delivery = delivery;
  }

  async receive(event: string, payload: WebhookPayload, deliveryId: string | null): Promise<void> {
    const type = `${event}${payload.action ? `.${payload.action}` : ''}`;
    // A repository the install does not manage is recorded by name only. The
    // whole payload used to be stored first, so an app installed on more
    // repositories than OpenADLC works in kept their issue, pull request and
    // comment bodies in the database and its backups.
    if (!(await this.ours(payload.repository))) {
      const eventId = await recordEvent({ source: 'github', type, deliveryId, payload: { repository: payload.repository?.full_name ?? null } });
      await markEventProcessed(eventId);
      return;
    }
    const eventId = await recordEvent({ source: 'github', type, deliveryId, payload });

    try {
      const attributed = (await this.fromSomeoneWithAccess(event, payload))
        ? await this.attributed(event, payload)
        : null;
      if (!attributed?.counts) {
        await markEventProcessed(eventId);
        return;
      }
      await this.dispatch(event, payload, attributed.signature);
      await markEventProcessed(eventId);
      // An issue labelled, moved, opened or closed, a pull request merged or
      // closed, a deploy that ships: each can let the next piece of work start.
      if (STARTS_WORK.has(event)) this.dispatchRuns?.soon(`${event}${payload.action ? `.${payload.action}` : ''}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markEventProcessed(eventId, message);
      throw error;
    }
  }

  /** Told when the app's installations change; see `whenInstallationChanged`. */
  private readonly installationListeners: ((account: string) => void | Promise<void>)[] = [];
  /** Accounts an installation changed on that OpenADLC works in no repository of, each said once. */
  private readonly unmanagedAccounts = new Set<string>();

  /**
   * Something to tell when the app is installed, uninstalled, suspended or
   * given other repositories on an account. Settings and the board say what
   * the app can reach; asking again when GitHub says it changed is what makes
   * them change as somebody comes back from GitHub, not a quarter hour later.
   */
  whenInstallationChanged(listener: (account: string) => void | Promise<void>): void {
    this.installationListeners.push(listener);
  }

  /** Told when a merge changes a repository's configuration; see `whenConfigurationChanged`. */
  private readonly configurationListeners: ((repoFullName: string) => void | Promise<void>)[] = [];

  /**
   * Something to tell when a pull request merged into a repository's default
   * branch changes one of the files the configuration check reads
   * (`CONFIG_FILES`): a name corrected in AGENTS.md clears its card now, not
   * at the next half hour.
   *
   * The merge is what is listened to, not a push: the app is not subscribed
   * to `push` (`WEBHOOK_EVENTS`), so a check waiting on one never ran, and a
   * change to the default branch reaches it through a pull request anyway.
   * A file pushed straight to the branch is seen at the check's next run.
   */
  whenConfigurationChanged(listener: (repoFullName: string) => void | Promise<void>): void {
    this.configurationListeners.push(listener);
  }

  private async noticeConfigurationMerged(
    repo: { defaultBranch: string },
    repoFullName: string,
    pr: NonNullable<WebhookPayload['pull_request']>,
  ): Promise<void> {
    if (this.configurationListeners.length === 0) return;
    // A branch's AGENTS.md is not what the gate reads: the default branch's is.
    if (!pr.base?.ref || pr.base.ref !== repo.defaultBranch) return;
    try {
      const client = await asAutomation(this.automation['actors'], this.config);
      if (!client) return;
      if (!touchesConfig(await client.listPullFiles(repoFullName, pr.number))) return;
      for (const listener of this.configurationListeners) await listener(repoFullName);
    } catch (error) {
      // The check runs again on its own schedule either way.
      console.warn(`[bridge] after ${repoFullName}#${pr.number} merged, its configuration was not checked again: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** Repositories a delivery was ignored for, each said once. */
  private readonly strangers = new Set<string>();

  /**
   * Whether a delivery is about a repository OpenADLC works in, by owner and name.
   *
   * Every handler below finds its repository by name alone, which is what the
   * install keys its issues and tasks by. So a delivery from somebody else's
   * repository of the same name — `someone/fleetadlc` — was taken for ours, and its
   * issue learned as ours and handed to a builder with write access here. Once
   * the app is installable by anyone, anyone can send one. A delivery about no
   * repository, an installation's, is not this check's to refuse.
   */
  private async ours(repository: WebhookPayload['repository']): Promise<boolean> {
    if (!repository) return true;
    if (repository.full_name && (await repos.getRepoByName(repository.full_name))) return true;
    if (!this.strangers.has(repository.full_name)) {
      this.strangers.add(repository.full_name);
      console.log(`[bridge] ignoring deliveries for ${repository.full_name}: not a repository OpenADLC works in`);
    }
    return false;
  }

  /** Authors a delivery was ignored for, each said once. */
  private readonly outsiders = new Set<string>();
  /** Gates an author's reply was not taken for, each said once in the gate's thread. */
  private readonly answersNotTaken = new Set<string>();

  /**
   * Says in the thread of the gate open on this comment's issue that the reply
   * was not taken as its answer, and why. Without it a person whose reply was
   * refused saw nothing happen, and neither did whoever watched the task wait.
   * Once per gate and author, so a stranger commenting again and again writes
   * one line, not one per comment. Nothing is posted on GitHub: answering a
   * stranger there is a way to make the crew write whatever they choose.
   */
  private async answerNotTaken(payload: WebhookPayload, login: string, why: string): Promise<void> {
    if (payload.action !== 'created' || !payload.issue || !payload.repository) return;
    try {
      const repo = await repos.getRepoByName(payload.repository.name);
      if (!repo) return;
      const gate = await this.gateForSubject(await threads.listOpenGates(), `${repo.name}#${payload.issue.number}`);
      const key = `${gate?.id}:${login.toLowerCase()}`;
      if (!gate?.threadId || this.answersNotTaken.has(key)) return;
      await threads.addMessage({
        threadId: gate.threadId,
        kind: 'sys',
        author: 'fleetadlc',
        text: `${login} replied on GitHub, and it was not taken as the answer: ${why}.`,
        payload: { gateId: gate.id, login },
        githubUrl: payload.comment?.html_url ?? null,
      });
      // Only once it is written: a note that failed is tried again on the next reply.
      this.answersNotTaken.add(key);
    } catch (error) {
      console.warn(`[bridge] could not say a reply by ${login} was not taken: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** Requests for changes that sent nothing back, each said once per pull request and reviewer. */
  private readonly reviewsNotTaken = new Set<string>();

  /**
   * Says in the builder's thread that a request for changes did not send the
   * work back, and why, as `answerNotTaken` does for a reply to a gate. A
   * review comes with no gate, so the thread is the builder's on the issue
   * the branch was cut for. Nothing is posted on GitHub.
   */
  private async reviewNotTaken(
    repo: { id: string; name: string; ownerBotId?: string | null },
    repoFullName: string,
    pr: NonNullable<WebhookPayload['pull_request']>,
    login: string,
    why: string,
  ): Promise<void> {
    console.log(`[bridge] ${repoFullName}#${pr.number}: ${login} asked for changes, and the work was not sent back: ${why}`);
    const key = `${repo.name}#${pr.number}:${login.toLowerCase()}`;
    if (this.reviewsNotTaken.has(key)) return;
    try {
      const issueNumber = ownIssueOf(pr, repoFullName);
      const lease = issueNumber ? await leases.getActiveLease(repo.id, issueNumber).catch(() => null) : null;
      const botId = lease?.botId ?? repo.ownerBotId ?? null;
      if (!botId) return;
      const thread = await threads.ensureThread({ botId, repoId: repo.id, subjectRef: `${repo.name}#${issueNumber ?? pr.number}` });
      await threads.addMessage({
        threadId: thread.id,
        kind: 'sys',
        author: 'fleetadlc',
        text: `${login} asked for changes on #${pr.number}, and the work was not sent back: ${why}.`,
        payload: { pr: pr.number, login },
        githubUrl: pr.html_url ?? null,
      });
      // Only once it is written: a note that failed is tried again on the next review.
      this.reviewsNotTaken.add(key);
    } catch (error) {
      console.warn(`[bridge] could not say a review by ${login} was not taken: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * Whether a delivery is from somebody OpenADLC acts for; see `actsFor`.
   *
   * What is judged is the thing the delivery is about: the issue, the pull
   * request, the comment or the review, by its author. Anybody acting on
   * somebody else's issue or pull request — labelling it, closing it, moving
   * it — holds a role on the repository, since GitHub lets nobody else, so a
   * person with access labelling a stranger's issue is what lets OpenADLC start
   * on it. A push to a pull request's branch is not one of those: on a fork,
   * whoever the fork's owner lets push — a second account, an app — sends it
   * with no role here, so what the branch's owner can cause is judged by the
   * pull request's author (`BY_THE_BRANCH`). Deliveries about the repository's
   * own machinery — checks, runs, deployments — have no author to judge.
   */
  private async fromSomeoneWithAccess(event: string, payload: WebhookPayload): Promise<boolean> {
    const written =
      event === 'issue_comment' || event === 'pull_request_review_comment'
        ? payload.comment
        : event === 'pull_request_review'
          ? payload.review
          : event === 'issues'
            ? payload.issue
            : event === 'pull_request'
              ? payload.pull_request
              : undefined;
    if (!written) return true;

    const author = written.user?.login ?? null;
    const authorId = (written.user as { id?: number } | undefined)?.id ?? null;
    const actedOnByAnother =
      (event === 'issues' || (event === 'pull_request' && !BY_THE_BRANCH.has(payload.action ?? ''))) &&
      payload.sender &&
      author &&
      !sameLogin(payload.sender.login, author);
    if (actedOnByAnother) return true;

    const crew = await bots.listBots().catch(() => []);
    if (actsFor({ login: author, association: written.author_association }, crew)) return true;
    if (author && payload.repository) {
      const live = await effectiveConfig(this.config).catch(() => null);
      const client = await asAutomation(this.automation['actors'], this.config).catch(() => null);
      if (await actsForOn({ client, repoFullName: payload.repository.full_name, author: { login: author, association: null, id: authorId }, crew, humans: live?.humans ?? [] })) {
        return true;
      }
    }

    if (event === 'issue_comment' && author) {
      await this.answerNotTaken(payload, author, isAppAccount(payload.comment?.user) ? APP_ACCOUNT : 'they have no access to the repository');
    }
    if (event === 'issues' && payload.action === 'edited' && author) await this.editNotRead(payload, author);

    const who = `${payload.repository?.full_name ?? 'a repository'}: ${author ?? 'an author GitHub did not name'}`;
    if (!this.outsiders.has(who)) {
      this.outsiders.add(who);
      console.log(`[bridge] not acting on ${event} by ${author ?? 'nobody named'} in ${payload.repository?.full_name}: no access to the repository`);
    }
    return false;
  }

  /**
   * Whether a post by one of the crew's accounts carries a signature that
   * checks, for what it is and where it is (`attribution.ts`). Only a post as
   * it is written — opened, created, submitted or edited — is checked; an
   * edit is checked again, which is what catches one stage rewriting another's
   * post. In `audit` mode a failure is recorded and the post still counts.
   */
  /**
   * Whether a post counts, and what its signature said: `signature` is null
   * when nothing was checked. A post that counts in audit mode without a
   * signature still counts for everything it did before; only what one task
   * alone may post (design memory) reads the signature itself.
   */
  private async attributed(
    event: string,
    payload: WebhookPayload,
  ): Promise<{ counts: boolean; signature: CommentSignature | null }> {
    const unchecked = { counts: true, signature: null };
    if (!this.attribution || !payload.repository) return unchecked;
    const action = payload.action ?? '';
    const post =
      event === 'issue_comment' && (action === 'created' || action === 'edited') && payload.comment
        ? { kind: 'comment', id: payload.comment.id, number: payload.issue?.number ?? null, login: payload.comment.user?.login, body: payload.comment.body, url: payload.comment.html_url }
        : event === 'pull_request_review' && (action === 'submitted' || action === 'edited') && payload.review
          ? { kind: 'review', id: payload.review.id, number: payload.pull_request?.number ?? null, login: payload.review.user?.login, body: payload.review.body ?? null, url: payload.review.html_url ?? null }
          : event === 'issues' && (action === 'opened' || action === 'edited') && payload.issue
            ? { kind: 'issue', id: payload.issue.id ?? payload.issue.number, number: payload.issue.number, login: payload.issue.user?.login, body: payload.issue.body, url: payload.issue.html_url }
            : event === 'pull_request' && (action === 'opened' || action === 'edited') && payload.pull_request
              ? { kind: 'pr', id: payload.pull_request.id ?? payload.pull_request.number, number: payload.pull_request.number, login: payload.pull_request.user?.login, body: payload.pull_request.body ?? null, url: payload.pull_request.html_url }
              : null;
    // A review submitted with no body — an approval and nothing else — has
    // nothing to sign; what it counts for is decided where reviews are counted.
    if (!post?.login || post.id === undefined || (post.kind === 'review' && !post.body)) return unchecked;
    // An edit is judged by who made it, not who first posted. A person
    // correcting a crew post's Expected paths was checked as the crew account,
    // and raised the stolen-sign-in alarm; a crew account editing a person's
    // issue was never checked at all. A person's edit has nothing to sign.
    if (action === 'edited' && payload.sender?.login) post.login = payload.sender.login;

    const crew = await bots.listBots().catch(() => []);
    const mode = (await effectiveConfig(this.config).catch(() => null))?.attributionMode ?? 'audit';
    const checked = await this.attribution
      .check({ ...post, repo: payload.repository.full_name, id: post.id, login: post.login }, crew, mode)
      .catch((error: unknown) => {
        console.warn(`[bridge] could not check a signature: ${error instanceof Error ? error.message : error}`);
        return { counts: true, verified: false, seat: null, task: null };
      });
    return { counts: checked.counts, signature: { verified: checked.verified, seat: checked.seat, task: checked.task } };
  }

  private async dispatch(event: string, payload: WebhookPayload, signature: CommentSignature | null = null): Promise<void> {
    switch (event) {
      case 'issues':
        return this.onIssue(payload);
      case 'issue_comment':
        return this.onIssueComment(payload, signature);
      case 'pull_request':
        return this.onPullRequest(payload);
      case 'pull_request_review':
        return this.onReview(payload);
      case 'workflow_run':
        return this.onWorkflowRun(payload);
      case 'check_suite':
      case 'check_run':
      case 'status':
        return this.onChecks(payload);

      // Recorded decisions, so a subscribed event is never silently dropped and
      // the next reader does not have to work out whether it was an oversight.
      case 'push':
        // A push to a pull request's branch arrives again as
        // `pull_request.synchronize`, which is where the diff is compared and
        // stale approvals are dismissed. A push to the base branch is GitHub's
        // business: the merge line brings the next pull request up to date on
        // its own schedule, so there is nothing for it to do here. (The app is
        // not subscribed to `push`; a change to the configuration is seen at
        // the merge, `noticeConfigurationMerged`.)
        return;
      case 'pull_request_review_comment':
        // Not subscribed: a patch round reads a pull request's line comments
        // from GitHub when it starts (`context.ts`), so none is missed.
        return;
      case 'deployment':
        // The deployment being created says a deploy started, which is true of
        // a deploy that then fails. `deployment_status` is the one that carries
        // a verdict, and acting on anything less would label a pull request as
        // live somewhere before it is.
        return;
      case 'deployment_status':
        return this.onDeploymentStatus(payload);
      case 'installation':
      case 'installation_repositories':
        return this.onInstallation(payload);

      default:
        return;
    }
  }

  /**
   * The app installed, uninstalled, suspended or given other repositories.
   *
   * GitHub sends these to every app with a webhook, subscribed or not, and a
   * public app can be installed by anyone — so this is a delivery from anyone.
   * Nothing here acts on the account: what it tells only looks again at where
   * the app can reach, which is what settings and the repositories OpenADLC works
   * in are waiting on. An account OpenADLC works in nothing of is said once.
   */
  private async onInstallation(payload: WebhookPayload): Promise<void> {
    const account = payload.installation?.account?.login;
    if (!account) return;
    const managed = (await repos.listRepos()).some((repo) => sameLogin(repo.fullName.split('/')[0], account));
    if (!managed && !this.unmanagedAccounts.has(account.toLowerCase())) {
      this.unmanagedAccounts.add(account.toLowerCase());
      console.log(`[bridge] the app's installation on ${account} changed; OpenADLC works in none of its repositories yet`);
    }
    for (const listener of this.installationListeners) {
      try {
        await listener(account);
      } catch (error) {
        // The checks look again on their own schedule either way.
        console.warn(`[bridge] after the installation on ${account} changed: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  /**
   * An issue as GitHub has it, onto the board, and the bot that staffs its
   * stage started.
   *
   * The `issues` delivery lands here, and so does reconcile when that delivery
   * never arrived — a hook GitHub was not sending from, a tunnel that was down,
   * a laptop asleep. One path, so an issue found late is treated exactly as one
   * heard on time. `action` is the delivery's; reconcile has none to give, and
   * only ever brings an issue that already carries a stage label.
   *
   * Only an open issue is recorded or staffed. Every `issues` action used to
   * land here and start its stage's bot: closing a stranger's issue from Needs
   * you handed its text to intake right after an admin turned it down,
   * cancelling an Intake or Design item restarted it, and a person closing an
   * issue in Design started a spec task on it. `state` is the delivery's;
   * reconcile and Needs you bring only open issues, so none given is open.
   *
   * A closed issue is never built again. Its row kept `adlc:build` and
   * `start:now`, so the dispatch a cancelled build's end asked for leased it
   * again and opened a new pull request. Unless it is merged or done, its row,
   * if there is one, loses `start:now`, and an implement task still on it is
   * stopped.
   */
  async learnIssue(
    repo: { id: string; name: string; fullName?: string },
    issue: { number: number; title: string; body: string | null; htmlUrl: string; labels: readonly string[]; state?: string },
    action?: string,
    /** Who changed it, from the delivery; reconcile has nobody to name. */
    sender?: string | null,
    /** Who wrote it, from the delivery, with their account's id when it names one. Absent keeps the text as given, unless a snapshot is already kept. */
    author?: { login: string | null; association: string | null; id?: number | null } | null,
    /** The one label a `labeled` or `unlabeled` delivery is about. */
    label?: string | null,
  ): Promise<void> {
    // Gone from this repository: nothing of it is kept to staff.
    if (action === 'deleted' || action === 'transferred') {
      await issues.forget(repo.id, issue.number);
      return;
    }
    // Closed, the row stays: a pull request that closes an issue can be heard
    // closing it before it is heard merging, and the merge is what moves the
    // row on (`moveClosedByMerge`). The reconciler forgets a closed issue no
    // merge closed.
    if (action === 'closed' || issue.state === 'closed') {
      const finished = (stage: string | null | undefined) => stage === 'merged' || stage === 'done';
      const known = await (async () => issues.getIssue(repo.id, issue.number))().catch(() => null);
      if (!finished(stageFromLabels(issue.labels)) && !finished(known?.stage)) {
        // Only a row already on the board: one for a closed issue is not made.
        if (known) await issues.setIssueLabels(repo.id, issue.number, issue.labels.filter((label) => label !== 'start:now'));
        await this.stopBuildsOf(repo.name, issue.number);
      }
      return;
    }

    // On an issue whose author OpenADLC does not act for, what is stored is
    // what a person with access stood behind, not the author's later edit.
    const vouched = await this.vouchedText(repo, issue, action, sender ?? null, author ?? null);
    issue = { ...issue, title: vouched.title, body: vouched.body };
    const store = async (row: Parameters<typeof issues.upsertIssue>[0]): Promise<void> => {
      await issues.upsertIssue(row);
      if (vouched.keep) await issues.setVouched(repo.id, issue.number, vouched.keep);
    };
    const labels = [...issue.labels];
    const liveStage = stageFromLabels(labels);

    // Assigned, locked, pinned, milestoned: nothing a person did there says
    // where the issue goes, nor vouches for a stranger's. Labelling does. A
    // row already kept is brought up to date; none is made, nothing is staffed.
    if (action !== undefined && !LEARNING_ACTIONS.has(action)) {
      const known = await issues.getIssue(repo.id, issue.number);
      if (known) {
        await issues.upsertIssue({
          repoId: repo.id,
          number: issue.number,
          title: issue.title,
          stage: known.stage,
          labels,
          declaredPaths: declaredPathsFrom(issue.body ?? ''),
          body: issue.body ?? '',
          url: issue.htmlUrl,
          prNumber: null,
        });
      }
      return;
    }

    // A stage label moved back on GitHub. A person may move a card anywhere,
    // and the rest is made to agree (`SendBack.fromPerson`). One of the crew's
    // accounts may not: a bot moves work back only by asking the bridge, which
    // checks where it goes and how often, so its label is put back. The
    // bridge's own moves never land here — the board's stage is written
    // before the label, so the delivery finds them already agreeing.
    //
    // Only a delivery that is itself the stage label changing is read as a
    // move: an earlier stage's label added, or the stored stage's taken off.
    // Every `issues` delivery carries the labels as they were when GitHub made
    // it, and one made between the bridge writing its stage and writing the
    // label still has the old one. The merge's own `issues.closed` arrived
    // with `adlc:review` (fleetadlc-testbed#1), and was taken for a person
    // moving the card back: work sent back to Review, and the builder's lease
    // let go of. An edit or another label is no move; a move whose delivery
    // never came is the reconciler's (`movedBack`).
    if (liveStage && !hasIgnoreLabel(labels)) {
      const known = await (async () => issues.getIssue(repo.id, issue.number))().catch(() => null);
      const stageOfLabel = label ? stageFromLabels([label]) : null;
      const movedTo = !stageOfLabel
        ? null
        : action === 'labeled'
          ? stageOfLabel
          : action === 'unlabeled' && known && stageOfLabel === known.stage
            ? liveStage
            : null;
      if (known && movedTo && isBackwardMove(known.stage, movedTo)) {
        const crew = await bots.listBots().catch(() => []);
        if (sender && isFleetLogin(crew, sender)) {
          await this.automation.moveStage({ repoName: repo.name, issueNumber: issue.number, to: known.stage, actor: 'bridge' });
          await audit({
            actor: sender,
            action: 'stage.backward_refused',
            target: `${repo.name}#${issue.number}`,
            payload: { from: known.stage, to: movedTo, why: 'a crew account moved the label back; a bot sends work back through the bridge' },
          }).catch(() => undefined);
          console.warn(`[bridge] ${repo.name}#${issue.number}: ${sender} moved it back from ${known.stage} to ${movedTo}; put back`);
          return;
        }
        await this.sendBack.fromPerson({
          repoName: repo.name,
          issueNumber: issue.number,
          to: movedTo,
          actor: sender ?? 'a person on GitHub',
          reason: `Moved back on GitHub${sender ? ` by @${sender}` : ''}, from ${known.stage}.`,
          moved: { from: known.stage },
        });
        await store({
          repoId: repo.id,
          number: issue.number,
          title: issue.title,
          stage: movedTo,
          labels,
          declaredPaths: declaredPathsFrom(issue.body ?? ''),
          body: issue.body ?? '',
          url: issue.htmlUrl,
          prNumber: null,
        });
        return;
      }
      // Any other delivery whose stage label is behind the board's has the
      // old label on it: the row keeps its stage, and nothing is staffed for
      // the stage it left. Stored as the snapshot's, the board went back to
      // that stage and its bot was staffed again.
      if (known && isBackwardMove(known.stage, liveStage)) {
        await store({
          repoId: repo.id,
          number: issue.number,
          title: issue.title,
          stage: known.stage,
          labels,
          declaredPaths: declaredPathsFrom(issue.body ?? ''),
          body: issue.body ?? '',
          url: issue.htmlUrl,
          prNumber: null,
        });
        return;
      }

      // Forward, by one of the crew's accounts. The bridge owns every stage
      // move: a bot's work ends and the bridge moves the card on. A label a
      // session set itself — through `gh api`, or intake's `gh issue edit` —
      // was stored as the stage, so `adlc:done` on a build unblocked the
      // issues that depend on it and a stacked pull request took it as merged.
      // It is put back, but for intake's own first move out of intake, which
      // goes where the repository's spec rule says (`stageAfterIntake`, the
      // same rule intake's end applies, `StageHandoff.afterIntake`): as soon
      // as the label comes in, so an issue is never left in a Design the rule
      // does not ask for, or out of one it does.
      // Any later column, not only the next one: build to done skips two.
      if (liveStage !== 'intake' && (!known || isBackwardMove(liveStage, known.stage))) {
        const crew = await bots.listBots().catch(() => []);
        if (sender && isFleetLogin(crew, sender)) {
          const row = (stage: StageKey) => ({
            repoId: repo.id,
            number: issue.number,
            title: issue.title,
            stage,
            labels,
            declaredPaths: declaredPathsFrom(issue.body ?? ''),
            body: issue.body ?? '',
            url: issue.htmlUrl,
            prNumber: null,
          });
          const fromIntake = !known || known.stage === 'intake';
          if (fromIntake && (liveStage === 'spec' || liveStage === 'build')) {
            const full = await repos.getRepoByName(repo.name).catch(() => null);
            const to = full
              ? stageAfterIntake({ labels, specRequiredLabels: full.specRequiredLabels ?? [], specMode: full.stageModes.spec ?? 'conditional' })
              : liveStage;
            if (to !== liveStage) {
              // From intake, where the bridge puts a new issue, so the move is forward.
              if (!known) await store(row('intake'));
              await this.automation.moveStage({ repoName: repo.name, issueNumber: issue.number, to, actor: 'bridge' });
              await audit({
                actor: sender,
                action: 'stage.intake_routed',
                target: `${repo.name}#${issue.number}`,
                payload: { chosen: liveStage, to, why: 'the repository’s spec rule decides where intake’s issue goes' },
              }).catch(() => undefined);
              await this.stages.staff({ repoName: repo.name, issueNumber: issue.number, stage: to });
              return;
            }
          } else {
            const back = known?.stage ?? 'intake';
            if (!known) await store(row('intake'));
            await this.automation.moveStage({ repoName: repo.name, issueNumber: issue.number, to: back, actor: 'bridge' });
            await audit({
              actor: sender,
              action: 'stage.forward_refused',
              target: `${repo.name}#${issue.number}`,
              payload: { from: back, to: liveStage, why: 'a crew account moved the label on; the bridge moves work on when its stage ends' },
            }).catch(() => undefined);
            console.warn(`[bridge] ${repo.name}#${issue.number}: ${sender} moved it on from ${back} to ${liveStage}; put back`);
            if (!known) await this.stages.staff({ repoName: repo.name, issueNumber: issue.number, stage: 'intake' });
            return;
          }
        }
      }
    }

    // `fleetadlc:ignore` is an issue the crew does not touch. The stage move
    // below writes `adlc:intake` onto one a person filed with no stage, and
    // staffing intake retitles it and adds `start:now`. A stage the sweep
    // does not staff is recorded so the routable query can see the label;
    // intake and spec are not inserted, because that is what the sweep then
    // starts. Taking the label off is what lets this run.
    if (hasIgnoreLabel(labels)) {
      if (liveStage && liveStage !== 'intake' && liveStage !== 'spec') {
        await store({
          repoId: repo.id,
          number: issue.number,
          title: issue.title,
          stage: liveStage,
          labels,
          declaredPaths: declaredPathsFrom(issue.body ?? ''),
          body: issue.body ?? '',
          url: issue.htmlUrl,
          prNumber: null,
        });
      } else {
        await issues.setIssueLabels(repo.id, issue.number, labels);
      }
      return;
    }

    const stage = liveStage ?? 'intake';

    await store({
      repoId: repo.id,
      number: issue.number,
      title: issue.title,
      stage,
      labels,
      declaredPaths: declaredPathsFrom(issue.body ?? ''),
      // The body itself, not only what was parsed out of it. The dispatcher
      // reads it back to decide whether an issue says enough to be worked on,
      // and an issue stored without one is missing every section it asks for —
      // so it is sent to triage, whatever it actually says.
      body: issue.body ?? '',
      url: issue.htmlUrl,
      prNumber: null,
    });

    // An issue filed by a person with no stage label is intake's to shape.
    // The labels checked above are the delivery's. An issue created and then
    // labelled `fleetadlc:ignore` in a second call arrives as `opened` with no
    // labels, and the move is where GitHub's labels are read. It refuses such
    // an issue and stores its labels, and intake is not staffed.
    if (action === 'opened' && !stageFromLabels(labels)) {
      const moved = await this.automation.moveStage({
        repoName: repo.name,
        issueNumber: issue.number,
        to: 'intake',
        actor: 'bridge',
      });
      if (moved?.ignored) return;
      await this.stages.staff({ repoName: repo.name, issueNumber: issue.number, stage: 'intake' });
      return;
    }

    // Whatever put the issue in a staffed stage, the bot that staffs it starts
    // here: a label applied by hand is as good a signal as one the platform set.
    await this.stages.staff({ repoName: repo.name, issueNumber: issue.number, stage });
  }

  /**
   * The title and body to keep for an issue, and the snapshot to take with it.
   *
   * A person with access acting on a stranger's issue — labelling it, most
   * often — is what lets the crew start on it, and vouches for its text as it
   * was then. The author can edit it at any time after, and a crew account's
   * next label change stored the edit, Expected paths and all. So the first
   * time somebody other than an unheard author is heard acting on the issue,
   * its text is kept (`setVouched`), from the stored row when there is one;
   * after that the kept text is what is stored. It moves on when a crew
   * account rewrites the issue (`edited`, signed by its seat), or when GitHub
   * says the text was last changed by someone with access other than the
   * author (`chooseIssueText`). A person labelling it again does not take the
   * author's edit with it: they accepted the issue, not what it says now.
   */
  private async vouchedText(
    repo: { id: string; name: string; fullName?: string },
    issue: { number: number; title: string; body: string | null },
    action: string | undefined,
    sender: string | null,
    author: { login: string | null; association: string | null; id?: number | null } | null,
  ): Promise<{ title: string; body: string | null; keep: { title: string; body: string; by: string } | null }> {
    const live = { title: issue.title, body: issue.body, keep: null };
    const known = await (async () => issues.getIssue(repo.id, issue.number))().catch(() => null);
    const crew = await bots.listBots().catch(() => []);
    const fromCrew = Boolean(sender && isFleetLogin(crew, sender));
    const fullName = repo.fullName ?? (await repos.getRepoByName(repo.name).catch(() => null))?.fullName ?? null;
    // The sender's account id is not passed down, so a sender is one of
    // `humans` only as GitHub's answer about the login says (`actsForOn`).
    const heard = async (login: string, association: string | null, id?: number | null): Promise<boolean> => {
      if (actsFor({ login, association }, crew)) return true;
      if (!fullName) return false;
      const people = await effectiveConfig(this.config).catch(() => null);
      const client = await asAutomation(this.automation['actors'], this.config).catch(() => null);
      return actsForOn({ client, repoFullName: fullName, author: { login, association: null, id: id ?? null }, crew, humans: people?.humans ?? [] });
    };

    const choose = (stored: { title: string; body: string }) =>
      chooseIssueText({
        stored,
        live: { title: issue.title, body: issue.body ?? '' },
        authorHeard: async () => Boolean(author?.login) && (await heard(author!.login!, author!.association, author!.id)),
        heard: (login) => heard(login, null),
        edits: async () => {
          const client = fullName ? await asAutomation(this.automation['actors'], this.config).catch(() => null) : null;
          if (!client || !fullName) throw new Error('no account to ask GitHub with');
          return client.issueEdits(fullName, issue.number);
        },
      });

    if (known?.vouched) {
      if (action === 'edited' && fromCrew) return { ...live, keep: { title: issue.title, body: issue.body ?? '', by: sender as string } };
      const choice = await choose(known.vouched);
      if (choice.refused) await editNotTaken(repo.name, issue.number, choice.editedAt, 'a delivery');
      if (!choice.changed) return { title: known.vouched.title, body: known.vouched.body, keep: null };
      return { title: choice.title, body: choice.body, keep: { title: choice.title, body: choice.body, by: choice.by ?? sender ?? 'github' } };
    }

    if (!author?.login || !sender || sameLogin(sender, author.login)) return live;
    if (await heard(author.login, author.association, author.id)) return live;
    // The row as the crew has been reading it, when there is one: the live
    // text may already be the author's edit, unless GitHub puts it to someone
    // with access.
    const choice = await choose(known ? { title: known.title, body: known.body } : { title: issue.title, body: issue.body ?? '' });
    if (choice.refused) await editNotTaken(repo.name, issue.number, choice.editedAt, 'a delivery');
    const text = { title: choice.title, body: choice.body };
    return { ...text, keep: { ...text, by: sender } };
  }

  /**
   * An edit by an author OpenADLC does not act for, to an issue whose text a
   * person vouched for: the crew does not read it, and the author is told so
   * once, rather than the edit being dropped with only a line in the log.
   * Nothing else moves: no stage, no label.
   */
  private async editNotRead(payload: WebhookPayload, author: string): Promise<void> {
    const number = payload.issue?.number;
    const repo = payload.repository ? await repos.getRepoByName(payload.repository.name).catch(() => null) : null;
    if (!repo || !number) return;
    const known = await issues.getIssue(repo.id, number).catch(() => null);
    if (!known?.vouched) return;
    const fields = { repo: repo.name, issue: String(number) };
    const told = await hasEventOfType(ISSUE_EDIT_NOT_READ, new Date(known.vouched.at), fields).catch(() => true);
    await recordEvent({ source: 'platform', type: ISSUE_EDIT_NOT_READ, payload: { ...fields, by: author } }).catch(() => undefined);
    if (told) return;
    await this.automation
      .comment(
        repo.fullName,
        number,
        `@${author}, this issue was edited after it was taken up. OpenADLC's crew reads it as it was then. It reads an edit once a person with access to the repository makes it: they can edit the issue to take yours.\n\n${dedupeMarker('edit-not-read', String(number))}`,
      )
      .catch(() => undefined);
  }

  /**
   * A stage label the reconciler found moved back on GitHub, with no delivery
   * that said so: taken as a person's move, as the delivery would have been.
   */
  async movedBack(repo: { id: string; name: string }, issueNumber: number, from: StageKey, to: StageKey): Promise<void> {
    await this.sendBack.fromPerson({
      repoName: repo.name,
      issueNumber,
      to,
      actor: 'a person on GitHub',
      reason: `Moved back on GitHub from ${from}; the reconciler found it, as no delivery said so.`,
      moved: { from },
    });
  }

  private async onIssue(payload: WebhookPayload): Promise<void> {
    const repoName = payload.repository?.name;
    const issue = payload.issue;
    if (!repoName || !issue || issue.pull_request) return;

    const repo = await repos.getRepoByName(repoName);
    if (!repo) return;

    await this.learnIssue(
      repo,
      {
        number: issue.number,
        title: issue.title,
        body: issue.body,
        htmlUrl: issue.html_url,
        labels: issue.labels.map((label) => label.name),
        ...(issue.state ? { state: issue.state } : {}),
      },
      payload.action,
      payload.sender?.login ?? null,
      { login: issue.user?.login ?? null, association: issue.author_association ?? null, id: issue.user?.id ?? null },
      payload.label?.name ?? null,
    );

    // The hold is over once its label comes off on GitHub or the issue closes:
    // the record of who held it and why goes too, or a later hold somebody
    // else puts on would be said as theirs.
    if ((payload.action === 'unlabeled' && payload.label?.name === PAUSED_LABEL) || payload.action === 'closed') {
      await forgetHold(`${repo.name}#${issue.number}`).catch(() => undefined);
    }

    // An issue intake filed for a console request files that request now,
    // rather than when the triage ends and GitHub's list may not have it yet.
    if (payload.action === 'opened' && this.requestFiling) {
      await this.requestFiling
        .issueOpened(
          { id: repo.id, fullName: repo.fullName },
          { number: issue.number, title: issue.title, body: issue.body, htmlUrl: issue.html_url },
        )
        .catch((error: unknown) =>
          console.warn(`[bridge] could not link ${repo.name}#${issue.number} to its request: ${error instanceof Error ? error.message : error}`),
        );
    }
  }

  /** A human reply to a gate comment is the answer; the task resumes on it. */
  private async onIssueComment(payload: WebhookPayload, signature: CommentSignature | null = null): Promise<void> {
    const comment = payload.comment;
    const issue = payload.issue;
    const repoName = payload.repository?.name;
    if (!comment || !issue || !repoName) return;

    // A comment written, not one changed or taken away. An edit to the answer a
    // person gave the last question arrived here as an answer too — to the next
    // question, which is open by then, since a bot asks one at a time and asks
    // the next once the last is answered. A deleted comment answered with the
    // words it no longer shows.
    if (payload.action !== 'created') return;

    const crew = await bots.listBots();
    const marker = parseMarker(comment.body);
    const authorIsBot = whoWrote(comment.user.login, crew, marker).kind === 'fleetadlc';

    // A design comment proposes what the repository should remember; only
    // one whose signature verifies to the issue's design task may, whatever
    // the attribution mode (`design-memory.ts`). Any crew comment did, and on
    // an issue past design a proposal is accepted at once: a console message
    // posted as the builder carried a marker that rewrote the accepted
    // decisions. A person's words are posted inert now (`inertMarkup`); the
    // seat tag is the poster's word on a shared account, so the design seat's
    // tag is asked first and the signature decides.
    const wrote = whoWrote(comment.user.login, crew, { bot: seatOf(comment.body) });
    const designSeat = wrote.kind === 'fleetadlc' && wrote.bot?.role === 'spec';
    if (designSeat) {
      await recordDesignMemory({ repoName, issueNumber: issue.number, body: comment.body, commentUrl: comment.html_url ?? null, signature }).catch(
        (error: unknown) => console.warn(`[bridge] ${repoName}#${issue.number}: design memory not recorded: ${error instanceof Error ? error.message : error}`),
      );
    }

    // A bot's own structured comment is not a gate answer — but it is the only
    // record of a step that leaves no GitHub trace of its own, and it used to be
    // dropped on the floor here. Record it, then stop.
    if (authorIsBot && marker) {
      // Except a question: that is the gate's own comment, coming back. The
      // gate put the question in the thread when it opened, so recording it
      // again showed the question twice, the second time as the whole comment.
      if (marker.event === 'question') return;
      await this.recordSkillEvent({ marker, comment, repoName: repoName, issueNumber: issue.number });
      return;
    }

    // Nothing else one of the crew writes is a person's answer either: it is a
    // bot's own words, an answer the bridge recorded and then posted back
    // ("janedoe answered: …"), or a message somebody wrote in the console that
    // the bridge posted for them. Taken as an answer, any of these would answer
    // a second bot's question on the same issue with it.
    if (authorIsBot) return;

    // Nor is another app's account a person, whatever the repository lets it
    // do. An app installed with write access can pass the access check, and a
    // dependency bot's routine comment would then answer a bot's question.
    if (isAppAccount(comment.user)) {
      await this.answerNotTaken(payload, comment.user.login, APP_ACCOUNT);
      return;
    }

    const repo = await repos.getRepoByName(repoName);
    if (!repo) return;

    const subjectRef = `${repo.name}#${issue.number}`;
    const openGates = await threads.listOpenGates();
    const relevant = await this.gateForSubject(openGates, subjectRef);
    if (!relevant) {
      await this.wakeBuild(payload, repo, subjectRef);
      return;
    }

    // Access to read the issue is not enough to answer it: a gate drives a bot
    // that writes to the repository. `author_association` cannot say how much
    // access — COLLABORATOR is a read-only collaborator too, and on a public
    // repository MEMBER is any member of the organization — so the permission
    // is asked of GitHub, whatever the label says.
    const may = await this.mayAnswerGates(payload.repository?.full_name ?? repo.fullName, comment.user.login, comment.user.id);
    if (may !== true) {
      await this.answerNotTaken(
        payload,
        comment.user.login,
        may === null
          ? 'OpenADLC could not ask GitHub what they may do on the repository; they can reply again, or answer in the console'
          : 'answering a gate takes triage or more on the repository, or a place in the install’s humans',
      );
      return;
    }

    // A comment is not a reason to start. `fleetadlc:ignore` means the crew leaves
    // the issue alone, and a reply here would otherwise resume the task that
    // was waiting on it. It is checked after the crew's own comments, which
    // still record what a task already running did, and after the access
    // check, so somebody who may not answer at all is told that instead. A
    // person whose answer is not taken is told so, where it was dropped
    // without a word.
    if (issue.labels?.some((label) => isIgnoreLabel(label.name))) {
      await this.answerNotTaken(payload, comment.user.login, IGNORED_ISSUE);
      return;
    }

    // A reply to an earlier question, delivered again after this one was
    // asked, is not an answer to this one; nor is a reply that already
    // answered a question. Either way it was GitHub redelivering, or a second
    // hook, and the old words were applied to whatever was open by then. The
    // minute allows for GitHub's clock and this database's disagreeing.
    const written = comment.created_at ? Date.parse(comment.created_at) : NaN;
    const asked = relevant.createdAt ? Date.parse(relevant.createdAt) : NaN;
    if (written < asked - 60_000) {
      console.log(`[bridge] ${subjectRef}: a reply written before the open question was asked is not its answer (${comment.html_url})`);
      return;
    }
    if (typeof comment.id === 'number' && !(await threads.claimGateReply(comment.id, relevant.id))) {
      console.log(`[bridge] ${subjectRef}: a reply that already answered a question is not taken again (${comment.html_url})`);
      return;
    }

    const { taskId } = await this.gates.answer({
      gateId: relevant.id,
      reply: ownWords(comment.body),
      // The login GitHub put in this delivery. `receive` runs only after the
      // signature check, which has no configuration that skips it, so this is
      // the person the verified delivery names — not a name from an unverified body.
      answeredBy: comment.user.login,
      // No console role: a GitHub identity has none, so a reply never lets a
      // continue at the cost cap past a spent monthly cap (`Gates.answer`).
      via: 'github',
    });

    // The answer is recorded by now. A resume that fails is hostd's problem to
    // report, as it is when the console answers; failing the delivery for it
    // would send GitHub a 500 for a gate that was answered.
    if (taskId) {
      await this.taskService.resume(taskId).catch((error: Error) => {
        console.warn(`[bridge] resume after answer failed: ${error.message}`);
      });
    }
  }

  /**
   * A person's comment on an issue whose build ended without opening its pull
   * request goes on from the build's branch, as Try again does.
   *
   * With no question open, a comment started nothing, and a `done` task has
   * none: found live, a person asked the builder to finish and open the pull
   * request, and no task started in the hour after. Its new session reads the
   * issue again, the comment with it. The same people who may answer a
   * question may do this, and `fleetadlc:ignore` stops it; anyone else's comment
   * is recorded and starts nothing, as before.
   */
  private async wakeBuild(payload: WebhookPayload, repo: { id: string; name: string; fullName: string }, subjectRef: string): Promise<void> {
    const issue = payload.issue;
    const comment = payload.comment;
    if (!this.continueBuild || !issue || !comment || issue.pull_request || issue.state === 'closed') return;
    const build = (await tasks.listTasksOnSubjects([subjectRef])).find((task) => task.kind === 'implement');
    if (!build?.branch || !continuesBranch(build)) return;
    if ((await issues.getIssue(repo.id, issue.number))?.prNumber) return;
    if ((await this.mayAnswerGates(payload.repository?.full_name ?? repo.fullName, comment.user.login, comment.user.id)) !== true) return;
    if (issue.labels?.some((label) => isIgnoreLabel(label.name))) return;
    // `retryTask` asks GitHub whether the branch has a pull request the issue
    // row does not know of, and refuses then; that refusal is only logged.
    await this.continueBuild(build.id, comment.user.login).catch((error: unknown) =>
      console.warn(`[bridge] ${subjectRef}: a comment did not continue its build: ${error instanceof Error ? error.message : error}`),
    );
  }

  /**
   * Whether a login may answer a gate from GitHub: one of the install's humans,
   * from the account the login was pinned to (`isPinnedHuman`), or somebody
   * GitHub says holds triage or more on the repository. An empty `humans` is
   * not "nobody": it leaves the repository's own roles to decide. A login in
   * `humans` that someone else registered after its account was renamed or
   * deleted has another id, and is asked about like anyone else. Null when
   * GitHub could not be asked, which refuses too.
   */
  private async mayAnswerGates(repoFullName: string, login: string, id: number | null | undefined): Promise<boolean | null> {
    const live = await effectiveConfig(this.config).catch(() => null);
    const humans = live?.humans ?? this.config.humans ?? [];
    if (await isPinnedHuman(humans, login, id)) return true;
    const client = await asAutomation(this.automation['actors'], this.config).catch(() => null);
    return repoAccess(client, repoFullName, login);
  }

  /**
   * Plan changes a person approved that were waiting on another change's paths,
   * tried again now that a pull request has closed or merged and let go of them.
   */
  private async resumeHeldPlanChanges(): Promise<void> {
    try {
      for (const taskId of await this.gates.applyHeld()) {
        await this.taskService.resume(taskId).catch((error: Error) => {
          console.warn(`[bridge] resume after a plan change failed: ${error.message}`);
        });
      }
    } catch (error) {
      console.warn(`[bridge] could not look at the plan changes waiting on paths: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * Writes a bot's structured comment into its thread, as the kind its event
   * means.
   *
   * The `fleetadlc:` events were declared, but only `question` was ever produced
   * or consumed, so the bridge learned what a bot did from GitHub's own webhooks
   * and learned nothing at all about a plan posted or a task that stopped on its
   * own terms. A comment with no marker never reaches here, so an operator's own
   * words keep their meaning.
   */
  private async recordSkillEvent(input: {
    marker: FleetMarker;
    comment: { body: string; user: { login: string }; html_url?: string };
    repoName: string;
    issueNumber: number;
  }): Promise<void> {
    // By the account that posted it, which is the bot's whatever it is called
    // now; the name in the marker is the one it had when it wrote the comment,
    // and a bot renamed since would otherwise lose the line from its thread.
    const crew = await bots.listBots().catch(() => []);
    const who = whoWrote(input.comment.user.login, crew, input.marker);
    const bot =
      (who.kind === 'fleetadlc' ? who.bot : null) ?? (await bots.getBotByName(input.marker.bot ?? '').catch(() => null));
    const repo = await repos.getRepoByName(input.repoName);
    if (!bot || !repo) return;

    const thread = await threads.ensureThread({
      botId: bot.id,
      repoId: repo.id,
      subjectRef: `${repo.name}#${input.issueNumber}`,
    });
    await threads.addMessage({
      threadId: thread.id,
      kind: messageKindFor(input.marker.event),
      author: bot.name,
      text: input.comment.body,
      note: headlineFor(input.marker.event),
      payload: { event: input.marker.event },
      githubUrl: input.comment.html_url ?? null,
    });
    await recordEvent({
      source: 'github',
      type: input.marker.event,
      payload: { bot: bot.name, subject: `${repo.name}#${input.issueNumber}` },
    });
  }

  private async gateForSubject(
    openGates: Awaited<ReturnType<typeof threads.listOpenGates>>,
    subjectRef: string,
  ): Promise<{ id: string; threadId: string | null; createdAt: string | null } | null> {
    // Two reads, however many gates are open: a stranger's comment on any issue
    // of a public repository comes through here, and must not cost a read per gate.
    if (!openGates.some((gate) => gate.taskId)) return null;
    const onSubject = new Set((await tasks.listTasksOnSubjects([subjectRef])).map((task) => task.id));
    const gate = openGates.find((candidate) => candidate.taskId && onSubject.has(candidate.taskId));
    return gate ? { id: gate.id, threadId: gate.threadId ?? null, createdAt: gate.createdAt ?? null } : null;
  }

  /**
   * A crew account merging a pull request the review gate had not passed.
   *
   * GitHub stops that only where a ruleset requires the review, and a private
   * repository on a free plan has none: the first cloud install's builder
   * merged its own pull request with no review at all. OpenADLC's `gh` now
   * refuses to, but a session holds a token that can do it anyway, so the
   * merge itself is watched for: audited, and put in front of a person.
   *
   * The gate is the one OpenADLC published (`publishedGate`). The combined
   * status shows the newest `review-gate` whoever set it, and a crew token
   * that may write statuses set its own green one just before merging, so
   * the alarm never fired. Anything but green, unreadable included, alarms.
   *
   * True when it flagged the merge. The caller then holds its testing deploy:
   * flagging it and deploying it anyway shipped the unreviewed commit to
   * testing on its own. A gate that cannot be read counts as not passed. The
   * merge line merges as the app, never as a crew account, so a crew merger
   * is already wrong, and holding is the safe side.
   *
   * `once` is the reconciler's: it comes back to a held merge every fifteen
   * minutes, and the hold stands until a person moves the card, so a merge
   * already audited as unreviewed is held without a second comment.
   */
  private async noticeUnreviewedMerge(
    repoFullName: string,
    pr: { number: number; merged_by?: { login: string } | null; head: { sha: string } },
    { once = false }: { once?: boolean } = {},
  ): Promise<boolean> {
    const merger = pr.merged_by?.login;
    const crew = await bots.listBots().catch(() => []);
    if (!merger || !isFleetLogin(crew, merger)) return false;
    const client = await asAutomation(this.automation['actors'], this.config).catch(() => null);
    const gate = await (async () => this.automation.publishedGate(repoFullName, pr.head.sha))().catch(() => null);
    if (gate === 'success') return false;
    if (once && (await lastAudit('merge.unreviewed', `${repoFullName}#${pr.number}`).catch(() => null))) return true;
    await audit({
      actor: merger,
      action: 'merge.unreviewed',
      target: `${repoFullName}#${pr.number}`,
      payload: { reviewGate: gate, sha: pr.head.sha },
    }).catch(() => undefined);
    console.warn(`[bridge] ${merger} merged ${repoFullName}#${pr.number} with review-gate ${gate ?? 'never set'}`);
    await client
      ?.comment(
        repoFullName,
        pr.number,
        `**This was merged without its reviews, and its testing deploy is held.** ${merger} is one of the crew's ` +
          `accounts, and \`review-gate\` was ${gate ?? 'never set'} when it landed. Nothing on GitHub stops that here — ` +
          `the repository's plan holds no rules on this branch. The commit is on the default branch already, and the next ` +
          `reviewed merge's deploy would carry it, so look at what landed and revert it if it should not have landed. ` +
          `If it is fine, move its issue to Merged on the board to let it deploy.`,
      )
      .catch(() => undefined);
    await client?.addLabels(repoFullName, pr.number, ['needs-human']).catch(() => undefined);
    return true;
  }

  private conflicts: Pick<ConflictRounds, 'pushed' | 'resolving'> | null = null;
  private stacks: Pick<Stacking, 'pushed'> | null = null;

  /** Tells a stacked pull request's update onto the base from any other push; set once at start-up (main.ts). */
  useStacking(stacks: Pick<Stacking, 'pushed'>): void {
    this.stacks = stacks;
  }

  /** Tells a push that resolves a merge-line conflict from any other; set once at start-up (main.ts). */
  useConflictRounds(rounds: Pick<ConflictRounds, 'pushed' | 'resolving'>): void {
    this.conflicts = rounds;
  }

  private stopTask: ((taskId: string, actor: string, note: string) => Promise<unknown>) | null = null;

  /** Counts each completed workflow run's minutes (`ci-usage.ts`); set once the counter exists (`main.ts`). */
  private ciUsage: ((delivery: WebhookPayload) => Promise<string | null>) | null = null;

  useCiUsage(record: (delivery: WebhookPayload) => Promise<string | null>): void {
    this.ciUsage = record;
  }

  /** How a task is stopped, as a card's Stop does it; set once at start-up (main.ts). */
  useStopTask(stop: (taskId: string, actor: string, note: string) => Promise<unknown>): void {
    this.stopTask = stop;
  }

  /**
   * The reviews still going on a pull request that has closed. A second
   * review of a pull request the merge line had just merged ran on for
   * minutes, spending, to post on something already in main.
   */
  /** An issue closed with its build unfinished: its implement tasks stop, as resume and retry refuse them. */
  private async stopBuildsOf(repoName: string, issueNumber: number): Promise<void> {
    if (!this.stopTask) return;
    const subjectRef = `${repoName}#${issueNumber}`;
    const going = (await tasks.listTasksForSubjects('implement', [subjectRef]).catch(() => [])).filter((task) =>
      ['queued', 'running', 'paused'].includes(task.state),
    );
    for (const task of going) {
      await this.stopTask(task.id, 'bridge', alreadyLanded(subjectRef)).catch((error: unknown) =>
        console.warn(`[bridge] build ${task.id} on ${subjectRef} not stopped: ${error instanceof Error ? error.message : error}`),
      );
    }
  }

  private async stopReviewsOf(repoName: string, prNumber: number, why: string): Promise<void> {
    if (!this.stopTask) return;
    const going = (await tasks.listTasksForSubjects('review', [`${repoName}#${prNumber}`]).catch(() => [])).filter((task) =>
      ['queued', 'running', 'paused'].includes(task.state),
    );
    for (const task of going) {
      await this.stopTask(task.id, 'bridge', why).catch((error: unknown) =>
        console.warn(`[bridge] review ${task.id} on ${repoName}#${prNumber} not stopped: ${error instanceof Error ? error.message : error}`),
      );
    }
  }

  private async onPullRequest(payload: WebhookPayload): Promise<void> {
    const pr = payload.pull_request;
    const repoName = payload.repository?.name;
    const repoFullName = payload.repository?.full_name;
    if (!pr || !repoName || !repoFullName) return;

    const repo = await repos.getRepoByName(repoName);
    if (!repo) return;

    // A pull request from a fork is never an issue's, whatever its branch is
    // called, and gets no crew reviewers: people review it. A stranger's fork
    // on `agent/builder/42-x` took #42's lease, moved it to Review and had
    // reviewers read the stranger's text.
    const fork = fromFork(pr, repoFullName);

    // Which pull request the issue's change is in, from the moment it opens —
    // a draft too. Nothing wrote it: the board could not tie a pull request's
    // reviews to its card, the dispatcher never saw an open pull request's
    // files, and the gate sweep found no pull request to settle.
    const forIssue = fork ? null : ownIssueOf(pr, repoFullName);
    if (forIssue && payload.action !== 'closed') {
      await issues.setPullRequestNumber(repo.id, forIssue, pr.number).catch(() => undefined);
      // And the lease that holds the issue's files, which is released by it:
      // with none recorded, nothing ever released a lease at a merge.
      const lease = await leases.getActiveLease(repo.id, forIssue).catch(() => null);
      if (lease && lease.prNumber !== pr.number) {
        await leases.setLeaseState(lease.id, lease.state, { prNumber: pr.number }).catch(() => undefined);
      }
      // Closing it released the lease; reopened, nothing took it back, and
      // the next request for changes found none and opened no patch round.
      if (!lease && payload.action === 'reopened') {
        const retaken = await retakeLease({ repo, issueNumber: forIssue, prNumber: pr.number, crew: await bots.listBots().catch(() => []), reason: `#${pr.number} was reopened` });
        if (retaken.why) console.log(`[bridge] ${repoFullName}#${pr.number} was reopened, and its lease was not taken again: ${retaken.why}`);
      }
    }

    if (payload.action === 'labeled' && payload.label?.name === CI_LABEL) {
      await this.guardCiLabel(repo, repoFullName, pr.number, payload.sender ?? null);
      return;
    }
    if (payload.action === 'labeled' && payload.label?.name === CROSS_CUTTING_LABEL) {
      await this.guardScopeLabel(repo, repoFullName, pr.number, payload.sender ?? null);
      return;
    }
    if (payload.action === 'labeled' && (payload.label?.name === 'revert' || payload.label?.name === 'deps')) {
      await this.guardFastPathLabel(repo, repoFullName, { number: pr.number, headRef: pr.head.ref }, payload.label.name, payload.sender ?? null);
      return;
    }

    if (payload.action === 'closed') {
      // Merged or abandoned, it no longer holds a place, and whatever is behind
      // it is now at the front.
      await this.mergeLine.leave(repo.name, pr.number);
      await this.mergeLine.advance(repo.name).catch(() => null);
      await this.stopReviewsOf(repo.name, pr.number, pr.merged ? 'its pull request merged' : 'its pull request closed');

      // A lease outlived its implement task to hold the ground this change sits
      // on. Closed unmerged, that ground is free again; merged, the verification
      // after it is what releases instead.
      // A fork's pull request holds no lease, so closing one releases none.
      if (!pr.merged && !fork) {
        const released = await leases.releaseForPullRequest(repo.id, pr.number, 'the pull request closed unmerged');
        if (released) console.log(`[bridge] released the lease on #${released.issueNumber}: #${pr.number} closed unmerged`);
        // The issue's lease was waiting on this pull request even when the
        // link to it was never written — the write above is best-effort — and
        // `releaseForPullRequest` finds a lease only by that link. Left held,
        // and paused on a question when its task ends, it would be settled
        // onto the issue's number, which still names this closed pull request
        // while the issue sits in review, and nothing would let it go.
        //
        // Only the lease that settle would tie to this pull request: paused,
        // with no link of its own, on an issue still in review that names this
        // pull request. Any other lease on the issue is a later round's — a
        // redelivered close, or a person closing an old pull request after the
        // issue went back to build — and releasing it would take that round's
        // paths out from under it.
        if (!released && forIssue) {
          const unlinked = await leases.getActiveLease(repo.id, forIssue).catch(() => null);
          const issue = unlinked ? await issues.getIssue(repo.id, forIssue).catch(() => null) : null;
          if (
            unlinked &&
            unlinked.state === 'paused' &&
            unlinked.prNumber === null &&
            issue?.stage === 'review' &&
            issue.prNumber === pr.number
          ) {
            await leases.setLeaseState(unlinked.id, 'released').catch(() => undefined);
            await audit({
              actor: 'bridge',
              action: 'lease.released',
              target: `${repo.name}#${forIssue}`,
              payload: { leaseId: unlinked.id, reason: `#${pr.number}, which it was waiting on, closed unmerged` },
            }).catch(() => undefined);
            console.log(`[bridge] released the lease on #${forIssue}: #${pr.number} closed unmerged, and the lease had no link to it`);
          }
        }
        await this.resumeHeldPlanChanges();
      }
    }

    if (payload.action === 'closed' && pr.merged) {
      const unreviewed = await this.noticeUnreviewedMerge(repoFullName, pr);
      await this.noticeConfigurationMerged(repo, repoFullName, pr);
      // Only a merge into the default branch ships anything. A merge into
      // release/1.x moved its issue to Merged, let go of its lease and
      // dispatched a testing deploy of a commit not on the default branch,
      // which the deploy refused, filing a P1 'The testing deploy failed' for
      // nothing. A merge whose base is missing is ignored as well.
      if (pr.base?.ref !== repo.defaultBranch) {
        console.log(
          `[bridge] ${repoFullName}#${pr.number} merged into ${pr.base?.ref ?? 'an unknown branch'}, not ${repo.defaultBranch}; its issue, lease and testing deploy are left alone`,
        );
        return;
      }
      if (unreviewed) {
        // Nothing moves and nothing deploys until a person has looked. Moving
        // the card to Merged is the release: the deploy sweep dispatches
        // testing for an issue in that stage. Leases stay as they are; the
        // person's move, or a revert, decides.
        console.warn(`[bridge] ${repoFullName}#${pr.number}: testing deploy held; a crew account merged it without review-gate passing`);
        return;
      }
      const { byMerging } = await this.finishMerge(repo, repoFullName, pr, fork);
      if (byMerging) {
        console.log(`[bridge] ${repoFullName}#${pr.number} merged; no testing deploy for this repository, so merging shipped it`);
        return;
      }
      // The testing deploy, by the repository's rules, dispatched as the app:
      // no bot's task stands between a merge and testing any more. The deploy
      // sweep is the backstop for a delivery that never came.
      if (this.pipeline) {
        const line = await this.pipeline
          .onMerged(repo, pr.number, pr.merge_commit_sha ?? null)
          .catch((error: unknown) => `${repo.name}#${pr.number}: the testing deploy was not dispatched: ${error instanceof Error ? error.message : error}`);
        console.log(`[bridge] ${line}`);
        return;
      }
      // Wired without the pipeline: the deploy bot's task, as before it.
      const deploy = (await bots.listBots()).find((bot) => bot.role === 'deploy');
      if (deploy) {
        await this.taskService
          .open({
            bot: deploy.name,
            repo: repo.name,
            kind: 'deploy',
            subjectType: 'merge',
            subjectRef: `${repo.name}#${pr.number}`,
            skill: 'deploy',
          })
          .catch((error) => console.warn(`[bridge] deploy task not started: ${error.message}`));
      }
      return;
    }

    // Reopened is as good as opened: closing stopped its reviews, and
    // `openMissingReviews` asks no seat that already had one, stopped or not.
    const readyForReview =
      payload.action === 'ready_for_review' ||
      ((payload.action === 'opened' || payload.action === 'reopened') && !pr.draft) ||
      payload.action === 'synchronize';

    if (!readyForReview || fork) return;

    // A push is not on its own a reason to review again. GitHub's "dismiss stale
    // reviews on push" is off by design, because the merge line merges the base
    // into a branch before landing it — which moves the head and changes nothing
    // about the work. So the question is whether the *diff against the base*
    // moved, and only that dismisses an approval and asks for another round.
    // A conflict resolution the lead re-checks alone, when this push is one.
    let resolution: { before: string; files: string[]; at: string } | null = null;
    if (payload.action === 'synchronize') {
      const before = String((payload as { before?: unknown }).before ?? '');
      const client = await asAutomation(this.automation['actors'], this.config);
      const base = pr.base?.ref ?? repo.defaultBranch ?? 'main';

      const wasProposing = before && client ? await client.diffFingerprint(repoFullName, base, before) : null;
      const isProposing = client ? await client.diffFingerprint(repoFullName, base, pr.head.sha) : null;
      const changed = contentChanged(wasProposing, isProposing);
      // A push while a conflict resolution round is open goes to the round
      // even when the diff fingerprints the same, so the lead re-checks every
      // resolution rather than letting the approvals stand on it.
      const resolving = this.conflicts ? await this.conflicts.resolving(repo.name, pr.number).catch(() => false) : false;
      // What the pull request changes now, read once for the two pushes below.
      const prFiles =
        (changed || resolving) && client && (this.conflicts || this.stacks) ? await client.listPullFilesAsNamed(repoFullName, pr.number).catch(() => null) : null;
      // A push that resolves a conflict the merge line found is the round's to
      // classify, and it is asked before the stacking rule: a stacked pull
      // request whose update conflicted is resolved from the very head the
      // line noted, and that push gets the round's re-review, never the line's
      // kept approvals. In files many changes add to, the other seats'
      // approvals stand and the lead re-checks only the resolution, below
      // (`conflict-round.ts`); the merge waits for the lead's approval of it.
      const round =
        (changed || resolving) && this.conflicts && prFiles
          ? await this.conflicts
              .pushed({ repoName: repo.name, repoFullName, prNumber: pr.number, before, after: pr.head.sha, baseRef: base, prFiles })
              .catch(() => null)
          : null;
      if (round?.review === 'lead-only') resolution = { before, files: round.files, at: round.at };
      // With no round open: the merge commit the line made to bring a stacked
      // pull request up to date once what it was built on merged, matched by
      // its SHA. Its diff lost only that work, which was reviewed and landed
      // (`stacking.ts`).
      const stackUpdate =
        changed && !round && prFiles && this.stacks
          ? await this.stacks.pushed({ repoName: repo.name, prNumber: pr.number, before, after: pr.head.sha, prFiles }).catch(() => false)
          : false;

      if ((!changed && !resolving) || stackUpdate) {
        // The approvals stand and no reviewer is asked again. The gate is still
        // refreshed, because it is a status on the new head and the old one's
        // does not carry over.
        const standing = await this.automation.reviewGateFor(repoFullName, { ...pr, baseRef: base });
        await this.automation.setReviewGate({
          repoFullName,
          prNumber: pr.number,
          sha: pr.head.sha,
          state: standing.state,
          description: await this.taskService.gateDescription(standing.description, repo.name),
        });
        console.log(
          stackUpdate
            ? `[bridge] ${repoFullName}#${pr.number}: brought up to date once what it was built on merged; approvals stand`
            : `[bridge] ${repoFullName}#${pr.number}: the head moved but the diff against ${base} did not; approvals stand`,
        );
        return;
      }

      if (!resolution) {
        const dismissed = await this.automation.dismissStaleApprovals({
          repoFullName,
          prNumber: pr.number,
          reason: 'superseded by new commits',
        });
        if (dismissed.length > 0) {
          console.log(`[bridge] ${repoFullName}#${pr.number}: dismissed ${dismissed.join(', ')} — the diff changed`);
        }
      }

      // A reviewer or the automation account changed the diff. The commits can
      // name the builder as their author, since whoever commits types that; the
      // pusher is GitHub's to say. Recorded, so the gate fails on this head
      // whenever it is set again (`checkAuthors`), not only now. A push that
      // left the diff alone is the merge line's update and never reaches here.
      const pusher = payload.sender?.login ?? null;
      const barred = changed && pusher ? accountsThatNeverAuthor(await bots.listBots()).find((account) => sameLogin(account.login, pusher)) : undefined;
      if (barred) {
        const push = { repo: repoFullName.toLowerCase(), pr: String(pr.number), sha: pr.head.sha, login: barred.login, why: barred.why };
        await recordEvent({ source: 'platform', type: FORBIDDEN_PUSH, payload: push }).catch((error: unknown) =>
          console.warn(`[bridge] ${repoFullName}#${pr.number}: forbidden push not recorded: ${error instanceof Error ? error.message : error}`),
        );
        await this.automation.setReviewGate({ repoFullName, prNumber: pr.number, sha: pr.head.sha, state: 'failure', description: forbiddenPushGate(push) });
        await audit({ actor: barred.login, action: FORBIDDEN_PUSH, target: `${repo.name}#${pr.number}`, payload: { sha: pr.head.sha, login: barred.login, why: barred.why } }).catch(
          () => undefined,
        );
        console.warn(`[bridge] ${repoFullName}#${pr.number}: ${barred.login} pushed ${pr.head.sha.slice(0, 7)}, which changed the diff — ${barred.why}`);
        return;
      }
    }

    // The builder's checks on this exact head are what the reviewers review on
    // top of: GitHub's CI runs only after the lead approves. OpenADLC's `gh` and
    // `git` refuse to open or push without a recorded pass, but a session holds
    // a token that can do either without them, so a crew account's change with
    // no pass on its head is not reviewed: the gate says why, and the work goes
    // back to build to run `fleetadlc-ci`. A person's push is theirs; a merge
    // line update changes no diff and never reaches here.
    const crewSender = payload.sender?.login ? isFleetLogin(await bots.listBots().catch(() => []), payload.sender.login) : false;
    if (crewSender && forIssue) {
      const pass = await (async () => localCiRuns.passFor(repo.id, pr.head.sha))().catch(() => undefined);
      if (pass === null) {
        const short = pr.head.sha.slice(0, 7);
        await this.automation.setReviewGate({
          repoFullName,
          prNumber: pr.number,
          sha: pr.head.sha,
          state: 'pending',
          description: `no local CI pass for ${short}: the builder runs fleetadlc-ci on it and pushes again`,
        });
        await audit({ actor: payload.sender?.login ?? 'a crew account', action: 'local_ci.missing', target: `${repo.name}#${pr.number}`, payload: { sha: pr.head.sha } }).catch(() => undefined);
        const client = await asAutomation(this.automation['actors'], this.config);
        await this.patchRound(repo, repoFullName, pr, await bots.listBots(), client, {
          by: 'fleetadlc',
          reason: `No local CI pass is recorded for ${short}, the head of #${pr.number}: run fleetadlc-ci on it, then push again. Nothing reviews it until then.`,
        });
        return;
      }
    }

    // A build already running when a person labelled its issue `fleetadlc:ignore`
    // finishes and opens its pull request; that is the task ending, not the
    // crew being let back in, so the issue stays where it is. The pull
    // request is still reviewed like any other: it is there, and a person can
    // merge it. Neither it nor the issue is on the board, and the merge does
    // not move the issue either: `moveStage` refuses an ignored issue, reading
    // the labels GitHub has, so a label whose delivery has not been processed
    // yet holds as well. This check of the stored labels only saves the read.
    const issueNumber = forIssue;
    const ignored = issueNumber ? hasIgnoreLabel((await issues.getIssue(repo.id, issueNumber))?.labels) : false;
    if (issueNumber && !ignored) {
      await this.automation.moveStage({
        repoName: repo.name,
        issueNumber,
        to: 'review',
        actor: 'bridge',
      });
    }

    const labels = pr.labels.map((label) => label.name);
    const client = await asAutomation(this.automation['actors'], this.config);
    // A list that could not be read, or stopped at GitHub's 3000, holds the
    // gate below and leaves the review requests as they are. What it did list
    // is still recorded and used.
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

    // Recorded here because this is where GitHub is already being asked. The
    // dispatcher checks a new issue against these, so a second change to the
    // same file is not leased while this one is still in review.
    const ownIssue = forIssue;
    if (ownIssue && changedFiles.length > 0) {
      await issues.setPullRequestPaths(repo.id, ownIssue, changedFiles).catch(() => undefined);
    }

    if (resolution) {
      const crewNow = await bots.listBots();
      const leadSeat = this.automation.decideReviewers(
        { labels, changedFiles, isRevert: false, humanReviewPaths: [], sample: reviewSample(repoFullName, pr.number) },
        crewNow,
      ).lead;
      await this.automation.setReviewGate({
        repoFullName,
        prNumber: pr.number,
        sha: pr.head.sha,
        state: 'pending',
        description: 'the lead re-checks the conflict resolution; the other approvals stand',
      });
      await this.taskService.openLeadReview({
        repo,
        prNumber: pr.number,
        branch: pr.head.ref,
        issueNumber: ownIssue,
        seat: leadSeat,
        // From the resolution: a lead review of the pull request from before
        // it is not this re-check, and with no time given it was taken for
        // one, so nothing opened and the resolution went unreviewed.
        since: resolution.at,
        extraContext: [resolutionCheckBrief({ before: resolution.before, after: pr.head.sha, files: resolution.files })],
      });
      return;
    }

    // The files that decide how CI runs in part, as the merge reads them: the
    // security reviewer is asked for the ones whose CI part changed.
    const ciKeys = client
      ? await ciKeysChanged(changedFiles, (path, ref) => client.readFileIfPresent(repoFullName, path, ref), {
          base: pr.base?.ref ?? repo.defaultBranch ?? 'main',
          head: pr.head.sha,
        })
      : undefined;
    const decision = this.automation.decideReviewers(
      {
        labels,
        changedFiles,
        isRevert: fastPathOf(labels, pr.head.ref),
        // The repository's own AGENTS.md decides this now, and is read below.
        // Leaving the old list in play would let a stale config contradict it.
        humanReviewPaths: [],
        sample: reviewSample(repoFullName, pr.number),
        ciKeysChanged: ciKeys,
      },
      // The rules name seats; the tasks and requests below need who is in them.
      await bots.listBots(),
    );

    await this.automation.requestReviewers(repoFullName, pr.number, decision.reviewers);

    // Who has to approve comes from the repository's own `AGENTS.md`, read from
    // the base branch — never from the pull request's copy, or a pull request
    // could edit its way out of the review it is subject to. A change to that
    // section itself needs everyone it names.
    const baseRef = pr.base?.ref ?? repo.defaultBranch ?? 'main';
    const { rules, required: humansRequired } = await this.automation.humansRequiredFor(repoFullName, baseRef, pr.head.sha, changedFiles);

    // Not knowing every file is not knowing who is needed: worked out from part
    // of the list, the labels came off and the requests of the people named
    // for the rest were withdrawn. Both are left as they are until it reads.
    if (!filesUnknown) {
      // A label that cannot be put on — no app key to make it, GitHub refusing —
      // is said and the rest goes on. It used to end the handling here, before
      // the requests below were withdrawn, and a person CODEOWNERS named stayed
      // requested on every such pull request, which the merge line waits on.
      await this.automation.setHumanReviewLabels(repoFullName, pr.number, humansRequired).catch((error: unknown) => {
        console.warn(`[bridge] ${repoFullName}#${pr.number}: could not label who must review: ${error instanceof Error ? error.message : error}`);
      });
      // CODEOWNERS makes GitHub request the owner on every pull request, which put
      // a person on all of them instead of the ones that need them. Anyone this
      // change does not actually need is withdrawn.
      await this.automation.dropUnneededHumanRequests(repoFullName, pr.number, humansRequired);
    }

    const gate = this.automation.computeReviewGate({
      draft: pr.draft,
      requestedReviewers: decision.reviewers,
      postedReviewers: [],
      lead: decision.lead,
      approvers: decision.approvers,
      humansRequired,
      // Nothing is approved at the moment a pull request opens.
      humansApproved: [],
      humanRulesUnknown: rules === null,
      filesUnknown,
      // Whoever GitHub just refused to ask, and anyone named who is known not
      // to exist or not to be able to review here: the gate says so, rather
      // than "waiting on" them.
      cannotReview: await this.automation.cannotReviewHere(repoFullName, { seats: decision.reviewers, humans: humansRequired }),
    });
    await this.automation.setReviewGate({
      repoFullName,
      prNumber: pr.number,
      sha: pr.head.sha,
      state: gate.state,
      description: await this.taskService.gateDescription(gate.description, repo.name),
    });

    // Every seat but the lead reviews now; the lead reviews last, once they
    // have all posted (`onReview`). A revert that no other seat's trigger
    // asks for has only the lead, which is asked at once.
    const first = decision.reviewers.filter((reviewer) => reviewer !== decision.lead);
    // When this round began, before any seat is asked: a seat busy now is
    // started by the gate sweep, which counts only reviews opened since.
    await recordEvent({ source: 'platform', type: REVIEW_ROUND_OPENED, payload: { subjectRef: `${repo.name}#${pr.number}`, sha: pr.head.sha } }).catch(
      () => undefined,
    );
    for (const reviewer of first.length > 0 ? first : [decision.lead]) {
      await this.taskService
        .open({
          bot: reviewer,
          repo: repo.name,
          kind: 'review',
          subjectType: 'pr',
          subjectRef: `${repo.name}#${pr.number}`,
          skill: 'pr-review',
          branch: pr.head.ref,
          // A reviewer reads the issue too: the acceptance criteria are what the
          // change has to be reviewed against.
          issueNumber,
          checkoutExistingBranch: true,
        })
        .catch((error) => console.warn(`[bridge] review task for ${reviewer} not started: ${error.message}`));
    }
  }

  /**
   * `adlc:ci` put on by somebody without the say is taken off again.
   *
   * The label lets GitHub's CI run on a crew pull request, and CI is paid for:
   * it is put on by the merge line once the lead has approved and the pull
   * request is at the front (`askedForCi`), or by a person who can write to the
   * repository. A crew account putting it on — a session around OpenADLC's
   * `gh`, a reviewer — is undone and audited, and so is anyone else.
   */
  private async guardCiLabel(
    repo: { name: string },
    repoFullName: string,
    prNumber: number,
    sender: { login: string; type?: string } | null,
  ): Promise<void> {
    const login = sender?.login ?? null;
    if (askedForCi(repoFullName, prNumber) && login && (isAppAccount(sender ?? undefined) || sameLogin(login, await this.automationLogin()))) return;
    const crew = await bots.listBots().catch(() => []);
    const client = await asAutomation(this.automation['actors'], this.config).catch(() => null);
    if (login && !isAppAccount(sender ?? undefined) && !isFleetLogin(crew, login)) {
      // Asked as the app first: a triage automation account is refused the
      // answer, and a maintainer's label was taken off as unknown.
      const permission = await permissionOn(client, repoFullName, login);
      if (['admin', 'maintain', 'write'].includes(permission)) return;
    }
    await this.automation.setCiLabel(repoFullName, prNumber, false).catch((error: unknown) =>
      console.warn(`[bridge] ${repoFullName}#${prNumber}: ${CI_LABEL} put on by ${login ?? 'nobody named'} could not be taken off: ${error instanceof Error ? error.message : error}`),
    );
    await audit({
      actor: login ?? 'unknown',
      action: 'ci.label_refused',
      target: `${repo.name}#${prNumber}`,
      payload: { label: CI_LABEL, why: 'only the merge line, after the lead approved, or a person who can write puts it on' },
    }).catch(() => undefined);
  }

  /**
   * `scope:cross-cutting` put on by a crew account is taken off again.
   *
   * The label waives the scope check, and any crew account could add it,
   * the builder whose work the check bounds included. It counts from the app,
   * the automation account or a person (`scopeLabelAcceptedFrom`). Where the
   * automation account is also a working seat's — one account shared by the
   * crew — its add counts only when the bridge made it, for the lead's signed
   * approval (`acceptScopeFromLead`): a session on that account looks the same.
   */
  private async guardScopeLabel(
    repo: { name: string },
    repoFullName: string,
    prNumber: number,
    sender: { login: string; type?: string } | null,
  ): Promise<void> {
    const login = sender?.login ?? null;
    const viaApp = isAppAccount(sender ?? undefined);
    const crew = await bots.listBots().catch(() => []);
    const automationLogin = await this.automationLogin();
    const sharedWithSeat = crew.some((bot) => bot.role !== 'automation' && sameLogin(bot.githubLogin, automationLogin));
    const bridgeAsked = scopeAccepted.delete(`${repoFullName.toLowerCase()}#${prNumber}`);
    const accepted =
      scopeLabelAcceptedFrom({ login, viaApp }, { crew, automationLogin }) &&
      (viaApp || !sameLogin(login, automationLogin) || !sharedWithSeat || bridgeAsked);
    if (accepted) return;
    await this.automation.setPullLabel(repoFullName, prNumber, CROSS_CUTTING_LABEL, false).catch((error: unknown) =>
      console.warn(`[bridge] ${repoFullName}#${prNumber}: ${CROSS_CUTTING_LABEL} put on by ${login ?? 'nobody named'} could not be taken off: ${error instanceof Error ? error.message : error}`),
    );
    await audit({
      actor: login ?? 'unknown',
      action: 'scope.label_refused',
      target: `${repo.name}#${prNumber}`,
      payload: { label: CROSS_CUTTING_LABEL, why: 'a crew account may not waive the scope check' },
    }).catch(() => undefined);
    await this.automation
      .comment(
        repoFullName,
        prNumber,
        `${login ? `@${login}` : 'A crew account'} put \`${CROSS_CUTTING_LABEL}\` on, and OpenADLC took it off: a crew account may not waive the scope check on work it bounds. ` +
          'Ask for the paths you need with a `plan_change` marker, and a person approves them; or the lead accepts a genuine widening in its approval.',
      )
      .catch(() => undefined);
  }

  /**
   * The lead's approval of the head that accepts a widening of scope (its
   * `review_posted` marker says `"scope":"cross-cutting"`) puts
   * `scope:cross-cutting` on, as the app. Only once the review's signature
   * checks: on a shared account any seat could write a lead-tagged body, so
   * without a signature check nothing is added and a person decides.
   */
  private async acceptScopeFromLead(
    repo: { name: string },
    repoFullName: string,
    pr: { number: number; head: { sha: string }; labels: { name: string }[] },
    review: NonNullable<WebhookPayload['review']>,
    crew: Awaited<ReturnType<typeof bots.listBots>>,
    lead: string | null,
  ): Promise<void> {
    if (review.state.toLowerCase() !== 'approved' || !acceptsCrossCutting(review.body)) return;
    if (review.id === undefined || (review.commit_id && review.commit_id !== pr.head.sha)) return;
    if (pr.labels.some((label) => label.name === CROSS_CUTTING_LABEL)) return;
    const author = whoWrote(review.user.login, crew, { bot: seatOf(review.body ?? '') });
    if (author.kind !== 'fleetadlc' || !lead || author.bot?.name !== lead) return;
    const target = `${repoFullName}#${pr.number}`;
    const attribution = this.automation['actors'].attribution;
    const signed = attribution
      ? await attribution.reviewsThatCount(repoFullName, pr.number, [{ id: review.id, user: review.user.login, body: review.body ?? null }], crew).catch(() => [])
      : [];
    if (signed.length === 0) {
      console.log(`[bridge] ${target}: the lead accepted a widening of scope, but its signature ${attribution ? 'does not check' : 'cannot be checked'}; ${CROSS_CUTTING_LABEL} is left to a person`);
      return;
    }
    scopeAccepted.add(`${repoFullName.toLowerCase()}#${pr.number}`);
    const as = await this.automation.setPullLabel(repoFullName, pr.number, CROSS_CUTTING_LABEL, true).catch((error: unknown) => {
      console.warn(`[bridge] ${target}: could not put ${CROSS_CUTTING_LABEL} on for the lead: ${error instanceof Error ? error.message : error}`);
      return null;
    });
    if (!as) return;
    await audit({
      actor: lead,
      action: 'scope.accepted_by_lead',
      target: `${repo.name}#${pr.number}`,
      payload: { label: CROSS_CUTTING_LABEL, reviewId: review.id, sha: pr.head.sha, as },
    }).catch(() => undefined);
  }

  /**
   * `revert` or `deps` put on by somebody without the say is taken off again.
   *
   * Either label puts a pull request on the fast path, which drops the
   * reviewers that are there by default (`decideReviewers`), and `revert`
   * moves it to the front of the merge line. A builder could put either on its
   * own pull request and choose a lighter review. They stand from the app, the
   * automation account, a person who can write to the repository, and — for
   * `revert` on its own revert branch — the deploy seat, whose skill opens the
   * revert of a red smoke with the label. Anyone else's is undone and audited.
   */
  private async guardFastPathLabel(
    repo: { name: string },
    repoFullName: string,
    pr: { number: number; headRef: string },
    label: 'revert' | 'deps',
    sender: { login: string; type?: string } | null,
  ): Promise<void> {
    const login = sender?.login ?? null;
    if (login && sameLogin(login, await this.automationLogin())) return;
    // OpenADLC's own app, not any app: another app's account has no
    // permission of its own to ask about, and is refused below.
    const appLogin = await (async () => this.automation['appGate']?.botLogin() ?? null)().catch(() => null);
    if (login && appLogin && sameLogin(login, appLogin)) return;
    const crew = await bots.listBots().catch(() => []);
    const client = await asAutomation(this.automation['actors'], this.config).catch(() => null);
    if (login && isFleetLogin(crew, login)) {
      const deploy = crew.find((bot) => bot.role === 'deploy');
      if (label === 'revert' && fastPathOf([label], pr.headRef) && sameLogin(deploy?.githubLogin ?? null, login)) return;
    } else if (login && !isAppAccount(sender ?? undefined)) {
      // Asked as the app first, as `adlc:ci`'s guard does: a triage automation
      // account is refused the answer, and a maintainer's label was taken off.
      const permission = await permissionOn(client, repoFullName, login);
      if (['admin', 'maintain', 'write'].includes(permission)) return;
    }
    await client?.removeLabel(repoFullName, pr.number, label).catch((error: unknown) =>
      console.warn(`[bridge] ${repoFullName}#${pr.number}: ${label} put on by ${login ?? 'nobody named'} could not be taken off: ${error instanceof Error ? error.message : error}`),
    );
    await audit({
      actor: login ?? 'unknown',
      action: 'review.fast_path_label_refused',
      target: `${repo.name}#${pr.number}`,
      payload: {
        label,
        why:
          label === 'revert'
            ? 'only the deploy seat on its revert branch, the app, the automation account or a person who can write puts it on'
            : 'only the app, the automation account or a person who can write puts it on',
      },
    }).catch(() => undefined);
  }

  /** The automation account's login, which the bridge acts as when the app cannot. */
  private async automationLogin(): Promise<string | null> {
    const name = await automationBotName(this.config).catch(() => null);
    return name ? ((await bots.getBotByName(name).catch(() => null))?.githubLogin ?? null) : null;
  }

  /**
   * Whether merging is the end of this repository's delivery.
   *
   * Ship deploys through the repository's own workflows — `deploy-testing`,
   * then a promote — and a card reaches Done when production reports the
   * deployment. A repository with no deploy workflow, or one whose settings
   * say it has no testing deploy, has nothing that could ever report one: its
   * cards sat in Ship for good, and the SRE was started on a deploy with
   * nothing to run. Such a repository ships by merging.
   *
   * Null when the choice is automatic and GitHub could not be asked, which
   * leaves it on the deploy path. An explicit choice is not asked.
   */
  private async shipsByMerging(repoName: string, repoFullName: string): Promise<boolean | null> {
    // By the repository's rules, where they are read here; see `delivery-rules.ts`.
    const repo = this.delivery ? await repos.getRepoByName(repoName).catch(() => null) : null;
    if (this.delivery && repo) {
      // Rules that could not be read are only a fallback: the card stays on the deploy path.
      const { rules, readError } = await this.delivery.get(repo);
      return readError ? null : rules.testing.on === 'none';
    }
    const choice = testingDeployChoice(await settings.getSetting('testingDeploy').catch(() => null), repoName);
    const client = choice === 'automatic' ? await asAutomation(this.automation['actors'], this.config).catch(() => null) : null;
    return shipsByMerging(client, repoFullName, choice);
  }

  /**
   * The issues a merged pull request finishes: the one its branch was cut for,
   * and every one it closes. Only the branch was read, so a pull request from
   * any other branch — a person's, another tool's — that said "Closes #N" left
   * #N closed on GitHub but in its old column on the board.
   *
   * GitHub's closing references are asked first: they cover an issue linked in
   * the sidebar, and a keyword counts only on a pull request into the default
   * branch. When GitHub cannot be asked, the body's keywords stand in, on a
   * pull request into the default branch only.
   */
  private async issuesMergedBy(
    repo: { defaultBranch: string },
    repoFullName: string,
    pr: MergedPull,
  ): Promise<{ own: number | null; closes: number[] }> {
    const client = await asAutomation(this.automation['actors'], this.config).catch(() => null);
    const closing = client
      ? await client.closingIssues(repoFullName, pr.number).catch((error: unknown) => {
          console.warn(
            `[bridge] GitHub could not say which issues ${repoFullName}#${pr.number} closes, so they were read from its body: ` +
              `${error instanceof Error ? error.message : error}`,
          );
          return null;
        })
      : null;
    return issuesMergedBy({
      number: pr.number,
      branch: pr.head.ref,
      body: pr.body ?? '',
      intoDefaultBranch: pr.base?.ref === repo.defaultBranch,
      closing,
      sameRepository: headInRepository(pr.head.repo?.full_name, repoFullName),
    });
  }

  /**
   * What a merge does to the board: the issues it finishes move to Merged, or
   * to Done where the repository ships by merging, with the pull request
   * recorded on each, and the lease let go when nothing runs after it. The
   * merge's delivery does it, and the reconciler, for a merge whose delivery
   * never came (`mergeUnheard`).
   */
  private async finishMerge(
    repo: { id: string; name: string; defaultBranch: string },
    repoFullName: string,
    pr: MergedPull,
    fork = false,
  ): Promise<{ to: 'merged' | 'done'; byMerging: boolean; own: number | null; closes: number[] }> {
    const [merged, byMerging] = await Promise.all([
      // A fork's branch name says nothing; the issues it closes still do.
      this.issuesMergedBy(repo, repoFullName, fork ? { ...pr, head: { ...pr.head, ref: '' } } : pr),
      this.shipsByMerging(repo.name, repoFullName),
    ]);
    const to = byMerging ? 'done' : 'merged';
    // The issues the pull request closes besides its own, first, so a failed
    // move of its own issue, thrown below, does not leave them behind.
    await this.moveClosedByMerge(repo, pr.number, merged.closes, to);
    if (merged.own) {
      // Only an issue the crew tracks, as for the ones it closes: a branch
      // named for any other number learnt that number as a card.
      if (!(await issues.getIssue(repo.id, merged.own).catch(() => null))) {
        console.log(`[bridge] ${repo.name}#${pr.number} was cut for ${repo.name}#${merged.own}, which OpenADLC does not track; left where it is`);
      } else {
        // Not an issue labelled `fleetadlc:ignore`: `moveStage` refuses it, and
        // it stays where it is, off the board.
        //
        // One move. It was two — to Ship, then to Done — and the issue's own
        // `closed` delivery, arriving between them with the labels it had
        // before the merge, put the stage back to Review; the second move was
        // then backwards, refused, and fleetadlc-testbed#1 stayed in Ship.
        const moved = await this.automation.moveStage({ repoName: repo.name, issueNumber: merged.own, to, actor: 'bridge', recordsOutcome: true });
        // Written when the pull request opened too; a missed delivery left it
        // empty, and the deploy after the merge finds its issues by it. Only
        // once the move went through: a refused one is not this issue's merge.
        if (moved.moved) await issues.setPullRequestNumber(repo.id, merged.own, pr.number).catch(() => undefined);
        else console.log(`[bridge] ${repo.name}#${pr.number} merged, but ${repo.name}#${merged.own} was not moved to ${to}: ${moved.reason ?? 'refused'}`);
      }
    }
    if (byMerging) {
      // Nothing runs after the merge, so nothing else would let go of the
      // files this change held: the next issue touching them would wait for
      // a verification that is never coming.
      const released = await leases
        .releaseForPullRequest(repo.id, pr.number, 'merged, and the repository deploys nothing')
        .catch(() => null);
      if (released) console.log(`[bridge] released the lease on #${released.issueNumber}: #${pr.number} merged`);
      await this.resumeHeldPlanChanges();
    }
    return { to, byMerging: Boolean(byMerging), own: merged.own, closes: merged.closes };
  }

  /**
   * A merge the reconciler found with no delivery to say so: GitHub closed the
   * issue through `Closes #N`, and the board still had it short of Merged. The
   * reconciler used to take it for an issue closed unmerged and forget it, so
   * its card vanished and whatever waited on it waited for good. Settled here
   * as the delivery would have, all but the testing deploy, which the deploy
   * sweep starts for an issue in Merged. The stage it reached, or null when
   * the pull request did not merge after all.
   */
  async mergeUnheard(repo: { id: string; name: string }, issueNumber: number, prNumber: number): Promise<'merged' | 'done' | null> {
    const record = await repos.getRepoByName(repo.name);
    const client = await asAutomation(this.automation['actors'], this.config);
    if (!record || !client) return null;
    const pull = await client.getPullRequest(record.fullName, prNumber);
    if (!pull.merged) return null;
    // The merge delivery holds a crew merge whose review-gate is not green and
    // moves nothing. This repair used to run finishMerge anyway, so within
    // fifteen minutes the unreviewed commit was in Merged and the deploy sweep
    // shipped it. The hold stands until the gate is green or a person moves
    // the card, which does not come through here. With the delivery missed,
    // nobody was told either, so the alarm is raised here, once. The pull is
    // read live: no `mergedBy` is an account deleted since it merged, and is
    // repaired as a person's merge would be.
    const unreviewed = await this.noticeUnreviewedMerge(
      record.fullName,
      { number: pull.number, merged_by: pull.mergedBy ? { login: pull.mergedBy } : null, head: { sha: pull.headSha } },
      { once: true },
    );
    if (unreviewed) {
      console.warn(`[bridge] ${record.fullName}#${prNumber}: not moved on; a crew account merged it without review-gate passing`);
      return null;
    }
    const { to, own, closes } = await this.finishMerge(record, record.fullName, {
      number: pull.number,
      head: { ref: pull.headRef, repo: pull.headRepoFullName ? { full_name: pull.headRepoFullName } : null },
      base: { ref: pull.baseRef },
    });
    // Its pull request by what the board recorded, and not by the branch or
    // the closing references GitHub lists: moved all the same.
    if (own !== issueNumber && !closes.includes(issueNumber)) await this.moveClosedByMerge(record, prNumber, [issueNumber], to);
    return to;
  }

  /**
   * Moves the issues a merge closes besides the one its branch was cut for,
   * and records the pull request on each, which is how the deploy after it
   * finds them: without it they reached Ship, no deploy ever labelled them,
   * and the deploy sweep said on every run that they were merged with no pull
   * request recorded.
   *
   * Only issues the crew already tracks. A merge's label on any other — one
   * from before the repository joined OpenADLC, a pull request's number — was
   * learnt as a card at that stage; and `fleetadlc:ignore` holds, since a person
   * said to leave the issue alone. A move that fails is said and not thrown:
   * the lease and the deploy after the merge belong to the branch's issue, and
   * an issue someone transferred or deleted should not hold them up.
   */
  private async moveClosedByMerge(
    repo: { id: string; name: string },
    prNumber: number,
    closes: readonly number[],
    to: 'merged' | 'done',
  ): Promise<void> {
    for (const issueNumber of closes) {
      const ref = `${repo.name}#${issueNumber}`;
      try {
        if (!(await issues.getIssue(repo.id, issueNumber))) {
          console.log(`[bridge] ${repo.name}#${prNumber} closes ${ref}, which OpenADLC does not track; left where it is`);
          continue;
        }
        const moved = await this.automation.moveStage({ repoName: repo.name, issueNumber, to, actor: 'bridge', recordsOutcome: true });
        if (!moved.moved) {
          console.log(`[bridge] ${repo.name}#${prNumber} closes ${ref}, not moved to ${to}: ${moved.reason ?? 'refused'}`);
          continue;
        }
        await issues.setPullRequestNumber(repo.id, issueNumber, prNumber);
      } catch (error) {
        console.warn(
          `[bridge] ${repo.name}#${prNumber} merged, but ${ref}, which it closes, was not moved to ${to}: ` +
            `${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }

  /**
   * A crew account dismissed a review: audited, said on the pull request, and
   * the dismissed reviewer asked again — a seat as a review request and a new
   * review task, a person as a review request. Each step is tried on its own,
   * and the comment says only what was done.
   */
  private async dismissedByBot(payload: WebhookPayload, actor: string, crew: Awaited<ReturnType<typeof bots.listBots>>): Promise<void> {
    const pr = payload.pull_request!;
    const review = payload.review!;
    const repoFullName = payload.repository!.full_name;
    const target = `${repoFullName}#${pr.number}`;
    const step = (what: string) => (error: unknown) => {
      console.warn(`[bridge] ${target}: after ${actor} dismissed a review, could not ${what}: ${error instanceof Error ? error.message : error}`);
      return null;
    };
    const reviewer = review.user?.login;
    const author = reviewer ? whoWrote(reviewer, crew, { bot: seatOf(review.body ?? '') }) : null;
    const seat = author?.kind === 'fleetadlc' ? author.bot?.name ?? null : null;

    await audit({
      actor,
      action: 'review.dismissed_by_bot',
      target,
      payload: { reviewId: review.id ?? null, reviewer: reviewer ?? null, seat, sha: pr.head.sha },
    }).catch(step('audit the dismissal'));

    if (seat) {
      // Asked as GitHub shows it, and as a task, which is what brings a review.
      await this.automation.requestReviewers(repoFullName, pr.number, [seat]).catch(step(`re-request ${seat}'s review`));
      const repo = await repos.getRepoByName(payload.repository!.name).catch(() => null);
      if (repo && review.id !== undefined && !fromFork(pr, repoFullName)) {
        await this.taskService
          .askAgain({
            repo,
            prNumber: pr.number,
            branch: pr.head.ref,
            issueNumber: issueNumberFromBranch(pr.head.ref),
            seat,
            reviewId: review.id,
          })
          .catch(step(`ask ${seat} to review again`));
      }
      await this.automation
        .comment(
          repoFullName,
          pr.number,
          `A bot account (${actor}) dismissed ${seat}'s review, which a bot may never do. OpenADLC asked ${seat} to review again, ` +
            'and `review-gate` waits for that review.',
        )
        .catch(step('comment'));
      return;
    }

    const client = await asAutomation(this.automation['actors'], this.config).catch(() => null);
    const reRequested =
      client && reviewer ? await client.requestReviewers(repoFullName, pr.number, [reviewer]).then(() => true, step(`re-request @${reviewer}'s review`)) : false;
    await this.automation
      .comment(
        repoFullName,
        pr.number,
        `A bot account (${actor}) dismissed a review${reviewer ? ` by @${reviewer}` : ''}, which a bot may never do. ` +
          (reRequested ? `OpenADLC re-requested @${reviewer}'s review. ` : '') +
          'A request for changes it dismissed still holds the merge until the person who made it, or someone else who can write here, lifts it.',
      )
      .catch(step('comment'));
  }

  private async onReview(payload: WebhookPayload): Promise<void> {
    const pr = payload.pull_request;
    const review = payload.review;
    const repoFullName = payload.repository?.full_name;
    const repoName = payload.repository?.name;
    if (!pr || !review || !repoFullName || !repoName) return;

    const crew = await bots.listBots();

    // A bot dismissing a review is an incident, not a workflow step. The
    // bridge's own dismissal of a superseded approval, made as the automation
    // account and recorded as it is made, is the one that is not.
    //
    // What holds the merge is `mergeFacts`, which reads the dismissal from the
    // timeline every time (`dismissalsThatHold`). This says so on the pull
    // request and asks the dismissed reviewer again; the gate below is then
    // worked out from the reviews that still stand, which no longer count the
    // dismissed one, so it waits for the new review. It used to hold the gate
    // for a person and ask nobody, and the pull request sat until one came.
    if (payload.action === 'dismissed') {
      const actor = payload.sender?.login;
      const ours = review.id !== undefined && (await this.automation.dismissedByBridge(repoFullName, review.id));
      if (actor && isFleetLogin(crew, actor) && !ours) await this.dismissedByBot(payload, actor, crew);
    }

    const client = await asAutomation(this.automation['actors'], this.config);
    if (!client) return;
    const repo = await repos.getRepoByName(repoName);
    const labels = pr.labels.map((label) => label.name);
    const fork = fromFork(pr, repoFullName);

    // The reviews on this diff, and what they leave to do.
    const standing = await this.automation.reviewStanding(repoFullName, {
      number: pr.number,
      draft: pr.draft,
      labels: pr.labels,
      head: { sha: pr.head.sha, ref: pr.head.ref },
      baseRef: pr.base?.ref ?? repo?.defaultBranch ?? 'main',
    });
    const { gate, decision, posted } = standing;

    // A crew pull request's lead may accept a change past its declared paths
    // in its signed approval; see `acceptScopeFromLead`.
    if (repo && !fork) await this.acceptScopeFromLead(repo, repoFullName, pr, review, crew, decision.lead);

    const published = await this.automation.setReviewGate({
      repoFullName,
      prNumber: pr.number,
      sha: pr.head.sha,
      state: gate.state,
      description: await this.taskService.gateDescription(gate.description, repoName),
    });

    // Every review is in: the pull request is eligible, so it takes a place in
    // the line rather than racing whatever else is ready. What was published is
    // what counts — every review in and a commit a reviewer wrote is not eligible.
    // Only while its issue is in Review: a person who moved the card back to
    // Build took it out of the line, and a reviewer still running turned the
    // gate green and put it back, to land over their decision. The gate
    // sweep (`scheduler.ts`) asks only of issues in Review for the same reason.
    const ownIssue = ownIssueOf(pr, repoFullName);
    const inReview =
      !repo || !ownIssue ? true : await issues.getIssue(repo.id, ownIssue).then((issue) => !issue || issue.stage === 'review', () => false);
    if (published?.state === 'success' && repo && inReview) {
      await this.mergeLine.enter({
        repoName: repo.name,
        prNumber: pr.number,
        headSha: pr.head.sha,
        revert: fastPathOf(labels, pr.head.ref),
      });
      await this.mergeLine.advance(repo.name).catch(() => null);
    }

    // A fork's pull request is reviewed by people: no seat is asked, and no
    // verdict on it sends any builder to patch it.
    if (repo && !fork) {
      // The lead goes last: once every other seat has posted on this diff, it
      // is asked, with all of their reviews in front of it (`context.ts`).
      if (standing.leadDue) {
        await this.taskService.openLeadReview({
          repo,
          prNumber: pr.number,
          branch: pr.head.ref,
          issueNumber: ownIssueOf(pr, repoFullName),
          seat: standing.leadDue.seat,
          since: standing.leadDue.since,
        });
      }
      // A reviewer the gate waits on with nothing in hand would be waited on
      // for good: one whose account was connected after the pull request
      // opened had no task started for it then. It is started now. One whose
      // task ran and failed has a card of its own, with Try again, and is left
      // to it. The lead is not one of these: it is asked above, when its turn comes.
      if (gate.state !== 'success') {
        await this.taskService.openMissingReviews({
          repo,
          prNumber: pr.number,
          branch: pr.head.ref,
          issueNumber: ownIssueOf(pr, repoFullName),
          waitingOn: decision.reviewers.filter((name) => name !== decision.lead && !posted.includes(name)),
        });
      }
    }

    // The lead approved this diff while a blocking seat still asks for changes
    // on it: the merge is held until that seat approves, and nothing sends the
    // work back, because only the lead's or a person's request does. The pull
    // request sat in Review with nobody on it and no card. Recorded on every
    // review that leaves it so; the board keeps the newest per pull request.
    // On a change to how CI runs the security seat holds it too: advisory, it
    // is no approver, and its signed request for changes held the gate with
    // no card for anyone.
    const blocking = decision.approvers.filter((seat) => seat !== decision.lead && (standing.changesRequested ?? []).includes(seat));
    const security = standing.securityAsks && !blocking.includes(standing.securityAsks) ? [standing.securityAsks] : [];
    const held = standing.approved.includes(decision.lead) ? [...blocking, ...security] : [];
    if (held.length > 0 && repo) {
      const blocker = crew.find((bot) => bot.name === held[0]) ?? null;
      console.log(`[bridge] ${repoFullName}#${pr.number}: the lead approved and ${held.join(', ')} still asks for changes; the merge is held for a person`);
      await recordEvent({
        source: 'platform',
        type: REVIEW_STALLED,
        payload: {
          repo: repo.name,
          pr: pr.number,
          issue: issueNumberFromBranch(pr.head.ref),
          rounds: 0,
          bot: blocker?.name ?? held[0],
          botId: blocker?.id ?? null,
          heldBy: held,
          head: pr.head.sha,
        },
      }).catch(() => undefined);
    }

    if (review.state !== 'changes_requested' || !repo || fork) return;

    // Only a verdict that decides sends the work back: the lead's, which has
    // read every other review, or a person's. Another seat's request for
    // changes is advice to the lead (the shim keeps advisory seats to
    // comments; one made around it is still only advice), or, from a blocking
    // seat, a hold on the merge the lead answers; see the stall above.
    const reviewer = whoWrote(review.user.login, crew, { bot: seatOf(review.body ?? '') });
    const seat = reviewer.kind === 'fleetadlc' ? reviewer.bot?.name ?? null : null;
    if (reviewer.kind === 'fleetadlc' && seat !== decision.lead) {
      console.log(`[bridge] ${repoFullName}#${pr.number}: ${seat ?? review.user.login} asked for changes; only the lead's request sends the work back`);
      return;
    }
    // A person's verdict decides only when they may answer a gate. The label
    // GitHub puts on a review says too little: COLLABORATOR is a read-only
    // collaborator too, and on a public repository MEMBER is any member of
    // the organization. Such a person steered the builder, spent its budget
    // and used up the rounds, though they could neither answer a gate nor
    // hold the merge. The review stays on the pull request for the lead.
    if (reviewer.kind !== 'fleetadlc') {
      const may = await this.mayAnswerGates(repoFullName, review.user.login, review.user.id);
      if (may !== true) {
        await this.reviewNotTaken(
          repo,
          repoFullName,
          pr,
          review.user.login,
          may === null
            ? 'OpenADLC could not ask GitHub what they may do on the repository'
            : 'sending work back takes triage or more on the repository, or a place in the install’s humans',
        );
        return;
      }
    }
    await this.patchRound(repo, repoFullName, pr, crew, client, {
      by: seat ?? review.user.login,
      reason: reviewReason(review),
    });
  }

  /**
   * Changes requested means the work goes back to build for another round, up
   * to the cap; at the cap the loop stops and asks a person, on the pull
   * request and as a card. Asked by a review, and by CI that failed again
   * after its rerun on a head whose only finding was CI. The round itself is
   * `SendBack.reviewRound`: the card moves to Build, and the builder's patch
   * task opens on the pull request's branch.
   */
  private async patchRound(
    repo: { id: string; name: string },
    repoFullName: string,
    pr: { number: number; head: { ref: string } },
    crew: readonly { id: string; name: string }[],
    client: Pick<GitHubClient, 'listPullFilesAsNamed'> | null,
    why: { by: string; reason: string } = { by: 'a reviewer', reason: 'changes were requested' },
  ): Promise<void> {
    await this.sendBack.reviewRound({ repo, repoFullName, pr, crew, client, by: why.by, reason: why.reason });
  }

  /**
   * Checks reporting is what the line is waiting for most of the time: it has
   * updated a branch and wants to know whether the result is sound before
   * anything lands on top of it.
   */
  private async onChecks(payload: WebhookPayload): Promise<void> {
    const repoName = payload.repository?.name;
    if (!repoName) return;
    const repo = await repos.getRepoByName(repoName);
    if (!repo) return;
    await this.mergeLine.advance(repo.name).catch(() => null);
  }

  /**
   * A client acting as the OpenADLC app on one repository, or null when the app
   * cannot be asked. Kept a few minutes per repository: each one is a new
   * installation token, and a push sends several runs' events at once.
   */
  private async asApp(repoFullName: string): Promise<GitHubClient | null> {
    const kept = this.appClients.get(repoFullName);
    if (kept && Date.now() - kept.at < APP_CLIENT_MS) return kept.client;
    const client = (await this.automation['appGate']?.client(repoFullName).catch(() => null)) ?? null;
    if (client) this.appClients.set(repoFullName, { client, at: Date.now() });
    return client;
  }

  private readonly appClients = new Map<string, { client: GitHubClient; at: number }>();

  /**
   * A red smoke reverts. Anything else red in the deploy path files an issue.
   *
   * The distinction is whether the change reached testing. A smoke that failed
   * means it did and does not work; a deploy that failed means it did not, and
   * testing is still serving the previous revision — there is nothing for a
   * revert to fix, and somebody has to look at why the deploy broke.
   */
  private async onWorkflowRun(payload: WebhookPayload): Promise<void> {
    const repoName = payload.repository?.name;
    const run = payload.workflow_run;
    if (!repoName) return;

    // Every completed run's minutes, whatever it is: CI, a deploy, a smoke.
    // Counted beside what follows, never in its way.
    if (payload.action === 'completed' && this.ciUsage) {
      void this.ciUsage(payload).then((said) => {
        if (said) console.warn(`[bridge] ${said}`);
      });
    }

    // Promote and deploy runs are acted on only as the repository's own, on
    // its default branch: a workflow is a file in the repository, and one
    // named like them on a pull request's branch or a fork's ran there too
    // (`runOriginRefusal`).
    const origin = run ? await this.deliveryOrigin(repoName) : null;
    if (origin && run && payload.action === 'requested' && isWorkflow(run.name, origin.promote)) {
      const promote = promoteRequested(payload, origin, origin.promote);
      if (!promote) {
        console.log(`[bridge] ${repoName}: a promote the bridge does not act on: ${promoteRefusal(run, origin, origin.promote) ?? 'no commit named'}`);
        return;
      }
      await this.qaBeforePromote(repoName, promote);
      return;
    }

    const ci = ciRunOutcome(payload);
    if (ci && payload.repository?.full_name) {
      await this.onCiRun(repoName, payload.repository.full_name, ci);
      return;
    }

    if (run && smokeFailedOnTesting(run)) {
      if (await this.smokeFromOutsider(payload, run)) return;
      const reverted = await this.revertTesting(repoName, run);
      // And the change goes back to build, with the smoke as its reason,
      // where the revert's own checks say this was a deploy the bridge saw.
      await this.onTestingSmoke(repoName, run, 'failure', reverted);
      return;
    }

    // A green smoke on testing goes on to production, by the rules. The smoke
    // is the workflow the rules name (`testing.smoke`), or `smoke-testing`.
    if (run && payload.action === 'completed' && (run.conclusion === 'success' || run.conclusion === 'failure')) {
      const smoke = await this.smokeNamed(repoName, run.name);
      if (smoke && (await this.smokeFromOutsider(payload, run))) return;
      if (smoke && run.conclusion === 'success') {
        await this.onTestingSmoke(repoName, run, 'success');
        return;
      }
      // A failed smoke under a name of the rules' own: reverted and sent back
      // as `smoke-testing` is, above.
      if (smoke && !smokeFailedOnTesting(run)) {
        const reverted = await this.revertTesting(repoName, run);
        await this.onTestingSmoke(repoName, run, 'failure', reverted);
        return;
      }
    }

    if (origin && run && deployFailedOnTesting(run, origin.deploy)) {
      // Pushed or dispatched on the default branch, as the template's runs are.
      const refused = runOriginRefusal(run, origin, { what: 'deploy', events: ['push', 'workflow_dispatch'] });
      if (refused) {
        console.log(`[bridge] ${repoName}@${run.head_sha.slice(0, 8)}: a failed deploy the bridge does not act on: ${refused}`);
        return;
      }
      // The commit the run was dispatched to deploy, not the tip it ran at.
      await this.reportDeployFailure(repoName, testedCandidate(run, 'deploy-testing') ?? run.head_sha, run.html_url ?? null);
    }
  }

  /**
   * What a run has to be for the bridge to act on it as a promote or a deploy:
   * the repository's default branch and name, and the workflows its rules
   * name for each, besides the templates' own.
   */
  private async deliveryOrigin(
    repoName: string,
  ): Promise<{ defaultBranch: string; fullName: string; promote: string[]; deploy: string[] } | null> {
    const repo = await repos.getRepoByName(repoName).catch(() => null);
    if (!repo) return null;
    const rules = this.delivery ? (await this.delivery.get(repo).catch(() => null))?.rules : null;
    const named = (configured: string | undefined, standard: string) => [...new Set([standard, ...(configured ? [configured] : [])])];
    return {
      defaultBranch: repo.defaultBranch,
      fullName: repo.fullName,
      promote: named(rules?.production.workflow, PROMOTE_WORKFLOW),
      deploy: named(rules?.testing.workflow, DEPLOY_WORKFLOW),
    };
  }

  /**
   * Whether a smoke run was started by somebody OpenADLC does not act for,
   * said once in the log when it was. See `smokeStarterRefusal`.
   */
  private async smokeFromOutsider(
    payload: WebhookPayload,
    run: { head_sha: string; triggering_actor?: { login: string; type?: string; id?: number } | null },
  ): Promise<boolean> {
    const refused = await smokeStarterRefusal(run, {
      repoFullName: payload.repository?.full_name ?? '',
      crew: await bots.listBots().catch(() => []),
      humans: (await effectiveConfig(this.config).catch(() => null))?.humans ?? [],
      client: await asAutomation(this.automation['actors'], this.config).catch(() => null),
    });
    if (!refused) return false;
    console.warn(`[bridge] ${payload.repository?.full_name}@${run.head_sha.slice(0, 8)}: a smoke neither reverted nor told to the pipeline: ${refused}`);
    return true;
  }

  /** Whether a workflow run is the repository's smoke on testing: `smoke-testing`, or the name its rules give. */
  private async smokeNamed(repoName: string, runName: string): Promise<boolean> {
    if (/smoke-testing/i.test(runName)) return true;
    if (!this.delivery) return false;
    const repo = await repos.getRepoByName(repoName).catch(() => null);
    if (!repo) return false;
    const { rules } = await this.delivery.get(repo).catch(() => ({ rules: null }));
    return rules !== null && rules.testing.on !== 'none' && runName === rules.testing.smoke;
  }

  /**
   * The smoke on testing, told to the pipeline: only a run on the default
   * branch, of a commit the bridge saw reach testing — the same proof a revert
   * asks for, since a workflow of that name on a pull request's branch is a
   * file a builder can commit (`smokeRevertRefusal`, `neverDeployed`).
   */
  private async onTestingSmoke(
    repoName: string,
    run: SmokeRun,
    conclusion: 'success' | 'failure',
    reverted?: RevertOutcome,
  ): Promise<void> {
    if (!this.pipeline) return;
    const repo = await repos.getRepoByName(repoName);
    if (!repo || !run.head_sha) return;
    // The commit the smoke ran for, not the default branch's tip (`testedCandidate`).
    const sha = smokedCommit(run);
    const refused = smokeRevertRefusal(run, repo.defaultBranch, repo.fullName) ?? (await this.neverDeployed(repo.name, sha));
    if (refused) {
      console.log(`[bridge] ${repo.name}@${sha.slice(0, 8)}: a smoke the pipeline does not act on: ${refused}`);
      return;
    }
    const line = await this.pipeline
      .onTestingSmoke(repo, sha, conclusion, run.html_url ?? null, reverted)
      .catch((error: unknown) => `${repo.name}@${sha.slice(0, 8)}: ${error instanceof Error ? error.message : error}`);
    console.log(`[bridge] ${line}`);
  }

  /**
   * A pull request's CI finished.
   *
   * Found live: the integration job failed in a test of code the change never
   * touched, passed on a rerun, and cost a review round on the way: the lead
   * reviewer requested changes only because CI was red, that was the third
   * round, and the loop handed the pull request to a person. So a first
   * failure is run again, once, as the app, and a second on the same run is
   * taken as real. Reviewers no longer read CI at all: they review the diff,
   * and a real failure after the lead approved sends the work back to build.
   */
  private async onCiRun(repoName: string, repoFullName: string, ci: CiRunOutcome): Promise<void> {
    const found = await repos.getRepoByName(repoName);
    if (!found) return;
    const repo = { id: found.id, name: found.name, fullName: repoFullName };
    const client = await asAutomation(this.automation['actors'], this.config);
    if (!client) return;
    const listed = ci.pullRequests.length > 0 ? ci.pullRequests : (await client.listPullsForCommit(repo.fullName, ci.sha).catch(() => [])).map((pull) => pull.number);

    // Only an open pull request whose head this run tested. A run on main
    // lists the pull request that merged into it, and that is no reason to
    // run main's CI again.
    const pulls: { number: number; headRef: string }[] = [];
    for (const number of new Set(listed)) {
      const pull = await client.getPullRequest(repo.fullName, number).catch(() => null);
      if (pull && pull.state === 'open' && pull.headSha === ci.sha) pulls.push({ number, headRef: pull.headRef });
    }
    if (pulls.length === 0) return;
    const target = `${repo.name}#${pulls.map((pull) => pull.number).join(',#')}`;

    // A first failure is run again once. When that cannot happen — no app, no
    // "Actions: write", GitHub refusing — no second attempt is coming, and
    // the failure is as real as a second one: waiting would park the pull
    // request with nothing to say so.
    if (ci.outcome === 'failed' && ci.attempt === 1) {
      if ((await this.rerunOnce(repo.fullName, target, ci)) !== 'unavailable') return;
    }

    if (ci.outcome !== 'failed') return;

    // Failed again after its one rerun, or with no rerun to be had: real. The
    // reviewers reviewed without CI; once the lead has approved, CI is what is
    // left, and its failure sends the work back to build — or, at the cap,
    // stops the loop and gives a person the card. Before the lead decides, a
    // red run waits for that decision.
    const crew = await bots.listBots();
    for (const pull of pulls) {
      const full = await client.getPullRequest(repo.fullName, pull.number).catch(() => null);
      if (!full) continue;
      const standing = await this.automation.reviewStanding(repo.fullName, {
        number: pull.number,
        draft: full.draft,
        labels: full.labels.map((name) => ({ name })),
        head: { sha: ci.sha, ref: full.headRef },
        baseRef: full.baseRef,
      });
      if (!standing.approved.includes(standing.decision.lead)) continue;
      console.log(`[bridge] ${repo.name}#${pull.number}: CI failed again on ${ci.sha.slice(0, 7)} after the lead approved; back to build`);
      // Out of the line, and no CI until the lead approves the fix: the label
      // goes, and the next push runs nothing on GitHub.
      await this.mergeLine.leave(repo.name, pull.number).catch(() => undefined);
      if (full.labels.includes(CI_LABEL)) await this.automation.setCiLabel(repo.fullName, pull.number, false).catch(() => null);
      await this.patchRound(repo, repo.fullName, { number: pull.number, head: { ref: pull.headRef } }, crew, client, {
        by: 'fleetadlc',
        reason: `CI failed again on ${ci.sha.slice(0, 7)} after its rerun, after the lead approved: https://github.com/${repo.fullName}/actions/runs/${ci.runId}`,
      });
    }
  }

  /**
   * Runs a first failure's failed jobs again, once. Once is by run and
   * attempt: the event can be delivered again, and an attempt-1 event
   * redelivered after attempt 2 failed would have started attempt 3. So the
   * run is read first, and only one still on its first attempt, and failed,
   * is run again.
   */
  private rerunOnce(repoFullName: string, target: string, ci: { runId: number; sha: string; attempt: number }): Promise<RerunOutcome> {
    // One ask per run at a time. Two callers at once — a delivery and a review,
    // or a redelivery — both asked, and the second, refused because the rerun
    // was already queued, turned a rerun under way into `unavailable` and
    // opened a round nobody needed. The first ask's answer is everyone's; only
    // one that is not known yet (`waiting`) is let go, so the next can ask.
    const key = `${repoFullName}:${ci.runId}:${ci.attempt}`;
    const asked = this.reruns.get(key);
    if (asked) return asked;
    const asking = this.askRerun(repoFullName, target, ci);
    this.reruns.set(key, asking);
    // A rejected ask is let go too, so the next event asks again. Without the
    // second handler the rejection was unhandled here, which ends the process.
    void asking.then(
      (outcome) => {
        if (outcome === 'waiting' && this.reruns.get(key) === asking) this.reruns.delete(key);
      },
      () => {
        if (this.reruns.get(key) === asking) this.reruns.delete(key);
      },
    );
    return asking;
  }

  private async askRerun(repoFullName: string, target: string, ci: { runId: number; sha: string; attempt: number }): Promise<RerunOutcome> {
    const live = await this.automation.ciRunById(repoFullName, ci.runId).catch((error: unknown) => {
      console.warn(
        `[bridge] ${target}: the ci run ${ci.runId} on ${ci.sha.slice(0, 7)} could not be read (${error instanceof Error ? error.message : error}); ` +
          'a verdict that waits on CI waits until it can be, and is asked about again on the next event',
      );
      return null;
    });
    if (!live) return 'waiting';
    if (live.attempt !== 1) return 'rerun';
    if (live.status !== 'completed' || !CI_FAILED.has(live.conclusion ?? '')) return 'waiting';
    let rerun: boolean;
    try {
      rerun = await this.automation.rerunFailedJobs(repoFullName, ci.runId);
    } catch (error) {
      const status = (error as { status?: number }).status;
      const why = error instanceof Error ? error.message : String(error);
      // Refused — the app lacks "Actions: write", or cannot see the run — is
      // for good. Anything else, GitHub failing for a moment, is not: it is
      // asked again on the next event rather than taken as no rerun at all.
      if (status === 403 || status === 404 || status === 422) {
        console.warn(`[bridge] ${target}: CI failed on ${ci.sha.slice(0, 7)} and GitHub refused to run it again: ${why}`);
        return 'unavailable';
      }
      console.warn(`[bridge] ${target}: CI failed on ${ci.sha.slice(0, 7)}; asking to run it again failed for now, and is asked again on the next event: ${why}`);
      return 'waiting';
    }
    if (!rerun) {
      console.warn(`[bridge] ${target}: CI failed on ${ci.sha.slice(0, 7)}; the app cannot be asked, so it is not run again`);
      return 'unavailable';
    }
    await audit({ actor: 'bridge', action: 'ci.rerun', target, payload: { run: ci.runId, sha: ci.sha, attempt: ci.attempt } }).catch(() => undefined);
    console.log(`[bridge] ${target}: CI failed on ${ci.sha.slice(0, 7)}; running its failed jobs again, once`);
    return 'rerun';
  }

  /** Each first failure's one rerun, asked or being asked, by `repo:run:attempt`. */
  private readonly reruns = new Map<string, Promise<RerunOutcome>>();

  /**
   * A production promote waiting for its approval opens a QA run, and tells the
   * person who will approve it where the readiness report will be.
   *
   * Where the environment holds a reviewer, GitHub holds the promote: the job
   * names the `production` environment, whose required reviewer is a person,
   * and it runs nothing until they approve. "QA before the promote proceeds"
   * is true because that person reads the report before approving. Where it
   * holds none — `approval: auto`, or a plan that refused the reviewer — the
   * promote is already running when this is heard: after its soak, or
   * released by a person from Needs you. Saying it waits for an approval
   * there told the person a gate held what nothing held.
   *
   * One QA run per commit. A redelivered event, a re-run of the promote or a
   * second dispatch at the same commit finds the run already going or finished
   * and points at it; only one that failed or was stopped is tried again. The
   * notification goes out every time, because every requested run is a promote
   * waiting for somebody.
   */
  private async qaBeforePromote(repoName: string, promote: PromoteRequest): Promise<void> {
    const repo = await repos.getRepoByName(repoName);
    if (!repo) return;

    const short = promote.sha.slice(0, 8);
    // A promote past the testing check: the workflow let it through only for
    // a person with admin or maintain, and this is the record of who and when.
    const by = promote.actor ?? 'an unknown account';
    if (promote.override) {
      await audit({
        actor: by,
        action: 'deploy.promote_override',
        target: `${repo.name}@${short}`,
        payload: { actor: promote.actor, sha: promote.sha, runUrl: promote.runUrl },
      }).catch(() => undefined);
      console.warn(`[bridge] ${repo.name}@${short}: ${by} promoted to production as an emergency override, past the testing check`);
    }
    const what = promote.override
      ? `A production promote of ${repo.name} at \`${short}\`, an emergency override by ${by} past the testing check,`
      : `A production promote of ${repo.name} at \`${short}\``;
    // Its own thread beside the nightly `<repo>#testing` one. The report a person
    // has to read before approving is the one about this commit, and the subject
    // is what lets a second request for the same commit find the first run.
    const subjectRef = `${repo.name}#testing@${short}`;
    const rules = this.delivery ? (await this.delivery.get(repo).catch(() => null))?.rules : null;
    const approval = rules?.production.approval ?? 'reviewers';
    // The same check that holds the promote. The stored plan-limit row alone
    // said "waiting for your approval" after a person had released one the
    // environment was not holding.
    const heldByBridge = this.pipeline
      ? await this.pipeline.productionNeedsAPerson(repo)
      : await repos
          .getPlanLimits(repo.fullName)
          .then((limits) => Boolean(limits?.limits.some((limit) => limit.name === 'environment production')))
          .catch(() => false);
    const heldByGitHub = approval === 'reviewers' && !heldByBridge;
    const waiting = heldByGitHub
      ? `${what} is waiting for your approval`
      : `${what} is running, ${approval === 'reviewers' ? 'released from Needs you' : 'after its soak on testing'}`;
    const approveAt = promote.runUrl ? (heldByGitHub ? ` Approve or reject it at ${promote.runUrl}.` : ` It runs at ${promote.runUrl}.`) : '';

    // The nightly job's refusals, word for word: no QA bot, or no testing
    // environment to point one at. Either way the person is still told, because
    // the promote is still waiting for them — now with nothing to read first.
    // Where this repository's testing is served, by its rules; the install's
    // FLEETADLC_TESTING_URL only where none says (deprecated).
    const url = this.delivery ? (await this.delivery.get(repo).catch(() => null))?.testingUrl : null;
    const target = await qaTarget(url ?? this.config.testingUrl);
    if ('refusal' in target) {
      await this.notifier?.send({
        event: 'promote_waiting',
        to: null,
        text:
          `${waiting}, and no QA ran before it: ${target.refusal}. ` +
          `There is no readiness report to read.${approveAt}`,
        link: promote.runUrl ?? this.config.consoleUrl,
      });
      return;
    }

    const readFirst = heldByGitHub
      ? 'Read it before you approve: your approval is the only thing holding the promote.'
      : 'Nothing on GitHub holds the promote, so read it as it runs, and roll production back if it finds something.';
    let text: string;
    const earlier = (await tasks.listTasksForSubjects('qa', [subjectRef])).find((task) => !taskGaveUp(task.state));
    if (earlier) {
      const where = earlier.state === 'done' ? 'is in' : 'will appear in';
      text =
        `${waiting}. ${target.bot}'s QA run for this commit is already ${earlier.state}, ` +
        `and its readiness report ${where} the ${subjectRef} thread. ${readFirst}${approveAt}`;
    } else {
      const opened = await openQaRun(this.taskService, target, { repo: repo.name, subjectRef });
      text = opened.taskId
        ? `${waiting}. ${target.bot} is running QA against ${target.testingUrl}, and the readiness report will ` +
          `appear in the ${subjectRef} thread. ${readFirst}${approveAt}`
        : `${waiting}, and QA could not start before it: ${opened.line}. ` +
          `There is no readiness report to read.${approveAt}`;
    }

    await this.notifier?.send({
      event: 'promote_waiting',
      to: null,
      text,
      link: itemLink(this.config.consoleUrl, subjectRef),
    });
  }

  /**
   * Every pull request a promote put in production: the candidate's, and each
   * one merged between the previous promote and it. A promote carries
   * everything before its candidate, and finishing only the candidate's left
   * the rest in Ship, live, with nothing to move them.
   *
   * The commits in between come from GitHub's compare, read page by page until
   * it has given every commit it counts. It used to be one page of at most a
   * hundred, and a promote that carried more finished the candidate's alone.
   *
   * `strict`: a compare GitHub did not finish answering, or a commit whose
   * pull requests it would not name, throws, so the promote stays queued and
   * is walked again; the pull requests it would have missed would otherwise
   * stay in Ship for good, since the next promote starts after them. Only a
   * promote being given up on settles for what GitHub did say.
   *
   * A testing deployment reads the same range, from what testing served
   * before, and settles for what GitHub says (`strict` off).
   */
  private async promotedPulls(
    repoName: string,
    repoFullName: string,
    previous: string | null,
    candidate: string,
    client: {
      request<T>(method: string, path: string): Promise<T>;
      listPullsForCommit(repo: string, sha: string): Promise<{ number: number; headRef: string; headRepoFullName?: string | null }[]>;
    },
    strict: boolean,
  ): Promise<{ number: number; headRef: string; headRepoFullName?: string | null }[]> {
    let shas = [candidate];
    if (previous && previous !== candidate) {
      const between: string[] = [];
      let total: number | null = null;
      let complete = false;
      let failure: unknown = null;
      for (let page = 1; page <= PROMOTE_MAX_PAGES; page++) {
        const answer = await client
          .request<{ commits?: { sha: string }[]; total_commits?: number }>(
            'GET',
            `/repos/${repoFullName}/compare/${previous}...${candidate}?per_page=${PROMOTE_PAGE}&page=${page}`,
          )
          .catch((error: unknown) => {
            failure = error;
            return null;
          });
        if (!answer?.commits) break;
        total ??= answer.total_commits ?? null;
        between.push(...answer.commits.map((commit) => commit.sha));
        // Done when every commit it counts is read, or a short page says there
        // are no more: whichever GitHub says first.
        if ((total !== null && between.length >= total) || answer.commits.length < PROMOTE_PAGE) {
          complete = true;
          break;
        }
      }
      if (!complete) {
        const said =
          `GitHub did not list everything merged between ${previous.slice(0, 8)} and ${candidate.slice(0, 8)} ` +
          `(${between.length} of ${total ?? 'an unknown number of'} commits` +
          `${failure instanceof Error ? `: ${failure.message.slice(0, 160)}` : ''})`;
        if (strict) throw new Error(said);
        console.warn(`[bridge] ${repoName}: ${said}, so only those pull requests and the candidate's are finished`);
      }
      shas = [...new Set([...between, candidate])];
    }

    const seen = new Map<number, { number: number; headRef: string; headRepoFullName?: string | null }>();
    for (const sha of shas) {
      const pulls = await client.listPullsForCommit(repoFullName, sha).catch((error: unknown) => {
        const said = `cannot tell what ${sha.slice(0, 8)} deployed: ${error instanceof Error ? error.message : error}`;
        if (strict) throw new Error(said);
        console.warn(`[bridge] ${repoName}: ${said}`);
        return [] as { number: number; headRef: string; headRepoFullName?: string | null }[];
      });
      for (const pull of pulls) seen.set(pull.number, pull);
    }
    return [...seen.values()];
  }

  /**
   * The candidate the promote before this one put in production.
   *
   * What this recorded when it finished that promote (`deploy.promoted`),
   * because GitHub's deployment for it is at the tip it was dispatched from,
   * not at what it promoted. With nothing recorded — the first promote since
   * OpenADLC started finishing them — the last successful promote run on GitHub
   * before this one names it: runs are numbered in the order they were made,
   * so a later run, which a walk delayed past it would otherwise find first,
   * is passed over. A repository's very first promote finishes the
   * candidate's alone.
   */
  private async previousPromote(
    job: QueuedPromote,
    last: FinishedPromote | null,
    client: { request<T>(method: string, path: string): Promise<T> },
    strict: boolean,
  ): Promise<{ candidate: string | null; recorded: boolean }> {
    if (last) return { candidate: last.candidate, recorded: true };

    // Under `strict`, GitHub not answering keeps the promote queued: taking it
    // for the first would finish the candidate's alone and record it, and the
    // range before it would be lost for good.
    const runs = await client
      .request<{ workflow_runs?: { id: number; name?: string | null; display_title?: string | null }[] }>(
        'GET',
        `/repos/${job.repoFullName}/actions/runs?status=success&event=workflow_dispatch&per_page=100`,
      )
      .catch((error: unknown) => {
        const said = `could not list the promote runs before ${job.candidate.slice(0, 8)}: ${error instanceof Error ? error.message : error}`;
        if (strict) throw new Error(said);
        console.warn(`[bridge] ${job.repo}: ${said}`);
        return null;
      });
    for (const run of runs?.workflow_runs ?? []) {
      if (job.runId !== null && run.id >= job.runId) continue;
      const earlier = promotedCandidate(run);
      if (earlier && earlier !== job.candidate) return { candidate: earlier, recorded: false };
    }
    return { candidate: null, recorded: false };
  }

  /** The promotes waiting to be walked, taken one at a time; see `walkPromotes`. */
  private promoteWalk: Promise<void> = Promise.resolve();

  /**
   * Walks every promote a production deployment queued (`PROMOTE_QUEUED`).
   *
   * A promote's walk is a compare, a lookup per commit, and a stage move,
   * labels and a comment per pull request: for a large promote, longer than
   * GitHub waits for a delivery's answer. So the delivery only queues it, and
   * this does the walk. Queued promotes are in the event log, so a bridge that
   * restarts walks what it had not finished (`main.ts` calls this as it
   * starts), and one whose walk failed is tried again on the next deployment,
   * testing's or production's.
   *
   * One walk at a time: in this process by the chain below, and across
   * processes — two bridge revisions overlap during a rollout — by an
   * advisory lock. Oldest first, and a repository's walk stops at its first
   * promote that fails, because each reads where the one before it left
   * production: a later promote finished first would leave the earlier one
   * nothing to compare, and moving the record back to it would walk the later
   * one's pull requests again.
   */
  walkPromotes(): Promise<void> {
    const walk = this.promoteWalk.then(() => withAdvisoryLock(PROMOTE_LOCK, () => this.walkQueuedPromotes()));
    this.promoteWalk = walk.catch((error: unknown) => {
      console.warn(`[bridge] could not walk the queued promotes: ${error instanceof Error ? error.message : error}`);
    });
    return this.promoteWalk;
  }

  private async walkQueuedPromotes(): Promise<void> {
    const stopped = new Set<string>();
    for (const event of await listUnprocessedEventsOfType(PROMOTE_QUEUED)) {
      const job = event.payload as QueuedPromote;
      if (stopped.has(job.repo)) continue;
      // A day of failing is not transient: the last try settles for what
      // GitHub does say, and whatever still fails then is given up on.
      const lastTry = Date.now() - Date.parse(event.at) > PROMOTE_GIVE_UP_MS;
      try {
        await this.walkPromote(job, { strict: !lastTry });
        await markEventProcessed(event.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (lastTry) {
          await markEventProcessed(event.id, message);
          console.warn(`[bridge] ${job.repo}: gave up finishing the promote of ${job.candidate.slice(0, 8)}: ${message}`);
        } else {
          stopped.add(job.repo);
          console.warn(`[bridge] ${job.repo}: could not finish the promote of ${job.candidate.slice(0, 8)} yet: ${message}`);
        }
      }
    }
  }

  private async walkPromote(job: QueuedPromote, options: { strict: boolean }): Promise<void> {
    const repo = await repos.getRepoByName(job.repo);
    if (!repo) return;

    // Keyed on the run, not the commit: a promote of an older commit is a real
    // rollback, and walks. A run already finished, or older than the last one
    // finished — a redelivery by hand, or a promote given up on and delivered
    // again — is not walked, and never moves the record back.
    // A new dispatch of the commit already last promoted has nothing new to
    // finish either; a rollback promotes a different one, and walks.
    const last = await lastPromoted(job.repo);
    if (
      last &&
      (job.candidate === last.candidate || (job.runId !== null && last.runId !== null && job.runId <= last.runId))
    ) {
      console.log(
        `[bridge] ${job.repo}: the promote of ${job.candidate.slice(0, 8)}${job.runId !== null ? ` (run ${job.runId})` : ''} ` +
          'is already finished, or older than the last one that was',
      );
      return;
    }

    const automation = await automationBotName(this.config);
    const client = await this.automation['actors'].asBot(automation);
    if (!client) {
      throw new Error(`no credential for ${automation}. Run: fleetadlc auth login --bot ${automation}`);
    }

    const since = await this.previousPromote(job, last, client, options.strict);
    if (!since.candidate) {
      console.log(
        `[bridge] ${job.repo}: no promote before ${job.candidate.slice(0, 8)} on record or on GitHub; finishing the candidate's pull request`,
      );
    } else if (!since.recorded) {
      console.log(
        `[bridge] ${job.repo}: the promote before ${job.candidate.slice(0, 8)} is ${since.candidate.slice(0, 8)}, from its run on GitHub`,
      );
    }
    // Everything that can fail the whole walk happens before anything is
    // written, so a walk tried again comments on nothing twice.
    const pulls = await this.promotedPulls(job.repo, job.repoFullName, since.candidate, job.candidate, client, options.strict);
    await this.finishDeployed({
      repo,
      repoFullName: job.repoFullName,
      client,
      pulls,
      outcome: { environment: 'production', label: job.label, sha: job.candidate, revisionUrl: job.revisionUrl, runUrl: job.runUrl ?? null },
      eachPull: 'continue',
    });
    await recordEvent({
      source: 'platform',
      type: 'deploy.promoted',
      payload: { repo: job.repo, candidate: job.candidate, runId: job.runId } satisfies FinishedPromote & { repo: string },
    });
  }

  /**
   * The candidate a production deployment's promote run names: from the
   * delivery, or else from the run itself, read by its id. Null when the run is
   * not a promote, or names none.
   */
  private async promotedBy(
    repoFullName: string,
    run: WebhookPayload['workflow_run'],
    client: Pick<GitHubClient, 'request'> | null,
  ): Promise<string | null> {
    const named = promotedCandidate(run);
    if (named || !run?.id || !client) return named;
    return client
      .request<{ name?: string; display_title?: string | null }>('GET', `/repos/${repoFullName}/actions/runs/${run.id}`)
      .then((fetched) => promotedCandidate(fetched))
      .catch(() => null);
  }

  /**
   * The commit a testing deployment's run deployed, as its name carries it,
   * from the delivery or else from the run itself; null when the run names
   * none, and the deployment's own commit stands (`testedCandidate`).
   */
  private async deployedBy(repoFullName: string, run: WebhookPayload['workflow_run']): Promise<string | null> {
    const named = testedCandidate(run, 'deploy-testing');
    if (named || !run?.id || run.display_title) return named;
    const client = await asAutomation(this.automation['actors'], this.config).catch(() => null);
    if (!client) return null;
    return client
      .request<{ name?: string; display_title?: string | null }>('GET', `/repos/${repoFullName}/actions/runs/${run.id}`)
      .then((fetched) => testedCandidate(fetched, 'deploy-testing'))
      .catch(() => null);
  }

  /**
   * What a deployment reaching an environment means for the work in it.
   *
   * The label on the pull request is what the rest of the platform reads: the
   * builder verifies against the revision URL, an issue waiting on this one
   * stops waiting once it is on testing, and production is what finishes the
   * card. None of it is written by the workflow that deployed — a workflow's
   * token fires no further events, so a label set from Actions would be a dead
   * end. The deployment is the event; this is what acts on it.
   */
  private async onDeploymentStatus(payload: WebhookPayload): Promise<void> {
    const repoName = payload.repository?.name;
    const repoFullName = payload.repository?.full_name;
    const outcome = deploymentOutcome(payload);
    if (!repoName || !repoFullName || !outcome) return;

    const repo = await repos.getRepoByName(repoName);
    if (!repo) return;

    // Only the default branch's deployments, failed or not: an environment is
    // named by the workflow, and a workflow on any branch can name
    // `production`, roll it back, or finish the pull requests of a commit.
    const refused = deploymentOriginRefusal(payload, repo.defaultBranch, outcome.environment);
    if (refused) {
      console.log(`[bridge] ${repo.name}: a ${outcome.environment} deployment the bridge does not act on: ${refused}`);
      return;
    }

    // A testing deployment is at the default branch's tip when its run was
    // dispatched; the commit it deployed is the one its run is named for.
    if (outcome.environment === 'testing') {
      const deployed = await this.deployedBy(repoFullName, payload.workflow_run);
      if (deployed && deployed !== outcome.sha) {
        console.log(`[bridge] ${repo.name}: testing's deployment is at ${outcome.sha.slice(0, 8)}, and its run deployed ${deployed.slice(0, 8)}`);
        outcome.sha = deployed;
      }
    }

    // A failed testing deployment never took traffic, so testing is still on
    // the previous revision and there is nothing for a revert to put back. It
    // becomes an issue, and the SRE's task on it, which finds whether the
    // change or the deploy path broke. Main is never reverted for production
    // either: that would be a second change during an incident.
    if (!outcome.succeeded) {
      if (outcome.environment === 'testing') {
        await this.reportDeployFailure(repo.name, outcome.sha, outcome.revisionUrl ?? outcome.runUrl);
      }
      // A failed production deployment is acted on only when it is a promote
      // this bridge dispatched, and only by where it stopped (see
      // `DeployPipeline.onProductionFailed`): a failed smoke goes back to
      // build, a failed traffic shift is rolled back and told to a person,
      // anything else is told to a person. Its commit is the candidate the
      // promote run names, never the deployment's own: that is the default
      // branch's tip, and a failure from any other run sent back whatever
      // pull request was at the tip and rolled a healthy production back.
      if (outcome.environment === 'production' && this.pipeline) {
        const client = await asAutomation(this.automation['actors'], this.config).catch(() => null);
        const run = payload.workflow_run;
        const sha = await this.promotedBy(repoFullName, run, client);
        if (!sha) {
          console.warn(`[bridge] ${repo.name}: a production deployment failed, but not in a promote run that names its candidate; nothing was rolled back or sent back`);
          return;
        }
        const handled = await this.pipeline
          .onProductionFailed(repo, sha, typeof run?.id === 'number' ? run.id : null, run?.html_url ?? outcome.revisionUrl ?? outcome.runUrl)
          .catch((error: unknown) => ({ line: `${repo.name}@${sha.slice(0, 8)}: ${error instanceof Error ? error.message : error}`, person: null }));
        console.log(`[bridge] ${handled.line}`);
        if (handled.person) {
          await this.reportDeployFailure(repo.name, sha, run?.html_url ?? outcome.revisionUrl ?? outcome.runUrl, { environment: 'production', note: handled.person });
        }
      }
      return;
    }

    // What a red smoke's revert is checked against (`revertTesting`): the
    // commit reached testing, as the bridge heard it, before anything else
    // here can fail. What testing served before it is read first.
    let previousOnTesting: string | null = null;
    if (outcome.environment === 'testing') {
      previousOnTesting = await lastOnTesting(repo.name).catch(() => null);
      await recordEvent({ source: 'platform', type: DEPLOYED_TO_TESTING, payload: { repo: repo.name, sha: outcome.sha } });
    }

    const automation = await automationBotName(this.config);
    const client = await this.automation['actors'].asBot(automation);
    if (!client) {
      console.warn(
        `[bridge] ${repo.name} is on ${outcome.environment} at ${outcome.sha.slice(0, 8)}, but nothing was labelled: ` +
          `no credential for ${automation}. Run: fleetadlc auth login --bot ${automation}`,
      );
      return;
    }

    // A promote is dispatched on the default branch, so the deployment GitHub
    // makes for its job is at the branch's tip, whatever `candidate` it was
    // asked to promote. Labelling the tip's pull requests would move to Done a
    // change that is not in production. The candidate comes from the run's
    // name (`run-name` in promote-production.yml), in the delivery or else
    // from the run itself; a production deployment that names none finishes
    // nothing, and says so.
    if (outcome.environment === 'production') {
      const candidate = await this.promotedBy(repoFullName, payload.workflow_run, client);
      if (!candidate) {
        console.warn(
          `[bridge] ${repo.name} is on production, but the deployment does not say which candidate was promoted ` +
            `(its run is not named "promote-production <commit>"), so no pull request was labelled or finished`,
        );
        return;
      }
      outcome.sha = candidate;
      // Walked off the request; see `walkPromotes`.
      await recordEvent({
        source: 'platform',
        type: PROMOTE_QUEUED,
        payload: {
          repo: repo.name,
          repoFullName,
          candidate,
          runId: typeof payload.workflow_run?.id === 'number' ? payload.workflow_run.id : null,
          label: outcome.label,
          revisionUrl: outcome.revisionUrl,
          runUrl: outcome.runUrl,
        } satisfies QueuedPromote,
      });
      void this.walkPromotes();
      return;
    }

    // Which pull requests a commit came from is GitHub's answer, not one the
    // platform can reconstruct: a squash merge leaves no link to its branch
    // that is visible from the pushed commit alone.
    //
    // Every one merged since what testing served before, not only this
    // commit's. deploy-testing's concurrency group holds one run waiting, and
    // a third merge replaces it rather than queueing behind it: the merge in
    // the middle is never deployed on its own, and is live only inside this
    // one. Finished from its own commit alone, it never got `deployed:testing`
    // and its builder never verified it.
    const pulls = await this.promotedPulls(repo.name, repoFullName, previousOnTesting, outcome.sha, client, false);
    await this.finishDeployed({ repo, repoFullName, client, pulls, outcome });
    // A promote whose walk failed is tried again here too, not only at the
    // next promote: testing deploys come far more often.
    void this.walkPromotes();
  }

  /**
   * Labels and comments on each pull request a deploy put somewhere, and on
   * its issue. Production finishes the card; testing starts the builder
   * verifying.
   */
  private async finishDeployed(input: {
    repo: { id: string; name: string };
    repoFullName: string;
    client: {
      addLabels(repo: string, number: number, labels: string[]): Promise<unknown>;
      comment(repo: string, number: number, body: string): Promise<unknown>;
    };
    pulls: { number: number; headRef: string; headRepoFullName?: string | null }[];
    outcome: { environment: 'testing' | 'production'; label: string; sha: string; revisionUrl: string | null; runUrl: string | null };
    /**
     * `continue`: one pull request that fails — its issue deleted or
     * transferred, GitHub erroring on its labels — is said and the rest are
     * finished. A promote's walk is not tried again for it, since trying
     * again would comment a second time on every pull request before it.
     */
    eachPull?: 'throw' | 'continue';
  }): Promise<void> {
    const { pulls } = input;
    for (const pull of pulls) {
      if (input.eachPull !== 'continue') {
        await this.finishOneDeployed(input, pull);
        continue;
      }
      await this.finishOneDeployed(input, pull).catch((error: unknown) => {
        console.warn(
          `[bridge] ${input.repo.name}: could not finish #${pull.number} on ${input.outcome.environment}: ` +
            `${error instanceof Error ? error.message : error}`,
        );
      });
    }
  }

  private async finishOneDeployed(
    input: {
      repo: { id: string; name: string };
      repoFullName: string;
      client: {
        addLabels(repo: string, number: number, labels: string[]): Promise<unknown>;
        comment(repo: string, number: number, body: string): Promise<unknown>;
      };
      outcome: { environment: 'testing' | 'production'; label: string; sha: string; revisionUrl: string | null; runUrl: string | null };
    },
    pull: { number: number; headRef: string; headRepoFullName?: string | null },
  ): Promise<void> {
    const { repo, repoFullName, client, outcome } = input;
    // A fork's branch names no issue, whatever it is called (`headInRepository`).
    const issueNumber = headInRepository(pull.headRepoFullName, repoFullName) ? issueNumberFromBranch(pull.headRef) : null;
    // The issues the merge moved besides the branch's own carry this pull
    // request's number; read only the branch, they sat in Ship for good.
    const tracked = await issues.listIssues(repo.name).catch(() => []);
    const closed = tracked.filter((issue) => issue.prNumber === pull.number && issue.number !== issueNumber).map((issue) => issue.number);

    // Production finishes a card that is in Ship. The jump from an earlier
    // column is the merge's (`recordsOutcome`): a card sent back after its
    // change was reverted is being reworked, and a later promote whose range
    // still contains that merge marked it Done. Review → Done is a forward
    // move, so the stage alone does not say the card is this pull's: once the
    // rework's pull request is open the card is in Review, and finishing it
    // counted the reverted change as done.
    const finishOnProduction = async (number: number): Promise<void> => {
      const issue = tracked.find((entry) => entry.number === number);
      const elsewhere = issue?.prNumber != null && issue.prNumber !== pull.number;
      const notInShip = Boolean(issue?.stage && issue.stage !== 'merged' && issue.stage !== 'done');
      if (elsewhere || notInShip) {
        console.warn(
          `[bridge] ${repo.name}#${number} is live on production but left in ${issue?.stage ?? 'its column'}: a promote finishes a card that is in Ship on this pull request`,
        );
        return;
      }
      const moved = await this.automation.moveStage({ repoName: repo.name, issueNumber: number, to: 'done', actor: 'bridge' });
      if (!moved.moved) console.warn(`[bridge] ${repo.name}#${number} is live on production but was not moved to Done: ${moved.reason ?? 'refused'}`);
    };

    // The stage move goes first, so a pull request whose issue could not be
    // moved is not labelled deployed as if its card were done. The move writes
    // the issue's labels from the ones GitHub has, not from the stored row,
    // and fails when it cannot read them.
    if (issueNumber && outcome.environment === 'production') await finishOnProduction(issueNumber);
    // Theirs is said and not thrown, as at the merge: the pull request and its
    // own issue are finished whatever became of an issue it also closed.
    for (const other of closed) {
      if (outcome.environment === 'production') {
        await finishOnProduction(other).catch((error: unknown) => {
          console.warn(
            `[bridge] ${repo.name}#${other} is live on production but was not moved to Done: ${error instanceof Error ? error.message : error}`,
          );
        });
      }
      await client.addLabels(repoFullName, other, [outcome.label]).catch(() => undefined);
    }

    await client.addLabels(repoFullName, pull.number, [outcome.label]).catch(() => undefined);
    await client
      .comment(
        repoFullName,
        pull.number,
        outcome.revisionUrl
          ? `Live on ${outcome.environment}: ${outcome.revisionUrl} (\`${outcome.sha.slice(0, 8)}\`).`
          : `Deployed to ${outcome.environment} at \`${outcome.sha.slice(0, 8)}\`. The deploy reported no revision URL` +
            (outcome.runUrl ? `; the run that deployed it: ${outcome.runUrl}.` : '.'),
      )
      .catch(() => undefined);

    if (!issueNumber) return;

    // The issue carries the label too, because that is where the rest of the
    // platform looks: `dependencyIsSatisfied` reads the issue's labels, and a
    // second issue waiting on this one never sees the pull request's.
    await client.addLabels(repoFullName, issueNumber, [outcome.label]).catch(() => undefined);

    if (outcome.environment === 'testing') {
      await this.verifyOnTesting({ repo, issueNumber, prNumber: pull.number, headRef: pull.headRef });
    }
  }

  /**
   * The builder checks its own change where it is now running.
   *
   * This is the moment the merge has been waiting for. The implement task ended
   * when the pull request opened, and the lease it left behind holds the ground
   * the change sits on until something has verified it — so nothing here is
   * optional bookkeeping: an issue that overlaps this one is waiting on it.
   *
   * A builder that stopped on this pull request resumes rather than starting
   * again, because it still has the worktree and the branch the change was
   * built on — and a verification that already happened is not repeated, because
   * a redelivered `deployment_status` must cost nothing. Every other handler
   * here re-derives its answer and so is free to run twice; this one spends
   * money, so it has to check.
   */
  private async verifyOnTesting(input: {
    repo: { id: string; name: string };
    issueNumber: number;
    prNumber: number;
    /** The pull request's branch, which names the builder when no lease is held any more. */
    headRef: string;
  }): Promise<void> {
    const subjectRef = `${input.repo.name}#${input.prNumber}`;
    const lease = await leases.getActiveLease(input.repo.id, input.issueNumber);
    // A lease let go before the deploy came — the issue closed at the merge
    // and a reconcile ran first, or its backstop passed — still owes the
    // verification: the branch says whose change it is. Both used to return
    // in silence, and the builder never checked its change on testing.
    const crew = await bots.listBots();
    const named = lease ? null : builderOfBranch(input.headRef);
    const builder = lease ? crew.find((bot) => bot.id === lease.botId) : crew.find((bot) => bot.name === named);
    if (!builder) {
      const why = lease
        ? 'the seat holding its lease is not in the crew'
        : named
          ? `no lease is held, and ${named}, the builder its branch ${input.headRef} names, is not in the crew`
          : `no lease is held, and its branch ${input.headRef} names no builder`;
      console.log(`[bridge] ${input.repo.name}#${input.issueNumber}: ${subjectRef} is on testing and not verified there: ${why}`);
      return;
    }

    const already = (await tasks.listTasks({ botId: builder.id, limit: 50 })).filter(
      (task) => task.subjectRef === subjectRef && task.kind === 'qa',
    );

    if (already.length > 0) {
      const paused = already.find((task) => task.state === 'paused');
      if (paused) await this.taskService.resume(paused.id);
      return;
    }

    // Nowhere to verify it: a task opened anyway tested nothing and still
    // reported `verified`. Its ending is what lets the lease go, so it is let
    // go here as a finished verification would, or an overlapping issue
    // waits for good. In the nightly job's words (`qaTarget`).
    const full = await repos.getRepoByName(input.repo.name).catch(() => null);
    const url = this.delivery && full ? (await this.delivery.get(full).catch(() => null))?.testingUrl : null;
    if (!(url || this.config.testingUrl)) {
      const released = await leases
        .releaseForPullRequest(input.repo.id, input.prNumber, 'no testing environment to verify the merge on')
        .catch(() => null);
      console.log(
        `[bridge] ${subjectRef} not verified on testing: ${NO_TESTING_URL}` +
          (released ? `; released the lease on #${released.issueNumber}` : ''),
      );
      return;
    }

    // `qa` rather than `patch`: what is owed is evidence against a real
    // environment, not another commit. It is also the kind that releases the
    // lease when it ends, which is what lets the next overlapping issue out.
    await this.taskService
      .open({
        bot: builder.name,
        repo: input.repo.name,
        kind: 'qa',
        subjectType: 'pr',
        subjectRef,
        skill: 'qa',
        issueNumber: input.issueNumber,
        declaredPaths: ['tests/**'],
        // The deploy that asks for it happens once; nothing sweeps for it.
        whenBlocked: 'record',
      })
      .catch((error) => console.warn(`[bridge] verification of ${subjectRef} not started: ${error.message}`));
  }

  /**
   * Reverting is the deploy bot's work, and only a red smoke of a commit the
   * bridge saw reach testing asks for it.
   *
   * The first revert of a commit starts past a monthly cap (`CapBypass`), so
   * what asks for one is checked first. Any failed run named smoke-testing
   * used to: a workflow of that name on a pull request's branch, which a
   * builder can commit, or a re-run of a red smoke, which any seat can ask
   * for, and each started another revert past the cap. Now the run must be on
   * the default branch, not from a pull request, and of a commit whose
   * testing deployment the bridge recorded (`DEPLOYED_TO_TESTING`); and only
   * the first ask for a commit is authorised past the cap
   * (`spendingLimits.authorizeRevert`). A later one is ordinary work, held by
   * a cap like any other.
   *
   * The authorisation is taken before the task opens, and is not spent until
   * a revert starts. An open refused because the deploy bot is busy records
   * nothing, and gives it back, so the next red smoke of the commit has it. A
   * task recorded without starting — a prerequisite missing — keeps it, so the
   * recovery's automatic retry of that task starts past the cap too
   * (`retryTask`, `spendingLimits.holdRevert`). Anything else spends it: an
   * open that threw after the task was written, or a start hostd may have
   * begun before its answer was lost (`recordedUnstarted`).
   *
   * What it did comes back, for the send-back and the reopened issue to say:
   * both said the change was being reverted when no revert was running.
   */
  private async revertTesting(repoName: string, run: SmokeRun): Promise<RevertOutcome> {
    // The commit the smoke ran for, not the default branch's tip (`testedCandidate`).
    const sha = run.head_sha ? smokedCommit(run) : '';
    if (!sha) return { opened: false, reason: 'refused', why: 'the smoke names no commit' };

    const repo = await repos.getRepoByName(repoName);
    if (!repo) return { opened: false, reason: 'refused', why: `${repoName} is not a repository OpenADLC works in` };
    const deploy = (await bots.listBots()).find((bot) => bot.role === 'deploy');
    if (!deploy) return { opened: false, reason: 'no-deploy-bot', why: 'the crew has no deploy bot to revert it' };

    const refused = smokeRevertRefusal(run, repo.defaultBranch, repo.fullName) ?? (await this.neverDeployed(repo.name, sha));
    if (refused) {
      console.warn(`[bridge] ${repo.name}@${sha.slice(0, 8)}: a red smoke, and no revert: ${refused}`);
      return { opened: false, reason: 'refused', why: refused };
    }

    const subjectRef = `${repo.name}@${sha.slice(0, 8)}`;
    const first = await spendingLimits
      .authorizeRevert(subjectRef, { repo: repo.name, sha, run: run.html_url ?? null })
      .catch((error: unknown) => {
        console.warn(`[bridge] ${subjectRef}: the revert is not authorised past a cap: ${error instanceof Error ? error.message : error}`);
        return false;
      });

    let failure = '';
    const opened = await this.taskService
      .open({
        bot: deploy.name,
        repo: repo.name,
        kind: 'deploy',
        subjectType: 'merge',
        subjectRef,
        skill: 'deploy',
        branch: `${REVERT_BRANCH_PREFIX}${sha.slice(0, 8)}`,
        // A red smoke is asked once; nothing sweeps for a revert.
        whenBlocked: 'record',
        ...(first ? { bypassCap: { by: 'bridge', why: 'the first revert of a commit after a red smoke test' } } : {}),
      })
      .catch((error: unknown) => {
        failure = error instanceof Error ? error.message : String(error);
        console.warn(`[bridge] revert task not started: ${failure}`);
        return error instanceof BotBusyError ? ('busy' as const) : null;
      });
    const unstarted = opened && opened !== 'busy' ? await recordedUnstarted(opened) : false;
    if (first) await this.settleRevertAuthorization(subjectRef, opened, unstarted);

    const outcome: RevertOutcome =
      opened === 'busy'
        ? { opened: false, reason: 'busy', why: `${deploy.name} was busy, and nothing asks for this revert again` }
        : opened === null
          ? { opened: false, reason: 'error', why: `the revert task did not start (${failure.slice(0, 160)})` }
          : !opened.error
            ? { opened: true }
            : unstarted
              ? { opened: false, reason: 'held', why: `the revert task is recorded but has not started (${opened.error.slice(0, 160)})` }
              : { opened: false, reason: 'error', why: `the revert task did not start (${opened.error.slice(0, 160)})` };
    await this.reopenForRevert(repo.fullName, sha, run.html_url ?? null, outcome);
    return outcome;
  }

  /**
   * Where the commit's one start past a cap goes once the revert's open has
   * answered: given back when the deploy bot was busy and nothing was
   * recorded, held for a task recorded without starting, and otherwise
   * spent. A failure here leaves it taken, which holds the next red smoke by
   * the cap: it fails closed.
   */
  private async settleRevertAuthorization(
    subjectRef: string,
    opened: { taskId: string; error?: string } | 'busy' | null,
    /** `recordedUnstarted(opened)`, read once by the caller. */
    unstarted: boolean,
  ): Promise<void> {
    try {
      if (opened === 'busy') {
        await spendingLimits.releaseRevert(subjectRef, { why: 'the deploy bot was busy, and no revert task was recorded' });
      } else if (opened && unstarted) {
        if (!(await spendingLimits.holdRevert(subjectRef, opened.taskId))) {
          console.warn(`[bridge] ${subjectRef}: the revert's authorisation past a cap was not held for ${opened.taskId}, so it is spent`);
        }
      }
    } catch (error) {
      console.warn(`[bridge] ${subjectRef}: the revert's authorisation was left as it was: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * Why a commit cannot be the one a red smoke tested, or null when the
   * bridge recorded its testing deployment succeeding. A failed read is no
   * record, so it fails closed.
   */
  private async neverDeployed(repoName: string, sha: string): Promise<string | null> {
    const since = new Date(Date.now() - DEPLOYED_LOOKBACK_MS);
    const seen = await hasEventOfType(DEPLOYED_TO_TESTING, since, { repo: repoName, sha }).catch(() => false);
    return seen ? null : `the bridge has no record of ${sha.slice(0, 8)} being deployed to testing`;
  }

  /**
   * Puts the issue back on the board, with the smoke output on it.
   *
   * A merge closes the issue and a revert takes the change away again. Left
   * closed, the work has simply vanished: nothing on the board, nobody
   * assigned, and the only trace is a revert pull request referencing a number
   * nobody is looking at. The builder finds out from this comment.
   */
  private async reopenForRevert(repoFullName: string, sha: string, smokeRunUrl: string | null, revert: RevertOutcome): Promise<void> {
    const automation = await automationBotName(this.config);
    const client = await this.automation['actors'].asBot(automation);
    if (!client) {
      console.warn(
        `[bridge] ${repoFullName}@${sha.slice(0, 8)} failed its smoke on testing, but no issue was reopened: ` +
          `no credential for ${automation}. Run: fleetadlc auth login --bot ${automation}`,
      );
      return;
    }

    try {
      const pulls = await client.listPullsForCommit(repoFullName, sha);
      for (const pull of pulls) {
        for (const issueNumber of await this.closedByPull(client, repoFullName, pull)) {
          await client.reopenIssue(repoFullName, issueNumber);
          await client.comment(
            repoFullName,
            issueNumber,
            [
              revert.opened
                ? `Reopened: the smoke failed on testing at \`${sha.slice(0, 8)}\` and the change is being reverted.`
                : `Reopened: the smoke failed on testing at \`${sha.slice(0, 8)}\`. No revert is running: ${revert.why}. Testing may still be serving it.`,
              smokeRunUrl ? `\nThe run: ${smokeRunUrl}` : '',
              `\n${revert.opened ? 'The revert keeps' : 'A revert has to keep'} \`${REVERT_EXCLUDES.join('`, `')}\`. A migration that reached testing has already run`,
              'against that database, and reverting the file would leave a schema the code no longer describes.',
            ]
              .filter(Boolean)
              .join('\n'),
          );
        }
      }
    } catch (error) {
      console.warn(
        `[bridge] could not reopen the issue behind ${sha.slice(0, 8)}: ` +
          `${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * The issues a merged pull request closed: GitHub's own list, or when it
   * cannot be asked, the closing keywords in its body; and the issue its
   * branch was cut for. Reading the body alone with a parser that knew only
   * closes, fixes and resolves left an issue a "Fixed #12" closed shut while
   * its change was reverted.
   */
  private async closedByPull(
    client: Pick<GitHubClient, 'closingIssues' | 'getIssue'>,
    repoFullName: string,
    pull: { number: number; headRef: string },
  ): Promise<number[]> {
    const listed =
      (await (async () => client.closingIssues(repoFullName, pull.number))().catch(() => null)) ??
      closingKeywords((await client.getIssue(repoFullName, pull.number))?.body ?? '');
    const own = issueNumberFromBranch(pull.headRef);
    return [...new Set([...listed, ...(own ? [own] : [])])].filter((number) => number !== pull.number);
  }

  /**
   * The deploy path broke, which is not the change failing.
   *
   * On testing, the revision never took traffic, so testing is still on the
   * previous one and a revert would put back something that was never there.
   * The issue filed for it is the SRE's (`diagnoseDeploy`): it reads the run
   * and says there what broke. A failed testing deploy filed for a person
   * alone sat until somebody read a run the SRE could have read, and a broken
   * deploy workflow is a file it can fix by pull request.
   * On production, a promote that stopped where OpenADLC cannot undo it alone
   * says what it did and what is left (`note`), and that issue is a person's.
   * Each environment has its own title and marker, so a production failure is
   * not taken for a testing one already filed for the same commit.
   */
  private async reportDeployFailure(
    repoName: string,
    sha: string,
    runUrl: string | null,
    production: { environment: 'production'; note: string } | null = null,
  ): Promise<void> {
    const repo = await repos.getRepoByName(repoName);
    if (!repo) return;

    const automation = await automationBotName(this.config);
    const client = await this.automation['actors'].asBot(automation);
    if (!client) {
      console.warn(
        `[bridge] the ${production ? 'production' : 'testing'} deploy failed at ${sha.slice(0, 8)}, but nothing was filed: ` +
          `no credential for ${automation}. Run: fleetadlc auth login --bot ${automation}`,
      );
      return;
    }

    // The same marker convention the scheduled jobs use, so a re-delivered
    // webhook or a re-run workflow does not file a second copy. A deploy that
    // fails tends to fail again on the retry.
    const kind = production ? 'deploy-failed-production' : 'deploy-failed';
    const marker = dedupeMarker(kind, sha.slice(0, 8));
    // With no deploy bot in the crew, a failed testing deploy is a person's too.
    const sre = production ? null : ((await bots.listBots().catch(() => [])).find((bot) => bot.role === 'deploy') ?? null);

    let filed: number | null = null;
    try {
      // One failed deploy is two deliveries — its `deployment_status` and its
      // `workflow_run` — and handled together both read the open issues before
      // either had filed, and both filed. The read and the filing are one step
      // under a lock every bridge shares, and the read is every page. Only the
      // delivery that filed starts the SRE, so the two start one task.
      filed = await withAdvisoryLock(`${kind}:${repo.fullName}@${sha.slice(0, 8)}`, async (): Promise<number | null> => {
        // Only an issue the automation account filed: the marker is built from
        // a public commit, and a stranger's issue carrying it kept the
        // failure from being filed.
        if (await findOwnOpenIssue(client, repo.fullName, await this.automationLogin(), kind, sha.slice(0, 8))) return null;

        if (production) {
          await client.createIssue(repo.fullName, {
            title: `The production deploy failed at ${sha.slice(0, 8)}`,
            body: [
              '### Outcome',
              '',
              production.note,
              '',
              runUrl ? `The run: ${runUrl}` : '',
              '',
              '### Acceptance criteria',
              '',
              '- Production is known to serve a healthy release, and which one.',
              '- The cause is named: the build, a migration, the deploy, the traffic shift, or the environment itself.',
              '',
              '### Expected paths',
              '',
              '- .github/workflows',
              '',
              '### Verification',
              '',
              'A later promote reaches production and its smoke passes.',
              '',
              marker,
            ]
              .filter((line) => line !== '')
              .join('\n'),
            labels: ['adlc:build', 'priority:p1', 'area:general', 'do:human'],
          });
          return null;
        }

        const created = await client.createIssue(repo.fullName, {
          title: `The testing deploy failed at ${sha.slice(0, 8)}`,
          body: [
            '### Outcome',
            '',
            `The \`deploy-testing\` run for \`${sha.slice(0, 8)}\` failed, so that revision never reached testing.`,
            'Testing is still serving whatever was there before, which is why this is an issue and not a revert:',
            'there is nothing on the environment to take back, and reverting `main` would be a second change',
            'for a commit whose only fault is that the deploy did not run.',
            '',
            sre ? `${sre.name} reads the run and says here what broke.` : '',
            '',
            runUrl ? `The run: ${runUrl}` : '',
            '',
            '### Acceptance criteria',
            '',
            '- The cause is named: the change, a deploy workflow in this repository, or what no file fixes (a runner, a secret, the environment\'s settings).',
            '- A change that broke it is sent back to build; a broken deploy workflow is fixed by a pull request that closes this issue;',
            '  anything else says the exact thing a person has to do.',
            '',
            '### Expected paths',
            '',
            '- .github/workflows',
            '',
            '### Verification',
            '',
            'A later push to `main` deploys to testing and the smoke passes.',
            '',
            marker,
          ]
            .filter((line) => line !== '')
            .join('\n'),
          labels: ['adlc:build', 'priority:p1', 'area:general', sre ? 'do:ai' : 'do:human'],
        });
        return created?.number ?? null;
      });
    } catch (error) {
      console.warn(
        `[bridge] could not file the deploy failure: ${error instanceof Error ? error.message : error}`,
      );
    }
    if (filed && sre) await this.diagnoseDeploy(repo, sha, filed, sre.name);
  }

  /**
   * The SRE's task on a failed testing deploy's issue, on its own
   * `system/deploy-path-<sha>` branch: from it a broken deploy workflow is
   * fixed by pull request, and a send-back from it goes to the change that
   * commit merged (`SendBack.request`). A start the bot cannot make yet is
   * recorded, for the recovery to start again; one that was not even
   * recorded leaves the issue to a person.
   */
  private async diagnoseDeploy(repo: { name: string; fullName: string }, sha: string, issueNumber: number, bot: string): Promise<void> {
    const subjectRef = `${repo.name}#${issueNumber}`;
    const opened = await this.taskService
      .open({
        bot,
        repo: repo.name,
        kind: 'deploy',
        subjectType: 'issue',
        subjectRef,
        skill: 'deploy',
        branch: `${DEPLOY_PATH_BRANCH_PREFIX}${sha.slice(0, 8)}`,
        // A failed deploy is heard once; nothing sweeps for it.
        whenBlocked: 'record',
      })
      .catch((error: unknown) => {
        console.warn(`[bridge] ${subjectRef}: the SRE was not started on the failed testing deploy: ${error instanceof Error ? error.message : error}`);
        return null;
      });
    if (opened) return;
    await this.automation.addLabels(repo.fullName, issueNumber, ['do:human']).catch(() => undefined);
  }
}

/**
 * Why a review sent the work back, as the record on the issue says it: the
 * review's own words, markers out, cut short, and where to read the rest.
 */
function reviewReason(review: { body?: string | null; html_url?: string }): string {
  const said = withoutMarker(review.body ?? '').replace(/<!--[\s\S]*?-->/g, '').trim();
  const short = said.length > 600 ? `${said.slice(0, 599).trimEnd()}…` : said;
  return [short || 'changes were requested', review.html_url ? `The review: ${review.html_url}` : ''].filter(Boolean).join('\n\n');
}

/**
 * What a person wrote in a reply to a question, without what they quoted of it.
 *
 * GitHub's "Quote reply" puts the question's comment above the answer as `>`
 * lines, so "2" arrived as the quoted question and then a 2, which matched no
 * choice and became the answer word for word. A reply that is nothing but a
 * quote is left as it is.
 */
export function ownWords(reply: string): string {
  const own = reply
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .join('\n')
    .trim();
  return own || reply.trim();
}

/** The environments the deploy path drives, and the label each one leaves. */
const DEPLOY_LABELS: Record<string, string> = {
  testing: 'deployed:testing',
  production: 'deployed:prod',
};

interface DeploymentOutcome {
  environment: 'testing' | 'production';
  /** `deployed:testing` or `deployed:prod`. */
  label: string;
  sha: string;
  succeeded: boolean;
  /** Where the change is live: the job's `environment.url`, as GitHub sends it. Null when the deploy reported none. */
  revisionUrl: string | null;
  /** The workflow run that deployed it, which is a log and never where the change is live. */
  runUrl: string | null;
}

/**
 * What a `deployment_status` delivery means, or nothing at all.
 *
 * GitHub sends one of these for every state a deployment passes through, and
 * most of them are the deploy still happening. Only `success` and the two ways
 * of failing are verdicts; acting on `in_progress` would label a pull request
 * as live somewhere the moment a deploy started.
 *
 * An environment nobody named is nothing to do with the platform — a preview
 * environment, a third-party integration — so it returns nothing rather than
 * guessing a label for it.
 */
export function deploymentOutcome(payload: {
  deployment?: { sha?: string; environment?: string };
  deployment_status?: {
    state?: string;
    environment?: string;
    environment_url?: string | null;
    target_url?: string | null;
  };
}): DeploymentOutcome | null {
  const status = payload.deployment_status;
  const sha = payload.deployment?.sha ?? '';
  if (!status || !sha) return null;

  // `error` is a deploy that threw and `failure` is one that reported failing.
  // They are the same news.
  const succeeded = status.state === 'success';
  if (!succeeded && status.state !== 'failure' && status.state !== 'error') return null;

  const environment = status.environment ?? payload.deployment?.environment ?? '';
  // Own keys only: `constructor` found Object's, a function, and commented
  // "Live on constructor" on every pull request of the commit.
  const label = Object.hasOwn(DEPLOY_LABELS, environment) ? DEPLOY_LABELS[environment] : undefined;
  if (!label) return null;

  // `environment_url` is what the job's `environment.url` carried, which is the
  // revision. `target_url` is the run that deployed it: worth linking as the
  // run, but never as the revision. Read as one, a template deploy that set no
  // `environment.url` said "Live on testing" with a link to its Actions log.
  return {
    environment: environment as 'testing' | 'production',
    label,
    sha,
    succeeded,
    revisionUrl: status.environment_url || null,
    runUrl: status.target_url || null,
  };
}

/**
 * The commit a production promote deployed, from its run's name.
 *
 * `promote-production.yml` names each run `promote-production <candidate>`:
 * the deployment GitHub creates for its job carries the workflow's commit —
 * the default branch's tip when it was dispatched — and a delivery carries no
 * dispatch inputs, so the run's name is where the candidate survives. Only a
 * commit id is taken, as the workflow requires of `candidate`. A promote past
 * the testing check is named `promote-production <candidate> (emergency
 * override)`: anchored on the plain name, its pull requests were never
 * finished.
 */
export function promotedCandidate(
  run: { name?: string | null; display_title?: string | null } | null | undefined,
): string | null {
  // The promote's own run only. A run's name is anybody's words on any other
  // workflow — a push run is named for its head commit's headline, which a
  // squash merge takes from a pull request's title — so a title shaped like
  // this would otherwise finish the pull requests of whatever commit it named.
  if (!/promote-production/i.test(run?.name ?? '')) return null;
  const found = PROMOTE_RUN_NAME.exec(run?.display_title?.trim() ?? '');
  return found?.[1]?.toLowerCase() ?? null;
}

/** What `promote-production.yml` names its runs: the candidate, and whether a person overrode the testing check. */
const PROMOTE_RUN_NAME = /^promote-production ([0-9a-f]{7,40})( \(emergency override\))?$/i;

/** Whether a promote's run is named as an emergency override of the testing check. */
export function promoteOverridden(run: { name?: string | null; display_title?: string | null } | null | undefined): boolean {
  if (promotedCandidate(run) === null) return false;
  return Boolean(PROMOTE_RUN_NAME.exec(run?.display_title?.trim() ?? '')?.[2]);
}

/**
 * The commit a testing deploy, or the smoke after it, ran for, from the run's
 * name; null when the run carries none.
 *
 * The bridge dispatches `deploy-testing` on the default branch with the merged
 * commit as `sha`, and GitHub records the deployment at the workflow's own
 * commit: the branch's tip when it was dispatched, which is another merge's
 * once two land close together. Read from the deployment, the wrong pull
 * request was labelled `deployed:testing` and verified, and its smoke reverted
 * or promoted a commit that was not the one deployed. So `deploy-testing.yml`
 * names each run `deploy-testing <sha>`, and `smoke-testing.yml` names its own
 * for that run (`smoke-testing of deploy-testing <sha>`, since an expression
 * cannot cut the commit out of a name; `smoke-testing <sha>` is read too).
 * A run of an older template has no such name, and its commit is read as it
 * always was.
 */
export function testedCandidate(
  run: { name?: string | null; display_title?: string | null } | null | undefined,
  workflow: 'deploy-testing' | 'smoke-testing',
): string | null {
  // That workflow's own run only, as for the promote: a title is anybody's
  // words on any other workflow (`promotedCandidate`).
  if (!new RegExp(workflow, 'i').test(run?.name ?? '')) return null;
  const title = run?.display_title?.trim() ?? '';
  const found =
    workflow === 'deploy-testing'
      ? /^deploy-testing ([0-9a-f]{7,40})$/i.exec(title)
      : /^smoke-testing (?:of deploy-testing )?([0-9a-f]{7,40})$/i.exec(title);
  return found?.[1]?.toLowerCase() ?? null;
}

/** The commit a smoke on testing ran for: the one its name carries (`testedCandidate`), or else its run's own. */
function smokedCommit(run: { head_sha: string; name?: string | null; display_title?: string | null }): string {
  return testedCandidate(run, 'smoke-testing') ?? run.head_sha;
}

/** Commits asked for per page of a promote's compare: GitHub's largest page. */
const PROMOTE_PAGE = 100;

/** A production deployment's promote, recorded for `walkPromotes` to finish. */
const PROMOTE_QUEUED = 'deploy.promote_queued';

/** How long a queued promote that keeps failing is tried before it is given up on. */
const PROMOTE_GIVE_UP_MS = 24 * 3600 * 1000;

/** The most pages of a promote's compare read: ten thousand commits. Past it, the list is incomplete. */
const PROMOTE_MAX_PAGES = 100;

/** Held while promotes are walked, by whichever bridge is walking them. */
const PROMOTE_LOCK = 'bridge:promote-walk';

interface QueuedPromote {
  repo: string;
  repoFullName: string;
  candidate: string;
  /** The promote's own run, so the run is not read as the promote before it. */
  runId: number | null;
  label: string;
  revisionUrl: string | null;
  /** Absent on one queued before the run was kept apart from the revision. */
  runUrl?: string | null;
}

/** A promote this finished, as `deploy.promoted` records it. */
interface FinishedPromote {
  candidate: string;
  /** Null for one recorded before runs were: its candidate is what is compared. */
  runId: number | null;
}

/** The last promote finished in a repository, as recorded. */
/** The commit testing served before, as the bridge last heard it (`DEPLOYED_TO_TESTING`), or nothing. */
async function lastOnTesting(repoName: string): Promise<string | null> {
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const found = (await listEventsOfType(DEPLOYED_TO_TESTING, since))
    .map((event) => event.payload as { repo?: string; sha?: string })
    .find((payload) => payload.repo === repoName && payload.sha);
  return found?.sha ?? null;
}

async function lastPromoted(repoName: string): Promise<FinishedPromote | null> {
  const since = new Date(Date.now() - 365 * 24 * 3600 * 1000);
  const found = (await listEventsOfType('deploy.promoted', since))
    .map((event) => event.payload as { repo?: string; candidate?: string; runId?: number | null })
    .find((payload) => payload.repo === repoName && payload.candidate);
  return found?.candidate ? { candidate: found.candidate, runId: typeof found.runId === 'number' ? found.runId : null } : null;
}

/**
 * A production promote that has just been asked for, and the commit it was
 * asked for at — or nothing.
 *
 * `workflow_run` with `requested`: of the events the app subscribes to
 * (`WEBHOOK_EVENTS`), it is the one that arrives before the promote runs.
 * `deployment_status` says it more directly, but only once the promote has
 * run, which is too late to ask QA first.
 * The job names the `production` environment, whose required reviewer is a
 * person, so at this moment the run is waiting for them and has done nothing.
 *
 * The commit is the candidate the run's name carries (`promotedCandidate`), or,
 * for a run named otherwise, the one it was dispatched at: the tip of the
 * default branch. A delivery does not carry a dispatch's inputs. The QA run
 * checks testing, whichever revision that is serving, so the commit is what
 * names the run rather than what it tests.
 *
 * `override` is a run named as an emergency override of the workflow's
 * testing check, and `actor` who started it (`triggering_actor`): the
 * workflow refuses the override to anyone but a person with admin or
 * maintain, and the bridge records who it was.
 */
export function promoteRequested(
  payload: {
    action?: string;
    workflow_run?: PromoteRun;
  },
  repo: { defaultBranch: string; fullName: string },
  workflows: readonly string[] = [PROMOTE_WORKFLOW],
): PromoteRequest | null {
  const run = payload.workflow_run;
  if (payload.action !== 'requested' || !run?.head_sha) return null;
  if (!isWorkflow(run.name, workflows)) return null;
  if (promoteRefusal(run, repo, workflows)) return null;
  return {
    sha: promotedCandidate(run) ?? run.head_sha,
    runUrl: run.html_url ?? null,
    override: promoteOverridden(run),
    actor: run.triggering_actor?.login ?? run.actor?.login ?? null,
  };
}

interface PromoteRequest {
  sha: string;
  runUrl: string | null;
  override: boolean;
  actor: string | null;
}

/** A smoke run on testing, as the revert and the pipeline read it. */
type SmokeRun = {
  head_sha: string;
  name?: string;
  display_title?: string | null;
  html_url?: string;
  event?: string;
  head_branch?: string | null;
  head_repository?: { full_name?: string } | null;
};

type PromoteRun = {
  name: string;
  head_sha: string;
  html_url?: string;
  display_title?: string | null;
  event?: string;
  head_branch?: string | null;
  head_repository?: { full_name?: string } | null;
  path?: string;
  triggering_actor?: { login?: string } | null;
  actor?: { login?: string } | null;
};

/**
 * Why a run named like the promote is not one, or null when it is: dispatched
 * by hand on the default branch, of the repository's own promote workflow
 * file. A workflow of that name requested on a pull request's branch started a
 * paid QA run and told the operator a production promote waited for them.
 */
export function promoteRefusal(run: Omit<PromoteRun, 'head_sha' | 'name'>, repo: { defaultBranch: string; fullName: string }, workflows: readonly string[] = [PROMOTE_WORKFLOW]): string | null {
  const refused = runOriginRefusal(run, repo, { what: 'promote', events: ['workflow_dispatch'] });
  if (refused) return refused;
  const files = workflows.map((name) => `.github/workflows/${workflowFile(name)}`);
  return run.path && files.includes(run.path) ? null : `the promote ran from ${run.path ?? 'no workflow file'}, not ${files.join(' or ')}`;
}

/** The templates' own workflow names, which a repository's rules may add to. */
const PROMOTE_WORKFLOW = 'promote-production';
const DEPLOY_WORKFLOW = 'deploy-testing';

/** Whether a run is of one of these workflows, by its name exactly; a rules entry may carry its file's `.yml`. */
function isWorkflow(name: string, workflows: readonly string[]): boolean {
  return workflows.some((workflow) => workflow.replace(/\.ya?ml$/, '') === name);
}

/**
 * Whether a finished run means the change that reached testing does not work.
 *
 * Only the smoke. A smoke failure says a revision **deployed** and then failed
 * to do its job, which is the one situation the revert answers.
 *
 * This used to be `(deploy|smoke)-testing`, and the argument for the wider form
 * was that a failed deploy also leaves testing wrong. It does — but not in a way
 * reverting `main` fixes. A build that failed, a migration that failed, or a
 * runner that died all mean the commit **never reached testing**: the
 * environment is still serving the previous revision and is fine, and the revert
 * would be of a commit whose only fault is that the deploy did not run. That is
 * a second change on `main` during an incident, for no gain.
 */
export function smokeFailedOnTesting(run: { name: string; conclusion: string | null } | undefined): boolean {
  if (!run || run.conclusion !== 'failure') return false;
  return /smoke-testing/i.test(run.name);
}

/**
 * Whether an open answered with a task that was recorded failed and never
 * handed to hostd: a prerequisite missing (`TaskService.recordBlocked`).
 * That task never ran, so what it was authorised to spend is still unspent.
 *
 * A start hostd refused is not one of these, whatever the refusal says. A
 * `fetch failed` may be a session hostd began before its answer was lost,
 * and running it again past a cap could be a second run; so a failed read
 * counts as started too.
 */
async function recordedUnstarted(opened: { taskId: string; error?: string }): Promise<boolean> {
  if (!opened.error) return false;
  const task = await tasks.getTask(opened.taskId).catch(() => null);
  return Boolean(task && task.state === 'failed' && !/^hostd refused:/i.test(task.exitReason ?? ''));
}

/** The platform event a successful testing deployment leaves, which a revert is checked against. */
const DEPLOYED_TO_TESTING = 'deploy.testing_live';

/** How far back a testing deployment still counts for a red smoke's revert. */
const DEPLOYED_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Why a run may not be acted on as the repository's own smoke, promote or
 * deploy, or null when it may: it ran on the default branch, not for a pull
 * request, of the repository's own commit, and, where `events` are named,
 * was started by one of them. Each of these workflows is a file in the
 * repository, and one committed on a pull request's branch, or a fork's,
 * runs there under the same name, red whenever its author likes. One check,
 * so the rules for the three cannot drift apart.
 */
export function runOriginRefusal(
  run: { event?: string; head_branch?: string | null; head_repository?: { full_name?: string } | null },
  repo: { defaultBranch: string; fullName?: string },
  options: { what: string; events?: readonly string[] },
): string | null {
  const { what } = options;
  if (run.event === 'pull_request' || run.event === 'pull_request_target') return `the ${what} ran for a pull request (${run.event})`;
  if (options.events && !options.events.includes(run.event ?? '')) {
    return `the ${what} was started by ${run.event ?? 'nothing it names'}, not ${options.events.join(' or ')}`;
  }
  if (run.head_branch !== repo.defaultBranch) return `the ${what} ran on ${run.head_branch ?? 'no branch'}, not on ${repo.defaultBranch}`;
  const from = run.head_repository?.full_name;
  if (repo.fullName && from && from.toLowerCase() !== repo.fullName.toLowerCase()) return `the ${what} ran on ${from}'s commit, a fork's`;
  return null;
}

/** Why a red smoke run may not ask for a revert, or null when it may; see `runOriginRefusal`. */
export function smokeRevertRefusal(
  run: { event?: string; head_branch?: string | null; head_repository?: { full_name?: string } | null },
  defaultBranch: string,
  fullName?: string,
): string | null {
  return runOriginRefusal(run, { defaultBranch, fullName }, { what: 'smoke' });
}

/**
 * Why a deployment may not be acted on, or null when it may: it is of the
 * default branch, and a production one was dispatched, not run for anything
 * else. A deployment's environment is whatever its workflow names, and a
 * `production` one from another branch rolled production back, sent issues
 * back to build, or finished pull requests.
 */
export function deploymentOriginRefusal(
  payload: { deployment?: { ref?: string }; workflow_run?: { event?: string } | null },
  defaultBranch: string,
  environment: 'testing' | 'production',
): string | null {
  const ref = payload.deployment?.ref ?? '';
  if (ref.replace(/^refs\/heads\//, '') !== defaultBranch) return `it is of ${ref || 'no ref'}, not ${defaultBranch}`;
  const event = payload.workflow_run?.event;
  if (environment === 'production' && event && event !== 'workflow_dispatch') return `its run was started by ${event}, not dispatched`;
  return null;
}

/**
 * Why a smoke run may not revert or reach the pipeline for who started it, or
 * null when it may.
 *
 * `workflow_run` matches deploy-testing by name, so on a repository whose
 * smoke-testing.yml has no guard, a fork's pull request could add a workflow
 * of that name and set the smoke going on the default branch's tip: red, it
 * reverted that tip past the cap; green, it promoted. Such a smoke names the
 * fork's author as the run's `triggering_actor`. OpenADLC's own dispatches
 * are the app's or the automation account's, and a person with access may
 * start one by hand; anyone else is refused, by the same rule as any other
 * delivery (`actsForOn`). An app's account is not a person and passes, as
 * the app dispatches as one. A payload with no starter named is taken as it
 * was before, so a GitHub that names nobody does not stop every promote.
 */
export async function smokeStarterRefusal(
  run: { triggering_actor?: { login: string; type?: string; id?: number } | null },
  input: {
    client: PermissionAsker | null;
    repoFullName: string;
    crew: readonly { githubLogin: string | null }[];
    humans: readonly string[];
  },
): Promise<string | null> {
  const starter = run.triggering_actor;
  if (!starter?.login || isAppAccount(starter)) return null;
  const author = { login: starter.login, association: null, id: starter.id ?? null };
  if (await actsForOn({ client: input.client, repoFullName: input.repoFullName, author, crew: input.crew, humans: input.humans })) return null;
  return `${starter.login} started it, and has no access to the repository`;
}

/**
 * Whether a finished run means the deploy path itself broke.
 *
 * Someone has to look at this, and reverting is not looking. It becomes an issue
 * rather than a revert task, because what failed is the machinery rather than
 * the change.
 */
export function deployFailedOnTesting(
  run: { name: string; conclusion: string | null } | undefined,
  workflows: readonly string[] = [DEPLOY_WORKFLOW],
): boolean {
  if (!run || run.conclusion !== 'failure') return false;
  return isWorkflow(run.name, workflows);
}

/** What became of a first failure's one rerun: asked, cannot be had, or not yet known. */
type RerunOutcome = 'rerun' | 'unavailable' | 'waiting';

/** Conclusions of a CI run that failed, rather than said nothing. */
const CI_FAILED = new Set(['failure', 'timed_out']);

/** A pull request's CI run that finished, as `onCiRun` reads it. */
interface CiRunOutcome {
  runId: number;
  sha: string;
  attempt: number;
  outcome: 'passed' | 'failed';
  pullRequests: number[];
}

/**
 * The CI workflow finishing, or null for any other run. The workflow is the
 * one named for the required check (`ci`), whose aggregate job is what a
 * ruleset requires. A run cancelled or skipped said nothing, and is neither.
 */
function ciRunOutcome(payload: {
  action?: string;
  workflow_run?: { id?: number; name: string; conclusion: string | null; head_sha: string; run_attempt?: number; pull_requests?: { number: number }[] };
}): CiRunOutcome | null {
  const run = payload.workflow_run;
  if (payload.action !== 'completed' || !run?.id || run.name.toLowerCase() !== REQUIRED_CHECK) return null;
  const outcome = run.conclusion === 'success' ? 'passed' : run.conclusion === 'failure' || run.conclusion === 'timed_out' ? 'failed' : null;
  if (!outcome) return null;
  return {
    runId: run.id,
    sha: run.head_sha,
    attempt: run.run_attempt ?? 1,
    outcome,
    pullRequests: (run.pull_requests ?? []).map((pull) => pull.number),
  };
}

/**
 * The paths a revert leaves alone.
 *
 * Migrations are expand-only, and one that reached testing has already run
 * against that database. Reverting the file does not un-run it; it produces a
 * schema the code no longer describes and a migration number that is free to be
 * reused, which is how two different migrations end up sharing one number.
 *
 * Any `migrations/` directory, not only one at the root: a repository keeps
 * them in `db/migrations/` or `packages/db/migrations/` as often, and a
 * root-only path restored nothing there and failed with "pathspec did not
 * match". Read with git's `glob` magic, where the leading `**` also matches
 * no directory at all, so the root's `migrations/` is one of them.
 *
 * The deploy skill (`crew/skills/deploy/SKILL.md`) restores these paths
 * itself, since it is what runs `git revert`; this list is what the reopened
 * issue tells people. The test "says so in the skill that performs the
 * revert" keeps the two in step.
 */
export const REVERT_EXCLUDES = ['**/migrations/**'] as const;

/** Where it has always been imported from; it lives in `work.ts`, which the scheduler can import too. */
export { issueNumberFromBranch };
