import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describeDatabase } from '@openadlc/db';
import { ensureConsoleSecret, ensureInternalSecret, openadlcHome } from '@openadlc/github';
import { applyingRefusal, recordCheckoutInstall, stepNamed } from '@openadlc/shared';
import { githubClientId } from '../client-id.js';
import { signInLink } from '../console-link.js';
import type { DriverProbe, InstallConfig } from '../install.js';
import {
  LOCAL_DRIVER_NOTES,
  LOCAL_DRIVER_WARNING,
  botImage,
  chooseDriver,
  configPath,
  databaseCredentials,
  dockerProbe,
  ensureDatabasePassword,
  hasPublishedDatabasePassword,
  makeHomePrivate,
  saveConfig,
  serviceEnv,
  storedDriver,
} from '../install.js';
import {
  isRunning,
  keeperPid,
  logFile,
  readPid,
  startService,
  stopService,
  waitForHealth,
  type ServiceSpec,
} from '../processes.js';
import { ui } from '../ui.js';

const run = promisify(execFile);

const SERVICES = ['hostd', 'bridge', 'console'] as const;

/**
 * Services an older install ran that this one does not start. The dispatcher
 * now runs inside the bridge, as soon as anything changes that could let work
 * start, so its own process — a look every five minutes — is gone. `openadlc down`
 * still stops one an older `openadlc up` left running, which would otherwise go on
 * dispatching beside the bridge.
 */
const RETIRED = ['dispatcher'] as const;

async function answers(url: string): Promise<boolean> {
  return fetch(url, { signal: AbortSignal.timeout(2000) })
    .then((response) => response.ok)
    .catch(() => false);
}

/**
 * What `up` says to do without a client id: what `openadlc doctor`, `auth
 * login` and the bridge say. Not `openadlc init`, which this used to name: it
 * sets only the driver and the database url.
 */
export const NO_CLIENT_ID_NOTE = `create the app on ${stepNamed('app')} of the console walkthrough, or set OPENADLC_GITHUB_CLIENT_ID, then connect the crew`;

/**
 * Whether this install actually has a client id, wherever it is kept, looked
 * for as the rest of the CLI and the bridge look (`githubClientId`).
 *
 * `install.json` is one of three places it can live, and no longer the usual one:
 * the console writes it to the settings table, which the bridge prefers. An
 * install set up from the browser therefore has a working app and an empty
 * `install.json`, and this printed "no GitHub App client id yet" over a crew of
 * nine connected accounts — on every `openadlc up`.
 *
 * A database that cannot be read answers the same as one with nothing in it,
 * because the only thing this decides is whether to print a hint.
 */
export async function clientIdConfigured(
  config: Pick<InstallConfig, 'githubClientId'>,
  stored?: () => Promise<string | null>,
): Promise<boolean> {
  return (await githubClientId(config, stored)) !== null;
}

/**
 * Whether the bot image is on this machine.
 *
 * Only asked under the docker driver: the local driver runs bots as processes
 * beside hostd and needs no image at all.
 */
