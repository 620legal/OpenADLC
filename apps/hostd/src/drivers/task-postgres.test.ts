import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeSlotTask } from '../worktree.js';
import { DockerDriver, type DockerResult } from './docker.js';
import { TASK_POSTGRES_PIDS_LIMIT, TASK_POSTGRES_READY_ATTEMPTS } from './task-postgres.js';
import type { TaskComputerSpec } from './types.js';

/**
 * A task's own Postgres servers under the docker driver (#136), with Docker
 * answering from a script that keeps what it was asked to make: which
 * container's network namespace each joined, what it was made with, when it
 * takes connections, and what is left once a computer goes.
 */

const TASK = '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f';
const OTHER = '9b1c4e2a-0f3d-4c5b-8a7e-6d5c4b3a2f10';
/** acme/app's local Postgres, as its docker-compose.yml and Makefile name it. */
const APP = { port: 55432, superuser: 'app', password: 'app', database: 'app_db', image: 'pgvector/pgvector:pg16' };

interface Box {
  id: string;
  status: 'running' | 'exited';
  labels: Record<string, string>;
  /** `container:<id>` for a server. */
  networkMode: string;
}

let workRoot: string;
let loginRoot: string;

beforeEach(() => {
  workRoot = mkdtempSync(join(tmpdir(), 'openadlc-task-postgres-work-'));
  loginRoot = join(mkdtempSync(join(tmpdir(), 'openadlc-task-postgres-logins-')), 'logins');
});

afterEach(() => {
  rmSync(workRoot, { recursive: true, force: true });
  rmSync(join(loginRoot, '..'), { recursive: true, force: true });
});

function daemon(
  options: {
    /** How many `pg_isready` checks a server fails before it takes connections; Infinity for never. */
    readyAfter?: number;
    /** A server that exits as it starts, with these last words. */
    dies?: string;
    images?: string[];
    pull?: 'ok' | 'refused';
    /** `container inspect` of a computer by id that does not answer. */
    silent?: string[];
  } = {},
) {
  const containers = new Map<string, Box>();
  const images = new Set(options.images ?? [APP.image]);
  const calls: string[][] = [];
  const secrets: Record<string, string>[] = [];
  const checks = new Map<string, number>();
  let next = 1;
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];
  const ok = (stdout = ''): DockerResult => ({ code: 0, stdout, stderr: '' });
  const missing = (name: string): DockerResult => ({ code: 1, stdout: '', stderr: `Error response from daemon: No such container: ${name}` });
  const byIdOrName = (key: string) => containers.get(key) ?? [...containers.values()].find((box) => box.id === key);
  const nameOf = (box: Box) => [...containers.entries()].find(([, value]) => value === box)?.[0] ?? '';

  const answer = async (args: string[], _input?: string, secret?: Record<string, string>): Promise<DockerResult> => {
    calls.push(args);
    if (secret) secrets.push(secret);
    const [verb, sub] = args;
    if (verb === 'network') return ok('[{"Labels":{"openadlc.install":"default"},"Options":{"com.docker.network.bridge.enable_icc":"false"}}]');
    if (verb === 'image' && sub === 'inspect') return images.has(args.at(-1)!) ? ok('sha256:image\n') : { code: 1, stdout: '', stderr: 'No such image' };
    if (verb === 'pull') {
      if (options.pull === 'refused') return { code: 1, stdout: '', stderr: 'toomanyrequests: You have reached your pull rate limit' };
      images.add(args[1]!);
      return ok();
    }
    if (verb === 'run') {
      const labels: Record<string, string> = {};
      args.forEach((arg, index) => {
        if (arg === '--label') {
          const [key, ...value] = (args[index + 1] ?? '').split('=');
          labels[key!] = value.join('=');
        }
      });
      const network = flag(args, '--network') ?? '';
      const joined = network.startsWith('container:') ? byIdOrName(network.slice('container:'.length)) : undefined;
      if (network.startsWith('container:') && !joined) return { code: 125, stdout: '', stderr: 'no such container to join' };
      const id = `${String(next++).padStart(2, '0')}${'f'.repeat(62)}`;
      const isServer = labels['openadlc.kind'] === 'task-postgres';
      containers.set(flag(args, '--name') ?? '', {
        id,
        status: isServer && options.dies ? 'exited' : 'running',
        labels,
        networkMode: joined ? `container:${joined.id}` : network,
      });
      return ok(`${id}\n`);
    }
    if (verb === 'rm') {
      const name = args.at(-1)!;
      containers.delete(name);
      return ok();
    }
    if (verb === 'start') {
      const box = containers.get(args[1]!);
      if (!box) return missing(args[1]!);
      const computer = box.networkMode.startsWith('container:') ? byIdOrName(box.networkMode.slice('container:'.length)) : box;
      if (!computer) return { code: 1, stdout: '', stderr: 'joining network namespace of container: No such container' };
      box.status = 'running';
      return ok();
    }
    if (verb === 'ps') {
      const wanted = args
        .filter((arg) => arg.startsWith('label='))
        .map((arg) => {
          const [key, ...value] = arg.slice('label='.length).split('=');
          return [key!, value.join('=')] as const;
        });
      return ok(`${[...containers.entries()].filter(([, box]) => wanted.every(([key, value]) => box.labels[key] === value)).map(([name]) => name).join('\n')}\n`);
    }
    if (verb === 'container' && sub === 'inspect') {
      const key = args.at(-1)!;
      if (options.silent?.includes(key)) return { code: 1, stdout: '', stderr: 'docker did not answer within 30 s; is the Docker daemon running?' };
      const box = byIdOrName(key);
      if (!box) return missing(key);
      if (args.includes('--format')) {
        const format = flag(args, '--format') ?? '';
        return ok(format.includes('Status') ? `${box.status}\n` : `${box.id}\n`);
      }
      return ok(
        JSON.stringify([{ Id: box.id, Name: `/${nameOf(box)}`, State: { Status: box.status }, Config: { Labels: box.labels }, HostConfig: { NetworkMode: box.networkMode }, Image: 'sha256:image' }]),
      );
    }
    if (verb === 'logs') return { code: 0, stdout: '', stderr: options.dies ?? '' };
    if (verb === 'exec' && args.includes('pg_isready')) {
      const name = args[1]!;
      const box = containers.get(name);
      if (!box || box.status !== 'running') return { code: 1, stdout: '', stderr: `container ${name} is not running` };
      const seen = (checks.get(name) ?? 0) + 1;
      checks.set(name, seen);
      return seen > (options.readyAfter ?? 0) ? ok() : { code: 2, stdout: '', stderr: '' };
    }
    if (verb === 'exec' && args.includes('tmux') && args.includes('list-sessions')) return ok('shell|0\n');
    return ok();
  };
  return { answer, containers, calls, secrets, checks };
}

