import { describe, expect, it } from 'vitest';
import { defaultConfig, type InstallConfig } from '../install.js';
import {
  addressesInstallDatabase,
  bridgeDispatches,
  clientIdConfigured,
  COMPOSE_ONLY_BLANK,
  databaseName,
  databasePasswordStep,
  databaseRunArgs,
  dockerRunFailure,
  NO_CLIENT_ID_NOTE,
  rotateDatabasePassword,
} from './up.js';

const PUBLISHED_URL = 'postgres://fleetadlc:fleetadlc@127.0.0.1:47432/fleetadlc_db';
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
    expect(databaseName('postgres://fleetadlc:fleetadlc@127.0.0.1:47432/fleetadlc_db')).toBe('fleetadlc_db');
    expect(databaseName('postgres://u:p@host:5432/something_else')).toBe('something_else');
  });

  it('falls back rather than throwing on a url it cannot parse', () => {
    // A bad url is somebody else's error to report; this one still has to
    // return a name so the caller can say which database it meant.
    expect(databaseName('not a url')).toBe('fleetadlc_db');
    expect(databaseName('')).toBe('fleetadlc_db');
  });

  it('ignores a query string, which a hosted url usually carries', () => {
    expect(databaseName('postgres://u:p@host:5432/fleetadlc_db?sslmode=require')).toBe('fleetadlc_db');
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

describe('what a hostd `fleetadlc up` starts is told', () => {
  it('blanks the compose stack’s own settings, so a shell that exported them cannot aim this install at another', () => {
    expect(COMPOSE_ONLY_BLANK).toEqual({
      FLEETADLC_HOSTD_TASK_BRIDGE_URL: '',
      FLEETADLC_HOSTD_TASK_HOSTD_URL: '',
      FLEETADLC_RUNNER_BUNDLE: '',
      FLEETADLC_GH_SHIM_DIR: '',
    });
  });
});

describe('the container an install keeps its database in', () => {
  it('is fleetadlc-db for the default install, and named after any other', async () => {
    const { databaseContainer } = await import('./up.js');
    expect(databaseContainer({})).toBe('fleetadlc-db');
    expect(databaseContainer({ FLEETADLC_INSTALL_ID: 'default' })).toBe('fleetadlc-db');
    // A scratch install never starts or reuses the real install's container.
    expect(databaseContainer({ FLEETADLC_INSTALL_ID: 'scratch', FLEETADLC_BOT_PREFIX: 'scratch-' })).toBe('scratch-db');
    expect(databaseContainer({ FLEETADLC_INSTALL_ID: 'compose' })).toBe('compose-db');
  });

  // An install from before the rename keeps Postgres in `fleet-db`. After a
  // reboot `up` ran a new, empty `fleetadlc-db` on its port instead.
  const ports = { ports: { postgres: 47432 } } as const;
  const inspect = (containers: Record<string, string>) => async (name: string) => containers[name];

  it('is the upgraded install’s fleet-db when only it publishes the install’s port', async () => {
    const { existingDatabaseContainer } = await import('./up.js');
    expect(await existingDatabaseContainer(ports, {}, inspect({ 'fleet-db': '47432' }))).toBe('fleet-db');
  });

  it('stays fleetadlc-db when that exists, or when fleet-db is absent or on another port', async () => {
    const { existingDatabaseContainer } = await import('./up.js');
    expect(await existingDatabaseContainer(ports, {}, inspect({ 'fleetadlc-db': '47432', 'fleet-db': '47432' }))).toBe('fleetadlc-db');
    expect(await existingDatabaseContainer(ports, {}, inspect({}))).toBe('fleetadlc-db');
    expect(await existingDatabaseContainer(ports, {}, inspect({ 'fleet-db': '5432' }))).toBe('fleetadlc-db');
  });

  it('is never fleet-db for an install with an id of its own', async () => {
    const { existingDatabaseContainer } = await import('./up.js');
    const scratch = { FLEETADLC_INSTALL_ID: 'scratch', FLEETADLC_BOT_PREFIX: 'scratch-' };
    expect(await existingDatabaseContainer(ports, scratch, inspect({ 'fleet-db': '47432' }))).toBe('scratch-db');
  });
});

/**
 * The container `fleetadlc up` creates. It used to be given `fleetadlc` as its
 * password whatever `databaseUrl` said, and was published on every address,
 * where Docker's rules go around a host firewall.
 */
describe('what `fleetadlc up` says when docker run fails', () => {
  // Docker's words were thrown away, and `up` waited twenty seconds and said
  // to install Docker to someone whose port was simply taken.
  it('gives the first line Docker said, and names a port something else holds', () => {
    const said = dockerRunFailure(
      'docker: Error response from daemon: driver failed programming external connectivity on endpoint fleetadlc-db: Bind for 127.0.0.1:47432 failed: port is already allocated.\nRun \'docker run --help\' for more information\n',
      47432,
    );
    expect(said.reason).toBe(
      'docker: Error response from daemon: driver failed programming external connectivity on endpoint fleetadlc-db: Bind for 127.0.0.1:47432 failed: port is already allocated.',
    );
    expect(said.note).toContain('port 47432 is taken by something else');
  });

  it('adds nothing about a port when the port is not the trouble', () => {
    expect(dockerRunFailure('Unable to find image locally\npull access denied', 47432)).toEqual({ reason: 'Unable to find image locally', note: null });
  });
});

describe('the database container `fleetadlc up` creates', () => {
  it('is published on loopback only', () => {
    const { args } = databaseRunArgs('fleetadlc-db', defaultConfig('/repo'));
    expect(args).toContain('127.0.0.1:47432:5432');
    expect(args.join(' ')).toContain('-p 127.0.0.1:47432:5432');
  });

  it('takes user, password and database from the url, and keeps the password out of its arguments', () => {
    const config = { ...defaultConfig('/repo'), databaseUrl: `postgres://app:${OWN_PASSWORD}@127.0.0.1:47432/the_db` };
    const { args, env } = databaseRunArgs('fleetadlc-db', config);

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
    expect(databaseRunArgs('fleetadlc-db', defaultConfig('/repo')).args.join(' ')).toContain('-v fleetadlc-db-data:/var/lib/postgresql/data');
    expect(databaseRunArgs('scratch-db', defaultConfig('/repo')).args.join(' ')).toContain('-v scratch-db-data:/var/lib/postgresql/data');
  });

  it('refuses a url it cannot read, rather than creating a database without a password', () => {
    expect(() => databaseRunArgs('fleetadlc-db', { ...defaultConfig('/repo'), databaseUrl: 'not a url' })).toThrow(
      /databaseUrl in .*install\.json is not a postgres url/,
    );
  });
});

describe('what `fleetadlc up` does about the published database password', () => {
  const step = (input: Partial<Parameters<typeof databasePasswordStep>[0]>) =>
    databasePasswordStep({ databaseUrl: PUBLISHED_URL, port: 47432, published: undefined, connection: 'nothing', ...input });

  it('generates one for a new install, before its container exists', () => {
    expect(step({})).toBe('generate');
  });

  it('rotates it on the install’s own container once it answers, so the data stays', () => {
    expect(step({ published: '47432', connection: 'answers' })).toBe('rotate');
    // An install from before the rename: user and password both `fleet`, on fleet-db.
    expect(step({ databaseUrl: 'postgres://fleet:fleet@127.0.0.1:47432/fleet_db', published: '47432', connection: 'answers' })).toBe('rotate');
    // Stopped: started first, then rotated.
    expect(step({ published: '47432', connection: 'nothing' })).toBe('keep');
  });

  it('leaves a database it does not own alone', () => {
    // tests/scratch.sh starts fleetadlc-scratch-db itself, with the published
    // password, and hands that url to the integration suites.
    expect(step({ databaseUrl: 'postgres://fleetadlc:fleetadlc@127.0.0.1:57432/fleetadlc_db', port: 57432, connection: 'answers' })).toBe('keep');
    // A server on the port that is not the install's container.
    expect(step({ connection: 'answers' })).toBe('keep');
    expect(step({ connection: 'refused' })).toBe('keep');
    // A container of this name on another port.
    expect(step({ published: '5432', connection: 'answers' })).toBe('keep');
    // An external server.
    expect(step({ databaseUrl: 'postgres://fleetadlc:fleetadlc@db.internal:47432/fleetadlc_db', published: '47432', connection: 'answers' })).toBe('keep');
  });

  it('does nothing to a password the install already has', () => {
    const databaseUrl = `postgres://fleetadlc:${OWN_PASSWORD}@127.0.0.1:47432/fleetadlc_db`;
    expect(step({ databaseUrl })).toBe('keep');
    expect(step({ databaseUrl, published: '47432', connection: 'answers' })).toBe('keep');
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
  function fake(options: { failSave?: boolean; failAlter?: boolean } = {}) {
    const events: string[] = [];
    const saved: InstallConfig[] = [];
    return {
      events,
      saved,
      deps: {
        connect: async (url: string) => {
          events.push(`connect ${url}`);
          return {
            query: async (text: string) => {
              events.push(text);
              if (options.failAlter) throw new Error(`syntax error at or near "${text}"`);
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

  it('alters the pre-rename role the same way', async () => {
    const published = 'postgres://fleet:fleet@127.0.0.1:47432/fleet_db';
    const config = { ...defaultConfig('/repo'), databaseUrl: published };
    const { events, deps } = fake();

    const next = await rotateDatabasePassword(config, { ...deps, env: {} });

    const password = new URL(next.databaseUrl).password;
    expect(events[1]).toBe(`alter role "fleet" password '${password}'`);
    expect(new URL(next.databaseUrl).username).toBe('fleet');
    expect(password).toMatch(/^[0-9a-f]{64}$/);
  });

  it('alters the role over the old url, saves the new url straight after, and hands it on', async () => {
    const config = defaultConfig('/repo');
    const env: NodeJS.ProcessEnv = { DATABASE_URL: PUBLISHED_URL };
    const { events, saved, deps } = fake();

    const next = await rotateDatabasePassword(config, { ...deps, env });

    const password = new URL(next.databaseUrl).password;
    expect(password).toMatch(/^[0-9a-f]{64}$/);
    expect(events).toEqual([`connect ${PUBLISHED_URL}`, `alter role "fleetadlc" password '${password}'`, 'save', 'end']);
    expect(saved).toEqual([next]);
    // This process's pool, and every service up starts, connect with it.
    expect(env.DATABASE_URL).toBe(next.databaseUrl);
    expect(next).toEqual({ ...config, databaseUrl: `postgres://fleetadlc:${password}@127.0.0.1:47432/fleetadlc_db` });
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
    expect(events.at(-2)).toBe(`alter role "fleetadlc" password 'fleetadlc'`);
    expect(env.DATABASE_URL).toBe(PUBLISHED_URL);
  });

  it('keeps the new password out of an error', async () => {
    const { deps } = fake({ failAlter: true });
    const error = (await rotateDatabasePassword(defaultConfig('/repo'), { ...deps, env: {} }).catch((caught: Error) => caught)) as Error;
    expect(error.message).toContain('***');
    expect(error.message).not.toMatch(/[0-9a-f]{64}/);
  });

  it('refuses a role name it would have to quote', async () => {
    const { events, deps } = fake();
    const config = { ...defaultConfig('/repo'), databaseUrl: 'postgres://a%22b:fleetadlc@127.0.0.1:47432/fleetadlc_db' };
    await expect(rotateDatabasePassword(config, { ...deps, env: {} })).rejects.toThrow(/plain role/);
    expect(events).toEqual([]);
  });
});

/**
 * The console secret is what the bridge serves `/v1` for. hostd is started
 * with `serviceEnv`, and a bot's session is started by hostd, so it goes to
 * the console and nowhere else.
 */
describe('what `fleetadlc up` starts each service with', () => {
  it('gives the console secret to the console alone', async () => {
    const { serviceSpecs } = await import('./up.js');
    const { defaultConfig, serviceEnv } = await import('../install.js');
    const config = defaultConfig('/repo');
    const env = serviceEnv(config);
    const specs = serviceSpecs(config, env, { consoleSecret: 'c'.repeat(64), scripted: false, node: 'node' });

    expect(specs.console.env.FLEETADLC_CONSOLE_SECRET).toBe('c'.repeat(64));
    expect(specs.hostd.env).not.toHaveProperty('FLEETADLC_CONSOLE_SECRET');
    expect(specs.bridge.env).not.toHaveProperty('FLEETADLC_CONSOLE_SECRET');
    expect(env).not.toHaveProperty('FLEETADLC_CONSOLE_SECRET');
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
});

describe('fleetadlc down', () => {
  it('says a service whose pid file outlived it was not running, and does not fail for it', async () => {
    // After a reboot every service read as "would not stop (pid …)".
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { vi } = await import('vitest');
    const { runtimeDir } = await import('../install.js');
    const { down } = await import('./up.js');
    const scratch = mkdtempSync(join(tmpdir(), 'fleetadlc-down-'));
    const before = { home: process.env.FLEETADLC_HOME, exitCode: process.exitCode };
    process.env.FLEETADLC_HOME = scratch;
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
      if (before.home === undefined) delete process.env.FLEETADLC_HOME;
      else process.env.FLEETADLC_HOME = before.home;
      process.exitCode = before.exitCode;
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('the driver fleetadlc up runs with', () => {
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
    const home = mkdtempSync(join(tmpdir(), 'fleetadlc-driver-'));
    const before = process.env.FLEETADLC_HOME;
    process.env.FLEETADLC_HOME = home;
    try {
      if (install) writeFileSync(join(home, 'install.json'), JSON.stringify(install));
      return await body();
    } finally {
      if (before === undefined) delete process.env.FLEETADLC_HOME;
      else process.env.FLEETADLC_HOME = before;
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
      expect(printed.join('\n')).toContain('infra/local/build-bot-image.sh, then fleetadlc init --driver docker');
      expect(process.exitCode).toBe(exitCode);

      printed.length = 0;
      sayDriver('docker');
      expect(printed).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });
});

describe('what `fleetadlc up` says without a GitHub App client id', () => {
  it('gives the remedy doctor and auth login give, not `fleetadlc init`, which sets no client id', () => {
    expect(NO_CLIENT_ID_NOTE).not.toContain('fleetadlc init');
    expect(NO_CLIENT_ID_NOTE).toContain('create the app on the “Create the app” step of the console walkthrough, or set FLEETADLC_GITHUB_CLIENT_ID');
  });
});

describe('whether up says there is no client id', () => {
  // up read install.json, then the settings, and never the environment the
  // rest of the CLI and the bridge read.
  it('looks where the rest of the CLI looks, the environment included', async () => {
    const before = process.env.FLEETADLC_GITHUB_CLIENT_ID;
    try {
      process.env.FLEETADLC_GITHUB_CLIENT_ID = 'Iv23liEnv';
      expect(await clientIdConfigured({ githubClientId: '' }, async () => null)).toBe(true);
      delete process.env.FLEETADLC_GITHUB_CLIENT_ID;
      expect(await clientIdConfigured({ githubClientId: '' }, async () => 'Iv23liStored')).toBe(true);
      expect(await clientIdConfigured({ githubClientId: 'Iv23liFile' }, async () => null)).toBe(true);
      expect(await clientIdConfigured({ githubClientId: '' }, async () => null)).toBe(false);
    } finally {
      if (before === undefined) delete process.env.FLEETADLC_GITHUB_CLIENT_ID;
      else process.env.FLEETADLC_GITHUB_CLIENT_ID = before;
    }
  });
});
