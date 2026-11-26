import type { GitHubClient, JobLog } from '@openadlc/github';
import { redactSecrets, REQUIRED_CHECK } from '@openadlc/shared';
import { CI_FAILED, everyJob, newestCiRun, type RunJob } from './ci-usage.js';

/**
 * Why a pull request's `ci` is red, on its item page: the failing job, its
 * step, and the first lines of the error. Finding out meant opening GitHub
 * Actions.
 *
 * Read-only by construction: it reads GitHub through `GitHubReads`, which can
 * only GET, and imports nothing that runs, reruns or decides
 * (docs/adr/0083-the-checks-page-reads-actions-and-the-bridges-records-and-writes-nothing.md).
 */

/**
 * What the Checks page and this section may do on GitHub: GET a REST path,
 * and read a job's log. Nothing that writes. Built from the automation
 * account's client by `githubReadsOf`.
 */
export interface GitHubReads {
  get<T>(path: string): Promise<T>;
  jobLog(repoFullName: string, jobId: number): Promise<JobLog>;
}

/** The only door from a client to these reads: `request('GET', …)` and `jobLog`, never a writer. */
export function githubReadsOf(client: Pick<GitHubClient, 'request' | 'jobLog'>): GitHubReads {
  return {
    get: <T>(path: string) => client.request<T>('GET', path),
    jobLog: (repoFullName, jobId) => client.jobLog(repoFullName, jobId),
  };
}

/** `newestCiRun` and `everyJob` take a client; this one can only GET. */
export function asGetter(reads: GitHubReads): { request<T>(method: string, path: string): Promise<T> } {
  return {
    request: <T>(method: string, path: string) => {
      if (method !== 'GET') return Promise.reject(new Error(`the Checks page reads GitHub and never writes: refused ${method} ${path}`));
      return reads.get<T>(path);
    },
  };
}

/** A step of a job, with the times its log lines are stamped within. */
export interface RunStep {
  name: string;
  conclusion: string | null;
  number?: number;
  started_at?: string | null;
  completed_at?: string | null;
}

/** A job as the attempt's jobs list gives it, with what the page links to. */
export type ActionsJob = Omit<RunJob, 'steps'> & { id?: number; html_url?: string | null; steps?: RunStep[] | null };

/** The most lines of an error the section shows. */
export const EXCERPT_LINES = 20;

/** The most failing jobs it names, as `failedAt` does. */
const MAX_FAILING_JOBS = 3;

export type ExcerptMissing = 'expired' | 'too_large' | 'unreachable' | 'no_lines';

export interface FailingJob {
  name: string;
  url: string | null;
  step: string | null;
  /** At most `EXCERPT_LINES` lines, redacted; null with `excerptMissing` saying why. */
  excerpt: string[] | null;
  excerptMissing: ExcerptMissing | null;
}

export type CiFailure =
  | { state: 'none' }
  | { state: 'running' | 'green'; headSha: string; runUrl: string }
  | { state: 'red'; headSha: string; runUrl: string; jobs: FailingJob[] }
  | { state: 'unreachable'; reason: string };

const STAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.\d+)?Z ?/;
// Colour codes a runner writes; they mean nothing in a <pre>.
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

