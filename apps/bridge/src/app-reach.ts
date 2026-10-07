import { appInstallations, appJwt, type AppApi, type AppCredentials, type AppInstallation } from '@fleetadlc/github';
import { appAdvancedUrl, appInstallUrl, appSettingsUrl, installationSettingsUrl, sameLogin } from '@fleetadlc/shared';
import { statusOf } from './health/checks/app.js';
import { HttpFailure, type Router } from './router.js';

/**
 * Whether OpenADLC's app can reach a repository, and when it cannot, the one
 * thing a person does about it.
 *
 * Settings added any `owner/name` it was given. For `exampleco/infra`, on an
 * install whose app lived on the personal account `janedoe`, the add worked,
 * letting the crew in then failed with GitHub's JSON —
 * `/repos/exampleco/infra/installation → 404` — and the card on the board said
 * to install the app and choose the repository, which GitHub does not allow:
 * the walkthrough creates the app private, and a private app installs only on
 * the account that owns it. Nothing said so, and "Try again" could never work.
 *
 * GitHub answers that 404 alike for an account that never installed the app,
 * one that gave it other repositories, and a repository that does not exist,
 * and each of those is a different thing to do on a different page. This
 * tells them apart once, for every place that has to say it — the card, the
 * repository's line in settings, the field a repository is typed into — so
 * they cannot disagree.
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

/** What to do about an account or a repository the app cannot reach, in words. */
export interface ReachFix {
  need: ReachNeed;
  title: string;
  detail: string;
  /** The one button: the first thing to do. */
  action: ReachAction;
  /** Everything to do, in order, for a page with room to list it. */
  steps: ReachStep[];
}

export type Reach =
  | { state: 'reachable'; repository: string; account: string; installationId: number }
  /** No answer — no key yet, or GitHub not answering. Never a reason to refuse anything. */
  | { state: 'unknown'; repository: string; reason: string }
  | ({ state: 'blocked'; repository: string; account: string } & ReachFix);

export type AccountType = 'User' | 'Organization';

/** The app as settings shows it: whose it is, and who can install it. */
export interface AppView {
  slug: string;
  name: string;
  owner: { login: string; type: AccountType };
  visibility: 'public' | 'private' | 'unknown';
  settingsUrl: string;
  advancedUrl: string;
  installUrl: string;
}

/** One account: the app's installation there, if any, and the repositories OpenADLC works in there. */
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
  installation: Pick<AppInstallation, 'id' | 'selection' | 'settingsUrl' | 'suspended'> | null;
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

export interface AppReachDeps {
  /** What acting as the app needs, or null when OpenADLC does not hold its key. */
  credentials(): Promise<AppCredentials | null>;
  api: AppApi;
  /** Whether an account other than the app's owner can install it; see `appVisibility`. */
  visibility(slug: string): Promise<'public' | 'private' | 'unknown'>;
  /** Whether a login is a person or an organization; null when GitHub does not say. */
  accountType(login: string): Promise<AccountType | null>;
  /** An account's numeric id, which the install page takes to skip its account picker; null when GitHub does not say. */
  accountId?(login: string): Promise<number | null>;
  /** The repositories OpenADLC works in. */
  repositories(): Promise<{ fullName: string }[]>;
  /** The organization the install is for, from its settings; empty or null when it names none. */
  organization?(): Promise<string | null>;
  /** The accounts an admin allowed beyond those, lower-cased (`allowedAccounts` in the settings). */
  allowedAccounts?(): Promise<string[]>;
  now?: () => number;
}

interface AppFacts {
  slug: string;
  name: string;
  owner: { login: string; type: AccountType };
}

interface FoundInstallation {
  id: number;
  account: string;
  suspended: boolean;
  settingsUrl: string | null;
}

/**
 * How long an answer is kept. A page waiting on an installation asks every few
 * seconds and must not ask GitHub every time; an installation webhook clears
 * them all. The visibility is asked without a credential, whose budget is
 * sixty an hour, so it is kept for a minute; what an account is barely changes.
 */
