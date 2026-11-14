import { randomUUID } from 'node:crypto';
import { hostCheckRuns, repos, type HostCheckRun, type HostCheckSetting } from '@openadlc/db';
import type { HostCheckAccountProbe, HostdClient } from './hostd-client.js';

/**
 * A repository's host check, as the bridge asks for it and records it (#327,
 * docs/adr/0064-a-host-check-runs-as-its-own-account-and-the-merge-reads-the-bridges-record.md).
 *
 * hostd runs it (`apps/hostd/src/host-check.ts`); the bridge decides when, with
 * what, and what it means:
 *
 * - `request` is called once the lead's approval counts on a head
 *   (`crewApprovedHead`), beside `awaitPeople`, by the review webhook and the
 *   scheduler's sweep, and for a pull request with no issue too. The command
 *   and the time limit are read from the repository's row, which only an
 *   admin writes, and from nowhere else: nothing on the pull request — its
 *   body, its branch, its files — can choose what runs on the machine.
 * - A pass on an earlier head whose diff against the base is this head's is
 *   carried rather than run again: the merge line's base update would
 *   otherwise rerun a build of hours while the line waits. Never through a
 *   head a conflict resolution led to, whose code changed (`carriedFrom` in
 *   the merge); this compares diffs only.
 * - `record` takes hostd's report, sent with the install's secret, finishes
 *   the row and posts the `host-check` status as the app. The status is for
 *   people: the merge reads the table (`MergeFacts.hostCheck`), since any crew
 *   token could set a status.
 * - `sweep` ends a `running` row hostd no longer holds, as after its restart,
 *   as `lost`; the next `request` runs it again.
 * - A head whose run `failed` is not run again: a build can take hours, and
 *   one that failed holds the merge until a new head is pushed. What kept it
 *   from running at all — the account, hostd — ends as `refused` or `lost`,
 *   which are asked for again.
 */

/** A run refused for something other than the account is tried again no sooner than this. */
const REFUSED_RETRY_MS = 10 * 60_000;

/** The fix for an account that is not fit, said on the card and in the health check. */
export const HOST_CHECK_DOCS = 'docs/self-hosting.md#host-checks';

export type HostCheckStatusState = 'pending' | 'success' | 'failure' | 'error';

/** What a held approval's card, and a held merge's, say about the host check of the head they are about. */
export interface HostCheckCardView {
  state: 'passed' | 'failed' | 'running' | 'cancelled' | 'refused' | 'not_run';
  head: string;
  /** Set when the pass is an earlier head's with the same changes. */
  carriedFrom?: string;
  startedAt?: string;
  durationMs?: number;
  /** A failed run's last `CARD_TAIL_LINES` lines. */
  logTail?: string;
  /** Why it did not run, or was stopped, in words that say what to do. */
  reason?: string;
  /** The run's page in the console, `/host-checks/<id>`; null when there is no run to show. */
  url: string | null;
}

/** How much of a failed run's log the card shows; the run's page shows all that was kept. */
export const CARD_TAIL_LINES = 40;

/**
 * The card's view of the head being approved, from the pull request's runs,
 * newest first. Only the head's own rows count: a run on another head says
 * nothing about this one, and a carry says so by its own row.
 */
