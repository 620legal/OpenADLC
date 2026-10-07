import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubApiError, appPrivateKeyRef, appRuleFields, mainRuleset, type AppApi, type ApplyOutcome, type RepoRulesInput } from '@fleetadlc/github';
import { REQUIRED_CHECK, REVIEW_GATE_CHECK } from '@fleetadlc/shared';
import { defaultConfig, type InstallConfig } from '../install.js';
import { credentialFailure, githubApply, productionFromFlags, repositoryAccessLine, rulesHumans, rulesInputFor, syncLabels, templateProblem } from './github.js';

describe('a repository template that is not as it should be', () => {
  it('says drifted for a file that is there, and missing only for one that is not', () => {
    expect(templateProblem({ name: 'AGENTS.md', state: 'drifted', detail: 'still names the template’s @owner' })).toBe(
      'drifted: AGENTS.md — still names the template’s @owner',
    );
    expect(templateProblem({ name: 'Makefile', state: 'missing', detail: 'hostd runs `make setup`' })).toBe('missing: Makefile — hostd runs `make setup`');
  });
});

/**
 * The commands against a database and a GitHub that are only what each test
 * says they are. `rulesHumans` below needs neither.
 */
const world = vi.hoisted(() => ({
  repos: [] as { id?: string; name: string; fullName: string; defaultBranch: string | null }[],
  crew: [] as { id?: string; name: string; slot: string; role: string; githubLogin: string | null }[],
  /** The secret namespace of the account each seat is on, by seat id: seats on one account share it. */
  identities: new Map<string, string>(),
  settings: {} as Record<string, string>,
  secrets: new Map<string, string>(),
  /** Every request, with who it was made as: `fleetadlc-app`, or the account's login. */
  requests: [] as { method: string; path: string; body?: unknown; as?: string }[],
  respond: (_method: string, _path: string): unknown => [],
  templates: [] as { fullName: string; root: string; approvers?: readonly string[] }[],
  templateOutcomes: [] as { name: string; action: string; detail: string }[],
  /** What the bridge's token route does: answer, or nothing listening. */
  bridge: null as null | ((bot: string) => { status: number; body: unknown }),
  /** Refreshes done here, by the client id each was done with and whether under the lock. */
  refreshed: [] as { bot: string; clientId: string; locked: boolean }[],
  locked: false,
  /** The advisory lock keys taken here, in order. */
  lockKeys: [] as string[],
  /** Each repository's recorded production choice, by id, and what each apply was given. */
  choices: new Map<string, { approval: 'auto' | 'reviewers' | null; soakMinutes: number | null; reviewers: string[] }>(),
  applied: [] as { productionReviewers: string[]; production?: { approval: string; soakMinutes: number }; appId?: number; pinnedChecks?: string[] }[],
  /** Who each apply wrote as. */
  appliedAs: [] as string[],
  /** The real `applyRepoRules`, against `respond`, instead of the stand-in. */
  realApply: false,
  /** What the stand-in apply reports, when `realApply` is off. */
  ruleOutcomes: [] as ApplyOutcome[],
  /** Repositories whose remembered plan limit an apply cleared. */
  cleared: [] as string[],
}));

vi.mock('@fleetadlc/db', () => ({
  audit: async () => undefined,
  bots: { listBots: async () => world.crew },
  identities: {
    identityOfBot: async (id: string) => {
      const secretNs = world.identities.get(id);
      return secretNs ? { id: `identity-${secretNs}`, login: 'alice-crew', githubUserId: 1, secretNs } : null;
    },
  },
  repos: {
    listRepos: async () => world.repos,
    clearPlanLimits: async (name: string) => {
      world.cleared.push(name);
      return true;
    },
    getDelivery: async () => null,
    setPlanLimits: async () => undefined,
    getProductionChoice: async (id: string) => world.choices.get(id) ?? { approval: null, soakMinutes: null, reviewers: [] },
    setProductionChoice: async (id: string, choice: { approval: 'auto' | 'reviewers'; soakMinutes: number; reviewers: string[] }) =>
      void world.choices.set(id, choice),
  },
  settings: {
    allSettings: async () => world.settings,
    getSetting: async (key: string) => world.settings[key] ?? null,
  },
  closePool: async () => undefined,
  waitForDatabase: async () => undefined,
  withAdvisoryLock: async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    world.lockKeys.push(key);
    world.locked = true;
    try {
      return await fn();
    } finally {
      world.locked = false;
    }
  },
}));