async function botImagePresent(): Promise<boolean> {
  return dockerProbe.botImagePresent();
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await run('sh', ['-c', `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * What to do when Docker is installed and its daemon does not answer: Docker
 * Desktop not opened since a reboot, most often. `up` used to say the bot image
 * was missing, or to install Docker, to someone who had both.
 */
export const DOCKER_NOT_RUNNING = 'Docker is installed but not running';
export const START_DOCKER = 'start Docker Desktop, or on Linux: sudo systemctl start docker; then run openadlc up again';

/**
 * What to say when `docker run` could not start the database container: the
 * first line of what Docker said, which `up` used to throw away before waiting
 * twenty seconds on a port nothing would open, and the port by name when
 * something else holds it.
 */
export function dockerRunFailure(stderr: string, port: number): { reason: string; note: string | null } {
  const reason = stderr.split('\n').map((line) => line.trim()).find(Boolean) ?? 'docker run failed and said nothing';
  const taken = /port is already allocated|address already in use/i.test(stderr);
  return {
    reason,
    note: taken ? `port ${port} is taken by something else: stop it, or set ports.postgres and the port in databaseUrl in ${configPath()} to a free one` : null,
  };
}

function stderrOf(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  if (typeof stderr === 'string' && stderr.trim()) return stderr;
  return error instanceof Error ? error.message : String(error);
}

async function dockerDaemonAnswers(): Promise<boolean> {
  try {
    await run('docker', ['version', '--format', '{{.Server.Version}}']);
    return true;
  } catch {
    return false;
  }
}

/**
 * The container `openadlc up` keeps the database in: `openadlc-db` for the
 * default install, and one named after any other (`OPENADLC_INSTALL_ID`,
 * which a scratch install and the compose stack set). A scratch install whose
 * own database was slow to answer used to start, or reuse, `openadlc-db` —
 * the real install's name — on the scratch port, and the real install's next
 * `up` found that container and waited on a port it does not publish.
 */
export function databaseContainer(env: NodeJS.ProcessEnv = process.env): string {
  const install = env.OPENADLC_INSTALL_ID;
  if (!install || install === 'default') return 'openadlc-db';
  return `${env.OPENADLC_BOT_PREFIX || `${install}-`}db`;
}

/** One of a container's port bindings, as `docker inspect` gives it. */
export interface PortBinding {
  HostIp?: string;
  HostPort?: string;
}

/** Where a container publishes Postgres: undefined when there is no such container, [] when it publishes nothing. */
export async function postgresBindings(name: string, docker: DockerRun = runDocker): Promise<PortBinding[] | undefined> {
  try {
    const { stdout } = await docker(['inspect', '--format', '{{json .HostConfig.PortBindings}}', name]);
    const bindings = JSON.parse(stdout.trim() || 'null') as Record<string, PortBinding[] | null> | null;
    return bindings?.['5432/tcp'] ?? [];
  } catch {
    return undefined;
  }
}

/** The host port a container publishes Postgres on: undefined when there is no such container, '' when it publishes none. */
export async function publishedPostgresPort(
  name: string,
  bindingsOf: (name: string) => Promise<PortBinding[] | undefined> = postgresBindings,
): Promise<string | undefined> {
  const bindings = await bindingsOf(name);
  if (bindings === undefined) return undefined;
  return bindings[0]?.HostPort ?? '';
}

/** Runs `docker` with these arguments, and what it printed: `execFile` outside the tests. */
export type DockerRun = (args: string[], options?: { env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>;

const runDocker: DockerRun = (args, options) => run('docker', args, { ...options, timeout: 15_000 });

/** A database container as Docker holds it now. */
export interface DatabaseContainerState {
  /** `running`, `exited`, `created`, `paused`, `restarting` or `dead`. */
  status: string;
  /** Its restart policy: `unless-stopped`, `always`, `on-failure`, or `no` or '' for none. */
  restart: string;
  /** The host port it was created to publish Postgres on; '' for none. */
  configured: string;
  /** The host ports Docker holds for it now. */
  serving: string[];
}

/**
 * A database container's state, its restart policy, and where it is
 * configured to publish Postgres and publishes it now: undefined when there
 * is no such container.
 *
 * The two ports are different things. `HostConfig.PortBindings` is what the
 * container was created with, and it stays whether or not the container ever
 * got the port; `NetworkSettings.Ports` is what Docker holds for it, nothing
 * while it is stopped or when its start found the port taken. A scratch
 * install's `scratch-db`, left by another run and configured for 57432, was
 * read by its configuration as the server on 57432 while
 * `openadlc-scratch-db` was the one answering there, and `up` changed that
 * one's password (#111).
 */
export async function databaseContainerState(name: string, docker: DockerRun = runDocker): Promise<DatabaseContainerState | undefined> {
  type Bindings = Record<string, PortBinding[] | null> | null;
  let state: { status?: string; restart?: string; configured: Bindings; serving: Bindings };
  try {
    const { stdout } = await docker([
      'inspect',
      '--type',
      'container',
      '--format',
      '{"status":{{json .State.Status}},"restart":{{json .HostConfig.RestartPolicy.Name}},"configured":{{json .HostConfig.PortBindings}},"serving":{{json .NetworkSettings.Ports}}}',
      name,
    ]);
    state = JSON.parse(stdout.trim()) as typeof state;
  } catch {
    return undefined;
  }
  const hostPorts = (bindings: Bindings) => (bindings?.['5432/tcp'] ?? []).map((binding) => binding.HostPort ?? '').filter(Boolean);
  return {
    status: state.status ?? '',
    restart: state.restart ?? '',
    configured: hostPorts(state.configured)[0] ?? '',
    serving: [...new Set(hostPorts(state.serving))],
  };
}

/** Where a container is configured to publish Postgres, and where it publishes it now (`databaseContainerState`). */
export async function databaseContainerPorts(
  name: string,
  docker: DockerRun = runDocker,
): Promise<{ configured: string; serving: string[] } | undefined> {
  const state = await databaseContainerState(name, docker);
  return state && { configured: state.configured, serving: state.serving };
}

/**
 * Gives the install's database container `--restart unless-stopped` when it
 * has no restart policy, saying so the one time it does, so it comes back by
 * itself when Docker or the machine restarts. Every container `up` made before
 * `databaseRunArgs` named a policy has none: after OrbStack restarted, hostd's
 * `openadlc-taskdb` came back and `openadlc-db` did not.
 *
 * Only the container that serves the install's port now, as Docker holds it,
 * once its database has answered: a stale one only configured for the port,
 * like the `scratch-db` of #111, given a policy, would race the real server
 * for the port at Docker's next start. A policy a person chose is kept.
 *
 * Returns whether `name` is that container, which is what the bridge is told
 * to name when the database stops answering.
 */
export async function keepRestarting(name: string, port: number, docker: DockerRun = runDocker): Promise<boolean> {
  const state = await databaseContainerState(name, docker);
  if (!state?.serving.includes(String(port))) return false;
  if (state.restart && state.restart !== 'no') return true;
  try {
    await docker(['update', '--restart', 'unless-stopped', name]);
    ui.ok(`${name} now comes back by itself when Docker or this machine restarts (--restart unless-stopped)`);
  } catch (error) {
    const said = stderrOf(error).split('\n').map((line) => line.trim()).find(Boolean) ?? 'docker update failed and said nothing';
    ui.warn(`${name} has no restart policy, so it stays down after Docker or this machine restarts: docker update said ${said}`);
    ui.note(`docker update --restart unless-stopped ${name}`);
  }
  return true;
}

/** The running containers that publish this host port, by name, as `docker ps` lists them. */
export async function containersPublishing(port: number, docker: DockerRun = runDocker): Promise<string[]> {
  try {
    const { stdout } = await docker(['ps', '--format', '{{.Names}}\t{{.Ports}}']);
    return stdout.split('\n').flatMap((line) => {
      const [name = '', ports = ''] = line.trim().split('\t');
      return name && ports.includes(`:${port}->`) ? [name] : [];
    });
  } catch {
    return [];
  }
}

/** Which server a connection is on: the install's container, another one, or not known, and why. */
export type SessionServer = { on: 'container' } | { on: 'elsewhere' } | { on: 'unknown'; reason: string };

/**
 * Whether the connection whose `application_name` is `marker` is on the
 * container `name`: asked of the server inside it, through `docker exec`, never
 * over the install's port, since what answers on the port is the question. A
 * container whose server holds that connection is the server it reached;
 * nothing else can have a session of that name.
 *
 * The password goes in the environment of `docker exec`, as a bare `-e`, so
 * it is not in the host's process list. Connected to `postgres`, which every
 * cluster has, because `pg_stat_activity` is the whole server's.
 */
export async function sessionServer(name: string, marker: string, databaseUrl: string, docker: DockerRun = runDocker): Promise<SessionServer> {
  const credentials = databaseCredentials(databaseUrl);
  if (!/^[a-z0-9-]+$/.test(marker) || !credentials) return { on: 'unknown', reason: 'the connection could not be named for it to look for' };
  try {
    const { stdout } = await docker(
      [
        'exec',
        '-e',
        'PGPASSWORD',
        name,
        'psql',
        '-X',
        '-A',
        '-t',
        '-U',
        credentials.user || 'postgres',
        '-d',
        'postgres',
        '-c',
        `select count(*) from pg_stat_activity where application_name = '${marker}'`,
      ],
      { env: { ...process.env, PGPASSWORD: credentials.password } },
    );
    return Number(stdout.trim()) > 0 ? { on: 'container' } : { on: 'elsewhere' };
  } catch (error) {
    const said = stderrOf(error).split('\n').map((line) => line.trim()).find(Boolean) ?? 'docker exec failed and said nothing';
    return { on: 'unknown', reason: credentials.password ? said.split(credentials.password).join('***') : said };
  }
}

/** Thrown by `rotateDatabasePassword` when the server it reached is not shown to be the install's container. */
export class DatabaseServerUnconfirmed extends Error {
  constructor(readonly found: Exclude<SessionServer, { on: 'container' }>) {
    super(found.on === 'unknown' ? found.reason : 'the server that answered is not the install’s container');
  }
}

/**
 * What `up` says, and stops on, when the server on the install's port is not
 * the install's own container: which one answers, when Docker can say, and
 * the two ways out, since only a person knows which of the two holds this
 * install's data.
 */
export function databaseServerMismatch(
  name: string,
  port: number,
  others: readonly string[],
  why: string,
): { fail: string; notes: string[] } {
  const answering = others.length > 0 ? others.join(' and ') : 'another server';
  return {
    fail: `${why}: ${answering} answers there, so up stopped and changed no password`,
    notes: [
      `if ${name} holds this install's database: stop ${others.length > 0 ? answering : `whatever else listens on 127.0.0.1:${port}`}, then run openadlc up again`,
      `if ${others.length > 0 ? answering : 'that server'} holds it instead: move ${name} aside, keeping its data (docker rename ${name} ${name}-old), then run openadlc up again`,
    ],
  };
}

