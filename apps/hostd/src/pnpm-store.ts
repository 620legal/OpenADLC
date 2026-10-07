import { randomBytes } from 'node:crypto';
import { constants, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { DockerResult } from './drivers/docker.js';

/** A lockfile or manifest bigger than this is not copied. A real lockfile is far smaller. */
const LOCKFILE_MAX_BYTES = 32 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 1024 * 1024;
/** `pnpm fetch` is stopped after this, inside the container and on the docker client. */
const FILL_TIMEOUT_S = 300;

/**
 * Each repository's pnpm store, filled by hostd and read by its tasks.
 *
 * Every task for a repository mounted one writable cache volume, and pnpm's
 * store was on it. pnpm trusts its own index for a package it already holds,
 * and does not hash a file again that is older than the index: a task that
 * rewrote both planted code that the next task's `make setup` or `make ci`
 * ran, in a reviewer's container that holds its seat's GitHub token, and the
 * code was in no diff. So the store is a volume of its own that every task
 * computer mounts read-only, and only hostd writes it: in a short-lived
 * container that holds no task's files and no credential but the install's
 * registry token, running `pnpm fetch` on a copy of the task's lockfile.
 *
 * The lockfile is the task's, and may be an attacker's. `pnpm fetch` checks
 * each tarball against the lockfile's integrity and keeps it under that hash,
 * so a hostile lockfile can add packages to the store but cannot change what
 * another package's hash names. Scripts and pnpmfiles are not run, and nothing
 * else of the worktree is copied: no `.npmrc`, no `pnpm-workspace.yaml`
 * (whose config dependencies run), and of `package.json` only which pnpm it
 * names, so the store is laid out for the version the task runs.
 *
 * pnpm 10 records each project that installs from a store under
 * `<store>/v10/projects`, and refuses to install when it cannot. The copy is
 * mounted at the worktree's own path, so the fill records the path the task
 * installs from, and the task finds it already there.
 */

/** Where a task's computer has its repository's store, read-only. */
export const CONTAINER_PNPM_STORE = '/pnpm-store';

/** A repository's store volume on this install: a new name, so a store a task could write is never read again. */
export function pnpmStoreVolume(install: string, repoKey: string): string {
  return `fleetadlc-pnpm-${install}-${repoKey}`;
}

export type PnpmFill =
  /** The store holds what the lockfile names; the task reads it at `path`. */
  | { filled: true; path: string }
  /** The task uses a store of its own: `skipped` when there was nothing to fill from. */
  | { filled: false; skipped: boolean; reason: string };

export interface PnpmStoreOptions {
  docker: (args: string[], input?: string, secrets?: Record<string, string>, options?: { timeoutMs?: number }) => Promise<DockerResult>;
  /** The image tasks run, whose pnpm is the one that reads the store. */
  image: string;
  install: string;
  /** Where hostd keeps what it mounts; the lockfile's copy goes under it. */
  workRoot: string;
  /** A repository's cache volume, from which the store that was on it is removed. */
  cacheVolume: (repoKey: string) => string;
  /** How a one-shot container gets out: the egress proxy, and the name that reaches it. */
  networkArgs: string[];
  /** Labels every container hostd makes carries, so the install's cleanup finds this one. */
  labels: string[];
  /** The install's private registry and its token, or null; see `RegistryCredentials`. */
  registry?: () => Promise<{ host: string; token: string } | null>;
}

/** Which pnpm a `packageManager` field names, when it names one exactly; anything else is not passed on. */
export function pnpmVersionOf(manifest: string): string | null {
  try {
    const named = (JSON.parse(manifest) as { packageManager?: unknown }).packageManager;
    return typeof named === 'string' && /^pnpm@\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?(?:\+sha\d+\.[0-9a-f]+)?$/.test(named) ? named : null;
  } catch {
    return null;
  }
}

/**
 * The bytes of one regular file in the worktree.
 *
 * `copyFileSync` follows a symlink and blocks on a FIFO, both of which a task
 * can leave where the lockfile is and then ask hostd to fill. Opening with
 * `O_NOFOLLOW` refuses the symlink, `O_NONBLOCK` returns at once on a FIFO,
 * and the file is copied only after `fstat` says it is a regular file under
 * the cap whose real path stays in the worktree. A refusal names the file and
 * how to put it right, never what it pointed at: the session reads it.
 */
async function readWorktreeFile(worktree: string, name: string, maxBytes: number): Promise<Buffer> {
  const refused = (what: string) => new Error(`${name} ${what}; check out the real file: git checkout ${name}`);
  let root: string;
  try {
    root = await realpath(worktree);
  } catch {
    throw new Error(`${name} was not copied: the worktree could not be read`);
  }
  const target = join(root, name);
  if (!target.startsWith(root + sep)) throw refused('is not in the worktree');
  let fh;
  try {
    fh = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw code === 'ELOOP' ? refused('is a symlink') : refused(`could not be opened (${code ?? 'unknown error'})`);
  }
  try {
    const stat = await fh.stat();
    if (!stat.isFile()) throw refused('is not a regular file');
    if (stat.size > maxBytes) throw refused(`is too large: ${stat.size} bytes, over the ${maxBytes} the fill copies`);
    const linked = await realpath(target).catch(() => null);
    if (!linked || (linked !== root && !linked.startsWith(root + sep))) throw refused('is not in the worktree');
    return Buffer.from(await fh.readFile());
  } finally {
    await fh.close();
  }
}

/**
 * Why pnpm failed, in words the session may read. Its output can quote a file
 * the lockfile pointed at, or a URL with a token in it, so only what pnpm's
 * own error names is kept: its `ERR_PNPM_*` code and, for an HTTP failure, the
 * status and the registry's host.
 */
export function pnpmFailure(output: string): string | null {
  const line = output.split('\n').find((text) => /\bERR_PNPM_[A-Z0-9_]+\b/.test(text));
  if (!line) return null;
  const code = /\bERR_PNPM_[A-Z0-9_]+\b/.exec(line)![0];
  const status = /:\s*([A-Za-z][A-Za-z ]{0,40}?)\s*-\s*(\d{3})\s*$/.exec(line);
  if (!status) return code;
  let host: string | null = null;
  const url = /\bhttps?:\/\/\S+/.exec(line);
  try {
    host = url ? new URL(url[0]).host : null;
  } catch {
    host = null;
  }
  return `${code} (${status[2]} ${status[1]}${host ? ` from ${host}` : ''})`;
}

export class PnpmStore {
  /** One fill at a time per repository: two `pnpm fetch` into one store at once race on its files. */
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Repositories whose old store on the cache volume this process has removed. */
  private readonly cleared = new Set<string>();

  constructor(private readonly options: PnpmStoreOptions) {}

  /**
   * The repository's store filled from the lockfile in `worktree`. Never
   * throws: a fill that fails — the registry unreachable, a private package,
   * an image without pnpm — is a task on a store of its own, not a failed
   * task.
   */
  fill(input: { repoKey: string; worktree: string }): Promise<PnpmFill> {
    const lockfile = join(input.worktree, 'pnpm-lock.yaml');
    if (!existsSync(lockfile)) return Promise.resolve({ filled: false, skipped: true, reason: 'it has no pnpm-lock.yaml' });
    const before = this.queues.get(input.repoKey) ?? Promise.resolve();
    const mine = before.then(
      () => this.run(input),
      () => this.run(input),
    );
    const settled = mine.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(input.repoKey, settled);
    void settled.then(() => {
      if (this.queues.get(input.repoKey) === settled) this.queues.delete(input.repoKey);
    });
    return mine.catch((error: unknown) => ({ filled: false as const, skipped: false, reason: error instanceof Error ? error.message : String(error) }));
  }

  private async run(input: { repoKey: string; worktree: string }): Promise<PnpmFill> {
    const copy = join(this.options.workRoot, 'pnpm-fill', randomBytes(6).toString('hex'));
    mkdirSync(copy, { recursive: true });
    try {
      // copyFileSync follows a symlink and blocks forever on a FIFO. A task
      // can make either in its worktree and call this route, which froze
      // hostd and could return a host file in the error. Open the file
      // itself, refuse anything that is not a regular file inside the
      // worktree, then copy the bytes we already hold.
      const lockfile = await readWorktreeFile(input.worktree, 'pnpm-lock.yaml', LOCKFILE_MAX_BYTES);
      writeFileSync(join(copy, 'pnpm-lock.yaml'), lockfile);
      const manifest = join(input.worktree, 'package.json');
      const pnpm = existsSync(manifest) ? pnpmVersionOf((await readWorktreeFile(input.worktree, 'package.json', MANIFEST_MAX_BYTES)).toString('utf8')) : null;
      writeFileSync(join(copy, 'package.json'), `${JSON.stringify(pnpm ? { packageManager: pnpm } : {})}\n`);

      const registry = await this.options.registry?.().catch(() => null);
      if (registry) writeFileSync(join(copy, '.npmrc'), `//${registry.host}/:_authToken=\${FLEETADLC_REGISTRY_TOKEN}\n`);
      const clear = !this.cleared.has(input.repoKey);
      const args = fillArgs({
        name: `fleetadlc-pnpm-fill-${randomBytes(4).toString('hex')}`,
        image: this.options.image,
        storeVolume: pnpmStoreVolume(this.options.install, input.repoKey),
        cacheVolume: clear ? this.options.cacheVolume(input.repoKey) : null,
        copy,
        worktree: input.worktree,
        networkArgs: this.options.networkArgs,
        labels: this.options.labels,
        registry: Boolean(registry),
      });
      const deadline = { timeoutMs: (FILL_TIMEOUT_S + 30) * 1000 };
      const result = registry
        ? await this.options.docker(args, undefined, { FLEETADLC_REGISTRY_TOKEN: registry.token }, deadline)
        : await this.options.docker(args, undefined, undefined, deadline);
      if (result.code !== 0) {
        const why = pnpmFailure(`${result.stderr}\n${result.stdout}`);
        return { filled: false, skipped: false, reason: `pnpm fetch exited ${result.code}${why ? `: ${why}` : ''}` };
      }
      if (clear) this.cleared.add(input.repoKey);
      return { filled: true, path: CONTAINER_PNPM_STORE };
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }
}

/**
 * The filler's `docker run`. It starts as root only to give the store's
 * volume to `bot` (Docker makes a new volume's mount point root's) and to
 * remove the store that was on the cache volume; pnpm itself runs as `bot`.
 * Mounted: the store, read-write; the lockfile's copy, at the worktree's path;
 * and, the first time, the cache volume. No slot, no login, and in its
 * environment only the proxy and, for a private registry, its token.
 */
export function fillArgs(input: {
  name: string;
  image: string;
  storeVolume: string;
  cacheVolume: string | null;
  copy: string;
  worktree: string;
  networkArgs: string[];
  labels: string[];
  registry: boolean;
}): string[] {
  const script = [
    ...(input.cacheVolume ? ['rm -rf /cache/pnpm-store'] : []),
    `chown bot:bot ${CONTAINER_PNPM_STORE}`,
    `exec setpriv --reuid=bot --regid=bot --init-groups env HOME=/home/bot timeout --kill-after=10s ${FILL_TIMEOUT_S}s pnpm fetch --frozen-lockfile --ignore-scripts --ignore-pnpmfile --store-dir ${CONTAINER_PNPM_STORE}`,
  ].join(' && ');
  return [
    'run',
    '--rm',
    '--name',
    input.name,
    ...input.labels.flatMap((label) => ['--label', label]),
    ...input.networkArgs,
    '-u',
    '0',
    '-v',
    `${input.storeVolume}:${CONTAINER_PNPM_STORE}`,
    ...(input.cacheVolume ? ['-v', `${input.cacheVolume}:/cache`] : []),
    '-v',
    `${input.copy}:${input.worktree}`,
    '-w',
    input.worktree,
    '-e',
    'COREPACK_ENABLE_DOWNLOAD_PROMPT=0',
    ...(input.registry ? ['-e', 'FLEETADLC_REGISTRY_TOKEN'] : []),
    '--entrypoint',
    '/bin/sh',
    input.image,
    '-c',
    script,
  ];
}
