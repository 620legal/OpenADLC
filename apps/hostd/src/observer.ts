import { audit, bots, hosts, leases, repos, sessions as sessionStore, tasks } from '@fleetadlc/db';
import { redactSecrets, type TaskKind } from '@fleetadlc/shared';
import { dirname, join, resolve } from 'node:path';
import type { ExecDriver, FoundComputer, TaskComputer } from './drivers/types.js';

/** A task in one of these is finished; nothing should still be held for it. */
const TERMINAL_STATES = new Set(['stopped', 'done', 'failed']);

type TaskRow = NonNullable<Awaited<ReturnType<typeof tasks.getTask>>>;

/**
 * What the database says of a task: its row, that it has none, or nothing,
 * because it could not be asked. A lookup that failed was read as "no row",
 * and no row counts as over: a database outage during a reap deleted every
 * paused task's kept branch, the only copy of its unpushed commits.
 */
type Lookup = { kind: 'row'; task: TaskRow } | { kind: 'absent' } | { kind: 'unknown' };

async function lookUp(taskId: string): Promise<Lookup> {
  try {
    const task = await tasks.getTask(taskId);
    return task ? { kind: 'row', task } : { kind: 'absent' };
  } catch {
    return { kind: 'unknown' };
  }
}

/** Over for good: a row in a terminal state, or no row at all. Unknown is not over. */
function isOver(lookup: Lookup): boolean {
  return lookup.kind === 'absent' || (lookup.kind === 'row' && TERMINAL_STATES.has(lookup.task.state));
}

/**
 * Whether a task's row names the computer found for it: its container under
 * docker, or its worktree in the found directory where there is no container.
 * Only a directory hostd makes task directories in counts.
 */
function namesComputer(
  task: { container?: string | null; worktree: string | null },
  found: FoundComputer,
  slotsRoot: string | null,
): boolean {
  if (!slotsRoot || !found.slotDir) return false;
  const dir = resolve(found.slotDir);
  if (dirname(dir) !== resolve(slotsRoot)) return false;
  return task.container ? task.container === found.name : task.worktree === join(dir, 'wt');
}

/** The part of `TaskRunner` the observer needs, so it can be faked in a test. */
export interface RunningTasks {
  activeTaskIds(): string[];
  /** This host's row id, once hostd has registered it; null in a test that has none. */
  hostId?: string | null;
  end(taskId: string, reason: string): Promise<void>;
  /** What the reaper asks of the runner; a runner without them is not reaped for. */
  adopt?(
    task: { id: string; kind: TaskKind; branch: string | null; tmuxSession: string | null },
    computer: TaskComputer,
    repoFullName: string | null,
  ): void;
  releasePausedPast?(keepMs: number, isPaused: (taskId: string) => Promise<boolean>): Promise<string[]>;
  pruneAbandonedSlots?(): Promise<number>;
  /** Where hostd makes task directories; a computer is adopted only with its directory there. */
  slotsRoot?(): string;
  /** Whether a task's computer is being made now, so the reaper leaves it be. */
  isStarting?(taskId: string): boolean;
  /** `isOver` answers false, or the branch of a task over for good, under which its unpushed commits are set aside. */
  dropFinishedTaskRefs?(isOver: (taskId: string) => Promise<boolean | { branch: string | null }>): Promise<number>;
}

/** How often the reaper runs, in observer ticks: once a minute at the usual ten seconds. */
export const REAP_EVERY = 6;

/**
 * How many successful listings in a row a running task's session must be
 * missing from before the task is stopped. Stopping removes its computer and,
 * at the next reap, its harvested branch, so a listing that was merely wrong
 * once cost the task everything it had not pushed. Three ticks is about thirty
 * seconds later than a single missed look.
 */
export const MISSES_BEFORE_STOP = 3;

/** Only the lines that appeared since the last tick are worth storing. */
export function newPaneLines(previous: readonly string[], current: readonly string[]): string[] {
  if (previous.length === 0) return [...current];
  const anchor = previous.at(-1);
  if (anchor === undefined) return [...current];

  for (let index = current.length - 1; index >= 0; index -= 1) {
    if (current[index] !== anchor) continue;
    const tailMatches = previous
      .slice(-Math.min(previous.length, index + 1))
      .every((line, offset) => current[index - Math.min(previous.length, index + 1) + 1 + offset] === line);
    if (tailMatches) return current.slice(index + 1);
  }

  return [...current];
}

/**
 * Every ten seconds, hostd lists what is actually running in each bot's computer
 * and writes it down. The Computer tab renders exactly this; the crew roster's
 * "now" line and the board's working dot are derived from it. A bot with no
 * sessions shows "nothing running", because that is what is true.
 */
