import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

import { query, queryOne } from '../client.js';
import { enqueue, release, settle, take } from './task-inbox.js';

const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ');

const ROW = {
  id: 'inbox-1',
  task_id: 'task-1',
  message_id: 'message-1',
  bot_id: 'bot-1',
  role: 'implement',
  subject_ref: 'openadlc#229',
  sender: 'ada@example.com',
  sender_access: 'user',
  text: 'also handle the empty state',
  github_url: null,
  state: 'queued',
  created_at: new Date('2026-11-02T12:00:00.000Z'),
  settled_at: null,
};

const INPUT = {
  taskId: 'task-1',
  messageId: 'message-1',
  botId: 'bot-1',
  role: 'implement',
  subjectRef: 'openadlc#229',
  sender: 'ada@example.com',
  senderAccess: 'user' as const,
  text: 'also handle the empty state',
  githubUrl: null,
};

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(queryOne).mockReset();
});

describe('a message queued for a task', () => {
  it('is written only in the statement that finds the task queued, or running on an engine that takes messages', async () => {
    vi.mocked(queryOne).mockResolvedValue(ROW);

    expect(await enqueue(INPUT)).toMatchObject({ id: 'inbox-1', taskId: 'task-1', state: 'queued', senderAccess: 'user' });

    const [sql, params] = vi.mocked(queryOne).mock.calls[0] ?? [];
    expect(flat(sql)).toContain('select t.id, $2, $3, $4, $5, $6, $7, $8, $9 from tasks t');
    expect(flat(sql)).toContain("where t.id = $1 and (t.state = 'queued' or (t.state = 'running' and t.takes_messages is true))");
    expect(params).toEqual(['task-1', 'message-1', 'bot-1', 'implement', 'openadlc#229', 'ada@example.com', 'user', 'also handle the empty state', null]);
  });

  it('is nothing for a task that is paused, ended, or running on an engine that does not take messages', async () => {
    // The guard is in the statement: the database writes no row, and says so with none.
    vi.mocked(queryOne).mockResolvedValue(null);

    expect(await enqueue(INPUT)).toBeNull();
    const sql = flat(vi.mocked(queryOne).mock.calls[0]?.[0]);
    expect(sql).not.toContain("'paused'");
    // `is true`: a null (a runner that never said) is not live.
    expect(sql).toContain('t.takes_messages is true');
  });
});

describe('a row claimed once', () => {
  it('is taken only from queued, and only while its task runs, oldest first', async () => {
    vi.mocked(query).mockResolvedValue([
      { ...ROW, id: 'later', state: 'taken', fresh: true, created_at: new Date('2026-11-02T12:05:00.000Z') },
      { ...ROW, state: 'taken', fresh: true },
    ]);

    const taken = await take('task-1', 'take-1');

    expect(taken.map((row) => row.id)).toEqual(['inbox-1', 'later']);
    expect(taken.every((row) => row.fresh)).toBe(true);
    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(flat(sql)).toContain("set state = 'taken', take_id = $2::uuid");
    expect(flat(sql)).toContain("where i.task_id = $1 and (i.state = 'queued' or (i.state = 'taken' and i.take_id = $2::uuid))");
    expect(flat(sql)).toContain("exists (select 1 from tasks t where t.id = i.task_id and t.state = 'running')");
    expect(params).toEqual(['task-1', 'take-1']);
  });

  it('is handed back to a take asked again with the same id, whose answer was lost, and marked not fresh', async () => {
    vi.mocked(query).mockResolvedValue([{ ...ROW, state: 'taken', fresh: false }]);

    const taken = await take('task-1', 'take-1');

    expect(taken).toEqual([expect.objectContaining({ id: 'inbox-1', state: 'taken', fresh: false })]);
    const sql = flat(vi.mocked(query).mock.calls[0]?.[0]);
    // Its first claim's time stays, which is how `fresh` tells the repeat apart.
    expect(sql).toContain("settled_at = case when i.state = 'queued' then now() else i.settled_at end");
    expect(sql).toContain('i.settled_at = now() as fresh');
  });

  it('is put back in the queue, from that take only, when the runner never got the take’s answer', async () => {
    vi.mocked(query).mockResolvedValue([{ ...ROW, state: 'queued' }]);

    expect(await release('task-1', 'take-1')).toEqual([expect.objectContaining({ id: 'inbox-1', state: 'queued' })]);

    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(flat(sql)).toContain("set state = 'queued', take_id = null, settled_at = null");
    // Never a row another take claimed, a returned one, or another task's.
    expect(flat(sql)).toContain("where i.task_id = $1 and i.take_id = $2::uuid and i.state = 'taken'");
    expect(params).toEqual(['task-1', 'take-1']);
  });

  it('is returned only from queued, and only once its task is neither queued nor running', async () => {
    vi.mocked(query).mockResolvedValue([{ ...ROW, state: 'returned' }]);

    expect(await settle('task-1')).toEqual([expect.objectContaining({ id: 'inbox-1', state: 'returned' })]);

    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(flat(sql)).toContain("update task_inbox i set state = 'returned', settled_at = now() where i.state = 'queued'");
    expect(flat(sql)).toContain("not exists (select 1 from tasks t where t.id = i.task_id and t.state in ('queued', 'running'))");
    expect(params).toEqual(['task-1']);
  });

  it('is settled for every task when none is named, which is the sweep', async () => {
    vi.mocked(query).mockResolvedValue([]);

    await settle();

    expect(flat(vi.mocked(query).mock.calls[0]?.[0])).toContain('($1::uuid is null or i.task_id = $1::uuid)');
    expect(vi.mocked(query).mock.calls[0]?.[1]).toEqual([null]);
  });

  it('cannot be both taken and returned: each claim takes a row out of queued, and claims only from queued', async () => {
    vi.mocked(query).mockResolvedValue([]);
    await take('task-1', 'take-1');
    await settle('task-1');
    const statements = vi.mocked(query).mock.calls.map((call) => flat(call[0]));
    expect(statements).toHaveLength(2);
    for (const sql of statements) expect(sql).toMatch(/set state = '(taken|returned)'.* i\.state = 'queued'/);
  });
});