/**
 * What the default install's database container was called under the names
 * before this one, newest first; docs/upgrading-from-fleet.md. Neither has a
 * restart policy, so after a reboot `up` found nothing answering and ran a
 * new, empty `openadlc-db` on its port, which then held the port against it.
 */
export const LEGACY_DATABASE_CONTAINERS = ['fleetadlc-db', 'fleet-db'] as const;

/**
 * The container to start for this install's database: `databaseContainer()`,
 * except for a default install upgraded from FleetADLC or Fleet, whose
 * `fleetadlc-db` or `fleet-db` publishes the install's port and has no
 * `openadlc-db` beside it. One on another port is someone else's, and an
 * install with an id of its own never had one.
 */
export async function existingDatabaseContainer(
  config: { ports: Pick<InstallConfig['ports'], 'postgres'> },
  env: NodeJS.ProcessEnv = process.env,
  published: (name: string) => Promise<string | undefined> = publishedPostgresPort,
): Promise<string> {
  const name = databaseContainer(env);
  if (name !== 'openadlc-db') return name;
  if ((await published(name)) !== undefined) return name;
  for (const legacy of LEGACY_DATABASE_CONTAINERS) {
    if ((await published(legacy)) === String(config.ports.postgres)) return legacy;
  }
  return name;
}

/**
 * Whether a database url is the address of the container `openadlc up` keeps:
 * this machine's loopback, on the install's postgres port. A url anywhere else
 * is a server somebody else runs, and `up` never changes its password.
 */
export function addressesInstallDatabase(databaseUrl: string, port: number): boolean {
  try {
    const url = new URL(databaseUrl);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && Number(url.port || 5432) === port;
  } catch {
    return false;
  }
}

/**
 * What `openadlc up` does about an install whose database url still has the
 * published password.
 *
 * - `generate`: nothing is listening and there is no container yet, so the one
 *   about to be created gets a password of the install's own.
 * - `rotate`: the install's own container publishes the port now, and what
 *   answers there takes the published password, so the password is changed in
 *   place and the data stays where it is. `rotateDatabasePassword` changes it
 *   only once the container's own server holds the connection it made.
 *   `POSTGRES_PASSWORD` is read only when the image initialises an empty data
 *   directory, so recreating the container would be the only other way, and
 *   a container made before `databaseRunArgs` named its volume keeps its data
 *   in an anonymous one `docker rm` would orphan.
 * - `keep`: anything else. A server that is not this install's container —
 *   `tests/scratch.sh`'s `openadlc-scratch-db`, which it starts itself with
 *   the published password and hands to the integration suites, or an external
 *   one — is never altered; `openadlc doctor` says what to do about it. Nor is
 *   one that answers while the install's container is only configured for the
 *   port: that is another container's server (#111).
 */
export function databasePasswordStep(input: {
  databaseUrl: string;
  port: number;
  /** The host port the install's container is configured to publish; undefined when there is no container. */
  published: string | undefined;
  /** Whether that container publishes the port now, as Docker holds it, not only as it was configured. */
  serving: boolean;
  /** What connecting with the url did: answered, found nothing listening, or anything else. */
  connection: 'answers' | 'nothing' | 'refused';
}): 'generate' | 'rotate' | 'keep' {
  if (!hasPublishedDatabasePassword(input.databaseUrl)) return 'keep';
  if (!addressesInstallDatabase(input.databaseUrl, input.port)) return 'keep';
  if (input.published === String(input.port)) return input.connection === 'answers' && input.serving ? 'rotate' : 'keep';
  if (input.published === undefined && input.connection === 'nothing') return 'generate';
  return 'keep';
}

