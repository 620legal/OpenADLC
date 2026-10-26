import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { defaultConfig, type InstallConfig } from '../install.js';
import {
  addressesInstallDatabase,
  bridgeDispatches,
  clientIdConfigured,
  COMPOSE_ONLY_BLANK,
  consoleLines,
  up,
  databaseName,
  databasePasswordStep,
  databaseRunArgs,
  DatabaseServerUnconfirmed,
  dockerRunFailure,
  NO_CLIENT_ID_NOTE,
  rotateDatabasePassword,
  settleDatabase,
  type DockerRun,
  type SessionServer,
} from './up.js';

const PUBLISHED_URL = 'postgres://openadlc:openadlc@127.0.0.1:47432/openadlc_db';
const OWN_PASSWORD = 'c0ffee'.repeat(10) + 'abcd';

/**
 * A server that answers with no database for us reads as a server that is not
 * there, because the only connection tried is to the install's own database.
 * The advice for one is useless for the other: a container that outlived its
 * database sent somebody to start a server that was already running and install
 * Docker they already had.
 */
describe('the database an install expects', () => {
  it('is taken from the url, not assumed', () => {
    expect(databaseName('postgres://openadlc:openadlc@127.0.0.1:47432/openadlc_db')).toBe('openadlc_db');
    expect(databaseName('postgres://u:p@host:5432/something_else')).toBe('something_else');
  });

  it('falls back rather than throwing on a url it cannot parse', () => {
    // A bad url is somebody else's error to report; this one still has to
    // return a name so the caller can say which database it meant.
    expect(databaseName('not a url')).toBe('openadlc_db');
    expect(databaseName('')).toBe('openadlc_db');
  });

  it('ignores a query string, which a hosted url usually carries', () => {
    expect(databaseName('postgres://u:p@host:5432/openadlc_db?sslmode=require')).toBe('openadlc_db');
  });
});

/**
 * Two dispatchers deciding at once: a scratch install's bridge, and the
 * integration suites' own passes against it. The suites passed; they would be
 * flaky the day the two disagreed.
 */
describe('whether the bridge dispatches', () => {
  it('does on an install', () => {
    expect(bridgeDispatches(false)).toBe(true);
  });

  it('does not on one started for the integration suites, which dispatch for themselves', () => {
    expect(bridgeDispatches(true)).toBe(false);
  });
});

describe('what a hostd `openadlc up` starts is told', () => {
  it('blanks the compose stack’s own settings, so a shell that exported them cannot aim this install at another', () => {
    expect(COMPOSE_ONLY_BLANK).toEqual({
      OPENADLC_HOSTD_TASK_BRIDGE_URL: '',
      OPENADLC_HOSTD_TASK_HOSTD_URL: '',
      OPENADLC_RUNNER_BUNDLE: '',
      OPENADLC_GH_SHIM_DIR: '',
    });
  });
});

describe('the container an install keeps its database in', () => {
  it('is openadlc-db for the default install, and named after any other', async () => {
    const { databaseContainer } = await import('./up.js');
    expect(databaseContainer({})).toBe('openadlc-db');
    expect(databaseContainer({ OPENADLC_INSTALL_ID: 'default' })).toBe('openadlc-db');
    // A scratch install never starts or reuses the real install's container.
    expect(databaseContainer({ OPENADLC_INSTALL_ID: 'scratch', OPENADLC_BOT_PREFIX: 'scratch-' })).toBe('scratch-db');
    expect(databaseContainer({ OPENADLC_INSTALL_ID: 'compose' })).toBe('compose-db');
  });
});

/**
 * The container `openadlc up` creates. It used to be given `openadlc` as its
 * password whatever `databaseUrl` said, and was published on every address,
 * where Docker's rules go around a host firewall.
 */
describe('what `openadlc up` says when docker run fails', () => {
  // Docker's words were thrown away, and `up` waited twenty seconds and said
  // to install Docker to someone whose port was simply taken.
  it('gives the first line Docker said, and names a port something else holds', () => {
    const said = dockerRunFailure(
      'docker: Error response from daemon: driver failed programming external connectivity on endpoint openadlc-db: Bind for 127.0.0.1:47432 failed: port is already allocated.\nRun \'docker run --help\' for more information\n',
      47432,
    );
    expect(said.reason).toBe(
      'docker: Error response from daemon: driver failed programming external connectivity on endpoint openadlc-db: Bind for 127.0.0.1:47432 failed: port is already allocated.',
    );
    expect(said.note).toContain('port 47432 is taken by something else');
  });

  it('adds nothing about a port when the port is not the trouble', () => {
    expect(dockerRunFailure('Unable to find image locally\npull access denied', 47432)).toEqual({ reason: 'Unable to find image locally', note: null });
  });
});

