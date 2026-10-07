import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Putting seats on the GitHub accounts OpenADLC holds, as settings' GitHub
 * accounts card does: the bridge refuses what GitHub would make wrong — a
 * reviewer on the account the crew opens pull requests as — and what cannot
 * work — an account it cannot sign in as — whatever the page offered, and
 * moves a seat without taking the shared sign-in from the seats that stay.
 */

interface Row {
  id: string;
  name: string;
  slot: string;
  role: string;
  githubLogin: string | null;
  identityId: string | null;
  displayName: string;
}

const world = vi.hoisted(() => ({
  crew: [] as Row[],
  identities: [] as { id: string; login: string; githubUserId: number | null; secretNs: string }[],
  credentials: new Map<string, { githubLogin: string; status: string; secretRef: string; scopes: string[] }>(),
  audits: [] as { action: string; target: string; payload?: Record<string, unknown> }[],
}));

vi.mock('@fleetadlc/db', () => {
  const identityOf = (id: string) => {
    const bot = world.crew.find((entry) => entry.id === id);
    return world.identities.find((identity) => identity.id === bot?.identityId) ?? null;
  };
  return {
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
      getBotById: vi.fn(async (id: string) => {
        const found = world.crew.find((bot) => bot.id === id);
        return found ? { ...found } : null;
      }),
      getBotByName: vi.fn(async (name: string) => {
        const found = world.crew.find((bot) => bot.name === name);
        return found ? { ...found } : null;
      }),
      setGithubLogin: vi.fn(async (id: string, login: string | null) => {
        const bot = world.crew.find((entry) => entry.id === id)!;
        bot.githubLogin = login;
        if (!login) {
          bot.identityId = null;
          return;
        }
        // Connected on its own: an identity filed under the seat's name, as migration 0014 files them.
        let identity = world.identities.find((one) => one.login.toLowerCase() === login.toLowerCase());
        if (!identity) {
          identity = { id: `i-${login}`, login, githubUserId: null, secretNs: bot.name };
          world.identities.push(identity);
        }
        bot.identityId = identity.id;
      }),
      releaseLogin: vi.fn(async () => []),
      seatWorkRefusal: vi.fn(async () => null),
      shareIdentity: vi.fn(async (id: string, identityId: string) => {
        const bot = world.crew.find((entry) => entry.id === id)!;
        bot.identityId = identityId;
        bot.githubLogin = world.identities.find((identity) => identity.id === identityId)!.login;
      }),
    },
    identities: {
      listIdentities: vi.fn(async () => world.identities.map((identity) => ({ ...identity }))),
      seatIdentities: vi.fn(async () =>
        world.crew.filter((bot) => bot.identityId).map((bot) => ({ botId: bot.id, identityId: bot.identityId! })),
      ),
      identityOfBot: vi.fn(async (id: string) => identityOf(id)),
      identityByLogin: vi.fn(
        async (login: string) => world.identities.find((one) => one.login.toLowerCase() === login.toLowerCase()) ?? null,
      ),
      recordIdentity: vi.fn(async (input: { login: string; githubUserId: number | null; secretNs: string }) => {
        const existing = world.identities.find((one) => one.login.toLowerCase() === input.login.toLowerCase());
        if (existing) return existing;
        const made = { id: `i-${input.login}`, ...input };
        world.identities.push(made);
        return made;
      }),
      botsOnSecretNs: vi.fn(async (ns: string) => {
        const identity = world.identities.find((one) => one.secretNs === ns);
        return world.crew.filter((bot) => identity && bot.identityId === identity.id).map((bot) => bot.name);
      }),
      moveSecretNs: vi.fn(async (identityId: string, to: string, refs: { from: string; to: string }[]) => {
        world.identities.find((identity) => identity.id === identityId)!.secretNs = to;
        for (const bot of world.crew.filter((entry) => entry.identityId === identityId)) {
          const credential = world.credentials.get(bot.id);
          const ref = refs.find((one) => one.from === credential?.secretRef);
          if (credential && ref) credential.secretRef = ref.to;
        }
      }),
      deleteUnusedIdentity: vi.fn(async (id: string) => {
        if (world.crew.some((bot) => bot.identityId === id)) return false;
        world.identities = world.identities.filter((identity) => identity.id !== id);
        return true;
      }),
    },
    credentials: {
      getCredential: vi.fn(async (id: string) => world.credentials.get(id) ?? null),
      recordAuthorization: vi.fn(async (input: { botId: string; githubLogin: string; secretRef: string; scopes: string[] }) => {
        world.credentials.set(input.botId, { ...input, status: 'active' });
        return input;
      }),
      forgetAuthorization: vi.fn(async (id: string) => void world.credentials.delete(id)),
      setSigningKeyId: vi.fn(async () => undefined),
    },
    repos: { listRepos: vi.fn(async () => []) },
    settings: { allSettings: vi.fn(async () => ({ githubClientId: 'Iv1.test' })) },
  };
});

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
        return { login: 'exampleco-new', id: 9 };
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
  loginAvailable: vi.fn(async () => true),
  lookUpAccount: vi.fn(async () => ({ exact: null })),
}));

