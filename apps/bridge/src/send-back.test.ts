import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Move {
  from: string | null;
  to: string;
  kind: string;
}

const REPO = {
  id: 'repo-1',
  name: 'openadlc-testbed',
  fullName: 'janedoe/openadlc-testbed',
  stageModes: { intake: 'autonomous', spec: 'conditional', build: 'autonomous', review: 'autonomous', merged: 'autonomous', done: 'autonomous' } as Record<string, string>,
};

const world = {
  tasks: new Map<string, Record<string, unknown>>(),
  issue: null as Record<string, unknown> | null,
  moves: [] as Move[],
  lease: null as Record<string, unknown> | null,
  /** The last lease linked to a pull request, and the repository's active ones, for a re-take. */
  lastForPr: null as Record<string, unknown> | null,
  activeLeases: [] as Record<string, unknown>[],
  botTasks: [] as Record<string, unknown>[],
  onSubjects: [] as Record<string, unknown>[],
  audits: [] as Record<string, unknown>[],
  events: [] as Record<string, unknown>[],
  deployRuns: [] as Record<string, unknown>[],
};

vi.mock('@openadlc/db', () => ({
  audit: vi.fn(async (entry: Record<string, unknown>) => {
    world.audits.push(entry);
  }),
  recordEvent: vi.fn(async (entry: Record<string, unknown>) => {
    world.events.push(entry);
  }),
  listEventsOfType: vi.fn(async (type: string) =>
    world.events.filter((event) => event.type === type).map((event, id) => ({ id, at: (event.at as string) ?? '2026-10-04T00:00:00.000Z', payload: event.payload })),
  ),
  listEventsOfTypeWith: vi.fn(async (type: string, fields: Record<string, unknown>) =>
    world.events
      .filter((event) => event.type === type && Object.entries(fields).every(([key, value]) => (event.payload as Record<string, unknown>)[key] === value))
      .map((event, id) => ({ id, at: '2026-10-04T00:00:00.000Z', payload: event.payload })),
  ),
  deployRuns: { forPullRequests: vi.fn(async () => world.deployRuns) },
  bots: {
    getBotById: vi.fn(async (id: string) => ({ id, name: id === 'bot-deploy' ? 'sre' : id === 'bot-spec' ? 'system-engineer' : 'builder' })),
    listBots: vi.fn(async () => [{ id: 'bot-builder', name: 'builder' }]),
  },
  issues: {
    getIssue: vi.fn(async () => world.issue),
    listIssues: vi.fn(async () => (world.issue ? [world.issue] : [])),
    setIssueStage: vi.fn(async () => undefined),
  },
  leases: {
    getActiveLease: vi.fn(async () => world.lease),
    setLeaseState: vi.fn(async () => null),
    lastForPullRequest: vi.fn(async () => world.lastForPr),
    listActiveLeases: vi.fn(async () => world.activeLeases),
    reacquireForPullRequest: vi.fn(async (input: { prNumber: number }) =>
      world.lastForPr ? { ...world.lastForPr, id: 'lease-again', state: 'in_task', prNumber: input.prNumber } : null,
    ),
  },
  repos: {
    listRepos: vi.fn(async () => [REPO]),
    getRepoByName: vi.fn(async () => REPO),
  },
  stageMoves: {
    listForIssue: vi.fn(async () => world.moves),
    record: vi.fn(async () => undefined),
  },
  tasks: {
    getTask: vi.fn(async (id: string) => world.tasks.get(id) ?? null),
    // Newest first, as the store returns them, and only as many as asked for.
    listTasks: vi.fn(async (filter: { botId?: string; states?: string[]; limit?: number } = {}) =>
      world.botTasks
        .filter((task) => (!filter.botId || task.botId === filter.botId) && (!filter.states || filter.states.includes(task.state as string)))
        .slice(0, filter.limit ?? 100),
    ),
    listTasksForSubjects: vi.fn(async (kind: string, subjects: string[]) =>
      world.botTasks.filter((task) => task.kind === kind && subjects.includes(task.subjectRef as string)),
    ),
    listTasksOnSubjects: vi.fn(async () => world.onSubjects),
  },
  threads: { expireGatesOfTask: vi.fn(async () => ['gate-1']) },
}));

import { leases, threads } from '@openadlc/db';
import { designMemoryProposals, parseMarkers } from '@openadlc/shared';
import { SendBack, recordComment } from './send-back.js';
import { PATCH_ROUND_WAITING } from './patch-waits.js';
import { BotBusyError, HostFullError } from './task-service.js';

function sendBack(review: Record<string, unknown> = {}) {
  const automation = {
    moveStage: vi.fn(async () => ({ moved: true })),
    comment: vi.fn(async () => 'https://github.test/janedoe/openadlc-testbed/issues/7#issuecomment-1'),
    parkPull: vi.fn(async () => true),
    reopenIssue: vi.fn(async () => true),
    addLabels: vi.fn(async () => undefined),
    setCiLabel: vi.fn(async () => 'app' as const),
  };
  const pull = { state: 'open', headRef: 'agent/builder/7-issue-7', headSha: 'h1' };
  const client = { getPullRequest: vi.fn(async () => pull), listPullFilesAsNamed: vi.fn(async () => ['src/app.ts']) };
  const mergeLine = { leave: vi.fn(async () => undefined) };
  const taskService = {
    open: vi.fn(async (): Promise<{ taskId: string; session: string | null; error?: string }> => ({ taskId: 'task-patch', session: 's' })),
    wouldWait: vi.fn(async (): Promise<BotBusyError | null> => null),
  };
  const stages = { staff: vi.fn(async () => true) };
  const stopTask = vi.fn(async () => undefined);
  const dispatchRuns = { soon: vi.fn() };
  const service = new SendBack({
    config: { review: { maxRounds: 3, sendBack: { maxPerEdge: 2, maxPerIssue: 6 }, ...review } as never },
    automation: automation as never,
    mergeLine: mergeLine as never,
    taskService: taskService as never,
    stages: stages as never,
    stopTask,
    dispatchRuns,
    client: async () => client as never,
  });
  return { service, automation, mergeLine, taskService, stages, stopTask, dispatchRuns, client };
}

const running = (id: string, input: Record<string, unknown>) => world.tasks.set(id, { id, state: 'running', repoId: REPO.id, ...input });
const designed: Move[] = [
  { from: null, to: 'intake', kind: 'forward' },
  { from: 'intake', to: 'spec', kind: 'forward' },
  { from: 'spec', to: 'build', kind: 'forward' },
];

beforeEach(() => {
  world.tasks.clear();
  world.issue = { number: 7, stage: 'build', prNumber: null, labels: ['adlc:build', 'start:now'] };
  world.moves = [];
  world.lease = { id: 'lease-7', botId: 'bot-builder', declaredPaths: ['src/app.ts'] };
  world.lastForPr = null;
  world.activeLeases = [];
  world.botTasks = [];
  world.onSubjects = [];
  world.audits = [];
  world.events = [];
  world.deployRuns = [];
  REPO.stageModes = { intake: 'autonomous', spec: 'conditional', build: 'autonomous', review: 'autonomous', merged: 'autonomous', done: 'autonomous' };
  vi.mocked(leases.setLeaseState).mockClear();
  vi.mocked(leases.reacquireForPullRequest).mockClear();
  vi.mocked(threads.expireGatesOfTask).mockClear();
});

