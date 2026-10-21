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
  /** Called after a refresh so the console and `openadlc doctor` show real expiry. */
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
  /** How long to wait before each retry of a refresh GitHub answered with an outage; see `REFRESH_RETRY_MS`. */
  refreshRetryMs?: readonly number[];
  /** How long a sign-in GitHub did not answer the refresh of is not asked again; see `UNANSWERED_FOR_MS`. */
  unansweredForMs?: number;
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
  if (cause.status !== undefined && (cause.status >= 500 || cause.status === 429)) return false;
  if (cause.code === 'http_error' || cause.code === 'bad_response') return cause.status === 401;
  // A 200 with neither a token nor an error names nothing GitHub refused.
  return cause.code !== 'unknown' && !NOT_A_REFUSAL.has(cause.code);
}

/**
 * How a refresh that did not work went, by what GitHub answered:
 *
 * - `refused`: GitHub said no, with an OAuth error or a 401 (`refusedByGitHub`).
 * - `busy`: GitHub answered that it is failing or overloaded — a 5xx, a 429,
 *   or an OAuth code that says so (`NOT_A_REFUSAL`) — and so did not take the
 *   refresh token. Asked again.
 * - `unclear`: no answer at all — a timeout, an abort, the network. GitHub may
 *   have taken the refresh and rotated the token before the answer was lost,
 *   so the same token is not sent again at once.
 * - `other`: anything else — a 403, a 404, a 200 with no token, a fault here.
 *   Neither an outage nor a refusal, so it is not waited out and marks
 *   nothing revoked: it fails as it is, for a person to read. Counting these
 *   as GitHub not answering left answered work paused with no end.
 */
export type RefreshFailure = 'refused' | 'busy' | 'unclear' | 'other';

export function refreshFailure(error: unknown): RefreshFailure {
  if (refusedByGitHub(error)) return 'refused';
  if (error instanceof DeviceAuthError) {
    if (error.status !== undefined && (error.status >= 500 || error.status === 429)) return 'busy';
    return NOT_A_REFUSAL.has(error.code) ? 'busy' : 'other';
  }
  if (!(error instanceof Error)) return 'other';
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'unclear';
  // Node's fetch: `fetch failed` when the connection could not be made or was
  // reset, `terminated` when the answer was cut off part way.
  return error instanceof TypeError && /^(?:fetch failed|terminated)$/.test(error.message) ? 'unclear' : 'other';
}

/**
 * What every error says when GitHub did not answer a sign-in's refresh — a
 * 5xx, a timeout, the network — rather than refusing it. It travels as words:
 * the bridge's token service answers 503 with it, hostd fails a task's start
 * with it, and the bridge reads it back from the task (`githubDidNotAnswer`)
 * to run the task again later instead of leaving it failed for a person.
 */
export const GITHUB_DID_NOT_ANSWER = 'GitHub did not answer the refresh of';

/** Whether a reason, as it reached a task or a log, says GitHub did not answer a sign-in's refresh. */
export function githubDidNotAnswer(reason: string | null | undefined): boolean {
  return (reason ?? '').includes(GITHUB_DID_NOT_ANSWER);
}

/**
 * A refresh GitHub did not answer (`busy` or `unclear`, `refreshFailure`):
 * an outage or the network, which says nothing about the sign-in. Its `cause`
 * is the last try's error; `askedAgainAt` is when the broker asks GitHub
 * again, null when the next ask does.
 */
export class GitHubUnavailableError extends Error {
  constructor(
    bot: string,
    reason: string,
    options: { cause?: unknown; askedAgainAt?: Date | null } = {},
  ) {
    const again = options.askedAgainAt ? `after ${options.askedAgainAt.toISOString().slice(11, 19)} UTC` : 'next time';
    super(`${GITHUB_DID_NOT_ANSWER} ${bot}'s sign-in (${reason}); it is asked again ${again}`, { cause: options.cause });
    this.name = 'GitHubUnavailableError';
  }
}

/** The waits between tries at saving a rotated refresh token. */
const SAVE_RETRY_MS = [250, 1000, 4000];

/**
 * The waits between tries at a refresh GitHub answered with an outage (`busy`).
 * GitHub answered a crew account's refresh with a 503 page for minutes at a
 * time (found live, 2026-10-21), and asked once, every task that started then
 * failed for good. A few seconds rides out a blip; a longer outage is the
 * bridge's to wait out (`retryAfterRecovery`). An `unclear` try is not asked
 * again at once: had GitHub taken it, the same token sent again is refused as
 * used, and every seat on the account would be marked revoked.
 */
const REFRESH_RETRY_MS = [1000, 2000, 4000];

/**
 * How long a sign-in whose refresh GitHub did not answer is not asked again:
 * every ask fails at once meanwhile. The merge job's sweep runs failed starts
 * again one after another, and each asked GitHub again, and waited for it,
 * before the gates and the merge line had their turn.
 */
const UNANSWERED_FOR_MS = 60 * 1000;

/**
 * What a token kept from before must still have left to serve a call while
 * GitHub does not answer its refresh: enough for one call to finish.
 */
