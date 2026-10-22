import { audit, bots, issues, leases, repos, standingApprovals, tasks, threads, type Role, type StandingApproval } from '@openadlc/db';
import type { GitHubClient } from '@openadlc/github';
import {
  PLAN_CHANGE_APPROVE,
  PLAN_CHANGE_REFUSE,
  PLAN_CHANGE_REVIEW_SKILL,
  designerLimits,
  hasIgnoreLabel,
  inertMarkup,
  keepsForPerson,
  keptForPerson,
  outsideInWords,
  parseMarkers,
  parsePlanChangeVerdict,
  pathsNamedIn,
  seatOf,
  verifyBody,
  withoutExpectedPaths,
  withoutMarker,
  type ContextDocument,
  type HumanReviewRule,
  type KeptForPerson,
  type SigningKey,
} from '@openadlc/shared';
import type { Actors } from './actors.js';
import { issueOfTask, type GateChannel, type Gates, type StandingCover } from './gates.js';
import { HttpFailure, type Router } from './router.js';
import type { TaskService } from './task-service.js';
import { publicNameOf } from './thread-view.js';

/**
 * Settling a builder's plan changes without a person answering each one
 * (#77). On 2026-10-22, #27 and #45 each asked for several paths beyond their
 * lease, one after another, and each waited on a person.
 *
 * - **Approve all for this work.** A person approves a request and leaves a
 *   standing approval on its issue: later requests from its builder are
 *   approved as they are asked (`Gates.open`, through `standingCoverFor`),
 *   until its pull request merges or closes, the issue closes, or a person
 *   turns it off. A path under Human review in `AGENTS.md` always asks a
 *   person, and each approval still posts its record on the issue and an
 *   audit row naming the standing approval and who set it.
 * - **Ask the designer.** A short task on the design seat (the `spec` role,
 *   skill `plan-change-review`) reads the issue's design, the builder's reason
 *   and the paths, and ends with a verdict marker. An approval counts as the
 *   decision only for paths the design names or that sit beside them, never
 *   for a Human-review path (`designerLimits`); otherwise it is advice, and
 *   the question stays for a person with the designer's view on the card. A
 *   refusal is advice too: it would stop the work, which a person decides.
 * - **Refusing after the fact.** A person can refuse what the designer or a
 *   standing approval approved: the paths come out of the lease and the
 *   issue's Expected paths, and the task stops, as a refusal stops it.
 *
 * The designer is a task, not a call to a model from the bridge: engines run
 * only in hostd, where the ledger is written before their output is acted
 * on, and a task is how a seat's spend is held to its caps.
 */

export interface PlanChangeDeps {
  gates: Pick<Gates, 'answer'>;
  /**
   * A person's answer from the console, which goes on with the task once it
   * is recorded (`answerFromConsole`): approve all's approval is the person's.
   */
  answerAsPerson(input: { gateId: string; reply: string; answeredBy: string; role?: Role; via: GateChannel }): Promise<{ answer: string; taskId: string | null; held?: boolean }>;
  /** Runs what a route leaves to after it has answered (`Afterwards`); absent, it runs before. */
  later?: (what: string, work: () => Promise<unknown>) => void;
  taskService: Pick<TaskService, 'open' | 'resume'>;
  actors: Pick<Actors, 'asBot'>;
  /** The Human-review rules on a repository's base branch; null when they cannot be read (`Automation.humanReviewRules`). */
  humanReviewRules(repoFullName: string, baseRef: string): Promise<HumanReviewRule[] | null>;
  /** The keys a crew post is signed with, which a design comment is checked against; absent where nothing is signed. */
  keyring?: () => Promise<SigningKey[]>;
  /** Stops a task for good, its lease with it (`stopTask` in api.ts). */
  stopTask(taskId: string, actor: string, note: string): Promise<unknown>;
}

const ACTIVE_LEASE: readonly string[] = ['leased', 'in_task', 'paused'];
const LIVE_TASK: readonly string[] = ['queued', 'running', 'paused'];

