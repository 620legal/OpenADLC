import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

/** Starts the device flow for a GitHub account on its own, for no bot; the bridge answers with the code and a flow id to ask after. */
export async function POST(request: Request) {
  const response = await fetchBridge(`${BRIDGE_URL}/v1/github/accounts/connect`, {
    method: 'POST',
    cache: 'no-store',
    headers: identityHeadersFrom(request),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}
