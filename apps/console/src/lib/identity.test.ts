import { afterEach, describe, expect, it, vi } from 'vitest';
import { identityHeadersFrom } from './identity';

/**
 * What the console's server puts on a call to the bridge. Locally the bridge
 * serves `/v1` only beside the console secret, and believes the name only
 * because of it; behind IAP the assertion is what counts.
 */
afterEach(() => {
  vi.unstubAllEnvs();
});

const FROM_A_BROWSER = {
  'x-goog-authenticated-user-email': 'accounts.google.com:attacker@example.com',
  'x-goog-iap-jwt-assertion': 'header.payload.signature',
};

function headersFor(incoming: Record<string, string> = {}) {
  return identityHeadersFrom(new Request('http://127.0.0.1:47300/api/backup', { headers: incoming }));
}

describe('on a local install', () => {
  it('carries the console secret when the console has one', () => {
    vi.stubEnv('FLEETADLC_IDENTITY_MODE_EXPECTED', '');
    vi.stubEnv('FLEETADLC_CONSOLE_SECRET', 'c'.repeat(64));
    expect(headersFor()['x-fleetadlc-console-secret']).toBe('c'.repeat(64));
  });

  it('carries no secret header when it has none', () => {
    vi.stubEnv('FLEETADLC_IDENTITY_MODE_EXPECTED', '');
    vi.stubEnv('FLEETADLC_CONSOLE_SECRET', '');
    expect(headersFor()).not.toHaveProperty('x-fleetadlc-console-secret');
  });

  it('never forwards the x-goog headers a browser sent, nor takes a name from them', () => {
    vi.stubEnv('FLEETADLC_IDENTITY_MODE_EXPECTED', '');
    vi.stubEnv('FLEETADLC_CONSOLE_SECRET', 'c'.repeat(64));
    vi.stubEnv('FLEETADLC_IDENTITY', '');
    delete process.env.FLEETADLC_IDENTITY;
    const sent = headersFor(FROM_A_BROWSER);
    expect(Object.keys(sent).filter((name) => name.startsWith('x-goog-'))).toEqual([]);
    expect(sent).not.toHaveProperty('x-fleetadlc-iap-assertion');
    expect(sent['x-fleetadlc-identity']).toBe('console');
  });
});

describe('behind IAP', () => {
  it('forwards the assertion and the email IAP set, as before', () => {
    vi.stubEnv('FLEETADLC_IDENTITY_MODE_EXPECTED', 'iap');
    const sent = headersFor(FROM_A_BROWSER);
    expect(sent['x-goog-iap-jwt-assertion']).toBe('header.payload.signature');
    expect(sent['x-fleetadlc-iap-assertion']).toBe('header.payload.signature');
    expect(sent['x-fleetadlc-identity']).toBe('attacker@example.com');
  });
});
