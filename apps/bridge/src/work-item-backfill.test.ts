import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A row the history read saved. */
type Row = { number: number; kind: 'issue' | 'pull'; title: string; state: string; url: string; openedAt: string; headRef?: string | null; headRepo?: string | null; baseRef?: string | null; closes?: readonly number[] };

/**
 * The store as far as the history read goes, in memory: each repository's
 * progress, the rows read, and the numbers given, in the order of the plan.
 */
const store = vi.hoisted(() => {
  type Progress = { repoId: string | null; issuesPage: number; pullsPage: number; readAt: string | null; numberedAt: string | null; caughtUpAt: string | null; lastError: string | null };
  const state = {
    repos: [] as { id: string; name: string; fullName: string; defaultBranch: string }[],
    progress: [] as Progress[],
    rows: new Map<string, Row[]>(),
    requests: [] as { requestId: string; openedAt: string }[],
    numbers: new Map<string, number>(),
    groups: [] as string[][],
    next: 1,
  };
  return {
    state,
    reset() {
      state.repos = [];
      state.progress = [];
      state.rows = new Map();
      state.requests = [];
      state.numbers = new Map();
      state.groups = [];
      state.next = 1;
    },
  };
});

vi.mock('@openadlc/db', () => {
  const progressOf = (repoId: string | null) => store.state.progress.find((one) => one.repoId === repoId);
  const keyOf = (member: { kind: string; repoId?: string | null; number?: number; requestId?: string }) =>
    member.kind === 'request' ? member.requestId! : `${store.state.repos.find((repo) => repo.id === member.repoId)?.name}#${member.number}`;
  return {
    repos: { listRepos: vi.fn(async () => store.state.repos) },
    workItems: {
      startBackfill: vi.fn(async (repoId: string) => {
        if (!progressOf(repoId)) store.state.progress.push({ repoId, issuesPage: 1, pullsPage: 1, readAt: null, numberedAt: null, caughtUpAt: null, lastError: null });
      }),
      backfillState: vi.fn(async () => store.state.progress.map((one) => ({ ...one }))),
      saveBackfillPage: vi.fn(async (repoId: string, which: 'issues' | 'pulls', nextPage: number, rows: Row[]) => {
        store.state.rows.set(repoId, [...(store.state.rows.get(repoId) ?? []), ...rows]);
        progressOf(repoId)![which === 'issues' ? 'issuesPage' : 'pullsPage'] = nextPage;
      }),
      markRead: vi.fn(async (repoId: string) => {
        progressOf(repoId)!.readAt = new Date().toISOString();
      }),
      markCaughtUp: vi.fn(async (repoId: string, at: string) => {
        progressOf(repoId)!.caughtUpAt = at;
      }),
      recordBackfillError: vi.fn(async (repoId: string, error: string) => {
        progressOf(repoId)!.lastError = error;
      }),
      numberPending: vi.fn(async (plan: (pending: unknown[], linked: unknown[]) => { members: { kind: string; repoId?: string; number?: number; requestId?: string }[] }[]) => {
        const ready = store.state.progress.filter((one) => one.repoId && one.readAt && !one.numberedAt).map((one) => one.repoId!);
        const pending = [
          ...ready.flatMap((repoId) => {
            const repo = store.state.repos.find((one) => one.id === repoId)!;
            return (store.state.rows.get(repoId) ?? []).map((row) => ({
              ...row,
              repoId,
              repoFullName: repo.fullName,
              url: row.url,
              headRef: row.headRef ?? null,
              headRepo: row.headRepo ?? null,
              baseRef: row.baseRef ?? null,
              closes: [...(row.closes ?? [])],
            }));
          }),
          ...store.state.requests
            .filter((request) => !store.state.numbers.has(request.requestId))
            .map((request) => ({ kind: 'request', requestId: request.requestId, repoId: null, issueNumber: null, title: 'r', state: 'open', openedAt: request.openedAt, itemId: null })),
        ];
        let links = 0;
        const groups = plan(pending, []);
        for (const group of groups) {
          const number = store.state.next++;
          store.state.groups.push(group.members.map(keyOf));
          for (const member of group.members) {
            store.state.numbers.set(keyOf(member), number);
            links += 1;
          }
        }
        for (const repoId of ready) {
          store.state.rows.delete(repoId);
          progressOf(repoId)!.numberedAt = new Date().toISOString();
        }
        const install = progressOf(null);
        if (install) install.numberedAt ??= new Date().toISOString();
        else store.state.progress.push({ repoId: null, issuesPage: 1, pullsPage: 1, readAt: null, numberedAt: new Date().toISOString(), caughtUpAt: null, lastError: null });
        return { items: groups.length, links, repos: ready };
      }),
      itemOf: vi.fn(async () => null),
      ensureLink: vi.fn(async () => null),
      isNumbered: vi.fn(async () => true),
      mergeInto: vi.fn(async () => true),
    },
  };
});

