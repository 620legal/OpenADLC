import { bots, repos, requests, tasks, withAdvisoryLock } from '@fleetadlc/db';
import { BotBusyError, PrerequisiteNotReadyError, SpendingCapError, heldAtCap, type TaskService } from './task-service.js';

/**
 * Console requests waiting for the intake bot.
 *
 * A request sent while intake was triaging another one was written, then
 * refused as busy — one running task per bot — and nothing started its triage
 * again: it sat as a draft nobody would pick up. It is now `queued`, and this
 * starts queued requests oldest first whenever intake is free: when an intake
 * task ends or pauses, on a sweep every minute, and when the bridge starts.
 *
 * Free is what `TaskService.open` means by it: the intake seat has room for
 * another task, fewer holding a computer than its `max_tasks` (Crew → "tasks
 * at once", `tasks.seatHasRoom`). A task paused on a person's answer counts
 * only while it keeps its computer.
 *
 * One start at a time: in this process by a chain, across processes — two
 * bridges during a rollout — by an advisory lock, and each request is claimed
 * in one statement besides, so none is started twice.
 *
 * What cannot start does not hold the line:
 * - intake turning busy stops the walk, and the request keeps its place;
 * - a request for a repository a person paused is passed over, keeping its
 *   place, until that repository is resumed;
 * - a request intake refuses on its own account — a repository it cannot work
 *   in, say — is passed over, with why kept on it, and tried again on later
 *   walks after a growing wait (`RETRY_AFTER_MS`), `MAX_ATTEMPTS` times, after
 *   which it waits for a person's "Try again";
 * - a request a spending cap refuses waits in line without spending an
 *   attempt, and is asked again on the usual wait: the cap is not the
 *   request's fault, and counted, five refusals in about eighteen minutes
 *   left it waiting for a person's "Try again" even once the cap was raised;
 * - a start hostd refused, or that failed without throwing, stops the walk
 *   and leaves the request queued without counting it against the request:
 *   whatever broke it would break every request behind it too, and the line
 *   is not spent on it. So does a start refused because the health checks
 *   say hostd is down or intake cannot sign in to GitHub: counted, one walk
 *   charged every request in line, and about eighteen minutes of outage left
 *   them all waiting for a person's "Try again" after it had cleared. Intake
 *   unable to work in the request's own repository is still the request's.
 */

export const REQUEST_QUEUE_LOCK = 'bridge:request-queue';

/** How often the queue is looked at when nothing else asks. */
export const REQUEST_SWEEP_MS = 60_000;

/** How many times a queued request's start may be refused before it waits for a person's "Try again". */
export const MAX_ATTEMPTS = 5;

/**
 * How long a request whose start failed waits before it is tried again, by
 * attempts so far: a repository intake cannot work in is not put right in a
 * minute, and trying every sweep only fills the log.
 */
export const RETRY_AFTER_MS = [1, 2, 5, 10].map((minutes) => minutes * 60_000);

/**
 * How recently a request must have been claimed for the bridge, as it starts,
 * to take it for one a restart interrupted. A draft with no task that is older
 * than this is something else — from before the queue — and is left alone.
 */
export const RECOVER_WITHIN_MS = 60 * 60_000;

export interface StartedRequest {
  requestId: string;
  task: { taskId: string; session: string | null; error?: string };
  bot: string;
}

export interface RequestQueueDeps {
  taskService: Pick<TaskService, 'open'>;
  /**
   * Why nothing new may start now — work paused from Settings, a restore — or
   * null. Asked with no repository, it is the whole install's pause: while it
   * says something the queue starts nothing, and requests wait in line.
   * Asked about a request's repository, it is that repository's pause too:
   * the request keeps its place and the walk goes on past it.
   * Resuming drains it (`pause-work.ts`).
   */
  paused?: (repo?: string | null) => string | null;
  /** Held across processes while the queue is walked; the database's advisory lock. */
  exclusive?: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
  log?: (line: string) => void;
  /**
   * Why the intake seat itself takes no new work — a person paused it from
   * Crew (`seat-pause.ts`) — or null. While it says something every request
   * waits in line, its place kept and no attempt counted, and resuming the
   * seat drains the queue. Absent, the intake seat is never paused.
   */
  seatPaused?: (seat: string) => Promise<string | null>;
}

/** The subject a request's triage task works on. */
export function requestSubject(requestId: string): string {
  return `request:${requestId.slice(0, 8)}`;
}