function pathList(paths: readonly string[]): string {
  return paths.map((path) => `\`${path}\``).join(', ');
}

function warn(what: string): (error: unknown) => void {
  return (error) => console.warn(`[bridge] ${what}: ${error instanceof Error ? error.message : error}`);
}

/**
 * What keeps these paths for a person: those under Human review on the base
 * branch, or every one when the rules cannot be read, which is said as that.
 */
async function keptFor(
  read: PlanChangeDeps['humanReviewRules'],
  repo: { fullName: string; defaultBranch?: string | null },
  paths: readonly string[],
): Promise<KeptForPerson> {
  const base = repo.defaultBranch || 'HEAD';
  const rules = await read(repo.fullName, base).catch(() => null);
  return keptForPerson(paths, rules, repo.defaultBranch || null);
}

/**
 * How `Gates.open` asks whether a standing approval settles a request: null
 * when none is on for the issue; on, it covers the request unless a path is
 * under Human review on the base branch, or the rules cannot be read.
 */
export function standingCoverFor(deps: Pick<PlanChangeDeps, 'humanReviewRules'>): StandingCover {
  return async ({ repoId, repoFullName, issueNumber, paths }) => {
    const on = await standingApprovals.activeFor(repoId, issueNumber);
    if (!on) return null;
    const repo = (await repos.listRepos()).find((entry) => entry.id === repoId);
    const kept = await keptFor(deps.humanReviewRules, { fullName: repoFullName, defaultBranch: repo?.defaultBranch ?? null }, paths);
    return {
      covers: !keepsForPerson(kept),
      setBy: on.setBy,
      setAt: on.setAt,
      humanReview: kept.humanReview,
      ...(kept.rulesUnread ? { rulesUnread: `${kept.rulesUnread.what}, so it does not cover this one and a person decides. ${kept.rulesUnread.fix}` } : {}),
    };
  };
}

/**
 * Ends the standing approval on an issue, if one is on: its pull request
 * merged or closed, or the issue closed. Never in the way of what called it.
 */
export async function endStandingApproval(input: { repoId: string; issueNumber: number; why: string; by?: string; subject?: string }): Promise<void> {
  try {
    const ended = await standingApprovals.turnOff({ repoId: input.repoId, issueNumber: input.issueNumber, by: input.by ?? 'openadlc', why: input.why });
    if (!ended) return;
    await audit({
      actor: input.by ?? 'openadlc',
      action: 'plan_change.standing_off',
      target: input.subject ?? `#${input.issueNumber}`,
      payload: { standingId: ended.id, setBy: ended.setBy, why: input.why },
    }).catch(warn(`the end of the standing approval on #${input.issueNumber} was not audited`));
  } catch (error) {
    warn(`the standing approval on #${input.issueNumber} was not turned off (${input.why})`)(error);
  }
}

interface Work {
  gate: NonNullable<Awaited<ReturnType<typeof threads.getGate>>>;
  request: leases.PlanChangeRecord;
  task: NonNullable<Awaited<ReturnType<typeof tasks.getTask>>>;
  repo: { id: string; name: string; fullName: string; defaultBranch?: string | null };
  issueNumber: number;
  builder: { id: string; name: string } | null;
}

/**
 * How a designer's task that ended without its verdict begins its reason. It
 * ended `done` with nothing said in the builder's thread, and only Needs you
 * said the designer had no answer; a review that leaves no review is failed
 * (`review-left.ts`), and so is this.
 */
export const NO_VERDICT = 'ended without its verdict on the plan change';

/** What the reason quotes of the designer, at most. */
const SAID_LIMIT = 600;

export class PlanChanges {
  constructor(private readonly deps: PlanChangeDeps) {}

