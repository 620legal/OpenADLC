import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Settling a builder's plan changes in one step (#77): a standing approval
 * for the rest of the work, or the designer's judgement within its limits,
 * and a person's refusal after the fact, which takes the paths back.
 */

const store = vi.hoisted(() => ({
  gate: null as Record<string, unknown> | null,
  planChange: null as Record<string, unknown> | null,
  standing: null as Record<string, unknown> | null,
  task: {} as Record<string, unknown>,
  tasks: {} as Record<string, Record<string, unknown>>,
  lease: null as Record<string, unknown> | null,
  issue: null as Record<string, unknown> | null,
  messages: [] as Record<string, unknown>[],
  notes: [] as [string, string, Record<string, unknown>][],
  /** What the designer said in its own thread, as the store lists it. */
  designerSaid: [] as Record<string, unknown>[],
  /** The work item the issue is linked to; null before the install is numbered. */
  workItem: null as { id: string; number: number } | null,
}));

vi.mock('@openadlc/db', () => ({
  audit: vi.fn(async () => undefined),
  bots: {
    getBotById: vi.fn(async (id: string) =>
      id === 'bot-builder' ? { id, name: 'builder', role: 'implement' } : id === 'bot-architect' ? { id, name: 'architect', role: 'spec' } : null,
    ),
    listBots: vi.fn(async () => [
      { id: 'bot-builder', name: 'builder', role: 'implement', engine: 'claude' },
      { id: 'bot-architect', name: 'architect', role: 'spec', engine: 'claude' },
    ]),
  },
  issues: {
    getIssue: vi.fn(async () => store.issue),
  },
  leases: {
    getLease: vi.fn(async () => store.lease),
    latestLease: vi.fn(async () => store.lease),
    setLeaseState: vi.fn(async () => null),
    narrowPaths: vi.fn(async (_id: string, paths: string[]) => (store.lease ? { ...store.lease, declaredPaths: (store.lease.declaredPaths as string[]).filter((one) => !paths.includes(one)) } : null)),
    planChangeOfGate: vi.fn(async () => store.planChange),
    planChangeOfDesignerTask: vi.fn(async (taskId: string) =>
      (store.planChange?.designer as { taskId?: string } | undefined)?.taskId === taskId ? { gateId: 'gate-1', request: store.planChange } : null,
    ),
    notePlanChange: vi.fn(async (gateId: string, note: string, value: Record<string, unknown>) => {
      store.notes.push([gateId, note, value]);
      store.planChange = { ...store.planChange, [note]: value };
    }),
  },
  repos: {
    listRepos: vi.fn(async () => [{ id: 'repo-1', name: 'openadlc', fullName: 'acme/openadlc', defaultBranch: 'main' }]),
  },
  settings: {
    getSetting: vi.fn(async () => null),
  },
  standingApprovals: {
    activeFor: vi.fn(async () => store.standing),
    turnOn: vi.fn(async (input: Record<string, unknown>) => {
      store.standing ??= { id: 'standing-1', setAt: '2026-10-22T10:00:00.000Z', endedAt: null, ...input };
      return store.standing;
    }),
    turnOff: vi.fn(async (input: Record<string, unknown>) => {
      if (!store.standing) return null;
      const ended = { ...store.standing, endedAt: '2026-10-23T00:00:00.000Z', endedBy: input.by, endedWhy: input.why };
      store.standing = null;
      return ended;
    }),
  },
  tasks: {
    getTask: vi.fn(async (id: string) => (id === 'task-1' ? { ...store.task } : (store.tasks[id] ?? null))),
  },
  workItems: {
    itemOf: vi.fn(async () => store.workItem),
  },
  threads: {
    getGate: vi.fn(async () => store.gate),
    addMessage: vi.fn(async (input: Record<string, unknown>) => {
      store.messages.push(input);
      return input;
    }),
    listThreadsForSubject: vi.fn(async () => [
      { id: 'thread-builder', bot_id: 'bot-builder', subject_ref: 'openadlc#77' },
      { id: 'thread-architect', bot_id: 'bot-architect', subject_ref: 'openadlc#77' },
    ]),
    listMessages: vi.fn(async (ids: string[]) => (ids.includes('thread-architect') ? store.designerSaid : [])),
  },
}));

