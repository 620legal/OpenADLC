import { spawn as spawnChild, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { basename, join } from 'node:path';
import { internalSecretRef, getSecretStore, type SecretStore } from '@openadlc/github';
import { redactSecrets } from '@openadlc/shared';
import { HOST_CHECK_PATH, accountEnv, asAccount, nodeProcesses, type HostProcesses } from './account-probe.js';
import { KILL_AFTER_MS } from './drivers/types.js';
import { LOG_TAIL_BYTES, receiveScript } from './host-check.js';
import type { ReleaseAccountProbe } from './release-account.js';

/**
 * A release build: one commit on the default branch, pinned when a person
 * asked for it, built in the release account, and its artifact taken out by
 * hostd (#343,
 * docs/adr/0068-a-release-is-built-in-its-own-account-and-signed-from-fields-hostd-computes.md,
 * docs/adr/0070-a-release-recipe-is-an-admins-and-its-artifact-stays-with-hostd.md).
 *
 * It follows `HostChecks.execute` (`host-check.ts`), with what a release
 * needs on top:
 *
 * - The commit is the one the bridge sends, and only that: hostd fetches the
 *   default branch into its own mirror and refuses a SHA that is not an
 *   ancestor of it. A branch that moved on since still holds it, so the run
 *   builds the pinned SHA, not the branch's new tip.
 * - The version is read by hostd from its own mirror at that SHA
 *   (`git show <sha>:<file>`), never from the account's tree, and must be
 *   above the last release before anything is built: a wrong version costs
 *   seconds, not hours.
 * - The account keeps its build tree between releases and the next bundle is
 *   thin; `clean` removes the folder, as the account, first.
 * - The artifact comes out as `cat` run as the account, whose stdout hostd
 *   hashes as it writes it into a file of its own under the work root, which
 *   the account cannot enter (the probe proves it). hostd never opens,
 *   stats or resolves a path in the account's folder: a symlink there is
 *   followed by `cat` with the account's permissions, which reach nothing the
 *   install guards, and never with hostd's.
 * - Every field a release is signed with (#344) is hostd's: the version from
 *   its mirror and the sha256 and size of the stream. Nothing the account
 *   prints reaches them; its output is only the log tail and a reason.
 * - One release run at a time on this hostd, apart from host checks, which
 *   run as another account.
 * - Every run that got past the probe ends, a pass included, with TERM and
 *   then KILL to every process of the account, before the run ends.
 */

/** How long the git steps and the read of the artifact may take, apart from the run's own limit. */
const STEP_TIMEOUT_MS = 30 * 60_000;

/** How much of the version file hostd reads. */
export const VERSION_FILE_BYTES = 64 * 1024;

/** GitHub's limit on a release asset; a larger artifact could not be published. */
export const MAX_ARTIFACT_BYTES = 2 * 1024 ** 3;

/** How long an artifact folder is kept under the work root. */
export const ARTIFACT_KEPT_MS = 14 * 24 * 60 * 60_000;

/** How long a finished run is kept in memory; `run.json` keeps a built one for longer. */
const KEPT_MS = 60 * 60_000;

/** What to do when the release account's probe fails; the `release-account` card says the same. */
export const RELEASE_ACCOUNT_FIX = 'Make the account and its sudo rule as docs/self-hosting.md#the-release-account says, then run openadlc doctor';

/** Git's own settings that could run something of the mirror's, off for hostd's git. */
const GIT_ENV: Record<string, string> = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };

// ---------------------------------------------------------------------------
// The version rule. Pure, so #345 moves it unchanged to
// `packages/shared/src/release-version.ts`, and the bridge's early check and
// hostd's authoritative one are the same.
// ---------------------------------------------------------------------------

/**
 * A release version: 1 to 4 numbers, optionally `-<label>.<n>`. `n` is 0 with
 * no suffix. `text` is the exact string read, so the tag is `v${text}`.
 */
export interface ReleaseVersion {
  text: string;
  parts: number[];
  label: string | null;
  n: number;
}

/** The longest version: #342's manifest refuses a version over 64 characters (`releaseMessage`). */
export const VERSION_MAX_CHARS = 64;

const NUMBER = '(?:0|[1-9][0-9]*)';
const VERSION_GRAMMAR = new RegExp(`^(${NUMBER}(?:\\.${NUMBER}){0,3})(?:-([a-z][a-z0-9]{0,31})\\.(${NUMBER}))?$`);

const FORMS = '`<1 to 4 numbers>` or `<1 to 4 numbers>-<lowercase label>.<number>`';

