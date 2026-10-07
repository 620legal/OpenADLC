/**
 * The containment a managed repository is supposed to have, as code.
 *
 * It used to be prose in `docs/self-hosting.md` addressed to a person: create
 * this ruleset, restrict that branch, add a required reviewer. The platform's
 * own principle is that a rule an agent must remember will be forgotten and a
 * rule the system enforces will hold. So the rules are declared here, applied
 * from here, and checked from here.
 *
 * What GitHub will actually hold depends on the **plan**, not on who owns the
 * repository. On a private repository, rulesets hold on GitHub Pro (a person's
 * account), Team and Enterprise; CODEOWNERS on Pro and above; and a required
 * environment reviewer only on GitHub Enterprise. Where GitHub holds nothing, OpenADLC's
 * own gates still do — the review gate, the merge line, the scope and author
 * checks — and `checkRepoRules` says which of the two is carrying the weight
 * rather than implying the repository is unprotected.
 *
 * Nothing in this file decides policy. What `main` requires comes from the
 * review rules and the checks the install runs; this turns that into the shape
 * GitHub's API wants, and reports honestly when GitHub cannot express it.
 */

import { GitHubApiError } from './client.js';
import { accountOf } from './reviewers.js';

/** Just enough of `GitHubClient` to be faked in a test. */
export interface RuleApi {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
}

/** A label as GitHub lists it. */
export interface RepoLabel {
  name: string;
  color: string;
  description: string | null;
}

const LABELS_PAGE = 100;

/**
 * Every label a repository has, page by page. Only the first hundred were
 * read, and OpenADLC's own labels with GitHub's defaults and a repository's
 * own pass that: a legacy label past page one was not seen, so its new name
 * was created beside it instead of renaming it. A read that fails throws: an
 * empty list in its place planned every label as one to create.
 */
export async function listLabels(client: RuleApi, repoFullName: string): Promise<RepoLabel[]> {
  const labels: RepoLabel[] = [];
  for (let page = 1; ; page += 1) {
    const listed = await client.request<RepoLabel[]>('GET', `/repos/${repoFullName}/labels?per_page=${LABELS_PAGE}&page=${page}`);
    labels.push(...listed);
    if (listed.length < LABELS_PAGE) return labels;
  }
}

export interface RepoRulesInput {
  /** `owner/name`. */
  fullName: string;
  defaultBranch: string;
  /** Status checks that must pass. Callers pass `[REQUIRED_CHECK, REVIEW_GATE_CHECK]` from @fleetadlc/shared, where the names are stated. */
  requiredChecks: string[];
  /**
   * Of those, the ones only the app may satisfy: required from `appId` alone
   * (`integration_id`), so no other token's status or check of the same name
   * counts. `review-gate`, once the app publishes it as a check run.
   */
  pinnedChecks?: string[];
  /** The account whose review `main` requires, as a code owner. */
  leadReviewer: string;
  /**
   * The crew's own logins. A code owner line naming one of them that is not
   * the lead reviewer is a seat that changed hands since CODEOWNERS was
   * written, not a decision somebody made; see `staleCodeOwner`.
   */
  crew?: string[];
  /**
   * The people who own the paths a bot may not change. Never the
   * organization's own name: it was the fallback while nobody was named, and
   * an organization cannot review — every line naming it waited for good.
   */
  humans: string[];
  /** Logins that may deploy to production; a bot may never approve its own. */
  productionReviewers: string[];
  /**
   * What holds production, from the repository's delivery rules
   * (`.github/fleetadlc.yml`): `reviewers` is the people above, `auto` is no
   * reviewer and a wait timer of the soak. Absent is `reviewers`. Either way
   * OpenADLC never approves the environment: GitHub's rule is the gate.
   */
  production?: { approval: 'reviewers' | 'auto'; soakMinutes: number };
  /**
   * The GitHub App's own id, so it can be named as a bypass actor.
   *
   * Without this, `apply` locks itself out: the `main` ruleset requires a pull
   * request, and the very next thing it does is write CODEOWNERS straight to the
   * default branch — which the rule it just created refuses with a 409. Measured
   * on a real repository, where it left the branch protected and the file absent.
   *
   * This grants the app nothing it did not already have. It holds
   * `administration: write` and can rewrite or delete the ruleset outright; a
   * declared bypass makes that capability explicit instead of implicit, and is
   * what lets OpenADLC repair a file it owns on a branch it protected. The token
   * never reaches a task — see `app-auth.ts`.
   */
  appId?: number;
}

export type RuleState = 'present' | 'drifted' | 'missing' | 'unsupported';

export interface RuleReport {
  /** Stable identifier, so drift can be reported against a name. */
  name: string;
  state: RuleState;
  /** What is wrong, or what GitHub will not express. Empty, or what was found, when present. */
  detail: string;
}

/** Rulesets OpenADLC owns. Anything else on the repository is left alone. */
export const MAIN_RULESET = 'fleetadlc: main';
export const AGENT_BRANCHES_RULESET = 'fleetadlc: agent and system branches';

/**
 * What each ruleset was called before the rename to FleetADLC. A repository
 * that already has one under its old name has the ruleset: it is found by
 * either name, reported as drifted, and renamed by the next apply — never
 * created a second time beside the first.
 */
const LEGACY_RULESET_NAMES: Readonly<Record<string, string>> = {
  [MAIN_RULESET]: 'fleet: main',
  [AGENT_BRANCHES_RULESET]: 'fleet: agent and system branches',
};

const AGENT_REFS = ['refs/heads/agent/**', 'refs/heads/system/**'];

interface Ruleset {
  id?: number;
  name: string;
  target: string;
  enforcement: string;
  conditions?: { ref_name?: { include?: string[]; exclude?: string[] } } | null;
  /** Who may act outside this ruleset; OpenADLC's own app, so it can repair what it owns. */
  bypass_actors?: { actor_id: number; actor_type: string; bypass_mode: string }[];
  rules: { type: string; parameters?: Record<string, unknown> }[];
}

/** OpenADLC's own app, named so it can maintain the files this ruleset depends on. */
export function bypassForApp(appId?: number): { actor_id: number; actor_type: string; bypass_mode: string }[] {
  return appId ? [{ actor_id: appId, actor_type: 'Integration', bypass_mode: 'always' }] : [];
}

/**
 * What `main` must require. `required_linear_history` and `non_fast_forward`
 * together are what make history append-only; `required_signatures` is why every
 * bot has its own signing key. The review rule asks for a code owner
 * specifically, because an approving review from a bot that is not the lead
 * reviewer must not satisfy it.
 */
export function mainRuleset(input: RepoRulesInput): Ruleset {
  return {
    name: MAIN_RULESET,
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    bypass_actors: bypassForApp(input.appId),
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      { type: 'required_linear_history' },
      { type: 'required_signatures' },
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 1,
          require_code_owner_review: true,
          // Off, because the merge line merges the base into a branch before
          // landing it: that changes the head and not the work, and GitHub's
          // dismissal would clear every approval it did that to. OpenADLC
          // dismisses an approval itself when the diff changed (`dismissReview`).
          dismiss_stale_reviews_on_push: false,
          // Off, for the same reason as the line above. The merge line brings a
          // pull request up to date with the builder's account before landing
          // it, and GitHub counts that merge from the base as a push the last
          // approval must come after — so every pull request whose base moved
          // waited for a review nobody was asked for. The review gate is what
          // asks again, and it asks when the diff changed, not the base.
          require_last_push_approval: false,
          required_review_thread_resolution: true,
          allowed_merge_methods: ['squash'],
        },
      },
      {
        type: 'required_status_checks',
        parameters: {
          // "Branches up to date" is what makes the merge line's base merge
          // meaningful rather than decorative.
          strict_required_status_checks_policy: true,
          required_status_checks: input.requiredChecks.map((context) =>
            input.appId && input.pinnedChecks?.includes(context) ? { context, integration_id: input.appId } : { context },
          ),
        },
      },
    ],
  };
}

/**
 * `agent/**` and `system/**` are the namespaces bots push to. Restricting
 * *update* rather than creation is deliberate: a builder must be able to open
 * its own branch, and must not be able to rewrite another's.
 */
export function agentBranchesRuleset(appId?: number): Ruleset {
  return {
    name: AGENT_BRANCHES_RULESET,
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: AGENT_REFS, exclude: [] } },
    bypass_actors: bypassForApp(appId),
    rules: [{ type: 'non_fast_forward' }, { type: 'deletion' }],
  };
}

export function codeownersBody(input: RepoRulesInput): string {
  const people = input.humans.map((login) => `@${login}`).join(' ');
  return [
    '# Generated by `fleetadlc github apply`. Edit freely: who owns what is a decision,',
    '# not a default, so apply leaves your lines alone. It rewrites only a `*` line that',
    '# names crew no longer leading review, and a line owned by nothing but the',
    '# organization, which GitHub cannot ask for a review.',
    '#',
    '# The lead reviewer owns everything, which is what makes the "review from a',
    '# code owner" rule on `main` mean their review specifically.',
    `*       @${input.leadReviewer}`,
    '',
    '# A person owns what a bot may not change without one: configuration,',
    '# infrastructure and the workflows that build and ship it.',
    ...(people
      ? [`/config/             ${people}`, `/infra/              ${people}`, `/.github/workflows/  ${people}`]
      : ['# Nobody was named when this was written: add who owns /config/, /infra/', '# and /.github/workflows/ here.']),
    '',
  ].join('\n');
}

