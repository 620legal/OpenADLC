import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which repositories the dispatcher leases work in.
 *
 * A repository removed from OpenADLC keeps its row, its issues and their labels:
 * removing one deletes nothing. So a routable issue can still be sitting in
 * it, and nothing but the removal says it must not be handed out.
 */

const BODY = ['### Outcome', 'x', '### Acceptance criteria', '- x', '### Expected paths', '- src/x.ts', '### Verification', 'x'].join('\n\n');
const LABELS = ['adlc:build', 'start:now', 'priority:p1', 'area:console', 'do:builder'];

const builder = { id: 'id-builder', name: 'fleetadlc-atlas-janedoe', slot: 'builder', role: 'implement', engine: 'claude' };
const ACTIVE = { id: 'repo-api', name: 'api', fullName: 'acme/api', ownerBotId: builder.id, concurrency: 1, removedAt: null };
const REMOVED = { id: 'repo-web', name: 'web', fullName: 'acme/web', ownerBotId: builder.id, concurrency: 1, removedAt: '2026-09-24T09:00:00.000Z' };

const issue = (repoId: string, number: number) => ({ repoId, number, labels: LABELS, body: BODY, declaredPaths: [`src/${number}.ts`] });

/**
 * The leases a pass takes, as the store would keep them, and when each issue
 * was last sent to triage; `clock` orders the two.
 */
const store = vi.hoisted(() => ({
  clock: 0,
  leases: [] as { id: string; issueNumber: number; state: string; started: boolean; at: number }[],
  triagedAt: new Map<number, number>(),
}));

vi.mock('@fleetadlc/db', () => ({
  audit: vi.fn(async () => undefined),
  bots: { getBotById: vi.fn(async () => builder), listBots: vi.fn(async () => [builder]) },
  costs: {
    currentPeriod: vi.fn(() => '2026-09'),
    refreshBudget: vi.fn(async () => ({ state: 'ok', spentUsd: 0, capUsd: 100 })),
  },
  spendingLimits: { refusal: vi.fn(async () => null) },
  issues: {
    listBlockedIssues: vi.fn(async () => []),
    listRoutableIssues: vi.fn(async (repoId: string) => [issue(repoId, repoId === 'repo-api' ? 1 : 2)]),
    listIssues: vi.fn(async () => []),
    workInFlight: vi.fn(async () => []),
    getIssue: vi.fn(async () => null),
  },
  leases: {
    expireStaleLeases: vi.fn(async () => []),
    listActiveLeases: vi.fn(async () => []),
    // As the store counts them: leases over, with no pull request, that a
    // build started under, taken since the issue was last sent to triage.
    attemptsWithoutPullRequest: vi.fn(
      async (_repoId: string, number: number) =>
        store.leases.filter(
          (lease) =>
            lease.issueNumber === number &&
            ['released', 'expired'].includes(lease.state) &&
            lease.started &&
            lease.at > (store.triagedAt.get(number) ?? -Infinity),
        ).length,
    ),
    createLease: vi.fn(async (input: { issueNumber: number }) => {
      const lease = { id: `lease-${store.leases.length + 1}`, issueNumber: input.issueNumber, state: 'leased', started: false, at: (store.clock += 1) };
      store.leases.push(lease);
      return { id: lease.id, expiresAt: null };
    }),
    setLeaseState: vi.fn(async (id: string, state: string) => {
      const lease = store.leases.find((one) => one.id === id);
      if (lease) lease.state = state;
      return lease ?? null;
    }),
  },
  health: { listHealth: vi.fn(async () => []) },
  repos: { listRepos: vi.fn(async () => [ACTIVE, REMOVED]) },
  settings: { getSetting: vi.fn(async () => null) },
  tasks: { countSeatSlotsInUse: vi.fn(async () => 0), countUnfinishedImplementTasks: vi.fn(async () => 0) },
  // No host has registered: their room is not counted.
  hosts: { taskRoom: vi.fn(async () => null) },
}));

