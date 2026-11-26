import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

import { query, queryOne } from '../client.js';
import {
  LedgerAliasError,
  ensureBudget,
  getBudget,
  listLedger,
  monthSpend,
  recordUsage,
  refreshBudget,
  spendByBotInRepo,
  spendByBot,
  spendByDay,
  spendByProvider,
  spendByProviderInRepo,
  spendByRepo,
  spendForBot,
  spendForRepo,
  spendByBotSince,
  usageByModel,
  usageSeries,
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
    // A caller that says nothing of the cache records none.
    expect(params).toEqual(['task-1', 'bot-1', 'claude', 'claude-opus-5', 'newest:opus', null, 10, 4, 0.02, true, 0, 0]);
    expect(String(params?.[3])).not.toMatch(/^newest:/);
  });

  it('stores the cache read and written beside tokens in', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);

    await recordUsage({ taskId: 'task-1', botId: 'bot-1', engine: 'claude', model: 'claude-opus-5', tokensIn: 100, tokensOut: 4, cacheRead: 70, cacheWrite: 30, costUsd: 0.02 });

    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toContain('tokens_cache_read, tokens_cache_write');
    expect((params as unknown[]).slice(-2)).toEqual([70, 30]);
    expect((params as unknown[])[6]).toBe(100);
  });

  it('refuses a negative or fractional cache count, or cache counts above tokens in, before any query runs', async () => {
    const row = { taskId: 'task-1', botId: 'bot-1', engine: 'claude' as const, model: 'claude-opus-5', tokensIn: 10, tokensOut: 4, costUsd: 0.02 };
    for (const bad of [{ cacheRead: -1 }, { cacheWrite: 0.5 }]) {
      await expect(recordUsage({ ...row, ...bad }), JSON.stringify(bad)).rejects.toThrow(/0 or more/);
    }
    await expect(recordUsage({ ...row, cacheRead: 6, cacheWrite: 5 })).rejects.toThrow(/cache tokens as part of tokens in/);
    expect(query).not.toHaveBeenCalled();
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

  it('reads the cache counts back with the row', async () => {
    const at = new Date('2026-11-25T12:00:00.000Z');
    const base = { task_id: 'task-1', bot_id: 'bot-1', engine: 'claude', model: 'claude-opus-5', model_alias: null, tokens_out: 4, cost_usd: '0.0200', billed: true, at };
    vi.mocked(query).mockResolvedValueOnce([
      { ...base, id: '10', tokens_in: 100, tokens_cache_read: 70, tokens_cache_write: 30 },
      // A row from before 0171 reads 0 in both, as its default.
      { ...base, id: '9', tokens_in: 10, tokens_cache_read: 0, tokens_cache_write: 0 },
    ]);

    const rows = await listLedger();

    expect(rows.map((row) => [row.tokensIn, row.cacheRead, row.cacheWrite])).toEqual([
      [100, 70, 30],
      [10, 0, 0],
    ]);
    expect(String(vi.mocked(query).mock.calls[0]?.[0])).toContain('tokens_cache_read, tokens_cache_write');
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
    expect(budget).toEqual({ period: '2026-10', capUsd: 40, spentUsd: 0, estimateUsd: 0, state: 'ok' });
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

describe('billed spend and the subscription estimate', () => {
  const sql = (call = 0) => String(vi.mocked(queryOne).mock.calls[call]?.[0] ?? vi.mocked(query).mock.calls[call]?.[0]).replace(/\s+/g, ' ');

  it('writes a subscription run as not billed, and a row with no flag as billed', async () => {
    vi.mocked(query).mockResolvedValue([]);
    const row = { taskId: 'task-1', botId: 'bot-1', engine: 'claude' as const, model: 'claude-opus-5', tokensIn: 1, tokensOut: 1, costUsd: 3 };

    await recordUsage({ ...row, billed: false });
    await recordUsage(row);

    expect(String(vi.mocked(query).mock.calls[0]?.[0])).toContain('billed');
    expect((vi.mocked(query).mock.calls[0]?.[1] as unknown[])[9]).toBe(false);
    expect((vi.mocked(query).mock.calls[1]?.[1] as unknown[])[9]).toBe(true);
  });

  it('reads the flag back with the ledger row', async () => {
    vi.mocked(query).mockResolvedValueOnce([
      { id: '1', task_id: 't', bot_id: 'b', engine: 'claude', model: 'm', model_alias: null, tokens_in: 1, tokens_out: 1, cost_usd: '2', billed: false, at: new Date() },
    ]);
    expect((await listLedger())[0]?.billed).toBe(false);
  });

  it('counts only billed rows in every month sum a cap reads, and only unbilled ones when asked for the estimate', async () => {
    const sums: [string, () => Promise<unknown>, () => Promise<unknown>, 'one' | 'many'][] = [
      ['monthSpend', () => monthSpend('2026-11'), () => monthSpend('2026-11', 'estimate'), 'one'],
      ['spendForBot', () => spendForBot('2026-11', 'bot-1'), () => spendForBot('2026-11', 'bot-1', 'estimate'), 'one'],
      ['spendForRepo', () => spendForRepo('2026-11', 'repo-1'), () => spendForRepo('2026-11', 'repo-1', 'estimate'), 'one'],
      ['spendByProvider', () => spendByProvider('2026-11'), () => spendByProvider('2026-11', 'estimate'), 'many'],
      ['spendByBotInRepo', () => spendByBotInRepo('2026-11', 'r'), () => spendByBotInRepo('2026-11', 'r', 'estimate'), 'many'],
      ['spendByProviderInRepo', () => spendByProviderInRepo('2026-11', 'r'), () => spendByProviderInRepo('2026-11', 'r', 'estimate'), 'many'],
    ];
    for (const [name, billed, estimate, shape] of sums) {
      vi.mocked(query).mockReset().mockResolvedValue([]);
      vi.mocked(queryOne).mockReset().mockResolvedValue({ total: '0' });
      await billed();
      await estimate();
      const calls = shape === 'one' ? vi.mocked(queryOne).mock.calls : vi.mocked(query).mock.calls;
      const [first, second] = calls.map(([text]) => String(text).replace(/\s+/g, ' '));
      expect(first, name).toMatch(/and (l\.)?billed\b/);
      expect(first, name).not.toMatch(/not (l\.)?billed/);
      expect(second, name).toMatch(/and not (l\.)?billed\b/);
    }
  });

  it('keeps the Costs page breakdowns of what work cost counting every row', async () => {
    vi.mocked(query).mockResolvedValue([]);
    await spendByBot('2026-11');
    await spendByRepo('2026-11');
    await spendByDay('2026-11');
    for (const [text] of vi.mocked(query).mock.calls) expect(String(text)).not.toContain('billed');
  });

  it('sets the leasing budget from billed spend alone, and carries the estimate beside it', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    vi.mocked(queryOne).mockResolvedValueOnce({ total: '10', estimate: '140' });
    vi.mocked(queryOne).mockResolvedValueOnce({ period: '2026-11', cap_usd: '100', spent_usd: '10', state: 'ok' });

    const budget = await refreshBudget('2026-11', 0.8);

    expect(sql(0)).toContain('sum(cost_usd) filter (where billed)');
    expect(sql(0)).toContain('sum(cost_usd) filter (where not billed)');
    // What the state is computed from: the billed sum, not the $150 total.
    expect(vi.mocked(queryOne).mock.calls[1]?.[1]).toEqual(['2026-11', 10, 0.8]);
    expect(budget).toMatchObject({ spentUsd: 10, estimateUsd: 140, state: 'ok' });
  });

  it('reads the estimate with a stored budget', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ period: '2026-11', cap_usd: '100', spent_usd: '10', estimate_usd: '7.5', state: 'ok' });
    expect(await getBudget('2026-11')).toEqual({ period: '2026-11', capUsd: 100, spentUsd: 10, estimateUsd: 7.5, state: 'ok' });
    expect(sql(0)).toContain('not billed');
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

/**
 * The Costs page's range (docs/adr/0091): reads only, held to `since` (or the
 * whole ledger for null), with billed and estimated summed apart.
 */
describe('usage by range', () => {
  const since = new Date('2026-11-18T12:00:00.000Z');

  it('sums per model, engine and billed since a moment, or over the whole ledger', async () => {
    vi.mocked(query).mockResolvedValue([
      { model: 'claude-opus-5', engine: 'claude', billed: true, cost_usd: '1.5000', tokens_in: '1000', tokens_out: '20', cache_read: '600', cache_write: '100', invocations: '3' },
      // A row from before 0171 sums to 0 in both cache columns.
      { model: 'gpt-5-codex', engine: 'codex', billed: false, cost_usd: '0.2500', tokens_in: '400', tokens_out: '5', cache_read: '0', cache_write: '0', invocations: '1' },
    ]);

    const rows = await usageByModel(since);
    expect(rows).toEqual([
      { model: 'claude-opus-5', engine: 'claude', billed: true, costUsd: 1.5, tokensIn: 1000, tokensOut: 20, cacheRead: 600, cacheWrite: 100, invocations: 3 },
      { model: 'gpt-5-codex', engine: 'codex', billed: false, costUsd: 0.25, tokensIn: 400, tokensOut: 5, cacheRead: 0, cacheWrite: 0, invocations: 1 },
    ]);
    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toContain('group by model, engine, billed');
    expect(String(sql)).toContain('sum(tokens_cache_read)');
    expect(String(sql)).toContain('($1::timestamptz is null or at >= $1)');
    expect(params).toEqual([since]);

    await usageByModel(null);
    expect(vi.mocked(query).mock.calls[1]?.[1]).toEqual([null]);
  });

  it('gives every bucket of the range, billed and estimated apart, held to since itself', async () => {
    vi.mocked(query).mockResolvedValue([
      { at: '2026-11-18T00:00:00Z', billed_usd: '0', estimate_usd: '0', tokens_in: '0', tokens_out: '0', cache_read: '0', cache_write: '0' },
      { at: '2026-11-19T00:00:00Z', billed_usd: '2.5', estimate_usd: '1', tokens_in: '300', tokens_out: '7', cache_read: '200', cache_write: '50' },
    ]);

    const rows = await usageSeries(since, 'day');
    expect(rows).toEqual([
      { at: '2026-11-18T00:00:00Z', billedUsd: 0, estimateUsd: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 },
      { at: '2026-11-19T00:00:00Z', billedUsd: 2.5, estimateUsd: 1, tokensIn: 300, tokensOut: 7, cacheRead: 200, cacheWrite: 50 },
    ]);
    const sql = String(vi.mocked(query).mock.calls[0]?.[0]);
    expect(sql).toContain('generate_series');
    expect(sql).toContain("date_trunc('day'");
    expect(sql).toContain("interval '1 day'");
    expect(sql).toContain('filter (where l.billed)');
    expect(sql).toContain('filter (where not l.billed)');
    // The first bucket starts before `since`; rows before it are not the range's.
    expect(sql).toContain('($1::timestamptz is null or l.at >= $1)');
    // All starts at the ledger's first row.
    expect(sql).toContain('(select min(at) from ledger)');

    await usageSeries(null, 'hour');
    expect(String(vi.mocked(query).mock.calls[1]?.[0])).toContain("interval '1 hour'");
  });

  it('refuses a bucket that is not an hour or a day before any query runs', async () => {
    await expect(usageSeries(since, 'week' as never)).rejects.toThrow(/an hour or a day/);
    expect(query).not.toHaveBeenCalled();
  });

  it('sums each bot’s billed and estimated cost apart since a moment', async () => {
    vi.mocked(query).mockResolvedValue([{ bot: 'builder', billed_usd: '3', estimate_usd: '4.5', tasks: '2' }]);

    expect(await spendByBotSince(since)).toEqual([{ bot: 'builder', billedUsd: 3, estimateUsd: 4.5, tasks: 2 }]);
    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toContain('left join ledger l on l.bot_id = b.id and ($1::timestamptz is null or l.at >= $1)');
    expect(params).toEqual([since]);
  });

  it('lists the latest rows since a moment, and the latest of all without one', async () => {
    vi.mocked(query).mockResolvedValue([]);

    await listLedger(50, since);
    await listLedger(50);
    expect(String(vi.mocked(query).mock.calls[0]?.[0])).toContain('where at >= $2');
    expect(vi.mocked(query).mock.calls[0]?.[1]).toEqual([50, since]);
    expect(String(vi.mocked(query).mock.calls[1]?.[0])).not.toContain('where');
    expect(vi.mocked(query).mock.calls[1]?.[1]).toEqual([50]);
  });
});
