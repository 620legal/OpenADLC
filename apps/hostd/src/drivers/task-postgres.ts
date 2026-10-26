import { taskPostgresAddresses, type TaskPostgresServer } from '@openadlc/shared';
import type { DockerCallOptions, DockerRunner } from './docker.js';

/**
 * A task's own Postgres servers, under the docker driver.
 *
 * Each is a container in its computer's network namespace (`--network
 * container:<computer>`), listening on loopback only, at the port its
 * repository's setting names: the task reaches it at `127.0.0.1:<port>`, as
 * the repository's own Makefile defaults expect, and nothing else can — it
 * publishes no port, joins no network, and another task's loopback is its
 * own. The shared task server could not do this: a task's role there can
 * create no server-wide role, and two tasks' fixed role names would collide
 * (a repository's `app_rw`, `app_api_rw` and the rest).
 *
 * A container that shares another's namespace is not removed with it. Docker
 * keeps it running in a namespace with only a loopback left, and it cannot be
 * started again once the computer is gone ("joining network namespace of
 * container: No such container"). So each is removed with its computer, and
 * one whose computer went another way is swept (`sweep`), found by the
 * computer id its namespace names rather than by the computer's name: a task
 * started again gets a computer of the same name.
 */

/** What a task's server is to hostd (`openadlc.kind`), beside a `computer`. */
export const TASK_POSTGRES_KIND = 'task-postgres';
/** The computer a server is in, by name, for a person reading `docker ps` and for `of`. */
export const COMPUTER_LABEL = 'openadlc.computer';
/** The task it was made for. */
export const TASK_LABEL = 'openadlc.task';
/** Where it listens, in its computer. */
export const PORT_LABEL = 'openadlc.port';

/**
 * Its own limits, beside its computer's seat size: a server is a container
 * with a cgroup of its own, and one test suite's runaway query must not take
 * the host's memory. Enough for a repository's migrations and test suite.
 */
export const TASK_POSTGRES_CPUS = 1;
export const TASK_POSTGRES_MEMORY_GB = 1;
/** A backend per connection, and a pool or two of them; a fork bomb stops here. */
export const TASK_POSTGRES_PIDS_LIMIT = 512;

/** How long a new server has to take connections: initdb and its first start take a few seconds. */
export const TASK_POSTGRES_READY_ATTEMPTS = 60;
const READY_WAIT_MS = 1000;
const QUICK: DockerCallOptions = { timeoutMs: 30_000 };

/** `<computer>-pg<port>`: a person sees in `docker ps` whose it is, and a task has one server per port. */
export function taskPostgresName(computer: string, port: number): string {
  return `${computer}-pg${port}`;
}

/**
 * The `docker run` for one server. The password is named and valued in the
 * docker client's environment (`secrets`), so it is not in the host's process
 * list. `PGPORT` as well as `-c port`: the image's first-run server, which
 * makes the database, listens on the socket named after it.
 */
export function taskPostgresRunArgs(input: {
  name: string;
  computer: string;
  taskId: string;
  server: TaskPostgresServer;
  labels: string[];
}): string[] {
  const memory = Math.round(TASK_POSTGRES_MEMORY_GB * 1024 ** 3);
  return [
    'run',
    '-d',
    '--name',
    input.name,
    // Its computer's own loopback: no address of its own, no published port.
    '--network',
    `container:${input.computer}`,
    '--cpus',
    String(TASK_POSTGRES_CPUS),
    '--memory',
    String(memory),
    '--memory-swap',
    String(memory),
    '--pids-limit',
    String(TASK_POSTGRES_PIDS_LIMIT),
    '--security-opt',
    'no-new-privileges:true',
    ...input.labels.flatMap((label) => ['--label', label]),
    '--label',
    `${COMPUTER_LABEL}=${input.computer}`,
    '--label',
    `${TASK_LABEL}=${input.taskId}`,
    '--label',
    `${PORT_LABEL}=${input.server.port}`,
    '-e',
    `POSTGRES_USER=${input.server.superuser}`,
    '-e',
    'POSTGRES_PASSWORD',
    '-e',
    `POSTGRES_DB=${input.server.database}`,
    '-e',
    `PGPORT=${input.server.port}`,
    // The password asked for over loopback too. initdb trusts 127.0.0.1 by
    // default, so any password let a task in, and a wrong one in a
    // repository's URLs passed here and failed in its own CI, where the
    // server is reached through a published port. The image's socket stays
    // trusted for its own setup, and is in the server's container alone.
    '-e',
    'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256',
    input.server.image,
    // Loopback only, IPv4 and IPv6: the computer is on the install's task
    // network, and listening on its address there would be one more door.
    // An IPv6 loopback a host has turned off is a warning, not a failure.
    '-c',
    'listen_addresses=127.0.0.1,::1',
    '-c',
    `port=${input.server.port}`,
  ];
}