import { costs, health, issues, leases, repos, settings, spendingLimits } from '@fleetadlc/db';
import { blockingOverlaps, Dispatcher, INSTALL_PAUSE_UNREAD, overlapReason, PAUSES_UNREAD, pausedRepoNames } from './dispatcher.js';

function dispatcher(paused?: (repo?: string) => string | null, stopLeasing = true, dryRun = true): Dispatcher {
  return new Dispatcher({
    ...(paused ? { paused } : {}),
    bridgeUrl: 'http://127.0.0.1:1',
    internalSecret: 'secret',
    costs: { monthlyCapUsd: 100, perTaskCapUsd: 15, warningAt: 0.8, onCap: { stopLeasing } } as never,
    leaseHours: 12,
    dryRun,
  });
}

/** The stored settings a pass reads, by name; an Error is a read that fails. */
function stored(values: Record<string, string | Error>): void {
  vi.mocked(settings.getSetting).mockImplementation(async (name: string) => {
    const value = values[name];
    if (value instanceof Error) throw value;
    return value ?? null;
  });
}

beforeEach(() => {
  store.leases = [];
  store.triagedAt.clear();
  vi.mocked(leases.createLease).mockClear();
  vi.mocked(issues.listRoutableIssues).mockClear();
  vi.mocked(settings.getSetting).mockClear();
  stored({});
});

describe('a monthly cap', () => {
  it('does not lease, and says which limit was reached', async () => {
    vi.mocked(spendingLimits.refusal).mockResolvedValueOnce(
      'acme/api has spent $200 of its $200 this month on openai',
    );

    const decisions = await dispatcher().runOnce();

    expect(decisions).toContainEqual(
      expect.objectContaining({
        repo: 'api',
        issue: 1,
        action: 'skipped',
        reason: 'acme/api has spent $200 of its $200 this month on openai',
      }),
    );
    expect(decisions.some((decision) => decision.action === 'leased')).toBe(false);
  });
});

describe('onCap.stopLeasing', () => {
  it('leases past the global month total when it is false, and hands the flag to every cap check', async () => {
    // The budget check kept the flag and the per-bot check did not: with
    // stopLeasing false, the global month total still refused every builder.
    vi.mocked(costs.refreshBudget).mockResolvedValueOnce({ state: 'stopped', spentUsd: 150, capUsd: 100 } as never);
    vi.mocked(spendingLimits.refusal).mockClear();

    const decisions = await dispatcher(undefined, false).runOnce();

    expect(decisions).toContainEqual(expect.objectContaining({ repo: 'api', issue: 1, action: 'leased' }));
    expect(vi.mocked(spendingLimits.refusal).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ onCap: { stopLeasing: false }, monthlyCapUsd: 100 }),
    );
  });

  it('leases nothing past the global month total when it is true', async () => {
    vi.mocked(costs.refreshBudget).mockResolvedValueOnce({ state: 'stopped', spentUsd: 150, capUsd: 100 } as never);

    const decisions = await dispatcher(undefined, true).runOnce();

    expect(decisions.some((decision) => decision.action === 'leased')).toBe(false);
  });
});

describe('a repository removed from OpenADLC', () => {
  it('has nothing leased in it, while the repository beside it still does', async () => {
    const decisions = await dispatcher().runOnce();

    expect(decisions.filter((decision) => decision.action === 'leased').map((decision) => `${decision.repo}#${decision.issue}`)).toEqual([
      'api#1',
    ]);
    expect(decisions.some((decision) => decision.repo === 'web')).toBe(false);
    // Not even looked at: no issue of it is read, so none can be sent to triage either.
    expect(vi.mocked(issues.listRoutableIssues).mock.calls.map(([repoId]) => repoId)).toEqual(['repo-api']);
  });
});

