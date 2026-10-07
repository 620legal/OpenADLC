import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubApiError, type AppApi } from '@fleetadlc/github';

/**
 * The last setup step, with no GitHub behind it.
 *
 * What matters here is that the list somebody agreed to is the list that gets
 * written, and that reading the plan never writes anything — the whole point of
 * moving this out of a terminal is that you see it before it happens.
 */
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

  settings: { allSettings: vi.fn(async () => STORED), setSetting: vi.fn() },
  repos: {
    listRepos: vi.fn(async () => REPOS),
    getPlanLimits: vi.fn(async (name: string) => PLAN_LIMITS.get(name) ?? null),
    setPlanLimits: vi.fn(async (name: string, input: Record<string, unknown>) => {
      if ((input.limits as unknown[]).length === 0) PLAN_LIMITS.delete(name);
      else PLAN_LIMITS.set(name, { ...input, recordedAt: '2026-09-29T00:00:00Z' });
    }),
    clearPlanLimits: vi.fn(async (name: string) => PLAN_LIMITS.delete(name)),
  },
  bots: { listBots: vi.fn(async () => CREW) },
}));

/** `repo_plan_limits`, by repository. */
const PLAN_LIMITS = new Map<string, Record<string, unknown>>();

vi.mock('@fleetadlc/github', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fleetadlc/github')>()),
  getSecretStore: () => ({
    get: async (ref: string) => SECRETS[ref] ?? null,
    set: async () => undefined,
    delete: async () => undefined,
    list: async () => [],
  }),
}));

let STORED: Record<string, string> = {};
let SECRETS: Record<string, string> = {};
let REPOS: { name: string; fullName: string; defaultBranch: string | null }[] = [];
let CREW: { name: string; role: string; githubLogin: string | null }[] = [];
/** Every call the subject made, so a read-only path can be proven read-only. */
let CALLS: { method: string; path: string; body?: unknown }[] = [];
let REMOTE_LABELS: { name: string; color: string; description: string }[] = [];
/** Repositories that are private on a plan that refuses rulesets, by full name. */
let REFUSES: Set<string> = new Set();

const { privateKey: PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const LABELS = [
  { name: 'stage:intake', color: 'ededed', description: 'waiting to be picked up' },
  { name: 'stage:spec', color: 'c5def5', description: 'being specified' },
  { name: 'stage:build', color: '0e8a16', description: 'being built' },
];

/** The app JWT path: an installation, then a token. */
const appApi: AppApi = {
  request: async <T>(method: string, path: string, _token: string, body?: unknown): Promise<T> => {
    CALLS.push({ method, path, body });
    if (path.endsWith('/installation')) return { id: 42 } as T;
    if (path.includes('access_tokens')) return { token: 'ghs_installation', expires_at: null } as T;
    return {} as T;
  },
};

/** The repository, spoken to with that token. */
function repoClient() {
  return {
    request: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      CALLS.push({ method, path, body });
      if (method === 'GET' && path.includes('/labels?')) return REMOTE_LABELS as T;
      if (method === 'GET' && path.startsWith('/users/')) return { id: 583231 } as T;
      const refusing = [...REFUSES].find((fullName) => path.startsWith(`/repos/${fullName}`));
      if (refusing && method === 'GET' && path === `/repos/${refusing}`) return { private: true, owner: { type: 'Organization' } } as T;
      if (refusing && path.startsWith(`/repos/${refusing}/rulesets`)) {
        throw new Error(`${path} → 403: {"message":"Upgrade to GitHub Pro or make this repository public to enable this feature."}`);
      }
      if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+$/.test(path)) return { private: false, owner: { type: 'Organization' } } as T;
      if (method === 'GET' && path.endsWith('/rulesets')) return [] as T;
      // Enough for checkRepoRules/checkRepoTemplates to report "missing" rather
      // than throw: nothing exists on this repository yet.
      if (method === 'GET') throw Object.assign(new Error('404'), { status: 404 });
      return {} as T;
    },
  };
}

async function subject(overrides: Record<string, unknown> = {}) {
  const { RepoSetup } = await import('./repo-setup.js');
  return new RepoSetup({
    config: { repoRoot: '/nowhere', organization: 'janedoe', gitHubClientId: 'Iv23liTEST', humans: ['janedoe'], automationBot: 'flow', publicUrl: '', webhookSecret: '' } as never,
    api: appApi,
    clientFor: () => repoClient(),
    readLabels: () => LABELS,
    ...overrides,
  });
}

