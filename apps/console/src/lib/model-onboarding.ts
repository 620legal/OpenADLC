/**
 * What the two model steps decide, apart from the widgets.
 *
 * One account is one credential. The assignment step points bots at it. The
 * families and the "newest first" ordering match `model-choice.ts`; this file
 * does not import `@fleetadlc/engines`, because that barrel pulls the CLIs into
 * the client bundle.
 */

import { atStart, botLabel } from './bot-label';

export const PROVIDERS = ['anthropic', 'openai', 'xai'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const ACCOUNT_KINDS = ['key', 'subscription'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const PROVIDER_LABEL: Record<Provider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  xai: 'xAI',
};

/** Where a key is issued. The same links `readiness.ts` puts on `keySource`. */
export const KEY_LINKS: Record<Provider, { envVar: string; url: string; label: string }> = {
  anthropic: {
    envVar: 'ANTHROPIC_API_KEY',
    url: 'https://console.anthropic.com/settings/keys',
    label: 'Anthropic Console',
  },
  openai: {
    envVar: 'OPENAI_API_KEY',
    url: 'https://platform.openai.com/api-keys',
    label: 'OpenAI platform',
  },
  xai: { envVar: 'XAI_API_KEY', url: 'https://console.x.ai/', label: 'xAI Console' },
};

/**
 * What a bot runs on each provider's account. The bridge takes any provider's
 * account for any thinking bot and switches its engine to match.
 */
export const PROVIDER_ENGINE: Record<Provider, ThinkingEngine> = {
  anthropic: 'claude',
  openai: 'codex',
  xai: 'grok',
};

export const ENGINE_PROVIDER = {
  claude: 'anthropic',
  codex: 'openai',
  grok: 'xai',
} as const;

export type ThinkingEngine = keyof typeof ENGINE_PROVIDER;
export type CrewEngine = ThinkingEngine | 'none';

/**
 * Floating families each engine can actually resolve.
 * `ALIAS_FAMILIES` in `packages/engines/src/model-choice.ts`.
 */
export const ALIAS_FAMILIES: Record<ThinkingEngine, readonly string[]> = {
  claude: ['fable', 'opus', 'sonnet', 'haiku'],
  codex: ['codex'],
  grok: ['grok'],
};

const FAMILY_NAME: Record<string, string> = {
  fable: 'Fable',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  codex: 'Codex',
  grok: 'Grok',
};

/** Said on the accounts screen, not in a document. */
export const SUBSCRIPTION_SEAT =
  'Bots sharing a subscription run at the same time, like several CLI windows on one laptop. They draw on one usage allowance and rate limit, so a busy crew reaches the plan’s limit sooner than it would on separate accounts or API keys.';

/**
 * Said beside SUBSCRIPTION_SEAT. A subscription is one person's account under
 * the provider's consumer terms; an organisation that ran its crew on it
 * without reading them could lose the account mid-task. The form starts on an
 * API key for that reason. It names no provider's rule, because those change:
 * it sends the reader to them.
 */
export const SUBSCRIPTION_TERMS =
  'We recommend an API key. A subscription is the subscriber’s personal account, under the provider’s consumer terms, which may not allow an automated crew. Read the provider’s current terms before connecting one: whether it is allowed is between you and the provider, and an account used against them can be suspended. An install serving several people should use API keys or the provider’s business or team plan.';

/** Where a Claude seat's token comes from: the first of its two steps, copied as it is. */
export const SETUP_TOKEN_COMMAND = 'claude setup-token';

/** Said under the command, so nobody runs it on the wrong machine or waits for a prompt that is not coming. */
export const SETUP_TOKEN_HOW =
  'Run it in a terminal on a machine signed in to this Claude subscription. It opens the browser to approve, then prints a token.';

/** Said where the token is pasted. There is no Verify to press: saving is the check. */
export const TOKEN_SAVE_COPY = 'Saving it checks it straight away, with one tiny prompt through the subscription.';

/** What an OpenAI or xAI seat needs, and what it does not. */
export const SIGN_IN_COPY =
  'Sign in once, here, and every bot on this account uses that login. No terminal, and nothing to install in the bot image.';

/** A seat nothing has checked yet. A tilde is that, and it is not a tick. */
export const NOT_VERIFIED_COPY = 'not verified yet';

/** Shown while the operator finishes a sign-in in their own browser. */
export const SIGN_IN_WAITING_COPY = 'waiting for you to finish in the browser…';

/** How often a sign-in in progress is asked about. */
export const LOGIN_POLL_MS = 3_000;

/**
 * How long a sign-in is followed before the page stops asking. hostd stops
 * the CLI at fifteen minutes, when its code expires, and says so; this is for
 * a page that has lost the bridge for that long and would otherwise ask for
 * ever.
 */
export const SIGN_IN_WINDOW_MS = 16 * 60 * 1000;

/** What an `engine: none` bot is. An empty picker would read as unfinished. */
export const NO_MODEL_COPY = 'no model, and that is correct';

export interface AccountRef {
  id: string;
  provider: Provider;
  kind: AccountKind;
  label: string;
  /** When the account was last checked by sending its CLI a one-line prompt. Absent or null: never. */
  verifiedAt?: string | null;
  /** The CLI's own words when that check failed. Null when it answered. */
  verifyError?: string | null;
}

/** Where an OpenAI or xAI seat's sign-in stands, as hostd says it. */
export type LoginState =
  | { state: 'waiting'; url: string; code: string; startedAt: string }
  | { state: 'signed-in' }
  | { state: 'failed'; message: string }
  | { state: 'signed-out' };

/** One check of an account, as the bridge recorded it. */
export interface AccountCheck {
  ok: boolean;
  message: string;
  checkedAt: string;
}

export interface ListedModel {
  id: string;
  createdAt: string | null;
  /** The account's own default, where the provider marks one (xAI does). */
  isDefault?: boolean;
}

/** What an account offers, as the bridge listed it. */
export interface AccountListing {
  models: ListedModel[];
  /** The families it can follow, as `newest:opus`. */
  aliases: string[];
  /** The provider's words when the listing failed. Null when it answered. */
  error: string | null;
}

/** An account that has not said what it offers, or could not. */
export const EMPTY_LISTING: AccountListing = { models: [], aliases: [], error: null };

export interface KeySource {
  envVar: string;
  url: string;
  label: string;
}

export interface Readiness {
  ready: boolean;
  confidence: 'certain' | 'binary-only';
  detail: string;
  remedy: string;
  keySource: KeySource | null;
  hasKey: boolean;
  needsCommand: string | null;
  hasCommand: boolean;
}

export interface CrewBot {
  /** Its name: the handle of its account once one is connected, the seat until then. */
  bot: string;
  /** The seat it fills, `second-reviewer`, which is how a person is told what it is before it connects. */
  slot?: string;
  /** Whether an account is connected, when the bridge says. */
  connected?: boolean;
  /** `review_lead`, `review_second`… The proposal keeps second opinions off the lead's provider. */
  role?: string;
  roleLabel: string;
  engine: CrewEngine;
  model: string;
  modelAccountId: string | null;
  readiness: Readiness | null;
  /**
   * What `config/bots.yaml` gives this bot, which the proposal starts from.
   * `engine` and `model` are what is saved, and once an operator has moved a
   * bot they are that choice; proposing from them would make the choice its
   * own recommendation, and a seat with nothing saved could start on an
   * earlier choice rather than the recommendation.
   */
  configuredEngine?: CrewEngine;
  configuredModel?: string;
}

/** The bot as the proposal sees it: its configured engine and model, when known. */
function asConfigured(bot: CrewBot): CrewBot {
  return {
    ...bot,
    engine: bot.configuredEngine ?? bot.engine,
    model: bot.configuredModel ?? bot.model,
  };
}

export interface ModelOption {
  value: string;
  label: string;
  /** The id a floating choice resolves to today, when the account's dated list says. */
  resolvesTo: string | null;
}

/**
 * How an assignment in the proposal differs from what the bot was set to.
 * Each is said in the sentence.
 */
export type Substitution =
  /** Its own provider, with a model the account offers in place of one it does not. */
  | { kind: 'model'; configured: string }
  /** Another provider's account, because none of its own can take it. */
  | {
      kind: 'provider';
      from: Provider;
      /** No account of its own provider, one not verified yet, or one that listed nothing to propose. */
      why: 'none' | 'unverified' | 'unlisted';
      /** A second opinion that landed on the lead reviewer's provider, or was moved off it. */
      lead: 'same' | 'moved' | null;
    };

export interface ProposalAssignment {
  bot: string;
  accountId: string;
  model: string;
  /** What the bot runs on that account. The bridge switches it to match. */
  engine: ThinkingEngine;
  /** Absent when the bot keeps its provider and its model. */
  substitution?: Substitution;
}

export interface Proposal {
  sentence: string;
  assignments: ProposalAssignment[];
}

const COUNT_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
];

