import type { ContextDocument } from '@openadlc/shared';

/**
 * Said when a patch round — CI red after the lead approved, the lead's or a
 * person's request for changes, a person's message to the builder or move of
 * the card back to Build — is turned away because its builder is running all
 * it may at once or every host is full (`BotBusyError` and its kin). The round
 * waits on the builder's seat and starts when the seat has room
 * (`SendBack.startWaiting`, run by the `StageRunner`).
 *
 * It used to be dropped: on 2026-11-09 a managed repository's pull request
 * went red after the lead approved, the dispatcher had leased the builder the
 * next issue twenty seconds before, and the round was refused as busy with a
 * line in the log. Nothing started it for 21 hours, until a person merged the
 * pull request by hand. Its own module, so the board reads waits without
 * importing the send-back (ADR 0044).
 */
export const PATCH_ROUND_WAITING = 'patch.round_waiting';

/** What a `patch.round_waiting` event carries. */
export interface PatchWaitPayload {
  /** The pull request, as its tasks name it: `<repo>#<pr>`. */
  subjectRef: string;
  repo: string;
  pr: number;
  /** The issue the pull request is for, from its branch. */
  issue: number | null;
  /** The builder it waits on, by id, which a rename keeps. */
  botId: string;
  /** The builder by the name it had when the round was turned away. */
  bot: string;
  /** The number the round would have had then. */
  round: number;
  /** Who sent it back: the lead's seat, a person, or `openadlc`. */
  by: string;
  /** The head it was sent back on, when known: a redelivery for the same head says nothing twice. */
  head?: string;
  /** What held the builder, as `busyWords` says it: "running `implement` on OpenADLC#280". */
  busyWith: string;
  /** Brief the round with the lease's paths alone (`reviewRound`'s `leasePathsOnly`). */
  leasePathsOnly?: boolean;
  /** What a person asked of the round (`message.md`), kept so a restart does not lose it. */
  brief?: ContextDocument[];
}

/** A wait, and when it began. */
export interface PatchWait extends PatchWaitPayload {
  /** The event's time; of several for one wait, the first. */
  since: string;
}

/** The wait an event records, or null for one that does not read as one. */
export function patchWaitFrom(event: { at: string; payload: unknown }): PatchWait | null {
  const payload = event.payload as Partial<PatchWaitPayload> | null;
  if (!payload || typeof payload !== 'object') return null;
  const { subjectRef, repo, pr, issue, botId, bot, round, by, head, busyWith, leasePathsOnly, brief } = payload;
  if (typeof subjectRef !== 'string' || typeof repo !== 'string' || typeof pr !== 'number') return null;
  if (typeof botId !== 'string' || typeof bot !== 'string') return null;
  return {
    subjectRef,
    repo,
    pr,
    issue: typeof issue === 'number' ? issue : null,
    botId,
    bot,
    round: typeof round === 'number' ? round : 0,
    by: typeof by === 'string' ? by : 'openadlc',
    ...(typeof head === 'string' ? { head } : {}),
    busyWith: typeof busyWith === 'string' ? busyWith : 'busy',
    ...(leasePathsOnly ? { leasePathsOnly: true } : {}),
    ...(Array.isArray(brief) ? { brief } : {}),
    since: event.at,
  };
}

/**
 * The waits that still stand, by the pull request's `subjectRef`.
 *
 * A wait stands until a patch task (any skill) is created on its pull request
 * at or after it — the round it waited for, a resolution round, or a round a
 * person started — or until its issue is no longer on the board in Build with
 * that pull request: a person's push moved it to Review, a person moved it, or
 * it closed. Of the events after the pull request's newest patch task, the
 * first says since when, and the newest everything else: who asked last, on
 * which head, and what holds the builder now.
 */
export function standingPatchWaits(
  events: readonly { at: string; payload: unknown }[],
  issues: readonly { repoName: string; number: number; stage: string; prNumber?: number | null }[],
  tasks: readonly { subjectRef: string; kind: string; createdAt: string }[],
): Map<string, PatchWait> {
  const newestPatch = new Map<string, number>();
  for (const task of tasks) {
    if (task.kind !== 'patch') continue;
    const at = Date.parse(task.createdAt);
    if (!(at <= (newestPatch.get(task.subjectRef) ?? Number.NEGATIVE_INFINITY))) newestPatch.set(task.subjectRef, at);
  }

  const standing = new Map<string, PatchWait>();
  for (const event of events) {
    const wait = patchWaitFrom(event);
    if (!wait) continue;
    const issue = issues.find((one) => one.repoName === wait.repo && one.prNumber === wait.pr && (wait.issue === null || one.number === wait.issue));
    if (!issue || issue.stage !== 'build') continue;
    if ((newestPatch.get(wait.subjectRef) ?? Number.NEGATIVE_INFINITY) >= Date.parse(wait.since)) continue;
    const seen = standing.get(wait.subjectRef);
    if (!seen) {
      standing.set(wait.subjectRef, wait);
      continue;
    }
    const newer = Date.parse(wait.since) >= Date.parse(seen.since) ? wait : seen;
    const first = Date.parse(wait.since) < Date.parse(seen.since) ? wait.since : seen.since;
    standing.set(wait.subjectRef, { ...newer, since: first });
  }
  return standing;
}
