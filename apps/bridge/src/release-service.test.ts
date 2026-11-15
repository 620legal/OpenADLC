import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReleaseRun, ReleaseSetting } from '@openadlc/db';

vi.mock('@openadlc/db', () => {
  class ReleaseAlreadyRunning extends Error {}
  return {
    repos: { getRelease: vi.fn() },
    releaseRuns: { start: vi.fn(), finish: vi.fn(), byRunId: vi.fn(), running: vi.fn(), anyInFlight: vi.fn(), builtUnheld: vi.fn(), publishingUnheld: vi.fn() },
    ReleaseAlreadyRunning,
  };
});

import { ReleaseAlreadyRunning, releaseRuns, repos } from '@openadlc/db';
import { ReleaseService, lastReleaseOnGitHub, lastReleaseVersion, lastVersionOnGitHub, type PublishedRelease, type ReleaseServiceDeps } from './release-service.js';
import type { ReleaseRunView } from './hostd-client.js';

const SHA = 'a'.repeat(40);
const REPO = { id: 'repo-1', name: 'app', fullName: 'acme/app', defaultBranch: 'main' };
const BY = { login: 'orzelig', githubUserId: 42 };
const SETTING: ReleaseSetting = { command: 'make release', artifact: 'build/App.zip', versionFile: 'VERSION', versionKey: null, releaseRepo: null, timeoutMinutes: 180, manifestAsset: null };

function row(overrides: Partial<ReleaseRun> = {}): ReleaseRun {
  return {
    id: 'row-1',
    runId: 'run-1',
    repoId: REPO.id,
    repoName: REPO.name,
    repoFullName: REPO.fullName,
    sha: SHA,
    clean: false,
    command: SETTING.command,
    artifact: SETTING.artifact,
    versionFile: SETTING.versionFile,
    versionKey: null,
    releaseRepo: null,
    timeoutMinutes: 180,
    previousVersion: '1.4.0-x.3',
    state: 'running',
    version: null,
    sha256: null,
    bytes: null,
    artifactName: null,
    exitCode: null,
    durationMs: null,
    logTail: null,
    reason: null,
    requestedByLogin: BY.login,
    requestedById: BY.githubUserId,
    startedAt: '2026-11-15T10:00:00.000Z',
    finishedAt: null,
    tag: null,
    releaseId: null,
    releaseUrl: null,
    assetUrl: null,
    tagged: false,
    publishedAt: null,
    ...overrides,
  };
}

const order: string[] = [];

function service(overrides: Partial<ReleaseServiceDeps> = {}) {
  const hostd = {
    releaseAccount: vi.fn(async () => ({ probe: { ok: true as const, account: 'openadlc-release', uid: 503, home: '/Users/openadlc-release' } })),
    startRelease: vi.fn(async (_input: unknown) => {
      order.push('hostd');
      return { run: {} as ReleaseRunView };
    }),
    releaseRun: vi.fn(async (_runId: string): Promise<{ run: ReleaseRunView }> => {
      throw Object.assign(new Error('no such run'), { status: 404 });
    }),
    cancelRelease: vi.fn(async (_runId: string) => ({ cancelled: true })),
  };
  const deps: ReleaseServiceDeps = {
    hostd,
    lastRelease: vi.fn(async () => ({ version: '1.4.0-x.3', tag: 'v1.4.0-x.3', url: 'https://github.com/acme/app/releases/tag/v1.4.0-x.3' })),
    fetchBot: async () => 'atlas',
    newId: () => 'run-1',
    warn: () => undefined,
    ...overrides,
  };
  return { releases: new ReleaseService(deps), hostd, deps };
}

beforeEach(() => {
  order.length = 0;
  vi.mocked(repos.getRelease).mockReset().mockResolvedValue(SETTING);
  vi.mocked(releaseRuns.anyInFlight).mockReset().mockResolvedValue(false);
  vi.mocked(releaseRuns.start).mockReset().mockImplementation(async (input) => {
    order.push(`row ${input.state ?? 'running'}`);
    return row({ runId: input.runId, state: input.state ?? 'running', reason: input.reason ?? null, previousVersion: input.previousVersion });
  });
  vi.mocked(releaseRuns.finish).mockReset().mockImplementation(async (runId, outcome) => row({ runId, ...outcome } as Partial<ReleaseRun>));
  vi.mocked(releaseRuns.byRunId).mockReset().mockResolvedValue(row());
  vi.mocked(releaseRuns.running).mockReset().mockResolvedValue([]);
  vi.mocked(releaseRuns.builtUnheld).mockReset().mockResolvedValue([]);
  vi.mocked(releaseRuns.publishingUnheld).mockReset().mockResolvedValue([]);
});

