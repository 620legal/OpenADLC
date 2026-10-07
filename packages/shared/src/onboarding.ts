import type { BotRole } from './types.js';

/**
 * Setting OpenADLC up means creating two GitHub accounts, one the crew works
 * as and one the reviewers approve as, and approving each sign-in in a
 * browser. That is the only genuinely tedious part of the whole install: it
 * needs a person at a browser. This module holds what to create, what to paste
 * where, and what is already done.
 *
 * `ONBOARDING_STEPS` is the walkthrough the console shows and the bridge
 * reports. There is no second list: the terminal used to walk the same ground
 * (an `onboard` command, before the rename) and the two drifted. Setup is the console.
 *
 * The order is the order the steps depend on each other. GitHub plumbing comes
 * first and together — creating the app does not install it — then the accounts,
 * then who uses them, then anything that needs a role.
 */

export const ONBOARDING_STEPS = [
  'start',
  'owner',
  'app',
  'install',
  'webhook',
  'repository',
  'github-accounts',
  'models',
  'crew',
  'access',
  'protect',
  'done',
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const STEP_TITLES: Record<OnboardingStep, string> = {
  start: 'Start fresh or restore a backup',
  owner: 'GitHub owner',
  app: 'Create the app',
  install: 'Install the app',
  webhook: 'Webhook',
  repository: 'Repositories',
  'github-accounts': 'GitHub accounts',
  models: 'Foundation model accounts / API keys',
  crew: 'Crew',
  access: 'Repository access',
  protect: 'Protect the repositories',
  done: 'Ready',
};

/**
 * A step as a sentence names it: by the title the walkthrough shows. "The
 * accounts step" and "the app step" were names from before the steps were
 * renamed, and a person looking for them found neither.
 */
export function stepNamed(step: OnboardingStep): string {
  return `the “${STEP_TITLES[step]}” step`;
}

/**
 * What the progress row says. Shorter than the title, and the same words: a
 * person can tell from the row which step is left.
 */
export const STEP_SHORT: Record<OnboardingStep, string> = {
  start: 'Start',
  owner: 'Owner',
  app: 'App',
  install: 'Install',
  webhook: 'Webhook',
  repository: 'Repositories',
  'github-accounts': 'GitHub accounts',
  models: 'Model accounts',
  crew: 'Crew',
  access: 'Access',
  protect: 'Protection',
  done: 'Ready',
};

/** The line under a step's title: why this step is here. */
export const STEP_WHY: Record<OnboardingStep, string> = {
  start: 'A new install, or one brought back from a backup.',
  owner: 'The GitHub organization or account that owns the repositories, and where the bot accounts will live.',
  app: 'One app per install. Every bot authorizes through it, and OpenADLC acts as it to invite them to the repository, merge an approved change, run CI again and start deploy workflows. No bot can act as it.',
  install: 'The app has to be installed on the owner before it can reach a repository. Creating it does not install it.',
  webhook: 'GitHub has to be able to reach this bridge, or nothing starts.',
  repository: 'Where the bots are invited and where the work happens — one repository or several.',
  'github-accounts': 'The accounts the crew acts as on GitHub.',
  models: 'An API key or a subscription, checked before a bot can think with it.',
  crew: 'Which GitHub account and which model each seat uses.',
  access: 'Each account invited to the repositories, and the invitation accepted.',
  protect: 'Labels and rulesets, so a change cannot land without them.',
  done: 'What is set up, and where to file the first request.',
};

/**
 * Bookmarks and cards from before the steps were reordered. A link still opens
 * the step that does the same thing; the address is not a second list.
 */
export const ONBOARDING_STEP_ALIASES = {
  where: 'owner',
  email: 'github-accounts',
  accounts: 'models',
  assignment: 'crew',
  finish: 'protect',
} as const satisfies Record<string, OnboardingStep>;

/** The step a `?step=` name means: itself, or the step an old name now is. */
export function onboardingStepKey(named: string): OnboardingStep | null {
  if ((ONBOARDING_STEPS as readonly string[]).includes(named)) return named as OnboardingStep;
  const alias = (ONBOARDING_STEP_ALIASES as Record<string, OnboardingStep | undefined>)[named];
  return alias ?? null;
}

/**
 * What a bot does, in words.
 *
 * A bot's identity is its GitHub handle — that is what appears on a commit, a
 * review and a comment, and what somebody looks for when reading history. The
 * display name is a label for a role, so it is said as one: `fleetadlc-builder-janedoe`,
 * connected as the builder.
 *
 * The wording matches what `config/bots.yaml` puts in each display name — the
 * seat's label is the role's — so the two cannot drift into describing one
 * role two ways.
 */
export function roleLabel(role: BotRole): string {
  switch (role) {
    case 'intake':
      return 'intake';
    case 'spec':
      return 'system engineer';
    case 'implement':
      return 'builder';
    case 'review_lead':
      return 'lead reviewer';
    case 'review_second':
      return 'second reviewer';
    case 'review_security':
      return 'security reviewer';
    case 'deploy':
      return 'SRE';
    case 'qa':
      return 'QA';
    case 'automation':
      return 'automation';
  }
}

/**
 * A bot's repository role. Least privilege is the account's role, not a setting.
 *
 * Intake files and labels but never pushes; the automation account writes labels
 * and review requests and should not be able to push at all (the app sets the
 * `review-gate` status, which triage cannot). `triage` says exactly
 * that, and it is the one thing a repository owned by a person genuinely cannot
 * offer — GitHub answers `422` to a triage grant there, whatever the plan.
 *
 * So `ownerIsOrganization` is asked for rather than assumed. Telling somebody to
 * grant a role the form does not contain is worse than telling them the truth:
 * on a user-owned repository these two get `write`, and what keeps them from
 * pushing is OpenADLC's own gates rather than GitHub's.
 */
export function repositoryRoleFor(role: BotRole, ownerIsOrganization: boolean): 'triage' | 'write' {
  const wantsTriage = role === 'intake' || role === 'automation';
  return wantsTriage && ownerIsOrganization ? 'triage' : 'write';
}

/**
 * The role to tell a person to grant, from what is known of the owner: an
 * organization, a person, or — when GitHub could not be asked — nobody knows.
 * Only a known organization gets `triage`. The walkthrough took an unknown
 * owner for an organization, and told somebody to pick a role that a person's
 * repository's access page does not have.
 */
export function repositoryRoleOffered(role: BotRole, ownerIsOrganization: boolean | null | undefined): 'triage' | 'write' {
  return repositoryRoleFor(role, ownerIsOrganization === true);
}

/** Why this account needs the access it is being given, in one line. */
export function accessReasonFor(role: BotRole): string {
  switch (role) {
    case 'intake':
      return 'files and labels issues; triage is what stops it pushing code';
    case 'automation':
      return 'writes labels, assignments and review requests, and must never push';
    case 'review_lead':
      return 'GitHub only counts an approving review from an account with write access';
    case 'review_second':
    case 'review_security':
      return 'reviews count only with write access';
    case 'implement':
      return 'branches, pushes and opens pull requests in the repositories it owns';
    case 'spec':
      return 'writes design comments, and opens pull requests that add ADRs under docs/adr/';
    case 'deploy':
      return 'reverts, runs deploy workflows and opens incident issues';
    case 'qa':
      return 'maintains the test suites it owns';
    default:
      return 'takes part in the pipeline';
  }
}

/**
 * Whether a bot is connected: it holds a GitHub credential. The same test the
 * walkthrough's "connected so far" uses, so the two can never disagree about
 * who is connected.
 */
export function holdsCredential(
  kind: 'refresh' | 'static' | null,
  credential: { status?: string } | null,
): boolean {
  return Boolean(kind) || credential?.status === 'active';
}

/**
 * Which other bot is already connected as this account.
 *
 * Seats share an account only within their group (`ACCOUNT_GROUPS`): a seat
 * signing in as an account its group already holds joins it, and one the
 * other group holds is refused (`otherGroupHolder`), since a reviewer on the
 * crew account would be approving its own work.
 *
 * Only a connection counts. A row that merely names the account — left by an
 * earlier install, or by a `config/bots.yaml` that used to suggest one — holds
 * nothing, and refusing a real account because of it is what stopped a bot
 * connecting as the one account its operator had for it: "set aside for
 * sydney, who is not connected yet". Such a row's login is stale, and the
 * caller clears it.
 */
export function accountHolder<T extends { id: string; name: string; role: BotRole; githubLogin: string | null; connected: boolean }>(
  login: string,
  botId: string,
  crew: readonly T[],
): T | null {
  const wanted = login.toLowerCase();
  return (
    crew.find(
      (other) => other.id !== botId && other.connected && (other.githubLogin ?? '').toLowerCase() === wanted,
    ) ?? null
  );
}

/**
 * The two accounts a crew needs at the least.
 *
 * GitHub will not let an account approve a pull request it opened, so the
 * reviewers cannot sign in as the account the builder opens pull requests as.
 * Everything else can: the crew account does the work, the reviewer account
 * approves it, and a real approval keeps CODEOWNERS and rulesets doing what
 * they do. Seats share an account only within their group.
 */
export type AccountGroup = 'crew' | 'reviewers';

export const ACCOUNT_GROUPS: readonly { group: AccountGroup; label: string; blurb: string }[] = [
  { group: 'crew', label: 'Crew account', blurb: 'Intake, design, build, QA, ship and automation post and push as this account.' },
  {
    group: 'reviewers',
    label: 'Reviewer account',
    blurb: 'The three reviewers approve as this account. GitHub won’t let the account that opened a pull request approve it, so it has to be a different one.',
  },
];

export function accountGroupOf(role: BotRole): AccountGroup {
  return role === 'review_lead' || role === 'review_second' || role === 'review_security' ? 'reviewers' : 'crew';
}

/** A connected seat in the other group already signed in as `login`, which this seat may not share. */
export function otherGroupHolder<T extends { id: string; role: BotRole; githubLogin: string | null; connected: boolean }>(
  login: string,
  bot: { id: string; role: BotRole },
  crew: readonly T[],
): T | null {
  const wanted = login.toLowerCase();
  const group = accountGroupOf(bot.role);
  return (
    crew.find(
      (other) =>
        other.id !== bot.id &&
        other.connected &&
        (other.githubLogin ?? '').toLowerCase() === wanted &&
        accountGroupOf(other.role) !== group,
    ) ?? null
  );
}

export function otherGroupRefusal(login: string, bot: { role: BotRole }, holder: { role: BotRole }): string {
  const reviewer = accountGroupOf(bot.role) === 'reviewers';
  return (
    `${login} is the ${reviewer ? 'crew' : 'reviewer'} account (the ${roleLabel(holder.role)} signs in as it). ` +
    `The reviewers need an account of their own — GitHub won’t let the account that opened a pull request approve it. ` +
    `Connect the ${roleLabel(bot.role)} with ${reviewer ? 'the reviewer account' : 'the crew account'}. If the browser you ` +
    `approved in is still signed in to GitHub as ${login}, sign out of it or use a private window, then connect again.`
  );
}

/**
 * The name to suggest for a bot's account when nobody has connected one: its
 * seat, prefixed. Only ever a suggestion. Which account a bot is, is decided
 * by the account that authorizes.
 */
export function suggestedLogin(bot: string, prefix = 'fleetadlc'): string {
  return `${prefix}-${bot}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

/**
 * Names to try for a bot's account, best first.
 *
 * The bare `fleetadlc-<bot>` name of one seat was taken — by a stranger,
 * registered years earlier — and the install went out with a bot pointed at
 * somebody else's account until the creation dates gave it away. A global
 * namespace of nine obvious names was always going to collide; what made it
 * dangerous was that nothing checked.
 *
 * So the owner's identifier goes in the name by default. `fleetadlc-builder-janedoe`
 * is nobody else's, reads as belonging to this install, and still says which bot
 * it is. The bare `fleetadlc-builder` is offered last rather than first: it is the one
 * most likely to be taken, and taken by someone unrelated.
 *
 * GitHub allows alphanumerics and single hyphens, cannot start or end with one,
 * and caps at 39 characters — so a long owner name truncates rather than
 * producing something GitHub will reject at the end of a sign-up form.
 */
export function loginCandidates(bot: string, owner: string | null): string[] {
  const clean = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 39)
      .replace(/-$/, '');

  const tail = owner ? clean(owner) : '';
  const candidates = tail
    ? [clean(`fleetadlc-${bot}-${tail}`), clean(`${tail}-fleetadlc-${bot}`), clean(`fleetadlc-${bot}`)]
    : [clean(`fleetadlc-${bot}`)];

  return [...new Set(candidates)].filter(Boolean);
}

/**
 * GitHub needs a unique address per account. Gmail and most modern providers
 * deliver `you+anything@` to the same inbox, so one mailbox can hold the whole
 * crew — which is the difference between a ten-minute job and an afternoon of
 * creating mailboxes.
 */
const PLUS_ADDRESSING = [
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'icloud.com',
  'me.com',
  'fastmail.com',
  'proton.me',
  'protonmail.com',
  'yahoo.com',
  'zoho.com',
];

export interface EmailSuggestion {
  email: string | null;
  /** True when the address is a tag on the operator's own mailbox. */
  plusAddressed: boolean;
  note: string;
}

export function suggestBotEmail(operatorEmail: string | null | undefined, bot: string): EmailSuggestion {
  const trimmed = (operatorEmail ?? '').trim().toLowerCase();
  const match = /^([^@+\s]+)(\+[^@\s]*)?@([^@\s]+)$/.exec(trimmed);

  if (!match) {
    return {
      email: null,
      plusAddressed: false,
      note: 'give your own email address and OpenADLC will suggest one per bot',
    };
  }

  const [, local = '', , domain = ''] = match;
  const tagged = `${local}+fleetadlc-${bot}@${domain}`;

  if (PLUS_ADDRESSING.includes(domain)) {
    return {
      email: tagged,
      plusAddressed: true,
      note: `${domain} delivers this to your own inbox, so every bot's mail arrives in one place`,
    };
  }

  return {
    email: tagged,
    plusAddressed: false,
    note: `check that ${domain} delivers plus-addressed mail; if it does not, use a separate address per bot`,
  };
}

