import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { holdFor, type HealthFacts } from './hold.js';

/**
 * A build is not handed to a bot that could not land it: one GitHub will not
 * let sign in, or one whose signing key its account does not know while the
 * repository requires signed commits. The owner's builder was handed one,
 * failed at its commit, and held the issue for twelve hours.
 */

const BUILDER = { id: 'bot-builder', name: 'fleetadlc-atlas-janedoe' };

const signingKey = (state: string, requires: Record<string, boolean | null>) => ({
  id: 'signing-key:bot-builder',
  state,
  facts: { botId: 'bot-builder', requiresSignatures: requires },
});

describe('whether a builder is held back', () => {
  it('is, when its key is not on its account and the repository requires signed commits — and says why', () => {
    const reason = holdFor(BUILDER, 'fleetadlc-testbed', [signingKey('failing', { 'fleetadlc-testbed': true })]);
    expect(reason).toBe(
      'fleetadlc-atlas-janedoe’s signing key is not on its GitHub account and fleetadlc-testbed requires signed commits, ' +
        'so GitHub would refuse its commits; nothing is leased to it until it is — reconnect it from Settings → GitHub → Connected accounts',
    );
  });

  it('is not, where nothing requires signed commits or GitHub could not say', () => {
    expect(holdFor(BUILDER, 'fleetadlc-testbed', [signingKey('failing', { 'fleetadlc-testbed': false })])).toBeNull();
    expect(holdFor(BUILDER, 'fleetadlc-testbed', [signingKey('failing', { 'fleetadlc-testbed': null })])).toBeNull();
    expect(holdFor(BUILDER, 'other-repo', [signingKey('failing', { 'fleetadlc-testbed': true })])).toBeNull();
  });

  it('is not, once the key is there, or before anything has been checked', () => {
    expect(holdFor(BUILDER, 'fleetadlc-testbed', [signingKey('ok', { 'fleetadlc-testbed': true })])).toBeNull();
    expect(holdFor(BUILDER, 'fleetadlc-testbed', [signingKey('unknown', { 'fleetadlc-testbed': true })])).toBeNull();
    expect(holdFor(BUILDER, 'fleetadlc-testbed', [])).toBeNull();
  });

  it('is, when GitHub will not let it sign in at all', () => {
    expect(holdFor(BUILDER, 'fleetadlc-testbed', [{ id: 'bot-sign-in:bot-builder', state: 'failing', facts: {} }])).toMatch(
      /^fleetadlc-atlas-janedoe cannot sign in to GitHub/,
    );
  });

  // The bridge refuses to start a build on either (`blockersOf`), and a lease
  // taken anyway was refused and released on every pass.
  it('is, in a repository it is not in, saying what the check says to do', () => {
    const access = {
      id: 'bot-access:bot-builder:fleetadlc-testbed',
      state: 'failing',
      facts: {},
      detail: 'Its invitation has not been accepted, so it cannot work there. Let the crew in from the walkthrough.',
    };
    expect(holdFor(BUILDER, 'fleetadlc-testbed', [access])).toBe(
      'fleetadlc-atlas-janedoe cannot work in fleetadlc-testbed, so the bridge would refuse its build; nothing is leased to it there until it can — ' +
        'Its invitation has not been accepted, so it cannot work there. Let the crew in from the walkthrough',
    );
    expect(holdFor(BUILDER, 'other-repo', [access])).toBeNull();
    expect(holdFor(BUILDER, 'fleetadlc-testbed', [{ ...access, state: 'ok' }])).toBeNull();
  });

  it('is, every builder, while the host service is not answering', () => {
    expect(holdFor(BUILDER, 'fleetadlc-testbed', [{ id: 'hostd', state: 'failing', facts: {}, detail: null }])).toBe(
      'OpenADLC’s host service is not answering, so no build can start; nothing is leased until it answers — start OpenADLC again on the machine it runs on',
    );
    expect(holdFor(BUILDER, 'fleetadlc-testbed', [{ id: 'hostd', state: 'ok', facts: {} }])).toBeNull();
  });
});

const world = vi.hoisted(() => ({
  health: [] as { id: string; state: string; facts: Record<string, unknown> }[],
  leased: [] as number[],
}));