describe('publishing a built run (#344)', () => {
  const built = { runId: 'run-1', state: 'built' as const, version: '1.4.0-x.4', sha256: 'b'.repeat(64), bytes: 1234, artifactName: 'App.zip', exitCode: 0, durationMs: 60_000, logTail: 'ok', reason: null };

  function publisher() {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    return {
      publish: vi.fn(async (_runId: string) => {
        await gate;
        return null;
      }),
      abandon: vi.fn(async (run: ReleaseRun) => row({ ...run, state: 'publish_failed' })),
      release: () => release(),
    };
  }

  it('starts the publish once when a built report is stored, and not for a report sent twice', async () => {
    const publish = publisher();
    const { releases } = service({ publisher: publish });
    await releases.record(built);
    vi.mocked(releaseRuns.byRunId).mockResolvedValueOnce(row({ state: 'built' }));
    await releases.record(built);
    // While it publishes, a sweep does not start a second publisher for it.
    vi.mocked(releaseRuns.builtUnheld).mockImplementation(async (held) => (held?.includes('run-1') ? [] : [row({ state: 'built' })]));
    await releases.sweep();
    publish.release();
    await releases.settled();
    expect(publish.publish).toHaveBeenCalledTimes(1);
    expect(publish.publish).toHaveBeenCalledWith('run-1');
    expect(releaseRuns.builtUnheld).toHaveBeenCalledWith(['run-1']);
  });

  it('publishes nothing for a failed or refused report', async () => {
    const publish = publisher();
    const { releases } = service({ publisher: publish });
    await releases.record({ ...built, state: 'failed', reason: 'make release exited 2' });
    await releases.record({ ...built, sha256: null });
    expect(publish.publish).not.toHaveBeenCalled();
  });

  it('publishes a built row no publisher holds, and fails a publishing row no publisher holds', async () => {
    const publish = publisher();
    publish.release();
    const { releases } = service({ publisher: publish });
    vi.mocked(releaseRuns.builtUnheld).mockResolvedValueOnce([row({ runId: 'run-2', state: 'built' })]);
    vi.mocked(releaseRuns.publishingUnheld).mockResolvedValueOnce([row({ runId: 'run-3', state: 'publishing', tag: 'v1.4.0' })]);
    const lines = await releases.sweep();
    await releases.settled();
    expect(publish.publish).toHaveBeenCalledWith('run-2');
    expect(publish.abandon).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-3' }));
    expect(lines).toEqual(['app: publishing v1.4.0 of aaaaaaa was cut off by a restart, and failed', 'app: publishing the release built from aaaaaaa']);
  });

  it('is the only caller of a publisher’s publish, and no route reaches one', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'));
    const callers = files.filter((name) => /\bpublisher\??\s*\.\s*publish\s*\(|\.publish\(\s*run(Id)?\b/.test(readFileSync(join(dir, name), 'utf8')));
    expect(callers).toEqual(['release-service.ts']);
    // No route file names the publisher.
    const routes = files.filter((name) => /router\.(get|post|put|patch|delete)\(/.test(readFileSync(join(dir, name), 'utf8')));
    for (const name of routes) expect(readFileSync(join(dir, name), 'utf8')).not.toMatch(/ReleasePublisher|release-publish/);
  });
});

describe('starting a release build (#343)', () => {
  it('writes the row with the pinned sha and the last release before hostd is asked, with the row’s recipe', async () => {
    const { releases, hostd } = service();
    const started = await releases.start({ repo: REPO, sha: SHA, clean: true, by: BY });
    expect(started).toMatchObject({ state: 'running', sha: SHA, previousVersion: '1.4.0-x.3' });
    expect(order).toEqual(['row running', 'hostd']);
    expect(releaseRuns.start).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', repoId: 'repo-1', sha: SHA, clean: true, command: 'make release', previousVersion: '1.4.0-x.3', requestedByLogin: 'orzelig', requestedById: 42 }),
    );
    expect(hostd.startRelease).toHaveBeenCalledWith({
      runId: 'run-1',
      repo: 'acme/app',
      sha: SHA,
      defaultBranch: 'main',
      versionFile: 'VERSION',
      versionKey: null,
      after: '1.4.0-x.3',
      command: 'make release',
      artifact: 'build/App.zip',
      timeoutMinutes: 180,
      clean: true,
      bot: 'atlas',
    });
  });

  it('reads the last release from the release repository when one is set', async () => {
    vi.mocked(repos.getRelease).mockResolvedValue({ ...SETTING, releaseRepo: 'acme/app-releases' });
    const { releases, deps } = service();
    await releases.start({ repo: REPO, sha: SHA, clean: false, by: BY });
    expect(deps.lastRelease).toHaveBeenCalledWith('acme/app-releases');
  });

  it('refuses, saying what to do, with no recipe, a sha that is not one, a run going, no hostd, no account, or hostd not answering', async () => {
    vi.mocked(repos.getRelease).mockResolvedValueOnce(null);
    await expect(service().releases.start({ repo: REPO, sha: SHA, clean: false, by: BY })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('PATCH /v1/repos/app') });

    await expect(service().releases.start({ repo: REPO, sha: 'main', clean: false, by: BY })).rejects.toMatchObject({ status: 400 });
    await expect(service().releases.start({ repo: REPO, sha: 'A'.repeat(40), clean: false, by: BY })).rejects.toMatchObject({ status: 400 });

    vi.mocked(releaseRuns.anyInFlight).mockResolvedValueOnce(true);
    await expect(service().releases.start({ repo: REPO, sha: SHA, clean: false, by: BY })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('is building') });

    await expect(service({ hostd: null }).releases.start({ repo: REPO, sha: SHA, clean: false, by: BY })).rejects.toMatchObject({ status: 501 });

    const unnamed = service();
    unnamed.hostd.releaseAccount.mockResolvedValueOnce({ probe: null } as never);
    await expect(unnamed.releases.start({ repo: REPO, sha: SHA, clean: false, by: BY })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('OPENADLC_RELEASE_ACCOUNT') });

    const silent = service();
    silent.hostd.releaseAccount.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    await expect(silent.releases.start({ repo: REPO, sha: SHA, clean: false, by: BY })).rejects.toMatchObject({ status: 502 });

    expect(releaseRuns.start).not.toHaveBeenCalled();
  });

  it('refuses at the database a second run of the repository started at once', async () => {
    vi.mocked(releaseRuns.start).mockRejectedValueOnce(new ReleaseAlreadyRunning('repo-1'));
    const { releases, hostd } = service();
    await expect(releases.start({ repo: REPO, sha: SHA, clean: false, by: BY })).rejects.toMatchObject({ status: 409 });
    expect(hostd.startRelease).not.toHaveBeenCalled();
  });

  it('records a refused row, with the account’s fix, when the probe fails', async () => {
    const { releases, hostd } = service();
    hostd.releaseAccount.mockResolvedValueOnce({ probe: { ok: false, account: 'openadlc-release', problem: 'no_sudo', detail: 'sudo -n refused' } } as never);
    const refused = await releases.start({ repo: REPO, sha: SHA, clean: false, by: BY });
    expect(refused.state).toBe('refused');
    expect(refused.reason).toContain('Add the sudo rule');
    expect(hostd.startRelease).not.toHaveBeenCalled();
  });

  it('refuses the run when the last release cannot be read, never reading it as no release', async () => {
    const { releases, hostd } = service({ lastRelease: async () => Promise.reject(new Error('GitHub answered 502')) });
    const refused = await releases.start({ repo: REPO, sha: SHA, clean: false, by: BY });
    expect(refused).toMatchObject({ state: 'refused', reason: expect.stringContaining('could not be read') });
    expect(refused.reason).toContain('GitHub answered 502');
    expect(hostd.startRelease).not.toHaveBeenCalled();
  });

  it('finishes the row refused when hostd does not take the run', async () => {
    const { releases, hostd } = service();
    hostd.startRelease.mockRejectedValueOnce(new Error('a release of acme/app is building'));
    const refused = await releases.start({ repo: REPO, sha: SHA, clean: false, by: BY });
    expect(releaseRuns.finish).toHaveBeenCalledWith('run-1', { state: 'refused', reason: expect.stringContaining('hostd did not take the run') });
    expect(refused.state).toBe('refused');
  });
});

