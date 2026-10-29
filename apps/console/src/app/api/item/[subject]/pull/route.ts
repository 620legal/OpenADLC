import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';
import { subjectFrom } from '@/lib/item';

export const dynamic = 'force-dynamic';

/** A work item's pull request, as its pull panel shows it: its declared commands and what its workflows posted. */
export async function GET(request: Request, { params }: { params: Promise<{ subject: string }> }) {
  const subject = subjectFrom((await params).subject);
  const response = await fetchBridge(`${BRIDGE_URL}/v1/items/${encodeURIComponent(subject)}/pull`, {
    cache: 'no-store',
    headers: identityHeadersFrom(request),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}
