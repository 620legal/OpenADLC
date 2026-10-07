import { randomUUID } from 'node:crypto';
import { HttpFailure } from './router.js';
import { signInKind, signInOf } from './sign-in.js';
import { audit, bots, credentials, identities, repos, type HealthRow } from '@fleetadlc/db';
import {
  GitHubApiError,
  GitHubClient,
  credentialKind,
  appPrivateKeyRef,
  getSecretStore,
  installationTokenFor,
  pollForUserToken,
  refreshTokenRef,
  accessTokenRef,
  requestDeviceCode,
  signingKeyRef,
  type UserToken,
} from '@fleetadlc/github';
import {
  GITHUB_DEVICE_URL,
  GITHUB_EMAIL_SETTINGS_URL,
  GITHUB_SIGNUP_URL,
  MANUAL_STEPS,
  ONBOARDING_STEPS,
  REQUIRED_APP_PERMISSIONS,
  REQUIRED_APP_SETTINGS,
  STEP_TITLES,
  WEBHOOK_EVENTS,
  accessReasonFor,
  accountGroupOf,
  accountHolder,
  otherGroupHolder,
  otherGroupRefusal,
  automationBotOf,
  holdsCredential,
  inviteUrl,
  resolveBotRef,
  sameLogin,
  newAppUrl,
  yourAppsUrl,
  repositoryRoleOffered,
  roleLabel,
  suggestBotEmail,
  suggestedLogin,
  type Bot,
  type HealthAction,
  type HealthSeverity,
  type ManualStep,
  type OnboardingStep,
} from '@fleetadlc/shared';
import type { Actors } from './actors.js';
import { ensureSigningKeyRegistered } from './signing-keys.js';
import { accountSecretNs, accountsView, assignmentRefusal, groupOfAccount, readAccounts, type GitHubAccountsView } from './github-identities.js';
import { guardRefusal, liveGuardDeps, peopleOf, type AccountGuardDeps, type Person } from './account-guard.js';
import type { BotNames } from './bot-names.js';
import type { BridgeConfig } from './config.js';
import { reviewRulesOf } from './automation.js';
import { effectiveConfig } from './effective-config.js';
import type { WebhookSetup } from './webhook-setup.js';
import type { HealthRegistry } from './health/registry.js';
import { isWaiting, failingIds, stepVerdicts } from './health/state.js';
import { loginAvailable, lookUpAccount } from './github-accounts.js';
import { APP_API, type CrewAccess, type InvitationService } from './invitation-service.js';
import type { CrewAccessKeeper } from './crew-access.js';

export interface OnboardingBot {
  /**
   * What the bot is called: its account's handle once one is connected, its
   * seat until then. It changes when an account connects.
   */
  bot: string;
  /** The seat it was seeded into, which never changes: `builder`, `lead-reviewer`. */
  slot: string;
  displayName: string;
  role: string;
  /** What that role is called, so the console needs no copy of the mapping. */
  roleLabel: string;
  login: string;
  suggestedLogin: string;
  suggestedEmail: string | null;
  emailNote: string;
  repositoryRole: 'triage' | 'write';
  accessReason: string;
  /** null when GitHub could not be asked yet, so the page can say so. */
  accountExists: boolean | null;
  /**
   * Whether a credential is *stored* for this bot. It is not whether that
   * credential works — see `authorizationWorks`.
   */
  connected: boolean;
  /**
   * Whether the stored credential can still act as the bot, asked of GitHub.
   *
   * Null when there is nothing stored to try. False is the state that used to
   * be invisible: a refresh token that GitHub has since invalidated leaves the
   * file on disk and the row in the database, so `connected` stays true and the
   * page reported nine working accounts over nine dead ones. Restoring a backup
   * whose tokens had been rotated since produced exactly that, and the only
   * place it showed was a line in the bridge's log.
   */
  authorizationWorks: boolean | null;
  credentialKind: 'refresh' | 'static' | null;
  tokenExpiresAt: string | null;
  hasSigningKey: boolean;
  /**
   * What GitHub says about the account, once it is connected. Null before that.
   *
   * Read from the connection rather than assembled from what OpenADLC suggested:
   * somebody who connected an account they already had was shown the address
   * OpenADLC would have proposed, as though it were the account's own.
   */
  profile: { login: string; name: string | null; email: string | null; avatarUrl: string; htmlUrl: string } | null;

  /**
   * Whether this bot is in the repositories yet — every one of them: a bot
   * missing from one is a bot that cannot work there. A bot can be connected,
   * hold a valid token and still be outside — an unaccepted invitation looks
   * exactly like a working install until the first push fails.
   */
  inRepository: boolean | null;
  /** The same, one repository at a time. */
  access: { repository: string; inRepository: boolean | null }[];
}

/** In every repository: false when out of any, true when in all, null while any is unknown. */
export function inEvery(access: readonly { inRepository: boolean | null }[]): boolean | null {
  if (access.length === 0) return null;
  if (access.some((one) => one.inRepository === false)) return false;
  return access.every((one) => one.inRepository === true) ? true : null;
}

export interface OnboardingView {
  organization: string | null;
  /** Whether that name is really an organization: a personal account has no teams. */
  organizationIsOrg: boolean | null;
  repositories: string[];
  clientIdConfigured: boolean;
  webhookSecretConfigured: boolean;
  /**
   * Whether GitHub can actually reach this bridge, which is not the same as a
   * secret having been saved: a tunnel address outlives the tunnel behind it.
   */
  webhookReady: boolean;
  /** The address suggestions were built from, stored or supplied. */
  operatorEmail: string;
  humans: string[];
  steps: { step: OnboardingStep; title: string; done: boolean; detail: string }[];
  /**
   * The GitHub accounts OpenADLC holds, apart from which seat uses which. The
   * accounts step is done from these; absent from a bridge that still counted
   * seats, and when reading them failed, so the health check decides instead.
   */
  githubAccounts?: {
    login: string;
    signIn: 'signed-in' | 'needs-reconnecting' | 'not-signed-in';
    group: 'crew' | 'reviewers' | 'mixed' | null;
    /** Seats on this account. The walkthrough offers Disconnect only when this is empty. */
    seats: { name: string }[];
  }[];
  bots: OnboardingBot[];
  links: { signup: string; emailSettings: string; device: string; newApp: string; yourApps: string; invite: string | null };
  appSettings: typeof REQUIRED_APP_SETTINGS;
  appPermissions: typeof REQUIRED_APP_PERMISSIONS;
  webhookEvents: readonly string[];
  webhookUrl: string;
  complete: boolean;
  /**
   * What the health checks say about each step a person does, by the
   * console walkthrough's step: done when a check proves it, not done when one
   * fails — with what fails, to say on the step — and null when no check has
   * an answer yet. The same checks that put a card on the board.
   */
  checks: Record<ManualStep, StepCheck>;
}

/** One step's verdict from the health checks. */
export interface StepCheck {
  done: boolean | null;
  failing: {
    id: string;
    title: string;
    detail: string;
    severity: HealthSeverity;
    action: HealthAction | null;
    /** Waiting for another check's fix, which comes first. */
    waiting: boolean;
  }[];
}

/** What connecting a seat did: the console's answer, and what `fleetadlc auth login` prints. */
export interface ConnectOutcome {
  /** The account that approved, as GitHub spells it. */
  login: string;
  /** What the seat is called now. */
  bot: string;
  /** The seat already on that account, which this one joined; absent when it connected on its own. */
  joined?: string;
  /** Connected, with something a person still has to do: a signing key GitHub refused. */
  warning?: string;
}

interface PendingAuthorization {
  botId: string;
  /** The bot's name: what it was called when this started, then what it is called once connected. */
  bot: string;
  login: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresAt: number;
  state: 'waiting' | 'connected' | 'failed';
  error?: string;
  /** Connected, with something a person still has to do — a signing key GitHub refused. */
  warning?: string;
  startedBy: string;
}

/** A device flow for an account on its own, for no seat: settings' "Connect a GitHub account". */
interface AccountFlow {
  flowId: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresAt: number;
  state: 'waiting' | 'connected' | 'failed';
  /** The account that approved it, once one has. */
  login?: string;
  error?: string;
  startedBy: string;
}

/**
 * What the `bot-sign-in` check proved about a seat, for settings' accounts
 * card: true when it signed in, false when GitHub refused it, null when the
 * check has nothing to say about the sign-in there is now.
 *
 * A row from before the seat last signed in says nothing about this sign-in:
 * right after a reconnect the row still says failing until the check runs
 * again, and the card said "Needs reconnecting" over an account that had just
 * worked. A failing row that is not GitHub refusing it — a seat with no
 * account yet, just given one — is no verdict on the account either.
 */
export function provenSignIn(
  row: Pick<HealthRow, 'state' | 'checkedAt' | 'facts'> | undefined,
  authorizedAt: string | null,
): boolean | null {
  if (!row) return null;
  if (authorizedAt && Date.parse(row.checkedAt) < Date.parse(authorizedAt)) return null;
  if (row.state === 'ok') return true;
  if (row.state === 'failing' && row.facts?.refused === true) return false;
  return null;
}

