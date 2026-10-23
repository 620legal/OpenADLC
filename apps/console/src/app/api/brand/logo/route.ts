import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';
import { attachmentPolicy } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';

/** The headers the logo is served with, passed on as the bridge set them: what keeps an SVG from running as the console's page. */
const KEPT = ['content-type', 'content-length', 'content-disposition', 'x-content-type-options', 'content-security-policy', 'cache-control'];

/**
 * The console's logo, for the header's `<img>`, through the console's own
 * server. Its address carries the logo's version (`readBrand`), so the
 * bridge's few minutes of cache never show an old one after a change.
 */
export async function GET(request: Request) {
  const upstream = await fetchBridge(`${BRIDGE_URL}/v1/brand/logo`, {
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
  // Whatever the bridge said, the logo is never sniffed into something else
  // here, runs sandboxed, and is not framed. next.config.ts leaves this path's
  // policy to this route: Next keeps a header the config set over the route's.
  headers.set('x-content-type-options', 'nosniff');
  headers.set('content-security-policy', attachmentPolicy(upstream.headers.get('content-security-policy')));
  return new Response(upstream.body, { status: 200, headers });
}