import { bots, identities, repos } from '@fleetadlc/db';
import { refreshTokenRef, setSecretStore, type SecretStore } from '@fleetadlc/github';
import type { BotNames } from './bot-names.js';
import { assignmentRefusal, groupOfAccount, signInStateOf } from './github-identities.js';
import { Onboarding } from './onboarding.js';
import { askAsTheApp, forgetRepoAccess } from './people.js';

let secrets: Map<string, string>;
const reconcile = vi.fn(async () => []);

function onboarding(config: Record<string, unknown> = {}): Onboarding {
  const flow = new Onboarding(
    { gitHubClientId: '', webhookSecret: '', humans: [], organization: '', publicUrl: '', automationBot: null, ...config } as never,
    { asBot: async () => null, exclusive: async (_names: string[], fn: () => Promise<unknown>) => fn() } as never,
  );
  flow.useNames({ reconcile, rename: async () => ({ state: 'unchanged' }) } as unknown as BotNames);
  return flow;
}

const seat = (id: string, name: string, role: string, identityId: string | null, login: string | null): Row => ({
  id,
  name,
  slot: id.replace(/^b-/, ''),
  role,
  githubLogin: login,
  identityId,
  displayName: name,
});

beforeEach(() => {
  secrets = new Map([
    [refreshTokenRef('builder'), 'ghr_crew'],
    [refreshTokenRef('exampleco-review'), 'ghr_review'],
  ]);
  setSecretStore({
    get: async (ref) => secrets.get(ref) ?? null,
    set: async (ref, value) => void secrets.set(ref, value),
    delete: async (ref) => void secrets.delete(ref),
    list: async () => [...secrets.keys()],
  } satisfies SecretStore);
  world.audits = [];
  reconcile.mockClear();
  vi.mocked(bots.seatWorkRefusal).mockReset().mockResolvedValue(null);
  // The crew on one account, filed under the builder that connected it first;
  // the lead reviewer alone on the reviewers' account; the second reviewer on
  // none; automation on an account whose sign-in is gone.
  world.identities = [
    { id: 'i-crew', login: 'exampleco-crew', githubUserId: 1, secretNs: 'builder' },
    { id: 'i-review', login: 'exampleco-review', githubUserId: 2, secretNs: 'exampleco-review' },
    { id: 'i-old', login: 'exampleco-old', githubUserId: 3, secretNs: 'automation' },
  ];
  world.crew = [
    seat('b-builder', 'builder', 'implement', 'i-crew', 'exampleco-crew'),
    seat('b-qa', 'qa', 'qa', 'i-crew', 'exampleco-crew'),
    seat('b-lead-reviewer', 'exampleco-review', 'review_lead', 'i-review', 'exampleco-review'),
    seat('b-second-reviewer', 'second-reviewer', 'review_second', null, null),
    seat('b-automation', 'automation', 'automation', 'i-old', 'exampleco-old'),
  ];
  const active = (login: string, ns: string) => ({ githubLogin: login, status: 'active', secretRef: refreshTokenRef(ns), scopes: [] });
  world.credentials = new Map([
    ['b-builder', active('exampleco-crew', 'builder')],
    ['b-qa', active('exampleco-crew', 'builder')],
    ['b-lead-reviewer', active('exampleco-review', 'exampleco-review')],
  ]);
});

