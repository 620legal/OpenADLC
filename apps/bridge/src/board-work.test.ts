import { describe, expect, it, vi } from 'vitest';
import { activityOf, boardWork, FILED_SHOWN_MS, readBoardActivity, readBoardWork } from './board-work.js';
import type { IssueFacts, TaskFacts } from './work.js';

/** What `readBoardWork` and `readBoardActivity` read, for the tests of them that read anything. */
const store = vi.hoisted(() => ({
  issues: [] as IssueFacts[],
  tasks: [] as TaskFacts[],
  sessions: [] as { id: string; taskId: string | null; lastLine: string | null }[],
  panes: {} as Record<string, string[]>,
  /** Each read of the sessions' lines, by the sessions it asked for. */
  lineReads: [] as string[][],
  /** Each read of when tasks last began running, by the tasks it asked for. */
  sinceReads: [] as string[][],
  since: {} as Record<string, string | null>,
  running: 0,
}));
vi.mock('@openadlc/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openadlc/db')>()),
  listEventsOfType: vi.fn(async () => []),
  stageMoves: { sendBackCounts: vi.fn(async () => new Map()) },
  bots: { listBots: vi.fn(async () => [{ id: 'bot-builder', name: 'openadlc-atlas-janedoe' }, { id: 'bot-lead', name: 'noraexampleco' }]) },
  issues: { listIssues: vi.fn(async (repoName?: string) => store.issues.filter((issue) => !repoName || issue.repoName === repoName)) },
  repos: {
    listRepos: vi.fn(async () => [
      { id: 'repo-1', name: 'api', fullName: 'exampleco/api', stageModes: {} },
      { id: 'repo-2', name: 'web', fullName: 'exampleco/web', stageModes: {} },
    ]),
  },
  requests: { listRequests: vi.fn(async () => []) },
  tasks: {
    listTasksOnSubjects: vi.fn(async (refs: readonly string[]) => store.tasks.filter((task) => refs.includes(task.subjectRef))),
    listTasks: vi.fn(async (filter: { states?: string[] }) => store.tasks.filter((task) => !filter.states || filter.states.includes(task.state))),
    countRunning: vi.fn(async () => store.running),
    runningSince: vi.fn(async (ids: readonly string[]) => {
      store.sinceReads.push([...ids]);
      return new Map(ids.filter((id) => id in store.since).map((id) => [id, store.since[id]!]));
    }),
  },
  sessions: {
    listSessions: vi.fn(async () => store.sessions),
    recentLines: vi.fn(async (ids: readonly string[]) => {
      store.lineReads.push([...ids]);
      return new Map(ids.filter((id) => store.panes[id]).map((id) => [id, store.panes[id]!]));
    }),
  },
}));

/**
 * A request's card in Intake says where the request is: waiting its
 * turn, intake on it, waiting on the person, or filed, with the issue.
 */

const NOW = new Date('2026-09-29T12:00:00.000Z');
const minutesAgo = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();

let count = 0;
function triage(subjectRef: string, state: TaskFacts['state']): TaskFacts {
  count += 1;
  return {
    id: `task-${count}`,
    botId: 'bot-intake',
    repoId: 'repo-1',
    kind: 'intake',
    subjectRef,
    state,
    round: 0,
    costUsd: 0,
    startedAt: minutesAgo(2),
    endedAt: null,
    exitReason: null,
    createdAt: minutesAgo(2),
  } as TaskFacts;
}

function request(id: string, state: string, extra: Record<string, unknown> = {}) {
  return { id: `${id}-0000-4000-8000-000000000000`, repoId: 'repo-1', issueNumber: null, text: `Request ${id}`, state, createdAt: minutesAgo(10), ...extra };
}

const read = (requests: ReturnType<typeof request>[], tasks: TaskFacts[] = [], gates: { taskId: string }[] = []) =>
  boardWork({
    issues: [],
    tasks,
    bots: [{ id: 'bot-intake', name: 'ottoexampleco' }],
    repos: [{ id: 'repo-1', name: 'api', fullName: 'exampleco/api', stageModes: {} }],
    gates,
    stallEvents: [],
    requests,
    now: NOW,
  }).requests;

