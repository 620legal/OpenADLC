import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { bots, modelAccounts } from '@fleetadlc/db';
import { modelPricesEnv, type ModelPrice } from '@fleetadlc/engines';
import {
  engineKeyRef,
  getSecretStore,
  internalSecretRef,
  modelAccountRef,
  signingKeyRef,
  taskTokenFor,
  type SecretStore,
} from '@fleetadlc/github';
import { loginRootFromEnv } from './config.js';
import type { SigningAgent } from './drivers/types.js';
import { keyEnv } from './key-env.js';
import { signInDir } from '@fleetadlc/backup';
import { CONTAINER_AUTH, CONTAINER_LOGIN, LOGIN_HOME_ENV, isDeviceProvider, loginDir } from './logins.js';

/** The account a bot was assigned, when it has been. */
export interface AssignedModelAccount {
  id: string;
  provider: 'anthropic' | 'openai' | 'xai';
  kind: 'key' | 'subscription';
}

export type AssignedAccountLookup = (botName: string) => Promise<AssignedModelAccount | null>;

const PROVIDER_ENV: Record<AssignedModelAccount['provider'], string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  xai: 'XAI_API_KEY',
};

/**
 * What Claude Code reads a subscription's long-lived token from — the one
 * `claude setup-token` prints. `ANTHROPIC_API_KEY` takes precedence over it,
 * so the two are never set together.
 */
export const SUBSCRIPTION_TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';

/**
 * Where a session finds an account's login: the home mounted inside
 * a bot's container, or the account's sign-in directory when the session
 * runs on the host. The driver answers; see `ExecDriver.loginPath`.
 */
export type LoginLocator = (accountId: string) => string;

/** The host's answer, for a caller that was given no driver's. */
const onTheHost: LoginLocator = (accountId) => signInDir(loginDir(loginRootFromEnv(), accountId));

/** The per-bot key has no provider of its own; the bot's engine is the signal. */
const ENGINE_ENV: Record<string, string> = {
  claude: 'ANTHROPIC_API_KEY',
  codex: 'OPENAI_API_KEY',
  grok: 'XAI_API_KEY',
};

async function lookupAssignedAccount(botName: string): Promise<AssignedModelAccount | null> {
  const bot = await bots.getBotByName(botName);
  if (!bot?.modelAccountId) return null;
  const account = await modelAccounts.get(bot.modelAccountId);
  if (!account) return null;
  return { id: account.id, provider: account.provider, kind: account.kind };
}

export interface EngineCredential {
  /** `account` when one is assigned; `fallback` is the per-bot key an install stored before model accounts. */
  source: 'account' | 'fallback';
  kind: AssignedModelAccount['kind'] | null;
  /** The variable a secret is injected as, or null when this credential has none. */
  envVar: string | null;
  /**
   * The secret: an API key, or a Claude subscription's token. Null when there
   * is nothing to inject. Never an empty string.
   */
  key: string | null;
  /**
   * An OpenAI or xAI subscription's login: the variable that points the CLI
   * at its directory, and where that directory is for this session. Null for
   * every other kind of account.
   */
  login: { envVar: string; path: string } | null;
  accountId: string | null;
  /**
   * Set when the per-bot key is plainly another provider's: the provider it
   * belongs to. Nothing is injected then, and a task refuses to start.
   */
  foreignKey?: AssignedModelAccount['provider'];
}

const PROVIDER_ARTICLE: Record<AssignedModelAccount['provider'], string> = {
  anthropic: 'an Anthropic',
  openai: 'an OpenAI',
  xai: 'an xAI',
};

const ENGINE_PROVIDER_NAME: Record<string, AssignedModelAccount['provider']> = {
  claude: 'anthropic',
  codex: 'openai',
  grok: 'xai',
};

/**
 * The provider a key plainly belongs to when that is not the engine's own, or
 * null. Only a positive match counts — `sk-ant-` is Anthropic's, `xai-` is
 * xAI's, any other `sk-` is OpenAI's — so a key of a shape nobody here knows
 * is left alone rather than refused.
 */
