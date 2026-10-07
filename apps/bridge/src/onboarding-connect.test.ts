import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Connecting a bot from the console, end to end inside the bridge: the device
 * flow is started under the seat, GitHub approves as some account, the bot is
 * renamed to that account's handle part-way through — and the console, which
 * keeps asking under the seat, still gets the finished answer.
 */

const world = vi.hoisted(() => ({
  crew: [] as {
    id: string;
    name: string;
    slot: string;
    role: string;
    githubLogin: string | null;
    displayName: string;
  }[],
  credentials: new Map<string, { githubLogin: string; status: string }>(),
  audits: [] as { action: string; target: string; payload?: Record<string, unknown> }[],
  // The account GitHub says approved the code, or what GET /user failed with.
  approvedAs: 'noraexampleco' as string | Error,
  repos: [] as { name: string; fullName: string }[],
  /** Where an account's sign-in was moved to (`moveSecretNs`), by the account's identity id. */
  movedNs: new Map<string, string>(),
}));

vi.mock('@fleetadlc/db', () => ({
  spendingLimits: {
    SPENDING_PROVIDERS: ['anthropic', 'openai', 'xai'],
    GLOBAL_SCOPE: 'global',
    seedGlobal: vi.fn(async () => false),
    effectiveTaskCap: vi.fn(async (_repoId: string | null, fallback: number) => fallback),
    amountOf: vi.fn(async () => null),
    refusal: vi.fn(async () => null),
    listLimits: vi.fn(async () => []),
    setLimit: vi.fn(async () => undefined),
    dollars: (amount: number) => (Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`),
    botKind: (id: string) => `month_bot:${id}`,
    providerKind: (provider: string) => `month_provider:${provider}`,
    repoScope: (id: string) => `repo:${id}`,
    repoIdOf: (scope: string) => (scope.startsWith('repo:') ? scope.slice(5) : null),
  },
  audit: vi.fn(async (entry: { action: string; target: string }) => void world.audits.push(entry)),
  bots: {
    listBots: vi.fn(async () => world.crew.map((bot) => ({ ...bot }))),
    // Copies, as rows are: a bot read before its rename keeps the name it had.
    getBotById: vi.fn(async (id: string) => {
      const found = world.crew.find((bot) => bot.id === id);
      return found ? { ...found } : null;
    }),
    getBotByName: vi.fn(async (name: string) => {
      const found = world.crew.find((bot) => bot.name === name);
      return found ? { ...found } : null;
    }),
    releaseLogin: vi.fn(async (login: string, except: string) => {
      const released: string[] = [];
      for (const bot of world.crew) {
        if (bot.id !== except && bot.githubLogin?.toLowerCase() === login.toLowerCase()) {
          bot.githubLogin = null;
          released.push(bot.name);
        }
      }
      return released;
    }),
    setGithubLogin: vi.fn(async (id: string, login: string | null) => {
      const bot = world.crew.find((entry) => entry.id === id);
      if (bot) bot.githubLogin = login;
    }),
    shareIdentity: vi.fn(async (id: string, identityId: string) => {
      const bot = world.crew.find((entry) => entry.id === id);
      if (bot) bot.githubLogin = identityId.replace(/^id-/, '');
    }),
  },
  // An account is an identity filed under the name of the first seat that
  // connected as it, as migration 0014 files them.
  identities: {
    // No account is held with no seat on it here; `github-identities.test.ts` covers those.
    identityByLogin: vi.fn(async () => null),
    seatIdentities: vi.fn(async () => []),
    identityOfBot: vi.fn(async (id: string) => {
      const bot = world.crew.find((entry) => entry.id === id);
      if (!bot?.githubLogin) return null;
      // Filed under the seat that connected first, which took the account's handle as its name.
      const holders = world.crew.filter(
        (entry) => entry.githubLogin?.toLowerCase() === bot.githubLogin?.toLowerCase() && world.credentials.has(entry.id),
      );
      const holder = holders.find((entry) => entry.name === bot.githubLogin?.toLowerCase()) ?? holders[0];
      const identity = `id-${bot.githubLogin.toLowerCase()}`;
      return { id: identity, login: bot.githubLogin, githubUserId: 42, secretNs: world.movedNs.get(identity) ?? holder?.name ?? bot.name };
    }),
    moveSecretNs: vi.fn(async (id: string, to: string) => void world.movedNs.set(id, to)),
    botsOnSecretNs: vi.fn(async (ns: string) => {
      const holder = world.crew.find((entry) => entry.name === ns);
      return world.crew.filter((entry) => entry.githubLogin && entry.githubLogin === holder?.githubLogin).map((entry) => entry.name);
    }),
  },
  credentials: {
    getCredential: vi.fn(async (id: string) => world.credentials.get(id) ?? null),
    recordAuthorization: vi.fn(async (input: { botId: string; githubLogin: string }) => {
      world.credentials.set(input.botId, { githubLogin: input.githubLogin, status: 'active' });
      return input;
    }),
    setSigningKeyId: vi.fn(async () => undefined),
    forgetAuthorization: vi.fn(async (id: string) => void world.credentials.delete(id)),
  },
  repos: { listRepos: vi.fn(async () => world.repos) },
  settings: { allSettings: vi.fn(async () => ({ githubClientId: 'Iv1.test' })) },
}));

vi.mock('@fleetadlc/github', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fleetadlc/github')>();
  return {
    ...actual,
    requestDeviceCode: vi.fn(async () => ({
      deviceCode: 'device-1',
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      interval: 1,
      expiresIn: 900,
    })),
    pollForUserToken: vi.fn(async () => ({
      accessToken: 'ghu_new',
      refreshToken: 'ghr_new',
      expiresAt: null,
      refreshExpiresAt: null,
      scopes: [],
      tokenType: 'bearer',
    })),
    GitHubClient: class {
      async viewer() {
        if (world.approvedAs instanceof Error) throw world.approvedAs;
        return { login: world.approvedAs, id: 42 };
      }
      async listSshSigningKeys() {
        return [];
      }
      async uploadSshSigningKey() {
        return 7;
      }
    },
    generateSigningKey: vi.fn(() => ({ privateKey: 'PRIVATE', publicKey: 'ssh-ed25519 AAAA' })),
  };
});

vi.mock('./github-accounts.js', () => ({
  // Whether a login is free on GitHub: nothing here asks GitHub.
  loginAvailable: vi.fn(async () => true),
  lookUpAccount: vi.fn(async () => ({ exact: null })),
}));

import { accessTokenRef, GitHubApiError, pollForUserToken, refreshTokenRef, setSecretStore, signingKeyRef, type SecretStore, type UserToken } from '@fleetadlc/github';
import { otherGroupRefusal } from '@fleetadlc/shared';
import type { BotNames } from './bot-names.js';
import { inEvery, Onboarding } from './onboarding.js';
import { askAsTheApp, forgetRepoAccess } from './people.js';
import { loginAvailable } from './github-accounts.js';

let secrets: Map<string, string>;

function memoryStore(): SecretStore {
  return {
    get: async (ref) => secrets.get(ref) ?? null,
    set: async (ref, value) => void secrets.set(ref, value),
    delete: async (ref) => void secrets.delete(ref),
    list: async () => [...secrets.keys()],
  };
}

/** A rename that does what the real one does to the row and the secrets it can see. */
const names = {
  reconcile: vi.fn(async () => []),
  rename: vi.fn(async (input: { botId: string; to: string }) => {
    const bot = world.crew.find((entry) => entry.id === input.botId)!;
    const from = bot.name;
    const to = input.to.toLowerCase();
    for (const [ref, value] of [...secrets]) {
      if (ref.endsWith(`-${from}`)) {
        secrets.set(ref.slice(0, -from.length) + to, value);
        secrets.delete(ref);
      }
    }
    bot.name = to;
    return { botId: bot.id, from, to, state: 'renamed' as const };
  }),
};

/** The broker's lock, as the flow asks for it: which sign-ins, and what was written under it. */
const held: { names: string[]; wrote: string[] }[] = [];

function onboarding(humans: string[] = []): Onboarding {
  const flow = new Onboarding(
    { gitHubClientId: '', webhookSecret: '', humans, organization: '', publicUrl: '', automationBot: null } as never,
    {
      asBot: async () => null,
      exclusive: async (names: string[], fn: () => Promise<unknown>) => {
        const before = new Map(secrets);
        const result = await fn();
        held.push({ names, wrote: [...secrets.keys()].filter((ref) => secrets.get(ref) !== before.get(ref)) });
        return result;
      },
    } as never,
  );
  flow.useNames(names as unknown as BotNames);
  return flow;
}

async function finished(flow: Onboarding, asked: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await flow.authorizationState(asked);
    if (state.state !== 'waiting') return state;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the connect never finished');
}

beforeEach(() => {
  held.length = 0;
  secrets = new Map();
  setSecretStore(memoryStore());
  world.audits = [];
  world.credentials = new Map();
  world.approvedAs = 'noraexampleco';
  world.repos = [];
  world.movedNs = new Map();
  names.rename.mockClear();
  world.crew = [
    { id: 'b-se', name: 'system-engineer', slot: 'system-engineer', role: 'spec', githubLogin: null, displayName: 'System engineer' },
    // An earlier install's row: it names an account and holds nothing for it.
    { id: 'b-lead', name: 'lead-reviewer', slot: 'lead-reviewer', role: 'review_lead', githubLogin: 'noraexampleco', displayName: 'Lead reviewer' },
    { id: 'b-builder', name: 'fleetadlc-atlas-janedoe', slot: 'builder', role: 'implement', githubLogin: 'fleetadlc-atlas-janedoe', displayName: 'Builder' },
  ];
  world.credentials.set('b-builder', { githubLogin: 'fleetadlc-atlas-janedoe', status: 'active' });
});

describe('connecting a bot under its seat', () => {
  it('refuses a bot nobody has as not found, and the app not made yet as a step still to do, not as the bridge failing', async () => {
    await expect(onboarding().startAuthorization('nobody', 'ada')).rejects.toMatchObject({ status: 404, message: 'unknown bot nobody' });
    const { settings } = await import('@fleetadlc/db');
    vi.mocked(settings.allSettings).mockResolvedValueOnce({});
    await expect(onboarding().startAuthorization('system-engineer', 'ada')).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('finish the “Create the app” step first'),
    });
  });

  it('answers the console under the seat it started with, naming the handle the bot now has', async () => {
    const flow = onboarding();

    await flow.startAuthorization('system-engineer', 'ada');
    const state = await finished(flow, 'system-engineer');

    expect(state).toEqual({ state: 'connected', bot: 'noraexampleco', login: 'noraexampleco' });
    expect(names.rename).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'b-se', to: 'noraexampleco', actor: 'ada' }),
    );
    expect(world.crew.find((bot) => bot.id === 'b-se')?.name).toBe('noraexampleco');
  });

  it('connects an account another row only names, and takes it off that row', async () => {
    // The owner's refusal: "GitHub approved this as noraexampleco, the account
    // set aside for sydney, who is not connected yet". Nobody held it.
    const flow = onboarding();

    await flow.startAuthorization('system-engineer', 'ada');
    await finished(flow, 'system-engineer');

    expect(world.crew.find((bot) => bot.id === 'b-lead')?.githubLogin).toBeNull();
    expect(world.crew.find((bot) => bot.id === 'b-se')?.githubLogin).toBe('noraexampleco');
    expect(world.audits).toContainEqual(
      expect.objectContaining({ action: 'bot.login_released', target: 'lead-reviewer' }),
    );
  });

  it('keeps the credential and the key under the name the bot ends up with', async () => {
    const flow = onboarding();

    await flow.startAuthorization('system-engineer', 'ada');
    await finished(flow, 'system-engineer');

    expect(secrets.get(refreshTokenRef('noraexampleco'))).toBe('ghr_new');
    expect(secrets.get(signingKeyRef('noraexampleco'))).toBe('PRIVATE');
    expect([...secrets.keys()].filter((ref) => ref.endsWith('-system-engineer'))).toEqual([]);
    expect(world.audits).toContainEqual(
      expect.objectContaining({
        action: 'onboarding.connected',
        target: 'noraexampleco',
        payload: expect.objectContaining({ renamedFrom: 'system-engineer', slot: 'system-engineer' }),
      }),
    );
  });

  it('joins a seat to an account another seat is connected as, rather than refusing it', async () => {
    // One GitHub account for several seats is a crew on a shared account.
    world.approvedAs = 'FleetADLC-Atlas-Janedoe';
    const flow = onboarding();

    await flow.startAuthorization('system-engineer', 'ada');
    const state = await finished(flow, 'system-engineer');

    expect(state).toMatchObject({ state: 'connected', login: 'FleetADLC-Atlas-Janedoe' });
    // The newer sign-in is the account's, filed once, under the account's name.
    expect(secrets.get(refreshTokenRef('fleetadlc-atlas-janedoe'))).toBe('ghr_new');
    expect(secrets.has(refreshTokenRef('system-engineer'))).toBe(false);
    // The seat is on the account, recorded as connected, and not renamed after it.
    expect(world.crew.find((bot) => bot.id === 'b-se')?.githubLogin?.toLowerCase()).toBe('fleetadlc-atlas-janedoe');
    expect(world.credentials.get('b-se')?.status).toBe('active');
    expect(names.rename).not.toHaveBeenCalled();
    expect(world.audits).toContainEqual(expect.objectContaining({ action: 'bot.account_shared', target: 'system-engineer' }));
  });

  it('writes the shared account’s new sign-in under the broker’s lock, and records the seats already on it', async () => {
    // Written straight to the store, the broker went on serving the dead
    // sign-in's cached token to every seat on the account.
    world.approvedAs = 'FleetADLC-Atlas-Janedoe';
    const { credentials } = await import('@fleetadlc/db');
    vi.mocked(credentials.recordAuthorization).mockClear();
    const flow = onboarding();

    await flow.startAuthorization('system-engineer', 'ada');
    await finished(flow, 'system-engineer');

    expect(held).toContainEqual({ names: ['fleetadlc-atlas-janedoe'], wrote: [refreshTokenRef('fleetadlc-atlas-janedoe')] });
    expect(vi.mocked(credentials.recordAuthorization)).toHaveBeenCalledWith(expect.objectContaining({ botId: 'b-builder', githubLogin: 'FleetADLC-Atlas-Janedoe' }));
  });

  it('drops a stale refresh token when the new sign-in is a token that does not expire', async () => {
    // The broker prefers a refresh token, so the account stayed broken however often it was reconnected.
    world.approvedAs = 'FleetADLC-Atlas-Janedoe';
    secrets.set(refreshTokenRef('fleetadlc-atlas-janedoe'), 'ghr_revoked');
    vi.mocked(pollForUserToken).mockResolvedValueOnce({ accessToken: 'ghu_static', refreshToken: null, expiresAt: null, refreshExpiresAt: null, scopes: [], tokenType: 'bearer' } as never);
    const flow = onboarding();

    await flow.startAuthorization('system-engineer', 'ada');
    await finished(flow, 'system-engineer');

    expect(secrets.has(refreshTokenRef('fleetadlc-atlas-janedoe'))).toBe(false);
    expect(secrets.get(accessTokenRef('fleetadlc-atlas-janedoe'))).toBe('ghu_static');
  });

  it('puts the other seats of its group on one seat’s account when asked to, and never a reviewer on the crew’s', async () => {
    secrets.set(refreshTokenRef('fleetadlc-atlas-janedoe'), 'ghr_builder');
    const flow = onboarding();
    const result = await flow.shareAccount({ from: 'builder', actor: 'ada' });

    expect(result.login).toBe('fleetadlc-atlas-janedoe');
    expect(result.shared).toEqual(['system-engineer']);
    expect(world.crew.find((bot) => bot.id === 'b-se')?.githubLogin).toBe('fleetadlc-atlas-janedoe');
    expect(world.credentials.get('b-se')?.status).toBe('active');
    // GitHub won't let the account that opened a pull request approve it.
    expect(world.crew.find((bot) => bot.id === 'b-lead')?.githubLogin).toBe('noraexampleco');
    // Seats sharing an account go back to their seats' names.
    expect(names.reconcile).toHaveBeenCalled();
  });

  it('refuses when asked to put a reviewer on the crew’s account', async () => {
    secrets.set(refreshTokenRef('fleetadlc-atlas-janedoe'), 'ghr_builder');
    await expect(onboarding().shareAccount({ from: 'builder', to: ['lead-reviewer'], actor: 'ada' })).rejects.toThrow(
      /reviewers need an account of their own/,
    );
  });

  it('refuses to share an account nobody is signed in as', async () => {
    await expect(onboarding().shareAccount({ from: 'system-engineer', actor: 'ada' })).rejects.toThrow(
      /not connected to a GitHub account/,
    );
  });

  it('can be cancelled under the seat, and keeps nothing of a sign-in approved meanwhile', async () => {
    const approval: { approve: (() => void) | null } = { approve: null };
    vi.mocked(pollForUserToken).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          approval.approve = () =>
            resolve({ accessToken: 'ghu_new', refreshToken: 'ghr_new', expiresAt: null, refreshExpiresAt: null, scopes: [], tokenType: 'bearer' });
        }),
    );
    const flow = onboarding();
    await flow.startAuthorization('system-engineer', 'ada');

    await vi.waitFor(() => expect(approval.approve).not.toBeNull());

    await flow.cancel('system-engineer');
    // The person had already approved the code on GitHub.
    approval.approve?.();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await flow.authorizationState('system-engineer')).toEqual({ state: 'none' });
    expect(secrets.size).toBe(0);
    expect(names.rename).not.toHaveBeenCalled();
    expect(world.audits).not.toContainEqual(expect.objectContaining({ action: 'onboarding.connected' }));
  });
});

describe('a connect GitHub does not say the account of', () => {
  it('stores nothing, records nothing, invites nobody, and says to connect again', async () => {
    // Filed under the guessed `fleetadlc-<slot>`, which anyone can register,
    // the token skipped the reviewer check and that account was invited in.
    world.approvedAs = new Error('GitHub answered 502');
    world.repos = [{ name: 'api', fullName: 'janedoe/api' }];
    const ensure = vi.fn();
    const { bots, credentials } = await import('@fleetadlc/db');
    vi.mocked(bots.setGithubLogin).mockClear();
    vi.mocked(credentials.recordAuthorization).mockClear();
    const flow = onboarding();
    flow.useCrewAccess({ ensure } as never);

    await flow.startAuthorization('lead-reviewer', 'ada');
    const state = await finished(flow, 'lead-reviewer');

    expect(state).toMatchObject({ state: 'failed', error: expect.stringMatching(/nothing was stored\. Connect again\./) });
    expect(secrets.size).toBe(0);
    expect(bots.setGithubLogin).not.toHaveBeenCalled();
    expect(credentials.recordAuthorization).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
    expect(names.rename).not.toHaveBeenCalled();
  });

  it('still refuses a reviewer seat GitHub says approved as the crew’s account', async () => {
    world.approvedAs = 'fleetadlc-atlas-janedoe';
    const flow = onboarding();

    await flow.startAuthorization('lead-reviewer', 'ada');
    const state = await finished(flow, 'lead-reviewer');

    expect(state).toMatchObject({ state: 'failed', error: expect.stringMatching(/reviewers need an account of their own/) });
    expect(secrets.size).toBe(0);
  });
});

describe('connecting a seat as a person, or as an account that administers a repository', () => {
  afterEach(() => {
    forgetRepoAccess();
  });

  /** The app, answering for exampleco/app: its AGENTS.md, and what each login may do there. */
  function theAppAnswers(agents: string, roles: Record<string, string> = {}) {
    world.repos = [{ name: 'app', fullName: 'exampleco/app' }];
    askAsTheApp(async () => ({
      request: async <T,>(_method: string, path: string): Promise<T> => {
        if (path.includes('/contents/AGENTS.md')) return { content: Buffer.from(agents).toString('base64'), encoding: 'base64' } as T;
        const login = /collaborators\/([^/]+)\/permission/.exec(path)?.[1] ?? '';
        const role = roles[login.toLowerCase()];
        if (!role) throw new Error('404');
        return { role_name: role, permission: role === 'maintain' ? 'write' : role } as T;
      },
    }));
  }

  async function refused(flow: Onboarding) {
    const { bots, credentials } = await import('@fleetadlc/db');
    vi.mocked(bots.setGithubLogin).mockClear();
    vi.mocked(credentials.recordAuthorization).mockClear();
    await flow.startAuthorization('system-engineer', 'ada');
    const state = await finished(flow, 'system-engineer');
    // Nothing stored, and the seat keeps whatever it had.
    expect(secrets.size).toBe(0);
    expect(bots.setGithubLogin).not.toHaveBeenCalled();
    expect(credentials.recordAuthorization).not.toHaveBeenCalled();
    expect(names.rename).not.toHaveBeenCalled();
    return state;
  }

  beforeEach(() => {
    names.rename.mockClear();
  });

  it('refuses one of the install’s people, whatever the case, and says to sign in as the bot', async () => {
    world.approvedAs = 'JaneDoe';

    expect(await refused(onboarding(['janedoe']))).toMatchObject({
      state: 'failed',
      error:
        'JaneDoe is one of this install’s people (FLEETADLC_HUMANS), so no bot can sign in as it. ' +
        'Sign in to GitHub as the bot’s own account (a private window helps) and enter a new code.',
    });
  });

  it('refuses a login AGENTS.md names under Human review, but never the template’s @owner', async () => {
    theAppAnswers('# Agent notes\n\n## Human review\n\n- `config/` @noraexampleco\n');
    expect(await refused(onboarding())).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('noraexampleco is named in exampleco/app’s AGENTS.md Human review'),
    });

    world.approvedAs = 'owner';
    theAppAnswers('# Agent notes\n\n## Human review\n\n- `config/` @owner\n');
    const flow = onboarding();
    await flow.startAuthorization('system-engineer', 'ada');
    expect(await finished(flow, 'system-engineer')).toMatchObject({ state: 'connected' });
  });

  it.each(['admin', 'maintain'])('refuses an account with %s on a managed repository, naming it and what to lower', async (role) => {
    theAppAnswers('# Agent notes\n', { noraexampleco: role });

    expect(await refused(onboarding())).toMatchObject({
      state: 'failed',
      error: expect.stringMatching(new RegExp(`noraexampleco has ${role} on exampleco/app.*Lower it to the role its seat needs`)),
    });
  });
});

describe('the crew as the walkthrough lists it', () => {
  it('gives each bot its seat beside the name it goes by, and suggests accounts from the seat', async () => {
    const view = await onboarding().view('owner@example.test');

    expect(view.bots.map(({ bot, slot, roleLabel, connected }) => ({ bot, slot, roleLabel, connected }))).toEqual([
      { bot: 'system-engineer', slot: 'system-engineer', roleLabel: 'system engineer', connected: false },
      { bot: 'lead-reviewer', slot: 'lead-reviewer', roleLabel: 'lead reviewer', connected: false },
      { bot: 'fleetadlc-atlas-janedoe', slot: 'builder', roleLabel: 'builder', connected: true },
    ]);
    // Built from the bot's current login instead of its seat, it would be `fleetadlc-fleetadlc-atlas-janedoe`.
    const builder = view.bots.find((entry) => entry.slot === 'builder');
    expect(builder?.suggestedLogin).toBe('fleetadlc-builder');
    expect(builder?.suggestedEmail).toBe('owner+fleetadlc-builder@example.test');
    expect(builder?.login).toBe('fleetadlc-atlas-janedoe');
  });
});

describe('a bot that connects', () => {
  it('is let into every repository OpenADLC works in, not only the first, under the name it now has', async () => {
    world.repos = [
      { name: 'fleetadlc-testbed', fullName: 'janedoe/fleetadlc-testbed' },
      { name: 'api', fullName: 'janedoe/api' },
    ];
    const ensure = vi.fn(async (repository: string, _trigger: string, options: { onlyBot?: string }) => ({
      repository,
      running: false,
      trigger: 'connected',
      checkedAt: null,
      error: null,
      bots: [{ bot: options.onlyBot!, login: options.onlyBot!, state: 'in', changed: true, detail: 'invited and accepted just now' }],
    }));
    const flow = onboarding();
    flow.useCrewAccess({ ensure } as never);

    await flow.startAuthorization('system-engineer', 'ada');
    await finished(flow, 'system-engineer');
    await vi.waitFor(() => expect(ensure).toHaveBeenCalledTimes(2));

    expect(ensure.mock.calls.map(([repository, trigger, options]) => `${repository} ${trigger} ${options.onlyBot}`)).toEqual([
      'janedoe/fleetadlc-testbed connected noraexampleco',
      'janedoe/api connected noraexampleco',
    ]);
    await vi.waitFor(() =>
      expect(world.audits.filter((entry) => entry.action === 'onboarding.access_in').map((entry) => entry.payload?.repository)).toEqual([
        'janedoe/fleetadlc-testbed',
        'janedoe/api',
      ]),
    );
  });
});

describe('whether a bot is in the repositories', () => {
  it('is said for each one, and is yes only when it is in all of them', async () => {
    world.repos = [
      { name: 'fleetadlc-testbed', fullName: 'janedoe/fleetadlc-testbed' },
      { name: 'api', fullName: 'janedoe/api' },
    ];
    const view = await onboarding().view('owner@example.test');
    expect(view.bots[0]?.access.map((one) => one.repository)).toEqual(['janedoe/fleetadlc-testbed', 'janedoe/api']);

    expect(inEvery([{ inRepository: true }, { inRepository: true }])).toBe(true);
    expect(inEvery([{ inRepository: true }, { inRepository: false }])).toBe(false);
    expect(inEvery([{ inRepository: true }, { inRepository: null }])).toBeNull();
    expect(inEvery([])).toBeNull();
  });
});

describe('a working install while GitHub refuses anonymous lookups', () => {
  /**
   * Every seat connected, signed in and in the repository, and GitHub answering
   * 403 to every lookup, as it does once the sixty anonymous requests an hour
   * are spent. The board re-asks every 15 seconds, and each ask looked every
   * seat up anonymously, so the board soon sent its admin back to the walkthrough.
   */
  const tokenFor = vi.fn(async (name: string) => ({ token: `ghu_${name}`, expiresAt: null, login: name }));
  const asked: string[] = [];

  function working(signedOut: string[] = []): Onboarding {
    const flow = new Onboarding(
      { gitHubClientId: '', webhookSecret: '', humans: [], organization: 'exampleco', publicUrl: '', automationBot: null } as never,
      {
        asBot: async (name: string) =>
          signedOut.includes(name)
            ? null
            : {
                request: async (method: string, path: string) => {
                  asked.push(`${method} ${path} as ${name}`);
                  if (path === '/user') return { login: name };
                  if (path.startsWith('/repos/')) return { permissions: { push: true, triage: true } };
                  throw new GitHubApiError(403, path, 'API rate limit exceeded');
                },
              },
        tokenFor,
      } as never,
    );
    flow.useWebhookSetup({ localReadiness: async () => ({ ready: true, stale: false }) } as never);
    return flow;
  }

  beforeEach(() => {
    asked.length = 0;
    tokenFor.mockClear();
    vi.mocked(loginAvailable).mockReset().mockResolvedValue(null);
    world.repos = [{ name: 'api', fullName: 'janedoe/api' }];
    world.crew = [
      { id: 'b-auto', name: 'automation', slot: 'automation', role: 'automation', githubLogin: 'automationexampleco', displayName: 'Automation' },
      { id: 'b-lead', name: 'lead-reviewer', slot: 'lead-reviewer', role: 'review_lead', githubLogin: 'noraexampleco', displayName: 'Lead reviewer' },
      { id: 'b-builder', name: 'fleetadlc-atlas-janedoe', slot: 'builder', role: 'implement', githubLogin: 'fleetadlc-atlas-janedoe', displayName: 'Builder' },
    ];
    for (const bot of world.crew) world.credentials.set(bot.id, { githubLogin: bot.githubLogin!, status: 'active' });
  });

  afterEach(() => {
    vi.mocked(loginAvailable).mockReset().mockResolvedValue(true);
  });

  it('stays complete, and asks nothing about an account whose sign-in works', async () => {
    const view = await working().view('owner@example.test');

    expect(loginAvailable).not.toHaveBeenCalled();
    expect(view.bots.map((bot) => bot.accountExists)).toEqual([true, true, true]);
    // The organization lookup was refused, which is no answer, not "a person owns it".
    expect(view.organizationIsOrg).toBeNull();
    expect(view.complete).toBe(true);
  });

  it('asks about a seat that is signed out as the automation bot, and says unknown when GitHub will not answer', async () => {
    const view = await working(['lead-reviewer']).view('owner@example.test');

    expect(vi.mocked(loginAvailable).mock.calls).toEqual([['noraexampleco', { token: 'ghu_automation' }]]);
    expect(view.bots.find((bot) => bot.bot === 'lead-reviewer')?.accountExists).toBeNull();
  });

  it('asks publicly when the automation bot is not signed in either', async () => {
    await working(['automation', 'lead-reviewer']).view('owner@example.test');
    expect(vi.mocked(loginAvailable).mock.calls.map(([login, options]) => `${login} ${options?.token ?? 'anonymous'}`)).toEqual([
      'automationexampleco anonymous',
      'noraexampleco anonymous',
    ]);
    expect(tokenFor).not.toHaveBeenCalled();
  });

  it('reads a refused repository lookup as unknown, and a 404 as not in', async () => {
    const flow = new Onboarding(
      { gitHubClientId: '', webhookSecret: '', humans: [], organization: '', publicUrl: '', automationBot: null } as never,
      {
        asBot: async (name: string) => ({
          request: async (_method: string, path: string) => {
            if (path === '/user') return { login: name };
            throw new GitHubApiError(name === 'automation' ? 404 : 403, path, 'refused');
          },
        }),
        tokenFor,
      } as never,
    );
    const view = await flow.view('owner@example.test');
    expect(view.bots.map((bot) => `${bot.bot} ${bot.inRepository}`)).toEqual([
      'automation false',
      'lead-reviewer null',
      'fleetadlc-atlas-janedoe null',
    ]);
  });
});

describe('the walkthrough’s steps, from the health checks', () => {
  const failingPermission = {
    id: 'app-permissions:git_signing_ssh_public_keys',
    checkId: 'app-permissions',
    subject: 'git_signing_ssh_public_keys',
    state: 'failing',
    severity: 'blocking',
    title: 'The OpenADLC app does not have “SSH signing keys”',
    detail: 'Add it on the app’s permissions page.',
    action: { label: 'Open the app’s permissions', url: 'https://github.com/settings/apps/fleetadlc-janedoe/permissions' },
    facts: {},
    waitingFor: [],
    failingSince: '2026-09-25T11:00:00.000Z',
    checkedAt: '2026-09-25T11:55:00.000Z',
    notifiedAt: null,
    fixedAt: null,
    fixedTitle: null,
    fixedDismissedAt: null,
  };
  const deliveringWebhook = { ...failingPermission, id: 'webhook', checkId: 'webhook', subject: null, state: 'ok', severity: null, title: null };

  function withHealth(rows: unknown[], runSoon = vi.fn()) {
    const flow = onboarding();
    flow.useHealth({
      rows: async () => rows,
      runSoon,
      checks: [
        { id: 'app-permissions', steps: ['app'] },
        { id: 'webhook', steps: ['webhook'] },
      ],
    } as never);
    return flow;
  }

  it('marks a step done when a check proves it, not done when one fails, and says what fails', async () => {
    const without = await onboarding().view('owner@example.test');
    const view = await withHealth([failingPermission, deliveringWebhook]).view('owner@example.test');

    expect(view.checks.app).toEqual({
      done: false,
      failing: [
        {
          id: 'app-permissions:git_signing_ssh_public_keys',
          title: 'The OpenADLC app does not have “SSH signing keys”',
          detail: 'Add it on the app’s permissions page.',
          severity: 'blocking',
          action: { label: 'Open the app’s permissions', url: 'https://github.com/settings/apps/fleetadlc-janedoe/permissions' },
          waiting: false,
        },
      ],
    });
    expect(view.checks.webhook).toEqual({ done: true, failing: [] });
    expect(view.checks['github-accounts']).toEqual({ done: null, failing: [] });

    // Without the check the app step was done: a client id is configured.
    expect(without.steps.find((step) => step.step === 'app')?.done).toBe(true);
    expect(view.steps.find((step) => step.step === 'app')?.done).toBe(false);
    expect(view.steps.find((step) => step.step === 'webhook')?.done).toBe(true);
    // Setting up is what `complete` is about: a check failing on a running
    // install does not send the board back to the walkthrough.
    expect(view.complete).toBe(without.complete);
  });

  it('asks a bot’s checks again as soon as it connects', async () => {
    const runSoon = vi.fn();
    const flow = withHealth([], runSoon);

    await flow.startAuthorization('system-engineer', 'ada');
    await finished(flow, 'system-engineer');

    expect(runSoon).toHaveBeenCalledWith(['bot-sign-in', 'signing-key', 'bot-access', 'token-expiry']);
  });
});

describe('connecting a seat with a sign-in the CLI got', () => {
  // `fleetadlc auth login` did this itself and refused any account another
  // seat held, so the two-account crew the docs recommend could not connect
  // from it; it hands the token to `connect` now, which the console uses too.
  const token = (refresh: string): UserToken => ({
    accessToken: `ghu_${refresh}`,
    refreshToken: refresh,
    expiresAt: null,
    refreshExpiresAt: null,
    scopes: [],
    tokenType: 'bearer',
  });

  it('puts a second crew seat on the account the first holds, and files the sign-in once under that account', async () => {
    world.approvedAs = 'fleetadlc-atlas-janedoe';
    const outcome = await onboarding().connect({ botId: 'b-se', token: token('ghr_cli'), actor: 'fleetadlc auth login' });

    expect(outcome).toMatchObject({ login: 'fleetadlc-atlas-janedoe', bot: 'system-engineer', joined: 'fleetadlc-atlas-janedoe' });
    const { identities } = await import('@fleetadlc/db');
    const builder = await identities.identityOfBot('b-builder');
    const engineer = await identities.identityOfBot('b-se');
    expect(engineer?.id).toBe(builder?.id);
    expect(engineer?.secretNs).toBe('fleetadlc-atlas-janedoe');
    expect([...secrets].filter(([, value]) => value === 'ghr_cli').map(([ref]) => ref)).toEqual([refreshTokenRef('fleetadlc-atlas-janedoe')]);
  });

  it('refuses a reviewer seat on the crew’s account with the console’s words, and stores nothing', async () => {
    world.approvedAs = 'fleetadlc-atlas-janedoe';
    const lead = world.crew.find((bot) => bot.id === 'b-lead')!;
    const builder = world.crew.find((bot) => bot.id === 'b-builder')!;

    await expect(onboarding().connect({ botId: 'b-lead', token: token('ghr_cli'), actor: 'fleetadlc auth login' })).rejects.toMatchObject({
      status: 409,
      message: otherGroupRefusal('fleetadlc-atlas-janedoe', lead as never, builder as never),
    });
    expect(secrets.size).toBe(0);
  });

  it('moves a shared account’s sign-in out from under a seat that leaves it, so the seats still on it keep it', async () => {
    // The builder connected first, so the account's sign-in is filed under its
    // name. Reconnected as another account, it used to write over that.
    secrets.set(refreshTokenRef('fleetadlc-atlas-janedoe'), 'ghr_shared');
    world.crew.find((bot) => bot.id === 'b-se')!.githubLogin = 'fleetadlc-atlas-janedoe';
    world.credentials.set('b-se', { githubLogin: 'fleetadlc-atlas-janedoe', status: 'active' });
    world.approvedAs = 'janedoe-builds';

    const outcome = await onboarding().connect({ botId: 'b-builder', token: token('ghr_new_account'), actor: 'fleetadlc auth login' });

    expect(outcome).toMatchObject({ login: 'janedoe-builds', bot: 'janedoe-builds' });
    expect(secrets.get(refreshTokenRef('account_fleetadlc-atlas-janedoe'))).toBe('ghr_shared');
    const { identities } = await import('@fleetadlc/db');
    const engineer = await identities.identityOfBot('b-se');
    expect(engineer?.secretNs).toBe('account_fleetadlc-atlas-janedoe');
    expect(secrets.get(refreshTokenRef(engineer!.secretNs))).toBe('ghr_shared');
    expect(secrets.get(refreshTokenRef('janedoe-builds'))).toBe('ghr_new_account');
  });
});
