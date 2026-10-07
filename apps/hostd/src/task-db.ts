import { createHmac, randomBytes } from 'node:crypto';
import type { DockerResult } from './drivers/docker.js';

/**
 * A database for each task, on one Postgres server per host.
 *
 * Each bot had a Postgres container of its own, on a network of its own, and
 * a task emptied it as it started. A computer per task would have meant a
 * Postgres per task — a second container to start, and to wait for, on every
 * task — so the host runs one server instead (`fleetadlc-taskdb`) and each
 * task gets a role and a database of its own on it: `t_<id>`, owned by that
 * role, made from a template that already has the extensions a repository's
 * migrations ask for, closed to every other role, and dropped with the
 * task's computer. A role may hold 20 connections, so one task's pool cannot
 * take the server from the others.
 *
 * The server is published on the host's gateway address only — never on an
 * address the network can reach — and a task's container reaches it as
 * `host.docker.internal`, the way it reaches hostd. Its superuser has no
 * password: every task can reach the server, and the image lets any role in
 * over TCP with a password, so a superuser password is one a task could use to
 * read or drop every other task's database. It was derived from a public
 * default, the same on every install. hostd runs its own SQL through
 * `docker exec psql`, over the server's local socket, which needs none. A task's
 * role has a password derived from the install's internal secret and its task
 * id, handed to the task in its `DATABASE_URL` and stored nowhere. A hostd
 * that restarts and adopts the task's computer computes it again: a random one
 * was lost with the process, and the adopted task's local CI ran with no
 * database.
 */

/** The template every task's database is made from. */
export const TASK_TEMPLATE = 'fleetadlc_task_template';
/** What the template holds: what pgvector's image offers and repositories most often ask for. */
export const TEMPLATE_EXTENSIONS = ['vector', 'pgcrypto', 'citext', 'uuid-ossp'] as const;
export const TASKDB_PORT = 47433;
const SUPERUSER = 'fleetadlc';

export interface TaskDatabasesOptions {
  docker: (args: string[], input?: string, secrets?: Record<string, string>) => Promise<DockerResult>;
  /** `fleetadlc-taskdb` for the default install; another install's has its own name. */
  container: string;
  image: string;
  installLabel: string;
  /**
   * Where the server is published on the host: the Docker bridge's gateway on
   * Linux (172.17.0.1, what `host-gateway` is), loopback on Docker Desktop and
   * OrbStack, whose `host.docker.internal` is the host's loopback. Never
   * 0.0.0.0: the cloud host's firewall is not what should keep a database off
   * the network.
   */
  bindAddress: string;
  port?: number;
  /** The password the image needs to make a new server, removed as soon as it is up; random unless a test says otherwise. */
  bootPassword?: () => string;
  /** How a task's container names the host. */
  hostFromTask?: string;
  /**
   * The key a task role's password is derived from: the install's internal
   * secret, which no task holds. Without one, or before the bridge has made
   * it, a role gets a random password and its URL cannot be rebuilt.
   */
  key?: () => Promise<string | null>;
  /** A task role's password; derived from `key` unless a test says otherwise. */
  password?: () => string;
}

/**
 * The role and database a task gets: `t_` and the letters and digits of its
 * whole id, 34 bytes for a UUID, inside Postgres's 63. It was the first eight
 * only, and `create` drops what it finds under its name first: two tasks on a
 * host whose ids began alike would have had one's live database dropped by the
 * other's start.
 */
export function taskDatabaseName(taskId: string): string {
  const id = taskId.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (id.length < 8) throw new Error(`${JSON.stringify(taskId)} is not a task id a database can be named after`);
  return `t_${id.slice(0, 61)}`;
}

/** The name a task's database had before it was named after the whole id, so `drop` removes those too. */
function shortTaskDatabaseName(taskId: string): string {
  return `t_${taskDatabaseName(taskId).slice(2, 10)}`;
}

/**
 * Where the task database server is published, when nothing says: loopback
 * on Docker Desktop and OrbStack, whose `host.docker.internal` reaches the
 * host's loopback; on Linux the default bridge's gateway, which is what
 * `host-gateway` resolves to in a container. Asked of the daemon rather than
 * read from the platform hostd runs on: hostd in the compose stack is a Linux
 * process talking to Docker Desktop.
 */
