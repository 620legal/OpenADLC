import { audit, bots, issues, listEventsOfType, recordEvent, repos, stageMoves, tasks, withAdvisoryLock } from '@openadlc/db';
import { acceptOnStage } from './design-memory.js';
import { leadReviewer, maxTasksOf, PLAN_CHANGE_REVIEW_SKILL, REPO_DEFAULTS, type ContextDocument, type StageKey, type StageMode } from '@openadlc/shared';
import { seatsWaitedOn, type Automation } from './automation.js';
import type { DispatchGate } from './dispatch-gate.js';
import type { TaskService } from './task-service.js';
import { dependencyIsSatisfied, hasIgnoreLabel, missingLabels, parseDependencyRefs } from '@openadlc/shared';
import { isActive, issueNumberFromBranch, REVIEW_STALLED } from './work.js';
import { INTAKE_STALLED } from './intake-events.js';
import { SEAT_WAIT_WINDOW_MS, STAGE_WAITING_ON_SEAT, standingSeatWaits, type SeatWait, type SeatWaitPayload } from './seat-waits.js';

/**
 * Where an issue goes once intake has shaped it: to Design, unless the
 * repository chose otherwise. `conditional` spends a design pass only on the
 * changes that carry a spec-required label — a schema, a contract, a
 * migration, anything large or safety-relevant — and `untouched` on none.
 */
export function stageAfterIntake(input: {
  labels: string[];
  specRequiredLabels: string[];
  specMode: StageMode;
}): StageKey {
  if (input.specMode === 'untouched') return 'build';
  if (input.specMode === 'conditional') {
    return input.specRequiredLabels.some((label) => input.labels.includes(label)) ? 'spec' : 'build';
  }
  return 'spec';
}

/** The stage a finished task hands its issue to, or null if it is not a handoff. */
export function stageAfterTask(kind: string): StageKey | null {
  if (kind === 'spec') return 'build';
  return null;
}

/**
 * Held while a sweep starts stages. Two bridges on one install sweeping at
 * once each saw the intake bot free and could each start an intake on it.
 */
const STAGE_SWEEP_LOCK = 'openadlc:stage-sweep';

/** Which role staffs a stage, and with which skill. */
const STAFFING: Partial<Record<StageKey, { role: string; skill: string; kind: 'intake' | 'spec' }>> = {
  intake: { role: 'intake', skill: 'triage', kind: 'intake' },
  spec: { role: 'spec', skill: 'spec', kind: 'spec' },
};

/** The stages a seat of this role staffs: intake's, design's, or none. */
export function stagesStaffedBy(role: string): StageKey[] {
  return (Object.keys(STAFFING) as StageKey[]).filter((stage) => STAFFING[stage]?.role === role);
}

/**
 * Whether a start was refused because its seat runs all the tasks it may at
 * once, and for nothing else. A full host, the same work already running and
 * a restart owed are refused as busy too (`HostFullError`, `SubjectBusyError`,
 * `RestartPendingError`, each a `BotBusyError`), and none of them ends when
 * the seat has room. Read by name, which each of them sets to its own.
 */
function seatWasFull(error: unknown): boolean {
  return error instanceof Error && error.name === 'BotBusyError';
}

/** What `backToLead` reads of a pull request to work out who has reviewed its diff; `getPullRequest` answers with it. */
export interface OpenPull {
  draft: boolean;
  headSha: string;
  headRef: string;
  baseRef: string;
  labels: string[];
}

/** What intake is told when it ended with one of its labels left off (`afterIntake`). */
function labelsBrief(missing: readonly string[]): ContextDocument {
  return {
    name: 'missing-labels.md',
    title: 'Labels intake left off',
    content: [
      'Intake ended on this issue without all of the labels it must give it, as GitHub has them now:',
      '',
      ...missing.map((item) => `- ${item}`),
      '',
      'The bridge kept the issue in intake because of them. It moves on once they are on and this task ends.',
    ].join('\n'),
  };
}

