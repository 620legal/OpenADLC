import { bots, credentials, identities, withAdvisoryLock } from '@fleetadlc/db';
import { headerFor, type Bot } from '@fleetadlc/shared';
import type { Attribution } from './attribution.js';
import {
  appClientSecretRef,
  ConfigurationError,
  getSecretStore,
  GitHubClient,
  refusedByGitHub,
  TokenBroker,
  type ScopedOutcome,
} from '@fleetadlc/github';

export interface MintedToken {
  token: string;
  expiresAt: string | null;
  login: string;
  /**
   * For a token asked for one repository: whether GitHub narrowed it to that
   * repository. False when it is the account's own, which reaches every
   * repository the account can; absent when no repository was asked for.
   */
  scoped?: boolean;
}

/**
 * Hands out a GitHub client that acts as one seat's account. What the platform
 * writes is attributable to the seat that did it: by its own account, or, for
 * seats sharing one, by the stage header and the signed seat tag on each post.
 *
 * This is also the install's token broker while it runs. GitHub rotates a
 * refresh token on every use, so a second component refreshing the same
 * credential invalidates the first; hostd and the CLI ask the bridge, and the
 * CLI refreshes directly, under the same lock, only when the bridge does not
 * answer (`commands/github.ts`).
 */
export class Actors {
  private readonly broker: TokenBroker;
  /** How the last try at a token scoped to a repository went; null before the first. */
  private scoped: ScopedOutcome | null = null;

  /**
   * `clientId` is a function because an install is configured from the console
   * after this process started. Reading it once at construction meant the
   * broker held the environment's value — empty, for a browser-configured
   * install — and refreshed every token with `client_id=`.
   *
   * `installName` is what the header on every post calls this install; asked
   * per client, since it can be changed in the console while the bridge runs.
   */
  constructor(
    private readonly clientId: string | (() => Promise<string>),
    private readonly installName: () => Promise<string> = async () => 'OpenADLC',
    /** Signs what each seat posts; absent in tests and tools that post nothing. */
    readonly attribution?: Attribution,
  ) {
    // The broker is built whether or not a client id is configured: refreshing a
    // device-flow token needs one, but an install whose app issues non-expiring
    // user tokens has a stored token and nothing to refresh.
    this.broker = new TokenBroker({
      clientId,
      // Read per call, so a secret pasted in settings narrows the next task's token.
      clientSecret: () => getSecretStore().get(appClientSecretRef()),
      onScoped: (outcome) => {
        this.scoped = outcome;
      },
      // One refresh at a time across every bridge on this database; see TokenBroker.
      exclusive: (key, fn) => withAdvisoryLock(key, fn),
      // The broker keys a sign-in by the name its secrets are filed under,
      // which every seat on one account shares; each of those seats shows the
      // refreshed expiry, or the revocation.
      onRefreshed: async (ns, token) => {
        for (const record of await seatsOn(ns)) {
          await credentials.setTokenExpiry(record.id, token.expiresAt, token.refreshExpiresAt);
        }
      },
      onRevoked: async (ns) => {
        for (const record of await seatsOn(ns)) await credentials.setCredentialStatus(record.id, 'revoked');
      },
    });
  }

  get configured(): boolean {
    return typeof this.clientId === 'function' || this.clientId.length > 0;
  }

