import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AppApi } from '@fleetadlc/github';
import { AppReach, onAccountsWorkedIn, repositoryFrom, type AppReachDeps } from './app-reach.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const CREDENTIALS = { clientId: 'Iv23liTEST', privateKey };

interface Installed {
  id: number;
  login: string;
  type?: 'User' | 'Organization';
  selection?: 'all' | 'selected';
  suspended?: boolean;
  /** The repositories it covers, by name; every one of the account's when `selection` is `all`. */
  repositories?: string[];
}

/**
 * GitHub as the app sees it: the app `fleetadlc-janedoe`, owned by `janedoe`, and
 * the installations given. A repository's installation is found the way
 * GitHub finds it — by the account and the repositories chosen — and anything
 * else is the 404 `APP_API` throws, in its words.
 */
function github(installations: Installed[], options: { existing?: string[] } = {}): { api: AppApi; paths: string[] } {
  const paths: string[] = [];
  const existing = new Set(options.existing ?? ['janedoe/fleetadlc-testbed', 'exampleco/infra', 'exampleco/website']);
  const notFound = (path: string) => new Error(`${path} → 404: {"message":"Not Found"}`);
  const describe = (one: Installed) => ({
    id: one.id,
    account: { login: one.login, id: one.id * 100, type: one.type ?? 'User' },
    repository_selection: one.selection ?? 'all',
    html_url: `https://github.com/settings/installations/${one.id}`,
    suspended_at: one.suspended ? '2026-09-01T00:00:00Z' : null,
  });
  return {
    paths,
    api: {
      async request<T>(_method: string, path: string): Promise<T> {
        paths.push(path);
        if (path === '/app') return { slug: 'fleetadlc-janedoe', name: 'OpenADLC (janedoe)', owner: { login: 'janedoe', type: 'User' } } as T;
        if (path === '/app/installations?per_page=100') return installations.map(describe) as T;
        const asked = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(path);
        if (asked) {
          const [, owner, name] = asked as unknown as [string, string, string];
          const covering = installations.find(
            (one) =>
              one.login.toLowerCase() === owner.toLowerCase() &&
              existing.has(`${owner}/${name}`) &&
              (one.selection !== 'selected' || (one.repositories ?? []).includes(name)),
          );
          if (!covering) throw notFound(path);
          return describe(covering) as T;
        }
        throw new Error(`no route for ${path}`);
      },
    },
  };
}

function reachWith(
  installations: Installed[],
  overrides: Partial<AppReachDeps> & { existing?: string[] } = {},
): { reach: AppReach; paths: string[]; visibility: ReturnType<typeof vi.fn> } {
  const { api, paths } = github(installations, { existing: overrides.existing });
  const visibility = vi.fn(async () => 'private' as const);
  const reach = new AppReach({
    credentials: async () => CREDENTIALS,
    api,
    visibility,
    accountType: async (login) => (login === 'exampleco' ? 'Organization' : 'User'),
    repositories: async () => [{ fullName: 'janedoe/fleetadlc-testbed' }, { fullName: 'exampleco/infra' }],
    ...overrides,
  });
  return { reach, paths, visibility: (overrides.visibility as ReturnType<typeof vi.fn>) ?? visibility };
}

const ON_JANEDOE: Installed = { id: 7, login: 'janedoe' };

