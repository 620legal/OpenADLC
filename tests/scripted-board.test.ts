import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The scripted board used to insert its thread, its gate and its task on every
 * run. Five restarts then showed the same lines five times, and the intake card
 * carried the bot's name once per restart. This drives the seed against an
 * in-memory board so a run that forgets to replace those rows fails here.
 *
 * Replacing them has a failure of its own: a clear that matches too much. The
 * first one matched on the subject alone, and on an install with a real
 * repository it deleted real work on #41, #43 and #144. So the board here sits
 * next to rows the seed did not write, and every one of them has to survive.
 */

interface RepoRow {
  id: string;
  name: string;
  fullName: string;
}

interface IssueRow {
  repoId: string;
  number: number;
  title: string;
}

interface TaskRow {
  id: string;
  repoId: string | null;
  botId: string;
  subjectRef: string;
  state: string;
  costUsd: number;
}

interface ThreadRow {
  id: string;
  repoId: string | null;
  botId: string;
  subjectRef: string;
}

interface MessageRow {
  id: string;
  threadId: string;
  text: string;
  payload: Record<string, unknown> | null;
}

interface GateRow {
  id: string;
  taskId: string | null;
  threadId: string | null;
  question: string;
  state: string;
}

interface LedgerRow {
  taskId: string | null;
  costUsd: number;
  promptHash: string | null;
}

const world = vi.hoisted(() => {
  const real = { id: 'repo-real', name: 'fleetadlc', fullName: 'janedoe/fleetadlc' };
  const standIn = { id: 'repo-scripted', name: 'scripted', fullName: 'local/scripted' };
  const crew = [
    {
      id: 'bot-intake',
      name: 'intake',
      slot: 'intake',
      displayName: 'Intake',
      role: 'intake',
      engine: 'claude',
      model: 'claude-haiku-4-5',
    },
    {
      id: 'bot-builder',
      // Connected, so it goes by its account's handle.
      name: 'fleetadlc-atlas-janedoe',
      slot: 'builder',
      displayName: 'Builder',
      role: 'implement',
      engine: 'claude',
      model: 'claude-sonnet-5',
    },
    {
      id: 'bot-lead-reviewer',
      name: 'lead-reviewer',
      slot: 'lead-reviewer',
      displayName: 'Lead reviewer',
      role: 'review_lead',
      engine: 'claude',
      model: 'claude-opus-5',
    },
  ];

  let sequence = 0;
  const state = {
    real,
    standIn,
    crew,
    databaseWaits: 0,
    poolsClosed: 0,
    failOn: null as string | null,
    // Ordered by name, as listRepos is: the real repository lists first, which
    // is the one the first clear picked.
    repos: [] as RepoRow[],
    issues: new Map<string, IssueRow>(),
    tasks: [] as TaskRow[],
    threads: [] as ThreadRow[],
    messages: [] as MessageRow[],
    gates: [] as GateRow[],
    ledger: [] as LedgerRow[],
    nextId(prefix: string) {
      sequence += 1;
      return `${prefix}-${sequence}`;
    },
    reset() {
      sequence = 0;
      this.failOn = null;
      this.repos = [real, standIn];
      this.issues = new Map();
      this.tasks = [];
      this.threads = [];
      this.messages = [];
      this.gates = [];
      this.ledger = [];
    },
  };

  return state;
});

function contains(payload: Record<string, unknown> | null, wanted: Record<string, unknown>): boolean {
  return Object.entries(wanted).every(([key, value]) => payload?.[key] === value);
}

/**
 * The statements the fake database runs, applied the way each one reads. It
 * runs these and nothing else, so a clear that drops a filter is an unknown
 * statement here rather than a delete that happens to pass.
 */
const statements: Record<string, (params: readonly unknown[]) => void> = {
  'delete from messages m using threads t where m.thread_id = t.id and t.repo_id = $1 and t.subject_ref = any($2::text[]) and m.payload @> $3::jsonb':
    ([repoId, subjects, mark]) => {
      const wanted = JSON.parse(String(mark)) as Record<string, unknown>;
      world.messages = world.messages.filter((message) => {
        const thread = world.threads.find((candidate) => candidate.id === message.threadId);
        const matches =
          thread !== undefined &&
          thread.repoId === repoId &&
          (subjects as string[]).includes(thread.subjectRef) &&
          contains(message.payload, wanted);
        return !matches;
      });
    },
  'delete from gates where task_id = any($1::uuid[])': ([ids]) => {
    world.gates = world.gates.filter((gate) => !(ids as string[]).includes(gate.taskId ?? ''));
  },
  'delete from ledger where task_id = any($1::uuid[]) and prompt_hash = $2': ([ids, mark]) => {
    world.ledger = world.ledger.filter((row) => !((ids as string[]).includes(row.taskId ?? '') && row.promptHash === mark));
  },
  'delete from tasks where id = any($1::uuid[]) and repo_id = $2': ([ids, repoId]) => {
    world.tasks = world.tasks.filter((task) => !((ids as string[]).includes(task.id) && task.repoId === repoId));
  },
};

