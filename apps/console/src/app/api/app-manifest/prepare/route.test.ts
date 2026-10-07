import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ BRIDGE_URL: 'http://bridge.test' }));
vi.mock('@/lib/identity', () => ({ identityHeadersFrom: () => ({ 'x-fleetadlc-user': 'alexsmith' }) }));

import { POST } from './route';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('preparing the app to create', () => {
  it('forwards what the page sent, so a create without an address raises no tunnel', async () => {
    const fetchMock = vi.fn(async () => new Response('{"postUrl":"https://github.com/settings/apps/new?state=x"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await POST(new Request('http://console.test/api/app-manifest/prepare', { method: 'POST', body: '{"withoutAddress":true}' }));

    expect(fetchMock).toHaveBeenCalledWith(
      'http://bridge.test/v1/app-manifest/prepare',
      expect.objectContaining({ method: 'POST', body: '{"withoutAddress":true}' }),
    );
  });

  it('sends an empty object when the page sent nothing', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await POST(new Request('http://console.test/api/app-manifest/prepare', { method: 'POST' }));

    expect(fetchMock).toHaveBeenCalledWith('http://bridge.test/v1/app-manifest/prepare', expect.objectContaining({ body: '{}' }));
  });
});
