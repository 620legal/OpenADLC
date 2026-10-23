/**
 * Starts the work a busy seat turned away as soon as the seat may have room.
 *
 * A stage's start is refused while its seat runs all it may at once
 * (`BotBusyError`), and the only thing that came back for it was the hourly
 * stage sweep. On the live install OpenADLC#141 reached Design at 13:46 while
 * the design seat ran #137's design; that task ended at 13:47, and #141, with
 * #137 waiting on it, sat with nobody on it until the sweep came round. A task's
 * end asked the dispatcher to run, but the dispatcher leases builds, and starts
 * no triage and no design.
 *
 * What may give a seat room asks here, with the seat: one of its tasks ending
 * (done, failed, stopped or cancelled), or its tasks at once going up. The
 * asks that arrive together make one run, and one run at a time, so a burst of
 * task ends is one sweep; an ask during a run brings one more after it. A run
 * starts only what those seats turned away (`StageHandoff.sweep({ seats })`),
 * next first, under the sweep's lock, so it never overlaps the hourly sweep or
 * another run, and a start it makes is never made twice.
 *
 * Some seats free up without anything asking: hostd giving back a paused
 * task's computer, or stopping a task when it restarts. So every minute it
 * looks at the seats something waits on, and asks for any with room. The
 * hourly sweep stays, as the net for a delivery that never came.
 */
export class StageRunner {
  private pending: ReturnType<typeof setTimeout> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** Once stopped — the bridge shutting down — nothing more is started. */
  private stopped = false;
  /** The seats asked about since the last run, by bot id. */
  private readonly seats = new Set<string>();
  private readonly reasons = new Set<string>();

  constructor(
    private readonly deps: {
      /** Starts what these seats turned away, next first: `StageHandoff.sweep({ seats })`. */
      start(seats: readonly string[]): Promise<string[]>;
      /** The seats something waits on now, by bot id (`StageHandoff.waitingOnSeats`). */
      waitedOn(): readonly string[];
      /** Whether a seat has room for one more task (`tasks.seatHasRoom`). */
      hasRoom(seat: string): Promise<boolean>;
    },
    private readonly options: {
      /** How long asks are gathered before a run. */
      delayMs?: number;
      /** How often the seats something waits on are looked at. */
      everyMs?: number;
      log?: (line: string) => void;
    } = {},
  ) {}

  /** A seat may have room now: what it turned away starts, shortly, with whatever else is asked meanwhile. */
  seatFreed(seat: string, reason: string): void {
    if (this.stopped) return;
    this.seats.add(seat);
    this.reasons.add(reason);
    // A run under way takes what arrived during it once it ends.
    if (this.running || this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      void this.now();
    }, this.options.delayMs ?? 1000);
    this.pending.unref?.();
  }

  /** A run now of what has been asked, unless one is under way, which runs it after. */
  async now(): Promise<void> {
    if (this.stopped || this.running || this.seats.size === 0) return;
    this.running = true;
    const seats = [...this.seats];
    const why = [...this.reasons].join(', ');
    this.seats.clear();
    this.reasons.clear();
    const log = this.options.log ?? ((line: string) => console.log(line));
    try {
      for (const line of await this.deps.start(seats)) log(`[bridge] stages, for ${why}: ${line}`);
    } catch (error) {
      log(`[bridge] stages, for ${why}, failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
      if (this.seats.size > 0 && !this.stopped) {
        this.pending = setTimeout(() => {
          this.pending = null;
          void this.now();
        }, this.options.delayMs ?? 1000);
        this.pending.unref?.();
      }
    }
  }

  /** Asks for every seat something waits on that has room now, whatever gave it room. */
  async look(): Promise<void> {
    for (const seat of new Set(this.deps.waitedOn())) {
      if (await this.deps.hasRoom(seat).catch(() => false)) this.seatFreed(seat, 'a seat work waits on has room');
    }
  }

  start(): void {
    this.stopped = false;
    if (this.timer) return;
    this.timer = setInterval(() => void this.look(), this.options.everyMs ?? 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.pending) clearTimeout(this.pending);
    this.timer = null;
    this.pending = null;
  }
}
