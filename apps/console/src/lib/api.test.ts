import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('./identity', () => ({ identityHeaders: async () => ({}) }));

/**
 * Settings reads four of its sections on the server so the page is drawn at
 * its full height. One of them is several calls to GitHub; a bridge that is
 * waiting on a slow GitHub must not hold the page.
 */
let bridge: Server;
/** What `/v1/me` adds for the mode it runs in; nothing, as a bridge older than the console does. */
let mode: Record<string, string> = {};
/** What `/v1/brand` answers: a status and a body. */
let brand: { status: number; body: unknown } = { status: 200, body: { name: null, logo: null } };
/** What `/healthz` answers: a status and a body. */
let health: { status: number; body: unknown } = { status: 200, body: { ok: true } };

beforeAll(async () => {
  // Answers nothing, ever: GitHub hanging behind the bridge. Except who is
  // asking, which it answers slowly.
  bridge = createServer((request, response) => {
    // A running bridge that refuses, with its reason.
    if (request.url === '/v1/costs') {
      response.writeHead(500, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ error: 'the database is not answering' }, null, 2));
    }
    if (request.url === '/healthz') {
      response.writeHead(health.status, { 'content-type': 'application/json' });
      return response.end(JSON.stringify(health.body));
    }
    if (request.url === '/v1/brand') {
      response.writeHead(brand.status, { 'content-type': 'application/json' });
      return response.end(JSON.stringify(brand.body));
    }
    if (request.url !== '/v1/me') return;
    setTimeout(() => response.end(JSON.stringify({ email: 'bob@exampleco.com', role: 'user', ...mode })), 2_000);
  });
  await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  process.env.OPENADLC_BRIDGE_URL = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
});

afterAll(async () => {
  bridge.closeAllConnections();
  await new Promise<void>((resolve) => bridge.close(() => resolve()));
});

describe('a settings section read on the server', () => {
  it('gives up after SECTION_READ_MS, so the section reads its own instead', async () => {
    const { api, SECTION_READ_MS } = await import('./api');
    const started = Date.now();
    await expect(api.installations()).rejects.toThrow();
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(SECTION_READ_MS - 50);
    expect(took).toBeLessThan(SECTION_READ_MS + 1_000);
  });
});

describe('who is asking, read for the layout', () => {
  it('waits out a bridge slower than a section read, rather than drawing the page as an admin’s', async () => {
    const { readMe } = await import('./api');
    expect(await readMe()).toEqual({ known: true, email: 'bob@exampleco.com', role: 'user', identityMode: 'local' });
  });

  it('carries the identity mode the bridge says', async () => {
    const { readMe } = await import('./api');
    mode = { identityMode: 'iap' };
    try {
      expect(await readMe()).toMatchObject({ known: true, identityMode: 'iap' });
    } finally {
      mode = {};
    }
  });
});

describe('a read the bridge answered with an error', () => {
  it('keeps the status and the bridge’s own words, so a page does not call a running bridge unreachable', async () => {
    const { api } = await import('./api');
    const { BridgeAnswered } = await import('./bridge-answered');
    const error = await api.costs().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(BridgeAnswered);
    expect(error).toMatchObject({ status: 500, said: 'the database is not answering', message: 'the bridge answered 500 to /v1/costs: the database is not answering' });
  });

  // After OrbStack restarted and left `openadlc-db` down, every page said only
  // what the driver said, `connect ECONNREFUSED 127.0.0.1:47432`.
  it('carries the bridge’s line from /healthz when its database is down, which names it and how to start it', async () => {
    const { api } = await import('./api');
    const { BridgeAnswered, DatabaseDown } = await import('./bridge-answered');
    const line = "the install's database (openadlc-db) isn't answering on 127.0.0.1:47432: start it with `docker start openadlc-db`, or run `openadlc up`";
    health = { status: 503, body: { ok: false, error: line, database: line } };
    try {
      const error = await api.costs().catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(DatabaseDown);
      // Still the bridge answering, for everything that tells that apart from no answer.
      expect(error).toBeInstanceOf(BridgeAnswered);
      expect(error).toMatchObject({ status: 500, said: line });
    } finally {
      health = { status: 200, body: { ok: true } };
    }
  });

  it('keeps the bridge’s own words when /healthz says nothing of the database, or cannot be read', async () => {
    const { api } = await import('./api');
    const { DatabaseDown } = await import('./bridge-answered');
    try {
      for (const answer of [{ status: 200, body: { ok: true } }, { status: 503, body: { ok: false } }, { status: 503, body: 'not json' }]) {
        health = answer;
        const error = await api.costs().catch((cause: unknown) => cause);
        expect(error).not.toBeInstanceOf(DatabaseDown);
        expect(error).toMatchObject({ status: 500, said: 'the database is not answering' });
      }
    } finally {
      health = { status: 200, body: { ok: true } };
    }
  });
});

describe('the console’s name and logo, read for the layout', () => {
  it('gives the name, and the logo’s address with its version, so a new logo is never an old one from the cache', async () => {
    const { readBrand } = await import('./api');
    brand = { status: 200, body: { name: 'Acme Legal', logo: { mediaType: 'image/png', version: '0123456789ab' } } };
    expect(await readBrand()).toEqual({ name: 'Acme Legal', logoUrl: '/api/brand/logo?v=0123456789ab' });
    brand = { status: 200, body: { name: null, logo: null } };
    expect(await readBrand()).toEqual({ name: null, logoUrl: null });
  });

  it('gives neither when the bridge refuses or answers nothing it can read, so the header still says OpenADLC', async () => {
    const { readBrand } = await import('./api');
    try {
      brand = { status: 500, body: { error: 'the database is not answering' } };
      expect(await readBrand()).toEqual({ name: null, logoUrl: null });
      brand = { status: 200, body: 'not json at all' };
      expect(await readBrand()).toEqual({ name: null, logoUrl: null });
    } finally {
      brand = { status: 200, body: { name: null, logo: null } };
    }
  });
});
