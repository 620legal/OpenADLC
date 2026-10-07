import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { DockerResult } from './drivers/docker.js';
import { TASK_TEMPLATE, TaskDatabases, taskDatabaseName, taskdbBindAddress } from './task-db.js';

/**
 * A database per task on one server per host, with Docker answering from a
 * script. What is pinned is the SQL each step sends, in order: a role that can
 * reach another task's database, or a database made without the template's
 * extensions, would pass every check that only asked whether it ran.
 */

const TASK = '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f';

function server(state: { running?: boolean; template?: boolean; superuserPassword?: boolean; bootPassword?: () => string; key?: string } = {}) {
  /** The task databases made on it, so a lookup finds only those. */
  const made = new Set<string>();
  const calls: string[][] = [];
  /** What each call wrote to psql's stdin, and put in the docker client's environment. */
  const inputs = new Map<string[], string>();
  const clientEnv = new Map<string[], Record<string, string>>();
  const docker = async (args: string[], input?: string, secrets?: Record<string, string>): Promise<DockerResult> => {
    calls.push(args);
    if (input !== undefined) inputs.set(args, input);
    if (secrets) clientEnv.set(args, secrets);
    if (args[0] === 'inspect') {
      return state.running === undefined ? { code: 1, stdout: '', stderr: 'no such container' } : { code: 0, stdout: state.running ? 'running\n' : 'exited\n', stderr: '' };
    }
    if (args.includes('psql') && String(args.at(-1)).startsWith('select 1 from pg_database')) {
      const name = /datname = '([^']+)'/.exec(String(args.at(-1)))?.[1] ?? '';
      const there = name === TASK_TEMPLATE ? state.template : made.has(name);
      return { code: 0, stdout: there ? '1\n' : '\n', stderr: '' };
    }
    const making = /^create database (\S+) owner/.exec(String(args.at(-1)));
    if (args.includes('psql') && making?.[1]) made.add(making[1]);
    if (args.includes('psql') && String(args.at(-1)).includes('from pg_authid')) {
      // A server just made has the password it was made with.
      return { code: 0, stdout: (state.superuserPassword ?? state.running === undefined) ? 't\n' : 'f\n', stderr: '' };
    }
    if (args.includes('psql') && String(args.at(-1)).startsWith('drop database if exists fleetadlc_task_template')) state.template = false;
    return { code: 0, stdout: '', stderr: '' };
  };
  const databases = new TaskDatabases({
    docker,
    container: 'fleetadlc-taskdb',
    image: 'pgvector/pgvector:pg16',
    installLabel: 'fleetadlc.install=default',
    bindAddress: '172.17.0.1',
    ...(state.key === undefined ? { password: () => 'a-random-password' } : { key: async () => state.key ?? null }),
    ...(state.bootPassword ? { bootPassword: state.bootPassword } : {}),
  });
  /** Each statement, with the database it was sent to, on the command line or on stdin. */
  const sql = () =>
    calls
      .filter((args) => args.includes('psql'))
      .map((args) => `${args[args.indexOf('-d') + 1]}: ${inputs.get(args) ?? args.at(-1)}`);
  return { calls, databases, sql, inputs, clientEnv };
}

const NAME = 't_3f2a9c1e7b4d4e8a9c2f1a2b3c4d5e6f';

describe('the name a task’s database and role get', () => {
  it('is t_ and every letter and digit of the task’s id, lowercased', () => {
    expect(taskDatabaseName(TASK)).toBe(NAME);
    expect(taskDatabaseName('ABCDEF01-0000-4000-8000-000000000000')).toBe('t_abcdef01000040008000000000000000');
  });

  it('differs for two tasks whose ids begin alike, so one’s start never drops the other’s database', () => {
    expect(taskDatabaseName('3f2a9c1e-0000-4000-8000-000000000001')).not.toBe(taskDatabaseName('3f2a9c1e-0000-4000-8000-000000000002'));
  });

  it('is never anything an id could smuggle SQL into, nor longer than Postgres takes', () => {
    expect(taskDatabaseName("x'; drop database fleetadlc_db; --12345678")).toBe('t_xdropdatabasefleetadlcdb12345678');
    expect(() => taskDatabaseName('short')).toThrow(/not a task id/);
    expect(taskDatabaseName('a'.repeat(100))).toHaveLength(63);
  });
});

