import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountLinkedElsewhere } from '@openadlc/db';
import type { DeviceCode, UserToken } from '@openadlc/github';
import { PersonFlows, registerPersonGitHubRoutes, withoutToken, type PersonGitHubDeps } from './person-github.js';
import { Router } from './router.js';

/**
 * A person links their own GitHub account by signing in as it: a crew login is
 * refused, so is an account another person linked, and the token that proved
 * it is revoked and kept nowhere.
 */

const TOKEN = 'ghu_link_once';

function deps(overrides: Partial<PersonGitHubDeps> = {}) {
  const rows = new Map<string, { githubLogin: string; githubUserId: number }>();
  const audits: { action: string; payload: Record<string, unknown> }[] = [];
  const revoked: string[] = [];
  const made: PersonGitHubDeps = {
    clientId: async () => 'Iv1.client',
    clientSecret: async () => 'secret',
    requestCode: async (): Promise<DeviceCode> => ({ deviceCode: 'dev', userCode: 'WXYZ-0001', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 }),
    pollToken: async (): Promise<UserToken> => ({ accessToken: TOKEN, expiresAt: null, refreshToken: null, refreshExpiresAt: null, scopes: [], tokenType: 'bearer' }),
    viewer: async () => ({ login: 'janedoe', id: 583231 }),
    revoke: async ({ accessToken }) => (revoked.push(accessToken), true),
    isCrew: async (login) => login === 'fleet-atlas-orzelig',
    store: {
      link: async (input) => {
        for (const [identity, row] of rows) if (row.githubUserId === input.githubUserId && identity !== input.identity) throw new AccountLinkedElsewhere(input.githubLogin);
        rows.set(input.identity, { githubLogin: input.githubLogin, githubUserId: input.githubUserId });
        return { ...input, linkedAt: '' };
      },
      unlink: async (identity) => rows.delete(identity),
      ofIdentity: async (identity) => {
        const row = rows.get(identity);
        return row ? { identity, ...row, linkedAt: '' } : null;
      },
    },
    audit: async (entry) => void audits.push(entry),
    ...overrides,
  };
  return { made, rows, audits, revoked };
}

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  vi.restoreAllMocks();
});

async function serve(given: PersonGitHubDeps) {
  const router = new Router(undefined, undefined, undefined, async () => 'user');
  const flows = registerPersonGitHubRoutes(router, given, new PersonFlows(given));
  server = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const as = (identity: string, method = 'GET') => ({ method, headers: { 'x-openadlc-identity': identity, 'content-type': 'application/json' }, ...(method === 'GET' ? {} : { body: '{}' }) });
  return { url, as, flows };
}

describe('linking a person’s GitHub account', () => {
  it('keeps the login and id of the account that approved, revokes the token, and audits it', async () => {
    const { made, rows, audits, revoked } = deps();
    const { url, as, flows } = await serve(made);
    const started = await (await fetch(`${url}/v1/me/github`, as('jane@example.com', 'POST'))).json();
    expect(started).toEqual({ flowId: expect.any(String), userCode: 'WXYZ-0001', verificationUri: 'https://github.com/login/device', expiresInSeconds: expect.any(Number) });
    await flows.lastRun;
    // Only the person who started it reads how it went.
    expect(await (await fetch(`${url}/v1/me/github/flows/${started.flowId}`, as('bob@example.com'))).json()).toEqual({ state: 'none' });
    expect(await (await fetch(`${url}/v1/me/github/flows/${started.flowId}`, as('jane@example.com'))).json()).toEqual({ state: 'done', login: 'janedoe' });
    expect(rows.get('jane@example.com')).toEqual({ githubLogin: 'janedoe', githubUserId: 583231 });
    expect(revoked).toEqual([TOKEN]);
    expect(audits).toEqual([{ actor: 'jane@example.com', action: 'person.github_linked', target: 'jane@example.com', payload: { login: 'janedoe', userId: 583231 } }]);
    expect(JSON.stringify(audits)).not.toContain(TOKEN);
  });

  it('refuses a login the crew uses, and keeps nothing', async () => {
    const { made, rows, revoked } = deps({ viewer: async () => ({ login: 'fleet-atlas-orzelig', id: 9 }) });
    const { url, as, flows } = await serve(made);
    const started = await (await fetch(`${url}/v1/me/github`, as('jane@example.com', 'POST'))).json();
    await flows.lastRun;
    const said = await (await fetch(`${url}/v1/me/github/flows/${started.flowId}`, as('jane@example.com'))).json();
    expect(said).toEqual({ state: 'failed', error: expect.stringMatching(/account the crew uses/) });
    expect(rows.size).toBe(0);
    expect(revoked).toEqual([TOKEN]);
  });

  it('refuses an account another person has linked', async () => {
    const { made, rows } = deps();
    rows.set('bob@example.com', { githubLogin: 'janedoe', githubUserId: 583231 });
    const { url, as, flows } = await serve(made);
    const started = await (await fetch(`${url}/v1/me/github`, as('jane@example.com', 'POST'))).json();
    await flows.lastRun;
    const said = await (await fetch(`${url}/v1/me/github/flows/${started.flowId}`, as('jane@example.com'))).json();
    expect(said).toEqual({ state: 'failed', error: expect.stringMatching(/already linked to another person/) });
    expect(rows.has('jane@example.com')).toBe(false);
  });

  it('unlinks the person’s own row, and audits what it was', async () => {
    const { made, rows, audits } = deps();
    rows.set('jane@example.com', { githubLogin: 'janedoe', githubUserId: 583231 });
    rows.set('bob@example.com', { githubLogin: 'bob', githubUserId: 2 });
    const { url, as } = await serve(made);
    expect(await (await fetch(`${url}/v1/me/github`, as('jane@example.com', 'DELETE'))).json()).toEqual({ unlinked: true });
    expect([...rows.keys()]).toEqual(['bob@example.com']);
    expect(audits).toEqual([{ actor: 'jane@example.com', action: 'person.github_unlinked', target: 'jane@example.com', payload: { login: 'janedoe', userId: 583231 } }]);
  });

  it('says what to do when the install has no app client id', async () => {
    const { made } = deps({ clientId: async () => null });
    const { url, as } = await serve(made);
    const response = await fetch(`${url}/v1/me/github`, as('jane@example.com', 'POST'));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/Create the app/);
  });

  it('does not revoke without a client secret: the token then expires on GitHub', async () => {
    const { made, revoked } = deps({ clientSecret: async () => null });
    const { url, as, flows } = await serve(made);
    await fetch(`${url}/v1/me/github`, as('jane@example.com', 'POST'));
    await flows.lastRun;
    expect(revoked).toEqual([]);
  });
});

describe('withoutToken', () => {
  it('takes every copy of the token out of a message', () => {
    expect(withoutToken(`a ${TOKEN} b ${TOKEN}`, TOKEN)).toBe('a [token] b [token]');
    expect(withoutToken('nothing here', null)).toBe('nothing here');
  });
});