/** How many times intake tries an issue that stays in intake, and over how long, before a person decides. */
export const INTAKE_TRIES = 2;
export const INTAKE_TRIES_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A stage that nothing staffs is a column work goes into and never leaves. The
 * board showed a bot on Spec and no spec task was ever started, so an issue that
 * reached it stopped there for good; the same was true of an issue a person
 * filed directly, which reached Intake and waited.
 *
 * This starts the bot a stage belongs to, and moves the label on when that bot's
 * task finishes — so a stage ends because its work ended, not because something
 * else noticed.
 */
export class StageHandoff {
  /** Issues whose stage was not staffed because work was paused, each audited once per pause. */
  private readonly deferred = new Set<string>();
  /** Issues intake gave up on that this process has already said so for. */
  private readonly said = new Set<string>();
  /**
   * Issues a seat turned away because it was running all it may at once, by
   * `<repo>#<number>:<stage>`: what `StageRunner` starts when that seat has
   * room. Each is said once as a `stage.waiting_on_seat` event, which is what
   * the board reads, and read back from those at start (`restoreWaits`).
   */
  private readonly waiting = new Map<string, SeatWait>();

  constructor(
    private readonly automation: Automation,
    private readonly taskService: TaskService,
    /**
     * The install's pause (`pause-work.ts`). Staffing a stage is new work: with
     * the install paused, twelve issues were each triaged as they were
     * opened, and some were labelled into build, because the issue delivery
     * started intake without asking. Absent, nothing is ever deferred.
     */
    private readonly gate: Pick<DispatchGate, 'paused'> | null = null,
    /** Runs a sweep under the install's lock; the database's advisory lock unless a test says otherwise. */
    private readonly exclusive: (<T>(key: string, fn: () => Promise<T>) => Promise<T>) | null = null,
    /**
     * Whether GitHub says the issue is closed. The board keeps a closed issue's
     * row until the reconciler's pass, and the hourly sweep staffed it in the
     * meantime: a cancelled Intake or Design item started again. A read that
     * fails answers open, as `subjectClosed` does. Absent, nothing is closed.
     */
    private readonly closed: ((repoFullName: string, number: number) => Promise<boolean>) | null = null,
    /**
     * The pull request as GitHub has it now, for which seats have reviewed
     * its diff when a patch round pushed nothing (`backToLead`). Absent, or a
     * read that fails, and only the lead is asked, as before.
     */
    private readonly pullOf: ((repoFullName: string, number: number) => Promise<OpenPull | null>) | null = null,
    /**
     * The issue's labels as GitHub has them now, for whether intake left all
     * of its own on (`afterIntake`). The stored row can be behind: a label put
     * on a moment before the task ended may not have been delivered yet.
     * Absent, or a read that fails, and the stored labels are read.
     */
    private readonly labelsOf: ((repoFullName: string, number: number) => Promise<string[] | null>) | null = null,
  ) {}

  private async alreadyWorking(subjectRef: string): Promise<boolean> {
    const open = await tasks.listTasks({ states: ['queued', 'running', 'paused'], limit: 100 });
    return open.some((task) => task.subjectRef === subjectRef);
  }

  /**
   * Whether intake has already had its tries at an issue that is still in
   * intake. Every issue in intake is staffed again by the sweep, and an issue
   * a person filed and intake could not shape — it ended each time without
   * moving it on — would be triaged every hour for good, now that every
   * unlabeled issue goes to intake. After `INTAKE_TRIES` in a week it waits for
   * a person, said once as an `intake.stalled` event, which Needs you shows.
   */
  private async intakeGaveUp(subjectRef: string): Promise<boolean> {
    const since = Date.now() - INTAKE_TRIES_WINDOW_MS;
    const ended = (await tasks.listTasksOnSubjects([subjectRef]).catch(() => [])).filter(
      (task) => task.kind === 'intake' && ['done', 'failed', 'stopped'].includes(task.state) && Date.parse(task.createdAt) >= since,
    );
    if (ended.length < INTAKE_TRIES) return false;
    if (!this.said.has(subjectRef)) {
      this.said.add(subjectRef);
      const already = (await listEventsOfType(INTAKE_STALLED, new Date(since)).catch(() => [])).some(
        (event) => (event.payload as { subjectRef?: unknown } | null)?.subjectRef === subjectRef,
      );
      if (!already) {
        await recordEvent({ source: 'platform', type: INTAKE_STALLED, payload: { subjectRef, tries: ended.length } }).catch(() => undefined);
        console.warn(`[bridge] intake left ${subjectRef} alone: it ran ${ended.length} times without moving it on; a person decides now`);
      }
    }
    return true;
  }

