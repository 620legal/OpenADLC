import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

/** What the last step would change, before anything is changed. Reads only. */
export async function GET(request: Request) {
  const response = await fetchBridge(`${BRIDGE_URL}/v1/repo-setup`, {
    cache: 'no-store',
    headers: identityHeadersFrom(request),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * The doing half. `what=labels` writes the board's columns, `what=rules` creates
 * the containment — separately, because they are agreed to separately — and
 * `what=production` records how a repository's production ships.
 */
export async function POST(request: Request) {
  const asked = new URL(request.url).searchParams.get('what');
  const what = asked === 'rules' || asked === 'production' ? asked : 'labels';

  const response = await fetchBridge(`${BRIDGE_URL}/v1/repo-setup/${what}`, {
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
