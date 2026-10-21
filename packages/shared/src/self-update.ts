import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { redactSecrets } from './redact.js';

/**
 * OpenADLC updating itself from its own releases.
 *
 * A release is the contract in docs/self-hosting.md#what-a-release-holds:
 * `.github/workflows/release.yml` publishes one when a person pushes a version
 * tag, and the bridge's self-update (`apps/bridge/src/self-update.ts`) takes
 * one. The names and formats both sides use are here, once.
 * `self-update.test.ts` pins each of them, and tests/release-workflow.test.ts
 * checks the workflow writes the same ones: a workflow that renamed the
 * archive would otherwise publish releases every install refused, and say
 * nothing.
 *
 * The rest is what an update decides without touching anything: which
 * release to take, whether a path in an archive may be unpacked, what a run's
 * record and its attention card say.
 */

/** A version tag: `v` and three numbers without leading zeros, nothing after. */
export const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** The same tags as GitHub's filter in `release.yml` has them; it lets leading zeros through, so the workflow checks `RELEASE_TAG` too. */
export const RELEASE_TAG_FILTER = 'v[0-9]+.[0-9]+.[0-9]+';

/** The workflow a version tag starts. It only calls `RELEASE_SIGNER`, and is not trusted: the tagged commit's own copy runs. */
export const RELEASE_WORKFLOW = '.github/workflows/release.yml';

/**
 * The reusable workflow that checks, builds and signs a release, and the ref
 * it is always called at. Its certificate's identity (Fulcio's
 * `job_workflow_ref`) is this file at this ref, whatever called it; that is
 * the signer an install accepts, so a tagged commit's own release.yml cannot
 * sign one.
 */
export const RELEASE_SIGNER = '.github/workflows/release-build.yml';
export const RELEASE_SIGNER_REF = 'refs/heads/main';

/** The certificate identity of a repository's release signer. */
export function releaseSignerIdentity(repo: string): string {
  return `https://github.com/${repo}/${RELEASE_SIGNER}@${RELEASE_SIGNER_REF}`;
}

/** Inside the archive, at the top: the commit and tree it was built from. */
export const RELEASE_MANIFEST = 'openadlc-release.json';

/** The checksum file, in `sha256sum`'s format. */
export const RELEASE_CHECKSUMS = 'SHA256SUMS';

/** What the attestation states: SLSA build provenance. */
export const RELEASE_PREDICATE = 'https://slsa.dev/provenance/v1';

/** The three files a release carries. */
export function releaseAssets(tag: string): { archive: string; bundle: string; checksums: string } {
  return {
    archive: `openadlc-${tag}.tar.gz`,
    bundle: `openadlc-${tag}.tar.gz.sigstore.json`,
    checksums: RELEASE_CHECKSUMS,
  };
}

/** Where a release's file is downloaded from: the release's own address, never one a response named. */
export function releaseAssetUrl(repo: string, tag: string, name: string): string {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

export type ReleaseVersion = readonly [number, number, number];

/** A tag's three numbers, or null for anything that is not a version tag. */
export function releaseVersion(tag: string): ReleaseVersion | null {
  const match = RELEASE_TAG.exec(tag);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative when `a` is older than `b`. */
export function compareVersions(a: ReleaseVersion, b: ReleaseVersion): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

// ------------------------------------------------------------------ the archive

export interface ReleaseManifest {
  format: 1;
  tag: string;
  commit: string;
  tree: string;
}

const OBJECT_ID = /^[0-9a-f]{40}$/;

/**
 * `openadlc-release.json`, or null for anything else. Strict: the workflow
 * writes exactly these four keys, so anything more or less is not one it wrote.
 */
export function parseReleaseManifest(text: string): ReleaseManifest | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'commit,format,tag,tree') return null;
  if (record.format !== 1) return null;
  if (typeof record.tag !== 'string' || !RELEASE_TAG.test(record.tag)) return null;
  if (typeof record.commit !== 'string' || !OBJECT_ID.test(record.commit)) return null;
  if (typeof record.tree !== 'string' || !OBJECT_ID.test(record.tree)) return null;
  return { format: 1, tag: record.tag, commit: record.commit, tree: record.tree };
}

/**
 * The SHA-256 `SHA256SUMS` gives a file, or null when it gives none, or two.
 * `sha256sum`'s format: the hash, then two spaces, or a space and `*` for its
 * binary mode, then the name.
 */
