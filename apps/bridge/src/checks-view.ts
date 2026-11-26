import {
  coveredByLocalCi,
  jobOfRun,
  makeTargetsReached,
  noMakefileReach,
  parseCiWorkflow,
  REQUIRED_CHECK,
  type CiWorkflowJob,
  type MakeReach,
} from '@openadlc/shared';
import { asGetter, isGathering, unreachableReason, type ActionsJob, type GitHubReads } from './ci-failure.js';
import { CI_FAILED, everyJob } from './ci-usage.js';

/**
 * A repository's Checks page: what its `ci` workflow and its host check run,
 * where each runs, whether `make ci` covers it, its last result on the
 * default branch, and which jobs are flaky.
 *
 * It only reads: GitHub through `GitHubReads` (GETs and job logs), and the
 * bridge's own records through the functions it is given. It imports nothing
 * that runs a check, reruns one, starts a host check or decides a merge, and
 * `checks-routes.test.ts` holds it to that
 * (docs/adr/0083-the-checks-page-reads-actions-and-the-bridges-records-and-writes-nothing.md).
 * Flakiness is worked out from GitHub on every read and never stored.
 */

/** How many of the newest `ci` runs the flake scan reads, on any branch. */
export const FLAKE_RUNS = 30;

/** How many of the newest default-branch push runs are read for last results. */
const DEFAULT_RUNS = 5;

/** The most attempts' job lists one read of the page reads for flakes; past it the page says `partial`. */
export const MAX_JOB_READS = 40;

/** How long one repository's view is kept before GitHub is read again. */
export const CHECKS_CACHE_MS = 60_000;

export type CheckResult = 'pass' | 'fail' | 'skipped' | 'cancelled' | 'none yet';

export interface FlakyHead {
  sha: string;
  /** The run whose pass settled the flake. */
  runUrl: string;
  passedAt: string | null;
}

export interface CheckRow {
  key: string;
  name: string;
  runsOn: 'github' | 'this machine';
  /** Whether `make ci` covers it; `unknown` when the workflow was not read. Absent on the host check row, which is never marked. */
  covered?: boolean | 'unknown';
  last: { result: CheckResult; url: string | null; at: string | null; detail: string | null };
  flaky: { count: number; heads: FlakyHead[] } | null;
  /** The host check row's command. */
  command?: string;
}

export interface ReadState<S extends string> {
  state: S;
  detail: string | null;
}

export interface ChecksView {
  repo: string;
  fullName: string;
  defaultBranch: string;
  workflow: ReadState<'read' | 'missing' | 'unparseable' | 'unreachable'> & { path: string | null };
  makefile: ReadState<'read' | 'missing' | 'unreachable'>;
  runs: ReadState<'read' | 'unreachable'>;
  flakes: ReadState<'read' | 'partial' | 'unreachable'>;
  rows: CheckRow[];
  /** The local CI's newest result on the default branch's newest `ci` head; one result per head, not per job. */
  localCi: { sha: string; ok: boolean; at: string } | null;
  readAt: string;
}

export interface ChecksRepo {
  id: string;
  name: string;
  fullName: string;
  defaultBranch: string;
}

/** The bridge's own records the page reads. All reads. */
export interface ChecksRecords {
  hostCheck(repoId: string): Promise<{ command: string } | null>;
  /** `hostCheckRuns.latestFor`: the bridge's record, never the `host-check` status. */
  hostCheckRun(repoId: string, prNumber: number): Promise<{ id: string; state: string; finishedAt: string | null; startedAt: string } | null>;
  localCi(repoId: string, headSha: string): Promise<{ ok: boolean; createdAt: string } | null>;
}

interface WorkflowRun {
  id: number;
  name?: string | null;
  head_sha: string;
  run_attempt?: number;
  status: string;
  conclusion: string | null;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
}

/** What a scan of one head's attempts found for one job. */
interface Flake {
  key: string;
  heads: FlakyHead[];
}

