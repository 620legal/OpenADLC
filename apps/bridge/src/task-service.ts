import { audit, bots, costs, hasEventOfType, health, hosts, lastEventAt, leases, recordEvent, repos, spendingLimits, tasks, threads } from '@fleetadlc/db';
import { attachmentsForTask } from './attachment-routes.js';
import { botAtStart, headerFor, leaseExpiryFrom, maxTasksOf, resolveBotRef, type ContextDocument, type Task, type TaskKind } from '@fleetadlc/shared';
import type { BridgeConfig } from './config.js';
import type { Context } from './context.js';
import { effectiveConfig } from './effective-config.js';
import { asAutomation } from './automation-bot.js';
import { alreadyLanded, endsWithSubject, subjectClosed, wasRefused } from './gates.js';
import { blockersOf, waitingOnBlocked, type Blocker } from './health/checks/crew.js';
import type { HostdClient, ReviewMode } from './hostd-client.js';
import { reviewRulesOf } from './automation.js';
import { requestPrefixOf } from './request-context.js';
import { readSeatPauses, seatPausedWords, type SeatPause } from './seat-pause.js';
import { heldWords } from './item-hold.js';
import { REVIEW_ASKED_AGAIN, REVIEW_ROUND_OPENED } from './work.js';

/**
 * A seat running all the tasks it may at once (`bots.max_tasks`, Crew →
 * "tasks at once"). Each of its tasks has a computer of its own; how many run
 * together is the seat's number, and a sweep that comes back for the work
 * starts it when one ends.
 */
export class BotBusyError extends Error {
  readonly status = 409;

  constructor(bot: string, maxTasks = 1, message?: string) {
    super(
      message ??
        `${bot} is running ${maxTasks === 1 ? 'a task' : `${maxTasks} tasks`}, all it may run at once; ` +
          'it starts this when one ends, or raise its tasks at once on the Crew page',
    );
    this.name = 'BotBusyError';
  }
}

/**
 * The same work already running on the seat: the same subject, by the same
 * seat, queued or running (`tasks_one_live_per_bot_subject`). With one task
 * per seat a second start was refused as busy; with several it would have
 * been a second review of one pull request. Busy, so every caller that comes
 * back for busy work comes back for this.
 */
export class SubjectBusyError extends BotBusyError {
  constructor(bot: string, subjectRef: string) {
    super(bot, 1, `${bot} is already working on ${subjectRef}; it is not started twice`);
    this.name = 'SubjectBusyError';
  }
}

/**
 * Every host running all the tasks it has room for (`hosts.capacity_tasks`).
 * Nothing is recorded as failed: it is busy work, tried again as a busy
 * seat's is.
 */
export class HostFullError extends BotBusyError {
  constructor(bot: string) {
    super(
      bot,
      1,
      `${bot} was not started: every host is running all the tasks it has room for, and this starts when one ends. ` +
        'Give the host more with FLEETADLC_HOST_CAPACITY_TASKS, or move it to a larger machine',
    );
    this.name = 'HostFullError';
  }
}

/** Whether hostd refused a start or a resume for want of room (`HostFull`, answered 503). */
function hostWasFull(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return status === 503 && /all it has room for/.test(error instanceof Error ? error.message : String(error));
}

/** Whether a task row was refused by `tasks_one_live_per_bot_subject`: the same work, started twice at once. */
function sameWorkTwice(error: unknown): boolean {
  const failure = error as { code?: string; constraint?: string } | null;
  return failure?.code === '23505' && failure.constraint === 'tasks_one_live_per_bot_subject';
}

/** How often, and how many times, a resume a full host refused is tried again before the task is failed with why. */
const RESUME_RETRY_MS = 60_000;
const RESUME_RETRIES = 60;
/** How long after its answer a task waits for a host with room, counted from the answer, so a restart does not start the hour again. */
const RESUME_WAIT_MS = RESUME_RETRIES * RESUME_RETRY_MS;

/** A piece of work a person held on the board (`item-hold.ts`): nothing new starts on it until it is resumed. */
export class ItemHeldError extends Error {
  readonly status = 409;

  constructor(words: string) {
    super(words);
    this.name = 'ItemHeldError';
  }
}

/**
 * A bot that cannot do the task yet: its GitHub sign-in is not working, it is
 * not in the repository, or hostd is not answering. Nothing is recorded, so
 * no failed task lands on the board beside the card that already says what to
 * do; a sweep that comes back for the work starts it once the check passes.
 * Work nothing comes back for is recorded instead (`whenBlocked: 'record'`).
 * See `TaskService.blocked`.
 */
export class PrerequisiteNotReadyError extends Error {
  readonly status = 409;

  constructor(
    bot: string,
    readonly blockers: readonly Blocker[],
  ) {
    super(
      `${bot} was not started: ${blockers.map((blocker) => blocker.why).join(' and ')}. ` +
        blockers
          .map((blocker) => blocker.instruction)
          .filter(Boolean)
          .join(' '),
    );
    this.name = 'PrerequisiteNotReadyError';
  }
}

/**
 * A usage report the bridge will not write. A task's session reports its own
 * engine calls with its task token, which the engine and every command it
 * runs can read: a report of -1000 cancelled every cap's spend, "NaN" stopped
 * the budget for good, and another engine's name dodged a provider cap.
 */
export class UsageRefusedError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'UsageRefusedError';
  }
}

/** A usage report's fields, as a session sends them. */
export interface UsageReport {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  engine: string;
  model: string;
  modelAlias?: string | null;
}

/**
 * What is wrong with a usage report's fields, or null when a real engine call
 * could have made it. `typeof` comes first: the string "NaN" reaches Postgres
 * numeric as NaN, which sorts above every number.
 */
export function usageProblem(input: Record<string, unknown>): string | null {
  const count = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0;
  if (!count(input.tokensIn)) return 'tokensIn must be a whole number at least 0';
  if (!count(input.tokensOut)) return 'tokensOut must be a whole number at least 0';
  if (typeof input.costUsd !== 'number' || !Number.isFinite(input.costUsd) || input.costUsd < 0) return 'costUsd must be a number at least 0';
  if (typeof input.engine !== 'string' || input.engine.trim() === '') return 'engine must name the engine that ran';
  if (typeof input.model !== 'string' || input.model.trim() === '') return 'model must be the resolved model id';
  if (input.modelAlias !== undefined && input.modelAlias !== null && (typeof input.modelAlias !== 'string' || !input.modelAlias.startsWith('newest:'))) {
    return 'modelAlias must be a newest: alias, or left out';
  }
  return null;
}

/**
 * A new task a monthly spending cap refuses: the global month total (unless
 * `onCap.stopLeasing` is false), or a repository's, a bot's or a provider's.
 *
 * Its words say what was held and what lets it go, and they are what a task
 * recorded for it keeps as its reason: `heldAtCap` reads them back, and the
 * recovery runs such a task again once the cap allows it
 * (`retryAfterRecovery`). A queued console request refused this way waits in
 * line without spending an attempt (`request-queue.ts`).
 */
