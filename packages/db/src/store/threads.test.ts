import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

import { query, queryOne } from '../client.js';
import {
  claimGateReply,
  createGate,
  ensureThread,
  expireEndedGatesInRepo,
  expireGatesOfTask,
  listGatesForSubject,
  listGatesForTasks,
  listOpenGates,
  listOpenGatesInRepo,
  listOpenGatesOnSubject,
  listThreadsForSubjects,
  reopenGate,
  subjectsWatermark,
} from './threads.js';

const ROW = {
  id: 'gate-1',
  task_id: 'task-1',
  thread_id: 'thread-1',
  question: 'Which repository?',
  options: ['fleetadlc', 'infra'],
  state: 'open',
  answer: null,
  answered_by: null,
  answered_at: null,
  addressed_to: null,
  github_comment_url: null,
  created_at: new Date('2026-09-24T11:58:00.000Z'),
};

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe('when a gate was asked', () => {
  it('comes with every read that lists gates, which is how long a person has been waited on', async () => {
    vi.mocked(query).mockResolvedValue([ROW]);

    expect((await listOpenGates())[0]?.createdAt).toBe('2026-09-24T11:58:00.000Z');
    expect((await listGatesForSubject('request:a4b02784'))[0]?.createdAt).toBe('2026-09-24T11:58:00.000Z');
    for (const [sql] of vi.mocked(query).mock.calls) expect(String(sql)).toMatch(/created_at\n/);
  });

  it('is left out, not a failure, where a row does not carry it', async () => {
    const { created_at: _dropped, ...without } = ROW;
    vi.mocked(query).mockResolvedValue([without]);

    const [gate] = await listOpenGates();
    expect(gate?.id).toBe('gate-1');
    expect(gate?.createdAt).toBeUndefined();
  });
});

describe('a gate a session asks', () => {
  it('is stored without a token in its question or its options', async () => {
    const token = `ghu_${'a'.repeat(36)}`;
    vi.mocked(queryOne).mockResolvedValueOnce(ROW);

    await createGate({ taskId: 'task-1', threadId: 'thread-1', question: `push failed: ${token}`, options: [`retry with ${token}`, 'stop'] });

    const params = vi.mocked(queryOne).mock.calls.at(-1)?.[1] as unknown[];
    expect(params[2]).toBe('push failed: ghu_***');
    expect(params[3]).toEqual(['retry with ghu_***', 'stop']);
  });
});

describe('whether a gate put needs-human on its subject', () => {
  it('is stored as the bridge says, and as true when it says nothing, as for a gate opened before it was kept', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ ...ROW, added_needs_human: false });
    const gate = await createGate({ taskId: 'task-1', threadId: 'thread-1', question: 'q', options: [], addedNeedsHuman: false });
    expect((vi.mocked(queryOne).mock.calls.at(-1)?.[1] as unknown[])[6]).toBe(false);
    expect(gate.addedNeedsHuman).toBe(false);

    vi.mocked(queryOne).mockResolvedValueOnce({ ...ROW, added_needs_human: true });
    await createGate({ taskId: 'task-1', threadId: 'thread-1', question: 'q', options: [] });
    expect((vi.mocked(queryOne).mock.calls.at(-1)?.[1] as unknown[])[6]).toBe(true);
  });

  it('is read with the gates still open on the subject, by any of its tasks', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ ...ROW, added_needs_human: true }]);

    const open = await listOpenGatesOnSubject('fleetadlc#31');

    expect(open).toEqual([expect.objectContaining({ id: 'gate-1', addedNeedsHuman: true })]);
    const [sql, params] = vi.mocked(query).mock.calls.at(-1) ?? [];
    expect(String(sql)).toMatch(/t\.subject_ref = \$1 and g\.state = 'open'/);
    expect(params).toEqual(['fleetadlc#31']);
  });
});

describe('handing a claimed gate back', () => {
  it('undoes only the claim this answer made', async () => {
    vi.mocked(queryOne).mockReset().mockResolvedValueOnce({ id: 'gate-1' });

    expect(await reopenGate('gate-1', 'Approve', 'janedoe')).toBe(true);

    const [sql, params] = vi.mocked(queryOne).mock.calls[0] ?? [];
    expect(String(sql).replace(/\s+/g, ' ')).toContain("where id = $1 and state = 'answered' and answer = $2 and answered_by = $3");
    expect(params).toEqual(['gate-1', 'Approve', 'janedoe']);
  });

  it('says so when someone else has answered it since', async () => {
    vi.mocked(queryOne).mockReset().mockResolvedValueOnce(null);
    expect(await reopenGate('gate-1', 'Approve', 'janedoe')).toBe(false);
  });
});

describe('the gates of many tasks', () => {
  it('are read in one query, by task', async () => {
    vi.mocked(query).mockResolvedValue([ROW]);

    expect((await listGatesForTasks(['task-1', 'task-2'])).map((gate) => gate.taskId)).toEqual(['task-1']);
    expect(vi.mocked(query)).toHaveBeenCalledTimes(1);
    const [sql, params] = vi.mocked(query).mock.calls[0]!;
    expect(String(sql)).toContain('task_id = any($1::uuid[])');
    expect(params).toEqual([['task-1', 'task-2']]);
  });

  it('asks nothing for no tasks', async () => {
    expect(await listGatesForTasks([])).toEqual([]);
    expect(vi.mocked(query)).not.toHaveBeenCalled();
  });
});

