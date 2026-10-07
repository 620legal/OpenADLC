import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ BRIDGE_URL: 'http://bridge.test' }));
vi.mock('@/lib/identity', () => ({ identityHeadersFrom: () => ({ 'x-fleetadlc-user': 'alexsmith' }) }));

import { POST as restore } from '@/app/api/restore/route';
import { POST as restorePreview } from '@/app/api/restore/preview/route';
import { POST as restoreInto } from '@/app/api/restore/into/route';
import { POST as restoreIntoPreview } from '@/app/api/restore/into/preview/route';
import { RESTORE_BODY_MAX } from './restore-body';

/**
 * A backup with history is larger than the ten megabytes Next hands a route
 * behind middleware by default. Cut short, it reached the bridge as JSON that
 * did not parse; now a body the console cannot carry is refused before it is
 * read, and one it can is forwarded whole.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const ROUTES = [
  ['/api/restore', restore, '/v1/restore'],
  ['/api/restore/preview', restorePreview, '/v1/restore/preview'],
  ['/api/restore/into', restoreInto, '/v1/restore/into'],
  ['/api/restore/into/preview', restoreIntoPreview, '/v1/restore/into/preview'],
] as const;

function post(path: string, body: string, length: number | null): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (length !== null) headers['content-length'] = String(length);
  return new Request(`http://console.test${path}`, { method: 'POST', headers, body });
}

describe('a restore body', () => {
  it.each(ROUTES)('under the limit is forwarded whole by %s', async (path, handler, bridgePath) => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const body = '{"archive":"aGVsbG8="}';
    const response = await handler(post(path, body, body.length));
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(`http://bridge.test${bridgePath}`, expect.objectContaining({ method: 'POST', body }));
  });

  it.each(ROUTES)('over the limit is refused by %s without calling the bridge', async (path, handler) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await handler(post(path, '{}', RESTORE_BODY_MAX + 1));
    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: string }).error).toContain('fleetadlc restore');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('that does not say its size is refused by %s', async (path, handler) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await handler(post(path, '{}', null));
    expect(response.status).toBe(411);
    expect(((await response.json()) as { error: string }).error).toContain('fleetadlc restore');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is limited to what the bridge accepts, 96 MiB', () => {
    expect(RESTORE_BODY_MAX).toBe(96 * 1024 * 1024);
  });
});
