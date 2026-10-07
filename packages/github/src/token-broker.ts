import { DeviceAuthError, refreshUserToken, type UserToken } from './device-auth.js';
import { createScopedToken, ScopedTokenError, type ScopedToken } from './scoped-token.js';
import { accessTokenRef, getSecretStore, refreshTokenRef, type SecretStore } from './secrets.js';

export interface BrokeredToken {
  token: string;
  expiresAt: Date | null;
  login: string;
}

/** A token for a task in one repository. */
export interface RepositoryToken extends BrokeredToken {
  /** Whether GitHub narrowed it to the repository; false when it is the account's own token, which reaches every repository the account can. */
  scoped: boolean;
}

/** How asking GitHub for a scoped token went, for the health check that says whether the client secret works. */
export type ScopedOutcome = { ok: true } | { ok: false; secretRefused: boolean; reason: string };

export interface TokenBrokerOptions {
  /**
   * The app's client id, or a way to get it.
   *
   * A function, because an install can be configured from the console after the
   * process started: taking the value once at construction meant the broker held
   * whatever the environment had at boot — empty, on an install configured in
   * the browser — and refreshed every token with `client_id=`, which GitHub
   * refuses.
   */
  clientId: string | (() => string | Promise<string>);
  store?: SecretStore;
  /** Called after a refresh so the console and `fleetadlc doctor` show real expiry. */
  onRefreshed?: (bot: string, token: UserToken) => Promise<void> | void;
  onRevoked?: (bot: string, reason: string) => Promise<void> | void;
  /**
   * Runs a refresh alone across every process that holds a broker for this
   * install. GitHub rotates the refresh token on each use, and two bridges
   * side by side during a rollout each read the same one and used it: the
   * second use is a replay, and GitHub revoked the sign-in (found live: the
   * reviewer account, after a deploy). Inside it the refresh token is read
   * again, so the second to arrive uses the one the first stored.
   */
  exclusive?: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
  now?: () => Date;
  /** How long to wait before each retry of saving a rotated refresh token. */
  saveRetryMs?: readonly number[];
  /**
   * The app's client secret, which narrowing a token to one repository needs
   * (`tokenForRepository`); null when the install has none. Asked per call, as
   * the client id is, so a secret pasted in settings is used at once.
   */
  clientSecret?: () => string | null | Promise<string | null>;
  /** Called after each try at a scoped token, so a health check can say whether the client secret works. */
  onScoped?: (outcome: ScopedOutcome) => Promise<void> | void;
  fetchImpl?: typeof fetch;
}

/**
 * A fault in this install rather than in the credential.
 *
 * Told apart because the two need opposite responses: a revoked authorization
 * needs somebody to sign in again, and a missing client id needs one setting —
 * and treating the second as the first throws away credentials that are fine.
 */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/**
 * OAuth error codes that say GitHub is busy or failing, not that it refused:
 * RFC 6749's `server_error` and `temporarily_unavailable`, and the device
 * flow's `slow_down`.
 */
const NOT_A_REFUSAL = new Set(['server_error', 'temporarily_unavailable', 'slow_down']);

/**
 * Whether a failed refresh was GitHub refusing the sign-in — an OAuth error
 * such as `bad_refresh_token`, or a 401 — rather than GitHub not being
 * reached or answering with an outage. The broker's own error carries what
 * GitHub said as its `cause`. Only a refusal is worth remembering: a network
 * blip or a 5xx says nothing about the account, and is asked again next time.
 *
 * What is not a refusal is listed, rather than what is, so an OAuth code
 * this does not know still counts as one: missing a revocation leaves every
 * seat failing with no reconnect card.
 */
export function refusedByGitHub(error: unknown): boolean {
  const cause = error instanceof DeviceAuthError ? error : error instanceof Error ? error.cause : undefined;
  if (!(cause instanceof DeviceAuthError)) return false;
  if (cause.status !== undefined && cause.status >= 500) return false;
  if (cause.code === 'http_error' || cause.code === 'bad_response') return cause.status === 401;
  // A 200 with neither a token nor an error names nothing GitHub refused.
  return cause.code !== 'unknown' && !NOT_A_REFUSAL.has(cause.code);
}

