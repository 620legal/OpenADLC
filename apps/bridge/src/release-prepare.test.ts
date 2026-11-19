import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReleaseSetting, requests } from '@openadlc/db';
import { PersonFlows, type PersonGitHubDeps } from './person-github.js';
import { RELEASE_PREPARE_REFUSED, RELEASE_PREPARE_REQUESTED, ReleasePrepare, registerReleasePrepareRoutes, type ReleasePrepareDeps } from './release-prepare.js';
import { ReleaseCuts, type ReleaseCutDeps } from './release-routes.js';
import { Router } from './router.js';

/**
 * Prepare next version (#363, ADR 0078): a press on a release page whose head
 * version is not above the last release files one console request for the
 * crew, in the approver's name, and nothing else. The view and its checks are
 * the real `ReleaseCuts`, with GitHub, People and the service stood in; the
 * service's `start` is a spy that must never be called.
 */

const A = 'a'.repeat(40);
const REPO = { id: 'repo-1', name: 'app', fullName: 'acme/app', defaultBranch: 'main' };
const SETTING: ReleaseSetting = { command: 'make release', artifact: 'build/App.zip', versionFile: 'VERSION', versionKey: null, releaseRepo: null, timeoutMinutes: 180, manifestAsset: null };
const JANE = 'jane@example.com';
const REQUEST_ID = 'abcdef12-0000-4000-8000-000000000001';

type RequestRecord = requests.RequestRecord;

function request(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    id: REQUEST_ID,
    text: 'Raise app',
    context: null,
    repoId: REPO.id,
    kind: 'feature',
    requestedBy: JANE,
    issueNumber: null,
    issues: [],
    state: 'queued',
    createdAt: '2026-11-19T00:00:00.000Z',
    queueAttempts: 0,
    queueReason: null,
    updatedAt: '2026-11-19T00:00:00.000Z',
    ...overrides,
  };
}

interface Rig {
  prepare: ReleasePrepare;
  cuts: ReleaseCuts;
  start: ReturnType<typeof vi.fn>;
  file: ReturnType<typeof vi.fn>;
  audits: { actor: string; action: string; target: string; payload: Record<string, unknown> }[];
  state: {
    version: string;
    last: { version: string; tag: string; url: string | null };
    link: { githubLogin: string; githubUserId: number } | null;
    approves: Set<number>;
    crew: Set<string>;
    requests: Map<string, RequestRecord>;
    /** GitHub's issues and pulls by path; a missing path fails the read. */
    github: Map<string, unknown>;
    prs: Map<number, number>;
  };
}