describe('whether the app can reach a repository', () => {
  it('can, where an installation covers it', async () => {
    const { reach } = reachWith([ON_JANEDOE]);
    expect(await reach.reach('janedoe/fleetadlc-testbed')).toEqual({
      state: 'reachable',
      repository: 'janedoe/fleetadlc-testbed',
      account: 'janedoe',
      installationId: 7,
    });
  });

  it('says a person’s private app has to move to the organization that needs it', async () => {
    // The install this was found on: the app on janedoe only, and a repository of exampleco's.
    const { reach } = reachWith([ON_JANEDOE]);
    const answer = await reach.reach('exampleco/infra');

    expect(answer).toMatchObject({
      state: 'blocked',
      account: 'exampleco',
      need: 'transfer',
      title: 'The OpenADLC app belongs to janedoe, so it cannot be installed on exampleco',
      action: { label: 'Transfer the app to exampleco', url: 'https://github.com/settings/apps/fleetadlc-janedoe/advanced' },
    });
    if (answer.state !== 'blocked') throw new Error('not blocked');
    expect(answer.detail).toContain('GitHub installs a private app only on the account that owns it');
    expect(answer.detail).toContain('keeps its id and client id');
    // The other way out is named, with what it costs.
    expect(answer.detail).toContain('lets anyone on GitHub install it');
    expect(answer.steps.map((step) => step.action)).toEqual([
      { label: 'Transfer the app to exampleco', url: 'https://github.com/settings/apps/fleetadlc-janedoe/advanced' },
      { label: 'Install on exampleco', url: 'https://github.com/apps/fleetadlc-janedoe/installations/new' },
    ]);
    // Never the raw answer GitHub gave, which is what settings used to show.
    expect(JSON.stringify(answer)).not.toContain('404');
  });

  it('says a private app has to be made public before another person’s account can install it, once that account is allowed', async () => {
    const { reach } = reachWith([ON_JANEDOE], { allowedAccounts: async () => ['someone-else'] });
    const answer = await reach.reach('someone-else/tool');

    expect(answer).toMatchObject({
      state: 'blocked',
      need: 'make-public',
      title: 'The OpenADLC app is private to janedoe',
      action: { label: 'Make the app public', url: 'https://github.com/settings/apps/fleetadlc-janedoe/advanced' },
    });
    if (answer.state !== 'blocked') throw new Error('not blocked');
    // What making it public lets happen, and what OpenADLC does about it.
    expect(answer.detail).toContain('anyone on GitHub can install it on their own repositories');
    expect(answer.detail).toContain('OpenADLC ignores an installation on an account it does not work in');
  });

  it('does not reach a repository on an account the install does not work in, though the app is installed there', async () => {
    // The app made public, and a stranger installed it on a look-alike.
    const { reach } = reachWith([ON_JANEDOE, { id: 9, login: 'examp1eco', type: 'Organization' }], { existing: ['examp1eco/infra'] });
    const answer = await reach.reach('examp1eco/infra');

    expect(answer).toMatchObject({ state: 'blocked', account: 'examp1eco', need: 'allow-account', title: 'examp1eco is not an account this install works in' });
    if (answer.state !== 'blocked') throw new Error('not blocked');
    expect(answer.detail).toContain('an admin allows examp1eco');
    expect(answer.steps.map((step) => step.text)).toEqual([
      'Check that examp1eco is an account you work in',
      'As an admin, allow examp1eco here, then add the repository again',
    ]);
  });

  it('reaches it once an admin allows the account, and knows the app’s owner, the organization and the managed repositories’ owners without asking', async () => {
    const elsewhere = { id: 9, login: 'partnerco', type: 'Organization' as const };
    const allowed = reachWith([ON_JANEDOE, elsewhere], { existing: ['partnerco/api'], allowedAccounts: async () => ['partnerco'] });
    expect(await allowed.reach.reach('partnerco/api')).toMatchObject({ state: 'reachable', account: 'partnerco' });

    const known = reachWith([ON_JANEDOE], { organization: async () => 'ExampleCo', repositories: async () => [] });
    expect([...(await known.reach.accountsWorkedIn())].sort()).toEqual(['exampleco', 'janedoe']);
  });

  it('says to install it once the app is public, and who on an organization can', async () => {
    const { reach } = reachWith([ON_JANEDOE], { visibility: vi.fn(async () => 'public' as const) });
    const answer = await reach.reach('exampleco/infra');

    expect(answer).toMatchObject({
      state: 'blocked',
      need: 'install',
      title: 'The OpenADLC app is not installed on exampleco',
      action: { label: 'Install on exampleco', url: 'https://github.com/apps/fleetadlc-janedoe/installations/new' },
    });
    if (answer.state !== 'blocked') throw new Error('not blocked');
    expect(answer.detail).toBe(
      'An owner of exampleco installs it and chooses infra: only the repositories the crew works in, not all of exampleco’s. ' +
        'A member who is not an owner can ask, and GitHub sends the owners the request.',
    );
    expect(answer.steps).toHaveLength(1);
  });

  it('links the install straight to the account, past GitHub’s account picker, when its id is known', async () => {
    const { reach } = reachWith([ON_JANEDOE], {
      visibility: vi.fn(async () => 'public' as const),
      accountId: async (login) => (login === 'exampleco' ? 4242 : null),
    });
    expect(await reach.reach('exampleco/infra')).toMatchObject({
      need: 'install',
      action: { label: 'Install on exampleco', url: 'https://github.com/apps/fleetadlc-janedoe/installations/new/permissions?target_id=4242' },
    });
  });

  it('covers both when it cannot tell whether the app is public, rather than calling it private', async () => {
    const { reach } = reachWith([ON_JANEDOE], { visibility: vi.fn(async () => 'unknown' as const) });
    const answer = await reach.reach('exampleco/infra');

    expect(answer).toMatchObject({ state: 'blocked', need: 'install', action: { label: 'Install on exampleco' } });
    if (answer.state !== 'blocked') throw new Error('not blocked');
    expect(answer.detail).toContain('If GitHub offers only janedoe, the app is still private');
    expect(answer.steps.map((step) => step.action.label)).toEqual(['Open its Advanced settings', 'Install on exampleco']);
  });

  it('knows the app is public without asking once it is installed on another account', async () => {
    const { reach, visibility } = reachWith([ON_JANEDOE, { id: 9, login: 'acme', type: 'Organization' }]);
    expect(await reach.reach('exampleco/infra')).toMatchObject({ need: 'install' });
    expect(visibility).not.toHaveBeenCalled();
  });

  it('says to install it on the app’s own account, which a private app allows', async () => {
    const { reach, visibility } = reachWith([], { existing: ['janedoe/fleetadlc-testbed'] });
    expect(await reach.reach('janedoe/fleetadlc-testbed')).toMatchObject({
      need: 'install',
      title: 'The OpenADLC app is not installed on janedoe',
      detail: 'janedoe installs it and chooses fleetadlc-testbed: only the repositories the crew works in, not all of janedoe’s.',
    });
    expect(visibility).not.toHaveBeenCalled();
  });

  it('says to add the repository where the account gave the app only some', async () => {
    const { reach } = reachWith([ON_JANEDOE, { id: 8, login: 'exampleco', type: 'Organization', selection: 'selected', repositories: ['website'] }]);
    expect(await reach.reach('exampleco/infra')).toMatchObject({
      state: 'blocked',
      need: 'add-repository',
      title: 'The OpenADLC app is on exampleco, but not on infra',
      detail: 'exampleco gave the app some of its repositories and not this one. Add infra on the installation’s page; choose only the repositories the crew works in.',
      action: { label: 'Choose repositories on exampleco', url: 'https://github.com/settings/installations/8' },
    });
  });

  it('says the name is wrong where the app has all of the account’s repositories and still not this one', async () => {
    const { reach } = reachWith([ON_JANEDOE, { id: 8, login: 'exampleco', type: 'Organization' }]);
    expect(await reach.reach('exampleco/infar')).toMatchObject({
      need: 'no-such-repository',
      title: 'exampleco has no repository called infar that the app can see',
      action: { url: 'https://github.com/exampleco' },
    });
  });

  it('says to unsuspend a suspended installation before anything else about it', async () => {
    const suspended: Installed = { id: 8, login: 'exampleco', type: 'Organization', selection: 'selected', suspended: true, repositories: ['infra'] };
    const { reach } = reachWith([ON_JANEDOE, suspended]);
    expect(await reach.reach('exampleco/infra')).toMatchObject({
      need: 'unsuspend',
      title: 'The OpenADLC app is suspended on exampleco',
      action: { url: 'https://github.com/settings/installations/8' },
    });
    // Suspended and not given the repository: unsuspending comes first.
    expect(await reach.reach('exampleco/website')).toMatchObject({ need: 'unsuspend' });
  });

  it('has no answer without the app’s key, or when GitHub does not answer', async () => {
    const keyless = reachWith([], { credentials: async () => null }).reach;
    expect(await keyless.reach('exampleco/infra')).toMatchObject({ state: 'unknown', reason: expect.stringContaining('private key') });

    const down: AppApi = {
      request: async () => {
        throw new Error('/app → 502: bad gateway');
      },
    };
    const { reach } = reachWith([], { api: down });
    expect(await reach.reach('exampleco/infra')).toMatchObject({ state: 'unknown', reason: expect.stringContaining('502') });
  });

  it('has no answer, rather than failing, when the key cannot be read — adding a repository asks this first', async () => {
    const broken = async () => {
      throw new Error('the secret store is not answering');
    };
    const { reach } = reachWith([], { credentials: broken });
    expect(await reach.reach('exampleco/infra')).toMatchObject({ state: 'unknown', reason: expect.stringContaining('secret store') });
    expect(await reach.installationsView()).toMatchObject({ app: null, reason: expect.stringContaining('secret store') });
  });

  it('asks GitHub once for a page that asks every few seconds, and again once told the installations changed', async () => {
    let now = 0;
    const { reach, paths } = reachWith([ON_JANEDOE], { now: () => now });
    await reach.reach('exampleco/infra');
    const once = paths.length;
    now = 5_000;
    await reach.reach('exampleco/infra');
    expect(paths).toHaveLength(once);

    reach.clear();
    await reach.reach('exampleco/infra');
    expect(paths.length).toBeGreaterThan(once);
  });
});

