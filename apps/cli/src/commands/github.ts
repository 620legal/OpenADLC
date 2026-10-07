import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { audit, bots, closePool, identities, repos, settings, withAdvisoryLock } from '@fleetadlc/db';
import {
  applyRepoRules,
  checkRepoRules,
  checkRepoTemplates,
  applyRepoTemplates,
  approversFor,
  GitHubApiError,
  GitHubClient,
  getSecretStore,
  accessTokenRef,
  appPrivateKeyRef,
  appRuleFields,
  installationTokenFor,
  internalSecretRef,
  listLabels,
  refreshTokenRef,
  repositoryPlanState,
  rulesAppliedPayload,
  TokenBroker,
  type AppApi,
  type AppCredentials,
  type RepoLabel,
  type RepoRulesInput,
  type RuleApi,
} from '@fleetadlc/github';
import { githubClientId } from '../client-id.js';
import { reachDatabase } from '../database.js';
import { configPath, type InstallConfig } from '../install.js';
import { prompt, ui } from '../ui.js';
import {
  DELIVERY_RULES_PATH,
  REQUIRED_CHECK,
  REVIEW_GATE_CHECK,
  automationBotOf,
  deliveryRulesFrom,
  rulesSetApproval,
  type Bot,
  labelStep,
} from '@fleetadlc/shared';

interface LabelSpec {
  name: string;
  color: string;
  description: string;
}

/**
 * Labels are configuration, not something a bot invents: this writes
 * config/labels.json to every configured repository and reports what changed.
 * Run it after editing the file, or when adding a repository.
 *
 * `file` writes another label file instead, relative to the checkout:
 * OpenADLC's own component areas (`config/labels-fleetadlc.json`) go only to
 * OpenADLC's own repository, never to every one an install manages.
 */
export async function syncLabels(config: InstallConfig, options: { repo?: string; file?: string }): Promise<void> {
  await reachDatabase();

  const specs = JSON.parse(
    readFileSync(options.file ? resolve(config.repoRoot, options.file) : join(config.repoRoot, 'config', 'labels.json'), 'utf8'),
  ) as LabelSpec[];

  const app = await appCredentials(config);
  const automation = lazyAutomation(config);
  if (!app) {
    const found = await automation();
    if (!('client' in found)) return noAutomation(found);
    ui.note(NO_APP_KEY_NOTE);
  }

  const targets = (await repos.listRepos()).filter(
    (repo) => !options.repo || repo.name === options.repo || repo.fullName === options.repo,
  );

  if (targets.length === 0) {
    ui.fail(options.repo ? `no repository named ${options.repo}` : 'no repositories are configured');
    await closePool();
    process.exitCode = 1;
    return;
  }

  for (const repo of targets) {
    const writer = await repositoryWriter(repo.fullName, app, automation);
    ui.heading(`${repo.fullName}${'as' in writer ? `, ${writer.as}` : ''}`);
    if (!('client' in writer)) {
      noWriter(writer);
      continue;
    }
    const { client } = writer;
    let created = 0;
    let updated = 0;
    let unchanged = 0;

    let existing: RepoLabel[];
    try {
      existing = await listLabels(client, repo.fullName);
    } catch (error) {
      // Not "none": that planned every label as new, beside the ones it has.
      ui.fail(`could not read its labels, so none were changed: ${error instanceof Error ? error.message.slice(0, 120) : error}`);
      process.exitCode = 1;
      continue;
    }

    for (const spec of specs) {
      const step = labelStep(spec, existing);

      if (step.action === 'create') {
        try {
          await client.request('POST', `/repos/${repo.fullName}/labels`, spec);
          created += 1;
        } catch (error) {
          ui.warn(`${spec.name}: ${error instanceof Error ? error.message.slice(0, 120) : error}`);
        }
        continue;
      }

      if (step.action === 'unchanged') {
        unchanged += 1;
        continue;
      }

      await client
        .request('PATCH', `/repos/${repo.fullName}/labels/${encodeURIComponent(step.from)}`, {
          new_name: spec.name,
          color: spec.color,
          description: spec.description,
        })
        .then(() => {
          updated += 1;
        })
        .catch((error: unknown) => {
          ui.warn(`${spec.name}: ${error instanceof Error ? error.message.slice(0, 120) : error}`);
        });
    }

    ui.ok(`${created} created, ${updated} updated, ${unchanged} already correct`);
  }

  await closePool();
}

