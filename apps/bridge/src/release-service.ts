import { randomUUID } from 'node:crypto';
import { ReleaseAlreadyRunning, releaseRuns, repos, type ReleaseRun, type ReleaseSetting } from '@openadlc/db';
import { compareRepoVersionsIgnoringLabel, repoVersionFrom, repoVersionFromTag, repoVersionGate, type RepoVersion } from '@openadlc/shared';
import { releaseAccountFix } from './health/checks/release-account.js';
import type { HostdClient, ReleaseAccountProbe, ReleaseRunView } from './hostd-client.js';
import type { ReleasePublisher } from './release-publish.js';
import { HttpFailure } from './router.js';

/**
 * A repository's release build, as the bridge asks hostd for it and records
 * it (#343,
 * docs/adr/0068-a-release-is-built-in-its-own-account-and-signed-from-fields-hostd-computes.md,
 * docs/adr/0070-a-release-recipe-is-an-admins-and-its-artifact-stays-with-hostd.md).
 *
 * hostd builds (`apps/hostd/src/release-run.ts`); the bridge decides with what,
 * and keeps the record:
 *
 * - `start` is for one commit, pinned when a person asked for it, and builds
 *   that commit only. Nothing here checks who asked: the only caller is #345's
 *   route, which holds the Approves check and the device-code proof. No route
 *   of this file's, nor an admin's, reaches it, so nothing can cut a release
 *   around them.
 * - The recipe (command, artifact, version file and key, where it is
 *   published, the time limit) is the repository row's, which only an admin
 *   writes; nothing in the repository can choose what runs as the release
 *   account.
 * - The last release is read from the release repository's published
 *   releases. One that cannot be read refuses the run, never "no release":
 *   a version that is not above the last would ship a downgrade.
 * - `record` takes hostd's report, sent with the install's secret. The row's
 *   repository and commit are the row's, never the report's, and a `built`
 *   report that does not carry every field a release is signed from, or
 *   whose version does not follow the last release, is stored `failed`.
 * - `sweep` ends a `running` row hostd no longer holds as `lost`, and takes the
 *   end of one hostd holds as ended from hostd, when its report went missing.
 * - A `built` run is published (#344, `release-publish.ts`, docs/adr/0071):
 *   `record` starts it when it stores the report, and `sweep` starts one no
 *   publisher holds. One publisher per run in this bridge; the row's
 *   conditional updates hold it across two. A `publishing` row no publisher
 *   holds, as after a restart, is cleaned up and failed. This is the only
 *   caller of `publish`, so a release is published only for a run started
 *   here, by #345's route.
 */

/** A GitHub release as `lastReleaseVersion` reads it. */
export interface PublishedRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
}

/**
 * The last release's version, from a repository's releases: the highest of
 * the published, non-draft releases GitHub does not mark prerelease, by tag
 * name with one leading `v` taken off. A tag that is not a version is
 * skipped. Labels do not choose it; the gate holds the next version to the
 * label of the one chosen. Two at the highest with different labels cannot
 * be told apart, and throw, naming both. Null when there is none.
 */
export function lastReleaseVersion(releases: readonly PublishedRelease[]): RepoVersion | null {
  let best: { version: RepoVersion; tag: string }[] = [];
  for (const release of releases) {
    if (release.draft || release.prerelease || !release.published_at) continue;
    const version = repoVersionFromTag(release.tag_name);
    if (!version) continue;
    const order = best[0] ? compareRepoVersionsIgnoringLabel(version, best[0].version) : 1;
    if (order > 0) best = [{ version, tag: release.tag_name }];
    else if (order === 0) best.push({ version, tag: release.tag_name });
  }
  const labels = new Set(best.map((one) => one.version.label).filter((label) => label !== null));
  if (labels.size > 1) {
    const [a, b] = best.filter((one) => one.version.label !== null);
    throw new Error(`the last releases ${a?.tag} and ${b?.tag} are equal but for their labels, so the next one's label cannot be told: delete or mark one of them prerelease`);
  }
  // A labelled release ranks with its bare twin; the label is the one to keep.
  return (best.find((one) => one.version.label !== null) ?? best[0])?.version ?? null;
}

/**
 * `ReleaseServiceDeps.lastVersion` on GitHub: the first page of 100 releases
 * of the release repository, read with `client`, as `lastReleaseVersion`
 * chooses. No client, or a failed read, throws: the run is refused.
 */