/** The waits between tries at saving a rotated refresh token. */
const SAVE_RETRY_MS = [250, 1000, 4000];

/** Refresh a little early so a short call never carries a token to its last second. */
const CALL_TOKEN_MIN_LIFETIME_MS = 5 * 60 * 1000;

/**
 * What a token handed to a task must still have left. A task may run for four
 * hours, and a token that expires part way through fails at the end, where the
 * work is — so a task never starts on one that will not outlast it.
 */
export const TASK_TOKEN_MIN_LIFETIME_MS = 5 * 60 * 60 * 1000;

/**
 * Hands out short-lived user tokens for a bot's own GitHub account, refreshing
 * from the stored refresh token when needed. Callers never see the refresh token.
 *
 * GitHub rotates the refresh token on every use, so exactly one component in an
 * install may hold a broker: a second one refreshing the same credential
 * invalidates the first and locks the account out until a person repeats the
 * device flow. That component is the bridge, which serves tokens to the rest
 * over its token service.
 */
export class TokenBroker {
  private readonly cache = new Map<string, BrokeredToken>();
  private readonly inflight = new Map<string, Promise<BrokeredToken>>();
  /** Names whose secrets are being moved, and what a caller waits on until they have. */
  private readonly held = new Map<string, Promise<void>>();
  /**
   * Rotated refresh tokens the store has not taken yet, by name. GitHub
   * invalidates the old refresh token the moment it issues a new one, so a
   * failed save used to leave the store with a dead token: the next refresh
   * sent it, GitHub refused it, and every seat on the account was marked
   * revoked. Kept here, the next refresh uses the live one instead.
   */
  private readonly unsaved = new Map<string, string>();
  /**
   * Tokens narrowed to one repository, by sign-in and repository, each with the
   * user token it was made from: a refresh replaces that, and a scoped token is
   * made again from the new one. Keyed apart from `cache`, whose key is the
   * sign-in alone, so a task in one repository never gets another's.
   */
  private readonly scopedCache = new Map<string, { parent: string; entry: BrokeredToken }>();
  private readonly scopedInflight = new Map<string, Promise<RepositoryToken>>();
  private readonly store: SecretStore;

  constructor(private readonly options: TokenBrokerOptions) {
    this.store = options.store ?? getSecretStore();
  }