export function defaultAccountLabel(provider: Provider, kind: AccountKind): string {
  const name = PROVIDER_LABEL[provider];
  if (kind === 'subscription') {
    if (provider === 'anthropic') return 'Anthropic — Max';
    return `${name} — subscription`;
  }
  return `${name} — API key`;
}

/**
 * What `POST /v1/model-accounts` is sent.
 *
 * A subscription carries no API key, including one left in the field from
 * before the kind was switched. The API would refuse that paste; not sending
 * it is the same decision made earlier. A Claude seat may carry the token
 * `claude setup-token` printed, from a field of its own, and nothing else.
 */
export function accountRequestBody(input: {
  provider: Provider;
  kind: AccountKind;
  label: string;
  key?: string;
  token?: string;
}): { provider: Provider; kind: AccountKind; label: string; key?: string } {
  const label = input.label.trim();
  if (input.kind === 'subscription') {
    const token = (input.token ?? '').trim();
    return input.provider === 'anthropic' && token
      ? { provider: input.provider, kind: 'subscription', label, key: token }
      : { provider: input.provider, kind: 'subscription', label };
  }
  return { provider: input.provider, kind: 'key', label, key: (input.key ?? '').trim() };
}

/**
 * How a subscription gets its credential: a token pasted for a Claude seat, a
 * sign-in run from here for an OpenAI or xAI one. Null for an API key account,
 * whose key was the credential from the moment it was added.
 */
export function subscriptionCredential(account: Pick<AccountRef, 'provider' | 'kind'>): 'token' | 'sign-in' | null {
  if (account.kind !== 'subscription') return null;
  return account.provider === 'anthropic' ? 'token' : 'sign-in';
}

/**
 * Why a paste is not what `claude setup-token` prints, or null when it could
 * be. The bridge decides; this is so the field can say so before it is sent.
 * A long token copied out of a terminal that wrapped it has a line break in
 * the middle, and that is the mistake worth naming.
 */
export function setupTokenProblem(paste: string): string | null {
  const token = paste.trim();
  if (!token) return null;
  if (/\s/.test(token)) return 'that has a space or a line break in it — copy the token again as one line';
  if (!token.startsWith('sk-ant-oat')) return 'that is not a setup token — they start with sk-ant-oat';
  return null;
}

export function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

export function isAccountKind(value: string): value is AccountKind {
  return (ACCOUNT_KINDS as readonly string[]).includes(value);
}

export function isCrewEngine(value: string): value is CrewEngine {
  return value === 'claude' || value === 'codex' || value === 'grok' || value === 'none';
}

/**
 * Done once one account is on the step's verified side — the same test that
 * puts it there, so the tick and the panel cannot disagree.
 *
 * It used to be done once one was stored. A key is proved on the way in, by
 * listing models, but a seat is not, so the walkthrough ticked "the accounts"
 * over a Claude seat with no token and moved on.
 */
export function accountsStepDone(accounts: readonly AccountRef[], crew: readonly CrewBot[] = []): boolean {
  return accounts.some((account) => accountStanding(account, crew).verified);
}

export function thinkingBots(bots: readonly CrewBot[]): CrewBot[] {
  return bots.filter((bot) => bot.engine !== 'none');
}

export function modelessBots(bots: readonly CrewBot[]): CrewBot[] {
  return bots.filter((bot) => bot.engine === 'none');
}

/**
 * Accounts of the provider this engine calls, in the order they were given
 * (oldest first). A thinking bot can be put on any provider's account, which
 * switches its engine; these are the ones it can have without switching.
 */
export function accountsFor(engine: CrewEngine, accounts: readonly AccountRef[]): AccountRef[] {
  if (engine === 'none') return [];
  const provider = ENGINE_PROVIDER[engine];
  return accounts.filter((account) => account.provider === provider);
}

/**
 * Whether an account's credential has been proved: a seat a check answered
 * through, or a key the provider accepted when it was stored, until a check
 * says otherwise. What the proposal and the pickers offer. A command missing
 * from the host does not count against it here, as it does on the accounts
 * step: that fails every account on the engine alike, and the bot's row says so.
 */
export function isVerified(account: Pick<AccountRef, 'kind' | 'verifiedAt' | 'verifyError'>): boolean {
  return !account.verifyError && (account.kind === 'key' || Boolean(account.verifiedAt));
}

/** `newest:opus` is a family to follow; anything else is a pinned id. */
export function isAlias(model: string): boolean {
  return model.startsWith('newest:');
}

export function keyLinkFor(provider: Provider, crew: readonly CrewBot[]): { url: string; label: string } {
  const engine = PROVIDER_ENGINE[provider];
  const live = crew.find((bot) => bot.engine === engine)?.readiness?.keySource;
  if (live?.url) return { url: live.url, label: live.label };
  const fallback = KEY_LINKS[provider];
  return { url: fallback.url, label: fallback.label };
}

/** "Newest Opus", for `newest:opus`. */
export function aliasTitle(alias: string): string {
  const family = alias.slice('newest:'.length);
  return `Newest ${FAMILY_NAME[family] ?? capitalised(family)}`;
}

/**
 * A model as a person says it: `claude-opus-5` is Claude Opus 5, `grok-4.7`
 * is Grok 4.7 and `newest:opus` is Newest Opus. An id whose shape this does
 * not know is said as it is.
 */
export function modelName(model: string): string {
  if (isAlias(model)) return aliasTitle(model);
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(model);
  if (claude) return `Claude ${capitalised(claude[1]!)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`;
  const grok = /^grok-(\d+(?:\.\d+)?)(?:-(.+))?$/.exec(model);
  if (grok) return `Grok ${grok[1]}${grok[2] ? ` ${grok[2]}` : ''}`;
  const codex = /^gpt-(\d+(?:\.\d+)?)-codex$/.exec(model);
  if (codex) return `GPT-${codex[1]} Codex`;
  return model;
}

/** A release date after an id: `claude-haiku-4-5-20251001` is `claude-haiku-4-5`. */
const DATE_SUFFIX = /^-\d{8}$/;

/**
 * The id under which an account offers a model, or null when it does not. A
 * family, when the account says it can follow it. A pinned id as it is
 * written, when the account lists it or a dated snapshot of it:
 * `claude-haiku-4-5` is the undated name of the `claude-haiku-4-5-20251001` a
 * Claude seat lists, the API and the CLI both take it, and the bridge accepts
 * it for the same reason — so the name the configuration uses is the one
 * proposed, not a date the operator never chose. An account that lists
 * nothing to check against, as an OpenAI subscription does, takes the id as it
 * is.
 */
export function offeredAs(listing: Pick<AccountListing, 'models' | 'aliases'>, model: string): string | null {
  if (isAlias(model)) return listing.aliases.includes(model) ? model : null;
  if (listing.models.length === 0 || listing.models.some((one) => one.id === model)) return model;
  const dated = listing.models.some(
    (one) => one.id.startsWith(`${model}-`) && DATE_SUFFIX.test(one.id.slice(model.length)),
  );
  return dated ? model : null;
}

/** Whether an account offers a model, under that id or its dated one. See `offeredAs`. */
export function offers(listing: Pick<AccountListing, 'models' | 'aliases'>, model: string): boolean {
  return offeredAs(listing, model) !== null;
}

/** How much a bot's work asks of its model. */
export type Tier = 'deep' | 'standard' | 'fast';

/**
 * The reviewers besides the lead. A proposal keeps each of them off the other
 * reviewers' providers when some account allows it; the shipped crew does not,
 * and puts the security reviewer on the lead's.
 */
