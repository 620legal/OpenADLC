import { bots, costs, repos, spendingLimits } from '@fleetadlc/db';
import type { CostsConfig } from '@fleetadlc/shared';

/**
 * Spending limits, read and written from Settings.
 *
 * Any user of the console may read them; saving them (PATCH or PUT) is an
 * admin's (`roles.ts`).
 */

const PROVIDERS = spendingLimits.SPENDING_PROVIDERS;

export interface LimitFigure {
  amountUsd: number | null;
  /** Null on a per-task cap: that cap is not a month's spend. */
  spentUsd: number | null;
  /** On a repository figure, the global cap a blank field uses. */
  globalUsd?: number | null;
}

export interface BotFigure extends LimitFigure {
  botId: string;
  name: string;
}

export interface ProviderFigure extends LimitFigure {
  provider: (typeof PROVIDERS)[number];
}

export interface ScopeFigures {
  monthTotal: LimitFigure;
  task: LimitFigure;
  bots: BotFigure[];
  providers: ProviderFigure[];
}

export interface SpendingView {
  period: string;
  global: ScopeFigures;
  repos: (ScopeFigures & { repoId: string; name: string; fullName: string })[];
}

export interface SpendingChange {
  scope: string;
  kind: string;
  amountUsd: number | null;
}

export interface SpendingUpdate {
  limits: SpendingView;
  lowered: { repo: string; kind: string; from: number; to: number }[];
  leasingStopped: boolean;
  notice: string | null;
}

/** A repository limit above the global one of the same kind. The route answers 400. */
export class SpendingLimitRejected extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'SpendingLimitRejected';
  }
}

const KIND = /^(month_total|task|month_bot:.+|month_provider:(anthropic|openai|xai))$/;

function key(scope: string, kind: string): string {
  return `${scope}\0${kind}`;
}

function aboveGlobal(globalUsd: number): string {
  return `can't be more than the global ${spendingLimits.dollars(globalUsd)}`;
}

function figure(amountUsd: number | null, spentUsd: number | null, globalUsd?: number | null): LimitFigure {
  return globalUsd === undefined ? { amountUsd, spentUsd } : { amountUsd, spentUsd, globalUsd };
}

