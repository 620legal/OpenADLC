import { afterEach, describe, expect, it, vi } from 'vitest';

/** A page of the board's event history, forwarded as the person asked it. */

vi.mock('@/lib/api', () => ({ BRIDGE_URL: 'http://bridge.test' }));
vi.mock('@/lib/identity', () => ({ identityHeadersFrom: () => ({ 'x-openadlc-user': 'alexsmith' }) }));

import { GET } from './route';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the board event history proxy', () => {
  it('forwards the filters, cursor and limit, as the person looking', async () => {
    const fetchMock = vi.fn(async () => new Response('{"events":[],"next":null,"floor":"2026-10-27T00:00:00.000Z"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const response = await GET(new Request('http://console.test/api/board/events?repo=web%20app&bot=builder&before=2026-11-02T00%3A00%3A00.000Z~task.started%3At1&limit=100&other=x'));
    expect(fetchMock).toHaveBeenCalledWith(
      'http://bridge.test/v1/board/events/history?repo=web+app&bot=builder&before=2026-11-02T00%3A00%3A00.000Z%7Etask.started%3At1&limit=100',
      expect.objectContaining({ cache: 'no-store', headers: expect.objectContaining({ 'x-openadlc-user': 'alexsmith' }) }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ events: [], next: null, floor: '2026-10-27T00:00:00.000Z' });
  });

  it('asks for the newest page when nothing is named', async () => {
    const fetchMock = vi.fn(async () => new Response('{"events":[]}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await GET(new Request('http://console.test/api/board/events'));
    expect(fetchMock).toHaveBeenCalledWith('http://bridge.test/v1/board/events/history', expect.anything());
  });

  it('passes the bridge’s refusal on in its own words', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"limit must be a whole number from 1 to 200"}', { status: 400 })));
    const response = await GET(new Request('http://console.test/api/board/events?limit=0'));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'limit must be a whole number from 1 to 200' });
  });

  it('says the bridge is not answering, rather than throwing, when it is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));
    const response = await GET(new Request('http://console.test/api/board/events'));
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toBeTruthy();
  });
});
