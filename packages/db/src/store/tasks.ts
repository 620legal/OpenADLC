import { redactSecrets } from '@fleetadlc/shared';
import type { ContextDocument, Task, TaskKind, TaskState } from '@fleetadlc/shared';
import { query, queryOne } from '../client.js';

interface TaskRow {
  id: string;
  bot_id: string;
  repo_id: string | null;
  kind: TaskKind;
  subject_type: Task['subjectType'];
  subject_ref: string;
  lease_id: string | null;
  state: TaskState;
  skill: string | null;
  worktree: string | null;
  branch: string | null;
  tmux_session: string | null;
  container: string | null;
  host_id: string | null;
  cost_cap_usd: string;
  cost_usd: string;
  round: number;
  started_at: Date | null;
  ended_at: Date | null;
  exit_reason: string | null;
  created_at: Date;
  auto_retried_at: Date | null;
  base_ref?: string | null;
  base_context?: ContextDocument[] | null;
}

export interface TaskRecord extends Task {
  skill: string | null;
  costCapUsd: number;
  /** When the task was opened, which is the order "was it tried again since" is asked in. */
  createdAt: string;
  /** When OpenADLC ran it again by itself, or was itself such a retry; see `claimAutoRetry`. */
  autoRetriedAt: string | null;
  /** The branch its worktree started from when that was not the default branch: a stacked build's dependency. */
  baseRef: string | null;
  /** What it was told about that branch when it started, told again when it resumes. */
  baseContext: ContextDocument[];
  /**
   * The container its computer is, as hostd wrote it when the task started;
   * null under the local driver and once a paused task's computer is given
   * back. What hostd checks a computer found after a restart against.
   */
  container: string | null;
  /** The host whose hostd started it, as hostd wrote it; see `SessionObserver`, and whose heartbeat reconcile reads. */
  hostId: string | null;
}

const COLUMNS = `id, bot_id, repo_id, kind, subject_type, subject_ref, lease_id, state, skill,
         worktree, branch, tmux_session, container, cost_cap_usd, cost_usd, round,
         started_at, ended_at, exit_reason, created_at, auto_retried_at, base_ref, base_context, host_id`;

const SELECT = `
  select ${COLUMNS}
  from tasks
`;

function toTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    botId: row.bot_id,
    repoId: row.repo_id,
    kind: row.kind,
    subjectType: row.subject_type,
    subjectRef: row.subject_ref,
    leaseId: row.lease_id,
    state: row.state,
    skill: row.skill,
    worktree: row.worktree,
    branch: row.branch,
    tmuxSession: row.tmux_session,
    container: row.container ?? null,
    hostId: row.host_id ?? null,
    costCapUsd: Number(row.cost_cap_usd),
    costUsd: Number(row.cost_usd),
    round: row.round,
    startedAt: row.started_at?.toISOString() ?? null,
    endedAt: row.ended_at?.toISOString() ?? null,
    exitReason: row.exit_reason,
    createdAt: row.created_at.toISOString(),
    autoRetriedAt: row.auto_retried_at?.toISOString() ?? null,
    baseRef: row.base_ref ?? null,
    baseContext: row.base_context ?? [],
  };
}

export async function createTask(input: {
  /** Omitted everywhere but the scripted board, which has to find its own rows again. */
  id?: string;
  botId: string;
  repoId: string | null;
  kind: TaskKind;
  subjectType: Task['subjectType'];
  subjectRef: string;
  leaseId?: string | null;
  skill?: string | null;
  branch?: string | null;
  costCapUsd?: number;
  round?: number;
  /** The branch it starts from, when not the default; see `TaskRecord.baseRef`. */
  baseRef?: string | null;
  baseContext?: ContextDocument[] | null;
}): Promise<TaskRecord> {
  const row = await queryOne<TaskRow>(
    `insert into tasks (id, bot_id, repo_id, kind, subject_type, subject_ref, lease_id, skill, branch, cost_cap_usd, round, base_ref, base_context)
     values (coalesce($11::uuid, gen_random_uuid()),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$12,$13::jsonb)
     returning ${COLUMNS}`,
    [
      input.botId,
      input.repoId,
      input.kind,
      input.subjectType,
      input.subjectRef,
      input.leaseId ?? null,
      input.skill ?? null,
      input.branch ?? null,
      input.costCapUsd ?? 15,
      input.round ?? 0,
      input.id ?? null,
      input.baseRef ?? null,
      input.baseContext && input.baseContext.length > 0 ? JSON.stringify(input.baseContext) : null,
    ],
  );
  if (!row) throw new Error('failed to create task');
  return toTask(row);
}

