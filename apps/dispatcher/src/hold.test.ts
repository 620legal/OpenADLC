import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bots } from '@openadlc/db';
import { holdFor, limitHold, type HealthFacts } from './hold.js';

/**
 * A build is not handed to a bot that could not land it: one GitHub will not
 * let sign in, or one whose signing key its account does not know while the
 * repository requires signed commits. The owner's builder was handed one,
 * failed at its commit, and held the issue for twelve hours.
 */

const BUILDER = { id: 'bot-builder', name: 'openadlc-atlas-janedoe' };

const signingKey = (state: string, requires: Record<string, boolean | null>) => ({
  id: 'signing-key:bot-builder',
  state,
  facts: { botId: 'bot-builder', requiresSignatures: requires },
});

/** The row the bridge raises when a task on the account ends on its usage limit (ADR 0096). */
const limited = (accountId: string, state = 'failing'): HealthFacts => ({
  id: `model-limit:${accountId}`,
  state,
  facts: { accountId, accountName: 'the Anthropic subscription “Shared Claude”', kind: 'spend', resetsAt: '2026-11-26T11:00:00.000Z' },
});

describe('a builder whose model account is at its usage limit', () => {
  const ON_SHARED = { ...BUILDER, modelAccountId: 'acct-shared' };

  it('is held back, and the decision names the account, the limit and its reset', () => {
    expect(holdFor(ON_SHARED, 'openadlc-testbed', [limited('acct-shared')])).toBe(
      'openadlc-atlas-janedoe thinks with the Anthropic subscription “Shared Claude”, which is at its spend limit ' +
        '(it says it resets 2026-11-26 11:00 UTC); nothing is leased to it until it works again',
    );
  });

  it('is held back with scripted engines too: the limit is the engine’s, not GitHub’s', () => {
    expect(holdFor(ON_SHARED, 'openadlc-testbed', [limited('acct-shared')], { scripted: true })).toMatch(/at its spend limit/);
  });

  it('is not, once the row passes, or for a builder on another account or none', () => {
    expect(holdFor(ON_SHARED, 'openadlc-testbed', [limited('acct-shared', 'ok')])).toBeNull();
    expect(holdFor({ ...BUILDER, modelAccountId: 'acct-other' }, 'openadlc-testbed', [limited('acct-shared')])).toBeNull();
    expect(limitHold({ name: 'x', modelAccountId: null }, [limited('acct-shared')])).toBeNull();
  });
});

describe('whether a builder is held back', () => {
  it('is, when its key is not on its account and the repository requires signed commits — and says why', () => {
    const reason = holdFor(BUILDER, 'openadlc-testbed', [signingKey('failing', { 'openadlc-testbed': true })]);
    expect(reason).toBe(
      'openadlc-atlas-janedoe’s signing key is not on its GitHub account and openadlc-testbed requires signed commits, ' +
        'so GitHub would refuse its commits; nothing is leased to it until it is — reconnect it from Settings → GitHub → Connected accounts',
    );
  });

  it('is not, where nothing requires signed commits or GitHub could not say', () => {
    expect(holdFor(BUILDER, 'openadlc-testbed', [signingKey('failing', { 'openadlc-testbed': false })])).toBeNull();
    expect(holdFor(BUILDER, 'openadlc-testbed', [signingKey('failing', { 'openadlc-testbed': null })])).toBeNull();
    expect(holdFor(BUILDER, 'other-repo', [signingKey('failing', { 'openadlc-testbed': true })])).toBeNull();
  });

  it('is not, once the key is there, or before anything has been checked', () => {
    expect(holdFor(BUILDER, 'openadlc-testbed', [signingKey('ok', { 'openadlc-testbed': true })])).toBeNull();
    expect(holdFor(BUILDER, 'openadlc-testbed', [signingKey('unknown', { 'openadlc-testbed': true })])).toBeNull();
    expect(holdFor(BUILDER, 'openadlc-testbed', [])).toBeNull();
  });

  it('is, when GitHub will not let it sign in at all', () => {
    expect(holdFor(BUILDER, 'openadlc-testbed', [{ id: 'bot-sign-in:bot-builder', state: 'failing', facts: {} }])).toMatch(
      /^openadlc-atlas-janedoe cannot sign in to GitHub/,
    );
  });

  // The bridge refuses to start a build on either (`blockersOf`), and a lease
  // taken anyway was refused and released on every pass.
  it('is, in a repository it is not in, saying what the check says to do', () => {
    const access = {
      id: 'bot-access:bot-builder:openadlc-testbed',
      state: 'failing',
      facts: {},
      detail: 'Its invitation has not been accepted, so it cannot work there. Let the crew in from the walkthrough.',
    };
    expect(holdFor(BUILDER, 'openadlc-testbed', [access])).toBe(
      'openadlc-atlas-janedoe cannot work in openadlc-testbed, so the bridge would refuse its build; nothing is leased to it there until it can — ' +
        'Its invitation has not been accepted, so it cannot work there. Let the crew in from the walkthrough',
    );
    expect(holdFor(BUILDER, 'other-repo', [access])).toBeNull();
    expect(holdFor(BUILDER, 'openadlc-testbed', [{ ...access, state: 'ok' }])).toBeNull();
  });

  it('is, every builder, while the host service is not answering', () => {
    expect(holdFor(BUILDER, 'openadlc-testbed', [{ id: 'hostd', state: 'failing', facts: {}, detail: null }])).toBe(
      'OpenADLC’s host service is not answering, so no build can start; nothing is leased until it answers — start OpenADLC again on the machine it runs on',
    );
    expect(holdFor(BUILDER, 'openadlc-testbed', [{ id: 'hostd', state: 'ok', facts: {} }])).toBeNull();
  });
});