  /** The plan change a gate asked, and the work it widens. */
  private async workOf(gateId: string): Promise<Work> {
    const gate = await threads.getGate(gateId);
    if (!gate) throw new HttpFailure(404, 'there is no such question');
    const [approve, refuse] = gate.options;
    const request = gate.options.length === 2 && approve === PLAN_CHANGE_APPROVE && refuse === PLAN_CHANGE_REFUSE ? await leases.planChangeOfGate(gate.id) : null;
    if (!request) throw new HttpFailure(409, 'that question is not a plan change; answer it from its card or the thread');
    const task = gate.taskId ? await tasks.getTask(gate.taskId) : null;
    if (!task) throw new HttpFailure(409, 'the task that asked it is gone; stop it from its card');
    const repo = task.repoId ? (await repos.listRepos()).find((entry) => entry.id === task.repoId) : undefined;
    const issueNumber = await issueOfTask(task);
    if (!repo || !issueNumber) throw new HttpFailure(409, 'the issue this plan change widens cannot be told; answer it on the issue instead');
    const builder = await bots.getBotById(task.botId);
    return { gate, request, task, repo, issueNumber, builder: builder ? { id: builder.id, name: builder.name } : null };
  }

  private open(work: Work): void {
    if (work.gate.state !== 'open') throw new HttpFailure(409, 'that question is no longer open: someone has answered it');
  }

  /** A comment on the issue as one of the crew, unless it is labelled to be left alone. Never thrown. */
  private async say(botName: string | null, repo: Work['repo'], issueNumber: number, text: string): Promise<GitHubClient | null> {
    if (!botName) return null;
    try {
      const stored = await issues.getIssue(repo.id, issueNumber).catch(() => null);
      if (hasIgnoreLabel(stored?.labels)) return null;
      const client = await this.deps.actors.asBot(botName);
      if (!client) return null;
      await client.comment(repo.fullName, issueNumber, text);
      return client;
    } catch (error) {
      warn(`${repo.name}#${issueNumber}: a line about its plan change was not posted`)(error);
      return null;
    }
  }

  private async line(threadId: string | null, gateId: string, text: string, note?: string): Promise<void> {
    if (!threadId) return;
    await threads
      .addMessage({ threadId, kind: 'sys', author: 'openadlc', text, ...(note ? { note } : {}), payload: { gateId } })
      .catch(warn(`gate ${gateId}: a line was not said in its thread`));
  }

  /**
   * "Approve, and any more paths for #N": approves this request, as the
   * person who pressed it, and leaves a standing approval on the issue for
   * the rest of its build. Not left on when the approval did not go through.
   */
  async approveAll(input: { gateId: string; identity: string; role?: Role }): Promise<{ answer: string; taskId: string | null; held?: boolean; standing: StandingApproval }> {
    const work = await this.workOf(input.gateId);
    this.open(work);
    const subject = `${work.repo.name}#${work.issueNumber}`;
    const before = await standingApprovals.activeFor(work.repo.id, work.issueNumber);
    const standing = before ?? (await standingApprovals.turnOn({ repoId: work.repo.id, issueNumber: work.issueNumber, setBy: input.identity, gateId: work.gate.id }));
    let result: { answer: string; taskId: string | null; held?: boolean };
    try {
      // The person's own approval, answered as their Approve is, the task
      // going on once it is recorded.
      result = await this.deps.answerAsPerson({ gateId: work.gate.id, reply: PLAN_CHANGE_APPROVE, answeredBy: input.identity, ...(input.role ? { role: input.role } : {}), via: 'console-gate' });
    } catch (error) {
      if (!before) {
        await standingApprovals
          .turnOff({ repoId: work.repo.id, issueNumber: work.issueNumber, by: input.identity, why: 'the approval it was turned on with did not go through' })
          .catch(warn(`${subject}: a standing approval was left on`));
      }
      throw error;
    }
    if (!before) {
      await audit({ actor: input.identity, action: 'plan_change.standing_on', target: subject, payload: { standingId: standing.id, gateId: work.gate.id } }).catch(
        warn(`${subject}: the standing approval was not audited`),
      );
      await this.line(work.gate.threadId, work.gate.id, `${input.identity} turned on approve all for #${work.issueNumber}`);
      const sayIt = () =>
        this.say(
          work.builder?.name ?? null,
          work.repo,
          work.issueNumber,
          `**${publicNameOf(input.identity)} turned on approve all** for #${work.issueNumber}: the builder's later plan changes on it are approved as they are asked, ` +
            'except a path under Human review in AGENTS.md, which still asks a person. Each one is said here. ' +
            'It stays on until the pull request merges or closes, or someone turns it off from the item in the console.',
        );
      if (this.deps.later) this.deps.later('Saying on the issue that approve all is on', sayIt);
      else await sayIt();
    }
    return { ...result, standing };
  }