describe('a task sending its work back', () => {
  it('sends a build back to design when the issue had a design pass, and says why on the issue first', async () => {
    world.moves = designed;
    running('task-build', { kind: 'implement', subjectRef: 'openadlc-testbed#7', botId: 'bot-builder', branch: 'agent/builder/7-issue-7' });
    const { service, automation } = sendBack();

    const result = await service.request({ taskId: 'task-build', to: 'spec', reason: 'the design names no migration for the new column' });

    expect(result).toEqual({ sent: true, from: 'build', to: 'spec', staffed: true, round: 1, commentUrl: expect.stringContaining('issuecomment') });
    const said = automation.comment.mock.calls[0] as unknown as [string, number, string];
    expect(said[0]).toBe('janedoe/openadlc-testbed');
    expect(said[2]).toContain('**Sent back to Design** by builder');
    expect(said[2]).toContain('> the design names no migration for the new column');
    expect(said[2]).toContain('<!-- openadlc:{"event":"send_back","from":"build","to":"spec","by":"builder","round":1} -->');
    expect(automation.moveStage).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'spec', direction: 'send_back', taskId: 'task-build', reason: 'the design names no migration for the new column' }),
    );
    // GitHub first, then the card.
    expect(automation.comment.mock.invocationCallOrder[0]).toBeLessThan(automation.moveStage.mock.invocationCallOrder[0]!);
    expect(world.audits).toContainEqual(expect.objectContaining({ action: 'stage.sent_back', target: 'openadlc-testbed#7' }));
  });

  it('closes the sending task’s questions and lets go of build’s lease', async () => {
    world.moves = designed;
    running('task-build', { kind: 'implement', subjectRef: 'openadlc-testbed#7', botId: 'bot-builder' });
    const { service } = sendBack();

    await service.request({ taskId: 'task-build', to: 'spec', reason: 'no migration' });

    expect(threads.expireGatesOfTask).toHaveBeenCalledWith('task-build', 'bridge', 'the work was sent back to spec');
    expect(leases.setLeaseState).toHaveBeenCalledWith('lease-7', 'released');
  });

  it('parks an open pull request: a draft again, out of the merge line', async () => {
    world.moves = designed;
    world.issue = { ...world.issue, prNumber: 31 };
    running('task-patch', { kind: 'patch', subjectRef: 'openadlc-testbed#31', botId: 'bot-builder', branch: 'agent/builder/7-issue-7' });
    const { service, automation, mergeLine } = sendBack();

    const result = await service.request({ taskId: 'task-patch', to: 'spec', reason: 'the review shows the design cannot hold' });

    expect(result).toMatchObject({ sent: true, to: 'spec' });
    expect(mergeLine.leave).toHaveBeenCalledWith('openadlc-testbed', 31);
    expect(automation.parkPull).toHaveBeenCalledWith('janedoe/openadlc-testbed', 31);
  });

  it('sends back to intake a build that intake sent straight to build, and refuses design', async () => {
    world.moves = [
      { from: null, to: 'intake', kind: 'forward' },
      { from: 'intake', to: 'build', kind: 'forward' },
    ];
    running('task-build', { kind: 'implement', subjectRef: 'openadlc-testbed#7', botId: 'bot-builder' });
    const { service, automation } = sendBack();

    const refused = await service.request({ taskId: 'task-build', to: 'spec', reason: 'unclear' });
    expect(refused).toMatchObject({ sent: false, reason: expect.stringMatching(/back to Intake, not Design/) });
    expect(automation.moveStage).not.toHaveBeenCalled();

    expect(await service.request({ taskId: 'task-build', to: 'intake', reason: 'the issue asks for two things that contradict' })).toMatchObject({
      sent: true,
      to: 'intake',
    });
  });

  it('passes over a design nobody staffs', async () => {
    world.moves = designed;
    REPO.stageModes = { ...REPO.stageModes, spec: 'untouched' };
    running('task-build', { kind: 'implement', subjectRef: 'openadlc-testbed#7', botId: 'bot-builder' });
    const { service } = sendBack();

    expect(await service.request({ taskId: 'task-build', to: 'intake', reason: 'unclear' })).toMatchObject({ sent: true, to: 'intake', staffed: true });
  });

  it('hands the work to a person when nothing on the way back is staffed', async () => {
    world.issue = { number: 7, stage: 'spec', prNumber: null, labels: ['adlc:spec'] };
    REPO.stageModes = { ...REPO.stageModes, intake: 'untouched' };
    running('task-spec', { kind: 'spec', subjectRef: 'openadlc-testbed#7', botId: 'bot-spec' });
    const { service, automation } = sendBack();

    const result = await service.request({ taskId: 'task-spec', to: 'intake', reason: 'two readings of the request' });

    expect(result).toMatchObject({ sent: true, to: 'intake', staffed: false });
    expect(automation.addLabels).toHaveBeenCalledWith('janedoe/openadlc-testbed', 7, ['needs-human']);
    expect(world.events).toContainEqual(expect.objectContaining({ type: 'send_back.to_person' }));
    expect((automation.comment.mock.calls[0] as unknown as string[])[2]).toContain('Nobody staffs Intake in this repository');
  });

  it('sends a shipped change back to build, reopening the issue its merge closed', async () => {
    world.issue = { number: 7, stage: 'merged', prNumber: 31, labels: ['adlc:merged'] };
    world.moves = [...designed, { from: 'build', to: 'review', kind: 'forward' }, { from: 'review', to: 'merged', kind: 'forward' }];
    running('task-deploy', { kind: 'deploy', subjectRef: 'openadlc-testbed#31', botId: 'bot-deploy' });
    const { service, automation, dispatchRuns } = sendBack();

    const result = await service.request({ taskId: 'task-deploy', to: 'build', reason: 'the migration fails on testing data' });

    expect(result).toMatchObject({ sent: true, from: 'merged', to: 'build' });
    expect(automation.reopenIssue).toHaveBeenCalledWith('janedoe/openadlc-testbed', 7);
    expect(automation.reopenIssue.mock.invocationCallOrder[0]).toBeLessThan(automation.moveStage.mock.invocationCallOrder[0]!);
    expect(leases.setLeaseState).toHaveBeenCalledWith('lease-7', 'released');
    expect(dispatchRuns.soon).toHaveBeenCalled();
    // A merged pull request is not parked: there is nothing open to park.
    expect(automation.parkPull).not.toHaveBeenCalled();
  });

  it('sends back the change a failed testing deploy merged, from the SRE’s task on the issue the bridge filed', async () => {
    world.issue = { number: 7, stage: 'merged', prNumber: 31, labels: ['adlc:merged'] };
    world.moves = [...designed, { from: 'build', to: 'review', kind: 'forward' }, { from: 'review', to: 'merged', kind: 'forward' }];
    world.deployRuns = [{ sha: 'c0ffee01'.padEnd(40, '0'), prNumber: 31 }];
    running('task-sre', { kind: 'deploy', subjectRef: 'openadlc-testbed#900', botId: 'bot-deploy', branch: 'system/deploy-path-c0ffee01' });
    const { service, automation } = sendBack();

    const result = await service.request({ taskId: 'task-sre', to: 'build', reason: 'the migration fails on testing data' });

    expect(result).toMatchObject({ sent: true, from: 'merged', to: 'build' });
    expect(automation.reopenIssue).toHaveBeenCalledWith('janedoe/openadlc-testbed', 7);
    expect(automation.moveStage).toHaveBeenCalledWith(expect.objectContaining({ issueNumber: 7, to: 'build', taskId: 'task-sre' }));
  });

  it('refuses the SRE a send-back when no change on the board merged at its commit', async () => {
    world.issue = { number: 7, stage: 'merged', prNumber: 31, labels: ['adlc:merged'] };
    world.deployRuns = [{ sha: 'deadbeef'.padEnd(40, '0'), prNumber: 31 }];
    running('task-sre', { kind: 'deploy', subjectRef: 'openadlc-testbed#900', botId: 'bot-deploy', branch: 'system/deploy-path-c0ffee01' });
    const { service, automation } = sendBack();

    const result = await service.request({ taskId: 'task-sre', to: 'build', reason: 'the migration fails' });

    expect(result).toMatchObject({ sent: false, reason: expect.stringMatching(/merged at c0ffee01/) });
    expect(automation.moveStage).not.toHaveBeenCalled();
  });

  it('refuses intake, a reviewer, a task not running, a stage the issue is not in, and no reason', async () => {
    const { service } = sendBack();
    running('task-intake', { kind: 'intake', subjectRef: 'openadlc-testbed#7', botId: 'bot-intake' });
    running('task-review', { kind: 'review', subjectRef: 'openadlc-testbed#31', botId: 'bot-lead' });
    world.tasks.set('task-done', { id: 'task-done', state: 'done', kind: 'implement', repoId: REPO.id, subjectRef: 'openadlc-testbed#7', botId: 'bot-builder' });
    running('task-spec', { kind: 'spec', subjectRef: 'openadlc-testbed#7', botId: 'bot-spec' });

    expect(await service.request({ taskId: 'task-intake', to: 'intake', reason: 'x' })).toMatchObject({ sent: false, reason: expect.stringMatching(/ask the person/) });
    expect(await service.request({ taskId: 'task-review', to: 'build', reason: 'x' })).toMatchObject({ sent: false, reason: expect.stringMatching(/requesting changes/) });
    expect(await service.request({ taskId: 'task-done', to: 'spec', reason: 'x' })).toMatchObject({ sent: false, reason: expect.stringMatching(/is done/) });
    expect(await service.request({ taskId: 'task-spec', to: 'intake', reason: 'x' })).toMatchObject({ sent: false, reason: expect.stringMatching(/is in Build, not Design/) });
    expect(await service.request({ taskId: 'task-spec', to: 'intake', reason: '  ' })).toMatchObject({ sent: false, reason: expect.stringMatching(/needs a reason/) });
  });
});

