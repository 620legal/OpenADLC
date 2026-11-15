import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReleaseRun, ReleaseSetting } from '@openadlc/db';

// One release row, moved the way the store's conditional updates move it.
const store = vi.hoisted(() => ({ row: null as ReleaseRun | null }));

vi.mock('@openadlc/db', () => {
  const move = (from: string[], change: (row: ReleaseRun) => Partial<ReleaseRun>) => (runId: string) => {
    if (!store.row || store.row.runId !== runId || !from.includes(store.row.state)) return Promise.resolve(null);
    store.row = { ...store.row, ...change(store.row) };
    return Promise.resolve({ ...store.row });
  };
  return {
    repos: { DEFAULT_MANIFEST_ASSET: 'manifest.json' },
    releaseRuns: {
      byRunId: vi.fn(async (runId: string) => (store.row?.runId === runId ? { ...store.row } : null)),
      toPublishing: vi.fn((runId: string, tag: string) => move(['built'], () => ({ state: 'publishing', tag }))(runId)),
      setReleaseId: vi.fn((runId: string, id: number) => move(['publishing'], () => ({ releaseId: id }))(runId)),
      markTagged: vi.fn((runId: string) => move(['publishing'], () => ({ tagged: true }))(runId)),
      published: vi.fn((runId: string, input: { releaseUrl: string; assetUrl: string }) =>
        move(['publishing'], () => ({ state: 'published', releaseUrl: input.releaseUrl, assetUrl: input.assetUrl, publishedAt: 'now' }))(runId),
      ),
      publishFailed: vi.fn((runId: string, reason: string) => move(['built', 'publishing'], () => ({ state: 'publish_failed', reason }))(runId)),
    },
  };
});

import { GitHubApiError, type ReleaseAsset } from '@openadlc/github';
import { releaseRuns } from '@openadlc/db';
import { ReleasePublisher, releaseAssetUrl, type PublishApi } from './release-publish.js';
import type { SignedReleaseRun } from './hostd-client.js';

const SHA = 'a'.repeat(40);
const MOVED = 'f'.repeat(40);
const BYTES = Buffer.from('real bytes');
const SHA256 = createHash('sha256').update(BYTES).digest('hex');
const SETTING: ReleaseSetting = { command: 'make release', artifact: 'build/App.zip', versionFile: 'VERSION', versionKey: null, releaseRepo: null, timeoutMinutes: 180, manifestAsset: null };

function builtRow(extra: Partial<ReleaseRun> = {}): ReleaseRun {
  return {
    id: 'row-1',
    runId: 'run-1',
    repoId: 'repo-1',
    repoName: 'app',
    repoFullName: 'acme/app',
    sha: SHA,
    clean: false,
    command: 'make release',
    artifact: 'build/App.zip',
    versionFile: 'VERSION',
    versionKey: null,
    releaseRepo: null,
    timeoutMinutes: 180,
    previousVersion: '1.3.0',
    state: 'built',
    version: '1.4.0',
    sha256: SHA256,
    bytes: BYTES.length,
    artifactName: 'App.zip',
    exitCode: 0,
    durationMs: 1000,
    logTail: 'uploaded to https://evil.example/App.zip',
    reason: null,
    requestedByLogin: 'orzelig',
    requestedById: 42,
    startedAt: '2026-11-15T10:00:00.000Z',
    finishedAt: '2026-11-15T10:30:00.000Z',
    tag: null,
    releaseId: null,
    releaseUrl: null,
    assetUrl: null,
    tagged: false,
    publishedAt: null,
    ...extra,
  };
}

interface Call {
  as: string;
  method: string;
  path: string;
  body?: unknown;
}

interface Release {
  id: number;
  repo: string;
  tag_name: string;
  draft: boolean;
  assets: { name: string; size: number }[];
}

const notFound = (path: string) => new GitHubApiError(404, path, '{"message":"Not Found"}');

/**
 * A GitHub that keeps tags, releases and assets, and records every call made
 * to it, by which repository's app client. Its default branch head moves to
 * another commit once the run has started.
 */