  /** A person turning the standing approval off, from the card or the item. */
  async turnOff(input: { repoName: string; issueNumber: number; identity: string }): Promise<StandingApproval> {
    const repo = (await repos.listRepos()).find((entry) => entry.name === input.repoName);
    if (!repo) throw new HttpFailure(404, `there is no repository named ${input.repoName}`);
    const ended = await standingApprovals.turnOff({ repoId: repo.id, issueNumber: input.issueNumber, by: input.identity, why: 'turned off by a person' });
    if (!ended) throw new HttpFailure(404, `approve all is not on for #${input.issueNumber}`);
    const subject = `${repo.name}#${input.issueNumber}`;
    await audit({ actor: input.identity, action: 'plan_change.standing_off', target: subject, payload: { standingId: ended.id, setBy: ended.setBy, why: 'turned off by a person' } }).catch(
      warn(`${subject}: turning approve all off was not audited`),
    );
    const lease = await leases.latestLease(repo.id, input.issueNumber).catch(() => null);
    const bot =
      (lease ? await bots.getBotById(lease.botId).catch(() => null) : null) ?? (await bots.listBots().catch(() => [])).find((one) => one.role === 'implement') ?? null;
    await this.say(
      bot?.name ?? null,
      repo,
      input.issueNumber,
      `**${publicNameOf(input.identity)} turned off approve all** for #${input.issueNumber}: the builder's next plan change asks a person again.`,
    );
    return ended;
  }

