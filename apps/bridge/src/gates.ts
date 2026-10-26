import { audit, bots, costs, issues, leases, repos, requests, spendingLimits, tasks, threads, type Role } from '@openadlc/db';
import type { GitHubClient } from '@openadlc/github';
import {
  COST_CAP_ABANDON,
  PLAN_CHANGE_APPROVE,
  botAtStart,
  PLAN_CHANGE_REFUSE,
  addExpectedPaths,
  costCapAnswer,
  declaredPathsOverlap,
  hasAccess,
  inertMarkup,
  isCrewLogin,
  normalisePlanPaths,
  redactSecrets,
  renderGateComment,
  resolveAnswer,
  seatOf,
  type CostsConfig,
  type Lease,
  type PlanChangeRequest,
  type TaskKind,
  hasIgnoreLabel,
} from '@openadlc/shared';
import type { Actors } from './actors.js';
import { itemLink, type Notifier } from './notify.js';
import { acceptOnAnswer } from './design-memory.js';
import { moveRequest } from './request-lifecycle.js';
import { HttpFailure } from './router.js';
import { publicNameOf } from './thread-view.js';
import { issueNumberFromBranch, parseRef } from './work.js';

/** A request that could not be moved is logged, not a gate that failed to open or close. */
function requestNotMoved(subjectRef: string, error: unknown): null {
  console.warn(`[bridge] could not move ${subjectRef}: ${error instanceof Error ? error.message : error}`);
  return null;
}

/** What a task's exit reason starts with when a person refused its plan change. */
const REFUSED = 'plan change refused';

/** What a task's exit reason starts with when a person stopped it at its cost cap. */
const STOPPED_AT_CAP = 'stopped at the cost cap';

/**
 * What a task's exit reason starts with when the issue or pull request it was
 * working on had closed by the time it would have gone on. Answering
 * intake's old question on a closed issue resumed intake, which moved the
 * issue to Build; answering a reviewer on a merged pull request resumed it
 * into "not a branch of" and a new failure card.
 */
export const ALREADY_LANDED = 'already landed';

/**
 * Whether a person's answer ended the task: a refused plan change, "hand to
 * a person" or "abandon" at the cost cap, or an answer on work that had
 * already landed. Not the same as a task stopped while it waited, and every
 * caller resumes the task an answer names, so this is what tells it to clean
 * up instead.
 */
export function wasRefused(exitReason: string | null | undefined): boolean {
  return Boolean(
    exitReason?.startsWith(REFUSED) || exitReason?.startsWith(STOPPED_AT_CAP) || exitReason?.startsWith(ALREADY_LANDED),
  );
}

/**
 * The kinds of task whose work is over once their subject closes: everything
 * up to and including the review. A deploy or QA task starts at the merge, so
 * a merged pull request is where its work is, not a sign it is done.
 */
const ENDS_WITH_SUBJECT: readonly TaskKind[] = ['intake', 'request', 'spec', 'implement', 'patch', 'review'];

/** Whether a task's work is over once its issue or pull request closes, and it has one on GitHub. */
export function endsWithSubject(task: { kind: TaskKind; subjectRef: string }): boolean {
  return ENDS_WITH_SUBJECT.includes(task.kind) && parseRef(task.subjectRef) !== null;
}

/**
 * Whether GitHub says an issue or pull request is closed; a pull request that
 * merged is closed too. A read that fails is not closed: the work goes on as
 * it would have, rather than being ended on a guess.
 */
export async function subjectClosed(client: Pick<GitHubClient, 'getIssue'>, repoFullName: string, number: number): Promise<boolean> {
  const issue = await client.getIssue(repoFullName, number).catch(() => null);
  return issue?.state === 'closed';
}

/** The exit reason of a task whose subject had closed. */
export function alreadyLanded(subjectRef: string): string {
  return `${ALREADY_LANDED}: ${subjectRef} is closed, so the work it was for is finished`;
}

/** What a continue held at a monthly cap says on the issue and in the thread. */
function capHeldText(answeredBy: string, refusal: string): string {
  return (
    `**${answeredBy} answered** continue, but a monthly spending cap is reached: ${refusal}. ` +
    'The task stays stopped. An admin can raise the cap in Settings → Spending limits, or answer continue from the console to let it go on past the cap.'
  );
}

const HELD_LEASE_STATES: readonly string[] = ['leased', 'in_task', 'paused'];

function pathList(paths: readonly string[]): string {
  return paths.map((path) => `\`${path}\``).join(', ');
}

/**
 * A GitHub login, which is what an `@` in a comment notifies. A console
 * identity is an email (or `local operator`), and `@janedoe@example.com`
 * notified nobody on the issue it was written to.
 */
const GITHUB_LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The lease is gone: the task cannot be given paths it no longer holds. */
const LEASE_GONE = 'Nothing was added: the lease this task asked to widen is no longer held.';

/**
 * The issue a task's work is about, which is where its plan change is
 * written: the issue its lease is on, else the one its branch was cut for,
 * else its subject when the subject is the issue. A patch round is filed
 * under the pull request and holds the issue's lease; read from its subject,
 * an approved path was written into the pull request's body, where CI's
 * scope check never looks, and the round went back to build over and over.
 * 0 when there is none.
 */
export async function issueOfTask(task: { kind: TaskKind; subjectRef: string; leaseId: string | null; branch: string | null }): Promise<number> {
  const lease = task.leaseId ? await leases.getLease(task.leaseId).catch(() => null) : null;
  if (lease) return lease.issueNumber;
  const fromBranch = issueNumberFromBranch(task.branch ?? '');
  if (fromBranch) return fromBranch;
  return task.kind === 'patch' ? 0 : Number(task.subjectRef.split('#')[1] ?? '0');
}

/**
 * How an approval no person typed is said: on the issue, as the record of what
 * was asked and who approved it, and in the thread as a line of OpenADLC's.
 */
function decidedWords(decided: GateDecider, gate: GateRef): { comment: string; line: string } {
  const why = decided.reason.trim() ? inertMarkup(decided.reason.trim()) : '';
  if (decided.by === 'standing_approval') {
    return {
      comment:
        `**Approved under the standing approval** ${publicNameOf(decided.setBy)} set for #${decided.issue} on ${decided.setAt.slice(0, 10)}.` +
        `${why ? ` The builder asked for it because: ${why}` : ''}`,
      line: `approved under ${decided.setBy}'s standing approval (gate ${gate.id.slice(0, 8)})`,
    };
  }
  return {
    comment:
      `**The designer (${decided.seat}) approved** it, asked by ${publicNameOf(decided.askedBy)}: ${why || 'no reason given'}\n\n` +
      'A person can still refuse it from the item in the console, which takes the paths back and stops the task.',
    line: `${decided.seat}, the designer, approved the plan change ${decided.askedBy} asked it to judge`,
  };
}

interface GateRef {
  id: string;
  taskId: string | null;
  threadId: string | null;
  /** Whether opening it put `needs-human` on its subject; see `threads.GateRecord`. */
  addedNeedsHuman?: boolean;
}

/**
 * Where an answer came from: the console's gate route, the item view's
 * composer, a bot's thread panel, a comment on GitHub, an approval that
 * waited on another lease and was applied once the paths were free, a
 * person's standing approval of the issue's plan changes, or the design
 * seat's judgement (`plan-changes.ts`).
 */
