import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';
import { forwardRestore } from '@/lib/restore-body';

/** Where a restore into this install, or its undo, has got to — and whether the last one can be undone. */
export async function GET(request: Request) {
  const response = await fetchBridge(`${BRIDGE_URL}/v1/restore/into`, {
    cache: 'no-store',
    headers: identityHeadersFrom(request),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Starts restoring what was chosen from a backup into this install. */
export async function POST(request: Request) {
  return forwardRestore(request, '/v1/restore/into');
}
