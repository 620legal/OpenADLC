import {
  ENGINE_PROVIDER,
  isAlias,
  modelForSession,
  modelListKey,
  ModelUnavailable,
  resolveModel,
  type AvailableModel,
  type ModelListCache,
  type ModelProvider,
} from '@fleetadlc/engines';
import type { EngineName } from '@fleetadlc/shared';

/**
 * Which model a task will call, decided when the task starts.
 *
 * The bot row holds either a pinned id or an alias. The account says which
 * credential can reach a catalogue. `resolveModel` picks the id; this module
 * is how the catalogue is obtained, and how a failure becomes the task's
 * error rather than a quieter model than the one somebody chose.
 */

export interface TaskModelBot {
  name: string;
  engine: EngineName;
  model: string;
  modelAccountId: string | null;
}

export interface TaskModelAccount {
  id: string;
  provider: ModelProvider;
  kind: 'key' | 'subscription';
}

export interface SessionModel {
  /** Resolved id. This is what the engine calls and what the ledger stores. */
  model: string;
  /** The configured alias, or null when the bot is pinned to an id. */
  modelAlias: string | null;
  /**
   * The account the model was resolved against, or null when the bot has
   * none. The session's key comes from this account and not from a second
   * read of the row, so the model and the credential are one assignment even
   * when the console changes it while the task is starting.
   */
  account: TaskModelAccount | null;
}

export interface ResolveTaskModelDeps {
  account: (id: string) => Promise<TaskModelAccount | null>;
  keyForAccount: (accountId: string) => Promise<string | null>;
  /**
   * The per-bot engine key, kept for installs that stored one before model
   * accounts existed. An alias still has to resolve against something.
   */
  keyForBot?: (botName: string) => Promise<string | null>;
  listModels: (provider: ModelProvider, key: string) => Promise<AvailableModel[]>;
  /**
   * What a subscription can call, which has no key to ask the API with —
   * `subscriptionModels` below. It caches for itself, because an xAI seat's
   * list is grok's to run and hostd's sign-in service already remembers it.
   * When this is omitted, a pinned id is trusted and an alias cannot be
   * resolved — the alternative is to send `newest:opus` to the engine and
   * then to the ledger.
   */
  subscriptionModels?: (account: TaskModelAccount, bot: TaskModelBot) => Promise<AvailableModel[]>;
  cache: ModelListCache;
  /**
   * The integration suites' scripted engines (`FLEETADLC_SCRIPTED_ENGINES`),
   * which call no model whatever the seat's engine (`engine-choice.ts`). A seat
   * there has no account, and `config/bots.yaml` sets `newest:` families, so
   * every task was refused before it started — the whole suite red.
   */
  scripted?: boolean;
}

async function listed(
  source: string,
  load: () => Promise<AvailableModel[]>,
  bot: TaskModelBot,
): Promise<AvailableModel[]> {
  try {
    return await load();
  } catch (error) {
    // An alias with no list has nothing to resolve to. A pinned id is the
    // one `resolveModel` already trusts when the catalogue is empty: a
    // provider that could not be asked must not become a provider that is
    // refused.
    if (isAlias(bot.model)) {
      const message = error instanceof Error ? error.message : 'could not list models';
      throw new ModelUnavailable(message);
    }
    console.warn(`[hostd] ${bot.name}: could not list models (${source}); using the configured id unverified`);
    return [];
  }
}

export interface SubscriptionListing {
  /** A Claude seat's token, stored as its secret the way a key is, or null. */
  tokenFor: (accountId: string) => Promise<string | null>;
  /** Anthropic's list for that token: `listProviderModels` in its OAuth mode. */
  listWithToken: (token: string) => Promise<AvailableModel[]>;
  /** What an xAI seat's CLI lists: `LoginService.models`, which remembers its own answer. */
  cliModels?: (accountId: string) => Promise<AvailableModel[]>;
  /** For the Claude seat's list, shared with the keys' so an account is one entry. */
  cache: ModelListCache;
}

