import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PersonFlows } from './person-github.js';
import { HeldMergeDecisions } from './held-merge-decide.js';
import { HumanReviewDecisions } from './human-review-decide.js';
import type { PullCommands } from './pull-commands.js';
import { livePullOf, pullTargetOf, registerPullRoutes, type PullOf } from './pull-routes.js';
import { Router } from './router.js';

const live = vi.hoisted(() => ({ resolveItem: vi.fn(), getRepoByName: vi.fn() }));
vi.mock('./items.js', async (actual) => ({ ...(await actual<typeof import('./items.js')>()), resolveItem: live.resolveItem }));
vi.mock('@openadlc/db', async (actual) => {
  const db = await actual<typeof import('@openadlc/db')>();
  return { ...db, repos: { ...db.repos, getRepoByName: live.getRepoByName } };
});

/**
 * The pull panel's routes: the view of the item's pull request, pressing a
 * command for the head the person saw, a sign-off's flow for the person who
 * started it, and a screenshot served by the bridge as an image that cannot
 * run as a page.
 */

const HEAD = 'a'.repeat(40);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
const REPO = { name: 'www', fullName: '620legal/www', defaultBranch: 'main' };

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function serve(commands: Partial<PullCommands>, flows: Partial<PersonFlows> = {}, pullOf: PullOf = async (subject) => (subject === 'www#12' ? { repo: REPO, number: 46 } : null)) {
  const router = new Router(undefined, undefined, undefined, async () => 'user');
  registerPullRoutes(router, commands as PullCommands, flows as PersonFlows, pullOf);
  server = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const as = { 'x-openadlc-identity': 'jane@example.com', 'content-type': 'application/json' };
  return { url, as };
}