  /**
   * Starts the bot that staffs a stage. Called on the webhook that put the issue
   * there and again by the sweep, so a missed delivery costs an hour, not the issue.
   *
   * A seat running all it may at once turns the start away, and the issue
   * waits on that seat (`waitingOnSeats`) until it has room: when one of the
   * seat's tasks ends or its tasks at once go up, the `StageRunner` starts
   * what it turned away. The catch below used to say "the sweep comes back
   * for this issue", and it came back an hour later.
   *
   * While work is paused nothing is started: the issue stays in its stage, the
   * deferral is audited, and the resume's sweep starts it. Only `followOn` — the
   * next stage of an issue whose own task just finished — goes ahead, as the
   * rest of a piece of work already under way does.
   */
  async staff(input: { repoName: string; issueNumber: number; stage: StageKey; followOn?: boolean }): Promise<boolean> {
    return (await this.staffing(input)).started;
  }

  /**
   * `staff`, saying why nothing started, for a person who asked for it: a
   * message to the stage's role on its item (`MessageStarts`), whose brief
   * the task starts from. A seat running all it may at once is `later`: the
   * issue waits on that seat, as above, and starts when it has room. A
   * person's message is the decision intake's tries wait for once it gave up
   * on an issue (`intakeGaveUp`), so with a brief it is tried again.
   */
  async staffing(input: {
    repoName: string;
    issueNumber: number;
    stage: StageKey;
    followOn?: boolean;
    /** What a person asked of the stage, beside its usual context. */
    brief?: ContextDocument[];
  }): Promise<{ started: boolean; why: string | null; later?: boolean }> {
    const no = (why: string, later = false) => ({ started: false, why, ...(later ? { later: true } : {}) });
    // An issue past design has had its design taken: what it proposed for the
    // repository to remember is accepted (`design-memory.ts`).
    if (input.stage === 'build') await acceptOnStage(input.repoName, input.issueNumber, input.stage).catch(() => 0);
    const staffing = STAFFING[input.stage];
    if (!staffing) return no(`no seat staffs ${input.stage}`);

    const repo = await repos.getRepoByName(input.repoName);
    if (!repo) return no(`${input.repoName} is not a repository OpenADLC works in`);

    const subjectRef = `${repo.name}#${input.issueNumber}`;
    // It waits on its seat after this only if the seat turns it away again,
    // below. Whatever else this comes to — started, ignored, closed, already
    // being worked on, held by a pause — the wait is over.
    const key = `${subjectRef}:${input.stage}`;
    const waited = this.waiting.get(key);
    this.waiting.delete(key);

    // `openadlc:ignore` is one issue, not the install. The pause still stops
    // every repository; this returns before that check, so a resume does not
    // staff it either. Taking the label off is what lets the next sweep in.
    // It reads the stored labels, so a label whose delivery has not been
    // processed yet does not stop it; `moveStage` keeps that label on GitHub.
    const known = await issues.getIssue(repo.id, input.issueNumber);
    if (hasIgnoreLabel(known?.labels)) return no(`${subjectRef} is labelled openadlc:ignore`);

    const mode = repo.stageModes[input.stage];
    if (mode === 'untouched') return no(`${repo.name} leaves ${input.stage} to people (its stage mode is untouched)`);

    if (await this.alreadyWorking(subjectRef)) return no(`work on ${subjectRef} is already under way`);
    if (input.stage === 'intake' && !input.brief && (await this.intakeGaveUp(subjectRef))) return no(`intake has had its tries at ${subjectRef}; a person decides now`);

    const bot = (await bots.listBots()).find((entry) => entry.role === staffing.role);
    if (!bot) return no(`the crew has no ${staffing.role} seat`);

    // Asked of GitHub last, as the one check here that costs a call.
    if (this.closed && (await this.closed(repo.fullName, input.issueNumber).catch(() => false))) return no(`${subjectRef} is closed`);

    // Asked about this repository: one a person paused on its own holds its
    // issues in intake as the install's pause holds every one.
    const paused = input.followOn ? null : this.gate?.paused(repo.name);
    if (paused) {
      await this.defer(subjectRef, input.stage, paused);
      return no(paused);
    }
    // Open again, whatever opened it — a person's Resume, a restore letting go
    // of its hold, a pause read back as cleared — so a later pause audits this
    // issue afresh rather than taking it for one already said.
    this.deferred.delete(key);

    // Why it was turned away, when it was, for the person who asked.
    const refusal: { why?: string; later?: boolean } = {};
    const started = await this.taskService
      .open({
        bot: bot.name,
        repo: repo.name,
        kind: staffing.kind,
        subjectType: 'issue',
        subjectRef,
        skill: staffing.skill,
        ...(input.brief && input.brief.length > 0 ? { extraContext: input.brief } : {}),
      })
      .catch(async (error: unknown) => {
        // A busy bot is not a failure. The issue waits on its seat, and starts
        // when the seat has room (`StageRunner`); the sweep comes back for
        // anything that misses.
        const full = seatWasFull(error);
        if (full) {
          await this.waitOnSeat(key, waited, {
            subjectRef,
            repo: repo.name,
            issue: input.issueNumber,
            stage: input.stage,
            seat: bot.name,
            botId: bot.id,
            maxTasks: maxTasksOf(bot),
          });
        }
        const why = error instanceof Error ? error.message : String(error);
        refusal.why = why;
        refusal.later = full;
        console.warn(`[bridge] ${input.stage} not staffed for ${subjectRef}: ${why}`);
        return null;
      });

    if (started && !started.error) return { started: true, why: null };
    return no(refusal.why ?? started?.error ?? `${staffing.skill} on ${subjectRef} did not start`, refusal.later ?? false);
  }

