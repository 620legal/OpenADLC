import { theApp } from '../people.js';
import { movedHumans } from '../human-ids.js';
import { readAccounts } from '../github-identities.js';
import { signInKind } from '../sign-in.js';
import { createHash } from 'node:crypto';
import { attributions, audit, bots, credentials, deployRuns, identities, issues, lastAudit, lastGithubDelivery, leases, modelAccounts, repos, tasks } from '@fleetadlc/db';
import {
  GitHubClient,
  accountExists,
  accountOf,
  appClientSecretRef,
  appPrivateKeyRef,
  clientSecretAccepted,
  credentialKind,
  getSecretStore,
  installationTokenFor,
  publicKeyOf,
  readConfigFiles,
  requestDeviceCode,
  reviewerStandingOf,
  signingKeyRef,
  generateSigningKey,
  type AppCredentials,
} from '@fleetadlc/github';
import type { Actors } from '../actors.js';
import type { AppReach } from '../app-reach.js';
import type { BridgeConfig } from '../config.js';
import { effectiveConfig } from '../effective-config.js';
import type { HostdClient } from '../hostd-client.js';
import { APP_API } from '../invitation-service.js';
import { Attribution, bodyDigest, postPath, postTarget } from '../attribution.js';
import { asAutomation, automationBotName } from '../automation-bot.js';
import { reviewerStandings } from '../automation.js';
import { defaultModelAccountDeps, listAccountModels } from '../model-accounts.js';
import type { RepoSetup } from '../repo-setup.js';
import type { WebhookSetup } from '../webhook-setup.js';
import { appChecks } from './checks/app.js';
import { commitEmailCheck } from './checks/commit-email.js';
import { crewChecks, type RepoRef } from './checks/crew.js';
import { dispatchModeOf, dispatcherCheck, type DispatchMode } from './checks/dispatcher.js';
import { githubAccountsCheck } from './checks/github-accounts.js';
import { hostCheck, hostDriverCheck } from './checks/host.js';
import { attributionCheck } from './checks/attribution.js';
import { leaseCheck } from './checks/leases.js';
import { deployDispatchCheck } from './checks/deploy-dispatch.js';
import { RETRY_WITHIN_MS } from '../deploy-pipeline.js';
import { modelAccountCheck } from './checks/models.js';
import { humanReviewLinesInspection, namedLoginsInspection, repoConfigCheck } from './checks/repo-config.js';
import { repoOwnerCheck } from './checks/repo-owner.js';
import { rulesCheck, skippedByLastApply } from './checks/repository.js';
import { webhookCheck } from './checks/webhook.js';
import { deliveryCheck, productionEnvironmentOf } from './checks/delivery.js';
import { effectiveDelivery, type DeliveryKnowledge } from '../delivery-rules.js';
import type { HealthCheck } from './types.js';

export { HealthRegistry } from './registry.js';
export type { HealthCheck } from './types.js';

export interface HealthWiring {
  config: BridgeConfig;
  actors: Actors;
  hostd: HostdClient;
  webhookSetup: WebhookSetup;
  repoSetup: RepoSetup;
  /** Whether the app can reach each repository: the same answers crew access and settings give. */
  appReach?: AppReach;
  /**
   * How this bridge dispatches, from where `main.ts` builds the dispatcher;
   * the pause route is given the same. Absent is read from the environment
   * the same way, so a test that leaves it out still registers the check.
   */
  dispatch?: DispatchMode;
  /** Each repository's delivery rules, as the pipeline reads them; absent, read here from GitHub. */
  delivery?: Pick<DeliveryKnowledge, 'get'>;
}

/** The public half of each stored key, by the private half's digest: ssh-keygen is not run every quarter hour. */
const publicHalves = new Map<string, string>();
function cachedPublicKeyOf(privateKey: string): string {
  const digest = createHash('sha256').update(privateKey).digest('hex');
  const known = publicHalves.get(digest);
  if (known) return known;
  const derived = publicKeyOf(privateKey);
  publicHalves.set(digest, derived);
  return derived;
}

/**
 * Every check this install runs, with the real GitHub, hostd and store behind
 * them. The checks themselves take readers, so a test gives each a fake.
 */
