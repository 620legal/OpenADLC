import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

/** The GitHub accounts OpenADLC holds, the bots on each, and which account each bot may use. */
export async function GET(request: Request) {
  const response = await fetchBridge(`${BRIDGE_URL}/v1/github/identities`, {
    cache: 'no-store',
    headers: identityHeadersFrom(request),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}
