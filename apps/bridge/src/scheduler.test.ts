import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DELIVERY_RULES, type TaskState } from '@openadlc/shared';
import { DEFAULT_INTERVALS } from './job-timer.js';
import {
  attentionIn,
  awaitingTestingDeploy,
  deploySweepRefusal,
  MAX_DEPLOY_ATTEMPTS,
  planDeploySweep,
  SCHEDULED_JOBS,
  RECOVERY_ACTOR,
  continueBuildsWithoutPullRequest,
  retryAfterRecovery,
  Scheduler,
  type AwaitingDeploy,
} from './scheduler.js';
import { TaskService } from './task-service.js';
import { CHECKS_FAILED } from './merge-line.js';

/**
 * The store is a fake so a whole deploy sweep can be run. Everything above the
 * `Scheduler` tests drives a pure function and never reaches it.
 */
const store = vi.hoisted(() => ({
  issues: [] as Record<string, unknown>[],
  bots: [] as Record<string, unknown>[],
  /** The newest thousand tasks the old lookup read, which here are never deploys. */
  recentTasks: [] as Record<string, unknown>[],
  deployTasks: [] as { subjectRef: string; state: string; exitReason?: string | null }[],
  events: [] as { type: string; payload: Record<string, unknown>; at?: string }[],
  repos: [] as Record<string, unknown>[],
  health: [] as Record<string, unknown>[],
  /** The reviews a pull request already has, by seat. */
  reviewTasks: [] as { subjectRef: string; state: string; botId: string; createdAt?: string }[],
  /** When the current round of reviews began (`review.round_opened`), or null when none was recorded. */
  roundAt: null as string | null,
  /** Every task the store holds, with `autoRetriedAt` as the claim leaves it. */
  tasks: [] as Record<string, any>[],
  /** When each attachment sweep cut off. */
  swept: [] as Date[],
  /** The moments `pruneGithubDeliveries` was asked to remove deliveries before. */
  pruned: [] as Date[],
  audits: [] as Record<string, unknown>[],
  /** The testing-deploy setting, JSON keyed by repository name. Null is automatic. */
  testingDeploy: null as string | null,
  /** What was said in a bot's thread. */
  said: [] as string[],
  /** Paused tasks whose question was answered after they paused (`tasks.pausedWithAnswer`). */
  answered: [] as Record<string, unknown>[],
  /** The changes being made in a repository (`issues.workInFlight`). */
  inFlight: [] as { number: number; paths: string[]; building: boolean }[],
  /** Each pull request's row in the merge line, whatever its state (`mergeLines.entryFor`). */
  mergeRows: [] as { prNumber: number; state: string; headSha: string | null; detail?: string | null }[],
  /** The `humanIds` setting: each of the install's people pinned to an account id. */
  humanIds: null as string | null,
  /** What the deploy pipeline recorded of each merged commit (`deployRuns.forPullRequests`). */
  deployRuns: [] as Record<string, unknown>[],
}));

// The status job's report reads the whole store; which issue it lands on is what is tested here.
vi.mock('./status.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./status.js')>()),
  buildStatus: vi.fn(async () => ({
    generatedAt: '2026-10-01T00:00:00.000Z',
    hosts: [],
    crew: [],
    board: {},
    budget: { period: '2026-10', capUsd: 100, spentUsd: 1, state: 'ok' },
    openGates: 0,
    activeLeases: 0,
  })),
}));

vi.mock('@openadlc/db', async () => ({
  // When the bridge last took a delivery: where the first redelivery pass reads back to.
  lastGithubDelivery: vi.fn(async () => ({ at: '2026-10-04T11:00:00.000Z', type: 'issue_comment' })),
  attachments: { sweepUnclaimed: vi.fn(async (before: Date) => (store.swept.push(before), 2)) },
  pruneGithubDeliveries: vi.fn(async (before: Date) => (store.pruned.push(before), 1234)),
  designMemory: { listForRepo: vi.fn(async () => []), decisionsWithoutAdr: vi.fn(async () => []) },
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

  audit: vi.fn(async (entry: Record<string, unknown>) => {
    store.audits.push(entry);
  }),
  health: { listHealth: vi.fn(async () => store.health) },
  bots: {
    listBots: vi.fn(async () => store.bots),
    getBotById: vi.fn(async (id: string) => ({ id, name: 'openadlc-cipher-janedoe', engine: 'claude' })),
  },
  costs: { currentPeriod: vi.fn(() => '2026-09') },
  credentials: {},
  issues: {
    listIssues: vi.fn(async () => store.issues),
    setPullRequestNumber: vi.fn(async () => undefined),
    workInFlight: vi.fn(async () => store.inFlight),
  },
  leases: { expireStaleLeases: vi.fn(async () => []) },
  deployRuns: { forPullRequests: vi.fn(async () => store.deployRuns) },
  lastEventAt: vi.fn(async () => store.roundAt),
  listEventsOfTypeWith: vi.fn(async (type: string, fields: Record<string, unknown>) =>
    store.events
      .filter((event) => event.type === type && Object.entries(fields).every(([key, value]) => event.payload[key] === value))
      .map((event, id) => ({ id, at: event.at ?? '2026-10-01T00:00:00.000Z', payload: event.payload })),
  ),
  recordEvent: vi.fn(async (event: { type: string; payload: Record<string, unknown> }) => {
    store.events.push(event);
    return 'event-1';
  }),
  repos: {
    getRepoByName: vi.fn(async (name: string) => ({ name, fullName: `janedoe/${name}`, defaultBranch: 'main' })),
    listRepos: vi.fn(async () => store.repos),
    getDelivery: vi.fn(async () => ({ deliveryRules: null, testingUrl: null })),
  },
  settings: {
    getSetting: vi.fn(async (key: string) => (key === 'testingDeploy' ? store.testingDeploy : key === 'humanIds' ? store.humanIds : null)),
    allSettings: vi.fn(async () => ({})),
  },
  mergeLines: {
    entryFor: vi.fn(async (_repoId: string, prNumber: number) => store.mergeRows.find((row) => row.prNumber === prNumber) ?? null),
  },
  tasks: {
    listTasks: vi.fn(async () => store.recentTasks),
    pausedWithAnswer: vi.fn(async () => store.answered),
    getTask: vi.fn(async (id: string) => store.tasks.find((task) => task.id === id) ?? null),
    // The real rule, so the sweep is tested against what the store writes.
    stoppedByPerson: (await vi.importActual<typeof import('@openadlc/db')>('@openadlc/db')).tasks.stoppedByPerson,
    listTasksForSubjects: vi.fn(async (_kind: string, refs: readonly string[]) =>
      [...store.deployTasks, ...store.reviewTasks].filter((task) => refs.includes(task.subjectRef)),
    ),
    listTasksSince: vi.fn(async () => store.tasks),
    countUnfinishedImplementTasks: vi.fn(
      async (repoId: string) =>
        store.tasks.filter((task) => task.repoId === repoId && task.kind === 'implement' && ['queued', 'running', 'paused'].includes(task.state)).length,
    ),
    countActiveTasksForBot: vi.fn(
      async (botId: string) => store.tasks.filter((task) => task.botId === botId && ['queued', 'running', 'paused'].includes(task.state)).length,
    ),
    // One task at a time, as every seat here is.
    seatHasRoom: vi.fn(
      async (botId: string, alsoStarting = 0) =>
        store.tasks.filter((task) => task.botId === botId && ['queued', 'running', 'paused'].includes(task.state)).length + alsoStarting < 1,
    ),
    claimAutoRetry: vi.fn(async (id: string) => {
      const task = store.tasks.find((one) => one.id === id);
      if (!task || task.autoRetriedAt) return false;
      task.autoRetriedAt = '2026-09-29T12:00:00.000Z';
      return true;
    }),
    releaseAutoRetry: vi.fn(async (id: string) => {
      const task = store.tasks.find((one) => one.id === id);
      if (task) task.autoRetriedAt = null;
    }),
    retakeAutoRetry: vi.fn(async (id: string, claimedBefore: Date) => {
      const task = store.tasks.find((one) => one.id === id);
      if (!task?.autoRetriedAt || Date.parse(task.autoRetriedAt) >= claimedBefore.getTime()) return false;
      task.autoRetriedAt = new Date().toISOString();
      return true;
    }),
    updateTaskState: vi.fn(async (id: string, state: string, patch: { exitReason?: string | null } = {}) => {
      const task = store.tasks.find((one) => one.id === id);
      if (task) Object.assign(task, { state, exitReason: patch.exitReason ?? task.exitReason });
      return task ?? null;
    }),
  },
  threads: {
    ensureThread: vi.fn(async () => ({ id: 'thread-1' })),
    listThreadsForSubjects: vi.fn(async (subjects: string[]) => (subjects.includes('openadlc#45') ? [{ id: 'thread-45', subject_ref: 'openadlc#45' }] : [])),
    addMessage: vi.fn(async (message: { text: string }) => {
      store.said.push(message.text);
    }),
  },
}));

beforeEach(() => {
  store.issues = [];
  store.deployRuns = [];
  store.bots = [];
  store.recentTasks = [];
  store.deployTasks = [];
  store.events = [];
  store.repos = [];
  store.health = [];
  store.reviewTasks = [];
  store.roundAt = null;
  store.tasks = [];
  store.audits = [];
  store.testingDeploy = null;
  github.workflows = [{ name: 'deploy-testing', path: '.github/workflows/deploy-testing.yml' }];
  github.asked = [];
  store.said = [];
  store.answered = [];
  store.inFlight = [];
  store.mergeRows = [];
  store.humanIds = null;
});

/**
 * The status job used to post a comment on every run. At the plan's
 * fifteen-minute cadence that is roughly ninety-six a day on one issue, which
 * makes the issue unreadable and every notification from it worthless.
 *
 * The body carries everything. A comment is a notification, and is worth sending
 * only when something needs a person and waiting for them to look would be too
 * late. These pin which cases those are.
 */
const clear = {
  budget: { state: 'ok', spentUsd: 12, capUsd: 1500 },
  openGates: 0,
  crew: [{ name: 'atlas', authorization: 'active' }],
};

describe('what is worth telling a person about', () => {
  it('says nothing when nothing needs anyone', () => {
    expect(attentionIn(clear)).toBeNull();
  });

  it('says so when spending has stopped', () => {
    const stopped = attentionIn({ ...clear, budget: { state: 'stopped', spentUsd: 1500, capUsd: 1500 } });
    expect(stopped).toContain('Spending is stopped');
    // The number matters: "at the cap" without it is not actionable.
    expect(stopped).toContain('1500');
  });

  it('does not treat a warning as an emergency', () => {
    // A warning is on the board. Waking someone for it is how the next one gets
    // ignored.
    expect(attentionIn({ ...clear, budget: { state: 'warning', spentUsd: 1400, capUsd: 1500 } })).toBeNull();
  });

  it('names a bot that can no longer act', () => {
    const locked = attentionIn({
      ...clear,
      crew: [
        { name: 'atlas', authorization: 'active' },
        { name: 'sydney', authorization: 'revoked' },
      ],
    });
    expect(locked).toContain('sydney');
    expect(locked).not.toContain('atlas');
    // The command names the bot: without --bot it connects nothing.
    expect(locked).toBe('sydney cannot act on GitHub any more. Run: `openadlc auth login --bot sydney`.');
  });

  it('does not report an account that was never connected', () => {
    // `unauthorized` is an install that is not finished, not a thing that broke.
    expect(attentionIn({ ...clear, crew: [{ name: 'vega', authorization: 'unauthorized' }] })).toBeNull();
  });

  it('reports questions waiting on a person', () => {
    expect(attentionIn({ ...clear, openGates: 3 })).toContain('3 questions are waiting');
    expect(attentionIn({ ...clear, openGates: 1 })).toContain('1 question is waiting');
  });

  it('reports the most serious thing, not all of them', () => {
    // A stopped budget and an open gate at once: the budget is why nothing is
    // moving, so that is the line.
    const both = attentionIn({
      ...clear,
      budget: { state: 'stopped', spentUsd: 1500, capUsd: 1500 },
      openGates: 4,
    });
    expect(both).toContain('Spending is stopped');
  });

  it('is stable, so the same state does not notify twice', () => {
    // The scheduler suppresses a repeat by comparing this string, so the same
    // input has to give the same output.
    expect(attentionIn({ ...clear, openGates: 2 })).toBe(attentionIn({ ...clear, openGates: 2 }));
  });
});

const merged = {
  repoName: 'openadlc',
  number: 45,
  prNumber: 145,
  labels: ['adlc:merged', 'priority:p1'],
  stage: 'merged',
};

const waiting: AwaitingDeploy = { repo: 'openadlc', number: 45, prNumber: 145 };

describe('which merged work is waiting on a testing deploy', () => {
  it('is a scheduled job, so openadlc status can list it', () => {
    expect(SCHEDULED_JOBS).toContain('deploy');
  });

  it('sweeps every thirty minutes', () => {
    expect(DEFAULT_INTERVALS.deploy).toBe(30);
  });

  it('selects a merged issue that testing has not labelled', () => {
    expect(awaitingTestingDeploy([merged])).toEqual([waiting]);
  });

  it('leaves work that is already on testing, and work that has not merged', () => {
    expect(
      awaitingTestingDeploy([
        { ...merged, labels: [...merged.labels, 'deployed:testing'] },
        { ...merged, number: 44, stage: 'review', labels: ['adlc:review'] },
        { ...merged, number: 46, stage: 'done', labels: ['adlc:done'] },
      ]),
    ).toEqual([]);
  });
});

/** A sweep with somewhere to deploy, a deploy bot, and pull request #145 at the tip of main. */
const ready = {
  testingUrl: 'https://testing.example',
  deployBot: 'harbor',
  newest: { openadlc: 145 } as Record<string, number | null>,
  priorDeploys: [] as { subjectRef: string; state: TaskState; exitReason?: string | null; nothing?: string | null }[],
};

describe('the deploy sweep decides before it acts', () => {
  it('says so when nothing merged is waiting', () => {
    const plan = planDeploySweep({ ...ready, waiting: [], testingUrl: '' });
    expect(deploySweepRefusal(plan)).toBe('nothing merged is waiting on a testing deploy');
  });

  it('does not deploy when this install has no testing target, and says the same thing twice', () => {
    const input = { ...ready, waiting: [waiting], testingUrl: '' };
    const first = planDeploySweep(input);
    const second = planDeploySweep(input);
    expect(first).toEqual(second);
    expect(first.kind).toBe('no-target');
    const line = deploySweepRefusal(first);
    expect(line).toContain('OPENADLC_TESTING_URL');
    expect(line).toContain('openadlc#45');
    expect(line).not.toContain('started a testing deploy');
  });

  it('starts a deploy once per pull request, and the second look finds that task', () => {
    const first = planDeploySweep({ ...ready, waiting: [waiting] });
    expect(first).toEqual({ kind: 'work', start: { subjectRef: 'openadlc#145', repo: 'openadlc' }, hold: [] });

    const second = planDeploySweep({
      ...ready,
      waiting: [waiting],
      priorDeploys: [{ subjectRef: 'openadlc#145', state: 'running' }],
    });
    expect(second.kind).toBe('work');
    if (second.kind !== 'work') return;
    expect(second.start).toBeNull();
    expect(second.hold).toEqual(['openadlc#145: a testing deploy was already started (running)']);
  });

  it('says a deploy that deployed nothing did so, and why, rather than that it is still running', () => {
    // OpenADLC#72's run finished skipped, and every sweep after said "a
    // testing deploy was already started (running)".
    const plan = planDeploySweep({
      ...ready,
      waiting: [waiting],
      priorDeploys: [{ subjectRef: 'openadlc#145', state: 'running', nothing: 'deploy-testing run 9 was skipped' }],
    });
    expect(plan.kind).toBe('work');
    if (plan.kind !== 'work') return;
    expect(plan.start).toBeNull();
    expect(plan.hold).toEqual([
      'openadlc#145: its testing deploy deployed nothing (deploy-testing run 9 was skipped), so its lease was let go; it stays in Ship until a later deploy carries it or a person moves it to Done',
    ]);
  });

  it('tries again after a deploy that never ran', () => {
    // When hostd refuses, the task is saved as failed. Counting that as "a
    // deploy was started" meant every later firing said so, forever, about a
    // pull request that never reached testing — the case a backstop is for.
    const plan = planDeploySweep({
      ...ready,
      waiting: [waiting],
      priorDeploys: [
        { subjectRef: 'openadlc#145', state: 'failed', exitReason: 'hostd refused: harbor is busy' },
        { subjectRef: 'openadlc#145', state: 'stopped' },
      ],
    });
    expect(plan).toEqual({
      kind: 'work',
      start: {
        subjectRef: 'openadlc#145',
        repo: 'openadlc',
        retry: `its last testing deploy failed: hostd refused: harbor is busy; attempt 3 of ${MAX_DEPLOY_ATTEMPTS}`,
      },
      hold: [],
    });
  });

  it('tries again after a deploy whose session went away, and says it was interrupted', () => {
    const plan = planDeploySweep({
      ...ready,
      waiting: [waiting],
      priorDeploys: [
        { subjectRef: 'openadlc#145', state: 'stopped', exitReason: 'the session was killed; the branch and the issue are untouched' },
      ],
    });
    expect(plan.kind === 'work' && plan.start).toEqual({
      subjectRef: 'openadlc#145',
      repo: 'openadlc',
      retry: `its last testing deploy was interrupted: the session was killed; the branch and the issue are untouched; attempt 2 of ${MAX_DEPLOY_ATTEMPTS}`,
    });
  });

  it('does not start again a deploy a person stopped, and says so', () => {
    // It used to: `stopped` was all the row said, and the sweep read it as a
    // deploy that never happened, within half an hour of a person stopping it.
    const plan = planDeploySweep({
      ...ready,
      waiting: [waiting],
      priorDeploys: [
        { subjectRef: 'openadlc#145', state: 'stopped', exitReason: 'stopped by a person (janedoe): its session was killed' },
        { subjectRef: 'openadlc#145', state: 'failed' },
      ],
    });
    expect(plan.kind).toBe('work');
    if (plan.kind !== 'work') return;
    expect(plan.start).toBeNull();
    expect(plan.hold).toEqual([
      'openadlc#145: its last testing deploy was stopped on purpose (stopped by a person (janedoe): its session was killed); not starting another until a person does',
    ]);
  });

  it('does not start again a deploy whose plan change a person refused', () => {
    const plan = planDeploySweep({
      ...ready,
      waiting: [waiting],
      priorDeploys: [{ subjectRef: 'openadlc#145', state: 'stopped', exitReason: 'plan change refused by janedoe' }],
    });
    expect(plan.kind === 'work' && plan.start).toBeNull();
  });

  it('tries again once a person’s own retry of a stopped deploy failed: the newest deploy decides', () => {
    const plan = planDeploySweep({
      ...ready,
      waiting: [waiting],
      priorDeploys: [
        { subjectRef: 'openadlc#145', state: 'failed', exitReason: 'the workflow failed' },
        { subjectRef: 'openadlc#145', state: 'stopped', exitReason: 'stopped by a person (janedoe): its session was killed' },
      ],
    });
    expect(plan.kind === 'work' && plan.start && plan.start.subjectRef).toBe('openadlc#145');
  });

  it('does not repeat a deploy that finished, even though testing never labelled it', () => {
    // A finished deploy that left no label is a person's question, not another
    // task: the next one would finish the same way.
    const plan = planDeploySweep({
      ...ready,
      waiting: [waiting],
      priorDeploys: [
        { subjectRef: 'openadlc#145', state: 'failed' },
        { subjectRef: 'openadlc#145', state: 'done' },
      ],
    });
    expect(plan.kind === 'work' && plan.start).toBeNull();
  });

  it('stops trying a deploy that keeps failing, and says so', () => {
    // Otherwise a broken deploy path spends the per-task cap on every firing.
    const plan = planDeploySweep({
      ...ready,
      waiting: [waiting],
      priorDeploys: Array.from({ length: MAX_DEPLOY_ATTEMPTS }, () => ({
        subjectRef: 'openadlc#145',
        state: 'failed' as const,
      })),
    });
    expect(plan.kind).toBe('work');
    if (plan.kind !== 'work') return;
    expect(plan.start).toBeNull();
    expect(plan.hold).toEqual([
      `openadlc#145: ${MAX_DEPLOY_ATTEMPTS} testing deploys failed or were interrupted; not trying again until a person looks`,
    ]);
  });

  it('does not invent a pull request for an issue that has none recorded', () => {
    const plan = planDeploySweep({ ...ready, waiting: [{ repo: 'openadlc', number: 45, prNumber: null }] });
    expect(plan.kind).toBe('work');
    if (plan.kind !== 'work') return;
    expect(plan.start).toBeNull();
    expect(plan.hold[0]).toContain('no pull request recorded');
  });

  it('names the missing deploy bot rather than starting a task as nobody', () => {
    const plan = planDeploySweep({ ...ready, waiting: [waiting], deployBot: null });
    expect(deploySweepRefusal(plan)).toContain('no bot has the deploy role');
  });
});

