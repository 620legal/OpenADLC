import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A console request moves with its triage, and ends linked to the issue triage
 * filed. `requests.updateRequest` had no caller: a request stayed a draft
 * whatever happened to it, and nothing tied it to its issue.
 */

const REQUEST_ID = 'a4b02784-3ae8-450b-abe9-0c93eb4d67dc';

const store = vi.hoisted(() => ({
  request: {
    id: 'a4b02784-3ae8-450b-abe9-0c93eb4d67dc',
    text: 'Create html hello world and a readme file.',
    context: null,
    repoId: 'repo-1' as string | null,
    kind: 'feature',
    requestedBy: 'janedoe',
    issueNumber: null as number | null,
    state: 'draft' as string,
    createdAt: '2026-09-24T20:44:22.945Z',
  },
  task: {
    id: 'task-1',
    botId: 'bot-intake',
    repoId: 'repo-1',
    kind: 'intake',
    subjectType: 'request',
    subjectRef: 'request:a4b02784',
    leaseId: null,
    state: 'running',
    skill: 'triage',
  } as Record<string, unknown>,
  gate: null as Record<string, unknown> | null,
  messages: [] as Record<string, unknown>[],
}));

vi.mock('@fleetadlc/db', () => ({
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

  audit: vi.fn(async () => undefined),
  bots: {
    getBotById: vi.fn(async (id: string) =>
      id === 'bot-intake' ? { id, name: 'ottoexampleco', displayName: 'Intake', role: 'intake' } : null,
    ),
    getBotByName: vi.fn(async () => null),
    listBots: vi.fn(async () => [
      { id: 'bot-flow', name: 'janedoe-fleetadlc-flow', slot: 'automation', role: 'automation' },
      { id: 'bot-intake', name: 'ottoexampleco', slot: 'intake', role: 'intake' },
    ]),
  },
  costs: {},
  credentials: {},
  issues: {},
  leases: { pauseIndefinitely: vi.fn(async () => undefined) },
  listAudit: vi.fn(),
  mergeLines: {},
  recordEvent: vi.fn(async () => 'event-1'),
  repos: {
    listRepos: vi.fn(async () => [
      { id: 'repo-1', name: 'fleetadlc-testbed', fullName: 'janedoe/fleetadlc-testbed' },
      { id: 'repo-2', name: 'FleetADLC', fullName: 'janedoe/FleetADLC' },
    ]),
  },
  requests: {
    getRequest: vi.fn(async (id: string) => (id === store.request.id ? { ...store.request } : null)),
    findRequestByPrefix: vi.fn(async (prefix: string) =>
      store.request.id.startsWith(prefix) ? { ...store.request } : null,
    ),
    updateRequest: vi.fn(async (id: string, patch: { state?: string; issueNumber?: number | null; repoId?: string | null }) => {
      if (id !== store.request.id) return null;
      if (patch.state) store.request.state = patch.state;
      if (patch.repoId && !store.request.repoId) store.request.repoId = patch.repoId;
      if (patch.issueNumber !== undefined && patch.issueNumber !== null) store.request.issueNumber = patch.issueNumber;
      return { ...store.request };
    }),
  },
  sessions: {},
  settings: { allSettings: vi.fn(async () => ({})) },
  tasks: {
    listTasksOnSubjects: vi.fn(async (refs: readonly string[]) =>
      refs.includes(String(store.task.subjectRef)) ? [{ ...store.task, createdAt: '2026-09-25T22:06:08.000Z' }] : [],
    ),
    getTask: vi.fn(async () => ({ ...store.task })),
    updateTaskState: vi.fn(async (_id: string, state: string) => {
      store.task.state = state;
      return { ...store.task };
    }),
  },
  threads: {
    ensureThread: vi.fn(async () => ({ id: 'thread-1' })),
    addMessage: vi.fn(async (input: Record<string, unknown>) => {
      store.messages.push(input);
      return input;
    }),
    listMessages: vi.fn(async () => []),
    createGate: vi.fn(async (input: Record<string, unknown>) => {
      store.gate = { id: 'gate-1', state: 'open', answer: null, ...input };
      return store.gate;
    }),
    getGate: vi.fn(async () => store.gate),
    answerGate: vi.fn(async (id: string, answer: string, answeredBy: string) => {
      if (!store.gate || store.gate.id !== id || store.gate.state !== 'open') return null;
      store.gate = { ...store.gate, state: 'answered', answer, answeredBy };
      return store.gate;
    }),
  },
}));