export class SpendingCapError extends Error {
  readonly status = 409;

  constructor(
    bot: string,
    /** The cap's own words, from `spendingLimits.refusal`. */
    readonly refusal: string,
  ) {
    super(
      `${bot} was held at a spending cap: ${refusal}. It starts on its own once the cap allows it: ` +
        'raise the cap in Settings → Spending limits, or wait for the month to roll over.',
    );
    this.name = 'SpendingCapError';
  }
}

/** Whether a task's reason says it was recorded, not started, because a spending cap refused it. */
export function heldAtCap(reason: string | null | undefined): boolean {
  return /^\S+ was held at a spending cap: /.test(reason ?? '');
}

/**
 * The branch a revert after a red smoke test works on (`Webhooks.revertTesting`).
 */
export const REVERT_BRANCH_PREFIX = 'system/revert-';

/**
 * Whether this task is a revert after a red smoke test, by its shape. The
 * shape alone lets nothing past a cap: that takes `bypassCap`, which only
 * the red smoke's handler and a person's Try again pass.
 */
export function isRevert(input: { kind: TaskKind; subjectType: string; branch?: string | null }): boolean {
  return input.kind === 'deploy' && input.subjectType === 'merge' && Boolean(input.branch?.startsWith(REVERT_BRANCH_PREFIX));
}

/**
 * Leave to start one task past a monthly cap, and who gave it.
 *
 * The decision: a revert after a red smoke test is safety work. Held
 * at a cap, a deploy that broke testing would stay live until somebody raised
 * the cap or the month rolled over. So the first revert of a commit starts
 * past a monthly cap — the bridge authorises it once per commit, after
 * checking the smoke ran on the default branch against a commit it saw
 * deployed (`Webhooks.revertTesting`, `spendingLimits.authorizeRevert`) —
 * and a person may run a revert again past the cap from its card
 * (`retryTask`). The recovery's automatic retry never passes it. Each start
 * is audited as `spending.cap_bypassed`, naming `by`, and said in the task's
 * thread; its own per-task cap still stops it.
 *
 * It was the task's shape once, and a red smoke could be asked for again and
 * again — a re-run, a workflow on a pull request's branch — each asking for
 * another revert past the cap.
 */
export interface CapBypass {
  /** `bridge` for the authorised first revert, or the person who pressed Try again. */
  by: string;
  /** Why, as the audit entry and the thread say it. */
  why: string;
}

/**
 * A bot's queue: what a rename holds while the bot's computer, row and
 * secrets move to a new name. See `BotNames.withBot`.
 */
export interface BotQueue {
  withBot<T>(botId: string, fn: () => Promise<T>): Promise<T>;
}

const UNQUEUED: BotQueue = { withBot: (_botId, fn) => fn() };

/** Whether GitHub says an issue or pull request is closed; see `subjectClosed`. */
export type SubjectClosed = (repoFullName: string, number: number) => Promise<boolean>;

/**
 * When a lease put back in task should expire if no pull request is linked to
 * it: as long from now as the dispatcher leases an issue for
 * (`FLEETADLC_LEASE_HOURS`, twelve by default).
 */
export function leaseHoldUntil(now = new Date()): Date {
  return leaseExpiryFrom(now);
}

/**
 * What a task's end does to its lease. A lease a gate paused is let go once
 * nothing under it is unfinished, or put back in task when a pull request is
 * open for its issue, or the work finished and its pull request may still be
 * on its way (`leases.settlePausedLeases`). A lease that is not paused is left to the
 * rules it is already under: its pull request, the idle-lease check, its
 * expiry.
 *
 * Never a reason for the caller to fail: the reconciler's sweep catches what
 * this misses.
 */
export async function settleLeaseAfter(task: Pick<Task, 'leaseId' | 'state' | 'subjectRef'>): Promise<void> {
  if (!task.leaseId || !['done', 'failed', 'stopped'].includes(task.state)) return;
  try {
    const { released, held } = await leases.settlePausedLeases({
      leaseId: task.leaseId,
      actor: 'bridge',
      reason: `its task on ${task.subjectRef} ${task.state === 'done' ? 'finished' : task.state}`,
      holdUntil: leaseHoldUntil(),
    });
    if (released.length > 0) console.log(`[bridge] released the paused lease on ${task.subjectRef}: its task ${task.state}`);
    if (held.length > 0) console.log(`[bridge] the lease on ${task.subjectRef} waits for its pull request again`);
  } catch (error) {
    console.warn(`[bridge] could not settle the lease on ${task.subjectRef}: ${error instanceof Error ? error.message : error}`);
  }
}

/** What a task's context is built from, at open and at resume. */
interface ContextRequest {
  kind: TaskKind;
  /** The repository's name, which a QA task's testing URL is looked up by. */
  repoName?: string | null;
  repoFullName: string | null;
  subjectRef: string;
  issueNumber?: number | null;
  /** The bot's own login, which a reviewer's earlier reviews are posted under. */
  reviewer?: string | null;
  reviewerSeat?: string | null;
  /** A review task's part; the lead is given every review of this round. */
  reviewMode?: ReviewMode;
}

/**
 * Opening a task is two steps that must not drift: a row that says what the bot
 * is doing, and a session on the bot's computer doing it. If hostd refuses, the
 * row is marked failed rather than left claiming to be running.
 */
export class TaskService {
  constructor(
    private readonly config: BridgeConfig,
    private readonly hostd: HostdClient,
    private readonly context: Context,
    /**
     * Taken while a task is opened or resumed, so none starts on a container
     * that is half-way to being called something else. A rename refuses a bot
     * with a task queued or running, so once the row exists the bot keeps its
     * name until the task ends.
     */
    private readonly names: BotQueue = UNQUEUED,
    /**
     * Asks GitHub whether a task's subject has closed, before a paused task is
     * resumed. Absent, it is read as the automation account, through the
     * actors the context reads with.
     */
    private readonly closed?: SubjectClosed,
  ) {}

  /** The seats a person paused from Crew; see `seat-pause.ts`. Replaced in tests. */
  seatPauses: () => Promise<Record<string, SeatPause>> = () => readSeatPauses();

  /**
   * Why work may not start in a repository now (`DispatchGate.paused`), or
   * null. Only the sweep of answered tasks asks it; `main.ts` wires the gate.
   */
  workPaused: (repoName: string | null) => string | null = () => null;

  /** Whether a subject is closed on GitHub. Not when it cannot be read: the task resumes as it would have. */
  private async subjectIsClosed(repoFullName: string, number: number): Promise<boolean> {
    try {
      if (this.closed) return await this.closed(repoFullName, number);
      const client = await asAutomation(this.context['actors'], this.config);
      return client ? await subjectClosed(client, repoFullName, number) : false;
    } catch {
      return false;
    }
  }