beforeEach(async () => {
  STORED = {};
  CALLS = [];
  REPOS = [{ name: 'fleetadlc-testbed', fullName: 'janedoe/fleetadlc-testbed', defaultBranch: 'main' }];
  CREW = [{ name: 'sydney', role: 'review_lead', githubLogin: 'ottoexampleco' }];
  REMOTE_LABELS = [];
  REFUSES = new Set();
  PLAN_LIMITS.clear();
  const { appPrivateKeyRef } = await import('@fleetadlc/github');
  SECRETS = { [appPrivateKeyRef()]: PRIVATE_KEY };
});

describe('showing what a click would change', () => {
  it('lists every label that is not there yet', async () => {
    const [plan] = await (await subject()).plan();

    expect(plan?.labels.map((one) => one.action)).toEqual(['create', 'create', 'create']);
    expect(plan?.labelChanges).toBe(3);
  });

  it('does not count a label that already matches', async () => {
    REMOTE_LABELS = [LABELS[0]!];
    const [plan] = await (await subject()).plan();

    expect(plan?.labels[0]).toMatchObject({ name: 'stage:intake', action: 'unchanged' });
    expect(plan?.labelChanges).toBe(2);
  });

  it('offers to fix a label whose colour drifted', async () => {
    REMOTE_LABELS = [{ ...LABELS[0]!, color: 'ff0000' }];
    const [plan] = await (await subject()).plan();

    expect(plan?.labels[0]).toMatchObject({ action: 'update' });
  });

  it('writes nothing while reading the plan', async () => {
    // The reason this is a preview and not a command: you see it first.
    await (await subject()).plan();

    const writes = CALLS.filter((call) => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(call.method));
    // The one POST that is allowed is minting the installation token, which
    // changes nothing on the repository.
    expect(writes.every((call) => call.path.includes('access_tokens'))).toBe(true);
  });

  it('plans nothing for a repository whose labels could not be read, rather than creating them all', async () => {
    const failing = () => ({
      request: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
        if (method === 'GET' && path.includes('/labels?')) throw new Error(`${path} → 502`);
        return repoClient().request<T>(method, path, body);
      },
    });
    const setup = await subject({ clientFor: failing });
    const [plan] = await setup.plan();

    expect(plan?.canApply).toBe(false);
    expect(plan?.labelChanges).toBe(0);
    expect(plan?.detail).toMatch(/labels could not be read .*502/);
    await expect(setup.applyLabels('janedoe/fleetadlc-testbed')).rejects.toThrow(/502/);
    expect(CALLS.filter((call) => call.method === 'POST' && call.path.endsWith('/labels'))).toEqual([]);
  });

  it('reports rather than fails when OpenADLC holds no app key', async () => {
    SECRETS = {};
    const [plan] = await (await subject()).plan();

    expect(plan?.canApply).toBe(false);
    expect(plan?.detail).toMatch(/no app key/);
  });

  it('says the labels could not be read, rather than that every one is missing', async () => {
    const [plan] = await (await subject({ clientFor: () => ({
      request: async <T>(method: string, path: string): Promise<T> => {
        CALLS.push({ method, path });
        if (path.includes('/labels?')) throw new Error('502 Bad Gateway');
        return [] as T;
      },
    }) })).plan();

    expect(plan?.labelChanges).toBe(0);
    expect(plan?.canApply).toBe(false);
    expect(plan?.detail).toMatch(/labels could not be read from GitHub.*502 Bad Gateway/);
  });

  it('tells a repository the app cannot reach apart from an install with no app key', async () => {
    const uninstalled: AppApi = {
      request: async <T>(method: string, path: string): Promise<T> => {
        CALLS.push({ method, path });
        if (path.endsWith('/installation')) throw new Error('GitHub answered 404: Not Found');
        return {} as T;
      },
    };
    const [plan] = await (await subject({ api: uninstalled })).plan();

    expect(plan?.canApply).toBe(false);
    expect(plan?.detail).toMatch(/^the app cannot reach this repository: /);
    expect(plan?.detail).not.toMatch(/no app key/);
  });

  it('says the app is not installed on a repository GitHub answers 404 for, and where that is fixed', async () => {
    const uninstalled: AppApi = {
      request: async <T>(method: string, path: string): Promise<T> => {
        CALLS.push({ method, path });
        if (path.endsWith('/installation')) throw new GitHubApiError(404, path, '{"message":"Not Found"}');
        return {} as T;
      },
    };
    const [plan] = await (await subject({ api: uninstalled })).plan();

    expect(plan?.canApply).toBe(false);
    expect(plan?.detail).toBe(
      'the OpenADLC app is not installed on janedoe/fleetadlc-testbed: install it on this repository, or add janedoe/fleetadlc-testbed to the repositories its installation can reach',
    );
  });

  it('tells an install with no app apart from one with no key', async () => {
    const setup = await subject({
      config: { repoRoot: '/nowhere', organization: 'janedoe', gitHubClientId: '', humans: ['janedoe'], automationBot: 'flow', publicUrl: '', webhookSecret: '' },
    });
    const [plan] = await setup.plan();

    expect(plan?.canApply).toBe(false);
    expect(plan?.detail).toBe('OpenADLC has no GitHub App yet, so it can only report. Create it on the Create the app step');
    await expect(setup.applyLabels('janedoe/fleetadlc-testbed')).rejects.toThrow(/has no GitHub App yet.*Create it on the Create the app step/);
  });

  it('says so plainly when there is nothing left to do', async () => {
    REMOTE_LABELS = LABELS;
    const [plan] = await (await subject({ clientFor: () => ({
      request: async <T>(method: string, path: string): Promise<T> => {
        CALLS.push({ method, path });
        if (path.includes('/labels?')) return REMOTE_LABELS as T;
        return [] as T;
      },
    }) })).plan();

    expect(plan?.labelChanges).toBe(0);
  });
});

