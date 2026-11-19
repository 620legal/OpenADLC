import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReleaseRun, ReleaseSetting } from '@openadlc/db';
import { PersonFlows, type GitHubViewer, type PersonGitHubDeps } from './person-github.js';
import { RELEASE_CUT, RELEASE_CUT_REFUSED, ReleaseCuts, VIEW_TTL_MS, registerReleaseRoutes, type ReleaseCutDeps } from './release-routes.js';
import { Router } from './router.js';

/**
 * Cutting a release from the console (#345, ADR 0072): the compare view the
 * bridge pins, and the cut that names it, checked before and after a fresh
 * device-code sign-in. GitHub, People and the service are stand-ins; the
 * sign-in is the real `PersonFlows`, with GitHub's device flow stubbed.
 */

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const REPO = { id: 'repo-1', name: 'app', fullName: 'acme/app', defaultBranch: 'main' };
const SETTING: ReleaseSetting = { command: 'make release', artifact: 'build/App.zip', versionFile: 'VERSION', versionKey: null, releaseRepo: null, timeoutMinutes: 180, manifestAsset: null };
const JANE = 'jane@example.com';
const LINK = { githubLogin: 'jane', githubUserId: 101 };

function run(overrides: Partial<ReleaseRun> = {}): ReleaseRun {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    runId: 'run-1',
    repoId: REPO.id,
    repoName: REPO.name,
    repoFullName: REPO.fullName,
    sha: A,
    clean: false,
    command: SETTING.command,
    artifact: SETTING.artifact,
    versionFile: 'VERSION',
    versionKey: null,
    releaseRepo: null,
    timeoutMinutes: 180,
    previousVersion: '1.4.0',
    state: 'running',
    version: null,
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

interface Rig {
  cuts: ReleaseCuts;
  flows: PersonFlows;
  deps: ReleaseCutDeps;
  start: ReturnType<typeof vi.fn>;
  audits: { actor: string; action: string; target: string; payload: Record<string, unknown> }[];
  reads: string[];
  requestCode: ReturnType<typeof vi.fn>;
  /** Approves the pending code as this account; the poll then answers. */
  approve(viewer: GitHubViewer): Promise<void>;
  /** Fails the pending code's poll, as GitHub does once it expires. */
  expire(): Promise<void>;
  clock: { now: number };
  state: { approves: Set<number>; link: typeof LINK | null; version: string; compare: { status: number; body?: unknown }; last: { version: string; tag: string; url: string | null } | null; crew: Set<string> };
}

function rig(overrides: Partial<ReleaseCutDeps> = {}): Rig {
  const state: Rig['state'] = {
    approves: new Set([101]),
    link: LINK,
    version: '1.5.0\n',
    compare: {
      status: 200,
      body: {
        status: 'ahead',
        ahead_by: 2,
        total_commits: 2,
        commits: [
          { sha: 'c'.repeat(40), commit: { message: 'Older change\n\nbody' }, author: { login: 'ann' } },
          { sha: 'd'.repeat(40), commit: { message: 'Newer change' }, author: null },
        ],
        files: [{}, {}, {}],
        html_url: 'https://github.com/acme/app/compare/v1.4.0...aaaa',
      },
    },
    last: { version: '1.4.0', tag: 'v1.4.0', url: 'https://github.com/acme/app/releases/tag/v1.4.0' },
    crew: new Set(['atlas-bot']),
  };
  const clock = { now: Date.parse('2026-11-15T10:00:00Z') };
  const reads: string[] = [];
  let heads = 0;
  const reader = {
    request: vi.fn(async (_method: string, path: string): Promise<never> => {
      reads.push(path);
      if (path === '/repos/acme/app/git/ref/heads/main') {
        heads += 1;
        // The branch moves on as soon as the view has read it.
        return { object: { sha: heads === 1 ? A : B } } as never;
      }
      if (path.startsWith('/repos/acme/app/compare/')) {
        if (state.compare.status !== 200) throw Object.assign(new Error(`${path} → ${state.compare.status}`), { status: state.compare.status });
        return state.compare.body as never;
      }
      if (path.startsWith('/repos/acme/app/contents/VERSION?ref=')) {
        return { type: 'file', size: state.version.length, encoding: 'base64', content: Buffer.from(state.version).toString('base64') } as never;
      }
      throw Object.assign(new Error(`${path} → 404`), { status: 404 });
    }),
  };
  let answer: { resolve: (token: { accessToken: string }) => void; reject: (error: Error) => void } | null = null;
  let viewerIs: GitHubViewer = { login: 'jane', id: 101 };
  const requestCode = vi.fn(async () => ({ deviceCode: 'dev', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 }));
  const person: PersonGitHubDeps = {
    clientId: async () => 'client-id',
    clientSecret: async () => 'client-secret',
    requestCode,
    pollToken: () => new Promise((resolve, reject) => (answer = { resolve: resolve as never, reject })),
    viewer: async () => viewerIs,
    revoke: async () => true,
    isCrew: async (login) => state.crew.has(login),
    store: { link: vi.fn(), unlink: vi.fn(), ofIdentity: async () => state.link } as never,
    audit: async () => undefined,
  };
  const flows = new PersonFlows(person);
  const audits: Rig['audits'] = [];
  const start = vi.fn(async (input: { sha: string; clean: boolean }) => run({ sha: input.sha, clean: input.clean }));
  const deps: ReleaseCutDeps = {
    release: { start: start as never, lastRelease: async () => state.last },
    repo: async (name) => (name === 'app' || name === 'acme/app' ? REPO : null),
    getRelease: async () => SETTING,
    reader: async () => reader,
    runsOf: async () => [],
    run: async () => null,
    releasing: async () => [{ id: REPO.id, fullName: REPO.fullName, releaseRepo: null }],
    flows,
    linkOf: async () => state.link,
    isCrew: async (login) => state.crew.has(login),
    approves: async (id) => state.approves.has(id),
    audit: async (entry) => {
      audits.push(entry);
    },
    now: () => clock.now,
    warn: () => undefined,
    ...overrides,
  };
  return {
    cuts: new ReleaseCuts(deps),
    flows,
    deps,
    start,
    audits,
    reads,
    requestCode,
    clock,
    state,
    approve: async (viewer) => {
      viewerIs = viewer;
      answer?.resolve({ accessToken: 'gho_secret' });
      await flows.lastRun;
    },
    expire: async () => {
      answer?.reject(new Error('the code expired before it was approved'));
      await flows.lastRun;
    },
  };
}

const refusals = (audits: Rig['audits']) => audits.filter((entry) => entry.action === RELEASE_CUT_REFUSED).map((entry) => entry.payload);

async function failedWith(r: Rig, flowId: string): Promise<string | undefined> {
  const seen = r.flows.state<unknown>(flowId, JANE);
  return 'error' in seen ? seen.error : undefined;
}

describe('the compare view', () => {
  it('pins the head it read, compares the last tag with that SHA, and reads the version there', async () => {
    const r = rig();
    const view = await r.cuts.view('app', JANE);
    expect(view).toMatchObject({
      sha: A,
      defaultBranch: 'main',
      last: { version: '1.4.0', tag: 'v1.4.0' },
      version: { text: '1.5.0', after: '1.4.0' },
      compare: { first: false, status: 'ahead', aheadBy: 2, totalCommits: 2, files: 3 },
      mayCut: true,
    });
    // The newest first.
    expect(view.compare).toMatchObject({ commits: [{ sha7: 'ddddddd', title: 'Newer change', author: null }, { sha7: 'ccccccc', title: 'Older change', author: 'ann' }] });
    expect(r.reads).toContain(`/repos/acme/app/compare/v1.4.0...${A}`);
    expect(r.reads).toContain(`/repos/acme/app/contents/VERSION?ref=${A}`);
    expect(r.reads.filter((path) => path.includes('/compare/')).every((path) => !path.endsWith('...main'))).toBe(true);
  });

  it('says it is the first release when there is none', async () => {
    const r = rig();
    r.state.last = null;
    const view = await r.cuts.view('app', JANE);
    expect(view).toMatchObject({ compare: { first: true }, last: null, version: { text: '1.5.0', after: null }, mayCut: true });
    expect(r.reads.some((path) => path.includes('/compare/'))).toBe(false);
  });

  it('offers no cut when the tag is not in the repository, or the head does not contain it', async () => {
    const missing = rig();
    missing.state.compare = { status: 404 };
    expect(await missing.cuts.view('app', JANE)).toMatchObject({ mayCut: false, why: expect.stringContaining('has no tag v1.4.0 to compare with') });

    const diverged = rig();
    diverged.state.compare = { status: 200, body: { status: 'diverged', ahead_by: 1, behind_by: 1, commits: [], files: [] } };
    expect(await diverged.cuts.view('app', JANE)).toMatchObject({ mayCut: false, why: `aaaaaaa does not contain v1.4.0, so it cannot be released after it.` });

    const behind = rig();
    behind.state.compare = { status: 200, body: { status: 'behind', commits: [], files: [] } };
    expect(await behind.cuts.view('app', JANE)).toMatchObject({ mayCut: false });
  });

  it('refuses with no recipe, and says the last release could not be read rather than "no release"', async () => {
    await expect(rig({ getRelease: async () => null }).cuts.view('app', JANE)).rejects.toMatchObject({ status: 404, message: expect.stringContaining('Settings → app → Release') });
    await expect(rig({ release: { start: vi.fn() as never, lastRelease: async () => Promise.reject(new Error('GitHub answered 502')) } }).cuts.view('app', JANE)).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining('GitHub answered 502'),
    });
    await expect(rig().cuts.view('nope', JANE)).rejects.toMatchObject({ status: 404 });
  });

  it('holds the version above the last release by hostd’s rule, a label mismatch and an unreadable file included', async () => {
    const same = rig();
    same.state.version = '1.4.0';
    expect(await same.cuts.view('app', JANE)).toMatchObject({ mayCut: false, why: '1.4.0 is not above the last release, 1.4.0: raise it in VERSION' });

    const label = rig();
    label.state.last = { version: '1.4.0-beta.2', tag: 'v1.4.0-beta.2', url: null };
    label.state.version = '1.4.0-rc.3';
    expect(await label.cuts.view('app', JANE)).toMatchObject({ mayCut: false, why: expect.stringContaining('use beta in VERSION') });

    const junk = rig();
    junk.state.version = 'one point five';
    expect(await junk.cuts.view('app', JANE)).toMatchObject({ mayCut: false, why: expect.stringContaining('is not a release version') });
  });

  it('says why this viewer may not cut: no link, or Approves off', async () => {
    const unlinked = rig();
    unlinked.state.link = null;
    expect(await unlinked.cuts.view('app', JANE)).toMatchObject({ mayCut: false, why: expect.stringContaining('Link your GitHub account'), url: '/settings#your-github' });
    const off = rig();
    off.state.approves.clear();
    expect(await off.cuts.view('app', JANE)).toMatchObject({ mayCut: false, why: expect.stringContaining('Approves is off'), url: '/settings#people' });
  });

  it('says a release in flight, with a link to it', async () => {
    const r = rig({ runsOf: async () => [run({ state: 'publishing' })] });
    expect(await r.cuts.view('app', JANE)).toMatchObject({ mayCut: false, why: expect.stringContaining('in flight (publishing)'), inFlight: { state: 'publishing' } });
  });
});