describe('where the app is installed, as settings shows it', () => {
  it('lists the app’s own account first, each installation, and each account OpenADLC works in without one', async () => {
    const { reach } = reachWith([ON_JANEDOE]);
    const view = await reach.installationsView();

    expect(view.app).toEqual({
      slug: 'fleetadlc-janedoe',
      name: 'OpenADLC (janedoe)',
      owner: { login: 'janedoe', type: 'User' },
      visibility: 'private',
      settingsUrl: 'https://github.com/settings/apps/fleetadlc-janedoe',
      advancedUrl: 'https://github.com/settings/apps/fleetadlc-janedoe/advanced',
      installUrl: 'https://github.com/apps/fleetadlc-janedoe/installations/new',
    });
    expect(view.accounts.map((account) => [account.login, account.installation?.selection ?? null, account.repositories])).toEqual([
      ['janedoe', 'all', ['fleetadlc-testbed']],
      ['exampleco', null, ['infra']],
    ]);
    expect(view.accounts[0]?.fix).toBeNull();
    expect(view.accounts[1]).toMatchObject({ type: 'Organization', fix: { need: 'transfer' } });
  });

  it('links each account to its installation’s page, or to installing there past GitHub’s account picker', async () => {
    const { reach } = reachWith([ON_JANEDOE], { accountId: async (login) => (login === 'exampleco' ? 4242 : null) });
    const view = await reach.installationsView();
    expect(view.accounts.map((account) => [account.login, account.id, account.installUrl])).toEqual([
      ['janedoe', 700, 'https://github.com/settings/installations/7'],
      ['exampleco', 4242, 'https://github.com/apps/fleetadlc-janedoe/installations/new/permissions?target_id=4242'],
    ]);
    // The transfer's second step installs on exampleco, not wherever the picker lands.
    expect(view.accounts[1]?.fix?.steps[1]?.action.url).toBe('https://github.com/apps/fleetadlc-janedoe/installations/new/permissions?target_id=4242');
  });

  it('says why there is nothing to show before OpenADLC holds the key', async () => {
    const { reach } = reachWith([], { credentials: async () => null });
    expect(await reach.installationsView()).toEqual({ app: null, accounts: [], reason: expect.stringContaining('private key') });
  });
});

