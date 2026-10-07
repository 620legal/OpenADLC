import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseYamlFile } from '@fleetadlc/shared';

/**
 * Cost is charged per million tokens.
 *
 * The table below is a default and will go stale: a vendor changes its prices
 * without asking, and this repository is not where an install should have to
 * edit them. The install's own `config/models.yaml` is the override. hostd
 * reads it from `FLEETADLC_CONFIG_ROOT` when it starts (`readModelPrices`) and
 * hands the table to every session in `FLEETADLC_MODEL_PRICES`, which is all a
 * session reads (`loadModelPrices`). A session used to read the file from its
 * working directory, which is the task's clone of a managed repository: the
 * install's file was never read, and a pull request carrying a
 * `config/models.yaml` priced its own review, at 0 or below.
 *
 * ```yaml
 * models:
 *   claude-opus-5:
 *     inPerMtok: 5
 *     outPerMtok: 25
 *   gpt-5-codex:
 *     inPerMtok: 1.25
 *     cachedInPerMtok: 0.125
 *     outPerMtok: 10
 * ```
 */
export interface ModelPrice {
  inPerMtok: number;
  outPerMtok: number;
  /**
   * Input the provider served from its cache, which it bills at a fraction of
   * `inPerMtok`. Codex reports it inside its input count, and pricing all of
   * it at the full rate overstated a long review several times over on input,
   * so a task's cap tripped early. Claude Code reports it as
   * `cache_read_input_tokens`. Unset, it is a tenth of `inPerMtok` for a
   * `claude-*` model (Anthropic's cache-read rate) and `inPerMtok` for any
   * other, which overcharges rather than under.
   */
  cachedInPerMtok?: number;
  /**
   * Input written to the provider's cache, which Claude Code reports as
   * `cache_creation_input_tokens`. Unset, it is 1.25 times `inPerMtok` for a
   * `claude-*` model (Anthropic's five-minute cache write) and `inPerMtok` for
   * any other.
   */
  cacheWritePerMtok?: number;
}

