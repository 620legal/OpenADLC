import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';
import { subjectFrom } from '@/lib/item';

export const dynamic = 'force-dynamic';

/** Presses one of a pull request's declared commands, for the head the button was shown for; the bridge posts it. */
export async function POST(request: Request, { params }: { params: Promise<{ subject: string; name: string }> }) {
  const { subject: raw, name } = await params;
  const subject = subjectFrom(raw);
  const response = await fetchBridge(`${BRIDGE_URL}/v1/items/${encodeURIComponent(subject)}/pull/commands/${encodeURIComponent(name)}`, {
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