const SECOND_OPINIONS: ReadonlySet<string> = new Set(['review_second', 'review_security']);
const REVIEWERS: ReadonlySet<string> = new Set(['review_lead', ...SECOND_OPINIONS]);

/**
 * Read from the model a bot was set to: Opus is deep, Sonnet standard, Haiku
 * fast. The security reviewer's codex and the second reviewer's grok are the
 * deepest opinion their providers give, and are deep wherever they go.
 */
export function tierOf(bot: Pick<CrewBot, 'model' | 'role'>): Tier {
  const model = bot.model.toLowerCase();
  if (model.includes('haiku') || /-(fast|mini)\b/.test(model)) return 'fast';
  if (model.includes('opus') || model.includes('fable')) return 'deep';
  if (model.includes('sonnet')) return 'standard';
  return SECOND_OPINIONS.has(bot.role ?? '') ? 'deep' : 'standard';
}

/**
 * What the proposal names for each tier on each provider. Null is the
 * account's own default, which is how xAI says what a seat runs.
 */
const TIER_MODEL: Record<Provider, Record<Tier, string | null>> = {
  anthropic: { deep: 'claude-opus-5', standard: 'claude-sonnet-5', fast: 'claude-haiku-4-5' },
  openai: { deep: 'gpt-5-codex', standard: 'gpt-5-codex', fast: 'gpt-5-codex' },
  xai: { deep: null, standard: null, fast: 'grok-4.7-build-fast' },
};

/** Where to look when an account does not offer the model above: the newest of this family that it does. */
const TIER_FAMILY: Record<Provider, Record<Tier, string>> = {
  anthropic: { deep: 'opus', standard: 'sonnet', fast: 'haiku' },
  openai: { deep: 'codex', standard: 'codex', fast: 'codex' },
  xai: { deep: 'grok', standard: 'grok', fast: 'grok' },
};

/**
 * Offered to choose, never proposed: Fable is priced above Opus
 * (packages/engines/src/pricing.ts), so a proposal never puts a bot on it.
 */
export function proposable(model: string): boolean {
  return !/^claude-fable-/.test(model);
}

/**
 * What the proposal puts a bot of this tier on, on this account: the tier's
 * model when the account offers it, otherwise the newest of that family it
 * does, never one that is only chosen on purpose. On xAI, the account's
 * default, and for a fast bot its build-fast model when it lists one. Null
 * when nothing it lists will do — and on xAI when it lists nothing, since a
 * grok id is not guessed.
 */
export function modelFor(provider: Provider, tier: Tier, listing: AccountListing | undefined): string | null {
  const models = listing?.models ?? [];
  const named = TIER_MODEL[provider][tier];
  if (provider === 'xai') {
    if (named && models.some((one) => one.id === named)) return named;
    const fallback =
      models.find((one) => one.isDefault) ?? [...models].filter((one) => !/-fast\b/.test(one.id)).sort(byNewest)[0];
    return fallback?.id ?? null;
  }
  const offered = named ? offeredAs({ models, aliases: [] }, named) : null;
  if (offered) return offered;
  const family = TIER_FAMILY[provider][tier];
  const fallback =
    [...models].filter((one) => one.id.includes(family) && proposable(one.id)).sort(byNewest)[0] ??
    models.find((one) => one.isDefault && proposable(one.id));
  return fallback?.id ?? null;
}

/**
 * Newest id in a family, by the provider's release date, skipping the
 * family's cheaper variants unless it names one or lists nothing else. See
 * `newestIn`, whose answer this has to match: it is the 'right now' beside a
 * family, and the runtime calls what `newestIn` says.
 */
export function newestId(family: string, available: readonly ListedModel[]): string | null {
  const matching = available.filter((model) => model.id.toLowerCase().includes(family));
  if (matching.length === 0) return null;
  const base = matching.filter((model) => !isVariant(model.id, family));
  return [...(base.length > 0 ? base : matching)].sort(byNewest)[0]!.id;
}

/**
 * What marks a cheaper variant of a model (`-mini`, `-fast`, which `tierOf`
 * grades fast, and the rest). The same lists as `isVariant` in
 * packages/engines/src/model-choice.ts, which the console does not import;
 * keep the two identical.
 */
const VARIANT_PARTS = ['mini', 'nano', 'fast', 'lite', 'preview'];
const VARIANT_PHRASES = ['non-reasoning'];

function isVariant(id: string, family: string): boolean {
  const parts = id.toLowerCase().split('-');
  const named = family.toLowerCase();
  const namedParts = named.split('-');
  return (
    VARIANT_PARTS.some((part) => parts.includes(part) && !namedParts.includes(part)) ||
    VARIANT_PHRASES.some((phrase) => id.toLowerCase().includes(phrase) && !named.includes(phrase))
  );
}

function byNewest(a: ListedModel, b: ListedModel): number {
  return byDate(a, b) || b.id.localeCompare(a.id);
}

/**
 * Newest first by release date, and otherwise as they were given. Sorted by id
 * instead, an undated list put `claude-sonnet-5` above Opus 5.5 and Fable last.
 */
function byDate(a: ListedModel, b: ListedModel): number {
  if (a.createdAt && b.createdAt && a.createdAt !== b.createdAt) return b.createdAt.localeCompare(a.createdAt);
  if (a.createdAt && !b.createdAt) return -1;
  if (!a.createdAt && b.createdAt) return 1;
  return 0;
}

/**
 * A row's model picker, for one account: the families it can follow, with
 * what each is today when its list is dated, then its models newest first —
 * by date where the list has dates, and otherwise in the order the account
 * listed them, which is the provider's, with a dated snapshot after the name
 * it pins. The account's default and the proposed choice are marked. What the
 * row has or is proposed, when the list does not have it, stays offered rather
 * than showing as something else, and says so when it is not a model a bot can
 * run at all.
 */
export function modelChoices(
  listing: Pick<AccountListing, 'models' | 'aliases'> | undefined,
  current: string,
  proposed: string | null = null,
): ModelOption[] {
  const models = listing?.models ?? [];
  const marks = (value: string, isDefault = false): string =>
    `${isDefault ? ' · default' : ''}${value === proposed ? ' · proposed' : ''}`;

  // Only a dated list says which is newest. By id alone, `grok-4.7-build-fast`
  // would be named as what the family is today.
  const dated = models.filter((model) => model.createdAt);
  const floating = (listing?.aliases ?? []).map((alias) => {
    const resolved = newestId(alias.slice('newest:'.length), dated);
    return {
      value: alias,
      label: `${aliasTitle(alias)}${resolved ? ` · ${resolved} right now` : ''}${marks(alias)}`,
      resolvesTo: resolved,
    };
  });
  const seen = new Set<string>();
  const concrete = snapshotsAfterNames([...models].sort(byDate)).flatMap((model) => {
    if (seen.has(model.id)) return [];
    seen.add(model.id);
    return [{ value: model.id, label: `${model.id}${marks(model.id, model.isDefault)}`, resolvesTo: null }];
  });
  const options: ModelOption[] = [...floating, ...concrete];
  for (const kept of [current, proposed]) {
    if (!kept || kept === 'none' || options.some((option) => option.value === kept)) continue;
    // Still there, so it can be changed: switching it here would run a model
    // nobody chose, and hostd refuses its next task naming what the account offers.
    const unusable = botCanRun(kept) ? '' : ' · not offered for bots';
    options.push({
      value: kept,
      label: `${isAlias(kept) ? aliasTitle(kept) : kept}${unusable}${marks(kept)}`,
      resolvesTo: null,
    });
  }
  return options;
}

/** A release date after an id, as Anthropic (`-20251001`) and OpenAI (`-2025-08-07`) write it. */
const SNAPSHOT_SUFFIX = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;

/**
 * Each dated snapshot straight after the undated name it pins, when that name
 * is listed too. OpenAI dates `gpt-5-2025-08-07` a minute after `gpt-5`, so by
 * date alone the snapshot came first and the name somebody means sat under it.
 * Done after the sort rather than in it: a comparator that put a name before
 * its snapshot and otherwise went by date could disagree with itself.
 */
