import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

/** Who a half-typed name belongs to on GitHub. The bridge asks; the browser never does. */
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get('q') ?? '';
  const response = await fetchBridge(`${BRIDGE_URL}/v1/github/accounts?q=${encodeURIComponent(q)}`, {
    cache: 'no-store',
    headers: identityHeadersFrom(request),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}
