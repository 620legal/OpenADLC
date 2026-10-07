import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

export async function GET(request: Request, { params }: { params: Promise<{ bot: string }> }) {
  const { bot } = await params;
  const response = await fetchBridge(`${BRIDGE_URL}/v1/sessions/${encodeURIComponent(bot)}`, {
    cache: 'no-store',
    headers: identityHeadersFrom(request),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}
