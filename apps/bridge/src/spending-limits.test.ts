import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Settings is where a spending cap is changed. The file only seeds the first
 * values; a repository cannot be set above the global cap of the same kind;
 * lowering the global cap pulls a repository down with it.
 */

const store = vi.hoisted(() => ({
  limits: [] as { scope: string; kind: string; amountUsd: number | null }[],
  audits: [] as { action: string; target: string; payload: Record<string, unknown> }[],
  budget: { period: '2026-09', capUsd: 100, spentUsd: 0, state: 'ok' as string },
  seeded: [] as number[][],
  lock: Promise.resolve() as Promise<unknown>,
}));

vi.mock('@fleetadlc/db', () => ({
  audit: vi.fn(async (input: { action: string; target: string; payload: Record<string, unknown> }) => {
    store.audits.push(input);
  }),
  bots: {
    listBots: vi.fn(async () => [
      { id: 'bot-1', name: 'builder', engine: 'codex', githubLogin: 'shared' },
      { id: 'bot-2', name: 'builder-2', engine: 'codex', githubLogin: 'shared' },
    ]),
  },
  costs: {
    currentPeriod: () => '2026-09',
    monthSpend: vi.fn(async () => store.budget.spentUsd),
    spendByProvider: vi.fn(async () => []),
    spendForBot: vi.fn(async () => 0),
    spendForRepo: vi.fn(async () => 0),
    spendByBotInRepo: vi.fn(async () => []),
    spendByProviderInRepo: vi.fn(async () => []),
    ensureBudget: vi.fn(async () => store.budget),
  },
  repos: {
    listRepos: vi.fn(async () => [{ id: 'repo-1', name: 'api', fullName: 'exampleco/api' }]),
  },
  spendingLimits: {
    GLOBAL_SCOPE: 'global',
    SPENDING_PROVIDERS: ['anthropic', 'openai', 'xai'],
    dollars: (amount: number) => (Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`),
    repoScope: (id: string) => `repo:${id}`,
    repoIdOf: (scope: string) => (scope.startsWith('repo:') ? scope.slice(5) : null),
    botKind: (id: string) => `month_bot:${id}`,
    providerKind: (provider: string) => `month_provider:${provider}`,
    seedGlobal: vi.fn(async (monthly: number, task: number) => {
      store.seeded.push([monthly, task]);
      return false;
    }),
    listLimits: vi.fn(async () => store.limits.map((row) => ({ ...row }))),
    // One save at a time, planned against the rows as they are once it is
    // its turn, and written whole or not at all: the transaction and the
    // advisory lock the store takes.
    saveLimits: vi.fn(
      (input: {
        actor: string;
        plan: (current: typeof store.limits) => {
          writes: { scope: string; kind: string; amountUsd: number | null; old: number | null }[];
          result: unknown;
        };
      }) => {
        const turn = store.lock.then(() => {
          const { writes, result } = input.plan(store.limits.map((row) => ({ ...row })));
          for (const write of writes) {
            store.limits = store.limits.filter((row) => !(row.scope === write.scope && row.kind === write.kind));
            if (write.amountUsd != null) store.limits.push({ scope: write.scope, kind: write.kind, amountUsd: write.amountUsd });
            store.audits.push({
              action: 'spending.limit_changed',
              target: `${write.scope} ${write.kind}`,
              payload: { scope: write.scope, kind: write.kind, old: write.old, new: write.amountUsd },
            });
          }
          return result;
        });
        store.lock = turn.catch(() => undefined);
        return turn;
      },
    ),
  },
}));

import { spendingLimits } from '@fleetadlc/db';
import type { CostsConfig } from '@fleetadlc/shared';
import { SpendingLimitRejected, applySpendingLimits, spendingView } from './spending-limits.js';

const costs = {
  monthlyCapUsd: 1500,
  perTaskCapUsd: 15,
  warningAt: 0.9,
  onCap: { stopLeasing: true, pauseReviewsAt: 1, notify: [] },
} as CostsConfig;

beforeEach(() => {
  store.limits = [
    { scope: 'global', kind: 'month_total', amountUsd: 100 },
    { scope: 'global', kind: 'task', amountUsd: 15 },
  ];
  store.audits = [];
  store.seeded = [];
  store.budget = { period: '2026-09', capUsd: 100, spentUsd: 0, state: 'ok' };
});

describe('saving a spending limit', () => {
  it('seeds from the file before it reads what is saved', async () => {
    vi.mocked(spendingLimits.seedGlobal).mockClear();
    vi.mocked(spendingLimits.listLimits).mockClear();

    await spendingView(costs);

    expect(store.seeded).toEqual([[1500, 15]]);
    // Read first, a fresh install's first view shows no global caps.
    expect(vi.mocked(spendingLimits.seedGlobal).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(spendingLimits.listLimits).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('refuses a repository limit above the global one', async () => {
    const saving = applySpendingLimits({
      costs,
      actor: 'alexsmith',
      changes: [{ scope: 'repo:repo-1', kind: 'month_total', amountUsd: 200 }],
    });

    await expect(saving).rejects.toThrow(SpendingLimitRejected);
    await expect(saving).rejects.toThrow("can't be more than the global $100");
    expect(store.audits).toEqual([]);
    expect(store.limits.some((row) => row.scope === 'repo:repo-1')).toBe(false);
  });

  it('lowers a repository cap that the new global cap undercuts, names it, and audits both', async () => {
    store.limits.push({ scope: 'repo:repo-1', kind: 'month_total', amountUsd: 80 });

    const saved = await applySpendingLimits({
      costs,
      actor: 'alexsmith',
      changes: [{ scope: 'global', kind: 'month_total', amountUsd: 50 }],
    });

    expect(saved.lowered).toEqual([{ repo: 'exampleco/api', kind: 'month_total', from: 80, to: 50 }]);
    expect(saved.notice).toContain('exampleco/api');
    expect(store.limits).toContainEqual({ scope: 'repo:repo-1', kind: 'month_total', amountUsd: 50 });
    expect(store.audits.map((entry) => entry.payload)).toEqual([
      { scope: 'global', kind: 'month_total', old: 100, new: 50 },
      { scope: 'repo:repo-1', kind: 'month_total', old: 80, new: 50 },
    ]);
    expect(store.audits.every((entry) => entry.action === 'spending.limit_changed')).toBe(true);
  });

  it('says leasing has stopped when the new global cap is already below this month’s spend', async () => {
    store.budget = { period: '2026-09', capUsd: 40, spentUsd: 60, state: 'stopped' };

    const saved = await applySpendingLimits({
      costs,
      actor: 'alexsmith',
      changes: [{ scope: 'global', kind: 'month_total', amountUsd: 40 }],
    });

    expect(saved.leasingStopped).toBe(true);
    expect(saved.notice).toContain('Month-to-date spend is $60.00 of $40.00, so no new work is leased.');
  });

  it('gives two bots that share a login a limit each', async () => {
    await applySpendingLimits({
      costs,
      actor: 'alexsmith',
      changes: [
        { scope: 'global', kind: 'month_bot:bot-1', amountUsd: 10 },
        { scope: 'global', kind: 'month_bot:bot-2', amountUsd: 30 },
      ],
    });

    expect(store.limits).toContainEqual({ scope: 'global', kind: 'month_bot:bot-1', amountUsd: 10 });
    expect(store.limits).toContainEqual({ scope: 'global', kind: 'month_bot:bot-2', amountUsd: 30 });
  });

  it('checks a repository cap against the global one saved by a save that ran at the same time', async () => {
    // Each save read the rows before either wrote. One lowered the global
    // month to $50 while the other set the repository's to $80, and both
    // were stored: a repository cap above the global one.
    const lowering = applySpendingLimits({
      costs,
      actor: 'alexsmith',
      changes: [{ scope: 'global', kind: 'month_total', amountUsd: 50 }],
    });
    const raising = applySpendingLimits({
      costs,
      actor: 'janedoe',
      changes: [{ scope: 'repo:repo-1', kind: 'month_total', amountUsd: 80 }],
    });

    await expect(lowering).resolves.toBeDefined();
    await expect(raising).rejects.toThrow("can't be more than the global $50");
    expect(store.limits).toContainEqual({ scope: 'global', kind: 'month_total', amountUsd: 50 });
    expect(store.limits.some((row) => row.scope === 'repo:repo-1')).toBe(false);
  });

  it('refuses a limit that rounds to nothing, rather than saving a cap of $0', async () => {
    const saving = applySpendingLimits({ costs, actor: 'alexsmith', changes: [{ scope: 'global', kind: 'month_total', amountUsd: 0.004 }] });

    await expect(saving).rejects.toThrow('a limit is at least $0.01, or blank for none');
    expect(store.limits).toContainEqual({ scope: 'global', kind: 'month_total', amountUsd: 100 });
  });

  it('refuses changes that are not a list, and saves nothing', async () => {
    for (const changes of [undefined, null, 'global month_total 50', { scope: 'global', kind: 'month_total', amountUsd: 50 }]) {
      const saving = applySpendingLimits({ costs, actor: 'alexsmith', changes });
      await expect(saving).rejects.toThrow(SpendingLimitRejected);
    }
    expect(store.audits).toEqual([]);
    expect(store.limits).toContainEqual({ scope: 'global', kind: 'month_total', amountUsd: 100 });
  });
});
