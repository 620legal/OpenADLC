import type { EngineName } from '@fleetadlc/shared';
import type { ModelProvider } from './provider-models.js';

/**
 * Choosing a model without pinning one.
 *
 * Anthropic's identifiers do not float: `claude-opus-5` is Opus 5 and stays
 * Opus 5 when Opus 6 ships. So "use the newest Opus" cannot be expressed as a
 * model id — it is a choice OpenADLC has to resolve, against the list of models
 * the account can actually call, at the moment a task starts.
 *
 * The cost of a floating choice is that a bot's behaviour and its price change
 * without anybody editing anything. That is tolerable only because the ledger
 * records a concrete model per usage row: what must never be written there is
 * the alias, or a month of spend stops being attributable the moment the alias
 * moves.
 */

/** A floating choice, written where a model id would go. */
export const MODEL_ALIAS_PREFIX = 'newest:';

export interface ModelChoice {
  /** What was configured: an alias, or a model id. */
  configured: string;
  /** The id to actually call, once resolved. */
  resolved: string;
  /** Null when nothing had to be resolved. */
  alias: string | null;
}

/** A model an account can call, as the provider reports it. */
export interface AvailableModel {
  id: string;
  /** When the provider says it was released; newest wins. */
  createdAt: string | null;
  /**
   * Whether the provider calls this one its default. Only a CLI's list says
   * so — `grok models` marks one and dates none — and an API's never does.
   */
  isDefault?: boolean;
}

export function isAlias(configured: string): boolean {
  return configured.startsWith(MODEL_ALIAS_PREFIX);
}

/** `newest:opus` -> `opus`. */
export function aliasFamily(configured: string): string | null {
  return isAlias(configured) ? configured.slice(MODEL_ALIAS_PREFIX.length).trim().toLowerCase() : null;
}

/**
 * The newest model in a family, by the provider's own release date.
 *
 * By date rather than by parsing version numbers out of the id: the numbering
 * is the vendor's to change, and a comparison that understood `4-5` and `5`
 * would be wrong the first time one of them shipped something shaped
 * differently. A provider that reports no date leaves the ordering to what it
 * calls its default, and then to the id, which is the best available and is
 * why the family has to match first.
 *
 * The default comes first because the id is wrong about it: an xAI
 * subscription lists grok-4.7 as its default beside grok-4.7-build-fast, and
 * by id the variant sorts ahead of the model it is a variant of.
 *
 * A family follows its base model, not a cheaper variant of it: an id marked
 * mini, nano, fast, lite, preview or non-reasoning is chosen only when the
 * family names that variant itself (`newest:codex-mini`), or when the account
 * lists nothing else in the family. By date alone, `newest:codex` became
 * gpt-5.1-codex-mini the day OpenAI dated it after gpt-5.1-codex, and the lead
 * reviewer, whose approval a merge needs, moved to it with no change of
 * configuration.
 */
export function newestIn(family: string, available: AvailableModel[]): string | null {
  const matching = available.filter((model) => model.id.toLowerCase().includes(family));
  if (matching.length === 0) return null;

  const base = matching.filter((model) => !isVariant(model.id, family));
  return [...(base.length > 0 ? base : matching)].sort(newestFirst)[0]!.id;
}

/**
 * The words that mark a cheaper variant of a model, as whole dash-separated
 * parts of its id (so `codex` is not read as `code`), and the phrases that do
 * anywhere in it. The console keeps the same lists, in
 * apps/console/src/lib/model-onboarding.ts; keep the two identical.
 */
const VARIANT_PARTS = ['mini', 'nano', 'fast', 'lite', 'preview'];
const VARIANT_PHRASES = ['non-reasoning'];

/** Whether an id is a variant the family does not name: `gpt-5.1-codex-mini` in `codex`, not in `codex-mini`. */
export function isVariant(id: string, family: string): boolean {
  const parts = id.toLowerCase().split('-');
  const named = family.toLowerCase();
  const namedParts = named.split('-');
  return (
    VARIANT_PARTS.some((part) => parts.includes(part) && !namedParts.includes(part)) ||
    VARIANT_PHRASES.some((phrase) => id.toLowerCase().includes(phrase) && !named.includes(phrase))
  );
}

