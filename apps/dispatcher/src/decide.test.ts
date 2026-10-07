import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the dispatcher starts, decided from what is true now.
 *
 * On the live install fleetadlc-testbed#3 waited twenty minutes behind a lease its
 * dependency had left behind after merging: a record, not work, held README.md.
 * These drive whole passes against a store that says what is in flight, and
 * look at what was started, sent to triage, or left alone.
 */

const ROUTABLE_BODY = [
  '### Outcome',
  'A second page.',
  '',
  '### Acceptance criteria',
  '- it shows Hello, world 2',
  '',
  '### Expected paths',
  '',
  '- hello-world2.html',
  '- README.md',
  '',
  '### Verification',
  '`make ci`',
].join('\n');

interface Issue {
  number: number;
  stage: string;
  labels: string[];
  body: string;
  declaredPaths: string[];
  title: string;
}

const world = vi.hoisted(() => ({
  candidates: [] as Issue[],
  known: [] as { number: number; stage: string; labels: string[] }[],
  inFlight: [] as { number: number; paths: string[]; building: boolean }[],
  leases: [] as { issueNumber: number; declaredPaths: string[] }[],
  /** The builder's tasks holding a computer, and the repository's builds not finished. */
  unfinished: 0,
  inRepo: null as number | null,
  maxTasks: 1,
  concurrency: 1,
  hostRoom: null as number | null,
  posted: [] as string[],
  /** `workPausedSeats` as stored, when a seat is paused. */
  pausedSeats: null as string | null,
  /** The events recorded, newest last. */
  events: [] as { type: string; payload: Record<string, unknown>; at: string }[],
}));

vi.mock('@fleetadlc/shared', async (original) => ({
  ...(await original<typeof import('@fleetadlc/shared')>()),
  fetchJson: vi.fn(async (url: string) => {
    world.posted.push(url.replace(/^https?:\/\/[^/]+/, ''));
    return {};
  }),
}));

vi.mock('@fleetadlc/db', () => ({
  audit: vi.fn(async () => undefined),
  bots: {
    getBotById: vi.fn(async () => ({ id: 'bot-builder', name: 'fleetadlc-atlas-janedoe', slot: 'builder', role: 'implement', engine: 'claude', maxTasks: world.maxTasks })),
    listBots: vi.fn(async () => [{ id: 'bot-builder', name: 'fleetadlc-atlas-janedoe', slot: 'builder', role: 'implement', engine: 'claude', maxTasks: world.maxTasks }]),
  },
  costs: {
    currentPeriod: vi.fn(() => '2026-09'),
    refreshBudget: vi.fn(async () => ({ state: 'ok', spentUsd: 1, capUsd: 1500 })),
  },
  spendingLimits: { refusal: vi.fn(async () => null) },
  health: { listHealth: vi.fn(async () => []) },
  issues: {
    listBlockedIssues: vi.fn(async () => []),
    listRoutableIssues: vi.fn(async () => world.candidates),
    listIssues: vi.fn(async () => world.known),
    workInFlight: vi.fn(async () => world.inFlight),
  },
  leases: {
    expireStaleLeases: vi.fn(async () => []),
    listActiveLeases: vi.fn(async () => world.leases),
    attemptsWithoutPullRequest: vi.fn(async () => 0),
    createLease: vi.fn(async () => ({ id: 'lease-1', expiresAt: null })),
    setLeaseState: vi.fn(async () => null),
  },
  repos: { listRepos: vi.fn(async () => [{ id: 'repo-1', name: 'fleetadlc-testbed', ownerBotId: 'bot-builder', concurrency: world.concurrency }]) },
  recordEvent: vi.fn(async (input: { type: string; payload: Record<string, unknown> }) => {
    world.events.push({ type: input.type, payload: input.payload, at: new Date().toISOString() });
    return 'event';
  }),
  listEventsOfType: vi.fn(async (type: string) =>
    world.events
      .filter((event) => event.type === type)
      .reverse()
      .map((event, index) => ({ id: index, at: event.at, payload: event.payload })),
  ),
  // Nothing paused: which repositories are is read each pass.
  settings: { getSetting: vi.fn(async (key: string) => (key === 'workPausedSeats' ? world.pausedSeats : null)) },
  tasks: {
    countSeatSlotsInUse: vi.fn(async () => world.unfinished),
    countUnfinishedImplementTasks: vi.fn(async () => world.inRepo ?? world.unfinished),
  },
  hosts: { taskRoom: vi.fn(async () => world.hostRoom) },
}));