describe('the rules for which account a seat may use', () => {
  const crew = [
    { id: 'b', name: 'builder', slot: 'builder', role: 'implement' as const, githubLogin: 'exampleco-crew', connected: true, identityId: 'i-crew' },
    { id: 'l', name: 'lead', slot: 'lead', role: 'review_lead' as const, githubLogin: 'exampleco-review', connected: true, identityId: 'i-review' },
  ];
  const crewAccount = { login: 'exampleco-crew', signIn: 'signed-in' as const, seats: [crew[0]!] };
  const reviewAccount = { login: 'exampleco-review', signIn: 'signed-in' as const, seats: [crew[1]!] };

  it('keeps a reviewer off the crew’s account, and a crew seat off the reviewers’', () => {
    expect(assignmentRefusal({ id: 'x', role: 'review_second' }, crewAccount, crew)).toBe(
      'used by the builder — reviewers need their own account',
    );
    expect(assignmentRefusal({ id: 'x', role: 'qa' }, reviewAccount, crew)).toBe(
      'the reviewers’ account (the lead reviewer uses it) — the crew needs a different one',
    );
    expect(assignmentRefusal({ id: 'x', role: 'qa' }, crewAccount, crew)).toBeNull();
    expect(assignmentRefusal({ id: 'x', role: 'review_security' }, reviewAccount, crew)).toBeNull();
  });

  it('keeps every seat off a person’s account, with a reason short enough to show beside the choice', () => {
    const people = [
      { login: 'Exampleco-Crew', why: 'one of this install’s people (FLEETADLC_HUMANS)', short: 'one of this install’s people' },
    ];
    expect(assignmentRefusal({ id: 'x', role: 'qa' }, crewAccount, crew, people)).toBe('one of this install’s people — bots need their own account');
    expect(assignmentRefusal({ id: 'x', role: 'review_security' }, reviewAccount, crew, people)).toBeNull();
  });

  it('refuses an account OpenADLC cannot sign in as', () => {
    expect(assignmentRefusal({ id: 'x', role: 'qa' }, { ...crewAccount, signIn: 'not-signed-in' }, crew)).toBe(
      'not signed in — reconnect it first',
    );
    expect(assignmentRefusal({ id: 'x', role: 'qa' }, { ...crewAccount, signIn: 'needs-reconnecting' }, crew)).toMatch(
      /reconnect it first/,
    );
  });

  it('reads an account’s sign-in and group from its seats', () => {
    expect(signInStateOf(null, ['active'])).toBe('not-signed-in');
    expect(signInStateOf('refresh', ['active', 'revoked'])).toBe('needs-reconnecting');
    expect(signInStateOf('refresh', ['active', null])).toBe('signed-in');
    expect(groupOfAccount([])).toBeNull();
    expect(groupOfAccount([{ role: 'qa' }, { role: 'automation' }])).toBe('crew');
  });

  it('believes what the sign-in check found over the stored status', () => {
    // The check signed in as it a minute ago; the stored status is from before.
    expect(signInStateOf('refresh', ['expired'], [true])).toBe('signed-in');
    // GitHub refused it; nothing had marked the credential yet.
    expect(signInStateOf('refresh', ['active', 'active'], [true, false])).toBe('needs-reconnecting');
    // The check has not said for one seat: the stored status decides.
    expect(signInStateOf('refresh', ['expired', 'active'], [true, null])).toBe('needs-reconnecting');
    expect(signInStateOf(null, ['active'], [true])).toBe('not-signed-in');
  });

  it('reads an account’s group from its seats', () => {
    expect(groupOfAccount([{ role: 'qa' }, { role: 'review_lead' }])).toBe('mixed');
  });
});

describe('the accounts, as the card lists them', () => {
  it('lists each account with its seats, group and sign-in, and each seat’s choices with reasons', async () => {
    const view = await onboarding().accounts();

    expect(view.accounts.map(({ login, group, signIn, seats }) => ({ login, group, signIn, seats: seats.map((one) => one.name) }))).toEqual([
      { login: 'exampleco-crew', group: 'crew', signIn: 'signed-in', seats: ['builder', 'qa'] },
      { login: 'exampleco-old', group: 'crew', signIn: 'not-signed-in', seats: ['automation'] },
      { login: 'exampleco-review', group: 'reviewers', signIn: 'signed-in', seats: ['exampleco-review'] },
    ]);
    const second = view.bots.find((bot) => bot.slot === 'second-reviewer')!;
    expect(second.login).toBeNull();
    expect(second.choices).toEqual([
      { login: 'exampleco-crew', refusal: 'used by the builder — reviewers need their own account' },
      { login: 'exampleco-old', refusal: 'used by the automation — reviewers need their own account' },
      { login: 'exampleco-review', refusal: null },
    ]);
  });
});

describe('which seats on an account the merge needs an approval from', () => {
  it('marks the lead and a blocking seat, not an advisory one, by the name each bot goes by now', async () => {
    world.crew = world.crew.map((bot) => (bot.id === 'b-second-reviewer' ? { ...bot, identityId: 'i-review', githubLogin: 'exampleco-review' } : bot));
    world.crew.push(seat('b-security-reviewer', 'security-reviewer', 'review_security', 'i-review', 'exampleco-review'));
    const view = await onboarding({
      review: {
        reviewers: [
          { seat: 'lead-reviewer', lens: 'lead', lead: true, blocking: false, trigger: 'always' },
          { seat: 'second-reviewer', lens: 'second', lead: false, blocking: false, trigger: 'always' },
          { seat: 'security-reviewer', lens: 'security', lead: false, blocking: true, trigger: 'always' },
        ],
        maxRounds: 3,
      },
    }).accounts();

    const review = view.accounts.find((account) => account.login === 'exampleco-review')!;
    expect(Object.fromEntries(review.seats.map((one) => [one.slot, one.approves]))).toEqual({
      'lead-reviewer': true,
      'second-reviewer': false,
      'security-reviewer': true,
    });
  });
});

