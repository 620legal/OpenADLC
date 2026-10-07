import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EARLY_CLICK_KEY, EARLY_CLICKS_SCRIPT, REACT_CONTAINER_KEY, REACT_PROPS_KEY, reactStarted, replayEarlyClick } from './early-clicks';

/**
 * A button pressed before React started is pressed again once it can answer,
 * and one React saw is never pressed twice.
 */

type Listener = (event: { target: unknown }) => void;

/** Runs the head script against a stand-in document, and returns how to click on it. */
function page() {
  let listeners: Listener[] = [];
  const document: Record<string, unknown> = {
    addEventListener: (type: string, listener: Listener, capture: boolean) => {
      expect(type).toBe('click');
      // Capture: a handler below that stops the click must not hide it.
      expect(capture).toBe(true);
      listeners.push(listener);
    },
    removeEventListener: (_type: string, listener: Listener) => {
      listeners = listeners.filter((one) => one !== listener);
    },
  };
  const window: Record<string, unknown> = {};
  new Function('document', 'window', EARLY_CLICKS_SCRIPT)(document, window);
  const click = (target: unknown) => [...listeners].forEach((listener) => listener({ target }));
  return { document, window, click, listening: () => listeners.length };
}

function button(extra: Partial<{ disabled: boolean; isConnected: boolean }> = {}) {
  const made = { disabled: false, isConnected: true, presses: 0, click: () => (made.presses += 1), ...extra };
  return made;
}

/** Something inside a button, as a click's target usually is: its label. */
const inside = (of: object) => ({ closest: (selector: string) => (selector === 'button' ? of : null) });

const now = (next: () => void) => next();

describe('a click before React has started', () => {
  it('is left on a window key in the fleetadlc namespace, the one the head script uses', () => {
    // The last Fleet-era name the console set on the page; the rename missed it.
    expect(EARLY_CLICK_KEY).toBe('__fleetadlcEarlyClick');
    expect(EARLY_CLICKS_SCRIPT).toContain('"__fleetadlcEarlyClick"');
    expect(EARLY_CLICKS_SCRIPT).not.toMatch(/__fleetEarly/);
  });

  it('is noted, by the button it was on, the last one winning', () => {
    const { window, click } = page();
    const first = button();
    const second = button();
    click(inside(first));
    click(inside(second));
    expect(window[EARLY_CLICK_KEY]).toBe(second);
  });

  it('is dropped by the first click after React has started, which React handles, and the script stops listening', () => {
    const { document, window, click, listening } = page();
    click(inside(button()));
    document[`${REACT_CONTAINER_KEY}abc`] = {};
    click(inside(button()));
    expect(window[EARLY_CLICK_KEY]).toBeNull();
    expect(listening()).toBe(0);
  });

  it('is not noted on a disabled button, or on something that is not a button', () => {
    const { window, click } = page();
    click(inside(button({ disabled: true })));
    click({ closest: () => null });
    expect(window[EARLY_CLICK_KEY]).toBeUndefined();
  });
});

describe('pressing it again', () => {
  it('presses the noted button once it answers, and forgets it', () => {
    const target = button();
    const holder: Record<string, unknown> = { [EARLY_CLICK_KEY]: target };
    let hydrated = false;
    let waits = 0;
    replayEarlyClick(holder, {
      answers: () => hydrated,
      wait: (next) => {
        waits += 1;
        if (waits === 3) hydrated = true;
        next();
      },
    });
    expect(target.presses).toBe(1);
    expect(holder[EARLY_CLICK_KEY]).toBeNull();

    replayEarlyClick(holder, { answers: () => true, wait: now });
    expect(target.presses).toBe(1);
  });

  it('does not press it when a click React handled cleared the note while it waited', () => {
    // The person pressed again once the page was live: that press counts, not
    // this one, or "Show more" opens and closes.
    const target = button();
    const holder: Record<string, unknown> = { [EARLY_CLICK_KEY]: target };
    let waits = 0;
    replayEarlyClick(holder, {
      answers: () => waits > 1,
      wait: (next) => {
        waits += 1;
        holder[EARLY_CLICK_KEY] = null;
        next();
      },
    });
    expect(target.presses).toBe(0);
  });

  it('presses one React has hydrated, by the props it attached', () => {
    const target = Object.assign(button(), { [`${REACT_PROPS_KEY}abc`]: {} });
    replayEarlyClick({ [EARLY_CLICK_KEY]: target }, { wait: now });
    expect(target.presses).toBe(1);
  });

  it('leaves alone a button that has gone or been disabled since', () => {
    const gone = button({ isConnected: false });
    const disabled = button({ disabled: true });
    replayEarlyClick({ [EARLY_CLICK_KEY]: gone }, { answers: () => true, wait: now });
    replayEarlyClick({ [EARLY_CLICK_KEY]: disabled }, { answers: () => true, wait: now });
    expect(gone.presses + disabled.presses).toBe(0);
  });

  it('gives up on one that never answers', () => {
    const target = button();
    let waits = 0;
    replayEarlyClick({ [EARLY_CLICK_KEY]: target }, { answers: () => false, tries: 5, wait: (next) => (waits++, next()) });
    expect(target.presses).toBe(0);
    expect(waits).toBe(4);
  });

  it('presses nothing, and says so, when React did not mark the document it started on', () => {
    const target = button();
    const said: string[] = [];
    replayEarlyClick({ [EARLY_CLICK_KEY]: target }, { started: false, answers: () => true, wait: now, warn: (line) => said.push(line) });
    expect(target.presses).toBe(0);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(REACT_CONTAINER_KEY);
    expect(reactStarted({ [`${REACT_CONTAINER_KEY}x`]: {} })).toBe(true);
    expect(reactStarted({})).toBe(false);
  });
});

describe('the React this console runs', () => {
  // The console has no DOM to hydrate a real tree in, so the keys are read
  // from the react-dom Next ships to the browser: a React that renames them
  // fails here rather than quietly turning the replay off.
  it('still marks the container and each hydrated element with the keys this reads', () => {
    const require = createRequire(import.meta.url);
    const next = dirname(require.resolve('next/package.json'));
    for (const build of ['react-dom-client.production.js', 'react-dom-client.development.js']) {
      const source = readFileSync(join(next, 'dist/compiled/react-dom/cjs', build), 'utf8');
      expect(source).toContain(`"${REACT_CONTAINER_KEY}"`);
      expect(source).toContain(`"${REACT_PROPS_KEY}"`);
    }
  });
});
