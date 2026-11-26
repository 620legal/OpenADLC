/**
 * What the crew has been doing, as the header's activity button and the
 * Activity page show it: the bridge's board events (`GET /v1/board/events`
 * live, `GET /v1/board/events/history` for the last thirty days), and which of
 * them this browser has seen.
 *
 * "Seen" is kept per browser, like the board's view and the pinned pages, and
 * never sent to the bridge (docs/adr/0081).
 */

/** One board event, as the bridge sends it (`apps/bridge/src/board-events.ts`). `type` is open: one this console does not know still lists. */
export interface BoardEvent {
  id: string;
  type: string;
  at: string;
  bot: string | null;
  item: { ref: string; repo: string | null; url: string | null };
  text: string;
}

/** A page of the history. `next` is the `before` of the page after; null once it reached `floor`, thirty days back. */
export interface ActivityPage {
  events: BoardEvent[];
  next: string | null;
  floor: string;
}

/** The newest event time the panel showed, as an ISO time. */
export const ACTIVITY_SEEN_KEY = 'openadlc.activity.seen';

/** Said in this tab after every write, so every button follows; another tab hears the `storage` event. */
export const ACTIVITY_SEEN_CHANGED = 'openadlc:activity-seen-changed';

/** What the button shows at most; more reads `99+`. */
export const BADGE_MAX = 99;

type Store = Pick<Storage, 'getItem' | 'setItem'>;

// Reached inside a `try`: with site data blocked, reading `localStorage` at all throws.
function browserStorage(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The time this browser last saw, or null when it stored none, or nothing that is a time. Never throws. */
export function readSeen(store: Pick<Storage, 'getItem'> | null = browserStorage()): string | null {
  try {
    const raw = store?.getItem(ACTIVITY_SEEN_KEY);
    return raw && !Number.isNaN(Date.parse(raw)) ? raw : null;
  } catch {
    return null;
  }
}

/** Stores the time seen and says so in this tab. Never throws: a private window goes on as it was. */
export function writeSeen(at: string, store: Store | null = browserStorage()): void {
  try {
    store?.setItem(ACTIVITY_SEEN_KEY, at);
  } catch {
    // Site data blocked: nothing is kept, and the count goes on from memory.
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(ACTIVITY_SEEN_CHANGED));
}

/** Calls back whenever the time seen changes, in this tab or another. The returned function stops it. */
export function onSeenChange(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const storage = (event: StorageEvent) => {
    if (event.key === null || event.key === ACTIVITY_SEEN_KEY) callback();
  };
  window.addEventListener(ACTIVITY_SEEN_CHANGED, callback);
  window.addEventListener('storage', storage);
  return () => {
    window.removeEventListener(ACTIVITY_SEEN_CHANGED, callback);
    window.removeEventListener('storage', storage);
  };
}

/** How many events are newer than the time seen. None before a time is stored: a browser starts at zero, not the backlog. */
export function unreadCount(events: readonly BoardEvent[], seen: string | null): number {
  if (!seen) return 0;
  const after = Date.parse(seen);
  return events.filter((event) => Date.parse(event.at) > after).length;
}

/** The button's badge: nothing at zero, the count up to 99, then `99+`. */
export function badgeText(count: number): string {
  if (count <= 0) return '';
  return count > BADGE_MAX ? `${BADGE_MAX}+` : String(count);
}

/** The newest event's time, or null for none. */
export function newestAt(events: readonly BoardEvent[]): string | null {
  let newest: string | null = null;
  for (const event of events) if (!newest || Date.parse(event.at) > Date.parse(newest)) newest = event.at;
  return newest;
}

/** Newest first, by time and then id, as the bridge orders them. */
export function newestFirst(a: BoardEvent, b: BoardEvent): number {
  const byTime = Date.parse(b.at) - Date.parse(a.at);
  if (byTime !== 0) return byTime;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * Two lists as one, each event once by id, newest first. The stream and the
 * history overlap — the history read on a reconnect has what the stream sent
 * before it dropped — and a merge-line hold carries one id in both but the
 * stream's own time, so the one listed first is kept.
 */
export function mergeEvents(a: readonly BoardEvent[], b: readonly BoardEvent[]): BoardEvent[] {
  const byId = new Map<string, BoardEvent>();
  for (const event of [...a, ...b]) if (!byId.has(event.id)) byId.set(event.id, event);
  return [...byId.values()].sort(newestFirst);
}

/**
 * Where an event's row goes in the console: a release to its repository's
 * releases, anything else to its work item, which resolves an issue, a pull
 * request and a request alike (`/items/<subject>`).
 */
export function eventHref(event: Pick<BoardEvent, 'item'>): string {
  const release = /^release:([^@]+)@/.exec(event.item.ref);
  if (release) return `/releases/${encodeURIComponent(release[1]!)}`;
  return `/items/${encodeURIComponent(event.item.ref)}`;
}

/** A repository's name from its full name, as the console names repositories. */
export function repoName(fullName: string | null): string | null {
  if (!fullName) return null;
  const slash = fullName.indexOf('/');
  return slash >= 0 ? fullName.slice(slash + 1) : fullName;
}

/** Whether an event passes the filters as the history applies them: a repository filter hides an event on no repository. */
export function matchesFilters(event: BoardEvent, filters: { repo?: string | null; bot?: string | null }): boolean {
  if (filters.repo && repoName(event.item.repo) !== filters.repo && event.item.repo !== filters.repo) return false;
  if (filters.bot && event.bot !== filters.bot) return false;
  return true;
}

/** The query for `/api/board/events`, with only what is set: `?repo=…&bot=…&before=…&limit=…`, or `''`. */
export function historyQuery(options: { repo?: string | null; bot?: string | null; before?: string | null; limit?: number | null }): string {
  const params = new URLSearchParams();
  if (options.repo) params.set('repo', options.repo);
  if (options.bot) params.set('bot', options.bot);
  if (options.before) params.set('before', options.before);
  if (options.limit) params.set('limit', String(options.limit));
  const query = params.toString();
  return query ? `?${query}` : '';
}

/**
 * Reads a page of the history through the console's proxy. Throws the
 * bridge's own words when it refuses, or says it could not be reached.
 */
export async function readActivity(
  options: { repo?: string | null; bot?: string | null; before?: string | null; limit?: number | null },
  fetcher: typeof fetch = fetch,
): Promise<ActivityPage> {
  const response = await fetcher(`/api/board/events${historyQuery(options)}`, { cache: 'no-store' });
  const body = (await response.json().catch(() => null)) as (Partial<ActivityPage> & { error?: string }) | null;
  if (!response.ok || !body || !Array.isArray(body.events)) {
    throw new Error(body?.error ?? `the bridge answered ${response.status}`);
  }
  return { events: body.events, next: body.next ?? null, floor: body.floor ?? '' };
}
