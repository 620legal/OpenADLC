import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DispatchGate } from './dispatch-gate.js';
import { StageHandoff, stageAfterIntake, stageAfterTask } from './stage-handoff.js';

const board = vi.hoisted(() => ({
  issues: [] as Record<string, unknown>[],
  audited: [] as Record<string, unknown>[],
  /** The locks a sweep was run under, in order. */
  locked: [] as string[],
  /** The send-back a task made, by task id. */
  sentBack: {} as Record<string, Record<string, unknown>>,
  /** Every task on a subject, ended ones included. */
  onSubject: {} as Record<string, Record<string, unknown>[]>,
  events: [] as { type: string; payload: unknown }[],
}));

vi.mock('@fleetadlc/db', async (importOriginal) => ({
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
      { id: 'bot-intake', name: 'fleetadlc-scout-janedoe', role: 'intake' },
      { id: 'bot-spec', name: 'fleetadlc-sage-janedoe', role: 'spec' },
    ]),
  },
  issues: {
    listIssues: vi.fn(async () => board.issues),
    getIssue: vi.fn(async (_repoId: string, number: number) => board.issues.find((entry) => entry.number === number) ?? null),
    byNextFirst: (await importOriginal<typeof import('@fleetadlc/db')>()).issues.byNextFirst,
  },
  repos: {
    getRepoByName: vi.fn(async () => ({ id: 'repo-1', name: 'fleetadlc', fullName: 'janedoe/fleetadlc', stageModes: {}, specRequiredLabels: ['touches:schema'] })),
    listRepos: vi.fn(async () => [{ id: 'repo-1', name: 'fleetadlc' }]),
  },
  tasks: {
    listTasks: vi.fn(async () => []),
    listTasksOnSubjects: vi.fn(async (refs: readonly string[]) => refs.flatMap((ref) => board.onSubject[ref] ?? [])),
  },
  recordEvent: vi.fn(async (event: { type: string; payload: unknown }) => (board.events.push(event), 'event-1')),
  listEventsOfType: vi.fn(async (type: string) => board.events.filter((event) => event.type === type).map((event) => ({ id: 1, at: '2026-10-02T00:00:00.000Z', payload: event.payload }))),
  stageMoves: { sendBackOfTask: vi.fn(async (taskId: string) => board.sentBack[taskId] ?? null) },
}));

const SPEC_REQUIRED = ['touches:schema', 'touches:contract', 'touches:migration', 'size:large', 'safety'];

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
      { number: 9, repoName: 'fleetadlc', stage: 'intake', labels: ['adlc:intake'], createdAt: '2026-09-29T09:00:00.000Z' },
      { number: 8, repoName: 'fleetadlc', stage: 'intake', labels: ['adlc:intake'], createdAt: '2026-09-29T09:05:00.000Z' },
    ];
    board.onSubject = {
      'fleetadlc#9': [
        { kind: 'intake', state: 'done', createdAt: now },
        { kind: 'intake', state: 'done', createdAt: now },
      ],
      'fleetadlc#8': [{ kind: 'intake', state: 'done', createdAt: now }],
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

    expect(started).toEqual(['fleetadlc#8', 'fleetadlc#8']);
    expect(board.events).toEqual([{ source: 'platform', type: 'intake.stalled', payload: { subjectRef: 'fleetadlc#9', tries: 2 } }]);
    warn.mockRestore();
    board.onSubject = {};
  });
});

