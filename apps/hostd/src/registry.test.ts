import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registryTokenRef, type SecretStore } from '@fleetadlc/github';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isRefusal, RegistryCredentials, REGISTRY_TOKEN_MAX_AGE_SECONDS } from './registry.js';

class FakeStore implements SecretStore {
  private readonly values = new Map<string, string>();
  async get(ref: string): Promise<string | null> {
    return this.values.get(ref) ?? null;
  }
  async set(ref: string, value: string): Promise<void> {
    this.values.set(ref, value);
  }
  async delete(ref: string): Promise<void> {
    this.values.delete(ref);
  }
  async list(prefix = ''): Promise<string[]> {
    return [...this.values.keys()].filter((ref) => ref.startsWith(prefix)).sort();
  }
}

let store: FakeStore;

beforeEach(() => {
  store = new FakeStore();
});

describe('the credential a task installs with', () => {
  it('names the registry it is good for, not just the token', async () => {
    // A task that is handed a bare token can send it anywhere it likes. Saying
    // which host it belongs to is what lets a wrapper scope it to one.
    await store.set(registryTokenRef(), 'npm_secret');
    const grant = await new RegistryCredentials('npm.internal.example', store).grant();

    expect(isRefusal(grant)).toBe(false);
    expect(grant).toEqual({
      host: 'npm.internal.example',
      token: 'npm_secret',
      maxAgeSeconds: REGISTRY_TOKEN_MAX_AGE_SECONDS,
    });
  });

  it('is re-read, so a rotation takes effect without restarting anything', async () => {
    // This is the whole reason the endpoint exists rather than an environment
    // variable: a task that runs for an hour and installs at minute fifty must
    // not present what was true when it started.
    const credentials = new RegistryCredentials('npm.internal.example', store);
    await store.set(registryTokenRef(), 'first');
    expect(await credentials.grant()).toMatchObject({ token: 'first' });

    await store.set(registryTokenRef(), 'second');
    expect(await credentials.grant()).toMatchObject({ token: 'second' });
  });

  it('caps how long a task may hold one', async () => {
    // Long enough that a normal install asks once, short enough that a rotation
    // is not waited out.
    expect(REGISTRY_TOKEN_MAX_AGE_SECONDS).toBeLessThanOrEqual(600);
    expect(REGISTRY_TOKEN_MAX_AGE_SECONDS).toBeGreaterThan(0);
  });
});

describe('an install that has nothing to serve', () => {
  it('says there is no registry, which is not a fault', async () => {
    // Every install today. The message has to read as "nothing to do here",
    // because a wrapper seeing it should install from the public registry.
    const grant = await new RegistryCredentials(null, store).grant();
    expect(isRefusal(grant)).toBe(true);
    expect(grant).toMatchObject({ error: expect.stringContaining('no private package registry'), configured: false });
  });

  it('distinguishes a half-configured install from an unconfigured one', async () => {
    // A registry named with no token stored is somebody's mistake, and the
    // install has to stop on it rather than go to the public registry.
    const grant = await new RegistryCredentials('npm.internal.example', store).grant();
    expect(isRefusal(grant)).toBe(true);
    expect(grant).toMatchObject({
      configured: true,
      error: expect.stringContaining('npm.internal.example'),
      remedy: expect.stringContaining(registryTokenRef()),
    });
  });

  it('does not leak the token into the refusal', async () => {
    await store.set(registryTokenRef(), 'npm_secret');
    const grant = await new RegistryCredentials(null, store).grant();
    expect(JSON.stringify(grant)).not.toContain('npm_secret');
  });
});

describe('where a missing token is to be stored', () => {
  const saved = process.env.FLEETADLC_SECRET_STORE;
  afterEach(() => {
    if (saved === undefined) delete process.env.FLEETADLC_SECRET_STORE;
    else process.env.FLEETADLC_SECRET_STORE = saved;
  });

  it('is the secret file, for the file store', async () => {
    delete process.env.FLEETADLC_SECRET_STORE;
    const grant = await new RegistryCredentials('npm.internal.example', store).grant();
    expect(grant).toMatchObject({ remedy: expect.stringContaining(`/secrets/${registryTokenRef()}.secret`) });
    expect(JSON.stringify(grant)).not.toContain('gcloud');
  });

  it('is a command that, pasted as it is, stores the token where the file store reads it, closed to everyone else', async () => {
    delete process.env.FLEETADLC_SECRET_STORE;
    const grant = await new RegistryCredentials('npm.internal.example', store).grant();
    const remedy = isRefusal(grant) ? grant.remedy : '';
    const home = mkdtempSync(join(tmpdir(), 'fleetadlc-registry-remedy-'));
    try {
      mkdirSync(join(home, 'secrets'));
      execFileSync('sh', ['-c', remedy.replace(/^store one: /, '')], {
        env: { PATH: process.env.PATH, HOME: home, FLEETADLC_HOME: home, REGISTRY_TOKEN: 'npm_pasted' },
      });
      const written = join(home, 'secrets', `${registryTokenRef()}.secret`);
      expect(readFileSync(written, 'utf8')).toBe('npm_pasted');
      expect(statSync(written).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('is the Secret Manager secret the cloud host reads, not a file it never looks at', async () => {
    process.env.FLEETADLC_SECRET_STORE = 'gcp';
    const grant = await new RegistryCredentials('npm.internal.example', store).grant();
    expect(grant).toMatchObject({
      remedy: expect.stringContaining('gcloud secrets create fleet-registry-token --labels=fleet=secret --data-file=-'),
    });
    expect(JSON.stringify(grant)).not.toContain('.secret"');
  });
});
