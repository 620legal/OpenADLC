import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';
import { subjectFrom } from '@/lib/item';

export const dynamic = 'force-dynamic';

/** How a sign-off's GitHub sign-in went, for the person who started it. */
export async function GET(request: Request, { params }: { params: Promise<{ subject: string; flowId: string }> }) {
  const { subject: raw, flowId } = await params;
  const subject = subjectFrom(raw);
  const response = await fetchBridge(`${BRIDGE_URL}/v1/items/${encodeURIComponent(subject)}/pull/flows/${encodeURIComponent(flowId)}`, {
    cache: 'no-store',
    headers: identityHeadersFrom(request),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}