import { requests } from '@fleetadlc/db';
import { parseMarker } from '@fleetadlc/shared';
import type { Actors } from './actors.js';
import { Gates } from './gates.js';
import { REQUEST_DOCUMENT, requestLineFor } from './request-context.js';
import { RequestFiling, abandonRequest, carriesRequestLine, requestPrefixIn } from './request-lifecycle.js';

interface ListedIssue {
  number: number;
  title: string;
  body: string | null;
  labels: string[];
  htmlUrl: string;
  pullRequest: boolean;
  state: 'open' | 'closed';
}

const github = vi.hoisted(() => ({
  issues: [] as ListedIssue[],
  asked: [] as { repo: string; params: Record<string, unknown> }[],
  actingAs: [] as string[],
  comments: [] as unknown[],
}));

/** A GitHub client that answers a listing with the issues the test put there. */
const fakeClient = {
  listIssues: vi.fn(async (repo: string, params: Record<string, unknown>) => {
    github.asked.push({ repo, params });
    return repo === 'janedoe/fleetadlc-testbed' ? github.issues : [];
  }),
  comment: vi.fn(async (...args: unknown[]) => {
    github.comments.push(args);
    return { htmlUrl: 'https://github.com/x' };
  }),
  addLabels: vi.fn(async () => undefined),
  removeLabel: vi.fn(async () => undefined),
};

const actors = {
  asBot: vi.fn(async (name: string) => {
    github.actingAs.push(name);
    return fakeClient;
  }),
} as unknown as Actors;

const issue = (number: number, body: string | null, extra: Partial<ListedIssue> = {}): ListedIssue => ({
  number,
  title: `issue ${number}`,
  body,
  labels: [],
  htmlUrl: `https://github.com/janedoe/fleetadlc-testbed/issues/${number}`,
  pullRequest: false,
  state: 'open',
  ...extra,
});

beforeEach(() => {
  store.request.state = 'draft';
  store.request.issueNumber = null;
  store.request.repoId = 'repo-1';
  store.task.state = 'running';
  store.gate = null;
  store.messages = [];
  github.issues = [];
  github.asked = [];
  github.actingAs = [];
  github.comments = [];
  vi.mocked(requests.updateRequest).mockClear();
  vi.mocked(requests.findRequestByPrefix).mockClear();
});

describe('a request while its triage asks and is answered', () => {
  it('waits on its person while a question is open, and goes back to triage with the answer', async () => {
    const gates = new Gates(actors);

    await gates.open({ taskId: 'task-1', question: 'Hello, world or Hello?', options: ['Hello, world', 'Hello'] });

    expect(store.request.state).toBe('questions');
    expect(store.task.state).toBe('paused');
    // No issue exists to comment on or label; the thread is the record.
    expect(github.comments).toEqual([]);
    expect(store.messages).toContainEqual(
      expect.objectContaining({ kind: 'gate', text: 'Hello, world or Hello?', payload: { options: ['Hello, world', 'Hello'], gateId: 'gate-1' } }),
    );

    const answered = await gates.answer({ gateId: 'gate-1', reply: '1', answeredBy: 'janedoe' });

    expect(answered).toEqual({ answer: 'Hello, world', taskId: 'task-1' });
    expect(store.request.state).toBe('draft');
    expect(store.messages).toContainEqual(expect.objectContaining({ kind: 'you', author: 'janedoe', text: 'Hello, world' }));
  });

  it('leaves a filed request filed when a late question opens on it', async () => {
    store.request.state = 'filed';
    store.request.issueNumber = 16;

    await new Gates(actors).open({ taskId: 'task-1', question: 'One more thing?', options: [] });

    expect(store.request.state).toBe('filed');
    expect(requests.updateRequest).not.toHaveBeenCalled();
  });

  it('asks on the issue with the context the bot gave, since the comment is all a person there sees', async () => {
    store.task = { ...store.task, subjectType: 'issue', subjectRef: 'fleetadlc-testbed#15' };
    try {
      await new Gates(actors).open({
        taskId: 'task-1',
        question: 'Where should the page go?',
        options: ['index.html at the repository root', 'A different path'],
        context: 'The repository has no web root yet.',
      });

      const [repo, number, body] = github.comments[0] as [string, number, string];
      expect([repo, number]).toEqual(['janedoe/fleetadlc-testbed', 15]);
      expect(body).toContain('The repository has no web root yet.\n\n**Where should the page go?**');
      expect(body).toContain('Reply with a number, or in your own words.');
      // The thread has the context as the bot's own message already; its gate is the question.
      expect(store.messages).toContainEqual(expect.objectContaining({ kind: 'gate', text: 'Where should the page go?' }));
    } finally {
      store.task = { ...store.task, subjectType: 'request', subjectRef: 'request:a4b02784' };
    }
  });

  it('does not look for a request behind a gate on an issue', async () => {
    store.task = { ...store.task, subjectType: 'issue', subjectRef: 'fleetadlc-testbed#15' };
    try {
      await new Gates(actors).open({ taskId: 'task-1', question: 'Which path?', options: [] });
      expect(requests.findRequestByPrefix).not.toHaveBeenCalled();
      // An issue's gate is on GitHub, as it always was.
      expect(github.comments).toHaveLength(1);
    } finally {
      store.task = { ...store.task, subjectType: 'request', subjectRef: 'request:a4b02784' };
    }
  });
});

