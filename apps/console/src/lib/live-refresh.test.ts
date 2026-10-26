import { UnrecognizedActionError } from 'next/dist/client/components/unrecognized-action-error';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readUnlessUpdated, REFRESH_EVERY_MS, refreshWhileVisible, type Visibility } from './live-refresh';

/** A tab, which can be put in the background and brought back. */
function tab(initially: 'visible' | 'hidden' = 'visible') {
  const listeners = new Set<() => void>();
  const page: Visibility & { set: (state: 'visible' | 'hidden') => void; listening: () => number } = {
    visibilityState: initially,
    addEventListener: (_type, listener) => void listeners.add(listener),
    removeEventListener: (_type, listener) => void listeners.delete(listener),
    set(state) {
      (this as { visibilityState: string }).visibilityState = state;
      for (const listener of listeners) listener();
    },
    listening: () => listeners.size,
  };
  return page;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('keeping a page current', () => {
  it('reads it again every fifteen seconds while it is on screen', () => {
    const refresh = vi.fn();
    refreshWhileVisible(refresh, tab());

    vi.advanceTimersByTime(REFRESH_EVERY_MS - 1);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(REFRESH_EVERY_MS * 3);
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  it('asks nothing while the tab is in the background, and reads it at once when it is back after a while', () => {
    const refresh = vi.fn();
    const page = tab();
    refreshWhileVisible(refresh, page);

    page.set('hidden');
    vi.advanceTimersByTime(REFRESH_EVERY_MS * 4);
    expect(refresh).not.toHaveBeenCalled();

    page.set('visible');
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(REFRESH_EVERY_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('does not read it again for a glance away shorter than the wait', () => {
    const refresh = vi.fn();
    const page = tab();
    refreshWhileVisible(refresh, page);

    vi.advanceTimersByTime(3_000);
    page.set('hidden');
    page.set('visible');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('stops when the page goes', () => {
    const refresh = vi.fn();
    const page = tab();
    const stop = refreshWhileVisible(refresh, page);
    stop();

    vi.advanceTimersByTime(REFRESH_EVERY_MS * 2);
    expect(refresh).not.toHaveBeenCalled();
    expect(page.listening()).toBe(0);
  });
});

describe('a read of a page the console may have been updated under', () => {
  it('is made once the console answers the page\'s own action', async () => {
    const read = vi.fn();
    expect(await readUnlessUpdated(async () => ({ ok: true }), read)).toBe('read');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('is not made once the console refuses that action as one it does not have', async () => {
    // Made, it reached the new build, and Next reloaded the page under
    // whoever was on it, without a word.
    const read = vi.fn();
    const outcome = await readUnlessUpdated(async () => {
      throw new UnrecognizedActionError('Server Action "7f3a9c" was not found on the server. \nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action');
    }, read);
    expect(outcome).toBe('updated');
    expect(read).not.toHaveBeenCalled();
  });

  it('is made as before when the action fails some other way, such as no answer while the console restarts', async () => {
    const read = vi.fn();
    expect(
      await readUnlessUpdated(async () => {
        throw new TypeError('Failed to fetch');
      }, read),
    ).toBe('read');
    expect(read).toHaveBeenCalledTimes(1);
  });
});
