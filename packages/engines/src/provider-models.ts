import type { AvailableModel } from './model-choice.js';

/**
 * Proving a key by asking the provider what it can call.
 *
 * The same move as listing the repositories an app can reach: a paste that is
 * stored first and checked never is how an install ends up with a credential
 * that cannot do the thing it was pasted to do. The list is also what an
 * assignment needs, because a model the account cannot call has to be refused
 * rather than substituted.
 */
export const MODEL_PROVIDERS = ['anthropic', 'openai', 'xai'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export const PROVIDER_MODELS_URL: Record<ModelProvider, string> = {
  anthropic: 'https://api.anthropic.com/v1/models',
  openai: 'https://api.openai.com/v1/models',
  xai: 'https://api.x.ai/v1/models',
};

/** The provider said this key cannot list models. `message` is their words. */
export class ProviderKeyRejected extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'ProviderKeyRejected';
  }
}

export function scrubSecret(message: string, secret: string): string {
  const value = secret.trim();
  if (!value) return message;
  return message.split(value).join('[redacted]');
}

interface ModelsPage {
  data?: unknown;
  has_more?: unknown;
  last_id?: unknown;
  error?: unknown;
  message?: unknown;
}

function messageFrom(body: string, status: number, noun: string): string {
  const trimmed = body.trim();
  if (!trimmed) return `the provider refused this ${noun} (${status})`;

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const error = parsed.error;
    if (typeof error === 'string' && error.trim()) return error.trim();
    if (error && typeof error === 'object' && 'message' in error) {
      const message = (error as { message: unknown }).message;
      if (typeof message === 'string' && message.trim()) return message.trim();
    }
    if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message.trim();
  } catch {
    // The body itself is what the provider said.
  }

  return trimmed.slice(0, 300);
}

function createdAtOf(entry: Record<string, unknown>): string | null {
  const iso = entry.created_at ?? entry.createdAt;
  if (typeof iso === 'string' && iso.trim()) return iso.trim();

  const unix = entry.created;
  if (typeof unix === 'number' && Number.isFinite(unix)) {
    const ms = unix > 1e12 ? unix : unix * 1000;
    return new Date(ms).toISOString();
  }

  return null;
}

function modelsFrom(data: unknown): AvailableModel[] {
  if (!Array.isArray(data)) return [];
  const models: AvailableModel[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== 'string' || record.id.trim().length === 0) continue;
    models.push({ id: record.id, createdAt: createdAtOf(record) });
  }
  return models;
}

/**
 * The families a bot can think with, by the part of an id after its provider
 * word: `gpt-5`, `gpt-4o`, `o3`, `grok-4.7`, `grok-code`. `gpt-image-1`,
 * `gpt-realtime`, `sora-2`, `tts-1` and `grok-imagine-video` name no version
 * there, so a family nobody has seen yet is left out. So is `chatgpt-4o-latest`:
 * the picker offered it, and `checkModelAssignment` (model-choice.ts), which
 * takes gpt-…, o… and codex… ids for Codex, then refused it.
 */
const BOT_FAMILIES: Record<'openai' | 'xai', RegExp> = {
  openai: /^(?:gpt-\d+(?:\.\d+)?o?|o\d+)(?:-|$)/,
  xai: /^grok-(?:\d+(?:\.\d+)?|code)(?:-|$)/,
};

/**
 * Parts that make a chat family's id something else: `gpt-4o-mini-tts`,
 * `gpt-4o-search-preview`, `gpt-3.5-turbo-instruct`, `grok-2-image-1212`.
 */
