import type { AttentionItem, PanelRead } from './api';
import { stripItems, waiting } from './attention-card';
import { REFRESH_EVERY_MS } from './live-refresh';

/**
 * The side panel beside every page: Needs you, Running and Recent, or a rail
 * with their counts (ADR 0085).
 *
 * Whether it is open is kept per person in this browser (ADR 0082), as the
 * "How this works" strips are: the person is the identity the bridge answered
 * `/v1/me` with (`useViewerIdentity`), so another person signed in on the same
 * browser keeps their own setting. Open unless this person collapsed it: on a
 * first visit, with no identity, and when storage is unavailable or throws.
 */

/** Said in this tab when the panel is opened or collapsed; another tab hears the `storage` event. */
export const SIDE_PANEL_CHANGED = 'openadlc:side-panel-changed';

/**
 * How often the panel reads again: the board's own full read
 * (`REFRESH_EVERY_MS`), so a task that starts or ends shows within the
 * board's poll interval on any page. The board's few-second activity poll
 * runs only while something on it runs, so it could not bound a start.
 */
export const PANEL_EVERY_MS = REFRESH_EVERY_MS;

/**
 * Where the panel is drawn and polled: Tailwind's `md`, where the header
 * leaves its phone form and `BottomNav` goes (`app-header.tsx`). Below it the
 * panel is hidden by CSS alone and never polls, so the phone layout and the
 * installed app are as they were.
 */
export const PANEL_MEDIA = '(min-width: 768px)';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The key for one person. The identity is encoded so an email's `.` cannot run into the key's own separators. */
export function sidePanelKey(identity: string): string {
  return `openadlc.sidePanel.${encodeURIComponent(identity)}`;
}

/** Whether the panel is open for this person; open whenever nothing says they collapsed it. */
export function storedSidePanelOpen(identity: string | null, store: Pick<Storage, 'getItem'> | null = browserStorage()): boolean {
  if (identity === null) return true;
  try {
    return store?.getItem(sidePanelKey(identity)) !== 'closed';
  } catch {
    return true;
  }
}

/** What `SIDE_PANEL_CHANGED` carries, so a listener need not read storage back. */
export interface SidePanelChange {
  identity: string;
  open: boolean;
}

/**
 * Remembers the panel open or collapsed for this person, and says so to this
 * tab with the new state in the event's detail: reading storage back after a
 * write that threw would answer "open", and undo the collapse just asked for.
 * Nothing is stored or said without an identity.
 */
export function storeSidePanelOpen(identity: string | null, open: boolean, store: Pick<Storage, 'setItem'> | null = browserStorage()): void {
  if (identity === null) return;
  try {
    store?.setItem(sidePanelKey(identity), open ? 'open' : 'closed');
  } catch {
    // A private window, or site data blocked: the panel keeps its state for this page only.
  }
  if (typeof window !== 'undefined') {
    const detail: SidePanelChange = { identity, open };
    window.dispatchEvent(new CustomEvent(SIDE_PANEL_CHANGED, { detail }));
  }
}

/**
 * The rail's badges and the tabs' counts. Needs you is counted by `waiting`,
 * the function behind the Needs you page's `groupCounts` and the header's
 * badge, so a notice that something was fixed, or a held approval that is
 * someone else's, is counted nowhere here either. Running is every row of
 * the Running tab — working, waiting and paused — so the badge and the list
 * agree.
 */
export function panelCounts(panel: PanelRead): { needsYou: number; running: number } {
  return { needsYou: panel.attention ? waiting(panel.attention).length : 0, running: panel.tasks?.running.length ?? 0 };
}

/** Needs you's rows: every item the page counts, in the board strip's order (what stops work first, work before system, newest), with no limit. */
export function needsYouRows(attention: readonly AttentionItem[]): AttentionItem[] {
  return stripItems(attention, Number.POSITIVE_INFINITY);
}

/** A count as a badge says it; none at all at zero. */
export function badge(count: number): string | null {
  if (count <= 0) return null;
  return count > 99 ? '99+' : String(count);
}