describe('the pull panel’s routes', () => {
  it('reads the view of the item’s pull request for the person asking, and 404s an item with none', async () => {
    const read = vi.fn(async () => ({ commands: [] }));
    const { url, as } = await serve({ read } as never);
    expect((await fetch(`${url}/v1/items/${encodeURIComponent('www#12')}/pull`, { headers: as })).status).toBe(200);
    expect(read).toHaveBeenCalledWith(REPO, 46, 'jane@example.com');
    const none = await fetch(`${url}/v1/items/${encodeURIComponent('www#13')}/pull`, { headers: as });
    expect(none.status).toBe(404);
    expect(((await none.json()) as { error: string }).error).toMatch(/no pull request yet/);
  });

  it('presses a command for the head the button was shown for, and refuses a body without one', async () => {
    const send = vi.fn(async () => ({ state: 'sent', commentUrl: 'https://github.com/x' }));
    const { url, as } = await serve({ send } as never);
    const pressed = await fetch(`${url}/v1/items/${encodeURIComponent('www#12')}/pull/commands/preview`, { method: 'POST', headers: as, body: JSON.stringify({ head: HEAD }) });
    expect(await pressed.json()).toEqual({ state: 'sent', commentUrl: 'https://github.com/x' });
    expect(send).toHaveBeenCalledWith({ repo: REPO, number: 46, name: 'preview', head: HEAD, identity: 'jane@example.com' });
    const bare = await fetch(`${url}/v1/items/${encodeURIComponent('www#12')}/pull/commands/preview`, { method: 'POST', headers: as, body: '{}' });
    expect(bare.status).toBe(400);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('says how a sign-off went to the person who started it, as sent once posted', async () => {
    const state = vi.fn((_flowId: string, identity: string) =>
      identity === 'jane@example.com' ? { state: 'done', result: { commentUrl: 'https://github.com/c' }, flowId: 'f', userCode: 'X', verificationUri: 'u', expiresInSeconds: 0 } : { state: 'none' },
    );
    const { url, as } = await serve({}, { state } as never);
    expect(await (await fetch(`${url}/v1/items/${encodeURIComponent('www#12')}/pull/flows/f`, { headers: as })).json()).toEqual({ state: 'sent', commentUrl: 'https://github.com/c' });
    expect(await (await fetch(`${url}/v1/items/${encodeURIComponent('www#12')}/pull/flows/f`, { headers: { ...as, 'x-openadlc-identity': 'bob@example.com' } })).json()).toEqual({
      state: 'none',
    });
  });

  it('serves a screenshot as an image that is never sniffed or run', async () => {
    const image = vi.fn(async () => ({ bytes: PNG, mediaType: 'image/png' }));
    const { url, as } = await serve({ image } as never);
    const served = await fetch(`${url}/v1/items/${encodeURIComponent('www#12')}/pull/images/12/0`, { headers: as });
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(served.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
    expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true);
    expect(image).toHaveBeenCalledWith(REPO, 46, 12, 0);
    expect((await fetch(`${url}/v1/items/${encodeURIComponent('www#12')}/pull/images/x/0`, { headers: as })).status).toBe(400);
  });
});

describe('deciding a held Human-review approval', () => {
  async function serveDecisions(decisions: HumanReviewDecisions | null) {
    const router = new Router(undefined, undefined, undefined, async () => 'user');
    registerPullRoutes(router, {} as PullCommands, {} as PersonFlows, async (subject) => (subject === 'www#46' ? { repo: REPO, number: 46 } : null), decisions);
    server = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (what: 'approve' | 'reject' | 'remind', body: unknown, identity = 'jane@example.com') =>
      fetch(`${url}/v1/items/${encodeURIComponent('www#46')}/pull/human-review/${what}`, {
        method: 'POST',
        headers: { 'x-openadlc-identity': identity, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const read = (login: string) =>
      fetch(`${url}/v1/items/${encodeURIComponent('www#46')}/pull/human-review/request?login=${encodeURIComponent(login)}`, { headers: { 'x-openadlc-identity': 'bob@example.com' } });
    return { post, read };
  }

  it('hands the request read and Remind the pull request, the login and the person asking, and refuses a malformed login', async () => {
    const view = { login: 'janedoe', request: { state: 'none' }, reminded: null, remindAfter: null };
    const requestStatus = vi.fn(async () => view);
    const remind = vi.fn(async () => ({ reminded: { at: '2026-11-11T04:00:00.000Z', by: 'Bob' }, remindAfter: '2026-11-11T05:00:00.000Z' }));
    const { post, read } = await serveDecisions({ requestStatus, remind } as never);

    expect(await (await read('janedoe')).json()).toEqual(view);
    expect(requestStatus).toHaveBeenCalledWith({ repo: REPO, number: 46, login: 'janedoe' });
    expect(await (await post('remind', { login: 'janedoe' }, 'bob@example.com')).json()).toEqual({ reminded: { at: '2026-11-11T04:00:00.000Z', by: 'Bob' }, remindAfter: '2026-11-11T05:00:00.000Z' });
    expect(remind).toHaveBeenCalledWith({ repo: REPO, number: 46, login: 'janedoe', identity: 'bob@example.com' });

    expect((await read('not a login')).status).toBe(400);
    expect((await post('remind', { login: '-x' })).status).toBe(400);
    expect(requestStatus).toHaveBeenCalledTimes(1);
    expect(remind).toHaveBeenCalledTimes(1);
  });

  it('answers a Remind within the hour with 429, the time it can be sent, and asks GitHub nothing', async () => {
    const requestReviewers = vi.fn(async () => undefined);
    const decisions = new HumanReviewDecisions({
      linkOf: async () => null,
      userIdOf: async () => 1,
      standing: async () => ({ head: HEAD }),
      pull: async () => ({ open: true, head: HEAD, url: 'https://github.com/620legal/www/pull/46' }),
      flows: { start: vi.fn(), state: vi.fn() } as never,
      isCrew: async () => false,
      postReviewAsPerson: vi.fn(),
      commentAsApp: vi.fn(),
      rejected: async () => false,
      audit: vi.fn(),
      sendBack: vi.fn(),
      history: async () => [],
      requestReviewers,
      removeReviewRequest: vi.fn(),
      lastReminded: async () => ({ at: '2026-11-11T04:00:00.000Z', byName: 'Ana' }),
      nameOf: async () => null,
      now: () => Date.parse('2026-11-11T04:20:00.000Z'),
    });
    const { post } = await serveDecisions(decisions);
    const refused = await post('remind', { login: 'janedoe' }, 'bob@example.com');
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: '@janedoe was reminded 20 min ago by Ana. You can remind them again in 40 min.', remindAfter: '2026-11-11T05:00:00.000Z' });
    expect(requestReviewers).not.toHaveBeenCalled();
  });

  it('hands Approve and Reject the pull request, the head, the login and the person asking', async () => {
    const approve = vi.fn(async () => ({ flow: { flowId: 'f', userCode: 'C', verificationUri: 'u', expiresInSeconds: 900 } }));
    const reject = vi.fn(async () => ({ state: 'sent_back', commentUrl: 'https://github.com/c' }));
    const { post } = await serveDecisions({ approve, reject } as never);

    expect(await (await post('approve', { head: HEAD, login: 'janedoe' })).json()).toEqual({ flow: { flowId: 'f', userCode: 'C', verificationUri: 'u', expiresInSeconds: 900 } });
    expect(approve).toHaveBeenCalledWith({ repo: REPO, number: 46, login: 'janedoe', head: HEAD, identity: 'jane@example.com' });
    expect(await (await post('reject', { head: HEAD, login: 'janedoe', reason: 'Not this way.' })).json()).toEqual({ state: 'sent_back', commentUrl: 'https://github.com/c' });
    expect(reject).toHaveBeenCalledWith({ repo: REPO, number: 46, login: 'janedoe', head: HEAD, identity: 'jane@example.com', reason: 'Not this way.' });

    // A body that names no head or login is refused before anything is asked.
    expect((await post('approve', { login: 'janedoe' })).status).toBe(400);
    expect((await post('reject', { head: HEAD, login: 'not a login' })).status).toBe(400);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(reject).toHaveBeenCalledTimes(1);
  });

  it('refuses a direct call from anyone but the awaited person, not only by hiding the buttons', async () => {
    const start = vi.fn();
    const commentAsApp = vi.fn();
    const decisions = new HumanReviewDecisions({
      linkOf: async (identity) => (identity === 'jane@example.com' ? { githubLogin: 'janedoe', githubUserId: 1 } : { githubLogin: 'bob', githubUserId: 2 }),
      userIdOf: async (login) => (login === 'janedoe' ? 1 : 2),
      standing: async () => ({ head: HEAD }),
      pull: async () => ({ open: true, head: HEAD, url: 'https://github.com/620legal/www/pull/46' }),
      flows: { start, state: vi.fn() } as never,
      isCrew: async () => false,
      postReviewAsPerson: vi.fn(),
      commentAsApp,
      rejected: async () => false,
      audit: vi.fn(),
      sendBack: vi.fn(),
      history: async () => [],
      requestReviewers: vi.fn(),
      removeReviewRequest: vi.fn(),
      lastReminded: async () => null,
      nameOf: async () => null,
    });
    const { post } = await serveDecisions(decisions);

    const approve = await post('approve', { head: HEAD, login: 'janedoe' }, 'bob@example.com');
    expect(approve.status).toBe(403);
    expect(((await approve.json()) as { error: string }).error).toBe("This is @janedoe's to decide; you can Discuss it.");
    expect((await post('reject', { head: HEAD, login: 'janedoe', reason: 'No.' }, 'bob@example.com')).status).toBe(403);
    expect(start).not.toHaveBeenCalled();
    expect(commentAsApp).not.toHaveBeenCalled();
  });

  it('says so on a bridge that does not decide them', async () => {
    const { post } = await serveDecisions(null);
    const refused = await post('approve', { head: HEAD, login: 'janedoe' });
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as { error: string }).error).toContain('approve it on GitHub');
  });
});

describe('merging a held pull request from the console', () => {
  async function serveMerges(heldMerges: HeldMergeDecisions | null, flows: Partial<PersonFlows> = {}) {
    const router = new Router(undefined, undefined, undefined, async () => 'user');
    registerPullRoutes(router, {} as PullCommands, flows as PersonFlows, async (subject) => (subject === 'www#46' ? { repo: REPO, number: 46 } : null), null, heldMerges);
    server = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const as = { 'x-openadlc-identity': 'jane@example.com', 'content-type': 'application/json' };
    const post = (body: unknown, identity = 'jane@example.com') =>
      fetch(`${url}/v1/items/${encodeURIComponent('www#46')}/pull/held-merge/merge`, { method: 'POST', headers: { ...as, 'x-openadlc-identity': identity }, body: JSON.stringify(body) });
    return { url, as, post };
  }

  it('hands Merge the pull request, the head and the person asking, and refuses a body without a head', async () => {
    const merge = vi.fn(async () => ({ flow: { flowId: 'f', userCode: 'C', verificationUri: 'u', expiresInSeconds: 900 } }));
    const { post } = await serveMerges({ merge } as never);
    expect(await (await post({ head: HEAD })).json()).toEqual({ flow: { flowId: 'f', userCode: 'C', verificationUri: 'u', expiresInSeconds: 900 } });
    expect(merge).toHaveBeenCalledWith({ repo: REPO, number: 46, head: HEAD, identity: 'jane@example.com' });
    expect((await post({})).status).toBe(400);
    expect(merge).toHaveBeenCalledTimes(1);
  });

  it('refuses a direct call from someone GitHub does not let merge, not only by hiding the button', async () => {
    const start = vi.fn();
    const mergeAsPerson = vi.fn();
    const decisions = new HeldMergeDecisions({
      linkOf: async () => ({ githubLogin: 'bob', githubUserId: 2 }),
      permissionOf: async () => 'read',
      isCrew: async () => false,
      held: async () => ({ head: HEAD, reason: 'auto-merge is not on for it' }),
      pull: async () => ({ open: true, head: HEAD, url: 'https://github.com/620legal/www/pull/46' }),
      blockers: async () => [],
      flows: { start, state: vi.fn() } as never,
      mergeAsPerson,
      audit: vi.fn(),
    });
    const { post } = await serveMerges(decisions);
    const refused = await post({ head: HEAD }, 'bob@example.com');
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe('@bob cannot merge in 620legal/www (GitHub says read); someone who can merges it.');
    expect(start).not.toHaveBeenCalled();
    expect(mergeAsPerson).not.toHaveBeenCalled();
  });

  it('says the merge’s sha once it lands, and so on a bridge that does not merge them', async () => {
    const state = vi.fn(() => ({ state: 'done', result: { commentUrl: 'https://github.com/620legal/www/pull/46', mergedSha: 'b'.repeat(40) }, flowId: 'f', userCode: 'X', verificationUri: 'u', expiresInSeconds: 0 }));
    const { url, as, post } = await serveMerges(null, { state } as never);
    expect(await (await fetch(`${url}/v1/items/${encodeURIComponent('www#46')}/pull/flows/f`, { headers: as })).json()).toEqual({
      state: 'sent',
      commentUrl: 'https://github.com/620legal/www/pull/46',
      mergedSha: 'b'.repeat(40),
    });
    const refused = await post({ head: HEAD });
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as { error: string }).error).toContain('merge it on GitHub');
  });
});