export const GITHUB_SIGNUP_URL = 'https://github.com/signup';
/**
 * Where an account keeps its email address private. GitHub writes the crew's
 * squash merges with the account's default commit email, which the suggested
 * plus-tagged address would otherwise publish.
 */
export const GITHUB_EMAIL_SETTINGS_URL = 'https://github.com/settings/emails';
export const GITHUB_DEVICE_URL = 'https://github.com/login/device';
export const GITHUB_NEW_APP_PATH = '/settings/apps/new';

/** Where to create the app: an organization's settings, or a personal account's. */
export function newAppUrl(organization: string | null): string {
  return organization
    ? `https://github.com/organizations/${organization}/settings/apps/new`
    : `https://github.com${GITHUB_NEW_APP_PATH}`;
}

/**
 * Where an account's existing apps are listed.
 *
 * GitHub has no API for this — an app cannot enumerate the apps an account
 * owns — but it does have a page, and that page is where both values OpenADLC
 * needs live: the client id is on it, and "Generate a private key" is the
 * button beside it. So the answer to "I think I already have one" is a link
 * rather than a search OpenADLC cannot perform.
 */
export function yourAppsUrl(organization: string | null): string {
  return organization
    ? `https://github.com/organizations/${organization}/settings/apps`
    : 'https://github.com/settings/apps';
}

