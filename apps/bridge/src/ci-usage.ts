import type { CiUsageRow } from '@fleetadlc/db';

/**
 * The GitHub Actions minutes the crew's work costs a repository, counted as
 * GitHub bills them, shown beside the model's spend, and capped if a person
 * says so.
 *
 * The model's spend was counted to the cent and capped; the CI runs the work
 * set off were not counted at all, and they are each repository's own bill.
 * An install of this project ran past its Actions spending limit in an hour of
 * crew branches (2026-09-30), and nothing in the console had said it was close.
 *
 * Minutes are read from a run's jobs when GitHub says the run completed, any
 * workflow, any event: each job's time rounded up to a whole minute, times its
 * runner's rate. A public repository's standard runners are free, so its
 * minutes are counted and not billed. What a plan includes for free is not
 * known here, so the dollars are an estimate at GitHub's list price for a Linux
 * runner and say so.
 */

/**
 * GitHub's list price for a minute of its standard 2-core Linux runner, before
 * any minutes a plan includes, as GitHub's "Actions runner pricing" page gave
 * it on 2026-10-04. Check it there before relying on the dollars.
 */
export const USD_PER_LINUX_MINUTE = 0.006;

/** A job as `GET /repos/{repo}/actions/runs/{id}/attempts/{n}/jobs` lists it. */
export interface RunJob {
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  labels?: string[];
  /** "GitHub Actions" for GitHub's standard runners; a larger runner's or a self-hosted one's group otherwise. */
  runner_group_name?: string | null;
}

/** GitHub's own group for its standard hosted runners. */
const STANDARD_RUNNER_GROUP = 'GitHub Actions';

/**
 * Where a job ran. A self-hosted runner is the repository's own machine, and
 * GitHub's runner prices are not for it; counted as billed, a repository that
 * runs CI on its own runners reached the cap and had its CI held for minutes
 * that cost nothing. A larger runner is GitHub's, outside its standard group,
 * and billed even for a public repository.
 */
export function runnerKind(job: Pick<RunJob, 'labels' | 'runner_group_name'>): 'standard' | 'larger' | 'self-hosted' {
  if ((job.labels ?? []).some((label) => label.toLowerCase() === 'self-hosted')) return 'self-hosted';
  if (job.runner_group_name && job.runner_group_name !== STANDARD_RUNNER_GROUP) return 'larger';
  return 'standard';
}

/**
 * Every job of one attempt of a run, however many pages that is. It was one
 * page of a hundred, so a matrix of more was under-counted and the month's cap
 * held late.
 */
export async function everyJob(
  client: { request<T>(method: string, path: string): Promise<T> },
  repoFullName: string,
  runId: number,
  attempt: number,
): Promise<RunJob[]> {
  const jobs: RunJob[] = [];
  // Twenty pages is two thousand jobs; GitHub stops a matrix at 256.
  for (let page = 1; page <= 20; page += 1) {
    const listed = await client.request<{ total_count?: number; jobs?: RunJob[] }>(
      'GET',
      `/repos/${repoFullName}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
    );
    const these = listed.jobs ?? [];
    jobs.push(...these);
    if (these.length < 100 || (listed.total_count !== undefined && jobs.length >= listed.total_count)) break;
  }
  return jobs;
}

/**
 * A runner's minute in Linux minutes, from its labels: Windows twice, macOS ten
 * times. GitHub once billed included minutes this way; it now prices each
 * runner in dollars (on 2026-10-04: Linux $0.006, Windows $0.010, macOS $0.062
 * a minute), which these still roughly follow, so the dollar estimate is high
 * by about a fifth for a Windows minute.
 */
export function runnerRate(labels: readonly string[] = []): number {
  const said = labels.join(' ').toLowerCase();
  if (said.includes('macos')) return 10;
  if (said.includes('windows')) return 2;
  return 1;
}

/**
 * A run's minutes as GitHub bills them: each job that ran on GitHub's runners,
 * rounded up to a whole minute, times its rate. A self-hosted job is not counted.
 */
export function billedMinutes(jobs: readonly RunJob[]): number {
  let minutes = 0;
  for (const job of jobs) {
    if (job.conclusion === 'skipped' || !job.started_at || !job.completed_at) continue;
    if (runnerKind(job) === 'self-hosted') continue;
    const ms = new Date(job.completed_at).getTime() - new Date(job.started_at).getTime();
    if (!(ms > 0)) continue;
    minutes += Math.ceil(ms / 60_000) * runnerRate(job.labels);
  }
  return minutes;
}

/** The first of the month `now` is in, UTC, as GitHub's billing month starts. */
export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export interface CiSummary {
  since: string;
  minutes: number;
  billedMinutes: number;
  /** At the Linux list price, before what a plan includes: an estimate. */
  estimatedUsd: number;
  runs: number;
  byRepo: { repo: string; minutes: number; billedMinutes: number; runs: number }[];
  /** The pull requests whose runs took most, most first. */
  byPullRequest: { repo: string; prNumber: number; minutes: number; runs: number }[];
  /** The cap a person set, in billed minutes a month; null for none. */
  cap: number | null;
  /** Why the merge line asks for no more CI, or null. */
  capReached: string | null;
}

export function summarize(rows: readonly CiUsageRow[], options: { since: Date; cap: number | null }): CiSummary {
  const repos = new Map<string, { minutes: number; billedMinutes: number; runs: number }>();
  const pulls = new Map<string, { repo: string; prNumber: number; minutes: number; runs: number }>();
  let minutes = 0;
  let billed = 0;
  for (const row of rows) {
    minutes += row.minutes;
    if (row.billed) billed += row.minutes;
    const repo = repos.get(row.repoName) ?? { minutes: 0, billedMinutes: 0, runs: 0 };
    repo.minutes += row.minutes;
    if (row.billed) repo.billedMinutes += row.minutes;
    repo.runs += 1;
    repos.set(row.repoName, repo);
    if (row.prNumber !== null) {
      const key = `${row.repoName}#${row.prNumber}`;
      const pull = pulls.get(key) ?? { repo: row.repoName, prNumber: row.prNumber, minutes: 0, runs: 0 };
      pull.minutes += row.minutes;
      pull.runs += 1;
      pulls.set(key, pull);
    }
  }
  return {
    since: options.since.toISOString(),
    minutes,
    billedMinutes: billed,
    estimatedUsd: Math.round(billed * USD_PER_LINUX_MINUTE * 100) / 100,
    runs: rows.length,
    byRepo: [...repos.entries()].map(([repo, used]) => ({ repo, ...used })).sort((a, b) => b.minutes - a.minutes),
    byPullRequest: [...pulls.values()].sort((a, b) => b.minutes - a.minutes).slice(0, 10),
    cap: options.cap,
    capReached: capReason(billed, options.cap),
  };
}

