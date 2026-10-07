import type { PoolClient } from 'pg';
import { query, queryOne, withTransaction } from '../client.js';
import { spendByBotInRepo, spendByProvider, spendByProviderInRepo, spendForBot, spendForRepo, monthSpend } from './costs.js';

/**
 * A spending cap, set in Settings.
 *
 * `scope` is `global` or `repo:<id>`. `kind` is `month_total`, `task`,
 * `month_bot:<botId>` or `month_provider:<anthropic|openai|xai>`. A missing
 * row and a null amount are the same: no cap of that kind. A repository with
 * no row uses the global cap.
 *
 * `month_bot` is the bot row. The kind carries the bot's id, so two bots that
 * share one GitHub login each have their own limit.
 */

export const GLOBAL_SCOPE = 'global';

export const SPENDING_PROVIDERS = ['anthropic', 'openai', 'xai'] as const;
export type SpendingProvider = (typeof SPENDING_PROVIDERS)[number];

/** The ledger stores the engine. The limit is the provider that engine calls. */
const PROVIDER_OF_ENGINE: Record<string, SpendingProvider | undefined> = {
  claude: 'anthropic',
  codex: 'openai',
  grok: 'xai',
};

export interface SpendingLimitRow {
  scope: string;
  kind: string;
  amountUsd: number | null;
}

export function repoScope(repoId: string): string {
  return `repo:${repoId}`;
}

export function repoIdOf(scope: string): string | null {
  return scope.startsWith('repo:') ? scope.slice('repo:'.length) : null;
}

/** The bot row, not the GitHub account the bot signs in as. */
export function botKind(botId: string): string {
  return `month_bot:${botId}`;
}

export function providerKind(provider: string): string {
  return `month_provider:${provider}`;
}

export function providerOfEngine(engine: string): SpendingProvider | null {
  return PROVIDER_OF_ENGINE[engine] ?? null;
}

export function isProvider(value: string): value is SpendingProvider {
  return (SPENDING_PROVIDERS as readonly string[]).includes(value);
}

function cents(amount: number): number {
  return Math.round(amount * 100);
}

/** Whole dollars without a trailing `.00`, so a message can say `$200`. */
export function dollars(amount: number): string {
  const rounded = cents(amount) / 100;
  return Number.isInteger(rounded) ? `$${rounded}` : `$${rounded.toFixed(2)}`;
}

function reached(spent: number, cap: number | null): boolean {
  return cap != null && cents(spent) >= cents(cap);
}

interface LimitRow {
  scope: string;
  kind: string;
  amount_usd: string | null;
}

function toLimit(row: LimitRow): SpendingLimitRow {
  return { scope: row.scope, kind: row.kind, amountUsd: row.amount_usd == null ? null : Number(row.amount_usd) };
}

export async function listLimits(): Promise<SpendingLimitRow[]> {
  const rows = await query<LimitRow>(
    'select scope, kind, amount_usd::text as amount_usd from spending_limits order by scope, kind',
  );
  return rows.map(toLimit);
}

export async function amountOf(scope: string, kind: string): Promise<number | null> {
  const row = await queryOne<{ amount_usd: string | null }>(
    'select amount_usd::text as amount_usd from spending_limits where scope = $1 and kind = $2',
    [scope, kind],
  );
  return row?.amount_usd == null ? null : Number(row.amount_usd);
}

/**
 * Writes one cap, or clears it.
 *
 * A null amount deletes the row. A repository with no row uses the global
 * cap, and a global bot or provider with no row has no cap. The monthly
 * total and the per-task cap are not cleared: the caller refuses that.
 */
export async function setLimit(scope: string, kind: string, amountUsd: number | null): Promise<void> {
  if (amountUsd == null) {
    await query('delete from spending_limits where scope = $1 and kind = $2', [scope, kind]);
    return;
  }
  await query(
    `insert into spending_limits (scope, kind, amount_usd) values ($1, $2, $3)
     on conflict (scope, kind) do update set amount_usd = excluded.amount_usd, updated_at = now()`,
    [scope, kind, amountUsd],
  );
}

/**
 * Copies the file's two global amounts in only when those rows are absent.
 *
 * A later start runs the same insert. `on conflict do nothing` is what keeps
 * a cap somebody changed in Settings: the file is the seed, not the source
 * of truth after the first start. Returns whether either row was new.
 */
export async function seedGlobal(monthlyCapUsd: number, perTaskCapUsd: number): Promise<boolean> {
  const rows = await query<{ kind: string }>(
    `insert into spending_limits (scope, kind, amount_usd)
     values ('global', 'month_total', $1), ('global', 'task', $2)
     on conflict (scope, kind) do nothing
     returning kind`,
    [monthlyCapUsd, perTaskCapUsd],
  );
  return rows.length > 0;
}

