// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandsOffView, HandsOffWindowView } from '@/lib/hands-off';
import { HandsOffBadge, TICK_MS } from './hands-off-badge';

/**
 * The hands-off badge in the header (#383): hidden with no window open, the
 * soonest window and how many more with some, gone when its time passes, and
 * Turn off that asks the bridge and reads the windows again. The bridge is
 * the fetcher.
 */

const NOW = Date.parse('2026-11-25T10:00:00.000Z');
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const window = (repo: string, endsAt: string | null): HandsOffWindowView => ({
  repo,
  fullName: `acme/${repo}`,
  setByLogin: 'janedoe',
  setAt: at(-60),
  endsAt,
  duration: endsAt ? '8h' : 'until_off',
});
const view = (windows: HandsOffWindowView[], mayTurnOn = true): HandsOffView => ({ windows, repos: ['api', 'web'], mayTurnOn });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function draw(initial: HandsOffView | null | undefined): Promise<void> {
  await act(async () => root.render(<HandsOffBadge initial={initial} />));
}

const badge = () => host.querySelector('[data-hands-off-badge]');

describe('the hands-off badge', () => {
  it('is hidden with no window open, and shows a quiet button to whoever may turn one on', async () => {
    await draw(view([]));
    expect(badge()).toBeNull();
    expect(host.querySelector('[data-hands-off-start]')?.textContent).toBe('Hands-off');
  });

  it('shows no button to someone who may not turn one on', async () => {
    await draw(view([], false));
    expect(host.innerHTML).toBe('');
  });

  it('shows the soonest window and +1 with two open', async () => {
    await draw(view([window('web', null), window('api', at(372))]));
    expect(badge()?.textContent).toBe('Hands-off · api · 6h 12m+1');
    expect(host.querySelector('[data-hands-off-more]')?.textContent).toBe('+1');
  });

  it('hides once the window’s time passes', async () => {
    await draw(view([window('api', at(1))]));
    expect(badge()?.textContent).toBe('Hands-off · api · 1m');
    await act(async () => {
      vi.setSystemTime(NOW + 2 * 60_000);
      vi.advanceTimersByTime(TICK_MS);
    });
    expect(badge()).toBeNull();
  });

  it('turns a window off with one click, and reads the windows again', async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return Response.json({ ended: { repo: 'api' } });
      return Response.json(view([]));
    });
    vi.stubGlobal('fetch', fetcher);
    await draw(view([window('api', at(120))]));

    await act(async () => (badge() as HTMLButtonElement).click());
    expect(host.querySelectorAll('[data-hands-off-window]')).toHaveLength(1);
    expect(host.querySelector('[data-hands-off-window]')?.textContent).toContain('set by janedoe');
    await act(async () => (host.querySelector('[data-hands-off-turn-off]') as HTMLButtonElement).click());

    expect(fetcher).toHaveBeenCalledWith('/api/hands-off/api', { method: 'DELETE' });
    expect(fetcher).toHaveBeenCalledWith('/api/hands-off', { cache: 'no-store' });
    expect(badge()).toBeNull();
  });

  it('is left out when the read failed, and reads it itself when the page read nothing', async () => {
    await draw(null);
    expect(host.innerHTML).toBe('');

    const fetcher = vi.fn(async () => Response.json(view([window('api', at(30))])));
    vi.stubGlobal('fetch', fetcher);
    await draw(undefined);
    expect(fetcher).toHaveBeenCalledWith('/api/hands-off', { cache: 'no-store' });
    expect(badge()?.textContent).toBe('Hands-off · api · 30m');
  });

  it('draws nothing from a read that is not a list of windows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: [] })));
    await draw(undefined);
    expect(host.innerHTML).toBe('');
  });
});