  /**
   * The subject of the task, read from GitHub. A task opened without it runs
   * blind, so this is gathered for every task that has one and only skipped
   * when there is nothing to read.
   */
  private async contextFor(input: ContextRequest): Promise<ContextDocument[]> {
    // Where a QA task tests, at open and at resume alike: `extraContext` is not
    // kept for a resume, and `<repo>#testing` subjects have no number below.
    const qa =
      input.kind === 'qa' && input.repoName
        ? await Promise.resolve()
            .then(() => this.context.forQa({ repoName: input.repoName!, subjectRef: input.subjectRef }))
            .catch((error: unknown) => {
              console.warn(`[bridge] no testing URL for ${input.subjectRef}: ${error instanceof Error ? error.message : error}`);
              return null;
            })
        : null;
    if (qa) return [qa, ...(await this.subjectContext(input))];
    return this.subjectContext(input);
  }

  private async subjectContext(input: ContextRequest): Promise<ContextDocument[]> {
    // A request from the console has no issue yet, so its subject is not a
    // number on GitHub: it is read from the request, at open and at resume.
    if (requestPrefixOf(input.subjectRef)) {
      return this.context.forRequest(input.subjectRef).catch((error: unknown) => {
        console.warn(`[bridge] no context for ${input.subjectRef}: ${error instanceof Error ? error.message : error}`);
        return [];
      });
    }

    const subjectNumber = Number(input.subjectRef.split('#')[1] ?? '');
    if (!input.repoFullName || !Number.isInteger(subjectNumber) || subjectNumber <= 0) return [];

    return this.context
      .forSubject({
        kind: input.kind,
        repoFullName: input.repoFullName,
        subjectNumber,
        issueNumber: input.issueNumber ?? null,
        reviewer: input.reviewer ?? null,
        reviewerSeat: input.reviewerSeat ?? null,
        lead: input.reviewMode === 'lead',
      })
      .catch((error: unknown) => {
        console.warn(`[bridge] no context for ${input.subjectRef}: ${error instanceof Error ? error.message : error}`);
        return [];
      });
  }

  /**
   * Which of these seats cannot work in the repository right now, and why, from
   * what the health checks last said. Seats that can are left out.
   *
   * Scripted engines fabricate the work and push nothing to GitHub, so what
   * GitHub would refuse decides nothing there — the integration suites run
   * them with no account behind any bot, as the dispatcher's hold allows. A
   * row that cannot be read holds nobody back: a check that has not said is
   * not a failure.
   */
  async blocked(seats: readonly { id: string; name: string }[], repoName: string | null): Promise<Map<string, Blocker[]>> {
    const blocked = new Map<string, Blocker[]>();
    if (seats.length === 0) return blocked;
    // A seat a person paused from Crew takes no new work, scripted or not: it
    // is a person's word, not something GitHub would refuse.
    const pauses = await this.seatPauses();
    for (const seat of seats) {
      const pause = pauses[seat.name];
      if (!pause) continue;
      blocked.set(seat.name, [
        { row: `seat-paused:${seat.name}`, kind: 'paused', why: seatPausedWords(seat.name, pause), instruction: `Resume it on the Crew page.` },
      ]);
    }
    if (process.env.FLEETADLC_SCRIPTED_ENGINES === '1') return blocked;
    let rows: Awaited<ReturnType<typeof health.listHealth>>;
    try {
      rows = await health.listHealth();
    } catch {
      return blocked;
    }
    for (const seat of seats) {
      const blockers = blockersOf(rows, seat, repoName);
      if (blockers.length > 0) blocked.set(seat.name, [...(blocked.get(seat.name) ?? []), ...blockers]);
    }
    return blocked;
  }

  /**
   * The words for a review gate: "waiting on lead-reviewer" becomes "waiting on
   * the reviewer account: lead-reviewer cannot sign in to GitHub" when that is
   * why nothing is coming. Any other description is returned as it was.
   */
  async gateDescription(description: string, repoName: string | null): Promise<string> {
    const named = /^waiting on (.+)$/.exec(description)?.[1]?.split(', ') ?? [];
    if (named.length === 0) return description;
    const crew = await bots.listBots().catch(() => []);
    const seats = crew.filter((bot) => named.includes(bot.name));
    return waitingOnBlocked(description, await this.blocked(seats, repoName)) ?? description;
  }

  /** Throws `PrerequisiteNotReadyError` when this bot cannot do a task in the repository yet. */
  async assertReady(bot: { id: string; name: string }, repoName: string | null): Promise<void> {
    const blockers = (await this.blocked([bot], repoName)).get(bot.name);
    if (blockers) throw new PrerequisiteNotReadyError(bot.name, blockers);
  }

  /**
   * The reviewers a pull request's gate waits on that have no review of this
   * diff, started. A reviewer whose account was connected after the pull
   * request opened had no task started for it then, and one that was busy
   * when a push opened a new round was refused and nothing recorded; either
   * way the gate would wait on it for good. A seat counts as asked on this
   * diff when it has a review under way, or one opened since the round began
   * (`REVIEW_ROUND_OPENED`); its reviews of earlier rounds do not count. One
   * whose task on this diff ran and failed has a card of its own, with Try
   * again, and is left to it; one that cannot work yet is left until it can.
   * A pull request whose round began before rounds were recorded counts every
   * review it ever had, as before. Returns a line for each one started.
   */
  async openMissingReviews(input: {
    repo: { name: string };
    prNumber: number;
    branch: string;
    issueNumber: number | null;
    /** The seats the gate waits on. */
    waitingOn: readonly string[];
  }): Promise<string[]> {
    const subjectRef = `${input.repo.name}#${input.prNumber}`;
    const had = await tasks.listTasksForSubjects('review', [subjectRef]).catch(() => null);
    if (!had) return [];
    // Not knowing when the round began starts nothing, rather than every seat.
    const round = await lastEventAt(REVIEW_ROUND_OPENED, { subjectRef }).catch(() => undefined);
    if (round === undefined) return [];
    const crew = await bots.listBots().catch(() => []);
    const waiting = input.waitingOn
      .map((name) => crew.find((entry) => entry.name === name))
      .filter((bot): bot is (typeof crew)[number] => Boolean(bot?.githubLogin));
    // A seat asked again after a bot dismissed its review: its task from
    // before that is the review that was dismissed.
    const askedAgain = new Map<string, string | null>();
    for (const bot of waiting) askedAgain.set(bot.id, await lastAskedAgain(subjectRef, bot.name));
    const asked = (bot: { id: string }) => {
      const since = [round, askedAgain.get(bot.id) ?? null].filter((at): at is string => Boolean(at)).map((at) => Date.parse(at));
      return had.some(
        (task) =>
          task.botId === bot.id &&
          ((round === null && since.length === 0) ||
            ['queued', 'running', 'paused'].includes(task.state) ||
            Date.parse(task.createdAt) >= Math.max(...since, Number.NEGATIVE_INFINITY)),
      );
    };
    const candidates = waiting.filter((bot) => !asked(bot));
    const blocked = await this.blocked(candidates, input.repo.name);

    const started: string[] = [];
    for (const bot of candidates) {
      const why = blocked.get(bot.name)?.map((blocker) => blocker.why).join(' and ');
      if (why) {
        console.log(`[bridge] ${subjectRef}: the gate waits on ${bot.name}, who cannot work yet: ${why}`);
        continue;
      }
      console.log(`[bridge] ${subjectRef}: the gate waits on ${bot.name}, who has no review under way; starting one`);
      try {
        const opened = await this.open({
          bot: bot.name,
          botId: bot.id,
          repo: input.repo.name,
          kind: 'review',
          subjectType: 'pr',
          subjectRef,
          skill: 'pr-review',
          branch: input.branch,
          issueNumber: input.issueNumber,
          checkoutExistingBranch: true,
        });
        started.push(`${subjectRef}: started ${bot.name}’s review${opened.error ? ` (${opened.error.slice(0, 80)})` : ''}`);
      } catch (error) {
        // A reviewer busy with another pull request is asked again on the
        // next sweep; that is not worth a line every time it is.
        if (!(error instanceof BotBusyError)) {
          console.warn(`[bridge] review task for ${bot.name} not started: ${error instanceof Error ? error.message : error}`);
        }
      }
    }
    return started;
  }