describe('putting a seat on an account', () => {
  it('refuses a reviewer on the crew’s account, whatever the page offered, and changes nothing', async () => {
    const refused = onboarding().assignAccount({ bot: 'second-reviewer', login: 'exampleco-crew', actor: 'ada' });
    await expect(refused).rejects.toMatchObject({ status: 400 });
    await expect(refused).rejects.toThrow(/reviewers need their own account/);
    expect(world.crew.find((bot) => bot.id === 'b-second-reviewer')?.identityId).toBeNull();
    expect(world.audits).toEqual([]);
  });

  it('refuses a crew seat on the reviewers’ account', async () => {
    await expect(onboarding().assignAccount({ bot: 'qa', login: 'exampleco-review', actor: 'ada' })).rejects.toThrow(
      /can’t use exampleco-review: the reviewers’ account/,
    );
  });

  it('refuses an account OpenADLC holds no working sign-in for', async () => {
    await expect(onboarding().assignAccount({ bot: 'qa', login: 'nobody-here', actor: 'ada' })).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/holds no sign-in for a GitHub account called nobody-here/),
    });
    await expect(onboarding().assignAccount({ bot: 'qa', login: 'exampleco-old', actor: 'ada' })).rejects.toThrow(
      /not signed in — reconnect it first/,
    );
  });

  it('puts a seat on an account in its group, signed in with the account’s sign-in, and audits it', async () => {
    const result = await onboarding().assignAccount({ bot: 'second-reviewer', login: 'exampleco-review', actor: 'ada' });

    expect(result).toEqual({ bot: 'second-reviewer', login: 'exampleco-review' });
    expect(world.crew.find((bot) => bot.id === 'b-second-reviewer')).toMatchObject({ identityId: 'i-review', githubLogin: 'exampleco-review' });
    expect(world.credentials.get('b-second-reviewer')).toMatchObject({ status: 'active', secretRef: refreshTokenRef('exampleco-review') });
    expect(reconcile).toHaveBeenCalledWith('ada');
    expect(world.audits).toContainEqual(
      expect.objectContaining({ action: 'github.account_assigned', target: 'second-reviewer', payload: { login: 'exampleco-review', from: null } }),
    );
  });

  it('moving the last seat off an account keeps that account and its sign-in, used by no bot', async () => {
    world.identities.push({ id: 'i-spare', login: 'exampleco-spare', githubUserId: 4, secretNs: 'exampleco-spare' });
    secrets.set(refreshTokenRef('exampleco-spare'), 'ghr_spare');
    world.crew.push(seat('b-security-reviewer', 'security-reviewer', 'review_security', 'i-spare', 'exampleco-spare'));

    await onboarding().assignAccount({ bot: 'security-reviewer', login: 'exampleco-review', actor: 'ada' });

    expect(world.identities.map((identity) => identity.login)).toContain('exampleco-spare');
    expect(secrets.get(refreshTokenRef('exampleco-spare'))).toBe('ghr_spare');
    const view = await onboarding().accounts();
    expect(view.accounts.find((account) => account.login === 'exampleco-spare')).toMatchObject({ group: null, signIn: 'signed-in', seats: [] });
  });

  it('puts any seat on an account no bot uses, which then belongs to that seat’s group', async () => {
    world.identities.push({ id: 'i-spare', login: 'exampleco-spare', githubUserId: 4, secretNs: 'account_exampleco-spare' });
    secrets.set(refreshTokenRef('account_exampleco-spare'), 'ghr_spare');

    await onboarding().assignAccount({ bot: 'second-reviewer', login: 'exampleco-spare', actor: 'ada' });

    expect(world.crew.find((bot) => bot.id === 'b-second-reviewer')).toMatchObject({ identityId: 'i-spare', githubLogin: 'exampleco-spare' });
    expect(world.credentials.get('b-second-reviewer')?.secretRef).toBe(refreshTokenRef('account_exampleco-spare'));
    // A reviewer's account now: the crew may not follow it there.
    await expect(onboarding().assignAccount({ bot: 'qa', login: 'exampleco-spare', actor: 'ada' })).rejects.toThrow(/the reviewers’ account/);
  });
});

describe('an account no seat is on, which GitHub has since refused', () => {
  it('is not given a seat, as the page would not offer it', async () => {
    world.identities.push({ id: 'i-spare', login: 'exampleco-spare', githubUserId: 4, secretNs: 'account_exampleco-spare' });
    secrets.set(refreshTokenRef('account_exampleco-spare'), 'ghr_revoked');
    const flow = new Onboarding(
      { gitHubClientId: '', webhookSecret: '', humans: [], organization: '', publicUrl: '', automationBot: null } as never,
      {
        asBot: async () => null,
        exclusive: async (_names: string[], fn: () => Promise<unknown>) => fn(),
        signInState: async (account: { secretNs: string }) => (account.secretNs === 'account_exampleco-spare' ? 'refused' : 'works'),
      } as never,
    );
    flow.useNames({ reconcile, rename: async () => ({ state: 'unchanged' }) } as unknown as BotNames);

    await expect(flow.assignAccount({ bot: 'second-reviewer', login: 'exampleco-spare', actor: 'ada' })).rejects.toMatchObject({ status: 400 });
    expect(world.crew.find((bot) => bot.id === 'b-second-reviewer')?.identityId).toBeNull();
  });
});

