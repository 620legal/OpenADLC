import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A work item read, and written to, over HTTP: any member's subject opens the
 * same item, and a message written on it answers the question the person
 * picked, the only one open, or goes to the seat working on it — never to a
 * question on another item.
 */

const CREW = [
  { id: 'b-intake', name: 'intake', slot: 'intake', displayName: 'intake', role: 'intake', githubLogin: 'acme-crew' },
  { id: 'b-builder', name: 'builder', slot: 'builder', displayName: 'builder', role: 'implement', githubLogin: 'acme-crew' },
  { id: 'b-lead', name: 'lead-reviewer', slot: 'lead-reviewer', displayName: 'lead reviewer', role: 'review_lead', githubLogin: 'acme-reviewer' },
  { id: 'b-second', name: 'second-reviewer', slot: 'second-reviewer', displayName: 'second reviewer', role: 'review_second', githubLogin: 'acme-reviewer' },
];
const REPO = { id: 'repo-1', name: 'api', fullName: 'acme/api' };
const FILED = { id: 'a4b02784-3ae8-450b-abe9-0c93eb4d67dc', text: 'Record which model reviewed', context: null, repoId: 'repo-1', issueNumber: 12, state: 'filed', requestedBy: 'jane@acme.test', createdAt: '2026-09-30T09:00:00.000Z' };
const OPEN = { id: 'c0ffee00-1111-4222-8333-944445555666', text: 'A page that says hello', context: null, repoId: 'repo-1', issueNumber: null, state: 'questions', requestedBy: 'jane@acme.test', createdAt: '2026-09-30T09:30:00.000Z' };

const world = vi.hoisted(() => ({
  threads: [] as { id: string; bot_id: string; repo_id: string | null; subject_ref: string; role: string; seat: string }[],
  messages: [] as Record<string, unknown>[],
  gates: [] as Record<string, unknown>[],
  tasks: [] as Record<string, unknown>[],
  /** Uploads: `subjectRef` null until sent with something. */
  files: [] as { id: string; name: string; sizeBytes: number; uploadedBy: string; subjectRef: string | null; messageId: string | null }[],
}));

vi.mock('@fleetadlc/db', () => ({
  attachments: {
    listForSubjects: vi.fn(async (refs: readonly string[]) => world.files.filter((one) => one.subjectRef && refs.includes(one.subjectRef))),
    claimable: vi.fn(async (ids: readonly string[], by: string) => world.files.filter((one) => ids.includes(one.id) && one.subjectRef === null && one.uploadedBy === by)),
    claim: vi.fn(async (ids: readonly string[], input: { uploadedBy: string; subjectRef: string; messageId?: string | null }) => {
      const mine = world.files.filter((one) => ids.includes(one.id) && one.subjectRef === null && one.uploadedBy === input.uploadedBy);
      for (const one of mine) Object.assign(one, { subjectRef: input.subjectRef, messageId: input.messageId ?? null });
      return mine;
    }),
  },
  bots: { listBots: vi.fn(async () => CREW) },
  repos: {
    listRepos: vi.fn(async () => [REPO]),
    getRepoByName: vi.fn(async (name: string) => (name === 'api' ? REPO : null)),
  },
  requests: {
    findRequestByPrefix: vi.fn(async (prefix: string) => [FILED, OPEN].find((one) => one.id.startsWith(prefix)) ?? null),
    listRequestsForIssue: vi.fn(async (repoId: string, number: number) => [FILED, OPEN].filter((one) => one.repoId === repoId && one.issueNumber === number)),
  },
  issues: {
    listIssues: vi.fn(async () => [
      { id: 'i-12', repoId: 'repo-1', repoName: 'api', number: 12, title: 'Record the model per review', stage: 'review', url: 'https://github.com/acme/api/issues/12', prNumber: 31, labels: [] },
      { id: 'i-15', repoId: 'repo-1', repoName: 'api', number: 15, title: 'Another piece of work', stage: 'build', url: null, prNumber: null, labels: [] },
    ]),
  },
  tasks: {
    listTasksOnSubjects: vi.fn(async (refs: readonly string[]) => world.tasks.filter((task) => refs.includes(String(task.subjectRef)))),
    getTask: vi.fn(async (id: string) => world.tasks.find((task) => task.id === id) ?? null),
  },
  threads: {
    listThreadsForSubjects: vi.fn(async (refs: readonly string[]) => world.threads.filter((thread) => refs.includes(thread.subject_ref))),
    listMessages: vi.fn(async (ids: readonly string[]) => world.messages.filter((message) => ids.includes(String(message.threadId)))),
    listOpenGates: vi.fn(async () => world.gates),
    subjectsWatermark: vi.fn(async () => '1:1::'),
    ensureThread: vi.fn(async (input: { botId: string; repoId: string | null; subjectRef: string }) => {
      const found = world.threads.find((thread) => thread.bot_id === input.botId && thread.subject_ref === input.subjectRef);
      if (found) return found;
      const bot = CREW.find((one) => one.id === input.botId)!;
      const thread = { id: `t-${world.threads.length + 1}`, bot_id: input.botId, repo_id: input.repoId, subject_ref: input.subjectRef, role: bot.role, seat: bot.slot };
      world.threads.push(thread);
      return thread;
    }),
    addMessage: vi.fn(async (input: Record<string, unknown>) => {
      const message = { id: `m-${world.messages.length + 1}`, at: '2026-09-30T11:00:00.000Z', note: null, payload: null, ...input };
      world.messages.push(message);
      return message;
    }),
  },
}));