describe('writing the board’s columns', () => {
  it('creates the ones that are missing', async () => {
    await (await subject()).applyLabels('janedoe/fleetadlc-testbed');

    const created = CALLS.filter((call) => call.method === 'POST' && call.path.endsWith('/labels'));
    expect(created.map((call) => (call.body as { name: string }).name)).toEqual([
      'stage:intake',
      'stage:spec',
      'stage:build',
    ]);
  });

  it('leaves a matching label alone rather than rewriting it', async () => {
    REMOTE_LABELS = [LABELS[0]!];
    await (await subject()).applyLabels('janedoe/fleetadlc-testbed');

    const touched = CALLS.filter(
      (call) => ['POST', 'PATCH'].includes(call.method) && call.path.includes('/labels'),
    );
    expect(touched).toHaveLength(2);
  });

  it('updates a drifted one in place instead of creating a duplicate', async () => {
    REMOTE_LABELS = [{ ...LABELS[0]!, color: 'ff0000' }];
    await (await subject()).applyLabels('janedoe/fleetadlc-testbed');

    const patched = CALLS.filter((call) => call.method === 'PATCH');
    expect(patched).toHaveLength(1);
    expect(patched[0]?.path).toContain('stage%3Aintake');
  });

  it('never deletes a label somebody else added', async () => {
    // The repository is not OpenADLC's to tidy. Additive, always.
    REMOTE_LABELS = [{ name: 'good first issue', color: 'aaaaaa', description: 'theirs' }];
    await (await subject()).applyLabels('janedoe/fleetadlc-testbed');

    expect(CALLS.filter((call) => call.method === 'DELETE')).toEqual([]);
  });

  it('reports one refusal per label instead of losing the whole run', async () => {
    let attempts = 0;
    const done = await (
      await subject({
        clientFor: () => ({
          request: async <T>(method: string, path: string): Promise<T> => {
            if (method === 'GET') return [] as T;
            attempts += 1;
            if (attempts === 2) throw new Error('403 Resource not accessible by integration');
            return {} as T;
          },
        }),
      })
    ).applyLabels('janedoe/fleetadlc-testbed');

    expect(done.filter((one) => one.detail.startsWith('failed:'))).toHaveLength(1);
    // The other two still went in.
    expect(done.filter((one) => !one.detail.startsWith('failed:'))).toHaveLength(2);
  });

  it('refuses a repository OpenADLC does not work in, and writes nothing to it', async () => {
    await expect((await subject()).applyLabels('someone-else/their-app')).rejects.toThrow(/no repository named someone-else\/their-app/);

    expect(CALLS.filter((call) => ['POST', 'PATCH'].includes(call.method))).toEqual([]);
  });

  it('reads every page of labels, and takes one GitHub says exists as done', async () => {
    const pages = [
      Array.from({ length: 100 }, (_, index) => ({ name: `theirs-${index}`, color: 'aaaaaa', description: '' })),
      [LABELS[0]!],
    ];
    const done = await (
      await subject({
        clientFor: () => ({
          request: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
            CALLS.push({ method, path, body });
            if (method === 'GET') return (pages[Number(new URL(path, 'https://api.github.com').searchParams.get('page')) - 1] ?? []) as T;
            if ((body as { name?: string }).name === 'stage:spec') throw new Error('422: {"errors":[{"code":"already_exists"}]}');
            return {} as T;
          },
        }),
      })
    ).applyLabels('janedoe/fleetadlc-testbed');

    // stage:intake was on the second page, so it is not created again.
    expect(CALLS.filter((call) => call.method === 'POST' && call.path.endsWith('/labels')).map((call) => (call.body as { name: string }).name)).toEqual(['stage:spec', 'stage:build']);
    expect(done.filter((one) => one.detail.startsWith('failed:'))).toEqual([]);
  });

  it('refuses to write at all without the app key', async () => {
    SECRETS = {};
    await expect((await subject()).applyLabels('janedoe/fleetadlc-testbed')).rejects.toThrow(/no app key/);
  });
});

