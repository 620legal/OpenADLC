import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The console only forwards. PUT is the method; PATCH stays so a page that
 * already sends it still reaches the same bridge handler.
 */

vi.mock('@/lib/api', () => ({ BRIDGE_URL: 'http://bridge.test' }));
vi.mock('@/lib/identity', () => ({ identityHeadersFrom: () => ({ 'x-fleetadlc-user': 'alexsmith' }) }));

import { BRIDGE_NOT_ANSWERING } from '@/lib/reach';
import { PATCH, PUT } from './route';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the spending limits proxy', () => {
  it('forwards PUT to the bridge', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const response = await PUT(new Request('http://console.test/api/spending/limits', { method: 'PUT', body: '{"changes":[]}' }));
    expect(fetchMock).toHaveBeenCalledWith(
      'http://bridge.test/v1/spending/limits',
      expect.objectContaining({ method: 'PUT', body: '{"changes":[]}' }),
    );
    expect(response.status).toBe(200);
  });

  it('still forwards PATCH', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await PATCH(new Request('http://console.test/api/spending/limits', { method: 'PATCH', body: '{"changes":[]}' }));
    expect(fetchMock).toHaveBeenCalledWith(
      'http://bridge.test/v1/spending/limits',
      expect.objectContaining({ method: 'PATCH', body: '{"changes":[]}' }),
    );
  });

  it('says the bridge is not answering, as JSON, when it does not answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    const response = await PUT(new Request('http://console.test/api/spending/limits', { method: 'PUT', body: '{"changes":[]}' }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: BRIDGE_NOT_ANSWERING });
  });
});