/**
 * What the walkthrough's access step says. One path, whoever owns the
 * repository: OpenADLC invites each account as a collaborator with its seat's
 * role, and on an organization GitHub adds an account that is already a member
 * directly. It used to tell an organization to add each account to its team,
 * and that no invitations are sent there, neither of which OpenADLC needs or does.
 */
export function accessStepDetail(organizationIsOrg: boolean | null, organization: string | null): string {
  if (!organization) return 'OpenADLC invites each account to the repository as a collaborator, with the role in the table';
  return organizationIsOrg === true
    ? `OpenADLC invites each account to ${organization}'s repositories as a collaborator, with the role in the table; GitHub adds a member of ${organization} directly`
    : `OpenADLC invites each account to ${organization}'s repositories as a collaborator, with the role in the table`;
}

/**
 * What the walkthrough can already say is true, before a health check moves a tick.
 *
 * The same list the console walks. Done here is what this view can ask; the
 * console asks the app checks and the model accounts on top of it. `install`,
 * `models`, `crew`, `protect` and `done` are not settled from this view alone —
 * installing is GitHub's page, the model steps are hostd's, and protection is
 * `fleetadlc github check` — so they are not what `complete` is made of.
 */
export interface WalkthroughFacts {
  organization: string | null;
  organizationIsOrg: boolean | null;
  clientIdConfigured: boolean;
  repositoryCount: number;
  crewCount: number;
  existingAccounts: number;
  connected: number;
  /** Accounts whose sign-in still works, however many seats are on them. */
  workingAccounts: number;
  inRepository: number;
  webhookReady: boolean;
  webhookStale: boolean;
}

/**
 * Whether the install's owner is an organization, or null when GitHub gave no
 * answer. The login goes into the path encoded: a stored value is a login, but
 * one saved before the bridge checked it could carry an `@` or a `/`.
 */
export async function isOrganization(organization: string, client: Pick<GitHubClient, 'request'> | null): Promise<boolean | null> {
  if (!client) {
    return lookUpAccount(organization)
      .then((found) => (found.exact ? found.exact.type === 'Organization' : null))
      .catch(() => null);
  }
  return client
    .request('GET', `/orgs/${encodeURIComponent(organization)}`)
    .then(() => true)
    // 404 is GitHub saying it is no organization; anything else is no answer.
    .catch((error) => (error instanceof GitHubApiError && error.status === 404 ? false : null));
}

export function walkthroughSteps(facts: WalkthroughFacts): OnboardingView['steps'] {
  const where = facts.repositoryCount > 1 ? 'every repository' : 'the repository';
  const detail: Record<OnboardingStep, string> = {
    start: 'a backup restores onto a clean install; otherwise start fresh',
    owner: facts.organization
      ? `the repositories belong to ${facts.organization}`
      : 'the GitHub organization or account that owns the repositories',
    app: facts.clientIdConfigured
      ? 'the device-flow client is configured'
      : 'OpenADLC needs one GitHub App as its OAuth client, with device flow and expiring tokens enabled. Creating it does not install it',
    install: 'install the app on the owner. Creating the app does not install it, and no API can',
    webhook: facts.webhookStale
      ? 'the address it had was a tunnel that is no longer running'
      : 'without it the bridge only sees what it polls for',
    repository:
      facts.repositoryCount > 0
        ? `${facts.repositoryCount} configured, from what the app’s installation can reach`
        : 'chosen from the repositories the app’s installation can reach',
    'github-accounts':
      facts.workingAccounts >= 2
        ? `${facts.workingAccounts} accounts connected`
        : 'two accounts: one that does the work and one that approves it',
    models: 'a model key or a subscription sign-in, for the accounts the crew thinks with',
    crew: 'which seat thinks with which model account, once the GitHub accounts and the model accounts exist',
    access: `${facts.inRepository} of ${facts.crewCount} seats can work in ${where}; OpenADLC accepts an invitation when a bot connects, given \`Administration\` on the app. ${accessStepDetail(facts.organizationIsOrg, facts.organization)}`,
    protect:
      'run `fleetadlc github apply`, then `fleetadlc github check`. What it can set depends on the plan, not on who owns the repository: on a private repository, rulesets and CODEOWNERS need GitHub Pro (a person’s account), GitHub Team or GitHub Enterprise, and a required environment reviewer needs Enterprise. `check` reports what this one supports',
    done: 'the crew is connected and the repositories are protected',
  };
  const done: Record<OnboardingStep, boolean> = {
    start: false,
    owner: Boolean(facts.organization),
    app: facts.clientIdConfigured,
    install: false,
    webhook: facts.webhookReady,
    repository: facts.repositoryCount > 0,
    // Two working accounts, not one per seat. Which seat uses which is Crew.
    'github-accounts': facts.workingAccounts >= 2,
    models: false,
    crew: false,
    access: facts.crewCount > 0 && facts.inRepository === facts.crewCount,
    protect: false,
    done: false,
  };
  return ONBOARDING_STEPS.map((step) => ({ step, title: STEP_TITLES[step], done: done[step], detail: detail[step] }));
}

/**
 * Whether setup is far enough that the board is the useful page.
 *
 * The same facts the walkthrough used to require before it would leave someone
 * on the board: the app's client id, every account created and connected and in
 * the repositories, the labels written, and the webhook delivering. A step this
 * view cannot settle — installing, the model accounts, protection — is not part
 * of it, or a clean answer would never come and the board would stay unreachable.
 */
export function setupComplete(
  facts: Partial<WalkthroughFacts> &
    Pick<WalkthroughFacts, 'clientIdConfigured' | 'crewCount' | 'connected' | 'inRepository' | 'webhookReady'> & {
      labelsWritten: boolean;
      missingAccounts: number;
    },
): boolean {
  return (
    facts.clientIdConfigured &&
    facts.crewCount > 0 &&
    // Only an account GitHub says nobody holds. One it could not answer for —
    // its anonymous limit is sixty requests an hour — sent a working install's
    // board back to the walkthrough until the limit reset.
    facts.missingAccounts === 0 &&
    facts.connected === facts.crewCount &&
    facts.inRepository === facts.crewCount &&
    facts.labelsWritten &&
    facts.webhookReady
  );
}

/** How long Crew's account choices keep the list of people no bot may be. */
const PEOPLE_KEPT_MS = 5 * 60_000;

/**
 * How long a seatless account GitHub refused stays refused without asking
 * again. Half the `github-accounts` check's interval, so the walkthrough is
 * never staler than the check.
 */
const REFUSAL_REMEMBERED_MS = 5 * 60 * 1000;

/**
 * Walks a person through the part of the install only they can do: connecting
 * the GitHub accounts the crew signs in as, and putting each seat on one. It
 * reports what is already true rather than asking the person to remember, and
 * it drives the device flow so the codes appear where they are working instead
 * of in a terminal.
 */
export class Onboarding {
  /** One device flow per bot, by id: the name changes when it connects. */
  private readonly pending = new Map<string, PendingAuthorization>();
  /** Device flows for accounts on their own, by the id the console polls with. */
  private readonly accountFlows = new Map<string, AccountFlow>();
  /**
   * Every name a flow was started or finished under, to its bot. The console
   * starts a connect under the seat and keeps asking under the seat, and the
   * bot has a handle by the time the answer is in.
   */
  private readonly asked = new Map<string, string>();
  /**
   * When GitHub last refused a seatless account's sign-in, by where it is
   * filed; not when it could not be asked. A sign-in that works costs nothing
   * to ask again, since the broker keeps its token until it nearly expires; a
   * refused one is asked of GitHub afresh, and the walkthrough reads the list
   * on every load and several times after each connect. Connecting or
   * disconnecting forgets the entry.
   */
  private readonly refused = new Map<string, number>();
  private names?: BotNames;
  private health?: HealthRegistry;
  /**
   * Set once setup has been found complete, and kept for the life of the
   * process: the board asks on every refresh, and working it out asks GitHub
   * about every bot in every repository. A check that fails later sends nobody
   * back to the walkthrough anyway (see `view`); the board has a card for it.
   */
  private completed = false;

  constructor(
    private readonly config: BridgeConfig,
    private readonly actors: Actors,
    /**
     * Set after construction, because the invitation service needs `Actors` and
     * this needs the invitation service. Absent, connecting still works and the
     * bot is let in from the walkthrough instead.
     */
    private invitations?: InvitationService,
    /** Set the same way, and for the same reason: it is built after this is. */
    private webhookSetup?: WebhookSetup,
  ) {}

  /** Wired once both exist. */
  useInvitations(invitations: InvitationService): void {
    this.invitations = invitations;
  }

  /** What keeps the crew in every repository, which a bot that connects is let in through. */
  private crewAccess?: CrewAccessKeeper;

