import { describe, expect, it } from 'vitest';
import { drainTasks } from './task-runner.js';

/**
 * What a stopping hostd does to the tasks it holds. A restart used to stop
 * every one of them, including a triage paused on its questions to a person,
 * which then read as work that had ended while the question was still open.
 */
describe('stopping hostd', () => {
  it('stops the tasks that are working and keeps the ones waiting on a person', async () => {
    const states: Record<string, string> = { building: 'running', asking: 'paused', starting: 'queued' };
    const cancelled: string[] = [];

    const result = await drainTasks({
      active: ['building', 'asking', 'starting'],
      stateOf: async (taskId) => states[taskId] ?? null,
      cancel: async (taskId) => void cancelled.push(taskId),
    });

    expect(cancelled).toEqual(['building', 'starting']);
    expect(result).toEqual({ stopped: ['building', 'starting'], kept: ['asking'], timedOut: [] });
  });

  it('stops a task whose state cannot be read, as it always did', async () => {
    const cancelled: string[] = [];
    await drainTasks({ active: ['unknown'], stateOf: async () => null, cancel: async (id) => void cancelled.push(id) });
    expect(cancelled).toEqual(['unknown']);
  });

  it('stops them all at once, so two slow stops take about the time of one', async () => {
    // One after another they ran past the time `fleetadlc down` gives hostd.
    const slow = () => new Promise<void>((resolve) => setTimeout(resolve, 300));
    const started = Date.now();
    const result = await drainTasks({ active: ['one', 'two'], stateOf: async () => 'running', cancel: slow, perTaskMs: 5000 });
    expect(result.stopped).toEqual(['one', 'two']);
    expect(Date.now() - started).toBeLessThan(550);
  });

  it('gives up on a stop that never finishes, says so, and does not hold up the rest', async () => {
    const result = await drainTasks({
      active: ['stuck', 'quick'],
      stateOf: async () => 'running',
      cancel: (taskId) => (taskId === 'stuck' ? new Promise<void>(() => undefined) : Promise.resolve()),
      perTaskMs: 100,
    });
    expect(result).toEqual({ stopped: ['quick'], kept: [], timedOut: ['stuck'] });
  });
});
