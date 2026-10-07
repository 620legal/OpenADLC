import { REQUIRED_CHECK, REVIEW_GATE_CHECK } from '@fleetadlc/shared';
import { describe, expect, it } from 'vitest';
import { GitHubApiError } from './client.js';
import { codeownersRepair,
  APP_UNKNOWN_DETAIL,
  AGENT_BRANCHES_RULESET,
  applyRepoRules,
  checkRepoRules,
  codeownersBody,
  enforcesRulesets,
  ENVIRONMENT_ABSENT,
  everythingOwners,
  githubSaid,
  listLabels,
  MAIN_RULESET,
  NO_PRODUCTION_REVIEWER,
  PLAN_LIMITS_ENVIRONMENTS,
  PLAN_LIMITS_REVIEWER,
  reviewerRefusedByPlan,
  mainRuleset,
  staleCodeOwner,
  withCodeOwner,
  productionWaitTimer,
  repositoryPlanState,
  PLAN_REFUSES_RULESETS,
  rulesAppliedPayload,
  repairedRuleset,
  rulesetDrift,
  agentBranchesRuleset,
  type RepoRulesInput,
  type RuleApi,
} from './rules.js';

const INPUT: RepoRulesInput = {
  fullName: 'exampleco/FleetADLC',
  defaultBranch: 'main',
  // The names GitHub actually publishes; `checks.ts` is where they are stated.
  requiredChecks: [REQUIRED_CHECK, REVIEW_GATE_CHECK],
  leadReviewer: 'fleetadlc-sydney',
  humans: ['janedoe'],
  productionReviewers: ['janedoe'],
  appId: 4242,
};

const APP_ID = 4242;

/**
 * A GitHub that remembers what was written to it. This is the whole point of the
 * shape of `rules.ts`: the rules and the verifier can be driven end to end here,
 * with no account, no network and nothing that could reach a real repository.
 */
class FakeGitHub implements RuleApi {
  readonly calls: { method: string; path: string; body?: unknown }[] = [];
  rulesets: {
    id: number;
    name: string;
    target: string;
    enforcement: string;
    rules: unknown[];
    conditions?: { ref_name?: { include?: string[]; exclude?: string[] } };
  }[] = [];
  /** Every read of one full ruleset fails, leaving only its entry in the list. */
  failsFullRulesetGet = false;
  /** The list leaves out each ruleset's rules too, as GitHub's does. */
  listOmitsRules = false;
  environments = new Map<
    string,
    {
      protection_rules?: { type: string; reviewers?: unknown[]; wait_timer?: number }[];
      deployment_branch_policy?: { protected_branches?: boolean; custom_branch_policies?: boolean } | null;
    }
  >();
  /** Each environment's deployment branch policies, as GitHub lists them. */
  branchPolicies = new Map<string, { id: number; name: string; type: string }[]>();
  /** An error every branch policy `POST` answers with. */
  branchPolicyFailure: string | null = null;
  codeowners: string | null = null;
  /** Where the repository keeps `codeowners`: one of the three places GitHub looks. */
  codeownersPath = '.github/CODEOWNERS';
  /** A status every CODEOWNERS read answers with, in place of the file or a 404. */
  codeownersFailure: number | null = null;
  /**
   * A plan that will not hold an environment protection rule. GitHub refuses the
   * whole call with a 422 and creates the environment anyway, which is what a
   * private user-owned repository on the free plan actually did.
   */
  refusesProtectionRules = false;
  /** What could publish a required status check. Empty is a fresh repository. */
  workflows: string[] = [];
  /** A private repository on a free plan: every rulesets call is a 403. */
  refusesRulesets = false;
  /** GitHub taking `allow_auto_merge: true` with a 200 and leaving it off, as a free plan's private repository did. */
  keepsAutoMergeOff = false;
  /**
   * A private repository on GitHub Pro or Team: rulesets and branch policies
   * hold, and a required reviewer does not — that takes Enterprise.
   */
  refusesReviewers = false;
  /** An error every environment `PUT` answers with, whatever it asks for. */
  environmentFailure: string | null = null;
  /** A status every environment `GET` answers with, in place of the environment or a 404. */
  environmentReadFailure: number | null = null;
  /**
   * GitHub's accounts, as `GET /users/<login>` answers: an account, a status
   * it fails with, or absent for a 404.
   */
  users = new Map<string, { login: string; id?: unknown; type: string } | number>([
    ['janedoe', { login: 'janedoe', id: 1001, type: 'User' }],
    ['alex-maintainer', { login: 'alex-maintainer', id: 77120, type: 'User' }],
  ]);
  private nextId = 1;

  constructor(
    private readonly repo: { owner?: { type?: string }; private?: boolean; allow_auto_merge?: boolean } | null = {
      owner: { type: 'Organization' },
      private: true,
    },
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.calls.push({ method, path, body });
    const repoPath = `/repos/${INPUT.fullName}`;

    if (method === 'GET' && path === repoPath) {
      if (!this.repo) throw new Error('404');
      return this.repo as T;
    }
    if (method === 'PATCH' && path === repoPath && this.repo) {
      const { allow_auto_merge: autoMerge, ...rest } = body as { allow_auto_merge?: boolean };
      Object.assign(this.repo, this.keepsAutoMergeOff ? rest : { ...rest, ...(autoMerge === undefined ? {} : { allow_auto_merge: autoMerge }) });
      return this.repo as T;
    }

    const user = /^\/users\/([^/]+)$/.exec(path);
    if (method === 'GET' && user) {
      const account = this.users.get(decodeURIComponent(user[1] as string));
      if (account === undefined) throw new GitHubApiError(404, path, '{"message":"Not Found"}');
      if (typeof account === 'number') throw new GitHubApiError(account, path, '{"message":"Server Error"}');
      return account as T;
    }

    if (this.refusesRulesets && path.startsWith(`${repoPath}/rulesets`)) {
      throw new Error(`${path} → 403: {"message":"Upgrade to GitHub Pro or make this repository public to enable this feature."}`);
    }
    // GitHub's list leaves out each ruleset's conditions.
    if (method === 'GET' && path === `${repoPath}/rulesets`) {
      return this.rulesets.map(({ conditions: _, rules, ...listed }) => (this.listOmitsRules ? listed : { ...listed, rules })) as T;
    }

    const one = new RegExp(`^${repoPath}/rulesets/(\\d+)$`).exec(path);
    if (method === 'GET' && one) {
      if (this.failsFullRulesetGet) throw new GitHubApiError(502, path, '{"message":"Server Error"}');
      const found = this.rulesets.find((r) => r.id === Number(one[1]));
      if (!found) throw new Error('404');
      return found as T;
    }
    if (method === 'PUT' && one) {
      const index = this.rulesets.findIndex((r) => r.id === Number(one[1]));
      this.rulesets[index] = { ...(body as typeof this.rulesets[number]), id: Number(one[1]) };
      return this.rulesets[index] as T;
    }
    if (method === 'POST' && path === `${repoPath}/rulesets`) {
      const created = { ...(body as typeof this.rulesets[number]), id: this.nextId++ };
      this.rulesets.push(created);
      return created as T;
    }

    const policies = new RegExp(`^${repoPath}/environments/([^/]+)/deployment-branch-policies(?:/(\\d+))?(?:\\?.*)?$`).exec(path);
    if (policies) {
      const name = policies[1] as string;
      const held = this.branchPolicies.get(name) ?? [];
      if (method === 'GET') return { total_count: held.length, branch_policies: held } as T;
      if (method === 'POST') {
        if (this.branchPolicyFailure) throw new Error(`${path} → ${this.branchPolicyFailure}`);
        // GitHub takes a policy only on an environment whose branch policy is custom.
        if (this.environments.get(name)?.deployment_branch_policy?.custom_branch_policies !== true) {
          throw new GitHubApiError(404, path, '{"message":"Not Found"}');
        }
        const created = { id: this.nextId++, ...(body as { name: string; type: string }) };
        this.branchPolicies.set(name, [...held, created]);
        return created as T;
      }
      if (method === 'DELETE') {
        this.branchPolicies.set(name, held.filter((one) => one.id !== Number(policies[2])));
        return undefined as T;
      }
    }

    const env = new RegExp(`^${repoPath}/environments/(.+)$`).exec(path);
    if (method === 'GET' && env) {
      if (this.environmentReadFailure) throw new GitHubApiError(this.environmentReadFailure, path, '{"message":"Server Error"}');
      const found = this.environments.get(env[1] as string);
      if (!found) throw new GitHubApiError(404, path, '{"message":"Not Found"}');
      // A GET lists each reviewer as `{type, reviewer:{id}}`. A PUT sends `{type, id}`.
      return {
        ...found,
        protection_rules: found.protection_rules?.map((rule) => ({
          ...rule,
          reviewers: rule.reviewers?.map((one) => {
            const entry = one as { type?: string; id?: unknown; reviewer?: { id?: unknown } };
            if (entry.reviewer) return one;
            return { type: entry.type ?? 'User', reviewer: { id: entry.id } };
          }),
        })),
      } as T;
    }
    if (method === 'PUT' && env) {
      const payload = body as {
        reviewers?: unknown[];
        deployment_branch_policy?: { protected_branches?: boolean } | null;
        wait_timer?: number;
      };
      const reviewers = payload.reviewers ?? [];
      // GitHub types a reviewer's id as an integer, and refuses a login there.
      const notAnId = reviewers.find((one) => !Number.isInteger((one as { id?: unknown }).id));
      if (notAnId) {
        throw new GitHubApiError(
          422,
          path,
          `{"message":"Invalid request.\\n\\nFor 'properties/id', ${JSON.stringify(JSON.stringify((notAnId as { id?: unknown }).id))} is not an integer."}`,
        );
      }
      const asksForProtection =
        reviewers.length > 0 || payload.deployment_branch_policy != null || (payload.wait_timer ?? 0) > 0;

      if (this.environmentFailure) throw new Error(`${path} → ${this.environmentFailure}`);
      if (this.refusesReviewers && reviewers.length > 0) {
        if (!this.environments.has(env[1] as string)) {
          this.environments.set(env[1] as string, { protection_rules: [], deployment_branch_policy: null });
        }
        throw new Error(
          `${path} → 422: Failed to create the environment protection rule. ` +
            'Please ensure the billing plan supports the required reviewers protection rule.',
        );
      }
      if (this.refusesProtectionRules && asksForProtection) {
        // GitHub's own behaviour: the environment is created, the rules are not,
        // and the call is a 422 either way.
        if (!this.environments.has(env[1] as string)) {
          this.environments.set(env[1] as string, { protection_rules: [], deployment_branch_policy: null });
        }
        throw new Error(
          `${path} → 422: Failed to create the environment protection rule. ` +
            'Please ensure the billing plan supports the required reviewers protection rule.',
        );
      }

      const timer = (payload as { wait_timer?: number }).wait_timer ?? 0;
      this.environments.set(env[1] as string, {
        protection_rules: [
          ...(reviewers.length > 0 ? [{ type: 'required_reviewers', reviewers }] : []),
          ...(timer > 0 ? [{ type: 'wait_timer', wait_timer: timer }] : []),
        ],
        deployment_branch_policy: payload.deployment_branch_policy ?? null,
      });
      return {} as T;
    }

    if (method === 'GET' && path === `${repoPath}/contents/.github/workflows`) {
      if (this.workflows.length === 0) throw new Error('404');
      return this.workflows.map((name) => ({ name })) as T;
    }

    /**
     * The ruleset actually refusing a write, which is what made this a locked
     * repository rather than a failed step: `apply` created a rule requiring a
     * pull request and then wrote CODEOWNERS straight to the default branch.
     */
    if (method === 'PUT' && path.startsWith(`${repoPath}/contents/`)) {
      const main = this.rulesets.find((r) => r.name === MAIN_RULESET);
      const bypassed = (main as { bypass_actors?: { actor_id: number }[] } | undefined)?.bypass_actors ?? [];
      if (main && !bypassed.some((actor) => actor.actor_id === APP_ID)) {
        throw new Error(
          `${path} → 409: Repository rule violations found\n\nChanges must be made through a pull request.`,
        );
      }
    }

    const owners = new RegExp(`^${repoPath}/contents/(\\.github/CODEOWNERS|CODEOWNERS|docs/CODEOWNERS)$`).exec(path);
    if (owners) {
      const at = owners[1] as string;
      if (method === 'GET') {
        if (this.codeownersFailure) throw new GitHubApiError(this.codeownersFailure, path, '{"message":"Server Error"}');
        if (this.codeowners === null || at !== this.codeownersPath) throw new GitHubApiError(404, path, '{"message":"Not Found"}');
        return { content: Buffer.from(this.codeowners, 'utf8').toString('base64'), sha: 'codeowners-sha' } as T;
      }
      if (this.codeowners !== null && at !== this.codeownersPath) throw new Error(`the fake holds one CODEOWNERS, at ${this.codeownersPath}`);
      const put = body as { content: string; sha?: string };
      // GitHub refuses to replace a file without naming the version it replaces.
      if (this.codeowners !== null && put.sha !== 'codeowners-sha') throw new Error(`${path} → 422: sha wasn't supplied`);
      this.codeowners = Buffer.from(put.content, 'base64').toString('utf8');
      this.codeownersPath = at;
      return {} as T;
    }

    throw new Error(`the fake has no route for ${method} ${path}`);
  }

