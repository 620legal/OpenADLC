import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

/** Whether the two settings GitHub's manifest cannot set were actually ticked. */
export async function GET(request: Request) {
  const response = await fetchBridge(`${BRIDGE_URL}/v1/app-checks`, {
    cache: 'no-store',
    headers: identityHeadersFrom(request),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}
