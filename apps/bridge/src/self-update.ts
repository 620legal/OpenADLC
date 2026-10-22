import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { audit, settings, type SettingKey } from '@openadlc/db';
import {
  ATTESTATION_FLAGS,
  attestationCheckArgs,
  checksumOf,
  attestationRunProblem,
  compareVersions,
  isCommitId,
  latestRelease,
  movedTagWords,
  nextRelease,
  nextReleaseRefused,
  ONE_RELEASE_AT_A_TIME,
  readReleasePages,
  untakeableReason,
  sharedCheckoutReason,
  takeableReleases,
  otherInstallsRunning,
  processCommandLine,
  parseResultFile,
  recordsImageDigests,
  releaseAssets,
  releaseAssetUrl,
  releaseInstallEnv,
  releaseVersion,
  safeWords,
  selfUpdateAttention,
  selfUpdatePaths,
  type CheckoutInstall,
  type MovedImageTag,
  type PublishedRelease,
  type SelfUpdateAttention,
  type SelfUpdateLast,
  type SelfUpdateResultFile,
  type SelfUpdateRun,
  type SelfUpdateTrigger,
} from '@openadlc/shared';
import {
  CloudUpdate,
  cloudInstallFrom,
  cloudStopReason,
  cloudUpdatedReason,
  digestOf,
  nextReleaseNote,
  type CloudBefore,
  type CloudPart,
  type CloudSelfUpdateRun,
} from './cloud-update.js';
import { DAYS, isDue, lastSlotAtOrBefore, localTimeZone, nextSlotAfter, type Day } from './engine-updates.js';
import { ArchiveRefused, readArchive, unpackArchive } from './release-archive.js';
import { HttpFailure, type Router } from './router.js';
import { timeZoneFrom } from './system-settings.js';

/**
 * OpenADLC updating itself, from the releases a person makes by tagging a
 * version (docs/self-hosting.md#updating-openadlc; the decision is
 * docs/adr/0007-self-update-follows-verified-releases.md).
 *
 * The install runs from a git checkout (`repoRoot`), which is also where a
 * task's computer mounts the skills, the role playbooks and OpenADLC's `gh`
 * and `git` from. That checkout stays the install. An update has three
 * phases:
 *
 * 1. **Preparing**, at once and while tasks run. The bridge fetches `main` and
 *    the release's tag into the checkout, which writes only refs, and checks
 *    the tag is a first-parent commit of `main` the checkout can fast-forward
 *    to. It downloads the release's three files beside the install, checks
 *    the archive's SHA-256 and then its attestation with `gh attestation
 *    verify`, reads the archive entry by entry against the contract, checks
 *    its manifest names the tag's commit and tree, and only then adds a
 *    detached worktree of that commit, unpacks the built output into it and
 *    runs `pnpm install --frozen-lockfile` there. Nothing the services run
 *    from is touched, so a failure anywhere leaves the install as it was.
 * 2. **Waiting**, once that worked: no new work starts (the dispatch gate is
 *    held, and `TaskService.openNow` refuses as busy), a paused task stays
 *    paused, and the restart begins only after two looks a poll apart find no
 *    task queued or running and no engine update on hostd.
 * 3. **Restarting**: a detached `openadlc self-update apply`, from the
 *    worktree's new CLI, stops the services, fast-forwards the checkout,
 *    swaps the built output in, installs offline from the store the worktree
 *    filled, migrates and starts them (`apps/cli/src/commands/self-update.ts`).
 *    It leaves its result in `run/self-update-result.json`, which the bridge
 *    that comes up records.
 *
 * A Google Cloud install (`OPENADLC_CLOUD=gcp`) runs no checkout: it runs a
 * release's images. The run is the same up to the restart, with checking the
 * release's images in place of preparing a worktree, and the restart is a
 * roll of the console, then hostd, then the bridge itself (`cloud-update.ts`).
 */

/** The run in flight, and the last result, and the rest, as settings. */
const KEY = {
  schedule: 'selfUpdateSchedule',
  run: 'selfUpdateRun',
  last: 'selfUpdateLast',
  candidate: 'selfUpdateCandidate',
} as const satisfies Record<string, SettingKey>;

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface SelfUpdateSchedule {
  mode: 'schedule' | 'manual';
  day: Day;
  time: string;
  /** The slot a run was claimed for. Null until the first look, which claims it and runs nothing. */
  slot: string | null;
}

/** Sunday 18:00, as the engines'; an install from before self-update starts on it too. */
export const DEFAULT_SELF_UPDATE_SCHEDULE: SelfUpdateSchedule = { mode: 'schedule', day: 'sunday', time: '18:00', slot: null };

export function selfUpdateScheduleFrom(raw: string | undefined): SelfUpdateSchedule {
  const parsed = parse<Partial<SelfUpdateSchedule>>(raw);
  if (!parsed) return { ...DEFAULT_SELF_UPDATE_SCHEDULE };
  return {
    mode: parsed.mode === 'manual' ? 'manual' : 'schedule',
    day: typeof parsed.day === 'string' && (DAYS as readonly string[]).includes(parsed.day) ? parsed.day : DEFAULT_SELF_UPDATE_SCHEDULE.day,
    time: typeof parsed.time === 'string' && TIME.test(parsed.time) ? parsed.time : DEFAULT_SELF_UPDATE_SCHEDULE.time,
    slot: typeof parsed.slot === 'string' && !Number.isNaN(new Date(parsed.slot).getTime()) ? parsed.slot : null,
  };
}

/** What the last look at the releases found, as `selfUpdateCandidate` keeps it. */
export interface SelfUpdateCandidate {
  tag: string | null;
  sha: string | null;
  publishedAt: string | null;
  /** Why there is nothing to take, or what taking it would do. */
  reason: string;
  checkedAt: string;
  /** On a cloud install, the newest release when it is further ahead than the next, which is what is taken. */
  newest?: string | null;
  /** On a cloud install, the tags of the release in use and the next that name another digest now than the release recorded. */
  moved?: MovedImageTag[];
}

export interface SelfUpdateView {
  /** How this install is updated: its checkout, or, on Google Cloud, by rolling a release's images. */
  backend: 'checkout' | 'cloud';
  /** The repository releases are read from: the checkout's `origin`, or the cloud module's `OPENADLC_RELEASE_REPO`. */
  repository: string | null;
  inUse: { sha: string; date: string | null; tag: string | null } | null;
  candidate: { tag: string; sha: string | null; publishedAt: string | null; newest?: string } | null;
  candidateReason: string;
  checkedAt: string | null;
  schedule: { mode: 'schedule' | 'manual'; day: Day; time: string };
  timeZone: string;
  nextRun: string | null;
  due: boolean;
  /** Whether this install can update itself; `reason` says why not. */
  applicable: boolean;
  reason: string;
  running: (CloudSelfUpdateRun & { waitingFor: LiveTask[] }) | null;
  last: SelfUpdateLast | null;
  attention: SelfUpdateAttention | null;
  /**
   * On a cloud install, each tag of the release in use, the next, or the one
   * a run is taking that names another digest now than the release recorded,
   * in words naming both (`movedTagWords`). The recorded one is what runs and
   * what is taken; someone pushed the tag again, and a person should know.
   */
  movedTags: string[];
}

/** A task that holds a restart: queued or running. */
export interface LiveTask {
  id: string;
  bot: string;
  subjectRef: string;
  kind: string;
}

export interface SelfUpdateStore {
  all(): Promise<Partial<Record<SettingKey, string>>>;
  set(key: SettingKey, value: string, by: string): Promise<void>;
}

export interface SelfUpdateDeps {
  /** The checkout the services run from. */
  repoRoot: string;
  /** `$OPENADLC_HOME`. */
  home: string;
  /** Runs a command and answers its standard output; a failure is thrown, in the words it printed. */
  run(command: string, args: readonly string[], options: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }): Promise<string>;
  fetch: typeof fetch;
  /** A token to ask GitHub's API with, or null to ask without one; downloads never carry one. */
  token?: () => Promise<string | null>;
  store?: SelfUpdateStore;
  audit?: (entry: { actor: string; action: string; target: string; payload?: Record<string, unknown> }) => Promise<void>;
  now?: () => Date;
  timeZone?: string;
  liveTasks(): Promise<LiveTask[]>;
  /** Whether hostd is updating the engines now; an engine update is not cut off either. */
  engineUpdateRunning(): Promise<boolean>;
  gate: { hold(reason: string): () => void };
  /**
   * Starts the restart, detached from the bridge, writing to `log`; answers
   * its pid. `failed` is told if the process could not be started after all,
   * which Node says only later.
   */
  spawnApply(args: readonly string[], log: string, failed: (error: Error) => void): number;
  /** Whether a pid is still the restart's process (`isRestartProcess`), not some other one that reused its number. */
  isAlive(pid: number): boolean;
  /** Other installs running from this checkout now; see `otherInstallsRunning`. */
  otherInstalls?: () => CheckoutInstall[];
  /** The bridge's environment, which says whether this is a cloud install (`OPENADLC_CLOUD=gcp`); `process.env` when absent. */
  env?: NodeJS.ProcessEnv;
  /** How a cloud install is rolled; made from `env` when absent, and none when null. */
  cloud?: CloudUpdate | null;
  /** How often the wait looks at the tasks. */
  pollMs?: number;
  /** How often the restarted bridge looks for the restart's result. */
  resultPollMs?: number;
  /** How long a restart may go without a result before it counts as lost. */
  restartMaxMs?: number;
  log?: (line: string) => void;
}

/** A step of preparing that failed, named as `selfUpdateLast.step` names it. */
class StepFailed extends Error {
  constructor(
    readonly step: string,
    reason: string,
  ) {
    super(reason);
  }
}

/** How long one release's preparation may take, most of it `pnpm install`. */
const INSTALL_TIMEOUT_MS = 30 * 60_000;
/** How often the candidate is asked for between runs. */
const CANDIDATE_EVERY_MS = 15 * 60_000;
/** How big each file of a release may be. */
const ASSET_LIMITS = { archive: 512 * 1024 * 1024, bundle: 4 * 1024 * 1024, checksums: 64 * 1024 };