export interface TaskPostgresOptions {
  docker: DockerRunner;
  /** This install's labels for what it makes: `openadlc.install=<id>` and `openadlc.kind=task-postgres`. */
  labels: string[];
  /** The filters `docker ps` lists this install's servers with. */
  filters: string[];
  /** How long between readiness checks; a test passes none. */
  wait?: (ms: number) => Promise<void>;
}

/** One server found on the daemon. */
interface FoundServer {
  name: string;
  running: boolean;
  port: number | null;
  /** The container whose network namespace it is in, by id: `container:<id>`. */
  computerId: string | null;
}

export class TaskPostgres {
  constructor(private readonly options: TaskPostgresOptions) {}

  private get docker(): DockerRunner {
    return this.options.docker;
  }

  /**
   * The task's servers, made fresh in its computer, and each taking
   * connections before this answers: hostd runs `make setup` next, and a
   * migration against a server still in initdb fails. Every server is made
   * before any is waited for, so their first starts overlap. One that cannot
   * be pulled, made or brought up throws with what to do, and what was made
   * is the caller's to remove (`removeFor`).
   */
  async start(input: {
    computer: string;
    taskId: string;
    servers: readonly TaskPostgresServer[];
    /** Whose servers they are, as an error starts: `task 3f2a9c1e's`. */
    why: string;
  }): Promise<string[]> {
    for (const server of input.servers) {
      const name = taskPostgresName(input.computer, server.port);
      // One left by a computer of this task that was never released.
      await this.docker(['rm', '-f', '-v', name], undefined, undefined, QUICK);
      await this.ensureImage(server.image, input.why);
      const made = await this.docker(
        taskPostgresRunArgs({ name, computer: input.computer, taskId: input.taskId, server, labels: this.options.labels }),
        undefined,
        { POSTGRES_PASSWORD: server.password },
      );
      if (made.code !== 0) {
        throw new Error(`could not start ${input.why} Postgres server on port ${server.port}: ${made.stderr.trim().slice(0, 300)}`);
      }
    }
    for (const server of input.servers) await this.ready(taskPostgresName(input.computer, server.port), server, input.why);
    return taskPostgresAddresses(input.servers);
  }

  /**
   * The image on this host, pulled when it is not. `docker run` would pull it
   * too, but its failure would read as the server's; and on the cloud host
   * this is the daemon's own pull, from Docker Hub, as openadlc-taskdb's
   * image is (infra/gcp/cloud-init/host.yaml).
   */
  private async ensureImage(image: string, why: string): Promise<void> {
    if ((await this.docker(['image', 'inspect', '--format', '{{.Id}}', image], undefined, undefined, QUICK)).code === 0) return;
    const pulled = await this.docker(['pull', image]);
    if (pulled.code !== 0) {
      throw new Error(
        `could not pull ${image} for ${why} Postgres server: ${pulled.stderr.trim().slice(0, 200)}. ` +
          `Pull it on this host (docker pull ${image}), or name an image it has in Settings → Repositories`,
      );
    }
  }

