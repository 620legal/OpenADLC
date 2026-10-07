import type { CiUsageRow } from '@fleetadlc/db';
import { describe, expect, it, vi } from 'vitest';
import { billedMinutes, capReason, everyJob, monthStart, parseCap, recordRun, runnerRate, summarize, type RunJob } from './ci-usage.js';

const job = (seconds: number, extra: Partial<RunJob> = {}): RunJob => ({
  status: 'completed',
  conclusion: 'success',
  started_at: '2026-10-03T10:00:00Z',
  completed_at: new Date(Date.parse('2026-10-03T10:00:00Z') + seconds * 1000).toISOString(),
  labels: ['ubuntu-24.04'],
  ...extra,
});

describe('a run’s minutes, as GitHub bills them', () => {
  it('rounds each job up to a whole minute, so four short jobs are four minutes and not one', () => {
    // This repository's CI before it ran less: check 6, integration 3, cloud 1, ci 1.
    expect(billedMinutes([job(356), job(184), job(11), job(4)])).toBe(6 + 4 + 1 + 1);
  });

  it('counts nothing for a job that was skipped or never started', () => {
    expect(billedMinutes([job(0, { conclusion: 'skipped' }), job(30, { started_at: null }), job(0)])).toBe(0);
  });

  it('bills a runner at its rate: Windows twice, macOS ten times', () => {
    expect(runnerRate(['windows-latest'])).toBe(2);
    expect(runnerRate(['macos-14'])).toBe(10);
    expect(runnerRate(['ubuntu-24.04', 'self-hosted'])).toBe(1);
    expect(billedMinutes([job(61, { labels: ['macos-14'] })])).toBe(20);
  });

  it('counts nothing for a job on a self-hosted runner, which GitHub does not bill as its own', () => {
    expect(billedMinutes([job(120, { labels: ['self-hosted', 'linux', 'x64'], runner_group_name: 'Default' }), job(30)])).toBe(1);
  });
});

const row = (over: Partial<CiUsageRow>): CiUsageRow => ({
  repoId: 'r1',
  repoName: 'api',
  runId: 1,
  runAttempt: 1,
  workflow: 'ci',
  event: 'pull_request',
  headBranch: 'agent/builder/7',
  prNumber: 7,
  conclusion: 'success',
  minutes: 8,
  billed: true,
  completedAt: '2026-10-03T10:00:00Z',
  ...over,
});