  wrote(method: string, path: string): boolean {
    return this.calls.some((call) => call.method === method && call.path === path);
  }
}

/** The `main` ruleset as it was written before OpenADLC named itself a bypass actor. */
function rulesetWithoutBypass(id: number): FakeGitHub['rulesets'][number] {
  const { bypass_actors: _dropped, ...rest } = mainRuleset({ ...INPUT, appId: undefined }) as ReturnType<
    typeof mainRuleset
  > & { bypass_actors?: unknown };
  return { ...rest, id } as FakeGitHub['rulesets'][number];
}

const stateOf = (reports: { name: string; state: string }[], name: string): string =>
  reports.find((report) => report.name === name)?.state ?? 'absent';

describe('reading a repository’s labels', () => {
  it('reads every page, not only the first hundred', async () => {
    const paths: string[] = [];
    const all = Array.from({ length: 230 }, (_, i) => ({ name: `label-${i}`, color: 'ededed', description: null }));
    const client = {
      request: async <T>(_method: string, path: string): Promise<T> => {
        paths.push(path);
        const page = Number(/[?&]page=(\d+)/.exec(path)?.[1]);
        return all.slice((page - 1) * 100, page * 100) as T;
      },
    };

    expect(await listLabels(client, 'exampleco/widgets')).toHaveLength(230);
    expect(paths).toEqual([1, 2, 3].map((page) => `/repos/exampleco/widgets/labels?per_page=100&page=${page}`));
  });

  it('fails when a page cannot be read, rather than saying there are none', async () => {
    const client = {
      request: async <T>(): Promise<T> => {
        throw new Error('GET /repos/exampleco/widgets/labels → 502');
      },
    };
    await expect(listLabels(client, 'exampleco/widgets')).rejects.toThrow(/502/);
  });
});

describe('a bare repository reports everything missing', () => {
  it('names each rule rather than failing as a whole', async () => {
    const reports = await checkRepoRules(new FakeGitHub(), INPUT);

    expect(stateOf(reports, MAIN_RULESET)).toBe('missing');
    expect(stateOf(reports, AGENT_BRANCHES_RULESET)).toBe('missing');
    expect(stateOf(reports, 'environment testing')).toBe('missing');
    expect(stateOf(reports, 'environment production')).toBe('missing');
    expect(stateOf(reports, 'CODEOWNERS')).toBe('missing');
  });

  it('says so once and clearly when the repository is not reachable at all', async () => {
    const reports = await checkRepoRules(new FakeGitHub(null), INPUT);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.state).toBe('missing');
    expect(reports[0]?.detail).toContain('not reachable');
  });
});

describe('apply then check reports everything present', () => {
  it('creates the rulesets, the environments and CODEOWNERS', async () => {
    const github = new FakeGitHub();
    // With a workflow to publish `ci`; one without is `a required check nothing can publish`.
    github.workflows = ['ci.yml'];
    const outcomes = await applyRepoRules(github, INPUT);

    expect(outcomes.filter((outcome) => outcome.action === 'created').map((o) => o.name)).toEqual([
      MAIN_RULESET,
      AGENT_BRANCHES_RULESET,
      'environment testing',
      'environment production',
      'environment production-rollback',
      'CODEOWNERS',
    ]);

    const reports = await checkRepoRules(github, INPUT);
    expect(reports.filter((report) => report.state === 'missing')).toEqual([]);
    expect(stateOf(reports, MAIN_RULESET)).toBe('present');
    expect(stateOf(reports, 'environment production')).toBe('present');
    expect(stateOf(reports, 'CODEOWNERS')).toBe('present');
  });

  it('is idempotent: a second apply changes nothing', async () => {
    const github = new FakeGitHub();
    await applyRepoRules(github, INPUT);
    const again = await applyRepoRules(github, INPUT);

    expect(again.filter((outcome) => outcome.name === MAIN_RULESET)[0]?.action).toBe('unchanged');
    expect(again.filter((outcome) => outcome.name === 'CODEOWNERS')[0]?.action).toBe('unchanged');
    expect(github.rulesets).toHaveLength(2);
  });

  it('does not overwrite a CODEOWNERS somebody wrote', async () => {
    const github = new FakeGitHub();
    github.codeowners = '* @somebody-else\n';
    await applyRepoRules(github, INPUT);

    expect(github.codeowners).toBe('* @somebody-else\n');
    expect(github.wrote('PUT', `/repos/${INPUT.fullName}/contents/.github/CODEOWNERS`)).toBe(false);
  });
});

describe('an apply that does not know the app’s id', () => {
  // `fleetadlc github apply` built its rules without the app and wrote the
  // console's ruleset back with no bypass and an unpinned review gate, which
  // any crew account could then set.
  it('leaves a ruleset that names the app as a bypass actor and pins the gate, and says where to apply from', async () => {
    const github = new FakeGitHub();
    github.workflows = ['ci.yml'];
    await applyRepoRules(github, { ...INPUT, pinnedChecks: [REVIEW_GATE_CHECK] });
    const before = JSON.stringify(github.rulesets);
    const puts = github.calls.filter((call) => call.method === 'PUT' && call.path.includes('/rulesets/')).length;

    const outcomes = await applyRepoRules(github, { ...INPUT, appId: undefined });

    expect(outcomes.find((outcome) => outcome.name === MAIN_RULESET)).toEqual({ name: MAIN_RULESET, action: 'skipped', detail: APP_UNKNOWN_DETAIL });
    expect(APP_UNKNOWN_DETAIL).toContain('Protect step');
    expect(github.calls.filter((call) => call.method === 'PUT' && call.path.includes('/rulesets/')).length).toBe(puts);
    expect(JSON.stringify(github.rulesets)).toBe(before);
  });

  it('still writes a ruleset that holds nothing for the app', async () => {
    const github = new FakeGitHub();
    github.rulesets = [rulesetWithoutBypass(7)];
    (github.rulesets[0] as { enforcement: string }).enforcement = 'disabled';
    // Present, so this apply does not also try to commit one past the ruleset.
    github.codeowners = '* @somebody-else\n';
    const outcomes = await applyRepoRules(github, { ...INPUT, appId: undefined });
    expect(outcomes.find((outcome) => outcome.name === MAIN_RULESET)?.action).toBe('updated');
  });
});

describe('a rule removed by hand is reported as drift', () => {
  it('notices a missing rule and names it', async () => {
    const github = new FakeGitHub();
    await applyRepoRules(github, INPUT);

    const main = github.rulesets.find((ruleset) => ruleset.name === MAIN_RULESET);
    main!.rules = (main!.rules as { type: string }[]).filter((rule) => rule.type !== 'required_signatures');

    const reports = await checkRepoRules(github, INPUT);
    expect(stateOf(reports, MAIN_RULESET)).toBe('drifted');
    expect(reports.find((report) => report.name === MAIN_RULESET)?.detail).toContain('required_signatures');
  });

  it('notices a weakened parameter, not just a deleted rule', async () => {
    const github = new FakeGitHub();
    await applyRepoRules(github, INPUT);

    const main = github.rulesets.find((ruleset) => ruleset.name === MAIN_RULESET);
    const review = (main!.rules as { type: string; parameters: Record<string, unknown> }[]).find(
      (rule) => rule.type === 'pull_request',
    );
    // The quiet way to defeat this: leave the rule in place and turn the code
    // owner requirement off.
    review!.parameters.require_code_owner_review = false;

    const reports = await checkRepoRules(github, INPUT);
    expect(stateOf(reports, MAIN_RULESET)).toBe('drifted');
    expect(reports.find((report) => report.name === MAIN_RULESET)?.detail).toContain('require_code_owner_review');
  });

  it('notices enforcement turned down to evaluate', async () => {
    const github = new FakeGitHub();
    await applyRepoRules(github, INPUT);
    github.rulesets.find((ruleset) => ruleset.name === MAIN_RULESET)!.enforcement = 'evaluate';

    const reports = await checkRepoRules(github, INPUT);
    expect(stateOf(reports, MAIN_RULESET)).toBe('drifted');
    expect(reports.find((report) => report.name === MAIN_RULESET)?.detail).toContain('enforcement');
  });

  it('re-applies over drift instead of leaving it', async () => {
    const github = new FakeGitHub();
    await applyRepoRules(github, INPUT);
    github.rulesets.find((ruleset) => ruleset.name === MAIN_RULESET)!.enforcement = 'disabled';

    const outcomes = await applyRepoRules(github, INPUT);
    expect(outcomes.find((outcome) => outcome.name === MAIN_RULESET)?.action).toBe('updated');
    expect(await checkRepoRules(github, INPUT).then((r) => stateOf(r, MAIN_RULESET))).toBe('present');
  });

  it('leaves a ruleset it does not own alone', async () => {
    const github = new FakeGitHub();
    github.rulesets.push({ id: 99, name: 'somebody else: tags', target: 'tag', enforcement: 'active', rules: [] });
    await applyRepoRules(github, INPUT);

    expect(github.rulesets.find((ruleset) => ruleset.id === 99)).toMatchObject({ name: 'somebody else: tags' });
    expect(github.wrote('PUT', `/repos/${INPUT.fullName}/rulesets/99`)).toBe(false);
  });
});

describe('what GitHub will not express is said, not passed over', () => {
  /** A person's private repository on the free plan, which refuses rulesets and every protection rule. */
  const personalPrivate = () => {
    const github = new FakeGitHub({ owner: { type: 'User' }, private: true });
    github.refusesRulesets = true;
    github.refusesProtectionRules = true;
    return github;
  };

  it('reports an unguarded production on a private personal repository', async () => {
    const github = personalPrivate();
    await applyRepoRules(github, INPUT);
    const reports = await checkRepoRules(github, INPUT);

    // The important part is that this is not 'present'.
    expect(stateOf(reports, 'environment production')).toBe('unsupported');
    // Says what still holds: OpenADLC's review gate and merge line, that nothing on GitHub holds a deploy,
    // and that OpenADLC holds each promote for a person instead.
    const detail = reports.find((report) => report.name === 'environment production')?.detail;
    expect(detail).toBe(PLAN_LIMITS_ENVIRONMENTS);
    // What an operator most needs: production is not held, and what would hold it.
    expect(detail).toContain('production has no required reviewer until the repository is public or on a plan that supports it');
    for (const limit of [PLAN_LIMITS_ENVIRONMENTS, PLAN_LIMITS_REVIEWER]) {
      expect(limit).toContain('OpenADLC holds each production promote for a person in Needs you');
      expect(limit).not.toContain('person’s merge');
    }
  });

  it('names the plan as what would guard it, not the owner', async () => {
    // It said "unless the repository moves to an organization", which on
    // GitHub Free, Pro or Team changes nothing for a private repository.
    const github = personalPrivate();
    await applyRepoRules(github, INPUT);
    const detail = (await checkRepoRules(github, INPUT)).find((report) => report.name === 'environment production')?.detail;
    expect(detail).toContain('only on GitHub Enterprise');
    expect(detail).not.toContain('organization');
  });

  it('skips the reviewer rather than applying a weaker one', async () => {
    const github = personalPrivate();
    const outcomes = await applyRepoRules(github, INPUT);
    const production = outcomes.find((outcome) => outcome.name === 'environment production');

    expect(production?.action).toBe('unsupported');
    // Not asked for at all: the plan had already said no, by refusing rulesets.
    const asked = github.calls.filter((call) => call.method === 'PUT' && call.path.endsWith('/environments/production'));
    expect(asked.map((call) => call.body)).toEqual([{}]);
  });

  it('says the Triage role is missing, which is the one thing that is', async () => {
    // Reported as a capability GitHub withholds, not as a fault in the install.
    // OpenADLC runs the same on a repository owned by a person, and naming the
    // finding `owner is an organization` made the owner the problem.
    const reports = await checkRepoRules(personalPrivate(), INPUT);
    expect(stateOf(reports, 'triage role')).toBe('unsupported');
  });

  it('says what holds the line instead, rather than leaving it at unsupported', async () => {
    // An operator reading "unsupported" needs to know whether anything is
    // guarding this. Something is: OpenADLC's own gates.
    const reports = await checkRepoRules(personalPrivate(), INPUT);
    expect(reports.find((report) => report.name === 'triage role')?.detail).toContain('own gates');
  });

  it('does not raise that on an organization', async () => {
    const reports = await checkRepoRules(new FakeGitHub(), INPUT);
    expect(stateOf(reports, 'triage role')).toBe('absent');
  });
});

/**
 * The plan decides what GitHub holds, not who owns the repository. It was
 * keyed on the owner: every private repository a person owns was taken as
 * limited, whatever its plan, and a free organization's was asked for a
 * reviewer its plan refuses.
 */
