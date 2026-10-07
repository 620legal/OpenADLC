import { audit, modelAccounts, type ModelAccount } from '@fleetadlc/db';
import {
  ProviderKeyRejected,
  aliasFamily,
  aliasesFor,
  listProviderModels,
  modelListCache,
  modelListKey,
  newestIn,
  scrubSecret,
  sortNewestFirst,
  type AvailableModel,
  type ModelListCache,
  type ModelProvider,
} from '@fleetadlc/engines';
import { getSecretStore, modelAccountRef, type SecretStore } from '@fleetadlc/github';
import type { AccountCheck, SubscriptionLogin } from '@fleetadlc/shared';
import type { CliModel } from './hostd-client.js';
import type { Router } from './router.js';

/**
 * Adding an account, and refusing one that cannot list models.
 *
 * Verify first, then write the row, then the secret. A key that fails is not
 * stored, and neither is a row that would claim it was. A Claude subscription
 * stores the token `claude setup-token` prints, the same way. An OpenAI or xAI
 * subscription stores nothing here: it is signed in from the console, by its
 * own CLI, into a directory hostd keeps for the account.
 */
export interface ModelAccountDeps {
  accounts: {
    list: typeof modelAccounts.list;
    get: typeof modelAccounts.get;
    create: typeof modelAccounts.create;
    remove: typeof modelAccounts.remove;
    recordVerification: typeof modelAccounts.recordVerification;
    clearVerification: typeof modelAccounts.clearVerification;
  };
  secrets: SecretStore;
  listModels: typeof listProviderModels;
  recordAudit: (input: {
    actor: string;
    action: string;
    target: string;
    payload?: Record<string, unknown>;
  }) => Promise<void>;
  /** hostd, which signs a subscription in and checks an account. Absent, those routes say so. */
  logins?: ModelAccountLogins;
  /**
   * The lists this bridge asked a provider for, kept a few minutes per
   * account so a picker opened twice is one request. An xAI seat's list is
   * hostd's to remember, and is not kept here as well.
   */
  cache?: ModelListCache;
  /**
   * Told when an account may have started answering, or stopped: added,
   * given a key, signed in, checked, removed. The health checks ask again then.
   */
  changed?: () => void;
}

/** What the bridge asks hostd about an account. `HostdClient` is one. */
export interface ModelAccountLogins {
  startLogin(accountId: string, identity: string): Promise<SubscriptionLogin>;
  loginStatus(accountId: string): Promise<SubscriptionLogin>;
  forgetLogin(accountId: string, identity: string): Promise<void>;
  verifyAccount(accountId: string, identity: string): Promise<AccountCheck>;
  /** What an xAI seat's CLI lists, run by hostd with the seat's login. */
  accountModels(accountId: string): Promise<{ models: CliModel[] }>;
}

export interface AddModelAccountInput {
  provider: string;
  kind: string;
  label: string;
  key?: string;
  actor: string;
}

export interface AddedModelAccount {
  account: ModelAccount;
  /** What the key can call. Empty for a subscription, which has no key to ask with. */
  models: AvailableModel[];
}

export class ModelAccountRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ModelAccountRequestError';
  }
}

const PROVIDERS: readonly ModelProvider[] = ['anthropic', 'openai', 'xai'];

const PROVIDER_NAME: Record<ModelProvider, string> = { anthropic: 'Anthropic', openai: 'OpenAI', xai: 'xAI' };

/**
 * The token `claude setup-token` prints, or a refusal that says what was
 * expected. One line, no spaces: a long token copied out of a terminal that
 * wrapped it arrives with a line break in the middle, and stored like that it
 * fails every task with an error that says nothing about why.
 */
function setupToken(value: string): string {
  const token = value.trim();
  if (!token || /\s/.test(token) || !token.startsWith('sk-ant-oat')) {
    throw new ModelAccountRequestError(
      400,
      'a Claude subscription takes the token `claude setup-token` prints — one line starting with sk-ant-oat, ' +
        'with no spaces or line breaks (if the terminal wrapped it, copy it again as one line)',
    );
  }
  return token;
}

/** An OpenAI or xAI subscription, whose credential is its CLI's own sign-in. */
function signsInByDevice(account: Pick<ModelAccount, 'kind' | 'provider'>): boolean {
  return account.kind === 'subscription' && account.provider !== 'anthropic';
}

function deviceSignInOnly(provider: ModelProvider): ModelAccountRequestError {
  return new ModelAccountRequestError(
    400,
    `an ${PROVIDER_NAME[provider]} subscription stores no key — its credential is the sign-in, ` +
      'which the “Foundation model accounts / API keys” step runs for it with Sign in',
  );
}

function asProvider(value: string): ModelProvider {
  if ((PROVIDERS as readonly string[]).includes(value)) return value as ModelProvider;
  throw new ModelAccountRequestError(400, 'provider must be anthropic, openai or xai');
}