export function lastVersionOnGitHub(
  client: (repoFullName: string) => Promise<{ request<T>(method: string, path: string): Promise<T> } | null>,
): (repoFullName: string) => Promise<string | null> {
  return async (repoFullName) => {
    const github = await client(repoFullName);
    if (!github) throw new Error(`neither the app nor the automation account can read the releases of ${repoFullName}`);
    const releases = await github.request<PublishedRelease[]>('GET', `/repos/${repoFullName}/releases?per_page=100`);
    if (!Array.isArray(releases)) throw new Error(`GitHub did not answer a list of the releases of ${repoFullName}`);
    return lastReleaseVersion(releases)?.text ?? null;
  };
}

/** What hostd reports when a run ends (`POST /internal/release`). */
export interface ReleaseReport {
  runId: string;
  state: 'built' | 'failed' | 'cancelled' | 'refused';
  version?: string | null;
  sha256?: string | null;
  bytes?: number | null;
  artifactName?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  logTail?: string | null;
  reason?: string | null;
}

/** The repository as `start` needs it. */
export interface ReleaseRepo {
  id: string;
  name: string;
  fullName: string;
  defaultBranch: string;
}

export interface ReleaseServiceDeps {
  hostd: Pick<HostdClient, 'releaseAccount' | 'startRelease' | 'releaseRun' | 'cancelRelease'> | null;
  /**
   * The release repository's last release's version text (`v` taken off), or
   * null when it has none; throws when it cannot be read. See
   * `lastReleaseVersion`.
   */
  lastVersion(repoFullName: string): Promise<string | null>;
  /** The crew account whose token hostd fetches the default branch with. */
  fetchBot(): Promise<string | null>;
  /**
   * Tags, signs and publishes a built run as the app (`release-publish.ts`,
   * #344). This service is its only caller; absent, a built run waits.
   */
  publisher?: Pick<ReleasePublisher, 'publish' | 'abandon'> | null;
  newId?: () => string;
  warn?: (message: string) => void;
}