describe('the database container `openadlc up` creates', () => {
  it('is published on loopback only', () => {
    const { args } = databaseRunArgs('openadlc-db', defaultConfig('/repo'));
    expect(args).toContain('127.0.0.1:47432:5432');
    expect(args.join(' ')).toContain('-p 127.0.0.1:47432:5432');
  });

  it('takes user, password and database from the url, and keeps the password out of its arguments', () => {
    const config = { ...defaultConfig('/repo'), databaseUrl: `postgres://app:${OWN_PASSWORD}@127.0.0.1:47432/the_db` };
    const { args, env } = databaseRunArgs('openadlc-db', config);

    expect(args).toContain('POSTGRES_USER=app');
    expect(args).toContain('POSTGRES_DB=the_db');
    // A bare `-e NAME` is read from docker's own environment, so the password
    // is not in the host's process list.
    expect(args).toContain('POSTGRES_PASSWORD');
    expect(env).toEqual({ POSTGRES_PASSWORD: OWN_PASSWORD });
    expect(args.join(' ')).not.toContain(OWN_PASSWORD);
    expect(args.some((arg) => arg.startsWith('POSTGRES_PASSWORD='))).toBe(false);
  });

  it('keeps the data in a volume named after the container, so removing the container does not lose it', () => {
    expect(databaseRunArgs('openadlc-db', defaultConfig('/repo')).args.join(' ')).toContain('-v openadlc-db-data:/var/lib/postgresql/data');
    expect(databaseRunArgs('scratch-db', defaultConfig('/repo')).args.join(' ')).toContain('-v scratch-db-data:/var/lib/postgresql/data');
  });

  it('refuses a url it cannot read, rather than creating a database without a password', () => {
    expect(() => databaseRunArgs('openadlc-db', { ...defaultConfig('/repo'), databaseUrl: 'not a url' })).toThrow(
      /databaseUrl in .*install\.json is not a postgres url/,
    );
  });

  // With no policy, OrbStack restarting brought `openadlc-taskdb` back and
  // left `openadlc-db` down, and the bridge refused every request.
  it('comes back by itself when Docker or the machine restarts', () => {
    const { args } = databaseRunArgs('openadlc-db', defaultConfig('/repo'));
    expect(args.join(' ')).toContain('--restart unless-stopped');
    // An option of `run`, before the image: after it, it would be the container's command.
    expect(args.indexOf('--restart')).toBeLessThan(args.indexOf('pgvector/pgvector:pg16'));
  });
});

describe('a database container made before `openadlc up` gave it a restart policy', () => {
  /**
   * Docker as `keepRestarting` meets it: each container's state, policy,
   * configured port and the port Docker holds for it now. `docker update`
   * changes the policy, or fails the way the daemon would.
   */
  function machine(containers: Record<string, { restart: string; configured: number; serving?: number }>, options: { update?: 'fails' } = {}) {
    const calls: string[][] = [];
    const bindings = (port?: number) => (port ? { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: String(port) }] } : {});
    const docker: DockerRun = async (args) => {
      calls.push(args);
      const container = containers[args.at(-1) ?? ''];
      if (!container) throw Object.assign(new Error('docker failed'), { stderr: `Error: No such container: ${args.at(-1)}\n` });
      if (args[0] === 'inspect') {
        const status = container.serving ? 'running' : 'exited';
        return { stdout: `${JSON.stringify({ status, restart: container.restart, configured: bindings(container.configured), serving: bindings(container.serving) })}\n` };
      }
      if (args[0] === 'update') {
        if (options.update === 'fails') throw Object.assign(new Error('docker update failed'), { stderr: 'Error response from daemon: Cannot update container: permission denied\n' });
        container.restart = args[args.indexOf('--restart') + 1] ?? '';
        return { stdout: `${args.at(-1)}\n` };
      }
      throw new Error(`docker ${args.join(' ')} was not expected`);
    };
    return { docker, calls, updates: () => calls.filter((args) => args[0] === 'update') };
  }

  async function keeping(name: string, port: number, docker: DockerRun) {
    const { keepRestarting } = await import('./up.js');
    const printed: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: string) => void printed.push(String(line)));
    try {
      return { serves: await keepRestarting(name, port, docker), said: printed.join('\n') };
    } finally {
      log.mockRestore();
    }
  }

  it('gives the install’s container `--restart unless-stopped`, and says so the one time it does', async () => {
    for (const none of ['', 'no']) {
      const world = machine({ 'openadlc-db': { restart: none, configured: 47432, serving: 47432 } });

      const first = await keeping('openadlc-db', 47432, world.docker);
      const second = await keeping('openadlc-db', 47432, world.docker);

      expect(world.updates()).toEqual([['update', '--restart', 'unless-stopped', 'openadlc-db']]);
      expect(first).toEqual({ serves: true, said: expect.stringContaining('openadlc-db now comes back by itself when Docker or this machine restarts (--restart unless-stopped)') });
      expect(second).toEqual({ serves: true, said: '' });
    }
  });

  it('keeps a policy somebody chose', async () => {
    for (const restart of ['always', 'on-failure', 'unless-stopped']) {
      const world = machine({ 'openadlc-db': { restart, configured: 47432, serving: 47432 } });
      expect(await keeping('openadlc-db', 47432, world.docker)).toEqual({ serves: true, said: '' });
      expect(world.updates()).toEqual([]);
    }
  });

  it('leaves a container that does not serve the install’s port now, or is not there, as it is', async () => {
    // The stale `scratch-db` of #111, given a policy, would race the real server for the port at Docker's next start.
    const world = machine({ 'scratch-db': { restart: '', configured: 57432 }, 'openadlc-scratch-db': { restart: '', configured: 57432, serving: 57432 } });

    expect(await keeping('scratch-db', 57432, world.docker)).toEqual({ serves: false, said: '' });
    expect(await keeping('openadlc-db', 47432, world.docker)).toEqual({ serves: false, said: '' });
    expect(world.updates()).toEqual([]);
  });

  it('says what Docker said, and the command to run, when it cannot give it one', async () => {
    const world = machine({ 'openadlc-db': { restart: '', configured: 47432, serving: 47432 } }, { update: 'fails' });

    const { serves, said } = await keeping('openadlc-db', 47432, world.docker);

    expect(serves).toBe(true);
    expect(said).toContain(
      'openadlc-db has no restart policy, so it stays down after Docker or this machine restarts: docker update said Error response from daemon: Cannot update container: permission denied',
    );
    expect(said).toContain('docker update --restart unless-stopped openadlc-db');
  });
});