describe('the limits on sending back', () => {
  it('stops at the limit for one edge: nothing moves, needs-human goes on, and a person decides', async () => {
    world.moves = [
      ...designed,
      { from: 'build', to: 'spec', kind: 'send_back' },
      { from: 'spec', to: 'build', kind: 'forward' },
      { from: 'build', to: 'spec', kind: 'send_back' },
      { from: 'spec', to: 'build', kind: 'forward' },
    ];
    running('task-build', { kind: 'implement', subjectRef: 'openadlc-testbed#7', botId: 'bot-builder' });
    const { service, automation } = sendBack();

    const result = await service.request({ taskId: 'task-build', to: 'spec', reason: 'still no migration' });

    expect(result).toMatchObject({ sent: false, stalled: true, reason: expect.stringMatching(/2 times from Build to Design/) });
    expect(automation.moveStage).not.toHaveBeenCalled();
    expect(automation.addLabels).toHaveBeenCalledWith('janedoe/openadlc-testbed', 7, ['needs-human']);
    expect(world.events).toContainEqual(expect.objectContaining({ type: 'send_back.stalled' }));
    expect(leases.setLeaseState).not.toHaveBeenCalled();
  });

  it('stops at the limit for the issue, and leaves review rounds to maxRounds', async () => {
    const back = (from: string, to: string): Move => ({ from, to, kind: 'send_back' });
    // Designed again after going back to intake, so Design is still the stage before Build.
    const forward = (from: string, to: string): Move => ({ from, to, kind: 'forward' });
    world.moves = [
      ...designed,
      back('build', 'spec'),
      back('spec', 'intake'),
      forward('intake', 'spec'),
      forward('spec', 'build'),
      back('review', 'build'),
      back('review', 'build'),
      back('review', 'build'),
    ];
    running('task-build', { kind: 'implement', subjectRef: 'openadlc-testbed#7', botId: 'bot-builder' });

    // Five back in all, three of them review rounds: two count, and two is the limit set here.
    const { service } = sendBack({ sendBack: { maxPerEdge: 5, maxPerIssue: 2 } });
    expect(await service.request({ taskId: 'task-build', to: 'spec', reason: 'x' })).toMatchObject({ stalled: true, reason: expect.stringMatching(/2 times in all/) });

    const { service: roomier } = sendBack({ sendBack: { maxPerEdge: 5, maxPerIssue: 3 } });
    expect(await roomier.request({ taskId: 'task-build', to: 'spec', reason: 'x' })).toMatchObject({ sent: true, round: 2 });
  });
});