  /**
   * The lead's review, once every other seat asked has posted on this diff
   * (`Automation.reviewStanding`). Asked from the review that completed the
   * set and from the gate sweep, so a lead busy at that moment is asked again;
   * and never twice for one diff: a lead task under way, or opened since
   * `since`, is that review already. With no `since`, only a task under way
   * is: taking it for "any lead task ever" left the lead unasked on every
   * round after its first, since it always had an earlier one. A lead that
   * cannot work yet is left until it can.
   */
  async openLeadReview(input: {
    repo: { name: string };
    prNumber: number;
    branch: string;
    issueNumber: number | null;
    seat: string;
    /** When this diff, or the conflict resolution the lead re-checks, began; null when that is not known. */
    since: string | null;
    /** What the lead is to look at, beyond the review: only a conflict's resolution (`resolutionCheckBrief`). */
    extraContext?: ContextDocument[];
  }): Promise<string | null> {
    const subjectRef = `${input.repo.name}#${input.prNumber}`;
    const lead = (await bots.listBots().catch(() => [])).find((bot) => bot.name === input.seat);
    if (!lead?.githubLogin) return null;
    const had = await tasks.listTasksForSubjects('review', [subjectRef]).catch(() => null);
    if (!had) return null;
    // A lead asked again after a bot dismissed its review: its task from
    // before that is the review that was dismissed.
    const again = await lastAskedAgain(subjectRef, lead.name);
    const cutoffs = [input.since, again].filter((at): at is string => Boolean(at)).map((at) => Date.parse(at));
    const since = cutoffs.length > 0 ? Math.max(...cutoffs) : null;
    const already = had.some(
      (task) =>
        task.botId === lead.id && (['queued', 'running', 'paused'].includes(task.state) || (since !== null && Date.parse(task.createdAt) >= since)),
    );
    if (already) return null;
    try {
      const opened = await this.open({
        bot: lead.name,
        botId: lead.id,
        repo: input.repo.name,
        kind: 'review',
        subjectType: 'pr',
        subjectRef,
        skill: 'pr-review',
        branch: input.branch,
        issueNumber: input.issueNumber,
        checkoutExistingBranch: true,
        ...(input.extraContext ? { extraContext: input.extraContext } : {}),
      });
      console.log(`[bridge] ${subjectRef}: every other review is in; ${lead.name} reviews last`);
      return `${subjectRef}: started ${lead.name}’s review, the lead’s, last${opened.error ? ` (${opened.error.slice(0, 80)})` : ''}`;
    } catch (error) {
      // Busy with another pull request: the gate sweep asks again.
      if (!(error instanceof BotBusyError) && !(error instanceof PrerequisiteNotReadyError)) {
        console.warn(`[bridge] the lead's review of ${subjectRef} not started: ${error instanceof Error ? error.message : error}`);
      }
      return null;
    }
  }

  /**
   * A seat whose review a bot dismissed, asked to review again: a new review
   * task on the pull request. Neither the sweep nor the lead's turn would ask
   * it, since each took the task behind the dismissed review for the review
   * of this diff (`REVIEW_ASKED_AGAIN` is what tells them otherwise from
   * now on). Once per dismissed review, however often GitHub delivers it, and
   * not while the seat has a review of this pull request under way. A seat
   * busy elsewhere, or one that cannot work yet, is asked by the gate sweep
   * when it can. Returns a line when a task was started.
   */
  async askAgain(input: {
    repo: { name: string };
    prNumber: number;
    branch: string;
    issueNumber: number | null;
    seat: string;
    reviewId: number;
  }): Promise<string | null> {
    const subjectRef = `${input.repo.name}#${input.prNumber}`;
    const bot = (await bots.listBots().catch(() => [])).find((entry) => entry.name === input.seat);
    if (!bot?.githubLogin) return null;
    const fields = { subjectRef, reviewId: String(input.reviewId) };
    // Not knowing whether it was asked asks nothing: a second task on one
    // dismissal is worse than the sweep's asking a moment later.
    const before = new Date(Date.now() - ASKED_AGAIN_WINDOW_MS);
    if (await hasEventOfType(REVIEW_ASKED_AGAIN, before, fields).catch(() => true)) return null;
    await recordEvent({ source: 'platform', type: REVIEW_ASKED_AGAIN, payload: { ...fields, seat: bot.name } });

    const had = await tasks.listTasksForSubjects('review', [subjectRef]).catch(() => null);
    if (had?.some((task) => task.botId === bot.id && ['queued', 'running', 'paused'].includes(task.state))) return null;
    try {
      const opened = await this.open({
        bot: bot.name,
        botId: bot.id,
        repo: input.repo.name,
        kind: 'review',
        subjectType: 'pr',
        subjectRef,
        skill: 'pr-review',
        branch: input.branch,
        issueNumber: input.issueNumber,
        checkoutExistingBranch: true,
      });
      console.log(`[bridge] ${subjectRef}: a bot dismissed ${bot.name}’s review; ${bot.name} reviews again`);
      return `${subjectRef}: started ${bot.name}’s review again${opened.error ? ` (${opened.error.slice(0, 80)})` : ''}`;
    } catch (error) {
      // Busy, or not able to work yet: the gate sweep asks again.
      if (!(error instanceof BotBusyError) && !(error instanceof PrerequisiteNotReadyError)) {
        console.warn(`[bridge] ${bot.name}'s review of ${subjectRef} not asked again: ${error instanceof Error ? error.message : error}`);
      }
      return null;
    }
  }

