import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { internalSecretRef, modelAccountRef, engineKeyRef, taskTokenFor, type SecretStore } from '@fleetadlc/github';
import {
  SessionEnvMinter,
  hostSigningAgent,
  keyBelongsElsewhere,
  readEngineCredential,
  type AssignedModelAccount,
  type SessionEnvInput,
} from './session-env.js';

const ACCOUNT = '550e8400-e29b-41d4-a716-446655440000';
const SECRET = 'sk-shared-account-key';
// An Anthropic key: atlas runs claude, and a per-bot key of another
// provider's shape is refused (see the end of this file).
const PER_BOT = 'sk-ant-old-per-bot-key';

function memory(initial: Record<string, string> = {}): SecretStore {
  const data = new Map(Object.entries(initial));
  return {
    async get(ref) {
      return data.get(ref) ?? null;
    },
    async set(ref, value) {
      data.set(ref, value);
    },
    async delete(ref) {
      data.delete(ref);
    },
    async list(prefix = '') {
      return [...data.keys()].filter((ref) => ref.startsWith(prefix)).sort();
    },
  };
}

function input(bot: string, engine = 'claude'): SessionEnvInput {
  return {
    bot,
    githubLogin: null,
    taskId: `task-${bot}`,
    token: null,
    engine,
    model: 'claude-opus-5',
    skill: 'implement',
    workdir: '/tmp/wt',
    bridgeUrl: 'http://bridge',
    hostdUrl: 'http://hostd',
    costCapUsd: 15,
    contextFiles: [],
    databaseUrl: null,
    declaredPaths: [],
    repoFullName: null,
    subjectRef: 'janedoe/FleetADLC#154',
  };
}

function assigned(kind: AssignedModelAccount['kind'], provider: AssignedModelAccount['provider'] = 'anthropic') {
  return async () => ({ id: ACCOUNT, provider, kind });
}

const none = async () => null;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('what a session gives fleetadlc-install', () => {
  it('is the task’s own token, and the registry flag only when hostd names a registry', async () => {
    const store = memory({ [modelAccountRef(ACCOUNT)]: SECRET, [internalSecretRef()]: 'install-secret' });
    const minter = new SessionEnvMinter(store, assigned('key'));

    const configured = await minter.mint({ ...input('atlas'), registryConfigured: true });
    const plain = await minter.mint(input('atlas'));

    expect(configured.env.FLEETADLC_TASK_TOKEN).toBe(taskTokenFor('task-atlas', 'install-secret'));
    expect(await minter.taskToken('task-atlas')).toBe(configured.env.FLEETADLC_TASK_TOKEN);
    expect(configured.env.FLEETADLC_REGISTRY_CONFIGURED).toBe('1');
    expect(plain.env).not.toHaveProperty('FLEETADLC_REGISTRY_CONFIGURED');
  });
});