describe('acting as the app rather than as a bot', () => {
  it('mints an installation token for the one repository', async () => {
    // A bot token reaches the app's permissions intersected with that account's
    // access, and the crew have `write` at most — so the admin-gated half of
    // this could never have worked as the automation bot.
    await (await subject()).plan();

    const minted = CALLS.find((call) => call.path.includes('access_tokens'));
    expect(minted?.body).toMatchObject({ repositories: ['fleetadlc-testbed'] });
  });

  it('names whoever actually holds the lead reviewer role', async () => {
    CREW = [{ name: 'someone-else', role: 'review_lead', githubLogin: 'a-different-login' }];
    const setup = await subject();

    // Reached through the rules input, which is what CODEOWNERS is built from.
    const input = await (setup as unknown as {
      rulesInput: (repo: unknown) => Promise<{ leadReviewer: string }>;
    }).rulesInput({ fullName: 'janedoe/fleetadlc-testbed', defaultBranch: 'main' });

    expect(input.leadReviewer).toBe('a-different-login');
  });

  it('names the person, not a guessed account, when no lead reviewer is connected', async () => {
    // A seat with no account has no login to put in CODEOWNERS. The fallback
    // was `fleetadlc-sydney`, which is somebody's account or will be.
    CREW = [{ name: 'lead-reviewer', role: 'review_lead', githubLogin: null }];
    const setup = await subject();

    const input = await (setup as unknown as {
      rulesInput: (repo: unknown) => Promise<{ leadReviewer: string }>;
    }).rulesInput({ fullName: 'janedoe/fleetadlc-testbed', defaultBranch: 'main' });

    expect(input.leadReviewer).toBe('janedoe');
  });
});

describe('counting what is being agreed to', () => {
  /**
   * CODEOWNERS is checked by both halves: the `main` ruleset needs one to be
   * able to require a code owner's review, and it is also among the files a
   * repository with none is given. Against the real repository that showed up as
   * two identical lines and a count one too high.
   */
  it('lists a file checked by both halves only once', async () => {
    const [plan] = await (
      await subject({
        clientFor: () => ({
          request: async <T,>(method: string, path: string): Promise<T> => {
            CALLS.push({ method, path });
            if (path.includes('/labels?')) return [] as T;
            throw Object.assign(new Error('404'), { status: 404 });
          },
        }),
      })
    ).plan();

    const names = [...(plan?.rules ?? []), ...(plan?.templates ?? [])].map((one) => one.name);
    expect(names.length).toBe(new Set(names).size);
  });

  it('counts that file once as well', async () => {
    const [plan] = await (await subject()).plan();

    const outstanding = [...(plan?.rules ?? []), ...(plan?.templates ?? [])].filter(
      (one) => one.state === 'missing' || one.state === 'drifted',
    );
    expect(plan?.ruleChanges).toBe(outstanding.length);
  });
});

describe('one apply leaves a repository able to land', () => {
  // A repository with no workflow was given no status-check rule, and then the
  // CI workflow was written after the rules: the merge line still had nothing
  // required to wait for until somebody applied a second time.
  const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

  it('requires the ci check in the same apply that writes the workflow publishing it', async () => {
    const workflows: string[] = [];
    const rulesets: { id: number; name: string; rules: { type: string }[] }[] = [];
    const client = {
      request: async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
        CALLS.push({ method, path, body });
        if (method === 'GET' && path === '/repos/janedoe/fleetadlc-testbed') return { owner: { type: 'User' }, private: false } as T;
        if (method === 'GET' && path.endsWith('/contents/.github/workflows')) {
          if (workflows.length === 0) throw Object.assign(new Error('404'), { status: 404 });
          return workflows.map((name) => ({ name })) as T;
        }
        if (method === 'PUT' && path.endsWith('/contents/.github/workflows/ci.yml')) {
          workflows.push('ci.yml');
          return {} as T;
        }
        if (method === 'GET' && path.endsWith('/rulesets')) return rulesets as T;
        if (method === 'POST' && path.endsWith('/rulesets')) {
          rulesets.push({ ...(body as { name: string; rules: { type: string }[] }), id: rulesets.length + 1 });
          return {} as T;
        }
        const one = /\/rulesets\/(\d+)$/.exec(path);
        if (one && method === 'GET') return rulesets.find((ruleset) => ruleset.id === Number(one[1])) as T;
        if (one && method === 'PUT') {
          const at = rulesets.findIndex((ruleset) => ruleset.id === Number(one[1]));
          rulesets[at] = { ...(body as { name: string; rules: { type: string }[] }), id: Number(one[1]) };
          return {} as T;
        }
        if (method === 'GET') throw Object.assign(new Error('404'), { status: 404 });
        return {} as T;
      },
    };
    const setup = await subject({
      clientFor: () => client,
      config: { repoRoot: ROOT, organization: 'janedoe', gitHubClientId: 'Iv23liTEST', humans: ['janedoe'], automationBot: 'flow', publicUrl: '', webhookSecret: '' },
    });

    const outcomes = await setup.applyRules('janedoe/fleetadlc-testbed');

    expect(outcomes.find((one) => one.name === '.github/workflows/ci.yml')).toMatchObject({ action: 'created' });
    expect(outcomes.find((one) => one.name === 'required status checks')).toMatchObject({ action: 'created' });
    const main = rulesets.find((ruleset) => ruleset.name === 'fleetadlc: main');
    expect(main?.rules.some((rule) => rule.type === 'required_status_checks')).toBe(true);
  });
});

