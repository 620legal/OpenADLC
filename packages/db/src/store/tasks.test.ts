import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

import { query, queryOne } from '../client.js';
import { listEventsOfType } from './audit.js';
import {
  addTaskCost,
  claimAutoRetry,
  createTask,
  getTask,
  countSeatSlotsInUse,
  countUnfinishedImplementTasks,
  discardUnstarted,
  failIfRunning,
  failUnstarted,
  listTasks,
  listTasksOnSubjects,
  releaseComputer,
  seatHasRoom,
  staleUnstarted,
  listTasksSince,
  noteStoppedByPerson,
  pausedWithAnswer,
  raiseCostCap,
  releaseAutoRetry,
  stopIfRunning,
  stoppedByPerson,
  TASK_STATE_FROM,
  updateTaskState,
} from './tasks.js';

const ROW = {
  id: 'task-1',
  bot_id: 'bot-1',
  repo_id: 'repo-1',
  kind: 'review',
  subject_type: 'pr',
  subject_ref: 'fleetadlc#31',
  lease_id: null,
  state: 'running',
  skill: 'pr-review',
  worktree: null,
  branch: null,
  tmux_session: null,
  cost_cap_usd: '15.0000',
  cost_usd: '0.3800',
  round: 0,
  started_at: new Date('2026-09-24T11:54:00.000Z'),
  ended_at: null,
  exit_reason: null,
  created_at: new Date('2026-09-24T11:53:00.000Z'),
  auto_retried_at: null,
  host_id: null,
};

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(queryOne).mockReset();
});

describe('the branch a task started from', () => {
  it('is kept with what it was told about it, and read back for a resume', async () => {
    const brief = { name: 'stacked-on.md', title: 'Built on #4', content: 'Your branch starts from agent/atlas/4-issue-4.' };
    vi.mocked(queryOne).mockResolvedValue({ ...ROW, base_ref: 'refs/heads/agent/atlas/4-issue-4', base_context: [brief] });

    await createTask({ botId: 'bot-1', repoId: 'repo-1', kind: 'implement', subjectType: 'issue', subjectRef: 'shop#5', baseRef: 'refs/heads/agent/atlas/4-issue-4', baseContext: [brief] });
    const params = vi.mocked(queryOne).mock.calls.at(-1)?.[1] ?? [];
    expect(params.slice(-2)).toEqual(['refs/heads/agent/atlas/4-issue-4', JSON.stringify([brief])]);

    expect(await getTask('task-1')).toMatchObject({ baseRef: 'refs/heads/agent/atlas/4-issue-4', baseContext: [brief] });
  });

  it('is none for a task on the default branch', async () => {
    vi.mocked(queryOne).mockResolvedValue({ ...ROW, base_ref: null, base_context: null });

    await createTask({ botId: 'bot-1', repoId: 'repo-1', kind: 'review', subjectType: 'pr', subjectRef: 'shop#5' });
    expect((vi.mocked(queryOne).mock.calls.at(-1)?.[1] ?? []).slice(-2)).toEqual([null, null]);
    expect(await getTask('task-1')).toMatchObject({ baseRef: null, baseContext: [] });
  });
});

describe('the host a task runs on', () => {
  it('is read with the task, so a hostd can leave another host’s work alone', async () => {
    vi.mocked(queryOne).mockResolvedValue({ ...ROW, host_id: 'host-a' });

    expect(await getTask('task-1')).toMatchObject({ hostId: 'host-a' });
    expect(String(vi.mocked(queryOne).mock.calls.at(-1)?.[0])).toMatch(/\bhost_id\b/);
  });

  it('is none for a task no hostd has started', async () => {
    vi.mocked(query).mockResolvedValue([ROW]);

    expect((await listTasks({ states: ['queued'] }))[0]?.hostId).toBeNull();
  });
});

