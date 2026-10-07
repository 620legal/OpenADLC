import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SLOT_FILE, slotRecordPath } from '../worktree.js';
import { GH_SHIM_DIR } from './base-env.js';
import { execFileSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { docker as runDocker, DockerDriver, probeNetworkArgs, sessionEnvFile, TASK_PIDS_LIMIT, type DockerResult, type TaskDatabaseServer } from './docker.js';
import type { TaskComputerSpec } from './types.js';

/**
 * What the docker driver asks Docker to do, with Docker answering from a
 * script. A task's container is decided here, and a mount is the one thing
 * about a container that cannot be changed after it exists.
 */

const SEAT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const OTHER_SEAT = '550e8400-e29b-41d4-a716-446655440000';
const IMAGE = 'sha256:e991db59faa0678dccd10e311474ab3eaafb1dadeda8d9b2cbe6e098a6286253';
const OLD_IMAGE = 'sha256:0f5a1c6d2e3b4a5968778695a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5';
const TASK = '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f';

/** The mounts label of a container made by `driverWith`: where its read-only mounts come from. */
const MOUNTS = ['/opt/fleetadlc/skills', '/opt/fleetadlc/roles', '/opt/fleetadlc/skill-runner.bundle.mjs', GH_SHIM_DIR].join(':');

interface Container {
  status: 'running' | 'exited';
  labels: Record<string, string> | null;
  image: string;
  /** Its tmux sessions, as `tmux list-sessions` prints them. */
  sessions?: string[];
}

let workRoot: string;
let loginRoot: string;

beforeEach(() => {
  workRoot = mkdtempSync(join(tmpdir(), 'fleetadlc-docker-work-'));
  loginRoot = join(mkdtempSync(join(tmpdir(), 'fleetadlc-docker-logins-')), 'logins');
});

afterEach(() => {
  rmSync(workRoot, { recursive: true, force: true });
  rmSync(join(loginRoot, '..'), { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A Docker that keeps what it was asked to make, so a test can ask about it again. */
function docker(
  containers: Record<string, Container> = {},
  options: { imageId?: string | null; networks?: Record<string, { labels?: Record<string, string>; options?: Record<string, string> }> } = {},
) {
  const calls: string[][] = [];
  const networks = { ...(options.networks ?? {}) };
  const imageId = options.imageId === undefined ? IMAGE : options.imageId;
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];
  const answer = async (args: string[]): Promise<DockerResult> => {
    calls.push(args);
    const ok = (stdout = ''): DockerResult => ({ code: 0, stdout, stderr: '' });
    if (args[0] === 'container' && args[1] === 'inspect') {
      const found = containers[args[2] ?? ''];
      if (!found) return { code: 1, stdout: '', stderr: `Error: No such container: ${args[2]}` };
      return ok(JSON.stringify([{ Name: `/${args[2]}`, State: { Status: found.status }, Config: { Labels: found.labels }, Image: found.image }]));
    }
    if (args[0] === 'image' && args[1] === 'inspect') return imageId ? ok(`${imageId}\n`) : { code: 1, stdout: '', stderr: 'no such image' };
    if (args[0] === 'network' && args[1] === 'inspect') {
      const found = networks[args[2] ?? ''];
      return found ? ok(JSON.stringify([{ Labels: found.labels ?? {}, Options: found.options ?? {} }])) : { code: 1, stdout: '', stderr: 'no such network' };
    }
    if (args[0] === 'network' && args[1] === 'create') {
      networks[args.at(-1) ?? ''] = { labels: { 'fleetadlc.install': (flag(args, '--label') ?? '').split('=')[1] ?? '' }, options: { 'com.docker.network.bridge.enable_icc': 'false' } };
      return ok();
    }
    if (args[0] === 'run') {
      const labels: Record<string, string> = {};
      args.forEach((arg, index) => {
        if (arg === '--label') {
          const [key, ...value] = (args[index + 1] ?? '').split('=');
          labels[key!] = value.join('=');
        }
      });
      containers[flag(args, '--name') ?? ''] = { status: 'running', labels, image: imageId ?? '', sessions: ['shell'] };
      return ok('container-id\n');
    }
    if (args[0] === 'rm') {
      delete containers[args.at(-1) ?? ''];
      return ok();
    }
    if (args[0] === 'ps') {
      const install = args.find((arg) => arg.startsWith('label=fleetadlc.install='))?.split('=')[2];
      const names = Object.entries(containers)
        .filter(([, found]) => found.labels?.['fleetadlc.kind'] === 'computer' && found.labels?.['fleetadlc.install'] === install)
        .map(([name]) => name);
      return ok(`${names.join('\n')}\n`);
    }
    if (args[0] === 'exec' && args.includes('tmux') && args.includes('list-sessions')) {
      const name = args[1] ?? '';
      return ok(`${(containers[name]?.sessions ?? []).map((session) => `${session}|0`).join('\n')}\n`);
    }
    return ok();
  };
  return { calls, answer, containers, networks };
}

function driverWith(
  answer: (args: string[]) => Promise<DockerResult>,
  extra: { egressProxy?: string; databases?: TaskDatabaseServer } = {},
): DockerDriver {
  return new DockerDriver({
    ...extra,
    image: 'fleetadlc-bot:latest',
    networkPrefix: 'fleetadlc-bot',
    runnerBundle: '/opt/fleetadlc/skill-runner.bundle.mjs',
    workRoot,
    skillsRoot: '/opt/fleetadlc/skills',
    rolesRoot: '/opt/fleetadlc/roles',
    hostdUrl: 'http://host.docker.internal:47312',
    loginRoot,
    docker: answer,
  });
}

function spec(partial: Partial<TaskComputerSpec> = {}): TaskComputerSpec {
  const taskId = partial.taskId ?? TASK;
  return {
    taskId,
    bot: 'atlas',
    repoKey: 'acme__widgets',
    slotDir: join(workRoot, 'slots', taskId),
    login: null,
    cpus: 2,
    memoryGb: 6,
    database: false,
    ...partial,
  };
}

/** The `docker run -d` that made a container, if one did. */
function created(calls: string[][], name: string): string[] | undefined {
  return calls.find((args) => args[0] === 'run' && args.includes(name));
}

function values(args: string[] | undefined, flag: string): string[] {
  const found: string[] = [];
  (args ?? []).forEach((arg, index) => {
    if (arg === flag && args?.[index + 1]) found.push(args[index + 1]!);
  });
  return found;
}

const mounts = (args: string[] | undefined) => values(args, '-v');
const labels = (args: string[] | undefined) => values(args, '--label');
const envs = (args: string[] | undefined) => values(args, '-e');

describe('a task’s computer, made cold', () => {
  it('is a container of its own, named after the task, on the install’s network, sized as its seat says', async () => {
    const { calls, answer } = docker();

    const computer = await driverWith(answer).acquire(spec());

    const run = created(calls, 'task-3f2a9c1e');
    expect(computer).toMatchObject({ taskId: TASK, bot: 'atlas', container: 'task-3f2a9c1e', slotDir: join(workRoot, 'slots', TASK), cacheDir: '/cache' });
    expect(values(run, '--network')).toEqual(['fleetadlc-tasks']);
    expect(values(run, '--add-host')).toEqual(['host.docker.internal:host-gateway']);
    expect(values(run, '--cpus')).toEqual(['2']);
    expect(values(run, '--memory')).toEqual([String(6 * 1024 ** 3)]);
    expect(run?.at(-1)).toBe('fleetadlc-bot:latest');
  });

  it('runs under a process limit and with no-new-privileges, which its engine’s own sandbox no longer gives it', async () => {
    const { calls, answer } = docker();

    await driverWith(answer).acquire(spec());

    const run = created(calls, 'task-3f2a9c1e');
    expect(values(run, '--pids-limit')).toEqual([String(TASK_PIDS_LIMIT)]);
    expect(values(run, '--security-opt')).toEqual(['no-new-privileges:true']);
    expect(labels(run)).toContain(`fleetadlc.hardening=pids-${TASK_PIDS_LIMIT}+no-new-privileges`);
    // hostd still owns the cache as root: no-new-privileges does not reach `docker exec -u 0`.
    expect(run).not.toContain('--cap-drop');
    expect(run).not.toContain('--read-only');
    expect(calls).toContainEqual(['exec', '-u', '0', 'task-3f2a9c1e', 'chown', 'bot:bot', '/cache']);
  });

  it('mounts its own directory at the same path and nothing else of the work root, so every path hostd hands it opens', async () => {
    const { calls, answer } = docker();
    const slot = join(workRoot, 'slots', TASK);

    await driverWith(answer).acquire(spec());

    const run = created(calls, 'task-3f2a9c1e');
    expect(mounts(run)).toContain(`${slot}:${slot}`);
    // No mirror, no other task, no bot's folder: the clone is self-contained.
    expect(mounts(run).filter((mount) => mount.startsWith(workRoot))).toEqual([`${slot}:${slot}`]);
    expect(mounts(run)).toEqual(
      expect.arrayContaining([
        'fleetadlc-cache-default-acme__widgets:/cache',
        '/opt/fleetadlc/skills:/skills:ro',
        '/opt/fleetadlc/roles:/roles:ro',
        '/opt/fleetadlc/skill-runner.bundle.mjs:/usr/local/lib/fleetadlc/skill-runner.mjs:ro',
        `${GH_SHIM_DIR}:/opt/fleetadlc/bin:ro`,
      ]),
    );
    // Docker made the cache volume's mount point as root; the bot is given it.
    expect(calls).toContainEqual(['exec', '-u', '0', 'task-3f2a9c1e', 'chown', 'bot:bot', '/cache']);
    // hostd made the directory, and says beside it whose it is: not in it,
    // where the task, which has it mounted, could rewrite the record.
    expect(statSync(slot).isDirectory()).toBe(true);
    expect(JSON.parse(readFileSync(slotRecordPath(slot), 'utf8'))).toEqual({ taskId: TASK, bot: 'atlas' });
    expect(existsSync(join(slot, SLOT_FILE))).toBe(false);
  });

  it('reads its repository’s pnpm store read-only, and never writes it, not even to own it', async () => {
    // pnpm trusts its own index for a package it holds: a store a task could
    // write was one it could plant code in for the next task's `make ci`.
    const { calls, answer } = docker();

    await driverWith(answer).acquire(spec());

    const run = created(calls, 'task-3f2a9c1e');
    expect(mounts(run).filter((mount) => mount.includes('pnpm'))).toEqual(['fleetadlc-pnpm-default-acme__widgets:/pnpm-store:ro']);
    expect(calls.filter((args) => args[0] === 'exec' && args.join(' ').includes('/pnpm-store'))).toEqual([]);
  });

  it('has hostd fill that store in a container of its own, the only thing that writes it', async () => {
    const { calls, answer } = docker();
    const driver = driverWith(answer);
    const computer = await driver.acquire(spec());
    const worktree = join(computer.slotDir, 'wt');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");

    expect(await driver.fillPnpmStore(computer, worktree)).toEqual({ filled: true, path: '/pnpm-store' });

    const fill = calls.find((args) => args[0] === 'run' && args.join(' ').includes('pnpm fetch'))!;
    expect(mounts(fill)).toContain('fleetadlc-pnpm-default-acme__widgets:/pnpm-store');
    expect(labels(fill)).toEqual(expect.arrayContaining(['fleetadlc.install=default', 'fleetadlc.kind=pnpm-fill']));
  });

  it('records what it was made with, and nothing of the seat in its environment', async () => {
    const { calls, answer } = docker();

    await driverWith(answer).acquire(spec());

    const run = created(calls, 'task-3f2a9c1e');
    expect(labels(run)).toEqual(
      expect.arrayContaining([
        'fleetadlc.install=default',
        'fleetadlc.kind=computer',
        `fleetadlc.image=${IMAGE}`,
        'fleetadlc.login=none',
        'fleetadlc.repo=acme__widgets',
        `fleetadlc.slot=${join(workRoot, 'slots', TASK)}`,
        `fleetadlc.mounts=${MOUNTS}`,
        'fleetadlc.tools=gh-shim-1',
        'fleetadlc.egress=none',
      ]),
    );
    // A container's environment is fixed when it is made, and a warm one is
    // made before its seat is known.
    expect(envs(run).some((env) => env.startsWith('BOT_NAME='))).toBe(false);
    expect(envs(run)).toContain('HOSTD_URL=http://host.docker.internal:47312');
  });

  it('makes the install’s network once, closed between its containers', async () => {
    const { calls, answer } = docker();
    const driver = driverWith(answer);

    await driver.acquire(spec());
    await driver.acquire(spec({ taskId: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a' }));

    const made = calls.filter((args) => args[0] === 'network' && args[1] === 'create');
    expect(made).toEqual([
      ['network', 'create', '--driver', 'bridge', '--opt', 'com.docker.network.bridge.enable_icc=false', '--label', 'fleetadlc.install=default', 'fleetadlc-tasks'],
    ]);
  });

  it('gives a task on no repository no cache at all', async () => {
    const { calls, answer } = docker();

    const computer = await driverWith(answer).acquire(spec({ repoKey: null }));

    expect(mounts(created(calls, 'task-3f2a9c1e')).some((mount) => mount.endsWith(':/cache'))).toBe(false);
    expect(computer.cacheDir).toBeNull();
  });

  it('gets a database of its own when its seat runs checks, and none otherwise', async () => {
    const databases = { create: vi.fn(async (taskId: string) => `postgres://t_3f2a9c1e:pw@host.docker.internal:47433/t_${taskId.slice(0, 8)}`), drop: vi.fn(async () => undefined), urlFor: vi.fn(async () => null) };
    const { answer } = docker();
    const driver = driverWith(answer, { databases });

    const withChecks = await driver.acquire(spec({ database: true }));
    const without = await driver.acquire(spec({ taskId: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a', database: false }));

    expect(withChecks.databaseUrl).toBe('postgres://t_3f2a9c1e:pw@host.docker.internal:47433/t_3f2a9c1e');
    expect(without.databaseUrl).toBeNull();
    expect(databases.create).toHaveBeenCalledTimes(1);
  });
});

describe('a task’s name when another task already has it', () => {
  it('takes more of the id rather than another task’s container', async () => {
    const otherSlot = join(workRoot, 'slots', 'someone-else');
    mkdirSync(otherSlot, { recursive: true });
    const { calls, answer } = docker({
      'task-3f2a9c1e': { status: 'running', labels: { 'fleetadlc.install': 'default', 'fleetadlc.slot': otherSlot }, image: IMAGE },
    });

    const computer = await driverWith(answer).acquire(spec());

    expect(computer.container).toBe('task-3f2a9c1e7b4d');
    expect(calls.some((args) => args[0] === 'rm' && args.includes('task-3f2a9c1e'))).toBe(false);
  });

  it('removes a container left by the same task, and keeps its directory', async () => {
    const slot = join(workRoot, 'slots', TASK);
    mkdirSync(slot, { recursive: true });
    const { calls, answer } = docker({
      'task-3f2a9c1e': { status: 'running', labels: { 'fleetadlc.install': 'default', 'fleetadlc.slot': slot }, image: IMAGE },
    });
    const driver = driverWith(answer);
    // What the first computer wrote before hostd lost it.
    const { writeSlotTask } = await import('../worktree.js');
    writeSlotTask(slot, { taskId: TASK, bot: 'atlas' });

    const computer = await driver.acquire(spec());

    expect(calls).toContainEqual(['rm', '-f', '-v', 'task-3f2a9c1e']);
    expect(computer.container).toBe('task-3f2a9c1e');
    expect(existsSync(slot)).toBe(true);
  });
});

describe('giving a task’s computer back', () => {
  it('removes the container with its volume, drops its database, removes its directory, and does it once', async () => {
    const databases = { create: vi.fn(async () => 'postgres://x'), drop: vi.fn(async () => undefined), urlFor: vi.fn(async () => null) };
    const { calls, answer } = docker();
    const driver = driverWith(answer, { databases });
    const computer = await driver.acquire(spec({ database: true }));

    await driver.release(TASK, 'done');
    await driver.release(TASK, 'done again');

    // `-v`: the image declares /work a volume, and each container would leave one behind.
    expect(calls.filter((args) => args[0] === 'rm')).toEqual([['rm', '-f', '-v', 'task-3f2a9c1e']]);
    expect(databases.drop).toHaveBeenCalledWith(TASK);
    expect(existsSync(computer.slotDir)).toBe(false);
    expect(driver.computerOf(TASK)).toBeNull();
  });

  it('never removes a directory outside the work root', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'fleetadlc-outside-'));
    try {
      const { answer } = docker();
      const driver = driverWith(answer);
      await driver.acquire(spec({ slotDir: outside }));
      await driver.release(TASK, 'done');
      expect(existsSync(outside)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('a task on an OpenAI or xAI subscription', () => {
  const home = (taskId: string) => join(loginRoot, '.homes', taskId);
  /** The account's sign-in, where hostd keeps it; its path. */
  const signIn = (dir: string, content: string): string => {
    mkdirSync(join(dir, 'sign-in'), { recursive: true });
    writeFileSync(join(dir, 'sign-in', 'auth.json'), content);
    return join(dir, 'sign-in', 'auth.json');
  };

  it('gets a home of its own at /fleetadlc/login, outside the slot, and the account sign-in beside it', async () => {
    // The home used to live in the slot. The slot is mounted at its host
    // path, so replacing that home with a link made release read another
    // directory's auth.json onto the account. A copy of the token also went
    // stale: OpenAI refresh tokens are single-use.
    const dir = join(loginRoot, SEAT);
    mkdirSync(join(dir, 'plugins', 'planted'), { recursive: true });
    const auth = signIn(dir, '{"tokens":"start"}');
    writeFileSync(join(dir, 'plugins', 'planted', '.mcp.json'), '{}\n');
    const { calls, answer } = docker();

    await driverWith(answer).acquire(spec({ login: { accountId: SEAT, provider: 'openai' } }));

    const run = created(calls, 'task-3f2a9c1e');
    expect(mounts(run)).toContain(`${home(TASK)}:/fleetadlc/login`);
    expect(mounts(run)).toContain(`${auth}:/fleetadlc/login/auth.json`);
    expect(mounts(run).some((mount) => mount.endsWith(':/fleetadlc/auth'))).toBe(false);
    expect(envs(run).some((env) => env.startsWith('GROK_AUTH_PATH='))).toBe(false);
    expect(readFileSync(join(home(TASK), 'auth.json'), 'utf8')).toBe('');
    expect(readFileSync(auth, 'utf8')).toBe('{"tokens":"start"}');
    expect(existsSync(join(home(TASK), 'plugins'))).toBe(false);
    expect(labels(run)).toContain(`fleetadlc.login=${SEAT}`);
    expect(statSync(home(TASK)).mode & 0o777).toBe(0o700);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(loginRoot).mode & 0o777).toBe(0o700);
  });

  it('mounts only the sign-in directory for a Grok task, at /fleetadlc/auth, and tells Grok where auth.json is', async () => {
    // The whole account directory used to be this mount: what a task planted
    // there sat beside the account's own files, and a backup carried it.
    const dir = join(loginRoot, SEAT);
    signIn(dir, '{"tokens":"start"}');
    const { calls, answer } = docker();

    await driverWith(answer).acquire(spec({ login: { accountId: SEAT, provider: 'xai' } }));

    const run = created(calls, 'task-3f2a9c1e');
    expect(mounts(run)).toContain(`${home(TASK)}:/fleetadlc/login`);
    expect(mounts(run)).toContain(`${join(dir, 'sign-in')}:/fleetadlc/auth`);
    expect(mounts(run).some((mount) => mount.startsWith(`${dir}:`))).toBe(false);
    expect(envs(run)).toContain('GROK_AUTH_PATH=/fleetadlc/auth/auth.json');
  });

  it('moves a sign-in an earlier build kept at the top of the account directory, and mounts it from its own', async () => {
    const dir = join(loginRoot, SEAT);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'auth.json'), '{"tokens":"legacy"}');
    const { calls, answer } = docker();

    await driverWith(answer).acquire(spec({ login: { accountId: SEAT, provider: 'xai' } }));

    const run = created(calls, 'task-3f2a9c1e');
    expect(existsSync(join(dir, 'auth.json'))).toBe(false);
    expect(readFileSync(join(dir, 'sign-in', 'auth.json'), 'utf8')).toBe('{"tokens":"legacy"}');
    expect(mounts(run)).toContain(`${join(dir, 'sign-in')}:/fleetadlc/auth`);
  });

  it('refuses a login that names no provider, rather than mounting it as an OpenAI one', async () => {
    // Read as OpenAI, a Grok task got no sign-in directory and no
    // GROK_AUTH_PATH, and ran signed out.
    signIn(join(loginRoot, SEAT), '{"tokens":"start"}');
    const { calls, answer } = docker();

    await expect(driverWith(answer).acquire(spec({ login: { accountId: SEAT } as never }))).rejects.toThrow(/names no provider/);

    expect(calls.some((args) => args[0] === 'run' || args[0] === 'create')).toBe(false);
  });

  it('does not mount a sign-in that is a link, or the account directory', async () => {
    const dir = join(loginRoot, SEAT);
    const elsewhere = join(workRoot, 'other-auth.json');
    mkdirSync(join(dir, 'sign-in'), { recursive: true });
    writeFileSync(elsewhere, '{"tokens":"not-this-account"}');
    symlinkSync(elsewhere, join(dir, 'sign-in', 'auth.json'));
    const { calls, answer } = docker();

    await driverWith(answer).acquire(spec({ login: { accountId: SEAT, provider: 'openai' } }));

    const run = created(calls, 'task-3f2a9c1e');
    expect(mounts(run).some((mount) => mount.includes('auth.json') || mount.endsWith(':/fleetadlc/auth'))).toBe(false);
    expect(envs(run).some((env) => env.startsWith('GROK_AUTH_PATH='))).toBe(false);
    expect(existsSync(join(home(TASK), 'auth.json'))).toBe(false);
  });

  it('gives the next task a different home, so a file this one wrote is not there', async () => {
    const other = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
    const { calls, answer } = docker();
    const driver = driverWith(answer);

    await driver.acquire(spec({ login: { accountId: SEAT, provider: 'openai' } }));
    mkdirSync(join(home(TASK), 'plugins', 'planted'), { recursive: true });
    writeFileSync(join(home(TASK), 'plugins', 'planted', '.mcp.json'), '{}\n');
    await driver.acquire(spec({ taskId: other, bot: 'quill', login: { accountId: SEAT, provider: 'openai' } }));

    const first = mounts(created(calls, 'task-3f2a9c1e')).filter((mount) => mount.endsWith(':/fleetadlc/login'));
    const second = mounts(created(calls, 'task-9d8c7b6a')).filter((mount) => mount.endsWith(':/fleetadlc/login'));
    expect(first).toEqual([`${home(TASK)}:/fleetadlc/login`]);
    expect(second).toEqual([`${home(other)}:/fleetadlc/login`]);
    expect(existsSync(join(home(other), 'plugins'))).toBe(false);
    expect(existsSync(join(loginRoot, SEAT, 'plugins'))).toBe(false);
  });

  it('leaves the account sign-in in place and removes the home', async () => {
    const auth = signIn(join(loginRoot, SEAT), '{"tokens":"start"}');
    const { answer } = docker();
    const driver = driverWith(answer);
    await driver.acquire(spec({ login: { accountId: SEAT, provider: 'openai' } }));
    writeFileSync(join(home(TASK), 'auth.json'), '{"tokens":"from-the-home"}');

    await driver.release(TASK, 'done');

    expect(readFileSync(auth, 'utf8')).toBe('{"tokens":"start"}');
    expect(existsSync(home(TASK))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)('removes a home in which the task left a directory nobody can enter', async () => {
    // `rmSync` threw on the `chmod 000` directory, and release left the home.
    signIn(join(loginRoot, SEAT), '{"tokens":"start"}');
    const { answer } = docker();
    const driver = driverWith(answer);
    await driver.acquire(spec({ login: { accountId: SEAT, provider: 'openai' } }));
    mkdirSync(join(home(TASK), 'plugins', 'inner'), { recursive: true });
    writeFileSync(join(home(TASK), 'plugins', 'inner', 'file'), 'x');
    chmodSync(join(home(TASK), 'plugins', 'inner'), 0o000);
    chmodSync(join(home(TASK), 'plugins'), 0o000);

    await driver.release(TASK, 'done');

    expect(existsSync(home(TASK))).toBe(false);
  });

  it('still removes the container when the home path is a file', async () => {
    // A home replaced with a file used to throw ENOTDIR before the container
    // was removed, so release failed and the reaper left the computer held.
    const auth = signIn(join(loginRoot, SEAT), '{"tokens":"start"}');
    const { calls, answer } = docker();
    const driver = driverWith(answer);
    await driver.acquire(spec({ login: { accountId: SEAT, provider: 'openai' } }));
    rmSync(home(TASK), { recursive: true });
    writeFileSync(home(TASK), 'not a directory');

    await driver.release(TASK, 'done');

    expect(calls.filter((args) => args[0] === 'rm')).toEqual([['rm', '-f', '-v', 'task-3f2a9c1e']]);
    expect(existsSync(home(TASK))).toBe(false);
    expect(readFileSync(auth, 'utf8')).toBe('{"tokens":"start"}');
    expect(driver.computerOf(TASK)).toBeNull();
  });

  it('drops the home when a leftover computer is discarded', async () => {
    const slot = join(workRoot, 'slots', TASK);
    mkdirSync(home(TASK), { recursive: true });
    writeFileSync(join(home(TASK), 'notes'), 'session');
    const { answer, containers } = docker({
      'task-3f2a9c1e': {
        status: 'exited',
        labels: { 'fleetadlc.install': 'default', 'fleetadlc.kind': 'computer', 'fleetadlc.slot': slot },
        image: IMAGE,
      },
    });

    await driverWith(answer).discard('task-3f2a9c1e');

    expect(containers['task-3f2a9c1e']).toBeUndefined();
    expect(existsSync(home(TASK))).toBe(false);
  });

  it('is told the login is at the mount point, whatever the host calls it', () => {
    const driver = driverWith(docker().answer);

    expect(driver.loginPath(SEAT)).toBe('/fleetadlc/login');
    expect(() => driver.loginPath('../../../etc')).toThrow(/not a model account id/);
  });
});

describe('a task on anything else', () => {
  it('gets no login directory on a key account or with no account', async () => {
    const { calls, answer } = docker();

    await driverWith(answer).acquire(spec({ login: null }));

    const run = created(calls, 'task-3f2a9c1e');
    expect(mounts(run).some((mount) => mount.endsWith(':/fleetadlc/login'))).toBe(false);
    expect(labels(run)).toContain('fleetadlc.login=none');
  });

  it('mounts only its own seat’s sealed files, never another’s and never the login root', async () => {
    const { calls, answer } = docker();

    await driverWith(answer).acquire(spec({ login: { accountId: OTHER_SEAT, provider: 'openai' } }));

    const logins = mounts(created(calls, 'task-3f2a9c1e')).filter((mount) => mount.startsWith(loginRoot));
    expect(logins).toEqual([
      `${join(loginRoot, '.homes', TASK)}:/fleetadlc/login`,
      `${join(loginRoot, '.published', OTHER_SEAT, 'config.toml')}:/fleetadlc/login/config.toml:ro`,
      `${join(loginRoot, '.published', OTHER_SEAT, 'AGENTS.md')}:/fleetadlc/login/AGENTS.md:ro`,
      `${join(loginRoot, '.published', OTHER_SEAT, 'AGENTS.override.md')}:/fleetadlc/login/AGENTS.override.md:ro`,
      `${join(loginRoot, '.published', OTHER_SEAT, 'managed_config.toml')}:/fleetadlc/login/managed_config.toml:ro`,
      `${join(loginRoot, '.published', OTHER_SEAT, 'requirements.toml')}:/fleetadlc/login/requirements.toml:ro`,
      `${join(loginRoot, '.published', OTHER_SEAT, '.env')}:/fleetadlc/login/.env:ro`,
    ]);
  });

  it('mounts the sealed config read-only, not the config.toml a task wrote into the shared login', async () => {
    // The shared file is the CLI's home config. A task wrote mcp_servers into
    // it, and the next task on the account loaded them before its model.
    const dir = join(loginRoot, SEAT);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.toml'), 'model = "gpt-5"\n');
    const { calls, answer } = docker();
    const driver = driverWith(answer);
    const other = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';

    await driver.acquire(spec({ login: { accountId: SEAT, provider: 'openai' } }));
    const firstMount = mounts(created(calls, 'task-3f2a9c1e')).find((mount) => mount.endsWith(':/fleetadlc/login/config.toml:ro'));
    writeFileSync(join(dir, 'config.toml'), '[mcp_servers.planted]\ncommand = "sh"\n');
    await driver.acquire(spec({ taskId: other, bot: 'quill', login: { accountId: SEAT, provider: 'openai' } }));

    const secondMount = mounts(created(calls, 'task-9d8c7b6a')).find((mount) => mount.endsWith(':/fleetadlc/login/config.toml:ro'));
    const sealed = join(loginRoot, '.published', SEAT, 'config.toml');
    expect(firstMount).toBe(`${sealed}:/fleetadlc/login/config.toml:ro`);
    expect(secondMount).toBe(firstMount);
    expect(readFileSync(sealed, 'utf8')).toBe('model = "gpt-5"\n');
  });
});

describe('a task behind the cloud host’s egress proxy', () => {
  const PROXY = 'http://host.docker.internal:3128';

  it('is told the proxy in both spellings, with hostd itself bypassed', async () => {
    const { calls, answer } = docker();

    await driverWith(answer, { egressProxy: PROXY }).acquire(spec());

    const env = envs(created(calls, 'task-3f2a9c1e'));
    expect(env).toEqual(expect.arrayContaining([`HTTPS_PROXY=${PROXY}`, `https_proxy=${PROXY}`, 'NO_PROXY=host.docker.internal,localhost,127.0.0.1']));
    expect(labels(created(calls, 'task-3f2a9c1e'))).toContain(`fleetadlc.egress=${PROXY}#2`);
  });

  it('is told nothing about a proxy on an install that has none', async () => {
    const { calls, answer } = docker();

    await driverWith(answer).acquire(spec());

    expect(envs(created(calls, 'task-3f2a9c1e')).some((env) => /proxy/i.test(env))).toBe(false);
  });
});

describe('a container hostd starts for a moment', () => {
  it('gets the proxy and the name that reaches it, on a host that has one', () => {
    expect(probeNetworkArgs('http://host.docker.internal:3128')).toEqual(
      expect.arrayContaining(['--add-host', 'host.docker.internal:host-gateway', '-e', 'HTTPS_PROXY=http://host.docker.internal:3128']),
    );
  });

  it('gets nothing extra where there is no proxy', () => {
    expect(probeNetworkArgs(undefined)).toEqual([]);
  });
});

/**
 * Two installs on one Docker daemon — `fleetadlc up` and the compose stack —
 * both run tasks. One install's hostd must never reuse or remove the other's.
 */
describe('two installs on one Docker daemon', () => {
  function composeDriver(answer: (args: string[]) => Promise<DockerResult>): DockerDriver {
    return new DockerDriver({
      image: 'fleetadlc-bot:latest',
      networkPrefix: 'fleetadlc-compose-bot-net',
      botPrefix: 'fleetadlc-compose-bot-',
      installId: 'compose-fleetadlc',
      runnerBundle: '/opt/fleetadlc/skill-runner.bundle.mjs',
      workRoot,
      skillsRoot: '/opt/fleetadlc/skills',
      rolesRoot: '/opt/fleetadlc/roles',
      hostdUrl: 'http://host.docker.internal:47312',
      loginRoot,
      docker: answer,
    });
  }

  it('names another install’s computers, network and caches after its own prefix and install', async () => {
    const { calls, answer } = docker();

    await composeDriver(answer).acquire(spec());

    const run = created(calls, 'fleetadlc-compose-bot-task-3f2a9c1e');
    expect(labels(run)).toContain('fleetadlc.install=compose-fleetadlc');
    expect(values(run, '--network')).toEqual(['fleetadlc-compose-bot-tasks']);
    expect(mounts(run)).toContain('fleetadlc-cache-compose-fleetadlc-acme__widgets:/cache');
  });

  it('never reuses or removes a task container another install made, and says whose it is', async () => {
    const { calls, answer } = docker({
      'task-3f2a9c1e': { status: 'running', labels: { 'fleetadlc.install': 'compose-fleetadlc', 'fleetadlc.kind': 'computer' }, image: IMAGE },
    });
    const driver = driverWith(answer);

    await expect(driver.acquire(spec())).rejects.toThrow('task-3f2a9c1e belongs to install compose-fleetadlc');
    await expect(driver.discard('task-3f2a9c1e')).rejects.toThrow('belongs to install compose-fleetadlc');
    expect(calls.some((args) => args[0] === 'rm')).toBe(false);
  });

  it('never takes over another install’s task network', async () => {
    const { answer } = docker({}, { networks: { 'fleetadlc-tasks': { labels: { 'fleetadlc.install': 'compose-fleetadlc' } } } });

    await expect(driverWith(answer).acquire(spec())).rejects.toThrow('fleetadlc-tasks belongs to install compose-fleetadlc');
  });
});

describe('computers found after hostd restarts', () => {
  it('lists this install’s, says whose each is, and takes a running one back with its sessions', async () => {
    const slot = join(workRoot, 'slots', TASK);
    const { writeSlotTask } = await import('../worktree.js');
    writeSlotTask(slot, { taskId: TASK, bot: 'atlas' });
    const { answer } = docker({
      'task-3f2a9c1e': {
        status: 'running',
        labels: { 'fleetadlc.install': 'default', 'fleetadlc.kind': 'computer', 'fleetadlc.slot': slot, 'fleetadlc.repo': 'acme__widgets' },
        image: IMAGE,
        sessions: ['shell', 'implement-3f2a9c1e'],
      },
      'warm-a1b2c3d4': {
        status: 'running',
        labels: { 'fleetadlc.install': 'default', 'fleetadlc.kind': 'computer', 'fleetadlc.slot': join(workRoot, 'slots', 'warm-a1b2c3d4') },
        image: IMAGE,
      },
      'task-ffffffff': { status: 'running', labels: { 'fleetadlc.install': 'compose-fleetadlc', 'fleetadlc.kind': 'computer' }, image: IMAGE },
    });
    const driver = driverWith(answer);

    const found = await driver.computers();

    expect(found.map((one) => [one.name, one.kind, one.taskId])).toEqual([
      ['task-3f2a9c1e', 'task', TASK],
      ['warm-a1b2c3d4', 'warm', null],
    ]);
    const computer = await driver.adopt(found[0]!);
    expect(computer).toMatchObject({ taskId: TASK, bot: 'atlas', container: 'task-3f2a9c1e', slotDir: slot, cacheDir: '/cache' });
    // The image's idle shell in every container is not a task's session.
    const sessions = await driver.listSessions('atlas');
    expect(sessions.map((session) => session.name)).toEqual(['implement-3f2a9c1e']);
    expect(driver.attachCommand('atlas', 'implement-3f2a9c1e')).toEqual(['docker', 'exec', '-it', 'task-3f2a9c1e', 'tmux', 'attach', '-t', '=implement-3f2a9c1e']);
  });

  it('gives an adopted computer its task’s database again, rebuilt, and none without a database server', async () => {
    // Local CI runs through `docker exec`, which does not inherit the session's
    // environment: an adopted computer with no URL ran `make ci` with no database.
    const slot = join(workRoot, 'slots', TASK);
    const { writeSlotTask } = await import('../worktree.js');
    writeSlotTask(slot, { taskId: TASK, bot: 'atlas' });
    const containers: Record<string, Container> = {
      'task-3f2a9c1e': { status: 'running', labels: { 'fleetadlc.install': 'default', 'fleetadlc.kind': 'computer', 'fleetadlc.slot': slot }, image: IMAGE },
    };
    const url = `postgres://t_x:derived@host.docker.internal:47433/t_x`;
    const databases = { create: vi.fn(async () => url), drop: vi.fn(async () => undefined), urlFor: vi.fn(async () => url) };

    const withServer = driverWith(docker(containers).answer, { databases });
    const adopted = await withServer.adopt((await withServer.computers())[0]!);
    expect(databases.urlFor).toHaveBeenCalledWith(TASK);
    expect(adopted?.databaseUrl).toBe(url);

    const without = driverWith(docker(containers).answer);
    expect((await without.adopt((await without.computers())[0]!))?.databaseUrl).toBeNull();
  });

  it('finds each of a bot’s sessions in the computer it is in', async () => {
    const { answer, containers } = docker();
    const driver = driverWith(answer);
    const one = await driver.acquire(spec());
    const two = await driver.acquire(spec({ taskId: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a' }));
    containers['task-3f2a9c1e']!.sessions = ['shell', 'implement-3f2a9c1e'];
    containers['task-9d8c7b6a']!.sessions = ['shell', 'pr-review-9d8c7b6a'];

    const sessions = await driver.listSessions('atlas');

    expect(sessions.map((session) => session.name).sort()).toEqual(['implement-3f2a9c1e', 'pr-review-9d8c7b6a']);
    expect(driver.attachCommand('atlas', 'pr-review-9d8c7b6a')).toContain(two.container);
    expect(driver.attachCommand('atlas', 'implement-3f2a9c1e')).toContain(one.container);
    expect(() => driver.attachCommand('atlas', 'gone-00000000')).toThrow(/no computer of atlas's has a session gone-00000000/);
  });

  it('throws rather than answer for a computer whose listing failed, which is not "its sessions are gone"', async () => {
    const fake = docker();
    const driver = driverWith(async (args) => {
      if (args[0] === 'exec' && args.includes('list-sessions')) return { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' };
      return fake.answer(args);
    });
    await driver.acquire(spec());

    await expect(driver.listSessions('atlas')).rejects.toThrow(/could not read sessions in task-3f2a9c1e: .*Cannot connect to the Docker daemon/);
  });

  it('throws for a listing without the idle shell every live computer has', async () => {
    const { answer, containers } = docker();
    const driver = driverWith(answer);
    await driver.acquire(spec());
    containers['task-3f2a9c1e']!.sessions = [];

    await expect(driver.listSessions('atlas')).rejects.toThrow(/could not read sessions in task-3f2a9c1e: its idle shell session is missing/);
  });
});

describe('a warm computer', () => {
  async function warmDriver(answer: (args: string[]) => Promise<DockerResult>, activeRepos: string[] = ['acme__widgets']) {
    const { WarmPool } = await import('../warm-pool.js');
    const driver = driverWith(answer);
    const pool = new WarmPool({ host: driver, enabled: true, max: 3, room: () => 4, activeRepos: async () => activeRepos });
    driver.usePool(pool);
    await pool.fill();
    return { driver, pool };
  }

  it('is made ahead of any task with no login, no seat, its repository’s cache and a folder named after it', async () => {
    const { calls, answer } = docker();

    const { pool } = await warmDriver(answer);

    const made = pool.list().find((warm) => warm.repoKey === 'acme__widgets')!;
    expect(made.name).toMatch(/^warm-[0-9a-f]{8}$/);
    const run = created(calls, made.name);
    expect(mounts(run)).toEqual(
      expect.arrayContaining([`${made.slotDir}:${made.slotDir}`, 'fleetadlc-cache-default-acme__widgets:/cache', 'fleetadlc-pnpm-default-acme__widgets:/pnpm-store:ro']),
    );
    expect(labels(run)).toEqual(expect.arrayContaining(['fleetadlc.login=none', 'fleetadlc.kind=computer', 'fleetadlc.repo=acme__widgets']));
    // Nothing in a computer ever writes the store, not even to own it.
    expect(calls.filter((args) => args[0] === 'exec' && args.join(' ').includes('/pnpm-store'))).toEqual([]);
    expect(envs(run).some((env) => env.startsWith('BOT_NAME='))).toBe(false);
  });

  it('runs under the same process limit and no-new-privileges as a cold one', async () => {
    const { calls, answer } = docker();

    const { pool } = await warmDriver(answer);

    const made = pool.list().find((warm) => warm.repoKey === 'acme__widgets')!;
    const run = created(calls, made.name);
    expect(values(run, '--pids-limit')).toEqual([String(TASK_PIDS_LIMIT)]);
    expect(values(run, '--security-opt')).toEqual(['no-new-privileges:true']);
    expect(labels(run)).toContain(`fleetadlc.hardening=pids-${TASK_PIDS_LIMIT}+no-new-privileges`);
  });

  it('made by a hostd before the limits, is found as warm and not the pool’s, so the reaper drains it', async () => {
    const { calls, answer, containers } = docker();
    containers['warm-0ld0ld00'] = {
      status: 'running',
      image: IMAGE,
      labels: { 'fleetadlc.install': 'default', 'fleetadlc.kind': 'computer', 'fleetadlc.repo': 'acme__widgets', 'fleetadlc.slot': join(workRoot, 'slots', 'warm-0ld0ld00') },
    };
    const { driver, pool } = await warmDriver(answer);
    const ours = pool.list().find((warm) => warm.repoKey === 'acme__widgets')!;

    const old = (await driver.computers()).find((found) => found.name === 'warm-0ld0ld00');

    expect(old).toMatchObject({ kind: 'warm', taskId: null });
    expect(driver.isWarm('warm-0ld0ld00')).toBe(false);
    // Never handed to a task: the claim takes only what the pool made.
    await driver.acquire(spec());
    expect(calls).toContainEqual(['rename', ours.name, 'task-3f2a9c1e']);
    expect(calls.some((args) => args[0] === 'rename' && args[1] === 'warm-0ld0ld00')).toBe(false);
    expect(containers[ours.name]?.labels?.['fleetadlc.hardening']).toBe(`pids-${TASK_PIDS_LIMIT}+no-new-privileges`);
  });

  it('is claimed by resizing it to the seat and renaming it the task’s, and its folder says whose it is', async () => {
    const { calls, answer } = docker();
    const { driver, pool } = await warmDriver(answer);
    const warm = pool.list().find((one) => one.repoKey === 'acme__widgets')!;

    const computer = await driver.acquire(spec({ cpus: 3, memoryGb: 6 }));

    // No container made for the task itself: the warm one is it.
    expect(created(calls, 'task-3f2a9c1e')).toBeUndefined();
    expect(calls).toContainEqual(['update', '--cpus', '3', '--memory', String(6 * 1024 ** 3), '--memory-swap', String(12 * 1024 ** 3), warm.name]);
    expect(calls).toContainEqual(['rename', warm.name, 'task-3f2a9c1e']);
    expect(computer).toMatchObject({ container: 'task-3f2a9c1e', slotDir: warm.slotDir });
    expect(JSON.parse(readFileSync(slotRecordPath(warm.slotDir), 'utf8'))).toEqual({ taskId: TASK, bot: 'atlas' });
    expect(pool.holds(warm.name)).toBe(false);
  });

  it('is never claimed for a task whose account needs a login, which starts cold', async () => {
    const { calls, answer } = docker();
    const { driver } = await warmDriver(answer);

    const computer = await driver.acquire(spec({ login: { accountId: SEAT, provider: 'openai' } }));

    expect(calls.some((args) => args[0] === 'rename')).toBe(false);
    expect(created(calls, 'task-3f2a9c1e')).toBeDefined();
    expect(computer.slotDir).toBe(join(workRoot, 'slots', TASK));
  });

  it('is given up, and the task started cold, when a claim fails', async () => {
    const { calls, answer } = docker();
    const failing = async (args: string[]): Promise<DockerResult> =>
      args[0] === 'rename' ? { code: 1, stdout: '', stderr: 'Error: conflict' } : answer(args);
    const { driver, pool } = await warmDriver(failing);
    const warm = pool.list().find((one) => one.repoKey === 'acme__widgets')!;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const computer = await driver.acquire(spec());

    expect(calls).toContainEqual(['rm', '-f', '-v', warm.name]);
    expect(created(calls, 'task-3f2a9c1e')).toBeDefined();
    expect(computer.slotDir).toBe(join(workRoot, 'slots', TASK));
  });
});

describe('after the engine update swaps the image', () => {
  it('leaves running tasks on the image they started with, says whose they are, and prunes what nothing uses', async () => {
    const { calls, answer, containers } = docker();
    const driver = driverWith(answer);
    await driver.acquire(spec());
    containers['task-3f2a9c1e']!.image = OLD_IMAGE;

    const moved = await driver.refreshComputers();

    expect(moved).toEqual({ refreshed: [], deferred: ['atlas'] });
    expect(calls.some((args) => args[0] === 'rm')).toBe(false);
    expect(calls).toContainEqual(['image', 'prune', '-f']);
  });
});

describe('a task’s secrets on their way into its computer', () => {
  /** Docker as `docker()`, keeping what each call wrote to stdin and put in the client’s environment. */
  function recording() {
    const { calls, answer } = docker();
    const inputs: string[] = [];
    const clientEnv: Record<string, string>[] = [];
    const withSecrets = async (args: string[], input?: string, secrets?: Record<string, string>): Promise<DockerResult> => {
      if (input !== undefined) inputs.push(input);
      if (secrets) clientEnv.push(secrets);
      return answer(args);
    };
    return { calls, inputs, clientEnv, driver: driverWith(withSecrets) };
  }

  it('names the database URL on the `docker exec` that runs `make setup`, and values it only in the docker client’s environment', async () => {
    const { calls, clientEnv, driver } = recording();
    const computer = await driver.acquire(spec());
    const url = 'postgres://t_x:a-task-password@host.docker.internal:47433/t_x';

    await driver.exec(computer, ['make', '-s', 'setup'], { cwd: '/work', env: { DATABASE_URL: url, FLEETADLC_REPO_HOME: '/work/home' } });

    const exec = calls.at(-1)!;
    expect(exec.join(' ')).not.toContain('a-task-password');
    expect(envs(exec)).toContain('DATABASE_URL');
    // The rest is the container's, and stays on the command line, where the client's own PATH and HOME cannot be taken for it.
    expect(envs(exec)).toContain('HOME=/work/home');
    expect(clientEnv.at(-1)).toEqual({ DATABASE_URL: url });
  });

  it('keeps a command’s deadline inside the container, where killing the docker client could not stop it', async () => {
    const { calls, driver } = recording();
    const computer = await driver.acquire(spec());

    await driver.exec(computer, ['make', 'ci'], { cwd: '/work', timeoutMs: 60 * 60_000 });

    const exec = calls.at(-1)!;
    expect(exec.slice(exec.indexOf(computer.container!))).toEqual([computer.container, 'timeout', '--kill-after=30s', '3600s', 'make', 'ci']);
  });

  it('hands a session its environment on stdin rather than on the tmux command line', async () => {
    const { calls, inputs, driver } = recording();
    const computer = await driver.acquire(spec());

    await driver.startSession({ computer, name: 'atlas__build', cwd: '/work', command: ['node', '/runner.mjs'], env: { GH_TOKEN: 'ghs_a-task-token' } });

    for (const args of calls) expect(args.join(' ')).not.toContain('ghs_a-task-token');
    const started = calls.find((args) => args.includes('new-session'))!;
    expect(started.slice(started.indexOf('/usr/bin/env'))).toEqual([
      '/usr/bin/env',
      '-i',
      '/bin/sh',
      '-c',
      'set -a && . "$0" && rm -f "$0" && exec "$@"',
      expect.stringMatching(/^\/dev\/shm\/fleetadlc-env-[0-9a-f]{16}$/),
      'node',
      '/runner.mjs',
    ]);
    expect(inputs.at(-1)).toContain("GH_TOKEN='ghs_a-task-token'");
  });

  it('writes an environment the shell reads back exactly, quotes and newlines and all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleetadlc-session-env-'));
    try {
      const file = join(dir, 'env');
      const env = { PLAIN: 'value', QUOTED: "it's $HOME `x` \\ \"y\"", LINES: 'one\ntwo' };
      writeFileSync(file, sessionEnvFile(env));
      const seen = execFileSync('/usr/bin/env', ['-i', '/bin/sh', '-c', 'set -a && . "$0" && rm -f "$0" && exec "$@"', file, '/usr/bin/env'], { encoding: 'utf8' });
      for (const [name, value] of Object.entries(env)) expect(seen).toContain(`${name}=${value}`);
      expect(existsSync(file)).toBe(false);
      expect(() => sessionEnvFile({ 'not-a-name': 'x' })).toThrow(/cannot be/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a Docker daemon that does not answer', () => {
  /** A `docker` first on PATH that hangs, as the client does while Docker Desktop wakes. */
  function hungDocker(): () => void {
    const dir = join(workRoot, 'bin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'docker'), '#!/bin/sh\nexec sleep 30\n');
    chmodSync(join(dir, 'docker'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${dir}:${path ?? ''}`;
    return () => {
      process.env.PATH = path;
    };
  }

  it('fails a call given a timeout once it passes, saying what to check, rather than hanging', async () => {
    const restore = hungDocker();
    try {
      const started = Date.now();
      const result = await runDocker(['ps'], undefined, undefined, { timeoutMs: 200 });

      expect(result.code).not.toBe(0);
      expect(result.stderr).toBe('docker did not answer within 0.2 s; is the Docker daemon running?');
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      restore();
    }
  });

  it('gives a timeout to the tmux calls and the reaper’s listing and removal, and none to `make setup` or `docker run`', async () => {
    const seen: { args: string[]; timeoutMs?: number }[] = [];
    const { answer } = docker();
    const driver = new DockerDriver({
      image: 'fleetadlc-bot:latest',
      networkPrefix: 'fleetadlc-bot',
      runnerBundle: '/opt/fleetadlc/skill-runner.bundle.mjs',
      workRoot,
      skillsRoot: '/opt/fleetadlc/skills',
      rolesRoot: '/opt/fleetadlc/roles',
      hostdUrl: 'http://host.docker.internal:47312',
      loginRoot,
      docker: (args, _input, _secrets, options) => {
        seen.push({ args, timeoutMs: options?.timeoutMs });
        return answer(args);
      },
    });
    const computer = await driver.acquire(spec());
    await driver.exec(computer, ['make', 'setup'], { cwd: '/work' });
    await driver.listSessions('atlas');
    await driver.computers();
    await driver.discard('task-3f2a9c1e');

    const timeoutOf = (match: (args: string[]) => boolean) => seen.filter((call) => match(call.args)).map((call) => call.timeoutMs);
    expect(timeoutOf((args) => args[0] === 'run')).toEqual([undefined]);
    expect(timeoutOf((args) => args.includes('make'))).toEqual([undefined]);
    expect(timeoutOf((args) => args.includes('tmux') && args.includes('list-sessions'))).toEqual([30_000]);
    expect(timeoutOf((args) => args[0] === 'ps')).toEqual([30_000]);
    expect(timeoutOf((args) => args[0] === 'rm')).toEqual([30_000]);
  });
});