describe('an issue labelled fleetadlc:ignore', () => {
  it('is not staffed, and the issue beside it still is', async () => {
    // The sweep is the other way a stage starts: a delivery that did not
    // staff, a bot that was busy, a resume after a pause. The label has to
    // hold there too, or intake begins an hour later.
    board.issues = [
      { number: 9, repoName: 'fleetadlc', stage: 'intake', labels: ['fleetadlc:ignore'], createdAt: '2026-09-29T09:00:00.000Z' },
      { number: 8, repoName: 'fleetadlc', stage: 'intake', labels: [], createdAt: '2026-09-29T09:05:00.000Z' },
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

    expect(started).toEqual(['fleetadlc#8']);
  });

  it.each(['intake', 'spec'])('is not moved on when a %s task already running finishes', async (kind) => {
    // The task was started before a person added the label, and still ends
    // with a stage move: that put the issue into build, and the move's label
    // write took fleetadlc:ignore off again.
    board.issues = [{ number: 9, repoName: 'fleetadlc', stage: kind, labels: [`adlc:${kind}`, 'fleetadlc:ignore'], createdAt: '2026-09-29T09:00:00.000Z' }];
    const moveStage = vi.fn(async () => ({ moved: true }));
    const started: string[] = [];
    const stages = new StageHandoff(
      { moveStage } as never,
      { open: async (input: { subjectRef: string }) => (started.push(input.subjectRef), { taskId: 'task-1', session: null }) } as never,
    );

    expect(await stages.onTaskDone({ kind, subjectRef: 'fleetadlc#9' })).toBeNull();
    expect(moveStage).not.toHaveBeenCalled();
    expect(started).toEqual([]);
  });

  it.each(['intake', 'spec'])('is not moved on when a %s task finishes before the label’s delivery is stored', async (kind) => {
    // The stored row has not seen the label yet, so the check above passes.
    // The move reads GitHub's labels, and refuses an ignored issue.
    board.issues = [{ number: 9, repoName: 'fleetadlc', stage: kind, labels: [`adlc:${kind}`], createdAt: '2026-09-29T09:00:00.000Z' }];
    const moveStage = vi.fn(async () => ({ moved: false, ignored: true }));
    const started: string[] = [];
    const stages = new StageHandoff(
      { moveStage } as never,
      { open: async (input: { subjectRef: string }) => (started.push(input.subjectRef), { taskId: 'task-1', session: null }) } as never,
    );

    expect(await stages.onTaskDone({ kind, subjectRef: 'fleetadlc#9' })).toBeNull();
    expect(moveStage).toHaveBeenCalledWith(expect.objectContaining({ issueNumber: 9 }));
    expect(started).toEqual([]);
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

    expect(await stages.staff({ repoName: 'fleetadlc', issueNumber: 9, stage: 'spec' })).toBe(false);
    expect(closed).toHaveBeenCalledWith('janedoe/fleetadlc', 9);
    expect(started).toEqual([]);
    expect(await stages.staff({ repoName: 'fleetadlc', issueNumber: 8, stage: 'spec' })).toBe(true);
    expect(await stages.staff({ repoName: 'fleetadlc', issueNumber: 3, stage: 'intake' })).toBe(true);
    expect(started).toEqual(['fleetadlc#8', 'fleetadlc#3']);
  });

  it('is not started by the sweep while its row is still on the board', async () => {
    // Cancel closes the issue; the reconciler forgets the row only on its pass.
    board.issues = [
      { number: 9, repoName: 'fleetadlc', stage: 'intake', labels: ['adlc:intake'], createdAt: '2026-09-29T09:00:00.000Z' },
      { number: 8, repoName: 'fleetadlc', stage: 'intake', labels: ['adlc:intake'], createdAt: '2026-09-29T09:05:00.000Z' },
    ];
    const started: string[] = [];
    const stages = new StageHandoff({} as never, opening(started), null, lock, async (_repo, number) => number === 9);

    await stages.sweep();

    expect(started).toEqual(['fleetadlc#8']);
  });
});

describe('a task that ended by sending its work back', () => {
  beforeEach(() => {
    board.sentBack = {};
  });

  it('hands nothing on, and starts the stage the work went back to now that the task is out of the way', async () => {
    // A build that sent its issue back to design ended `done`. Handed on as a
    // finished build would be, the design pass it asked for would never start.
    board.issues = [{ number: 9, repoName: 'fleetadlc', stage: 'spec', labels: ['adlc:spec'], createdAt: '2026-09-29T09:00:00.000Z' }];
    board.sentBack = { 'task-build': { repoId: 'repo-1', issueNumber: 9, from: 'build', to: 'spec', kind: 'send_back' } };
    const moveStage = vi.fn(async () => ({ moved: true }));
    const started: string[] = [];
    const stages = new StageHandoff(
      { moveStage } as never,
      { open: async (input: { kind: string; subjectRef: string }) => (started.push(`${input.kind} ${input.subjectRef}`), { taskId: 'task-2', session: null }) } as never,
    );

    expect(await stages.onTaskDone({ kind: 'implement', subjectRef: 'fleetadlc#9', taskId: 'task-build' })).toBeNull();
    expect(moveStage).not.toHaveBeenCalled();
    expect(started).toEqual(['spec fleetadlc#9']);
  });

  it('does not hand a design on to build when the design sent its issue back to intake', async () => {
    board.issues = [{ number: 9, repoName: 'fleetadlc', stage: 'intake', labels: ['adlc:intake'], createdAt: '2026-09-29T09:00:00.000Z' }];
    board.sentBack = { 'task-spec': { repoId: 'repo-1', issueNumber: 9, from: 'spec', to: 'intake', kind: 'send_back' } };
    const moveStage = vi.fn(async () => ({ moved: true }));
    const stages = new StageHandoff({ moveStage } as never, { open: async () => ({ taskId: 'task-2', session: null }) } as never);

    expect(await stages.onTaskDone({ kind: 'spec', subjectRef: 'fleetadlc#9', taskId: 'task-spec' })).toBeNull();
    expect(moveStage).not.toHaveBeenCalled();
  });

  it('moves a card a patch round left in Build back to Review, when the round pushed nothing that moved it', async () => {
    board.issues = [{ number: 11, repoName: 'fleetadlc', stage: 'build', labels: ['adlc:build'], createdAt: '2026-09-29T09:00:00.000Z' }];
    const moveStage = vi.fn(async () => ({ moved: true }));
    const stages = new StageHandoff({ moveStage } as never, { open: async () => ({ taskId: 'task-2', session: null }) } as never);

    expect(await stages.onTaskDone({ kind: 'patch', subjectRef: 'fleetadlc#31', taskId: 'task-patch', branch: 'agent/builder/11-issue-11' })).toBe('review');
    expect(moveStage).toHaveBeenCalledWith(expect.objectContaining({ issueNumber: 11, to: 'review' }));

    board.issues = [{ number: 11, repoName: 'fleetadlc', stage: 'review', labels: ['adlc:review'], createdAt: '2026-09-29T09:00:00.000Z' }];
    moveStage.mockClear();
    expect(await stages.onTaskDone({ kind: 'patch', subjectRef: 'fleetadlc#31', taskId: 'task-patch', branch: 'agent/builder/11-issue-11' })).toBeNull();
    expect(moveStage).not.toHaveBeenCalled();
  });

  describe('a patch round that pushed nothing', () => {
    // The builder answered the lead in words. The lead's request for changes
    // still stood on the same head, so no lead review was due, and the pull
    // request sat in Review with no task and nobody told.
    const reviewRules = vi.fn(() => ({ reviewers: [{ seat: 'fleetadlc-lead-janedoe', lead: true }] }));

    beforeEach(() => {
      board.events = [];
      board.onSubject = {};
      board.issues = [{ number: 11, repoName: 'fleetadlc', stage: 'build', labels: ['adlc:build'], createdAt: '2026-09-29T09:00:00.000Z' }];
    });

    it('hands the pull request back to the lead, to read the replies and decide again', async () => {
      const openLeadReview = vi.fn(async () => 'fleetadlc#31: started the lead’s review');
      const stages = new StageHandoff({ moveStage: async () => ({ moved: true }), reviewRules } as never, { openLeadReview } as never);
      const ended = new Date().toISOString();

      expect(await stages.onTaskDone({ kind: 'patch', subjectRef: 'fleetadlc#31', taskId: 'task-patch', branch: 'agent/builder/11-issue-11' })).toBe('review');

      expect(openLeadReview).toHaveBeenCalledWith({
        repo: expect.objectContaining({ name: 'fleetadlc' }),
        prNumber: 31,
        branch: 'agent/builder/11-issue-11',
        issueNumber: 11,
        seat: 'fleetadlc-lead-janedoe',
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

      expect(await stages.onTaskDone({ kind: 'patch', subjectRef: 'fleetadlc#31', taskId: 'task-patch', branch: 'agent/builder/11-issue-11' })).toBe('review');

      expect(board.events).toEqual([
        { source: 'platform', type: 'review.stalled', payload: expect.objectContaining({ repo: 'fleetadlc', pr: 31, issue: 11 }) },
      ]);
    });

    it('opens nothing more for a round that pushed, which moved the card already', async () => {
      board.issues = [{ number: 11, repoName: 'fleetadlc', stage: 'review', labels: ['adlc:review'], createdAt: '2026-09-29T09:00:00.000Z' }];
      const openLeadReview = vi.fn(async () => null);
      const stages = new StageHandoff({ moveStage: async () => ({ moved: true }), reviewRules } as never, { openLeadReview } as never);

      expect(await stages.onTaskDone({ kind: 'patch', subjectRef: 'fleetadlc#31', taskId: 'task-patch', branch: 'agent/builder/11-issue-11' })).toBeNull();
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
      { number: 7, repoName: 'fleetadlc', stage: 'intake', labels: [], createdAt: '2026-09-29T09:10:00.000Z' },
      { number: 5, repoName: 'fleetadlc', stage: 'intake', labels: ['touches:schema'], createdAt: '2026-09-29T09:00:00.000Z' },
      { number: 6, repoName: 'fleetadlc', stage: 'build', labels: [], createdAt: '2026-09-29T08:00:00.000Z' },
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
      'stage.deferred fleetadlc#5',
      'stage.deferred fleetadlc#7',
    ]);
  });

  it('still hands on the issue whose own task just finished', async () => {
    // The spec after a triage that ran before the pause is the rest of that
    // work, as a review after a build is.
    const { stages, started } = handoff();

    expect(await quietly(() => stages.onTaskDone({ kind: 'intake', subjectRef: 'fleetadlc#5' }))).toBe('spec');

    expect(started).toEqual(['spec fleetadlc#5']);
  });

  it('starts what waited, oldest first, when work resumes, and audits it', async () => {
    const { gate, stages, started } = handoff();
    await quietly(() => stages.sweep());

    gate.pauseWork(null);
    await quietly(() => stages.resumed());

    expect(started).toEqual(['intake fleetadlc#5', 'intake fleetadlc#7']);
    expect(board.audited.at(-1)).toMatchObject({
      action: 'stage.resumed',
      payload: { deferred: ['fleetadlc#5:intake', 'fleetadlc#7:intake'] },
    });
  });

  it('starts a p0 filed during the pause before an older p3', async () => {
    board.issues = [
      { number: 3, repoName: 'fleetadlc', stage: 'intake', labels: ['priority:p3'], createdAt: '2026-09-29T07:00:00.000Z' },
      { number: 9, repoName: 'fleetadlc', stage: 'intake', labels: ['priority:p0'], createdAt: '2026-09-29T09:30:00.000Z' },
      { number: 4, repoName: 'fleetadlc', stage: 'intake', labels: [], createdAt: '2026-09-29T06:00:00.000Z' },
    ];
    const { gate, stages, started } = handoff();
    await quietly(() => stages.sweep());

    gate.pauseWork(null);
    await quietly(() => stages.resumed());

    expect(started).toEqual(['intake fleetadlc#9', 'intake fleetadlc#3', 'intake fleetadlc#4']);
  });

  it('sweeps under the install’s lock, the resume’s drain included', async () => {
    const { gate, stages } = handoff();
    await quietly(() => stages.sweep());
    gate.pauseWork(null);
    await quietly(() => stages.resumed());

    expect(board.locked).toEqual(['fleetadlc:stage-sweep', 'fleetadlc:stage-sweep']);
  });

  it('starts what is waiting when work is not paused, and a finished triage starts the next', async () => {
    const { gate, stages, started } = handoff();
    gate.pauseWork(null);

    expect(await quietly(() => stages.sweep())).toEqual([
      'started intake on fleetadlc#5: it was waiting with nobody on it',
      'started intake on fleetadlc#7: it was waiting with nobody on it',
    ]);
    started.length = 0;
    // #5's triage ended and moved it to spec; #7 still waits on intake.
    board.issues = [
      { number: 5, repoName: 'fleetadlc', stage: 'spec', labels: ['touches:schema'], createdAt: '2026-09-29T09:00:00.000Z' },
      { number: 7, repoName: 'fleetadlc', stage: 'intake', labels: [], createdAt: '2026-09-29T09:10:00.000Z' },
    ];

    await quietly(() => stages.onTaskDone({ kind: 'intake', subjectRef: 'fleetadlc#5' }));

    expect(started).toEqual(['spec fleetadlc#5', 'intake fleetadlc#7']);
    expect(board.audited).toEqual([]);
  });

  it('audits an issue again in a later pause once the gate opened between, however it opened', async () => {
    // A restore's hold let go, or a pause read back as cleared: neither calls
    // `resumed`, and the issue was still taken for one already said.
    const { gate, stages, started } = handoff();
    await quietly(() => stages.sweep());
    gate.pauseWork(null);
    await quietly(() => stages.staff({ repoName: 'fleetadlc', issueNumber: 5, stage: 'intake' }));
    gate.pauseWork(PAUSED);
    await quietly(() => stages.staff({ repoName: 'fleetadlc', issueNumber: 5, stage: 'intake' }));

    expect(started).toEqual(['intake fleetadlc#5']);
    expect(board.audited.map((entry) => `${entry.action} ${entry.target}`)).toEqual([
      'stage.deferred fleetadlc#5',
      'stage.deferred fleetadlc#7',
      'stage.deferred fleetadlc#5',
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
      { number: 5, repoName: 'fleetadlc', stage: 'intake', labels: [], createdAt: '2026-09-29T09:00:00.000Z' },
      { number: 8, repoName: 'fleetadlc-web', stage: 'intake', labels: [], createdAt: '2026-09-29T09:05:00.000Z' },
    ];
  });

  it('defers that repository’s issues, staffs the rest, and starts them when it alone is resumed', async () => {
    const { repos, issues } = await import('@fleetadlc/db');
    const both = [
      { id: 'repo-1', name: 'fleetadlc', stageModes: {}, specRequiredLabels: [] },
      { id: 'repo-2', name: 'fleetadlc-web', stageModes: {}, specRequiredLabels: [] },
    ];
    vi.mocked(repos.listRepos).mockResolvedValue(both as never);
    vi.mocked(repos.getRepoByName).mockImplementation((async (name: string) => both.find((one) => one.name === name) ?? null) as never);
    vi.mocked(issues.listIssues).mockImplementation((async (name?: string) => board.issues.filter((one) => one.repoName === name)) as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const gate = new DispatchGate();
      gate.pauseRepo('fleetadlc', 'work is paused in fleetadlc, by janedoe since 2026-09-29T08:00:00Z; resume it in Settings → Pause work');
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
      await stages.staff({ repoName: 'fleetadlc', issueNumber: 5, stage: 'intake' });
      expect(started).toEqual(['intake fleetadlc-web#8']);
      expect(board.audited.map((entry) => `${entry.action} ${entry.target}`)).toEqual(['stage.deferred fleetadlc#5']);

      gate.pauseRepo('fleetadlc', null);
      started.length = 0;
      await stages.resumed();
      expect(started).toContain('intake fleetadlc#5');
      expect(board.audited.at(-1)).toMatchObject({ action: 'stage.resumed', payload: { deferred: ['fleetadlc#5:intake'] } });
    } finally {
      log.mockRestore();
      vi.mocked(repos.listRepos).mockResolvedValue([{ id: 'repo-1', name: 'fleetadlc' }] as never);
      vi.mocked(repos.getRepoByName).mockImplementation((async () => ({ id: 'repo-1', name: 'fleetadlc', stageModes: {}, specRequiredLabels: ['touches:schema'] })) as never);
      vi.mocked(issues.listIssues).mockImplementation((async () => board.issues) as never);
    }
  });

  it('lets go on a resume of only what no pause still holds, and does not say the rest twice', async () => {
    const { repos, issues } = await import('@fleetadlc/db');
    const both = [
      { id: 'repo-1', name: 'fleetadlc', stageModes: {}, specRequiredLabels: [] },
      { id: 'repo-2', name: 'fleetadlc-web', stageModes: {}, specRequiredLabels: [] },
    ];
    vi.mocked(repos.listRepos).mockResolvedValue(both as never);
    vi.mocked(repos.getRepoByName).mockImplementation((async (name: string) => both.find((one) => one.name === name) ?? null) as never);
    vi.mocked(issues.listIssues).mockImplementation((async (name?: string) => board.issues.filter((one) => one.repoName === name)) as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      // The install paused, and fleetadlc paused on its own besides.
      const gate = new DispatchGate();
      gate.pauseWork('work is paused, by janedoe since 2026-09-29T08:00:00Z; resume it in Settings → Pause work');
      gate.pauseRepo('fleetadlc', 'work is paused in fleetadlc, by janedoe since 2026-09-29T08:00:00Z; resume it in Settings → Pause work');
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
      expect(board.audited.map((entry) => `${entry.action} ${entry.target}`)).toEqual(['stage.deferred fleetadlc#5', 'stage.deferred fleetadlc-web#8']);

      // The install resumed; fleetadlc's own pause stands.
      gate.pauseWork(null);
      await stages.resumed();

      expect(started).toEqual(['intake fleetadlc-web#8']);
      expect(board.audited.map((entry) => `${entry.action} ${entry.target}`)).toEqual([
        'stage.deferred fleetadlc#5',
        'stage.deferred fleetadlc-web#8',
        'stage.resumed dispatch',
      ]);
      expect(board.audited.at(-1)).toMatchObject({ payload: { deferred: ['fleetadlc-web#8:intake'] } });

      // Its own resume lets it go too.
      gate.pauseRepo('fleetadlc', null);
      await stages.resumed();
      // (fleetadlc-web#8 is started again only because this test's tasks list nothing running.)
      expect(started.slice(1)).toContain('intake fleetadlc#5');
      expect(board.audited.at(-1)).toMatchObject({ action: 'stage.resumed', payload: { deferred: ['fleetadlc#5:intake'] } });
    } finally {
      log.mockRestore();
      vi.mocked(repos.listRepos).mockResolvedValue([{ id: 'repo-1', name: 'fleetadlc' }] as never);
      vi.mocked(repos.getRepoByName).mockImplementation((async () => ({ id: 'repo-1', name: 'fleetadlc', stageModes: {}, specRequiredLabels: ['touches:schema'] })) as never);
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
        if (issue?.stage === 'build' && input.to === 'spec') return { moved: false, reason: 'intake task tried to move fleetadlc#9 from build back to spec' };
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
    const { repos } = await import('@fleetadlc/db');
    vi.mocked(repos.getRepoByName).mockImplementation((async () => ({ id: 'repo-1', name: 'fleetadlc', fullName: 'janedoe/fleetadlc', stageModes, specRequiredLabels: ['touches:schema'] })) as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      return await fn();
    } finally {
      warn.mockRestore();
      vi.mocked(repos.getRepoByName).mockImplementation((async () => ({ id: 'repo-1', name: 'fleetadlc', fullName: 'janedoe/fleetadlc', stageModes: {}, specRequiredLabels: ['touches:schema'] })) as never);
    }
  }

  const DEPENDS_ON_4 = '### Dependencies\n\n- #4\n';

  it('ends in Build with start:now when every dependency has shipped', async () => {
    board.issues = [
      { number: 9, repoName: 'fleetadlc', stage: 'intake', labels: ['adlc:spec', 'do:ai'], body: DEPENDS_ON_4 },
      { number: 4, repoName: 'fleetadlc', stage: 'done', labels: ['adlc:done'], body: '' },
    ];
    const { stages, moves, readiness } = handoff();

    // Triage guessed Design; the rule, with no trigger label, says Build.
    expect(await withRepo({ spec: 'conditional' }, () => stages.onTaskDone({ kind: 'intake', subjectRef: 'fleetadlc#9' }))).toBe('build');

    expect(moves).toEqual([{ issueNumber: 9, to: 'build' }]);
    expect(readiness).toEqual([{ issueNumber: 9, blocked: false }]);
  });

  it('ends in Build with blocked while a dependency has not shipped, and leaves one already marked alone', async () => {
    board.issues = [
      { number: 9, repoName: 'fleetadlc', stage: 'intake', labels: ['adlc:build'], body: DEPENDS_ON_4 },
      { number: 4, repoName: 'fleetadlc', stage: 'build', labels: ['adlc:build'], body: '' },
      { number: 10, repoName: 'fleetadlc', stage: 'intake', labels: ['adlc:build', 'start:now'], body: '' },
    ];
    const { stages, readiness } = handoff();

    await withRepo({ spec: 'conditional' }, () => stages.afterIntake({ repoName: 'fleetadlc', issueNumber: 9 }));
    await withRepo({ spec: 'conditional' }, () => stages.afterIntake({ repoName: 'fleetadlc', issueNumber: 10 }));

    expect(readiness).toEqual([{ issueNumber: 9, blocked: true }]);
  });

  it('sends an issue triage labelled adlc:spec to Build on a repository that does not design', async () => {
    // The console path: the request's issue, filed straight into Design.
    board.issues = [{ number: 9, repoName: 'fleetadlc', stage: 'spec', labels: ['adlc:spec', 'touches:schema'], body: '' }];
    const { stages, moves, readiness, started } = handoff();

    expect(await withRepo({ spec: 'untouched' }, () => stages.afterIntake({ repoName: 'fleetadlc', issueNumber: 9 }))).toBe('build');

    expect(moves).toEqual([{ issueNumber: 9, to: 'build' }]);
    expect(readiness).toEqual([{ issueNumber: 9, blocked: false }]);
    expect(started).toEqual([]);
  });

  it('keeps an issue with a trigger label in Design, and staffs it for spec', async () => {
    board.issues = [{ number: 9, repoName: 'fleetadlc', stage: 'spec', labels: ['adlc:spec', 'touches:schema'], body: '' }];
    const { stages, moves, readiness, started } = handoff();

    expect(await withRepo({ spec: 'conditional' }, () => stages.afterIntake({ repoName: 'fleetadlc', issueNumber: 9 }))).toBe('spec');

    expect(moves).toEqual([{ issueNumber: 9, to: 'spec' }]);
    expect(readiness).toEqual([]);
    expect(started).toEqual(['spec fleetadlc#9']);
  });

  it('says so when the rule asks for a move back, rather than dropping it', async () => {
    board.issues = [{ number: 9, repoName: 'fleetadlc', stage: 'build', labels: ['adlc:build', 'touches:schema'], body: '' }];
    const { stages, readiness } = handoff();
    const warn = vi.spyOn(console, 'warn');

    const { repos } = await import('@fleetadlc/db');
    vi.mocked(repos.getRepoByName).mockImplementation((async () => ({ id: 'repo-1', name: 'fleetadlc', fullName: 'janedoe/fleetadlc', stageModes: { spec: 'conditional' }, specRequiredLabels: ['touches:schema'] })) as never);
    warn.mockImplementation(() => undefined);
    try {
      expect(await stages.afterIntake({ repoName: 'fleetadlc', issueNumber: 9 })).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('fleetadlc#9 stays where intake left it, not in spec'));
      expect(readiness).toEqual([]);
    } finally {
      warn.mockRestore();
      vi.mocked(repos.getRepoByName).mockImplementation((async () => ({ id: 'repo-1', name: 'fleetadlc', fullName: 'janedoe/fleetadlc', stageModes: {}, specRequiredLabels: ['touches:schema'] })) as never);
    }
  });
});
