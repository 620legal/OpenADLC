/**
 * Which pages this browser keeps in the console's navigation, the rest being
 * under More. Kept per browser, like the alert switches
 * (`alert-preferences.ts`) and the board's view (`board-state.ts`), and never
 * sent to the bridge (ADR 0080).
 *
 * The stored value is a JSON array of page ids in the order they were
 * pinned. Pinning adds to the end, so the navigation reads in that order.
 */
import { PAGES, type Page } from './header';

export const NAV_PINS_KEY = 'openadlc.nav.pins';

/** What a browser that has stored nothing, or nothing readable, shows. */
export const NAV_PIN_DEFAULTS: readonly Page[] = ['board', 'needs-you', 'crew', 'releases'];

/** Said in this tab after every write, so both bars follow; another tab hears the `storage` event. */
export const NAV_PINS_CHANGED = 'openadlc:nav-pins-changed';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

// Reached inside a `try`: with site data blocked, reading `localStorage` at all throws.
function browserStorage(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const KNOWN = new Set<string>(PAGES.map((one) => one.page));

/**
 * What is pinned. The defaults when nothing is stored, when storage throws,
 * or when the value is not a JSON array. Inside one, an entry that names no
 * page, or repeats an earlier one, is dropped: a page renamed or removed in a
 * later console leaves the rest of the person's choice standing. A stored
 * `[]` is kept: the person unpinned everything, which is a choice.
 */
export function storedPins(store: Pick<Storage, 'getItem'> | null = browserStorage()): Page[] {
  let value: unknown;
  try {
    const raw = store?.getItem(NAV_PINS_KEY);
    if (raw === null || raw === undefined) return [...NAV_PIN_DEFAULTS];
    value = JSON.parse(raw);
  } catch {
    return [...NAV_PIN_DEFAULTS];
  }
  if (!Array.isArray(value)) return [...NAV_PIN_DEFAULTS];
  const pins: Page[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && KNOWN.has(entry) && !pins.includes(entry as Page)) pins.push(entry as Page);
  }
  return pins;
}

function write(pins: readonly Page[], store: Store | null): void {
  try {
    store?.setItem(NAV_PINS_KEY, JSON.stringify(pins));
  } catch {
    // A private window, or site data blocked: the page goes on as it was.
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(NAV_PINS_CHANGED));
}

/** Adds a page to the end of the navigation; nothing when it is already there. */
export function pin(page: Page, store: Store | null = browserStorage()): void {
  const pins = storedPins(store);
  if (pins.includes(page)) return;
  write([...pins, page], store);
}

/** Takes a page out of the navigation, to More; nothing when it is not there. */
export function unpin(page: Page, store: Store | null = browserStorage()): void {
  const pins = storedPins(store);
  if (!pins.includes(page)) return;
  write(
    pins.filter((one) => one !== page),
    store,
  );
}

/**
 * Calls `follow` each time the pins change: in this tab (`pin`, `unpin`),
 * or in another tab of this browser (its `storage` event). Returns the
 * unsubscribe.
 */
export function onPinsChange(follow: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const fromStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === NAV_PINS_KEY) follow();
  };
  window.addEventListener(NAV_PINS_CHANGED, follow);
  window.addEventListener('storage', fromStorage);
  return () => {
    window.removeEventListener(NAV_PINS_CHANGED, follow);
    window.removeEventListener('storage', fromStorage);
  };
}
