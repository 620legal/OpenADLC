import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

/**
 * The manifest to create the app from now, with a tunnel raised for its
 * webhook first when this bridge has no address. That takes as long as
 * cloudflared takes to be reachable — seconds, occasionally more — and the
 * proxy waits rather than handing the page a timeout to explain.
 */
export async function POST(request: Request) {
  const response = await fetchBridge(`${BRIDGE_URL}/v1/app-manifest/prepare`, {
    method: 'POST',
    cache: 'no-store',
    headers: { ...identityHeadersFrom(request), 'content-type': 'application/json' },
    // As the page sent it: `withoutAddress` says to raise no tunnel.
    body: (await request.text()) || '{}',
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}