describe('a request in Intake', () => {
  it('is queued with its place in line, as the queue gives it', () => {
    const cards = read([
      request('bbbbbbbb', 'queued', { createdAt: minutesAgo(3), queuePosition: 2 }),
      request('aaaaaaaa', 'queued', { createdAt: minutesAgo(5), queuePosition: 1 }),
    ]);
    expect(cards.map((card) => [card.ref, card.requestState, card.queuePosition])).toEqual([
      ['request:aaaaaaaa', 'queued', 1],
      ['request:bbbbbbbb', 'queued', 2],
    ]);
  });

  it('is not queued once the queue gave up on it: Needs you has it, with Try again', () => {
    const cards = read([
      request('aaaaaaaa', 'queued', { queueAttempts: 5, queuePosition: null }),
      request('bbbbbbbb', 'queued', { queueAttempts: 1, queuePosition: 1 }),
    ]);
    expect(cards.map((card) => [card.ref, card.requestState, card.queuePosition])).toEqual([['request:bbbbbbbb', 'queued', 1]]);
  });

  it('is intake working while its triage runs, and waiting for you while its question is open', () => {
    const running = triage('request:cccccccc', 'running');
    const asking = triage('request:dddddddd', 'paused');
    const cards = read([request('cccccccc', 'draft'), request('dddddddd', 'questions')], [running, asking], [{ taskId: asking.id }]);
    expect(cards.map((card) => [card.ref, card.requestState, card.gateOpen])).toEqual([
      ['request:dddddddd', 'waiting', true],
      ['request:cccccccc', 'working', false],
    ]);
  });

  it('is filed, linking the issue, only until its issue is on the board', () => {
    // Between filing and the issue's first read there is no other card for it.
    const filed = read([request('eeeeeeee', 'filed', { issueNumber: 42, updatedAt: minutesAgo(2) })]);
    expect(filed).toEqual([
      expect.objectContaining({ requestState: 'filed', issueNumber: 42, url: 'https://github.com/exampleco/api/issues/42', queuePosition: null }),
    ]);
    const old = read([request('eeeeeeee', 'filed', { issueNumber: 42, updatedAt: new Date(NOW.getTime() - FILED_SHOWN_MS - 1).toISOString() })]);
    expect(old).toEqual([]);
    // An issue closed before it was ever on the board never arrives: its
    // request does not sit in Intake as work that is still to happen.
    expect(read([request('eeeeeeee', 'filed', { issueNumber: 42, updatedAt: minutesAgo(60) })])).toEqual([]);
  });

  it('is one card with its issue: once the issue is on the board, the request is not a card of its own', () => {
    // It stayed in Intake for a day saying "Filed #42" beside #42's own card in
    // Build, so every piece of work was on the board twice.
    const triaged = { ...triage('request:eeeeeeee', 'done'), costUsd: 0.4 };
    const work = boardWork({
      issues: [
        { repoId: 'repo-1', repoName: 'api', number: 42, title: 'Request eeeeeeee', stage: 'build', url: null, prNumber: null, labels: ['adlc:build'], updatedAt: minutesAgo(5) },
      ],
      tasks: [triaged],
      bots: [{ id: 'bot-intake', name: 'ottoexampleco' }],
      repos: [{ id: 'repo-1', name: 'api', fullName: 'exampleco/api', stageModes: {} }],
      gates: [],
      stallEvents: [],
      requests: [request('eeeeeeee', 'filed', { issueNumber: 42, updatedAt: minutesAgo(30) })],
      now: NOW,
    });
    expect(work.requests).toEqual([]);
    // The issue's card is the one card, and the triage it took still counts on it.
    expect(work.byRef.get('api#42')?.costUsd).toBe(0.4);
  });

  it('is gone when its triage ended without filing it, or it was abandoned', () => {
    const ended = triage('request:ffffffff', 'failed');
    expect(read([request('ffffffff', 'draft'), request('abababab', 'abandoned')], [ended])).toEqual([]);
  });

  it('puts what needs you first, then what intake is on, then the line, then what was filed', () => {
    const running = triage('request:22222222', 'running');
    const asking = triage('request:33333333', 'paused');
    const cards = read(
      [
        request('11111111', 'filed', { issueNumber: 7, updatedAt: minutesAgo(1) }),
        request('22222222', 'draft'),
        request('33333333', 'questions'),
        request('44444444', 'queued'),
      ],
      [running, asking],
      [{ taskId: asking.id }],
    );
    expect(cards.map((card) => card.requestState)).toEqual(['waiting', 'working', 'queued', 'filed']);
  });
});

