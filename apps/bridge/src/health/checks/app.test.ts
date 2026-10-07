import { WEBHOOK_EVENTS } from '@fleetadlc/shared';
import { generateKeyPairSync } from 'node:crypto';
import { GitHubApiError, type AppApi } from '@fleetadlc/github';
import { describe, expect, it } from 'vitest';
import { appChecks, forbiddenBecause, type AppReader } from './app.js';

/**
 * The Checks permission, which only changes something where GitHub holds a
 * required check. It was a red box on every install that lacked it, free
 * private organizations included, where it changes nothing at all.
 */

const NOW = new Date('2026-09-28T12:00:00.000Z');
const PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

const FULL = {
  contents: 'write',
  issues: 'write',
  pull_requests: 'write',
  statuses: 'write',
  checks: 'write',
  workflows: 'write',
  administration: 'write',
  actions: 'write',
  deployments: 'read',
  metadata: 'read',
  members: 'read',
  git_signing_ssh_public_keys: 'write',
};
const { checks: _checks, ...WITHOUT_CHECKS } = FULL;

function reader(options: {
  permissions?: Record<string, string>;
  accepted?: Record<string, string>;
  enforces?: boolean | null;
  /** A second repository, on an installation of its own. */
  second?: boolean;
}): AppReader & { asked: number } {
  const api: AppApi = {
    async request<T>(_method: string, path: string): Promise<T> {
      if (path === '/app') {
        return {
          slug: 'fleetadlc-exampleco',
          id: 7,
          owner: { login: 'exampleco', type: 'Organization' },
          permissions: options.permissions ?? FULL,
          // Every event the bridge acts on, so these cases are about Checks alone.
          events: [...WEBHOOK_EVENTS],
        } as T;
      }
      if (path.endsWith('/installation')) {
        const account = path.startsWith('/repos/janedoe/') ? { id: 43, login: 'janedoe', type: 'User' } : { id: 42, login: 'exampleco', type: 'Organization' };
        return { id: account.id, account, permissions: options.accepted ?? options.permissions ?? FULL } as T;
      }
      throw new Error(`${path} → 404: not faked`);
    },
  };
  const read: AppReader & { asked: number } = {
    asked: 0,
    clientId: async () => 'Iv23client',
    credentials: async () => ({ clientId: 'Iv23client', privateKey: PRIVATE_KEY }),
    api,
    repositories: async () => [
      { name: 'site', fullName: 'exampleco/site' },
      ...(options.second ? [{ name: 'notes', fullName: 'janedoe/notes' }] : []),
    ],
    requestDeviceCode: async () => ({}),
    tokenKinds: async () => [{ who: 'builder', kind: 'refresh' }],
    enforcesRules: async () => {
      read.asked += 1;
      return options.enforces ?? null;
    },
  };
  return read;
}

const row = (results: Awaited<ReturnType<ReturnType<typeof appChecks>['permissions']['run']>>, subject: string) =>
  results.find((result) => result.subject === subject);