describe('room for one more task', () => {
  const sql = () => String(vi.mocked(queryOne).mock.calls.at(-1)?.[0] ?? '').replace(/\s+/g, ' ');

  beforeEach(() => vi.mocked(queryOne).mockReset());

  it('is a seat holding fewer computers than its tasks at once, a paused task’s kept one included, counting what the caller started this pass', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ room: true });

    expect(await seatHasRoom('bot-1', 2)).toBe(true);

    expect(sql()).toContain(
      "(select count(*) from tasks where bot_id = $1 and (state in ('queued','running') or (state = 'paused' and host_id is not null))) + $2 < b.max_tasks as room",
    );
    expect(vi.mocked(queryOne).mock.calls.at(-1)?.[1]).toEqual(['bot-1', 2]);
  });

  it('is none for a seat that is not there', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(null);
    expect(await seatHasRoom('gone')).toBe(false);
  });

  it('counts a paused task against its seat and the hosts only while its computer is kept', async () => {
    vi.mocked(queryOne).mockResolvedValue({ count: '2' });

    expect(await countSeatSlotsInUse('bot-1')).toBe(2);
    expect(sql()).toContain("state in ('queued','running') or (state = 'paused' and host_id is not null)");
    // A repository's concurrency counts a paused build whether or not it has a computer.
    expect(await countUnfinishedImplementTasks('repo-1')).toBe(2);
    expect(sql()).toContain("kind = 'implement' and state in ('queued','running','paused')");
  });

  it('gives a paused task’s place back when its computer goes, and takes back only a start that never ran', async () => {
    vi.mocked(query).mockResolvedValue([]);

    await releaseComputer('task-1');
    await discardUnstarted('task-2');

    const statements = vi.mocked(query).mock.calls.map(([text]) => String(text).replace(/\s+/g, ' '));
    expect(statements[0]).toContain("set host_id = null, container = null, updated_at = now() where id = $1 and state = 'paused'");
    expect(statements[1]).toContain("delete from tasks where id = $1 and state = 'queued' and started_at is null");
  });
});

describe('a paused task owed a resume', () => {
  const sql = () => String(vi.mocked(query).mock.calls.at(-1)?.[0] ?? '').replace(/\s+/g, ' ');

  it('is one whose newest question was answered after it paused, with none still open', async () => {
    // Checked against Postgres: of a task answered after its pause, one whose
    // only answer is older than its pause, and one with a question still open,
    // only the first comes back.
    vi.mocked(query).mockResolvedValue([{ ...ROW, state: 'paused', gate_answered_at: new Date('2026-09-24T12:10:00.000Z') }]);

    const owed = await pausedWithAnswer();

    expect(owed).toEqual([expect.objectContaining({ id: 'task-1', state: 'paused', answeredAt: '2026-09-24T12:10:00.000Z' })]);
    // The newest gate of each task, not any answered one.
    expect(sql()).toContain('select distinct on (task_id) task_id as gate_task_id, state as gate_state, answered_at as gate_answered_at from gates');
    expect(sql()).toContain('order by task_id, created_at desc');
    expect(sql()).toContain("where tasks.state = 'paused' and newest.gate_state = 'answered'");
    // An answer older than the pause is one the task already resumed on.
    expect(sql()).toContain('and newest.gate_answered_at > tasks.paused_at');
    expect(sql()).toContain("not exists (select 1 from gates g where g.task_id = tasks.id and g.state = 'open')");
  });

  it('is told by when it paused, stamped only on the way into paused', async () => {
    vi.mocked(queryOne).mockResolvedValue({ ...ROW, state: 'paused' });

    await updateTaskState('task-1', 'paused', { exitReason: 'waiting on a person' });

    const statement = String(vi.mocked(queryOne).mock.calls.at(-1)?.[0] ?? '').replace(/\s+/g, ' ');
    // The runner reports the pause again after the gate did; a second stamp
    // could land after a quick answer and hide it.
    expect(statement).toContain("paused_at = case when $2 = 'paused' and state <> 'paused' then now() else paused_at end");
  });
});

describe('a task recorded and never handed to a host', () => {
  it('is a queued row never started, on no host, opened before the cut-off', async () => {
    vi.mocked(query).mockResolvedValue([{ ...ROW, state: 'queued', started_at: null }]);
    const cutoff = new Date('2026-09-24T11:30:00.000Z');

    expect(await staleUnstarted(cutoff)).toEqual([expect.objectContaining({ id: 'task-1', state: 'queued', startedAt: null })]);

    const [text, params] = vi.mocked(query).mock.calls.at(-1) ?? [];
    expect(String(text).replace(/\s+/g, ' ')).toContain("where state = 'queued' and started_at is null and host_id is null and created_at < $1");
    expect(params).toEqual([cutoff]);
  });

  it('is failed only while it still has not started, so a start that landed meanwhile stands', async () => {
    vi.mocked(queryOne).mockResolvedValue(null);

    expect(await failUnstarted('task-1', 'its start never finished')).toBeNull();

    const [text, params] = vi.mocked(queryOne).mock.calls.at(-1) ?? [];
    expect(String(text).replace(/\s+/g, ' ')).toContain("set state = 'failed', exit_reason = $2, ended_at = now(), updated_at = now() where id = $1 and state = 'queued' and started_at is null and host_id is null");
    expect(params).toEqual(['task-1', 'its start never finished']);
  });
});