function snapshotsAfterNames<T extends ListedModel>(sorted: readonly T[]): T[] {
  const listed = new Set(sorted.map((model) => model.id));
  const nameOf = (id: string): string | null => {
    const name = id.replace(SNAPSHOT_SUFFIX, '');
    return name !== id && listed.has(name) ? name : null;
  };
  const snapshots = new Map<string, T[]>();
  for (const model of sorted) {
    const name = nameOf(model.id);
    if (name) snapshots.set(name, [...(snapshots.get(name) ?? []), model]);
  }
  return sorted.flatMap((model) => (nameOf(model.id) ? [] : [model, ...(snapshots.get(model.id) ?? [])]));
}

/**
 * The families a bot can think with. A copy of `botCanRun` in
 * `packages/engines/src/provider-models.ts`, which filters what an account
 * lists; this is for what a bot was already set to before that filter, and
 * takes the provider from the id. Change the two together.
 */
const BOT_FAMILIES = [
  /^claude-/,
  /^(?:gpt-\d+(?:\.\d+)?o?|o\d+)(?:-|$)/,
  /^grok-(?:\d+(?:\.\d+)?|code)(?:-|$)/,
];
const NOT_FOR_BOTS: ReadonlySet<string> = new Set([
  'audio',
  'realtime',
  'transcribe',
  'tts',
  'image',
  'imagine',
  'video',
  'search',
  'instruct',
  'embedding',
  'moderation',
  'research',
]);

/** Whether a bot can run on this id: `gpt-5-codex` and `grok-4.7`, not `tts-1` or `gpt-image-1`. */
export function botCanRun(model: string): boolean {
  if (isAlias(model)) return true;
  const base = (model.startsWith('ft:') ? model.slice(3).split(':')[0]! : model).toLowerCase();
  const parts = base.split('-');
  // Codex is OpenAI's. A grok id that contains `codex` is still a grok id:
  // `grok-codex` is not a grok family, and `grok-2-image-codex` is an image
  // model. Treating every `codex` part as runnable left those unlabelled.
  if (parts.includes('codex') && !base.startsWith('grok')) return true;
  if (!BOT_FAMILIES.some((family) => family.test(base))) return false;
  return !parts.some((part) => NOT_FOR_BOTS.has(part));
}

function countWord(count: number): string {
  return COUNT_WORDS[count] ?? String(count);
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): { key: string; items: T[] }[] {
  const groups: { key: string; items: T[] }[] = [];
  for (const item of items) {
    const at = key(item);
    const existing = groups.find((group) => group.key === at);
    if (existing) existing.items.push(item);
    else groups.push({ key: at, items: [item] });
  }
  return groups;
}

function modelToKeep(bot: CrewBot): string {
  if (bot.engine === 'none') return bot.model;
  if (bot.model && bot.model !== 'none') return bot.model;
  const family = ALIAS_FAMILIES[bot.engine][0];
  return family ? `newest:${family}` : bot.model;
}

/** The order another provider is tried in, when nothing else decides. */
const PROVIDER_ORDER: readonly Provider[] = ['anthropic', 'openai', 'xai'];

function listingOf(listings: Readonly<Record<string, AccountListing>>, id: string): AccountListing {
  return listings[id] ?? EMPTY_LISTING;
}

/**
 * The best model for each agent, at the top of the assignment step.
 *
 * A bot goes on a verified account of its own provider when there is one:
 * with the model it was set to when that account offers it, under the id the
 * account lists, and the equivalent it does offer when not — `grok-4` on a
 * SuperGrok seat is that seat's default. A task is refused an id its account
 * does not list, so nothing unlisted is proposed where there is a list. A
 * family stays only on an account that can follow it. A bot
 * whose provider has no such account goes on the best of the others, at the
 * same depth, rather than on nothing: the lead reviewer first, then a second
 * opinion on a provider no other reviewer is on, when there is one, so that
 * it is independent; otherwise Anthropic, then OpenAI, then xAI. Every
 * substitution is said. Bots with no model stay named as such.
 *
 * `listings` is what each account offers. An account missing from it is
 * taken to list nothing, so the step asks for them before proposing. One
 * whose listing failed is not proposed on at all: its own bots wait for it,
 * named, rather than moving to another provider over a listing that failed.
 */
export function propose(
  accounts: readonly AccountRef[],
  bots: readonly CrewBot[],
  listings: Readonly<Record<string, AccountListing>> = {},
): Proposal | null {
  if (accounts.length === 0 || bots.length === 0) return null;

  const verified = accounts.filter(isVerified);
  // Nothing is proposed on an account whose list could not be had: a task is
  // refused an id its account does not list, and which it lists is unknown.
  const listable = verified.filter((account) => !listings[account.id]?.error);
  // From what the configuration gives each bot, not what was last saved: a
  // bot moved to another provider is still proposed its recommended one.
  const thinking = thinkingBots(bots.map(asConfigured));
  const placed = new Map<string, ProposalAssignment>();

  for (const bot of thinking) {
    const own = onOwnProvider(bot, listable, listings);
    if (own) placed.set(bot.bot, own);
  }

  // A bot whose own provider's accounts could not be listed waits for them,
  // rather than moving to another provider over one listing that failed.
  const providerOf = (bot: CrewBot): Provider | null => (bot.engine === 'none' ? null : ENGINE_PROVIDER[bot.engine]);
  const waiting = thinking.filter((bot) => {
    const provider = providerOf(bot);
    return (
      !placed.has(bot.bot) &&
      verified.some((account) => account.provider === provider) &&
      !listable.some((account) => account.provider === provider)
    );
  });

  // The lead reviewer first, so that a second opinion can keep off its provider.
  const rest = thinking.filter((bot) => !placed.has(bot.bot) && !waiting.includes(bot));
  const leadFirst = [
    ...rest.filter((bot) => bot.role === 'review_lead'),
    ...rest.filter((bot) => bot.role !== 'review_lead'),
  ];
  for (const bot of leadFirst) {
    const reviewers = thinking.flatMap((one) => {
      const at = placed.get(one.bot);
      if (!at || one.bot === bot.bot || !REVIEWERS.has(one.role ?? '')) return [];
      return [{ role: one.role ?? '', provider: ENGINE_PROVIDER[at.engine] }];
    });
    const other = onAnotherProvider(bot, accounts, verified, listable, listings, reviewers);
    if (other) placed.set(bot.bot, other);
  }

  const assignments = thinking.flatMap((bot) => placed.get(bot.bot) ?? []);
  const uncovered = thinking
    .filter((bot) => !placed.has(bot.bot) && !waiting.includes(bot))
    .map((bot) => bot.bot);
  const modeless = modelessBots(bots).map((bot) => bot.bot);
  // Said as a person reads them: a handle, or the role of a bot not connected yet.
  const said = new Map(bots.map((bot) => [bot.bot, botLabel(bot).said]));
  return {
    sentence: proposalSentence({
      accounts,
      failed: verified.filter((account) => !listable.includes(account)),
      assignments,
      waiting: waiting.map((bot) => ({ bot: bot.bot, provider: providerOf(bot)! })),
      uncovered,
      modeless,
      anyVerified: verified.length > 0,
      saidOf: (bot) => said.get(bot) ?? botLabel({ bot }).said,
    }),
    assignments,
  };
}

function onOwnProvider(
  bot: CrewBot,
  verified: readonly AccountRef[],
  listings: Readonly<Record<string, AccountListing>>,
): ProposalAssignment | null {
  if (bot.engine === 'none') return null;
  const provider = ENGINE_PROVIDER[bot.engine];
  const own = verified.filter((account) => account.provider === provider);
  const model = modelToKeep(bot);
  for (const account of own) {
    // The same model, as this account lists it: not a substitution.
    const listed = offeredAs(listingOf(listings, account.id), model);
    if (listed) return { bot: bot.bot, accountId: account.id, model: listed, engine: bot.engine };
  }

  const tier = tierOf({ model, role: bot.role });
  for (const account of own) {
    const instead = modelFor(provider, tier, listings[account.id]);
    if (instead) {
      return {
        bot: bot.bot,
        accountId: account.id,
        model: instead,
        engine: bot.engine,
        substitution: { kind: 'model', configured: model },
      };
    }
  }
  return null;
}