export class SessionObserver {
  private timer: NodeJS.Timeout | null = null;
  private readonly lastPane = new Map<string, string[]>();
  /** Consecutive listings each running task's session was missing from; see `MISSES_BEFORE_STOP`. */
  private readonly misses = new Map<string, number>();
  private ticks = 0;
  /** A tick is running; see `tick`. */
  private ticking = false;
  /** A tick was skipped since the last one finished, which has been said once. */
  private skipping = false;

  constructor(
    private readonly driver: ExecDriver,
    private readonly hostName: string,
    private readonly intervalMs = 10_000,
    /**
     * Optional so the observer can still be tested on its own, but an install
     * always passes it: without it nothing reconciles what hostd thinks is
     * running against what the database says, and a container stays busy.
     */
    private readonly runner: RunningTasks | null = null,
    /** How long a paused task keeps its computer; see `TaskRunner.releasePausedPast`. */
    private readonly pausedKeepMs = 15 * 60_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Drops what hostd is still holding for a task the database has finished with.
   *
   * `TaskRunner.active` was only ever emptied by the call that should have come:
   * `/tasks/:id/cleanup` from the skill runner's completion report, a cancel, or
   * a container restart. Anything else that ended a task — the bridge dying
   * before it reported, the reconciler failing a task whose host went silent,
   * the observer above stopping one whose session disappeared — left the entry
   * behind for the life of the process. Each entry counts in `computersHeld()`
   * against the host's `FLEETADLC_HOST_CAPACITY_TASKS`: a leaked one held a
   * place no task used, and once enough leaked, the host refused every start as
   * full until hostd restarted. The dispatcher counts the database's rows and
   * did not notice.
   *
   * The database is the authority here, not this map. An id with no row, or a
   * row in a terminal state, is not running whatever hostd remembers. One the
   * database could not be asked about is left held.
   */
  private async forgetFinishedTasks(): Promise<void> {
    if (!this.runner) return;

    for (const taskId of this.runner.activeTaskIds()) {
      const lookup = await lookUp(taskId);
      if (!isOver(lookup)) continue;

      const why = lookup.kind === 'row' ? `the task is ${lookup.task.state}` : 'the task row is gone';
      // `end` is what releases the worktree and the session too, which is the
      // rest of what leaked.
      await this.runner.end(taskId, why).catch(() => undefined);
      console.log(`[hostd] released what was held for ${taskId}: ${why}`);
    }
  }

  /**
   * One look, never two at once. The interval fires whether or not the last
   * tick has finished, and a Docker daemon that stopped answering parked each
   * tick on its first call: ticks stacked up every ten seconds with a hung
   * docker process each, and when the daemon came back they all resumed
   * together, reapers included, adopting and releasing the same containers.
   * A tick that finds one still running is skipped, and does not count
   * towards the reaper's turn.
   */
  async tick(): Promise<void> {
    if (this.ticking) {
      if (!this.skipping) console.log('[hostd] observer: the last look has not finished, so the next ones are skipped until it does');
      this.skipping = true;
      return;
    }
    this.ticking = true;
    try {
      await this.look();
    } finally {
      this.ticking = false;
      this.skipping = false;
    }
  }

  private async look(): Promise<void> {
    // The reap reads the database too; while it cannot be read, what the
    // reap would decide is not to be trusted.
    let databaseAnswered = false;
    try {
      await hosts.heartbeat(this.hostName);
      const crew = await bots.listBots();
      const listed = await tasks.listTasks({ states: ['running', 'queued', 'paused'], limit: 200 });
      // Only this host's sessions are in its driver's listing. A second hostd
      // on the same database saw none of the first's, and within a tick
      // stopped every task the first was running, released their leases and
      // deleted their session rows; the first then tore their containers
      // down. A task with no host yet has not started anywhere.
      const myHost = this.runner?.hostId ?? null;
      const elsewhere = (task: { hostId: string | null }) => myHost !== null && task.hostId !== null && task.hostId !== myHost;
      const running = listed.filter((task) => !elsewhere(task));
      const otherHosts = new Set(listed.filter(elsewhere).map((task) => task.id));

      for (const bot of crew) {
        // A listing that failed says nothing about which sessions are gone, so
        // nothing of this bot's is removed or stopped on this tick.
        let observed;
        try {
          observed = await this.driver.listSessions(bot.name);
        } catch (error) {
          console.log(
            `[hostd] ${bot.name}: could not read its sessions, so nothing is stopped this tick: ${error instanceof Error ? error.message : error}`,
          );
          continue;
        }
        const seen = new Set<string>();

        for (const session of observed) {
          seen.add(session.name);
          const task = running.find(
            (candidate) => candidate.botId === bot.id && candidate.tmuxSession === `${bot.name}/${session.name}`,
          );

          const record = await sessionStore.observeSession({
            botId: bot.id,
            taskId: task?.id ?? null,
            name: session.name,
            cmd: session.cmd,
            state: session.state,
            pid: session.pid,
            // A token a bot wrote into its narration, or `env` typed by a person
            // who took the terminal over, was stored as it was, in the database
            // and its backups, and the last line was shown to every console user.
            lastLine: session.lastLine === null ? null : redactSecrets(session.lastLine),
          });

          // The diff is taken on the raw pane and only what is stored is
          // redacted: a line the redaction changed would no longer match the
          // one kept from the last tick, and the whole pane would read as new.
          const paneKey = `${bot.name}/${session.name}`;
          const fresh = newPaneLines(this.lastPane.get(paneKey) ?? [], session.pane);
          if (fresh.length > 0) {
            await sessionStore.appendSessionLog(record.id, fresh.map(redactSecrets));
          }
          this.lastPane.set(paneKey, session.pane.slice(-50));
        }

        // Sessions that have gone are removed rather than left as stale rows.
        const known = await sessionStore.listSessions(bot.id);
        for (const stale of known) {
          if (stale.taskId && otherHosts.has(stale.taskId)) continue;
          if (!seen.has(stale.name)) {
            await sessionStore.removeSession(bot.id, stale.name);
            this.lastPane.delete(`${bot.name}/${stale.name}`);
          }
        }

        // A task whose session is gone is not running, whatever the row says.
        // This is what makes a killed session return its issue to the board
        // instead of leaving the work claimed by a bot that is doing nothing.
        //
        // A task that finished on its own has no session either, because its own
        // cleanup killed it — and `running` here is a snapshot taken before that
        // could happen. So the stop is conditional in the database: it applies
        // only while the task is still running, and a task that already reported
        // how it ended keeps that ending.
        for (const task of running) {
          if (task.botId !== bot.id || task.state !== 'running' || !task.tmuxSession) continue;
          const sessionName = task.tmuxSession.split('/').at(-1) ?? '';
          if (seen.has(sessionName)) {
            this.misses.delete(task.id);
            continue;
          }
          const missed = (this.misses.get(task.id) ?? 0) + 1;
          if (missed < MISSES_BEFORE_STOP) {
            this.misses.set(task.id, missed);
            continue;
          }
          this.misses.delete(task.id);

          const stopped = await tasks.stopIfRunning(
            task.id,
            'the session was killed; the branch and the issue are untouched',
          );
          if (!stopped) continue;

          // A lease with a pull request outlives the task that opened it. The
          // change is still in flight until that pull request closes unmerged or
          // merges and its verification finishes, and releasing here would let a
          // second, overlapping issue go out while the first is in review.
          if (task.leaseId) {
            const lease = await leases.getLease(task.leaseId).catch(() => null);
            if (lease?.prNumber) {
              console.log(`[hostd] keeping the lease on ${task.subjectRef}: #${lease.prNumber} is still open`);
            } else {
              await leases.setLeaseState(task.leaseId, 'released');
            }
          }
          await audit({
            actor: 'hostd',
            action: 'task.stopped',
            target: task.subjectRef,
            payload: { reason: 'session disappeared', branch: task.branch },
          });
          console.log(`[hostd] ${bot.name}: session ${sessionName} is gone; stopped its task on ${task.subjectRef}`);
        }
      }

      // A count is kept only for a task still running.
      for (const taskId of this.misses.keys()) {
        if (!running.some((task) => task.id === taskId && task.state === 'running')) this.misses.delete(taskId);
      }

      await this.forgetFinishedTasks();
      databaseAnswered = true;
    } catch (error) {
      console.error('[hostd] observer tick failed:', error instanceof Error ? error.message : error);
    }
    if (this.ticks++ % REAP_EVERY === 0 && databaseAnswered) {
      await this.reapComputers().catch((error: unknown) => {
        console.error('[hostd] reaping computers failed:', error instanceof Error ? error.message : error);
      });
    }
  }

  /**
   * Squares the computers on this host with the tasks they are for.
   *
   * A computer is a container now, made per task, and a container outlives
   * whatever forgot it: hostd restarting while a task ran, a release that
   * failed, a task the bridge ended while hostd was down. Each one found is:
   *
   * - released, when its task is over or no task row names it;
   * - adopted, when its task is still running or paused, nothing here holds
   *   it, and the task's row names it — after a restart its session is still
   *   going, and adopting it is what lets the task end, be watched and be
   *   taken over as if hostd had never stopped;
   * - discarded, when it claims a running or paused task whose row names
   *   another computer, or none;
   * - discarded, when it says nothing about whose it is;
   * - left alone, when the database could not say what its task is.
   *
   * Then a paused task's computer is given back once it has been paused
   * longer than it is kept (`releasePausedPast`), task folders nothing holds
   * are cleared with their branches kept, and the kept branches of tasks that
   * have ended for good are dropped from the mirrors.
   */
  async reapComputers(): Promise<void> {
    const runner = this.runner;
    if (!runner) return;
    const held = new Set(runner.activeTaskIds());

    for (const found of (await this.driver.computers?.().catch(() => [])) ?? []) {
      // A warm computer the pool does not hold was made by a hostd before this
      // one, from an image and mounts nothing here can vouch for: its labels
      // are for a person to read, and are not checked.
      if (found.kind === 'warm') {
        if (!this.driver.isWarm?.(found.name)) await this.driver.discard?.(found.name).catch(() => undefined);
        continue;
      }
      if (!found.taskId) {
        await this.driver.discard?.(found.name).catch(() => undefined);
        console.log(`[hostd] removed ${found.name}: it says nothing about which task it is for`);
        continue;
      }
      const lookup = await lookUp(found.taskId);
      if (lookup.kind === 'unknown') continue;
      const task = lookup.kind === 'row' ? lookup.task : null;
      if (!task || TERMINAL_STATES.has(task.state)) {
        // `forgetFinishedTasks` ends what is held, with its branch kept. One
        // being started is the start's, whatever its row said a moment ago.
        if (held.has(found.taskId) || this.driver.computerOf(found.taskId) || runner.isStarting?.(found.taskId)) continue;
        const computer = await this.driver.adopt?.(found).catch(() => null);
        if (computer) {
          await this.driver.release(found.taskId, task ? `its task is ${task.state}` : 'no task names it').catch(() => undefined);
        } else {
          await this.driver.discard?.(found.name).catch(() => undefined);
        }
        console.log(`[hostd] removed ${found.name}: ${task ? `its task is ${task.state}` : 'no task names it'}`);
        continue;
      }
      // Held, or being started: `acquire` registers a computer before the
      // task is held, and taking it back then would race the start.
      if (held.has(found.taskId) || this.driver.computerOf(found.taskId) || runner.isStarting?.(found.taskId) || !runner.adopt) continue;
      // Which task a computer is for comes from its slot's record, and a
      // computer started before records moved out of its directory has one
      // its task could rewrite. A task that wrote a paused task's id there
      // was adopted as that task: its terminal and local CI ran in the
      // other's name. So only the computer the row names is adopted.
      if (!namesComputer(task, found, runner.slotsRoot?.() ?? null)) {
        await this.driver.discard?.(found.name).catch(() => undefined);
        console.log(`[hostd] removed ${found.name}: it claims task ${found.taskId}, whose row names ${task.container ?? task.worktree ?? 'no computer'}, not it`);
        continue;
      }
      const computer = await this.driver.adopt?.(found).catch(() => null);
      if (!computer) continue;
      const repoFullName = task.repoId
        ? ((await repos.listRepos({ includeRemoved: true }).catch(() => [])).find((repo) => repo.id === task.repoId)?.fullName ?? null)
        : null;
      runner.adopt(task, computer, repoFullName);
      console.log(`[hostd] took back ${found.name} for ${task.state} task ${task.id} (${task.subjectRef})`);
    }

    await runner.releasePausedPast?.(this.pausedKeepMs, async (taskId) => {
      const lookup = await lookUp(taskId);
      return lookup.kind === 'row' && lookup.task.state === 'paused';
    });
    await runner.pruneAbandonedSlots?.().catch(() => 0);
    await runner
      .dropFinishedTaskRefs?.(async (taskId) => {
        const lookup = await lookUp(taskId);
        // Rejecting keeps the branch (`Worktrees.dropTaskRefs`).
        if (lookup.kind === 'unknown') throw new Error(`could not read task ${taskId}`);
        return isOver(lookup) && { branch: lookup.kind === 'row' ? lookup.task.branch : null };
      })
      .catch(() => 0);
    // And the warm pool brought to its targets, once nothing stale is left.
    await this.driver.refreshWarm?.().catch(() => undefined);
  }
}
