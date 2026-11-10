import { listEventsOfType, recordEvent } from '@openadlc/db';

/**
 * Whether a pull request's head conflicts with its base, as GitHub says it,
 * and the short wait for GitHub to say it at all.
 *
 * #257 conflicted with main once #256 merged, and three seats reviewed it on
 * two heads only for the lead to block it each time on "not mergeable": a
 * round of three seats spent, and one of the review loop's rounds with it. A
 * head that conflicts is now resolved before any seat is asked
 * (`Webhooks.onPullRequest`, ADR 0042).
 *
 * GitHub computes `mergeable` lazily: right after a push it is usually null,
 * with `mergeable_state` `unknown`, for a few seconds. The wait for it cannot
 * run inside the delivery: `internal-api.ts` answers GitHub only once
 * `Webhooks.receive` returns, GitHub fails a delivery after 10 s, and
 * `redeliverFailed` then sends it again, starting the review twice. So an
 * unknown head is held on a timer, re-read every few seconds, and given up on
 * after a minute: a head GitHub never computes must not hold its reviews
 * indefinitely. The hold is recorded, so a restart picks it up again.
 */

export type Mergeability = 'conflicting' | 'mergeable' | 'unknown';

/** Re-read this often while GitHub has not said. */
export const MERGEABILITY_RECHECK_MS = 5_000;
/** And no longer than this after the first unknown read: then the reviews start as they would have. */
export const MERGEABILITY_WAIT_MS = 60_000;

export const MERGEABILITY_WAITING = 'review.mergeability_waiting';
export const MERGEABILITY_DECIDED = 'review.mergeability_decided';

/**
 * Conflicting is `mergeable: false` or `mergeable_state: 'dirty'`; unknown is
 * `mergeable` null with the state `unknown` or none. Every other state —
 * `blocked`, `behind`, `unstable`, `clean`, `has_hooks` — is not a conflict:
 * blocked is this very gate, and behind is the merge line's to bring up to date.
 */
export function mergeabilityOf(pull: { mergeable?: boolean | null; mergeableState?: string | null }): Mergeability {
  if (pull.mergeable === false || pull.mergeableState === 'dirty') return 'conflicting';
  if ((pull.mergeable ?? null) === null && (!pull.mergeableState || pull.mergeableState === 'unknown')) return 'unknown';
  return 'mergeable';
}

/** The pull request as GitHub has it now: what a hold re-reads, and what the decision acts on. */
export interface PullNow {
  number: number;
  state: 'open' | 'closed';
  draft: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  labels: string[];
  mergeable: boolean | null;
  mergeableState: string | null;
}

export interface MergeabilityHold {
  /** The repository's name in OpenADLC, and its full name on GitHub. */
  repo: string;
  repoFullName: string;
  pr: number;
  head: string;
}

/** What a hold ends in. `moved` (the head moved, or the pull request closed or went to draft) calls nothing: the newer delivery owns it. */
export type Decided = 'conflicting' | 'mergeable' | 'unknown' | 'moved';

export type Decide = (answer: Exclude<Decided, 'moved'>, pull: PullNow | null, hold: MergeabilityHold) => Promise<void>;

interface WaitingPayload {
  repo: string;
  repoFullName: string;
  pr: number;
  head: string;
  at: string;
}

export interface MergeabilityWaitDeps {
  /** Reads the pull request; null when it could not be read. */
  read: (repoFullName: string, pr: number) => Promise<PullNow | null>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  record?: (type: string, payload: object) => Promise<unknown>;
  /** Events of a type since a time, newest first (`listEventsOfType`). */
  events?: (type: string, since: Date) => Promise<{ at: string; payload: unknown }[]>;
  recheckMs?: number;
  waitMs?: number;
  log?: (line: string) => void;
}

export class MergeabilityWait {
  /** One hold per `repo#pr@head`: a redelivery of the same push adds no second timer. */
  private readonly held = new Map<string, { timer: unknown }>();
  private stopped = false;

