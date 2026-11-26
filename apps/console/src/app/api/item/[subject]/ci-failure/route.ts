import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';
import { subjectFrom } from '@/lib/item';

export const dynamic = 'force-dynamic';

/** Why a work item's pull request is red: the failing job, its step and the first lines of its error (#372). Only reads. */
export async function GET(request: Request, { params }: { params: Promise<{ subject: string }> }) {
  const subject = subjectFrom((await params).subject);
  const response = await fetchBridge(`${BRIDGE_URL}/v1/items/${encodeURIComponent(subject)}/ci-failure`, {
    cache: 'no-store',
    headers: identityHeadersFrom(request),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}