const world = vi.hoisted(() => ({
  health: [] as { id: string; state: string; facts: Record<string, unknown> }[],
  leased: [] as number[],
}));

vi.mock('@openadlc/db', () => ({
  audit: vi.fn(async () => undefined),
  bots: {
    getBotById: vi.fn(async () => ({ id: 'bot-builder', name: 'openadlc-atlas-janedoe', slot: 'builder', role: 'implement', engine: 'claude' })),
    listBots: vi.fn(async () => [{ id: 'bot-builder', name: 'openadlc-atlas-janedoe', slot: 'builder', role: 'implement', engine: 'claude' }]),
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
  repos: { listRepos: vi.fn(async () => [{ id: 'repo-1', name: 'openadlc-testbed', ownerBotId: 'bot-builder', concurrency: 1 }]) },
  // Nothing paused: which repositories are is read each pass.
  settings: { getSetting: vi.fn(async () => null) },
  tasks: { countSeatSlotsInUse: vi.fn(async () => 0), countUnfinishedImplementTasks: vi.fn(async () => 0) },
  hosts: { taskRoom: vi.fn(async () => null) },
}));

vi.mock('@openadlc/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openadlc/shared')>()),
  // What the issue says is enough; routing readiness is its own test's.
  missingForRouting: () => [],
}));

beforeEach(() => {
  world.health = [];
  world.leased = [];
});

describe('the dispatcher, with a builder GitHub would refuse', () => {
  // A scripted install holds nobody back, and `node tests/all.mjs` runs these
  // with a scratch install's exports, `OPENADLC_SCRIPTED_ENGINES=1` among them.
  beforeEach(() => {
    vi.stubEnv('OPENADLC_SCRIPTED_ENGINES', '');
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
    world.health = [signingKey('failing', { 'openadlc-testbed': true })];
    const decisions = await run();

    expect(decisions).toEqual([
      expect.objectContaining({ repo: 'openadlc-testbed', bot: 'openadlc-atlas-janedoe', action: 'skipped', reason: expect.stringMatching(/signing key is not on its GitHub account/) }),
    ]);
    expect(decisions.some((decision) => decision.action === 'leased')).toBe(false);
  });

  it('leases to it once its key is on its account', async () => {
    world.health = [signingKey('ok', { 'openadlc-testbed': true })];
    const decisions = await run();
    expect(decisions).toEqual([expect.objectContaining({ issue: 1, bot: 'openadlc-atlas-janedoe', action: 'leased' })]);
  });

  it('passes over a builder on a limited account and leases to one on another account in the same pass', async () => {
    const seat = (id: string, name: string, slot: string, modelAccountId: string) => ({ id, name, slot, role: 'implement', engine: 'claude', githubLogin: name, modelAccountId });
    const owner = seat('bot-builder', 'openadlc-atlas-janedoe', 'builder', 'acct-shared');
    const second = seat('bot-builder-2', 'openadlc-orion-janedoe', 'builder-2', 'acct-own');
    vi.mocked(bots.getBotById).mockResolvedValue(owner as never);
    vi.mocked(bots.listBots).mockResolvedValue([owner, second] as never);
    world.health = [limited('acct-shared')];
    try {
      const decisions = await run();
      expect(decisions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ bot: 'openadlc-atlas-janedoe', action: 'skipped', reason: expect.stringMatching(/at its spend limit/) }),
          expect.objectContaining({ issue: 1, bot: 'openadlc-orion-janedoe', action: 'leased' }),
        ]),
      );
      expect(decisions.some((decision) => decision.action === 'leased' && decision.bot === 'openadlc-atlas-janedoe')).toBe(false);
    } finally {
      vi.mocked(bots.getBotById).mockReset().mockImplementation((async () => ({ id: 'bot-builder', name: 'openadlc-atlas-janedoe', slot: 'builder', role: 'implement', engine: 'claude' })) as never);
      vi.mocked(bots.listBots).mockReset().mockImplementation((async () => [{ id: 'bot-builder', name: 'openadlc-atlas-janedoe', slot: 'builder', role: 'implement', engine: 'claude' }]) as never);
    }
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