describe('a task’s database', () => {
  it('starts the server on the host’s gateway only, then makes the template with its extensions, once', async () => {
    const { calls, databases, sql } = server();

    await databases.create(TASK);
    await databases.create('9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a');

    const run = calls.filter((args) => args[0] === 'run');
    expect(run).toHaveLength(1);
    // Never 0.0.0.0: published where only the host's containers reach it.
    expect(run[0]).toEqual(expect.arrayContaining(['-p', '172.17.0.1:47433:5432', '--restart', 'unless-stopped', 'pgvector/pgvector:pg16']));
    const statements = sql();
    expect(statements.slice(0, 13)).toEqual([
      "postgres: select rolpassword is not null from pg_authid where rolname = 'fleetadlc'",
      `postgres: update pg_database set datistemplate = false where datname = '${TASK_TEMPLATE}'`,
      `postgres: drop database if exists ${TASK_TEMPLATE} with (force)`,
      `postgres: select 1 from pg_database where datname = '${TASK_TEMPLATE}'`,
      `postgres: create database ${TASK_TEMPLATE}`,
      `${TASK_TEMPLATE}: create extension if not exists "vector"`,
      `${TASK_TEMPLATE}: create extension if not exists "pgcrypto"`,
      `${TASK_TEMPLATE}: create extension if not exists "citext"`,
      `${TASK_TEMPLATE}: create extension if not exists "uuid-ossp"`,
      `postgres: update pg_database set datistemplate = true where datname = '${TASK_TEMPLATE}'`,
      'postgres: revoke connect on database postgres from public',
      `postgres: revoke connect on database ${TASK_TEMPLATE} from public`,
      // Nobody logs in as the superuser over the network.
      'postgres: alter role fleetadlc password null',
    ]);
    expect(statements.filter((statement) => statement.includes('create database fleetadlc_task_template'))).toHaveLength(1);
  });

  it('makes the template again, then takes the superuser’s password away, on a server made when that password could be worked out', async () => {
    const { databases, sql } = server({ running: true, template: true, superuserPassword: true });

    await databases.ensure();

    const statements = sql();
    expect(statements.slice(0, 5)).toEqual([
      "postgres: select rolpassword is not null from pg_authid where rolname = 'fleetadlc'",
      `postgres: update pg_database set datistemplate = false where datname = '${TASK_TEMPLATE}'`,
      `postgres: drop database if exists ${TASK_TEMPLATE} with (force)`,
      `postgres: select 1 from pg_database where datname = '${TASK_TEMPLATE}'`,
      `postgres: create database ${TASK_TEMPLATE}`,
    ]);
    expect(statements.at(-1)).toBe('postgres: alter role fleetadlc password null');
    expect(statements.indexOf('postgres: alter role fleetadlc password null')).toBeGreaterThan(
      statements.indexOf(`postgres: update pg_database set datistemplate = true where datname = '${TASK_TEMPLATE}'`),
    );
  });

  it('leaves the template alone, and still takes no password, on a server whose superuser has none', async () => {
    const { databases, sql } = server({ running: true, template: true, superuserPassword: false });

    await databases.ensure();

    expect(sql()).toEqual([
      "postgres: select rolpassword is not null from pg_authid where rolname = 'fleetadlc'",
      `postgres: select 1 from pg_database where datname = '${TASK_TEMPLATE}'`,
      'postgres: revoke connect on database postgres from public',
      `postgres: revoke connect on database ${TASK_TEMPLATE} from public`,
      'postgres: alter role fleetadlc password null',
    ]);
  });

  it('starts a new server with a random password nothing could work out', async () => {
    const first = server();
    const second = server();

    await first.databases.ensure();
    await second.databases.ensure();

    const passwordOf = (s: ReturnType<typeof server>) => s.clientEnv.get(s.calls.find((args) => args[0] === 'run')!)!.POSTGRES_PASSWORD;
    expect(passwordOf(first)).toMatch(/^[0-9a-f]{48}$/);
    expect(passwordOf(first)).not.toBe(passwordOf(second));
    const theOldDefault = createHash('sha256').update(['fleet', 'local', 'sidecar'].join('-') + ':taskdb').digest('hex').slice(0, 32);
    expect([passwordOf(first), passwordOf(second)]).not.toContain(theOldDefault);
  });

  it('is its own role’s alone, from the template, with a limit on its connections, and handed back as a URL the container reaches', async () => {
    const { databases, sql } = server({ running: true, template: true });

    const url = await databases.create(TASK);

    expect(sql().slice(-6)).toEqual([
      `postgres: drop database if exists ${NAME} with (force)`,
      `postgres: drop role if exists ${NAME}`,
      `postgres: create role ${NAME} login password 'a-random-password' connection limit 20`,
      `postgres: create database ${NAME} owner ${NAME} template ${TASK_TEMPLATE}`,
      `postgres: revoke connect on database ${NAME} from public`,
      `postgres: grant connect on database ${NAME} to ${NAME}`,
    ]);
    expect(url).toBe(`postgres://${NAME}:a-random-password@host.docker.internal:47433/${NAME}`);
  });

  it('keeps every password off the docker command line, where the host’s process list shows it', async () => {
    const { calls, databases, inputs, clientEnv } = server({ bootPassword: () => 'a-boot-password' });

    await databases.create(TASK);

    const superuser = 'a-boot-password';
    for (const args of calls) expect(args.join(' ')).not.toMatch(new RegExp(`${superuser}|a-random-password|PGPASSWORD`));
    // The role's password goes on psql's stdin, the superuser's in the docker client's environment.
    const role = calls.find((args) => inputs.get(args)?.includes('create role'));
    expect(role).toEqual(expect.arrayContaining(['exec', '-i', '-f', '-']));
    const run = calls.find((args) => args[0] === 'run')!;
    expect(run).toEqual(expect.arrayContaining(['-e', 'POSTGRES_PASSWORD']));
    expect(clientEnv.get(run)).toEqual({ POSTGRES_PASSWORD: superuser });
  });

  it('is found again, at the URL its start was given, by a hostd that restarted and adopts its computer', async () => {
    // Local CI in an adopted computer runs through `docker exec`, without the
    // session's environment; a random password was lost with the old process.
    const { databases, sql } = server({ key: 'the-install-secret' });

    const url = await databases.create(TASK);

    expect(await databases.urlFor(TASK)).toBe(url);
    expect(url).toMatch(new RegExp(`^postgres://${NAME}:[0-9a-f]{40}@host\\.docker\\.internal:47433/${NAME}$`));
    // Its own: another task's differs, and neither is the task's session token.
    const other = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
    const otherUrl = await databases.create(other);
    expect(otherUrl.split('@')[0]!.split(':').at(-1)).not.toBe(url.split('@')[0]!.split(':').at(-1));
    const { taskTokenFor } = await import('@fleetadlc/github');
    expect(url).not.toContain(taskTokenFor(TASK, 'the-install-secret').slice(0, 40));
    // Looked up, never reset: the session's connections use the original.
    expect(sql().filter((line) => line.includes('alter role t_'))).toEqual([]);
  });

  it('is no URL for a task that has none, or when there is no key to work its password out from', async () => {
    const keyed = server({ key: 'the-install-secret', running: true, template: true });
    expect(await keyed.databases.urlFor(TASK)).toBeNull();

    const keyless = server({ key: '', running: true, template: true });
    const url = await keyless.databases.create(TASK);
    expect(url).toMatch(new RegExp(`^postgres://${NAME}:[0-9a-f]{36}@`));
    expect(await keyless.databases.urlFor(TASK)).toBeNull();
  });

  it('is dropped with its role when the computer goes, by its old short name too, and dropping one that is not there is not a failure', async () => {
    const { databases, sql } = server({ running: true, template: true });

    await databases.drop(TASK);

    expect(sql()).toEqual([
      `postgres: drop database if exists ${NAME} with (force)`,
      `postgres: drop role if exists ${NAME}`,
      'postgres: drop database if exists t_3f2a9c1e with (force)',
      'postgres: drop role if exists t_3f2a9c1e',
    ]);
    await expect(server().databases.drop(TASK)).resolves.toBeUndefined();
  });
});

