import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DispatchGate } from './dispatch-gate.js';
import { StageHandoff, stageAfterIntake, stageAfterTask, stagesStaffedBy } from './stage-handoff.js';
import { StageRunner } from './stage-runner.js';
import { BotBusyError, HostFullError, RestartPendingError, SubjectBusyError } from './task-service.js';

const board = vi.hoisted(() => ({
  issues: [] as Record<string, unknown>[],
  elsewhere: [] as { fullName: string; number: number; stage: string; labels: string[] }[],
  audited: [] as Record<string, unknown>[],
  /** The locks a sweep was run under, in order. */
  locked: [] as string[],
  /** The send-back a task made, by task id. */
  sentBack: {} as Record<string, Record<string, unknown>>,
  /** Every task on a subject, ended ones included. */
  onSubject: {} as Record<string, Record<string, unknown>[]>,
  events: [] as { type: string; payload: unknown }[],
}));

vi.mock('@openadlc/db', async (importOriginal) => ({
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

  // The board's own order, not a copy of it: what is under test is that the
  // sweep uses it.
  withAdvisoryLock: vi.fn(async (key: string, fn: () => Promise<unknown>) => {
    board.locked.push(key);
    return fn();
  }),
  audit: vi.fn(async (entry: Record<string, unknown>) => void board.audited.push(entry)),
  bots: {
    listBots: vi.fn(async () => [
      { id: 'bot-intake', name: 'openadlc-scout-janedoe', role: 'intake' },
      { id: 'bot-spec', name: 'openadlc-sage-janedoe', role: 'spec' },
    ]),
  },
  issues: {
    listIssues: vi.fn(async () => board.issues),
    getIssue: vi.fn(async (_repoId: string, number: number) => board.issues.find((entry) => entry.number === number) ?? null),
    // Another repository's issues, as the store resolves them by full name.
    resolveDependency: vi.fn(async (_own: unknown, ref: { repo: string | null; number: number }) => {
      const issue = board.elsewhere.find((entry) => entry.fullName === ref.repo?.toLowerCase() && entry.number === ref.number);
      return { managed: true, issue: issue ?? null };
    }),
    byNextFirst: (await importOriginal<typeof import('@openadlc/db')>()).issues.byNextFirst,
  },
  repos: {
    getRepoByName: vi.fn(async () => ({ id: 'repo-1', name: 'openadlc', fullName: 'janedoe/openadlc', stageModes: {}, specRequiredLabels: ['touches:schema'] })),
    listRepos: vi.fn(async () => [{ id: 'repo-1', name: 'openadlc' }]),
  },
  tasks: {
    listTasks: vi.fn(async () => []),
    listTasksOnSubjects: vi.fn(async (refs: readonly string[]) => refs.flatMap((ref) => board.onSubject[ref] ?? [])),
  },
  recordEvent: vi.fn(async (event: { type: string; payload: unknown }) => (board.events.push(event), 'event-1')),
  listEventsOfType: vi.fn(async (type: string) => board.events.filter((event) => event.type === type).map((event) => ({ id: 1, at: '2026-10-02T00:00:00.000Z', payload: event.payload }))),
  stageMoves: { sendBackOfTask: vi.fn(async (taskId: string) => board.sentBack[taskId] ?? null) },
}));

/** What intake must give an issue before it leaves intake (`missingLabels`). */
const INTAKES_OWN = ['priority:p1', 'area:general', 'do:ai'];

const SPEC_REQUIRED = ['touches:schema','touches:contract', 'touches:migration', 'size:large', 'safety'];

describe('where an issue goes after intake', () => {
  it('spends a design pass on a schema change', () => {
    expect(
      stageAfterIntake({
        labels: ['do:ai', 'touches:schema'],
        specRequiredLabels: SPEC_REQUIRED,
        specMode: 'conditional',
      }),
    ).toBe('spec');
  });

  it('sends an ordinary change straight to a builder', () => {
    expect(
      stageAfterIntake({ labels: ['do:ai', 'area:console'], specRequiredLabels: SPEC_REQUIRED, specMode: 'conditional' }),
    ).toBe('build');
  });

  it('skips the stage entirely when nobody staffs it', () => {
    expect(
      stageAfterIntake({ labels: ['touches:schema'], specRequiredLabels: SPEC_REQUIRED, specMode: 'untouched' }),
    ).toBe('build');
  });

  it('specs everything when the repository asks for it', () => {
    expect(
      stageAfterIntake({ labels: ['area:console'], specRequiredLabels: SPEC_REQUIRED, specMode: 'autonomous' }),
    ).toBe('spec');
  });
});

describe('where a finished task hands its issue', () => {
  it('moves a spec on to a builder', () => {
    expect(stageAfterTask('spec')).toBe('build');
  });

  it('leaves the stage alone for work that is not a handoff', () => {
    // An implement task ending does not mean the pull request is reviewed; the
    // bridge moves that stage from the pull request's own events.
    expect(stageAfterTask('implement')).toBeNull();
    expect(stageAfterTask('review')).toBeNull();
    expect(stageAfterTask('deploy')).toBeNull();
  });
});

describe('an issue intake cannot shape', () => {
  it('is left for a person after two tries that kept it in intake, said once, while another is still staffed', async () => {
    // Every unlabeled issue now goes to intake, and the hourly sweep staffs
    // whatever is in intake: an issue that intake could not shape would be
    // triaged again every hour.
    const now = new Date().toISOString();
    board.issues = [
      { number: 9, repoName: 'openadlc', stage: 'intake', labels: ['adlc:intake'], createdAt: '2026-09-29T09:00:00.000Z' },
      { number: 8, repoName: 'openadlc', stage: 'intake', labels: ['adlc:intake'], createdAt: '2026-09-29T09:05:00.000Z' },
    ];
    board.onSubject = {
      'openadlc#9': [
        { kind: 'intake', state: 'done', createdAt: now },
        { kind: 'intake', state: 'done', createdAt: now },
      ],
      'openadlc#8': [{ kind: 'intake', state: 'done', createdAt: now }],
    };
    board.events = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const started: string[] = [];
    const stages = new StageHandoff(
      {} as never,
      { open: async (input: { subjectRef: string }) => (started.push(input.subjectRef), { taskId: 'task-1', session: null }) } as never,
    );

    await stages.sweep();
    await stages.sweep();

    expect(started).toEqual(['openadlc#8', 'openadlc#8']);
    expect(board.events).toEqual([{ source: 'platform', type: 'intake.stalled', payload: { subjectRef: 'openadlc#9', tries: 2 } }]);
    warn.mockRestore();
    board.onSubject = {};
  });
});