describe('what `openadlc up` does about the published database password', () => {
  const step = (input: Partial<Parameters<typeof databasePasswordStep>[0]>) =>
    databasePasswordStep({ databaseUrl: PUBLISHED_URL, port: 47432, published: undefined, serving: false, connection: 'nothing', ...input });

  it('generates one for a new install, before its container exists', () => {
    expect(step({})).toBe('generate');
  });

  it('rotates it on the install’s own container once it answers, so the data stays', () => {
    expect(step({ published: '47432', serving: true, connection: 'answers' })).toBe('rotate');
    // Stopped: started first, then rotated.
    expect(step({ published: '47432', connection: 'nothing' })).toBe('keep');
  });

  // A stale `scratch-db`, configured for 57432, was taken for the server there
  // while `openadlc-scratch-db` answered, and that one's password was changed.
  it('leaves what answers alone while the install’s container is only configured for the port', () => {
    expect(step({ published: '47432', serving: false, connection: 'answers' })).toBe('keep');
    expect(
      step({ databaseUrl: 'postgres://openadlc:openadlc@127.0.0.1:57432/openadlc_db', port: 57432, published: '57432', serving: false, connection: 'answers' }),
    ).toBe('keep');
  });

  it('leaves a database it does not own alone', () => {
    // tests/scratch.sh starts openadlc-scratch-db itself, with the published
    // password, and hands that url to the integration suites.
    expect(step({ databaseUrl: 'postgres://openadlc:openadlc@127.0.0.1:57432/openadlc_db', port: 57432, connection: 'answers' })).toBe('keep');
    // A server on the port that is not the install's container.
    expect(step({ connection: 'answers' })).toBe('keep');
    expect(step({ connection: 'refused' })).toBe('keep');
    // A container of this name on another port.
    expect(step({ published: '5432', serving: true, connection: 'answers' })).toBe('keep');
    // An external server.
    expect(step({ databaseUrl: 'postgres://openadlc:openadlc@db.internal:47432/openadlc_db', published: '47432', serving: true, connection: 'answers' })).toBe('keep');
  });

  it('does nothing to a password the install already has', () => {
    const databaseUrl = `postgres://openadlc:${OWN_PASSWORD}@127.0.0.1:47432/openadlc_db`;
    expect(step({ databaseUrl })).toBe('keep');
    expect(step({ databaseUrl, published: '47432', serving: true, connection: 'answers' })).toBe('keep');
  });

  it('counts loopback on the install’s port as its own address, and nothing else', () => {
    expect(addressesInstallDatabase(PUBLISHED_URL, 47432)).toBe(true);
    expect(addressesInstallDatabase('postgres://u:p@localhost:47432/x', 47432)).toBe(true);
    expect(addressesInstallDatabase('postgres://u:p@[::1]:47432/x', 47432)).toBe(true);
    expect(addressesInstallDatabase(PUBLISHED_URL, 57432)).toBe(false);
    expect(addressesInstallDatabase('postgres://u:p@10.0.0.5:47432/x', 47432)).toBe(false);
    expect(addressesInstallDatabase('nonsense', 47432)).toBe(false);
  });
});

