import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReleaseRun, ReleaseSetting } from '@openadlc/db';
import { hasReleaseSigningKey, releaseSigningKeyRef, serializeReleaseKeyRecord, type RuleApi } from '@openadlc/github';
import type { ReleaseAccountProbe } from './hostd-client.js';
import { READINESS_ITEMS, READINESS_TTL_MS, ReleaseReadiness, type ReadinessItem, type ReleaseReadinessDeps } from './release-readiness.js';

/**
 * The release page's readiness checklist (#371, docs/adr/0084): six reads,
 * each its own, none of which can start, pin or sign anything, and none of
 * which reads the signing key.
 */

const SHA = 'a'.repeat(40);
const REPO = { id: 'repo-1', name: 'app', fullName: 'acme/app', defaultBranch: 'main' };
const SETTING: ReleaseSetting = { command: 'make release', artifact: 'build/App.zip', versionFile: 'VERSION', versionKey: null, releaseRepo: null, timeoutMinutes: 180, manifestAsset: null };
const ACCOUNT_OK: ReleaseAccountProbe = { ok: true, account: 'openadlc-release', uid: 502, home: '/Users/openadlc-release' };

const RULESET = {
  id: 7,
  name: 'release tags',
  target: 'tag',
  enforcement: 'active',
  source_type: 'Repository',
  source: 'acme/app',
  conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] as string[] } },
  rules: [{ type: 'creation' }],
  current_user_can_bypass: 'never',
};

/** GitHub as the app reads a repository's tag rulesets. */
function rulesetsApi(rulesets: Record<string, unknown>[]): RuleApi {
  return {
    async request<T>(_method: string, path: string): Promise<T> {
      if (path.includes('/rulesets?')) return rulesets.map(({ current_user_can_bypass: _b, ...entry }) => entry) as T;
      return rulesets.find((one) => path.endsWith(`/rulesets/${String(one.id)}`)) as T;
    },
  };
}

function run(overrides: Partial<ReleaseRun> = {}): ReleaseRun {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    runId: 'run-1',
    repoId: REPO.id,
    repoName: REPO.name,
    repoFullName: REPO.fullName,
    sha: SHA,
    clean: false,
    command: SETTING.command,
    artifact: SETTING.artifact,
    versionFile: 'VERSION',
    versionKey: null,
    releaseRepo: null,
    timeoutMinutes: 180,
    previousVersion: '1.4.0',
    state: 'published',
    version: '1.4.0',
    sha256: null,
    bytes: null,
    artifactName: null,
    exitCode: null,
    durationMs: null,
    logTail: null,
    reason: null,
    requestedByLogin: 'jane',
    requestedById: 101,
    startedAt: '2026-11-15T10:00:00.000Z',
    finishedAt: '2026-11-15T10:20:00.000Z',
    tag: 'v1.4.0',
    releaseId: null,
    releaseUrl: null,
    assetUrl: null,
    tagged: true,
    publishedAt: null,
    ...overrides,
  };
}

/** Every read passing, unless a test says otherwise. */
function deps(overrides: Partial<ReleaseReadinessDeps> = {}): ReleaseReadinessDeps & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    repo: async (name) => (name === 'app' ? REPO : null),
    getRelease: async () => SETTING,
    recipeSetBy: async () => ({ actor: 'ann@example.com', at: '2026-11-01T09:00:00.000Z' }),
    hasSigningKey: async () => true,
    releaseAccount: async () => ({ probe: ACCOUNT_OK }),
    lastRelease: async () => ({ version: '1.4.0', tag: 'v1.4.0', url: null }),
    reader: async () => ({
      request: async <T,>(_method: string, path: string): Promise<T> => {
        reads.push(path);
        return { object: { sha: SHA } } as T;
      },
    }),
    version: async () => ({ text: '1.5.0', blocked: null }),
    app: async () => rulesetsApi([]),
    lastRun: async () => run(),
    ...overrides,
  };
}