describe('what GitHub holds, decided by the plan rather than the owner', () => {
  it('asks a person’s private repository on GitHub Pro for its reviewer, and keeps the branch policy when it is refused', async () => {
    // Pro holds the branch policy and not a reviewer; asked for both, GitHub
    // refuses the call, and a bare environment was all that was left.
    const github = new FakeGitHub({ owner: { type: 'User' }, private: true });
    github.refusesReviewers = true;

    const outcomes = await applyRepoRules(github, INPUT);
    const production = outcomes.find((outcome) => outcome.name === 'environment production');

    expect(production).toMatchObject({ action: 'unsupported', detail: PLAN_LIMITS_REVIEWER });
    const puts = github.calls.filter((call) => call.method === 'PUT' && call.path.endsWith('/environments/production'));
    expect(puts).toHaveLength(2);
    expect((puts[0]?.body as { reviewers: unknown[] }).reviewers).not.toEqual([]);
    expect(puts[1]?.body).toMatchObject({ reviewers: [], deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } });
    expect(github.environments.get('production')?.deployment_branch_policy).toMatchObject({ custom_branch_policies: true });
    // Held to the default branch on the retry too, not left admitting none.
    expect(github.branchPolicies.get('production')?.map((one) => one.name)).toEqual(['main']);
    // And the check does not fail on it every run: no apply adds what the plan refuses.
    const report = (await checkRepoRules(github, INPUT)).find((rule) => rule.name === 'environment production');
    expect(report).toMatchObject({ state: 'unsupported' });
    expect(report?.detail).toContain('GitHub Enterprise');
  });

  it('names an open branch policy on a private production that also has no reviewer', async () => {
    const github = new FakeGitHub({ owner: { type: 'User' }, private: true });
    github.environments.set('production', { protection_rules: [], deployment_branch_policy: null });

    const production = (await checkRepoRules(github, INPUT)).find((report) => report.name === 'environment production');
    expect(production?.state).toBe('drifted');
    expect(production?.detail).toContain('no required reviewer');
    expect(production?.detail).toContain('no branch policy');
  });

  describe('a production that already holds its reviewer', () => {
    function withReviewer(failure: string) {
      const github = new FakeGitHub({ owner: { type: 'User' }, private: true });
      github.environments.set('production', {
        protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', id: 1 }] }],
        deployment_branch_policy: { protected_branches: true },
      });
      github.environmentFailure = failure;
      return github;
    }

    function productionPuts(github: FakeGitHub) {
      return github.calls.filter((call) => call.method === 'PUT' && call.path.endsWith('/environments/production'));
    }

    it('is not asked again without it when GitHub answers a 5xx', async () => {
      const github = withReviewer('502: Bad Gateway');

      const outcomes = await applyRepoRules(github, INPUT);

      expect(productionPuts(github)).toHaveLength(1);
      const production = outcomes.find((outcome) => outcome.name === 'environment production');
      // Something that went wrong, not the plan: said as such, in words.
      expect(production).toMatchObject({ action: 'skipped' });
      expect(production?.detail).toContain('GitHub answered 502: Bad Gateway');
      expect(production?.detail).not.toContain('/repos/');
      expect(github.environments.get('production')?.protection_rules).toEqual([
        expect.objectContaining({ type: 'required_reviewers' }),
      ]);
    });

    it('is not asked again without it when GitHub answers a 422 about something else', async () => {
      const github = withReviewer('422: {"message":"Validation Failed","errors":["wait_timer is out of range"]}');

      await applyRepoRules(github, INPUT);

      expect(productionPuts(github)).toHaveLength(1);
      expect(github.environments.get('production')?.protection_rules).toEqual([
        expect.objectContaining({ type: 'required_reviewers' }),
      ]);
    });

    it('is not asked again without it even on the plan’s refusal', async () => {
      const github = withReviewer(
        '422: Failed to create the environment protection rule. ' +
          'Please ensure the billing plan supports the required reviewers protection rule.',
      );

      await applyRepoRules(github, INPUT);

      expect(productionPuts(github)).toHaveLength(1);
    });
  });

  it('does not ask a new production again without its reviewer when GitHub answers a 5xx', async () => {
    const github = new FakeGitHub({ owner: { type: 'User' }, private: true });
    github.environmentFailure = '503: Service Unavailable';

    await applyRepoRules(github, INPUT);

    const puts = github.calls.filter((call) => call.method === 'PUT' && call.path.endsWith('/environments/production'));
    expect(puts.some((call) => (call.body as { reviewers?: unknown[] }).reviewers?.length === 0)).toBe(false);
  });

  it('asks a private repository on GitHub Enterprise for its reviewer, and finds it there', async () => {
    // Enterprise holds a reviewer on a private repository; nothing here refuses.
    const github = new FakeGitHub({ owner: { type: 'User' }, private: true });

    const outcomes = await applyRepoRules(github, INPUT);

    expect(outcomes.find((outcome) => outcome.name === 'environment production')?.action).toBe('created');
    expect(github.environments.get('production')?.protection_rules).toEqual([
      expect.objectContaining({ type: 'required_reviewers' }),
    ]);
    expect(stateOf(await checkRepoRules(github, INPUT), 'environment production')).toBe('present');
  });

  it('does not ask an organization’s private repository on the free plan for one, and calls it unsupported', async () => {
    const github = new FakeGitHub({ owner: { type: 'Organization' }, private: true });
    github.refusesRulesets = true;
    github.refusesProtectionRules = true;

    const outcomes = await applyRepoRules(github, INPUT);
    const production = outcomes.find((outcome) => outcome.name === 'environment production');

    expect(production?.action).toBe('unsupported');
    const asked = github.calls.filter((call) => call.method === 'PUT' && call.path.endsWith('/environments/production'));
    expect(asked.map((call) => call.body)).toEqual([{}]);
    const reports = await checkRepoRules(github, INPUT);
    expect(stateOf(reports, 'environment production')).toBe('unsupported');
    expect(stateOf(reports, 'triage role')).toBe('absent');
  });

  it('calls a private repository with a branch policy and no reviewer unsupported, and says what would hold one', async () => {
    // The shape GitHub Pro and Team leave; it used to be `missing` on every check.
    const github = new FakeGitHub({ owner: { type: 'User' }, private: true });
    github.environments.set('production', { protection_rules: [], deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } });
    github.branchPolicies.set('production', [{ id: 90, name: 'main', type: 'branch' }]);

    const production = (await checkRepoRules(github, INPUT)).find((report) => report.name === 'environment production');

    expect(production?.state).toBe('unsupported');
    expect(production?.detail).toContain('only on GitHub Enterprise');
  });
});