describe('rotating an older install’s database password', () => {
  function fake(options: { failSave?: boolean; failAlter?: boolean; server?: SessionServer } = {}) {
    const events: string[] = [];
    const saved: InstallConfig[] = [];
    return {
      events,
      saved,
      deps: {
        serverOf: async (marker: string) => {
          events.push(`ask the container for ${marker}`);
          return options.server ?? { on: 'container' as const };
        },
        connect: async (url: string) => {
          events.push(`connect ${url}`);
          return {
            query: async (text: string) => {
              events.push(text);
              if (options.failAlter && text.startsWith('alter')) throw new Error(`syntax error at or near "${text}"`);
            },
            end: async () => {
              events.push('end');
            },
          };
        },
        save: (config: InstallConfig) => {
          events.push('save');
          if (options.failSave) throw new Error('EACCES: permission denied, open install.json');
          saved.push(config);
        },
      },
    };
  }

  it('alters the role over the old url, once the container holds that connection, saves the new url straight after, and hands it on', async () => {
    const config = defaultConfig('/repo');
    const env: NodeJS.ProcessEnv = { DATABASE_URL: PUBLISHED_URL };
    const { events, saved, deps } = fake();

    const next = await rotateDatabasePassword(config, { ...deps, env });

    const password = new URL(next.databaseUrl).password;
    expect(password).toMatch(/^[0-9a-f]{64}$/);
    const marker = /^set application_name to '(openadlc-up-[0-9a-f]{16})'$/.exec(events[1] ?? '')?.[1];
    expect(marker).toBeDefined();
    expect(events).toEqual([
      `connect ${PUBLISHED_URL}`,
      `set application_name to '${marker}'`,
      `ask the container for ${marker}`,
      `alter role "openadlc" password '${password}'`,
      'save',
      'end',
    ]);
    expect(saved).toEqual([next]);
    // This process's pool, and every service up starts, connect with it.
    expect(env.DATABASE_URL).toBe(next.databaseUrl);
    expect(next).toEqual({ ...config, databaseUrl: `postgres://openadlc:${password}@127.0.0.1:47432/openadlc_db` });
  });

  it('leaves a DATABASE_URL exported for another database alone', async () => {
    const env: NodeJS.ProcessEnv = { DATABASE_URL: 'postgres://u:p@elsewhere:5432/x' };
    await rotateDatabasePassword(defaultConfig('/repo'), { ...fake().deps, env });
    expect(env.DATABASE_URL).toBe('postgres://u:p@elsewhere:5432/x');
  });

  it('puts the old password back when the new one cannot be saved, and never says the new one', async () => {
    const env: NodeJS.ProcessEnv = { DATABASE_URL: PUBLISHED_URL };
    const { events, deps } = fake({ failSave: true });

    await expect(rotateDatabasePassword(defaultConfig('/repo'), { ...deps, env })).rejects.toThrow(/EACCES/);
    expect(events.at(-2)).toBe(`alter role "openadlc" password 'openadlc'`);
    expect(env.DATABASE_URL).toBe(PUBLISHED_URL);
  });

  it('keeps the new password out of an error', async () => {
    const { deps } = fake({ failAlter: true });
    const error = (await rotateDatabasePassword(defaultConfig('/repo'), { ...deps, env: {} }).catch((caught: Error) => caught)) as Error;
    expect(error.message).toContain('***');
    expect(error.message).not.toMatch(/[0-9a-f]{64}/);
  });

  // Whatever answers on the port answers the connection, and the container
  // configured for it is not always what does (#111).
  it('alters nothing on a server the container does not show to be its own, and says which way it is not', async () => {
    for (const server of [{ on: 'elsewhere' as const }, { on: 'unknown' as const, reason: 'Error response from daemon: container is not running' }]) {
      const env: NodeJS.ProcessEnv = { DATABASE_URL: PUBLISHED_URL };
      const { events, saved, deps } = fake({ server });

      const error = (await rotateDatabasePassword(defaultConfig('/repo'), { ...deps, env }).catch((caught: unknown) => caught)) as DatabaseServerUnconfirmed;

      expect(error).toBeInstanceOf(DatabaseServerUnconfirmed);
      expect(error.found).toEqual(server);
      expect(events.some((event) => event.startsWith('alter'))).toBe(false);
      expect(events.at(-1)).toBe('end');
      expect(saved).toEqual([]);
      expect(env.DATABASE_URL).toBe(PUBLISHED_URL);
    }
  });

  it('refuses a role name it would have to quote', async () => {
    const { events, deps } = fake();
    const config = { ...defaultConfig('/repo'), databaseUrl: 'postgres://a%22b:openadlc@127.0.0.1:47432/openadlc_db' };
    await expect(rotateDatabasePassword(config, { ...deps, env: {} })).rejects.toThrow(/plain role/);
    expect(events).toEqual([]);
  });
});

/**
 * Testing v0.1.5 on a scratch install, a `scratch-db` left by another run was
 * configured for 57432 while `openadlc-scratch-db` answered there. `up` took
 * the configured one for the server on the port and changed the password of
 * the one answering, and the suites' `DATABASE_URL` stopped working (#111).
 */