describe('taking a seat off its account', () => {
  it('leaves the other seats on it signed in', async () => {
    const result = await onboarding().assignAccount({ bot: 'qa', login: null, actor: 'ada' });

    expect(result).toEqual({ bot: 'qa', login: null });
    expect(world.crew.find((bot) => bot.id === 'b-qa')).toMatchObject({ identityId: null, githubLogin: null });
    expect(world.credentials.has('b-qa')).toBe(false);
    expect(secrets.get(refreshTokenRef('builder'))).toBe('ghr_crew');
    expect(world.audits).toContainEqual(
      expect.objectContaining({ action: 'github.account_unassigned', target: 'qa', payload: { login: 'exampleco-crew' } }),
    );
  });

  it('files the sign-in under the account’s own name when the seat leaving holds it', async () => {
    // Left under `builder`, the builder's next rename would carry it off.
    await onboarding().assignAccount({ bot: 'builder', login: null, actor: 'ada' });

    expect(secrets.get(refreshTokenRef('account_exampleco-crew'))).toBe('ghr_crew');
    expect(secrets.has(refreshTokenRef('builder'))).toBe(false);
    expect(world.identities.find((identity) => identity.id === 'i-crew')?.secretNs).toBe('account_exampleco-crew');
    expect(world.credentials.get('b-qa')?.secretRef).toBe(refreshTokenRef('account_exampleco-crew'));
  });

  it('keeps the account and its sign-in when the last seat leaves it', async () => {
    const result = await onboarding().assignAccount({ bot: 'lead-reviewer', login: null, actor: 'ada' });

    expect(result).toEqual({ bot: 'exampleco-review', login: null });
    expect(world.identities.find((identity) => identity.id === 'i-review')).toMatchObject({
      login: 'exampleco-review',
      secretNs: 'account_exampleco-review',
    });
    expect(secrets.get(refreshTokenRef('account_exampleco-review'))).toBe('ghr_review');
    expect(secrets.has(refreshTokenRef('exampleco-review'))).toBe(false);
  });
});

describe('putting a seat on a person’s account, or one that administers a repository', () => {
  afterEach(() => {
    forgetRepoAccess();
    vi.mocked(repos.listRepos).mockResolvedValue([]);
  });

  it('refuses one of the install’s people with 400, and changes nothing', async () => {
    const refused = onboarding({ humans: ['exampleco-review'] }).assignAccount({ bot: 'second-reviewer', login: 'exampleco-review', actor: 'ada' });

    await expect(refused).rejects.toMatchObject({ status: 400 });
    await expect(refused).rejects.toThrow(/one of this install’s people — bots need their own account/);
    expect(world.crew.find((bot) => bot.id === 'b-second-reviewer')?.identityId).toBeNull();
    expect(world.audits).toEqual([]);
  });

  it('shows the same reason beside that account in the crew’s choices', async () => {
    const view = await onboarding({ humans: ['exampleco-review'] }).accounts();
    const choice = view.bots.find((bot) => bot.name === 'second-reviewer')?.choices.find((one) => one.login === 'exampleco-review');
    expect(choice?.refusal).toBe('one of this install’s people — bots need their own account');
  });

  it('refuses an account GitHub says has admin or maintain on a managed repository, naming it', async () => {
    vi.mocked(repos.listRepos).mockResolvedValue([{ name: 'app', fullName: 'exampleco/app', defaultBranch: 'main' }] as never);
    askAsTheApp(async () => ({
      request: async <T,>(_method: string, path: string): Promise<T> => {
        if (path.includes('/collaborators/exampleco-review/permission')) return { role_name: 'maintain', permission: 'write' } as T;
        throw new Error('404');
      },
    }));

    const refused = onboarding().assignAccount({ bot: 'second-reviewer', login: 'exampleco-review', actor: 'ada' });

    await expect(refused).rejects.toMatchObject({ status: 400 });
    await expect(refused).rejects.toThrow(/exampleco-review has maintain on exampleco\/app.*Lower it to the role its seat needs/);
    expect(world.crew.find((bot) => bot.id === 'b-second-reviewer')?.identityId).toBeNull();
  });
});