function run(sql: string, params: readonly unknown[]): void {
  const flat = sql.replace(/\s+/g, ' ').trim();
  const statement = statements[flat];
  if (!statement) throw new Error(`unexpected sql: ${sql}`);
  if (world.failOn && flat.startsWith(world.failOn)) throw new Error(`the database refused: ${world.failOn}`);
  statement(params);
}

/** What a rollback puts back. */
function tables() {
  return {
    tasks: structuredClone(world.tasks),
    threads: structuredClone(world.threads),
    messages: structuredClone(world.messages),
    gates: structuredClone(world.gates),
    ledger: structuredClone(world.ledger),
  };
}

vi.mock('../packages/db/src/client.js', () => ({
  // Straight to the pool: each statement stands on its own, as it would there.
  query: async (sql: string, params: readonly unknown[] = []) => {
    run(sql, params);
    return [];
  },
  // One client, and on a throw every table as it was before the first statement.
  withTransaction: async (fn: (client: unknown) => Promise<unknown>) => {
    const before = tables();
    const client = {
      query: async (sql: string, params: readonly unknown[] = []) => {
        run(sql, params);
        return { rows: [] };
      },
    };
    try {
      return await fn(client);
    } catch (error) {
      Object.assign(world, before);
      throw error;
    }
  },
  queryOne: async () => null,
  waitForDatabase: async () => {
    world.databaseWaits += 1;
  },
  closePool: async () => {
    world.poolsClosed += 1;
  },
}));

vi.mock('../packages/db/src/migrate.js', () => ({
  migrate: async () => undefined,
}));

vi.mock('../packages/db/src/store/bots.js', async (importOriginal) => {
  // The reseed rule is pure, and the seed calls it; the real one is used.
  const actual = await importOriginal<typeof import('../packages/db/src/store/bots.js')>();
  return {
    keptOnReseed: actual.keptOnReseed,
    listBots: async () => world.crew,
    getBotBySlot: async () => null,
    seedBot: async (input: { slot: string }) => ({ id: input.slot, name: input.slot, ...input }),
  };
});

vi.mock('../packages/db/src/store/repos.js', () => ({
  listRepos: async () => world.repos,
  upsertRepo: async (input: { name: string }) => ({ id: input.name, ...input }),
}));

vi.mock('../packages/db/src/store/issues.js', () => ({
  upsertIssue: async (input: IssueRow) => {
    world.issues.set(`${input.repoId}#${input.number}`, input);
    return { id: `issue-${input.number}`, ...input };
  },
}));

vi.mock('../packages/db/src/store/tasks.js', () => ({
  createTask: async (input: { id?: string; repoId: string | null; botId: string; subjectRef: string }) => {
    const id = input.id ?? world.nextId('task');
    // The primary key: a fixed id the clear missed would fail here, as it would there.
    if (world.tasks.some((task) => task.id === id)) throw new Error(`duplicate key: task ${id}`);
    const task: TaskRow = { costUsd: 0, state: 'queued', ...input, id };
    world.tasks.push(task);
    return task;
  },
  updateTaskState: async (id: string, state: string) => {
    const task = world.tasks.find((candidate) => candidate.id === id);
    if (task) task.state = state;
    return task ?? null;
  },
  addTaskCost: async (id: string, costUsd: number) => {
    const task = world.tasks.find((candidate) => candidate.id === id);
    if (!task) return 0;
    task.costUsd += costUsd;
    return task.costUsd;
  },
}));

vi.mock('../packages/db/src/store/threads.js', () => ({
  ensureThread: async (input: { botId: string; repoId: string | null; subjectRef: string }) => {
    const existing = world.threads.find(
      (thread) => thread.botId === input.botId && thread.subjectRef === input.subjectRef,
    );
    if (existing) return existing;
    const thread: ThreadRow = { id: world.nextId('thread'), ...input };
    world.threads.push(thread);
    return thread;
  },
  addMessage: async (input: { threadId: string; text: string; payload?: Record<string, unknown> | null }) => {
    const message: MessageRow = {
      id: world.nextId('message'),
      threadId: input.threadId,
      text: input.text,
      payload: input.payload ?? null,
    };
    world.messages.push(message);
    return message;
  },
  createGate: async (input: {
    taskId: string | null;
    threadId: string | null;
    question: string;
    options: string[];
    githubCommentUrl?: string | null;
  }) => {
    const gate: GateRow = {
      id: world.nextId('gate'),
      state: 'open',
      taskId: input.taskId,
      threadId: input.threadId,
      question: input.question,
    };
    world.gates.push(gate);
    return { ...gate, options: input.options, githubCommentUrl: input.githubCommentUrl ?? null };
  },
}));

