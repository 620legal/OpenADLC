import { BRIDGE_URL, type JumpItem, type PaletteRead, type WorkPauses } from '@/lib/api';
import { fetchBridge } from '@/lib/bridge-fetch';
import { identityHeadersFrom } from '@/lib/identity';

/** The bridge's own words for a refusal, else its status. */
async function errorOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === 'string' && body.error ? body.error : `the bridge answered ${response.status}`;
}

/**
 * What the command palette reads each time it opens: the jump list
 * (`GET /v1/items`) and whether anything is paused, for Resume. Read here
 * rather than with every page's header, which would carry hundreds of items
 * for a palette that is rarely open (docs/adr/0029). Each read can fail on its
 * own: an older bridge with no `/v1/items` still lets the palette go places
 * and act.
 */
export async function GET(request: Request) {
  const init: RequestInit = { cache: 'no-store', headers: identityHeadersFrom(request) };
  const [itemsResponse, pauseResponse] = await Promise.all([
    fetchBridge(`${BRIDGE_URL}/v1/items`, init),
    fetchBridge(`${BRIDGE_URL}/v1/work/pause`, init),
  ]);

  const read: PaletteRead = { items: null, numbered: false, itemsError: null, paused: null };
  if (itemsResponse.ok) {
    const body = (await itemsResponse.json().catch(() => null)) as { numbered?: unknown; items?: unknown } | null;
    if (body && Array.isArray(body.items)) {
      read.items = body.items as JumpItem[];
      read.numbered = body.numbered === true;
    } else read.itemsError = 'the bridge answered with something that is not a list of items';
  } else read.itemsError = await errorOf(itemsResponse);

  if (pauseResponse.ok) {
    const pauses = (await pauseResponse.json().catch(() => null)) as WorkPauses | null;
    if (pauses) read.paused = Boolean(pauses.paused) || Object.keys(pauses.repos ?? {}).length > 0;
  }
  return Response.json(read, { headers: { 'cache-control': 'no-store' } });
}