function newestFirst(a: AvailableModel, b: AvailableModel): number {
  if (a.createdAt && b.createdAt) return b.createdAt.localeCompare(a.createdAt);
  if (a.createdAt) return -1;
  if (b.createdAt) return 1;
  if (Boolean(a.isDefault) !== Boolean(b.isDefault)) return a.isDefault ? -1 : 1;
  return b.id.localeCompare(a.id);
}

/** A list in the order `newest:` reads it: newest first, or the default first when nothing is dated. */
export function sortNewestFirst<T extends AvailableModel>(available: readonly T[]): T[] {
  return [...available].sort(newestFirst);
}

/** The most a refusal names before it says how many more there are. */
const NAMED_AT_MOST = 8;

/**
 * What a refusal offers instead.
 *
 * A provider's catalogue runs to dozens of ids, and the message is cut to a
 * few hundred characters on its way to the task's thread, so the whole list
 * lost the useful end of itself. The models in the same family as the one
 * configured are what somebody would pick from; the whole catalogue is named
 * only when no family can be told, and then only the newest few.
 */
function offeredInstead(configured: string, available: AvailableModel[]): string {
  const id = configured.toLowerCase();
  const family = Object.values(ALIAS_FAMILIES)
    .flat()
    .find((name) => id.includes(name));
  const related = family ? available.filter((model) => model.id.toLowerCase().includes(family)) : [];
  const pool = [...(related.length > 0 ? related : available)].sort(newestFirst).map((model) => model.id);

  const named = pool.slice(0, NAMED_AT_MOST).join(', ');
  const more = pool.length > NAMED_AT_MOST ? `, and ${pool.length - NAMED_AT_MOST} more` : '';
  return related.length > 0 ? `its ${family} models are ${named}${more}` : `it offers ${named}${more}`;
}

export class ModelUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelUnavailable';
  }
}

/** A console assignment the engine cannot honour: no model, or the wrong family. */
export class ModelAssignmentError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'ModelAssignmentError';
  }
}

/** Whether `id` is `name` with a date appended, the way a provider lists a snapshot. */
export function isSnapshotOf(id: string, name: string): boolean {
  return id.startsWith(`${name}-`) && /^-\d{8}$/.test(id.slice(name.length));
}

/**
 * What to call, given what was configured and what the account can reach.
 *
 * A configured id that the account cannot call is an error rather than a
 * substitution: quietly running a different model than the one somebody chose
 * is the same fault as a scripted engine standing in for a missing one, and it
 * would appear in the ledger as a model nobody selected.
 */
export function resolveModel(configured: string, available: AvailableModel[]): ModelChoice {
  const family = aliasFamily(configured);

  if (family === null) {
    // Listed as itself, or as a dated snapshot of itself: Anthropic lists
    // `claude-haiku-4-5-20251001` and not `claude-haiku-4-5`, and the undated
    // name is the one the API, the CLI and the configuration all use. Only a
    // date completes it — `claude-haiku-4` is not `claude-haiku-4-5`.
    const known = available.some((model) => model.id === configured || isSnapshotOf(model.id, configured));
    if (available.length > 0 && !known) {
      throw new ModelUnavailable(`this account cannot call ${configured} — ${offeredInstead(configured, available)}`);
    }
    return { configured, resolved: configured, alias: null };
  }

  const newest = newestIn(family, available);
  if (!newest) {
    throw new ModelUnavailable(`this account offers no ${family} model, so "${configured}" resolves to nothing`);
  }

  return { configured, resolved: newest, alias: family };
}

/** An engine that calls a model: every one but the automation account's. */
export type ThinkingEngine = Exclude<EngineName, 'none'>;

/** The families worth offering as a floating choice, per engine. */
export const ALIAS_FAMILIES: Partial<Record<EngineName, string[]>> = {
  claude: ['fable', 'opus', 'sonnet', 'haiku'],
  codex: ['codex'],
  grok: ['grok'],
};

/**
 * Whose account can drive each engine. `claude` calls Anthropic and nothing
 * else, so an OpenAI key on it is a key the engine cannot present.
 */
export const ENGINE_PROVIDER: Partial<Record<EngineName, ModelProvider>> = {
  claude: 'anthropic',
  codex: 'openai',
  grok: 'xai',
};