export type GateChannel = 'console-gate' | 'item' | 'thread' | 'github' | 'held' | 'standing' | 'designer' | 'unknown';

/** What an answer granted, as its audit row records it. */
export type GateGrant = 'plan_change_approved' | 'plan_change_refused' | 'cap_raised' | 'stopped' | null;

/**
 * Who approved a plan change when no person answered it (#77): a standing
 * approval a person left on for the issue, or the design seat's judgement
 * within its limits. Said on the issue and in the audit row, which otherwise
 * read as the person or the seat having typed `Approve`.
 */
export type GateDecider =
  | { by: 'standing_approval'; setBy: string; setAt: string; reason: string; issue: number }
  | { by: 'designer'; seat: string; taskId: string; askedBy: string; reason: string };

/** How an answer that claims its gate is audited, and whether its GitHub writes are left to the caller. */
interface AnswerRecord {
  via: GateChannel;
  grant: GateGrant;
  /** See `deferGitHub` on `answer`. */
  deferGitHub?: boolean;
  /** A plan change's paths, so the audit log says what each decision covered. */
  paths?: readonly string[];
  decided?: GateDecider;
}

/**
 * Whether a standing approval on the work a plan change widens covers it.
 * Null when none is on. `covers` is false when a path is under Human review,
 * and `humanReview` says which, or when the rules could not be read, and
 * `rulesUnread` says so and what to do: either asks a person.
 */
export type StandingCover = (input: {
  repoId: string;
  repoFullName: string;
  issueNumber: number;
  paths: readonly string[];
}) => Promise<{ covers: boolean; setBy: string; setAt: string; humanReview: readonly string[]; rulesUnread?: string } | null>;

/**
 * A gate is the only thing that demands a person. It is written to GitHub first
 * (the comment is the durable record), then mirrored into the thread the console
 * shows, and it holds the task until the answer comes back. A console request
 * has no issue yet, so its gate is in the thread alone, and the request's own
 * state says it is waiting.
 */
export class Gates {
  constructor(
    private readonly actors: Actors,
    /** Optional so a caller that only reads gates need not wire one. */
    private readonly notifier: Notifier | null = null,
    private readonly consoleUrl = 'http://127.0.0.1:47300',
    /** The install's per-task cap: what one "continue" at the cost cap offers and adds. */
    private readonly perTaskCapUsd = 15,
    /**
     * The install's monthly caps, which a "continue" at the cost cap is held
     * to. Without them (a test, a caller that only reads gates) no monthly
     * cap is asked, as before.
     */
    private readonly monthly: Pick<CostsConfig, 'monthlyCapUsd' | 'onCap'> | null = null,
  ) {}

  private leaseReleased: ((reason: string) => void) | null = null;

  /**
   * Whether the issue is labelled `openadlc:ignore`, as stored or as GitHub has
   * it now. The stored row can be behind: the label's delivery may still be
   * in flight while the task asks. A read GitHub does not answer counts as
   * not labelled, and the stored row is what decides.
   */
  private async labelledIgnore(
    client: Pick<GitHubClient, 'getIssue'>,
    repo: { id: string; fullName: string },
    issueNumber: number,
  ): Promise<boolean> {
    const reads = [() => issues.getIssue(repo.id, issueNumber), () => client.getIssue(repo.fullName, issueNumber)];
    for (const read of reads) {
      try {
        if (hasIgnoreLabel((await read())?.labels)) return true;
      } catch {
        // Not labelled, as far as this read can tell.
      }
    }
    return false;
  }

  /**
   * The subject of the gate's task when it has closed on GitHub and the task's
   * work ends with it; null otherwise, and when GitHub cannot be asked.
   */
  private async landedSubject(gate: GateRef): Promise<string | null> {
    const task = gate.taskId ? await tasks.getTask(gate.taskId) : null;
    const parsed = task ? parseRef(task.subjectRef) : null;
    if (!task || !parsed || !endsWithSubject(task)) return null;
    const repo = task.repoId ? (await repos.listRepos({ includeRemoved: true })).find((entry) => entry.id === task.repoId) : null;
    const bot = await bots.getBotById(task.botId);
    const client = bot ? await this.actors.asBot(bot.name).catch(() => null) : null;
    if (!repo || !client) return null;
    return (await subjectClosed(client, repo.fullName, parsed.number)) ? task.subjectRef : null;
  }

  /**
   * Called when an answer ends a task and lets go of its lease. The bridge
   * wakes the dispatcher and retries held plan changes there, as it does for
   * every other task that stops; an answer that released a lease used to leave
   * both waiting for some unrelated work to end.
   */
  onLeaseReleased(listener: (reason: string) => void): void {
    this.leaseReleased = listener;
  }

  private standing: StandingCover | null = null;

  /**
   * How a plan change is checked against a standing approval on its issue
   * (`plan-changes.ts`). Without one, every plan change asks a person.
   */
  useStandingApprovals(cover: StandingCover): void {
    this.standing = cover;
  }