  /**
   * "Ask the designer": a short task on the design seat that judges this
   * request against the issue's design and ends with its verdict
   * (`crew/skills/plan-change-review/SKILL.md`), which `verdict` acts on.
   */
  async askDesigner(input: { gateId: string; identity: string }): Promise<{ taskId: string; designer: string }> {
    const work = await this.workOf(input.gateId);
    this.open(work);
    if (work.request.held) {
      throw new HttpFailure(409, `${publicNameOf(work.request.held.approvedBy)} approved it already; it waits for other work to let go of its paths`);
    }
    const asked = work.request.designer;
    if (asked && !asked.verdict) {
      const running = await tasks.getTask(asked.taskId).catch(() => null);
      if (running && LIVE_TASK.includes(running.state)) throw new HttpFailure(409, 'the designer is already judging it; its view comes to this card');
    }
    const designer = (await bots.listBots()).find((bot) => bot.role === 'spec');
    if (!designer) throw new HttpFailure(409, 'the crew has no design seat (system engineer) to ask. Add one in Crew, or answer it yourself');

    const subject = `${work.repo.name}#${work.issueNumber}`;
    const { humanReview, rulesUnread } = await keptFor(this.deps.humanReviewRules, work.repo, work.request.paths);
    const brief: ContextDocument = {
      name: 'plan-change.md',
      title: `The plan change you judge, on ${subject}`,
      content: [
        `# A plan change on ${subject}`,
        '',
        `${work.builder?.name ?? 'The builder'} asked to add these paths to the issue's Expected paths and its lease:`,
        '',
        ...work.request.paths.map((path) => `- \`${path}\``),
        '',
        '## Its reason, in its words',
        '',
        work.request.reason.trim() || '_It gave none._',
        '',
        '## What your approval counts for',
        '',
        'OpenADLC takes your approval as the decision only for paths the design names, or that sit beside them: the same package, their tests, the docs. ' +
          'For any other path, and for a refusal, your view is shown to a person, who decides.',
        ...(rulesUnread
          ? ['', `${rulesUnread.what}, so only a person approves these paths, whatever you answer. Judge them all the same: your view is shown to the person.`]
          : humanReview.length > 0
            ? ['', `${pathList(humanReview)} ${humanReview.length === 1 ? 'is' : 'are'} under Human review in AGENTS.md: only a person approves ${humanReview.length === 1 ? 'it' : 'them'}, whatever you answer.`]
            : []),
      ].join('\n'),
    };
    const opened = await this.deps.taskService
      .open({
        bot: designer.name,
        botId: designer.id,
        repo: work.repo.name,
        kind: 'spec',
        subjectType: 'issue',
        subjectRef: subject,
        skill: PLAN_CHANGE_REVIEW_SKILL,
        issueNumber: work.issueNumber,
        extraContext: [brief],
      })
      .catch((error: unknown) => {
        throw new HttpFailure(409, `the designer could not be started: ${error instanceof Error ? error.message : error}. Try again when it is free, or answer it yourself`);
      });
    if (opened.error) throw new HttpFailure(409, `the designer could not be started: ${opened.error}`);

    await leases.notePlanChange(work.gate.id, 'designer', { taskId: opened.taskId, askedBy: input.identity, at: new Date().toISOString() });
    await this.line(work.gate.threadId, work.gate.id, `${input.identity} asked ${designer.name}, the designer, to judge this plan change`);
    await audit({
      actor: input.identity,
      action: 'plan_change.designer_asked',
      target: subject,
      payload: { gateId: work.gate.id, taskId: opened.taskId, designer: designer.name, paths: work.request.paths },
    }).catch(warn(`${subject}: asking the designer was not audited`));
    return { taskId: opened.taskId, designer: designer.name };
  }

  /**
   * The paths the issue's design names: the Expected paths it wrote and every
   * path in its design comment. Only a comment whose signature checks and
   * names a design (`spec`) task on this very issue, as its own seat, is the
   * design: the marker and the login are the poster's word on a shared crew
   * account, and a builder could otherwise post a "design" naming the paths it
   * wants. Null when the issue has no such comment.
   */
  private async designOf(client: GitHubClient | null, repo: Work['repo'], issueNumber: number): Promise<string[] | null> {
    if (!client || !this.deps.keyring) return null;
    const keys = await this.deps.keyring().catch(() => null);
    if (!keys) return null;
    const subject = `${repo.name}#${issueNumber}`;
    const comments = await client.listComments(repo.fullName, issueNumber).catch(() => []);
    for (const comment of [...comments].reverse()) {
      if (!parseMarkers(comment.body).some((marker) => marker.event === 'plan_posted')) continue;
      const signed = verifyBody(comment.body, keys);
      if (!signed.ok || !signed.payload.task) continue;
      if (signed.payload.n && signed.payload.n !== issueNumber) continue;
      const task = await tasks.getTask(signed.payload.task).catch(() => null);
      if (!task || task.kind !== 'spec' || task.skill === PLAN_CHANGE_REVIEW_SKILL || task.subjectRef !== subject) continue;
      const seat = await bots.getBotById(task.botId).catch(() => null);
      if (!seat || seat.name.toLowerCase() !== signed.payload.seat.toLowerCase()) continue;
      const declared = (await issues.getIssue(repo.id, issueNumber).catch(() => null))?.declaredPaths ?? [];
      return [...new Set([...declared, ...pathsNamedIn(comment.body)])];
    }
    return null;
  }

