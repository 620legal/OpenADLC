import { BRIDGE_URL, type AttentionItem, type BoardPanel, type PanelRead } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

/** The body of a read that answered ok, else null: a refusal, an older bridge's 404 or a bridge not answering. */
async function bodyOf(response: Response): Promise<unknown> {
  if (!response.ok) return null;
  return response.json().catch(() => null);
}

/**
 * What the side panel polls on every page (ADR 0085): the bridge's Running
 * and Recent (`GET /v1/board/panel`) and Needs you (`GET /v1/attention`),
 * both as the person looking, side by side. Needs you is the same read the
 * Needs you page makes, so the panel's count is that page's.
 *
 * Always a 200: each part is null when its read failed, so a bridge that does
 * not answer, or an older one with no panel route, leaves the page as it is
 * rather than putting an error on every page.
 */
export async function GET(request: Request) {
  const init: RequestInit = { cache: 'no-store', headers: identityHeadersFrom(request) };
  const [panelResponse, attentionResponse] = await Promise.all([
    fetchBridge(`${BRIDGE_URL}/v1/board/panel`, init),
    fetchBridge(`${BRIDGE_URL}/v1/attention`, init),
  ]);
  const [panel, attention] = (await Promise.all([bodyOf(panelResponse), bodyOf(attentionResponse)])) as [
    { running?: unknown; recent?: unknown } | null,
    { items?: unknown } | null,
  ];
  const read: PanelRead = {
    tasks:
      panel && Array.isArray(panel.running)
        ? { running: panel.running as BoardPanel['running'], recent: Array.isArray(panel.recent) ? (panel.recent as BoardPanel['recent']) : [] }
        : null,
    attention: attention && Array.isArray(attention.items) ? (attention.items as AttentionItem[]) : null,
  };
  return Response.json(read, { headers: { 'cache-control': 'no-store' } });
}