describe('moving a seat that is working', () => {
  // What `seatWorkRefusal` answers for a seat with work in flight: a 409 in
  // seat removal's words, ending with what to do.
  const busy = (message: string) => Object.assign(new Error(message), { name: 'SeatRefused', status: 409 });

  it.each([
    ['has a task that has not ended', 'qa has a task that has not ended; stop it or let it finish, then move it'],
    ['holds a lease', 'qa holds the lease on infra#12; release it or let it expire, then move it'],
  ])('refuses to take it off its account while it %s, and changes nothing', async (_why, message) => {
    vi.mocked(bots.seatWorkRefusal).mockResolvedValue(busy(message) as never);

    const refused = onboarding().assignAccount({ bot: 'qa', login: null, actor: 'ada' });

    await expect(refused).rejects.toMatchObject({ status: 409, message });
    expect(bots.seatWorkRefusal).toHaveBeenCalledWith('b-qa', 'move it');
    expect(world.crew.find((bot) => bot.id === 'b-qa')).toMatchObject({ identityId: 'i-crew', githubLogin: 'exampleco-crew' });
    expect(world.credentials.has('b-qa')).toBe(true);
    expect(world.audits).toEqual([]);
  });

  it('refuses to move it to another account while it works', async () => {
    world.identities.push({ id: 'i-spare', login: 'exampleco-spare', githubUserId: 4, secretNs: 'account_exampleco-spare' });
    secrets.set(refreshTokenRef('account_exampleco-spare'), 'ghr_spare');
    vi.mocked(bots.seatWorkRefusal).mockResolvedValue(
      busy('qa has a task that has not ended; stop it or let it finish, then move it') as never,
    );

    await expect(onboarding().assignAccount({ bot: 'qa', login: 'exampleco-spare', actor: 'ada' })).rejects.toMatchObject({
      status: 409,
    });
    expect(world.crew.find((bot) => bot.id === 'b-qa')).toMatchObject({ identityId: 'i-crew', githubLogin: 'exampleco-crew' });
    expect(world.credentials.get('b-qa')?.githubLogin).toBe('exampleco-crew');
  });

  it('puts a seat on no account onto one without asking, and leaves a seat put back on its own account alone', async () => {
    vi.mocked(bots.seatWorkRefusal).mockResolvedValue(busy('never asked') as never);

    await onboarding().assignAccount({ bot: 'second-reviewer', login: 'exampleco-review', actor: 'ada' });
    expect(await onboarding().assignAccount({ bot: 'qa', login: 'exampleco-crew', actor: 'ada' })).toEqual({
      bot: 'qa',
      login: 'exampleco-crew',
    });
    expect(await onboarding().assignAccount({ bot: 'second-reviewer', login: null, actor: 'ada' }).catch((error) => error)).toMatchObject({
      status: 409,
    });
    expect(world.crew.find((bot) => bot.id === 'b-second-reviewer')?.identityId).toBe('i-review');
  });
});

describe('connecting a seat on a shared account as another account', () => {
  it('leaves the shared account signed in for the seats that stay', async () => {
    // The builder holds the crew's sign-in under its own name; connecting it
    // as a new account files that one under its name too, and must not write
    // over the other.
    const flow = onboarding();
    await flow.startAuthorization('builder', 'ada');
    await vi.waitFor(async () => expect((await flow.authorizationState('builder')).state).toBe('connected'));

    expect(secrets.get(refreshTokenRef('builder'))).toBe('ghr_new');
    expect(secrets.get(refreshTokenRef('account_exampleco-crew'))).toBe('ghr_crew');
    expect(world.identities.find((identity) => identity.id === 'i-crew')?.secretNs).toBe('account_exampleco-crew');
    expect(world.crew.find((bot) => bot.id === 'b-builder')?.githubLogin).toBe('exampleco-new');
    expect(world.audits).toContainEqual(
      expect.objectContaining({
        action: 'github.account_unassigned',
        target: 'builder',
        payload: expect.objectContaining({ login: 'exampleco-crew' }),
      }),
    );
  });

  it('joins an account OpenADLC holds with no bot on it, replacing its sign-in where it is filed', async () => {
    world.identities.push({ id: 'i-new', login: 'exampleco-new', githubUserId: 9, secretNs: 'account_exampleco-new' });
    secrets.set(refreshTokenRef('account_exampleco-new'), 'ghr_old');
    const flow = onboarding();
    await flow.startAuthorization('second-reviewer', 'ada');
    await vi.waitFor(async () => expect((await flow.authorizationState('second-reviewer')).state).toBe('connected'));

    expect(secrets.get(refreshTokenRef('account_exampleco-new'))).toBe('ghr_new');
    expect(secrets.has(refreshTokenRef('second-reviewer'))).toBe(false);
    expect(world.crew.find((bot) => bot.id === 'b-second-reviewer')).toMatchObject({ identityId: 'i-new', githubLogin: 'exampleco-new' });
    expect(world.credentials.get('b-second-reviewer')?.secretRef).toBe(refreshTokenRef('account_exampleco-new'));
  });
});

