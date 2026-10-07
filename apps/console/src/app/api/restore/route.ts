import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';
import { forwardRestore } from '@/lib/restore-body';

/** Whether this install can be restored into: a clean one only. */
export async function GET(request: Request) {
  const response = await fetchBridge(`${BRIDGE_URL}/v1/restore`, {
    cache: 'no-store',
    headers: identityHeadersFrom(request),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Restores a backup into this install, which the bridge refuses unless it is clean. */
export async function POST(request: Request) {
  return forwardRestore(request, '/v1/restore');
}