export function hostCheckCardView(runs: readonly HostCheckRun[], head: string, notRun: string | null = null): HostCheckCardView {
  const onHead = runs.filter((run) => run.headSha === head);
  // A carried pass or a pass stands over a later cancel of a run nobody needed.
  const passed = onHead.find((run) => run.state === 'passed' || run.state === 'carried');
  const newest = passed ?? onHead[0];
  if (!newest) return { state: 'not_run', head, reason: notRun ?? `no run on ${head.slice(0, 7)} yet: it starts once the crew's reviews approve this head`, url: null };
  const url = `/host-checks/${newest.id}`;
  switch (newest.state) {
    case 'passed':
      return { state: 'passed', head, ...(newest.durationMs !== null ? { durationMs: newest.durationMs } : {}), startedAt: newest.startedAt, url };
    case 'carried':
      return { state: 'passed', head, ...(newest.carriedFrom ? { carriedFrom: newest.carriedFrom } : {}), url };
    case 'running':
      return { state: 'running', head, startedAt: newest.startedAt, url };
    case 'failed':
      return {
        state: 'failed',
        head,
        ...(newest.durationMs !== null ? { durationMs: newest.durationMs } : {}),
        ...(newest.logTail ? { logTail: lastLines(newest.logTail, CARD_TAIL_LINES) } : {}),
        ...(newest.reason ? { reason: newest.reason } : {}),
        url,
      };
    case 'refused':
      return { state: 'refused', head, reason: newest.reason ?? 'hostd refused to run it', url };
    case 'cancelled':
      return { state: 'cancelled', head, reason: newest.reason ?? 'it was stopped before it finished', url };
    case 'lost':
      return { state: 'not_run', head, reason: newest.reason ?? 'hostd lost the run; it is asked for again', url };
  }
}

function lastLines(text: string, count: number): string {
  const lines = text.replace(/\n+$/, '').split('\n');
  return lines.slice(-count).join('\n');
}

/**
 * Whether the crew's reviews approve the head, as a host check waits for:
 * the lead's approval counts on it, and the lead is not deciding again
 * (`leadDue`, docs/adr/0038). The person is asked beside it, not after it.
 */
export function crewApprovedHead(standing: { approved: readonly string[]; decision: { lead: string }; leadDue?: unknown }): boolean {
  return standing.approved.includes(standing.decision.lead) && !standing.leadDue;
}

/** What hostd reports when a run ends (`POST /internal/host-check`). */
export interface HostCheckReport {
  runId: string;
  state: 'passed' | 'failed' | 'cancelled' | 'refused';
  exitCode?: number | null;
  durationMs?: number | null;
  logTail?: string | null;
  reason?: string | null;
}

export interface HostCheckServiceDeps {
  hostd: Pick<HostdClient, 'startHostCheck' | 'hostCheckRun' | 'cancelHostCheck' | 'hostCheckAccount'> | null;
  /** Posts the `host-check` status on a head, as the app where it can. */
  postStatus(repoFullName: string, sha: string, status: { state: HostCheckStatusState; description: string; targetUrl?: string }): Promise<void>;
  /** The diff of `base...sha`, as `GitHubClient.diffFingerprint` says; null when it cannot be told. */
  fingerprint(repoFullName: string, base: string, sha: string): Promise<string | null>;
  /** The crew account whose token hostd fetches the head with. */
  fetchBot(): Promise<string | null>;
  /** The console's address, for the status's link; null leaves the status without one. */
  consoleUrl: string | null;
  newId?: () => string;
  now?: () => number;
  warn?: (message: string) => void;
}

/** The repository as `request` needs it. */
export interface HostCheckRepo {
  id: string;
  name: string;
  fullName: string;
}

export class HostCheckService {
  constructor(private readonly deps: HostCheckServiceDeps) {}