function onAnotherProvider(
  bot: CrewBot,
  accounts: readonly AccountRef[],
  verified: readonly AccountRef[],
  listable: readonly AccountRef[],
  listings: Readonly<Record<string, AccountListing>>,
  reviewers: readonly { role: string; provider: Provider }[],
): ProposalAssignment | null {
  if (bot.engine === 'none') return null;
  const from = ENGINE_PROVIDER[bot.engine];
  const tier = tierOf({ model: modelToKeep(bot), role: bot.role });
  const options = PROVIDER_ORDER.filter((provider) => provider !== from).flatMap((provider) => {
    for (const account of listable) {
      if (account.provider !== provider) continue;
      const model = modelFor(provider, tier, listings[account.id]);
      if (model) return [{ account, model }];
    }
    return [];
  });
  const first = options[0];
  if (!first) return null;

  let choice = first;
  let lead: 'same' | 'moved' | null = null;
  if (SECOND_OPINIONS.has(bot.role ?? '')) {
    // Independent of every other reviewer, when some provider allows it. When
    // none does, any choice repeats one of theirs, and the usual order decides.
    choice = options.find((option) => !reviewers.some((one) => one.provider === option.account.provider)) ?? first;
    const leads = reviewers.filter((one) => one.role === 'review_lead').map((one) => one.provider);
    if (leads.includes(choice.account.provider)) lead = 'same';
    else if (choice !== first && leads.includes(first.account.provider)) lead = 'moved';
  }

  const why = verified.some((account) => account.provider === from)
    ? 'unlisted'
    : accounts.some((account) => account.provider === from)
      ? 'unverified'
      : 'none';
  return {
    bot: bot.bot,
    accountId: choice.account.id,
    model: choice.model,
    engine: PROVIDER_ENGINE[choice.account.provider],
    substitution: { kind: 'provider', from, why, lead },
  };
}

function proposalSentence({
  accounts,
  failed,
  assignments,
  waiting,
  uncovered,
  modeless: modelessIds,
  anyVerified,
  saidOf,
}: {
  accounts: readonly AccountRef[];
  /** Verified accounts whose list could not be had. */
  failed: readonly AccountRef[];
  assignments: readonly ProposalAssignment[];
  /** Bots whose own provider's accounts are among those. */
  waiting: readonly { bot: string; provider: Provider }[];
  uncovered: readonly string[];
  modeless: readonly string[];
  anyVerified: boolean;
  /** A bot by its name, as a sentence says it. */
  saidOf: (bot: string) => string;
}): string {
  const labelOf = (id: string): string => accounts.find((account) => account.id === id)?.label ?? 'that account';
  const names = (group: { items: ProposalAssignment[] }): string[] => group.items.map((one) => saidOf(one.bot));
  const modeless = modelessIds.map(saidOf);
  const plain = assignments.filter((assignment) => !assignment.substitution);
  const groups = groupBy(plain, (assignment) => assignment.accountId);
  const sentences: string[] = [];
  let modelessSaid = false;

  if (!anyVerified && uncovered.length > 0) {
    sentences.push('No account is verified yet, so there is nothing to propose — verify one on the previous step.');
  } else if (
    groups.length === 1 &&
    plain.length === assignments.length &&
    uncovered.length === 0 &&
    waiting.length === 0
  ) {
    const label = labelOf(groups[0]!.key);
    const count = plain.length;
    const head =
      count === 1 ? `Put the one thinking bot on ${label}` : `Put all ${countWord(count)} thinking bots on ${label}`;
    modelessSaid = modeless.length > 0;
    sentences.push(modelessSaid ? `${head}, and leave ${joinNames(modeless)} without a model.` : `${head}.`);
  } else if (groups.length > 0) {
    const clauses = groups.map((group) => `${joinNames(names(group))} on ${labelOf(group.key)}`);
    sentences.push(
      clauses.length === 1
        ? `Put ${clauses[0]}.`
        : `Put ${clauses.slice(0, -1).join(', ')} and ${clauses[clauses.length - 1]}.`,
    );
  }

  const changedModel = assignments.filter((assignment) => assignment.substitution?.kind === 'model');
  for (const group of groupBy(changedModel, (one) => `${one.accountId}|${one.model}|${configuredOf(one)}`)) {
    const first = group.items[0]!;
    const configured = configuredOf(first);
    const why = isAlias(configured) ? `cannot follow ${aliasTitle(configured)}` : `does not offer ${configured}`;
    const verb = group.items.length === 1 ? 'is' : 'are';
    sentences.push(
      `${joinNames(names(group))} ${verb} proposed ${modelName(first.model)} on ${labelOf(first.accountId)}, which ${why}.`,
    );
  }

  const changedProvider = assignments.filter((assignment) => assignment.substitution?.kind === 'provider');
  for (const group of groupBy(changedProvider, (one) => `${JSON.stringify(one.substitution)}|${one.accountId}|${one.model}`)) {
    const first = group.items[0]!;
    const substitution = first.substitution as Extract<Substitution, { kind: 'provider' }>;
    const one = group.items.length === 1;
    const who = joinNames(names(group));
    const provider = PROVIDER_LABEL[substitution.from];
    const opening =
      substitution.why === 'unlisted'
        ? `${provider} lists nothing to propose for ${who}`
        : `${who} ${one ? 'has' : 'have'} no ${substitution.why === 'unverified' ? 'verified ' : ''}${provider} account`;
    const note =
      substitution.lead === 'same'
        ? `; ${one ? 'its second opinion then comes' : 'their second opinions then come'} from the same provider as the lead reviewer`
        : substitution.lead === 'moved'
          ? `, so ${one ? 'its opinion is' : 'their opinions are'} independent of the lead reviewer’s`
          : '';
    sentences.push(`${opening} — proposed ${modelName(first.model)} on ${labelOf(first.accountId)}${note}.`);
  }

  for (const group of groupBy(failed, (account) => account.provider)) {
    const one = group.items.length === 1;
    const names = waiting.filter((bot) => bot.provider === group.key).map((bot) => saidOf(bot.bot));
    const what = names.length > 0 ? `for ${joinNames(names)}` : `on ${one ? 'it' : 'them'}`;
    sentences.push(
      `${joinNames(group.items.map((account) => account.label))} could not list ${one ? 'its' : 'their'} models, so nothing is proposed ${what} yet.`,
    );
  }
  if (anyVerified && uncovered.length > 0) {
    sentences.push(`Nothing verified can take ${joinNames(uncovered.map(saidOf))} yet.`);
  }
  if (modeless.length > 0 && !modelessSaid) {
    sentences.push(`${joinNames(modeless)} ${modeless.length === 1 ? 'has' : 'have'} no model, and that is correct.`);
  }
  return sentences.map(atStart).join(' ');
}

function configuredOf(assignment: ProposalAssignment): string {
  return assignment.substitution?.kind === 'model' ? assignment.substitution.configured : '';
}

/**
 * Done when every thinking bot that has a compatible account is on one, and
 * none of those can be seen not to run.
 *
 * A bot whose engine has no account yet is named on the proposal; it does not
 * keep the step open after the accounts that do exist have been accepted.
 * `engine: none` is never an assignment. An assigned bot the probe says cannot
 * run — its command is not on the host — is not done: the engines step this
 * replaced held the walkthrough there, and a tick over it would say the crew
 * can think when it cannot. A probe that has not answered is not a no.
 */