export async function taskdbBindAddress(
  docker: (args: string[]) => Promise<DockerResult>,
  configured: string | null,
): Promise<string> {
  if (configured) {
    // Every address the host has, the network's included: the cloud host's
    // firewall is not what should keep a database off the network.
    if (['0.0.0.0', '::', '[::]'].includes(configured.trim())) {
      throw new Error(`FLEETADLC_TASKDB_BIND is ${configured}, which publishes the task database server on every address the host has. Unset it, or give the host's gateway or loopback address (172.17.0.1 or 127.0.0.1)`);
    }
    return configured;
  }
  const info = await docker(['info', '--format', '{{.OperatingSystem}}']);
  if (/docker desktop|orbstack/i.test(info.stdout)) return '127.0.0.1';
  const gateway = await docker(['network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}']);
  const address = gateway.stdout.trim();
  return gateway.code === 0 && /^\d+\.\d+\.\d+\.\d+$/.test(address) ? address : '172.17.0.1';
}

export class TaskDatabases {
  private ready: Promise<void> | null = null;

  constructor(private readonly options: TaskDatabasesOptions) {}

  private get port(): number {
    return this.options.port ?? TASKDB_PORT;
  }

  /**
   * One statement, as the superuser, in the server's own container. Each its
   * own `psql -c`: `create database` refuses a transaction. No password: psql
   * there connects over the server's socket, which the image trusts.
   *
   * A statement that holds a secret is sent on psql's stdin instead
   * (`onStdin`), so it is not on a `docker exec` command line in the host's
   * process list.
   */
  private async psql(sql: string, database = 'postgres', onStdin = false): Promise<DockerResult> {
    const args = ['exec', ...(onStdin ? ['-i'] : []), this.options.container, 'psql', '-U', SUPERUSER, '-d', database, '-v', 'ON_ERROR_STOP=1'];
    return onStdin ? this.options.docker([...args, '-tA', '-f', '-'], sql) : this.options.docker([...args, '-tAc', sql]);
  }

  private async must(sql: string, database = 'postgres', onStdin = false): Promise<string> {
    const result = await this.psql(sql, database, onStdin);
    if (result.code !== 0) throw new Error(`the task database server refused \`${sql.split(' ').slice(0, 4).join(' ')} …\`: ${result.stderr.trim().slice(0, 200)}`);
    return result.stdout.trim();
  }

  /**
   * The server running, and its template made. Once per process; a failure
   * is tried again by the next task that needs a database.
   */
  ensure(): Promise<void> {
    this.ready ??= this.bringUp().catch((error: unknown) => {
      this.ready = null;
      throw error;
    });
    return this.ready;
  }