  useCrewAccess(crewAccess: CrewAccessKeeper): void {
    this.crewAccess = crewAccess;
  }

  /**
   * Set after construction, the same way the invitations are: the webhook setup
   * holds the tunnel this process raised, and the walkthrough needs to know
   * whether it is still up to tick that step honestly.
   */
  useWebhookSetup(webhookSetup: WebhookSetup): void {
    this.webhookSetup = webhookSetup;
  }

  /**
   * The routine a connected bot is renamed with, so it takes its account's
   * handle. Absent, a connection still works and the bridge's next reconcile
   * renames it.
   */
  useNames(names: BotNames): void {
    this.names = names;
  }

  /**
   * The health checks, which mark a step done when they prove it was, and are
   * asked again as soon as a bot connects rather than minutes later.
   */
  useHealth(registry: HealthRegistry): void {
    this.health = registry;
  }

  /** Each step a person does, as the health checks last saw it. */
  private async stepChecks(): Promise<Record<ManualStep, StepCheck>> {
    const steps = Object.keys(MANUAL_STEPS) as ManualStep[];
    const rows: HealthRow[] = this.health ? await this.health.rows().catch(() => []) : [];
    const verdicts = stepVerdicts(rows, this.health?.checks ?? [], steps);
    const failing = failingIds(rows);
    const out = {} as Record<ManualStep, StepCheck>;
    for (const step of steps) {
      out[step] = {
        done: verdicts[step].done,
        failing: verdicts[step].failing.map((row) => ({
          id: row.id,
          title: row.title ?? row.checkId,
          detail: row.detail ?? '',
          severity: row.severity ?? 'blocking',
          action: row.action,
          waiting: isWaiting(row, failing),
        })),
      };
    }
    return out;
  }

  /**
   * Whether setup is complete, as `view` says it, for the board to decide
   * whether to send someone to the walkthrough. Remembered once true, so an
   * open board asks GitHub nothing; worked out afresh while false, so a step
   * just finished is seen on the next load. Only what `setupComplete` reads is
   * gathered: no step checks, profiles or accounts list.
   */
  async complete(): Promise<boolean> {
    if (this.completed) return true;
    const { live, webhook, crew, repoList, automation, organizationIsOrg, lookupToken } = await this.setupFacts();
    const standing = await Promise.all(crew.map((bot) => this.standingOf(bot, repoList, organizationIsOrg, lookupToken)));
    const ofAutomation = automation ? standing[crew.indexOf(automation)] : undefined;
    const complete = setupComplete({
      clientIdConfigured: live.clientIdConfigured,
      crewCount: crew.length,
      missingAccounts: standing.filter((bot) => bot.accountExists === false).length,
      connected: standing.filter((bot) => bot.connected).length,
      inRepository: standing.filter((bot) => bot.inRepository === true).length,
      // As `view` reads it: labels are written once the automation account is connected and there is a repository.
      labelsWritten: Boolean(ofAutomation?.connected && repoList.length > 0),
      webhookReady: webhook.ready,
    });
    if (complete) this.completed = true;
    return complete;
  }

  /** What the walkthrough and `complete` both start from. */
  private async setupFacts() {
    // Read now, not at start-up: the console writes these and the next request
    // has to see them, or setting a client id in the browser does nothing.
    const live = await effectiveConfig(this.config);
    const webhook = (await this.webhookSetup?.localReadiness()) ?? {
      ready: live.webhookSecretConfigured,
      stale: false,
    };
    const crew = await bots.listBots();
    const repoList = await repos.listRepos();

    // Anything GitHub can answer is asked rather than assumed.
    const automation = automationBotOf(crew, live.automationBot);
    const client = automation ? await this.actors.asBot(automation.name) : null;
    const organization = live.organization || null;

    // Asked unauthenticated when no bot is connected, which at this point in
    // onboarding is always. It matters before the crew exists: whether the
    // owner is an organization decides whether `triage` can be granted, and the
    // table on this page tells somebody which role to pick. Defaulting to
    // "organization" while unknown printed `triage` for a user-owned
    // repository, where GitHub's form does not offer it.
    const organizationIsOrg = organization ? await isOrganization(organization, client) : null;

    // Minted once, and only when a seat whose sign-in does not work needs it.
    let automationToken: Promise<string | null> | undefined;
    const lookupToken = (): Promise<string | null> =>
      (automationToken ??=
        automation && client
          ? Promise.resolve()
              .then(() => this.actors.tokenFor(automation.name))
              .then((minted) => minted?.token ?? null)
              .catch(() => null)
          : Promise.resolve(null));
    return { live, webhook, crew, repoList, automation, client, organization, organizationIsOrg, lookupToken };
  }

  /**
   * What setting up needs of one bot: whether its account exists, whether it
   * holds a sign-in, and whether it can work in every repository.
   */
  private async standingOf(
    bot: Bot,
    repoList: { fullName: string }[],
    organizationIsOrg: boolean | null,
    lookupToken: () => Promise<string | null>,
  ) {
    const credential = await credentials.getCredential(bot.id);
    const kind = await signInKind(bot);
    const login = bot.githubLogin ?? suggestedLogin(bot.slot);

    // Asked once and shared. Two callers used to ask separately, and neither
    // reported that it had failed — they just quietly did something else.
    const connected = holdsCredential(kind, credential);
    const client = await this.actors.asBot(bot.name).catch(() => null);
    const authorizationWorks = connected ? client !== null : null;

    // An account whose sign-in works exists; GitHub is not asked. Otherwise
    // it is asked, as the automation bot when that one is connected, and
    // publicly when not: before anything is connected the page still has to
    // tell a bot whose account is to be made from one ready to be invited.
    // Asked anonymously for every seat, a board left open spent GitHub's
    // sixty requests an hour in minutes.
    const free = authorizationWorks === true ? false : await loginAvailable(login, { token: await lookupToken() }).catch(() => null);
    const accountExists = free === null ? null : !free;

    // Asked of GitHub rather than inferred, in every repository OpenADLC
    // works in: the bot's own token 404s on a private repository it has
    // not joined, and sees a public one with no right to push to it.
    const wanted = repositoryRoleOffered(bot.role, organizationIsOrg);
    const access = await Promise.all(
      repoList.map(async (repo) => ({
        repository: repo.fullName,
        inRepository: await this.seesRepository(bot.name, repo.fullName, client, wanted),
      })),
    );
    return { credential, kind, login, accountExists, connected, client, authorizationWorks, inRepository: inEvery(access), access };
  }

