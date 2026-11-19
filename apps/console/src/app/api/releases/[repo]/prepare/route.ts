import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

export const dynamic = 'force-dynamic';

/**
 * Prepare next version from a pinned view (#363, docs/adr/0078):
 * `{ viewId, version }`, passed through as sent, so the bridge's own checks
 * stand — who may press, the view, and the version held above the last
 * release. Answers with the console request it filed.
 */
export async function POST(request: Request, { params }: { params: Promise<{ repo: string }> }) {
  const { repo } = await params;
  const response = await fetchBridge(`${BRIDGE_URL}/v1/repos/${encodeURIComponent(decodeURIComponent(repo))}/release/prepare`, {
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