async function items(overrides: Partial<ReleaseReadinessDeps> = {}): Promise<Record<string, ReadinessItem>> {
  const answer = await new ReleaseReadiness(deps(overrides)).read('app');
  return Object.fromEntries(answer.items.map((item) => [item.id, item]));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the readiness of a cut', () => {
  it('answers six items, in a fixed order, all passing when everything is set', async () => {
    const answer = await new ReleaseReadiness(deps({ now: () => Date.parse('2026-11-26T08:00:00Z') })).read('app');
    expect(answer).toMatchObject({ repo: 'app', fullName: 'acme/app', checkedAt: '2026-11-26T08:00:00.000Z' });
    expect(answer.items.map((item) => item.id)).toEqual([...READINESS_ITEMS]);
    expect(answer.items.map((item) => item.title)).toEqual(['Release account', 'Signing key', 'Release recipe', 'Release tag', 'Next version', 'Last build']);
    for (const item of answer.items) expect(item.status).toBe('pass');
    expect(answer.items.filter((item) => item.informational).map((item) => item.id)).toEqual(['last_build']);
  });

  it('404s a repository the install does not manage', async () => {
    await expect(new ReleaseReadiness(deps()).read('nope')).rejects.toMatchObject({ status: 404 });
  });

  it('reads once per repository for 30 seconds, then again', async () => {
    const clock = { now: 0 };
    const releaseAccount = vi.fn(async () => ({ probe: ACCOUNT_OK }));
    const readiness = new ReleaseReadiness(deps({ releaseAccount, now: () => clock.now }));
    await readiness.read('app');
    await readiness.read('app');
    expect(releaseAccount).toHaveBeenCalledTimes(1);
    clock.now += READINESS_TTL_MS;
    await readiness.read('app');
    expect(releaseAccount).toHaveBeenCalledTimes(2);
  });
});

describe('1. the release account', () => {
  it('passes with the account hostd probed', async () => {
    expect((await items()).account).toMatchObject({ status: 'pass', says: 'openadlc-release (uid 502) builds releases in /Users/openadlc-release' });
  });

  it('fails with the probe’s own fix when the account can read the install', async () => {
    const probe: ReleaseAccountProbe = { ok: false, account: 'openadlc-release', problem: 'can_read', path: '/Users/me/.openadlc', detail: 'openadlc-release can list /Users/me/.openadlc' };
    expect((await items({ releaseAccount: async () => ({ probe }) })).account).toMatchObject({
      status: 'fail',
      says: 'The release account can read /Users/me/.openadlc',
      fix: expect.stringContaining('Run: chmod 700 /Users/me/.openadlc, then run openadlc doctor.'),
      action: { label: 'Run in a terminal', command: 'chmod 700 /Users/me/.openadlc' },
    });
  });

  it('fails when the account is the host check’s', async () => {
    const probe: ReleaseAccountProbe = { ok: false, account: 'openadlc-ci', problem: 'host_check_account', detail: 'openadlc-ci is the host check account' };
    expect((await items({ releaseAccount: async () => ({ probe }) })).account).toMatchObject({
      status: 'fail',
      says: 'Releases would be built in the host check’s account',
      fix: expect.stringContaining("Set OPENADLC_RELEASE_ACCOUNT to an account made only for releases, never the host check's."),
    });
  });

  it('fails, saying to name one, when hostd names no account', async () => {
    expect((await items({ releaseAccount: async () => ({ probe: null }) })).account).toMatchObject({
      status: 'fail',
      fix: 'Set OPENADLC_RELEASE_ACCOUNT to the account you made for releases (docs/self-hosting.md#the-release-account), then restart hostd.',
    });
  });
});

describe('2. the signing key', () => {
  it('passes when a key is filed', async () => {
    expect((await items()).signing_key).toMatchObject({ status: 'pass', says: 'A signing key is filed for acme/app; it is proved when a release is signed.' });
  });

  it('fails with the import command when none is', async () => {
    expect((await items({ hasSigningKey: async () => false })).signing_key).toMatchObject({
      status: 'fail',
      fix: 'Run on the host: openadlc release-key import --repo acme/app --file <path>',
      action: { label: 'Run on the host', command: 'openadlc release-key import --repo acme/app --file <path>' },
    });
  });
});

describe('3. the release recipe', () => {
  it('passes with the command, the artifact, the version file and who set it', async () => {
    expect((await items()).recipe).toMatchObject({
      status: 'pass',
      says: 'Runs make release, leaves build/App.zip, reads the version from VERSION; set by ann@example.com at 2026-11-01T09:00:00.000Z.',
    });
  });

  it('says who set it is not recorded when no audit row says', async () => {
    expect((await items({ recipeSetBy: async () => null })).recipe?.says).toContain('who set it is not recorded');
  });

  it('fails with where an admin sets it when it is not whole', async () => {
    expect((await items({ getRelease: async () => null })).recipe).toMatchObject({
      status: 'fail',
      fix: 'An admin sets it in Settings → app → Release.',
      action: { label: 'Open the settings', href: '/settings/repositories/app' },
    });
  });
});