/** A row's key for a run job's name: its workflow job's key, or the name with any ` (…)` taken off when the workflow was not read. */
function keyOf(name: string, jobs: readonly CiWorkflowJob[] | null): string | null {
  if (jobs) return jobOfRun(name, jobs)?.key ?? null;
  return name.replace(/ \(.*\)$/, '');
}

function resultOf(conclusions: readonly (string | null)[]): CheckResult {
  if (conclusions.length === 0) return 'none yet';
  if (conclusions.some((one) => CI_FAILED.has(one ?? ''))) return 'fail';
  if (conclusions.some((one) => one === 'cancelled')) return 'cancelled';
  if (conclusions.every((one) => one === 'skipped')) return 'skipped';
  if (conclusions.every((one) => one === 'success' || one === 'skipped' || one === 'neutral')) return 'pass';
  return 'none yet';
}

/**
 * Which jobs failed and then passed on the same head, from every attempt of
 * every run on heads that ran more than once. A job is flaky on a head when an
 * attempt has it failed (`CI_FAILED`) and a later attempt or run on that head
 * has it passed; cancelled and skipped never count. The gathering `ci` job
 * counts on a head only when it was the only job that failed in that attempt,
 * as `failedAt` names it, so a flaky `check` does not make `ci` flaky too.
 */
export async function flakesOf(
  reads: GitHubReads,
  repoFullName: string,
  runs: readonly WorkflowRun[],
  jobs: readonly CiWorkflowJob[] | null,
): Promise<{ flakes: Flake[]; partial: boolean }> {
  const client = asGetter(reads);
  const byHead = new Map<string, WorkflowRun[]>();
  for (const run of runs) byHead.set(run.head_sha, [...(byHead.get(run.head_sha) ?? []), run]);
  const found = new Map<string, Flake>();
  let jobReads = 0;
  let partial = false;
  // Newest heads first, so a cap leaves out the oldest.
  const heads = [...byHead.entries()]
    .filter(([, list]) => list.reduce((sum, run) => sum + (run.run_attempt ?? 1), 0) > 1)
    .sort(([, a], [, b]) => Math.max(...b.map((run) => run.id)) - Math.max(...a.map((run) => run.id)));
  for (const [sha, list] of heads) {
    const attempts: { run: WorkflowRun; attempt: number }[] = [];
    for (const run of [...list].sort((a, b) => a.id - b.id)) {
      for (let attempt = 1; attempt <= (run.run_attempt ?? 1); attempt += 1) attempts.push({ run, attempt });
    }
    // Stop rather than skip: skipping would read a smaller, older head after
    // leaving out a newer one, and the page says the oldest were left out.
    if (jobReads + attempts.length > MAX_JOB_READS) {
      partial = true;
      break;
    }
    jobReads += attempts.length;
    const failedBefore = new Set<string>();
    const settled = new Set<string>();
    for (const { run, attempt } of attempts) {
      const attemptJobs = (await everyJob(client, repoFullName, run.id, attempt)) as ActionsJob[];
      const failedOwn = attemptJobs.filter((job) => CI_FAILED.has(job.conclusion ?? '') && !isGathering(job.name ?? ''));
      // Per row, not per job: a matrix's legs share a row, and one leg
      // failing beside another passing in the same attempt is no flake.
      const inAttempt = new Map<string, { failed: boolean; passed: boolean; url: string | null; at: string | null }>();
      for (const job of attemptJobs) {
        const key = keyOf(job.name ?? '', jobs);
        if (key === null) continue;
        const entry = inAttempt.get(key) ?? { failed: false, passed: true, url: null, at: null };
        if (CI_FAILED.has(job.conclusion ?? '')) {
          entry.passed = false;
          if (!(isGathering(job.name ?? '') && failedOwn.length > 0)) entry.failed = true;
        } else if (job.conclusion !== 'success') {
          entry.passed = false;
        } else {
          entry.url = job.html_url ?? entry.url;
          entry.at = [entry.at ?? '', job.completed_at ?? ''].sort().at(-1) || null;
        }
        inAttempt.set(key, entry);
      }
      for (const [key, entry] of inAttempt) {
        if (entry.passed && failedBefore.has(key) && !settled.has(key)) {
          settled.add(key);
          const flake = found.get(key) ?? { key, heads: [] };
          flake.heads.push({ sha, runUrl: entry.url ?? run.html_url ?? `https://github.com/${repoFullName}/actions/runs/${run.id}`, passedAt: entry.at ?? run.updated_at ?? null });
          found.set(key, flake);
        }
      }
      for (const [key, entry] of inAttempt) if (entry.failed) failedBefore.add(key);
    }
  }
  for (const flake of found.values()) flake.heads.sort((a, b) => (b.passedAt ?? '').localeCompare(a.passedAt ?? ''));
  return { flakes: [...found.values()], partial };
}