/** Checks the GitHub side of an install: the account, its scopes, and the repositories. */
export async function githubCheck(config: InstallConfig): Promise<void> {
  await reachDatabase();
  const automation = await automationClient(config);

  ui.heading('Automation account');
  if (!('client' in automation)) return noAutomation(automation);
  const { client } = automation;

  const viewer = await client.viewer().catch((error: unknown) => credentialFailure(error, automation.login));
  if ('reason' in viewer) return noAutomation(viewer);
  ui.ok(`acting as ${viewer.login}`);

  const appKeyHeld = (await appCredentials(config)) !== null;
  ui.heading('Repositories');
  for (const repo of await repos.listRepos()) {
    try {
      const detail = await client.request<{ full_name: string; permissions?: Record<string, boolean> }>(
        'GET',
        `/repos/${repo.fullName}`,
      );
      const line = repositoryAccessLine(repo.fullName, detail.permissions ?? {}, appKeyHeld);
      if (line.ok) ui.ok(line.text);
      else ui.warn(line.text);
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) {
        ui.fail(`${repo.fullName} not found, or the account cannot see it`);
      } else {
        ui.fail(`${repo.fullName}: ${error instanceof Error ? error.message.slice(0, 120) : error}`);
      }
    }
  }

  ui.heading('Repository rules');
  let missing = 0;
  for (const repo of await repos.listRepos()) {
    const { input } = await rulesInputFor(config, repo, client);
    for (const report of await checkRepoRules(client, input)) {
      const line = `${report.name}${report.detail ? ` — ${report.detail}` : ''}`;
      if (report.state === 'present') ui.ok(report.name);
      else if (report.state === 'drifted') {
        missing += 1;
        ui.fail(`drifted: ${line}`);
      } else if (report.state === 'missing') {
        missing += 1;
        ui.fail(`missing: ${line}`);
      } else {
        // Not a pass and not a failure of this install: GitHub will not hold it
        // here, so the containment has to come from somewhere else and somebody
        // has to know that.
        ui.warn(`cannot be expressed: ${line}`);
      }
    }
  }
  // A repository can have every rule and still be one no bot can work in: the
  // task form's labels are the headings the platform parses, `AGENTS.md` is
  // where human-review paths come from, and `make setup` is what runs at task
  // start. Without them an operator gets labels and a webhook and nothing else.
  ui.heading('Repository templates');
  for (const repo of await repos.listRepos()) {
    for (const report of await checkRepoTemplates(client, repo.fullName)) {
      if (report.state === 'present') ui.ok(report.name);
      else {
        missing += 1;
        ui.fail(templateProblem(report));
      }
    }
  }

  if (missing > 0) {
    ui.note('`fleetadlc github apply` creates what is missing and brings what drifted up to date');
    process.exitCode = 1;
  }

  ui.heading('Crew')
  for (const bot of await bots.listBots()) {
    if (!bot.githubLogin) {
      ui.warn(`${bot.name.padEnd(8)} has no account connected — fleetadlc auth login --bot ${bot.slot}`);
      continue;
    }
    try {
      await client.request('GET', `/users/${bot.githubLogin}`);
      ui.ok(`${bot.name.padEnd(8)} ${bot.githubLogin} exists on GitHub`);
    } catch {
      ui.warn(`${bot.name.padEnd(8)} ${bot.githubLogin} does not exist yet`);
    }
  }

  await closePool();
}

/**
 * The people the rules name: who may approve production, and the one who owns
 * the paths a bot may not change.
 *
 * Found where the console's repository setup finds them, so `check` measures
 * what the console applied: a `humans` setting stored from the console wins
 * over `FLEETADLC_HUMANS`, which `main` fills from install.json's `humans` unless it
 * was exported. With no humans the organization stands in, which on a personal
 * account is its owner.
 *
 * There is no default. This used to fall back to the original author's GitHub
 * handle, so an install that configured nobody made that account — someone
 * with no part in the install — the code owner of its `config/` and `infra/`.
 * Naming nobody is refused instead, with what to set.
 */
/**
 * A template that is not as it should be, as `github check` prints it. A file
 * OpenADLC wrote and left behind is there, so calling it missing sent an
 * operator looking for a file they could see: "missing: AGENTS.md — still
 * names the template's @owner".
 */