const FRESH_MS = 15_000;
const VISIBILITY_MS = 60_000;
const ACCOUNT_TYPE_MS = 10 * 60_000;

export class AppReach {
  private readonly held = new Map<string, { at: number; value: Promise<unknown> }>();
  private readonly now: () => number;

  constructor(private readonly deps: AppReachDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Forgets every answer: GitHub said an installation changed. */
  clear(): void {
    this.held.clear();
  }

  async reach(fullName: string): Promise<Reach> {
    const [account = '', name = ''] = fullName.split('/');
    // Never throws: adding a repository asks this first, and a secret store or
    // a GitHub that does not answer must not be why a repository cannot be added.
    try {
      const credentials = await this.deps.credentials();
      if (!credentials) {
        return {
          state: 'unknown',
          repository: fullName,
          reason: 'OpenADLC does not hold the app’s private key, so it cannot ask GitHub where the app is installed',
        };
      }
      // A public app can be installed by anyone, on their own repositories,
      // and a look-alike of a repository the crew works in could then be
      // picked and added: the crew invited in, and the stranger, as its
      // admin, answering the crew's questions. Only an account the install
      // works in is reached; another is an admin's to allow, first.
      if (!(await this.accountsWorkedIn(credentials)).has(account.toLowerCase())) {
        return { state: 'blocked', repository: fullName, account, ...allowFix(account) };
      }
      const found = await this.installationOn(credentials, fullName);
      if (found && !found.suspended) {
        return { state: 'reachable', repository: fullName, account: found.account, installationId: found.id };
      }

      const installations = await this.installations(credentials);
      const onAccount = installations.find((one) => sameLogin(one.account.login, account));
      const blocked = (fix: ReachFix): Reach => ({ state: 'blocked', repository: fullName, account, ...fix });

      if (found?.suspended || onAccount?.suspended) {
        const url = found?.settingsUrl ?? onAccount?.settingsUrl ?? appInstallUrl((await this.app(credentials)).slug);
        return blocked(suspendedFix(account, onAccount?.account.type ?? null, url));
      }
      if (onAccount?.selection === 'selected') {
        return blocked(chooseFix(account, name, onAccount.settingsUrl ?? appInstallUrl((await this.app(credentials)).slug)));
      }
      if (onAccount) return blocked(missingFix(account, name));

      const app = await this.app(credentials);
      const [type, id] = await Promise.all([this.accountType(account), this.accountId(account)]);
      return blocked(await this.notInstalledFix(app, installations, { login: account, type, id }, [name]));
    } catch (error) {
      return { state: 'unknown', repository: fullName, reason: `OpenADLC could not ask where the app is installed: ${messageOf(error)}` };
    }
  }

  /**
   * The accounts the install works in, lower-cased: the app's owner, the
   * configured organization, the owners of the repositories it works in, and
   * any an admin allowed. An installation anywhere else is ignored.
   */
  async accountsWorkedIn(credentials?: AppCredentials | null): Promise<Set<string>> {
    const known = new Set<string>();
    const add = (login: string | null | undefined) => {
      if (login?.trim()) known.add(login.trim().toLowerCase());
    };
    const held = credentials === undefined ? await this.deps.credentials().catch(() => null) : credentials;
    if (held) add((await this.app(held).catch(() => null))?.owner.login);
    const [managed, organization, allowed] = await Promise.all([
      this.deps.repositories(),
      this.deps.organization ? this.deps.organization().catch(() => null) : Promise.resolve(null),
      this.deps.allowedAccounts ? this.deps.allowedAccounts().catch(() => [] as string[]) : Promise.resolve([] as string[]),
    ]);
    for (const repo of managed) add(repo.fullName.split('/')[0]);
    add(organization);
    for (const login of allowed) add(login);
    return known;
  }

  /** The app, every account it is installed on, and every account OpenADLC works in. */
  async installationsView(): Promise<InstallationsView> {
    try {
      const credentials = await this.deps.credentials();
      if (!credentials) return { app: null, accounts: [], reason: 'OpenADLC does not hold the app’s private key yet, so it cannot ask GitHub about the app' };
      const [app, installations, managed] = await Promise.all([
        this.app(credentials),
        this.installations(credentials),
        this.deps.repositories(),
      ]);
      const visibility = await this.visibilityOf(app, installations);

      const accounts = new Map<string, AccountView>();
      for (const installation of installations) {
        const organization = installation.account.type === 'Organization' ? installation.account.login : null;
        accounts.set(installation.account.login.toLowerCase(), {
          login: installation.account.login,
          type: installation.account.type,
          id: installation.account.id,
          installUrl: installation.settingsUrl ?? installationSettingsUrl(installation.id, organization),
          installation: {
            id: installation.id,
            selection: installation.selection,
            settingsUrl: installation.settingsUrl,
            suspended: installation.suspended,
          },
          repositories: [],
          fix: null,
        });
      }
      for (const repo of managed) {
        const [owner = '', name = ''] = repo.fullName.split('/');
        let entry = accounts.get(owner.toLowerCase());
        if (!entry) {
          const [type, id] = await Promise.all([this.accountType(owner), this.accountId(owner)]);
          entry = { login: owner, type, id, installUrl: appInstallUrl(app.slug, id), installation: null, repositories: [], fix: null };
          accounts.set(owner.toLowerCase(), entry);
        }
        entry.repositories.push(name);
      }
      for (const entry of accounts.values()) {
        if (!entry.installation && entry.repositories.length > 0) {
          entry.fix = await this.notInstalledFix(app, installations, entry, entry.repositories);
        }
      }

      // The app's own account first, where it always can be; then by name.
      const ordered = [...accounts.values()].sort((a, b) =>
        sameLogin(a.login, app.owner.login) ? -1 : sameLogin(b.login, app.owner.login) ? 1 : a.login.localeCompare(b.login),
      );
      const organization = app.owner.type === 'Organization' ? app.owner.login : null;
      return {
        app: {
          ...app,
          visibility,
          settingsUrl: appSettingsUrl(app.slug, organization),
          advancedUrl: appAdvancedUrl(app.slug, organization),
          installUrl: appInstallUrl(app.slug),
        },
        accounts: ordered,
        reason: '',
      };
    } catch (error) {
      return { app: null, accounts: [], reason: `OpenADLC could not ask GitHub about the app: ${messageOf(error)}` };
    }
  }

  /**
   * An account the app is not installed on: install it there — or, when the
   * app is private and the account is not its owner, move it or open it first.
   * A person's app that an organization needs is moved to the organization:
   * that is where the crew works, and making it public would let anyone on
   * GitHub install it. Anywhere else, it is made public.
   */
  private async notInstalledFix(
    app: AppFacts,
    installations: readonly AppInstallation[],
    account: { login: string; type: AccountType | null; id: number | null },
    repositories: readonly string[],
  ): Promise<ReachFix> {
    const organization = app.owner.type === 'Organization' ? app.owner.login : null;
    // Installed on this account, not on whichever GitHub's picker would offer first.
    const urls = { install: appInstallUrl(app.slug, account.id), advanced: appAdvancedUrl(app.slug, organization) };
    if (sameLogin(account.login, app.owner.login)) return installFix(account, repositories, app, urls, false);
    const visibility = await this.visibilityOf(app, installations);
    if (visibility === 'private') {
      return account.type === 'Organization' && app.owner.type === 'User'
        ? transferFix(account, repositories, app, urls)
        : publicFix(account, repositories, app, urls);
    }
    return installFix(account, repositories, app, urls, visibility === 'unknown');
  }

  /** Public for certain once it is installed on an account besides its owner's; otherwise, asked. */
  private async visibilityOf(app: AppFacts, installations: readonly AppInstallation[]): Promise<AppView['visibility']> {
    if (installations.some((one) => !sameLogin(one.account.login, app.owner.login))) return 'public';
    return this.remember(`visibility:${app.slug}`, VISIBILITY_MS, () => this.deps.visibility(app.slug));
  }

  private app(credentials: AppCredentials): Promise<AppFacts> {
    return this.remember('app', FRESH_MS, async () => {
      const app = await this.deps.api.request<{
        slug?: string;
        name?: string;
        owner?: { login?: string; type?: string } | null;
      }>('GET', '/app', appJwt(credentials, this.now()));
      if (!app.slug || !app.owner?.login) throw new Error('GitHub described the app without a slug or an owner');
      return {
        slug: app.slug,
        name: app.name ?? app.slug,
        owner: { login: app.owner.login, type: app.owner.type === 'Organization' ? 'Organization' : 'User' },
      };
    });
  }

  private installations(credentials: AppCredentials): Promise<AppInstallation[]> {
    return this.remember('installations', FRESH_MS, () => appInstallations(this.deps.api, credentials, this.now()));
  }

  /** The installation covering a repository, or null when GitHub says there is none. */
  private installationOn(credentials: AppCredentials, fullName: string): Promise<FoundInstallation | null> {
    return this.remember(`installation:${fullName.toLowerCase()}`, FRESH_MS, async () => {
      try {
        const found = await this.deps.api.request<{
          id?: number;
          account?: { login?: string } | null;
          suspended_at?: string | null;
          html_url?: string;
        }>('GET', `/repos/${fullName}/installation`, appJwt(credentials, this.now()));
        if (!found.id) return null;
        return {
          id: found.id,
          account: found.account?.login ?? fullName.split('/')[0] ?? '',
          suspended: Boolean(found.suspended_at),
          settingsUrl: found.html_url ?? null,
        };
      } catch (error) {
        if (statusOf(error) === 404) return null;
        throw error;
      }
    });
  }

  private accountType(login: string): Promise<AccountType | null> {
    return this.remember(`account:${login.toLowerCase()}`, ACCOUNT_TYPE_MS, () => this.deps.accountType(login));
  }

  private accountId(login: string): Promise<number | null> {
    const ask = this.deps.accountId;
    if (!ask) return Promise.resolve(null);
    return this.remember(`account-id:${login.toLowerCase()}`, ACCOUNT_TYPE_MS, () => ask(login));
  }

  private remember<T>(key: string, forMs: number, load: () => Promise<T>): Promise<T> {
    const held = this.held.get(key);
    if (held && this.now() - held.at < forMs) return held.value as Promise<T>;
    const value = load();
    this.held.set(key, { at: this.now(), value });
    // A failure is not kept: the next asker asks GitHub again.
    value.catch(() => {
      if (this.held.get(key)?.value === value) this.held.delete(key);
    });
    return value;
  }
}

/**
 * Of the repositories the app's installations reach, those on accounts the
 * install works in (`AppReach.accountsWorkedIn`, lower-cased), and the other
 * accounts by name, for an admin to allow.
 */
export function onAccountsWorkedIn<R extends { fullName: string }>(
  found: readonly R[],
  known: ReadonlySet<string>,
): { offered: R[]; unknownAccounts: string[] } {
  const owner = (fullName: string) => fullName.split('/')[0] ?? '';
  const offered = found.filter((repository) => known.has(owner(repository.fullName).toLowerCase()));
  const unknownAccounts = [...new Set(found.filter((repository) => !offered.includes(repository)).map((repository) => owner(repository.fullName)))];
  return { offered, unknownAccounts };
}

/**
 * `owner/name` from what somebody typed or pasted: a full GitHub URL is fine
 * (http or https, with `www.` or a trailing slash, or the SSH clone address),
 * and so is a `.git` on the end. A bare name has no owner to act as, and a URL
 * with more path is a file in a repository rather than the repository.
 */
export function repositoryFrom(text: string): { owner: string; name: string; fullName: string } | null {
  const fullName = text
    .trim()
    .replace(/^(?:(?:https?:\/\/|ssh:\/\/git@)(?:www\.)?github\.com\/|git@github\.com:|(?:www\.)?github\.com\/)/i, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/.exec(fullName);
  // The name pattern allows dots, and `.` and `..` are paths rather than names.
  if (!match || match[2] === '.' || match[2] === '..') return null;
  return { owner: match[1]!, name: match[2]!, fullName };
}

/**
 * Where the app is installed, for settings' GitHub App section, and whether it
 * reaches one repository, for the field a repository is typed into while it
 * waits on somebody installing the app. Names and GitHub's pages only: no
 * token, key or installation token leaves the bridge.
 */
export function registerAppReachRoutes(router: Router, reach: AppReach | undefined): void {
  const known = (): AppReach => {
    if (!reach) throw new HttpFailure(501, 'this bridge does not look at where the app is installed');
    return reach;
  };

  router.get('/v1/github/installations', async () => known().installationsView());

  router.get('/v1/github/reach', async ({ query }) => {
    const asked = query.get('repo') ?? '';
    const repository = repositoryFrom(asked);
    if (!repository) throw new HttpFailure(400, `${asked || 'that'} is not a repository — give it as owner/name`);
    return known().reach(repository.fullName);
  });
}

/** "an owner of exampleco", or "janedoe": who can install an app on an account. */
function whoInstalls(account: { login: string; type: AccountType | null }): string {
  return account.type === 'Organization' ? `an owner of ${account.login}` : account.login;
}

/** The same, to begin a sentence. A login keeps its case: it is a name, and `Janedoe` is somebody else. */
function whoInstallsFirst(account: { login: string; type: AccountType | null }): string {
  return account.type === 'Organization' ? `An owner of ${account.login}` : account.login;
}

/** "infra", "infra and website", "a, b and c". */
function inWords(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * An account the install does not work in. Nothing is installed or added
 * until an admin allows it, knowing what that means: the crew is invited to
 * its repositories, and the people who can write there can answer the crew's
 * questions and approve its plans.
 */
export function allowFix(account: string): ReachFix {
  const open = { label: `Open ${account} on GitHub`, url: `https://github.com/${account}` };
  return {
    need: 'allow-account',
    title: `${account} is not an account this install works in`,
    detail:
      `OpenADLC works in the app owner’s account, the organization in its settings, the accounts of the repositories it has, ` +
      `and accounts an admin has allowed. A public app can be installed by anyone on their own repositories, and OpenADLC ` +
      `ignores those installations, so a repository on ${account} is not added until an admin allows ${account} — after ` +
      `checking it is an account you work in, not a look-alike: the crew is invited to its repositories, and whoever can ` +
      `write there can answer the crew’s questions.`,
    action: open,
    steps: [
      { text: `Check that ${account} is an account you work in`, action: open },
      { text: `As an admin, allow ${account} here, then add the repository again`, action: open },
    ],
  };
}

function suspendedFix(account: string, type: AccountType | null, url: string): ReachFix {
  const action = { label: `Open the installation on ${account}`, url };
  return {
    need: 'unsuspend',
    title: `The OpenADLC app is suspended on ${account}`,
    detail:
      `Nothing OpenADLC does as the app reaches ${account}’s repositories while it is suspended. ` +
      `${whoInstallsFirst({ login: account, type })} unsuspends it on the installation’s page.`,
    action,
    steps: [{ text: `Unsuspend the app on ${account}`, action }],
  };
}

// Never "or give it all of them": a crew bot's user token reaches whatever the
// installation covers that the bot can see, so an all-repositories install on
// an organization whose bots are members turns what a session can reach from
// the repositories OpenADLC manages into the whole organization.
function chooseFix(account: string, name: string, url: string): ReachFix {
  const action = { label: `Choose repositories on ${account}`, url };
  return {
    need: 'add-repository',
    title: `The OpenADLC app is on ${account}, but not on ${name}`,
    detail: `${account} gave the app some of its repositories and not this one. Add ${name} on the installation’s page; choose only the repositories the crew works in.`,
    action,
    steps: [{ text: `Add ${name} to the app’s repositories on ${account}`, action }],
  };
}

function missingFix(account: string, name: string): ReachFix {
  const action = { label: `Open ${account} on GitHub`, url: `https://github.com/${account}` };
  return {
    need: 'no-such-repository',
    title: `${account} has no repository called ${name} that the app can see`,
    detail: `The app has all of ${account}’s repositories, so the name is misspelled, or the repository was renamed or deleted.`,
    action,
    steps: [{ text: `Check the repository’s name on ${account}`, action }],
  };
}

function transferFix(
  account: { login: string; type: AccountType | null },
  repositories: readonly string[],
  app: AppFacts,
  urls: { install: string; advanced: string },
): ReachFix {
  const transfer = { label: `Transfer the app to ${account.login}`, url: urls.advanced };
  return {
    need: 'transfer',
    title: `The OpenADLC app belongs to ${app.owner.login}, so it cannot be installed on ${account.login}`,
    detail:
      `GitHub installs a private app only on the account that owns it. Move it to ${account.login}: ` +
      `${app.owner.login} transfers it in the app’s Advanced settings (“Transfer ownership”), and an owner of ` +
      `${account.login} accepts. It keeps its id and client id, so nothing in OpenADLC changes. Then ${whoInstalls(account)} ` +
      `installs it and chooses ${inWords(repositories)}. Once it is ${account.login}’s, it stays private to ` +
      `${account.login}: a repository still under ${app.owner.login} needs moving too, or the app made public instead ` +
      `of transferred — which lets anyone on GitHub install it.`,
    action: transfer,
    steps: [
      { text: `Transfer the app to ${account.login} — ${app.owner.login} starts it, an owner of ${account.login} accepts`, action: transfer },
      {
        text: `Install it on ${account.login} and choose ${inWords(repositories)}`,
        action: { label: `Install on ${account.login}`, url: urls.install },
      },
    ],
  };
}

function publicFix(
  account: { login: string; type: AccountType | null },
  repositories: readonly string[],
  app: AppFacts,
  urls: { install: string; advanced: string },
): ReachFix {
  const makePublic = { label: 'Make the app public', url: urls.advanced };
  const owner = whoInstalls(app.owner);
  return {
    need: 'make-public',
    title: `The OpenADLC app is private to ${app.owner.login}`,
    detail:
      `GitHub installs a private app only on the account that owns it, so it cannot go on ${account.login} yet. ` +
      `${whoInstallsFirst(app.owner)} makes it public, in the app’s Advanced settings; then ${whoInstalls(account)} installs it ` +
      `and chooses ${inWords(repositories)}. Once it is public, anyone on GitHub can install it on their own repositories; ` +
      `OpenADLC ignores an installation on an account it does not work in.`,
    action: makePublic,
    steps: [
      { text: `Make the app public — only ${owner} can`, action: makePublic },
      { text: `Install it on ${account.login} and choose ${inWords(repositories)}`, action: { label: `Install on ${account.login}`, url: urls.install } },
    ],
  };
}

function installFix(
  account: { login: string; type: AccountType | null },
  repositories: readonly string[],
  app: AppFacts,
  urls: { install: string; advanced: string },
  maybePrivate: boolean,
): ReachFix {
  const install = { label: `Install on ${account.login}`, url: urls.install };
  const asking =
    account.type === 'Organization' ? ' A member who is not an owner can ask, and GitHub sends the owners the request.' : '';
  // Not known either way: say what GitHub would show if it were private.
  const privately = maybePrivate
    ? ` If GitHub offers only ${app.owner.login}, the app is still private: make it public in its Advanced settings first. ` +
      'Public, anyone on GitHub can install it on their own repositories, and OpenADLC ignores an installation on an account it does not work in.'
    : '';
  const steps: ReachStep[] = [];
  if (maybePrivate) {
    steps.push({ text: `If GitHub offers only ${app.owner.login}, make the app public first`, action: { label: 'Open its Advanced settings', url: urls.advanced } });
  }
  steps.push({ text: `Install it on ${account.login} and choose ${inWords(repositories)}`, action: install });
  return {
    need: 'install',
    title: `The OpenADLC app is not installed on ${account.login}`,
    detail: `${whoInstallsFirst(account)} installs it and chooses ${inWords(repositories)}: only the repositories the crew works in, not all of ${account.login}’s.${asking}${privately}`,
    action: install,
    steps,
  };
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}
