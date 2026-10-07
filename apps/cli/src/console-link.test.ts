import { describe, expect, it, vi } from 'vitest';
import type { SecretStore } from '@fleetadlc/github';
import { bridgeHeaders, consoleLink, consoleUrlOf, signInLink } from './console-link.js';

const SECRET = '0123456789abcdef'.repeat(4);

function storeWith(values: Record<string, string>): SecretStore {
  return {
    get: async (ref) => values[ref] ?? null,
    set: async () => undefined,
    delete: async () => undefined,
    list: async () => Object.keys(values),
  };
}

describe('a sign-in link', () => {
  it('is the fixed vector the console checks, valid for an hour', () => {
    // The same vector as apps/console/src/lib/sign-in.test.ts, which verifies
    // it with Web Crypto: a link the CLI prints is one the console accepts.
    expect(signInLink(SECRET, 'http://127.0.0.1:47300', 1_800_000_000_000)).toBe(
      'http://127.0.0.1:47300/signin?token=1800003600.55e64a713ef5fed11eac66d38c157758eb45f2473d58705e088827f7e12b4835',
    );
  });

  it('never carries the secret itself', () => {
    expect(signInLink(SECRET, 'http://127.0.0.1:47300/')).not.toContain(SECRET);
    expect(signInLink(SECRET, 'http://127.0.0.1:47300/')).toMatch(/^http:\/\/127\.0\.0\.1:47300\/signin\?token=\d+\.[0-9a-f]{64}$/);
  });
});

describe('fleetadlc console-link', () => {
  it('prints a link to the console of this install', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const link = await consoleLink(57300, storeWith({ 'console-api-secret': SECRET }));
    expect(link.startsWith('http://127.0.0.1:57300/signin?token=')).toBe(true);
    vi.restoreAllMocks();
  });

  it('says to start the install when it has no secret yet', async () => {
    await expect(consoleLink(47300, storeWith({}))).rejects.toThrow(/fleetadlc up/);
  });

  it('takes the console from FLEETADLC_CONSOLE_URL, else the port, else the default', () => {
    expect(consoleUrlOf(57300, { FLEETADLC_CONSOLE_URL: 'http://mybox.lan:47300' })).toBe('http://mybox.lan:47300');
    expect(consoleUrlOf(57300, {})).toBe('http://127.0.0.1:57300');
    expect(consoleUrlOf(undefined, {})).toBe('http://127.0.0.1:47300');
  });
});

describe('what the CLI sends the bridge', () => {
  it('carries the console secret from the store', async () => {
    const headers = await bridgeHeaders(storeWith({ 'console-api-secret': SECRET }));
    expect(headers['x-fleetadlc-console-secret']).toBe(SECRET);
    expect(headers['x-fleetadlc-identity']).toBeTruthy();
  });
});