export function templateProblem(report: { name: string; state: string; detail: string }): string {
  return `${report.state === 'drifted' ? 'drifted' : 'missing'}: ${report.name} — ${report.detail}`;
}

export function rulesHumans(install: {
  /** The console's settings: `humans` comma-separated, as the bridge reads it. */
  stored: { humans?: string; organization?: string };
  /** `FLEETADLC_HUMANS`. */
  environment: string | undefined;
  /** install.json's `organization`. */
  organization: string;
}): { human: string; humans: string[] } {
  const humans = (install.stored.humans || install.environment || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const human = humans[0] ?? (install.stored.organization || install.organization || '').trim();
  if (!human) {
    throw new Error(
      `no human reviewer is configured, and the repository rules name one: set "humans" in ${configPath()} ` +
        'to the GitHub logins who approve, e.g. "humans": ["your-login"], or export FLEETADLC_HUMANS=your-login',
    );
  }
  return { human, humans };
}

/** GitHub, spoken to as the app itself, with its JWT. */
const APP_API: AppApi = {
  request: <T>(method: string, path: string, token: string, body?: unknown) =>
    new GitHubClient({ token, actingAs: 'fleetadlc-app' }).request<T>(method, path, body),
};

/**
 * The app's id and the checks pinned to it, as the bridge's Protect step
 * writes them (`appRuleFields`). Without them `check` called every ruleset the
 * console wrote drifted, and `apply` wrote it back with no bypass and an
 * unpinned review gate. Without the app's key on this machine there is no id,
 * and `applyRepoRules` then leaves a ruleset that holds anything for the app
 * alone.
 */
async function appFieldsFor(config: InstallConfig, api: AppApi): Promise<{ appId?: number; pinnedChecks: string[] }> {
  const privateKey = await getSecretStore()
    .get(appPrivateKeyRef())
    .catch(() => null);
  const clientId = await githubClientId(config);
  return appRuleFields(api, privateKey && clientId ? { clientId, privateKey } : null);
}

/**
 * What the rules are built from. Nothing here is a policy decision made in this
 * file: the checks are the ones CI publishes, the lead reviewer is the one the
 * review rules name, and the humans are the install's. `approvers` is who
 * `approversFor` found, before the rules' fallback: what AGENTS.md names.
 */
export async function rulesInputFor(
  config: InstallConfig,
  repo: { id?: string; fullName: string; defaultBranch: string | null },
  client?: (Pick<GitHubClient, 'readFileIfPresent'> & Partial<Pick<GitHubClient, 'request'>>) | null,
  api: AppApi = APP_API,
): Promise<{ input: RepoRulesInput; approvers: string[] }> {
  const stored: { humans?: string; organization?: string } = await settings.allSettings().catch(() => ({}));
  const { human, humans } = rulesHumans({
    stored,
    environment: process.env.FLEETADLC_HUMANS,
    organization: config.organization,
  });
  // Whoever holds the lead reviewer's role, as the console's setup does. With
  // no account connected there, the person owns everything instead of a login
  // nobody connected.
  const crew = await bots.listBots().catch(() => []);
  const lead = crew.find((bot) => bot.role === 'review_lead');
  // The same people the console's Protect step names; see `approversFor`.
  const logins = crew.map((bot) => bot.githubLogin).filter((login): login is string => Boolean(login));
  const approvers = client ? await approversFor(client as unknown as RuleApi, repo.fullName, { humans, crew: logins }) : humans;

  // Who approves production: the repository's own named reviewers, else the
  // install's humans, else CODEOWNERS' approvers without the organization's
  // login. Never the `[human]` fallback below: that is the organization on an
  // organization's install, and an organization cannot review. It was the
  // humans alone, empty on a default install, and production was written for
  // nobody.
  const recorded = repo.id ? ((await repos.getProductionChoice(repo.id).catch(() => null))?.reviewers ?? []) : [];
  const organization = (stored.organization || config.organization || '').toLowerCase();
  const named = approvers.filter((login) => login.toLowerCase() !== organization);
  const productionReviewers = [recorded, humans, named].find((list) => list.length > 0) ?? [];

  const input: RepoRulesInput = {
    fullName: repo.fullName,
    defaultBranch: repo.defaultBranch ?? 'main',
    // One place, so the ruleset cannot require a check the workflow never publishes.
    requiredChecks: [REQUIRED_CHECK, REVIEW_GATE_CHECK],
    leadReviewer: lead?.githubLogin ?? human,
    // On a personal install the fallback is its owner, a person. On an
    // organization's it is the organization, which the CODEOWNERS writer
    // leaves out: no review can come from one.
    humans: approvers.length > 0 ? approvers : [human],
    // So a code owner line naming a seat's old account is known for one, as the bridge does.
    crew: logins,
    productionReviewers,
    // What holds production, by the repository's rules: its
    // `.github/fleetadlc.yml`, else its stored rules, else a person approves.
    production: await productionRuleOf(repo, client ?? null),
    // The app's bypass and the review gate pinned to it, as the bridge writes them.
    ...(await appFieldsFor(config, api)),
  };
  return { input, approvers };
}

async function productionRuleOf(
  repo: { id?: string; fullName: string; defaultBranch: string | null },
  client: Pick<GitHubClient, 'readFileIfPresent'> | null,
): Promise<RepoRulesInput['production']> {
  const text = await rulesFileOf(repo, client);
  const stored = repo.id ? (await repos.getDelivery(repo.id).catch(() => null))?.deliveryRules ?? null : null;
  // An approval or soak the rules leave out is the repository's recorded choice, as the bridge reads it.
  const choice = repo.id ? await repos.getProductionChoice(repo.id).catch(() => null) : null;
  const { production } = deliveryRulesFrom(text, stored, { approval: choice?.approval ?? null, soakMinutes: choice?.soakMinutes ?? null });
  return { approval: production.approval, soakMinutes: production.soakMinutes };
}

function rulesFileOf(
  repo: { fullName: string; defaultBranch: string | null },
  client: Pick<GitHubClient, 'readFileIfPresent'> | null,
): Promise<string | null> {
  return client
    ? client.readFileIfPresent(repo.fullName, DELIVERY_RULES_PATH, repo.defaultBranch ?? 'main').catch(() => null)
    : Promise.resolve(null);
}

/** How production ships, as `fleetadlc github apply --production … --reviewer … --soak …` says it. */
export interface ProductionOptions {
  production?: string;
  reviewers?: string[];
  soak?: string;
}

/** The soak a repository shipping automatically waits on testing, unless it says otherwise. */
const DEFAULT_SOAK_MINUTES = 30;

/**
 * The choice the flags make, or why they make none: `reviewers` names
 * someone, a soak is whole minutes within GitHub's 30 days. Null when no
 * `--production` was given.
 */
export function productionFromFlags(
  options: ProductionOptions,
): { choice: { approval: 'auto' | 'reviewers'; soakMinutes: number; reviewers: string[] } } | { refused: string } | null {
  if (options.production === undefined) {
    if (options.reviewers?.length || options.soak !== undefined) return { refused: '--reviewer and --soak go with --production auto|reviewers' };
    return null;
  }
  const approval = options.production;
  if (approval !== 'auto' && approval !== 'reviewers') return { refused: `--production is auto or reviewers, not ${approval || '(nothing)'}` };
  const reviewers = [...new Set((options.reviewers ?? []).flatMap((one) => one.split(',')).map((one) => one.trim().replace(/^@/, '')).filter(Boolean))];
  if (approval === 'reviewers' && reviewers.length === 0) {
    return { refused: '--production reviewers names who approves: add --reviewer <login>[,<login>]' };
  }
  const soakMinutes = options.soak === undefined ? (approval === 'auto' ? DEFAULT_SOAK_MINUTES : 0) : Number(options.soak);
  if (!Number.isInteger(soakMinutes) || soakMinutes < 0 || soakMinutes > 43_200) {
    return { refused: `--soak is whole minutes from 0 to 43200, not ${options.soak}` };
  }
  return { choice: { approval, soakMinutes, reviewers: approval === 'reviewers' ? reviewers : [] } };
}

/**
 * Asks how production ships for a repository with no recorded choice and no
 * rules file that sets one: at a terminal, the person answers; otherwise the
 * automatic default is used and said. A choice the flags made is recorded
 * for every repository whose file does not set it.
 */
async function settleProduction(
  repo: { id?: string; fullName: string; defaultBranch: string | null },
  client: Pick<GitHubClient, 'readFileIfPresent'>,
  flagged: { approval: 'auto' | 'reviewers'; soakMinutes: number; reviewers: string[] } | null,
  suggest: () => Promise<string[]>,
): Promise<void> {
  if (!repo.id) return;
  if (rulesSetApproval(await rulesFileOf(repo, client))) {
    if (flagged) ui.note(`${repo.fullName}: its ${DELIVERY_RULES_PATH} sets production.approval, which wins; change it there`);
    return;
  }
  if (flagged) {
    await repos.setProductionChoice(repo.id, flagged);
    return;
  }
  const recorded = await repos.getProductionChoice(repo.id).catch(() => null);
  if (recorded?.approval) return;
  if (!process.stdin.isTTY) {
    ui.note(
      `${repo.fullName}: nobody was asked how production ships, so it ships automatically after a ${DEFAULT_SOAK_MINUTES}-minute soak on testing. ` +
        'Say otherwise with --production reviewers --reviewer <login>',
    );
    return;
  }
  const how = (await prompt(`How does production ship for ${repo.fullName}? auto (after testing) or reviewers (after a person approves)`, 'auto')).toLowerCase();
  if (how === 'reviewers') {
    const offered = (await suggest().catch(() => [] as string[])).join(',');
    for (;;) {
      const answer = await prompt('Who approves production? GitHub logins, comma-separated', offered);
      const chosen = productionFromFlags({ production: 'reviewers', reviewers: [answer] });
      if (chosen && 'choice' in chosen) {
        await repos.setProductionChoice(repo.id, chosen.choice);
        return;
      }
      ui.warn('name at least one person who approves production');
    }
  }
  const soak = await prompt('Minutes on testing before production', String(DEFAULT_SOAK_MINUTES));
  const chosen = productionFromFlags({ production: 'auto', soak });
  if (chosen && 'choice' in chosen) await repos.setProductionChoice(repo.id, chosen.choice);
  else ui.warn(`${chosen && 'refused' in chosen ? chosen.refused : 'not a soak'}; it ships automatically after ${DEFAULT_SOAK_MINUTES} minutes until you choose again`);
}

/**
 * Creates the containment a managed repository is supposed to have: the `main`
 * ruleset, the agent-branch restriction, the two environments and a CODEOWNERS
 * if none exists. This writes to GitHub — `fleetadlc github check` is the read-only
 * half, and is what to run first.
 */
export async function githubApply(config: InstallConfig, options: ProductionOptions = {}): Promise<void> {
  // Refused before anything is asked of GitHub: a scripted run that said
  // `reviewers` and named nobody would write production for nobody.
  const flagged = productionFromFlags(options);
  if (flagged && 'refused' in flagged) {
    ui.fail(flagged.refused);
    process.exitCode = 2;
    return;
  }
  await reachDatabase();
  const app = await appCredentials(config);
  const automation = lazyAutomation(config);
  if (!app) {
    const found = await automation();
    if (!('client' in found)) return noAutomation(found);
    ui.note(NO_APP_KEY_NOTE);
  }

  for (const repo of await repos.listRepos()) {
    const writer = await repositoryWriter(repo.fullName, app, automation);
    ui.heading(`${repo.fullName}${'as' in writer ? `, ${writer.as}` : ''}`);
    if (!('client' in writer)) {
      noWriter(writer);
      continue;
    }
    const { client } = writer;
    // Recorded before the rules are built, which read it.
    await settleProduction(repo, client, flagged?.choice ?? null, async () => (await rulesInputFor(config, repo, client)).input.productionReviewers);
    const { input, approvers } = await rulesInputFor(config, repo, client);
    try {
      // The remembered limit stays until this apply says what the plan did.
      // Cleared first, an apply that then failed or skipped production left
      // no row, and a reviewers promote dispatched with nothing holding it.
      const outcomes = await applyRepoRules(client, input);
      await rememberPlanLimits(client, repo.fullName, outcomes);
      // The entry the console's apply writes, which the repo-rules check reads
      // for what GitHub refused: without it, an apply from here left the
      // check reading an older one.
      await audit({ actor: 'fleetadlc github apply', action: 'repo.rules_applied', target: repo.fullName, payload: rulesAppliedPayload(outcomes) }).catch(
        () => undefined,
      );
      for (const outcome of outcomes) {
        const line = `${outcome.name}${outcome.detail ? ` — ${outcome.detail}` : ''}`;
        if (outcome.action === 'skipped') ui.warn(`${line}`);
        else if (outcome.action === 'unsupported') ui.note(`${outcome.name} — not available on this GitHub plan: ${outcome.detail}`);
        // An unchanged step can still say why: production keeps the reviewer
        // it holds because a named login could not be resolved, which the
        // person has to fix.
        else if (outcome.action === 'unchanged') ui.note(`${outcome.name} unchanged${outcome.detail ? ` — ${outcome.detail}` : ''}`);
        else ui.ok(`${outcome.action} ${line}`);
      }
    } catch (error) {
      ui.fail(`${repo.fullName}: ${error instanceof Error ? error.message.slice(0, 200) : error}`);
      process.exitCode = 1;
    }
    // Only what is absent. What a repository says about itself is its own, so an
    // existing AGENTS.md or Makefile is left exactly as it is — this fills gaps
    // and never overwrites an answer somebody already gave.
    try {
      // Never AGENTS.md with the template's @owner in it: it was the first
      // thing a new install showed, as a card about OpenADLC's own file.
      // `approversFor`'s own answer, as the bridge passes it, not the rules'
      // humans less the owner: that dropped a personal repository's owner, who
      // is the person.
      if (approvers.length === 0) {
        ui.warn(
          `${repo.fullName}: nobody to name as approving AGENTS.md's human-review paths — set "humans" in ${configPath()} ` +
            'or export FLEETADLC_HUMANS=your-login, and run this again. Until then AGENTS.md keeps the template\'s @owner.',
        );
      }
      // The checkout's templates, wherever the command is run from.
      for (const outcome of await applyRepoTemplates(client, { fullName: repo.fullName, root: config.repoRoot, approvers })) {
        if (outcome.action === 'unchanged') ui.note(`${outcome.name} unchanged`);
        else if (outcome.action === 'skipped') {
          ui.warn(`${outcome.name} — ${outcome.detail}`);
          process.exitCode = 1;
        } else ui.ok(`${outcome.action} ${outcome.name} — ${outcome.detail}`);
      }
    } catch (error) {
      ui.fail(`${repo.fullName} templates: ${error instanceof Error ? error.message.slice(0, 200) : error}`);
      process.exitCode = 1;
    }
  }

  ui.plain();
  ui.note('now run `fleetadlc github check` to see it from the outside');
  await closePool();
}

/** The automation account's client, or why there is none and what to do about it. */
type AutomationClient = { client: GitHubClient; login: string } | { reason: string; hint: string | null };

/**
 * Why GitHub would not say who the automation account is: its credential
 * refused, which a new sign-in fixes, or GitHub not reached, which it does
 * not. Both were "the stored credential was rejected by GitHub", with no remedy.
 */
export function credentialFailure(error: unknown, login: string): { reason: string; hint: string | null } {
  if (error instanceof GitHubApiError && (error.status === 401 || error.status === 403)) {
    return { reason: `GitHub refused ${login}’s stored credential`, hint: `fleetadlc auth login --bot ${login}` };
  }
  return {
    reason: `could not ask GitHub who ${login} is: ${error instanceof Error ? error.message : String(error)}`,
    hint: 'check that this machine reaches api.github.com, and run this again',
  };
}

/**
 * What the bridge, the install's only broker, says about a bot's token: the
 * token, the bridge's own refusal, or that nothing listens on its port.
 * Asking it rather than refreshing here is what keeps a command run while the
 * crew is working from rotating a refresh token out from under a running task.
 *
 * Only a refused connection is "not answering". Every other way the ask could
 * go (an error the bridge gave, no internal secret to ask with) used to read
 * as one too, and the command then refreshed the token itself beside a
 * bridge that might do the same: two refreshes of one token are a replay, and
 * GitHub revokes the sign-in.
 */
async function tokenFromBridge(
  config: InstallConfig,
  bot: string,
): Promise<{ token: string } | { refused: string; status: number } | { notAnswering: true }> {
  const secret = (await getSecretStore().get(internalSecretRef()).catch(() => null)) ?? '';
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${config.ports.bridge}/internal/tokens/${encodeURIComponent(bot)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fleetadlc-internal-secret': secret },
      body: JSON.stringify({ purpose: 'call' }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    if ((error as { cause?: { code?: unknown } }).cause?.code === 'ECONNREFUSED') return { notAnswering: true };
    return { refused: `the bridge could not be asked (${error instanceof Error ? error.message : String(error)})`, status: 0 };
  }
  const body = (await response.json().catch(() => ({}))) as { token?: unknown; error?: unknown };
  if (response.ok && typeof body.token === 'string') return { token: body.token };
  const said = typeof body.error === 'string' && body.error ? body.error : `it answered ${response.status}`;
  return { refused: `the bridge refused: ${said}`, status: response.status };
}

/**
 * The automation account: the bot whose role is `automation`, or the one
 * `install.json` names as a seat or a name. Asked of the crew each time, as
 * the bridge does, because its name is its account's handle once one
 * connects. An `automationBotName` of `flow`, which every `fleet init` wrote
 * before the rename, is read as the seat that persona was.
 */
async function automationBot(config: InstallConfig): Promise<Bot | null> {
  return automationBotOf(await bots.listBots(), config.automationBotName ?? null);
}

/**
 * The name a seat's sign-in is filed under, as the bridge files it
 * (`signInOf`, apps/bridge/src/actors.ts): its identity's, which seats on one
 * account share, else its own name. Looked up under the seat's name alone,
 * an automation seat on the crew's shared account found nothing with the
 * bridge down, and was told to sign in again, which changed nothing.
 */
async function signInOf(bot: Bot): Promise<string> {
  return (await identities.identityOfBot(bot.id))?.secretNs ?? bot.name;
}

async function automationClient(config: InstallConfig): Promise<AutomationClient> {
  const bot = await automationBot(config);
  const notConnected = (name: string): AutomationClient => ({ reason: `${name} is not connected`, hint: `fleetadlc auth login --bot ${name}` });
  if (!bot) return notConnected(config.automationBotName ?? 'automation');
  const name = bot.name;
  const login = bot.githubLogin ?? name;

  // The bridge first, whatever this machine's store holds: it knows where a
  // seat on a shared account keeps its sign-in, and it refreshes under the lock.
  const asked = await tokenFromBridge(config, name);
  if ('token' in asked) return { client: new GitHubClient({ token: asked.token, actingAs: login }), login };
  if ('refused' in asked) return { reason: asked.refused, hint: asked.status === 404 ? `fleetadlc auth login --bot ${name}` : null };

  const store = getSecretStore();
  const signIn = await signInOf(bot);
  // A stored refresh token is the normal path; a static token is what an install
  // has when its app issues non-expiring user tokens.
  if (await store.get(refreshTokenRef(signIn))) {
    // Where the walkthrough keeps it too: an install set up from the console
    // has no client id in install.json, and was told to sign in again.
    const clientId = await githubClientId(config);
    if (!clientId) {
      return {
        reason: 'the bridge is not answering, and this install has no GitHub App client id to refresh the token with',
        hint: 'start the bridge: fleetadlc up, and run this again',
      };
    }
    // This path is for a stopped install, and says so. The lock is the one the
    // bridge's broker takes, so a bridge that is up after all, on some other
    // port, cannot spend the same refresh token at the same time.
    ui.warn('the bridge is not answering; refreshing this token directly');
    ui.note('run this while `fleetadlc up` is running and the bridge mints it instead');
    const broker = new TokenBroker({
      clientId: async () => (await githubClientId(config)) ?? '',
      exclusive: (key, fn) => withAdvisoryLock(key, fn),
    });
    try {
      const refreshed = await broker.tokenFor(signIn, login);
      return { client: new GitHubClient({ token: refreshed.token, actingAs: login }), login };
    } catch (error) {
      return { reason: error instanceof Error ? error.message : String(error), hint: null };
    }
  }

  const staticToken = await store.get(accessTokenRef(signIn));
  return staticToken ? { client: new GitHubClient({ token: staticToken, actingAs: login }), login } : notConnected(name);
}

const NO_APP_KEY_NOTE =
  'this machine holds no key for the OpenADLC app, so labels and rules are written as the automation account; ' +
  'on an organization’s repository, where it has triage, that fails: use the console’s repository setup instead';

/**
 * The app's key and client id, when this machine holds both: what label and
 * rule writes act with. The client id the console stored wins over
 * install.json's (`githubClientId`).
 */
async function appCredentials(config: InstallConfig): Promise<AppCredentials | null> {
  const privateKey = await getSecretStore()
    .get(appPrivateKeyRef())
    .catch(() => null);
  const clientId = await githubClientId(config);
  return privateKey && clientId ? { clientId, privateKey } : null;
}

/** The automation account's client, asked for once and only when something needs it. */
function lazyAutomation(config: InstallConfig): () => Promise<AutomationClient> {
  let found: Promise<AutomationClient> | null = null;
  return () => (found ??= automationClient(config));
}

/** Who writes a repository's labels and rules, as its heading says it. */
type Writer = { client: GitHubClient; as: string } | { reason: string; hint: string | null; as?: string };

/**
 * The client that writes one repository's labels and rules: the OpenADLC
 * app, with an installation token minted for that repository alone, as the
 * console's repository setup does (`RepoSetup.asApp`), and the automation
 * account only when this machine holds no app key. The automation account
 * is invited to an organization's repository with triage, which may put a
 * label on an issue but not create or rename one: every create, and the
 * `sdlc:` to `adlc:` rename, failed with a warning per label.
 */
export async function repositoryWriter(
  repoFullName: string,
  app: AppCredentials | null,
  automation: () => Promise<AutomationClient>,
  mint: (credentials: AppCredentials, repoFullName: string) => Promise<string> = async (credentials, fullName) =>
    (await installationTokenFor(APP_API, credentials, fullName)).token,
): Promise<Writer> {
  if (app) {
    try {
      const token = await mint(app, repoFullName);
      return { client: new GitHubClient({ token, actingAs: 'fleetadlc-app' }), as: 'as the OpenADLC app' };
    } catch (error) {
      return {
        reason: `${repoFullName}: the OpenADLC app could not act on it: ${error instanceof Error ? error.message.slice(0, 120) : error}`,
        hint: 'install the app on this repository (the app’s page on GitHub → Configure), or set it up from the console’s repository setup',
        as: 'as the OpenADLC app',
      };
    }
  }
  const found = await automation();
  if (!('client' in found)) return found;
  return { client: found.client, as: `as ${found.login}, the automation account (no app key held)` };
}

function noWriter(found: { reason: string; hint: string | null }): void {
  ui.fail(found.reason);
  if (found.hint) ui.note(found.hint);
  process.exitCode = 1;
}

/**
 * What `github check` says about the automation account's access to one
 * repository. Triage is what the setup gives it on an organization's
 * repository, on purpose: it may put labels on issues, which is all the
 * bridge asks of it. It was called "read only (labels and statuses will
 * fail)", about the role it was meant to have.
 */
export function repositoryAccessLine(
  fullName: string,
  permissions: Record<string, boolean>,
  appKeyHeld: boolean,
): { ok: boolean; text: string } {
  if (permissions.push === true || permissions.admin === true || permissions.maintain === true) {
    return { ok: true, text: `${fullName} reachable, write access` };
  }
  if (permissions.triage === true) {
    return appKeyHeld
      ? { ok: true, text: `${fullName} reachable, triage: the account may apply labels; creating or renaming labels and applying rules are done as the app` }
      : {
          ok: false,
          text: `${fullName} reachable, triage: the account may apply labels, but this machine holds no app key, so sync-labels and apply will fail here; use the console’s repository setup`,
        };
  }
  return { ok: false, text: `${fullName} reachable with pull access only: the account cannot apply labels or set statuses; invite it with triage` };
}

/** Says why there is no automation client, and marks the command failed. */
async function noAutomation(found: { reason: string; hint: string | null }): Promise<void> {
  ui.fail(found.reason);
  if (found.hint) ui.note(found.hint);
  await closePool();
  process.exitCode = 1;
}

/**
 * What the bridge's apply remembers (`recordPlanLimits`), remembered the same
 * way here: the environments GitHub's plan refused, under the plan state it
 * refused them in.
 */
async function rememberPlanLimits(
  client: Parameters<typeof repositoryPlanState>[0],
  repoFullName: string,
  outcomes: { name: string; action: string; detail: string }[],
): Promise<void> {
  const limits = outcomes
    .filter((one) => one.action === 'unsupported' && one.name.startsWith('environment '))
    .map((one) => ({ name: one.name, detail: one.detail }));
  if (limits.length === 0) {
    // A skipped production step did not show that GitHub can hold a reviewer.
    // Clearing the row there let the next promote dispatch with nothing holding
    // it. An apply that did write production forgets the old refusal: after a
    // plan upgrade the stale row held every promote twice.
    const production = outcomes.find((one) => one.name === 'environment production');
    if (!production || production.action === 'skipped') return;
    await repos.clearPlanLimits(repoFullName).catch(() => undefined);
    return;
  }
  const state = await repositoryPlanState(client, repoFullName).catch(() => null);
  if (state) await repos.setPlanLimits(repoFullName, { limits, ...state }).catch(() => undefined);
}
