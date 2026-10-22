/**
 * The stops the bridge makes itself, once the work a task was for is over: a
 * review whose pull request merged or closed (`Webhooks.stopReviewsOf`), a
 * build whose issue closed, the work on an abandoned issue, what was paused on
 * a subject that closed.
 *
 * They go through a card's Stop (`stopTask` in api.ts), and were written as
 * one: "stopped by a person from the console (bridge): its pull request
 * merged". The audit log said a person had stopped a review that a merge had,
 * and the crew page counted it as a person's stop.
 */

/** The actor the bridge's own stops are made as, and audited under. */
export const THE_BRIDGE = 'bridge';

/** What the exit reason of a task the bridge stopped starts with: `stopped by the bridge: its pull request merged`. */
export const STOPPED_BY_THE_BRIDGE = 'stopped by the bridge';

/** How a bridge before this one wrote its own stops, which rows written then still say. */
const AS_A_PERSON_BEFORE = 'stopped by a person from the console (bridge)';

/** Why the bridge stopped a task, as its row and the audit log keep it. */
export function bridgeStopReason(why: string): string {
  return why ? `${STOPPED_BY_THE_BRIDGE}: ${why}` : STOPPED_BY_THE_BRIDGE;
}

/**
 * Whether the bridge stopped the task because its work was over. Like a
 * person's stop, it is a decision about the work: no card offers to try it
 * again, no answer resumes it, the deploy sweep does not start it again. It is
 * just not a person's.
 */
export function stoppedByTheBridge(task: { state: string; exitReason?: string | null }): boolean {
  const reason = task.exitReason ?? '';
  return task.state === 'stopped' && (reason.startsWith(STOPPED_BY_THE_BRIDGE) || reason.startsWith(AS_A_PERSON_BEFORE));
}
