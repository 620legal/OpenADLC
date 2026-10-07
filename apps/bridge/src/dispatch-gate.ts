/**
 * Whether the dispatcher may start work now.
 *
 * The dispatcher, which the bridge runs (`dispatch-runner.ts`) and the
 * integration suites run a pass at a time as its own process, asks the
 * bridge's lease route for every lease, so the bridge is where it is paused:
 * the bridge's own dispatcher passes a paused install or repository over, and
 * while something holds the gate, a lease is refused in the holder's words,
 * and the dispatcher lets the issue go and tries again on its next pass. A restore into an install that is in use holds it
 * while it writes, so no new work starts on the crew it is changing.
 */
export class DispatchGate {
  private readonly holds = new Map<symbol, string>();
  /** A person's pause from Settings, which outlasts any hold; see `pause-work.ts`. */
  private pausedByPerson: string | null = null;
  /** A person's pause of one repository, by its name, in its words. */
  private readonly pausedRepoWords = new Map<string, string>();

  /** Pauses work until it is resumed, in these words; null resumes it. */
  pauseWork(words: string | null): void {
    this.pausedByPerson = words;
  }

  /** A person's pause, in its words, or null; a restore's hold is not one. */
  pausedByAPerson(): string | null {
    return this.pausedByPerson;
  }

  /** Pauses one repository's new work until it is resumed, in these words; null resumes it. */
  pauseRepo(name: string, words: string | null): void {
    if (words) this.pausedRepoWords.set(name, words);
    else this.pausedRepoWords.delete(name);
  }

  /** The repositories a person paused on their own, by name. */
  pausedRepos(): string[] {
    return [...this.pausedRepoWords.keys()];
  }

  /** Pauses leasing, and says why to anyone refused meanwhile. Returns what lets go. */
  hold(reason: string): () => void {
    const key = Symbol('hold');
    this.holds.set(key, reason);
    return () => {
      this.holds.delete(key);
    };
  }

  /**
   * Why new work may not start, or null when it may. Asked about a
   * repository, that repository's own pause counts too; asked about none —
   * the request queue's drain, a request with no repository yet — only what
   * stops the whole install does, so one paused repository holds nobody else.
   */
  paused(repo?: string | null): string | null {
    if (this.pausedByPerson) return this.pausedByPerson;
    for (const reason of this.holds.values()) return reason;
    return repo ? (this.pausedRepoWords.get(repo) ?? null) : null;
  }
}