function driverWith(answer: (args: string[], input?: string, secrets?: Record<string, string>) => Promise<DockerResult>): DockerDriver {
  return new DockerDriver({
    image: 'openadlc-bot:latest',
    runnerBundle: '/opt/openadlc/skill-runner.bundle.mjs',
    workRoot,
    skillsRoot: '/opt/openadlc/skills',
    rolesRoot: '/opt/openadlc/roles',
    hostdUrl: 'http://host.docker.internal:47312',
    loginRoot,
    docker: answer,
    wait: async () => undefined,
  });
}

function spec(partial: Partial<TaskComputerSpec> = {}): TaskComputerSpec {
  const taskId = partial.taskId ?? TASK;
  return {
    taskId,
    bot: 'atlas',
    repoKey: 'acme__app',
    slotDir: join(workRoot, 'slots', taskId),
    login: null,
    cpus: 2,
    memoryGb: 4,
    database: false,
    postgres: [APP],
    ...partial,
  };
}

const serverRun = (calls: string[][], name: string) => calls.find((args) => args[0] === 'run' && args.includes(name));
const value = (args: string[] | undefined, name: string) => (args ? args[args.indexOf(name) + 1] : undefined);
const values = (args: string[] | undefined, name: string) => (args ?? []).flatMap((arg, index) => (arg === name ? [args![index + 1]!] : []));