describe('the server `openadlc up` changes a database password on', () => {
  const SCRATCH_URL = 'postgres://openadlc:openadlc@127.0.0.1:57432/openadlc_db';
  const scratch = (): InstallConfig => ({
    ...defaultConfig('/repo'),
    databaseUrl: SCRATCH_URL,
    ports: { ...defaultConfig('/repo').ports, postgres: 57432 },
  });

  /**
   * Docker and Postgres as `up` meets them: each container's configured port,
   * the port Docker holds for it now (none while it is stopped), and its
   * server, which keeps the names of the connections made to it. The url
   * reaches `answering`, whatever the containers are configured with.
   */
  function machine(containers: Record<string, { configured: number; serving?: number }>, options: { answering: string; exec?: 'fails' }) {
    const sessions = new Map(Object.keys(containers).map((name) => [name, new Set<string>()]));
    const queries: string[] = [];
    const execs: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
    const bindings = (port?: number) => (port ? { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: String(port) }] } : {});
    const docker: DockerRun = async (args, run) => {
      const [command] = args;
      if (command === 'inspect') {
        const container = containers[args.at(-1) ?? ''];
        if (!container) throw Object.assign(new Error('docker inspect failed'), { stderr: `Error: No such container: ${args.at(-1)}\n` });
        return { stdout: `${JSON.stringify({ configured: bindings(container.configured), serving: bindings(container.serving) })}\n` };
      }
      if (command === 'ps') {
        const running = Object.entries(containers).filter(([, container]) => container.serving);
        return { stdout: running.map(([name, container]) => `${name}\t127.0.0.1:${container.serving}->5432/tcp\n`).join('') };
      }
      if (command === 'exec') {
        execs.push({ args, env: run?.env });
        const name = args[3] ?? '';
        if (options.exec === 'fails' || !containers[name]?.serving) {
          throw Object.assign(new Error('docker exec failed'), { stderr: `Error response from daemon: container ${name} is not running\n` });
        }
        const marker = /application_name = '([^']+)'/.exec(args.at(-1) ?? '')?.[1] ?? '';
        return { stdout: `${sessions.get(name)?.has(marker) ? 1 : 0}\n` };
      }
      throw new Error(`docker ${args.join(' ')} was not expected`);
    };
    const connect = async () => ({
      query: async (text: string) => {
        queries.push(text);
        const named = /^set application_name to '([^']+)'$/.exec(text)?.[1];
        if (named) sessions.get(options.answering)?.add(named);
      },
      end: async () => undefined,
    });
    return { docker, connect, queries, execs };
  }

  async function settling(config: InstallConfig, name: string, world: ReturnType<typeof machine>) {
    const printed: string[] = [];
    const saved: InstallConfig[] = [];
    const env: NodeJS.ProcessEnv = { DATABASE_URL: config.databaseUrl };
    const log = vi.spyOn(console, 'log').mockImplementation((line: string) => void printed.push(String(line)));
    try {
      const result = await settleDatabase(config, name, { docker: world.docker, connect: world.connect, save: (next) => void saved.push(next), env });
      return { result, saved, env, said: printed.join('\n') };
    } finally {
      log.mockRestore();
    }
  }

  it('changes nothing when two containers are configured for the port and the other one serves it, and says why', async () => {
    const world = machine({ 'scratch-db': { configured: 57432 }, 'openadlc-scratch-db': { configured: 57432, serving: 57432 } }, { answering: 'openadlc-scratch-db' });

    const { result, saved, env, said } = await settling(scratch(), 'scratch-db', world);

    expect(result).toBeNull();
    expect(world.queries).toEqual([]);
    expect(saved).toEqual([]);
    expect(env.DATABASE_URL).toBe(SCRATCH_URL);
    expect(said).toContain('scratch-db is configured for port 57432 but does not publish it now: openadlc-scratch-db answers there, so up stopped and changed no password');
    expect(said).toContain("if scratch-db holds this install's database: stop openadlc-scratch-db, then run openadlc up again");
    expect(said).toContain('if openadlc-scratch-db holds it instead: move scratch-db aside, keeping its data (docker rename scratch-db scratch-db-old), then run openadlc up again');
  });

  it('changes nothing when Docker says the container publishes the port but the connection reaches another server', async () => {
    const world = machine({ 'openadlc-db': { configured: 47432, serving: 47432 }, 'other-db': { configured: 47432, serving: 47432 } }, { answering: 'other-db' });

    const { result, saved, env, said } = await settling(defaultConfig('/repo'), 'openadlc-db', world);

    expect(result).toBeNull();
    expect(world.queries.some((query) => query.startsWith('alter'))).toBe(false);
    expect(saved).toEqual([]);
    expect(env.DATABASE_URL).toBe(PUBLISHED_URL);
    expect(said).toContain('openadlc-db publishes port 47432, but the connection up made there is not on it: other-db answers there, so up stopped and changed no password');
  });

  it('gives the install’s own container a password of its own, asked inside it, without the password in its arguments', async () => {
    const world = machine({ 'openadlc-db': { configured: 47432, serving: 47432 } }, { answering: 'openadlc-db' });

    const { result, saved, env, said } = await settling(defaultConfig('/repo'), 'openadlc-db', world);

    const password = new URL(result?.databaseUrl ?? 'postgres://x').password;
    expect(password).toMatch(/^[0-9a-f]{64}$/);
    expect(world.queries.at(-1)).toBe(`alter role "openadlc" password '${password}'`);
    expect(saved).toEqual([result]);
    expect(env.DATABASE_URL).toBe(result?.databaseUrl);
    expect(said).toContain('openadlc-db has a password of this install’s own now');
    const [exec] = world.execs;
    expect(exec?.args.slice(0, 5)).toEqual(['exec', '-e', 'PGPASSWORD', 'openadlc-db', 'psql']);
    expect(exec?.env?.PGPASSWORD).toBe('openadlc');
    expect(exec?.args.some((arg) => arg.startsWith('PGPASSWORD='))).toBe(false);
  });

  it('goes on with the published password, unchanged, when the container cannot be asked', async () => {
    const world = machine({ 'openadlc-db': { configured: 47432, serving: 47432 } }, { answering: 'openadlc-db', exec: 'fails' });

    const { result, saved, said } = await settling(defaultConfig('/repo'), 'openadlc-db', world);

    expect(result).toEqual(defaultConfig('/repo'));
    expect(world.queries.some((query) => query.startsWith('alter'))).toBe(false);
    expect(saved).toEqual([]);
    expect(said).toContain('openadlc-db still takes the password published with OpenADLC: up could not ask it whether it is the server on port 47432');
  });

  it('goes on with a server that is not the install’s container when none of that name exists, as tests/scratch.sh starts it', async () => {
    const world = machine({ 'openadlc-scratch-db': { configured: 57432, serving: 57432 } }, { answering: 'openadlc-scratch-db' });

    const { result, saved, said } = await settling(scratch(), 'scratch-db', world);

    expect(result).toEqual(scratch());
    expect(world.queries).toEqual([]);
    expect(saved).toEqual([]);
    expect(said).toBe('');
  });

  it('goes on with a url that has a password of the install’s own, which nothing changes, whatever a stale container is configured for', async () => {
    const own = { ...defaultConfig('/repo'), databaseUrl: `postgres://openadlc:${OWN_PASSWORD}@127.0.0.1:47432/openadlc_db` };
    const world = machine({ 'openadlc-db': { configured: 47432 }, 'openadlc-db-new': { configured: 47432, serving: 47432 } }, { answering: 'openadlc-db-new' });

    const { result, said } = await settling(own, 'openadlc-db', world);

    expect(result).toEqual(own);
    expect(world.queries).toEqual([]);
    expect(said).toBe('');
  });
});