describe('an issue held back by work in flight', () => {
  it('names the issue it waits for and the files they share', async () => {
    // "declared paths overlap work already in flight" named neither, so a
    // person could not tell what an issue was waiting on without comparing
    // every open issue's paths by hand.
    vi.mocked(issues.workInFlight).mockResolvedValueOnce([
      { number: 68, paths: ['src/', 'docs/guide.md'], building: true },
    ] as never);

    const decisions = await dispatcher().runOnce();

    expect(decisions).toContainEqual(
      expect.objectContaining({
        repo: 'api',
        issue: 1,
        action: 'skipped',
        reason: 'declared paths overlap work in flight: #68 (src/1.ts against src/), being built',
      }),
    );
  });

  it('names every issue it waits for, and says how many files it did not list', () => {
    const reason = overlapReason(
      blockingOverlaps(
        ['apps/bridge/src/a.ts', 'apps/bridge/src/b.ts', 'apps/bridge/src/c.ts', 'apps/bridge/src/d.ts', 'docs/x.md'],
        [
          { number: 68, paths: ['apps/bridge/src'], building: true },
          { number: 70, paths: ['docs/x.md'], building: true },
          { number: 71, paths: ['packages/shared/src/'], building: true },
        ],
        { shared: [], exclusive: [] },
      ),
    );

    expect(reason).toBe(
      'declared paths overlap work in flight: ' +
        '#68 (apps/bridge/src/a.ts against apps/bridge/src, apps/bridge/src/b.ts against apps/bridge/src, apps/bridge/src/c.ts against apps/bridge/src, and 1 more), being built; ' +
        '#70 (docs/x.md), being built',
    );
  });
});

describe('a blocked issue whose dependencies have shipped', () => {
  const WAITING = `${BODY}\n\n### Dependencies\n\n- #11`;

  it('is unblocked, unless it is labelled fleetadlc:ignore', async () => {
    // Unblocking swaps blocked for start:now: on an ignored issue, the crew
    // changing what it was told to leave alone.
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (asked.push(url), new Response('{"changed":true}', { status: 200, headers: { 'content-type': 'application/json' } }))),
    );
    vi.mocked(issues.getIssue).mockResolvedValue({ number: 11, stage: 'done', labels: ['adlc:done'] } as never);
    vi.mocked(issues.listBlockedIssues).mockImplementation(async (repoId: string) =>
      repoId === 'repo-api'
        ? ([
            { repoId, number: 12, labels: ['blocked', 'adlc:build'], body: WAITING, declaredPaths: [] },
            { repoId, number: 13, labels: ['blocked', 'adlc:build', 'fleetadlc:ignore'], body: WAITING, declaredPaths: [] },
          ] as never)
        : [],
    );

    try {
      const decisions = await dispatcher().runOnce();

      expect(decisions.filter((decision) => decision.action === 'unblocked').map((decision) => decision.issue)).toEqual([12]);
      expect(asked.filter((url) => url.includes('/unblock'))).toEqual(['http://127.0.0.1:1/internal/issues/api/12/unblock']);
    } finally {
      vi.mocked(issues.listBlockedIssues).mockImplementation(async () => []);
      vi.mocked(issues.getIssue).mockResolvedValue(null);
      vi.unstubAllGlobals();
    }
  });
});

