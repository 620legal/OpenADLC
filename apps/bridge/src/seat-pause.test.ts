import { describe, expect, it, vi } from 'vitest';
import { Router } from './router.js';
import { heldBySeatPause, pauseSeat, registerSeatPauseRoutes, resumeSeat, seatPausedReason, seatPausesFrom, type SeatPauseStore } from './seat-pause.js';

vi.mock('@fleetadlc/db', () => ({
  settings: { getSetting: vi.fn(async () => null), setSetting: vi.fn(async () => undefined) },
  withAdvisoryLock: vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
}));

/** A store in memory, whose reads and writes take `delayMs`, with a lock that queues as the advisory lock does. */
function memory(initial: string | null = null, delayMs = 0): SeatPauseStore & { value: string | null } {
  const wait = () => new Promise((resolve) => setTimeout(resolve, delayMs));
  let tail: Promise<unknown> = Promise.resolve();
  const store = {
    value: initial,
    read: async () => (await wait(), store.value),
    write: async (value: string) => {
      await wait();
      store.value = value;
    },
    exclusive: <T>(_key: string, fn: () => Promise<T>): Promise<T> => {
      const run = tail.then(fn, fn);
      tail = run.catch(() => undefined);
      return run;
    },
  };
  return store;
}

async function call(router: Router, method: 'POST', path: string, body?: unknown) {
  const { createServer } = await import('node:http');
  const server = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('a seat paused from Crew', () => {
  it('keeps both of two pauses made at once, and a resume made while another seat is paused', async () => {
    const store = memory(null, 10);

    await Promise.all([pauseSeat('builder', 'janedoe', null, store), pauseSeat('qa', 'janedoe', null, store)]);
    expect(Object.keys(seatPausesFrom(store.value)).sort()).toEqual(['builder', 'qa']);

    await Promise.all([resumeSeat('builder', 'janedoe', store), pauseSeat('intake', 'janedoe', null, store)]);
    expect(Object.keys(seatPausesFrom(store.value)).sort()).toEqual(['intake', 'qa']);
  });

  it('is kept by name, with who paused it, when, and why, and a value that does not read pauses nobody', async () => {
    const store = memory();
    const pause = await pauseSeat('builder', 'janedoe', 'changing its model', store, new Date('2026-10-02T10:00:00Z'));
    expect(pause).toEqual({ by: 'janedoe', at: '2026-10-02T10:00:00.000Z', why: 'changing its model' });
    expect(seatPausesFrom(store.value)).toEqual({ builder: pause });
    expect(await seatPausedReason('builder', store.read)).toBe('builder is paused by janedoe: changing its model');
    expect(await seatPausedReason('intake', store.read)).toBeNull();

    expect(seatPausesFrom('not json')).toEqual({});
    expect(await resumeSeat('builder', 'janedoe', store)).toEqual(pause);
    expect(seatPausesFrom(store.value)).toEqual({});
    expect(await resumeSeat('builder', 'janedoe', store)).toBeNull();
  });

  it('keeps both of two seats paused at once: a pause is not lost to another written over it', async () => {
    const store = memory();
    // A read that takes a moment, as the database's does, and a lock that
    // lets one read-and-write through at a time, as the advisory lock does.
    const read = store.read;
    store.read = async () => {
      const value = await read();
      await new Promise((resolve) => setTimeout(resolve, 5));
      return value;
    };
    let held: Promise<unknown> = Promise.resolve();
    store.exclusive = <T,>(_key: string, fn: () => Promise<T>): Promise<T> => {
      const next = held.then(fn);
      held = next.catch(() => undefined);
      return next;
    };

    await Promise.all([pauseSeat('builder', 'janedoe', null, store), pauseSeat('intake', 'bob', null, store)]);
    expect(Object.keys(seatPausesFrom(store.value)).sort()).toEqual(['builder', 'intake']);

    await Promise.all([resumeSeat('builder', 'janedoe', store), pauseSeat('reviewer', 'bob', null, store)]);
    expect(Object.keys(seatPausesFrom(store.value)).sort()).toEqual(['intake', 'reviewer']);
  });

  it('is paused and resumed by its routes, each audited, and the resume starts what it held', async () => {
    const store = memory();
    const audit = vi.fn(async () => undefined);
    const resumed = vi.fn(async () => undefined);
    const router = new Router();
    registerSeatPauseRoutes(router, {
      store,
      audit,
      resumed,
      botNamed: async (name) => (name === 'builder' || name === 'fleetadlc-atlas-janedoe' ? { id: 'bot-1', name: 'fleetadlc-atlas-janedoe' } : null),
    });

    const paused = await call(router, 'POST', '/v1/crew/builder/pause', { reason: 'changing its model' });
    expect(paused.status).toBe(200);
    expect(paused.body).toMatchObject({ seat: 'fleetadlc-atlas-janedoe', seatPaused: { why: 'changing its model' } });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'seat.paused', target: 'fleetadlc-atlas-janedoe' }));

    const back = await call(router, 'POST', '/v1/crew/fleetadlc-atlas-janedoe/resume');
    expect(back.body).toMatchObject({ seatPaused: null, wasPaused: true });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'seat.resumed' }));
    expect(resumed).toHaveBeenCalledWith('fleetadlc-atlas-janedoe');

    expect((await call(router, 'POST', '/v1/crew/nobody/pause')).status).toBe(404);
  });

  it('finds the work only an event starts that the pause held, newest per subject, none taken up since', () => {
    const held = 'builder is paused by janedoe: changing its model. Resume it on the Crew page.';
    const tasks = [
      { id: 'a', subjectRef: 'api#4', state: 'failed', exitReason: held, createdAt: '2026-10-02T10:00:00Z' },
      // Taken up again since: the newest on the subject is not the held one.
      { id: 'b', subjectRef: 'api#5', state: 'failed', exitReason: held, createdAt: '2026-10-02T10:00:00Z' },
      { id: 'c', subjectRef: 'api#5', state: 'done', exitReason: 'complete', createdAt: '2026-10-02T11:00:00Z' },
      // Failed for something else.
      { id: 'd', subjectRef: 'api#6', state: 'failed', exitReason: 'make ci failed', createdAt: '2026-10-02T10:00:00Z' },
    ];
    expect(heldBySeatPause(tasks).map((task) => task.id)).toEqual(['a']);
  });

  it('finds the work held under a name the bot had before it was renamed', () => {
    const tasks = [
      {
        id: 'a',
        subjectRef: 'api#4',
        state: 'failed',
        exitReason: 'atlas was not started: atlas is paused by janedoe: checking its account. Resume it on the Crew page.',
        createdAt: '2026-10-02T10:00:00Z',
      },
    ];
    expect(heldBySeatPause(tasks).map((task) => task.id)).toEqual(['a']);
  });

  it('does not take the install’s or a repository’s pause for a seat’s', () => {
    const tasks = [
      { id: 'a', subjectRef: 'api#4', state: 'failed', exitReason: 'work is paused, by janedoe since 2026-10-02T09:00:00Z; resume it in Settings → Pause work', createdAt: '2026-10-02T10:00:00Z' },
      { id: 'b', subjectRef: 'api#5', state: 'failed', exitReason: 'work is paused in api, by janedoe since 2026-10-02T09:00:00Z; resume it in Settings → Pause work', createdAt: '2026-10-02T10:00:00Z' },
    ];
    expect(heldBySeatPause(tasks)).toEqual([]);
  });
});