  /** Moves the issue on when the stage's own task finishes. */
  async onTaskDone(input: { kind: string; subjectRef: string; taskId?: string; branch?: string | null; skill?: string | null }): Promise<StageKey | null> {
    // The designer judging a builder's plan change runs on the design seat as
    // a spec task, on an issue already in Build or Review: its end is no
    // design finishing, and handing the issue to Build from Review would undo
    // a stage (#77).
    if (input.skill === PLAN_CHANGE_REVIEW_SKILL) return null;

    // A task that sent its work back did not finish its stage, and handing the
    // issue on would undo the send-back. The stage it went back to is started
    // instead, now that this task is out of the way: started while it ran, it
    // was refused, because one task works on an issue at a time. Build is the
    // dispatcher's to start.
    const sentBack = input.taskId ? await (async () => stageMoves.sendBackOfTask(input.taskId!))().catch(() => null) : null;
    if (sentBack) {
      const repo = (await repos.listRepos()).find((entry) => entry.id === sentBack.repoId);
      if (repo && STAFFING[sentBack.to]) {
        await this.staff({ repoName: repo.name, issueNumber: sentBack.issueNumber, stage: sentBack.to, followOn: true });
      }
      return null;
    }

    // A patch round answers a review on the pull request, and is filed under
    // it. One that pushed a change to the diff moved the card back to Review
    // with that push; one that pushed nothing — it found the review wrong, or
    // the change already there — would leave the card in Build with its lease
    // and nobody working, so it goes back to Review too.
    if (input.kind === 'patch') return this.patchDone(input.subjectRef, input.branch ?? null);

    const [repoName, number] = input.subjectRef.split('#');
    const issueNumber = Number(number);
    if (!repoName || !Number.isInteger(issueNumber) || issueNumber <= 0) return null;

    const repo = await repos.getRepoByName(repoName);
    if (!repo) return null;

    // An intake or spec task already running when a person labelled the issue
    // `openadlc:ignore` still finishes; it does not move the stage of an issue
    // the crew was told to leave alone.
    const known = await issues.getIssue(repo.id, issueNumber);
    if (hasIgnoreLabel(known?.labels)) return null;

    // The seat this task ran on has room again, and what it turned away — the
    // backlog a pause left, say — is started by the `StageRunner` the task's
    // end asks, whatever the seat, once this has handed the issue on. Swept
    // here, after intake alone, a design that waited on a busy design seat
    // waited for the hourly sweep.
    if (input.kind === 'intake') return this.afterIntake({ repoName: repo.name, issueNumber });

    const to = stageAfterTask(input.kind);
    if (!to) return null;

    // The check above reads the stored labels. A label added a moment before
    // the task ended may not have been delivered yet, so the move checks
    // GitHub's labels as well.
    const moved = await this.automation.moveStage({
      repoName: repo.name,
      issueNumber,
      to,
      actor: `${input.kind} task`,
    });
    if (!moved.moved) return null;

    await this.staff({ repoName: repo.name, issueNumber, stage: to, followOn: true });
    return to;
  }

