import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('./costs.js', () => ({
  monthSpend: vi.fn(async () => 0),
  spendForRepo: vi.fn(async () => 0),
  spendForBot: vi.fn(async () => 0),
  spendByBotInRepo: vi.fn(async () => []),
  spendByProvider: vi.fn(async () => []),
  spendByProviderInRepo: vi.fn(async () => []),
}));

import { query, queryOne, withTransaction } from '../client.js';
import { monthSpend, spendByBotInRepo, spendByProvider, spendByProviderInRepo, spendForBot, spendForRepo } from './costs.js';
import {
  REVERT_AUTHORIZED,
  REVERT_HELD,
  REVERT_RELEASED,
  REVERT_SPENT,
  SAVE_LOCK,
  authorizeRevert,
  holdRevert,
  releaseRevert,
  spendHeldRevert,
  botKind, effectiveTaskCap, refusal, refusalReason, saveLimits, seedGlobal } from './spending-limits.js';

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(queryOne).mockReset();
});

const NONE = {
  month: 0,
  repoMonth: 0,
  bot: 0,
  botInRepo: 0,
  provider: 0,
  providerInRepo: 0,
};

describe('seeding the global caps from the file', () => {
  it('inserts them only when the rows are absent, and does not update a row that is already there', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ kind: 'month_total' }, { kind: 'task' }]);

    await expect(seedGlobal(1500, 15)).resolves.toBe(true);

    const sql = String(vi.mocked(query).mock.calls[0]?.[0]);
    expect(sql).toContain('on conflict (scope, kind) do nothing');
    expect(sql).not.toContain('do update');
    expect(vi.mocked(query).mock.calls[0]?.[1]).toEqual([1500, 15]);
  });

  it('reports that a later start wrote nothing', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);

    await expect(seedGlobal(9999, 1)).resolves.toBe(false);
  });
});

describe('a task cap', () => {
  it('is the lower of the global cap and the repository cap', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ amount_usd: '15' }).mockResolvedValueOnce({ amount_usd: '5' });

    await expect(effectiveTaskCap('repo-1', 15)).resolves.toBe(5);
  });

  it('is the global cap when the repository has not set its own', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ amount_usd: '15' }).mockResolvedValueOnce(null);

    await expect(effectiveTaskCap('repo-1', 99)).resolves.toBe(15);
  });
});

describe('a lease the caps refuse', () => {
  const base = {
    repoLabel: 'exampleco/api',
    botName: 'builder',
    provider: 'openai' as const,
    spent: NONE,
    caps: {
      month: 1500,
      repoMonth: null,
      bot: null,
      botInRepo: null,
      provider: null,
      providerInRepo: null,
    },
  };

  it('names the global month', () => {
    expect(refusalReason({ ...base, spent: { ...NONE, month: 1500 } })).toBe(
      "this month's spend is $1500 of the $1500 monthly cap",
    );
  });

  it('names the repository month', () => {
    expect(refusalReason({ ...base, spent: { ...NONE, repoMonth: 80 }, caps: { ...base.caps, repoMonth: 80 } })).toBe(
      'exampleco/api has spent $80 of its $80 this month',
    );
  });

  it('names the bot, and a second bot that shares the login is a different cap', () => {
    expect(botKind('bot-1')).toBe('month_bot:bot-1');
    expect(botKind('bot-2')).not.toBe(botKind('bot-1'));
    expect(refusalReason({ ...base, botName: 'builder-2', spent: { ...NONE, bot: 5 }, caps: { ...base.caps, bot: 5 } })).toBe(
      'builder-2 has spent $5 of its $5 this month',
    );
    expect(refusalReason({ ...base, botName: 'builder', spent: { ...NONE, bot: 1 }, caps: { ...base.caps, bot: 5 } })).toBeNull();
  });

  it("names the bot's cap inside the repository", () => {
    expect(
      refusalReason({ ...base, spent: { ...NONE, botInRepo: 4 }, caps: { ...base.caps, botInRepo: 4 } }),
    ).toBe('builder has spent $4 of its $4 this month in exampleco/api');
  });

  it('names the provider', () => {
    expect(
      refusalReason({ ...base, spent: { ...NONE, provider: 10 }, caps: { ...base.caps, provider: 10 } }),
    ).toBe('spend on openai is $10 of its $10 monthly cap');
  });

  it('names the provider inside the repository', () => {
    expect(
      refusalReason({
        ...base,
        spent: { ...NONE, providerInRepo: 200 },
        caps: { ...base.caps, providerInRepo: 200 },
      }),
    ).toBe('spend on openai in exampleco/api is $200 of its $200 monthly cap');
  });

  it('allows the lease when every cap is still above the spend', () => {
    expect(refusalReason({ ...base, spent: { ...NONE, month: 10, repoMonth: 10 }, caps: { ...base.caps, repoMonth: 80 } })).toBeNull();
  });
});