describe('a review sending the work back to build', () => {
  const pr = { number: 31, head: { ref: 'agent/builder/7-issue-7' } };
  const crew = [{ id: 'bot-builder', name: 'builder' }];

  it('moves the card to Build, keeps the lease, and opens the builder’s patch round', async () => {
    world.issue = { number: 7, stage: 'review', prNumber: 31, labels: ['adlc:review'] };
    const { service, automation, taskService } = sendBack();

    await service.reviewRound({ repo: REPO, repoFullName: REPO.fullName, pr, crew, client: null, by: 'lead-reviewer', reason: 'the cache is never invalidated' });

    expect(automation.moveStage).toHaveBeenCalledWith(expect.objectContaining({ to: 'build', direction: 'send_back', prNumber: 31, actor: 'lead-reviewer' }));
    expect((automation.comment.mock.calls[0] as unknown as [string, number, string])[2]).toContain('**Sent back to Build** from #31 by lead-reviewer (review round 1)');
    expect(taskService.open).toHaveBeenCalledWith(expect.objectContaining({ kind: 'patch', round: 1, leaseId: 'lease-7', branch: pr.head.ref }));
    expect(leases.setLeaseState).not.toHaveBeenCalled();
  });

  it('answers whether the round is with the builder, and why not, for a caller with a person to hand it to instead', async () => {
    // A held stacked change is handed to its builder to be brought up to date
    // (`Stacking`); one the builder could not take went nowhere, said only in the log.
    world.issue = { number: 7, stage: 'review', prNumber: 31, labels: ['adlc:review'] };
    const { service, taskService, client } = sendBack();
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await service.backToBuild({ repoName: REPO.name, prNumber: 31, reason: 'bring it up to date' })).toBeNull();

      taskService.open.mockRejectedValueOnce(new Error('builder is already working on openadlc-testbed#31; it is not started twice'));
      expect(await service.backToBuild({ repoName: REPO.name, prNumber: 31, reason: 'bring it up to date' })).toBe(
        'builder is already working on openadlc-testbed#31; it is not started twice',
      );

      world.lease = null;
      expect(await service.reviewRound({ repo: REPO, repoFullName: REPO.fullName, pr, crew, client: null, by: 'openadlc', reason: 'x' })).toBe(
        'no lease on #7 was ever linked to #31',
      );

      client.getPullRequest.mockResolvedValueOnce({ state: 'closed', headRef: pr.head.ref, headSha: 'h1' });
      expect(await service.backToBuild({ repoName: REPO.name, prNumber: 31, reason: 'x' })).toBe('#31 is closed');
    } finally {
      warned.mockRestore();
    }
  });

  it('briefs a round with the diff’s files too, and one sent back for straying with its lease’s paths alone', async () => {
    world.issue = { number: 7, stage: 'review', prNumber: 31, labels: ['adlc:review'] };
    const client = { listPullFilesAsNamed: vi.fn(async () => ['src/app.ts', 'src/billing/charge.ts']) };
    const { service, taskService } = sendBack();

    await service.reviewRound({ repo: REPO, repoFullName: REPO.fullName, pr, crew, client, by: 'lead-reviewer', reason: 'the cache is never invalidated' });
    expect(taskService.open).toHaveBeenLastCalledWith(expect.objectContaining({ declaredPaths: ['src/app.ts', 'src/billing/charge.ts'] }));

    // The stray file is in the diff, and the round that is to take it out
    // was let write it.
    await service.reviewRound({ repo: REPO, repoFullName: REPO.fullName, pr, crew, client, by: 'openadlc', reason: 'it strayed', leasePathsOnly: true });
    expect(taskService.open).toHaveBeenLastCalledWith(expect.objectContaining({ declaredPaths: ['src/app.ts'] }));
  });

  it('opens no patch round when the issue’s lease is for another pull request', async () => {
    // A stranger's fork pull request on a branch named like the builder's.
    world.issue = { number: 7, stage: 'review', prNumber: 31, labels: ['adlc:review'] };
    world.lease = { id: 'lease-7', botId: 'bot-builder', declaredPaths: ['src/app.ts'], prNumber: 31 };
    const { service, automation, taskService } = sendBack();

    await service.reviewRound({ repo: REPO, repoFullName: REPO.fullName, pr: { ...pr, number: 77 }, crew, client: null, by: 'lead-reviewer', reason: 'x' });

    expect(automation.moveStage).not.toHaveBeenCalled();
    expect(taskService.open).not.toHaveBeenCalled();

    await service.reviewRound({ repo: REPO, repoFullName: REPO.fullName, pr, crew, client: null, by: 'lead-reviewer', reason: 'the cache is never invalidated' });
    expect(taskService.open).toHaveBeenCalledWith(expect.objectContaining({ kind: 'patch', leaseId: 'lease-7' }));
  });

  it('moves nothing at the cap, and stops the loop for a person', async () => {
    world.botTasks = [1, 2, 3].map((round) => ({ id: `p${round}`, subjectRef: 'openadlc-testbed#31', kind: 'patch', state: 'done', startedAt: 'x' }));
    const { service, automation, taskService } = sendBack();

    await service.reviewRound({ repo: REPO, repoFullName: REPO.fullName, pr, crew, client: null, by: 'lead-reviewer', reason: 'still wrong' });

    expect(automation.moveStage).not.toHaveBeenCalled();
    expect(taskService.open).not.toHaveBeenCalled();
    // What hit the cap, and who asked: the card said only that the reviewers
    // still asked, and a person guessed the install was out of CI budget.
    // Not under `reason`, which says nothing could take the work.
    const stalled = world.events.filter((event) => event.type === 'review.stalled');
    expect(stalled).toEqual([expect.objectContaining({ payload: expect.objectContaining({ rounds: 3, request: 'still wrong', requestBy: 'lead-reviewer' }) })]);
    expect(stalled[0]?.payload).not.toHaveProperty('reason');
  });

  it('records the merge line as the one that asked when its send-back hits the cap', async () => {
    world.issue = { number: 7, stage: 'review', prNumber: 31, labels: ['adlc:review'] };
    world.botTasks = [1, 2, 3].map((round) => ({ id: `p${round}`, subjectRef: 'openadlc-testbed#31', kind: 'patch', state: 'done', startedAt: 'x' }));
    const { service, taskService } = sendBack();

    await service.backToBuild({ repoName: REPO.name, prNumber: 31, reason: 'The branch left the merge line: it conflicts with main' });

    expect(taskService.open).not.toHaveBeenCalled();
    expect(world.events).toContainEqual(
      expect.objectContaining({
        type: 'review.stalled',
        payload: expect.objectContaining({ request: 'The branch left the merge line: it conflicts with main', requestBy: 'openadlc' }),
      }),
    );
  });

  it('counts every round on the pull request, however many newer tasks the builder has', async () => {
    // A busy builder: its twenty newest tasks are on other subjects, and the
    // three rounds on this pull request fell out of the count.
    const elsewhere = Array.from({ length: 25 }, (_, n) => ({ id: `o${n}`, botId: 'bot-builder', subjectRef: `openadlc-testbed#${100 + n}`, kind: 'implement', state: 'done', startedAt: 'x' }));
    const rounds = [1, 2, 3].map((round) => ({ id: `p${round}`, botId: 'bot-builder', subjectRef: 'openadlc-testbed#31', kind: 'patch', state: 'done', startedAt: 'x' }));
    world.botTasks = [...elsewhere, ...rounds];
    const { service, automation, taskService } = sendBack();

    await service.reviewRound({ repo: REPO, repoFullName: REPO.fullName, pr, crew, client: null, by: 'lead-reviewer', reason: 'still wrong' });

    expect(taskService.open).not.toHaveBeenCalled();
    expect((automation.comment.mock.calls[0] as unknown as [string, number, string])[2]).toContain('3 review rounds have not converged');
  });

  it('does not count conflict resolutions as review rounds', async () => {
    world.issue = { number: 7, stage: 'review', prNumber: 31, labels: ['adlc:review'] };
    const conflict = (id: string) => ({ id, botId: 'bot-builder', subjectRef: 'openadlc-testbed#31', kind: 'patch', skill: 'resolve-conflict', state: 'done', startedAt: 'x' });
    world.botTasks = [conflict('c1'), conflict('c2'), { id: 'p1', botId: 'bot-builder', subjectRef: 'openadlc-testbed#31', kind: 'patch', state: 'done', startedAt: 'x' }];
    const { service, taskService } = sendBack();

    await service.reviewRound({ repo: REPO, repoFullName: REPO.fullName, pr, crew, client: null, by: 'lead-reviewer', reason: 'one more thing' });

    expect(world.events).not.toContainEqual(expect.objectContaining({ type: 'review.stalled' }));
    expect(taskService.open).toHaveBeenCalledWith(expect.objectContaining({ kind: 'patch', round: 2 }));
  });

  describe('when nothing holds the issue', () => {
    // Its pull request was closed and reopened, or the reconciler let the
    // lease go. The round returned with no log, no comment and no event.
    const released = { id: 'lease-7', issueNumber: 7, botId: 'bot-builder', declaredPaths: ['src/app.ts'], state: 'released', prNumber: 31 };
    const ci = { ...pr, head: { ...pr.head, sha: 'h1' } };

    beforeEach(() => {
      world.issue = { number: 7, stage: 'review', prNumber: 31, labels: ['adlc:review'] };
      world.lease = null;
    });

    it('takes the lease again for the same builder and paths, and opens the patch round', async () => {
      world.lastForPr = released;
      const { service, taskService } = sendBack();

      await service.reviewRound({ repo: REPO, repoFullName: REPO.fullName, pr: ci, crew, client: null, by: 'openadlc', reason: 'CI failed' });

      expect(leases.reacquireForPullRequest).toHaveBeenCalledWith(expect.objectContaining({ repoId: REPO.id, issueNumber: 7, prNumber: 31, actor: 'bridge' }));
      expect(taskService.open).toHaveBeenCalledWith(expect.objectContaining({ kind: 'patch', leaseId: 'lease-again', bot: 'builder' }));
      expect(world.events.filter((event) => event.type === 'review.stalled')).toEqual([]);
    });

    it('says why and records a stopped review when the lease cannot be taken again', async () => {
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      world.lastForPr = released;
      world.activeLeases = [{ id: 'lease-9', issueNumber: 9, declaredPaths: ['src/**'], botId: 'bot-builder' }];
      const { service, automation, taskService } = sendBack();

      await service.reviewRound({ repo: REPO, repoFullName: REPO.fullName, pr: ci, crew, client: null, by: 'openadlc', reason: 'CI failed' });
      await service.reviewRound({ repo: REPO, repoFullName: REPO.fullName, pr: ci, crew, client: null, by: 'openadlc', reason: 'CI failed' });

      expect(leases.reacquireForPullRequest).not.toHaveBeenCalled();
      expect(taskService.open).not.toHaveBeenCalled();
      expect(automation.comment).not.toHaveBeenCalled();
      expect(warned.mock.calls.map(([line]) => String(line))).toContainEqual(
        expect.stringMatching(/^\[bridge\] janedoe\/openadlc-testbed#31: not sent back to build: #9 now holds paths #7 declared/),
      );
      // Once for the head, as a redelivery would say it again.
      expect(world.events.filter((event) => event.type === 'review.stalled')).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ repo: REPO.name, pr: 31, issue: 7, rounds: 0, reason: '#9 now holds paths #7 declared' }) }),
      ]);
      warned.mockRestore();
    });

    it('takes nothing for an issue no longer on the board, and says so', async () => {
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      world.issue = null;
      world.lastForPr = released;
      const { service, taskService } = sendBack();

      await service.reviewRound({ repo: REPO, repoFullName: REPO.fullName, pr: ci, crew, client: null, by: 'openadlc', reason: 'CI failed' });

      expect(leases.reacquireForPullRequest).not.toHaveBeenCalled();
      expect(taskService.open).not.toHaveBeenCalled();
      expect(world.events).toContainEqual(expect.objectContaining({ type: 'review.stalled', payload: expect.objectContaining({ reason: '#7 is no longer on the board' }) }));
      warned.mockRestore();
    });

    it('says the builder is gone when its seat no longer exists, whether the lease was held or would be taken again', async () => {
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      world.lastForPr = { ...released, botId: 'bot-gone' };
      const { service, taskService } = sendBack();

      await service.reviewRound({ repo: REPO, repoFullName: REPO.fullName, pr: ci, crew, client: null, by: 'openadlc', reason: 'CI failed' });

      expect(leases.reacquireForPullRequest).not.toHaveBeenCalled();
      expect(world.events).toContainEqual(
        expect.objectContaining({ type: 'review.stalled', payload: expect.objectContaining({ rounds: 0, reason: 'the builder that held #7 is no longer in the crew' }) }),
      );

      // Held, by a seat that has since been removed.
      world.events = [];
      world.lease = { id: 'lease-7', botId: 'bot-gone', declaredPaths: ['src/app.ts'], prNumber: 31 };
      await service.reviewRound({ repo: REPO, repoFullName: REPO.fullName, pr: { ...ci, head: { ...ci.head, sha: 'h2' } }, crew, client: null, by: 'openadlc', reason: 'CI failed' });

      expect(taskService.open).not.toHaveBeenCalled();
      expect(world.events).toContainEqual(
        expect.objectContaining({ type: 'review.stalled', payload: expect.objectContaining({ reason: 'the builder that held #7 is no longer in the crew' }) }),
      );
      expect(warned).toHaveBeenCalledWith(expect.stringContaining('not sent back to build: the builder that held #7 is no longer in the crew'));
      warned.mockRestore();
    });
  });

  it('asks a person, once for each head, when the lead asks for changes on a branch no builder holds', async () => {
    // The SRE's revert of a broken testing deploy: no issue, no lease. The
    // round returned with nothing said, and the revert never landed.
    world.lease = null;
    const { service, automation, taskService } = sendBack();
    const revert = { number: 44, head: { ref: 'system/revert-1234abcd', sha: 'r1' } };
    const withLead = [...crew, { id: 'bot-lead', name: 'lead-reviewer' }];

    await service.reviewRound({ repo: REPO, repoFullName: REPO.fullName, pr: revert, crew: withLead, client: null, by: 'lead-reviewer', reason: 'x' });
    await service.reviewRound({ repo: REPO, repoFullName: REPO.fullName, pr: revert, crew: withLead, client: null, by: 'lead-reviewer', reason: 'x' });

    expect(automation.comment).toHaveBeenCalledTimes(1);
    expect((automation.comment.mock.calls[0] as unknown as [string, number, string])[2]).toContain('no builder holds `system/revert-1234abcd`');
    expect(automation.addLabels).toHaveBeenCalledTimes(1);
    expect(automation.addLabels).toHaveBeenCalledWith(REPO.fullName, 44, ['needs-human']);
    expect(world.events.filter((event) => event.type === 'review.stalled')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ repo: REPO.name, pr: 44, issue: null, bot: null }) }),
    ]);
    expect(taskService.open).not.toHaveBeenCalled();
    expect(automation.moveStage).not.toHaveBeenCalled();
  });
});

