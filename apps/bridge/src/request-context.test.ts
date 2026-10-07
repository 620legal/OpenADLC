import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What a console request's triage is given to read, when it starts and when it
 * resumes after a question.
 *
 * Every task was briefed by reading its issue from GitHub, and a request has
 * no issue yet — so the intake bot opened on `request:a4b02784` was briefed
 * with nothing, and said the request was nowhere it could reach. It was right.
 */

const store = vi.hoisted(() => ({
  request: {
    id: 'a4b02784-3ae8-450b-abe9-0c93eb4d67dc',
    text: 'Create html hello world and a readme file.',
    context: 'Keep it to one page; no framework.',
    repoId: 'repo-1',
    kind: 'feature',
    requestedBy: 'janedoe',
    issueNumber: null as number | null,
    state: 'draft',
    createdAt: '2026-09-24T20:44:22.945Z',
  },
  gates: [] as Record<string, unknown>[],
  messages: [] as Record<string, unknown>[],
  prefixes: [] as string[],
  /** Files given with the request. */
  files: [] as Record<string, unknown>[],
  /** The repository's issues, as the bridge has them. */
  issues: [] as Record<string, unknown>[],
  /** The stored `unownedIssues` setting, or null. */
  unowned: null as string | null,
  /** Whether the subject's prefix names two requests. */
  ambiguous: false,
}));