function toSecond(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * The first lines of a step's error in its job's log. The lines stamped
 * within the step's start and end, to the second, inclusive; of them, the up
 * to `EXCERPT_LINES` ending at the first `##[error]`, or the last ones when
 * there is none. Timestamps and `##[group]`, `##[endgroup]` and `##[error]`
 * markup are taken off, and every line is redacted (`redactSecrets`), as
 * every log the console shows is. A step with no times reads the whole log.
 */
export function failingExcerpt(log: string, step: Pick<RunStep, 'started_at' | 'completed_at'> | null): string[] {
  const from = toSecond(step?.started_at);
  const to = toSecond(step?.completed_at);
  const window: { text: string; error: boolean }[] = [];
  let keeping = from === null;
  for (const raw of log.replace(/\r/g, '').split('\n')) {
    const stamp = STAMP.exec(raw);
    if (stamp) {
      const second = toSecond(`${stamp[1]}Z`);
      keeping = second === null || ((from === null || second >= from) && (to === null || second <= to));
    }
    if (!keeping) continue;
    let text = (stamp ? raw.slice(stamp[0].length) : raw).replace(ANSI, '');
    if (text.startsWith('##[endgroup]')) continue;
    const error = text.startsWith('##[error]');
    text = text.replace(/^##\[(group|error|warning|notice|debug)\]/, '');
    if (!stamp && !text.trim() && window.length === 0) continue;
    window.push({ text, error });
  }
  while (window.length > 0 && !window[window.length - 1]!.text.trim()) window.pop();
  const firstError = window.findIndex((line) => line.error);
  const picked = firstError >= 0 ? window.slice(Math.max(0, firstError - EXCERPT_LINES + 1), firstError + 1) : window.slice(-EXCERPT_LINES);
  return picked.map((line) => redactSecrets(line.text));
}

/**
 * The jobs a red attempt names, by `failedAt`'s rule (webhooks.ts): the
 * failed jobs that did their own work before the gathering `ci` job, which
 * fails only because one of them did; `ci` alone when nothing else failed.
 */
export function failingJobsOf<J extends Pick<RunJob, 'name' | 'conclusion'>>(jobs: readonly J[]): J[] {
  const failed = jobs.filter((job) => CI_FAILED.has(job.conclusion ?? ''));
  const ownWork = failed.filter((job) => !isGathering(job.name ?? ''));
  return (ownWork.length > 0 ? ownWork : failed).slice(0, MAX_FAILING_JOBS);
}

/** The gathering job, by the names it reports under: `ci`, `ci (draft)`, `ci (after approval)`. */
export function isGathering(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === REQUIRED_CHECK || lower.startsWith(`${REQUIRED_CHECK} (`);
}

function runUrlOf(repoFullName: string, runId: number, attempt: number): string {
  return `https://github.com/${repoFullName}/actions/runs/${runId}/attempts/${attempt}`;
}

/** Why GitHub could not be read, in words, redacted. */
export function unreachableReason(error: unknown): string {
  const status = (error as { status?: number } | null)?.status;
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(status ? `GitHub answered ${status}: ${message}` : message).slice(0, 300);
}

/**
 * What the newest `ci` run on a head says: nothing, still running, green, or
 * red with its failing jobs, each with its step and an excerpt of its log.
 */
export async function ciFailureOf(reads: GitHubReads, repoFullName: string, headSha: string): Promise<CiFailure> {
  const client = asGetter(reads);
  let run: Awaited<ReturnType<typeof newestCiRun>>;
  try {
    run = await newestCiRun(client, repoFullName, headSha);
  } catch (error) {
    return { state: 'unreachable', reason: unreachableReason(error) };
  }
  if (!run) return { state: 'none' };
  const runUrl = runUrlOf(repoFullName, run.id, run.attempt);
  if (run.status !== 'completed') return { state: 'running', headSha, runUrl };
  if (!CI_FAILED.has(run.conclusion ?? '')) return { state: 'green', headSha, runUrl };
  let jobs: ActionsJob[];
  try {
    jobs = (await everyJob(client, repoFullName, run.id, run.attempt)) as ActionsJob[];
  } catch (error) {
    return { state: 'unreachable', reason: unreachableReason(error) };
  }
  const failing: FailingJob[] = [];
  for (const job of failingJobsOf(jobs)) {
    const step = (job.steps ?? []).find((one) => CI_FAILED.has(one.conclusion ?? '')) ?? null;
    const base = { name: job.name ?? 'unnamed', url: job.html_url ?? runUrl, step: step?.name ?? null };
    if (job.id === undefined) {
      failing.push({ ...base, excerpt: null, excerptMissing: 'unreachable' });
      continue;
    }
    const log = await reads.jobLog(repoFullName, job.id).catch((): JobLog => ({ missing: 'unreachable' }));
    if ('missing' in log) {
      failing.push({ ...base, excerpt: null, excerptMissing: log.missing });
      continue;
    }
    const excerpt = failingExcerpt(log.text, step);
    failing.push(excerpt.length > 0 ? { ...base, excerpt, excerptMissing: null } : { ...base, excerpt: null, excerptMissing: 'no_lines' });
  }
  return { state: 'red', headSha, runUrl, jobs: failing };
}