describe('refusal reads the spend', () => {
  const input = {
    monthlyCapUsd: 1500,
    onCap: { stopLeasing: true },
    period: '2026-09',
    repoId: 'repo-api',
    repoLabel: 'exampleco/api',
    botId: 'bot-1',
    botName: 'builder',
    engine: 'codex',
  };

  function caps(repoMonth: string | null) {
    vi.mocked(queryOne)
      .mockResolvedValueOnce({ amount_usd: '1500' })
      .mockResolvedValueOnce(repoMonth == null ? null : { amount_usd: repoMonth })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
  }

  it('refuses once the repository month is spent, from the queries rather than from facts handed in', async () => {
    caps('200');
    vi.mocked(spendForRepo).mockResolvedValueOnce(200);

    await expect(refusal(input)).resolves.toBe('exampleco/api has spent $200 of its $200 this month');

    expect(monthSpend).toHaveBeenCalledWith('2026-09');
    expect(spendForRepo).toHaveBeenCalledWith('2026-09', 'repo-api');
    expect(spendForBot).toHaveBeenCalledWith('2026-09', 'bot-1');
    expect(spendByBotInRepo).toHaveBeenCalledWith('2026-09', 'repo-api');
    expect(spendByProvider).toHaveBeenCalledWith('2026-09');
    expect(spendByProviderInRepo).toHaveBeenCalledWith('2026-09', 'repo-api');
  });

  it('allows the lease when those queries are still under the cap', async () => {
    caps('200');
    vi.mocked(monthSpend).mockResolvedValueOnce(10);
    vi.mocked(spendForRepo).mockResolvedValueOnce(10);

    await expect(refusal(input)).resolves.toBeNull();
  });

  function amounts(...values: Array<string | null>) {
    for (const value of values) vi.mocked(queryOne).mockResolvedValueOnce(value == null ? null : { amount_usd: value });
  }

  it('refuses the global month from the month query', async () => {
    amounts('1500', null, null, null, null, null);
    vi.mocked(monthSpend).mockResolvedValueOnce(1500);

    await expect(refusal(input)).resolves.toBe("this month's spend is $1500 of the $1500 monthly cap");
  });

  it('refuses the bot from its own spend, not the repository’s', async () => {
    amounts(null, null, '5', null, null, null);
    vi.mocked(spendForBot).mockResolvedValueOnce(5);

    await expect(refusal(input)).resolves.toBe('builder has spent $5 of its $5 this month');
  });

  it('refuses the bot inside the repository from that query', async () => {
    amounts(null, null, null, '4', null, null);
    vi.mocked(spendByBotInRepo).mockResolvedValueOnce([{ botId: 'bot-1', costUsd: 4 }]);

    await expect(refusal(input)).resolves.toBe('builder has spent $4 of its $4 this month in exampleco/api');
  });

  it('refuses the provider from its own spend', async () => {
    amounts(null, null, null, null, '10', null);
    vi.mocked(spendByProvider).mockResolvedValueOnce([{ provider: 'openai', costUsd: 10 }]);

    await expect(refusal(input)).resolves.toBe('spend on openai is $10 of its $10 monthly cap');
  });

  it('refuses codex where openai is spent, and not claude there or codex in another repository', async () => {
    // The cap and the spend are real only for openai in repo-api. A refusal
    // that ignored the engine, or always read repo-api, would still refuse.
    vi.mocked(queryOne).mockImplementation(async (_sql: string, params?: readonly unknown[]) => {
      const [scope, kind] = params ?? [];
      return scope === 'repo:repo-api' && kind === 'month_provider:openai' ? { amount_usd: '10' } : null;
    });
    vi.mocked(spendByProviderInRepo).mockImplementation(async (_period: string, repoId: string) =>
      repoId === 'repo-api' ? [{ provider: 'openai' as const, costUsd: 10 }] : [],
    );

    try {
      await expect(refusal(input)).resolves.toBe('spend on openai in exampleco/api is $10 of its $10 monthly cap');
      await expect(refusal({ ...input, engine: 'claude' })).resolves.toBeNull();
      await expect(refusal({ ...input, repoId: 'repo-other', repoLabel: 'exampleco/other' })).resolves.toBeNull();
    } finally {
      vi.mocked(queryOne).mockReset();
      vi.mocked(spendByProviderInRepo).mockReset();
      vi.mocked(spendByProviderInRepo).mockResolvedValue([]);
    }
  });

  it('refuses a console request with no repository once the global month is spent', async () => {
    vi.mocked(spendForRepo).mockClear();
    vi.mocked(queryOne)
      .mockResolvedValueOnce({ amount_usd: '1500' })
      .mockResolvedValueOnce({ amount_usd: '5' })
      .mockResolvedValueOnce(null);
    vi.mocked(monthSpend).mockResolvedValueOnce(1500);

    await expect(refusal({ ...input, repoId: null, repoLabel: '' })).resolves.toBe(
      "this month's spend is $1500 of the $1500 monthly cap",
    );
    expect(spendForRepo).not.toHaveBeenCalled();
  });
});