describe('a task’s own Postgres server, made with its computer', () => {
  it('runs in the computer’s network namespace, on loopback at its port, publishing nothing, with limits of its own', async () => {
    const { answer, calls } = daemon();
    const computer = await driverWith(answer).acquire(spec());

    expect(computer.postgres).toEqual(['127.0.0.1:55432']);
    const args = serverRun(calls, 'task-3f2a9c1e-pg55432');
    expect(value(args, '--network')).toBe('container:task-3f2a9c1e');
    expect(args).not.toContain('-p');
    expect(args).not.toContain('--publish');
    expect(args).not.toContain('--network-alias');
    expect(args?.slice(-5)).toEqual(['pgvector/pgvector:pg16', '-c', 'listen_addresses=127.0.0.1,::1', '-c', 'port=55432']);
    expect(value(args, '--cpus')).toBe('1');
    expect(value(args, '--memory')).toBe(String(1024 ** 3));
    expect(value(args, '--pids-limit')).toBe(String(TASK_POSTGRES_PIDS_LIMIT));
    expect(value(args, '--security-opt')).toBe('no-new-privileges:true');
    expect(values(args, '--label')).toEqual(
      expect.arrayContaining([
        'openadlc.install=default',
        'openadlc.kind=task-postgres',
        'openadlc.computer=task-3f2a9c1e',
        `openadlc.task=${TASK}`,
        'openadlc.port=55432',
      ]),
    );
    expect(values(args, '-e')).toEqual([
      'POSTGRES_USER=app',
      'POSTGRES_PASSWORD',
      'POSTGRES_DB=app_db',
      'PGPORT=55432',
      // Loopback asks for the password, as the repository's own CI does through a published port.
      'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256',
    ]);
  });

  it('keeps the password off every command line, in the docker client’s own environment', async () => {
    const { answer, calls, secrets } = daemon();
    await driverWith(answer).acquire(spec({ postgres: [{ ...APP, password: 'not-on-argv' }] }));

    expect(calls.some((args) => args.some((arg) => arg.includes('not-on-argv')))).toBe(false);
    expect(secrets).toContainEqual({ POSTGRES_PASSWORD: 'not-on-argv' });
  });

  it('answers only once each server takes connections on its loopback port, having made them all first', async () => {
    const { answer, calls, checks } = daemon({ readyAfter: 3 });
    const second = { ...APP, port: 55499, superuser: 'ci', database: 'ci_db' };
    const computer = await driverWith(answer).acquire(spec({ postgres: [APP, second] }));

    expect(computer.postgres).toEqual(['127.0.0.1:55432', '127.0.0.1:55499']);
    expect(checks.get('task-3f2a9c1e-pg55432')).toBe(4);
    expect(checks.get('task-3f2a9c1e-pg55499')).toBe(4);
    const order = calls.map((args) => (args[0] === 'run' ? `run ${value(args, '--name')}` : args.includes('pg_isready') ? `ready? ${args[1]}` : '')).filter(Boolean);
    expect(order.slice(0, 4)).toEqual(['run task-3f2a9c1e', 'run task-3f2a9c1e-pg55432', 'run task-3f2a9c1e-pg55499', 'ready? task-3f2a9c1e-pg55432']);
    expect(calls.find((args) => args.includes('pg_isready'))).toEqual([
      'exec', 'task-3f2a9c1e-pg55432', 'pg_isready', '-q', '-h', '127.0.0.1', '-p', '55432', '-U', 'app', '-d', 'app_db',
    ]);
  });

  it('makes a computer with no servers when the repository has none', async () => {
    const { answer, calls } = daemon();
    const computer = await driverWith(answer).acquire(spec({ postgres: [] }));

    expect(computer.postgres).toEqual([]);
    expect(calls.filter((args) => args[0] === 'run')).toHaveLength(1);
  });

  it('pulls an image the host does not have before it runs it', async () => {
    const { answer, calls } = daemon({ images: [] });
    await driverWith(answer).acquire(spec());

    const pull = calls.findIndex((args) => args[0] === 'pull');
    expect(calls[pull]).toEqual(['pull', 'pgvector/pgvector:pg16']);
    expect(pull).toBeLessThan(calls.findIndex((args) => args[0] === 'run' && args.includes('task-3f2a9c1e-pg55432')));
  });
});

describe('a task’s server that cannot be brought up', () => {
  it('fails the start with its last words, and takes the computer and the server down', async () => {
    const { answer, containers } = daemon({ dies: 'initdb: error: invalid locale settings' });
    const driver = driverWith(answer);

    await expect(driver.acquire(spec())).rejects.toThrow(
      `task ${TASK}'s Postgres server on port 55432 stopped before it took connections: initdb: error: invalid locale settings`,
    );
    expect([...containers.keys()]).toEqual([]);
    expect(driver.computerOf(TASK)).toBeNull();
  });

  it('gives up when it never takes connections, and says where its log is', async () => {
    const { answer, checks, containers } = daemon({ readyAfter: Infinity });

    await expect(driverWith(answer).acquire(spec())).rejects.toThrow(
      `task ${TASK}'s Postgres server did not take connections on 127.0.0.1:55432 within ${TASK_POSTGRES_READY_ATTEMPTS} seconds; docker logs task-3f2a9c1e-pg55432 says why`,
    );
    expect(checks.get('task-3f2a9c1e-pg55432')).toBe(TASK_POSTGRES_READY_ATTEMPTS);
    expect(containers.size).toBe(0);
  });

  it('says what to do when its image cannot be pulled', async () => {
    const { answer, containers } = daemon({ images: [], pull: 'refused' });

    await expect(driverWith(answer).acquire(spec())).rejects.toThrow(
      `could not pull pgvector/pgvector:pg16 for task ${TASK}'s Postgres server: toomanyrequests: You have reached your pull rate limit. ` +
        'Pull it on this host (docker pull pgvector/pgvector:pg16), or name an image it has in Settings → Repositories',
    );
    expect(containers.size).toBe(0);
  });
});

