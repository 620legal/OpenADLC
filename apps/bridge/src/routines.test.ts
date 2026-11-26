import type { Routine } from '@openadlc/db';
import { describe, expect, it, vi } from 'vitest';
import { ROUTINE_FAILED, ROUTINE_FILED, ROUTINE_SKIPPED, RoutineService, type RoutineFile, type RoutineServiceDeps } from './routines.js';

const ID = '0b6f1d1c-6c55-4c1c-9a59-1f4a4b8f2a10';
const NOW = new Date('2026-11-26T09:00:20.000Z');

function routine(patch: Partial<Routine> = {}): Routine {
  return {
    id: ID,
    repoId: 'repo-1',
    repo: 'app',
    repoFullName: 'acme/app',
    text: 'Review the dependencies',
    details: 'One change per pull request.',
    kind: 'chore',
    cadence: { every: 'day' },
    time: '09:00',
    timeZone: 'UTC',
    paused: false,
    owner: { identity: 'ada@example.com', login: 'ada', githubId: 4242 },
    createdBy: 'ada@example.com',
    updatedBy: 'ada@example.com',
    createdAt: '2026-11-20T10:00:00.000Z',
    updatedAt: '2026-11-20T10:00:00.000Z',
    nextRunAt: '2026-11-26T09:00:00.000Z',
    lastRunAt: null,
    lastRequestId: null,
    lastRequestState: null,
    lastOutcome: null,
    lastSkipReason: null,
    ...patch,
  };
}

/**
 * The store as the database keeps it: `claimSlot` moves `next_run_at` only
 * when it still reads the slot, as its conditional update does, and requests
 * are open while their state says so.
 */
function harness(initial: Routine, options: { paused?: string | null; cap?: { spentUsd: number; capUsd: number } | null; approves?: boolean } = {}) {
  const state = { routine: { ...initial }, open: new Map<string, boolean>(), filedRoutineIds: [] as string[] };
  const settings = { paused: options.paused ?? null, cap: options.cap ?? null, approves: options.approves ?? true };
  const audits: { action: string; target: string; payload: Record<string, unknown> }[] = [];
  let requests = 0;
  const file = vi.fn<RoutineFile>(async (_request, _identity, { routineId }) => {
    requests += 1;
    const id = `${String(requests).padStart(8, '0')}-0000-4000-8000-000000000000`;
    state.open.set(id, true);
    state.filedRoutineIds.push(routineId);
    return { id };
  });
  const deps: RoutineServiceDeps = {
    store: {
      due: async (now) => {
        const { routine: current } = state;
        return !current.paused && current.nextRunAt && new Date(current.nextRunAt) <= now ? [{ ...current }] : [];
      },
      claimSlot: async (id, expected, next) => {
        await Promise.resolve();
        if (id !== state.routine.id || state.routine.paused || state.routine.nextRunAt !== expected.toISOString()) return false;
        state.routine.nextRunAt = next.toISOString();
        return true;
      },
      recordRun: async (_id, run) => {
        state.routine.lastRunAt = run.at.toISOString();
        state.routine.lastOutcome = run.outcome;
        if (run.outcome === 'filed') {
          state.routine.lastRequestId = run.requestId ?? null;
          state.routine.lastSkipReason = null;
        } else {
          state.routine.lastSkipReason = run.skipReason ?? null;
        }
      },
      previousOpen: async (requestId) => state.open.get(requestId) ?? false,
    },
    paused: () => settings.paused,
    capReached: async () => settings.cap,
    approves: async () => settings.approves,
    audit: async (entry) => {
      audits.push(entry);
    },
  };
  const service = new RoutineService(deps);
  service.useFiler(file);
  return { service, state, settings, audits, file };
}

describe('a routine that falls due', () => {
  it('files exactly one request, as its owner, with its repository, text, details and kind, marked as its own', async () => {
    const { service, state, file, audits } = harness(routine());

    const lines = await service.fire(NOW);

    expect(file).toHaveBeenCalledTimes(1);
    expect(file).toHaveBeenCalledWith(
      { repo: 'app', text: 'Review the dependencies', context: 'One change per pull request.', kind: 'chore' },
      'ada@example.com',
      { routineId: ID },
    );
    expect(state.routine).toMatchObject({ lastOutcome: 'filed', lastRequestId: '00000001-0000-4000-8000-000000000000', lastSkipReason: null });
    expect(state.routine.nextRunAt).toBe('2026-11-27T09:00:00.000Z');
    expect(lines).toEqual(['routine 0b6f1d1c (app) filed request:00000001 as ada@example.com']);
    expect(audits).toEqual([
      { actor: 'routines', action: ROUTINE_FILED, target: `routine:${ID}`, payload: { repo: 'app', owner: 'ada', requestId: '00000001-0000-4000-8000-000000000000', nextRunAt: '2026-11-27T09:00:00.000Z' } },
    ]);
  });

  it('skips the next firing while that request is still open, says why, and files again once it closes', async () => {
    const { service, state, file } = harness(routine());
    await service.fire(NOW);
    const first = state.routine.lastRequestId!;

    const tomorrow = new Date('2026-11-27T09:00:05.000Z');
    expect(await service.fire(tomorrow)).toEqual(['routine 0b6f1d1c (app) skipped: Its last request request:00000001 is still open']);
    expect(file).toHaveBeenCalledTimes(1);
    expect(state.routine).toMatchObject({ lastOutcome: 'skipped', lastRequestId: first, lastSkipReason: 'Its last request request:00000001 is still open' });
    // The skip spent the slot.
    expect(state.routine.nextRunAt).toBe('2026-11-28T09:00:00.000Z');

    state.open.set(first, false);
    await service.fire(new Date('2026-11-28T09:00:05.000Z'));
    expect(file).toHaveBeenCalledTimes(2);
    expect(state.routine).toMatchObject({ lastOutcome: 'filed', lastSkipReason: null });
  });

  it('files nothing before its slot', async () => {
    const { service, file } = harness(routine({ nextRunAt: '2026-11-26T09:01:00.000Z' }));
    expect(await service.fire(NOW)).toEqual([]);
    expect(file).not.toHaveBeenCalled();
  });
});

