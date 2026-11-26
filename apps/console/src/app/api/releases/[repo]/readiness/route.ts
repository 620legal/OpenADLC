import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

export const dynamic = 'force-dynamic';

/** What a cut of a repository needs, checked (#371), which the release page reads again while it is open. */
export async function GET(request: Request, { params }: { params: Promise<{ repo: string }> }) {
  const { repo } = await params;
  const response = await fetchBridge(`${BRIDGE_URL}/v1/repos/${encodeURIComponent(decodeURIComponent(repo))}/release/readiness`, {
    cache: 'no-store',
    headers: identityHeadersFrom(request),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}
