import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

/**
 * OpenADLC's update of itself from its releases: the commit in use, the
 * release an update would take, the last result, the schedule. The bridge
 * keeps the clock and the record, and prepares and restarts.
 */
async function forward(request: Request, method: 'GET' | 'POST' | 'PATCH'): Promise<Response> {
  const response = await fetchBridge(`${BRIDGE_URL}/v1/self-update`, {
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

/** Update now. Answers once the release is chosen; preparing it carries on without the page. */
export async function POST(request: Request) {
  return forward(request, 'POST');
}

/** The schedule: Schedule or Manual, the day, the time. */
export async function PATCH(request: Request) {
  return forward(request, 'PATCH');
}
