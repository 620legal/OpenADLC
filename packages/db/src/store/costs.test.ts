import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

import { query, queryOne } from '../client.js';
import {
  LedgerAliasError,
  ensureBudget,
  listLedger,
  monthSpend,
  recordUsage,
  refreshBudget,
  spendByBotInRepo,
  spendByDay,
  spendByProvider,
  spendByProviderInRepo,
} from './costs.js';

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(queryOne).mockReset();
});

describe('a usage row', () => {
  it('refuses a negative cost, NaN or Infinity, and negative or fractional tokens, before any query runs', async () => {
    const row = { taskId: 'task-1', botId: 'bot-1', engine: 'claude' as const, model: 'claude-opus-5', tokensIn: 10, tokensOut: 4, costUsd: 0.02 };
    for (const bad of [{ costUsd: -1000 }, { costUsd: Number.NaN }, { costUsd: Number.POSITIVE_INFINITY }, { tokensIn: -5 }, { tokensOut: 1.5 }]) {
      await expect(recordUsage({ ...row, ...bad }), JSON.stringify(bad)).rejects.toThrow(/0 or more/);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('stores the resolved id, and the alias beside it', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);

    await recordUsage({
      taskId: 'task-1',
      botId: 'bot-1',
      engine: 'claude',
      model: 'claude-opus-5',
      modelAlias: 'newest:opus',
      tokensIn: 10,
      tokensOut: 4,
      costUsd: 0.02,
    });

    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toContain('model_alias');
    expect(params).toEqual(['task-1', 'bot-1', 'claude', 'claude-opus-5', 'newest:opus', null, 10, 4, 0.02]);
    expect(String(params?.[3])).not.toMatch(/^newest:/);
  });

  it('stores no alias for a pinned id', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);

    await recordUsage({
      taskId: 'task-1',
      botId: 'bot-1',
      engine: 'claude',
      model: 'claude-sonnet-5',
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
    });

    const params = vi.mocked(query).mock.calls[0]?.[1] as unknown[];
    expect(params[3]).toBe('claude-sonnet-5');
    expect(params[4]).toBeNull();
  });

  it('refuses an alias in the model column and writes nothing', async () => {
    await expect(
      recordUsage({
        taskId: 'task-1',
        botId: 'bot-1',
        engine: 'claude',
        model: 'newest:opus',
        tokensIn: 1,
        tokensOut: 1,
        costUsd: 0,
      }),
    ).rejects.toBeInstanceOf(LedgerAliasError);

    expect(vi.mocked(query)).not.toHaveBeenCalled();
  });

  it('reads the alias back with the row', async () => {
    vi.mocked(query).mockResolvedValueOnce([
      {
        id: '9',
        task_id: 'task-1',
        bot_id: 'bot-1',
        engine: 'claude',
        model: 'claude-opus-5',
        model_alias: 'newest:opus',
        tokens_in: 10,
        tokens_out: 4,
        cost_usd: '0.0200',
        at: new Date('2026-09-23T12:00:00.000Z'),
      },
    ]);

    const rows = await listLedger();

    expect(rows[0]).toMatchObject({ model: 'claude-opus-5', modelAlias: 'newest:opus' });
    expect(String(vi.mocked(query).mock.calls[0]?.[0])).toContain('model_alias');
  });
});

