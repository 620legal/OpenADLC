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

beforeAll(async () => {
  // Answers nothing, ever: GitHub hanging behind the bridge. Except who is
  // asking, which it answers slowly.
  bridge = createServer((request, response) => {
    // A running bridge that refuses, with its reason.
    if (request.url === '/v1/costs') {
      response.writeHead(500, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ error: 'the database is not answering' }, null, 2));
    }
    if (request.url !== '/v1/me') return;
    setTimeout(() => response.end(JSON.stringify({ email: 'bob@exampleco.com', role: 'user', ...mode })), 2_000);
  });
  await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  process.env.FLEETADLC_BRIDGE_URL = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
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
});