import { audit, leases, settings, standingApprovals } from '@openadlc/db';
import { newSigningKey, signBody } from '@openadlc/shared';
import type { HumanReviewRead } from './human-review-read.js';
import { endStandingApproval, NO_VERDICT, PlanChanges, standingCoverFor } from './plan-changes.js';

const RULES = [{ path: 'apps/bridge/src/gates.ts', logins: ['orzelig'] }, { path: 'config/', logins: ['orzelig'] }];
const KEY = newSigningKey();

const client = {
  comment: vi.fn(async () => ({ htmlUrl: 'https://github.com/acme/openadlc/issues/77#issuecomment-1' })),
  addLabels: vi.fn(async () => undefined),
  getIssue: vi.fn(async () => ({ number: 77, body: store.issue?.body ?? '', labels: [], state: 'open' })),
  updateIssueBody: vi.fn(async () => undefined),
  listComments: vi.fn(async () => [] as { user: string; body: string; at: string; association: string | null }[]),
};

const gates = { answer: vi.fn(async () => ({ answer: 'Approve', taskId: 'task-1' })) };
const taskService = {
  open: vi.fn(async () => ({ taskId: 'task-9', session: 'architect-1' })),
  resume: vi.fn(async () => undefined),
};
const stopTask = vi.fn(async () => ({ stopped: true }));
const humanReviewRules = vi.fn(async (): Promise<HumanReviewRead> => ({ rules: RULES, unread: null }));
/** Rules that could not be read, for no reason the bridge could tell. */
const UNREAD: HumanReviewRead = { rules: null, unread: null };

const answerAsPerson = vi.fn(async () => ({ answer: 'Approve', taskId: 'task-1' }));
const planChanges = new PlanChanges({
  gates: gates as never,
  answerAsPerson,
  taskService: taskService as never,
  actors: { asBot: vi.fn(async () => client as never) } as never,
  humanReviewRules,
  keyring: async () => [KEY],
  stopTask,
});

const DESIGN = [
  'The design.',
  '',
  '1. Read the field in `apps/hostd/src/skill-runner.ts` and pass it on.',
  '2. Show it in apps/console/src/lib/attention-card.ts.',
  '<!-- openadlc:{"event":"plan_posted"} -->',
].join('\n');

function designComment(task = 'task-spec', seat = 'architect'): { user: string; body: string; at: string; association: string | null } {
  return { user: 'openadlc-crew', body: signBody(DESIGN, { seat, task, repo: 'acme/openadlc', kind: 'comment', n: 77 }, KEY), at: '2026-10-21T10:00:00Z', association: 'MEMBER' };
}

function openPlanChange(paths = ['apps/hostd/src/skill-runner.ts']): void {
  store.gate = { id: 'gate-1', taskId: 'task-1', threadId: 'thread-1', state: 'open', options: ['Approve', 'Refuse'], answer: null };
  store.planChange = { paths, reason: 'the runner drops the field', held: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  store.messages = [];
  store.notes = [];
  store.designerSaid = [];
  store.standing = null;
  store.workItem = null;
  store.task = { id: 'task-1', botId: 'bot-builder', repoId: 'repo-1', kind: 'implement', subjectRef: 'openadlc#77', leaseId: 'lease-1', branch: 'agent/builder/77-x', state: 'paused' };
  store.tasks = {
    'task-spec': { id: 'task-spec', botId: 'bot-architect', kind: 'spec', skill: 'spec', subjectRef: 'openadlc#77' },
    'task-9': { id: 'task-9', botId: 'bot-architect', kind: 'spec', skill: 'plan-change-review', subjectRef: 'openadlc#77', state: 'running' },
  };
  store.lease = { id: 'lease-1', repoId: 'repo-1', issueNumber: 77, botId: 'bot-builder', declaredPaths: ['apps/hostd/src/skill-runner.ts', 'apps/console/src/'], state: 'in_task' };
  store.issue = { number: 77, labels: [], declaredPaths: ['apps/console/src/'], body: '## Expected paths\n\n- apps/console/src/\n- apps/hostd/src/skill-runner.ts\n', vouched: null };
  client.listComments.mockResolvedValue([designComment()]);
  humanReviewRules.mockResolvedValue({ rules: RULES, unread: null });
  openPlanChange();
});