function gate(id: string, threadId: string, taskId: string) {
  return { id, taskId, threadId, question: 'Which?', options: [], state: 'open', answer: null, answeredBy: null, answeredAt: null, githubCommentUrl: null, addressedTo: null };
}

function task(id: string, botId: string, subjectRef: string, state: string) {
  return { id, botId, kind: 'review', subjectRef, state, round: 1, startedAt: null, endedAt: null, exitReason: null, tmuxSession: `${botId}-s`, branch: null, costUsd: 0, createdAt: '2026-09-30T10:00:00.000Z' };
}

let bridge: Server;
let url: string;
const answered: Record<string, unknown>[] = [];
const resumed: string[] = [];
const comments: { repo: string; number: number; body: string; as: string }[] = [];

beforeEach(async () => {
  world.threads = [
    { id: 't-intake', bot_id: 'b-intake', repo_id: 'repo-1', subject_ref: 'request:a4b02784', role: 'intake', seat: 'intake' },
    { id: 't-lead', bot_id: 'b-lead', repo_id: 'repo-1', subject_ref: 'api#31', role: 'review_lead', seat: 'lead-reviewer' },
    { id: 't-second', bot_id: 'b-second', repo_id: 'repo-1', subject_ref: 'api#31', role: 'review_second', seat: 'second-reviewer' },
    { id: 't-15', bot_id: 'b-builder', repo_id: 'repo-1', subject_ref: 'api#15', role: 'implement', seat: 'builder' },
    { id: 't-open', bot_id: 'b-intake', repo_id: 'repo-1', subject_ref: 'request:c0ffee00', role: 'intake', seat: 'intake' },
  ];
  world.messages = [
    { id: 'm-1', threadId: 't-intake', kind: 'bot', author: 'intake', text: 'Filed as #12.', note: null, payload: null, githubUrl: null, at: '2026-09-30T09:10:00.000Z' },
    { id: 'm-2', threadId: 't-lead', kind: 'bot', author: 'lead-reviewer', text: 'Store it per round.', note: null, payload: null, githubUrl: null, at: '2026-09-30T10:10:00.000Z' },
    { id: 'm-3', threadId: 't-15', kind: 'bot', author: 'builder', text: 'Another item.', note: null, payload: null, githubUrl: null, at: '2026-09-30T10:20:00.000Z' },
  ];
  world.tasks = [task('k-lead', 'b-lead', 'api#31', 'done'), task('k-second', 'b-second', 'api#31', 'paused'), task('k-15', 'b-builder', 'api#15', 'paused')];
  world.gates = [];
  world.files = [];
  answered.length = 0;
  resumed.length = 0;
  comments.length = 0;

  const { registerItemRoutes } = await import('./item-routes.js');
  const { Router } = await import('./router.js');
  // Every person here is a user: the role is what lets a continue at a cost
  // cap past a spent monthly cap (`Gates.answer`), so the gate is told it.
  const router = new Router(undefined, undefined, undefined, async () => 'user');
  registerItemRoutes(router, {
    actors: {
      asBot: async (name: string) => ({
        comment: async (repo: string, number: number, body: string) => {
          comments.push({ repo, number, body, as: name });
          return { id: 1, body, htmlUrl: `https://github.com/${repo}/issues/${number}#issuecomment-1`, user: name };
        },
      }),
    } as never,
    gates: {
      answer: async (input: Record<string, unknown>) => {
        answered.push(input);
        const found = world.gates.find((one) => one.id === input.gateId);
        return { answer: String(input.reply), taskId: found?.taskId ?? null };
      },
    } as never,
    taskService: { resume: async (taskId: string) => void resumed.push(taskId) } as never,
    threadStream: { subscribe: () => () => undefined, watching: 0 } as never,
  });
  bridge = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => bridge.close(() => resolve()));
});