export async function getTask(id: string): Promise<TaskRecord | null> {
  const row = await queryOne<TaskRow>(`${SELECT} where id = $1`, [id]);
  return row ? toTask(row) : null;
}

export async function listTasks(filter: { botId?: string; states?: TaskState[]; limit?: number } = {}): Promise<
  TaskRecord[]
> {
  const rows = await query<TaskRow>(
    `${SELECT}
     where ($1::uuid is null or bot_id = $1)
       and ($2::text[] is null or state = any($2))
     order by created_at desc
     limit $3`,
    [filter.botId ?? null, filter.states ?? null, filter.limit ?? 100],
  );
  return rows.map(toTask);
}

/**
 * Every task of one kind opened on any of these subjects, newest first.
 *
 * By subject rather than a page of one bot's recent tasks: "was this pull
 * request ever deployed" has to have the same answer however long ago it was,
 * and whichever bot did it.
 */
export async function listTasksForSubjects(kind: TaskKind, subjectRefs: readonly string[]): Promise<TaskRecord[]> {
  if (subjectRefs.length === 0) return [];
  const rows = await query<TaskRow>(
    `${SELECT}
     where kind = $1 and subject_ref = any($2)
     order by created_at desc`,
    [kind, subjectRefs],
  );
  return rows.map(toTask);
}

/**
 * Every task opened on any of these subjects, whatever its kind, newest first.
 *
 * The board asks this for its cards: an issue's own tasks are on `repo#issue`
 * and its pull request's on `repo#pr`, and a card is the sum of both — what it
 * has cost, and who is on it now.
 */
export async function listTasksOnSubjects(subjectRefs: readonly string[]): Promise<TaskRecord[]> {
  if (subjectRefs.length === 0) return [];
  const rows = await query<TaskRow>(
    `${SELECT}
     where subject_ref = any($1)
     order by created_at desc`,
    [subjectRefs],
  );
  return rows.map(toTask);
}

/**
 * Tasks opened or ended since a moment, and every one still going, newest
 * first: what "needs you" reads to find a failure nobody has tried again.
 */
export async function listTasksSince(since: Date): Promise<TaskRecord[]> {
  const rows = await query<TaskRow>(
    `${SELECT}
     where created_at >= $1 or ended_at >= $1 or state in ('queued','running','paused')
     order by created_at desc`,
    [since],
  );
  return rows.map(toTask);
}

/**
 * How many of this bot's tasks are queued or running (paused ones are not
 * counted): whether a rename, a restore or retiring its old container would
 * pull work out from under it.
 */
export async function countActiveTasksForBot(botId: string): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `select count(*)::text as count from tasks where bot_id = $1 and state in ('queued','running')`,
    [botId],
  );
  return Number(row?.count ?? 0);
}

/**
 * Whether a seat may start one more task: it holds fewer computers than its
 * `bots.max_tasks` (Crew → "tasks at once"), counting `alsoStarting` the
 * caller has started in this pass and not yet seen in the table. A seat that
 * is not there has no room. A paused task that kept its computer counts, as in
 * `countSeatSlotsInUse`: without it a review paused on a question was given a
 * second computer beside it, and both ran once the first resumed.
 *
 * Every caller that asked "has this bot anything running" asked it because a
 * bot ran one task at a time. With several, the question is whether it has
 * room; a check that still asked the first one held a seat at one task.
 */
export async function seatHasRoom(botId: string, alsoStarting = 0): Promise<boolean> {
  const row = await queryOne<{ room: boolean }>(
    `select (select count(*) from tasks
              where bot_id = $1 and (state in ('queued','running') or (state = 'paused' and host_id is not null))) + $2 < b.max_tasks as room
     from bots b where b.id = $1`,
    [botId, alsoStarting],
  );
  return row?.room === true;
}

/** The task this seat is already running on this subject, if any; see `tasks_one_live_per_bot_subject`. */
export async function liveTaskOn(botId: string, subjectRef: string): Promise<TaskRecord | null> {
  const row = await queryOne<TaskRow>(
    `${SELECT} where bot_id = $1 and subject_ref = $2 and state in ('queued','running') order by created_at desc limit 1`,
    [botId, subjectRef],
  );
  return row ? toTask(row) : null;
}