/** Why no more CI is asked for this month, or null while under the cap or with none. */
export function capReason(billedThisMonth: number, cap: number | null): string | null {
  if (cap === null || billedThisMonth < cap) return null;
  return `GitHub Actions minutes this month reached the cap of ${cap.toLocaleString('en-US')} (${billedThisMonth.toLocaleString('en-US')} used): no more CI is asked for until it is raised in Costs, or the month turns`;
}

/** The cap as stored: a whole number of minutes, or null for none. */
export function parseCap(stored: string | null | undefined): number | null {
  if (stored === null || stored === undefined || stored.trim() === '') return null;
  const cap = Number(stored);
  return Number.isInteger(cap) && cap >= 0 ? cap : null;
}

/** A workflow run as a `workflow_run` delivery carries it: what this reads of it. */
export interface CompletedRun {
  id: number;
  name: string;
  run_attempt?: number;
  event?: string;
  head_branch?: string | null;
  conclusion?: string | null;
  updated_at?: string;
  pull_requests?: { number: number }[];
}

export interface CiUsageDeps {
  repo(name: string): Promise<{ id: string } | null>;
  /** The jobs of one attempt of a run, as GitHub lists them. */
  jobs(repoFullName: string, runId: number, attempt: number): Promise<RunJob[]>;
  record(row: Omit<CiUsageRow, 'repoName'>): Promise<void>;
  now?(): Date;
}

/** Writes a completed run's minutes. Never throws: a count that could not be made is said and left. */
export async function recordRun(
  deps: CiUsageDeps,
  delivery: { action?: string; repository?: { name?: string; full_name?: string; private?: boolean }; workflow_run?: CompletedRun },
): Promise<string | null> {
  const run = delivery.workflow_run;
  const name = delivery.repository?.name;
  const fullName = delivery.repository?.full_name;
  if (delivery.action !== 'completed' || !run || !name || !fullName) return null;
  try {
    const repo = await deps.repo(name);
    if (!repo) return null;
    const attempt = run.run_attempt ?? 1;
    const jobs = await deps.jobs(fullName, run.id, attempt);
    const minutes = billedMinutes(jobs);
    await deps.record({
      repoId: repo.id,
      runId: run.id,
      runAttempt: attempt,
      workflow: run.name,
      event: run.event ?? null,
      headBranch: run.head_branch ?? null,
      prNumber: run.pull_requests?.[0]?.number ?? null,
      conclusion: run.conclusion ?? null,
      minutes,
      // A public repository's standard runners cost nothing; one GitHub did not
      // say is counted as billed, which over-counts rather than under. A run
      // with a larger runner is billed wherever it ran.
      billed: delivery.repository?.private !== false || jobs.some((job) => runnerKind(job) === 'larger'),
      completedAt: run.updated_at ?? (deps.now?.() ?? new Date()).toISOString(),
    });
    return null;
  } catch (error) {
    return `${name}: the minutes of run ${run.id} were not counted: ${error instanceof Error ? error.message : error}`;
  }
}