/** A run's tokens by how each is billed. `input` is the uncached part. */
export interface TokenCounts {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/**
 * Defaults, checked against the vendors on the dates noted on each row. A
 * vendor can change a rate without asking. The cap in `config/costs.yaml` is
 * what actually stops spend; these numbers decide how quickly it is reached,
 * so an install with a negotiated rate sets `config/models.yaml`.
 */
const DEFAULT_PRICES: Record<string, ModelPrice> = {
  // Corrected 2026-09-22 against Anthropic's published rates. They had been
  // wrong in the direction that matters: Opus was charged at $15/$75, three
  // times its real price, so a task tripped the per-task cap at a third of the
  // spend the cap was meant to allow — and the ledger, the budget and every
  // "what did this cost" answer were wrong by the same multiple.
  'claude-opus-5': { inPerMtok: 5, outPerMtok: 25 },
  'claude-sonnet-5': { inPerMtok: 2, outPerMtok: 10 },
  'claude-haiku-4-5': { inPerMtok: 1, outPerMtok: 5 },
  // Checked 2026-09-24 against Anthropic's published model table: the models
  // a Claude account lists today, now that a bot can be given any of them.
  // Each is named because the rule below would price it wrongly. Anthropic
  // writes a point release with a hyphen, so `claude-opus-5-5` reads as a
  // snapshot of Opus 5 and was charged Opus 5's $5 / $25; and an id the table
  // did not know fell to the $5 / $20 fallback, which charged Fable half of
  // its $10 / $50, Opus 4.x $20 of its $25 output and Sonnet 4.6 more than
  // its $3 / $15.
  'claude-opus-5-5': { inPerMtok: 4, outPerMtok: 20 },
  'claude-fable-5-1': { inPerMtok: 10, outPerMtok: 50 },
  'claude-fable-5': { inPerMtok: 10, outPerMtok: 50 },
  'claude-opus-4-8': { inPerMtok: 5, outPerMtok: 25 },
  'claude-opus-4-7': { inPerMtok: 5, outPerMtok: 25 },
  'claude-opus-4-6': { inPerMtok: 5, outPerMtok: 25 },
  'claude-sonnet-4-6': { inPerMtok: 3, outPerMtok: 15 },
  // Checked 2026-09-23. This id was an alias of `grok-4-0709`, whose own
  // published rate was $3 input / $15 output per million tokens (xAI models
  // catalog; still that price on the 2026-01-15 docs snapshot). On 2026-05-15
  // xAI retired the slug. The migration guide still published on this date
  // says a request to it is billed at grok-4.3's rate, $1.25 / $2.50, and the
  // 2026-06-16 models catalog lists `grok-4` itself as an alias of grok-4.3 at
  // that rate. The pricing page confirms grok-4.3's standard rate — prompts
  // under 200k tokens — is $1.25 / $2.50. At or above 200k tokens the same
  // page bills $2.50 / $5, which this single rate does not represent.
  'grok-4': { inPerMtok: 1.25, outPerMtok: 2.5 },
  // Named on its own because the prefix match below stops at a hyphen: a later
  // `grok-4.x` is a different model at a different rate, not a snapshot of
  // this one, and it must not inherit the cheapest grok price.
  'grok-4.3': { inPerMtok: 1.25, outPerMtok: 2.5 },
  // Checked 2026-09-24 against xAI's models page: $2 input and $6 output per
  // million tokens for prompts under 200k, twice that at or above. These are
  // what `grok models` offers a SuperGrok subscription, 4.7 by default, and a
  // subscription reports a cost of 0, so this table is the only price a grok
  // task has. `grok-4.7-build-fast`, which the page does not list, is priced as
  // grok-4.7 by the snapshot rule below.
  'grok-4.7': { inPerMtok: 2, outPerMtok: 6 },
  'grok-4.6': { inPerMtok: 2, outPerMtok: 6 },
  'grok-4.5': { inPerMtok: 2, outPerMtok: 6 },
  // Checked 2026-09-23 against OpenAI's gpt-5-codex model page: $1.25 input
  // and $10 output per million tokens. Cached input is OpenAI's gpt-5 rate, a
  // tenth of input.
  'gpt-5-codex': { inPerMtok: 1.25, cachedInPerMtok: 0.125, outPerMtok: 10 },
  mock: { inPerMtok: 0, outPerMtok: 0 },
};

/** The variable a session is handed the install's prices in, as JSON. */
export const MODEL_PRICES_ENV = 'FLEETADLC_MODEL_PRICES';

const overrides = new Map<string, ModelPrice>();

export function setModelPrice(model: string, price: ModelPrice): void {
  overrides.set(model, price);
}

/** Forgets what `FLEETADLC_MODEL_PRICES` last provided, and which ids were warned about. For tests. */
export function resetModelPrices(): void {
  overrides.clear();
  warned.clear();
  loaded = false;
}

/** The fallback's rate: a guess, for an id nothing here or in `config/models.yaml` prices. */
const FALLBACK: ModelPrice = { inPerMtok: 5, outPerMtok: 20 };

/** The ids already warned about: `modelPrice` is called on every turn, and one line per id is enough. */
const warned = new Set<string>();

let loaded = false;

/**
 * A rate is a number of dollars, 0 or more. A negative one was recorded as
 * negative spend, and one such row took the month's total below zero and
 * switched off every monthly cap.
 */
function rate(where: string, model: string, key: keyof ModelPrice, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${where}: ${model}'s ${key} must be a number of dollars, 0 or more; it is ${JSON.stringify(value) ?? 'missing'}`);
  }
  return value;
}

/** Checks a `models:` map whole, so a table with one bad row is never half used. */
function checkPrices(models: unknown, where: string): Record<string, ModelPrice> {
  if (!models || typeof models !== 'object' || Array.isArray(models)) {
    throw new Error(`${where} has no \`models:\` map of model ids to prices`);
  }
  const table: Record<string, ModelPrice> = {};
  for (const [model, entry] of Object.entries(models as Record<string, unknown>)) {
    const price = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    table[model] = {
      inPerMtok: rate(where, model, 'inPerMtok', price.inPerMtok),
      outPerMtok: rate(where, model, 'outPerMtok', price.outPerMtok),
      ...(price.cachedInPerMtok !== undefined
        ? { cachedInPerMtok: rate(where, model, 'cachedInPerMtok', price.cachedInPerMtok) }
        : {}),
      ...(price.cacheWritePerMtok !== undefined
        ? { cacheWritePerMtok: rate(where, model, 'cacheWritePerMtok', price.cacheWritePerMtok) }
        : {}),
    };
  }
  return table;
}

/**
 * The install's `<configRoot>/models.yaml`, checked. A missing file is the
 * normal case and means the defaults stand; a malformed one, or one with a
 * price that is negative or not a number, throws with the file's path, so
 * hostd and the bridge stop at start rather than an install learning from the
 * bill that a price it wrote was not used.
 */