function send(subject: string, body: Record<string, unknown>) {
  return fetch(`${url}/v1/items/${encodeURIComponent(subject)}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fleetadlc-identity': 'jane@acme.test' },
    body: JSON.stringify(body),
  });
}

describe('reading a work item', () => {
  it('is the same item from the request, the issue or the pull request, and holds only its own conversation', async () => {
    for (const subject of ['request:a4b02784', 'api#12', 'api#31']) {
      const view = (await (await fetch(`${url}/v1/items/${encodeURIComponent(subject)}`)).json()) as {
        key: string;
        timeline: { id: string; role: string }[];
        roles: { role: string }[];
        tasks: { id: string; tmuxSession: string }[];
      };
      expect(view.key).toBe('api#12');
      expect(view.timeline.map((entry) => [entry.id, entry.role])).toEqual([
        ['m-1', 'intake'],
        ['m-2', 'review_lead'],
      ]);
      expect(view.roles.map((role) => role.role)).toEqual(['intake', 'review_lead', 'review_second']);
      expect(view.tasks.map((one) => one.id).sort()).toEqual(['k-lead', 'k-second']);
    }
  });

  it('says where a message would go from each tab, as the send routes it', async () => {
    // The lead reviewer spoke last; the builder's patch is running on the issue.
    world.tasks.push(task('k-patch', 'b-builder', 'api#12', 'running'));
    const view = (await (await fetch(`${url}/v1/items/${encodeURIComponent('api#12')}`)).json()) as { routes: Record<string, unknown> };
    expect(view.routes['']).toEqual({ kind: 'post', bot: 'lead-reviewer', role: 'review_lead', handle: 'acme-reviewer', subject: 'api#31', on: 'pull_request', number: 31 });
    expect(Object.keys(view.routes)).toEqual(['', 'intake', 'implement', 'review_lead', 'review_second']);

    // And that is where it goes.
    const response = await send('api#12', { text: 'Keep it per round.' });
    expect(await response.json()).toMatchObject({ answered: false, bot: 'lead-reviewer', subject: 'api#31' });
    expect(comments).toEqual([expect.objectContaining({ repo: 'acme/api', number: 31, as: 'lead-reviewer' })]);
  });

  it('is not shown, from any of its members, once its issue is labelled fleetadlc:ignore', async () => {
    const { issues } = await import('@fleetadlc/db');
    const listed = await issues.listIssues();
    const ignored = listed.map((one) => (one.number === 12 ? { ...one, labels: ['fleetadlc:ignore'] } : one));
    vi.mocked(issues.listIssues).mockImplementation(async () => ignored as never);
    try {
      for (const subject of ['api#12', 'api#31', 'request:a4b02784']) {
        const response = await fetch(`${url}/v1/items/${encodeURIComponent(subject)}`);
        expect(response.status, subject).toBe(404);
        expect(((await response.json()) as { error: string }).error).toMatch(/labelled fleetadlc:ignore/);
      }
    } finally {
      vi.mocked(issues.listIssues).mockImplementation(async () => listed as never);
    }
    // The label off, it is back.
    expect((await fetch(`${url}/v1/items/${encodeURIComponent('api#12')}`)).status).toBe(200);
  });

  it('says what to do for a subject that is no item', async () => {
    const response = await fetch(`${url}/v1/items/${encodeURIComponent('request:deadbeef')}`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toMatch(/not a work item this install knows/);
  });
});

describe('a message written on a work item', () => {
  it('answers the one question open on it, and resumes the task that asked', async () => {
    world.gates = [gate('g-second', 't-second', 'k-second')];
    const response = await send('api#12', { text: 'per round' });
    expect(await response.json()).toMatchObject({ answered: true, answer: 'per round', gateId: 'g-second', item: 'api#12' });
    expect(answered).toEqual([{ gateId: 'g-second', reply: 'per round', answeredBy: 'jane@acme.test', role: 'user', via: 'item' }]);
    expect(resumed).toEqual(['k-second']);
  });

  it('refuses to guess between two open questions, and answers the one picked', async () => {
    world.gates = [gate('g-lead', 't-lead', 'k-lead'), gate('g-second', 't-second', 'k-second')];
    const refused = await send('api#12', { text: 'yes' });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(/pick the question you're answering/);
    expect(answered).toEqual([]);

    await send('api#12', { text: 'yes', gateId: 'g-lead' });
    expect(answered).toEqual([{ gateId: 'g-lead', reply: 'yes', answeredBy: 'jane@acme.test', role: 'user', via: 'item' }]);
  });

  it('never answers a question on another item, even named by id', async () => {
    world.gates = [gate('g-15', 't-15', 'k-15')];
    const response = await send('api#12', { text: 'yes', gateId: 'g-15' });
    expect(response.status).toBe(409);
    expect(answered).toEqual([]);
    expect(resumed).toEqual([]);
  });

  it('goes to the role’s seat that last spoke, posted on the pull request a reviewer works on', async () => {
    const response = await send('api#12', { text: 'Agreed.', role: 'review_lead' });
    expect(await response.json()).toMatchObject({ answered: false, bot: 'lead-reviewer', subject: 'api#31', item: 'api#12' });
    expect(comments).toEqual([expect.objectContaining({ repo: 'acme/api', number: 31, as: 'lead-reviewer' })]);
  });

  it('goes to the seat whose task is on the item when that role has not spoken', async () => {
    const response = await send('api#12', { text: 'Check the edge case.', role: 'review_second' });
    expect(await response.json()).toMatchObject({ bot: 'second-reviewer', subject: 'api#31' });
  });

  it('goes into the request’s own thread before the issue exists, and posts nothing on GitHub', async () => {
    const response = await send('request:c0ffee00', { text: 'Put it at the root.' });
    expect(await response.json()).toMatchObject({ answered: false, bot: 'intake', subject: 'request:c0ffee00' });
    expect(comments).toEqual([]);
    expect(world.messages.at(-1)).toMatchObject({ threadId: 't-open', kind: 'you', text: 'Put it at the root.' });
  });
});

describe('files sent with a message on a work item', () => {
  it('go onto the subject the message went to, with the message they came with', async () => {
    world.files = [{ id: 'f-1', name: 'mockup.png', sizeBytes: 1000, uploadedBy: 'jane@acme.test', subjectRef: null, messageId: null }];
    const response = await send('request:c0ffee00', { text: 'Like this.', attachments: ['f-1'] });
    expect(response.status).toBe(200);
    const message = world.messages.at(-1)!;
    expect(world.files[0]).toMatchObject({ subjectRef: 'request:c0ffee00', messageId: message.id });
  });

  it('are named on GitHub with no live marker, the message having no text of its own', async () => {
    const name = '<!-- fleetadlc:{"event":"design_memory","entries":[]} -->.png';
    world.files = [{ id: 'f-4', name, sizeBytes: 1000, uploadedBy: 'jane@acme.test', subjectRef: null, messageId: null }];
    const response = await send('api#12', { text: '', role: 'review_lead', attachments: ['f-4'] });
    expect(response.status).toBe(200);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain('Attached &lt;!-- fleetadlc:');
    expect(comments[0]?.body).not.toContain('<!-- fleetadlc');
  });

  it('refuse the whole message when one is not the sender’s to send, and send nothing', async () => {
    world.files = [{ id: 'f-2', name: 'theirs.png', sizeBytes: 1000, uploadedBy: 'someone@else.test', subjectRef: null, messageId: null }];
    const before = world.messages.length;
    const response = await send('request:c0ffee00', { text: 'Like this.', attachments: ['f-2'] });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/could not be found.*Attach it again/);
    expect(world.messages).toHaveLength(before);
    expect(world.files[0]?.subjectRef).toBeNull();
  });

  it('refuse what would take the item past its limit', async () => {
    world.files = [
      ...Array.from({ length: 20 }, (_, index) => ({ id: `on-${index}`, name: 'x.png', sizeBytes: 10, uploadedBy: 'jane@acme.test', subjectRef: 'api#12', messageId: null })),
      { id: 'f-3', name: 'one-more.png', sizeBytes: 10, uploadedBy: 'jane@acme.test', subjectRef: null, messageId: null },
    ];
    const response = await send('api#31', { text: 'And this.', role: 'review_lead', attachments: ['f-3'] });
    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: string }).error).toMatch(/20 files/);
  });
});