describe('the app changing on a running bridge', () => {
  const { privateKey: OTHER_KEY } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  /** GitHub's `/app`, answering for whichever app the JWT's issuer is. */
  const apps: AppApi = {
    request: async <T,>(method: string, path: string, token: string, body?: unknown): Promise<T> => {
      if (path === '/app') {
        CALLS.push({ method, path });
        const { iss } = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as { iss: string };
        return { id: iss === 'Iv23liAPPTWO' ? 222 : 111, permissions: { checks: 'write' } } as T;
      }
      return appApi.request<T>(method, path, token, body);
    },
  };

  // The repository's own templates, so the apply writes CI and the ruleset requires its checks.
  const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

  /** A repository that keeps the rulesets and workflows written to it. */
  function keeping() {
    const workflows: string[] = [];
    const rulesets: { id: number; name: string; bypass_actors?: { actor_id: number }[]; rules: { type: string; parameters?: Record<string, unknown> }[] }[] = [];
    const client = {
      request: async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
        if (method === 'GET' && path.includes('/labels?')) return [] as T;
        if (method === 'GET' && path === '/repos/janedoe/fleetadlc-testbed') return { owner: { type: 'User' }, private: false } as T;
        if (method === 'GET' && path.endsWith('/contents/.github/workflows')) {
          if (workflows.length === 0) throw Object.assign(new Error('404'), { status: 404 });
          return workflows.map((name) => ({ name })) as T;
        }
        if (method === 'PUT' && path.endsWith('/contents/.github/workflows/ci.yml')) {
          workflows.push('ci.yml');
          return {} as T;
        }
        if (method === 'GET' && path.endsWith('/rulesets')) return rulesets as T;
        if (method === 'POST' && path.endsWith('/rulesets')) {
          rulesets.push({ ...(body as (typeof rulesets)[number]), id: rulesets.length + 1 });
          return {} as T;
        }
        const one = /\/rulesets\/(\d+)$/.exec(path);
        if (one && method === 'GET') return rulesets.find((ruleset) => ruleset.id === Number(one[1])) as T;
        if (one && method === 'PUT') {
          const at = rulesets.findIndex((ruleset) => ruleset.id === Number(one[1]));
          rulesets[at] = { ...(body as (typeof rulesets)[number]), id: Number(one[1]) };
          return {} as T;
        }
        if (method === 'GET') throw Object.assign(new Error('404'), { status: 404 });
        return {} as T;
      },
    };
    return { rulesets, client };
  }

  const asked = () => CALLS.filter((call) => call.path === '/app').length;
  const reviewGate = (ruleset: { rules: { type: string; parameters?: Record<string, unknown> }[] }) =>
    (ruleset.rules.find((rule) => rule.type === 'required_status_checks')?.parameters?.required_status_checks as { context: string; integration_id?: number }[] | undefined)?.find(
      (check) => check.context === 'review-gate',
    );

  it('names the new app in the rulesets, pins review-gate to it, and finds the old app’s rulesets drifted', async () => {
    STORED = { githubClientId: 'Iv23liAPPONE' };
    const { rulesets, client } = keeping();
    const config = { repoRoot: ROOT, organization: 'janedoe', gitHubClientId: '', humans: ['janedoe'], automationBot: 'flow', publicUrl: '', webhookSecret: '' };
    const setup = await subject({ api: apps, clientFor: () => client, config });

    await setup.plan();
    await setup.plan();
    // The same app twice: asked once.
    expect(asked()).toBe(1);
    await setup.applyRules('janedoe/fleetadlc-testbed');
    expect(rulesets.flatMap((ruleset) => ruleset.bypass_actors?.map((actor) => actor.actor_id) ?? [])).toEqual([111, 111]);
    expect(reviewGate(rulesets.find((ruleset) => ruleset.name === 'fleetadlc: main')!)?.integration_id).toBe(111);

    // Another app: its client id and its key, as the manifest exchange stores them.
    STORED = { githubClientId: 'Iv23liAPPTWO' };
    const { appPrivateKeyRef } = await import('@fleetadlc/github');
    SECRETS = { [appPrivateKeyRef()]: OTHER_KEY };

    const [plan] = await setup.plan();
    expect(plan?.rules.filter((one) => one.name.startsWith('fleetadlc: ')).map((one) => one.state)).toEqual(['drifted', 'drifted']);

    await setup.applyRules('janedoe/fleetadlc-testbed');
    expect(rulesets).toHaveLength(2);
    for (const ruleset of rulesets) expect(ruleset.bypass_actors?.map((actor) => actor.actor_id)).toEqual([222]);
    const main = rulesets.find((ruleset) => ruleset.name === 'fleetadlc: main');
    expect(main && reviewGate(main)?.integration_id).toBe(222);
  });

  it('asks again when only the key changed', async () => {
    const { client } = keeping();
    const setup = await subject({ api: apps, clientFor: () => client });

    await setup.plan();
    const { appPrivateKeyRef } = await import('@fleetadlc/github');
    SECRETS = { [appPrivateKeyRef()]: OTHER_KEY };
    await setup.plan();

    expect(asked()).toBe(2);
  });
});

