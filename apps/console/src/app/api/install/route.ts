import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

/** The install's settings, so a person can configure OpenADLC without a shell. */
export async function GET(request: Request) {
  const response = await fetchBridge(`${BRIDGE_URL}/v1/install`, {
    cache: 'no-store',
    headers: identityHeadersFrom(request),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Writes only the fields the page sent; the rest are left alone. */
export async function PATCH(request: Request) {
  const response = await fetchBridge(`${BRIDGE_URL}/v1/install`, {
    method: 'PATCH',
    cache: 'no-store',
    headers: { ...identityHeadersFrom(request), 'content-type': 'application/json' },
    body: await request.text(),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}
