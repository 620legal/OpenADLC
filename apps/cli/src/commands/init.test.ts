import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSecretStore, webhookSecretRef } from '@openadlc/github';
import { init } from './init.js';

/**
 * What `openadlc init` does to the database and the install file.
 *
 * The store is a fake that records which database each call would have reached:
 * the pool is opened from DATABASE_URL on first use, so that is what a call
 * made at that moment talks to. OPENADLC_HOME is a temporary directory and `fetch`
 * refuses, so nothing here reads or writes a real install or reaches its ports.
 */
const calls = vi.hoisted(() => ({
  stored: null as string | null,
  reads: [] as string[],
  writes: [] as { database: string; value: string }[],
}));

/** The secret store, in memory. */
let secrets: Record<string, string> = {};

vi.mock('@openadlc/db', () => ({
  closePool: vi.fn(async () => undefined),
  settings: {
    getSetting: vi.fn(async () => {
      calls.reads.push(process.env.DATABASE_URL ?? '');
      return calls.stored;
    }),
    setSetting: vi.fn(async (_key: string, value: string) => {
      calls.writes.push({ database: process.env.DATABASE_URL ?? '', value });
    }),
  },
}));

const OLD_DATABASE = 'postgres://openadlc:openadlc@127.0.0.1:1/the_old_one';
const NEW_DATABASE = 'postgres://openadlc:openadlc@127.0.0.1:1/the_new_one';

/** What `chooseDriver` asks of the machine, answered without Docker. */
function probe(dockerAnswers: boolean, botImagePresent: boolean) {
  return { dockerAnswers: async () => dockerAnswers, botImagePresent: async () => botImagePresent };
}
const NO_DOCKER = probe(false, false);

let home: string;
const saved: Record<string, string | undefined> = {};

function installFile(): { webhookSecret: string; databaseUrl: string } {
  return JSON.parse(readFileSync(join(home, 'install.json'), 'utf8'));
}

beforeEach(() => {
  for (const key of ['OPENADLC_HOME', 'DATABASE_URL', 'OPENADLC_WEBHOOK_SECRET']) saved[key] = process.env[key];
  home = mkdtempSync(join(tmpdir(), 'openadlc-init-'));
  process.env.OPENADLC_HOME = home;
  // What `main` does before `init` runs: fills DATABASE_URL from the install file.
  process.env.DATABASE_URL = OLD_DATABASE;
  delete process.env.OPENADLC_WEBHOOK_SECRET;

  calls.stored = null;
  calls.reads.length = 0;
  calls.writes.length = 0;
  secrets = {};
  setSecretStore({
    get: async (ref) => secrets[ref] ?? null,
    set: async (ref, value) => {
      secrets[ref] = value;
    },
    delete: async (ref) => {
      delete secrets[ref];
    },
    list: async () => Object.keys(secrets),
  });
  vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('no console in a unit test'))));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

describe('openadlc init and a webhook secret set in the environment', () => {
  it('keeps that one, and does not store a different one in the database', async () => {
    // The self-hosting guide: the value on the GitHub App goes in
    // OPENADLC_WEBHOOK_SECRET. A secret generated here and stored in the database
    // would win over it in the bridge, and GitHub's deliveries would all be refused.
    process.env.OPENADLC_WEBHOOK_SECRET = 'the-one-github-has';

    await init('/tmp/openadlc-repo', {}, NO_DOCKER);

    expect(installFile().webhookSecret).toBe('the-one-github-has');
    expect(calls.writes).toEqual([]);
    expect(secrets).toEqual({});
  });
});

describe('openadlc init and a webhook secret it generates', () => {
  it('keeps it in the secret store, never in the settings table', async () => {
    await init('/tmp/openadlc-repo', {}, NO_DOCKER);

    expect(secrets[webhookSecretRef()]).toMatch(/^[0-9a-f]{64}$/);
    expect(installFile().webhookSecret).toBe(secrets[webhookSecretRef()]);
    expect(calls.writes).toEqual([]);
  });

  it('keeps the one the secret store already has', async () => {
    secrets[webhookSecretRef()] = 'zzz-in-the-store-zzz';

    await init('/tmp/openadlc-repo', {}, NO_DOCKER);

    expect(installFile().webhookSecret).toBe('zzz-in-the-store-zzz');
    expect(calls.writes).toEqual([]);
  });
});

describe('openadlc init --database-url', () => {
  it('looks an older install’s secret up in the database it was given', async () => {
    await init('/tmp/openadlc-repo', { databaseUrl: NEW_DATABASE }, NO_DOCKER);

    expect(calls.reads).toEqual([NEW_DATABASE]);
    expect(calls.writes).toEqual([]);
    expect(installFile().databaseUrl).toBe(NEW_DATABASE);
    expect(installFile().webhookSecret).toBe(secrets[webhookSecretRef()]);
  });
});

describe('openadlc init and the driver', () => {
  // Every new install got `local`, where a task runs as the operator's user
  // and can read the secret store, and nothing said so.
  function driverIn(): string | undefined {
    return (JSON.parse(readFileSync(join(home, 'install.json'), 'utf8')) as { driver?: string }).driver;
  }
  function printed(): string {
    return vi.mocked(console.log).mock.calls.map((call) => String(call[0])).join('\n');
  }

  it('writes docker for a new install where Docker answers and the bot image is built, and says why', async () => {
    await init('/tmp/openadlc-repo', {}, probe(true, true));
    expect(driverIn()).toBe('docker');
    expect(printed()).toContain('driver: docker, because Docker answers and the bot image');
    expect(printed()).toContain('with the docker driver');
  });

  it('writes local when Docker or the bot image is missing, and says what a task can then reach', async () => {
    await init('/tmp/openadlc-repo', {}, probe(true, false));
    expect(driverIn()).toBe('local');
    expect(printed()).toContain('the bot image');
    expect(printed()).toContain('can read the secret store');
    rmSync(join(home, 'install.json'));

    await init('/tmp/openadlc-repo', {}, probe(false, true));
    expect(driverIn()).toBe('local');
    expect(printed()).toContain('Docker is not answering');
  });

  it('never changes a driver install.json already names', async () => {
    writeFileSync(join(home, 'install.json'), JSON.stringify({ driver: 'local', webhookSecret: 'kept' }));
    await init('/tmp/openadlc-repo', {}, probe(true, true));
    expect(driverIn()).toBe('local');
  });

  it('still takes --driver local on a machine that could run docker', async () => {
    await init('/tmp/openadlc-repo', { driver: 'local' }, probe(true, true));
    expect(driverIn()).toBe('local');
  });
});