describe('connecting an account for no bot', () => {
  async function connected(flow: Onboarding): Promise<{ state: string; login?: string; error?: string }> {
    const { flowId } = await flow.startAccountConnect('ada');
    let answer: { state: string; login?: string; error?: string } = { state: 'waiting' };
    await vi.waitFor(() => {
      answer = flow.accountConnectState(flowId);
      expect(answer.state).not.toBe('waiting');
    });
    return answer;
  }

  it('asks the accounts check again when a seatless account connects, and when one is disconnected', async () => {
    const runSoon = vi.fn();
    const flow = onboarding();
    flow.useHealth({ rows: async () => [], runSoon, checks: [] } as never);

    await connected(flow);
    expect(runSoon).toHaveBeenCalledWith(['github-accounts']);

    runSoon.mockClear();
    await flow.disconnectAccount({ login: 'exampleco-new', actor: 'ada' });
    expect(runSoon).toHaveBeenCalledWith(['github-accounts']);
  });

  it('refuses one of the install’s people before anything is stored, and says to sign in as the bot', async () => {
    const answer = await connected(onboarding({ humans: ['ExampleCo-New'] }));

    expect(answer).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('exampleco-new is one of this install’s people (FLEETADLC_HUMANS), so no bot can sign in as it'),
    });
    expect(world.identities.some((identity) => identity.login === 'exampleco-new')).toBe(false);
    expect([...secrets.keys()].some((ref) => ref.includes('exampleco-new'))).toBe(false);
  });

  it('records the account that approved, its sign-in under the account’s own name, on no seat', async () => {
    const answer = await connected(onboarding());

    expect(answer).toEqual({ state: 'connected', login: 'exampleco-new' });
    expect(world.identities.find((identity) => identity.login === 'exampleco-new')).toMatchObject({
      githubUserId: 9,
      secretNs: 'account_exampleco-new',
    });
    expect(secrets.get(refreshTokenRef('account_exampleco-new'))).toBe('ghr_new');
    expect(world.crew.some((bot) => bot.githubLogin === 'exampleco-new')).toBe(false);
    expect(world.audits).toContainEqual(expect.objectContaining({ action: 'github.account_connected', target: 'exampleco-new' }));
  });

  it('reconnects an account OpenADLC holds where its sign-in is filed, and marks its seats authorized again', async () => {
    world.identities = world.identities.map((identity) => (identity.id === 'i-crew' ? { ...identity, login: 'exampleco-new' } : identity));
    world.credentials.set('b-qa', { ...world.credentials.get('b-qa')!, status: 'revoked' });

    const answer = await connected(onboarding());

    expect(answer.login).toBe('exampleco-new');
    expect(secrets.get(refreshTokenRef('builder'))).toBe('ghr_new');
    expect(world.identities.filter((identity) => identity.login === 'exampleco-new')).toHaveLength(1);
    expect(world.credentials.get('b-qa')?.status).toBe('active');
    expect(world.audits).toContainEqual(expect.objectContaining({ action: 'github.account_reconnected' }));
  });
});

describe('an account no bot uses, as the list shows it', () => {
  it('leaves the accounts step open when the broker refuses a seatless sign-in', async () => {
    world.crew = [];
    world.credentials = new Map();
    world.identities = [
      { id: 'i-spare', login: 'exampleco-spare', githubUserId: 4, secretNs: 'account_exampleco-spare' },
      { id: 'i-other', login: 'exampleco-other', githubUserId: 5, secretNs: 'account_exampleco-other' },
    ];
    secrets.set(refreshTokenRef('account_exampleco-spare'), 'ghr_spare');
    secrets.set(refreshTokenRef('account_exampleco-other'), 'ghr_other');
    const asked: string[] = [];
    const flow = new Onboarding(
      { gitHubClientId: '', webhookSecret: '', humans: [], organization: '', publicUrl: '', automationBot: null } as never,
      {
        asBot: async () => null,
        exclusive: async (_names: string[], fn: () => Promise<unknown>) => fn(),
        signsIn: async (account: { login: string }) => {
          asked.push(account.login);
          return false;
        },
      } as never,
    );

    const view = await flow.view('op@example.com');

    expect(asked.sort()).toEqual(['exampleco-other', 'exampleco-spare']);
    expect(view.githubAccounts?.map((account) => account.signIn)).toEqual(['needs-reconnecting', 'needs-reconnecting']);
    expect(view.steps.find((step) => step.step === 'github-accounts')?.done).toBe(false);
  });

  it('asks the token broker whether its sign-in works, having no seat to say', async () => {
    world.identities.push({ id: 'i-spare', login: 'exampleco-spare', githubUserId: 4, secretNs: 'account_exampleco-spare' });
    secrets.set(refreshTokenRef('account_exampleco-spare'), 'ghr_spare');
    const asked: string[] = [];
    const flow = new Onboarding(
      { gitHubClientId: '', webhookSecret: '', humans: [], organization: '', publicUrl: '', automationBot: null } as never,
      {
        asBot: async () => null,
        exclusive: async (_names: string[], fn: () => Promise<unknown>) => fn(),
        signsIn: async (account: { secretNs: string }) => {
          asked.push(account.secretNs);
          return false;
        },
      } as never,
    );

    const view = await flow.accounts();

    expect(asked).toEqual(['account_exampleco-spare']);
    expect(view.accounts.find((account) => account.login === 'exampleco-spare')?.signIn).toBe('needs-reconnecting');
  });
});

