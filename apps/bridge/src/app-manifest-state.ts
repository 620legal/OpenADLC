import { randomBytes } from 'node:crypto';

/**
 * The `state` a create of the GitHub App carries out to GitHub and back.
 *
 * GitHub redirects to the console's app-created page with a one-time code,
 * and the page exchanges it while it renders. Nothing tied the code to a
 * create this install started, so any page that sent the operator's browser
 * there with a code — one an attacker minted from a manifest of their own —
 * replaced the install's app, key and webhook secret. A code is now exchanged
 * only with a state this bridge issued when someone pressed create, within the
 * hour GitHub's code lasts, and only once.
 *
 * Kept in memory: the bridge is one process locally and one instance on
 * GCP. A restart between create and return loses it, and the person presses
 * create again, as they would for an expired code.
 */

/** How long a state is good for: as long as GitHub's code is. */
export const STATE_TTL_MS = 60 * 60 * 1000;

/** At most this many waiting at once, so repeated prepares cannot grow the map without bound. */
const MOST_WAITING = 50;

export class AppManifestStates {
  private readonly waiting = new Map<string, { at: number; expectedOwner: string | null }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * A new state for one create. `expectedOwner` is the organization when the
   * manifest goes to an organization's form, whose app any other account's
   * code is not; null for a person's form, whose login the bridge does not know.
   */
  issue(expectedOwner: string | null): string {
    const now = this.now();
    for (const [state, entry] of this.waiting) {
      if (now - entry.at > STATE_TTL_MS) this.waiting.delete(state);
    }
    while (this.waiting.size >= MOST_WAITING) {
      const oldest = this.waiting.keys().next().value;
      if (oldest === undefined) break;
      this.waiting.delete(oldest);
    }
    const state = randomBytes(32).toString('hex');
    this.waiting.set(state, { at: now, expectedOwner });
    return state;
  }

  /**
   * What a state was issued for, once: it is gone on the first ask, used or
   * not, so a replay fails even when the first exchange failed. Null for a
   * state never issued, already used, or older than an hour.
   */
  consume(state: string | null | undefined): { expectedOwner: string | null } | null {
    if (!state) return null;
    const entry = this.waiting.get(state);
    if (!entry) return null;
    this.waiting.delete(state);
    if (this.now() - entry.at > STATE_TTL_MS) return null;
    return { expectedOwner: entry.expectedOwner };
  }
}