function parse<T>(raw: string | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clip(text: string, limit = 600): string {
  const one = text.trim().replace(/\s+\n/g, '\n');
  return one.length > limit ? `${one.slice(0, limit - 1)}…` : one;
}

function short(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : 'unknown';
}

/** `owner/name` of a github.com remote, or null for any other. */
export function githubRepositoryOf(remote: string): string | null {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return match?.[1] ?? null;
}

/** The environment `gh` checks a release in: no GitHub credential, since `--bundle` needs none. */
function verifyEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete env[name];
  return env;
}

const settingsStore: SelfUpdateStore = {
  all: () => settings.allSettings(),
  set: (key, value, by) => settings.setSetting(key, value, by),
};

interface Applicability {
  applicable: boolean;
  reason: string;
  repo: string | null;
  head: string | null;
}

interface Choice {
  take: boolean;
  state?: 'current' | 'skipped' | 'failed';
  step?: string;
  reason: string;
  tag: string | null;
  sha: string | null;
  head: string | null;
  /** The releases to try, newest first, each fetched and a fast-forward on main's own history; a cloud install's names the files its release lists. */
  candidates: { tag: string; sha: string; assets?: readonly string[] }[];
}

/** How many releases GitHub is asked for a page at a time. */
const RELEASES_PER_PAGE = 30;

/** How many releases, newest first, a run tries before it gives up. */
const CANDIDATES = 5;

export class SelfUpdate {
  private readonly store: SelfUpdateStore;
  private readonly audit: NonNullable<SelfUpdateDeps['audit']>;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  /** The commit the services started on: read once, so a checkout moved under them is told apart. */
  private readonly started: Promise<{ sha: string; date: string | null; tag: string | null } | null>;
  /** The run this bridge is preparing, waiting on or restarting for. */
  private current: CloudSelfUpdateRun | null = null;
  /** What a run is starting: between the check and the run being written down. */
  private starting: Promise<unknown> | null = null;
  private letGo: (() => void) | null = null;
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  private waitingFor: LiveTask[] = [];
  private ghChecked: { at: number; problem: string | null } | null = null;
  /** On a cloud install, how it is rolled; null on one that runs from a checkout. */
  private readonly cloud: CloudUpdate | null;
  /** The release a cloud install's bridge runs, once known: its image does not change under it. */
  private cloudKnown: { sha: string; date: string | null; tag: string } | null = null;
  /** Why it could not be told, kept a few minutes: the row asks every few seconds during a run. */
  private cloudUnknown: { at: number; problem: string } | null = null;

  constructor(private readonly deps: SelfUpdateDeps) {
    this.store = deps.store ?? settingsStore;
    this.audit = deps.audit ?? audit;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? ((line) => console.log(`[bridge] ${line}`));
    // The module says it is a cloud install, which runs no checkout; that
    // is then a way of updating, not a reason not to.
    const found = deps.cloud === undefined ? cloudInstallFrom(deps.env ?? process.env) : null;
    this.cloud =
      deps.cloud !== undefined
        ? deps.cloud
        : found
          ? new CloudUpdate({
              install: found.install,
              missing: found.missing,
              fetch: deps.fetch,
              run: deps.run,
              workRoot: join(deps.home, 'self-update'),
              // What the bridge reads releases with, for the one request to GitHub's attestations API.
              ...(deps.token ? { githubToken: deps.token } : {}),
              log: this.log,
            })
          : null;
    this.started = this.cloud ? Promise.resolve(null) : this.headInfo().catch(() => null);
  }

  private git(args: readonly string[], timeoutMs = 120_000): Promise<string> {
    return this.deps.run('git', args, { cwd: this.deps.repoRoot, timeoutMs }).then((out) => out.trim());
  }

  private async isAncestor(older: string, newer: string): Promise<boolean> {
    return this.git(['merge-base', '--is-ancestor', older, newer]).then(
      () => true,
      () => false,
    );
  }

  private async headInfo(): Promise<{ sha: string; date: string | null; tag: string | null }> {
    const sha = await this.git(['rev-parse', 'HEAD']);
    const date = await this.git(['log', '-1', '--format=%cI', 'HEAD']).catch(() => null);
    // The highest version tag on it, when it is a release.
    const tags = (await this.git(['tag', '--points-at', 'HEAD']).catch(() => '')).split('\n').map((name) => name.trim());
    let tag: string | null = null;
    for (const name of tags) {
      const version = releaseVersion(name);
      const best = tag ? releaseVersion(tag) : null;
      if (version && (!best || compareVersions(version, best) > 0)) tag = name;
    }
    return { sha, date: date || null, tag };
  }

  private zone(all: Partial<Record<SettingKey, string>>): string {
    return timeZoneFrom(all.systemTimeZone ?? null, this.deps.timeZone ?? localTimeZone());
  }

  /** Words for a refused start: what is in flight, who started it, when. */
  private inFlight(run: SelfUpdateRun): HttpFailure {
    const step = (run as CloudSelfUpdateRun).cloud?.step;
    const doing =
      run.phase === 'preparing'
        ? this.cloud
          ? `is checking its images`
          : `is being prepared`
        : run.phase === 'waiting'
          ? `is waiting for ${this.waitingFor.length === 1 ? '1 task' : `${this.waitingFor.length} tasks`}`
          : this.cloud
            ? `is rolling the ${step === 'images' || !step ? 'console' : step}`
            : 'is restarting the install';
    return new HttpFailure(409, `an OpenADLC update to ${run.tag} ${doing}, started by ${run.actor} at ${run.startedAt}; press Update now again once it has finished`);
  }

  /** Why work may not start: a restart is owed. Null otherwise. Read by the dispatch gate's hold and `TaskService.openNow`. */
  restartPending(): string | null {
    if (!this.current || this.current.phase === 'preparing') return null;
    return `OpenADLC restarts onto ${this.current.tag} once the running tasks end`;
  }

  // ------------------------------------------------------------------ what can be done

  /** Whether `gh` here can check a release: on the PATH, and new enough for every flag the check uses. */
  private async ghProblem(): Promise<string | null> {
    if (this.ghChecked && Date.now() - this.ghChecked.at < 10 * 60_000) return this.ghChecked.problem;
    let problem: string | null = null;
    // A cloud bridge's gh is its image's: one from before release images
    // carried it is moved onto one by hand.
    const byHand = 'roll it onto a release by hand with openadlc cloud update --release <tag>';
    try {
      // A cloud bridge has no install home on its disk to run in.
      const help = await this.deps.run('gh', ['attestation', 'verify', '--help'], { cwd: this.cloud ? tmpdir() : this.deps.home, timeoutMs: 20_000, env: verifyEnv() });
      const missing = ATTESTATION_FLAGS.filter((flag) => !help.includes(flag));
      if (missing.length > 0) {
        problem = this.cloud
          ? `the GitHub CLI in the bridge's image cannot check a release's attestation (its gh attestation verify has no ${missing.join(', ')}): ${byHand}`
          : `the GitHub CLI here cannot check a release's attestation (its gh attestation verify has no ${missing.join(', ')}): update it (brew upgrade gh, or https://cli.github.com)`;
      }
    } catch (error) {
      problem = this.cloud
        ? `the GitHub CLI, which checks a release image's attestation, did not run in the bridge's image (${clip(message(error), 160)}), which is from before release images carried one: ${byHand}`
        : `the GitHub CLI, which checks a release's attestation, did not run here (${clip(message(error), 160)}): install it (https://cli.github.com) where the bridge runs`;
    }
    this.ghChecked = { at: Date.now(), problem };
    return problem;
  }