export function readModelPrices(configRoot: string): Record<string, ModelPrice> {
  const path = join(configRoot, 'models.yaml');
  if (!existsSync(path)) return {};
  const parsed = parseYamlFile(path) as { models?: unknown } | null;
  return checkPrices(parsed?.models, path);
}

/** The install's prices as a session is handed them; nothing when there are none. */
export function modelPricesEnv(prices: Record<string, ModelPrice>): Record<string, string> {
  return Object.keys(prices).length > 0 ? { [MODEL_PRICES_ENV]: JSON.stringify(prices) } : {};
}

/**
 * Takes the prices hostd handed this session, once. It never looks at the
 * working directory: that is a managed repository's checkout, and what it
 * carries at `config/models.yaml` is not the install's to price by. With
 * nothing handed over, the defaults stand.
 */
export function loadModelPrices(): void {
  if (loaded) return;
  const text = process.env[MODEL_PRICES_ENV];
  let table: Record<string, ModelPrice> = {};
  if (text) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`${MODEL_PRICES_ENV} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    table = checkPrices(parsed, MODEL_PRICES_ENV);
  }
  for (const [model, price] of Object.entries(table)) overrides.set(model, price);
  // Only once the whole table has been taken: a failed load is tried again,
  // never left half applied.
  loaded = true;
}

export function modelPrice(model: string): ModelPrice {
  loadModelPrices();
  const override = overrides.get(model);
  if (override) return override;
  const exact = DEFAULT_PRICES[model];
  if (exact) return exact;
  // A last resort for an id this table does not know — a dated snapshot of an
  // older model, or one a provider added after this was written. It is not a
  // licence to configure dated ids: a current model's id is complete as it
  // stands, and `claude-haiku-4-5-20251001` was a configuration mistake this
  // prefix match quietly absorbed for months rather than surfacing.
  //
  // A snapshot extends its model's id with a hyphen (`grok-4-0709`). A next
  // version extends it with a dot (`grok-4.7`), and is a different price, so
  // it falls through to the $5 / $20 fallback. That is a guess, not a safe
  // side: it overcharges a model cheaper than that (every grok-4.x today) and
  // undercharges a dearer one (it charged Fable half its price), so name every
  // model a seat may run here or in config/models.yaml. An id priced by it is
  // warned about once, since the id `newest:` resolves to is often one this
  // table has not met.
  const family = Object.keys(DEFAULT_PRICES)
    .filter((key) => model.startsWith(`${key}-`))
    // Longest first, so `claude-haiku-4-5` wins over a shorter prefix.
    .sort((a, b) => b.length - a.length)[0];
  if (family) return DEFAULT_PRICES[family] as ModelPrice;
  if (!warned.has(model)) {
    warned.add(model);
    console.warn(
      `[engines] no price for ${model}; charged at the $${FALLBACK.inPerMtok} in / $${FALLBACK.outPerMtok} out fallback, which may be too high or too low. Add it to config/models.yaml`,
    );
  }
  return FALLBACK;
}

/**
 * What tokens cost, unrounded, so that many small messages add up to what they
 * cost rather than each rounding to nothing. Claude Code's cache rates default
 * to Anthropic's: a long agentic run is mostly cached input, and priced at 0
 * it reached the ledger only on the run's last line, after a $15 cap was long
 * passed.
 */
export function exactCost(model: string, tokens: TokenCounts): number {
  const price = modelPrice(model);
  const claude = model.startsWith('claude-');
  const read = price.cachedInPerMtok ?? (claude ? price.inPerMtok * 0.1 : price.inPerMtok);
  const write = price.cacheWritePerMtok ?? (claude ? price.inPerMtok * 1.25 : price.inPerMtok);
  return (
    (Math.max(tokens.input, 0) * price.inPerMtok +
      Math.max(tokens.cacheRead, 0) * read +
      Math.max(tokens.cacheWrite, 0) * write +
      Math.max(tokens.output, 0) * price.outPerMtok) /
    1_000_000
  );
}

/** `cachedIn` is the part of `tokensIn` the provider served from its cache. */
export function costOf(model: string, tokensIn: number, tokensOut: number, cachedIn = 0): number {
  const cached = Math.min(Math.max(cachedIn, 0), tokensIn);
  const cost = exactCost(model, { input: tokensIn - cached, cacheRead: cached, cacheWrite: 0, output: tokensOut });
  return Math.round(cost * 10_000) / 10_000;
}