describe('a repository from what somebody typed', () => {
  it('reads the ways a GitHub repository is usually pasted', () => {
    for (const typed of [
      'exampleco/app',
      ' exampleco/app.git ',
      'https://github.com/exampleco/app',
      'https://github.com/exampleco/app/',
      'https://github.com/exampleco/app.git',
      'http://github.com/exampleco/app',
      'https://www.github.com/exampleco/app',
      'github.com/exampleco/app',
      'git@github.com:exampleco/app.git',
      'ssh://git@github.com/exampleco/app.git',
    ]) {
      expect(repositoryFrom(typed), typed).toEqual({ owner: 'exampleco', name: 'app', fullName: 'exampleco/app' });
    }
  });

  it('refuses a bare name, a file in a repository, and a path in place of a name', () => {
    for (const typed of ['app', 'https://github.com/exampleco/app/blob/main/README.md', 'exampleco/.', 'exampleco/..', 'https://gitlab.com/exampleco/app']) {
      expect(repositoryFrom(typed), typed).toBeNull();
    }
  });
});

describe('the repositories offered to pick from', () => {
  it('are only those on accounts the install works in, the others named for an admin to allow', () => {
    const found = [{ fullName: 'janedoe/fleetadlc-testbed' }, { fullName: 'ExampleCo/infra' }, { fullName: 'examp1eco/infra' }, { fullName: 'examp1eco/website' }];
    expect(onAccountsWorkedIn(found, new Set(['janedoe', 'exampleco']))).toEqual({
      offered: [{ fullName: 'janedoe/fleetadlc-testbed' }, { fullName: 'ExampleCo/infra' }],
      unknownAccounts: ['examp1eco'],
    });
  });
});
