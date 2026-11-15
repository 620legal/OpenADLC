import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

export const dynamic = 'force-dynamic';

/** How a release cut's sign-in went, for the person who started it, with the run once it started. */
export async function GET(request: Request, { params }: { params: Promise<{ repo: string; flowId: string }> }) {
  const { repo, flowId } = await params;
  const response = await fetchBridge(
    `${BRIDGE_URL}/v1/repos/${encodeURIComponent(decodeURIComponent(repo))}/release/flows/${encodeURIComponent(flowId)}`,
    { cache: 'no-store', headers: identityHeadersFrom(request) },
  );
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}