describe('the Checks permission', () => {
  it('raises nothing when every repository is on a plan that refuses rulesets', async () => {
    const results = await appChecks(reader({ permissions: WITHOUT_CHECKS, enforces: false })).permissions.run(NOW);
    expect(row(results, 'checks')).toBeUndefined();
    expect(results.some((result) => result.ok === false)).toBe(false);
  });

  it('is an optional notice where a repository can enforce it, with both places to go', async () => {
    const results = await appChecks(reader({ permissions: WITHOUT_CHECKS, enforces: true })).permissions.run(NOW);
    const checks = row(results, 'checks');
    expect(checks).toMatchObject({
      ok: false,
      severity: 'warning',
      title: 'Optional: give the OpenADLC app “Checks”',
      action: { url: 'https://github.com/organizations/exampleco/settings/apps/fleetadlc-exampleco/permissions' },
    });
    const detail = checks && 'detail' in checks ? checks.detail : '';
    expect(detail).toContain('[Permissions & events](https://github.com/organizations/exampleco/settings/apps/fleetadlc-exampleco/permissions)');
    expect(detail).toContain('Repository permissions → Checks');
    expect(detail).toContain('**Read and write**');
    expect(detail).toContain('Organization settings → GitHub Apps → the OpenADLC app → [Review request](https://github.com/organizations/exampleco/settings/installations/42)');
    expect(detail).toContain('`review-gate` becomes a check run only the app can set');
  });

  it('links each installation’s own request when there are several', async () => {
    const results = await appChecks(reader({ permissions: WITHOUT_CHECKS, enforces: true, second: true })).permissions.run(NOW);
    const checks = row(results, 'checks');
    const detail = checks && 'detail' in checks ? checks.detail : '';
    expect(detail).toContain('[exampleco](https://github.com/organizations/exampleco/settings/installations/42)');
    expect(detail).toContain('[janedoe](https://github.com/settings/installations/43)');
  });

  it('is the same optional notice when nothing says whether rules are enforced', async () => {
    const results = await appChecks(reader({ permissions: WITHOUT_CHECKS, enforces: null })).permissions.run(NOW);
    expect(row(results, 'checks')).toMatchObject({ ok: false, severity: 'warning' });
  });

  it('asks nothing about the plan when the app has it', async () => {
    const read = reader({ enforces: true });
    const results = await appChecks(read).permissions.run(NOW);
    expect(row(results, 'checks')).toMatchObject({ ok: true });
    expect(read.asked).toBe(0);
  });

  it('asks the installation to accept it only where it counts, and as optional', async () => {
    // No row rather than a passing one: the installation accepted nothing.
    const quiet = await appChecks(reader({ accepted: WITHOUT_CHECKS, enforces: false })).permissions.run(NOW);
    expect(row(quiet, 'accept:42')).toBeUndefined();
    const accepted = await appChecks(reader({ enforces: false })).permissions.run(NOW);
    expect(row(accepted, 'accept:42')).toMatchObject({ ok: true });

    const asked = await appChecks(reader({ accepted: WITHOUT_CHECKS, enforces: true })).permissions.run(NOW);
    expect(row(asked, 'accept:42')).toMatchObject({ ok: false, severity: 'warning' });
  });

  it('leaves every other missing permission blocking', async () => {
    const { administration: _left, ...rest } = WITHOUT_CHECKS;
    const results = await appChecks(reader({ permissions: rest, enforces: false })).permissions.run(NOW);
    expect(row(results, 'administration')).toMatchObject({ ok: false, severity: 'blocking' });
    expect(row(results, 'checks')).toBeUndefined();
  });
});

describe('the app’s client secret', () => {
  const settingsLink = { label: 'Open the app’s settings', url: expect.stringContaining('fleetadlc-exampleco') };

  it('warns, with the steps and a link to the app’s page, when the install holds none', async () => {
    const [result] = await appChecks({ ...reader({}), clientSecret: async () => null }).clientSecret.run(NOW);

    expect(result).toMatchObject({
      ok: false,
      severity: 'warning',
      title: 'Each task’s GitHub token reaches every repository its bot can',
      detail: expect.stringMatching(/Generate a new client secret on the app’s settings page.*Settings → GitHub → App client secret/),
      action: settingsLink,
    });
  });

  it('passes once a token has been scoped with it', async () => {
    const asked: string[] = [];
    const [result] = await appChecks({
      ...reader({}),
      clientSecret: async () => 'zzz-secret-zzz',
      lastScoped: () => ({ ok: true }),
      secretAccepted: async () => (asked.push('asked'), false),
    }).clientSecret.run(NOW);

    expect(result).toMatchObject({ ok: true });
    expect(asked).toEqual([]);
  });

  it('fails when GitHub refused it for a scoped token, or when asked to check a bot’s token with it', async () => {
    const [scoping] = await appChecks({
      ...reader({}),
      clientSecret: async () => 'zzz-stale-zzz',
      lastScoped: () => ({ ok: false, secretRefused: true, reason: 'GitHub refused the app’s client secret' }),
    }).clientSecret.run(NOW);
    expect(scoping).toMatchObject({ ok: false, title: 'GitHub refuses the OpenADLC app’s client secret', action: settingsLink });

    const [checking] = await appChecks({
      ...reader({}),
      clientSecret: async () => 'zzz-stale-zzz',
      lastScoped: () => null,
      secretAccepted: async () => false,
    }).clientSecret.run(NOW);
    expect(checking).toMatchObject({ ok: false, title: 'GitHub refuses the OpenADLC app’s client secret' });

    const [accepted] = await appChecks({
      ...reader({}),
      clientSecret: async () => 'zzz-secret-zzz',
      lastScoped: () => null,
      secretAccepted: async (clientId, secret) => clientId === 'Iv23client' && secret === 'zzz-secret-zzz',
    }).clientSecret.run(NOW);
    expect(accepted).toMatchObject({ ok: true });
  });

  it('has no answer when GitHub cannot be asked', async () => {
    const [result] = await appChecks({
      ...reader({}),
      clientSecret: async () => 'zzz-secret-zzz',
      secretAccepted: async () => {
        throw new Error('fetch failed');
      },
    }).clientSecret.run(NOW);
    expect(result).toMatchObject({ ok: null });
  });
});