const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export class ReleaseService {
  /** Runs a publisher in this bridge holds, and the publish going for each. */
  private readonly publishing = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: ReleaseServiceDeps) {}

  private warn(message: string): void {
    (this.deps.warn ?? console.warn)(message);
  }

  /** Starts publishing a built run unless a publisher here holds it; false when none was started. */
  private startPublish(runId: string): boolean {
    const publisher = this.deps.publisher;
    if (!publisher || this.publishing.has(runId)) return false;
    const going = publisher
      .publish(runId)
      .catch((error: unknown) => {
        this.warn(`[bridge] release ${runId} could not be published: ${error instanceof Error ? error.message : error}. The sweep tries again`);
      })
      .finally(() => this.publishing.delete(runId));
    this.publishing.set(runId, going);
    return true;
  }

  /** Waits for every publish going; for tests. */
  async settled(): Promise<void> {
    while (this.publishing.size > 0) await Promise.all([...this.publishing.values()]);
  }

  /**
   * Starts a release build of `sha`; see the header. Throws an `HttpFailure`
   * that says what to do when nothing can start; answers the row otherwise,
   * `running`, or `refused` with its reason when the account, the last
   * release or hostd refused it.
   */
  async start(input: { repo: ReleaseRepo; sha: string; clean: boolean; by: { login: string; githubUserId: number } }): Promise<ReleaseRun> {
    const { repo, sha, clean, by } = input;
    const setting = await repos.getRelease(repo.id);
    if (!setting) {
      throw new HttpFailure(409, `${repo.name} is not set to release: an admin sets its release recipe first (PATCH /v1/repos/${repo.name} with release)`);
    }
    if (typeof sha !== 'string' || !SHA.test(sha)) throw new HttpFailure(400, 'a release builds one commit: give its full 40-character sha');
    if (await releaseRuns.anyInFlight(repo.id)) throw new HttpFailure(409, `a release of ${repo.name} is building or publishing; wait for it to end, or cancel it`);
    if (!this.deps.hostd) throw new HttpFailure(501, 'this bridge has no hostd to build releases on. Start hostd: openadlc up');
    let probe: ReleaseAccountProbe | null;
    try {
      probe = (await this.deps.hostd.releaseAccount()).probe;
    } catch (error) {
      throw new HttpFailure(502, `hostd could not be asked about the release account: ${error instanceof Error ? error.message : error}. Check that hostd is running (openadlc doctor), then try again`);
    }
    if (probe === null) {
      throw new HttpFailure(409, 'hostd names no release account. Set OPENADLC_RELEASE_ACCOUNT to the account you made for releases (docs/self-hosting.md#the-release-account), then restart hostd');
    }
    const runId = (this.deps.newId ?? randomUUID)();
    const row = (extra: { state?: 'running' | 'refused'; reason?: string | null; previousVersion?: string | null } = {}) =>
      this.startRow({ runId, repo, sha, clean, by, setting, previousVersion: extra.previousVersion ?? null, ...(extra.state ? { state: extra.state } : {}), reason: extra.reason ?? null });
    if (!probe.ok) return row({ state: 'refused', reason: releaseAccountFix(probe).detail });

    const releaseRepo = setting.releaseRepo ?? repo.fullName;
    let after: string | null;
    try {
      after = await this.deps.lastVersion(releaseRepo);
    } catch (error) {
      // Never "no release": the run would then pass any version, a downgrade included.
      return row({
        state: 'refused',
        reason: `the last release of ${releaseRepo} could not be read, so the new version cannot be held above it: ${error instanceof Error ? error.message : error}`,
      });
    }

    const started = await row({ previousVersion: after });
    try {
      await this.deps.hostd.startRelease({
        runId,
        repo: repo.fullName,
        sha,
        defaultBranch: repo.defaultBranch,
        versionFile: setting.versionFile,
        versionKey: setting.versionKey,
        after,
        command: setting.command,
        artifact: setting.artifact,
        timeoutMinutes: setting.timeoutMinutes,
        clean,
        bot: await this.deps.fetchBot().catch(() => null),
      });
    } catch (error) {
      const refused = await releaseRuns.finish(runId, { state: 'refused', reason: `hostd did not take the run: ${error instanceof Error ? error.message : error}` });
      return refused ?? started;
    }
    return started;
  }

  private async startRow(input: {
    runId: string;
    repo: ReleaseRepo;
    sha: string;
    clean: boolean;
    by: { login: string; githubUserId: number };
    setting: ReleaseSetting;
    previousVersion: string | null;
    state?: 'running' | 'refused';
    reason: string | null;
  }): Promise<ReleaseRun> {
    try {
      return await releaseRuns.start({
        runId: input.runId,
        repoId: input.repo.id,
        sha: input.sha,
        clean: input.clean,
        command: input.setting.command,
        artifact: input.setting.artifact,
        versionFile: input.setting.versionFile,
        versionKey: input.setting.versionKey,
        releaseRepo: input.setting.releaseRepo,
        timeoutMinutes: input.setting.timeoutMinutes,
        previousVersion: input.previousVersion,
        requestedByLogin: input.by.login,
        requestedById: input.by.githubUserId,
        ...(input.state ? { state: input.state } : {}),
        reason: input.reason,
      });
    } catch (error) {
      if (error instanceof ReleaseAlreadyRunning) throw new HttpFailure(409, `a release of ${input.repo.name} is building or publishing; wait for it to end, or cancel it`);
      throw error;
    }
  }

  /**
   * hostd's report of a run's end. A report for a run already ended — sent
   * twice, or one the sweep called lost — changes nothing. False when there
   * is no such running row.
   */
  async record(report: ReleaseReport): Promise<boolean> {
    const run = await releaseRuns.byRunId(report.runId);
    if (!run || run.state !== 'running') return false;
    const common = {
      exitCode: report.exitCode ?? null,
      durationMs: report.durationMs ?? null,
      logTail: report.logTail ?? null,
    };
    if (report.state !== 'built') {
      // Only a built run carries the fields a release is signed from.
      return Boolean(await releaseRuns.finish(run.runId, { state: report.state, ...common, reason: report.reason ?? null }));
    }
    const problem = builtProblem(report, run.previousVersion);
    if (problem) {
      this.warn(`[bridge] release ${run.runId} of ${run.repoName} at ${run.sha.slice(0, 7)}: ${problem}`);
      return Boolean(await releaseRuns.finish(run.runId, { state: 'failed', ...common, reason: problem }));
    }
    const built = await releaseRuns.finish(run.runId, {
      state: 'built',
      ...common,
      version: report.version ?? null,
      sha256: report.sha256 ?? null,
      bytes: report.bytes ?? null,
      artifactName: report.artifactName ?? null,
      reason: null,
    });
    if (built) this.startPublish(run.runId);
    return Boolean(built);
  }

  /** Stops a release building. A run hostd no longer knows of is ended here. False when it was not running. */
  async cancel(runId: string, reason = 'the release was cancelled'): Promise<boolean> {
    const run = await releaseRuns.byRunId(runId);
    if (!run || run.state !== 'running') return false;
    const told = this.deps.hostd ? await this.deps.hostd.cancelRelease(runId).catch(() => null) : null;
    // hostd stops it, clears the account and reports the end itself.
    if (told?.cancelled) return true;
    await releaseRuns.finish(runId, { state: 'cancelled', reason });
    return true;
  }

  /**
   * Ends each `running` row hostd no longer holds as `lost`, and records the
   * end of one hostd holds as ended whose report never arrived.
   */
  async sweep(): Promise<string[]> {
    const lines = await this.sweepPublishing();
    if (!this.deps.hostd) return lines;
    const hostd = this.deps.hostd;
    for (const run of await releaseRuns.running()) {
      const held = await hostd.releaseRun(run.runId).then(
        (answer): ReleaseRunView | false | null => answer.run,
        (error: unknown) => ((error as { status?: number }).status === 404 ? false : null),
      );
      if (held === null) continue;
      if (held === false) {
        const lost = await releaseRuns.finish(run.runId, { state: 'lost', reason: 'hostd no longer had the run, as after a restart: start the release again' });
        if (lost) lines.push(`${run.repoName}: release of ${run.sha.slice(0, 7)} was lost by hostd`);
        continue;
      }
      if (held.state === 'running') continue;
      const recorded = await this.record({
        runId: run.runId,
        state: held.state,
        version: held.version,
        sha256: held.sha256,
        bytes: held.bytes,
        artifactName: held.artifactName,
        exitCode: held.exitCode,
        durationMs: held.durationMs,
        logTail: held.logTail,
        reason: held.reason,
      });
      if (recorded) lines.push(`${run.repoName}: release of ${run.sha.slice(0, 7)} ${held.state}, as hostd holds it; its report had not arrived`);
    }
    return lines;
  }

  /**
   * A `publishing` row no publisher here holds — the bridge restarted while
   * it published — is cleaned up and failed, saying what it left; a `built`
   * row no publisher holds is published.
   */
  private async sweepPublishing(): Promise<string[]> {
    const publisher = this.deps.publisher;
    if (!publisher) return [];
    const lines: string[] = [];
    for (const run of await releaseRuns.publishingUnheld([...this.publishing.keys()])) {
      const ended = await publisher.abandon(run).catch(() => null);
      if (ended) lines.push(`${run.repoName}: publishing ${run.tag ?? 'a release'} of ${run.sha.slice(0, 7)} was cut off by a restart, and failed`);
    }
    for (const run of await releaseRuns.builtUnheld([...this.publishing.keys()])) {
      if (this.startPublish(run.runId)) lines.push(`${run.repoName}: publishing the release built from ${run.sha.slice(0, 7)}`);
    }
    return lines;
  }
}