describe('4. the release tag', () => {
  it('passes when no ruleset stops the app creating the head’s tag', async () => {
    expect((await items()).release_tag).toMatchObject({ status: 'pass', says: expect.stringContaining('(judged for v1.5.0)') });
  });

  it('fails with the ruleset’s page when a tag ruleset does not let the app bypass it', async () => {
    expect((await items({ app: async () => rulesetsApi([RULESET]) })).release_tag).toMatchObject({
      status: 'fail',
      says: "OpenADLC's app cannot create release tags on acme/app",
      fix: expect.stringContaining('lets only its bypass list create v1.5.0'),
      action: { label: 'Open the ruleset', url: 'https://github.com/acme/app/settings/rules/7' },
    });
  });

  it('judges the separate release repository too, and fails where the app is not installed there', async () => {
    const app = vi.fn(async (name: string) => (name === 'acme/app' ? rulesetsApi([]) : null));
    const found = await items({ getRelease: async () => ({ ...SETTING, releaseRepo: 'acme/app-releases' }), app });
    expect(app).toHaveBeenCalledWith('acme/app-releases');
    expect(found.release_tag).toMatchObject({ status: 'fail', action: { label: 'Install the app' } });
  });

  it('judges the likely next tag when the head’s version cannot be read', async () => {
    const app = vi.fn(async () => rulesetsApi([{ ...RULESET, conditions: { ref_name: { include: ['refs/tags/v1.4.1'], exclude: [] } } }]));
    expect((await items({ getRelease: async () => null, app })).release_tag).toMatchObject({ status: 'fail', fix: expect.stringContaining('v1.4.1') });
  });
});

describe('5. the next version', () => {
  it('passes when the head’s version is above the last release', async () => {
    expect((await items()).version).toMatchObject({ status: 'pass', says: '1.5.0 at aaaaaaa is above 1.4.0' });
  });

  it('fails showing both versions when the gate refuses it', async () => {
    const found = await items({ version: async () => ({ text: '1.4.0', blocked: { message: 'VERSION says 1.4.0, which is not above the last release, 1.4.0' } }) });
    expect(found.version).toMatchObject({
      status: 'fail',
      says: 'VERSION says 1.4.0, which is not above the last release, 1.4.0. At aaaaaaa: 1.4.0; last release: 1.4.0.',
      fix: 'Raise the version in VERSION above 1.4.0, or use Prepare next version on this page when it is offered.',
    });
  });

  it('reads the head without pinning anything, and asks the cut’s own version read at that SHA', async () => {
    const version = vi.fn(async () => ({ text: '1.5.0', blocked: null }));
    const d = deps({ version });
    await new ReleaseReadiness(d).read('app');
    expect(d.reads).toEqual(['/repos/acme/app/git/ref/heads/main']);
    expect(version).toHaveBeenCalledWith(expect.anything(), REPO, SETTING, { version: '1.4.0', tag: 'v1.4.0', url: null }, SHA);
  });

  it('could not check without a recipe, or when the last release cannot be read', async () => {
    expect((await items({ getRelease: async () => null })).version).toMatchObject({ status: 'unknown', says: expect.stringContaining('release recipe') });
    const found = await items({ lastRelease: async () => Promise.reject(new Error('GitHub answered 502')) });
    expect(found.version).toMatchObject({ status: 'unknown', says: expect.stringContaining('GitHub answered 502') });
    expect(found.release_tag).toMatchObject({ status: 'pass' });
  });
});

describe('6. the last build', () => {
  it('passes for a published build, with when it ran', async () => {
    expect((await items()).last_build).toMatchObject({ status: 'pass', informational: true, says: expect.stringContaining('published as v1.4.0') });
  });

  it('passes when nothing was built yet', async () => {
    expect((await items({ lastRun: async () => null })).last_build).toMatchObject({ status: 'pass', informational: true });
  });

  it('fails for a failed build, saying its tree is kept and to tick Clean build', async () => {
    const found = await items({ lastRun: async () => run({ state: 'failed', reason: 'make release exited 2', tag: null }) });
    expect(found.last_build).toMatchObject({
      status: 'fail',
      informational: true,
      says: expect.stringContaining('make release exited 2'),
      fix: 'Tick Clean build when you cut.',
    });
    expect(found.last_build?.says).toContain('the next cut reuses it');
  });

  it('fails for a failed publish, with its reason as the fix', async () => {
    expect((await items({ lastRun: async () => run({ state: 'publish_failed', reason: 'the tag v1.5.0 is protected' }) })).last_build).toMatchObject({
      status: 'fail',
      says: expect.stringContaining('hostd still holds the built artifact'),
      fix: 'the tag v1.5.0 is protected',
    });
  });
});