describe('the month, beside the model’s spend', () => {
  const since = new Date('2026-10-01T00:00:00Z');

  it('adds up minutes by repository and by pull request, and prices only what is billed', () => {
    const summary = summarize(
      [
        row({ runId: 1, minutes: 8 }),
        row({ runId: 1, runAttempt: 2, minutes: 6 }),
        row({ runId: 2, prNumber: null, event: 'push', minutes: 2 }),
        row({ runId: 3, repoName: 'site', repoId: 'r2', prNumber: 4, minutes: 30, billed: false }),
      ],
      { since, cap: null },
    );
    expect(summary).toMatchObject({ minutes: 46, billedMinutes: 16, estimatedUsd: 0.1, runs: 4, cap: null, capReached: null });
    expect(summary.byRepo).toEqual([
      { repo: 'site', minutes: 30, billedMinutes: 0, runs: 1 },
      { repo: 'api', minutes: 16, billedMinutes: 16, runs: 3 },
    ]);
    expect(summary.byPullRequest).toEqual([
      { repo: 'site', prNumber: 4, minutes: 30, runs: 1 },
      { repo: 'api', prNumber: 7, minutes: 14, runs: 2 },
    ]);
  });

  it('starts the month on the first, in UTC, as GitHub’s billing does', () => {
    expect(monthStart(new Date('2026-10-31T23:30:00-05:00')).toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });
});

describe('the cap a person sets', () => {
  it('holds once billed minutes reach it, and says why and what to do', () => {
    expect(capReason(1_999, 2_000)).toBeNull();
    expect(capReason(2_000, 2_000)).toBe(
      'GitHub Actions minutes this month reached the cap of 2,000 (2,000 used): no more CI is asked for until it is raised in Costs, or the month turns',
    );
    expect(capReason(50_000, null)).toBeNull();
  });

  it('reads only a whole number as a cap, and anything else as none', () => {
    expect(parseCap('3000')).toBe(3000);
    expect(parseCap('0')).toBe(0);
    for (const none of [null, undefined, '', ' ', '-5', '2.5', 'lots']) expect(parseCap(none)).toBeNull();
  });
});

describe('counting a completed run', () => {
  function deps(jobs: RunJob[] = [job(90)]) {
    return {
      repo: vi.fn(async (name: string) => (name === 'api' ? { id: 'r1' } : null)),
      jobs: vi.fn(async () => jobs),
      record: vi.fn(async () => undefined),
    };
  }
  const delivery = (over: Record<string, unknown> = {}, repository: Record<string, unknown> = {}) => ({
    action: 'completed',
    repository: { name: 'api', full_name: 'exampleco/api', private: true, ...repository },
    workflow_run: { id: 4242, name: 'ci', run_attempt: 2, event: 'pull_request', head_branch: 'agent/builder/7', conclusion: 'failure', updated_at: '2026-10-03T10:05:00Z', pull_requests: [{ number: 7 }], ...over },
  });

  it('reads the jobs of that attempt and writes its minutes', async () => {
    const d = deps([job(90), job(20)]);
    expect(await recordRun(d, delivery())).toBeNull();
    expect(d.jobs).toHaveBeenCalledWith('exampleco/api', 4242, 2);
    expect(d.record).toHaveBeenCalledWith({
      repoId: 'r1',
      runId: 4242,
      runAttempt: 2,
      workflow: 'ci',
      event: 'pull_request',
      headBranch: 'agent/builder/7',
      prNumber: 7,
      conclusion: 'failure',
      minutes: 3,
      billed: true,
      completedAt: '2026-10-03T10:05:00Z',
    });
  });

  it('counts a public repository’s minutes as free', async () => {
    const d = deps();
    await recordRun(d, delivery({}, { private: false }));
    expect(d.record).toHaveBeenCalledWith(expect.objectContaining({ billed: false }));
  });

  it('counts a larger runner as billed, even in a public repository', async () => {
    const d = deps([job(60, { labels: ['ubuntu-latest-8-cores'], runner_group_name: 'Default Larger Runners' })]);
    await recordRun(d, delivery({}, { private: false }));
    expect(d.record).toHaveBeenCalledWith(expect.objectContaining({ minutes: 1, billed: true }));
  });

  it('counts only a completed run, of a repository OpenADLC works in', async () => {
    const d = deps();
    await recordRun(d, { ...delivery(), action: 'requested' });
    await recordRun(d, delivery({}, { name: 'elsewhere' }));
    expect(d.record).not.toHaveBeenCalled();
  });

  it('says what it could not count, and never throws into the delivery', async () => {
    const d = deps();
    d.jobs.mockRejectedValueOnce(new Error('/repos/exampleco/api/actions/runs/4242/attempts/2/jobs → 403'));
    expect(await recordRun(d, delivery())).toBe('api: the minutes of run 4242 were not counted: /repos/exampleco/api/actions/runs/4242/attempts/2/jobs → 403');
    expect(d.record).not.toHaveBeenCalled();
  });
});

describe('a run’s jobs, as they are read', () => {
  it('are every page of them, so a matrix of more than a hundred is counted whole', async () => {
    const asked: string[] = [];
    const client = {
      request: async <T>(_method: string, path: string): Promise<T> => {
        asked.push(path);
        const page = Number(new URL(path, 'https://api.github.com').searchParams.get('page'));
        return { total_count: 130, jobs: Array.from({ length: page === 1 ? 100 : 30 }, () => job(60)) } as T;
      },
    };

    const jobs = await everyJob(client, 'exampleco/testbed', 7, 2);

    expect(jobs).toHaveLength(130);
    expect(asked).toEqual([
      '/repos/exampleco/testbed/actions/runs/7/attempts/2/jobs?per_page=100&page=1',
      '/repos/exampleco/testbed/actions/runs/7/attempts/2/jobs?per_page=100&page=2',
    ]);
  });
});
