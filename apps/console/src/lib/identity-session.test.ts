import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A server action posted to a path the middleware matcher skips still runs,
 * and Next accepts it with no Origin. It must not call the bridge with the
 * console secret unless the session cookie checks.
 */
const session = vi.hoisted(() => ({ value: undefined as string | undefined }));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(session.value ? { cookie: `fleetadlc_session=${session.value}` } : {}),
  cookies: async () => ({
    get: (name: string) => (name === 'fleetadlc_session' && session.value ? { name, value: session.value } : undefined),
  }),
}));

import { identityHeaders, requireLocalSession } from './identity';
import { sessionValue } from './sign-in';

const SECRET = 'e'.repeat(64);

afterEach(() => {
  session.value = undefined;
  vi.unstubAllEnvs();
});

describe('a server action with no session', () => {
  it('refuses before the console secret can be attached, on any path the matcher skips', async () => {
    vi.stubEnv('FLEETADLC_IDENTITY_MODE_EXPECTED', '');
    vi.stubEnv('FLEETADLC_CONSOLE_SECRET', SECRET);
    await expect(requireLocalSession()).rejects.toThrow(/console-link/);
    await expect(identityHeaders()).rejects.toThrow(/console-link/);
  });

  it('attaches the secret once the session cookie checks', async () => {
    vi.stubEnv('FLEETADLC_IDENTITY_MODE_EXPECTED', '');
    vi.stubEnv('FLEETADLC_CONSOLE_SECRET', SECRET);
    session.value = await sessionValue(SECRET);
    const sent = await identityHeaders();
    expect(sent['x-fleetadlc-console-secret']).toBe(SECRET);
  });

  it('leaves the check to IAP when that is how people sign in', async () => {
    vi.stubEnv('FLEETADLC_IDENTITY_MODE_EXPECTED', 'iap');
    vi.stubEnv('FLEETADLC_CONSOLE_SECRET', SECRET);
    await expect(requireLocalSession()).resolves.toBeUndefined();
  });
});
