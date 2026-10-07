import { leases } from '@fleetadlc/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { startBuild } from './build-start.js';
import { STACK_MADE, STACK_PAUSED, STACK_STARTED, STACK_UPDATED, STACK_UPDATING, Stacking } from './stacking.js';

const REPO = { id: 'repo-1', name: 'shop', fullName: 'janedoe/shop', defaultBranch: 'main', concurrency: 2 };
const OTHER = { id: 'repo-2', name: 'mill', fullName: 'janedoe/mill', defaultBranch: 'main', concurrency: 2 };
const A_BRANCH = 'agent/atlas/4-issue-4';

type Issue = { number: number; stage: string; labels: string[]; prNumber: number | null; body: string; declaredPaths: string[] };

const world = vi.hoisted(() => ({
  issues: new Map<number, Issue>(),
  leases: new Map<number, { id: string }>(),
  created: [] as { issueNumber: number; botId: string }[],
  released: [] as string[],
  labels: [] as { number: number; labels: string[] }[],
  holds: [] as { subject: string; why: string | null }[],
  /** The `stacks` table, by stacked issue. */
  stacks: new Map<number, Record<string, unknown> & { issue: number; onIssue: number; pausedAt: string | null }>(),
  stackWriteFails: false,
  stackReadFails: false,
  repos: [] as { id: string; name: string; fullName: string; defaultBranch: string; concurrency: number }[],
  attempts: 0,
  inFlight: [] as { number: number; paths: string[]; building: boolean }[],
  unfinished: 0,
}));

vi.mock('@fleetadlc/db', () => ({
  bots: { listBots: vi.fn(async () => [{ id: 'bot-1', name: 'atlas' }]) },
  issues: {
    getIssue: vi.fn(async (_repo: string, number: number) => world.issues.get(number) ?? null),
    listBlockedIssues: vi.fn(async () => [...world.issues.values()].filter((issue) => issue.labels.includes('blocked'))),
    workInFlight: vi.fn(async () => world.inFlight),
    setIssueLabels: vi.fn(async (_repo: string, number: number, labels: string[]) => {
      world.labels.push({ number, labels });
    }),
  },
  leases: {
    attemptsWithoutPullRequest: vi.fn(async () => world.attempts),
    getActiveLease: vi.fn(async (repo: string, number: number) => (repo === 'repo-1' ? (world.leases.get(number) ?? null) : null)),
    createLease: vi.fn(async (input: { issueNumber: number; botId: string; declaredPaths: string[]; expiresAt: Date }) => {
      world.created.push({ issueNumber: input.issueNumber, botId: input.botId });
      return { id: `lease-${input.issueNumber}`, declaredPaths: input.declaredPaths, expiresAt: input.expiresAt.toISOString() };
    }),
    setLeaseState: vi.fn(async (id: string) => {
      world.released.push(id);
      return null;
    }),
  },
  repos: { listRepos: vi.fn(async () => world.repos), getRepoByName: vi.fn(async () => REPO) },
  tasks: { countUnfinishedImplementTasks: vi.fn(async () => world.unfinished) },
  settings: { getSetting: vi.fn(async () => null), setSetting: vi.fn(async () => undefined) },
  stacks: {
    recordStack: vi.fn(async (input: { repoId: string; issue: number; onIssue: number; onPr: number; onBranch: string; onHeadSha: string | null }) => {
      if (world.stackWriteFails) throw new Error('the database went away');
      const stack = { ...input, startedAt: new Date().toISOString(), pausedAt: null };
      world.stacks.set(input.issue, stack);
      return stack;
    }),
    stackOf: vi.fn(async (_repo: string, issue: number) => {
      if (world.stackReadFails) throw new Error('the database went away');
      return world.stacks.get(issue) ?? null;
    }),
    removeStack: vi.fn(async (_repo: string, issue: number) => {
      world.stacks.delete(issue);
    }),
    listStacks: vi.fn(async () => [...world.stacks.values()]),
    markPaused: vi.fn(async (_repo: string, issue: number) => {
      const stack = world.stacks.get(issue);
      if (stack && !stack.pausedAt) stack.pausedAt = new Date().toISOString();
    }),
  },
  recordEvent: vi.fn(async () => undefined),
  listEventsOfType: vi.fn(async () => []),
}));