describe('cutting a release', () => {
  it('starts the run for the SHA the view showed, not the branch’s later head (criterion 4)', async () => {
    const r = rig();
    const view = await r.cuts.view('app', JANE);
    const readsAtView = r.reads.length;
    const { flow } = await r.cuts.cut('app', JANE, { viewId: view.viewId, clean: true });
    expect(flow).toMatchObject({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device' });
    await r.approve({ login: 'jane', id: 101 });

    expect(r.start).toHaveBeenCalledTimes(1);
    expect(r.start).toHaveBeenCalledWith({ repo: REPO, sha: A, clean: true, by: { login: 'jane', githubUserId: 101 } });
    // Nothing after the view read the branch again.
    expect(r.reads.slice(readsAtView).some((path) => path.includes('/git/ref/heads/'))).toBe(false);
    const cut = r.audits.find((entry) => entry.action === RELEASE_CUT);
    expect(cut).toMatchObject({ actor: JANE, target: 'acme/app:release', payload: { sha: A, version: '1.5.0', after: '1.4.0', clean: true, login: 'jane', githubUserId: 101, runId: 'run-1' } });
    expect(await r.cuts.flowState(flow.flowId, JANE)).toEqual({ state: 'done', runId: 'run-1', id: run().id });

    // A second view sees the moved head.
    expect((await r.cuts.view('app', JANE)).sha).toBe(B);
  });

  it('refuses a body that carries a SHA, or anything beyond { viewId, clean }', async () => {
    const r = rig();
    const view = await r.cuts.view('app', JANE);
    await expect(r.cuts.cut('app', JANE, { viewId: view.viewId, sha: B })).rejects.toMatchObject({ status: 400, message: 'the commit is the one the view showed; reload to see the new head' });
    await expect(r.cuts.cut('app', JANE, { viewId: view.viewId, ref: 'main' })).rejects.toMatchObject({ status: 400 });
    await expect(r.cuts.cut('app', JANE, { viewId: view.viewId, clean: 'yes' })).rejects.toMatchObject({ status: 400 });
    await expect(r.cuts.cut('app', JANE, null)).rejects.toMatchObject({ status: 400 });
    expect(r.requestCode).not.toHaveBeenCalled();
    expect(refusals(r.audits).map((row) => row.reason)).toEqual(['bad_body', 'bad_body', 'bad_body', 'bad_body']);
  });

  it('refuses a person without Approves before any sign-in, and audits it (criterion 1)', async () => {
    const r = rig();
    r.state.approves.clear();
    const view = await r.cuts.view('app', JANE);
    await expect(r.cuts.cut('app', JANE, { viewId: view.viewId })).rejects.toMatchObject({ status: 403, details: { url: '/settings#people' } });
    expect(r.requestCode).not.toHaveBeenCalled();
    expect(r.start).not.toHaveBeenCalled();
    expect(refusals(r.audits)).toEqual([expect.objectContaining({ reason: 'approves_off', stage: 'before_sign_in', viewSha: A, linkedLogin: 'jane', linkedId: 101, by: JANE })]);
  });

  it('refuses a person with no linked account (criterion 1)', async () => {
    const r = rig();
    const view = await r.cuts.view('app', JANE);
    r.state.link = null;
    await expect(r.cuts.cut('app', JANE, { viewId: view.viewId })).rejects.toMatchObject({ status: 403 });
    expect(r.requestCode).not.toHaveBeenCalled();
    expect(refusals(r.audits)).toEqual([expect.objectContaining({ reason: 'not_linked', stage: 'before_sign_in' })]);
  });

  it('refuses after the sign-in when Approves was turned off meanwhile (criterion 1)', async () => {
    const r = rig();
    const view = await r.cuts.view('app', JANE);
    const { flow } = await r.cuts.cut('app', JANE, { viewId: view.viewId });
    r.state.approves.clear();
    await r.approve({ login: 'jane', id: 101 });
    expect(r.start).not.toHaveBeenCalled();
    expect(await failedWith(r, flow.flowId)).toContain('Approves is off');
    expect(refusals(r.audits)).toEqual([expect.objectContaining({ reason: 'approves_off', stage: 'after_sign_in', login: 'jane', githubUserId: 101 })]);
  });

  it('refuses after the sign-in when Approves cannot be read then, though it passed before', async () => {
    let failing = false;
    const r = rig({
      approves: async (id) => {
        if (failing) throw new Error('people store unreachable');
        return id === 101;
      },
    });
    const view = await r.cuts.view('app', JANE);
    const { flow } = await r.cuts.cut('app', JANE, { viewId: view.viewId });
    failing = true;
    await r.approve({ login: 'jane', id: 101 });
    expect(r.start).not.toHaveBeenCalled();
    expect(await failedWith(r, flow.flowId)).toContain('Approves is off');
    expect(refusals(r.audits)).toEqual([expect.objectContaining({ reason: 'approves_off', stage: 'after_sign_in', login: 'jane', githubUserId: 101 })]);
    expect(r.audits.some((entry) => entry.action === RELEASE_CUT)).toBe(false);
  });

  it('refuses after the sign-in when whether the account is the crew’s cannot be read', async () => {
    const r = rig({ isCrew: async () => Promise.reject(new Error('crew list unreadable')) });
    const view = await r.cuts.view('app', JANE);
    const { flow } = await r.cuts.cut('app', JANE, { viewId: view.viewId });
    await r.approve({ login: 'jane', id: 101 });
    expect(r.start).not.toHaveBeenCalled();
    expect(await failedWith(r, flow.flowId)).toContain('a bot never cuts a release');
    expect(refusals(r.audits)).toEqual([expect.objectContaining({ reason: 'crew_account', stage: 'after_sign_in', login: 'jane', githubUserId: 101 })]);
    expect(r.audits.some((entry) => entry.action === RELEASE_CUT)).toBe(false);
  });

  it('refuses after the sign-in when the view expired while the code waited', async () => {
    const r = rig();
    const view = await r.cuts.view('app', JANE);
    const { flow } = await r.cuts.cut('app', JANE, { viewId: view.viewId });
    r.clock.now += VIEW_TTL_MS;
    await r.approve({ login: 'jane', id: 101 });
    expect(r.start).not.toHaveBeenCalled();
    expect(await failedWith(r, flow.flowId)).toContain('expired');
    expect(refusals(r.audits)).toEqual([expect.objectContaining({ reason: 'view_gone', stage: 'after_sign_in', viewSha: A, login: 'jane', githubUserId: 101 })]);
    expect(r.audits.some((entry) => entry.action === RELEASE_CUT)).toBe(false);
  });

  it('refuses a code approved by another account id, or another login (criterion 2)', async () => {
    for (const viewer of [
      { login: 'jane', id: 202 },
      { login: 'mallory', id: 101 },
    ]) {
      const r = rig();
      const view = await r.cuts.view('app', JANE);
      const { flow } = await r.cuts.cut('app', JANE, { viewId: view.viewId });
      await r.approve(viewer);
      expect(r.start).not.toHaveBeenCalled();
      expect(await failedWith(r, flow.flowId)).toContain(`You approved the code as @${viewer.login}`);
      expect(refusals(r.audits)).toEqual([expect.objectContaining({ reason: 'other_account', stage: 'after_sign_in', login: viewer.login, githubUserId: viewer.id })]);
    }
  });

  it('accepts the linked login whatever its case', async () => {
    const r = rig();
    const view = await r.cuts.view('app', JANE);
    await r.cuts.cut('app', JANE, { viewId: view.viewId });
    await r.approve({ login: 'Jane', id: 101 });
    expect(r.start).toHaveBeenCalledTimes(1);
  });

  it('audits a code that expired, or a poll that failed, and starts nothing (criterion 2)', async () => {
    const r = rig();
    const view = await r.cuts.view('app', JANE);
    const { flow } = await r.cuts.cut('app', JANE, { viewId: view.viewId });
    await r.expire();
    expect(await r.cuts.flowState(flow.flowId, JANE)).toMatchObject({ state: 'failed', error: expect.stringContaining('expired') });
    expect(r.start).not.toHaveBeenCalled();
    expect(refusals(r.audits)).toEqual([expect.objectContaining({ reason: 'sign_in_failed', stage: 'after_sign_in', why: expect.stringContaining('expired'), viewSha: A })]);
    // Audited once, however often it is swept.
    await r.cuts.sweepFlows();
    expect(refusals(r.audits)).toHaveLength(1);
  });

  it('refuses a crew account that approved the code (criterion 3)', async () => {
    const r = rig();
    r.state.link = { githubLogin: 'atlas-bot', githubUserId: 900 };
    r.state.approves.add(900);
    const view = await r.cuts.view('app', JANE);
    const { flow } = await r.cuts.cut('app', JANE, { viewId: view.viewId });
    await r.approve({ login: 'atlas-bot', id: 900 });
    expect(r.start).not.toHaveBeenCalled();
    expect(await failedWith(r, flow.flowId)).toContain('a bot never cuts a release');
    expect(refusals(r.audits)).toEqual([expect.objectContaining({ reason: 'crew_account', stage: 'after_sign_in', login: 'atlas-bot' })]);
  });

  it('refuses a view that is another identity’s, expired, spent, or unknown (criterion 2)', async () => {
    const r = rig();
    const view = await r.cuts.view('app', JANE);
    await expect(r.cuts.cut('app', 'bob@example.com', { viewId: view.viewId })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('expired') });
    await expect(r.cuts.cut('app', JANE, { viewId: 'no-such-view' })).rejects.toMatchObject({ status: 409 });

    r.clock.now += VIEW_TTL_MS;
    await expect(r.cuts.cut('app', JANE, { viewId: view.viewId })).rejects.toMatchObject({ status: 409 });

    const spent = await r.cuts.view('app', JANE);
    await r.cuts.cut('app', JANE, { viewId: spent.viewId });
    await r.approve({ login: 'jane', id: 101 });
    await expect(r.cuts.cut('app', JANE, { viewId: spent.viewId })).rejects.toMatchObject({ status: 409 });

    expect(refusals(r.audits).map((row) => row.reason)).toEqual(['view_gone', 'view_gone', 'view_gone', 'view_gone']);
    expect(r.start).toHaveBeenCalledTimes(1);
  });

  it('refuses a view whose version is not above before any sign-in (criterion 6)', async () => {
    const r = rig();
    r.state.version = '1.4.0';
    const view = await r.cuts.view('app', JANE);
    await expect(r.cuts.cut('app', JANE, { viewId: view.viewId })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('is not above the last release') });
    expect(r.requestCode).not.toHaveBeenCalled();
    expect(refusals(r.audits)).toEqual([expect.objectContaining({ reason: 'version_not_above', stage: 'before_sign_in' })]);
  });

  it('starts a fresh sign-in for each cut, and refuses a second press while one waits (criterion 7)', async () => {
    const r = rig();
    const view = await r.cuts.view('app', JANE);
    await r.cuts.cut('app', JANE, { viewId: view.viewId });
    await expect(r.cuts.cut('app', JANE, { viewId: view.viewId })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('still waiting') });
    expect(r.requestCode).toHaveBeenCalledTimes(1);
    expect(refusals(r.audits)).toEqual([expect.objectContaining({ reason: 'already_signing' })]);
  });

  it('leaves the view unspent when the service refuses, so the person can try again with a new proof', async () => {
    const r = rig();
    r.start.mockRejectedValueOnce(Object.assign(new Error('hostd names no release account'), { status: 409 }));
    const view = await r.cuts.view('app', JANE);
    const { flow } = await r.cuts.cut('app', JANE, { viewId: view.viewId });
    await r.approve({ login: 'jane', id: 101 });
    expect(await failedWith(r, flow.flowId)).toBe('hostd names no release account');
    expect(refusals(r.audits)).toEqual([expect.objectContaining({ reason: 'service_refused', stage: 'after_sign_in' })]);

    await r.cuts.cut('app', JANE, { viewId: view.viewId });
    expect(r.requestCode).toHaveBeenCalledTimes(2);
    await r.approve({ login: 'jane', id: 101 });
    expect(r.start).toHaveBeenCalledTimes(2);
    expect(r.start).toHaveBeenLastCalledWith(expect.objectContaining({ sha: A }));
  });

  it('refuses to cut while a release of the repository is in flight', async () => {
    const runs: ReleaseRun[] = [];
    const r = rig({ runsOf: async () => runs });
    const view = await r.cuts.view('app', JANE);
    runs.push(run({ state: 'running' }));
    await expect(r.cuts.cut('app', JANE, { viewId: view.viewId })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('in flight') });
    expect(refusals(r.audits)).toEqual([expect.objectContaining({ reason: 'in_flight' })]);
  });

  it('refuses a person and says so in the log when the refusal cannot be audited', async () => {
    const warn = vi.fn();
    const r = rig({ audit: async () => Promise.reject(new Error('database down')), warn });
    r.state.approves.clear();
    const view = await r.cuts.view('app', JANE);
    await expect(r.cuts.cut('app', JANE, { viewId: view.viewId })).rejects.toMatchObject({ status: 403 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('was not audited'));
  });
});