describe('where a container publishes postgres', () => {
  const inspecting = (stdout: string): DockerRun => async () => ({ stdout });

  it('is what Docker holds for it now, beside what it was configured with', async () => {
    const { databaseContainerPorts } = await import('./up.js');
    const configured = '{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"57432"}]}';
    // Stopped, or its start found the port taken: configured for it, holding nothing.
    expect(await databaseContainerPorts('scratch-db', inspecting(`{"configured":${configured},"serving":{}}\n`))).toEqual({ configured: '57432', serving: [] });
    expect(await databaseContainerPorts('scratch-db', inspecting(`{"configured":${configured},"serving":null}\n`))).toEqual({ configured: '57432', serving: [] });
    const both = '{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"47432"},{"HostIp":"::1","HostPort":"47432"}]}';
    expect(await databaseContainerPorts('openadlc-db', inspecting(`{"configured":${both},"serving":${both}}\n`))).toEqual({ configured: '47432', serving: ['47432'] });
  });

  it('is nothing for a container that is not there', async () => {
    const { databaseContainerPorts } = await import('./up.js');
    const missing: DockerRun = async () => {
      throw new Error('Error: No such container: scratch-db');
    };
    expect(await databaseContainerPorts('scratch-db', missing)).toBeUndefined();
  });
});

/**
 * The console secret is what the bridge serves `/v1` for. hostd is started
 * with `serviceEnv`, and a bot's session is started by hostd, so it goes to
 * the console and nowhere else.
 */