describe('refusal and onCap.stopLeasing', () => {
  const input = {
    monthlyCapUsd: 1500,
    onCap: { stopLeasing: false },
    period: '2026-09',
    repoId: 'repo-api',
    repoLabel: 'exampleco/api',
    botId: 'bot-1',
    botName: 'builder',
    engine: 'claude',
  };

  function saved(rows: Record<string, string>) {
    vi.mocked(queryOne).mockImplementation(async (_sql: string, params?: readonly unknown[]) => {
      const [scope, kind] = params ?? [];
      const amount = rows[`${scope} ${kind}`];
      return amount ? { amount_usd: amount } : null;
    });
  }

  it('leases past the global month total when stopLeasing is false', async () => {
    saved({ 'global month_total': '1500' });
    vi.mocked(monthSpend).mockResolvedValueOnce(2000);

    await expect(refusal(input)).resolves.toBeNull();
  });

  it('still refuses at a repository cap when stopLeasing is false', async () => {
    saved({ 'global month_total': '1500', 'repo:repo-api month_total': '50' });
    vi.mocked(monthSpend).mockResolvedValueOnce(2000);
    vi.mocked(spendForRepo).mockResolvedValueOnce(50);

    await expect(refusal(input)).resolves.toBe('exampleco/api has spent $50 of its $50 this month');
  });

  it('refuses at the global month total when stopLeasing is true', async () => {
    saved({ 'global month_total': '1500' });
    vi.mocked(monthSpend).mockResolvedValueOnce(2000);

    await expect(refusal({ ...input, onCap: { stopLeasing: true } })).resolves.toBe(
      "this month's spend is $2000 of the $1500 monthly cap",
    );
  });

  it('writes nothing, and uses the file’s monthly total before the row is seeded', async () => {
    saved({});
    vi.mocked(monthSpend).mockResolvedValueOnce(1500);

    await expect(refusal({ ...input, onCap: { stopLeasing: true } })).resolves.toBe(
      "this month's spend is $1500 of the $1500 monthly cap",
    );
    expect(query).not.toHaveBeenCalled();
  });
});

