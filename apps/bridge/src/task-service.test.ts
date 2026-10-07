import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const crew = vi.hoisted(() => [{ id: 'bot-1', name: 'builder', slot: 'builder', displayName: 'Builder', engine: 'claude', model: 'm' }]);
const store = vi.hoisted(() => ({
  crew: [] as Record<string, unknown>[],
  health: [] as Record<string, unknown>[],
  healthReadable: true,
  reviewTasks: [] as { botId: string; subjectRef: string; state: string }[],
  issues: [] as { repoName: string; number: number; prNumber: number | null; labels: string[] }[],
  /** When the current round of reviews began (`review.round_opened`), or null when none was recorded. */
  roundAt: null as string | null,
  /** Seats asked to review again after a bot dismissed their review (`review.asked_again`), as recorded. */
  askedAgain: [] as { at: string; payload: Record<string, string> }[],
}));

vi.mock('@fleetadlc/db', () => ({
  // No host has registered: room is not counted (`hosts.taskRoom`).
  hosts: { taskRoom: vi.fn(async () => null) },
  audit: vi.fn(async () => undefined),
  lastEventAt: vi.fn(async (type: string, fields: Record<string, string>) => {
    if (type !== 'review.asked_again') return store.roundAt;
    const found = store.askedAgain.filter((event) => Object.entries(fields).every(([key, value]) => event.payload[key] === value));
    return found.at(-1)?.at ?? null;
  }),
  recordEvent: vi.fn(async (event: { type: string; payload: Record<string, string> }) => {
    if (event.type === 'review.asked_again') store.askedAgain.push({ at: new Date().toISOString(), payload: event.payload });
    return 'event-1';
  }),
  hasEventOfType: vi.fn(async (type: string, _since: Date, fields: Record<string, string>) =>
    type === 'review.asked_again' && store.askedAgain.some((event) => Object.entries(fields).every(([key, value]) => event.payload[key] === value)),
  ),
  bots: {
    getBotById: vi.fn(async (id: string) => {
      const found = [...crew, ...store.crew].find((bot) => bot.id === id);
      return found ? { ...found } : null;
    }),
    getBotByName: vi.fn(async (name: string) => {
      const found = [...crew, ...store.crew].find((bot) => bot.name === name);
      return found ? { ...found } : null;
    }),
    listBots: vi.fn(async () => store.crew),
  },
  costs: { currentPeriod: vi.fn(() => '2026-09'), recordUsage: vi.fn(async () => undefined), ensureBudget: vi.fn(async () => undefined) },
  spendingLimits: {
    seedGlobal: vi.fn(async () => false),
    effectiveTaskCap: vi.fn(async (_repoId: string | null, fallback: number) => fallback),
    refusal: vi.fn(async () => null),
  },
  health: {
    listHealth: vi.fn(async () => {
      if (!store.healthReadable) throw new Error('relation "health" does not exist');
      return store.health;
    }),
  },
  leases: { settlePausedLeases: vi.fn(async () => ({ released: [], held: [] })) },
  issues: { listIssues: vi.fn(async (repo: string) => store.issues.filter((issue) => issue.repoName === repo)) },
  settings: { getSetting: vi.fn(async () => JSON.stringify({ 'api#1': { by: 'janedoe', at: '2026-10-02T10:00:00Z', why: 'waiting on design' } })) },
  repos: { listRepos: vi.fn(async () => []), getRepoByName: vi.fn(async () => null) },
  tasks: {
    getTask: vi.fn(),
    addTaskCost: vi.fn(async (_id: string, costUsd: number) => 14 + costUsd),
    updateTaskState: vi.fn(async () => null),
    countActiveTasksForBot: vi.fn(async () => 0),
    seatHasRoom: vi.fn(async () => true),
    liveTaskOn: vi.fn(async () => null),
    discardUnstarted: vi.fn(async () => undefined),
    pausedWithAnswer: vi.fn(async () => []),
    createTask: vi.fn(async (input: { botId: string }) => ({ id: 'task-2', ...input })),
    listTasksForSubjects: vi.fn(async (_kind: string, refs: readonly string[]) =>
      store.reviewTasks.filter((task) => refs.includes(task.subjectRef)),
    ),
  },
  threads: {
    ensureThread: vi.fn(async () => ({ id: 'thread-1' })),
    addMessage: vi.fn(async () => undefined),
    listGatesForTasks: vi.fn(async () => []),
  },
}));

import { audit, costs, hosts, leases, repos, spendingLimits, tasks, threads } from '@fleetadlc/db';
import type { BridgeConfig } from './config.js';
import type { Context } from './context.js';
import type { HostdClient } from './hostd-client.js';
import { causeOfFailure } from './health/checks/crew.js';
import {
  BotBusyError,
  HostFullError,
  ItemHeldError,
  PrerequisiteNotReadyError,
  SubjectBusyError,
  SpendingCapError,
  TaskService,
  UsageRefusedError,
  heldAtCap,
  isRevert,
  leaseHoldUntil,
  settleLeaseAfter,
  type BotQueue,
} from './task-service.js';

function service(hostd: Partial<HostdClient>): TaskService {
  return new TaskService({} as BridgeConfig, hostd as HostdClient, {} as Context);
}

beforeEach(() => {
  vi.mocked(tasks.updateTaskState).mockClear();
  vi.mocked(threads.addMessage).mockClear();
  vi.mocked(tasks.createTask).mockClear();
  vi.mocked(tasks.seatHasRoom).mockReset().mockResolvedValue(true);
  vi.mocked(tasks.liveTaskOn).mockReset().mockResolvedValue(null);
  vi.mocked(hosts.taskRoom).mockReset().mockResolvedValue(null);
  vi.mocked(tasks.getTask).mockResolvedValue({
    id: 'task-1',
    botId: 'bot-1',
    repoId: null,
    kind: 'implement',
    subjectRef: 'fleetadlc#155',
    skill: 'implement',
  } as never);
});

describe('resuming a task hostd will not start', () => {
  it('fails the task and says why in its thread', async () => {
    const refusal = new Error('this account cannot call claude-opus-4-6 — its opus models are claude-opus-5');
    const cleanupTask = vi.fn(async () => undefined);
    const tasksService = service({ resumeTask: vi.fn(async () => Promise.reject(refusal)), cleanupTask });

    await expect(tasksService.resume('task-1')).rejects.toBe(refusal);

    // It used to stay paused, with the reason only in the bridge's log.
    expect(tasks.updateTaskState).toHaveBeenCalledWith('task-1', 'failed', {
      exitReason: `hostd refused: ${refusal.message}`,
    });
    expect(threads.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-1',
        kind: 'sys',
        text: `could not resume implement: ${refusal.message}`,
      }),
    );
    expect(cleanupTask).toHaveBeenCalledWith('task-1', 'resume refused');
  });

  it('leaves a resumed task alone', async () => {
    const tasksService = service({ resumeTask: vi.fn(async () => ({ session: 'atlas/implement' })) });

    await tasksService.resume('task-1');

    expect(tasks.updateTaskState).not.toHaveBeenCalled();
    expect(threads.addMessage).not.toHaveBeenCalled();
  });
});

describe('a review seat’s part and lens', () => {
  const REVIEW = {
    maxRounds: 3,
    sendBack: { maxPerEdge: 2, maxPerIssue: 6 },
    reviewers: [{ seat: 'builder', lens: 'security', lead: false, blocking: true, trigger: 'always' }],
  };
  function reviewing(review: unknown) {
    const startTask = vi.fn(async (_input: object) => ({ session: 'builder/pr-review-task2', worktree: 'w' }));
    const resumeTask = vi.fn(async () => ({ session: 'builder/pr-review-task1' }));
    const tasksService = new TaskService(
      { costs: { perTaskCapUsd: 15, monthlyCapUsd: 1500 }, review } as unknown as BridgeConfig,
      { startTask, resumeTask } as unknown as HostdClient,
      { forSubject: async () => [] } as unknown as Context,
    );
    return { startTask, resumeTask, tasksService };
  }

  // The tests after these count the rows a refused open did not make.
  afterEach(() => vi.mocked(tasks.createTask).mockClear());

  it('is taken from the review rules and sent to hostd on a start and on a resume', async () => {
    const { startTask, resumeTask, tasksService } = reviewing(REVIEW);
    vi.mocked(tasks.getTask).mockResolvedValue({ id: 'task-1', botId: 'bot-1', repoId: null, kind: 'review', subjectRef: 'api#2', skill: 'pr-review' } as never);

    await tasksService.open({ bot: 'builder', kind: 'review', subjectType: 'pr', subjectRef: 'api#2', skill: 'pr-review' });
    await tasksService.resume('task-1');

    expect(startTask).toHaveBeenCalledWith(expect.objectContaining({ reviewMode: 'blocking', reviewLens: 'security' }));
    expect(resumeTask).toHaveBeenCalledWith('task-1', expect.any(Array), expect.any(String), expect.any(Array), 'blocking', 'security');
  });

  it('is advisory with no lens for a seat no rule names, rather than a guessed one', async () => {
    const { startTask, tasksService } = reviewing({ ...REVIEW, reviewers: [{ ...REVIEW.reviewers[0], seat: 'lead-reviewer' }] });

    await tasksService.open({ bot: 'builder', kind: 'review', subjectType: 'pr', subjectRef: 'api#2', skill: 'pr-review' });

    expect(startTask).toHaveBeenCalledWith(expect.objectContaining({ reviewMode: 'advisory' }));
    expect(startTask.mock.calls[0]?.[0]).not.toHaveProperty('reviewLens');
  });
});

