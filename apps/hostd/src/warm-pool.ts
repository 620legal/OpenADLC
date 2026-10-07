/**
 * Computers made before their task, so a task start claims one rather than
 * waiting for a container to be made: the cold start a container per task
 * would otherwise add to every task. Off unless `FLEETADLC_WARM_POOL` is set.
 *
 * A warm computer is keyed by what cannot be changed once a container exists:
 * the image it runs, the repository whose cache volume it mounts, and the
 * login it holds. A claim changes what can be — its CPUs and memory to the
 * seat's, its name to the task's — and writes whose it is in its folder. No
 * warm computer holds a login: a subscription's login is a credential, and one
 * mounted into a container nobody has claimed yet would be one more copy of it
 * for nothing. A task that needs one starts cold.
 *
 * How many are kept: one with no repository (intake's work, which has none
 * yet), one for each repository with a task in the last two hours, never more
 * than `FLEETADLC_WARM_POOL_MAX` (three by default), and never more than the
 * host has room for beside what it runs. One made from an image the engine
 * update has since replaced, or made more than a day ago, is drained; so is
 * every warm one found when hostd starts: hostd reads none of the labels a
 * container records, so nothing it trusts says what that one was made from.
 */

/** What a warm computer is made for, and claimed by. */
export interface WarmKey {
  repoKey: string | null;
}

export interface WarmComputer {
  name: string;
  repoKey: string | null;
  slotDir: string;
  /** The image id it was made from. */
  image: string | null;
  madeAt: number;
}

/** What the pool needs of the driver. */
export interface WarmHost {
  makeWarm(key: WarmKey): Promise<WarmComputer>;
  discard(name: string): Promise<void>;
  /** The image id a computer made now would run; null when it cannot be told. */
  imageId(): Promise<string | null>;
}

export interface WarmPoolOptions {
  host: WarmHost;
  enabled: boolean;
  /** `FLEETADLC_WARM_POOL_MAX`. */
  max: number;
  /** How many more computers the host has room for now, beside what it runs. */
  room: () => number;
  /** The repositories (`repoKeyOf`) with a task in the last two hours, most recent first. */
  activeRepos: () => Promise<string[]>;
  now?: () => number;
  log?: (line: string) => void;
}

/** How old a warm computer may be before it is replaced. */
export const WARM_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The warm computers the pool should hold, most wanted first: one with no
 * repository, then one per active repository, as many as `limit` allows.
 */
export function warmTargets(activeRepos: readonly string[], limit: number): WarmKey[] {
  const wanted: WarmKey[] = [{ repoKey: null }, ...[...new Set(activeRepos)].map((repoKey) => ({ repoKey }))];
  return wanted.slice(0, Math.max(0, limit));
}

const keyOf = (key: WarmKey) => key.repoKey ?? '';

export class WarmPool {
  private readonly warm = new Map<string, WarmComputer>();
  private filling: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(private readonly options: WarmPoolOptions) {
    this.now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  /** Whether a container is one of the pool's, unclaimed. */
  holds(name: string): boolean {
    return this.warm.has(name);
  }

  list(): WarmComputer[] {
    return [...this.warm.values()];
  }

  /**
   * A warm computer for this key on the image in use, taken out of the pool,
   * or null when there is none: the caller makes one cold. Taken synchronously
   * before anything is awaited, so two starts cannot claim the same one.
   */
  take(key: WarmKey, image: string | null): WarmComputer | null {
    if (!this.options.enabled) return null;
    for (const computer of this.warm.values()) {
      if (keyOf(computer) !== keyOf(key)) continue;
      if (image && computer.image && computer.image !== image) continue;
      this.warm.delete(computer.name);
      return computer;
    }
    return null;
  }

  /** Brings the pool to its targets: drains what is stale or too old, then makes what is missing. One fill at a time. */
  fill(): Promise<void> {
    if (!this.options.enabled) return Promise.resolve();
    this.filling ??= this.fillNow().finally(() => {
      this.filling = null;
    });
    return this.filling;
  }

  private async fillNow(): Promise<void> {
    const image = await this.options.host.imageId().catch(() => null);
    for (const computer of [...this.warm.values()]) {
      const stale = image && computer.image && computer.image !== image;
      const old = this.now() - computer.madeAt > WARM_MAX_AGE_MS;
      if (stale || old) await this.drainOne(computer, stale ? 'its image was replaced' : 'it is more than a day old');
    }

    // `room` is what the host can run beside the tasks it runs; a warm
    // computer is not a task, and is counted against it here.
    const limit = Math.min(this.options.max, Math.max(0, this.options.room()));
    const targets = warmTargets(await this.options.activeRepos().catch(() => []), limit);
    const wanted = new Set(targets.map(keyOf));
    // Over the limit, or for a repository nobody has worked in lately.
    for (const computer of [...this.warm.values()]) {
      if (!wanted.has(keyOf(computer)) || this.warm.size > limit) await this.drainOne(computer, 'the pool has no place for it');
    }
    const held = new Set([...this.warm.values()].map(keyOf));
    for (const key of targets) {
      if (held.has(keyOf(key)) || this.warm.size >= limit) continue;
      const made = await this.options.host.makeWarm(key).catch((error: unknown) => {
        this.options.log?.(`[hostd] could not make a warm computer: ${error instanceof Error ? error.message : error}`);
        return null;
      });
      if (made) {
        this.warm.set(made.name, made);
        held.add(keyOf(key));
      }
    }
  }

  private async drainOne(computer: WarmComputer, why: string): Promise<void> {
    this.warm.delete(computer.name);
    await this.options.host.discard(computer.name).catch(() => undefined);
    this.options.log?.(`[hostd] drained warm computer ${computer.name}: ${why}`);
  }
}