  /**
   * Whether this install can update itself, against the checkout itself. It
   * never stashes, merges, resets over or discards anything a person changed:
   * a checkout with changes, on another branch, or moved since the services
   * started is left alone, and says why.
   */
  private async applicability(): Promise<Applicability> {
    if (this.cloud) return this.cloudApplicability(this.cloud);
    const no = (reason: string, repo: string | null = null, head: string | null = null): Applicability => ({ applicable: false, reason, repo, head });
    const inside = await this.git(['rev-parse', '--is-inside-work-tree']).catch(() => '');
    if (inside !== 'true') {
      return no(`OpenADLC runs from ${this.deps.repoRoot}, which is not a git checkout, so it is updated where it was installed`);
    }
    // As configured, not as `insteadOf` rewrites it: which repository the
    // releases are read from is the one the checkout names.
    const remote = await this.git(['config', '--get', 'remote.origin.url']).catch(() => '');
    const repo = githubRepositoryOf(remote);
    if (!repo) return no(`the checkout's origin (${remote || 'none'}) is not a GitHub repository, so there are no releases to take`);
    const head = await this.git(['rev-parse', 'HEAD']).catch(() => null);
    const changed = await this.git(['status', '--porcelain', '--untracked-files=no']).catch((error: unknown) => `?? ${message(error)}`);
    if (changed) {
      const count = changed.split('\n').filter(Boolean).length;
      return no(
        `the checkout ${this.deps.repoRoot} has changes of its own (${count === 1 ? '1 file' : `${count} files`}), which an update never writes over: commit or stash them, or update by hand`,
        repo,
        head,
      );
    }
    const branch = await this.git(['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '');
    if (branch !== 'main') return no(`the checkout is ${branch ? `on ${branch}` : 'not on a branch'}, not main; releases are taken only onto main`, repo, head);
    const started = await this.started;
    if (started && head && started.sha !== head) {
      return no(
        `the checkout is at ${short(head)}, and the services started on ${short(started.sha)}: run openadlc down && openadlc up, then update`,
        repo,
        head,
      );
    }
    const others = (this.deps.otherInstalls ?? (() => otherInstallsRunning(this.deps.repoRoot, this.deps.home)))();
    if (others.length > 0) return no(sharedCheckoutReason(this.deps.repoRoot, others), repo, head);
    const gh = await this.ghProblem();
    if (gh) return no(gh, repo, head);
    return { applicable: true, reason: '', repo, head };
  }

  /**
   * Whether a cloud install can roll itself: the module let it (`self_update`
   * on, which is also what grants the bridge the deploy), told it what it
   * needs, and its image has a `gh` that can check a release; and the bridge
   * runs a release's image, so there is a release in use to take the next of.
   */
  private async cloudApplicability(cloud: CloudUpdate): Promise<Applicability> {
    const repo = cloud.install.repo;
    const no = (reason: string, head: string | null = null): Applicability => ({ applicable: false, reason, repo, head });
    if (!cloud.install.selfUpdate) {
      return no(
        `self-update is off on this install (the cloud module's self_update is false), so the bridge does not deploy its own services: roll it onto a release by hand with openadlc cloud update --release <tag>`,
        this.cloudKnown?.sha ?? null,
      );
    }
    if (cloud.missing.length > 0) return no(`the bridge was started without ${cloud.missing.join(', ')}, which the cloud module sets: run openadlc cloud apply, then update`);
    const gh = await this.ghProblem();
    if (gh) return no(gh);
    const inUse = await this.cloudInUse();
    if (!inUse.info) return no(inUse.problem ?? 'could not tell which release the bridge runs');
    return { applicable: true, reason: '', repo, head: inUse.info.sha };
  }

  /**
   * The release a cloud install's bridge runs: the one whose `service` image
   * is the digest of this bridge's own revision, its tag resolved at the
   * registry, newest release first. A bridge on anything else, an image built
   * from a checkout (`openadlc cloud configure --build`) or one by tag, runs
   * no release, and is moved onto one by hand.
   */
  private async cloudInUse(): Promise<{ info: { sha: string; date: string | null; tag: string } | null; problem: string | null }> {
    const cloud = this.cloud!;
    if (this.cloudKnown) return { info: this.cloudKnown, problem: null };
    if (this.cloudUnknown && Date.now() - this.cloudUnknown.at < 5 * 60_000) return { info: null, problem: this.cloudUnknown.problem };
    const repo = cloud.install.repo;
    const byHand = 'move it onto one by hand with openadlc cloud update --release <tag>';
    let problem: string;
    try {
      const image = await cloud.ownImage();
      const digest = digestOf(image);
      if (!digest) {
        problem = `the bridge runs ${image}, which is not a release's image by its digest, so it is not updated from releases: ${byHand}`;
      } else {
        // Page by page until a release's service image is this digest.
        let tag: string | null = null;
        const read = await this.releases(repo, async (got) => (tag ??= await cloud.releaseOf(repo, digest, takeableReleases(got).releases)) !== null);
        const releases = takeableReleases(read).releases;
        if (!tag) {
          problem = `the bridge runs ${digest}, which is the service image of none of ${repo}'s ${releases.length === 1 ? 'release' : `${releases.length} releases`}, so it is not updated from them: ${byHand}`;
        } else {
          const commit = await this.githubJson<{ sha?: unknown; commit?: { committer?: { date?: unknown } } }>(`/repos/${repo}/commits/${encodeURIComponent(tag)}`);
          // An answer, not a fact: checked before it is kept as the commit in use.
          if (!isCommitId(commit.sha)) throw new Error(`GitHub gave no commit for ${tag}`);
          // The record's word, or for a release from before records the
          // registry's, that this digest is the release's is checked as a
          // release's images are: the release in use decides the next one, and
          // an unchecked lookup would let it skip one.
          const unchecked = await cloud.checkImage(repo, 'service', digest, tag, commit.sha);
          if (unchecked) {
            const recorded = read.some((release) => release.tag === tag && recordsImageDigests(release));
            const named = recorded ? `${tag} recorded the bridge's image as its own` : `the registry names the bridge's image ${tag}'s`;
            problem = `${named}, but ${unchecked}, so which release it runs is not known: ${byHand}`;
          } else {
            const date = commit.commit?.committer?.date;
            this.cloudKnown = { sha: commit.sha, date: typeof date === 'string' ? date : null, tag };
            this.cloudUnknown = null;
            return { info: this.cloudKnown, problem: null };
          }
        }
      }
    } catch (error) {
      problem = `could not tell which release the bridge runs: ${clip(message(error), 400)}`;
    }
    this.cloudUnknown = { at: Date.now(), problem };
    return { info: null, problem };
  }

  // ------------------------------------------------------------------ the releases

  private async githubJson<T>(path: string): Promise<T> {
    const token = this.deps.token ? await this.deps.token().catch(() => null) : null;
    const response = await this.deps.fetch(`https://api.github.com${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'openadlc-self-update',
        'x-github-api-version': '2022-11-28',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path}`);
    return (await response.json()) as T;
  }

  /**
   * The repository's releases, newest first: the first page, which holds the
   * newest a checkout takes, or, given `enough`, page after page until it
   * says the pages read hold what is wanted (`readReleasePages`). A cloud
   * install needs the release it runs, which can be a page or more down.
   */
  private async releases(repo: string, enough: Parameters<typeof readReleasePages>[1] = () => true): Promise<PublishedRelease[]> {
    return readReleasePages(
      async (page) => {
        const listed = await this.githubJson<
          { tag_name: string; draft: boolean; prerelease: boolean; published_at: string | null; immutable?: boolean; assets: { name: string }[] }[]
        >(`/repos/${repo}/releases?per_page=${RELEASES_PER_PAGE}${page > 1 ? `&page=${page}` : ''}`);
        return listed.map((release) => ({
          tag: release.tag_name,
          draft: release.draft,
          prerelease: release.prerelease,
          publishedAt: release.published_at,
          assets: (release.assets ?? []).map((asset) => asset.name),
          immutable: release.immutable === true,
        }));
      },
      enough,
      { perPage: RELEASES_PER_PAGE },
    );
  }

  /** The releases through the one in use: it and every version above it. */
  private releasesThrough(repo: string, inUse: string): Promise<PublishedRelease[]> {
    return this.releases(repo, (_, all) => all.some((release) => release.tag === inUse));
  }

  /**
   * The releases to try, newest first, or why none: version tags with all
   * three files that GitHub holds immutable, fetched with `main` into the
   * checkout's refs (nothing else of the checkout is written), each on main's
   * own history and a fast-forward from the commit in use. A release refused
   * here is passed over for the next older one, so one bad release does not
   * stall every update after it.
   */
  private async choose(repo: string, head: string): Promise<Choice> {
    const nothing = (state: Choice['state'], reason: string, extra: Partial<Choice> = {}): Choice => ({
      take: false,
      state,
      reason,
      tag: null,
      sha: null,
      head,
      candidates: [],
      ...extra,
    });
    let listed: PublishedRelease[];
    try {
      listed = await this.releases(repo);
    } catch (error) {
      return nothing('failed', `could not read ${repo}'s releases: ${message(error)}`, { step: 'releases' });
    }
    const { releases: takeable, incomplete, mutable } = takeableReleases(listed);
    if (takeable.length === 0) return nothing('current', noReleaseReason(repo, incomplete, mutable));
    try {
      await this.git(['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
    } catch (error) {
      return nothing('failed', `could not fetch main: ${clip(message(error), 300)}`, { step: 'fetch' });
    }
    const firstParents = new Set((await this.git(['rev-list', '--first-parent', 'refs/remotes/origin/main'], 60_000)).split('\n'));
    const candidates: { tag: string; sha: string }[] = [];
    const refused: { state: 'skipped' | 'failed'; step?: string; reason: string; tag: string; sha: string | null }[] = [];
    for (const release of takeable.slice(0, CANDIDATES)) {
      const tag = release.tag;
      try {
        // No `+`: a tag this checkout already has on another commit is refused
        // rather than moved, as a tag that moved on GitHub should be.
        await this.git(['fetch', '--no-tags', 'origin', `refs/tags/${tag}:refs/tags/${tag}`]);
      } catch (error) {
        const words = message(error);
        refused.push({
          state: 'failed',
          step: 'fetch',
          tag,
          sha: null,
          reason: /rejected|clobber/.test(words)
            ? `the tag ${tag} on origin is not the commit this checkout has for it, so it is not taken: ${clip(words, 300)}`
            : `could not fetch ${tag}: ${clip(words, 300)}`,
        });
        continue;
      }
      const sha = await this.git(['rev-parse', `refs/tags/${tag}^{commit}`]);
      // This release and every older one are behind what runs.
      if (sha === head) {
        if (candidates.length === 0 && refused.length === 0) return nothing('current', `on ${tag}, the newest release`, { tag, sha });
        break;
      }
      if (await this.isAncestor(sha, head)) {
        if (candidates.length === 0 && refused.length === 0) return nothing('current', `this checkout is ahead of the newest release, ${tag}`, { tag, sha });
        break;
      }
      if (!(await this.isAncestor(head, sha))) {
        refused.push({ state: 'skipped', tag, sha, reason: `the checkout cannot fast-forward from ${short(head)} to ${tag} (${short(sha)}), so it is left as it is` });
        continue;
      }
      if (!firstParents.has(sha)) {
        refused.push({ state: 'failed', step: 'tag', tag, sha, reason: `${tag} is on ${short(sha)}, which is not a commit of main's own history, so it is not taken` });
        continue;
      }
      candidates.push({ tag, sha });
    }
    if (candidates.length > 0) {
      for (const one of refused) await this.passOver(one.tag, one.reason);
      return { take: true, reason: '', tag: candidates[0]!.tag, sha: candidates[0]!.sha, head, candidates };
    }
    const first = refused[0];
    if (!first) return nothing('current', `on the newest release this checkout can take`);
    return nothing(first.state, refused.map((one) => one.reason).join('; '), { tag: first.tag, sha: first.sha, ...(first.step ? { step: first.step } : {}) });
  }

  /** `owner/name` as GitHub spells it, for the one the remote names in any case. */
  private async canonicalRepository(repo: string): Promise<string> {
    const answer = await this.githubJson<{ full_name?: unknown }>(`/repos/${repo}`).catch((error: unknown) => {
      throw new Error(`could not read ${repo} from GitHub: ${message(error)}`);
    });
    const name = answer.full_name;
    if (typeof name !== 'string' || name.toLowerCase() !== repo.toLowerCase()) {
      throw new Error(
        this.cloud
          ? `the cloud module's release_repo names ${repo}, which GitHub calls ${String(name)}: set it to ${String(name)} and run openadlc cloud apply, then update`
          : `the checkout's origin names ${repo}, which GitHub calls ${String(name)}: point origin at ${String(name)} (git remote set-url origin …), then update`,
      );
    }
    return name;
  }

  /** A release a run passed over for an older one, in the audit log: the person should know one was refused. */
  private async passOver(tag: string, reason: string): Promise<void> {
    this.log(`self-update: passed over ${tag}: ${safeWords(reason)}`);
    await this.audit({ actor: 'openadlc', action: 'openadlc.release_refused', target: 'openadlc', payload: { tag, reason: clip(safeWords(reason), 1000) } }).catch(() => undefined);
  }

  /** Asks again what an update would take, at most every quarter hour unless `force`. */
  async refreshCandidate(force = false): Promise<SelfUpdateCandidate | null> {
    const all = await this.store.all();
    const stored = parse<SelfUpdateCandidate>(all[KEY.candidate]);
    if (!force && stored && this.now().getTime() - new Date(stored.checkedAt).getTime() < CANDIDATE_EVERY_MS) return stored;
    const check = await this.applicability();
    if (!check.repo || !check.head) return stored;
    let candidate: SelfUpdateCandidate;
    try {
      if (this.cloud && this.cloudKnown) {
        candidate = await this.cloudCandidate(check.repo, this.cloudKnown.tag);
        await this.store.set(KEY.candidate, JSON.stringify(candidate), 'openadlc');
        return candidate;
      }
      const { release, incomplete, mutable } = latestRelease(await this.releases(check.repo));
      if (!release) {
        candidate = { tag: null, sha: null, publishedAt: null, reason: noReleaseReason(check.repo, incomplete, mutable), checkedAt: this.now().toISOString() };
      } else {
        const commit = await this.githubJson<{ sha: unknown }>(`/repos/${check.repo}/commits/${encodeURIComponent(release.tag)}`).catch(() => null);
        // An answer, not a fact: checked before git is given it.
        const sha = isCommitId(commit?.sha) ? commit.sha : null;
        const known = sha ? await this.git(['cat-file', '-e', `${sha}^{commit}`]).then(() => true, () => false) : false;
        const reason =
          sha === check.head
            ? `on ${release.tag}, the newest release`
            : sha && known && (await this.isAncestor(sha, check.head))
              ? `this checkout is ahead of the newest release, ${release.tag}`
              : '';
        candidate = { tag: reason ? null : release.tag, sha, publishedAt: release.publishedAt, reason: reason || `${release.tag} is the newest release`, checkedAt: this.now().toISOString() };
      }
    } catch (error) {
      candidate = { tag: stored?.tag ?? null, sha: stored?.sha ?? null, publishedAt: stored?.publishedAt ?? null, reason: `could not ask GitHub for releases: ${clip(message(error), 200)}`, checkedAt: this.now().toISOString() };
    }
    await this.store.set(KEY.candidate, JSON.stringify(candidate), 'openadlc');
    return candidate;
  }

  /** What a cloud install would take: the next release after the one it runs, and the newest when that is further. */
  private async cloudCandidate(repo: string, inUse: string): Promise<SelfUpdateCandidate> {
    const checkedAt = this.now().toISOString();
    const listed = await this.releasesThrough(repo, inUse);
    const { incomplete, mutable } = takeableReleases(listed);
    const { next, newest } = nextRelease(listed, inUse);
    const why = next ? untakeableReason(next) : null;
    // The release that runs, and the one a run would take: a tag of either pushed again since is said on the row.
    const moved = await this.movedTags(repo, [listed.find((release) => release.tag === inUse), why ? null : next]);
    const also = moved.length > 0 ? { moved } : {};
    if (!next) {
      return { tag: null, sha: null, publishedAt: null, reason: listed.some((release) => release.tag === inUse) ? `on ${inUse}, the newest release` : noReleaseReason(repo, incomplete, mutable), checkedAt, ...also };
    }
    if (why) return { tag: null, sha: null, publishedAt: null, reason: nextReleaseRefused(next.tag, why, inUse), checkedAt, ...also };
    const commit = await this.githubJson<{ sha: unknown }>(`/repos/${repo}/commits/${encodeURIComponent(next.tag)}`).catch(() => null);
    const further = newest && newest.tag !== next.tag ? newest.tag : null;
    return {
      tag: next.tag,
      sha: isCommitId(commit?.sha) ? commit.sha : null,
      publishedAt: next.publishedAt,
      reason: further ? nextReleaseNote(next.tag, further) : `${next.tag} is the next release`,
      checkedAt,
      newest: further,
      ...also,
    };
  }

  /** The tags of these releases that name another digest at the registry now than the release recorded. Never throws: one that cannot be read is not compared. */
  private async movedTags(repo: string, releases: readonly (PublishedRelease | null | undefined)[]): Promise<MovedImageTag[]> {
    const moved: MovedImageTag[] = [];
    for (const release of releases) if (release) moved.push(...(await this.cloud!.movedTags(repo, release).catch(() => [])));
    return moved;
  }

  // ------------------------------------------------------------------ the view

  async view(): Promise<SelfUpdateView> {
    const now = this.now();
    const all = await this.store.all().catch(() => ({}) as Partial<Record<SettingKey, string>>);
    const schedule = selfUpdateScheduleFrom(all[KEY.schedule]);
    const zone = this.zone(all);
    const check = await this.applicability().catch((error: unknown) => ({ applicable: false, reason: message(error), repo: null, head: null }));
    const started = this.cloud ? (await this.cloudInUse().catch(() => ({ info: null }))).info : await this.started;
    const candidate = parse<SelfUpdateCandidate>(all[KEY.candidate]);
    const last = parse<SelfUpdateLast>(all[KEY.last]);
    const run = this.current ?? parse<CloudSelfUpdateRun>(all[KEY.run]);
    const scheduled = schedule.mode === 'schedule';
    const asSchedule = { enabled: true, day: schedule.day, time: schedule.time };
    const slot = schedule.slot ? new Date(schedule.slot) : null;
    return {
      backend: this.cloud ? 'cloud' : 'checkout',
      repository: this.cloud ? this.cloud.install.repo : check.repo,
      inUse: started,
      candidate: candidate?.tag ? { tag: candidate.tag, sha: candidate.sha, publishedAt: candidate.publishedAt, ...(candidate.newest ? { newest: candidate.newest } : {}) } : null,
      candidateReason: candidate?.reason ?? 'not asked yet',
      checkedAt: candidate?.checkedAt ?? null,
      schedule: { mode: schedule.mode, day: schedule.day, time: schedule.time },
      timeZone: zone,
      nextRun: scheduled ? nextSlotAfter(now, asSchedule, zone).toISOString() : null,
      due: scheduled && isDue(now, asSchedule, slot, zone),
      applicable: check.applicable,
      reason: check.reason,
      running: run ? { ...run, waitingFor: run.phase === 'waiting' ? this.waitingFor : [] } : null,
      last,
      attention: selfUpdateAttention(last),
      movedTags: this.cloud ? movedTagsSaid(this.cloud.install.repo, [...(candidate?.moved ?? []), ...(run?.cloud?.moved ?? [])]) : [],
    };
  }

  // ------------------------------------------------------------------ a run

  /**
   * Starts a run: checks the install and chooses the release now, and
   * prepares it in the background. Refused, naming it, while one is in flight.
   * Answers once the run is written down, or once it ended without one.
   */
  async start(input: { trigger: SelfUpdateTrigger; actor: string }): Promise<void> {
    if (this.current) throw this.inFlight(this.current);
    if (this.starting) throw new HttpFailure(409, 'an OpenADLC update is starting; press Update now again once it has finished');
    const persisted = parse<SelfUpdateRun>((await this.store.all())[KEY.run]);
    if (persisted) throw this.inFlight(persisted);
    const begun = this.begin(input);
    this.starting = begun;
    try {
      await begun;
    } finally {
      this.starting = null;
    }
  }

  private async begin(input: { trigger: SelfUpdateTrigger; actor: string }): Promise<void> {
    const startedAt = this.now().toISOString();
    const ended = (state: SelfUpdateLast['state'], reason: string, extra: Partial<SelfUpdateLast> = {}) =>
      this.record({ state, trigger: input.trigger, actor: input.actor, from: null, to: null, tag: null, reason, startedAt, finishedAt: this.now().toISOString(), ...extra });

    const check = await this.applicability();
    if (!check.applicable || !check.repo || !check.head) {
      await ended('skipped', check.reason, { from: check.head, to: check.head });
      return;
    }
    // The name as GitHub has it: the certificate names the repository so, and
    // a remote spelled in another case would fail the check on every release.
    let repo: string;
    try {
      repo = await this.canonicalRepository(check.repo);
    } catch (error) {
      await ended('failed', message(error), { from: check.head, to: check.head, step: 'releases' });
      return;
    }
    const choice = this.cloud ? await this.cloudChoose(repo, check.head) : await this.choose(repo, check.head);
    if (!choice.take || !choice.tag || !choice.sha) {
      await ended(choice.state ?? 'current', choice.reason, {
        from: check.head,
        to: check.head,
        tag: choice.tag,
        ...(choice.step ? { step: choice.step } : {}),
      });
      return;
    }
    const run: CloudSelfUpdateRun = {
      phase: 'preparing',
      tag: choice.tag,
      from: check.head,
      to: choice.sha,
      trigger: input.trigger,
      actor: input.actor,
      startedAt,
      pid: null,
      ...(this.cloud && this.cloudKnown ? { cloud: { fromTag: this.cloudKnown.tag, step: 'images' as const, target: null, previous: null, rolled: [] } } : {}),
    };
    this.current = run;
    await this.store.set(KEY.run, JSON.stringify(run), input.actor);
    void this.prepare(run, repo, choice.candidates).catch((error: unknown) => this.log(`self-update: preparing ${run.tag} ended unexpectedly: ${message(error)}`));
  }

  /**
   * Phase one: everything beside the install. The releases are tried newest
   * first until one's files are the release's and its attestation checks; one
   * that fails is passed over, in the audit log. Any later failure removes
   * what it made and records why.
   */
  private async prepare(first: CloudSelfUpdateRun, repo: string, candidates: Choice['candidates']): Promise<void> {
    if (this.cloud) return this.checkImages(this.cloud, first, repo, candidates[0]?.assets ?? []);
    let run = first;
    const refused: StepFailed[] = [];
    let verified: { paths: ReturnType<typeof selfUpdatePaths>; archive: string } | null = null;
    for (const candidate of candidates.length > 0 ? candidates : [{ tag: first.tag, sha: first.to }]) {
      const paths = selfUpdatePaths(this.deps.home, candidate.tag);
      try {
        const archive = await this.fetchAndCheck(repo, candidate.tag, candidate.sha, paths);
        verified = { paths, archive };
        if (candidate.tag !== run.tag) {
          run = { ...run, tag: candidate.tag, to: candidate.sha };
          this.current = run;
          await this.store.set(KEY.run, JSON.stringify(run), 'openadlc');
        }
        break;
      } catch (error) {
        const failed = error instanceof StepFailed ? error : new StepFailed('prepare', message(error));
        refused.push(new StepFailed(failed.step, `${candidate.tag}: ${failed.message}`));
        await this.removeStaging(paths);
        if (candidates.length > 1) await this.passOver(candidate.tag, failed.message);
      }
    }
    if (!verified) {
      const last = refused.at(-1)!;
      await this.failRun(run, last.step, refused.length === 1 ? last.message.slice(run.tag.length + 2) : refused.map((one) => one.message).join('; '));
      return;
    }
    const { paths, archive } = verified;
    try {
      const { entries } = await this.step('archive', async () => {
        const read = readArchive(archive);
        const tree = await this.git(['rev-parse', `${run.to}^{tree}`]);
        const { manifest } = read;
        if (manifest.tag !== run.tag || manifest.commit !== run.to || manifest.tree !== tree) {
          throw new Error(
            `the archive says it was built from ${manifest.tag} at ${short(manifest.commit)} (tree ${short(manifest.tree)}), not ${run.tag} at ${short(run.to)} (tree ${short(tree)})`,
          );
        }
        return read;
      });

      await this.step('worktree', () => this.git(['worktree', 'add', '--detach', paths.tree, run.to]));
      await this.step('unpack', async () => {
        unpackArchive(entries, paths.tree);
      });
      // The dependencies' install scripts run here, with nothing of the bridge's environment.
      await this.step('install', () =>
        this.deps.run('pnpm', ['install', '--frozen-lockfile'], { cwd: paths.tree, timeoutMs: INSTALL_TIMEOUT_MS, env: releaseInstallEnv() }),
      );
      // The release's own CLI is what restarts the install: it has to load.
      await this.step('check', () =>
        this.deps.run(process.execPath, [join(paths.tree, 'apps/cli/dist/main.js'), '--help'], { cwd: paths.tree, timeoutMs: 60_000, env: releaseInstallEnv() }),
      );
    } catch (error) {
      await this.removeStaging(paths);
      await this.failRun(run, error instanceof StepFailed ? error.step : 'prepare', message(error));
      return;
    }
    await this.wait({ ...run, phase: 'waiting' });
  }

  /**
   * Downloads a release's three files and checks them, the archive against
   * `SHA256SUMS` and then its attestation; answers the archive's path. Nothing
   * of the archive is read before both pass.
   */
  private async fetchAndCheck(repo: string, tag: string, commit: string, paths: ReturnType<typeof selfUpdatePaths>): Promise<string> {
    const names = releaseAssets(tag);
    const file = (name: string) => join(paths.download, name);
    await this.removeStaging(paths);
    mkdirSync(paths.download, { recursive: true, mode: 0o700 });
    await this.step('download', async () => {
      await this.download(releaseAssetUrl(repo, tag, names.checksums), file(names.checksums), ASSET_LIMITS.checksums);
      await this.download(releaseAssetUrl(repo, tag, names.bundle), file(names.bundle), ASSET_LIMITS.bundle);
      await this.download(releaseAssetUrl(repo, tag, names.archive), file(names.archive), ASSET_LIMITS.archive);
    });
    await this.step('checksum', async () => {
      const stated = checksumOf(readFileSync(file(names.checksums), 'utf8'), names.archive);
      if (!stated) throw new Error(`${names.checksums} does not give one SHA-256 for ${names.archive}`);
      const actual = createHash('sha256').update(readFileSync(file(names.archive))).digest('hex');
      if (actual !== stated) throw new Error(`${names.archive} has SHA-256 ${actual}, and ${names.checksums} says ${stated}: the download is not the release's`);
    });
    await this.step('attestation', async () => {
      // The documented check, and what it verified read back: the run behind
      // the attestation was the tag's push, started by release.yml at it.
      const verified = await this.deps
        .run('gh', [...attestationCheckArgs({ archive: file(names.archive), bundle: file(names.bundle), repo, tag, commit }), '--format', 'json'], {
          cwd: paths.download,
          timeoutMs: 120_000,
          env: verifyEnv(),
        })
        .catch((error: unknown) => {
          throw new Error(`gh attestation verify refused ${names.archive}, so it is not unpacked: ${clip(message(error), 500)}`);
        });
      const problem = attestationRunProblem(verified, { repo, tag });
      if (problem) throw new Error(`${problem}, so ${names.archive} is not unpacked`);
    });
    return file(names.archive);
  }

  /** A run that ended at a step before the restart, with the install as it was. */
  private async failRun(run: SelfUpdateRun, step: string, reason: string): Promise<void> {
    await this.record({
      state: 'failed',
      trigger: run.trigger,
      actor: run.actor,
      from: run.from,
      to: run.from,
      tag: run.tag,
      step,
      reason: `${clip(reason, 1500)}. The install is as it was`,
      startedAt: run.startedAt,
      finishedAt: this.now().toISOString(),
    });
  }

  private async step<T>(name: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof StepFailed) throw error;
      throw new StepFailed(name, error instanceof ArchiveRefused ? error.message : message(error));
    }
  }

  /** One file of a release, from the release's own address, no larger than `limit`. Carries no credential. */
  private async download(url: string, to: string, limit: number): Promise<void> {
    const response = await this.deps.fetch(url, { redirect: 'follow', headers: { 'user-agent': 'openadlc-self-update' }, signal: AbortSignal.timeout(10 * 60_000) });
    if (!response.ok || !response.body) throw new Error(`${url} answered ${response.status}`);
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > limit) throw new Error(`${url} is ${declared} bytes, more than a release's file may be`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > limit) throw new Error(`${url} is more than ${limit} bytes, more than a release's file may be`);
      chunks.push(Buffer.from(chunk));
    }
    writeFileSync(to, Buffer.concat(chunks), { mode: 0o600 });
  }

