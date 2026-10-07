import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ BRIDGE_URL: 'http://bridge.test' }));
vi.mock('@/lib/identity', () => ({ identityHeadersFrom: () => ({ 'x-fleetadlc-user': 'alexsmith' }) }));

import * as route from './route';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the app manifest proxy', () => {
  it('forwards a look at the manifest to the bridge', async () => {
    const fetchMock = vi.fn(async () => new Response('{"postUrl":"https://github.com/settings/apps/new"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await route.GET(new Request('http://console.test/api/app-manifest'));

    expect(fetchMock).toHaveBeenCalledWith('http://bridge.test/v1/app-manifest', expect.objectContaining({ cache: 'no-store' }));
    expect(response.status).toBe(200);
  });

  it('exchanges no code: only the app-created page does, with the state the bridge issued', () => {
    expect('POST' in route).toBe(false);
  });
});
