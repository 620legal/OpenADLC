import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

/** What is waiting to be accepted. The bridge asks `gh`; the browser asks the bridge. */
export async function GET(request: Request) {
  const response = await fetchBridge(`${BRIDGE_URL}/v1/invitations`, {
    cache: 'no-store',
    headers: identityHeadersFrom(request),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Accepts each one as the bot it was sent to. */
export async function POST(request: Request) {
  const response = await fetchBridge(`${BRIDGE_URL}/v1/invitations/accept`, {
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