/**
 * The rows in the page's order: flaky rows first, by how many heads flaked
 * (most first), then by the latest pass that settled one; the rest in
 * workflow order; the host check row last.
 */
export function rankChecks(rows: readonly CheckRow[]): CheckRow[] {
  const latest = (row: CheckRow): string => row.flaky?.heads.reduce((best, head) => ((head.passedAt ?? '') > best ? (head.passedAt ?? '') : best), '') ?? '';
  const flaky = rows.filter((row) => row.flaky && row.flaky.count > 0);
  const rest = rows.filter((row) => !(row.flaky && row.flaky.count > 0));
  flaky.sort((a, b) => b.flaky!.count - a.flaky!.count || latest(b).localeCompare(latest(a)));
  return [...flaky, ...rest.filter((row) => row.runsOn === 'github'), ...rest.filter((row) => row.runsOn !== 'github')];
}

function decode(file: { content?: string; encoding?: string }): string {
  return Buffer.from(file.content ?? '', (file.encoding as BufferEncoding) ?? 'base64').toString('utf8');
}

function contentsPath(fullName: string, path: string, ref: string): string {
  return `/repos/${fullName}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`;
}

const is404 = (error: unknown): boolean => (error as { status?: number } | null)?.status === 404;

const HOST_RESULT: Record<string, CheckResult> = { passed: 'pass', carried: 'pass', failed: 'fail', cancelled: 'skipped', refused: 'skipped', lost: 'skipped', running: 'none yet' };

/**
 * One repository's Checks view. `reads` is null when no account can read
 * GitHub; the page then says so and still shows the host check row.
 */
