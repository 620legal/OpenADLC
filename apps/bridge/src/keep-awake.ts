import { spawn as spawnProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { InFlight } from '@openadlc/db';

/**
 * Holding the bridge's own host awake while the install has work in flight.
 *
 * On 10-29 a laptop running a local install went to sleep with a task
 * running, a merge waiting on CI and a deploy on its soak timer: each of them
 * stopped where it was until somebody opened the lid. On macOS the bridge now
 * holds one `caffeinate -i` while anything is in flight (`inFlight()`), and
 * lets go a minute after the last tick that saw work, so it does not flap
 * between one task and the next. `-w <pid>` ties the child to the bridge: a
 * bridge that crashes or is killed, and never runs its shutdown, would
 * otherwise leave an orphan holding the assertion for good.
 *
 * `caffeinate -i` stops idle sleep only. A closed lid, or Sleep chosen from
 * the Apple menu, still sleeps a Mac, which is why each tick also looks for a
 * sleep under the running bridge and records it (`bridge.slept`) for the
 * health check `slept` to say. That looking runs on every host, since a Linux
 * laptop that suspends costs the same.
 *
 * See docs/adr/0028-the-bridge-keeps-its-host-awake-while-work-is-in-flight.md.
 */

export const KEEP_AWAKE_EVERY_MS = 30_000;
/** How long after the last tick that saw work the assertion is held. */
export const KEEP_AWAKE_GRACE_MS = 60_000;
/** A gap between ticks this long, four intervals, may be a sleep. */
export const SLEPT_AFTER_MS = 120_000;
/**
 * How far the wall clock must have run ahead of the monotonic one, which
 * stands still while the machine is suspended, for that gap to be a sleep:
 * an event loop blocked for two minutes, or an NTP step, moves both, or only
 * the wall clock by a little.
 */
export const SLEPT_CLOCKS_APART_MS = 60_000;

export const SLEPT_EVENT = 'bridge.slept';

/** What keep-awake was doing when the machine slept. */
export type KeepAwakeWas = 'holding' | 'off' | 'unavailable';

/** The `bridge.slept` event's payload. */
export interface Slept {
  /** The tick before the sleep. */
  sleptAt: string;
  /** The tick after it. */
  wokeAt: string;
  seconds: number;
  /** What the tick before it saw in flight. */
  inFlight: InFlight;
  keepAwake: KeepAwakeWas;
}

/** Just the parts of a child process this uses. */
export interface ChildLike {
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', listener: () => void): unknown;
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown;
  unref?(): void;
}

export interface KeepAwakeDeps {
  inFlight(): Promise<InFlight>;
  /** The stored `keepAwake` setting: `off`, or anything else for on. */
  setting(): Promise<string | null>;
  /** Writes the `bridge.slept` event. */
  recordSleep(slept: Slept): Promise<void>;
  /** Called once a sleep is recorded: the health check `slept` is asked again. */
  slept?(): void;
  spawn?(command: string, args: string[]): ChildLike;
  platform?: NodeJS.Platform;
  /** Whether an executable of this name is in one of PATH's directories. */
  onPath?(name: string): boolean;
  wall?(): number;
  mono?(): number;
  pid?: number;
  log?(line: string): void;
}

export interface KeepAwakeState {
  /** Whether this host can be held awake: macOS, with `caffeinate` found. */
  available: boolean;
  /** Whether a `caffeinate` is held now. */
  holding: boolean;
}

/** Looked for by its effect, an executable file in a PATH directory: nothing is spawned to find out. */
export function onPath(name: string, path = process.env.PATH ?? ''): boolean {
  return path
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => {
      try {
        accessSync(join(dir, name), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}

const busy = (counts: InFlight): boolean => counts.tasks > 0 || counts.merges > 0 || counts.deploys > 0;

export class KeepAwake {
  private available: boolean;
  private child: ChildLike | null = null;
  private lastBusyAt: number | null = null;
  /** The last tick: its clocks, and what it saw, for the next one to judge a sleep by. */
  private last: { wall: number; mono: number; inFlight: InFlight | null; keepAwake: KeepAwakeWas } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;
  private readonly wall: () => number;
  private readonly mono: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: KeepAwakeDeps) {
    const platform = deps.platform ?? process.platform;
    this.available = platform === 'darwin' && (deps.onPath ?? onPath)('caffeinate');
    this.wall = deps.wall ?? Date.now;
    this.mono = deps.mono ?? (() => performance.now());
    this.log = deps.log ?? ((line) => console.log(`[bridge] ${line}`));
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.tick(), KEEP_AWAKE_EVERY_MS);
    this.timer.unref();
    void this.tick();
  }

  state(): KeepAwakeState {
    return { available: this.available, holding: this.child !== null };
  }

  /** Looks again now rather than at the next tick: a switch turned off lets go at once. */
  evaluateSoon(): void {
    void this.tick();
  }

  /** One evaluation, after any still running, so two never decide at once. */
  tick(): Promise<void> {
    this.chain = this.chain.then(() => this.evaluate()).catch((error: unknown) => {
      this.log(`keep-awake could not evaluate: ${error instanceof Error ? error.message : error}`);
    });
    return this.chain;
  }

  /** Clears the timer and lets go of the assertion; at shutdown. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.chain;
    this.release();
  }

  /** Synchronous, for `process.on('exit')`, where nothing awaited runs. */
  killNow(): void {
    this.release();
  }

  private async evaluate(): Promise<void> {
    if (this.stopped) return;
    const wall = this.wall();
    const mono = this.mono();
    const before = this.last;

    let counts: InFlight;
    let setting: string | null;
    try {
      [counts, setting] = await Promise.all([this.deps.inFlight(), this.deps.setting()]);
    } catch (error) {
      // A database blip must not let go of the assertion mid-task: nothing
      // changes. The tick after a wake is the one whose pooled connection is
      // dead, so the sleep is still judged here, from the clocks already read:
      // judged only after a good read, it was lost, and the clocks moved on
      // past it.
      this.log(`keep-awake could not read what is in flight, so it changes nothing: ${error instanceof Error ? error.message : error}`);
      if (!before) this.last = { wall, mono, inFlight: null, keepAwake: this.was(null) };
      else if (await this.judgeSleep(before, wall, mono)) this.last = { ...before, wall, mono };
      return;
    }

    const judged = await this.judgeSleep(before, wall, mono);
    if (this.stopped) return;

    // The grace runs on the monotonic clock: a wall clock stepped back would
    // leave the last busy tick in the future, and hold the assertion until
    // wall time caught up with it.
    if (busy(counts)) this.lastBusyAt = mono;
    const on = setting !== 'off';
    const want = this.available && on && this.lastBusyAt !== null && mono - this.lastBusyAt < KEEP_AWAKE_GRACE_MS;
    if (want && !this.child) this.hold();
    else if (!want && this.child) this.release();

    // A sleep that could not be written keeps the tick before it as the
    // baseline, so the next tick sees the same gap and writes it then.
    if (judged || !before) this.last = { wall, mono, inFlight: counts, keepAwake: this.was(setting) };
  }

  /**
   * `holding` only with a live child: the card reads it as the assertion held
   * and the Mac slept anyway, which a spawn that threw is not.
   */
  private was(setting: string | null): KeepAwakeWas {
    if (!this.available) return 'unavailable';
    if (this.child) return 'holding';
    return setting === 'off' ? 'off' : 'unavailable';
  }

  /**
   * Records a sleep between the tick before and this one, when the tick before
   * saw work. False only when there was one and it could not be written.
   */
  private async judgeSleep(before: KeepAwake['last'], wall: number, mono: number): Promise<boolean> {
    if (!before?.inFlight || !busy(before.inFlight)) return true;
    const gap = wall - before.wall;
    const apart = gap - (mono - before.mono);
    if (gap <= SLEPT_AFTER_MS || apart <= SLEPT_CLOCKS_APART_MS) return true;
    const slept: Slept = {
      sleptAt: new Date(before.wall).toISOString(),
      wokeAt: new Date(wall).toISOString(),
      seconds: Math.round(gap / 1000),
      inFlight: before.inFlight,
      keepAwake: before.keepAwake,
    };
    try {
      await this.deps.recordSleep(slept);
    } catch (error) {
      this.log(`could not record that the machine slept, so the next tick tries again: ${error instanceof Error ? error.message : error}`);
      return false;
    }
    this.log(`this machine slept for ${slept.seconds} s with work in flight`);
    this.deps.slept?.();
    return true;
  }

  private hold(): void {
    const pid = this.deps.pid ?? process.pid;
    const spawn = this.deps.spawn ?? ((command, args) => spawnProcess(command, args, { stdio: 'ignore' }));
    let child: ChildLike;
    try {
      child = spawn('caffeinate', ['-i', '-w', String(pid)]);
    } catch (error) {
      this.log(`could not start caffeinate: ${error instanceof Error ? error.message : error}`);
      return;
    }
    // One that exits on its own is let go of here, and the next tick with
    // work in flight starts another.
    child.on('exit', () => {
      if (this.child === child) this.child = null;
    });
    child.on('error', (error) => {
      if (this.child === child) this.child = null;
      // Gone since the PATH was read: this host cannot be held awake.
      if (error.code === 'ENOENT') this.available = false;
      this.log(`caffeinate failed: ${error.message}`);
    });
    child.unref?.();
    this.child = child;
  }

  private release(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
  }
}