export function keyBelongsElsewhere(key: string, engine: string): AssignedModelAccount['provider'] | null {
  const own = ENGINE_PROVIDER_NAME[engine];
  if (!own) return null;
  const owner: AssignedModelAccount['provider'] | null = key.startsWith('sk-ant-')
    ? 'anthropic'
    : key.startsWith('xai-')
      ? 'xai'
      : key.startsWith('sk-')
        ? 'openai'
        : null;
  return owner && owner !== own ? owner : null;
}

/**
 * Which credential this task presents, and how.
 *
 * An assigned account wins. A key account is its key, as the provider's
 * variable. A Claude subscription is the token `claude setup-token` printed,
 * as `CLAUDE_CODE_OAUTH_TOKEN` — and never with an `ANTHROPIC_API_KEY` beside
 * it, which Claude Code would use instead. An OpenAI or xAI subscription is a
 * sign-in shared by every bot on the account: `CODEX_HOME` or `GROK_HOME`
 * names the home it is found in (`ExecDriver.loginPath`), and no key variable
 * is set, because an empty one would shadow the login. No assignment falls back to `engineKeyRef(bot)`, kept for
 * installs that stored a per-bot key before model accounts existed.
 */
export async function readEngineCredential(
  input: { bot: string; engine: string; account?: AssignedModelAccount | null },
  store: SecretStore,
  accounts: AssignedAccountLookup = lookupAssignedAccount,
  locate: LoginLocator = onTheHost,
): Promise<EngineCredential> {
  // Given when the caller has already read the assignment, and then the one
  // that is used. `null` is an answer too: no account, so the per-bot key.
  const account = input.account !== undefined ? input.account : await accounts(input.bot);
  if (account) {
    if (account.kind === 'subscription') {
      if (isDeviceProvider(account.provider)) {
        return {
          source: 'account',
          kind: 'subscription',
          envVar: null,
          key: null,
          login: { envVar: LOGIN_HOME_ENV[account.provider], path: locate(account.id) },
          accountId: account.id,
        };
      }
      const token = (await store.get(modelAccountRef(account.id)))?.trim() ?? '';
      return {
        source: 'account',
        kind: 'subscription',
        envVar: SUBSCRIPTION_TOKEN_ENV,
        key: token.length > 0 ? token : null,
        login: null,
        accountId: account.id,
      };
    }
    const stored = (await store.get(modelAccountRef(account.id)))?.trim() ?? '';
    return {
      source: 'account',
      kind: 'key',
      envVar: PROVIDER_ENV[account.provider],
      key: stored.length > 0 ? stored : null,
      login: null,
      accountId: account.id,
    };
  }

  const stored = (await store.get(engineKeyRef(input.bot)))?.trim() ?? '';
  const envVar = ENGINE_ENV[input.engine] ?? null;
  // A per-bot key was stored for the engine the bot had then. A bot since
  // moved to another provider — by an account, then left without one — would
  // present that provider its old one's key.
  const foreign = stored ? keyBelongsElsewhere(stored, input.engine) : null;
  if (foreign) {
    return { source: 'fallback', kind: null, envVar: null, key: null, login: null, accountId: null, foreignKey: foreign };
  }
  return {
    source: 'fallback',
    kind: null,
    envVar: stored && envVar ? envVar : null,
    key: stored.length > 0 ? stored : null,
    login: null,
    accountId: null,
  };
}

const run = promisify(execFile);

/** The real OpenSSH binary, preferred over whatever PATH resolves first. */
async function resolveSshKeygen(): Promise<string | null> {
  const { existsSync } = await import('node:fs');
  for (const candidate of ['/usr/bin/ssh-keygen', '/bin/ssh-keygen', '/usr/local/bin/ssh-keygen']) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    const { stdout } = await run('sh', ['-c', 'command -v ssh-keygen']);
    const resolved = stdout.trim();
    return resolved.length > 0 ? resolved : null;
  } catch {
    return null;
  }
}