describe('which pull request a subject’s panel acts on', () => {
  // The item's issue is www#12 and records pull 99; pull 46 in www and pull 15
  // in api are linked onto it by hand.
  const item = {
    pr: 99,
    refs: { request: null, issue: 'www#12', pullRequest: 'www#99' },
    links: [
      { kind: 'issue', repo: 'www', number: 12 },
      { kind: 'pull', repo: 'www', number: 99 },
      { kind: 'pull', repo: 'www', number: 46 },
      { kind: 'pull', repo: 'api', number: 15 },
    ],
  } as never;

  it('is the pull a card names, in its own repository, when it is one of the item’s, and the item’s pull request otherwise', () => {
    // A card for pull 46, on an item whose issue records 99, sent its sign-off to 99.
    expect(pullTargetOf('www#46', item, 'www')).toEqual({ repo: 'www', number: 46 });
    expect(pullTargetOf('www#99', item, 'www')).toEqual({ repo: 'www', number: 99 });
    // A card for a pull linked from another repository posted on www#99.
    expect(pullTargetOf('api#15', item, 'www')).toEqual({ repo: 'api', number: 15 });
    expect(pullTargetOf('www#12', item, 'www')).toEqual({ repo: 'www', number: 99 });
    expect(pullTargetOf('W-7', item, 'www')).toEqual({ repo: 'www', number: 99 });
    // A pull the item does not hold is not taken from the subject, and a
    // number alone is no match: www#15 and api#46 are not the item's.
    expect(pullTargetOf('www#47', item, 'www')).toEqual({ repo: 'www', number: 99 });
    expect(pullTargetOf('api#46', item, 'www')).toEqual({ repo: 'www', number: 99 });
    expect(pullTargetOf('www#15', item, 'www')).toEqual({ repo: 'www', number: 99 });
  });

  it('is none for an item with no pull request', () => {
    const none = { pr: null, refs: { request: null, issue: 'www#12', pullRequest: null }, links: [] } as never;
    expect(pullTargetOf('www#12', none, 'www')).toBeNull();
  });

  it('reads and posts in the repository of the card’s pull, not the item’s', async () => {
    live.resolveItem.mockResolvedValue({ item, repo: { name: 'www' } });
    live.getRepoByName.mockImplementation(async (name: string) => ({ name, fullName: `620legal/${name}`, defaultBranch: 'main' }));
    expect(await livePullOf('api#15')).toEqual({ repo: { name: 'api', fullName: '620legal/api', defaultBranch: 'main' }, number: 15 });
    expect(live.getRepoByName).toHaveBeenLastCalledWith('api');
    expect(await livePullOf('www#12')).toEqual({ repo: { name: 'www', fullName: '620legal/www', defaultBranch: 'main' }, number: 99 });
    expect(live.getRepoByName).toHaveBeenLastCalledWith('www');
  });
});