export function checksumOf(sums: string, name: string): string | null {
  const found = new Set<string>();
  for (const line of sums.split('\n')) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.replace(/\r$/, ''));
    if (match && match[2] === name) found.add(match[1]!);
  }
  return found.size === 1 ? ([...found][0] ?? null) : null;
}

/** A built output's directory: each package's and app's `dist/`, and the console's `.next/`. */
const ROOT = /^(?:(?:packages|apps)\/[a-z0-9][a-z0-9-]*\/dist|apps\/console\/\.next)$/;
const UNDER_ROOT = /^(?:(?:packages|apps)\/[a-z0-9][a-z0-9-]*\/dist|apps\/console\/\.next)\//;
/** The directories a root sits in, which another tar may write as entries of their own. */
const ABOVE_ROOT = /^(?:packages|apps)(?:\/[a-z0-9][a-z0-9-]*)?$/;
/** The console's build cache: this machine's, and large. */
const CACHE = /^apps\/console\/\.next\/cache(?:\/|$)/;

/** Whether a directory is one of the roots of the built output (`apps/bridge/dist`). */
export function isBuiltRoot(path: string): boolean {
  return ROOT.test(path);
}

/** The root a path of the built output is in, or null: every root is three names deep. */
export function builtRootOf(path: string): string | null {
  const candidate = path.split('/').slice(0, 3).join('/');
  return ROOT.test(candidate) ? candidate : null;
}

/**
 * Whether an archive's entry may be unpacked: `openadlc-release.json`, and
 * directories and regular files of the built output, at a relative path with
 * no `.` or `..` in it. Anything else refuses the whole archive; links are
 * refused before this is asked, by their type.
 */
export function archivePathAllowed(path: string, type: 'file' | 'directory'): boolean {
  if (path.length === 0 || path.length > 1024) return false;
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
  const parts = path.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return false;
  if (CACHE.test(path)) return false;
  if (type === 'file') return path === RELEASE_MANIFEST || UNDER_ROOT.test(path);
  return ROOT.test(path) || UNDER_ROOT.test(path) || ABOVE_ROOT.test(path);
}

// ------------------------------------------------------------------ the attestation

/**
 * The `gh` arguments that check a release's attestation, exactly as
 * docs/self-hosting.md#checking-a-release gives them and `release-build.yml`
 * runs them before it publishes. `--bundle` reads the attestation from the
 * file the release carries, so no GitHub sign-in is needed. The signer's own
 * commit is not pinned: it is main's at the time of the release.
 */
export function attestationCheckArgs(input: { archive: string; bundle: string; repo: string; tag: string; commit: string }): string[] {
  return [
    'attestation',
    'verify',
    input.archive,
    '--bundle',
    input.bundle,
    '--repo',
    input.repo,
    '--cert-identity',
    releaseSignerIdentity(input.repo),
    '--source-ref',
    `refs/tags/${input.tag}`,
    '--source-digest',
    input.commit,
    '--deny-self-hosted-runners',
    '--predicate-type',
    RELEASE_PREDICATE,
  ];
}

/** The flags of `gh attestation verify` that check needs, which an older GitHub CLI does not have. */
export const ATTESTATION_FLAGS = ['--bundle', '--cert-identity', '--source-ref', '--source-digest', '--deny-self-hosted-runners'] as const;

// ------------------------------------------------------------------ choosing

/** A release as GitHub lists it, reduced to what choosing reads. */
export interface PublishedRelease {
  tag: string;
  draft: boolean;
  prerelease: boolean;
  publishedAt: string | null;
  /** The names of its files. */
  assets: readonly string[];
  /** GitHub's `immutable`: its files and tag can no longer change. */
  immutable: boolean;
}

/**
 * The newest release an install may take: a published version tag, neither a
 * draft nor a prerelease, immutable, carrying all three files. Newest by
 * version, not by date, so a fix published for an older line is never taken
 * over a newer one. A release missing a file, or one GitHub does not hold
 * immutable (its files could be replaced after the check), is passed over and
 * named, so the row can say why the version a person just tagged is not
 * offered.
 */
export function latestRelease(releases: readonly PublishedRelease[]): { release: PublishedRelease | null; incomplete: string[]; mutable: string[] } {
  const { releases: takeable, incomplete, mutable } = takeableReleases(releases);
  return { release: takeable[0] ?? null, incomplete, mutable };
}

