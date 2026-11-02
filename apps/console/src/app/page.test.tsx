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
// The board itself is beside the point here, unless a test gives one.
const reads = vi.hoisted(() => ({
  board: (): Promise<unknown> => {
    throw new Error('no board in this test');
  },
  gap: (): Promise<unknown> => Promise.resolve(null),
}));
vi.mock('@/lib/api', () => ({
  BRIDGE_URL: 'http://bridge.test',
  waitingCount: () => 0,
  api: {
    board: () => reads.board(),
    crew: async () => ({ bots: [] }),
    costs: async () => null,
    attention: async () => ({ items: [] }),
    workPauses: async () => null,
    repos: async () => ({ repos: [] }),
    bridgeGap: () => reads.gap(),
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

describe('the report of how long the bridge was away, on the board', () => {
  const GAP = { lastUpAt: '2026-11-02T14:02:00.000Z', backAt: '2026-11-02T14:03:10.000Z', awayMs: 70_000, tasks: [], filling: false };

  afterEach(() => {
    reads.board = () => {
      throw new Error('no board in this test');
    };
    reads.gap = () => Promise.resolve(null);
  });

  it('is given to the board as the bridge has it', async () => {
    reads.board = async () => ({ columns: [], repos: [] });
    reads.gap = async () => GAP;
    const page = (await load({ board: '1' })) as { props: { gap?: unknown } };
    expect(page.props.gap).toEqual(GAP);
  });

  it('is left out when its read fails, and the board is still drawn, not the bridge-down page', async () => {
    reads.board = async () => ({ columns: [], repos: [] });
    reads.gap = async () => Promise.reject(new Error('the bridge is not answering'));
    const page = (await load({ board: '1' })) as { props: { gap?: unknown; error?: unknown } };
    expect(page.props.error).toBeUndefined();
    expect(page.props.gap).toBeNull();
  });
});