  /** Removes a run's worktree, downloads and the output it kept aside. Never throws. */
  private removeStaging(paths: ReturnType<typeof selfUpdatePaths>): Promise<void> {
    const removed = (async () => {
      if (existsSync(paths.tree)) await this.git(['worktree', 'remove', '--force', paths.tree]).catch(() => undefined);
      await this.git(['worktree', 'prune']).catch(() => undefined);
      rmSync(paths.root, { recursive: true, force: true });
    })().catch((error: unknown) => this.log(`self-update: could not remove ${paths.root}: ${message(error)}`));
    this.removing = removed;
    return removed;
  }

  /** The last removal, for a caller (a test) that waits for it. */
  removing: Promise<void> = Promise.resolve();

  /**
   * Phase two. Holds new work and looks at the tasks every poll; restarts once
   * two looks in a row, a poll apart, find nothing queued or running and no
   * engine update. Paused tasks do not count: a question can stay open for
   * days, and one answered meanwhile is resumed by the bridge that comes up.
   */
  private async wait(run: CloudSelfUpdateRun): Promise<void> {
    // Written down before it holds anything: a hold this bridge could not
    // write down would hold every start until it restarted.
    try {
      await this.store.set(KEY.run, JSON.stringify(run), 'openadlc');
    } catch (error) {
      if (!this.cloud) await this.removeStaging(selfUpdatePaths(this.deps.home, run.tag));
      await this.failRun(run, 'wait', `the wait could not be written down (${message(error)})`).catch((failure: unknown) =>
        this.log(`self-update: could not record the failed wait: ${message(failure)}`),
      );
      return;
    }
    this.current = run;
    this.letGo ??= this.deps.gate.hold(this.restartPending() ?? `OpenADLC restarts onto ${run.tag} once the running tasks end`);
    let empty = 0;
    const look = async (): Promise<void> => {
      this.waitTimer = null;
      if (this.current !== run) return;
      const live = await this.deps.liveTasks().catch(() => null);
      // hostd not answering is not "no engine update": it may be mid-swap.
      const engines = await this.deps.engineUpdateRunning().catch(() => true);
      this.waitingFor = live ?? this.waitingFor;
      empty = live && live.length === 0 && !engines ? empty + 1 : 0;
      if (empty >= 2) {
        await this.restart(run);
        return;
      }
      this.waitTimer = setTimeout(() => void look(), this.deps.pollMs ?? 30_000);
      this.waitTimer.unref?.();
    };
    await look();
  }