describe('what hostd reports', () => {
  const built = { runId: 'run-1', state: 'built' as const, version: '1.4.0-x.4', sha256: 'b'.repeat(64), bytes: 1234, artifactName: 'App.zip', exitCode: 0, durationMs: 60_000, logTail: 'ok', reason: null };

  it('stores a built run with hostd’s fields', async () => {
    await expect(service().releases.record(built)).resolves.toBe(true);
    expect(releaseRuns.finish).toHaveBeenCalledWith('run-1', expect.objectContaining({ state: 'built', version: '1.4.0-x.4', sha256: 'b'.repeat(64), bytes: 1234, artifactName: 'App.zip' }));
  });

  it.each([
    ['no sha256', { sha256: null }],
    ['a short sha256', { sha256: 'abc' }],
    ['no size', { bytes: 0 }],
    ['no artifact name', { artifactName: null }],
    ['no version', { version: null }],
    ['a version that is not one', { version: '1.4.0-rc' }],
    ['a version not above the last release', { version: '1.4.0-x.3' }],
    ['a version with another label', { version: '1.4.0-y.9' }],
  ])('stores a built report with %s as failed', async (_name, change) => {
    await service().releases.record({ ...built, ...change });
    expect(releaseRuns.finish).toHaveBeenCalledWith('run-1', expect.objectContaining({ state: 'failed', reason: expect.stringMatching(/hostd reported/) }));
    expect(vi.mocked(releaseRuns.finish).mock.calls[0]?.[1]).not.toHaveProperty('sha256');
  });

  it('keeps no signed field from a failed report', async () => {
    await service().releases.record({ ...built, state: 'failed', reason: 'make release exited 2' });
    expect(releaseRuns.finish).toHaveBeenCalledWith('run-1', { state: 'failed', exitCode: 0, durationMs: 60_000, logTail: 'ok', reason: 'make release exited 2' });
  });

  it('ignores a report for a run already ended, or none', async () => {
    vi.mocked(releaseRuns.byRunId).mockResolvedValueOnce(row({ state: 'built' }));
    await expect(service().releases.record(built)).resolves.toBe(false);
    vi.mocked(releaseRuns.byRunId).mockResolvedValueOnce(null);
    await expect(service().releases.record(built)).resolves.toBe(false);
    expect(releaseRuns.finish).not.toHaveBeenCalled();
  });
});

