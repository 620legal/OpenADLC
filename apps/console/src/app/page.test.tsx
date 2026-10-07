import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Whether the board sends someone to the walkthrough. It asks on every load
 * and every refresh of an open board, so it asks the bridge's cheap answer,
 * not the walkthrough, and redirects only on a clear "not complete".
 */

const redirect = vi.hoisted(() =>
  vi.fn((to: string) => {
    throw new Error(`redirected to ${to}`);
  }),
);

vi.mock('next/navigation', () => ({ redirect }));
vi.mock('@/lib/identity', () => ({ identityHeaders: async () => ({}) }));
vi.mock('@/components/board-view', () => ({ BoardView: () => null }));
vi.mock('@/components/bridge-down', () => ({ BridgeDown: ({ error }: { error: Error }) => `down: ${error.message}` }));
vi.mock('@/lib/api', () => ({
  BRIDGE_URL: 'http://bridge.test',
  waitingCount: () => 0,
  // The board itself is beside the point here.
  api: {
    board: () => {
      throw new Error('no board in this test');
    },
  },
}));

import BoardPage from './page';

function bridgeAnswers(answer: () => Promise<Response>) {
  const asked: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      asked.push(url);
      return answer();
    }),
  );
  return asked;
}

const load = (searchParams: Record<string, string> = {}) => BoardPage({ searchParams: Promise.resolve(searchParams) });

afterEach(() => {
  vi.unstubAllGlobals();
  redirect.mockClear();
});

describe('the board, before setup is finished', () => {
  it('asks whether setup is complete, not for the walkthrough, and goes to it on a clear no', async () => {
    const asked = bridgeAnswers(async () => new Response(JSON.stringify({ complete: false })));

    await expect(load()).rejects.toThrow('redirected to /onboarding');
    expect(asked).toEqual(['http://bridge.test/v1/onboarding/complete']);
  });

  it('stays on the board once it is complete, when the bridge cannot be reached, or on an unclear answer', async () => {
    for (const answer of [
      async () => new Response(JSON.stringify({ complete: true })),
      async () => Promise.reject(new Error('connection refused')),
      async () => new Response('{}', { status: 500 }),
      async () => new Response('{}'),
    ]) {
      bridgeAnswers(answer);
      await load();
    }
    expect(redirect).not.toHaveBeenCalled();
  });

  it('does not ask at all on the board link the walkthrough uses', async () => {
    const asked = bridgeAnswers(async () => new Response(JSON.stringify({ complete: false })));

    await load({ board: '1' });
    expect(asked).toEqual([]);
  });
});
