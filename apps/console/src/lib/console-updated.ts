/**
 * A page from an older build of the console, open after the console was updated.
 *
 * Next names each server action with an id the build makes up, so a console
 * updated under an open page has none of that page's actions: it answers each
 * with "not found" and runs nothing, and Next rejects the call with
 * `Server Action "<id>" was not found on the server`. On the cloud install the
 * Settings page was open across an update, and Pause work → Confirm showed
 * exactly that in the error screen, with a Try again that sent the same
 * refused id again, and nothing saying the work had not been paused. Only a
 * reload, which loads the new build's ids, makes the page work again.
 *
 * The failure is told by what Next gives it: the error's `name`, which Next
 * sets itself (`UnrecognizedActionError`, a string a minified bundle keeps,
 * where its class's own name is mangled), or its message. Nothing else is
 * read as it, so every other failure is said as before.
 */

/** What a control says when the action it called was refused this way. Nothing ran. */
export const CONSOLE_UPDATED = 'the console was updated since this page loaded, so that was not done. Reload the page, then do it again.';

/** The start of Next's message, should a release stop setting the name. */
const NOT_FOUND = /^Server Action "[^"]*" was not found on the server/;

/** Whether a server action was refused because the console was updated since its page loaded. */
export function isStaleAction(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  return name === 'UnrecognizedActionError' || (typeof message === 'string' && NOT_FOUND.test(message));
}

/**
 * On `window`, so the page says it once however many controls find out:
 * `notice` once it knows, `in-place` once a page's error screen says it
 * instead, with a reload of its own.
 */
const SAID_KEY = '__openadlcConsoleUpdated';
const SAID_EVENT = 'openadlc:console-updated';

function said(): 'notice' | 'in-place' | undefined {
  if (typeof window === 'undefined') return undefined;
  const value = (window as unknown as Record<string, unknown>)[SAID_KEY];
  return value === 'notice' || value === 'in-place' ? value : undefined;
}

function say(how: 'notice' | 'in-place'): void {
  (window as unknown as Record<string, unknown>)[SAID_KEY] = how;
  window.dispatchEvent(new Event(SAID_EVENT));
}

/**
 * Tells the page that the console was updated under it, for the notice that
 * offers the reload (`ConsoleUpdatedNotice`). Once per page: a reload is a
 * new page.
 */
export function sayConsoleUpdated(): void {
  if (typeof window === 'undefined' || said()) return;
  say('notice');
}

/**
 * For the error screen that says it in place of the page (`error.tsx`), with
 * a reload of its own: the notice steps aside, so one button reloads. With
 * both, the screen read "Reload the page" twice.
 */
export function sayConsoleUpdatedInPlace(): void {
  if (typeof window === 'undefined' || said() === 'in-place') return;
  say('in-place');
}

/** Whether this page has learned that the console was updated since it loaded. */
export function consoleWasUpdated(): boolean {
  return said() !== undefined;
}

/** Whether the notice should say it: the page knows, and no error screen says it already. */
export function noticeWanted(): boolean {
  return said() === 'notice';
}

/** Calls `listener` whenever what the page knows of it changes. Returns what stops it. */
export function onConsoleUpdated(listener: () => void): () => void {
  window.addEventListener(SAID_EVENT, listener);
  return () => window.removeEventListener(SAID_EVENT, listener);
}

/** How long a page that knows it is untouched before it reloads itself. */
export const IDLE_RELOAD_MS = 5 * 60_000;

/** What a person does to a page they are using. Each starts the wait again. */
const ACTIVITY = ['keydown', 'pointerdown', 'input'] as const;

/** Whether something a person types into has focus: a draft may be in it. */
function editing(element: Element | null): boolean {
  if (!element) return false;
  if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT') return true;
  return (element as HTMLElement).isContentEditable === true;
}

/**
 * Reloads a page that knows the console was updated once nobody has used it
 * for `idle`. Before the page checked, Next reloaded it by itself at its next
 * read, so a board left open on a wall kept current; holding it for a person
 * to press Reload left that board stale for good. A key, a press or an edit
 * starts the wait again, and so does a field with focus when it ends, so a
 * person in the middle of something keeps it. Returns what stops it.
 */
export function reloadWhenIdle(reload: () => void, page: Document = document, idle = IDLE_RELOAD_MS): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => (editing(page.activeElement) ? wait() : reload()), idle);
  };
  for (const type of ACTIVITY) page.addEventListener(type, wait, true);
  wait();
  return () => {
    clearTimeout(timer);
    for (const type of ACTIVITY) page.removeEventListener(type, wait, true);
  };
}

/** The answer a control shows for an action refused this way, said to the whole page too. */
export function staleActionRefusal(): { ok: false; error: string } {
  sayConsoleUpdated();
  return { ok: false, error: CONSOLE_UPDATED };
}