  private warn(message: string): void {
    (this.deps.warn ?? console.warn)(message);
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** The repository's host check, or null for none; one that cannot be read is none, and the merge says so on its own. */
  async settingOf(repoId: string): Promise<HostCheckSetting | null> {
    return repos.getHostCheck(repoId).catch(() => null);
  }

  /**
   * Asks for the head's host check once the crew approved it; see the
   * header. Answers what it did, for the sweep's log, or null for nothing.
   * Never throws: a host check that cannot be asked for holds the merge
   * where it is required, and is asked for again at the next sweep.
   */
  async request(repo: HostCheckRepo, pr: number, head: string, base: string): Promise<string | null> {
    try {
      return await this.requestOrThrow(repo, pr, head, base);
    } catch (error) {
      this.warn(`[bridge] ${repo.name}#${pr}: the host check of ${head.slice(0, 7)} could not be asked for: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }

  private async requestOrThrow(repo: HostCheckRepo, pr: number, head: string, base: string): Promise<string | null> {
    const setting = await this.settingOf(repo.id);
    if (!setting) return null;
    const ref = `${repo.name}#${pr}`;
    const runs = await hostCheckRuns.forPull(repo.id, pr);
    const onHead = runs.filter((run) => run.headSha === head);
    const newest = onHead[0] ?? null;
    if (onHead.some((run) => run.state === 'passed' || run.state === 'carried' || run.state === 'running' || run.state === 'failed')) return null;
    if (newest?.state === 'refused' && newest.finishedAt && this.now() - Date.parse(newest.finishedAt) < REFUSED_RETRY_MS) return null;

    // The same changes as a head that passed: carried, not built again.
    const passed = [...new Set(runs.filter((run) => run.state === 'passed').map((run) => run.headSha))].filter((sha) => sha !== head);
    if (passed.length > 0) {
      const now = await this.deps.fingerprint(repo.fullName, base, head);
      for (const sha of passed) {
        const then = now === null ? null : await this.deps.fingerprint(repo.fullName, base, sha).catch(() => null);
        if (now === null || then === null || then !== now) continue;
        const carried = await hostCheckRuns.carry({ repoId: repo.id, prNumber: pr, headSha: head, from: sha, command: setting.command, timeoutMinutes: setting.timeoutMinutes });
        await this.status(repo.fullName, head, 'success', `passed on ${sha.slice(0, 7)}, which has the same changes`, carried.id);
        return `${ref}: host check carried to ${head.slice(0, 7)} from ${sha.slice(0, 7)}, which has the same changes`;
      }
    }

    if (!this.deps.hostd) return null;
    // An account that is not fit runs nothing, and says so once per head:
    // the health check has the card that says what to do.
    const probe = await this.deps.hostd.hostCheckAccount().then(
      (answer) => answer.probe,
      (error: unknown) => ({ ok: false, account: '', problem: 'no_account', detail: `hostd did not answer about the account: ${error instanceof Error ? error.message : error}` }) as HostCheckAccountProbe,
    );
    if (!probe.ok) {
      const reason = accountFix(probe);
      const refused = await hostCheckRuns.start({
        runId: `refused:${repo.id}:${pr}:${head}`,
        repoId: repo.id,
        prNumber: pr,
        headSha: head,
        command: setting.command,
        timeoutMinutes: setting.timeoutMinutes,
        state: 'refused',
        reason,
      });
      // Said once per head: the row was there already when this head was refused before.
      if (newest?.id === refused.id) return null;
      await this.status(repo.fullName, head, 'error', `not run: ${reason}`, refused.id);
      return `${ref}: host check of ${head.slice(0, 7)} not run: ${reason}`;
    }

    // From the repository's row, and only from there.
    const runId = (this.deps.newId ?? randomUUID)();
    const row = await hostCheckRuns.start({ runId, repoId: repo.id, prNumber: pr, headSha: head, command: setting.command, timeoutMinutes: setting.timeoutMinutes });
    try {
      await this.deps.hostd.startHostCheck({
        runId,
        repo: repo.fullName,
        pr,
        head,
        command: setting.command,
        timeoutMinutes: setting.timeoutMinutes,
        bot: await this.deps.fetchBot().catch(() => null),
      });
    } catch (error) {
      const reason = `hostd did not take the run: ${error instanceof Error ? error.message : error}; it is asked for again shortly`;
      await hostCheckRuns.finish(runId, { state: 'refused', reason });
      throw new Error(reason);
    }
    await this.status(repo.fullName, head, 'pending', `running ${setting.command}`, row.id);
    return `${ref}: host check started on ${head.slice(0, 7)} (${setting.command}, up to ${setting.timeoutMinutes} min)`;
  }

  /**
   * hostd's report of a run's end: the row finished and the status posted.
   * A report for a run already ended — sent twice, or one the sweep called
   * lost — changes nothing. False when there is no such running row.
   */
  async record(report: HostCheckReport): Promise<boolean> {
    const run = await hostCheckRuns.finish(report.runId, {
      state: report.state,
      exitCode: report.exitCode ?? null,
      durationMs: report.durationMs ?? null,
      logTail: report.logTail ?? null,
      reason: report.reason ?? null,
    });
    if (!run) return false;
    const minutes = run.durationMs !== null ? Math.max(1, Math.round(run.durationMs / 60_000)) : null;
    if (run.state === 'passed') await this.status(run.repoFullName, run.headSha, 'success', `passed${minutes ? ` in ${minutes} min` : ''}`, run.id);
    else if (run.state === 'failed') await this.status(run.repoFullName, run.headSha, 'failure', run.reason ?? `failed${run.exitCode !== null ? ` with exit ${run.exitCode}` : ''}`, run.id);
    else if (run.state === 'refused') await this.status(run.repoFullName, run.headSha, 'error', `not run: ${run.reason ?? 'hostd refused it'}`, run.id);
    // A cancelled run says nothing: a newer head, or a closed pull request, has its own story.
    return true;
  }

  /**
   * Stops a pull request's run: closed, merged, or a new head the crew has
   * not approved yet. A run hostd no longer knows of is ended here.
   */
  async cancel(repo: HostCheckRepo, pr: number, reason: string): Promise<void> {
    const going = (await hostCheckRuns.forPull(repo.id, pr).catch(() => [])).filter((run) => run.state === 'running');
    if (going.length === 0) return;
    const told = this.deps.hostd ? await this.deps.hostd.cancelHostCheck(repo.fullName, pr).catch(() => null) : null;
    if (told?.cancelled) return;
    for (const run of going) await hostCheckRuns.finish(run.runId, { state: 'cancelled', reason }).catch(() => null);
  }

  /** Ends each `running` row hostd no longer holds as `lost`; see the header. */
  async sweep(): Promise<string[]> {
    if (!this.deps.hostd) return [];
    const lines: string[] = [];
    for (const run of await hostCheckRuns.running()) {
      const held = await this.deps.hostd.hostCheckRun(run.runId).then(
        () => true,
        (error: unknown) => ((error as { status?: number }).status === 404 ? false : null),
      );
      if (held !== false) continue;
      const lost = await hostCheckRuns.finish(run.runId, { state: 'lost', reason: 'hostd no longer had the run, as after a restart; it is asked for again' });
      if (lost) lines.push(`${run.repoName}#${run.prNumber}: host check on ${run.headSha.slice(0, 7)} was lost by hostd; it is asked for again`);
    }
    return lines;
  }

  private async status(repoFullName: string, sha: string, state: HostCheckStatusState, description: string, id: string): Promise<void> {
    const targetUrl = this.deps.consoleUrl ? `${this.deps.consoleUrl.replace(/\/+$/, '')}/host-checks/${id}` : undefined;
    await this.deps.postStatus(repoFullName, sha, { state, description, ...(targetUrl ? { targetUrl } : {}) }).catch((error: unknown) => {
      this.warn(`[bridge] ${repoFullName}@${sha.slice(0, 7)}: the host-check status could not be posted: ${error instanceof Error ? error.message : error}`);
    });
  }
}

/** What to do about an account the probe found unfit; the health check and the card say the same. */
export function accountFix(probe: HostCheckAccountProbe): string {
  if (probe.ok) return '';
  switch (probe.problem) {
    case 'no_account':
      return `${probe.detail}. Make the account as ${HOST_CHECK_DOCS} says`;
    case 'not_dedicated':
      return `${probe.detail}. Set OPENADLC_HOST_CHECK_ACCOUNT to an account made for host checks, as ${HOST_CHECK_DOCS} says`;
    case 'no_sudo':
      return `${probe.detail}. Add the sudo rule in ${HOST_CHECK_DOCS}, then run openadlc doctor`;
    case 'can_read':
      return `${probe.detail}, so it could read the install's secrets. Run: chmod 700 ${probe.path ?? 'that folder'}`;
  }
}