describe('an issue whose work was sent back', () => {
  it('says on its card how many times', () => {
    const issue = {
      repoId: 'repo-1',
      repoName: 'api',
      number: 7,
      title: 'Cache the price list',
      stage: 'spec' as const,
      url: null,
      prNumber: null,
      labels: ['adlc:spec'],
      updatedAt: minutesAgo(5),
    };
    const work = boardWork({
      issues: [issue, { ...issue, number: 8 }],
      tasks: [],
      bots: [],
      repos: [{ id: 'repo-1', name: 'api', fullName: 'exampleco/api', stageModes: {} }],
      gates: [],
      stallEvents: [],
      requests: [],
      now: NOW,
      sendBacks: new Map([['repo-1#7', 2]]),
    });
    expect(work.byRef.get('api#7')?.sentBack).toBe(2);
    expect(work.byRef.get('api#8')?.sentBack).toBe(0);
  });
});

describe('a card with work running', () => {
  const issue = {
    repoId: 'repo-1',
    repoName: 'api',
    number: 7,
    title: 'Cache the price list',
    stage: 'build' as const,
    url: null,
    prNumber: 31,
    labels: ['adlc:build'],
    updatedAt: minutesAgo(5),
  };
  const task = (id: string, subjectRef: string, state: TaskFacts['state'], extra: Partial<TaskFacts> = {}): TaskFacts =>
    ({ ...triage(subjectRef, state), id, botId: 'bot-builder', kind: 'implement', ...extra }) as TaskFacts;
  const read = (tasks: TaskFacts[], steps: Map<string, string[]>, requests: ReturnType<typeof request>[] = [], since?: Map<string, string | null>) =>
    boardWork({
      issues: [issue],
      tasks,
      bots: [
        { id: 'bot-builder', name: 'openadlc-atlas-janedoe' },
        { id: 'bot-intake', name: 'ottoexampleco' },
      ],
      repos: [{ id: 'repo-1', name: 'api', fullName: 'exampleco/api', stageModes: {} }],
      gates: [],
      stallEvents: [],
      requests,
      now: NOW,
      steps,
      since,
    });

  it('says what its bot is doing now, from the step its session printed last', () => {
    const building = task('task-build', 'api#7', 'running');
    const work = read(
      [building],
      new Map([['task-build', ['[skill] openadlc-atlas-janedoe starting implement on api#7', '[tool] Read: src/prices.ts', '[tool] Bash: pnpm --filter @exampleco/api test']]]),
    );
    expect(work.byRef.get('api#7')?.active).toEqual([expect.objectContaining({ bot: 'openadlc-atlas-janedoe', state: 'running', activity: 'running tests' })]);
  });

  it('reads the step of a task on the card’s pull request as the card’s too, and a request’s triage on its own card', () => {
    const reviewing = task('task-review', 'api#31', 'running', { kind: 'review' });
    const triaging = { ...triage('request:cccccccc', 'running'), id: 'task-triage' } as TaskFacts;
    const work = read(
      [reviewing, triaging],
      new Map([
        ['task-review', ['[tool] Bash: gh pr diff 31']],
        ['task-triage', ['[tool] Grep: Grep']],
      ]),
      [request('cccccccc', 'draft')],
    );
    expect(work.byRef.get('api#7')?.active[0]?.activity).toBe('reading the diff');
    expect(work.requests[0]?.active[0]?.activity).toBe('searching the code');
  });

  it('says no step for a task queued or paused, nor for one that has printed none yet', () => {
    const waiting = task('task-queued', 'api#7', 'queued');
    const asking = task('task-paused', 'api#31', 'paused');
    const starting = task('task-starting', 'api#7', 'running', { botId: 'bot-intake' });
    const work = read(
      [waiting, asking, starting],
      new Map([
        ['task-queued', ['[tool] Bash: pnpm test']],
        ['task-paused', ['[skill] waiting on a person: Which cache?']],
        ['task-starting', ['[skill] ottoexampleco starting implement on api#7']],
      ]),
    );
    expect(work.byRef.get('api#7')?.active.map((one) => [one.state, one.activity])).toEqual([
      ['queued', null],
      ['paused', null],
      ['running', null],
    ]);
  });

  it('counts the tasks running across the install, on a card or not, and only those running', () => {
    const work = read(
      [
        task('task-build', 'api#7', 'running'),
        // A deploy of a commit has no card; it is running all the same.
        task('task-deploy', 'api@3f2c1a9', 'running', { kind: 'deploy' }),
        task('task-queued', 'api#9', 'queued'),
        task('task-paused', 'api#31', 'paused'),
        task('task-done', 'api#7', 'done'),
      ],
      new Map(),
    );
    expect(work.runningTasks).toBe(2);
    expect(read([], new Map()).runningTasks).toBe(0);
  });

  it('says since when each running task has been running: from its resume, not its start, when it paused', () => {
    // Started a day ago, asked, answered two minutes ago: "1 day" was the time it waited on a person.
    const resumed = task('task-resumed', 'api#7', 'running', { startedAt: minutesAgo(24 * 60) });
    const fresh = task('task-fresh', 'api#31', 'running', { startedAt: minutesAgo(6) });
    const unrecorded = task('task-unrecorded', 'api#31', 'running', { startedAt: minutesAgo(90) });
    const waiting = task('task-queued', 'api#7', 'queued');
    const since = new Map<string, string | null>([
      ['task-resumed', minutesAgo(2)],
      ['task-unrecorded', null],
    ]);
    const work = read([resumed, fresh, unrecorded, waiting], new Map(), [], since);
    expect(work.byRef.get('api#7')?.active.map((one) => [one.state, one.since])).toEqual([
      ['running', minutesAgo(2)],
      // Not in what was read: its start, as before.
      ['running', minutesAgo(6)],
      // Resumed at a time nothing recorded: no time, rather than a wrong one.
      ['running', null],
      ['queued', null],
    ]);
  });
});

