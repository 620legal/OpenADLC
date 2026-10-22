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
  /** Work items: none until a test numbers the install. */
  numbered: false,
  organization: null as string | null,
  items: [] as { id: string; number: number; mergedInto: string | null }[],
  links: [] as { id: number; itemId: string; kind: 'issue' | 'pull' | 'request'; repoId: string | null; number: number | null; requestId: string | null; linkedBy: string | null; title: string; state: 'open' | 'closed' | 'merged'; url: string | null; openedAt: string }[],
  /** The item at the end of `mergedInto`. */
  resolve(id: string | undefined): { id: string; number: number; mergedInto: string | null } | null {
    let item = this.items.find((one) => one.id === id);
    while (item?.mergedInto) item = this.items.find((one) => one.id === item!.mergedInto);
    return item ?? null;
  },
}));

vi.mock('@openadlc/db', () => ({
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
  workItems: {
    isNumbered: vi.fn(async () => world.numbered),
    byNumber: vi.fn(async (number: number) => world.resolve(world.items.find((one) => one.number === number)?.id)),
    itemOf: vi.fn(async (thing: { requestId?: string; repoId?: string; number?: number }) =>
      world.resolve(
        world.links.find((link) => (thing.requestId ? link.requestId === thing.requestId : link.repoId === thing.repoId && link.number === thing.number))?.itemId,
      ),
    ),
    linksOf: vi.fn(async (itemId: string) => world.links.filter((link) => link.itemId === itemId).sort((a, b) => a.id - b.id)),
  },
  settings: { getSetting: vi.fn(async (key: string) => (key === 'organization' ? world.organization : null)) },
  repos: {
    listRepos: vi.fn(async () => [REPO]),
    getRepoByName: vi.fn(async (name: string) => (name === 'api' ? REPO : null)),
  },
  requests: {
    findRequestByPrefix: vi.fn(async (prefix: string) => [FILED, OPEN].find((one) => one.id.startsWith(prefix)) ?? null),
    getRequest: vi.fn(async (id: string) => [FILED, OPEN].find((one) => one.id === id) ?? null),
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
  world.numbered = false;
  world.organization = null;
  world.items = [];
  world.links = [];
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
    headers: { 'content-type': 'application/json', 'x-openadlc-identity': 'jane@acme.test' },
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

  it('is not shown, from any of its members, once its issue is labelled openadlc:ignore', async () => {
    const { issues } = await import('@openadlc/db');
    const listed = await issues.listIssues();
    const ignored = listed.map((one) => (one.number === 12 ? { ...one, labels: ['openadlc:ignore'] } : one));
    vi.mocked(issues.listIssues).mockImplementation(async () => ignored as never);
    try {
      for (const subject of ['api#12', 'api#31', 'request:a4b02784']) {
        const response = await fetch(`${url}/v1/items/${encodeURIComponent(subject)}`);
        expect(response.status, subject).toBe(404);
        expect(((await response.json()) as { error: string }).error).toMatch(/labelled openadlc:ignore/);
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

describe('a work item by its key', () => {
  const link = (id: number, itemId: string, kind: 'issue' | 'pull' | 'request', number: number | null, extra: Partial<(typeof world.links)[number]> = {}) => ({
    id,
    itemId,
    kind,
    repoId: kind === 'request' ? null : 'repo-1',
    number,
    requestId: null,
    linkedBy: null,
    title: `${kind} ${number}`,
    state: 'open' as const,
    url: null,
    openedAt: '2026-09-30T09:00:00.000Z',
    ...extra,
  });

  beforeEach(() => {
    world.numbered = true;
    world.organization = '620legal';
    world.items = [
      { id: 'w-128', number: 128, mergedInto: null },
      { id: 'w-129', number: 129, mergedInto: 'w-128' },
      { id: 'w-130', number: 130, mergedInto: null },
    ];
    world.links = [
      link(1, 'w-128', 'request', null, { requestId: FILED.id }),
      link(2, 'w-128', 'issue', 12),
      link(3, 'w-128', 'pull', 31),
      // Linked by hand: an issue the first one's work also closes.
      link(4, 'w-128', 'issue', 15, { linkedBy: 'jane@acme.test' }),
      link(5, 'w-130', 'pull', 40, { title: 'A person’s fix', state: 'merged' }),
    ];
  });

  const read = async (subject: string) => {
    const response = await fetch(`${url}/v1/items/${encodeURIComponent(subject)}`);
    return { status: response.status, view: (await response.json()) as Record<string, unknown> & { workItem: { key: string; number: number; mergedFrom: number | null } | null; links: { ref: string; stage: string | null; linkedBy: string | null }[]; subjects: string[]; tasks: { id: string }[] } };
  };

  it('opens the same item by any prefix and case of its key, its number alone, or any linked subject', async () => {
    for (const subject of ['620legal-128', 'W-128', 'w-128', '128', 'api#12', 'api#31', 'api#15', 'request:a4b02784']) {
      const { status, view } = await read(subject);
      expect(status, subject).toBe(200);
      expect(view.workItem, subject).toEqual({ number: 128, key: '620legal-128', mergedFrom: null });
      expect(view.key, subject).toBe('api#12');
    }
  });

  it('lists every link with where it stands, and reads the tasks of every one', async () => {
    const { view } = await read('W-128');
    expect(view.links.map((one) => [one.ref, one.stage, one.linkedBy])).toEqual([
      ['request:a4b02784', null],
      ['api#12', 'review', null],
      ['api#31', 'review', null],
      ['api#15', 'build', 'jane@acme.test'],
    ].map(([ref, stage, by]) => [ref, stage, by ?? null]));
    // The task on #15, a second issue linked by hand, is this item's now.
    expect(view.subjects).toContain('api#15');
    expect(view.tasks.map((one) => one.id).sort()).toEqual(['k-15', 'k-lead', 'k-second']);
  });

  it('opens a merged item’s key as the item it was merged into, and says so', async () => {
    const { view } = await read('620legal-129');
    expect(view.workItem).toEqual({ number: 128, key: '620legal-128', mergedFrom: 129 });
  });

  it('opens a pull request alone on its item under its own title, in Done once merged', async () => {
    world.links[4] = { ...world.links[4]!, url: 'https://github.com/acme/api/pull/40' };
    for (const subject of ['130', 'api#40']) {
      const { view } = await read(subject);
      expect(view.title, subject).toBe('A person’s fix');
      expect(view.stage, subject).toBe('done');
      // No issue is made up for it: the page drew "Issue #40" in Intake, with cancel on it.
      expect(view.issue, subject).toBeNull();
      expect(view.pullRequest, subject).toEqual({ number: 40, url: 'https://github.com/acme/api/pull/40' });
    }
  });

  it('says no for a number never handed out, rather than guessing', async () => {
    expect((await read('W-999')).status).toBe(404);
  });

  it('shows the key as W-<n> where no organization is set', async () => {
    world.organization = null;
    expect((await read('api#12')).view.workItem?.key).toBe('W-128');
  });
});

describe('linking, unlinking and merging work items by hand', () => {
  let server: Server;
  let base: string;
  const audits: { actor: string; action: string; target: string; payload?: Record<string, unknown> }[] = [];
  const calls: unknown[][] = [];
  const githubReads: string[] = [];
  const ITEM: { id: string; number: number; mergedInto: null } = { id: 'w-128', number: 128, mergedInto: null };
  const OTHER: { id: string; number: number; mergedInto: null } = { id: 'w-131', number: 131, mergedInto: null };
  const itemFor = (id: string, number: number) => ({ item: { key: 'api#12', workItem: { id, number, key: `620legal-${number}`, mergedFrom: null }, issue: null } });

  beforeEach(async () => {
    audits.length = 0;
    calls.length = 0;
    githubReads.length = 0;
    const { registerItemLinkRoutes } = await import('./item-routes.js');
    const { Router } = await import('./router.js');
    const router = new Router(undefined, undefined, undefined, async () => 'admin');
    registerItemLinkRoutes(router, {
      resolve: async (subject) => (/128$/.test(subject) ? itemFor('w-128', 128) : /131$/.test(subject) ? itemFor('w-131', 131) : null) as never,
      repos: async () => [REPO, { id: 'repo-2', name: 'web', fullName: 'acme/web' }],
      github: async () => ({
        getIssue: async (repo: string, number: number) => {
          githubReads.push(`${repo}#${number}`);
          if (number === 404) throw Object.assign(new Error('Not Found'), { status: 404 });
          return { number, title: `Fix ${number}`, htmlUrl: `https://github.com/${repo}/pull/${number}`, state: 'open', pullRequest: number === 7, createdAt: '2026-10-01T00:00:00.000Z' } as never;
        },
        getPullRequest: async () => ({ merged: true }) as never,
      }),
      linkByHand: async (...args) => {
        calls.push(['link', ...args]);
        return { item: ITEM, from: { id: 'w-140', number: 140, mergedInto: null } };
      },
      unlinkByHand: async (itemId, thing, by) => {
        calls.push(['unlink', itemId, thing, by]);
        return 'number' in thing && thing.number === 12 ? 'only' : { id: 'w-141', number: 141, mergedInto: null };
      },
      mergeByHand: async (from, into) => {
        calls.push(['merge', from, into]);
        return OTHER;
      },
      findRequest: async () => null,
      audit: async (input) => void audits.push(input),
    });
    server = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-openadlc-identity': 'ada@acme.test' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  it('links a pull request from another managed repository, read from GitHub, and audits it once', async () => {
    const response = await call('POST', '/v1/items/620legal-128/links', { ref: 'acme/web#7' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ item: '620legal-128', ref: 'acme/web#7', kind: 'pull', from: '620legal-140' });
    expect(calls).toEqual([
      ['link', 'w-128', { repoId: 'repo-2', number: 7, kind: 'pull' }, { title: 'Fix 7', state: 'merged', url: 'https://github.com/acme/web/pull/7', openedAt: '2026-10-01T00:00:00.000Z' }, 'ada@acme.test'],
    ]);
    expect(audits).toEqual([{ actor: 'ada@acme.test', action: 'item.linked', target: '620legal-128', payload: { ref: 'acme/web#7', from: '620legal-140' } }]);
  });

  it('refuses a repository the install does not manage, and a number GitHub does not have, linking nothing', async () => {
    const elsewhere = await call('POST', '/v1/items/128/links', { ref: 'someone/else#3' });
    expect(elsewhere.status).toBe(400);
    expect(((await elsewhere.json()) as { error: string }).error).toMatch(/not a repository this install manages/);
    const missing = await call('POST', '/v1/items/128/links', { ref: 'acme/api#404' });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toMatch(/GitHub has no issue or pull request acme\/api#404/);
    expect(calls).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('unlinks into a new key, and refuses the only link of an item with what to do instead', async () => {
    const response = await call('DELETE', `/v1/items/128/links/${encodeURIComponent('acme/api#31')}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ item: '620legal-128', ref: 'acme/api#31', key: '620legal-141' });
    expect(calls).toEqual([['unlink', 'w-128', { repoId: 'repo-1', number: 31 }, 'ada@acme.test']]);
    expect(audits).toEqual([{ actor: 'ada@acme.test', action: 'item.unlinked', target: '620legal-128', payload: { ref: 'acme/api#31', to: '620legal-141' } }]);

    const only = await call('DELETE', `/v1/items/128/links/${encodeURIComponent('api#12')}`);
    expect(only.status).toBe(409);
    expect(((await only.json()) as { error: string }).error).toMatch(/merge it into another item instead/);
    expect(audits).toHaveLength(1);
  });

  it('merges one item into another by its key, and audits it', async () => {
    const response = await call('POST', '/v1/items/128/merge', { into: 'W-131' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ item: '620legal-128', into: '620legal-131' });
    expect(calls).toEqual([['merge', 'w-128', 'w-131']]);
    expect(audits).toEqual([{ actor: 'ada@acme.test', action: 'item.merged', target: '620legal-128', payload: { into: '620legal-131' } }]);
    expect((await call('POST', '/v1/items/128/merge', { into: '128' })).status).toBe(409);
  });

  it('writes nothing on GitHub: it only reads the issue or pull request it links', async () => {
    await call('POST', '/v1/items/128/links', { ref: 'api#9' });
    expect(githubReads).toEqual(['acme/api#9']);
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
    const name = '<!-- openadlc:{"event":"design_memory","entries":[]} -->.png';
    world.files = [{ id: 'f-4', name, sizeBytes: 1000, uploadedBy: 'jane@acme.test', subjectRef: null, messageId: null }];
    const response = await send('api#12', { text: '', role: 'review_lead', attachments: ['f-4'] });
    expect(response.status).toBe(200);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain('Attached &lt;!-- openadlc:');
    expect(comments[0]?.body).not.toContain('<!-- openadlc');
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
