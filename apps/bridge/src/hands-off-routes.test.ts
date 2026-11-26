import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HandsOffWindow } from '@openadlc/db';
import { HandsOff, HANDS_OFF_OFF, HANDS_OFF_ON, HANDS_OFF_REFUSED } from './hands-off.js';
import { HandsOffRoutes, registerHandsOffRoutes, type HandsOffRouteDeps } from './hands-off-routes.js';
import { PersonFlows, type GitHubViewer, type PersonGitHubDeps } from './person-github.js';
import { ROUTE_ROLES } from './roles.js';
import { Router } from './router.js';

/**
 * Turning hands-off mode on and off from the console (#383, ADR 0093): on
 * only for a linked account with Approves on, asked before and after a fresh
 * device-code sign-in, as a release cut is; off by anyone, at once. People
 * and the store are stand-ins; the sign-in is the real `PersonFlows`, with
 * GitHub's device flow stubbed.
 */

const REPO = { id: 'repo-1', name: 'app', fullName: 'acme/app', defaultBranch: 'main' };
const JANE = 'jane@example.com';
const LINK = { githubLogin: 'jane', githubUserId: 101 };
const SET_AT = '2026-11-25T10:00:00.000Z';
const HOURS = 60 * 60_000;

function rig() {
  const state = { approves: new Set([101]), link: LINK as typeof LINK | null, crew: new Set(['atlas-bot']), open: null as HandsOffWindow | null };
  const audits: { actor: string; action: string; target: string; payload: Record<string, unknown> }[] = [];
  const service = new HandsOff({
    store: {
      openFor: vi.fn(async () => state.open),
      listOpen: vi.fn(async () => (state.open ? [state.open] : [])),
      turnOn: vi.fn(async (input) => {
        if (state.open) return { window: state.open, created: false };
        const ms = { '1h': HOURS, '8h': 8 * HOURS, '24h': 24 * HOURS, until_off: null }[input.duration];
        state.open = {
          id: 'window-1',
          repoId: input.repoId,
          setBy: input.setBy,
          setByLogin: input.setByLogin,
          setByGithubId: input.setByGithubId,
          duration: input.duration,
          setAt: SET_AT,
          endsAt: ms === null ? null : new Date(Date.parse(SET_AT) + ms).toISOString(),
          endedAt: null,
          endedBy: null,
          endedWhy: null,
          endedNote: null,
        };
        return { window: state.open, created: true };
      }),
      end: vi.fn(async (input) => {
        if (!state.open) return null;
        const was = { ...state.open, endedAt: '2026-11-25T11:00:00.000Z', endedBy: input.by, endedWhy: input.why, endedNote: input.note ?? null };
        state.open = null;
        return was;
      }),
      endExpired: vi.fn(async () => []),
    },
    audit: async (entry) => {
      audits.push(entry);
    },
    repoById: async () => REPO,
    repositoryRefusal: async () => null,
    taskRefusal: async () => null,
    humanReviewRules: async () => ({ rules: [], unread: null }),
    issueFacts: async () => ({ labels: [], declaredPaths: [] }),
  });
  let answer: { resolve: (token: { accessToken: string }) => void; reject: (error: Error) => void } | null = null;
  let viewerIs: GitHubViewer = { login: 'jane', id: 101 };
  const person: PersonGitHubDeps = {
    clientId: async () => 'client-id',
    clientSecret: async () => 'client-secret',
    requestCode: vi.fn(async () => ({ deviceCode: 'dev', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 })),
    pollToken: () => new Promise((resolve, reject) => (answer = { resolve: resolve as never, reject })),
    viewer: async () => viewerIs,
    revoke: async () => true,
    isCrew: async (login) => state.crew.has(login),
    store: { link: vi.fn(), unlink: vi.fn(), ofIdentity: async () => state.link } as never,
    audit: async () => undefined,
  };
  const flows = new PersonFlows(person);
  const deps: HandsOffRouteDeps = {
    handsOff: service,
    repo: async (name) => (name === 'app' ? REPO : null),
    repos: async () => [REPO],
    flows,
    linkOf: async () => state.link,
    isCrew: async (login) => state.crew.has(login),
    approves: async (id) => state.approves.has(id),
    audit: async (entry) => {
      audits.push(entry);
    },
    warn: () => undefined,
  };
  return {
    routes: new HandsOffRoutes(deps),
    flows,
    state,
    audits,
    approve: async (viewer: GitHubViewer) => {
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

const refusals = (audits: ReturnType<typeof rig>['audits']) => audits.filter((entry) => entry.action === HANDS_OFF_REFUSED).map((entry) => entry.payload);

describe('turning hands-off mode on', () => {
  it('opens a window only after a fresh sign-in by the linked approver, recording who set it, when and when it ends', async () => {
    const r = rig();
    const { flow } = await r.routes.turnOn('app', JANE, { duration: '8h' });
    expect(flow).toMatchObject({ userCode: 'ABCD-1234' });
    // Nothing is on until the code is approved.
    expect(r.state.open).toBeNull();

    await r.approve({ login: 'jane', id: 101 });

    expect(r.state.open).toMatchObject({ setBy: JANE, setByLogin: 'jane', setByGithubId: 101, duration: '8h', setAt: SET_AT, endsAt: '2026-11-25T18:00:00.000Z' });
    expect(await r.routes.flowState(flow.flowId, JANE)).toMatchObject({ state: 'done', window: { repo: 'app', setByLogin: 'jane', endsAt: '2026-11-25T18:00:00.000Z' } });
    expect(r.audits.filter((entry) => entry.action === HANDS_OFF_ON)).toEqual([
      expect.objectContaining({
        actor: JANE,
        target: 'acme/app:hands-off',
        payload: expect.objectContaining({ setBy: JANE, setByLogin: 'jane', setByGithubId: 101, setAt: SET_AT, endsAt: '2026-11-25T18:00:00.000Z', duration: '8h' }),
      }),
    ]);
  });

  it('has no end when it is until turned off', async () => {
    const r = rig();
    await r.routes.turnOn('app', JANE, { duration: 'until_off' });
    await r.approve({ login: 'jane', id: 101 });
    expect(r.state.open).toMatchObject({ duration: 'until_off', endsAt: null });
  });

  const before: [string, (r: ReturnType<typeof rig>) => void, unknown, number, string, string][] = [
    ['an account that is not linked', (r) => (r.state.link = null), { duration: '8h' }, 403, 'not_linked', 'Link your GitHub account'],
    ['Approves off', (r) => r.state.approves.clear(), { duration: '8h' }, 403, 'approves_off', 'Approves is off for you'],
    ['a duration it does not offer', () => undefined, { duration: '2h' }, 400, 'bad_duration', 'duration is one of "1h", "8h", "24h", "until_off"'],
  ];
  it.each(before)('refuses %s before any sign-in, and audits it', async (_what, arrange, body, status, reason, words) => {
    const r = rig();
    arrange(r);
    await expect(r.routes.turnOn('app', JANE, body)).rejects.toMatchObject({ status, message: expect.stringContaining(words) });
    expect(refusals(r.audits)).toEqual([expect.objectContaining({ reason, stage: 'before_sign_in' })]);
    expect(r.state.open).toBeNull();
  });

  it('refuses a second window while one is open, naming who set it and when it ends', async () => {
    const r = rig();
    await r.routes.turnOn('app', JANE, { duration: '8h' });
    await r.approve({ login: 'jane', id: 101 });
    await expect(r.routes.turnOn('app', JANE, { duration: '1h' })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('already on for app, set by @jane until 2026-11-25 18:00 UTC'),
    });
    expect(refusals(r.audits)).toEqual([expect.objectContaining({ reason: 'already_on' })]);
  });

  it('refuses a repository the install does not manage', async () => {
    const r = rig();
    await expect(r.routes.turnOn('other', JANE, { duration: '8h' })).rejects.toMatchObject({ status: 404 });
    expect(refusals(r.audits)).toEqual([expect.objectContaining({ reason: 'unknown_repo' })]);
  });

  const after: [string, (r: ReturnType<typeof rig>) => void, GitHubViewer, string][] = [
    ['a viewer who is another account', () => undefined, { login: 'mallory', id: 666 }, 'other_account'],
    ['a crew account', (r) => r.state.crew.add('jane'), { login: 'jane', id: 101 }, 'crew_account'],
    ['Approves turned off during the sign-in', (r) => r.state.approves.clear(), { login: 'jane', id: 101 }, 'approves_off'],
  ];
  it.each(after)('refuses %s after the sign-in, and turns nothing on', async (_what, arrange, viewer, reason) => {
    const r = rig();
    const { flow } = await r.routes.turnOn('app', JANE, { duration: '8h' });
    arrange(r);
    await r.approve(viewer);
    expect(r.state.open).toBeNull();
    expect(await r.routes.flowState(flow.flowId, JANE)).toMatchObject({ state: 'failed' });
    expect(refusals(r.audits)).toEqual([expect.objectContaining({ reason, stage: 'after_sign_in' })]);
    expect(r.audits.filter((entry) => entry.action === HANDS_OFF_ON)).toEqual([]);
  });

  it('refuses after the sign-in when another window opened meanwhile, and leaves that one as it was', async () => {
    const r = rig();
    await r.routes.turnOn('app', JANE, { duration: '8h' });
    r.state.open = {
      id: 'window-0',
      repoId: REPO.id,
      setBy: 'sam@example.com',
      setByLogin: 'sam',
      setByGithubId: 7,
      duration: '1h',
      setAt: SET_AT,
      endsAt: '2026-11-25T11:00:00.000Z',
      endedAt: null,
      endedBy: null,
      endedWhy: null,
      endedNote: null,
    };
    await r.approve({ login: 'jane', id: 101 });
    expect(r.state.open).toMatchObject({ id: 'window-0', setByLogin: 'sam' });
    expect(refusals(r.audits)).toEqual([expect.objectContaining({ reason: 'already_on', stage: 'after_sign_in' })]);
    expect(r.audits.filter((entry) => entry.action === HANDS_OFF_ON)).toEqual([]);
  });

  it('turns nothing on for a sign-in that ends unapproved, and audits it', async () => {
    const r = rig();
    await r.routes.turnOn('app', JANE, { duration: '8h' });
    await r.expire();
    await r.routes.sweepFlows();
    expect(r.state.open).toBeNull();
    expect(refusals(r.audits)).toEqual([expect.objectContaining({ reason: 'sign_in_failed' })]);
  });
});

describe('turning hands-off mode off', () => {
  it('ends the window at once for anyone signed in, Approves or not, recording who; a second turn-off is 404', async () => {
    const r = rig();
    await r.routes.turnOn('app', JANE, { duration: '24h' });
    await r.approve({ login: 'jane', id: 101 });
    r.state.approves.clear();

    expect(await r.routes.turnOff('app', 'sam@example.com')).toMatchObject({ ended: { repo: 'app', setByLogin: 'jane', endedBy: 'sam@example.com' } });
    expect(r.state.open).toBeNull();
    expect(r.audits.filter((entry) => entry.action === HANDS_OFF_OFF)).toEqual([
      expect.objectContaining({ actor: 'sam@example.com', payload: expect.objectContaining({ by: 'sam@example.com', why: 'turned_off', setByLogin: 'jane' }) }),
    ]);
    await expect(r.routes.turnOff('app', 'sam@example.com')).rejects.toMatchObject({ status: 404 });
  });
});

describe('the list', () => {
  it('shows the open windows, the repositories, and whether this viewer may turn one on and why not', async () => {
    const r = rig();
    expect(await r.routes.list(JANE)).toEqual({ windows: [], repos: ['app'], mayTurnOn: true });
    await r.routes.turnOn('app', JANE, { duration: '1h' });
    await r.approve({ login: 'jane', id: 101 });
    r.state.approves.clear();
    expect(await r.routes.list(JANE)).toEqual({
      windows: [{ repo: 'app', fullName: 'acme/app', setByLogin: 'jane', setAt: SET_AT, endsAt: '2026-11-25T11:00:00.000Z', duration: '1h' }],
      repos: ['app'],
      mayTurnOn: false,
      why: expect.stringContaining('Approves is off'),
      url: '/settings#people',
    });
  });
});

describe('the routes', () => {
  let server: Server | null = null;
  afterEach(() => {
    server?.close();
    server = null;
  });

  it('are each a user’s, with Approves checked per person by the routes themselves', () => {
    for (const key of ['GET /v1/hands-off', 'POST /v1/repos/:name/hands-off', 'GET /v1/repos/:name/hands-off/flows/:flowId', 'DELETE /v1/repos/:name/hands-off']) {
      expect(ROUTE_ROLES[key], key).toBe('user');
    }
  });

  it('turn it on and off over HTTP as the signed-in person', async () => {
    const r = rig();
    const router = new Router(undefined, undefined, undefined, async () => 'user');
    registerHandsOffRoutes(router, r.routes);
    server = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const as = (who: string) => ({ 'x-openadlc-identity': who, 'content-type': 'application/json' });

    const started = await fetch(`${url}/v1/repos/app/hands-off`, { method: 'POST', headers: as(JANE), body: JSON.stringify({ duration: '8h' }) });
    expect(started.status).toBe(200);
    const { flow } = (await started.json()) as { flow: { flowId: string } };
    await r.approve({ login: 'jane', id: 101 });
    expect(await (await fetch(`${url}/v1/repos/app/hands-off/flows/${flow.flowId}`, { headers: as(JANE) })).json()).toMatchObject({ state: 'done' });
    expect(await (await fetch(`${url}/v1/hands-off`, { headers: as(JANE) })).json()).toMatchObject({ windows: [{ repo: 'app', setByLogin: 'jane' }] });
    expect((await fetch(`${url}/v1/repos/app/hands-off`, { method: 'DELETE', headers: as('sam@example.com') })).status).toBe(200);
    expect((await fetch(`${url}/v1/repos/app/hands-off`, { method: 'DELETE', headers: as('sam@example.com') })).status).toBe(404);
  });
});
