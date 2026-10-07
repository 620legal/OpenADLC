/**
 * What the console says when a request got no answer at all.
 *
 * `fetch` rejects with the runtime's own words for that — `fetch failed` in
 * Node, `Failed to fetch` in Chrome, `Load failed` in Safari — and none of them
 * says what did not answer or what to do about it. The Terminal tab showed
 * `fetch failed` as its whole error.
 */
export const BRIDGE_NOT_ANSWERING = 'the bridge is not answering; it may be restarting. Try again in a moment.';

/** `fetch`, with "no answer" said as `unreachable` rather than in the runtime's words. */
export async function reach(url: string, init: RequestInit, unreachable: string): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new Error(unreachable);
  }
}

/**
 * One read for a poll: the JSON, or null when there was no usable answer this
 * time. It never rejects. A poll is fired from a timer that nothing awaits, so a
 * rejection is an `Uncaught (in promise)` in the console every few seconds while
 * the bridge restarts — and the next tick is already the retry.
 */
export async function poll<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}