describe('what `openadlc up` starts each service with', () => {
  it('gives the console secret to the console alone', async () => {
    const { serviceSpecs } = await import('./up.js');
    const { defaultConfig, serviceEnv } = await import('../install.js');
    const config = defaultConfig('/repo');
    const env = serviceEnv(config);
    const specs = serviceSpecs(config, env, { consoleSecret: 'c'.repeat(64), scripted: false, node: 'node' });

    expect(specs.console.env.OPENADLC_CONSOLE_SECRET).toBe('c'.repeat(64));
    expect(specs.hostd.env).not.toHaveProperty('OPENADLC_CONSOLE_SECRET');
    expect(specs.bridge.env).not.toHaveProperty('OPENADLC_CONSOLE_SECRET');
    expect(env).not.toHaveProperty('OPENADLC_CONSOLE_SECRET');
    expect(JSON.stringify([specs.hostd, specs.bridge])).not.toContain('c'.repeat(64));
  });

  it('asks the console whether it answers at /signin, since / refuses a browser that has not signed in', async () => {
    const { healthUrl, serviceSpecs } = await import('./up.js');
    const { defaultConfig, serviceEnv } = await import('../install.js');
    const config = defaultConfig('/repo');
    const specs = serviceSpecs(config, serviceEnv(config), { consoleSecret: 'c'.repeat(64), scripted: false, node: 'node' });
    expect(specs.console.health).toBe(`http://127.0.0.1:${config.ports.console}/signin`);
    expect(specs.bridge.health).toBe(`http://127.0.0.1:${config.ports.bridge}/healthz`);
    expect(healthUrl('console', 57300)).toBe('http://127.0.0.1:57300/signin');
    expect(healthUrl('hostd', 57312)).toBe('http://127.0.0.1:57312/healthz');
  });

  // The bridge runs no Docker, so only `up` can tell it which `docker start` brings its database back.
  it('tells the bridge which container holds the database, and names none for a server that is not one', async () => {
    const { serviceSpecs } = await import('./up.js');
    const { defaultConfig, serviceEnv } = await import('../install.js');
    const config = defaultConfig('/repo');
    const specs = (databaseContainer: string | null) =>
      serviceSpecs(config, serviceEnv(config), { consoleSecret: 'c'.repeat(64), scripted: false, node: 'node', databaseContainer });

    expect(specs('openadlc-db').bridge.env.OPENADLC_DATABASE_CONTAINER).toBe('openadlc-db');
    expect(specs('scratch-db').bridge.env.OPENADLC_DATABASE_CONTAINER).toBe('scratch-db');
    // Empty, not left out: one exported in the shell would be named for a server it is not.
    expect(specs(null).bridge.env.OPENADLC_DATABASE_CONTAINER).toBe('');
  });
});