  /** Phase three: the detached restart, from the release's own CLI; on a cloud install, the roll. */
  private async restart(run: CloudSelfUpdateRun): Promise<void> {
    if (this.cloud) return this.roll(this.cloud, run);
    const paths = selfUpdatePaths(this.deps.home, run.tag);
    const cli = join(paths.tree, 'apps/cli/dist/main.js');
    let pid: number;
    try {
      if (!existsSync(cli)) throw new Error(`${cli} is gone`);
      mkdirSync(dirname(paths.log), { recursive: true, mode: 0o700 });
      rmSync(paths.result, { force: true });
      // Written down before the spawn: the restart stops this bridge, and the
      // one that comes up must find a restart, not a wait, or it records a
      // finished update as failed.
      const starting: SelfUpdateRun = { ...run, phase: 'restarting', pid: null };
      this.current = starting;
      await this.store.set(KEY.run, JSON.stringify(starting), 'openadlc');
      pid = this.deps.spawnApply(
        [cli, 'self-update', 'apply', '--checkout', this.deps.repoRoot, '--staging', paths.root, '--tag', run.tag, '--from', run.from, '--to', run.to],
        paths.log,
        (error) => void this.spawnFailed(run, error),
      );
    } catch (error) {
      await this.removeStaging(paths);
      await this.record({
        state: 'failed',
        trigger: run.trigger,
        actor: run.actor,
        from: run.from,
        to: run.from,
        tag: run.tag,
        step: 'restart',
        reason: `the restart could not start (${message(error)}). The install is as it was`,
        startedAt: run.startedAt,
        finishedAt: this.now().toISOString(),
      });
      return;
    }
    const restarting: SelfUpdateRun = { ...run, phase: 'restarting', pid };
    this.current = restarting;
    await this.store.set(KEY.run, JSON.stringify(restarting), 'openadlc').catch((error: unknown) =>
      this.log(`self-update: could not write down the restart's pid ${pid}: ${message(error)}`),
    );
    this.log(`self-update: restarting onto ${run.tag} (pid ${pid}); see ${paths.log}`);
    // Its preflight can refuse before it stops anything, and this bridge then
    // goes on running: it records that, and lets the hold go.
    this.followRestart(restarting);
  }

