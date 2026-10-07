import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

/**
 * Spending caps, read and written from Settings. The bridge keeps them; this
 * only forwards. Reading is a user's; saving is an admin's, which the bridge
 * enforces (`roles.ts`). The page sends PUT; PATCH is still accepted so a page
 * loaded before that change still saves.
 */
async function forward(request: Request, method: 'GET' | 'PATCH' | 'PUT'): Promise<Response> {
  const response = await fetchBridge(`${BRIDGE_URL}/v1/spending/limits`, {
    method,
    cache: 'no-store',
    headers: { ...identityHeadersFrom(request), 'content-type': 'application/json' },
    ...(method === 'GET' ? {} : { body: await request.text() }),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function GET(request: Request) {
  return forward(request, 'GET');
}

export async function PATCH(request: Request) {
  return forward(request, 'PATCH');
}

export async function PUT(request: Request) {
  return forward(request, 'PUT');
}