  async view(requestedEmail: string | null): Promise<OnboardingView> {
    const { live, webhook, crew, repoList, automation, organization, organizationIsOrg, lookupToken } = await this.setupFacts();
    // The page may not carry one — a reload, or a link from elsewhere — and the
    // stored address is what makes the suggestions survive that.
    const operatorEmail = requestedEmail || live.operatorEmail || null;
    const store = getSecretStore();

    /**
     * One bot at a time was costing the page most of its load.
     *
     * Each bot asks GitHub three things — whether its login is taken, whether it
     * can see the repository, and who it is — and nine bots in a `for` loop is
     * twenty-seven round trips end to end, which measured at 8.5s of a ten
     * second page. They do not depend on each other, so they no longer wait for
     * each other.
     *
     * `Promise.all` over `map` keeps the crew's order, which the page relies on.
     * Concurrent refreshes of one bot's token are safe: the broker collapses
     * them into a single refresh, which is what its first test is about.
     */
    const detailed: OnboardingBot[] = await Promise.all(
      crew.map(async (bot) => {
      const { credential, kind, login, accountExists, connected: stored, client, authorizationWorks, inRepository, access } = await this.standingOf(
        bot,
        repoList,
        organizationIsOrg,
        lookupToken,
      );
      // Suggested from the seat: a connected bot's name is already a handle,
      // and a suggestion built on it would be `fleetadlc-fleetadlc-atlas-janedoe`.
      const suggestion = suggestBotEmail(operatorEmail, bot.slot);

      return {
        accountExists,
        bot: bot.name,
        slot: bot.slot,
        displayName: bot.displayName,
        role: bot.role,
        roleLabel: roleLabel(bot.role),
        login,
        suggestedLogin: suggestedLogin(bot.slot),
        suggestedEmail: suggestion.email,
        emailNote: suggestion.note,
        repositoryRole: repositoryRoleOffered(bot.role, organizationIsOrg),
        accessReason: accessReasonFor(bot.role),
        connected: stored,
        authorizationWorks,
        credentialKind: kind,
        tokenExpiresAt: credential?.tokenExpiresAt ?? null,
        hasSigningKey: Boolean(await store.get(signingKeyRef(bot.name))),
        inRepository,
        access,
        profile: await this.profileOf(client),
      } satisfies OnboardingBot;
      }),
    );

    const connected = detailed.filter((bot) => bot.connected).length;
    // A seatless account has no credential row. The token broker is the only
    // thing that can say its sign-in still works; a stored kind alone counted
    // it as signed in, so two revoked accounts ticked this step.
    // A failed read leaves the list out rather than empty: the console takes
    // any list as the answer, and an empty one said "no account connected"
    // over a check that had passed.
    const held = await readAccounts(getSecretStore(), (account) => this.signsIn(account)).catch(() => null);
    const githubAccounts = held?.accounts.map((account) => ({
      login: account.login,
      signIn: account.signIn,
      group: groupOfAccount(account.seats),
      seats: account.seats.map((seat) => ({ name: seat.name })),
    }));
    const workingAccounts = (githubAccounts ?? []).filter((account) => account.signIn === 'signed-in').length;
    const inRepository = detailed.filter((bot) => bot.inRepository === true).length;
    const existing = detailed.filter((bot) => bot.accountExists === true).length;
    const missingAccounts = detailed.filter((bot) => bot.accountExists === false).length;
    const firstRepo = repoList[0]?.fullName ?? null;
    const appOwner = organizationIsOrg === true ? organization : null;

    // Labels are the board's columns, so an install without them has no board.
    const labelsWritten = Boolean(
      detailed.find((bot) => bot.bot === automation?.name)?.connected && repoList.length > 0,
    );

    const facts: WalkthroughFacts = {
      organization,
      organizationIsOrg,
      clientIdConfigured: live.clientIdConfigured,
      repositoryCount: repoList.length,
      crewCount: crew.length,
      existingAccounts: existing,
      connected,
      workingAccounts,
      inRepository,
      webhookReady: webhook.ready,
      webhookStale: webhook.stale,
    };
    const steps = walkthroughSteps(facts);

    // What the health checks prove moves a step's tick: a step whose check
    // fails is not done, whatever the page knew. `complete` stays what setting
    // up needs, so a check that fails on a running install — a permission a
    // new OpenADLC asks for — sends nobody from the board back to the walkthrough;
    // the board has the card for it.
    const checks = await this.stepChecks();
    const proved: Partial<Record<OnboardingStep, ManualStep>> = {
      app: 'app',
      install: 'install',
      'github-accounts': 'github-accounts',
      models: 'models',
      crew: 'crew',
      access: 'access',
      webhook: 'webhook',
    };
    const shown = steps.map((one) => {
      const verdict = proved[one.step] ? checks[proved[one.step]!].done : null;
      return verdict === null ? one : { ...one, done: verdict };
    });

    const complete = setupComplete({ ...facts, labelsWritten, missingAccounts });
    if (complete) this.completed = true;

    return {
      organization,
      organizationIsOrg,
      repositories: repoList.map((repo) => repo.fullName),
      clientIdConfigured: live.clientIdConfigured,
      webhookSecretConfigured: live.webhookSecretConfigured,
      webhookReady: webhook.ready,
      operatorEmail: operatorEmail ?? '',
      humans: live.humans,
      steps: shown,
      githubAccounts,
      bots: detailed,
      links: {
        signup: GITHUB_SIGNUP_URL,
        emailSettings: GITHUB_EMAIL_SETTINGS_URL,
        device: GITHUB_DEVICE_URL,
        // An organization app lives in the organization's settings; a personal
        // account's lives in the user's, and the other URL is a 404.
        newApp: newAppUrl(appOwner),
        // Where to find an app you already have; GitHub lists them here.
        yourApps: yourAppsUrl(appOwner),
        invite: inviteUrl(appOwner, firstRepo),
      },
      appSettings: REQUIRED_APP_SETTINGS,
      appPermissions: REQUIRED_APP_PERMISSIONS,
      webhookEvents: WEBHOOK_EVENTS,
      webhookUrl: `${live.publicUrl || 'https://your-bridge.example.com'}/webhooks/github`,
      complete,
      checks,
    };
  }

  /**
   * The bot a name means: its current name, or its seat — which is what the
   * console starts a connect under and keeps asking under, while the bot takes
   * its account's handle part-way through.
   */
  private async find(reference: string) {
    return resolveBotRef(await bots.listBots(), reference);
  }

  /**
   * Starts the device flow for one bot and returns the code a person types at
   * github.com/login/device. Polling happens here rather than in the browser, so
   * the refresh token never leaves the bridge.
   */
  async startAuthorization(reference: string, identity: string): Promise<PendingAuthorization> {
    const live = await effectiveConfig(this.config);
    if (!live.gitHubClientId) {
      throw new HttpFailure(400, 'no GitHub App client id is configured yet — finish the “Create the app” step first');
    }

    const bot = await this.find(reference);
    if (!bot) throw new HttpFailure(404, `unknown bot ${reference}`);

    const code = await requestDeviceCode({ clientId: live.gitHubClientId });
    const entry: PendingAuthorization = {
      botId: bot.id,
      bot: bot.name,
      // Only a guess at which account will approve, for the page to say: the
      // account that does approve is the one the bot becomes.
      login: bot.githubLogin ?? suggestedLogin(bot.slot),
      deviceCode: code.deviceCode,
      userCode: code.userCode,
      verificationUri: code.verificationUri,
      interval: code.interval,
      expiresAt: Date.now() + code.expiresIn * 1000,
      state: 'waiting',
      startedBy: identity,
    };
    this.pending.set(bot.id, entry);
    this.asked.set(reference, bot.id);
    this.asked.set(bot.name, bot.id);

    await audit({
      actor: identity,
      action: 'onboarding.device_code',
      target: bot.name,
      payload: { login: entry.login },
    });

    // Poll in the background so the browser can just ask how it went.
    void this.awaitApproval(entry).catch((error: unknown) => {
      entry.state = 'failed';
      entry.error = error instanceof Error ? error.message : String(error);
    });

    return entry;
  }

  private async awaitApproval(entry: PendingAuthorization): Promise<void> {
    const token = await pollForUserToken({
      clientId: (await effectiveConfig(this.config)).gitHubClientId,
      deviceCode: entry.deviceCode,
      intervalSeconds: entry.interval,
      expiresInSeconds: Math.max(1, Math.round((entry.expiresAt - Date.now()) / 1000)),
    });

    // Cancelled while GitHub was being asked, or started again over this one:
    // the person turned this sign-in down, so nothing of it is kept. It used
    // to be stored anyway, renaming the seat after an account they had just
    // said was the wrong one.
    if (this.pending.get(entry.botId) !== entry) return;
    await this.store(entry, token);
    entry.state = 'connected';
  }

  private async store(entry: PendingAuthorization, token: UserToken): Promise<void> {
    const outcome = await this.connect({ botId: entry.botId, token, actor: entry.startedBy, guess: entry.login });
    // What the console is told when it next asks: the account that approved,
    // not the one the page guessed, and the name the bot has now.
    entry.login = outcome.login;
    entry.bot = outcome.bot;
    if (outcome.warning) entry.warning = outcome.warning;
    this.asked.set(outcome.bot, entry.botId);
  }

