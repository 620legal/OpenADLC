/**
 * A click on a button before React has started, pressed again once it has.
 *
 * Every page is drawn on the server, so its buttons are on screen before the
 * script that makes them do anything has run. React replays a click that
 * arrives while it is hydrating, but not one from before it started: until
 * then there is no listener at all, and the click is simply lost. That window
 * is short with the scripts cached and a good second right after a deploy,
 * when each page's scripts are new, and it is when a person who has just
 * opened a page presses the thing they came for. "The first click does
 * nothing, the second works" was this, on settings and on the board alike.
 *
 * So a script in the document's head, which runs before anything else, notes
 * the last button pressed while React had not started, and the root layout
 * presses it once that button can answer. Only a `<button>` and only its
 * click: a native select or checkbox changed that early keeps what it shows
 * but gets no `onChange`, and a control that acts on `mousedown` (Radix's tab
 * triggers) is not pressed by a replayed click. Links need none of this: a
 * browser follows one without any script.
 *
 * Nothing is pressed twice. The first click after React has started, which
 * React handles itself, drops the note; and the replay presses the button
 * only while the note still names it.
 *
 * It reads two of React's own expando keys, which are not an API:
 * `__reactContainer$…`, which `hydrateRoot(document)` puts on the document
 * when React starts, and `__reactProps$…`, which it puts on each element it
 * has hydrated. `early-clicks.test.ts` fails if the installed react-dom stops
 * writing either, and the replay turns itself off, saying so once in the
 * browser's console, when the document never gets the first.
 */

/** Where the head script leaves the button, for the layout to find. */
export const EARLY_CLICK_KEY = '__fleetadlcEarlyClick';

/** React's key on the container it rendered into, `hydrateRoot(document)` here. */
export const REACT_CONTAINER_KEY = '__reactContainer$';
/** React's key on each element it has hydrated, holding its props. */
export const REACT_PROPS_KEY = '__reactProps$';

/**
 * Inlined into the document head, so it is a string: it runs before any
 * bundle has loaded, as `THEME_SCRIPT` does. The first click it sees after
 * React has started clears the note — React saw that one, and a button noted
 * earlier and pressed again would fire twice — and it stops listening.
 */
export const EARLY_CLICKS_SCRIPT = `(function(){var K=${JSON.stringify(EARLY_CLICK_KEY)};function on(e){try{if(Object.keys(document).some(function(k){return k.indexOf(${JSON.stringify(REACT_CONTAINER_KEY)})===0})){window[K]=null;document.removeEventListener("click",on,true);return;}var t=e.target,b=t&&t.closest?t.closest("button"):null;if(!b||b.disabled)return;window[K]=b;}catch(x){}}document.addEventListener("click",on,true);})();`;

/** The part of a button this needs, so a test can hand it a stand-in. */
export interface Pressable {
  readonly isConnected: boolean;
  readonly disabled?: boolean;
  click(): void;
}

/** Whether React has attached a button's handlers, which it does as it hydrates that part of the page. */
export function answers(button: object): boolean {
  return Object.keys(button).some((key) => key.startsWith(REACT_PROPS_KEY));
}

/** Whether React has started on this document, by the key it marks it with. */
export function reactStarted(doc: object): boolean {
  return Object.keys(doc).some((key) => key.startsWith(REACT_CONTAINER_KEY));
}

/**
 * Presses the button noted before React started, once it answers. A part of
 * the page that is still hydrating is waited for, a little; a button that has
 * gone or been disabled since is left alone, because what it offered is no
 * longer what is on screen, and so is one whose note a later click cleared.
 *
 * Called once React has started. When the document does not carry React's
 * key even then, React has changed how it marks it; nothing is pressed, and
 * `warn` says so, rather than a replay that guesses.
 */
export function replayEarlyClick(
  holder: Record<string, unknown>,
  options: {
    started?: boolean;
    warn?: (message: string) => void;
    wait?: (next: () => void) => void;
    tries?: number;
    answers?: (button: object) => boolean;
  } = {},
): void {
  const button = holder[EARLY_CLICK_KEY] as Pressable | null | undefined;
  if (!button) return;
  if (options.started === false) {
    holder[EARLY_CLICK_KEY] = null;
    options.warn?.(
      `[fleetadlc] React no longer marks the document with ${REACT_CONTAINER_KEY}, so a click made before the page ` +
        'was ready is not pressed again (lib/early-clicks.ts).',
    );
    return;
  }
  const wait = options.wait ?? ((next) => setTimeout(next, 25));
  const ready = options.answers ?? answers;
  let left = options.tries ?? 80;
  const attempt = (): void => {
    // A click since, which React handled, cleared the note: that was the press.
    if (holder[EARLY_CLICK_KEY] !== button) return;
    if (!button.isConnected || button.disabled) {
      holder[EARLY_CLICK_KEY] = null;
      return;
    }
    if (ready(button)) {
      holder[EARLY_CLICK_KEY] = null;
      button.click();
      return;
    }
    if (--left > 0) wait(attempt);
    else holder[EARLY_CLICK_KEY] = null;
  };
  attempt();
}