function asKind(value: string): 'key' | 'subscription' {
  if (value === 'key' || value === 'subscription') return value;
  throw new ModelAccountRequestError(400, 'kind must be key or subscription');
}

// A body is whatever was posted. A field that is not a string is treated as
// missing, so it is a 400 that names the field rather than a 500 from .trim().
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// An id that is not a uuid cannot name an account. Postgres would refuse it
// with a syntax error, which reaches the operator as a 500.
async function accountFor(id: string, deps: ModelAccountDeps): Promise<ModelAccount> {
  const account = UUID.test(id) ? await deps.accounts.get(id) : null;
  if (!account) throw new ModelAccountRequestError(404, `no model account ${id}`);
  return account;
}

function rejectUnverified(error: unknown, key: string): never {
  const raw = error instanceof Error ? error.message : 'the provider refused this key';
  throw new ProviderKeyRejected(scrubSecret(raw, key));
}

export function defaultModelAccountDeps(logins?: ModelAccountLogins): ModelAccountDeps {
  // Resolved per call. A store installed after the routes were registered —
  // tests do this, and so does a bridge that swaps the store at startup — has
  // to be the one a paste writes to.
  const secrets: SecretStore = {
    get: (ref) => getSecretStore().get(ref),
    set: (ref, value) => getSecretStore().set(ref, value),
    delete: (ref) => getSecretStore().delete(ref),
    list: (prefix) => getSecretStore().list(prefix),
  };
  return {
    accounts: modelAccounts,
    secrets,
    listModels: listProviderModels,
    recordAudit: audit,
    ...(logins ? { logins } : {}),
    cache: modelListCache(),
  };
}

/**
 * One account, one secret. Rotating it is a later write to the same ref, so
 * every bot assigned to it picks the new key up on its next task.
 */
export async function addModelAccount(
  input: AddModelAccountInput,
  deps: ModelAccountDeps,
): Promise<AddedModelAccount> {
  const provider = asProvider(text(input.provider).trim());
  const kind = asKind(text(input.kind).trim());
  const label = text(input.label).trim();
  if (!label) throw new ModelAccountRequestError(400, 'an account needs a label');

  const key = text(input.key).trim();

  if (kind === 'subscription') {
    // A key pasted onto an OpenAI or xAI seat would be stored and then
    // injected, which is the opposite of what a seat is. Refused rather than
    // dropped quietly. A Claude seat's token is checked before the row exists,
    // so a paste that is not one leaves nothing behind.
    if (provider !== 'anthropic' && key) throw deviceSignInOnly(provider);
    const token = provider === 'anthropic' && key ? setupToken(key) : null;

    const account = await deps.accounts.create({ provider, kind, label });
    if (token) {
      try {
        await deps.secrets.set(modelAccountRef(account.id), token);
      } catch (error) {
        await deps.accounts.remove(account.id).catch(() => undefined);
        throw error;
      }
    }
    await deps.recordAudit({
      actor: input.actor,
      action: 'model_account.added',
      target: account.id,
      // Whether a token came with it, never the token.
      payload: { provider, kind, label, ...(provider === 'anthropic' ? { tokenStored: token !== null } : {}) },
    });
    return { account, models: [] };
  }

  if (!key) throw new ModelAccountRequestError(400, 'an API key account needs a key');

  let models: AvailableModel[];
  try {
    models = await deps.listModels(provider, key);
  } catch (error) {
    rejectUnverified(error, key);
  }

  const account = await deps.accounts.create({ provider, kind, label });
  try {
    await deps.secrets.set(modelAccountRef(account.id), key);
  } catch (error) {
    // The row would say a key is stored. It is not, and a bot assigned to it
    // would start with nothing rather than fall back to a per-bot key.
    await deps.accounts.remove(account.id).catch(() => undefined);
    throw error;
  }

  await deps.recordAudit({
    actor: input.actor,
    action: 'model_account.added',
    target: account.id,
    // The fact of a key, never the key and never its length.
    payload: { provider, kind, label },
  });

  return { account, models };
}

/**
 * Replaces the secret at the same ref. Verified before the write, so a bad
 * paste does not destroy the key every bot on this account is using.
 *
 * A Claude subscription's token is replaced here too, checked for being the
 * shape `claude setup-token` prints; whether it works is what Verify asks.
 * Either way the last check is forgotten, because it was about the old one.
 */