describe('a repository a person paused', () => {
  const OTHER = { ...ACTIVE, id: 'repo-web', name: 'web', fullName: 'acme/web' };

  it('is passed over before any lease is asked for, while the repository beside it is leased', async () => {
    vi.mocked(repos.listRepos).mockResolvedValueOnce([ACTIVE, OTHER] as never);
    stored({ workPausedRepos: JSON.stringify({ api: { by: 'janedoe', at: '2026-09-29T10:00:00.000Z', reason: null } }) });

    const decisions = await dispatcher().runOnce();

    expect(decisions).toContainEqual(expect.objectContaining({ repo: 'api', action: 'skipped', reason: expect.stringMatching(/^work is paused in api/) }));
    expect(decisions.filter((decision) => decision.action === 'leased').map((decision) => `${decision.repo}#${decision.issue}`)).toEqual(['web#2']);
    expect(vi.mocked(issues.listRoutableIssues).mock.calls.map(([repoId]) => repoId)).toEqual(['repo-web']);
  });

  it('holds every repository when the setting cannot be read, rather than leasing and being refused', async () => {
    vi.mocked(repos.listRepos).mockResolvedValueOnce([ACTIVE, OTHER] as never);
    stored({ workPausedRepos: new Error('timeout') });

    const decisions = await dispatcher().runOnce();

    expect(decisions.some((decision) => decision.action === 'leased')).toBe(false);
    expect(decisions.filter((decision) => decision.reason === PAUSES_UNREAD).map((decision) => decision.repo)).toEqual(['api', 'web']);
    expect(vi.mocked(issues.listRoutableIssues)).not.toHaveBeenCalled();
    expect(pausedRepoNames('not json')).toBeNull();
    expect(pausedRepoNames('["api"]')).toBeNull();
    expect(pausedRepoNames(null)).toEqual(new Set());
  });

  it('asks the bridge’s gate when it runs in the bridge, and takes no lease in a repository it holds', async () => {
    vi.mocked(repos.listRepos).mockResolvedValueOnce([ACTIVE, OTHER] as never);
    const words = 'work is paused in api, by janedoe since 2026-09-29T10:00:00.000Z; resume it in Settings → Pause work';

    const decisions = await dispatcher((repo) => (repo === 'api' ? words : null)).runOnce();

    expect(decisions).toContainEqual(expect.objectContaining({ repo: 'api', action: 'skipped', reason: words }));
    expect(decisions.filter((decision) => decision.action === 'leased').map((decision) => decision.repo)).toEqual(['web']);
    expect(vi.mocked(issues.listRoutableIssues).mock.calls.map(([repoId]) => repoId)).toEqual(['repo-web']);
    // The stored repositories' pauses are not what it goes by here. (The
    // seats' pauses are read from the setting either way: the gate holds none.)
    expect(vi.mocked(settings.getSetting)).not.toHaveBeenCalledWith('workPausedRepos');
  });

  it('leases nothing at all while the install is paused', async () => {
    const decisions = await dispatcher((repo) => (repo ? null : 'work is paused, by janedoe')).runOnce();
    expect(decisions).toEqual([expect.objectContaining({ action: 'skipped', reason: 'work is paused, by janedoe' })]);
    expect(vi.mocked(issues.listRoutableIssues)).not.toHaveBeenCalled();
  });

  it('reads the install’s pause from the setting when it runs on its own', async () => {
    // Without the bridge's gate only the repositories' pauses were read, so a
    // paused install was leased in, every lease was refused, and each refusal
    // counted as an attempt.
    stored({ workPaused: JSON.stringify({ by: 'janedoe', at: '2026-09-29T10:00:00.000Z', reason: 'rotating keys' }) });

    const decisions = await dispatcher().runOnce();

    expect(decisions).toEqual([
      expect.objectContaining({
        repo: '-',
        bot: '-',
        action: 'skipped',
        reason: 'work is paused, by janedoe since 2026-09-29T10:00:00.000Z (rotating keys); resume it in Settings → Pause work',
      }),
    ]);
    expect(vi.mocked(issues.listRoutableIssues)).not.toHaveBeenCalled();
  });

  it('leases nothing when it cannot read whether the install is paused', async () => {
    stored({ workPaused: new Error('timeout') });

    const decisions = await dispatcher().runOnce();

    expect(decisions).toEqual([expect.objectContaining({ action: 'skipped', reason: INSTALL_PAUSE_UNREAD })]);
    expect(vi.mocked(issues.listRoutableIssues)).not.toHaveBeenCalled();
  });

});