vi.mock('@fleetadlc/github', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fleetadlc/github')>();
  class FakeClient {
    constructor(readonly options: { token: string; actingAs: string }) {}
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      world.requests.push({ method, path, body, as: this.options.actingAs });
      return world.respond(method, path) as T;
    }
    async readFileIfPresent(): Promise<null> {
      return null;
    }
  }
  class FakeBroker {
    constructor(readonly options: { clientId: () => Promise<string>; exclusive?: <T>(key: string, fn: () => Promise<T>) => Promise<T> }) {}
    async tokenFor(bot: string, login: string) {
      const mint = async () => {
        world.refreshed.push({ bot, clientId: await this.options.clientId(), locked: world.locked });
        return { token: 'a-refreshed-token', expiresAt: null, login };
      };
      return this.options.exclusive ? this.options.exclusive(`github-refresh:${bot}`, mint) : mint();
    }
  }
  return {
    ...actual,
    GitHubClient: FakeClient,
    TokenBroker: FakeBroker,
    getSecretStore: () => ({
      get: async (ref: string) => world.secrets.get(ref) ?? null,
      set: async (ref: string, value: string) => void world.secrets.set(ref, value),
      delete: async (ref: string) => void world.secrets.delete(ref),
      list: async () => [...world.secrets.keys()],
    }),
    applyRepoRules: async (client: never, input: (typeof world.applied)[number]): Promise<ApplyOutcome[]> => {
      world.applied.push(input);
      world.appliedAs.push((client as { options: { actingAs: string } }).options.actingAs);
      return world.realApply ? actual.applyRepoRules(client, input as never) : world.ruleOutcomes;
    },
    applyRepoTemplates: async (_client: unknown, input: { fullName: string; root: string; approvers?: readonly string[] }) => {
      world.templates.push(input);
      return world.templateOutcomes;
    },
  };
});

let checkout = '';
let config: InstallConfig;
const printed: string[] = [];
const exitCodeBefore = process.exitCode;