describe('the rules say what the plan says', () => {
  const rules = mainRuleset(INPUT).rules;
  const rule = (type: string) => rules.find((candidate) => candidate.type === type);

  it('makes history append-only and signed', () => {
    expect(rule('required_linear_history')).toBeDefined();
    expect(rule('non_fast_forward')).toBeDefined();
    expect(rule('required_signatures')).toBeDefined();
    expect(rule('deletion')).toBeDefined();
  });

  it('requires a code owner and a resolved conversation, and squash only', () => {
    expect(rule('pull_request')?.parameters).toMatchObject({
      required_approving_review_count: 1,
      require_code_owner_review: true,
      required_review_thread_resolution: true,
      allowed_merge_methods: ['squash'],
    });
  });

  it('requires the checks to have run against an up-to-date branch', () => {
    // Without `strict`, a green check from before `main` moved still counts,
    // which is what the merge line's base merge exists to prevent.
    expect(rule('required_status_checks')?.parameters).toMatchObject({
      strict_required_status_checks_policy: true,
      required_status_checks: [{ context: REQUIRED_CHECK }, { context: REVIEW_GATE_CHECK }],
    });
  });

  it('does not dismiss stale reviews on push, because the merge line merges the base', () => {
    // GitHub's own dismissal would clear approvals when the bridge brings a
    // branch up to date; the merge line's own dismissal, by the diff's
    // fingerprint, is what dismisses on a real content change.
    expect(rule('pull_request')?.parameters?.dismiss_stale_reviews_on_push).toBe(false);
  });

  it('names the lead reviewer as owner of everything, and a person for the rest', () => {
    const body = codeownersBody(INPUT);
    expect(body).toContain(`*       @${INPUT.leadReviewer}`);
    expect(body).toContain('/config/             @janedoe');
    expect(body).toContain('/.github/workflows/  @janedoe');
  });

  it('names no path of OpenADLC’s own, which a managed repository does not have', () => {
    for (const body of [codeownersBody(INPUT), codeownersBody({ ...INPUT, humans: [] })]) {
      expect(body).not.toContain('platform-plan');
      expect(body).not.toMatch(/the crew|the plan/);
    }
  });

  it('says which of its lines apply rewrites, rather than promising it never will', () => {
    const body = codeownersBody(INPUT);
    expect(body).not.toContain('only when it is absent');
    expect(body).toContain('It rewrites only a `*` line');
  });

  it('names nobody, rather than the organization, when no person is known', () => {
    const body = codeownersBody({ ...INPUT, humans: [] });
    expect(body).not.toMatch(/^\/config\//m);
    expect(body).toContain('Nobody was named when this was written');
  });
});

describe('repairing a CODEOWNERS that names nobody who can review', () => {
  // As OpenADLC wrote it while nobody was named: the organization everywhere.
  const ORG_FALLBACK = ['*       @acme', '', '# a person owns these', '/config/             @acme', '/infra/              @acme', ''].join('\n');

  it('gives * to the lead reviewer and the person lines to the people, when an organization owns them', () => {
    const repaired = codeownersRepair(ORG_FALLBACK, { leadReviewer: 'acme-lead', crew: ['acme-lead'], humans: ['janedoe'] }, 'acme');
    expect(repaired?.body).toBe(['*       @acme-lead', '', '# a person owns these', '/config/             @janedoe', '/infra/              @janedoe', ''].join('\n'));
    expect(repaired?.said).toEqual(['*: @acme → @acme-lead', '/config/: @acme → @janedoe', '/infra/: @acme → @janedoe']);
  });

  it('leaves a line somebody wrote: a person, a team, or several owners', () => {
    const own = ['*       @acme-lead', '/config/ @acme/platform', '/infra/ @acme @janedoe', '/docs/ @sam', ''].join('\n');
    expect(codeownersRepair(own, { leadReviewer: 'acme-lead', crew: ['acme-lead'], humans: ['janedoe'] }, 'acme')).toBeNull();
  });

  it('does not take a person’s own name for the organization’s on a personal repository', () => {
    expect(codeownersRepair('/config/ @janedoe\n', { leadReviewer: 'lead', crew: [], humans: ['sam'] }, null)).toBeNull();
  });

  it('still moves * from crew that no longer leads the review', () => {
    const repaired = codeownersRepair('*       @old-lead\n', { leadReviewer: 'new-lead', crew: ['old-lead', 'new-lead'], humans: [] }, null);
    expect(repaired?.body).toBe('*       @new-lead\n');
  });
});

/**
 * What a private repository on a plan without environment protection rules
 * actually does — measured against `janedoe/fleetadlc-testbed`, where clicking
 * apply returned a 422 and left nine things unwritten.
 */
describe('a plan that will not hold an environment protection rule', () => {
  function freePersonalRepo(): FakeGitHub {
    const github = new FakeGitHub({ owner: { type: 'User' }, private: true });
    github.refusesProtectionRules = true;
    github.refusesRulesets = true;
    return github;
  }

  it('does not lose everything after the environment it could not protect', async () => {
    // The bug: this threw out of `applyRepoRules`, so the second environment,
    // CODEOWNERS and every template after it never ran.
    const github = freePersonalRepo();

    const outcomes = await applyRepoRules(github, INPUT);

    expect(outcomes.map((one) => one.name)).toContain('CODEOWNERS');
    expect(github.codeowners).not.toBeNull();
  });

  it('still reaches the other environments after the first is refused', async () => {
    const github = freePersonalRepo();

    const outcomes = await applyRepoRules(github, INPUT);

    expect(outcomes.filter((one) => one.name.startsWith('environment'))).toHaveLength(3);
  });

  it('leaves the environment in place so the deploy path has a target', async () => {
    const github = freePersonalRepo();

    await applyRepoRules(github, INPUT);

    expect(github.environments.has('testing')).toBe(true);
  });

  it('says it is the plan’s limit, in words, and never as GitHub’s path or JSON', async () => {
    const github = freePersonalRepo();

    const outcomes = await applyRepoRules(github, INPUT);

    for (const name of ['environment testing', 'environment production', 'environment production-rollback']) {
      const outcome = outcomes.find((one) => one.name === name);
      expect(outcome).toMatchObject({ action: 'unsupported', detail: PLAN_LIMITS_ENVIRONMENTS });
      expect(outcome?.detail).not.toMatch(/\/repos\/|\{|422/);
    }
  });

  it('does not ask again for what the plan refuses, on this apply or the next', async () => {
    // Every apply used to ask for both environments' rules, be refused with a
    // 422 each time, and report it as needing attention.
    const github = freePersonalRepo();

    await applyRepoRules(github, INPUT);
    await applyRepoRules(github, INPUT);

    const protective = github.calls.filter(
      (call) =>
        call.method === 'PUT' &&
        call.path.includes('/environments/') &&
        Object.keys((call.body as object | undefined) ?? {}).length > 0,
    );
    expect(protective).toEqual([]);
    // Each made once, bare; the second apply finds them there.
    expect(github.calls.filter((call) => call.method === 'PUT' && call.path.includes('/environments/'))).toHaveLength(3);
  });

  it('calls a plan refusal it meets without having been told a limit, and says so in words', async () => {
    // A plan whose rulesets hold but whose environments refuse their rules:
    // the 422 names the billing plan, so it is the plan's limit, not a fault.
    const github = new FakeGitHub({ owner: { type: 'User' }, private: true });
    github.refusesProtectionRules = true;

    const outcomes = await applyRepoRules(github, INPUT);

    expect(outcomes.find((one) => one.name === 'environment testing')).toMatchObject({
      action: 'unsupported',
      detail: PLAN_LIMITS_ENVIRONMENTS,
    });
    // Testing's is the branch policy, which the sentence says, not a reviewer.
    expect(PLAN_LIMITS_ENVIRONMENTS).toContain('testing and production-rollback are not held to the default branch');
  });

  it('reports the retry’s own failure, never as the plan’s limit, when the reviewer’s refusal is followed by another', async () => {
    // A 422 for the reviewer, then a 502 for the environment without it: a
    // GitHub Pro repository that did not get its branch policy, which a limit
    // would have kept anyone from asking about again.
    const github = new FakeGitHub({ owner: { type: 'User' }, private: true });
    github.refusesReviewers = true;
    const original = github.request.bind(github);
    let productionPuts = 0;
    github.request = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
      if (method === 'PUT' && path.endsWith('/environments/production') && ++productionPuts === 2) {
        github.calls.push({ method, path, body });
        throw new Error(`${path} → 502: Bad Gateway`);
      }
      return original<T>(method, path, body);
    };

    const outcomes = await applyRepoRules(github, INPUT);
    const production = outcomes.find((one) => one.name === 'environment production');

    expect(production?.action).toBe('skipped');
    expect(production?.detail).toContain('GitHub answered 502: Bad Gateway');
  });

  it('never reports an unprotected environment as present', async () => {
    // The dangerous one. This said `present` for an environment with
    // `protection_rules: []` and `deployment_branch_policy: null` — reporting
    // containment that was not there.
    const github = freePersonalRepo();
    await applyRepoRules(github, INPUT);

    const reports = await checkRepoRules(github, INPUT);

    expect(stateOf(reports, 'environment testing')).not.toBe('present');
    expect(stateOf(reports, 'environment testing')).toBe('unsupported');
  });

  it('does not strip the rules off an environment that already has them', async () => {
    // The fallback asks for a bare environment. Doing that over one that is
    // already protected would take the protection off.
    const github = new FakeGitHub({ owner: { type: 'User' }, private: true });
    await applyRepoRules(github, INPUT);
    expect(github.environments.get('testing')?.deployment_branch_policy).toEqual({
      protected_branches: false,
      custom_branch_policies: true,
    });

    github.refusesProtectionRules = true;
    await applyRepoRules(github, INPUT);

    expect(github.environments.get('testing')?.deployment_branch_policy).not.toBeNull();
  });
});

describe('an environment that is there but guarding nothing', () => {
  it('is reported as present once its branch policy is in place', async () => {
    const github = new FakeGitHub({ owner: { type: 'Organization' }, private: true });
    await applyRepoRules(github, INPUT);

    expect(stateOf(await checkRepoRules(github, INPUT), 'environment testing')).toBe('present');
  });

  it('is reported as drifted where the plan could hold one and does not', async () => {
    // An organization repository can express this, so an absent policy is
    // something to fix rather than something to live with.
    const github = new FakeGitHub({ owner: { type: 'Organization' }, private: true });
    github.environments.set('testing', { protection_rules: [], deployment_branch_policy: null });

    const reports = await checkRepoRules(github, INPUT);

    expect(stateOf(reports, 'environment testing')).toBe('drifted');
    expect(reports.find((one) => one.name === 'environment testing')?.detail).toMatch(/main/);
  });
});

/**
 * Testing and production are held to the default branch alone. They were held
 * to protected branches, which the crew's own `agent/**` and `system/**` are:
 * a workflow pushed to a bot's branch could deploy, or read the environment's
 * secrets.
 */
describe('environments held to the default branch alone', () => {
  const custom = { protected_branches: false, custom_branch_policies: true };
  const policyNames = (github: FakeGitHub, environment: string) => github.branchPolicies.get(environment)?.map((one) => one.name);

  it('writes a custom policy naming the default branch, for testing and production, reviewed or automatic', async () => {
    for (const input of [INPUT, { ...INPUT, production: { approval: 'auto' as const, soakMinutes: 30 } }]) {
      const github = new FakeGitHub();
      const outcomes = await applyRepoRules(github, input);

      for (const environment of ['testing', 'production']) {
        const put = github.calls.find((call) => call.method === 'PUT' && call.path.endsWith(`/environments/${environment}`));
        expect(put?.body).toMatchObject({ deployment_branch_policy: custom });
        expect(policyNames(github, environment)).toEqual(['main']);
        expect(outcomes.find((one) => one.name === `environment ${environment}`)?.action).toBe('created');
      }
      expect(stateOf(await checkRepoRules(github, input), 'environment testing')).toBe('present');
      expect(stateOf(await checkRepoRules(github, input), 'environment production')).toBe('present');
    }
  });

  it('removes any other policy, leaving exactly the default branch', async () => {
    const github = new FakeGitHub();
    github.environments.set('testing', { protection_rules: [], deployment_branch_policy: custom });
    github.branchPolicies.set('testing', [{ id: 77, name: 'agent/*', type: 'branch' }]);

    expect(stateOf(await checkRepoRules(github, INPUT), 'environment testing')).toBe('drifted');
    await applyRepoRules(github, INPUT);

    expect(policyNames(github, 'testing')).toEqual(['main']);
    expect(github.wrote('DELETE', `/repos/${INPUT.fullName}/environments/testing/deployment-branch-policies/77`)).toBe(true);
  });

  it('calls testing drifted when it admits every protected branch, lacks the default branch, or admits another', async () => {
    const cases: [string, FakeGitHub['environments'] extends Map<string, infer E> ? E : never, { id: number; name: string; type: string }[], RegExp][] = [
      ['protected branches', { protection_rules: [], deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } }, [], /every protected branch/],
      ['no default branch', { protection_rules: [], deployment_branch_policy: custom }, [], /no branch policy names `main`/],
      ['another', { protection_rules: [], deployment_branch_policy: custom }, [{ id: 1, name: 'main', type: 'branch' }, { id: 2, name: 'system/*', type: 'branch' }], /also admits `system\/\*`/],
    ];
    for (const [what, environment, policies, said] of cases) {
      const github = new FakeGitHub();
      github.environments.set('testing', environment);
      github.branchPolicies.set('testing', policies);
      const report = (await checkRepoRules(github, INPUT)).find((one) => one.name === 'environment testing');
      expect(report?.state, what).toBe('drifted');
      expect(report?.detail, what).toMatch(said);
    }
  });

  it('reads production’s branch policy even when it holds a reviewer', async () => {
    const github = new FakeGitHub();
    github.environments.set('production', {
      protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', id: 1001 }] }],
      deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
    });

    const report = (await checkRepoRules(github, INPUT)).find((one) => one.name === 'environment production');

    expect(report?.state).toBe('drifted');
    expect(report?.detail).toMatch(/every protected branch/);
  });

  it('calls a renamed default branch drift, and apply moves the policy to it', async () => {
    const trunk = { ...INPUT, defaultBranch: 'trunk' };
    const github = new FakeGitHub();
    github.environments.set('testing', { protection_rules: [], deployment_branch_policy: custom });
    github.branchPolicies.set('testing', [{ id: 5, name: 'main', type: 'branch' }]);

    expect(stateOf(await checkRepoRules(github, trunk), 'environment testing')).toBe('drifted');
    await applyRepoRules(github, trunk);

    expect(policyNames(github, 'testing')).toEqual(['trunk']);
    expect(stateOf(await checkRepoRules(github, trunk), 'environment testing')).toBe('present');
  });

  it('is not a success when GitHub refuses the policy', async () => {
    const github = new FakeGitHub();
    github.branchPolicyFailure = '502: Bad Gateway';

    const outcomes = await applyRepoRules(github, INPUT);

    expect(outcomes.find((one) => one.name === 'environment testing')).toMatchObject({
      action: 'skipped',
      detail: expect.stringContaining('GitHub answered 502: Bad Gateway'),
    });
  });

  it('makes no branch policy call on a private repository whose plan refuses rulesets', async () => {
    const github = new FakeGitHub({ owner: { type: 'Organization' }, private: true });
    github.refusesRulesets = true;
    github.refusesProtectionRules = true;

    const outcomes = await applyRepoRules(github, INPUT);

    expect(outcomes.find((one) => one.name === 'environment testing')).toMatchObject({ action: 'unsupported', detail: PLAN_LIMITS_ENVIRONMENTS });
    expect(github.calls.some((call) => call.path.includes('/deployment-branch-policies'))).toBe(false);
  });

  it('says the plan’s limits without speaking of protected branches', () => {
    expect(PLAN_LIMITS_ENVIRONMENTS).not.toContain('protected branches');
    expect(PLAN_LIMITS_REVIEWER).not.toContain('protected branches');
    expect(PLAN_LIMITS_REVIEWER).toContain('held to the default branch');
  });
});

/**
 * The rollback runs in an environment of its own. Named in no environment, the
 * credential that shifts production's traffic could only be a repository
 * secret, which any workflow on any branch reads. Its environment waits for
 * nobody, so a rollback still never waits, and admits the default branch alone.
 */
