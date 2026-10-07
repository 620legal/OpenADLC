import { describe, expect, it } from 'vitest';
import { ACTION_DID_NOT_ANSWER, safeAction } from './safe-action';

describe('a server action called from a button', () => {
  it('answers what the action answered', async () => {
    expect(await safeAction(async () => ({ ok: false, error: 'this needs an admin' }))).toEqual({ ok: false, error: 'this needs an admin' });
    expect(await safeAction(async () => ({ ok: true, bot: 'intake' }))).toEqual({ ok: true, bot: 'intake' });
  });

  it('answers a refusal that says what to do when the call itself fails, rather than rejecting', async () => {
    // Rejected inside a transition, the page was replaced by an error screen.
    const result = await safeAction(async (): Promise<{ ok: boolean; error?: string }> => {
      throw new Error('Failed to find Server Action "7f3a". This request might be from an older or newer deployment.');
    });
    expect(result).toEqual({ ok: false, error: ACTION_DID_NOT_ANSWER });
    expect(ACTION_DID_NOT_ANSWER).toContain('reload the page');
  });
});
