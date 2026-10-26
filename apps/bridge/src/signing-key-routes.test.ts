import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitHubApiError } from '@openadlc/github';
import type { Bot } from '@openadlc/shared';
import { Router } from './router.js';
import { registerSigningKeyRoutes, type SigningKeyRouteDeps } from './signing-key-routes.js';

/**
 * The signing-key card's buttons: Dismiss records a key as used elsewhere,
 * its undo takes that back, and Revoke deletes the key from the bot's GitHub
 * account with the bot's own sign-in.
 */

function bot(partial: Partial<Bot> & { id: string; name: string; slot: string; role: Bot['role'] }): Bot {
  return {
    displayName: partial.name,
    engine: 'claude',
    model: 'newest:opus',
    githubLogin: partial.name,
    hostId: null,
    container: `bot-${partial.name}`,
    status: 'running',
    skills: [],
    sidecarDb: false,
    modelAccountId: null,
    modelSetAt: null,
    ...partial,
  };
}

const BUILDER = bot({ id: 'bot-builder', name: 'openadlc-vega-janedoe', slot: 'builder', role: 'implement', githubLogin: 'OpenADLC-Vega-Janedoe' });

let server: Server;
let url: string;
let marked: [string, number, string, string | null][];
let unmarked: [string, number][];
let deleted: number[];
let audited: { actor: string; action: string; target: string; payload?: Record<string, unknown> }[];
let rechecks: number;
let deps: SigningKeyRouteDeps;

beforeEach(async () => {
  marked = [];
  unmarked = [];
  deleted = [];
  audited = [];
  rechecks = 0;
  deps = {
    crew: async () => [BUILDER],
    asBot: async () => ({
      deleteSshSigningKey: async (id: number) => {
        deleted.push(id);
      },
    }),
    signInKind: async () => 'refresh',
    scopesOf: async () => [],
    markExternal: async (login, keyId, by, title) => void marked.push([login, keyId, by, title]),
    unmarkExternal: async (login, keyId) => {
      unmarked.push([login, keyId]);
      return true;
    },
    audit: async (entry) => void audited.push(entry),
    recheck: () => {
      rechecks += 1;
    },
  };
  const router = new Router();
  registerSigningKeyRoutes(router, deps);
  server = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const post = (path: string, body?: unknown) =>
  fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('dismissing a key as used elsewhere', () => {
  it('records it with the title the card showed, audits who said so, and asks the check again', async () => {
    const response = await post('/v1/signing-keys/openadlc-vega-janedoe/keys/6/dismiss', { title: 'laptop' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ dismissed: 6 });
    expect(marked).toEqual([['openadlc-vega-janedoe', 6, expect.any(String), 'laptop']]);
    expect(audited).toMatchObject([{ action: 'signing_key.dismissed', target: 'openadlc-vega-janedoe', payload: { keyId: 6, title: 'laptop' } }]);
    expect(rechecks).toBe(1);
  });

  it('records a key with no title all the same', async () => {
    const response = await post('/v1/signing-keys/openadlc-vega-janedoe/keys/6/dismiss', {});
    expect(response.status).toBe(200);
    expect(marked).toEqual([['openadlc-vega-janedoe', 6, expect.any(String), null]]);
  });

  it('refuses a key id that is not GitHub’s numeric id', async () => {
    const response = await post('/v1/signing-keys/openadlc-vega-janedoe/keys/not-a-key/dismiss', {});
    expect(response.status).toBe(400);
    expect(marked).toEqual([]);
  });
});

describe('the undo', () => {
  it('forgets the dismissal, audits it, and asks the check again', async () => {
    const response = await fetch(`${url}/v1/signing-keys/openadlc-vega-janedoe/keys/6/dismiss`, { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect(unmarked).toEqual([['openadlc-vega-janedoe', 6]]);
    expect(audited).toMatchObject([{ action: 'signing_key.undismissed', target: 'openadlc-vega-janedoe' }]);
    expect(rechecks).toBe(1);
  });

  it('says when nothing was dismissed for that key, and audits nothing', async () => {
    deps.unmarkExternal = async () => false;
    const response = await fetch(`${url}/v1/signing-keys/openadlc-vega-janedoe/keys/6/dismiss`, { method: 'DELETE' });
    expect(response.status).toBe(404);
    expect(audited).toEqual([]);
  });
});

describe('revoking a key from the bot’s account', () => {
  it('deletes it as the bot — found by its login, whatever the case — audits it, and asks the check again', async () => {
    const response = await post('/v1/signing-keys/OPENADLC-VEGA-JANEDOE/keys/6/revoke');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: 6 });
    expect(deleted).toEqual([6]);
    expect(audited).toMatchObject([{ action: 'signing_key.revoked', target: 'OPENADLC-VEGA-JANEDOE', payload: { keyId: 6 } }]);
    expect(rechecks).toBe(1);
  });

  it('says when no seat is on that account', async () => {
    const response = await post('/v1/signing-keys/somebody-else/keys/6/revoke');
    expect(response.status).toBe(404);
    expect(deleted).toEqual([]);
  });

  it('refuses a static token without the scope deleting needs, before asking GitHub', async () => {
    deps.signInKind = async () => 'static';
    const response = await post('/v1/signing-keys/openadlc-vega-janedoe/keys/6/revoke');
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('admin:ssh_signing_key');
    expect(deleted).toEqual([]);
  });

  it('lets a static token with admin:ssh_signing_key delete', async () => {
    deps.signInKind = async () => 'static';
    deps.scopesOf = async () => ['repo', 'admin:ssh_signing_key'];
    const response = await post('/v1/signing-keys/openadlc-vega-janedoe/keys/6/revoke');
    expect(response.status).toBe(200);
    expect(deleted).toEqual([6]);
  });

  it('says what the app needs when GitHub refuses the delete', async () => {
    deps.asBot = async () => ({
      deleteSshSigningKey: async () => {
        throw new GitHubApiError(403, '/user/ssh_signing_keys/6', 'Resource not accessible by integration');
      },
    });
    const response = await post('/v1/signing-keys/openadlc-vega-janedoe/keys/6/revoke');
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('SSH signing keys');
    expect(audited).toEqual([]);
  });

  it('reads a key already gone as revoked: that is what revoking was for', async () => {
    deps.asBot = async () => ({
      deleteSshSigningKey: async () => {
        throw new GitHubApiError(404, '/user/ssh_signing_keys/6', 'Not Found');
      },
    });
    const response = await post('/v1/signing-keys/openadlc-vega-janedoe/keys/6/revoke');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: 6, alreadyGone: true });
    expect(audited).toMatchObject([{ action: 'signing_key.revoked', payload: { keyId: 6, alreadyGone: true } }]);
  });

  it('says when the bot holds no working sign-in to delete with', async () => {
    deps.asBot = async () => null;
    const response = await post('/v1/signing-keys/openadlc-vega-janedoe/keys/6/revoke');
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('no working sign-in');
  });
});