const SECRET = 'install-secret-for-the-test';
let bridge: Server;
let bridgeUrl: string;
/** The issues handed to Design or Build when a triage ended (`StageHandoff.afterIntake`). */
let handedOn: unknown[] = [];

describe('a request its person no longer wants', () => {
  // The only way to abandon one was the cost cap's answer, and Cancel left a
  // queued request queued, so the queue started it again later.
  const stop = vi.fn(async (_taskId: string, _actor: string, _note: string) => ({ questionsClosed: 1 }));

  beforeEach(() => {
    stop.mockClear();
  });

  it('is abandoned while it waits in the queue, and nothing is stopped', async () => {
    store.request.state = 'queued';
    store.task.state = 'done';

    const done = await abandonRequest({ requestId: REQUEST_ID, actor: 'janedoe', note: 'not wanted', stop });

    expect(done).toMatchObject({ outcome: 'abandoned', stopped: 0, request: { state: 'abandoned' } });
    expect(store.request.state).toBe('abandoned');
    expect(stop).not.toHaveBeenCalled();
  });

  it('stops its triage, which closes its questions, before it is abandoned, and audits it', async () => {
    const { audit } = await import('@fleetadlc/db');
    vi.mocked(audit).mockClear();
    store.request.state = 'questions';
    store.task.state = 'paused';

    const done = await abandonRequest({ requestId: REQUEST_ID, actor: 'janedoe', note: 'not wanted', stop });

    expect(stop).toHaveBeenCalledWith('task-1', 'janedoe', 'not wanted');
    expect(done).toMatchObject({ outcome: 'abandoned', stopped: 1, questionsClosed: 1 });
    expect(store.request.state).toBe('abandoned');
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'janedoe', action: 'request.abandoned', target: 'request:a4b02784', payload: expect.objectContaining({ from: 'questions', stopped: 1 }) }),
    );
  });

  it('leaves one that is filed or abandoned as it is, and says so', async () => {
    for (const state of ['filed', 'abandoned']) {
      store.request.state = state;
      expect(await abandonRequest({ requestId: REQUEST_ID, actor: 'janedoe', note: 'x', stop })).toEqual({ outcome: 'finished', state });
    }
    expect(await abandonRequest({ requestId: 'no-such-request', actor: 'janedoe', note: 'x', stop })).toEqual({ outcome: 'unknown' });
    expect(stop).not.toHaveBeenCalled();
  });

  it('is left as it was when its triage could not be stopped', async () => {
    store.task.state = 'running';
    const refused = vi.fn(async () => {
      throw new Error('hostd did not stop it: connection refused');
    });

    await expect(abandonRequest({ requestId: REQUEST_ID, actor: 'janedoe', note: 'x', stop: refused })).rejects.toThrow(/hostd did not stop it/);
    expect(store.request.state).toBe('draft');
  });
});