  async open(input: {
    taskId: string;
    question: string;
    options: string[];
    /**
     * What the bot found and why it asks. The thread already has it as the
     * bot's own message; on an issue the comment is all a person sees.
     */
    context?: string | null;
    addressedTo?: string | null;
    /**
     * Paths the task asks to add to its lease. A bot-authored list is data: it
     * is normalised here, and it grants nothing until a person approves it.
     */
    planChange?: { paths?: unknown; reason?: unknown } | null;
  }): Promise<{ gateId: string; commentUrl: string | null }> {
    // A question can quote a failing command, token and all, and from here it
    // goes to the issue, the notifier, the gate row and the thread. Redacted
    // once, before any copy is made, so every copy says the same and an answer
    // still matches an option by its text.
    input = {
      ...input,
      question: redactSecrets(input.question),
      options: input.options.map((option) => redactSecrets(option)),
      context: input.context == null ? input.context : redactSecrets(input.context),
    };
    const task = await tasks.getTask(input.taskId);
    if (!task) throw new Error(`unknown task ${input.taskId}`);
    const bot = await bots.getBotById(task.botId);
    if (!bot) throw new Error('task has no bot');

    const repo = task.repoId ? (await repos.listRepos()).find((entry) => entry.id === task.repoId) : null;
    // Where the question is asked: the task's subject, a pull request for a patch round.
    const issueNumber = Number(task.subjectRef.split('#')[1] ?? '0');
    // What a plan change widens: the issue the lease is on.
    const leaseIssue = task.leaseId ? await issueOfTask(task) : 0;

    // Only a task holding a lease on an issue has paths to widen. Anything else
    // asking is an ordinary question, and Approve means nothing to it.
    const paths = task.leaseId && repo && leaseIssue ? normalisePlanPaths(input.planChange?.paths) : [];
    const reason = typeof input.planChange?.reason === 'string' ? input.planChange.reason.trim().slice(0, 2000) : '';
    const request: PlanChangeRequest | null = paths.length > 0 ? { paths, reason } : null;
    // What "continue" adds is the lower of the global and this repository's
    // per-task cap, the same amount the task was started with. The session's
    // own number is text, and is not what is granted.
    const step = await spendingLimits.effectiveTaskCap(task.repoId, this.perTaskCapUsd);
    const options = request ? [PLAN_CHANGE_APPROVE, PLAN_CHANGE_REFUSE] : this.capOffer(input.options, step);
    // A standing approval on the work settles the request as it is asked,
    // unless a path is under Human review: that one is a person's, always.
    // One that cannot be read is not on, and the person is asked as before.
    const standing =
      request && repo && this.standing
        ? await this.standing({ repoId: repo.id, repoFullName: repo.fullName, issueNumber: leaseIssue, paths: request.paths }).catch((error: unknown) => {
            console.warn(`[bridge] ${repo.name}#${leaseIssue}: the standing approval could not be read, so a person is asked: ${error instanceof Error ? error.message : error}`);
            return null;
          })
        : null;
    const settles = standing?.covers ? standing : null;
    const context = request
      ? [
          input.context?.trim(),
          `Approve adds ${request.paths.length === 1 ? 'it' : 'them'} to ${leaseIssue === issueNumber ? "this issue's" : `#${leaseIssue}'s`} Expected paths and to the task's lease, and the task goes on. Refuse stops the task.`,
          standing && !standing.covers
            ? standing.rulesUnread
              ? `Approve all is on for #${leaseIssue}, but ${standing.rulesUnread}.`
              : `Approve all is on for #${leaseIssue}, but ${pathList([...standing.humanReview])} ${standing.humanReview.length === 1 ? 'is' : 'are'} under Human review in AGENTS.md, so a person decides.`
            : '',
        ]
          .filter(Boolean)
          .join('\n\n')
      : (input.context ?? null);
    // The bot asking for wider paths does not choose who is notified about the
    // grant: what it names counts only when the issue's own record names nobody.
    // A person the record names but GitHub knows no login for is still the
    // record's answer: the question then mentions nobody, not the bot's pick.
    const decider = request && repo ? await this.whoDecides(`${repo.name}#${leaseIssue}`, repo, leaseIssue, bot.name) : undefined;
    const named = decider !== undefined ? decider : (input.addressedTo ?? null);
    // Whoever named the person, only a login is written as a mention. A bot
    // that wrote `@janedoe` meant the login, and got `@@janedoe` before.
    const login = named?.trim().replace(/^@/, '') ?? '';
    const addressedTo = GITHUB_LOGIN.test(login) ? login : null;

    let commentUrl: string | null = null;
    let ignored = false;
    let addedNeedsHuman = false;
    if (repo && issueNumber) {
      const client = await this.actors.asBot(bot.name);
      // A person can add `openadlc:ignore` while a task is already working on
      // the issue. The task is not stopped, but it writes nothing more to
      // the issue: intake once asked its question and added `needs-human`
      // after the issue was labelled to be left alone. The question stays in
      // the thread, where the person can answer it or stop the task.
      ignored = client ? await this.labelledIgnore(client, repo, issueNumber) : false;
      // A request the standing approval settles asks nobody: its record on
      // the issue is the answer's comment, which says what was asked and why.
      if (client && !ignored && !settles) {
        const body = renderGateComment({
          bot: bot.displayName,
          taskId: task.id,
          question: input.question,
          options,
          context,
          ...(addressedTo ? { addressedTo } : {}),
        });
        // `needs-human` is also how a person holds a pull request, and
        // answering a question took it off whatever put it there: a reviewer's
        // question on a held pull request, once answered, lifted the hold and
        // the merge line landed it. So the gate keeps whether the label is the
        // crew's: absent before, or put there by a question still open. A
        // label that cannot be read is taken for a person's, which leaves it on.
        let present = true;
        try {
          present = (await client.getIssue(repo.fullName, issueNumber)).labels.includes('needs-human');
          if (present) addedNeedsHuman = (await threads.listOpenGatesOnSubject(task.subjectRef)).some((other) => other.addedNeedsHuman !== false);
        } catch {
          // A person's, as far as this can tell.
        }
        if (!present) addedNeedsHuman = true;
        const comment = await client.comment(repo.fullName, issueNumber, body);
        commentUrl = comment.htmlUrl;
        // needs-human is what keeps the dispatcher from leasing this issue again.
        await client.addLabels(repo.fullName, issueNumber, ['needs-human']);
      }
    }

    const thread = await threads.ensureThread({
      botId: bot.id,
      repoId: task.repoId,
      subjectRef: task.subjectRef,
    });

    const gate = await threads.createGate({
      taskId: task.id,
      threadId: thread.id,
      question: input.question,
      options,
      addressedTo,
      githubCommentUrl: commentUrl,
      addedNeedsHuman,
    });

    // A gate can stay open for a day. Expiring the lease under it would hand
    // the issue back to the board while the bot is still holding the branch, so
    // it is paused with no expiry instead.
    if (task.leaseId) await leases.pauseIndefinitely(task.leaseId).catch(() => undefined);

    // The one moment a person is genuinely being waited on. Answering produces
    // no notification: the work resumes, which is the point, and telling
    // somebody their own answer landed is noise. Nor does a request a standing
    // approval settles: nobody is waited on, unless applying it fails below.
    const notify = () =>
      this.notifier?.send({
        event: 'gate_opened',
        to: addressedTo,
        text: `${botAtStart(bot)} is waiting on an answer about ${task.subjectRef}: ${input.question}`,
        link: itemLink(this.consoleUrl, task.subjectRef),
      });
    if (!settles) await notify();

    await threads.addMessage({
      threadId: thread.id,
      kind: 'gate',
      author: bot.name,
      text: input.question,
      payload: {
        options,
        gateId: gate.id,
        ...(request ? { planChange: request } : {}),
        // What kept a standing approval from settling it, for the card to say.
        ...(standing && !standing.covers
          ? { standing: { setBy: standing.setBy, humanReview: [...standing.humanReview], ...(standing.rulesUnread ? { rulesUnread: standing.rulesUnread } : {}) } }
          : {}),
      },
      githubUrl: commentUrl,
    });
    if (ignored) {
      await threads.addMessage({
        threadId: thread.id,
        kind: 'sys',
        author: 'openadlc',
        text: `The question was not posted on ${task.subjectRef}: the issue is labelled openadlc:ignore, which the crew leaves alone`,
        note: 'answer it here, or stop the task',
        payload: { gateId: gate.id },
      });
    }

    await tasks.updateTaskState(task.id, 'paused', { exitReason: 'waiting on a person' });
    // A console request has no issue to carry `needs-human`, so the request
    // itself says it is waiting on the person who asked.
    await moveRequest(task, 'questions').catch((error: unknown) => requestNotMoved(task.subjectRef, error));
    if (settles && request) await this.settleByStanding(gate, request, settles, leaseIssue, notify);
    return { gateId: gate.id, commentUrl };
  }

  /**
   * Approves a request a standing approval covers, as it is asked: the same
   * approval a person's answer is, recorded as the standing approval's. The
   * task's resume waits for its session to stop (`/internal/tasks/:id/state`,
   * once it reports itself paused). One that cannot be applied leaves the
   * question open, and the person is asked after all.
   */
  private async settleByStanding(
    gate: GateRef,
    request: PlanChangeRequest,
    standing: { setBy: string; setAt: string },
    issueNumber: number,
    notify: () => Promise<unknown> | undefined,
  ): Promise<void> {
    try {
      await this.answer({
        gateId: gate.id,
        reply: PLAN_CHANGE_APPROVE,
        answeredBy: standing.setBy,
        via: 'standing',
        decided: { by: 'standing_approval', setBy: standing.setBy, setAt: standing.setAt, reason: request.reason, issue: issueNumber },
      });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      console.warn(`[bridge] gate ${gate.id}: the standing approval on #${issueNumber} could not be applied, so a person is asked: ${why}`);
      if (gate.threadId) {
        await threads
          .addMessage({
            threadId: gate.threadId,
            kind: 'sys',
            author: 'openadlc',
            text: `${standing.setBy}'s standing approval for #${issueNumber} could not be applied, so a person answers this one`,
            note: why,
            payload: { gateId: gate.id },
          })
          .catch(() => undefined);
      }
      await notify();
    }
  }