  /**
   * Where an issue goes once its triage has ended, by the repository's spec
   * rule (`stageAfterIntake`) and the trigger labels triage set, not by the
   * stage triage guessed. Both intake paths end here: an issue opened on
   * GitHub, from `onTaskDone`, and one filed from a console request, from the
   * task's end once the request is linked to its issue. The console path
   * never applied the rule, and an issue triage sent to Design on a repository
   * that does not design sat there for good.
   *
   * An issue moved into Build is given `start:now` or `blocked` by its
   * Dependencies, unless it carries one already: one that came into Build
   * with neither was never started by anything. A move refused — Build to
   * Design is backwards — is said rather than dropped.
   */
  async afterIntake(input: { repoName: string; issueNumber: number }): Promise<StageKey | null> {
    const repo = await repos.getRepoByName(input.repoName);
    if (!repo) return null;
    const known = await issues.getIssue(repo.id, input.issueNumber);
    // Its labels are what the rule reads. An issue whose own delivery has not
    // arrived yet is left to it, rather than sent to Build for want of them.
    if (!known) {
      console.warn(`[bridge] ${repo.name}#${input.issueNumber} is not on the board yet, so intake's end does not move it`);
      return null;
    }
    if (hasIgnoreLabel(known.labels)) return null;

    // An issue leaves intake only with its priority, area and one `do:`.
    // #203's intake said it put `area:general` on and never did; it went on
    // to Design, and was parked with `needs-triage` only when routing read
    // the labels, after Design had spent a run on it. One a person already
    // moved on is theirs, and is left to them.
    if (known.stage === 'intake') {
      const subjectRef = `${repo.name}#${input.issueNumber}`;
      const live = this.labelsOf ? await this.labelsOf(repo.fullName, input.issueNumber).catch(() => null) : null;
      const missing = missingLabels(live ?? known.labels);
      if (missing.length > 0) {
        await audit({ actor: 'bridge', action: 'intake.labels_missing', target: subjectRef, payload: { missing } }).catch(() => undefined);
        // Asked here, not left to `staffing`: a brief is a person's message
        // there, which overrides intake's tries, and this one is the bridge's.
        // The task that just ended is already `done`, so it is one of them.
        if (await this.intakeGaveUp(subjectRef)) return null;
        await this.staffing({ repoName: repo.name, issueNumber: input.issueNumber, stage: 'intake', followOn: true, brief: [labelsBrief(missing)] });
        return 'intake';
      }
    }

    const to = stageAfterIntake({
      labels: known.labels,
      specRequiredLabels: repo.specRequiredLabels,
      // A row with no spec mode stored reads as a new repository's default.
      // This was a `conditional` of its own, one of five copies of the
      // default in code that could drift apart (ADR 0004).
      specMode: repo.stageModes.spec ?? REPO_DEFAULTS.stageModes.spec,
    });
    // The check above reads the stored labels. A label added a moment before
    // the task ended may not have been delivered yet, so the move checks
    // GitHub's labels as well.
    const moved = await this.automation.moveStage({
      repoName: repo.name,
      issueNumber: input.issueNumber,
      to,
      actor: 'intake task',
    });
    if (!moved.moved) {
      if (!moved.ignored) console.warn(`[bridge] ${repo.name}#${input.issueNumber} stays where intake left it, not in ${to}: ${moved.reason ?? 'the move was refused'}`);
      return null;
    }

    if (to === 'build') await this.markReadiness(repo, input.issueNumber, known);
    await this.staff({ repoName: repo.name, issueNumber: input.issueNumber, stage: to, followOn: true });
    return to;
  }

