import { describe, expect, it } from 'vitest';
import type { GitHubReads } from './ci-failure.js';
import { checksViewOf, ChecksViews, MAX_JOB_READS, rankChecks, type CheckRow, type ChecksRecords, type ChecksRepo, type ChecksView } from './checks-view.js';

const REPO: ChecksRepo = { id: 'r1', name: 'api', fullName: 'acme/api', defaultBranch: 'main' };
const R = '/repos/acme/api';

const WORKFLOW = `name: ci
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm install
      - run: make ci
  integration:
    runs-on: ubuntu-latest
    steps:
      - run: node tests/all.mjs
  ci:
    name: \${{ github.event.pull_request.draft && 'ci (draft)' || 'ci' }}
    needs: [check, integration]
    steps:
      - run: echo ok
`;
const MAKEFILE = 'ci:\n\tpnpm test\n';

const b64 = (text: string) => ({ content: Buffer.from(text).toString('base64'), encoding: 'base64' });
const sha = (c: string) => c.repeat(40);

type J = { id: number; name: string; conclusion: string; completed_at?: string; html_url?: string };
const job = (id: number, name: string, conclusion: string, at = '2026-11-20T10:00:00Z'): J => ({ id, name, conclusion, completed_at: at, html_url: `https://github.com/acme/api/actions/runs/x/job/${id}` });
const jobs = (list: J[]) => ({ total_count: list.length, jobs: list.map((one) => ({ status: 'completed', started_at: null, ...one })) });

/**
 * Head A: integration failed in attempt 1 and passed in attempt 2, with the
 * gathering ci failing beside it. Head B: check failed in two runs and never
 * passed. Head C: integration failed in one run and passed in a second, later.
 */
function history(): Record<string, unknown> {
  return {
    [`${R}/actions/workflows?per_page=100`]: { workflows: [{ id: 7, name: 'ci', path: '.github/workflows/ci.yml' }, { id: 8, name: 'deploy', path: '.github/workflows/deploy.yml' }] },
    [`${R}/contents/.github/workflows/ci.yml?ref=main`]: b64(WORKFLOW),
    [`${R}/contents/Makefile?ref=main`]: b64(MAKEFILE),
    [`${R}/actions/workflows/7/runs?per_page=30`]: {
      workflow_runs: [
        { id: 105, head_sha: sha('c'), run_attempt: 1, status: 'completed', conclusion: 'success' },
        { id: 104, head_sha: sha('c'), run_attempt: 1, status: 'completed', conclusion: 'failure' },
        { id: 103, head_sha: sha('b'), run_attempt: 1, status: 'completed', conclusion: 'failure' },
        { id: 102, head_sha: sha('b'), run_attempt: 1, status: 'completed', conclusion: 'failure' },
        { id: 101, head_sha: sha('a'), run_attempt: 2, status: 'completed', conclusion: 'success' },
        { id: 100, head_sha: sha('d'), run_attempt: 1, status: 'completed', conclusion: 'success' },
      ],
    },
    [`${R}/actions/workflows/7/runs?branch=main&event=push&per_page=5`]: {
      workflow_runs: [{ id: 100, head_sha: sha('d'), run_attempt: 1, status: 'completed', conclusion: 'success', html_url: 'https://github.com/acme/api/actions/runs/100' }],
    },
    [`${R}/actions/runs/101/attempts/1/jobs`]: jobs([job(1, 'check', 'success'), job(2, 'integration', 'failure'), job(3, 'ci', 'failure')]),
    [`${R}/actions/runs/101/attempts/2/jobs`]: jobs([job(4, 'check', 'success'), job(5, 'integration', 'success', '2026-11-20T11:00:00Z'), job(6, 'ci', 'success')]),
    [`${R}/actions/runs/102/attempts/1/jobs`]: jobs([job(7, 'check', 'failure'), job(8, 'ci', 'failure')]),
    [`${R}/actions/runs/103/attempts/1/jobs`]: jobs([job(9, 'check', 'failure'), job(10, 'ci', 'failure')]),
    [`${R}/actions/runs/104/attempts/1/jobs`]: jobs([job(11, 'check', 'success'), job(12, 'integration', 'failure'), job(13, 'ci', 'failure')]),
    [`${R}/actions/runs/105/attempts/1/jobs`]: jobs([job(14, 'check', 'success'), job(15, 'integration', 'success', '2026-11-21T09:00:00Z'), job(16, 'ci', 'success')]),
    [`${R}/actions/runs/100/attempts/1/jobs`]: jobs([job(17, 'check', 'success'), job(18, 'integration', 'skipped'), job(19, 'ci', 'success')]),
    [`${R}/commits/${sha('d')}/pulls`]: [{ number: 41 }],
  };
}