export async function replaceModelAccountKey(
  input: { id: string; key: string; actor: string },
  deps: ModelAccountDeps,
): Promise<AddedModelAccount> {
  const account = await accountFor(input.id, deps);

  if (account.kind === 'subscription') {
    if (account.provider !== 'anthropic') throw deviceSignInOnly(account.provider);
    const token = setupToken(text(input.key));
    await deps.secrets.set(modelAccountRef(account.id), token);
    await deps.accounts.clearVerification(account.id);
    await deps.recordAudit({
      actor: input.actor,
      action: 'model_account.token_set',
      target: account.id,
      payload: { provider: account.provider, kind: account.kind },
    });
    return { account: { ...account, verifiedAt: null, verifyError: null }, models: [] };
  }

  const key = text(input.key).trim();
  if (!key) throw new ModelAccountRequestError(400, 'an API key account needs a key');

  let models: AvailableModel[];
  try {
    models = await deps.listModels(account.provider, key);
  } catch (error) {
    rejectUnverified(error, key);
  }

  await deps.secrets.set(modelAccountRef(account.id), key);
  await deps.accounts.clearVerification(account.id);
  await deps.recordAudit({
    actor: input.actor,
    action: 'model_account.key_rotated',
    target: account.id,
    payload: { provider: account.provider, kind: account.kind },
  });

  return { account: { ...account, verifiedAt: null, verifyError: null }, models };
}

export async function removeModelAccount(
  input: { id: string; actor: string },
  deps: ModelAccountDeps,
): Promise<{ id: string }> {
  const account = await accountFor(input.id, deps);

  // Throws AccountInUse, naming the bots, before the secret is touched. A
  // refusal must leave the credential where those bots still read it.
  await deps.accounts.remove(account.id);
  // A key, or a Claude subscription's token; nothing, for any other seat.
  await deps.secrets.delete(modelAccountRef(account.id));

  await deps.recordAudit({
    actor: input.actor,
    action: 'model_account.removed',
    target: account.id,
    payload: { provider: account.provider, kind: account.kind, label: account.label },
  });

  // The login an OpenAI or xAI seat signed in to, which hostd holds. After
  // the row, so a refusal above leaves it for the bots still on it, and best
  // effort, because the account is gone either way: a hostd that is down now
  // leaves a directory nothing can mount again, not a credential in use.
  if (signsInByDevice(account) && deps.logins) {
    await deps.logins.forgetLogin(account.id, input.actor).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message.slice(0, 200) : 'hostd did not answer';
      console.warn(`[bridge] model account ${account.id} is removed, but hostd did not forget its login: ${reason}`);
    });
  }

  return { id: account.id };
}

function loginsOf(deps: ModelAccountDeps): ModelAccountLogins {
  if (!deps.logins) throw new ModelAccountRequestError(503, 'this bridge has no hostd to sign in or check with');
  return deps.logins;
}

/**
 * Starts an OpenAI or xAI subscription's sign-in. The answer is the link and
 * one-time code for the operator to enter in their own browser, and it goes
 * nowhere else: not to the audit trail, not to a log.
 */
export async function startSubscriptionLogin(
  input: { id: string; actor: string },
  deps: ModelAccountDeps,
): Promise<SubscriptionLogin> {
  const account = await accountFor(input.id, deps);
  if (account.kind === 'key') {
    throw new ModelAccountRequestError(400, 'an API key account has nothing to sign in to — its key is the credential');
  }
  if (!signsInByDevice(account)) {
    throw new ModelAccountRequestError(
      400,
      'a Claude subscription does not sign in here — run `claude setup-token` and paste the token it prints on the account',
    );
  }
  return loginsOf(deps).startLogin(account.id, input.actor);
}

export async function subscriptionLoginStatus(id: string, deps: ModelAccountDeps): Promise<SubscriptionLogin> {
  const account = await accountFor(id, deps);
  if (!signsInByDevice(account)) return { state: 'signed-out' };
  return loginsOf(deps).loginStatus(account.id);
}

/**
 * Runs the account's CLI with a one-line prompt, with the credential a
 * session on it would get, and keeps what happened on the row — so the
 * accounts step can say ✓ and when, or × and the CLI's own words.
 */
export async function verifyModelAccount(
  input: { id: string; actor: string },
  deps: ModelAccountDeps,
): Promise<AccountCheck & { account: ModelAccount }> {
  const account = await accountFor(input.id, deps);
  const check = await loginsOf(deps).verifyAccount(account.id, input.actor);

  // hostd scrubbed it already. The secret is here too, and this is the copy
  // that is kept and shown, so it is taken out once more by value.
  const secret = (await deps.secrets.get(modelAccountRef(account.id)).catch(() => null)) ?? '';
  const message = scrubSecret(check.message, secret);
  const recorded = await deps.accounts.recordVerification(account.id, {
    checkedAt: check.checkedAt,
    error: check.ok ? null : message,
  });
  return { ok: check.ok, message, checkedAt: check.checkedAt, account: recorded };
}

/** One model a picker can offer. */
export interface ListedModel {
  id: string;
  /** When the provider says it was released, or null when it does not say. */
  createdAt: string | null;
  /** The one the provider uses unasked. Only grok marks one. */
  isDefault: boolean;
}