/** The version a string is, or why it is none. `where` names the file the reason tells to change. */
export function versionFrom(text: string, where?: string): { ok: true; version: ReleaseVersion } | { ok: false; reason: string } {
  const refuse = (why = '') => ({
    ok: false as const,
    reason: `\`${text.length > 80 ? `${text.slice(0, 80)}…` : text}\` is not a release version${why}: write ${FORMS}${where ? ` in ${where}` : ''}`,
  });
  if (text.length > VERSION_MAX_CHARS) return refuse(` (it is longer than ${VERSION_MAX_CHARS} characters)`);
  const match = VERSION_GRAMMAR.exec(text);
  if (!match) return refuse();
  const parts = (match[1] ?? '').split('.').map(Number);
  const n = match[3] === undefined ? 0 : Number(match[3]);
  if ([...parts, n].some((value) => !Number.isSafeInteger(value))) return refuse(' (a number in it is too large)');
  return { ok: true, version: { text, parts, label: match[2] ?? null, n } };
}

/**
 * Reads the version from a version file's text, by the repository's file and
 * key: with no key, the whole file, trimmed; for a `.json` file, `key` is a
 * dotted path, `version` by default; for any other file with a key, the value
 * of the first `KEY = value` or `KEY: value` line, quotes taken off — which
 * reads `.xcconfig`'s `MARKETING_VERSION = 1.4.0`. No regular expression an
 * admin writes is run.
 */
export function parseVersion(text: string, file: string, key: string | null): { ok: true; version: ReleaseVersion } | { ok: false; reason: string } {
  if (file.toLowerCase().endsWith('.json')) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { ok: false, reason: `${file} is not JSON, so its version cannot be read: fix it, or set the repository's version file` };
    }
    const path = key ?? 'version';
    for (const step of path.split('.')) {
      value = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[step] : undefined;
    }
    if (typeof value !== 'string') return { ok: false, reason: `${file} has no string at ${path}: add the version there, or set the repository's version key` };
    return versionFrom(value, file);
  }
  if (!key) return versionFrom(text.trim(), file);
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(key)) continue;
    const rest = trimmed.slice(key.length).trimStart();
    if (!rest.startsWith('=') && !rest.startsWith(':')) continue;
    let value = rest.slice(1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    return versionFrom(value, file);
  }
  return { ok: false, reason: `${file} has no line \`${key} = <version>\`: add it, or set the repository's version key` };
}

/**
 * How two versions order: by their numbers, a missing trailing part being 0,
 * then by `n`, a bare version being `n = 0`. Not semver: a suffix ranks above
 * the bare version, as the shipped clients rank it. Null when both carry a
 * label and the labels differ: two labels are never ordered.
 */