/** A GitHub that answers GETs from a table, exact path first, and records each one. */
function fakeReads(table: Record<string, unknown>): GitHubReads & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    get: async <T>(path: string): Promise<T> => {
      asked.push(path);
      const answer = path in table ? table[path] : table[path.split('?')[0]!] ?? table[path.replace(/&page=\d+$/, '').replace(/\?per_page=100&page=\d+$/, '')];
      if (answer === undefined) throw Object.assign(new Error('Not Found'), { status: 404 });
      if (answer instanceof Error) throw answer;
      return answer as T;
    },
    jobLog: async () => ({ missing: 'expired' }),
  };
}

function records(over: Partial<ChecksRecords> = {}): ChecksRecords {
  return {
    hostCheck: async () => null,
    hostCheckRun: async () => null,
    localCi: async () => null,
    ...over,
  };
}

const row = (view: ChecksView, key: string): CheckRow => view.rows.find((one) => one.key === key)!;

describe('checksViewOf', () => {
  it('ranks a job that failed then passed on the same head first, with its heads, and not one that only failed, nor the gathering ci', async () => {
    const view = await checksViewOf(REPO, fakeReads(history()), records());
    expect(view.rows.map((one) => one.key)).toEqual(['integration', 'check', 'ci']);
    expect(row(view, 'integration').flaky).toEqual({
      count: 2,
      heads: [
        { sha: sha('c'), runUrl: 'https://github.com/acme/api/actions/runs/x/job/15', passedAt: '2026-11-21T09:00:00Z' },
        { sha: sha('a'), runUrl: 'https://github.com/acme/api/actions/runs/x/job/5', passedAt: '2026-11-20T11:00:00Z' },
      ],
    });
    expect(row(view, 'check').flaky).toBeNull();
    expect(row(view, 'ci').flaky).toBeNull();
    expect(view.flakes.state).toBe('read');
  });

  it('marks only the job that reaches make ci as covered', async () => {
    const view = await checksViewOf(REPO, fakeReads(history()), records());
    expect(row(view, 'check').covered).toBe(true);
    expect(row(view, 'integration').covered).toBe(false);
    expect(row(view, 'ci').covered).toBe(false);
    expect(view.rows.every((one) => one.runsOn === 'github')).toBe(true);
  });

  it('takes each last result from the newest completed default-branch push run', async () => {
    const view = await checksViewOf(REPO, fakeReads(history()), records());
    expect(row(view, 'check').last).toMatchObject({ result: 'pass', url: 'https://github.com/acme/api/actions/runs/x/job/17' });
    expect(row(view, 'integration').last.result).toBe('skipped');
    const table = history();
    table[`${R}/actions/runs/100/attempts/1/jobs`] = jobs([job(17, 'check', 'failure'), job(19, 'ci (after approval)', 'failure')]);
    const red = await checksViewOf(REPO, fakeReads(table), records());
    expect(row(red, 'check').last.result).toBe('fail');
    expect(row(red, 'ci').last.result).toBe('fail');
    expect(row(red, 'integration').last).toMatchObject({ result: 'none yet', url: null });
  });

  it('reads only with GETs, through the reads it is given', async () => {
    const reads = fakeReads(history());
    await checksViewOf(REPO, reads, records());
    expect(reads.asked.length).toBeGreaterThan(0);
    expect(reads.asked.every((path) => path.startsWith(`${R}/`))).toBe(true);
  });

  it("shows the host check last, from the bridge's record for the pull request behind the default branch", async () => {
    const asked: [string, number][] = [];
    const view = await checksViewOf(
      REPO,
      fakeReads(history()),
      records({
        hostCheck: async () => ({ command: 'make e2e' }),
        hostCheckRun: async (repoId, pr) => {
          asked.push([repoId, pr]);
          return { id: 'hc1', state: 'failed', startedAt: '2026-11-20T09:00:00Z', finishedAt: '2026-11-20T09:05:00Z' };
        },
      }),
    );
    expect(asked).toEqual([['r1', 41]]);
    const host = view.rows.at(-1)!;
    expect(host).toMatchObject({ key: 'host-check', runsOn: 'this machine', command: 'make e2e', last: { result: 'fail', url: '/host-checks/hc1' } });
    expect('covered' in host).toBe(false);
  });

  it('says none yet for the host check with no record, whatever a host-check status says', async () => {
    const table = history();
    // A status any token could set; the page never reads it.
    table[`${R}/commits/${sha('d')}/statuses`] = [{ context: 'host-check', state: 'success' }];
    const reads = fakeReads(table);
    const view = await checksViewOf(REPO, reads, records({ hostCheck: async () => ({ command: 'make e2e' }) }));
    expect(view.rows.at(-1)!.last.result).toBe('none yet');
    expect(reads.asked.some((path) => path.includes('/statuses') || path.includes('/status'))).toBe(false);
  });

  it('shows the local CI result on the default branch head', async () => {
    const view = await checksViewOf(REPO, fakeReads(history()), records({ localCi: async (_repo, head) => (head === sha('d') ? { ok: true, createdAt: '2026-11-20T08:00:00Z' } : null) }));
    expect(view.localCi).toEqual({ sha: sha('d'), ok: true, at: '2026-11-20T08:00:00Z' });
  });

  it('says partial when the job reads reach their cap', async () => {
    const table = history();
    table[`${R}/actions/workflows/7/runs?per_page=30`] = {
      workflow_runs: [{ id: 300, head_sha: sha('e'), run_attempt: MAX_JOB_READS + 1, status: 'completed', conclusion: 'success' }],
    };
    const view = await checksViewOf(REPO, fakeReads(table), records());
    expect(view.flakes.state).toBe('partial');
    expect(view.flakes.detail).toMatch(/Only part/);
  });

  it('says a missing workflow, and never shows an empty table as if all were fine', async () => {
    const table = history();
    table[`${R}/actions/workflows?per_page=100`] = { workflows: [] };
    const view = await checksViewOf(REPO, fakeReads(table), records());
    expect(view.workflow).toMatchObject({ state: 'missing', detail: 'No `ci` workflow on main' });
    expect(view.rows).toEqual([]);
  });

  it('says an unparseable workflow with its line, and builds rows from the run jobs, never covered', async () => {
    const table = history();
    table[`${R}/contents/.github/workflows/ci.yml?ref=main`] = b64('jobs:\n  a: [\n');
    const view = await checksViewOf(REPO, fakeReads(table), records());
    expect(view.workflow.state).toBe('unparseable');
    expect(view.workflow.detail).toMatch(/^The ci workflow could not be read: .*\(line \d+\)$/);
    expect(view.rows.map((one) => one.key).sort()).toEqual(['check', 'ci', 'integration']);
    expect(view.rows.every((one) => one.covered === 'unknown')).toBe(true);
    expect(view.rows[0]!.key).toBe('integration');
  });

  it('says GitHub could not be reached, and still shows the host check row', async () => {
    const down = fakeReads({});
    down.get = async () => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com');
    };
    const view = await checksViewOf(REPO, down, records({ hostCheck: async () => ({ command: 'make e2e' }) }));
    expect(view.workflow).toMatchObject({ state: 'unreachable', detail: 'getaddrinfo ENOTFOUND api.github.com' });
    expect(view.runs.state).toBe('unreachable');
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({ key: 'host-check', last: { result: 'none yet' } });
    const none = await checksViewOf(REPO, null, records());
    expect(none.workflow.detail).toMatch(/no GitHub account can read it/);
  });
});

