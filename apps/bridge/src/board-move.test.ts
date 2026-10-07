import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A person moving a card on the board (`POST /v1/board/move`): anywhere, and
 * back only with a reason, which the stage it goes to works from.
 */

const ISSUE = { number: 7, stage: 'review', prNumber: 31, labels: ['adlc:review'] };

vi.mock('@fleetadlc/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fleetadlc/db')>()),
  audit: vi.fn(async () => undefined),
  issues: { getIssue: vi.fn(async () => ISSUE) },
  repos: { getRepoByName: vi.fn(async () => ({ id: 'repo-1', name: 'fleetadlc-testbed', fullName: 'janedoe/fleetadlc-testbed' })) },
}));

const moveStage = vi.fn(async (_input: Record<string, unknown>) => ({ moved: true }));
const fromPerson = vi.fn(async (_input: Record<string, unknown>) => ({ sent: true, from: 'review', to: 'build', staffed: true, round: 0, commentUrl: null }));

let bridge: Server;
let bridgeUrl: string;

beforeEach(async () => {
  const { registerConsoleApi } = await import('./api.js');
  const { Router } = await import('./router.js');
  const router = new Router();
  registerConsoleApi(router, {
    config: { gitHubClientId: '', webhookSecret: '', humans: [], review: { maxRounds: 3 } } as never,
    hostd: {} as never,
    actors: {} as never,
    invitations: {} as never,
    automation: { moveStage } as never,
    gates: {} as never,
    taskService: {} as never,
    threadStream: { subscribe: () => () => undefined, watching: 0 } as never,
    onboarding: {} as never,
    webhookSetup: {} as never,
    repoSetup: {} as never,
    sendBack: { fromPerson } as never,
  });
  bridge = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  bridgeUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
});

afterEach(async () => {
  vi.clearAllMocks();
  await new Promise<void>((resolve) => bridge.close(() => resolve()));
});

const move = (body: Record<string, unknown>) =>
  fetch(`${bridgeUrl}/v1/board/move`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo: 'fleetadlc-testbed', issue: 7, ...body }) });

describe('a person moving a card', () => {
  it('refuses a move back with no reason, and says why one is needed', async () => {
    const response = await move({ to: 'build' });
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/say why .* goes back to Build/);
    expect(fromPerson).not.toHaveBeenCalled();
  });

  it('sends the work back with the person’s reason', async () => {
    const response = await move({ to: 'build', reason: ' the cache key is wrong ' });
    expect(response.status).toBe(200);
    expect(fromPerson).toHaveBeenCalledWith(expect.objectContaining({ repoName: 'fleetadlc-testbed', issueNumber: 7, to: 'build', reason: 'the cache key is wrong' }));
    expect(moveStage).not.toHaveBeenCalled();
  });

  it('moves a card on past a stage as the person’s move, which a bot could not make', async () => {
    const response = await move({ to: 'done' });
    expect(response.status).toBe(200);
    expect(moveStage).toHaveBeenCalledWith(expect.objectContaining({ to: 'done', direction: 'person' }));
  });

  it('refuses a stage that is not one', async () => {
    expect((await move({ to: 'shipped' })).status).toBe(400);
  });
});