/**
 * Every release an install may take, newest first, and the ones passed over.
 * An update tries them in this order, so a newest one that fails its check,
 * someone's hand-made `v999.0.0` say, is passed over rather than stalling
 * every update after it.
 */
export function takeableReleases(releases: readonly PublishedRelease[]): { releases: PublishedRelease[]; incomplete: string[]; mutable: string[] } {
  const takeable: { release: PublishedRelease; version: ReleaseVersion }[] = [];
  const incomplete: string[] = [];
  const mutable: string[] = [];
  for (const release of releases) {
    const version = releaseVersion(release.tag);
    if (!version || release.draft || release.prerelease) continue;
    const { archive, bundle, checksums } = releaseAssets(release.tag);
    if (![archive, bundle, checksums].every((name) => release.assets.includes(name))) {
      incomplete.push(release.tag);
      continue;
    }
    if (!release.immutable) {
      mutable.push(release.tag);
      continue;
    }
    takeable.push({ release, version });
  }
  takeable.sort((a, b) => compareVersions(b.version, a.version));
  return { releases: takeable.map((one) => one.release), incomplete, mutable };
}

const SHA = /^[0-9a-f]{40}$/;

/** Whether a value is a full commit id: what GitHub's API answers is checked before git is given it. */
export function isCommitId(value: unknown): value is string {
  return typeof value === 'string' && SHA.test(value);
}

// ------------------------------------------------------------------ the record

/** How a run ended. `current` and `skipped` changed nothing; `failed` says at which step. */
export type SelfUpdateState = 'updated' | 'current' | 'skipped' | 'failed';

/** Where a run is: making the release ready beside the install, waiting for the tasks, or restarting onto it. */
export type SelfUpdatePhase = 'preparing' | 'waiting' | 'restarting';

/** What started a run. */
export type SelfUpdateTrigger = 'schedule' | 'console';

/** The run in flight, as `selfUpdateRun` keeps it so a bridge that restarts goes on with it. */
export interface SelfUpdateRun {
  phase: SelfUpdatePhase;
  tag: string;
  /** The commit the install ran when the run started. */
  from: string;
  /** The release's commit. */
  to: string;
  trigger: SelfUpdateTrigger;
  actor: string;
  startedAt: string;
  /** The process restarting the install, once there is one. */
  pid: number | null;
}

/** How the last run ended, as `selfUpdateLast` keeps it. */
export interface SelfUpdateLast {
  state: SelfUpdateState;
  trigger: SelfUpdateTrigger;
  actor: string;
  /** The commit the run started from; null when it never read one. */
  from: string | null;
  /** The commit the install ended on. */
  to: string | null;
  tag: string | null;
  reason: string;
  /** For a failure, the step it failed at. */
  step?: string;
  /** For a failed restart that put the install back, the commit it is on. */
  restoredTo?: string;
  startedAt: string;
  finishedAt: string;
}

/**
 * What `openadlc self-update apply` leaves for the bridge that comes up after
 * it, in `run/self-update-result.json`: the bridge it stopped cannot be told.
 */
export interface SelfUpdateResultFile {
  format: 1;
  state: 'updated' | 'failed';
  tag: string;
  from: string;
  /** The commit the checkout is on now. */
  to: string;
  step?: string;
  reason: string;
  restoredTo?: string;
  finishedAt: string;
}

export function parseResultFile(text: string): SelfUpdateResultFile | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Partial<SelfUpdateResultFile>;
  if (record.format !== 1 || (record.state !== 'updated' && record.state !== 'failed')) return null;
  if (typeof record.tag !== 'string' || typeof record.from !== 'string' || typeof record.to !== 'string') return null;
  if (typeof record.reason !== 'string' || typeof record.finishedAt !== 'string') return null;
  return {
    format: 1,
    state: record.state,
    tag: record.tag,
    from: record.from,
    to: record.to,
    reason: record.reason,
    finishedAt: record.finishedAt,
    ...(typeof record.step === 'string' ? { step: record.step } : {}),
    ...(typeof record.restoredTo === 'string' ? { restoredTo: record.restoredTo } : {}),
  };
}