vi.mock('../packages/db/src/store/costs.js', () => ({
  currentPeriod: () => '2026-09',
  ensureBudget: async () => ({ period: '2026-09', capUsd: 100, spentUsd: 0, state: 'ok' }),
  refreshBudget: async () => ({ period: '2026-09', capUsd: 100, spentUsd: 0, state: 'ok' }),
  recordUsage: async (input: { taskId: string | null; costUsd: number; promptHash?: string | null }) => {
    world.ledger.push({ taskId: input.taskId, costUsd: input.costUsd, promptHash: input.promptHash ?? null });
  },
}));

vi.mock('../packages/db/src/store/hosts.js', () => ({
  registerHost: async () => ({ id: 'host-1' }),
  // What the seed records its host with since it stopped resetting one hostd
  // had already registered.
  ensureHost: async () => ({ id: 'host-1' }),
}));

const { seedScriptedBoard } = await import('../packages/db/src/cli/scripted-board.js');

function inStandIn(subject: string): string {
  return `${world.standIn.name}${subject}`;
}

function boardThreadIds(): Set<string> {
  return new Set(
    world.threads.filter((thread) => thread.repoId === world.standIn.id).map((thread) => thread.id),
  );
}

function assignees(subject: string): string[] {
  return world.tasks
    .filter((task) => task.subjectRef === subject && ['queued', 'running', 'paused'].includes(task.state))
    .map((task) => world.crew.find((bot) => bot.id === task.botId)?.name ?? task.botId);
}

function snapshot() {
  const threadIds = boardThreadIds();
  const texts = world.messages.filter((message) => threadIds.has(message.threadId)).map((message) => message.text);
  const tasksHere = new Set(world.tasks.filter((task) => task.repoId === world.standIn.id).map((task) => task.id));
  return {
    messages: texts.length,
    texts,
    gates: world.gates.filter((gate) => gate.state === 'open' && tasksHere.has(gate.taskId ?? '')).length,
    cards: [...world.issues.values()].filter((issue) => issue.repoId === world.standIn.id).length,
    intake: assignees(inStandIn('#41')),
    implement: assignees(inStandIn('#43')),
    review: assignees(inStandIn('#144')),
    ledger: world.ledger.filter((row) => tasksHere.has(row.taskId ?? '')).length,
  };
}

/** Work on the real repository's #41, #43 and #144: the subjects the board also writes. */
function realWork() {
  const repo = world.real;
  world.issues.set(`${repo.id}#41`, { repoId: repo.id, number: 41, title: 'A real issue somebody filed' });
  world.threads.push({ id: 'thread-real-41', repoId: repo.id, botId: 'bot-intake', subjectRef: `${repo.name}#41` });
  world.messages.push({ id: 'real-message', threadId: 'thread-real-41', text: 'a real message', payload: null });
  world.tasks.push({
    id: 'real-intake',
    repoId: repo.id,
    botId: 'bot-intake',
    subjectRef: `${repo.name}#41`,
    state: 'paused',
    costUsd: 1.25,
  });
  world.gates.push({
    id: 'real-gate',
    taskId: 'real-intake',
    threadId: 'thread-real-41',
    question: 'a real question',
    state: 'open',
  });
  world.ledger.push({ taskId: 'real-intake', costUsd: 1.25, promptHash: null });
  world.tasks.push({
    id: 'real-build',
    repoId: repo.id,
    botId: 'bot-builder',
    subjectRef: `${repo.name}#43`,
    state: 'running',
    costUsd: 2.5,
  });
  world.ledger.push({ taskId: 'real-build', costUsd: 2.5, promptHash: null });
}

function rowsIn(repoId: string) {
  const threadIds = new Set(world.threads.filter((thread) => thread.repoId === repoId).map((thread) => thread.id));
  const taskIds = new Set(world.tasks.filter((task) => task.repoId === repoId).map((task) => task.id));
  return structuredClone({
    issues: [...world.issues.values()].filter((issue) => issue.repoId === repoId),
    tasks: world.tasks.filter((task) => taskIds.has(task.id)),
    threads: world.threads.filter((thread) => threadIds.has(thread.id)),
    messages: world.messages.filter((message) => threadIds.has(message.threadId)),
    gates: world.gates.filter((gate) => taskIds.has(gate.taskId ?? '') || threadIds.has(gate.threadId ?? '')),
    ledger: world.ledger.filter((row) => taskIds.has(row.taskId ?? '')),
  });
}