describe('an item that cannot be read', () => {
  it('is "could not check" with the reason, and the other five still answer', async () => {
    const found = await items({ releaseAccount: async () => Promise.reject(new Error('hostd is not answering at 127.0.0.1:47301')) });
    expect(found.account).toMatchObject({ status: 'unknown', says: 'Could not check: hostd is not answering at 127.0.0.1:47301' });
    for (const id of ['signing_key', 'recipe', 'release_tag', 'version', 'last_build']) expect(found[id]?.status).toBe('pass');
  });

  it('is "could not check" when it never answers, after its timeout', async () => {
    vi.useFakeTimers();
    const reading = new ReleaseReadiness(deps({ hasSigningKey: () => new Promise<boolean>(() => undefined), timeoutMs: 10_000 })).read('app');
    await vi.advanceTimersByTimeAsync(10_000);
    const answer = await reading;
    const found = Object.fromEntries(answer.items.map((item) => [item.id, item]));
    expect(found.signing_key).toMatchObject({ status: 'unknown', says: expect.stringContaining('did not answer within 10 s') });
    for (const id of ['account', 'recipe', 'release_tag', 'version', 'last_build']) expect(found[id]?.status).toBe('pass');
  });

  it('is "could not check" for the tag when GitHub fails reading the rulesets', async () => {
    const app = async (): Promise<RuleApi> => ({ request: async () => Promise.reject(new Error('GitHub answered 500')) });
    expect((await items({ app })).release_tag).toMatchObject({ status: 'unknown', says: expect.stringContaining('GitHub answered 500') });
  });
});

describe('the signing key is never read', () => {
  it('answers from the store’s list alone, and nothing of the key reaches the answer or the log', async () => {
    const PEM = '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIJ1hsZ3v/VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g\n-----END PRIVATE KEY-----\n';
    const record = serializeReleaseKeyRecord({ v: 1, repo: 'acme/app', tag: 'acme-app-updates-1', key: PEM });
    const values = new Map([[releaseSigningKeyRef('acme/app'), record]]);
    const store = {
      list: vi.fn(async (prefix = '') => [...values.keys()].filter((ref) => ref.startsWith(prefix))),
      get: vi.fn(async (ref: string) => values.get(ref) ?? null),
    };
    const said: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void said.push(args.map(String).join(' ')));
    }

    const answer = await new ReleaseReadiness(deps({ hasSigningKey: (fullName) => hasReleaseSigningKey(fullName, store) })).read('app');

    expect(answer.items.find((item) => item.id === 'signing_key')).toMatchObject({ status: 'pass' });
    expect(store.get).not.toHaveBeenCalled();
    const everything = [JSON.stringify(answer), ...said].join('\n');
    for (const secret of [PEM, record, 'MC4CAQAwBQYDK2VwBCIEIJ1hsZ3v', 'acme-app-updates-1', releaseSigningKeyRef('acme/app')]) {
      expect(everything).not.toContain(secret);
    }
  });
});

describe('the readiness source', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'release-readiness.ts'), 'utf8');

  it('names none of the key’s loaders', () => {
    for (const name of ['releaseSigningKeyRef', 'parseReleaseKeyRecord', 'signRelease', 'getSecretStore', '.get(']) expect(source).not.toContain(name);
  });

  it('reaches the service, the cut’s routes, the publisher and hostd’s client as types only, and never starts or publishes', () => {
    for (const file of ['release-service', 'release-routes', 'release-publish', 'hostd-client']) {
      const imports = source.split('\n').filter((line) => line.startsWith('import') && line.includes(`./${file}.js`));
      for (const line of imports) expect(line).toMatch(/^import type /);
    }
    for (const call of ['.start(', 'startRelease', 'publish(', 'ReleasePublisher', 'keep(', '/views']) expect(source).not.toContain(call);
  });
});
