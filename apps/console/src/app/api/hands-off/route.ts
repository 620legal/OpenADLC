import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

export const dynamic = 'force-dynamic';

/** The open hands-off windows, and whether this person may turn one on (#383), as themselves. */
export async function GET(request: Request) {
  const response = await fetchBridge(`${BRIDGE_URL}/v1/hands-off`, { cache: 'no-store', headers: identityHeadersFrom(request) });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}