describe('the questions of a repository removed from OpenADLC', () => {
  it('are listed with the subject they are about, whether a task or only a thread asked them', async () => {
    vi.mocked(query).mockResolvedValue([{ ...ROW, subject_ref: 'api#12' }]);

    const open = await listOpenGatesInRepo('repo-1');

    expect(open).toEqual([expect.objectContaining({ id: 'gate-1', question: 'Which repository?', subjectRef: 'api#12' })]);
    const [sql, params] = vi.mocked(query).mock.calls[0]!;
    const text = String(sql).replace(/\s+/g, ' ');
    expect(text).toContain("g.state = 'open' and coalesce(t.repo_id, th.repo_id) = $1");
    expect(params).toEqual(['repo-1']);
  });

  it('are closed for a stopped task, audited with why, in one statement', async () => {
    vi.mocked(query).mockResolvedValue([{ id: 'gate-1' }]);

    expect(await expireGatesOfTask('task-1', 'janedoe', 'repository removed from OpenADLC by janedoe')).toEqual(['gate-1']);

    const [sql, params] = vi.mocked(query).mock.calls[0]!;
    const text = String(sql).replace(/\s+/g, ' ');
    expect(text).toContain("update gates g set state = 'expired'");
    expect(text).toContain("where g.task_id = $1 and g.state = 'open'");
    expect(text).toContain("'gate.expired'");
    expect(params).toEqual(['task-1', 'janedoe', 'repository removed from OpenADLC by janedoe']);
  });

  it('are closed across the repository, except one a task that could not be stopped is still waiting on', async () => {
    vi.mocked(query).mockResolvedValue([{ id: 'gate-2' }]);

    expect(await expireEndedGatesInRepo('repo-1', 'janedoe', 'r')).toEqual(['gate-2']);

    const [sql, params] = vi.mocked(query).mock.calls[0]!;
    const text = String(sql).replace(/\s+/g, ' ');
    expect(text).toContain("(t.id is null or t.state not in ('queued', 'running', 'paused'))");
    expect(text).toContain("'gate.expired'");
    expect(params).toEqual(['repo-1', 'janedoe', 'r']);
  });
});

describe('a thread’s role and seat', () => {
  it('are the bot’s when the thread is written, and a later write only fills one that has none', async () => {
    // Seats sharing one GitHub account were one handle in the console; the
    // role on the thread is what tells them apart, and it must not move when
    // a seat is later given another role.
    vi.mocked(queryOne).mockReset().mockResolvedValueOnce({ id: 't-1', bot_id: 'b-1', repo_id: null, subject_ref: 'api#12', role: 'review_lead', seat: 'lead-reviewer' });
    const thread = await ensureThread({ botId: 'b-1', repoId: null, subjectRef: 'api#12' });
    expect(thread).toMatchObject({ role: 'review_lead', seat: 'lead-reviewer' });

    const sql = String(vi.mocked(queryOne).mock.calls[0]?.[0]).replace(/\s+/g, ' ');
    expect(sql).toContain('select $1, $2, $3, b.role, b.slot from bots b where b.id = $1');
    expect(sql).toContain('role = coalesce(threads.role, excluded.role)');
  });

  it('says which bot is missing rather than failing on nothing', async () => {
    vi.mocked(queryOne).mockReset().mockResolvedValueOnce(null);
    await expect(ensureThread({ botId: 'b-gone', repoId: null, subjectRef: 'api#12' })).rejects.toThrow(/there is no bot b-gone/);
  });
});

describe('a work item’s threads and watermark', () => {
  it('reads every thread about any of the item’s subjects, and nothing for none', async () => {
    vi.mocked(query).mockResolvedValue([]);
    expect(await listThreadsForSubjects([])).toEqual([]);
    expect(vi.mocked(query)).not.toHaveBeenCalled();

    await listThreadsForSubjects(['request:a4b02784', 'api#12', 'api#31']);
    expect(vi.mocked(query).mock.calls[0]?.[1]).toEqual([['request:a4b02784', 'api#12', 'api#31']]);
  });

  it('moves when a message, a question or a task on those subjects changes', async () => {
    vi.mocked(queryOne).mockReset().mockResolvedValueOnce({ latest: 'm9', count: '4', gates: new Date('2026-09-30T10:00:00Z'), tasks: null });
    expect(await subjectsWatermark(['api#12'])).toBe('m9:4:2026-09-30T10:00:00.000Z:');
    const sql = String(vi.mocked(queryOne).mock.calls[0]?.[0]);
    expect(sql).toMatch(/from gates g/);
    expect(sql).toMatch(/from tasks k/);
  });
});

describe('a GitHub reply claimed as a gate’s answer', () => {
  it('is claimed once: a second claim of the same comment finds it taken', async () => {
    vi.mocked(queryOne).mockReset().mockResolvedValueOnce({ comment_id: '5501' }).mockResolvedValueOnce(null);

    expect(await claimGateReply(5501, 'gate-1')).toBe(true);
    expect(await claimGateReply(5501, 'gate-2')).toBe(false);
    expect(String(vi.mocked(queryOne).mock.calls[0]?.[0])).toMatch(/on conflict \(comment_id\) do nothing/);
    expect(vi.mocked(queryOne).mock.calls[0]?.[1]).toEqual([5501, 'gate-1']);
  });
});
