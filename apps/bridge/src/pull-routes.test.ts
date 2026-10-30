import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PersonFlows } from './person-github.js';
import type { PullCommands } from './pull-commands.js';
import { pullNumberOf, registerPullRoutes, type PullOf } from './pull-routes.js';
import { Router } from './router.js';

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

describe('which pull request a subject’s panel acts on', () => {
  const item = {
    pr: 99,
    refs: { request: null, issue: 'www#12', pullRequest: 'www#99' },
    links: [
      { kind: 'issue', repo: 'www', number: 12 },
      { kind: 'pull', repo: 'www', number: 99 },
      { kind: 'pull', repo: 'www', number: 46 },
    ],
  } as never;

  it('is the pull a card names when it is one of the item’s, and the item’s pull request otherwise', () => {
    // A card for pull 46, on an item whose issue records 99, sent its sign-off to 99.
    expect(pullNumberOf('www#46', item, 'www')).toBe(46);
    expect(pullNumberOf('www#99', item, 'www')).toBe(99);
    expect(pullNumberOf('www#12', item, 'www')).toBe(99);
    expect(pullNumberOf('W-7', item, 'www')).toBe(99);
    // A number the item does not hold is not taken from the subject.
    expect(pullNumberOf('www#47', item, 'www')).toBe(99);
    expect(pullNumberOf('api#46', item, 'www')).toBe(99);
  });
});
