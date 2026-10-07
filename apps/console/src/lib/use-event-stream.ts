'use client';

import { useEffect, useRef } from 'react';

/** The first wait before a stream that ended is opened again, doubled each time up to the cap. */
export const RECONNECT_FIRST_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
/** How often a browser with no EventSource reads again instead. */
export const POLL_MS = 5_000;

export interface EventStreamHandlers {
  /** The stream is open, the first time or again: whatever arrived while it was down is read now. */
  onOpen: () => void;
  /** The bridge says something changed. */
  onChanged: () => void;
  /** The stream is not connected, for the panel to say so. */
  onDown: () => void;
}

/**
 * A bot's thread and a work item learn of a change from a stream the console
 * proxies from the bridge, and read again when it says so.
 *
 * A browser retries a stream that drops on its own, but gives up for good on
 * an answer that is not a 200. A bridge restarting answers that — the
 * console's proxy says 500 or 502 while it is down, and so does a reverse
 * proxy while the console restarts — and the browser's retry a second later
 * usually lands in that window. The panel then said it would catch up when
 * the connection was back, and never did. So a stream the browser has closed
 * is opened again here, after a wait that doubles to a cap, so a long outage
 * is not a request a second; the next `open` reads what was missed. An error
 * the browser is retrying itself is only said, never doubled with a second
 * stream.
 *
 * With no EventSource it reads again every five seconds instead.
 */
export function useEventStream(url: string, handlers: EventStreamHandlers): void {
  // The latest handlers, without opening the stream again each render.
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      const timer = setInterval(() => latest.current.onChanged(), POLL_MS);
      return () => clearInterval(timer);
    }

    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let wait = RECONNECT_FIRST_MS;
    let stopped = false;

    const connect = (): void => {
      const stream = new EventSource(url);
      source = stream;
      stream.addEventListener('open', () => {
        wait = RECONNECT_FIRST_MS;
        latest.current.onOpen();
      });
      stream.addEventListener('changed', () => latest.current.onChanged());
      stream.addEventListener('error', () => {
        latest.current.onDown();
        // CONNECTING: the browser is trying again by itself.
        if (stream.readyState !== EventSource.CLOSED || stopped) return;
        stream.close();
        clearTimeout(retry);
        retry = setTimeout(connect, wait);
        wait = Math.min(wait * 2, RECONNECT_MAX_MS);
      });
    };
    connect();

    return () => {
      stopped = true;
      clearTimeout(retry);
      source?.close();
    };
  }, [url]);
}