/**
 * How many of a seat's tasks hold a computer: queued or running, and paused
 * while its computer is kept (`host_id` set). A paused task whose computer was
 * given back holds nothing until its answer resumes it, so it does not keep
 * its seat from other work.
 */
export async function countSeatSlotsInUse(botId: string): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `select count(*)::text as count from tasks
     where bot_id = $1 and (state in ('queued','running') or (state = 'paused' and host_id is not null))`,
    [botId],
  );
  return Number(row?.count ?? 0);
}

/**
 * How many builds a repository has that are not finished, paused ones
 * included: what its `concurrency` is counted against. A paused build is still
 * the repository's work in flight, whether or not it holds a computer.
 */
export async function countUnfinishedImplementTasks(repoId: string): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `select count(*)::text as count from tasks where repo_id = $1 and kind = 'implement' and state in ('queued','running','paused')`,
    [repoId],
  );
  return Number(row?.count ?? 0);
}

/**
 * A paused task's computer was given back: it is on no host until it resumes,
 * so it no longer counts against its seat or the hosts' capacity.
 */
export async function releaseComputer(id: string): Promise<void> {
  await query(`update tasks set host_id = null, container = null, updated_at = now() where id = $1 and state = 'paused'`, [id]);
}

/**
 * Paused tasks whose question has been answered since they paused, with when:
 * a resume is owed to each. The answer that let one go is the record of it,
 * not a timer in the bridge, so a resume a full host or a restart kept from
 * starting is found again (`TaskService.resumeAnswered`). A task with a
 * question still open is waiting on a person, and one whose newest answer is
 * older than its pause paused again on its own (at its cost cap).
 */
export async function pausedWithAnswer(): Promise<(TaskRecord & { answeredAt: string })[]> {
  const rows = await query<TaskRow & { gate_answered_at: Date }>(
    `with newest as (
       select distinct on (task_id) task_id as gate_task_id, state as gate_state, answered_at as gate_answered_at
       from gates
       where task_id is not null
       order by task_id, created_at desc
     )
     select ${COLUMNS}, newest.gate_answered_at
     from tasks
     join newest on newest.gate_task_id = tasks.id
     where tasks.state = 'paused'
       and newest.gate_state = 'answered'
       and newest.gate_answered_at > tasks.paused_at
       and not exists (select 1 from gates g where g.task_id = tasks.id and g.state = 'open')
     order by newest.gate_answered_at`,
  );
  return rows.map((row) => ({ ...toTask(row), answeredAt: row.gate_answered_at.toISOString() }));
}

/**
 * Removes a task the bridge recorded and hostd refused for want of room
 * (`HostFull`) before it ever started: it is tried again as a busy seat's work
 * is, and a stopped row for it would be a card about nothing.
 */
export async function discardUnstarted(id: string): Promise<void> {
  await query(`delete from tasks where id = $1 and state = 'queued' and started_at is null`, [id]);
}

/**
 * Tasks recorded and never handed to a host: queued, never started, on no
 * host, and opened before `olderThan`. The bridge writes the row before it
 * reads the subject and asks hostd, and a bridge that threw or exited in
 * between left it queued for good, holding its seat, a host's room, its
 * subject and its issue. hostd writes `started_at` and `host_id` only once
 * the session is up, so `olderThan` has to be well past a slow start.
 */
export async function staleUnstarted(olderThan: Date): Promise<TaskRecord[]> {
  const rows = await query<TaskRow>(
    `${SELECT}
     where state = 'queued' and started_at is null and host_id is null and created_at < $1
     order by created_at`,
    [olderThan],
  );
  return rows.map(toTask);
}

/** Fails a task that never started, only while it still has not: a start that landed meanwhile is left alone. */
export async function failUnstarted(id: string, reason: string): Promise<TaskRecord | null> {
  const row = await queryOne<TaskRow>(
    `update tasks set state = 'failed', exit_reason = $2, ended_at = now(), updated_at = now()
     where id = $1 and state = 'queued' and started_at is null and host_id is null
     returning ${COLUMNS}`,
    [id, reason],
  );
  return row ? toTask(row) : null;
}

/**
 * The states a task may be in for `updateTaskState` to move it to each state.
 *
 * Every write used to land whatever the task was in: a start that finished
 * after a cancel wrote `running` over `stopped`, and a failed task could turn
 * `done`, so work a person stopped ran on and a second build could be leased
 * on the same issue. A task that has ended stays ended, and a `done` one is
 * not changed at all. A failed one may still be stopped: the card's Stop on
 * it. Writing an ending a task already has again is harmless and allowed.
 */
