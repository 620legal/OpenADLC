import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DockerResult } from './drivers/docker.js';
import { PnpmStore, pnpmFailure, pnpmVersionOf } from './pnpm-store.js';

/**
 * A repository's pnpm store, filled by hostd in a container of its own. What
 * is pinned is what that container is given: the store read-write, a copy of
 * the lockfile and nothing else of the task's, no credential but the install's
 * registry token, the egress proxy, and `pnpm fetch` with no scripts.
 */

let root: string;
let worktree: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleetadlc-pnpm-store-'));
  worktree = join(root, 'work', 'slots', 'task-1-abc', 'wt');
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  writeFileSync(join(worktree, 'package.json'), JSON.stringify({ name: 'widgets', packageManager: 'pnpm@10.33.3', scripts: { preinstall: 'curl evil' } }));
  writeFileSync(join(worktree, '.npmrc'), 'registry=https://evil.example/\n');
  writeFileSync(join(worktree, 'pnpm-workspace.yaml'), 'configDependencies:\n  evil: 1.0.0\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Seen {
  args: string[];
  secrets: Record<string, string> | undefined;
  /** The files of the lockfile's copy, as the filler saw them. */
  files: Record<string, string>;
}

function store(answer: (args: string[]) => Promise<DockerResult> | DockerResult = () => ({ code: 0, stdout: '', stderr: '' }), registry?: { host: string; token: string }) {
  const seen: Seen[] = [];
  const docker = async (args: string[], _input?: string, secrets?: Record<string, string>): Promise<DockerResult> => {
    const copy = args[args.indexOf('-w') - 1]!.split(':')[0]!;
    const files = Object.fromEntries(readdirSync(copy).map((name) => [name, readFileSync(join(copy, name), 'utf8')]));
    seen.push({ args, secrets, files });
    return answer(args);
  };
  const pnpm = new PnpmStore({
    docker,
    image: 'fleetadlc-bot:latest',
    install: 'default',
    workRoot: join(root, 'work'),
    cacheVolume: (repoKey) => `fleetadlc-cache-default-${repoKey}`,
    networkArgs: ['--add-host', 'host.docker.internal:host-gateway', '-e', 'HTTPS_PROXY=http://host.docker.internal:3128'],
    labels: ['fleetadlc.install=default', 'fleetadlc.kind=pnpm-fill'],
    ...(registry ? { registry: async () => registry } : {}),
  });
  return { pnpm, seen };
}

const mounts = (args: string[]) => args.flatMap((arg, index) => (args[index - 1] === '-v' ? [arg] : []));
const envs = (args: string[]) => args.flatMap((arg, index) => (args[index - 1] === '-e' ? [arg] : []));

