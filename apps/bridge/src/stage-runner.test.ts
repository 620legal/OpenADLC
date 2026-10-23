import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StageRunner } from './stage-runner.js';

/**
 * What starts the work a busy seat turned away once the seat may have room.
 * Only the hourly stage sweep came back for it, and a design refused while
 * the design seat ran another waited an hour after that one ended. Asked on
 * each task's end, it must still be one run at a time, and a burst of task
 * ends one run.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function runner(
  start: (seats: readonly string[]) => Promise<string[]> = async () => [],
  waiting: { waitedOn?: () => string[]; hasRoom?: (seat: string) => Promise<boolean> } = {},
) {
  const lines: string[] = [];
  const run = vi.fn(start);
  const stages = new StageRunner(
    { start: run, waitedOn: waiting.waitedOn ?? (() => []), hasRoom: waiting.hasRoom ?? (async () => true) },
    { delayMs: 1000, everyMs: 60_000, log: (line) => lines.push(line) },
  );
  return { stages, run, lines };
}

describe('a seat that may have room', () => {
  it('makes one run of the asks that arrive together, for every seat asked about, and says what asked', async () => {
    const { stages, run, lines } = runner(async () => ['started spec on openadlc#141: openadlc-sage-janedoe has room now']);

    stages.seatFreed('bot-spec', 'spec task done');
    stages.seatFreed('bot-intake', 'intake task failed');
    stages.seatFreed('bot-spec', 'spec task done');
    await vi.advanceTimersByTimeAsync(1000);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(['bot-spec', 'bot-intake']);
    expect(lines).toEqual(['[bridge] stages, for spec task done, intake task failed: started spec on openadlc#141: openadlc-sage-janedoe has room now']);
  });

  it('runs once more after a run that an ask arrived during, and never two at once', async () => {
    let finish: (() => void) | null = null;
    let concurrent = 0;
    let most = 0;
    const { stages, run } = runner(async () => {
      concurrent += 1;
      most = Math.max(most, concurrent);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      concurrent -= 1;
      return [];
    });

    stages.seatFreed('bot-spec', 'spec task done');
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);

    // Mid-run: the run may have read the seat before these.
    stages.seatFreed('bot-intake', 'intake task done');
    stages.seatFreed('bot-spec', 'spec task stopped');
    await stages.now();
    expect(run).toHaveBeenCalledTimes(1);

    finish!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith(['bot-intake', 'bot-spec']);
    finish!();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(most).toBe(1);
  });

  it('keeps going after a run that failed, and says so', async () => {
    const { stages, run, lines } = runner(async () => {
      throw new Error('the database is not answering');
    });

    stages.seatFreed('bot-spec', 'spec task done');
    await vi.advanceTimersByTimeAsync(1000);
    stages.seatFreed('bot-spec', 'spec task done');
    await vi.advanceTimersByTimeAsync(1000);

    expect(run).toHaveBeenCalledTimes(2);
    expect(lines[0]).toBe('[bridge] stages, for spec task done, failed: the database is not answering');
  });

  it('starts nothing once the bridge is stopping', async () => {
    const { stages, run } = runner();

    stages.seatFreed('bot-spec', 'spec task done');
    stages.stop();
    await vi.advanceTimersByTimeAsync(5000);
    stages.seatFreed('bot-spec', 'spec task done');
    await vi.advanceTimersByTimeAsync(5000);

    expect(run).not.toHaveBeenCalled();
  });
});

describe('a seat that freed up without anything asking', () => {
  it('is found by the look every minute when something waits on it and it has room', async () => {
    // hostd giving back a paused task's computer frees its seat, and says so
    // to nobody.
    const room: Record<string, boolean> = { 'bot-spec': false, 'bot-intake': true };
    const { stages, run } = runner(async () => [], {
      waitedOn: () => ['bot-spec', 'bot-spec', 'bot-intake'],
      hasRoom: async (seat) => room[seat] ?? false,
    });
    stages.start();

    await vi.advanceTimersByTimeAsync(61_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenLastCalledWith(['bot-intake']);

    room['bot-spec'] = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith(['bot-spec', 'bot-intake']);
    stages.stop();
  });

  it('asks nothing while nothing waits', async () => {
    const hasRoom = vi.fn(async () => true);
    const { stages, run } = runner(async () => [], { waitedOn: () => [], hasRoom });
    stages.start();

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(hasRoom).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    stages.stop();
  });
});
