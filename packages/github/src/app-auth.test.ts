import { generateKeyPairSync, createVerify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { appInstallations, appJwt, appRuleFields, appVisibility, installationTokenFor, installedRepositories, type AppApi } from './app-auth.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const CREDENTIALS = { clientId: 'Iv23liTEST', privateKey };
const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('proving we hold the app key', () => {
  it('signs a token GitHub can verify with the public half', () => {
    const [header, payload, signature] = appJwt(CREDENTIALS, NOW).split('.');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${payload}`);
    verifier.end();

    expect(verifier.verify(publicKey, Buffer.from(signature as string, 'base64url'))).toBe(true);
    expect(decode(header as string)).toEqual({ alg: 'RS256', typ: 'JWT' });
  });

  it('backdates the issue time, because a laptop clock drifts', () => {
    // GitHub rejects a JWT whose `iat` is in its own future. A minute of slack
    // is the difference between working and an intermittent 401 nobody can
    // reproduce.
    const claims = decode(appJwt(CREDENTIALS, NOW).split('.')[1] as string);
    expect(claims.iat).toBe(Math.floor(NOW / 1000) - 60);
  });

  it('never asks for longer than GitHub allows', () => {
    // Ten minutes is the maximum; more is refused outright.
    const claims = decode(appJwt(CREDENTIALS, NOW).split('.')[1] as string);
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(600);
  });

  it('issues as the client id, which is what identifies the app', () => {
    const claims = decode(appJwt(CREDENTIALS, NOW).split('.')[1] as string);
    expect(claims.iss).toBe('Iv23liTEST');
  });
});

describe('what the repository rules need from the app', () => {
  const answering = (app: unknown): AppApi & { asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      request: async <T>(method: string, path: string): Promise<T> => {
        asked.push(`${method} ${path}`);
        return app as T;
      },
    };
  };

  it('is its id, and the review gate pinned to it once it holds Checks: write', async () => {
    const api = answering({ id: 4242, permissions: { checks: 'write', contents: 'write' } });
    expect(await appRuleFields(api, CREDENTIALS, NOW)).toEqual({ appId: 4242, pinnedChecks: ['review-gate'] });
    expect(api.asked).toEqual(['GET /app']);
  });

  it('is its id alone when it cannot publish checks, since nothing else could set a pinned gate', async () => {
    expect(await appRuleFields(answering({ id: 4242, permissions: { checks: 'read' } }), CREDENTIALS, NOW)).toEqual({
      appId: 4242,
      pinnedChecks: [],
    });
  });

  it('is nothing without the app key, or when GitHub does not answer, and asks nothing then', async () => {
    const api = answering({ id: 4242 });
    expect(await appRuleFields(api, null, NOW)).toEqual({ pinnedChecks: [] });
    expect(await appRuleFields(api, { clientId: 'Iv23liTEST', privateKey: '' }, NOW)).toEqual({ pinnedChecks: [] });
    expect(api.asked).toEqual([]);
    const failing: AppApi = { request: async () => Promise.reject(new Error('401')) };
    expect(await appRuleFields(failing, CREDENTIALS, NOW)).toEqual({ pinnedChecks: [] });
  });
});

describe('getting a token that can administer one repository', () => {
  function api(overrides: { installation?: unknown; minted?: unknown } = {}) {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const impl: AppApi = {
      async request<T>(method: string, path: string, _token: string, body?: unknown): Promise<T> {
        calls.push({ method, path, body });
        if (path.endsWith('/installation')) return (overrides.installation ?? { id: 42 }) as T;
        return (overrides.minted ?? { token: 'ghs_abc', expires_at: '2026-09-20T13:00:00Z' }) as T;
      },
    };
    return { impl, calls };
  }

  it('scopes the token to the one repository it was asked about', async () => {
    // An installation token is already wider than anything else here: it is not
    // intersected with any account's access. It should not also reach every
    // other repository the app happens to be installed on.
    const { impl, calls } = api();
    await installationTokenFor(impl, CREDENTIALS, 'janedoe/fleetadlc-testbed', NOW);

    expect(calls[1]?.path).toBe('/app/installations/42/access_tokens');
    expect(calls[1]?.body).toEqual({ repositories: ['fleetadlc-testbed'] });
  });

  it('returns the token and when it dies', async () => {
    const { impl } = api();
    const minted = await installationTokenFor(impl, CREDENTIALS, 'janedoe/fleetadlc-testbed', NOW);

    expect(minted).toEqual({ token: 'ghs_abc', expiresAt: '2026-09-20T13:00:00Z' });
  });

  it('says the app is not installed, rather than failing obscurely', async () => {
    // The likeliest setup mistake: the app exists, the key is right, and nobody
    // installed it on this repository.
    const { impl } = api({ installation: {} });

    await expect(
      installationTokenFor(impl, CREDENTIALS, 'janedoe/fleetadlc-testbed', NOW),
    ).rejects.toThrow(/not installed on janedoe\/fleetadlc-testbed/);
  });
});

describe('the repositories an app was installed on', () => {
  /**
   * The list exists only after the app is installed, which is the argument for
   * asking which repository *then* rather than making somebody type one into a
   * blank field before anything has been set up.
   */
  function fakeGitHub(installations: Record<number, string[]>): { api: AppApi; calls: string[] } {
    const calls: string[] = [];
    let current: number | null = null;

    return {
      calls,
      api: {
        request: async <T>(method: string, path: string): Promise<T> => {
          calls.push(`${method} ${path}`);
          if (path.startsWith('/app/installations?')) {
            return Object.keys(installations).map((id) => ({ id: Number(id) })) as T;
          }
          const minting = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
          if (minting) {
            current = Number(minting[1]);
            return { token: `ghs_for_${current}` } as T;
          }
          if (path.startsWith('/installation/repositories')) {
            const page = Number(new URLSearchParams(path.split('?')[1]).get('page'));
            return {
              repositories: (installations[current as number] ?? []).slice((page - 1) * 100, page * 100).map((full_name) => ({
                full_name,
                private: full_name.includes('private'),
                default_branch: 'main',
              })),
            } as T;
          }
          throw new Error(`no route for ${path}`);
        },
      },
    };
  }

  it('lists what the app can actually act on', async () => {
    const { api } = fakeGitHub({ 42: ['janedoe/fleetadlc-testbed', 'janedoe/private-thing'] });

    const found = await installedRepositories(api, CREDENTIALS, NOW);

    expect(found.map((one) => one.fullName)).toEqual(['janedoe/fleetadlc-testbed', 'janedoe/private-thing']);
    expect(found.find((one) => one.fullName.includes('private'))?.private).toBe(true);
  });

  it('gathers every installation, not only the first', async () => {
    // An app can be installed on a personal account and an organization at once,
    // and a picker that showed one of them would hide the repository somebody
    // was looking for.
    const { api } = fakeGitHub({ 1: ['a/one'], 2: ['b/two'] });

    expect((await installedRepositories(api, CREDENTIALS, NOW)).map((one) => one.fullName)).toEqual([
      'a/one',
      'b/two',
    ]);
  });

  it('returns nothing, rather than failing, before the app is installed anywhere', async () => {
    const { api } = fakeGitHub({});

    expect(await installedRepositories(api, CREDENTIALS, NOW)).toEqual([]);
  });

  it('reads every page of an installation’s repositories', async () => {
    // An organization that installed the app on all of its repositories, more
    // than a page of them, was offered the first hundred.
    const many = Array.from({ length: 230 }, (_, i) => `acme/repo-${String(i).padStart(3, '0')}`);
    const { api } = fakeGitHub({ 7: many });

    const found = await installedRepositories(api, CREDENTIALS, NOW);

    expect(found).toHaveLength(230);
    expect(found.at(-1)?.fullName).toBe('acme/repo-229');
  });

  it('says why when the installations cannot be listed, rather than reading it as installed nowhere', async () => {
    const api: AppApi = {
      request: async <T>(): Promise<T> => {
        throw new Error('/app/installations → 401: A JSON web token could not be decoded');
      },
    };

    await expect(installedRepositories(api, CREDENTIALS, NOW)).rejects.toThrow(/could not be decoded/);
  });

  it('carries on when one installation cannot be read', async () => {
    // One installation the app has lost access to must not hide the others.
    const calls: string[] = [];
    const api: AppApi = {
      request: async <T>(method: string, path: string): Promise<T> => {
        calls.push(path);
        if (path.startsWith('/app/installations?')) return [{ id: 1 }, { id: 2 }] as T;
        if (path === '/app/installations/1/access_tokens') throw new Error('404');
        if (path === '/app/installations/2/access_tokens') return { token: 'ghs_ok' } as T;
        return { repositories: [{ full_name: 'b/two', private: false, default_branch: 'main' }] } as T;
      },
    };

    expect((await installedRepositories(api, CREDENTIALS, NOW)).map((one) => one.fullName)).toEqual(['b/two']);
  });
});

describe('the accounts the app is installed on', () => {
  function listing(installations: unknown[]): { api: AppApi; paths: string[] } {
    const paths: string[] = [];
    return {
      paths,
      api: {
        request: async <T>(_method: string, path: string): Promise<T> => {
          paths.push(path);
          return installations as T;
        },
      },
    };
  }

  it('says, for each, whose it is, which repositories it has, and where to change that', async () => {
    const { api } = listing([
      {
        id: 7,
        account: { login: 'janedoe', id: 1001, type: 'User' },
        repository_selection: 'all',
        html_url: 'https://github.com/settings/installations/7',
        suspended_at: null,
      },
      {
        id: 8,
        account: { login: 'exampleco', id: 99, type: 'Organization' },
        repository_selection: 'selected',
        html_url: 'https://github.com/organizations/exampleco/settings/installations/8',
        suspended_at: '2026-09-01T00:00:00Z',
      },
    ]);

    expect(await appInstallations(api, CREDENTIALS, NOW)).toEqual([
      {
        id: 7,
        account: { login: 'janedoe', id: 1001, type: 'User' },
        selection: 'all',
        settingsUrl: 'https://github.com/settings/installations/7',
        suspended: false,
      },
      {
        id: 8,
        account: { login: 'exampleco', id: 99, type: 'Organization' },
        selection: 'selected',
        settingsUrl: 'https://github.com/organizations/exampleco/settings/installations/8',
        suspended: true,
      },
    ]);
  });

  it('asks for a full page, since an app can be on more accounts than the default thirty', async () => {
    const { api, paths } = listing([]);
    await appInstallations(api, CREDENTIALS, NOW);
    expect(paths).toEqual(['/app/installations?per_page=100']);
  });

  it('leaves out an installation GitHub describes without an account', async () => {
    const { api } = listing([{ id: 9, account: null }, { account: { login: 'nobody' } }]);
    expect(await appInstallations(api, CREDENTIALS, NOW)).toEqual([]);
  });
});

describe('whether another account can install the app', () => {
  const answering = (status: number) => vi.fn(async () => new Response('{}', { status })) as unknown as typeof fetch;

  it('is public when GitHub shows the app to somebody with no credential, and private when it does not', async () => {
    expect(await appVisibility('fleetadlc-janedoe', answering(200))).toBe('public');
    expect(await appVisibility('fleetadlc-janedoe', answering(404))).toBe('private');
  });

  it('asks without a credential, since the owner’s own token sees a private app too', async () => {
    const fetchImpl = answering(200);
    await appVisibility('fleetadlc janedoe', fetchImpl);
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe('https://api.github.com/apps/fleetadlc%20janedoe');
    expect(new Headers(init.headers).has('authorization')).toBe(false);
  });

  it('does not know when GitHub refuses or cannot be reached, rather than calling it private', async () => {
    expect(await appVisibility('fleetadlc-janedoe', answering(403))).toBe('unknown');
    const unreachable = vi.fn(async () => {
      throw new Error('ENOTFOUND');
    }) as unknown as typeof fetch;
    expect(await appVisibility('fleetadlc-janedoe', unreachable)).toBe('unknown');
  });
});
