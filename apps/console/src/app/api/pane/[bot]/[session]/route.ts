import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ bot: string; session: string }> },
) {
  const { bot, session } = await params;
  const response = await fetchBridge(
    `${BRIDGE_URL}/v1/sessions/${encodeURIComponent(bot)}/${encodeURIComponent(session)}/pane?lines=80`,
    { cache: 'no-store', headers: identityHeadersFrom(request) },
  );
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}
