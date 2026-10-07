import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

/** Proxies the thread read so the browser never needs a route to the bridge. */
export async function GET(request: Request, { params }: { params: Promise<{ bot: string }> }) {
  const { bot } = await params;
  // The bridge narrows a thread to one subject when `subject` is given; pass it on when the page asks for one.
  const subject = new URL(request.url).searchParams.get('subject');
  const query = subject ? `?subject=${encodeURIComponent(subject)}` : '';
  const response = await fetchBridge(`${BRIDGE_URL}/v1/threads/${encodeURIComponent(bot)}${query}`, {
    cache: 'no-store',
    headers: identityHeadersFrom(request),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}