describe('the walkthrough reading the accounts', () => {
  type State = 'works' | 'refused' | 'failed' | 'unknown';
  function spare(asked: string[], state: () => State) {
    world.crew = [];
    world.credentials = new Map();
    world.identities = [{ id: 'i-spare', login: 'exampleco-spare', githubUserId: 4, secretNs: 'account_exampleco-spare' }];
    secrets.set(refreshTokenRef('account_exampleco-spare'), 'ghr_spare');
    return new Onboarding(
      { gitHubClientId: '', webhookSecret: '', humans: [], organization: '', publicUrl: '', automationBot: null } as never,
      {
        asBot: async () => null,
        exclusive: async (_names: string[], fn: () => Promise<unknown>) => fn(),
        signInState: async (account: { login: string }) => {
          asked.push(account.login);
          return state();
        },
      } as never,
    );
  }

  it('does not ask GitHub again on every load about a sign-in it just refused', async () => {
    const asked: string[] = [];
    const flow = spare(asked, () => 'refused');

    await flow.view('op@example.com');
    await flow.view('op@example.com');
    const listed = await flow.accounts();

    expect(asked).toEqual(['exampleco-spare']);
    expect(listed.accounts[0]?.signIn).toBe('needs-reconnecting');
  });

  it('asks again on the next load when GitHub could not be reached, rather than remembering a refusal', async () => {
    const asked: string[] = [];
    let state: State = 'failed';
    const flow = spare(asked, () => state);

    const blip = await flow.view('op@example.com');
    state = 'works';
    const after = await flow.view('op@example.com');

    expect(asked).toEqual(['exampleco-spare', 'exampleco-spare']);
    expect(blip.githubAccounts?.[0]?.signIn).toBe('needs-reconnecting');
    expect(after.githubAccounts?.[0]?.signIn).toBe('signed-in');
  });

  it('asks again once the account is disconnected, so a reconnect is not still refused', async () => {
    const asked: string[] = [];
    let state: State = 'refused';
    const flow = spare(asked, () => state);

    await flow.view('op@example.com');
    await flow.disconnectAccount({ login: 'exampleco-spare', actor: 'ada' });
    world.identities = [{ id: 'i-spare', login: 'exampleco-spare', githubUserId: 4, secretNs: 'account_exampleco-spare' }];
    secrets.set(refreshTokenRef('account_exampleco-spare'), 'ghr_again');
    state = 'works';
    const view = await flow.view('op@example.com');

    expect(asked).toEqual(['exampleco-spare', 'exampleco-spare']);
    expect(view.githubAccounts?.[0]?.signIn).toBe('signed-in');
  });

  it('leaves the list out when it cannot be read, so the check decides the step', async () => {
    const flow = spare([], () => 'works');
    flow.useHealth({
      rows: async () => [{ id: 'github-accounts', checkId: 'github-accounts', subject: null, state: 'ok', severity: null }],
      runSoon: vi.fn(),
      checks: [{ id: 'github-accounts', steps: ['github-accounts'] }],
    } as never);
    vi.mocked(identities.listIdentities).mockRejectedValueOnce(new Error('the database went away'));

    const view = await flow.view('op@example.com');

    expect(view.githubAccounts).toBeUndefined();
    expect(view.steps.find((step) => step.step === 'github-accounts')?.done).toBe(true);
  });
});

describe('disconnecting an account', () => {
  it('refuses while any bot uses it, naming them', async () => {
    const refused = onboarding().disconnectAccount({ login: 'exampleco-crew', actor: 'ada' });
    await expect(refused).rejects.toMatchObject({ status: 409 });
    await expect(refused).rejects.toThrow(/used by the builder, the QA/i);
    expect(world.identities.some((identity) => identity.id === 'i-crew')).toBe(true);
    expect(secrets.get(refreshTokenRef('builder'))).toBe('ghr_crew');
  });

  it('forgets an account no bot uses, and its sign-in, and audits it', async () => {
    world.identities.push({ id: 'i-spare', login: 'exampleco-spare', githubUserId: 4, secretNs: 'account_exampleco-spare' });
    secrets.set(refreshTokenRef('account_exampleco-spare'), 'ghr_spare');

    await expect(onboarding().disconnectAccount({ login: 'exampleco-spare', actor: 'ada' })).resolves.toEqual({ login: 'exampleco-spare' });

    expect(world.identities.some((identity) => identity.id === 'i-spare')).toBe(false);
    expect(secrets.has(refreshTokenRef('account_exampleco-spare'))).toBe(false);
    expect(world.audits).toContainEqual(expect.objectContaining({ action: 'github.account_disconnected', target: 'exampleco-spare' }));
  });
});