/**
 * One app's own settings page: where Device Flow, token expiry and the
 * webhook's **Active** switch are, none of which any API can set.
 *
 * An app an organization owns is under the organization's settings; the
 * personal address 404s for it, which is the page a link to the one switch
 * that matters must never land on.
 */
export function appSettingsUrl(slug: string, organization: string | null): string {
  return organization
    ? `https://github.com/organizations/${organization}/settings/apps/${slug}`
    : `https://github.com/settings/apps/${slug}`;
}

/**
 * The app's Advanced page, whose Danger zone has **Make public**: the one way
 * to let an account other than the app's owner install it. GitHub installs a
 * private app only on the account that owns it, and no API can change that.
 */
export function appAdvancedUrl(slug: string, organization: string | null): string {
  return `${appSettingsUrl(slug, organization)}/advanced`;
}

/**
 * Where an account installs the app: GitHub's own page, which asks which
 * account and which of its repositories. A private app's page offers only its owner.
 * Given the account's numeric id, it goes past that picker straight to the
 * account's repositories — the plain page first asks which signed-in user to
 * act as, which reads as a sign-in and not an install.
 */
export function appInstallUrl(slug: string, targetId?: number | null): string {
  const plain = `https://github.com/apps/${slug}/installations/new`;
  return targetId ? `${plain}/permissions?target_id=${targetId}` : plain;
}