describe('a paused lease when its task ends', () => {
  beforeEach(() => vi.mocked(leases.settlePausedLeases).mockClear());

  it.each(['done', 'failed', 'stopped'] as const)('is settled when the task %s, and the reason says so', async (state) => {
    await settleLeaseAfter({ leaseId: 'lease-78', state, subjectRef: 'fleetadlc#78' });

    expect(leases.settlePausedLeases).toHaveBeenCalledWith({
      leaseId: 'lease-78',
      actor: 'bridge',
      reason: `its task on fleetadlc#78 ${state === 'done' ? 'finished' : state}`,
      holdUntil: expect.any(Date),
    });
  });

  it('is left alone while the task has not ended, or when it had no lease', async () => {
    await settleLeaseAfter({ leaseId: 'lease-78', state: 'paused', subjectRef: 'fleetadlc#78' });
    await settleLeaseAfter({ leaseId: null, state: 'failed', subjectRef: 'request:abc' });

    expect(leases.settlePausedLeases).not.toHaveBeenCalled();
  });

  it('never fails the end of a task: the reconciler sweeps what this misses', async () => {
    vi.mocked(leases.settlePausedLeases).mockRejectedValueOnce(new Error('connection reset'));

    await expect(settleLeaseAfter({ leaseId: 'lease-78', state: 'failed', subjectRef: 'fleetadlc#78' })).resolves.toBeUndefined();
  });

  it('is settled when a resume after the answer cannot start, which is how that task ends', async () => {
    vi.mocked(tasks.getTask).mockResolvedValueOnce({
      id: 'task-1',
      botId: 'bot-1',
      repoId: null,
      kind: 'implement',
      subjectRef: 'fleetadlc#78',
      skill: 'implement',
      leaseId: 'lease-78',
      state: 'paused',
    } as never);
    const tasksService = service({ resumeTask: vi.fn(async () => Promise.reject(new Error('no model'))), cleanupTask: vi.fn(async () => undefined) });

    await expect(tasksService.resume('task-1')).rejects.toThrow('no model');

    expect(leases.settlePausedLeases).toHaveBeenCalledWith(expect.objectContaining({ leaseId: 'lease-78', reason: 'its task on fleetadlc#78 failed' }));
  });

  it('holds a lease put back in task for as long as the dispatcher leases an issue', () => {
    const now = new Date('2026-09-28T12:00:00.000Z');
    expect(leaseHoldUntil(now).toISOString()).toBe('2026-09-29T00:00:00.000Z');
  });
});

describe('resuming a task whose plan change was refused', () => {
  const refused = {
    id: 'task-1',
    botId: 'bot-1',
    repoId: null,
    kind: 'implement',
    subjectRef: 'fleetadlc#155',
    skill: 'implement',
    state: 'stopped',
    exitReason: 'plan change refused by alexsmith',
  };

  it('cleans it up and starts nothing: every caller that answers a gate resumes the task that asked', async () => {
    vi.mocked(tasks.getTask).mockResolvedValueOnce(refused as never);
    const resumeTask = vi.fn(async () => ({ session: 'builder/implement' }));
    const cleanupTask = vi.fn(async () => undefined);

    await service({ resumeTask, cleanupTask }).resume('task-1');

    expect(cleanupTask).toHaveBeenCalledWith('task-1', 'plan change refused by alexsmith');
    expect(resumeTask).not.toHaveBeenCalled();
    expect(tasks.updateTaskState).not.toHaveBeenCalled();
  });

  it('is done even when hostd cannot clean up, since the task is already stopped', async () => {
    vi.mocked(tasks.getTask).mockResolvedValueOnce(refused as never);
    const cleanupTask = vi.fn(async () => Promise.reject(new Error('hostd is down')));

    await expect(service({ resumeTask: vi.fn(), cleanupTask }).resume('task-1')).resolves.toBeUndefined();
  });

  it('is not what a task stopped for another reason gets: that one is resumed as before', async () => {
    vi.mocked(tasks.getTask).mockResolvedValueOnce({ ...refused, exitReason: 'stopped by an operator' } as never);
    const resumeTask = vi.fn(async () => ({ session: 'builder/implement' }));

    await service({ resumeTask, cleanupTask: vi.fn() }).resume('task-1');

    expect(resumeTask).toHaveBeenCalled();
  });

  it('is not what a paused task gets, even with the words in its reason', async () => {
    vi.mocked(tasks.getTask).mockResolvedValueOnce({ ...refused, state: 'paused' } as never);
    const resumeTask = vi.fn(async () => ({ session: 'builder/implement' }));
    const cleanupTask = vi.fn();

    await service({ resumeTask, cleanupTask }).resume('task-1');

    expect(resumeTask).toHaveBeenCalled();
    expect(cleanupTask).not.toHaveBeenCalled();
  });
});

