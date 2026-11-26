import type { JobLog } from '@openadlc/github';
import { describe, expect, it } from 'vitest';
import { asGetter, ciFailureOf, EXCERPT_LINES, failingExcerpt, failingJobsOf, type GitHubReads } from './ci-failure.js';

/** A GitHub that answers GETs from a table and records every path asked. */
function fakeReads(table: Record<string, unknown>, logs: Record<number, JobLog> = {}): GitHubReads & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    get: async <T>(path: string): Promise<T> => {
      asked.push(path);
      const key = Object.keys(table).find((one) => path === one || path.startsWith(`${one}?`) || path.split('?')[0] === one);
      const answer = key === undefined ? undefined : table[key];
      if (answer === undefined) throw Object.assign(new Error(`no fixture for ${path}`), { status: 404 });
      if (answer instanceof Error) throw answer;
      return answer as T;
    },
    jobLog: async (repo, id) => {
      asked.push(`log:${repo}:${id}`);
      return logs[id] ?? { missing: 'expired' };
    },
  };
}

const LOG = [
  '2026-11-20T10:00:00.1000000Z ##[group]Run pnpm install',
  '2026-11-20T10:00:01.0000000Z installed',
  '2026-11-20T10:00:02.0000000Z ##[endgroup]',
  '2026-11-20T10:00:05.0000000Z ##[group]Run make ci',
  ...Array.from({ length: 30 }, (_, i) => `2026-11-20T10:00:06.${String(i).padStart(7, '0')}Z line ${i}`),
  '2026-11-20T10:00:07.0000000Z token was ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  '2026-11-20T10:00:08.0000000Z ##[error]Process completed with exit code 1.',
  '2026-11-20T10:00:09.0000000Z after the error',
  '2026-11-20T10:00:20.0000000Z ##[group]Post job cleanup',
].join('\n');

const STEP = { started_at: '2026-11-20T10:00:05Z', completed_at: '2026-11-20T10:00:09Z' };

describe('failingExcerpt', () => {
  it('takes at most 20 lines of the step ending at its first error, without stamps or markup, redacted', () => {
    const lines = failingExcerpt(LOG, STEP);
    expect(lines).toHaveLength(EXCERPT_LINES);
    expect(lines.at(-1)).toBe('Process completed with exit code 1.');
    expect(lines.at(-2)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(lines.join('\n')).not.toMatch(/2026-11-20T/);
    expect(lines.join('\n')).not.toContain('installed');
    expect(lines.join('\n')).not.toContain('after the error');
  });

  it('takes the window from the step start, inclusive to the second', () => {
    const short = ['2026-11-20T10:00:04.9Z before', '2026-11-20T10:00:05.5Z ##[group]Run x', '2026-11-20T10:00:06.0Z ##[error]boom'].join('\n');
    expect(failingExcerpt(short, STEP)).toEqual(['Run x', 'boom']);
  });

  it("takes the window's last 20 lines when there is no error line", () => {
    const log = Array.from({ length: 40 }, (_, i) => `2026-11-20T10:00:06.0Z n${i}`).join('\n');
    const lines = failingExcerpt(log, STEP);
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe('n20');
    expect(lines.at(-1)).toBe('n39');
  });
});

describe('failingJobsOf', () => {
  it("names the jobs that did their own work before the gathering ci, and ci alone when it alone failed", () => {
    const jobs = [
      { name: 'check', conclusion: 'failure' },
      { name: 'ci', conclusion: 'failure' },
      { name: 'docs', conclusion: 'success' },
    ];
    expect(failingJobsOf(jobs).map((job) => job.name)).toEqual(['check']);
    expect(failingJobsOf([{ name: 'ci (after approval)', conclusion: 'failure' }]).map((job) => job.name)).toEqual(['ci (after approval)']);
    expect(failingJobsOf([{ name: 'check', conclusion: 'cancelled' }])).toEqual([]);
  });
});

describe('asGetter', () => {
  it('refuses anything but a GET', async () => {
    const reads = fakeReads({ '/x': { ok: true } });
    await expect(asGetter(reads).request('POST', '/x')).rejects.toThrow(/never writes/);
    expect(reads.asked).toEqual([]);
  });
});

describe('ciFailureOf', () => {
  const RUNS = '/repos/acme/api/actions/runs';
  const red = (conclusion: string, status = 'completed') => ({
    [RUNS]: { workflow_runs: [{ id: 9, name: 'ci', run_attempt: 2, status, conclusion }] },
    '/repos/acme/api/actions/runs/9/attempts/2/jobs': {
      total_count: 2,
      jobs: [
        { id: 31, name: 'check', conclusion: 'failure', status: 'completed', html_url: 'https://github.com/acme/api/actions/runs/9/job/31', steps: [{ name: 'setup', conclusion: 'success' }, { name: 'make ci', conclusion: 'failure', ...STEP }] },
        { id: 32, name: 'ci', conclusion: 'failure', status: 'completed', steps: [] },
      ],
    },
  });

  it('names the failing job, its step and its excerpt', async () => {
    const reads = fakeReads(red('failure'), { 31: { text: LOG } });
    const failure = await ciFailureOf(reads, 'acme/api', 'a'.repeat(40));
    expect(failure.state).toBe('red');
    if (failure.state !== 'red') return;
    expect(failure.jobs).toHaveLength(1);
    expect(failure.jobs[0]).toMatchObject({ name: 'check', step: 'make ci', url: 'https://github.com/acme/api/actions/runs/9/job/31', excerptMissing: null });
    expect(failure.jobs[0]!.excerpt!.at(-1)).toBe('Process completed with exit code 1.');
    expect(failure.runUrl).toBe('https://github.com/acme/api/actions/runs/9/attempts/2');
  });

  it('says the log is missing and why, keeping the job link', async () => {
    const reads = fakeReads(red('failure'));
    const failure = await ciFailureOf(reads, 'acme/api', 'a'.repeat(40));
    expect(failure).toMatchObject({ state: 'red', jobs: [{ name: 'check', excerpt: null, excerptMissing: 'expired', url: 'https://github.com/acme/api/actions/runs/9/job/31' }] });
  });

  it('is green, running or none without reading a log', async () => {
    const green = fakeReads(red('success'));
    expect((await ciFailureOf(green, 'acme/api', 'a'.repeat(40))).state).toBe('green');
    expect(green.asked.some((path) => path.startsWith('log:'))).toBe(false);
    expect((await ciFailureOf(fakeReads(red('', 'in_progress')), 'acme/api', 'a'.repeat(40))).state).toBe('running');
    expect(await ciFailureOf(fakeReads({ [RUNS]: { workflow_runs: [] } }), 'acme/api', 'a'.repeat(40))).toEqual({ state: 'none' });
  });

  it('says GitHub could not be reached', async () => {
    const failure = await ciFailureOf(fakeReads({ [RUNS]: Object.assign(new Error('Bad credentials'), { status: 401 }) }), 'acme/api', 'a'.repeat(40));
    expect(failure).toEqual({ state: 'unreachable', reason: 'GitHub answered 401: Bad credentials' });
  });
});
