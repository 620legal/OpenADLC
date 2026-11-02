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
  finish(): Promise<void>;
  current(): Promise<{ id: string; backAt: string; filling: boolean } | null>;
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
 *
 * The bridge serves while this runs, so the stored report is marked filling
 * until the end, failed steps included (`finish`): read before then it said
 * "nothing was resumed" and could be dismissed, and the tasks written after
 * were shown to nobody. A start with no gap of its own that finds a report
 * still filling, left by a start that died part way and came back inside an
 * interval, lists what it resumes and orphans there before finishing it:
 * finished bare, the report said "nothing was resumed" for tasks this start
 * resumed.
 */
export async function startGap(store: GapStore, deps: GapStartDeps): Promise<{ gapId: string | null }> {
  const log = deps.log ?? ((line: string) => console.log(`[bridge] ${line}`));
  const warn = deps.warn ?? ((line: string) => console.warn(`[bridge] ${line}`));
  try {
    return await fill(store, deps, log, warn);
  } finally {
    await store.finish().catch((error: unknown) => warn(`could not mark the gap report complete: ${reasonOf(error)}`));
  }
}

async function fill(store: GapStore, deps: GapStartDeps, log: (line: string) => void, warn: (line: string) => void): Promise<{ gapId: string | null }> {
  let gapId: string | null = null;
  let backAt: string | null = null;
  let beat: Awaited<ReturnType<GapStore['beat']>> | null = null;
  try {
    beat = await store.beat();
  } catch (error) {
    warn(`could not record when it was last running: ${reasonOf(error)}`);
  }
  const lastUpAt = beat?.lastUpAt ?? null;
  if (beat && lastUpAt !== null && Date.parse(beat.backAt) - Date.parse(lastUpAt) > BRIDGE_HEARTBEAT_MS) {
    // The beat that measured the gap is already written over, so the next
    // start cannot find this gap again: one more try before it is lost.
    const at = beat.backAt;
    const open = () => store.openGap(lastUpAt, at);
    try {
      gapId = (await open().catch(open)).id;
      backAt = at;
      log(`back after a gap: last up at ${lastUpAt}`);
    } catch (error) {
      warn(`could not store the gap since ${lastUpAt}, so the board will not report it: ${reasonOf(error)}`);
    }
  }
  if (gapId === null) {
    try {
      const open = await store.current();
      if (open?.filling) {
        gapId = open.id;
        backAt = beat?.backAt ?? open.backAt;
        log(`listing this start’s tasks in the gap report back at ${open.backAt}, which a start that stopped part way left unfinished`);
      }
    } catch (error) {
      warn(`could not read the gap report, so this start’s tasks are not listed in it: ${reasonOf(error)}`);
    }
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
 * The beat while the bridge runs, and the last ones on a clean shutdown: a
 * keeper restart that is back inside the interval then reports no gap.
 * `beat` is for the start of a shutdown, before its drains: they can run past
 * the keeper's grace and be killed before `stop` is reached.
 */
export function startHeartbeat(
  touch: () => Promise<void>,
  intervalMs = BRIDGE_HEARTBEAT_MS,
  warn: (line: string) => void = (line) => console.warn(`[bridge] ${line}`),
): { beat(): Promise<void>; stop(): Promise<void> } {
  const beat = () => touch().catch((error: unknown) => warn(`could not beat: ${reasonOf(error)}`));
  const timer = setInterval(() => void beat(), intervalMs);
  timer.unref?.();
  return {
    beat,
    async stop() {
      clearInterval(timer);
      await beat();
    },
  };
}
