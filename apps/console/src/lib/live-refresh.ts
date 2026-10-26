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

/**
 * One read of the page, unless the console was updated since it loaded.
 *
 * Once a read reaches a new build of the console, Next reloads the whole page
 * by itself, without a word, and until that read every action of the page is
 * refused (`lib/console-updated.ts`): a person who pressed Pause work in the
 * seconds between got Next's raw "Server Action … was not found on the
 * server", and the work was not paused. So `probe`, an action that does
 * nothing, goes first. Refused that way, the page is not read (the read would
 * reload it under whoever is on it) and the answer is `updated`, for the page
 * to say so and offer the reload. Any other failure, such as no answer while
 * the console restarts, is left to the read, which meets it as it did before.
 */
export async function readUnlessUpdated(probe: () => Promise<unknown>, read: () => void): Promise<'read' | 'updated'> {
  try {
    await probe();
  } catch (error) {
    if (isStaleAction(error)) return 'updated';
  }
  read();
  return 'read';
}