  async asBot(botName: string): Promise<GitHubClient | null> {
    const bot = await bots.getBotByName(botName);
    if (!bot?.githubLogin) return null;

    try {
      const brokered = await this.broker.tokenFor(await signInOf(bot), bot.githubLogin);
      // Headed as the bot's stage — the automation bot's as the platform — so a
      // crew on one account still says, on every post, which stage wrote it.
      const header = headerFor(await this.installName().catch(() => 'OpenADLC'), bot.role);
      const sign = await this.attribution?.signerFor(bot.name).catch((error: unknown) => {
        console.warn(`[bridge] ${botName} posts unsigned: ${error instanceof Error ? error.message : error}`);
        return undefined;
      });
      return new GitHubClient({ token: brokered.token, actingAs: bot.githubLogin, header, seat: bot.name, ...(sign ? { sign } : {}) });
    } catch (error) {
      console.warn(`[bridge] cannot act as ${botName}: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }

  /**
   * Runs `fn` while no token is minted under any of these names: what a rename
   * holds while it moves a bot's refresh token from one name to the other. See
   * `TokenBroker.exclusive`.
   */
  exclusive<T>(names: readonly string[], fn: () => Promise<T>): Promise<T> {
    return this.broker.exclusive(names, fn);
  }

  /**
   * Whether an account's sign-in still gives a token, asked by where it is
   * filed rather than by a bot: an account no bot is on has no bot to ask
   * as. Through the broker, like every other use, since a refresh rotates
   * the token and only one component may do that. Null when this install
   * cannot ask — no client id configured — which says nothing about the
   * account.
   */
  async signsIn(account: { secretNs: string; login: string }): Promise<boolean | null> {
    const state = await this.signInState(account);
    return state === 'works' ? true : state === 'unknown' ? null : false;
  }

  /**
   * `signsIn`, telling apart why a sign-in gave no token: `refused` when
   * GitHub said no, which stays so until someone reconnects, and `failed`
   * when GitHub could not be reached or answered with an outage, which the
   * next ask may not repeat.
   */
  async signInState(account: { secretNs: string; login: string }): Promise<'works' | 'refused' | 'failed' | 'unknown'> {
    try {
      await this.broker.tokenFor(account.secretNs, account.login);
      return 'works';
    } catch (error) {
      if (error instanceof ConfigurationError) return 'unknown';
      return refusedByGitHub(error) ? 'refused' : 'failed';
    }
  }

  /**
   * A token for another component to act as this bot. `minLifetimeMs` is how
   * long the caller needs it to stay valid — a task asks for longer than a
   * single API call, because it may still be running hours from now.
   */
  async tokenFor(botName: string, options: { minLifetimeMs?: number; repository?: string } = {}): Promise<MintedToken | null> {
    const bot = await bots.getBotByName(botName);
    if (!bot?.githubLogin) return null;

    const { repository, ...lifetime } = options;
    if (repository) {
      // A task's: narrowed to its repository where the install can, since the
      // account itself is in every repository OpenADLC manages.
      const brokered = await this.broker.tokenForRepository(await signInOf(bot), bot.githubLogin, repository, lifetime);
      return {
        token: brokered.token,
        expiresAt: brokered.expiresAt?.toISOString() ?? null,
        login: brokered.login,
        scoped: brokered.scoped,
      };
    }
    const brokered = await this.broker.tokenFor(await signInOf(bot), bot.githubLogin, lifetime);
    return {
      token: brokered.token,
      expiresAt: brokered.expiresAt?.toISOString() ?? null,
      login: brokered.login,
    };
  }

  /** How the last try at a token scoped to a repository went, for the `app-client-secret` check; null before the first. */
  lastScoped(): ScopedOutcome | null {
    return this.scoped;
  }
}

/**
 * The name a bot's GitHub sign-in is filed under: its identity's, which seats
 * on one account share, so the broker refreshes that account once for all of
 * them. A bot on an account of its own is filed under its own name, as it
 * always was; one whose identity is not recorded yet falls back to that too.
 */
async function signInOf(bot: Bot): Promise<string> {
  return (await identities.identityOfBot(bot.id))?.secretNs ?? bot.name;
}

/** The seats signed in under one name, or the bot of that name when no identity says. */
async function seatsOn(ns: string): Promise<Bot[]> {
  const names = await identities.botsOnSecretNs(ns);
  const found = await Promise.all((names.length > 0 ? names : [ns]).map((name) => bots.getBotByName(name)));
  return found.filter((bot): bot is Bot => Boolean(bot));
}
