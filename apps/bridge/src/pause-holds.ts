import { listEventsOfTypeWith, recordEvent, tasks } from '@openadlc/db';
import type { StageHandoff } from './stage-handoff.js';
import { PAUSED_BUILDER_HOLD_MS, pauseHoldEndsAt } from './task-service.js';

/** Recorded when a builder round's pause starts holding its review seats: `{ task, pausedAt, until, subjectRef }`. */
export const REVIEW_PAUSE_HELD = 'review.pause_held';
/** Recorded when that hold lapsed with the round still on the pause, and the seats were asked: `{ task, pausedAt, subjectRef }`. */
export const REVIEW_PAUSE_HOLD_LAPSED = 'review.pause_hold_lapsed';

/** Past the window's end, so the lapse's own `builderOn` no longer counts the pause (`now < until`). */
const LAPSE_SLACK_MS = 1_000;

/** As many paused tasks as `load` reads; an install has a handful at a time. */
const PAUSED_READ_LIMIT = 1_000;

type PausedTask = { id: string; kind: string; state: string; subjectRef: string; branch: string | null; pausedAt?: string | null };

export interface PauseHoldsDeps {
  stages: Pick<StageHandoff, 'builderEnded'>;
  now?: () => number;
  /** Replaced in tests; the default is an unref'd `setTimeout`, which a shutdown does not wait on. */
  setTimer?: (fn: () => void, ms: number) => { clear(): void };
}

/**
 * What a builder round's pause does to its pull request's review seats (#287,
 * ADR 0051). A paused `patch` or `implement` task holds the seats for
 * `PAUSED_BUILDER_HOLD_MS` after it paused (`builderOn` refuses every start
 * meanwhile), so a pause no longer asks them: asked at the pause, they were
 * started on a head the round then replaced, the gap a question answered in
 * a minute left on 2026-11-10. They are asked when the task ends, as before,
 * or here, once, when the hold lapses with the round still on that pause: a
 * pull request sent back to Build is in no stage the gate sweep settles, so
 * nothing else would ask them while its question waits for days.
 *
 * The lapse survives a restart through two events, keyed by task and
 * `pausedAt`: `load` lapses a pause that was held and never lapsed, and
 * leaves alone one with no `review.pause_held`, a pause from before this
 * change, whose pause already asked the seats.
 */
export class PauseHolds {
  /** Each held task's lapse timer, with the pause it is for. */
  private readonly timers = new Map<string, { pausedAt: string; timer: { clear(): void } }>();
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => { clear(): void };

  constructor(private readonly deps: PauseHoldsDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        timer.unref();
        return { clear: () => clearTimeout(timer) };
      });
  }

  /**
   * A builder task that has just paused: its lapse is set, and its hold
   * recorded. The timer is set first: if the event write fails, the lapse
   * still asks the seats, where a pause before this change would have asked
   * them at once; only a restart inside the window loses it then, as `load`
   * finds no `review.pause_held`. The runner reports a pause again while the
   * task is already on it (`paused_at` is not restamped), and that report
   * neither records a second hold nor moves the timer.
   */
  async paused(task: PausedTask): Promise<void> {
    if (!isBuilder(task) || !task.pausedAt) return;
    const until = pauseHoldEndsAt(task);
    if (until === null) return;
    if (this.timers.get(task.id)?.pausedAt === task.pausedAt) return;
    this.schedule(task.id, task.pausedAt, until);
    await recordEvent({
      source: 'platform',
      type: REVIEW_PAUSE_HELD,
      payload: { task: task.id, pausedAt: task.pausedAt, until: new Date(until).toISOString(), subjectRef: task.subjectRef },
    });
  }

  /**
   * The hold of a task paused at `pausedAt` has ended. The seats are asked
   * only if the task is still on that pause: answered and resumed, its end
   * asks them; paused again, the new pause has its own window.
   */
  async lapse(taskId: string, pausedAt: string): Promise<boolean> {
    this.timers.delete(taskId);
    const task = await tasks.getTask(taskId);
    if (!task || task.state !== 'paused' || task.pausedAt !== pausedAt || !isBuilder(task)) return false;
    // A pause reported again after its lapse sets a new timer for a window
    // already over; the seats were asked once for this pause, and only once.
    if ((await listEventsOfTypeWith(REVIEW_PAUSE_HOLD_LAPSED, { task: task.id, pausedAt })).length > 0) return false;
    await recordEvent({ source: 'platform', type: REVIEW_PAUSE_HOLD_LAPSED, payload: { task: task.id, pausedAt, subjectRef: task.subjectRef } });
    console.log(`[bridge] ${task.subjectRef}: the builder's ${task.kind} round is still paused on a question after ${PAUSED_BUILDER_HOLD_MS / 60_000} minutes; its review seats are asked`);
    await this.deps.stages.builderEnded({ kind: task.kind, subjectRef: task.subjectRef, branch: task.branch });
    return true;
  }

  /**
   * At start-up: every paused builder task's hold, from the database. One
   * still open is set for what is left of it; one that ended while the bridge
   * was down, held and never lapsed, lapses now. Returns how many were set or
   * lapsed.
   */
  async load(): Promise<number> {
    const paused = await tasks.listTasks({ states: ['paused'], limit: PAUSED_READ_LIMIT });
    let count = 0;
    for (const task of paused) {
      if (!isBuilder(task) || !task.pausedAt) continue;
      const until = pauseHoldEndsAt(task);
      if (until === null) continue;
      if (this.now() < until) {
        this.schedule(task.id, task.pausedAt, until);
        count++;
        continue;
      }
      const key = { task: task.id, pausedAt: task.pausedAt };
      const held = await listEventsOfTypeWith(REVIEW_PAUSE_HELD, key);
      if (held.length === 0) continue;
      const lapsed = await listEventsOfTypeWith(REVIEW_PAUSE_HOLD_LAPSED, key);
      if (lapsed.length > 0) continue;
      if (await this.lapse(task.id, task.pausedAt)) count++;
    }
    return count;
  }

  /** A builder task that has ended: its hold has nothing left to ask. */
  forget(taskId: string): void {
    this.timers.get(taskId)?.timer.clear();
    this.timers.delete(taskId);
  }

  stop(): void {
    for (const { timer } of this.timers.values()) timer.clear();
    this.timers.clear();
  }

  private schedule(taskId: string, pausedAt: string, until: number): void {
    this.forget(taskId);
    const timer = this.setTimer(() => {
      void this.lapse(taskId, pausedAt).catch((error: unknown) =>
        console.warn(`[bridge] the review seats held by paused task ${taskId} were not asked: ${error instanceof Error ? error.message : error}`),
      );
    }, Math.max(0, until - this.now()) + LAPSE_SLACK_MS);
    this.timers.set(taskId, { pausedAt, timer });
  }
}

function isBuilder(task: { kind: string }): boolean {
  return task.kind === 'patch' || task.kind === 'implement';
}