/** Where a run keeps its files under the install's home. */
export function selfUpdatePaths(home: string, tag: string): {
  root: string;
  download: string;
  tree: string;
  previous: string;
  result: string;
  log: string;
} {
  const root = join(home, 'self-update', tag);
  return {
    root,
    download: join(root, 'download'),
    tree: join(root, 'tree'),
    previous: join(root, 'previous'),
    result: join(home, 'run', 'self-update-result.json'),
    log: join(home, 'run', 'self-update.log'),
  };
}

// ------------------------------------------------------------------ what runs

/**
 * The environment a release's `pnpm install` runs in: enough to find the
 * tools, the store and a proxy, and to build node-pty, and nothing of the
 * bridge's. Install scripts are the release's dependencies' code; given the
 * bridge's environment they would have had the database URL, the webhook
 * secret and every other credential the services are started with.
 */
const INSTALL_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'PNPM_HOME',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  // What node-gyp reads to build node-pty.
  'PYTHON',
  'CC',
  'CXX',
  'CFLAGS',
  'CXXFLAGS',
  'LDFLAGS',
  'MAKEFLAGS',
  'DEVELOPER_DIR',
  'SDKROOT',
] as const;

/** An npm or pnpm setting that carries a credential rather than where to find the registry or the store. */
const CREDENTIAL_SETTING = /auth|token|password|_pass|secret|cert|key/i;

