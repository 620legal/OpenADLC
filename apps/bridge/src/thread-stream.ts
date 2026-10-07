import { threads } from '@fleetadlc/db';

/**
 * Tells open thread panels and item views when something happened, so they do
 * not have to ask.
 *
 * The panel used to `setInterval(load, 5000)`: a request every five seconds per
 * open panel whether or not anything had changed, about seventeen thousand of
 * them for a console left open overnight, and up to a five second wait to see a
 * bot's answer.
 *
 * What replaced it is not a push from the writers. Thread messages are written
 * from several places — the console's own POST, a task reporting through
 * `/internal/tasks/:id/message`, the seed, the dispatcher — and an emitter
 * every one of them has to remember to call is a mechanism that silently stops
 * covering whichever writer is added next. So this watches the database
 * instead, which cannot be bypassed.
 *
 * What that buys:
 *
 * - one watcher per *key* — a bot (`bot:<id>`) or a work item
 *   (`item:<canonical subject>`) — not per open panel, so a second person
 *   opening the same panel costs nothing;
 * - no watcher at all when nobody is looking, because the interval is
 *   reference-counted and stops with the last subscriber;
 * - a probe that reads two numbers rather than two hundred rows;
 * - and a second of latency instead of five, over a connection that stays open.
 */
const PROBE_MS = 1_000;

/** Reads where what a key watches is now, as one string; a change in it is a change worth telling. */
export type Probe = () => Promise<string>;

/** A bot's threads, as the per-bot panel watches them. */
export function botProbe(botId: string): Probe {
  return async () => {
    const { latest, count } = await threads.threadWatermark(botId);
    return `${latest}:${count}`;
  };
}

interface Watcher {
  probe: Probe;
  timer: ReturnType<typeof setInterval>;
  subscribers: Set<(watermark: string) => void>;
  last: string;
  /**
   * Whether `last` has ever been read. The first probe records where the
   * threads are and says nothing: a panel loads on connect anyway, so
   * announcing a change the instant it subscribes is a second read of the same
   * data.
   */
  primed: boolean;
  /**
   * Settles once the first probe has. It runs as the first panel subscribes,
   * not one interval later: a baseline read a second after the panel loaded
   * took in whatever a bot wrote in that second, and it was never announced.
   */
  ready: Promise<void>;
}

export class WatermarkStream {
  private readonly watchers = new Map<string, Watcher>();

  constructor(private readonly probeMs = PROBE_MS) {}

  /**
   * Calls back with a new watermark whenever what `key` watches changes.
   *
   * The first subscriber's `probe` is the key's: a second subscriber to the
   * same key is watching the same thing, and a second probe would be the
   * per-panel cost this exists to remove. The returned function unsubscribes,
   * and stopping the last subscriber stops the database probe — a stream
   * nobody is listening to should not keep asking.
   */
  subscribe(key: string, probe: Probe, onChange: (watermark: string) => void): () => void {
    const existing = this.watchers.get(key);
    if (existing) {
      existing.subscribers.add(onChange);
      return () => this.unsubscribe(key, onChange);
    }

    const watcher: Watcher = {
      probe,
      subscribers: new Set([onChange]),
      last: '',
      primed: false,
      ready: Promise.resolve(),
      timer: setInterval(() => void this.probe(key), this.probeMs),
    };
    // `unref` so a watcher never holds the process open on shutdown.
    watcher.timer.unref?.();
    this.watchers.set(key, watcher);
    watcher.ready = this.probe(key);
    return () => this.unsubscribe(key, onChange);
  }

  /**
   * Resolves once `key` has a baseline. A stream route awaits it before it
   * answers 200, because the panel re-reads on `open`: with the baseline taken
   * first, anything written after that read differs from it and is announced.
   */
  ready(key: string): Promise<void> {
    return this.watchers.get(key)?.ready ?? Promise.resolve();
  }

  /** How many keys are being watched. For tests. */
  get watching(): number {
    return this.watchers.size;
  }

  private unsubscribe(key: string, onChange: (watermark: string) => void): void {
    const watcher = this.watchers.get(key);
    if (!watcher) return;
    watcher.subscribers.delete(onChange);
    if (watcher.subscribers.size > 0) return;
    clearInterval(watcher.timer);
    this.watchers.delete(key);
  }

  private async probe(key: string): Promise<void> {
    const watcher = this.watchers.get(key);
    if (!watcher) return;

    try {
      const watermark = await watcher.probe();
      if (watermark === watcher.last && watcher.primed) return;

      const wasPrimed = watcher.primed;
      watcher.last = watermark;
      watcher.primed = true;
      if (!wasPrimed) return;

      for (const subscriber of watcher.subscribers) subscriber(watermark);
    } catch {
      // A database blip is not a reason to tear the stream down. The next probe
      // tries again, and the panel is still connected — which is the difference
      // between "quiet" and "disconnected", and the panel says which.
    }
  }
}