describe('what a running task is doing, in words', () => {
  it('names the step it is on from the tool it called, in a word a person reads', () => {
    const cases: [string, string | null][] = [
      ['[tool] Bash: cd /workspace/api && pnpm --filter @exampleco/api exec vitest run src/prices.test.ts', 'running tests'],
      ['[tool] shell: go test ./...', 'running tests'],
      ['[tool] Bash: openadlc-ci', 'running CI locally'],
      ['[tool] Bash: make ci', 'running CI locally'],
      ['[tool] Bash: pnpm install --frozen-lockfile', 'installing dependencies'],
      ['[tool] Bash: pnpm build', 'building'],
      ['[tool] Bash: pnpm exec tsc --noEmit', 'type-checking'],
      ['[tool] Bash: git commit -m "Add the test for prices"', 'committing'],
      // Words in a message are not the command.
      ['[tool] Bash: git commit -m "Keep make ci green"', 'committing'],
      ['[tool] Bash: cd /workspace/api && make build', 'building'],
      ['[tool] Bash: git push -u origin agent/builder/7-cache', 'pushing the branch'],
      ['[tool] Bash: gh pr create --title "Cache the price list" --body "Closes #7"', 'opening the pull request'],
      ['[tool] Bash: gh pr diff 31', 'reading the diff'],
      ['[tool] Bash: git diff origin/main...HEAD', 'reading the diff'],
      ['[tool] Bash: gh pr review 31 --approve --body-file review.md', 'writing the review'],
      ['[tool] Bash: gh issue comment 7 --body-file note.md', 'writing a comment'],
      ['[tool] Bash: rg -n "priceList" src', 'searching the code'],
      ['[tool] Bash: sed -n 1,80p src/prices.ts', 'reading the code'],
      ['[tool] Bash: echo done', 'running a command'],
      ['[tool] Read: /workspace/api/src/prices.ts', 'reading the code'],
      ['[tool] Grep: Grep', 'searching the code'],
      ['[tool] Glob: Glob', 'searching the code'],
      ['[tool] Edit: /workspace/api/src/prices.ts', 'editing files'],
      ['[tool] search_replace: src/prices.ts', 'editing files'],
      ['[wrote] src/prices.ts', 'editing files'],
      ['[tool] TodoWrite: TodoWrite', 'planning the work'],
      // Codex runs each command inside a login shell; the command is what is inside it.
      ['[tool] shell: bash -lc "make ci"', 'running CI locally'],
      ["[tool] shell: /bin/bash -lc 'cd /workspace/api && rg -n priceList src'", 'searching the code'],
      // Its older events give the words as a list, joined, with no quotes.
      ['[tool] shell: bash -lc make ci', 'running CI locally'],
      ['[tool] shell: sh -c "git push origin HEAD"', 'pushing the branch'],
      // Starting, its briefing, a question, finishing: no step to name, so the card says its kind of work.
      ['[skill] openadlc-atlas-janedoe starting implement on api#7', null],
      ['[skill] waiting on a person: Which cache?', null],
      ['[tool] SomethingNew: x', null],
    ];
    for (const [line, words] of cases) expect(activityOf(['[skill] starting', line]), line).toBe(words);
    expect(activityOf([])).toBeNull();
  });

  it('reads a command tmux wrapped onto the rows below it', () => {
    // A detached session is 80 columns wide: the last row of the pane was
    // the end of the command, and the tool's name was the row above. The
    // row breaks inside the word that says what the command is.
    const start = '[tool] Bash: cd /workspace/';
    const head = `${start}${'a'.repeat(80 - start.length - ' && pnpm exec vit'.length)} && pnpm exec vit`;
    expect(head).toHaveLength(80);
    expect(activityOf(['[tool] Read: src/prices.ts', head])).toBe('running a command');
    expect(activityOf(['[tool] Read: src/prices.ts', head, 'est run src/prices.test.ts'])).toBe('running tests');
  });

  it('puts back the space tmux trims from a wrapped row’s last column', () => {
    // A row one short of the width ended in a space tmux left off.
    const start = '[tool] Bash: cd /workspace/';
    const head = `${start}${'a'.repeat(79 - start.length - ' && pnpm'.length)} && pnpm`;
    expect(head).toHaveLength(79);
    expect(activityOf([head, 'test'])).toBe('running tests');
  });

  it('glues no other output onto a step that did not fill its row', () => {
    // The runner's next real line is not the rest of the command.
    expect(activityOf(['[tool] Bash: echo starting', ' RUN  v4.1.11 vitest'])).toBe('running a command');
  });

  it('says only its own words, never what the session printed', () => {
    // The screen is an admin's (`sessionsFor`); the board is anybody's.
    const said = [
      activityOf(['[tool] Bash: curl -H "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789" https://api.example.com']),
      activityOf(['[tool] Read: /home/janedoe/.ssh/id_ed25519']),
      activityOf(['[tool] Bash: export TOKEN=hunter2 && ./deploy.sh']),
    ];
    expect(said).toEqual(['reading the web', 'reading the code', 'running a command']);
  });
});

