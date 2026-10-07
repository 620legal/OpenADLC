import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rotateAttribution } from './attribution.js';

const ports = { console: 47300, bridge: 47311, hostd: 47312, postgres: 47432 };
// The bridge serves `/v1` only beside the console secret, which the CLI reads from the store.
const store = {
  get: async (ref: string) => (ref === 'console-api-secret' ? 'c'.repeat(64) : null),
  set: async () => undefined,
  delete: async () => undefined,
  list: async () => [],
};

describe('fleetadlc attribution rotate', () => {
  let printed: string[];

  beforeEach(() => {
    printed = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => void printed.push(line));
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  const answering = (body: unknown, status = 200) => {
    const asked: { url: string; method: string | undefined; body: unknown; secret: string | undefined }[] = [];
    const call = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      asked.push({
        url: String(input),
        method: init?.method,
        body: JSON.parse(String(init?.body)),
        secret: (init?.headers as Record<string, string>)['x-fleetadlc-console-secret'],
      });
      return new Response(JSON.stringify(body), { status });
    });
    return { asked, call: call as unknown as typeof fetch };
  };

  it('asks the running bridge, and says how long the old key keeps checking and to take a new backup', async () => {
    const bridge = answering({ kid: 'newkid01', retiredKid: 'oldkid01', oldKeyChecksUntil: '2026-11-03T00:00:00.000Z' });

    expect(await rotateAttribution({ ports }, { dropOld: false }, { fetch: bridge.call, store })).toBe(true);

    expect(bridge.asked).toEqual([{ url: 'http://127.0.0.1:47311/v1/attribution/rotate', method: 'POST', body: { dropOld: false }, secret: 'c'.repeat(64) }]);
    const said = printed.join('\n');
    expect(said).toContain('newkid01');
    expect(said).toContain('key oldkid01 keeps checking posts signed before now until 2026-11-03');
    expect(said).toContain('take a new backup');
    expect(process.exitCode).toBeUndefined();
  });

  it('says the old keys no longer check anything after a leak, and what that does to reviews already posted', async () => {
    const bridge = answering({ kid: 'newkid01', retiredKid: 'oldkid01', oldKeyChecksUntil: null });

    expect(await rotateAttribution({ ports }, { dropOld: true }, { fetch: bridge.call, store })).toBe(true);

    expect(bridge.asked[0]?.body).toEqual({ dropOld: true });
    const said = printed.join('\n');
    expect(said).toContain('key oldkid01 and every key before it no longer check anything');
    expect(said).toContain('wait for a fresh lead review');
    expect(said).toContain('take a new backup');
  });

  it('exits 1 and says to start the install when the bridge does not answer', async () => {
    const call = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:47311');
    }) as unknown as typeof fetch;

    expect(await rotateAttribution({ ports }, { dropOld: false }, { fetch: call, store })).toBe(false);

    expect(process.exitCode).toBe(1);
    expect(printed.join('\n')).toContain('the bridge is not answering on 127.0.0.1:47311; start the install with fleetadlc up and run this again');
  });

  it('exits 1 with the bridge’s own words when it refuses', async () => {
    const bridge = answering({ error: 'this bridge signs nothing' }, 503);

    expect(await rotateAttribution({ ports }, { dropOld: false }, { fetch: bridge.call, store })).toBe(false);

    expect(process.exitCode).toBe(1);
    expect(printed.join('\n')).toContain('this bridge signs nothing');
  });
});
