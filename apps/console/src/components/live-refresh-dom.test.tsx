// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REFRESH_EVERY_MS } from '@/lib/live-refresh';
import { LiveRefresh } from './live-refresh';

/**
 * A page open while the bridge stops: it keeps what it shows and says since
 * when, and says nothing more once the bridge answers again.
 */

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
const probe = vi.hoisted(() => ({ bridge: true, calls: 0 }));
vi.mock('@/app/actions', () => ({
  consoleServesThisPage: vi.fn(async () => {
    probe.calls += 1;
    return { ok: true, bridge: probe.bridge };
  }),
}));

const reload = vi.fn();
let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload } as Location);
  probe.bridge = true;
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
});

async function wait(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(REFRESH_EVERY_MS);
  });
}

function banner(): string | null {
  return container.querySelector('[role="status"]')?.textContent ?? null;
}

const clock = (at: number) =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));

describe('a page open while the bridge does not answer', () => {
  it('shows the banner within one refresh, with the time it was last read, and keeps the page', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-02T14:02:00'));
    const loaded = Date.now();
    await act(async () => root.render(<LiveRefresh />));
    expect(banner()).toBeNull();

    probe.bridge = false;
    await wait();

    expect(banner()).toBe(`Can't reach OpenADLC since ${clock(loaded)}. What you see may be out of date.`);
    // A read would have drawn "cannot reach the bridge" over the page.
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('clears it on the first read after the bridge is back, with no reload', async () => {
    vi.useFakeTimers();
    await act(async () => root.render(<LiveRefresh />));
    await wait();
    expect(router.refresh).toHaveBeenCalledTimes(1);

    probe.bridge = false;
    await wait();
    await wait();
    expect(banner()).toContain("Can't reach OpenADLC since");

    probe.bridge = true;
    await wait();
    expect(banner()).toBeNull();
    expect(router.refresh).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
  });

  // A tab in the background keeps reading, so its title and icon can say that
  // something needs a person (#222); it says the bridge is gone the same way.
  it('keeps asking from a tab in the background, and shows the banner within one refresh', async () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => root.render(<LiveRefresh />));
    await wait();
    expect(probe.calls).toBe(1);
    expect(router.refresh).toHaveBeenCalledTimes(1);

    probe.bridge = false;
    await wait();
    expect(probe.calls).toBe(2);
    expect(banner()).toContain("Can't reach OpenADLC since");
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });
});
