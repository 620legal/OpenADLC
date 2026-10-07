import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The requests table and intake's tasks as the queue reads them. `running` is
 * intake's queued or running tasks, which is what makes it busy: a task paused
 * on a person's answer is not counted, as `countActiveTasksForBot` does not.
 */
interface Row {
  id: string;
  state: string;
  repoId: string | null;
  createdAt: string;
  queueAttempts: number;
  queueReason: string | null;
  updatedAt: string;
}

const store = vi.hoisted(() => ({
  requests: [] as Row[],
  running: 0,
  /** Task rows by subject, as the recovery and the clean-up read them. */
  taskRows: [] as { id: string; subjectRef: string; state: string; exitReason?: string }[],
}));

vi.mock('@fleetadlc/db', () => ({
  spendingLimits: {
    SPENDING_PROVIDERS: ['anthropic', 'openai', 'xai'],
    GLOBAL_SCOPE: 'global',
    seedGlobal: vi.fn(async () => false),
    effectiveTaskCap: vi.fn(async (_repoId: string | null, fallback: number) => fallback),
    amountOf: vi.fn(async () => null),
    refusal: vi.fn(async () => null),
    listLimits: vi.fn(async () => []),
    setLimit: vi.fn(async () => undefined),
    dollars: (amount: number) => (Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`),
    botKind: (id: string) => `month_bot:${id}`,
    providerKind: (provider: string) => `month_provider:${provider}`,
    repoScope: (id: string) => `repo:${id}`,
    repoIdOf: (scope: string) => (scope.startsWith('repo:') ? scope.slice(5) : null),
  },

  bots: { listBots: vi.fn(async () => [{ id: 'bot-intake', name: 'ottoexampleco', role: 'intake' }]) },
  repos: { listRepos: vi.fn(async () => [{ id: 'repo-1', name: 'fleetadlc-testbed' }]) },
  requests: {
    listQueued: vi.fn(async () =>
      store.requests
        .filter((one) => one.state === 'queued')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((one) => ({ ...one })),
    ),
    listInState: vi.fn(async (state: string) => store.requests.filter((one) => one.state === state).map((one) => ({ ...one }))),
    listDraftsSince: vi.fn(async (since: Date) =>
      store.requests.filter((one) => one.state === 'draft' && Date.parse(one.updatedAt) >= since.getTime()).map((one) => ({ ...one })),
    ),
    claimQueued: vi.fn(async (id: string) => {
      const found = store.requests.find((one) => one.id === id && one.state === 'queued');
      if (!found) return null;
      found.state = 'draft';
      return { ...found };
    }),
    requeue: vi.fn(async (id: string, failure?: string, options: { counts?: boolean } = {}) => {
      const found = store.requests.find((one) => one.id === id && one.state === 'draft');
      if (!found) return;
      found.state = 'queued';
      found.updatedAt = new Date().toISOString();
      if (failure) {
        if (options.counts ?? true) found.queueAttempts += 1;
        found.queueReason = failure;
      }
    }),
  },
  tasks: {
    countActiveTasksForBot: vi.fn(async () => store.running),
    seatHasRoom: vi.fn(async () => store.running < 1),
    listTasksOnSubjects: vi.fn(async (refs: string[]) => store.taskRows.filter((task) => refs.includes(task.subjectRef))),
    updateTaskState: vi.fn(async (id: string, state: string, patch: { exitReason?: string }) => {
      const found = store.taskRows.find((task) => task.id === id);
      if (found) Object.assign(found, { state, exitReason: patch.exitReason });
      return found ?? null;
    }),
  },
  withAdvisoryLock: vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
}));

const { MAX_ATTEMPTS, RETRY_AFTER_MS, RequestQueue, queuePositions, withPositions, REQUEST_QUEUE_LOCK } = await import('./request-queue.js');
const { BotBusyError, PrerequisiteNotReadyError, SpendingCapError } = await import('./task-service.js');
const { withAdvisoryLock } = await import('@fleetadlc/db');

function queued(id: string, at: string, overrides: Partial<Row> = {}): Row {
  return { id, state: 'queued', repoId: 'repo-1', createdAt: at, queueAttempts: 0, queueReason: null, updatedAt: at, ...overrides };
}

/** A task service whose triage runs until told to stop, as intake's does. */
function intake() {
  const opened: string[] = [];
  const open = vi.fn(async (input: { subjectRef: string }) => {
    if (store.running > 0) throw new BotBusyError('ottoexampleco');
    store.running += 1;
    opened.push(input.subjectRef);
    return { taskId: `task-${opened.length}`, session: 'fleetadlc-1' };
  });
  return { taskService: { open }, opened };
}

/** An advisory lock as Postgres holds one: a second taker waits for the first to let go. */
function sharedLock() {
  let held: Promise<unknown> = Promise.resolve();
  return vi.fn(<T,>(_key: string, fn: () => Promise<T>): Promise<T> => {
    const run = held.catch(() => undefined).then(fn);
    held = run.catch(() => undefined);
    return run;
  });
}

const quiet = { log: () => undefined };

beforeEach(() => {
  store.requests = [];
  store.running = 0;
  store.taskRows = [];
  vi.mocked(withAdvisoryLock).mockClear();
});

describe('a request waiting for intake', () => {
  it('waits while intake is busy, and nothing is started', async () => {
    store.requests = [queued('aaaaaaaa-1', '2026-09-29T10:00:00Z')];
    store.running = 1;
    const { taskService, opened } = intake();

    expect(await new RequestQueue({ taskService, ...quiet }).drain()).toEqual([]);

    expect(opened).toEqual([]);
    expect(store.requests[0]?.state).toBe('queued');
  });

  it('waits, uncounted, while a person has the intake seat paused, and starts once it is resumed', async () => {
    // Asked to start anyway, each request was refused on its own account and
    // counted an attempt, and a paused intake would have given them up.
    store.requests = [queued('aaaaaaaa-1', '2026-09-29T10:00:00Z')];
    const { taskService, opened } = intake();
    let paused: string | null = 'intake is paused by janedoe: changing its model';
    const queue = new RequestQueue({ taskService, ...quiet, seatPaused: async () => paused });

    expect(await queue.drain()).toEqual([]);
    expect(opened).toEqual([]);
    expect(store.requests[0]).toMatchObject({ state: 'queued' });
    expect(store.requests[0]?.queueAttempts ?? 0).toBe(0);

    paused = null;
    expect((await queue.drain()).map((one) => one.requestId)).toEqual(['aaaaaaaa-1']);
  });

  it('starts oldest first once intake is free, one while it is busy with that one', async () => {
    store.requests = [queued('bbbbbbbb-2', '2026-09-29T10:05:00Z'), queued('aaaaaaaa-1', '2026-09-29T10:00:00Z')];
    const { taskService, opened } = intake();
    const queue = new RequestQueue({ taskService, ...quiet });

    expect((await queue.drain()).map((one) => one.requestId)).toEqual(['aaaaaaaa-1']);
    expect(store.requests.find((one) => one.id === 'bbbbbbbb-2')?.state).toBe('queued');

    // Its triage ended, or paused on a question: intake is free for the next.
    store.running = 0;
    expect((await queue.drain()).map((one) => one.requestId)).toEqual(['bbbbbbbb-2']);
    expect(opened).toEqual(['request:aaaaaaaa', 'request:bbbbbbbb']);
  });

  it('keeps its place when intake turned busy between the look and the start', async () => {
    store.requests = [queued('aaaaaaaa-1', '2026-09-29T10:00:00Z')];
    const open = vi.fn(async () => {
      throw new BotBusyError('ottoexampleco');
    });

    expect(await new RequestQueue({ taskService: { open }, ...quiet }).drain()).toEqual([]);

    expect(store.requests[0]).toMatchObject({ state: 'queued', queueAttempts: 0, queueReason: null });
  });

  it('is passed over when intake cannot start it, with why, and the request behind it starts', async () => {
    // Intake cannot work in the first request's repository; the second's is fine.
    store.requests = [queued('aaaaaaaa-1', '2026-09-29T10:00:00Z'), queued('bbbbbbbb-2', '2026-09-29T10:05:00Z')];
    const said: string[] = [];
    const opened: string[] = [];
    const open = vi.fn(async (input: { subjectRef: string }) => {
      if (input.subjectRef === 'request:aaaaaaaa') throw new Error('ottoexampleco was not started: ottoexampleco cannot work in fleetadlc-private.');
      opened.push(input.subjectRef);
      return { taskId: 'task-1', session: 'fleetadlc-1' };
    });

    await new RequestQueue({ taskService: { open }, log: (line) => said.push(line) }).drain();

    expect(opened).toEqual(['request:bbbbbbbb']);
    expect(store.requests[0]).toMatchObject({ state: 'queued', queueAttempts: 1, queueReason: expect.stringContaining('cannot work in fleetadlc-private') });
    expect(said).toContainEqual(expect.stringContaining('its triage could not start, and it waits (attempt 1 of 5)'));
  });

  it('keeps its attempts while a spending cap refuses it, and starts once the cap allows', async () => {
    // Counted, five refusals in about eighteen minutes left it waiting for
    // a person's "Try again" even after the cap was raised.
    store.requests = [queued('aaaaaaaa-1', '2026-09-29T10:00:00Z'), queued('bbbbbbbb-2', '2026-09-29T10:05:00Z')];
    let capped = true;
    let spent = 1500;
    const opened: string[] = [];
    const open = vi.fn(async (input: { subjectRef: string }) => {
      // Work already running keeps spending, so the words change each sweep.
      spent += 3;
      if (capped && input.subjectRef === 'request:aaaaaaaa') {
        throw new SpendingCapError('ottoexampleco', `month-to-date spend is $${spent.toFixed(2)} of $1500.00; not leasing new work`);
      }
      opened.push(input.subjectRef);
      return { taskId: `task-${opened.length}`, session: 'fleetadlc-1' };
    });
    const said: string[] = [];
    const queue = new RequestQueue({ taskService: { open }, log: (line) => said.push(line) });

    for (let sweep = 0; sweep < MAX_ATTEMPTS + 2; sweep += 1) {
      await queue.drain();
      // Long enough for the next sweep to try it again.
      const waiting = store.requests.find((one) => one.id === 'aaaaaaaa-1');
      if (waiting) waiting.updatedAt = '2026-09-29T09:00:00Z';
    }

    expect(store.requests[0]).toMatchObject({ state: 'queued', queueAttempts: 0, queueReason: expect.stringContaining('was held at a spending cap') });
    // Passed over, not in the way of the one behind it.
    expect(opened).toEqual(['request:bbbbbbbb']);
    // Said once, not on every sweep.
    expect(said.filter((line) => line.includes('waits for a spending cap'))).toHaveLength(1);

    capped = false;
    await queue.drain();
    expect(opened).toEqual(['request:bbbbbbbb', 'request:aaaaaaaa']);
  });

  it('is tried a bounded number of times, then waits for a person', async () => {
    store.requests = [queued('aaaaaaaa-1', '2026-09-29T10:00:00Z', { queueAttempts: MAX_ATTEMPTS, queueReason: 'cannot work in fleetadlc-private' })];
    const { taskService, opened } = intake();

    await new RequestQueue({ taskService, ...quiet }).drain();

    expect(opened).toEqual([]);
    // Nothing it would try: an idle sweep, no lock taken.
    expect(vi.mocked(withAdvisoryLock)).not.toHaveBeenCalled();
  });

  it('stops the walk, and keeps its place with why, when hostd refused the start', async () => {
    store.requests = [queued('aaaaaaaa-1', '2026-09-29T10:00:00Z'), queued('bbbbbbbb-2', '2026-09-29T10:05:00Z')];
    // hostd answers without throwing; the task is recorded failed and intake is free.
    const open = vi.fn(async () => ({ taskId: 'task-1', session: null, error: 'hostd did not answer' }));

    expect(await new RequestQueue({ taskService: { open }, ...quiet }).drain()).toEqual([]);

    expect(open).toHaveBeenCalledTimes(1);
    // Not counted against the request: hostd, not it, is what failed.
    expect(store.requests.map((one) => [one.id, one.state, one.queueAttempts])).toEqual([
      ['aaaaaaaa-1', 'queued', 0],
      ['bbbbbbbb-2', 'queued', 0],
    ]);
    expect(store.requests[0]?.queueReason).toBe('hostd refused: hostd did not answer');
  });

  const blockers = {
    host: { row: 'hostd', kind: 'host', why: 'OpenADLC’s host service is not answering', instruction: 'Start hostd.' },
    'sign-in': { row: 'bot-sign-in:bot-intake', kind: 'sign-in', why: 'ottoexampleco cannot sign in to GitHub', instruction: 'Sign it in.' },
  } as const;

  for (const kind of ['host', 'sign-in'] as const) {
    it(`a ${kind} blocker stops the walk without counting an attempt`, async () => {
      // Counted, one walk charged every request in line, and after about
      // eighteen minutes of outage none was ever tried again.
      store.requests = [
        queued('aaaaaaaa-1', '2026-09-29T10:00:00Z'),
        queued('bbbbbbbb-2', '2026-09-29T10:05:00Z'),
        queued('cccccccc-3', '2026-09-29T10:10:00Z'),
      ];
      let down = true;
      const opened: string[] = [];
      const open = vi.fn(async (input: { subjectRef: string }) => {
        if (down) throw new PrerequisiteNotReadyError('ottoexampleco', [blockers[kind]]);
        opened.push(input.subjectRef);
        return { taskId: `task-${opened.length}`, session: 'fleetadlc-1' };
      });
      const said: string[] = [];
      const queue = new RequestQueue({ taskService: { open }, log: (line) => said.push(line) });

      await queue.drain();
      expect(open).toHaveBeenCalledTimes(1);
      expect(store.requests.map((one) => one.queueAttempts)).toEqual([0, 0, 0]);

      for (let sweep = 1; sweep < MAX_ATTEMPTS; sweep += 1) {
        // Long enough for the next sweep to try it again.
        for (const one of store.requests) one.updatedAt = '2026-09-29T09:00:00Z';
        await queue.drain();
      }
      expect(open).toHaveBeenCalledTimes(MAX_ATTEMPTS);
      expect(store.requests.every((one) => one.state === 'queued' && one.queueAttempts === 0)).toBe(true);
      expect(said).toEqual([`request:aaaaaaaa: the queue waits, counting no attempt, while ${blockers[kind].why}`]);

      down = false;
      for (const one of store.requests) one.updatedAt = '2026-09-29T09:00:00Z';
      await queue.drain();
      expect(opened).toEqual(['request:aaaaaaaa', 'request:bbbbbbbb', 'request:cccccccc']);
    });
  }

  it('an access blocker counts an attempt and passes the request over', async () => {
    store.requests = [queued('aaaaaaaa-1', '2026-09-29T10:00:00Z'), queued('bbbbbbbb-2', '2026-09-29T10:05:00Z')];
    const opened: string[] = [];
    const open = vi.fn(async (input: { subjectRef: string }) => {
      if (input.subjectRef === 'request:aaaaaaaa') {
        throw new PrerequisiteNotReadyError('ottoexampleco', [
          { row: 'bot-access:bot-intake:fleetadlc-testbed', kind: 'access', why: 'ottoexampleco cannot work in fleetadlc-testbed', instruction: 'Invite it.' },
        ]);
      }
      opened.push(input.subjectRef);
      return { taskId: 'task-1', session: 'fleetadlc-1' };
    });

    await new RequestQueue({ taskService: { open }, ...quiet }).drain();

    expect(opened).toEqual(['request:bbbbbbbb']);
    expect(store.requests[0]).toMatchObject({ state: 'queued', queueAttempts: 1 });
  });

  it('stops a task row a start left behind when it threw, so intake is not held by it', async () => {
    store.requests = [queued('aaaaaaaa-1', '2026-09-29T10:00:00Z')];
    const open = vi.fn(async () => {
      store.taskRows.push({ id: 'task-9', subjectRef: 'request:aaaaaaaa', state: 'queued' });
      throw new Error('the thread could not be written');
    });

    await new RequestQueue({ taskService: { open }, ...quiet }).drain();

    expect(store.taskRows[0]).toMatchObject({ state: 'stopped', exitReason: expect.stringContaining('the request waits in line again') });
    expect(store.requests[0]?.state).toBe('queued');
  });

  it('waits longer between tries the more a start failed, passing over what is backing off', async () => {
    const now = Date.now();
    const ago = (ms: number) => new Date(now - ms).toISOString();
    store.requests = [
      // Failed three times, two minutes ago: its next try is at five.
      queued('aaaaaaaa-1', '2026-09-29T10:00:00Z', { queueAttempts: 3, queueReason: 'cannot work in fleetadlc-private', updatedAt: ago(RETRY_AFTER_MS[0]! * 2) }),
      // Failed once, two minutes ago: a minute's wait is over.
      queued('bbbbbbbb-2', '2026-09-29T10:05:00Z', { queueAttempts: 1, queueReason: 'cannot work in fleetadlc-private', updatedAt: ago(RETRY_AFTER_MS[0]! * 2) }),
    ];
    const { taskService, opened } = intake();

    await new RequestQueue({ taskService, ...quiet }).drain();

    expect(opened).toEqual(['request:bbbbbbbb']);
    expect(RETRY_AFTER_MS.map((ms) => ms / 60_000)).toEqual([1, 2, 5, 10]);
  });

  it('takes no lock when everything waiting is backing off', async () => {
    store.requests = [queued('aaaaaaaa-1', '2026-09-29T10:00:00Z', { queueAttempts: 1, queueReason: 'hostd refused', updatedAt: new Date().toISOString() })];
    const { taskService, opened } = intake();

    await new RequestQueue({ taskService, ...quiet }).drain();

    expect(opened).toEqual([]);
    expect(vi.mocked(withAdvisoryLock)).not.toHaveBeenCalled();
  });

  it('puts back in line, after a restart, a request claimed within the hour but never started', async () => {
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    store.requests = [
      { ...queued('aaaaaaaa-1', '2026-09-29T10:00:00Z', { updatedAt: recent }), state: 'draft' },
      // A draft with a triage (failed, here) has its card, and is left to it.
      { ...queued('bbbbbbbb-2', '2026-09-29T10:05:00Z', { updatedAt: recent }), state: 'draft' },
      // Weeks old: from before the queue, whatever it is. Not revived.
      { ...queued('cccccccc-3', '2026-09-01T10:00:00Z', { updatedAt: '2026-09-01T10:00:00Z' }), state: 'draft' },
    ];
    store.taskRows = [{ id: 'task-1', subjectRef: 'request:bbbbbbbb', state: 'failed' }];
    store.running = 1;
    const { taskService } = intake();

    await new RequestQueue({ taskService, ...quiet }).drain();

    expect(store.requests.map((one) => [one.id, one.state])).toEqual([
      ['aaaaaaaa-1', 'queued'],
      ['bbbbbbbb-2', 'draft'],
      ['cccccccc-3', 'draft'],
    ]);
  });

  it('is started once when two bridges drain at the same moment', async () => {
    store.requests = [queued('aaaaaaaa-1', '2026-09-29T10:00:00Z'), queued('bbbbbbbb-2', '2026-09-29T10:05:00Z')];
    const { taskService, opened } = intake();
    const exclusive = sharedLock();
    const one = new RequestQueue({ taskService, exclusive: exclusive as never, ...quiet });
    const other = new RequestQueue({ taskService, exclusive: exclusive as never, ...quiet });

    await Promise.all([one.drain(), other.drain(), one.drain()]);

    expect(opened).toEqual(['request:aaaaaaaa']);
    expect(exclusive).toHaveBeenCalledWith(REQUEST_QUEUE_LOCK, expect.any(Function));
    expect(taskService.open).toHaveBeenCalledTimes(1);
  });

  it('is started once even without the lock, the claim being one statement', async () => {
    store.requests = [queued('aaaaaaaa-1', '2026-09-29T10:00:00Z')];
    const opened: string[] = [];
    const open = vi.fn(async (input: { subjectRef: string }) => {
      opened.push(input.subjectRef);
      return { taskId: 'task-1', session: 'fleetadlc-1' };
    });
    // Two processes that each think they hold the lock.
    const free = <T,>(_key: string, fn: () => Promise<T>) => fn();

    await Promise.all([
      new RequestQueue({ taskService: { open }, exclusive: free, ...quiet }).drain(),
      new RequestQueue({ taskService: { open }, exclusive: free, ...quiet }).drain(),
    ]);

    expect(opened).toEqual(['request:aaaaaaaa']);
  });

  it('takes no lock on a sweep with nothing waiting', async () => {
    const { taskService } = intake();

    expect(await new RequestQueue({ taskService, ...quiet }).drain()).toEqual([]);

    expect(vi.mocked(withAdvisoryLock)).not.toHaveBeenCalled();
  });
});

describe('a request’s place in line', () => {
  it('is 1 for the next to start, and none for one that is not waiting', async () => {
    store.requests = [
      queued('bbbbbbbb-2', '2026-09-29T10:05:00Z'),
      queued('aaaaaaaa-1', '2026-09-29T10:00:00Z'),
      { ...queued('cccccccc-3', '2026-09-29T09:00:00Z'), state: 'draft' },
    ];

    expect([...(await queuePositions()).entries()]).toEqual([
      ['aaaaaaaa-1', 1],
      ['bbbbbbbb-2', 2],
    ]);
    expect((await withPositions(store.requests)).map((one) => [one.id, one.queuePosition])).toEqual([
      ['bbbbbbbb-2', 2],
      ['aaaaaaaa-1', 1],
      ['cccccccc-3', null],
    ]);
  });

  it('is none for one the queue gave up on, which takes no place from those behind it', async () => {
    store.requests = [
      { ...queued('aaaaaaaa-1', '2026-09-29T10:00:00Z'), queueAttempts: MAX_ATTEMPTS, queueReason: 'intake is not ready' },
      queued('bbbbbbbb-2', '2026-09-29T10:05:00Z'),
    ];

    expect((await withPositions(store.requests)).map((one) => [one.id, one.queuePosition])).toEqual([
      ['aaaaaaaa-1', null],
      ['bbbbbbbb-2', 1],
    ]);
  });
});

describe('while work is paused', () => {
  it('starts nothing, however free intake is, and starts the line once work resumes', async () => {
    store.requests = [queued('req-a', '2026-09-29T10:00:00.000Z'), queued('req-b', '2026-09-29T10:01:00.000Z')];
    let paused: string | null = 'work is paused, by janedoe since 2026-09-29T10:00:00.000Z; resume it in Settings → Pause work';
    const { taskService, opened } = intake();
    const queue = new RequestQueue({ taskService, paused: () => paused });

    expect(await queue.drain()).toEqual([]);
    expect(opened).toEqual([]);
    expect(store.requests.map((one) => one.state)).toEqual(['queued', 'queued']);

    paused = null;
    const started = await queue.drain();
    expect(started.map((one) => one.requestId)).toEqual(['req-a']);
  });
});

describe('a request claimed but never started', () => {
  it('goes back in line on any sweep, paused or not, and starts nothing while paused', async () => {
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    store.requests = [{ ...queued('aaaaaaaa-1', '2026-09-29T10:00:00Z', { updatedAt: recent }), state: 'draft' }];
    let paused: string | null = 'work is paused';
    const { taskService, opened } = intake();
    const queue = new RequestQueue({ taskService, paused: () => paused, ...quiet });

    expect(await queue.drain()).toEqual([]);
    expect(store.requests.map((one) => one.state)).toEqual(['queued']);
    expect(opened).toEqual([]);

    paused = null;
    expect((await queue.drain()).map((one) => one.requestId)).toEqual(['aaaaaaaa-1']);
  });
});

describe('while one repository is paused', () => {
  it('passes over its requests, keeping their place, starts the rest, and starts them once it resumes', async () => {
    vi.mocked((await import('@fleetadlc/db')).repos.listRepos).mockResolvedValue([
      { id: 'repo-1', name: 'fleetadlc-testbed' },
      { id: 'repo-2', name: 'fleetadlc-other' },
    ] as never);
    store.requests = [
      queued('req-a', '2026-09-29T10:00:00.000Z'),
      queued('req-b', '2026-09-29T10:01:00.000Z', { repoId: 'repo-2' }),
      // No repository yet: intake picks one, so its triage runs.
      queued('req-c', '2026-09-29T10:02:00.000Z', { repoId: null }),
    ];
    const pausedRepos = new Set(['fleetadlc-testbed']);
    const { taskService, opened } = intake();
    const queue = new RequestQueue({
      taskService,
      paused: (repo) => (repo && pausedRepos.has(repo) ? `work is paused in ${repo}, by janedoe` : null),
      ...quiet,
    });

    expect((await queue.drain()).map((one) => one.requestId)).toEqual(['req-b']);
    store.running = 0;
    expect((await queue.drain()).map((one) => one.requestId)).toEqual(['req-c']);
    store.running = 0;
    expect(await queue.drain()).toEqual([]);
    expect(opened).toEqual(['request:req-b', 'request:req-c']);
    // Waiting, not failed: nothing counted against it.
    expect(store.requests.find((one) => one.id === 'req-a')).toMatchObject({ state: 'queued', queueAttempts: 0, queueReason: null });

    pausedRepos.delete('fleetadlc-testbed');
    expect((await queue.drain()).map((one) => one.requestId)).toEqual(['req-a']);
    vi.mocked((await import('@fleetadlc/db')).repos.listRepos).mockResolvedValue([{ id: 'repo-1', name: 'fleetadlc-testbed' }] as never);
  });
});