  /**
   * `start:now` when every issue under its Dependencies has shipped, `blocked`
   * otherwise; nothing when it carries either. One in another repository is
   * read from that repository's row: skipped, it was `start:now` and built
   * before the work it waited on had shipped. One labelled `openadlc:ignore`
   * is read from its record, as the dispatcher reads it
   * (`resolveDependency`), so the label set here is the one it would unblock.
   */
  private async markReadiness(
    repo: { id: string; name: string; fullName: string },
    issueNumber: number,
    known: { labels: string[]; body: string | null },
  ): Promise<void> {
    if (known.labels.includes('start:now') || known.labels.includes('blocked')) return;
    const resolved = await Promise.all(parseDependencyRefs(known.body).map((ref) => issues.resolveDependency(repo, ref)));
    const waiting = resolved.some((dependency) => !dependencyIsSatisfied(dependency.issue, dependency.ignored));
    await this.automation.setBlocked(repo.fullName, issueNumber, waiting);
  }

  private async patchDone(subjectRef: string, branch: string | null): Promise<StageKey | null> {
    const issueNumber = branch ? issueNumberFromBranch(branch) : null;
    const repo = await repos.getRepoByName(subjectRef.split('#')[0] ?? '');
    if (!repo || !issueNumber) return null;
    const known = await issues.getIssue(repo.id, issueNumber);
    if (known?.stage !== 'build' || hasIgnoreLabel(known.labels)) return null;
    const moved = await this.automation.moveStage({ repoName: repo.name, issueNumber, to: 'review', actor: 'patch task' });
    if (!moved.moved) return null;
    const prNumber = Number(subjectRef.split('#')[1]);
    if (branch && Number.isInteger(prNumber) && prNumber > 0) await this.backToLead(repo, prNumber, branch, issueNumber);
    return 'review';
  }

  /**
   * A patch round that pushed nothing: it answered the lead in words, or the
   * local-CI rule sent it back and the checks then passed on the head as it
   * was. No push opens a round, so nothing asks a seat: the lead's request
   * for changes still stands on the same head, nothing counts a lead review
   * as due, and the pull request sat in Review with no task and nobody told.
   *
   * Every seat before the lead with no review of this diff is asked first
   * (`reviewStanding`, `openMissingReviews`), and the lead's turn comes when
   * they have posted (`onReview`). Asked only the lead, a pull request the
   * local-CI rule had held when its diff changed waited on its second
   * reviewer for good (#118). With them all in, the lead is asked to read the
   * replies and decide again; when that cannot start, the pull request is a
   * Needs-you card instead.
   */
  private async backToLead(repo: { name: string; fullName: string }, prNumber: number, branch: string, issueNumber: number): Promise<void> {
    const subjectRef = `${repo.name}#${prNumber}`;
    // Now, so the lead's earlier review — the one this round answered — is
    // not taken for this one.
    const since = new Date().toISOString();
    const crew = await bots.listBots().catch(() => []);
    let seat: string | null = null;
    try {
      const standing = await this.standingOf(repo.fullName, prNumber);
      seat = standing?.decision.lead ?? leadReviewer(this.automation.reviewRules(crew)).seat;
      // The seats the gate waits on before the lead, as it names them
      // (`computeReviewGate`): one that cannot be asked here is not among them.
      const named = seatsWaitedOn(standing?.gate.description ?? '');
      const before = named.filter((name) => name !== seat && !name.startsWith('@'));
      const notCounted = standing?.notCounted;
      if (before.length > 0) {
        await this.taskService.openMissingReviews({ repo, prNumber, branch, issueNumber, waitingOn: before, notCounted });
        return;
      }
      // Due on this diff since its others posted; a lead that has posted on
      // it already wrote the review this round answered, so from now.
      if (await this.taskService.openLeadReview({ repo, prNumber, branch, issueNumber, seat, since: standing?.leadDue?.since ?? since, notCounted })) return;
    } catch (error) {
      console.warn(`[bridge] the lead was not asked to review ${subjectRef} again: ${error instanceof Error ? error.message : error}`);
    }
    // A lead review already under way is the answer; nobody needs telling.
    const lead = crew.find((bot) => bot.name === seat);
    const onIt = lead
      ? await tasks
          .listTasksOnSubjects([subjectRef])
          .then((list) => list.some((task) => task.kind === 'review' && task.botId === lead.id && isActive(task)))
          .catch(() => false)
      : false;
    if (onIt) return;
    await recordEvent({
      source: 'platform',
      type: REVIEW_STALLED,
      payload: { repo: repo.name, pr: prNumber, issue: issueNumber, rounds: 0, bot: seat, botId: lead?.id ?? null },
    }).catch(() => undefined);
  }

