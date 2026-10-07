import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkApp } from './app-checks.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('an app that was deleted on GitHub', () => {
  it('is named as deleted, not reported as GitHub’s bare "Not Found"', async () => {
    // What GitHub answers a device-code request for a client id whose app is gone.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'Not Found' }), { status: 404 })),
    );

    const checks = await checkApp({
      clientId: 'Iv1.deleted',
      privateKey: null,
      repoFullName: null,
      anyConnected: true,
      anyRefreshToken: true,
    });

    expect(checks.deviceFlow).toBe('disabled');
    expect(checks.detail).toContain('it was deleted');
    expect(checks.detail).toContain('every bot then connects again');
    expect(checks.detail).not.toBe('Not Found');
  });
});

describe('the account named in the first step', () => {
  it('is asked about directly, and the install link skips GitHub’s account picker', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes('/login/device/code')) return new Response(JSON.stringify({ device_code: 'd', user_code: 'U', verification_uri: 'https://github.com/login/device' }));
        if (url.endsWith('/app')) return new Response(JSON.stringify({ slug: 'fleetadlc-example', id: 9, installations_count: 1, owner: { login: 'example-org', type: 'Organization' } }));
        if (url.endsWith('/orgs/example-org/installation')) return new Response('{}', { status: 404 });
        if (url.endsWith('/users/example-org/installation')) return new Response('{}', { status: 404 });
        if (url.endsWith('/users/example-org')) return new Response(JSON.stringify({ id: 42 }));
        return new Response('{}', { status: 404 });
      }),
    );

    const checks = await checkApp({
      clientId: 'Iv1.example',
      privateKey: key,
      repoFullName: null,
      account: 'example-org',
      anyConnected: false,
      anyRefreshToken: false,
    });

    expect(checks.account).toBe('example-org');
    expect(checks.installedOnAccount).toBe('no');
    expect(checks.installUrl).toBe('https://github.com/apps/fleetadlc-example/installations/new/permissions?target_id=42');
  });

  it('links to the installation’s own page once the app is installed there, where more repositories are chosen', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes('/login/device/code')) return new Response(JSON.stringify({ device_code: 'd', user_code: 'U', verification_uri: 'https://github.com/login/device' }));
        if (url.endsWith('/app')) return new Response(JSON.stringify({ slug: 'fleetadlc-exampleco', id: 9, installations_count: 1, owner: { login: 'exampleco', type: 'Organization' } }));
        if (url.endsWith('/orgs/exampleco/installation')) return new Response(JSON.stringify({ id: 88 }));
        if (url.endsWith('/users/exampleco')) return new Response(JSON.stringify({ id: 42 }));
        return new Response('{}', { status: 404 });
      }),
    );

    const checks = await checkApp({
      clientId: 'Iv1.example',
      privateKey: key,
      repoFullName: null,
      account: 'exampleco',
      anyConnected: false,
      anyRefreshToken: false,
    });

    expect(checks.installedOnAccount).toBe('yes');
    expect(checks.installUrl).toBe('https://github.com/organizations/exampleco/settings/installations/88');
  });
});

describe('a repository the app is installed on', () => {
  async function checked(installation: Record<string, unknown>) {
    const { generateKeyPairSync } = await import('node:crypto');
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes('/login/device/code')) return new Response(JSON.stringify({ device_code: 'd', user_code: 'U', verification_uri: 'https://github.com/login/device' }));
        if (url.endsWith('/app')) return new Response(JSON.stringify({ slug: 'fleetadlc-exampleco', id: 9, installations_count: 1, owner: { login: 'exampleco', type: 'Organization' } }));
        if (url.endsWith('/repos/exampleco/api/installation')) return new Response(JSON.stringify(installation));
        return new Response('{}', { status: 404 });
      }),
    );
    return checkApp({ clientId: 'Iv1.example', privateKey: key, repoFullName: 'exampleco/api', anyConnected: false, anyRefreshToken: false });
  }

  it('is installed while the installation is not suspended', async () => {
    expect((await checked({ id: 88, suspended_at: null })).installed).toBe('yes');
  });

  it('is not, while the installation is suspended', async () => {
    // GitHub answers 200 for a suspended one, which reaches nothing.
    expect((await checked({ id: 88, suspended_at: '2026-10-01T00:00:00Z' })).installed).toBe('no');
  });

  it('says whether the private key is held, which is what tells "no key" from "GitHub did not answer"', async () => {
    expect((await checked({ id: 88 })).privateKeyHeld).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ device_code: 'd' }))));
    const keyless = await checkApp({ clientId: 'Iv1.example', privateKey: null, repoFullName: null, anyConnected: false, anyRefreshToken: false });
    expect(keyless.privateKeyHeld).toBe(false);
    expect(keyless.app).toBeNull();
  });
});