/**
 * What one new task may spend: the lower of the global per-task cap and the
 * repository's, when the repository has one. The file's amount is the
 * fallback for a start that has not seeded yet.
 */
export async function effectiveTaskCap(repoId: string | null, fallback: number): Promise<number> {
  const global = (await amountOf(GLOBAL_SCOPE, 'task')) ?? fallback;
  if (!repoId) return global;
  const repo = await amountOf(repoScope(repoId), 'task');
  if (repo == null) return global;
  return Math.min(global, repo);
}

export interface RefusalFacts {
  repoLabel: string;
  botName: string;
  provider: SpendingProvider | null;
  spent: {
    month: number;
    repoMonth: number;
    bot: number;
    botInRepo: number;
    provider: number;
    providerInRepo: number;
  };
  caps: {
    month: number | null;
    repoMonth: number | null;
    bot: number | null;
    botInRepo: number | null;
    provider: number | null;
    providerInRepo: number | null;
  };
}

/**
 * The first cap this lease would cross, in the words the refusal uses.
 *
 * Monthly caps stop a new lease. They do not stop a task that is already
 * running: that one finishes up to its own per-task cap.
 */
export function refusalReason(facts: RefusalFacts): string | null {
  const { spent, caps, repoLabel, botName, provider } = facts;
  if (reached(spent.month, caps.month)) {
    return `this month's spend is ${dollars(spent.month)} of the ${dollars(caps.month ?? 0)} monthly cap`;
  }
  if (reached(spent.repoMonth, caps.repoMonth)) {
    return `${repoLabel} has spent ${dollars(spent.repoMonth)} of its ${dollars(caps.repoMonth ?? 0)} this month`;
  }
  if (reached(spent.bot, caps.bot)) {
    return `${botName} has spent ${dollars(spent.bot)} of its ${dollars(caps.bot ?? 0)} this month`;
  }
  if (reached(spent.botInRepo, caps.botInRepo)) {
    return `${botName} has spent ${dollars(spent.botInRepo)} of its ${dollars(caps.botInRepo ?? 0)} this month in ${repoLabel}`;
  }
  if (provider && reached(spent.provider, caps.provider)) {
    return `spend on ${provider} is ${dollars(spent.provider)} of its ${dollars(caps.provider ?? 0)} monthly cap`;
  }
  if (provider && reached(spent.providerInRepo, caps.providerInRepo)) {
    return `spend on ${provider} in ${repoLabel} is ${dollars(spent.providerInRepo)} of its ${dollars(caps.providerInRepo ?? 0)} monthly cap`;
  }
  return null;
}

/** What `config/costs.yaml` says a reached cap does. Only `stopLeasing` is read here. */
export interface OnCap {
  stopLeasing: boolean;
}

export interface LeaseSpendInput {
  /** The file's monthly total, used only while the global row has not been seeded yet. */
  monthlyCapUsd: number;
  /**
   * `stopLeasing: false` lets work start past the global month total. It is
   * the file's promise (`config/costs.yaml`), which the dispatcher's budget
   * check kept and these checks did not: they refused at the global total
   * whatever the file said. A repository, bot or provider cap still refuses,
   * because a person set that one in Settings for that purpose alone.
   */
  onCap: OnCap;
  period: string;
  /** Absent for a console request that has no repository yet. The global month, bot and provider caps still apply. */
  repoId: string | null;
  repoLabel: string;
  botId: string;
  botName: string;
  engine: string;
}

/**
 * Whether this bot may be leased new work in this repository. Null when it may.
 *
 * Read on every lease and every task start, so it only reads. It used to run
 * `seedGlobal`'s insert first, a write on every call; the bridge seeds when
 * it starts and whenever Settings is read or saved, and until it has, the
 * file's monthly total stands in for the missing row. The global total
 * cannot be cleared (Settings refuses a blank one), so a missing row means
 * not seeded yet, never "no cap".
 */