export interface SessionEnvInput {
  bot: string;
  githubLogin: string | null;
  taskId: string;
  token: string | null;
  engine: string;
  /** The resolved id. Never an alias. */
  model: string;
  /** The configured alias, when one was resolved. Null for a pinned id. */
  modelAlias?: string | null;
  /**
   * The account `model` was resolved against. The task runner passes it so the
   * key is that account's: reading the row again here could find a different
   * assignment, saved from the console in between, and pair one account's
   * model with another's key. Omitted, the row is read.
   */
  account?: AssignedModelAccount | null;
  skill: string;
  workdir: string;
  bridgeUrl: string;
  /** Where the task reaches hostd, for the registry credential it installs with. */
  hostdUrl: string;
  /** hostd names a private registry (`FLEETADLC_REGISTRY_HOST`), so `fleetadlc-install` must not install without it. */
  registryConfigured?: boolean;
  costCapUsd: number;
  contextFiles: string[];
  /** The task's own database, or null when it has none. */
  databaseUrl: string | null;
  declaredPaths: string[];
  repoFullName: string | null;
  subjectRef: string;
  /**
   * What the session's own posts to GitHub start with. The `gh` on its PATH
   * (`bin/gh` in this package) puts it first on every body it posts, so a crew
   * on one account still says which stage wrote each comment.
   */
  postHeader?: string | null;
  /** A review task's part; `advisory` holds the session's `gh` to comments. */
  reviewMode?: string | null;
  /** A review task's lens; its brief states it with the part. */
  reviewLens?: string | null;
  /** The task's own home (`<slot>/home`); see `withRepoHome`. */
  repoHome?: string | null;
  /** The install's prices, which the session charges its usage at; see `HostdConfig.modelPrices`. */
  modelPrices?: Record<string, ModelPrice>;
}

export interface MintedEnv {
  env: Record<string, string>;
  /** Stops the task's own ssh-agent, which holds its loaded key, and removes its socket when the task ends. */
  cleanup: () => Promise<void>;
}

/**
 * Starts the agent that holds a bot's signing key where its sessions can reach
 * it; see `ExecDriver.startSigningAgent`. The default is the host's own agent.
 * The task is named because a computer is per task: the agent goes in the
 * task's own, and dies with it.
 */
export type SigningAgentStarter = (bot: string, privateKey: string, taskId: string) => Promise<SigningAgent | null>;

/**
 * Mints the environment a task runs in and nothing more: a short-lived GitHub
 * user token for the bot's own account, its engine key, an ssh-agent holding the
 * signing key, and the task's own identifiers. The environment dies with the
 * session; no secret is written to the worktree.
 */
export class SessionEnvMinter {
  constructor(
    private readonly store: SecretStore = getSecretStore(),
    private readonly accounts: AssignedAccountLookup = lookupAssignedAccount,
    /** The driver's answer to where a login is for a session; see `LoginLocator`. */
    private readonly locate: LoginLocator = onTheHost,
    /** The driver's agent, where its sessions run; the host's when it has none. */
    private readonly signing: SigningAgentStarter = hostSigningAgent,
  ) {}

  /**
   * The task's own token (`taskTokenFor`), which `make setup` and local CI
   * need as well as the session: `fleetadlc-install` presents it to hostd for
   * the registry credential. Null on an install whose bridge has not written
   * its secret yet, in which case the session reports nothing and hostd's own
   * observer is what notices the task ending.
   */
  async taskToken(taskId: string): Promise<string | null> {
    const installSecret = await this.store.get(internalSecretRef());
    return installSecret ? taskTokenFor(taskId, installSecret) : null;
  }