export function defaultChecks(wiring: HealthWiring): HealthCheck[] {
  const { config, actors, hostd } = wiring;

  const clientId = async (): Promise<string> => (await effectiveConfig(config)).gitHubClientId;
  const appCredentials = async (): Promise<AppCredentials | null> => {
    const id = await clientId();
    const privateKey = await getSecretStore().get(appPrivateKeyRef());
    return id && privateKey ? { clientId: id, privateKey } : null;
  };
  const repositories = async (): Promise<RepoRef[]> =>
    (await repos.listRepos()).map((repo) => ({ name: repo.name, fullName: repo.fullName, defaultBranch: repo.defaultBranch || 'main' }));

  const app = appChecks({
    clientId,
    credentials: appCredentials,
    api: APP_API,
    repositories,
    requestDeviceCode: (id) => requestDeviceCode({ clientId: id }),
    // Every seat, and every account no seat is on: an account held for later
    // keeps its sign-in as much as one in use.
    tokenKinds: async () => {
      const [crew, held, seated] = await Promise.all([bots.listBots(), identities.listIdentities(), identities.seatIdentities()]);
      const onSeat = new Set(seated.map((row) => row.identityId));
      const kinds = await Promise.all([
        ...crew.map(async (bot) => ({ who: bot.name, kind: await signInKind(bot).catch(() => null) })),
        ...held
          .filter((identity) => !onSeat.has(identity.id))
          .map(async (identity) => ({ who: identity.login, kind: await credentialKind(identity.secretNs, getSecretStore()).catch(() => null) })),
      ]);
      return kinds.filter((one): one is { who: string; kind: 'refresh' | 'static' } => one.kind !== null);
    },
    reach: wiring.appReach ? (fullName) => wiring.appReach!.reach(fullName) : undefined,
    installations: wiring.appReach ? () => wiring.appReach!.installationsView() : undefined,
    enforcesRules: () => wiring.repoSetup.enforcesRules(),
    clientSecret: () => getSecretStore().get(appClientSecretRef()),
    lastScoped: () => actors.lastScoped(),
    // Asked with the automation account's token, or the first bot's that has one.
    secretAccepted: async (id, secret) => {
      for (const name of [await automationBotName(config), ...(await bots.listBots()).map((bot) => bot.name)]) {
        const minted = await actors.tokenFor(name).catch(() => null);
        if (minted) return clientSecretAccepted({ clientId: id, clientSecret: secret, accessToken: minted.token });
      }
      return null;
    },
  });

  /**
   * Whether the default branch requires signed commits, as GitHub enforces it:
   * a ruleset's `required_signatures`, or classic branch protection's. Asked
   * as the app, which can read both.
   */
  const requiresSignatures = async (repo: RepoRef): Promise<boolean | null> => {
    const credentials = await appCredentials();
    if (!credentials) return null;
    const { token } = await installationTokenFor(APP_API, credentials, repo.fullName);
    const github = new GitHubClient({ token, actingAs: 'fleetadlc-app' });
    const branch = encodeURIComponent(repo.defaultBranch);
    const rules = await github
      .request<{ type?: string }[]>('GET', `/repos/${repo.fullName}/rules/branches/${branch}`)
      .catch(() => null);
    if (rules?.some((rule) => rule.type === 'required_signatures')) return true;
    const classic = await github
      .request<{ enabled?: boolean }>('GET', `/repos/${repo.fullName}/branches/${branch}/protection/required_signatures`)
      .then((answer) => answer.enabled === true)
      .catch(() => false);
    return classic || (rules ? false : null);
  };

  /** A token that acts as the bot, which the crew's checks and the commit-email check ask GitHub with. */
  const botToken = async (bot: { name: string }): Promise<string> => {
    const minted = await actors.tokenFor(bot.name);
    if (!minted) throw new Error(`${bot.name} is not connected to GitHub`);
    return minted.token;
  };

  const crew = crewChecks({
    crew: () => bots.listBots(),
    repositories,
    credential: async (bot) => ({
      kind: await signInKind(bot).catch(() => null),
      status: (await credentials.getCredential(bot.id).catch(() => null))?.status ?? null,
    }),
    token: botToken,
    // The account's, for a seat on one, else what its own sign-in recorded.
    githubUserId: async (bot) =>
      (await identities.identityOfBot(bot.id).catch(() => null))?.githubUserId ??
      (await credentials.getCredential(bot.id).catch(() => null))?.githubUserId ??
      null,
    github: (token, login) => new GitHubClient({ token, actingAs: login }),
    // A connected seat that commits and has no key yet is given one here, and
    // the check then registers it: a seat put on a shared account while its
    // sign-in could not act had none made, and "reconnect" is no fix for a
    // seat whose account is working.
    signingKey: async (bot) => {
      const store = getSecretStore();
      const stored = await store.get(signingKeyRef(bot.name));
      if (stored) return stored;
      const pair = generateSigningKey(bot.name);
      await store.set(signingKeyRef(bot.name), pair.privateKey);
      return pair.privateKey;
    },
    publicKeyOf: cachedPublicKeyOf,
    requiresSignatures,
    appLacksSigningPermission: async () => app.lacks('git_signing_ssh_public_keys'),
    recordKeyId: (bot, keyId) => credentials.setSigningKeyId(bot.id, keyId),
  });

  const modelDeps = defaultModelAccountDeps(hostd);

  // Asked as the automation account, the same one that requests reviews and
  // reads AGENTS.md for the gate, so the check and the gate see one answer.
  const automation = () => asAutomation(actors, config).catch(() => null);
  const repoConfig = repoConfigCheck(
    {
      repositories,
      files: async (repo) => {
        const client = await automation();
        return client ? readConfigFiles(client, repo.fullName, repo.defaultBranch) : null;
      },
      humans: async () => (await effectiveConfig(config)).humans,
      exists: async (login) => {
        const client = await automation();
        return client ? accountExists(client, login) : null;
      },
      movedHumans: (humans) =>
        movedHumans(humans, async (login) => {
          const client = await automation();
          const account = client ? await accountOf(client, login) : null;
          return account ? (account.id ?? null) : account;
        }),
    },
    [
      // Asked afresh on every run, and kept for the gates: this is how a
      // person invited or a name corrected reaches a pull request's gate.
      namedLoginsInspection((repo, login) =>
        reviewerStandings.of(
          repo,
          login,
          async (where, who) => {
            // The app first: it can read a collaborator's permission, and the
            // automation account, holding triage, is told nothing.
            const client = (await theApp(where)) ?? (await automation());
            return client ? reviewerStandingOf(client, where, who) : { state: 'unknown', reason: 'there is no automation account to ask GitHub as' };
          },
          { fresh: true },
        ),
        async (login) => {
          const client = await automation();
          return client ? accountExists(client, login) : null;
        },
      ),
      humanReviewLinesInspection(),
    ],
  );

  return [
    hostCheck(hostd),
    hostDriverCheck(hostd),
    dispatcherCheck(wiring.dispatch ?? dispatchModeOf(process.env.FLEETADLC_DISPATCH_IN_BRIDGE === '1')),
    webhookCheck({
      status: () => wiring.webhookSetup.status(),
      lastHeard: async () => (await lastGithubDelivery())?.at ?? null,
    }),
    app.installed,
    app.permissions,
    app.deviceFlow,
    app.tokenExpiry,
    app.clientSecret,
    app.selection,
    githubAccountsCheck({
      // The same read settings uses. A seatless account is asked of the token
      // broker: a stored token nothing has refreshed is not a working sign-in.
      // GitHub not reached, or answering with an outage, is no verdict on the
      // sign-in: read as refused, it raised a reconnect card during an outage.
      accounts: async () => {
        const unasked = new Set<string>();
        const { accounts } = await readAccounts(getSecretStore(), async (account) => {
          const state = await actors.signInState(account);
          if (state === 'failed') unasked.add(account.login);
          return state === 'works' ? true : state === 'unknown' ? null : false;
        });
        return accounts.map((account) => ({ login: account.login, signIn: unasked.has(account.login) ? 'unknown' : account.signIn }));
      },
    }),
    crew.signIn,
    crew.access,
    crew.signingKey,
    commitEmailCheck({
      crew: () => bots.listBots(),
      repositories,
      token: botToken,
      github: (token, login) => new GitHubClient({ token, actingAs: login }),
    }),
    modelAccountCheck({
      accounts: () => modelAccounts.list(),
      crew: () => bots.listBots(),
      models: (account) => listAccountModels(account.id, modelDeps),
      login: (account) => hostd.loginStatus(account.id),
    }),
    rulesCheck({
      plan: () => wiring.repoSetup.plan(),
      // The last apply itself, not the last among the newest few hundred
      // entries of any kind, which a busy install had long pushed past.
      refused: async (repository) => {
        const applied = await lastAudit('repo.rules_applied', repository);
        const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
        return skippedByLastApply(list(applied?.payload?.outcomes), list(applied?.payload?.planRefused));
      },
    }),
    repoConfig,
    repoOwnerCheck({ repos: () => repos.listRepos() }),
    deliveryCheck({
      repos: async () =>
        (await repos.listRepos()).map((repo) => ({ name: repo.name, fullName: repo.fullName, defaultBranch: repo.defaultBranch })),
      rules: async (repo) => {
        const record = await repos.getRepoByName(repo.name);
        if (!record) return null;
        if (wiring.delivery) return (await wiring.delivery.get(record)).rules;
        return (await effectiveDelivery({ repo: record, client: await asAutomation(actors, config).catch(() => null) })).rules;
      },
      production: async (fullName) => {
        const client = await asAutomation(actors, config).catch(() => null);
        if (!client) return undefined;
        try {
          const body = await client.request<Parameters<typeof productionEnvironmentOf>[0]>('GET', `/repos/${fullName}/environments/production`);
          // Custom branch policies are listed apart; unread, the branches are not judged.
          const policies = body.deployment_branch_policy?.custom_branch_policies
            ? await client
                .request<{ branch_policies?: { name?: string; type?: string }[] }>(
                  'GET',
                  `/repos/${fullName}/environments/production/deployment-branch-policies?per_page=100`,
                )
                .then((listed) => listed.branch_policies ?? [])
                .catch(() => undefined)
            : [];
          return productionEnvironmentOf(body, policies);
        } catch (error) {
          return (error as { status?: number }).status === 404 ? null : undefined;
        }
      },
      planRefused: async (fullName) =>
        Boolean((await repos.getPlanLimits(fullName).catch(() => null))?.limits.some((limit) => limit.name === 'environment production')),
      // A crew that could not be read is no answer, not an empty crew: read as
      // nobody, no reviewer matched it and every repository passed.
      crewLogins: async () => (await bots.listBots()).map((bot) => bot.githubLogin).filter((login): login is string => Boolean(login)),
    }),
    leaseCheck({
      leases: () => leases.listActiveLeases(),
      repos: () => repos.listRepos(),
      tasksOn: (refs) => tasks.listTasksOnSubjects(refs),
      issue: async (repoId, number) => {
        const found = await issues.getIssue(repoId, number);
        return found ? { title: found.title, prNumber: found.prNumber } : null;
      },
      botName: async (botId) => (await bots.getBotById(botId))?.name ?? null,
      release: async (lease, why) => {
        if (!(await leases.releaseIfIdle(lease.id))) return false;
        await audit({
          actor: 'fleetadlc',
          action: 'lease.released_idle',
          target: `issue #${lease.issueNumber}`,
          payload: { leaseId: lease.id, botId: lease.botId, why },
        });
        return true;
      },
    }),
    deployDispatchCheck({
      undispatched: (before) => deployRuns.undispatchedSince(before, new Date(Date.now() - RETRY_WITHIN_MS)),
      unfinishedRollbacks: () => deployRuns.unfinishedRollbacks(new Date(Date.now() - RETRY_WITHIN_MS)),
      repos: () => repos.listRepos(),
      workflow: async (repo, step) => {
        const record = await repos.getRepoByName(repo.name);
        if (!record || !wiring.delivery) return null;
        const { rules, readError } = await wiring.delivery.get(record);
        if (readError) return null;
        return step === 'rollback' ? rules.production.rollback : rules.production.workflow;
      },
    }),
    attributionCheck({
      since: (since) => attributions.listUnattributed(since),
      mode: async () => (await effectiveConfig(config)).attributionMode,
      // Read again from GitHub as the automation account, and checked under
      // the rules as they are now; a post that verifies after all is resolved.
      reverify: async (post) => {
        const path = post.objectId ? postPath({ ...post, objectId: post.objectId }) : null;
        const client = path ? await asAutomation(actors, config).catch(() => null) : null;
        if (!path || !client) return null;
        const found = await client.request<{ body?: string | null }>('GET', path).catch(() => null);
        if (!found) return null;
        // Edited since it was recorded: what verifies now is not what was posted.
        if (!post.bodySha256 || bodyDigest(found.body) !== post.bodySha256) return false;
        return new Attribution().verifies({
          repo: post.repo,
          kind: post.kind,
          id: post.objectId!,
          number: postTarget(post.url)?.number ?? null,
          login: post.login,
          body: found.body ?? null,
        });
      },
      // Closing a security record: said in the audit trail, once, with what it was.
      resolve: async (post) => {
        if (post.id === undefined || !(await attributions.resolveUnattributed(post.id))) return;
        await audit({
          actor: 'fleetadlc',
          action: 'attribution.resolved',
          target: `${post.repo} post:${post.id}`,
          payload: { postId: post.id, kind: post.kind, repo: post.repo, login: post.login, url: post.url, reason: post.reason },
        }).catch(() => undefined);
      },
    }),
  ];
}

/** Whether nothing has ever run here: the install is still being set up, and nothing is sent. */
export async function settingUp(): Promise<boolean> {
  return (await tasks.listTasks({ limit: 1 })).length === 0;
}

/** Each bot's name by its id. */
export async function botNames(): Promise<Map<string, string>> {
  return new Map((await bots.listBots()).map((bot) => [bot.id, bot.name]));
}