describe('openadlc down', () => {
  it('says a service whose pid file outlived it was not running, and does not fail for it', async () => {
    // After a reboot every service read as "would not stop (pid …)".
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { vi } = await import('vitest');
    const { runtimeDir } = await import('../install.js');
    const { down } = await import('./up.js');
    const scratch = mkdtempSync(join(tmpdir(), 'openadlc-down-'));
    const before = { home: process.env.OPENADLC_HOME, exitCode: process.exitCode };
    process.env.OPENADLC_HOME = scratch;
    const printed: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: string) => void printed.push(String(line)));
    try {
      writeFileSync(join(runtimeDir(), 'bridge.pid'), '999999');
      await down();

      expect(printed.join('\n')).toContain('bridge was not running (stale pid file removed)');
      expect(printed.join('\n')).not.toContain('would not stop');
      expect(process.exitCode).toBe(before.exitCode);
    } finally {
      log.mockRestore();
      if (before.home === undefined) delete process.env.OPENADLC_HOME;
      else process.env.OPENADLC_HOME = before.home;
      process.exitCode = before.exitCode;
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('the driver openadlc up runs with', () => {
  // A bare `up` ran every task as the operator's user, able to read the secret
  // store, and said only "Starting OpenADLC (local driver)".
  const probe = (dockerAnswers: boolean, botImagePresent: boolean) => ({
    dockerAnswers: async () => dockerAnswers,
    botImagePresent: async () => botImagePresent,
  });

  async function inHome<T>(install: object | null, body: () => Promise<T>): Promise<T> {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = mkdtempSync(join(tmpdir(), 'openadlc-driver-'));
    const before = process.env.OPENADLC_HOME;
    process.env.OPENADLC_HOME = home;
    try {
      if (install) writeFileSync(join(home, 'install.json'), JSON.stringify(install));
      return await body();
    } finally {
      if (before === undefined) delete process.env.OPENADLC_HOME;
      else process.env.OPENADLC_HOME = before;
      rmSync(home, { recursive: true, force: true });
    }
  }

  it('is docker for an install that names none, on a machine that can run it', async () => {
    const { upDriver } = await import('./up.js');
    const { defaultConfig } = await import('../install.js');
    const chosen = await inHome(null, () => upDriver(defaultConfig('/repo'), probe(true, true)));
    expect(chosen.config.driver).toBe('docker');
    expect(chosen.reason).toContain('bot image');
  });

  it('is the one install.json names, whatever the machine could run', async () => {
    const { upDriver } = await import('./up.js');
    const { defaultConfig } = await import('../install.js');
    const kept = await inHome({ driver: 'local' }, () => upDriver(defaultConfig('/repo'), probe(true, true)));
    expect(kept).toEqual({ config: defaultConfig('/repo') });
  });

  it('warns under local what a task can read and run, and how to switch, without failing', async () => {
    const { vi } = await import('vitest');
    const { sayDriver } = await import('./up.js');
    const printed: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: string) => void printed.push(String(line)));
    const exitCode = process.exitCode;
    try {
      sayDriver('local');
      expect(printed.join('\n')).toContain('the local driver runs each task as this user on this machine');
      expect(printed.join('\n')).toContain('private key');
      expect(printed.join('\n')).toContain('infra/local/build-bot-image.sh, then openadlc init --driver docker');
      expect(process.exitCode).toBe(exitCode);

      printed.length = 0;
      sayDriver('docker');
      expect(printed).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });
});

describe('what `openadlc up` says without a GitHub App client id', () => {
  it('gives the remedy doctor and auth login give, not `openadlc init`, which sets no client id', () => {
    expect(NO_CLIENT_ID_NOTE).not.toContain('openadlc init');
    expect(NO_CLIENT_ID_NOTE).toContain('create the app on the “Create the app” step of the console walkthrough, or set OPENADLC_GITHUB_CLIENT_ID');
  });
});

describe('whether up says there is no client id', () => {
  // up read install.json, then the settings, and never the environment the
  // rest of the CLI and the bridge read.
  it('looks where the rest of the CLI looks, the environment included', async () => {
    const before = process.env.OPENADLC_GITHUB_CLIENT_ID;
    try {
      process.env.OPENADLC_GITHUB_CLIENT_ID = 'Iv23liEnv';
      expect(await clientIdConfigured({ githubClientId: '' }, async () => null)).toBe(true);
      delete process.env.OPENADLC_GITHUB_CLIENT_ID;
      expect(await clientIdConfigured({ githubClientId: '' }, async () => 'Iv23liStored')).toBe(true);
      expect(await clientIdConfigured({ githubClientId: 'Iv23liFile' }, async () => null)).toBe(true);
      expect(await clientIdConfigured({ githubClientId: '' }, async () => null)).toBe(false);
    } finally {
      if (before === undefined) delete process.env.OPENADLC_GITHUB_CLIENT_ID;
      else process.env.OPENADLC_GITHUB_CLIENT_ID = before;
    }
  });
});

describe('what up prints about the console', () => {
  const ports = { console: 47300, bridge: 47311, hostd: 47312 };

  it('is a sign-in link for the person at the terminal', () => {
    expect(consoleLines('s3cret', ports, {})[0]).toMatch(/^console {3}http:\/\/127\.0\.0\.1:47300\/signin\?token=\d+\.[0-9a-f]{64}$/);
  });

  it('is the address alone when OpenADLC’s own update runs it, since that goes to a log', () => {
    const lines = consoleLines('s3cret', ports, { OPENADLC_NO_SIGN_IN_LINK: '1' });
    expect(lines[0]).toBe('console   http://127.0.0.1:47300 (openadlc console-link signs a browser in)');
    expect(lines.join('\n')).not.toContain('token=');
  });
});

describe('up after a restart onto a release stopped partway', () => {
  it('refuses for another install too, which runs from the same checkout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'up-applying-checkout-'));
    const was = process.env.OPENADLC_HOME;
    const printed: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: string) => void printed.push(String(line)));
    process.env.OPENADLC_HOME = join(root, 'scratch-home');
    try {
      const checkout = join(root, 'OpenADLC');
      mkdirSync(join(checkout, '.openadlc'), { recursive: true });
      writeFileSync(
        join(checkout, '.openadlc', 'applying.json'),
        JSON.stringify({ format: 1, tag: 'v0.2.0', from: 'a'.repeat(40), to: 'b'.repeat(40), checkout, step: 'merge', startedAt: 't' }),
      );
      process.exitCode = undefined;
      await up(defaultConfig(checkout), { probe: { dockerAnswers: async () => { throw new Error('up went on to the driver'); } } as never });
      expect(process.exitCode).toBe(1);
      expect(printed.join('\n')).toContain('stopped during merge');
    } finally {
      log.mockRestore();
      process.exitCode = undefined;
      if (was === undefined) delete process.env.OPENADLC_HOME;
      else process.env.OPENADLC_HOME = was;
      rmSync(root, { recursive: true, force: true });
    }
  });


  it('refuses, saying how to finish or go back, and starts nothing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'up-applying-'));
    const was = process.env.OPENADLC_HOME;
    const printed: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: string) => void printed.push(String(line)));
    process.env.OPENADLC_HOME = home;
    try {
      mkdirSync(join(home, 'run'));
      writeFileSync(
        join(home, 'run', 'self-update-applying.json'),
        JSON.stringify({ format: 1, tag: 'v0.2.0', from: 'a'.repeat(40), to: 'b'.repeat(40), checkout: '/Users/me/OpenADLC', step: 'output', startedAt: 't' }),
      );
      process.exitCode = undefined;
      await up(defaultConfig('/Users/me/OpenADLC'), { probe: { dockerAnswers: async () => { throw new Error('up went on to the driver'); } } as never });
      expect(process.exitCode).toBe(1);
      const said = printed.join('\n');
      expect(said).toContain('OpenADLC was restarting onto v0.2.0 and stopped during output');
      expect(said).toContain('git merge --ff-only ' + 'b'.repeat(40) + ' && pnpm install --frozen-lockfile && pnpm build');
      expect(said).toContain('git reset --keep ' + 'a'.repeat(40));
      expect(said).not.toContain('Starting OpenADLC');
    } finally {
      log.mockRestore();
      process.exitCode = undefined;
      if (was === undefined) delete process.env.OPENADLC_HOME;
      else process.env.OPENADLC_HOME = was;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