/**
 * The engine each provider is thought with: `ENGINE_PROVIDER` the other way
 * round. An engine is only how a provider is reached, so an account decides
 * it — a bot given an xAI account runs grok, whatever config/bots.yaml
 * proposed for it.
 */
export const PROVIDER_ENGINE: Record<ModelProvider, ThinkingEngine> = {
  anthropic: 'claude',
  openai: 'codex',
  xai: 'grok',
};

/**
 * Whether a subscription on this provider can say what it can call, which is
 * what a `newest:` family resolves against. A Claude seat lists with its setup
 * token and an xAI seat with `grok models`; codex has no command that lists
 * what a ChatGPT plan can call. A key always can.
 */
export const SUBSCRIPTION_LISTS_MODELS: Record<ModelProvider, boolean> = {
  anthropic: true,
  openai: false,
  xai: true,
};

/** The part of an account an assignment is checked against. */
export interface AssignableAccount {
  id: string;
  provider: ModelProvider;
  kind: 'key' | 'subscription';
}

/** The `newest:` families this account can resolve, in the order a picker offers them. */
export function aliasesFor(account: Pick<AssignableAccount, 'provider' | 'kind'>): string[] {
  if (account.kind === 'subscription' && !SUBSCRIPTION_LISTS_MODELS[account.provider]) return [];
  return (ALIAS_FAMILIES[PROVIDER_ENGINE[account.provider]] ?? []).map((family) => `${MODEL_ALIAS_PREFIX}${family}`);
}

const PROVIDER_NAME: Record<ModelProvider, string> = { anthropic: 'Anthropic', openai: 'OpenAI', xai: 'xAI' };

/**
 * How each provider's model ids start, so a model chosen for one provider is
 * not handed to another's engine. Only the start: the rest is the vendor's to
 * change. OpenAI serves a fine-tune as `ft:gpt-…`.
 */
const PROVIDER_IDS: Record<ModelProvider, { shape: RegExp; said: string }> = {
  anthropic: { shape: /^claude-/, said: 'claude-… ids' },
  openai: { shape: /^(?:ft:)?(?:gpt-|o\d|codex)/, said: 'gpt-…, o… and codex… ids' },
  xai: { shape: /^grok-/, said: 'grok-… ids' },
};

/** The provider an id looks like it belongs to, or null when it looks like none of theirs. */
export function providerOfModel(id: string): ModelProvider | null {
  const providers = Object.keys(PROVIDER_IDS) as ModelProvider[];
  return providers.find((provider) => PROVIDER_IDS[provider].shape.test(id)) ?? null;
}

