import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_INTERVALS, intervalsFromEnv, JobTimer } from './job-timer.js';
import { SCHEDULED_JOBS } from './scheduler.js';

/**
 * The timer that fires the jobs nobody asks for.
 *
 * What these pin is not "a setInterval was created" but the three ways this
 * goes wrong quietly: firing at start-up so a crash-looping bridge files an
 * issue every time it comes up; every job landing in the same millisecond
 * forever; and a job that throws taking its own timer down, which looks exactly
 * like a job that was never configured.
 */
let fired: string[];
let scheduler: { run: (job: string) => Promise<{ job: string; actions: string[] }> };

beforeEach(() => {
  fired = [];
  scheduler = {
    run: async (job: string) => {
      fired.push(job);
      return { job, actions: [] };
    },
  };
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Only `status`, at one minute, so the timing is easy to reason about. */
function oneJob(): Record<string, number> {
  const intervals = Object.fromEntries(SCHEDULED_JOBS.map((job) => [job, 0]));
  return { ...intervals, status: 1 };
}

describe('firing the recurring jobs', () => {
  it('fires nothing at start-up', async () => {
    // A bridge that crash-loops would otherwise run the credential check on
    // every boot, and that check files an issue.
    const timer = new JobTimer(scheduler as never, oneJob() as never);
    timer.start();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fired).toEqual([]);
    timer.stop();
  });

  it('fires once an interval has passed, and then keeps going', async () => {
    const timer = new JobTimer(scheduler as never, oneJob() as never);
    timer.start();

    await vi.advanceTimersByTimeAsync(61_000);
    expect(fired).toEqual(['status']);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fired).toEqual(['status', 'status']);
    timer.stop();
  });

  it('keeps firing after a job throws', async () => {
    // A job that stops silently is worse than one that fails loudly: nothing in
    // `fleetadlc status` tells "never ran" from "stopped running" except a
    // timestamp nobody is looking at.
    let calls = 0;
    const failing = {
      run: async (job: string) => {
        calls += 1;
        if (calls === 1) throw new Error('postgres went away');
        return { job, actions: [] };
      },
    };
    const timer = new JobTimer(failing as never, oneJob() as never);
    timer.start();

    await vi.advanceTimersByTimeAsync(61_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(2);
    timer.stop();
  });

  it('does not land every job in the same millisecond', async () => {
    // Every job sharing one interval means all of them together, forever:
    // a load spike and a burst of comments on the same tick.
    const every = Object.fromEntries(SCHEDULED_JOBS.map((job) => [job, 1]));
    const timer = new JobTimer(scheduler as never, every as never);
    timer.start();

    await vi.advanceTimersByTimeAsync(61_000);
    const first = fired.length;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(SCHEDULED_JOBS.length);
    timer.stop();
  });

  it('stops everything when told to', async () => {
    const timer = new JobTimer(scheduler as never, oneJob() as never);
    timer.start();
    await vi.advanceTimersByTimeAsync(61_000);
    timer.stop();

    const after = fired.length;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fired.length).toBe(after);
  });

  it('waits a whole interval longer than a timer can hold', async () => {
    // Node's timers top out at 24.8 days and wait 1 ms past that, so a monthly
    // dependency sweep ran back to back from start-up.
    const intervals = { ...Object.fromEntries(SCHEDULED_JOBS.map((job) => [job, 0])), deps: 43_200 };
    const timer = new JobTimer(scheduler as never, intervals as never);
    timer.start();
    const month = 43_200 * 60_000;

    await vi.advanceTimersByTimeAsync(month - 1);
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toEqual(['deps']);

    await vi.advanceTimersByTimeAsync(month - 1);
    expect(fired).toEqual(['deps']);
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toEqual(['deps', 'deps']);

    timer.stop();
    await vi.advanceTimersByTimeAsync(2 * month);
    expect(fired).toEqual(['deps', 'deps']);
  });

  it('stops a long wait part way through its chain', async () => {
    const intervals = { ...Object.fromEntries(SCHEDULED_JOBS.map((job) => [job, 0])), deps: 43_200 };
    const timer = new JobTimer(scheduler as never, intervals as never);
    timer.start();
    // Past the first link of the chain, so the pending timeout is a re-armed one.
    await vi.advanceTimersByTimeAsync(30 * 24 * 60 * 60_000 - 1);
    timer.stop();
    await vi.advanceTimersByTimeAsync(43_200 * 60_000 * 3);
    expect(fired).toEqual([]);
  });
});

describe('how often each job runs', () => {
  it('has a cadence for every job the scheduler knows', () => {
    // A job added without one would silently never run, which is the bug this
    // whole file exists for.
    for (const job of SCHEDULED_JOBS) {
      expect(DEFAULT_INTERVALS[job], job).toBeGreaterThan(0);
    }
  });

  it('is overridden from the environment', () => {
    expect(intervalsFromEnv({ FLEETADLC_JOB_QA_MINUTES: '30' } as never).qa).toBe(30);
    expect(intervalsFromEnv({} as never).events).toBe(24 * 60);
    expect(intervalsFromEnv({ FLEETADLC_JOB_EVENTS_MINUTES: '0' } as never).events).toBe(0);
  });

  it('turns a job off at zero rather than treating it as unset', () => {
    // An install that does not want the dependency sweep should not have to
    // patch the source.
    const intervals = intervalsFromEnv({ FLEETADLC_JOB_DEPS_MINUTES: '0' } as never);
    expect(intervals.deps).toBe(0);

    const timer = new JobTimer(scheduler as never, intervals);
    expect(timer.running.map((entry) => entry.job)).not.toContain('deps');
  });

  it('refuses a value that is not a number of minutes', () => {
    // Keeping the default silently is how somebody believes they turned a job
    // off and did not.
    expect(() => intervalsFromEnv({ FLEETADLC_JOB_QA_MINUTES: 'nightly' } as never)).toThrow(/not a number/);
    expect(() => intervalsFromEnv({ FLEETADLC_JOB_QA_MINUTES: '-5' } as never)).toThrow(/not a number/);
    // And what to do about it.
    expect(() => intervalsFromEnv({ FLEETADLC_JOB_QA_MINUTES: 'nightly' } as never)).toThrow(
      'set it to a number of minutes (0 turns the job off), or remove it for the default of 1440',
    );
  });

  it('refuses a blank value rather than reading it as zero', () => {
    // Number('') is 0, so an env file that wrote `FLEETADLC_JOB_RECONCILE_MINUTES=`
    // turned the backstop for missed webhooks off without a message.
    expect(() => intervalsFromEnv({ FLEETADLC_JOB_RECONCILE_MINUTES: '' } as never)).toThrow(/not a number/);
    expect(() => intervalsFromEnv({ FLEETADLC_JOB_RECONCILE_MINUTES: '  ' } as never)).toThrow(/not a number/);
    expect(intervalsFromEnv({ FLEETADLC_JOB_QA_MINUTES: ' 2.5 ' } as never).qa).toBe(2.5);
  });
});
