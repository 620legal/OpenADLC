import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

/**
 * The weekly engine update: which versions the crew runs, the last result,
 * the schedule and the next run. The bridge keeps the clock and the record;
 * hostd does the work.
 */
async function forward(request: Request, method: 'GET' | 'POST' | 'PATCH'): Promise<Response> {
  const response = await fetchBridge(`${BRIDGE_URL}/v1/engines/updates`, {
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

/** Update now. Answers once hostd has started the run, which then carries on without the page. */
export async function POST(request: Request) {
  return forward(request, 'POST');
}

/** The schedule: on or off, the day, the time. */
export async function PATCH(request: Request) {
  return forward(request, 'PATCH');
}
