import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

/** Allows an account beyond those the install works in, after its warning; see the bridge's `app-reach.ts`. */
export async function POST(request: Request) {
  const response = await fetchBridge(`${BRIDGE_URL}/v1/github/allowed-accounts`, {
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