describe('the tasks on a card', () => {
  it('are every kind on any of its subjects, with when each was opened', async () => {
    vi.mocked(query).mockResolvedValueOnce([ROW]);

    const [task] = await listTasksOnSubjects(['fleetadlc#12', 'fleetadlc#31']);

    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toMatch(/subject_ref = any\(\$1\)/);
    expect(String(sql)).not.toMatch(/kind =/);
    expect(params).toEqual([['fleetadlc#12', 'fleetadlc#31']]);
    expect(task).toMatchObject({ id: 'task-1', costUsd: 0.38, createdAt: '2026-09-24T11:53:00.000Z' });
  });

  it('asks nothing for a board with no cards', async () => {
    expect(await listTasksOnSubjects([])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('the tasks "needs you" reads', () => {
  it('are the recent ones, and every one still going however old', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    const since = new Date('2026-09-17T12:00:00.000Z');

    await listTasksSince(since);

    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toContain("state in ('queued','running','paused')");
    expect(params).toEqual([since]);
  });

  it('read a stopped review loop from its event, with what it carried', async () => {
    vi.mocked(query).mockResolvedValueOnce([
      { id: '7', at: new Date('2026-09-24T11:20:00.000Z'), payload: { repo: 'fleetadlc', pr: 31 } },
    ]);

    const events = await listEventsOfType('review.stalled', new Date('2026-09-17T00:00:00.000Z'));

    expect(vi.mocked(query).mock.calls[0]?.[1]).toEqual(['review.stalled', new Date('2026-09-17T00:00:00.000Z')]);
    expect(events).toEqual([{ id: 7, at: '2026-09-24T11:20:00.000Z', payload: { repo: 'fleetadlc', pr: 31 } }]);
  });
});

describe('a task a person stopped, told from one whose session went away', () => {
  it('is recorded against the session before the kill lands, while the task still runs', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ ...ROW, tmux_session: 'harbor/deploy' });

    await noteStoppedByPerson('harbor/deploy', 'janedoe');

    const [sql, params] = vi.mocked(queryOne).mock.calls.at(-1) ?? [];
    expect(String(sql).replace(/\s+/g, ' ')).toContain("where tmux_session = $1 and state = 'running'");
    expect(String(sql)).not.toMatch(/state = 'stopped'/);
    expect(params).toEqual(['harbor/deploy', 'stopped by a person (janedoe): its session was killed']);
  });

  it('keeps the person’s reason when hostd finds the session gone and stops the task', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(null);

    await stopIfRunning('task-1', 'the session was killed; the branch and the issue are untouched');

    const sql = String(vi.mocked(queryOne).mock.calls.at(-1)?.[0]).replace(/\s+/g, ' ');
    expect(sql).toContain("exit_reason = case when exit_reason like 'stopped by a person%' then exit_reason else $2 end");
  });

  it('is only a stopped task whose reason says a person stopped it', () => {
    const byPerson = 'stopped by a person (janedoe): its session was killed';
    expect(stoppedByPerson({ state: 'stopped', exitReason: byPerson })).toBe(true);
    expect(stoppedByPerson({ state: 'stopped', exitReason: 'the session was killed; the branch and the issue are untouched' })).toBe(false);
    expect(stoppedByPerson({ state: 'stopped', exitReason: null })).toBe(false);
    // A kill that never landed: the task went on and ended on its own terms.
    expect(stoppedByPerson({ state: 'failed', exitReason: byPerson })).toBe(false);
  });
});

describe('a task reconcile fails because its host stopped reporting', () => {
  it('is failed only while it is still running, so a verdict it reported in between stays', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(null);

    expect(await failIfRunning('task-1', 'the host stopped reporting')).toBeNull();

    const [sql, params] = vi.mocked(queryOne).mock.calls.at(-1) ?? [];
    const flat = String(sql).replace(/\s+/g, ' ');
    expect(flat).toContain("state = 'failed'");
    expect(flat).toContain("where id = $1 and state = 'running'");
    expect(params).toEqual(['task-1', 'the host stopped reporting']);
  });
});