describe('approve all for this work', () => {
  it('turns a standing approval on for the issue, approves this request, and resumes the builder', async () => {
    const done = await planChanges.approveAll({ gateId: 'gate-1', identity: 'orzelig', role: 'user' });

    expect(standingApprovals.turnOn).toHaveBeenCalledWith({ repoId: 'repo-1', issueNumber: 77, setBy: 'orzelig', gateId: 'gate-1' });
    // The person's own answer, which goes on with the builder once recorded (`answerFromConsole`).
    expect(answerAsPerson).toHaveBeenCalledWith({ gateId: 'gate-1', reply: 'Approve', answeredBy: 'orzelig', role: 'user', via: 'console-gate' });
    expect(done.standing).toMatchObject({ setBy: 'orzelig', issueNumber: 77 });
    expect(String((client.comment.mock.calls[0] as unknown[])[2])).toContain('**orzelig turned on approve all** for #77');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ actor: 'orzelig', action: 'plan_change.standing_on', target: 'openadlc#77' }));
  });

  it('is not left on when the approval it came with did not go through', async () => {
    answerAsPerson.mockRejectedValueOnce(new Error('gate is no longer open'));
    await expect(planChanges.approveAll({ gateId: 'gate-1', identity: 'orzelig', role: 'user' })).rejects.toThrow(/no longer open/);
    expect(standingApprovals.turnOff).toHaveBeenCalledWith(expect.objectContaining({ repoId: 'repo-1', issueNumber: 77 }));
    expect(store.standing).toBeNull();
  });

  it('covers a later request with no path under Human review, and never one with such a path', async () => {
    store.standing = { id: 'standing-1', repoId: 'repo-1', issueNumber: 77, setBy: 'orzelig', setAt: '2026-10-22T10:00:00.000Z' };
    const cover = standingCoverFor({ humanReviewRules });

    await expect(cover({ repoId: 'repo-1', repoFullName: 'acme/openadlc', issueNumber: 77, paths: ['apps/hostd/src/task-runner.ts'] })).resolves.toEqual({
      covers: true,
      setBy: 'orzelig',
      setAt: '2026-10-22T10:00:00.000Z',
      humanReview: [],
    });
    expect(humanReviewRules).toHaveBeenCalledWith('acme/openadlc', 'main');
    await expect(cover({ repoId: 'repo-1', repoFullName: 'acme/openadlc', issueNumber: 77, paths: ['apps/hostd/src/x.ts', 'config/review.yaml'] })).resolves.toMatchObject({
      covers: false,
      humanReview: ['config/review.yaml'],
    });
    // Rules that cannot be read cover nothing: a person is asked.
    humanReviewRules.mockResolvedValueOnce(UNREAD);
    await expect(cover({ repoId: 'repo-1', repoFullName: 'acme/openadlc', issueNumber: 77, paths: ['apps/hostd/src/x.ts'] })).resolves.toMatchObject({ covers: false });

    store.standing = null;
    await expect(cover({ repoId: 'repo-1', repoFullName: 'acme/openadlc', issueNumber: 77, paths: ['apps/hostd/src/x.ts'] })).resolves.toBeNull();
  });

  it('says the rules could not be read, and what to do, when they cannot be: never that a path is under Human review', async () => {
    // On 2026-10-22 the card said `apps/probe60-more/util.ts` was under Human
    // review, in a repository whose AGENTS.md had no such section.
    store.standing = { id: 'standing-1', repoId: 'repo-1', issueNumber: 77, setBy: 'orzelig', setAt: '2026-10-22T10:00:00.000Z' };
    humanReviewRules.mockResolvedValueOnce(UNREAD);

    const cover = await standingCoverFor({ humanReviewRules })({ repoId: 'repo-1', repoFullName: 'acme/openadlc', issueNumber: 77, paths: ['apps/probe60-more/util.ts'] });

    expect(cover).toMatchObject({ covers: false, humanReview: [] });
    expect(cover?.rulesUnread).toBe(
      'OpenADLC could not read the Human-review rules in AGENTS.md on `main`, so it does not cover this one and a person decides. ' +
        'Add a `## Human review` section to AGENTS.md on `main`, or fix the line of it OpenADLC cannot read; until then a person approves every path',
    );
    // A read that throws is the same: unknown holds.
    humanReviewRules.mockRejectedValueOnce(new Error('GitHub is down'));
    await expect(standingCoverFor({ humanReviewRules })({ repoId: 'repo-1', repoFullName: 'acme/openadlc', issueNumber: 77, paths: ['a/b/c.ts'] })).resolves.toMatchObject({
      covers: false,
      humanReview: [],
      rulesUnread: expect.stringContaining('could not read the Human-review rules'),
    });
  });

  it('turns off when its pull request merges, saying why', async () => {
    store.standing = { id: 'standing-1', repoId: 'repo-1', issueNumber: 77, setBy: 'orzelig', setAt: '2026-10-22T10:00:00.000Z' };
    await endStandingApproval({ repoId: 'repo-1', issueNumber: 77, why: '#80 merged' });
    expect(standingApprovals.turnOff).toHaveBeenCalledWith({ repoId: 'repo-1', issueNumber: 77, by: 'openadlc', why: '#80 merged' });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plan_change.standing_off', payload: expect.objectContaining({ why: '#80 merged' }) }));
    // A later request is a person's again.
    await expect(standingCoverFor({ humanReviewRules })({ repoId: 'repo-1', repoFullName: 'acme/openadlc', issueNumber: 77, paths: ['a/b/c.ts'] })).resolves.toBeNull();
    // Nothing on: nothing to say, and nothing thrown.
    await endStandingApproval({ repoId: 'repo-1', issueNumber: 77, why: 'again' });
    expect(vi.mocked(audit).mock.calls.filter(([entry]) => entry.action === 'plan_change.standing_off')).toHaveLength(1);
  });

  it('is turned off by a person, from the card or the item', async () => {
    store.standing = { id: 'standing-1', repoId: 'repo-1', issueNumber: 77, setBy: 'orzelig', setAt: '2026-10-22T10:00:00.000Z' };
    await expect(planChanges.turnOff({ repoName: 'openadlc', issueNumber: 77, identity: 'janedoe' })).resolves.toMatchObject({ endedBy: 'janedoe' });
    expect(String((client.comment.mock.calls.at(-1) as unknown[])[2])).toContain('**janedoe turned off approve all** for #77');
    await expect(planChanges.turnOff({ repoName: 'openadlc', issueNumber: 77, identity: 'janedoe' })).rejects.toThrow(/is not on/);
  });
});