function candidate(over: Partial<Issue> = {}): Issue {
  return {
    number: 3,
    stage: 'build',
    title: 'Add hello-world2.html',
    labels: ['adlc:build', 'start:now', 'priority:p1', 'area:docs', 'do:ai'],
    body: ROUTABLE_BODY,
    declaredPaths: ['hello-world2.html', 'README.md'],
    ...over,
  };
}

async function pass() {
  const { Dispatcher } = await import('./dispatcher.js');
  const dispatcher = new Dispatcher({
    bridgeUrl: 'http://bridge',
    internalSecret: 'secret',
    costs: { warningAt: 0.8, onCap: { stopLeasing: true } } as never,
    leaseHours: 12,
    dryRun: true,
  });
  return dispatcher.runOnce();
}

const started = (decisions: Awaited<ReturnType<typeof pass>>) =>
  decisions.filter((decision) => decision.action === 'leased').map((decision) => decision.issue);

beforeEach(() => {
  world.candidates = [candidate()];
  world.known = [];
  world.inFlight = [];
  world.leases = [];
  world.unfinished = 0;
  world.inRepo = null;
  world.maxTasks = 1;
  world.concurrency = 1;
  world.hostRoom = null;
  world.posted = [];
  world.pausedSeats = null;
  world.events = [];
});

describe('what is in flight', () => {
  it('is the work, not a lease left behind: a merged dependency’s lease claims nothing', async () => {
    world.leases = [{ issueNumber: 1, declaredPaths: ['index.html', 'README.md'] }];

    expect(started(await pass())).toEqual([3]);
  });

  it('holds another issue’s files while it is being built', async () => {
    world.inFlight = [{ number: 5, paths: ['hello-world2.html', 'docs/'], building: true }];

    const decisions = await pass();

    expect(started(decisions)).toEqual([]);
    expect(decisions).toContainEqual(
      expect.objectContaining({ issue: 3, action: 'skipped', reason: 'declared paths overlap work in flight: #5 (hello-world2.html), being built' }),
    );
  });

  it('builds beside another issue waiting in review on an ordinary file: the merge line catches a clash', async () => {
    // Held until merge, review and all, the next change waited out a review
    // it had nothing to do with.
    world.inFlight = [{ number: 5, paths: ['hello-world2.html'], building: false }];

    expect(started(await pass())).toEqual([3]);
  });

  it('never holds anything back on a shared file, however busy', async () => {
    // README.md and the Makefile are touched by nearly every change; #3 waited
    // for #2 on the Makefile, and #6 for #1 on README.md.
    world.candidates = [candidate({ declaredPaths: ['README.md', 'Makefile', 'docs/snake/index.md'] })];
    world.inFlight = [{ number: 5, paths: ['README.md', 'Makefile', 'docs/snake/index.md'], building: true }];

    expect(started(await pass())).toEqual([3]);
  });

  it('holds an exclusive path through the other’s review, until it merges', async () => {
    world.candidates = [candidate({ declaredPaths: ['db/migrations/0002_add.sql'] })];
    world.inFlight = [{ number: 5, paths: ['db/migrations/'], building: false }];

    const decisions = await pass();

    expect(started(decisions)).toEqual([]);
    expect(decisions).toContainEqual(
      expect.objectContaining({
        issue: 3,
        reason: 'declared paths overlap work in flight: #5 (db/migrations/0002_add.sql against db/migrations/), an exclusive path in review',
      }),
    );
  });

  it('records when an issue starts waiting on overlap, and when it stops, with how long', async () => {
    world.inFlight = [{ number: 5, paths: ['hello-world2.html'], building: true }];
    await pass();
    expect(world.events).toContainEqual(
      expect.objectContaining({
        type: 'overlap.waited',
        payload: expect.objectContaining({ repo: 'fleetadlc-testbed', issue: 3, on: [5], paths: ['hello-world2.html'], kind: 'building' }),
      }),
    );
    // Asked again with nothing changed, it is not said twice.
    await pass();
    expect(world.events.filter((event) => event.type === 'overlap.waited')).toHaveLength(1);

    world.inFlight = [];
    await pass();
    expect(world.events).toContainEqual(
      expect.objectContaining({ type: 'overlap.cleared', payload: expect.objectContaining({ repo: 'fleetadlc-testbed', issue: 3, waitedMs: expect.any(Number) }) }),
    );
  });

  it('never holds an issue’s files against the issue itself', async () => {
    // Its own earlier attempt, ended, with a pull request number still recorded.
    world.inFlight = [{ number: 3, paths: ['README.md', 'hello-world2.html'], building: false }];

    expect(started(await pass())).toEqual([3]);
  });
});

