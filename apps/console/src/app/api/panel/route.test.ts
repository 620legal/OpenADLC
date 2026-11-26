import { afterEach, describe, expect, it, vi } from 'vitest';

/** The side panel's read: the bridge's panel tasks and Needs you, as the person, each part null when it failed. */

vi.mock('@/lib/api', () => ({ BRIDGE_URL: 'http://bridge.test' }));
vi.mock('@/lib/identity', () => ({ identityHeadersFrom: () => ({ 'x-openadlc-user': 'alexsmith' }) }));

import { GET } from './route';

afterEach(() => {
  vi.unstubAllGlobals();
});

const PANEL = { running: [{ id: 'task-1', state: 'working' }], recent: [] };
const ATTENTION = { items: [{ id: 'gate-1', kind: 'question' }] };

function bridge(answers: Record<string, () => Response | Promise<Response>>) {
  const fetchMock = vi.fn(async (url: string) => {
    const answer = answers[new URL(url).pathname];
    if (!answer) throw new Error(`unexpected ${url}`);
    return answer();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('the side panel’s read (#376)', () => {
  it('reads the panel’s tasks and Needs you side by side, as the person looking', async () => {
    const fetchMock = bridge({
      '/v1/board/panel': () => Response.json(PANEL),
      '/v1/attention': () => Response.json(ATTENTION),
    });
    const response = await GET(new Request('http://console.test/api/panel'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tasks: PANEL, attention: ATTENTION.items });
    for (const path of ['/v1/board/panel', '/v1/attention']) {
      expect(fetchMock).toHaveBeenCalledWith(
        `http://bridge.test${path}`,
        expect.objectContaining({ cache: 'no-store', headers: expect.objectContaining({ 'x-openadlc-user': 'alexsmith' }) }),
      );
    }
  });

  it('answers no tasks, with a 200, from an older bridge with no panel route', async () => {
    bridge({
      '/v1/board/panel': () => Response.json({ error: 'not found' }, { status: 404 }),
      '/v1/attention': () => Response.json(ATTENTION),
    });
    const response = await GET(new Request('http://console.test/api/panel'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tasks: null, attention: ATTENTION.items });
  });

  it('answers nothing, with a 200, when the bridge does not answer', async () => {
    bridge({
      '/v1/board/panel': () => Promise.reject(new TypeError('fetch failed')),
      '/v1/attention': () => Promise.reject(new TypeError('fetch failed')),
    });
    const response = await GET(new Request('http://console.test/api/panel'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tasks: null, attention: null });
  });

  it('answers no part whose body is not the shape it should be', async () => {
    bridge({
      '/v1/board/panel': () => Response.json({ running: 'nope' }),
      '/v1/attention': () => new Response('<html>', { status: 200 }),
    });
    expect(await (await GET(new Request('http://console.test/api/panel'))).json()).toEqual({ tasks: null, attention: null });
  });
});