function stubGitHub(options: {
  rename?: (name: string) => string;
  publishedUrl?: (url: string) => string;
  fail?: Record<string, () => Error>;
  tags?: Record<string, string>;
  published?: Release[];
  rulesets?: Record<string, unknown>[];
  fullName?: (repo: string) => string;
  /** The digest GitHub answers for an uploaded asset, in place of the bytes' own. */
  digest?: (name: string) => string;
  /** Applies a publish before failing it, as a timed-out PATCH GitHub did act on. */
  failAfterPublish?: () => Error;
} = {}) {
  const calls: Call[] = [];
  const tags = new Map<string, string>(Object.entries(options.tags ?? {}));
  const releases = new Map<number, Release>((options.published ?? []).map((one) => [one.id, one]));
  let nextId = 991;
  const fullName = options.fullName ?? ((repo: string) => repo);
  const failing = (key: string) => {
    const make = options.fail?.[key];
    if (make) throw make();
  };
  const downloadUrl = (release: Release, name: string) =>
    release.draft ? `https://github.com/${fullName(release.repo)}/releases/download/untagged-0abc/${encodeURIComponent(name)}` : releaseAssetUrl(fullName(release.repo), release.tag_name, name);
  const view = (release: Release) => ({
    id: release.id,
    tag_name: release.tag_name,
    draft: release.draft,
    html_url: release.draft ? `https://github.com/${release.repo}/releases/tag/untagged-0abc` : `https://github.com/${release.repo}/releases/tag/${release.tag_name}`,
    assets: release.assets.map((asset) => ({
      ...asset,
      state: 'uploaded',
      browser_download_url: options.publishedUrl && !release.draft ? options.publishedUrl(downloadUrl(release, asset.name)) : downloadUrl(release, asset.name),
    })),
  });

  function client(as: string): PublishApi {
    return {
      async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        calls.push({ as, method, path, ...(body === undefined ? {} : { body }) });
        const bare = path.split('?')[0] as string;
        failing(`${method} ${bare}`);
        let match: RegExpExecArray | null;
        if (method === 'GET' && (match = /^\/repos\/([^/]+\/[^/]+)$/.exec(bare))) return { full_name: fullName(match[1] as string), default_branch: 'main' } as T;
        if (method === 'GET' && /\/rulesets$/.test(bare)) return (options.rulesets ?? []).map(({ current_user_can_bypass: _b, ...entry }) => entry) as T;
        if (method === 'GET' && (match = /\/rulesets\/(\d+)$/.exec(bare))) return (options.rulesets ?? []).find((one) => one.id === Number(match?.[1])) as T;
        if (method === 'GET' && (match = /^\/repos\/([^/]+\/[^/]+)\/git\/ref\/tags\/(.+)$/.exec(bare))) {
          const sha = tags.get(`${match[1]}:${decodeURIComponent(match[2] as string)}`);
          if (!sha) throw notFound(path);
          return { object: { sha, type: 'commit' } } as T;
        }
        if (method === 'GET' && /\/git\/ref\/heads\//.test(bare)) return { object: { sha: MOVED } } as T;
        if (method === 'GET' && (match = /^\/repos\/([^/]+\/[^/]+)\/releases\/tags\/(.+)$/.exec(bare))) {
          const found = [...releases.values()].find((one) => one.repo === match?.[1] && one.tag_name === decodeURIComponent(match?.[2] ?? '') && !one.draft);
          if (!found) throw notFound(path);
          return view(found) as T;
        }
        if (method === 'POST' && (match = /^\/repos\/([^/]+\/[^/]+)\/releases$/.exec(bare))) {
          const made: Release = { id: nextId++, repo: match[1] as string, tag_name: (body as { tag_name: string }).tag_name, draft: true, assets: [] };
          releases.set(made.id, made);
          return view(made) as T;
        }
        if (method === 'POST' && (match = /^\/repos\/([^/]+\/[^/]+)\/git\/refs$/.exec(bare))) {
          const { ref, sha } = body as { ref: string; sha: string };
          tags.set(`${match[1]}:${ref.replace('refs/tags/', '')}`, sha);
          return { ref } as T;
        }
        if ((match = /^\/repos\/[^/]+\/[^/]+\/releases\/(\d+)$/.exec(bare))) {
          const release = releases.get(Number(match[1]));
          if (!release) throw notFound(path);
          if (method === 'GET') return view(release) as T;
          if (method === 'PATCH') {
            release.draft = (body as { draft: boolean }).draft;
            if (!release.draft && options.failAfterPublish) throw options.failAfterPublish();
            return view(release) as T;
          }
          if (method === 'DELETE') {
            releases.delete(release.id);
            return {} as T;
          }
        }
        throw new Error(`the stub has no ${method} ${path}`);
      },
      async uploadReleaseAsset(repo, releaseId, name, body, bytes, _contentType): Promise<ReleaseAsset> {
        const text = body instanceof ReadableStream ? Buffer.from(await new Response(body).arrayBuffer()) : Buffer.from(body as string);
        calls.push({ as, method: 'UPLOAD', path: `/repos/${repo}/releases/${releaseId}/assets?name=${name}`, body: text.toString('utf8') });
        failing(`UPLOAD ${name}`);
        const release = releases.get(releaseId);
        if (!release) throw notFound('upload');
        const stored = options.rename ? options.rename(name) : name;
        release.assets.push({ name: stored, size: bytes });
        return {
          id: release.assets.length,
          name: stored,
          state: 'uploaded',
          size: text.length,
          digest: options.digest ? options.digest(stored) : `sha256:${createHash('sha256').update(text).digest('hex')}`,
          browser_download_url: downloadUrl(release, stored),
        };
      },
    };
  }
  return { calls, tags, releases, client };
}