export async function refusal(input: LeaseSpendInput): Promise<string | null> {
  const provider = providerOfEngine(input.engine);
  // A request with no repository yet still has a global month, a bot and a
  // provider. The repository's own caps are read only when there is one.
  const scope = input.repoId ? repoScope(input.repoId) : null;
  const [savedMonth, repoMonth, bot, botInRepo, providerCap, providerInRepo, monthSpent, repoSpent, botSpent, botRepoSpent, providerSpend, providerRepoSpend] =
    await Promise.all([
      input.onCap.stopLeasing ? amountOf(GLOBAL_SCOPE, 'month_total') : Promise.resolve(null),
      scope ? amountOf(scope, 'month_total') : Promise.resolve(null),
      amountOf(GLOBAL_SCOPE, botKind(input.botId)),
      scope ? amountOf(scope, botKind(input.botId)) : Promise.resolve(null),
      provider ? amountOf(GLOBAL_SCOPE, providerKind(provider)) : Promise.resolve(null),
      provider && scope ? amountOf(scope, providerKind(provider)) : Promise.resolve(null),
      monthSpend(input.period),
      input.repoId ? spendForRepo(input.period, input.repoId) : Promise.resolve(0),
      spendForBot(input.period, input.botId),
      input.repoId
        ? spendByBotInRepo(input.period, input.repoId).then((rows) => rows.find((row) => row.botId === input.botId)?.costUsd ?? 0)
        : Promise.resolve(0),
      provider ? spendByProvider(input.period).then((rows) => rows.find((row) => row.provider === provider)?.costUsd ?? 0) : Promise.resolve(0),
      provider && input.repoId
        ? spendByProviderInRepo(input.period, input.repoId).then((rows) => rows.find((row) => row.provider === provider)?.costUsd ?? 0)
        : Promise.resolve(0),
    ]);
  const month = input.onCap.stopLeasing ? (savedMonth ?? input.monthlyCapUsd) : null;

  return refusalReason({
    repoLabel: input.repoLabel,
    botName: input.botName,
    provider,
    spent: {
      month: monthSpent,
      repoMonth: repoSpent,
      bot: botSpent,
      botInRepo: botRepoSpent,
      provider: providerSpend,
      providerInRepo: providerRepoSpend,
    },
    caps: {
      month,
      repoMonth,
      bot,
      botInRepo,
      provider: providerCap,
      providerInRepo,
    },
  });
}

/** One row a save writes, with what it held before, for the audit entry. */
export interface LimitWrite {
  scope: string;
  kind: string;
  /** Null clears the row. */
  amountUsd: number | null;
  old: number | null;
}

/** The advisory lock every save of the limits takes, so two saves are one after the other. */
export const SAVE_LOCK = 'spending-limits:save';

/**
 * Saves limits as one change: the seed, the read, every row and every audit
 * entry in one transaction, under an advisory lock.
 *
 * Written row by row, two saves at once each checked a repository cap against
 * the global one it had read, and each wrote its half: one lowered the global
 * total while the other raised the repository's, and a repository cap above
 * the global one was stored. A save that failed half-way left some rows
 * written and their audit entries missing. Now `plan` sees the rows as they
 * are once the lock is held, and what it returns is written or nothing is;
 * a `plan` that throws writes nothing.
 */
export async function saveLimits<T>(input: {
  seed: { monthlyCapUsd: number; perTaskCapUsd: number };
  actor: string;
  plan: (current: SpendingLimitRow[]) => { writes: LimitWrite[]; result: T };
}): Promise<T> {
  return withTransaction(async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [SAVE_LOCK]);
    await client.query(
      `insert into spending_limits (scope, kind, amount_usd)
       values ('global', 'month_total', $1), ('global', 'task', $2)
       on conflict (scope, kind) do nothing`,
      [input.seed.monthlyCapUsd, input.seed.perTaskCapUsd],
    );
    const rows = await client.query<LimitRow>(
      'select scope, kind, amount_usd::text as amount_usd from spending_limits order by scope, kind',
    );
    const { writes, result } = input.plan(rows.rows.map(toLimit));
    for (const write of writes) {
      await writeLimit(client, write.scope, write.kind, write.amountUsd);
      await client.query('insert into audit (actor, action, target, payload) values ($1, $2, $3, $4)', [
        input.actor,
        'spending.limit_changed',
        `${write.scope} ${write.kind}`,
        JSON.stringify({ scope: write.scope, kind: write.kind, old: write.old, new: write.amountUsd }),
      ]);
    }
    return result;
  });
}

async function writeLimit(client: PoolClient, scope: string, kind: string, amountUsd: number | null): Promise<void> {
  if (amountUsd == null) {
    await client.query('delete from spending_limits where scope = $1 and kind = $2', [scope, kind]);
    return;
  }
  await client.query(
    `insert into spending_limits (scope, kind, amount_usd) values ($1, $2, $3)
     on conflict (scope, kind) do update set amount_usd = excluded.amount_usd, updated_at = now()`,
    [scope, kind, amountUsd],
  );
}

/** The audit action that lets one revert start past a monthly cap. */
export const REVERT_AUTHORIZED = 'spending.revert_authorized';

/** The audit action that gives a commit's authorisation to a revert task that could not start yet. */
export const REVERT_HELD = 'spending.revert_held';

/** The audit action that gives back an authorisation no revert task took up. */
export const REVERT_RELEASED = 'spending.revert_released';

/** The audit action that spends a held authorisation on the retry of the task it was held for. */
export const REVERT_SPENT = 'spending.revert_spent';

const REVERT_ACTIONS = [REVERT_AUTHORIZED, REVERT_HELD, REVERT_RELEASED, REVERT_SPENT];