describe('a due routine that files nothing', () => {
  const cases: { name: string; options: Parameters<typeof harness>[1]; reason: string; message: string }[] = [
    { name: 'while work is paused, across the install or in its repository', options: { paused: 'a person paused it' }, reason: 'paused', message: 'Work is paused: a person paused it' },
    { name: 'while the monthly cap stops leasing', options: { cap: { spentUsd: 1500, capUsd: 1500 } }, reason: 'cap', message: 'The monthly cap is reached ($1500.00 of $1500.00)' },
    {
      name: 'while its owner has no Approves on, or is not in People',
      options: { approves: false },
      reason: 'approves',
      message: '@ada no longer has Approves on (or is not in People): an approver can edit this routine to take it over',
    },
  ];

  for (const { name, options, reason, message } of cases) {
    it(`skips ${name}, says why, and still moves its next run on`, async () => {
      const { service, state, file, audits } = harness(routine(), options);
      expect(await service.fire(NOW)).toEqual([`routine 0b6f1d1c (app) skipped: ${message}`]);
      expect(file).not.toHaveBeenCalled();
      expect(state.routine).toMatchObject({ lastOutcome: 'skipped', lastSkipReason: message, paused: false, nextRunAt: '2026-11-27T09:00:00.000Z' });
      expect(audits[0]).toMatchObject({ action: ROUTINE_SKIPPED, payload: { reason, message } });
    });
  }

  it('checks in order: paused, then the cap, then Approves, then the open request', async () => {
    const { service, state } = harness(routine({ lastRequestId: 'open-one' }), { paused: 'held', cap: { spentUsd: 1, capUsd: 1 }, approves: false });
    state.open.set('open-one', true);
    await service.fire(NOW);
    expect(state.routine.lastSkipReason).toBe('Work is paused: held');
  });

  it('files again at the first firing after its owner has Approves back, having stayed unpaused', async () => {
    const { service, state, settings, file } = harness(routine(), { approves: false });
    await service.fire(NOW);
    expect(file).not.toHaveBeenCalled();
    expect(state.routine.paused).toBe(false);

    settings.approves = true;
    await service.fire(new Date('2026-11-27T09:00:05.000Z'));
    expect(file).toHaveBeenCalledTimes(1);
    expect(state.routine.lastOutcome).toBe('filed');
  });

  it('records a filing that fails, and does not try it again before its next slot', async () => {
    const { service, state, file, audits } = harness(routine());
    file.mockRejectedValueOnce(Object.assign(new Error('intake is not connected to GitHub'), { status: 409 }));

    expect(await service.fire(NOW)).toEqual(['routine 0b6f1d1c (app) failed: Filing its request failed: intake is not connected to GitHub']);
    expect(state.routine).toMatchObject({ lastOutcome: 'failed', lastSkipReason: 'Filing its request failed: intake is not connected to GitHub', nextRunAt: '2026-11-27T09:00:00.000Z' });
    expect(audits[0]).toMatchObject({ action: ROUTINE_FAILED });

    await service.fire(new Date('2026-11-26T09:01:30.000Z'));
    expect(file).toHaveBeenCalledTimes(1);
  });
});

describe('after downtime', () => {
  it('fires once for a daily routine three days behind, and not again in the same minute', async () => {
    const { service, state, file } = harness(routine({ nextRunAt: '2026-11-23T09:00:00.000Z' }));
    const start = new Date('2026-11-26T11:30:10.000Z');

    await service.fire(start);
    expect(file).toHaveBeenCalledTimes(1);
    expect(state.routine.nextRunAt).toBe('2026-11-27T09:00:00.000Z');

    // The request is closed, so only the schedule could file again.
    state.open.clear();
    await service.fire(new Date('2026-11-26T11:30:50.000Z'));
    expect(file).toHaveBeenCalledTimes(1);
  });
});

describe('two ticks at once', () => {
  it('give one filing', async () => {
    const { service, file } = harness(routine());
    await Promise.all([service.fire(NOW), service.fire(NOW)]);
    expect(file).toHaveBeenCalledTimes(1);
  });
});

describe('before the console API is registered', () => {
  it('claims nothing, so no slot is spent with nothing to file it', async () => {
    const claimSlot = vi.fn(async () => true);
    const service = new RoutineService({
      store: { due: async () => [routine()], claimSlot, recordRun: vi.fn(), previousOpen: vi.fn() },
      paused: () => null,
      capReached: async () => null,
      approves: async () => true,
      audit: vi.fn(),
    });
    expect(await service.fire(NOW)).toEqual(['routines wait for the console API, which files their requests']);
    expect(claimSlot).not.toHaveBeenCalled();
  });
});