export async function checksViewOf(repo: ChecksRepo, reads: GitHubReads | null, records: ChecksRecords, now: () => Date = () => new Date()): Promise<ChecksView> {
  const branch = repo.defaultBranch;
  const view: ChecksView = {
    repo: repo.name,
    fullName: repo.fullName,
    defaultBranch: branch,
    workflow: { state: 'unreachable', detail: null, path: null },
    makefile: { state: 'unreachable', detail: null },
    runs: { state: 'unreachable', detail: null },
    flakes: { state: 'unreachable', detail: null },
    rows: [],
    localCi: null,
    readAt: now().toISOString(),
  };
  let jobs: CiWorkflowJob[] | null = null;
  let reach: MakeReach = noMakefileReach();
  let recent: WorkflowRun[] = [];
  let onDefault: WorkflowRun[] = [];
  let lastJobs: ActionsJob[] = [];
  let lastRun: WorkflowRun | null = null;
  let flakes: Flake[] = [];

  if (!reads) {
    const detail = 'no GitHub account can read it: reconnect the automation account from Settings → GitHub → Connected accounts';
    view.workflow.detail = detail;
    view.makefile.detail = detail;
    view.runs.detail = detail;
    view.flakes.detail = detail;
  } else {
    // The workflow named for the required check, as `newestCiRun` filters runs.
    let workflowId: number | null = null;
    try {
      const listed = await reads.get<{ workflows?: { id: number; name: string; path: string }[] }>(`/repos/${repo.fullName}/actions/workflows?per_page=100`);
      const named = (listed.workflows ?? []).filter((one) => one.name.toLowerCase() === REQUIRED_CHECK);
      const chosen = named.find((one) => one.path === '.github/workflows/ci.yml') ?? named[0] ?? null;
      if (chosen) {
        workflowId = chosen.id;
        view.workflow.path = chosen.path;
      } else {
        view.workflow = { state: 'missing', detail: `No \`${REQUIRED_CHECK}\` workflow on ${branch}`, path: null };
      }
    } catch (error) {
      view.workflow.detail = unreachableReason(error);
    }

    if (view.workflow.path) {
      try {
        const text = decode(await reads.get(contentsPath(repo.fullName, view.workflow.path, branch)));
        const parsed = parseCiWorkflow(text);
        if ('error' in parsed) {
          view.workflow = { state: 'unparseable', detail: `The ci workflow could not be read: ${parsed.error}${parsed.line ? ` (line ${parsed.line})` : ''}`, path: view.workflow.path };
        } else {
          jobs = parsed.jobs;
          view.workflow = { state: 'read', detail: null, path: view.workflow.path };
        }
      } catch (error) {
        view.workflow = is404(error)
          ? { state: 'missing', detail: `No \`${REQUIRED_CHECK}\` workflow on ${branch}: ${view.workflow.path} is not there`, path: view.workflow.path }
          : { state: 'unreachable', detail: unreachableReason(error), path: view.workflow.path };
      }
    }

    try {
      reach = makeTargetsReached(decode(await reads.get(contentsPath(repo.fullName, 'Makefile', branch))));
      view.makefile = { state: 'read', detail: null };
    } catch (error) {
      view.makefile = is404(error) ? { state: 'missing', detail: `No Makefile on ${branch}: only a job that runs \`make ci\` itself counts as covered` } : { state: 'unreachable', detail: unreachableReason(error) };
    }

    if (workflowId !== null) {
      try {
        const base = `/repos/${repo.fullName}/actions/workflows/${workflowId}/runs`;
        recent = (await reads.get<{ workflow_runs?: WorkflowRun[] }>(`${base}?per_page=${FLAKE_RUNS}`)).workflow_runs ?? [];
        onDefault = (await reads.get<{ workflow_runs?: WorkflowRun[] }>(`${base}?branch=${encodeURIComponent(branch)}&event=push&per_page=${DEFAULT_RUNS}`)).workflow_runs ?? [];
        onDefault.sort((a, b) => b.id - a.id);
        lastRun = onDefault.find((run) => run.status === 'completed') ?? null;
        if (lastRun) lastJobs = (await everyJob(asGetter(reads), repo.fullName, lastRun.id, lastRun.run_attempt ?? 1)) as ActionsJob[];
        view.runs = { state: 'read', detail: null };
      } catch (error) {
        view.runs = { state: 'unreachable', detail: unreachableReason(error) };
      }
      if (view.runs.state === 'read') {
        try {
          const scanned = await flakesOf(reads, repo.fullName, recent, jobs);
          flakes = scanned.flakes;
          view.flakes = scanned.partial
            ? { state: 'partial', detail: `Only part of the last ${FLAKE_RUNS} runs was read for flaky jobs (at most ${MAX_JOB_READS} attempts a read); the oldest heads were left out` }
            : { state: 'read', detail: null };
        } catch (error) {
          view.flakes = { state: 'unreachable', detail: unreachableReason(error) };
        }
      } else {
        view.flakes = { state: 'unreachable', detail: view.runs.detail };
      }
    } else if (view.workflow.state === 'missing') {
      // No ci workflow on GitHub is no ci runs, read and empty.
      view.runs = { state: 'read', detail: null };
      view.flakes = { state: 'read', detail: null };
    } else {
      view.runs.detail = view.workflow.detail;
      view.flakes.detail = view.workflow.detail;
    }
  }

  // The rows: the workflow's jobs, or, when it could not be read, the jobs
  // the runs name, never marked covered.
  const rowKeys: { key: string; name: string; covered: boolean | 'unknown' }[] = jobs
    ? jobs.map((job) => ({ key: job.key, name: job.name, covered: coveredByLocalCi(job, reach) }))
    : [];
  if (!jobs) {
    const seen = new Set<string>();
    for (const name of [...lastJobs.map((job) => job.name ?? ''), ...flakes.map((flake) => flake.key)]) {
      const key = keyOf(name, null);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      rowKeys.push({ key, name: key, covered: 'unknown' });
    }
  }
  const runUrl = lastRun ? (lastRun.html_url ?? `https://github.com/${repo.fullName}/actions/runs/${lastRun.id}`) : null;
  const rows: CheckRow[] = rowKeys.map(({ key, name, covered }) => {
    const matched = lastJobs.filter((job) => keyOf(job.name ?? '', jobs) === key);
    const flake = flakes.find((one) => one.key === key);
    const result = resultOf(matched.map((job) => job.conclusion));
    return {
      key,
      name,
      runsOn: 'github',
      covered,
      last: {
        result,
        url: matched.find((job) => job.html_url)?.html_url ?? (result === 'none yet' ? null : runUrl),
        at: matched.map((job) => job.completed_at ?? '').sort().at(-1) || null,
        detail: !lastRun ? `no completed ${REQUIRED_CHECK} run on ${branch} yet` : null,
      },
      flaky: flake ? { count: flake.heads.length, heads: flake.heads } : null,
    };
  });

  // The host check, from the bridge's own record only. It runs on pull
  // request heads, so its result "on the default branch" is the run of the
  // pull request that landed the newest default-branch commit.
  const hostCheck = await records.hostCheck(repo.id).catch(() => null);
  if (hostCheck) {
    let last: CheckRow['last'] = { result: 'none yet', url: null, at: null, detail: null };
    if (reads && onDefault.length > 0) {
      const shas = [...new Set(onDefault.map((run) => run.head_sha))];
      for (const sha of shas) {
        const pulls = await reads.get<{ number: number }[]>(`/repos/${repo.fullName}/commits/${sha}/pulls?per_page=100`).catch(() => []);
        let run: Awaited<ReturnType<ChecksRecords['hostCheckRun']>> = null;
        for (const pull of pulls) {
          run = await records.hostCheckRun(repo.id, pull.number).catch(() => null);
          if (run) break;
        }
        if (run) {
          const result = HOST_RESULT[run.state] ?? 'none yet';
          last = { result, url: `/host-checks/${run.id}`, at: run.finishedAt ?? run.startedAt, detail: result === 'skipped' || run.state === 'running' ? run.state : null };
          break;
        }
      }
    } else if (!reads || view.runs.state !== 'read') {
      last.detail = 'the pull request behind the default branch could not be found without GitHub';
    }
    rows.push({ key: 'host-check', name: 'host check', runsOn: 'this machine', last, flaky: null, command: hostCheck.command });
  }

  view.rows = rankChecks(rows);

  const head = onDefault[0]?.head_sha;
  if (head) {
    const local = await records.localCi(repo.id, head).catch(() => null);
    if (local) view.localCi = { sha: head, ok: local.ok, at: local.createdAt };
  }
  return view;
}

/**
 * Each repository's view, kept for `CHECKS_CACHE_MS`, so a reload does not
 * cost the forty-odd GitHub calls a read makes, as `MessageStarts` keeps its
 * CI read.
 */
export class ChecksViews {
  private readonly kept = new Map<string, { at: number; view: Promise<ChecksView> }>();

  constructor(
    private readonly read: (repo: ChecksRepo) => Promise<ChecksView>,
    private readonly clock: () => number = Date.now,
  ) {}

  async of(repo: ChecksRepo): Promise<ChecksView> {
    const now = this.clock();
    const kept = this.kept.get(repo.id);
    if (kept && now - kept.at < CHECKS_CACHE_MS) return kept.view;
    const view = this.read(repo);
    this.kept.set(repo.id, { at: now, view });
    view.catch(() => this.kept.delete(repo.id));
    return view;
  }
}