export const TASK_STATE_FROM: Record<TaskState, readonly TaskState[]> = {
  queued: ['queued', 'running', 'paused'],
  running: ['queued', 'running', 'paused'],
  paused: ['queued', 'running', 'paused'],
  done: ['queued', 'running', 'paused'],
  failed: ['queued', 'running', 'paused', 'failed'],
  stopped: ['queued', 'running', 'paused', 'failed', 'stopped'],
};

/**
 * Moves a task to `state`, in one statement guarded by `TASK_STATE_FROM`.
 * Null when there is no such task, or it is in a state it may not leave for
 * this one; `getTask` tells the two apart.
 */
export async function updateTaskState(
  id: string,
  state: TaskState,
  patch: {
    exitReason?: string | null;
    costUsd?: number;
    worktree?: string | null;
    tmuxSession?: string | null;
    /** The container the task's computer is, and the host it is on; written by hostd as it starts the task. */
    container?: string | null;
    hostId?: string | null;
  } = {},
): Promise<TaskRecord | null> {
  const row = await queryOne<TaskRow>(
    `update tasks set
       state = $2,
       exit_reason = coalesce($3, exit_reason),
       cost_usd = coalesce($4, cost_usd),
       worktree = coalesce($5, worktree),
       tmux_session = coalesce($6, tmux_session),
       container = coalesce($7, container),
       host_id = coalesce($8::uuid, host_id),
       started_at = case when $2 = 'running' and started_at is null then now() else started_at end,
       ended_at = case when $2 in ('done','failed','stopped') then now() else ended_at end,
       -- Only on the way in: the runner reports a pause again after the
       -- gate's own, and a second stamp could land after a quick answer.
       paused_at = case when $2 = 'paused' and state <> 'paused' then now() else paused_at end,
       updated_at = now()
     where id = $1 and state = any($9::text[])
     returning ${COLUMNS}`,
    [
      id,
      state,
      // Never a credential: a failed git command's reason carries its remote,
      // token and all, and this is shown on the board. See `redactSecrets`.
      patch.exitReason == null ? null : redactSecrets(patch.exitReason),
      patch.costUsd ?? null,
      patch.worktree ?? null,
      patch.tmuxSession ?? null,
      patch.container ?? null,
      patch.hostId ?? null,
      TASK_STATE_FROM[state] ?? [],
    ],
  );
  return row ? toTask(row) : null;
}

/**
 * The task a session was started for, newest first: the terminal is asked for
 * by bot and session, and a computer is the task's. Null when no task names it.
 */
export async function findTaskBySession(tmuxSession: string): Promise<TaskRecord | null> {
  const row = await queryOne<TaskRow>(`${SELECT} where tmux_session = $1 order by created_at desc limit 1`, [tmuxSession]);
  return row ? toTask(row) : null;
}

/**
 * What the exit reason of a task a person stopped starts with.
 *
 * `stopped` is written both when hostd finds a task's session gone — a crash,
 * a host that went away — and when a person kills the session on purpose, and
 * the row said nothing more. The deploy sweep treated both as a deploy that
 * never happened, and started one a person had stopped again within half an
 * hour. The reason is where the difference is kept, because it is already
 * what the board shows and what every ending writes.
 */
export const STOPPED_BY_PERSON = 'stopped by a person';

/** Whether a task ended because a person stopped it, rather than because its session went away. */
export function stoppedByPerson(task: { state: TaskState; exitReason: string | null }): boolean {
  return task.state === 'stopped' && (task.exitReason ?? '').startsWith(STOPPED_BY_PERSON);
}

/**
 * Records, before a person's kill reaches the session, that the task running
 * in it is being stopped by them. The task stays running: hostd's observer
 * stops it when the session is gone, as for any other, and keeps this reason
 * (`stopIfRunning`). A kill that does not land leaves a reason the task's own
 * ending replaces.
 */
export async function noteStoppedByPerson(tmuxSession: string, actor: string): Promise<TaskRecord | null> {
  const row = await queryOne<TaskRow>(
    `update tasks set exit_reason = $2, updated_at = now()
     where tmux_session = $1 and state = 'running'
     returning ${COLUMNS}`,
    [tmuxSession, `${STOPPED_BY_PERSON} (${actor}): its session was killed`],
  );
  return row ? toTask(row) : null;
}

