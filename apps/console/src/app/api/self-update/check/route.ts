import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

/** Asks GitHub again what an OpenADLC update would take; the bridge refuses a second look within a minute. */
export async function POST(request: Request) {
  const response = await fetchBridge(`${BRIDGE_URL}/v1/self-update/check`, {
    method: 'POST',
    cache: 'no-store',
    headers: { ...identityHeadersFrom(request), 'content-type': 'application/json' },
    body: '{}',
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}