function spoken(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/** What an engine can be given on this account: its provider's ids, and the families the account can float. */
function takes(provider: ModelProvider, kind: AssignableAccount['kind']): string {
  const floating = aliasesFor({ provider, kind });
  return floating.length > 0 ? `${PROVIDER_IDS[provider].said} or ${spoken(floating)}` : PROVIDER_IDS[provider].said;
}

/**
 * What a model id may look like: provider ids are letters, digits and a few
 * separators (`claude-opus-5`, `ft:gpt-5:org:1`, `newest:opus`). Anything else
 * would reach an engine's command line and a ledger column.
 */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
export const MODEL_ID_MAX = 128;

/** Whether a value is shaped like a model id, for anything that reads one out of a CLI's words. */
export function isModelId(value: string): boolean {
  return value.length > 0 && value.length <= MODEL_ID_MAX && MODEL_ID.test(value);
}

/** What an assignment stores: the engine the account puts the bot on, the model, the account. */
export interface CheckedAssignment {
  engine: EngineName;
  model: string;
  modelAccountId: string | null;
}

/**
 * What a console may store on a bot, and the engine that puts it on.
 *
 * The account decides the engine. OpenADLC proposes a model for each bot, and a
 * person may choose differently — any verified account, any model it offers —
 * so a bot given an xAI account runs grok, and one given an Anthropic account
 * runs claude, whatever config/bots.yaml said. Refusing an account from
 * another provider, as this used to, left a bot configured for Codex with
 * nothing to think with on an install that has no OpenAI account. With no
 * account the bot keeps its engine, and the per-bot key it may still have.
 *
 * `engine: none` is the automation account. It has no model, and offering it
 * an account would put a credential on a bot that never calls one.
 *
 * The model has to be one the account's provider serves: `claude-opus-5`
 * handed to grok is a task that fails on its first call, and the refusal
 * belongs here rather than there. A floating family has to be one the engine
 * has — `newest:opus` on grok cannot resolve — and one the account can list:
 * a key always can, and so can a Claude or an xAI subscription, but an OpenAI
 * subscription cannot, so a family there would have nothing to resolve
 * against.
 */
export function checkModelAssignment(
  engine: EngineName,
  model: string,
  account: AssignableAccount | null,
): CheckedAssignment {
  const chosen = model.trim();
  if (!chosen) throw new ModelAssignmentError('a bot needs a model');
  if (chosen.length > MODEL_ID_MAX) {
    throw new ModelAssignmentError(`a model id is at most ${MODEL_ID_MAX} characters`);
  }
  if (!MODEL_ID.test(chosen)) {
    throw new ModelAssignmentError('a model id is letters, digits and . _ : / - only');
  }

  if (engine === 'none') {
    if (account) {
      throw new ModelAssignmentError('this bot does not run a model and cannot be assigned an account');
    }
    if (chosen !== 'none') throw new ModelAssignmentError('this bot does not run a model');
    return { engine: 'none', model: 'none', modelAccountId: null };
  }

  const target: ThinkingEngine = account ? PROVIDER_ENGINE[account.provider] : engine;
  const provider = account?.provider ?? ENGINE_PROVIDER[engine];
  if (!provider) throw new ModelAssignmentError(`${engine} calls no provider this can check a model against`);
  const kind = account?.kind ?? 'key';

  if (chosen === 'none') throw new ModelAssignmentError(`${target} needs a model`);

  const family = aliasFamily(chosen);
  if (family !== null) {
    const families = ALIAS_FAMILIES[target] ?? [];
    if (!families.includes(family)) {
      const offered =
        families.length > 0 ? families.map((name) => `${MODEL_ALIAS_PREFIX}${name}`).join(', ') : 'no floating family';
      throw new ModelAssignmentError(`${target} has no ${family} family — it offers ${offered}`);
    }
    if (kind === 'subscription' && !SUBSCRIPTION_LISTS_MODELS[provider]) {
      throw new ModelAssignmentError(
        `an ${PROVIDER_NAME[provider]} subscription cannot list models, so ${chosen} would have nothing to ` +
          'resolve against — pin a model id',
      );
    }
  } else if (!PROVIDER_IDS[provider].shape.test(chosen)) {
    const owner = providerOfModel(chosen);
    const name = PROVIDER_NAME[provider];
    if (!owner) {
      throw new ModelAssignmentError(`${chosen} is not an ${name} model — ${target} takes ${takes(provider, kind)}`);
    }
    throw new ModelAssignmentError(
      account
        ? `${chosen} is an ${PROVIDER_NAME[owner]} model, and this is an ${name} account — ` +
            `${target} takes ${takes(provider, kind)}`
        : `${chosen} is an ${PROVIDER_NAME[owner]} model, and ${target} calls ${name} — ` +
            `choose an ${PROVIDER_NAME[owner]} account to run it on ${PROVIDER_ENGINE[owner]}`,
    );
  }

  return { engine: target, model: chosen, modelAccountId: account?.id ?? null };
}

/**
 * The id a session is allowed to call, and the alias to remember beside it.
 *
 * `resolved` is what the engine and the ledger both receive. An alias there is
 * refused rather than passed through: the ledger column is how a month of
 * spend stays attributable after the alias moves.
 */
export function modelForSession(choice: ModelChoice): { model: string; modelAlias: string | null } {
  if (isAlias(choice.resolved)) {
    throw new ModelUnavailable(`refusing to start on an unresolved alias ${choice.resolved}`);
  }
  return {
    model: choice.resolved,
    modelAlias: choice.alias ? choice.configured : null,
  };
}

/**
 * What a usage row may store.
 *
 * Called at the moment the runner reports usage, which is the last place an
 * alias could still be written into the model column. The alias, when there
 * was one, travels separately.
 */
export function ledgerModel(
  model: string,
  modelAlias: string | null | undefined,
): { model: string; modelAlias: string | null } {
  if (isAlias(model)) {
    throw new ModelUnavailable(`refusing to record ${model}; the ledger stores a resolved model id`);
  }
  return { model, modelAlias: modelAlias && isAlias(modelAlias) ? modelAlias : null };
}