describe('an issue labelled openadlc:ignore', () => {
  it('is not staffed, and the issue beside it still is', async () => {
    // The sweep is the other way a stage starts: a delivery that did not
    // staff, a bot that was busy, a resume after a pause. The label has to
    // hold there too, or intake begins an hour later.
    board.issues = [
      { number: 9, repoName: 'openadlc', stage: 'intake', labels: ['openadlc:ignore'], createdAt: '2026-09-29T09:00:00.000Z' },
      { number: 8, repoName: 'openadlc', stage: 'intake', labels: [], createdAt: '2026-09-29T09:05:00.000Z' },
    ];
    const started: string[] = [];
    const stages = new StageHandoff(
      {} as never,
      {
        open: async (input: { subjectRef: string }) => {
          started.push(input.subjectRef);
          return { taskId: 'task-1', session: null };
        },
      } as never,
    );

    await stages.sweep();

    expect(started).toEqual(['openadlc#8']);
  });

  it.each(['intake', 'spec'])('is not moved on when a %s task already running finishes', async (kind) => {
    // The task was started before a person added the label, and still ends
    // with a stage move: that put the issue into build, and the move's label
    // write took openadlc:ignore off again.
    board.issues = [{ number: 9, repoName: 'openadlc', stage: kind, labels: [`adlc:${kind}`, 'openadlc:ignore'], createdAt: '2026-09-29T09:00:00.000Z' }];
    const moveStage = vi.fn(async () => ({ moved: true }));
    const started: string[] = [];
    const stages = new StageHandoff(
      { moveStage } as never,
      { open: async (input: { subjectRef: string }) => (started.push(input.subjectRef), { taskId: 'task-1', session: null }) } as never,
    );

    expect(await stages.onTaskDone({ kind, subjectRef: 'openadlc#9' })).toBeNull();
    expect(moveStage).not.toHaveBeenCalled();
    expect(started).toEqual([]);
  });

  it.each(['intake', 'spec'])('is not moved on when a %s task finishes before the label’s delivery is stored', async (kind) => {
    // The stored row has not seen the label yet, so the check above passes.
    // The move reads GitHub's labels, and refuses an ignored issue.
    board.issues = [{ number: 9, repoName: 'openadlc', stage: kind, labels: [`adlc:${kind}`, ...INTAKES_OWN], createdAt: '2026-09-29T09:00:00.000Z' }];
    const moveStage = vi.fn(async () => ({ moved: false, ignored: true }));
    const started: string[] = [];
    const stages = new StageHandoff(
      { moveStage } as never,
      { open: async (input: { subjectRef: string }) => (started.push(input.subjectRef), { taskId: 'task-1', session: null }) } as never,
    );

    expect(await stages.onTaskDone({ kind, subjectRef: 'openadlc#9' })).toBeNull();
    expect(moveStage).toHaveBeenCalledWith(expect.objectContaining({ issueNumber: 9 }));
    expect(started).toEqual([]);
  });
});