  constructor(private readonly deps: MergeabilityWaitDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private record(type: string, payload: object): Promise<unknown> {
    const write = this.deps.record ?? ((t: string, p: object) => recordEvent({ source: 'platform', type: t, payload: p }));
    return write(type, payload).catch(() => undefined);
  }

  private log(line: string): void {
    (this.deps.log ?? ((text: string) => console.log(text)))(line);
  }

  private schedule(fn: () => void, ms: number): unknown {
    if (this.deps.setTimer) return this.deps.setTimer(fn, ms);
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  }

  /** Whether a hold is open on this head now. */
  holding(hold: Pick<MergeabilityHold, 'repo' | 'pr' | 'head'>): boolean {
    return this.held.has(keyOf(hold));
  }

  /**
   * Holds the head until GitHub says whether it conflicts, re-reading every
   * few seconds, and calls `decide` once with the answer, or with `unknown`
   * once the wait has run out. `since` is when the first unknown read was
   * made: the cap counts from it. False when this head is already held.
   */
  async hold(hold: MergeabilityHold, decide: Decide, since: number = this.now()): Promise<boolean> {
    const key = keyOf(hold);
    if (this.stopped || this.held.has(key)) return false;
    this.held.set(key, { timer: null });
    await this.record(MERGEABILITY_WAITING, { repo: hold.repo, repoFullName: hold.repoFullName, pr: hold.pr, head: hold.head, at: new Date(since).toISOString() });
    this.log(`[bridge] ${hold.repoFullName}#${hold.pr}: GitHub has not said whether ${hold.head.slice(0, 7)} conflicts; its reviews wait for it`);
    this.next(hold, decide, since);
    return true;
  }

  private next(hold: MergeabilityHold, decide: Decide, since: number): void {
    const key = keyOf(hold);
    const entry = this.held.get(key);
    if (!entry) return;
    entry.timer = this.schedule(() => {
      void this.check(hold, decide, since);
    }, this.deps.recheckMs ?? MERGEABILITY_RECHECK_MS);
  }

  private async check(hold: MergeabilityHold, decide: Decide, since: number): Promise<void> {
    const key = keyOf(hold);
    if (!this.held.has(key) || this.stopped) return;
    const pull = await this.deps.read(hold.repoFullName, hold.pr).catch(() => null);
    const waited = this.now() - since;
    if (pull && movedOn(pull, hold.head)) return this.end(hold, 'moved', waited, null, decide);
    const answer = pull ? mergeabilityOf(pull) : 'unknown';
    if (answer !== 'unknown') return this.end(hold, answer, waited, pull, decide);
    if (waited >= (this.deps.waitMs ?? MERGEABILITY_WAIT_MS)) return this.end(hold, 'unknown', waited, pull, decide);
    this.next(hold, decide, since);
  }

  private async end(hold: MergeabilityHold, answer: Decided, waitedMs: number, pull: PullNow | null, decide: Decide): Promise<void> {
    this.held.delete(keyOf(hold));
    await this.record(MERGEABILITY_DECIDED, { repo: hold.repo, pr: hold.pr, head: hold.head, answer, waitedMs, at: new Date(this.now()).toISOString() });
    this.log(
      answer === 'moved'
        ? `[bridge] ${hold.repoFullName}#${hold.pr}: moved on from ${hold.head.slice(0, 7)} while GitHub had not said whether it conflicts; the newer push decides`
        : `[bridge] ${hold.repoFullName}#${hold.pr}: ${hold.head.slice(0, 7)} is ${answer === 'unknown' ? 'still unknown after the wait; its reviews start' : answer} (${Math.round(waitedMs / 1000)} s)`,
    );
    if (answer === 'moved') return;
    await decide(answer, pull, hold).catch((error: unknown) =>
      this.log(`[bridge] ${hold.repoFullName}#${hold.pr}: what to do once GitHub said ${answer} failed: ${error instanceof Error ? error.message : error}`),
    );
  }

  /**
   * At start-up: every hold of the last day that recorded no decision, the
   * newest per pull request. Its minute has passed, so each is read once and
   * decided at once, an unknown answer starting the reviews.
   */
  async resume(decide: Decide): Promise<string[]> {
    const read = this.deps.events ?? listEventsOfType;
    const since = new Date(this.now() - 24 * 60 * 60 * 1000);
    const waiting = await read(MERGEABILITY_WAITING, since).catch(() => []);
    const decided = await read(MERGEABILITY_DECIDED, since).catch(() => []);
    const done = new Set(
      decided.map((row) => row.payload as { repo?: string; pr?: number; head?: string }).map((p) => `${p?.repo}#${p?.pr}@${p?.head}`),
    );
    const newest = new Map<string, { at: string; payload: WaitingPayload }>();
    for (const row of waiting) {
      const payload = row.payload as WaitingPayload;
      if (!payload?.repo || !payload.repoFullName || typeof payload.pr !== 'number' || !payload.head) continue;
      const pr = `${payload.repo}#${payload.pr}`;
      const seen = newest.get(pr);
      if (!seen || Date.parse(row.at) > Date.parse(seen.at)) newest.set(pr, { at: row.at, payload });
    }
    const lines: string[] = [];
    for (const { payload } of newest.values()) {
      const hold: MergeabilityHold = { repo: payload.repo, repoFullName: payload.repoFullName, pr: payload.pr, head: payload.head };
      if (done.has(keyOf(hold)) || this.held.has(keyOf(hold))) continue;
      const pull = await this.deps.read(hold.repoFullName, hold.pr).catch(() => null);
      const waited = this.now() - Date.parse(payload.at);
      if (pull && movedOn(pull, hold.head)) {
        await this.end(hold, 'moved', waited, null, decide);
        lines.push(`${hold.repo}#${hold.pr}: moved on since its wait`);
        continue;
      }
      const answer = pull ? mergeabilityOf(pull) : 'unknown';
      await this.end(hold, answer, waited, pull, decide);
      lines.push(`${hold.repo}#${hold.pr}: ${answer} after a restart`);
    }
    return lines;
  }

  /** The bridge shutting down: no hold decides any more. */
  stop(): void {
    this.stopped = true;
    for (const { timer } of this.held.values()) {
      if (timer === null) continue;
      if (this.deps.clearTimer) this.deps.clearTimer(timer);
      else clearTimeout(timer as ReturnType<typeof setTimeout>);
    }
    this.held.clear();
  }
}

function keyOf(hold: Pick<MergeabilityHold, 'repo' | 'pr' | 'head'>): string {
  return `${hold.repo}#${hold.pr}@${hold.head}`;
}

/** Closed, a draft, or at another head: the hold is no longer this delivery's to decide. */
function movedOn(pull: PullNow, head: string): boolean {
  return pull.state !== 'open' || pull.draft || pull.headSha !== head;
}
