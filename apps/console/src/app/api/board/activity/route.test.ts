import { afterEach, describe, expect, it, vi } from 'vitest';

/** The board's few-second read of its running cards, forwarded as the person asked it. */

vi.mock('@/lib/api', () => ({ BRIDGE_URL: 'http://bridge.test' }));
vi.mock('@/lib/identity', () => ({ identityHeadersFrom: () => ({ 'x-openadlc-user': 'alexsmith' }) }));

import { GET } from './route';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the board activity proxy', () => {
  it('forwards the read for the repository the board shows, as the person looking', async () => {
    const fetchMock = vi.fn(async () => new Response('{"running":1,"cards":[]}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const response = await GET(new Request('http://console.test/api/board/activity?repo=web%20app'));
    expect(fetchMock).toHaveBeenCalledWith(
      'http://bridge.test/v1/board/activity?repo=web%20app',
      expect.objectContaining({ cache: 'no-store', headers: expect.objectContaining({ 'x-openadlc-user': 'alexsmith' }) }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ running: 1, cards: [] });
  });

  it('reads every repository when the board names none', async () => {
    const fetchMock = vi.fn(async () => new Response('{"running":0,"cards":[]}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await GET(new Request('http://console.test/api/board/activity'));
    expect(fetchMock).toHaveBeenCalledWith('http://bridge.test/v1/board/activity?repo=all', expect.anything());
  });
});