export async function spendingView(costsConfig: CostsConfig): Promise<SpendingView> {
  await spendingLimits.seedGlobal(costsConfig.monthlyCapUsd, costsConfig.perTaskCapUsd);
  const period = costs.currentPeriod();
  const [saved, crew, repoList, monthSpent, byProvider] = await Promise.all([
    spendingLimits.listLimits(),
    bots.listBots(),
    repos.listRepos(),
    costs.monthSpend(period),
    costs.spendByProvider(period),
  ]);
  const amounts = new Map(saved.map((row) => [key(row.scope, row.kind), row.amountUsd]));
  const read = (scope: string, kind: string): number | null => {
    const found = amounts.get(key(scope, kind));
    return found === undefined ? null : found;
  };

  const botSpend = new Map(
    await Promise.all(crew.map(async (bot) => [bot.id, await costs.spendForBot(period, bot.id)] as const)),
  );
  const providerSpend = new Map(byProvider.map((row) => [row.provider, row.costUsd]));

  const botsOf = (scope: string, spendOf: (botId: string) => number, global: boolean): BotFigure[] =>
    crew.map((bot) => ({
      botId: bot.id,
      name: bot.name,
      ...figure(
        read(scope, spendingLimits.botKind(bot.id)),
        spendOf(bot.id),
        global ? undefined : read(spendingLimits.GLOBAL_SCOPE, spendingLimits.botKind(bot.id)),
      ),
    }));

  const providersOf = (scope: string, spendOf: (provider: string) => number, global: boolean): ProviderFigure[] =>
    PROVIDERS.map((provider) => ({
      provider,
      ...figure(
        read(scope, spendingLimits.providerKind(provider)),
        spendOf(provider),
        global ? undefined : read(spendingLimits.GLOBAL_SCOPE, spendingLimits.providerKind(provider)),
      ),
    }));

  const global: ScopeFigures = {
    monthTotal: figure(read(spendingLimits.GLOBAL_SCOPE, 'month_total') ?? costsConfig.monthlyCapUsd, monthSpent),
    task: figure(read(spendingLimits.GLOBAL_SCOPE, 'task') ?? costsConfig.perTaskCapUsd, null),
    bots: botsOf(spendingLimits.GLOBAL_SCOPE, (id) => botSpend.get(id) ?? 0, true),
    providers: providersOf(spendingLimits.GLOBAL_SCOPE, (provider) => providerSpend.get(provider) ?? 0, true),
  };

  const reposView = await Promise.all(
    repoList.map(async (repo) => {
      const scope = spendingLimits.repoScope(repo.id);
      const [spent, byBot, byProviderInRepo] = await Promise.all([
        costs.spendForRepo(period, repo.id),
        costs.spendByBotInRepo(period, repo.id),
        costs.spendByProviderInRepo(period, repo.id),
      ]);
      const botInRepo = new Map(byBot.map((row) => [row.botId, row.costUsd]));
      const providerInRepo = new Map(byProviderInRepo.map((row) => [row.provider, row.costUsd]));
      return {
        repoId: repo.id,
        name: repo.name,
        fullName: repo.fullName,
        monthTotal: figure(read(scope, 'month_total'), spent, global.monthTotal.amountUsd),
        task: figure(read(scope, 'task'), null, global.task.amountUsd),
        bots: botsOf(scope, (id) => botInRepo.get(id) ?? 0, false),
        providers: providersOf(scope, (provider) => providerInRepo.get(provider) ?? 0, false),
      };
    }),
  );

  return { period, global, repos: reposView };
}

interface NormalChange {
  scope: string;
  kind: string;
  amountUsd: number | null;
}

function parseAmount(scope: string, kind: string, value: unknown): number | null {
  if (value == null) {
    if (scope === spendingLimits.GLOBAL_SCOPE && (kind === 'month_total' || kind === 'task')) {
      throw new SpendingLimitRejected('the monthly total and the per-task cap need an amount');
    }
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new SpendingLimitRejected('a limit is an amount in dollars, or blank for none');
  }
  const rounded = Math.round(value * 100) / 100;
  // Checked after rounding: $0.004 is more than nothing, but is saved as $0,
  // a cap reached at any spend, which stopped the work it was meant to limit.
  if (rounded <= 0) throw new SpendingLimitRejected('a limit is at least $0.01, or blank for none');
  if (rounded > 9_999_999_999.99) throw new SpendingLimitRejected('that amount is too large');
  return rounded;
}

/**
 * Saves the changes, pulls a repository cap down when a global cap is lowered
 * beneath it, and audits every write.
 *
 * What is checked against what is saved runs inside `saveLimits`: one
 * transaction under an advisory lock, reading the rows once the lock is held.
 * Two saves at once used to check against what each had read before either
 * wrote, and could together store a repository cap above the global one.
 */
