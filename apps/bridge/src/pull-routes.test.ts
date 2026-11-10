import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PersonFlows } from './person-github.js';
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
    const post = (what: 'approve' | 'reject', body: unknown, identity = 'jane@example.com') =>
      fetch(`${url}/v1/items/${encodeURIComponent('www#46')}/pull/human-review/${what}`, {
        method: 'POST',
        headers: { 'x-openadlc-identity': identity, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    return { post };
  }

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