vi.mock('@fleetadlc/db', () => ({
  attachments: {
    listForSubjects: vi.fn(async (refs: readonly string[]) => store.files.filter((one) => refs.includes(String(one.subjectRef)))),
  },
  issues: { listIssues: vi.fn(async () => store.issues) },
  // No host has registered: room is not counted (`hosts.taskRoom`).
  hosts: { taskRoom: vi.fn(async () => null) },
  spendingLimits: {
    SPENDING_PROVIDERS: ['anthropic', 'openai', 'xai'],
    GLOBAL_SCOPE: 'global',
    seedGlobal: vi.fn(async () => false),
    effectiveTaskCap: vi.fn(async (_repoId: string | null, fallback: number) => fallback),
    amountOf: vi.fn(async () => null),
    refusal: vi.fn(async () => null),
    listLimits: vi.fn(async () => []),
    setLimit: vi.fn(async () => undefined),
    dollars: (amount: number) => (Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`),
    botKind: (id: string) => `month_bot:${id}`,
    providerKind: (provider: string) => `month_provider:${provider}`,
    repoScope: (id: string) => `repo:${id}`,
    repoIdOf: (scope: string) => (scope.startsWith('repo:') ? scope.slice(5) : null),
  },

  bots: {
    getBotById: vi.fn(async () => ({ id: 'bot-intake', name: 'ottoexampleco', displayName: 'Intake', engine: 'claude', model: 'm' })),
    getBotByName: vi.fn(async () => ({ id: 'bot-intake', name: 'ottoexampleco', displayName: 'Intake', engine: 'claude', model: 'm' })),
  },
  costs: { currentPeriod: vi.fn(() => '2026-09') },
  repos: {
    listRepos: vi.fn(async () => [{ id: 'repo-1', name: 'fleetadlc-testbed', fullName: 'janedoe/fleetadlc-testbed' }]),
    getRepoByName: vi.fn(async () => ({ id: 'repo-1', name: 'fleetadlc-testbed', fullName: 'janedoe/fleetadlc-testbed' })),
  },
  requests: (() => {
    class AmbiguousRequestPrefix extends Error {}
    return {
      AmbiguousRequestPrefix,
      findRequestByPrefix: vi.fn(async (prefix: string) => {
        store.prefixes.push(prefix);
        // Two requests sent before migration 0144 that share their first eight characters.
        if (store.ambiguous) throw new AmbiguousRequestPrefix(`request:${prefix} matches more than one request`);
        return store.request.id.startsWith(prefix) ? { ...store.request } : null;
      }),
    };
  })(),
  settings: {
    allSettings: vi.fn(async () => ({})),
    getSetting: vi.fn(async (key: string) => (key === 'unownedIssues' ? store.unowned : null)),
    setSetting: vi.fn(async () => undefined),
  },
  tasks: {
    getTask: vi.fn(async () => ({
      id: 'task-1',
      botId: 'bot-intake',
      repoId: 'repo-1',
      kind: 'intake',
      subjectType: 'request',
      subjectRef: 'request:a4b02784',
      skill: 'triage',
    })),
    countActiveTasksForBot: vi.fn(async () => 0),
    seatHasRoom: vi.fn(async () => true),
    liveTaskOn: vi.fn(async () => null),
    createTask: vi.fn(async (input: Record<string, unknown>) => ({ id: 'task-1', ...input })),
    updateTaskState: vi.fn(async () => null),
  },
  threads: {
    ensureThread: vi.fn(async () => ({ id: 'thread-1' })),
    addMessage: vi.fn(async () => undefined),
    listGatesForSubject: vi.fn(async () => store.gates),
    listThreadsForSubject: vi.fn(async () => [{ id: 'thread-1', subject_ref: 'request:a4b02784' }]),
    listMessages: vi.fn(async () => store.messages),
  },
}));

import type { ContextDocument } from '@fleetadlc/shared';
import type { Actors } from './actors.js';
import type { BridgeConfig } from './config.js';
import { Context } from './context.js';
import type { HostdClient } from './hostd-client.js';
import { OPEN_WORK_DOCUMENT, REQUEST_DOCUMENT } from './request-context.js';
import { TaskService } from './task-service.js';

const startTask = vi.fn(async (_input: { context: ContextDocument[] }) => ({ session: 'ottoexampleco/triage' }));
const resumeTask = vi.fn(async (_taskId: string, _context: ContextDocument[]) => ({ session: 'ottoexampleco/triage' }));

function service(): TaskService {
  // GitHub is never asked: a request has nothing there to read.
  const actors = { asBot: vi.fn(async () => Promise.reject(new Error('GitHub was asked'))) } as unknown as Actors;
  return new TaskService(
    { costs: { perTaskCapUsd: 15 } } as BridgeConfig,
    { startTask, resumeTask } as unknown as HostdClient,
    new Context(actors, { automationBot: null, consoleUrl: 'http://console.test/' }),
  );
}

async function openTriage(): Promise<ContextDocument[]> {
  await service().open({
    bot: 'ottoexampleco',
    repo: 'fleetadlc-testbed',
    kind: 'intake',
    subjectType: 'request',
    subjectRef: 'request:a4b02784',
    skill: 'triage',
  });
  return startTask.mock.calls.at(-1)?.[0].context ?? [];
}

async function resumeTriage(): Promise<ContextDocument[]> {
  await service().resume('task-1');
  return resumeTask.mock.calls.at(-1)?.[1] ?? [];
}

beforeEach(() => {
  store.files = [];
  store.issues = [];
  store.unowned = null;
  store.ambiguous = false;
  store.gates = [];
  store.messages = [];
  store.prefixes = [];
  store.request.issueNumber = null;
  startTask.mockClear();
  resumeTask.mockClear();
});

describe('the request a console request’s triage reads', () => {
  it('is what it starts with: the text, the context, who asked, where and when', async () => {
    const [document, ...others] = await openTriage();

    // And the repository's open work, for the overlap check before filing.
    expect(others.map((one) => one.name)).toEqual([OPEN_WORK_DOCUMENT]);
    expect(document?.name).toBe(REQUEST_DOCUMENT);
    expect(document?.name).toBe('request.md');
    // Looked up by its prefix alone, for its brief and for the files its item carries.
    expect(new Set(store.prefixes)).toEqual(new Set(['a4b02784']));

    const content = document?.content ?? '';
    expect(content).toContain('Create html hello world and a readme file.');
    expect(content).toContain('Keep it to one page; no framework.');
    expect(content).toContain('**Kind:** feature');
    expect(content).toContain('**Repository:** janedoe/fleetadlc-testbed');
    expect(content).toContain('**Asked by:** janedoe, at 2026-09-24T20:44:22.945Z');
    // The line the issue it files has to carry, so it can be linked back.
    expect(content).toContain('OpenADLC request: request:a4b02784');
    expect(content).toContain('_Nothing yet: no question has been answered');
  });

  it('carries each answered question, and what else the person wrote, when triage resumes', async () => {
    store.gates = [
      {
        id: 'gate-1',
        taskId: 'task-1',
        question: 'Should the page say "Hello, world" or just "Hello"?',
        options: ['Hello, world', 'Hello'],
        state: 'answered',
        answer: 'Hello, world',
        answeredBy: 'janedoe',
        answeredAt: '2026-09-24T21:02:11.000Z',
      },
      {
        id: 'gate-2',
        taskId: 'task-1',
        question: 'Anything else for the readme?',
        options: [],
        state: 'answered',
        answer: 'Say how to open it in a browser.',
        answeredBy: 'janedoe',
        answeredAt: '2026-09-24T21:09:40.000Z',
      },
      // Still waiting: it has no answer to give anybody.
      { id: 'gate-3', taskId: 'task-1', question: 'A question nobody answered', options: [], state: 'open', answer: null },
    ];
    store.messages = [
      { id: 'm-1', kind: 'sys', author: 'fleetadlc', text: 'Intake started triage on request:a4b02784', payload: null, at: '2026-09-24T20:44:23.000Z' },
      { id: 'm-2', kind: 'gate', author: 'ottoexampleco', text: 'Should the page say…', payload: { gateId: 'gate-1' }, at: '2026-09-24T20:50:00.000Z' },
      // The answer is written into the thread too. It is shown once, with its question.
      { id: 'm-3', kind: 'you', author: 'janedoe', text: 'Hello, world', payload: { gateId: 'gate-1' }, at: '2026-09-24T21:02:11.000Z' },
      { id: 'm-4', kind: 'you', author: 'janedoe', text: 'And make the background dark, please.', payload: null, at: '2026-09-24T21:05:00.000Z' },
      { id: 'm-5', kind: 'you', author: 'janedoe', text: 'Say how to open it in a browser.', payload: { gateId: 'gate-2' }, at: '2026-09-24T21:09:40.000Z' },
    ];

    const [document] = await resumeTriage();
    const content = document?.content ?? '';

    expect(document?.name).toBe('request.md');
    expect(content).toContain('Create html hello world and a readme file.');
    expect(content).toContain('### A question, answered by janedoe at 2026-09-24T21:02:11.000Z');
    expect(content).toContain('Should the page say "Hello, world" or just "Hello"?');
    expect(content).toContain('1. Hello, world\n2. Hello');
    expect(content).toContain('**Answer:** Hello, world');
    expect(content).toContain('_None: the answer was theirs to word._');
    expect(content).toContain('**Answer:** Say how to open it in a browser.');
    expect(content).toContain('### janedoe wrote, at 2026-09-24T21:05:00.000Z\n\nAnd make the background dark, please.');

    // In the order it happened, each thing once, and nothing the bot said.
    const order = ['answered by janedoe at 2026-09-24T21:02', 'make the background dark', 'answered by janedoe at 2026-09-24T21:09'];
    const positions = order.map((text) => content.indexOf(text));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(content.split('Say how to open it in a browser.').length - 1).toBe(1);
    expect(content).not.toContain('A question nobody answered');
    expect(content).not.toContain('started triage');
    expect(content).not.toContain('_Nothing yet');
  });

  it('starts the task anyway, unbriefed, when the subject names no request it can find', async () => {
    store.request.id = 'ffffffff-0000-0000-0000-000000000000';
    try {
      expect(await openTriage()).toEqual([]);
      expect(startTask).toHaveBeenCalledTimes(1);
    } finally {
      store.request.id = 'a4b02784-3ae8-450b-abe9-0c93eb4d67dc';
    }
  });
});

describe('a subject that names two requests', () => {
  it('briefs triage to have it sent again, rather than with nothing or with the wrong one', async () => {
    store.ambiguous = true;

    const context = await openTriage();

    // Not the open work either: which repository it is about is not known.
    expect(context.map((one) => one.name)).toEqual([REQUEST_DOCUMENT]);
    const content = context[0]?.content ?? '';
    expect(content).toContain('`request:a4b02784` names more than one request');
    expect(content).toContain('send it again from the console');
    expect(content).toContain('Do not file an issue');
    expect(content).not.toContain('Create html hello world');
    expect(startTask).toHaveBeenCalledTimes(1);
  });
});

describe('the open work a triage compares its draft with', () => {
  it('lists each open issue with the files it will touch, and leaves out what has merged', async () => {
    // A hello page and a snake game were filed as two issues that both create
    // index.html: intake looked for duplicates, never for overlap.
    store.issues = [
      { number: 7, title: 'Add a snake game', stage: 'build', declaredPaths: [], body: '## Expected paths\n- index.html\n- Makefile\n' },
      { number: 3, title: 'Add a hello page', stage: 'build', declaredPaths: ['index.html', 'Makefile'], body: '' },
      { number: 1, title: 'Add a getting-started page', stage: 'merged', declaredPaths: ['docs/getting-started.md'], body: '' },
    ];

    const open = (await openTriage()).find((one) => one.name === OPEN_WORK_DOCUMENT);

    expect(open?.content).toContain('- **#3** Add a hello page (build): `index.html`, `Makefile`');
    // Read from the body the way the dispatcher reads it, when none are cached.
    expect(open?.content).toContain('- **#7** Add a snake game (build): `index.html`, `Makefile`');
    expect(open?.content).not.toContain('#1');
    expect(open!.content.indexOf('#3')).toBeLessThan(open!.content.indexOf('#7'));
  });

  it('leaves out what nobody will build: an ignored issue, and one OpenADLC will not take on its own', async () => {
    // Intake asked how every request should fit with two issues filed by an old
    // crew account that nothing was ever going to build.
    store.issues = [
      { number: 7, title: 'Add 3D rubicube as rub.html', stage: 'intake', labels: [], declaredPaths: ['rub.html', 'Makefile'], body: '' },
      { number: 4, title: 'Ignored', stage: 'build', labels: ['fleetadlc:ignore'], declaredPaths: ['Makefile'], body: '' },
      { number: 3, title: 'Add a hello page', stage: 'build', labels: ['adlc:build'], declaredPaths: ['Makefile'], body: '' },
    ];
    store.unowned = JSON.stringify({ 'fleetadlc-testbed': [{ number: 7, title: 'Add 3D rubicube as rub.html', url: 'u', author: 'outside-author' }] });

    const open = (await openTriage()).find((one) => one.name === OPEN_WORK_DOCUMENT);

    expect(open?.content).toContain('**#3**');
    expect(open?.content).not.toContain('**#7**');
    expect(open?.content).not.toContain('**#4**');
  });

  it('marks which overlap is worth asking about: exclusive paths, not shared ones', async () => {
    // Intake asked how every request should fit with whatever else touched the
    // Makefile, which never holds work back now.
    store.issues = [
      { number: 5, title: 'Add a users table', stage: 'build', labels: ['adlc:build'], declaredPaths: ['db/migrations/0002_users.sql', 'Makefile', 'src/users.ts'], body: '' },
    ];

    const open = (await openTriage()).find((one) => one.name === OPEN_WORK_DOCUMENT);

    expect(open?.content).toContain('`db/migrations/0002_users.sql` (exclusive), `Makefile` (shared), `src/users.ts`');
    expect(open?.content).toContain('A path marked (exclusive) is one two changes in flight break each other on');
  });

  it('says there are none, rather than leaving the triage to guess', async () => {
    const open = (await openTriage()).find((one) => one.name === OPEN_WORK_DOCUMENT);
    expect(open?.content).toContain('_No open issues._');
  });

  it('states the repository’s spec rule, which the bridge applies when the triage ends', async () => {
    // Triage was told to label adlc:spec "when the spec rule matches" and was
    // never told the rule.
    const { repos } = await import('@fleetadlc/db');
    const repo = { id: 'repo-1', name: 'fleetadlc-testbed', fullName: 'janedoe/fleetadlc-testbed', specRequiredLabels: ['touches:schema', 'size:large'] };
    vi.mocked(repos.listRepos).mockResolvedValue([{ ...repo, stageModes: { spec: 'conditional' } }] as never);
    try {
      const conditional = (await openTriage()).find((one) => one.name === OPEN_WORK_DOCUMENT);
      expect(conditional?.content).toContain('Spec mode: `conditional`. The labels that send an issue to Design: `touches:schema`, `size:large`.');
      expect(conditional?.content).toContain('Put on each of those labels that fits the issue.');

      vi.mocked(repos.listRepos).mockResolvedValue([{ ...repo, stageModes: { spec: 'untouched' } }] as never);
      const untouched = (await openTriage()).find((one) => one.name === OPEN_WORK_DOCUMENT);
      expect(untouched?.content).toContain('Never label one `adlc:spec`.');
    } finally {
      vi.mocked(repos.listRepos).mockResolvedValue([{ id: 'repo-1', name: 'fleetadlc-testbed', fullName: 'janedoe/fleetadlc-testbed' }] as never);
    }
  });
});

describe('the files given with a request', () => {
  it('are named in what triage reads, with the work item to link to instead of them, and given to the task', async () => {
    // Intake asked what the page should look like while the mockup sat in the
    // database, and a filed issue linked to nothing it could show.
    store.files = [
      { id: 'f-1', subjectRef: 'request:a4b02784', name: 'mockup.png', mediaType: 'image/png', sizeBytes: 48_000, sha256: 'a'.repeat(64), uploadedBy: 'janedoe', source: 'console' },
    ];
    const [document] = await openTriage();
    const content = document?.content ?? '';
    expect(content).toContain('## Files given with it');
    expect(content).toContain('- mockup.png (image/png, 47 kB)');
    expect(content).toContain('never on GitHub');
    expect(content).toContain('**Work item in the console:** http://console.test/?item=request%3Aa4b02784');

    const given = (startTask.mock.calls.at(-1)?.[0] as { attachments?: { name: string }[] }).attachments ?? [];
    expect(given.map((one) => one.name)).toEqual(['mockup.png']);
  });

  it('are said to be none when there are none', async () => {
    const [document] = await openTriage();
    expect(document?.content).toMatch(/## Files given with it\n\n_None._/);
  });
});
