import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

/**
 * Proxies the board's live events (`GET /v1/board/events`), as
 * `api/item/[subject]/stream` does a work item's: the activity button learns
 * from it that something happened, within the bridge's two-second probe, and
 * the browser still needs no route to the bridge.
 *
 * `dynamic` and `fetchCache` are here because Next will otherwise buffer this:
 * a streamed response that is cached is a response that arrives once, at the
 * end, which is indistinguishable from the stream never working.
 */
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export async function GET(request: Request) {
  const upstream = await fetchBridge(`${BRIDGE_URL}/v1/board/events`, {
    cache: 'no-store',
    headers: { ...identityHeadersFrom(request), accept: 'text/event-stream' },
    // Node's fetch buffers a response body without this.
    // @ts-expect-error -- `duplex` is required by undici and not in the DOM types.
    duplex: 'half',
    signal: request.signal,
  });

  if (!upstream.ok || !upstream.body) {
    return new Response(JSON.stringify({ error: `the stream is not available (${upstream.status})` }), {
      status: upstream.status === 401 || upstream.status === 403 ? upstream.status : 502,
      headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Tells a reverse proxy not to buffer it either.
      'x-accel-buffering': 'no',
    },
  });
}
