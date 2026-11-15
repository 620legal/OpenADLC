import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

export const dynamic = 'force-dynamic';

/** Pins a new compare view of the repository's default branch (#345): the page asks again when its view has expired. */
export async function POST(request: Request, { params }: { params: Promise<{ repo: string }> }) {
  const { repo } = await params;
  const response = await fetchBridge(`${BRIDGE_URL}/v1/repos/${encodeURIComponent(decodeURIComponent(repo))}/release/views`, {
    method: 'POST',
    cache: 'no-store',
    headers: identityHeadersFrom(request),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}
