import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskState } from '@fleetadlc/shared';
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

vi.mock('@fleetadlc/db', async () => ({
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
    getBotById: vi.fn(async (id: string) => ({ id, name: 'fleetadlc-cipher-janedoe', engine: 'claude' })),
  },
  costs: { currentPeriod: vi.fn(() => '2026-09') },
  credentials: {},
  issues: {
    listIssues: vi.fn(async () => store.issues),
    setPullRequestNumber: vi.fn(async () => undefined),
    workInFlight: vi.fn(async () => store.inFlight),
  },
  leases: { expireStaleLeases: vi.fn(async () => []) },
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
    getSetting: vi.fn(async (key: string) => (key === 'testingDeploy' ? store.testingDeploy : null)),
  },
  tasks: {
    listTasks: vi.fn(async () => store.recentTasks),
    pausedWithAnswer: vi.fn(async () => store.answered),
    getTask: vi.fn(async (id: string) => store.tasks.find((task) => task.id === id) ?? null),
    // The real rule, so the sweep is tested against what the store writes.
    stoppedByPerson: (await vi.importActual<typeof import('@fleetadlc/db')>('@fleetadlc/db')).tasks.stoppedByPerson,
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
    updateTaskState: vi.fn(async (id: string, state: string, patch: { exitReason?: string | null } = {}) => {
      const task = store.tasks.find((one) => one.id === id);
      if (task) Object.assign(task, { state, exitReason: patch.exitReason ?? task.exitReason });
      return task ?? null;
    }),
  },
  threads: {
    ensureThread: vi.fn(async () => ({ id: 'thread-1' })),
    addMessage: vi.fn(async (message: { text: string }) => {
      store.said.push(message.text);
    }),
  },
}));