describe('a seat a person paused', () => {
  it('is leased nothing, and the pass says who paused it and why', async () => {
    world.pausedSeats = JSON.stringify({ 'fleetadlc-atlas-janedoe': { by: 'janedoe', at: '2026-10-02T00:00:00Z', why: 'changing its model' } });

    const decisions = await pass();

    expect(started(decisions)).toEqual([]);
    expect(decisions).toContainEqual(
      expect.objectContaining({
        bot: 'fleetadlc-atlas-janedoe',
        action: 'skipped',
        reason: 'fleetadlc-atlas-janedoe is paused by janedoe: changing its model; nothing is leased to it until it is resumed on the Crew page',
      }),
    );
  });

  it('is leased to again once resumed', async () => {
    world.pausedSeats = JSON.stringify({});
    expect(started(await pass())).toEqual([3]);
  });
});

describe('an issue a person held or put next', () => {
  it('starts nothing on one held, and says why', async () => {
    world.candidates = [candidate({ labels: ['adlc:build', 'start:now', 'priority:p1', 'fleetadlc:paused'] })];

    const decisions = await pass();

    expect(started(decisions)).toEqual([]);
    expect(decisions).toContainEqual(expect.objectContaining({ issue: 3, action: 'skipped', reason: 'held by a person (fleetadlc:paused)' }));
  });

  it('builds the one put next first, ahead of the order it was listed in', async () => {
    world.candidates = [
      candidate({ number: 3, declaredPaths: ['a.html'] }),
      candidate({ number: 9, labels: ['adlc:build', 'start:now', 'priority:p3', 'area:docs', 'do:ai', 'fleetadlc:next'], declaredPaths: ['b.html'] }),
    ];

    expect(started(await pass())).toEqual([9]);
  });

  it('still waits when the one put next overlaps work in flight, and says so', async () => {
    world.candidates = [candidate({ number: 9, labels: ['adlc:build', 'start:now', 'priority:p1', 'area:docs', 'do:ai', 'fleetadlc:next'], declaredPaths: ['b.html'] })];
    world.inFlight = [{ number: 5, paths: ['b.html'], building: true }];

    const decisions = await pass();

    expect(started(decisions)).toEqual([]);
    expect(decisions).toContainEqual(expect.objectContaining({ issue: 9, reason: 'next, but declared paths overlap work in flight: #5 (b.html), being built' }));
  });
});