describe('the sweep and a cancel', () => {
  it('marks a running row hostd no longer holds lost', async () => {
    vi.mocked(releaseRuns.running).mockResolvedValue([row()]);
    const lines = await service().releases.sweep();
    expect(releaseRuns.finish).toHaveBeenCalledWith('run-1', { state: 'lost', reason: expect.stringContaining('start the release again') });
    expect(lines).toEqual(['app: release of aaaaaaa was lost by hostd']);
  });

  it('leaves a run hostd is building, or cannot be asked about', async () => {
    vi.mocked(releaseRuns.running).mockResolvedValue([row()]);
    const going = service();
    going.hostd.releaseRun.mockResolvedValueOnce({ run: { state: 'running' } as ReleaseRunView });
    await going.releases.sweep();
    const silent = service();
    silent.hostd.releaseRun.mockRejectedValueOnce(new Error('hostd is not answering'));
    await silent.releases.sweep();
    expect(releaseRuns.finish).not.toHaveBeenCalled();
  });

  it('takes the end of a run whose report went missing from hostd', async () => {
    vi.mocked(releaseRuns.running).mockResolvedValue([row()]);
    const { releases, hostd } = service();
    hostd.releaseRun.mockResolvedValueOnce({
      run: { state: 'built', version: '1.4.0-x.4', sha256: 'c'.repeat(64), bytes: 9, artifactName: 'App.zip', exitCode: null, durationMs: null, logTail: '', reason: null } as ReleaseRunView,
    });
    await releases.sweep();
    expect(releaseRuns.finish).toHaveBeenCalledWith('run-1', expect.objectContaining({ state: 'built', sha256: 'c'.repeat(64) }));
  });

  it('asks hostd to stop a run, and ends one hostd does not know of', async () => {
    const told = service();
    await expect(told.releases.cancel('run-1')).resolves.toBe(true);
    expect(told.hostd.cancelRelease).toHaveBeenCalledWith('run-1');
    expect(releaseRuns.finish).not.toHaveBeenCalled();

    const unknown = service();
    unknown.hostd.cancelRelease.mockResolvedValueOnce({ cancelled: false });
    await unknown.releases.cancel('run-1', 'stopped by orzelig');
    expect(releaseRuns.finish).toHaveBeenCalledWith('run-1', { state: 'cancelled', reason: 'stopped by orzelig' });
  });
});