beforeEach(async () => {
  checkout = mkdtempSync(join(tmpdir(), 'fleetadlc-github-'));
  mkdirSync(join(checkout, 'config'));
  writeFileSync(join(checkout, 'config', 'labels.json'), JSON.stringify([{ name: 'adlc:build', color: '0e8a16', description: 'Being built' }]));
  config = { ...defaultConfig(checkout), humans: [] };
  world.repos = [{ name: 'app', fullName: 'alice/app', defaultBranch: 'main' }];
  world.crew = [{ name: 'automation', slot: 'automation', role: 'automation', githubLogin: 'alice-automation' }];
  world.settings = {};
  world.secrets = new Map();
  world.identities = new Map();
  const { accessTokenRef } = await import('@fleetadlc/github');
  world.secrets.set(accessTokenRef('automation'), 'a-static-token');
  world.requests = [];
  world.respond = () => [];
  world.templates = [];
  world.templateOutcomes = [];
  world.bridge = null;
  world.refreshed = [];
  world.lockKeys = [];
  world.choices = new Map();
  world.applied = [];
  world.appliedAs = [];
  world.realApply = false;
  world.ruleOutcomes = [];
  world.cleared = [];
  printed.length = 0;
  vi.spyOn(console, 'log').mockImplementation((line: string) => void printed.push(String(line)));
  // Never this machine's own bridge: nothing listens unless a test says so.
  vi.stubGlobal('fetch', async (url: string) => {
    const bot = decodeURIComponent(String(url).split('/internal/tokens/')[1] ?? '');
    if (!world.bridge) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const { status, body } = world.bridge(bot);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(checkout, { recursive: true, force: true });
  process.exitCode = exitCodeBefore;
});

describe('fleetadlc github sync-labels', () => {
  const created = () => world.requests.filter((one) => one.method === 'POST').map((one) => (one.body as { name: string }).name);

  it('writes config/labels.json when no file is named', async () => {
    await syncLabels(config, {});

    expect(created()).toEqual(['adlc:build']);
  });

  it('writes the file --file names, read from the checkout, to the one repository --repo names', async () => {
    // OpenADLC's own component areas, which only OpenADLC's repository gets.
    writeFileSync(join(checkout, 'config', 'labels-fleetadlc.json'), JSON.stringify([{ name: 'area:bridge', color: '1d76db', description: 'The bridge' }]));
    world.repos = [...world.repos, { name: 'fleetadlc', fullName: 'alice/fleetadlc', defaultBranch: 'main' }];

    await syncLabels(config, { repo: 'fleetadlc', file: 'config/labels-fleetadlc.json' });

    expect(created()).toEqual(['area:bridge']);
    expect(world.requests.filter((one) => one.method === 'POST').map((one) => one.path)).toEqual(['/repos/alice/fleetadlc/labels']);
  });

  it('changes nothing on a repository whose labels could not be read, and says so', async () => {
    // An unread list was planned as an empty one: every label was "created"
    // beside the ones the repository has.
    world.respond = (method, path) => {
      if (method === 'GET' && path.includes('/labels?')) throw new Error('GET /repos/alice/app/labels → 502');
      return {};
    };
    await syncLabels(config, {});

    expect(world.requests.filter((one) => one.method !== 'GET')).toEqual([]);
    expect(printed.join('\n')).toMatch(/could not read its labels, so none were changed: .*502/);
    expect(process.exitCode).toBe(1);
  });

  it('renames a legacy label it finds past the first page, rather than creating its new name beside it', async () => {
    const filler = Array.from({ length: 100 }, (_, i) => ({ name: `theirs-${i}`, color: 'ededed', description: null }));
    world.respond = (method, path) => {
      if (method !== 'GET') return {};
      if (path.endsWith('&page=1')) return filler;
      if (path.endsWith('&page=2')) return [{ name: 'sdlc:build', color: '0e8a16', description: 'Being built' }];
      return [];
    };
    await syncLabels(config, {});

    const writes = world.requests.filter((one) => one.method !== 'GET');
    expect(writes.map((one) => `${one.method} ${one.path}`)).toEqual(['PATCH /repos/alice/app/labels/sdlc%3Abuild']);
  });
});

describe('the automation account’s token', () => {
  it('comes from the bridge when it answers, whatever this machine’s store holds', async () => {
    world.secrets = new Map();
    world.bridge = () => ({ status: 200, body: { token: 'from-the-bridge', expiresAt: null, login: 'alice-automation' } });
    await syncLabels(config, {});

    expect(world.refreshed).toEqual([]);
    expect(process.exitCode).toBe(exitCodeBefore);
  });

  it('is not refreshed here when the bridge answers with an error, and the error is said', async () => {
    // A refusal was read as "not answering", and the token was refreshed here
    // beside the bridge: a replay, and GitHub revokes the sign-in.
    const { refreshTokenRef } = await import('@fleetadlc/github');
    world.secrets.set(refreshTokenRef('automation'), 'a-refresh-token');
    world.settings = { githubClientId: 'Iv1.zzz-stored-zzz' };
    world.bridge = (bot) => ({ status: 409, body: { error: `${bot}'s GitHub authorization is no longer valid (bad_refresh_token)` } });
    await syncLabels(config, {});

    expect(world.refreshed).toEqual([]);
    expect(printed.join('\n')).toContain("the bridge refused: automation's GitHub authorization is no longer valid (bad_refresh_token)");
    expect(printed.join('\n')).not.toContain('not answering');
    expect(process.exitCode).toBe(1);
  });

  it('is not refreshed here when the bridge has no sign-in for it, and says to sign in', async () => {
    const { refreshTokenRef } = await import('@fleetadlc/github');
    world.secrets.set(refreshTokenRef('automation'), 'a-refresh-token');
    world.settings = { githubClientId: 'Iv1.zzz-stored-zzz' };
    world.bridge = (bot) => ({ status: 404, body: { error: `${bot} has no GitHub login` } });
    await syncLabels(config, {});

    expect(world.refreshed).toEqual([]);
    expect(world.lockKeys).toEqual([]);
    expect(printed.join('\n')).toContain('the bridge refused: automation has no GitHub login');
    expect(printed.join('\n')).toContain('fleetadlc auth login --bot automation');
    expect(printed.join('\n')).not.toContain('not answering');
    expect(process.exitCode).toBe(1);
  });

  it('is refreshed here only when the bridge is down, under the bridge’s lock, with the client id the console stored', async () => {
    // install.json has none on an install set up from the console, and the
    // command used to say the account was not connected.
    const { refreshTokenRef } = await import('@fleetadlc/github');
    world.secrets.set(refreshTokenRef('automation'), 'a-refresh-token');
    world.settings = { githubClientId: 'Iv1.zzz-stored-zzz' };
    await syncLabels({ ...config, githubClientId: '' }, {});

    expect(world.refreshed).toEqual([{ bot: 'automation', clientId: 'Iv1.zzz-stored-zzz', locked: true }]);
    expect(world.lockKeys).toEqual(['github-refresh:automation']);
    expect(printed.join('\n')).toContain('the bridge is not answering; refreshing this token directly');
  });

  it('says to start the install, not to sign in again, when the bridge is down and there is no client id', async () => {
    const { refreshTokenRef } = await import('@fleetadlc/github');
    world.secrets.set(refreshTokenRef('automation'), 'a-refresh-token');
    await syncLabels({ ...config, githubClientId: '' }, {});

    expect(world.refreshed).toEqual([]);
    expect(printed.join('\n')).toContain('the bridge is not answering, and this install has no GitHub App client id to refresh the token with');
    expect(printed.join('\n')).toContain('start the bridge: fleetadlc up');
    expect(printed.join('\n')).not.toContain('auth login');
    expect(process.exitCode).toBe(1);
  });
});

describe('the automation account’s token on an account the crew shares', () => {
  // The sign-in is filed under the account's namespace, not each seat's name:
  // looked up under the seat's, every command said "not connected", and
  // `fleetadlc auth login` did not fix it.
  beforeEach(() => {
    world.crew = [{ id: 'seat-automation', name: 'automation', slot: 'automation', role: 'automation', githubLogin: 'alice-crew' }];
    world.identities.set('seat-automation', 'crew-account');
    world.secrets = new Map();
  });

  it('asks the bridge first, by the seat’s name, before anything is refreshed here', async () => {
    const asked: string[] = [];
    const { refreshTokenRef } = await import('@fleetadlc/github');
    world.secrets.set(refreshTokenRef('crew-account'), 'a-refresh-token');
    world.bridge = (bot) => {
      asked.push(bot);
      return { status: 200, body: { token: 'from-the-bridge', expiresAt: null, login: 'alice-crew' } };
    };
    await syncLabels(config, {});

    expect(asked).toEqual(['automation']);
    expect(world.refreshed).toEqual([]);
    expect(process.exitCode).toBe(exitCodeBefore);
  });

  it('finds the shared refresh token with the bridge down, and refreshes it under the account’s name', async () => {
    const { refreshTokenRef } = await import('@fleetadlc/github');
    world.secrets.set(refreshTokenRef('crew-account'), 'a-refresh-token');
    world.settings = { githubClientId: 'Iv1.zzz-stored-zzz' };
    await syncLabels(config, {});

    expect(world.refreshed).toEqual([{ bot: 'crew-account', clientId: 'Iv1.zzz-stored-zzz', locked: true }]);
    // The key the bridge's broker takes for this sign-in (`signInOf`), not the seat's.
    expect(world.lockKeys).toEqual(['github-refresh:crew-account']);
    expect(printed.join('\n')).not.toContain('not connected');
  });

  it('finds a shared static token with the bridge down', async () => {
    const { accessTokenRef } = await import('@fleetadlc/github');
    world.secrets.set(accessTokenRef('crew-account'), 'a-static-token');
    await syncLabels(config, {});

    expect(printed.join('\n')).not.toContain('not connected');
    expect(process.exitCode).toBe(exitCodeBefore);
  });

  it('is still not connected when nothing is stored anywhere and the bridge is down', async () => {
    await syncLabels(config, {});

    expect(printed.join('\n')).toContain('not connected');
    expect(process.exitCode).toBe(1);
  });
});

describe('fleetadlc github apply', () => {
  it('names a personal repository’s owner in AGENTS.md, and reads the templates from the checkout', async () => {
    // The owner filter meant for an organization's name dropped the person who
    // owns a personal repository, and AGENTS.md kept the template's @owner.
    world.settings = { humans: 'alice' };
    await githubApply(config);

    expect(world.templates).toEqual([{ fullName: 'alice/app', root: checkout, approvers: ['alice'] }]);
    expect(printed.join('\n')).not.toMatch(/nobody to name/);
  });

  it('warns and fails for a template it could not write', async () => {
    world.settings = { humans: 'alice' };
    world.templateOutcomes = [
      { name: 'Makefile', action: 'created', detail: 'what a task runs first' },
      { name: 'AGENTS.md', action: 'skipped', detail: 'not written: ENOENT' },
    ];
    await githubApply(config);

    expect(printed.some((line) => line.includes('!') && line.includes('AGENTS.md — not written: ENOENT'))).toBe(true);
    expect(process.exitCode).toBe(1);
  });
});

describe('how production ships, from fleetadlc github apply', () => {
  beforeEach(() => {
    world.repos = [{ id: 'repo-1', name: 'app', fullName: 'acme/app', defaultBranch: 'main' }];
    world.settings = { organization: 'acme' };
  });

  it('refuses --production reviewers without --reviewer, before anything is asked of GitHub', async () => {
    expect(productionFromFlags({ production: 'reviewers' })).toEqual({ refused: expect.stringContaining('--reviewer <login>') });
    await githubApply(config, { production: 'reviewers' });

    expect(printed.join('\n')).toContain('--production reviewers names who approves');
    expect(process.exitCode).toBe(2);
    expect(world.applied).toEqual([]);
  });

  it('records the choice the flags make, and builds production from it', async () => {
    expect(productionFromFlags({ production: 'auto', soak: '45' })).toEqual({ choice: { approval: 'auto', soakMinutes: 45, reviewers: [] } });
    expect(productionFromFlags({ production: 'auto', soak: 'soon' })).toMatchObject({ refused: expect.stringContaining('--soak') });

    await githubApply(config, { production: 'reviewers', reviewers: ['@ada,grace'] });

    expect(world.choices.get('repo-1')).toEqual({ approval: 'reviewers', soakMinutes: 0, reviewers: ['ada', 'grace'] });
    expect(world.applied[0]).toMatchObject({ productionReviewers: ['ada', 'grace'], production: { approval: 'reviewers' } });
  });

  it('forgets a plan limit once an apply writes production, and keeps it when that step was skipped', async () => {
    world.ruleOutcomes = [{ name: 'environment production', action: 'created', detail: '' }];
    await githubApply(config);
    expect(world.cleared).toEqual(['acme/app']);

    world.cleared = [];
    world.ruleOutcomes = [{ name: 'environment production', action: 'skipped', detail: 'nobody is named to approve production' }];
    await githubApply(config);
    expect(world.cleared).toEqual([]);
  });

  it('says why production was left unchanged: the login it could not resolve is the person’s to fix', async () => {
    const detail = 'keeps the required reviewer it already holds: could not resolve ad4 to a GitHub user to replace it: 404 Not Found';
    world.ruleOutcomes = [
      { name: 'environment production', action: 'unchanged', detail },
      { name: 'environment testing', action: 'unchanged', detail: '' },
    ];
    await githubApply(config);

    const said = printed.join('\n');
    expect(said).toContain(`environment production unchanged — ${detail}`);
    expect(said).toMatch(/environment testing unchanged(?! —)/);
  });

  it('uses the automatic default where nobody is at a terminal, says so, and records nothing', async () => {
    await githubApply(config);

    expect(printed.join('\n')).toContain('ships automatically after a 30-minute soak on testing');
    expect(world.choices.has('repo-1')).toBe(false);
    expect(world.applied[0]?.production).toEqual({ approval: 'auto', soakMinutes: 30 });
  });

  it('no longer creates production with an empty reviewer list when nobody is configured', async () => {
    // A repository that was here before the default changed: reviewers, as the migration recorded.
    world.choices.set('repo-1', { approval: 'reviewers', soakMinutes: 0, reviewers: [] });
    world.realApply = true;
    world.respond = (method, path) => {
      if (method === 'GET' && path === '/repos/acme/app') return { private: false, owner: { login: 'acme', type: 'Organization' } };
      if (method === 'GET' && (path.endsWith('/rulesets') || path.includes('/collaborators'))) return [];
      if (method === 'GET') throw new Error(`${path} → 404: {"message":"Not Found"}`);
      return {};
    };
    await githubApply(config);

    const said = printed.join('\n');
    expect(said).not.toContain('created environment production');
    expect(said).toContain('Choose who approves production in repository setup');
    const puts = world.requests.filter((call) => call.method === 'PUT' && call.path.endsWith('/environments/production'));
    expect(puts.some((call) => Array.isArray((call.body as { reviewers?: unknown }).reviewers))).toBe(false);
  });
});

describe('the person the repository rules name', () => {
  it('is nobody the install did not name: with none configured it stops and says what to set', () => {
    // This fell back to the original author's GitHub handle, so every install
    // that configured nobody made that account the owner of its config/ and
    // infra/. Throwing is the proof there is no fallback: nothing is returned.
    const nobody = { stored: {}, environment: undefined, organization: '' };

    expect(() => rulesHumans(nobody)).toThrow(/"humans" in .*install\.json/);
    expect(() => rulesHumans(nobody)).toThrow(/FLEETADLC_HUMANS=/);
    // Blank is not a name either.
    expect(() => rulesHumans({ stored: { humans: '' }, environment: ' , ', organization: '  ' })).toThrow(/FLEETADLC_HUMANS/);
  });

  it('is the first of the install’s humans, and every one of them may approve production', () => {
    expect(rulesHumans({ stored: {}, environment: 'ada, grace', organization: 'acme' })).toEqual({
      human: 'ada',
      humans: ['ada', 'grace'],
    });
  });

  it('comes from the console’s setting before the environment, as the bridge reads it', () => {
    expect(rulesHumans({ stored: { humans: 'linus' }, environment: 'ada', organization: '' })).toEqual({
      human: 'linus',
      humans: ['linus'],
    });
  });

  it('is the organization when no humans are named, which on a personal account is its owner', () => {
    expect(rulesHumans({ stored: {}, environment: '', organization: 'ada' })).toEqual({ human: 'ada', humans: [] });
    // The console's organization, when it has one, as for the humans.
    expect(rulesHumans({ stored: { organization: 'grace' }, environment: '', organization: 'ada' }).human).toBe('grace');
  });
});

describe('the rules `github check` and `github apply` build', () => {
  // The CLI built them without the app: `check` called every repository the
  // console had protected drifted, and `apply` wrote its ruleset back with no
  // bypass and a review gate any crew account could set.
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const app: AppApi = {
    request: async <T>(method: string, path: string): Promise<T> => {
      if (method === 'GET' && path === '/app') return { id: 4242, permissions: { checks: 'write' } } as T;
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  const repo = { fullName: 'alice/app', defaultBranch: 'main' };

  it('are the bridge’s, with the app as bypass actor and review-gate pinned to it', async () => {
    world.secrets.set(appPrivateKeyRef(), privateKey);
    world.crew = [
      { name: 'automation', slot: 'automation', role: 'automation', githubLogin: 'alice-automation' },
      { name: 'reviewer', slot: 'reviewer', role: 'review_lead', githubLogin: 'alice-reviews' },
    ];
    const withClient = { ...config, githubClientId: 'Iv23liTEST', humans: ['alice'] };
    const humansBefore = process.env.FLEETADLC_HUMANS;
    process.env.FLEETADLC_HUMANS = 'alice';
    try {
      const { input: cli } = await rulesInputFor(withClient, repo, null, app);
      // As `RepoSetup.rulesInput` in the bridge builds it, for the same app and crew.
      const bridge: RepoRulesInput = {
        fullName: repo.fullName,
        defaultBranch: 'main',
        requiredChecks: [REQUIRED_CHECK, REVIEW_GATE_CHECK],
        leadReviewer: 'alice-reviews',
        crew: ['alice-automation', 'alice-reviews'],
        humans: ['alice'],
        productionReviewers: ['alice'],
        ...(await appRuleFields(app, { clientId: 'Iv23liTEST', privateKey })),
      };

      expect(cli.crew).toEqual(bridge.crew);
      const ruleset = mainRuleset(cli);
      expect(ruleset).toEqual(mainRuleset(bridge));
      expect(ruleset.bypass_actors).toEqual([{ actor_id: 4242, actor_type: 'Integration', bypass_mode: 'always' }]);
      const checks = ruleset.rules.find((rule) => rule.type === 'required_status_checks')?.parameters?.required_status_checks;
      expect(checks).toContainEqual({ context: REVIEW_GATE_CHECK, integration_id: 4242 });
    } finally {
      if (humansBefore === undefined) delete process.env.FLEETADLC_HUMANS;
      else process.env.FLEETADLC_HUMANS = humansBefore;
    }
  });

  it('carry no app id without the app’s key on this machine, which leaves the app’s rulesets to the console', async () => {
    const { input } = await rulesInputFor({ ...config, githubClientId: 'Iv23liTEST', humans: ['alice'], organization: 'alice' }, repo, null, app);
    expect(input.appId).toBeUndefined();
    expect(input.pinnedChecks).toEqual([]);
  });
});

describe('who writes labels and rules from the terminal', () => {
  // As the automation account, which an organization's repository gives
  // triage: it may put a label on an issue but not create or rename one, so
  // every create and the sdlc: to adlc: rename failed, a warning per label.
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const installed = (installedOn: string[]) => (method: string, path: string): unknown => {
    const repo = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(path)?.[1];
    if (method === 'GET' && repo) {
      if (installedOn.includes(repo)) return { id: 7 };
      throw new Error(`GET ${path} → 404: {"message":"Not Found"}`);
    }
    if (method === 'POST' && path === '/app/installations/7/access_tokens') return { token: 'ghs_not-printed' };
    if (method === 'GET' && path === '/app') return { id: 4242, permissions: { checks: 'write' } };
    return [];
  };
  const labelWrites = () => world.requests.filter((one) => one.method === 'POST' && one.path.endsWith('/labels'));

  beforeEach(() => {
    world.secrets.set(appPrivateKeyRef(), privateKey);
    // The console's, which wins over install.json's.
    world.settings = { githubClientId: 'Iv23liSTORED' };
  });

  it('is the app, with a token for that repository, when this machine holds its key', async () => {
    world.respond = installed(['alice/app']);
    await syncLabels({ ...config, githubClientId: 'Iv1.old-install-json' }, {});

    expect(labelWrites().map((one) => one.as)).toEqual(['fleetadlc-app']);
    const minted = world.requests.find((one) => one.path === '/app/installations/7/access_tokens');
    expect(minted?.body).toEqual({ repositories: ['app'] });
    const said = printed.join('\n');
    expect(said).toContain('alice/app, as the OpenADLC app');
    expect(said).not.toContain('ghs_not-printed');
    expect(process.exitCode).toBe(exitCodeBefore);
  });

  it('is the automation account without the app’s key, and says so', async () => {
    world.secrets.delete(appPrivateKeyRef());
    await syncLabels(config, {});

    expect(labelWrites().map((one) => one.as)).toEqual(['alice-automation']);
    const said = printed.join('\n');
    expect(said).toContain('alice/app, as alice-automation, the automation account (no app key held)');
    expect(said).toContain('holds no key for the OpenADLC app');
  });

  it('fails a repository the app is not installed on, says what to do, and carries on with the rest', async () => {
    world.repos = [...world.repos, { name: 'other', fullName: 'alice/other', defaultBranch: 'main' }];
    world.respond = installed(['alice/other']);
    await syncLabels(config, {});

    expect(labelWrites().map((one) => one.path)).toEqual(['/repos/alice/other/labels']);
    const said = printed.join('\n');
    expect(said).toMatch(/alice\/app: the OpenADLC app could not act on it: .*404/);
    expect(said).toContain('install the app on this repository');
    expect(said).toContain('console’s repository setup');
    expect(process.exitCode).toBe(1);
  });

  it('writes the rules as the app, naming it as the bypass actor with review-gate pinned to it', async () => {
    world.respond = installed(['alice/app']);
    world.settings = { ...world.settings, humans: 'alice' };
    await githubApply(config, { production: 'auto' });

    expect(world.appliedAs).toEqual(['fleetadlc-app']);
    expect(world.applied[0]).toMatchObject({ appId: 4242, pinnedChecks: [REVIEW_GATE_CHECK] });
    expect(printed.join('\n')).toContain('alice/app, as the OpenADLC app');
  });

  it('writes the rules as the automation account without the app’s key', async () => {
    world.secrets.delete(appPrivateKeyRef());
    world.settings = { ...world.settings, humans: 'alice' };
    await githubApply(config, { production: 'auto' });

    expect(world.appliedAs).toEqual(['alice-automation']);
  });
});

describe('what `github check` says about the automation account’s access', () => {
  it('calls triage what it is, not read only: labels go on issues, and the app writes the rest', () => {
    const line = repositoryAccessLine('acme/app', { triage: true, push: false, pull: true }, true);
    expect(line.ok).toBe(true);
    expect(line.text).not.toContain('read only');
    expect(line.text).toContain('may apply labels');
    expect(line.text).toContain('done as the app');
  });

  it('warns about triage without the app’s key, where sync-labels and apply will fail', () => {
    const line = repositoryAccessLine('acme/app', { triage: true, push: false }, false);
    expect(line.ok).toBe(false);
    expect(line.text).not.toContain('read only');
    expect(line.text).toContain('sync-labels and apply will fail');
  });

  it('still warns about an account with pull access only', () => {
    expect(repositoryAccessLine('acme/app', { pull: true }, true).ok).toBe(false);
    expect(repositoryAccessLine('acme/app', { push: true }, false)).toEqual({ ok: true, text: 'acme/app reachable, write access' });
  });
});

describe('when GitHub will not say who the automation account is', () => {
  // Both a refused credential and an unreachable GitHub said "the stored
  // credential was rejected by GitHub", with no remedy.
  it('says to sign in again when GitHub refused the credential', () => {
    expect(credentialFailure(new GitHubApiError(401, '/user', '{"message":"Bad credentials"}'), 'janedoe-crew')).toEqual({
      reason: 'GitHub refused janedoe-crew’s stored credential',
      hint: 'fleetadlc auth login --bot janedoe-crew',
    });
  });

  it('does not send anyone to sign in again when GitHub was not reached', () => {
    const said = credentialFailure(new TypeError('fetch failed'), 'janedoe-crew');
    expect(said.reason).toBe('could not ask GitHub who janedoe-crew is: fetch failed');
    expect(said.hint).not.toContain('auth login');
  });
});
