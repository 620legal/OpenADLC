import type { StageKey } from '@openadlc/shared';

/**
 * Said when a stage's start is refused because its seat is running all the
 * tasks it may at once (`StageHandoff.staff`): the issue waits on that seat,
 * and starts when the seat has room (`StageRunner`). On the live install
 * OpenADLC#141's design was refused at 13:46 while the design seat ran #137's,
 * nothing recorded what it waited on, and the card said "Waiting for a design
 * pass" for half an hour while the seat it waited on had been free since
 * 13:47. Its own module, so the board reads it without importing the handoff.
 */
export const STAGE_WAITING_ON_SEAT = 'stage.waiting_on_seat';

/**
 * How far back a wait is looked for. Older than this it has been swept many
 * times, and every sweep the seat turned it away in recorded it again.
 */
export const SEAT_WAIT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** What a `stage.waiting_on_seat` event carries. */
export interface SeatWaitPayload {
  /** The issue, as its tasks name it: `<repo>#<number>`. */
  subjectRef: string;
  repo: string;
  issue: number;
  /** The stage it waits to be staffed in: `intake` or `spec`. */
  stage: StageKey;
  /** The seat that turned it away, by the name it had then. */
  seat: string;
  /** The same seat by id, which a rename keeps: what its tasks carry as `botId`. */
  botId: string;
  /** Its tasks at once when it refused: `bots.max_tasks`. */
  maxTasks: number;
}

/** A wait, and when it began. */
export interface SeatWait extends SeatWaitPayload {
  /** The event's time; of several for one wait (one per bridge start), the first. */
  since: string;
}

/** The wait an event records, or null for one that does not read as one. */
export function seatWaitFrom(event: { at: string; payload: unknown }): SeatWait | null {
  const payload = event.payload as Partial<SeatWaitPayload> | null;
  if (!payload || typeof payload !== 'object') return null;
  const { subjectRef, repo, issue, stage, seat, botId, maxTasks } = payload;
  if (typeof subjectRef !== 'string' || typeof repo !== 'string' || typeof issue !== 'number') return null;
  if (typeof stage !== 'string' || typeof seat !== 'string' || typeof botId !== 'string') return null;
  return { subjectRef, repo, issue, stage, seat, botId, maxTasks: typeof maxTasks === 'number' ? maxTasks : 1, since: event.at };
}

/**
 * The waits that still stand, by the issue's `subjectRef`.
 *
 * A wait stands until a task is created on its issue at or after it — the
 * start it waited for, or any other — or until the issue is no longer in the
 * stage it waited in: moved on, closed, or off the board. A bridge that
 * restarts while an issue waits records the wait again the next time the seat
 * turns it away, so of the events after the issue's newest task the first
 * says since when, and the newest which seat by what name.
 */
export function standingSeatWaits(
  events: readonly { at: string; payload: unknown }[],
  issues: readonly { repoName: string; number: number; stage: string }[],
  tasks: readonly { subjectRef: string; createdAt: string }[],
): Map<string, SeatWait> {
  const newestTask = new Map<string, number>();
  for (const task of tasks) {
    const at = Date.parse(task.createdAt);
    if (!(at <= (newestTask.get(task.subjectRef) ?? Number.NEGATIVE_INFINITY))) newestTask.set(task.subjectRef, at);
  }

  const standing = new Map<string, SeatWait>();
  for (const event of events) {
    const wait = seatWaitFrom(event);
    if (!wait) continue;
    const issue = issues.find((one) => one.repoName === wait.repo && one.number === wait.issue);
    if (!issue || issue.stage !== wait.stage) continue;
    if ((newestTask.get(wait.subjectRef) ?? Number.NEGATIVE_INFINITY) >= Date.parse(wait.since)) continue;
    const seen = standing.get(wait.subjectRef);
    if (!seen) {
      standing.set(wait.subjectRef, wait);
      continue;
    }
    const newer = Date.parse(wait.since) > Date.parse(seen.since) ? wait : seen;
    const first = Date.parse(wait.since) < Date.parse(seen.since) ? wait.since : seen.since;
    standing.set(wait.subjectRef, { ...newer, since: first });
  }
  return standing;
}