describe('rankChecks', () => {
  const base = (key: string, flaky: CheckRow['flaky'] = null, runsOn: CheckRow['runsOn'] = 'github'): CheckRow => ({
    key,
    name: key,
    runsOn,
    last: { result: 'pass', url: null, at: null, detail: null },
    flaky,
  });
  it('ranks by heads, then the latest settling pass, then workflow order, the host check last', () => {
    const heads = (...at: string[]) => ({ count: at.length, heads: at.map((passedAt, i) => ({ sha: String(i), runUrl: '', passedAt })) });
    const ranked = rankChecks([
      base('host', null, 'this machine'),
      base('a'),
      base('b', heads('2026-01-01')),
      base('c', heads('2026-01-02')),
      base('d', heads('2025-01-01', '2025-01-02')),
      base('e'),
    ]);
    expect(ranked.map((one) => one.key)).toEqual(['d', 'c', 'b', 'a', 'e', 'host']);
  });
});

describe('ChecksViews', () => {
  it('keeps a view for a minute', async () => {
    let now = 0;
    let reads = 0;
    const views = new ChecksViews(async () => {
      reads += 1;
      return { readAt: String(reads) } as ChecksView;
    }, () => now);
    await views.of(REPO);
    now = 59_000;
    await views.of(REPO);
    expect(reads).toBe(1);
    now = 61_000;
    expect((await views.of(REPO)).readAt).toBe('2');
  });
});
