import type { BudgetState, EngineName, LedgerEntry } from '@fleetadlc/shared';
import { query, queryOne } from '../client.js';

interface LedgerRow {
  id: string;
  task_id: string | null;
  bot_id: string;
  engine: EngineName;
  model: string;
  model_alias: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: string;
  at: Date;
}

/**
 * An alias must not land in the model column. Spend is attributed to the id
 * that was called; `newest:opus` stops meaning anything the day a newer Opus
 * ships. The configured alias, when there was one, is a separate column.
 */
export class LedgerAliasError extends Error {
  constructor(model: string) {
    super(`the ledger records a resolved model id; refusing to store ${model}`);
    this.name = 'LedgerAliasError';
  }
}

export function currentPeriod(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * `column` falls in the month `param` names (`YYYY-MM`), in UTC as
 * `currentPeriod` counts it. `to_char(at, 'YYYY-MM')` read the month in the
 * session's time zone, which is local time on a Postgres the machine already
 * ran, so spend near the turn of a month went against the wrong month's cap.
 * Bounds also let the `ledger_at` index answer.
 */
function inPeriod(column: string, param = '$1'): string {
  const start = `(${param}::text || '-01')::timestamp`;
  return `${column} >= ${start} at time zone 'UTC' and ${column} < (${start} + interval '1 month') at time zone 'UTC'`;
}

/** Every engine invocation is recorded before its output is acted on. */
export async function recordUsage(input: {
  taskId: string | null;
  botId: string;
  engine: EngineName;
  /** The resolved id. An alias is refused rather than written. */
  model: string;
  /** The configured alias (`newest:opus`), or null when the bot was pinned. */
  modelAlias?: string | null;
  promptHash?: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}): Promise<void> {
  if (input.model.startsWith('newest:')) throw new LedgerAliasError(input.model);
  // The caps sum this column: a negative amount cancels real spend, and NaN
  // sorts above every number in Postgres and stops the budget for good.
  if (!Number.isFinite(input.costUsd) || input.costUsd < 0) throw new Error(`the ledger records a cost of 0 or more; refusing ${input.costUsd}`);
  for (const tokens of [input.tokensIn, input.tokensOut]) {
    if (!Number.isInteger(tokens) || tokens < 0) throw new Error(`the ledger records whole token counts of 0 or more; refusing ${tokens}`);
  }
  const alias = input.modelAlias && input.modelAlias.startsWith('newest:') ? input.modelAlias : null;

  await query(
    `insert into ledger (task_id, bot_id, engine, model, model_alias, prompt_hash, tokens_in, tokens_out, cost_usd)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      input.taskId,
      input.botId,
      input.engine,
      input.model,
      alias,
      input.promptHash ?? null,
      input.tokensIn,
      input.tokensOut,
      input.costUsd,
    ],
  );
}

export async function listLedger(limit = 200): Promise<LedgerEntry[]> {
  const rows = await query<LedgerRow>(
    `select id, task_id, bot_id, engine, model, model_alias, tokens_in, tokens_out, cost_usd, at
     from ledger order by at desc limit $1`,
    [limit],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    taskId: row.task_id,
    botId: row.bot_id,
    engine: row.engine,
    model: row.model,
    modelAlias: row.model_alias,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    costUsd: Number(row.cost_usd),
    at: row.at.toISOString(),
  }));
}

export async function taskSpend(taskId: string): Promise<number> {
  const row = await queryOne<{ total: string }>(
    'select coalesce(sum(cost_usd), 0)::text as total from ledger where task_id = $1',
    [taskId],
  );
  return Number(row?.total ?? 0);
}

export async function spendByBot(period: string): Promise<{ bot: string; costUsd: number; tasks: number }[]> {
  return (
    await query<{ bot: string; cost_usd: string; tasks: string }>(
      `select b.name as bot,
              coalesce(sum(l.cost_usd), 0)::text as cost_usd,
              count(distinct l.task_id)::text as tasks
       from bots b
       left join ledger l on l.bot_id = b.id and ${inPeriod('l.at')}
       group by b.name order by b.name`,
      [period],
    )
  ).map((row) => ({ bot: row.bot, costUsd: Number(row.cost_usd), tasks: Number(row.tasks) }));
}

const PROVIDER_OF_ENGINE = `case engine
         when 'claude' then 'anthropic'
         when 'codex' then 'openai'
         when 'grok' then 'xai'
         else engine end`;

/** Month-to-date spend, the number the global monthly cap is compared with. */
export async function monthSpend(period: string): Promise<number> {
  const row = await queryOne<{ total: string }>(
    `select coalesce(sum(cost_usd), 0)::text as total from ledger where ${inPeriod('at')}`,
    [period],
  );
  return Number(row?.total ?? 0);
}

/**
 * Month-to-date spend by provider.
 *
 * The ledger records the engine. The cap is the provider that engine calls:
 * claude is Anthropic, codex is OpenAI, grok is xAI.
 */
export async function spendByProvider(period: string): Promise<{ provider: string; costUsd: number }[]> {
  return (
    await query<{ provider: string; cost_usd: string }>(
      `select ${PROVIDER_OF_ENGINE} as provider, coalesce(sum(cost_usd), 0)::text as cost_usd
       from ledger where ${inPeriod('at')}
       group by 1 order by 1`,
      [period],
    )
  ).map((row) => ({ provider: row.provider, costUsd: Number(row.cost_usd) }));
}

/** One bot's month-to-date spend. The bot row, not the GitHub login it shares. */
export async function spendForBot(period: string, botId: string): Promise<number> {
  const row = await queryOne<{ total: string }>(
    `select coalesce(sum(cost_usd), 0)::text as total from ledger
     where bot_id = $2 and ${inPeriod('at')}`,
    [period, botId],
  );
  return Number(row?.total ?? 0);
}

/** One repository's month-to-date spend, from the tasks the ledger rows belong to. */
export async function spendForRepo(period: string, repoId: string): Promise<number> {
  const row = await queryOne<{ total: string }>(
    `select coalesce(sum(l.cost_usd), 0)::text as total
     from ledger l join tasks t on t.id = l.task_id
     where t.repo_id = $2 and ${inPeriod('l.at')}`,
    [period, repoId],
  );
  return Number(row?.total ?? 0);
}

/** Month-to-date spend by bot inside one repository. */
export async function spendByBotInRepo(
  period: string,
  repoId: string,
): Promise<{ botId: string; costUsd: number }[]> {
  return (
    await query<{ bot_id: string; cost_usd: string }>(
      `select l.bot_id, coalesce(sum(l.cost_usd), 0)::text as cost_usd
       from ledger l join tasks t on t.id = l.task_id
       where t.repo_id = $2 and ${inPeriod('l.at')}
       group by l.bot_id order by l.bot_id`,
      [period, repoId],
    )
  ).map((row) => ({ botId: row.bot_id, costUsd: Number(row.cost_usd) }));
}

/** Month-to-date spend by provider inside one repository. */
export async function spendByProviderInRepo(
  period: string,
  repoId: string,
): Promise<{ provider: string; costUsd: number }[]> {
  return (
    await query<{ provider: string; cost_usd: string }>(
      `select ${PROVIDER_OF_ENGINE.replaceAll('engine', 'l.engine')} as provider,
              coalesce(sum(l.cost_usd), 0)::text as cost_usd
       from ledger l join tasks t on t.id = l.task_id
       where t.repo_id = $2 and ${inPeriod('l.at')}
       group by 1 order by 1`,
      [period, repoId],
    )
  ).map((row) => ({ provider: row.provider, costUsd: Number(row.cost_usd) }));
}

export async function spendByRepo(period: string): Promise<{ repo: string; costUsd: number }[]> {
  return (
    await query<{ repo: string; cost_usd: string }>(
      `select coalesce(r.name, 'unassigned') as repo, coalesce(sum(l.cost_usd), 0)::text as cost_usd
       from ledger l
       left join tasks t on t.id = l.task_id
       left join repos r on r.id = t.repo_id
       where ${inPeriod('l.at')}
       group by r.name order by 2 desc`,
      [period],
    )
  ).map((row) => ({ repo: row.repo, costUsd: Number(row.cost_usd) }));
}

/**
 * Spend for each day of the period, up to today: a day with none is a row of
 * 0. Grouped over the ledger alone, a quiet day had no row, and the chart drew
 * nine days spread over a month as nine days in a row. Days are told in UTC,
 * as the month is.
 */
export async function spendByDay(period: string): Promise<{ day: string; costUsd: number }[]> {
  return (
    await query<{ day: string; cost_usd: string }>(
      `select to_char(d, 'YYYY-MM-DD') as day, coalesce(sum(l.cost_usd), 0)::text as cost_usd
       from generate_series(
         to_date($1, 'YYYY-MM')::timestamp,
         least((now() at time zone 'UTC')::date, (to_date($1, 'YYYY-MM') + interval '1 month - 1 day')::date)::timestamp,
         interval '1 day'
       ) as d
       left join ledger l on to_char(l.at at time zone 'UTC', 'YYYY-MM-DD') = to_char(d, 'YYYY-MM-DD')
       group by 1 order by 1`,
      [period],
    )
  ).map((row) => ({ day: row.day, costUsd: Number(row.cost_usd) }));
}

export async function ensureBudget(period: string, capUsd: number, warningAt: number): Promise<BudgetState> {
  // The file's amount is only the seed. Once Settings has saved a global
  // monthly cap, a later start must not copy config/costs.yaml back over it:
  // that is what this used to do on every call.
  const saved = await queryOne<{ amount_usd: string | null }>(
    `select amount_usd::text as amount_usd from spending_limits where scope = 'global' and kind = 'month_total'`,
  );
  const cap = saved?.amount_usd != null ? Number(saved.amount_usd) : capUsd;
  await query(
    `insert into budgets (period, cap_usd) values ($1,$2)
     on conflict (period) do update set cap_usd = excluded.cap_usd, updated_at = now()`,
    [period, cap],
  );
  return refreshBudget(period, warningAt);
}

/**
 * Month-to-date spend against the cap; the dispatcher reads this every run.
 *
 * A month's row is made by `ensureBudget`, which the bridge runs at start and
 * on its jobs, so from midnight UTC on the 1st until one of those ran there was
 * none, this threw, and the dispatcher leased nothing. A month with no row is
 * started here on the saved global cap, or last month's when none is saved;
 * the next `ensureBudget` sets it as it always does.
 */
export async function refreshBudget(period: string, warningAt: number): Promise<BudgetState> {
  await query(
    `with cap as (
       select coalesce(
         (select amount_usd from spending_limits where scope = 'global' and kind = 'month_total'),
         (select cap_usd from budgets where period < $1 order by period desc limit 1)) as usd
     )
     insert into budgets (period, cap_usd) select $1, usd from cap where usd is not null
     on conflict (period) do nothing`,
    [period],
  );
  const spentRow = await queryOne<{ total: string }>(
    `select coalesce(sum(cost_usd), 0)::text as total from ledger where ${inPeriod('at')}`,
    [period],
  );
  const spent = Number(spentRow?.total ?? 0);
  const row = await queryOne<{ period: string; cap_usd: string; spent_usd: string; state: BudgetState['state'] }>(
    `update budgets set
       spent_usd = $2,
       state = case
         when $2 >= cap_usd then 'stopped'
         when $2 >= cap_usd * $3 then 'warning'
         else 'ok' end,
       updated_at = now()
     where period = $1
     returning period, cap_usd, spent_usd, state`,
    [period, spent, warningAt],
  );
  if (!row) throw new Error(`budget period ${period} not initialised`);
  return {
    period: row.period,
    capUsd: Number(row.cap_usd),
    spentUsd: Number(row.spent_usd),
    state: row.state,
  };
}

export async function getBudget(period: string): Promise<BudgetState | null> {
  const row = await queryOne<{ period: string; cap_usd: string; spent_usd: string; state: BudgetState['state'] }>(
    'select period, cap_usd, spent_usd, state from budgets where period = $1',
    [period],
  );
  return row
    ? {
        period: row.period,
        capUsd: Number(row.cap_usd),
        spentUsd: Number(row.spent_usd),
        state: row.state,
      }
    : null;
}