  /** The restart's process could not start after all: nothing was stopped, and the hold goes. */
  private async spawnFailed(run: SelfUpdateRun, error: Error): Promise<void> {
    if (this.current?.startedAt !== run.startedAt || this.current.phase !== 'restarting') return;
    await this.removeStaging(selfUpdatePaths(this.deps.home, run.tag));
    await this.record({
      state: 'failed',
      trigger: run.trigger,
      actor: run.actor,
      from: run.from,
      to: run.from,
      tag: run.tag,
      step: 'restart',
      reason: `the restart could not start (${message(error)}). The install is as it was`,
      startedAt: run.startedAt,
      finishedAt: this.now().toISOString(),
    }).catch((failure: unknown) => this.log(`self-update: could not record the restart that did not start: ${message(failure)}`));
  }

  /**
   * Writes a run's end down, once: the last result, the audit log, and the
   * run in flight cleared, with the hold let go.
   */
  private async record(last: SelfUpdateLast): Promise<void> {
    // A failure stays the last result, and its card stays, until a run
    // updates or finds the install current: a run skipped meanwhile, for a
    // checkout with changes say, is in the audit log and the row's reason.
    // What a command said can hold a credential: kept only once made safe.
    last = { ...last, reason: clip(safeWords(last.reason), 2000) };
    try {
      const before = parse<SelfUpdateLast>((await this.store.all())[KEY.last]);
      if (!(last.state === 'skipped' && before?.state === 'failed')) {
        await this.store.set(KEY.last, JSON.stringify(last), 'openadlc');
      }
      await this.store.set(KEY.run, '', 'openadlc');
    } finally {
      // Whatever the settings did: a run that ended holds no more work.
      this.current = null;
      this.waitingFor = [];
      if (this.waitTimer) clearTimeout(this.waitTimer);
      this.waitTimer = null;
      this.letGo?.();
      this.letGo = null;
    }
    const action = last.state === 'updated' ? 'openadlc.updated' : last.state === 'failed' ? 'openadlc.update_failed' : 'openadlc.update_checked';
    await this.audit({
      actor: last.actor,
      action,
      target: 'openadlc',
      payload: {
        trigger: last.trigger,
        actor: last.actor,
        from: last.from,
        to: last.to,
        tag: last.tag,
        outcome: last.state,
        reason: clip(last.reason, 1000),
        ...(last.step ? { step: last.step } : {}),
        ...(last.restoredTo ? { restoredTo: last.restoredTo } : {}),
      },
    }).catch((error: unknown) => this.log(`self-update: could not write the audit entry: ${message(error)}`));
    if (last.state === 'failed') this.log(`self-update: ${last.tag ?? 'the update'} failed at ${last.step ?? 'a step'}: ${last.reason}`);
  }

  /** The restart's result, recorded once, with the run it finished; false when there is none. */
  private async recordResult(run: SelfUpdateRun | null): Promise<boolean> {
    const paths = selfUpdatePaths(this.deps.home, run?.tag ?? 'none');
    if (!existsSync(paths.result)) return false;
    const result: SelfUpdateResultFile | null = parseResultFile(readFileSync(paths.result, 'utf8'));
    if (!result) {
      // The restart writes it whole (a file renamed into place), so this was not its.
      this.log(`self-update: ${paths.result} is not a result the restart wrote; it is left for a person to look at`);
      return false;
    }
    await this.removeStaging(selfUpdatePaths(this.deps.home, result.tag));
    await this.record({
      state: result.state,
      trigger: run?.trigger ?? 'schedule',
      actor: run?.actor ?? 'openadlc',
      from: result.from,
      to: result.to,
      tag: result.tag,
      reason: result.reason,
      ...(result.step ? { step: result.step } : {}),
      ...(result.restoredTo ? { restoredTo: result.restoredTo } : {}),
      startedAt: run?.startedAt ?? result.finishedAt,
      finishedAt: result.finishedAt,
    });
    // Only once it is recorded: a bridge that fails to record it finds it again.
    rmSync(paths.result, { force: true });
    return true;
  }

  /**
   * At bridge start: a run a restart finished is recorded from its result
   * file; one that was waiting goes on waiting; one that was being prepared,
   * or a restart that left no result and is not running, is recorded failed.
   */
  async resume(): Promise<string[]> {
    if (this.cloud) return this.resumeCloud(parse<CloudSelfUpdateRun>((await this.store.all())[KEY.run]));
    const run = parse<SelfUpdateRun>((await this.store.all())[KEY.run]);
    if (await this.recordResult(run)) return [`recorded the OpenADLC update to ${run?.tag ?? 'a release'}`];
    if (!run) return [];
    const paths = selfUpdatePaths(this.deps.home, run.tag);
    const failed = (step: string, reason: string, to = run.from) =>
      this.record({ state: 'failed', trigger: run.trigger, actor: run.actor, from: run.from, to, tag: run.tag, step, reason, startedAt: run.startedAt, finishedAt: this.now().toISOString() });
    if (run.phase === 'preparing') {
      await this.removeStaging(paths);
      await failed('prepare', `the bridge restarted while it prepared ${run.tag}, so it was given up; the next run tries again. The install is as it was`);
      return [`gave up the OpenADLC update to ${run.tag} that was being prepared`];
    }
    if (run.phase === 'waiting') {
      if (!existsSync(join(paths.tree, 'apps/cli/dist/main.js'))) {
        await this.removeStaging(paths);
        await failed('prepare', `the prepared ${run.tag} is gone from ${paths.tree}; the next run prepares it again. The install is as it was`);
        return [`gave up the OpenADLC update to ${run.tag}: what was prepared is gone`];
      }
      void this.wait(run);
      return [`the OpenADLC update to ${run.tag} goes on waiting for the running tasks`];
    }
    // No pid: the bridge stopped between writing the restart down and
    // spawning it, or before it wrote the pid. Its result may still come.
    if (run.pid === null || this.deps.isAlive(run.pid)) {
      this.current = run;
      this.followRestart(run);
      return [`the OpenADLC restart onto ${run.tag} is still running${run.pid ? ` (pid ${run.pid})` : ''}`];
    }
    await failed('restart', `the restart onto ${run.tag} ended without a result; see ${paths.log}, and run openadlc up if a service is down`, run.to);
    return [`the OpenADLC restart onto ${run.tag} left no result`];
  }

  /**
   * Looks for the restart's result while its process runs: its `up` starts the
   * next bridge before it has finished, and its preflight can refuse while this
   * one still runs. A pid can be another process's after a reboot, so a
   * restart that leaves nothing within the hour counts as lost.
   */
  private followRestart(run: SelfUpdateRun): void {
    const began = Date.now();
    const look = async (): Promise<void> => {
      if (this.current !== run) return;
      if (await this.recordResult(run)) return;
      const lost = Date.now() - began > (this.deps.restartMaxMs ?? 60 * 60_000);
      if (lost || (run.pid !== null && !this.deps.isAlive(run.pid))) {
        if (await this.recordResult(run)) return;
        const paths = selfUpdatePaths(this.deps.home, run.tag);
        await this.record({ state: 'failed', trigger: run.trigger, actor: run.actor, from: run.from, to: run.to, tag: run.tag, step: 'restart', reason: `the restart onto ${run.tag} ${lost ? 'left no result within the hour' : 'ended without a result'}; see ${paths.log}, and run openadlc up if a service is down`, startedAt: run.startedAt, finishedAt: this.now().toISOString() });
        return;
      }
      const timer = setTimeout(() => void look(), this.deps.resultPollMs ?? 5_000);
      timer.unref?.();
    };
    void look();
  }

  // ------------------------------------------------------------------ a cloud install

  /**
   * The release a cloud run takes: the next after the one in use, never a
   * later one, however far ahead the newest is. A next release that cannot
   * be taken (a mutable one, one without its files) stops the run with why,
   * and so does one that then fails its check: passing it over, as a
   * checkout passes over a bad release, would be the skip the next-release
   * rule is there to prevent.
   */
  private async cloudChoose(repo: string, head: string): Promise<Choice> {
    const nothing = (state: Choice['state'], reason: string, extra: Partial<Choice> = {}): Choice => ({ take: false, state, reason, tag: null, sha: null, head, candidates: [], ...extra });
    const inUse = this.cloudKnown?.tag;
    if (!inUse) return nothing('skipped', 'could not tell which release the bridge runs');
    let listed: PublishedRelease[];
    try {
      listed = await this.releasesThrough(repo, inUse);
    } catch (error) {
      return nothing('failed', `could not read ${repo}'s releases: ${message(error)}`, { step: 'releases' });
    }
    const { incomplete, mutable } = takeableReleases(listed);
    const { next, newest } = nextRelease(listed, inUse);
    if (!next) return nothing('current', listed.some((release) => release.tag === inUse) ? `on ${inUse}, the newest release` : noReleaseReason(repo, incomplete, mutable));
    const why = untakeableReason(next);
    if (why) return nothing('failed', nextReleaseRefused(next.tag, why, inUse), { step: 'releases', tag: next.tag });
    let sha: string;
    try {
      const commit = await this.githubJson<{ sha: unknown }>(`/repos/${repo}/commits/${encodeURIComponent(next.tag)}`);
      if (!isCommitId(commit.sha)) throw new Error('GitHub answered no commit id');
      sha = commit.sha;
    } catch (error) {
      return nothing('failed', `could not read ${next.tag}'s commit from GitHub: ${message(error)}`, { step: 'releases', tag: next.tag });
    }
    if (newest && newest.tag !== next.tag) this.log(`self-update: ${nextReleaseNote(next.tag, newest.tag)}`);
    return { take: true, reason: '', tag: next.tag, sha, head, candidates: [{ tag: next.tag, sha, assets: next.assets }] };
  }