describe('a task environment and where its key comes from', () => {
  it('names the cost cap as it names every other session variable, under FLEETADLC_', async () => {
    const minted = await new SessionEnvMinter(memory({ [modelAccountRef(ACCOUNT)]: SECRET }), assigned('key')).mint(input('atlas'));
    expect(minted.env.FLEETADLC_TASK_COST_CAP_USD).toBe('15');
    expect(minted.env).not.toHaveProperty('TASK_COST_CAP_USD');
    await minted.cleanup();
  });

  it('injects one account key for every bot assigned to it', async () => {
    const store = memory({ [modelAccountRef(ACCOUNT)]: SECRET, [engineKeyRef('atlas')]: PER_BOT });
    const minter = new SessionEnvMinter(store, assigned('key'));

    const atlas = await minter.mint(input('atlas'));
    const nova = await minter.mint(input('nova', 'claude'));

    expect(atlas.env.ANTHROPIC_API_KEY).toBe(SECRET);
    expect(nova.env.ANTHROPIC_API_KEY).toBe(SECRET);
    expect(atlas.env.ANTHROPIC_API_KEY).not.toBe(PER_BOT);
    await atlas.cleanup();
    await nova.cleanup();
  });

  it('picks the variable from the account provider', async () => {
    const store = memory({ [modelAccountRef(ACCOUNT)]: SECRET });
    const openai = await new SessionEnvMinter(store, assigned('key', 'openai')).mint(input('quill', 'codex'));
    const xai = await new SessionEnvMinter(store, assigned('key', 'xai')).mint(input('lens', 'grok'));

    expect(openai.env.OPENAI_API_KEY).toBe(SECRET);
    // Codex reads the key from CODEX_API_KEY; given only OPENAI_API_KEY it sends none.
    expect(openai.env.CODEX_API_KEY).toBe(SECRET);
    expect(openai.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(xai.env.XAI_API_KEY).toBe(SECRET);
    await openai.cleanup();
    await xai.cleanup();
  });

  it('injects no key for a subscription, including no empty variable', async () => {
    // The account ref holds an empty file and the bot still has a per-bot key.
    // Neither may be injected: an empty variable shadows the credential it was
    // meant to be, and falling back to the per-bot key would bill the API.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = memory({
      [modelAccountRef(ACCOUNT)]: '',
      [engineKeyRef('atlas')]: PER_BOT,
    });
    const minted = await new SessionEnvMinter(store, assigned('subscription')).mint(input('atlas'));

    expect(minted.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(minted.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(minted.env).not.toHaveProperty('XAI_API_KEY');
    expect(Object.values(minted.env)).not.toContain(PER_BOT);
    expect(Object.values(minted.env)).not.toContain(SECRET);
    expect(minted.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(warn.mock.calls.flat().join('\n')).not.toContain('falling back');
    await minted.cleanup();
  });

  it('keeps a per-bot key working and says it is the fallback', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = memory({ [engineKeyRef('atlas')]: PER_BOT });
    const minted = await new SessionEnvMinter(store, none).mint(input('atlas'));

    expect(minted.env.ANTHROPIC_API_KEY).toBe(PER_BOT);
    const logged = warn.mock.calls.flat().join('\n');
    expect(logged).toContain('falling back');
    expect(logged).toContain('give atlas an account on the assignment step');
    expect(logged).not.toContain(PER_BOT);
    await minted.cleanup();
  });

  it('does not fall back once an account is assigned, even when that account has no key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = memory({ [engineKeyRef('atlas')]: PER_BOT });
    const minted = await new SessionEnvMinter(store, assigned('key')).mint(input('atlas'));

    expect(minted.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    const logged = warn.mock.calls.flat().join('\n');
    expect(logged).toContain('has no key stored — replace its key on the account in the console, or assign atlas another account');
    expect(logged).not.toContain('falling back');
    expect(logged).not.toContain(PER_BOT);
    await minted.cleanup();
  });

  it('sees a rotated key on the next task, because every bot reads the same ref', async () => {
    const store = memory({ [modelAccountRef(ACCOUNT)]: SECRET });
    const minter = new SessionEnvMinter(store, assigned('key'));
    const before = await minter.mint(input('atlas'));
    await store.set(modelAccountRef(ACCOUNT), 'sk-rotated');
    const afterAtlas = await minter.mint(input('atlas'));
    const afterNova = await minter.mint(input('nova'));

    expect(before.env.ANTHROPIC_API_KEY).toBe(SECRET);
    expect(afterAtlas.env.ANTHROPIC_API_KEY).toBe('sk-rotated');
    expect(afterNova.env.ANTHROPIC_API_KEY).toBe('sk-rotated');
    await before.cleanup();
    await afterAtlas.cleanup();
    await afterNova.cleanup();
  });

  it('uses the account the model was resolved against, not a second read of the row', async () => {
    // Between resolving the model and minting the key, the console moved the
    // bot to another account. The key has to match the model it was chosen with.
    const OTHER = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    const store = memory({ [modelAccountRef(ACCOUNT)]: SECRET, [modelAccountRef(OTHER)]: 'sk-the-new-account' });
    const reread = vi.fn(async () => ({ id: OTHER, provider: 'anthropic' as const, kind: 'key' as const }));

    const minted = await new SessionEnvMinter(store, reread).mint({
      ...input('atlas'),
      account: { id: ACCOUNT, provider: 'anthropic', kind: 'key' },
    });

    expect(minted.env.ANTHROPIC_API_KEY).toBe(SECRET);
    expect(reread).not.toHaveBeenCalled();
    await minted.cleanup();
  });

  it('takes no account as an answer, and uses the per-bot key', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = memory({ [modelAccountRef(ACCOUNT)]: SECRET, [engineKeyRef('atlas')]: PER_BOT });

    const minted = await new SessionEnvMinter(store, assigned('key')).mint({ ...input('atlas'), account: null });

    expect(minted.env.ANTHROPIC_API_KEY).toBe(PER_BOT);
    await minted.cleanup();
  });

  it('puts the resolved id in FLEETADLC_MODEL and the alias in its own variable', async () => {
    const store = memory();
    const minted = await new SessionEnvMinter(store, none).mint({
      ...input('atlas'),
      model: 'claude-opus-5',
      modelAlias: 'newest:opus',
    });

    expect(minted.env.FLEETADLC_MODEL).toBe('claude-opus-5');
    expect(minted.env.FLEETADLC_MODEL_ALIAS).toBe('newest:opus');
    expect(minted.env.FLEETADLC_MODEL).not.toMatch(/^newest:/);
    await minted.cleanup();
  });

  it('hands the session the install’s prices, which it charges at, and nothing when there are none', async () => {
    // A session runs in the managed repository's checkout; the prices it
    // charges at come from hostd, never from a file there.
    const store = memory();
    const minter = new SessionEnvMinter(store, none);
    const override = { 'gpt-5-codex': { inPerMtok: 250, outPerMtok: 10 } };

    const priced = await minter.mint({ ...input('quill', 'codex'), modelPrices: override });
    expect(JSON.parse(priced.env.FLEETADLC_MODEL_PRICES ?? '')).toEqual(override);
    expect(priced.env.FLEETADLC_CONFIG_ROOT).toBeUndefined();
    await priced.cleanup();

    const plain = await minter.mint({ ...input('quill', 'codex'), modelPrices: {} });
    expect('FLEETADLC_MODEL_PRICES' in plain.env).toBe(false);
    await plain.cleanup();
  });
});

