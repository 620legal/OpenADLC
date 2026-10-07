import { BRIDGE_NOT_ANSWERING } from '@/lib/reach';

/**
 * `fetch` to the bridge from a route handler, where a bridge that does not
 * answer is a 502 whose `{ error }` says so.
 *
 * A bare `fetch` rejects, and Next turns that into its own 500 page: saving
 * the spending limits while the bridge restarted showed a JSON SyntaxError,
 * and every caller that read the error showed "Internal Server Error". Server
 * actions say `BRIDGE_NOT_ANSWERING` through `reach`; routes say the same here.
 */
export async function fetchBridge(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    return Response.json({ error: BRIDGE_NOT_ANSWERING }, { status: 502 });
  }
}