vi.mock('@fleetadlc/db', () => ({
  audit: vi.fn(async () => undefined),
  bots: {
    getBotById: vi.fn(async () => ({ id: 'bot-builder', name: 'fleetadlc-atlas-janedoe', slot: 'builder', role: 'implement', engine: 'claude' })),
    listBots: vi.fn(async () => [{ id: 'bot-builder', name: 'fleetadlc-atlas-janedoe', slot: 'builder', role: 'implement', engine: 'claude' }]),
  },
  costs: {
    currentPeriod: vi.fn(() => '2026-09'),
    refreshBudget: vi.fn(async () => ({ state: 'ok', spentUsd: 1, capUsd: 1500 })),
  },
  spendingLimits: { refusal: vi.fn(async () => null) },
  health: { listHealth: vi.fn(async () => world.health) },
  issues: {
    listBlockedIssues: vi.fn(async () => []),
    listRoutableIssues: vi.fn(async () => [
      { number: 1, title: 'Add a health endpoint', body: '', labels: ['start:now'], declaredPaths: ['apps/api/'], acceptance: ['it answers'] },
    ]),
    listIssues: vi.fn(async () => []),
    workInFlight: vi.fn(async () => []),
  },
  leases: {
    expireStaleLeases: vi.fn(async () => []),
    listActiveLeases: vi.fn(async () => []),
    attemptsWithoutPullRequest: vi.fn(async () => 0),
    createLease: vi.fn(async (input: { issueNumber: number }) => {
      world.leased.push(input.issueNumber);
      return { id: 'lease-1', expiresAt: null };
    }),
  },
  repos: { listRepos: vi.fn(async () => [{ id: 'repo-1', name: 'fleetadlc-testbed', ownerBotId: 'bot-builder', concurrency: 1 }]) },
  // Nothing paused: which repositories are is read each pass.
  settings: { getSetting: vi.fn(async () => null) },
  tasks: { countSeatSlotsInUse: vi.fn(async () => 0), countUnfinishedImplementTasks: vi.fn(async () => 0) },
  hosts: { taskRoom: vi.fn(async () => null) },
}));

vi.mock('@fleetadlc/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fleetadlc/shared')>()),
  // What the issue says is enough; routing readiness is its own test's.
  missingForRouting: () => [],
}));

beforeEach(() => {
  world.health = [];
  world.leased = [];
});

describe('the dispatcher, with a builder GitHub would refuse', () => {
  // A scripted install holds nobody back, and `node tests/all.mjs` runs these
  // with a scratch install's exports, `FLEETADLC_SCRIPTED_ENGINES=1` among them.
  beforeEach(() => {
    vi.stubEnv('FLEETADLC_SCRIPTED_ENGINES', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function run() {
    const { Dispatcher } = await import('./dispatcher.js');
    const dispatcher = new Dispatcher({
      bridgeUrl: 'http://127.0.0.1:1',
      internalSecret: 'secret',
      costs: { onCap: { stopLeasing: true }, warningAt: 0.8 } as never,
      leaseHours: 12,
      dryRun: true,
    });
    return dispatcher.runOnce();
  }

  it('leases nothing to it, and its decision says why', async () => {
    world.health = [signingKey('failing', { 'fleetadlc-testbed': true })];
    const decisions = await run();

    expect(decisions).toEqual([
      expect.objectContaining({ repo: 'fleetadlc-testbed', bot: 'fleetadlc-atlas-janedoe', action: 'skipped', reason: expect.stringMatching(/signing key is not on its GitHub account/) }),
    ]);
    expect(decisions.some((decision) => decision.action === 'leased')).toBe(false);
  });

  it('leases to it once its key is on its account', async () => {
    world.health = [signingKey('ok', { 'fleetadlc-testbed': true })];
    const decisions = await run();
    expect(decisions).toEqual([expect.objectContaining({ issue: 1, bot: 'fleetadlc-atlas-janedoe', action: 'leased' })]);
  });

  it('holds nobody back when the engines are scripted, since nothing is pushed to GitHub', () => {
    // The integration suites run scripted engines with no account behind any
    // bot: every sign-in check fails there, and holding builders back for it
    // leased nothing at all.
    const failing: HealthFacts[] = [
      { id: 'bot-sign-in:bot-builder', state: 'failing', facts: {} },
      { id: 'signing-key:bot-builder', state: 'failing', facts: { requiresSignatures: { testbed: true } } },
      // The bridge's own check skips these under scripted engines too (`TaskService.blocked`).
      { id: 'bot-access:bot-builder:testbed', state: 'failing', facts: {} },
      { id: 'hostd', state: 'failing', facts: {} },
    ];
    expect(holdFor({ id: 'bot-builder', name: 'builder' }, 'testbed', failing, { scripted: true })).toBeNull();
    expect(holdFor({ id: 'bot-builder', name: 'builder' }, 'testbed', failing)).not.toBeNull();
  });
});

