import { tasks as taskStore, threads } from '@openadlc/db';
import { nameTask, namingFacts, type NamedTask, type NamingContext } from './board-work.js';
import type { Router } from './router.js';
import type { TaskFacts } from './work.js';

/**
 * What the console's side panel reads for its Running and Recent tabs
 * (`GET /v1/board/panel`, ADR 0085). Its Needs you tab is `/v1/attention`,
 * read by the console as the person, and nothing here reads attention: a
 * second read of it would be a second audience filter, free to drift from the
 * Needs you page's count.
 */

/** How far back Recent looks, by `tasks.ended_at`. */
export const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How many Recent lists at most. */
export const RECENT_LIMIT = 20;
/** How many running or paused tasks are read: what `readBoardWork` reads its tasks going under. */
const RUNNING_LIMIT = 200;

/**
 * A running row's state in words: `working` is running, `waiting` is paused
 * on a gate a person answers (a question, a plan change, a cost cap), and
 * `paused` is any other pause (a restart pending, a resume the network
 * failed, #360). The board's own rule for a bot waiting (`boardWork`).
 */
export type PanelState = 'working' | 'waiting' | 'paused';

export interface PanelRunning extends NamedTask {
  state: PanelState;
  /**
   * When it came into its present state, which the console says as minutes
   * so far: for `working` when it last began running (`tasks.runningSince`),
   * else its start; for `waiting` and `paused`, when it paused. `openadlc ls`
   * reads `since` the same way.
   */
  since: string | null;
  costUsd: number;
  /** False on a subscription seat, whose spend is an estimate (ADR 0050). */
  billed: boolean;
}

export interface PanelRecent extends NamedTask {
  outcome: 'done' | 'failed' | 'stopped';
  endedAt: string;
  costUsd: number;
  billed: boolean;
}

export interface BoardPanel {
  /** Running and paused tasks across the install, oldest `since` first, so rows stand still between polls. */
  running: PanelRunning[];
  /** Tasks that ended in the last `RECENT_WINDOW_MS`, newest first, at most `RECENT_LIMIT`. */
  recent: PanelRecent[];
}

type PanelTask = TaskFacts & { billed?: boolean; pausedAt?: string | null };

/** What the panel reads, so a test hands it rows rather than a database. */
export interface BoardPanelDeps {
  listTasks(filter: { states: ('running' | 'paused')[]; limit: number }): Promise<PanelTask[]>;
  listFinishedSince(since: Date, limit: number): Promise<PanelTask[]>;
  listOpenGates(): Promise<{ taskId: string | null }[]>;
  runningSince(ids: readonly string[]): Promise<ReadonlyMap<string, string | null>>;
  namingFacts(tasks: readonly TaskFacts[]): Promise<NamingContext>;
}

const liveDeps: BoardPanelDeps = {
  listTasks: (filter) => taskStore.listTasks(filter),
  listFinishedSince: (since, limit) => taskStore.listFinishedSince(since, limit),
  listOpenGates: () => threads.listOpenGates(),
  runningSince: (ids) => taskStore.runningSince(ids),
  namingFacts: (tasks) => namingFacts(tasks),
};

const OUTCOMES = new Set<string>(['done', 'failed', 'stopped']);

/**
 * The panel's tasks. A read that fails fails the whole answer rather than
 * leaving a tab silently short: the console takes a failure as no panel data
 * and keeps what it last drew.
 */
export async function readBoardPanel(now: Date, deps: BoardPanelDeps = liveDeps): Promise<BoardPanel> {
  const [going, finished, gates] = await Promise.all([
    deps.listTasks({ states: ['running', 'paused'], limit: RUNNING_LIMIT }),
    deps.listFinishedSince(new Date(now.getTime() - RECENT_WINDOW_MS), RECENT_LIMIT),
    deps.listOpenGates(),
  ]);
  const gated = new Set(gates.flatMap((gate) => (gate.taskId ? [gate.taskId] : [])));
  const live = going.filter((task) => task.state === 'running' || task.state === 'paused');
  const ended = finished.filter((task) => OUTCOMES.has(task.state) && task.endedAt);
  const runningIds = live.filter((task) => task.state === 'running').map((task) => task.id);
  const [since, naming] = await Promise.all([
    runningIds.length === 0 ? new Map<string, string | null>() : deps.runningSince(runningIds),
    live.length + ended.length === 0 ? null : deps.namingFacts([...live, ...ended]),
  ]);
  if (!naming) return { running: [], recent: [] };

  const running = live.map((task): PanelRunning => {
    const state: PanelState = task.state === 'running' ? 'working' : gated.has(task.id) ? 'waiting' : 'paused';
    const at = state === 'working' ? (since.has(task.id) ? (since.get(task.id) ?? null) : task.startedAt) : (task.pausedAt ?? null);
    return { ...nameTask(task, naming), state, since: at, costUsd: task.costUsd, billed: task.billed ?? true };
  });
  const at = (row: PanelRunning) => (row.since ? Date.parse(row.since) : Number.POSITIVE_INFINITY);
  running.sort((a, b) => at(a) - at(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const recent = ended
    .map(
      (task): PanelRecent => ({
        ...nameTask(task, naming),
        outcome: task.state as PanelRecent['outcome'],
        endedAt: task.endedAt!,
        costUsd: task.costUsd,
        billed: task.billed ?? true,
      }),
    )
    .sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return { running, recent };
}

/** `GET /v1/board/panel`. Called once from `registerConsoleApi`; a test passes its own reads. */
export function registerBoardPanelRoute(router: Router, deps?: BoardPanelDeps): void {
  router.get('/v1/board/panel', async () => readBoardPanel(new Date(), deps));
}
