// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECONNECT_FIRST_MS, RECONNECT_MAX_MS, useEventStream } from './use-event-stream';

/**
 * A stream that ends is opened again: after a bridge restart the browser's
 * own retry is answered 500 or 502, and a browser gives up on that for good.
 */

/** An EventSource the test drives: each one made, and the events it is sent. */
class FakeEventSource {
  static made: FakeEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = FakeEventSource.CONNECTING;
  closed = false;
  private listeners = new Map<string, (() => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.made.push(this);
  }
  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  /** An event, with the readyState the browser would have set by then. */
  emit(type: string, readyState?: number): void {
    if (readyState !== undefined) this.readyState = readyState;
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
}

let root: Root;
let said: string[];

function Probe({ url }: { url: string }) {
  useEventStream(url, {
    onOpen: () => said.push('open'),
    onChanged: () => said.push('changed'),
    onDown: () => said.push('down'),
  });
  return null;
}

const draw = (url = '/api/thread/builder/stream') => act(() => root.render(createElement(Probe, { url })));
const latest = () => FakeEventSource.made[FakeEventSource.made.length - 1]!;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  FakeEventSource.made = [];
  said = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  root = createRoot(document.createElement('div'));
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a stream that ends', () => {
  it('is opened again after a wait once the browser has closed it, and its open reads again', async () => {
    draw();
    latest().emit('open', FakeEventSource.OPEN);
    // The bridge restarts; the browser's retry gets a 502 and closes the stream.
    latest().emit('error', FakeEventSource.CLOSED);
    expect(said).toEqual(['open', 'down']);
    expect(FakeEventSource.made).toHaveLength(1);

    await act(async () => vi.advanceTimersByTimeAsync(RECONNECT_FIRST_MS));
    expect(FakeEventSource.made).toHaveLength(2);
    expect(latest().url).toBe('/api/thread/builder/stream');
    latest().emit('open', FakeEventSource.OPEN);
    expect(said).toEqual(['open', 'down', 'open']);
  });

  it('waits longer each time it fails again, up to a cap, and from the start once one opens', async () => {
    draw();
    const waits: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const before = FakeEventSource.made.length;
      latest().emit('error', FakeEventSource.CLOSED);
      let waited = 0;
      while (FakeEventSource.made.length === before) {
        await act(async () => vi.advanceTimersByTimeAsync(500));
        waited += 500;
      }
      waits.push(waited);
    }
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, RECONNECT_MAX_MS, RECONNECT_MAX_MS]);

    latest().emit('open', FakeEventSource.OPEN);
    latest().emit('error', FakeEventSource.CLOSED);
    await act(async () => vi.advanceTimersByTimeAsync(RECONNECT_FIRST_MS));
    expect(latest().readyState).toBe(FakeEventSource.CONNECTING);
    expect(FakeEventSource.made).toHaveLength(9);
  });

  it('opens no second stream while the browser is retrying by itself', async () => {
    draw();
    latest().emit('error', FakeEventSource.CONNECTING);
    expect(said).toEqual(['down']);
    await act(async () => vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS * 2));
    expect(FakeEventSource.made).toHaveLength(1);
    expect(FakeEventSource.made[0]!.closed).toBe(false);
  });

  it('is not opened again once the panel closes, or after it moves to another stream', async () => {
    draw();
    latest().emit('error', FakeEventSource.CLOSED);
    draw('/api/thread/reviewer/stream');
    // The reconnect for the first is let go; the new stream is the only one.
    await act(async () => vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS));
    expect(FakeEventSource.made.map((one) => one.url)).toEqual(['/api/thread/builder/stream', '/api/thread/reviewer/stream']);

    latest().emit('error', FakeEventSource.CLOSED);
    act(() => root.unmount());
    root = createRoot(document.createElement('div'));
    await act(async () => vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS));
    expect(FakeEventSource.made).toHaveLength(2);
    expect(FakeEventSource.made.every((one) => one.closed)).toBe(true);
  });
});
