import { afterEach, describe, expect, it, vi } from 'vitest';

/** The board's live events, streamed through as the person asked for them. */

vi.mock('@/lib/api', () => ({ BRIDGE_URL: 'http://bridge.test' }));
vi.mock('@/lib/identity', () => ({ identityHeadersFrom: () => ({ 'x-openadlc-user': 'alexsmith' }) }));

import { GET, dynamic, fetchCache } from './route';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the board event stream proxy', () => {
  it('streams the bridge’s events through unbuffered, as the person looking', async () => {
    const frame = 'event: board\nid: task.started:t1\ndata: {"id":"task.started:t1"}\n\n';
    const fetchMock = vi.fn(async () => new Response(frame, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetchMock);
    const response = await GET(new Request('http://console.test/api/board/events/stream'));
    expect(fetchMock).toHaveBeenCalledWith(
      'http://bridge.test/v1/board/events',
      expect.objectContaining({ cache: 'no-store', headers: expect.objectContaining({ 'x-openadlc-user': 'alexsmith', accept: 'text/event-stream' }) }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(await response.text()).toBe(frame);
    // Cached, a stream arrives once, at its end.
    expect(dynamic).toBe('force-dynamic');
    expect(fetchCache).toBe('force-no-store');
  });

  it('answers 502 when the bridge is down, and passes a refusal of the person on', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));
    expect((await GET(new Request('http://console.test/api/board/events/stream'))).status).toBe(502);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"sign in"}', { status: 401 })));
    expect((await GET(new Request('http://console.test/api/board/events/stream'))).status).toBe(401);
  });
});
