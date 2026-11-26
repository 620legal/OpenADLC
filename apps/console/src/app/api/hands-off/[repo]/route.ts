import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

export const dynamic = 'force-dynamic';

function bridgePath(repo: string): string {
  return `${BRIDGE_URL}/v1/repos/${encodeURIComponent(decodeURIComponent(repo))}/hands-off`;
}

/**
 * Turns hands-off mode on for a repository (#383, ADR 0093): `{ duration }`,
 * passed through as sent, so the bridge's checks stand. Answers with the
 * sign-in to approve; nothing is on until it is approved.
 */
export async function POST(request: Request, { params }: { params: Promise<{ repo: string }> }) {
  const { repo } = await params;
  const response = await fetchBridge(bridgePath(repo), {
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

/** Turns it off at once, as the person who pressed Turn off. */
export async function DELETE(request: Request, { params }: { params: Promise<{ repo: string }> }) {
  const { repo } = await params;
  const response = await fetchBridge(bridgePath(repo), { method: 'DELETE', cache: 'no-store', headers: identityHeadersFrom(request) });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}