const NOT_FOR_BOTS = new Set([
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

/**
 * Whether a bot can run on this id. The same rule is copied into the console
 * as `botCanRun` in `apps/console/src/lib/model-onboarding.ts`, which cannot
 * import this package.
 *
 * An OpenAI key lists every model the organisation can call, well over a
 * hundred, and a bot given `tts-1` or `gpt-image-1` failed on its first task.
 * So this is an allowlist of families, and a new speech, image or video family
 * is left out until someone adds it. Anything with a `codex` part is Codex's
 * own. A fine-tuned `ft:gpt-4o-mini:org::id` is its base model. Anthropic
 * lists only models, and its ids are taken as they are.
 */
export function botCanRun(provider: ModelProvider, id: string): boolean {
  if (provider === 'anthropic') return true;
  const base = (id.startsWith('ft:') ? id.slice(3).split(':')[0]! : id).toLowerCase();
  const parts = base.split('-');
  if (provider === 'openai' && parts.includes('codex')) return true;
  if (!BOT_FAMILIES[provider].test(base)) return false;
  return !parts.some((part) => NOT_FOR_BOTS.has(part));
}

/**
 * How the secret is presented. `key` is an API key. `oauth` is the token
 * `claude setup-token` prints for a Claude subscription: Anthropic lists what
 * a subscription can call for it, sent as a bearer token with the OAuth beta
 * header, and refuses it as an `x-api-key`. Only Anthropic has one. An OpenAI
 * or xAI subscription's credential is its CLI's own sign-in, and there is no
 * token to present here.
 */
export type ProviderAuth = 'key' | 'oauth';

/** The beta Anthropic's API reads a subscription's token under. */
export const ANTHROPIC_OAUTH_BETA = 'oauth-2025-04-20';

function headersFor(provider: ModelProvider, secret: string, auth: ProviderAuth): Record<string, string> {
  if (provider === 'anthropic') {
    return auth === 'oauth'
      ? {
          authorization: `Bearer ${secret}`,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': ANTHROPIC_OAUTH_BETA,
        }
      : { 'x-api-key': secret, 'anthropic-version': '2023-06-01' };
  }
  return { authorization: `Bearer ${secret}` };
}

/**
 * Lists the models this key can call that a bot can run (`botCanRun`), or
 * throws the provider's own words. The picker offers this list, and hostd
 * checks a task's model against it, so a model left out here is also refused.
 *
 * An empty list is a refusal: a key that reaches nothing, or nothing a bot can
 * use, is not a credential worth keeping, and it is refused before anything is
 * stored. The key travels in a header and is scrubbed out of any message that
 * comes back, including one where the provider echoed it.
 *
 * `auth: 'oauth'` asks with a Claude subscription's token instead, the same
 * way in every other respect: the same pages, the same scrubbing, the same
 * refusal of an empty answer. It is what lets `newest:opus` float on a
 * subscription, which has no key.
 */
export async function listProviderModels(
  provider: ModelProvider,
  key: string,
  fetchImpl: typeof fetch = fetch,
  options: { auth?: ProviderAuth } = {},
): Promise<AvailableModel[]> {
  const auth = options.auth ?? 'key';
  if (auth === 'oauth' && provider !== 'anthropic') {
    throw new ProviderKeyRejected(
      `an ${provider === 'openai' ? 'OpenAI' : 'xAI'} subscription has no token to list models with — ` +
        "its credential is its CLI's own sign-in",
    );
  }
  const noun = auth === 'oauth' ? 'token' : 'key';
  const secret = key.trim();
  if (!secret) {
    throw new ProviderKeyRejected(
      auth === 'oauth' ? 'a Claude subscription needs its token to list models' : 'an API key account needs a key',
    );
  }

  const collected: AvailableModel[] = [];
  const seen = new Set<string>();
  let after: string | null = null;

  // Anthropic pages this list. OpenAI and xAI return it in one response, and
  // sending them a pagination query they do not document is how a good key
  // comes back as a 400 that is our fault.
  const paginate = provider === 'anthropic';

  for (let page = 0; page < 20; page += 1) {
    const url = new URL(PROVIDER_MODELS_URL[provider]);
    if (paginate) {
      url.searchParams.set('limit', '100');
      if (after) url.searchParams.set('after_id', after);
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: headersFor(provider, secret, auth),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'the provider did not answer';
      throw new ProviderKeyRejected(scrubSecret(message, secret));
    }

    // Scrubbed before anything is cut from it: a message sliced first can end
    // part-way through an echoed key, and a partial key no longer matches.
    const body = scrubSecret(await response.text(), secret);
    if (!response.ok) {
      throw new ProviderKeyRejected(messageFrom(body, response.status, noun));
    }

    let parsed: ModelsPage;
    try {
      parsed = JSON.parse(body) as ModelsPage;
    } catch {
      throw new ProviderKeyRejected(body.trim().slice(0, 300) || `${provider} returned no models`);
    }

    if (parsed.error) {
      throw new ProviderKeyRejected(messageFrom(body, response.status, noun));
    }

    for (const model of modelsFrom(parsed.data)) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      collected.push(model);
    }

    if (!paginate) break;
    const lastId = typeof parsed.last_id === 'string' ? parsed.last_id : null;
    if (parsed.has_more !== true || !lastId || lastId === after) break;
    after = lastId;
  }

  if (collected.length === 0) {
    throw new ProviderKeyRejected(`${provider} listed no models for this ${noun}`);
  }

  const runnable = collected.filter((model) => botCanRun(provider, model.id));
  if (runnable.length === 0) {
    throw new ProviderKeyRejected(
      `${provider} listed ${collected.length} models for this ${noun}, and none a bot can use — ` +
        'a bot needs a chat, reasoning or codex model',
    );
  }

  return runnable;
}