/**
 * Authorises one revert of this commit to start past a monthly cap, and says
 * whether this call was the one that did.
 *
 * A red smoke on testing asks for a revert, and a revert is not held by a
 * monthly cap (`TaskService.open`, `bypassCap`). But a smoke can be red
 * again for the same commit — `gh run rerun`, which any seat may run — and
 * each one asked for another revert past the cap, with nothing counting
 * them. The authorisation is an audit row keyed by the revert's subject
 * (`<repo>@<sha>`), written at most once: the check and the insert run in
 * one transaction under an advisory lock on that subject, so two deliveries
 * at once cannot both be first. Every later ask for the same commit is held
 * by the cap like any other work.
 *
 * The rows are appended, never changed, and the newest of them for the
 * subject is where the authorisation stands: authorised or held, it is
 * taken; released (`releaseRevert`), the next red smoke may have it again.
 */
export async function authorizeRevert(subjectRef: string, detail: Record<string, unknown>): Promise<boolean> {
  return withRevertLock(subjectRef, async (client) => {
    const latest = await latestRevertRow(client, subjectRef);
    if (latest && latest.action !== REVERT_RELEASED) return false;
    await writeRevertRow(client, REVERT_AUTHORIZED, subjectRef, detail);
    return true;
  });
}

/**
 * Gives back a commit's authorisation when no revert task came of it, and
 * says whether there was one to give back.
 *
 * The authorisation is taken before the task opens, and an open can fail
 * with nothing recorded — the deploy bot busy with something else. Kept,
 * the commit's one start past a cap was spent on a revert that never
 * existed, and the next red smoke of it was held by the cap.
 */
export async function releaseRevert(subjectRef: string, detail: Record<string, unknown>): Promise<boolean> {
  return withRevertLock(subjectRef, async (client) => {
    const latest = await latestRevertRow(client, subjectRef);
    if (latest?.action !== REVERT_AUTHORIZED) return false;
    await writeRevertRow(client, REVERT_RELEASED, subjectRef, detail);
    return true;
  });
}

/**
 * Gives a commit's authorisation to the revert task that was recorded
 * without starting — a prerequisite missing — and says whether it did.
 *
 * Nothing sweeps for a revert: the recovery's automatic retry of that task
 * is what starts it once the prerequisite passes, and without the
 * authorisation that retry was held by the cap, and a broken testing deploy
 * stayed live until somebody pressed Try again (`spendHeldRevert`).
 *
 * Without `from`, only a fresh authorisation is held. With it, only the one
 * just spent on retrying `from` (`spendHeldRevert`), held again for `from`
 * when that retry was refused before anything was recorded: the recovery
 * comes back for `from`. A hold is never moved to another task.
 */
export async function holdRevert(subjectRef: string, taskId: string, from?: string): Promise<boolean> {
  return withRevertLock(subjectRef, async (client) => {
    const latest = await latestRevertRow(client, subjectRef);
    const holdable =
      from === undefined
        ? latest?.action === REVERT_AUTHORIZED
        : from === taskId && latest?.action === REVERT_SPENT && latest.payload?.taskId === from;
    if (!holdable) return false;
    await writeRevertRow(client, REVERT_HELD, subjectRef, { taskId });
    return true;
  });
}

/**
 * Spends the authorisation held for this task (`holdRevert`), and says
 * whether there was one to spend: the recovery's retry of it starts past
 * the cap once, and never again. Under the commit's lock, so two retries at
 * once cannot both spend it.
 */
export async function spendHeldRevert(subjectRef: string, taskId: string): Promise<boolean> {
  return withRevertLock(subjectRef, async (client) => {
    const latest = await latestRevertRow(client, subjectRef);
    if (latest?.action !== REVERT_HELD || latest.payload?.taskId !== taskId) return false;
    await writeRevertRow(client, REVERT_SPENT, subjectRef, { taskId });
    return true;
  });
}

async function withRevertLock<T>(subjectRef: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTransaction(async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`${REVERT_AUTHORIZED}:${subjectRef}`]);
    return fn(client);
  });
}

async function latestRevertRow(
  client: PoolClient,
  subjectRef: string,
): Promise<{ action: string; payload: { taskId?: unknown } | null } | null> {
  const found = await client.query<{ action: string; payload: { taskId?: unknown } | null }>(
    'select action, payload from audit where action = any($1) and target = $2 order by id desc limit 1',
    [REVERT_ACTIONS, subjectRef],
  );
  return found.rows[0] ?? null;
}

async function writeRevertRow(client: PoolClient, action: string, subjectRef: string, detail: Record<string, unknown>): Promise<void> {
  await client.query('insert into audit (actor, action, target, payload) values ($1, $2, $3, $4)', [
    'bridge',
    action,
    subjectRef,
    JSON.stringify(detail),
  ]);
}