  /**
   * Answering removes `needs-human`, when the question put it there and no
   * other is open on the subject, and lets the task resume from a fresh context.
   *
   * A plan-change request is answered by exactly `Approve` or `Refuse`. Approving
   * widens the lease and the issue, or keeps the gate open when another lease
   * holds a path it asked for (`taskId` is null then: nothing resumes yet).
   * Refusing stops the task, and the caller's resume cleans it up instead of
   * starting it. Any other words grant nothing and go to the bot as they are.
   */
  async answer(input: {
    gateId: string;
    reply: string;
    answeredBy: string;
    /**
     * The console role of whoever answered. Only an admin's "continue" goes
     * past a spent monthly cap; a reply on GitHub passes none, since a GitHub
     * identity has no console role.
     */
    role?: Role;
    /** Where the answer came from, for its audit row. A caller that names none is audited as 'unknown'. */
    via?: GateChannel;
    /**
     * Leave what an answer writes on GitHub once it has claimed the gate — the
     * answer's comment, `needs-human` taken off, why the task stopped — to the
     * caller, as `github`, rather than writing it here. A console route
     * answers the person first and writes it after (`answerFromConsole`): an
     * answer to #27's builder took 30 seconds on a live install, and the
     * person pressed Approve again while it ran. The caller runs it before it
     * resumes the task, since a resumed session reads the answer from the
     * issue. Never rejects: what it could not write is said in the thread.
     */
    deferGitHub?: boolean;
    /**
     * An approval no person gave: a standing approval's, or the designer's
     * (`plan-changes.ts`, which holds each to its limits). Only a plan
     * change's `Approve` is ever given this way.
     */
    decided?: GateDecider;
  }): Promise<{ answer: string; taskId: string | null; held?: boolean; github?: () => Promise<void> }> {
    const via = input.via ?? 'unknown';
    const record = (grant: GateGrant): AnswerRecord => ({ via, grant, ...(input.deferGitHub ? { deferGitHub: true } : {}) });
    const gate = await threads.getGate(input.gateId);
    if (!gate) throw new Error('unknown gate');
    if (gate.state !== 'open') throw new Error('gate is no longer open');

    const answer = resolveAnswer(input.reply, gate.options);

    // The answer is kept, but work whose issue or pull request has closed is
    // not resumed for it: the resume that follows cleans the task up instead.
    const landed = await this.landedSubject(gate);
    if (landed) {
      return this.stop(
        gate,
        answer,
        input.answeredBy,
        alreadyLanded(landed),
        `**${publicNameOf(input.answeredBy)} answered:** ${inertMarkup(answer)}\n\n${landed} is closed, so the task is not resumed: the work it asked about is finished.`,
        record(null),
      );
    }

    const request = await this.planChangeOf(gate);
    // Nothing else is decided on a person's behalf: not a refusal, which
    // stops the work, and not an answer to any other question.
    if (input.decided && !(request && answer === PLAN_CHANGE_APPROVE)) {
      throw new Error(`only a plan change's approval is given without a person answering; this gate was answered "${answer}"`);
    }
    // A person already approved it and it waits on another lease: nothing is left to decide.
    if (input.decided && request?.held) return { answer, taskId: null, held: true };

    if (request && answer === PLAN_CHANGE_REFUSE) return this.refuse(gate, input.answeredBy, { ...record('plan_change_refused'), paths: request.paths });

    // A person already approved this, and it waits on another lease. Closing the
    // gate on a stray comment ("any news?") would resume the task without the
    // paths and drop the approval without a word.
    if (request?.held && answer !== PLAN_CHANGE_APPROVE) {
      const approval = `**${publicNameOf(input.answeredBy)} commented**, which changes nothing: ${publicNameOf(request.held.approvedBy)}'s approval of ${pathList(request.paths)}`;
      await this.say(
        gate,
        request.held.failed
          ? `${approval} is kept, but adding the paths failed; the console says why. Reply \`Approve\` to try again, or \`Refuse\` to stop the task.`
          : `${approval} is still waiting for ${request.held.blockedBy.map((number) => `#${number}`).join(', ')} to let go of overlapping paths. ` +
              'It goes on by itself once they do; reply `Refuse` to stop the task instead.',
      );
      return { answer, taskId: null, held: true };
    }

    if (request && answer === PLAN_CHANGE_APPROVE) {
      const approved = await this.approve(gate, request, input.answeredBy);
      if (approved.held) return { answer, taskId: null, held: true };
      // Applied only by the answer that claims the gate. Two answers at once (a
      // console click and a reply on the issue) both read the gate open, and
      // both edited the issue and widened the lease before one of them lost.
      return this.applyApproval(
        gate,
        request,
        input.answeredBy,
        { ...record('plan_change_approved'), paths: request.paths, ...(input.decided ? { decided: input.decided } : {}) },
        approved.apply,
      );
    }

    // The cost-cap gate. "continue" resumed the task with the cap where it
    // was, so the session stopped again on its first headroom check;
    // the other two resumed it as well, only for it to ask the same question.
    const atCap = costCapAnswer(answer, gate.options);
    if (atCap && 'end' in atCap) return this.endAtCap(gate, atCap.end, input.answeredBy, record('stopped'));
    const taskId = gate.taskId;
    if (atCap && taskId) {
      // Raised only once this answer has claimed the gate: two answers at once
      // (a console click and a reply of `1` on the issue) both got past the
      // open check above and both raised, while only one of them resumed.
      // And by the per-task cap — the lower of the global and the repository's —
      // never the amount the gate names: that is text a session wrote.
      const held = await tasks.getTask(taskId);
      const step = await spendingLimits.effectiveTaskCap(held?.repoId ?? null, this.perTaskCapUsd);
      // A continue is new spend, so it is held to the month's caps the way a
      // new task is. Without this, once the month's ceiling had stopped all
      // new work, anyone who may answer kept a running task spending another
      // step, again and again, with no admin asked and nothing audited.
      // Asked before the gate is claimed: a held answer leaves it open.
      const overCap = held ? await this.monthlyRefusal(held) : null;
      if (overCap && input.role !== 'admin') {
        await this.say(gate, capHeldText(input.answeredBy, overCap));
        if (gate.threadId) {
          await threads.addMessage({
            threadId: gate.threadId,
            kind: 'sys',
            author: 'openadlc',
            text: capHeldText(input.answeredBy, overCap),
            payload: { gateId: gate.id },
          });
        }
        return { answer, taskId: null, held: true };
      }
      return this.close(gate, answer, input.answeredBy, null, record('cap_raised'), async () => {
        const cap = await tasks.raiseCostCap(taskId, step);
        if (cap !== null && overCap) await this.recordBypass(gate, taskId, input.answeredBy, overCap);
        return cap === null ? null : `The task's cap is now $${cap}.`;
      });
    }
    return this.close(gate, answer, input.answeredBy, null, record(null));
  }