describe('a patch round on a branch that conflicts with its base', () => {
  // #257: the builder answered the findings without merging main, and the
  // lead's only blocker was "not mergeable (CONFLICTING)" on two heads.
  const pr = { number: 31, head: { ref: 'agent/builder/7-issue-7' } };
  const crew = [{ id: 'bot-builder', name: 'builder' }];
  const contextOf = (taskService: ReturnType<typeof sendBack>['taskService']) =>
    ((taskService.open.mock.calls[0] as unknown as [{ extraContext?: { name: string; content: string }[] }])[0].extraContext ?? []).map((doc) => doc.name);

  it('is told to merge the base first, whatever started it', async () => {
    world.issue = { number: 7, stage: 'review', prNumber: 31, labels: ['adlc:review'] };
    const { service, taskService, client } = sendBack();
    client.getPullRequest.mockResolvedValue({ state: 'open', headRef: pr.head.ref, baseRef: 'main', mergeable: false, mergeableState: 'dirty' } as never);

    await service.reviewRound({ repo: REPO, repoFullName: REPO.fullName, pr, crew, client: null, by: 'lead-reviewer', reason: 'the cache is never invalidated' });

    const doc = ((taskService.open.mock.calls[0] as unknown as [{ extraContext: { name: string; content: string }[] }])[0].extraContext ?? []).find(
      (entry) => entry.name === 'conflict.md',
    );
    expect(doc?.content).toContain('Your branch conflicts with `main`. Merge `main` into it first (`git merge origin/main`, not a rebase)');
  });

  it('is told nothing of the kind when the branch is mergeable, or GitHub has not said', async () => {
    for (const now of [
      { mergeable: true, mergeableState: 'clean' },
      { mergeable: null, mergeableState: 'unknown' },
    ]) {
      world.issue = { number: 7, stage: 'review', prNumber: 31, labels: ['adlc:review'] };
      const { service, taskService, client } = sendBack();
      client.getPullRequest.mockResolvedValue({ state: 'open', headRef: pr.head.ref, baseRef: 'main', ...now } as never);

      await service.reviewRound({ repo: REPO, repoFullName: REPO.fullName, pr, crew, client: null, by: 'lead-reviewer', reason: 'x' });

      expect(contextOf(taskService)).not.toContain('conflict.md');
    }
  });

  it('is told beside a person’s message, which it keeps', async () => {
    world.issue = { number: 7, stage: 'review', prNumber: 31, labels: ['adlc:review'] };
    const brief = { name: 'message.md', title: 'What jane asked of you', content: 'Accept any heading level.' };
    const { service, taskService, client } = sendBack();
    client.getPullRequest.mockResolvedValue({
      state: 'open',
      merged: false,
      headRef: pr.head.ref,
      headSha: 'abc1234',
      baseRef: 'main',
      labels: [],
      mergeable: false,
      mergeableState: 'dirty',
    } as never);

    await service.fromMessage({ repoName: REPO.name, prNumber: 31, actor: 'jane@acme.test', reason: 'x', brief, commentUrl: 'https://github.test/c/1' });

    expect(contextOf(taskService)).toEqual(['message.md', 'conflict.md']);
  });
});

describe('a person’s message to the builder on a pull request', () => {
  // core#5 on 2026-10-24: a person asked the builder to fix #7's scope check,
  // the message was a comment and nothing else, and #7 stayed red.
  const brief = { name: 'message.md', title: 'What jane asked of you', content: 'Accept any heading level.' };
  const ask = { repoName: REPO.name, prNumber: 31, actor: 'jane@acme.test', reason: 'Accept any heading level.', brief, commentUrl: 'https://github.test/c/1' };
  const open = (labels: string[] = []) => ({ state: 'open', merged: false, headRef: 'agent/builder/7-issue-7', headSha: 'abc1234', labels });

  it('takes the card in Review back to Build as the person’s move, out of the merge line, and opens a patch round briefed with it', async () => {
    world.issue = { number: 7, stage: 'review', prNumber: 31, labels: ['adlc:review'] };
    const { service, automation, mergeLine, taskService, client } = sendBack();
    client.getPullRequest.mockResolvedValue(open(['adlc:ci']) as never);

    expect(await service.fromMessage(ask)).toEqual({ started: true, round: 1 });

    expect(mergeLine.leave).toHaveBeenCalledWith('openadlc-testbed', 31);
    expect(automation.setCiLabel).toHaveBeenCalledWith('janedoe/openadlc-testbed', 31, false);
    expect(automation.moveStage).toHaveBeenCalledWith({
      repoName: 'openadlc-testbed',
      issueNumber: 7,
      to: 'build',
      actor: 'jane@acme.test',
      direction: 'person',
      reason: 'Accept any heading level.',
      prNumber: 31,
      commentUrl: 'https://github.test/c/1',
    });
    // The message itself is the comment: nothing else is said on the issue.
    expect(automation.comment).not.toHaveBeenCalled();
    expect(taskService.open).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'patch', round: 1, leaseId: 'lease-7', branch: 'agent/builder/7-issue-7', declaredPaths: ['src/app.ts'], extraContext: [brief] }),
    );
    expect(automation.moveStage.mock.invocationCallOrder[0]).toBeLessThan(taskService.open.mock.invocationCallOrder[0]!);
  });

  it('opens the round on a card already in Build without moving it, and past the round limit: a person asking is that decision', async () => {
    world.issue = { number: 7, stage: 'build', prNumber: 31, labels: ['adlc:build'] };
    world.botTasks = [1, 2, 3].map((round) => ({ id: `p${round}`, subjectRef: 'openadlc-testbed#31', kind: 'patch', state: 'done', startedAt: 'x' }));
    const { service, automation, mergeLine, taskService, client } = sendBack();
    client.getPullRequest.mockResolvedValue(open() as never);

    expect(await service.fromMessage(ask)).toEqual({ started: true, round: 4 });
    expect(automation.moveStage).not.toHaveBeenCalled();
    expect(mergeLine.leave).not.toHaveBeenCalled();
    expect(automation.comment).not.toHaveBeenCalled();
    expect(world.events).not.toContainEqual(expect.objectContaining({ type: 'review.stalled' }));
    expect(taskService.open).toHaveBeenCalledWith(expect.objectContaining({ kind: 'patch', round: 4, extraContext: [brief] }));
  });

  it('opens no second round beside one under way, and none on a pull request no builder holds, saying why', async () => {
    world.issue = { number: 7, stage: 'review', prNumber: 31, labels: ['adlc:review'] };
    world.onSubjects = [{ id: 'p1', kind: 'patch', state: 'running', subjectRef: 'openadlc-testbed#31' }];
    const { service, automation, taskService, client } = sendBack();
    client.getPullRequest.mockResolvedValue(open() as never);

    expect(await service.fromMessage(ask)).toEqual({ started: false, why: 'its patch round on #31 is already under way' });
    world.onSubjects = [];
    world.lease = null;
    expect(await service.fromMessage(ask)).toEqual({ started: false, why: 'no lease on #7 was ever linked to #31' });
    client.getPullRequest.mockResolvedValue({ ...open(), state: 'closed', merged: true } as never);
    expect(await service.fromMessage(ask)).toEqual({ started: false, why: 'pull request #31 is merged' });
    expect(automation.moveStage).not.toHaveBeenCalled();
    expect(taskService.open).not.toHaveBeenCalled();
  });
});