describe('the one automatic retry a task gets', () => {
  it('is taken in one statement that only matches a task nobody has retried', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ id: 'task-1' }).mockResolvedValueOnce(null);

    expect(await claimAutoRetry('task-1')).toBe(true);
    expect(await claimAutoRetry('task-1')).toBe(false);

    const [sql, params] = vi.mocked(queryOne).mock.calls[0] ?? [];
    expect(String(sql)).toMatch(/where id = \$1 and auto_retried_at is null/);
    expect(params).toEqual(['task-1']);
  });

  it('is given back when the retry was refused', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);

    await releaseAutoRetry('task-1');

    expect(String(vi.mocked(query).mock.calls[0]?.[0])).toMatch(/set auto_retried_at = null/);
  });

  it('is read with the task, so a caller can tell a retried one', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ ...ROW, auto_retried_at: new Date('2026-09-25T00:00:00.000Z') }]);

    const [task] = await listTasksOnSubjects(['fleetadlc#31']);

    expect(task?.autoRetriedAt).toBe('2026-09-25T00:00:00.000Z');
  });
});

describe('raising a task’s cap', () => {
  it('adds the amount in one statement', async () => {
    vi.mocked(queryOne).mockReset().mockResolvedValueOnce({ cost_cap_usd: '30.0000' });

    expect(await raiseCostCap('task-1', 15)).toBe(30);

    const [sql, params] = vi.mocked(queryOne).mock.calls[0] ?? [];
    expect(String(sql)).toContain('cost_cap_usd = cost_cap_usd + $2');
    expect(params).toEqual(['task-1', 15]);
  });

  it('is null for a task that is not there', async () => {
    vi.mocked(queryOne).mockReset().mockResolvedValueOnce(null);
    expect(await raiseCostCap('task-gone', 15)).toBeNull();
  });
});

/**
 * Every write landed whatever the task was in: a start that finished after a
 * cancel wrote `running` over `stopped`, and a failed task turned `done`.
 */
describe('moving a task from one state to another', () => {
  const may = (from: string, to: keyof typeof TASK_STATE_FROM) => (TASK_STATE_FROM[to] as readonly string[]).includes(from);

  it('never takes an ended task back to queued, running or paused, and never changes a done one', () => {
    for (const from of ['done', 'failed', 'stopped']) {
      for (const to of ['queued', 'running', 'paused'] as const) expect(may(from, to), `${from} → ${to}`).toBe(false);
    }
    for (const to of ['queued', 'running', 'paused', 'done', 'failed', 'stopped'] as const) expect(may('done', to), `done → ${to}`).toBe(false);
    expect(may('failed', 'done')).toBe(false);
    expect(may('stopped', 'done')).toBe(false);
    expect(may('stopped', 'failed')).toBe(false);
  });

  it('still lets a task start, pause, resume and end, and a failed one be stopped', () => {
    const allowed: Array<[string, keyof typeof TASK_STATE_FROM]> = [
      ['queued', 'running'],
      ['paused', 'running'],
      ['running', 'paused'],
      ...(['queued', 'running', 'paused'] as const).flatMap((from) => (['done', 'failed', 'stopped'] as const).map((to): [string, keyof typeof TASK_STATE_FROM] => [from, to])),
      // The card's Stop on a failed task.
      ['failed', 'stopped'],
    ];
    for (const [from, to] of allowed) expect(may(from, to), `${from} → ${to}`).toBe(true);
  });

  it('decides in the write itself, so nothing can end the task between a read and the write', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(null);

    expect(await updateTaskState('task-1', 'running', { tmuxSession: 'atlas/implement-task1' })).toBeNull();

    const [sql, params] = vi.mocked(queryOne).mock.calls.at(-1) ?? [];
    expect(String(sql).replace(/\s+/g, ' ')).toContain('where id = $1 and state = any($9::text[])');
    expect(params?.[8]).toEqual(['queued', 'running', 'paused']);
  });
});

describe('adding to what a task cost', () => {
  it('adds an amount of 0 or more, and reads the total back', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ cost_usd: '0.4200' });
    expect(await addTaskCost('task-1', 0.04)).toBe(0.42);
  });

  it('refuses a negative cost, NaN or Infinity before any query runs', async () => {
    for (const amount of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(addTaskCost('task-1', amount)).rejects.toThrow(/0 or more/);
    }
    expect(queryOne).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});