describe('asking the designer', () => {
  it('starts a short task on the design seat with the paths, the reason and what only a person may approve', async () => {
    openPlanChange(['apps/hostd/src/skill-runner.ts', 'config/review.yaml']);

    await expect(planChanges.askDesigner({ gateId: 'gate-1', identity: 'orzelig' })).resolves.toEqual({ taskId: 'task-9', designer: 'architect' });

    const [opened] = taskService.open.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(opened).toMatchObject({
      bot: 'architect',
      botId: 'bot-architect',
      repo: 'openadlc',
      kind: 'spec',
      subjectType: 'issue',
      subjectRef: 'openadlc#77',
      skill: 'plan-change-review',
      issueNumber: 77,
    });
    const brief = (opened.extraContext as { name: string; content: string }[])[0]!;
    expect(brief.name).toBe('plan-change.md');
    expect(brief.content).toContain('`apps/hostd/src/skill-runner.ts`');
    expect(brief.content).toContain('the runner drops the field');
    expect(brief.content).toContain('`config/review.yaml` is under Human review');
    expect(store.notes).toContainEqual(['gate-1', 'designer', expect.objectContaining({ taskId: 'task-9', askedBy: 'orzelig' })]);
    expect(store.messages.at(-1)).toMatchObject({ threadId: 'thread-1', kind: 'sys', text: expect.stringContaining('orzelig asked architect, the designer') });
  });

  it('tells the designer the rules could not be read, not that the paths are under Human review, when they cannot be', async () => {
    humanReviewRules.mockResolvedValueOnce(UNREAD);
    await planChanges.askDesigner({ gateId: 'gate-1', identity: 'orzelig' });

    const brief = ((taskService.open.mock.calls[0] as unknown as [Record<string, unknown>])[0].extraContext as { content: string }[])[0]!;
    expect(brief.content).toContain('OpenADLC could not read the Human-review rules in AGENTS.md on `main`, so only a person approves these paths');
    expect(brief.content).not.toContain('under Human review in AGENTS.md');
  });

  it('is not asked twice while it is judging, nor of a gate already answered', async () => {
    await planChanges.askDesigner({ gateId: 'gate-1', identity: 'orzelig' });
    await expect(planChanges.askDesigner({ gateId: 'gate-1', identity: 'orzelig' })).rejects.toThrow(/already judging/);
    store.gate = { ...store.gate, state: 'answered' };
    await expect(planChanges.askDesigner({ gateId: 'gate-1', identity: 'orzelig' })).rejects.toThrow(/no longer open/);
  });

  const verdict = (verdictWord: string, reason = 'The design writes the runner.') =>
    `I read the design.\n<!-- openadlc:{"event":"plan_change_verdict","verdict":"${verdictWord}","reason":"${reason}"} -->`;

  it('settles it when the designer approves paths the design names or sits beside, and the builder goes on', async () => {
    openPlanChange(['apps/hostd/src/skill-runner.ts', 'apps/hostd/src/skill-runner.test.ts', 'docs/architecture.md']);
    await planChanges.askDesigner({ gateId: 'gate-1', identity: 'orzelig' });

    const said = await planChanges.verdict(store.tasks['task-9'] as never, verdict('approve'));

    expect(said).toEqual({ counted: true });
    expect(gates.answer).toHaveBeenCalledWith({
      gateId: 'gate-1',
      reply: 'Approve',
      answeredBy: 'architect',
      via: 'designer',
      decided: { by: 'designer', seat: 'architect', taskId: 'task-9', askedBy: 'orzelig', reason: 'The design writes the runner.' },
    });
    expect(taskService.resume).toHaveBeenCalledWith('task-1');
    expect(store.notes.at(-1)).toEqual(['gate-1', 'designer', expect.objectContaining({ verdict: 'approve', counted: true, outside: [] })]);
  });

  it('is advice when a path is outside what the design names, and the question stays for a person with its view', async () => {
    openPlanChange(['apps/hostd/src/skill-runner.ts', 'packages/engines/src/claude.ts']);
    await planChanges.askDesigner({ gateId: 'gate-1', identity: 'orzelig' });

    await expect(planChanges.verdict(store.tasks['task-9'] as never, verdict('approve'))).resolves.toEqual({ counted: false });

    expect(gates.answer).not.toHaveBeenCalled();
    expect(store.notes.at(-1)).toEqual([
      'gate-1',
      'designer',
      expect.objectContaining({ verdict: 'approve', counted: false, outside: [{ path: 'packages/engines/src/claude.ts', why: 'the design neither names it nor anything beside it' }] }),
    ]);
    const comment = String((client.comment.mock.calls.at(-1) as unknown[])[2]);
    expect(comment).toContain('**The designer (architect) would approve** this');
    expect(comment).toContain('`packages/engines/src/claude.ts`: the design neither names it nor anything beside it');
    expect(store.messages.at(-1)).toMatchObject({ threadId: 'thread-1', kind: 'sys' });
  });

  it('never settles a path under Human review, even one the design names', async () => {
    openPlanChange(['apps/bridge/src/gates.ts']);
    client.listComments.mockResolvedValue([{ ...designComment(), body: signBody(`${DESIGN}\nAnd \`apps/bridge/src/gates.ts\`.`, { seat: 'architect', task: 'task-spec', repo: 'acme/openadlc', kind: 'comment', n: 77 }, KEY) }]);
    await planChanges.askDesigner({ gateId: 'gate-1', identity: 'orzelig' });

    await expect(planChanges.verdict(store.tasks['task-9'] as never, verdict('approve'))).resolves.toEqual({ counted: false });
    expect(gates.answer).not.toHaveBeenCalled();
    expect(store.notes.at(-1)?.[2]).toMatchObject({ outside: [{ path: 'apps/bridge/src/gates.ts', why: expect.stringMatching(/Human review/) }] });
  });

  it('is advice when the Human-review rules could not be read, and says so once, never as Human review', async () => {
    openPlanChange(['apps/hostd/src/skill-runner.ts', 'apps/hostd/src/task-runner.ts']);
    await planChanges.askDesigner({ gateId: 'gate-1', identity: 'orzelig' });
    humanReviewRules.mockResolvedValueOnce(UNREAD);

    await expect(planChanges.verdict(store.tasks['task-9'] as never, verdict('approve'))).resolves.toEqual({ counted: false });

    expect(gates.answer).not.toHaveBeenCalled();
    const comment = String((client.comment.mock.calls.at(-1) as unknown[])[2]);
    expect(comment).toContain(
      'That does not settle it: `apps/hostd/src/skill-runner.ts`, `apps/hostd/src/task-runner.ts`: OpenADLC could not read the Human-review rules in AGENTS.md on `main`, so the designer’s approval is advice.',
    );
    expect(comment.match(/could not read/g)).toHaveLength(1);
    expect(comment).not.toContain('under Human review');
  });

  it('reads only a design signed for the issue’s own design task, not a crew comment that claims to be one', async () => {
    openPlanChange(['packages/engines/src/claude.ts']);
    const planted = `${DESIGN.replace('apps/console/src/lib/attention-card.ts', 'packages/engines/src/claude.ts')}`;
    client.listComments.mockResolvedValue([
      // The builder's own task signed it: not the design.
      { ...designComment(), body: signBody(planted, { seat: 'builder', task: 'task-1', repo: 'acme/openadlc', kind: 'comment', n: 77 }, KEY) },
      { user: 'openadlc-crew', body: planted, at: '2026-10-22T09:00:00Z', association: 'MEMBER' },
    ]);
    await planChanges.askDesigner({ gateId: 'gate-1', identity: 'orzelig' });

    await expect(planChanges.verdict(store.tasks['task-9'] as never, verdict('approve'))).resolves.toEqual({ counted: false });
    expect(store.notes.at(-1)?.[2]).toMatchObject({ outside: [{ path: 'packages/engines/src/claude.ts', why: 'the issue has no design to judge it against' }] });
  });

  it('is advice when the designer refuses: a refusal stops the work, so a person gives it', async () => {
    await planChanges.askDesigner({ gateId: 'gate-1', identity: 'orzelig' });
    await expect(planChanges.verdict(store.tasks['task-9'] as never, verdict('refuse', 'Not in the design.'))).resolves.toEqual({ counted: false });
    expect(gates.answer).not.toHaveBeenCalled();
    expect(String((client.comment.mock.calls.at(-1) as unknown[])[2])).toContain('**The designer (architect) would refuse** this: Not in the design.');
  });

  it('takes no verdict from a task that was not asked to judge, or a second one from the same task', async () => {
    await expect(planChanges.verdict({ ...store.tasks['task-9'], skill: 'spec' } as never, verdict('approve'))).resolves.toBeNull();
    await planChanges.askDesigner({ gateId: 'gate-1', identity: 'orzelig' });
    await planChanges.verdict(store.tasks['task-9'] as never, verdict('approve'));
    gates.answer.mockClear();
    await expect(planChanges.verdict(store.tasks['task-9'] as never, verdict('approve'))).resolves.toBeNull();
    expect(gates.answer).not.toHaveBeenCalled();
  });
});

