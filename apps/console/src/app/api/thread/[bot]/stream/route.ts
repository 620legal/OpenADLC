import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

/**
 * Proxies the thread's event stream, so the browser still needs no route to the
 * bridge — the same reason the read next door is proxied.
 *
 * `dynamic` and `fetchCache` are here because Next will otherwise buffer this:
 * a streamed response that is cached is a response that arrives once, at the
 * end, which is indistinguishable from the stream never working.
 */
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export async function GET(request: Request, { params }: { params: Promise<{ bot: string }> }) {
  const { bot } = await params;
  const upstream = await fetchBridge(`${BRIDGE_URL}/v1/threads/${encodeURIComponent(bot)}/stream`, {
    cache: 'no-store',
    headers: { ...identityHeadersFrom(request), accept: 'text/event-stream' },
    // Node's fetch buffers a response body without this.
    // @ts-expect-error -- `duplex` is required by undici and not in the DOM types.
    duplex: 'half',
    signal: request.signal,
  });

  if (!upstream.ok || !upstream.body) {
    return new Response(JSON.stringify({ error: `the stream is not available (${upstream.status})` }), {
      status: upstream.status === 404 ? 404 : 502,
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
