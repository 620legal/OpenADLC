import { MERGE_IS_SHIPPING } from '@fleetadlc/shared';
import { describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  listBots: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock('@fleetadlc/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fleetadlc/db')>();
  return {
    ...actual,
    bots: { ...actual.bots, listBots: db.listBots },
    repos: {
      ...actual.repos,
      listRepos: async () => [{ id: 'repo-1', name: 'app', fullName: 'exampleco/app', defaultBranch: 'main' }],
      getRepoByName: async () => ({ id: 'repo-1', name: 'app', fullName: 'exampleco/app', defaultBranch: 'main' }),
    },
  };
});

const { defaultChecks } = await import('./index.js');

/** The real checks' wiring, where it decides what an error means. */

function checks() {
  return defaultChecks({
    config: { automationBot: null } as never,
    actors: {} as never,
    hostd: {} as never,
    webhookSetup: {} as never,
    repoSetup: {} as never,
    delivery: { get: async () => ({ rules: MERGE_IS_SHIPPING }) as never },
  });
}

describe('production-rules', () => {
  it('gives no answer when the crew cannot be read, rather than passing every repository', async () => {
    db.listBots.mockRejectedValueOnce(new Error('connection refused'));
    const check = checks().find((one) => one.id === 'production-rules')!;
    await expect(check.run(new Date())).rejects.toThrow('connection refused');
  });
});
