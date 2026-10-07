import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

/** Asks how an account's device flow went; the bridge does the polling. */
export async function GET(request: Request, { params }: { params: Promise<{ flowId: string }> }) {
  const { flowId } = await params;
  const response = await fetchBridge(`${BRIDGE_URL}/v1/github/accounts/connect/${encodeURIComponent(flowId)}`, {
    cache: 'no-store',
    headers: identityHeadersFrom(request),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}
