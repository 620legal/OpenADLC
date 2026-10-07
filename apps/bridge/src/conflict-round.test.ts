import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFLICT_RESOLVED, CONFLICT_RESOLVING, CONFLICT_SENT_BACK, ConflictRounds, leadOnlyResolutionTo, resolutionRetry } from './conflict-round.js';
import { BotBusyError, HostFullError } from './task-service.js';

const REPO = { id: 'repo-1', name: 'shop', fullName: 'janedoe/shop', defaultBranch: 'main' };
const BEFORE = 'b'.repeat(40);
const AFTER = 'a'.repeat(40);

const world = vi.hoisted(() => ({
  lease: { id: 'lease-7', botId: 'bot-1' } as { id: string; botId: string } | null,
}));

vi.mock('@fleetadlc/db', () => ({
  bots: { getBotById: vi.fn(async (id: string) => ({ id, name: 'atlas' })) },
  leases: { getActiveLease: vi.fn(async () => world.lease) },
  repos: { getRepoByName: vi.fn(async () => REPO) },
  recordEvent: vi.fn(async () => undefined),
  listEventsOfTypeWith: vi.fn(async () => []),
}));

function rounds(
  options: {
    prFiles?: string[];
    onBase?: string[] | null;
    rules?: string | null | Error;
    /** What the resolution push changed, and each file's content by ref. */
    pushed?: string[];
    resolutionChanged?: () => Promise<string[]>;
    contents?: Record<string, Record<string, string | null>>;
  } = {},
) {
  const events: { type: string; payload: Record<string, unknown>; at: string }[] = [];
  let clock = Date.parse('2026-10-02T12:00:00Z');
  const client = {
    getPullRequest: vi.fn(async () => ({ headRef: 'agent/atlas/7-issue-7', headSha: BEFORE })),
    listPullFilesAsNamed: vi.fn(async () => options.prFiles ?? ['README.md', 'src/cart.ts']),
    filesChangedOnBaseSince: vi.fn(async () => (options.onBase === undefined ? ['README.md', 'src/other.ts'] : options.onBase)),
    readFileIfPresent: vi.fn(async (_repo: string, path: string, ref: string) => {
      if (path === '.github/fleetadlc.yml') {
        if (options.rules instanceof Error) throw options.rules;
        return options.rules ?? null;
      }
      return options.contents?.[path]?.[ref] ?? null;
    }),
    changedFilesBetween: vi.fn(options.resolutionChanged ?? (async () => options.pushed ?? ['README.md'])),
    comment: vi.fn(async () => null),
  };
  const open = vi.fn(async () => ({ taskId: 'task-1', session: 's' }));
  const backToBuild = vi.fn(async () => undefined);
  const subject = new ConflictRounds({
    taskService: { open } as never,
    client: async () => client as never,
    backToBuild,
    record: async ({ type, payload }) => {
      events.push({ type, payload: payload as Record<string, unknown>, at: new Date(clock).toISOString() });
    },
    // As the database answers: a window when asked for one, the subject's fields otherwise.
    events: async (type, about: { repo: string; pr: number } | Date) =>
      events
        .filter((event) => event.type === type)
        .filter((event) =>
          about instanceof Date ? Date.parse(event.at) >= about.getTime() : event.payload.repo === about.repo && event.payload.pr === about.pr,
        )
        .map(({ at, payload }) => ({ at, payload })),
    now: () => (clock += 1000),
  });
  const wait = (ms: number) => {
    clock += ms;
  };
  return { subject, client, open, backToBuild, events, wait };
}