describe('the rollback’s own environment', () => {
  const custom = { protected_branches: false, custom_branch_policies: true };
  const rollback = (reports: { name: string; state: string; detail: string }[]) =>
    reports.find((one) => one.name === 'environment production-rollback');

  it('is created with no reviewer, no wait timer and the default branch as its one policy', async () => {
    const github = new FakeGitHub();

    const outcomes = await applyRepoRules(github, INPUT);

    const put = github.calls.find((call) => call.method === 'PUT' && call.path.endsWith('/environments/production-rollback'));
    expect(put?.body).toEqual({ wait_timer: 0, reviewers: [], deployment_branch_policy: custom });
    expect(github.branchPolicies.get('production-rollback')).toEqual([expect.objectContaining({ name: 'main', type: 'branch' })]);
    expect(outcomes.find((one) => one.name === 'environment production-rollback')?.action).toBe('created');
    expect(rollback(await checkRepoRules(github, INPUT))?.state).toBe('present');
  });

  it('is missing until it is made', async () => {
    expect(rollback(await checkRepoRules(new FakeGitHub(), INPUT))?.state).toBe('missing');
  });

  it('is drifted with a reviewer, a wait timer, protected branches, or another policy', async () => {
    const policy = [{ id: 1, name: 'main', type: 'branch' }];
    const cases: [string, Parameters<FakeGitHub['environments']['set']>[1], { id: number; name: string; type: string }[], RegExp][] = [
      ['a reviewer', { protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', id: 1001 }] }], deployment_branch_policy: custom }, policy, /reviewer/],
      ['a wait timer', { protection_rules: [{ type: 'wait_timer', wait_timer: 10 }], deployment_branch_policy: custom }, policy, /wait timer of 10/],
      ['protected branches', { protection_rules: [], deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } }, [], /every protected branch/],
      ['another policy', { protection_rules: [], deployment_branch_policy: custom }, [...policy, { id: 2, name: 'agent/*', type: 'branch' }], /also admits `agent\/\*`/],
    ];
    for (const [what, environment, policies, said] of cases) {
      const github = new FakeGitHub();
      github.environments.set('production-rollback', environment);
      github.branchPolicies.set('production-rollback', policies);
      const report = rollback(await checkRepoRules(github, INPUT));
      expect(report?.state, what).toBe('drifted');
      expect(report?.detail, what).toMatch(said);
    }
  });

  it('is unsupported, and made bare, on a private repository whose plan refuses rulesets', async () => {
    const github = new FakeGitHub({ owner: { type: 'Organization' }, private: true });
    github.refusesRulesets = true;
    github.refusesProtectionRules = true;

    const outcomes = await applyRepoRules(github, INPUT);

    expect(outcomes.find((one) => one.name === 'environment production-rollback')).toMatchObject({
      action: 'unsupported',
      detail: PLAN_LIMITS_ENVIRONMENTS,
    });
    const puts = github.calls.filter((call) => call.method === 'PUT' && call.path.endsWith('/environments/production-rollback'));
    expect(puts.map((call) => call.body)).toEqual([{}]);
    expect(rollback(await checkRepoRules(github, INPUT))).toMatchObject({ state: 'unsupported', detail: PLAN_LIMITS_ENVIRONMENTS });
  });
});

/**
 * The lock with no key.
 *
 * Applying to a fresh repository created a `main` ruleset requiring a pull
 * request and two status checks, then tried to write CODEOWNERS straight to the
 * default branch — which that rule refuses. Measured on a real repository: the
 * branch ended up protected, CODEOWNERS absent, `.github/workflows` absent, and
 * so no pull request could ever satisfy the checks either. Nothing could be
 * merged and OpenADLC could not repair it.
 */
describe('setting up a repository must not lock OpenADLC out of it', () => {
  it('can still write CODEOWNERS after protecting the branch', async () => {
    const github = new FakeGitHub();

    await applyRepoRules(github, INPUT);

    expect(github.codeowners).not.toBeNull();
  });

  it('names the app as a bypass actor on the ruleset it creates', async () => {
    const github = new FakeGitHub();
    await applyRepoRules(github, INPUT);

    const main = github.rulesets.find((one) => one.name === MAIN_RULESET) as unknown as {
      bypass_actors?: { actor_id: number; actor_type: string }[];
    };
    expect(main.bypass_actors).toEqual([
      { actor_id: 4242, actor_type: 'Integration', bypass_mode: 'always' },
    ]);
  });

  it('adds the bypass to a ruleset that already exists without one', async () => {
    // Recovery. Drift compared only enforcement and rules, so a repository OpenADLC
    // had already locked itself out of reported "unchanged" and stayed locked.
    const github = new FakeGitHub();
    github.rulesets.push(rulesetWithoutBypass(99));

    await applyRepoRules(github, INPUT);

    const main = github.rulesets.find((one) => one.name === MAIN_RULESET) as unknown as {
      bypass_actors?: unknown[];
    };
    expect(main.bypass_actors).toHaveLength(1);
    expect(github.codeowners).not.toBeNull();
  });

  it('reports the missing bypass as drift rather than as nothing', async () => {
    const github = new FakeGitHub();
    github.rulesets.push(rulesetWithoutBypass(99));

    const reports = await checkRepoRules(github, INPUT);

    expect(stateOf(reports, MAIN_RULESET)).toBe('drifted');
  });
});

describe('a required check nothing can publish', () => {
  it('is left off, because requiring it makes `main` unmergeable', async () => {
    // No `.github/workflows`, so `ci` and `review-gate` will never arrive.
    const github = new FakeGitHub();

    await applyRepoRules(github, INPUT);

    const main = github.rulesets.find((one) => one.name === MAIN_RULESET);
    expect(main?.rules.some((rule) => (rule as { type: string }).type === 'required_status_checks')).toBe(
      false,
    );
  });

  it('says why, rather than quietly dropping a rule', async () => {
    const github = new FakeGitHub();

    const outcomes = await applyRepoRules(github, INPUT);
    const note = outcomes.find((one) => one.name === 'required status checks');

    expect(note?.action).toBe('skipped');
    expect(note?.detail).toMatch(/nothing lands/);
  });

  it('is reported missing, not merely unsupported: the merge line lands nothing without it', async () => {
    // Reported as "unsupported", it put nothing on the board, and every pull
    // request waited on a `ci` check no workflow would ever publish.
    const reports = await checkRepoRules(new FakeGitHub(), INPUT);
    expect(stateOf(reports, 'required status checks')).toBe('missing');
    expect(reports.find((one) => one.name === 'required status checks')?.detail).toContain('Applying writes a `ci` workflow');
  });

  it('is required once something can publish it', async () => {
    const github = new FakeGitHub();
    github.workflows = ['ci.yml'];

    await applyRepoRules(github, INPUT);

    const main = github.rulesets.find((one) => one.name === MAIN_RULESET);
    expect(main?.rules.some((rule) => (rule as { type: string }).type === 'required_status_checks')).toBe(
      true,
    );
  });

  it('reads back as present rather than drifted, either way', async () => {
    // The preview and the writer have to want the same thing, or applying
    // leaves the check reporting the ruleset it just wrote as wrong.
    for (const workflows of [[], ['ci.yml']]) {
      const github = new FakeGitHub();
      github.workflows = workflows;
      await applyRepoRules(github, INPUT);

      expect(stateOf(await checkRepoRules(github, INPUT), MAIN_RULESET), JSON.stringify(workflows)).toBe(
        'present',
      );
    }
  });
});

describe('the code owner follows the lead reviewer’s seat', () => {
  // CODEOWNERS named whoever held the seat the day it was written. The seat
  // changed hands, and every pull request waited for a code owner's review
  // from the intake bot, which never reviews.
  const LEAD = { ...INPUT, leadReviewer: 'noraexampleco', crew: ['ottoexampleco', 'noraexampleco', 'irisexampleco'] };
  const WRITTEN = codeownersBody({ ...LEAD, leadReviewer: 'ottoexampleco' });

  it('reports a code owner that is crew but not the lead reviewer as drift, naming both', async () => {
    const github = new FakeGitHub();
    github.codeowners = WRITTEN;

    const report = (await checkRepoRules(github, LEAD)).find((one) => one.name === 'CODEOWNERS');

    expect(report?.state).toBe('drifted');
    expect(report?.detail).toContain('@ottoexampleco');
    expect(report?.detail).toContain('@noraexampleco');
  });

  it('gives the seat to whoever holds it now, and leaves every other line as it was', async () => {
    const github = new FakeGitHub();
    github.codeowners = WRITTEN;

    const outcome = (await applyRepoRules(github, LEAD)).find((one) => one.name === 'CODEOWNERS');

    expect(outcome).toMatchObject({ action: 'updated', detail: '.github/CODEOWNERS: *: @ottoexampleco → @noraexampleco' });
    expect(github.codeowners).toBe(WRITTEN.replace('*       @ottoexampleco', '*       @noraexampleco'));
    expect(stateOf(await checkRepoRules(github, LEAD), 'CODEOWNERS')).toBe('present');
  });

  it('writes no organization as an owner, and nothing at all with nobody else to name', async () => {
    const github = new FakeGitHub();
    github.codeowners = null as never;
    const outcome = (await applyRepoRules(github, { ...LEAD, leadReviewer: 'exampleco', humans: ['exampleco'] })).find(
      (one) => one.name === 'CODEOWNERS',
    );
    expect(outcome).toMatchObject({ action: 'skipped' });
    expect(github.codeowners ?? '').not.toContain('@exampleco');
  });

  it('leaves a person named there alone: that is a decision, not a seat', async () => {
    const github = new FakeGitHub();
    github.codeowners = '* @janedoe\n';

    await applyRepoRules(github, LEAD);

    expect(github.codeowners).toBe('* @janedoe\n');
    expect(stateOf(await checkRepoRules(github, LEAD), 'CODEOWNERS')).toBe('present');
  });

  it('reads the owner of everything the way GitHub does: the last `*` line, comments aside', () => {
    expect(everythingOwners('# owners\n* @a # first\n/docs/ @b\n*   @c @d\n')).toEqual(['c', 'd']);
    expect(everythingOwners('/docs/ @b\n')).toBeNull();
    expect(staleCodeOwner('* @Ottoexampleco\n', LEAD)).toEqual(['Ottoexampleco']);
    expect(staleCodeOwner('* @NORAexampleco\n', LEAD)).toBeNull();
    expect(withCodeOwner('# keep\n*       @ottoexampleco  # the lead\n/infra/ @janedoe\n', 'noraexampleco')).toBe(
      '# keep\n*       @noraexampleco\n/infra/ @janedoe\n',
    );
  });
});

/**
 * GitHub reads CODEOWNERS from `.github/`, then the root, then `docs/`, and
 * uses the first it finds. Only `.github/` was read: a repository with its own
 * file elsewhere was told it had none, and applying wrote a `.github/` one
 * naming the lead reviewer for everything, which GitHub then read instead.
 */
describe('the CODEOWNERS GitHub reads', () => {
  const OWN = '* @acme/core\n/src/billing/ @acme/billing\n';
  const contentPuts = (github: FakeGitHub) =>
    github.calls.filter((call) => call.method === 'PUT' && call.path.includes('/contents/') && call.path.endsWith('CODEOWNERS'));

  for (const [path, place] of [
    ['CODEOWNERS', 'CODEOWNERS (root)'],
    ['docs/CODEOWNERS', 'docs/CODEOWNERS'],
  ] as const) {
    it(`is found at ${place}: present, unchanged, and nothing written`, async () => {
      const github = new FakeGitHub();
      github.codeowners = OWN;
      github.codeownersPath = path;

      const report = (await checkRepoRules(github, INPUT)).find((one) => one.name === 'CODEOWNERS');
      expect(report).toMatchObject({ state: 'present' });
      expect(report?.detail).toContain(place);

      const outcome = (await applyRepoRules(github, INPUT)).find((one) => one.name === 'CODEOWNERS');
      expect(outcome).toMatchObject({ action: 'unchanged' });
      expect(outcome?.detail).toContain(place);
      expect(contentPuts(github)).toEqual([]);
      expect(github.codeowners).toBe(OWN);
    });
  }

  it('is repaired where it is, with that file’s sha, and no second one is created', async () => {
    const github = new FakeGitHub();
    // Owned by the organization alone, which `codeownersRepair` rewrites.
    github.codeowners = '*       @exampleco\n/config/ @exampleco\n';
    github.codeownersPath = 'CODEOWNERS';

    const outcome = (await applyRepoRules(github, INPUT)).find((one) => one.name === 'CODEOWNERS');

    expect(contentPuts(github).map((call) => call.path)).toEqual([`/repos/${INPUT.fullName}/contents/CODEOWNERS`]);
    expect(contentPuts(github)[0]?.body).toMatchObject({ sha: 'codeowners-sha' });
    expect(outcome).toMatchObject({ action: 'updated', detail: expect.stringContaining('CODEOWNERS (root)') });
    expect(github.wrote('PUT', `/repos/${INPUT.fullName}/contents/.github/CODEOWNERS`)).toBe(false);
  });

  it('is created in .github/ when there is none in any of the three places', async () => {
    const github = new FakeGitHub();

    const outcome = (await applyRepoRules(github, INPUT)).find((one) => one.name === 'CODEOWNERS');

    expect(outcome).toMatchObject({ action: 'created', detail: '.github/CODEOWNERS' });
    expect(github.codeownersPath).toBe('.github/CODEOWNERS');
    expect(['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'].every((path) => github.wrote('GET', `/repos/${INPUT.fullName}/contents/${path}`))).toBe(true);
  });

  it('is not called missing, and nothing is written, when GitHub answers something other than a 404', async () => {
    const github = new FakeGitHub();
    github.codeownersFailure = 502;

    const report = (await checkRepoRules(github, INPUT)).find((one) => one.name === 'CODEOWNERS');
    expect(report?.state).not.toBe('missing');
    expect(report?.detail).toContain('.github/CODEOWNERS');

    const outcome = (await applyRepoRules(github, INPUT)).find((one) => one.name === 'CODEOWNERS');
    expect(outcome).toMatchObject({ action: 'skipped', detail: expect.stringContaining('GitHub answered 502') });
    expect(contentPuts(github)).toEqual([]);
  });
});

describe('auto-merge', () => {
  it('is turned on where the plan offers it, for a repository whose merges are handed to GitHub', async () => {
    const github = new FakeGitHub({ owner: { type: 'User' }, private: false, allow_auto_merge: false });
    github.workflows = ['ci.yml'];

    expect(stateOf(await checkRepoRules(github, INPUT), 'auto-merge')).toBe('missing');
    const outcome = (await applyRepoRules(github, INPUT)).find((one) => one.name === 'auto-merge');

    expect(outcome?.action).toBe('updated');
    expect(github.wrote('PATCH', `/repos/${INPUT.fullName}`)).toBe(true);
    expect(stateOf(await checkRepoRules(github, INPUT), 'auto-merge')).toBe('present');
  });

  it('is not asked for on a plan that offers none, which the check said and listed nothing to agree to', async () => {
    // exampleco/testbed-2, 2026-10-03: the check said unsupported, apply sent the
    // change anyway, GitHub took it and changed nothing, and apply said updated.
    const github = new FakeGitHub({ owner: { type: 'User' }, private: true, allow_auto_merge: false });
    github.refusesRulesets = true;
    github.workflows = ['ci.yml'];

    expect(stateOf(await checkRepoRules(github, INPUT), 'auto-merge')).toBe('unsupported');
    const outcome = (await applyRepoRules(github, INPUT)).find((one) => one.name === 'auto-merge');

    expect(outcome?.action).toBe('skipped');
    expect(outcome?.detail).toMatch(/plan does not offer auto-merge/);
    expect(github.wrote('PATCH', `/repos/${INPUT.fullName}`)).toBe(false);
  });

  it('says what GitHub did, not what was asked: a change it took and did not make is not an update', async () => {
    const github = new FakeGitHub({ owner: { type: 'User' }, private: false, allow_auto_merge: false });
    github.keepsAutoMergeOff = true;
    github.workflows = ['ci.yml'];

    const outcome = (await applyRepoRules(github, INPUT)).find((one) => one.name === 'auto-merge');

    expect(outcome).toMatchObject({ action: 'skipped', detail: expect.stringContaining('left auto-merge off') });
  });

  it('is not guessed at when GitHub does not say', async () => {
    const github = new FakeGitHub();

    expect(stateOf(await checkRepoRules(github, INPUT), 'auto-merge')).toBe('absent');
    expect(github.wrote('PATCH', `/repos/${INPUT.fullName}`)).toBe(false);
    await applyRepoRules(github, INPUT);
    expect(github.wrote('PATCH', `/repos/${INPUT.fullName}`)).toBe(false);
  });
});

describe('an approval after the merge line brings a pull request up to date', () => {
  // GitHub counts the merge from the base as a push the last approval has to
  // come after. With the rule on, every pull request whose base moved waited
  // for a review nobody was asked for; the review gate re-asks when the diff
  // changes, which is the rule OpenADLC means.
  it('is not asked for by the ruleset OpenADLC writes', () => {
    const review = mainRuleset(INPUT).rules.find((rule) => rule.type === 'pull_request') as { parameters: Record<string, unknown> };
    expect(review.parameters.require_last_push_approval).toBe(false);
  });

  it('is reported where an older apply turned it on, and applying turns it off', async () => {
    const github = new FakeGitHub();
    github.workflows = ['ci.yml'];
    const older = mainRuleset(INPUT) as unknown as { rules: { type: string; parameters?: Record<string, unknown> }[] };
    const pr = older.rules.find((rule) => rule.type === 'pull_request');
    if (pr?.parameters) pr.parameters.require_last_push_approval = true;
    github.rulesets.push({ ...(older as unknown as FakeGitHub['rulesets'][number]), id: 7 });

    const report = (await checkRepoRules(github, INPUT)).find((one) => one.name === MAIN_RULESET);
    expect(report?.state).toBe('drifted');
    expect(report?.detail).toContain('pull_request.require_last_push_approval is true, not false');

    await applyRepoRules(github, INPUT);
    expect(stateOf(await checkRepoRules(github, INPUT), MAIN_RULESET)).toBe('present');
  });
});

describe('a check only the app may satisfy', () => {
  const checksOf = (ruleset: ReturnType<typeof mainRuleset>) =>
    ruleset.rules.find((rule) => rule.type === 'required_status_checks')?.parameters?.required_status_checks;

  it('requires review-gate from the app alone once it is pinned, and ci from anyone', () => {
    expect(checksOf(mainRuleset({ ...INPUT, appId: 42, pinnedChecks: [REVIEW_GATE_CHECK] }))).toEqual([
      { context: REQUIRED_CHECK },
      { context: REVIEW_GATE_CHECK, integration_id: 42 },
    ]);
  });

  it('pins nothing without an app to pin it to', () => {
    expect(checksOf(mainRuleset({ ...INPUT, appId: undefined, pinnedChecks: [REVIEW_GATE_CHECK] }))).toEqual([
      { context: REQUIRED_CHECK },
      { context: REVIEW_GATE_CHECK },
    ]);
  });
});

describe('a plan that holds no rulesets', () => {
  it('says so of each ruleset, as a limit rather than a change, and applies everything else', async () => {
    const github = new FakeGitHub();
    github.refusesRulesets = true;
    github.workflows = ['ci.yml'];

    const reports = await checkRepoRules(github, INPUT);
    expect(stateOf(reports, MAIN_RULESET)).toBe('unsupported');
    expect(reports.find((report) => report.name === MAIN_RULESET)?.detail).toContain('GitHub Pro or Team');

    const outcomes = await applyRepoRules(github, INPUT);
    expect(outcomes.find((outcome) => outcome.name === MAIN_RULESET)).toMatchObject({ action: 'skipped' });
    // The environments are still made, and a private repository on a plan
    // that refuses rulesets is not asked for their rules either.
    expect(outcomes.find((outcome) => outcome.name === 'environment testing')?.action).toBe('unsupported');
    expect(github.environments.has('testing')).toBe(true);
    expect(github.calls.some((call) => call.method === 'POST' && call.path.endsWith('/rulesets'))).toBe(false);
  });

  it('reads as a repository that does not enforce rulesets, without asking GitHub again', async () => {
    const github = new FakeGitHub();
    github.refusesRulesets = true;
    const refused = await checkRepoRules(github, INPUT);
    const calls = github.calls.length;
    expect(enforcesRulesets(refused)).toBe(false);
    expect(github.calls.length).toBe(calls);

    expect(enforcesRulesets(await checkRepoRules(new FakeGitHub(), INPUT))).toBe(true);
    expect(enforcesRulesets([])).toBeNull();
  });
});

describe('an environment GitHub would not show', () => {
  const environmentPath = (environment: string) => `/repos/${INPUT.fullName}/environments/${environment}`;
  const putsTo = (github: FakeGitHub, environment: string) =>
    github.calls.filter((call) => call.method === 'PUT' && call.path === environmentPath(environment));

  it('is not written at all when the read fails and the write would have failed too', async () => {
    // The auditor's sandbox: a 502 on the read, a 422 on the write, and then a
    // bare `PUT {}` that took production's rules off.
    const github = new FakeGitHub();
    github.environmentReadFailure = 502;
    github.environmentFailure = '422: {"message":"Validation Failed"}';

    const outcomes = await applyRepoRules(github, INPUT);

    expect(putsTo(github, 'production')).toEqual([]);
    expect(outcomes.find((outcome) => outcome.name === 'environment production')).toMatchObject({
      action: 'skipped',
      detail: expect.stringMatching(/^could not read it, so nothing was written: GitHub answered 502/),
    });
  });

  it.each([403, 502])('sends no PUT of any kind to it when the read answers %i', async (status) => {
    const github = new FakeGitHub();
    github.environmentReadFailure = status;

    await applyRepoRules(github, INPUT);

    for (const environment of ['testing', 'production', 'production-rollback']) {
      expect(putsTo(github, environment)).toEqual([]);
    }
  });

  it('still gets a bare environment when it is not there and the write fails', async () => {
    const github = new FakeGitHub();
    github.environmentFailure = '502: Bad Gateway';

    await applyRepoRules(github, INPUT);

    expect(putsTo(github, 'production').map((call) => call.body)).toContainEqual({});
  });

  it('keeps a reviewer production already holds when the read fails for a moment', async () => {
    const github = new FakeGitHub();
    const held = {
      protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', id: 1 }] }],
      deployment_branch_policy: { protected_branches: true },
    };
    github.environments.set('production', held);
    github.environmentReadFailure = 502;
    // A refusal the old path answered by writing again without the reviewer.
    github.refusesReviewers = true;

    await applyRepoRules(github, INPUT);

    expect(github.environments.get('production')).toEqual(held);
  });

  it('is reported by the check as a read that failed, in GitHub’s words, not as absent', async () => {
    const github = new FakeGitHub();
    github.environmentReadFailure = 502;

    const reports = await checkRepoRules(github, INPUT);
    const production = reports.find((report) => report.name === 'environment production');

    expect(production?.detail).not.toBe(ENVIRONMENT_ABSENT);
    expect(production?.detail).toBe('the environment could not be read: GitHub answered 502: Server Error');
  });
});

describe('what GitHub said, as a person reads it', () => {
  it('is the message, without the path or the JSON around it', () => {
    const cause = new Error(
      '/repos/exampleco/app/environments/testing → 422: {"message":"Failed to create the environment protection rule. ' +
        'Please ensure the billing plan supports the required reviewers protection rule.","documentation_url":"https://docs.github.com"}',
    );
    expect(githubSaid(cause)).toBe(
      'GitHub answered 422: Failed to create the environment protection rule. Please ensure the billing plan supports the required reviewers protection rule.',
    );
  });

  it('keeps the status when GitHub gave no message, and survives text cut short', () => {
    expect(githubSaid(new Error('/repos/exampleco/app/environments/testing → 502: Bad Gateway'))).toBe('GitHub answered 502: Bad Gateway');
    expect(githubSaid(new Error('/repos/x/environments/testing → 422: {"message":"Failed to create the rule. Please ensure'))).toBe(
      'GitHub answered 422: Failed to create the rule. Please ensure',
    );
  });

  it('keeps the permission a 403 says the app needs', () => {
    const cause = new Error(
      '/repos/exampleco/app/environments/testing → 403: {"message":"Resource not accessible by integration","documentation_url":"https://docs.github.com"} x-accepted-github-permissions: administration=write',
    );
    expect(githubSaid(cause)).toBe(
      'GitHub answered 403: Resource not accessible by integration. The app needs: administration=write',
    );
  });

  it('keeps what each of a 422’s errors says was wrong', () => {
    const cause = new Error(
      '/repos/exampleco/app/environments/production → 422: {"message":"Validation Failed","errors":[{"resource":"Environment","field":"wait_timer","code":"invalid"},"reviewers must be users or teams"],"documentation_url":"https://docs.github.com"}',
    );
    expect(githubSaid(cause)).toBe(
      'GitHub answered 422: Validation Failed (Environment wait_timer invalid; reviewers must be users or teams)',
    );
  });
});

describe('a plan’s refusal of a reviewer', () => {
  const WORDS = 'Please ensure the billing plan supports the required reviewers protection rule.';

  it('is read from the status the client writes, not from digits anywhere in the text', () => {
    expect(reviewerRefusedByPlan(new Error(`/repos/x/app/environments/production → 422: {"message":"${WORDS}"}`))).toBe(true);
    expect(reviewerRefusedByPlan(new Error(`/repos/x/app-422/environments/production → 500: {"message":"${WORDS}"}`))).toBe(false);
    expect(reviewerRefusedByPlan(new Error(`/repos/x/app/environments/production → 500: error 422: ${WORDS}`))).toBe(false);
  });
});

/**
 * What a ruleset applies to. Drift compared only its name, enforcement, bypass
 * and rules, so the main ruleset edited to leave out the default branch was
 * reported present, and apply never put it back.
 */
describe('what an OpenADLC ruleset applies to', () => {
  const applied = async (): Promise<FakeGitHub> => {
    const github = new FakeGitHub();
    github.workflows = ['ci.yml'];
    await applyRepoRules(github, INPUT);
    return github;
  };
  const named = (github: FakeGitHub, name: string) => github.rulesets.find((ruleset) => ruleset.name === name)!;
  const detailOf = (reports: Awaited<ReturnType<typeof checkRepoRules>>, name: string) => reports.find((report) => report.name === name)?.detail;
  const rulesetPuts = (github: FakeGitHub) => github.calls.filter((call) => call.method === 'PUT' && call.path.includes('/rulesets/'));

  it('is drift when the main ruleset no longer includes the default branch', async () => {
    const github = await applied();
    named(github, MAIN_RULESET).conditions = { ref_name: { include: ['refs/heads/does-not-exist'], exclude: [] } };

    const reports = await checkRepoRules(github, INPUT);
    expect(stateOf(reports, MAIN_RULESET)).toBe('drifted');
    expect(detailOf(reports, MAIN_RULESET)).toContain('conditions include ["refs/heads/does-not-exist"], missing ["~DEFAULT_BRANCH"]');
  });

  it('is drift when the main ruleset excludes the default branch', async () => {
    const github = await applied();
    named(github, MAIN_RULESET).conditions = { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: ['~DEFAULT_BRANCH'] } };

    const reports = await checkRepoRules(github, INPUT);
    expect(stateOf(reports, MAIN_RULESET)).toBe('drifted');
    expect(detailOf(reports, MAIN_RULESET)).toContain('conditions exclude ["~DEFAULT_BRANCH"], not []');
  });

  it('is drift when the agent branches ruleset targets tags', async () => {
    const github = await applied();
    named(github, AGENT_BRANCHES_RULESET).target = 'tag';

    const reports = await checkRepoRules(github, INPUT);
    expect(stateOf(reports, AGENT_BRANCHES_RULESET)).toBe('drifted');
    expect(detailOf(reports, AGENT_BRANCHES_RULESET)).toContain('target is tag, not branch');
  });

  it('is put back by apply', async () => {
    const github = await applied();
    named(github, MAIN_RULESET).conditions = { ref_name: { include: [], exclude: ['~DEFAULT_BRANCH'] } };
    named(github, AGENT_BRANCHES_RULESET).target = 'tag';
    github.calls.length = 0;

    const outcomes = await applyRepoRules(github, INPUT);
    expect(outcomes.find((outcome) => outcome.name === MAIN_RULESET)?.action).toBe('updated');
    expect(outcomes.find((outcome) => outcome.name === AGENT_BRANCHES_RULESET)?.action).toBe('updated');
    expect(rulesetPuts(github)).toHaveLength(2);
    expect(named(github, MAIN_RULESET).conditions).toEqual({ ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } });
    expect(stateOf(await checkRepoRules(github, INPUT), MAIN_RULESET)).toBe('present');
    expect(stateOf(await checkRepoRules(github, INPUT), AGENT_BRANCHES_RULESET)).toBe('present');
  });

  it('is not drift when GitHub lists the same branches in another order', async () => {
    const github = await applied();
    const agent = named(github, AGENT_BRANCHES_RULESET);
    agent.conditions = { ref_name: { include: [...(agent.conditions?.ref_name?.include ?? [])].reverse(), exclude: [] } };
    expect(agent.conditions.ref_name?.include?.[0]).toBe('refs/heads/system/**');
    github.calls.length = 0;

    expect(stateOf(await checkRepoRules(github, INPUT), AGENT_BRANCHES_RULESET)).toBe('present');
    expect((await applyRepoRules(github, INPUT)).find((outcome) => outcome.name === AGENT_BRANCHES_RULESET)?.action).toBe('unchanged');
    expect(rulesetPuts(github)).toHaveLength(0);
  });

  it('is not judged from the list entry alone, which has no conditions', async () => {
    const github = await applied();
    named(github, MAIN_RULESET).conditions = { ref_name: { include: [], exclude: ['~DEFAULT_BRANCH'] } };
    github.failsFullRulesetGet = true;
    github.calls.length = 0;

    expect(stateOf(await checkRepoRules(github, INPUT), MAIN_RULESET)).toBe('present');
    expect((await applyRepoRules(github, INPUT)).find((outcome) => outcome.name === MAIN_RULESET)?.action).toBe('unchanged');
    expect(rulesetPuts(github)).toHaveLength(0);
  });
});