describe('an issue already being built', () => {
  it('is left alone, and never sent to triage for what it said before', async () => {
    world.candidates = [candidate({ body: 'too short to route' })];
    world.inFlight = [{ number: 3, paths: ['README.md'], building: true }];

    const decisions = await pass();

    expect(decisions.filter((decision) => decision.issue === 3)).toEqual([]);
    expect(world.posted).toEqual([]);
  });
});

describe('an issue that waits on another', () => {
  const waiting = candidate({ body: `${ROUTABLE_BODY}\n\n### Dependencies\n\n- #1\n` });

  it('is not started while what it waits on has not shipped, whatever its labels say', async () => {
    world.candidates = [waiting];
    world.known = [{ number: 1, stage: 'review', labels: ['adlc:review'] }];

    const decisions = await pass();
    expect(started(decisions)).toEqual([]);
    // Said, so a wait on something that will never ship is not silent.
    expect(decisions).toContainEqual(expect.objectContaining({ issue: 3, action: 'skipped', reason: 'waits on #1, not shipped yet' }));
  });

  it('is started in the pass that sees it shipped', async () => {
    world.candidates = [waiting];
    world.known = [{ number: 1, stage: 'done', labels: ['adlc:done'] }];

    expect(started(await pass())).toEqual([3]);
  });
});

describe('which builders are free', () => {
  it('counts a build waiting on a person against its repository: the answer resumes it', async () => {
    world.unfinished = 1;

    expect(started(await pass())).toEqual([]);
  });

  it('counts a paused build against the repository even once its computer is given back, but not against its seat', async () => {
    // Paused, its computer released: the seat has room, the repository does not.
    world.unfinished = 0;
    world.inRepo = 1;

    expect(started(await pass())).toEqual([]);

    world.concurrency = 2;
    world.candidates = [candidate({ number: 3 }), candidate({ number: 4, declaredPaths: ['other.html'] })];
    expect(started(await pass())).toEqual([3]);
  });

  it('gives one seat two builds at once when its tasks at once and the concurrency say so', async () => {
    // Raising concurrency used to need a second seat and a second account.
    world.maxTasks = 2;
    world.concurrency = 2;
    world.candidates = [candidate({ number: 3 }), candidate({ number: 4, declaredPaths: ['other.html'] }), candidate({ number: 5, declaredPaths: ['third.html'] })];

    const decisions = await pass();

    expect(started(decisions)).toEqual([3, 4]);
    expect(decisions.filter((decision) => decision.action === 'leased').map((decision) => decision.bot)).toEqual([
      'fleetadlc-atlas-janedoe',
      'fleetadlc-atlas-janedoe',
    ]);
  });

  it('says what is missing when the concurrency outruns what the builders can run between them', async () => {
    world.concurrency = 3;
    world.maxTasks = 2;

    const decisions = await pass();

    expect(decisions).toContainEqual(
      expect.objectContaining({
        action: 'skipped',
        reason: "concurrency is 3 but the builders' combined maxTasks is 2; raise a builder's tasks at once on the Crew page, or add a builder-2 seat in Settings → Crew",
      }),
    );
  });

  it('starts no more than the hosts have room for, and says so', async () => {
    world.maxTasks = 2;
    world.concurrency = 2;
    world.hostRoom = 1;
    world.candidates = [candidate({ number: 3 }), candidate({ number: 4, declaredPaths: ['other.html'] })];

    const decisions = await pass();

    expect(started(decisions)).toEqual([3]);
    expect(decisions).toContainEqual(expect.objectContaining({ action: 'skipped', reason: expect.stringMatching(/^every host is running all the tasks it has room for/) }));
  });

  it('still sends an issue that says too little to triage when nobody is free', async () => {
    world.unfinished = 1;
    world.candidates = [candidate({ body: 'too short to route', declaredPaths: [] })];

    await pass();

    expect(world.posted).toEqual(['/internal/issues/fleetadlc-testbed/3/triage']);
  });
});
