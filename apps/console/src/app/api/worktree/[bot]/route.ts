import { BRIDGE_URL } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

/**
 * The path travels as a query parameter rather than in the route, so a segment
 * containing a slash cannot be split across the console's routing and the
 * bridge's. What is inside the worktree is hostd's decision, not this file's.
 */
export async function GET(request: Request, { params }: { params: Promise<{ bot: string }> }) {
  const { bot } = await params;
  const query = new URL(request.url).searchParams;
  const path = query.get('path') ?? '';
  const task = query.get('task');
  const response = await fetchBridge(
    `${BRIDGE_URL}/v1/worktree/${encodeURIComponent(bot)}?path=${encodeURIComponent(path)}${task ? `&task=${encodeURIComponent(task)}` : ''}`,
    { cache: 'no-store', headers: identityHeadersFrom(request) },
  );
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}