  async mint(input: SessionEnvInput): Promise<MintedEnv> {
    const taskToken = await this.taskToken(input.taskId);

    const env: Record<string, string> = {
      FLEETADLC_TASK_ID: input.taskId,
      FLEETADLC_BOT: input.bot,
      FLEETADLC_SKILL: input.skill,
      FLEETADLC_ENGINE: input.engine,
      // The id the engine calls. The alias, if the bot was configured with
      // one, is a second variable so the ledger can record both and the model
      // column never holds `newest:`.
      FLEETADLC_MODEL: input.model,
      ...(input.modelAlias ? { FLEETADLC_MODEL_ALIAS: input.modelAlias } : {}),
      FLEETADLC_BRIDGE_URL: input.bridgeUrl,
      FLEETADLC_HOSTD_URL: input.hostdUrl,
      // Scoped to this task and nothing else. The session's command reports its
      // state, usage and gates to `/internal/tasks/<id>/*`, and this is what
      // admits it there — not the install's secret, which would also open
      // `/internal/dispatch/lease` and let a bot start work as any other bot.
      ...(taskToken ? { FLEETADLC_TASK_TOKEN: taskToken } : {}),
      // Set from hostd's own configuration, never the repository's, so a
      // repository cannot turn off `fleetadlc-install`'s refusal to install
      // without the registry's credential.
      ...(input.registryConfigured ? { FLEETADLC_REGISTRY_CONFIGURED: '1' } : {}),
      FLEETADLC_SUBJECT_REF: input.subjectRef,
      FLEETADLC_WORKDIR: input.workdir,
      FLEETADLC_CONTEXT_FILES: input.contextFiles.join(','),
      FLEETADLC_DECLARED_PATHS: input.declaredPaths.join(','),
      FLEETADLC_TASK_COST_CAP_USD: String(input.costCapUsd),
      // Passed through so the integration suites can run scripted engines.
      // Never set by an install: see FLEETADLC_SCRIPTED_ENGINES in the CLI.
      ...(process.env.FLEETADLC_SCRIPTED_ENGINES === '1' ? { FLEETADLC_SCRIPTED_ENGINES: '1' } : {}),
      // Only ever the task's own: the platform's database is not a bot's to see.
      ...(input.databaseUrl ? { DATABASE_URL: input.databaseUrl } : {}),
      ...(input.repoFullName ? { FLEETADLC_REPO: input.repoFullName } : {}),
      ...(input.postHeader ? { FLEETADLC_POST_HEADER: input.postHeader } : {}),
      ...(input.reviewMode ? { FLEETADLC_REVIEW_MODE: input.reviewMode } : {}),
      ...(input.reviewLens ? { FLEETADLC_REVIEW_LENS: input.reviewLens } : {}),
      ...(input.repoHome ? { FLEETADLC_REPO_HOME: input.repoHome } : {}),
      // The install's prices. The session never reads a price from its
      // working directory, which is the managed repository's checkout.
      ...modelPricesEnv(input.modelPrices ?? {}),
    };

    if (input.token) {
      env.GITHUB_TOKEN = input.token;
      env.GH_TOKEN = input.token;
    }

    const credential = await readEngineCredential(input, this.store, this.accounts, this.locate);
    if (credential.foreignKey) {
      // Refused before anything is minted, so the reason is the task's own
      // rather than an authentication error from the CLI. Never the key.
      throw new Error(
        `${input.bot} runs ${input.engine} with no model account, and its per-bot key is ${PROVIDER_ARTICLE[credential.foreignKey]} key — ` +
          `give ${input.bot} an account on the assignment step`,
      );
    }
    if (credential.source === 'fallback' && credential.key) {
      // A key stored before model accounts existed. An install that has one has not lost it,
      // and the log is how an operator can see that it has not been moved.
      console.warn(
        `[hostd] ${input.bot}: no model account assigned; falling back to the per-bot engine key — ` +
          `give ${input.bot} an account on the assignment step`,
      );
    } else if (credential.source === 'account' && credential.kind === 'key' && !credential.key) {
      console.warn(
        `[hostd] ${input.bot}: model account ${credential.accountId} has no key stored — ` +
          `replace its key on the account in the console, or assign ${input.bot} another account`,
      );
    } else if (credential.envVar === SUBSCRIPTION_TOKEN_ENV && !credential.key) {
      // The task still starts, and fails the way an unsigned-in CLI does; this
      // is the line that says why, and what fixes it. Never the token.
      console.warn(
        `[hostd] ${input.bot}: subscription account ${credential.accountId} has no token stored — ` +
          'run `claude setup-token` on a machine signed in to it and paste the token on the account',
      );
    }
    // Nothing is set without a value: an empty variable would shadow the
    // credential it was meant to be.
    if (credential.envVar && credential.key) {
      Object.assign(env, keyEnv(credential.envVar, credential.key));
    }
    if (credential.envVar === SUBSCRIPTION_TOKEN_ENV) {
      // It is never set above for this account, and this says so where the
      // token goes in: with both present, Claude Code uses the key and bills
      // the API rather than the subscription.
      delete env.ANTHROPIC_API_KEY;
    }
    if (credential.login) {
      env[credential.login.envVar] = credential.login.path;
      // Grok renames auth.json. Under docker the home is the task's own, and
      // the sign-in is in the account's sign-in directory at CONTAINER_AUTH.
      if (credential.login.envVar === LOGIN_HOME_ENV.xai && credential.login.path === CONTAINER_LOGIN) {
        env.GROK_AUTH_PATH = `${CONTAINER_AUTH}/auth.json`;
      }
    }

    if (input.githubLogin) {
      env.GIT_AUTHOR_NAME = input.bot;
      env.GIT_COMMITTER_NAME = input.bot;
      const email = `${input.githubLogin}@users.noreply.github.com`;
      env.GIT_AUTHOR_EMAIL = email;
      env.GIT_COMMITTER_EMAIL = email;
    }

    // Git's settings for the session, as GIT_CONFIG_* variables: nothing is
    // written to a file the worktree serves or the container keeps.
    const gitConfig: [string, string][] = [];

    const agent = await this.startAgent(input.bot, input.taskId);
    if (agent) {
      env.SSH_AUTH_SOCK = agent.socket;
      // The private key exists only in the agent, so git signs by naming the
      // literal public key and letting ssh-keygen find its pair there.
      gitConfig.push(['gpg.format', 'ssh'], ['user.signingkey', `key::${agent.publicKey}`], ['commit.gpgsign', 'true']);

      // Pin the signing binary. A wrapper earlier on PATH that does not forward
      // agent signing turns every commit into "failed to write commit object",
      // which is a confusing way to learn that signing is misconfigured. The
      // one where the session runs: a host path means nothing in a container.
      if (agent.signer) gitConfig.push(['gpg.ssh.program', agent.signer]);
    }

    if (input.token) {
      // `git push` asks gh for the token the session already holds. Without
      // this a plain push had no credentials: the builder of fleetadlc-testbed#4
      // found that out mid-task and ran `gh auth setup-git`, which writes the
      // helper into the container's own configuration for good.
      gitConfig.push(['credential.https://github.com.helper', '!gh auth git-credential']);
    }

    if (gitConfig.length > 0) {
      env.GIT_CONFIG_COUNT = String(gitConfig.length);
      gitConfig.forEach(([key, value], index) => {
        env[`GIT_CONFIG_KEY_${index}`] = key;
        env[`GIT_CONFIG_VALUE_${index}`] = value;
      });
    }

    return {
      env,
      cleanup: async () => {
        if (agent) await agent.stop();
      },
    };
  }