describe('a request whose triage finished', () => {
  beforeEach(async () => {
    handedOn = [];
    const { registerInternalApi } = await import('./internal-api.js');
    const { Router } = await import('./router.js');
    const router = new Router();
    registerInternalApi(router, {
      config: { automationBot: null } as never,
      webhooks: {} as never,
      scheduler: {} as never,
      stages: { onTaskDone: async () => null, afterIntake: async (input: unknown) => (handedOn.push(input), null) } as never,
      internalSecret: SECRET,
      alertsSecret: '',
      hostd: { cleanupTask: async () => undefined } as never,
      actors,
      automation: {} as never,
      gates: {} as never,
      taskService: {} as never,
      onboarding: {} as never,
      invitations: {} as never,
      threadStream: {} as never,
      webhookSetup: {} as never,
      repoSetup: {} as never,
      names: {} as never,
      requestFiling: new RequestFiling(actors, { automationBot: null } as never, { lookAgainAfterMs: 0 }),
    });
    bridge = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
    bridgeUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => bridge.close(() => resolve()));
  });

  const done = () =>
    fetch(`${bridgeUrl}/internal/tasks/task-1/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fleetadlc-internal-secret': SECRET },
      body: JSON.stringify({ state: 'done', reason: 'complete' }),
    });

  it('is filed as the issue that carries its line, and the thread says which', async () => {
    github.issues = [
      // Newest first, as GitHub lists them. A pull request quoting the line is not the issue.
      issue(18, 'Closes #16\n\nFleetADLC request: request:a4b02784', { pullRequest: true }),
      issue(17, 'OpenADLC request: request:a4b02785'),
      issue(16, '## Outcome\n\nA hello world page.\n\n**OpenADLC request:** `request:a4b02784`\n\n<!-- fleetadlc:{"event":"plan_posted"} -->', {
        title: 'Add a hello world page and a readme',
      }),
      issue(12, null),
    ];

    expect((await done()).status).toBe(200);

    expect(requests.updateRequest).toHaveBeenCalledWith(REQUEST_ID, { state: 'filed', issueNumber: 16 });
    expect(store.request).toMatchObject({ state: 'filed', issueNumber: 16 });
    // And then sent to Design or Build by the repository's spec rule.
    expect(handedOn).toEqual([{ repoName: 'fleetadlc-testbed', issueNumber: 16 }]);
    // Read as the automation account, over the repository's recently changed
    // issues: a request resolved by an older issue writes its line into it.
    expect(github.actingAs).toEqual(['janedoe-fleetadlc-flow']);
    expect(github.asked).toEqual([{ repo: 'janedoe/fleetadlc-testbed', params: { state: 'all', perPage: 100, sort: 'updated' } }]);
    expect(store.messages).toContainEqual({
      threadId: 'thread-1',
      kind: 'sys',
      author: 'fleetadlc',
      text: 'Filed as janedoe/fleetadlc-testbed#16',
      note: 'Add a hello world page and a readme',
      payload: { taskId: 'task-1', requestId: REQUEST_ID, issue: 16 },
      githubUrl: 'https://github.com/janedoe/fleetadlc-testbed/issues/16',
    });
  });

  it('stays a draft when nothing carries its line, and the thread says triage filed nothing', async () => {
    github.issues = [issue(17, 'OpenADLC request: request:a4b02785'), issue(15, 'An issue a person filed.')];

    expect((await done()).status).toBe(200);

    expect(requests.updateRequest).not.toHaveBeenCalled();
    expect(store.request.state).toBe('draft');
    expect(store.messages).toContainEqual(
      expect.objectContaining({
        kind: 'sys',
        text: 'Triage of request:a4b02784 ended without filing anything',
        note: 'no recent issue in janedoe/fleetadlc-testbed carries “OpenADLC request: request:a4b02784”',
      }),
    );
  });

  it('is filed on a second look, when GitHub’s list had not caught up with the issue yet', async () => {
    // On the live install intake filed fleetadlc-testbed#7 four seconds before its
    // task ended, and the list the ending read did not have it yet.
    const filed = issue(7, 'OpenADLC request: request:a4b02784', { title: 'Add hello-world3.html' });
    let looks = 0;
    fakeClient.listIssues.mockImplementation(async (repo: string, params: Record<string, unknown>) => {
      github.asked.push({ repo, params });
      looks += 1;
      return looks === 1 ? [] : [filed];
    });
    try {
      expect((await done()).status).toBe(200);

      expect(store.request).toMatchObject({ state: 'filed', issueNumber: 7 });
      expect(store.messages.map((message) => message.text)).toEqual(['Filed as janedoe/fleetadlc-testbed#7']);
    } finally {
      fakeClient.listIssues.mockImplementation(async (repo: string, params: Record<string, unknown>) => {
        github.asked.push({ repo, params });
        return repo === 'janedoe/fleetadlc-testbed' ? github.issues : [];
      });
    }
  });

  it('says nothing more when the issue’s delivery filed it while it looked', async () => {
    let looks = 0;
    fakeClient.listIssues.mockImplementation(async (repo: string, params: Record<string, unknown>) => {
      github.asked.push({ repo, params });
      looks += 1;
      // The delivery lands between the two looks.
      if (looks === 1) {
        store.request.state = 'filed';
        store.request.issueNumber = 7;
      }
      return [];
    });
    try {
      expect((await done()).status).toBe(200);

      expect(requests.updateRequest).not.toHaveBeenCalled();
      expect(store.messages.filter((message) => String(message.text).startsWith('Triage of'))).toEqual([]);
    } finally {
      fakeClient.listIssues.mockImplementation(async (repo: string, params: Record<string, unknown>) => {
        github.asked.push({ repo, params });
        return repo === 'janedoe/fleetadlc-testbed' ? github.issues : [];
      });
    }
  });

  it('looks in every repository when the request named none', async () => {
    store.request.repoId = null;
    github.issues = [issue(16, 'OpenADLC request: request:a4b02784')];
    // The issue is in the second repository, so the first one's empty answer is not the end.
    fakeClient.listIssues.mockImplementation(async (repo: string, params: Record<string, unknown>) => {
      github.asked.push({ repo, params });
      return repo === 'janedoe/FleetADLC' ? github.issues : [];
    });
    try {
      await done();

      expect(github.asked.map((call) => call.repo)).toEqual(['janedoe/fleetadlc-testbed', 'janedoe/FleetADLC']);
      expect(requests.updateRequest).toHaveBeenCalledWith(REQUEST_ID, expect.objectContaining({ repoId: 'repo-2' }));
      expect(store.request).toMatchObject({ state: 'filed', issueNumber: 16, repoId: 'repo-2' });
    } finally {
      fakeClient.listIssues.mockImplementation(async (repo: string, params: Record<string, unknown>) => {
        github.asked.push({ repo, params });
        return repo === 'janedoe/fleetadlc-testbed' ? github.issues : [];
      });
    }
  });

  it('links nothing twice when the same ending is reported again', async () => {
    github.issues = [issue(16, 'OpenADLC request: request:a4b02784')];

    await done();
    await done();

    expect(requests.updateRequest).toHaveBeenCalledTimes(1);
    expect(store.messages.filter((message) => String(message.text).startsWith('Filed as'))).toHaveLength(1);
  });
});

describe('the line that links an issue to its request', () => {
  it('is found however a model decorated it', () => {
    for (const body of [
      'OpenADLC request: request:a4b02784',
      'Outcome\n\n**OpenADLC request:** request:a4b02784\n',
      'OpenADLC request: `request:a4b02784`',
      '- OpenADLC request: request:a4b02784',
      '> fleetadlc request: REQUEST:A4B02784',
    ]) {
      expect(carriesRequestLine(body, 'request:a4b02784'), body).toBe(true);
    }
  });

  it('is not another request’s, nor a passing mention', () => {
    expect(carriesRequestLine('OpenADLC request: request:a4b027845', 'request:a4b02784')).toBe(false);
    expect(carriesRequestLine('OpenADLC request: request:a4b02785', 'request:a4b02784')).toBe(false);
    expect(carriesRequestLine('This is like OpenADLC request: request:a4b02784', 'request:a4b02784')).toBe(false);
    expect(carriesRequestLine(null, 'request:a4b02784')).toBe(false);
    expect(carriesRequestLine('OpenADLC request: request:a4b02784', 'fleetadlc-testbed#15')).toBe(false);
  });
});

describe('the triage skill, which is what makes any of this happen', () => {
  const skill = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'crew', 'skills', 'triage', 'SKILL.md'),
    'utf8',
  );

  it('sends a console request’s triage to the document the bridge writes', () => {
    expect(skill).toContain(`\`${REQUEST_DOCUMENT}\``);
  });

  it('asks with the marker the runner turns into a gate, the question and its choices in it, or an open question', () => {
    const markers = [...skill.matchAll(/<!--\s*fleetadlc:\{[^\n]*?\}\s*-->/g)].map((match) => parseMarker(match[0]));
    const questions = markers.filter((marker) => marker?.event === 'question');

    expect(questions).toContainEqual({
      event: 'question',
      question: 'Where should the page go?',
      options: ['index.html at the repository root', 'A different path'],
    });
    expect(questions).toContainEqual({ event: 'question', question: 'What should the page say?', open: true });
    // Every question the skill shows is asked in its marker, not by the message around it.
    for (const question of questions) expect(typeof question?.question).toBe('string');
  });

  it('asks on an issue the way it asks on a console request, and never several questions at once', () => {
    const prose = skill.replace(/\s+/g, ' ');
    expect(prose).toContain('On an issue, ask the same way: end your own message with the marker');
    expect(prose).not.toMatch(/questions numbered|all at once/i);
  });

  it('says to mark an issue for Build as ready, or as waiting, and never neither', () => {
    // fleetadlc-testbed#7 was filed into Build with neither label, where nothing
    // looks at it; the snake game's intake had added `start:now` of its own accord.
    expect(skill).toContain('exactly one of `start:now`');
    expect(skill).toContain('or `blocked`');
  });

  it('files the issue with the line the bridge looks for', () => {
    expect(skill).toContain(requestLineFor('request:<id8>'));
    expect(skill).toContain('gh issue create');
  });
});