describe('reading the board’s work', () => {
  const issue = (repoName: string, number: number, extra: Partial<IssueFacts> = {}): IssueFacts => ({
    repoId: repoName === 'api' ? 'repo-1' : 'repo-2',
    repoName,
    number,
    title: `Issue ${number}`,
    stage: 'build',
    url: null,
    prNumber: null,
    labels: [],
    updatedAt: minutesAgo(5),
    ...extra,
  });
  const running = (id: string, subjectRef: string, extra: Partial<TaskFacts> = {}): TaskFacts =>
    ({ ...triage(subjectRef, 'running'), id, botId: 'bot-builder', kind: 'implement', ...extra }) as TaskFacts;

  function install(): void {
    store.issues = [issue('api', 7, { prNumber: 31 }), issue('api', 8, { labels: ['openadlc:ignore'] }), issue('web', 3), issue('api', 9)];
    store.tasks = [
      running('task-review', 'api#31', { kind: 'review', botId: 'bot-lead', startedAt: minutesAgo(40) }),
      { ...triage('api#7', 'queued'), id: 'task-queued', botId: 'bot-builder', kind: 'patch' } as TaskFacts,
      { ...triage('api#7', 'paused'), id: 'task-asking', botId: 'bot-builder', kind: 'patch' } as TaskFacts,
      // On an issue the console leaves out, and with no card at all: not on the board, so not read.
      running('task-ignored', 'api#8'),
      running('task-deploy', 'api@3f2c1a9', { kind: 'deploy' }),
      running('task-web', 'web#3'),
      { ...triage('api#9', 'done'), id: 'task-done', botId: 'bot-builder' } as TaskFacts,
    ];
    store.sessions = [
      { id: 'session-review', taskId: 'task-review', lastLine: 'ter @exampleco/api test' },
      { id: 'session-asking', taskId: 'task-asking', lastLine: '[skill] waiting on a person: Which cache?' },
      { id: 'session-ignored', taskId: 'task-ignored', lastLine: '[tool] Bash: pnpm test' },
      { id: 'session-deploy', taskId: 'task-deploy', lastLine: '[tool] Bash: gh run watch' },
      { id: 'session-web', taskId: 'task-web', lastLine: '[tool] Read: src/app.ts' },
      { id: 'session-shell', taskId: null, lastLine: '$' },
    ];
    store.panes = {
      'session-review': ['[tool] Bash: gh pr diff 31'],
      'session-ignored': ['[tool] Bash: pnpm test'],
      'session-deploy': ['[tool] Bash: gh run watch'],
      'session-web': ['[tool] Read: src/app.ts'],
    };
    // Resumed two minutes ago after a question, forty minutes after it started.
    store.since = { 'task-review': minutesAgo(2) };
    // More than the listing of 200 a page of tasks holds.
    store.running = 231;
    store.lineReads = [];
    store.sinceReads = [];
  }

  it('reads, in one query each, the latest output and the resume of only the running tasks on the cards it shows', async () => {
    install();
    const work = await readBoardWork(
      {
        issues: store.issues,
        bots: [
          { id: 'bot-builder', name: 'openadlc-atlas-janedoe' },
          { id: 'bot-lead', name: 'noraexampleco' },
        ],
        repos: [
          { id: 'repo-1', name: 'api', fullName: 'exampleco/api', stageModes: {} },
          { id: 'repo-2', name: 'web', fullName: 'exampleco/web', stageModes: {} },
        ],
        gates: [],
        requests: [],
        sessions: store.sessions,
      },
      NOW,
    );
    expect(store.lineReads).toEqual([['session-review', 'session-web']]);
    expect(store.sinceReads.map((ids) => [...ids].sort())).toEqual([['task-review', 'task-web']]);
    expect(work.byRef.get('api#7')?.active.map((one) => [one.state, one.activity, one.since])).toEqual([
      ['running', 'reading the diff', minutesAgo(2)],
      ['queued', null, null],
      ['paused', null, null],
    ]);
    // Counted by the database: every running task in the install.
    expect(work.runningTasks).toBe(231);
  });

  it('reads, for the few-second poll, only each running card shown, with all its work and its step, and the count', async () => {
    install();
    const activity = await readBoardActivity(undefined, NOW);
    expect(activity.running).toBe(231);
    expect(activity.cards.map((card) => card.ref)).toEqual(['api#7', 'web#3']);
    expect(activity.cards[0]?.active.map((one) => [one.bot, one.state, one.activity, one.since])).toEqual([
      ['noraexampleco', 'running', 'reading the diff', minutesAgo(2)],
      ['openadlc-atlas-janedoe', 'queued', null, null],
      ['openadlc-atlas-janedoe', 'paused', null, null],
    ]);
    expect(store.lineReads).toEqual([['session-review', 'session-web']]);

    // A board of one repository polls for its own cards; the count is still the install's.
    install();
    const api = await readBoardActivity('api', NOW);
    expect(api.cards.map((card) => card.ref)).toEqual(['api#7']);
    expect(api.running).toBe(231);
    expect(store.lineReads).toEqual([['session-review']]);
  });
});