  /** Resolved per call, so a client id configured after start-up is used. */
  private async clientId(): Promise<string> {
    const value =
      typeof this.options.clientId === 'function' ? await this.options.clientId() : this.options.clientId;
    if (!value) {
      throw new ConfigurationError(
        'this install has no GitHub App client id, so no token can be refreshed — set one in the console',
      );
    }
    return value;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private fresh(entry: BrokeredToken | undefined, minLifetimeMs: number): entry is BrokeredToken {
    if (!entry) return false;
    if (!entry.expiresAt) return true;
    return entry.expiresAt.getTime() - this.now().getTime() > minLifetimeMs;
  }

  /**
   * `minLifetimeMs` is how much life the caller needs the token to have left.
   * A task asks for `TASK_TOKEN_MIN_LIFETIME_MS`; a single API call is content
   * with the default, so an ordinary comment does not force a refresh.
   */
  async tokenFor(
    bot: string,
    login = bot,
    options: { minLifetimeMs?: number } = {},
  ): Promise<BrokeredToken> {
    const minLifetimeMs = options.minLifetimeMs ?? CALL_TOKEN_MIN_LIFETIME_MS;
    // A rename is moving this name's refresh token; asking now would read it
    // from one place and could write the rotated one back to the other.
    const moving = this.held.get(bot);
    if (moving) await moving;
    const cached = this.cache.get(bot);
    if (this.fresh(cached, minLifetimeMs)) return cached;

    const existing = this.inflight.get(bot);
    if (existing) return existing;

    const promise = this.mint(bot, login).finally(() => this.inflight.delete(bot));
    this.inflight.set(bot, promise);
    return promise;
  }

  /**
   * A token for a task in one repository (`owner/name`): the account's user
   * token narrowed by GitHub to that repository, so a call to any other is
   * refused by GitHub itself and not only by a shim.
   *
   * The user token is the one `tokenFor` gives, refreshed only there and once
   * per sign-in: a second refresher would lock the account out. With no client
   * secret, or when GitHub will not narrow it, the account's own token is
   * returned with `scoped: false` and one line is logged: a task must not fail
   * because an install has no secret yet, which would stop every install that
   * existed before this did.
   */
  async tokenForRepository(
    bot: string,
    login: string,
    repository: string,
    options: { minLifetimeMs?: number } = {},
  ): Promise<RepositoryToken> {
    const minLifetimeMs = options.minLifetimeMs ?? CALL_TOKEN_MIN_LIFETIME_MS;
    const parent = await this.tokenFor(bot, login, options);
    const key = `${bot}\n${repository.toLowerCase()}`;
    const cached = this.scopedCache.get(key);
    if (cached && cached.parent === parent.token && this.fresh(cached.entry, minLifetimeMs)) return { ...cached.entry, scoped: true };

    const existing = this.scopedInflight.get(key);
    if (existing) return existing;
    const promise = this.scope(bot, repository, parent, key).finally(() => this.scopedInflight.delete(key));
    this.scopedInflight.set(key, promise);
    return promise;
  }

  private async scope(bot: string, repository: string, parent: BrokeredToken, key: string): Promise<RepositoryToken> {
    const unscoped: RepositoryToken = { ...parent, scoped: false };
    const clientSecret = (await this.options.clientSecret?.()) ?? null;
    if (!clientSecret) {
      console.warn(`[token-broker] ${bot}'s token for ${repository} is not scoped to it: this install has no GitHub App client secret`);
      await this.options.onScoped?.({ ok: false, secretRefused: false, reason: 'this install has no GitHub App client secret' });
      return unscoped;
    }
    let minted: ScopedToken;
    try {
      minted = await createScopedToken({
        clientId: await this.clientId(),
        clientSecret,
        accessToken: parent.token,
        repository,
        ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[token-broker] ${bot}'s token for ${repository} is not scoped to it: ${reason}`);
      await this.options.onScoped?.({ ok: false, secretRefused: error instanceof ScopedTokenError && error.secretRefused, reason });
      return unscoped;
    }
    // GitHub's own expiry when it gives one; otherwise the parent's, which is
    // the most a token made from it can have.
    const entry: BrokeredToken = { token: minted.token, expiresAt: minted.expiresAt ?? parent.expiresAt, login: parent.login };
    this.scopedCache.set(key, { parent: parent.token, entry });
    await this.options.onScoped?.({ ok: true });
    return { ...entry, scoped: true };
  }

  private forgetScoped(bot: string): void {
    for (const key of this.scopedCache.keys()) if (key.startsWith(`${bot}\n`)) this.scopedCache.delete(key);
  }

  private async mint(bot: string, login: string): Promise<BrokeredToken> {
    const exclusive = this.options.exclusive;
    return exclusive ? exclusive(`github-refresh:${bot}`, () => this.mintAlone(bot, login)) : this.mintAlone(bot, login);
  }

  private async mintAlone(bot: string, login: string): Promise<BrokeredToken> {
    const refreshToken = this.unsaved.get(bot) ?? (await this.store.get(refreshTokenRef(bot)));

    if (!refreshToken) {
      // Apps with token expiry disabled issue no refresh token; the access token
      // itself is stored instead and used until revoked.
      const staticToken = await this.store.get(accessTokenRef(bot));
      if (staticToken) {
        const entry: BrokeredToken = { token: staticToken, expiresAt: null, login };
        this.cache.set(bot, entry);
        return entry;
      }
      throw new Error(
        `${bot} is not connected to GitHub. Run: fleetadlc auth login --bot ${bot}`,
      );
    }

    let refreshed: UserToken;
    try {
      refreshed = await refreshUserToken({ clientId: await this.clientId(), refreshToken });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Not revoked. A credential is marked revoked when GitHub says the
      // authorization is gone — not when this install cannot ask, which is a
      // fault here and is repaired by fixing the configuration. Marking it
      // revoked turned a missing client id into nine device flows to redo.
      if (error instanceof ConfigurationError) throw error;
      // Nor when GitHub could not be reached, or answered with an outage: that
      // says nothing about the authorization, and marking it revoked turned one
      // network blip into a reconnect for every seat on the account. Nothing
      // is cached, so the next ask refreshes again.
      if (!refusedByGitHub(error)) {
        console.warn(`[token-broker] could not refresh ${bot}'s GitHub sign-in; asking again next time: ${message}`);
        throw new Error(`GitHub could not be asked to refresh ${bot}'s sign-in (${message})`, { cause: error });
      }
      await this.options.onRevoked?.(bot, message);
      // `--bot` takes the account's login, which every seat on it shares; the
      // name here is where the sign-in is filed, which a seat may not go by.
      throw new Error(`${bot}'s GitHub authorization is no longer valid (${message}). Reconnect it: fleetadlc auth login --bot ${login || bot}`, {
        cause: error,
      });
    }

    // GitHub rotates the refresh token on every use; the new one must replace
    // it. Held in memory and the access token cached first, so a store that
    // fails to save it loses neither.
    const entry: BrokeredToken = {
      token: refreshed.accessToken,
      expiresAt: refreshed.expiresAt,
      login,
    };
    this.cache.set(bot, entry);
    if (refreshed.refreshToken) {
      this.unsaved.set(bot, refreshed.refreshToken);
      await this.save(bot);
    } else {
      this.unsaved.delete(bot);
    }
    await this.options.onRefreshed?.(bot, refreshed);
    return entry;
  }

  /**
   * Saves the rotated refresh token held for this name, trying again with
   * backoff. Whether it was saved: when every try fails it stays in memory, so
   * the next refresh still sends the live one, and is saved after that refresh.
   */
  private async save(bot: string): Promise<boolean> {
    const waits = this.options.saveRetryMs ?? SAVE_RETRY_MS;
    for (let attempt = 0; ; attempt += 1) {
      const value = this.unsaved.get(bot);
      if (value === undefined) return true;
      try {
        await this.store.set(refreshTokenRef(bot), value);
        if (this.unsaved.get(bot) === value) this.unsaved.delete(bot);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt >= waits.length) {
          console.warn(
            `[token-broker] could not save ${bot}'s rotated GitHub refresh token; keeping it in memory until a save works: ${message}`,
          );
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, waits[attempt]));
      }
    }
  }

  forget(bot: string): void {
    this.cache.delete(bot);
    this.forgetScoped(bot);
  }

  /**
   * Runs `fn` with no token minted under any of these names, and forgets what
   * was cached for them when it is done.
   *
   * A rename moves a bot's refresh token from one name to another, and GitHub
   * rotates a refresh token every time it is used. A refresh that started
   * before the move and finished after it would write the rotated token back
   * under the old name, after the copy — and the bot would be left holding
   * the one GitHub has just invalidated, until a person repeats the device
   * flow. So the names are held first, then any refresh already in flight is
   * let finish, and only then does `fn` run; a caller that arrives meanwhile
   * waits, and afterwards finds the token wherever `fn` put it.
   *
   * A rotated refresh token the store has not taken yet is saved before `fn`
   * runs, so the move carries the live one; if it still cannot be saved,
   * nothing is moved.
   */
  async exclusive<T>(bots: readonly string[], fn: () => Promise<T>): Promise<T> {
    const names = [...new Set(bots)];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const before = names.map((bot) => this.held.get(bot)).filter((held): held is Promise<void> => Boolean(held));
    for (const bot of names) this.held.set(bot, gate);

    try {
      await Promise.all(before);
      await Promise.all(names.map((bot) => this.inflight.get(bot)?.catch(() => undefined)));
      for (const bot of names) {
        if (this.unsaved.has(bot) && !(await this.save(bot))) {
          throw new Error(`${bot}'s rotated GitHub sign-in could not be saved to the secret store, so it was not moved. Try again.`);
        }
      }
      return await fn();
    } finally {
      for (const bot of names) {
        this.cache.delete(bot);
        this.forgetScoped(bot);
        if (this.held.get(bot) === gate) this.held.delete(bot);
      }
      release();
    }
  }
}