  private async startAgent(bot: string, taskId: string): Promise<SigningAgent | null> {
    const privateKey = await this.store.get(signingKeyRef(bot));
    if (!privateKey) return null;
    return this.signing(bot, privateKey, taskId);
  }
}

/**
 * The host's own ssh-agent, for sessions that run on the host — the local
 * driver's. A docker session cannot reach a socket made here; its driver
 * starts one inside the container instead.
 */
export async function hostSigningAgent(bot: string, privateKey: string): Promise<SigningAgent | null> {
  const dir = mkdtempSync(join(tmpdir(), `fleetadlc-agent-${bot}-`));
  const socket = join(dir, 'agent.sock');
  let pid: number | null = null;
  // The agent is stopped by the PID it printed. `ssh-agent -k` kills whatever
  // SSH_AGENT_PID names: with only the socket set it refused, and the agent
  // stayed up holding the bot's key, one more per task; with the SSH_AGENT_PID
  // hostd inherited from the shell that ran `fleetadlc up`, it killed the
  // operator's own agent instead.
  const stopAgent = (): void => {
    if (pid === null) return;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
    pid = null;
  };

  try {
    const started = await run('ssh-agent', ['-s', '-a', socket]);
    const printed = /SSH_AGENT_PID=(\d+)/.exec(started.stdout)?.[1];
    if (!printed) throw new Error('ssh-agent did not say its PID');
    pid = Number(printed);
    const add = spawn('ssh-add', ['-'], { env: { ...process.env, SSH_AUTH_SOCK: socket } });
    add.stdin.write(privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`);
    add.stdin.end();
    await new Promise<void>((resolve, reject) => {
      add.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ssh-add exited ${code}`))));
      add.on('error', reject);
    });

    const { stdout } = await run('ssh-add', ['-L'], { env: { ...process.env, SSH_AUTH_SOCK: socket } });
    return {
      socket,
      publicKey: stdout.trim().split('\n')[0] ?? '',
      signer: await resolveSshKeygen(),
      stop: async () => {
        stopAgent();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch {
    // An agent that started and then could not take the key is stopped too.
    stopAgent();
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
}
