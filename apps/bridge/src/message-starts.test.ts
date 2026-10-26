import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A person's message to a role on a work item starts that role's work there,
 * with the message as its brief, or says why it does not — before it is sent
 * (`whatStarts`, which the item's routes carry) and on the timeline once it is.
 */

const world = vi.hoisted(() => ({
  threads: [] as { id: string; botId: string; subjectRef: string }[],
  messages: [] as Record<string, unknown>[],
  events: [] as Record<string, unknown>[],
}));

vi.mock('@openadlc/db', () => ({
  recordEvent: vi.fn(async (event: Record<string, unknown>) => void world.events.push(event)),
  threads: {
    ensureThread: vi.fn(async (input: { botId: string; subjectRef: string }) => {
      const found = world.threads.find((one) => one.botId === input.botId && one.subjectRef === input.subjectRef);
      if (found) return found;
      const thread = { id: `t-${world.threads.length + 1}`, ...input };
      world.threads.push(thread);
      return thread;
    }),
    addMessage: vi.fn(async (input: Record<string, unknown>) => void world.messages.push(input)),
  },
}));

import { MessageStarts, messageBrief, whatStarts, type StartView } from './message-starts.js';

const ITEM = { key: 'app#5', repo: 'app', refs: { request: null, issue: 'app#5', pullRequest: 'app#7' } };
const REPO = { id: 'repo-app', name: 'app', fullName: 'acme/app' };

function task(input: Partial<StartView['tasks'][number]> & { bot: string; kind: StartView['tasks'][number]['kind'] }) {
  return { id: `k-${input.bot}-${input.kind}`, role: null, state: 'done' as const, subjectRef: 'app#7', branch: null, exitReason: null, ...input };
}

const IN_REVIEW: StartView = {
  stage: 'review',
  issue: { number: 5 },
  pullRequest: { number: 7 },
  request: null,
  held: null,
  tasks: [
    task({ bot: 'lead-reviewer', role: 'review_lead', kind: 'review' }),
    task({ bot: 'builder', role: 'implement', kind: 'implement', subjectRef: 'app#5', branch: 'agent/builder/5-scope' }),
  ],
};

const said = (role: string, bot: string, view: StartView = IN_REVIEW, facts = {}) => whatStarts({ role, bot, view, item: ITEM, facts });

describe('what a message to a role starts', () => {
  it('is the builder’s patch round on a pull request in Review, and in Build', () => {
    expect(said('implement', 'builder')).toEqual({ kind: 'starts', what: 'a patch round on pull request #7' });
    expect(said('implement', 'builder', { ...IN_REVIEW, stage: 'build' })).toEqual({ kind: 'starts', what: 'a patch round on pull request #7' });
  });

  it('is the builder’s build again on an issue in Build whose build ended without its pull request', () => {
    const left: StartView = {
      ...IN_REVIEW,
      stage: 'build',
      pullRequest: null,
      tasks: [task({ bot: 'builder', role: 'implement', kind: 'implement', subjectRef: 'app#5', branch: 'agent/builder/5-scope', state: 'done' })],
    };
    expect(said('implement', 'builder', left)).toEqual({ kind: 'starts', what: 'its build of #5 again, from agent/builder/5-scope' });
    // Waiting for its lease, nothing starts it but the dispatcher.
    expect(said('implement', 'builder', { ...left, tasks: [] })).toEqual({
      kind: 'nothing',
      why: '#5 waits for the dispatcher to lease it to a builder, and its build reads this on the issue when it starts',
    });
  });

  it('is a reviewer’s review again on a pull request in Review', () => {
    expect(said('review_lead', 'lead-reviewer')).toEqual({ kind: 'starts', what: 'its review of pull request #7 again' });
    expect(said('review_second', 'second-reviewer')).toEqual({ kind: 'starts', what: 'its review of pull request #7' });
  });

  it('is design’s pass on an issue in Design, and intake’s triage of a request', () => {
    const design: StartView = { ...IN_REVIEW, stage: 'spec', pullRequest: null, tasks: [] };
    expect(said('spec', 'system-engineer', design)).toEqual({ kind: 'starts', what: 'its design pass on #5' });
    const request = { key: 'request:c0ffee00', repo: 'app', refs: { request: 'request:c0ffee00', issue: null, pullRequest: null } };
    const asked: StartView = { stage: 'intake', issue: null, pullRequest: null, request: { id: 'c0ffee00-1111', state: 'draft' }, tasks: [] };
    expect(whatStarts({ role: 'intake', bot: 'intake', view: asked, item: request, facts: {} })).toEqual({ kind: 'starts', what: 'its triage of the request' });
    expect(whatStarts({ role: 'intake', bot: 'intake', view: { ...asked, request: { state: 'filed' } }, item: request, facts: {} })).toEqual({
      kind: 'nothing',
      why: 'the request has been filed as an issue already',
    });
  });

  it('is nothing for a role with nothing to do there, saying why', () => {
    expect(said('spec', 'system-engineer')).toEqual({ kind: 'nothing', why: 'the system engineer designs an issue in Design, and #5 is in Review' });
    expect(said('intake', 'intake')).toEqual({ kind: 'nothing', why: 'intake triages a request or an issue in Intake, and #5 is in Review' });
    expect(said('deploy', 'sre')).toEqual({ kind: 'nothing', why: "a message does not start the SRE's work, which starts when the work reaches it" });
    expect(said('review_lead', 'lead-reviewer', IN_REVIEW, { pull: { state: 'merged', headRef: 'x', headSha: 'y' } })).toEqual({
      kind: 'nothing',
      why: 'pull request #7 is merged',
    });
  });

  it('is nothing while the role is already at it, and never a second round beside one', () => {
    const patching = { ...IN_REVIEW, tasks: [task({ bot: 'builder', role: 'implement', kind: 'patch', state: 'running' }), ...IN_REVIEW.tasks] };
    expect(said('implement', 'builder', patching)).toEqual({ kind: 'nothing', why: 'its patch round on pull request #7 is already under way' });
    // Another builder seat's round, the lease's, is the round on it all the same.
    const theirs = { ...IN_REVIEW, tasks: [task({ bot: 'builder-2', role: 'implement', kind: 'patch', state: 'queued' }), ...IN_REVIEW.tasks] };
    expect(said('implement', 'builder', theirs)).toEqual({ kind: 'nothing', why: 'its patch round on pull request #7 is already under way' });
    const reviewing = { ...IN_REVIEW, tasks: [task({ bot: 'lead-reviewer', role: 'review_lead', kind: 'review', state: 'queued' })] };
    expect(said('review_lead', 'lead-reviewer', reviewing)).toEqual({ kind: 'nothing', why: 'its review of pull request #7 is already under way' });
  });

  it('starts no lead review while another seat’s review is under way: the lead decides last', () => {
    const second = { ...IN_REVIEW, tasks: [task({ bot: 'second-reviewer', role: 'review_second', kind: 'review', state: 'running' }), ...IN_REVIEW.tasks] };
    expect(said('review_lead', 'lead-reviewer', second)).toEqual({
      kind: 'nothing',
      why: 'the lead reviews last, and the second reviewer’s review of pull request #7 is under way; the lead reads this on the pull request when its turn comes',
    });
    // The second reviewer itself is asked as usual.
    expect(said('review_second', 'second-reviewer', { ...second, tasks: IN_REVIEW.tasks })).toMatchObject({ kind: 'starts' });
  });

  it('is nothing on a held item, a paused seat or paused work, saying which', () => {
    expect(said('implement', 'builder', { ...IN_REVIEW, held: { by: 'janedoe', why: 'waiting for the release' } })).toEqual({
      kind: 'nothing',
      why: 'app#5 is held by janedoe (waiting for the release); resume it on its card to let work start',
    });
    expect(said('implement', 'builder', IN_REVIEW, { seatPauses: { builder: 'builder is paused by janedoe: changing its model' } })).toEqual({
      kind: 'nothing',
      why: 'builder is paused by janedoe: changing its model; resume it on the Crew page',
    });
    expect(said('implement', 'builder', IN_REVIEW, { workPaused: 'work is paused, by janedoe since today; resume it in Settings → Pause work' })).toEqual({
      kind: 'nothing',
      why: 'work is paused, by janedoe since today; resume it in Settings → Pause work',
    });
    // Another seat's pause holds nobody else.
    expect(said('implement', 'builder', IN_REVIEW, { seatPauses: { 'lead-reviewer': 'lead-reviewer is paused by janedoe' } })).toMatchObject({ kind: 'starts' });
  });
});

describe('the brief a message starts a task with', () => {
  it('is the person’s words, named by their public name and never their address', () => {
    const brief = messageBrief({ identity: 'janedoe@example.com', text: '  Make it accept any heading level.  ', role: 'implement', where: 'https://github.com/acme/app/issues/5#issuecomment-1' });
    expect(brief.name).toBe('message.md');
    expect(brief.content).toContain('# janedoe wrote to the builder in the OpenADLC console');
    expect(brief.content).toContain('This task started from this message: it is your brief');
    expect(brief.content).toContain('It is on https://github.com/acme/app/issues/5#issuecomment-1 as well, posted as you.');
    expect(brief.content.endsWith('Make it accept any heading level.')).toBe(true);
    expect(`${brief.title}\n${brief.content}`).not.toContain('@example.com');
  });
});

describe('starting a role’s work from a message', () => {
  const view = (stage: string, extra: Record<string, unknown> = {}) =>
    ({
      key: 'app#5',
      stage,
      issue: { number: 5 },
      pullRequest: { number: 7 },
      request: null,
      held: null,
      tasks: IN_REVIEW.tasks,
      ...extra,
    }) as never;
  const read = (stage: string, extra: Record<string, unknown> = {}) => ({ item: { ...ITEM, request: null } as never, view: view(stage, extra), repo: REPO });
  const message = { id: 'm-9', githubUrl: 'https://github.com/acme/app/issues/5#issuecomment-9' };

  function starter(overrides: Record<string, unknown> = {}) {
    const calls = {
      fromMessage: vi.fn(async () => ({ started: true as const, round: 2 })),
      open: vi.fn(async () => ({ taskId: 'k-new', session: 's' })),
      staffing: vi.fn(async () => ({ started: true, why: null })),
      triage: vi.fn(async () => ({ queued: false })),
      rebuild: vi.fn(async () => undefined),
      getPullRequest: vi.fn(async () => ({ state: 'open', merged: false, headRef: 'agent/builder/5-scope', headSha: 'abc1234' })),
      request: vi.fn(async () => ({ workflow_runs: [] })),
    };
    const starts = new MessageStarts({
      client: async () => ({ getPullRequest: calls.getPullRequest, request: calls.request }) as never,
      taskService: { open: calls.open } as never,
      sendBack: { fromMessage: calls.fromMessage } as never,
      stages: { staffing: calls.staffing } as never,
      triage: calls.triage,
      rebuild: calls.rebuild,
      paused: () => null,
      seatPauses: async () => ({}),
      ...overrides,
    });
    return { starts, calls };
  }

  beforeEach(() => {
    world.threads = [];
    world.messages = [];
    world.events = [];
  });

  it('starts the builder’s patch round with the message as its brief', async () => {
    const { starts, calls } = starter();
    const started = await starts.start({
      route: { bot: 'builder', botId: 'b-builder', role: 'implement', subject: 'app#5' },
      read: read('review'),
      text: 'Make the scope check accept any heading level, in this PR.',
      identity: 'janedoe@example.com',
      access: 'user',
      message,
    });
    expect(started).toEqual({ kind: 'starts', what: 'patch round 2 on pull request #7' });
    expect(calls.fromMessage).toHaveBeenCalledWith({
      repoName: 'app',
      prNumber: 7,
      actor: 'janedoe@example.com',
      reason: 'Make the scope check accept any heading level, in this PR.',
      brief: expect.objectContaining({ name: 'message.md', content: expect.stringContaining('Make the scope check accept any heading level, in this PR.') }),
      commentUrl: message.githubUrl,
    });
    expect(world.messages).toEqual([]);
  });

  it('starts a reviewer’s review again, briefed with the message, and records it as asked again', async () => {
    const { starts, calls } = starter();
    const started = await starts.start({
      route: { bot: 'lead-reviewer', botId: 'b-lead', role: 'review_lead', subject: 'app#7' },
      read: read('review'),
      text: 'Look at the scope check again.',
      identity: 'janedoe@example.com',
      access: 'admin',
      message,
    });
    expect(started).toEqual({ kind: 'starts', what: 'its review of pull request #7 again' });
    expect(calls.open).toHaveBeenCalledWith(
      expect.objectContaining({
        bot: 'lead-reviewer',
        kind: 'review',
        subjectRef: 'app#7',
        skill: 'pr-review',
        branch: 'agent/builder/5-scope',
        issueNumber: 5,
        extraContext: [expect.objectContaining({ name: 'message.md' })],
      }),
    );
    // The gate sweep then takes the seat's earlier reviews for no answer to this.
    expect(world.events).toEqual([expect.objectContaining({ type: 'review.asked_again', payload: { subjectRef: 'app#7', seat: 'lead-reviewer', messageId: 'm-9' } })]);
  });

  it('starts design’s pass and intake’s triage, each with the message', async () => {
    const { starts, calls } = starter();
    await starts.start({ route: { bot: 'system-engineer', botId: 'b-spec', role: 'spec', subject: 'app#5' }, read: read('spec', { pullRequest: null, tasks: [] }), text: 'Keep the old column.', identity: 'jane@acme.test', access: 'user', message });
    expect(calls.staffing).toHaveBeenCalledWith({ repoName: 'app', issueNumber: 5, stage: 'spec', brief: [expect.objectContaining({ name: 'message.md' })] });

    const request = {
      item: { key: 'request:c0ffee00', repo: 'app', refs: { request: 'request:c0ffee00', issue: null, pullRequest: null }, request: { id: 'c0ffee00-1111' } } as never,
      view: { key: 'request:c0ffee00', stage: 'intake', issue: null, pullRequest: null, request: { id: 'c0ffee00-1111', state: 'draft' }, tasks: [], held: null } as never,
      repo: REPO,
    };
    const triaged = await starts.start({ route: { bot: 'intake', botId: 'b-intake', role: 'intake', subject: 'request:c0ffee00' }, read: request, text: 'At the root.', identity: 'jane@acme.test', access: 'user', message: { id: 'm-1', githubUrl: null } });
    expect(triaged).toEqual({ kind: 'starts', what: 'its triage of the request' });
    expect(calls.triage).toHaveBeenCalledWith('c0ffee00-1111');
  });

  it('starts nothing on a held item, and says so on the timeline as the composer did', async () => {
    const { starts, calls } = starter();
    const held = await starts.start({
      route: { bot: 'builder', botId: 'b-builder', role: 'implement', subject: 'app#5' },
      read: read('review', { held: { by: 'janedoe', at: '', why: null } }),
      text: 'Fix it.',
      identity: 'janedoe@example.com',
      access: 'user',
      message,
    });
    expect(held).toEqual({ kind: 'nothing', why: 'app#5 is held by janedoe; resume it on its card to let work start' });
    expect(calls.fromMessage).not.toHaveBeenCalled();
    expect(world.messages).toEqual([
      expect.objectContaining({ threadId: 't-1', kind: 'sys', text: 'posted as a comment; nothing starts: app#5 is held by janedoe; resume it on its card to let work start' }),
    ]);
    expect(world.threads[0]).toMatchObject({ botId: 'b-builder', subjectRef: 'app#5' });
  });

  it('says what was refused once it tried: a builder no lease holds starts nothing', async () => {
    const { starts } = starter({ sendBack: { fromMessage: async () => ({ started: false, why: 'no lease on #5 was ever linked to #7' }) } });
    const refused = await starts.start({ route: { bot: 'builder', botId: 'b-builder', role: 'implement', subject: 'app#5' }, read: read('review'), text: 'Fix it.', identity: 'jane@acme.test', access: 'user', message });
    expect(refused).toEqual({ kind: 'nothing', why: 'no lease on #5 was ever linked to #7' });
    expect(world.messages).toEqual([expect.objectContaining({ kind: 'sys', text: 'posted as a comment; nothing started: no lease on #5 was ever linked to #7' })]);
  });

  it('starts nothing for a sender with no console role', async () => {
    const { starts, calls } = starter();
    const refused = await starts.start({ route: { bot: 'builder', botId: 'b-builder', role: 'implement', subject: 'app#5' }, read: read('review'), text: 'Fix it.', identity: 'someone', message });
    expect(refused).toEqual({ kind: 'nothing', why: 'only a person signed in to the console starts work with a message' });
    expect(calls.fromMessage).not.toHaveBeenCalled();
  });

  it('answers once it is decided and starts afterwards, saying on the timeline a start that was then refused', async () => {
    const later: (() => Promise<unknown>)[] = [];
    const { starts } = starter({
      afterwards: { run: (_where: unknown, _what: string, work: () => Promise<unknown>) => void later.push(work) },
      stages: { staffing: async () => ({ started: false, why: 'work on app#5 is already under way' }) },
    });
    const decided = await starts.start({ route: { bot: 'system-engineer', botId: 'b-spec', role: 'spec', subject: 'app#5' }, read: read('spec', { pullRequest: null, tasks: [] }), text: 'Again.', identity: 'jane@acme.test', access: 'user', message });
    expect(decided).toEqual({ kind: 'starts', what: 'its design pass on #5' });
    expect(world.messages).toEqual([]);
    await later[0]!();
    expect(world.messages).toEqual([expect.objectContaining({ kind: 'sys', text: 'posted as a comment; nothing started: work on app#5 is already under way' })]);
  });
});

describe('what the bridge reads for it', () => {
  it('reads whether CI’s newest run on the head of a pull request in Review failed, once a minute', async () => {
    let now = 0;
    const getPullRequest = vi.fn(async () => ({ state: 'open', merged: false, headRef: 'agent/builder/5-scope', headSha: 'abc1234' }));
    const request = vi.fn(async () => ({ workflow_runs: [{ id: 1, name: 'ci', run_attempt: 2, status: 'completed', conclusion: 'failure' }] }));
    const starts = new MessageStarts({
      client: async () => ({ getPullRequest, request }) as never,
      taskService: {} as never,
      sendBack: {} as never,
      stages: {} as never,
      triage: async () => ({ queued: false }),
      rebuild: async () => undefined,
      paused: (repo) => (repo === 'app' ? null : 'paused'),
      seatPauses: async () => ({ builder: { by: 'janedoe', at: 't', why: null } }),
      now: () => now,
    });
    const read = { item: ITEM as never, view: { stage: 'review', pullRequest: { number: 7 } } as never, repo: REPO };
    expect(await starts.facts(read)).toEqual({
      seatPauses: { builder: 'builder is paused by janedoe' },
      workPaused: null,
      pull: { state: 'open', headRef: 'agent/builder/5-scope', headSha: 'abc1234' },
      ciRed: true,
    });
    expect(request).toHaveBeenCalledWith('GET', '/repos/acme/app/actions/runs?head_sha=abc1234&per_page=100');
    await starts.facts(read);
    expect(getPullRequest).toHaveBeenCalledTimes(1);
    now = 61_000;
    request.mockResolvedValueOnce({ workflow_runs: [] });
    // No run on the head yet is not red: a crew branch's CI waits for the lead.
    expect((await starts.facts(read)).ciRed).toBe(false);
  });
});