describe('a patch round its builder has no room for', () => {
  // 2026-11-09: CI went red after the lead approved, the dispatcher had leased
  // the builder the next issue 20 seconds after the pull request opened, the
  // round was refused as busy, and nothing started it for 21 hours.
  const pr = { number: 31, head: { ref: 'agent/builder/7-issue-7', sha: 'h1' } };
  const crew = [{ id: 'bot-builder', name: 'builder' }];
  const elsewhere = { id: 'task-280', botId: 'bot-builder', repoId: REPO.id, subjectRef: 'openadlc-testbed#280', kind: 'implement', skill: 'implement', state: 'running' };
  const waits = () => world.events.filter((event) => event.type === PATCH_ROUND_WAITING);
  const said = (automation: ReturnType<typeof sendBack>['automation']) => (automation.comment.mock.calls as unknown as [string, number, string][]).map((call) => call[2]);

  beforeEach(() => {
    world.issue = { number: 7, stage: 'review', prNumber: 31, labels: ['adlc:review'] };
    world.botTasks = [elsewhere];
  });

  it('opens nothing while the builder runs another task, says so on the send-back, and starts the round when that task ends', async () => {
    const { service, automation, taskService } = sendBack();
    taskService.wouldWait.mockResolvedValue(new BotBusyError('builder'));

    expect(await service.reviewRound({ repo: REPO, repoFullName: REPO.fullName, pr, crew, client: null, by: 'openadlc', reason: 'CI failed', check: 'ci' })).toBeNull();

    expect(taskService.open).not.toHaveBeenCalled();
    expect(automation.moveStage).toHaveBeenCalledWith(expect.objectContaining({ to: 'build', direction: 'send_back', prNumber: 31 }));
    expect(waits()).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ subjectRef: 'openadlc-testbed#31', pr: 31, issue: 7, botId: 'bot-builder', round: 1, by: 'openadlc', head: 'h1', busyWith: 'running `implement` on openadlc-testbed#280' }),
      }),
    ]);
    const [comment] = said(automation);
    expect(comment).toContain('**Sent back to Build** from #31 by openadlc (review round 1)');
    expect(comment).toContain('**This round is waiting for the builder:** _builder_ is running `implement` on openadlc-testbed#280. It starts as soon as builder has room.');
    expect(comment!.trim().split('\n').at(-1)).toMatch(/^<!-- openadlc:\{"event":"send_back"/);
    expect(service.waitingSeats()).toEqual(['bot-builder']);

    // The task on #280 ends; the card is in Build, where the move put it.
    world.botTasks = [];
    world.issue = { number: 7, stage: 'build', prNumber: 31, labels: ['adlc:build'] };
    taskService.wouldWait.mockResolvedValue(null);
    expect(await service.startWaiting(['bot-builder'])).toEqual(['openadlc-testbed#31: patch round 1 started']);

    expect(taskService.open).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'patch', skill: 'implement', subjectRef: 'openadlc-testbed#31', branch: pr.head.ref, leaseId: 'lease-7', round: 1 }),
    );
    expect(said(automation).at(-1)).toMatch(/^\*\*Review round 1 started\*\* on #31: builder has room now \(it waited since \d\d:\d\d UTC\)\.$/);
    expect(service.waitingSeats()).toEqual([]);
    expect(await service.startWaiting(['bot-builder'])).toEqual([]);
  });

  it('names no work the builder has in another repository on this pull request', async () => {
    const { service, automation, taskService } = sendBack();
    world.botTasks = [elsewhere, { id: 'task-9', botId: 'bot-builder', repoId: 'repo-private', subjectRef: 'secret-repo#9', kind: 'implement', skill: 'implement', state: 'running' }];
    taskService.wouldWait.mockResolvedValue(new BotBusyError('builder'));

    await service.reviewRound({ repo: REPO, repoFullName: REPO.fullName, pr, crew, client: null, by: 'openadlc', reason: 'CI failed', check: 'ci' });

    const [comment] = said(automation);
    expect(comment).toContain('_builder_ is running `implement` on openadlc-testbed#280 and other work besides.');
    expect(comment).not.toContain('secret-repo');
    expect(JSON.stringify(waits())).not.toContain('secret-repo');
  });

  it('starts a wait once when the seat freeing and the minute look reach it together', async () => {
    const { service, taskService } = sendBack();
    taskService.wouldWait.mockResolvedValue(new BotBusyError('builder'));
    await service.reviewRound({ repo: REPO, repoFullName: REPO.fullName, pr, crew, client: null, by: 'openadlc', reason: 'CI failed', check: 'ci' });
    world.botTasks = [];
    world.issue = { number: 7, stage: 'build', prNumber: 31, labels: ['adlc:build'] };
    taskService.wouldWait.mockResolvedValue(null);

    const [first, second] = await Promise.all([service.startWaiting(['bot-builder']), service.startWaiting(['bot-builder'])]);

    expect([...first, ...second]).toEqual(['openadlc-testbed#31: patch round 1 started']);
    expect(taskService.open).toHaveBeenCalledTimes(1);
    expect(waits()).toHaveLength(1);
    expect(service.waitingSeats()).toEqual([]);
  });

  it('waits the same when every host is full, and starts once a host has room', async () => {
    const { service, automation, taskService } = sendBack();
    taskService.wouldWait.mockResolvedValue(new HostFullError('builder'));

    await service.reviewRound({ repo: REPO, repoFullName: REPO.fullName, pr, crew, client: null, by: 'openadlc', reason: 'CI failed', check: 'ci' });

    expect(taskService.open).not.toHaveBeenCalled();
    expect(said(automation)[0]).toContain('_builder_ is waiting for a host: every host is running all the tasks it has room for.');
    world.issue = { number: 7, stage: 'build', prNumber: 31, labels: ['adlc:build'] };

    // The seat has room, a host still has none: it keeps waiting, said once.
    taskService.open.mockRejectedValueOnce(new HostFullError('builder'));
    expect(await service.startWaiting(['bot-builder'])).toEqual([
      'openadlc-testbed#31: patch round still waiting: builder is waiting for a host: every host is running all the tasks it has room for',
    ]);
    expect(waits()).toHaveLength(1);
    expect(service.waitingSeats()).toEqual(['bot-builder']);

    expect(await service.startWaiting(['bot-builder'])).toEqual(['openadlc-testbed#31: patch round 1 started']);
    expect(taskService.open).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'patch', round: 1 }));
  });

  it('waits on the lead’s request for changes too, and says nothing twice for a redelivery', async () => {
    const { service, taskService } = sendBack();
    taskService.wouldWait.mockResolvedValue(new BotBusyError('builder'));

    await service.reviewRound({ repo: REPO, repoFullName: REPO.fullName, pr, crew, client: null, by: 'lead-reviewer', reason: 'the cache is never invalidated' });
    await service.reviewRound({ repo: REPO, repoFullName: REPO.fullName, pr, crew, client: null, by: 'lead-reviewer', reason: 'the cache is never invalidated' });

    expect(taskService.open).not.toHaveBeenCalled();
    expect(waits()).toEqual([expect.objectContaining({ payload: expect.objectContaining({ by: 'lead-reviewer', round: 1 }) })]);
  });

  it('keeps a round turned away between the question and the start, and says so once', async () => {
    const { service, automation, taskService } = sendBack();
    taskService.open.mockRejectedValueOnce(new BotBusyError('builder'));

    // Null: the round is still the builder's, so `Stacking` and the merge line hand it no one else.
    expect(await service.backToBuild({ repoName: REPO.name, prNumber: 31, reason: 'CI failed' })).toBeNull();

    expect(waits()).toHaveLength(1);
    const comments = said(automation);
    expect(comments).toHaveLength(2);
    expect(comments[0]).not.toContain('waiting for the builder');
    expect(comments[1]).toBe(
      'Review round 1 on #31 has not started. **This round is waiting for the builder:** _builder_ is running `implement` on openadlc-testbed#280. It starts as soon as builder has room.',
    );
    expect(service.waitingSeats()).toEqual(['bot-builder']);
  });

  it('keeps a person’s message as the round’s brief while it waits, and moves the card to Build', async () => {
    const brief = { name: 'message.md', title: 'What jane asked of you', content: 'Accept any heading level.' };
    const { service, automation, taskService, client } = sendBack();
    client.getPullRequest.mockResolvedValue({ state: 'open', merged: false, headRef: pr.head.ref, headSha: 'h1', labels: [] } as never);
    taskService.wouldWait.mockResolvedValue(new BotBusyError('builder'));

    expect(await service.fromMessage({ repoName: REPO.name, prNumber: 31, actor: 'jane@acme.test', reason: 'Accept any heading level.', brief })).toEqual({
      started: true,
      round: 1,
      waiting: 'running `implement` on openadlc-testbed#280',
    });
    expect(automation.moveStage).toHaveBeenCalledWith(expect.objectContaining({ to: 'build', direction: 'person' }));
    expect(taskService.open).not.toHaveBeenCalled();
    expect(waits()).toEqual([expect.objectContaining({ payload: expect.objectContaining({ by: 'jane@acme.test', brief: [brief] }) })]);
  });

  describe('across a restart', () => {
    const brief = { name: 'message.md', title: 'What jane asked of you', content: 'Accept any heading level.' };
    const recorded = {
      type: PATCH_ROUND_WAITING,
      at: '2026-11-09T21:00:53.000Z',
      payload: {
        subjectRef: 'openadlc-testbed#31',
        repo: REPO.name,
        pr: 31,
        issue: 7,
        botId: 'bot-builder',
        bot: 'builder',
        round: 1,
        by: 'jane@acme.test',
        head: 'h1',
        busyWith: 'running `implement` on openadlc-testbed#280',
        brief: [brief],
      },
    };
    const now = Date.parse('2026-11-10T09:00:00.000Z');

    beforeEach(() => {
      world.issue = { number: 7, stage: 'build', prNumber: 31, labels: ['adlc:build'], repoName: REPO.name };
      world.events = [recorded];
      world.botTasks = [];
    });

    it('reads a standing wait back and starts it, with its brief, when the seat has room', async () => {
      const { service, taskService } = sendBack();
      expect(await service.loadWaits(now)).toBe(1);
      expect(service.waitingSeats()).toEqual(['bot-builder']);

      expect(await service.startWaiting(['bot-builder'])).toEqual(['openadlc-testbed#31: patch round 1 started']);
      expect(taskService.open).toHaveBeenCalledWith(expect.objectContaining({ kind: 'patch', round: 1, extraContext: [brief] }));
    });

    it('does not read back a wait a later round answered, or whose card left Build', async () => {
      world.onSubjects = [{ id: 'p1', kind: 'patch', state: 'done', subjectRef: 'openadlc-testbed#31', createdAt: '2026-11-09T22:00:00.000Z' }];
      expect(await sendBack().service.loadWaits(now)).toBe(0);

      world.onSubjects = [];
      world.issue = { number: 7, stage: 'review', prNumber: 31, labels: ['adlc:review'], repoName: REPO.name };
      expect(await sendBack().service.loadWaits(now)).toBe(0);
    });

    it('lets go of a wait whose card left Build before its seat had room', async () => {
      const { service, taskService } = sendBack();
      await service.loadWaits(now);
      world.issue = { number: 7, stage: 'review', prNumber: 31, labels: ['adlc:review'], repoName: REPO.name };

      expect(await service.startWaiting(['bot-builder'])).toEqual([
        'openadlc-testbed#31: patch round no longer waiting: a round was opened on it since, or its card left Build',
      ]);
      expect(taskService.open).not.toHaveBeenCalled();
      expect(service.waitingSeats()).toEqual([]);
    });
  });
});