/**
 * A repair used to `PUT` OpenADLC's ruleset whole, and GitHub replaces the
 * ruleset with the body: once anything declared drifted, every rule, branch
 * and required check a person had added was deleted, said only as `updated`.
 */
describe('repairing an OpenADLC ruleset keeps what a person added', () => {
  const applied = async (input: RepoRulesInput = INPUT): Promise<FakeGitHub> => {
    const github = new FakeGitHub();
    github.workflows = ['ci.yml'];
    await applyRepoRules(github, input);
    github.calls.length = 0;
    return github;
  };
  type Held = FakeGitHub['rulesets'][number] & { bypass_actors?: unknown[] };
  type Rule = { type: string; parameters?: Record<string, unknown> };
  const named = (github: FakeGitHub, name: string) => github.rulesets.find((ruleset) => ruleset.name === name) as Held;
  const rulesOf = (ruleset: { rules: unknown[] }) => ruleset.rules as Rule[];
  const checksOf = (ruleset: { rules: unknown[] }) =>
    rulesOf(ruleset).find((rule) => rule.type === 'required_status_checks')?.parameters?.required_status_checks as {
      context: string;
      integration_id?: number;
    }[];
  const putTo = (github: FakeGitHub, ruleset: Held) =>
    github.calls.filter((call) => call.method === 'PUT' && call.path === `/repos/${INPUT.fullName}/rulesets/${ruleset.id}`);
  const outcomeOf = (outcomes: Awaited<ReturnType<typeof applyRepoRules>>, name: string) => outcomes.find((outcome) => outcome.name === name);
  const desiredFor = (name: string, input: RepoRulesInput = INPUT) => (name === MAIN_RULESET ? mainRuleset(input) : agentBranchesRuleset(input.appId));

  /** A second apply changes nothing, and the body sent reads back as no drift. */
  async function settles(github: FakeGitHub, name: string, input: RepoRulesInput = INPUT): Promise<void> {
    const sent = github.calls.filter((call) => call.method === 'PUT' && call.path.includes('/rulesets/')).at(-1)?.body;
    expect(rulesetDrift(desiredFor(name, input) as never, sent as never, true)).toEqual([]);
    github.calls.length = 0;
    const again = await applyRepoRules(github, input);
    expect(outcomeOf(again, MAIN_RULESET)?.action).toBe('unchanged');
    expect(outcomeOf(again, AGENT_BRANCHES_RULESET)?.action).toBe('unchanged');
    expect(github.calls.filter((call) => call.method === 'PUT' && call.path.includes('/rulesets/'))).toHaveLength(0);
  }

  it('keeps a rule and a branch a person added when it repairs enforcement', async () => {
    const github = await applied();
    const main = named(github, MAIN_RULESET);
    main.rules.push({ type: 'code_scanning', parameters: { code_scanning_tools: [{ tool: 'CodeQL', security_alerts_threshold: 'high_or_higher', alerts_threshold: 'errors' }] } });
    main.conditions = { ref_name: { include: ['~DEFAULT_BRANCH', 'refs/heads/release/*'], exclude: [] } };
    main.enforcement = 'evaluate';

    const outcome = outcomeOf(await applyRepoRules(github, INPUT), MAIN_RULESET);
    expect(outcome?.action).toBe('updated');
    expect(outcome?.detail).toContain('enforcement');
    const [put] = putTo(github, main);
    const body = put?.body as Held;
    expect(rulesOf(body).map((rule) => rule.type)).toContain('code_scanning');
    expect(body.conditions?.ref_name?.include).toEqual(expect.arrayContaining(['~DEFAULT_BRANCH', 'refs/heads/release/*']));
    expect(body.enforcement).toBe('active');
    // Nothing GitHub only reads back is sent.
    expect(Object.keys(body).sort()).toEqual(['bypass_actors', 'conditions', 'enforcement', 'name', 'rules', 'target']);
    await settles(github, MAIN_RULESET);
  });

  it('keeps an extra required check, which is not drift', async () => {
    const github = await applied();
    const main = named(github, MAIN_RULESET);
    checksOf(main).push({ context: 'codeql' });

    expect(stateOf(await checkRepoRules(github, INPUT), MAIN_RULESET)).toBe('present');
    expect(outcomeOf(await applyRepoRules(github, INPUT), MAIN_RULESET)?.action).toBe('unchanged');

    main.enforcement = 'disabled';
    github.calls.length = 0;
    expect(outcomeOf(await applyRepoRules(github, INPUT), MAIN_RULESET)?.action).toBe('updated');
    expect(checksOf(putTo(github, main)[0]?.body as Held).map((check) => check.context)).toEqual([REQUIRED_CHECK, REVIEW_GATE_CHECK, 'codeql']);
    await settles(github, MAIN_RULESET);
  });

  it('puts back a required check of its own that is missing, keeping the extra one', async () => {
    const github = await applied();
    const main = named(github, MAIN_RULESET);
    const checks = checksOf(main);
    checks.splice(0, checks.length, { context: REQUIRED_CHECK }, { context: 'codeql' });

    const reports = await checkRepoRules(github, INPUT);
    expect(stateOf(reports, MAIN_RULESET)).toBe('drifted');
    expect(reports.find((report) => report.name === MAIN_RULESET)?.detail).toContain(REVIEW_GATE_CHECK);
    expect(outcomeOf(await applyRepoRules(github, INPUT), MAIN_RULESET)?.action).toBe('updated');
    expect(checksOf(named(github, MAIN_RULESET)).map((check) => check.context).sort()).toEqual([REQUIRED_CHECK, REVIEW_GATE_CHECK, 'codeql'].sort());
    await settles(github, MAIN_RULESET);
  });

  it('repins a check pinned to another app', async () => {
    const pinned = { ...INPUT, pinnedChecks: [REVIEW_GATE_CHECK] };
    const github = await applied(pinned);
    const main = named(github, MAIN_RULESET);
    checksOf(main).find((check) => check.context === REVIEW_GATE_CHECK)!.integration_id = 999;

    expect(stateOf(await checkRepoRules(github, pinned), MAIN_RULESET)).toBe('drifted');
    expect(outcomeOf(await applyRepoRules(github, pinned), MAIN_RULESET)?.action).toBe('updated');
    expect(checksOf(named(github, MAIN_RULESET)).find((check) => check.context === REVIEW_GATE_CHECK)?.integration_id).toBe(APP_ID);
    await settles(github, MAIN_RULESET, pinned);
  });

  it('puts back a branch it covers, keeping any other', async () => {
    const github = await applied();
    named(github, MAIN_RULESET).conditions = { ref_name: { include: ['refs/heads/release/*'], exclude: [] } };
    named(github, AGENT_BRANCHES_RULESET).conditions = { ref_name: { include: ['refs/heads/agent/**', 'refs/heads/bots/**'], exclude: [] } };

    const reports = await checkRepoRules(github, INPUT);
    expect(stateOf(reports, MAIN_RULESET)).toBe('drifted');
    expect(reports.find((report) => report.name === AGENT_BRANCHES_RULESET)?.detail).toContain('missing ["refs/heads/system/**"]');
    await applyRepoRules(github, INPUT);
    expect([...(named(github, MAIN_RULESET).conditions?.ref_name?.include ?? [])].sort()).toEqual(['refs/heads/release/*', '~DEFAULT_BRANCH']);
    expect([...(named(github, AGENT_BRANCHES_RULESET).conditions?.ref_name?.include ?? [])].sort()).toEqual([
      'refs/heads/agent/**',
      'refs/heads/bots/**',
      'refs/heads/system/**',
    ]);
    await settles(github, AGENT_BRANCHES_RULESET);
  });

  it('removes an exclude, and says which', async () => {
    const github = await applied();
    named(github, MAIN_RULESET).conditions = { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: ['refs/heads/hotfix/*'] } };

    expect(stateOf(await checkRepoRules(github, INPUT), MAIN_RULESET)).toBe('drifted');
    const outcome = outcomeOf(await applyRepoRules(github, INPUT), MAIN_RULESET);
    expect(outcome?.action).toBe('updated');
    expect(outcome?.detail).toContain('removed exclude "refs/heads/hotfix/*"');
    expect(named(github, MAIN_RULESET).conditions?.ref_name?.exclude).toEqual([]);
    await settles(github, MAIN_RULESET);
  });

  it('replaces a bypass someone added with its own', async () => {
    const github = await applied();
    named(github, MAIN_RULESET).bypass_actors = [
      { actor_id: APP_ID, actor_type: 'Integration', bypass_mode: 'always' },
      { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' },
    ];

    expect(stateOf(await checkRepoRules(github, INPUT), MAIN_RULESET)).toBe('drifted');
    expect(outcomeOf(await applyRepoRules(github, INPUT), MAIN_RULESET)?.action).toBe('updated');
    expect(named(github, MAIN_RULESET).bypass_actors).toEqual([{ actor_id: APP_ID, actor_type: 'Integration', bypass_mode: 'always' }]);
    await settles(github, MAIN_RULESET);
  });

  it('keeps a person’s rule when it renames a ruleset from before FleetADLC', async () => {
    const github = await applied();
    const main = named(github, MAIN_RULESET);
    main.name = 'fleet: main';
    main.rules.push({ type: 'required_deployments', parameters: { required_deployment_environments: ['staging'] } });

    expect(outcomeOf(await applyRepoRules(github, INPUT), MAIN_RULESET)?.action).toBe('updated');
    const renamed = named(github, MAIN_RULESET);
    expect(rulesOf(renamed).map((rule) => rule.type)).toContain('required_deployments');
    await settles(github, MAIN_RULESET);
  });

  it('sends nothing when it could read only the list entry, which has no rules to keep', async () => {
    const github = await applied();
    const main = named(github, MAIN_RULESET);
    main.rules.push({ type: 'code_scanning' });
    main.enforcement = 'evaluate';
    github.failsFullRulesetGet = true;
    github.listOmitsRules = true;

    const outcome = outcomeOf(await applyRepoRules(github, INPUT), MAIN_RULESET);
    expect(outcome?.action).toBe('skipped');
    expect(outcome?.detail).toContain('its rules could not be read');
    expect(putTo(github, main)).toHaveLength(0);
  });

  it('is built from what OpenADLC declares, never from GitHub’s read-only fields', () => {
    const desired = mainRuleset(INPUT);
    const { ruleset, removed } = repairedRuleset(desired, {
      ...desired,
      id: 3,
      source: 'exampleco/FleetADLC',
      _links: {},
      conditions: { ref_name: { include: [], exclude: ['~DEFAULT_BRANCH'] } },
    } as never);
    expect(ruleset).toEqual(desired);
    expect(removed).toEqual(['~DEFAULT_BRANCH']);
  });
});

