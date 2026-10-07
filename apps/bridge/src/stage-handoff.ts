import { audit, bots, issues, listEventsOfType, recordEvent, repos, stageMoves, tasks, withAdvisoryLock } from '@fleetadlc/db';
import { acceptOnStage } from './design-memory.js';
import { leadReviewer, type StageKey, type StageMode } from '@fleetadlc/shared';
import type { Automation } from './automation.js';
import type { DispatchGate } from './dispatch-gate.js';
import type { TaskService } from './task-service.js';
import { dependencyIsSatisfied, hasIgnoreLabel, parseDependencies } from '@fleetadlc/shared';
import { isActive, issueNumberFromBranch, REVIEW_STALLED } from './work.js';
import { INTAKE_STALLED } from './intake-events.js';

/**
 * Where an issue goes once intake has shaped it. A design pass costs a stage,
 * so `conditional` spends it only on the changes that earn one — a schema, a
 * contract, a migration, anything large or safety-relevant.
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
const STAGE_SWEEP_LOCK = 'fleetadlc:stage-sweep';

/** Which role staffs a stage, and with which skill. */
const STAFFING: Partial<Record<StageKey, { role: string; skill: string; kind: 'intake' | 'spec' }>> = {
  intake: { role: 'intake', skill: 'triage', kind: 'intake' },
  spec: { role: 'spec', skill: 'spec', kind: 'spec' },
};

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
   * While work is paused nothing is started: the issue stays in its stage, the
   * deferral is audited, and the resume's sweep starts it. Only `followOn` — the
   * next stage of an issue whose own task just finished — goes ahead, as the
   * rest of a piece of work already under way does.
   */
  async staff(input: { repoName: string; issueNumber: number; stage: StageKey; followOn?: boolean }): Promise<boolean> {
    // An issue past design has had its design taken: what it proposed for the
    // repository to remember is accepted (`design-memory.ts`).
    if (input.stage === 'build') await acceptOnStage(input.repoName, input.issueNumber, input.stage).catch(() => 0);
    const staffing = STAFFING[input.stage];
    if (!staffing) return false;

    const repo = await repos.getRepoByName(input.repoName);
    if (!repo) return false;

    // `fleetadlc:ignore` is one issue, not the install. The pause still stops
    // every repository; this returns before that check, so a resume does not
    // staff it either. Taking the label off is what lets the next sweep in.
    // It reads the stored labels, so a label whose delivery has not been
    // processed yet does not stop it; `moveStage` keeps that label on GitHub.
    const known = await issues.getIssue(repo.id, input.issueNumber);
    if (hasIgnoreLabel(known?.labels)) return false;

    const mode = repo.stageModes[input.stage];
    if (mode === 'untouched') return false;

    const subjectRef = `${repo.name}#${input.issueNumber}`;
    if (await this.alreadyWorking(subjectRef)) return false;
    if (input.stage === 'intake' && (await this.intakeGaveUp(subjectRef))) return false;

    const bot = (await bots.listBots()).find((entry) => entry.role === staffing.role);
    if (!bot) return false;

    // Asked of GitHub last, as the one check here that costs a call.
    if (this.closed && (await this.closed(repo.fullName, input.issueNumber).catch(() => false))) return false;

    // Asked about this repository: one a person paused on its own holds its
    // issues in intake as the install's pause holds every one.
    const paused = input.followOn ? null : this.gate?.paused(repo.name);
    if (paused) {
      await this.defer(subjectRef, input.stage, paused);
      return false;
    }
    // Open again, whatever opened it — a person's Resume, a restore letting go
    // of its hold, a pause read back as cleared — so a later pause audits this
    // issue afresh rather than taking it for one already said.
    this.deferred.delete(`${subjectRef}:${input.stage}`);

    const started = await this.taskService
      .open({
        bot: bot.name,
        repo: repo.name,
        kind: staffing.kind,
        subjectType: 'issue',
        subjectRef,
        skill: staffing.skill,
      })
      .catch((error: unknown) => {
        // A busy bot is not a failure: the sweep comes back for this issue.
        console.warn(`[bridge] ${input.stage} not staffed for ${subjectRef}: ${error instanceof Error ? error.message : error}`);
        return null;
      });

    return Boolean(started && !started.error);
  }

  /** Moves the issue on when the stage's own task finishes. */
  async onTaskDone(input: { kind: string; subjectRef: string; taskId?: string; branch?: string | null }): Promise<StageKey | null> {
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
    // `fleetadlc:ignore` still finishes; it does not move the stage of an issue
    // the crew was told to leave alone.
    const known = await issues.getIssue(repo.id, issueNumber);
    if (hasIgnoreLabel(known?.labels)) return null;

    if (input.kind === 'intake') {
      const to = await this.afterIntake({ repoName: repo.name, issueNumber });
      // The intake bot is free again, and one triage runs at a time: the next
      // issue waiting on it — the backlog a pause left, say — starts now rather
      // than on the hourly sweep.
      if (to) await this.sweep({ stage: 'intake' });
      return to;
    }

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

    const to = stageAfterIntake({
      labels: known.labels,
      specRequiredLabels: repo.specRequiredLabels,
      specMode: repo.stageModes.spec ?? 'conditional',
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

  /** `start:now` when every issue under its Dependencies has shipped, `blocked` otherwise; nothing when it carries either. */
  private async markReadiness(
    repo: { name: string; fullName: string },
    issueNumber: number,
    known: { labels: string[]; body: string | null },
  ): Promise<void> {
    if (known.labels.includes('start:now') || known.labels.includes('blocked')) return;
    const inRepo = await issues.listIssues(repo.name);
    const waiting = parseDependencies(known.body).some(
      (number) => !dependencyIsSatisfied(inRepo.find((issue) => issue.number === number) ?? null),
    );
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
   * A patch round that pushed nothing answered the lead in words. The lead's
   * request for changes still stands on the same head, so nothing counts a
   * lead review as due, and the pull request sat in Review with no task and
   * nobody told. The lead is asked to read the replies and decide again; when
   * that cannot start, the pull request is a Needs-you card instead.
   */
  private async backToLead(repo: { name: string }, prNumber: number, branch: string, issueNumber: number): Promise<void> {
    const subjectRef = `${repo.name}#${prNumber}`;
    // Now, so the lead's earlier review — the one this round answered — is
    // not taken for this one.
    const since = new Date().toISOString();
    const crew = await bots.listBots().catch(() => []);
    let seat: string | null = null;
    try {
      seat = leadReviewer(this.automation.reviewRules(crew)).seat;
      if (await this.taskService.openLeadReview({ repo, prNumber, branch, issueNumber, seat, since })) return;
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
   * it. One bot runs one task, so the first issue starts now and each one
   * after it as the triage before it ends (`onTaskDone`), or on the sweep.
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
   */
  async sweep(options: { stage?: StageKey } = {}): Promise<string[]> {
    return (this.exclusive ?? withAdvisoryLock)(STAGE_SWEEP_LOCK, async () => {
      const actions: string[] = [];

      // In the order the board and the dispatcher use, across repositories:
      // priority, then the longest waiting. After a pause, a p0 filed during
      // it is triaged before a p3 filed earlier.
      const waiting: issues.IssueRecord[] = [];
      for (const repo of await repos.listRepos()) {
        for (const issue of await issues.listIssues(repo.name)) {
          if (!STAFFING[issue.stage] || (options.stage && issue.stage !== options.stage)) continue;
          waiting.push({ ...issue, repoName: repo.name });
        }
      }
      waiting.sort(issues.byNextFirst);

      for (const issue of waiting) {
        if (await this.staff({ repoName: issue.repoName, issueNumber: issue.number, stage: issue.stage })) {
          actions.push(`started ${issue.stage} on ${issue.repoName}#${issue.number}: it was waiting with nobody on it`);
        }
      }

      return actions;
    });
  }
}