function rig(overrides: Partial<ReleasePrepareDeps> = {}): Rig {
  const state: Rig['state'] = {
    version: '1.4.0\n',
    last: { version: '1.4.0', tag: 'v1.4.0', url: null },
    link: { githubLogin: 'jane', githubUserId: 101 },
    approves: new Set([101]),
    crew: new Set(['atlas-bot']),
    requests: new Map(),
    github: new Map(),
    prs: new Map(),
  };
  const reader = {
    request: vi.fn(async (_method: string, path: string): Promise<never> => {
      if (path === '/repos/acme/app/git/ref/heads/main') return { object: { sha: A } } as never;
      if (path.startsWith('/repos/acme/app/compare/')) return { status: 'ahead', ahead_by: 1, total_commits: 1, commits: [], files: [] } as never;
      if (path.startsWith('/repos/acme/app/contents/VERSION?ref=')) return { type: 'file', encoding: 'base64', content: Buffer.from(state.version).toString('base64') } as never;
      if (state.github.has(path)) return state.github.get(path) as never;
      throw Object.assign(new Error(`${path} → 502`), { status: 502 });
    }),
  };
  const person = { requestCode: vi.fn(), isCrew: async () => false } as unknown as PersonGitHubDeps;
  const start = vi.fn();
  const audits: Rig['audits'] = [];
  let prepare: ReleasePrepare | null = null;
  const cutDeps: ReleaseCutDeps = {
    release: { start: start as never, lastRelease: async () => state.last },
    repo: async (name) => (name === 'app' ? REPO : null),
    getRelease: async () => SETTING,
    reader: async () => reader,
    runsOf: async () => [],
    run: async () => null,
    releasing: async () => [],
    flows: new PersonFlows(person),
    linkOf: async () => state.link,
    isCrew: async (login) => state.crew.has(login),
    approves: async (id) => state.approves.has(id),
    preparing: async (repo) => (prepare ? prepare.preparing(repo) : null),
    audit: async (entry) => {
      audits.push(entry);
    },
    warn: () => undefined,
  };
  const cuts = new ReleaseCuts(cutDeps);
  const file = vi.fn(async (_request: unknown, identity: string) => {
    const record = request({ requestedBy: identity });
    state.requests.set(record.id, record);
    return { id: record.id, state: record.state };
  });
  // A lock as the database holds it: one holder at a time per key.
  const held = new Map<string, Promise<unknown>>();
  const lock = async <T,>(key: string, fn: () => Promise<T>): Promise<T> => {
    const before = held.get(key) ?? Promise.resolve();
    const mine = before.catch(() => undefined).then(fn);
    held.set(key, mine.catch(() => undefined));
    return mine;
  };
  prepare = new ReleasePrepare({
    cuts,
    isCrew: async (login) => state.crew.has(login),
    file,
    lastPrepared: async (target) => {
      const row = [...audits].reverse().find((entry) => entry.action === RELEASE_PREPARE_REQUESTED && entry.target === target);
      return row ? { payload: row.payload } : null;
    },
    getRequest: async (id) => state.requests.get(id) ?? null,
    prOf: async (_repoId, number) => state.prs.get(number) ?? null,
    reader: async () => reader,
    audit: async (entry) => {
      audits.push(entry);
    },
    lock,
    warn: () => undefined,
    ...overrides,
  });
  return { prepare, cuts, start, file, audits, state };
}

const refusals = (audits: Rig['audits']) => audits.filter((entry) => entry.action === RELEASE_PREPARE_REFUSED).map((entry) => entry.payload);

async function viewOf(r: Rig): Promise<string> {
  return (await r.cuts.view('app', JANE)).viewId;
}