/** The app's "Permissions & events" page, where a permission it lacks is added. */
export function appPermissionsUrl(slug: string, organization: string | null): string {
  return `${appSettingsUrl(slug, organization)}/permissions`;
}

/**
 * One installation of the app: where the account that installed it chooses
 * its repositories and accepts permissions the app has asked for since.
 */
export function installationSettingsUrl(installationId: number, organization: string | null): string {
  return organization
    ? `https://github.com/organizations/${organization}/settings/installations/${installationId}`
    : `https://github.com/settings/installations/${installationId}`;
}

/**
 * The roles whose work ends in a commit: the builder writes the change, the
 * system engineer commits ADRs under `docs/adr/`, QA maintains its suites and
 * the SRE reverts. Each signs its commits with its own key, so each
 * needs that key on its GitHub account — a reviewer, intake and the automation
 * account never commit, and a key of theirs proves nothing.
 */
export const COMMITTING_ROLES: readonly BotRole[] = ['implement', 'spec', 'deploy', 'qa'];

/**
 * The walkthrough's steps that need a person, because OpenADLC cannot do them
 * for itself — and what the person does on each.
 *
 * The keys are the console walkthrough's (`?step=app`). A step here must come
 * with a check in the bridge's health registry that proves it was done by its
 * effect, not by a setting somebody ticked: the check then keeps proving it,
 * turns into a card on the board when it stops being true, and is what marks
 * the step done. `apps/bridge/src/health/registry.test.ts` fails for a step
 * listed here that no check answers, and AGENTS.md says why.
 *
 * Creating the app and installing it are different things a person does on
 * GitHub, so they are different steps. Device Flow and token expiry stay on
 * creating it: the manifest cannot set either.
 */