  /**
   * Puts a seat on the GitHub account a fresh sign-in is for: the one way a
   * seat connects, from the console's device flow and from `fleetadlc auth
   * login`, which hands its token to the bridge for this. The CLI used to
   * connect on its own: it refused any account another seat held, so the
   * two-account crew the docs recommend could not be connected from it, and
   * it filed the sign-in under the seat's name, over a shared account's.
   *
   * Throws, storing nothing, for an account a seat of the other group holds.
   */
  async connect(input: { botId: string; token: UserToken; actor: string; guess?: string }): Promise<ConnectOutcome> {
    const { token } = input;
    const bot = await bots.getBotById(input.botId);
    if (!bot) throw new HttpFailure(404, `unknown bot ${input.botId}`);

    // Who authorized, asked before anything is stored. GitHub approves as
    // whichever account the browser is signed in to, and that account is the
    // one this bot becomes. If GitHub cannot say, nothing is stored: falling
    // back to the guessed login filed the token under an account anyone could
    // register, skipped the reviewer check and invited that account in.
    const client = new GitHubClient({ token: token.accessToken, actingAs: input.guess ?? bot.githubLogin ?? bot.name });
    const viewer = await client.viewer().catch(() => null);
    if (!viewer?.login) throw new HttpFailure(502, 'GitHub did not say which account approved the code, so nothing was stored. Connect again.');
    const login = viewer.login;

    // Never a person, nor an account that administers a managed repository:
    // the seat's tasks would run with that person's token. Refused here,
    // before anything is stored, so the seat keeps the sign-in it had.
    const guarded = await guardRefusal(login, this.guard, { elevated: true, then: 'enter a new code' });
    if (guarded) throw new HttpFailure(409, guarded);

    /**
     * Seats share an account only within their group: one the other group
     * holds is refused, one the seat's own group holds is joined. Only a
     * connection counts.
     *
     * Refused before the token is stored. It used to be stored first and
     * deleted on refusal, which also deleted whatever this bot held before —
     * so reconnecting a working bot while signed in as the wrong account
     * disconnected it.
     *
     * A row that merely names the account holds nothing for it, and is not a
     * reason to refuse: that is how an earlier install's config/bots.yaml had
     * the walkthrough turn down the one account an operator had for a bot,
     * because it was "set aside" for another bot nobody had connected. Its
     * login is let go instead, below.
     */
    const crew = await Promise.all(
      (await bots.listBots()).map(async (other) => ({
        ...other,
        connected: holdsCredential(await signInKind(other), await credentials.getCredential(other.id)),
      })),
    );
    const across = otherGroupHolder(login, bot, crew);
    if (across) throw new HttpFailure(409, otherGroupRefusal(login, bot, across));
    const holder = accountHolder(login, bot.id, crew);
    if (holder) {
      // Another seat is already signed in as this account, so this seat joins
      // it: one account for several seats is a crew on a shared account, not a
      // mistake. The newer sign-in replaces the account's, and every seat on it
      // uses it; the seat keeps its own name, key and computer.
      // Through `storeSignIn`, under the broker's lock: written straight to
      // the store, the broker went on serving the dead sign-in's cached token
      // to every seat on the account, and a refresh in flight could write the
      // old refresh token back over the new one. The seats already on it are
      // recorded as signed in again, as reconnecting the account does.
      const shared = await signInOf(holder);
      await this.storeSignIn(shared.ns, token);
      const onIt = await identities.botsOnSecretNs(shared.ns).catch(() => [] as string[]);
      for (const name of onIt.length > 0 ? onIt : [holder.name]) {
        const seat = await bots.getBotByName(name);
        if (!seat || seat.id === bot.id) continue;
        await credentials.recordAuthorization({
          botId: seat.id,
          githubLogin: login,
          githubUserId: viewer.id ?? null,
          secretRef: token.refreshToken ? refreshTokenRef(shared.ns) : accessTokenRef(shared.ns),
          scopes: token.scopes,
          tokenExpiresAt: token.expiresAt,
          refreshExpiresAt: token.refreshExpiresAt,
        });
      }
      await this.shareAccount({ from: holder.name, to: [bot.id], actor: input.actor });
      return { login, bot: (await bots.getBotById(bot.id))?.name ?? bot.name, joined: holder.name };
    }

    // An account OpenADLC holds that no seat is on — connected in
    // settings on its own, or left behind when its last seat moved. This seat
    // joins it, and the new sign-in replaces the account's where it is filed:
    // written under the seat's name instead, the account would hold two
    // sign-ins, and the one every other use asks for would be the old one.
    const held = await identities.identityByLogin(login);
    const was = await identities.identityOfBot(bot.id);
    const seatless = held ? !(await identities.seatIdentities()).some((row) => row.identityId === held.id) : false;
    if (held && seatless) {
      await this.storeSignIn(held.secretNs, token);
      await this.joinAccount({
        identity: { ...held, githubUserId: held.githubUserId ?? viewer.id ?? null },
        kind: token.refreshToken ? 'refresh' : 'static',
        credential: {
          githubUserId: viewer.id ?? held.githubUserId,
          scopes: token.scopes,
          tokenExpiresAt: token.expiresAt?.toISOString() ?? null,
          refreshExpiresAt: token.refreshExpiresAt?.toISOString() ?? null,
        },
        targets: [bot],
        actor: input.actor,
        from: null,
      });
      const joinedAs = (await bots.getBotById(bot.id))?.name ?? bot.name;
      await audit({
        actor: input.actor,
        action: 'onboarding.connected',
        target: joinedAs,
        payload: { login: held.login, slot: bot.slot, ...(was ? { from: was.login } : {}) },
      });
      return { login: held.login, bot: joinedAs };
    }

    // A seat connected as a different account leaves the one it was on first,
    // as an assignment does: its sign-in is about to be filed under this
    // seat's name, which may be where the old account's sign-in is. The old
    // account stays OpenADLC's, with nobody on it until a seat is put back.
    if (was && !sameLogin(was.login, login)) {
      await this.leaveAccount(bot, was);
      await audit({
        actor: input.actor,
        action: 'github.account_unassigned',
        target: bot.name,
        payload: { login: was.login, reason: `connected as ${login}` },
      });
    }

    const released = await bots.releaseLogin(login, bot.id);
    for (const name of released) {
      await audit({
        actor: input.actor,
        action: 'bot.login_released',
        target: name,
        payload: { login, reason: `${login} connected as the ${roleLabel(bot.role)}` },
      });
    }

    // Reconnecting the account it is on refreshes that account's sign-in
    // where it is filed — under the seat's name for an account it connected
    // itself, under the account's for one connected in settings first.
    const store = getSecretStore();
    const ns = held && was?.id === held.id ? held.secretNs : bot.name;
    await this.storeSignIn(ns, token);

    // The account that authorized is the account this bot is. Case-insensitive:
    // GitHub answers with the canonical casing, and a login stored in another
    // is the same account, not a new one.
    if (!sameLogin(login, bot.githubLogin)) await bots.setGithubLogin(bot.id, login);

    await credentials.recordAuthorization({
      botId: bot.id,
      githubLogin: login,
      githubUserId: viewer.id ?? null,
      secretRef: token.refreshToken ? refreshTokenRef(ns) : accessTokenRef(ns),
      scopes: token.scopes,
      tokenExpiresAt: token.expiresAt,
      refreshExpiresAt: token.refreshExpiresAt,
    });

    // And now it goes by that account's handle. A bot that is working keeps
    // its name until the work is done, and the bridge renames it then; the
    // connection stands either way.
    const renamed = await this.names?.rename({
      botId: bot.id,
      to: login,
      reason: `connected as ${login}`,
      actor: input.actor,
    });
    if (renamed && renamed.state !== 'renamed' && renamed.state !== 'unchanged') {
      console.warn(`[bridge] ${bot.name} connected as ${login} and keeps its name for now: ${renamed.reason ?? renamed.state}`);
    }
    const name = (await bots.getBotById(bot.id))?.name ?? bot.name;
    let warning: string | undefined;

    // Signed commits need the key on the account. Checked at every connect, not
    // only when the key is made: a refused first upload used to leave a stored
    // key GitHub never learned, and connecting again tried nothing.
    const signing = await ensureSigningKeyRegistered({ name, store, client });
    if (signing.state === 'refused') {
      warning = signing.warning;
      console.warn(`[bridge] ${signing.warning}`);
      await audit({
        actor: input.actor,
        action: 'signing_key.refused',
        target: name,
        payload: { reason: signing.warning },
      });
    } else {
      await credentials.setSigningKeyId(bot.id, signing.keyId);
    }

    await audit({
      actor: input.actor,
      action: 'onboarding.connected',
      target: name,
      payload: { login, slot: bot.slot, ...(name !== bot.name ? { renamedFrom: bot.name } : {}) },
    });

    await this.letIn(name, login, input.actor);
    // Its sign-in, its key and its access are what connecting just changed.
    this.health?.runSoon(['bot-sign-in', 'signing-key', 'bot-access', 'token-expiry']);
    return { login, bot: name, ...(warning ? { warning } : {}) };
  }

  /**
   * Puts seats on the GitHub account another seat is already signed in as —
   * all the others when `to` names none. What "Use this account for the whole
   * crew" does, and what connecting a second seat as the same account does.
   *
   * The seats are then put on it by `joinAccount`.
   */
  async shareAccount(input: { from: string; to?: string[]; actor: string }): Promise<{ login: string; shared: string[] }> {
    const crew = await bots.listBots();
    const source = crew.find((bot) => bot.name === input.from || bot.slot === input.from || bot.id === input.from);
    if (!source?.githubLogin) throw new HttpFailure(400, `${input.from} is not connected to a GitHub account`);
    const kind = await signInKind(source);
    if (!kind) throw new HttpFailure(400, `${source.name} holds no sign-in for ${source.githubLogin} to share`);

    let identity = await identities.identityOfBot(source.id);
    if (!identity) {
      await bots.setGithubLogin(source.id, source.githubLogin);
      identity = await identities.identityOfBot(source.id);
    }
    if (!identity) throw new HttpFailure(500, `${source.name}'s account could not be recorded`);

    const credential = await credentials.getCredential(source.id);
    const wanted = input.to && input.to.length > 0 ? new Set(input.to) : null;
    // Within its group only: the reviewers never sign in as the account the
    // builder opens pull requests as (see ACCOUNT_GROUPS).
    const group = accountGroupOf(source.role);
    const named = crew.filter(
      (bot) => bot.id !== source.id && (!wanted || wanted.has(bot.id) || wanted.has(bot.name) || wanted.has(bot.slot)),
    );
    const across = wanted ? named.find((bot) => accountGroupOf(bot.role) !== group) : undefined;
    if (across) throw new HttpFailure(400, otherGroupRefusal(source.githubLogin, across, source));
    const targets = named.filter((bot) => accountGroupOf(bot.role) === group);

    const shared = await this.joinAccount({ identity, kind, credential, targets, actor: input.actor, from: source.name });
    return { login: identity.login, shared };
  }