import { workItems } from '@openadlc/db';
import { WorkItemBackfill } from './work-item-backfill.js';

const day = (n: number) => new Date(Date.UTC(2025, 0, 1) + n * 86_400_000).toISOString();

/**
 * A GitHub with a history to read. Anything but the four reads it answers is
 * recorded and refused: the read never writes.
 */
function github(history: Record<string, { issues: { number: number; createdAt: string }[]; pulls: { number: number; createdAt: string; headRef?: string; body?: string; merged?: boolean }[] }>) {
  const asked: string[] = [];
  const refused: string[] = [];
  const failing = new Set<string>();
  const page = <T>(all: T[], params: { page?: number; perPage?: number }) => {
    const per = params.perPage ?? 50;
    const from = ((params.page ?? 1) - 1) * per;
    return all.slice(from, from + per);
  };
  const reads = {
    listIssues: vi.fn(async (repo: string, params: { page?: number; perPage?: number; direction?: string; since?: string }) => {
      asked.push(`${repo} issues ${params.page ?? 1}${params.since ? ' since' : ''}`);
      if (failing.has(`${repo} issues ${params.page}`)) throw Object.assign(new Error('API rate limit exceeded'), { status: 403 });
      if (params.since) return [];
      expect(params.direction).toBe('asc');
      return page(history[repo]!.issues, params).map((issue) => ({
        number: issue.number, title: `#${issue.number}`, body: null, labels: [], htmlUrl: `https://github.com/${repo}/issues/${issue.number}`,
        pullRequest: false, state: 'closed' as const, createdAt: issue.createdAt, updatedAt: issue.createdAt, author: null, association: null,
      }));
    }),
    listPullRequests: vi.fn(async (repo: string, params: { page?: number; perPage?: number; direction?: string }) => {
      asked.push(`${repo} pulls ${params.page ?? 1}`);
      expect(params.direction).toBe('asc');
      return page(history[repo]!.pulls, params).map((pull) => ({
        number: pull.number, title: `#${pull.number}`, body: pull.body ?? null, state: 'closed' as const, merged: pull.merged ?? true,
        htmlUrl: `https://github.com/${repo}/pull/${pull.number}`, createdAt: pull.createdAt, headRef: pull.headRef ?? 'patch-1', headRepoFullName: repo, baseRef: 'main',
      }));
    }),
    getPullRequest: vi.fn(),
    closingIssueRefs: vi.fn(),
  };
  const client = new Proxy(reads, {
    get(target, name: string) {
      if (name in target) return target[name as keyof typeof target];
      if (name === 'then') return undefined;
      refused.push(name);
      return () => Promise.reject(new Error(`the history read called ${name}`));
    },
  });
  return { client, asked, refused, failing };
}

