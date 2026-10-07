import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  allowedHostsOf,
  chooseDriver,
  databaseConflictMessage,
  databaseCredentials,
  databaseUrlConflict,
  defaultConfig,
  driverOf,
  ensureDatabasePassword,
  ensureWebhookSecret,
  loadConfig,
  maskDatabaseUrl,
  serviceEnv,
  settleWebhookSecret,
  storedDriver,
} from './install.js';

describe('a webhook secret for a new install', () => {
  it('generates one when the install has none', () => {
    const first = ensureWebhookSecret(defaultConfig('/tmp/fleetadlc'));
    const second = ensureWebhookSecret(defaultConfig('/tmp/fleetadlc'));

    expect(first.generated).toBe(true);
    expect(first.config.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    // Two installs do not share a key.
    expect(second.config.webhookSecret).not.toBe(first.config.webhookSecret);
  });

  it('keeps an existing one', () => {
    const config = { ...defaultConfig('/tmp/fleetadlc'), webhookSecret: 'already-set' };
    const next = ensureWebhookSecret(config);

    expect(next.generated).toBe(false);
    expect(next.config).toBe(config);
    expect(next.config.webhookSecret).toBe('already-set');
  });
});

/**
 * Every install's platform database took `fleetadlc`/`fleetadlc`, a password
 * printed in this repository, as its superuser — from the LAN, and from any
 * task's computer through `host.docker.internal`.
 */
describe('a database password for an install', () => {
  it('replaces the published one with one of the install’s own', () => {
    const fresh = defaultConfig('/tmp/fleetadlc');
    const first = ensureDatabasePassword(fresh);
    const second = ensureDatabasePassword(fresh);

    expect(first.generated).toBe(true);
    expect(databaseCredentials(first.config.databaseUrl)?.password).toMatch(/^[0-9a-f]{64}$/);
    // Two installs, or two calls, never share one.
    expect(second.config.databaseUrl).not.toBe(first.config.databaseUrl);
    // Only the password changes.
    expect(first.config.databaseUrl).toMatch(/^postgres:\/\/fleetadlc:[0-9a-f]{64}@127\.0\.0\.1:47432\/fleetadlc_db$/);
    expect(fresh.databaseUrl).toBe('postgres://fleetadlc:fleetadlc@127.0.0.1:47432/fleetadlc_db');
  });

  it('replaces the superuser from before the rename the same way', () => {
    const config = { ...defaultConfig('/tmp/fleetadlc'), databaseUrl: 'postgres://fleet:fleet@127.0.0.1:47432/fleet_db' };
    const next = ensureDatabasePassword(config);
    expect(next.generated).toBe(true);
    expect(databaseCredentials(next.config.databaseUrl)?.user).toBe('fleet');
    expect(databaseCredentials(next.config.databaseUrl)?.password).toMatch(/^[0-9a-f]{64}$/);
    expect(databaseCredentials(next.config.databaseUrl)?.database).toBe('fleet_db');
    // A cloud database keeps the user `fleet` and a password of its own.
    const cloud = { ...config, databaseUrl: 'postgres://fleet:0123abcd@10.0.0.5:5432/fleet_db' };
    expect(ensureDatabasePassword(cloud).generated).toBe(false);
  });

  it('keeps any other password, an external server’s included', () => {
    for (const databaseUrl of [
      'postgres://fleetadlc:0123abcd@127.0.0.1:47432/fleetadlc_db',
      'postgres://app:s3cret@db.internal:5432/fleetadlc_db?sslmode=require',
    ]) {
      const config = { ...defaultConfig('/tmp/fleetadlc'), databaseUrl };
      const next = ensureDatabasePassword(config);
      expect(next.generated).toBe(false);
      expect(next.config).toBe(config);
    }
  });

  it('reads a password that needed escaping in the url', () => {
    expect(databaseCredentials('postgres://app:p%40ss@host:5432/the_db')).toEqual({ user: 'app', password: 'p@ss', database: 'the_db' });
    expect(databaseCredentials('not a url')).toBeNull();
  });
});

/**
 * Which secret `fleetadlc init` keeps.
 *
 * An operator who followed the self-hosting guide gave GitHub a secret and put
 * the same value in FLEETADLC_WEBHOOK_SECRET. Onboarding then saw nothing in the
 * install file or the database, generated another, and stored it in the
 * database, which the bridge prefers to its environment — so every real
 * delivery was refused.
 */
describe('settling on a webhook secret', () => {
  function sources(input: { environment?: string; stored?: string | null; unreachable?: boolean }) {
    const written: string[] = [];
    return {
      written,
      from: {
        environment: input.environment,
        stored: async () => {
          if (input.unreachable) throw new Error('connect ECONNREFUSED');
          return input.stored ?? null;
        },
        store: async (secret: string) => {
          written.push(secret);
        },
      },
    };
  }

  it('keeps the one in the environment, and writes nothing to the database', async () => {
    const { written, from } = sources({ environment: 'the-one-github-has' });

    const settled = await settleWebhookSecret(defaultConfig('/tmp/fleetadlc'), from);

    expect(settled.source).toBe('environment');
    expect(settled.config.webhookSecret).toBe('the-one-github-has');
    expect(written).toEqual([]);
  });

  it('prefers a stored one to the environment, because the bridge does', async () => {
    const { written, from } = sources({ environment: 'from-the-shell', stored: 'from-the-console' });

    const settled = await settleWebhookSecret(defaultConfig('/tmp/fleetadlc'), from);

    expect(settled.source).toBe('stored');
    expect(settled.config.webhookSecret).toBe('from-the-console');
    expect(written).toEqual([]);
  });

  it('keeps the one in the install file without asking anything else', async () => {
    const { written, from } = sources({ environment: 'other', stored: 'another' });
    const config = { ...defaultConfig('/tmp/fleetadlc'), webhookSecret: 'already-set' };

    const settled = await settleWebhookSecret(config, from);

    expect(settled).toEqual({ config, source: 'install' });
    expect(written).toEqual([]);
  });

  it('generates and stores one only when there is none anywhere', async () => {
    const { written, from } = sources({ environment: '' });

    const settled = await settleWebhookSecret(defaultConfig('/tmp/fleetadlc'), from);

    expect(settled.source).toBe('generated');
    expect(settled.config.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(written).toEqual([settled.config.webhookSecret]);
  });

  it('still uses the environment when the database cannot be read', async () => {
    const { written, from } = sources({ environment: 'the-one-github-has', unreachable: true });

    const settled = await settleWebhookSecret(defaultConfig('/tmp/fleetadlc'), from);

    expect(settled.config.webhookSecret).toBe('the-one-github-has');
    expect(written).toEqual([]);
  });
});

describe('which bot is the automation account', () => {
  it('is left to the bridge, which finds it by role, unless the install names one', () => {
    // Every install.json used to say `flow`, and every service was started
    // with FLEETADLC_AUTOMATION_BOT=flow — a name that is nobody once the seat
    // takes its account's handle.
    const fresh = defaultConfig('/repo');
    expect(fresh).not.toHaveProperty('automationBotName');
    expect(serviceEnv(fresh)).not.toHaveProperty('FLEETADLC_AUTOMATION_BOT');

    expect(serviceEnv({ ...fresh, automationBotName: 'automation' }).FLEETADLC_AUTOMATION_BOT).toBe('automation');
  });
});

describe('the names an install is opened under', () => {
  it('are handed to every service from install.json, and nothing is set when it lists none', () => {
    const fresh = defaultConfig('/repo');
    expect(serviceEnv(fresh)).not.toHaveProperty('FLEETADLC_ALLOWED_HOSTS');

    expect(serviceEnv({ ...fresh, allowedHosts: ['mybox.lan', 'fleetadlc.tailnet.ts.net'] }).FLEETADLC_ALLOWED_HOSTS).toBe(
      'mybox.lan,fleetadlc.tailnet.ts.net',
    );
  });

  it('takes a single name written as a string, and refuses anything else with what to write', () => {
    const fresh = defaultConfig('/repo');
    expect(serviceEnv({ ...fresh, allowedHosts: 'mybox.lan' as never }).FLEETADLC_ALLOWED_HOSTS).toBe('mybox.lan');
    expect(() => allowedHostsOf({ allowedHosts: 5 as never })).toThrow(/must be a list of names, e\.g\. "allowedHosts": \["mybox\.lan"\]/);
  });
});

describe('the driver an install names', () => {
  it('is docker or local, whatever the case and spacing of a hand-edited file', () => {
    expect(driverOf({ driver: 'docker' })).toBe('docker');
    expect(driverOf({ driver: ' Docker ' as never })).toBe('docker');
    expect(driverOf({ driver: 'local' })).toBe('local');
  });

  it('refuses anything else and says what to write, rather than running sessions with no isolation', () => {
    expect(() => driverOf({ driver: 'dokcer' as never })).toThrow(/"driver" in .*install\.json is "dokcer"; write "driver": "docker" or "driver": "local"/);
    expect(() => driverOf({ driver: undefined as never })).toThrow(/write "driver": "docker"/);
  });
});

describe('what install.json leaves to the environment', () => {
  it('sets the organization, client id, public address and humans only when it has them', () => {
    // `fleetadlc github` tells an operator to export FLEETADLC_HUMANS; an empty
    // value from install.json replaced it, and the bridge saw nobody.
    const fresh = defaultConfig('/repo');
    const env = serviceEnv(fresh);
    for (const key of ['FLEETADLC_GITHUB_ORG', 'FLEETADLC_GITHUB_CLIENT_ID', 'FLEETADLC_PUBLIC_URL', 'FLEETADLC_HUMANS']) {
      expect(env).not.toHaveProperty(key);
    }

    const set = serviceEnv({ ...fresh, organization: 'exampleco', githubClientId: 'Iv1.zzz', publicUrl: 'https://fleet.example.test', humans: ['alex', 'sam'] });
    expect(set).toMatchObject({
      FLEETADLC_GITHUB_ORG: 'exampleco',
      FLEETADLC_GITHUB_CLIENT_ID: 'Iv1.zzz',
      FLEETADLC_PUBLIC_URL: 'https://fleet.example.test',
      FLEETADLC_HUMANS: 'alex,sam',
    });
  });
});

describe('the install folder', () => {
  it('is made its owner’s alone, and one made open before is closed', async () => {
    const { chmodSync, mkdtempSync, rmSync, statSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { homeIsOpen, makeHomePrivate, runtimeDir } = await import('./install.js');
    const scratch = mkdtempSync(join(tmpdir(), 'fleetadlc-home-'));
    const before = process.env.FLEETADLC_HOME;
    process.env.FLEETADLC_HOME = join(scratch, 'home');
    try {
      expect(homeIsOpen()).toBeNull();
      const run = runtimeDir();
      expect(statSync(join(scratch, 'home')).mode & 0o777).toBe(0o700);
      expect(statSync(run).mode & 0o777).toBe(0o700);

      chmodSync(join(scratch, 'home'), 0o755);
      expect(homeIsOpen()).toBe(true);
      expect(makeHomePrivate()).toBe(true);
      expect(statSync(join(scratch, 'home')).mode & 0o777).toBe(0o700);
      expect(makeHomePrivate()).toBe(false);
    } finally {
      if (before === undefined) delete process.env.FLEETADLC_HOME;
      else process.env.FLEETADLC_HOME = before;
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

/**
 * Every new install ran tasks with the local driver, as the operator's user
 * and able to read the secret store, without anyone choosing it.
 */
describe('the driver for an install that names none', () => {
  const probe = (dockerAnswers: boolean, botImagePresent: boolean) => ({
    dockerAnswers: async () => dockerAnswers,
    botImagePresent: async () => botImagePresent,
  });

  it('is docker when Docker answers and the bot image is here', async () => {
    expect(await chooseDriver(probe(true, true))).toMatchObject({ driver: 'docker' });
  });

  it('is local when Docker does not answer, or the bot image is missing, and says which', async () => {
    expect(await chooseDriver(probe(false, true))).toMatchObject({ driver: 'local', reason: expect.stringContaining('Docker is not answering') });
    expect(await chooseDriver(probe(true, false))).toMatchObject({ driver: 'local', reason: expect.stringContaining('bot image') });
  });

  it('is told from one install.json names, which a missing key no longer looks like', () => {
    const home = mkdtempSync(join(tmpdir(), 'fleetadlc-driver-'));
    const before = process.env.FLEETADLC_HOME;
    process.env.FLEETADLC_HOME = home;
    try {
      expect(storedDriver()).toBeUndefined();
      writeFileSync(join(home, 'install.json'), JSON.stringify({ organization: 'exampleco' }));
      expect(storedDriver()).toBeUndefined();
      writeFileSync(join(home, 'install.json'), JSON.stringify({ driver: 'local' }));
      expect(storedDriver()).toBe('local');
      writeFileSync(join(home, 'install.json'), JSON.stringify({ driver: 'Docker' }));
      expect(storedDriver()).toBe('docker');
    } finally {
      if (before === undefined) delete process.env.FLEETADLC_HOME;
      else process.env.FLEETADLC_HOME = before;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

/**
 * install.json is edited by hand. Merged one level deep and never checked,
 * `"ports": {"console": 3001}` left the bridge at port undefined, and
 * `"humans": "alice"` made every command die on `.join`.
 */
describe('a hand-edited install.json', () => {
  const load = (file: unknown) => {
    const home = mkdtempSync(join(tmpdir(), 'fleetadlc-load-'));
    const before = process.env.FLEETADLC_HOME;
    process.env.FLEETADLC_HOME = home;
    try {
      writeFileSync(join(home, 'install.json'), JSON.stringify(file));
      return loadConfig('/tmp/fleetadlc');
    } finally {
      if (before === undefined) delete process.env.FLEETADLC_HOME;
      else process.env.FLEETADLC_HOME = before;
      rmSync(home, { recursive: true, force: true });
    }
  };

  it('keeps the default for each port it does not name', () => {
    const config = load({ ports: { console: 3001 } });
    expect(config.ports).toEqual({ console: 3001, bridge: 47311, hostd: 47312, postgres: 47432 });
    expect(Object.values(serviceEnv(config)).join(' ')).not.toContain('undefined');
  });

  it('points the default database at the postgres port it names, and keeps a url it writes', () => {
    expect(load({ ports: { postgres: 58432 } }).databaseUrl).toContain('127.0.0.1:58432/');
    const written = 'postgres://u:p@db.example.com:5432/fleetadlc_db';
    expect(load({ ports: { postgres: 58432 }, databaseUrl: written }).databaseUrl).toBe(written);
  });

  it('names the file, and what to do, when it is not JSON', () => {
    // A trailing comma stopped every command with JSON.parse's words alone.
    const home = mkdtempSync(join(tmpdir(), 'fleetadlc-load-'));
    const before = process.env.FLEETADLC_HOME;
    process.env.FLEETADLC_HOME = home;
    try {
      writeFileSync(join(home, 'install.json'), '{"driver": "local",}');
      expect(() => loadConfig('/tmp/fleetadlc')).toThrow(`${join(home, 'install.json')} is not valid JSON`);
      expect(() => loadConfig('/tmp/fleetadlc')).toThrow('fix it, or move it aside');
      expect(() => storedDriver()).toThrow(`${join(home, 'install.json')} is not valid JSON`);
    } finally {
      if (before === undefined) delete process.env.FLEETADLC_HOME;
      else process.env.FLEETADLC_HOME = before;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('takes humans written as one string', () => {
    const config = load({ humans: 'alice' });
    expect(config.humans).toEqual(['alice']);
    expect(serviceEnv(config).FLEETADLC_HUMANS).toBe('alice');
    expect(load({ humans: 'alice, bob' }).humans).toEqual(['alice', 'bob']);
  });

  it('reads a null string as its default', async () => {
    const config = load({ webhookSecret: null, organization: null });
    expect(config.webhookSecret).toBe('');
    expect(config.organization).toBe('');
    expect(ensureWebhookSecret(config).generated).toBe(true);
    const settled = await settleWebhookSecret(config, {
      environment: undefined,
      stored: async () => null,
      store: async () => undefined,
    });
    expect(settled.source).toBe('generated');
  });

  it('refuses a value it cannot use, naming the key and the file', () => {
    expect(() => load({ ports: { bridge: 'abc' } })).toThrow(/ports\.bridge.*install\.json/);
    expect(() => load({ ports: { hostd: 70000 } })).toThrow(/ports\.hostd/);
    expect(() => load({ ports: 3001 })).toThrow(/"ports"/);
    expect(() => load({ humans: 7 })).toThrow(/"humans" in .*install\.json/);
    expect(() => load({ driver: 'vm' })).toThrow(/"driver"/);
  });
});

describe('a DATABASE_URL exported beside install.json', () => {
  // main fills only what the shell has not set, so a stale export beat
  // install.json for the commands that open the database themselves, while
  // `up` gave the services install.json's: a restore wrote to two databases.
  const install = { databaseUrl: 'postgres://fleetadlc:install-secret@127.0.0.1:47432/fleetadlc_db' };
  const scratch = 'postgres://fleetadlc:scratch-secret@127.0.0.1:58432/fleetadlc_db';

  it('is a conflict when it differs, named with both passwords masked', () => {
    const conflict = databaseUrlConflict(install, { DATABASE_URL: scratch });
    expect(conflict).toEqual({
      shell: 'postgres://fleetadlc:***@127.0.0.1:58432/fleetadlc_db',
      install: 'postgres://fleetadlc:***@127.0.0.1:47432/fleetadlc_db',
    });
    const message = databaseConflictMessage(conflict!, '/home/ada/.fleetadlc');
    expect(message).toBe(
      'DATABASE_URL in this shell is postgres://fleetadlc:***@127.0.0.1:58432/fleetadlc_db, but the install at /home/ada/.fleetadlc uses postgres://fleetadlc:***@127.0.0.1:47432/fleetadlc_db. Run: unset DATABASE_URL',
    );
    expect(message).not.toMatch(/secret/);
  });

  it('is none when they match or nothing is exported', () => {
    expect(databaseUrlConflict(install, { DATABASE_URL: install.databaseUrl })).toBeNull();
    expect(databaseUrlConflict(install, {})).toBeNull();
    expect(databaseUrlConflict(install, { DATABASE_URL: '' })).toBeNull();
  });

  it('is none without install.json, where the compose stack and the cloud host set it', () => {
    expect(databaseUrlConflict(null, { DATABASE_URL: scratch })).toBeNull();
  });

  it('masks a password with an @ in it, or given as a parameter', () => {
    expect(maskDatabaseUrl('postgres://u:p%40ss@db:5432/x')).toBe('postgres://u:***@db:5432/x');
    expect(maskDatabaseUrl('postgres://u@db/x?password=hunter2')).toBe('postgres://u@db/x?password=***');
    expect(maskDatabaseUrl('not a url hunter2')).not.toContain('hunter2');
  });
});