describe('an issue that names the request it was filed for', () => {
  const filing = () => new RequestFiling(actors, { automationBot: null } as never, { lookAgainAfterMs: 0 });
  const TESTBED = { id: 'repo-1', fullName: 'janedoe/fleetadlc-testbed' };
  const opened = (body: string | null) => ({
    number: 7,
    title: 'Add hello-world3.html',
    body,
    htmlUrl: 'https://github.com/janedoe/fleetadlc-testbed/issues/7',
  });

  it('files the request as soon as it is delivered, and its triage thread says which', async () => {
    expect(await filing().issueOpened(TESTBED, opened('## Outcome\n\nA page.\n\nFleetADLC request: request:a4b02784\n'))).toBe(true);

    expect(store.request).toMatchObject({ state: 'filed', issueNumber: 7 });
    expect(store.messages).toContainEqual(
      expect.objectContaining({ kind: 'sys', text: 'Filed as janedoe/fleetadlc-testbed#7', payload: expect.objectContaining({ taskId: 'task-1', issue: 7 }) }),
    );
  });

  it('keeps the repository it was filed in, for a request that named none', async () => {
    store.request.repoId = null;
    expect(await filing().issueOpened({ id: 'repo-2', fullName: 'janedoe/FleetADLC' }, opened('OpenADLC request: request:a4b02784'))).toBe(true);
    expect(requests.updateRequest).toHaveBeenCalledWith(REQUEST_ID, { state: 'filed', issueNumber: 7, repoId: 'repo-2' });
    expect(store.request).toMatchObject({ state: 'filed', issueNumber: 7, repoId: 'repo-2' });
  });

  it('files nothing for an issue that names no request, another repository’s request, or one already filed', async () => {
    expect(await filing().issueOpened(TESTBED, opened('An issue a person filed.'))).toBe(false);
    expect(await filing().issueOpened({ id: 'repo-2', fullName: 'janedoe/FleetADLC' }, opened('OpenADLC request: request:a4b02784'))).toBe(false);
    store.request.state = 'filed';
    store.request.issueNumber = 5;
    expect(await filing().issueOpened(TESTBED, opened('OpenADLC request: request:a4b02784'))).toBe(false);

    expect(requests.updateRequest).not.toHaveBeenCalled();
    expect(store.request.issueNumber).toBe(5);
  });
});


describe('an issue filed before the rename to FleetADLC', () => {
  it('still names the request it was filed for', () => {
    const body = '### Outcome\n\nA thing.\n\nFleet request: request:a4b02784';
    expect(carriesRequestLine(body, 'request:a4b02784')).toBe(true);
    expect(carriesRequestLine(body, 'request:00000000')).toBe(false);
  });
});

describe('an issue filed before the rename to OpenADLC', () => {
  // The triage skill wrote `FleetADLC request:` until the rename. An issue it
  // filed then, still waiting for its request to be filed, has only that line.
  it('still names the request it was filed for', () => {
    const body = '### Outcome\n\nA thing.\n\nFleetADLC request: request:a4b02784';
    expect(carriesRequestLine(body, 'request:a4b02784')).toBe(true);
    expect(requestPrefixIn(body)).toBe('a4b02784');
  });

  it('reads the line the triage skill writes now', () => {
    const body = '### Outcome\n\nA thing.\n\nOpenADLC request: request:a4b02784';
    expect(carriesRequestLine(body, 'request:a4b02784')).toBe(true);
    expect(requestPrefixIn(body)).toBe('a4b02784');
  });
});
