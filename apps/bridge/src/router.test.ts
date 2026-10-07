import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSON_BODY_MAX, Router } from './router.js';

let server: Server;
let url: string;

beforeEach(async () => {
  const router = new Router();
  router.get('/v1/bots/:name', async ({ params }) => ({ name: params.name }));
  router.post('/v1/notes', async ({ body }) => ({ got: await body() }));
  router.post('/v1/large', async ({ body }) => ({ got: Object.keys(await body<object>({ limit: 8 * 1024 * 1024 })).length }));
  server = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('a request the caller got wrong', () => {
  it('answers 400 for a path that is not valid percent-encoding, and logs no failure', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await fetch(`${url}/v1/bots/%E0%A4%A`);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('the path is not valid percent-encoding');
    expect(said).not.toHaveBeenCalled();
    said.mockRestore();
  });

  it('answers 400 for a body that is not JSON, and logs no failure', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await fetch(`${url}/v1/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('the body is not JSON');
    expect(said).not.toHaveBeenCalled();
    said.mockRestore();
  });

  it('still decodes a valid parameter, and reads an empty body as nothing', async () => {
    expect(await (await fetch(`${url}/v1/bots/a%20b`)).json()).toEqual({ name: 'a b' });
    expect(await (await fetch(`${url}/v1/notes`, { method: 'POST' })).json()).toEqual({ got: {} });
  });
});

/** A body of `bytes` in 1 MB chunks, sent chunked: no Content-Length declares it. */
function sendChunked(path: string, bytes: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const target = new URL(`${url}${path}`);
    const sending = httpRequest(
      { host: target.hostname, port: target.port, method: 'POST', path: target.pathname, headers: { 'content-type': 'application/json' } },
      (answer) => {
        resolve(answer.statusCode ?? 0);
        answer.resume();
      },
    );
    sending.on('error', reject);
    // A JSON string of spaces, so a body under the limit still parses.
    const total = Math.max(bytes - 2, 0);
    sending.write('"');
    let sent = 0;
    const more = (): void => {
      while (sent < total) {
        const size = Math.min(1024 * 1024, total - sent);
        sent += size;
        if (!sending.write(Buffer.alloc(size, 0x20))) return void sending.once('drain', more);
      }
      sending.end('"');
    };
    more();
  });
}

describe('a body larger than a route takes', () => {
  it('answers 413 past the default limit, though the body declared no length', async () => {
    expect(await sendChunked('/v1/notes', JSON_BODY_MAX + 1024 * 1024)).toBe(413);
  });

  it('still reads a body under the default limit', async () => {
    expect(await sendChunked('/v1/notes', 1024 * 1024)).toBe(200);
  });

  it('reads past the default limit where the route names a larger one', async () => {
    expect(await sendChunked('/v1/large', JSON_BODY_MAX + 1024 * 1024)).toBe(200);
  });
});

describe('who a route that acts for no person is called by', () => {
  // These routes skip the resolver, and took the name in a request's headers
  // at its word, on a cloud install too.
  it('is a fixed name on a router with a resolver, whatever the headers say', async () => {
    const { identityFromConfig } = await import('./identity.js');
    const router = new Router(identityFromConfig('iap', '/projects/1/global/backendServices/2'));
    const heard: string[] = [];
    for (const path of ['/webhooks/github', '/internal/events', '/healthz']) {
      router.post(path, async ({ identity }) => void heard.push(identity));
    }
    const own = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => own.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(own.address() as AddressInfo).port}`;
    try {
      const headers = { 'x-goog-authenticated-user-email': 'accounts.google.com:admin@example.com', 'x-fleetadlc-identity': 'admin@example.com' };
      for (const path of ['/webhooks/github', '/internal/events', '/healthz']) {
        expect((await fetch(`${base}${path}`, { method: 'POST', headers })).status).toBe(200);
      }
      expect(heard).toEqual(['github', 'internal', 'internal']);
    } finally {
      await new Promise<void>((resolve) => own.close(() => resolve()));
    }
  });
});