describe('whether GitHub enforces rules anywhere this install works', () => {
  it('is false only when every repository is on a plan that refuses rulesets', async () => {
    REFUSES = new Set(['janedoe/fleetadlc-testbed']);
    expect(await (await subject()).enforcesRules()).toBe(false);
  });

  it('is true when one repository enforces them', async () => {
    REPOS = [...REPOS, { name: 'site', fullName: 'janedoe/site', defaultBranch: 'main' }];
    REFUSES = new Set(['janedoe/fleetadlc-testbed']);
    expect(await (await subject()).enforcesRules()).toBe(true);
  });

  it('reads the last plan rather than asking GitHub again', async () => {
    REFUSES = new Set(['janedoe/fleetadlc-testbed']);
    const setup = await subject();
    await setup.plan();
    const asked = CALLS.length;
    expect(await setup.enforcesRules()).toBe(false);
    expect(CALLS.length).toBe(asked);
  });

  it('plans a repository whose plan fails at most once an hour, not on every run', async () => {
    let planned = 0;
    const setup = await subject({
      readLabels: () => {
        planned += 1;
        throw new Error('labels.json is missing');
      },
    });
    const now = Date.parse('2026-09-28T12:00:00Z');
    expect(await setup.enforcesRules(now)).toBeNull();
    expect(await setup.enforcesRules(now + 10 * 60_000)).toBeNull();
    expect(planned).toBe(1);
    await setup.enforcesRules(now + 61 * 60_000);
    expect(planned).toBe(2);
  });

  it('does not know without the app key', async () => {
    SECRETS = {};
    expect(await (await subject()).enforcesRules()).toBeNull();
  });
});

