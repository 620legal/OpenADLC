// @vitest-environment happy-dom
import { UnrecognizedActionError } from 'next/dist/client/components/unrecognized-action-error';
import { afterEach, describe, expect, it } from 'vitest';
import { consoleWasUpdated } from './console-updated';
import { ACTION_DID_NOT_ANSWER, safeAction } from './safe-action';

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__openadlcConsoleUpdated;
});

describe('a server action called from a button', () => {
  it('answers what the action answered', async () => {
    expect(await safeAction(async () => ({ ok: false, error: 'this needs an admin' }))).toEqual({ ok: false, error: 'this needs an admin' });
    expect(await safeAction(async () => ({ ok: true, bot: 'intake' }))).toEqual({ ok: true, bot: 'intake' });
  });

  it('answers a refusal that says what to do when the call itself fails, rather than rejecting', async () => {
    // Rejected inside a transition, the page was replaced by an error screen.
    const result = await safeAction(async (): Promise<{ ok: boolean; error?: string }> => {
      throw new TypeError('Failed to fetch');
    });
    expect(result).toEqual({ ok: false, error: ACTION_DID_NOT_ANSWER });
    expect(ACTION_DID_NOT_ANSWER).toContain('reload the page');
    expect(consoleWasUpdated()).toBe(false);
  });

  it('says the console was updated and nothing was done when the console no longer has the action, and tells the page', async () => {
    // What Next rejects with once the console was updated under the page: the
    // call never ran, and trying again sends the same id to the same refusal.
    const result = await safeAction(async (): Promise<{ ok: boolean; error?: string }> => {
      throw new UnrecognizedActionError(
        'Server Action "60a4dd1dc477e939b91262212479c9ac135159a0e9" was not found on the server. \nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action',
      );
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('the console was updated since this page loaded, so that was not done');
    expect(result.error).toContain('Reload the page');
    expect(result.error).not.toMatch(/try again/i);
    expect(result.error).not.toContain('60a4dd1d');
    // The notice over the page offers the reload.
    expect(consoleWasUpdated()).toBe(true);
  });
});