  /**
   * The designer's verdict, from its own session's message. Counted as the
   * decision when it approves and every path is within its limits; advice
   * otherwise, said on the issue and in the thread, and shown on the card.
   * Only the first verdict of a task asked to judge one is taken.
   */
  async verdict(task: { id: string; botId: string; skill: string | null }, text: string): Promise<{ counted: boolean } | null> {
    if (task.skill !== PLAN_CHANGE_REVIEW_SKILL) return null;
    const said = parsePlanChangeVerdict(text);
    if (!said) return null;
    const found = await leases.planChangeOfDesignerTask(task.id);
    if (!found?.request.designer || found.request.designer.verdict) return null;
    const asked = found.request.designer;
    const seat = (await bots.getBotById(task.botId))?.name ?? 'the designer';
    const work = await this.workOf(found.gateId);
    const note = (more: { counted: boolean; outside?: { path: string; why: string }[] }) =>
      leases.notePlanChange(found.gateId, 'designer', { ...asked, verdict: said.verdict, reason: said.reason, ...more });

    if (work.gate.state !== 'open') {
      await note({ counted: false, outside: [] });
      await this.line(work.gate.threadId, work.gate.id, `${seat}, the designer, answered ${said.verdict} after the question was already answered; nothing changed`);
      return { counted: false };
    }

    const client = work.builder ? await this.deps.actors.asBot(work.builder.name).catch(() => null) : null;
    const { humanReview, rulesUnread } = await keptFor(this.deps.humanReviewRules, work.repo, work.request.paths);
    const designPaths = await this.designOf(client, work.repo, work.issueNumber);
    const limits = designerLimits({ paths: work.request.paths, designPaths, humanReview, rulesUnread });

    if (said.verdict === 'approve' && limits.counts) {
      await note({ counted: true, outside: [] });
      try {
        const answered = await this.deps.gates.answer({
          gateId: work.gate.id,
          reply: PLAN_CHANGE_APPROVE,
          answeredBy: seat,
          via: 'designer',
          decided: { by: 'designer', seat, taskId: task.id, askedBy: asked.askedBy, reason: said.reason },
        });
        if (answered.taskId) await this.deps.taskService.resume(answered.taskId).catch(warn(`${work.repo.name}#${work.issueNumber}: the builder did not resume after the designer approved`));
        return { counted: true };
      } catch (error) {
        await note({ counted: false, outside: [] });
        await this.line(work.gate.threadId, work.gate.id, `${seat}, the designer, approved it, but the approval could not be applied, so a person answers it`, error instanceof Error ? error.message : String(error));
        return { counted: false };
      }
    }

    await note({ counted: false, outside: said.verdict === 'approve' ? limits.outside : [] });
    const why = said.reason ? inertMarkup(said.reason) : 'it gave no reason';
    const kept =
      said.verdict === 'approve'
        ? `That does not settle it: ${outsideInWords(limits.outside)}.`
        : 'A refusal stops the task, so a person gives it.';
    await this.say(
      seat === 'the designer' ? (work.builder?.name ?? null) : seat,
      work.repo,
      work.issueNumber,
      `**The designer (${seat}) would ${said.verdict}** this: ${why}\n\n${kept} A person answers \`Approve\` or \`Refuse\` above, or on the card in the console.`,
    );
    await this.line(work.gate.threadId, work.gate.id, `${seat}, the designer, would ${said.verdict} it; a person decides`, said.reason || undefined);
    return { counted: false };
  }