describe('an environment the plan refused, remembered from the apply', () => {
  const REFUSAL =
    '→ 422: {"message":"Failed to create the environment protection rule. Please ensure the billing plan supports the required reviewers protection rule."}';

  /**
   * A private repository whose rulesets hold and whose environments refuse
   * their rules — until `holds` says the plan now holds them, or `visibility`
   * says it was made public.
   */
  function refusingEnvironments() {
    const state = { private: true, holds: false };
    const environments = new Map<string, { protection_rules: unknown[]; deployment_branch_policy: unknown }>();
    const client = {
      request: async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
        CALLS.push({ method, path, body });
        if (method === 'GET' && path.includes('/labels?')) return [] as T;
        if (method === 'GET' && path.startsWith('/users/')) return { id: 583231 } as T;
        if (method === 'GET' && path === '/repos/janedoe/fleetadlc-testbed') return { owner: { type: 'User' }, private: state.private } as T;
        if (method === 'GET' && path.endsWith('/rulesets')) return [] as T;
        // Production's reviewer is sent by GitHub user id, looked up from the login.
        if (method === 'GET' && path === '/users/janedoe') return { login: 'janedoe', id: 1001, type: 'User' } as T;
        // An environment written is then held to the default branch by its branch policies.
        if (method === 'GET' && path.includes('/deployment-branch-policies')) return { total_count: 0, branch_policies: [] } as T;
        const env = /\/environments\/([\w-]+)$/.exec(path);
        if (env && method === 'GET') {
          const found = environments.get(env[1] as string);
          if (!found) throw Object.assign(new Error('404'), { status: 404 });
          return found as T;
        }
        if (env && method === 'PUT') {
          const asked = (body ?? {}) as { reviewers?: unknown[]; deployment_branch_policy?: unknown };
          if (!state.holds && Object.keys(asked).length > 0) {
            environments.set(env[1] as string, { protection_rules: [], deployment_branch_policy: null });
            throw new Error(`${path} ${REFUSAL}`);
          }
          environments.set(env[1] as string, {
            protection_rules: (asked.reviewers ?? []).length > 0 ? [{ type: 'required_reviewers', reviewers: asked.reviewers }] : [],
            deployment_branch_policy: asked.deployment_branch_policy ?? null,
          });
          return {} as T;
        }
        if (method === 'GET') throw Object.assign(new Error('404'), { status: 404 });
        return {} as T;
      },
    };
    return { state, environments, client };
  }

  it('is the plan’s limit on the next plan, persisted with the plan state it was refused under', async () => {
    const { client } = refusingEnvironments();
    const setup = await subject({ clientFor: () => client });

    const outcomes = await setup.applyRules('janedoe/fleetadlc-testbed');
    expect(outcomes.filter((one) => one.name.startsWith('environment')).map((one) => one.action)).toEqual([
      'unsupported',
      'unsupported',
      'unsupported',
    ]);
    expect(PLAN_LIMITS.get('janedoe/fleetadlc-testbed')).toMatchObject({ private: true, rulesetsRefused: false });

    // A fresh bridge — a restart — reads the database, not a memory of its own.
    const [plan] = await (await subject({ clientFor: () => client })).plan();
    const planned = plan?.rules.filter((one) => one.name.startsWith('environment')) ?? [];
    expect(planned.map((one) => one.state)).toEqual(['unsupported', 'unsupported', 'unsupported']);
    expect(planned.every((one) => !/\/repos\/|\{/.test(one.detail))).toBe(true);
  });

  it('is forgotten once the repository is made public, so a missing reviewer shows again', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { state, client } = refusingEnvironments();
    const setup = await subject({ clientFor: () => client });
    await setup.applyRules('janedoe/fleetadlc-testbed');

    state.private = false;
    const [plan] = await setup.plan();

    // The refused PUT still created the environment, with no branch policy.
    // Forgetting the plan limit shows that drift, not an environment that is absent.
    expect(plan?.rules.find((one) => one.name === 'environment production')).toMatchObject({
      state: 'drifted',
      detail: expect.stringContaining('no branch policy'),
    });
    expect(plan?.ruleChanges).toBeGreaterThan(0);
    expect(PLAN_LIMITS.has('janedoe/fleetadlc-testbed')).toBe(false);
    log.mockRestore();
  });

  it('is forgotten by Apply again, which asks GitHub and records what it says now', async () => {
    const { state, client, environments } = refusingEnvironments();
    const setup = await subject({ clientFor: () => client });
    await setup.applyRules('janedoe/fleetadlc-testbed');

    // The plan now holds them: the same state as far as OpenADLC can read it.
    state.holds = true;
    const outcomes = await setup.applyRules('janedoe/fleetadlc-testbed', { force: true });

    expect(outcomes.filter((one) => one.name.startsWith('environment')).map((one) => one.action)).toEqual(['created', 'created', 'created']);
    expect(PLAN_LIMITS.has('janedoe/fleetadlc-testbed')).toBe(false);
    expect(environments.get('production')?.protection_rules).toEqual([expect.objectContaining({ type: 'required_reviewers' })]);
  });

  it('keeps the production limit when GitHub does not say whether the plan changed', async () => {
    PLAN_LIMITS.set('janedoe/fleetadlc-testbed', {
      limits: [{ name: 'environment production', detail: 'the plan refused a reviewer' }],
      private: true,
      rulesetsRefused: false,
    });
    const failing = () => ({
      request: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
        if (method === 'GET' && path.endsWith('/rulesets')) throw new Error(`${path} → 502`);
        if (method === 'GET' && path.endsWith('/environments/production')) {
          return { protection_rules: [], deployment_branch_policy: null } as T;
        }
        return repoClient().request<T>(method, path, body);
      },
    });

    const [plan] = await (await subject({ clientFor: failing })).plan();

    expect(plan?.rules.find((one) => one.name === 'environment production')?.state).toBe('unsupported');
    expect(PLAN_LIMITS.has('janedoe/fleetadlc-testbed')).toBe(true);
  });

  it('keeps the production limit when an apply skips production instead of proving the plan holds a reviewer', async () => {
    const { recordPlanLimits } = await import('./repo-setup.js');
    PLAN_LIMITS.set('exampleco/app', { limits: [{ name: 'environment production', detail: 'plan' }] });

    await recordPlanLimits({} as never, 'exampleco/app', [
      { name: 'environment production', action: 'skipped', detail: 'nobody is named to approve production' },
    ]);

    expect(PLAN_LIMITS.has('exampleco/app')).toBe(true);
  });

  it('leaves an environment that is not there at all a change, and anything the apply did not refuse alone', async () => {
    const { withPlanLimits } = await import('./repo-setup.js');
    const limits = [
      { name: 'environment testing', detail: 'the plan' },
      { name: 'environment production', detail: 'the plan' },
    ];

    const rules = withPlanLimits(
      [
        { name: 'environment testing', state: 'missing', detail: 'the environment does not exist' },
        { name: 'environment production', state: 'drifted', detail: 'no branch policy' },
        { name: 'fleetadlc: main', state: 'missing', detail: 'no ruleset by this name' },
      ],
      limits,
    );

    expect(rules.map((one) => one.state)).toEqual(['missing', 'unsupported', 'missing']);
    expect(rules[1]?.detail).toBe('the plan');
  });
});