/**
 * A designer's task that ended with no verdict read "done", and only Needs
 * you said it had no answer; the builder's thread, where the question waits,
 * said nothing. A review that leaves no review is failed, and so is this.
 */
describe('a designer that ends without its verdict', () => {
  const asked = async () => {
    await planChanges.askDesigner({ gateId: 'gate-1', identity: 'orzelig' });
    store.tasks['task-9'] = { ...store.tasks['task-9'], startedAt: '2026-10-22T10:00:00.000Z' };
    return store.tasks['task-9'] as never;
  };
  const said = (text: string, extra: Record<string, unknown> = {}) => ({ author: 'architect', kind: 'bot', text, at: '2026-10-22T10:02:00.000Z', payload: null, ...extra });

  it('failed, with what it last said', async () => {
    const task = await asked();
    store.designerSaid = [said('I could not find the design comment on #77.')];
    await expect(planChanges.missingVerdict(task)).resolves.toBe(`${NO_VERDICT}. It said: “I could not find the design comment on #77.”`);
    store.designerSaid = [];
    await expect(planChanges.missingVerdict(task)).resolves.toBe(NO_VERDICT);
  });

  it('did not fail when it gave one, noted or only said, nor when it was not asked to judge one', async () => {
    const task = await asked();
    // Said, though not acted on yet: the note comes once the verdict is.
    store.designerSaid = [said('<!-- openadlc:{"event":"plan_change_verdict","verdict":"refuse","reason":"no"} -->', { kind: 'sys', payload: { event: 'plan_change_verdict', taskId: 'task-9' } })];
    await expect(planChanges.missingVerdict(task)).resolves.toBeNull();

    store.designerSaid = [];
    store.planChange = { ...store.planChange, designer: { ...(store.planChange?.designer as object), verdict: 'approve' } };
    await expect(planChanges.missingVerdict(task)).resolves.toBeNull();

    await expect(planChanges.missingVerdict({ ...store.tasks['task-spec'], startedAt: null } as never)).resolves.toBeNull();
    // A task asked before the person asked again is not the one the card waits on.
    await expect(planChanges.missingVerdict({ ...store.tasks['task-9'], id: 'task-old' } as never)).resolves.toBeNull();
  });

  it('is said in the builder’s thread, and the designer can be asked again', async () => {
    const task = await asked();
    store.tasks['task-9'] = { ...store.tasks['task-9'], state: 'failed' };

    await planChanges.designerEnded(task, NO_VERDICT);

    expect(store.messages.at(-1)).toMatchObject({
      threadId: 'thread-1',
      kind: 'sys',
      text: 'architect, the designer, ended without an answer, so nothing is settled. Ask the designer again from the card, or answer it yourself',
      note: NO_VERDICT,
    });
    taskService.open.mockResolvedValueOnce({ taskId: 'task-10', session: 'architect-2' });
    await expect(planChanges.askDesigner({ gateId: 'gate-1', identity: 'orzelig' })).resolves.toEqual({ taskId: 'task-10', designer: 'architect' });
  });

  it('is not said once the question has been answered, or for a designer that gave its verdict', async () => {
    const task = await asked();
    store.gate = { ...store.gate, state: 'answered' };
    await planChanges.designerEnded(task, NO_VERDICT);
    store.gate = { ...store.gate, state: 'open' };
    store.planChange = { ...store.planChange, designer: { ...(store.planChange?.designer as object), verdict: 'refuse' } };
    await planChanges.designerEnded(task, NO_VERDICT);
    expect(store.messages.filter((message) => String(message.text).includes('ended without an answer'))).toEqual([]);
  });
});