beforeEach(() => {
  store.issues = [];
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
    expect(locked).toBe('sydney cannot act on GitHub any more. Run: `fleetadlc auth login --bot sydney`.');
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
  repoName: 'fleetadlc',
  number: 45,
  prNumber: 145,
  labels: ['adlc:merged', 'priority:p1'],
  stage: 'merged',
};

const waiting: AwaitingDeploy = { repo: 'fleetadlc', number: 45, prNumber: 145 };

describe('which merged work is waiting on a testing deploy', () => {
  it('is a scheduled job, so fleetadlc status can list it', () => {
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
  newest: { fleetadlc: 145 } as Record<string, number | null>,
  priorDeploys: [] as { subjectRef: string; state: TaskState; exitReason?: string | null }[],
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
    expect(line).toContain('FLEETADLC_TESTING_URL');
    expect(line).toContain('fleetadlc#45');
    expect(line).not.toContain('started a testing deploy');
  });

  it('starts a deploy once per pull request, and the second look finds that task', () => {
    const first = planDeploySweep({ ...ready, waiting: [waiting] });
    expect(first).toEqual({ kind: 'work', start: { subjectRef: 'fleetadlc#145', repo: 'fleetadlc' }, hold: [] });

    const second = planDeploySweep({
      ...ready,
      waiting: [waiting],
      priorDeploys: [{ subjectRef: 'fleetadlc#145', state: 'running' }],
    });
    expect(second.kind).toBe('work');
    if (second.kind !== 'work') return;
    expect(second.start).toBeNull();
    expect(second.hold).toEqual(['fleetadlc#145: a testing deploy was already started (running)']);
  });

  it('tries again after a deploy that never ran', () => {
    // When hostd refuses, the task is saved as failed. Counting that as "a
    // deploy was started" meant every later firing said so, forever, about a
    // pull request that never reached testing — the case a backstop is for.
    const plan = planDeploySweep({
      ...ready,
      waiting: [waiting],
      priorDeploys: [
        { subjectRef: 'fleetadlc#145', state: 'failed', exitReason: 'hostd refused: harbor is busy' },
        { subjectRef: 'fleetadlc#145', state: 'stopped' },
      ],
    });
    expect(plan).toEqual({
      kind: 'work',
      start: {
        subjectRef: 'fleetadlc#145',
        repo: 'fleetadlc',
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
        { subjectRef: 'fleetadlc#145', state: 'stopped', exitReason: 'the session was killed; the branch and the issue are untouched' },
      ],
    });
    expect(plan.kind === 'work' && plan.start).toEqual({
      subjectRef: 'fleetadlc#145',
      repo: 'fleetadlc',
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
        { subjectRef: 'fleetadlc#145', state: 'stopped', exitReason: 'stopped by a person (janedoe): its session was killed' },
        { subjectRef: 'fleetadlc#145', state: 'failed' },
      ],
    });
    expect(plan.kind).toBe('work');
    if (plan.kind !== 'work') return;
    expect(plan.start).toBeNull();
    expect(plan.hold).toEqual([
      'fleetadlc#145: its last testing deploy was stopped on purpose (stopped by a person (janedoe): its session was killed); not starting another until a person does',
    ]);
  });

  it('does not start again a deploy whose plan change a person refused', () => {
    const plan = planDeploySweep({
      ...ready,
      waiting: [waiting],
      priorDeploys: [{ subjectRef: 'fleetadlc#145', state: 'stopped', exitReason: 'plan change refused by janedoe' }],
    });
    expect(plan.kind === 'work' && plan.start).toBeNull();
  });

  it('tries again once a person’s own retry of a stopped deploy failed: the newest deploy decides', () => {
    const plan = planDeploySweep({
      ...ready,
      waiting: [waiting],
      priorDeploys: [
        { subjectRef: 'fleetadlc#145', state: 'failed', exitReason: 'the workflow failed' },
        { subjectRef: 'fleetadlc#145', state: 'stopped', exitReason: 'stopped by a person (janedoe): its session was killed' },
      ],
    });
    expect(plan.kind === 'work' && plan.start && plan.start.subjectRef).toBe('fleetadlc#145');
  });

  it('does not repeat a deploy that finished, even though testing never labelled it', () => {
    // A finished deploy that left no label is a person's question, not another
    // task: the next one would finish the same way.
    const plan = planDeploySweep({
      ...ready,
      waiting: [waiting],
      priorDeploys: [
        { subjectRef: 'fleetadlc#145', state: 'failed' },
        { subjectRef: 'fleetadlc#145', state: 'done' },
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
        subjectRef: 'fleetadlc#145',
        state: 'failed' as const,
      })),
    });
    expect(plan.kind).toBe('work');
    if (plan.kind !== 'work') return;
    expect(plan.start).toBeNull();
    expect(plan.hold).toEqual([
      `fleetadlc#145: ${MAX_DEPLOY_ATTEMPTS} testing deploys failed or were interrupted; not trying again until a person looks`,
    ]);
  });

  it('does not invent a pull request for an issue that has none recorded', () => {
    const plan = planDeploySweep({ ...ready, waiting: [{ repo: 'fleetadlc', number: 45, prNumber: null }] });
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
    repo: 'fleetadlc',
    number: 29 + index,
    prNumber: 129 + index,
  }));

  it('deploys the newest merge once, not every merge that is waiting', () => {
    // Setting FLEETADLC_TESTING_URL used to start one deploy per historic merge,
    // one a firing, each spending up to the per-task cap.
    const plan = planDeploySweep({ ...ready, waiting: backlog });
    expect(plan.kind).toBe('work');
    if (plan.kind !== 'work') return;
    expect(plan.start).toEqual({ subjectRef: 'fleetadlc#145', repo: 'fleetadlc' });
    expect(plan.hold).toHaveLength(1);
    expect(plan.hold[0]).toContain('fleetadlc#129');
    expect(plan.hold[0]).toContain('older than fleetadlc#145, the newest merge');
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
    expect(plan.hold).toEqual([expect.stringContaining('older than fleetadlc#145, the newest merge')]);
  });

  it('deploys nothing when it cannot tell which merge is newest', () => {
    // No account to ask GitHub with, or GitHub did not answer. Any pick is a
    // guess, and a wrong guess moves testing backwards.
    const plan = planDeploySweep({ ...ready, waiting: backlog, newest: {} });
    expect(plan.kind === 'work' && plan.start).toBeNull();
    expect(plan.kind === 'work' && plan.hold[0]).toContain('cannot tell which merge is newest on fleetadlc');
  });

  it('starts one deploy a firing, however many repositories have one waiting', () => {
    // One deploy bot runs one task; a second start would only be refused as busy.
    const plan = planDeploySweep({
      ...ready,
      waiting: [waiting, { repo: 'console', number: 7, prNumber: 12 }],
      newest: { fleetadlc: 145, console: 12 },
    });
    expect(plan.kind).toBe('work');
    if (plan.kind !== 'work') return;
    expect(plan.start).toEqual({ subjectRef: 'fleetadlc#145', repo: 'fleetadlc' });
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
      subjectRef: `fleetadlc#${index}`,
      state: 'done',
    }));
    store.deployTasks = [{ subjectRef: 'fleetadlc#145', state: 'done' }];
    const { scheduler, open } = sweeper();

    const result = await scheduler.run('deploy');
    expect(open).not.toHaveBeenCalled();
    expect(result.actions).toEqual(['fleetadlc#145: a testing deploy was already started (done)']);
  });

  it('leaves a deploy a person stopped, and starts one whose session went away again, saying which', async () => {
    store.deployTasks = [{ subjectRef: 'fleetadlc#145', state: 'stopped', exitReason: 'stopped by a person (janedoe): its session was killed' }];
    const stopped = sweeper();
    expect((await stopped.scheduler.run('deploy')).actions).toEqual([
      'fleetadlc#145: its last testing deploy was stopped on purpose (stopped by a person (janedoe): its session was killed); not starting another until a person does',
    ]);
    expect(stopped.open).not.toHaveBeenCalled();

    store.deployTasks = [{ subjectRef: 'fleetadlc#145', state: 'stopped', exitReason: 'hostd shutting down' }];
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
    expect(open.mock.calls[0]?.[0]).toMatchObject({ kind: 'deploy', subjectRef: 'fleetadlc#145' });
    expect(result.actions[0]).toBe(
      'fleetadlc#143, fleetadlc#144: older than fleetadlc#145, the newest merge, whose deploy carries them',
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
    expect(third.actions).toEqual(['fleetadlc#145: a testing deploy was already started (running)']);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('moves an issue in Ship to Done when the repository has no testing deploy, and starts nothing', async () => {
    // Set, not inferred: the workflow file is still there. A closed issue sits
    // in Ship the same way — the sweep reads the stage, which stays merged
    // until this move.
    store.testingDeploy = JSON.stringify({ fleetadlc: 'none' });
    const { scheduler, open, moves } = sweeper();

    const result = await scheduler.run('deploy');

    expect(open).not.toHaveBeenCalled();
    expect(moves).toEqual([{ repoName: 'fleetadlc', issueNumber: 45, to: 'done', actor: 'bridge' }]);
    expect(result.actions).toEqual([
      'fleetadlc#45 moved to Done: no testing deploy for this repository',
      'nothing merged is waiting on a testing deploy',
    ]);
    expect(github.asked.some((path) => path.includes('/actions/workflows'))).toBe(false);
  });

  it('moves an issue that already reached testing to Done once the repository has no testing deploy', async () => {
    // No promote is coming for it either.
    store.testingDeploy = JSON.stringify({ fleetadlc: 'none' });
    store.issues = [{ ...merged, labels: [...merged.labels, 'deployed:testing'] }];
    const { scheduler, open, moves } = sweeper();

    const result = await scheduler.run('deploy');

    expect(open).not.toHaveBeenCalled();
    expect(moves).toEqual([{ repoName: 'fleetadlc', issueNumber: 45, to: 'done', actor: 'bridge' }]);
    expect(result.actions[0]).toBe('fleetadlc#45 moved to Done: no testing deploy for this repository');
  });

  it('still deploys when settings say there is a testing deploy, without asking which workflows exist', async () => {
    store.testingDeploy = JSON.stringify({ fleetadlc: 'has' });
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
    expect(result.actions[0]).toBe('fleetadlc#45 moved to Done: no testing deploy for this repository');
    expect(github.asked.some((path) => path.includes('/actions/workflows'))).toBe(true);

    github.workflows = null;
    github.asked = [];
    const unknown = sweeper();
    const again = await unknown.scheduler.run('deploy');
    expect(unknown.open).toHaveBeenCalledTimes(1);
    expect(again.actions.some((line) => line.startsWith('fleetadlc#45 moved to Done'))).toBe(false);
  });

  it('dispatches again a promote or rollback whose dispatch failed', async () => {
    // A promote with no soak the bridge held, and every rollback, were never
    // tried again: the comment said the sweep would, and nothing did.
    store.issues = [];
    const { scheduler } = sweeper();
    const pipeline = {
      checkRollbacks: vi.fn(async () => []),
      promoteDue: vi.fn(async () => []),
      sendBackDue: vi.fn(async () => []),
      retryUndispatched: vi.fn(async () => ['fleetadlc@abc1234: dispatched promote-production']),
    };
    scheduler.useDelivery(pipeline as never, { get: vi.fn() } as never);

    const result = await scheduler.run('deploy');

    expect(pipeline.retryUndispatched).toHaveBeenCalledTimes(1);
    expect(result.actions).toContain('fleetadlc@abc1234: dispatched promote-production');
  });

  it('looks at each dispatched rollback’s run before it promotes or dispatches again', async () => {
    // A rollback was dispatched and never looked at again: one cancelled
    // behind a promote, or never started, left production broken.
    store.issues = [];
    const { scheduler } = sweeper();
    const order: string[] = [];
    const pipeline = {
      checkRollbacks: vi.fn(async () => (order.push('check'), ['fleetadlc@abc1234: production was rolled back (rollback-production run 91)'])),
      promoteDue: vi.fn(async () => (order.push('promote'), [])),
      sendBackDue: vi.fn(async () => []),
      retryUndispatched: vi.fn(async () => (order.push('retry'), [])),
    };
    scheduler.useDelivery(pipeline as never, { get: vi.fn() } as never);

    const result = await scheduler.run('deploy');

    expect(order).toEqual(['check', 'promote', 'retry']);
    expect(result.actions).toContain('fleetadlc@abc1234: production was rolled back (rollback-production run 91)');
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
      (scheduler as unknown as { dispatchTesting(repo: string, subjectRef: string): Promise<string> }).dispatchTesting('fleetadlc', subjectRef);

    expect(await dispatch('fleetadlc#145')).toMatch(
      /^fleetadlc#145: no testing deploy was dispatched, because \S+ is not connected to GitHub\. Run: fleetadlc auth login --bot \S+$/,
    );
    expect(await dispatch('fleetadlc')).toBe('fleetadlc: no testing deploy was dispatched, because it names no pull request');
  });
});

describe('what a job run leaves in the event log', () => {
  it('records how many lines a job said, not the lines themselves', async () => {
    // Most jobs say the same few lines on every firing, reconcile every quarter
    // hour. The event says the job ran; what it said is in the bridge's log.
    const lines = Array.from({ length: 50 }, (_, index) => `fleetadlc#${index} is sitting in Spec with nobody on it`);
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
  const MARKER = '<!-- fleetadlc:job:dependency-update -->';
  function filer(pages: (page: number) => { number: number; body: string; user: { login: string } }[] | Error) {
    const requests: string[] = [];
    const posted: { title: string; body: string; labels: string[] }[] = [];
    const github = {
      viewer: async () => ({ login: 'fleetadlc-flow-janedoe', id: 1 }),
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
    const { scheduler, posted } = filer(() => [issue(41, 'fleetadlc-flow-janedoe', `shaped by triage\n\n${MARKER}`)]);

    expect((await scheduler.run('deps')).actions).toEqual(['Weekly dependency update: already open as #41']);
    expect(posted).toEqual([]);
  });

  it('finds its own issue past the first page, and lists only what the automation account opened', async () => {
    const { scheduler, requests } = filer((page) =>
      page === 1 ? Array.from({ length: 100 }, (_, index) => issue(index + 1, 'fleetadlc-flow-janedoe')) : [issue(150, 'fleetadlc-flow-janedoe', `update\n\n${MARKER}`)],
    );

    const result = await scheduler.run('deps');

    expect(result.actions).toEqual(['Weekly dependency update: already open as #150']);
    expect(requests[0]).toContain('creator=fleetadlc-flow-janedoe');
    expect(requests.some((one) => one.startsWith('POST'))).toBe(false);
  });

  it('does not take a stranger’s issue carrying the marker as its own', async () => {
    const { scheduler } = filer(() => [issue(5, 'stranger', MARKER)]);

    expect((await scheduler.run('deps')).actions).toEqual(['Weekly dependency update: filed as #900']);
  });

  it('says what GitHub said when it refuses the issue', async () => {
    const { GitHubApiError } = await import('@fleetadlc/github');
    const refusing = new Scheduler(
      { automationBot: 'flow' } as never,
      {} as never,
      {
        actors: {
          asBot: async () => ({
            viewer: async () => ({ login: 'fleetadlc-flow-janedoe', id: 1 }),
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
    expect(line).toMatch(/^would file "Weekly dependency update" \(\S+ is not connected to GitHub\. Run: fleetadlc auth login --bot \S+\)$/);
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
    store.repos = [{ name: 'fleetadlc', fullName: 'janedoe/fleetadlc' }];
  });

  it('opens a QA run per repository on its testing thread', async () => {
    const { scheduler, open } = nightly('https://testing.example');

    const result = await scheduler.run('qa');
    expect(open.mock.calls[0]?.[0]).toMatchObject({ bot: 'vega', kind: 'qa', skill: 'qa', subjectRef: 'fleetadlc#testing' });
    expect(result.actions).toEqual(['opened a QA run on fleetadlc#testing against https://testing.example (task task-qa)']);
  });

  it('refuses without a testing environment, in the words a promote repeats', async () => {
    const { scheduler, open } = nightly('');

    const result = await scheduler.run('qa');
    expect(open).not.toHaveBeenCalled();
    expect(result.actions).toEqual(["no testing environment is configured: set testing.url in the repository's .github/fleetadlc.yml (FLEETADLC_TESTING_URL is the deprecated fallback); not opening a QA task"]);
  });

  it('does not say it opened a QA run that hostd refused', async () => {
    // The task is saved as failed and nothing runs. "Opened" here is what a
    // promote would have passed on to the person deciding whether to approve.
    const { scheduler } = nightly(
      'https://testing.example',
      vi.fn(async () => ({ taskId: 'task-qa', session: null, error: 'hostd refused: no image for vega' })),
    );

    const result = await scheduler.run('qa');
    expect(result.actions).toEqual(['fleetadlc#testing: hostd refused: no image for vega']);
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
    expect(result.actions).toEqual(['GitHub deliveries are kept for good (FLEETADLC_EVENT_RETENTION_DAYS=0)']);
    expect(store.pruned).toEqual([]);
  });
});

describe('reconciling', () => {
  it('lets the crew into every repository as well, and says what changed', async () => {
    const ensureAll = vi.fn(async () => ['fleetadlc-atlas-janedoe can work in acme/web']);
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
    expect(result.actions).toEqual(['nothing has drifted: the board matches GitHub', 'fleetadlc-atlas-janedoe can work in acme/web']);
  });

  it('says which repository’s lease it expired, and that it expired rather than was released', async () => {
    const { leases } = await import('@fleetadlc/db');
    vi.mocked(leases.expireStaleLeases).mockResolvedValueOnce([{ repoId: 'repo-9', issueNumber: 12 }] as never);
    store.repos = [{ id: 'repo-9', name: 'widgets' }];
    const scheduler = new Scheduler({} as never, {} as never, {} as never, { run: async () => [] } as never, {} as never, {} as never, {} as never, null);

    const result = await scheduler.run('reconcile');

    expect(result.actions).toContain('expired the lease on widgets#12: it ran out with no pull request');
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

  it('is the issue in the repository FLEETADLC_STATUS_ISSUE names, whatever sorts first', async () => {
    vi.stubEnv('FLEETADLC_STATUS_ISSUE', 'org/web#12');
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
    vi.stubEnv('FLEETADLC_STATUS_ISSUE', '7');
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
        expect(reconciled.actions.join('\n')).toContain('did not post the drift to the status issue: FLEETADLC_STATUS_ISSUE is "7"; it must be');
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('gets only its own repository’s drift, and a count of the rest', async () => {
    vi.stubEnv('FLEETADLC_STATUS_ISSUE', 'org/web#12');
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
  // fleetadlc-testbed#2 had both reviews in and a gate held on a security review
  // a later decision no longer asked for. The gate is only worked out when
  // something happens to the pull request, and nothing more was coming.
  const BUILT = { user: { login: 'fleetadlc-atlas-janedoe' }, author_association: 'COLLABORATOR' };

  function sweep(options: { standing: { state: string; description: string } | null; gate: { state: 'pending' | 'success'; description: string } }) {
    store.repos = [{ id: 'repo-1', name: 'fleetadlc-testbed', fullName: 'janedoe/fleetadlc-testbed' }];
    store.issues = [
      // As the live install had it: nothing had ever recorded the pull request.
      { repoName: 'fleetadlc-testbed', number: 1, prNumber: null, stage: 'review', labels: ['adlc:review'] },
      { repoName: 'fleetadlc-testbed', number: 3, prNumber: null, stage: 'build', labels: ['adlc:build'] },
    ];
    const published: { state: string; description: string }[] = [];
    const entered: { repoName: string; prNumber: number; headSha: string }[] = [];
    const github = {
      getPullRequest: async (_repo: string, number: number) => ({
        number,
        draft: false,
        merged: false,
        state: 'open',
        headRef: 'agent/fleetadlc-atlas-janedoe/1-issue-1',
        headSha: 'abc123',
        baseRef: 'main',
        labels: [],
      }),
      request: async (_method: string, path: string) =>
        path.includes('/pulls?state=open')
          ? [
              { number: 2, draft: false, head: { ref: 'agent/fleetadlc-atlas-janedoe/1-issue-1', sha: 'abc123', repo: { full_name: 'janedoe/fleetadlc-testbed' } }, base: { ref: 'main' }, labels: [], ...BUILT },
              // Not an issue's branch, or not an issue in review: left alone.
              { number: 9, draft: false, head: { ref: 'dependabot/npm/x', sha: 'def456', repo: { full_name: 'janedoe/fleetadlc-testbed' } }, base: { ref: 'main' }, labels: [], ...BUILT },
              { number: 10, draft: false, head: { ref: 'agent/fleetadlc-atlas-janedoe/3-issue-3', sha: 'fed789', repo: { full_name: 'janedoe/fleetadlc-testbed' } }, base: { ref: 'main' }, labels: [], ...BUILT },
              // A stranger's fork, its branch named like the builder's: not the issue's.
              { number: 11, draft: false, head: { ref: 'agent/fleetadlc-atlas-janedoe/1-issue-1', sha: 'bad000', repo: { full_name: 'stranger/fleetadlc-testbed' } }, base: { ref: 'main' }, labels: [], user: { login: 'stranger' }, author_association: 'NONE' },
            ]
          : { statuses: options.standing ? [{ context: 'review-gate', ...options.standing }] : [] },
    };
    const scheduler = new Scheduler(
      { automationBot: 'flow' } as never,
      {} as never,
      {
        actors: { asBot: async () => github },
        reviewStanding: async () => ({ gate: options.gate, decision: { lead: 'fleetadlc-sydney-janedoe', reviewers: [], approvers: [] }, posted: [], approved: [], leadDue: null }),
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
      standing: { state: 'pending', description: 'waiting on fleetadlc-cipher-janedoe' },
      gate: { state: 'success', description: 'all required reviews are in' },
    });

    expect(await scheduler.settleGates()).toEqual(['fleetadlc-testbed#2: review gate is success (all required reviews are in)']);
    expect(published).toEqual([{ state: 'success', description: 'all required reviews are in' }]);
    expect(entered).toEqual([{ repoName: 'fleetadlc-testbed', prNumber: 2, headSha: 'abc123' }]);
  });

  it('finds the pull request from GitHub, and records it on the issue that had none', async () => {
    const { scheduler } = sweep({
      standing: { state: 'pending', description: 'waiting on irisexampleco' },
      gate: { state: 'pending', description: 'waiting on irisexampleco' },
    });
    const { issues } = await import('@fleetadlc/db');
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
      { id: 'repo-1', name: 'fleetadlc-testbed', fullName: 'janedoe/fleetadlc-testbed' },
      { id: 'repo-2', name: 'api', fullName: 'exampleco/api' },
    ];
    store.issues = [{ repoName: 'fleetadlc-testbed', number: 1, prNumber: 2, stage: 'review', labels: [] }];
    const pullOf = (fullName: string, number: number) => ({
      number,
      draft: false,
      head: { ref: 'agent/fleetadlc-atlas-janedoe/1-issue-1', sha: `sha-${number}`, repo: { full_name: fullName } },
      base: { ref: 'main' },
      labels: [],
      ...BUILT,
    });
    const github = {
      request: async (_method: string, path: string) =>
        path.includes('janedoe/fleetadlc-testbed/pulls?state=open')
          ? [pullOf('janedoe/fleetadlc-testbed', 2)]
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
          gate: { state: 'pending', description: 'waiting on fleetadlc-sydney-janedoe' },
          decision: { lead: 'fleetadlc-sydney-janedoe', reviewers: [], approvers: [] },
          posted: [],
          approved: [],
          leadDue: null,
        }),
        setReviewGate: async (input: { repoFullName: string; state: string; description: string }) => {
          asked.push(input.repoFullName);
          if (input.repoFullName === 'janedoe/fleetadlc-testbed') throw new Error('Resource not accessible by integration');
          return { state: input.state, description: input.description };
        },
      } as never,
      {} as never,
      {} as never,
      { enter: async () => undefined } as never,
      new TaskService({} as never, {} as never, {} as never) as never,
    );

    const actions = await scheduler.settleGates();

    expect(actions).toContain('fleetadlc-testbed#2: could not settle the review gate: Resource not accessible by integration');
    expect(asked).toEqual(['janedoe/fleetadlc-testbed', 'exampleco/api']);
  });
});

describe('a gate waiting on a reviewer that cannot sign in', () => {
  const BRANCH = 'agent/fleetadlc-atlas-janedoe/1-issue-1';
  const CIPHER = { id: 'bot-cipher', name: 'fleetadlc-cipher-janedoe', githubLogin: 'fleetadlc-cipher-janedoe' };
  const SIGNED_OUT = {
    id: 'bot-sign-in:bot-cipher',
    state: 'failing',
    title: 'fleetadlc-cipher-janedoe is signed out of GitHub',
    detail: 'Reconnect fleetadlc-cipher-janedoe from Settings → GitHub → Connected accounts.',
  };
  const WAITING = { state: 'pending' as const, description: 'waiting on fleetadlc-cipher-janedoe' };

  type Opened = { bot: string; kind: string; subjectRef: string; branch?: string | null; issueNumber?: number | null };

  // Pull request #2 of fleetadlc-testbed is issue #1's, and is in review.
  function sweeping(gate: { state: 'pending' | 'success'; description: string }, standing: { state: string; description: string } | null) {
    store.repos = [{ id: 'repo-1', name: 'fleetadlc-testbed', fullName: 'janedoe/fleetadlc-testbed' }];
    store.issues = [{ repoName: 'fleetadlc-testbed', number: 1, prNumber: 2, stage: 'review', labels: [] }];
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
                head: { ref: BRANCH, sha: 'abc123', repo: { full_name: 'janedoe/fleetadlc-testbed' } },
                base: { ref: 'main' },
                labels: [],
                user: { login: 'fleetadlc-atlas-janedoe' },
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
        reviewStanding: async () => ({ gate, decision: { lead: 'fleetadlc-sydney-janedoe', reviewers: [], approvers: [] }, posted: [], approved: [], leadDue: null }),
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
      { state: 'pending', description: 'waiting on the reviewer account: fleetadlc-cipher-janedoe cannot sign in to GitHub' },
    ]);
    expect(opened).toEqual([]);
  });

  it('starts the review by itself, and names the seat in the gate again, once the sign-in works', async () => {
    store.health = [{ ...SIGNED_OUT, state: 'passing' }];
    const standing = { state: 'pending', description: 'waiting on the reviewer account: fleetadlc-cipher-janedoe cannot sign in to GitHub' };
    const { scheduler, published, opened } = sweeping(WAITING, standing);

    const actions = await scheduler.settleGates();

    expect(published).toEqual([{ state: 'pending', description: 'waiting on fleetadlc-cipher-janedoe' }]);
    expect(opened).toEqual([
      expect.objectContaining({ bot: 'fleetadlc-cipher-janedoe', kind: 'review', subjectRef: 'fleetadlc-testbed#2', branch: BRANCH, issueNumber: 1 }),
    ]);
    expect(actions).toContainEqual(expect.stringContaining('fleetadlc-testbed#2: started fleetadlc-cipher-janedoe’s review'));
  });

  it('starts the review of a seat that could always sign in, though no event is coming for it', async () => {
    const { scheduler, opened } = sweeping(WAITING, WAITING);

    await scheduler.settleGates();

    expect(opened).toHaveLength(1);
  });

  it('leaves a seat that has a review under way, or one that ran and failed, alone', async () => {
    for (const state of ['running', 'failed']) {
      store.reviewTasks = [{ subjectRef: 'fleetadlc-testbed#2', state, botId: 'bot-cipher' }];
      const { scheduler, opened } = sweeping(WAITING, WAITING);
      await scheduler.settleGates();
      expect(opened).toEqual([]);
    }
  });

  it('starts a seat on round two whose review could not start at the push, though it reviewed round one', async () => {
    // Round one's review is done; round two's open found the seat busy and
    // recorded nothing. The seat now has room.
    store.reviewTasks = [{ subjectRef: 'fleetadlc-testbed#2', state: 'done', botId: 'bot-cipher', createdAt: '2026-10-01T09:00:00.000Z' }];
    store.roundAt = '2026-10-01T10:00:00.000Z';
    const { scheduler, opened } = sweeping(WAITING, WAITING);

    const actions = await scheduler.settleGates();

    expect(opened).toEqual([expect.objectContaining({ bot: 'fleetadlc-cipher-janedoe', kind: 'review', subjectRef: 'fleetadlc-testbed#2' })]);
    expect(actions).toContainEqual(expect.stringContaining('started fleetadlc-cipher-janedoe’s review'));
  });

  it('waits on a seat that is missing from its repository, saying so', async () => {
    store.health = [{ id: 'bot-access:bot-cipher:fleetadlc-testbed', state: 'failing', title: 'not in the repository', detail: 'Invite it.' }];
    const { scheduler, published, opened } = sweeping(WAITING, WAITING);

    await scheduler.settleGates();

    expect(published[0]?.description).toBe('waiting on the reviewer account: fleetadlc-cipher-janedoe cannot work in fleetadlc-testbed');
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
    vi.stubEnv('FLEETADLC_SCRIPTED_ENGINES', '1');
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
  const BRANCH = 'agent/fleetadlc-atlas-janedoe/1-issue-1';
  const LEAD = { id: 'bot-lead', name: 'fleetadlc-sydney-janedoe', githubLogin: 'fleetadlc-sydney-janedoe' };
  const HEAD = 'c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2';
  const WAITING = { state: 'pending' as const, description: 'waiting on fleetadlc-sydney-janedoe' };

  type Opened = { bot: string; subjectRef: string; extraContext?: { name: string }[] };

  // Pull request #2 of fleetadlc-testbed is issue #1's, in review, and only the
  // lead reviews it (a revert).
  function sweeping(leadDue: { seat: string; since: string | null } | null) {
    store.repos = [{ id: 'repo-1', name: 'fleetadlc-testbed', fullName: 'janedoe/fleetadlc-testbed' }];
    store.issues = [{ repoName: 'fleetadlc-testbed', number: 1, prNumber: 2, stage: 'review', labels: [] }];
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
                head: { ref: BRANCH, sha: HEAD, repo: { full_name: 'janedoe/fleetadlc-testbed' } },
                base: { ref: 'main' },
                labels: [{ name: 'deps' }],
                user: { login: 'fleetadlc-atlas-janedoe' },
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
    store.reviewTasks = [{ subjectRef: 'fleetadlc-testbed#2', state: 'done', botId: LEAD.id, createdAt: '2026-10-01T09:00:00.000Z' }];
    const { scheduler, opened } = sweeping({ seat: LEAD.name, since: '2026-10-01T10:00:00.000Z' });

    const actions = await scheduler.settleGates();

    expect(opened).toEqual([expect.objectContaining({ bot: LEAD.name, subjectRef: 'fleetadlc-testbed#2' })]);
    expect(actions).toContainEqual(expect.stringContaining('the lead’s, last'));
  });

  it('does not ask the lead twice for one diff', async () => {
    store.reviewTasks = [{ subjectRef: 'fleetadlc-testbed#2', state: 'done', botId: LEAD.id, createdAt: '2026-10-01T10:00:05.000Z' }];
    const { scheduler, opened } = sweeping({ seat: LEAD.name, since: '2026-10-01T10:00:00.000Z' });

    await scheduler.settleGates();

    expect(opened).toEqual([]);
  });

  it('opens the re-check of a lead-only resolution the lead was busy for at the push, with its brief', async () => {
    store.reviewTasks = [{ subjectRef: 'fleetadlc-testbed#2', state: 'done', botId: LEAD.id, createdAt: '2026-10-01T09:00:00.000Z' }];
    store.events = [
      {
        type: 'conflict.resolved',
        payload: { repo: 'fleetadlc-testbed', pr: 2, issue: 1, files: ['Makefile'], review: 'lead-only', from: 'b0'.repeat(20), to: HEAD, at: '2026-10-01T10:00:00.000Z' },
        at: '2026-10-01T10:00:00.000Z',
      },
    ];
    // The lead's approval of the head before the resolution carries, so the
    // standing does not say the lead is due.
    const { scheduler, opened } = sweeping(null);

    await scheduler.settleGates();
    expect(opened).toEqual([
      expect.objectContaining({ bot: LEAD.name, subjectRef: 'fleetadlc-testbed#2', extraContext: [expect.objectContaining({ name: 'resolution-check.md' })] }),
    ]);

    // Opened once: the next sweep finds it under way.
    store.reviewTasks.push({ subjectRef: 'fleetadlc-testbed#2', state: 'running', botId: LEAD.id, createdAt: '2026-10-01T10:05:00.000Z' });
    await scheduler.settleGates();
    expect(opened).toHaveLength(1);
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
      subjectRef: 'fleetadlc-testbed#2',
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
    store.repos = [{ id: 'repo-1', name: 'fleetadlc-testbed', fullName: 'janedoe/fleetadlc-testbed' }];
    store.issues = [{ repoName: 'fleetadlc-testbed', number: 1, prNumber: 2, stage: 'review', labels: [] }];
    const retry = vi.fn(async (_id: string, _actor: string) => {
      store.tasks.push(failed({ id: 't2', state: 'running', endedAt: null, exitReason: null, createdAt: '2026-09-29T12:00:01.000Z' }));
      return { task: { taskId: 't2' }, bot: 'fleetadlc-cipher-janedoe' };
    });
    return { retry, run: (fixed: string[]) => retryAfterRecovery(fixed, { retry, now: () => NOW }) };
  }

  it('is run again, once, and the retry is recorded', async () => {
    store.tasks = [failed()];
    const { retry, run } = recovering();

    const actions = await run(['bot-sign-in:bot-cipher']);

    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledWith('t1', RECOVERY_ACTOR);
    expect(actions).toEqual(['fleetadlc-testbed#2: fleetadlc-cipher-janedoe’s review run again, now that bot-sign-in:bot-cipher passes']);
    expect(store.audits).toEqual([
      {
        actor: RECOVERY_ACTOR,
        action: 'task.auto_retried',
        target: 'fleetadlc-testbed#2',
        payload: { retried: 't1', task: 't2', bot: 'fleetadlc-cipher-janedoe', kind: 'review', cause: 'bot-sign-in:bot-cipher' },
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
    retry.mockRejectedValueOnce(new Error('fleetadlc-cipher-janedoe is busy with another task'));

    const first = await run(['bot-sign-in:bot-cipher']);
    expect(first).toEqual(['fleetadlc-testbed#2: not run again (fleetadlc-cipher-janedoe is busy with another task)']);
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

  it('is left alone while its issue is labelled fleetadlc:ignore, and run again once the label is off', async () => {
    // A person told the crew to leave the issue alone; the recovery started
    // its failed review again anyway.
    store.tasks = [failed()];
    const { retry, run } = recovering();
    store.issues = [{ repoName: 'fleetadlc-testbed', number: 1, prNumber: 2, stage: 'review', labels: ['fleetadlc:ignore'] }];

    expect(await run(['bot-sign-in:bot-cipher'])).toEqual([]);
    expect(retry).not.toHaveBeenCalled();
    expect(store.tasks[0]?.autoRetriedAt).toBeNull();

    store.issues = [{ repoName: 'fleetadlc-testbed', number: 1, prNumber: 2, stage: 'review', labels: [] }];
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
    store.tasks = [failed({ exitReason: 'remote: Permission to janedoe/fleetadlc-testbed.git denied to fleetadlc-cipher-janedoe.' })];
    const { retry, run } = recovering();

    await run(['bot-access:bot-cipher:fleetadlc-testbed']);

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('is run again, stopped or failed, when the host comes back', async () => {
    store.tasks = [
      failed({ id: 't-stopped', state: 'stopped', exitReason: 'host stopped reporting' }),
      failed({ id: 't-other', botId: 'bot-lead', subjectRef: 'fleetadlc-testbed#5', exitReason: 'hostd did not answer' }),
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
    store.issues = [{ repoName: 'fleetadlc-testbed', number: 1, prNumber: 2, stage: 'merged', labels: [] }];

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
    store.repos = [{ id: 'repo-1', name: 'fleetadlc-testbed', fullName: 'janedoe/fleetadlc-testbed' }];
    store.issues = [];
    let n = 0;
    const retry = vi.fn(async (id: string, _actor: string) => {
      const original = store.tasks.find((task) => task.id === id);
      const started = `retry-${++n}`;
      store.tasks.push({ ...original, id: started, state: 'running', endedAt: null, exitReason: null, createdAt: `2026-09-29T12:00:0${n}.000Z` });
      return { task: { taskId: started }, bot: 'fleetadlc-cipher-janedoe' };
    });
    const deps = { retry, now: () => NOW };
    return { retry, fixed: (ids: string[]) => retryAfterRecovery(ids, deps), sweep: () => retryAfterRecovery(null, deps) };
  }

  it('runs both of one seat’s failures from an outage, one at a time, each once', async () => {
    store.tasks = [failed('t-a', 'fleetadlc-testbed#2'), failed('t-b', 'fleetadlc-testbed#3')];
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
    store.tasks = [failed('t-a', 'fleetadlc-testbed#2')];
    store.health = [SIGN_IN_FIXED];
    const { retry, fixed, sweep } = recovering();
    retry.mockRejectedValueOnce(new Error('fleetadlc-cipher-janedoe was not started: OpenADLC’s host service is not answering.'));

    await fixed(['bot-sign-in:bot-cipher']);
    await sweep();

    expect(retry.mock.calls.map(([id]) => id)).toEqual(['t-a', 't-a']);
    expect(store.audits).toHaveLength(1);
  });

  it('runs nothing whose check has not been put right since it failed', async () => {
    store.tasks = [failed('t-a', 'fleetadlc-testbed#2')];
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
      failed('t-patch', 'fleetadlc-testbed#2', {
        kind: 'patch',
        startedAt: null,
        exitReason:
          'fleetadlc-cipher-janedoe was not started: fleetadlc-cipher-janedoe cannot sign in to GitHub. Reconnect fleetadlc-cipher-janedoe from Settings → GitHub → Connected accounts.',
      }),
    ];
    store.health = [SIGN_IN_FIXED];
    const { retry, sweep } = recovering();

    const actions = await sweep();

    expect(retry.mock.calls.map(([id]) => id)).toEqual(['t-patch']);
    expect(actions).toEqual(['fleetadlc-testbed#2: fleetadlc-cipher-janedoe’s patch run again, now that bot-sign-in:bot-cipher passes']);
  });

  it('runs once more a revert that was recorded but never started, and never the task its retry records', async () => {
    // A red smoke's authorisation past a cap is not held for a task that a
    // retry records without starting (`retryTask`): the recovery claims that
    // task as it starts it, so it would never come back to spend the
    // authorisation.
    const NOT_SIGNED_IN =
      'fleetadlc-cipher-janedoe was not started: fleetadlc-cipher-janedoe cannot sign in to GitHub. Reconnect fleetadlc-cipher-janedoe from Settings → GitHub → Connected accounts.';
    store.tasks = [
      failed('t-revert', 'fleetadlc-testbed@deadbeef', {
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
      return { task: { taskId: 'retry-recorded' }, bot: 'fleetadlc-cipher-janedoe' };
    });

    await sweep();
    // The seat is put right again after the recorded retry failed.
    store.health = [{ ...SIGN_IN_FIXED, fixedAt: '2026-09-29T11:45:00.000Z' }];
    await sweep();

    expect(retry.mock.calls.map(([id]) => id)).toEqual(['t-revert']);
    expect(store.tasks.find((task) => task.id === 'retry-recorded')?.autoRetriedAt).not.toBeNull();
  });

  describe('work a spending cap held', () => {
    const HELD =
      'fleetadlc-cipher-janedoe was held at a spending cap: janedoe/fleetadlc-testbed has spent $200 of its $200 this month. ' +
      'It starts on its own once the cap allows it: raise the cap in Settings → Spending limits, or wait for the month to roll over.';
    const caps = { monthlyCapUsd: 1500, onCap: { stopLeasing: true } };

    function heldPatch() {
      store.tasks = [failed('t-patch', 'fleetadlc-testbed#2', { kind: 'patch', startedAt: null, exitReason: HELD })];
      store.health = [];
    }

    it('starts a patch round once the cap allows it, asking the cap for its own bot and repository', async () => {
      heldPatch();
      const { retry } = recovering();
      const { spendingLimits } = await import('@fleetadlc/db');
      vi.mocked(spendingLimits.refusal).mockClear();

      const actions = await retryAfterRecovery(null, { retry, now: () => NOW, costs: caps });

      expect(retry.mock.calls.map(([id]) => id)).toEqual(['t-patch']);
      expect(actions).toEqual(['fleetadlc-testbed#2: fleetadlc-cipher-janedoe’s patch started, now that the spending cap allows it']);
      expect(spendingLimits.refusal).toHaveBeenCalledWith(
        expect.objectContaining({ repoId: 'repo-1', repoLabel: 'janedoe/fleetadlc-testbed', botId: 'bot-cipher', onCap: caps.onCap }),
      );
      expect(store.audits).toContainEqual(
        expect.objectContaining({ action: 'task.auto_retried', payload: expect.objectContaining({ retried: 't-patch', cause: 'spending-cap' }) }),
      );
    });

    it('leaves it while the cap still refuses, and starts it on the sweep after the cap is raised', async () => {
      heldPatch();
      const { retry } = recovering();
      const { spendingLimits } = await import('@fleetadlc/db');
      vi.mocked(spendingLimits.refusal).mockResolvedValueOnce('janedoe/fleetadlc-testbed has spent $200 of its $200 this month');

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
    store.tasks = [failed('t-a', 'fleetadlc-testbed#2')];
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
    expect(result.actions).toContain('fleetadlc-testbed#2: fleetadlc-cipher-janedoe’s review run again, now that bot-sign-in:bot-cipher passes');
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
      subjectRef: 'fleetadlc-testbed#7',
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
    store.repos = [{ id: 'repo-1', name: 'fleetadlc-testbed', fullName: 'janedoe/fleetadlc-testbed', defaultBranch: 'main', concurrency }];
    store.issues = [{ repoId: 'repo-1', repoName: 'fleetadlc-testbed', number: 7, stage: 'build', prNumber: null, labels: ['start:now'], declaredPaths: ['src/app.ts'], ...issue }];
    store.health = [SIGN_IN_FIXED];
    const retry = vi.fn(async (_id: string, _actor: string) => ({ task: null, bot: 'fleetadlc-cipher-janedoe' }));
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
    store.tasks = [failedBuild(), { id: 't-other', botId: 'bot-builder', repoId: 'repo-1', kind: 'implement', subjectRef: 'fleetadlc-testbed#8', state: 'running', createdAt: '2026-09-29T11:00:00.000Z' }];
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
    const BRANCH = 'agent/fleetadlc-atlas-janedoe/7-issue-7';
    const ended = () => failedBuild({ state: 'done', exitReason: 'complete', branch: BRANCH, startedAt: '2026-09-30T19:00:00.000Z', endedAt: '2026-09-30T19:56:30.000Z', createdAt: '2026-09-30T19:00:00.000Z' });

    function continuing(issue: Record<string, unknown> = {}, concurrency = 2) {
      recovering(issue, concurrency);
      const retry = vi.fn(async (_id: string, _actor: string) => ({ task: null, bot: 'fleetadlc-cipher-janedoe' }));
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
      store.tasks = [ended(), { id: 't-other', botId: 'bot-builder', repoId: 'repo-1', kind: 'implement', subjectRef: 'fleetadlc-testbed#8', state: 'running', createdAt: '2026-09-30T20:00:00.000Z' }];
      const { retry, sweep } = continuing({}, 1);

      await sweep();

      expect(retry).not.toHaveBeenCalled();
      expect(store.tasks[0]).toMatchObject({ state: 'done', autoRetriedAt: null });
    });
  });
});

describe('a paused task whose question was answered', () => {
  it('is resumed by the merge job, though no retry of it is held in memory', async () => {
    store.tasks = [{ id: 't-answered', botId: 'bot-builder', repoId: null, kind: 'implement', skill: 'implement', subjectRef: 'fleetadlc-testbed#9', state: 'paused' }];
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
    expect(result.actions).toContain('resumed implement on fleetadlc-testbed#9, answered 2026-10-01T09:00:00.000Z');
  });
});

describe('a build that ended without its pull request', () => {
  const NOW = new Date('2026-09-30T20:30:00.000Z');
  const BRANCH = 'agent/fleetadlc-atlas-janedoe/216-issue-216';

  function build(id: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      botId: 'bot-builder',
      repoId: 'repo-1',
      kind: 'implement',
      subjectType: 'issue',
      subjectRef: 'fleetadlc-testbed#216',
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
    store.repos = [{ id: 'repo-1', name: 'fleetadlc-testbed', fullName: 'janedoe/fleetadlc-testbed', defaultBranch: 'main' }];
    store.issues = [{ repoId: 'repo-1', repoName: 'fleetadlc-testbed', number: 216, stage: 'build', prNumber: null, labels: [] }];
    const retry = vi.fn(async (id: string, _actor: string) => {
      const original = store.tasks.find((task) => task.id === id);
      store.tasks.push({ ...original, id: 'continued', state: 'running', endedAt: null, createdAt: '2026-09-30T20:30:01.000Z', autoRetriedAt: NOW.toISOString() });
      return { task: { taskId: 'continued' }, bot: 'fleetadlc-atlas-janedoe' };
    });
    const branch = vi.fn(async () => facts);
    return { retry, branch, sweep: () => continueBuildsWithoutPullRequest({ retry, branch, now: () => NOW }) };
  }

  it('goes on from its branch once when it pushed commits, and fails the second try that also opened none', async () => {
    store.tasks = [build('t-216')];
    const { retry, branch, sweep } = sweeping({ pullRequest: null, ahead: 3 });

    const actions = await sweep();
    expect(branch).toHaveBeenCalledWith('janedoe/fleetadlc-testbed', BRANCH, 'main');
    expect(retry.mock.calls).toEqual([['t-216', 'bridge']]);
    expect(store.tasks.find((task) => task.id === 't-216')?.autoRetriedAt).not.toBeNull();
    expect(store.audits).toContainEqual(expect.objectContaining({ action: 'task.continued', payload: expect.objectContaining({ continued: 't-216', task: 'continued' }) }));
    expect(actions).toEqual([`fleetadlc-testbed#216: fleetadlc-atlas-janedoe’s build ended without its pull request, so it goes on from ${BRANCH}`]);

    // The second try ends done, again with no pull request: it is failed,
    // with the reason the card knows, and not continued a third time.
    Object.assign(store.tasks.find((task) => task.id === 'continued') ?? {}, { state: 'done', endedAt: '2026-09-30T20:20:00.000Z' });
    await sweep();
    expect(retry).toHaveBeenCalledTimes(1);
    const second = store.tasks.find((task) => task.id === 'continued');
    expect(second).toMatchObject({ state: 'failed', exitReason: expect.stringMatching(/^finished without opening a pull request: its commits are on /) });
    expect(store.said).toEqual([expect.stringMatching(/^the build on fleetadlc-testbed#216 finished without opening a pull request/)]);
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

  it('leaves a build that a later build took over from, one marked fleetadlc:ignore, or one whose issue has moved on', async () => {
    store.tasks = [build('t-216'), build('t-later', { state: 'running', createdAt: '2026-09-30T20:00:00.000Z', endedAt: null })];
    const later = sweeping({ pullRequest: null, ahead: 3 });
    await later.sweep();
    expect(later.branch).not.toHaveBeenCalled();

    store.tasks = [build('t-216')];
    const ignored = sweeping({ pullRequest: null, ahead: 3 });
    store.issues[0]!.labels = ['fleetadlc:ignore'];
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
      expect(closed).toHaveBeenCalledWith('janedoe/fleetadlc-testbed', 216);
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
    expect(await refusing).toEqual(['fleetadlc-testbed#216: the build without its pull request was not continued (nothing new starts: work is paused)']);
    expect(store.tasks[0]?.autoRetriedAt).toBeNull();
    await sweep();
    expect(store.tasks.find((task) => task.id === 'continued')).toBeDefined();
  });
});