describe('the bridge sending a deployed change back', () => {
  it('moves a merged change to Build with the deploy as its reason, under the same limits', async () => {
    // A red smoke on testing, or a failed production deploy: nobody's task
    // asked, so there is no task to stop and no question of one to close.
    world.issue = { number: 7, stage: 'merged', prNumber: 31, labels: ['adlc:merged'] };
    const { service, automation } = sendBack();

    const result = await service.fromBridge({ repoName: REPO.name, issueNumber: 7, from: 'merged', reason: 'The smoke failed on testing at `abc1234`.' });

    expect(result).toMatchObject({ sent: true, to: 'build' });
    expect(automation.moveStage).toHaveBeenCalledWith(expect.objectContaining({ to: 'build', direction: 'send_back', actor: 'openadlc' }));
    expect(threads.expireGatesOfTask).not.toHaveBeenCalled();
  });
});

describe('a person moving a card back', () => {
  it('says why on the issue, stops the build that was running, lets go of build, and starts the stage it went to', async () => {
    world.issue = { number: 7, stage: 'build', prNumber: 31, labels: ['adlc:build'] };
    world.onSubjects = [
      { id: 'task-build', kind: 'implement', state: 'running', subjectRef: 'openadlc-testbed#7' },
      { id: 'task-old', kind: 'spec', state: 'done', subjectRef: 'openadlc-testbed#7' },
    ];
    const { service, automation, stopTask, stages, mergeLine } = sendBack();

    const result = await service.fromPerson({ repoName: REPO.name, issueNumber: 7, to: 'spec', actor: 'janedoe@example.com', reason: 'design the schema first' });

    expect(result).toMatchObject({ sent: true, from: 'build', to: 'spec' });
    expect(automation.moveStage).toHaveBeenCalledWith(expect.objectContaining({ to: 'spec', direction: 'person', reason: 'design the schema first' }));
    expect(stopTask).toHaveBeenCalledWith('task-build', 'janedoe@example.com', 'openadlc-testbed#7 was moved back to spec');
    expect(stopTask).toHaveBeenCalledTimes(1);
    expect(leases.setLeaseState).toHaveBeenCalledWith('lease-7', 'released');
    expect(mergeLine.leave).toHaveBeenCalledWith('openadlc-testbed', 31);
    expect(stages.staff).toHaveBeenCalledWith({ repoName: 'openadlc-testbed', issueNumber: 7, stage: 'spec' });
  });

  it('takes a pull request out of the line when a person moves review back to build, and opens the builder’s patch round', async () => {
    world.issue = { number: 7, stage: 'review', prNumber: 31, labels: ['adlc:review'] };
    world.onSubjects = [{ id: 'task-review', kind: 'review', state: 'running', subjectRef: 'openadlc-testbed#31' }];
    const { service, automation, mergeLine, taskService, stopTask } = sendBack();

    const result = await service.fromPerson({ repoName: REPO.name, issueNumber: 7, to: 'build', actor: 'janedoe@example.com', reason: 'handle the empty cart' });

    expect(result).toMatchObject({ sent: true, from: 'review', to: 'build' });
    expect(mergeLine.leave).toHaveBeenCalledWith('openadlc-testbed', 31);
    expect(automation.setCiLabel).toHaveBeenCalledWith(REPO.fullName, 31, false);
    // Moved once, by the person's move; the patch round does not move it again.
    expect(automation.moveStage).toHaveBeenCalledTimes(1);
    expect(automation.moveStage).toHaveBeenCalledWith(expect.objectContaining({ to: 'build', direction: 'person', reason: 'handle the empty cart' }));
    // The reason reaches the round from the move just recorded (`sent-back.md`).
    expect(taskService.open).toHaveBeenCalledWith(
      expect.objectContaining({ bot: 'builder', kind: 'patch', subjectRef: 'openadlc-testbed#31', branch: 'agent/builder/7-issue-7', issueNumber: 7, leaseId: 'lease-7', round: 1 }),
    );
    // Not parked: the round pushes to it, and that push brings it back to review.
    expect(automation.parkPull).not.toHaveBeenCalled();
    expect(leases.setLeaseState).not.toHaveBeenCalled();
    expect(stopTask).not.toHaveBeenCalled();
  });

  it('opens no patch round past maxRounds when a person moves review back to build, and still takes it out of the line', async () => {
    world.issue = { number: 7, stage: 'review', prNumber: 31, labels: ['adlc:review'] };
    world.botTasks = [1, 2, 3].map((round) => ({ id: `p${round}`, subjectRef: 'openadlc-testbed#31', kind: 'patch', state: 'done', startedAt: 'x' }));
    const { service, mergeLine, taskService } = sendBack();

    await service.fromPerson({ repoName: REPO.name, issueNumber: 7, to: 'build', actor: 'janedoe', reason: 'not yet' });

    expect(mergeLine.leave).toHaveBeenCalledWith('openadlc-testbed', 31);
    expect(taskService.open).not.toHaveBeenCalled();
    expect(world.events).toContainEqual(expect.objectContaining({ type: 'review.stalled' }));
    // No request sent it back: the card keeps the wording it had.
    expect(world.events.find((event) => event.type === 'review.stalled')?.payload).not.toHaveProperty('request');
  });

  // Behind IAP the identity is the person's email, and a comment is public.
  it('names the person on the issue and in its marker by name, and keeps who it was on the move', async () => {
    world.issue = { number: 7, stage: 'build', prNumber: 31, labels: ['adlc:build'] };
    world.onSubjects = [];
    const { service, automation } = sendBack();

    await service.fromPerson({ repoName: REPO.name, issueNumber: 7, to: 'spec', actor: 'jane@example.com', reason: 'design the schema first' });

    const said = String((vi.mocked(automation.comment).mock.calls[0] as unknown[] | undefined)?.[2]);
    expect(said).toContain('by jane.');
    expect(said).not.toContain('@');
    expect(parseMarkers(said).find((marker) => marker.event === 'send_back')).toMatchObject({ by: 'jane' });
    expect(automation.moveStage).toHaveBeenCalledWith(expect.objectContaining({ actor: 'jane@example.com' }));
  });

  it('takes a label a person already moved on GitHub as the move, and records it as theirs', async () => {
    const { stageMoves, issues } = await import('@openadlc/db');
    world.issue = { number: 7, stage: 'review', prNumber: null, labels: ['adlc:intake'] };
    const { service, automation } = sendBack();

    await service.fromPerson({ repoName: REPO.name, issueNumber: 7, to: 'intake', actor: 'janedoe', reason: 'Moved back on GitHub by @janedoe', moved: { from: 'review' } });

    expect(automation.moveStage).not.toHaveBeenCalled();
    expect(issues.setIssueStage).toHaveBeenCalledWith('repo-1', 7, 'intake');
    expect(stageMoves.record).toHaveBeenCalledWith(expect.objectContaining({ from: 'review', to: 'intake', kind: 'person', actor: 'janedoe' }));
  });
});

