/**
 * Where OpenADLC's app is installed, and what a person does where it is not, as
 * the bridge says it (`apps/bridge/src/app-reach.ts`).
 *
 * The console does not depend on the bridge's packages, so the shapes are
 * written out here. The words are the bridge's: the card on the board, a
 * repository's line in settings and the field a repository is typed into all
 * show the same sentences, so none of them can say what the others do not.
 */

export type ReachNeed = 'unsuspend' | 'add-repository' | 'no-such-repository' | 'transfer' | 'make-public' | 'install' | 'allow-account';

/** A button that goes to where the thing is done: always a page on GitHub. */
export interface ReachAction {
  label: string;
  url: string;
}

export interface ReachStep {
  text: string;
  action: ReachAction;
}

export interface ReachFix {
  need: ReachNeed;
  title: string;
  detail: string;
  /** The one button: the first thing to do. */
  action: ReachAction;
  /** Everything to do, in order. */
  steps: ReachStep[];
}

export type Reach =
  | { state: 'reachable'; repository: string; account: string; installationId: number }
  | { state: 'unknown'; repository: string; reason: string }
  | ({ state: 'blocked'; repository: string; account: string } & ReachFix);

export type AccountType = 'User' | 'Organization';

export interface AppView {
  slug: string;
  name: string;
  owner: { login: string; type: AccountType };
  visibility: 'public' | 'private' | 'unknown';
  settingsUrl: string;
  advancedUrl: string;
  installUrl: string;
}

export interface AccountView {
  login: string;
  type: AccountType | null;
  /** GitHub's numeric id for the account; null when GitHub did not say. */
  id: number | null;
  /**
   * The app's page for this account: the installation's own when it is
   * installed there, else the install page straight past GitHub's account
   * picker — or the picker itself, when the account's id is not known.
   */
  installUrl: string;
  installation: { id: number; selection: 'all' | 'selected'; settingsUrl: string | null; suspended: boolean } | null;
  /** The names of the repositories OpenADLC works in under this account. */
  repositories: string[];
  /** What to do, for an account OpenADLC works in that the app is not installed on. */
  fix: ReachFix | null;
}

export interface InstallationsView {
  app: AppView | null;
  accounts: AccountView[];
  /** Why there is no app to show; empty when there is. */
  reason: string;
}

/** The account a repository belongs to: `exampleco` of `exampleco/infra`. */
export function ownerOf(fullName: string): string {
  return fullName.split('/')[0] ?? '';
}

/** Whether two logins are the same account: GitHub's are not case-sensitive. */
function sameLogin(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Where a repository the list does not have is got, and whether the app has to be made public first. */
export interface MoreRepositories {
  /** The account it is got on, when known: `choose` its installation's repositories, or `install` the app there. */
  account: string | null;
  kind: 'choose' | 'install';
  url: string;
  /** Any account's install page, GitHub's picker: offered beside `url` when another account can install the app. */
  elsewhere: string | null;
  /** The app is private to another account than `account`, so it has to be made public before it can go there. */
  makePublic: boolean;
}

/**
 * Where to send the person to give the app more repositories, for the field a
 * repository is chosen in.
 *
 * The account is the one the page is for when it knows it (the walkthrough's
 * first step); otherwise an account OpenADLC works in that the app is not
 * installed on yet; otherwise, for a private app, its owner, the only account
 * it can go on. When the app is already installed on that account, this is the
 * installation's settings page, where more repositories are chosen; when it is
 * not, it is that account's install page, skipping GitHub's account picker.
 * (This used to send everybody to the account picker, and to say a private app
 * is offered only to its owner, even when the app belonged to the organization
 * it was installed on, where there is nothing to make public.)
 */
export function moreRepositories(view: InstallationsView, account: string | null, fallback: string | null): MoreRepositories | null {
  const app = view.app;
  if (!app) return fallback ? { account: null, kind: 'install', url: fallback, elsewhere: null, makePublic: false } : null;
  const target =
    account ??
    view.accounts.find((one) => !one.installation && one.repositories.length > 0)?.login ??
    (app.visibility === 'private' ? app.owner.login : null);
  const elsewhere = app.visibility === 'private' ? null : app.installUrl;
  if (!target) return { account: null, kind: 'install', url: fallback ?? app.installUrl, elsewhere: null, makePublic: false };

  const known = view.accounts.find((one) => sameLogin(one.login, target));
  if (known?.installation) {
    return {
      account: known.login,
      kind: 'choose',
      url: known.installation.settingsUrl ?? known.installUrl,
      elsewhere,
      makePublic: false,
    };
  }
  return {
    account: known?.login ?? target,
    kind: 'install',
    // The walkthrough's link is for its account already, found before this view.
    url: (account ? fallback : null) ?? known?.installUrl ?? fallback ?? app.installUrl,
    elsewhere,
    makePublic: app.visibility === 'private' && !sameLogin(target, app.owner.login),
  };
}

/** "organization · all repositories", "personal · chosen repositories", "organization · not installed". */
export function accountLine(account: Pick<AccountView, 'type' | 'installation'>): string {
  const kind = account.type === 'Organization' ? 'organization' : account.type === 'User' ? 'personal' : null;
  const reach = !account.installation
    ? 'not installed'
    : account.installation.suspended
      ? 'suspended'
      : account.installation.selection === 'all'
        ? 'all repositories'
        : 'chosen repositories';
  return [kind, reach].filter(Boolean).join(' · ');
}

/** Who can install the app, in a sentence, from whether it is public. */
export function visibilityLine(app: Pick<AppView, 'visibility' | 'owner'>): string {
  switch (app.visibility) {
    case 'public':
      return 'Public: any account can install it. OpenADLC acts only where it works in a repository.';
    case 'private':
      return `Private: only ${app.owner.login} can install it.`;
    case 'unknown':
      return `GitHub did not say whether it is public. A private app installs only on ${app.owner.login}.`;
  }
}