describe('the deploy sweep only moves testing forward', () => {
  /** Seventeen merges that never got the label, the newest of them at the tip of main. */
  const backlog: AwaitingDeploy[] = Array.from({ length: 17 }, (_, index) => ({
    repo: 'openadlc',
    number: 29 + index,
    prNumber: 129 + index,
  }));

  it('deploys the newest merge once, not every merge that is waiting', () => {
    // Setting OPENADLC_TESTING_URL used to start one deploy per historic merge,
    // one a firing, each spending up to the per-task cap.
    const plan = planDeploySweep({ ...ready, waiting: backlog });
    expect(plan.kind).toBe('work');
    if (plan.kind !== 'work') return;
    expect(plan.start).toEqual({ subjectRef: 'openadlc#145', repo: 'openadlc' });
    expect(plan.hold).toHaveLength(1);
    expect(plan.hold[0]).toContain('openadlc#129');
    expect(plan.hold[0]).toContain('older than openadlc#145, the newest merge');
  });

  it('does not deploy an older merge once the newest is on testing', () => {
    // The bridge labels only the pull request the deployed commit came from,
    // so the older ones are still waiting after the newest is live. The newest
    // of *those* is older than testing, and deploying its merge commit would
    // put testing back on a revision without #145 in it.
    const plan = planDeploySweep({ ...ready, waiting: backlog.slice(0, 16) });
    expect(plan.kind).toBe('work');
    if (plan.kind !== 'work') return;
    expect(plan.start).toBeNull();
    expect(plan.hold).toEqual([expect.stringContaining('older than openadlc#145, the newest merge')]);
  });

  it('deploys nothing when it cannot tell which merge is newest', () => {
    // No account to ask GitHub with, or GitHub did not answer. Any pick is a
    // guess, and a wrong guess moves testing backwards.
    const plan = planDeploySweep({ ...ready, waiting: backlog, newest: {} });
    expect(plan.kind === 'work' && plan.start).toBeNull();
    expect(plan.kind === 'work' && plan.hold[0]).toContain('cannot tell which merge is newest on openadlc');
  });

  it('starts one deploy a firing, however many repositories have one waiting', () => {
    // One deploy bot runs one task; a second start would only be refused as busy.
    const plan = planDeploySweep({
      ...ready,
      waiting: [waiting, { repo: 'console', number: 7, prNumber: 12 }],
      newest: { openadlc: 145, console: 12 },
    });
    expect(plan.kind).toBe('work');
    if (plan.kind !== 'work') return;
    expect(plan.start).toEqual({ subjectRef: 'openadlc#145', repo: 'openadlc' });
    expect(plan.hold).toEqual(['console#12: next, after the deploy this firing started']);
  });
});

/**
 * GitHub, as far as a deploy sweep asks it: main is at the merge of #145, and
 * — unless a test says otherwise — a `deploy-testing` workflow exists. Without
 * that, automatic would treat the repository as shipping by merging and move
 * the waiting issues to Done instead of deploying them.
 */
const github = {
  workflows: [{ name: 'deploy-testing', path: '.github/workflows/deploy-testing.yml' }] as { name: string; path: string }[] | null,
  asked: [] as string[],
  request: async (_method: string, path: string) => {
    github.asked.push(path);
    if (path.includes('/actions/workflows')) {
      if (!github.workflows) throw new Error('502');
      return { workflows: github.workflows };
    }
    return { object: { sha: 'f00dcafe' } };
  },
  listPullsForCommit: async () => [{ number: 145, headRef: 'issue-45' }],
};

/** A scheduler with only what a deploy sweep reaches; the rest is never called. */
function sweeper(open = vi.fn(async (_input: unknown) => ({ taskId: 'task-1', session: 'harbor-1' }))) {
  const moves: { repoName: string; issueNumber: number; to: string }[] = [];
  const scheduler = new Scheduler(
    { testingUrl: 'https://testing.example', automationBot: 'flow' } as never,
    {} as never,
    {
      actors: { asBot: async () => github },
      moveStage: async (input: { repoName: string; issueNumber: number; to: string }) => {
        moves.push(input);
        return { moved: true };
      },
    } as never,
    {} as never,
    {} as never,
    {} as never,
    { open } as never,
  );
  return { scheduler, open, moves };
}

describe('a whole deploy sweep', () => {
  beforeEach(() => {
    store.issues = [merged];
    store.bots = [{ id: 'bot-harbor', name: 'harbor', role: 'deploy' }];
  });

  it('finds an earlier deploy however many tasks have run since', async () => {
    // It used to read the deploy bot's newest thousand tasks, so a pull request
    // deployed before those looked as if it never had been.
    store.recentTasks = Array.from({ length: 1000 }, (_, index) => ({
      kind: 'qa',
      subjectRef: `openadlc#${index}`,
      state: 'done',
    }));
    store.deployTasks = [{ subjectRef: 'openadlc#145', state: 'done' }];
    const { scheduler, open } = sweeper();

    const result = await scheduler.run('deploy');
    expect(open).not.toHaveBeenCalled();
    expect(result.actions).toEqual(['openadlc#145: a testing deploy was already started (done)']);
  });

  it('leaves a deploy a person stopped, and starts one whose session went away again, saying which', async () => {
    store.deployTasks = [{ subjectRef: 'openadlc#145', state: 'stopped', exitReason: 'stopped by a person (janedoe): its session was killed' }];
    const stopped = sweeper();
    expect((await stopped.scheduler.run('deploy')).actions).toEqual([
      'openadlc#145: its last testing deploy was stopped on purpose (stopped by a person (janedoe): its session was killed); not starting another until a person does',
    ]);
    expect(stopped.open).not.toHaveBeenCalled();

    store.deployTasks = [{ subjectRef: 'openadlc#145', state: 'stopped', exitReason: 'hostd shutting down' }];
    const interrupted = sweeper();
    const result = await interrupted.scheduler.run('deploy');
    expect(interrupted.open).toHaveBeenCalledTimes(1);
    expect(result.actions.at(-1)).toMatch(/: its last testing deploy was interrupted: hostd shutting down; attempt 2 of 3$/);
  });

  it('asks the tip of main which merge is newest, and deploys only that one', async () => {
    store.issues = [143, 144, 145].map((prNumber) => ({ ...merged, number: prNumber - 100, prNumber }));
    const { scheduler, open } = sweeper();

    const result = await scheduler.run('deploy');
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]?.[0]).toMatchObject({ kind: 'deploy', subjectRef: 'openadlc#145' });
    expect(result.actions[0]).toBe(
      'openadlc#143, openadlc#144: older than openadlc#145, the newest merge, whose deploy carries them',
    );
  });

  it('starts one deploy when two firings overlap', async () => {
    // The timer and a hand-fired curl, or a run slower than its interval: both
    // read the task log before either deploy task exists.
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { scheduler, open } = sweeper(
      vi.fn(async (input: unknown) => {
        await gate;
        store.deployTasks.push({ subjectRef: (input as { subjectRef: string }).subjectRef, state: 'running' });
        return { taskId: 'task-1', session: 'harbor-1' };
      }),
    );

    const first = scheduler.run('deploy');
    const second = scheduler.run('deploy');
    await vi.waitFor(() => expect(open).toHaveBeenCalled());
    release();
    const [one, two] = await Promise.all([first, second]);

    expect(open).toHaveBeenCalledTimes(1);
    expect(two).toEqual(one);

    // Once it has finished, the next firing is a run of its own, and finds the task.
    const third = await scheduler.run('deploy');
    expect(third.actions).toEqual(['openadlc#145: a testing deploy was already started (running)']);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('moves an issue in Ship to Done when the repository has no testing deploy, and starts nothing', async () => {
    // Set, not inferred: the workflow file is still there. A closed issue sits
    // in Ship the same way — the sweep reads the stage, which stays merged
    // until this move.
    store.testingDeploy = JSON.stringify({ openadlc: 'none' });
    const { scheduler, open, moves } = sweeper();

    const result = await scheduler.run('deploy');

    expect(open).not.toHaveBeenCalled();
    expect(moves).toEqual([{ repoName: 'openadlc', issueNumber: 45, to: 'done', actor: 'bridge' }]);
    expect(result.actions).toEqual([
      'openadlc#45 moved to Done: no testing deploy for this repository',
      'nothing merged is waiting on a testing deploy',
    ]);
    expect(github.asked.some((path) => path.includes('/actions/workflows'))).toBe(false);
  });

  it('moves an issue that already reached testing to Done once the repository has no testing deploy', async () => {
    // No promote is coming for it either.
    store.testingDeploy = JSON.stringify({ openadlc: 'none' });
    store.issues = [{ ...merged, labels: [...merged.labels, 'deployed:testing'] }];
    const { scheduler, open, moves } = sweeper();

    const result = await scheduler.run('deploy');

    expect(open).not.toHaveBeenCalled();
    expect(moves).toEqual([{ repoName: 'openadlc', issueNumber: 45, to: 'done', actor: 'bridge' }]);
    expect(result.actions[0]).toBe('openadlc#45 moved to Done: no testing deploy for this repository');
  });

  it('still deploys when settings say there is a testing deploy, without asking which workflows exist', async () => {
    store.testingDeploy = JSON.stringify({ openadlc: 'has' });
    github.workflows = [];
    const { scheduler, open } = sweeper();

    await scheduler.run('deploy');

    expect(open).toHaveBeenCalledTimes(1);
    expect(github.asked.some((path) => path.includes('/actions/workflows'))).toBe(false);
  });

  it('moves to Done on automatic when no deploy workflow exists, and deploys when GitHub cannot say', async () => {
    github.workflows = [];
    const moved = sweeper();
    const result = await moved.scheduler.run('deploy');
    expect(moved.open).not.toHaveBeenCalled();
    expect(result.actions[0]).toBe('openadlc#45 moved to Done: no testing deploy for this repository');
    expect(github.asked.some((path) => path.includes('/actions/workflows'))).toBe(true);

    github.workflows = null;
    github.asked = [];
    const unknown = sweeper();
    const again = await unknown.scheduler.run('deploy');
    expect(unknown.open).toHaveBeenCalledTimes(1);
    expect(again.actions.some((line) => line.startsWith('openadlc#45 moved to Done'))).toBe(false);
  });

  it('dispatches again a promote or rollback whose dispatch failed', async () => {
    // A promote with no soak the bridge held, and every rollback, were never
    // tried again: the comment said the sweep would, and nothing did.
    store.issues = [];
    const { scheduler } = sweeper();
    const pipeline = {
      checkTestingDeploys: vi.fn(async () => []),
      checkRollbacks: vi.fn(async () => []),
      promoteDue: vi.fn(async () => []),
      sendBackDue: vi.fn(async () => []),
      retryUndispatched: vi.fn(async () => ['openadlc@abc1234: dispatched promote-production']),
    };
    scheduler.useDelivery(pipeline as never, { get: vi.fn() } as never);

    const result = await scheduler.run('deploy');

    expect(pipeline.retryUndispatched).toHaveBeenCalledTimes(1);
    expect(result.actions).toContain('openadlc@abc1234: dispatched promote-production');
  });

  it('settles each dispatched testing deploy first, and says of one that deployed nothing what its record says', async () => {
    const { scheduler, moves } = sweeper();
    const pipeline = {
      checkTestingDeploys: vi.fn(async () => ['app@f00dcaf: no run of deploy-testing appeared within 10 minutes of its dispatch; released the lease on #45']),
      checkRollbacks: vi.fn(async () => []),
      promoteDue: vi.fn(async () => []),
      sendBackDue: vi.fn(async () => []),
      retryUndispatched: vi.fn(async () => []),
    };
    const why = 'no run of deploy-testing appeared within 10 minutes of its dispatch';
    store.deployRuns = [{ sha: 'f00dcafe', prNumber: 145, testingDispatchedAt: '2026-10-22T16:57:00.000Z', testingConclusion: 'not_started', detail: why }];
    scheduler.useDelivery(pipeline as never, { get: vi.fn(async () => ({ rules: DEFAULT_DELIVERY_RULES, readError: null })) } as never);

    const result = await scheduler.run('deploy');

    expect(result.actions[0]).toBe(`app@f00dcaf: ${why}; released the lease on #45`);
    expect(result.actions).toContain(
      `openadlc#145: its testing deploy deployed nothing (${why}), so its lease was let go; it stays in Ship until a later deploy carries it or a person moves it to Done`,
    );
    expect(result.actions.some((line) => line.includes('already started'))).toBe(false);
    // Never started is not nothing to deploy: the repository does deploy.
    expect(moves).toEqual([]);
  });

  /**
   * 620legal/OpenADLC's deploy-testing skips every run, and seven cards sat in
   * Ship with their testing deploys settled as skipped: #84 let their leases
   * go and moved nothing, so no later sweep did either.
   */
  it('moves to Done an issue whose testing deploy already settled as having nothing to deploy, with why', async () => {
    const { scheduler, moves, open } = sweeper();
    const pipeline = {
      checkTestingDeploys: vi.fn(async () => []),
      checkRollbacks: vi.fn(async () => []),
      promoteDue: vi.fn(async () => []),
      sendBackDue: vi.fn(async () => []),
      retryUndispatched: vi.fn(async () => []),
    };
    store.deployRuns = [{ sha: 'fe6b790c', prNumber: 145, testingDispatchedAt: '2026-10-22T09:00:00.000Z', testingConclusion: 'skipped', detail: 'deploy-testing run 39836758586 was skipped' }];
    scheduler.useDelivery(pipeline as never, { get: vi.fn(async () => ({ rules: DEFAULT_DELIVERY_RULES, readError: null })) } as never);

    const result = await scheduler.run('deploy');

    expect(moves).toEqual([
      { repoName: 'openadlc', issueNumber: 45, to: 'done', actor: 'bridge', reason: 'merging shipped it: deploy-testing run 39836758586 was skipped', prNumber: 145 },
    ]);
    expect(result.actions).toEqual([
      'openadlc#45 moved to Done: merging shipped it, since its testing deploy had nothing to deploy (deploy-testing run 39836758586 was skipped)',
      'nothing merged is waiting on a testing deploy',
    ]);
    expect(store.said).toEqual([expect.stringContaining('Moved to Done: merging shipped it. Its testing deploy had nothing to deploy (deploy-testing run 39836758586 was skipped)')]);
    expect(store.audits).toContainEqual(expect.objectContaining({ action: 'deploy.shipped_by_merging', target: 'openadlc#45' }));
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    ['still running', null],
    ['failed', 'failure'],
    ['cancelled with no later deploy to carry it', 'cancelled'],
    ['re-run and deployed after a skip', 'success'],
  ])('keeps in Ship an issue whose testing deploy is %s', async (_name, conclusion) => {
    const { scheduler, moves } = sweeper();
    const pipeline = {
      checkTestingDeploys: vi.fn(async () => []),
      checkRollbacks: vi.fn(async () => []),
      promoteDue: vi.fn(async () => []),
      sendBackDue: vi.fn(async () => []),
      retryUndispatched: vi.fn(async () => []),
    };
    store.deployRuns = [{ sha: 'fe6b790c', prNumber: 145, testingDispatchedAt: '2026-10-22T09:00:00.000Z', testingConclusion: conclusion, detail: null }];
    scheduler.useDelivery(pipeline as never, { get: vi.fn(async () => ({ rules: DEFAULT_DELIVERY_RULES, readError: null })) } as never);

    const result = await scheduler.run('deploy');

    expect(moves).toEqual([]);
    expect(result.actions.some((line) => line.includes('moved to Done'))).toBe(false);
  });

  it('looks at each dispatched rollback’s run before it promotes or dispatches again', async () => {
    // A rollback was dispatched and never looked at again: one cancelled
    // behind a promote, or never started, left production broken.
    store.issues = [];
    const { scheduler } = sweeper();
    const order: string[] = [];
    const pipeline = {
      checkTestingDeploys: vi.fn(async () => (order.push('testing'), [])),
      checkRollbacks: vi.fn(async () => (order.push('check'), ['openadlc@abc1234: production was rolled back (rollback-production run 91)'])),
      promoteDue: vi.fn(async () => (order.push('promote'), [])),
      sendBackDue: vi.fn(async () => []),
      retryUndispatched: vi.fn(async () => (order.push('retry'), [])),
    };
    scheduler.useDelivery(pipeline as never, { get: vi.fn() } as never);

    const result = await scheduler.run('deploy');

    expect(order).toEqual(['testing', 'check', 'promote', 'retry']);
    expect(result.actions).toContain('openadlc@abc1234: production was rolled back (rollback-production run 91)');
  });
});

