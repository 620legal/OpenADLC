// @vitest-environment happy-dom
import { unstable_isUnrecognizedActionError } from 'next/navigation';
import { UnrecognizedActionError } from 'next/dist/client/components/unrecognized-action-error';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_NOT_ANSWERING } from './reach';
import {
  CONSOLE_UPDATED,
  consoleWasUpdated,
  isStaleAction,
  noticeWanted,
  onConsoleUpdated,
  sayConsoleUpdated,
  sayConsoleUpdatedInPlace,
  staleActionRefusal,
} from './console-updated';

/**
 * What Next rejected Pause work → Confirm with on the cloud install, word for
 * word, from the class its router throws it as.
 */
const SAID = 'Server Action "60a4dd1dc477e939b91262212479c9ac135159a0e9" was not found on the server. \nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action';

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__openadlcConsoleUpdated;
});

describe('an action refused because the console was updated since its page loaded', () => {
  it('is told by the error Next rejects it with', () => {
    const refused = new UnrecognizedActionError(SAID);
    // Next's own test agrees this is the one it means.
    expect(unstable_isUnrecognizedActionError(refused)).toBe(true);
    expect(isStaleAction(refused)).toBe(true);
  });

  it('is told in a built bundle too, where the class is renamed and only the name Next sets survives', () => {
    // A production bundle names the class `r`; `name` is a string Next assigns.
    expect(isStaleAction(Object.assign(new Error('whatever it says'), { name: 'UnrecognizedActionError' }))).toBe(true);
    // And by Next's words alone, should a release stop setting the name.
    expect(isStaleAction(new Error(SAID))).toBe(true);
  });

  it('is not every other failure, which is said as before', () => {
    for (const other of [
      new TypeError('Failed to fetch'),
      new Error('An unexpected response was received from the server.'),
      new Error(BRIDGE_NOT_ANSWERING),
      new Error('this needs an admin'),
      new Error('the bridge said Server Action "x" was not found on the server'),
      'Server Action "x" was not found on the server',
      null,
      undefined,
    ]) {
      expect(isStaleAction(other)).toBe(false);
    }
  });

  it('says that nothing was done, and that a reload is what helps, not trying again', () => {
    expect(CONSOLE_UPDATED).toContain('updated since this page loaded');
    expect(CONSOLE_UPDATED).toContain('not done');
    expect(CONSOLE_UPDATED).toContain('Reload the page');
    expect(CONSOLE_UPDATED).not.toMatch(/try again/i);
  });

  it('is said to the whole page once, however many controls find out', () => {
    const heard = vi.fn();
    const stop = onConsoleUpdated(heard);
    expect(consoleWasUpdated()).toBe(false);

    expect(staleActionRefusal()).toEqual({ ok: false, error: CONSOLE_UPDATED });
    sayConsoleUpdated();
    expect(consoleWasUpdated()).toBe(true);
    expect(noticeWanted()).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
  });

  it('leaves the saying to an error screen that says it in place of the page, with its own reload', () => {
    sayConsoleUpdated();
    sayConsoleUpdatedInPlace();
    expect(consoleWasUpdated()).toBe(true);
    expect(noticeWanted()).toBe(false);
    // A control finding out after does not bring a second reload back.
    sayConsoleUpdated();
    expect(noticeWanted()).toBe(false);
  });
});
