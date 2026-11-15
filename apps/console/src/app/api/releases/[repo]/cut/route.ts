import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

export const dynamic = 'force-dynamic';

/**
 * Cuts a release from a pinned view (#345, ADR 0072): `{ viewId, clean }`,
 * passed through as sent, so the bridge's own check of the body stands — a
 * body naming a commit is refused there. Answers with the sign-in to approve.
 */
export async function POST(request: Request, { params }: { params: Promise<{ repo: string }> }) {
  const { repo } = await params;
  const response = await fetchBridge(`${BRIDGE_URL}/v1/repos/${encodeURIComponent(decodeURIComponent(repo))}/release/cut`, {
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