  /**
   * Phase one on a cloud install: the release's images, each the digest it
   * recorded (or its tag resolved, for a release from before records) and
   * checked, while tasks run and nothing changes. A tag that names another
   * digest now is said in the log, the audit log and the row, and the
   * recorded digest is what rolls.
   */
  private async checkImages(cloud: CloudUpdate, run: CloudSelfUpdateRun, repo: string, assets: readonly string[]): Promise<void> {
    let checked;
    try {
      checked = await cloud.verify(repo, { tag: run.tag, assets }, run.to);
    } catch (error) {
      await this.failRun(run, 'images', `${message(error)}; ${ONE_RELEASE_AT_A_TIME}, so it stays on ${run.cloud?.fromTag ?? 'its release'} until ${run.tag} checks out, or until it is rolled past ${run.tag} by hand (openadlc cloud update --release <tag>)`);
      return;
    }
    for (const moved of checked.moved) {
      const words = movedTagWords(repo, moved);
      this.log(`self-update: ${words}`);
      await this.audit({ actor: 'openadlc', action: 'openadlc.release_tag_moved', target: 'openadlc', payload: { ...moved } }).catch(() => undefined);
    }
    await this.wait({
      ...run,
      phase: 'waiting',
      cloud: { ...(run.cloud ?? { fromTag: '', step: 'images', previous: null, rolled: [] }), target: checked.images, ...(checked.moved.length > 0 ? { moved: checked.moved } : {}) },
    });
  }

  /**
   * Phase three on a cloud install, once no task runs: (a) the console, (b)
   * hostd, (c) the bridge itself, each only once the one before serves on
   * the release. Before (a) it reads what each runs, so a stop can say what
   * goes back, and asks hostd whether a task holds the host, and changes
   * nothing if either fails. Each step is written down before it starts, (c)
   * above all: this bridge is replaced by it, and the one that comes up
   * finishes the run from the record. A part already on the release (a roll
   * cut off and gone on with) is not rolled again; a service whose roll
   * failed is put back on what it ran.
   */
  private async roll(cloud: CloudUpdate, run: CloudSelfUpdateRun): Promise<void> {
    const state = run.cloud;
    const target = state?.target;
    if (!state || !target) {
      await this.failRun(run, 'images', `the run for ${run.tag} has no checked images on record`);
      return;
    }
    const rolled: CloudPart[] = [...state.rolled];
    let previous: CloudBefore | null = state.previous;
    try {
      const [console, bridge, host] = await Promise.all([
        previous ? null : cloud.serviceImage('console'),
        previous ? null : cloud.serviceImage('bridge'),
        rolled.includes('host') ? null : cloud.hostImage(),
      ]);
      // The bridge's wait counts the tasks the database has; hostd counts
      // what runs on the host. Asked now, a task there stops the run before
      // the console moves, not after.
      if (host && host.busy.length > 0) {
        throw new Error(`hostd says ${host.busy.length === 1 ? 'a task runs' : `${host.busy.length} tasks run`} on the host (${host.busy.join(', ')}), which a restart would end; the next run tries again`);
      }
      // On a fresh install the host runs the module's hostd_image, a tag: it
      // is what goes back, and the roll goes on, since the release in use is
      // the bridge's.
      previous ??= { console: console!, bridge: bridge!, service: host?.service ?? null };
    } catch (error) {
      // Nothing rolled unless this is a roll gone on with after a restart.
      if (rolled.length === 0 || !previous) await this.failRun(run, 'console', `before anything was rolled, ${message(error)}`);
      else await this.cloudFailed(run, rolled.includes('console') ? 'host' : 'console', message(error), rolled, previous);
      return;
    }
    // Written before it is this bridge's run: a run it could not write down
    // is one the bridge that comes up would never find.
    const stage = async (step: CloudPart, extra: { generation?: number } = {}): Promise<CloudSelfUpdateRun> => {
      const next: CloudSelfUpdateRun = { ...run, phase: 'restarting', cloud: { ...state, ...extra, step, target, previous: previous!, rolled: [...rolled] } };
      await this.store.set(KEY.run, JSON.stringify(next), 'openadlc');
      this.current = next;
      return next;
    };
    let step: CloudPart = 'console';
    try {
      await stage('console');
      if (!rolled.includes('console')) {
        try {
          await cloud.roll('console', target.console);
        } catch (error) {
          const back = await this.putBack('console', previous.console);
          await this.cloudFailed(run, 'console', `${message(error)}${back.words}`, rolled, previous, back.asItWas);
          return;
        }
        rolled.push('console');
      }
      step = 'host';
      await stage('host');
      if (!rolled.includes('host')) {
        await cloud.restartHost(target);
        rolled.push('host');
      }
      step = 'bridge';
      // Before the call: this instance is replaced by it.
      let replacing = await stage('bridge');
      let generation: number;
      try {
        generation = await cloud.requestRoll('bridge', target.service);
      } catch (error) {
        const back = await this.putBack('bridge', previous.bridge);
        await this.cloudFailed(run, 'bridge', `${message(error)}${back.words}`, rolled, previous, back.asItWas);
        return;
      }
      replacing = await stage('bridge', { generation }).catch(() => replacing);
      this.log(`self-update: the console and the host run ${run.tag}; the bridge is being replaced by one on ${target.service}`);
      this.followBridge(replacing, 'replacing');
    } catch (error) {
      await this.cloudFailed(run, step, message(error), rolled, previous);
    }
  }

  /** A part's service back on what it ran before a failed roll, in the words a stop adds. */
  private async putBack(part: 'console' | 'bridge', image: string): Promise<{ words: string; asItWas: boolean }> {
    try {
      const changed = await this.cloud!.putBack(part, image);
      return { words: changed ? `; the ${part}'s service is back on ${image}` : '', asItWas: true };
    } catch (error) {
      return { words: `; putting the ${part}'s service back on ${image} failed too (${clip(message(error), 300)}), so it still names the image that failed`, asItWas: false };
    }
  }

  /** A cloud run that stopped at a step: what rolled and what did not, and what finishes it or goes back. */
  private async cloudFailed(run: CloudSelfUpdateRun, step: CloudPart, problem: string, rolled: readonly CloudPart[], previous: CloudBefore | null, asItWas = true): Promise<void> {
    await this.record({
      state: 'failed',
      trigger: run.trigger,
      actor: run.actor,
      from: run.from,
      // On the release in part: the card says the update did not finish.
      to: rolled.length > 0 ? run.to : run.from,
      tag: run.tag,
      step,
      reason: cloudStopReason({ problem, tag: run.tag, fromTag: run.cloud?.fromTag ?? 'the release it had', rolled, target: run.cloud?.target ?? null, previous, install: this.cloud!.install, asItWas }),
      startedAt: run.startedAt,
      finishedAt: this.now().toISOString(),
    });
  }

  /**
   * The bridge's own update, followed until its service settles. The bridge
   * being replaced (`replacing`) leaves the record to the bridge on the
   * release once the new revision serves; the bridge on the release
   * (`replaced`) records the update then, and not before, so an update is
   * never recorded for a revision that has not taken the traffic. Either
   * records a revision that never serves, with the service put back. New work
   * stays held meanwhile.
   */
  private followBridge(run: CloudSelfUpdateRun, as: 'replacing' | 'replaced'): void {
    const began = Date.now();
    const target = run.cloud!.target!;
    const failed = async (problem: string): Promise<void> => {
      const previous = run.cloud!.previous;
      const back = previous ? await this.putBack('bridge', previous.bridge) : { words: '', asItWas: false };
      await this.cloudFailed(run, 'bridge', `${problem}${back.words}`, run.cloud!.rolled, previous, back.asItWas);
    };
    const look = async (): Promise<void> => {
      if (this.current !== run) return;
      const state = await this.cloud!.rollState('bridge', target.service, run.cloud!.generation ?? 0).catch((error: unknown) => ({ state: 'pending' as const, why: message(error) }));
      if (this.current !== run) return;
      if (state.state === 'serving') {
        if (as === 'replacing') {
          this.log(`self-update: the bridge on ${run.tag} serves; it records the update`);
          return;
        }
        await this.record({
          state: 'updated',
          trigger: run.trigger,
          actor: run.actor,
          from: run.from,
          to: run.to,
          tag: run.tag,
          reason: cloudUpdatedReason(run.tag, target),
          startedAt: run.startedAt,
          finishedAt: this.now().toISOString(),
        });
        return;
      }
      if (state.state === 'failed') {
        await failed(state.reason);
        return;
      }
      if (Date.now() - began > (this.deps.restartMaxMs ?? 60 * 60_000)) {
        await failed(`the bridge's new revision was not serving within the hour`);
        return;
      }
      const timer = setTimeout(() => void look(), this.deps.resultPollMs ?? 5_000);
      timer.unref?.();
    };
    void look();
  }