  /**
   * Puts seats on an account OpenADLC already holds a sign-in for: what sharing
   * an account and assigning one both come down to, so there is one way it is
   * done.
   *
   * Each seat is put on the account's identity and recorded as connected; the
   * account's sign-in is not copied, since every seat on it asks the token
   * broker for the same one. Then, per seat: it goes back to its seat's name
   * (seats sharing an account are not named after it), its own signing key is
   * put on the account, and it is let into every repository — once per
   * account, as GitHub invites accounts, not seats.
   *
   * A seat on another account leaves it first (`leaveAccount`), so that
   * account keeps its sign-in somewhere no seat's rename reaches, and stays
   * OpenADLC's with nobody on it.
   *
   * The caller has already decided the seats may use it; nothing here asks.
   */
  private async joinAccount(input: {
    identity: { id: string; login: string; githubUserId: number | null; secretNs: string };
    kind: 'refresh' | 'static';
    /** An authorization on the account, whose scopes and expiry the new seats' records copy. */
    credential: Pick<credentials.BotCredentialRecord, 'githubUserId' | 'scopes' | 'tokenExpiresAt' | 'refreshExpiresAt'> | null;
    targets: readonly { id: string; name: string }[];
    actor: string;
    /** The seat the account was shared from, for the audit line. */
    from: string | null;
  }): Promise<string[]> {
    const { identity, kind, credential } = input;
    for (const target of input.targets) {
      const was = await identities.identityOfBot(target.id);
      if (was && was.id !== identity.id) await this.leaveAccount(target, was);
      await bots.shareIdentity(target.id, identity.id);
      await credentials.recordAuthorization({
        botId: target.id,
        githubLogin: identity.login,
        githubUserId: credential?.githubUserId ?? identity.githubUserId,
        secretRef: kind === 'refresh' ? refreshTokenRef(identity.secretNs) : accessTokenRef(identity.secretNs),
        scopes: credential?.scopes ?? [],
        tokenExpiresAt: credential?.tokenExpiresAt ? new Date(credential.tokenExpiresAt) : null,
        refreshExpiresAt: credential?.refreshExpiresAt ? new Date(credential.refreshExpiresAt) : null,
      });
      await audit({
        actor: input.actor,
        action: 'bot.account_shared',
        target: target.name,
        payload: { login: identity.login, ...(input.from ? { with: input.from } : {}) },
      });
    }

    // Seats on a shared account go by their seats' names, the one it came
    // from included; see BotNames.wantedFor.
    await this.names?.reconcile(input.actor).catch(() => undefined);

    const store = getSecretStore();
    const shared: string[] = [];
    for (const target of input.targets) {
      const name = (await bots.getBotById(target.id))?.name ?? target.name;
      shared.push(name);
      const client = await this.actors.asBot(name);
      if (client) {
        const signing = await ensureSigningKeyRegistered({ name, store, client });
        if (signing.state !== 'refused') await credentials.setSigningKeyId(target.id, signing.keyId);
        else console.warn(`[bridge] ${signing.warning}`);
      }
      await this.letIn(name, identity.login, input.actor);
    }
    this.health?.runSoon(['bot-sign-in', 'signing-key', 'bot-access', 'token-expiry']);
    return shared;
  }

  /**
   * Puts one seat on a GitHub account OpenADLC holds — or, with `login: null`,
   * takes it off the one it is on. What each row of settings' crew does.
   *
   * The rules are enforced here whatever the page offered (`assignmentRefusal`):
   * a reviewer never shares an account with a crew seat, nor a crew seat with
   * a reviewer, because GitHub won't let the account that opened a pull
   * request approve it; and the account must be one OpenADLC can sign in as.
   *
   * A seat that was the last on its old account leaves that account behind,
   * still signed in: moving a bot is not disconnecting an account. It is
   * listed as used by no bot, any seat may be put back on it, and only
   * Disconnect forgets it.
   */
  async assignAccount(input: {
    bot: string;
    login: string | null;
    actor: string;
  }): Promise<{ bot: string; login: string | null }> {
    // With the probe the page uses: without it an account no seat is on read
    // as signed in whenever a token was stored, so one GitHub had revoked
    // could still be given a seat whose tasks would then fail.
    const { crew, accounts } = await readAccounts(getSecretStore(), (account) => this.signsIn(account));
    const seat = resolveBotRef(crew, input.bot);
    if (!seat) throw new HttpFailure(404, `unknown bot ${input.bot}`);
    const current = accounts.find((account) => account.id === seat.identityId) ?? null;
    const nameNow = async () => (await bots.getBotById(seat.id))?.name ?? seat.name;

    // Taking a busy seat off its account took its credential and its login
    // from the work in flight, so its next gate question, resume or review
    // failed. Refused as seat removal is; a seat on no account has nothing to
    // lose and is put on one at once.
    const busy = async () => {
      const refusal = await bots.seatWorkRefusal(seat.id, 'move it');
      if (refusal) throw refusal;
    };

    if (input.login === null) {
      if (!current) return { bot: seat.name, login: null };
      await busy();
      await this.leaveAccount(seat, current);
      await audit({
        actor: input.actor,
        action: 'github.account_unassigned',
        target: seat.name,
        payload: { login: current.login },
      });
      // Not connected, it goes back to its seat's name; the seat left behind
      // alone on the account takes the account's handle.
      await this.names?.reconcile(input.actor).catch(() => undefined);
      this.health?.runSoon(['bot-sign-in', 'signing-key', 'bot-access', 'token-expiry']);
      return { bot: await nameNow(), login: null };
    }

    const target = accounts.find((account) => sameLogin(account.login, input.login));
    if (!target) {
      throw new HttpFailure(
        400,
        `OpenADLC holds no sign-in for a GitHub account called ${input.login}. Connect it first: Settings → GitHub → Connected accounts → Connect a GitHub account.`,
      );
    }
    const people = await peopleOf(this.guard);
    const refusal = assignmentRefusal(seat, target, crew, people);
    if (refusal) throw new HttpFailure(400, `The ${roleLabel(seat.role)} can’t use ${target.login}: ${refusal}.`);
    if (current?.id === target.id) return { bot: seat.name, login: target.login };
    if (current) await busy();
    const elevated = await guardRefusal(target.login, this.guard, { elevated: true, then: 'choose it for the seat again', people });
    if (elevated) throw new HttpFailure(400, elevated);

    const kind = await credentialKind(target.secretNs, getSecretStore());
    if (!kind) throw new HttpFailure(400, `The ${roleLabel(seat.role)} can’t use ${target.login}: not signed in — reconnect it first.`);
    const credential =
      (await Promise.all(target.seats.map((other) => credentials.getCredential(other.id)))).find(Boolean) ?? null;

    await this.joinAccount({
      identity: { id: target.id, login: target.login, githubUserId: target.githubUserId, secretNs: target.secretNs },
      kind,
      credential,
      targets: [seat],
      actor: input.actor,
      from: null,
    });
    await audit({
      actor: input.actor,
      action: 'github.account_assigned',
      target: await nameNow(),
      payload: { login: target.login, from: current?.login ?? null },
    });
    return { bot: await nameNow(), login: target.login };
  }

  /**
   * Takes a seat off its account, leaving the account — and every other seat
   * on it — signed in.
   *
   * The account's sign-in may be filed under this very seat's name — the seat
   * that connected it first — and a seat's own name is what its next rename
   * carries its sign-in away under, and its next connect writes over. So
   * before it leaves, the sign-in is filed under the account's own name
   * (`accountSecretNs`), which no seat can be called. The last seat to leave
   * used to take the account with it, sign-in deleted; moving a bot is not
   * disconnecting an account, so now the account stays, used by no bot, until
   * it is disconnected on purpose.
   */
  private async leaveAccount(
    seat: { id: string; name: string },
    account: { id: string; login: string; secretNs: string },
  ): Promise<void> {
    if (account.secretNs === seat.name) {
      const store = getSecretStore();
      const refs = [refreshTokenRef, accessTokenRef];
      const from = account.secretNs;
      const to = accountSecretNs(account.login);
      await this.actors.exclusive([from, to], async () => {
        for (const ref of refs) {
          const value = await store.get(ref(from));
          if (value !== null) await store.set(ref(to), value);
          else await store.delete(ref(to));
        }
        await identities.moveSecretNs(
          account.id,
          to,
          refs.map((ref) => ({ from: ref(from), to: ref(to) })),
        );
        for (const ref of refs) await store.delete(ref(from));
      });
    }
    await bots.setGithubLogin(seat.id, null);
    await credentials.forgetAuthorization(seat.id);
  }

