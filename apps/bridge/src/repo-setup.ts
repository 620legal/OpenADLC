import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bots, repos } from '@fleetadlc/db';
import {
  CI_WORKFLOW,
  GitHubClient,
  appPrivateKeyRef,
  appRuleFields,
  applyRepoRules,
  applyRepoTemplates,
  checkRepoRules,
  approversFor,
  checkRepoTemplates,
  ENVIRONMENT_ABSENT,
  enforcesRulesets,
  getSecretStore,
  installationTokenFor,
  repositoryPlanState,
  type AppApi,
  type ApplyOutcome,
  type RepoLabel,
  type RepoRulesInput,
  type RuleApi,
  type RuleReport,
} from '@fleetadlc/github';
import { REQUIRED_CHECK, REVIEW_GATE_CHECK, labelStep } from '@fleetadlc/shared';
import type { BridgeConfig } from './config.js';
import { effectiveConfig } from './effective-config.js';
import { APP_API } from './invitation-service.js';
import { statusOf } from './health/checks/app.js';
import { allPages } from './repo-removal.js';

/**
 * The last step, done from the console rather than from a terminal.
 *
 * Both halves of this already existed — `checkRepoRules` computes what would
 * change and `applyRepoRules` makes it so — and the walkthrough still ended by
 * asking somebody to paste two commands into a shell. The stated reason was
 * that both act on the repository and so should not happen without being asked
 * for. That is right, and it is not an argument for a terminal: a button is
 * being asked, and a button that lists what it will change first is a better
 * asking than a command that acts sight-unseen.
 *
 * It runs as the **app**, not as the automation bot. A bot's token reaches the
 * app's permissions intersected with that account's own access, and the crew are
 * collaborators with `write` at most — so where a repository's plan does support
 * rulesets and branch protection, which are admin-gated, the account the CLI
 * used could not set them. An installation token carries `administration: write`
 * un-intersected. The terminal path was the weaker of the two.
 *
 * Nothing here writes without a separate call saying so. `plan` is read-only.
 */

interface LabelSpec {
  name: string;
  color: string;
  description: string;
}

export interface LabelChange {
  name: string;
  action: 'create' | 'update' | 'unchanged';
  detail: string;
  /** For an update, the label's name on GitHub now: its own, or the one it had before the rename. */
  from?: string;
}

export interface RepoPlan {
  repository: string;
  labels: LabelChange[];
  rules: RuleReport[];
  templates: RuleReport[];
  /** Who a new or placeholder AGENTS.md names as approving its human-review paths. */
  approvers?: string[];
  /** Nobody known to name there, so the step asks. */
  needsApprovers?: boolean;
  /**
   * How production ships: the approval and soak the repository's rules come
   * to (its recorded choice where they say nothing), who would be named as
   * production's reviewers, and whether `.github/fleetadlc.yml` sets the
   * approval itself, which only an edit of that file changes.
   */
  production?: ProductionPlan;
  /** Production's rules say a person approves and nobody can be named, so the step asks before it applies. */
  needsProductionReviewer?: boolean;
  /** How many things a person would be agreeing to. Zero means nothing to do. */
  labelChanges: number;
  ruleChanges: number;
  /** Whether OpenADLC holds the app key, without which it can only report. */
  canApply: boolean;
  detail: string;
}

export interface ProductionPlan {
  approval: 'reviewers' | 'auto';
  soakMinutes: number;
  reviewers: string[];
  governedByFile: boolean;
}

export interface RepoSetupDeps {
  config: BridgeConfig;
  /** Injected so the tests never reach GitHub. */
  api?: AppApi;
  clientFor?: (token: string) => RuleApi;
  /** Injected so a test does not depend on a file in the working tree. */
  readLabels?: () => LabelSpec[];
  /**
   * What holds a repository's production, by its delivery rules
   * (`delivery-rules.ts`), and whether its `.github/fleetadlc.yml` sets the
   * approval itself; absent or null, a person approves it.
   */
  production?: (repoFullName: string) => Promise<(NonNullable<RepoRulesInput['production']> & { governedByFile?: boolean }) | null>;
}

/** How long `enforcesRules` leaves a repository it could not plan before planning it again: the hourly check's interval. */
const PLAN_AGAIN_MS = 60 * 60_000;

