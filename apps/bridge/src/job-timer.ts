import { SCHEDULED_JOBS, type Scheduler } from './scheduler.js';

type Job = (typeof SCHEDULED_JOBS)[number];

/**
 * How often each job runs when nobody asks, in minutes.
 *
 * These were implied by comments and by nothing else: `scheduler.ts` said
 * "firing this job hourly must not produce an issue an hour" and "sending one
 * every quarter hour is how a notification stops meaning anything", while
 * nothing fired either. `POST /internal/schedule/:job` was the only way in, so
 * on a running install the credential check, the status issue and the dependency
 * sweep simply never happened.
 *
 * Stated here so the cadence is a value somebody can read and change, rather
 * than a sentence in a comment that the code does not honour.
 */
export const DEFAULT_INTERVALS: Record<Job, number> = {
  // Cheap, and the thing that repairs drift when a webhook was missed.
  reconcile: 15,
  status: 15,
  budget: 30,
  // The stage sweep (`StageHandoff.sweep`) starts intake or design on an issue
  // that sits in that stage with nobody on it, after a webhook that never
  // came, a bot that was busy, or a label applied while the bridge was down.
  // The delivery starts most of them; this caps what a missed one costs at an
  // hour.
  stages: 60,
  // Mostly webhook-driven; this is the backstop for a delivery that never came.
  merge: 10,
  // Nightly, against whatever is on testing.
  qa: 24 * 60,
  // A refresh token aging out should be noticed before a bot finds it mid-task.
  credentials: 12 * 60,
  deps: 7 * 24 * 60,
  // Backstop for a merge whose webhook never dispatched a testing deploy: the
  // merge dispatches it, and this only notices what was missed. Half-hourly:
  // it starts at most one deploy a firing, and only of the newest merge, so a
  // shorter interval costs a board read, not a deploy.
  deploy: 30,
  // Looks whether this week's engine update is owed; the update itself is
  // weekly (Sunday 18:00 unless the console says otherwise). Looking often
  // is what lets a machine that slept through the hour run it on waking.
  engines: 5,
  // Uploads nobody sent with anything; they wait a day, so hourly is plenty.
  attachments: 60,
  // GitHub deliveries past FLEETADLC_EVENT_RETENTION_DAYS; kept for weeks, so daily.
  events: 24 * 60,
};

/** Reads `FLEETADLC_JOB_<NAME>_MINUTES`; 0 turns a job off. */
export function intervalsFromEnv(env: NodeJS.ProcessEnv = process.env): Record<Job, number> {
  const intervals = { ...DEFAULT_INTERVALS };
  for (const job of SCHEDULED_JOBS) {
    const raw = env[`FLEETADLC_JOB_${job.toUpperCase()}_MINUTES`];
    if (raw === undefined) continue;
    // A value that is not a number is a typo, and silently keeping the default
    // is how somebody believes they turned a job off and did not. A blank one
    // is checked too: Number('') is 0, so an env file that wrote
    // `FLEETADLC_JOB_RECONCILE_MINUTES=` turned the backstop off without a word.
    if (!/^\d+(\.\d+)?$/.test(raw.trim())) {
      throw new Error(
        `FLEETADLC_JOB_${job.toUpperCase()}_MINUTES is "${raw}", which is not a number of minutes. ` +
          `Where the bridge is started, set it to a number of minutes (0 turns the job off), or remove it for the default of ${DEFAULT_INTERVALS[job]}`,
      );
    }
    intervals[job] = Number(raw.trim());
  }
  return intervals;
}

/** The longest delay `setTimeout` takes before it overflows to 1 ms. */
const MAX_DELAY = 2_147_483_647;

/**
 * Runs the jobs nobody asks for.
 *
 * Three things it deliberately does:
 *
 * - **Nothing fires at start-up.** A bridge that crash-loops would otherwise
 *   run the credential check every time it came up, and that check files an
 *   issue. The first run of each job is one interval away.
 * - **The jobs are spread out.** Starting every timer in the same millisecond
 *   means every job landing together every hour, which is a load spike and a
 *   burst of comments. Each starts a little after the last.
 * - **A job that throws keeps its timer.** The failure is reported and the next
 *   firing still happens, because a job that stops silently is worse than one
 *   that fails loudly — nothing in `fleetadlc status` distinguishes "never ran"
 *   from "stopped running" except the timestamp nobody is looking at.
 */
export class JobTimer {
  /** Each job's pending timeout. One per job, replaced every time it re-arms. */
  private readonly pending = new Map<Job, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly scheduler: Pick<Scheduler, 'run'>,
    private readonly intervals: Record<Job, number> = intervalsFromEnv(),
  ) {}

  /** The jobs that will run, and how often. For the start-up log. */
  get running(): { job: Job; minutes: number }[] {
    return SCHEDULED_JOBS.filter((job) => this.intervals[job] > 0).map((job) => ({
      job,
      minutes: this.intervals[job],
    }));
  }

  start(): void {
    let stagger = 0;
    for (const { job, minutes } of this.running) {
      const period = minutes * 60_000;
      // Each job first fires one interval after start, plus 20 seconds for
      // every job before it, so jobs with the same interval do not land
      // together for the life of the process.
      const offset = stagger;
      stagger += 20_000;
      this.arm(job, period + offset, period);
    }
  }

  stop(): void {
    for (const handle of this.pending.values()) clearTimeout(handle);
    this.pending.clear();
  }

  /**
   * Waits `wait` ms, fires the job, and then waits `period` again.
   *
   * Node's timers hold at most 2^31-1 ms (24.8 days). Past that it prints a
   * TimeoutOverflowWarning and waits 1 ms instead, so a monthly
   * `FLEETADLC_JOB_DEPS_MINUTES=43200` ran the dependency sweep back to back
   * from start-up. A longer wait is a chain of shorter ones.
   */
  private arm(job: Job, wait: number, period: number): void {
    const step = Math.min(wait, MAX_DELAY);
    const handle = setTimeout(() => {
      if (wait > step) {
        this.arm(job, wait - step, period);
        return;
      }
      void this.fire(job);
      this.arm(job, period, period);
    }, step);
    handle.unref?.();
    this.pending.set(job, handle);
  }

  private async fire(job: Job): Promise<void> {
    try {
      const result = await this.scheduler.run(job);
      for (const action of result.actions) console.log(`[bridge] ${job}: ${action}`);
    } catch (error) {
      console.warn(`[bridge] ${job} failed: ${error instanceof Error ? error.message : error}`);
    }
  }
}
