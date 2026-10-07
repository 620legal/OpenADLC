import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DispatchRunner } from './dispatch-runner.js';

/**
 * The dispatcher, run when something changes that could let work start.
 *
 * It looked every five minutes on its own, and an issue whose dependency had
 * just shipped waited for the look. Asked soon after each change instead, it
 * must still be one run at a time, and a burst of changes one run.
 */

const DECISION = { repo: 'fleetadlc-testbed', issue: 3, bot: 'fleetadlc-atlas-janedoe', action: 'leased' as const, reason: 'leased' };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('asking for a dispatch', () => {
  it('makes one run of the asks that arrive together, and says what asked', async () => {
    const lines: string[] = [];
    const run = vi.fn(async () => [DECISION]);
    const runner = new DispatchRunner(run, { delayMs: 1000, log: (line) => lines.push(line) });

    runner.soon('issues.labeled');
    runner.soon('issues.unlabeled');
    runner.soon('issues.labeled');
    await vi.advanceTimersByTimeAsync(1000);

    expect(run).toHaveBeenCalledTimes(1);
    expect(lines).toEqual(['[bridge] dispatch, for issues.labeled, issues.unlabeled: leased fleetadlc-testbed#3 → fleetadlc-atlas-janedoe: leased']);
  });

  it('runs once more after a run that an ask arrived during, and never two at once', async () => {
    let finish: (() => void) | null = null;
    let concurrent = 0;
    let most = 0;
    const run = vi.fn(async () => {
      concurrent += 1;
      most = Math.max(most, concurrent);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      concurrent -= 1;
      return [];
    });
    const runner = new DispatchRunner(run, { delayMs: 100, log: () => undefined });

    runner.soon('a task ended');
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(1);

    // Mid-run: the run may have read the world before these.
    runner.soon('issues.closed');
    runner.soon('pull_request.closed');
    await runner.now();
    expect(run).toHaveBeenCalledTimes(1);

    (finish as (() => void) | null)?.();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(2);
    (finish as (() => void) | null)?.();
    await vi.advanceTimersByTimeAsync(1000);

    expect(run).toHaveBeenCalledTimes(2);
    expect(most).toBe(1);
  });

  it('says a run failed and runs again the next time it is asked', async () => {
    const lines: string[] = [];
    const run = vi.fn(async () => {
      throw new Error('the database went away');
    });
    const runner = new DispatchRunner(run, { delayMs: 10, log: (line) => lines.push(line) });

    runner.soon('issues.labeled');
    await vi.advanceTimersByTimeAsync(10);
    runner.soon('implement task done');
    await vi.advanceTimersByTimeAsync(10);

    expect(run).toHaveBeenCalledTimes(2);
    expect(lines[0]).toBe('[bridge] dispatch, for issues.labeled, failed: the database went away');
  });

  it('also looks on a timer, for whatever nobody asked about, and stops when told', async () => {
    const run = vi.fn(async () => []);
    const runner = new DispatchRunner(run, { delayMs: 10, everyMs: 60_000, log: () => undefined });

    runner.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);

    runner.stop();
    runner.soon('issues.labeled');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