describe('a branch that conflicts at the front of the merge line', () => {
  beforeEach(() => {
    world.lease = { id: 'lease-7', botId: 'bot-1' };
  });

  it('gets a resolution round on just the conflicted files, not a send-back', async () => {
    const { subject, open, backToBuild, events } = rounds();

    expect(await subject.start({ repoName: 'shop', prNumber: 31, baseRef: 'main' })).toBe('resolving');

    expect(backToBuild).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        bot: 'atlas',
        kind: 'patch',
        skill: 'resolve-conflict',
        subjectRef: 'shop#31',
        branch: 'agent/atlas/7-issue-7',
        checkoutExistingBranch: true,
        leaseId: 'lease-7',
        declaredPaths: ['README.md'],
      }),
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: CONFLICT_RESOLVING,
        payload: expect.objectContaining({ repo: 'shop', pr: 31, issue: 7, files: ['README.md'], at: expect.any(String) }),
      }),
    ]);
  });

  it('tells the builder to commit the merge before it runs the checks', async () => {
    // Local CI runs only on a committed HEAD, and an unfinished merge has every
    // file the base brought in staged: "run fleetadlc-ci and push" was refused.
    const { subject, open } = rounds();
    await subject.start({ repoName: 'shop', prNumber: 31, baseRef: 'main' });
    const brief = (open.mock.calls[0] as unknown as [{ extraContext: { name: string; content: string }[] }])[0].extraContext.find(
      (doc) => doc.name === 'resolve-conflict.md',
    );
    expect(brief?.content).toMatch(/Commit the merge, then run `fleetadlc-ci` on it and push\./);
  });

  it('is re-checked by the lead alone when every conflicted file is shared, and the approvals carry to the new head', async () => {
    const { subject, events } = rounds();
    await subject.start({ repoName: 'shop', prNumber: 31, baseRef: 'main' });

    const review = await subject.pushed({ repoName: 'shop', repoFullName: 'janedoe/shop', prNumber: 31, before: BEFORE, after: AFTER, baseRef: 'main', prFiles: ['README.md', 'src/cart.ts'] });

    expect(review).toEqual({ review: 'lead-only', files: ['README.md'], at: expect.any(String) });
    expect(events.map((event) => event.type)).toEqual([CONFLICT_RESOLVING, CONFLICT_RESOLVED]);
    expect(events[1]?.payload).toMatchObject({ repo: 'shop', pr: 31, issue: 7, files: ['README.md'], review: 'lead-only' });
    expect(await subject.carriedTo('shop', 31, AFTER)).toEqual(new Set([BEFORE]));
    // From when it was pushed, the lead re-checks the new head.
    expect(await subject.resolvedAt('shop', 31, AFTER)).toBe(review?.at);
    expect(await subject.resolvedAt('shop', 31, BEFORE)).toBeNull();
  });

  it('is reviewed in full when the resolution rewrote a file the pull request already changed, its names unchanged', async () => {
    // README.md conflicted; the builder also rewrote src/cart.ts, which the
    // reviewers approved as it was.
    const { subject, client, events } = rounds({ resolutionChanged: async () => ['README.md', 'src/other.ts', 'src/cart.ts'], contents: { 'src/other.ts': { [AFTER]: 'x', main: 'x' } } });
    await subject.start({ repoName: 'shop', prNumber: 31, baseRef: 'main' });

    const review = await subject.pushed({ repoName: 'shop', repoFullName: 'janedoe/shop', prNumber: 31, before: BEFORE, after: AFTER, baseRef: 'main', prFiles: ['README.md', 'src/cart.ts'] });

    expect(client.changedFilesBetween).toHaveBeenCalledWith('janedoe/shop', BEFORE, AFTER);
    expect(review?.review).toBe('full');
    expect(events.at(-1)).toMatchObject({ type: CONFLICT_SENT_BACK, payload: { why: 'the resolution changed files beyond the conflict' } });
    expect(await subject.carriedTo('shop', 31, AFTER)).toEqual(new Set());
    expect(await subject.resolvedAt('shop', 31, AFTER)).toBeNull();
  });

  it('is reviewed in full when what the resolution changed cannot be read', async () => {
    const { subject } = rounds({ resolutionChanged: async () => Promise.reject(new Error('compare → 502')) });
    await subject.start({ repoName: 'shop', prNumber: 31, baseRef: 'main' });

    const review = await subject.pushed({ repoName: 'shop', repoFullName: 'janedoe/shop', prNumber: 31, before: BEFORE, after: AFTER, baseRef: 'main', prFiles: ['README.md', 'src/cart.ts'] });

    expect(review?.review).toBe('full');
  });

  it('names the lead-only resolution pushed as a head, and when, for the sweep to re-check it again', async () => {
    const { subject, events } = rounds();
    await subject.start({ repoName: 'shop', prNumber: 31, baseRef: 'main' });
    const review = await subject.pushed({ repoName: 'shop', repoFullName: 'janedoe/shop', prNumber: 31, before: BEFORE, after: AFTER, baseRef: 'main', prFiles: ['README.md', 'src/cart.ts'] });
    const read = async (type: string, fields: Record<string, string | number>) =>
      events
        .filter((event) => event.type === type && Object.entries(fields).every(([key, value]) => event.payload[key] === value))
        .map(({ at, payload }) => ({ at, payload }));

    expect(await leadOnlyResolutionTo('shop', 31, AFTER, read)).toEqual({ from: BEFORE, to: AFTER, files: ['README.md'], at: review?.at });
    expect(await leadOnlyResolutionTo('shop', 31, BEFORE, read)).toBeNull();
  });

  it('keeps a resolution and its carried approvals for as long as the pull request takes to land', async () => {
    const { subject, wait } = rounds();
    await subject.start({ repoName: 'shop', prNumber: 31, baseRef: 'main' });
    wait(5 * 24 * 60 * 60 * 1000);

    const review = await subject.pushed({ repoName: 'shop', repoFullName: 'janedoe/shop', prNumber: 31, before: BEFORE, after: AFTER, baseRef: 'main', prFiles: ['README.md', 'src/cart.ts'] });
    expect(review).toEqual({ review: 'lead-only', files: ['README.md'], at: expect.any(String) });

    wait(10 * 24 * 60 * 60 * 1000);
    expect(await subject.carriedTo('shop', 31, AFTER)).toEqual(new Set([BEFORE]));
    expect(await subject.carriedTo('shop', 32, AFTER)).toEqual(new Set());
  });

  it('falls back to the whole round when the base changed more files than the comparison lists', async () => {
    const { subject, open, backToBuild, events } = rounds({ onBase: null });

    expect(await subject.start({ repoName: 'shop', prNumber: 31, baseRef: 'main' })).toBe('sent_back');

    expect(open).not.toHaveBeenCalled();
    expect(backToBuild).toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual([CONFLICT_SENT_BACK]);
    expect(events[0]!.payload).toMatchObject({ why: 'the base changed too many files to tell which conflict' });
  });

  it('is reviewed in full again when a conflicted file is not a shared one', async () => {
    const { subject, events } = rounds({ prFiles: ['src/cart.ts'], onBase: ['src/cart.ts'] });
    await subject.start({ repoName: 'shop', prNumber: 31, baseRef: 'main' });

    const review = await subject.pushed({ repoName: 'shop', repoFullName: 'janedoe/shop', prNumber: 31, before: BEFORE, after: AFTER, baseRef: 'main', prFiles: ['src/cart.ts'] });

    expect(review?.review).toBe('full');
    expect(events.map((event) => event.type)).toEqual([CONFLICT_RESOLVING, CONFLICT_RESOLVED, CONFLICT_SENT_BACK]);
    expect(events[1]?.payload).toMatchObject({ review: 'full' });
    expect(await subject.carriedTo('shop', 31, AFTER)).toEqual(new Set());
  });

  it('is reviewed in full when the resolution changed files beyond the conflict', async () => {
    const { subject, events } = rounds();
    await subject.start({ repoName: 'shop', prNumber: 31, baseRef: 'main' });

    const review = await subject.pushed({ repoName: 'shop', repoFullName: 'janedoe/shop', prNumber: 31, before: BEFORE, after: AFTER, baseRef: 'main', prFiles: ['README.md', 'src/cart.ts', 'src/new.ts'] });

    expect(review?.review).toBe('full');
    expect(events.at(-1)).toMatchObject({ type: CONFLICT_SENT_BACK, payload: { why: 'the resolution changed files beyond the conflict' } });
  });

  it('reads the shared paths from the repository’s rules', async () => {
    const { subject, events } = rounds({ prFiles: ['src/cart.ts'], onBase: ['src/cart.ts'], rules: 'version: 1\npaths:\n  shared: ["src/*.ts"]\n' });
    await subject.start({ repoName: 'shop', prNumber: 31, baseRef: 'main' });

    expect(events[0]?.payload).toMatchObject({ review: 'lead-only' });
  });

  it('is an ordinary push when no resolution is waiting on it', async () => {
    const { subject, events } = rounds();

    expect(await subject.pushed({ repoName: 'shop', repoFullName: 'janedoe/shop', prNumber: 31, before: BEFORE, after: AFTER, baseRef: 'main', prFiles: ['README.md'] })).toBeNull();
    expect(events).toEqual([]);
  });

  it('falls back to the whole round, and says so, when no builder holds the issue', async () => {
    world.lease = null;
    const { subject, open, backToBuild, events } = rounds();

    expect(await subject.start({ repoName: 'shop', prNumber: 31, baseRef: 'main' })).toBe('sent_back');

    expect(open).not.toHaveBeenCalled();
    expect(backToBuild).toHaveBeenCalledWith(expect.objectContaining({ repoName: 'shop', prNumber: 31 }));
    expect(events).toEqual([expect.objectContaining({ type: CONFLICT_SENT_BACK, payload: expect.objectContaining({ repo: 'shop', pr: 31, issue: 7 }) })]);
  });

  const PUSH = { repoName: 'shop', repoFullName: 'janedoe/shop', prNumber: 31, before: BEFORE, after: AFTER, baseRef: 'main' };

  it.each([
    ['Makefile'],
    ['makefile'],
    ['GNUmakefile'],
    ['package.json'],
    ['packages/web/package.json'],
    ['tsconfig.build.json'],
    ['.github/workflows/ci.yml'],
    ['AGENTS.md'],
  ])('is reviewed in full when %s conflicted, though the rules call it shared', async (file) => {
    const { subject, events } = rounds({ prFiles: [file], onBase: [file], rules: `version: 1\npaths:\n  shared: ["${file}", "**/*"]\n` });
    await subject.start({ repoName: 'shop', prNumber: 31, baseRef: 'main' });

    expect(events[0]?.payload).toMatchObject({ review: 'full' });
  });

  it('is reviewed in full when the rules cannot be read, and when they do not parse; a missing file gets the defaults', async () => {
    const unreadable = rounds({ rules: new Error('GitHub answered 502') });
    await unreadable.subject.start({ repoName: 'shop', prNumber: 31, baseRef: 'main' });
    expect(unreadable.events[0]?.payload).toMatchObject({ review: 'full' });

    const broken = rounds({ rules: 'paths: [unclosed\n' });
    await broken.subject.start({ repoName: 'shop', prNumber: 31, baseRef: 'main' });
    expect(broken.events[0]?.payload).toMatchObject({ review: 'full' });

    const missing = rounds({ rules: null });
    await missing.subject.start({ repoName: 'shop', prNumber: 31, baseRef: 'main' });
    expect(missing.events[0]?.payload).toMatchObject({ review: 'lead-only' });
  });

  it('is reviewed in full when the push rewrote a file the pull request already changed, beyond the conflict', async () => {
    // src/cart.ts is the pull request's own; the base did not touch it.
    const { subject, events } = rounds({ pushed: ['README.md', 'src/cart.ts'] });
    await subject.start({ repoName: 'shop', prNumber: 31, baseRef: 'main' });

    const review = await subject.pushed({ ...PUSH, prFiles: ['README.md', 'src/cart.ts'] });

    expect(review?.review).toBe('full');
    expect(events.at(-1)).toMatchObject({ type: CONFLICT_SENT_BACK, payload: { why: 'the resolution changed files beyond the conflict' } });
  });

  it('is reviewed in full when a file the base brought is not as the base has it', async () => {
    const { subject } = rounds({ pushed: ['README.md', 'src/other.ts'], contents: { 'src/other.ts': { [AFTER]: 'tampered', main: 'from the base' } } });
    await subject.start({ repoName: 'shop', prNumber: 31, baseRef: 'main' });

    expect((await subject.pushed({ ...PUSH, prFiles: ['README.md', 'src/cart.ts'] }))?.review).toBe('full');
  });

  it('stays lead-only when the push brought what the base changed, unchanged', async () => {
    const { subject } = rounds({ pushed: ['README.md', 'src/other.ts'], contents: { 'src/other.ts': { [AFTER]: 'from the base', main: 'from the base' } } });
    await subject.start({ repoName: 'shop', prNumber: 31, baseRef: 'main' });

    expect((await subject.pushed({ ...PUSH, prFiles: ['README.md', 'src/cart.ts'] }))?.review).toBe('lead-only');
  });

  it('is reviewed in full when what the push changed cannot be told', async () => {
    const { subject, client } = rounds();
    await subject.start({ repoName: 'shop', prNumber: 31, baseRef: 'main' });
    client.changedFilesBetween.mockRejectedValueOnce(new Error('GitHub answered 502'));

    expect((await subject.pushed({ ...PUSH, prFiles: ['README.md', 'src/cart.ts'] }))?.review).toBe('full');
  });

  it('says when the resolution that made a head was pushed, for the lead review that is due from then', async () => {
    const { subject } = rounds();
    await subject.start({ repoName: 'shop', prNumber: 31, baseRef: 'main' });
    const pushed = await subject.pushed({ ...PUSH, prFiles: ['README.md', 'src/cart.ts'] });

    expect(await subject.resolvedAt('shop', 31, AFTER)).toBe(pushed?.at);
    expect(await subject.resolvedAt('shop', 31, BEFORE)).toBeNull();
  });
});