/**
 * The `docker run` that creates the install's database container, and the
 * environment to run it with.
 *
 * User, password and database come from the url, so a password set with
 * `openadlc init --database-url` reaches the container too; these used to be
 * constants, and the first `up` with any other password could not connect.
 * The password is passed as a bare `-e POSTGRES_PASSWORD`, which docker reads
 * from its own environment, so it is not in the host's process list. The port
 * is published on loopback only: published on every address it bypasses a
 * host firewall, and the LAN could try the password.
 *
 * The data is in a named volume, `<name>-data`. In the image's anonymous one,
 * `docker rm -f` of the container, which `up` itself once advised, or a
 * `docker system prune --volumes` while it was stopped lost the leases, the
 * ledger and the audit trail, and the next `up` started an empty database.
 * A container made before this keeps its anonymous volume: it is only started.
 *
 * `--restart unless-stopped`, as hostd starts `openadlc-taskdb`: with no
 * policy, OrbStack restarting brought the task database back and left this
 * one down, and the bridge answered every request with ECONNREFUSED until
 * somebody ran `docker start`. One made before this is given the policy
 * (`keepRestarting`).
 */
export function databaseRunArgs(
  name: string,
  config: Pick<InstallConfig, 'databaseUrl' | 'ports'>,
): { args: string[]; env: Record<string, string> } {
  const credentials = databaseCredentials(config.databaseUrl);
  if (!credentials) throw new Error(`databaseUrl in ${configPath()} is not a postgres url`);
  return {
    args: [
      'run',
      '-d',
      '--name',
      name,
      '--restart',
      'unless-stopped',
      '-e',
      `POSTGRES_USER=${credentials.user || 'openadlc'}`,
      '-e',
      'POSTGRES_PASSWORD',
      '-e',
      `POSTGRES_DB=${credentials.database || 'openadlc_db'}`,
      '-p',
      `127.0.0.1:${config.ports.postgres}:5432`,
      '-v',
      `${name}-data:/var/lib/postgresql/data`,
      'pgvector/pgvector:pg16',
    ],
    env: { POSTGRES_PASSWORD: credentials.password },
  };
}

/** A query over one connection, which is all a rotation needs; pg's `Client` is one. */
interface DatabaseSession {
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
}

/**
 * Gives the install's database a password of its own, over a connection made
 * with the published one, and saves it in `install.json` straight after, so an
 * `up` interrupted between the two does not leave them disagreeing. A failed
 * save puts the old password back over the same connection for the same
 * reason. The returned config carries the new url; `DATABASE_URL` is moved to
 * it when it held the old one, because this process's own pool reads it.
 * No error says the new password.
 *
 * Nothing is altered until `serverOf` finds the connection, by a name given
 * to it here, on the install's container. Whatever answers on the port
 * answers this connection, and a container configured for the port is not
 * always what holds it: `up` changed the password of another install's
 * database that way (#111). Throws `DatabaseServerUnconfirmed` when it is not.
 */
export async function rotateDatabasePassword(
  config: InstallConfig,
  deps: {
    connect: (databaseUrl: string) => Promise<DatabaseSession>;
    /** Which server holds the connection named `marker`: `sessionServer` for the install's container. */
    serverOf: (marker: string) => Promise<SessionServer>;
    save: (config: InstallConfig) => unknown;
    env?: NodeJS.ProcessEnv;
  },
): Promise<InstallConfig> {
  const next = ensureDatabasePassword(config).config;
  const before = databaseCredentials(config.databaseUrl);
  const after = databaseCredentials(next.databaseUrl);
  // Written into the statement, which cannot take a parameter: only a plain
  // role name and a hex password ever are.
  if (!before || !after || !/^[0-9a-f]+$/.test(after.password) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(after.user)) {
    throw new Error('the database url does not name a plain role, so its password was not changed');
  }
  const alter = (password: string) => `alter role "${after.user}" password '${password}'`;

  try {
    const session = await deps.connect(config.databaseUrl);
    try {
      const marker = `openadlc-up-${randomBytes(8).toString('hex')}`;
      await session.query(`set application_name to '${marker}'`);
      const found = await deps.serverOf(marker);
      if (found.on !== 'container') throw new DatabaseServerUnconfirmed(found);
      await session.query(alter(after.password));
      try {
        deps.save(next);
      } catch (error) {
        await session.query(alter(before.password)).catch(() => undefined);
        throw error;
      }
    } finally {
      await session.end().catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof DatabaseServerUnconfirmed) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.split(after.password).join('***'));
  }

  adoptDatabaseUrl(config.databaseUrl, next.databaseUrl, deps.env);
  return next;
}

/**
 * Hands a new database url to this process. `main` copies `install.json` into
 * `DATABASE_URL` before `up` runs, and `up` reads a setting through the pool,
 * which connects with it; one exported by hand for another database is left.
 */
function adoptDatabaseUrl(previous: string, next: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!env.DATABASE_URL || env.DATABASE_URL === previous) env.DATABASE_URL = next;
}

/**
 * What `up` does once the install's database url answers, under Docker: goes
 * on with it, gives the install's container a password of its own when it
 * still takes the published one, or stops (null) when it does and what answers
 * is not the container named `name`.
 *
 * The container is the install's by its name, and checked by what Docker
 * holds for it now, never by the port it was configured with, which another
 * container can share: `up` once took a stale `scratch-db` configured for
 * 57432 for the server there, and changed the password of
 * `openadlc-scratch-db`, which was the one answering (#111). The same on a
 * machine with a real install would change the real database's password.
 */