describe('a ruleset named before the rename to FleetADLC', () => {
  it('is the same ruleset: reported as drifted, renamed by the next apply, never written twice', async () => {
    const github = new FakeGitHub();
    github.workflows = ['ci.yml'];
    await applyRepoRules(github, INPUT);
    for (const ruleset of github.rulesets) ruleset.name = ruleset.name.replace('fleetadlc: ', 'fleet: ');

    const reports = await checkRepoRules(github, INPUT);
    expect(stateOf(reports, MAIN_RULESET)).toBe('drifted');
    expect(reports.find((report) => report.name === MAIN_RULESET)?.detail).toContain('named "fleet: main"');

    const outcomes = await applyRepoRules(github, INPUT);
    expect(outcomes.find((outcome) => outcome.name === MAIN_RULESET)?.action).toBe('updated');
    expect(github.rulesets.map((ruleset) => ruleset.name).sort()).toEqual([AGENT_BRANCHES_RULESET, MAIN_RULESET].sort());
    expect(stateOf(await checkRepoRules(github, INPUT), MAIN_RULESET)).toBe('present');
  });
});

/**
 * Production is held the way the repository's delivery rules say. With
 * `approval: auto` nobody is asked: the environment carries no reviewer and
 * the soak as its wait timer, and OpenADLC never approves it either way.
 * Before the rules, every apply wrote the person as reviewer, so a repository
 * that chose to ship on a soak was turned back into one that waits for a
 * person on the next apply.
 */