vi.mock('./item-hold.js', () => ({
  recordHold: vi.fn(async (subject: string, hold: { why: string | null }) => {
    world.holds.push({ subject, why: hold.why });
  }),
}));

function stacking(
  options: {
    rules?: string | null;
    sleep?: (ms: number) => Promise<void>;
    paused?: (repo?: string) => string | null;
    dispatching?: () => boolean;
  } = {},
) {
  const events: { type: string; payload: Record<string, unknown>; at: string }[] = [];
  let clock = Date.parse('2026-10-02T12:00:00Z');
  const client = {
    getPullRequest: vi.fn(async (repo: string, _number?: number) => ({ state: 'open', merged: false, headRef: A_BRANCH, headRepoFullName: repo })),
    readFileIfPresent: vi.fn(async (_repo: string, _path: string, _ref: string): Promise<string | null> => options.rules ?? null),
    comment: vi.fn(async () => null),
    addLabels: vi.fn(async () => undefined),
    removeLabel: vi.fn(async () => undefined),
    changedFilesBetween: vi.fn(async (): Promise<string[] | null> => ['src/a.ts', 'src/b.ts']),
  };
  const build = vi.fn(async () => ({ taskId: 'task-5', session: 's' }));
  const subject = new Stacking({
    client: async () => client as never,
    startBuild: build,
    paused: options.paused ?? (() => null),
    dispatching: options.dispatching ?? (() => true),
    record: async ({ type, payload }) => {
      events.push({ type, payload: payload as Record<string, unknown>, at: new Date(clock).toISOString() });
    },
    // As the database reads them: since the moment asked for.
    events: async (type, since) =>
      events.filter((event) => event.type === type && Date.parse(event.at) >= since.getTime()).map(({ at, payload }) => ({ at, payload })),
    now: () => (clock += 1000),
    sleep: options.sleep ?? (async () => undefined),
  });
  return { subject, client, build, events, later: (ms: number) => (clock += ms) };
}

const dependsOn4 = [
  '### Outcome\n\nIt works.',
  '### Acceptance criteria\n\n- It works.',
  '### Expected paths\n\n- src/b.ts',
  '### Verification\n\nRun it.',
  '### Dependencies\n\n- #4\n',
].join('\n\n');
/** Everything the dispatcher asks of an issue before it leases it. */
const READY = ['blocked', 'priority:p2', 'area:bridge', 'do:ai'];