describe('a person refusing after the fact', () => {
  const approvedByTheDesigner = () => {
    store.gate = { ...store.gate, state: 'answered', answer: 'Approve', answeredBy: 'architect' };
    store.planChange = { ...store.planChange, decided: { by: 'designer', seat: 'architect', at: '2026-10-22T10:05:00.000Z' } };
    store.lease = { ...store.lease, declaredPaths: ['apps/console/src/', 'apps/hostd/src/skill-runner.ts'] };
  };

  it('takes the paths back out of the lease and the issue, stops the task, and leaves needs-human on', async () => {
    approvedByTheDesigner();

    const done = await planChanges.takeBack({ gateId: 'gate-1', identity: 'orzelig' });

    expect(done).toMatchObject({ paths: ['apps/hostd/src/skill-runner.ts'] });
    expect(stopTask).toHaveBeenCalledWith('task-1', 'orzelig', expect.stringContaining('refused after the fact'));
    expect(leases.narrowPaths).toHaveBeenCalledWith('lease-1', ['apps/hostd/src/skill-runner.ts']);
    expect(leases.setLeaseState).toHaveBeenCalledWith('lease-1', 'released');
    expect(client.updateIssueBody).toHaveBeenCalledWith('acme/openadlc', 77, '## Expected paths\n\n- apps/console/src/\n');
    expect(client.addLabels).toHaveBeenCalledWith('acme/openadlc', 77, ['needs-human']);
    expect(String((client.comment.mock.calls.at(-1) as unknown[])[2])).toContain('**orzelig refused** the plan change the designer approved');
    expect(store.notes).toContainEqual(['gate-1', 'takenBack', expect.objectContaining({ by: 'orzelig' })]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'orzelig', action: 'plan_change.refused_after', payload: expect.objectContaining({ paths: ['apps/hostd/src/skill-runner.ts'], decidedBy: 'designer' }) }),
    );
  });

  it('is only for an approval no person gave, and only once', async () => {
    store.gate = { ...store.gate, state: 'answered', answer: 'Approve', answeredBy: 'orzelig' };
    await expect(planChanges.takeBack({ gateId: 'gate-1', identity: 'orzelig' })).rejects.toThrow(/a person approved/);
    approvedByTheDesigner();
    await planChanges.takeBack({ gateId: 'gate-1', identity: 'orzelig' });
    await expect(planChanges.takeBack({ gateId: 'gate-1', identity: 'orzelig' })).rejects.toThrow(/already refused/);
  });
});