export function compareVersions(a: ReleaseVersion, b: ReleaseVersion): -1 | 0 | 1 | null {
  if (a.label !== null && b.label !== null && a.label !== b.label) return null;
  const length = Math.max(a.parts.length, b.parts.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.parts[index] ?? 0;
    const y = b.parts[index] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (a.n !== b.n) return a.n < b.n ? -1 : 1;
  return 0;
}

/** Why `version` may not follow `after`, or null when it may. */
export function versionGate(version: ReleaseVersion, after: ReleaseVersion | null, file: string): string | null {
  if (!after) return null;
  const order = compareVersions(version, after);
  if (order === null) {
    return `${version.text} has the label ${version.label}, and the last release, ${after.text}, has ${after.label}: use ${after.label} in ${file}`;
  }
  if (order <= 0) return `${version.text} is not above the last release, ${after.text}: raise it in ${file}`;
  return null;
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

/** Every variable the build is given; `env -i` clears the rest. The SHA and version are hostd's own, given so a build can stamp them. */
export function releaseEnv(account: string, home: string, sha: string, version: string | null): Record<string, string> {
  return {
    ...accountEnv(account, home),
    CI: '1',
    OPENADLC_RELEASE: '1',
    OPENADLC_RELEASE_SHA: sha,
    OPENADLC_RELEASE_VERSION: version ?? '',
  };
}

export type ReleaseRunState = 'running' | 'built' | 'failed' | 'cancelled' | 'refused';

export interface ReleaseRunRequest {
  /** The bridge's id for it, which the report carries back; also the artifact's folder name. */
  runId: string;
  /** `owner/name`. */
  repo: string;
  /** The commit pinned when the release was asked for. */
  sha: string;
  defaultBranch: string;
  versionFile: string;
  versionKey: string | null;
  /** The last release's version, `v` taken off, or null for none. */
  after: string | null;
  /** From the repository's row, set by an admin; never from the repository's files. */
  command: string;
  /** The file the command leaves, relative to the working folder. */
  artifact: string;
  timeoutMinutes: number;
  /** Remove the kept build tree first. */
  clean: boolean;
  /** The crew account whose token fetches the default branch into hostd's mirror. */
  bot: string | null;
}

export interface ReleaseRunView extends ReleaseRunRequest {
  state: ReleaseRunState;
  /** hostd's, from its mirror at `sha`. */
  version: string | null;
  /** hostd's, of the bytes `cat` wrote. */
  sha256: string | null;
  bytes: number | null;
  artifactName: string | null;
  exitCode: number | null;
  durationMs: number | null;
  logTail: string;
  reason: string | null;
  startedAt: string;
  finishedAt: string | null;
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;

/**
 * A path in the account's working folder as an admin wrote it, or why it is
 * none: relative, no `..` or `.` segment, no leading `/` or `~`, no NUL,
 * newline or backslash, at most 300 characters. hostd never opens it: it is
 * an argument to `cat` as the account, or a path in hostd's mirror.
 */
export function relativePathProblem(value: unknown, name: string): string | null {
  if (typeof value !== 'string' || !value) return `${name} is a path relative to the working folder, such as build/App.zip`;
  if (value.length > 300) return `${name} is at most 300 characters`;
  if (/[\u0000\r\n\\]/.test(value)) return `${name} has no NUL, newline or backslash`;
  if (value.startsWith('/') || value.startsWith('~')) return `${name} is relative to the working folder: take off the leading ${value[0]}`;
  if (value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) return `${name} has no empty, . or .. part`;
  return null;
}

/** A start as the bridge sends it, or what is wrong with it. Only the bridge calls this route, with the install's secret; checked all the same. */
export function releaseRunRequestFrom(body: Record<string, unknown>): ReleaseRunRequest | string {
  const { runId, repo, sha, defaultBranch, versionFile, versionKey, after, command, artifact, timeoutMinutes, clean, bot } = body;
  if (typeof runId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(runId)) return 'runId must be an id';
  if (typeof repo !== 'string' || !REPO.test(repo) || repo.includes('..')) return 'repo must be owner/name';
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) return 'sha must be a full commit sha';
  if (typeof defaultBranch !== 'string' || !BRANCH.test(defaultBranch) || defaultBranch.includes('..') || defaultBranch.startsWith('-') || defaultBranch.startsWith('/')) {
    return 'defaultBranch must be a branch name';
  }
  const fileProblem = relativePathProblem(versionFile, 'versionFile');
  if (fileProblem) return fileProblem;
  if (versionKey !== undefined && versionKey !== null && (typeof versionKey !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(versionKey))) {
    return 'versionKey must be letters, digits, _, . and -, at most 100';
  }
  if (after !== undefined && after !== null && (typeof after !== 'string' || !versionFrom(after).ok)) return `after must be the last release's version, ${FORMS}, or null`;
  if (typeof command !== 'string' || !command.trim() || command.length > 500 || /[\u0000\n\r]/.test(command)) return 'command must be one line of at most 500 characters';
  const artifactProblem = relativePathProblem(artifact, 'artifact');
  if (artifactProblem) return artifactProblem;
  if (typeof timeoutMinutes !== 'number' || !Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 1440) return 'timeoutMinutes must be 1 to 1440';
  if (clean !== undefined && typeof clean !== 'boolean') return 'clean must be true or false';
  if (bot !== undefined && bot !== null && (typeof bot !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(bot))) return 'bot must be a bot name';
  return {
    runId,
    repo,
    sha,
    defaultBranch,
    versionFile: versionFile as string,
    versionKey: typeof versionKey === 'string' ? versionKey : null,
    after: typeof after === 'string' ? after : null,
    command,
    artifact: artifact as string,
    timeoutMinutes,
    clean: clean === true,
    bot: typeof bot === 'string' ? bot : null,
  };
}

/** What reading a stream as the account ended with. */
export interface ReadResult {
  code: number;
  stderr: string;
  timedOut: boolean;
}

/**
 * How hostd reads a command's stdout as bytes: `HostProcesses` decodes UTF-8,
 * which corrupts a binary. `onChunk` returning false stops the read and kills
 * the command. Injected so the tests can see every argv and feed any bytes.
 */
export interface ReleaseProcesses {
  read(argv: string[], onChunk: (chunk: Buffer) => boolean, timeoutMs: number): { done: Promise<ReadResult>; stop(): void };
}

/** `ReleaseProcesses` on this machine, with node's `child_process`. */
export function nodeReleaseProcesses(spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess = spawnChild): ReleaseProcesses {
  return {
    read(argv, onChunk, timeoutMs) {
      const [command = '', ...args] = argv;
      // The environment hostd's own `sudo` runs with: nothing of hostd's.
      const child = spawn(command, args, { env: { PATH: HOST_CHECK_PATH, LANG: 'en_US.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      let timedOut = false;
      const stop = () => {
        child.stdout?.removeAllListeners('data');
        child.kill('SIGTERM');
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => {
        if (!onChunk(chunk)) stop();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString('utf8')}`.slice(-10_000);
      });
      const done = new Promise<ReadResult>((resolve) => {
        child.on('error', (error) => {
          clearTimeout(timer);
          resolve({ code: 127, stderr: `${stderr}${error.message}`, timedOut });
        });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          resolve({ code: code ?? (signal ? 143 : 1), stderr, timedOut });
        });
      });
      return { done, stop };
    },
  };
}

export interface ReleaseRunDeps {
  /** The release account and its probe (`release-account.ts`). */
  account: { readonly account: string; probe(): Promise<ReleaseAccountProbe> };
  /** This install's id, so two installs' folders in the account's home are apart. */
  installId: string;
  /** hostd's work root: its mirror and the artifacts live under `<workRoot>/release`, where the account cannot enter. */
  workRoot: string;
  /** The clone URL for a repository. */
  remote(repoFullName: string): string;
  /** The git environment that carries a bot's token for one fetch; `{}` for none. */
  fetchAuth(bot: string | null, repoFullName: string, remote: string): Promise<Record<string, string>>;
  /** Tells the bridge a run ended; see `releaseReporter`. */
  report(run: ReleaseRunView): Promise<void>;
  processes?: HostProcesses;
  reader?: ReleaseProcesses;
  now?: () => number;
  killAfterMs?: number;
  /** How long a minute of the time limit is; only a test shortens it. */
  msPerMinute?: number;
  /** Only a test lowers it. */
  maxArtifactBytes?: number;
}

/** A second start while one release builds. */
export class ReleaseBusy extends Error {
  constructor(repo: string) {
    super(`a release of ${repo} is building; wait for it to end, or cancel it`);
  }
}

type Started = ReturnType<HostProcesses['start']>;
type Stopped = { reason: string; state: 'cancelled' | 'failed' };
type Outcome = {
  state: Exclude<ReleaseRunState, 'running'>;
  version?: string | null;
  sha256?: string;
  bytes?: number;
  artifactName?: string;
  exitCode?: number;
  durationMs?: number;
  logTail?: string;
  reason?: string;
};
type Held = ReleaseRunView & { stop?: (reason: string, state: Stopped['state']) => void };

/** What a built run left under the work root, as `run.json` keeps it. */
export interface KeptArtifact {
  runId: string;
  repo: string;
  sha: string;
  version: string;
  sha256: string;
  bytes: number;
  artifactName: string;
  finishedAt: string;
}

export class ReleaseRuns {
  private readonly runs = new Map<string, Held>();
  private current: Held | null = null;
  /** The commit last given to each repository's working folder, so the next bundle carries only what is new. */
  private readonly sent = new Map<string, string>();
  private readonly processes: HostProcesses;
  private readonly reader: ReleaseProcesses;
  private readonly now: () => number;
  private idle: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ReleaseRunDeps) {
    this.processes = deps.processes ?? nodeProcesses();
    this.reader = deps.reader ?? nodeReleaseProcesses();
    this.now = deps.now ?? Date.now;
  }

  private get root(): string {
    return join(this.deps.workRoot, 'release');
  }

  private artifactsDir(runId: string): string {
    return join(this.root, 'artifacts', runId);
  }

  /** Starts a run, or throws `ReleaseBusy` while one is going. */
  start(request: ReleaseRunRequest): ReleaseRunView {
    if (this.current) throw new ReleaseBusy(this.current.repo);
    this.forgetOld();
    this.removeOldArtifacts();
    const run: Held = {
      ...request,
      state: 'running',
      version: null,
      sha256: null,
      bytes: null,
      artifactName: null,
      exitCode: null,
      durationMs: null,
      logTail: '',
      reason: null,
      startedAt: new Date(this.now()).toISOString(),
      finishedAt: null,
    };
    this.runs.set(run.runId, run);
    this.current = run;
    this.idle = this.execute(run).finally(() => {
      this.current = null;
    });
    return view(run);
  }

  /** Stops a run; false when it is not going here. */
  cancel(runId: string, reason = 'the release was cancelled'): boolean {
    if (!this.current || this.current.runId !== runId) return false;
    this.current.stop?.(reason, 'cancelled');
    return true;
  }

  /** The run as hostd holds it in memory, else as its `run.json` kept it, else null. */
  get(runId: string): ReleaseRunView | null {
    const run = this.runs.get(runId);
    if (run) return view(run);
    const kept = this.kept(runId);
    if (!kept) return null;
    return {
      runId: kept.runId,
      repo: kept.repo,
      sha: kept.sha,
      state: 'built',
      version: kept.version,
      sha256: kept.sha256,
      bytes: kept.bytes,
      artifactName: kept.artifactName,
      finishedAt: kept.finishedAt,
      // Not kept: what the bridge's row has.
      defaultBranch: '',
      versionFile: '',
      versionKey: null,
      after: null,
      command: '',
      artifact: '',
      timeoutMinutes: 0,
      clean: false,
      bot: null,
      exitCode: null,
      durationMs: null,
      logTail: '',
      reason: null,
      startedAt: kept.finishedAt,
    };
  }

  /** A built run's artifact under the work root, for #344 to sign and upload; null when there is none. */
  artifact(runId: string): (KeptArtifact & { path: string }) | null {
    const kept = this.kept(runId);
    if (!kept) return null;
    const path = join(this.artifactsDir(runId), kept.artifactName);
    return fs.existsSync(path) ? { ...kept, path } : null;
  }

  /** Removes a run's artifact folder, once #344 has published it; false when there was none. */
  deleteArtifact(runId: string): boolean {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(runId) || this.current?.runId === runId) return false;
    const dir = this.artifactsDir(runId);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  /** Waits until nothing is running; for tests. */
  async settled(): Promise<void> {
    for (;;) {
      const idle = this.idle;
      await idle;
      if (idle === this.idle && !this.current) return;
    }
  }

  private kept(runId: string): KeptArtifact | null {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(runId)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(join(this.artifactsDir(runId), 'run.json'), 'utf8')) as KeptArtifact;
      return parsed && parsed.runId === runId && typeof parsed.artifactName === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }

  private async execute(run: Held): Promise<void> {
    const started = this.now();
    const halt: { stopped: Stopped | null; child: Started | null; killing: Promise<void> | null; reading: { stop(): void } | null } = {
      stopped: null,
      child: null,
      killing: null,
      reading: null,
    };
    const stop = (reason: string, state: Stopped['state']) => {
      if (halt.stopped) return;
      halt.stopped = { reason, state };
      if (halt.child && !halt.killing) halt.killing = this.kill(halt.child);
      halt.reading?.stop();
    };
    run.stop = stop;
    const stoppedNow = (): Stopped | null => halt.stopped;
    const limit = setTimeout(() => {
      const minutes = run.timeoutMinutes;
      stop(`it did not finish within ${minutes} minute${minutes === 1 ? '' : 's'}, so it was stopped: find what keeps it running, or raise the repository's release time limit`, 'failed');
    }, run.timeoutMinutes * (this.deps.msPerMinute ?? 60_000));
    limit.unref?.();
    /** The account's home once the probe passed: from then on the run ends by clearing the account. */
    const ctx: { home: string | null; version: string | null } = { home: null, version: null };
    let outcome: Outcome;
    try {
      outcome = await this.steps(run, halt, stoppedNow, ctx);
    } catch (error) {
      outcome = { state: 'failed', reason: `the release could not be built: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      clearTimeout(limit);
      delete run.stop;
    }
    // TERM and KILL to everything the account runs, on every end that got
    // past the probe, a pass included, before the run ends: what the build
    // left in the background must not run into the next release's tree.
    if (halt.killing) await halt.killing;
    if (ctx.home) await this.clearAccount(ctx.home, run, ctx.version).catch(() => undefined);
    // A step that threw because the run was stopped ends as the stop says.
    const end = stoppedNow();
    if (end && outcome.state === 'failed') outcome = { ...outcome, state: end.state, reason: end.reason };
    this.end(run, { durationMs: this.now() - started, ...outcome });
  }

  private async steps(
    run: Held,
    halt: { child: Started | null; killing: Promise<void> | null; reading: { stop(): void } | null },
    stoppedNow: () => Stopped | null,
    ctx: { home: string | null; version: string | null },
  ): Promise<Outcome> {
    const halted = (): Outcome | null => {
      const stopped = stoppedNow();
      return stopped ? { state: stopped.state, reason: stopped.reason } : null;
    };

    // 1. The account is fit, then cleared of anything it still runs.
    const fit = await this.deps.account.probe();
    if (!fit.ok) return { state: 'refused', reason: `${fit.detail}. ${RELEASE_ACCOUNT_FIX}` };
    ctx.home = fit.home;
    const home = fit.home;
    await this.clearAccount(home, run, null);
    const early = halted();
    if (early) return early;

    // 2. hostd's own mirror of the default branch, fetched with the token.
    const mirrorRoot = join(this.root, 'mirrors');
    fs.mkdirSync(mirrorRoot, { recursive: true, mode: 0o700 });
    const mirror = join(mirrorRoot, `${run.repo.replace('/', '__')}.git`);
    const git = (args: string[], env: Record<string, string> = {}) => this.processes.run(['git', ...args], { env: { ...env, ...GIT_ENV }, timeoutMs: STEP_TIMEOUT_MS });
    if (!fs.existsSync(mirror)) {
      const made = await git(['init', '--bare', '--quiet', mirror]);
      if (made.code !== 0) throw new Error(`hostd could not make its mirror for ${run.repo}: ${made.stderr.trim()}`);
    }
    const remote = this.deps.remote(run.repo);
    const auth = await this.deps.fetchAuth(run.bot, run.repo, remote);
    const fetched = await git(['-C', mirror, 'fetch', '--quiet', remote, `+refs/heads/${run.defaultBranch}:refs/openadlc/release/default`], auth);
    if (fetched.code !== 0) throw new Error(`hostd could not fetch ${run.defaultBranch} of ${run.repo}: ${fetched.stderr.trim().slice(0, 300)}`);

    // 3. On the default branch, by hostd's own fetch: the SHA is an ancestor
    // of it. A branch that moved on still holds it, and it is what is built.
    const sha7 = run.sha.slice(0, 7);
    const exists = await git(['-C', mirror, 'cat-file', '-e', `${run.sha}^{commit}`]);
    const ancestor = exists.code === 0 ? await git(['-C', mirror, 'merge-base', '--is-ancestor', run.sha, 'refs/openadlc/release/default']) : exists;
    if (exists.code !== 0 || ancestor.code !== 0) {
      return { state: 'refused', reason: `${sha7} is not on ${run.defaultBranch}: a release builds only a commit on the default branch` };
    }

    // 4. The version, from the mirror at the SHA, before anything is built.
    const shown = await git(['-C', mirror, 'show', `${run.sha}:${run.versionFile}`]);
    if (shown.code !== 0) return { state: 'refused', reason: `${run.versionFile} is not in ${sha7}: add it, or set the repository's version file` };
    if (Buffer.byteLength(shown.stdout) > VERSION_FILE_BYTES) return { state: 'refused', reason: `${run.versionFile} is larger than ${VERSION_FILE_BYTES / 1024} KiB: point the repository's version file at a smaller one` };
    const read = parseVersion(shown.stdout, run.versionFile, run.versionKey);
    if (!read.ok) return { state: 'refused', reason: read.reason };
    const after = run.after === null ? null : versionFrom(run.after);
    if (after && !after.ok) return { state: 'refused', reason: `the last release's version, ${run.after}, cannot be read` };
    const gate = versionGate(read.version, after ? (after as { ok: true; version: ReleaseVersion }).version : null, run.versionFile);
    if (gate) return { state: 'refused', reason: gate };
    const version = read.version.text;
    run.version = version;
    ctx.version = version;
    const stoppedBeforeGive = halted();
    if (stoppedBeforeGive) return stoppedBeforeGive;

    // 5. The code, as a bundle of only the pinned SHA, into the kept tree.
    const folder = join(home, 'openadlc', this.deps.installId, run.repo.replace('/', '__'));
    const key = run.repo.toLowerCase();
    const as = (argv: string[]) => asAccount(this.deps.account.account, releaseEnv(this.deps.account.account, home, run.sha, version), argv);
    if (run.clean) {
      const removed = await this.processes.run(as(['/bin/rm', '-rf', '--', folder]), { timeoutMs: STEP_TIMEOUT_MS });
      if (removed.code !== 0) throw new Error(`the kept build tree ${folder} could not be removed: ${(removed.stderr || removed.stdout).trim().slice(0, 300)}`);
      this.sent.delete(key);
    }
    const ref = 'refs/openadlc/release/build';
    const set = await git(['-C', mirror, 'update-ref', ref, run.sha]);
    if (set.code !== 0) throw new Error(`hostd could not point ${ref} at ${sha7}: ${set.stderr.trim().slice(0, 300)}`);
    const give = (since: string | null) =>
      this.processes.pipe(
        { argv: ['git', '-C', mirror, 'bundle', 'create', '-', ref, ...(since ? [`^${since}`] : [])], env: GIT_ENV },
        { argv: as(['/bin/sh', '-c', receiveScript('release'), 'sh', folder, run.sha]) },
        STEP_TIMEOUT_MS,
      );
    const last = this.sent.get(key) ?? null;
    let given = last && last !== run.sha ? await give(last) : null;
    if (!given || given.code !== 0) given = await give(null);
    if (given.code !== 0) throw new Error(`${sha7} could not be given to ${this.deps.account.account}'s working folder ${folder}: ${(given.stderr || given.stdout).trim().slice(0, 300)}`);
    this.sent.set(key, run.sha);
    const stoppedBeforeBuild = halted();
    if (stoppedBeforeBuild) return stoppedBeforeBuild;

    // 6. The build.
    let tail = '';
    const child = this.processes.start(as(['/bin/sh', '-c', 'cd "$1" && shift && exec /bin/sh -c "$1"', 'sh', folder, run.command]), (chunk) => {
      tail = `${tail}${chunk}`.slice(-LOG_TAIL_BYTES);
    });
    halt.child = child;
    if (stoppedNow() && !halt.killing) halt.killing = this.kill(child);
    const code = await child.exited;
    halt.killing ??= this.kill(child);
    await halt.killing;
    const built = { exitCode: code, logTail: tail, version };
    const stoppedInBuild = halted();
    if (stoppedInBuild) return { ...built, ...stoppedInBuild };
    if (code !== 0) return { ...built, state: 'failed', reason: `${run.command} exited ${code}: see the log` };

    // 7. The artifact, as `cat` run as the account, hashed as hostd writes it.
    const taken = await this.takeOut(run, as, folder, halt);
    if (!taken.ok) return { ...built, ...(halted() ?? { state: 'failed' as const, reason: taken.reason }) };

    // 8. What a release is signed from, kept beside the artifact for #344.
    const kept: KeptArtifact = {
      runId: run.runId,
      repo: run.repo,
      sha: run.sha,
      version,
      sha256: taken.sha256,
      bytes: taken.bytes,
      artifactName: taken.name,
      finishedAt: new Date(this.now()).toISOString(),
    };
    fs.writeFileSync(join(this.artifactsDir(run.runId), 'run.json'), `${JSON.stringify(kept, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    return { ...built, state: 'built', sha256: taken.sha256, bytes: taken.bytes, artifactName: taken.name };
  }

  /**
   * Streams the artifact out of the account's folder: `/bin/cat -- <path>` as
   * the account, each chunk hashed and written to a file hostd creates
   * exclusively in a folder of its own. hostd never opens, stats or resolves
   * the account's path.
   */
  private async takeOut(
    run: Held,
    as: (argv: string[]) => string[],
    folder: string,
    halt: { reading: { stop(): void } | null },
  ): Promise<{ ok: true; sha256: string; bytes: number; name: string } | { ok: false; reason: string }> {
    const name = basename(run.artifact);
    const dir = this.artifactsDir(run.runId);
    fs.mkdirSync(join(this.root, 'artifacts'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(dir, { mode: 0o700 });
    const file = join(dir, name);
    const fd = fs.openSync(file, 'wx', 0o600);
    const hash = createHash('sha256');
    const cap = this.deps.maxArtifactBytes ?? MAX_ARTIFACT_BYTES;
    let bytes = 0;
    let over = false;
    let result: ReadResult;
    try {
      const reading = this.reader.read(
        as(['/bin/cat', '--', `${folder}/${run.artifact}`]),
        (chunk) => {
          if (bytes + chunk.length > cap) {
            over = true;
            return false;
          }
          hash.update(chunk);
          fs.writeSync(fd, chunk);
          bytes += chunk.length;
          return true;
        },
        STEP_TIMEOUT_MS,
      );
      halt.reading = reading;
      result = await reading.done;
    } finally {
      halt.reading = null;
      fs.closeSync(fd);
    }
    const fail = (reason: string) => {
      fs.rmSync(dir, { recursive: true, force: true });
      return { ok: false as const, reason };
    };
    if (over) return fail(`${run.artifact} is larger than ${Math.round(cap / 1024 ** 2)} MiB, GitHub's limit for a release asset: make it smaller`);
    if (result.timedOut) return fail(`${run.artifact} could not be read within ${STEP_TIMEOUT_MS / 60_000} minutes`);
    if (result.code !== 0) return fail(`${run.artifact} could not be read as ${this.deps.account.account}: ${result.stderr.trim().slice(0, 300) || `cat exited ${result.code}`}. Check that ${run.command} leaves it there`);
    if (bytes === 0) return fail(`${run.artifact} is empty: check that ${run.command} writes it`);
    return { ok: true, sha256: hash.digest('hex'), bytes, name };
  }

  /** TERM, then KILL, to every process the account runs (`kill -1` as it), with no wait between. */
  private async clearAccount(home: string, run: ReleaseRunRequest, version: string | null): Promise<void> {
    const account = this.deps.account.account;
    for (const signal of ['TERM', 'KILL'] as const) {
      await this.processes.run(asAccount(account, releaseEnv(account, home, run.sha, version), ['/bin/kill', `-${signal}`, '-1']), { timeoutMs: 30_000 });
    }
  }

  /** TERM to everything the account runs, then KILL once `killAfterMs` has passed or the build has exited. */
  private async kill(child: Started): Promise<void> {
    await child.signalAll('TERM').catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([child.exited, new Promise((resolve) => (timer = setTimeout(resolve, this.deps.killAfterMs ?? KILL_AFTER_MS)))]);
    clearTimeout(timer);
    await child.signalAll('KILL').catch(() => undefined);
  }

  private end(run: Held, outcome: Outcome & { durationMs: number }): void {
    if (run.finishedAt) return;
    run.state = outcome.state;
    run.version = outcome.version ?? run.version;
    run.sha256 = outcome.sha256 ?? null;
    run.bytes = outcome.bytes ?? null;
    run.artifactName = outcome.artifactName ?? null;
    run.exitCode = outcome.exitCode ?? null;
    run.durationMs = outcome.durationMs;
    // Redacted here as well as in the bridge's table: the account holds no
    // credential, but a build can print one it found on the machine.
    run.logTail = redactSecrets(outcome.logTail ?? '');
    run.reason = outcome.reason === undefined ? null : redactSecrets(outcome.reason);
    run.finishedAt = new Date(this.now()).toISOString();
    // Only a built run keeps a version: a refused one's is said in its reason.
    if (run.state !== 'built') {
      run.sha256 = null;
      run.bytes = null;
      run.artifactName = null;
    }
    void this.deps.report(view(run)).catch((error: unknown) => {
      console.warn(
        `[hostd] release ${run.runId} of ${run.repo} at ${run.sha.slice(0, 7)} ${run.state}, but the bridge did not record it: ` +
          `${error instanceof Error ? error.message : String(error)}. The bridge's sweep asks again.`,
      );
    });
  }

  private forgetOld(): void {
    const cutoff = this.now() - KEPT_MS;
    for (const [id, run] of this.runs) {
      if (run.finishedAt && Date.parse(run.finishedAt) < cutoff) this.runs.delete(id);
    }
  }

  /** Artifact folders older than `ARTIFACT_KEPT_MS` go: hostd's own folders, under the work root. */
  private removeOldArtifacts(): void {
    const root = join(this.root, 'artifacts');
    let names: string[];
    try {
      names = fs.readdirSync(root);
    } catch {
      return;
    }
    const cutoff = this.now() - ARTIFACT_KEPT_MS;
    for (const name of names) {
      const dir = join(root, name);
      try {
        if (fs.statSync(dir).mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Gone already.
      }
    }
  }
}

function view(run: ReleaseRunView): ReleaseRunView {
  const { stop: _stop, ...rest } = run as Held;
  return { ...rest };
}

/**
 * Tells the bridge a release run ended, with the install's secret: the one way
 * its result is written (`POST /internal/release`).
 */
export function releaseReporter(bridgeUrl: string, store: SecretStore = getSecretStore()): (run: ReleaseRunView) => Promise<void> {
  return async (run) => {
    const secret = await store.get(internalSecretRef());
    if (!secret) throw new Error('hostd has no internal secret yet, so it cannot report the run. Start the bridge, which generates it: openadlc up');
    const response = await fetch(`${bridgeUrl}/internal/release`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openadlc-internal-secret': secret },
      body: JSON.stringify({
        runId: run.runId,
        state: run.state,
        version: run.version,
        sha256: run.sha256,
        bytes: run.bytes,
        artifactName: run.artifactName,
        exitCode: run.exitCode,
        durationMs: run.durationMs,
        logTail: run.logTail,
        reason: run.reason,
      }),
    });
    if (!response.ok) throw new Error(`the bridge answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  };
}