describe('saving limits', () => {
  function transaction() {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string, _params?: readonly unknown[]) => {
        statements.push(sql);
        if (sql.startsWith('select scope, kind')) {
          return { rows: [{ scope: 'global', kind: 'month_total', amount_usd: '100' }] };
        }
        return { rows: [] };
      }),
    };
    vi.mocked(withTransaction).mockImplementation(async (fn) => fn(client as never));
    return { statements, client };
  }

  it('takes the lock, then seeds, reads, and writes each row with its audit entry in the one transaction', async () => {
    const { statements, client } = transaction();

    const result = await saveLimits({
      seed: { monthlyCapUsd: 1500, perTaskCapUsd: 15 },
      actor: 'janedoe',
      plan: (current) => {
        expect(current).toEqual([{ scope: 'global', kind: 'month_total', amountUsd: 100 }]);
        return { writes: [{ scope: 'global', kind: 'month_total', amountUsd: 50, old: 100 }], result: 'saved' };
      },
    });

    expect(result).toBe('saved');
    expect(statements[0]).toContain('pg_advisory_xact_lock');
    expect(client.query.mock.calls[0]?.[1]).toEqual([SAVE_LOCK]);
    expect(statements[1]).toContain('on conflict (scope, kind) do nothing');
    expect(statements[2]).toContain('select scope, kind');
    expect(statements[3]).toContain('insert into spending_limits');
    expect(statements[4]).toContain('insert into audit');
    expect(client.query.mock.calls[4]?.[1]).toEqual([
      'janedoe',
      'spending.limit_changed',
      'global month_total',
      JSON.stringify({ scope: 'global', kind: 'month_total', old: 100, new: 50 }),
    ]);
    expect(query).not.toHaveBeenCalled();
  });

  it('writes nothing when the plan refuses', async () => {
    const { statements } = transaction();

    await expect(
      saveLimits({
        seed: { monthlyCapUsd: 1500, perTaskCapUsd: 15 },
        actor: 'janedoe',
        plan: () => {
          throw new Error('too high');
        },
      }),
    ).rejects.toThrow('too high');
    expect(statements.some((sql) => sql.includes('insert into audit') || sql.includes('delete from'))).toBe(false);
  });
});