  /** The reviews on a pull request's diff as they stand, or null when it or they cannot be read. */
  private async standingOf(repoFullName: string, prNumber: number): Promise<Awaited<ReturnType<Automation['reviewStanding']>> | null> {
    const pull = this.pullOf ? await this.pullOf(repoFullName, prNumber).catch(() => null) : null;
    if (!pull) return null;
    return this.automation
      .reviewStanding(repoFullName, {
        number: prNumber,
        draft: pull.draft,
        labels: pull.labels.map((name) => ({ name })),
        head: { sha: pull.headSha, ref: pull.headRef },
        baseRef: pull.baseRef,
      })
      .catch(() => null);
  }

  /** Records, once per issue and pause, that a stage was not staffed because work is paused. */
  private async defer(subjectRef: string, stage: StageKey, why: string): Promise<void> {
    const key = `${subjectRef}:${stage}`;
    if (this.deferred.has(key)) return;
    this.deferred.add(key);
    console.log(`[bridge] ${stage} not started on ${subjectRef}: ${why}`);
    await audit({ actor: 'bridge', action: 'stage.deferred', target: subjectRef, payload: { stage, why } }).catch(() => undefined);
  }

  /**
   * Work resumed: what waited through the pause starts, next first, through
   * the same `staff` a delivery uses — so a pause taken again meanwhile holds
   * it. One bot runs one task, so the first issue starts now, the seat turns
   * the rest away, and each starts as the task before it ends (`StageRunner`).
   *
   * What is let go is what the gate no longer holds: resuming one repository
   * leaves another's issues deferred, and they are not audited a second time
   * when the sweep finds them still paused.
   */
  async resumed(): Promise<string[]> {
    const waited = [...this.deferred].filter((key) => !this.gate?.paused(key.slice(0, key.lastIndexOf('#'))));
    for (const key of waited) this.deferred.delete(key);
    const actions = await this.sweep();
    if (waited.length > 0 || actions.length > 0) {
      await audit({
        actor: 'bridge',
        action: 'stage.resumed',
        target: 'dispatch',
        payload: { deferred: waited, started: actions },
      }).catch(() => undefined);
    }
    return actions;
  }

