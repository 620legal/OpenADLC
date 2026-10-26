// @vitest-environment happy-dom
import { UnrecognizedActionError } from 'next/dist/client/components/unrecognized-action-error';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REFRESH_EVERY_MS } from '@/lib/live-refresh';
import { IDLE_RELOAD_MS, sayConsoleUpdated } from '@/lib/console-updated';
import { ConsoleUpdatedNotice } from './console-updated';
import { LiveRefresh } from './live-refresh';

/**
 * A page from an older build, open after the console was updated: it says so
 * over whatever page it is, with a reload, before anyone presses a button it
 * would refuse.
 */

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
const probe = vi.hoisted(() => ({ refused: false, calls: 0 }));
vi.mock('@/app/actions', () => ({
  consoleServesThisPage: vi.fn(async () => {
    probe.calls += 1;
    if (probe.refused) {
      throw new UnrecognizedActionError(
        'Server Action "7f3a9c" was not found on the server. \nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action',
      );
    }
    return { ok: true };
  }),
}));

const reload = vi.fn();
let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload } as Location);
  probe.refused = false;
  probe.calls = 0;
  router.refresh.mockClear();
  reload.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (window as unknown as Record<string, unknown>).__openadlcConsoleUpdated;
});

function reloadButton(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((one) => one.textContent?.trim() === 'Reload the page');
}

/** Fifteen seconds on screen, and the reads they start. */
async function wait(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(REFRESH_EVERY_MS);
  });
}

describe('the notice that the console was updated', () => {
  it('says nothing until the page learns it, then offers the reload', async () => {
    await act(async () => root.render(<ConsoleUpdatedNotice />));
    expect(container.textContent).toBe('');

    await act(async () => sayConsoleUpdated());
    expect(container.textContent).toContain('The console was updated since this page loaded');
    reloadButton()!.click();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('shows at once on a part of the page drawn after it was learned', async () => {
    sayConsoleUpdated();
    await act(async () => root.render(<ConsoleUpdatedNotice />));
    expect(reloadButton()).toBeDefined();
  });
});

describe('a page reading itself again', () => {
  it('reads as before while the console has its actions', async () => {
    vi.useFakeTimers();
    await act(async () => root.render(<><LiveRefresh /><ConsoleUpdatedNotice /></>));
    await wait();
    await wait();
    expect(probe.calls).toBe(2);
    expect(router.refresh).toHaveBeenCalledTimes(2);
    expect(reloadButton()).toBeUndefined();
  });

  it('says the console was updated instead of reading itself once its actions are refused, and stops asking', async () => {
    vi.useFakeTimers();
    await act(async () => root.render(<><LiveRefresh /><ConsoleUpdatedNotice /></>));
    await wait();
    expect(router.refresh).toHaveBeenCalledTimes(1);

    // The console restarts on a new build.
    probe.refused = true;
    await wait();
    // Next would have reloaded the whole page under the person for this read.
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('The console was updated since this page loaded');
    expect(reloadButton()).toBeDefined();

    await wait();
    await wait();
    expect(probe.calls).toBe(2);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('a page nobody is using, once the console was updated under it', () => {
  // Before the page checked, Next reloaded it at its next read; held for a
  // person who is not there, a board on a wall stayed stale for good.
  const MINUTE = 60_000;

  async function pass(ms: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  async function shown(): Promise<void> {
    vi.useFakeTimers();
    await act(async () => root.render(<ConsoleUpdatedNotice />));
    await act(async () => sayConsoleUpdated());
    expect(reloadButton()).toBeDefined();
  }

  it('reloads itself after five minutes untouched', async () => {
    await shown();
    expect(IDLE_RELOAD_MS).toBe(5 * MINUTE);
    await pass(5 * MINUTE - 1);
    expect(reload).not.toHaveBeenCalled();
    await pass(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('waits five minutes from the last thing a person did on it', async () => {
    await shown();
    const field = document.createElement('input');
    container.appendChild(field);

    await pass(4 * MINUTE);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await pass(1 * MINUTE);
    expect(reload).not.toHaveBeenCalled();

    await pass(3 * MINUTE);
    document.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await pass(4 * MINUTE);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    await pass(5 * MINUTE - 1);
    expect(reload).not.toHaveBeenCalled();
    await pass(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload under a field that has focus, where a draft may be', async () => {
    await shown();
    const draft = document.createElement('textarea');
    container.appendChild(draft);
    draft.focus();

    await pass(9 * MINUTE);
    expect(reload).not.toHaveBeenCalled();

    // Five minutes from when it last found the field in use.
    draft.blur();
    await pass(1 * MINUTE);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