  /**
   * A review seat's part, from the review rules: the lead, a blocking seat, or
   * advisory. It is the session's `FLEETADLC_REVIEW_MODE`, which OpenADLC's `gh`
   * holds an advisory seat to (comments only), and what decides whether its
   * task is briefed with the other seats' reviews. Undefined when the rules
   * cannot be read, which holds the seat to nothing more than before.
   *
   * With it, the seat's lens, which its brief states with its part: the model
   * was never told either, so it took its part from its playbook and guessed
   * the lens it wrote in its marker. A seat no rule names has no lens.
   */
  private async reviewSeatOf(bot: { name: string; slot?: string }): Promise<{ mode?: ReviewMode; lens?: string }> {
    try {
      const rules = reviewRulesOf(this.config.review);
      const crew = await bots.listBots().catch(() => []);
      const entry = rules.reviewers.find((one) => (resolveBotRef(crew, one.seat)?.name ?? one.seat) === bot.name || one.seat === bot.slot);
      if (!entry) return { mode: 'advisory' };
      return { mode: entry.lead ? 'lead' : entry.blocking ? 'blocking' : 'advisory', lens: entry.lens };
    } catch {
      return {};
    }
  }

  /**
   * Opens a task (see `openNow`), counted while it is under way so a shutdown
   * can wait for it (`drain`).
   */
  async open(input: Parameters<TaskService['openNow']>[0]): ReturnType<TaskService['openNow']> {
    const opening = this.openNow(input);
    this.opening.add(opening);
    try {
      return await opening;
    } finally {
      this.opening.delete(opening);
    }
  }

  /** Starts under way in this process. */
  private readonly opening = new Set<Promise<unknown>>();