describe('a resolution round that cannot start yet', () => {
  beforeEach(() => {
    world.lease = { id: 'lease-7', botId: 'bot-1' };
  });

  it('waits, and says nothing, when the start was recorded as a failed task', async () => {
    // A health check or a cap holding the builder: `open` answers with the
    // failed task's error. It was taken for a started round, which said
    // "resolving" while nothing ran.
    const { subject, open, client, backToBuild, events } = rounds();
    open.mockResolvedValueOnce({ taskId: 'task-1', session: null, error: 'atlas cannot work yet: its GitHub sign-in failed' } as never);

    expect(await subject.start({ repoName: 'shop', prNumber: 31, baseRef: 'main' })).toBe('pending');

    expect(client.comment).not.toHaveBeenCalled();
    expect(backToBuild).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({ type: CONFLICT_RESOLVING, payload: expect.objectContaining({ files: ['README.md'], base: 'main', pending: 'blocked' }) }),
    ]);
    expect(await subject.unstarted('shop', 31)).toEqual({ base: 'main', pending: 'blocked' });
  });

  it('waits for a busy builder or a full host rather than sending the change back to build', async () => {
    for (const busy of [new BotBusyError('atlas'), new HostFullError('atlas')]) {
      const { subject, open, client, backToBuild } = rounds();
      open.mockRejectedValueOnce(busy);

      expect(await subject.start({ repoName: 'shop', prNumber: 31, baseRef: 'main' })).toBe('pending');

      expect(backToBuild).not.toHaveBeenCalled();
      expect(client.comment).not.toHaveBeenCalled();
      expect(await subject.unstarted('shop', 31)).toEqual({ base: 'main', pending: 'busy' });
    }
  });

  it('starts when asked again once the builder is free, and is a round like any other', async () => {
    const { subject, open, client, events } = rounds();
    open.mockRejectedValueOnce(new BotBusyError('atlas'));
    await subject.start({ repoName: 'shop', prNumber: 31, baseRef: 'main' });
    // Asked again while still busy: said once.
    open.mockRejectedValueOnce(new BotBusyError('atlas'));
    await subject.start({ repoName: 'shop', prNumber: 31, baseRef: 'main' });
    expect(events).toHaveLength(1);

    expect(await subject.start({ repoName: 'shop', prNumber: 31, baseRef: 'main' })).toBe('resolving');

    expect(await subject.unstarted('shop', 31)).toBeNull();
    expect(await subject.resolving('shop', 31)).toBe(true);
    expect(client.comment).toHaveBeenCalledTimes(1);
  });

  it('still falls back to the whole round for any other refusal', async () => {
    const { subject, open, backToBuild } = rounds();
    open.mockRejectedValueOnce(new Error('unknown bot atlas'));
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await subject.start({ repoName: 'shop', prNumber: 31, baseRef: 'main' })).toBe('sent_back');
    } finally {
      quiet.mockRestore();
    }
    expect(backToBuild).toHaveBeenCalled();
  });

  it('is over once a later start fell back to the whole round', async () => {
    const { subject, open } = rounds();
    open.mockRejectedValueOnce(new BotBusyError('atlas'));
    await subject.start({ repoName: 'shop', prNumber: 31, baseRef: 'main' });
    world.lease = null;

    expect(await subject.start({ repoName: 'shop', prNumber: 31, baseRef: 'main' })).toBe('sent_back');

    expect(await subject.unstarted('shop', 31)).toBeNull();
  });

  it('gives a round run again its brief and only the conflicted files', async () => {
    const { subject, open, events } = rounds();
    open.mockResolvedValueOnce({ taskId: 'task-1', session: null, error: 'held at a cap' } as never);
    await subject.start({ repoName: 'shop', prNumber: 31, baseRef: 'release' });
    const read = async (type: string, fields: Record<string, string | number>) =>
      events
        .filter((event) => event.type === type && Object.entries(fields).every(([key, value]) => event.payload[key] === value))
        .map(({ at, payload }) => ({ at, payload }));

    const again = await resolutionRetry('shop', 31, 'main', read);

    expect(again?.files).toEqual(['README.md']);
    expect(again?.brief).toMatchObject({ name: 'resolve-conflict.md' });
    expect(again?.brief.content).toContain('Your branch conflicts with `release` in:');
    expect(await resolutionRetry('shop', 32, 'main', read)).toBeNull();
  });
});