export async function settleDatabase(
  current: InstallConfig,
  name: string,
  deps: {
    connect: (databaseUrl: string) => Promise<DatabaseSession>;
    save: (config: InstallConfig) => unknown;
    docker?: DockerRun;
    env?: NodeJS.ProcessEnv;
  },
): Promise<InstallConfig | null> {
  const docker = deps.docker ?? runDocker;
  const port = current.ports.postgres;
  // Held to this only when a password would be changed: a url with one of
  // the install's own changes nothing, and what takes that password is this
  // install's database whatever a stale container is configured for.
  if (!hasPublishedDatabasePassword(current.databaseUrl) || !addressesInstallDatabase(current.databaseUrl, port)) return current;
  const container = await databaseContainerPorts(name, docker);
  const serving = container?.serving.includes(String(port)) ?? false;
  const stop = async (why: string) => {
    const said = databaseServerMismatch(name, port, (await containersPublishing(port, docker)).filter((other) => other !== name), why);
    ui.fail(said.fail);
    for (const note of said.notes) ui.note(note);
    return null;
  };

  if (container?.configured === String(port) && !serving) {
    return stop(`${name} is configured for port ${port} but does not publish it now`);
  }

  // An install from before each had a password of its own, on its own
  // container, is given one once its database answers.
  const step = databasePasswordStep({ databaseUrl: current.databaseUrl, port, published: container?.configured, serving, connection: 'answers' });
  if (step !== 'rotate') return current;
  try {
    const rotated = await rotateDatabasePassword(current, {
      connect: deps.connect,
      serverOf: (marker) => sessionServer(name, marker, current.databaseUrl, docker),
      save: deps.save,
      env: deps.env,
    });
    ui.ok(`${name} has a password of this install’s own now, kept in ${configPath()}`);
    return rotated;
  } catch (error) {
    if (error instanceof DatabaseServerUnconfirmed && error.found.on === 'elsewhere') {
      return stop(`${name} publishes port ${port}, but the connection up made there is not on it`);
    }
    if (error instanceof DatabaseServerUnconfirmed) {
      ui.warn(`${name} still takes the password published with OpenADLC: up could not ask it whether it is the server on port ${port} (${error.message})`);
      ui.note(`anything that reaches its port can log in as its superuser; run \`openadlc up\` again once docker exec ${name} psql answers`);
      return current;
    }
    ui.warn(`${name} still takes the password published with OpenADLC: ${error instanceof Error ? error.message : error}`);
    ui.note('anything that reaches its port can log in as its superuser; run `openadlc up` again');
    return current;
  }
}

/**
 * Brings Postgres up however this machine can: a container, or an existing
 * server. Returns the config to go on with, whose url carries the install's own
 * password when this gave it one, and the container that serves it when it is
 * one of the install's; or null when there is no database.
 */