  /**
   * Waits for the starts under way, for at most `timeoutMs`. A bridge that
   * closed its pool and exited mid-start left a row queued that no host ever
   * took; the reconciler clears one that is left anyway (`staleUnstarted`).
   */
  async drain(timeoutMs: number): Promise<void> {
    if (this.opening.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });
    await Promise.race([Promise.allSettled([...this.opening]), waited]);
    clearTimeout(timer);
  }

  private async openNow(input: {
    bot: string;
    /**
     * The bot by id, when the caller read it some time before asking: the
     * name it read may be one the bot no longer has.
     */
    botId?: string;
    repo?: string | null;
    kind: TaskKind;
    subjectType: 'issue' | 'pr' | 'merge' | 'request';
    subjectRef: string;
    skill: string;
    branch?: string | null;
    leaseId?: string | null;
    declaredPaths?: string[];
    /** The issue a pull request closes, so a patch round keeps its acceptance criteria. */
    issueNumber?: number | null;
    round?: number;
    checkoutExistingBranch?: boolean;
    /**
     * With `checkoutExistingBranch`, a branch that is not on the remote is
     * started from the base rather than refused: a build continued after it
     * ended without its pull request may have pushed nothing (`build-left.ts`).
     */
    startFromBaseIfMissing?: boolean;
    /**
     * What happens when the bot cannot work yet. `refuse` (the default) throws
     * `PrerequisiteNotReadyError` and records nothing, which is right where a
     * sweep comes back for the work: reviews, staffing, the QA and deploy
     * sweeps. `record` is for work only an event starts — a patch round after
     * changes requested, a revert, a verification. Refused, that was dropped
     * with a line in the log, and the pull request waited for good with no
     * card naming it. Recorded, it is a failed task that says why, which the
     * recovery runs again once the check passes (`retryAfterRecovery`).
     *
     * A monthly spending cap is handled the same way: `refuse` throws
     * `SpendingCapError`, and `record` records the task with the cap's words,
     * for the recovery to start once the cap allows it.
     */
    whenBlocked?: 'refuse' | 'record';
    /** Start past a monthly cap; see `CapBypass`. */
    bypassCap?: CapBypass;
    /**
     * What this task is for beyond its subject, written beside the rest of its
     * context: a resolution round's conflicted files, a lead's re-check of one,
     * the branch a stacked build starts from.
     */
    extraContext?: ContextDocument[];
    /** The branch a new branch starts from, as `refs/heads/<name>`; the default branch when absent. A stacked build's is the work it depends on. */
    baseRef?: string;
  }): Promise<{ taskId: string; session: string | null; error?: string }> {
    const found = (input.botId ? await bots.getBotById(input.botId) : null) ?? (await bots.getBotByName(input.bot));
    if (!found) throw new Error(`unknown bot ${input.bot}`);

    const repo = input.repo ? await repos.getRepoByName(input.repo) : null;
    // A month cap stops a new task, including a console request that has no
    // repository yet: the global month, the bot and the provider still apply.
    // One already running finishes, so resume does not ask.
    const overCap = await spendingLimits.refusal({
      monthlyCapUsd: this.config.costs.monthlyCapUsd,
      onCap: this.config.costs.onCap,
      period: costs.currentPeriod(),
      repoId: repo?.id ?? null,
      repoLabel: repo?.fullName ?? '',
      botId: found.id,
      botName: found.name,
      engine: found.engine,
    });
    const pastCap = overCap && input.bypassCap ? overCap : null;
    if (overCap && !pastCap) {
      const refused = new SpendingCapError(found.name, overCap);
      // Work only an event starts was dropped here with a line in the log:
      // a patch round, a verification, never tried again once the cap was
      // raised. Recorded, it is a card that says which cap, and the recovery
      // starts it when that cap allows.
      if (input.whenBlocked !== 'record') throw refused;
      return this.recordBlocked(found, repo, input, refused.message);
    }
    // A piece of work a person held on the board starts nothing new: no
    // build, no review, no fix round. A task paused on a question is resumed,
    // not opened, so an answer still goes on.
    const held = await heldWords(input.subjectRef);
    if (held) throw new ItemHeldError(held);
    const cap = await this.taskCap(repo?.id ?? null);
    const blockers = (await this.blocked([found], repo?.name ?? input.repo ?? null)).get(found.name);
    if (blockers) {
      const refused = new PrerequisiteNotReadyError(found.name, blockers);
      if (input.whenBlocked !== 'record') throw refused;
      return this.recordBlocked(found, repo, input, refused.message);
    }
    const { bot, task } = await this.names.withBot(found.id, async () => {
      // Read again: a rename this waited for has given the bot another name.
      const bot = (await bots.getBotById(found.id)) ?? found;
      // The same work twice, then room on the seat, then room on a host.
      if (await tasks.liveTaskOn(bot.id, input.subjectRef)) throw new SubjectBusyError(bot.name, input.subjectRef);
      if (!(await tasks.seatHasRoom(bot.id))) throw new BotBusyError(bot.name, maxTasksOf(bot));
      const room = await hosts.taskRoom();
      if (room !== null && room <= 0) throw new HostFullError(bot.name);

      const task = await tasks.createTask({
        botId: bot.id,
        repoId: repo?.id ?? null,
        kind: input.kind,
        subjectType: input.subjectType,
        subjectRef: input.subjectRef,
        leaseId: input.leaseId ?? null,
        skill: input.skill,
        branch: input.branch ?? null,
        costCapUsd: cap,
        round: input.round ?? 0,
        // A stacked build's base and its brief, which hostd gives it again
        // when it resumes; without them it resumed on the default branch.
        ...(input.baseRef ? { baseRef: input.baseRef, baseContext: input.extraContext ?? [] } : {}),
      }).catch((error: unknown) => {
        // Two starts of the same work at once, both past the check above.
        if (sameWorkTwice(error)) throw new SubjectBusyError(bot.name, input.subjectRef);
        throw error;
      });
      return { bot, task };
    });

    // Everything between the row and hostd. A throw here — a database error,
    // mostly — left the row queued for good: it held its seat, a host's room,
    // its subject and its issue, and Stop refuses a queued task. The row goes,
    // as a start a full host refused does, and the caller hears why.
    const { thread, reviewMode, reviewLens, context, files } = await (async () => {
      const thread = await threads.ensureThread({
        botId: bot.id,
        repoId: repo?.id ?? null,
        subjectRef: input.subjectRef,
      });

      await threads.addMessage({
        threadId: thread.id,
        kind: 'sys',
        author: 'fleetadlc',
        text: `${botAtStart(bot)} started ${input.skill} on ${input.subjectRef}`,
        note: `engine ${bot.engine} · model ${bot.model} · cap $${cap}`,
        payload: { taskId: task.id, skill: input.skill },
      });

      if (pastCap && input.bypassCap) {
        // Started past a monthly cap with leave to (`CapBypass`): written down
        // where a person reviewing spend looks, and on the task's own thread.
        const { by, why } = input.bypassCap;
        await audit({
          actor: by,
          action: 'spending.cap_bypassed',
          target: input.subjectRef,
          payload: { taskId: task.id, bot: bot.name, kind: input.kind, refusal: pastCap, why },
        }).catch((error: unknown) => console.warn(`[bridge] could not audit the start past the cap: ${error instanceof Error ? error.message : error}`));
        await threads.addMessage({
          threadId: thread.id,
          kind: 'sys',
          author: 'fleetadlc',
          text: `started past a spending cap (${why}): ${pastCap}`,
        });
        console.warn(`[bridge] ${input.subjectRef}: started past a spending cap by ${by} (${why}): ${pastCap}`);
      }

      const { mode: reviewMode, lens: reviewLens } = input.kind === 'review' ? await this.reviewSeatOf(bot) : {};
      const context = await this.contextFor({
        kind: input.kind,
        repoName: repo?.name ?? null,
        repoFullName: repo?.fullName ?? null,
        subjectRef: input.subjectRef,
        issueNumber: input.issueNumber ?? null,
        reviewer: bot.githubLogin,
        reviewerSeat: bot.name,
        reviewMode,
      });

      // After the context, which stores the images it reads from the issue.
      const files = await attachmentsForTask(input.subjectRef);
      return { thread, reviewMode, reviewLens, context, files };
    })().catch(async (error: unknown) => {
      await tasks.discardUnstarted(task.id).catch(() => undefined);
      throw error;
    });

    try {
      const started = await this.hostd.startTask({
        taskId: task.id,
        bot: bot.name,
        repo: repo?.name ?? null,
        kind: input.kind,
        subjectRef: input.subjectRef,
        branch: input.branch ?? null,
        skill: input.skill,
        context: [...context, ...(input.extraContext ?? [])],
        ...(input.baseRef ? { baseRef: input.baseRef } : {}),
        ...(files.length > 0 ? { attachments: files } : {}),
        declaredPaths: input.declaredPaths ?? [],
        costCapUsd: cap,
        checkoutExistingBranch: input.checkoutExistingBranch ?? false,
        ...(input.startFromBaseIfMissing ? { startFromBaseIfMissing: true } : {}),
        // What the session's own posts to GitHub start with, which its `gh`
        // puts first: the install and this seat's stage.
        postHeader: headerFor((await effectiveConfig(this.config).catch(() => null))?.installName ?? 'OpenADLC', bot.role),
        ...(reviewMode ? { reviewMode } : {}),
        ...(reviewLens ? { reviewLens } : {}),
      });
      return { taskId: task.id, session: started.session };
    } catch (error) {
      // No host had room after all: busy, not failed. The row goes, so no
      // card is left about work that never started, and the caller comes back.
      if (hostWasFull(error)) {
        await tasks.discardUnstarted(task.id).catch(() => undefined);
        await threads
          .addMessage({ threadId: thread.id, kind: 'sys', author: 'fleetadlc', text: `${input.skill} waits: every host is running all it has room for` })
          .catch(() => undefined);
        throw new HostFullError(bot.name);
      }
      const message = error instanceof Error ? error.message : String(error);
      await tasks.updateTaskState(task.id, 'failed', { exitReason: `hostd refused: ${message}` });
      await threads.addMessage({
        threadId: thread.id,
        kind: 'sys',
        author: 'fleetadlc',
        text: `could not start ${input.skill}: ${message}`,
      });
      return { taskId: task.id, session: null, error: message };
    }
  }

  /**
   * Work that only an event starts, for a bot that cannot do it yet: a failed
   * task that was never started, saying why in the words
   * `PrerequisiteNotReadyError` or `SpendingCapError` uses. Those words are
   * what `causeOfFailure` reads the health row from, or what `heldAtCap`
   * recognises, so the recovery runs it again when the row passes or the cap
   * allows it, and until then it is a card with Try again. It has no `startedAt`,
   * so a patch round held this way is not counted as a round that ran.
   */
  private async recordBlocked(
    found: { id: string; name: string },
    repo: { id: string; name: string } | null,
    input: Parameters<TaskService['openNow']>[0],
    reason: string,
  ): Promise<{ taskId: string; session: null; error: string }> {
    const cap = await this.taskCap(repo?.id ?? null);
    const task = await this.names.withBot(found.id, () =>
      tasks
        .createTask({
          botId: found.id,
          repoId: repo?.id ?? null,
          kind: input.kind,
          subjectType: input.subjectType,
          subjectRef: input.subjectRef,
          leaseId: input.leaseId ?? null,
          skill: input.skill,
          branch: input.branch ?? null,
          costCapUsd: cap,
          round: input.round ?? 0,
        })
        .catch((error: unknown) => {
          // The seat is already running this work: nothing to record beside it.
          if (sameWorkTwice(error)) throw new SubjectBusyError(found.name, input.subjectRef);
          throw error;
        }),
    );
    await tasks.updateTaskState(task.id, 'failed', { exitReason: reason });
    const thread = await threads.ensureThread({ botId: found.id, repoId: repo?.id ?? null, subjectRef: input.subjectRef });
    await threads.addMessage({ threadId: thread.id, kind: 'sys', author: 'fleetadlc', text: `could not start ${input.skill}: ${reason}` });
    console.warn(`[bridge] ${input.subjectRef}: ${reason}`);
    return { taskId: task.id, session: null, error: reason };
  }

  /**
   * A resumption starts a fresh session with a fresh context, so it re-reads the
   * subject rather than carrying anything over — the answer that unblocked it is
   * a comment on that subject, or for a console request an answered gate in its
   * `request.md`, and this is how the bot gets to see it.
   *
   * A refusal is handled as `open` handles one: the task is marked failed and
   * the reason goes in its thread. It used to reach only the bridge's log,
   * and the task sat paused with its question answered and nothing running.
   * The usual reason is a model the bot's account can no longer call.
   *
   * A task whose plan change was refused, that a person stopped at its cost
   * cap, or whose work has already landed, is not resumed: it is cleaned up.
   */
  async resume(taskId: string): Promise<void> {
    this.resuming.add(taskId);
    try {
      await this.resumeNow(taskId);
    } finally {
      this.resuming.delete(taskId);
    }
  }

  /** Resumes under way in this process, which the sweep of answered tasks leaves to finish. */
  private readonly resuming = new Set<string>();

  /**
   * Resumes every paused task whose question was answered after it paused
   * (`tasks.pausedWithAnswer`). The resume an answer starts is tried again
   * from a timer while every host is full, and a timer dies with the bridge:
   * a restart in that hour, or an exit between recording the answer and
   * resuming, left the task paused with nothing open, out of Needs you, and
   * its issue counted as building for good. The answer is the record that a
   * resume is owed, so this runs at start and on the merge sweep.
   *
   * One a person paused since — its seat, its item or its repository — is
   * left: the sweep must not undo a person's pause. One this process is
   * already resuming or trying again is left to that. Returns a line for
   * each one it acted on.
   */
  async resumeAnswered(): Promise<string[]> {
    const owed = await tasks.pausedWithAnswer();
    if (owed.length === 0) return [];
    const pauses = await this.seatPauses().catch(() => ({}) as Record<string, SeatPause>);
    const known = await repos.listRepos({ includeRemoved: true }).catch(() => []);
    const lines: string[] = [];
    for (const task of owed) {
      if (this.resuming.has(task.id) || this.resumeRetries.has(task.id)) continue;
      const seat = await bots.getBotById(task.botId).catch(() => null);
      const repoName = known.find((repo) => repo.id === task.repoId)?.name ?? null;
      const held =
        (seat && pauses[seat.name] ? seatPausedWords(seat.name, pauses[seat.name]!) : null) ??
        (await heldWords(task.subjectRef).catch(() => null)) ??
        this.workPaused(repoName);
      if (held) continue;
      try {
        await this.resume(task.id);
        const now = await tasks.getTask(task.id).catch(() => null);
        lines.push(
          now?.state === 'paused'
            ? `${task.subjectRef}: answered, and waits for a host with room`
            : `resumed ${task.skill ?? task.kind} on ${task.subjectRef}, answered ${task.answeredAt}`,
        );
      } catch (error) {
        lines.push(`${task.subjectRef}: could not resume: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`);
      }
    }
    return lines;
  }

  private async resumeNow(taskId: string): Promise<void> {
    const task = await tasks.getTask(taskId);
    // A refused plan change, or "hand to a person" or "abandon" at the cost
    // cap, answers its gate like any other, and every caller resumes the task
    // that asked. It was stopped by the answer, so what is left is its worktree.
    if (task && task.state === 'stopped' && wasRefused(task.exitReason)) {
      await this.hostd.cleanupTask(task.id, task.exitReason ?? 'plan change refused').catch(() => undefined);
      return;
    }
    const repo = task?.repoId ? (await repos.listRepos({ includeRemoved: true })).find((entry) => entry.id === task.repoId) : null;

    // Removing a repository from OpenADLC stops its paused tasks and closes their
    // questions. One whose stop failed — hostd did not answer — is still
    // paused, and an answer to it must not start work in a repository OpenADLC
    // has left: it is stopped here instead, as the removal would have.
    if (task && task.state === 'paused' && repo?.removedAt) {
      const reason = `not resumed: ${repo.fullName} was removed from OpenADLC`;
      await tasks.updateTaskState(task.id, 'stopped', { exitReason: reason });
      await this.hostd.cleanupTask(task.id, reason).catch(() => undefined);
      await settleLeaseAfter({ ...task, state: 'stopped' });
      return;
    }

    // Work whose issue or pull request has closed since it paused is over: a
    // reviewer resumed on a merged pull request failed with "not a branch of"
    // and left a new card, and intake resumed on a closed issue moved it to
    // Build. It is stopped and cleaned up, and the bot is not started.
    const number = task ? Number(task.subjectRef.split('#')[1] ?? '') : NaN;
    if (task && task.state === 'paused' && repo && endsWithSubject(task) && (await this.subjectIsClosed(repo.fullName, number))) {
      const reason = alreadyLanded(task.subjectRef);
      await tasks.updateTaskState(task.id, 'stopped', { exitReason: reason });
      await this.hostd.cleanupTask(task.id, reason).catch(() => undefined);
      await settleLeaseAfter({ ...task, state: 'stopped' });
      const thread = await threads.ensureThread({ botId: task.botId, repoId: task.repoId, subjectRef: task.subjectRef });
      await threads.addMessage({ threadId: thread.id, kind: 'sys', author: 'fleetadlc', text: `not resumed: ${reason}` });
      return;
    }

    const seat = task ? await bots.getBotById(task.botId).catch(() => null) : null;
    const reviewer = seat?.githubLogin ?? null;
    // A resumed session posts to GitHub as much as the first one did.
    const postHeader = seat
      ? headerFor((await effectiveConfig(this.config).catch(() => null))?.installName ?? 'OpenADLC', seat.role)
      : undefined;
    const { mode: reviewMode, lens: reviewLens } = task?.kind === 'review' && seat ? await this.reviewSeatOf(seat) : {};
    const context = task
      ? await this.contextFor({
          kind: task.kind,
          repoName: repo?.name ?? null,
          repoFullName: repo?.fullName ?? null,
          subjectRef: task.subjectRef,
          reviewer,
          reviewerSeat: seat?.name ?? null,
          reviewMode,
        })
      : [];

    try {
      // hostd resumes under whatever the row calls the bot, so not while a
      // rename is moving it to another name.
      // Read again: a file sent while it waited on a question goes with it.
      const files = task ? await attachmentsForTask(task.subjectRef) : [];
      if (task) await this.names.withBot(task.botId, () => this.hostd.resumeTask(taskId, context, postHeader, files, reviewMode, reviewLens));
      else await this.hostd.resumeTask(taskId, context, postHeader, files);
      this.resumeRetries.delete(taskId);
    } catch (error) {
      if (!task) throw error;
      // A resume may take its seat past its tasks at once — the task was
      // its seat's before it paused — but not a host past its room. Kept
      // paused and tried again shortly, as busy work is; failed with why
      // only if no host has had room for an hour.
      if (hostWasFull(error) && (await this.retryResumeLater(task))) return;
      const message = error instanceof Error ? error.message : String(error);
      await tasks.updateTaskState(task.id, 'failed', { exitReason: `hostd refused: ${message}` });
      await this.hostd.cleanupTask(task.id, 'resume refused').catch(() => undefined);
      // It was paused on a question, so its lease was too, and a resume that
      // cannot start is the end of it.
      await settleLeaseAfter({ ...task, state: 'failed' });
      const thread = await threads.ensureThread({
        botId: task.botId,
        repoId: task.repoId,
        subjectRef: task.subjectRef,
      });
      await threads.addMessage({
        threadId: thread.id,
        kind: 'sys',
        author: 'fleetadlc',
        text: `could not resume ${task.skill ?? task.kind}: ${message}`,
      });
      throw error;
    }
  }

  /** A resume a full host refused, and how many times it has been tried again. */
  private readonly resumeRetries = new Map<string, number>();

  /**
   * Schedules a resume again a minute from now; false once no host has had
   * room for an hour since the answer. The hour is counted from the answer as
   * stored, not from tries in memory, which a restart set back to none. A
   * resume no answered question explains (a plan change approved) counts
   * tries as before.
   */
  private async retryResumeLater(task: Task): Promise<boolean> {
    const tries = (this.resumeRetries.get(task.id) ?? 0) + 1;
    const answeredAt = await this.answeredAt(task.id);
    const waited = answeredAt === null ? null : Date.now() - Date.parse(answeredAt);
    if (waited !== null ? waited >= RESUME_WAIT_MS : tries > RESUME_RETRIES) {
      this.resumeRetries.delete(task.id);
      return false;
    }
    this.resumeRetries.set(task.id, tries);
    if (tries === 1) {
      void threads
        .ensureThread({ botId: task.botId, repoId: task.repoId, subjectRef: task.subjectRef })
        .then((thread) =>
          threads.addMessage({
            threadId: thread.id,
            kind: 'sys',
            author: 'fleetadlc',
            text: 'answered; it starts again as soon as a host has room — every host is running all the tasks it has room for',
          }),
        )
        .catch(() => undefined);
    }
    // Only while it is still paused: answered twice, or stopped meanwhile, it
    // is not this retry's to start.
    const again = async (): Promise<void> => {
      if ((await tasks.getTask(task.id).catch(() => null))?.state === 'paused') await this.resume(task.id);
    };
    const timer = setTimeout(() => void again().catch(() => undefined), RESUME_RETRY_MS);
    timer.unref?.();
    return true;
  }

  /** When the task's newest question was answered, or null when it has none answered or it cannot be read. */
  private async answeredAt(taskId: string): Promise<string | null> {
    // Oldest first, as the store lists them.
    const newest = (await threads.listGatesForTasks([taskId]).catch(() => [])).at(-1);
    return newest?.state === 'answered' ? newest.answeredAt : null;
  }

  /**
   * Records an engine invocation and answers whether the task may keep going.
   *
   * Only what a real engine call of this task could have cost: on the task's
   * own bot's engine, while the task is running or paused (a question's own
   * usage arrives after its gate paused the task), and no more in one report
   * than the cap plus one step, past which `stop` would already have tripped.
   */
  async recordUsage(input: { taskId: string } & UsageReport): Promise<{ stop: boolean; spent: number; cap: number; stepUsd: number }> {
    const problem = usageProblem(input as unknown as Record<string, unknown>);
    if (problem) throw new UsageRefusedError(problem);
    const task = await tasks.getTask(input.taskId);
    if (!task) throw new Error('unknown task');
    if (task.state !== 'running' && task.state !== 'paused') {
      throw new UsageRefusedError(`task ${task.id} is ${task.state}; usage is recorded only while it is running or paused`);
    }
    const bot = await bots.getBotById(task.botId);
    // The scripted engine, `none`, runs only in the integration suites.
    const scripted = input.engine === 'none' && process.env.FLEETADLC_SCRIPTED_ENGINES === '1';
    if (!bot || (input.engine !== bot.engine && !scripted)) {
      throw new UsageRefusedError(`engine must be the task's bot's own (${bot?.engine ?? 'its bot is gone'}), not ${input.engine}`);
    }
    // `stepUsd` is what the cost-cap gate offers to add: the lower of the
    // global and repository per-task caps, not this task's, which a raise
    // has made larger.
    const stepUsd = await this.taskCap(task.repoId);
    if (input.costUsd > task.costCapUsd + stepUsd) {
      throw new UsageRefusedError(`costUsd must be at most ${task.costCapUsd + stepUsd}, the task's cap and one step: no one engine call costs more`);
    }

    await costs.recordUsage({
      taskId: task.id,
      botId: task.botId,
      engine: input.engine as never,
      model: input.model,
      modelAlias: input.modelAlias ?? null,
      tokensIn: input.tokensIn,
      tokensOut: input.tokensOut,
      costUsd: input.costUsd,
    });
    const spent = await tasks.addTaskCost(task.id, input.costUsd);

    const period = costs.currentPeriod();
    await costs.ensureBudget(period, this.config.costs.monthlyCapUsd, this.config.costs.warningAt);

    return { stop: spent >= task.costCapUsd, spent, cap: task.costCapUsd, stepUsd };
  }

  async headroom(taskId: string, estimateUsd: number): Promise<{ stop: boolean; spent: number; cap: number; stepUsd: number }> {
    const task = await tasks.getTask(taskId);
    if (!task) throw new Error('unknown task');
    const spent = await costs.taskSpend(taskId);
    const stepUsd = await this.taskCap(task.repoId);
    return { stop: spent + estimateUsd > task.costCapUsd, spent, cap: task.costCapUsd, stepUsd };
  }

  /**
   * The cap a new task in this repository starts with, and what one
   * "continue" at the cost cap adds. The lower of the global and repository
   * per-task limits. The file's amount is the fallback before the first seed.
   */
  private async taskCap(repoId: string | null): Promise<number> {
    const fallback = this.config.costs.perTaskCapUsd;
    await spendingLimits.seedGlobal(this.config.costs.monthlyCapUsd, fallback);
    return spendingLimits.effectiveTaskCap(repoId, fallback);
  }
}

/** How far back a dismissal's asking again is looked for: GitHub redelivers within days. */
const ASKED_AGAIN_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** When `seat` was last asked to review this pull request again (`REVIEW_ASKED_AGAIN`), or null. */
async function lastAskedAgain(subjectRef: string, seat: string): Promise<string | null> {
  return lastEventAt(REVIEW_ASKED_AGAIN, { subjectRef, seat }).catch(() => null);
}