/**
 * How hostd learns what a subscription can call.
 *
 * A Claude seat is asked like a key, with the token `claude setup-token`
 * printed, and its list dates every model, so `newest:opus` is the newest by
 * date. An xAI seat is asked through grok, which dates nothing and marks its
 * default, so `newest:grok` is the model grok would use unasked. An OpenAI
 * seat has nothing to ask — codex has no command that lists what a ChatGPT
 * plan can call — so it lists nothing: a pinned id is trusted, and the
 * assignment route already refuses a family there.
 */
export function subscriptionModels(
  listing: SubscriptionListing,
): (account: TaskModelAccount) => Promise<AvailableModel[]> {
  return async (account) => {
    switch (account.provider) {
      case 'anthropic': {
        const token = await listing.tokenFor(account.id);
        if (!token) {
          throw new ModelUnavailable(`subscription account ${account.id} has no token stored to list models with`);
        }
        return listing.cache.modelsFor(modelListKey(account.id, token), () => listing.listWithToken(token));
      }
      case 'xai':
        if (!listing.cliModels) {
          throw new ModelUnavailable('this hostd has no sign-in service to ask grok what the subscription can call');
        }
        return listing.cliModels(account.id);
      case 'openai':
        return [];
    }
  };
}

/**
 * The model this task will run, from the bot's current row.
 *
 * Called at the start of every task, so a console change is what the next
 * task sees without hostd being restarted. `ModelUnavailable` is the task's
 * failure: the message names what the account offers, and nothing is
 * substituted in its place.
 */
export async function resolveTaskModel(bot: TaskModelBot, deps: ResolveTaskModelDeps): Promise<SessionModel> {
  if (bot.engine === 'none') {
    if (bot.modelAccountId) {
      throw new ModelUnavailable(`${bot.name} does not run a model and cannot be assigned an account`);
    }
    return { ...modelForSession(resolveModel(bot.model, [])), account: null };
  }
  if (deps.scripted) {
    // Nothing is called, so a family resolves to nothing: the ledger says the
    // scripted engine ran, under the family the seat is set to. A pinned id
    // is kept, as it is with no list to check it against.
    if (isAlias(bot.model)) return { model: 'scripted', modelAlias: bot.model, account: null };
    return { ...modelForSession(resolveModel(bot.model, [])), account: null };
  }

  const account = bot.modelAccountId ? await deps.account(bot.modelAccountId) : null;
  if (bot.modelAccountId && !account) {
    throw new ModelUnavailable(
      `${bot.name} is assigned to model account ${bot.modelAccountId}, which no longer exists`,
    );
  }

  let available: AvailableModel[] = [];

  if (account?.kind === 'key') {
    const key = await deps.keyForAccount(account.id);
    if (key) {
      available = await listed(
        account.id,
        () => deps.cache.modelsFor(modelListKey(account.id, key), () => deps.listModels(account.provider, key)),
        bot,
      );
    } else if (isAlias(bot.model)) {
      throw new ModelUnavailable(
        `${bot.name} is set to ${bot.model}, but account ${account.id} has no key to list models with`,
      );
    }
  } else if (account?.kind === 'subscription') {
    const list = deps.subscriptionModels;
    available = list ? await listed(account.id, () => list(account, bot), bot) : [];
    if (isAlias(bot.model) && available.length === 0) {
      const why =
        account.provider === 'openai'
          ? 'an OpenAI subscription cannot list models'
          : `nothing listed what subscription account ${account.id} can call`;
      throw new ModelUnavailable(`${why}, so ${bot.model} cannot be resolved — pin a model id`);
    }
  } else if (isAlias(bot.model)) {
    const provider = ENGINE_PROVIDER[bot.engine];
    const key = provider ? ((await deps.keyForBot?.(bot.name)) ?? null) : null;
    if (!provider || !key) {
      throw new ModelUnavailable(
        `${bot.name} is set to ${bot.model}, but it has no model account to list models from`,
      );
    }
    const cacheKey = `bot:${bot.name}`;
    available = await listed(
      cacheKey,
      () => deps.cache.modelsFor(modelListKey(cacheKey, key), () => deps.listModels(provider, key)),
      bot,
    );
  }

  return { ...modelForSession(resolveModel(bot.model, available)), account };
}
