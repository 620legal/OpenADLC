import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

/** Which model a bot runs, and which account it uses. Takes effect on the next task. */
export async function PATCH(request: Request, { params }: { params: Promise<{ bot: string }> }) {
  const { bot } = await params;
  const response = await fetchBridge(`${BRIDGE_URL}/v1/bots/${encodeURIComponent(bot)}/assignment`, {
    method: 'PATCH',
    cache: 'no-store',
    headers: { ...identityHeadersFrom(request), 'content-type': 'application/json' },
    body: await request.text(),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}
