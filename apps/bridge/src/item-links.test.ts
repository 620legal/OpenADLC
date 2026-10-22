import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Work items whose links and the board's rows disagree, read as the console
 * reads them: the page, the card, the few-second poll, and Cancel.
 *
 * - `W-128` is issue 12, whose row still records pull 31 as its pull
 *   request, and still has the request filed as it.
 * - `W-132` is pull 31, which a person moved to an item of its own.
 * - `W-133` is that request, which a person unlinked from issue 12.
 * - `W-140` is issue 77, closed long ago, which the board has no row for.
 *
 * Links were added on top of the item as it was before them, and read from
 * the rows wherever the two disagreed: the request opened as `api#12`, and
 * its Cancel closed issue 12; issue 12's card counted the request's triage;
 * `W-140` drew a made-up issue in Intake. Each item here is its own links.
 */

const REPO = { id: 'repo-1', name: 'api', fullName: 'acme/api', stageModes: {}, color: 'teal', defaultBranch: 'main' };
const FILED = { id: 'a4b02784-3ae8-450b-abe9-0c93eb4d67dc', text: 'Record which model reviewed', context: null, repoId: 'repo-1', issueNumber: 12, state: 'filed', requestedBy: 'jane@acme.test', createdAt: '2026-10-20T09:00:00.000Z', updatedAt: '2026-10-20T09:10:00.000Z' };
const ISSUE_12 = {
  id: 'i-12', repoId: 'repo-1', repoName: 'api', number: 12, title: 'Record the model per review', stage: 'review', labels: ['adlc:review'],
  declaredPaths: [], prChangedPaths: [], body: '', url: 'https://github.com/acme/api/issues/12',
  // The row's own record, from before a person moved the pull.
  prNumber: 31,
  updatedAt: '2026-10-21T10:00:00.000Z', createdAt: '2026-10-20T09:10:00.000Z',
};
const CREW = [
  { id: 'b-intake', name: 'intake', slot: 'intake', displayName: 'intake', role: 'intake', githubLogin: 'acme-crew', status: 'stopped' },
  { id: 'b-builder', name: 'builder', slot: 'builder', displayName: 'builder', role: 'implement', githubLogin: 'acme-crew', status: 'stopped' },
  { id: 'b-lead', name: 'lead-reviewer', slot: 'lead-reviewer', displayName: 'lead reviewer', role: 'review_lead', githubLogin: 'acme-reviewer', status: 'stopped' },
];

const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
const task = (id: string, botId: string, kind: string, subjectRef: string, state: string, costUsd: number) => ({
  id, botId, repoId: 'repo-1', kind, subjectType: 'issue', subjectRef, state, round: 0, costUsd, skill: null,
  startedAt: at(0), endedAt: state === 'running' ? null : at(0), exitReason: null, tmuxSession: `${botId}-s`, branch: null, createdAt: at(0),
});
const TASKS = [
  task('k-build', 'b-builder', 'patch', 'api#12', 'running', 1),
  task('k-review', 'b-lead', 'review', 'api#31', 'running', 0.5),
  task('k-triage', 'b-intake', 'intake', 'request:a4b02784', 'running', 0.25),
  task('k-old', 'b-builder', 'implement', 'api#77', 'done', 2),
];

type LinkRow = { id: number; itemId: string; itemNumber: number; kind: 'issue' | 'pull' | 'request'; repoId: string | null; number: number | null; requestId: string | null; linkedBy: string | null; title: string; state: 'open' | 'closed' | 'merged'; url: string | null; openedAt: string; closedAt: string | null };
const link = (id: number, itemNumber: number, kind: LinkRow['kind'], number: number | null, extra: Partial<LinkRow> = {}): LinkRow => ({
  id, itemId: `w-${itemNumber}`, itemNumber, kind, repoId: kind === 'request' ? null : 'repo-1', number, requestId: null, linkedBy: null,
  title: `${kind} ${number}`, state: 'open', url: null, openedAt: at(2), closedAt: null, ...extra,
});
const LINKS: LinkRow[] = [
  link(1, 133, 'request', null, { requestId: FILED.id, title: FILED.text, linkedBy: 'jane@acme.test' }),
  link(2, 128, 'issue', 12, { title: ISSUE_12.title, url: ISSUE_12.url }),
  link(3, 132, 'pull', 31, { title: 'Store the model per round', url: 'https://github.com/acme/api/pull/31', linkedBy: 'jane@acme.test' }),
  // Numbered from history: closed a year ago, before the board read it, so it has no row.
  link(4, 140, 'issue', 77, { title: 'An old report', state: 'closed', url: 'https://github.com/acme/api/issues/77', openedAt: at(400) }),
];