export const MANUAL_STEPS = {
  app: 'create the GitHub App from its manifest, and tick Device Flow and token expiry, which no manifest or API can set',
  install: 'install the app on the owner — making it public first when that account is not the app’s own — which creating the app does not do',
  'github-accounts': 'connect two GitHub accounts, one that does the work and one that approves it, and approve each sign-in in a browser',
  // Connecting an account does not put a seat on it, and does not register a
  // committing bot's key. Those are what `bot-sign-in` and `signing-key` prove,
  // and they are this step: before they were tagged here, a failing key marked
  // nothing and Crew could tick with no seat on an account.
  crew: 'put each seat on a GitHub account, which registers a committing bot’s signing key on that account',
  access: 'let each account into the repository, when an invitation cannot be accepted for it',
  models: 'paste a model key or sign a subscription in, for the accounts the crew thinks with',
  webhook: 'switch the app’s webhook on under Active, which no API can reach',
} as const;

export type ManualStep = keyof typeof MANUAL_STEPS;

export function inviteUrl(organization: string | null, repoFullName: string | null): string | null {
  if (organization) return `https://github.com/orgs/${organization}/people`;
  if (repoFullName) return `https://github.com/${repoFullName}/settings/access`;
  return null;
}

/** The app settings that are not optional, with the reason each one matters. */
export const REQUIRED_APP_SETTINGS = [
  {
    setting: 'Enable Device Flow',
    value: 'checked',
    why: 'this is how a bot authorizes its own account; without it OpenADLC cannot connect anything',
  },
  {
    setting: 'Expire user authorization tokens',
    value: 'checked',
    why: 'makes user tokens last 8 hours; OpenADLC stores only the refresh token (six months, rotated on every use) in the secret store, and mints a short-lived token for each task',
  },
  {
    setting: 'Callback URL',
    value: 'leave empty',
    why: 'the device flow needs no redirect',
  },
  {
    setting: 'Client secret',
    value: 'do not create one',
    why: 'refreshing a device-flow token needs only the client id',
  },
] as const;

