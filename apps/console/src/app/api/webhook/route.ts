import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

/** Where GitHub delivers, and whether it currently does. */
export async function GET(request: Request) {
  const response = await fetchBridge(`${BRIDGE_URL}/v1/webhook`, {
    cache: 'no-store',
    headers: identityHeadersFrom(request),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Raising a tunnel takes as long as cloudflared takes to be reachable, which is
 * a few seconds and occasionally more. The proxy waits rather than giving the
 * page a timeout it would have to explain.
 */
export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  const path = searchParams.get('stop') === '1' ? 'stop-tunnel' : 'configure';

  const response = await fetchBridge(`${BRIDGE_URL}/v1/webhook/${path}`, {
    method: 'POST',
    cache: 'no-store',
    headers: { ...identityHeadersFrom(request), 'content-type': 'application/json' },
    body: await request.text(),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}