describe('a testing deploy the sweep could not dispatch', () => {
  it('says which cause it was, and the command when it is the automation account', async () => {
    const scheduler = new Scheduler(
      { automationBot: 'flow' } as never,
      {} as never,
      { actors: { asBot: async () => null } } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    scheduler.useDelivery({} as never, { get: vi.fn() } as never);
    const dispatch = (subjectRef: string) =>
      (scheduler as unknown as { dispatchTesting(repo: string, subjectRef: string): Promise<string> }).dispatchTesting('openadlc', subjectRef);

    expect(await dispatch('openadlc#145')).toMatch(
      /^openadlc#145: no testing deploy was dispatched, because \S+ is not connected to GitHub\. Run: openadlc auth login --bot \S+$/,
    );
    expect(await dispatch('openadlc')).toBe('openadlc: no testing deploy was dispatched, because it names no pull request');
  });
});

describe('what a job run leaves in the event log', () => {
  it('records how many lines a job said, not the lines themselves', async () => {
    // Most jobs say the same few lines on every firing, reconcile every quarter
    // hour. The event says the job ran; what it said is in the bridge's log.
    const lines = Array.from({ length: 50 }, (_, index) => `openadlc#${index} is sitting in Spec with nobody on it`);
    const scheduler = new Scheduler(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { sweep: async () => lines } as never,
      {} as never,
      {} as never,
    );

    await scheduler.run('stages');
    expect(store.events).toEqual([{ source: 'schedule', type: 'job.stages', payload: { actions: 50 } }]);
  });

  it('keeps what the deploy sweep decided, within a bound', async () => {
    store.bots = [{ id: 'bot-harbor', name: 'harbor', role: 'deploy' }];
    store.issues = Array.from({ length: 40 }, (_, index) => ({ ...merged, number: index + 1, prNumber: null }));
    const { scheduler } = sweeper();

    const result = await scheduler.run('deploy');
    expect(result.actions).toHaveLength(40);
    expect(store.events).toEqual([
      { source: 'schedule', type: 'job.deploy', payload: { actions: 40, detail: result.actions.slice(0, 20) } },
    ]);
  });
});

describe('an issue a job files once', () => {
  const MARKER = '<!-- openadlc:job:dependency-update -->';
  function filer(pages: (page: number) => { number: number; body: string; user: { login: string } }[] | Error) {
    const requests: string[] = [];
    const posted: { title: string; body: string; labels: string[] }[] = [];
    const github = {
      viewer: async () => ({ login: 'openadlc-flow-janedoe', id: 1 }),
      request: vi.fn(async (method: string, path: string, body?: { title: string; body: string; labels: string[] }) => {
        requests.push(`${method} ${path}`);
        if (body) posted.push(body);
        if (method === 'POST') return { number: 900 };
        const answer = pages(Number(new URL(path, 'https://api.github.com').searchParams.get('page')));
        if (answer instanceof Error) throw answer;
        return answer;
      }),
    };
    const scheduler = new Scheduler(
      { automationBot: 'flow' } as never,
      {} as never,
      { actors: { asBot: async () => github } } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    store.repos = [{ name: 'testbed', fullName: 'janedoe/testbed' }];
    return { scheduler, requests, posted };
  }
  const issue = (number: number, login: string, body = '') => ({ number, body, user: { login } });

  it('files the dependency update into intake, which shapes it for Build, not into Build where nothing routes it', async () => {
    const { scheduler, requests, posted } = filer(() => []);

    expect((await scheduler.run('deps')).actions).toEqual(['Weekly dependency update: filed as #900']);
    expect(requests).toContain('POST /repos/janedoe/testbed/issues');
    expect(posted[0]?.labels).toEqual(['deps', 'adlc:intake', 'do:ai', 'priority:p3']);
    expect(posted[0]?.labels).not.toContain('adlc:build');
    const lines = posted[0]?.body.split('\n') ?? [];
    expect(lines[0]).toContain('janedoe/testbed');
    expect(lines[0]).toContain('manifests and lockfiles');
    expect(posted[0]?.body).toContain('Acceptance: `make ci` green, no major version taken without a note on why.');
    expect(lines.at(-1)).toBe(MARKER);
  });

  it('files the dependency update once while it is open', async () => {
    const { scheduler, posted } = filer(() => [issue(41, 'openadlc-flow-janedoe', `shaped by triage\n\n${MARKER}`)]);

    expect((await scheduler.run('deps')).actions).toEqual(['Weekly dependency update: already open as #41']);
    expect(posted).toEqual([]);
  });

  it('finds its own issue past the first page, and lists only what the automation account opened', async () => {
    const { scheduler, requests } = filer((page) =>
      page === 1 ? Array.from({ length: 100 }, (_, index) => issue(index + 1, 'openadlc-flow-janedoe')) : [issue(150, 'openadlc-flow-janedoe', `update\n\n${MARKER}`)],
    );

    const result = await scheduler.run('deps');

    expect(result.actions).toEqual(['Weekly dependency update: already open as #150']);
    expect(requests[0]).toContain('creator=openadlc-flow-janedoe');
    expect(requests.some((one) => one.startsWith('POST'))).toBe(false);
  });

  it('does not take a stranger’s issue carrying the marker as its own', async () => {
    const { scheduler } = filer(() => [issue(5, 'stranger', MARKER)]);

    expect((await scheduler.run('deps')).actions).toEqual(['Weekly dependency update: filed as #900']);
  });

  it('says what GitHub said when it refuses the issue', async () => {
    const { GitHubApiError } = await import('@openadlc/github');
    const refusing = new Scheduler(
      { automationBot: 'flow' } as never,
      {} as never,
      {
        actors: {
          asBot: async () => ({
            viewer: async () => ({ login: 'openadlc-flow-janedoe', id: 1 }),
            request: vi.fn(async (method: string, path: string) => {
              if (method === 'POST') throw new GitHubApiError(422, path, '{"message":"Validation Failed"}');
              return [];
            }),
          }),
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    store.repos = [{ name: 'testbed', fullName: 'janedoe/testbed' }];

    expect((await refusing.run('deps')).actions).toEqual([
      'Weekly dependency update: could not be filed in janedoe/testbed: /repos/janedoe/testbed/issues → 422: {"message":"Validation Failed"}',
    ]);
  });

  it('names the account to connect when there is none to file with', async () => {
    const scheduler = new Scheduler(
      { automationBot: 'flow' } as never,
      {} as never,
      { actors: { asBot: async () => null } } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    store.repos = [{ name: 'testbed', fullName: 'janedoe/testbed' }];

    const [line] = (await scheduler.run('deps')).actions;
    expect(line).toMatch(/^would file "Weekly dependency update" \(\S+ is not connected to GitHub\. Run: openadlc auth login --bot \S+\)$/);
  });

  it('files nothing when the open issues could not be read', async () => {
    const { scheduler, requests } = filer(() => new Error('GitHub did not answer'));

    expect((await scheduler.run('deps')).actions).toEqual([
      'Weekly dependency update: not filed, because the open issues of janedoe/testbed could not be read',
    ]);
    expect(requests.some((one) => one.startsWith('POST'))).toBe(false);
  });
});

/** A scheduler with only what the nightly QA job reaches. */
function nightly(
  testingUrl: string,
  open = vi.fn(async (_input: unknown): Promise<{ taskId: string; session: string | null; error?: string }> => ({
    taskId: 'task-qa',
    session: 'vega-1',
  })),
) {
  const scheduler = new Scheduler(
    { testingUrl } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { open } as never,
  );
  return { scheduler, open };
}

/**
 * The nightly QA job. A production promote opens the same task through the
 * same two functions, so what this says is also what the person about to
 * approve a promote is told.
 */
describe('the nightly QA job', () => {
  beforeEach(() => {
    store.bots = [{ id: 'bot-vega', name: 'vega', role: 'qa' }];
    store.repos = [{ name: 'openadlc', fullName: 'janedoe/openadlc' }];
  });

  it('opens a QA run per repository on its testing thread', async () => {
    const { scheduler, open } = nightly('https://testing.example');

    const result = await scheduler.run('qa');
    expect(open.mock.calls[0]?.[0]).toMatchObject({ bot: 'vega', kind: 'qa', skill: 'qa', subjectRef: 'openadlc#testing' });
    expect(result.actions).toEqual(['opened a QA run on openadlc#testing against https://testing.example (task task-qa)']);
  });

  it('refuses without a testing environment, in the words a promote repeats', async () => {
    const { scheduler, open } = nightly('');

    const result = await scheduler.run('qa');
    expect(open).not.toHaveBeenCalled();
    expect(result.actions).toEqual(["no testing environment is configured: set testing.url in the repository's .github/openadlc.yml (OPENADLC_TESTING_URL is the deprecated fallback); not opening a QA task"]);
  });

  it('does not say it opened a QA run that hostd refused', async () => {
    // The task is saved as failed and nothing runs. "Opened" here is what a
    // promote would have passed on to the person deciding whether to approve.
    const { scheduler } = nightly(
      'https://testing.example',
      vi.fn(async () => ({ taskId: 'task-qa', session: null, error: 'hostd refused: no image for vega' })),
    );

    const result = await scheduler.run('qa');
    expect(result.actions).toEqual(['openadlc#testing: hostd refused: no image for vega']);
  });
});

describe('the weekly engine update’s clock', () => {
  it('is a scheduled job that looks every five minutes, so a machine that slept through the hour catches up', () => {
    expect(SCHEDULED_JOBS).toContain('engines');
    expect(DEFAULT_INTERVALS.engines).toBe(5);
  });

  it('asks the engine update whether this week’s run is owed, and reports what it said', async () => {
    const tick = vi.fn(async () => ["this week's engine update: current — every engine is already the newest version"]);
    const scheduler = new Scheduler(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      null,
      { tick },
    );

    const result = await scheduler.run('engines');

    expect(tick).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      job: 'engines',
      actions: ["this week's engine update: current — every engine is already the newest version"],
    });
    expect(store.events).toEqual([{ source: 'schedule', type: 'job.engines', payload: { actions: 1 } }]);
  });
});

describe('OpenADLC’s own update’s clock', () => {
  it('is a scheduled job that looks every five minutes, as the engines’ does', () => {
    expect(SCHEDULED_JOBS).toContain('releases');
    expect(DEFAULT_INTERVALS.releases).toBe(5);
  });

  it('asks self-update whether this week’s run is owed, and says when it is not wired', async () => {
    const scheduler = new Scheduler({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    expect((await scheduler.run('releases')).actions).toEqual(['OpenADLC’s own update is not wired into this bridge']);

    const tick = vi.fn(async () => ['the next OpenADLC update is at 2026-10-25T18:00:00.000Z']);
    scheduler.useSelfUpdate({ tick });
    expect(await scheduler.run('releases')).toEqual({ job: 'releases', actions: ['the next OpenADLC update is at 2026-10-25T18:00:00.000Z'] });
    expect(tick).toHaveBeenCalledTimes(1);
  });
});

describe('uploads nobody sent with anything', () => {
  it('are swept hourly once they are a day old, and the sweep says how many', async () => {
    // A dialog closed half-way leaves its files behind, their bytes in the database.
    expect(SCHEDULED_JOBS).toContain('attachments');
    expect(DEFAULT_INTERVALS.attachments).toBe(60);
    store.swept = [];
    const scheduler = new Scheduler({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, null);
    const before = Date.now();
    const result = await scheduler.run('attachments');
    expect(result).toEqual({ job: 'attachments', actions: ['removed 2 uploads nobody sent with anything within a day'] });
    const cutoff = store.swept[0]!.getTime();
    expect(before - cutoff).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 1000);
    expect(before - cutoff).toBeLessThan(24 * 60 * 60 * 1000 + 5000);
  });
});

describe('old GitHub deliveries', () => {
  it('are pruned daily past the retention days, and the job says how many', async () => {
    // Nothing deleted from events, so every delivery's payload stayed for good.
    expect(SCHEDULED_JOBS).toContain('events');
    expect(DEFAULT_INTERVALS.events).toBe(24 * 60);
    store.pruned = [];
    const scheduler = new Scheduler({ eventRetentionDays: 30 } as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, null);
    const before = Date.now();
    const result = await scheduler.run('events');
    expect(result).toEqual({ job: 'events', actions: ['removed 1234 GitHub deliveries older than 30 days'] });
    const age = before - store.pruned[0]!.getTime();
    expect(age).toBeGreaterThanOrEqual(30 * 24 * 60 * 60 * 1000 - 1000);
    expect(age).toBeLessThan(30 * 24 * 60 * 60 * 1000 + 5000);
  });

  it('are kept for good at 0 days', async () => {
    store.pruned = [];
    const scheduler = new Scheduler({ eventRetentionDays: 0 } as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, null);
    const result = await scheduler.run('events');
    expect(result.actions).toEqual(['GitHub deliveries are kept for good (OPENADLC_EVENT_RETENTION_DAYS=0)']);
    expect(store.pruned).toEqual([]);
  });
});

describe('reconciling', () => {
  it('lets the crew into every repository as well, and says what changed', async () => {
    const ensureAll = vi.fn(async () => ['openadlc-atlas-janedoe can work in acme/web']);
    const scheduler = new Scheduler(
      {} as never,
      {} as never,
      {} as never,
      { run: async () => [] } as never,
      {} as never,
      {} as never,
      {} as never,
      null,
      null,
      { ensureAll },
    );

    const result = await scheduler.run('reconcile');

    expect(ensureAll).toHaveBeenCalledWith('reconcile');
    expect(result.actions).toEqual(['nothing has drifted: the board matches GitHub', 'openadlc-atlas-janedoe can work in acme/web']);
  });

  it('says which repository’s lease it expired, and that it expired rather than was released', async () => {
    const { leases } = await import('@openadlc/db');
    vi.mocked(leases.expireStaleLeases).mockResolvedValueOnce([{ repoId: 'repo-9', issueNumber: 12 }] as never);
    store.repos = [{ id: 'repo-9', name: 'widgets' }];
    const leasesReleased = vi.fn(async (_why: string) => undefined);
    const scheduler = new Scheduler({} as never, {} as never, {} as never, { run: async () => [], leasesReleased } as never, {} as never, {} as never, {} as never, null);

    const result = await scheduler.run('reconcile');

    expect(result.actions).toContain('expired the lease on widgets#12: it ran out with no pull request');
    // The plan changes held on its paths are tried again, as for a lease let go:
    // #27's stayed held after #71's lease was gone, until a person approved it again.
    expect(leasesReleased).toHaveBeenCalledWith('1 lease ran out');
  });

  it('looks at no held plan change when no lease ran out', async () => {
    const leasesReleased = vi.fn(async (_why: string) => undefined);
    const scheduler = new Scheduler({} as never, {} as never, {} as never, { run: async () => [], leasesReleased } as never, {} as never, {} as never, {} as never, null);

    await scheduler.run('reconcile');

    expect(leasesReleased).not.toHaveBeenCalled();
  });

  it('keeps each repository’s default branch in step with GitHub, and says only what it changed', async () => {
    const sync = vi.fn(async () => ['acme/legacy: its default branch is master on GitHub, not main; corrected']);
    const scheduler = new Scheduler({} as never, {} as never, {} as never, { run: async () => [] } as never, {} as never, {} as never, {} as never, null);
    scheduler.useDefaultBranches(sync);

    const result = await scheduler.run('reconcile');

    expect(sync).toHaveBeenCalledTimes(1);
    expect(result.actions).toContain('acme/legacy: its default branch is master on GitHub, not main; corrected');
  });

  it('still reconciles when the default branches cannot be checked, and says so', async () => {
    const scheduler = new Scheduler({} as never, {} as never, {} as never, { run: async () => [] } as never, {} as never, {} as never, {} as never, null);
    scheduler.useDefaultBranches(async () => Promise.reject(new Error('the database went away')));

    const result = await scheduler.run('reconcile');

    expect(result.actions).toContain("could not check the repositories' default branches: the database went away");
  });

  it('still reconciles when the crew’s access cannot be checked, and says so', async () => {
    const scheduler = new Scheduler(
      {} as never,
      {} as never,
      {} as never,
      { run: async () => [] } as never,
      {} as never,
      {} as never,
      {} as never,
      null,
      null,
      { ensureAll: async () => Promise.reject(new Error('the database went away')) },
    );
    const result = await scheduler.run('reconcile');
    expect(result.actions).toContain("could not check the crew's access: the database went away");
  });

  // GitHub does not send a failed delivery again by itself: a gate answered
  // on GitHub while the bridge was down was lost.
  describe('and redelivering what GitHub could not deliver', () => {
    const reconciling = () => new Scheduler({} as never, {} as never, {} as never, { run: async () => [] } as never, {} as never, {} as never, {} as never, null);

    it('says how many it redelivered, reading back first to the last delivery taken, then to its own last pass', async () => {
      const scheduler = reconciling();
      const asked: number[] = [];
      scheduler.useRedelivery(async (since) => {
        asked.push(since);
        return [11, 12];
      });

      const first = await scheduler.run('reconcile');
      const startedSecond = Date.now();
      await scheduler.run('reconcile');

      expect(first.actions).toContain('redelivered 2 webhook deliveries GitHub recorded as failed');
      expect(asked[0]).toBe(Date.parse('2026-10-04T11:00:00.000Z') - 60_000);
      expect(asked[1]).toBeLessThanOrEqual(startedSecond - 60_000);
      expect(asked[1]).toBeGreaterThan(Date.parse('2026-10-04T11:00:00.000Z'));
    });

    it('says it could not, and still reconciles, when GitHub cannot be asked; the next pass reads the same stretch', async () => {
      const scheduler = reconciling();
      const asked: number[] = [];
      scheduler.useRedelivery(async (since) => {
        asked.push(since);
        throw new Error('GitHub answered 503');
      });

      const result = await scheduler.run('reconcile');
      await scheduler.run('reconcile');

      expect(result.actions).toContain('could not redeliver the webhook deliveries GitHub recorded as failed: GitHub answered 503');
      expect(result.actions).toContain('nothing has drifted: the board matches GitHub');
      expect(asked[1]).toBe(asked[0]);
    });

    it('runs a pass asked for after the hook was repointed after the one already going, rather than joining it', async () => {
      // A reconcile's pass that began before a new tunnel had GitHub send
      // what failed to the dead address; joined, what failed waited for the
      // next reconcile.
      const scheduler = reconciling();
      const passes: number[] = [];
      let release: () => void = () => undefined;
      scheduler.useRedelivery(async (since) => {
        passes.push(since);
        if (passes.length === 1) await new Promise<void>((resolve) => (release = resolve));
        return [passes.length];
      });

      const going = scheduler.redeliverFailed();
      const joined = scheduler.redeliverFailed();
      const afterRepoint = scheduler.redeliverFailed(Date.now(), { afterRepoint: true });
      await vi.waitFor(() => expect(passes).toHaveLength(1));
      release();

      await Promise.all([going, joined, afterRepoint]);
      expect(passes).toHaveLength(2);
    });

    it('says nothing without app credentials, or with nothing to redeliver', async () => {
      const scheduler = reconciling();
      scheduler.useRedelivery(async () => null);
      expect((await scheduler.run('reconcile')).actions.filter((line) => /redeliver/.test(line))).toEqual([]);

      scheduler.useRedelivery(async () => []);
      expect((await scheduler.run('reconcile')).actions.filter((line) => /redeliver/.test(line))).toEqual([]);
    });
  });
});

describe('the status issue', () => {
  const active = [
    { name: 'api', fullName: 'org/api' },
    { name: 'web', fullName: 'org/web' },
  ];
  const drifted = { run: async () => [{ subject: 'web#3', detail: 'the board says Review, GitHub says closed', repaired: false }] };

  function schedulerWith(automation: Record<string, unknown>, reconciler: unknown = { run: async () => [] }) {
    return new Scheduler({} as never, {} as never, automation as never, reconciler as never, {} as never, {} as never, {} as never, null);
  }

  beforeEach(() => {
    store.repos = active;
  });

  it('is the issue in the repository OPENADLC_STATUS_ISSUE names, whatever sorts first', async () => {
    vi.stubEnv('OPENADLC_STATUS_ISSUE', 'org/web#12');
    try {
      const updateStatusIssue = vi.fn(async () => true);
      const comment = vi.fn(async () => undefined);
      const automation = { updateStatusIssue, comment };

      const status = await schedulerWith(automation).run('status');
      expect(updateStatusIssue).toHaveBeenCalledWith('org/web', 12, expect.any(String));
      expect(status.actions).toContain('rewrote the status issue in org/web');

      await schedulerWith(automation, drifted).run('reconcile');
      expect(comment).toHaveBeenCalledWith('org/web', 12, expect.stringContaining('### Reconciliation'));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('is not written for a bare number, even on an install with one repository, and says what to set', async () => {
    vi.stubEnv('OPENADLC_STATUS_ISSUE', '7');
    try {
      for (const managed of [active, [active[1]!]]) {
        store.repos = managed;
        const updateStatusIssue = vi.fn(async () => true);
        const comment = vi.fn(async () => undefined);
        const automation = { updateStatusIssue, comment };

        const status = await schedulerWith(automation).run('status');
        expect(updateStatusIssue).not.toHaveBeenCalled();
        expect(status.actions.join('\n')).toContain('it must be <owner>/<name>#<number>');

        const reconciled = await schedulerWith(automation, drifted).run('reconcile');
        expect(comment).not.toHaveBeenCalled();
        expect(reconciled.actions.join('\n')).toContain('did not post the drift to the status issue: OPENADLC_STATUS_ISSUE is "7"; it must be');
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('gets only its own repository’s drift, and a count of the rest', async () => {
    vi.stubEnv('OPENADLC_STATUS_ISSUE', 'org/web#12');
    try {
      const comment = vi.fn(async (_repo: string, _number: number, _body: string) => undefined);
      const reconciler = {
        run: async () => [
          { subject: 'web#3', detail: 'the board says Review, GitHub says closed', repaired: false },
          { subject: 'api#41', detail: 'private-billing work', repaired: false },
          { subject: 'hostd', detail: 'host build-box-7 is gone', repaired: false },
        ],
      };
      await schedulerWith({ updateStatusIssue: vi.fn(), comment }, reconciler).run('reconcile');
      const body = comment.mock.calls[0]?.[2] ?? '';
      expect(body).toContain('web#3');
      expect(body).toContain('2 more need a person in other repositories or on the install; the console lists them');
      expect(body).not.toMatch(/api#41|private-billing|hostd|build-box-7/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('the gates of pull requests in review, worked out again', () => {
  // openadlc-testbed#2 had both reviews in and a gate held on a security review
  // a later decision no longer asked for. The gate is only worked out when
  // something happens to the pull request, and nothing more was coming.
  const BUILT = { user: { login: 'openadlc-atlas-janedoe' }, author_association: 'COLLABORATOR' };

  function sweep(options: { standing: { state: string; description: string } | null; gate: { state: 'pending' | 'success'; description: string } }) {
    store.repos = [{ id: 'repo-1', name: 'openadlc-testbed', fullName: 'janedoe/openadlc-testbed' }];
    store.issues = [
      // As the live install had it: nothing had ever recorded the pull request.
      { repoName: 'openadlc-testbed', number: 1, prNumber: null, stage: 'review', labels: ['adlc:review'] },
      { repoName: 'openadlc-testbed', number: 3, prNumber: null, stage: 'build', labels: ['adlc:build'] },
    ];
    const published: { state: string; description: string }[] = [];
    const entered: { repoName: string; prNumber: number; headSha: string }[] = [];
    const github = {
      getPullRequest: async (_repo: string, number: number) => ({
        number,
        draft: false,
        merged: false,
        state: 'open',
        headRef: 'agent/openadlc-atlas-janedoe/1-issue-1',
        headSha: 'abc123',
        baseRef: 'main',
        labels: [],
      }),
      request: async (_method: string, path: string) =>
        path.includes('/pulls?state=open')
          ? [
              { number: 2, draft: false, head: { ref: 'agent/openadlc-atlas-janedoe/1-issue-1', sha: 'abc123', repo: { full_name: 'janedoe/openadlc-testbed' } }, base: { ref: 'main' }, labels: [], ...BUILT },
              // Not an issue's branch, with no review round OpenADLC opened on it,
              // or not an issue in review: left alone.
              { number: 9, draft: false, head: { ref: 'dependabot/npm/x', sha: 'def456', repo: { full_name: 'janedoe/openadlc-testbed' } }, base: { ref: 'main' }, labels: [], ...BUILT },
              { number: 10, draft: false, head: { ref: 'agent/openadlc-atlas-janedoe/3-issue-3', sha: 'fed789', repo: { full_name: 'janedoe/openadlc-testbed' } }, base: { ref: 'main' }, labels: [], ...BUILT },
              // A stranger's fork, its branch named like the builder's: not the issue's.
              { number: 11, draft: false, head: { ref: 'agent/openadlc-atlas-janedoe/1-issue-1', sha: 'bad000', repo: { full_name: 'stranger/openadlc-testbed' } }, base: { ref: 'main' }, labels: [], user: { login: 'stranger' }, author_association: 'NONE' },
            ]
          : { statuses: options.standing ? [{ context: 'review-gate', ...options.standing }] : [] },
    };
    const scheduler = new Scheduler(
      { automationBot: 'flow' } as never,
      {} as never,
      {
        actors: { asBot: async () => github },
        reviewStanding: async () => ({ gate: options.gate, decision: { lead: 'openadlc-sydney-janedoe', reviewers: [], approvers: [] }, posted: [], approved: [], leadDue: null }),
        setReviewGate: async (input: { state: string; description: string }) => {
          published.push({ state: input.state, description: input.description });
          return { state: input.state, description: input.description };
        },
      } as never,
      {} as never,
      {} as never,
      {
        enter: async (input: { repoName: string; prNumber: number; headSha: string }) => {
          entered.push(input);
        },
      } as never,
      new TaskService({} as never, {} as never, {} as never) as never,
    );
    return { scheduler, published, entered };
  }

  it('publishes a gate that passes now, and puts the pull request in the merge line', async () => {
    const { scheduler, published, entered } = sweep({
      standing: { state: 'pending', description: 'waiting on openadlc-cipher-janedoe' },
      gate: { state: 'success', description: 'all required reviews are in' },
    });

    expect(await scheduler.settleGates()).toEqual(['openadlc-testbed#2: review gate is success (all required reviews are in)']);
    expect(published).toEqual([{ state: 'success', description: 'all required reviews are in' }]);
    expect(entered).toEqual([{ repoName: 'openadlc-testbed', prNumber: 2, headSha: 'abc123', revert: false }]);
  });

  it('finds the pull request from GitHub, and records it on the issue that had none', async () => {
    const { scheduler } = sweep({
      standing: { state: 'pending', description: 'waiting on irisexampleco' },
      gate: { state: 'pending', description: 'waiting on irisexampleco' },
    });
    const { issues } = await import('@openadlc/db');
    vi.mocked(issues.setPullRequestNumber).mockClear();

    await scheduler.settleGates();

    expect(vi.mocked(issues.setPullRequestNumber).mock.calls).toEqual([['repo-1', 1, 2]]);
  });

  it('says nothing again when the gate is what it was', async () => {
    const { scheduler, published, entered } = sweep({
      standing: { state: 'pending', description: 'waiting on irisexampleco' },
      gate: { state: 'pending', description: 'waiting on irisexampleco' },
    });

    expect(await scheduler.settleGates()).toEqual([]);
    expect(published).toEqual([]);
    expect(entered).toEqual([]);
  });

  it('goes on to the next repository when one pull request\'s gate cannot be set', async () => {
    // An organisation's repository whose app lacks 'Commit statuses: write'
    // refuses the fallback too, and that stopped the sweep for every
    // repository after it.
    store.repos = [
      { id: 'repo-1', name: 'openadlc-testbed', fullName: 'janedoe/openadlc-testbed' },
      { id: 'repo-2', name: 'api', fullName: 'exampleco/api' },
    ];
    store.issues = [{ repoName: 'openadlc-testbed', number: 1, prNumber: 2, stage: 'review', labels: [] }];
    const pullOf = (fullName: string, number: number) => ({
      number,
      draft: false,
      head: { ref: 'agent/openadlc-atlas-janedoe/1-issue-1', sha: `sha-${number}`, repo: { full_name: fullName } },
      base: { ref: 'main' },
      labels: [],
      ...BUILT,
    });
    const github = {
      request: async (_method: string, path: string) =>
        path.includes('janedoe/openadlc-testbed/pulls?state=open')
          ? [pullOf('janedoe/openadlc-testbed', 2)]
          : path.includes('exampleco/api/pulls?state=open')
            ? [pullOf('exampleco/api', 5)]
            : { statuses: [] },
    };
    const asked: string[] = [];
    const scheduler = new Scheduler(
      { automationBot: 'flow' } as never,
      {} as never,
      {
        actors: { asBot: async () => github },
        reviewStanding: async () => ({
          gate: { state: 'pending', description: 'waiting on openadlc-sydney-janedoe' },
          decision: { lead: 'openadlc-sydney-janedoe', reviewers: [], approvers: [] },
          posted: [],
          approved: [],
          leadDue: null,
        }),
        setReviewGate: async (input: { repoFullName: string; state: string; description: string }) => {
          asked.push(input.repoFullName);
          if (input.repoFullName === 'janedoe/openadlc-testbed') throw new Error('Resource not accessible by integration');
          return { state: input.state, description: input.description };
        },
      } as never,
      {} as never,
      {} as never,
      { enter: async () => undefined } as never,
      new TaskService({} as never, {} as never, {} as never) as never,
    );

    const actions = await scheduler.settleGates();

    expect(actions).toContain('openadlc-testbed#2: could not settle the review gate: Resource not accessible by integration');
    expect(asked).toEqual(['janedoe/openadlc-testbed', 'exampleco/api']);
  });
});

describe('a gate waiting on a reviewer that cannot sign in', () => {
  const BRANCH = 'agent/openadlc-atlas-janedoe/1-issue-1';
  const CIPHER = { id: 'bot-cipher', name: 'openadlc-cipher-janedoe', githubLogin: 'openadlc-cipher-janedoe' };
  const SIGNED_OUT = {
    id: 'bot-sign-in:bot-cipher',
    state: 'failing',
    title: 'openadlc-cipher-janedoe is signed out of GitHub',
    detail: 'Reconnect openadlc-cipher-janedoe from Settings → GitHub → Connected accounts.',
  };
  const WAITING = { state: 'pending' as const, description: 'waiting on openadlc-cipher-janedoe' };

  type Opened = { bot: string; kind: string; subjectRef: string; branch?: string | null; issueNumber?: number | null };

  // Pull request #2 of openadlc-testbed is issue #1's, and is in review.
  function sweeping(gate: { state: 'pending' | 'success'; description: string }, standing: { state: string; description: string } | null) {
    store.repos = [{ id: 'repo-1', name: 'openadlc-testbed', fullName: 'janedoe/openadlc-testbed' }];
    store.issues = [{ repoName: 'openadlc-testbed', number: 1, prNumber: 2, stage: 'review', labels: [] }];
    store.bots = [CIPHER];
    const published: { state: string; description: string }[] = [];
    const opened: Opened[] = [];
    const taskService = new TaskService({} as never, {} as never, {} as never);
    taskService.open = (async (input: Opened) => {
      opened.push(input);
      return { taskId: 'task-new', session: 'review-1' };
    }) as never;
    const github = {
      request: async (_method: string, path: string) =>
        path.includes('/pulls?state=open')
          ? [
              {
                number: 2,
                draft: false,
                head: { ref: BRANCH, sha: 'abc123', repo: { full_name: 'janedoe/openadlc-testbed' } },
                base: { ref: 'main' },
                labels: [],
                user: { login: 'openadlc-atlas-janedoe' },
                author_association: 'COLLABORATOR',
              },
            ]
          : { statuses: standing ? [{ context: 'review-gate', ...standing }] : [] },
    };
    const scheduler = new Scheduler(
      { automationBot: 'flow' } as never,
      {} as never,
      {
        actors: { asBot: async () => github },
        reviewStanding: async () => ({ gate, decision: { lead: 'openadlc-sydney-janedoe', reviewers: [], approvers: [] }, posted: [], approved: [], leadDue: null }),
        setReviewGate: async (input: { state: string; description: string }) => {
          published.push({ state: input.state, description: input.description });
          return { state: input.state, description: input.description };
        },
      } as never,
      {} as never,
      {} as never,
      { enter: async () => undefined } as never,
      taskService as never,
    );
    return { scheduler, published, opened };
  }

  it('says it is waiting on the reviewer account, and starts nothing', async () => {
    store.health = [SIGNED_OUT];
    const { scheduler, published, opened } = sweeping(WAITING, WAITING);

    await scheduler.settleGates();

    expect(published).toEqual([
      { state: 'pending', description: 'waiting on the reviewer account: openadlc-cipher-janedoe cannot sign in to GitHub' },
    ]);
    expect(opened).toEqual([]);
  });

  it('starts the review by itself, and names the seat in the gate again, once the sign-in works', async () => {
    store.health = [{ ...SIGNED_OUT, state: 'passing' }];
    const standing = { state: 'pending', description: 'waiting on the reviewer account: openadlc-cipher-janedoe cannot sign in to GitHub' };
    const { scheduler, published, opened } = sweeping(WAITING, standing);

    const actions = await scheduler.settleGates();

    expect(published).toEqual([{ state: 'pending', description: 'waiting on openadlc-cipher-janedoe' }]);
    expect(opened).toEqual([
      expect.objectContaining({ bot: 'openadlc-cipher-janedoe', kind: 'review', subjectRef: 'openadlc-testbed#2', branch: BRANCH, issueNumber: 1 }),
    ]);
    expect(actions).toContainEqual(expect.stringContaining('openadlc-testbed#2: started openadlc-cipher-janedoe’s review'));
  });

  it('starts the review of a seat that could always sign in, though no event is coming for it', async () => {
    const { scheduler, opened } = sweeping(WAITING, WAITING);

    await scheduler.settleGates();

    expect(opened).toHaveLength(1);
  });

  it('leaves a seat that has a review under way, or one that ran and failed, alone', async () => {
    for (const state of ['running', 'failed']) {
      store.reviewTasks = [{ subjectRef: 'openadlc-testbed#2', state, botId: 'bot-cipher' }];
      const { scheduler, opened } = sweeping(WAITING, WAITING);
      await scheduler.settleGates();
      expect(opened).toEqual([]);
    }
  });

  it('starts a seat on round two whose review could not start at the push, though it reviewed round one', async () => {
    // Round one's review is done; round two's open found the seat busy and
    // recorded nothing. The seat now has room.
    store.reviewTasks = [{ subjectRef: 'openadlc-testbed#2', state: 'done', botId: 'bot-cipher', createdAt: '2026-10-01T09:00:00.000Z' }];
    store.roundAt = '2026-10-01T10:00:00.000Z';
    const { scheduler, opened } = sweeping(WAITING, WAITING);

    const actions = await scheduler.settleGates();

    expect(opened).toEqual([expect.objectContaining({ bot: 'openadlc-cipher-janedoe', kind: 'review', subjectRef: 'openadlc-testbed#2' })]);
    expect(actions).toContainEqual(expect.stringContaining('started openadlc-cipher-janedoe’s review'));
  });

  it('waits on a seat that is missing from its repository, saying so', async () => {
    store.health = [{ id: 'bot-access:bot-cipher:openadlc-testbed', state: 'failing', title: 'not in the repository', detail: 'Invite it.' }];
    const { scheduler, published, opened } = sweeping(WAITING, WAITING);

    await scheduler.settleGates();

    expect(published[0]?.description).toBe('waiting on the reviewer account: openadlc-cipher-janedoe cannot work in openadlc-testbed');
    expect(opened).toEqual([]);
  });

  it('says the host service when that is what everything waits on', async () => {
    store.health = [{ id: 'hostd', state: 'failing', title: 'hostd is not answering', detail: 'Start it.' }];
    const { scheduler, published } = sweeping(WAITING, WAITING);

    await scheduler.settleGates();

    expect(published[0]?.description).toBe('waiting on the host service: OpenADLC’s host service is not answering');
  });

  it('leaves a gate waiting on people as it words it', async () => {
    store.health = [SIGNED_OUT];
    const { scheduler, published } = sweeping({ state: 'pending', description: 'waiting on @janedoe' }, null);

    await scheduler.settleGates();

    expect(published).toEqual([{ state: 'pending', description: 'waiting on @janedoe' }]);
  });

  it('does not hold a scripted install back for accounts it does not use', async () => {
    store.health = [SIGNED_OUT];
    vi.stubEnv('OPENADLC_SCRIPTED_ENGINES', '1');
    try {
      const { scheduler, opened } = sweeping(WAITING, WAITING);
      await scheduler.settleGates();
      expect(opened).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('the lead’s review, asked again by the sweep', () => {
  const BRANCH = 'agent/openadlc-atlas-janedoe/1-issue-1';
  const LEAD = { id: 'bot-lead', name: 'openadlc-sydney-janedoe', githubLogin: 'openadlc-sydney-janedoe' };
  const HEAD = 'c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2';
  const WAITING = { state: 'pending' as const, description: 'waiting on openadlc-sydney-janedoe' };

  type Opened = { bot: string; subjectRef: string; extraContext?: { name: string }[] };

  // Pull request #2 of openadlc-testbed is issue #1's, in review, and only the
  // lead reviews it (a revert).
  function sweeping(leadDue: { seat: string; since: string | null } | null) {
    store.repos = [{ id: 'repo-1', name: 'openadlc-testbed', fullName: 'janedoe/openadlc-testbed' }];
    store.issues = [{ repoName: 'openadlc-testbed', number: 1, prNumber: 2, stage: 'review', labels: [] }];
    store.bots = [LEAD];
    const opened: Opened[] = [];
    const taskService = new TaskService({} as never, {} as never, {} as never);
    taskService.open = (async (input: Opened) => {
      opened.push(input);
      return { taskId: 'task-new', session: 'review-1' };
    }) as never;
    const github = {
      request: async (_method: string, path: string) =>
        path.includes('/pulls?state=open')
          ? [
              {
                number: 2,
                draft: false,
                head: { ref: BRANCH, sha: HEAD, repo: { full_name: 'janedoe/openadlc-testbed' } },
                base: { ref: 'main' },
                labels: [{ name: 'deps' }],
                user: { login: 'openadlc-atlas-janedoe' },
                author_association: 'COLLABORATOR',
              },
            ]
          : { statuses: [{ context: 'review-gate', ...WAITING }] },
    };
    const scheduler = new Scheduler(
      { automationBot: 'flow' } as never,
      {} as never,
      {
        actors: { asBot: async () => github },
        reviewStanding: async () => ({
          gate: WAITING,
          decision: { lead: LEAD.name, reviewers: [LEAD.name], approvers: [LEAD.name] },
          posted: [],
          approved: [],
          leadDue,
        }),
        setReviewGate: async (input: { state: string; description: string }) => input,
      } as never,
      {} as never,
      {} as never,
      { enter: async () => undefined } as never,
      taskService as never,
    );
    return { scheduler, opened };
  }

  it('a lead-only pull request in round 2 is asked again by the sweep', async () => {
    // Round two began at 10:00 and the lead was busy then, so no task was
    // recorded; its round-one review is done. That review was taken for this one.
    store.reviewTasks = [{ subjectRef: 'openadlc-testbed#2', state: 'done', botId: LEAD.id, createdAt: '2026-10-01T09:00:00.000Z' }];
    const { scheduler, opened } = sweeping({ seat: LEAD.name, since: '2026-10-01T10:00:00.000Z' });

    const actions = await scheduler.settleGates();

    expect(opened).toEqual([expect.objectContaining({ bot: LEAD.name, subjectRef: 'openadlc-testbed#2' })]);
    expect(actions).toContainEqual(expect.stringContaining('the lead’s, last'));
  });

  it('does not ask the lead twice for one diff', async () => {
    store.reviewTasks = [{ subjectRef: 'openadlc-testbed#2', state: 'done', botId: LEAD.id, createdAt: '2026-10-01T10:00:05.000Z' }];
    const { scheduler, opened } = sweeping({ seat: LEAD.name, since: '2026-10-01T10:00:00.000Z' });

    await scheduler.settleGates();

    expect(opened).toEqual([]);
  });

  it('opens the re-check of a lead-only resolution the lead was busy for at the push, with its brief', async () => {
    store.reviewTasks = [{ subjectRef: 'openadlc-testbed#2', state: 'done', botId: LEAD.id, createdAt: '2026-10-01T09:00:00.000Z' }];
    store.events = [
      {
        type: 'conflict.resolved',
        payload: { repo: 'openadlc-testbed', pr: 2, issue: 1, files: ['Makefile'], review: 'lead-only', from: 'b0'.repeat(20), to: HEAD, at: '2026-10-01T10:00:00.000Z' },
        at: '2026-10-01T10:00:00.000Z',
      },
    ];
    // The lead's approval of the head before the resolution carries, so the
    // standing does not say the lead is due.
    const { scheduler, opened } = sweeping(null);

    await scheduler.settleGates();
    expect(opened).toEqual([
      expect.objectContaining({ bot: LEAD.name, subjectRef: 'openadlc-testbed#2', extraContext: [expect.objectContaining({ name: 'resolution-check.md' })] }),
    ]);

    // Opened once: the next sweep finds it under way.
    store.reviewTasks.push({ subjectRef: 'openadlc-testbed#2', state: 'running', botId: LEAD.id, createdAt: '2026-10-01T10:05:00.000Z' });
    await scheduler.settleGates();
    expect(opened).toHaveLength(1);
  });
});

describe('a person’s pull request, settled by the sweep too', () => {
  // A person's branch is not cut for an issue, so no issue in Review stands
  // for it, and the sweep passed it by. #15, #19 and #25 sat "waiting on" a
  // seat that was busy when the round opened, or a lead busy when its turn
  // came, with no task, until a person posted a review.
  const BRANCH = 'janedoe/fix-the-sweep';
  const CIPHER = { id: 'bot-cipher', name: 'openadlc-cipher-janedoe', githubLogin: 'openadlc-cipher-janedoe' };
  const LEAD = { id: 'bot-lead', name: 'openadlc-sydney-janedoe', githubLogin: 'openadlc-sydney-janedoe' };
  const ROUND = '2026-10-20T10:00:00.000Z';
  const PERSON = { user: { login: 'janedoe' }, author_association: 'OWNER' };
  const waitingOn = (seat: { name: string }) => ({ state: 'pending' as const, description: `waiting on ${seat.name}` });

  type Gate = { state: 'pending' | 'success'; description: string };
  type Pull = {
    number: number;
    draft?: boolean;
    ref?: string;
    sha?: string;
    /** The head's repository; null once a fork is deleted. */
    headRepo?: string | null;
    labels?: string[];
    author?: { user: { login: string; id?: number }; author_association: string };
  };
  type Opened = { bot: string; botId?: string; kind: string; subjectRef: string; branch?: string | null; issueNumber?: number | null };

  function sweeping(options: {
    pulls: Pull[];
    gate: Gate;
    standing?: { state: string; description: string } | null;
    leadDue?: { seat: string; since: string | null };
    /** Each page of GitHub's list; by default `pulls` is the first and only one. */
    pageOf?: (page: number) => Pull[];
    config?: Record<string, unknown>;
    /** The checks on a head, as GitHub reports them (`checksFor`). */
    checks?: (sha: string) => { name: string; status: string; conclusion: string | null; id?: number }[];
  }) {
    store.repos = [{ id: 'repo-1', name: 'openadlc-testbed', fullName: 'janedoe/openadlc-testbed' }];
    store.issues = [];
    store.bots = [CIPHER, LEAD];
    const standing = options.standing === undefined ? options.gate : options.standing;
    const published: { prNumber: number; state: string; description: string }[] = [];
    const entered: { repoName: string; prNumber: number; headSha: string; revert?: boolean }[] = [];
    const opened: Opened[] = [];
    const pagesAsked: number[] = [];
    const checksAsked: string[] = [];
    const pageOf = options.pageOf ?? ((page: number) => (page === 1 ? options.pulls : []));
    const taskService = new TaskService({} as never, {} as never, {} as never);
    // Recorded as the task service records it, so the next sweep finds it under way.
    taskService.open = (async (input: Opened) => {
      opened.push(input);
      store.reviewTasks.push({ subjectRef: input.subjectRef, state: 'queued', botId: input.botId ?? '', createdAt: '2026-10-20T10:30:00.000Z' });
      return { taskId: `task-${opened.length}`, session: 'review-1' };
    }) as never;
    const github = {
      request: async (_method: string, path: string) => {
        if (!path.includes('/pulls?state=open')) return { statuses: standing ? [{ context: 'review-gate', ...standing }] : [] };
        const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? '1');
        pagesAsked.push(page);
        return pageOf(page).map((pull) => ({
          number: pull.number,
          draft: pull.draft ?? false,
          head: {
            ref: pull.ref ?? BRANCH,
            sha: pull.sha ?? `sha-${pull.number}`,
            repo: pull.headRepo === null ? null : { full_name: pull.headRepo ?? 'janedoe/openadlc-testbed' },
          },
          base: { ref: 'main' },
          labels: (pull.labels ?? []).map((name) => ({ name })),
          ...(pull.author ?? PERSON),
        }));
      },
      checksFor: async (_repo: string, sha: string) => {
        checksAsked.push(sha);
        return options.checks?.(sha) ?? [];
      },
    };
    const scheduler = new Scheduler(
      (options.config ?? { automationBot: 'flow' }) as never,
      {} as never,
      {
        actors: { asBot: async () => github },
        reviewStanding: async () => ({
          gate: options.gate,
          decision: { lead: LEAD.name, reviewers: [CIPHER.name, LEAD.name], approvers: [LEAD.name] },
          posted: [],
          approved: [],
          leadDue: options.leadDue ?? null,
        }),
        setReviewGate: async (input: { prNumber: number; state: string; description: string }) => {
          published.push({ prNumber: input.prNumber, state: input.state, description: input.description });
          return { state: input.state, description: input.description };
        },
      } as never,
      {} as never,
      {} as never,
      {
        // As the store takes a place: a failed one becomes waiting again, at the head entered with.
        enter: async (input: { repoName: string; prNumber: number; headSha: string; revert?: boolean }) => {
          entered.push(input);
          const row = store.mergeRows.find((entry) => entry.prNumber === input.prNumber);
          if (!row) store.mergeRows.push({ prNumber: input.prNumber, state: 'waiting', headSha: input.headSha });
          else if (row.state === 'failed' || row.state === 'merged') Object.assign(row, { state: 'waiting', headSha: input.headSha, detail: null });
          else row.headSha = input.headSha;
        },
      } as never,
      taskService as never,
    );
    return { scheduler, published, entered, opened, pagesAsked, checksAsked };
  }

  it('starts a second reviewer that was busy when the round opened', async () => {
    // The round opened at 10:00 and the seat had no room, so no task was recorded.
    store.roundAt = ROUND;
    const { scheduler, opened } = sweeping({ pulls: [{ number: 15 }], gate: waitingOn(CIPHER) });

    const actions = await scheduler.settleGates();

    expect(opened).toEqual([
      expect.objectContaining({ bot: CIPHER.name, kind: 'review', subjectRef: 'openadlc-testbed#15', branch: BRANCH, issueNumber: null }),
    ]);
    expect(actions).toContainEqual(expect.stringContaining('openadlc-testbed#15: started openadlc-cipher-janedoe’s review'));
  });

  it('starts the lead, due once the others posted, that was busy when its turn came', async () => {
    store.roundAt = ROUND;
    // The second reviewer posted at 10:20; the review that completed the set found the lead busy.
    store.reviewTasks = [{ subjectRef: 'openadlc-testbed#15', state: 'done', botId: CIPHER.id, createdAt: '2026-10-20T10:01:00.000Z' }];
    const { scheduler, opened } = sweeping({
      pulls: [{ number: 15 }],
      gate: waitingOn(LEAD),
      leadDue: { seat: LEAD.name, since: '2026-10-20T10:20:00.000Z' },
    });

    const actions = await scheduler.settleGates();

    expect(opened).toEqual([expect.objectContaining({ bot: LEAD.name, subjectRef: 'openadlc-testbed#15', branch: BRANCH, issueNumber: null })]);
    expect(actions).toContainEqual(expect.stringContaining('the lead’s, last'));
  });

  it('asks each seat once: a review under way, or one opened on this diff, is that seat’s review', async () => {
    store.roundAt = ROUND;
    const second = sweeping({ pulls: [{ number: 15 }], gate: waitingOn(CIPHER) });
    await second.scheduler.settleGates();
    await second.scheduler.settleGates();
    expect(second.opened.map((task) => task.bot)).toEqual([CIPHER.name]);

    store.reviewTasks = [{ subjectRef: 'openadlc-testbed#15', state: 'done', botId: CIPHER.id, createdAt: '2026-10-20T10:01:00.000Z' }];
    const lead = sweeping({ pulls: [{ number: 15 }], gate: waitingOn(LEAD), leadDue: { seat: LEAD.name, since: '2026-10-20T10:20:00.000Z' } });
    await lead.scheduler.settleGates();
    await lead.scheduler.settleGates();
    expect(lead.opened.map((task) => task.bot)).toEqual([LEAD.name]);

    // A seat whose task on this diff already ran is left to it, though the gate still names it.
    store.reviewTasks = [{ subjectRef: 'openadlc-testbed#15', state: 'failed', botId: CIPHER.id, createdAt: '2026-10-20T10:01:00.000Z' }];
    const ran = sweeping({ pulls: [{ number: 15 }], gate: waitingOn(CIPHER) });
    await ran.scheduler.settleGates();
    expect(ran.opened).toEqual([]);
  });

  it('leaves a fork’s pull request, a deleted fork’s, a draft, a stranger’s, and one OpenADLC opened no round on alone', async () => {
    store.roundAt = ROUND;
    const { scheduler, published, opened } = sweeping({
      pulls: [
        { number: 15 },
        { number: 16, headRepo: 'collaborator/openadlc-testbed' },
        { number: 17, headRepo: null },
        { number: 18, draft: true },
        // From a branch somebody else pushed, by somebody with no role here.
        { number: 19, author: { user: { login: 'stranger' }, author_association: 'NONE' } },
      ],
      gate: waitingOn(CIPHER),
      standing: null,
    });

    await scheduler.settleGates();

    expect(published.map((gate) => gate.prNumber)).toEqual([15]);
    expect(opened.map((task) => task.subjectRef)).toEqual(['openadlc-testbed#15']);

    // Open before the repository was managed: no webhook asked any seat, and neither does the sweep.
    store.roundAt = null;
    store.reviewTasks = [];
    const never = sweeping({ pulls: [{ number: 15 }], gate: waitingOn(CIPHER), standing: null });
    await never.scheduler.settleGates();
    expect(never.published).toEqual([]);
    expect(never.opened).toEqual([]);
  });

  it('puts a person’s pull request whose gate passes in the merge line, and the SRE’s revert at its front', async () => {
    store.roundAt = ROUND;
    const { scheduler, entered, opened } = sweeping({
      pulls: [
        { number: 15 },
        {
          number: 20,
          ref: 'system/revert-0a1b2c3d',
          labels: ['revert'],
          author: { user: { login: 'openadlc-sre-janedoe' }, author_association: 'COLLABORATOR' },
        },
      ],
      gate: { state: 'success', description: 'all required reviews are in' },
      standing: waitingOn(LEAD),
    });

    const actions = await scheduler.settleGates();

    expect(actions).toContain('openadlc-testbed#15: review gate is success (all required reviews are in)');
    expect(entered).toEqual([
      { repoName: 'openadlc-testbed', prNumber: 15, headSha: 'sha-15', revert: false },
      { repoName: 'openadlc-testbed', prNumber: 20, headSha: 'sha-20', revert: true },
    ]);
    expect(opened).toEqual([]);
  });

  it('does not put a person’s pull request back in the line at the head the line let go of it at', async () => {
    store.roundAt = ROUND;
    const pulls: Pull[] = [{ number: 15 }];
    const { scheduler, entered } = sweeping({ pulls, gate: { state: 'success', description: 'all required reviews are in' } });
    // The line at its front: the checks on that head are red, so it fails
    // the place and says so on the pull request (`leaveFor`).
    const said: string[] = [];
    const lineFails = () => {
      for (const row of store.mergeRows.filter((entry) => entry.state === 'waiting')) {
        row.state = 'failed';
        said.push(`#${row.prNumber}@${row.headSha}: Leaving the merge line`);
      }
    };

    await scheduler.settleGates();
    lineFails();
    await scheduler.settleGates();
    lineFails();

    expect(entered.map((entry) => entry.headSha)).toEqual(['sha-15']);
    expect(said).toEqual(['#15@sha-15: Leaving the merge line']);

    // A push moves the head, and it takes a place again.
    pulls[0] = { number: 15, sha: 'sha-15-fixed' };
    await scheduler.settleGates();
    expect(entered.map((entry) => entry.headSha)).toEqual(['sha-15', 'sha-15-fixed']);
  });

  it('puts a person’s pull request back in the line once CI’s rerun passed at the head the line let go of it at', async () => {
    // CI's first run failed at the front, so the line let it go
    // (`CHECKS_FAILED`), and `onCiRun` ran it again, which passed on the same
    // head. Kept out until the head moved, it waited for a push or a review.
    store.roundAt = ROUND;
    store.mergeRows = [{ prNumber: 15, state: 'failed', headSha: 'sha-15', detail: CHECKS_FAILED }];
    type Check = { name: string; status: string; conclusion: string | null; id?: number };
    const first: Check = { name: 'ci', status: 'completed', conclusion: 'failure', id: 101 };
    let checks: Check[] = [first, { name: 'review-gate', status: 'completed', conclusion: 'success' }];
    const { scheduler, entered } = sweeping({ pulls: [{ number: 15 }], gate: { state: 'success', description: 'all required reviews are in' }, checks: () => checks });

    await scheduler.settleGates();
    expect(entered).toEqual([]);

    // The rerun is under way: still out.
    checks = [first, { name: 'ci', status: 'in_progress', conclusion: null, id: 102 }, checks[1]!];
    await scheduler.settleGates();
    expect(entered).toEqual([]);

    checks = [first, { name: 'ci', status: 'completed', conclusion: 'success', id: 102 }, checks[2]!];
    await scheduler.settleGates();
    expect(entered).toEqual([{ repoName: 'openadlc-testbed', prNumber: 15, headSha: 'sha-15', revert: false }]);
  });

  it('keeps out one the line let go of for anything but its checks, though they are green', async () => {
    // A conflict, or a base that is not the default branch, fails it again at
    // the front whatever CI says, and says "Leaving the merge line" each time.
    store.roundAt = ROUND;
    const green = [{ name: 'ci', status: 'completed', conclusion: 'success', id: 102 }, { name: 'review-gate', status: 'completed', conclusion: 'success' }];
    for (const detail of ['conflicts with main', 'not for the merge line: it is based on release, not main', null]) {
      store.mergeRows = [{ prNumber: 15, state: 'failed', headSha: 'sha-15', detail }];
      const { scheduler, entered, checksAsked } = sweeping({ pulls: [{ number: 15 }], gate: { state: 'success', description: 'all required reviews are in' }, checks: () => green });

      await scheduler.settleGates();

      expect(entered).toEqual([]);
      expect(checksAsked).toEqual([]);
    }
  });

  it('admits one of the install’s people as a delivery does, from the account their login was pinned to', async () => {
    // GitHub labels an organization's owner whose membership is private a
    // CONTRIBUTOR, and no role lookup answers for them here.
    store.roundAt = ROUND;
    store.humanIds = JSON.stringify({ janedoe: 4242 });
    const config = { automationBot: 'flow', humans: ['janedoe'], gitHubClientId: '', webhookSecret: '', organization: 'janedoe', publicUrl: '' };
    const byJane = (id: number): Pull => ({ number: 15, author: { user: { login: 'janedoe', id }, author_association: 'CONTRIBUTOR' } });

    const pinned = sweeping({ pulls: [byJane(4242)], gate: waitingOn(CIPHER), config });
    await pinned.scheduler.settleGates();
    expect(pinned.opened.map((task) => task.subjectRef)).toEqual(['openadlc-testbed#15']);

    // The same login on another account is not them.
    store.reviewTasks = [];
    const taken = sweeping({ pulls: [byJane(999)], gate: waitingOn(CIPHER), config });
    await taken.scheduler.settleGates();
    expect(taken.opened).toEqual([]);
  });

  it('reads every page of open pull requests, up to a thousand, and says when it stopped short', async () => {
    store.roundAt = ROUND;
    // A hundred drafts fill a page.
    const drafts = (page: number): Pull[] => Array.from({ length: 100 }, (_, index) => ({ number: page * 1000 + index, draft: true }));

    // The pull request waiting on a seat is on the second page.
    const two = sweeping({ pulls: [], gate: waitingOn(CIPHER), pageOf: (page) => (page === 1 ? drafts(1) : page === 2 ? [{ number: 15 }] : []) });
    const actions = await two.scheduler.settleGates();
    expect(two.pagesAsked).toEqual([1, 2]);
    expect(two.opened.map((task) => task.subjectRef)).toEqual(['openadlc-testbed#15']);
    expect(actions.join('\n')).not.toContain('no more');

    // Every page full: it stops at the tenth, and says so.
    const endless = sweeping({ pulls: [], gate: waitingOn(CIPHER), pageOf: drafts });
    const stopped = await endless.scheduler.settleGates();
    expect(endless.pagesAsked).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(stopped).toContain('openadlc-testbed: read 1000 open pull requests and no more; the review gates of the rest were not settled');
  });
});

describe('a task that failed for something a health check proves, once that check passes', () => {
  const NOW = new Date('2026-09-29T12:00:00.000Z');
  const SIGN_IN_FAILURE = 'git push failed: remote: Bad credentials';

  function failed(overrides: Record<string, unknown> = {}) {
    return {
      id: 't1',
      botId: 'bot-cipher',
      repoId: 'repo-1',
      kind: 'review',
      subjectType: 'pr',
      subjectRef: 'openadlc-testbed#2',
      state: 'failed',
      startedAt: '2026-09-29T10:00:00.000Z',
      endedAt: '2026-09-29T10:05:00.000Z',
      createdAt: '2026-09-29T10:00:00.000Z',
      exitReason: SIGN_IN_FAILURE,
      autoRetriedAt: null,
      ...overrides,
    };
  }

  function recovering() {
    store.repos = [{ id: 'repo-1', name: 'openadlc-testbed', fullName: 'janedoe/openadlc-testbed' }];
    store.issues = [{ repoName: 'openadlc-testbed', number: 1, prNumber: 2, stage: 'review', labels: [] }];
    const retry = vi.fn(async (_id: string, _actor: string) => {
      store.tasks.push(failed({ id: 't2', state: 'running', endedAt: null, exitReason: null, createdAt: '2026-09-29T12:00:01.000Z' }));
      return { task: { taskId: 't2' }, bot: 'openadlc-cipher-janedoe' };
    });
    return { retry, run: (fixed: string[]) => retryAfterRecovery(fixed, { retry, now: () => NOW }) };
  }

  it('is run again, once, and the retry is recorded', async () => {
    store.tasks = [failed()];
    const { retry, run } = recovering();

    const actions = await run(['bot-sign-in:bot-cipher']);

    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledWith('t1', RECOVERY_ACTOR);
    expect(actions).toEqual(['openadlc-testbed#2: openadlc-cipher-janedoe’s review run again, now that bot-sign-in:bot-cipher passes']);
    expect(store.audits).toEqual([
      {
        actor: RECOVERY_ACTOR,
        action: 'task.auto_retried',
        target: 'openadlc-testbed#2',
        payload: { retried: 't1', task: 't2', bot: 'openadlc-cipher-janedoe', kind: 'review', cause: 'bot-sign-in:bot-cipher' },
      },
    ]);
  });

  it('is not run again for the same failure when the check passes a second time', async () => {
    store.tasks = [failed()];
    const { retry, run } = recovering();

    await run(['bot-sign-in:bot-cipher']);
    await run(['bot-sign-in:bot-cipher']);

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('is not run again when two recoveries find it at once', async () => {
    store.tasks = [failed()];
    const { retry, run } = recovering();

    await Promise.all([run(['bot-sign-in:bot-cipher']), run(['bot-sign-in:bot-cipher'])]);

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('is not run a third time when the retry fails for the same cause', async () => {
    store.tasks = [failed()];
    const { retry, run } = recovering();

    await run(['bot-sign-in:bot-cipher']);
    // The retry ran, and failed on the very thing that had just been put right.
    Object.assign(store.tasks.find((task) => task.id === 't2') ?? {}, {
      state: 'failed',
      endedAt: '2026-09-29T12:10:00.000Z',
      exitReason: SIGN_IN_FAILURE,
    });
    await run(['bot-sign-in:bot-cipher']);

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('gives the claim back when the retry is refused, so the next recovery may try', async () => {
    store.tasks = [failed()];
    const { retry, run } = recovering();
    retry.mockRejectedValueOnce(new Error('openadlc-cipher-janedoe is busy with another task'));

    const first = await run(['bot-sign-in:bot-cipher']);
    expect(first).toEqual(['openadlc-testbed#2: not run again (openadlc-cipher-janedoe is busy with another task)']);
    expect(store.tasks[0]?.autoRetriedAt).toBeNull();
    expect(store.audits).toEqual([]);

    await run(['bot-sign-in:bot-cipher']);
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it('is left alone when it was already tried again, by a person or by the dispatcher', async () => {
    store.tasks = [failed(), failed({ id: 't-later', state: 'running', endedAt: null, createdAt: '2026-09-29T11:00:00.000Z' })];
    const { retry, run } = recovering();

    await run(['bot-sign-in:bot-cipher']);

    expect(retry).not.toHaveBeenCalled();
  });

  it('is left alone while its issue is labelled openadlc:ignore, and run again once the label is off', async () => {
    // A person told the crew to leave the issue alone; the recovery started
    // its failed review again anyway.
    store.tasks = [failed()];
    const { retry, run } = recovering();
    store.issues = [{ repoName: 'openadlc-testbed', number: 1, prNumber: 2, stage: 'review', labels: ['openadlc:ignore'] }];

    expect(await run(['bot-sign-in:bot-cipher'])).toEqual([]);
    expect(retry).not.toHaveBeenCalled();
    expect(store.tasks[0]?.autoRetriedAt).toBeNull();

    store.issues = [{ repoName: 'openadlc-testbed', number: 1, prNumber: 2, stage: 'review', labels: [] }];
    await run(['bot-sign-in:bot-cipher']);
    expect(retry).toHaveBeenCalledWith('t1', RECOVERY_ACTOR);
  });

  it('is left alone when a different seat’s check passed', async () => {
    store.tasks = [failed()];
    const { retry, run } = recovering();

    await run(['bot-sign-in:bot-lead']);

    expect(retry).not.toHaveBeenCalled();
  });

  it('is left alone when the check that passed is not about what went wrong', async () => {
    store.tasks = [failed({ exitReason: 'the engine ran out of credit' })];
    const { retry, run } = recovering();

    await run(['bot-sign-in:bot-cipher', 'hostd']);

    expect(retry).not.toHaveBeenCalled();
  });

  it('is left alone when what passed does not decide whether a bot can work', async () => {
    store.tasks = [failed()];
    const { retry, run } = recovering();

    expect(await run(['webhook', 'model-account:acct-1'])).toEqual([]);

    expect(retry).not.toHaveBeenCalled();
  });

  it('is run again when the seat is let into the repository', async () => {
    store.tasks = [failed({ exitReason: 'remote: Permission to janedoe/openadlc-testbed.git denied to openadlc-cipher-janedoe.' })];
    const { retry, run } = recovering();

    await run(['bot-access:bot-cipher:openadlc-testbed']);

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('is run again, stopped or failed, when the host comes back', async () => {
    store.tasks = [
      failed({ id: 't-stopped', state: 'stopped', exitReason: 'host stopped reporting' }),
      failed({ id: 't-other', botId: 'bot-lead', subjectRef: 'openadlc-testbed#5', exitReason: 'hostd did not answer' }),
    ];
    const { retry, run } = recovering();

    await run(['hostd']);

    expect(retry.mock.calls.map(([id]) => id).sort()).toEqual(['t-other', 't-stopped']);
  });

  it('is left for a person once it is old enough that the board has stopped showing it', async () => {
    store.tasks = [failed({ endedAt: '2026-09-15T10:05:00.000Z', createdAt: '2026-09-15T10:00:00.000Z' })];
    const { retry, run } = recovering();

    await run(['bot-sign-in:bot-cipher']);

    expect(retry).not.toHaveBeenCalled();
  });

  it('is left alone when its card has moved on past the stage it was for', async () => {
    store.tasks = [failed()];
    const { retry, run } = recovering();
    store.issues = [{ repoName: 'openadlc-testbed', number: 1, prNumber: 2, stage: 'merged', labels: [] }];

    await run(['bot-sign-in:bot-cipher']);

    expect(retry).not.toHaveBeenCalled();
  });

  it('runs a conflict resolution round again with its card in Review, where the merge line opened it', async () => {
    // A patch is Build work, so with the card in Review it was passed over,
    // and the pull request waited out of the merge line for good.
    store.tasks = [failed({ botId: 'bot-atlas', kind: 'patch', skill: 'resolve-conflict', exitReason: 'git push failed: remote: Bad credentials' })];
    const { retry, run } = recovering();

    await run(['bot-sign-in:bot-atlas']);

    expect(retry).toHaveBeenCalledWith('t1', RECOVERY_ACTOR);
    // An ordinary patch round is still Build's.
    store.tasks = [failed({ id: 't3', botId: 'bot-atlas', kind: 'patch', skill: 'implement', exitReason: 'git push failed: remote: Bad credentials' })];
    retry.mockClear();
    await run(['bot-sign-in:bot-atlas']);
    expect(retry).not.toHaveBeenCalled();
  });
});

describe('the sweep that comes back for a failed task the recovery could not run', () => {
  const NOW = new Date('2026-09-29T12:00:00.000Z');
  const SIGN_IN_FAILURE = 'git push failed: remote: Bad credentials';
  const SIGN_IN_FIXED = { id: 'bot-sign-in:bot-cipher', state: 'ok', fixedAt: '2026-09-29T11:00:00.000Z' };

  function failed(id: string, subjectRef: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      botId: 'bot-cipher',
      repoId: 'repo-1',
      kind: 'review',
      subjectType: 'pr',
      subjectRef,
      state: 'failed',
      startedAt: '2026-09-29T10:00:00.000Z',
      endedAt: '2026-09-29T10:05:00.000Z',
      createdAt: '2026-09-29T10:00:00.000Z',
      exitReason: SIGN_IN_FAILURE,
      autoRetriedAt: null,
      ...overrides,
    };
  }

  // Each retry starts a running task on the same subject, as `retryTask` does.
  function recovering() {
    store.repos = [{ id: 'repo-1', name: 'openadlc-testbed', fullName: 'janedoe/openadlc-testbed' }];
    store.issues = [];
    let n = 0;
    const retry = vi.fn(async (id: string, _actor: string) => {
      const original = store.tasks.find((task) => task.id === id);
      const started = `retry-${++n}`;
      store.tasks.push({ ...original, id: started, state: 'running', endedAt: null, exitReason: null, createdAt: `2026-09-29T12:00:0${n}.000Z` });
      return { task: { taskId: started }, bot: 'openadlc-cipher-janedoe' };
    });
    const deps = { retry, now: () => NOW };
    return { retry, fixed: (ids: string[]) => retryAfterRecovery(ids, deps), sweep: () => retryAfterRecovery(null, deps) };
  }

  it('runs both of one seat’s failures from an outage, one at a time, each once', async () => {
    store.tasks = [failed('t-a', 'openadlc-testbed#2'), failed('t-b', 'openadlc-testbed#3')];
    store.health = [SIGN_IN_FIXED];
    const { retry, fixed, sweep } = recovering();

    // The seat can run one task: the first is run again, the second waits
    // unclaimed rather than being refused as busy.
    await fixed(['bot-sign-in:bot-cipher']);
    expect(retry.mock.calls.map(([id]) => id)).toEqual(['t-a']);
    expect(store.tasks.find((task) => task.id === 't-b')?.autoRetriedAt).toBeNull();

    // While the first retry runs, the sweep leaves the second alone.
    await sweep();
    expect(retry).toHaveBeenCalledTimes(1);

    // The first retry is done. The check does not turn green again, so the
    // sweep is what runs the second.
    Object.assign(store.tasks.find((task) => task.id === 'retry-1') ?? {}, { state: 'done', endedAt: '2026-09-29T12:05:00.000Z' });
    await sweep();
    expect(retry.mock.calls.map(([id]) => id)).toEqual(['t-a', 't-b']);

    Object.assign(store.tasks.find((task) => task.id === 'retry-2') ?? {}, { state: 'done', endedAt: '2026-09-29T12:10:00.000Z' });
    await sweep();
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it('runs a claim given back again on a later sweep', async () => {
    store.tasks = [failed('t-a', 'openadlc-testbed#2')];
    store.health = [SIGN_IN_FIXED];
    const { retry, fixed, sweep } = recovering();
    retry.mockRejectedValueOnce(new Error('openadlc-cipher-janedoe was not started: OpenADLC’s host service is not answering.'));

    await fixed(['bot-sign-in:bot-cipher']);
    await sweep();

    expect(retry.mock.calls.map(([id]) => id)).toEqual(['t-a', 't-a']);
    expect(store.audits).toHaveLength(1);
  });

  it('runs nothing whose check has not been put right since it failed', async () => {
    store.tasks = [failed('t-a', 'openadlc-testbed#2')];
    const { retry, sweep } = recovering();

    // Never failing, the check proves nothing was put right.
    store.health = [{ id: 'bot-sign-in:bot-cipher', state: 'ok', fixedAt: null }];
    await sweep();
    // Fixed before the task failed: what it failed on is something else.
    store.health = [{ ...SIGN_IN_FIXED, fixedAt: '2026-09-29T09:00:00.000Z' }];
    await sweep();
    // Still failing.
    store.health = [{ ...SIGN_IN_FIXED, state: 'failing' }];
    await sweep();

    expect(retry).not.toHaveBeenCalled();
  });

  it('runs a patch round that was recorded, not started, while the builder could not sign in', async () => {
    store.tasks = [
      failed('t-patch', 'openadlc-testbed#2', {
        kind: 'patch',
        startedAt: null,
        exitReason:
          'openadlc-cipher-janedoe was not started: openadlc-cipher-janedoe cannot sign in to GitHub. Reconnect openadlc-cipher-janedoe from Settings → GitHub → Connected accounts.',
      }),
    ];
    store.health = [SIGN_IN_FIXED];
    const { retry, sweep } = recovering();

    const actions = await sweep();

    expect(retry.mock.calls.map(([id]) => id)).toEqual(['t-patch']);
    expect(actions).toEqual(['openadlc-testbed#2: openadlc-cipher-janedoe’s patch run again, now that bot-sign-in:bot-cipher passes']);
  });

  it('runs once more a revert that was recorded but never started, and never the task its retry records', async () => {
    // A red smoke's authorisation past a cap is not held for a task that a
    // retry records without starting (`retryTask`): the recovery claims that
    // task as it starts it, so it would never come back to spend the
    // authorisation.
    const NOT_SIGNED_IN =
      'openadlc-cipher-janedoe was not started: openadlc-cipher-janedoe cannot sign in to GitHub. Reconnect openadlc-cipher-janedoe from Settings → GitHub → Connected accounts.';
    store.tasks = [
      failed('t-revert', 'openadlc-testbed@deadbeef', {
        kind: 'deploy',
        subjectType: 'merge',
        branch: 'system/revert-deadbeef',
        startedAt: null,
        exitReason: NOT_SIGNED_IN,
      }),
    ];
    store.health = [SIGN_IN_FIXED];
    const { retry, sweep } = recovering();
    // The retry is recorded without starting, as `retryTask` leaves it when
    // the seat signs out again before it starts.
    retry.mockImplementationOnce(async (id: string) => {
      const original = store.tasks.find((task) => task.id === id);
      store.tasks.push({ ...original, id: 'retry-recorded', state: 'failed', autoRetriedAt: null, endedAt: '2026-09-29T11:30:00.000Z' });
      return { task: { taskId: 'retry-recorded' }, bot: 'openadlc-cipher-janedoe' };
    });

    await sweep();
    // The seat is put right again after the recorded retry failed.
    store.health = [{ ...SIGN_IN_FIXED, fixedAt: '2026-09-29T11:45:00.000Z' }];
    await sweep();

    expect(retry.mock.calls.map(([id]) => id)).toEqual(['t-revert']);
    expect(store.tasks.find((task) => task.id === 'retry-recorded')?.autoRetriedAt).not.toBeNull();
  });

  describe('work OpenADLC’s restart held', () => {
    const HELD = 'openadlc-cipher-janedoe was not started: OpenADLC restarts onto v0.2.0 once the running tasks end, and this starts after the restart';

    it('waits while the restart is owed, and starts the patch round once it is done', async () => {
      store.tasks = [failed('t-patch', 'openadlc-testbed#2', { kind: 'patch', startedAt: null, exitReason: HELD })];
      store.health = [];
      const { retry } = recovering();
      let owed: string | null = 'OpenADLC restarts onto v0.2.0 once the running tasks end';

      expect(await retryAfterRecovery(null, { retry, now: () => NOW, restartPending: () => owed })).toEqual([]);
      expect(retry).not.toHaveBeenCalled();
      expect(store.tasks.find((task) => task.id === 't-patch')?.autoRetriedAt).toBeNull();

      owed = null;
      const actions = await retryAfterRecovery(null, { retry, now: () => NOW, restartPending: () => owed });
      expect(retry.mock.calls.map(([id]) => id)).toEqual(['t-patch']);
      expect(actions).toEqual(['openadlc-testbed#2: openadlc-cipher-janedoe’s patch started, now that OpenADLC has restarted']);
      expect(store.audits).toContainEqual(expect.objectContaining({ action: 'task.auto_retried', payload: expect.objectContaining({ cause: 'openadlc-restart' }) }));
    });

    // The SRE's task on the issue the bridge files for a failed testing deploy
    // (`Webhooks.diagnoseDeploy`): filed in Build, with `adlc:build`.
    function heldSre(issue: { stage: string; labels: string[] }) {
      store.tasks = [
        failed('t-sre', 'openadlc-testbed#5', {
          kind: 'deploy',
          subjectType: 'issue',
          skill: 'deploy',
          branch: 'system/deploy-path-abc12345',
          startedAt: null,
          exitReason: HELD,
        }),
      ];
      store.health = [];
      const { retry } = recovering();
      store.issues = [{ repoName: 'openadlc-testbed', number: 5, prNumber: null, ...issue }];
      return retry;
    }

    it('starts the SRE on a failed testing deploy once the restart is done, though its issue is in Build', async () => {
      // Read as any deploy, it was held for a card in Merged, and never started.
      const retry = heldSre({ stage: 'build', labels: ['adlc:build', 'priority:p1', 'area:general', 'do:ai'] });

      const actions = await retryAfterRecovery(null, { retry, now: () => NOW, restartPending: () => null });

      expect(retry.mock.calls.map(([id]) => id)).toEqual(['t-sre']);
      expect(actions).toEqual(['openadlc-testbed#5: openadlc-cipher-janedoe’s deploy started, now that OpenADLC has restarted']);
    });

    it('leaves the SRE once its issue is closed, or a person has it', async () => {
      const done = heldSre({ stage: 'done', labels: ['adlc:done', 'do:ai'] });
      await retryAfterRecovery(null, { retry: done, now: () => NOW, restartPending: () => null });
      expect(done).not.toHaveBeenCalled();

      const theirs = heldSre({ stage: 'build', labels: ['adlc:build', 'do:human'] });
      await retryAfterRecovery(null, { retry: theirs, now: () => NOW, restartPending: () => null });
      expect(theirs).not.toHaveBeenCalled();
    });

    it('still holds any other deploy for a card in Merged', async () => {
      const retry = heldSre({ stage: 'build', labels: ['adlc:build'] });
      store.tasks = store.tasks.map((task) => ({ ...task, branch: 'agent/openadlc-cipher-janedoe/5-issue-5' }));

      await retryAfterRecovery(null, { retry, now: () => NOW, restartPending: () => null });

      expect(retry).not.toHaveBeenCalled();
    });

    it('waits for a cap spent during the wait, and starts once the cap allows it', async () => {
      // Started anyway, the cap refused it, and the claim went back, on every pass.
      store.tasks = [failed('t-patch', 'openadlc-testbed#2', { kind: 'patch', startedAt: null, exitReason: HELD })];
      store.health = [];
      const { retry } = recovering();
      const caps = { monthlyCapUsd: 1500, onCap: { stopLeasing: true } };
      const { spendingLimits } = await import('@openadlc/db');
      vi.mocked(spendingLimits.refusal).mockResolvedValueOnce('janedoe/openadlc-testbed has spent $200 of its $200 this month');

      await retryAfterRecovery(null, { retry, now: () => NOW, costs: caps, restartPending: () => null });
      expect(retry).not.toHaveBeenCalled();
      expect(store.tasks.find((task) => task.id === 't-patch')?.autoRetriedAt).toBeNull();

      await retryAfterRecovery(null, { retry, now: () => NOW, costs: caps, restartPending: () => null });
      expect(retry.mock.calls.map(([id]) => id)).toEqual(['t-patch']);
    });
  });

  describe('work a spending cap held', () => {
    const HELD =
      'openadlc-cipher-janedoe was held at a spending cap: janedoe/openadlc-testbed has spent $200 of its $200 this month. ' +
      'It starts on its own once the cap allows it: raise the cap in Settings → Spending limits, or wait for the month to roll over.';
    const caps = { monthlyCapUsd: 1500, onCap: { stopLeasing: true } };

    function heldPatch() {
      store.tasks = [failed('t-patch', 'openadlc-testbed#2', { kind: 'patch', startedAt: null, exitReason: HELD })];
      store.health = [];
    }

    it('starts a patch round once the cap allows it, asking the cap for its own bot and repository', async () => {
      heldPatch();
      const { retry } = recovering();
      const { spendingLimits } = await import('@openadlc/db');
      vi.mocked(spendingLimits.refusal).mockClear();

      const actions = await retryAfterRecovery(null, { retry, now: () => NOW, costs: caps });

      expect(retry.mock.calls.map(([id]) => id)).toEqual(['t-patch']);
      expect(actions).toEqual(['openadlc-testbed#2: openadlc-cipher-janedoe’s patch started, now that the spending cap allows it']);
      expect(spendingLimits.refusal).toHaveBeenCalledWith(
        expect.objectContaining({ repoId: 'repo-1', repoLabel: 'janedoe/openadlc-testbed', botId: 'bot-cipher', onCap: caps.onCap }),
      );
      expect(store.audits).toContainEqual(
        expect.objectContaining({ action: 'task.auto_retried', payload: expect.objectContaining({ retried: 't-patch', cause: 'spending-cap' }) }),
      );
    });

    it('leaves it while the cap still refuses, and starts it on the sweep after the cap is raised', async () => {
      heldPatch();
      const { retry } = recovering();
      const { spendingLimits } = await import('@openadlc/db');
      vi.mocked(spendingLimits.refusal).mockResolvedValueOnce('janedoe/openadlc-testbed has spent $200 of its $200 this month');

      await retryAfterRecovery(null, { retry, now: () => NOW, costs: caps });
      expect(retry).not.toHaveBeenCalled();
      expect(store.tasks.find((task) => task.id === 't-patch')?.autoRetriedAt).toBeNull();

      await retryAfterRecovery(null, { retry, now: () => NOW, costs: caps });
      expect(retry.mock.calls.map(([id]) => id)).toEqual(['t-patch']);
    });

    it('is left to the sweep by a health run, which knows nothing of caps', async () => {
      heldPatch();
      const { retry, fixed } = recovering();

      await fixed(['bot-sign-in:bot-cipher']);

      expect(retry).not.toHaveBeenCalled();
    });
  });

  it('is run by the merge job, before the gates are worked out', async () => {
    store.tasks = [failed('t-a', 'openadlc-testbed#2')];
    store.health = [SIGN_IN_FIXED];
    const { retry } = recovering();
    const order: string[] = [];
    const scheduler = new Scheduler(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { advanceAll: async () => [] } as never,
      { resumeAnswered: async () => [] } as never,
      null,
      null,
      null,
      {
        retry: async (id: string, actor: string) => {
          order.push('retry');
          return retry(id, actor);
        },
        now: () => NOW,
      },
    );
    scheduler.settleGates = async () => {
      order.push('gates');
      return [];
    };

    const result = await scheduler.run('merge');

    expect(order).toEqual(['retry', 'gates']);
    expect(result.actions).toContain('openadlc-testbed#2: openadlc-cipher-janedoe’s review run again, now that bot-sign-in:bot-cipher passes');
  });
});

describe('a start GitHub did not answer for, run again on a backoff', () => {
  /**
   * On 2026-10-21 GitHub answered the bridge's refresh of a crew account with
   * a 503 page for about eighteen minutes: intake and builder tasks started
   * then failed for good, and sat until a person pressed Try again.
   */
  const NOW = new Date('2026-10-21T04:30:00.000Z');
  const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
  const UNANSWERED =
    "hostd refused: fleet-atlas-orzelig has no GitHub token yet: GitHub did not answer the refresh of account_fleet-atlas-orzelig's sign-in (GitHub returned a non-JSON response (503): <html>); it is asked again next time";

  function failedStart(id: string, endedAt: Date, overrides: Record<string, unknown> = {}) {
    return {
      id,
      botId: 'bot-intake',
      repoId: 'repo-1',
      kind: 'intake',
      subjectType: 'issue',
      subjectRef: 'openadlc-testbed#45',
      state: 'failed',
      startedAt: null,
      endedAt: endedAt.toISOString(),
      createdAt: new Date(endedAt.getTime() - 1000).toISOString(),
      exitReason: UNANSWERED,
      autoRetriedAt: null,
      ...overrides,
    };
  }

  /** Each retry records a new start of the same work, failed the same way until GitHub answers. */
  function recovering(now: () => Date) {
    store.repos = [{ id: 'repo-1', name: 'openadlc-testbed', fullName: 'janedoe/openadlc-testbed' }];
    let n = 0;
    let answers = false;
    const retry = vi.fn(async (id: string, _actor: string) => {
      const original = store.tasks.find((task) => task.id === id);
      const started = `retry-${++n}`;
      const at = now().toISOString();
      store.tasks.push({
        ...original,
        id: started,
        autoRetriedAt: null,
        createdAt: at,
        ...(answers ? { state: 'running', endedAt: null, exitReason: null } : { state: 'failed', endedAt: at, exitReason: UNANSWERED }),
      });
      return { task: { taskId: started, ...(answers ? {} : { error: UNANSWERED }) }, bot: 'fleet-atlas-orzelig' };
    });
    return {
      retry,
      sweep: () => retryAfterRecovery(null, { retry, now }),
      githubAnswers: () => {
        answers = true;
      },
    };
  }

  it('waits out each backoff, runs it again while GitHub does not answer, and it starts once GitHub does', async () => {
    let now = NOW;
    store.tasks = [failedStart('t-intake', later(-1))];
    const { retry, sweep, githubAnswers } = recovering(() => now);

    // A minute after it failed, and its first wait is two.
    expect(await sweep()).toEqual([]);
    expect(store.tasks[0]?.autoRetriedAt).toBeNull();

    now = later(2);
    expect(await sweep()).toEqual([
      'openadlc-testbed#45: fleet-atlas-orzelig’s intake run again (retry 1 of 6), as GitHub did not answer when it started',
    ]);
    // The start it recorded is left unclaimed: the next retry is its.
    expect(store.tasks.find((task) => task.id === 'retry-1')?.autoRetriedAt).toBeNull();

    // The second wait is five minutes from that start.
    now = later(6);
    await sweep();
    expect(retry).toHaveBeenCalledTimes(1);

    now = later(8);
    githubAnswers();
    await sweep();
    expect(retry.mock.calls.map(([id]) => id)).toEqual(['t-intake', 'retry-1']);
    expect(store.tasks.at(-1)).toMatchObject({ id: 'retry-2', state: 'running' });
    expect(store.audits).toContainEqual(
      expect.objectContaining({ action: 'task.auto_retried', payload: expect.objectContaining({ retried: 'retry-1', cause: 'github-unanswered' }) }),
    );
  });

  it('takes back a claim a bridge exited holding, once it is older than a retry takes, and leaves a newer one', async () => {
    store.tasks = [
      failedStart('t-stale', later(-25), { autoRetriedAt: later(-20).toISOString() }),
      // Another seat's, so only its claim holds it back.
      failedStart('t-fresh', later(-25), { botId: 'bot-builder', subjectRef: 'openadlc-testbed#46', autoRetriedAt: later(-5).toISOString() }),
    ];
    const { retry, sweep } = recovering(() => NOW);

    await sweep();

    expect(retry.mock.calls.map(([id]) => id)).toEqual(['t-stale']);
  });

  it('runs no more of a seat’s starts this pass once GitHub did not answer one of them again', async () => {
    const { tasks } = await import('@openadlc/db');
    store.tasks = [failedStart('t-45', later(-30)), failedStart('t-46', later(-30), { subjectRef: 'openadlc-testbed#46' })];
    const { retry, sweep } = recovering(() => NOW);
    // A seat with room for both, so room is not what holds the second back.
    const room = vi.mocked(tasks.seatHasRoom).getMockImplementation();
    vi.mocked(tasks.seatHasRoom).mockImplementation(async () => true);

    try {
      await sweep();
    } finally {
      vi.mocked(tasks.seatHasRoom).mockImplementation(room!);
    }
    expect(retry.mock.calls.map(([id]) => id)).toEqual(['t-45']);
    expect(store.tasks.find((task) => task.id === 't-46')?.autoRetriedAt).toBeNull();
  });

  it('stops, as landed, a start whose pull request closed since, rather than asking GitHub again on every sweep', async () => {
    store.tasks = [failedStart('t-review', later(-30), { kind: 'review', subjectType: 'pr', subjectRef: 'openadlc-testbed#47' })];
    const { retry, sweep } = recovering(() => NOW);
    // `retryTask`'s refusal once GitHub says the pull request is closed.
    retry.mockRejectedValue(new Error('already landed: openadlc-testbed#47 is closed, so there is nothing to run again'));

    expect(await sweep()).toEqual(['openadlc-testbed#47: not run again: already landed: openadlc-testbed#47 is closed, so the work it was for is finished']);
    expect(store.tasks[0]).toMatchObject({
      state: 'stopped',
      exitReason: 'already landed: openadlc-testbed#47 is closed, so the work it was for is finished',
    });
    expect(store.tasks[0]?.autoRetriedAt).not.toBeNull();

    // Every later sweep leaves it.
    await sweep();
    await sweep();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('is never a task that ran before it failed', async () => {
    store.tasks = [failedStart('t-resumed', later(-30), { startedAt: later(-90).toISOString() })];
    const { retry, sweep } = recovering(() => NOW);

    await sweep();

    expect(retry).not.toHaveBeenCalled();
  });

  it('leaves it for a person once every retry is spent', async () => {
    const { GITHUB_RETRY_MINUTES } = await import('./attention.js');
    store.tasks = [...GITHUB_RETRY_MINUTES, 0].map((_, index) => failedStart(`t-${index}`, later(-300 + index * 30)));
    const { retry, sweep } = recovering(() => NOW);

    expect(await sweep()).toEqual([]);
    expect(retry).not.toHaveBeenCalled();
  });

  it('is left to the sweep by a health run', async () => {
    store.tasks = [failedStart('t-intake', later(-30))];
    const { retry } = recovering(() => NOW);

    await retryAfterRecovery(['bot-sign-in:bot-intake'], { retry, now: () => NOW });

    expect(retry).not.toHaveBeenCalled();
  });

  it('never runs again on a backoff a start GitHub refused the sign-in for', async () => {
    store.tasks = [
      failedStart('t-intake', later(-30), {
        exitReason:
          "hostd refused: fleet-atlas-orzelig has no GitHub token: the bridge would not mint one (409) account_fleet-atlas-orzelig's GitHub authorization is no longer valid (bad_refresh_token). Reconnect it: openadlc auth login --bot fleet-atlas-orzelig",
      }),
    ];
    store.health = [{ id: 'bot-sign-in:bot-intake', state: 'failing', fixedAt: null }];
    const { retry, sweep } = recovering(() => NOW);

    await sweep();

    expect(retry).not.toHaveBeenCalled();
  });
});

describe('a failed build run again on its own, only where the dispatcher would start it', () => {
  const NOW = new Date('2026-09-29T12:00:00.000Z');
  const SIGN_IN_FAILURE = 'git push failed: remote: Bad credentials';
  const SIGN_IN_FIXED = { id: 'bot-sign-in:bot-cipher', state: 'ok', fixedAt: '2026-09-29T11:00:00.000Z' };

  function failedBuild(overrides: Record<string, unknown> = {}) {
    return {
      id: 't-build',
      botId: 'bot-cipher',
      repoId: 'repo-1',
      kind: 'implement',
      subjectType: 'issue',
      subjectRef: 'openadlc-testbed#7',
      state: 'failed',
      startedAt: '2026-09-29T10:00:00.000Z',
      endedAt: '2026-09-29T10:05:00.000Z',
      createdAt: '2026-09-29T10:00:00.000Z',
      exitReason: SIGN_IN_FAILURE,
      autoRetriedAt: null,
      ...overrides,
    };
  }

  function recovering(issue: Record<string, unknown> = {}, concurrency = 2) {
    store.repos = [{ id: 'repo-1', name: 'openadlc-testbed', fullName: 'janedoe/openadlc-testbed', defaultBranch: 'main', concurrency }];
    store.issues = [{ repoId: 'repo-1', repoName: 'openadlc-testbed', number: 7, stage: 'build', prNumber: null, labels: ['start:now'], declaredPaths: ['src/app.ts'], ...issue }];
    store.health = [SIGN_IN_FIXED];
    const retry = vi.fn(async (_id: string, _actor: string) => ({ task: null, bot: 'openadlc-cipher-janedoe' }));
    const deps = { retry, now: () => NOW };
    return { retry, fixed: () => retryAfterRecovery(['bot-sign-in:bot-cipher'], deps), sweep: () => retryAfterRecovery(null, deps) };
  }

  it('waits while a person has moved the card back to Design, and runs once it is in Build again', async () => {
    store.tasks = [failedBuild()];
    const { retry, fixed, sweep } = recovering({ stage: 'spec' });

    expect(await fixed()).toEqual([]);
    expect(retry).not.toHaveBeenCalled();
    expect(store.tasks[0]?.autoRetriedAt).toBeNull();

    (store.issues[0] as { stage: string }).stage = 'build';
    await sweep();
    expect(retry).toHaveBeenCalledWith('t-build', RECOVERY_ACTOR);
  });

  it('waits while the issue is labelled needs-human, and runs once the label is off', async () => {
    store.tasks = [failedBuild()];
    const { retry, fixed, sweep } = recovering({ labels: ['start:now', 'needs-human'] });

    await fixed();
    expect(retry).not.toHaveBeenCalled();
    expect(store.tasks[0]?.autoRetriedAt).toBeNull();

    (store.issues[0] as { labels: string[] }).labels = ['start:now'];
    await sweep();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('waits under needs-triage and do:human too, as the dispatcher does', async () => {
    for (const label of ['needs-triage', 'do:human']) {
      store.tasks = [failedBuild()];
      const { retry, fixed } = recovering({ labels: ['start:now', label] });
      await fixed();
      expect(retry, label).not.toHaveBeenCalled();
    }
  });

  it('waits while the repository is building as many things as its concurrency allows', async () => {
    store.tasks = [failedBuild(), { id: 't-other', botId: 'bot-builder', repoId: 'repo-1', kind: 'implement', subjectRef: 'openadlc-testbed#8', state: 'running', createdAt: '2026-09-29T11:00:00.000Z' }];
    const { retry, fixed } = recovering({}, 1);

    await fixed();

    expect(retry).not.toHaveBeenCalled();
    expect(store.tasks[0]?.autoRetriedAt).toBeNull();
  });

  it('waits while a build on the same files is in flight', async () => {
    store.tasks = [failedBuild()];
    store.inFlight = [{ number: 8, paths: ['src/app.ts'], building: true }];
    const { retry, fixed } = recovering();

    await fixed();

    expect(retry).not.toHaveBeenCalled();
    expect(store.tasks[0]?.autoRetriedAt).toBeNull();
  });

  it('runs one where nothing holds it', async () => {
    store.tasks = [failedBuild()];
    store.inFlight = [{ number: 8, paths: ['docs/guide.md'], building: true }];
    const { retry, fixed } = recovering();

    await fixed();

    expect(retry).toHaveBeenCalledWith('t-build', RECOVERY_ACTOR);
  });

  describe('a build continued without its pull request', () => {
    const LATER = new Date('2026-09-30T20:30:00.000Z');
    const BRANCH = 'agent/openadlc-atlas-janedoe/7-issue-7';
    const ended = () => failedBuild({ state: 'done', exitReason: 'complete', branch: BRANCH, startedAt: '2026-09-30T19:00:00.000Z', endedAt: '2026-09-30T19:56:30.000Z', createdAt: '2026-09-30T19:00:00.000Z' });

    function continuing(issue: Record<string, unknown> = {}, concurrency = 2) {
      recovering(issue, concurrency);
      const retry = vi.fn(async (_id: string, _actor: string) => ({ task: null, bot: 'openadlc-cipher-janedoe' }));
      const branch = vi.fn(async () => ({ pullRequest: null, ahead: 3 }));
      return { retry, branch, sweep: () => continueBuildsWithoutPullRequest({ retry, branch, now: () => LATER }) };
    }

    it('is left alone, unclaimed and not failed, while its issue is labelled needs-human or moved back', async () => {
      for (const issue of [{ labels: ['start:now', 'needs-human'] }, { stage: 'spec' }]) {
        store.tasks = [ended()];
        const { retry, branch, sweep } = continuing(issue);
        await sweep();
        expect(retry).not.toHaveBeenCalled();
        expect(branch).not.toHaveBeenCalled();
        expect(store.tasks[0]).toMatchObject({ state: 'done', autoRetriedAt: null });
      }
    });

    it('waits, unclaimed, while the repository has no room for another build', async () => {
      store.tasks = [ended(), { id: 't-other', botId: 'bot-builder', repoId: 'repo-1', kind: 'implement', subjectRef: 'openadlc-testbed#8', state: 'running', createdAt: '2026-09-30T20:00:00.000Z' }];
      const { retry, sweep } = continuing({}, 1);

      await sweep();

      expect(retry).not.toHaveBeenCalled();
      expect(store.tasks[0]).toMatchObject({ state: 'done', autoRetriedAt: null });
    });
  });
});

describe('a paused task whose question was answered', () => {
  it('is resumed by the merge job, though no retry of it is held in memory', async () => {
    store.tasks = [{ id: 't-answered', botId: 'bot-builder', repoId: null, kind: 'implement', skill: 'implement', subjectRef: 'openadlc-testbed#9', state: 'paused' }];
    store.answered = [{ ...store.tasks[0], answeredAt: '2026-10-01T09:00:00.000Z' }];
    const taskService = new TaskService({} as never, {} as never, {} as never);
    taskService.seatPauses = async () => ({});
    const resume = vi.fn(async (id: string) => {
      const task = store.tasks.find((one) => one.id === id);
      if (task) task.state = 'running';
    });
    taskService.resume = resume;
    const scheduler = new Scheduler({} as never, {} as never, {} as never, {} as never, {} as never, { advanceAll: async () => [] } as never, taskService as never);
    scheduler.settleGates = async () => [];

    const result = await scheduler.run('merge');

    expect(resume).toHaveBeenCalledWith('t-answered');
    expect(result.actions).toContain('resumed implement on openadlc-testbed#9, answered 2026-10-01T09:00:00.000Z');
  });
});

describe('a build that ended without its pull request', () => {
  const NOW = new Date('2026-09-30T20:30:00.000Z');
  const BRANCH = 'agent/openadlc-atlas-janedoe/216-issue-216';

  function build(id: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      botId: 'bot-builder',
      repoId: 'repo-1',
      kind: 'implement',
      subjectType: 'issue',
      subjectRef: 'openadlc-testbed#216',
      branch: BRANCH,
      state: 'done',
      startedAt: '2026-09-30T19:00:00.000Z',
      endedAt: '2026-09-30T19:56:30.000Z',
      createdAt: '2026-09-30T19:00:00.000Z',
      exitReason: 'complete',
      autoRetriedAt: null,
      ...overrides,
    };
  }

  /** The sweep, with GitHub saying `facts` of the branch and each retry starting a running build, claimed as `retryTask` claims it. */
  function sweeping(facts: { pullRequest: number | null; ahead: number } | null) {
    store.repos = [{ id: 'repo-1', name: 'openadlc-testbed', fullName: 'janedoe/openadlc-testbed', defaultBranch: 'main' }];
    store.issues = [{ repoId: 'repo-1', repoName: 'openadlc-testbed', number: 216, stage: 'build', prNumber: null, labels: [] }];
    const retry = vi.fn(async (id: string, _actor: string) => {
      const original = store.tasks.find((task) => task.id === id);
      store.tasks.push({ ...original, id: 'continued', state: 'running', endedAt: null, createdAt: '2026-09-30T20:30:01.000Z', autoRetriedAt: NOW.toISOString() });
      return { task: { taskId: 'continued' }, bot: 'openadlc-atlas-janedoe' };
    });
    const branch = vi.fn(async () => facts);
    return { retry, branch, sweep: () => continueBuildsWithoutPullRequest({ retry, branch, now: () => NOW }) };
  }

  it('goes on from its branch once when it pushed commits, and fails the second try that also opened none', async () => {
    store.tasks = [build('t-216')];
    const { retry, branch, sweep } = sweeping({ pullRequest: null, ahead: 3 });

    const actions = await sweep();
    expect(branch).toHaveBeenCalledWith('janedoe/openadlc-testbed', BRANCH, 'main');
    expect(retry.mock.calls).toEqual([['t-216', 'bridge']]);
    expect(store.tasks.find((task) => task.id === 't-216')?.autoRetriedAt).not.toBeNull();
    expect(store.audits).toContainEqual(expect.objectContaining({ action: 'task.continued', payload: expect.objectContaining({ continued: 't-216', task: 'continued' }) }));
    expect(actions).toEqual([`openadlc-testbed#216: openadlc-atlas-janedoe’s build ended without its pull request, so it goes on from ${BRANCH}`]);

    // The second try ends done, again with no pull request: it is failed,
    // with the reason the card knows, and not continued a third time.
    Object.assign(store.tasks.find((task) => task.id === 'continued') ?? {}, { state: 'done', endedAt: '2026-09-30T20:20:00.000Z' });
    await sweep();
    expect(retry).toHaveBeenCalledTimes(1);
    const second = store.tasks.find((task) => task.id === 'continued');
    expect(second).toMatchObject({ state: 'failed', exitReason: expect.stringMatching(/^finished without opening a pull request: its commits are on /) });
    expect(store.said).toEqual([expect.stringMatching(/^the build on openadlc-testbed#216 finished without opening a pull request/)]);
    // The first is left as it was: a later build took over from it.
    expect(store.tasks.find((task) => task.id === 't-216')?.state).toBe('done');
  });

  it('fails a build that pushed nothing, with a reason that says so', async () => {
    store.tasks = [build('t-216')];
    const { retry, sweep } = sweeping({ pullRequest: null, ahead: 0 });

    await sweep();
    expect(retry).not.toHaveBeenCalled();
    expect(store.tasks[0]).toMatchObject({ state: 'failed', exitReason: `finished without pushing a commit or opening a pull request: ${BRANCH} has no commits beyond the base` });
  });

  it('leaves a build alone whose pull request GitHub has, or that GitHub cannot be asked about', async () => {
    store.tasks = [build('t-216')];
    const withPull = sweeping({ pullRequest: 230, ahead: 0 });
    await withPull.sweep();
    expect(withPull.retry).not.toHaveBeenCalled();

    const unknown = sweeping(null);
    await unknown.sweep();
    expect(unknown.retry).not.toHaveBeenCalled();
    expect(store.tasks[0]).toMatchObject({ state: 'done', autoRetriedAt: null });
  });

  it('waits out the grace period for the pull request’s webhook, and never asks GitHub about a build whose issue has one', async () => {
    store.tasks = [build('t-216', { endedAt: '2026-09-30T20:29:00.000Z' })];
    const early = sweeping({ pullRequest: null, ahead: 3 });
    await early.sweep();
    expect(early.branch).not.toHaveBeenCalled();

    store.tasks = [build('t-216')];
    const linked = sweeping({ pullRequest: null, ahead: 3 });
    store.issues[0]!.prNumber = 230;
    await linked.sweep();
    expect(linked.branch).not.toHaveBeenCalled();
  });

  it('leaves a build that a later build took over from, one marked openadlc:ignore, or one whose issue has moved on', async () => {
    store.tasks = [build('t-216'), build('t-later', { state: 'running', createdAt: '2026-09-30T20:00:00.000Z', endedAt: null })];
    const later = sweeping({ pullRequest: null, ahead: 3 });
    await later.sweep();
    expect(later.branch).not.toHaveBeenCalled();

    store.tasks = [build('t-216')];
    const ignored = sweeping({ pullRequest: null, ahead: 3 });
    store.issues[0]!.labels = ['openadlc:ignore'];
    await ignored.sweep();
    expect(ignored.branch).not.toHaveBeenCalled();

    const moved = sweeping({ pullRequest: null, ahead: 3 });
    store.issues[0]!.stage = 'done';
    await moved.sweep();
    expect(moved.branch).not.toHaveBeenCalled();
  });

  it('looks only at builds that ended after the bridge started and within a lease’s length, so a deploy does not revive old ones', async () => {
    store.tasks = [build('t-216')];
    const { retry, branch } = sweeping({ pullRequest: null, ahead: 3 });
    // Ended before this bridge started.
    await continueBuildsWithoutPullRequest({ retry, branch, now: () => NOW, since: new Date('2026-09-30T20:00:00.000Z') });
    // Ended more than a lease (twelve hours) ago.
    store.tasks = [build('t-old', { createdAt: '2026-09-29T07:00:00.000Z', endedAt: '2026-09-29T08:00:00.000Z' })];
    await continueBuildsWithoutPullRequest({ retry, branch, now: () => NOW });
    expect(branch).not.toHaveBeenCalled();
    expect(store.tasks[0]).toMatchObject({ state: 'done' });
  });

  it('leaves a build on an issue GitHub says is closed, with or without commits', async () => {
    for (const ahead of [0, 3]) {
      store.tasks = [build('t-216')];
      const { retry, branch } = sweeping({ pullRequest: null, ahead });
      const closed = vi.fn(async () => true);
      await continueBuildsWithoutPullRequest({ retry, branch, closed, now: () => NOW });
      expect(closed).toHaveBeenCalledWith('janedoe/openadlc-testbed', 216);
      expect(retry).not.toHaveBeenCalled();
      expect(store.tasks[0]).toMatchObject({ state: 'done' });
    }
  });

  it('continues nothing where nothing dispatches, and looks again once a build’s pull request has had time to arrive', async () => {
    vi.useFakeTimers();
    try {
      const retry = vi.fn();
      const make = (dispatching: boolean) =>
        new Scheduler({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, null, null, null, { retry }, {
          dispatching,
          startedAt: new Date(0),
        });

      const off = make(false);
      const offLook = vi.spyOn(off, 'continueBuilds');
      expect(await off.continueBuilds()).toEqual([]);
      off.afterBuildEnded();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(offLook).toHaveBeenCalledTimes(1);

      const on = make(true);
      const onLook = vi.spyOn(on, 'continueBuilds').mockResolvedValue([]);
      on.afterBuildEnded();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onLook).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(90_000);
      expect(onLook).toHaveBeenCalledTimes(1);
      expect(retry).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives the claim back when the build could not be continued, so the next sweep tries', async () => {
    store.tasks = [build('t-216')];
    const { sweep } = sweeping({ pullRequest: null, ahead: 3 });
    const refusing = continueBuildsWithoutPullRequest({
      retry: vi.fn(async () => {
        throw new Error('nothing new starts: work is paused');
      }),
      branch: async () => ({ pullRequest: null, ahead: 3 }),
      now: () => NOW,
    });
    expect(await refusing).toEqual(['openadlc-testbed#216: the build without its pull request was not continued (nothing new starts: work is paused)']);
    expect(store.tasks[0]?.autoRetriedAt).toBeNull();
    await sweep();
    expect(store.tasks.find((task) => task.id === 'continued')).toBeDefined();
  });
});