export const REQUIRED_APP_PERMISSIONS = [
  { scope: 'Repository', permission: 'Contents', access: 'Read and write', why: 'clone, branch and push' },
  {
    scope: 'Repository',
    permission: 'Administration',
    access: 'Read and write',
    // Without it `PATCH /user/repository_invitations/{id}` answers `403
    // Resource not accessible by integration`, which reads as a limit of app
    // tokens and is not one — GitHub names this permission in
    // `x-accepted-github-permissions`. With it the same call returns 204.
    why: 'so each bot can accept its own repository invitation instead of a person signing in as it',
  },
  { scope: 'Repository', permission: 'Issues', access: 'Read and write', why: 'comments, labels, assignees' },
  {
    scope: 'Repository',
    permission: 'Pull requests',
    access: 'Read and write',
    why: 'open pull requests, request reviewers, post reviews',
  },
  {
    scope: 'Repository',
    permission: 'Commit statuses',
    access: 'Read and write',
    why: 'the review-gate status that holds a pull request',
  },
  {
    scope: 'Repository',
    permission: 'Checks',
    access: 'Read and write',
    why: 'review-gate as the app’s own check, which no bot’s token can set',
  },
  {
    scope: 'Repository',
    permission: 'Workflows',
    access: 'Read and write',
    why: 'bots that change files under .github/workflows',
  },
  {
    scope: 'Repository',
    permission: 'Actions',
    access: 'Read and write',
    why: 'running a failed CI’s jobs again, once, so a flaky test does not cost a review round',
  },
  {
    scope: 'Repository',
    permission: 'Deployments',
    access: 'Read-only',
    why: 'hearing when a change reaches testing or production, which labels it deployed and moves a promoted card to Done',
  },
  { scope: 'Repository', permission: 'Metadata', access: 'Read-only', why: 'mandatory' },
  {
    scope: 'Account',
    permission: 'SSH signing keys',
    access: 'Read and write',
    why: 'so each bot registers the key its commits are signed with; without it every commit reads Unverified',
  },
] as const;

/**
 * The events the bridge acts on. Anything else is noise.
 *
 * `deployment_status` is what labels a change `deployed:testing` and moves a
 * promoted card to Done (`onDeploymentStatus` in the bridge). The bridge
 * handled it long before the app asked for it, so an app made from an older
 * manifest never sends it; the `app-permissions` check says what to tick. Not
 * `deployment`: a deployment being created is not one that worked, and the
 * bridge ignores it.
 */
export const WEBHOOK_EVENTS = [
  'issues',
  'issue_comment',
  'pull_request',
  'pull_request_review',
  'workflow_run',
  'deployment_status',
] as const;

/**
 * Each event as the app's "Permissions & events" page names it under
 * "Subscribe to events", so a person told to tick one can find it. Every entry
 * of `WEBHOOK_EVENTS` needs one; `onboarding.test.ts` holds that.
 */
export const WEBHOOK_EVENT_NAMES: Record<(typeof WEBHOOK_EVENTS)[number], string> = {
  issues: 'Issues',
  issue_comment: 'Issue comment',
  pull_request: 'Pull request',
  pull_request_review: 'Pull request review',
  workflow_run: 'Workflow run',
  deployment_status: 'Deployment status',
};
