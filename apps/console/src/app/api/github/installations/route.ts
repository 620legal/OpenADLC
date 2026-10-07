import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

/** Where the app is installed, and each account OpenADLC works in: settings' GitHub App section. */
export async function GET(request: Request) {
  const response = await fetchBridge(`${BRIDGE_URL}/v1/github/installations`, {
    cache: 'no-store',
    headers: identityHeadersFrom(request),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}