export function assignmentStepDone(accounts: readonly AccountRef[], bots: readonly CrewBot[]): boolean {
  // Any account, checked or not. Which bot thinks with which is a fact of its
  // own, and it does not become untrue while a seat waits for its token.
  if (accounts.length === 0) return false;
  return thinkingBots(bots).every((bot) => {
    const compatible = accountsFor(bot.engine, accounts);
    if (compatible.length === 0) return true;
    const assigned = compatible.some((account) => account.id === bot.modelAccountId);
    return assigned && bot.readiness?.ready !== false;
  });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * When a check ran, said the same way on the server and in the browser. A
 * relative "3 minutes ago" is a different string by the time the page
 * hydrates, and a locale's date is a different string in a different place.
 */
export function checkedWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}, ${two(at.getUTCHours())}:${two(at.getUTCMinutes())} UTC`;
}

/**
 * What can be said about a subscription, and why.
 *
 * A check is the evidence: ✓ when the CLI answered a one-line prompt through
 * the seat, with when; × with the CLI's own words when it did not; a tilde
 * when nothing has asked. The readiness probe says one thing that outranks a
 * check — that the command a seat thinks with is not on the host at all,
 * which is true of every account on that engine and fails every task on it.
 * A bot's tick says nothing here: it can come from a key of its own.
 */
export function accountMark(
  account: Pick<AccountRef, 'provider' | 'verifiedAt' | 'verifyError'>,
  crew: readonly CrewBot[],
): { mark: '✓' | '~' | '×'; detail: string | null } {
  const missing = missingCommand(account.provider, crew);
  if (missing) return { mark: '×', detail: missing.detail || null };

  if (account.verifyError) return { mark: '×', detail: account.verifyError };
  if (account.verifiedAt) return { mark: '✓', detail: `verified ${checkedWhen(account.verifiedAt)}` };
  return { mark: '~', detail: null };
}

/** What the probe says about a provider's command, when it says the command is not there. */
function missingCommand(provider: Provider, crew: readonly CrewBot[]): Readiness | null {
  const engine = PROVIDER_ENGINE[provider];
  const bot = crew.find((one) => one.engine === engine && one.readiness?.needsCommand && !one.readiness.hasCommand);
  return bot?.readiness ?? null;
}

/** How an account is given its credential: a pasted token, a sign-in run from here, or a pasted key. */
export type AccountCredential = 'token' | 'sign-in' | 'key';

export function credentialOf(account: Pick<AccountRef, 'provider' | 'kind'>): AccountCredential {
  return subscriptionCredential(account) ?? 'key';
}

/** Where an account stands on the accounts step. See `accountStanding`. */
export interface AccountStanding {
  /** On the verified side, where nothing more is asked of it. */
  verified: boolean;
  mark: '✓' | '~' | '×';
  /** A tick's when, or a cross's reason in the words of whatever said no. */
  detail: string | null;
  /** What the step offers next. Null for a verified account, which is done. */
  next: AccountCredential | 'command' | null;
}

/**
 * Which side of the accounts step an account is on, and what it still needs.
 *
 * The verified side is for what is done and nothing else: a seat a check has
 * proved — the CLI answered one tiny prompt through it — and a key, which the
 * provider accepted before it was stored, until a check says otherwise. Every
 * other account stays with its next step: the token, the sign-in or a new key,
 * beside the mark and the words of whatever said no. That is what took the
 * Verify button away. Shown on every row, it was pressed again on accounts
 * that were already done, because nothing said they were.
 *
 * A command missing from where the bots run outranks a check, as it does in
 * the mark. When the credential was proved already, installing the command is
 * all that is left, so that is the step, rather than a token to paste again.
 */
export function accountStanding(account: AccountRef, crew: readonly CrewBot[]): AccountStanding {
  const credential = credentialOf(account);
  const { mark, detail } = accountMark(account, crew);
  const proved = isVerified(account);

  if (missingCommand(account.provider, crew)) {
    return { verified: false, mark, detail, next: proved ? 'command' : credential };
  }
  if (mark === '✓') return { verified: true, mark, detail, next: null };
  if (account.kind === 'key' && proved) {
    return { verified: true, mark: '✓', detail: keyAcceptedCopy(account.provider), next: null };
  }
  return { verified: false, mark, detail, next: credential };
}

/** A key nothing has checked since it was stored, which the provider did before it was. */
export function keyAcceptedCopy(provider: Provider): string {
  return `accepted by ${PROVIDER_LABEL[provider]} when it was saved`;
}

/** "Anthropic · subscription": what an account is, under its label. */
export function accountKindLine(account: Pick<AccountRef, 'provider' | 'kind'>): string {
  return `${PROVIDER_LABEL[account.provider]} · ${account.kind === 'key' ? 'API key' : 'subscription'}`;
}

export interface AccountTag {
  label: string;
  tone: 'signal' | 'neutral';
  /** Which bots, when the tag counts them: each by its handle, or by its role before it connects. */
  names?: string;
}

/**
 * The small tags on a verified account, in the manner of the crew step's:
 * whether any bot thinks with it yet, and what OpenADLC holds for it.
 */
export function accountTags(account: AccountRef, crew: readonly CrewBot[]): AccountTag[] {
  const on = crew.filter((bot) => bot.modelAccountId === account.id);
  const held = account.kind === 'key' ? 'key stored' : account.provider === 'anthropic' ? 'token stored' : 'signed in';
  return [
    ...(on.length > 0
      ? [
          {
            label: `${on.length} ${on.length === 1 ? 'bot' : 'bots'} on it`,
            tone: 'signal' as const,
            names: on.map((bot) => botLabel(bot).text).join(', '),
          },
        ]
      : []),
    { label: held, tone: 'neutral' },
  ];
}

/** A line of copy ending as a sentence does, whatever the CLI ended it with. */
export function asSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * A sign-in's state from the bridge's answer, or null when it is not one.
 *
 * The link is rendered as a link, so it has to be an https URL: anything else
 * — a `javascript:` URL above all — is not a sign-in at all.
 */
export function loginStateFrom(body: unknown): LoginState | null {
  const row = asRecord(body);
  switch (row?.state) {
    case 'waiting': {
      if (typeof row.url !== 'string' || typeof row.code !== 'string' || !row.code.trim()) return null;
      try {
        if (new URL(row.url).protocol !== 'https:') return null;
      } catch {
        return null;
      }
      return {
        state: 'waiting',
        url: row.url,
        code: row.code.trim(),
        startedAt: typeof row.startedAt === 'string' ? row.startedAt : '',
      };
    }
    case 'signed-in':
      return { state: 'signed-in' };
    case 'failed':
      return { state: 'failed', message: typeof row.message === 'string' && row.message ? row.message : 'the sign-in failed' };
    case 'signed-out':
      return { state: 'signed-out' };
    default:
      return null;
  }
}

export function checkFrom(body: unknown): AccountCheck | null {
  const row = asRecord(body);
  if (!row || typeof row.ok !== 'boolean' || typeof row.checkedAt !== 'string') return null;
  return { ok: row.ok, message: typeof row.message === 'string' ? row.message : '', checkedAt: row.checkedAt };
}

/**
 * A pause that ends early when `signal` aborts. The listener goes when the
 * timer fires: a sign-in polled on the page's one signal every three seconds
 * for sixteen minutes used to leave some 320 behind.
 */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Runs the account's check. A refusal is an error to show, not a verdict to record. */
export async function verifyAccount(
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<{ check: AccountCheck | null; error: string | null }> {
  try {
    const response = await fetcher(accountVerifyPath(id), { method: 'POST' });
    if (!response.ok) return { check: null, error: await readBridgeError(response) };
    const check = checkFrom(await response.json());
    return check ? { check, error: null } : { check: null, error: 'the bridge answered something that is not a check' };
  } catch (cause) {
    return { check: null, error: cause instanceof Error ? cause.message : 'could not verify' };
  }
}

/** Starts an OpenAI or xAI seat's sign-in. A refusal comes back as a failed sign-in, in the bridge's words. */
export async function startSignIn(id: string, fetcher: typeof fetch = fetch): Promise<LoginState> {
  try {
    const response = await fetcher(accountLoginPath(id), { method: 'POST' });
    if (!response.ok) return { state: 'failed', message: await readBridgeError(response) };
    return loginStateFrom(await response.json()) ?? { state: 'failed', message: 'the sign-in printed no link to follow' };
  } catch (cause) {
    return { state: 'failed', message: cause instanceof Error ? cause.message : 'could not start the sign-in' };
  }
}

/**
 * Where a sign-in stands, or null when the answer could not be had — the
 * bridge restarting, or busy for a moment — which is no news, not a failure.
 * Any other refusal is an answer, and a failed sign-in in the bridge's words:
 * a 404 for an account removed in another tab used to read as "waiting" for
 * sixteen minutes, then as a sign-in not finished in time.
 */
export async function readSignIn(id: string, fetcher: typeof fetch = fetch): Promise<LoginState | null> {
  try {
    const response = await fetcher(accountLoginPath(id), { cache: 'no-store' });
    if (response.ok) return loginStateFrom(await response.json());
    if (response.status >= 500 || response.status === 408 || response.status === 429) return null;
    return { state: 'failed', message: await readBridgeError(response) };
  } catch {
    return null;
  }
}

/**
 * Follows a sign-in until the operator has finished it in their browser.
 *
 * Asked every three seconds while it is waiting. A poll that gets no answer
 * is skipped rather than shown, because the bridge restarting for a moment
 * is not the sign-in failing. Once signed in, the account is checked straight
 * away, which is what turns its tilde into a tick — or into a cross that says
 * why. Stops when the page goes, through `signal`.
 */
export async function followSignIn(
  id: string,
  from: LoginState,
  on: { state: (state: LoginState) => void; check: (outcome: { check: AccountCheck | null; error: string | null }) => void },
  options: { fetcher?: typeof fetch; pause?: (ms: number, signal?: AbortSignal) => Promise<void>; signal?: AbortSignal; now?: () => number } = {},
): Promise<LoginState> {
  const fetcher = options.fetcher ?? fetch;
  const pause = options.pause ?? wait;
  const now = options.now ?? Date.now;
  const until = now() + SIGN_IN_WINDOW_MS;

  let state = from;
  on.state(state);
  while (state.state === 'waiting') {
    await pause(LOGIN_POLL_MS, options.signal);
    if (options.signal?.aborted) return state;
    if (now() > until) {
      state = { state: 'failed', message: 'the sign-in was not finished in time — sign in again for a new code' };
      on.state(state);
      return state;
    }
    const next = await readSignIn(id, fetcher);
    if (options.signal?.aborted) return state;
    if (!next) continue;
    state = next;
    on.state(state);
  }

  if (state.state === 'signed-in') on.check(await verifyAccount(id, fetcher));
  return state;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

export function accountsFrom(body: unknown): AccountRef[] {
  const record = asRecord(body);
  const list = record && Array.isArray(record.accounts) ? record.accounts : [];
  const accounts: AccountRef[] = [];
  for (const entry of list) {
    const row = asRecord(entry);
    const provider = typeof row?.provider === 'string' ? row.provider : '';
    const kind = typeof row?.kind === 'string' ? row.kind : '';
    if (!row || typeof row.id !== 'string' || !isProvider(provider) || !isAccountKind(kind)) continue;
    accounts.push({
      id: row.id,
      provider,
      kind,
      label: typeof row.label === 'string' ? row.label : '',
      verifiedAt: typeof row.verifiedAt === 'string' ? row.verifiedAt : null,
      verifyError: typeof row.verifyError === 'string' ? row.verifyError : null,
    });
  }
  return accounts;
}

function readinessFrom(value: unknown): Readiness | null {
  const row = asRecord(value);
  if (!row || typeof row.ready !== 'boolean') return null;
  const confidence = row.confidence === 'binary-only' ? 'binary-only' : 'certain';
  const source = asRecord(row.keySource);
  return {
    ready: row.ready,
    confidence,
    detail: typeof row.detail === 'string' ? row.detail : '',
    remedy: typeof row.remedy === 'string' ? row.remedy : '',
    keySource:
      source && typeof source.url === 'string'
        ? {
            envVar: typeof source.envVar === 'string' ? source.envVar : '',
            url: source.url,
            label: typeof source.label === 'string' ? source.label : 'the provider',
          }
        : null,
    hasKey: row.hasKey === true,
    needsCommand: typeof row.needsCommand === 'string' ? row.needsCommand : null,
    hasCommand: row.hasCommand === true,
  };
}

export function crewFromEngines(body: unknown): CrewBot[] {
  const record = asRecord(body);
  const list = record && Array.isArray(record.bots) ? record.bots : [];
  const crew: CrewBot[] = [];
  for (const entry of list) {
    const row = asRecord(entry);
    const engine = typeof row?.engine === 'string' ? row.engine : '';
    if (!row || typeof row.bot !== 'string' || !isCrewEngine(engine)) continue;
    const configuredEngine = typeof row.configuredEngine === 'string' ? row.configuredEngine : '';
    crew.push({
      bot: row.bot,
      ...(typeof row.slot === 'string' && row.slot ? { slot: row.slot } : {}),
      ...(typeof row.connected === 'boolean' ? { connected: row.connected } : {}),
      ...(typeof row.role === 'string' ? { role: row.role } : {}),
      roleLabel: typeof row.roleLabel === 'string' ? row.roleLabel : '',
      engine,
      model: typeof row.model === 'string' ? row.model : '',
      modelAccountId: typeof row.modelAccountId === 'string' ? row.modelAccountId : null,
      readiness: readinessFrom(row.readiness),
      ...(isCrewEngine(configuredEngine) ? { configuredEngine } : {}),
      ...(typeof row.configuredModel === 'string' && row.configuredModel ? { configuredModel: row.configuredModel } : {}),
    });
  }
  return crew;
}

export function modelsFrom(body: unknown): ListedModel[] {
  const record = asRecord(body);
  const list = record && Array.isArray(record.models) ? record.models : [];
  const models: ListedModel[] = [];
  for (const entry of list) {
    const row = asRecord(entry);
    if (!row || typeof row.id !== 'string' || !row.id) continue;
    models.push({
      id: row.id,
      createdAt: typeof row.createdAt === 'string' ? row.createdAt : null,
      isDefault: row.isDefault === true,
    });
  }
  return models;
}

const ALIAS = /^newest:[a-z0-9][a-z0-9._-]*$/i;

/** The families an account says it can follow. Anything else in the list is not one. */
export function aliasesFrom(body: unknown): string[] {
  const record = asRecord(body);
  const list = record && Array.isArray(record.aliases) ? record.aliases : [];
  return [...new Set(list.filter((one): one is string => typeof one === 'string' && ALIAS.test(one)))];
}

/** `GET /v1/model-accounts/:id/models`, read: what the account offers and which families it follows. */
export function listingFrom(body: unknown): AccountListing {
  return { models: modelsFrom(body), aliases: aliasesFrom(body), error: null };
}

/** How many model ids a line of what an account offers names before it counts the rest. */
const OFFERED_SHOWN = 4;

/**
 * What an account offers, in a line under it: its models newest first, the
 * rest counted, or why it could not say. Null until it has been asked.
 */
export function offeredLine(listing: AccountListing | undefined): { text: string; tone: 'plain' | 'error' } | null {
  if (!listing) return null;
  if (listing.error) return { text: `Could not list its models: ${listing.error}`, tone: 'error' };
  if (listing.models.length === 0) return { text: 'It did not list any models.', tone: 'plain' };
  const ids = [...listing.models].sort(byNewest).map((model) => model.id);
  const shown = ids.slice(0, OFFERED_SHOWN).join(', ');
  const more = ids.length - OFFERED_SHOWN;
  return { text: `Offers ${shown}${more > 0 ? `, and ${more} more` : ''}`, tone: 'plain' };
}

/** What a row saves: either half of an assignment, or both. */
export interface AssignmentPatch {
  model?: string;
  modelAccountId?: string | null;
}

/** A saved assignment, as the crew shows it: the bridge may answer that the bot now runs another engine. */
export interface AssignmentChange extends AssignmentPatch {
  engine?: CrewEngine;
}

/** The console's routes, with a bot name or an account id as one path segment. */
export function assignmentPath(bot: string): string {
  return `/api/bots/${encodeURIComponent(bot)}/assignment`;
}

export function accountModelsPath(id: string): string {
  return `/api/model-accounts/${encodeURIComponent(id)}/models`;
}

export function accountRemovePath(id: string): string {
  return `/api/model-accounts/${encodeURIComponent(id)}/remove`;
}

/** Where a key, or a Claude seat's token, is replaced. */
export function accountTokenPath(id: string): string {
  return `/api/model-accounts/${encodeURIComponent(id)}/key`;
}

export function accountLoginPath(id: string): string {
  return `/api/model-accounts/${encodeURIComponent(id)}/login`;
}

export function accountVerifyPath(id: string): string {
  return `/api/model-accounts/${encodeURIComponent(id)}/verify`;
}

/**
 * Saves a Claude seat's token, or a key account's new key. The answer never
 * carries it back; a refusal is the bridge's words, which say what a token
 * looks like, or the provider's about a key, and not what was pasted. Returns
 * the refusal, or null.
 */
export async function saveCredential(id: string, secret: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetcher(accountTokenPath(id), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: secret.trim() }),
    });
    return response.ok ? null : await readBridgeError(response);
  } catch (cause) {
    return cause instanceof Error ? cause.message : 'could not save that';
  }
}

/** What a check came to, or why it could not be asked for. See `verifyAccount`. */
export type CheckOutcome = { check: AccountCheck | null; error: string | null };

/**
 * A Claude seat's token saved, then checked straight away.
 *
 * The bridge forgets the last check when a token changes, because it was
 * about the old one. With a Verify button to press after, people pressed it,
 * and then pressed it again, not sure it had counted; now saving is the check.
 * A refusal is the bridge's words, and then nothing is checked. `saved` is
 * called between the two, so the page can say which of them it is waiting on.
 */
export async function saveTokenAndVerify(
  id: string,
  token: string,
  options: { fetcher?: typeof fetch; saved?: () => void } = {},
): Promise<{ refused: string | null } & CheckOutcome> {
  const fetcher = options.fetcher ?? fetch;
  const refused = await saveCredential(id, token, fetcher);
  if (refused) return { refused, check: null, error: null };
  options.saved?.();
  return { refused: null, ...(await verifyAccount(id, fetcher)) };
}

/** The id of the account `POST /v1/model-accounts` answered with, or null. */
export function addedAccountId(body: unknown): string | null {
  const account = asRecord(asRecord(body)?.account);
  return typeof account?.id === 'string' && account.id ? account.id : null;
}

/**
 * Adds an account, and checks it straight away when it came with a token.
 *
 * A Claude seat's token is only looked at for its shape on the way in, so the
 * check is what proves it, and it runs as part of adding rather than waiting
 * for a button. A key needs no check here: the provider listed models with it
 * before the bridge stored it. An OpenAI or xAI seat has nothing to check
 * until it is signed in, which is its next step. Returns the bridge's refusal,
 * or the new account's id and what the check came to; `added` is called in
 * between, once the account exists.
 */
export async function addAccount(
  input: Parameters<typeof accountRequestBody>[0],
  options: { fetcher?: typeof fetch; added?: (id: string) => void } = {},
): Promise<{ refused: string | null; id: string | null; checked: CheckOutcome | null }> {
  const fetcher = options.fetcher ?? fetch;
  const body = accountRequestBody(input);
  let response: Response;
  try {
    response = await fetcher('/api/model-accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    return { refused: cause instanceof Error ? cause.message : 'could not add that', id: null, checked: null };
  }
  if (!response.ok) return { refused: await readBridgeError(response), id: null, checked: null };

  const id = addedAccountId(await response.json().catch(() => null));
  if (!id) return { refused: null, id: null, checked: null };
  options.added?.(id);
  const token = body.kind === 'subscription' && Boolean(body.key);
  return { refused: null, id, checked: token ? await verifyAccount(id, fetcher) : null };
}

export function withAssignment(crew: readonly CrewBot[], bot: string, change: AssignmentChange): CrewBot[] {
  return crew.map((one) =>
    one.bot === bot
      ? {
          ...one,
          ...(change.engine !== undefined ? { engine: change.engine } : {}),
          ...(change.model !== undefined ? { model: change.model } : {}),
          ...(change.modelAccountId !== undefined ? { modelAccountId: change.modelAccountId } : {}),
        }
      : one,
  );
}

type CrewUpdate = (update: (current: CrewBot[] | null) => CrewBot[] | null) => void;

/** The engine the bridge says a bot runs now, from the `{ bot }` a save answers with. */
function savedEngine(body: unknown): CrewEngine | null {
  const engine = asRecord(asRecord(body)?.bot)?.engine;
  return typeof engine === 'string' && isCrewEngine(engine) ? engine : null;
}

/**
 * Saves one row, and applies it to the crew as it is when the answer arrives.
 *
 * The update is a function of the current crew. Built from the crew a render
 * captured, two rows saved in quick succession each wrote back the other's
 * old value, and the screen showed one assignment the bridge did not have.
 * On another provider's account the bot runs that provider's engine, and the
 * engine applied is the one the bridge answered with. Returns the bridge's
 * refusal, or null.
 */
export async function saveAssignment(
  bot: string,
  patch: AssignmentPatch,
  setCrew: CrewUpdate,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  const response = await fetcher(assignmentPath(bot), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!response.ok) return readBridgeError(response);
  const engine = savedEngine(await response.json().catch(() => null));
  setCrew((current) => (current ? withAssignment(current, bot, { ...patch, ...(engine ? { engine } : {}) }) : current));
  return null;
}

/** What a bot's row shows: the account it would think with, and the model. */
export interface AssignmentDraft {
  accountId: string | null;
  model: string;
}

/**
 * The assignment a row shows for a bot.
 *
 * What somebody chose on the row, when they chose something. Otherwise a bot
 * on no account starts at its proposal — shown, and not saved — and one on an
 * account starts where it is.
 */
export function draftFor(
  bot: Pick<CrewBot, 'modelAccountId' | 'model'>,
  edit: AssignmentDraft | undefined,
  proposal: Pick<ProposalAssignment, 'accountId' | 'model'> | null,
): AssignmentDraft {
  if (edit) return edit;
  if (!bot.modelAccountId && proposal) return { accountId: proposal.accountId, model: proposal.model };
  return { accountId: bot.modelAccountId, model: bot.model };
}

/** What the walkthrough's forward button says. */
export function forwardLabel(input: { done: boolean; blocked: boolean }): string {
  if (input.done) return 'continue';
  return input.blocked ? 'continue anyway' : 'skip for now';
}

/**
 * How long one account's listing is waited for. The proposal waits for every
 * account's, so one that never answers must not hold it for ever; it becomes
 * that account's error instead.
 */
export const LISTING_WAIT_MS = 20_000;

/**
 * What each account offers, or why it could not be listed.
 *
 * A failed listing is an error to show, not an empty catalogue: shown as
 * nothing, it read as an account that can call nothing, and the picker quietly
 * offered only what was already stored. A provider's refusal is shown in its
 * words. A 409 is an account with no credential stored yet, which is a thing
 * to do rather than a failure: save its token, or its key, first.
 */
export async function listModelsFor(
  accounts: readonly (Pick<AccountRef, 'id'> & Partial<Pick<AccountRef, 'kind'>>)[],
  fetcher: typeof fetch = fetch,
  waitMs: number = LISTING_WAIT_MS,
): Promise<Record<string, AccountListing>> {
  const listed = await Promise.all(
    accounts.map(async (account): Promise<[string, AccountListing]> => {
      try {
        const response = await fetcher(accountModelsPath(account.id), {
          cache: 'no-store',
          signal: AbortSignal.timeout(waitMs),
        });
        if (response.status === 409) {
          const credential = account.kind === 'key' ? 'key' : 'token';
          return [account.id, { ...EMPTY_LISTING, error: `save its ${credential} first` }];
        }
        if (!response.ok) return [account.id, { ...EMPTY_LISTING, error: await readBridgeError(response) }];
        return [account.id, listingFrom(await response.json())];
      } catch (cause) {
        const error =
          cause instanceof Error && cause.name === 'TimeoutError'
            ? 'the account did not say what it offers in time'
            : cause instanceof Error
              ? cause.message
              : 'could not list models';
        return [account.id, { ...EMPTY_LISTING, error }];
      }
    }),
  );
  return Object.fromEntries(listed);
}

export async function readBridgeError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === 'string' && body.error.trim()) return body.error.trim();
  } catch {
    // The bridge usually answers JSON. A proxy that did not still has a body.
  }
  const trimmed = text.trim();
  return trimmed.slice(0, 300) || `the bridge answered ${response.status}`;
}

/**
 * How long the onboarding page waits for `/v1/engines` before rendering
 * without it. That route asks hostd's readiness probe, and a hostd that does
 * not answer used to hold the walkthrough's first paint for as long as it
 * did not answer.
 */
export const ENGINES_WAIT_MS = 3_000;

/** A JSON body, or null when the answer is not ok, fails, or is later than `ms`. */
export async function jsonWithin(
  url: string,
  init: RequestInit,
  ms: number,
  fetcher: typeof fetch = fetch,
): Promise<unknown | null> {
  try {
    const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(ms) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}