describe('filling a repository’s pnpm store', () => {
  it('runs pnpm fetch from the lockfile alone, with no scripts, in a container that holds no task’s files and no credential', async () => {
    const { pnpm, seen } = store();

    expect(await pnpm.fill({ repoKey: 'acme__widgets', worktree })).toEqual({ filled: true, path: '/pnpm-store' });

    const [{ args, secrets, files }] = seen as [Seen];
    expect(args.slice(0, 2)).toEqual(['run', '--rm']);
    const copy = mounts(args).find((mount) => mount.endsWith(`:${worktree}`))!.split(':')[0]!;
    expect(mounts(args)).toEqual(['fleetadlc-pnpm-default-acme__widgets:/pnpm-store', 'fleetadlc-cache-default-acme__widgets:/cache', `${copy}:${worktree}`]);
    // Its copy, mounted at the worktree's path so the task finds its project
    // recorded in the store; never the slot or the worktree themselves.
    expect(copy.startsWith(join(root, 'work', 'pnpm-fill'))).toBe(true);
    expect(mounts(args).some((mount) => mount.startsWith(join(root, 'work', 'slots')))).toBe(false);
    expect(files).toEqual({ 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n", 'package.json': '{"packageManager":"pnpm@10.33.3"}\n' });
    // The proxy and nothing that signs anybody in.
    expect(envs(args)).toEqual(['HTTPS_PROXY=http://host.docker.internal:3128', 'COREPACK_ENABLE_DOWNLOAD_PROMPT=0']);
    expect(args.join(' ')).not.toMatch(/GH_TOKEN|GITHUB_TOKEN|ANTHROPIC|OPENAI|CODEX_HOME|GROK_HOME|\/fleetadlc\/login|DATABASE_URL/);
    expect(secrets).toBeUndefined();
    const script = args.at(-1)!;
    expect(script).toContain('timeout --kill-after=10s 300s pnpm fetch --frozen-lockfile --ignore-scripts --ignore-pnpmfile --store-dir /pnpm-store');
    expect(script).toContain('setpriv --reuid=bot');
    // The copy goes once the fill is done.
    expect(existsSync(copy)).toBe(false);
  });

  it('removes the store that was on the cache volume the first time only', async () => {
    const { pnpm, seen } = store();

    await pnpm.fill({ repoKey: 'acme__widgets', worktree });
    await pnpm.fill({ repoKey: 'acme__widgets', worktree });

    expect(seen[0]!.args.at(-1)).toMatch(/^rm -rf \/cache\/pnpm-store && /);
    expect(seen[1]!.args.at(-1)).not.toContain('/cache');
    expect(mounts(seen[1]!.args).some((mount) => mount.endsWith(':/cache'))).toBe(false);
  });

  it('starts no fill for a repository with no pnpm-lock.yaml', async () => {
    rmSync(join(worktree, 'pnpm-lock.yaml'));
    const { pnpm, seen } = store();

    expect(await pnpm.fill({ repoKey: 'acme__widgets', worktree })).toMatchObject({ filled: false, skipped: true });
    expect(seen).toEqual([]);
  });

  it('answers why when the fill fails, rather than failing the task', async () => {
    const { pnpm } = store(() => ({
      code: 1,
      stdout: '',
      stderr: ' ERR_PNPM_FETCH_404  GET https://ci:npm_SECRET@registry.npmjs.org/@acme%2fprivate?token=npm_SECRET: Not Found - 404\n',
    }));

    // pnpm's code and the status say why; the URL, which can carry a token,
    // is cut to its host.
    expect(await pnpm.fill({ repoKey: 'acme__widgets', worktree })).toEqual({
      filled: false,
      skipped: false,
      reason: 'pnpm fetch exited 1: ERR_PNPM_FETCH_404 (404 Not Found from registry.npmjs.org)',
    });
  });

  it('says only pnpm’s code when its error quotes what it read', () => {
    expect(pnpmFailure(' ERR_PNPM_JSON_PARSE  Unexpected token r in JSON at position 0 while parsing "root:x:0:0:root:/root:/bin/sh"\n')).toBe('ERR_PNPM_JSON_PARSE');
    expect(pnpmFailure('Error: connect ECONNREFUSED\n')).toBeNull();
  });

  it('does not follow a symlink or block on a FIFO where the lockfile is, and says how to put it back', async () => {
    rmSync(join(worktree, 'pnpm-lock.yaml'));
    symlinkSync('/etc/passwd', join(worktree, 'pnpm-lock.yaml'));
    const linked = store();
    const started = performance.now();
    const viaLink = await linked.pnpm.fill({ repoKey: 'acme__widgets', worktree });
    expect(viaLink).toEqual({ filled: false, skipped: false, reason: 'pnpm-lock.yaml is a symlink; check out the real file: git checkout pnpm-lock.yaml' });
    expect(linked.seen).toEqual([]);

    rmSync(join(worktree, 'pnpm-lock.yaml'));
    const made = spawnSync('mkfifo', [join(worktree, 'pnpm-lock.yaml')]);
    expect(made.status).toBe(0);
    const piped = store();
    const viaPipe = await piped.pnpm.fill({ repoKey: 'acme__widgets', worktree });
    expect(viaPipe).toEqual({ filled: false, skipped: false, reason: 'pnpm-lock.yaml is not a regular file; check out the real file: git checkout pnpm-lock.yaml' });
    expect(piped.seen).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('calls a lockfile over the cap too large, not irregular', async () => {
    // Sparse: its size is past the cap without writing 32 MiB.
    truncateSync(join(worktree, 'pnpm-lock.yaml'), 32 * 1024 * 1024 + 1);
    const { pnpm, seen } = store();

    expect(await pnpm.fill({ repoKey: 'acme__widgets', worktree })).toEqual({
      filled: false,
      skipped: false,
      reason: 'pnpm-lock.yaml is too large: 33554433 bytes, over the 33554432 the fill copies; check out the real file: git checkout pnpm-lock.yaml',
    });
    expect(seen).toEqual([]);
  });

  it('fills one repository’s store one at a time, and two repositories’ at once', async () => {
    let running = 0;
    let most = 0;
    const { pnpm } = store(async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running -= 1;
      return { code: 0, stdout: '', stderr: '' };
    });

    await Promise.all([pnpm.fill({ repoKey: 'acme__widgets', worktree }), pnpm.fill({ repoKey: 'acme__widgets', worktree })]);
    expect(most).toBe(1);

    most = 0;
    await Promise.all([pnpm.fill({ repoKey: 'acme__widgets', worktree }), pnpm.fill({ repoKey: 'acme__gadgets', worktree })]);
    expect(most).toBe(2);
  });

  it('can fetch from the install’s private registry, its token named on the command line and valued only in docker’s environment', async () => {
    const { pnpm, seen } = store(undefined, { host: 'npm.example.com', token: 'npm_TOKEN' });

    await pnpm.fill({ repoKey: 'acme__widgets', worktree });

    const [{ args, secrets, files }] = seen as [Seen];
    expect(envs(args)).toContain('FLEETADLC_REGISTRY_TOKEN');
    expect(args.join(' ')).not.toContain('npm_TOKEN');
    expect(secrets).toEqual({ FLEETADLC_REGISTRY_TOKEN: 'npm_TOKEN' });
    expect(files['.npmrc']).toBe('//npm.example.com/:_authToken=${FLEETADLC_REGISTRY_TOKEN}\n');
  });
});

describe('which pnpm a repository names', () => {
  it('is passed on only when it names an exact version of pnpm', () => {
    expect(pnpmVersionOf('{"packageManager":"pnpm@10.33.3"}')).toBe('pnpm@10.33.3');
    expect(pnpmVersionOf('{"packageManager":"pnpm@10.33.3+sha512.abc123"}')).toBe('pnpm@10.33.3+sha512.abc123');
    expect(pnpmVersionOf('{"packageManager":"pnpm@https://evil.example/pnpm.tgz"}')).toBeNull();
    expect(pnpmVersionOf('{"packageManager":"yarn@4.0.0"}')).toBeNull();
    expect(pnpmVersionOf('not json')).toBeNull();
  });
});