async function ensureDatabase(config: InstallConfig): Promise<{ config: InstallConfig; container: string | null } | null> {
  const { Client } = (await import('pg')) as typeof import('pg');
  const connect = async (databaseUrl: string): Promise<'answers' | 'nothing' | 'refused'> => {
    const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 1500 });
    try {
      await client.connect();
      await client.end();
      return 'answers';
    } catch (error) {
      return (error as { code?: string }).code === 'ECONNREFUSED' ? 'nothing' : 'refused';
    }
  };
  const installed = await commandExists('docker');
  // Installed and not running answers like no Docker at all to every command
  // below, and the advice for that, to install it, is wrong.
  const stopped = installed && !(await dockerDaemonAnswers());
  const docker = installed && !stopped;
  const name = docker ? await existingDatabaseContainer(config) : databaseContainer();
  const published = docker ? await publishedPostgresPort(name) : undefined;

  // Without Docker there is no container of the install's, and nothing to
  // give a password of its own or a restart policy.
  const settled = async (current: InstallConfig): Promise<{ config: InstallConfig; container: string | null } | null> => {
    if (!docker) return { config: current, container: null };
    const next = await settleDatabase(current, name, {
      connect: async (databaseUrl) => {
        const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 1500 });
        await client.connect();
        return client;
      },
      save: saveConfig,
    });
    if (!next) return null;
    return { config: next, container: (await keepRestarting(name, next.ports.postgres)) ? name : null };
  };

  let current = config;
  const first = await connect(current.databaseUrl);
  if (first === 'answers') {
    ui.ok('postgres is reachable');
    return settled(current);
  }

  if (docker) {
    // A container by this name that publishes another port: starting it
    // again and waiting on this install's port only ever times out, and
    // saying "cannot reach postgres" sent people looking for a server that was
    // running. It is often this install's own database after `ports.postgres`
    // was changed, so removing it is not the advice: that made `up` start a
    // new, empty one.
    if (published !== undefined && published !== String(config.ports.postgres)) {
      ui.fail(`a container named ${name} exists, publishing ${published ? `port ${published}` : 'no port'}, not ${config.ports.postgres}`);
      ui.note(
        `It may be this install's database. If it is, point this install back at it: set ports.postgres and the port in databaseUrl in ${configPath()} to ${published || 'the port it publishes'}`,
      );
      ui.note(`Removing it (docker rm -f ${name}) makes the next openadlc up start a new, empty database`);
      return null;
    }

    if ((LEGACY_DATABASE_CONTAINERS as readonly string[]).includes(name)) {
      // Started as it is, never run anew: it holds the install's data.
      ui.step(`starting postgres in ${name}, the container this install had before the rename`);
      await run('docker', ['start', name]).catch(() => undefined);
    } else {
      let container: { args: string[]; env: Record<string, string> };
      try {
        // Nothing answers yet, so nothing is rotated here, whatever the container publishes.
        const step = databasePasswordStep({ databaseUrl: current.databaseUrl, port: current.ports.postgres, published, serving: false, connection: first });
        // A daemon that is not running answers "no container" too. Generating
        // then would leave an older install's url with a password its container,
        // found once the daemon is back, has never had.
        if (step === 'generate' && (await dockerDaemonAnswers())) {
          // Saved before the container exists, so an `up` interrupted after
          // creating it does not leave a database with a password nobody kept.
          const generated = ensureDatabasePassword(current).config;
          saveConfig(generated);
          adoptDatabaseUrl(current.databaseUrl, generated.databaseUrl);
          current = generated;
          ui.ok(`generated this install’s database password, kept in ${configPath()}`);
        }
        container = databaseRunArgs(name, current);
      } catch (error) {
        ui.fail(error instanceof Error ? error.message : String(error));
        return null;
      }

      ui.step(`starting postgres in a container (${name})`);
      const failed = await run('docker', container.args, { env: { ...process.env, ...container.env } }).then(
        () => null,
        // One already made by this name is started instead.
        async (error: unknown) => (await run('docker', ['start', name]).then(() => null, () => stderrOf(error))),
      );
      if (failed !== null) {
        const said = dockerRunFailure(failed, current.ports.postgres);
        ui.fail(`docker could not start ${name}: ${said.reason}`);
        if (said.note) ui.note(said.note);
        return null;
      }
    }

    for (let attempt = 0; attempt < 40; attempt += 1) {
      if ((await connect(current.databaseUrl)) === 'answers') {
        ui.ok('postgres is up');
        return settled(current);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  /**
   * A server that answers but has no database for us.
   *
   * Connecting goes to the install's own database, so "no such database"
   * and "no server" arrive as the same failure — and the advice for one is
   * useless for the other. A container that outlived its database sent somebody
   * to start a server that was already running and install Docker they already
   * had. The same conflation once had `openadlc doctor` print "postgres answers"
   * and "cannot reach postgres" one line apart.
   */
  const created = await createDatabase(current).catch(() => false);
  if (created) {
    ui.ok(`created ${databaseName(current.databaseUrl)} on a server that was already running`);
    return { config: current, container: null };
  }

  const where = describeDatabase(current.databaseUrl);
  ui.fail(where ? `cannot reach postgres: ${where}` : 'cannot reach postgres');
  if (stopped) ui.note(`${DOCKER_NOT_RUNNING}, so it could not start one: ${START_DOCKER}`);
  else ui.note('Start a Postgres 16 server, or install Docker and run `openadlc up` again.');
  return null;
}

/** The database an install expects, taken from its url. */
export function databaseName(databaseUrl: string): string {
  try {
    return new URL(databaseUrl).pathname.replace(/^\//, '') || 'openadlc_db';
  } catch {
    return 'openadlc_db';
  }
}

/**
 * Creates the install's database on a server that is answering without it.
 *
 * Connects to `postgres`, which every server has, so this can tell a server
 * that is down from one that is merely empty. Returns false rather than
 * throwing when the server itself cannot be reached — that is the other case,
 * and its advice is different.
 */
async function createDatabase(config: InstallConfig): Promise<boolean> {
  const { Client } = (await import('pg')) as typeof import('pg');
  const name = databaseName(config.databaseUrl);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return false;

  const admin = new URL(config.databaseUrl);
  admin.pathname = '/postgres';

  const client = new Client({ connectionString: admin.toString(), connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
  } catch {
    // No server. Not this function's problem to report.
    return false;
  }

  try {
    await client.query(`create database "${name}"`);
    return true;
  } catch (error) {
    // Already there is a success: something else created it in the meantime.
    return /already exists/i.test(error instanceof Error ? error.message : '');
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * A local git repository for the integration suites to work in.
 *
 * Only reached when `OPENADLC_SCRIPTED_ENGINES` is set, which only tests/scratch.sh
 * and CI set — see `SCRIPTED_ENGINES` below.
 */
async function ensureScriptedRepo(): Promise<string> {
  const path = join(openadlcHome(), 'scripted', 'testbed');
  if (existsSync(join(path, '.git'))) return path;

  mkdirSync(path, { recursive: true });
  const git = (args: string[]) => run('git', args, { cwd: path });
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 'scripted@openadlc.local']);
  await git(['config', 'user.name', 'OpenADLC scripted testbed']);

  writeFileSync(
    join(path, 'README.md'),
    '# scripted testbed\n\nA stand-in so the integration suites can run the whole pipeline without a GitHub account.\n',
  );
  writeFileSync(
    join(path, 'AGENTS.md'),
    [
      '# Agent notes',
      '',
      '- Run `make ci` before opening a pull request.',
      '- Write only inside the paths your lease declared.',
      '',
      '## Human review',
      '',
      '- `infra/` @openadlc-operator',
      '',
    ].join('\n'),
  );
  writeFileSync(join(path, 'Makefile'), 'ci: ; @echo "scripted ci: ok"\nsetup: ; @echo "scripted setup: ok"\n');
  await git(['add', '-A']);
  await git(['commit', '-q', '-m', 'Initialize scripted testbed']);
  return path;
}

/**
 * Whether this process is running the integration suites rather than an install.
 *
 * Read from the environment and nowhere else: not `openadlc init`, not
 * `install.json`, not a flag of `openadlc up`. The point of replacing `--demo`
 * with this variable is that there is no longer a supported way for an
 * operator to arrive here by accident.
 */
const SCRIPTED_ENGINES = process.env.OPENADLC_SCRIPTED_ENGINES === '1';

/**
 * Whether the bridge runs the dispatcher (`OPENADLC_DISPATCH_IN_BRIDGE`): on every
 * install but one started for the integration suites.
 *
 * The suites run dispatcher passes of their own and read what each decided. A
 * bridge dispatching beside them is a second dispatcher deciding at the same
 * time — both reading the same free builder, one leasing what the other was
 * about to — which is nothing a suite asserts on and everything that makes it
 * flaky. CI never had it: it starts the services itself, without the variable.
 * A scratch install (`tests/scratch.sh`) runs through `openadlc up`, so it has
 * to be said here.
 */
export function bridgeDispatches(scripted: boolean): boolean {
  return !scripted;
}

/** hostd settings only the compose stack sets, emptied for an install `openadlc up` runs. */
export const COMPOSE_ONLY_BLANK: Readonly<Record<string, string>> = {
  OPENADLC_HOSTD_TASK_BRIDGE_URL: '',
  OPENADLC_HOSTD_TASK_HOSTD_URL: '',
  OPENADLC_RUNNER_BUNDLE: '',
  OPENADLC_GH_SHIM_DIR: '',
};

/**
 * Where `openadlc up` and `openadlc status` ask whether a service answers.
 * The console's `/` refuses a browser that has not signed in, so it is asked
 * at `/signin`, which answers anybody.
 */
export function healthUrl(service: (typeof SERVICES)[number], port: number): string {
  return `http://127.0.0.1:${port}${service === 'console' ? '/signin' : '/healthz'}`;
}

/**
 * What each service is started with. The console secret goes to the console
 * alone, never into `serviceEnv`: hostd is started with that environment, and
 * a bot's session is started by hostd.
 *
 * The bridge is told which container holds the database
 * (`OPENADLC_DATABASE_CONTAINER`), so that while it does not answer,
 * `/healthz` and the console name the `docker start` that brings it back:
 * the bridge runs no Docker of its own, and only `up` knows whether the
 * install's database is a container, and which. Empty for a server that is
 * not, so one exported in the shell is not named for it.
 */
export function serviceSpecs(
  effective: InstallConfig,
  env: Record<string, string>,
  options: { consoleSecret: string; scripted: boolean; node?: string; databaseContainer?: string | null },
): Record<(typeof SERVICES)[number], ServiceSpec> {
  const node = options.node ?? process.execPath;
  return {
    hostd: {
      name: 'hostd',
      command: [node, join(effective.repoRoot, 'apps/hostd/dist/main.js')],
      cwd: effective.repoRoot,
      // Blanked, because a service's environment is merged over the shell's:
      // exported there for the compose stack, these would point this hostd's
      // bots at another install's bridge and hostd, and at assets it does not
      // keep up to date.
      env: { ...env, ...COMPOSE_ONLY_BLANK },
      health: healthUrl('hostd', effective.ports.hostd),
    },
    bridge: {
      name: 'bridge',
      command: [node, join(effective.repoRoot, 'apps/bridge/dist/main.js')],
      cwd: effective.repoRoot,
      // The bridge dispatches (see `RETIRED`), except beside the suites.
      env: {
        ...env,
        OPENADLC_DISPATCH_IN_BRIDGE: bridgeDispatches(options.scripted) ? '1' : '0',
        OPENADLC_DATABASE_CONTAINER: options.databaseContainer ?? '',
      },
      health: healthUrl('bridge', effective.ports.bridge),
    },
    console: {
      name: 'console',
      command: ['pnpm', 'start'],
      cwd: join(effective.repoRoot, 'apps/console'),
      env: { ...env, OPENADLC_CONSOLE_SECRET: options.consoleSecret },
      health: healthUrl('console', effective.ports.console),
    },
  };
}

/**
 * The driver `up` runs with: the one install.json names, or for one that
 * names none, what this machine can run (`chooseDriver`). Not written back:
 * `openadlc init` records a choice; `up` only says which it made.
 */
export async function upDriver(
  config: InstallConfig,
  probe: DriverProbe = dockerProbe,
): Promise<{ config: InstallConfig; reason?: string }> {
  if (storedDriver() !== undefined) return { config };
  const choice = await chooseDriver(probe);
  return { config: { ...config, driver: choice.driver }, reason: choice.reason };
}

/**
 * What `up` says about its driver. Under local, what a task can read and run,
 * every time: it was "Starting OpenADLC (local driver)" and nothing more. A
 * warning, never a failure: development and the scratch suites run local.
 */
export function sayDriver(driver: InstallConfig['driver'], reason?: string): void {
  if (reason) ui.note(`install.json names no driver, so ${driver}: ${reason}`);
  if (driver !== 'local') return;
  ui.warn(LOCAL_DRIVER_WARNING);
  for (const note of LOCAL_DRIVER_NOTES) ui.note(note);
}

export async function up(config: InstallConfig, options: { skipSeed?: boolean; probe?: DriverProbe } = {}): Promise<void> {
  // A restart onto a release that stopped partway left the checkout between
  // two releases: started now, it would run that mix, and the release's
  // migrations. Said first, before anything is started.
  const cutShort = applyingRefusal(openadlcHome(), config.repoRoot);
  if (cutShort) {
    ui.fail(cutShort.reason);
    for (const step of cutShort.steps) ui.note(step);
    process.exitCode = 1;
    return;
  }
  const driven = await upDriver(config, options.probe);
  let effective: InstallConfig = driven.config;
  ui.heading(`Starting OpenADLC (${effective.driver} driver)`);
  sayDriver(effective.driver, driven.reason);

  if (SCRIPTED_ENGINES) {
    // Said as loudly as possible, every time. This used to be `openadlc up --demo`
    // — a documented install option that produced fabricated work while looking
    // like a working install, and on a machine with a connected crew it reached
    // the real repository. It is now reachable only by setting an environment
    // variable, which the docs give only for the integration suites, set by
    // tests/scratch.sh on an install of its own.
    ui.warn('OPENADLC_SCRIPTED_ENGINES is set: every bot will fabricate its work.');
    ui.note('This exists for the integration suites. Nothing it produces is real.');
    const repoPath = await ensureScriptedRepo();
    ui.ok(`scripted repository at ${repoPath}`);
    ui.note('The bridge does not dispatch here: the suites run their own dispatcher passes.');
  }
  ui.note(`state under ${openadlcHome()}`);
  if (makeHomePrivate()) ui.note(`${openadlcHome()} could be read by others on this machine; it is now 0700`);

  if (effective.driver === 'docker' && !(await dockerProbe.dockerAnswers())) {
    // Asked first: with the daemon down, the image looks missing too.
    if (await commandExists('docker')) {
      ui.fail(`the docker driver needs Docker, and ${DOCKER_NOT_RUNNING}`);
      ui.note(START_DOCKER);
    } else {
      ui.fail('the docker driver needs Docker, and Docker is not installed');
      ui.note('install Docker and run openadlc up again, or choose the local driver: openadlc init --driver local');
    }
    process.exitCode = 1;
    return;
  }

  if (effective.driver === 'docker' && !(await botImagePresent())) {
    // Said here rather than discovered when the first task starts. The docker
    // driver runs each bot from an image, and nothing in this repository built
    // one until `infra/local/build-bot-image.sh` existed — so switching the
    // driver produced a host that came up healthy and failed every task.
    ui.fail(`the bot image ${botImage()} is not on this machine, so no task can start`);
    ui.note('build it: infra/local/build-bot-image.sh');
    process.exitCode = 1;
    return;
  }

  const withDatabase = await ensureDatabase(effective);
  if (!withDatabase) {
    process.exitCode = 1;
    return;
  }
  // Carries a password `ensureDatabase` generated or rotated to every service.
  effective = withDatabase.config;

  // hostd starts before the bridge, and hostd refuses every caller it cannot
  // authenticate. The bridge generates the shared secret, so establishing it
  // here means hostd finds one already written instead of coming up unable to
  // serve the bridge that is about to call it.
  await ensureInternalSecret();
  ui.ok('internal secret is in place');
  // What the bridge serves `/v1` for, and what the console signs a browser in
  // with. Made here as well as by the bridge, because the console is started
  // with it.
  const consoleSecret = await ensureConsoleSecret();
  ui.ok('console secret is in place');

  const env = serviceEnv(effective);
  const node = process.execPath;

  ui.step('applying migrations');
  await run(node, [join(effective.repoRoot, 'packages/db/dist/cli/migrate.js')], {
    env: { ...process.env, ...env },
  })
    .then(() => ui.ok('schema is current'))
    .catch((error: Error) => {
      ui.fail(`migrations failed: ${error.message.slice(0, 200)}`);
      throw error;
    });

  if (!options.skipSeed) {
    ui.step('loading config/bots.yaml and config/repos.yaml');
    const args = [join(effective.repoRoot, 'packages/db/dist/cli/seed.js')];
    if (SCRIPTED_ENGINES) args.push('--scripted-board');
    await run(node, args, { env: { ...process.env, ...env } })
      .then(() => ui.ok('crew and repositories are loaded'))
      .catch((error: Error) => ui.warn(`seed reported: ${error.message.slice(0, 200)}`));
  }

  const specs = serviceSpecs(effective, env, { consoleSecret, scripted: SCRIPTED_ENGINES, node, databaseContainer: withDatabase.container });

  // Which installs run from this checkout, so one updating itself refuses to
  // change the files under another's running services (`otherInstallsRunning`).
  try {
    recordCheckoutInstall(effective.repoRoot, openadlcHome());
  } catch (error) {
    ui.warn(`could not note this install in ${effective.repoRoot}/.openadlc: ${error instanceof Error ? error.message : error}`);
  }

  let refused = 0;

  for (const name of SERVICES) {
    const spec = specs[name];
    const pid = keeperPid(name);
    if (pid !== null) {
      ui.ok(`${name} already running (pid ${pid})`);
      continue;
    }

    // Something already serving the port would make the new process die of
    // EADDRINUSE while its health check passed against the old one, and the
    // install would report itself up when it had not started anything.
    if (spec.health && (await answers(spec.health))) {
      refused += 1;
      ui.fail(`${name}: something is already serving ${spec.health} that this install did not start`);
      ui.note(`stop it, or run \`openadlc down\` in the shell that started it, then try again`);
      continue;
    }

    ui.step(`starting ${name}`);
    const started = startService(spec);

    if (spec.health) {
      const healthy = await waitForHealth(spec.health);
      // The health check alone is not proof: confirm the process we started is
      // the one answering.
      if (healthy && keeperPid(name) !== null) {
        ui.ok(`${name} is up (pid ${started})`);
      } else if (healthy) {
        refused += 1;
        ui.fail(`${name} exited but ${spec.health} still answers, so another process holds the port`);
        ui.note(`see ${logFile(name)}`);
      } else {
        refused += 1;
        // Its keeper would go on starting it; one that never answered is stopped instead.
        await stopService(name);
        ui.fail(`${name} did not answer at ${spec.health}`);
        ui.note(`see ${logFile(name)}`);
      }
    } else if (isRunning(started)) {
      ui.ok(`${name} is running (pid ${started})`);
    } else {
      refused += 1;
      ui.fail(`${name} exited immediately`);
      ui.note(`see ${logFile(name)}`);
    }
  }

  ui.plain();
  if (refused > 0) {
    ui.heading(`OpenADLC is partly up: ${refused} service(s) did not start`);
    process.exitCode = 1;
  } else {
    ui.heading('OpenADLC is up');
  }
  for (const line of consoleLines(consoleSecret, effective.ports)) ui.code(line);
  if (!process.env.OPENADLC_NO_SIGN_IN_LINK) {
    ui.note('the console link signs this browser in and works for an hour; `openadlc console-link` prints another');
  }
  ui.plain();

  if (!(await clientIdConfigured(effective))) {
    ui.warn('no GitHub App client id yet, so no bot can connect');
    ui.note(NO_CLIENT_ID_NOTE);
  }
}

/**
 * What `up` prints about where the services are. A link, not the address,
 * for the console: it serves a browser only once it has signed in, and the
 * link expires within the hour (`openadlc console-link` prints another).
 * Started by OpenADLC's own update (`OPENADLC_NO_SIGN_IN_LINK`), its output
 * goes to a log, so the link is left out: whoever reads that log has not
 * signed in.
 */
export function consoleLines(
  consoleSecret: string,
  ports: { console: number; bridge: number; hostd: number },
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const address = `http://127.0.0.1:${ports.console}`;
  return [
    env.OPENADLC_NO_SIGN_IN_LINK ? `console   ${address} (openadlc console-link signs a browser in)` : `console   ${signInLink(consoleSecret, address)}`,
    `bridge    http://127.0.0.1:${ports.bridge}`,
    `hostd     http://127.0.0.1:${ports.hostd}`,
  ];
}

export async function down(): Promise<void> {
  ui.heading(`Stopping OpenADLC (state under ${openadlcHome()})`);
  for (const name of [...SERVICES].reverse()) {
    const pid = readPid(name);
    const outcome = await stopService(name);
    if (outcome === 'stopped') ui.ok(`stopped ${name}`);
    else if (outcome === 'still-running') {
      ui.fail(`${name} would not stop (pid ${pid}); something may still be holding its port`);
      process.exitCode = 1;
    } else if (pid) ui.note(`${name} was not running (stale pid file removed)`);
    else ui.note(`${name} was not running`);
  }
  for (const name of RETIRED) {
    if (keeperPid(name) !== null && (await stopService(name)) === 'stopped') ui.ok(`stopped the ${name} an older install ran; the bridge does its work now`);
  }
  // Not "docker stop openadlc-db", which this used to suggest: that is the
  // container `openadlc up` starts for the default install, and on a machine with
  // a scratch install or a database of its own it is another install's.
  ui.note('postgres and the bot containers were left alone: they hold the data and the bots’ sessions');
}