describe('a stage staffed for a person’s message', () => {
  // A message to design or intake on its item starts that stage's work, with
  // the message as its brief, or says why not (`MessageStarts`).
  const brief = [{ name: 'message.md', title: 'What jane asked of you', content: 'Keep the old column.' }];

  it('starts the stage’s task with the message beside its context, and says why when it does not', async () => {
    board.issues = [{ number: 9, repoName: 'openadlc', stage: 'spec', labels: ['adlc:spec'], createdAt: '2026-09-29T09:00:00.000Z' }];
    const open = vi.fn(async () => ({ taskId: 'task-1', session: null }));
    const stages = new StageHandoff({} as never, { open } as never, null, async (_key, fn) => fn());

    expect(await stages.staffing({ repoName: 'openadlc', issueNumber: 9, stage: 'spec', brief })).toEqual({ started: true, why: null });
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ kind: 'spec', subjectRef: 'openadlc#9', skill: 'spec', extraContext: brief }));

    board.issues = [{ ...board.issues[0]!, labels: ['adlc:spec', 'openadlc:ignore'] }];
    expect(await stages.staffing({ repoName: 'openadlc', issueNumber: 9, stage: 'spec', brief })).toEqual({ started: false, why: 'openadlc#9 is labelled openadlc:ignore' });

    board.issues = [{ ...board.issues[0]!, labels: ['adlc:spec'] }];
    open.mockRejectedValueOnce(Object.assign(new Error('openadlc-sage-janedoe is running a task, all it may run at once'), { name: 'BotBusyError' }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await stages.staffing({ repoName: 'openadlc', issueNumber: 9, stage: 'spec', brief })).toEqual({
        started: false,
        why: 'openadlc-sage-janedoe is running a task, all it may run at once',
        later: true,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('tries intake again on an issue it gave up on: a person’s message is the decision the tries wait for', async () => {
    const now = new Date().toISOString();
    board.issues = [{ number: 9, repoName: 'openadlc', stage: 'intake', labels: ['adlc:intake'], createdAt: '2026-09-29T09:00:00.000Z' }];
    board.onSubject = { 'openadlc#9': [{ kind: 'intake', state: 'done', createdAt: now }, { kind: 'intake', state: 'done', createdAt: now }] };
    board.events = [];
    const open = vi.fn(async () => ({ taskId: 'task-1', session: null }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const stages = new StageHandoff({} as never, { open } as never, null, async (_key, fn) => fn());
      expect(await stages.staffing({ repoName: 'openadlc', issueNumber: 9, stage: 'intake' })).toEqual({ started: false, why: 'intake has had its tries at openadlc#9; a person decides now' });
      expect(await stages.staffing({ repoName: 'openadlc', issueNumber: 9, stage: 'intake', brief })).toEqual({ started: true, why: null });
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      board.onSubject = {};
    }
  });
});

describe('an issue that is closed on GitHub', () => {
  const opening = (started: string[]) =>
    ({ open: vi.fn(async (input: { subjectRef: string }) => (started.push(input.subjectRef), { taskId: 'task-1', session: null })) }) as never;
  const lock = async <T,>(_key: string, fn: () => Promise<T>) => fn();

  beforeEach(() => {
    board.issues = [];
  });

  it('is not staffed, and one that is open, or that GitHub cannot be asked about, still is', async () => {
    const started: string[] = [];
    const closed = vi.fn(async (_repo: string, number: number) => {
      if (number === 3) throw new Error('GitHub is down');
      return number === 9;
    });
    const stages = new StageHandoff({} as never, opening(started), null, lock, closed);

    expect(await stages.staff({ repoName: 'openadlc', issueNumber: 9, stage: 'spec' })).toBe(false);
    expect(closed).toHaveBeenCalledWith('janedoe/openadlc', 9);
    expect(started).toEqual([]);
    expect(await stages.staff({ repoName: 'openadlc', issueNumber: 8, stage: 'spec' })).toBe(true);
    expect(await stages.staff({ repoName: 'openadlc', issueNumber: 3, stage: 'intake' })).toBe(true);
    expect(started).toEqual(['openadlc#8', 'openadlc#3']);
  });

  it('is not started by the sweep while its row is still on the board', async () => {
    // Cancel closes the issue; the reconciler forgets the row only on its pass.
    board.issues = [
      { number: 9, repoName: 'openadlc', stage: 'intake', labels: ['adlc:intake'], createdAt: '2026-09-29T09:00:00.000Z' },
      { number: 8, repoName: 'openadlc', stage: 'intake', labels: ['adlc:intake'], createdAt: '2026-09-29T09:05:00.000Z' },
    ];
    const started: string[] = [];
    const stages = new StageHandoff({} as never, opening(started), null, lock, async (_repo, number) => number === 9);

    await stages.sweep();

    expect(started).toEqual(['openadlc#8']);
  });
});

describe('a task that ended by sending its work back', () => {
  beforeEach(() => {
    board.sentBack = {};
  });

  it('hands nothing on, and starts the stage the work went back to now that the task is out of the way', async () => {
    // A build that sent its issue back to design ended `done`. Handed on as a
    // finished build would be, the design pass it asked for would never start.
    board.issues = [{ number: 9, repoName: 'openadlc', stage: 'spec', labels: ['adlc:spec'], createdAt: '2026-09-29T09:00:00.000Z' }];
    board.sentBack = { 'task-build': { repoId: 'repo-1', issueNumber: 9, from: 'build', to: 'spec', kind: 'send_back' } };
    const moveStage = vi.fn(async () => ({ moved: true }));
    const started: string[] = [];
    const stages = new StageHandoff(
      { moveStage } as never,
      { open: async (input: { kind: string; subjectRef: string }) => (started.push(`${input.kind} ${input.subjectRef}`), { taskId: 'task-2', session: null }) } as never,
    );

    expect(await stages.onTaskDone({ kind: 'implement', subjectRef: 'openadlc#9', taskId: 'task-build' })).toBeNull();
    expect(moveStage).not.toHaveBeenCalled();
    expect(started).toEqual(['spec openadlc#9']);
  });

  it('does not hand a design on to build when the design sent its issue back to intake', async () => {
    board.issues = [{ number: 9, repoName: 'openadlc', stage: 'intake', labels: ['adlc:intake'], createdAt: '2026-09-29T09:00:00.000Z' }];
    board.sentBack = { 'task-spec': { repoId: 'repo-1', issueNumber: 9, from: 'spec', to: 'intake', kind: 'send_back' } };
    const moveStage = vi.fn(async () => ({ moved: true }));
    const stages = new StageHandoff({ moveStage } as never, { open: async () => ({ taskId: 'task-2', session: null }) } as never);

    expect(await stages.onTaskDone({ kind: 'spec', subjectRef: 'openadlc#9', taskId: 'task-spec' })).toBeNull();
    expect(moveStage).not.toHaveBeenCalled();
  });

  it('moves a card a patch round left in Build back to Review, when the round pushed nothing that moved it', async () => {
    board.issues = [{ number: 11, repoName: 'openadlc', stage: 'build', labels: ['adlc:build'], createdAt: '2026-09-29T09:00:00.000Z' }];
    const moveStage = vi.fn(async () => ({ moved: true }));
    const stages = new StageHandoff({ moveStage } as never, { open: async () => ({ taskId: 'task-2', session: null }) } as never);

    expect(await stages.onTaskDone({ kind: 'patch', subjectRef: 'openadlc#31', taskId: 'task-patch', branch: 'agent/builder/11-issue-11' })).toBe('review');
    expect(moveStage).toHaveBeenCalledWith(expect.objectContaining({ issueNumber: 11, to: 'review' }));

    board.issues = [{ number: 11, repoName: 'openadlc', stage: 'review', labels: ['adlc:review'], createdAt: '2026-09-29T09:00:00.000Z' }];
    moveStage.mockClear();
    expect(await stages.onTaskDone({ kind: 'patch', subjectRef: 'openadlc#31', taskId: 'task-patch', branch: 'agent/builder/11-issue-11' })).toBeNull();
    expect(moveStage).not.toHaveBeenCalled();
  });

  describe('a patch round that pushed nothing', () => {
    // The builder answered the lead in words. The lead's request for changes
    // still stood on the same head, so no lead review was due, and the pull
    // request sat in Review with no task and nobody told.
    const reviewRules = vi.fn(() => ({ reviewers: [{ seat: 'openadlc-lead-janedoe', lead: true }] }));

    beforeEach(() => {
      board.events = [];
      board.onSubject = {};
      board.issues = [{ number: 11, repoName: 'openadlc', stage: 'build', labels: ['adlc:build'], createdAt: '2026-09-29T09:00:00.000Z' }];
    });

    it('hands the pull request back to the lead, to read the replies and decide again', async () => {
      const openLeadReview = vi.fn(async () => 'openadlc#31: started the lead’s review');
      const stages = new StageHandoff({ moveStage: async () => ({ moved: true }), reviewRules } as never, { openLeadReview } as never);
      const ended = new Date().toISOString();

      expect(await stages.onTaskDone({ kind: 'patch', subjectRef: 'openadlc#31', taskId: 'task-patch', branch: 'agent/builder/11-issue-11' })).toBe('review');

      expect(openLeadReview).toHaveBeenCalledWith({
        repo: expect.objectContaining({ name: 'openadlc' }),
        prNumber: 31,
        branch: 'agent/builder/11-issue-11',
        issueNumber: 11,
        seat: 'openadlc-lead-janedoe',
        since: expect.any(String),
      });
      // Not earlier than the round's end, or the lead's review this round
      // answered would be taken for the new one.
      const [{ since }] = openLeadReview.mock.calls[0] as unknown as [{ since: string }];
      expect(Date.parse(since)).toBeGreaterThanOrEqual(Date.parse(ended));
      expect(board.events).toEqual([]);
    });

    it('puts the pull request in Needs you when the lead cannot be asked', async () => {
      const openLeadReview = vi.fn(async () => null);
      const stages = new StageHandoff({ moveStage: async () => ({ moved: true }), reviewRules } as never, { openLeadReview } as never);

      expect(await stages.onTaskDone({ kind: 'patch', subjectRef: 'openadlc#31', taskId: 'task-patch', branch: 'agent/builder/11-issue-11' })).toBe('review');

      expect(board.events).toEqual([
        { source: 'platform', type: 'review.stalled', payload: expect.objectContaining({ repo: 'openadlc', pr: 31, issue: 11 }) },
      ]);
    });

    describe('read against the reviews of its diff', () => {
      const BRANCH = 'agent/builder/11-issue-11';
      const LEAD = 'openadlc-lead-janedoe';
      const SECOND = 'openadlc-vega-janedoe';
      const pull = async () => ({ draft: false, headSha: 'c1c1c1c1', headRef: BRANCH, baseRef: 'main', labels: ['area:bridge'] });
      const standing = (description: string, leadDue: { seat: string; since: string | null } | null = null) =>
        vi.fn(async () => ({
          gate: { state: 'pending', description },
          decision: { reviewers: [SECOND, LEAD], lead: LEAD, approvers: [LEAD] },
          posted: [],
          leadDue,
        }));
      const handoff = (reviewStanding: ReturnType<typeof standing>) => {
        const openLeadReview = vi.fn(async () => 'openadlc#31: started the lead’s review');
        const openMissingReviews = vi.fn(async () => [`openadlc#31: started ${SECOND}’s review`]);
        const stages = new StageHandoff(
          { moveStage: async () => ({ moved: true }), reviewRules, reviewStanding } as never,
          { openLeadReview, openMissingReviews } as never,
          null,
          null,
          null,
          pull,
        );
        return { stages, openLeadReview, openMissingReviews };
      };

      it('asks every seat before the lead that has not reviewed this diff, and not the lead yet', async () => {
        // Sent back for its local CI after its diff changed, the round pushed
        // nothing once the checks passed. Asked only the lead, the pull
        // request waited on the second reviewer for good (#118).
        const reviewStanding = standing(`waiting on ${SECOND}`);
        const { stages, openLeadReview, openMissingReviews } = handoff(reviewStanding);

        expect(await stages.onTaskDone({ kind: 'patch', subjectRef: 'openadlc#31', taskId: 'task-patch', branch: BRANCH })).toBe('review');

        expect(reviewStanding).toHaveBeenCalledWith('janedoe/openadlc', {
          number: 31,
          draft: false,
          labels: [{ name: 'area:bridge' }],
          head: { sha: 'c1c1c1c1', ref: BRANCH },
          baseRef: 'main',
        });
        expect(openMissingReviews).toHaveBeenCalledWith({
          repo: expect.objectContaining({ name: 'openadlc' }),
          prNumber: 31,
          branch: BRANCH,
          issueNumber: 11,
          waitingOn: [SECOND],
        });
        expect(openLeadReview).not.toHaveBeenCalled();
        expect(board.events).toEqual([]);
      });

      it('asks the lead once every other seat has posted on this diff, from when its turn came', async () => {
        const { stages, openLeadReview, openMissingReviews } = handoff(standing(`waiting on ${LEAD}`, { seat: LEAD, since: '2026-10-23T01:30:00.000Z' }));

        expect(await stages.onTaskDone({ kind: 'patch', subjectRef: 'openadlc#31', taskId: 'task-patch', branch: BRANCH })).toBe('review');

        expect(openMissingReviews).not.toHaveBeenCalled();
        expect(openLeadReview).toHaveBeenCalledWith(expect.objectContaining({ seat: LEAD, since: '2026-10-23T01:30:00.000Z' }));
      });

      it('asks the lead to decide again, from now, when its request for changes on this diff is what the round answered', async () => {
        const { stages, openLeadReview, openMissingReviews } = handoff(standing(`changes requested by ${LEAD}`));
        const ended = new Date().toISOString();

        expect(await stages.onTaskDone({ kind: 'patch', subjectRef: 'openadlc#31', taskId: 'task-patch', branch: BRANCH })).toBe('review');

        expect(openMissingReviews).not.toHaveBeenCalled();
        const [{ seat, since }] = openLeadReview.mock.calls[0] as unknown as [{ seat: string; since: string }];
        expect(seat).toBe(LEAD);
        expect(Date.parse(since)).toBeGreaterThanOrEqual(Date.parse(ended));
      });
    });

    it('opens nothing more for a round that pushed, which moved the card already', async () => {
      board.issues = [{ number: 11, repoName: 'openadlc', stage: 'review', labels: ['adlc:review'], createdAt: '2026-09-29T09:00:00.000Z' }];
      const openLeadReview = vi.fn(async () => null);
      const stages = new StageHandoff({ moveStage: async () => ({ moved: true }), reviewRules } as never, { openLeadReview } as never);

      expect(await stages.onTaskDone({ kind: 'patch', subjectRef: 'openadlc#31', taskId: 'task-patch', branch: 'agent/builder/11-issue-11' })).toBeNull();
      expect(openLeadReview).not.toHaveBeenCalled();
      expect(board.events).toEqual([]);
    });
  });
});

describe('staffing a stage while work is paused', () => {
  const PAUSED = 'work is paused, by janedoe since 2026-09-29T08:00:00Z; resume it in Settings → Pause work';

  beforeEach(() => {
    board.audited = [];
    board.locked = [];
    board.issues = [
      { number: 7, repoName: 'openadlc', stage: 'intake', labels: [], createdAt: '2026-09-29T09:10:00.000Z' },
      { number: 5, repoName: 'openadlc', stage: 'intake', labels: ['touches:schema', ...INTAKES_OWN], createdAt: '2026-09-29T09:00:00.000Z' },
      { number: 6, repoName: 'openadlc', stage: 'build', labels: [], createdAt: '2026-09-29T08:00:00.000Z' },
    ];
  });

  function handoff() {
    const gate = new DispatchGate();
    gate.pauseWork(PAUSED);
    const started: string[] = [];
    const stages = new StageHandoff(
      { moveStage: async () => ({ moved: true }) } as never,
      {
        open: async (input: { kind: string; subjectRef: string }) => {
          started.push(`${input.kind} ${input.subjectRef}`);
          return { taskId: 'task-1', session: null };
        },
      } as never,
      gate,
    );
    return { gate, stages, started };
  }

  async function quietly<T>(fn: () => Promise<T>): Promise<T> {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      return await fn();
    } finally {
      log.mockRestore();
    }
  }

  it('starts nothing on the sweep, and audits each issue once', async () => {
    const { stages, started } = handoff();

    expect(await quietly(() => stages.sweep())).toEqual([]);
    await quietly(() => stages.sweep());

    expect(started).toEqual([]);
    expect(board.audited.map((entry) => `${entry.action} ${entry.target}`)).toEqual([
      'stage.deferred openadlc#5',
      'stage.deferred openadlc#7',
    ]);
  });

  it('still hands on the issue whose own task just finished', async () => {
    // The spec after a triage that ran before the pause is the rest of that
    // work, as a review after a build is.
    const { stages, started } = handoff();

    expect(await quietly(() => stages.onTaskDone({ kind: 'intake', subjectRef: 'openadlc#5' }))).toBe('spec');

    expect(started).toEqual(['spec openadlc#5']);
  });

  it('starts what waited, oldest first, when work resumes, and audits it', async () => {
    const { gate, stages, started } = handoff();
    await quietly(() => stages.sweep());

    gate.pauseWork(null);
    await quietly(() => stages.resumed());

    expect(started).toEqual(['intake openadlc#5', 'intake openadlc#7']);
    expect(board.audited.at(-1)).toMatchObject({
      action: 'stage.resumed',
      payload: { deferred: ['openadlc#5:intake', 'openadlc#7:intake'] },
    });
  });

  it('starts a p0 filed during the pause before an older p3', async () => {
    board.issues = [
      { number: 3, repoName: 'openadlc', stage: 'intake', labels: ['priority:p3'], createdAt: '2026-09-29T07:00:00.000Z' },
      { number: 9, repoName: 'openadlc', stage: 'intake', labels: ['priority:p0'], createdAt: '2026-09-29T09:30:00.000Z' },
      { number: 4, repoName: 'openadlc', stage: 'intake', labels: [], createdAt: '2026-09-29T06:00:00.000Z' },
    ];
    const { gate, stages, started } = handoff();
    await quietly(() => stages.sweep());

    gate.pauseWork(null);
    await quietly(() => stages.resumed());

    expect(started).toEqual(['intake openadlc#9', 'intake openadlc#3', 'intake openadlc#4']);
  });

  it('sweeps under the install’s lock, the resume’s drain included', async () => {
    const { gate, stages } = handoff();
    await quietly(() => stages.sweep());
    gate.pauseWork(null);
    await quietly(() => stages.resumed());

    expect(board.locked).toEqual(['openadlc:stage-sweep', 'openadlc:stage-sweep']);
  });

  it('starts what is waiting when work is not paused, and a finished triage hands its issue on', async () => {
    const { gate, stages, started } = handoff();
    gate.pauseWork(null);

    expect(await quietly(() => stages.sweep())).toEqual([
      'started intake on openadlc#5: it was waiting with nobody on it',
      'started intake on openadlc#7: it was waiting with nobody on it',
    ]);
    started.length = 0;
    // #5's triage ended and moved it to spec; #7 still waits on intake.
    board.issues = [
      { number: 5, repoName: 'openadlc', stage: 'spec', labels: ['touches:schema'], createdAt: '2026-09-29T09:00:00.000Z' },
      { number: 7, repoName: 'openadlc', stage: 'intake', labels: [], createdAt: '2026-09-29T09:10:00.000Z' },
    ];

    await quietly(() => stages.onTaskDone({ kind: 'intake', subjectRef: 'openadlc#5' }));

    // The next triage is the `StageRunner`'s to start, for what the intake
    // seat turned away: see "work a busy seat turned away" below.
    expect(started).toEqual(['spec openadlc#5']);
    expect(board.audited).toEqual([]);
  });

  it('audits an issue again in a later pause once the gate opened between, however it opened', async () => {
    // A restore's hold let go, or a pause read back as cleared: neither calls
    // `resumed`, and the issue was still taken for one already said.
    const { gate, stages, started } = handoff();
    await quietly(() => stages.sweep());
    gate.pauseWork(null);
    await quietly(() => stages.staff({ repoName: 'openadlc', issueNumber: 5, stage: 'intake' }));
    gate.pauseWork(PAUSED);
    await quietly(() => stages.staff({ repoName: 'openadlc', issueNumber: 5, stage: 'intake' }));

    expect(started).toEqual(['intake openadlc#5']);
    expect(board.audited.map((entry) => `${entry.action} ${entry.target}`)).toEqual([
      'stage.deferred openadlc#5',
      'stage.deferred openadlc#7',
      'stage.deferred openadlc#5',
    ]);
  });

  it('holds what waited when work is paused again before the resume runs', async () => {
    const { gate, stages, started } = handoff();
    gate.pauseWork(null);
    gate.pauseWork(PAUSED);

    await quietly(() => stages.resumed());

    expect(started).toEqual([]);
  });
});

describe('staffing a stage while one repository is paused', () => {
  beforeEach(() => {
    board.audited = [];
    board.locked = [];
    board.issues = [
      { number: 5, repoName: 'openadlc', stage: 'intake', labels: [], createdAt: '2026-09-29T09:00:00.000Z' },
      { number: 8, repoName: 'openadlc-web', stage: 'intake', labels: [], createdAt: '2026-09-29T09:05:00.000Z' },
    ];
  });

  it('defers that repository’s issues, staffs the rest, and starts them when it alone is resumed', async () => {
    const { repos, issues } = await import('@openadlc/db');
    const both = [
      { id: 'repo-1', name: 'openadlc', stageModes: {}, specRequiredLabels: [] },
      { id: 'repo-2', name: 'openadlc-web', stageModes: {}, specRequiredLabels: [] },
    ];
    vi.mocked(repos.listRepos).mockResolvedValue(both as never);
    vi.mocked(repos.getRepoByName).mockImplementation((async (name: string) => both.find((one) => one.name === name) ?? null) as never);
    vi.mocked(issues.listIssues).mockImplementation((async (name?: string) => board.issues.filter((one) => one.repoName === name)) as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const gate = new DispatchGate();
      gate.pauseRepo('openadlc', 'work is paused in openadlc, by janedoe since 2026-09-29T08:00:00Z; resume it in Settings → Pause work');
      const started: string[] = [];
      const stages = new StageHandoff(
        { moveStage: async () => ({ moved: true }) } as never,
        {
          open: async (input: { kind: string; subjectRef: string }) => {
            started.push(`${input.kind} ${input.subjectRef}`);
            return { taskId: 'task-1', session: null };
          },
        } as never,
        gate,
      );

      await stages.sweep();
      // Asked again, by a delivery say: still deferred, and said once.
      await stages.staff({ repoName: 'openadlc', issueNumber: 5, stage: 'intake' });
      expect(started).toEqual(['intake openadlc-web#8']);
      expect(board.audited.map((entry) => `${entry.action} ${entry.target}`)).toEqual(['stage.deferred openadlc#5']);

      gate.pauseRepo('openadlc', null);
      started.length = 0;
      await stages.resumed();
      expect(started).toContain('intake openadlc#5');
      expect(board.audited.at(-1)).toMatchObject({ action: 'stage.resumed', payload: { deferred: ['openadlc#5:intake'] } });
    } finally {
      log.mockRestore();
      vi.mocked(repos.listRepos).mockResolvedValue([{ id: 'repo-1', name: 'openadlc' }] as never);
      vi.mocked(repos.getRepoByName).mockImplementation((async () => ({ id: 'repo-1', name: 'openadlc', stageModes: {}, specRequiredLabels: ['touches:schema'] })) as never);
      vi.mocked(issues.listIssues).mockImplementation((async () => board.issues) as never);
    }
  });

  it('lets go on a resume of only what no pause still holds, and does not say the rest twice', async () => {
    const { repos, issues } = await import('@openadlc/db');
    const both = [
      { id: 'repo-1', name: 'openadlc', stageModes: {}, specRequiredLabels: [] },
      { id: 'repo-2', name: 'openadlc-web', stageModes: {}, specRequiredLabels: [] },
    ];
    vi.mocked(repos.listRepos).mockResolvedValue(both as never);
    vi.mocked(repos.getRepoByName).mockImplementation((async (name: string) => both.find((one) => one.name === name) ?? null) as never);
    vi.mocked(issues.listIssues).mockImplementation((async (name?: string) => board.issues.filter((one) => one.repoName === name)) as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      // The install paused, and openadlc paused on its own besides.
      const gate = new DispatchGate();
      gate.pauseWork('work is paused, by janedoe since 2026-09-29T08:00:00Z; resume it in Settings → Pause work');
      gate.pauseRepo('openadlc', 'work is paused in openadlc, by janedoe since 2026-09-29T08:00:00Z; resume it in Settings → Pause work');
      const started: string[] = [];
      const stages = new StageHandoff(
        { moveStage: async () => ({ moved: true }) } as never,
        {
          open: async (input: { kind: string; subjectRef: string }) => {
            started.push(`${input.kind} ${input.subjectRef}`);
            return { taskId: 'task-1', session: null };
          },
        } as never,
        gate,
      );
      await stages.sweep();
      expect(board.audited.map((entry) => `${entry.action} ${entry.target}`)).toEqual(['stage.deferred openadlc#5', 'stage.deferred openadlc-web#8']);

      // The install resumed; openadlc's own pause stands.
      gate.pauseWork(null);
      await stages.resumed();

      expect(started).toEqual(['intake openadlc-web#8']);
      expect(board.audited.map((entry) => `${entry.action} ${entry.target}`)).toEqual([
        'stage.deferred openadlc#5',
        'stage.deferred openadlc-web#8',
        'stage.resumed dispatch',
      ]);
      expect(board.audited.at(-1)).toMatchObject({ payload: { deferred: ['openadlc-web#8:intake'] } });

      // Its own resume lets it go too.
      gate.pauseRepo('openadlc', null);
      await stages.resumed();
      // (openadlc-web#8 is started again only because this test's tasks list nothing running.)
      expect(started.slice(1)).toContain('intake openadlc#5');
      expect(board.audited.at(-1)).toMatchObject({ action: 'stage.resumed', payload: { deferred: ['openadlc#5:intake'] } });
    } finally {
      log.mockRestore();
      vi.mocked(repos.listRepos).mockResolvedValue([{ id: 'repo-1', name: 'openadlc' }] as never);
      vi.mocked(repos.getRepoByName).mockImplementation((async () => ({ id: 'repo-1', name: 'openadlc', stageModes: {}, specRequiredLabels: ['touches:schema'] })) as never);
      vi.mocked(issues.listIssues).mockImplementation((async () => board.issues) as never);
    }
  });
});

describe('the end of intake, on either intake path', () => {
  function handoff() {
    const moves: { issueNumber: number; to: string }[] = [];
    const readiness: { issueNumber: number; blocked: boolean }[] = [];
    const started: string[] = [];
    const automation = {
      // Forward only, as `moveStage` is: Build to Design is refused.
      moveStage: async (input: { issueNumber: number; to: string }) => {
        const issue = board.issues.find((entry) => entry.number === input.issueNumber);
        if (issue?.stage === 'build' && input.to === 'spec') return { moved: false, reason: 'intake task tried to move openadlc#9 from build back to spec' };
        moves.push({ issueNumber: input.issueNumber, to: input.to });
        return { moved: true };
      },
      setBlocked: async (_repo: string, issueNumber: number, blocked: boolean) => void readiness.push({ issueNumber, blocked }),
    };
    const stages = new StageHandoff(
      automation as never,
      {
        open: async (input: { kind: string; subjectRef: string }) => {
          started.push(`${input.kind} ${input.subjectRef}`);
          return { taskId: 'task-1', session: null };
        },
      } as never,
    );
    return { stages, moves, readiness, started };
  }

  async function withRepo<T>(stageModes: Record<string, string>, fn: () => Promise<T>): Promise<T> {
    const { repos } = await import('@openadlc/db');
    vi.mocked(repos.getRepoByName).mockImplementation((async () => ({ id: 'repo-1', name: 'openadlc', fullName: 'janedoe/openadlc', stageModes, specRequiredLabels: ['touches:schema'] })) as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      return await fn();
    } finally {
      warn.mockRestore();
      vi.mocked(repos.getRepoByName).mockImplementation((async () => ({ id: 'repo-1', name: 'openadlc', fullName: 'janedoe/openadlc', stageModes: {}, specRequiredLabels: ['touches:schema'] })) as never);
    }
  }

  const DEPENDS_ON_4 = '### Dependencies\n\n- #4\n';

  it('ends in Build with start:now when every dependency has shipped', async () => {
    board.issues = [
      { number: 9, repoName: 'openadlc', stage: 'intake', labels: ['adlc:spec', ...INTAKES_OWN], body: DEPENDS_ON_4 },
      { number: 4, repoName: 'openadlc', stage: 'done', labels: ['adlc:done'], body: '' },
    ];
    const { stages, moves, readiness } = handoff();

    // Triage guessed Design; the rule, with no trigger label, says Build.
    expect(await withRepo({ spec: 'conditional' }, () => stages.onTaskDone({ kind: 'intake', subjectRef: 'openadlc#9' }))).toBe('build');

    expect(moves).toEqual([{ issueNumber: 9, to: 'build' }]);
    expect(readiness).toEqual([{ issueNumber: 9, blocked: false }]);
  });

  it('ends in Build with blocked while a dependency has not shipped, and leaves one already marked alone', async () => {
    board.issues = [
      { number: 9, repoName: 'openadlc', stage: 'intake', labels: ['adlc:build', ...INTAKES_OWN], body: DEPENDS_ON_4 },
      { number: 4, repoName: 'openadlc', stage: 'build', labels: ['adlc:build'], body: '' },
      { number: 10, repoName: 'openadlc', stage: 'intake', labels: ['adlc:build', 'start:now', ...INTAKES_OWN], body: '' },
    ];
    const { stages, readiness } = handoff();

    await withRepo({ spec: 'conditional' }, () => stages.afterIntake({ repoName: 'openadlc', issueNumber: 9 }));
    await withRepo({ spec: 'conditional' }, () => stages.afterIntake({ repoName: 'openadlc', issueNumber: 10 }));

    expect(readiness).toEqual([{ issueNumber: 9, blocked: true }]);
  });

  it('ends in Build with blocked while a dependency in another repository has not shipped, and start:now once it has', async () => {
    // Read as waiting on nothing, it was given start:now and built before
    // the work in the other repository shipped.
    const { stages, readiness } = handoff();
    try {
      board.issues = [{ number: 9, repoName: 'openadlc', stage: 'intake', labels: ['adlc:build', ...INTAKES_OWN], body: '### Dependencies\n\n- owner/a#1\n' }];
      board.elsewhere = [{ fullName: 'owner/a', number: 1, stage: 'build', labels: ['adlc:build'] }];
      await withRepo({ spec: 'conditional' }, () => stages.afterIntake({ repoName: 'openadlc', issueNumber: 9 }));

      board.elsewhere = [{ fullName: 'owner/a', number: 1, stage: 'done', labels: ['adlc:done'] }];
      await withRepo({ spec: 'conditional' }, () => stages.afterIntake({ repoName: 'openadlc', issueNumber: 9 }));

      expect(readiness).toEqual([
        { issueNumber: 9, blocked: true },
        { issueNumber: 9, blocked: false },
      ]);
    } finally {
      board.elsewhere = [];
    }
  });

  it('sends an issue triage labelled adlc:spec to Build on a repository that does not design', async () => {
    // The console path: the request's issue, filed straight into Design.
    board.issues = [{ number: 9, repoName: 'openadlc', stage: 'spec', labels: ['adlc:spec', 'touches:schema'], body: '' }];
    const { stages, moves, readiness, started } = handoff();

    expect(await withRepo({ spec: 'untouched' }, () => stages.afterIntake({ repoName: 'openadlc', issueNumber: 9 }))).toBe('build');

    expect(moves).toEqual([{ issueNumber: 9, to: 'build' }]);
    expect(readiness).toEqual([{ issueNumber: 9, blocked: false }]);
    expect(started).toEqual([]);
  });

  it('sends an unlabelled issue to Design on a repository with no spec mode stored: Design is Always by default', async () => {
    // The fallback was `conditional`, which sent an issue without a
    // spec-required label, nearly every issue, straight to Build.
    board.issues = [{ number: 9, repoName: 'openadlc', stage: 'intake', labels: ['adlc:build', ...INTAKES_OWN], body: '' }];
    const { stages, moves, readiness, started } = handoff();

    expect(await withRepo({}, () => stages.afterIntake({ repoName: 'openadlc', issueNumber: 9 }))).toBe('spec');

    expect(moves).toEqual([{ issueNumber: 9, to: 'spec' }]);
    expect(readiness).toEqual([]);
    expect(started).toEqual(['spec openadlc#9']);
  });

  it('keeps an issue with a trigger label in Design, and staffs it for spec', async () => {
    board.issues = [{ number: 9, repoName: 'openadlc', stage: 'spec', labels: ['adlc:spec', 'touches:schema'], body: '' }];
    const { stages, moves, readiness, started } = handoff();

    expect(await withRepo({ spec: 'conditional' }, () => stages.afterIntake({ repoName: 'openadlc', issueNumber: 9 }))).toBe('spec');

    expect(moves).toEqual([{ issueNumber: 9, to: 'spec' }]);
    expect(readiness).toEqual([]);
    expect(started).toEqual(['spec openadlc#9']);
  });

  it('says so when the rule asks for a move back, rather than dropping it', async () => {
    board.issues = [{ number: 9, repoName: 'openadlc', stage: 'build', labels: ['adlc:build', 'touches:schema'], body: '' }];
    const { stages, readiness } = handoff();
    const warn = vi.spyOn(console, 'warn');

    const { repos } = await import('@openadlc/db');
    vi.mocked(repos.getRepoByName).mockImplementation((async () => ({ id: 'repo-1', name: 'openadlc', fullName: 'janedoe/openadlc', stageModes: { spec: 'conditional' }, specRequiredLabels: ['touches:schema'] })) as never);
    warn.mockImplementation(() => undefined);
    try {
      expect(await stages.afterIntake({ repoName: 'openadlc', issueNumber: 9 })).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('openadlc#9 stays where intake left it, not in spec'));
      expect(readiness).toEqual([]);
    } finally {
      warn.mockRestore();
      vi.mocked(repos.getRepoByName).mockImplementation((async () => ({ id: 'repo-1', name: 'openadlc', fullName: 'janedoe/openadlc', stageModes: {}, specRequiredLabels: ['touches:schema'] })) as never);
    }
  });
});

describe('the end of intake with one of its labels left off', () => {
  // #203: intake said it put `area:general` on and never did. The issue went
  // on to Design, which ran, and was parked with `needs-triage` only when
  // routing read its labels.
  const now = () => new Date().toISOString();

  beforeEach(() => {
    board.audited = [];
    board.events = [];
    board.onSubject = { 'openadlc#9': [{ kind: 'intake', state: 'done', createdAt: now() }] };
  });

  function handoff(labelsOf: ((fullName: string, number: number) => Promise<string[] | null>) | null = null) {
    const moveStage = vi.fn(async () => ({ moved: true }));
    const open = vi.fn(async () => ({ taskId: 'task-2', session: null }));
    const stages = new StageHandoff({ moveStage, setBlocked: async () => undefined } as never, { open } as never, null, null, null, null, labelsOf);
    return { stages, moveStage, open };
  }

  it('keeps the issue in intake and starts intake again, told which label is missing', async () => {
    board.issues = [{ number: 9, repoName: 'openadlc', stage: 'intake', labels: ['adlc:intake', 'priority:p1', 'do:ai'], body: '' }];
    const { stages, moveStage, open } = handoff();

    expect(await stages.onTaskDone({ kind: 'intake', subjectRef: 'openadlc#9' })).toBe('intake');

    expect(moveStage).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'intake',
        skill: 'triage',
        subjectRef: 'openadlc#9',
        extraContext: [expect.objectContaining({ name: 'missing-labels.md', content: expect.stringContaining('an area label') })],
      }),
    );
    expect(board.audited).toContainEqual(expect.objectContaining({ action: 'intake.labels_missing', target: 'openadlc#9', payload: { missing: ['an area label'] } }));
  });

  it('reads the labels GitHub has now over the stored ones', async () => {
    board.issues = [{ number: 9, repoName: 'openadlc', stage: 'intake', labels: ['adlc:intake', ...INTAKES_OWN], body: '' }];
    const asked: string[] = [];
    const { stages, moveStage, open } = handoff(async (fullName, number) => (asked.push(`${fullName}#${number}`), ['adlc:intake', 'priority:p1', 'do:ai']));

    expect(await stages.afterIntake({ repoName: 'openadlc', issueNumber: 9 })).toBe('intake');

    expect(asked).toEqual(['janedoe/openadlc#9']);
    expect(moveStage).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ kind: 'intake' }));
  });

  it('falls back on the stored labels when GitHub cannot be read', async () => {
    board.issues = [{ number: 9, repoName: 'openadlc', stage: 'intake', labels: ['adlc:intake', ...INTAKES_OWN], body: '' }];
    const { stages, moveStage } = handoff(async () => {
      throw new Error('GitHub is down');
    });

    expect(await stages.afterIntake({ repoName: 'openadlc', issueNumber: 9 })).toBe('spec');
    expect(moveStage).toHaveBeenCalledWith(expect.objectContaining({ to: 'spec' }));
  });

  it('moves an issue with all three on as before', async () => {
    board.issues = [{ number: 9, repoName: 'openadlc', stage: 'intake', labels: ['adlc:intake', ...INTAKES_OWN], body: '' }];
    const { stages, moveStage, open } = handoff(async () => ['adlc:spec', ...INTAKES_OWN]);

    expect(await stages.onTaskDone({ kind: 'intake', subjectRef: 'openadlc#9' })).toBe('spec');

    expect(moveStage).toHaveBeenCalledWith(expect.objectContaining({ issueNumber: 9, to: 'spec' }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ kind: 'spec', skill: 'spec' }));
    expect(board.audited).not.toContainEqual(expect.objectContaining({ action: 'intake.labels_missing' }));
  });

  it('is not started again past intake’s tries, and waits for a person', async () => {
    board.issues = [{ number: 9, repoName: 'openadlc', stage: 'intake', labels: ['adlc:intake', 'priority:p1', 'do:ai'], body: '' }];
    board.onSubject = {
      'openadlc#9': [
        { kind: 'intake', state: 'done', createdAt: now() },
        { kind: 'intake', state: 'done', createdAt: now() },
      ],
    };
    const { stages, moveStage, open } = handoff();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await stages.afterIntake({ repoName: 'openadlc', issueNumber: 9 })).toBeNull();
      expect(await stages.afterIntake({ repoName: 'openadlc', issueNumber: 9 })).toBeNull();
    } finally {
      warn.mockRestore();
    }

    expect(moveStage).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(board.events.filter((event) => event.type === 'intake.stalled')).toEqual([{ source: 'platform', type: 'intake.stalled', payload: { subjectRef: 'openadlc#9', tries: 2 } }]);
  });

  it('leaves an issue a person already moved on to them', async () => {
    board.issues = [{ number: 9, repoName: 'openadlc', stage: 'spec', labels: ['adlc:spec', 'priority:p1', 'do:ai'], body: '' }];
    const { stages, moveStage } = handoff();

    expect(await stages.afterIntake({ repoName: 'openadlc', issueNumber: 9 })).toBe('spec');
    expect(moveStage).toHaveBeenCalledWith(expect.objectContaining({ to: 'spec' }));
  });
});

