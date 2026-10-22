import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

/**
 * Proxies the board's few-second read of its running cards
 * (`useBoardActivity`), for the repository it shows, as the person looking:
 * the browser never needs a route to the bridge.
 */
export async function GET(request: Request) {
  const repo = new URL(request.url).searchParams.get('repo') || 'all';
  const response = await fetchBridge(`${BRIDGE_URL}/v1/board/activity?repo=${encodeURIComponent(repo)}`, {
    cache: 'no-store',
    headers: identityHeadersFrom(request),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}