/** hostd's signed answer for this run, with any field changed by `extra`. */
function signedAnswer(url: string, extra: Partial<SignedReleaseRun> = {}): SignedReleaseRun {
  const sig = 'c2ln'.repeat(22);
  return { sig, asset: `${JSON.stringify({ version: '1.4.0', url, sha256: SHA256, sig })}\n`, publicKey: 'cHVi', repo: 'acme/app', sha: SHA, version: '1.4.0', sha256: SHA256, bytes: BYTES.length, ...extra };
}

function hostd(options: { sign?: (url: string) => Promise<SignedReleaseRun>; artifact?: Partial<{ sha256: string; version: string; bytes: number }> } = {}) {
  const signed: string[] = [];
  const cancelled: unknown[] = [];
  return {
    signed,
    cancelled,
    releaseArtifact: vi.fn(async (_runId: string) => ({
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(BYTES));
          controller.close();
        },
        cancel(reason) {
          cancelled.push(reason);
        },
      }),
      sha256: SHA256,
      version: '1.4.0',
      bytes: BYTES.length,
      ...options.artifact,
    })),
    signRelease: vi.fn(async (_runId: string, url: string) => {
      signed.push(url);
      if (options.sign) return options.sign(url);
      return signedAnswer(url);
    }),
    deleteReleaseArtifact: vi.fn(async (_runId: string) => ({ deleted: true })),
  };
}

function publisher(github: ReturnType<typeof stubGitHub>, host = hostd(), extra: { installed?: string[]; setting?: ReleaseSetting } = {}) {
  const asked: string[] = [];
  const installed = extra.installed ?? ['acme/app', 'acme/app-releases'];
  const releases = new ReleasePublisher({
    app: async (repo) => {
      asked.push(repo);
      return installed.includes(repo) ? github.client(`app:${repo}`) : null;
    },
    hostd: host,
    getRelease: async () => extra.setting ?? SETTING,
    warn: () => undefined,
  });
  return { releases, host, asked };
}

const writes = (calls: Call[]) => calls.filter((call) => call.method !== 'GET').map((call) => `${call.method} ${call.path.split('?')[0]}`);

