import { isStaleAction, staleActionRefusal } from './console-updated';

/**
 * Calling a server action from a button, without losing the page.
 *
 * The actions catch the bridge's refusals and answer `{ ok: false, error }`,
 * but the call itself still rejects when the console's own server does not
 * answer, was updated under an open tab (its action ids are gone), or a body
 * passes Next's size limit. Inside `startTransition` that rejection went to
 * the nearest error boundary: the whole page was replaced, and what had been
 * typed with it.
 *
 * An update is said apart (`lib/console-updated.ts`): the action did not run,
 * and trying again cannot help, only a reload.
 */
export const ACTION_DID_NOT_ANSWER =
  'the console did not take that: it may be restarting, or it was updated since this page was opened. Try again, or reload the page.';

/** The action's answer, or `{ ok: false, error }` when the call itself failed. Never rejects. */
export async function safeAction<T extends { ok: boolean; error?: string }>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    // Every answer's other fields are optional, so a refusal is one of them.
    if (isStaleAction(error)) return staleActionRefusal() as T;
    return { ok: false, error: ACTION_DID_NOT_ANSWER } as T;
  }
}