/**
 * Needs you's Start the builder round, on a sent-back card a lease holds for
 * its pull request with nothing started: the dispatcher it used to ask never
 * starts an issue a lease holds (#153), and on 2026-11-09 a card sat 21 hours
 * (ADR 0046).
 */
describe('starting a held pull request’s builder round from Needs you', () => {
  const said = (automation: ReturnType<typeof sendBack>['automation']) => (automation.comment.mock.calls as unknown as [string, number, string][]).map((call) => call[2]);

  beforeEach(() => {
    world.issue = { number: 7, stage: 'build', prNumber: 31, labels: ['adlc:build'] };
    world.lease = { id: 'lease-7', botId: 'bot-builder', declaredPaths: ['src/app.ts'], prNumber: 31 };
  });

  it('opens the patch round on its branch, with the lease and the next round, and says so on the issue', async () => {
    world.botTasks = [{ id: 'p1', subjectRef: 'openadlc-testbed#31', kind: 'patch', state: 'done', startedAt: 'x' }];
    const { service, automation, taskService } = sendBack();

    expect(await service.startHeldRound({ repoName: REPO.name, issueNumber: 7 })).toEqual(['started patch round 2 on #31']);

    expect(taskService.open).toHaveBeenCalledWith(
      expect.objectContaining({ bot: 'builder', kind: 'patch', subjectRef: 'openadlc-testbed#31', branch: 'agent/builder/7-issue-7', issueNumber: 7, leaseId: 'lease-7', round: 2 }),
    );
    expect(said(automation)).toEqual(['**Review round 2 started from Needs you** on #31.']);
    // Nothing moves: the card is in Build already.
    expect(automation.moveStage).not.toHaveBeenCalled();
  });

  it('opens nothing beside a patch round already live on it', async () => {
    world.onSubjects = [{ id: 'p2', kind: 'patch', state: 'queued', subjectRef: 'openadlc-testbed#31' }];
    const { service, taskService, automation } = sendBack();

    expect(await service.startHeldRound({ repoName: REPO.name, issueNumber: 7 })).toEqual([]);
    expect(taskService.open).not.toHaveBeenCalled();
    expect(automation.comment).not.toHaveBeenCalled();
  });

  it('records the wait when the builder is busy, and says the round waits', async () => {
    world.botTasks = [{ id: 'task-280', botId: 'bot-builder', repoId: REPO.id, subjectRef: 'openadlc-testbed#280', kind: 'implement', skill: 'implement', state: 'running' }];
    const { service, taskService, automation } = sendBack();
    taskService.open.mockRejectedValueOnce(new BotBusyError('builder'));

    expect(await service.startHeldRound({ repoName: REPO.name, issueNumber: 7 })).toEqual(['patch round 1 on #31 waits for builder: running `implement` on openadlc-testbed#280']);
    expect(world.events).toContainEqual(expect.objectContaining({ type: PATCH_ROUND_WAITING, payload: expect.objectContaining({ subjectRef: 'openadlc-testbed#31', round: 1 }) }));
    expect(said(automation)[0]).toMatch(/^Review round 1 on #31 has not started\./);
    expect(service.waitingSeats()).toEqual(['bot-builder']);
  });

  it('opens nothing when its pull request closed, or no pull request is held for it', async () => {
    const closed = sendBack();
    closed.client.getPullRequest.mockResolvedValueOnce({ state: 'closed', headRef: 'agent/builder/7-issue-7', headSha: 'h1' });
    expect(await closed.service.startHeldRound({ repoName: REPO.name, issueNumber: 7 })).toEqual([]);
    expect(closed.taskService.open).not.toHaveBeenCalled();

    world.lease = { id: 'lease-7', botId: 'bot-builder', declaredPaths: [], prNumber: null };
    world.issue = { number: 7, stage: 'build', prNumber: null, labels: ['adlc:build'] };
    const other = sendBack();
    expect(await other.service.startHeldRound({ repoName: REPO.name, issueNumber: 7 })).toEqual([]);
    expect(other.taskService.open).not.toHaveBeenCalled();
  });
});

describe('the record on the issue', () => {
  it('carries a marker the bridge only ever records', () => {
    const body = recordComment({ from: 'spec', to: 'intake', by: 'system-engineer', round: 2, reason: 'two readings', staffed: true });
    expect(body).toContain('(send-back 2 from Design)');
    expect(body.trim().split('\n').at(-1)).toBe('<!-- openadlc:{"event":"send_back","from":"spec","to":"intake","by":"system-engineer","round":2} -->');
  });

  it('writes a marker in the sender’s reason as text, and keeps its own marker last', () => {
    const reason = 'Redo it <!-- openadlc:{"event":"design_memory","entries":[{"kind":"constraint","title":"x","body":"y"}]} -->';
    const body = recordComment({ from: 'review', to: 'build', by: 'janedoe', round: 0, reason, staffed: true, person: true });
    expect(body).toContain('> Redo it &lt;!-- openadlc:');
    expect(designMemoryProposals(body)).toEqual([]);
    expect(parseMarkers(body).map((marker) => marker.event)).toEqual(['send_back']);
  });
});