describe('pressing Prepare next version', () => {
  it('files one feature request in the approver’s name, with what to raise and what moves with it, and audits it', async () => {
    const r = rig();
    const viewId = await viewOf(r);
    const answer = await r.prepare.prepare('app', JANE, { viewId, version: '1.4.1' });
    expect(answer).toMatchObject({ request: { id: REQUEST_ID, state: 'queued' }, subject: 'request:abcdef12', preparing: { version: '1.4.1', state: 'queued', issue: null } });

    expect(r.file).toHaveBeenCalledTimes(1);
    const [filed, identity] = r.file.mock.calls[0] as [{ kind: string; repo: string; text: string; context: string }, string];
    expect(identity).toBe(JANE);
    expect(filed).toMatchObject({ kind: 'feature', repo: 'app', text: "Raise app's version to 1.4.1 for its next release" });
    expect(filed.context).toContain('Target version: 1.4.1');
    expect(filed.context).toContain('Last release: 1.4.0 (tag v1.4.0)');
    expect(filed.context).toContain('Version file: VERSION');
    expect(filed.context).toContain('Version key:');
    expect(filed.context).toContain('Raise the version on the default branch to exactly 1.4.1');
    expect(filed.context).toContain('moves with it, so that CI stays green');
    expect(filed.context).toContain('under Expected paths, so no plan_change is needed');

    expect(r.audits.filter((entry) => entry.action === RELEASE_PREPARE_REQUESTED)).toEqual([
      {
        actor: JANE,
        action: RELEASE_PREPARE_REQUESTED,
        target: 'acme/app:release',
        payload: { requestId: REQUEST_ID, version: '1.4.1', after: '1.4.0', afterTag: 'v1.4.0', versionFile: 'VERSION', versionKey: null, by: JANE },
      },
    ]);
    expect(r.start).not.toHaveBeenCalled();
  });

  it('accepts an edited version above the last release, labelled or not', async () => {
    const r = rig();
    r.state.last = { version: '156.0.8078.79-abc.29', tag: 'v156.0.8078.79-abc.29', url: null };
    r.state.version = '156.0.8078.79-abc.29';
    const viewId = await viewOf(r);
    await r.prepare.prepare('app', JANE, { viewId, version: '156.0.8078.80-abc.1' });
    expect(r.file).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('156.0.8078.80-abc.1') }), JANE);
  });

  it('refuses a version at or below the last release, another label, or no version, and files nothing', async () => {
    const r = rig();
    const viewId = await viewOf(r);
    await expect(r.prepare.prepare('app', JANE, { viewId, version: '1.4.0' })).rejects.toMatchObject({ status: 422, message: '1.4.0 is not above the last release, 1.4.0: raise it in VERSION' });
    await expect(r.prepare.prepare('app', JANE, { viewId, version: '1.3.9' })).rejects.toMatchObject({ status: 422, message: expect.stringContaining('raise it in VERSION') });
    await expect(r.prepare.prepare('app', JANE, { viewId, version: '1.5.0-rc.1' })).resolves.toBeTruthy();

    const labelled = rig();
    labelled.state.last = { version: '1.4.0-beta.2', tag: 'v1.4.0-beta.2', url: null };
    labelled.state.version = '1.4.0-beta.2';
    const labelledView = await viewOf(labelled);
    await expect(labelled.prepare.prepare('app', JANE, { viewId: labelledView, version: '1.5.0-rc.1' })).rejects.toMatchObject({ status: 422, message: expect.stringContaining('use beta in VERSION') });
    await expect(labelled.prepare.prepare('app', JANE, { viewId: labelledView, version: 'one point five' })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('is not a release version'),
    });
    expect(labelled.file).not.toHaveBeenCalled();
    expect(refusals(labelled.audits).map((row) => row.reason)).toEqual(['version_not_above', 'bad_version']);
    expect(refusals(r.audits).map((row) => row.reason)).toEqual(['version_not_above', 'version_not_above']);
  });

  it('refuses a person who may not cut — no link, Approves off, a crew account — and audits it', async () => {
    for (const [arrange, reason] of [
      [(r: Rig) => (r.state.link = null), 'not_linked'],
      [(r: Rig) => r.state.approves.clear(), 'approves_off'],
      [
        (r: Rig) => {
          r.state.link = { githubLogin: 'atlas-bot', githubUserId: 900 };
          r.state.approves.add(900);
        },
        'crew_account',
      ],
    ] as const) {
      const r = rig();
      const viewId = await viewOf(r);
      arrange(r);
      await expect(r.prepare.prepare('app', JANE, { viewId, version: '1.4.1' })).rejects.toMatchObject({ status: 403 });
      expect(r.file).not.toHaveBeenCalled();
      expect(refusals(r.audits)).toEqual([expect.objectContaining({ reason, version: '1.4.1', by: JANE })]);
    }
  });

  it('refuses a crew check that cannot be read', async () => {
    const r = rig({ isCrew: async () => Promise.reject(new Error('crew list unreadable')) });
    const viewId = await viewOf(r);
    await expect(r.prepare.prepare('app', JANE, { viewId, version: '1.4.1' })).rejects.toMatchObject({ status: 403 });
    expect(r.file).not.toHaveBeenCalled();
  });

  it('refuses a view that is not offered, another identity’s, or expired', async () => {
    const above = rig();
    above.state.version = '1.5.0';
    const cuttable = await viewOf(above);
    await expect(above.prepare.prepare('app', JANE, { viewId: cuttable, version: '1.5.1' })).rejects.toMatchObject({ status: 409 });

    const r = rig();
    const viewId = await viewOf(r);
    await expect(r.prepare.prepare('app', 'bob@example.com', { viewId, version: '1.4.1' })).rejects.toMatchObject({ status: 409 });
    expect(refusals(above.audits).map((row) => row.reason)).toEqual(['not_offered']);
    expect(refusals(r.audits).map((row) => row.reason)).toEqual(['view_gone']);
    expect(above.file).not.toHaveBeenCalled();
    expect(r.file).not.toHaveBeenCalled();
  });

  it('refuses a body that is not exactly { viewId, version }, a SHA included', async () => {
    const r = rig();
    const viewId = await viewOf(r);
    for (const body of [null, [], { viewId }, { version: '1.4.1' }, { viewId, version: '1.4.1', sha: A }, { viewId, version: 7 }]) {
      await expect(r.prepare.prepare('app', JANE, body)).rejects.toMatchObject({ status: 400 });
    }
    expect(r.file).not.toHaveBeenCalled();
    expect(refusals(r.audits).every((row) => row.reason === 'bad_body')).toBe(true);
  });

  it('refuses a second press while the first is open, and two presses at once file once', async () => {
    const r = rig();
    const viewId = await viewOf(r);
    const both = await Promise.allSettled([r.prepare.prepare('app', JANE, { viewId, version: '1.4.1' }), r.prepare.prepare('app', JANE, { viewId, version: '1.4.2' })]);
    expect(both.map((one) => one.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((both.find((one) => one.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ status: 409, message: expect.stringContaining('already open') });
    await expect(r.prepare.prepare('app', JANE, { viewId: await viewOf(r), version: '1.4.3' })).rejects.toMatchObject({ status: 409 });
    expect(r.file).toHaveBeenCalledTimes(1);
    expect(refusals(r.audits).map((row) => row.reason)).toEqual(['already_preparing', 'already_preparing']);
  });

  it('says the refusal and files no audit row when intake refuses the request', async () => {
    const r = rig();
    r.file.mockRejectedValueOnce(Object.assign(new Error('no intake bot is configured'), { status: 409 }));
    const viewId = await viewOf(r);
    await expect(r.prepare.prepare('app', JANE, { viewId, version: '1.4.1' })).rejects.toMatchObject({ status: 409, message: 'no intake bot is configured' });
    expect(r.audits.some((entry) => entry.action === RELEASE_PREPARE_REQUESTED)).toBe(false);
    expect(refusals(r.audits)).toEqual([expect.objectContaining({ reason: 'intake_refused' })]);
  });

  it('keeps the filed request when its audit row cannot be written, and says so in the log', async () => {
    const warn = vi.fn();
    const r = rig({ warn, audit: async () => Promise.reject(new Error('database down')) });
    const viewId = await viewOf(r);
    await expect(r.prepare.prepare('app', JANE, { viewId, version: '1.4.1' })).resolves.toMatchObject({ request: { id: REQUEST_ID } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('was not audited'));
  });
});

describe('the open preparation', () => {
  async function pressed(r: Rig): Promise<void> {
    await r.prepare.prepare('app', JANE, { viewId: await viewOf(r), version: '1.4.1' });
  }
  const filed = (overrides: Partial<RequestRecord> = {}) =>
    request({ state: 'filed', issueNumber: 400, issues: [{ repoId: REPO.id, repoFullName: 'acme/app', number: 400, filedAt: '2026-11-19T00:00:00.000Z' }], ...overrides });

  it('is none before any press', async () => {
    expect(await rig().prepare.preparing(REPO)).toBeNull();
  });

  it.each(['queued', 'draft', 'questions'] as const)('is open while the request is %s, with no issue', async (state) => {
    const r = rig();
    await pressed(r);
    r.state.requests.set(REQUEST_ID, request({ state }));
    expect(await r.prepare.preparing(REPO)).toEqual({ requestId: REQUEST_ID, subject: 'request:abcdef12', state, version: '1.4.1', issue: null, pullRequest: null, unknown: false });
  });

  it('is none once the request is abandoned or gone, and Prepare is offered again', async () => {
    const r = rig();
    await pressed(r);
    r.state.requests.set(REQUEST_ID, request({ state: 'abandoned' }));
    expect(await r.prepare.preparing(REPO)).toBeNull();
    expect((await r.cuts.view('app', JANE)).prepare).toMatchObject({ suggested: '1.4.1' });
    r.state.requests.delete(REQUEST_ID);
    expect(await r.prepare.preparing(REPO)).toBeNull();
  });

  it('is open while its issue is open, with its pull request, and the page shows it instead of the offer', async () => {
    const r = rig();
    await pressed(r);
    r.state.requests.set(REQUEST_ID, filed());
    r.state.github.set('/repos/acme/app/issues/400', { state: 'open' });
    r.state.prs.set(400, 401);
    r.state.github.set('/repos/acme/app/pulls/401', { state: 'open', merged: false });
    const open = await r.prepare.preparing(REPO);
    expect(open).toMatchObject({
      state: 'filed',
      issue: { number: 400, url: 'https://github.com/acme/app/issues/400' },
      pullRequest: { number: 401, url: 'https://github.com/acme/app/pull/401', state: 'open' },
      unknown: false,
    });
    expect(await r.cuts.view('app', JANE)).toMatchObject({ prepare: null, preparing: { issue: { number: 400 } } });

    r.state.github.set('/repos/acme/app/pulls/401', { state: 'closed', merged: false });
    expect((await r.prepare.preparing(REPO))?.pullRequest).toBeNull();
    r.state.github.set('/repos/acme/app/pulls/401', { state: 'closed', merged: true });
    expect((await r.prepare.preparing(REPO))?.pullRequest).toMatchObject({ state: 'merged' });
  });

  it('counts an issue or pull request GitHub would not say as open, state unknown', async () => {
    const r = rig();
    await pressed(r);
    r.state.requests.set(REQUEST_ID, filed());
    expect(await r.prepare.preparing(REPO)).toMatchObject({ issue: { number: 400 }, unknown: true });

    r.state.github.set('/repos/acme/app/issues/400', { state: 'open' });
    r.state.prs.set(400, 401);
    expect(await r.prepare.preparing(REPO)).toMatchObject({ pullRequest: { number: 401, state: 'unknown' }, unknown: true });
    await expect(r.prepare.prepare('app', JANE, { viewId: await viewOf(r), version: '1.4.2' })).rejects.toMatchObject({ status: 409 });
  });

  it('is none once every issue it was filed as is closed', async () => {
    const r = rig();
    await pressed(r);
    r.state.requests.set(REQUEST_ID, filed());
    r.state.github.set('/repos/acme/app/issues/400', { state: 'closed' });
    expect(await r.prepare.preparing(REPO)).toBeNull();
    await expect(r.prepare.prepare('app', JANE, { viewId: await viewOf(r), version: '1.4.2' })).resolves.toBeTruthy();
    expect(r.file).toHaveBeenCalledTimes(2);
  });
});

describe('the route', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it('files through POST /v1/repos/:name/release/prepare, and says a refusal with its status', async () => {
    const r = rig();
    const router = new Router(undefined, undefined, undefined, async () => 'user');
    registerReleasePrepareRoutes(router, r.prepare);
    server = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/repos/app/release/prepare`;
    const headers = { 'x-openadlc-identity': JANE, 'content-type': 'application/json' };
    const viewId = await viewOf(r);

    const low = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ viewId, version: '1.4.0' }) });
    expect(low.status).toBe(422);
    expect(((await low.json()) as { error: string }).error).toContain('raise it in VERSION');

    const ok = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ viewId, version: '1.4.1' }) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ subject: 'request:abcdef12' });

    expect(r.start).not.toHaveBeenCalled();
  });
});

describe('what Prepare next version can reach', () => {
  it('imports neither the service, the publisher nor hostd, and never starts a release', () => {
    const root = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(root, 'release-prepare.ts'), 'utf8');
    expect(source).not.toMatch(/from '\.\/release-service\.js'/);
    expect(source).not.toMatch(/from '\.\/release-publish\.js'/);
    expect(source).not.toMatch(/from '[^']*hostd/i);
    expect(source).not.toMatch(/\.start\(/);
    // It takes the cuts only as `preparable`.
    expect(source).toContain("cuts: Pick<ReleaseCuts, 'preparable'>");
  });

  it('leaves the view unspent: a cut can still be refused or offered from it as before', async () => {
    const r = rig();
    const viewId = await viewOf(r);
    await r.prepare.prepare('app', JANE, { viewId, version: '1.4.1' });
    expect((await r.cuts.preparable(viewId, JANE, 'app')).ok).toBe(true);
    expect(r.start).not.toHaveBeenCalled();
  });
});