  /**
   * At a cloud bridge's start, or a tick after one that could not: a run whose
   * last step was the bridge's own update is finished by the bridge on the
   * release, from the record and the image it runs, once its revision serves.
   * Any other bridge is the one being replaced, started again: it follows the
   * service, as the one that asked for the update did.
   */
  private async finishCloud(run: CloudSelfUpdateRun): Promise<string[]> {
    const target = run.cloud?.target;
    if (!target) return [];
    let own: string;
    try {
      own = await this.cloud!.ownImage();
    } catch (error) {
      this.log(`self-update: could not tell which image this bridge runs, to finish the update to ${run.tag}: ${message(error)}`);
      return [`the OpenADLC update to ${run.tag} is recorded once this bridge can tell which image it runs`];
    }
    this.current = run;
    if (own === target.service) {
      this.followBridge(run, 'replaced');
      return [`this bridge runs ${run.tag}, and records the update once its revision serves`];
    }
    this.followBridge(run, 'replacing');
    return [`this bridge runs ${own}, and follows the bridge's update to ${run.tag}`];
  }

  /** A cloud bridge's start: the checkout's `resume`, for a roll. */
  private async resumeCloud(run: CloudSelfUpdateRun | null): Promise<string[]> {
    if (!run) return [];
    const failed = (step: string, reason: string) =>
      this.record({ state: 'failed', trigger: run.trigger, actor: run.actor, from: run.from, to: run.from, tag: run.tag, step, reason, startedAt: run.startedAt, finishedAt: this.now().toISOString() });
    if (run.phase === 'preparing') {
      await failed('images', `the bridge restarted while it checked ${run.tag}'s images, so the run was given up; the next run checks them again. The install is as it was`);
      return [`gave up the OpenADLC update to ${run.tag} whose images were being checked`];
    }
    if (!run.cloud?.target) {
      await failed('images', `the run for ${run.tag} has no checked images on record, so it was given up. The install is as it was`);
      return [`gave up the OpenADLC update to ${run.tag}: it has no checked images`];
    }
    if (run.phase === 'restarting' && run.cloud.step === 'bridge') return this.finishCloud(run);
    // Waiting, or cut off partway through the roll: it waits for the tasks
    // again, holding new work, and goes on from what had rolled.
    void this.wait({ ...run, phase: 'waiting' });
    return [
      run.phase === 'waiting'
        ? `the OpenADLC update to ${run.tag} goes on waiting for the running tasks`
        : `the OpenADLC update to ${run.tag} goes on from the ${run.cloud.step} once no task runs`,
    ];
  }

  // ------------------------------------------------------------------ the clock

  /**
   * The scheduled job. The first look claims this week's slot and runs
   * nothing, so an install never updates itself the moment it upgrades; the
   * slot is claimed before a run starts, so a bridge that restarts mid-run
   * does not start a second. Refreshes what an update would take.
   */
  async tick(): Promise<string[]> {
    const lines: string[] = [];
    if (this.cloud) {
      // A bridge that came up on the release and could not record it then
      // (the database away at its start) records it now.
      const persisted = parse<CloudSelfUpdateRun>((await this.store.all())[KEY.run]);
      if (!this.current && persisted?.phase === 'restarting' && persisted.cloud?.step === 'bridge') lines.push(...(await this.finishCloud(persisted)));
    } else if (!this.current && (await this.recordResult(parse<SelfUpdateRun>((await this.store.all())[KEY.run])))) {
      lines.push('recorded the OpenADLC update the restart finished');
    }
    const now = this.now();
    const all = await this.store.all();
    const schedule = selfUpdateScheduleFrom(all[KEY.schedule]);
    const zone = this.zone(all);
    if (!this.current && !parse<SelfUpdateRun>(all[KEY.run])) await this.refreshCandidate().catch(() => null);
    if (schedule.mode === 'manual') return [...lines, 'OpenADLC updates only when somebody presses Update now'];
    const asSchedule = { enabled: true, day: schedule.day, time: schedule.time };
    const slot = lastSlotAtOrBefore(now, asSchedule, zone);
    const next = nextSlotAfter(now, asSchedule, zone).toISOString();
    if (!schedule.slot) {
      await this.store.set(KEY.schedule, JSON.stringify({ ...schedule, slot: slot.toISOString() }), 'schedule');
      return [...lines, `OpenADLC updates every ${schedule.day} at ${schedule.time} (${zone}); the first is at ${next}`];
    }
    if (!isDue(now, asSchedule, new Date(schedule.slot), zone)) return [...lines, `the next OpenADLC update is at ${next}`];
    await this.store.set(KEY.schedule, JSON.stringify({ ...schedule, slot: slot.toISOString() }), 'schedule');
    try {
      await this.start({ trigger: 'schedule', actor: 'schedule' });
      const run = this.current;
      return [...lines, run ? `this week's OpenADLC update is preparing ${run.tag}` : `this week's OpenADLC update: ${parse<SelfUpdateLast>((await this.store.all())[KEY.last])?.reason ?? 'nothing to do'}`];
    } catch (error) {
      return [...lines, `this week's OpenADLC update did not start: ${message(error)}`];
    }
  }

  /**
   * Changes the schedule: Schedule or Manual, the day, the time. A schedule
   * turned on or moved counts from now, never from a slot that passed while it
   * said something else.
   */
  async setSchedule(input: Record<string, unknown>, actor: string): Promise<SelfUpdateView> {
    for (const key of Object.keys(input)) {
      if (!['mode', 'day', 'time'].includes(key)) throw new HttpFailure(400, `${key} is not part of OpenADLC's update schedule; send mode, day or time`);
    }
    const all = await this.store.all();
    const was = selfUpdateScheduleFrom(all[KEY.schedule]);
    const next = { ...was };
    if (input.mode !== undefined) {
      if (input.mode !== 'schedule' && input.mode !== 'manual') throw new HttpFailure(400, 'mode is schedule or manual');
      next.mode = input.mode;
    }
    if (input.day !== undefined) {
      const day = typeof input.day === 'string' ? input.day.trim().toLowerCase() : '';
      if (!(DAYS as readonly string[]).includes(day)) throw new HttpFailure(400, `day is one of ${DAYS.join(', ')}`);
      next.day = day as Day;
    }
    if (input.time !== undefined) {
      const time = typeof input.time === 'string' ? input.time.trim() : '';
      if (!TIME.test(time)) throw new HttpFailure(400, 'time is HH:MM on a 24-hour clock, such as 18:00');
      next.time = time;
    }
    const moved = next.mode === 'schedule' && (was.mode !== 'schedule' || was.day !== next.day || was.time !== next.time);
    if (moved) next.slot = lastSlotAtOrBefore(this.now(), { day: next.day, time: next.time }, this.zone(all)).toISOString();
    await this.store.set(KEY.schedule, JSON.stringify(next), actor);
    await this.audit({ actor, action: 'openadlc.schedule_changed', target: 'openadlc', payload: { mode: next.mode, day: next.day, time: next.time } });
    return this.view();
  }
}

/** Each moved tag once, in the words the row says it. */
function movedTagsSaid(repo: string, moved: readonly MovedImageTag[]): string[] {
  return [...new Set(moved.map((one) => movedTagWords(repo, one)))];
}

/** Why there is no release to take, naming the ones passed over. */
function noReleaseReason(repo: string, incomplete: readonly string[], mutable: readonly string[]): string {
  const passed: string[] = [];
  if (incomplete.length > 0) passed.push(`${incomplete.join(', ')} ${incomplete.length === 1 ? 'is a release' : 'are releases'} without all three files`);
  if (mutable.length > 0) {
    passed.push(`${mutable.join(', ')} ${mutable.length === 1 ? 'is not an immutable release' : 'are not immutable releases'}, so ${mutable.length === 1 ? 'its files' : 'their files'} could still be replaced (docs/development.md#once-per-repository)`);
  }
  return passed.length > 0 ? `${passed.join('; ')}: not taken, and no other release of ${repo} is published` : `no release of ${repo} is published yet`;
}

/** The last result, from settings, for the attention list. */
export async function selfUpdateAttentionFromSettings(store: SelfUpdateStore = settingsStore): Promise<SelfUpdateAttention | null> {
  const all = await store.all();
  return selfUpdateAttention(parse<SelfUpdateLast>(all[KEY.last]));
}

/** Runs a command, answering its standard output; a failure is its standard error, or how it ended. */
export function runCommand(command: string, args: readonly string[], options: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { cwd: options.cwd, env: options.env ?? process.env, timeout: options.timeoutMs ?? 120_000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return resolve(String(stdout));
        const said = String(stderr).trim() || String(stdout).trim();
        const how = (error as { killed?: boolean }).killed ? `timed out after ${Math.round((options.timeoutMs ?? 120_000) / 1000)}s` : `exited ${(error as { code?: unknown }).code ?? 'with an error'}`;
        reject(new Error(`${command} ${args.slice(0, 2).join(' ')} ${how}${said ? `: ${said.slice(-1500)}` : ''}`));
      },
    );
  });
}

/**
 * Starts `openadlc self-update apply` in a session of its own, so stopping the
 * services does not stop it. A process that cannot start is said by an
 * `error` event, later; with no listener, Node would end the bridge with it.
 */
export function spawnDetached(args: readonly string[], log: string, failed: (error: Error) => void): number {
  const out = openSync(log, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [...args], { detached: true, stdio: ['ignore', out, out], env: process.env, cwd: dirname(log) });
    child.once('error', failed);
    child.unref();
    if (!child.pid) throw new Error('the restart process did not start');
    return child.pid;
  } finally {
    closeSync(out);
  }
}

/**
 * Whether a pid is the restart's process: alive, and running `self-update
 * apply`, by its command line, as a keeper is told from another program. A
 * pid a reboot gave to something else would otherwise hold every start for
 * the hour the restart is followed.
 */
export function isRestartProcess(pid: number, commandLine: (pid: number) => string | null = processCommandLine): boolean {
  const line = commandLine(pid);
  if (line !== null) return line.includes('self-update apply');
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The console's routes: what OpenADLC runs and would take, Update now, and the schedule. */
export function registerSelfUpdateRoutes(router: Router, update: SelfUpdate): void {
  router.get('/v1/self-update', async () => update.view());

  router.post('/v1/self-update', async ({ identity }) => {
    await update.start({ trigger: 'console', actor: identity });
    return update.view();
  });

  router.patch('/v1/self-update', async ({ body, identity }) => {
    const input = await body<unknown>();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpFailure(400, 'send the parts of the schedule to change: mode, day, time');
    return update.setSchedule(input as Record<string, unknown>, identity);
  });
}