describe('Prepare next version on the view (#363)', () => {
  const OPEN = { requestId: 'abcdef12-0000-4000-8000-000000000000', subject: 'request:abcdef12', state: 'draft' as const, version: '1.4.1', issue: null, pullRequest: null, unknown: false };

  it('offers it, with the suggestion, only for a version at or below the last release', async () => {
    const same = rig();
    same.state.version = '1.4.0';
    expect(await same.cuts.view('app', JANE)).toMatchObject({
      mayCut: false,
      prepare: { suggested: '1.4.1', last: { version: '1.4.0', tag: 'v1.4.0' }, versionFile: 'VERSION', versionKey: null },
      preparing: null,
    });

    const below = rig();
    below.state.version = '1.3.0';
    expect((await below.cuts.view('app', JANE)).prepare).toMatchObject({ suggested: '1.4.1' });

    const labelled = rig();
    labelled.state.last = { version: '156.0.8078.79-abc.29', tag: 'v156.0.8078.79-abc.29', url: null };
    labelled.state.version = '156.0.8078.79-abc.29';
    expect((await labelled.cuts.view('app', JANE)).prepare).toMatchObject({ suggested: '156.0.8078.79-abc.30', last: { tag: 'v156.0.8078.79-abc.29' } });

    expect((await rig().cuts.view('app', JANE)).prepare).toBeNull();
  });

  it('does not offer it for any other refusal, or to a viewer who may not cut', async () => {
    const cases: [string, (r: Rig) => void, Partial<ReleaseCutDeps>?][] = [
      ['no tag', (r) => (r.state.compare = { status: 404 })],
      ['diverged', (r) => (r.state.compare = { status: 200, body: { status: 'diverged', commits: [], files: [] } })],
      ['behind', (r) => (r.state.compare = { status: 200, body: { status: 'behind', commits: [], files: [] } })],
      [
        'another label',
        (r) => {
          r.state.last = { version: '1.4.0-beta.2', tag: 'v1.4.0-beta.2', url: null };
          r.state.version = '1.4.0-rc.1';
        },
      ],
      ['no version file', (r) => (r.state.version = 'not a version')],
      ['no link', (r) => (r.state.link = null)],
      ['Approves off', (r) => r.state.approves.clear()],
      ['in flight', () => undefined, { runsOf: async () => [run({ state: 'running' })] }],
      ['already preparing', () => undefined, { preparing: async () => OPEN }],
    ];
    for (const [name, arrange, overrides] of cases) {
      const r = rig(overrides);
      if (name !== 'another label' && name !== 'no version file') r.state.version = '1.4.0';
      arrange(r);
      const view = await r.cuts.view('app', JANE);
      expect({ name, prepare: view.prepare, mayCut: view.mayCut }).toEqual({ name, prepare: null, mayCut: false });
    }
  });

  it('shows the open preparation, and says nothing of one it could not read', async () => {
    const r = rig({ preparing: async () => OPEN });
    r.state.version = '1.4.0';
    expect(await r.cuts.view('app', JANE)).toMatchObject({ prepare: null, preparing: OPEN });
    const failing = rig({ preparing: async () => Promise.reject(new Error('database down')) });
    failing.state.version = '1.4.0';
    expect(await failing.cuts.view('app', JANE)).toMatchObject({ prepare: { suggested: '1.4.1' }, preparing: null });
  });

  it('answers preparable for the view’s own viewer, never spending the view or starting a run', async () => {
    const r = rig();
    r.state.version = '1.4.0';
    const view = await r.cuts.view('app', JANE);
    const answer = await r.cuts.preparable(view.viewId, JANE, 'app');
    expect(answer).toMatchObject({ ok: true, preparable: { repo: REPO, last: { version: { text: '1.4.0' }, tag: 'v1.4.0' }, versionFile: 'VERSION', versionKey: null, link: LINK } });
    expect(JSON.stringify(answer)).not.toContain(A);
    // Asked twice, still the same view, and it can still be pressed.
    expect((await r.cuts.preparable(view.viewId, JANE, 'app')).ok).toBe(true);
    expect(r.start).not.toHaveBeenCalled();
    expect(r.requestCode).not.toHaveBeenCalled();
    expect(r.audits).toEqual([]);
  });

  it('refuses preparable for a gone view, a view not offered, a release in flight, no link or Approves off', async () => {
    const r = rig();
    r.state.version = '1.4.0';
    const view = await r.cuts.view('app', JANE);
    expect(await r.cuts.preparable(view.viewId, 'bob@example.com', 'app')).toMatchObject({ ok: false, refusal: { status: 409, reason: 'view_gone' } });
    expect(await r.cuts.preparable('no-such-view', JANE, 'app')).toMatchObject({ ok: false, refusal: { reason: 'view_gone' } });
    expect(await r.cuts.preparable(view.viewId, JANE, 'other')).toMatchObject({ ok: false, refusal: { reason: 'view_gone' } });

    const above = rig();
    const cuttable = await above.cuts.view('app', JANE);
    expect(await above.cuts.preparable(cuttable.viewId, JANE, 'app')).toMatchObject({ ok: false, refusal: { status: 409, reason: 'not_offered' } });

    const label = rig();
    label.state.last = { version: '1.4.0-beta.2', tag: 'v1.4.0-beta.2', url: null };
    label.state.version = '1.4.0-rc.1';
    const labelled = await label.cuts.view('app', JANE);
    expect(await label.cuts.preparable(labelled.viewId, JANE, 'app')).toMatchObject({ ok: false, refusal: { reason: 'not_offered' } });

    const runs: ReleaseRun[] = [];
    const going = rig({ runsOf: async () => runs });
    going.state.version = '1.4.0';
    const goingView = await going.cuts.view('app', JANE);
    runs.push(run({ state: 'running' }));
    expect(await going.cuts.preparable(goingView.viewId, JANE, 'app')).toMatchObject({ ok: false, refusal: { status: 409, reason: 'in_flight' } });

    const r2 = rig();
    r2.state.version = '1.4.0';
    const v2 = await r2.cuts.view('app', JANE);
    r2.state.approves.clear();
    expect(await r2.cuts.preparable(v2.viewId, JANE, 'app')).toMatchObject({ ok: false, refusal: { status: 403, reason: 'approves_off', url: '/settings#people' } });
    r2.state.link = null;
    expect(await r2.cuts.preparable(v2.viewId, JANE, 'app')).toMatchObject({ ok: false, refusal: { status: 403, reason: 'not_linked', url: '/settings#your-github' } });

    r.clock.now += VIEW_TTL_MS;
    expect(await r.cuts.preparable(view.viewId, JANE, 'app')).toMatchObject({ ok: false, refusal: { reason: 'view_gone' } });
    for (const one of [r, above, label, going, r2]) expect(one.start).not.toHaveBeenCalled();
  });
});

