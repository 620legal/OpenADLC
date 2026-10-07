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
