// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Take-over in a DOM: attaching again after a socket failed lets go of the
 * terminal the failed attach drew, rather than drawing a second over it.
 */

vi.mock('@/app/actions', () => ({ requestAttachToken: vi.fn(async () => ({ ok: true, token: 'token-1' })) }));

const drawn = vi.hoisted(() => [] as { disposed: boolean }[]);
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    disposed = false;
    constructor() {
      drawn.push(this);
    }
    loadAddon() {}
    open() {}
    focus() {}
    write() {}
    onData() {}
    onResize() {}
    dispose() {
      this.disposed = true;
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));

const sockets: FakeSocket[] = [];
class FakeSocket {
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor() {
    sockets.push(this);
  }
  send() {}
  addEventListener() {}
  close() {
    this.closed = true;
  }
}

afterEach(() => {
  document.body.innerHTML = '';
  drawn.length = 0;
  sockets.length = 0;
  vi.unstubAllGlobals();
});

describe('attaching again after the socket failed', () => {
  it('lets go of the last terminal and its socket first', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('WebSocket', FakeSocket);
    const { Terminal } = await import('./terminal');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<Terminal bot="builder" session="implement-aaaa" />));

    const press = async (label: string) => {
      const found = [...host.querySelectorAll('button')].find((one) => one.textContent?.trim() === label)!;
      await act(async () => found.click());
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    };

    await press('take over');
    expect(drawn).toHaveLength(1);
    await act(async () => sockets[0]!.onerror?.());
    expect(host.textContent).toContain('attach again');

    await press('attach again');
    // Overwritten in place, the first never had dispose called: its timers
    // and its keystroke handler lived on, one more for every retry.
    expect(drawn).toHaveLength(2);
    expect(drawn[0]!.disposed).toBe(true);
    expect(sockets[0]!.closed).toBe(true);
    expect(drawn[1]!.disposed).toBe(false);
    act(() => root.unmount());
  });
});