describe('the routes', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  async function serve(r: Rig) {
    const router = new Router(undefined, undefined, undefined, async () => 'user');
    registerReleaseRoutes(router, r.cuts);
    server = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const as = (identity: string) => ({ 'x-openadlc-identity': identity, 'content-type': 'application/json' });
    return { url, as };
  }

  let r: Rig;
  beforeEach(() => {
    r = rig();
  });

  it('builds a view, refuses a cut with a SHA, cuts by the view, and says the flow only to its identity', async () => {
    const { url, as } = await serve(r);
    const view = (await (await fetch(`${url}/v1/repos/app/release/views`, { method: 'POST', headers: as(JANE) })).json()) as { viewId: string; sha: string };
    expect(view.sha).toBe(A);

    const withSha = await fetch(`${url}/v1/repos/app/release/cut`, { method: 'POST', headers: as(JANE), body: JSON.stringify({ viewId: view.viewId, sha: B }) });
    expect(withSha.status).toBe(400);
    expect(((await withSha.json()) as { error: string }).error).toContain('reload to see the new head');

    const cut = await fetch(`${url}/v1/repos/app/release/cut`, { method: 'POST', headers: as(JANE), body: JSON.stringify({ viewId: view.viewId }) });
    const { flow } = (await cut.json()) as { flow: { flowId: string } };
    expect(await (await fetch(`${url}/v1/repos/app/release/flows/${flow.flowId}`, { headers: as('bob@example.com') })).json()).toEqual({ state: 'none' });
    expect(await (await fetch(`${url}/v1/repos/app/release/flows/${flow.flowId}`, { headers: as(JANE) })).json()).toEqual({ state: 'waiting' });
    await r.approve({ login: 'jane', id: 101 });
    expect(await (await fetch(`${url}/v1/repos/app/release/flows/${flow.flowId}`, { headers: as(JANE) })).json()).toMatchObject({ state: 'done', runId: 'run-1' });
    expect(r.start).toHaveBeenCalledWith(expect.objectContaining({ sha: A }));
  });

  it('lists the releasing repositories and a repository’s runs to anyone, and 404s an unknown run', async () => {
    r = rig({ runsOf: async (_id, limit) => [run({ state: 'published', releaseUrl: 'https://github.com/acme/app/releases/tag/v1.5.0' })].slice(0, limit) });
    const { url, as } = await serve(r);
    expect(await (await fetch(`${url}/v1/releases`, { headers: as('bob@example.com') })).json()).toMatchObject({
      repos: [{ name: 'app', fullName: 'acme/app', latest: { state: 'published', releaseUrl: 'https://github.com/acme/app/releases/tag/v1.5.0' } }],
    });
    expect(await (await fetch(`${url}/v1/repos/app/releases`, { headers: as('bob@example.com') })).json()).toMatchObject({ runs: [{ state: 'published' }] });
    expect((await fetch(`${url}/v1/releases/nope`, { headers: as('bob@example.com') })).status).toBe(404);
  });
});

describe('ReleaseService.start has one caller', () => {
  it('is called only from the cut’s sign-in in release-routes.ts', () => {
    const root = dirname(fileURLToPath(import.meta.url));
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          // `release.start(` is how a holder of the service reaches it; `releaseRuns.start(` in the
          // service is the database's row, not the service.
          if (/\brelease\.start\(|\breleases?Service\.start\(|\breleaseRuns\.start\(\{\s*repo/.test(readFileSync(path, 'utf8'))) callers.push(path.slice(root.length + 1));
        }
      }
    };
    walk(root);
    expect(callers).toEqual(['release-routes.ts']);
    const source = readFileSync(join(root, 'release-routes.ts'), 'utf8');
    expect(source.match(/\.release\.start\(/g)).toHaveLength(1);
    // Inside `use`, which runs only once the person approved the code.
    const use = source.slice(source.indexOf('private async use('), source.indexOf('async sweepFlows('));
    expect(use).toContain('this.deps.release.start(');
  });
});