describe('work a busy seat turned away', () => {
  // On the live install: #141 reached Design while the design seat ran #137's
  // design, and was refused; #137's task ended a minute later, and nothing
  // started #141 until the hourly sweep.
  const SPEC_SEAT = 'bot-spec';
  const WAITING_ON_SEAT = 'stage.waiting_on_seat';

  beforeEach(() => {
    board.events = [];
    board.locked = [];
    board.onSubject = {};
    board.issues = [{ number: 141, repoName: 'openadlc', stage: 'spec', labels: ['priority:p1'], createdAt: '2026-10-23T13:46:00.000Z' }];
  });

  /** A design seat with one task at once, running `running` of them, and what it was asked to start. */
  function seat(open: { refuse?: () => Error } = {}) {
    const world = { running: 1, started: [] as string[], asked: 0 };
    const stages = new StageHandoff(
      { moveStage: async () => ({ moved: true }) } as never,
      {
        open: async (input: { bot: string; kind: string; subjectRef: string }) => {
          world.asked += 1;
          if (open.refuse) throw open.refuse();
          if (world.running >= 1) throw new BotBusyError(input.bot, 1);
          world.running += 1;
          world.started.push(`${input.kind} ${input.subjectRef}`);
          return { taskId: `task-${world.started.length}`, session: null };
        },
      } as never,
    );
    const runs: string[][] = [];
    const runner = new StageRunner(
      {
        start: async (seats) => (runs.push([...seats]), stages.sweep({ seats })),
        waitedOn: () => stages.waitingOnSeats().map((wait) => wait.botId),
        hasRoom: async () => world.running < 1,
      },
      { delayMs: 0, log: () => undefined },
    );
    return { world, stages, runner, runs };
  }

  async function quietly<T>(fn: () => Promise<T>): Promise<T> {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      return await fn();
    } finally {
      warn.mockRestore();
    }
  }

  const waits = () => board.events.filter((event) => event.type === WAITING_ON_SEAT);

  it('is recorded as waiting on that seat, said once however often it is turned away', async () => {
    const { stages } = seat();

    expect(await quietly(() => stages.staff({ repoName: 'openadlc', issueNumber: 141, stage: 'spec', followOn: true }))).toBe(false);
    await quietly(() => stages.sweep());

    expect(stages.waitingOnSeats()).toEqual([
      {
        subjectRef: 'openadlc#141',
        repo: 'openadlc',
        issue: 141,
        stage: 'spec',
        seat: 'openadlc-sage-janedoe',
        botId: SPEC_SEAT,
        maxTasks: 1,
        since: expect.any(String),
      },
    ]);
    expect(waits()).toEqual([
      {
        source: 'platform',
        type: WAITING_ON_SEAT,
        payload: { subjectRef: 'openadlc#141', repo: 'openadlc', issue: 141, stage: 'spec', seat: 'openadlc-sage-janedoe', botId: SPEC_SEAT, maxTasks: 1 },
      },
    ]);
  });

  it('starts when the seat’s task ends, without the hourly sweep, and is no longer waiting', async () => {
    const { world, stages, runner } = seat();
    await quietly(() => stages.staff({ repoName: 'openadlc', issueNumber: 141, stage: 'spec', followOn: true }));

    // #137's design ends: its seat has room, and the task's end says so.
    world.running = 0;
    runner.seatFreed(SPEC_SEAT, 'spec task done');

    await vi.waitFor(() => expect(world.started).toEqual(['spec openadlc#141']));
    expect(stages.waitingOnSeats()).toEqual([]);
    expect(board.locked).toEqual(['openadlc:stage-sweep']);
  });

  it('starts two waiting issues next first, one each time the seat has room', async () => {
    board.issues = [
      { number: 20, repoName: 'openadlc', stage: 'spec', labels: ['priority:p3'], createdAt: '2026-10-23T09:00:00.000Z' },
      { number: 21, repoName: 'openadlc', stage: 'spec', labels: ['priority:p1'], createdAt: '2026-10-23T12:00:00.000Z' },
    ];
    const { world, stages, runner } = seat();
    await quietly(() => stages.staff({ repoName: 'openadlc', issueNumber: 20, stage: 'spec' }));
    await quietly(() => stages.staff({ repoName: 'openadlc', issueNumber: 21, stage: 'spec' }));
    const firstSince = stages.waitingOnSeats().find((wait) => wait.issue === 20)?.since;

    world.running = 0;
    runner.seatFreed(SPEC_SEAT, 'spec task done');
    await vi.waitFor(() => expect(world.started).toEqual(['spec openadlc#21']));
    // Turned away again by the start just made, and still waiting from when it first was.
    await vi.waitFor(() => expect(stages.waitingOnSeats().map((wait) => [wait.issue, wait.since])).toEqual([[20, firstSince]]));

    world.running = 0;
    runner.seatFreed(SPEC_SEAT, 'spec task done');
    await vi.waitFor(() => expect(world.started).toEqual(['spec openadlc#21', 'spec openadlc#20']));
    expect(stages.waitingOnSeats()).toEqual([]);
    expect(waits().map((event) => (event.payload as { issue: number }).issue)).toEqual([20, 21]);
  });

  it('is started once, however many asks arrive, and not again once it has started', async () => {
    const { world, stages, runner, runs } = seat();
    await quietly(() => stages.staff({ repoName: 'openadlc', issueNumber: 141, stage: 'spec' }));

    // Two tasks end at once, and its tasks at once go up meanwhile.
    world.running = 0;
    runner.seatFreed(SPEC_SEAT, 'spec task done');
    runner.seatFreed(SPEC_SEAT, 'spec task failed');
    runner.seatFreed(SPEC_SEAT, 'its tasks at once went up');
    await vi.waitFor(() => expect(world.started).toEqual(['spec openadlc#141']));
    expect(runs).toEqual([[SPEC_SEAT]]);

    // Its task ends too, before the board has moved it: it was not waiting
    // any more, and nothing starts it a second time.
    world.running = 0;
    runner.seatFreed(SPEC_SEAT, 'spec task done');
    await runner.now();
    await quietly(() => stages.sweep({ seats: [SPEC_SEAT] }));

    expect(world.started).toEqual(['spec openadlc#141']);
    expect(world.asked).toBe(2);
  });

  it('does not start a design in its stage that its seat did not turn away: one a person stopped, or one that failed', async () => {
    // Started again the moment its own task ended, a Stop would be undone,
    // and a design that fails would fail again and again.
    const { world, stages, runner } = seat();
    world.running = 0;

    runner.seatFreed(SPEC_SEAT, 'spec task stopped');
    await runner.now();
    await stages.sweep({ seats: [SPEC_SEAT] });

    expect(world.asked).toBe(0);
    expect(board.locked).toEqual([]);
  });

  it('is over once its issue has left the stage, and starts nothing there', async () => {
    const { world, stages } = seat();
    await quietly(() => stages.staff({ repoName: 'openadlc', issueNumber: 141, stage: 'spec' }));
    // A person moved it on to Build meanwhile.
    board.issues = [{ number: 141, repoName: 'openadlc', stage: 'build', labels: ['priority:p1'], createdAt: '2026-10-23T13:46:00.000Z' }];
    world.running = 0;

    await stages.sweep({ seats: [SPEC_SEAT] });

    expect(world.asked).toBe(1);
    expect(stages.waitingOnSeats()).toEqual([]);
  });

  it.each([
    ['a full host', () => new HostFullError('openadlc-sage-janedoe')],
    ['the same work already running', () => new SubjectBusyError('openadlc-sage-janedoe', 'openadlc#141')],
    ['a restart owed', () => new RestartPendingError('openadlc-sage-janedoe', 'OpenADLC restarts onto v0.2.0')],
  ])('is not waiting on the seat when the start was refused for %s', async (_why, refuse) => {
    const { stages } = seat({ refuse });

    await quietly(() => stages.staff({ repoName: 'openadlc', issueNumber: 141, stage: 'spec' }));

    expect(stages.waitingOnSeats()).toEqual([]);
    expect(waits()).toEqual([]);
  });

  it('reads the waits back after a restart, starts them when the seat has room, and does not say them again', async () => {
    board.events = [
      { type: WAITING_ON_SEAT, payload: { subjectRef: 'openadlc#141', repo: 'openadlc', issue: 141, stage: 'spec', seat: 'openadlc-sage-janedoe', botId: SPEC_SEAT, maxTasks: 1 } },
      // Started since, by an earlier run: not waiting.
      { type: WAITING_ON_SEAT, payload: { subjectRef: 'openadlc#140', repo: 'openadlc', issue: 140, stage: 'spec', seat: 'openadlc-sage-janedoe', botId: SPEC_SEAT, maxTasks: 1 } },
    ];
    board.issues = [
      ...board.issues,
      { number: 140, repoName: 'openadlc', stage: 'spec', labels: [], createdAt: '2026-10-01T00:00:00.000Z' },
    ];
    board.onSubject = { 'openadlc#140': [{ subjectRef: 'openadlc#140', kind: 'spec', state: 'running', createdAt: '2026-10-02T00:05:00.000Z' }] };
    const { world, stages, runner } = seat();

    expect(await stages.restoreWaits(Date.parse('2026-10-03T00:00:00.000Z'))).toBe(1);
    expect(stages.waitingOnSeats()).toEqual([expect.objectContaining({ subjectRef: 'openadlc#141', since: '2026-10-02T00:00:00.000Z' })]);
    await quietly(() => stages.staff({ repoName: 'openadlc', issueNumber: 141, stage: 'spec' }));
    expect(waits()).toHaveLength(2);

    // Found by the runner's look: nothing asked when the seat freed.
    world.running = 0;
    await runner.look();

    await vi.waitFor(() => expect(world.started).toEqual(['spec openadlc#141']));
  });

  it('walks only the stages it is given, as a seat’s resume does', async () => {
    board.issues = [
      { number: 7, repoName: 'openadlc', stage: 'intake', labels: [], createdAt: '2026-10-23T09:00:00.000Z' },
      { number: 141, repoName: 'openadlc', stage: 'spec', labels: [], createdAt: '2026-10-23T09:00:00.000Z' },
    ];
    const { world, stages } = seat();
    world.running = 0;

    await stages.sweep({ stages: stagesStaffedBy('spec') });

    expect(stagesStaffedBy('spec')).toEqual(['spec']);
    expect(stagesStaffedBy('intake')).toEqual(['intake']);
    expect(stagesStaffedBy('implement')).toEqual([]);
    expect(world.started).toEqual(['spec openadlc#141']);
  });
});