describe('a lease the bridge refuses', () => {
  /** The bridge, answering every lease with `answer`; what was asked of it, by path. */
  function bridge(answer: number): string[] {
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        asked.push(path);
        const triaged = /^\/internal\/issues\/[^/]+\/(\d+)\/triage$/.exec(path);
        if (triaged) store.triagedAt.set(Number(triaged[1]), (store.clock += 1));
        if (path === '/internal/dispatch/lease' && answer !== 200) {
          return new Response('{"error":"fleetadlc-atlas-janedoe is not in acme/api yet"}', { status: answer });
        }
        return new Response('{"changed":true}', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    return asked;
  }

  it('is released and costs the issue no attempt, however many passes refuse it', async () => {
    // Each refused lease counted, and the fourth pass sent a ready issue to
    // triage, `start:now` off and a comment blaming it, with no build ever run.
    vi.mocked(repos.listRepos).mockResolvedValue([ACTIVE] as never);
    const asked = bridge(409);
    try {
      for (let pass = 1; pass <= 4; pass += 1) {
        const decisions = await dispatcher(undefined, true, false).runOnce();
        expect(decisions).toContainEqual(
          expect.objectContaining({ repo: 'api', issue: 1, action: 'skipped', reason: expect.stringMatching(/^bridge refused the lease: .*409/) }),
        );
        expect(decisions.some((decision) => decision.action === 'triaged')).toBe(false);
      }
      expect(store.leases.map((lease) => lease.state)).toEqual(['released', 'released', 'released', 'released']);
      expect(await leases.attemptsWithoutPullRequest('repo-api', 1)).toBe(0);
      expect(asked.some((path) => path.endsWith('/triage'))).toBe(false);
    } finally {
      vi.mocked(repos.listRepos).mockImplementation(async () => [ACTIVE, REMOVED] as never);
      vi.unstubAllGlobals();
    }
  });

  it('leaves an issue a person sent back to build after triage with three fresh attempts', async () => {
    // Its old leases still counted, so the next pass sent it straight back to
    // triage, and only a database edit got it built.
    vi.mocked(repos.listRepos).mockResolvedValue([ACTIVE] as never);
    for (let built = 1; built <= 3; built += 1) {
      store.leases.push({ id: `old-${built}`, issueNumber: 1, state: 'released', started: true, at: (store.clock += 1) });
    }
    const asked = bridge(200);
    try {
      const first = await dispatcher(undefined, true, false).runOnce();
      expect(first).toContainEqual(expect.objectContaining({ issue: 1, action: 'triaged', reason: 'leased 3 times without producing a pull request' }));
      expect(asked).toContain('/internal/issues/api/1/triage');

      // A person reshapes it, takes needs-triage off and puts start:now back:
      // it is routable again, as listRoutableIssues answers.
      const next = await dispatcher(undefined, true, false).runOnce();
      expect(next).toContainEqual(expect.objectContaining({ issue: 1, action: 'leased' }));
      expect(next.some((decision) => decision.action === 'triaged')).toBe(false);
    } finally {
      vi.mocked(repos.listRepos).mockImplementation(async () => [ACTIVE, REMOVED] as never);
      vi.unstubAllGlobals();
    }
  });

  it('does not offer the same builder to the next issue in the pass', async () => {
    // It was put back at the head of the line, so one refusal about the
    // builder took and released a lease on every issue in the repository.
    vi.mocked(repos.listRepos).mockResolvedValue([{ ...ACTIVE, concurrency: 2 }] as never);
    vi.mocked(issues.listRoutableIssues).mockImplementation(async (repoId: string) => [issue(repoId, 1), issue(repoId, 2)] as never);
    bridge(409);
    try {
      await dispatcher(undefined, true, false).runOnce();
      expect(leases.createLease).toHaveBeenCalledTimes(1);
    } finally {
      vi.mocked(repos.listRepos).mockImplementation(async () => [ACTIVE, REMOVED] as never);
      vi.mocked(issues.listRoutableIssues).mockImplementation(async (repoId: string) => [issue(repoId, repoId === 'repo-api' ? 1 : 2)] as never);
      vi.unstubAllGlobals();
    }
  });
});

describe('a builder the bridge would refuse', () => {
  afterEach(() => {
    vi.mocked(health.listHealth).mockResolvedValue([]);
    vi.unstubAllEnvs();
  });
  beforeEach(() => {
    // `node tests/all.mjs` runs these with a scratch install's exports, scripted engines among them.
    vi.stubEnv('FLEETADLC_SCRIPTED_ENGINES', '');
  });

  it('is not leased to in a repository it is not in, and the decision names it and the repository', async () => {
    vi.mocked(health.listHealth).mockResolvedValue([
      { id: `bot-access:${builder.id}:api`, state: 'failing', facts: {}, detail: 'Its invitation has not been accepted, so it cannot work there.' },
    ] as never);

    const decisions = await dispatcher().runOnce();

    expect(decisions).toContainEqual(
      expect.objectContaining({
        repo: 'api',
        bot: builder.name,
        action: 'skipped',
        reason: expect.stringMatching(/^fleetadlc-atlas-janedoe cannot work in api, so the bridge would refuse its build/),
      }),
    );
    expect(decisions.some((decision) => decision.action === 'leased')).toBe(false);
  });

  it('is not leased to while the host service is not answering', async () => {
    vi.mocked(health.listHealth).mockResolvedValue([{ id: 'hostd', state: 'failing', facts: {}, detail: null }] as never);

    const decisions = await dispatcher().runOnce();

    expect(decisions).toContainEqual(
      expect.objectContaining({ repo: 'api', action: 'skipped', reason: expect.stringMatching(/host service is not answering/) }),
    );
    expect(decisions.some((decision) => decision.action === 'leased')).toBe(false);
  });
});

describe('an issue whose Expected paths have a line that is not a path', () => {
  const UNREAD = BODY.replace('- src/x.ts', '- src/x.ts and its test');

  async function pass(labels: string[]): Promise<{ decisions: Awaited<ReturnType<Dispatcher['runOnce']>>; asked: { path: string; body: string }[] }> {
    const asked: { path: string; body: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        asked.push({ path, body: String(init?.body ?? '') });
        const answer = path.endsWith('/expected-paths') ? { changed: true, outcome: 'sent', reason: 'sent back to intake to rewrite its Expected paths' } : { changed: true };
        return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    vi.mocked(repos.listRepos).mockResolvedValue([ACTIVE] as never);
    vi.mocked(issues.listRoutableIssues).mockImplementation(async (repoId: string) => [{ ...issue(repoId, 1), labels, body: UNREAD }] as never);
    try {
      return { decisions: await dispatcher().runOnce(), asked };
    } finally {
      vi.mocked(repos.listRepos).mockImplementation(async () => [ACTIVE, REMOVED] as never);
      vi.mocked(issues.listRoutableIssues).mockImplementation(async (repoId: string) => [issue(repoId, repoId === 'repo-api' ? 1 : 2)] as never);
      vi.unstubAllGlobals();
    }
  }

  it('is sent back to the stage that wrote them, not to triage, when that is all it lacks', async () => {
    // needs-triage is a stop for a person, and a line to rewrite from the code
    // is no question for one.
    const { decisions, asked } = await pass(LABELS);

    expect(asked.map((one) => one.path)).toEqual(['/internal/issues/api/1/expected-paths']);
    expect(JSON.parse(asked[0]!.body)).toEqual({
      reason: 'not ready to be worked on: an Expected paths line that is not a path: src/x.ts and its test',
    });
    expect(decisions).toContainEqual(expect.objectContaining({ issue: 1, action: 'sent_back', reason: 'sent back to intake to rewrite its Expected paths' }));
    expect(leases.createLease).not.toHaveBeenCalled();
  });

  it('goes to triage when a person has something to say as well', async () => {
    const { decisions, asked } = await pass(LABELS.filter((label) => !label.startsWith('priority:')));

    expect(asked.map((one) => one.path)).toEqual(['/internal/issues/api/1/triage']);
    expect(JSON.parse(asked[0]!.body)).toEqual({
      reason: 'not ready to be worked on: needs a priority label; an Expected paths line that is not a path: src/x.ts and its test',
    });
    expect(decisions).toContainEqual(expect.objectContaining({ issue: 1, action: 'triaged' }));
  });
});
