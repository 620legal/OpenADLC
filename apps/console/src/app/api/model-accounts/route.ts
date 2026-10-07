import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

/** The accounts the crew can think with. A response never includes a key. */
export async function GET(request: Request) {
  const response = await fetchBridge(`${BRIDGE_URL}/v1/model-accounts`, {
    cache: 'no-store',
    headers: identityHeadersFrom(request),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Adds one account. A key is verified by the bridge before it is stored. */
export async function POST(request: Request) {
  const response = await fetchBridge(`${BRIDGE_URL}/v1/model-accounts`, {
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