describe('what the audit log files a plan change under', () => {
  const entries = () =>
    vi
      .mocked(audit)
      .mock.calls.map(([entry]) => ({ action: entry.action, target: entry.target, subjects: (entry.payload as { subjects?: string[] } | undefined)?.subjects }));

  it('files approve all on and off, asking the designer and a refusal after the fact under the item’s key, with the issue in subjects', async () => {
    // Turned off from W-14, and still filed under its issue, scripted#60, while
    // pause, next and cancel on W-14 were filed under W-14 (#106).
    store.workItem = { id: 'w-14', number: 14 };

    await planChanges.approveAll({ gateId: 'gate-1', identity: 'orzelig', role: 'user' });
    await planChanges.turnOff({ repoName: 'openadlc', issueNumber: 77, identity: 'janedoe' });
    await planChanges.askDesigner({ gateId: 'gate-1', identity: 'orzelig' });
    store.gate = { ...store.gate, state: 'answered', answer: 'Approve', answeredBy: 'architect' };
    store.planChange = { ...store.planChange, decided: { by: 'designer', seat: 'architect', at: '2026-10-22T10:05:00.000Z' } };
    await planChanges.takeBack({ gateId: 'gate-1', identity: 'orzelig' });
    store.standing = { id: 'standing-2', repoId: 'repo-1', issueNumber: 77, setBy: 'orzelig', setAt: '2026-10-22T10:00:00.000Z' };
    await endStandingApproval({ repoId: 'repo-1', issueNumber: 77, why: '#80 merged', subject: 'openadlc#77' });

    expect(entries()).toEqual([
      { action: 'plan_change.standing_on', target: 'W-14', subjects: ['openadlc#77'] },
      { action: 'plan_change.standing_off', target: 'W-14', subjects: ['openadlc#77'] },
      { action: 'plan_change.designer_asked', target: 'W-14', subjects: ['openadlc#77'] },
      { action: 'plan_change.refused_after', target: 'W-14', subjects: ['openadlc#77'] },
      { action: 'plan_change.standing_off', target: 'W-14', subjects: ['openadlc#77'] },
    ]);
  });

  it('files them under the issue before the install is numbered, and under the install’s own prefix once it is', async () => {
    await planChanges.approveAll({ gateId: 'gate-1', identity: 'orzelig', role: 'user' });
    expect(entries()).toEqual([{ action: 'plan_change.standing_on', target: 'openadlc#77', subjects: ['openadlc#77'] }]);

    vi.mocked(audit).mockClear();
    store.workItem = { id: 'w-14', number: 14 };
    vi.mocked(settings.getSetting).mockResolvedValueOnce('acme');
    await planChanges.turnOff({ repoName: 'openadlc', issueNumber: 77, identity: 'orzelig' });
    expect(entries()).toEqual([{ action: 'plan_change.standing_off', target: 'acme-14', subjects: ['openadlc#77'] }]);
  });
});