  /** Until it takes connections on its loopback port, as the task will reach it; or why it never will. */
  private async ready(name: string, server: TaskPostgresServer, why: string): Promise<void> {
    const wait = this.options.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    const check = ['exec', name, 'pg_isready', '-q', '-h', '127.0.0.1', '-p', String(server.port), '-U', server.superuser, '-d', server.database];
    for (let attempt = 1; ; attempt += 1) {
      if ((await this.docker(check, undefined, undefined, QUICK)).code === 0) return;
      const state = await this.docker(['container', 'inspect', '--format', '{{.State.Status}}', name], undefined, undefined, QUICK);
      if (state.code !== 0 || state.stdout.trim() !== 'running') {
        // Its own last words: a bad setting (a database name the image
        // refused) says so there, and nowhere else.
        const logs = await this.docker(['logs', '--tail', '5', name], undefined, undefined, QUICK);
        const said = `${logs.stdout}\n${logs.stderr}`.trim().split('\n').slice(-3).join(' / ').slice(0, 300);
        throw new Error(`${why} Postgres server on port ${server.port} stopped before it took connections${said ? `: ${said}` : ''}`);
      }
      if (attempt >= TASK_POSTGRES_READY_ATTEMPTS) {
        throw new Error(
          `${why} Postgres server did not take connections on 127.0.0.1:${server.port} within ${TASK_POSTGRES_READY_ATTEMPTS} seconds; docker logs ${name} says why`,
        );
      }
      await wait(READY_WAIT_MS);
    }
  }

  /** This install's servers on the daemon, every one or a computer's, as `docker ps -a` lists them. */
  private async list(computer?: string): Promise<string[]> {
    const filters = [...this.options.filters, ...(computer ? [`label=${COMPUTER_LABEL}=${computer}`] : [])].flatMap((filter) => ['--filter', filter]);
    const listed = await this.docker(['ps', '-a', ...filters, '--format', '{{.Names}}'], undefined, undefined, QUICK);
    if (listed.code !== 0) throw new Error(`docker would not list task Postgres servers: ${listed.stderr.trim().slice(0, 200)}`);
    return listed.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  private async inspect(name: string): Promise<FoundServer | null> {
    const found = await this.docker(['container', 'inspect', name], undefined, undefined, QUICK);
    if (found.code !== 0) return null;
    try {
      const [entry] = JSON.parse(found.stdout) as Array<{
        State?: { Status?: string };
        Config?: { Labels?: Record<string, string> | null };
        HostConfig?: { NetworkMode?: string };
      }>;
      const port = Number(entry?.Config?.Labels?.[PORT_LABEL]);
      const mode = entry?.HostConfig?.NetworkMode ?? '';
      return {
        name,
        running: entry?.State?.Status === 'running',
        port: Number.isInteger(port) && port > 0 ? port : null,
        computerId: mode.startsWith('container:') ? mode.slice('container:'.length) : null,
      };
    } catch {
      return null;
    }
  }

  /** A computer's servers removed, with their data: it is the task's, and goes with it. Nothing there is not a failure. */
  async removeFor(computer: string): Promise<void> {
    for (const name of await this.list(computer).catch(() => [])) await this.docker(['rm', '-f', '-v', name], undefined, undefined, QUICK);
  }

  /**
   * A computer's servers, for a hostd that takes the computer back after a
   * restart: they were running beside it all along. One that stopped is
   * started again, which works while its computer is up; the addresses are
   * those of the ones that run.
   */
  async adopt(computer: string, computerId: string | null): Promise<string[]> {
    const servers: { port: number }[] = [];
    for (const name of await this.list(computer).catch(() => [])) {
      const found = await this.inspect(name);
      if (!found?.port) continue;
      // Another computer of the same name's, not yet swept.
      if (computerId && found.computerId && !computerId.startsWith(found.computerId) && !found.computerId.startsWith(computerId)) continue;
      if (!found.running && (await this.docker(['start', name], undefined, undefined, QUICK)).code !== 0) continue;
      servers.push({ port: found.port });
    }
    return taskPostgresAddresses(servers.sort((a, b) => a.port - b.port));
  }

  /**
   * Removes every server whose computer is gone — released while hostd was
   * down, or removed by hand — and answers their names. Asked of the computer
   * by the id in the server's namespace, never its name.
   */
  async sweep(): Promise<string[]> {
    const removed: string[] = [];
    for (const name of await this.list()) {
      const found = await this.inspect(name);
      if (!found) continue;
      if (found.computerId) {
        const computer = await this.docker(['container', 'inspect', '--format', '{{.Id}}', found.computerId], undefined, undefined, QUICK);
        // Only Docker saying there is no such container: a daemon that did
        // not answer says nothing about the computer, which may be running a
        // task's checks against this server right now.
        if (computer.code === 0 || !/no such (container|object)/i.test(computer.stderr)) continue;
      }
      await this.docker(['rm', '-f', '-v', name], undefined, undefined, QUICK);
      removed.push(name);
    }
    return removed;
  }
}