describe('month-to-date spend the limits are checked against', () => {
  it('attributes an engine to the provider that engine calls', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);

    await spendByProvider('2026-09');

    const sql = String(vi.mocked(query).mock.calls[0]?.[0]);
    expect(sql).toContain("when 'claude' then 'anthropic'");
    expect(sql).toContain("when 'codex' then 'openai'");
    expect(sql).toContain("when 'grok' then 'xai'");
    expect(sql).toContain("at >= ($1::text || '-01')::timestamp at time zone 'UTC'");
  });

  it('counts a month in UTC, as the period is named, whatever the server’s time zone', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ total: '5' });
    vi.mocked(query).mockResolvedValueOnce([]);

    expect(await monthSpend('2026-11')).toBe(5);
    await spendByDay('2026-11');

    const month = String(vi.mocked(queryOne).mock.calls[0]?.[0]);
    expect(month).toContain(
      "at >= ($1::text || '-01')::timestamp at time zone 'UTC' and at < (($1::text || '-01')::timestamp + interval '1 month') at time zone 'UTC'",
    );
    expect(month).not.toContain('to_char');
    expect(String(vi.mocked(query).mock.calls[0]?.[0])).toContain("to_char(l.at at time zone 'UTC', 'YYYY-MM-DD')");
  });

  it('starts a month that has no budget row yet, rather than failing the dispatcher until a job makes one', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    vi.mocked(queryOne).mockResolvedValueOnce({ total: '0' });
    vi.mocked(queryOne).mockResolvedValueOnce({ period: '2026-10', cap_usd: '40', spent_usd: '0', state: 'ok' });

    const budget = await refreshBudget('2026-10', 0.9);

    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    const text = String(sql).replace(/\s+/g, ' ');
    expect(text).toContain("(select amount_usd from spending_limits where scope = 'global' and kind = 'month_total')");
    expect(text).toContain('(select cap_usd from budgets where period < $1 order by period desc limit 1)');
    expect(text).toContain('on conflict (period) do nothing');
    expect(params).toEqual(['2026-10']);
    expect(budget).toEqual({ period: '2026-10', capUsd: 40, spentUsd: 0, state: 'ok' });
  });

  it('sums a bot inside one repository by the bot row, not by a shared login', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ bot_id: 'bot-2', cost_usd: '3.5' }]);

    const rows = await spendByBotInRepo('2026-09', 'repo-1');

    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toContain('l.bot_id');
    expect(String(sql)).toContain('t.repo_id = $2');
    expect(params).toEqual(['2026-09', 'repo-1']);
    expect(rows).toEqual([{ botId: 'bot-2', costUsd: 3.5 }]);
  });

  it('sums a provider inside one repository', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ provider: 'openai', cost_usd: '200' }]);

    const rows = await spendByProviderInRepo('2026-09', 'repo-api');

    const sql = String(vi.mocked(query).mock.calls[0]?.[0]);
    expect(sql).toContain('l.engine');
    expect(sql).toContain('t.repo_id = $2');
    expect(rows).toEqual([{ provider: 'openai', costUsd: 200 }]);
  });

  it('keeps a saved monthly cap when the file still says the old one', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ amount_usd: '40' });
    vi.mocked(query).mockResolvedValue([]);
    vi.mocked(queryOne).mockResolvedValueOnce({ total: '12' });
    vi.mocked(queryOne).mockResolvedValueOnce({ period: '2026-09', cap_usd: '40', spent_usd: '12', state: 'ok' });

    const budget = await ensureBudget('2026-09', 1500, 0.9);

    expect(String(vi.mocked(queryOne).mock.calls[0]?.[0])).toContain("kind = 'month_total'");
    const [, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(params).toEqual(['2026-09', 40]);
    expect(budget.capUsd).toBe(40);
  });
});

describe('spend by day', () => {
  it('is a row for every day of the period up to today, a quiet one as 0, not only the days with spend', async () => {
    vi.mocked(query).mockResolvedValueOnce([
      { day: '2026-09-01', cost_usd: '1.5' },
      { day: '2026-09-02', cost_usd: '0' },
    ]);
    expect(await spendByDay('2026-09')).toEqual([
      { day: '2026-09-01', costUsd: 1.5 },
      { day: '2026-09-02', costUsd: 0 },
    ]);
    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    const text = String(sql).replace(/\s+/g, ' ');
    expect(text).toContain("from generate_series( to_date($1, 'YYYY-MM')::timestamp, least((now() at time zone 'UTC')::date,");
    expect(text).toContain('left join ledger l');
    expect(text).toContain('coalesce(sum(l.cost_usd), 0)');
    expect(params).toEqual(['2026-09']);
  });
});
