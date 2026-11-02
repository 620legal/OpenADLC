import type { GapTask } from '@openadlc/db';
import type { Drift } from './reconciler.js';

/**
 * How often the bridge says it is running, and how long a start may come
 * after the last beat before it counts as a gap. The keeper's restart and a
 * self-update are back well inside it, and a clean shutdown beats once more
 * on its way out, so only a crash or a stop the console noticed reports one.
 */
export const BRIDGE_HEARTBEAT_MS = 30_000;

/** What `startGap` needs of `bridgeGaps` (packages/db/src/store/bridge-gaps.ts). */
export interface GapStore {
  beat(): Promise<{ lastUpAt: string | null; backAt: string }>;
  openGap(lastUpAt: string, backAt: string): Promise<{ id: string }>;
  addTasks(id: string, tasks: readonly GapTask[]): Promise<void>;
}

export interface GapStartDeps {
  /** `TaskService.resumeAnswered`, which says each task that left `paused`. */
  resume(onResumed: (task: { id: string; subjectRef: string }, line: string) => void): Promise<string[]>;
  /** One repairing pass of `Reconciler.run`. */
  reconcile(): Promise<Drift[]>;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The bridge's start: beats, and when the beat it replaced is more than one
 * interval old, records the gap and what this start did about it.
 *
 * The orphan verdicts come from a reconcile pass run here: the timed one
 * first runs an interval after start (`job-timer.ts`), and the report would
 * have no orphans until then. It runs only after a gap. The gap is stored
 * before either step, so a gap that cost nothing, or a start that dies part
 * way, still says how long the bridge was away. Nothing here throws: a step
 * that fails is logged and leaves what was stored.
 */
export async function startGap(store: GapStore, deps: GapStartDeps): Promise<{ gapId: string | null }> {
  const log = deps.log ?? ((line: string) => console.log(`[bridge] ${line}`));
  const warn = deps.warn ?? ((line: string) => console.warn(`[bridge] ${line}`));
  let gapId: string | null = null;
  let backAt: string | null = null;
  try {
    const beat = await store.beat();
    if (beat.lastUpAt !== null && Date.parse(beat.backAt) - Date.parse(beat.lastUpAt) > BRIDGE_HEARTBEAT_MS) {
      gapId = (await store.openGap(beat.lastUpAt, beat.backAt)).id;
      backAt = beat.backAt;
      log(`back after a gap: last up at ${beat.lastUpAt}`);
    }
  } catch (error) {
    warn(`could not record when it was last running: ${reasonOf(error)}`);
  }

  const resumed: GapTask[] = [];
  try {
    const lines = await deps.resume((task, line) => {
      if (backAt) resumed.push({ taskId: task.id, subject: task.subjectRef, outcome: 'resumed', why: line, backAt });
    });
    for (const line of lines) log(line);
  } catch (error) {
    warn(`could not resume answered tasks: ${reasonOf(error)}`);
  }
  if (gapId === null || backAt === null) return { gapId };
  const at = backAt;
  if (resumed.length > 0) await store.addTasks(gapId, resumed).catch((error: unknown) => warn(`could not list the resumed tasks in the gap report: ${reasonOf(error)}`));

  try {
    const orphaned = (await deps.reconcile())
      .filter((entry) => entry.kind === 'orphaned_task' && entry.repaired && entry.taskId)
      .map((entry): GapTask => ({ taskId: entry.taskId!, subject: entry.subject, outcome: 'orphaned', why: entry.detail, backAt: at }));
    if (orphaned.length > 0) await store.addTasks(gapId, orphaned);
  } catch (error) {
    warn(`could not list the orphaned tasks in the gap report: ${reasonOf(error)}`);
  }
  return { gapId };
}

/**
 * The beat while the bridge runs, and the last one on a clean shutdown: a
 * keeper restart that is back inside the interval then reports no gap.
 */
export function startHeartbeat(touch: () => Promise<void>, intervalMs = BRIDGE_HEARTBEAT_MS): { stop(): Promise<void> } {
  const beat = () => void touch().catch((error: unknown) => console.warn(`[bridge] could not beat: ${reasonOf(error)}`));
  const timer = setInterval(beat, intervalMs);
  timer.unref?.();
  return {
    async stop() {
      clearInterval(timer);
      await touch().catch(() => undefined);
    },
  };
}
