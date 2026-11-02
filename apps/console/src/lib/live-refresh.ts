import { isStaleAction } from './console-updated';

/**
 * Keeping a page current without a reload.
 *
 * "Needs you", the chip in the header and the board were read once, when the
 * page was: a question a bot asked, or an answer landing, showed only after a
 * reload. There is no stream of the board to subscribe to — a bot's thread has
 * one, and the thread panel uses it — so the page is read again on a timer,
 * and only while somebody can see it: a tab in the background asks nothing,
 * and one brought back after a while is read again at once.
 */

export const REFRESH_EVERY_MS = 15_000;

/** The part of `document` this needs, so a test can hand it a stand-in. */
export interface Visibility {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/** Calls `refresh` every `every` milliseconds while `page` is visible. Returns what stops it. */
export function refreshWhileVisible(
  refresh: () => void,
  page: Visibility,
  options: { every?: number; now?: () => number } = {},
): () => void {
  const every = options.every ?? REFRESH_EVERY_MS;
  const now = options.now ?? Date.now;
  let last = now();
  let timer: ReturnType<typeof setInterval> | null = null;

  const read = (): void => {
    last = now();
    refresh();
  };
  const start = (): void => {
    if (timer === null) timer = setInterval(read, every);
  };
  const stop = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const onVisibility = (): void => {
    if (page.visibilityState !== 'visible') return stop();
    // Back after longer than one wait: what it shows is that old already.
    if (now() - last >= every) read();
    start();
  };

  if (page.visibilityState === 'visible') start();
  page.addEventListener('visibilitychange', onVisibility);
  return () => {
    stop();
    page.removeEventListener('visibilitychange', onVisibility);
  };
}

/** What one tick of the live refresh came to. */
export type ReadOutcome = 'read' | 'updated' | 'unreachable';

/**
 * One read of the page, unless the console was updated since it loaded, or
 * the bridge is not answering.
 *
 * Once a read reaches a new build of the console, Next reloads the whole page
 * by itself, without a word, and until that read every action of the page is
 * refused (`lib/console-updated.ts`): a person who pressed Pause work in the
 * seconds between got Next's raw "Server Action … was not found on the
 * server", and the work was not paused. So `probe`, an action that asks the
 * bridge who is asking and nothing more, goes first. Refused that way, the
 * page is not read (the read would reload it under whoever is on it) and the
 * answer is `updated`, for the page to say so and offer the reload.
 *
 * A probe that says the bridge gave no answer is `unreachable`, and the page
 * is not read either: `router.refresh()` reports nothing, and the board's
 * page meets a failed read by drawing the full-page "cannot reach the
 * bridge" screen, so a refresh during an outage replaced the board with it
 * rather than saying what is on screen may be out of date. Any other failure,
 * such as no answer while the console itself restarts, is left to the read,
 * which meets it as it did before.
 */
export async function readUnlessUpdated(probe: () => Promise<unknown>, read: () => void): Promise<ReadOutcome> {
  try {
    const answer = await probe();
    if (typeof answer === 'object' && answer !== null && (answer as { bridge?: unknown }).bridge === false) return 'unreachable';
  } catch (error) {
    if (isStaleAction(error)) return 'updated';
  }
  read();
  return 'read';
}

/**
 * Whether the page is showing what the bridge last said, and since when.
 * `lastReadAt` is the last tick whose probe the bridge answered, the page's
 * load counting as the first; `offlineSince` is the first tick it did not,
 * and null while it answers.
 */
export interface OfflineState {
  lastReadAt: number;
  offlineSince: number | null;
}

export function offlineState(previous: OfflineState, outcome: ReadOutcome, now: number): OfflineState {
  if (outcome === 'read') return { lastReadAt: now, offlineSince: null };
  if (outcome === 'unreachable') return { lastReadAt: previous.lastReadAt, offlineSince: previous.offlineSince ?? now };
  return previous;
}
