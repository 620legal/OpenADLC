import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

/** What there is to back up, by name. Never a value. */
export async function GET(request: Request) {
  const response = await fetchBridge(`${BRIDGE_URL}/v1/backup`, {
    cache: 'no-store',
    headers: identityHeadersFrom(request),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * The sealed archive, passed straight through to the browser as the
 * download. The choice and the passphrase go to the bridge and nowhere else;
 * a refusal comes back as the bridge's own words.
 */
export async function POST(request: Request) {
  const response = await fetchBridge(`${BRIDGE_URL}/v1/backup`, {
    method: 'POST',
    cache: 'no-store',
    headers: { ...identityHeadersFrom(request), 'content-type': 'application/json' },
    body: await request.text(),
  });
  if (!response.ok) {
    return new Response(await response.text(), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(response.body, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': response.headers.get('content-disposition') ?? 'attachment; filename="fleetadlc-backup.fleetbak"',
      'cache-control': 'no-store',
    },
  });
}