describe('an issue that depends on one in review', () => {
  beforeEach(() => {
    world.issues = new Map([
      [4, { number: 4, stage: 'review', labels: [], prNumber: 30, body: '', declaredPaths: ['src/a.ts'] }],
      [5, { number: 5, stage: 'build', labels: READY, prNumber: null, body: dependsOn4, declaredPaths: ['src/b.ts'] }],
    ]);
    world.leases = new Map();
    world.created = [];
    world.released = [];
    world.labels = [];
    world.holds = [];
    world.stacks = new Map();
    world.stackWriteFails = false;
    world.stackReadFails = false;
    world.repos = [REPO];
    world.attempts = 0;
    world.inFlight = [{ number: 4, paths: ['src/a.ts', 'src/b.ts'], building: false }];
    world.unfinished = 0;
  });

  it('starts from that one’s branch rather than waiting for it to merge', async () => {
    const { subject, build, events } = stacking();

    expect(await subject.sweep()).toEqual([`shop#5: stacked on #4, from ${A_BRANCH}`]);

    expect(world.created).toEqual([{ issueNumber: 5, botId: 'bot-1' }]);
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ issue: 5, bot: { id: 'bot-1', name: 'atlas' }, stackOn: { issue: 4, pr: 30, branch: A_BRANCH } }));
    expect(events).toEqual([expect.objectContaining({ type: STACK_STARTED, payload: expect.objectContaining({ repo: 'shop', issue: 5, on: 4, onPr: 30, branch: A_BRANCH }) })]);
    // Recorded on its own row, which is what the merge line reads.
    expect(world.stacks.get(5)).toMatchObject({ repoId: 'repo-1', issue: 5, onIssue: 4, onPr: 30, onBranch: A_BRANCH });
  });

  it('leases for as long as FLEETADLC_LEASE_HOURS says, as every other lease does', async () => {
    // It was twelve hours whatever the install set.
    vi.stubEnv('FLEETADLC_LEASE_HOURS', '3');
    try {
      const { subject } = stacking();
      await subject.sweep();
      const expiresAt = vi.mocked(leases.createLease).mock.calls.at(-1)?.[0].expiresAt as Date;
      const hours = (expiresAt.getTime() - Date.parse('2026-10-02T12:00:00Z')) / 3600_000;
      expect(hours).toBeGreaterThanOrEqual(3);
      expect(hours).toBeLessThan(3.1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('waits as before when the repository turned stacking off', async () => {
    const { subject, build } = stacking({ rules: 'version: 1\nstacking: false\n' });

    expect(await subject.sweep()).toEqual([]);
    expect(build).not.toHaveBeenCalled();
  });

  it('stacking skips a repository whose rules could not be read', async () => {
    // Taken for no file, a 502 turned stacking on for a repository that had
    // it off. The other repositories are still swept.
    const cart = { id: 'repo-2', name: 'cart', fullName: 'janedoe/cart', defaultBranch: 'main', concurrency: 1 };
    world.repos = [REPO, cart];
    const { subject, client, build } = stacking();
    client.readFileIfPresent.mockImplementation(async (fullName: string) => {
      if (fullName === REPO.fullName) throw new Error('GitHub answered 502: Bad Gateway');
      return null;
    });

    expect(await subject.sweep()).toEqual([
      'shop: no stacked work started, since .github/fleetadlc.yml could not be read: GitHub answered 502: Bad Gateway',
      `cart#5: stacked on #4, from ${A_BRANCH}`,
    ]);
    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ repo: cart }));
  });

  it('waits as before while the one it depends on is still being built', async () => {
    world.issues.set(4, { ...world.issues.get(4)!, stage: 'build', prNumber: null });
    const { subject, build } = stacking();

    await subject.sweep();
    expect(build).not.toHaveBeenCalled();
  });

  it('keeps out of the merge line until that one has merged', async () => {
    const { subject } = stacking();
    await subject.sweep();

    expect(await subject.waitingOn('shop', 5)).toBe(4);
    world.issues.set(4, { ...world.issues.get(4)!, stage: 'merged' });
    expect(await subject.waitingOn('shop', 5)).toBeNull();
  });

  /** #5's pull request, #31, with #4 merged and the line about to bring it up to date. */
  async function readyToUpdate(options: { sleep?: (ms: number) => Promise<void> } = {}) {
    const stacked = stacking(options);
    await stacked.subject.sweep();
    world.issues.set(4, { ...world.issues.get(4)!, stage: 'merged' });
    expect(await stacked.subject.updating({ repoName: 'shop', repoFullName: 'janedoe/shop', prNumber: 31, issue: 5, baseRef: 'main', headSha: before })).toBe(true);
    return stacked;
  }
  const before = 'b'.repeat(40);
  const after = 'a'.repeat(40);

  it('notes no update, so keeps no approvals, when the comparison lists only part of what it took out', async () => {
    const { subject, client, events } = stacking();
    await subject.sweep();
    world.issues.set(4, { ...world.issues.get(4)!, stage: 'merged' });
    client.changedFilesBetween.mockResolvedValueOnce(null);

    expect(await subject.updating({ repoName: 'shop', repoFullName: 'janedoe/shop', prNumber: 31, issue: 5, baseRef: 'main', headSha: before })).toBe(false);
    expect(events.some((event) => event.type === STACK_UPDATING)).toBe(false);
  });

  it('keeps its approvals for the merge commit the line made once that one merged', async () => {
    const { subject, events } = await readyToUpdate();
    await subject.made({ repoName: 'shop', prNumber: 31, from: before, to: after });

    // The update took out #4's file, which landed; it added none.
    expect(await subject.pushed({ repoName: 'shop', prNumber: 31, before, after, prFiles: ['src/b.ts'] })).toBe(true);

    expect(events.at(-1)).toMatchObject({ type: STACK_UPDATED, payload: { repo: 'shop', pr: 31, issue: 5, on: 4, from: before, to: after } });
    expect(await subject.carriedTo('shop', 31, after)).toEqual(new Set([before]));
    // Any other push is reviewed as usual.
    expect(await subject.pushed({ repoName: 'shop', prNumber: 31, before: after, after: 'c'.repeat(40), prFiles: ['src/b.ts'] })).toBe(false);
  });

  it('keeps none for a push from the noted head once the update conflicted, then or hours later', async () => {
    const { subject, events, later } = await readyToUpdate();
    await subject.made({ repoName: 'shop', prNumber: 31, from: before, to: null });

    // The builder's resolution, from the head the line noted and touching only files it changed.
    expect(await subject.pushed({ repoName: 'shop', prNumber: 31, before, after, prFiles: ['src/b.ts'] })).toBe(false);
    later(6 * 60 * 60 * 1000);
    expect(await subject.pushed({ repoName: 'shop', prNumber: 31, before, after: 'c'.repeat(40), prFiles: ['src/b.ts'] })).toBe(false);

    expect(await subject.carriedTo('shop', 31, after)).toEqual(new Set());
    expect(events.some((event) => event.type === STACK_UPDATED)).toBe(false);
  });

  it('keeps none for a push from the noted head to any commit but the one the line made', async () => {
    const { subject } = await readyToUpdate();
    await subject.made({ repoName: 'shop', prNumber: 31, from: before, to: after });

    expect(await subject.pushed({ repoName: 'shop', prNumber: 31, before, after: 'c'.repeat(40), prFiles: ['src/b.ts'] })).toBe(false);
  });

  it('keeps them once: a second push from the same head is reviewed as usual', async () => {
    const { subject, events } = await readyToUpdate();
    await subject.made({ repoName: 'shop', prNumber: 31, from: before, to: after });

    expect(await subject.pushed({ repoName: 'shop', prNumber: 31, before, after, prFiles: ['src/b.ts'] })).toBe(true);
    expect(await subject.pushed({ repoName: 'shop', prNumber: 31, before, after, prFiles: ['src/b.ts'] })).toBe(false);

    expect(events.filter((event) => event.type === STACK_UPDATED)).toHaveLength(1);
  });

  it('never matches a note an earlier version wrote, which says nothing of what was made', async () => {
    const { subject, events, later } = stacking();
    events.push({ type: STACK_UPDATING, payload: { repo: 'shop', pr: 31, issue: 5, on: 4, from: before, files: ['src/a.ts', 'src/b.ts'] }, at: new Date(later(0)).toISOString() });
    later(60 * 60 * 1000);

    expect(await subject.pushed({ repoName: 'shop', prNumber: 31, before, after, prFiles: ['src/b.ts'] })).toBe(false);
  });

  it('waits for the line to record what it made when the push arrives first', async () => {
    let made: Promise<void> | null = null;
    const sleep = vi.fn(async () => {
      made ??= stacked.subject.made({ repoName: 'shop', prNumber: 31, from: before, to: after });
      await made;
    });
    const stacked = await readyToUpdate({ sleep });

    expect(await stacked.subject.pushed({ repoName: 'shop', prNumber: 31, before, after, prFiles: ['src/b.ts'] })).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('waits a bounded time, then keeps none, when the line never records it', async () => {
    const sleep = vi.fn(async () => undefined);
    const { subject, events } = await readyToUpdate({ sleep });

    expect(await subject.pushed({ repoName: 'shop', prNumber: 31, before, after, prFiles: ['src/b.ts'] })).toBe(false);
    expect(sleep).toHaveBeenCalledTimes(10);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(events.some((event) => event.type === STACK_MADE || event.type === STACK_UPDATED)).toBe(false);
  });

  it('is held, with a note, when that one is sent back to build', async () => {
    const { subject, client, events } = stacking();
    await subject.sweep();
    world.leases.set(5, { id: 'lease-5' });
    world.issues.set(4, { ...world.issues.get(4)!, stage: 'build' });

    expect(await subject.sweep()).toEqual(['shop#5: held, #4 was sent back']);

    expect(client.addLabels).toHaveBeenCalledWith('janedoe/shop', 5, ['fleetadlc:paused']);
    expect(world.holds).toEqual([{ subject: 'shop#5', why: expect.stringContaining('#4, which this was built on, was sent back') }]);
    expect(client.comment).toHaveBeenCalledWith('janedoe/shop', 5, expect.stringContaining('**Held.**'));
    expect(events.at(-1)).toMatchObject({ type: STACK_PAUSED, payload: { repo: 'shop', issue: 5, on: 4 } });
    // Once: a person who resumes it has decided.
    expect(await subject.sweep()).toEqual([]);
  });

  it('says on GitHub where it is resumed, and how it is started over from the base', async () => {
    const { subject, client } = stacking();
    await subject.sweep();
    world.leases.set(5, { id: 'lease-5' });
    world.issues.set(4, { ...world.issues.get(4)!, stage: 'build' });
    await subject.sweep();

    for (const said of [
      'Resume it from its card in OpenADLC once #4 is settled',
      'take the `fleetadlc:paused` label off this issue and its pull request',
      'cancel it from its card and file the work again as a new issue',
    ]) {
      expect(client.comment).toHaveBeenCalledWith('janedoe/shop', 5, expect.stringContaining(said));
    }
  });

  it('is held when that one goes back further than build, or is gone', async () => {
    const { subject, client } = stacking();
    await subject.sweep();
    world.issues.set(4, { ...world.issues.get(4)!, stage: 'spec' });

    expect(await subject.sweep()).toEqual(['shop#5: held, #4 was sent back']);
    expect(world.holds).toEqual([{ subject: 'shop#5', why: expect.stringContaining('#4, which this was built on, was sent back to spec') }]);
    expect(client.comment).toHaveBeenCalledWith('janedoe/shop', 5, expect.stringContaining('#4 has been sent back to spec.'));

    const again = stacking();
    world.issues.set(4, { ...world.issues.get(4)!, stage: 'review' });
    world.leases = new Map();
    await again.subject.sweep();
    world.leases.set(5, { id: 'lease-5' });
    world.issues.delete(4);
    again.client.getPullRequest.mockResolvedValue({ state: 'closed', merged: false, headRef: A_BRANCH, headRepoFullName: 'janedoe/shop' });
    expect(await again.subject.sweep()).toEqual(['shop#5: held, #4 was closed without merging']);
  });

  it('is held, with a note, when that one is closed without merging', async () => {
    const { subject, client } = stacking();
    await subject.sweep();
    world.leases.set(5, { id: 'lease-5' });
    // The reconciler forgets an issue closed with its change unmerged.
    world.issues.delete(4);
    client.getPullRequest.mockResolvedValue({ state: 'closed', merged: false, headRef: A_BRANCH, headRepoFullName: 'janedoe/shop' });

    expect(await subject.sweep()).toEqual(['shop#5: held, #4 was closed without merging']);

    expect(client.addLabels).toHaveBeenCalledWith('janedoe/shop', 5, ['fleetadlc:paused']);
    expect(world.holds).toEqual([{ subject: 'shop#5', why: '#4, which this was built on, was closed without merging' }]);
    expect(client.comment).toHaveBeenCalledWith('janedoe/shop', 5, expect.stringContaining('#4 was closed without merging'));
    expect(world.stacks.get(5)?.pausedAt).not.toBeNull();
    expect(await subject.sweep()).toEqual([]);
  });

  it('is not held when that one merged and left the board, nor when GitHub cannot say', async () => {
    const { subject, client } = stacking();
    await subject.sweep();
    world.leases.set(5, { id: 'lease-5' });
    world.issues.delete(4);

    client.getPullRequest.mockResolvedValue({ state: 'closed', merged: true, headRef: A_BRANCH, headRepoFullName: 'janedoe/shop' });
    expect(await subject.sweep()).toEqual([]);
    client.getPullRequest.mockRejectedValue(new Error('GitHub answered 502'));
    expect(await subject.sweep()).toEqual([]);
    expect(client.comment).not.toHaveBeenCalled();
  });

  it('keeps out of the merge line however long that one stays in review', async () => {
    // The stack was an event read from the last fourteen days: on day fifteen
    // the pull request joined the line with #4's commits in it.
    const { subject, later } = stacking();
    await subject.sweep();

    later(30 * 24 * 60 * 60 * 1000);
    expect(await subject.waitingOn('shop', 5)).toBe(4);
  });

  it('is held when that one is sent back a month after it was stacked', async () => {
    const { subject, later } = stacking();
    await subject.sweep();
    world.leases.set(5, { id: 'lease-5' });
    later(30 * 24 * 60 * 60 * 1000);
    world.issues.set(4, { ...world.issues.get(4)!, stage: 'build' });

    expect(await subject.sweep()).toEqual(['shop#5: held, #4 was sent back']);
  });

  it('says it cannot tell, rather than nothing to wait on, when the stack cannot be read', async () => {
    const { subject } = stacking();
    await subject.sweep();
    world.stackReadFails = true;

    await expect(subject.waitingOn('shop', 5)).rejects.toThrow('the database went away');
  });

  it('starts no build when the stack cannot be recorded, and forgets one whose build did not start', async () => {
    world.stackWriteFails = true;
    const first = stacking();
    expect(await first.subject.sweep()).toEqual([]);
    expect(first.build).not.toHaveBeenCalled();
    expect(world.released).toEqual(['lease-5']);

    world.stackWriteFails = false;
    const second = stacking();
    second.build.mockResolvedValueOnce({ taskId: '', session: null, error: 'hostd is not answering' } as never);
    expect(await second.subject.sweep()).toEqual([]);
    expect(world.stacks.has(5)).toBe(false);
    expect(world.released).toEqual(['lease-5', 'lease-5']);
  });
});

describe('a stacked build the dispatcher would not start', () => {
  beforeEach(() => {
    world.issues = new Map([
      [4, { number: 4, stage: 'review', labels: [], prNumber: 30, body: '', declaredPaths: ['src/a.ts'] }],
      [5, { number: 5, stage: 'build', labels: READY, prNumber: null, body: dependsOn4, declaredPaths: ['src/b.ts'] }],
    ]);
    world.leases = new Map();
    world.created = [];
    world.released = [];
    world.labels = [];
    world.holds = [];
    world.repos = [REPO];
    world.attempts = 0;
    world.inFlight = [{ number: 4, paths: ['src/a.ts', 'src/b.ts'], building: false }];
    world.unfinished = 0;
  });

  it('starts nothing while work is paused install-wide', async () => {
    const { subject, build } = stacking({ paused: () => 'paused from Settings' });

    expect(await subject.sweep()).toEqual([]);
    expect(world.created).toEqual([]);
    expect(build).not.toHaveBeenCalled();
  });

  it('starts nothing in a paused repository, and stacks in another', async () => {
    world.repos = [REPO, OTHER];
    const { subject, build } = stacking({ paused: (repo) => (repo === 'shop' ? 'shop is paused' : null) });

    expect(await subject.sweep()).toEqual([`mill#5: stacked on #4, from ${A_BRANCH}`]);
    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ repo: OTHER }));
  });

  it('still holds what was sent back in a paused repository', async () => {
    const paused = { now: null as string | null };
    const { subject, client } = stacking({ paused: (repo) => (repo === 'shop' ? paused.now : null) });
    await subject.sweep();
    paused.now = 'shop is paused';
    world.leases.set(5, { id: 'lease-5' });
    world.issues.set(4, { ...world.issues.get(4)!, stage: 'build' });

    expect(await subject.sweep()).toEqual(['shop#5: held, #4 was sent back']);
    expect(client.addLabels).toHaveBeenCalledWith('janedoe/shop', 5, ['fleetadlc:paused']);
  });

  it('starts nothing where nothing dispatches', async () => {
    const { subject, build } = stacking({ dispatching: () => false });

    expect(await subject.sweep()).toEqual([]);
    expect(build).not.toHaveBeenCalled();
  });

  it('leaves alone an issue still in spec', async () => {
    world.issues.set(5, { ...world.issues.get(5)!, stage: 'spec' });
    const { subject, build } = stacking();

    expect(await subject.sweep()).toEqual([]);
    expect(build).not.toHaveBeenCalled();
  });

  it.each(['do:human', 'needs-human', 'needs-triage'])('leaves alone an issue labelled %s', async (label) => {
    const labels = label === 'do:human' ? READY.filter((one) => one !== 'do:ai').concat(label) : [...READY, label];
    world.issues.set(5, { ...world.issues.get(5)!, labels });
    const { subject, build } = stacking();

    expect(await subject.sweep()).toEqual([]);
    expect(world.created).toEqual([]);
    expect(build).not.toHaveBeenCalled();
  });

  it('leaves alone an issue not ready to route', async () => {
    world.issues.set(5, { ...world.issues.get(5)!, labels: ['blocked', 'do:ai'] });
    const { subject, build } = stacking();

    expect(await subject.sweep()).toEqual([]);
    expect(build).not.toHaveBeenCalled();
  });

  it('leaves alone an issue that has failed too many times', async () => {
    world.attempts = 3;
    const { subject, build } = stacking();

    expect(await subject.sweep()).toEqual([]);
    expect(build).not.toHaveBeenCalled();
  });

  it('leaves alone an issue whose files another change is building, but not for the one it stacks on', async () => {
    world.inFlight = [
      { number: 4, paths: ['src/a.ts', 'src/b.ts'], building: false },
      { number: 7, paths: ['src/b.ts'], building: true },
    ];
    const { subject, build } = stacking();

    expect(await subject.sweep()).toEqual([]);
    expect(build).not.toHaveBeenCalled();

    world.inFlight = [{ number: 4, paths: ['src/b.ts'], building: true }];
    expect(await stacking().subject.sweep()).toEqual([`shop#5: stacked on #4, from ${A_BRANCH}`]);
  });

  it('leaves alone an issue when the repository is already building as many as it allows', async () => {
    world.unfinished = 2;
    const { subject, build } = stacking();

    expect(await subject.sweep()).toEqual([]);
    expect(build).not.toHaveBeenCalled();
  });
});

describe('a stacked build', () => {
  it('starts its branch from the branch it depends on, and is told so', async () => {
    const open = vi.fn(async () => ({ taskId: 'task-5', session: 's' }));
    const automation = { assignIssue: vi.fn(async () => undefined), comment: vi.fn(async () => undefined) };

    await startBuild({ taskService: { open } as never, automation: automation as never }, {
      leaseId: 'lease-5',
      repo: { name: 'shop', fullName: 'janedoe/shop' },
      issue: 5,
      bot: { id: 'bot-1', name: 'atlas' },
      declaredPaths: ['src/b.ts'],
      expiresAt: null,
      stackOn: { issue: 4, pr: 30, branch: A_BRANCH },
    });

    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: 'agent/atlas/5-issue-5',
        baseRef: `refs/heads/${A_BRANCH}`,
        extraContext: [expect.objectContaining({ name: 'stacked-on.md' })],
      }),
    );
    expect(automation.comment).toHaveBeenCalledWith('janedoe/shop', 5, expect.stringContaining(`started from #4's branch \`${A_BRANCH}\``));
  });
});
