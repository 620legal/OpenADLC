import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';
import { attachmentPolicy } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';

/** The headers a file is served with, passed on as the bridge set them: what keeps a file from running as the console's page. */
const KEPT = ['content-type', 'content-length', 'content-disposition', 'x-content-type-options', 'content-security-policy', 'cache-control'];

/** One file, for a preview or a download, through the console's own server. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const upstream = await fetchBridge(`${BRIDGE_URL}/v1/attachments/${encodeURIComponent(id)}`, {
    cache: 'no-store',
    headers: identityHeadersFrom(request),
  });
  if (!upstream.ok || !upstream.body) {
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { 'content-type': 'application/json', 'content-security-policy': attachmentPolicy(null) },
    });
  }
  const headers = new Headers();
  for (const name of KEPT) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  // Whatever the bridge said, a file is never sniffed into something else here,
  // runs sandboxed, and is not framed. next.config.ts leaves this path's policy
  // to this route: Next keeps a header the config set over the route's.
  headers.set('x-content-type-options', 'nosniff');
  headers.set('content-security-policy', attachmentPolicy(upstream.headers.get('content-security-policy')));
  return new Response(upstream.body, { status: 200, headers });
}

/** Removes one for good; the bridge holds this to an admin and audits it. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const upstream = await fetchBridge(`${BRIDGE_URL}/v1/attachments/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    cache: 'no-store',
    headers: identityHeadersFrom(request),
  });
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': 'application/json', 'content-security-policy': attachmentPolicy(null) },
  });
}
