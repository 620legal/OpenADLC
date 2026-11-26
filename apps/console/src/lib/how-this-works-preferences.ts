/**
 * Whether a "How this works" strip is open, per strip and per person, kept in
 * this browser (ADR 0082). The person is the identity the bridge answered
 * `/v1/me` with (`useViewerIdentity`); a different person on the same browser
 * has keys of their own, so their strips start open.
 *
 * Open unless this person collapsed it: on a first visit, with no identity,
 * and when storage is unavailable or throws. Nothing is stored on the bridge.
 */

export type StripId = 'needs-you' | 'releases' | 'host-checks' | 'merge-state' | 'costs';

/** Said in this tab when a strip is opened or collapsed; another tab hears the `storage` event. */
export const HOW_THIS_WORKS_CHANGED = 'openadlc:how-this-works-changed';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * The key for one strip and one person. The identity is encoded so an email's
 * `.` or a `:` cannot run into the key's own separators.
 */
export function stripKey(strip: StripId, identity: string): string {
  return `openadlc.howThisWorks.${strip}.${encodeURIComponent(identity)}`;
}

/** Whether the strip is open for this person; open whenever nothing says it was collapsed. */
export function storedStripOpen(
  strip: StripId,
  identity: string | null,
  store: Pick<Storage, 'getItem'> | null = browserStorage(),
): boolean {
  if (identity === null) return true;
  try {
    return store?.getItem(stripKey(strip, identity)) !== 'closed';
  } catch {
    return true;
  }
}

/** What `HOW_THIS_WORKS_CHANGED` carries, so a listener need not read storage back. */
export interface StripChange {
  strip: StripId;
  identity: string;
  open: boolean;
}

/**
 * Remembers the strip open or collapsed for this person, and says so to this
 * tab with the new state in the event's detail. The detail is what a listener
 * applies: reading storage back after a write that threw would answer "open",
 * and undo the collapse the person just asked for. Nothing is stored or said
 * without an identity.
 */
export function storeStripOpen(
  strip: StripId,
  identity: string | null,
  open: boolean,
  store: Pick<Storage, 'setItem'> | null = browserStorage(),
): void {
  if (identity === null) return;
  try {
    store?.setItem(stripKey(strip, identity), open ? 'open' : 'closed');
  } catch {
    // A private window, or site data blocked: the strip keeps its state for this page only.
  }
  if (typeof window !== 'undefined') {
    const detail: StripChange = { strip, identity, open };
    window.dispatchEvent(new CustomEvent(HOW_THIS_WORKS_CHANGED, { detail }));
  }
}