describe('authorising a revert past a cap', () => {
  interface Row {
    action: string;
    target: string;
    payload: Record<string, unknown>;
  }

  /** A transaction over an audit table that holds these rows, oldest first. */
  function audited(rows: Row[]) {
    const statements: { sql: string; params: readonly unknown[] }[] = [];
    const latest = (actions: readonly string[], target: string) =>
      rows.filter((row) => actions.includes(row.action) && row.target === target).slice(-1);
    const client = {
      query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
        statements.push({ sql, params });
        if (sql.startsWith('select action, payload from audit')) {
          const found = latest(params[0] as string[], String(params[1]));
          return { rows: found, rowCount: found.length };
        }
        if (sql.startsWith('insert into audit')) {
          rows.push({ action: String(params[1]), target: String(params[2]), payload: JSON.parse(String(params[3])) });
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    vi.mocked(withTransaction).mockImplementation(async (fn) => fn(client as never));
    return statements;
  }

  it('authorises the first revert of a commit, under a lock on that commit, and no later one', async () => {
    const rows: Row[] = [];
    const statements = audited(rows);

    await expect(authorizeRevert('api@deadbeef', { sha: 'deadbeef' })).resolves.toBe(true);
    await expect(authorizeRevert('api@deadbeef', { sha: 'deadbeef' })).resolves.toBe(false);
    await expect(authorizeRevert('api@feedface', { sha: 'feedface' })).resolves.toBe(true);

    expect(statements[0]?.sql).toContain('pg_advisory_xact_lock');
    expect(statements[0]?.params).toEqual([`${REVERT_AUTHORIZED}:api@deadbeef`]);
    expect(rows.map(({ action, target }) => ({ action, target }))).toEqual([
      { action: REVERT_AUTHORIZED, target: 'api@deadbeef' },
      { action: REVERT_AUTHORIZED, target: 'api@feedface' },
    ]);
  });

  it('authorises the commit again once the authorisation is given back, as nothing started with it', async () => {
    const rows: Row[] = [];
    audited(rows);

    await authorizeRevert('api@deadbeef', {});
    await expect(releaseRevert('api@deadbeef', {})).resolves.toBe(true);
    // Given back once: a second release has nothing to give.
    await expect(releaseRevert('api@deadbeef', {})).resolves.toBe(false);
    await expect(authorizeRevert('api@deadbeef', {})).resolves.toBe(true);

    expect(rows.map((row) => row.action)).toEqual([REVERT_AUTHORIZED, REVERT_RELEASED, REVERT_AUTHORIZED]);
  });

  it('holds the authorisation for a revert that could not start, which no red smoke then has, and cannot be given back', async () => {
    const rows: Row[] = [];
    audited(rows);

    await authorizeRevert('api@deadbeef', {});
    await expect(holdRevert('api@deadbeef', 'task-1')).resolves.toBe(true);

    await expect(authorizeRevert('api@deadbeef', {})).resolves.toBe(false);
    await expect(releaseRevert('api@deadbeef', {})).resolves.toBe(false);
    expect(rows.at(-1)).toMatchObject({ action: REVERT_HELD, payload: { taskId: 'task-1' } });
  });

  it('spends a hold once, on the task it is held for, and never again', async () => {
    const rows: Row[] = [];
    audited(rows);
    await authorizeRevert('api@deadbeef', {});
    await holdRevert('api@deadbeef', 'task-1');

    await expect(spendHeldRevert('api@deadbeef', 'task-other')).resolves.toBe(false);
    await expect(spendHeldRevert('api@deadbeef', 'task-1')).resolves.toBe(true);
    await expect(spendHeldRevert('api@deadbeef', 'task-1')).resolves.toBe(false);
    // Spent is taken: no red smoke of the commit has it after.
    await expect(authorizeRevert('api@deadbeef', {})).resolves.toBe(false);

    expect(rows.map((row) => row.action)).toEqual([REVERT_AUTHORIZED, REVERT_HELD, REVERT_SPENT]);
  });

  it('holds a spent authorisation again only for the task it was spent on, never for a new one', async () => {
    // The recovery claims the task its retry started and never runs it
    // again, so a hold moved there would be stranded.
    const rows: Row[] = [];
    audited(rows);
    await authorizeRevert('api@deadbeef', {});
    await holdRevert('api@deadbeef', 'task-1');
    await spendHeldRevert('api@deadbeef', 'task-1');

    await expect(holdRevert('api@deadbeef', 'task-2')).resolves.toBe(false);
    await expect(holdRevert('api@deadbeef', 'task-2', 'task-1')).resolves.toBe(false);
    await expect(holdRevert('api@deadbeef', 'task-other', 'task-other')).resolves.toBe(false);
    await expect(holdRevert('api@deadbeef', 'task-1', 'task-1')).resolves.toBe(true);

    await expect(spendHeldRevert('api@deadbeef', 'task-2')).resolves.toBe(false);
    await expect(spendHeldRevert('api@deadbeef', 'task-1')).resolves.toBe(true);
  });

  it('never moves a hold to another task', async () => {
    const rows: Row[] = [];
    audited(rows);
    await authorizeRevert('api@deadbeef', {});
    await holdRevert('api@deadbeef', 'task-1');

    await expect(holdRevert('api@deadbeef', 'task-2')).resolves.toBe(false);
    await expect(holdRevert('api@deadbeef', 'task-2', 'task-1')).resolves.toBe(false);
    await expect(spendHeldRevert('api@deadbeef', 'task-2')).resolves.toBe(false);
  });

  it('holds nothing that was never authorised, or was given back', async () => {
    const rows: Row[] = [];
    audited(rows);

    await expect(holdRevert('api@deadbeef', 'task-1')).resolves.toBe(false);
    await authorizeRevert('api@deadbeef', {});
    await releaseRevert('api@deadbeef', {});
    await expect(holdRevert('api@deadbeef', 'task-1')).resolves.toBe(false);

    expect(rows.map((row) => row.action)).not.toContain(REVERT_HELD);
  });
});