export async function applySpendingLimits(input: {
  costs: CostsConfig;
  actor: string;
  changes: unknown;
}): Promise<SpendingUpdate> {
  // The body is the console's, but a script can send anything: a `changes`
  // that is not a list was read as no changes, and answered 200 having saved
  // nothing.
  if (!Array.isArray(input.changes)) throw new SpendingLimitRejected('changes is a list of limits');
  const changes = input.changes as SpendingChange[];
  const [crew, repoList] = await Promise.all([bots.listBots(), repos.listRepos()]);
  const botIds = new Set(crew.map((bot) => bot.id));
  const repoById = new Map(repoList.map((repo) => [repo.id, repo]));

  const folded = new Map<string, NormalChange>();
  for (const change of changes) {
    if (!change || (change.scope !== spendingLimits.GLOBAL_SCOPE && !change.scope?.startsWith('repo:'))) {
      throw new SpendingLimitRejected('a limit is global or for one repository');
    }
    if (!change.kind || !KIND.test(change.kind)) throw new SpendingLimitRejected(`unknown limit ${change.kind ?? ''}`);
    const repoId = spendingLimits.repoIdOf(change.scope);
    if (repoId && !repoById.has(repoId)) throw new SpendingLimitRejected('unknown repository');
    const botId = change.kind.startsWith('month_bot:') ? change.kind.slice('month_bot:'.length) : null;
    if (botId && !botIds.has(botId)) throw new SpendingLimitRejected('unknown bot');
    const amountUsd = parseAmount(change.scope, change.kind, change.amountUsd);
    folded.set(key(change.scope, change.kind), { scope: change.scope, kind: change.kind, amountUsd });
  }

  const repoName = (scope: string): string => {
    const id = spendingLimits.repoIdOf(scope);
    return (id && repoById.get(id)?.fullName) || scope;
  };

  const { current, next, lowered } = await spendingLimits.saveLimits({
    seed: { monthlyCapUsd: input.costs.monthlyCapUsd, perTaskCapUsd: input.costs.perTaskCapUsd },
    actor: input.actor,
    plan: (saved) => {
      const current = new Map(saved.map((row) => [key(row.scope, row.kind), row.amountUsd]));
      const next = new Map(current);
      for (const change of folded.values()) {
        if (change.amountUsd == null) next.delete(key(change.scope, change.kind));
        else next.set(key(change.scope, change.kind), change.amountUsd);
      }

      for (const change of folded.values()) {
        if (!change.scope.startsWith('repo:') || change.amountUsd == null) continue;
        const global = next.get(key(spendingLimits.GLOBAL_SCOPE, change.kind)) ?? null;
        if (global != null && change.amountUsd > global) throw new SpendingLimitRejected(aboveGlobal(global));
      }

      const writes: spendingLimits.LimitWrite[] = [];
      for (const change of folded.values()) {
        const before = current.get(key(change.scope, change.kind)) ?? null;
        if (before === change.amountUsd) continue;
        writes.push({ scope: change.scope, kind: change.kind, amountUsd: change.amountUsd, old: before });
      }

      const lowered: SpendingUpdate['lowered'] = [];
      for (const [id, amount] of [...next]) {
        const [scope, kind] = id.split('\0');
        if (!scope?.startsWith('repo:') || !kind || amount == null) continue;
        const global = next.get(key(spendingLimits.GLOBAL_SCOPE, kind)) ?? null;
        if (global == null || amount <= global) continue;
        lowered.push({ repo: repoName(scope), kind, from: amount, to: global });
        next.set(id, global);
        writes.push({ scope, kind, amountUsd: global, old: amount });
      }
      return { writes, result: { current, next, lowered } };
    },
  });

  const monthBefore = current.get(key(spendingLimits.GLOBAL_SCOPE, 'month_total')) ?? null;
  const monthAfter = next.get(key(spendingLimits.GLOBAL_SCOPE, 'month_total')) ?? null;
  const monthChanged = monthBefore !== monthAfter && monthAfter != null;
  let leasingStopped = false;
  let spent = 0;
  if (monthChanged) {
    const budget = await costs.ensureBudget(costs.currentPeriod(), monthAfter, input.costs.warningAt);
    spent = budget.spentUsd;
    leasingStopped = budget.state === 'stopped' && input.costs.onCap.stopLeasing;
  }

  const names = [...new Set(lowered.map((row) => row.repo))];
  const parts: string[] = [];
  if (names.length > 0) parts.push(`Lowered ${names.join(', ')} to match.`);
  if (leasingStopped) parts.push(`Month-to-date spend is $${spent.toFixed(2)} of $${(monthAfter ?? 0).toFixed(2)}, so no new work is leased.`);

  return {
    limits: await spendingView(input.costs),
    lowered,
    leasingStopped,
    notice: parts.length > 0 ? parts.join(' ') : null,
  };
}