describe('the labels setting up a repository writes', () => {
  // config/labels.json is written into every repository an install manages.
  // OpenADLC's own component areas there filed someone else's issues under
  // `area:bridge` and `area:hostd`; those live in config/labels-fleetadlc.json.
  const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

  it('have one area, area:general, and OpenADLC’s own areas are in a file of their own', async () => {
    const { readFileSync } = await import('node:fs');
    const read = (file: string) => (JSON.parse(readFileSync(`${ROOT}config/${file}`, 'utf8')) as { name: string }[]).map((label) => label.name);

    expect(read('labels.json').filter((name) => name.startsWith('area:'))).toEqual(['area:general']);
    expect(read('labels-fleetadlc.json')).toEqual([
      'area:console',
      'area:bridge',
      'area:hostd',
      'area:dispatcher',
      'area:engines',
      'area:auth',
      'area:db',
      'area:cli',
      'area:skills',
      'area:infra',
      'area:docs',
    ]);
  });
});

describe('who approves production', () => {
  const NOBODY_SET = { repoRoot: '/nowhere', organization: 'exampleco', gitHubClientId: 'Iv23liTEST', humans: [], automationBot: 'flow', publicUrl: '', webhookSecret: '' };

  /** An organization's repository whose admins GitHub lists as `admins`, and the users GitHub knows. */
  function orgRepo(admins: string[]) {
    return {
      request: async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
        CALLS.push({ method, path, body });
        if (method === 'GET' && path.includes('/labels?')) return [] as T;
        if (method === 'GET' && path.includes('/collaborators?permission=admin')) return admins.map((login) => ({ login, type: 'User' })) as T;
        const user = /^\/users\/(.+)$/.exec(path);
        if (method === 'GET' && user) return { id: user[1] === 'alex-maintainer' ? 77120 : 1 } as T;
        if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+$/.test(path)) return { private: false, owner: { login: 'exampleco', type: 'Organization' } } as T;
        if (method === 'GET' && path.endsWith('/rulesets')) return [] as T;
        if (method === 'GET') throw Object.assign(new Error('404'), { status: 404 });
        return {} as T;
      },
    };
  }

  it('names CODEOWNERS’ approvers on production, by numeric id, when the install names nobody', async () => {
    const setup = await subject({ config: NOBODY_SET, clientFor: () => orgRepo(['alex-maintainer', 'exampleco']) });

    const [plan] = await setup.plan();
    expect(plan?.production).toMatchObject({ approval: 'reviewers', reviewers: ['alex-maintainer'] });
    expect(plan?.needsProductionReviewer).toBe(false);

    await setup.applyRules('janedoe/fleetadlc-testbed');
    const production = CALLS.filter((call) => call.method === 'PUT' && call.path.endsWith('/environments/production'));
    expect(production.map((call) => (call.body as { reviewers?: unknown }).reviewers)).toEqual([[{ type: 'User', id: 77120 }]]);
  });

  it('asks before it applies when production’s rules say a person approves and nobody can be named', async () => {
    const setup = await subject({ config: NOBODY_SET, clientFor: () => orgRepo([]) });

    const [plan] = await setup.plan();
    expect(plan?.production).toMatchObject({ approval: 'reviewers', reviewers: [] });
    expect(plan?.needsProductionReviewer).toBe(true);
  });

  it('needs nobody where production ships automatically, and says when the file sets that', async () => {
    const setup = await subject({
      config: NOBODY_SET,
      clientFor: () => orgRepo([]),
      production: async () => ({ approval: 'auto', soakMinutes: 30, governedByFile: true }),
    });

    const [plan] = await setup.plan();
    expect(plan?.production).toEqual({ approval: 'auto', soakMinutes: 30, reviewers: [], governedByFile: true });
    expect(plan?.needsProductionReviewer).toBe(false);
  });
});