/** What `GET /v1/model-accounts/:id/models` answers, for every kind of account. */
export interface AccountModels {
  /** Newest first by date; the provider's default first when nothing is dated. */
  models: ListedModel[];
  /** The `newest:` families this account can resolve: offered only when the list has one in the family. */
  aliases: string[];
}

/**
 * The models a stored account can call, for a picker that has to offer real
 * ones and say what `newest:opus` is today.
 *
 * Every account answers. A key is asked with the key already stored; a Claude
 * subscription with its setup token, which lists the same way; an xAI
 * subscription through hostd, which runs `grok models` with the seat's login;
 * an OpenAI subscription lists nothing and floats nothing, because codex has
 * nothing that lists what a ChatGPT plan can call. No secret is part of the
 * answer.
 *
 * A list that could not be had is a 502 in the provider's words, scrubbed —
 * not an empty list, which would read as "this account can call nothing" and
 * leave a picker offering only what was already stored.
 */
export async function listAccountModels(id: string, deps: ModelAccountDeps): Promise<AccountModels> {
  const account = await accountFor(id, deps);

  if (account.kind === 'subscription' && account.provider === 'openai') return { models: [], aliases: [] };

  let listed: AvailableModel[];
  if (account.kind === 'subscription' && account.provider === 'xai') {
    // hostd's words and status travel as they are: a seat that is not signed
    // in is a 502 saying so, and hostd not answering is one too.
    listed = (await loginsOf(deps).accountModels(account.id)).models;
  } else {
    const seat = account.kind === 'subscription';
    const secret = ((await deps.secrets.get(modelAccountRef(account.id))) ?? '').trim();
    if (!secret) {
      throw new ModelAccountRequestError(
        409,
        seat
          ? 'this subscription has no token stored, so its models cannot be listed — ' +
              'paste the one `claude setup-token` prints'
          : 'this account has no key stored, so its models cannot be listed',
      );
    }
    const load = () => deps.listModels(account.provider, secret, undefined, { auth: seat ? 'oauth' : 'key' });
    try {
      listed = deps.cache ? await deps.cache.modelsFor(modelListKey(account.id, secret), load) : await load();
    } catch (error) {
      const raw = error instanceof Error ? error.message : `${PROVIDER_NAME[account.provider]} did not list models`;
      throw new ModelAccountRequestError(502, scrubSecret(raw, secret));
    }
  }

  return {
    models: sortNewestFirst(listed).map((model) => ({
      id: model.id,
      createdAt: model.createdAt ?? null,
      isDefault: model.isDefault === true,
    })),
    aliases: aliasesFor(account).filter((alias) => {
      const family = aliasFamily(alias);
      return family !== null && newestIn(family, listed) !== null;
    }),
  };
}

export function registerModelAccountRoutes(router: Router, deps: ModelAccountDeps = defaultModelAccountDeps()): void {
  router.get('/v1/model-accounts', async () => {
    const accounts = await deps.accounts.list();
    return { accounts };
  });

  const told = <T>(result: T): T => {
    deps.changed?.();
    return result;
  };

  router.post('/v1/model-accounts', async ({ body, identity }) => {
    const input = await body<{ provider?: unknown; kind?: unknown; label?: unknown; key?: unknown }>();
    return told(await addModelAccount(
      {
        provider: text(input.provider),
        kind: text(input.kind),
        label: text(input.label),
        ...(input.key !== undefined ? { key: text(input.key) } : {}),
        actor: identity,
      },
      deps,
    ));
  });

  router.get('/v1/model-accounts/:id/models', async ({ params }) => {
    return listAccountModels(params.id ?? '', deps);
  });

  router.post('/v1/model-accounts/:id/key', async ({ params, body, identity }) => {
    const input = await body<{ key?: unknown }>();
    return told(await replaceModelAccountKey({ id: params.id ?? '', key: text(input.key), actor: identity }, deps));
  });

  router.post('/v1/model-accounts/:id/remove', async ({ params, identity }) => {
    return told(await removeModelAccount({ id: params.id ?? '', actor: identity }, deps));
  });

  router.post('/v1/model-accounts/:id/login', async ({ params, identity }) => {
    return startSubscriptionLogin({ id: params.id ?? '', actor: identity }, deps);
  });

  router.get('/v1/model-accounts/:id/login', async ({ params }) => {
    const login = await subscriptionLoginStatus(params.id ?? '', deps);
    // The accounts step asks this while a sign-in finishes; the moment it has
    // is the moment the account's card can go.
    return login.state === 'signed-in' ? told(login) : login;
  });

  router.post('/v1/model-accounts/:id/verify', async ({ params, identity }) => {
    return told(await verifyModelAccount({ id: params.id ?? '', actor: identity }, deps));
  });
}