  /**
   * The accounts OpenADLC holds, the seats on each, and what each seat may be put
   * on: settings' connected accounts and the crew's account choices. An
   * account no seat is on is asked of the token broker, which is the only way
   * to know its sign-in still works.
   */
  async accounts(): Promise<GitHubAccountsView> {
    // Whether each seat signs in, as the health check last asked GitHub: what
    // settings' accounts card shows, rather than the status stored with the
    // credential, which nothing refreshes once the sign-in works again.
    const rows: HealthRow[] = this.health ? await this.health.rows().catch(() => []) : [];
    const signIn = new Map(rows.filter((row) => row.checkId === 'bot-sign-in' && row.subject).map((row) => [row.subject!, row]));
    const { crew, accounts } = await readAccounts(
      getSecretStore(),
      (account) => this.signsIn(account),
      (botId, authorizedAt) => provenSignIn(signIn.get(botId), authorizedAt),
    );
    // Named by seat in config/review.yaml, as the merge reads it: the lead and
    // any seat marked blocking, each under the name its bot goes by now.
    const reviewers = this.config.review ? reviewRulesOf(this.config.review).reviewers : [];
    const approving = new Set(
      reviewers.filter((entry) => entry.lead || entry.blocking).map((entry) => resolveBotRef(crew, entry.seat)?.name ?? entry.seat),
    );
    return accountsView(crew, accounts, approving, await this.peopleForChoices());
  }

  /**
   * The people no bot may sign in as, for Crew's account choices: read again
   * at most every few minutes, since the page asks every few seconds and each
   * read is a file per repository from GitHub. Refusing an account always
   * reads them afresh.
   */
  private async peopleForChoices(): Promise<readonly Person[]> {
    const kept = this.peopleKept;
    if (kept && Date.now() - kept.at < PEOPLE_KEPT_MS) return kept.people;
    const people = await peopleOf(this.guard).catch(() => [] as Person[]);
    this.peopleKept = { at: Date.now(), people };
    return people;
  }

  private peopleKept: { at: number; people: readonly Person[] } | null = null;

  /** Where the guard on which accounts a bot may be looks: the live settings, the repositories, the app. */
  private get guard(): AccountGuardDeps {
    return liveGuardDeps(this.config);
  }

  /**
   * Starts the device flow for an account on its own, for no seat: settings'
   * "Connect a GitHub account". Whichever account approves the code is the
   * one OpenADLC holds afterwards — a new one, or one it holds already, whose
   * sign-in this replaces. Putting a bot on it is the crew's business.
   */
  async startAccountConnect(actor: string): Promise<{ flowId: string; userCode: string; verificationUri: string; expiresInSeconds: number }> {
    const live = await effectiveConfig(this.config);
    if (!live.gitHubClientId) throw new HttpFailure(400, 'no GitHub App client id is configured yet — finish the “Create the app” step first');
    const code = await requestDeviceCode({ clientId: live.gitHubClientId });
    const flow: AccountFlow = {
      flowId: randomUUID(),
      deviceCode: code.deviceCode,
      userCode: code.userCode,
      verificationUri: code.verificationUri,
      interval: code.interval,
      expiresAt: Date.now() + code.expiresIn * 1000,
      state: 'waiting',
      startedBy: actor,
    };
    this.accountFlows.set(flow.flowId, flow);
    await audit({ actor, action: 'github.account_device_code', target: 'github-account', payload: {} });

    void (async () => {
      const token = await pollForUserToken({
        clientId: live.gitHubClientId,
        deviceCode: flow.deviceCode,
        intervalSeconds: flow.interval,
        expiresInSeconds: Math.max(1, Math.round((flow.expiresAt - Date.now()) / 1000)),
      });
      flow.login = await this.storeAccount(token, actor);
      flow.state = 'connected';
    })().catch((error: unknown) => {
      flow.state = 'failed';
      flow.error = error instanceof Error ? error.message : String(error);
    });

    return {
      flowId: flow.flowId,
      userCode: flow.userCode,
      verificationUri: flow.verificationUri,
      expiresInSeconds: Math.max(0, Math.round((flow.expiresAt - Date.now()) / 1000)),
    };
  }

  /** How an account's device flow went; `none` for one this bridge is not waiting on — it restarted, say. */
  accountConnectState(flowId: string): { state: AccountFlow['state'] | 'none'; login?: string; error?: string } {
    const flow = this.accountFlows.get(flowId);
    if (!flow) return { state: 'none' };
    if (flow.state !== 'waiting') this.accountFlows.delete(flowId);
    return { state: flow.state, ...(flow.login ? { login: flow.login } : {}), ...(flow.error ? { error: flow.error } : {}) };
  }

  /**
   * Files the sign-in of an account that approved a code in settings, and
   * says which account it was.
   *
   * One OpenADLC holds already has its sign-in replaced where it is filed, and
   * every seat on it is recorded as authorized again — reconnecting is how a
   * revoked account is mended. A new one is recorded as an account with no
   * seat, its sign-in filed under the account's own name.
   */
  private async storeAccount(token: UserToken, actor: string): Promise<string> {
    const client = new GitHubClient({ token: token.accessToken, actingAs: 'github-account' });
    const viewer = await client.viewer();
    if (!viewer?.login) throw new Error('GitHub did not say which account approved the code. Try again.');
    // A person's account is refused before anything is stored. Its admin
    // rights are asked where a seat is put on it: an account connected for no
    // seat may come before any repository.
    const guarded = await guardRefusal(viewer.login, this.guard, { elevated: false, then: 'connect it again' });
    if (guarded) throw new Error(guarded);

    const held = await identities.identityByLogin(viewer.login);
    const identity = held ?? { login: viewer.login, githubUserId: viewer.id ?? null, secretNs: accountSecretNs(viewer.login) };
    await this.storeSignIn(identity.secretNs, token);
    const recorded = await identities.recordIdentity({ ...identity, githubUserId: viewer.id ?? identity.githubUserId });

    const seats = (await identities.seatIdentities()).filter((row) => row.identityId === recorded.id);
    for (const row of seats) {
      await credentials.recordAuthorization({
        botId: row.botId,
        githubLogin: recorded.login,
        githubUserId: recorded.githubUserId,
        secretRef: token.refreshToken ? refreshTokenRef(recorded.secretNs) : accessTokenRef(recorded.secretNs),
        scopes: token.scopes,
        tokenExpiresAt: token.expiresAt,
        refreshExpiresAt: token.refreshExpiresAt,
      });
    }
    await audit({
      actor,
      action: held ? 'github.account_reconnected' : 'github.account_connected',
      target: recorded.login,
      payload: { seats: seats.length },
    });
    // Seatless or not: the accounts step is this list, and its check otherwise
    // waits ten minutes. A connect that already has seats still re-asks those.
    this.health?.runSoon(seats.length > 0 ? ['bot-sign-in', 'token-expiry', 'github-accounts'] : ['github-accounts']);
    return recorded.login;
  }

  /**
   * Forgets an account OpenADLC holds: its row and its sign-in. Refused while any
   * bot uses it — the page names them, and they move to another account in
   * the crew first — so disconnecting never takes an account out from under a
   * seat.
   */
  async disconnectAccount(input: { login: string; actor: string }): Promise<{ login: string }> {
    const { accounts } = await readAccounts();
    const account = accounts.find((one) => sameLogin(one.login, input.login));
    if (!account) throw new HttpFailure(404, `OpenADLC holds no GitHub account called ${input.login}.`);
    if (account.seats.length > 0) {
      const who = account.seats.map((seat) => `the ${roleLabel(seat.role)}`).join(', ');
      throw new HttpFailure(409, `${account.login} is used by ${who}. Put ${account.seats.length > 1 ? 'them' : 'it'} on another account under Crew first.`);
    }
    if (!(await identities.deleteUnusedIdentity(account.id))) {
      throw new HttpFailure(409, `A bot was put on ${account.login} just now; it was not disconnected.`);
    }
    const store = getSecretStore();
    await this.actors.exclusive([account.secretNs], async () => {
      for (const ref of [refreshTokenRef, accessTokenRef]) await store.delete(ref(account.secretNs));
    });
    this.refused.delete(account.secretNs);
    await audit({ actor: input.actor, action: 'github.account_disconnected', target: account.login, payload: {} });
    // The list just shrank. A verdict that is still true would keep the step
    // in the already-done row until the next ten-minute pass.
    this.health?.runSoon(['github-accounts']);
    return { login: account.login };
  }

  /**
   * Writes a sign-in where an account's is filed, replacing the kind it had:
   * a refresh token clears a stale static token, and a static token clears a
   * stale refresh token, which the broker would otherwise go on preferring.
   * Held against the broker, which could otherwise rotate the old refresh
   * token back over the new one.
   */
  private async storeSignIn(ns: string, token: UserToken): Promise<void> {
    const store = getSecretStore();
    this.refused.delete(ns);
    await this.actors.exclusive([ns], async () => {
      if (token.refreshToken) {
        await store.set(refreshTokenRef(ns), token.refreshToken);
        await store.delete(accessTokenRef(ns));
      } else {
        await store.set(accessTokenRef(ns), token.accessToken);
        await store.delete(refreshTokenRef(ns));
      }
    });
  }

