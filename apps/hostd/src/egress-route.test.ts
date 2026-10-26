import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@openadlc/db', () => ({
  audit: vi.fn(async () => undefined),
  bots: { listBots: vi.fn(async () => []), getBotByName: vi.fn(async () => null) },
  costs: {},
  sessions: {},
  tasks: { getTask: vi.fn(async () => null) },
}));

import { EgressListRefused } from './egress.js';

/**
 * The host's egress as it reaches the wire: behind the install's secret like
 * every other route, asking the proxy about names, and writing the list only
 * from the list it is given.
 */

const INSTALL_SECRET = 'install-secret-for-the-test';
const PLATFORM = { 'x-openadlc-internal-secret': INSTALL_SECRET, 'content-type': 'application/json' };

const probe = {
  ask: vi.fn(async (hosts: readonly string[]) => {
    if (hosts.length > 20) throw new EgressListRefused('ask about at most 20 names at once, not 21: ask again in batches', 400);
    return { proxied: true, hosts: hosts.map((host) => ({ host, allowed: false as const, status: 403 })) };
  }),
};
const list = {
  available: true,
  apply: vi.fn(async (hosts: readonly string[]) => {
    if (hosts.includes('10.0.0.5')) throw new EgressListRefused('10.0.0.5 is an address', 400);
    return [...hosts];
  }),
};

let server: { close: () => Promise<void>; call: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: Record<string, unknown> }> };

beforeEach(async () => {
  probe.ask.mockClear();
  list.apply.mockClear();
  const { createHostdServer } = await import('./server.js');
  const { RegistryCredentials } = await import('./registry.js');
  const { AttachTokens } = await import('./attach-tokens.js');
  const http = createHostdServer({
    config: { hostName: 'test', driver: 'docker', loginRoot: '/nowhere' } as never,
    driver: { kind: 'docker' } as never,
    runner: { activeTaskIds: () => [], sessionOf: () => null } as never,
    attachTokens: new AttachTokens(),
    registry: new RegistryCredentials(null),
    perTaskCapUsd: 10,
    secret: async () => INSTALL_SECRET,
    egress: { probe, list },
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  server = {
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
    async call(method, path, body, headers = PLATFORM) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
  };
});

afterEach(async () => {
  await server.close();
});

describe('the egress routes', () => {
  it('refuse a caller without the install’s secret', async () => {
    expect((await server.call('GET', '/egress?host=acme.example', undefined, {})).status).toBe(401);
    expect((await server.call('PUT', '/egress/hosts', { hosts: ['acme.example'] }, {})).status).toBe(401);
    expect(probe.ask).not.toHaveBeenCalled();
    expect(list.apply).not.toHaveBeenCalled();
  });

  it('ask the proxy about each name, and say whether it reads Settings’ list, without writing it', async () => {
    const { status, body } = await server.call('GET', '/egress?host=web-1234-uc.a.run.app&host=acme.example');
    expect(status).toBe(200);
    expect(body).toEqual({
      proxied: true,
      settingsList: true,
      hosts: [
        { host: 'web-1234-uc.a.run.app', allowed: false, status: 403 },
        { host: 'acme.example', allowed: false, status: 403 },
      ],
    });
    expect(list.apply).not.toHaveBeenCalled();
  });

  it('say an ask of more names than the probe takes at once is refused, rather than answer some of them', async () => {
    const query = Array.from({ length: 21 }, (_, index) => `host=web${index}.acme.example`).join('&');
    expect(await server.call('GET', `/egress?${query}`)).toEqual({ status: 400, body: { error: 'ask about at most 20 names at once, not 21: ask again in batches' } });
  });

  it('write the list they are given, and say a refusal in its own words and status', async () => {
    expect(await server.call('PUT', '/egress/hosts', { hosts: ['acme.example'] })).toEqual({ status: 200, body: { hosts: ['acme.example'] } });
    expect(await server.call('PUT', '/egress/hosts', { hosts: ['10.0.0.5'] })).toEqual({ status: 400, body: { error: '10.0.0.5 is an address' } });
    expect((await server.call('PUT', '/egress/hosts', { hosts: 'acme.example' })).status).toBe(400);
  });
});
