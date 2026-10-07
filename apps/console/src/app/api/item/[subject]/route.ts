import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';
import { subjectFrom } from '@/lib/item';

/**
 * Proxies a work item's read, so the browser never needs a route to the
 * bridge. The subject is any of the item's members — `request:<id8>`,
 * `repo#12`, its pull request — read as it was meant (`subjectFrom`) and
 * encoded again for the bridge: `#` would otherwise end the path.
 */
export async function GET(request: Request, { params }: { params: Promise<{ subject: string }> }) {
  const subject = subjectFrom((await params).subject);
  const response = await fetchBridge(`${BRIDGE_URL}/v1/items/${encodeURIComponent(subject)}`, {
    cache: 'no-store',
    headers: identityHeadersFrom(request),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}
