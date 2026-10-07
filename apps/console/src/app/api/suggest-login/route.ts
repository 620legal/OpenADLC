import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

/** A username for this bot that nobody already holds. */
export async function GET(request: Request) {
  const bot = new URL(request.url).searchParams.get('bot') ?? '';
  const response = await fetchBridge(`${BRIDGE_URL}/v1/github/suggest-login?bot=${encodeURIComponent(bot)}`, {
    cache: 'no-store',
    headers: identityHeadersFrom(request),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}