/** Whether the queue will still try to start this request, or waits for a person. */
export function stillTried(request: { queueAttempts?: number }): boolean {
  return (request.queueAttempts ?? 0) < MAX_ATTEMPTS;
}

/**
 * Whether the queue tries this request now: it is still tried, and a start
 * that failed was long enough ago (`RETRY_AFTER_MS`). One that never failed,
 * or was tried again by a person, is ready at once.
 */
export function readyNow(request: { queueAttempts?: number; queueReason?: string | null; updatedAt?: string }, now: number): boolean {
  if (!stillTried(request)) return false;
  if (!request.queueReason || !request.updatedAt) return true;
  const attempts = request.queueAttempts ?? 0;
  const wait = RETRY_AFTER_MS[Math.min(Math.max(attempts - 1, 0), RETRY_AFTER_MS.length - 1)] ?? 0;
  return now - Date.parse(request.updatedAt) >= wait;
}

export class RequestQueue {
  private walking: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: RequestQueueDeps) {}

  /**
   * Starts what can start now, oldest first, and says which it started. It
   * first puts back in line a request left claimed but never started
   * (`stranded`), paused or not, since that starts nothing.
   */
  drain(): Promise<StartedRequest[]> {
    const exclusive = this.deps.exclusive ?? withAdvisoryLock;
    const run = this.walking
      .catch(() => undefined)
      .then(async () => {
        const now = Date.now();
        const stranded = await this.stranded(now);
        const paused = Boolean(this.deps.paused?.());
        // Nothing waiting, nothing to lock for: an idle install's sweep is two reads.
        if (stranded.length === 0 && (paused || !(await requests.listQueued()).some((request) => readyNow(request, now)))) return [];
        return exclusive(REQUEST_QUEUE_LOCK, async () => {
          // Read again under the lock: a drain that held it may have started one.
          if (stranded.length > 0) await this.recover(await this.stranded(Date.now()));
          // Paused: everything waits in line, started when work resumes.
          if (this.deps.paused?.()) return [];
          return this.startQueued();
        });
      });
    this.walking = run.catch((error: unknown) => {
      this.say(`could not start the queued requests: ${error instanceof Error ? error.message : error}`);
    });
    return run;
  }

  /**
   * A request claimed for triage whose start never happened — the bridge
   * stopped between the claim and the task — is a draft with no task, which no
   * card offers to try again. Asked of every draft claimed within the hour (a
   * restart's interruption, not a request from before the queue, whose draft
   * with no task means something else), however many older drafts there are.
   * It was asked only at start, which a paused install skipped, and of the 200
   * oldest drafts, which every triage that files nothing leaves behind.
   */
  private async stranded(now: number): Promise<{ id: string }[]> {
    const drafts = await requests.listDraftsSince(new Date(now - RECOVER_WITHIN_MS));
    if (drafts.length === 0) return [];
    const onSubjects = await tasks.listTasksOnSubjects(drafts.map((request) => requestSubject(request.id)));
    return drafts.filter((request) => !onSubjects.some((task) => task.subjectRef === requestSubject(request.id)));
  }

  /** Each goes back to its place in line. */
  private async recover(stranded: readonly { id: string }[]): Promise<void> {
    for (const request of stranded) {
      await requests.requeue(request.id);
      this.say(`${requestSubject(request.id)}: claimed for triage but never started; back in line`);
    }
  }

  private async startQueued(): Promise<StartedRequest[]> {
    const intake = (await bots.listBots()).find((bot) => bot.role === 'intake');
    if (!intake) return [];
    // Paused from Crew: everything waits, uncounted. Asked to start anyway, each
    // request was refused on its own account and counted an attempt, and after
    // a few a paused intake would have given requests up for good.
    const seatPaused = await this.deps.seatPaused?.(intake.name).catch(() => null);
    if (seatPaused) return [];
    const started: StartedRequest[] = [];
    const now = Date.now();
    const repoList = await repos.listRepos();
    for (const waiting of await requests.listQueued()) {
      // Passed over, not waited for: one backing off holds nobody behind it.
      if (!readyNow(waiting, now)) continue;
      const repo = waiting.repoId ? (repoList.find((one) => one.id === waiting.repoId) ?? null) : null;
      // Its repository is paused: it keeps its place, unclaimed and with no
      // attempt counted, and the requests for other repositories go ahead of
      // it until that one is resumed. Stopping the walk here held every
      // repository for one.
      if (repo && this.deps.paused?.(repo.name)) continue;
      // Intake triages as many requests at once as its tasks at once.
      if (!(await tasks.seatHasRoom(intake.id))) break;
      const request = await requests.claimQueued(waiting.id);
      // Another bridge took it between the read and the claim.
      if (!request) continue;
      const subject = requestSubject(request.id);
      let task: StartedRequest['task'];
      try {
        task = await this.deps.taskService.open({
          bot: intake.name,
          botId: intake.id,
          repo: repo?.name ?? null,
          kind: 'intake',
          subjectType: 'request',
          subjectRef: subject,
          skill: 'triage',
        });
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        // A task row the start wrote before it threw would keep intake busy for good.
        await this.settleUnstarted(subject, why);
        if (error instanceof BotBusyError) {
          await requests.requeue(request.id);
          break;
        }
        // Held at a cap: it starts once the cap allows it, as the recovery
        // starts a patch round held the same way. Passed over rather than
        // stopping the walk, since a repository's cap holds only its own
        // requests. Said once, not on every sweep while the cap stands: by
        // whether it was already held, since the words carry the month's
        // spend, which moves while other work runs.
        if (error instanceof SpendingCapError) {
          const already = heldAtCap(request.queueReason);
          await requests.requeue(request.id, why, { counts: false });
          if (!already) this.say(`${subject}: its triage waits for a spending cap: ${error.refusal}`);
          continue;
        }
        // hostd down, or intake signed out of GitHub: every request behind
        // this one would be refused the same way, so the walk stops here and
        // nothing is counted. Said once, while the reason stays the same.
        const outage =
          error instanceof PrerequisiteNotReadyError
            ? error.blockers.filter((blocker) => blocker.kind === 'host' || blocker.kind === 'sign-in')
            : [];
        if (outage.length > 0) {
          const already = request.queueReason === why;
          await requests.requeue(request.id, why, { counts: false });
          if (!already) this.say(`${subject}: the queue waits, counting no attempt, while ${outage.map((blocker) => blocker.why).join(' and ')}`);
          break;
        }
        // Refused on this request's own account: passed over, not in the way.
        await requests.requeue(request.id, why);
        this.say(`${subject}: its triage could not start, and it waits (attempt ${(request.queueAttempts ?? 0) + 1} of ${MAX_ATTEMPTS}): ${why}`);
        continue;
      }
      if (task.error) {
        // hostd refused. Whatever broke this start breaks the next one too:
        // the walk stops, and this request stays in line.
        // Not the request's fault, so not one of its attempts; it waits as any
        // failed start does (`RETRY_AFTER_MS`, by the attempts it already has)
        // before it is tried again.
        await requests.requeue(request.id, `hostd refused: ${task.error}`, { counts: false });
        this.say(`${subject}: hostd refused its triage, and the queue waits: ${task.error}`);
        break;
      }
      started.push({ requestId: request.id, task, bot: intake.name });
      this.say(`${subject}: started its triage, which had waited for ${intake.name}`);
    }
    return started;
  }

  /** Stops a task row a start left queued when it threw, so it holds nothing. */
  private async settleUnstarted(subject: string, why: string): Promise<void> {
    const left = (
      await Promise.resolve()
        .then(() => tasks.listTasksOnSubjects([subject]))
        .catch(() => [])
    ).filter((task) => task.state === 'queued');
    for (const task of left) {
      await tasks.updateTaskState(task.id, 'stopped', { exitReason: `its start did not finish, and the request waits in line again: ${why}` }).catch(() => undefined);
    }
  }

  private say(line: string): void {
    (this.deps.log ?? ((text: string) => console.log(`[bridge] ${text}`)))(line);
  }
}

/** Each queued request's place in line, 1 being next, by its id. */
export async function queuePositions(): Promise<Map<string, number>> {
  // One the queue gave up on takes no place: it waits for a person's Try
  // again, which Needs you offers, and counted it put everyone behind it a
  // place further back than the walk has them.
  return new Map((await requests.listQueued()).filter(stillTried).map((request, index) => [request.id, index + 1]));
}

/** Requests as the console reads them: each with its place in line while it waits. */
export async function withPositions<R extends { id: string; state: string }>(list: readonly R[]): Promise<(R & { queuePosition: number | null })[]> {
  const positions = list.some((request) => request.state === 'queued') ? await queuePositions() : new Map<string, number>();
  return list.map((request) => ({ ...request, queuePosition: positions.get(request.id) ?? null }));
}