describe('where the server is published', () => {
  const answering = (os: string, gateway = '172.17.0.1') => async (args: string[]): Promise<DockerResult> =>
    args[0] === 'info' ? { code: 0, stdout: `${os}\n`, stderr: '' } : { code: 0, stdout: `${gateway}\n`, stderr: '' };

  it('is loopback on Docker Desktop and OrbStack, whose host.docker.internal is the host’s loopback', async () => {
    expect(await taskdbBindAddress(answering('Docker Desktop'), null)).toBe('127.0.0.1');
    expect(await taskdbBindAddress(answering('OrbStack'), null)).toBe('127.0.0.1');
  });

  it('is the default bridge’s gateway on Linux, which is what host-gateway is', async () => {
    expect(await taskdbBindAddress(answering('Debian GNU/Linux 12 (bookworm)', '172.18.0.1'), null)).toBe('172.18.0.1');
  });

  it('is the address the install configures, when it configures one', async () => {
    expect(await taskdbBindAddress(answering('OrbStack'), '10.0.0.5')).toBe('10.0.0.5');
  });

  it('is never every address the host has, whatever the install says', async () => {
    for (const wildcard of ['0.0.0.0', '::', '[::]']) {
      await expect(taskdbBindAddress(answering('OrbStack'), wildcard)).rejects.toThrow(/FLEETADLC_TASKDB_BIND.*Unset it, or give the host's gateway or loopback address/);
    }
  });
});