const seen = vi.hoisted(() => ({ linkReads: [] as string[], issueReads: [] as string[] }));

vi.mock('@openadlc/db', () => {
  const items = [128, 132, 133, 140].map((number) => ({ id: `w-${number}`, number, mergedInto: null }));
  const issues = {
    listIssues: vi.fn(async (repoName?: string) => {
      seen.issueReads.push(repoName ?? '*');
      return [ISSUE_12];
    }),
    getIssue: vi.fn(async (repoId: string, number: number) => {
      seen.issueReads.push(`#${number}`);
      return repoId === ISSUE_12.repoId && number === ISSUE_12.number ? ISSUE_12 : null;
    }),
    boardCards: vi.fn(async () => [
      { repo: 'api', ref: 'api#12', title: ISSUE_12.title, stage: ISSUE_12.stage, assignees: [], gateOpen: false, url: ISSUE_12.url, labels: ISSUE_12.labels, updatedAt: ISSUE_12.updatedAt },
    ]),
  };
  const holding = (things: readonly ({ repoId: string; number: number } | { requestId: string })[]) => {
    const held = new Set(
      LINKS.filter((one) => things.some((thing) => ('requestId' in thing ? one.requestId === thing.requestId : one.repoId === thing.repoId && one.number === thing.number))).map(
        (one) => one.itemId,
      ),
    );
    return LINKS.filter((one) => held.has(one.itemId));
  };
  return {
    spendingLimits: {
      SPENDING_PROVIDERS: ['anthropic', 'openai', 'xai'],
      GLOBAL_SCOPE: 'global',
      seedGlobal: vi.fn(async () => false),
      effectiveTaskCap: vi.fn(async (_repoId: string | null, fallback: number) => fallback),
      amountOf: vi.fn(async () => null),
      refusal: vi.fn(async () => null),
      listLimits: vi.fn(async () => []),
      setLimit: vi.fn(async () => undefined),
      dollars: (amount: number) => `$${amount}`,
      botKind: (id: string) => `month_bot:${id}`,
      providerKind: (provider: string) => `month_provider:${provider}`,
      repoScope: (id: string) => `repo:${id}`,
      repoIdOf: (scope: string) => (scope.startsWith('repo:') ? scope.slice(5) : null),
    },
    audit: vi.fn(async () => undefined),
    AccountInUse: class AccountInUse extends Error {},
    attachments: { listForSubjects: vi.fn(async () => []) },
    designMemory: { listForSubjects: vi.fn(async () => []) },
    standingApprovals: { activeFor: vi.fn(async () => null) },
    bots: { listBots: vi.fn(async () => CREW) },
    costs: {},
    credentials: { getCredential: vi.fn(async () => ({ status: 'active', tokenExpiresAt: null })) },
    issues,
    leases: {},
    listAudit: vi.fn(),
    listEventsOfType: vi.fn(async () => []),
    mergeLines: { line: vi.fn(async () => []) },
    modelAccounts: {},
    recordEvent: vi.fn(),
    repos: { listRepos: vi.fn(async () => [REPO]), getRepoByName: vi.fn(async (name: string) => (name === 'api' ? REPO : null)) },
    requests: {
      listRequests: vi.fn(async () => [FILED]),
      getRequest: vi.fn(async (id: string) => (id === FILED.id ? FILED : null)),
      findRequestByPrefix: vi.fn(async (prefix: string) => (FILED.id.startsWith(prefix) ? FILED : null)),
      listRequestsForIssue: vi.fn(async (repoId: string, number: number) => (repoId === FILED.repoId && number === FILED.issueNumber ? [FILED] : [])),
    },
    sessions: { listSessions: vi.fn(async () => []), recentLines: vi.fn(async () => new Map()) },
    settings: {
      allSettings: vi.fn(async () => ({})),
      getSetting: vi.fn(async () => null),
      mergeSettingJson: vi.fn(async () => undefined),
      removeSettingJsonKey: vi.fn(async () => undefined),
    },
    withAdvisoryLock: async <T,>(_key: string, fn: () => Promise<T>): Promise<T> => fn(),
    stageMoves: { sendBackOfTask: vi.fn(async () => null), sendBackCounts: vi.fn(async () => new Map()) },
    tasks: {
      listTasksOnSubjects: vi.fn(async (refs: readonly string[]) => TASKS.filter((one) => refs.includes(one.subjectRef))),
      listTasks: vi.fn(async (filter: { states?: string[] }) => TASKS.filter((one) => !filter.states || filter.states.includes(one.state))),
      listTasksForSubjects: vi.fn(async (kind: string, refs: readonly string[]) => TASKS.filter((one) => one.kind === kind && refs.includes(one.subjectRef))),
      countRunning: vi.fn(async () => TASKS.filter((one) => one.state === 'running').length),
      runningSince: vi.fn(async () => new Map()),
    },
    threads: { listOpenGates: vi.fn(async () => []), listThreadsForSubjects: vi.fn(async () => []), listMessages: vi.fn(async () => []) },
    workItems: {
      isNumbered: vi.fn(async () => true),
      byNumber: vi.fn(async (number: number) => items.find((one) => one.number === number) ?? null),
      itemOf: vi.fn(async (thing: { requestId?: string; repoId?: string; number?: number }) => {
        const found = LINKS.find((one) => (thing.requestId ? one.requestId === thing.requestId : one.repoId === thing.repoId && one.number === thing.number));
        return items.find((one) => one.id === found?.itemId) ?? null;
      }),
      linksOf: vi.fn(async (itemId: string) => LINKS.filter((one) => one.itemId === itemId)),
      // As the store selects them: items with a link open, closed since, or an issue the board has outside Done.
      boardLinks: vi.fn(async (since: Date) => {
        seen.linkReads.push('board');
        const shown = new Set(
          LINKS.filter((one) => one.state === 'open' || Date.parse(one.closedAt ?? one.openedAt) >= since.getTime() || (one.kind === 'issue' && one.number === 12)).map((one) => one.itemId),
        );
        return LINKS.filter((one) => shown.has(one.itemId));
      }),
      linksOfItemsHolding: vi.fn(async (things: readonly ({ repoId: string; number: number } | { requestId: string })[]) => {
        seen.linkReads.push('running');
        return holding(things);
      }),
      allLinks: vi.fn(async () => {
        seen.linkReads.push('all');
        return LINKS;
      }),
    },
  };
});

