import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { workItems } from '@openadlc/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerItemSearchRoutes, type ItemSearchDeps, type JumpItem } from './item-search-routes.js';
import { authorize, roleFor, type Role, type RoleLookup } from './roles.js';
import { Router } from './router.js';

/**
 * The command palette's jump list over HTTP: open items and those closed in
 * the last 30 days, without what the console leaves out, for anyone with a
 * role and nobody else.
 */

const NOW = new Date('2026-11-02T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

const REPOS = [
  { id: 'repo-api', name: 'api' },
  { id: 'repo-web', name: 'web' },
];

let next = 1;
function link(itemNumber: number, partial: Partial<workItems.Link>): workItems.Link {
  return {
    id: next++,
    itemId: `item-${itemNumber}`,
    itemNumber,
    kind: 'issue',
    repoId: 'repo-api',
    number: itemNumber,
    requestId: null,
    linkedBy: null,
    title: `Item ${itemNumber}`,
    state: 'open',
    url: null,
    openedAt: daysAgo(60),
    closedAt: null,
    ...partial,
  };
}

const world = {
  numbered: true,
  links: [] as workItems.Link[],
  issues: [] as { repoName: string; number: number; prNumber: number | null; labels: string[] }[],
  roles: new Map<string, Role>(),
};

let server: Server;
let base: string;

beforeEach(async () => {
  next = 1;
  world.numbered = true;
  world.roles = new Map([
    ['jane@acme.test', 'user'],
    ['ada@acme.test', 'admin'],
  ]);
  world.links = [
    // Open: a request, then its issue and its pull request.
    link(213, { kind: 'request', repoId: 'repo-api', number: null, requestId: 'req-1', title: 'Add a palette, as asked' }),
    link(213, { title: 'Add a command palette' }),
    link(213, { kind: 'pull', number: 240, title: 'Add the palette' }),
    // Closed ten days ago.
    link(150, { state: 'closed', closedAt: daysAgo(12) }),
    link(150, { kind: 'pull', number: 151, state: 'merged', closedAt: daysAgo(10) }),
    // Closed forty days ago, read by the board because its issue is still held outside Done.
    link(90, { state: 'closed', closedAt: daysAgo(40) }),
    // Labelled openadlc:ignore.
    link(170, { title: 'A person’s own work' }),
    link(170, { kind: 'pull', number: 171 }),
    // In a repository the install no longer works in.
    link(180, { repoId: 'repo-gone', number: 4 }),
    // A pull request alone, in another repository.
    link(200, { kind: 'pull', repoId: 'repo-web', number: 7, title: 'Bump the docs' }),
  ];
  world.issues = [
    { repoName: 'api', number: 213, prNumber: 240, labels: [] },
    { repoName: 'api', number: 170, prNumber: 171, labels: ['openadlc:ignore'] },
  ];

  const deps: ItemSearchDeps = {
    isNumbered: async () => world.numbered,
    boardLinks: async () => world.links,
    boardIssues: async () => world.issues,
    repos: async () => REPOS,
    organization: async () => 'acme',
    now: () => NOW,
  };
  const lookup: RoleLookup = {
    roleOf: async (identity) => world.roles.get(identity) ?? null,
    admins: async () => ['ada@acme.test'],
    refused: async () => undefined,
  };
  const router = new Router(undefined, undefined, undefined, (method, path, identity) => authorize(lookup, method, path, identity));
  registerItemSearchRoutes(router, deps);
  server = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function read(as: string): Promise<{ status: number; body: { numbered?: boolean; items?: JumpItem[]; error?: string } }> {
  const response = await fetch(`${base}/v1/items`, { headers: { 'x-openadlc-identity': as } });
  return { status: response.status, body: (await response.json()) as never };
}

describe('the jump list', () => {
  it('lists the open items and those closed in the last 30 days, open first', async () => {
    const { status, body } = await read('jane@acme.test');
    expect(status).toBe(200);
    expect(body.numbered).toBe(true);
    expect(body.items).toEqual([
      { key: 'acme-213', number: 213, title: 'Add a command palette', refs: ['api#213', 'api#240'], open: true, closedAt: null },
      { key: 'acme-200', number: 200, title: 'Bump the docs', refs: ['web#7'], open: true, closedAt: null },
      { key: 'acme-150', number: 150, title: 'Item 150', refs: ['api#150', 'api#151'], open: false, closedAt: daysAgo(10) },
    ]);
  });

  it('leaves out one closed 40 days ago, one labelled openadlc:ignore and one in a removed repository', async () => {
    const numbers = (await read('jane@acme.test')).body.items!.map((item) => item.number);
    expect(numbers).not.toContain(90);
    expect(numbers).not.toContain(170);
    expect(numbers).not.toContain(180);
  });

  it('titles an item by its first issue, not the request it was filed from', async () => {
    const item = (await read('jane@acme.test')).body.items!.find((one) => one.number === 213);
    expect(item?.title).toBe('Add a command palette');
  });

  it('is empty before the install is numbered', async () => {
    world.numbered = false;
    expect((await read('jane@acme.test')).body).toEqual({ numbered: false, items: [] });
  });

  it('answers a user and an admin, and refuses someone with no role', async () => {
    expect((await read('jane@acme.test')).status).toBe(200);
    expect((await read('ada@acme.test')).status).toBe(200);
    const refused = await read('eve@elsewhere.test');
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain('Ask an admin');
  });

  it('is a user’s route, and not read as an item called "items"', () => {
    expect(roleFor('GET', '/v1/items')).toBe('user');
  });
});