/**
 * Takes back `noteStoppedByPerson` when the kill it announced did not land:
 * the task is still running, and if its session later goes away on its own it
 * was interrupted, not stopped, so the deploy sweep may start it again.
 */
export async function forgetStoppedByPerson(id: string): Promise<void> {
  await queryOne<TaskRow>(
    `update tasks set exit_reason = null, updated_at = now()
     where id = $1 and state = 'running' and exit_reason like '${STOPPED_BY_PERSON}%'
     returning ${COLUMNS}`,
    [id],
  );
}

/**
 * Stops a task only while it is still running, in one statement.
 *
 * hostd watches for sessions that have gone and stops the task they belonged
 * to, which is what returns an interrupted issue to the board. But a task that
 * has just reported `done` has no session either — its own cleanup killed it —
 * so a read-then-write would overwrite the verdict the task reported with
 * `stopped`, from a snapshot taken before it finished. The guard lives in the
 * `where` clause so there is no window between deciding and writing.
 *
 * Returns null when the task was no longer running, which means somebody else
 * already gave it its ending.
 */
export async function stopIfRunning(id: string, exitReason: string): Promise<TaskRecord | null> {
  // A person who killed the session said so first (`noteStoppedByPerson`),
  // and that is the reason that stays: it is what tells the deploy sweep not
  // to start the work again.
  const row = await queryOne<TaskRow>(
    `update tasks set
       state = 'stopped',
       exit_reason = case when exit_reason like '${STOPPED_BY_PERSON}%' then exit_reason else $2 end,
       ended_at = now(),
       updated_at = now()
     where id = $1 and state = 'running'
     returning ${COLUMNS}`,
    [id, exitReason],
  );
  return row ? toTask(row) : null;
}

/**
 * Fails a task only while it is still running, in one statement: reconcile's
 * verdict on a task whose host stopped reporting. It read the running tasks
 * first and wrote `failed` without a guard, so a task that reported `done`
 * in between lost its verdict.
 *
 * Returns null when the task was no longer running.
 */
export async function failIfRunning(id: string, exitReason: string): Promise<TaskRecord | null> {
  const row = await queryOne<TaskRow>(
    `update tasks set
       state = 'failed',
       exit_reason = $2,
       ended_at = now(),
       updated_at = now()
     where id = $1 and state = 'running'
     returning ${COLUMNS}`,
    [id, redactSecrets(exitReason)],
  );
  return row ? toTask(row) : null;
}

export async function addTaskCost(id: string, costUsd: number): Promise<number> {
  // As the ledger's row: a task's cost only grows, and NaN would stick.
  if (!Number.isFinite(costUsd) || costUsd < 0) throw new Error(`a task's cost grows by 0 or more; refusing ${costUsd}`);
  const row = await queryOne<{ cost_usd: string }>(
    'update tasks set cost_usd = cost_usd + $2, updated_at = now() where id = $1 returning cost_usd',
    [id, costUsd],
  );
  return Number(row?.cost_usd ?? 0);
}

/**
 * Takes the one automatic retry a task gets, in one statement.
 *
 * The health check that explains a failure can pass again from two runs at
 * once, or from a run and an event, and each would find the task still
 * waiting. The `where` clause is what lets exactly one of them have it.
 * Returns false when it was already taken.
 */
export async function claimAutoRetry(id: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    'update tasks set auto_retried_at = now(), updated_at = now() where id = $1 and auto_retried_at is null returning id',
    [id],
  );
  return row !== null;
}

/** Gives back a claim whose retry was refused, so the next recovery may try. */
export async function releaseAutoRetry(id: string): Promise<void> {
  await query('update tasks set auto_retried_at = null, updated_at = now() where id = $1', [id]);
}

/**
 * Gives a task at its cap more to spend: a person answered its cost-cap gate
 * with "continue". How much is the caller's to bound (`Gates`). Returns the new
 * cap, or null for a task that is not there.
 */
export async function raiseCostCap(id: string, byUsd: number): Promise<number | null> {
  const row = await queryOne<{ cost_cap_usd: string }>(
    'update tasks set cost_cap_usd = cost_cap_usd + $2, updated_at = now() where id = $1 returning cost_cap_usd',
    [id, byUsd],
  );
  return row ? Number(row.cost_cap_usd) : null;
}