/**
 * Why a `built` report cannot stand, or null when it can: it carries every
 * field a release is signed from, its version is one, and it follows the last
 * release the bridge read when it asked for the run. hostd checked the same
 * before it built; this holds the record to it, whatever reached the route.
 */
function builtProblem(report: ReleaseReport, previous: string | null): string | null {
  const missing: string[] = [];
  if (typeof report.version !== 'string' || !report.version) missing.push('a version');
  if (typeof report.sha256 !== 'string' || !SHA256.test(report.sha256)) missing.push('a sha256');
  if (typeof report.bytes !== 'number' || !Number.isSafeInteger(report.bytes) || report.bytes <= 0) missing.push('a size');
  if (typeof report.artifactName !== 'string' || !report.artifactName || /[/\\\u0000]/.test(report.artifactName)) missing.push('an artifact name');
  if (missing.length > 0) return `hostd reported a build without ${missing.join(', ')}, so it cannot be released: start the release again`;
  const read = repoVersionFrom(report.version as string);
  if (!read.ok) return `hostd reported a version that is not one (${read.reason}), so it cannot be released`;
  const after = previous === null ? null : repoVersionFrom(previous);
  const gate = repoVersionGate(read.version, after?.ok ? after.version : null, 'the version file');
  if (gate) return `hostd reported ${read.version.text}, which cannot follow the last release: ${gate}`;
  return null;
}