  /**
   * Whether a seatless account still signs in, through the broker; a refusal
   * is remembered for `REFUSAL_REMEMBERED_MS`. See `refused`.
   *
   * Only GitHub refusing is remembered. A sign-in that failed because GitHub
   * could not be reached, or answered with an outage, still shows as not
   * working on this load, but the next load asks again: remembering it showed
   * one network blip as "needs reconnecting" for five minutes.
   */
  private async signsIn(account: { secretNs: string; login: string }): Promise<boolean | null> {
    if (typeof this.actors.signInState !== 'function') {
      return typeof this.actors.signsIn === 'function' ? this.actors.signsIn(account) : null;
    }
    const at = this.refused.get(account.secretNs);
    if (at !== undefined && Date.now() - at < REFUSAL_REMEMBERED_MS) return false;
    const state = await this.actors.signInState(account);
    if (state === 'refused') this.refused.set(account.secretNs, Date.now());
    else this.refused.delete(account.secretNs);
    return state === 'works' ? true : state === 'unknown' ? null : false;
  }

  /**
   * The account as GitHub describes it, asked with that bot's own credential.
   *
   * `email` is whatever the account has made public, which is often nothing:
   * reading a private address needs the `Email addresses` account permission,
   * and OpenADLC does not ask for one it would only use to decorate a panel. Absent
   * is reported as absent rather than filled in with a guess.
   */
  private async profileOf(client: GitHubClient | null): Promise<OnboardingBot['profile']> {
    if (!client) return null;

    return client
      .request<{ login?: string; name?: string | null; email?: string | null; avatar_url?: string; html_url?: string }>(
        'GET',
        '/user',
      )
      .then((user) =>
        user.login
          ? {
              login: user.login,
              name: user.name ?? null,
              email: user.email ?? null,
              avatarUrl: user.avatar_url ?? '',
              htmlUrl: user.html_url ?? `https://github.com/${user.login}`,
            }
          : null,
      )
      .catch(() => null);
  }

  /**
   * Whether a bot's own account can see the repository.
   *
   * A private repository answers `404` to an account that has not joined it, so
   * this is the difference between "connected" and "connected and able to work".
   * `null` when there is nothing to ask with or nothing to ask about.
   *
   * The bot's token answers it when there is one that works. Before a bot is
   * connected the app answers instead, and "before that" is most of onboarding
   * — but the fallback is for *absent* credentials only. It used to run for
   * failing ones too, which meant a bot whose authorization GitHub had revoked
   * was reported as in the repository on the app's say-so: a true answer to a
   * different question, printed where this one goes.
   */
  private async seesRepository(
    botName: string,
    repoFullName: string | undefined,
    client: GitHubClient | null,
    wanted: 'triage' | 'write' = 'write',
  ): Promise<boolean | null> {
    if (!repoFullName) return null;

    if (client) {
      return client
        .request<{ permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; triage?: boolean } }>(
          'GET',
          `/repos/${repoFullName}`,
        )
        .then((repo) => {
          // Seeing a public repository says nothing about working in it; the
          // permissions GitHub answers with, for this account, do.
          const can = repo?.permissions;
          if (!can) return true;
          return Boolean(can.admin || can.maintain || can.push || (wanted === 'triage' && can.triage));
        })
        // A private repository answers 404 to an account that has not joined
        // it. Anything else — a rate limit, an outage — says nothing about the
        // bot, and reading it as "not in" marked working bots as outside.
        .catch((error) => (error instanceof GitHubApiError && error.status === 404 ? false : null));
    }

    const bot = await bots.getBotByName(botName);
    if (!bot?.githubLogin) return null;
    // Only when nothing is stored. A stored credential that cannot act is a
    // fact about this bot, and hiding it behind the app's view is how the page
    // came to report nine working accounts over nine dead ones.
    const credential = await credentials.getCredential(bot.id);
    const stored = Boolean(await signInKind(bot)) || credential?.status === 'active';
    if (stored) return null;

    return this.appSeesCollaborator(repoFullName, bot.githubLogin);
  }

  /**
   * Whether the app can see this account as a collaborator.
   *
   * `GET /repos/{repo}/collaborators/{login}` answers 204 for a collaborator and
   * 404 for anybody else, which is exactly the question, and an installation
   * token can ask it without any bot being connected.
   */
  private async appSeesCollaborator(repoFullName: string, login: string): Promise<boolean | null> {
    const key = await getSecretStore().get(appPrivateKeyRef());
    if (!key) return null;

    try {
      const live = await effectiveConfig(this.config);
      const { token } = await installationTokenFor(
        APP_API,
        { clientId: live.gitHubClientId, privateKey: key },
        repoFullName,
      );
      const response = await fetch(
        `https://api.github.com/repos/${repoFullName}/collaborators/${encodeURIComponent(login)}`,
        { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}` } },
      );
      if (response.status === 204) return true;
      if (response.status === 404) return false;
      return null;
    } catch {
      return null;
    }
  }


  /**
   * Lets a bot that has just connected into the repository, then and there.
   *
   * It used to look for a waiting invitation with the bot's own token, and find
   * nothing: `GET /user/repository_invitations` answers `200 []` for an app
   * token however many are waiting. So the promise on the page — that a bot
   * accepts its invitation when it connects — quietly never happened, and
   * somebody had to go to a later step and press a button.
   *
   * The app knows the id because it creates the invitation, so it does both
   * halves here, for this one bot. Already a collaborator is a success with
   * nothing to do, which is what makes connecting twice harmless.
   *
   * The acceptance uses the bot's own credential, the one the device flow just
   * produced. Without `Administration` on the app, `PATCH
   * /user/repository_invitations/{id}` answers `403 Resource not accessible by
   * integration`, which reads as a limit of app tokens. It is not: GitHub names
   * the permission in `x-accepted-github-permissions`, and with it granted the
   * identical call returns 204.
   *
   * Nothing here can fail the connection. An invitation GitHub refuses, an app
   * without the permission — each leaves a connected bot, which is what the
   * operator asked for. Every outcome is audited, so a bot that still cannot
   * push has a recorded reason rather than being a mystery.
   */
  private async letIn(botName: string, login: string, actor: string): Promise<void> {
    // Every repository OpenADLC works in, not only the first: a bot that could
    // push to one and not another was a bot that failed there, later.
    for (const repo of await repos.listRepos().catch(() => [])) {
      let results: CrewAccess[];
      if (this.crewAccess) {
        const access = await this.crewAccess.ensure(repo.fullName, 'connected', { actor, onlyBot: botName });
        results = access.error ? [] : access.bots.filter((one) => one.bot === botName);
      } else if (this.invitations) {
        ({ results } = await this.invitations.inviteAndAccept(repo.fullName, botName).catch(() => ({ results: [] })));
      } else {
        return;
      }

      for (const result of results) {
        await audit({
          actor,
          action: `onboarding.access_${result.state}`,
          target: botName,
          // `result` carries the login it actually acted on, which is the one
          // that matters if the two ever disagree.
          payload: { repository: repo.fullName, connectedAs: login, ...result },
        });

        if (result.state === 'in' && result.changed) {
          console.log(`[bridge] ${botName} is in ${repo.fullName}`);
        } else if (result.state === 'refused') {
          console.warn(`[bridge] ${botName} could not be let into ${repo.fullName}: ${result.detail}`);
        }
      }
    }
  }


  /**
   * How a connect is going, asked under whatever name it was started under.
   *
   * The console starts one under the seat and keeps asking under the seat, and
   * the bot has taken its account's handle by the time the answer is in — so
   * the answer is found by the name it was asked under first, and only then by
   * what that name means now. `bot` in a finished answer is the name the bot
   * goes by from here on.
   */
  async authorizationState(reference: string): Promise<{
    state: PendingAuthorization['state'] | 'none';
    bot?: string;
    userCode?: string;
    verificationUri?: string;
    login?: string;
    error?: string;
    warning?: string;
    expiresInSeconds?: number;
  }> {
    const botId = this.asked.get(reference) ?? (await this.find(reference))?.id;
    const entry = botId ? this.pending.get(botId) : undefined;
    if (!entry) return { state: 'none' };

    if (entry.state === 'connected') {
      this.forget(entry.botId);
      return { state: 'connected', bot: entry.bot, login: entry.login, ...(entry.warning ? { warning: entry.warning } : {}) };
    }

    return {
      state: entry.state,
      bot: entry.bot,
      userCode: entry.userCode,
      verificationUri: entry.verificationUri,
      login: entry.login,
      ...(entry.error ? { error: entry.error } : {}),
      expiresInSeconds: Math.max(0, Math.round((entry.expiresAt - Date.now()) / 1000)),
    };
  }

  async cancel(reference: string): Promise<void> {
    const botId = this.asked.get(reference) ?? (await this.find(reference))?.id;
    if (botId) this.forget(botId);
  }

  private forget(botId: string): void {
    this.pending.delete(botId);
    for (const [name, id] of this.asked) if (id === botId) this.asked.delete(name);
  }
}

// Where the walkthrough's account rules live now; the CLI connects by them too.
export { accountHolder, holdsCredential };