/** The owners of `*`, the line every path falls back to; the last one wins, as GitHub reads it. */
export function everythingOwners(body: string): string[] | null {
  let owners: string[] | null = null;
  for (const raw of body.split('\n')) {
    const [pattern, ...rest] = raw.replace(/#.*$/, '').trim().split(/\s+/);
    if (pattern === '*') owners = rest.map((owner) => owner.replace(/^@/, ''));
  }
  return owners;
}

/**
 * The accounts CODEOWNERS makes the owner of everything when they are crew
 * that no longer holds the lead reviewer's seat, or null when it names the
 * lead reviewer — or a person, whose name there is a decision.
 *
 * CODEOWNERS is written once, naming whoever held the seat that day. When the
 * seat changed hands, every pull request waited for a review from the intake
 * bot, which never reviews: `main` requires a code owner's approval, and the
 * code owner was an account with no reason to give one.
 */
export function staleCodeOwner(body: string, input: Pick<RepoRulesInput, 'leadReviewer' | 'crew'>): string[] | null {
  const owners = everythingOwners(body);
  if (!owners || owners.length === 0) return null;
  const lead = input.leadReviewer.toLowerCase();
  if (owners.some((owner) => owner.toLowerCase() === lead)) return null;
  const crew = new Set((input.crew ?? []).map((login) => login.toLowerCase()));
  return owners.every((owner) => crew.has(owner.toLowerCase())) ? owners : null;
}

/** The same file with `*` owned by the lead reviewer, and every other line as it was. */
export function withCodeOwner(body: string, leadReviewer: string): string {
  return body
    .split('\n')
    .map((raw) => (raw.replace(/#.*$/, '').trim().split(/\s+/)[0] === '*' ? raw.replace(/^(\s*\*\s+)\S.*$/, `$1@${leadReviewer}`) : raw))
    .join('\n');
}

/**
 * The lines of a CODEOWNERS that are OpenADLC's to bring up to date, and the
 * file with them brought up to date: `*` when it names crew no longer leading the
 * review, and any line owned by nothing but the repository's organization.
 *
 * The organization's name was written when no person was known. GitHub takes
 * a team (`@org/team`) or a person as a code owner, never an organization, so
 * those lines asked for a review nobody could give. Somebody's own line —
 * a person, a team, several owners — is a decision, and stays.
 */
export function codeownersRepair(
  body: string,
  input: Pick<RepoRulesInput, 'leadReviewer' | 'crew' | 'humans'>,
  organization: string | null,
): { body: string; said: string[] } | null {
  const org = organization?.toLowerCase() ?? null;
  const onlyOrg = (owners: string[]) => org !== null && owners.length > 0 && owners.every((owner) => owner.toLowerCase() === org);
  const staleCrew = staleCodeOwner(body, input);
  const said: string[] = [];
  const lines = body.split('\n').map((raw) => {
    const [pattern, ...rest] = raw.replace(/#.*$/, '').trim().split(/\s+/);
    if (!pattern || rest.length === 0) return raw;
    const owners = rest.map((owner) => owner.replace(/^@/, ''));
    const replace = (logins: string[]) => {
      if (logins.map((login) => login.toLowerCase()).join(' ') === owners.map((owner) => owner.toLowerCase()).join(' ')) return raw;
      said.push(`${pattern}: ${owners.map((owner) => `@${owner}`).join(' ')} → ${logins.map((login) => `@${login}`).join(' ')}`);
      return raw.replace(/^(\s*\S+\s+)\S.*$/, `$1${logins.map((login) => `@${login}`).join(' ')}`);
    };
    if (pattern === '*') {
      if (input.leadReviewer && (onlyOrg(owners) || (staleCrew && owners.length === staleCrew.length))) return replace([input.leadReviewer]);
      return raw;
    }
    return onlyOrg(owners) && input.humans.length > 0 ? replace(input.humans) : raw;
  });
  return said.length > 0 ? { body: lines.join('\n'), said } : null;
}

function decoded(file: { content?: string } | null): string {
  return file?.content ? Buffer.from(file.content, 'base64').toString('utf8') : '';
}

/** Where GitHub looks for CODEOWNERS, in the order it looks: it uses the first it finds. */
const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'] as const;

/** A CODEOWNERS path as a person reads it: the root one says so. */
function codeownersPlace(path: string): string {
  return path === 'CODEOWNERS' ? 'CODEOWNERS (root)' : path;
}

/**
 * The CODEOWNERS GitHub reads, found where GitHub looks for it.
 *
 * Only `.github/CODEOWNERS` was read, and any failure was taken as absent. A
 * repository that kept its file at the root or in `docs/` was told it had
 * none, and applying wrote a `.github/CODEOWNERS` naming the lead reviewer for
 * everything — which GitHub then read first, so the repository's own code
 * owners stopped being required. Only a 404 is absent now; anything else is
 * unreadable, and nothing is written over it.
 */
async function codeownersFile(
  api: RuleApi,
  fullName: string,
): Promise<
  | { state: 'found'; path: string; body: string; sha?: string }
  | { state: 'absent' }
  | { state: 'unreadable'; path: string; said: string }
> {
  for (const path of CODEOWNERS_PATHS) {
    try {
      const file = await api.request<{ content?: string; sha?: string }>('GET', `/repos/${fullName}/contents/${path}`);
      return { state: 'found', path, body: decoded(file), ...(file?.sha ? { sha: file.sha } : {}) };
    } catch (cause) {
      if (cause instanceof GitHubApiError && cause.status === 404) continue;
      return { state: 'unreadable', path, said: githubSaid(cause) };
    }
  }
  return { state: 'absent' };
}

/**
 * The environments OpenADLC writes. `production-rollback` is the rollback's
 * own: no reviewer and no wait, so a rollback never waits, and held to the
 * default branch like the others, so the credential that shifts production's
 * traffic is not one any workflow on any branch can read.
 */
const ENVIRONMENTS = ['testing', 'production', 'production-rollback'] as const;
type Environment = (typeof ENVIRONMENTS)[number];

/**
 * An environment's branch policy: custom, so it can name the default branch
 * alone (`holdToDefaultBranch` adds that one policy). It was
 * `protected_branches: true`, which admits every protected branch, and the
 * crew's own `agent/**` and `system/**` are protected by OpenADLC's ruleset:
 * a workflow pushed to a bot's branch could deploy, or read the environment's
 * secrets.
 */
const DEFAULT_BRANCH_ONLY = { protected_branches: false, custom_branch_policies: true };

/** A deployment branch policy as GitHub lists it. */
interface BranchPolicy {
  id: number;
  name: string;
  /** `branch` or `tag`; absent on an older answer, which knew branches only. */
  type?: string;
}

function branchPoliciesPath(fullName: string, environment: string): string {
  return `/repos/${fullName}/environments/${environment}/deployment-branch-policies`;
}

async function branchPoliciesOf(api: RuleApi, fullName: string, environment: string): Promise<BranchPolicy[]> {
  const listed = await api.request<{ branch_policies?: BranchPolicy[] }>('GET', `${branchPoliciesPath(fullName, environment)}?per_page=100`);
  return listed.branch_policies ?? [];
}

function namesDefaultBranch(policy: BranchPolicy, defaultBranch: string): boolean {
  return policy.name === defaultBranch && (policy.type ?? 'branch') === 'branch';
}

/**
 * Holds a production that already exists to the default branch without
 * replacing its reviewers. The two paths that cannot name a reviewer used to
 * return before this, so an upgraded install kept `protected_branches: true`:
 * every protected branch, the crew's own included, could deploy to production.
 * A reviewer GitHub already holds is sent back by id; one it does not is left
 * off the payload, because an empty list would take a hand-added reviewer off.
 * What GitHub said when it refused, or null.
 */
async function holdExistingProduction(api: RuleApi, input: RepoRulesInput, existing: EnvironmentRead): Promise<string | null> {
  const reviewerRule = existing.protection_rules?.find((rule) => rule.type === 'required_reviewers');
  // GitHub lists a reviewer as `{type, reviewer:{id}}`, not a top-level id.
  // Reading the id where a PUT puts it saw nobody, skipped the policy, and
  // left every protected branch able to deploy.
  const reviewers = (reviewerRule?.reviewers ?? []).flatMap((one) => {
    const entry = one as { type?: string; reviewer?: { id?: unknown } };
    return typeof entry.reviewer?.id === 'number' ? [{ type: entry.type ?? 'User', id: entry.reviewer.id }] : [];
  });
  if ((reviewerRule?.reviewers?.length ?? 0) > 0 && reviewers.length !== reviewerRule?.reviewers?.length) {
    return 'its reviewers could not be read back, so its branch policy was not written';
  }
  const timer = existing.protection_rules?.find((rule) => rule.type === 'wait_timer')?.wait_timer ?? 0;
  const payload: Record<string, unknown> = { wait_timer: timer, deployment_branch_policy: DEFAULT_BRANCH_ONLY };
  if (reviewers.length > 0) {
    // Kept as GitHub holds it. Forcing it on changed a setting this call is
    // only here to write the branch policy around.
    if (typeof reviewerRule?.prevent_self_review === 'boolean') payload.prevent_self_review = reviewerRule.prevent_self_review;
    payload.reviewers = reviewers;
  }
  try {
    await api.request('PUT', `/repos/${input.fullName}/environments/production`, payload);
    return await holdToDefaultBranch(api, input, 'production');
  } catch (cause) {
    return githubSaid(cause);
  }
}

/**
 * Holds an environment to the default branch alone: adds the policy naming it
 * and removes every other. GitHub takes a policy only once the environment's
 * branch policy is custom, so this runs after the environment is written.
 * Null when done, or what GitHub said.
 */
async function holdToDefaultBranch(api: RuleApi, input: RepoRulesInput, environment: string): Promise<string | null> {
  try {
    const policies = await branchPoliciesOf(api, input.fullName, environment);
    if (!policies.some((policy) => namesDefaultBranch(policy, input.defaultBranch))) {
      await api.request('POST', branchPoliciesPath(input.fullName, environment), { name: input.defaultBranch, type: 'branch' });
    }
    for (const policy of policies.filter((one) => !namesDefaultBranch(one, input.defaultBranch))) {
      await api.request('DELETE', `${branchPoliciesPath(input.fullName, environment)}/${policy.id}`);
    }
    return null;
  } catch (cause) {
    return githubSaid(cause);
  }
}

/**
 * What lets an environment deploy from anything but the default branch, or
 * null when nothing does. Said the same way of every environment.
 */
async function branchPolicyProblem(
  api: RuleApi,
  input: RepoRulesInput,
  environment: string,
  policy: { protected_branches?: boolean; custom_branch_policies?: boolean } | null | undefined,
): Promise<string | null> {
  const main = `\`${input.defaultBranch}\``;
  if (policy?.protected_branches === true) {
    return `its branch policy admits every protected branch, not ${main} alone, and the crew's own branches are protected too`;
  }
  if (policy?.custom_branch_policies !== true) return `no branch policy, so a deploy need not have gone through ${main}`;
  let policies: BranchPolicy[];
  try {
    policies = await branchPoliciesOf(api, input.fullName, environment);
  } catch (cause) {
    return `its branch policies could not be read: ${githubSaid(cause)}`;
  }
  const problems: string[] = [];
  if (!policies.some((one) => namesDefaultBranch(one, input.defaultBranch))) problems.push(`no branch policy names ${main}`);
  const others = policies.filter((one) => !namesDefaultBranch(one, input.defaultBranch));
  if (others.length > 0) {
    problems.push(`it also admits ${others.map((one) => `${one.type === 'tag' ? 'tag ' : ''}\`${one.name}\``).join(', ')}`);
  }
  return problems.length > 0 ? problems.join('; ') : null;
}

/**
 * What an environment is written with. `reviewerIds` are production's
 * reviewers as GitHub's numeric user ids, looked up from their logins: GitHub
 * types `reviewers[].id` as an integer and refused a login there with a 422,
 * which left a new production with no reviewer and no branch policy at all.
 */
function environmentPayload(input: RepoRulesInput, environment: Environment, reviewerIds: number[] = []): unknown {
  if (environment === 'testing' || environment === 'production-rollback') {
    // The SRE deploys testing on its own, and a rollback waits for nobody;
    // the branch policy is what stops either running from anything that
    // never went through the default branch.
    return {
      wait_timer: 0,
      reviewers: [],
      deployment_branch_policy: DEFAULT_BRANCH_ONLY,
    };
  }
  if (input.production?.approval === 'auto') {
    // The repository's rules say no person approves production: the promote
    // waits only the soak, which GitHub holds as the environment's wait timer
    // (at most 30 days). Nobody — and no bot — approves anything.
    return {
      wait_timer: productionWaitTimer(input),
      reviewers: [],
      deployment_branch_policy: DEFAULT_BRANCH_ONLY,
    };
  }
  return {
    wait_timer: 0,
    // A person approves production. A bot cannot approve its own deploy, which
    // is why this list is people and the check below reports it emptying out.
    prevent_self_review: true,
    reviewers: reviewerIds.map((id) => ({ type: 'User', id })),
    deployment_branch_policy: DEFAULT_BRANCH_ONLY,
  };
}

/**
 * What is said when production's rules say a person approves and nobody can
 * be named: no reviewer list is written, since an empty one would take off a
 * reviewer somebody added by hand and leave production waiting for nobody.
 */
export const NO_PRODUCTION_REVIEWER =
  'nobody is named to approve production, so its reviewers were not written. Choose who approves production in ' +
  'repository setup (the walkthrough’s Protect step), or run `fleetadlc github apply --production reviewers --reviewer <login>`';

/**
 * Each login's GitHub user id, or the first login that has none and why. Only
 * a person's account is an environment reviewer OpenADLC names: `humans` are
 * people, and a team would need a permission the app does not hold.
 */
async function reviewerIdsOf(api: RuleApi, logins: string[]): Promise<{ ids: number[] } | { unresolved: string; reason: string }> {
  const ids: number[] = [];
  for (const login of logins) {
    const account = await accountOf(api, login);
    if (account === null) return { unresolved: login, reason: 'GitHub did not say who that is' };
    if (account === false) return { unresolved: login, reason: 'there is no such GitHub account; correct `humans`' };
    if (account.type !== 'User') {
      const kind = account.type === 'Organization' ? 'an organization' : `a ${account.type} account`;
      return { unresolved: login, reason: `it is ${kind}, not a person; correct \`humans\`` };
    }
    if (account.id === undefined) return { unresolved: login, reason: 'GitHub gave no user id for it' };
    ids.push(account.id);
  }
  return { ids };
}

/** The production wait timer the rules call for, in GitHub's minutes and within its 30-day limit. */
export function productionWaitTimer(input: Pick<RepoRulesInput, 'production'>): number {
  if (input.production?.approval !== 'auto') return 0;
  return Math.max(0, Math.min(43_200, Math.round(input.production.soakMinutes)));
}

async function listRulesets(api: RuleApi, fullName: string): Promise<Ruleset[]> {
  return api.request<Ruleset[]>('GET', `/repos/${fullName}/rulesets`).catch(() => []);
}

/**
 * The plan state a refusal is remembered under: whether the repository is
 * private, and whether GitHub refuses it rulesets. A repository made public,
 * or moved to a plan that holds rulesets, changes it. Null when GitHub did not
 * say.
 */
export async function repositoryPlanState(
  api: RuleApi,
  fullName: string,
): Promise<{ private: boolean; rulesetsRefused: boolean } | null> {
  const owner = await ownerKind(api, fullName);
  if (!owner) return null;
  const rulesetsRefused = await rulesetsRefusedByPlan(api, fullName);
  // A read that failed is not "the plan allows rulesets". Treating it as
  // allowed dropped the remembered production limit on one 502, and the next
  // promote then had nothing holding it.
  if (rulesetsRefused === null) return null;
  return { private: owner.private, rulesetsRefused };
}

/**
 * Whether GitHub's plan refuses rulesets on this repository, asked by listing
 * them. Only a 2xx is "not refused". The plan's own 403 is "refused". Any
 * other failure did not say, and is not taken as permission.
 */
async function rulesetsRefusedByPlan(api: RuleApi, fullName: string): Promise<boolean | null> {
  try {
    await api.request<unknown>('GET', `/repos/${fullName}/rulesets`);
    return false;
  } catch (cause) {
    return refusedByPlan(cause) ? true : null;
  }
}

/**
 * The ruleset by this name or its old one, and whether it is the full ruleset
 * or only its entry in the list, which is what is left when the full read
 * fails. The list form omits `rules` and `conditions`.
 */
async function rulesetByName(
  api: RuleApi,
  fullName: string,
  name: string,
): Promise<{ ruleset: Ruleset; full: boolean } | null> {
  const listed = await listRulesets(api, fullName);
  const legacy = LEGACY_RULESET_NAMES[name];
  const found =
    listed.find((candidate) => candidate.name === name) ?? (legacy ? listed.find((candidate) => candidate.name === legacy) : undefined);
  if (!found?.id) return null;
  return api
    .request<Ruleset>('GET', `/repos/${fullName}/rulesets/${found.id}`)
    .then((ruleset) => ({ ruleset, full: true }))
    .catch(() => ({ ruleset: found, full: false }));
}

/**
 * Compares only what OpenADLC declares, so a rule someone else added is not
 * drift, nor is an extra branch the ruleset covers or an extra required check.
 * `full` is false when only the list entry could be read: it has no
 * conditions, and reading that as an empty list would rewrite the ruleset on
 * every pass.
 */
export function rulesetDrift(desired: Ruleset, actual: Ruleset, full: boolean): string[] {
  const problems: string[] = [];
  if (actual.name && actual.name !== desired.name) {
    problems.push(`named "${actual.name}", not "${desired.name}"`);
  }
  if (actual.enforcement !== desired.enforcement) {
    problems.push(`enforcement is ${actual.enforcement}, not ${desired.enforcement}`);
  }

  /**
   * What the ruleset applies to, which this did not compare either. The main
   * ruleset edited to exclude the default branch, in an incident and never put
   * back, left main unprotected while the check said `present` and apply
   * `unchanged`. A branch someone added is theirs and stays; a branch
   * OpenADLC covers that is gone, or any exclude, is drift: an exclude is how
   * the default branch gets carved back out. The order of a list is GitHub's,
   * not a difference.
   */
  if (full) {
    if (actual.target !== desired.target) problems.push(`target is ${actual.target}, not ${desired.target}`);
    const included = actual.conditions?.ref_name?.include ?? [];
    const missing = (desired.conditions?.ref_name?.include ?? []).filter((ref) => !included.includes(ref));
    if (missing.length > 0) {
      problems.push(`conditions include ${JSON.stringify([...included].sort())}, missing ${JSON.stringify(missing)}`);
    }
    const allowed = desired.conditions?.ref_name?.exclude ?? [];
    const excluded = (actual.conditions?.ref_name?.exclude ?? []).filter((ref) => !allowed.includes(ref));
    if (excluded.length > 0) {
      problems.push(`conditions exclude ${JSON.stringify([...excluded].sort())}, not ${JSON.stringify(allowed)}`);
    }
  }

  /**
   * Who may act outside the ruleset, which this did not compare at all.
   *
   * That made the bypass unreachable on any repository that already had the
   * ruleset: drift saw `enforcement` and `rules` matching, reported no problems,
   * and never sent the update that would have added it — so a repository OpenADLC
   * had already locked itself out of stayed locked out. It is also worth
   * noticing in its own right: a bypass quietly added to a ruleset is somebody
   * granted an exemption from it.
   */
  const bypassOf = (ruleset: Ruleset): string =>
    JSON.stringify(
      [...(ruleset.bypass_actors ?? [])]
        .map((actor) => `${actor.actor_type}:${actor.actor_id}:${actor.bypass_mode}`)
        .sort(),
    );
  if (bypassOf(actual) !== bypassOf(desired)) {
    problems.push(`bypass actors are ${bypassOf(actual)}, not ${bypassOf(desired)}`);
  }

  const actualByType = new Map(actual.rules?.map((rule) => [rule.type, rule]) ?? []);
  for (const rule of desired.rules) {
    const present = actualByType.get(rule.type);
    if (!present) {
      problems.push(`missing rule ${rule.type}`);
      continue;
    }
    for (const [key, value] of Object.entries(rule.parameters ?? {})) {
      const actualValue = (present.parameters ?? {})[key];
      if (rule.type === 'required_status_checks' && key === 'required_status_checks') {
        // A check someone else requires, such as `codeql`, is theirs and not
        // drift; each of OpenADLC's has to be there, pinned as it says.
        const held = new Map(statusChecksOf(actualValue).map((check) => [check.context, check]));
        const lacking = statusChecksOf(value).filter(
          (check) => !held.has(check.context) || held.get(check.context)?.integration_id !== check.integration_id,
        );
        if (lacking.length > 0) problems.push(`${rule.type}.${key} is ${JSON.stringify(actualValue)}, lacking ${JSON.stringify(lacking)}`);
        continue;
      }
      if (JSON.stringify(actualValue) !== JSON.stringify(value)) {
        problems.push(`${rule.type}.${key} is ${JSON.stringify(actualValue)}, not ${JSON.stringify(value)}`);
      }
    }
  }
  return problems;
}

type StatusCheck = { context: string; integration_id?: number };

function statusChecksOf(value: unknown): StatusCheck[] {
  return Array.isArray(value) ? value.filter((check): check is StatusCheck => typeof (check as StatusCheck)?.context === 'string') : [];
}

/**
 * What a repair sends: OpenADLC's ruleset laid over the one GitHub holds.
 *
 * A `PUT` replaces the whole ruleset, and sending `desired` as it was deleted
 * everything a person had added to it, a `code_scanning` rule, a
 * `refs/heads/release/*` branch or a required `codeql` check, whenever any
 * declared setting drifted, saying only `updated`. So the name, target,
 * enforcement and bypass actors are OpenADLC's; every rule it does not
 * declare stays, in order; a declared rule keeps the parameters it had with
 * OpenADLC's laid over them; required checks are the union, OpenADLC's entry
 * winning where both name a context so pinning holds; and the branches are
 * OpenADLC's plus any other included. Excludes are dropped, and named in
 * `removed`. Built from `existing`'s fields one by one, never spread: the full
 * read carries `id`, `source`, `_links` and other fields a `PUT` does not take.
 */
export function repairedRuleset(desired: Ruleset, existing: Ruleset): { ruleset: Ruleset; removed: string[] } {
  const declared = new Map(desired.rules.map((rule) => [rule.type, rule]));
  const kept = new Set<string>();
  const rules: Ruleset['rules'] = [];
  for (const rule of existing.rules ?? []) {
    const ours = declared.get(rule.type);
    if (!ours) {
      rules.push(rule);
      continue;
    }
    if (kept.has(rule.type)) continue;
    kept.add(rule.type);
    rules.push(mergedRule(ours, rule));
  }
  for (const rule of desired.rules) if (!kept.has(rule.type)) rules.push(rule);

  const desiredRefs = desired.conditions?.ref_name ?? {};
  const existingRefs = existing.conditions?.ref_name ?? {};
  const include = [...(desiredRefs.include ?? [])];
  for (const ref of existingRefs.include ?? []) if (!include.includes(ref)) include.push(ref);
  const exclude = [...(desiredRefs.exclude ?? [])];
  const removed = (existingRefs.exclude ?? []).filter((ref) => !exclude.includes(ref));

  return {
    ruleset: {
      name: desired.name,
      target: desired.target,
      enforcement: desired.enforcement,
      conditions: { ref_name: { include, exclude } },
      bypass_actors: desired.bypass_actors,
      rules,
    },
    removed,
  };
}

function mergedRule(desired: Ruleset['rules'][number], existing: Ruleset['rules'][number]): Ruleset['rules'][number] {
  if (!desired.parameters && !existing.parameters) return { type: desired.type };
  const parameters: Record<string, unknown> = { ...(existing.parameters ?? {}), ...(desired.parameters ?? {}) };
  if (desired.type === 'required_status_checks' && desired.parameters && 'required_status_checks' in desired.parameters) {
    const ours = statusChecksOf(desired.parameters.required_status_checks);
    const contexts = new Set(ours.map((check) => check.context));
    parameters.required_status_checks = [
      ...ours,
      ...statusChecksOf(existing.parameters?.required_status_checks).filter((check) => !contexts.has(check.context)),
    ];
  }
  return { type: desired.type, parameters };
}

/** The repository's organization, when an organization owns it. */
function organizationOf(fullName: string, owner: { personal: boolean } | null): string | null {
  return owner && !owner.personal ? (fullName.split('/')[0] ?? null) : null;
}

/**
 * Whether the target can express what OpenADLC asks of it. A private repository
 * owned by a user has no environment reviewers on a free plan, and saying so is
 * the difference between a check that passed and a repository that is protected.
 */
async function ownerKind(
  api: RuleApi,
  fullName: string,
): Promise<{ personal: boolean; private: boolean; autoMerge: boolean | null } | null> {
  return api
    .request<{ owner?: { type?: string }; private?: boolean; allow_auto_merge?: boolean }>('GET', `/repos/${fullName}`)
    .then((repo) => ({
      personal: repo.owner?.type !== 'Organization',
      private: repo.private === true,
      // Only said to an account that administers the repository; unsaid is not "off".
      autoMerge: typeof repo.allow_auto_merge === 'boolean' ? repo.allow_auto_merge : null,
    }))
    .catch(() => null);
}

/**
 * Why a repository allows auto-merge, said the same way by the reader and the
 * writer. OpenADLC's merge line lands a pull request itself, as the app, and a
 * session's `gh` refuses auto-merge; it is GitHub's auto-merge that lands one
 * only in a repository whose merges were handed back to GitHub (`bridgeMergeOff`).
 * The reason said here was the builder's, from before the merge line merged.
 */
const AUTO_MERGE_WHY =
  'for a repository whose merges are handed to GitHub (bridgeMergeOff): auto-merge then lands a pull request once ' +
  'its rules pass. OpenADLC’s own merge line does not need it';

/** What the reader and the writer say of a plan that offers no auto-merge on a private repository. */
const AUTO_MERGE_UNSUPPORTED =
  'GitHub’s plan does not offer auto-merge on a private repository — a paid plan does. OpenADLC’s merge line lands ' +
  'pull requests as its app without it; only a repository whose merges are handed to GitHub (bridgeMergeOff) would ' +
  'wait for a person';

/**
 * Reports each rule as present, drifted, missing or unsupported. Reads only —
 * this is what `fleetadlc github check` runs, and what tells an operator whether the
 * containment they think they have is there.
 */
export async function checkRepoRules(api: RuleApi, input: RepoRulesInput): Promise<RuleReport[]> {
  const reports: RuleReport[] = [];
  const owner = await ownerKind(api, input.fullName);

  if (!owner) {
    return [{ name: 'repository', state: 'missing', detail: `${input.fullName} is not reachable by this account` }];
  }

  const wanted = await desiredRulesets(api, input);
  if (wanted.unpublishable) {
    // Missing, not merely unsupported: the merge line lands a pull request only
    // once `ci` has passed on it, so with nothing to publish it nothing lands.
    // Applying writes the workflow from the templates and then requires it.
    reports.push({ name: 'required status checks', state: 'missing', detail: unpublishableDetail(input) });
  }

  const refused = await rulesetsRefusedByPlan(api, input.fullName);
  // A private repository on a plan that holds none of GitHub's protections,
  // as GitHub says by refusing rulesets (`refusedByPlan`). The plan decides,
  // not who owns the repository: this used to count every private repository
  // a person owns as limited, though GitHub Pro holds rulesets there, and a
  // free organization's only once it refused.
  const limited = owner.private && refused;
  for (const desired of wanted.rulesets) {
    if (refused) {
      reports.push({ name: desired.name, state: 'unsupported', detail: PLAN_REFUSES_RULESETS });
      continue;
    }
    const actual = await rulesetByName(api, input.fullName, desired.name);
    if (!actual) {
      reports.push({ name: desired.name, state: 'missing', detail: 'no ruleset by this name' });
      continue;
    }
    const problems = rulesetDrift(desired, actual.ruleset, actual.full);
    reports.push(
      problems.length === 0
        ? { name: desired.name, state: 'present', detail: '' }
        : { name: desired.name, state: 'drifted', detail: problems.join('; ') },
    );
  }

  for (const environment of ENVIRONMENTS) {
    const read = await readEnvironment(api, input.fullName, environment);
    if (read.state === 'absent') {
      reports.push({ name: `environment ${environment}`, state: 'missing', detail: ENVIRONMENT_ABSENT });
      continue;
    }
    if (read.state === 'unreadable') {
      reports.push({ name: `environment ${environment}`, state: 'missing', detail: `${ENVIRONMENT_UNREADABLE}: ${read.said}` });
      continue;
    }
    const actual = read.environment;

    if (environment === 'testing' || environment === 'production-rollback') {
      /**
       * That the environment exists was the whole of this check, and existing is
       * not the same as guarding anything. On a plan that will not hold an
       * environment protection rule, GitHub creates the environment and refuses
       * the rules — leaving exactly what `environmentPayload` calls "the branch
       * policy that stops it deploying something that never went through
       * `main`" absent, and this reporting it as present.
       *
       * Measured on a private user-owned repository: `protection_rules: []`,
       * `deployment_branch_policy: null`, reported `present`.
       */
      const name = `environment ${environment}`;
      const problems: string[] = [];
      if (environment === 'production-rollback') {
        // A rollback that waits for a person, or a timer, is not a rollback.
        const reviewers = actual.protection_rules?.find((rule) => rule.type === 'required_reviewers')?.reviewers?.length ?? 0;
        const timer = actual.protection_rules?.find((rule) => rule.type === 'wait_timer')?.wait_timer ?? 0;
        if (reviewers > 0) problems.push(`${reviewers} required reviewer(s), though a rollback waits for nobody`);
        if (timer > 0) problems.push(`a wait timer of ${timer} minutes, though a rollback waits for nobody`);
      }
      const problem = await branchPolicyProblem(api, input, environment, actual.deployment_branch_policy);
      if (problem) problems.push(problem);
      if (problems.length === 0) {
        reports.push({ name, state: 'present', detail: '' });
      } else if (limited) {
        // Same shape as the production reviewer below: GitHub will not hold it
        // here, so the containment has to come from somewhere else.
        reports.push({ name, state: 'unsupported', detail: PLAN_LIMITS_ENVIRONMENTS });
      } else {
        reports.push({ name, state: 'drifted', detail: problems.join('; ') });
      }
      continue;
    }

    /**
     * Production's branch policy, read whatever holds it besides. A reviewer
     * was taken as the whole of it, so a production held to every protected
     * branch, or to none, read as present.
     */
    const branchProblem = () => branchPolicyProblem(api, input, environment, actual.deployment_branch_policy);
    const reviewerRule = actual.protection_rules?.find((rule) => rule.type === 'required_reviewers');
    const reviewers = reviewerRule?.reviewers?.length ?? 0;
    if (input.production?.approval === 'auto') {
      // The rules say no reviewer: production is held only by the soak. A
      // reviewer left on it is a promote that waits for a person the rules
      // said it does not, and a wait timer that is not the soak is a soak
      // the rules did not ask for.
      const timer = actual.protection_rules?.find((rule) => rule.type === 'wait_timer')?.wait_timer ?? 0;
      const want = productionWaitTimer(input);
      if (reviewers > 0) {
        reports.push({
          name: 'environment production',
          state: 'drifted',
          detail: `${reviewers} required reviewer(s), though the repository's rules say production needs no approval`,
        });
      } else if (timer !== want && !limited) {
        reports.push({ name: 'environment production', state: 'drifted', detail: `a wait timer of ${timer} minutes, not the rules' soak of ${want}` });
      } else {
        const problem = limited ? null : await branchProblem();
        reports.push(
          problem
            ? { name: 'environment production', state: 'drifted', detail: problem }
            : { name: 'environment production', state: 'present', detail: want > 0 ? `no reviewer; a ${want}-minute soak` : 'no reviewer' },
        );
      }
      continue;
    }
    if (reviewers > 0) {
      const problem = await branchProblem();
      reports.push(
        problem
          ? { name: 'environment production', state: 'drifted', detail: problem }
          : { name: 'environment production', state: 'present', detail: `${reviewers} required reviewer(s)` },
      );
    } else if (limited) {
      // Not a pass. GitHub will not hold this here, so the containment has to
      // come from somewhere else and somebody has to know that.
      // The plan decides this, not who owns the repository: on GitHub Free,
      // Pro and Team a required reviewer holds only on a public repository,
      // whether a person or an organization owns it. Moving a repository to
      // an organization on Team, which this used to suggest, changes nothing.
      // The same words as testing's, so the two are said once, not twice.
      reports.push({ name: 'environment production', state: 'unsupported', detail: PLAN_LIMITS_ENVIRONMENTS });
    } else if (owner.private && actual.deployment_branch_policy) {
      // A private repository whose plan holds the branch policy and not the
      // reviewer: GitHub Pro or Team, which is what `apply` leaves when GitHub
      // refuses the reviewer and keeps the policy. Reported `missing`, it was
      // a failing check on every run that no `apply` could fix. On GitHub
      // Enterprise, where a reviewer does hold, `apply` still adds it. A
      // policy that admits more than the default branch is still drift.
      const problem = await branchProblem();
      reports.push(
        problem
          ? { name: 'environment production', state: 'drifted', detail: `no required reviewer, and ${problem}` }
          : { name: 'environment production', state: 'unsupported', detail: PLAN_LIMITS_REVIEWER },
      );
    } else {
      // The reviewer is missing. The branch policy is judged here too: this
      // branch used to stop at the reviewer, so a production held to every
      // protected branch, or to none, was reported only as having no reviewer.
      const problem = await branchProblem();
      const reviewer =
        (owner.private
          ? 'no required reviewer, so a bot could promote to production unaccompanied; on a private repository ' +
            'GitHub holds one only on GitHub Enterprise, and `apply` says so if the plan refuses it'
          : 'no required reviewer, so a bot could promote to production unaccompanied') +
        (input.productionReviewers.length === 0 ? `. ${NO_PRODUCTION_REVIEWER[0]!.toUpperCase()}${NO_PRODUCTION_REVIEWER.slice(1)}` : '');
      reports.push(
        problem
          ? { name: 'environment production', state: 'drifted', detail: `${reviewer}; ${problem}` }
          : { name: 'environment production', state: 'missing', detail: reviewer },
      );
    }
  }

  const codeowners = await codeownersFile(api, input.fullName);
  const repair =
    codeowners.state === 'found' ? codeownersRepair(codeowners.body, input, organizationOf(input.fullName, owner)) : null;
  reports.push(
    codeowners.state === 'absent'
      ? {
          name: 'CODEOWNERS',
          state: 'missing',
          detail: 'without it, "review from a code owner" on `main` cannot be satisfied by anyone',
        }
      : codeowners.state === 'unreadable'
        ? {
            // Not missing: GitHub did not say it is absent, and applying
            // writes nothing until it can be read.
            name: 'CODEOWNERS',
            state: 'drifted',
            detail: `${codeownersPlace(codeowners.path)} could not be read, so whether it is there is not known: ${codeowners.said}`,
          }
        : repair
          ? {
              name: 'CODEOWNERS',
              state: 'drifted',
              detail:
                `${codeownersPlace(codeowners.path)} names code owners nobody can be — ${repair.said.join('; ')} — ` +
                'and a pull request waits for their review',
            }
          : { name: 'CODEOWNERS', state: 'present', detail: `GitHub reads ${codeownersPlace(codeowners.path)}` },
  );

  if (owner.autoMerge !== null) {
    reports.push(
      owner.autoMerge
        ? { name: 'auto-merge', state: 'present', detail: '' }
        : limited
          ? { name: 'auto-merge', state: 'unsupported', detail: AUTO_MERGE_UNSUPPORTED }
          : { name: 'auto-merge', state: 'missing', detail: AUTO_MERGE_WHY },
    );
  }

  if (owner.personal) {
    // Reported, not failed. Who owns the repository is not a fault to correct:
    // OpenADLC runs the same either way, and the one thing genuinely missing here
    // is the Triage role, which GitHub offers only on an organization.
    reports.push({
      name: 'triage role',
      state: 'unsupported',
      detail:
        'a user-owned repository has no Triage role, so intake and the automation account ' +
        'hold write; OpenADLC\u2019s own gates are what keep them from pushing',
    });
  }

  return reports;
}

export interface ApplyOutcome {
  name: string;
  /**
   * `unsupported`: GitHub's plan will not hold it, which no apply changes — a
   * fact about the plan, not something that went wrong. `skipped`: something
   * OpenADLC meant to do did not happen.
   */
  action: 'created' | 'updated' | 'unchanged' | 'skipped' | 'unsupported';
  detail: string;
}

/**
 * Whether anything in the repository could publish the checks the ruleset wants.
 *
 * A `required_status_checks` rule naming a check that no workflow produces is a
 * branch nobody can ever merge to: the pull request is required, the check is
 * required, and the check will never arrive. On a fresh repository — no
 * `.github/workflows` at all — that is exactly what `apply` created, and then it
 * could not write the workflow that would have fixed it, because it had just
 * required a pull request for writes.
 *
 * So the rule is left off until there is something to satisfy it, and said.
 */
async function checksArePublishable(api: RuleApi, fullName: string): Promise<boolean> {
  return api
    .request<unknown[]>('GET', `/repos/${fullName}/contents/.github/workflows`)
    .then((entries) => Array.isArray(entries) && entries.length > 0)
    .catch(() => false);
}

/**
 * What OpenADLC wants of this repository, decided once.
 *
 * The reader and the writer have to agree about this or the preview is a
 * different opinion from the change: computing the wanted rulesets separately
 * had `apply` leaving the status-check rule off and `check` then reporting the
 * ruleset it had just written as drifted.
 */
async function desiredRulesets(
  api: RuleApi,
  input: RepoRulesInput,
): Promise<{ rulesets: Ruleset[]; unpublishable: boolean }> {
  const main = mainRuleset(input);
  const unpublishable = !(await checksArePublishable(api, input.fullName));

  if (unpublishable) {
    const at = main.rules.findIndex((rule) => rule.type === 'required_status_checks');
    if (at >= 0) main.rules.splice(at, 1);
  }

  return { rulesets: [main, agentBranchesRuleset(input.appId)], unpublishable };
}

/** Said the same way by the reader and the writer. */
function unpublishableDetail(input: RepoRulesInput): string {
  return (
    `nothing in ${input.fullName} publishes ${input.requiredChecks.join(' or ')}, and the merge line lands a pull ` +
    'request only once they pass — so nothing lands. Applying writes a `ci` workflow that runs `make ci`, then requires it'
  );
}

/** What is said when GitHub's plan will not hold a ruleset on this repository. */
export const PLAN_REFUSES_RULESETS =
  'GitHub’s plan does not enforce rulesets on a private repository — a paid plan (GitHub Pro or Team) or a public ' +
  'repository does. Until then GitHub itself does not require the review or the checks; only OpenADLC’s merge line waits for them';

/**
 * What applying the rules is audited with (`repo.rules_applied`), by the
 * console and `fleetadlc github apply` alike: each outcome in a line, and
 * apart from them the rulesets skipped because the plan refused them. The
 * repo-rules check reads a plan's refusal live, so those are not taken as
 * refused for good: kept hidden, a ruleset the plan could hold by then was
 * reported as in place.
 */
export function rulesAppliedPayload(outcomes: readonly ApplyOutcome[]): { outcomes: string[]; planRefused: string[] } {
  return {
    outcomes: outcomes.map((one) => `${one.action} ${one.name}`),
    planRefused: outcomes.filter((one) => one.action === 'skipped' && one.detail === PLAN_REFUSES_RULESETS).map((one) => one.name),
  };
}

/** What the check says of an environment that is not there at all. */
export const ENVIRONMENT_ABSENT = 'the environment does not exist';

/** What the check says of an environment GitHub would not show: not the same as absent. */
export const ENVIRONMENT_UNREADABLE = 'the environment could not be read';

/** An environment as GitHub shows it. */
interface EnvironmentRead {
  protection_rules?: { type: string; reviewers?: unknown[]; wait_timer?: number; prevent_self_review?: boolean }[];
  deployment_branch_policy?: { protected_branches?: boolean; custom_branch_policies?: boolean } | null;
}

/**
 * An environment, read: found, absent (a 404 and nothing else), or a read
 * that failed, with what GitHub said.
 */
async function readEnvironment(
  api: RuleApi,
  fullName: string,
  environment: string,
): Promise<{ state: 'found'; environment: EnvironmentRead } | { state: 'absent' } | { state: 'unreadable'; said: string }> {
  try {
    return { state: 'found', environment: await api.request<EnvironmentRead>('GET', `/repos/${fullName}/environments/${environment}`) };
  } catch (cause) {
    return notFound(cause) ? { state: 'absent' } : { state: 'unreadable', said: githubSaid(cause) };
  }
}

/** Whether GitHub answered 404: by the error's status, or the status the client writes in its message. */
function notFound(cause: unknown): boolean {
  if (cause instanceof GitHubApiError) return cause.status === 404;
  if ((cause as { status?: unknown } | null)?.status === 404) return true;
  return /→\s*404:/.test(cause instanceof Error ? cause.message : String(cause));
}

/**
 * What is said of environments GitHub's plan will not protect at all — a
 * private repository on the free plan: neither testing's branch policy nor
 * production's reviewer. The words a person reads, never GitHub's path or
 * JSON; the same sentence for both environments, so the two are said once.
 * The environments are still created, because the deploy path targets them.
 */
export const PLAN_LIMITS_ENVIRONMENTS =
  'GitHub protects a private repository’s environments only on a paid plan, and holds a required reviewer on one ' +
  'only on GitHub Enterprise. The environments exist without protection: testing and production-rollback are not held to ' +
  'the default branch, ' +
  'and production has no required reviewer until the repository is public or on a plan that supports it. ' +
  'OpenADLC’s review gate and merge line still apply (its reviewers, CI, and a person only for the paths AGENTS.md ' +
  'names), but nothing on GitHub holds a deploy to production. So OpenADLC holds each production promote for a person ' +
  'in Needs you where the rules say a person approves (`approval: reviewers`), and holds the soak itself where they say `auto`.';

/**
 * What is said of production on a private repository whose plan holds its
 * branch policy and not its reviewer: GitHub Pro or Team.
 */
export const PLAN_LIMITS_REVIEWER =
  'GitHub holds a required reviewer on a private repository’s environment only on GitHub Enterprise, so production ' +
  'has no required reviewer until the repository is public or on a plan that supports it. It is held to the default ' +
  'branch, and OpenADLC’s review gate and merge line still apply (its reviewers, CI, and a person only for the paths ' +
  'AGENTS.md names), but nothing on GitHub holds a deploy to production. So OpenADLC holds each production promote for a ' +
  'person in Needs you where the rules say a person approves (`approval: reviewers`), and holds the soak itself where they say `auto`.';

/**
 * What GitHub said, as a sentence: the `message` of its JSON answer, with what
 * a person needs to act on it — each of its `errors`, and the permissions the
 * app would need (`x-accepted-github-permissions`, on a 403) — and without the
 * request path, the rest of the JSON or its documentation link.
 */
export function githubSaid(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  const head = /→\s*(\d{3}):?\s*/.exec(text);
  const status = head?.[1] ?? null;
  let body = head ? text.slice(head.index + head[0].length) : text;

  let accepted: string | null = null;
  const permissions = /\s*x-accepted-github-permissions:\s*(.+)$/i.exec(body);
  if (permissions) {
    accepted = (permissions[1] ?? '').trim() || null;
    body = body.slice(0, permissions.index);
  }
  body = body.trim();

  let message: string | null = null;
  let errors: string[] = [];
  try {
    const json = JSON.parse(body) as { message?: unknown; errors?: unknown };
    if (typeof json.message === 'string') message = json.message;
    if (Array.isArray(json.errors)) errors = json.errors.map(describeError).filter((one): one is string => Boolean(one));
  } catch {
    // Cut short, or not JSON: the message if it can be found, else the text.
    message = /"message"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(body)?.[1]?.replace(/\\"/g, '"') ?? null;
    if (message === null && !body.startsWith('{')) message = body || null;
  }

  const said = [
    message ?? 'GitHub refused it',
    errors.length > 0 ? ` (${errors.join('; ')})` : '',
    accepted ? `. The app needs: ${accepted}` : '',
  ].join('');
  return (status ? `GitHub answered ${status}: ${said}` : said).slice(0, 400);
}

/** One of GitHub's `errors`, in words: its message, or what field and why. */
function describeError(error: unknown): string | null {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return null;
  const one = error as { message?: unknown; field?: unknown; code?: unknown; resource?: unknown };
  if (typeof one.message === 'string' && one.message) return one.message;
  const parts = [one.resource, one.field, one.code].filter((part): part is string => typeof part === 'string' && part.length > 0);
  return parts.length > 0 ? parts.join(' ') : null;
}

/** Whether GitHub refused because of the account's plan, rather than anything OpenADLC sent. */
export function refusedByPlan(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /\b403\b/.test(message) && /upgrade to github (pro|team)|make this repository public/i.test(message);
}

/**
 * Whether GitHub refused an environment's required reviewer because of the
 * plan: a 422 naming the billing plan and the required reviewers rule. It holds
 * one on a private repository only on GitHub Enterprise.
 */
export function reviewerRefusedByPlan(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  // The status the client writes (`<path> → 422: <body>`), not a 422 anywhere
  // in the text — a path or a body can hold those digits.
  return /→\s*422:/.test(message) && /billing plan/i.test(message) && /required reviewers/i.test(message);
}

/**
 * Whether GitHub enforces rulesets on a repository, read from a report
 * `checkRepoRules` already made rather than asked again: every ruleset is
 * `unsupported` exactly when the plan refused them. Null when the report does
 * not say, because it holds no ruleset at all (GitHub did not answer, or the
 * repository is not reachable).
 *
 * This is the half of `limited` that decides whether a required check means
 * anything: a private repository on a plan that refuses rulesets holds no
 * required check, whoever publishes it.
 */
export function enforcesRulesets(reports: readonly RuleReport[]): boolean | null {
  const main = reports.find((report) => report.name === MAIN_RULESET);
  if (!main) return null;
  return main.state !== 'unsupported';
}

/**
 * Creates or updates what `checkRepoRules` looks for.
 *
 * Writes only what OpenADLC declares: an existing ruleset of the same name is
 * updated in place, CODEOWNERS is written when absent and otherwise only has
 * the lines `codeownersRepair` names brought up to date, and a rule GitHub
 * cannot express is skipped with a reason rather than approximated.
 */
/** What an apply that does not know the app's id says of a ruleset it would weaken. */
export const APP_UNKNOWN_DETAIL =
  'left as it is: it names the OpenADLC app as a bypass actor or pins a check to it, and the app could not be asked ' +
  'for its id here, so writing it would take those off. Apply the rules from the console’s Protect step, ' +
  'or run this where the app’s private key is';

/**
 * Whether a ruleset names an app as a bypass actor or pins a required check to
 * one. Written without the app's id, it would lose both: the app could no
 * longer write CODEOWNERS to the branch, and any account could set the gate.
 */
function holdsForApp(ruleset: Ruleset): boolean {
  // Read from the list's summary when the full ruleset could not be: what it
  // holds is not known, so it is not overwritten either.
  if (!Array.isArray(ruleset.rules)) return true;
  if ((ruleset.bypass_actors ?? []).some((actor) => actor.actor_type === 'Integration')) return true;
  return ruleset.rules.some((rule) => {
    const checks = rule.parameters?.required_status_checks;
    return Array.isArray(checks) && checks.some((check) => typeof (check as { integration_id?: unknown })?.integration_id === 'number');
  });
}

export async function applyRepoRules(api: RuleApi, input: RepoRulesInput): Promise<ApplyOutcome[]> {
  const outcomes: ApplyOutcome[] = [];
  const owner = await ownerKind(api, input.fullName);
  if (!owner) {
    return [{ name: 'repository', action: 'skipped', detail: `${input.fullName} is not reachable by this account` }];
  }

  /**
   * Whether the checks the ruleset wants can be produced at all. Asked before
   * the ruleset is written, because a rule requiring a check nothing publishes
   * is a branch that can never be merged to.
   */
  const wanted = await desiredRulesets(api, input);
  if (wanted.unpublishable) {
    outcomes.push({ name: 'required status checks', action: 'skipped', detail: unpublishableDetail(input) });
  }

  const refused = await rulesetsRefusedByPlan(api, input.fullName);
  for (const desired of wanted.rulesets) {
    if (refused) {
      outcomes.push({ name: desired.name, action: 'skipped', detail: PLAN_REFUSES_RULESETS });
      continue;
    }
    /**
     * GitHub's plan can refuse rulesets outright: a private repository on a
     * free plan answers 403 "Upgrade to GitHub Pro or make this repository
     * public". That used to throw out of here, so the environments, CODEOWNERS
     * and auto-merge after it were never written either — on every private
     * repository of a free organization. It is said, with GitHub's words, and
     * the rest goes on.
     */
    try {
      const found = await rulesetByName(api, input.fullName, desired.name);
      const existing = found?.ruleset;
      if (!found || !existing?.id) {
        await api.request('POST', `/repos/${input.fullName}/rulesets`, desired);
        outcomes.push({ name: desired.name, action: 'created', detail: `${desired.rules.length} rule(s)` });
        continue;
      }
      const problems = rulesetDrift(desired, existing, found.full);
      if (problems.length === 0) {
        outcomes.push({ name: desired.name, action: 'unchanged', detail: '' });
        continue;
      }
      // The list entry has no rules or conditions to keep, so a repair built
      // from it would delete what a person added, as `desired` alone did.
      if (!found.full) {
        outcomes.push({ name: desired.name, action: 'skipped', detail: `${problems.join('; ')}; not repaired: its rules could not be read` });
        continue;
      }
      if (!input.appId && holdsForApp(existing)) {
        outcomes.push({ name: desired.name, action: 'skipped', detail: APP_UNKNOWN_DETAIL });
        continue;
      }
      const repair = repairedRuleset(desired, existing);
      await api.request('PUT', `/repos/${input.fullName}/rulesets/${existing.id}`, repair.ruleset);
      const removed = repair.removed.map((ref) => `removed exclude ${JSON.stringify(ref)}`);
      outcomes.push({ name: desired.name, action: 'updated', detail: [...problems, ...removed].join('; ') });
    } catch (cause) {
      if (!refusedByPlan(cause)) throw cause;
      outcomes.push({ name: desired.name, action: 'skipped', detail: PLAN_REFUSES_RULESETS });
    }
  }

  for (const environment of ENVIRONMENTS) {
    const name = `environment ${environment}`;

    /**
     * Whether it is already there, asked before anything is written.
     *
     * The fallback below asks for a bare environment, and a bare `PUT` over an
     * environment that already has protection rules would take them off. So the
     * fallback is only for an environment that does not exist yet, where there
     * is nothing to lose and a deploy target to gain.
     */
    const read = await readEnvironment(api, input.fullName, environment);
    /**
     * Only a 404 says it is not there. A 5xx, a 403 or a rate limit read as
     * "absent" too, and when the payload `PUT` then failed, the bare `PUT {}`
     * went over the real environment: production lost its reviewer and its
     * branch policy, and the outcome did not say so. Nothing is written to an
     * environment that could not be read.
     */
    if (read.state === 'unreadable') {
      outcomes.push({ name, action: 'skipped', detail: `could not read it, so nothing was written: ${read.said}` });
      continue;
    }
    const existing = read.state === 'found' ? read.environment : null;
    const already = existing !== null;
    const hasReviewer = (existing?.protection_rules ?? []).some((rule) => rule.type === 'required_reviewers');

    /** A bare environment where there is none, so the deploy path has a target. */
    const bare = async (): Promise<string | null> =>
      already
        ? null
        : api
            .request('PUT', `/repos/${input.fullName}/environments/${environment}`, {})
            .then(() => null)
            .catch((cause: unknown) => githubSaid(cause));

    /**
     * A private repository on a plan that already refused rulesets holds no
     * environment protection either: its branch policy and its reviewer are
     * refused alike, with a 422 naming the billing plan. So neither is asked
     * for — on every apply, every repository, both environments, that was a
     * refusal said in GitHub's raw words and counted as needing attention.
     * The environment itself is still made, and the limit said once.
     */
    if (owner.private && refused) {
      const failed = await bare();
      outcomes.push(
        failed
          ? { name, action: 'skipped', detail: `could not be created: ${failed}` }
          : { name, action: 'unsupported', detail: PLAN_LIMITS_ENVIRONMENTS },
      );
      continue;
    }

    /**
     * Production's reviewers as GitHub's user ids, looked up only where one is
     * sent. A login that cannot be looked up is said by name, and never sent:
     * the refusal took production to a bare environment, with no reviewer and
     * no branch policy, reported only as skipped. A production that did not
     * exist gets its branch policy and no reviewer; one that did is held to the
     * default branch too, with the reviewers GitHub already holds sent back by
     * id, so a reviewer somebody added by hand is not taken off.
     *
     * Nobody to name is never a PUT with an empty reviewer list either. That
     * replaced the environment's rules, took off a reviewer added by hand, and
     * reported production as created with nobody to approve it: a reviewer
     * GitHub already holds is kept, and otherwise the step says who to name.
     */
    let reviewerIds: number[] = [];
    if (environment === 'production' && input.production?.approval !== 'auto') {
      const resolved = input.productionReviewers.length > 0 ? await reviewerIdsOf(api, input.productionReviewers) : null;
      if (!resolved || 'unresolved' in resolved) {
        // A login that could not be resolved over a reviewer GitHub already
        // holds is not production without one: that reviewer is sent back.
        const why = resolved
          ? hasReviewer
            ? `keeps the required reviewer it already holds: could not resolve ${resolved.unresolved} to a GitHub user to replace it: ${resolved.reason}`
            : `could not resolve ${resolved.unresolved} to a GitHub user, so production has no required reviewer: ${resolved.reason}`
          : hasReviewer
            ? 'keeps the required reviewer it already holds: nobody is named to replace it'
            : NO_PRODUCTION_REVIEWER;
        // The reviewer is what could not be written. The branch policy still
        // is: leaving it was how an install made before the policy changed
        // kept every protected branch able to deploy.
        if (already && existing) {
          const failed = await holdExistingProduction(api, input, existing);
          outcomes.push({
            name,
            action: failed ? 'skipped' : hasReviewer ? 'unchanged' : 'skipped',
            detail: failed ? `${why}. Its branch policy was refused too: ${failed}` : why,
          });
          continue;
        }
        // A new production: its branch policy, and no `reviewers` at all.
        const { reviewers: _none, ...noReviewer } = environmentPayload(input, environment, []) as Record<string, unknown>;
        const failed = await api
          .request('PUT', `/repos/${input.fullName}/environments/${environment}`, noReviewer)
          .then(() => holdToDefaultBranch(api, input, environment))
          .catch((cause: unknown) => githubSaid(cause));
        outcomes.push({ name, action: 'skipped', detail: failed ? `${why}. Its branch policy was refused too: ${failed}` : why });
        continue;
      }
      reviewerIds = resolved.ids;
    }

    /**
     * The environment written, its branch policy set to the default branch
     * alone. A policy GitHub refused is not a success: the environment would
     * admit no branch, or the ones it admitted before.
     */
    const heldOrSaid = async (outcome: ApplyOutcome): Promise<ApplyOutcome> => {
      const failed = await holdToDefaultBranch(api, input, environment);
      return failed
        ? { name, action: 'skipped', detail: `GitHub did not take its branch policy for \`${input.defaultBranch}\`: ${failed}` }
        : outcome;
    };

    const payload = environmentPayload(input, environment, reviewerIds) as { reviewers?: unknown[] };
    try {
      await api.request('PUT', `/repos/${input.fullName}/environments/${environment}`, payload);
      outcomes.push(await heldOrSaid({ name, action: 'created', detail: '' }));
    } catch (cause) {
      /**
       * A plan that will not hold a protection rule refuses the whole call.
       * This used to throw out of `applyRepoRules` entirely, so one environment
       * GitHub would not protect cost the caller everything after it — the
       * second environment, CODEOWNERS and every template. Measured against a
       * private user-owned repository: nine things went unwritten because of
       * one 422.
       */
      const byPlan = reviewerRefusedByPlan(cause);

      // A reviewer is the rule most plans refuse on a private repository — it
      // holds there only on GitHub Enterprise, where GitHub Pro and Team hold
      // the branch policy. So a refused reviewer is asked again without it,
      // keeping the branch policy, before settling for a bare environment:
      // a person's private repository on Pro used to lose its policy here.
      //
      // Only on the plan's refusal, and only while the environment holds no
      // reviewer yet. Any other failure — a 5xx, a 422 about something else —
      // says nothing about the plan, and asking again without the reviewer
      // would take off one GitHub already holds.
      let refusal: unknown = cause;
      if ((payload.reviewers?.length ?? 0) > 0 && byPlan && !hasReviewer) {
        const retry = await api
          .request('PUT', `/repos/${input.fullName}/environments/${environment}`, { ...payload, reviewers: [] })
          .then(() => null)
          .catch((again: unknown) => again ?? new Error('GitHub refused it'));
        if (retry === null) {
          outcomes.push(await heldOrSaid({ name, action: 'unsupported', detail: PLAN_LIMITS_REVIEWER }));
          continue;
        }
        // Refused again: the plan refusing the branch policy too is still
        // the plan's limit; anything else is a failure, and said as one —
        // never remembered as a limit nobody asks about again.
        refusal = retry;
      }

      const failed = await bare();
      if (failed) {
        outcomes.push({ name, action: 'skipped', detail: `could not be created: ${failed}` });
      } else if (reviewerRefusedByPlan(refusal) && !hasReviewer) {
        // The plan's limit, not a failure: said as one, in words.
        outcomes.push({ name, action: 'unsupported', detail: PLAN_LIMITS_ENVIRONMENTS });
      } else if (refusal !== cause) {
        outcomes.push({
          name,
          action: 'skipped',
          detail: `GitHub refused the reviewer on this plan, and then the environment without it: ${githubSaid(refusal)}`,
        });
      } else {
        outcomes.push({
          name,
          action: 'skipped',
          detail: `the environment is there but GitHub did not take its rules: ${githubSaid(cause)}`,
        });
      }
    }
  }

  const existingOwners = await codeownersFile(api, input.fullName);
  const repair =
    existingOwners.state === 'found'
      ? codeownersRepair(existingOwners.body, input, organizationOf(input.fullName, owner))
      : null;

  if (existingOwners.state === 'unreadable') {
    outcomes.push({
      name: 'CODEOWNERS',
      action: 'skipped',
      detail: `${codeownersPlace(existingOwners.path)} could not be read, so nothing was written: ${existingOwners.said}`,
    });
  } else if (existingOwners.state === 'found' && repair && existingOwners.sha) {
    // The lines that name a seat, or nobody who can review, rewritten in the
    // file GitHub reads. Everything else in it is somebody's and stays as it is.
    await api.request('PUT', `/repos/${input.fullName}/contents/${existingOwners.path}`, {
      message: `Name code owners who can review\n\n${repair.said.join('\n')}`,
      content: Buffer.from(repair.body, 'utf8').toString('base64'),
      sha: existingOwners.sha,
    });
    outcomes.push({ name: 'CODEOWNERS', action: 'updated', detail: `${codeownersPlace(existingOwners.path)}: ${repair.said.join('; ')}` });
  } else if (existingOwners.state === 'found') {
    outcomes.push({
      name: 'CODEOWNERS',
      action: 'unchanged',
      detail: `${codeownersPlace(existingOwners.path)} is already there; who owns what is a decision`,
    });
  } else {
    // Never the repository's organization as an owner: it was the fallback
    // while nobody was named, and GitHub takes no review from one.
    const org = organizationOf(input.fullName, owner)?.toLowerCase() ?? null;
    const people = input.humans.filter((login) => login.toLowerCase() !== org);
    const lead = input.leadReviewer && input.leadReviewer.toLowerCase() !== org ? input.leadReviewer : people[0];
    if (!lead) {
      outcomes.push({
        name: 'CODEOWNERS',
        action: 'skipped',
        detail: 'nobody to name as its owner yet: connect the lead reviewer, or say who approves',
      });
    } else {
      await api.request('PUT', `/repos/${input.fullName}/contents/.github/CODEOWNERS`, {
        message: 'Add CODEOWNERS so a review from a code owner can be satisfied',
        content: Buffer.from(codeownersBody({ ...input, leadReviewer: lead, humans: people }), 'utf8').toString('base64'),
      });
      outcomes.push({ name: 'CODEOWNERS', action: 'created', detail: '.github/CODEOWNERS' });
    }
  }

  // Not on a plan that offers none: the check says so and lists nothing to
  // agree to, and GitHub took the PATCH and changed nothing, so the outcome
  // said "updated" for a change that was neither agreed to nor made
  // (exampleco/testbed-2, 2026-10-03). What GitHub then says is what is reported.
  if (owner.autoMerge === false && owner.private && refused) {
    outcomes.push({ name: 'auto-merge', action: 'skipped', detail: AUTO_MERGE_UNSUPPORTED });
  } else if (owner.autoMerge === false) {
    try {
      await api.request('PATCH', `/repos/${input.fullName}`, { allow_auto_merge: true });
      const after = await ownerKind(api, input.fullName);
      outcomes.push(
        after?.autoMerge === true
          ? { name: 'auto-merge', action: 'updated', detail: `allowed: ${AUTO_MERGE_WHY}` }
          : { name: 'auto-merge', action: 'skipped', detail: 'GitHub took the change and left auto-merge off; its plan may not offer it here' },
      );
    } catch (cause) {
      outcomes.push({
        name: 'auto-merge',
        action: 'skipped',
        detail: `GitHub refused it: ${cause instanceof Error ? cause.message.slice(0, 160) : 'refused'}`,
      });
    }
  } else if (owner.autoMerge) {
    outcomes.push({ name: 'auto-merge', action: 'unchanged', detail: '' });
  }

  return outcomes;
}