describe('the production environment follows the delivery rules', () => {
  const AUTO: RepoRulesInput = { ...INPUT, production: { approval: 'auto', soakMinutes: 30 } };

  it('writes no reviewer and the soak as the wait timer when the rules say auto', async () => {
    const github = new FakeGitHub();
    await applyRepoRules(github, AUTO);
    const put = github.calls.find((call) => call.method === 'PUT' && call.path.endsWith('/environments/production'));
    expect(put?.body).toMatchObject({ wait_timer: 30, reviewers: [] });
    expect(put?.body).not.toHaveProperty('prevent_self_review');
    expect(stateOf(await checkRepoRules(github, AUTO), 'environment production')).toBe('present');
  });

  it('still writes the person, and prevents self review, when the rules say reviewers', async () => {
    const github = new FakeGitHub();
    await applyRepoRules(github, { ...INPUT, production: { approval: 'reviewers', soakMinutes: 30 } });
    const put = github.calls.find((call) => call.method === 'PUT' && call.path.endsWith('/environments/production'));
    expect(put?.body).toMatchObject({ wait_timer: 0, prevent_self_review: true, reviewers: [{ type: 'User', id: 1001 }] });
  });

  describe('production reviewers when nobody may be named', () => {
    const NOBODY = { ...INPUT, humans: [], productionReviewers: [], production: { approval: 'reviewers' as const, soakMinutes: 0 } };
    const productionPuts = (github: FakeGitHub) =>
      github.calls.filter((call) => call.method === 'PUT' && call.path.endsWith('/environments/production'));

    it('names the approvers it was given on production by numeric id', async () => {
      const github = new FakeGitHub();
      const outcomes = await applyRepoRules(github, { ...NOBODY, productionReviewers: ['alex-maintainer'] });
      expect(productionPuts(github).map((call) => (call.body as { reviewers?: unknown }).reviewers)).toEqual([[{ type: 'User', id: 77120 }]]);
      expect(outcomes.find((one) => one.name === 'environment production')?.action).toBe('created');
    });

    it('keeps a reviewer production already holds, and never sends an empty list', async () => {
      const github = new FakeGitHub();
      github.environments.set('production', {
        protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { id: 1 } }] }],
        deployment_branch_policy: { protected_branches: true },
      });
      const outcomes = await applyRepoRules(github, NOBODY);

      expect(outcomes.find((one) => one.name === 'environment production')).toMatchObject({ action: 'unchanged' });
      // The reviewer stays. The branch policy is still written: this used to
      // return before it, and production kept admitting every protected branch.
      expect(productionPuts(github)).toHaveLength(1);
      expect(productionPuts(github)[0]?.body).toMatchObject({
        reviewers: [{ type: 'User', id: 1 }],
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      });
      expect(productionPuts(github)[0]?.body).not.toHaveProperty('reviewers', []);
      expect(github.environments.get('production')?.protection_rules).toEqual([expect.objectContaining({ type: 'required_reviewers' })]);
      expect(github.environments.get('production')?.deployment_branch_policy).toMatchObject({ custom_branch_policies: true });
      expect(github.branchPolicies.get('production')).toEqual([expect.objectContaining({ name: 'main', type: 'branch' })]);
    });

    it('holds an existing production with no reviewer to the default branch, and sends no reviewer list', async () => {
      const github = new FakeGitHub();
      github.environments.set('production', {
        protection_rules: [],
        deployment_branch_policy: { protected_branches: true },
      });
      const outcomes = await applyRepoRules(github, NOBODY);

      expect(outcomes.find((one) => one.name === 'environment production')).toMatchObject({ action: 'skipped' });
      expect(productionPuts(github)).toHaveLength(1);
      expect(productionPuts(github)[0]?.body).not.toHaveProperty('reviewers');
      expect(github.environments.get('production')?.deployment_branch_policy).toMatchObject({ custom_branch_policies: true });
      expect(github.environments.get('production')?.protection_rules).toEqual([]);
      expect(github.branchPolicies.get('production')).toEqual([expect.objectContaining({ name: 'main', type: 'branch' })]);
    });

    it('makes a new production with its branch policy and no reviewer list, and says how to name one', async () => {
      const github = new FakeGitHub();
      const outcomes = await applyRepoRules(github, NOBODY);

      const production = outcomes.find((one) => one.name === 'environment production');
      expect(production).toMatchObject({ action: 'skipped', detail: NO_PRODUCTION_REVIEWER });
      expect(production?.detail).toContain('fleetadlc github apply --production reviewers --reviewer <login>');
      expect(productionPuts(github)).toHaveLength(1);
      expect(productionPuts(github).some((call) => Array.isArray((call.body as { reviewers?: unknown }).reviewers))).toBe(false);
    });

    it('names a login GitHub does not know, and writes no list without it', async () => {
      const github = new FakeGitHub();
      const outcomes = await applyRepoRules(github, { ...NOBODY, productionReviewers: ['janedoe', 'no-such-person'] });

      const production = outcomes.find((one) => one.name === 'environment production');
      expect(production?.action).toBe('skipped');
      expect(production?.detail).toContain('no-such-person');
      expect(productionPuts(github).some((call) => Array.isArray((call.body as { reviewers?: unknown }).reviewers))).toBe(false);
    });

    it('says what to do in the check when nobody is named', async () => {
      const github = new FakeGitHub();
      github.environments.set('production', { protection_rules: [], deployment_branch_policy: null });
      const report = (await checkRepoRules(github, NOBODY)).find((one) => one.name === 'environment production');
      expect(report?.state).toBe('drifted');
      expect(report?.detail).toContain('Choose who approves production in repository setup');
      expect(report?.detail).toContain('no branch policy');
    });
  });

  it('calls a reviewer left on an auto environment drift', async () => {
    const github = new FakeGitHub();
    await applyRepoRules(github, INPUT);
    const report = (await checkRepoRules(github, AUTO)).find((one) => one.name === 'environment production');
    expect(report?.state).toBe('drifted');
    expect(report?.detail).toContain('needs no approval');
  });

  it('keeps the wait timer within what GitHub accepts', () => {
    expect(productionWaitTimer({ production: { approval: 'auto', soakMinutes: 99_999 } })).toBe(43_200);
    expect(productionWaitTimer({ production: { approval: 'reviewers', soakMinutes: 30 } })).toBe(0);
    expect(productionWaitTimer({})).toBe(0);
  });
});

/**
 * GitHub takes an environment's reviewer by numeric user id. A login there was
 * a 422 that took a new production to a bare environment: no reviewer, no
 * branch policy, and every promote ran with nobody approving.
 */
describe('production’s reviewer, named by GitHub user id', () => {
  const productionPuts = (github: FakeGitHub) =>
    github.calls.filter((call) => call.method === 'PUT' && call.path.endsWith('/environments/production'));

  it('looks the login up and sends its id, which GitHub accepts', async () => {
    const github = new FakeGitHub();
    const outcomes = await applyRepoRules(github, INPUT);

    expect(github.wrote('GET', '/users/janedoe')).toBe(true);
    expect(productionPuts(github)[0]?.body).toMatchObject({ reviewers: [{ type: 'User', id: 1001 }] });
    expect(outcomes.find((one) => one.name === 'environment production')?.action).toBe('created');
    expect(stateOf(await checkRepoRules(github, INPUT), 'environment production')).toBe('present');
  });

  for (const [what, answer] of [
    ['no such account', undefined],
    ['an organization', { login: 'janedoe', id: 5, type: 'Organization' }],
    ['a bot', { login: 'janedoe', id: 6, type: 'Bot' }],
    ['no answer from GitHub', 502],
    ['no user id', { login: 'janedoe', type: 'User' }],
  ] as const) {
    it(`gives a new production its branch policy and no reviewer when the login is ${what}, and names the login`, async () => {
      const github = new FakeGitHub();
      if (answer === undefined) github.users.delete('janedoe');
      else github.users.set('janedoe', answer as never);

      const outcomes = await applyRepoRules(github, INPUT);
      const production = outcomes.find((one) => one.name === 'environment production');

      expect(production?.action).toBe('skipped');
      expect(production?.detail).toContain('could not resolve janedoe');
      expect(productionPuts(github).map((call) => call.body)).not.toContainEqual({});
      // No reviewer list at all: an empty one would take off a reviewer somebody added by hand.
      expect(productionPuts(github).every((call) => !('reviewers' in (call.body as object)))).toBe(true);
      expect(github.environments.get('production')?.deployment_branch_policy).not.toBeNull();
      expect(github.environments.get('production')?.protection_rules).toEqual([]);
    });
  }

  it('keeps the reviewer production already holds when the login cannot be looked up, and says so', async () => {
    const github = new FakeGitHub();
    github.users.delete('janedoe');
    // As a GET lists it: `{type, reviewer:{id}}`.
    github.environments.set('production', {
      protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { id: 7 } }] }],
      deployment_branch_policy: { protected_branches: true },
    });

    const outcomes = await applyRepoRules(github, INPUT);

    // Not skipped, and not "no required reviewer": GitHub still holds one. A
    // skipped production step read later as unheld would hold promotes twice.
    const production = outcomes.find((one) => one.name === 'environment production');
    expect(production).toMatchObject({
      action: 'unchanged',
      detail: expect.stringContaining('keeps the required reviewer it already holds'),
    });
    expect(production?.detail).toContain('could not resolve janedoe');
    expect(production?.detail).not.toContain('no required reviewer');
    expect(productionPuts(github)).toHaveLength(1);
    expect(productionPuts(github)[0]?.body).toMatchObject({
      reviewers: [{ type: 'User', id: 7 }],
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    });
    expect(github.environments.get('production')?.protection_rules).toEqual([
      { type: 'required_reviewers', reviewers: [{ type: 'User', id: 7 }] },
    ]);
    expect(github.environments.get('production')?.deployment_branch_policy).toMatchObject({ custom_branch_policies: true });
    expect(github.branchPolicies.get('production')).toEqual([expect.objectContaining({ name: 'main', type: 'branch' })]);
  });

  it('asks nobody’s id where no reviewer is sent: auto, or a private repository on a plan that refuses rulesets', async () => {
    const auto = new FakeGitHub();
    await applyRepoRules(auto, { ...INPUT, production: { approval: 'auto', soakMinutes: 30 } });
    expect(auto.calls.some((call) => call.path.startsWith('/users/'))).toBe(false);

    const free = new FakeGitHub({ owner: { type: 'Organization' }, private: true });
    free.refusesRulesets = true;
    free.refusesProtectionRules = true;
    await applyRepoRules(free, INPUT);
    expect(free.calls.some((call) => call.path.startsWith('/users/'))).toBe(false);
  });
});

describe('what the plan state is remembered under', () => {
  function api(rulesets: () => unknown): RuleApi {
    return {
      request: async <T>(_method: string, path: string): Promise<T> => {
        if (path === '/repos/acme/app') return { private: true, owner: { type: 'User' } } as T;
        if (path === '/repos/acme/app/rulesets') return rulesets() as T;
        throw new Error(`unexpected ${path}`);
      },
    };
  }

  it('reads a 2xx as the plan allowing rulesets', async () => {
    expect(await repositoryPlanState(api(() => []), 'acme/app')).toEqual({ private: true, rulesetsRefused: false });
  });

  it('reads the plan’s 403 as rulesets refused', async () => {
    const refused = api(() => {
      throw new Error('/repos/acme/app/rulesets → 403: {"message":"Upgrade to GitHub Pro or make this repository public to enable this feature."}');
    });
    expect(await repositoryPlanState(refused, 'acme/app')).toEqual({ private: true, rulesetsRefused: true });
  });

  it('does not read a failed rulesets request as the plan allowing them', async () => {
    const failed = api(() => {
      throw new Error('/repos/acme/app/rulesets → 502: Bad Gateway');
    });
    expect(await repositoryPlanState(failed, 'acme/app')).toBeNull();
  });
});

describe('what an apply is audited with', () => {
  it('names the rulesets the plan refused apart from what else was skipped', () => {
    expect(
      rulesAppliedPayload([
        { name: MAIN_RULESET, action: 'skipped', detail: PLAN_REFUSES_RULESETS },
        { name: 'required status checks', action: 'skipped', detail: 'nothing publishes ci' },
        { name: 'CODEOWNERS', action: 'created', detail: '' },
      ]),
    ).toEqual({
      outcomes: [`skipped ${MAIN_RULESET}`, 'skipped required status checks', 'created CODEOWNERS'],
      planRefused: [MAIN_RULESET],
    });
  });
});