beforeEach(() => {
  store.reset();
  vi.mocked(workItems.numberPending).mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('the history read of work items', () => {
  it('resumes at the page it stopped on, and numbers both repositories in the order things were opened', async () => {
    store.state.repos = [
      { id: 'r-app', name: 'app', fullName: 'acme/app', defaultBranch: 'main' },
      { id: 'r-api', name: 'api', fullName: 'acme/api', defaultBranch: 'main' },
    ];
    // 250 issues in app, three pages, opened on even days; api's on odd ones.
    const appIssues = Array.from({ length: 250 }, (_, index) => ({ number: index + 1, createdAt: day(index * 2) }));
    const gh = github({
      'acme/app': {
        issues: appIssues,
        pulls: [
          { number: 251, createdAt: day(600), headRef: 'agent/x/3-fix' },
          { number: 252, createdAt: day(601), body: 'Closes #5' },
          { number: 253, createdAt: day(602), body: 'Tidies the readme.' },
        ],
      },
      'acme/api': { issues: [{ number: 1, createdAt: day(1) }, { number: 2, createdAt: day(3) }], pulls: [] },
    });
    // A request made before numbering, between api#2 (day 3) and app#3 (day 4).
    store.state.requests = [{ requestId: 'req-1', openedAt: day(3.5) }];
    gh.failing.add('acme/app issues 3');

    const backfill = new WorkItemBackfill(async () => gh.client as never);
    await backfill.run();

    expect(store.state.progress.find((one) => one.repoId === 'r-app')).toMatchObject({ issuesPage: 3, readAt: null, lastError: 'API rate limit exceeded' });
    expect(workItems.numberPending).not.toHaveBeenCalled();
    expect(store.state.numbers.size).toBe(0);

    gh.failing.clear();
    gh.asked.length = 0;
    await backfill.run();

    // Only the page it stopped on, then the rest.
    expect(gh.asked.filter((line) => line.startsWith('acme/app issues') && !line.endsWith('since'))).toEqual(['acme/app issues 3']);
    expect(workItems.numberPending).toHaveBeenCalledTimes(1);
    const n = (key: string) => store.state.numbers.get(key);
    expect([n('app#1'), n('api#1'), n('app#2'), n('api#2'), n('req-1'), n('app#3'), n('app#4')]).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // Every issue has its number; a pull request is with its branch's issue or the one it closes, else alone.
    expect(store.state.numbers.size).toBe(250 + 3 + 2 + 1);
    expect(n('app#251')).toBe(n('app#3'));
    expect(n('app#252')).toBe(n('app#5'));
    expect(n('app#253')).toBe(Math.max(...store.state.numbers.values()));
    expect(gh.refused).toEqual([]);
  });

  it('numbers a repository added later after everything numbered already', async () => {
    store.state.repos = [{ id: 'r-app', name: 'app', fullName: 'acme/app', defaultBranch: 'main' }];
    const gh = github({
      'acme/app': { issues: [{ number: 1, createdAt: day(5) }], pulls: [] },
      'acme/old': { issues: [{ number: 1, createdAt: day(1) }], pulls: [] },
    });
    const backfill = new WorkItemBackfill(async () => gh.client as never);
    await backfill.run();
    expect(store.state.numbers.get('app#1')).toBe(1);

    store.state.repos.push({ id: 'r-old', name: 'old', fullName: 'acme/old', defaultBranch: 'main' });
    await backfill.run();
    // Opened first, numbered after.
    expect(store.state.numbers.get('old#1')).toBe(2);
    expect(gh.refused).toEqual([]);
  });

  it('numbers nothing until every repository is read', async () => {
    store.state.repos = [
      { id: 'r-app', name: 'app', fullName: 'acme/app', defaultBranch: 'main' },
      { id: 'r-api', name: 'api', fullName: 'acme/api', defaultBranch: 'main' },
    ];
    const gh = github({ 'acme/app': { issues: [{ number: 1, createdAt: day(1) }], pulls: [] }, 'acme/api': { issues: [], pulls: [] } });
    gh.failing.add('acme/api issues 1');
    await new WorkItemBackfill(async () => gh.client as never).run();
    expect(store.state.progress.find((one) => one.repoId === 'r-app')?.readAt).not.toBeNull();
    expect(workItems.numberPending).not.toHaveBeenCalled();
  });
});
