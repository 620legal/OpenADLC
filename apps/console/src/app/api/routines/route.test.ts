import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ BRIDGE_URL: 'http://bridge.test' }));
vi.mock('@/lib/identity', () => ({ identityHeadersFrom: () => ({ 'x-openadlc-identity': 'ada@example.com' }) }));

import { DELETE, PATCH } from './[id]/route';
import { POST as PAUSE } from './[id]/pause/route';
import { POST as RESUME } from './[id]/resume/route';
import { GET, POST } from './route';

afterEach(() => {
  vi.unstubAllGlobals();
});

const ID = '0b6f1d1c-6c55-4c1c-9a59-1f4a4b8f2a10';
const params = { params: Promise.resolve({ id: ID }) };

describe('the Routines proxy', () => {
  it('passes each change to the bridge as sent, with the caller’s identity, and its answer back whole', async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: 'Only someone in People with Approves on can change routines' }, { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    const created = await POST(new Request('http://console.test/api/routines', { method: 'POST', body: '{"text":"Review"}' }));
    expect(created.status).toBe(403);
    expect(await created.json()).toEqual({ error: 'Only someone in People with Approves on can change routines' });
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://bridge.test/v1/routines',
      expect.objectContaining({ method: 'POST', body: '{"text":"Review"}', headers: { 'x-openadlc-identity': 'ada@example.com', 'content-type': 'application/json' } }),
    );

    await PATCH(new Request('http://console.test/x', { method: 'PATCH', body: '{"text":"Edited"}' }), params);
    expect(fetchMock).toHaveBeenLastCalledWith(`http://bridge.test/v1/routines/${ID}`, expect.objectContaining({ method: 'PATCH', body: '{"text":"Edited"}' }));

    await PAUSE(new Request('http://console.test/x', { method: 'POST' }), params);
    expect(fetchMock).toHaveBeenLastCalledWith(`http://bridge.test/v1/routines/${ID}/pause`, expect.objectContaining({ method: 'POST', body: '{}' }));

    await RESUME(new Request('http://console.test/x', { method: 'POST' }), params);
    expect(fetchMock).toHaveBeenLastCalledWith(`http://bridge.test/v1/routines/${ID}/resume`, expect.objectContaining({ method: 'POST' }));

    await DELETE(new Request('http://console.test/x', { method: 'DELETE' }), params);
    expect(fetchMock).toHaveBeenLastCalledWith(`http://bridge.test/v1/routines/${ID}`, expect.not.objectContaining({ body: expect.anything() }));

    await GET(new Request('http://console.test/api/routines'));
    expect(fetchMock).toHaveBeenLastCalledWith('http://bridge.test/v1/routines', expect.objectContaining({ method: 'GET' }));
  });
});