describe('resuming a paused task whose work has already landed', () => {
  const fleetadlc = { id: 'repo-1', name: 'fleetadlc', fullName: 'acme/fleetadlc' };
  const paused = { id: 'task-1', botId: 'bot-1', repoId: 'repo-1', kind: 'review', subjectRef: 'fleetadlc#193', skill: 'pr-review', state: 'paused', leaseId: null };

  beforeEach(() => {
    vi.mocked(repos.listRepos).mockImplementation((async () => [fleetadlc]) as never);
  });
  afterEach(() => {
    vi.mocked(repos.listRepos).mockImplementation((async () => []) as never);
  });

  it('is refused on a merged pull request: the bot is not started, the task is stopped and cleaned up', async () => {
    vi.mocked(tasks.getTask).mockResolvedValueOnce(paused as never);
    const resumeTask = vi.fn(async () => ({ session: 'reviewer/review' }));
    const cleanupTask = vi.fn(async () => undefined);
    const closed = vi.fn(async () => true);
    const tasksService = new TaskService({} as BridgeConfig, { resumeTask, cleanupTask } as unknown as HostdClient, { forSubject: vi.fn(async () => []) } as unknown as Context, undefined, closed);

    await tasksService.resume('task-1');

    expect(closed).toHaveBeenCalledWith('acme/fleetadlc', 193);
    expect(resumeTask).not.toHaveBeenCalled();
    expect(tasks.updateTaskState).toHaveBeenCalledWith('task-1', 'stopped', { exitReason: expect.stringMatching(/^already landed: fleetadlc#193 is closed/) });
    expect(cleanupTask).toHaveBeenCalledWith('task-1', expect.stringMatching(/^already landed/));
    expect(threads.addMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('not resumed: already landed') }));
  });

  it('resumes as before while the subject is open, or cannot be read', async () => {
    for (const closed of [vi.fn(async () => false), vi.fn(async () => Promise.reject(new Error('GitHub is down')))]) {
      vi.mocked(tasks.getTask).mockResolvedValueOnce(paused as never);
      const resumeTask = vi.fn(async () => ({ session: 'reviewer/review' }));
      const tasksService = new TaskService({} as BridgeConfig, { resumeTask } as unknown as HostdClient, { forSubject: vi.fn(async () => []) } as unknown as Context, undefined, closed);

      await tasksService.resume('task-1');

      expect(resumeTask).toHaveBeenCalled();
    }
  });

  it('resumes a deploy on a merged pull request, whose work starts there', async () => {
    vi.mocked(tasks.getTask).mockResolvedValueOnce({ ...paused, kind: 'deploy', skill: 'deploy' } as never);
    const resumeTask = vi.fn(async () => ({ session: 'sre/deploy' }));
    const tasksService = new TaskService({} as BridgeConfig, { resumeTask } as unknown as HostdClient, { forSubject: vi.fn(async () => []) } as unknown as Context, undefined, vi.fn(async () => true));

    await tasksService.resume('task-1');

    expect(resumeTask).toHaveBeenCalled();
  });

  it('cleans up a task an answer on landed work already ended, without starting it', async () => {
    vi.mocked(tasks.getTask).mockResolvedValueOnce({ ...paused, state: 'stopped', exitReason: 'already landed: fleetadlc#193 is closed, so the work it was for is finished' } as never);
    const resumeTask = vi.fn();
    const cleanupTask = vi.fn(async () => undefined);

    await service({ resumeTask, cleanupTask }).resume('task-1');

    expect(resumeTask).not.toHaveBeenCalled();
    expect(cleanupTask).toHaveBeenCalled();
  });
});

describe('resuming a paused task in a repository since removed from OpenADLC', () => {
  const removed = { id: 'repo-api', name: 'api', fullName: 'acme/api', removedAt: '2026-09-24T09:00:00.000Z' };
  const pausedThere = { id: 'task-1', botId: 'bot-1', repoId: 'repo-api', kind: 'implement', state: 'paused', subjectRef: 'api#12', skill: 'implement', leaseId: 'lease-12' };

  afterEach(() => {
    vi.mocked(repos.listRepos).mockImplementation((async () => []) as never);
  });

  it('stops it instead: an answer must not start work in a repository OpenADLC has left', async () => {
    // Removal stops a paused task and closes its question; one whose stop
    // failed is still paused, and is stopped here when somebody answers it.
    vi.mocked(repos.listRepos).mockImplementation((async (options?: { includeRemoved?: boolean }) =>
      options?.includeRemoved ? [removed] : []) as never);
    vi.mocked(tasks.getTask).mockResolvedValueOnce(pausedThere as never);
    const resumeTask = vi.fn();
    const cleanupTask = vi.fn(async () => undefined);

    await service({ resumeTask, cleanupTask }).resume('task-1');

    expect(resumeTask).not.toHaveBeenCalled();
    expect(tasks.updateTaskState).toHaveBeenCalledWith('task-1', 'stopped', { exitReason: 'not resumed: acme/api was removed from OpenADLC' });
    expect(cleanupTask).toHaveBeenCalledWith('task-1', 'not resumed: acme/api was removed from OpenADLC');
    expect(leases.settlePausedLeases).toHaveBeenCalledWith(expect.objectContaining({ leaseId: 'lease-12' }));
  });

  it('resumes it as always while the repository is still OpenADLC’s', async () => {
    vi.mocked(repos.listRepos).mockImplementation((async () => [{ ...removed, removedAt: null }]) as never);
    vi.mocked(tasks.getTask).mockResolvedValueOnce(pausedThere as never);
    const forSubject = vi.fn(async () => []);
    const resumeTask = vi.fn(async () => ({ session: 'builder/implement' }));
    const tasksService = new TaskService({} as BridgeConfig, { resumeTask } as unknown as HostdClient, { forSubject } as unknown as Context);

    await tasksService.resume('task-1');

    expect(resumeTask).toHaveBeenCalled();
    expect(forSubject).toHaveBeenCalledWith(expect.objectContaining({ repoFullName: 'acme/api', subjectNumber: 12 }));
  });
});

describe('a piece of work a person held on the board', () => {
  it('starts nothing new on the issue or its pull request, and says who held it', async () => {
    store.issues = [{ repoName: 'api', number: 1, prNumber: 2, labels: ['adlc:review', 'fleetadlc:paused'] }];
    vi.mocked(repos.getRepoByName).mockResolvedValue({ id: 'repo-api', name: 'api', fullName: 'exampleco/api' } as never);
    const startTask = vi.fn(async () => ({ session: 's', worktree: 'w' }));
    const tasksService = new TaskService(
      { costs: { perTaskCapUsd: 15, monthlyCapUsd: 1500 } } as BridgeConfig,
      { startTask } as unknown as HostdClient,
      { forSubject: async () => [] } as unknown as Context,
    );

    try {
      await expect(
        tasksService.open({ bot: 'builder', repo: 'api', kind: 'review', subjectType: 'pr', subjectRef: 'api#2', skill: 'pr-review' }),
      ).rejects.toThrow('api#1 is held by janedoe: waiting on design; resume it on its card');
      await expect(
        tasksService.open({ bot: 'builder', repo: 'api', kind: 'implement', subjectType: 'issue', subjectRef: 'api#1', skill: 'implement' }),
      ).rejects.toThrow(ItemHeldError);
      expect(tasks.createTask).not.toHaveBeenCalled();
      expect(startTask).not.toHaveBeenCalled();
    } finally {
      store.issues = [];
      vi.mocked(repos.getRepoByName).mockResolvedValue(null);
    }
  });
});

describe('a repository that has reached its month cap', () => {
  it('does not staff intake or open a review, and a task already running still resumes', async () => {
    const reason = 'exampleco/api has spent $200 of its $200 this month';
    vi.mocked(spendingLimits.refusal).mockResolvedValue(reason);
    vi.mocked(repos.getRepoByName).mockResolvedValue({ id: 'repo-api', name: 'api', fullName: 'exampleco/api' } as never);
    const startTask = vi.fn(async () => ({ session: 's', worktree: 'w' }));
    const resumeTask = vi.fn(async () => ({ session: 'builder/implement' }));
    const tasksService = new TaskService(
      { costs: { perTaskCapUsd: 15, monthlyCapUsd: 1500 } } as BridgeConfig,
      { startTask, resumeTask } as unknown as HostdClient,
      { forSubject: async () => [] } as unknown as Context,
    );

    try {
      await expect(
        tasksService.open({ bot: 'builder', repo: 'api', kind: 'intake', subjectType: 'issue', subjectRef: 'api#1', skill: 'triage' }),
      ).rejects.toThrow(reason);
      await expect(
        tasksService.open({ bot: 'builder', repo: 'api', kind: 'review', subjectType: 'pr', subjectRef: 'api#2', skill: 'pr-review' }),
      ).rejects.toThrow(reason);
      expect(tasks.createTask).not.toHaveBeenCalled();
      expect(startTask).not.toHaveBeenCalled();

      const global = 'month-to-date spend is $1500.00 of $1500.00; not leasing new work';
      vi.mocked(spendingLimits.refusal).mockClear();
      vi.mocked(spendingLimits.refusal).mockResolvedValueOnce(global);
      await expect(
        tasksService.open({ bot: 'builder', kind: 'intake', subjectType: 'request', subjectRef: 'request:a4b02784', skill: 'triage' }),
      ).rejects.toThrow(global);
      expect(spendingLimits.refusal).toHaveBeenCalledWith(expect.objectContaining({ repoId: null, botId: 'bot-1' }));
      expect(tasks.createTask).not.toHaveBeenCalled();

      vi.mocked(spendingLimits.refusal).mockClear();
      await tasksService.resume('task-1');
      expect(spendingLimits.refusal).not.toHaveBeenCalled();
      expect(resumeTask).toHaveBeenCalledWith('task-1', expect.any(Array), expect.any(String), expect.any(Array), undefined, undefined);
    } finally {
      vi.mocked(spendingLimits.refusal).mockResolvedValue(null);
      vi.mocked(repos.getRepoByName).mockResolvedValue(null);
    }
  });
});

describe('work only an event starts, at a monthly cap', () => {
  const reason = 'exampleco/api has spent $200 of its $200 this month';
  const onCap = { stopLeasing: true };

  function capped() {
    vi.mocked(spendingLimits.refusal).mockResolvedValue(reason);
    vi.mocked(repos.getRepoByName).mockResolvedValue({ id: 'repo-api', name: 'api', fullName: 'exampleco/api' } as never);
    vi.mocked(tasks.createTask).mockClear();
    vi.mocked(tasks.updateTaskState).mockClear();
    vi.mocked(threads.addMessage).mockClear();
    vi.mocked(audit).mockClear();
    const startTask = vi.fn(async () => ({ session: 's', worktree: 'w' }));
    const tasksService = new TaskService(
      { costs: { perTaskCapUsd: 15, monthlyCapUsd: 1500, onCap } } as BridgeConfig,
      { startTask } as unknown as HostdClient,
      { forSubject: async () => [] } as unknown as Context,
    );
    return { tasksService, startTask };
  }

  afterEach(() => {
    vi.mocked(spendingLimits.refusal).mockResolvedValue(null);
    vi.mocked(repos.getRepoByName).mockResolvedValue(null);
  });

  it('records a patch round as failed with the cap’s words, for the recovery to start once the cap allows', async () => {
    // It was thrown away before `whenBlocked` was read: the round after
    // changes requested was a line in the log, and never started.
    const { tasksService, startTask } = capped();

    const held = await tasksService.open({
      bot: 'builder',
      repo: 'api',
      kind: 'patch',
      subjectType: 'pr',
      subjectRef: 'api#7',
      skill: 'implement',
      branch: 'claude/3-thing',
      round: 2,
      leaseId: 'lease-1',
      whenBlocked: 'record',
    });

    const words = new SpendingCapError('builder', reason).message;
    expect(words).toBe(
      `builder was held at a spending cap: ${reason}. It starts on its own once the cap allows it: raise the cap in Settings → Spending limits, or wait for the month to roll over.`,
    );
    expect(held).toEqual({ taskId: 'task-2', session: null, error: words });
    expect(tasks.createTask).toHaveBeenCalledWith(expect.objectContaining({ kind: 'patch', subjectRef: 'api#7', round: 2, leaseId: 'lease-1' }));
    expect(tasks.updateTaskState).toHaveBeenCalledWith('task-2', 'failed', { exitReason: words });
    expect(startTask).not.toHaveBeenCalled();
    expect(spendingLimits.refusal).toHaveBeenCalledWith(expect.objectContaining({ onCap, repoId: 'repo-api' }));
    // What the recovery reads it back by, and not as a health check's cause.
    expect(heldAtCap(words)).toBe(true);
    expect(causeOfFailure(words, { botId: 'bot-1', repoName: 'api' })).toBeNull();
  });

  it('records the verification after a deploy the same way', async () => {
    const { tasksService, startTask } = capped();

    const held = await tasksService.open({
      bot: 'builder',
      repo: 'api',
      kind: 'qa',
      subjectType: 'pr',
      subjectRef: 'api#7',
      skill: 'qa',
      whenBlocked: 'record',
    });

    expect(heldAtCap(held.error)).toBe(true);
    expect(startTask).not.toHaveBeenCalled();
  });

  it('refuses with a SpendingCapError, recording nothing, where a sweep comes back for the work', async () => {
    const { tasksService } = capped();

    await expect(
      tasksService.open({ bot: 'builder', repo: 'api', kind: 'review', subjectType: 'pr', subjectRef: 'api#7', skill: 'pr-review' }),
    ).rejects.toBeInstanceOf(SpendingCapError);
    expect(tasks.createTask).not.toHaveBeenCalled();
  });

  const revert = {
    bot: 'builder',
    repo: 'api',
    kind: 'deploy' as const,
    subjectType: 'merge' as const,
    subjectRef: 'api@0123abcd',
    skill: 'deploy',
    branch: 'system/revert-0123abcd',
    whenBlocked: 'record' as const,
  };

  it('starts a revert past the cap only with leave to, and audits who gave it', async () => {
    const { tasksService, startTask } = capped();

    const started = await tasksService.open({ ...revert, bypassCap: { by: 'bridge', why: 'the first revert of a commit after a red smoke test' } });

    expect(started).toEqual({ taskId: 'task-2', session: 's' });
    expect(startTask).toHaveBeenCalledWith(expect.objectContaining({ kind: 'deploy', branch: 'system/revert-0123abcd', costCapUsd: 15 }));
    expect(audit).toHaveBeenCalledWith({
      actor: 'bridge',
      action: 'spending.cap_bypassed',
      target: 'api@0123abcd',
      payload: { taskId: 'task-2', bot: 'builder', kind: 'deploy', refusal: reason, why: 'the first revert of a commit after a red smoke test' },
    });
    expect(threads.addMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('started past a spending cap') }));
  });

  it('holds a revert without leave at the cap, however revert-shaped it is', async () => {
    // Its shape let it past once, and a red smoke can be asked for again
    // and again.
    const { tasksService, startTask } = capped();

    const held = await tasksService.open(revert);

    expect(heldAtCap(held.error)).toBe(true);
    expect(startTask).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('knows a revert by its shape, and nothing else as one', () => {
    expect(isRevert({ kind: 'deploy', subjectType: 'merge', branch: 'system/revert-0123abcd' })).toBe(true);
    expect(isRevert({ kind: 'deploy', subjectType: 'merge', branch: 'main' })).toBe(false);
    expect(isRevert({ kind: 'deploy', subjectType: 'pr', branch: 'system/revert-0123abcd' })).toBe(false);
    expect(isRevert({ kind: 'patch', subjectType: 'merge', branch: 'system/revert-0123abcd' })).toBe(false);
  });
});

describe('the cap a new task starts with', () => {
  it('is the lower of the global and the repository per-task limits', async () => {
    vi.mocked(spendingLimits.effectiveTaskCap).mockResolvedValueOnce(5);
    vi.mocked(repos.getRepoByName).mockResolvedValueOnce({ id: 'repo-api', name: 'api' } as never);
    const startTask = vi.fn(async () => ({ session: 's', worktree: 'w' }));
    const tasksService = new TaskService(
      { costs: { perTaskCapUsd: 15, monthlyCapUsd: 1500 } } as BridgeConfig,
      { startTask } as unknown as HostdClient,
      { forSubject: async () => [] } as unknown as Context,
    );

    await tasksService.open({
      bot: 'builder',
      kind: 'implement',
      subjectType: 'issue',
      subjectRef: 'api#1',
      skill: 'implement',
      repo: 'api',
    });

    expect(tasks.createTask).toHaveBeenCalledWith(expect.objectContaining({ costCapUsd: 5, repoId: 'repo-api' }));
    expect(startTask).toHaveBeenCalledWith(expect.objectContaining({ costCapUsd: 5 }));
  });
});

describe('opening a task on a seat that runs several at once', () => {
  const OPEN = { bot: 'builder', botId: 'bot-1', kind: 'implement' as const, subjectType: 'issue' as const, subjectRef: 'fleetadlc#7', skill: 'implement' };

  function opener(startTask: HostdClient['startTask'] = vi.fn(async () => ({ session: 's', worktree: 'w' }))) {
    return new TaskService(
      { costs: { perTaskCapUsd: 5 } } as BridgeConfig,
      { startTask } as unknown as HostdClient,
      { forSubject: async () => [] } as unknown as Context,
    );
  }

  beforeEach(() => {
    vi.mocked(tasks.createTask).mockClear();
    vi.mocked(tasks.seatHasRoom).mockReset().mockResolvedValue(true);
    vi.mocked(tasks.liveTaskOn).mockReset().mockResolvedValue(null);
    vi.mocked(hosts.taskRoom).mockReset().mockResolvedValue(null);
  });

  it('starts a task while the seat has room, whatever else it is running', async () => {
    // One task per seat was the collision guarantee when a seat was a
    // container; each task has a computer of its own now.
    await opener().open(OPEN);

    expect(tasks.seatHasRoom).toHaveBeenCalledWith('bot-1');
    expect(tasks.createTask).toHaveBeenCalled();
  });

  it('keeps a stacked build’s base and its brief on the task, which hostd gives it again when it resumes', async () => {
    const brief = { name: 'stacked-on.md', title: 'Built on #6, still in review', content: 'Your branch starts from agent/builder/6-issue-6.' };

    await opener().open({ ...OPEN, baseRef: 'refs/heads/agent/builder/6-issue-6', extraContext: [brief] });
    await opener().open({ ...OPEN, extraContext: [brief] });

    expect(vi.mocked(tasks.createTask).mock.calls[0]?.[0]).toMatchObject({ baseRef: 'refs/heads/agent/builder/6-issue-6', baseContext: [brief] });
    // Only a task that starts off the default branch keeps one.
    expect(vi.mocked(tasks.createTask).mock.calls[1]?.[0]).not.toHaveProperty('baseRef');
  });

  it('is busy, and says how to raise it, when the seat runs all it may at once', async () => {
    vi.mocked(tasks.seatHasRoom).mockResolvedValue(false);

    const refused = opener().open(OPEN);

    await expect(refused).rejects.toBeInstanceOf(BotBusyError);
    await expect(refused).rejects.toThrow(/all it may run at once; .*tasks at once on the Crew page/);
    expect(tasks.createTask).not.toHaveBeenCalled();
  });

  it('never starts the same work twice on one seat, and says so as busy work', async () => {
    vi.mocked(tasks.liveTaskOn).mockResolvedValue({ id: 'task-already' } as never);

    const refused = opener().open(OPEN);

    await expect(refused).rejects.toBeInstanceOf(SubjectBusyError);
    await expect(refused).rejects.toBeInstanceOf(BotBusyError);
    await expect(refused).rejects.toThrow('builder is already working on fleetadlc#7; it is not started twice');
    expect(tasks.createTask).not.toHaveBeenCalled();
  });

  it('reads two starts of the same work at once, which the index refuses, as the same', async () => {
    vi.mocked(tasks.createTask).mockRejectedValueOnce(
      Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505', constraint: 'tasks_one_live_per_bot_subject' }),
    );

    await expect(opener().open(OPEN)).rejects.toBeInstanceOf(SubjectBusyError);
  });

  it('records nothing beside work the seat is already running, even work recorded rather than started', async () => {
    // A patch round held at a cap is recorded as failed; the index refuses a
    // second row while the same seat runs the same subject.
    vi.mocked(spendingLimits.refusal).mockResolvedValueOnce('the month is spent');
    vi.mocked(tasks.createTask).mockRejectedValueOnce(
      Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505', constraint: 'tasks_one_live_per_bot_subject' }),
    );

    await expect(opener().open({ ...OPEN, whenBlocked: 'record' })).rejects.toBeInstanceOf(SubjectBusyError);
  });

  it('is busy, not failed, when every host runs all it has room for, before anything is recorded', async () => {
    vi.mocked(hosts.taskRoom).mockResolvedValue(0);

    const refused = opener().open(OPEN);

    await expect(refused).rejects.toBeInstanceOf(HostFullError);
    await expect(refused).rejects.toThrow(/FLEETADLC_HOST_CAPACITY_TASKS/);
    expect(tasks.createTask).not.toHaveBeenCalled();
  });

  it('takes back the row of a start hostd refused for want of room, rather than failing it', async () => {
    const full = Object.assign(new Error('POST /tasks → 503: {"error":"host-a is running 4 task(s), all it has room for"}'), { status: 503 });

    const refused = opener(vi.fn(async () => Promise.reject(full))).open(OPEN);

    await expect(refused).rejects.toBeInstanceOf(HostFullError);
    expect(tasks.discardUnstarted).toHaveBeenCalledWith('task-2');
    expect(tasks.updateTaskState).not.toHaveBeenCalledWith('task-2', 'failed', expect.anything());
  });

  it('keeps a paused task paused when no host has room to resume it, and tries again', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(tasks.getTask).mockResolvedValue({ id: 'task-1', botId: 'bot-1', repoId: null, kind: 'implement', subjectRef: 'fleetadlc#7', skill: 'implement', state: 'paused' } as never);
      const full = Object.assign(new Error('POST /tasks/task-1/resume → 503: all it has room for'), { status: 503 });
      const resumeTask = vi.fn().mockRejectedValueOnce(full).mockResolvedValueOnce({ session: 'builder/implement-task1' });
      const tasksService = service({ resumeTask, cleanupTask: vi.fn(async () => undefined) });

      await tasksService.resume('task-1');
      expect(tasks.updateTaskState).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(resumeTask).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a start that breaks between its row and hostd', () => {
  const OPEN = { bot: 'builder', botId: 'bot-1', kind: 'implement' as const, subjectType: 'issue' as const, subjectRef: 'fleetadlc#7', skill: 'implement' };

  function opener(startTask: HostdClient['startTask'] = vi.fn(async () => ({ session: 's', worktree: 'w' }))) {
    return new TaskService({ costs: { perTaskCapUsd: 5 } } as BridgeConfig, { startTask } as unknown as HostdClient, { forSubject: async () => [] } as unknown as Context);
  }

  beforeEach(() => {
    vi.mocked(tasks.discardUnstarted).mockClear();
    vi.mocked(tasks.seatHasRoom).mockReset().mockResolvedValue(true);
    vi.mocked(tasks.liveTaskOn).mockReset().mockResolvedValue(null);
    vi.mocked(hosts.taskRoom).mockReset().mockResolvedValue(null);
  });

  it('takes its row back and says why, rather than leaving it queued for good', async () => {
    const lost = new Error('Connection terminated unexpectedly');
    vi.mocked(threads.addMessage).mockRejectedValueOnce(lost);
    const startTask = vi.fn(async () => ({ session: 's', worktree: 'w' }));

    await expect(opener(startTask).open(OPEN)).rejects.toBe(lost);

    expect(tasks.discardUnstarted).toHaveBeenCalledWith('task-2');
    expect(startTask).not.toHaveBeenCalled();
  });

  it('is waited for by a shutdown, which goes on once the start has finished', async () => {
    let answer!: (value: { session: string; worktree: string }) => void;
    const startTask = vi.fn(() => new Promise<{ session: string; worktree: string }>((resolve) => (answer = resolve)));
    const tasksService = opener(startTask as unknown as HostdClient['startTask']);

    const opened = tasksService.open(OPEN);
    await vi.waitFor(() => expect(startTask).toHaveBeenCalled());
    let drained = false;
    const draining = tasksService.drain(10_000).then(() => (drained = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(drained).toBe(false);

    answer({ session: 's', worktree: 'w' });
    await opened;
    await draining;
    expect(drained).toBe(true);
  });

  it('is waited for no longer than the bound', async () => {
    const tasksService = opener(vi.fn(() => new Promise(() => undefined)) as unknown as HostdClient['startTask']);
    void tasksService.open(OPEN);

    const started = Date.now();
    await tasksService.drain(50);

    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('a paused task whose question was answered before the bridge restarted', () => {
  const PAUSED = { id: 'task-1', botId: 'bot-1', repoId: null, kind: 'implement', subjectRef: 'fleetadlc#7', skill: 'implement', state: 'paused' };
  const full = () => Object.assign(new Error('POST /tasks/task-1/resume → 503: all it has room for'), { status: 503 });
  const answeredAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

  beforeEach(() => {
    vi.mocked(tasks.getTask).mockResolvedValue(PAUSED as never);
  });
  afterEach(() => {
    vi.mocked(tasks.pausedWithAnswer).mockResolvedValue([]);
    vi.mocked(threads.listGatesForTasks).mockResolvedValue([]);
    store.issues = [];
  });

  it('is resumed by the sweep, with no retry of it held in memory', async () => {
    vi.mocked(tasks.pausedWithAnswer).mockResolvedValue([{ ...PAUSED, answeredAt: answeredAgo(5) }] as never);
    const resumeTask = vi.fn(async () => ({ session: 'builder/implement' }));
    const tasksService = service({ resumeTask });
    tasksService.seatPauses = async () => ({});

    const lines = await tasksService.resumeAnswered();

    expect(resumeTask).toHaveBeenCalledTimes(1);
    expect((resumeTask.mock.calls[0] as unknown[])[0]).toBe('task-1');
    expect(lines).toHaveLength(1);
  });

  it('is failed with why once no host has had room for an hour since the answer, counted from the answer', async () => {
    vi.mocked(threads.listGatesForTasks).mockResolvedValue([{ id: 'g', taskId: 'task-1', state: 'answered', answeredAt: answeredAgo(61) }] as never);
    const refusal = full();
    const cleanupTask = vi.fn(async () => undefined);
    const tasksService = service({ resumeTask: vi.fn(async () => Promise.reject(refusal)), cleanupTask });

    // The first try in this process: before, that started an hour of retries afresh.
    await expect(tasksService.resume('task-1')).rejects.toBe(refusal);

    expect(tasks.updateTaskState).toHaveBeenCalledWith('task-1', 'failed', { exitReason: `hostd refused: ${refusal.message}` });
    expect(threads.addMessage).toHaveBeenCalledWith(expect.objectContaining({ text: `could not resume implement: ${refusal.message}` }));
  });

  it('waits for a host with room while the answer is less than an hour old', async () => {
    vi.mocked(threads.listGatesForTasks).mockResolvedValue([{ id: 'g', taskId: 'task-1', state: 'answered', answeredAt: answeredAgo(59) }] as never);
    const tasksService = service({ resumeTask: vi.fn(async () => Promise.reject(full())), cleanupTask: vi.fn(async () => undefined) });

    await tasksService.resume('task-1');

    expect(tasks.updateTaskState).not.toHaveBeenCalled();
  });

  it('is left alone while a person has paused its seat, its item or its repository', async () => {
    vi.mocked(tasks.pausedWithAnswer).mockResolvedValue([{ ...PAUSED, answeredAt: answeredAgo(5) }] as never);
    const resumeTask = vi.fn(async () => ({ session: 'builder/implement' }));

    const seatPaused = service({ resumeTask });
    seatPaused.seatPauses = async () => ({ builder: { by: 'janedoe', at: '2026-10-02T10:00:00Z', why: 'changing its model' } });
    expect(await seatPaused.resumeAnswered()).toEqual([]);

    store.issues = [{ repoName: 'fleetadlc', number: 7, prNumber: null, labels: ['adlc:build', 'fleetadlc:paused'] }];
    const itemHeld = service({ resumeTask });
    itemHeld.seatPauses = async () => ({});
    expect(await itemHeld.resumeAnswered()).toEqual([]);
    store.issues = [];

    const workPaused = service({ resumeTask });
    workPaused.seatPauses = async () => ({});
    workPaused.workPaused = () => 'work is paused, by janedoe since 2026-10-02T10:00:00Z; resume it in Settings → Pause work';
    expect(await workPaused.resumeAnswered()).toEqual([]);

    expect(resumeTask).not.toHaveBeenCalled();
  });
});

describe('opening a task on a bot that is being renamed', () => {
  it('waits for the rename, and starts it under the name the bot has once it is done', async () => {
    // The dispatcher read `builder` before the bot connected and took its
    // handle; the id it sent is what finds the bot now.
    let finishRename!: () => void;
    const renaming = new Promise<void>((resolve) => (finishRename = resolve));
    const held = vi.fn();
    const queue: BotQueue = {
      async withBot<T>(botId: string, fn: () => Promise<T>): Promise<T> {
        held(botId);
        await renaming;
        return fn();
      },
    };
    const startTask = vi.fn(async () => ({ session: 's', worktree: 'w' }));
    const tasksService = new TaskService(
      { costs: { perTaskCapUsd: 5 } } as BridgeConfig,
      { startTask } as unknown as HostdClient,
      { forSubject: async () => [] } as unknown as Context,
      queue,
    );

    const opened = tasksService.open({
      bot: 'builder',
      botId: 'bot-1',
      kind: 'implement',
      subjectType: 'issue',
      subjectRef: 'fleetadlc#1',
      skill: 'implement',
    });
    await vi.waitFor(() => expect(held).toHaveBeenCalledWith('bot-1'));
    expect(tasks.createTask).not.toHaveBeenCalled();

    crew[0]!.name = 'fleetadlc-atlas-janedoe';
    try {
      finishRename();
      await opened;

      expect(startTask).toHaveBeenCalledWith(expect.objectContaining({ bot: 'fleetadlc-atlas-janedoe' }));
    } finally {
      // Every other test opens tasks as `builder`.
      crew[0]!.name = 'builder';
    }
  });
});

describe('a bot that must be able to work before a task starts', () => {
  beforeEach(() => {
    store.crew = [LEAD, SECURITY];
    store.health = [];
    store.healthReadable = true;
    store.reviewTasks = [];
    store.roundAt = null;
    store.askedAgain = [];
    vi.mocked(tasks.createTask).mockClear();
    vi.unstubAllEnvs();
    vi.mocked(repos.getRepoByName).mockImplementation((async (name: string) => ({ id: `repo-${name}`, name })) as never);
  });

  const LEAD = { id: 'bot-lead', name: 'fleetadlc-sydney-janedoe', githubLogin: 'fleetadlc-sydney-janedoe' };
  const SECURITY = { id: 'bot-security', name: 'fleetadlc-cipher-janedoe', githubLogin: 'fleetadlc-cipher-janedoe' };

  const signedOut = (id: string) => ({
    id: `bot-sign-in:${id}`,
    state: 'failing',
    title: 'Signed out of GitHub',
    detail: 'Reconnect it from Settings → GitHub → Connected accounts.',
  });

  function readyService() {
    const startTask = vi.fn(async () => ({ session: 'review-1', worktree: 'w' }));
    const tasksService = new TaskService(
      { costs: { perTaskCapUsd: 5 } } as BridgeConfig,
      { startTask } as unknown as HostdClient,
      { forSubject: async () => [] } as never,
    );
    return { tasksService, startTask };
  }

  const REVIEW = {
    kind: 'review' as const,
    subjectType: 'pr' as const,
    subjectRef: 'fleetadlc#2',
    skill: 'pr-review',
    repo: 'fleetadlc',
  };

  describe('opening a task for a bot that cannot do it yet', () => {
    it('records nothing and starts nothing while its GitHub sign-in fails, and says what to do', async () => {
      store.health = [signedOut('bot-security')];
      const { tasksService, startTask } = readyService();

      const refused = await tasksService.open({ ...REVIEW, bot: SECURITY.name }).catch((error: unknown) => error);

      expect(refused).toBeInstanceOf(PrerequisiteNotReadyError);
      expect(refused).toMatchObject({ status: 409 });
      expect((refused as Error).message).toBe(
        'fleetadlc-cipher-janedoe was not started: fleetadlc-cipher-janedoe cannot sign in to GitHub. Reconnect it from Settings → GitHub → Connected accounts.',
      );
      expect(tasks.createTask).not.toHaveBeenCalled();
      expect(startTask).not.toHaveBeenCalled();
    });

    it('starts as soon as the sign-in passes', async () => {
      store.health = [{ ...signedOut('bot-security'), state: 'passing' }];
      const { tasksService, startTask } = readyService();

      await expect(tasksService.open({ ...REVIEW, bot: SECURITY.name })).resolves.toMatchObject({ taskId: 'task-2' });

      expect(startTask).toHaveBeenCalledTimes(1);
    });

    it('is refused for a seat missing from this repository only, not another', async () => {
      store.health = [{ id: 'bot-access:bot-security:fleetadlc', state: 'failing', title: 'Not in fleetadlc', detail: 'Invite it.' }];
      const { tasksService } = readyService();

      await expect(tasksService.open({ ...REVIEW, bot: SECURITY.name })).rejects.toThrow(
        'fleetadlc-cipher-janedoe was not started: fleetadlc-cipher-janedoe cannot work in fleetadlc. Invite it.',
      );
      await expect(tasksService.open({ ...REVIEW, bot: SECURITY.name, repo: 'other', subjectRef: 'other#2' })).resolves.toBeDefined();
    });

    it('is refused for every bot while the host service is not answering', async () => {
      store.health = [{ id: 'hostd', state: 'failing', title: 'hostd is down', detail: 'Start it with fleetadlc up.' }];
      const { tasksService } = readyService();

      await expect(tasksService.open({ ...REVIEW, bot: LEAD.name })).rejects.toThrow(/host service is not answering\. Start it with fleetadlc up\./);
    });

    it('names everything in the way when there is more than one', async () => {
      store.health = [signedOut('bot-security'), { id: 'hostd', state: 'failing', title: 'hostd is down', detail: 'Start it.' }];
      const { tasksService } = readyService();

      const refused = (await tasksService.open({ ...REVIEW, bot: SECURITY.name }).catch((error: unknown) => error)) as PrerequisiteNotReadyError;

      expect(refused.blockers.map((blocker) => blocker.kind)).toEqual(['sign-in', 'host']);
    });

    it('is not held back by another bot’s sign-in, or by checks that do not decide whether it can work', async () => {
      store.health = [signedOut('bot-lead'), { id: 'webhook', state: 'failing', title: 'No deliveries', detail: null }];
      const { tasksService } = readyService();

      await expect(tasksService.open({ ...REVIEW, bot: SECURITY.name })).resolves.toMatchObject({ taskId: 'task-2' });
    });

    it('records nothing and starts nothing while a person has the seat paused, and starts once it is resumed', async () => {
      store.health = [];
      const { tasksService, startTask } = readyService();
      let paused = true;
      tasksService.seatPauses = async () =>
        paused ? { [SECURITY.name]: { by: 'janedoe', at: '2026-10-02T10:00:00.000Z', why: 'changing its model' } } : {};

      const refused = (await tasksService.open({ ...REVIEW, bot: SECURITY.name }).catch((error: unknown) => error)) as PrerequisiteNotReadyError;
      expect(refused).toBeInstanceOf(PrerequisiteNotReadyError);
      expect(refused.blockers).toEqual([expect.objectContaining({ kind: 'paused', why: `${SECURITY.name} is paused by janedoe: changing its model` })]);
      expect(tasks.createTask).not.toHaveBeenCalled();
      expect(startTask).not.toHaveBeenCalled();
      // Another seat goes on.
      await expect(tasksService.open({ ...REVIEW, bot: LEAD.name })).resolves.toBeDefined();

      paused = false;
      await expect(tasksService.open({ ...REVIEW, bot: SECURITY.name, subjectRef: 'fleetadlc#3' })).resolves.toBeDefined();
    });

    it('holds a paused seat on a scripted install too: the pause is a person’s word, not GitHub’s', async () => {
      vi.stubEnv('FLEETADLC_SCRIPTED_ENGINES', '1');
      const { tasksService } = readyService();
      tasksService.seatPauses = async () => ({ [SECURITY.name]: { by: 'janedoe', at: '2026-10-02T10:00:00.000Z', why: null } });

      await expect(tasksService.open({ ...REVIEW, bot: SECURITY.name })).rejects.toThrow(`${SECURITY.name} is paused by janedoe`);
    });

    it('is not held back on an install whose engines are scripted', async () => {
      // The integration suites run with no GitHub account behind any bot.
      vi.stubEnv('FLEETADLC_SCRIPTED_ENGINES', '1');
      store.health = [signedOut('bot-security')];
      const { tasksService } = readyService();

      await expect(tasksService.open({ ...REVIEW, bot: SECURITY.name })).resolves.toMatchObject({ taskId: 'task-2' });
    });

    it('is not held back by a health table that cannot be read', async () => {
      store.healthReadable = false;
      const { tasksService } = readyService();

      await expect(tasksService.open({ ...REVIEW, bot: SECURITY.name })).resolves.toMatchObject({ taskId: 'task-2' });
    });

    it('is recorded as failed, never started, when only an event would ask for it again', async () => {
      store.health = [signedOut('bot-security')];
      vi.mocked(tasks.updateTaskState).mockClear();
      vi.mocked(threads.addMessage).mockClear();
      const { tasksService, startTask } = readyService();

      const held = await tasksService.open({
        ...REVIEW,
        bot: SECURITY.name,
        kind: 'patch',
        skill: 'implement',
        round: 2,
        leaseId: 'lease-1',
        whenBlocked: 'record',
      });

      const reason =
        'fleetadlc-cipher-janedoe was not started: fleetadlc-cipher-janedoe cannot sign in to GitHub. Reconnect it from Settings → GitHub → Connected accounts.';
      expect(held).toEqual({ taskId: 'task-2', session: null, error: reason });
      expect(tasks.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ botId: 'bot-security', kind: 'patch', subjectRef: 'fleetadlc#2', round: 2, leaseId: 'lease-1' }),
      );
      expect(tasks.updateTaskState).toHaveBeenCalledWith('task-2', 'failed', { exitReason: reason });
      expect(threads.addMessage).toHaveBeenCalledWith(expect.objectContaining({ text: `could not start implement: ${reason}` }));
      expect(startTask).not.toHaveBeenCalled();
      // The words are what the recovery reads its cause from.
      expect(causeOfFailure(reason, { botId: 'bot-security', repoName: 'fleetadlc' })).toBe('bot-sign-in:bot-security');
    });
  });

  describe('the words of a gate that waits on a seat', () => {
    it('say the reviewer account when the seat cannot sign in', async () => {
      store.health = [signedOut('bot-security')];
      const { tasksService } = readyService();

      expect(await tasksService.gateDescription('waiting on fleetadlc-sydney-janedoe, fleetadlc-cipher-janedoe', 'fleetadlc')).toBe(
        'waiting on the reviewer account: fleetadlc-cipher-janedoe cannot sign in to GitHub',
      );
    });

    it('are left as they were when nobody it waits on is blocked, or it waits on people', async () => {
      store.health = [signedOut('bot-security')];
      const { tasksService } = readyService();

      expect(await tasksService.gateDescription('waiting on fleetadlc-sydney-janedoe', 'fleetadlc')).toBe('waiting on fleetadlc-sydney-janedoe');
      expect(await tasksService.gateDescription('waiting on @janedoe', 'fleetadlc')).toBe('waiting on @janedoe');
      expect(await tasksService.gateDescription('pull request is still a draft', 'fleetadlc')).toBe('pull request is still a draft');
    });
  });

  describe('the reviews a gate waits on with none under way', () => {
    const input = { repo: { name: 'fleetadlc' }, prNumber: 2, branch: 'agent/x/1-issue-1', issueNumber: 1, waitingOn: [LEAD.name, SECURITY.name] };

    it('are started for the seats that can work, and only those', async () => {
      store.health = [signedOut('bot-security')];
      const { tasksService } = readyService();
      const open = vi.spyOn(tasksService, 'open').mockResolvedValue({ taskId: 'task-2', session: 's' });

      const lines = await tasksService.openMissingReviews(input);

      expect(open).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledWith(
        expect.objectContaining({ bot: LEAD.name, botId: LEAD.id, kind: 'review', subjectRef: 'fleetadlc#2', branch: 'agent/x/1-issue-1', issueNumber: 1, checkoutExistingBranch: true }),
      );
      expect(lines).toEqual(['fleetadlc#2: started fleetadlc-sydney-janedoe’s review']);
    });

    it('are started once the seat can work: a seat is never started twice for the same pull request', async () => {
      const { tasksService } = readyService();
      const open = vi.spyOn(tasksService, 'open').mockResolvedValue({ taskId: 'task-2', session: 's' });

      await tasksService.openMissingReviews({ ...input, waitingOn: [SECURITY.name] });
      store.reviewTasks = [{ botId: SECURITY.id, subjectRef: 'fleetadlc#2', state: 'running' }];
      await tasksService.openMissingReviews({ ...input, waitingOn: [SECURITY.name] });

      expect(open).toHaveBeenCalledTimes(1);
    });

    it('are started again on a new round, though the seat reviewed an earlier one', async () => {
      // second-reviewer was busy when the push opened round two: the refusal
      // recorded nothing, and its round-one review kept it from being asked.
      store.reviewTasks = [{ botId: SECURITY.id, subjectRef: 'fleetadlc#2', state: 'done', createdAt: '2026-10-01T09:00:00.000Z' } as never];
      store.roundAt = '2026-10-01T10:00:00.000Z';
      const { tasksService } = readyService();
      const open = vi.spyOn(tasksService, 'open').mockResolvedValue({ taskId: 'task-2', session: 's' });

      await tasksService.openMissingReviews({ ...input, waitingOn: [SECURITY.name] });

      expect(open).toHaveBeenCalledWith(expect.objectContaining({ bot: SECURITY.name, subjectRef: 'fleetadlc#2' }));
    });

    it.each(['done', 'failed'])('are not started twice on one diff: a review %s since the round began is that review', async (state) => {
      store.reviewTasks = [{ botId: SECURITY.id, subjectRef: 'fleetadlc#2', state, createdAt: '2026-10-01T10:00:05.000Z' } as never];
      store.roundAt = '2026-10-01T10:00:00.000Z';
      const { tasksService } = readyService();
      const open = vi.spyOn(tasksService, 'open');

      await tasksService.openMissingReviews({ ...input, waitingOn: [SECURITY.name] });

      expect(open).not.toHaveBeenCalled();
    });

    it('leave a seat whose review ran and failed to its card', async () => {
      store.reviewTasks = [{ botId: SECURITY.id, subjectRef: 'fleetadlc#2', state: 'failed' }];
      const { tasksService } = readyService();
      const open = vi.spyOn(tasksService, 'open');

      await tasksService.openMissingReviews({ ...input, waitingOn: [SECURITY.name] });

      expect(open).not.toHaveBeenCalled();
    });

    it('skip a name that is not a seat with an account, such as a person the gate waits on', async () => {
      const { tasksService } = readyService();
      const open = vi.spyOn(tasksService, 'open');

      await tasksService.openMissingReviews({ ...input, waitingOn: ['@janedoe'] });

      expect(open).not.toHaveBeenCalled();
    });

    it('are asked again on the next sweep when the seat is busy, without a line for it', async () => {
      const { tasksService } = readyService();
      vi.spyOn(tasksService, 'open').mockRejectedValue(new BotBusyError(SECURITY.name));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      try {
        expect(await tasksService.openMissingReviews({ ...input, waitingOn: [SECURITY.name] })).toEqual([]);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('the lead’s review, last', () => {
    const input = { repo: { name: 'fleetadlc' }, prNumber: 2, branch: 'agent/x/1-issue-1', issueNumber: 1, seat: LEAD.name, since: '2026-09-30T10:00:00Z' };

    it('is started once, and not again for the same diff while it runs or once it was opened after the others posted', async () => {
      const { tasksService } = readyService();
      const open = vi.spyOn(tasksService, 'open').mockResolvedValue({ taskId: 'task-2', session: 's' });
      const quiet = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      try {
        expect(await tasksService.openLeadReview(input)).toMatch(/the lead’s, last/);
        store.reviewTasks = [{ botId: LEAD.id, subjectRef: 'fleetadlc#2', state: 'running' }];
        expect(await tasksService.openLeadReview(input)).toBeNull();
        store.reviewTasks = [{ botId: LEAD.id, subjectRef: 'fleetadlc#2', state: 'done', createdAt: '2026-09-30T10:01:00Z' } as never];
        expect(await tasksService.openLeadReview(input)).toBeNull();
        // A lead review from before the others last posted is an earlier diff's: asked again.
        store.reviewTasks = [{ botId: LEAD.id, subjectRef: 'fleetadlc#2', state: 'done', createdAt: '2026-09-30T09:00:00Z' } as never];
        expect(await tasksService.openLeadReview(input)).toMatch(/the lead’s, last/);
      } finally {
        quiet.mockRestore();
      }
      expect(open).toHaveBeenCalledTimes(2);
      expect(open).toHaveBeenCalledWith(expect.objectContaining({ bot: LEAD.name, kind: 'review', subjectRef: 'fleetadlc#2', checkoutExistingBranch: true }));
    });

    it('with no cut-off, counts only a lead task under way, never any earlier one', async () => {
      const { tasksService } = readyService();
      const open = vi.spyOn(tasksService, 'open').mockResolvedValue({ taskId: 'task-2', session: 's' });
      const quiet = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      try {
        store.reviewTasks = [{ botId: LEAD.id, subjectRef: 'fleetadlc#2', state: 'done', createdAt: '2026-09-30T09:00:00Z' } as never];
        expect(await tasksService.openLeadReview({ ...input, since: null })).toMatch(/the lead’s, last/);
        store.reviewTasks = [{ botId: LEAD.id, subjectRef: 'fleetadlc#2', state: 'queued', createdAt: '2026-09-30T09:00:00Z' } as never];
        expect(await tasksService.openLeadReview({ ...input, since: null })).toBeNull();
      } finally {
        quiet.mockRestore();
      }
      expect(open).toHaveBeenCalledTimes(1);
    });

    it('is asked again by the sweep when the lead was busy', async () => {
      const { tasksService } = readyService();
      vi.spyOn(tasksService, 'open').mockRejectedValue(new BotBusyError(LEAD.name));
      expect(await tasksService.openLeadReview(input)).toBeNull();
    });
  });

  describe('a seat whose review a bot dismissed', () => {
    const input = { repo: { name: 'fleetadlc' }, prNumber: 2, branch: 'agent/x/1-issue-1', issueNumber: 1, reviewId: 41 };
    // The review the bot dismissed, from a task opened since the round began.
    const dismissedTask = (botId: string) => ({ botId, subjectRef: 'fleetadlc#2', state: 'done', createdAt: '2026-10-01T10:00:05.000Z' }) as never;

    it.each([
      ['the lead', LEAD],
      ['another seat', SECURITY],
    ])('is asked again when it is %s, though its task already reviewed this diff', async (_who, seat) => {
      store.roundAt = '2026-10-01T10:00:00.000Z';
      store.reviewTasks = [dismissedTask(seat.id)];
      const { tasksService } = readyService();
      const open = vi.spyOn(tasksService, 'open').mockResolvedValue({ taskId: 'task-2', session: 's' });
      const quiet = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      try {
        expect(await tasksService.askAgain({ ...input, seat: seat.name })).toMatch(/review again/);
      } finally {
        quiet.mockRestore();
      }
      expect(open).toHaveBeenCalledWith(
        expect.objectContaining({ bot: seat.name, botId: seat.id, kind: 'review', skill: 'pr-review', subjectRef: 'fleetadlc#2', checkoutExistingBranch: true }),
      );
    });

    it('is asked once per dismissed review, and not while it has a review of the pull request under way', async () => {
      const { tasksService } = readyService();
      const open = vi.spyOn(tasksService, 'open').mockResolvedValue({ taskId: 'task-2', session: 's' });
      const quiet = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      try {
        await tasksService.askAgain({ ...input, seat: SECURITY.name });
        await tasksService.askAgain({ ...input, seat: SECURITY.name });
        store.reviewTasks = [{ botId: LEAD.id, subjectRef: 'fleetadlc#2', state: 'running' }];
        expect(await tasksService.askAgain({ ...input, reviewId: 42, seat: LEAD.name })).toBeNull();
      } finally {
        quiet.mockRestore();
      }
      expect(open).toHaveBeenCalledTimes(1);
    });

    it('is asked by the sweep when it was busy: its task from before the dismissal no longer counts', async () => {
      store.roundAt = '2026-10-01T10:00:00.000Z';
      store.reviewTasks = [dismissedTask(SECURITY.id), dismissedTask(LEAD.id)];
      const { tasksService } = readyService();
      const busy = vi.spyOn(tasksService, 'open').mockRejectedValue(new BotBusyError(SECURITY.name));
      expect(await tasksService.askAgain({ ...input, seat: SECURITY.name })).toBeNull();
      expect(await tasksService.askAgain({ ...input, reviewId: 42, seat: LEAD.name })).toBeNull();
      busy.mockReset().mockResolvedValue({ taskId: 'task-3', session: 's' });
      const quiet = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      try {
        await tasksService.openMissingReviews({ ...input, waitingOn: [SECURITY.name] });
        await tasksService.openLeadReview({ ...input, seat: LEAD.name, since: '2026-10-01T10:00:00.000Z' });
      } finally {
        quiet.mockRestore();
      }
      expect(busy.mock.calls.map(([call]) => call.bot)).toEqual([SECURITY.name, LEAD.name]);
    });
  });

  afterEach(() => {
    vi.mocked(repos.getRepoByName).mockImplementation((async () => null) as never);
  });
});

describe('usage a task’s session reports', () => {
  // The builder runs on claude (`crew` above); its task has spent $14 of $15.
  const usage = (overrides: Record<string, unknown> = {}) =>
    ({ taskId: 'task-1', tokensIn: 1200, tokensOut: 300, costUsd: 0.5, engine: 'claude', model: 'claude-opus-5', modelAlias: null, ...overrides }) as never;
  const reporting = () => new TaskService({ costs: { monthlyCapUsd: 1500, perTaskCapUsd: 15, warningAt: 0.9 } } as BridgeConfig, {} as HostdClient, {} as Context);
  const task = (state: string) =>
    vi.mocked(tasks.getTask).mockResolvedValue({ id: 'task-1', botId: 'bot-1', repoId: null, state, costCapUsd: 15, kind: 'implement', subjectRef: 'fleetadlc#155' } as never);

  beforeEach(() => {
    vi.mocked(costs.recordUsage).mockClear();
    vi.mocked(tasks.addTaskCost).mockClear();
    task('running');
  });

  it('is recorded for a running or paused task, and says when the cap is reached', async () => {
    expect(await reporting().recordUsage(usage())).toEqual({ stop: false, spent: 14.5, cap: 15, stepUsd: 15 });
    task('paused');
    expect(await reporting().recordUsage(usage({ costUsd: 1 }))).toEqual({ stop: true, spent: 15, cap: 15, stepUsd: 15 });
    expect(costs.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-1', botId: 'bot-1', engine: 'claude', costUsd: 1 }));
  });

  it('is refused for an ended task, or one not started, and nothing is written', async () => {
    for (const state of ['done', 'failed', 'stopped', 'queued']) {
      task(state);
      await expect(reporting().recordUsage(usage()), state).rejects.toThrow(UsageRefusedError);
    }
    expect(costs.recordUsage).not.toHaveBeenCalled();
    expect(tasks.addTaskCost).not.toHaveBeenCalled();
  });

  it('is refused on a foreign engine, so no provider cap is dodged; the scripted engine only in the integration suites', async () => {
    await expect(reporting().recordUsage(usage({ engine: 'codex' }))).rejects.toThrow(/engine must be the task's bot's own \(claude\)/);
    await expect(reporting().recordUsage(usage({ engine: 'none' }))).rejects.toThrow(UsageRefusedError);
    expect(costs.recordUsage).not.toHaveBeenCalled();

    vi.stubEnv('FLEETADLC_SCRIPTED_ENGINES', '1');
    try {
      await reporting().recordUsage(usage({ engine: 'none' }));
    } finally {
      vi.unstubAllEnvs();
    }
    expect(costs.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ engine: 'none' }));
  });

  it('is refused above the ceiling of the cap and one step, a negative cost, "NaN", or fractional tokens', async () => {
    for (const bad of [{ costUsd: 30.01 }, { costUsd: -1000 }, { costUsd: 'NaN' }, { costUsd: Number.POSITIVE_INFINITY }, { tokensIn: -5 }, { tokensOut: 1.5 }]) {
      await expect(reporting().recordUsage(usage(bad)), JSON.stringify(bad)).rejects.toThrow(UsageRefusedError);
    }
    expect(costs.recordUsage).not.toHaveBeenCalled();
    expect(tasks.addTaskCost).not.toHaveBeenCalled();
    // The ceiling itself is a cost one call could still reach.
    await reporting().recordUsage(usage({ costUsd: 30 }));
    expect(costs.recordUsage).toHaveBeenCalledTimes(1);
  });
});

describe('a QA task, told where testing is', () => {
  // The skill said to test "the testing environment" and no task was told
  // where that was: it tested nothing and reported `verified` all the same.
  const testing = (subjectRef: string) => ({ name: 'testing.md', title: 'Where to test', content: `https://testing.example for ${subjectRef}` });
  const context = () => ({
    forSubject: vi.fn(async () => []),
    forQa: vi.fn(async (input: { repoName: string; subjectRef: string }) => testing(input.subjectRef)),
  });

  afterEach(() => {
    vi.mocked(repos.getRepoByName).mockResolvedValue(null);
    vi.mocked(repos.listRepos).mockImplementation((async () => []) as never);
  });

  it.each([
    ['the nightly run', 'api#testing'],
    ['the run before a promote', 'api#testing@1a2b3c4d'],
    ['the verification after a merge reaches testing', 'api#31'],
  ])('is given testing.md for %s', async (_what, subjectRef) => {
    vi.mocked(repos.getRepoByName).mockResolvedValue({ id: 'repo-api', name: 'api', fullName: 'exampleco/api' } as never);
    const startTask = vi.fn(async () => ({ session: 's', worktree: 'w' }));
    const stub = context();
    const tasksService = new TaskService(
      { costs: { perTaskCapUsd: 15, monthlyCapUsd: 1500 } } as BridgeConfig,
      { startTask } as unknown as HostdClient,
      stub as unknown as Context,
    );

    await tasksService.open({ botId: 'bot-1', bot: 'builder', repo: 'api', kind: 'qa', subjectType: 'request', subjectRef, skill: 'qa', declaredPaths: ['tests/**'] });

    expect(stub.forQa).toHaveBeenCalledWith({ repoName: 'api', subjectRef });
    expect(startTask).toHaveBeenCalledWith(expect.objectContaining({ context: expect.arrayContaining([testing(subjectRef)]) }));
  });

  it('is given it again when it resumes, where what it was opened with is not kept', async () => {
    vi.mocked(repos.listRepos).mockImplementation((async () => [{ id: 'repo-api', name: 'api', fullName: 'exampleco/api', removedAt: null }]) as never);
    vi.mocked(tasks.getTask).mockResolvedValueOnce({
      id: 'task-1', botId: 'bot-1', repoId: 'repo-api', kind: 'qa', state: 'paused', subjectRef: 'api#testing', skill: 'qa',
    } as never);
    const resumeTask = vi.fn(async (_taskId: string, _context: unknown[]) => ({ session: 'builder/qa' }));
    const stub = context();
    const tasksService = new TaskService({} as BridgeConfig, { resumeTask } as unknown as HostdClient, stub as unknown as Context);

    await tasksService.resume('task-1');

    expect(resumeTask.mock.calls[0]?.[1]).toEqual([testing('api#testing')]);
  });

  it('is not given one by any other kind of task', async () => {
    vi.mocked(repos.getRepoByName).mockResolvedValue({ id: 'repo-api', name: 'api', fullName: 'exampleco/api' } as never);
    const startTask = vi.fn(async () => ({ session: 's', worktree: 'w' }));
    const stub = context();
    const tasksService = new TaskService({ costs: { perTaskCapUsd: 15, monthlyCapUsd: 1500 } } as BridgeConfig, { startTask } as unknown as HostdClient, stub as unknown as Context);

    await tasksService.open({ botId: 'bot-1', bot: 'builder', repo: 'api', kind: 'implement', subjectType: 'issue', subjectRef: 'api#3', skill: 'implement' });

    expect(stub.forQa).not.toHaveBeenCalled();
  });
});