beforeEach(() => {
  store.row = builtRow();
  vi.clearAllMocks();
});

describe('publishing a built release as the app (#344)', () => {
  it('drafts, uploads, signs, uploads the manifest, tags the pinned SHA, publishes and reads back, in that order', async () => {
    const github = stubGitHub();
    const { releases, host } = publisher(github);
    const done = await releases.publish('run-1');

    expect(done).toMatchObject({
      state: 'published',
      tag: 'v1.4.0',
      tagged: true,
      releaseUrl: 'https://github.com/acme/app/releases/tag/v1.4.0',
      assetUrl: 'https://github.com/acme/app/releases/download/v1.4.0/App.zip',
    });
    expect(writes(github.calls)).toEqual([
      'POST /repos/acme/app/releases',
      'UPLOAD /repos/acme/app/releases/991/assets',
      'UPLOAD /repos/acme/app/releases/991/assets',
      'POST /repos/acme/app/git/refs',
      'PATCH /repos/acme/app/releases/991',
    ]);
    expect(github.calls.at(-1)).toMatchObject({ method: 'GET', path: '/repos/acme/app/releases/991' });
    // The sign comes between the artifact and the manifest.
    expect(host.signRelease).toHaveBeenCalledTimes(1);
    expect(github.calls.filter((call) => call.method === 'UPLOAD').map((call) => call.path)).toEqual([
      '/repos/acme/app/releases/991/assets?name=App.zip',
      '/repos/acme/app/releases/991/assets?name=manifest.json',
    ]);
    expect(github.calls.find((call) => call.method === 'UPLOAD')?.body).toBe('real bytes');
    expect(github.calls.find((call) => call.path.endsWith('name=manifest.json'))?.body).toContain('"url":"https://github.com/acme/app/releases/download/v1.4.0/App.zip"');
    expect(github.calls.find((call) => call.method === 'POST' && call.path.endsWith('/releases'))?.body).toMatchObject({ tag_name: 'v1.4.0', draft: true, target_commitish: SHA });
    expect(host.deleteReleaseArtifact).toHaveBeenCalledWith('run-1');
  });

  it('tags the built SHA though the default branch moved on, and never reads the source’s default branch', async () => {
    const github = stubGitHub();
    await publisher(github).releases.publish('run-1');
    expect(github.calls.find((call) => call.path === '/repos/acme/app/git/refs')?.body).toEqual({ ref: 'refs/tags/v1.4.0', sha: SHA });
    expect(github.tags.get('acme/app:v1.4.0')).toBe(SHA);
    expect(github.calls.some((call) => call.path.startsWith('/repos/acme/app/git/ref/heads/'))).toBe(false);
  });

  it('uses the app’s client for every call, on the repositories it publishes to only', async () => {
    const github = stubGitHub();
    const { releases, asked } = publisher(github);
    await releases.publish('run-1');
    expect(new Set(github.calls.map((call) => call.as))).toEqual(new Set(['app:acme/app']));
    expect(asked).toEqual(['acme/app']);
  });

  it('signs the URL built from GitHub’s name for the asset and the canonical full name, never the build’s output', async () => {
    const github = stubGitHub({ rename: (name) => name.replace(/ /g, '.'), fullName: () => 'Acme/App' });
    store.row = builtRow({ artifactName: 'My App.zip' });
    const { releases, host } = publisher(github);
    const done = await releases.publish('run-1');
    expect(host.signed).toEqual(['https://github.com/Acme/App/releases/download/v1.4.0/My.App.zip']);
    expect(host.signRelease.mock.calls[0]).toEqual(['run-1', 'https://github.com/Acme/App/releases/download/v1.4.0/My.App.zip']);
    expect(JSON.stringify(host.signRelease.mock.calls)).not.toContain('evil.example');
    expect(done?.state).toBe('published');
  });

  it('never sends hostd a version or sha256 to sign', async () => {
    const github = stubGitHub();
    const { releases, host } = publisher(github);
    await releases.publish('run-1');
    expect(host.signRelease.mock.calls[0]).toHaveLength(2);
  });

  it('uses the repository’s manifest asset name', async () => {
    const github = stubGitHub();
    const { releases } = publisher(github, hostd(), { setting: { ...SETTING, manifestAsset: 'app-manifest.json' } });
    await releases.publish('run-1');
    expect(github.calls.some((call) => call.path.endsWith('name=app-manifest.json'))).toBe(true);
  });

  it('with a separate release repository: tags the built SHA in the source, and its own default branch in the release repository', async () => {
    store.row = builtRow({ releaseRepo: 'acme/app-releases' });
    const github = stubGitHub();
    const done = await publisher(github).releases.publish('run-1');
    expect(done).toMatchObject({ state: 'published', assetUrl: 'https://github.com/acme/app-releases/releases/download/v1.4.0/App.zip' });
    expect(github.tags.get('acme/app:v1.4.0')).toBe(SHA);
    expect(github.tags.get('acme/app-releases:v1.4.0')).toBe(MOVED);
    expect(github.calls.find((call) => call.method === 'POST' && call.path.endsWith('/releases'))).toMatchObject({ path: '/repos/acme/app-releases/releases', body: { target_commitish: 'main' } });
  });
});