  /**
   * The words of the monthly cap (global, repository, bot or provider) that
   * refuses the task more spend, or null when none does or none is configured.
   * The same question a new task's start asks (`TaskService.startTask`).
   */
  private async monthlyRefusal(task: { botId: string; repoId: string | null }): Promise<string | null> {
    if (!this.monthly) return null;
    const bot = await bots.getBotById(task.botId);
    if (!bot) return null;
    const repo = task.repoId ? (await repos.listRepos({ includeRemoved: true })).find((entry) => entry.id === task.repoId) : null;
    return spendingLimits.refusal({
      monthlyCapUsd: this.monthly.monthlyCapUsd,
      onCap: this.monthly.onCap,
      period: costs.currentPeriod(),
      repoId: repo?.id ?? null,
      repoLabel: repo?.fullName ?? '',
      botId: bot.id,
      botName: bot.name,
      engine: bot.engine,
    });
  }

  /**
   * An admin's continue past a monthly cap, written down where a person
   * reviewing spend looks and on the task's thread, in the shape a start past
   * a cap is (`CapBypass` in task-service.ts).
   */
  private async recordBypass(gate: GateRef, taskId: string, admin: string, refusal: string): Promise<void> {
    const task = await tasks.getTask(taskId);
    const bot = task ? await bots.getBotById(task.botId) : null;
    await audit({
      actor: admin,
      action: 'spending.cap_bypassed',
      target: task?.subjectRef ?? taskId,
      payload: { taskId, bot: bot?.name ?? null, kind: task?.kind ?? null, refusal, why: 'an admin continued it at its cost cap' },
    }).catch((error: unknown) => console.warn(`[bridge] could not audit the continue past the cap: ${error instanceof Error ? error.message : error}`));
    if (gate.threadId) {
      await threads.addMessage({
        threadId: gate.threadId,
        kind: 'sys',
        author: 'openadlc',
        text: `${admin} answered continue, and the task went on past a spending cap: ${refusal}`,
        payload: { gateId: gate.id },
      });
    }
    console.warn(`[bridge] ${task?.subjectRef ?? taskId}: continued past a spending cap by ${admin}: ${refusal}`);
  }

  /**
   * A gate shaped like the cost-cap question offers what "continue" will
   * actually add. The options arrive from the session, which could name any
   * amount; a person agreeing to "another $1000" would otherwise be granted
   * something else without being told.
   */
  private capOffer(options: string[], stepUsd: number): string[] {
    const [more] = options;
    const shaped = more ? costCapAnswer(more, options) : null;
    if (!shaped || !('raiseUsd' in shaped)) return options;
    return [`continue for another $${stepUsd}`, ...options.slice(1)];
  }

  /**
   * Grants the approved requests that were waiting on another lease, once the
   * paths are free, and answers their gates. Returns the tasks to resume.
   *
   * Called whenever work ends: a task, a pull request closing, a verification.
   * A request still blocked stays as it was, and a person answering `Approve`
   * again tries it at once.
   */
  async applyHeld(): Promise<string[]> {
    const resume: string[] = [];
    for (const { gateId, request } of await leases.listHeldPlanChanges()) {
      try {
        const gate = await threads.getGate(gateId);
        if (!gate || gate.state !== 'open' || !request.held) continue;
        const approved = await this.approve(gate, request, request.held.approvedBy);
        if (approved.held) continue;
        const done = await this.applyApproval(
          gate,
          request,
          request.held.approvedBy,
          { via: 'held', grant: 'plan_change_approved', paths: request.paths },
          approved.apply,
        );
        if (done.taskId) resume.push(done.taskId);
      } catch (error) {
        console.warn(`[bridge] could not apply the plan change on gate ${gateId}: ${error instanceof Error ? error.message : error}`);
      }
    }
    return resume;
  }

  /**
   * Carries out an approval whose paths are free, as the answer that claims
   * the gate. When that fails, `close` hands the claim back and the question
   * is open again; an approval that had waited still named what it waited on,
   * so its card went on saying it would go on by itself once #71 let go, with
   * nothing to press and the failure only in the log. It is recorded instead,
   * and the card asks again with the reason (`attention.ts`).
   */
  private async applyApproval(
    gate: GateRef,
    request: leases.PlanChangeRecord,
    approvedBy: string,
    record: AnswerRecord,
    apply: () => Promise<string>,
  ): Promise<{ answer: string; taskId: string | null; github?: () => Promise<void> }> {
    try {
      return await this.close(gate, PLAN_CHANGE_APPROVE, approvedBy, null, record, apply);
    } catch (error) {
      if (request.held) await this.notApplied(gate, request.held, approvedBy, error).catch(() => undefined);
      throw error;
    }
  }