const KEPT_TOKEN_MIN_LIFETIME_MS = 60 * 1000;

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
  /** Sign-ins GitHub did not answer the refresh of, until when they are not asked again, and why; see `UNANSWERED_FOR_MS`. */
  private readonly unanswered = new Map<string, { until: number; reason: string }>();
  /** The refresh token each sign-in last sent in a try that got no answer (`unclear`), which GitHub may have taken. */
  private readonly sentUnanswered = new Map<string, string>();
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

    let minting = this.inflight.get(bot);
    if (!minting) {
      minting = this.mint(bot, login).finally(() => this.inflight.delete(bot));
      this.inflight.set(bot, minting);
    }
    return minting.catch((error: unknown) => this.keptWhileUnanswered(bot, error, minLifetimeMs));
  }

  /**
   * The token from the last refresh that worked, for a call, when GitHub did
   * not answer this one: GitHub's sign-in endpoint can be down while its API
   * answers, and the token it issued is good until it expires. A caller asking
   * for more than a call's lifetime is a task, whose token must outlast it
   * (`TASK_TOKEN_MIN_LIFETIME_MS`): handed one that expires part way, it would
   * fail at the end, where the work is, so it is refused and started later.
   */
  private keptWhileUnanswered(bot: string, error: unknown, minLifetimeMs: number): BrokeredToken {
    const kept = this.cache.get(bot);
    if (!(error instanceof GitHubUnavailableError) || minLifetimeMs > CALL_TOKEN_MIN_LIFETIME_MS) throw error;
    if (!this.fresh(kept, KEPT_TOKEN_MIN_LIFETIME_MS)) throw error;
    console.warn(`[token-broker] using ${bot}'s last GitHub token until GitHub answers its refresh; it expires ${kept.expiresAt?.toISOString() ?? 'never'}`);
    return kept;
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
    const quiet = this.unanswered.get(bot);
    if (quiet && quiet.until > this.now().getTime()) {
      throw new GitHubUnavailableError(bot, quiet.reason, { askedAgainAt: new Date(quiet.until) });
    }
    const exclusive = this.options.exclusive;
    return exclusive ? exclusive(`github-refresh:${bot}`, () => this.mintAlone(bot, login)) : this.mintAlone(bot, login);
  }

  private async mintAlone(bot: string, login: string): Promise<BrokeredToken> {
    const held = this.unsaved.get(bot);
    let refreshToken = held ?? (await this.store.get(refreshTokenRef(bot)));

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
        `${bot} is not connected to GitHub. Run: openadlc auth login --bot ${bot}`,
      );
    }

    // A credential is marked revoked when GitHub says the authorization is
    // gone — not when this install cannot ask, which is a fault here and is
    // repaired by fixing the configuration. Marking it revoked turned a
    // missing client id into nine device flows to redo.
    const clientId = await this.clientId();
    const waits = this.options.refreshRetryMs ?? REFRESH_RETRY_MS;
    let readAgain = false;
    let refreshed: UserToken;
    for (let attempt = 0; ; attempt += 1) {
      try {
        refreshed = await refreshUserToken({ clientId, refreshToken, now: () => this.now() });
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failure = refreshFailure(error);
        if (failure === 'refused') {
          // The store may hold a newer token than the one sent: another
          // refresh — another bridge, the CLI, or one whose answer was lost
          // here — stored it since this one was read. Sent instead, once,
          // before anything is marked; never the store's when the token sent
          // was one held in memory, which is newer than the store's.
          if (!readAgain && held === undefined) {
            readAgain = true;
            const stored = await this.store.get(refreshTokenRef(bot)).catch(() => null);
            if (stored && stored !== refreshToken) {
              refreshToken = stored;
              continue;
            }
          }
          const spent = this.sentUnanswered.get(bot) === refreshToken ? '; a refresh before this one got no answer, and GitHub may have taken the token then' : '';
          await this.options.onRevoked?.(bot, message);
          // `--bot` takes the account's login, which every seat on it shares; the
          // name here is where the sign-in is filed, which a seat may not go by.
          throw new Error(`${bot}'s GitHub authorization is no longer valid (${message}${spent}). Reconnect it: openadlc auth login --bot ${login || bot}`, {
            cause: error,
          });
        }
        // Neither GitHub not answering nor a refusal: not waited out, and
        // nothing is marked. The next ask refreshes again.
        if (failure === 'other') {
          console.warn(`[token-broker] could not refresh ${bot}'s GitHub sign-in: ${message}`);
          throw new Error(`GitHub did not refresh ${bot}'s sign-in (${message})`, { cause: error });
        }
        // Not revoked when GitHub could not be reached, or answered with an
        // outage: that says nothing about the authorization, and marking it
        // revoked turned one network blip into a reconnect for every seat on
        // the account. An outage GitHub answered is asked again with the
        // same token, which it did not take.
        const wait = failure === 'busy' ? waits[attempt] : undefined;
        if (wait !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, wait));
          continue;
        }
        if (failure === 'unclear') this.sentUnanswered.set(bot, refreshToken);
        const until = this.now().getTime() + (this.options.unansweredForMs ?? UNANSWERED_FOR_MS);
        this.unanswered.set(bot, { until, reason: message });
        const unanswered = new GitHubUnavailableError(bot, message, { cause: error, askedAgainAt: new Date(until) });
        console.warn(`[token-broker] ${unanswered.message} (${attempt + 1} ${attempt === 0 ? 'try' : 'tries'})`);
        throw unanswered;
      }
    }
    this.unanswered.delete(bot);
    this.sentUnanswered.delete(bot);

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