describe('the scripted board seed', () => {
  beforeEach(() => {
    world.reset();
  });

  it('replaces the conversation, the gate and the bot on the card', async () => {
    await seedScriptedBoard();

    const once = snapshot();
    expect(once.cards).toBe(6);
    expect(once.gates).toBe(1);
    expect(once.intake).toEqual(['intake']);
    expect(once.implement).toEqual(['fleetadlc-atlas-janedoe']);
    expect(once.review).toEqual(['lead-reviewer']);
    expect(once.messages).toBe(4);
    expect(new Set(once.texts).size).toBe(once.texts.length);
    expect(once.ledger).toBe(3);
    // Postgres takes the fixed ids as uuids or not at all.
    for (const task of world.tasks) {
      expect(task.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }

    for (let run = 0; run < 4; run += 1) await seedScriptedBoard();

    expect(snapshot()).toEqual(once);
  });

  it('leaves a real repository’s #41, #43 and #144 alone', async () => {
    // The real repository lists first, which is where the board used to go.
    // Its clear then deleted this task, its thread, its gate and its spend.
    realWork();
    const before = rowsIn(world.real.id);

    await seedScriptedBoard();
    await seedScriptedBoard();

    expect(rowsIn(world.real.id)).toEqual(before);
    expect(world.ledger.filter((row) => row.promptHash === null).map((row) => row.costUsd)).toEqual([1.25, 2.5]);
    expect(snapshot().cards).toBe(6);
  });

  it('writes nothing when the install has a repository of its own', async () => {
    // The stand-in is only created when nothing else is configured, so an
    // install like this gets no board rather than one over its own issues.
    world.repos = [world.real];
    realWork();
    const before = rowsIn(world.real.id);

    await seedScriptedBoard();

    expect(rowsIn(world.real.id)).toEqual(before);
    expect(world.issues.size).toBe(1);
    expect(world.tasks.map((task) => task.id)).toEqual(['real-intake', 'real-build']);
  });

  it('leaves a leased task on a scripted card, and what it wrote, alone', async () => {
    // The dispatcher can lease #43 to the builder in the stand-in. That task,
    // its gate, its spend and its lines in the builder's thread share a subject and a
    // bot with the board's, and none of them are the board's.
    await seedScriptedBoard();
    const thread = world.threads.find((candidate) => candidate.subjectRef === inStandIn('#43'));
    if (!thread) throw new Error('the board wrote no thread on #43');
    world.tasks.push({
      id: 'leased-43',
      repoId: world.standIn.id,
      botId: 'bot-builder',
      subjectRef: inStandIn('#43'),
      state: 'running',
      costUsd: 0.5,
    });
    world.ledger.push({ taskId: 'leased-43', costUsd: 0.5, promptHash: null });
    world.messages.push({ id: 'leased-line', threadId: thread.id, text: 'from the leased task', payload: null });
    world.gates.push({
      id: 'leased-gate',
      taskId: 'leased-43',
      threadId: thread.id,
      question: 'a question from the leased task',
      state: 'open',
    });

    await seedScriptedBoard();

    expect(world.tasks.some((task) => task.id === 'leased-43' && task.state === 'running')).toBe(true);
    expect(world.ledger).toContainEqual({ taskId: 'leased-43', costUsd: 0.5, promptHash: null });
    expect(world.messages.some((message) => message.id === 'leased-line')).toBe(true);
    expect(world.gates.some((gate) => gate.id === 'leased-gate')).toBe(true);
    expect(assignees(inStandIn('#43'))).toEqual(['fleetadlc-atlas-janedoe', 'fleetadlc-atlas-janedoe']);
  });
});

describe('the scripted board seed, failing partway', () => {
  beforeEach(() => {
    world.reset();
  });

  it('leaves the last board whole when the clear fails', async () => {
    // Deleted one statement at a time, a failure on the tasks left them
    // without their conversation, their gate and their spend.
    await seedScriptedBoard();
    const whole = tables();

    world.failOn = 'delete from tasks';
    await expect(seedScriptedBoard()).rejects.toThrow('the database refused');

    expect(tables()).toEqual(whole);
  });
});

describe('seed.ts', () => {
  it('seeds when the path it was started by is not the one it resolves to', async () => {
    // It ran main() only when import.meta.url, which has symlinks resolved,
    // matched argv[1], which does not. Started through a symlink it seeded
    // nothing and exited 0. Here argv[1] is vitest, the same mismatch.
    const waited = world.databaseWaits;
    // A seed that throws also closes the pool, then exits 1. Closing the pool
    // is not enough to say it seeded.
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await import('../packages/db/src/cli/seed.js');

    await vi.waitFor(() => expect(world.poolsClosed).toBe(1));
    // The failure path exits just after it closes the pool.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(world.databaseWaits).toBe(waited + 1);
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });
});
