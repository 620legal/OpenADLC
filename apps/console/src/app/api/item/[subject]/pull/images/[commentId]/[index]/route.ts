import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';
import { subjectFrom } from '@/lib/item';
import { attachmentPolicy } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';

/** The headers an image is served with, passed on as the bridge set them. */
const KEPT = ['content-type', 'content-length', 'content-disposition', 'x-content-type-options', 'content-security-policy', 'cache-control'];

/**
 * One screenshot a pull request's workflow posted, read by the bridge with its
 * own GitHub access: the repository may be private, and the browser is never
 * given a GitHub or signed address for it.
 */
export async function GET(request: Request, { params }: { params: Promise<{ subject: string; commentId: string; index: string }> }) {
  const { subject: raw, commentId, index } = await params;
  const subject = subjectFrom(raw);
  const upstream = await fetchBridge(
    `${BRIDGE_URL}/v1/items/${encodeURIComponent(subject)}/pull/images/${encodeURIComponent(commentId)}/${encodeURIComponent(index)}`,
    { cache: 'no-store', headers: identityHeadersFrom(request) },
  );
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
  headers.set('x-content-type-options', 'nosniff');
  headers.set('content-security-policy', attachmentPolicy(upstream.headers.get('content-security-policy')));
  return new Response(upstream.body, { status: 200, headers });
}
