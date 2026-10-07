import type { DispatchDecision } from '@fleetadlc/dispatcher';

/**
 * Runs the dispatcher when something changes that could let work start, and
 * on a timer besides.
 *
 * The dispatcher was a process of its own that looked every five minutes, so
 * everything it could act on waited up to five minutes for it to look: on the
 * live install an issue whose dependency had just shipped sat unleased while
 * the pass that would start it came round. What changes arrives here, in the
 * bridge — an issue labelled or moved, a task ending, a pull request closing —
 * and each of those now asks for a run.
 *
 * One run at a time, and the asks that arrive together make one run: an issue
 * relabelled three times in a second is one decision. An ask during a run
 * brings one more run after it, since the run may have read the world before
 * the change. The timer is the safety net for anything nobody asked about.
 * Running it often costs nothing, because it acts only on what can start.
 */
export class DispatchRunner {
  private pending: ReturnType<typeof setTimeout> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private again = false;
  /** Once stopped — the bridge shutting down — nothing more is started. */
  private stopped = false;
  private readonly reasons = new Set<string>();

  constructor(
    private readonly run: () => Promise<DispatchDecision[]>,
    private readonly options: {
      /** How long asks are gathered before a run. */
      delayMs?: number;
      /** The safety net's period. */
      everyMs?: number;
      log?: (line: string) => void;
    } = {},
  ) {}

  /** Something changed that could let work start: a run, shortly, with whatever else arrives meanwhile. */
  soon(reason: string): void {
    if (this.stopped) return;
    this.reasons.add(reason);
    if (this.running) {
      this.again = true;
      return;
    }
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      void this.now();
    }, this.options.delayMs ?? 1500);
    this.pending.unref?.();
  }

  /** A run now, or one more after the run under way. */
  async now(): Promise<void> {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    const why = [...this.reasons].join(', ') || 'its timer';
    this.reasons.clear();
    const log = this.options.log ?? ((line: string) => console.log(line));
    try {
      for (const decision of await this.run()) {
        log(`[bridge] dispatch, for ${why}: ${decision.action} ${decision.repo}#${decision.issue} → ${decision.bot}: ${decision.reason}`);
      }
    } catch (error) {
      log(`[bridge] dispatch, for ${why}, failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
      if (this.again) {
        this.again = false;
        this.soon('what changed during the last run');
      }
    }
  }

  start(): void {
    this.stopped = false;
    if (this.timer) return;
    this.timer = setInterval(() => void this.now(), this.options.everyMs ?? 5 * 60_000);
    this.timer.unref?.();
    this.soon('the bridge starting');
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.pending) clearTimeout(this.pending);
    this.timer = null;
    this.pending = null;
  }
}
