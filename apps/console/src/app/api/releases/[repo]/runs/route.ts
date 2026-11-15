import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

export const dynamic = 'force-dynamic';

/** A repository's release runs, newest first, which the page follows while one is in flight. */
export async function GET(request: Request, { params }: { params: Promise<{ repo: string }> }) {
  const { repo } = await params;
  const response = await fetchBridge(`${BRIDGE_URL}/v1/repos/${encodeURIComponent(decodeURIComponent(repo))}/releases`, {
    cache: 'no-store',
    headers: identityHeadersFrom(request),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}