export function releaseInstallEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { CI: '1' };
  for (const name of INSTALL_ENV) if (env[name] !== undefined) out[name] = env[name];
  // The registry, the store, a proxy: how npm and pnpm are set up here. Not
  // a registry's token, which the public registry this installs from needs none of.
  for (const [name, value] of Object.entries(env)) {
    if (/^npm_config_/i.test(name) && !CREDENTIAL_SETTING.test(name) && value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * A setting or field whose name ends in a credential's word, then `=`, `:` or
 * JSON's `":"`, and its value: `token=`, `access_token=`, `client_secret=`,
 * `api_key=`, `_authToken=`, `PGPASSWORD=`, an OAuth `code=`,
 * `"token":"…"`, `x-openadlc-console-secret: …`. The name is matched to its
 * end, not at a word boundary, which `_token` and `_secret` do not have.
 */
const CREDENTIAL_FIELD = /([A-Za-z0-9_.-]*(?:token|secret|password|passwd|pwd|key|code|auth|credentials?))(["']?\s*[:=]\s*["']?)([^\s"'&,;}]+)/gi;
/** `Authorization: token <hex>`, `Bearer …`, `Basic …`. */
const AUTHORIZATION = /(authorization["']?\s*[:=]\s*["']?(?:bearer|token|basic)\s+)[^\s"',;}]+/gi;
/** npm's automation and publish tokens, by their prefix. */
const NPM_TOKEN = /\bnpm_[A-Za-z0-9]{20,}\b/g;

/**
 * Words from a command, made safe to keep: they go into the last result, the
 * audit log, the bridge's log and a card. Credentials by their shape
 * (`redactSecrets`), npm's tokens, an Authorization header's value, and the
 * value of any field named for a credential, such as the console's sign-in
 * link `openadlc up` prints.
 */
export function safeWords(text: string): string {
  return redactSecrets(text)
    .replace(AUTHORIZATION, '$1[redacted]')
    .replace(NPM_TOKEN, '[redacted]')
    .replace(CREDENTIAL_FIELD, (match, name: string, separator: string, value: string) => (value === '[redacted]' ? match : `${name}${separator}[redacted]`));
}

/**
 * What `gh attestation verify --format json` adds to its exit code: the run
 * behind each verified attestation was the push of this tag, started by this
 * repository's release.yml at it. The identity flags already pin the signer
 * to release-build.yml at main and the source to the tag; this is the caller,
 * which only reads Fulcio's own certificate fields (`buildTrigger`,
 * `buildConfigURI`), not anything the workflow wrote. Null when it holds.
 */
export function attestationRunProblem(output: string, input: { repo: string; tag: string }): string | null {
  let verified: unknown;
  try {
    verified = JSON.parse(output);
  } catch {
    return 'gh attestation verify did not print the attestations it verified';
  }
  if (!Array.isArray(verified) || verified.length === 0) return 'gh attestation verify verified no attestation';
  const caller = `https://github.com/${input.repo}/${RELEASE_WORKFLOW}@refs/tags/${input.tag}`;
  for (const entry of verified as { verificationResult?: { signature?: { certificate?: Record<string, unknown> } } }[]) {
    const certificate = entry?.verificationResult?.signature?.certificate ?? {};
    if (certificate.buildTrigger !== 'push') return `the attestation was made by a run started by ${String(certificate.buildTrigger ?? 'nothing it names')}, not by the push of ${input.tag}`;
    if (certificate.buildConfigURI !== caller) return `the attestation was made by a run of ${String(certificate.buildConfigURI ?? 'a workflow it does not name')}, not of ${caller}`;
  }
  return null;
}

// ------------------------------------------------------------------ writing what must survive

/**
 * Writes a file so that it is either all there or not at all, and on disk
 * before this returns: a temporary file beside it, flushed, renamed over it,
 * and the directory flushed so the rename is too. The restart's record and
 * result are read after a crash, when a half written one would be worse than
 * none. On macOS `fsync` leaves the drive's own cache unflushed, which only
 * `F_FULLFSYNC` forces, and Node offers no way to ask for it: a power cut
 * there can still lose the newest write, though never leave half of one.
 */
export function writeFileDurably(path: string, data: string | Buffer, mode = 0o600): void {
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, 'w', mode);
  try {
    writeSync(fd, typeof data === 'string' ? Buffer.from(data) : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  try {
    const directory = openSync(dirname(path), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch {
    // A file system that cannot flush a directory has the rename as it is.
  }
}

// ------------------------------------------------------------------ one checkout, one install

/**
 * Where installs that run from a checkout say so: one file per install's home,
 * under the checkout's `.openadlc/`, which git ignores. Two installs on one
 * machine can run from the same checkout (a developer's real install and its
 * scratch one), and an update of one would fast-forward and swap the files
 * under the other's running services, whose tasks it never waited for.
 */
export function checkoutInstallsDir(checkout: string): string {
  return join(checkout, '.openadlc', 'installs');
}

/** Records that the install at `home` runs from `checkout`. `openadlc up` writes it. */
export function recordCheckoutInstall(checkout: string, home: string): void {
  const dir = checkoutInstallsDir(checkout);
  mkdirSync(dir, { recursive: true });
  const name = createHash('sha256').update(home).digest('hex').slice(0, 16);
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify({ home })}\n`);
}

/**
 * A process's command line, '' when there is none, or null when nothing can
 * say: `ps`, else Linux's /proc, as the CLI's `psCommand` reads it.
 */
export function processCommandLine(pid: number): string | null {
  try {
    return execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) {
    if ((error as { status?: number }).status === 1) return '';
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !existsSync('/proc')) return null;
    try {
      return readFileSync(join('/proc', String(pid), 'cmdline'), 'utf8').split('\0').filter(Boolean).join(' ');
    } catch {
      return '';
    }
  }
}

/**
 * Whether a pid is that service's keeper, by its command line: a pid file
 * outlives a reboot, and its number can be another program's by then. When
 * nothing can say, whether the process is there.
 */
export function isServiceKeeper(service: string, pid: number, commandLine: (pid: number) => string | null = processCommandLine): boolean {
  const line = commandLine(pid);
  if (line !== null) return line.includes(`keep.js ${service} `);
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface CheckoutInstall {
  home: string;
  /** The file that says it runs from this checkout. */
  record: string;
}

/**
 * The other installs running from `checkout` now: each recorded home but
 * `home` with a service whose pid file names that service's keeper. A stale
 * record, of an install since stopped or removed, or a pid file a reboot
 * left naming some other program, counts for nothing.
 */
export function otherInstallsRunning(
  checkout: string,
  home: string,
  isKeeper: (service: string, pid: number) => boolean = (service, pid) => isServiceKeeper(service, pid),
): CheckoutInstall[] {
  let names: string[];
  try {
    names = readdirSync(checkoutInstallsDir(checkout)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const running: CheckoutInstall[] = [];
  for (const name of names) {
    const record = join(checkoutInstallsDir(checkout), name);
    let other: string;
    try {
      const value = JSON.parse(readFileSync(record, 'utf8')) as { home?: unknown };
      if (typeof value.home !== 'string') continue;
      other = value.home;
    } catch {
      continue;
    }
    if (other === home) continue;
    const live = ['hostd', 'bridge', 'console'].some((service) => {
      try {
        const pid = Number(readFileSync(join(other, 'run', `${service}.pid`), 'utf8').trim());
        return Number.isInteger(pid) && pid > 1 && isKeeper(service, pid);
      } catch {
        return false;
      }
    });
    if (live) running.push({ home: other, record });
  }
  return running;
}

/** Why an update refuses a checkout another install runs from, and the way out. */
export function sharedCheckoutReason(checkout: string, others: readonly CheckoutInstall[]): string {
  const ways = others.map((other) => `stop it (OPENADLC_HOME=${other.home} openadlc down), or, if it is not running, delete ${other.record}`);
  return `another install (${others.map((other) => other.home).join(', ')}) runs from ${checkout} too, and an update would change the files under its running services: give each install its own clone, or ${ways.join('; ')}`;
}

// ------------------------------------------------------------------ a restart cut short

/** What the restart writes before it stops anything, and clears once the checkout is one release again. */
export interface SelfUpdateApplying {
  format: 1;
  tag: string;
  from: string;
  to: string;
  checkout: string;
  step: string;
  startedAt: string;
}

export function selfUpdateApplyingPath(home: string): string {
  return join(home, 'run', 'self-update-applying.json');
}

/**
 * The same record in the checkout itself: two installs can run from one
 * checkout (a scratch install of a developer's), and the other's `up` must
 * refuse a half-swapped tree too, which it would otherwise start, and migrate
 * its own database with. git ignores `.openadlc/`.
 */
export function checkoutApplyingPath(checkout: string): string {
  return join(checkout, '.openadlc', 'applying.json');
}

/**
 * What `openadlc up` says, and refuses, when a restart onto a release stopped
 * partway (power lost, the process killed): the checkout may hold the
 * release's source with part of its built output and the old dependencies,
 * and starting it would run that mix, and the release's migrations. Null when
 * no restart was cut short.
 */
export function applyingRefusal(home: string, checkout?: string): { reason: string; steps: string[] } | null {
  const records = [selfUpdateApplyingPath(home), ...(checkout ? [checkoutApplyingPath(checkout)] : [])].filter((path) => existsSync(path));
  if (records.length === 0) return null;
  let applying: Partial<SelfUpdateApplying> = {};
  for (const path of records) {
    try {
      applying = JSON.parse(readFileSync(path, 'utf8')) as Partial<SelfUpdateApplying>;
      break;
    } catch {
      // Unreadable is still a restart that did not finish.
    }
  }
  const where = applying.checkout ?? checkout ?? 'the checkout';
  const tag = applying.tag ?? 'a release';
  const to = applying.to ?? '<the release commit>';
  const from = applying.from ?? '<the commit before>';
  return {
    reason: `OpenADLC was restarting onto ${tag} and stopped during ${applying.step ?? 'a step'}, so ${where} may hold part of ${tag} and part of what it ran before; it is not started like that`,
    steps: [
      `to finish onto ${tag}: cd ${where} && git merge --ff-only ${to} && pnpm install --frozen-lockfile && pnpm build`,
      `or to go back: cd ${where} && git reset --keep ${from} && pnpm install --frozen-lockfile && pnpm build`,
      `if git refuses either (the restart died inside it): rm -f ${where}/.git/index.lock, then git reset --hard ${to} to finish or ${from} to go back, and the same pnpm install and build; the checkout had no changes of its own when the restart began`,
      `then: rm ${records.join(' ')} && openadlc up`,
    ],
  };
}

/** A failed update, as the console's attention list shows it. */
export interface SelfUpdateAttention {
  kind: 'self-update-failed';
  title: string;
  detail: string;
  at: string;
  href: string;
}

/**
 * The card for the last result, or null. Only a failure needs a person: the
 * install is on what it was, or, after a migration, on the release with a
 * reason to look. It stays until a later run updates or finds it current.
 */
export function selfUpdateAttention(last: SelfUpdateLast | null): SelfUpdateAttention | null {
  if (!last || last.state !== 'failed') return null;
  const onRelease = last.to && last.to !== last.from && !last.restoredTo;
  return {
    kind: 'self-update-failed',
    title: onRelease
      ? `The OpenADLC update to ${last.tag ?? 'the release'} did not finish`
      : `OpenADLC did not update${last.tag ? ` to ${last.tag}` : ''} — it is still on the version it had`,
    detail: last.step ? `${last.step}: ${last.reason}` : last.reason,
    at: last.finishedAt,
    href: '/settings#system',
  };
}