describe('a subscription, signed in once and shared by every bot on it', () => {
  const TOKEN = 'sk-ant-oat01-the-token-setup-token-printed';
  const SEAT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
  const MOUNTED = () => '/fleetadlc/login';
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it('gives a bot on a Claude subscription the stored token, and no API key beside it', async () => {
    // hostd itself may have been started with a key, and the bot still has a
    // per-bot one. Either beside the token would be used instead of it.
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-hostd-own';
    const store = memory({ [modelAccountRef(ACCOUNT)]: TOKEN, [engineKeyRef('atlas')]: PER_BOT });

    const minted = await new SessionEnvMinter(store, assigned('subscription', 'anthropic'), MOUNTED).mint(input('atlas'));

    expect(minted.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    expect(minted.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(Object.values(minted.env)).not.toContain(PER_BOT);
    await minted.cleanup();
  });

  it('says what to run when a Claude subscription has no token, without injecting anything', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = memory({ [engineKeyRef('atlas')]: PER_BOT });

    const minted = await new SessionEnvMinter(store, assigned('subscription', 'anthropic'), MOUNTED).mint(input('atlas'));

    expect(minted.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(minted.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    const logged = warn.mock.calls.flat().join('\n');
    expect(logged).toContain('claude setup-token');
    expect(logged).toContain(ACCOUNT);
    expect(logged).not.toContain(PER_BOT);
    await minted.cleanup();
  });

  it('never writes the token into a log', async () => {
    const said = [
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
    const store = memory({ [modelAccountRef(ACCOUNT)]: TOKEN });

    const minted = await new SessionEnvMinter(store, assigned('subscription', 'anthropic'), MOUNTED).mint(input('atlas'));

    for (const spy of said) expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN);
    await minted.cleanup();
  });

  it('points two bots on one OpenAI subscription at the same login, and sets no key', async () => {
    const store = memory({ [modelAccountRef(SEAT)]: 'sk-should-never-be-read' });
    const seat = async () => ({ id: SEAT, provider: 'openai' as const, kind: 'subscription' as const });
    const minter = new SessionEnvMinter(store, seat, MOUNTED);

    const quill = await minter.mint(input('quill', 'codex'));
    const cipher = await minter.mint(input('cipher', 'codex'));

    expect(quill.env.CODEX_HOME).toBe('/fleetadlc/login');
    expect(cipher.env.CODEX_HOME).toBe(quill.env.CODEX_HOME);
    expect(quill.env).not.toHaveProperty('GROK_AUTH_PATH');
    expect(quill.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(Object.values(quill.env)).not.toContain('sk-should-never-be-read');
    await quill.cleanup();
    await cipher.cleanup();
  });

  it('points a bot on an xAI subscription at its login with GROK_HOME', async () => {
    const seat = async () => ({ id: SEAT, provider: 'xai' as const, kind: 'subscription' as const });

    const minted = await new SessionEnvMinter(memory(), seat, MOUNTED).mint(input('lens', 'grok'));

    expect(minted.env.GROK_HOME).toBe('/fleetadlc/login');
    expect(minted.env.GROK_AUTH_PATH).toBe('/fleetadlc/auth/auth.json');
    expect(minted.env).not.toHaveProperty('XAI_API_KEY');
    expect(minted.env).not.toHaveProperty('CODEX_HOME');
    await minted.cleanup();
  });

  it('does not set GROK_AUTH_PATH when the home is the account directory on the host', async () => {
    const seat = async () => ({ id: SEAT, provider: 'xai' as const, kind: 'subscription' as const });

    const minted = await new SessionEnvMinter(memory(), seat, (accountId) => `/home/op/.fleetadlc/logins/${accountId}`).mint(input('lens', 'grok'));

    expect(minted.env.GROK_HOME).toBe(`/home/op/.fleetadlc/logins/${SEAT}`);
    expect(minted.env).not.toHaveProperty('GROK_AUTH_PATH');
    await minted.cleanup();
  });

  it('asks the driver where the login is, so a host session gets the directory itself', async () => {
    const seat = async () => ({ id: SEAT, provider: 'openai' as const, kind: 'subscription' as const });
    const locate = vi.fn((accountId: string) => `/home/op/.fleetadlc/logins/${accountId}`);

    const minted = await new SessionEnvMinter(memory(), seat, locate).mint(input('quill', 'codex'));

    expect(locate).toHaveBeenCalledWith(SEAT);
    expect(minted.env.CODEX_HOME).toBe(`/home/op/.fleetadlc/logins/${SEAT}`);
    await minted.cleanup();
  });

  it('gives a bot on a key account no login at all', async () => {
    const store = memory({ [modelAccountRef(ACCOUNT)]: SECRET });

    const minted = await new SessionEnvMinter(store, assigned('key', 'openai'), MOUNTED).mint(input('quill', 'codex'));

    expect(minted.env.OPENAI_API_KEY).toBe(SECRET);
    expect(minted.env).not.toHaveProperty('CODEX_HOME');
    expect(minted.env).not.toHaveProperty('GROK_HOME');
    await minted.cleanup();
  });
});

describe('a per-bot key another provider issued', () => {
  function storeWith(refs: Record<string, string>) {
    return {
      get: async (ref: string) => refs[ref] ?? null,
      set: async () => undefined,
      delete: async () => undefined,
      list: async () => Object.keys(refs),
    };
  }

  it('is recognised by its prefix, and only a positive match counts', () => {
    expect(keyBelongsElsewhere('sk-proj-abc', 'claude')).toBe('openai');
    expect(keyBelongsElsewhere('sk-ant-api03-abc', 'codex')).toBe('anthropic');
    expect(keyBelongsElsewhere('sk-ant-api03-abc', 'grok')).toBe('anthropic');
    expect(keyBelongsElsewhere('xai-abc', 'claude')).toBe('xai');
    expect(keyBelongsElsewhere('sk-ant-api03-abc', 'claude')).toBeNull();
    expect(keyBelongsElsewhere('sk-proj-abc', 'codex')).toBeNull();
    expect(keyBelongsElsewhere('xai-abc', 'grok')).toBeNull();
    // A shape nobody here knows is left alone rather than refused.
    expect(keyBelongsElsewhere('key-of-another-shape', 'claude')).toBeNull();
  });

  it('is not injected, and the task refuses to start saying why', async () => {
    // cipher was moved to Claude by an account and left without one; its
    // per-bot key is the OpenAI key it was given as a Codex bot.
    const store = storeWith({ 'engine-key-cipher': 'sk-proj-openai-key' });
    const credential = await readEngineCredential({ bot: 'cipher', engine: 'claude', account: null }, store);
    expect(credential).toMatchObject({ source: 'fallback', envVar: null, key: null, foreignKey: 'openai' });

    const minter = new SessionEnvMinter(store, async () => null);
    await expect(
      minter.mint({
        bot: 'cipher',
        githubLogin: null,
        taskId: 'task-1',
        token: null,
        engine: 'claude',
        model: 'claude-opus-5',
        skill: 'pr-review',
        workdir: '/tmp/w',
        bridgeUrl: 'http://bridge',
        hostdUrl: 'http://hostd',
        costCapUsd: 1,
        contextFiles: [],
        databaseUrl: null,
        declaredPaths: [],
        repoFullName: null,
        subjectRef: 'repo#1',
      }),
    ).rejects.toThrow(/its per-bot key is an OpenAI key — give cipher an account/);
  });
});

describe('pushing', () => {
  // The builder of fleetadlc-testbed#4 found mid-task that a plain `git push` had
  // no credentials, and ran `gh auth setup-git`, which writes the helper into
  // the container's own configuration for good.
  it('lets git ask gh for the token the session holds, in the environment and nowhere else', async () => {
    const store = memory({ [modelAccountRef(ACCOUNT)]: SECRET });
    const minted = await new SessionEnvMinter(store, assigned('key'), undefined, none).mint({ ...input('atlas'), token: 'ghu_session' });

    const count = Number(minted.env.GIT_CONFIG_COUNT);
    const settings = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [minted.env[`GIT_CONFIG_KEY_${index}`], minted.env[`GIT_CONFIG_VALUE_${index}`]]),
    );
    expect(settings['credential.https://github.com.helper']).toBe('!gh auth git-credential');
    expect(minted.env.GH_TOKEN).toBe('ghu_session');
  });

  it('sets no helper for a session with no GitHub token', async () => {
    const store = memory({ [modelAccountRef(ACCOUNT)]: SECRET });
    const minted = await new SessionEnvMinter(store, assigned('key'), undefined, none).mint(input('atlas'));
    expect(minted.env.GIT_CONFIG_COUNT).toBeUndefined();
  });
});

describe('a review task’s part', () => {
  it('is in the session as FLEETADLC_REVIEW_MODE, which OpenADLC’s gh holds an advisory seat to', async () => {
    const store = memory({ [modelAccountRef(ACCOUNT)]: SECRET });
    const minter = new SessionEnvMinter(store, assigned('key'));

    const advisory = await minter.mint({ ...input('iris'), skill: 'pr-review', reviewMode: 'advisory' });
    const builder = await minter.mint(input('atlas'));

    expect(advisory.env.FLEETADLC_REVIEW_MODE).toBe('advisory');
    expect(builder.env).not.toHaveProperty('FLEETADLC_REVIEW_MODE');
    await advisory.cleanup();
    await builder.cleanup();
  });

  it('comes with its lens as FLEETADLC_REVIEW_LENS, which the brief states', async () => {
    const store = memory({ [modelAccountRef(ACCOUNT)]: SECRET });
    const minter = new SessionEnvMinter(store, assigned('key'));

    const security = await minter.mint({ ...input('iris'), skill: 'pr-review', reviewMode: 'blocking', reviewLens: 'security' });
    const builder = await minter.mint(input('atlas'));

    expect(security.env.FLEETADLC_REVIEW_LENS).toBe('security');
    expect(builder.env).not.toHaveProperty('FLEETADLC_REVIEW_LENS');
    await security.cleanup();
    await builder.cleanup();
  });
});

/**
 * The local driver's signing agent, run for real: what is being tested is
 * which process ends, and only a real ssh-agent can say.
 */
const hasSshAgent = spawnSync('ssh-agent', ['-k'], { stdio: 'ignore', env: { PATH: process.env.PATH ?? '' } }).error === undefined;

describe.runIf(hasSshAgent)('the signing agent a task on the host gets', () => {
  const agentsOf = (bot: string): string =>
    spawnSync('pgrep', ['-f', `fleetadlc-agent-${bot}-`], { encoding: 'utf8' }).stdout.trim();
  let keyDir: string;
  let decoy: ReturnType<typeof spawn> | null = null;
  const savedPid = process.env.SSH_AGENT_PID;

  afterEach(() => {
    decoy?.kill();
    decoy = null;
    if (savedPid === undefined) delete process.env.SSH_AGENT_PID;
    else process.env.SSH_AGENT_PID = savedPid;
    if (keyDir) rmSync(keyDir, { recursive: true, force: true });
  });

  function privateKey(): string {
    keyDir = mkdtempSync(join(tmpdir(), 'fleetadlc-signing-key-'));
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'atlas', '-f', join(keyDir, 'key')]);
    return readFileSync(join(keyDir, 'key'), 'utf8');
  }

  it('stops its own agent when the task ends, and not the one hostd’s environment names', async () => {
    // The operator's own agent, as hostd inherits it from the shell that ran `fleetadlc up`.
    decoy = spawn('sleep', ['60'], { stdio: 'ignore' });
    process.env.SSH_AGENT_PID = String(decoy.pid);
    const bot = `keytest${process.pid}`;

    const agent = await hostSigningAgent(bot, privateKey());
    expect(agent?.publicKey).toMatch(/^ssh-ed25519 /);
    expect(agentsOf(bot)).not.toBe('');

    await agent!.stop();

    await vi.waitFor(() => expect(agentsOf(bot)).toBe(''), { timeout: 5_000 });
    expect(() => process.kill(decoy!.pid!, 0)).not.toThrow();
  });

  it('stops the agent it started when the key does not load', async () => {
    const bot = `badkey${process.pid}`;

    expect(await hostSigningAgent(bot, 'not a private key')).toBeNull();

    await vi.waitFor(() => expect(agentsOf(bot)).toBe(''), { timeout: 5_000 });
  });
});