  /** Records, once for each reason, that a waiting approval could not be carried out, and says so in the thread. */
  private async notApplied(gate: GateRef, was: leases.PlanChangeHold, approvedBy: string, error: unknown): Promise<void> {
    if ((await threads.getGate(gate.id))?.state !== 'open') return;
    const why = redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 500);
    if (was.failed === why && was.blockedBy.length === 0) return;
    if (!(await leases.holdPlanChange(gate.id, { approvedBy, blockedBy: [], failed: why }, was))) return;
    if (!gate.threadId) return;
    await threads.addMessage({
      threadId: gate.threadId,
      kind: 'sys',
      author: 'openadlc',
      text: `${approvedBy} approved the plan change and nothing holds its paths now, but adding them failed. Approve again to try once more, or Refuse to stop the task`,
      note: why,
      payload: { gateId: gate.id },
    });
  }

  private async planChangeOf(gate: { id: string; options: string[] }): Promise<leases.PlanChangeRecord | null> {
    // A plan-change gate always has exactly these two choices, so one that does
    // not is not looked up.
    const [approve, refuse] = gate.options;
    if (gate.options.length !== 2 || approve !== PLAN_CHANGE_APPROVE || refuse !== PLAN_CHANGE_REFUSE) return null;
    return leases.planChangeOfGate(gate.id);
  }

  /** A line on the gate's issue, as the task's bot. Nothing when the gate is not on an issue. */
  private async say(gate: GateRef, text: string): Promise<void> {
    await this.onIssue(gate, 'a comment', (client, repoFullName, issueNumber) => client.comment(repoFullName, issueNumber, text));
  }

  /**
   * Writes on the gate's issue as the task's bot. Nothing when the gate is not
   * on an issue, or its bot is not connected.
   *
   * An issue labelled `openadlc:ignore` gets nothing either. `open` keeps the
   * question off such an issue, and the answer that followed still posted
   * "answered … Resuming." and took `needs-human` off; a stop posted its own
   * comment. The label is checked again at each write, since it can be added
   * while the gate is open, and what was left off is said in the thread.
   */
  private async onIssue(
    gate: GateRef,
    what: string,
    write: (client: GitHubClient, repoFullName: string, issueNumber: number) => Promise<unknown>,
  ): Promise<void> {
    const task = gate.taskId ? await tasks.getTask(gate.taskId) : null;
    const bot = task ? await bots.getBotById(task.botId) : null;
    const repo = task?.repoId ? (await repos.listRepos()).find((entry) => entry.id === task.repoId) : null;
    const issueNumber = Number(task?.subjectRef.split('#')[1] ?? '0');
    if (!task || !bot || !repo || !issueNumber) return;
    const client = await this.actors.asBot(bot.name);
    if (!client) return;
    if (await this.labelledIgnore(client, repo, issueNumber)) {
      if (gate.threadId) {
        await threads.addMessage({
          threadId: gate.threadId,
          kind: 'sys',
          author: 'openadlc',
          text: `Nothing was written on ${task.subjectRef}: the issue is labelled openadlc:ignore, which the crew leaves alone`,
          note: `left off: ${what}`,
          payload: { gateId: gate.id },
        });
      }
      return;
    }
    await write(client, repo.fullName, issueNumber);
  }

  /**
   * Says, loudly and in the task's thread, that a gate is closed with nothing
   * applied. Without it the gate reads as answered, the task stays paused, and
   * nobody is asked again.
   */
  private async stranded(gate: GateRef, answer: string, answeredBy: string, error: unknown): Promise<void> {
    const why = error instanceof Error ? error.message : String(error);
    console.error(
      `[bridge] gate ${gate.id}: ${answeredBy} answered "${answer}", carrying it out failed (${why}), and the gate could not be reopened. ` +
        'It is closed with nothing applied; the task stays paused until a person acts.',
    );
    if (!gate.threadId) return;
    await threads
      .addMessage({
        threadId: gate.threadId,
        kind: 'sys',
        author: 'openadlc',
        text:
          `${answeredBy} answered "${answer}", but carrying it out failed and the question could not be reopened, so nothing it asked for was applied. ` +
          'Stop the task and start it again, or make the change by hand.',
        note: why,
        payload: { gateId: gate.id },
      })
      .catch((failure: unknown) =>
        console.error(`[bridge] could not say so in the thread either: ${failure instanceof Error ? failure.message : failure}`),
      );
  }

  /**
   * The audit row of an answer that claimed its gate, written where the claim
   * is, whichever route the answer came by. Only the console's gate route
   * wrote one, and most answers come from the item view, a thread or GitHub:
   * an approved plan change or a raised cap left nothing in the audit log.
   * After the claim the gate is answered, so a failed write is logged, not
   * thrown: an error then would invite a second answer to a closed gate.
   */
  private async audited(gate: GateRef, answer: string, answeredBy: string, record: AnswerRecord): Promise<void> {
    try {
      const task = gate.taskId ? await tasks.getTask(gate.taskId).catch(() => null) : null;
      await audit({
        actor: answeredBy,
        action: 'gate.answer',
        target: gate.id,
        payload: {
          gateId: gate.id,
          taskId: gate.taskId,
          subject: task?.subjectRef ?? null,
          answer,
          grant: record.grant,
          channel: record.via,
          ...(record.paths ? { paths: [...record.paths] } : {}),
          // Who decided a plan change: a person, the designer or a standing
          // approval, with the seat or the person who left it on.
          ...(record.grant === 'plan_change_approved' || record.grant === 'plan_change_refused' ? { decidedBy: record.decided?.by ?? 'person' } : {}),
          ...(record.decided?.by === 'standing_approval' ? { standingApproval: { setBy: record.decided.setBy, setAt: record.decided.setAt } } : {}),
          ...(record.decided?.by === 'designer'
            ? { designer: { seat: record.decided.seat, taskId: record.decided.taskId, askedBy: record.decided.askedBy } }
            : {}),
        },
      });
    } catch (error) {
      console.error(`[bridge] gate ${gate.id}: ${answeredBy}'s answer was taken, but its audit row was not written: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * The tail every answer shares: record it, tell the issue, and hand back what
   * to resume. With `deferGitHub`, telling the issue is handed back too, as
   * `github`, and the answer is in the thread before it.
   */
  private async close(
    gate: GateRef,
    answer: string,
    answeredBy: string,
    note: string | null,
    record: AnswerRecord,
    /**
     * What only the answer that claimed the gate may do; what it returns is
     * said with the answer. When it fails the claim is handed back, so the
     * gate can be answered again to finish it.
     */
    afterClaim?: () => Promise<string | null>,
  ): Promise<{ answer: string; taskId: string | null; github?: () => Promise<void> }> {
    const answered = await threads.answerGate(gate.id, answer, answeredBy);
    if (!answered) throw new Error('gate is no longer open');
    await this.audited(gate, answer, answeredBy, record);
    // A person answering the design's question takes the design: what it
    // proposed for the repository to remember is accepted (`design-memory.ts`).
    await acceptOnAnswer(gate.taskId, answeredBy).catch(() => 0);
    if (afterClaim) {
      try {
        note = (await afterClaim()) ?? note;
      } catch (error) {
        const reopened = await threads.reopenGate(gate.id, answer, answeredBy).catch(() => false);
        // This answer holds the claim, so nothing else can have answered it
        // since: not reopening is a failure, and it leaves a gate answered with
        // nothing it asked for applied and no way to answer it again.
        if (!reopened) await this.stranded(gate, answer, answeredBy, error);
        throw error;
      }
    }

    // The gate is claimed and the answer applied, so a GitHub write that
    // fails from here on does not undo it. It used to escape: no caller
    // reached its resume, the gate could not be answered again, and the task
    // stayed paused for good with nothing said. Each write is tried on its
    // own, and what was left off is said in the thread.
    const left: string[] = [];
    let why = '';
    const failed = (what: string) => (error: unknown) => {
      left.push(what);
      why ||= error instanceof Error ? error.message : String(error);
    };
    const task = gate.taskId ? await tasks.getTask(gate.taskId) : null;
    // `needs-human` comes off only when this question put it there and no
    // other question on the subject is still waiting: a person's hold on a
    // pull request, or another bot's open question, keeps it.
    const ours = gate.addedNeedsHuman !== false;
    let takeOff = ours;
    if (ours && task) {
      try {
        takeOff = !(await threads.listOpenGatesOnSubject(task.subjectRef)).some((other) => other.id !== gate.id);
      } catch {
        // Whether another question waits cannot be read: the label stays.
        takeOff = false;
      }
    }
    // An approval no person typed says who gave it, and what was asked.
    const decided = record.decided ? decidedWords(record.decided, gate) : null;
    if (record.decided) {
      await leases
        .notePlanChange(gate.id, 'decided', { ...record.decided, at: new Date().toISOString() })
        .catch((error: unknown) => console.warn(`[bridge] gate ${gate.id}: who decided it was not noted: ${error instanceof Error ? error.message : error}`));
    }
    const write = () =>
      this.onIssue(gate, takeOff ? 'the answer, and taking needs-human off' : 'the answer', async (client, repoFullName, issueNumber) => {
        // Posted as the task's bot: a marker in a person's answer would read as
        // the bot's own (`inertMarkup`).
        await client
          .comment(repoFullName, issueNumber, `${decided?.comment ?? `**${publicNameOf(answeredBy)} answered:** ${inertMarkup(answer)}`}${note ? `\n\n${note}` : ''}\n\nResuming.`)
          .catch(failed('the answer was not posted'));
        if (takeOff) await client.removeLabel(repoFullName, issueNumber, 'needs-human').catch(failed('needs-human is still on'));
      }).catch(failed('nothing was written'));
    const sayWhatWasLeft = async () => {
      if (left.length > 0) {
        await this.notOnGitHub(gate, task?.subjectRef ?? null, `${left.join(', and ')}. The answer stands and the task goes on`, why);
      }
    };
    if (!record.deferGitHub) await write();

    if (gate.threadId) {
      await threads.addMessage({
        threadId: gate.threadId,
        kind: decided ? 'sys' : 'you',
        author: decided ? 'openadlc' : answeredBy,
        text: decided?.line ?? answer,
        payload: { gateId: gate.id },
      });
    }
    if (!record.deferGitHub) await sayWhatWasLeft();

    // Back to triage, which the caller resumes with the answer in `request.md`.
    if (task) await moveRequest(task, 'draft').catch((error: unknown) => requestNotMoved(task.subjectRef, error));

    const github = async (): Promise<void> => {
      await write();
      await sayWhatWasLeft();
    };
    return { answer, taskId: gate.taskId, ...(record.deferGitHub ? { github } : {}) };
  }

  /**
   * The issues whose work claims a path this request asks for: another lease on
   * the repository, or a change in build or review that declared or touched it.
   * The lease says a path is held, and the work in flight is what a lease that
   * outlived its task is holding it for.
   */
  private async blockers(lease: Lease, paths: readonly string[]): Promise<number[]> {
    const held = (await leases.listActiveLeases(lease.repoId)).map((other) => ({
      number: other.issueNumber,
      paths: other.declaredPaths,
    }));
    const working = await issues.workInFlight(lease.repoId);
    const numbers = [...held, ...working]
      .filter((work) => work.number !== lease.issueNumber && declaredPathsOverlap(paths, work.paths))
      .map((work) => work.number);
    return [...new Set(numbers)].sort((a, b) => a - b);
  }

  /**
   * A person's approval: held when another lease has a path it asks for, which
   * leaves the gate open, or else the work that carries it out, for the answer
   * that claims the gate to run. That widens the lease and the issue together,
   * and writes the paths into the issue's Expected paths on GitHub, which is
   * where a person reads them; the lease is what the merge line holds the
   * pull request to (`mergeDecision`). Every step can be repeated, so an
   * approval that fails part-way is finished by answering it again.
   */
  private async approve(
    gate: GateRef,
    request: leases.PlanChangeRecord,
    approvedBy: string,
  ): Promise<{ held: true } | { held: false; apply: () => Promise<string> }> {
    const task = gate.taskId ? await tasks.getTask(gate.taskId) : null;
    const repo = task?.repoId ? (await repos.listRepos()).find((entry) => entry.id === task.repoId) : null;
    const issueNumber = task ? await issueOfTask(task) : 0;
    const lease = task?.leaseId ? await leases.getLease(task.leaseId) : null;
    const bot = task ? await bots.getBotById(task.botId) : null;

    if (!task || !repo || !bot || !issueNumber || !lease || !HELD_LEASE_STATES.includes(lease.state)) {
      return { held: false, apply: async () => LEASE_GONE };
    }

    const blockedBy = await this.blockers(lease, request.paths);
    if (blockedBy.length > 0) {
      const stillWaiting =
        request.held?.blockedBy.length === blockedBy.length && request.held.blockedBy.every((number, i) => number === blockedBy[i]);
      // A retry runs whenever any work ends, so it speaks only when what it waits
      // on has changed: once per event, not once per unrelated task that ends.
      // So does a person approving again: #27 was approved three times while
      // #71 held its paths, from a card that still asked, and got the same
      // comment each time. Needs you shows it as waiting (`attention.ts`).
      if (stillWaiting) return { held: true };
      // Two approvals at once both read the same hold: only the one whose
      // write lands tells the issue.
      if (!(await leases.holdPlanChange(gate.id, { approvedBy, blockedBy }, request.held))) return { held: true };
      const waiting = blockedBy.map((number) => `#${number}`).join(', ');
      await this.say(
        gate,
        `**${publicNameOf(approvedBy)} approved** adding ${pathList(request.paths)}, but ${waiting} holds paths that overlap ${request.paths.length === 1 ? 'it' : 'them'}. ` +
          'The task stays paused until that work lets go of them; then the paths are added and the task goes on, with nothing more to answer.',
      );
      if (gate.threadId) {
        await threads.addMessage({
          threadId: gate.threadId,
          kind: 'sys',
          author: 'openadlc',
          text: `${approvedBy} approved the plan change; waiting for ${waiting} to let go of overlapping paths`,
          payload: { gateId: gate.id },
        });
      }
      return { held: true };
    }

    return {
      held: false,
      apply: () =>
        this.widen({
          subjectRef: `${repo.name}#${issueNumber}`,
          repoId: repo.id,
          repoFullName: repo.fullName,
          issueNumber,
          bot,
          leaseId: lease.id,
          paths: request.paths,
        }),
    };
  }

  /** The approval's writes: the issue's Expected paths on GitHub, then the lease. */
  private async widen(on: {
    subjectRef: string;
    repoId: string;
    repoFullName: string;
    issueNumber: number;
    bot: NonNullable<Awaited<ReturnType<typeof bots.getBotById>>>;
    leaseId: string;
    paths: string[];
  }): Promise<string> {
    const { subjectRef, repoId, repoFullName, issueNumber, bot, leaseId, paths } = on;
    const reader = await this.actors.asBot(bot.name);
    // A seat that is not connected is a person's to fix, so the route answers
    // a conflict with the words that say how: Approve with the builder signed
    // out answered 500 on 2026-10-22, the right words said as a crash.
    if (!reader) {
      throw new HttpFailure(
        409,
        `${botAtStart(bot)} is not connected to GitHub, so the Expected paths of ${subjectRef} cannot be updated. Run: openadlc auth login --bot ${bot.name}`,
      );
    }
    // GitHub first: the reconciler rewrites the issue's paths from its body, so
    // widening the rows before the body would let it narrow them again while the
    // lease stayed wide. Every step here can be repeated.
    const issue = await reader.getIssue(repoFullName, issueNumber);
    // On a stranger's issue, the text a person vouched for, not the author's
    // later edit: written back as a crew seat, the edit would be laundered
    // into the crew's own text (`learnIssue`).
    const vouched = (await issues.getIssue(repoId, issueNumber).catch(() => null))?.vouched ?? null;
    const current = vouched ? vouched.body : (issue.body ?? '');
    const body = addExpectedPaths(current, paths);
    if (body !== current) {
      // The edit is signed as the seat that edits it, and a body carries the tag
      // of the seat that wrote it: edited as another, it fails `verifyBody` with
      // `seat-mismatch` and the `edited` delivery is refused as unverified.
      const seat = seatOf(current);
      const editor = seat && seat !== bot.name ? await this.actors.asBot(seat) : reader;
      if (!editor) {
        throw new HttpFailure(
          409,
          `${seat} wrote ${subjectRef}, and only ${seat} can edit it without breaking its signature, but ${seat} is not connected to GitHub. Run: openadlc auth login --bot ${seat}`,
        );
      }
      await editor.updateIssueBody(repoFullName, issueNumber, body);
      if (vouched) await issues.setVouched(repoId, issueNumber, { title: vouched.title, body, by: bot.name });
    }

    // The lease can end between the overlap check and here, after the body was
    // edited. The body is what the reconciler reads, so the paths then stay
    // listed on an issue nobody holds a lease on; the next lease starts from it.
    const widened = await leases.widenPaths(leaseId, paths);
    if (!widened) return LEASE_GONE;

    return `Added to Expected paths: ${pathList(paths)}.`;
  }

  /** A refusal ends the task; `TaskService.resume` cleans it up instead of starting it. */
  private refuse(gate: GateRef, refusedBy: string, record: AnswerRecord): Promise<{ answer: string; taskId: string | null; github?: () => Promise<void> }> {
    // `needs-human` stays: taking it off would hand the issue back to the
    // dispatcher, which would lease it again and ask for the same paths.
    return this.stop(
      gate,
      PLAN_CHANGE_REFUSE,
      refusedBy,
      `${REFUSED} by ${refusedBy}`,
      `**${publicNameOf(refusedBy)} refused** the plan change. The task is stopped and its lease released. ` +
        '`needs-human` stays on the issue until a person changes its Expected paths or the plan.',
      record,
    );
  }

  /** Handing off or abandoning at the cap ends the task as a refusal does, and keeps `needs-human` for the same reason. */
  private async endAtCap(
    gate: GateRef,
    answer: string,
    answeredBy: string,
    record: AnswerRecord,
  ): Promise<{ answer: string; taskId: string | null; github?: () => Promise<void> }> {
    const what = answer === COST_CAP_ABANDON ? 'abandoned the task' : 'took the task over';
    const stopped = await this.stop(
      gate,
      answer,
      answeredBy,
      `${STOPPED_AT_CAP}: ${answer} (${answeredBy})`,
      `**${publicNameOf(answeredBy)} ${what}** at its cost cap. The task is stopped and its lease released. ` +
        '`needs-human` stays on the issue until a person picks it up.',
      record,
    );
    // A console request has no issue to carry `needs-human`. Left in
    // `questions`, it waited for good on an answer already given.
    const task = gate.taskId ? await tasks.getTask(gate.taskId) : null;
    if (task) await moveRequest(task, 'abandoned').catch((error: unknown) => requestNotMoved(task.subjectRef, error));
    return stopped;
  }

  /** Answers the gate with an answer that ends its task, which `TaskService.resume` then cleans up. */
  private async stop(
    gate: GateRef,
    answer: string,
    answeredBy: string,
    exitReason: string,
    comment: string,
    record: AnswerRecord,
  ): Promise<{ answer: string; taskId: string | null; github?: () => Promise<void> }> {
    const answered = await threads.answerGate(gate.id, answer, answeredBy);
    if (!answered) throw new Error('gate is no longer open');
    await this.audited(gate, answer, answeredBy, record);

    const task = gate.taskId ? await tasks.getTask(gate.taskId) : null;
    let github: (() => Promise<void>) | undefined;
    if (task) {
      await tasks.updateTaskState(task.id, 'stopped', { exitReason });
      if (task.leaseId) {
        const released = await leases.setLeaseState(task.leaseId, 'released').catch(() => null);
        if (released) this.leaseReleased?.(`${task.kind} task stopped by ${answeredBy}`);
      }

      // The task is stopped already: a comment that fails must not skip the
      // caller's clean-up of its worktree.
      github = async () => {
        const why = await this.say(gate, comment).then(
          () => null,
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
        if (why !== null) await this.notOnGitHub(gate, task.subjectRef, 'why the task stopped was not said. The task is stopped all the same', why);
      };
      if (!record.deferGitHub) await github();
    }

    if (gate.threadId) {
      await threads.addMessage({
        threadId: gate.threadId,
        kind: 'you',
        author: answeredBy,
        text: answer,
        payload: { gateId: gate.id },
      });
    }
    return { answer, taskId: gate.taskId, ...(record.deferGitHub && github ? { github } : {}) };
  }

  /**
   * Says, in the log and the task's thread, what an answer could not write on
   * GitHub, so a person can see the comment or the label change is missing.
   */
  private async notOnGitHub(gate: GateRef, subjectRef: string | null, what: string, why: string): Promise<void> {
    const text = `On ${subjectRef ?? 'GitHub'}, ${what}.`;
    console.error(`[bridge] gate ${gate.id}: ${text} (${why})`);
    if (!gate.threadId) return;
    await threads
      .addMessage({ threadId: gate.threadId, kind: 'sys', author: 'openadlc', text, note: why, payload: { gateId: gate.id } })
      .catch((failure: unknown) =>
        console.error(`[bridge] could not say so in the thread either: ${failure instanceof Error ? failure.message : failure}`),
      );
  }

  /**
   * Who a plan-change request is addressed to. When the issue had a design pass,
   * whoever answered its spec gate; otherwise whoever filed the console request
   * it came from. Nobody when neither is known: any person with access answers.
   *
   * Either may be a console identity, which is an email. It is turned into the
   * GitHub login that email belongs to, or into nobody (null) when GitHub knows
   * none. Undefined is a record that names nobody at all.
   */
  private async whoDecides(
    subjectRef: string,
    repo: { id: string; fullName: string },
    issueNumber: number,
    botName: string,
  ): Promise<string | null | undefined> {
    try {
      const onSubject = await tasks.listTasksOnSubjects([subjectRef]);
      const specIds = new Set(onSubject.filter((task) => task.kind === 'spec').map((task) => task.id));
      if (specIds.size > 0) {
        const answered = (await threads.listGatesForSubject(subjectRef)).filter(
          (gate) => gate.taskId && specIds.has(gate.taskId) && gate.answeredBy,
        );
        const last = answered.at(-1)?.answeredBy;
        if (last) return await this.loginOf(last, botName);
      }
      const issue = await issues.getIssue(repo.id, issueNumber);
      const prefix = /\brequest:([0-9a-f]{8})\b/i.exec(issue?.body ?? '')?.[1];
      const requester = prefix ? (await requests.findRequestByPrefix(prefix))?.requestedBy : null;
      if (requester) return await this.loginOf(requester, botName);
      return (await this.filedBy(repo.fullName, issueNumber, botName)) ?? undefined;
    } catch (error) {
      console.warn(`[bridge] could not tell who decides a plan change on ${subjectRef}: ${error instanceof Error ? error.message : error}`);
      return undefined;
    }
  }

  /**
   * The GitHub login behind who answered or asked, when it can be known: a login
   * is itself, and an email is the one account GitHub lists with it as a public,
   * verified address. Anything else, and an email no account or several claim,
   * is nobody, so the question mentions nobody rather than an address.
   */
  private async loginOf(who: string, botName: string): Promise<string | null> {
    const name = who.trim();
    if (GITHUB_LOGIN.test(name)) return name;
    if (!EMAIL.test(name)) return null;
    const client = await this.actors.asBot(botName);
    if (!client) return null;
    const found = await client
      .request<{ items?: { login: string; type?: string }[] }>(
        'GET',
        `/search/users?q=${encodeURIComponent(`${name} in:email`)}&per_page=2`,
      )
      .catch(() => null);
    const people = (found?.items ?? []).filter((item) => item.type !== 'Bot');
    const login = people.length === 1 ? people[0]!.login : null;
    if (!login) return null;
    // The record named a person: a crew list that cannot be read is nobody to
    // mention, not a reason to fall back to the person the bot named.
    const crew = await bots.listBots().catch(() => null);
    if (!crew || isCrewLogin(crew, login)) return null;
    return login;
  }

  /** The person who filed the issue on GitHub, when they have access to the repository. A bot that filed it is nobody's owner. */
  private async filedBy(repoFullName: string, issueNumber: number, botName: string): Promise<string | null> {
    const client = await this.actors.asBot(botName);
    if (!client) return null;
    const filed = await client.request<{ user: { login: string } | null; author_association?: string }>(
      'GET',
      `/repos/${repoFullName}/issues/${issueNumber}`,
    );
    const login = filed.user?.login;
    if (!login || !hasAccess(filed.author_association)) return null;
    return isCrewLogin(await bots.listBots(), login) ? null : login;
  }
}