describe('why the Human-review rules could not be read', () => {
  it('is said on the card and to the designer when the read knows it, pointing at no card that is not there', async () => {
    // No GitHub account could read AGENTS.md on a scratch install, and the
    // card said to add a section and that the repository's card in Needs you
    // named the line: neither was true, and there was no such card.
    store.standing = { id: 'standing-1', repoId: 'repo-1', issueNumber: 77, setBy: 'orzelig', setAt: '2026-10-22T10:00:00.000Z' };
    humanReviewRules.mockResolvedValueOnce({ rules: null, unread: { cause: 'no-account', account: 'openadlc-flow' } });
    const cover = await standingCoverFor({ humanReviewRules })({ repoId: 'repo-1', repoFullName: 'acme/openadlc', issueNumber: 77, paths: ['apps/x.ts'] });

    expect(cover).toMatchObject({ covers: false, humanReview: [] });
    expect(cover?.rulesUnread).toBe(
      'OpenADLC could not read AGENTS.md on `main` for its Human-review rules: openadlc-flow, the account it reads GitHub with, is not connected, ' +
        'so it does not cover this one and a person decides. Until it is, a person approves every path. Run: openadlc auth login --bot openadlc-flow',
    );
    expect(cover?.rulesUnread).not.toMatch(/Needs you|## Human review/);

    humanReviewRules.mockResolvedValueOnce({ rules: null, unread: { cause: 'no-section' } });
    await planChanges.askDesigner({ gateId: 'gate-1', identity: 'orzelig' });
    const brief = ((taskService.open.mock.calls[0] as unknown as [Record<string, unknown>])[0].extraContext as { content: string }[])[0]!;
    expect(brief.content).toContain('AGENTS.md on `main` has no `## Human review` section to read the rules from, so only a person approves these paths');
  });
});