describe('an organization that gave the app all of its repositories', () => {
  // A crew token reaches what the installation covers that the bot can see:
  // all of an organization's repositories, with the bots its members, is the
  // whole organization rather than the repositories OpenADLC manages.
  const account = (login: string, type: 'Organization' | 'User', selection: 'all' | 'selected' | null, repositories = ['site']) => ({
    login,
    type,
    id: 42,
    installUrl: `https://github.com/organizations/${login}/settings/installations/8`,
    installation: selection ? { id: 8, selection, settingsUrl: `https://github.com/organizations/${login}/settings/installations/8`, suspended: false } : null,
    repositories,
    fix: null,
  });
  const checking = (accounts: ReturnType<typeof account>[], app: unknown = { slug: 'fleetadlc-exampleco' }) =>
    appChecks({
      ...reader({}),
      installations: async () => ({ app: app as never, accounts, reason: app ? '' : 'OpenADLC does not hold the app’s private key yet' }),
    }).selection.run(NOW);

  it('warns, and links to the installation’s page, where an organization gave it all of them', async () => {
    const results = await checking([account('exampleco', 'Organization', 'all')]);
    expect(results).toEqual([
      expect.objectContaining({
        subject: 'exampleco',
        ok: false,
        severity: 'warning',
        title: 'The OpenADLC app is given all of exampleco’s repositories',
        action: { label: 'Choose repositories on exampleco', url: 'https://github.com/organizations/exampleco/settings/installations/8' },
      }),
    ]);
    expect((results[0] as { detail: string }).detail).toContain('not only the ones OpenADLC manages');
  });

  it('passes where the organization chose its repositories', async () => {
    expect(await checking([account('exampleco', 'Organization', 'selected')])).toEqual([expect.objectContaining({ subject: 'exampleco', ok: true })]);
  });

  it('says nothing of a person’s account, an organization OpenADLC does not work in, or one the app is not on', async () => {
    expect(
      await checking([account('janedoe', 'User', 'all'), account('elsewhere', 'Organization', 'all', []), account('acme', 'Organization', null)]),
    ).toEqual([]);
  });

  it('has no answer when GitHub cannot be asked', async () => {
    expect(await checking([], null)).toEqual([{ ok: null, reason: 'OpenADLC does not hold the app’s private key yet' }]);
  });
});

describe('why GitHub answered 403', () => {
  const forbidden = (body: string) => new GitHubApiError(403, '/repos/exampleco/site', body);

  it('is a rate limit, primary or secondary', () => {
    expect(forbiddenBecause(forbidden('{"message":"API rate limit exceeded for user ID 1."}'))).toBe('rate-limit');
    expect(forbiddenBecause(forbidden('{"message":"You have exceeded a secondary rate limit. Please wait a few minutes."}'))).toBe('rate-limit');
  });

  it('is an organization’s SSO or its IP allow list', () => {
    expect(forbiddenBecause(forbidden('{"message":"Resource protected by organization SAML enforcement."}'))).toBe('sso');
    expect(forbiddenBecause(forbidden('{"message":"The exampleco organization has an IP allow list enabled."}'))).toBe('ip-allow-list');
  });

  it('is nothing for another 403, or for words like these on another status', () => {
    expect(forbiddenBecause(forbidden('{"message":"Resource not accessible by integration"}'))).toBeNull();
    expect(forbiddenBecause(new GitHubApiError(404, '/repos/exampleco/site', 'API rate limit exceeded'))).toBeNull();
    expect(forbiddenBecause(new Error('fetch failed'))).toBeNull();
  });
});