let server: Server;
let base: string;
const calls: string[] = [];
const audits: { action: string; target: string }[] = [];

beforeEach(async () => {
  calls.length = 0;
  audits.length = 0;
  seen.linkReads.length = 0;
  seen.issueReads.length = 0;
  const { registerConsoleApi } = await import('./api.js');
  const { registerItemControlRoutes } = await import('./item-controls.js');
  const { resolveControlled } = await import('./items.js');
  const { Router } = await import('./router.js');
  const router = new Router(undefined, undefined, undefined, async () => 'admin');
  registerConsoleApi(router, {
    config: { gitHubClientId: '', webhookSecret: '', humans: [], review: { maxRounds: 3 } } as never,
    hostd: {} as never,
    actors: {} as never,
    invitations: {} as never,
    automation: {} as never,
    gates: {} as never,
    taskService: {} as never,
    threadStream: { subscribe: () => () => undefined, watching: 0 } as never,
    onboarding: {} as never,
    webhookSetup: {} as never,
    repoSetup: {} as never,
  });
  const github = {
    addLabels: async (_repo: string, number: number, labels: string[]) => void calls.push(`label #${number} +${labels.join(',')}`),
    removeLabel: async (_repo: string, number: number, label: string) => void calls.push(`label #${number} -${label}`),
    comment: async (_repo: string, number: number) => void calls.push(`comment #${number}`),
    request: async <T,>(method: string, path: string) => (calls.push(`${method} ${path}`), undefined as T),
  };
  // The control routes' resolve, as `main.ts` wires it.
  registerItemControlRoutes(router, {
    resolve: (subject) =>
      resolveControlled(subject, {
        pull: async () => ({ headRef: 'person/fix', headRepoFullName: 'acme/api', merged: false, state: 'open' }),
        defaultBranch: async () => 'main',
      }),
    github: async () => github,
    issuesOf: async () => [],
    setLabels: async (_repoId, number, labels) => void calls.push(`board #${number} ${labels.join(',')}`),
    audit: async (entry) => void audits.push({ action: entry.action, target: entry.target }),
    tasks: async (subjects) => TASKS.filter((one) => subjects.includes(one.subjectRef)).map((one) => ({ id: one.id, bot: one.botId, kind: one.kind, state: one.state })),
    openQuestions: async () => 0,
    stop: async (taskId) => (calls.push(`stop ${taskId}`), { questionsClosed: 0 }),
    closeQuestions: async () => 0,
    leaveMergeLine: async (_repo, pr) => void calls.push(`leave line #${pr}`),
    releaseLease: async (_repoId, number) => (calls.push(`lease #${number}`), false),
    abandonRequest: async (requestId) => (calls.push(`abandon ${requestId.slice(0, 8)}`), 'abandoned the request'),
    forget: async (_repoId, number) => void calls.push(`forget #${number}`),
  });
  server = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const json = async <T,>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> => {
  const response = await fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', 'x-openadlc-identity': 'ada@acme.test' } });
  return { status: response.status, body: (await response.json()) as T };
};

interface Page {
  key: string;
  title: string;
  stage: string | null;
  subjects: string[];
  costUsd: number;
  request: { id: string } | null;
  issue: { number: number; title: string; stage: string; onBoard: boolean } | null;
  pullRequest: { number: number } | null;
  tasks: { id: string }[];
  workItem: { number: number } | null;
}
interface Card {
  ref: string;
  stage?: string;
  item: { number: number } | null;
  prNumber?: number | null;
  costUsd?: number;
  active?: { kind: string }[];
}

const page = (subject: string) => json<Page>(`/v1/items/${encodeURIComponent(subject)}`);
const board = async () => {
  const { body } = await json<{ columns: { stage: string; cards: Card[] }[] }>('/v1/board');
  return body.columns.flatMap((column) => column.cards.map((card) => ({ ...card, stage: column.stage })));
};
const cancel = (subject: string) => json<{ steps: { step: string; done: boolean; what: string }[]; error?: string }>(`/v1/items/${encodeURIComponent(subject)}/cancel`, { method: 'POST', body: JSON.stringify({ reason: 'not wanted' }) });

describe('work items whose links and rows disagree', () => {
  it('W-128, issue 12: its own issue, without the pull its row records or the request filed as it', async () => {
    for (const subject of ['W-128', 'api#12']) {
      const { body: view } = await page(subject);
      expect(view, subject).toMatchObject({ key: 'api#12', workItem: { number: 128 }, request: null, pullRequest: null, subjects: ['api#12'], costUsd: 1 });
      expect(view.issue, subject).toMatchObject({ number: 12, stage: 'review', onBoard: true });
      expect(view.tasks.map((one) => one.id), subject).toEqual(['k-build']);
    }

    // Its card counts its own build, not pull 31's review nor the request's triage.
    const card = (await board()).find((one) => one.ref === 'api#12');
    expect(card).toMatchObject({ stage: 'review', item: { number: 128 }, prNumber: null, costUsd: 1 });
    expect(card?.active?.map((one) => one.kind)).toEqual(['patch']);

    // Cancel stops its build and closes its issue: no pull request to close, no request to abandon.
    const { status, body } = await cancel('W-128');
    expect(status).toBe(200);
    expect(body.steps.map((one) => one.step)).toEqual(['board', 'tasks', 'questions', 'issue', 'lease']);
    expect(calls).toEqual(['forget #12', 'stop k-build', 'comment #12', 'PATCH /repos/acme/api/issues/12', 'lease #12']);
  });

  it('W-132, pull 31: the pull alone, in Review by its own state, with its own card, and no cancel', async () => {
    for (const subject of ['W-132', 'api#31']) {
      const { body: view } = await page(subject);
      expect(view, subject).toMatchObject({ key: 'api#31', title: 'Store the model per round', stage: 'review', issue: null, pullRequest: { number: 31 }, subjects: ['api#31'], costUsd: 0.5 });
      expect(view.tasks.map((one) => one.id), subject).toEqual(['k-review']);
    }

    const card = (await board()).find((one) => one.ref === 'api#31');
    expect(card).toMatchObject({ stage: 'review', item: { number: 132 }, costUsd: 0.5, pull: true });

    const { status, body } = await cancel('W-132');
    expect(status).toBe(409);
    expect(body.error).toMatch(/pull request with no issue/);
    expect(calls).toEqual([]);
  });

  it('W-133, the request unlinked from issue 12: its own request, never issue 12, and its cancel leaves issue 12 alone', async () => {
    for (const subject of ['W-133', 'request:a4b02784']) {
      const { body: view } = await page(subject);
      expect(view, subject).toMatchObject({ key: 'request:a4b02784', title: 'Record which model reviewed', stage: 'intake', request: { id: FILED.id }, issue: null, pullRequest: null, subjects: ['request:a4b02784'] });
      expect(view.tasks.map((one) => one.id), subject).toEqual(['k-triage']);
    }

    // Filed, it is no card of its own, and not issue 12's.
    expect((await board()).map((one) => one.ref)).toEqual(['api#12', 'api#31']);

    const { status, body } = await cancel('W-133');
    expect(status).toBe(200);
    expect(body.steps.map((one) => one.step)).toEqual(['tasks', 'questions', 'request']);
    // Not `forget #12`, `stop k-build` and `PATCH .../issues/12`: issue 12 is W-128's.
    expect(calls).toEqual(['stop k-triage', 'abandon a4b02784']);
  });

  it('W-140, issue 77 with no row: drawn from its link, Done as its header says, with no card and no controls', async () => {
    const { body: view } = await page('W-140');
    expect(view).toMatchObject({ key: 'api#77', title: 'An old report', stage: 'done', subjects: ['api#77'], costUsd: 2 });
    expect(view.issue).toEqual({ number: 77, title: 'An old report', url: 'https://github.com/acme/api/issues/77', stage: 'done', onBoard: false });

    expect((await board()).map((one) => one.ref)).not.toContain('api#77');

    const { status, body } = await cancel('W-140');
    expect(status).toBe(409);
    expect(body.error).toMatch(/api#77 was closed before OpenADLC read it/);
    expect(calls).toEqual([]);
  });

  it('polls each running card as the board shows it, from the links of the work running and nothing else', async () => {
    const { body } = await json<{ running: number; cards: { ref: string; active: { kind: string; state: string }[] }[] }>('/v1/board/activity');
    // The triage is on the request's item, which has no card: not on issue 12's.
    expect(body.cards.map((card) => [card.ref, card.active.map((one) => one.kind)])).toEqual([
      ['api#12', ['patch']],
      ['api#31', ['review']],
    ]);
    expect(body.running).toBe(3);
    // Only the items running work is linked to, and their issues one by one.
    expect(seen.linkReads).toEqual(['running']);
    expect(seen.issueReads).toEqual(['#12']);
  });

  it('reads, for the board, only the links of work open or closed in the week Done shows', async () => {
    const { workItems } = await import('@openadlc/db');
    await board();
    expect(seen.linkReads).toEqual(['board']);
    const since = vi.mocked(workItems.boardLinks).mock.calls.at(-1)![0];
    expect(Date.now() - since.getTime()).toBeGreaterThan(7 * 86_400_000 - 60_000);
    expect(Date.now() - since.getTime()).toBeLessThan(7 * 86_400_000 + 60_000);
  });
});