/**
 * The environments the last apply found GitHub's plan would not protect, read
 * as the plan's limit rather than as something to change — each with the
 * words the apply said of it.
 *
 * The check cannot tell from an environment with no rules whether the plan
 * refused them or nobody asked; the apply can, from GitHub's 422. Without
 * this, a plan whose rulesets hold but whose environments refuse their rules
 * showed them as changes on every plan, applied them again on every click,
 * and the hourly check called the repository unprotected. An environment that
 * is not there at all is still a change: applying makes it. The caller passes
 * only limits recorded under the plan state the repository is still in.
 */
export function withPlanLimits(rules: RuleReport[], limits: { name: string; detail: string }[]): RuleReport[] {
  const byName = new Map(limits.map((limit) => [limit.name, limit.detail]));
  return rules.map((rule) => {
    const detail = byName.get(rule.name);
    return detail !== undefined &&
      rule.name.startsWith('environment ') &&
      (rule.state === 'drifted' || (rule.state === 'missing' && rule.detail !== ENVIRONMENT_ABSENT))
      ? { name: rule.name, state: 'unsupported', detail }
      : rule;
  });
}

/** GitHub's labels could not be read, which is not the same as there being none. */
class LabelsUnread extends Error {
  constructor(override readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

/** A rule that is neither in place nor expressible is not something to agree to. */
function countable(reports: RuleReport[]): number {
  return reports.filter((report) => report.state === 'missing' || report.state === 'drifted').length;
}

/**
 * Why the app could not act on one repository, as the plan says it. GitHub's
 * 404 for the installation is the app not installed there, or the repository
 * left out of the repositories it was given, which is fixed on the app's
 * installation and nowhere here.
 */
function unreachableWords(repoFullName: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (statusOf(error) === 404 || /is not installed on/.test(message)) {
    return `the OpenADLC app is not installed on ${repoFullName}: install it on this repository, or add ${repoFullName} to the repositories its installation can reach`;
  }
  return `the app cannot reach this repository: ${message}`;
}

export class RepoSetup {
  constructor(private readonly deps: RepoSetupDeps) {}

  private labels(): LabelSpec[] {
    if (this.deps.readLabels) return this.deps.readLabels();
    return JSON.parse(
      readFileSync(join(this.deps.config.repoRoot, 'config', 'labels.json'), 'utf8'),
    ) as LabelSpec[];
  }

  /**
   * A client with the app's own reach over one repository.
   *
   * Null when no key is stored, which is a state the page reports rather than an
   * error: an install can be perfectly usable and still not let OpenADLC administer
   * the repository for it.
   */
  private async asApp(repoFullName: string): Promise<RuleApi | null> {
    const privateKey = await getSecretStore().get(appPrivateKeyRef());
    if (!privateKey) return null;

    const live = await effectiveConfig(this.deps.config);
    if (!live.gitHubClientId) return null;

    const { token } = await installationTokenFor(
      this.deps.api ?? APP_API,
      { clientId: live.gitHubClientId, privateKey },
      repoFullName,
    );
    return this.deps.clientFor
      ? this.deps.clientFor(token)
      : (new GitHubClient({ token, actingAs: 'fleetadlc-app' }) as unknown as RuleApi);
  }

  /**
   * Why `asApp` has no client for any repository, in two parts a caller puts
   * its own words between: what is missing, and where it is fixed. Both cases
   * read "OpenADLC holds no app key", which sent a person who had never
   * created the app to add a key to it.
   */
  private async noApp(): Promise<{ what: string; fix: string }> {
    const live = await effectiveConfig(this.deps.config).catch(() => null);
    if (live && !live.gitHubClientId) {
      return { what: 'OpenADLC has no GitHub App yet', fix: 'Create it on the Create the app step' };
    }
    return { what: 'OpenADLC holds no app key for this install', fix: 'Add the app’s private key on the Create the app step' };
  }

  /**
   * The app's id, which names it as a bypass actor on the rulesets it creates,
   * and the checks pinned to it (`appRuleFields`, which the CLI's
   * `github apply` uses too, so the two write the same rulesets). Only
   * reachable with the app JWT — an installation token cannot ask `/app` — so
   * it is resolved here rather than inside `rules.ts`.
   *
   * Kept for ten minutes, as `AppGate` keeps its answer, since Checks: write
   * can be granted on the app's page while this runs; and only for the client
   * id and key it was asked with. The app changes on a running bridge — the
   * manifest exchange, a new client id and key, a restore — and an id kept
   * for the life of the process wrote rulesets naming the old app, which the
   * drift check then compared against the same old id and found in place.
   * The key is kept as its hash, never itself.
   */
  private ruleFieldsCache: { at: number; clientId: string; keyHash: string; fields: { appId?: number; pinnedChecks: string[] } } | null = null;

  private async ruleFields(): Promise<{ appId?: number; pinnedChecks: string[] }> {
    const privateKey = await getSecretStore().get(appPrivateKeyRef());
    const live = await effectiveConfig(this.deps.config);
    if (!privateKey || !live.gitHubClientId) return { pinnedChecks: [] };

    const keyHash = createHash('sha256').update(privateKey).digest('hex');
    const cached = this.ruleFieldsCache;
    if (cached && cached.clientId === live.gitHubClientId && cached.keyHash === keyHash && Date.now() - cached.at < 10 * 60_000) {
      return cached.fields;
    }

    const fields = await appRuleFields(this.deps.api ?? APP_API, { clientId: live.gitHubClientId, privateKey });
    // Not kept when GitHub did not answer, so the next plan asks again.
    this.ruleFieldsCache = fields.appId ? { at: Date.now(), clientId: live.gitHubClientId, keyHash, fields } : null;
    return fields;
  }

  /**
   * Who approves the human-review paths in a new repository's `AGENTS.md`:
   * the install's people when it names them, else the repository's admins as
   * GitHub lists them — never a crew account — else the person who owns a
   * user-owned repository. Nobody leaves the template's placeholder, which
   * the repository check then asks about.
   */
  private async approvers(client: RuleApi, repoFullName: string): Promise<string[]> {
    const live = await effectiveConfig(this.deps.config);
    const crew = (await bots.listBots().catch(() => []))
      .map((bot) => bot.githubLogin)
      .filter((login): login is string => Boolean(login));
    return approversFor(client, repoFullName, { humans: live.humans, crew });
  }

  /**
   * Who approves production, by GitHub login: the first of the repository's
   * own named reviewers (its recorded choice), the install's `humans`, and the
   * people CODEOWNERS would name (`approversFor`, which leaves out the crew),
   * without the organization's own login, which cannot review. It was the
   * install's `humans` alone, empty on a default install, and production was
   * written with nobody on it.
   */
  private async productionReviewers(repo: { id?: string }, approvers: readonly string[]): Promise<string[]> {
    const live = await effectiveConfig(this.deps.config);
    const recorded = repo.id ? ((await repos.getProductionChoice(repo.id).catch(() => null))?.reviewers ?? []) : [];
    const organization = (live.organization ?? '').toLowerCase();
    const named = approvers.filter((login) => login.toLowerCase() !== organization);
    return [recorded, live.humans, named].find((list) => list.length > 0) ?? [];
  }

  private async rulesInput(
    repo: {
      id?: string;
      fullName: string;
      defaultBranch: string | null;
    },
    client: RuleApi,
  ): Promise<RepoRulesInput> {
    const live = await effectiveConfig(this.deps.config);
    // Whoever holds the lead reviewer's role, rather than a name written down
    // here — the crew is configurable and this would otherwise quietly name a
    // bot that does not exist on this install.
    const crew = await bots.listBots().catch(() => []);
    const lead = crew.find((bot) => bot.role === 'review_lead');
    // The people who own what a bot may not change: never the organization's
    // name, which was the fallback and which no review can come from.
    const humans = await this.approvers(client, repo.fullName).catch(() => [] as string[]);

    return {
      fullName: repo.fullName,
      defaultBranch: repo.defaultBranch ?? 'main',
      // One place, so the ruleset cannot require a check the workflow never publishes.
      requiredChecks: [REQUIRED_CHECK, REVIEW_GATE_CHECK],
      // Until an account connects as the lead reviewer there is no account to
      // name, and the person owns everything instead. Falling back to a fixed
      // bot login is wrong: one nobody has connected may be registered by a
      // stranger, and CODEOWNERS would then ask them to review.
      leadReviewer: lead?.githubLogin ?? humans[0] ?? '',
      // So a code owner line naming a seat's old account is known for one.
      crew: crew.map((bot) => bot.githubLogin).filter((login): login is string => Boolean(login)),
      humans,
      productionReviewers: await this.productionReviewers(repo, humans),
      // Reviewers or a soak, as the repository's rules say.
      ...(await this.productionRule(repo.fullName)),
      // The app's id, so OpenADLC can still write CODEOWNERS to a branch it
      // has just protected; and the gate pinned to the app once it publishes
      // it, so no bot can set it.
      ...(await this.ruleFields()),
    };
  }

  private async productionRule(fullName: string): Promise<Pick<RepoRulesInput, 'production'>> {
    const rule = this.deps.production ? await this.deps.production(fullName).catch(() => null) : null;
    return rule ? { production: { approval: rule.approval, soakMinutes: rule.soakMinutes } } : {};
  }

  /** How production ships, as the plan says it; see `RepoPlan.production`. */
  private async productionPlan(repo: { id?: string; fullName: string }, input: RepoRulesInput): Promise<ProductionPlan> {
    const rule = this.deps.production ? await this.deps.production(repo.fullName).catch(() => null) : null;
    return {
      approval: rule?.approval ?? 'reviewers',
      soakMinutes: rule?.soakMinutes ?? 0,
      reviewers: input.productionReviewers,
      governedByFile: rule?.governedByFile ?? false,
    };
  }

  /** Each repository's last plan, by its full name: what `enforcesRules` reads instead of asking GitHub again. */
  private readonly latest = new Map<string, RepoPlan>();
  /** When `enforcesRules` last planned a repository that had none, so one that fails is not planned in full every run. */
  private readonly tried = new Map<string, number>();

  /**
   * Whether GitHub enforces rules on at least one of this install's
   * repositories: true when one does, false when every one is on a plan that
   * refuses rulesets, null when nothing has said either way.
   *
   * Read from the last plan of each repository — the repository-rules check
   * makes one every hour, and the walkthrough's last step one each time it is
   * shown — so a check that asks every few minutes adds no call to GitHub. A
   * repository with no plan yet is planned here at most once an hour: one
   * whose plan fails stays unknown until then, or until the hourly check's
   * plan answers, rather than being planned in full on every run.
   */
  async enforcesRules(now = Date.now()): Promise<boolean | null> {
    const all = await repos.listRepos();
    const unplanned = all.filter(
      (repo) => !this.latest.has(repo.fullName) && now - (this.tried.get(repo.fullName) ?? -Infinity) >= PLAN_AGAIN_MS,
    );
    for (const repo of unplanned) this.tried.set(repo.fullName, now);
    if (unplanned.length > 0) await Promise.all(unplanned.map((repo) => this.plan(repo.fullName).catch(() => [])));
    const answers = all.map((repo) => {
      const plan = this.latest.get(repo.fullName);
      return plan ? enforcesRulesets(plan.rules) : null;
    });
    if (answers.includes(true)) return true;
    if (answers.length > 0 && answers.every((answer) => answer === false)) return false;
    return null;
  }

  /**
   * What GitHub's plan refused the last time the rules were applied to a
   * repository (`repo_plan_limits`), while the repository is still in the plan
   * state it was refused under: still private, or not, and still refused
   * rulesets, or not. Once that changes — made public, moved to another plan —
   * the memory is dropped and the check's own answer stands, so a production
   * that could now hold its reviewer shows as a change again.
   */
  private async planLimited(client: RuleApi, repoFullName: string): Promise<{ name: string; detail: string }[]> {
    const stored = await repos.getPlanLimits(repoFullName).catch(() => null);
    if (!stored) return [];
    const now = await repositoryPlanState(client, repoFullName).catch(() => null);
    // GitHub did not say. The remembered limit stays: clearing it on a 502
    // made a reviewers promote look as if the plan could hold it.
    if (!now) return stored.limits;
    if (now.private === stored.private && now.rulesetsRefused === stored.rulesetsRefused) return stored.limits;
    await repos.clearPlanLimits(repoFullName).catch(() => false);
    console.log(`[bridge] ${repoFullName}: its GitHub plan state changed, so what the plan refused is asked again`);
    return [];
  }

  /** What is already true, and what a click would change. Reads only. */
  async plan(only?: string): Promise<RepoPlan[]> {
    const planned = await this.planEach(only);
    for (const one of planned) this.latest.set(one.repository, one);
    return planned;
  }

  private async planEach(only?: string): Promise<RepoPlan[]> {
    const targets = (await repos.listRepos()).filter(
      (repo) => !only || repo.name === only || repo.fullName === only,
    );

    return Promise.all(
      targets.map(async (repo) => {
        // No key is the install's to fix; a key that mints no token here is
        // this repository's — the app uninstalled, the repository taken out
        // of its selection, GitHub failing for a moment — and both used to
        // read as "no app key".
        const reached = await this.asApp(repo.fullName).then(
          (client) => ({ client, why: null }),
          (error: unknown) => ({ client: null, why: unreachableWords(repo.fullName, error) }),
        );
        const client = reached.client;
        if (!client) {
          const missing = reached.why ? null : await this.noApp();
          return {
            repository: repo.fullName,
            labels: [],
            rules: [],
            templates: [],
            labelChanges: 0,
            ruleChanges: 0,
            canApply: false,
            detail: reached.why ?? `${missing!.what}, so it can only report. ${missing!.fix}`,
          } satisfies RepoPlan;
        }

        const [labelRead, checked, { approvers, reports: checkedTemplates }, limited] = await Promise.all([
          this.labelPlan(client, repo.fullName).then(
            (labels) => ({ labels }),
            (error: unknown) => {
              if (error instanceof LabelsUnread) return { error: error.cause };
              throw error;
            },
          ),
          this.rulesInput(repo, client).then(async (input) => ({
            reports: await checkRepoRules(client, input).catch(() => [] as RuleReport[]),
            production: await this.productionPlan(repo, input),
          })),
          this.approvers(client, repo.fullName)
            .catch(() => [] as string[])
            .then(async (approvers) => ({
              approvers,
              reports: await checkRepoTemplates(client, repo.fullName, { approvers }).catch(() => [] as RuleReport[]),
            })),
          this.planLimited(client, repo.fullName),
        ]);
        if ('error' in labelRead) {
          const why = labelRead.error instanceof Error ? labelRead.error.message.slice(0, 160) : String(labelRead.error);
          return {
            repository: repo.fullName,
            labels: [],
            rules: [],
            templates: [],
            labelChanges: 0,
            ruleChanges: 0,
            canApply: false,
            detail: `its labels could not be read from GitHub, so what would change is not known: ${why}. Try again in a minute`,
          } satisfies RepoPlan;
        }
        const labels = labelRead.labels;
        const rules = withPlanLimits(checked.reports, limited);
        const production = checked.production;
        const needsProductionReviewer = production.approval === 'reviewers' && production.reviewers.length === 0;

        // Whether the AGENTS.md this repository has, or is about to be given,
        // names the template's placeholder with nobody known to put instead.
        // The app cannot see an organization's owners, so on an organization's
        // repository with no people set this is asked of the person, and the
        // placeholder is not a change a click can make until they answer.
        const agents = checkedTemplates.find((report) => report.name === 'AGENTS.md');
        // CODEOWNERS too: a missing one is written with a person on its
        // protected paths, and one naming the organization is repaired to one.
        const owners = rules.find((report) => report.name === 'CODEOWNERS');
        const needsApprovers =
          approvers.length === 0 &&
          (Boolean(agents && agents.state !== 'present') || Boolean(owners && owners.state !== 'present'));
        const templates = checkedTemplates.map((report) =>
          report === agents && needsApprovers && report.state === 'drifted'
            ? { ...report, state: 'present' as const, detail: '' }
            : report,
        );

        const labelChanges = labels.filter((one) => one.action !== 'unchanged').length;
        // CODEOWNERS is checked by both halves — the ruleset needs it to require
        // a code owner's review, and it is also one of the files a repository is
        // given if it has none. Listing it twice reads as a bug, and counting it
        // twice overstates what somebody is agreeing to.
        const named = new Set(rules.map((report) => report.name));
        const extraTemplates = templates.filter((report) => !named.has(report.name));
        const ruleChanges = countable(rules) + countable(extraTemplates);

        return {
          repository: repo.fullName,
          labels,
          rules,
          templates: extraTemplates,
          labelChanges,
          ruleChanges,
          canApply: true,
          approvers,
          needsApprovers,
          production,
          needsProductionReviewer,
          detail:
            labelChanges + ruleChanges === 0
              ? 'everything OpenADLC would set is already in place'
              : `${labelChanges + ruleChanges} thing(s) would change`,
        } satisfies RepoPlan;
      }),
    );
  }

  /**
   * The same comparison the writer makes, so the list somebody agreed to is the
   * list that gets written rather than a second opinion about it.
   */
  private async labelPlan(client: RuleApi, repoFullName: string): Promise<LabelChange[]> {
    // Every page, and a read that failed fails: one page left a repository with
    // more than a hundred labels planning to create ours again, and an error
    // read as none said every label was missing.
    const specs = this.labels();
    const existing = await allPages<LabelSpec>(client, `/repos/${repoFullName}/labels`).catch((cause: unknown) => {
      throw new LabelsUnread(cause);
    });

    return specs.map((spec) => ({ name: spec.name, ...labelStep(spec, existing) }));
  }

  /**
   * Creates one of OpenADLC's own labels on a repository that lacks it, as the
   * app. A label added since the repository was set up — `fleetadlc:paused`,
   * `fleetadlc:next` — is not there until somebody sets it up again, and the
   * automation account, with triage, may put a label on an issue but not make
   * one: GitHub refuses that with a 422.
   * True when the label is there now; false when it is not one of ours or no
   * app key is held.
   */
  async ensureLabel(repoFullName: string, name: string): Promise<boolean> {
    const spec = this.labels().find((one) => one.name === name);
    if (!spec) return false;
    const client = await this.asApp(repoFullName);
    if (!client) return false;
    try {
      await client.request('POST', `/repos/${repoFullName}/labels`, { name: spec.name, color: spec.color, description: spec.description });
    } catch (cause) {
      // Made in the meantime, by a person or the setup page: there all the same.
      if (!/already_exists/.test(cause instanceof Error ? cause.message : String(cause))) throw cause;
    }
    return true;
  }

  /** Writes the board's columns. Additive: nothing is deleted, ever. */
  async applyLabels(name: string): Promise<LabelChange[]> {
    // Only a repository OpenADLC works in, as applyRules: the app may reach
    // every repository of the account, and the name comes from the request.
    const repo = (await repos.listRepos()).find((one) => one.fullName.toLowerCase() === name.toLowerCase());
    if (!repo) throw new Error(`no repository named ${name}`);
    const repoFullName = repo.fullName;
    const client = await this.asApp(repoFullName);
    if (!client) {
      const missing = await this.noApp();
      throw new Error(`${missing.what}, so it cannot write to the repository. ${missing.fix}`);
    }

    const planned = await this.labelPlan(client, repoFullName);
    const done: LabelChange[] = [];

    for (const change of planned) {
      const spec = this.labels().find((one) => one.name === change.name);
      if (!spec || change.action === 'unchanged') {
        done.push(change);
        continue;
      }
      try {
        if (change.action === 'create') {
          await client.request('POST', `/repos/${repoFullName}/labels`, spec).catch((cause: unknown) => {
            // Made in the meantime, as ensureLabel says: there all the same.
            if (!/already_exists/.test(cause instanceof Error ? cause.message : String(cause))) throw cause;
          });
        } else {
          const from = change.from ?? spec.name;
          await client.request('PATCH', `/repos/${repoFullName}/labels/${encodeURIComponent(from)}`, {
            new_name: spec.name,
            color: spec.color,
            description: spec.description,
          });
        }
        done.push(change);
      } catch (cause) {
        // Reported per label rather than failing the lot: eight written and one
        // refused is worth knowing precisely.
        done.push({
          name: change.name,
          action: change.action,
          detail: `failed: ${cause instanceof Error ? cause.message.slice(0, 120) : 'unknown'}`,
        });
      }
    }

    return done;
  }

  /**
   * Creates the containment: the rulesets a plan supports, the environments, a
   * CODEOWNERS where there is none, and the templates a repository is missing.
   *
   * Only what is absent. An existing AGENTS.md or Makefile is a decision
   * somebody made and is left exactly as it is.
   */
  async applyRules(repoFullName: string, options: { force?: boolean } = {}): Promise<ApplyOutcome[]> {
    const client = await this.asApp(repoFullName);
    if (!client) {
      const missing = await this.noApp();
      throw new Error(`${missing.what}, so it cannot administer the repository. ${missing.fix}`);
    }

    const repo = (await repos.listRepos()).find((one) => one.fullName === repoFullName);
    if (!repo) throw new Error(`no repository named ${repoFullName}`);

    /**
     * The rules first, then the files — because the rules step is what puts the
     * bypass in place, and without it the files cannot be written at all.
     *
     * This is how `apply` locked itself out: the `main` ruleset requires a pull
     * request, and the next thing it did was write CODEOWNERS straight to the
     * default branch, which that rule refuses with a 409. Writing the files
     * first fixes a *fresh* repository and does nothing for one that is already
     * protected — which is the state the bug leaves behind. Naming the app as a
     * bypass actor fixes both, so that is the fix, and the order stays.
     */
    // Asked again whatever was remembered: an apply always asks GitHub, and
    // "Apply again" is also a person saying to forget what the plan refused.
    if (options.force) await repos.clearPlanLimits(repoFullName);

    const input = await this.rulesInput(repo, client);
    const outcomes = await applyRepoRules(client, input);
    await recordPlanLimits(client, repoFullName, outcomes);

    if (!input.appId) {
      // Said out loud rather than discovered as a 409 nine lines later.
      outcomes.push({
        name: 'bypass for OpenADLC',
        action: 'skipped',
        detail:
          'OpenADLC could not learn its own app id, so it is not a bypass actor on the ruleset it ' +
          'just wrote — writing CODEOWNERS or a template to the default branch will be refused',
      });
    }

    const templates = await applyRepoTemplates(client, {
      fullName: repoFullName,
      root: this.deps.config.repoRoot,
      approvers: await this.approvers(client, repoFullName),
    }).catch((cause: unknown) => [
      {
        name: 'templates',
        action: 'skipped' as const,
        detail: cause instanceof Error ? cause.message.slice(0, 160) : 'could not be written',
      },
    ]);

    // The rules were decided before the files, and a repository with no
    // workflow was given no status-check rule: requiring a check nothing
    // publishes would leave `main` unmergeable. The workflow just written is
    // what publishes it, so the rules are applied again and one apply leaves
    // the repository requiring the check the merge line waits for.
    const wroteCi = templates.some((one) => one.name === CI_WORKFLOW && one.action === 'created');
    const leftOff = outcomes.some((one) => one.name === 'required status checks' && one.action === 'skipped');
    if (wroteCi && leftOff) {
      const again = await applyRepoRules(client, input).catch(() => null);
      if (again && !again.some((one) => one.name === 'required status checks')) {
        return [
          ...outcomes.filter((one) => one.name !== 'required status checks'),
          ...templates,
          { name: 'required status checks', action: 'created', detail: `${input.requiredChecks.join(' and ')}, now that ci publishes` },
        ];
      }
    }

    return [...outcomes, ...templates];
  }
}

/**
 * Remembers what an apply found GitHub's plan would not hold on a repository,
 * with the plan state it found it under; an apply that found nothing clears
 * it. Not remembered when GitHub would not say the state: without it the
 * memory could never be told stale.
 */
export async function recordPlanLimits(client: RuleApi, repoFullName: string, outcomes: ApplyOutcome[]): Promise<void> {
  const limits = outcomes
    .filter((one) => one.action === 'unsupported' && one.name.startsWith('environment '))
    .map((one) => ({ name: one.name, detail: one.detail }));
  if (limits.length === 0) {
    // A skipped production step did not show that GitHub can hold a reviewer
    // — nobody to name, a login it could not resolve, GitHub not answering.
    // Clearing the row here let the next promote dispatch with nothing holding it.
    const production = outcomes.find((one) => one.name === 'environment production');
    if (!production || production.action === 'skipped') return;
    await repos.clearPlanLimits(repoFullName).catch(() => false);
    return;
  }
  const state = await repositoryPlanState(client, repoFullName).catch(() => null);
  if (!state) return;
  await repos.setPlanLimits(repoFullName, { limits, ...state }).catch((error: unknown) => {
    console.warn(`[bridge] ${repoFullName}: could not remember what the plan refused: ${error instanceof Error ? error.message : error}`);
  });
}