describe('a task’s server, after its computer', () => {
  it('goes with the computer when the task is released, before the computer, with its data', async () => {
    const { answer, calls, containers } = daemon();
    const driver = driverWith(answer);
    await driver.acquire(spec());
    const before = calls.length;

    await driver.release(TASK, 'done');

    expect([...containers.keys()]).toEqual([]);
    const removals = calls.slice(before).filter((args) => args[0] === 'rm');
    expect(removals).toEqual([
      ['rm', '-f', '-v', 'task-3f2a9c1e-pg55432'],
      ['rm', '-f', '-v', 'task-3f2a9c1e'],
    ]);
  });

  it('goes with a computer the reaper discards', async () => {
    const { answer, containers } = daemon();
    const driver = driverWith(answer);
    await driver.acquire(spec());

    await driver.discard('task-3f2a9c1e');

    expect([...containers.keys()]).toEqual([]);
  });

  it('is two servers for two tasks at once, each in its own computer’s namespace', async () => {
    const { answer, containers } = daemon();
    const driver = driverWith(answer);
    await driver.acquire(spec());
    await driver.acquire(spec({ taskId: OTHER }));

    const one = containers.get('task-3f2a9c1e-pg55432');
    const two = containers.get('task-9b1c4e2a-pg55432');
    expect(one?.networkMode).toBe(`container:${containers.get('task-3f2a9c1e')?.id}`);
    expect(two?.networkMode).toBe(`container:${containers.get('task-9b1c4e2a')?.id}`);
    expect(one?.networkMode).not.toBe(two?.networkMode);

    await driver.release(TASK, 'done');
    expect([...containers.keys()].sort()).toEqual(['task-9b1c4e2a', 'task-9b1c4e2a-pg55432']);
  });

  it('is taken back with an adopted computer after hostd restarts, and started again if it had stopped', async () => {
    const slot = join(workRoot, 'slots', TASK);
    writeSlotTask(slot, { taskId: TASK, bot: 'atlas' });
    const { answer, containers, calls } = daemon();
    // What the hostd before this one left running.
    await driverWith(answer).acquire(spec({ slotDir: slot }));
    containers.get('task-3f2a9c1e-pg55432')!.status = 'exited';

    const restarted = driverWith(answer);
    const [found] = await restarted.computers();
    const computer = await restarted.adopt(found!);

    expect(computer?.postgres).toEqual(['127.0.0.1:55432']);
    expect(calls).toContainEqual(['start', 'task-3f2a9c1e-pg55432']);
    expect(containers.get('task-3f2a9c1e-pg55432')?.status).toBe('running');
    // And the adopted computer's release takes it down too.
    await restarted.release(TASK, 'done');
    expect(containers.size).toBe(0);
  });

  it('is replaced, not joined, when a computer of the same task left one behind', async () => {
    const slot = join(workRoot, 'slots', TASK);
    const { answer, containers, calls } = daemon();
    await driverWith(answer).acquire(spec({ slotDir: slot }));
    const before = containers.get('task-3f2a9c1e-pg55432')?.id;

    // hostd lost track of it, and the task starts again under the same name.
    await driverWith(answer).acquire(spec({ slotDir: slot }));

    expect(containers.get('task-3f2a9c1e-pg55432')?.id).not.toBe(before);
    expect(containers.get('task-3f2a9c1e-pg55432')?.networkMode).toBe(`container:${containers.get('task-3f2a9c1e')?.id}`);
    expect(calls.filter((args) => args[0] === 'run' && args.includes('task-3f2a9c1e-pg55432'))).toHaveLength(2);
  });

  it('is swept as an orphan once its computer is gone, by the id its namespace names, and only then', async () => {
    const { answer, containers } = daemon();
    const driver = driverWith(answer);
    await driver.acquire(spec());
    await driver.acquire(spec({ taskId: OTHER }));
    // Its computer removed by hand, or released by a hostd that did not know of servers.
    containers.delete('task-9b1c4e2a');

    expect(await driver.sweepOrphans()).toEqual(['task-9b1c4e2a-pg55432']);
    expect([...containers.keys()].sort()).toEqual(['task-3f2a9c1e', 'task-3f2a9c1e-pg55432']);
    expect(await driver.sweepOrphans()).toEqual([]);
  });

  it('is not swept when Docker does not answer for its computer', async () => {
    const first = daemon();
    const driver = driverWith(first.answer);
    await driver.acquire(spec());
    const computerId = first.containers.get('task-3f2a9c1e')!.id;
    const silent = daemon({ silent: [computerId] });
    for (const [name, box] of first.containers) silent.containers.set(name, box);

    expect(await driverWith(silent.answer).sweepOrphans()).toEqual([]);
    expect(silent.containers.has('task-3f2a9c1e-pg55432')).toBe(true);
  });
});