  /**
   * Why a designer's task that ended `done` failed: it was asked to judge a
   * plan change and gave no verdict, with what it last said. Null when it gave
   * one, was not asked to judge one, or that cannot be told: a task is never
   * failed on a guess. The verdict's own message is looked for as well as its
   * note, since the note is written only once the verdict has been acted on.
   */
  async missingVerdict(task: { id: string; botId: string; skill: string | null; subjectRef: string; startedAt: string | null }): Promise<string | null> {
    if (task.skill !== PLAN_CHANGE_REVIEW_SKILL) return null;
    const found = await leases.planChangeOfDesignerTask(task.id);
    if (!found?.request.designer || found.request.designer.verdict) return null;
    const seat = await bots.getBotById(task.botId);
    if (!seat) return null;
    const thread = (await threads.listThreadsForSubject(task.subjectRef)).find((row) => row.bot_id === task.botId);
    const since = task.startedAt ? Date.parse(task.startedAt) : Number.NEGATIVE_INFINITY;
    const said = thread
      ? (await threads.listMessages([thread.id], 50)).filter((message) => message.author === seat.name && Date.parse(message.at) >= since)
      : [];
    if (said.some((message) => parsePlanChangeVerdict(message.text))) return null;
    const last = withoutMarker(said.filter((message) => message.kind === 'bot').at(-1)?.text ?? '').trim();
    if (!last) return NO_VERDICT;
    return `${NO_VERDICT}. It said: “${last.length > SAID_LIMIT ? `${last.slice(0, SAID_LIMIT - 1).trimEnd()}…` : last}”`;
  }

  /**
   * Says in the builder's thread, where the question is, that the designer it
   * was waiting on ended without an answer, and what is left to press. Only
   * its own thread said so, and the builder's said nothing at all. Nothing
   * when it gave a verdict, or the question has been answered since.
   */
  async designerEnded(task: { id: string; botId: string; skill: string | null }, reason: string | null): Promise<void> {
    if (task.skill !== PLAN_CHANGE_REVIEW_SKILL) return;
    const found = await leases.planChangeOfDesignerTask(task.id);
    if (!found?.request.designer || found.request.designer.verdict) return;
    const gate = await threads.getGate(found.gateId);
    if (!gate || gate.state !== 'open') return;
    const seat = (await bots.getBotById(task.botId))?.name ?? 'the design seat';
    await this.line(
      gate.threadId,
      gate.id,
      `${seat}, the designer, ended without an answer, so nothing is settled. Ask the designer again from the card, or answer it yourself`,
      reason ?? undefined,
    );
  }

  /**
   * A person refusing a plan change the designer or a standing approval
   * approved: the paths come out of the lease, the issue's paths and its
   * Expected paths on GitHub, and the task is stopped and its lease let go,
   * as a refusal does. `needs-human` goes on the issue and stays, so the
   * dispatcher does not lease it again to ask for the same paths.
   */
  async takeBack(input: { gateId: string; identity: string }): Promise<{ paths: string[] }> {
    const work = await this.workOf(input.gateId);
    const { gate, request, task, repo, issueNumber } = work;
    if (gate.state !== 'answered' || gate.answer !== PLAN_CHANGE_APPROVE) throw new HttpFailure(409, 'only an approved plan change is refused after the fact; answer an open one from its card');
    if (!request.decided) throw new HttpFailure(409, 'a person approved this plan change; change the issue’s Expected paths, or stop the task, instead');
    if (request.takenBack) throw new HttpFailure(409, `${publicNameOf(request.takenBack.by)} already refused it`);
    const subject = `${repo.name}#${issueNumber}`;
    const who = request.decided.by === 'designer' ? 'the designer' : 'the standing approval';

    // Noted first: a second press while this runs is refused, not run twice.
    await leases.notePlanChange(gate.id, 'takenBack', { by: input.identity, at: new Date().toISOString() });
    await this.deps.stopTask(task.id, input.identity, `plan change refused after the fact by ${input.identity}`).catch(warn(`${subject}: the task was not stopped`));
    const lease = task.leaseId ? await leases.getLease(task.leaseId) : await leases.latestLease(repo.id, issueNumber);
    if (lease) {
      await leases.narrowPaths(lease.id, request.paths);
      if (ACTIVE_LEASE.includes(lease.state)) await leases.setLeaseState(lease.id, 'released').catch(warn(`${subject}: its lease was not let go`));
    }

    const client = work.builder ? await this.deps.actors.asBot(work.builder.name).catch(() => null) : null;
    const left: string[] = [];
    if (client) {
      await this.narrowIssue(client, repo, issueNumber, request.paths, work.builder!.name).catch((error: unknown) => {
        left.push(`the Expected paths on GitHub still list them (${error instanceof Error ? error.message : error})`);
      });
      await client.addLabels(repo.fullName, issueNumber, ['needs-human']).catch(() => left.push('needs-human is not on'));
    } else {
      left.push(`${work.builder?.name ?? 'the builder'} is not connected to GitHub, so the issue was not changed`);
    }
    await this.say(
      work.builder?.name ?? null,
      repo,
      issueNumber,
      `**${publicNameOf(input.identity)} refused** the plan change ${who} approved: ${pathList(request.paths)} ${request.paths.length === 1 ? 'is' : 'are'} taken out of the Expected paths and the lease. ` +
        'The task is stopped and its lease released. `needs-human` stays on the issue until a person changes its Expected paths or the plan.',
    );
    await this.line(gate.threadId, gate.id, `${input.identity} refused the plan change ${who} approved, and took ${pathList(request.paths)} back`, left.join('; ') || undefined);
    await audit({
      actor: input.identity,
      action: 'plan_change.refused_after',
      target: subject,
      payload: { gateId: gate.id, taskId: task.id, paths: request.paths, decidedBy: request.decided.by },
    }).catch(warn(`${subject}: the refusal was not audited`));
    return { paths: request.paths };
  }

