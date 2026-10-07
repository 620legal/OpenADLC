import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startWebhookGateway, WEBHOOK_BODY_MAX, type WebhookGateway } from './webhook-gateway.js';

interface Received {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let bridge: Server;
let bridgePort: number;
let seen: Received[];
let gateway: WebhookGateway;

beforeEach(async () => {
  seen = [];
  bridge = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      seen.push({
        method: incoming.method ?? '',
        path: incoming.url ?? '',
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, event: incoming.headers['x-github-event'] }));
    });
  });
  await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  bridgePort = (bridge.address() as AddressInfo).port;
  gateway = await startWebhookGateway({ bridgePort });
});

afterEach(async () => {
  await gateway.close();
  await new Promise<void>((resolve) => bridge.close(() => resolve()));
});

function post(path: string, headers: Record<string, string>, body = '{}'): Promise<Response> {
  return fetch(`http://127.0.0.1:${gateway.port}${path}`, { method: 'POST', headers, body });
}

describe('the one route a tunnel exposes', () => {
  it('forwards a signed delivery to the bridge and relays the answer', async () => {
    const response = await post(
      '/webhooks/github',
      {
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-github-delivery': 'abc-123',
        'x-hub-signature-256': 'sha256=whatever',
      },
      '{"action":"created"}',
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, event: 'issue_comment' });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe('/webhooks/github');
    expect(seen[0]?.body).toBe('{"action":"created"}');
    // The signature has to survive the hop, or nothing verifies.
    expect(seen[0]?.headers['x-hub-signature-256']).toBe('sha256=whatever');
    expect(seen[0]?.headers['x-github-delivery']).toBe('abc-123');
  });

  it('strips the identity header, which the bridge would otherwise believe', async () => {
    // The whole reason this gateway exists. In local mode the bridge takes this
    // header at face value; a tunnel pointed at the bridge would let a stranger
    // answer a gate as the operator.
    await post('/webhooks/github', {
      'content-type': 'application/json',
      'x-github-event': 'issues',
      'x-fleetadlc-identity': 'owner@example.test',
    });

    expect(seen[0]?.headers['x-fleetadlc-identity']).toBeUndefined();
  });

  it('strips the headers a proxied identity would arrive in', async () => {
    await post('/webhooks/github', {
      'content-type': 'application/json',
      'x-github-event': 'issues',
      'x-goog-authenticated-user-email': 'accounts.google.com:somebody@example.com',
      'x-goog-iap-jwt-assertion': 'forged',
      authorization: 'Bearer stolen',
      cookie: 'session=stolen',
    });

    const headers = seen[0]?.headers ?? {};
    expect(headers['x-goog-authenticated-user-email']).toBeUndefined();
    expect(headers['x-goog-iap-jwt-assertion']).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
  });

  it('refuses every other path, without saying what else is there', async () => {
    for (const path of ['/v1/install', '/internal/dispatch/lease', '/healthz', '/', '/webhooks/github/x', '/webhooks/githubx']) {
      const response = await post(path, { 'content-type': 'application/json' });
      expect(response.status, path).toBe(404);
    }
    expect(seen).toEqual([]);
  });

  it('refuses a path that climbs out of the allowed one', async () => {
    // Sent as written: fetch would resolve the `..` before it left, and the
    // gateway would never see it.
    const status = await new Promise<number>((resolve, reject) => {
      const sending = httpRequest({ host: '127.0.0.1', port: gateway.port, method: 'POST', path: '/webhooks/github/../v1/install' }, (answer) => {
        answer.resume();
        answer.on('end', () => resolve(answer.statusCode ?? 0));
      });
      sending.on('error', reject);
      sending.end('{}');
    });
    expect(status).toBe(404);
    expect(seen).toEqual([]);
  });

  it('allows a query string on the allowed path, and drops it', async () => {
    // The path is compared without its query, so this one is allowed through —
    // which is correct, GitHub sends none and the handler reads none.
    const response = await post('/webhooks/github?x=1', {
      'content-type': 'application/json',
      'x-github-event': 'issues',
    });
    expect(response.status).toBe(200);
    expect(seen[0]?.path).toBe('/webhooks/github');
  });

  it('refuses methods other than POST', async () => {
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      const response = await fetch(`http://127.0.0.1:${gateway.port}/webhooks/github`, { method });
      expect(response.status, method).toBe(404);
    }
    expect(seen).toEqual([]);
  });

  it('answers 502 when the bridge is not listening, a failure the bridge has redelivered once it is back', async () => {
    await new Promise<void>((resolve) => bridge.close(() => resolve()));

    const response = await post('/webhooks/github', {
      'content-type': 'application/json',
      'x-github-event': 'issues',
    });

    expect(response.status).toBe(502);
  });
});

describe('a delivery larger than GitHub sends', () => {
  it('is refused on its declared length, before any of it is read', async () => {
    // Declares more than the cap and sends only a few bytes: an answer that
    // comes back at all came back without waiting for the rest.
    const status = await new Promise<number>((resolve, reject) => {
      const sending = httpRequest(
        {
          host: '127.0.0.1',
          port: gateway.port,
          method: 'POST',
          path: '/webhooks/github',
          headers: { 'content-type': 'application/json', 'content-length': String(WEBHOOK_BODY_MAX + 1) },
        },
        (answer) => {
          resolve(answer.statusCode ?? 0);
          answer.resume();
          sending.destroy();
        },
      );
      sending.on('error', (error) => {
        if (!sending.destroyed) reject(error);
      });
      sending.write('{}');
    });
    expect(status).toBe(413);
    expect(seen).toHaveLength(0);
  });
});