describe('the last release', () => {
  const release = (tag: string, extra: Partial<PublishedRelease> = {}): PublishedRelease => ({ tag_name: tag, draft: false, prerelease: false, published_at: '2026-11-01T00:00:00Z', ...extra });

  it('reads v-prefixed and bare tags', () => {
    expect(lastReleaseVersion([release('v156.0.8078.79-abc.29')])?.text).toBe('156.0.8078.79-abc.29');
    expect(lastReleaseVersion([release('1.4.0')])?.text).toBe('1.4.0');
  });

  it('skips a tag that is not a version, a draft and a GitHub prerelease', () => {
    expect(lastReleaseVersion([release('nightly-2020'), release('v9.0', { draft: true, published_at: null }), release('v8.0', { prerelease: true }), release('v1.0')])?.text).toBe('1.0');
    expect(lastReleaseVersion([release('nightly')])).toBeNull();
    expect(lastReleaseVersion([])).toBeNull();
  });

  it('chooses the highest, not the newest', () => {
    expect(lastReleaseVersion([release('v1.0.1', { published_at: '2026-11-10T00:00:00Z' }), release('v2.0-x.1', { published_at: '2026-10-01T00:00:00Z' })])?.text).toBe('2.0-x.1');
  });

  it('refuses a tie at the highest across two labels, naming both', () => {
    expect(() => lastReleaseVersion([release('v1.2-x.3'), release('v1.2-y.3')])).toThrow(/v1\.2-x\.3 and v1\.2-y\.3/);
  });

  it('reads the first page as the given client, and throws with none or a failed read', async () => {
    const request = vi.fn(async () => [release('v1.2.3')]);
    await expect(lastVersionOnGitHub(async () => ({ request }) as never)('acme/app')).resolves.toBe('1.2.3');
    expect(request).toHaveBeenCalledWith('GET', '/repos/acme/app/releases?per_page=100');
    await expect(lastVersionOnGitHub(async () => null)('acme/app')).rejects.toThrow(/can read the releases of acme\/app/);
    await expect(lastVersionOnGitHub(async () => ({ request: async () => Promise.reject(new Error('502')) }) as never)('acme/app')).rejects.toThrow('502');
  });

  it('answers the tag and page of the release the run takes its version from (#345)', async () => {
    const request = vi.fn(async () => [
      release('v1.3.0', { html_url: 'https://github.com/acme/app/releases/tag/v1.3.0' }),
      release('v1.4.0', { html_url: 'https://github.com/acme/app/releases/tag/v1.4.0' }),
      release('v2.0.0', { prerelease: true, html_url: 'https://github.com/acme/app/releases/tag/v2.0.0' }),
    ]);
    await expect(lastReleaseOnGitHub(async () => ({ request }) as never)('acme/app')).resolves.toEqual({
      version: '1.4.0',
      tag: 'v1.4.0',
      url: 'https://github.com/acme/app/releases/tag/v1.4.0',
    });
    await expect(lastReleaseOnGitHub(async () => ({ request: async () => [] }) as never)('acme/app')).resolves.toBeNull();
    await expect(lastReleaseOnGitHub(async () => ({ request: async () => Promise.reject(new Error('502')) }) as never)('acme/app')).rejects.toThrow('502');
  });

  it('is read through the service, which start takes after from, and a failed read throws', async () => {
    const one = { version: '1.4.0', tag: 'v1.4.0', url: null };
    const { releases, hostd } = service({ lastRelease: vi.fn(async () => one) });
    await expect(releases.lastRelease('acme/app')).resolves.toBe(one);
    await releases.start({ repo: REPO, sha: SHA, clean: false, by: BY });
    expect(hostd.startRelease).toHaveBeenCalledWith(expect.objectContaining({ after: '1.4.0' }));
    const broken = service({ lastRelease: async () => Promise.reject(new Error('GitHub answered 502')) });
    await expect(broken.releases.lastRelease('acme/app')).rejects.toThrow('GitHub answered 502');
  });
});