  /**
   * The hourly walk. A webhook that never arrived, a bot that was busy at the
   * time, or a stage entered while the bridge was down all look the same from
   * here: an issue sitting in a staffed stage with nobody on it.
   *
   * Given `stages`, only those are walked: a seat's pause ending walks the
   * stages it staffs. Given `seats`, only the issues those seats turned away
   * (`waitingOnSeats`) are started, which is what `StageRunner` asks for when
   * one of them may have room. Not everything in their stages: an issue whose
   * design a person stopped, or whose triage failed, sits there with nobody
   * on it too, and started again the moment its own task ended it would undo
   * the Stop, or fail again for as long as whatever failed it lasts. The
   * hourly walk is what comes back for those, as before.
   */
  async sweep(options: { stages?: readonly StageKey[]; seats?: readonly string[] } = {}): Promise<string[]> {
    const turnedAway = (): Set<string> | null =>
      options.seats ? new Set([...this.waiting].filter(([, wait]) => options.seats!.includes(wait.botId)).map(([key]) => key)) : null;
    // Nothing waits on these seats: nothing to walk, and no lock to wait for.
    if (turnedAway()?.size === 0) return [];

    return (this.exclusive ?? withAdvisoryLock)(STAGE_SWEEP_LOCK, async () => {
      const actions: string[] = [];
      // Read again under the lock: a start that held it may have taken one.
      const only = turnedAway();

      // In the order the board and the dispatcher use, across repositories:
      // priority, then the longest waiting. After a pause, a p0 filed during
      // it is triaged before a p3 filed earlier, and of two issues a busy seat
      // turned away, the next one is the first it takes when it has room.
      const walked = new Set<string>();
      const waiting: issues.IssueRecord[] = [];
      for (const repo of await repos.listRepos()) {
        for (const issue of await issues.listIssues(repo.name)) {
          if (!STAFFING[issue.stage] || (options.stages && !options.stages.includes(issue.stage))) continue;
          const key = `${repo.name}#${issue.number}:${issue.stage}`;
          walked.add(key);
          if (only && !only.has(key)) continue;
          waiting.push({ ...issue, repoName: repo.name });
        }
      }
      waiting.sort(issues.byNextFirst);

      for (const issue of waiting) {
        const wait = this.waiting.get(`${issue.repoName}#${issue.number}:${issue.stage}`);
        if (await this.staff({ repoName: issue.repoName, issueNumber: issue.number, stage: issue.stage })) {
          actions.push(
            wait
              ? `started ${issue.stage} on ${issue.repoName}#${issue.number}: ${wait.seat} turned it away at ${wait.since}, running all it may at once, and has room now`
              : `started ${issue.stage} on ${issue.repoName}#${issue.number}: it was waiting with nobody on it`,
          );
        }
      }

      // A wait whose issue is not in that stage any more — moved on, closed,
      // its repository gone — is over: nothing would start it, and the
      // runner's look for seats with room would keep finding it.
      for (const [key, wait] of this.waiting) {
        if (!walked.has(key) && (!options.stages || options.stages.includes(wait.stage))) this.waiting.delete(key);
      }

      return actions;
    });
  }

  /**
   * What the busy seats turned away and nobody has started yet, first turned
   * away first. `StageRunner` reads it for the seats to look at; the board
   * reads the same waits from their events (`standingSeatWaits`).
   */
  waitingOnSeats(): SeatWait[] {
    return [...this.waiting.values()].sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
  }

  /**
   * Reads back the waits that stood when the bridge last stopped, from their
   * events. Kept only in this process, they went with every restart, and an
   * issue a seat had turned away waited for the hourly sweep again — after
   * each release OpenADLC updates itself onto. Says how many it read.
   */
  async restoreWaits(now = Date.now()): Promise<number> {
    const events = await listEventsOfType(STAGE_WAITING_ON_SEAT, new Date(now - SEAT_WAIT_WINDOW_MS));
    if (events.length === 0) return 0;
    const subjects = [...new Set(events.map((event) => (event.payload as { subjectRef?: unknown } | null)?.subjectRef).filter((ref): ref is string => typeof ref === 'string'))];
    const repoNames = new Set(subjects.map((ref) => ref.slice(0, ref.lastIndexOf('#'))));
    const onBoard: issues.IssueRecord[] = [];
    for (const repo of await repos.listRepos()) {
      if (!repoNames.has(repo.name)) continue;
      for (const issue of await issues.listIssues(repo.name)) onBoard.push({ ...issue, repoName: repo.name });
    }
    const standing = standingSeatWaits(events, onBoard, await tasks.listTasksOnSubjects(subjects));
    for (const wait of standing.values()) {
      const key = `${wait.subjectRef}:${wait.stage}`;
      if (!this.waiting.has(key)) this.waiting.set(key, wait);
    }
    return standing.size;
  }

  /**
   * Records that a seat turned an issue away: said once as an event, while it
   * keeps turning it away, and kept with when it first did.
   */
  private async waitOnSeat(key: string, waited: SeatWait | undefined, wait: SeatWaitPayload): Promise<void> {
    if (waited && waited.botId === wait.botId) {
      this.waiting.set(key, { ...wait, since: waited.since });
      return;
    }
    this.waiting.set(key, { ...wait, since: new Date().toISOString() });
    await recordEvent({ source: 'platform', type: STAGE_WAITING_ON_SEAT, payload: wait }).catch(() => undefined);
  }
}