describe('what a failed run or publish leaves (#344)', () => {
  it('publishes nothing for a run that did not build', async () => {
    store.row = builtRow({ state: 'failed', version: null });
    const github = stubGitHub();
    await expect(publisher(github).releases.publish('run-1')).resolves.toBeNull();
    expect(github.calls).toEqual([]);
  });

  it.each([
    ['no key', () => Object.assign(new Error('no release signing key for acme/app. Run on the host: openadlc release-key import --repo acme/app --file <path>'), { status: 409 }), /release-key import/],
    ['a changed artifact', () => Object.assign(new Error('the kept artifact of release run run-1 no longer matches its build; cut the release again'), { status: 409 }), /no longer matches/],
    ['hostd failing', () => Object.assign(new Error('hostd refused with 500'), { status: 500 }), /500/],
  ])('leaves no tag and no draft when signing fails with %s', async (_name, error, reason) => {
    const github = stubGitHub();
    const { releases } = publisher(github, hostd({ sign: async () => Promise.reject(error()) }));
    const done = await releases.publish('run-1');
    expect(github.calls.some((call) => call.path.endsWith('/git/refs'))).toBe(false);
    expect(writes(github.calls)).toContain('DELETE /repos/acme/app/releases/991');
    expect(github.releases.size).toBe(0);
    expect(done).toMatchObject({ state: 'publish_failed', tagged: false });
    expect(done?.reason).toMatch(reason);
  });

  it('reverts to a draft what GitHub published under another URL, naming both, and deletes it', async () => {
    const github = stubGitHub({ publishedUrl: (url) => url.replace('/download/', '/download/x-') });
    const done = await publisher(github).releases.publish('run-1');
    expect(done?.state).toBe('publish_failed');
    expect(done?.reason).toContain('GitHub published https://github.com/acme/app/releases/download/x-v1.4.0/App.zip');
    expect(done?.reason).toContain('not the signed https://github.com/acme/app/releases/download/v1.4.0/App.zip');
    const patches = github.calls.filter((call) => call.method === 'PATCH').map((call) => call.body);
    expect(patches).toEqual([{ draft: false, make_latest: 'true' }, { draft: true }]);
    expect(github.releases.size).toBe(0);
    expect(done?.reason).toMatch(/v1\.4\.0 is on aaaaaaa in acme\/app/);
  });

  it('names a public release with an unsigned URL when it cannot be taken back, and leaves it', async () => {
    let patched = 0;
    const github = stubGitHub({
      publishedUrl: (url) => url.replace('/download/', '/download/x-'),
      fail: {
        get 'PATCH /repos/acme/app/releases/991'() {
          patched += 1;
          return patched > 1 ? () => new GitHubApiError(500, '/repos/acme/app/releases/991', '{"message":"boom"}') : (undefined as never);
        },
      },
    });
    const done = await publisher(github).releases.publish('run-1');
    expect(done?.reason).toMatch(/is public with a URL its manifest does not sign: delete it there/);
    expect(writes(github.calls)).not.toContain('DELETE /repos/acme/app/releases/991');
  });

  it('fails a publish after tagging saying where the tag is and what to do, deletes the draft, and a second cut reuses the tag', async () => {
    const github = stubGitHub({ fail: { 'PATCH /repos/acme/app/releases/991': () => new GitHubApiError(500, '/repos/acme/app/releases/991', '{"message":"Server Error"}') } });
    const done = await publisher(github).releases.publish('run-1');
    expect(done).toMatchObject({ state: 'publish_failed', tagged: true });
    expect(done?.reason).toContain('GitHub answered 500');
    expect(done?.reason).toContain('v1.4.0 is on aaaaaaa in acme/app. Cutting the same commit again reuses it. To build another commit, raise the version, or delete the tag at https://github.com/acme/app/tags');
    expect(writes(github.calls)).toContain('DELETE /repos/acme/app/releases/991');

    // The next cut of the same commit.
    store.row = builtRow({ runId: 'run-2' });
    const again = stubGitHub({ tags: { 'acme/app:v1.4.0': SHA } });
    const second = await publisher(again).releases.publish('run-2');
    expect(second).toMatchObject({ state: 'published', tagged: true });
    expect(again.calls.some((call) => call.path.endsWith('/git/refs'))).toBe(false);
  });

  it('names the draft to delete when its delete fails too', async () => {
    const github = stubGitHub({
      fail: {
        'POST /repos/acme/app/git/refs': () => new GitHubApiError(500, '/repos/acme/app/git/refs', '{"message":"boom"}'),
        'DELETE /repos/acme/app/releases/991': () => new GitHubApiError(500, '/repos/acme/app/releases/991', '{"message":"boom"}'),
      },
    });
    const done = await publisher(github).releases.publish('run-1');
    expect(done?.state).toBe('publish_failed');
    expect(done?.reason).toContain('The draft release at https://github.com/acme/app/releases/tag/untagged-0abc could not be deleted: delete it there');
  });

  it.each([
    ['another sha256', { sha256: 'b'.repeat(64) }],
    ['another size', { bytes: BYTES.length + 1 }],
    ['another version', { version: '1.4.1' }],
  ])('uploads nothing when hostd serves an artifact with %s than the row, deletes the draft and tags nothing', async (_name, artifact) => {
    const github = stubGitHub();
    const host = hostd({ artifact });
    const done = await publisher(github, host).releases.publish('run-1');
    expect(done).toMatchObject({ state: 'publish_failed', tagged: false });
    expect(done?.reason).toContain('hostd’s kept artifact is not the one recorded for this run');
    expect(github.calls.some((call) => call.method === 'UPLOAD')).toBe(false);
    expect(host.cancelled).toHaveLength(1);
    expect(writes(github.calls)).toContain('DELETE /repos/acme/app/releases/991');
    expect(github.releases.size).toBe(0);
    expect(host.signRelease).not.toHaveBeenCalled();
    expect(github.calls.some((call) => call.path.endsWith('/git/refs'))).toBe(false);
  });

  it.each([
    ['another commit', { sha: 'd'.repeat(40) }],
    ['another version', { version: '1.4.1' }],
    ['another sha256', { sha256: 'b'.repeat(64) }],
    ['another repository', { repo: 'acme/other' }],
  ])('uploads no manifest and tags nothing when hostd signs %s than the row', async (_name, extra) => {
    const github = stubGitHub();
    const host = hostd({ sign: async (url) => signedAnswer(url, extra) });
    const done = await publisher(github, host).releases.publish('run-1');
    expect(done).toMatchObject({ state: 'publish_failed', tagged: false });
    expect(done?.reason).toContain("which is not this run's acme/app@aaaaaaa 1.4.0");
    expect(host.signRelease).toHaveBeenCalledTimes(1);
    expect(github.calls.filter((call) => call.method === 'UPLOAD').map((call) => call.path)).toEqual(['/repos/acme/app/releases/991/assets?name=App.zip']);
    expect(github.calls.some((call) => call.path.endsWith('/git/refs'))).toBe(false);
    expect(writes(github.calls)).toContain('DELETE /repos/acme/app/releases/991');
    expect(github.releases.size).toBe(0);
  });

  it('signs nothing and tags nothing when GitHub’s digest of the upload is not the run’s sha256', async () => {
    const other = `sha256:${'e'.repeat(64)}`;
    const github = stubGitHub({ digest: () => other });
    const { releases, host } = publisher(github);
    const done = await releases.publish('run-1');
    expect(done).toMatchObject({ state: 'publish_failed', tagged: false });
    expect(done?.reason).toContain(`GitHub’s digest of the uploaded artifact is ${other}, not sha256:${SHA256}`);
    expect(host.signRelease).not.toHaveBeenCalled();
    expect(github.calls.some((call) => call.path.endsWith('/git/refs'))).toBe(false);
    expect(github.releases.size).toBe(0);
  });

  it('does not delete a release the publish may have made public when the read-back fails, and names it', async () => {
    const github = stubGitHub({ fail: { 'GET /repos/acme/app/releases/991': () => new GitHubApiError(502, '/repos/acme/app/releases/991', '{"message":"Bad Gateway"}') } });
    const done = await publisher(github).releases.publish('run-1');
    expect(done).toMatchObject({ state: 'publish_failed', tagged: true });
    expect(done?.reason).toContain('may be public, so it was not deleted');
    expect(done?.reason).toContain('v1.4.0 is on aaaaaaa in acme/app');
    expect(writes(github.calls)).not.toContain('DELETE /repos/acme/app/releases/991');
    expect(github.releases.get(991)?.draft).toBe(false);
  });

  it('does not delete a release GitHub published though its PATCH answered an error, and names it', async () => {
    const github = stubGitHub({ failAfterPublish: () => new GitHubApiError(504, '/repos/acme/app/releases/991', '{"message":"Gateway Timeout"}') });
    const done = await publisher(github).releases.publish('run-1');
    expect(done?.state).toBe('publish_failed');
    expect(done?.reason).toContain('The release at https://github.com/acme/app/releases/tag/v1.4.0 may be public, so it was not deleted');
    expect(writes(github.calls)).not.toContain('DELETE /repos/acme/app/releases/991');
  });

  it('refuses before anything is written when the manifest would take the artifact’s name', async () => {
    const github = stubGitHub();
    store.row = builtRow({ artifactName: 'manifest.json' });
    const done = await publisher(github).releases.publish('run-1');
    expect(done?.state).toBe('publish_failed');
    expect(done?.reason).toContain("the manifest asset's name, manifest.json, is the artifact's");
    expect(writes(github.calls)).toEqual([]);
  });

  it('says to add the bypass when the tag is refused by a rule', async () => {
    const github = stubGitHub({
      fail: { 'POST /repos/acme/app/git/refs': () => new GitHubApiError(422, '/repos/acme/app/git/refs', '{"message":"Repository rule violations found","errors":["Cannot create ref due to creations being restricted."]}') },
    });
    const done = await publisher(github).releases.publish('run-1');
    expect(done?.reason).toMatch(/Add OpenADLC's app as a bypass actor of the ruleset, set to Always/);
    expect(github.releases.size).toBe(0);
  });

  it('refuses a tag already on another commit before anything is written', async () => {
    const github = stubGitHub({ tags: { 'acme/app:v1.4.0': 'c'.repeat(40) } });
    const done = await publisher(github).releases.publish('run-1');
    expect(done).toMatchObject({ state: 'publish_failed' });
    expect(done?.reason).toContain('v1.4.0 is already on ccccccc in acme/app; raise the version in VERSION');
    expect(writes(github.calls)).toEqual([]);
  });

  it('refuses a release of the tag already published, before anything is written', async () => {
    const github = stubGitHub({ published: [{ id: 5, repo: 'acme/app', tag_name: 'v1.4.0', draft: false, assets: [] }] });
    const done = await publisher(github).releases.publish('run-1');
    expect(done?.reason).toContain('a release v1.4.0 is already published at https://github.com/acme/app/releases/tag/v1.4.0');
    expect(writes(github.calls)).toEqual([]);
  });

  it('refuses before anything is written when a tag ruleset blocks the app, in the card’s words', async () => {
    const github = stubGitHub({
      rulesets: [
        {
          id: 7,
          name: 'release tags',
          target: 'tag',
          enforcement: 'active',
          source_type: 'Repository',
          source: 'acme/app',
          conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
          rules: [{ type: 'creation' }],
          current_user_can_bypass: 'never',
        },
      ],
    });
    const done = await publisher(github).releases.publish('run-1');
    expect(done?.reason).toContain('The tag ruleset “release tags” lets only its bypass list create v1.4.0, and OpenADLC\'s app is not on it. Add the app as a bypass actor, set to Always.');
    expect(done?.reason).toContain('https://github.com/acme/app/settings/rules/7');
    expect(writes(github.calls)).toEqual([]);
  });

  it('refuses when the app is not installed on the release repository, saying to install it', async () => {
    store.row = builtRow({ releaseRepo: 'acme/app-releases' });
    const github = stubGitHub();
    const done = await publisher(github, hostd(), { installed: ['acme/app'] }).releases.publish('run-1');
    expect(done?.reason).toContain("OpenADLC's app is not installed on acme/app-releases");
    expect(github.calls).toEqual([]);
  });

  it('changes nothing when another publisher moved the row first', async () => {
    const github = stubGitHub();
    vi.mocked(releaseRuns.toPublishing).mockResolvedValueOnce(null);
    await expect(publisher(github).releases.publish('run-1')).resolves.toBeNull();
    expect(writes(github.calls)).toEqual([]);
  });

  it('cleans up a publishing row cut off by a restart, deleting its draft and naming its tag', async () => {
    const github = stubGitHub();
    const { releases } = publisher(github);
    // A draft left by the publisher that was cut off.
    const draft = await github.client('app:acme/app').request<{ id: number }>('POST', '/repos/acme/app/releases', { tag_name: 'v1.4.0' });
    store.row = builtRow({ state: 'publishing', tag: 'v1.4.0', releaseId: draft.id, tagged: true });
    const done = await releases.abandon(store.row);
    expect(done?.state).toBe('publish_failed');
    expect(done?.reason).toMatch(/^the bridge restarted while publishing\. v1\.4\.0 is on aaaaaaa in acme\/app/);
    expect(done?.reason).not.toContain('may also have been made');
    expect(github.releases.size).toBe(0);
  });

  it('says a restart may have left a tag on a separate release repository', async () => {
    const github = stubGitHub();
    const { releases } = publisher(github);
    store.row = builtRow({ state: 'publishing', tag: 'v1.4.0', releaseRepo: 'acme/app-releases', releaseId: null, tagged: true });
    const done = await releases.abandon(store.row);
    expect(done?.reason).toContain("v1.4.0 may also have been made on acme/app-releases's default branch");
  });
});

describe('who can start a publish (#344)', () => {
  it('is only ReleaseService: no other file calls publish on a publisher, and no route names it', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'));
    const importing = files.filter((name) => /from '\.\/release-publish\.js'/.test(readFileSync(join(dir, name), 'utf8')));
    expect(importing.sort()).toEqual(['main.ts', 'release-service.ts']);
    const calling = files.filter((name) => /publisher\??\s*\.\s*publish\s*\(/.test(readFileSync(join(dir, name), 'utf8')));
    expect(calling).toEqual(['release-service.ts']);
    // main.ts builds it and hands it to the service, and registers no route with it.
    const main = readFileSync(join(dir, 'main.ts'), 'utf8');
    expect(main).not.toMatch(/\.publish\(/);
  });
});
