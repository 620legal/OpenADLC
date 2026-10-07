import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

/** Puts the previous bot image back. Recorded in the audit log as the person who asked. */
export async function POST(request: Request) {
  const response = await fetchBridge(`${BRIDGE_URL}/v1/engines/updates/rollback`, {
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
