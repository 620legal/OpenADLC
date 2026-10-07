import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Whether setup is complete, as the board asks it on every load and every
 * 15-second refresh. Working it out asks GitHub about every bot in every
 * repository, so once it is true it is remembered; while false it is asked
 * afresh, so a step just finished is seen on the next load.
 */

const world = vi.hoisted(() => ({
  crew: [] as { id: string; name: string; slot: string; role: string; githubLogin: string | null }[],
  /** What GitHub says each bot may do in the repository. */
  pushes: new Map<string, boolean>(),
  /** Every request made to GitHub, by anyone. */
  asked: [] as string[],
}));

vi.mock('@fleetadlc/db', () => ({
  audit: vi.fn(async () => undefined),
  bots: { listBots: vi.fn(async () => world.crew.map((bot) => ({ ...bot }))) },
  credentials: { getCredential: vi.fn(async (id: string) => ({ githubLogin: id, status: 'active', secretRef: id, scopes: [] })) },
  identities: {},
  repos: { listRepos: vi.fn(async () => [{ id: 'repo-1', name: 'shop', fullName: 'exampleco/shop' }]) },
  settings: { allSettings: vi.fn(async () => ({ githubClientId: 'Iv1.test', webhookSecret: 'secret' })) },
}));

vi.mock('./sign-in.js', () => ({
  signInKind: vi.fn(async () => 'refresh'),
  signInOf: vi.fn(async (bot: { name: string }) => ({ ns: bot.name })),
}));

vi.mock('./github-accounts.js', () => ({
  loginAvailable: vi.fn(async (login: string) => {
    world.asked.push(`GET /users/${login}`);
    return false;
  }),
  lookUpAccount: vi.fn(async (login: string) => {
    world.asked.push(`GET /users/${login}`);
    return { exact: null };
  }),
}));

import { Onboarding } from './onboarding.js';

/** A GitHub client that counts what it is asked. */
function clientFor(bot: string) {
  return {
    request: async (method: string, path: string) => {
      world.asked.push(`${method} ${path}`);
      return { permissions: { push: world.pushes.get(bot) ?? false } };
    },
  };
}

function onboarding(): Onboarding {
  return new Onboarding(
    { gitHubClientId: '', webhookSecret: '', humans: [], organization: '', publicUrl: '', automationBot: null } as never,
    { asBot: async (name: string) => clientFor(name) } as never,
  );
}

beforeEach(() => {
  world.crew = [
    { id: 'b-builder', name: 'builder', slot: 'builder', role: 'implement', githubLogin: 'exampleco-crew' },
    { id: 'b-automation', name: 'automation', slot: 'automation', role: 'automation', githubLogin: 'exampleco-flow' },
  ];
  world.pushes = new Map([
    ['builder', true],
    ['automation', true],
  ]);
  world.asked = [];
});

describe('whether setup is complete, as the board asks it', () => {
  it('asks GitHub nothing more once it has been found complete', async () => {
    const flow = onboarding();

    expect(await flow.complete()).toBe(true);
    const first = world.asked.length;
    expect(first).toBeGreaterThan(0);

    expect(await flow.complete()).toBe(true);
    expect(await flow.complete()).toBe(true);
    expect(world.asked).toHaveLength(first);
  });

  it('works an unfinished setup out afresh each time, so a step just finished is seen on the next load', async () => {
    world.pushes.set('builder', false);
    const flow = onboarding();

    expect(await flow.complete()).toBe(false);
    const first = world.asked.length;
    expect(await flow.complete()).toBe(false);
    expect(world.asked.length).toBeGreaterThan(first);

    // The builder is let into the repository.
    world.pushes.set('builder', true);
    expect(await flow.complete()).toBe(true);
  });

  it('says what the walkthrough says', async () => {
    world.pushes.set('automation', false);
    const flow = onboarding();

    expect(await flow.complete()).toBe((await flow.view(null)).complete);
    world.pushes.set('automation', true);
    expect(await flow.complete()).toBe((await flow.view(null)).complete);
  });
});