  private async bringUp(): Promise<void> {
    const state = await this.options.docker(['inspect', '-f', '{{.State.Status}}', this.options.container]);
    if (state.code !== 0) {
      const run = await this.options.docker([
        'run',
        '-d',
        '--name',
        this.options.container,
        '--restart',
        'unless-stopped',
        '--label',
        this.options.installLabel,
        '--label',
        'fleetadlc.kind=taskdb',
        '-p',
        `${this.options.bindAddress}:${this.port}:5432`,
        '-e',
        `POSTGRES_USER=${SUPERUSER}`,
        // The image will not make a server without one. Random, kept
        // nowhere, and removed below once the server is up. Named here,
        // valued in the docker client's own environment: not in the host's
        // process list.
        '-e',
        'POSTGRES_PASSWORD',
        '-e',
        'POSTGRES_DB=postgres',
        this.options.image,
      ], undefined, { POSTGRES_PASSWORD: (this.options.bootPassword ?? (() => randomBytes(24).toString('hex')))() });
      if (run.code !== 0) throw new Error(`could not start ${this.options.container}: ${run.stderr.trim().slice(0, 200)}`);
    } else if (state.stdout.trim() !== 'running') {
      await this.options.docker(['start', this.options.container]);
    }

    // It takes a moment to take connections after it starts.
    for (let attempt = 0; ; attempt += 1) {
      const ready = await this.options.docker(['exec', this.options.container, 'pg_isready', '-U', SUPERUSER, '-q']);
      if (ready.code === 0) break;
      if (attempt >= 30) throw new Error(`${this.options.container} did not take connections within a minute`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    // A superuser that still has a password is a server just made, or one
    // made when that password was derived from a public default: anybody
    // could have logged in and changed the template every task's database is
    // copied from, so it is made again before the password goes.
    const hasPassword = await this.must(`select rolpassword is not null from pg_authid where rolname = '${SUPERUSER}'`);
    if (hasPassword === 't') {
      await this.must(`update pg_database set datistemplate = false where datname = '${TASK_TEMPLATE}'`);
      await this.must(`drop database if exists ${TASK_TEMPLATE} with (force)`);
    }
    const exists = await this.must(`select 1 from pg_database where datname = '${TASK_TEMPLATE}'`);
    if (exists !== '1') {
      await this.must(`create database ${TASK_TEMPLATE}`);
      for (const extension of TEMPLATE_EXTENSIONS) await this.must(`create extension if not exists "${extension}"`, TASK_TEMPLATE);
      await this.must(`update pg_database set datistemplate = true where datname = '${TASK_TEMPLATE}'`);
    }
    // Nobody but the superuser reaches the server's own databases: PUBLIC
    // may connect to every database by default, a task's role included.
    await this.must('revoke connect on database postgres from public');
    await this.must(`revoke connect on database ${TASK_TEMPLATE} from public`);
    // No password, no login over the network: the image's `host all all all
    // scram-sha-256` rule then admits nobody as the superuser, whatever the
    // server was made with. Every start, so an older server is repaired too.
    await this.must(`alter role ${SUPERUSER} password null`);
  }

  /**
   * A task's own role and database, made fresh: one left by a computer that
   * was not released properly is dropped first. Returns the URL the task's
   * container reaches it by.
   */
  async create(taskId: string): Promise<string> {
    await this.ensure();
    const name = taskDatabaseName(taskId);
    const password = (await this.passwordFor(taskId)) ?? randomBytes(18).toString('hex');
    await this.must(`drop database if exists ${name} with (force)`);
    await this.must(`drop role if exists ${name}`);
    await this.must(`create role ${name} login password '${password}' connection limit 20`, 'postgres', true);
    await this.must(`create database ${name} owner ${name} template ${TASK_TEMPLATE}`);
    await this.must(`revoke connect on database ${name} from public`);
    await this.must(`grant connect on database ${name} to ${name}`);
    return this.url(name, password);
  }

  /**
   * The URL `create` returned for a task, for a hostd that adopts its computer
   * after a restart; null when that task has no database on the server (it
   * was started without one) or no key to compute the password from. The
   * role's password is not reset here: the running session's own connections
   * use the URL it was started with.
   */
  async urlFor(taskId: string): Promise<string | null> {
    const password = await this.passwordFor(taskId);
    if (!password) return null;
    const name = taskDatabaseName(taskId);
    const found = await this.psql(`select 1 from pg_database where datname = '${name}'`);
    return found.code === 0 && found.stdout.trim() === '1' ? this.url(name, password) : null;
  }

  /**
   * Under its own prefix, so a task's session token (`task:<id>`, the same
   * key) and its database password are never the same value.
   */
  private async passwordFor(taskId: string): Promise<string | null> {
    if (this.options.password) return this.options.password();
    const key = await this.options.key?.().catch(() => null);
    return key ? createHmac('sha256', key).update(`taskdb:${taskId}`).digest('hex').slice(0, 40) : null;
  }

  private url(name: string, password: string): string {
    return `postgres://${name}:${password}@${this.options.hostFromTask ?? 'host.docker.internal'}:${this.port}/${name}`;
  }

  /**
   * The task's database and role gone, under the name it has now and the
   * eight-letter one it had before. Nothing there is not a failure.
   */
  async drop(taskId: string): Promise<void> {
    const state = await this.options.docker(['inspect', '-f', '{{.State.Status}}', this.options.container]);
    if (state.code !== 0) return;
    for (const name of [taskDatabaseName(taskId), shortTaskDatabaseName(taskId)]) {
      await this.must(`drop database if exists ${name} with (force)`);
      await this.must(`drop role if exists ${name}`);
    }
  }
}
