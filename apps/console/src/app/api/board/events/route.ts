import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

/**
 * Proxies a page of the board's event history (`GET /v1/board/events/history`)
 * for the activity button and the Activity page, as the person looking: the
 * browser never needs a route to the bridge. Only the parameters the bridge
 * reads are passed on, and its answer — a page, or a refusal in its own
 * words — comes back as it is.
 */
export async function GET(request: Request) {
  const asked = new URL(request.url).searchParams;
  const params = new URLSearchParams();
  for (const name of ['repo', 'bot', 'before', 'limit']) {
    const value = asked.get(name);
    if (value) params.set(name, value);
  }
  const query = params.toString();
  const response = await fetchBridge(`${BRIDGE_URL}/v1/board/events/history${query ? `?${query}` : ''}`, {
    cache: 'no-store',
    headers: identityHeadersFrom(request),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}