  /** The issue's Expected paths on GitHub without these, edited as the seat that wrote the body, as an approval's widening is. */
  private async narrowIssue(reader: GitHubClient, repo: Work['repo'], issueNumber: number, paths: readonly string[], botName: string): Promise<void> {
    const issue = await reader.getIssue(repo.fullName, issueNumber);
    const vouched = (await issues.getIssue(repo.id, issueNumber).catch(() => null))?.vouched ?? null;
    const current = vouched ? vouched.body : (issue.body ?? '');
    const body = withoutExpectedPaths(current, paths);
    if (body === current) return;
    const seat = seatOf(current);
    const editor = seat && seat !== botName ? await this.deps.actors.asBot(seat) : reader;
    if (!editor) throw new Error(`${seat} wrote the issue, and only ${seat} can edit it, but ${seat} is not connected to GitHub. Run: openadlc auth login --bot ${seat}`);
    await editor.updateIssueBody(repo.fullName, issueNumber, body);
    if (vouched) await issues.setVouched(repo.id, issueNumber, { title: vouched.title, body, by: botName });
  }
}

/**
 * The console's buttons: on a plan-change card, "Approve, and any more paths
 * for #N" and "Ask the designer"; on the card or the item, turning approve
 * all off; on the item, refusing what the designer or a standing approval
 * approved. A user's, as answering a question is (`roles.ts`).
 */
export function registerPlanChangeRoutes(
  router: Router,
  planChanges: PlanChanges,
  resolve: (subject: string) => Promise<{ repo: string; issueNumber: number } | null>,
): void {
  router.post('/v1/gates/:id/approve-all', async ({ params, identity, role }) =>
    planChanges.approveAll({ gateId: params.id ?? '', identity, ...(role ? { role } : {}) }),
  );
  router.post('/v1/gates/:id/ask-designer', async ({ params, identity }) => planChanges.askDesigner({ gateId: params.id ?? '', identity }));
  router.post('/v1/gates/:id/take-back', async ({ params, identity }) => planChanges.takeBack({ gateId: params.id ?? '', identity }));
  router.post('/v1/items/:subject/approve-all/off', async ({ params, identity }) => {
    const found = await resolve(params.subject ?? '');
    if (!found) throw new HttpFailure(404, 'there is no such issue to turn approve all off on');
    const ended = await planChanges.turnOff({ repoName: found.repo, issueNumber: found.issueNumber, identity });
    return { standingApproval: null, ended };
  });
}
