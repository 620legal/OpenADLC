// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Board, CrewMember } from '@/lib/api';

/**
 * A card whose task runs, drawn in a browser: its dot pulses unless the
 * person's system asks for less motion, and is there and read as working
 * either way.
 */

vi.mock('@/app/actions', () => ({ moveCard: vi.fn(async () => ({ ok: true })) }));
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

/** Whether the person's system asks for less motion, as `matchMedia` answers it. */
let reduced = false;

const BUILDER: CrewMember = {
  name: 'openadlc-atlas-janedoe',
  slot: 'builder',
  displayName: 'builder',
  role: 'implement',
  engine: 'claude',
  model: 'claude-opus-5',
  status: 'stopped',
  container: 'bot-builder',
  githubLogin: 'openadlc-atlas-janedoe',
  authorization: 'active',
  tokenExpiresAt: null,
  now: 'nothing running',
  paused: false,
  sessions: [],
};

const NOW = '2026-09-24T12:00:00.000Z';
const TITLES: Record<string, string> = { intake: 'Intake', spec: 'Design', build: 'Build', review: 'Review', merged: 'Ship', done: 'Done' };
const BOARD: Board = {
  repo: 'all',
  repos: ['openadlc'],
  columns: Object.keys(TITLES).map((stage) => ({
    stage,
    title: TITLES[stage]!,
    mode: 'autonomous',
    bots: [],
    cards:
      stage === 'build'
        ? [
            {
              repo: 'openadlc',
              ref: 'openadlc#16',
              title: 'Let the board filter by label',
              stage: 'build',
              assignees: ['openadlc-atlas-janedoe'],
              gateOpen: false,
              url: null,
              labels: ['adlc:build', 'start:now'],
              updatedAt: NOW,
              number: 16,
              active: [{ bot: 'openadlc-atlas-janedoe', kind: 'implement', state: 'running', round: 0, startedAt: '2026-09-24T11:48:00.000Z', endedAt: null, exitReason: null, activity: 'running tests' }],
              last: null,
            },
          ]
        : [],
  })),
  mergeLine: [],
  waitingOnYou: 0,
  working: 1,
  idle: 0,
  running: 1,
};

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  reduced = false;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? reduced : false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function draw(): Promise<void> {
  const { BoardView } = await import('./board-view');
  const { headerData } = await import('@/lib/header');
  const header = headerData({ repos: ['openadlc'], crew: [BUILDER], budget: null, needsYou: 0 });
  await act(async () => root.render(<BoardView board={BOARD} crew={[BUILDER]} repo="all" header={header} attention={[]} now={NOW} />));
}

/** The card's mark and the count's, on the desktop board. */
function marks(): { card: Element | null; count: Element | null } {
  const board = container.querySelector('[aria-label="Board"]');
  return {
    card: board?.querySelector('[data-status] [aria-label="working"]') ?? null,
    count: container.querySelector('[data-running] span') ?? null,
  };
}

describe('a running card’s live mark', () => {
  it('pulses, and is read as working', async () => {
    await draw();
    const { card, count } = marks();
    expect(card?.getAttribute('role')).toBe('img');
    expect(card?.classList.contains('working-dot')).toBe(true);
    expect(count?.classList.contains('working-dot')).toBe(true);
    expect(container.querySelector('[aria-label="Board"] [data-status]')?.textContent).toBe('Builder · running tests · 12 min');
  });

  it('stays still under prefers-reduced-motion, and is still there and still read as working', async () => {
    reduced = true;
    await draw();
    const { card, count } = marks();
    expect(card).not.toBeNull();
    expect(card?.getAttribute('aria-label')).toBe('working');
    expect(card?.classList.contains('bg-signal')).toBe(true);
    expect(card?.classList.contains('working-dot')).toBe(false);
    expect(count?.classList.contains('bg-signal')).toBe(true);
    expect(count?.classList.contains('working-dot')).toBe(false);
    expect(container.innerHTML).not.toContain('working-dot');
  });
});

describe('a running card’s line, between reads of the whole board', () => {
  const answer = (body: unknown) => ({ ok: true, json: async () => body });
  const activityCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/board/activity'));

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    router.refresh.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('follows what the bot is doing every five seconds, in place, without reading the whole page', async () => {
    const running = BOARD.columns.find((column) => column.stage === 'build')!.cards[0]!.active![0]!;
    const fetchMock = vi.fn(async () => answer({ running: 3, cards: [{ ref: 'openadlc#16', active: [{ ...running, activity: 'committing' }] }] }));
    vi.stubGlobal('fetch', fetchMock);
    await draw();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(activityCalls(fetchMock).map(([url]) => url)).toEqual(['/api/board/activity?repo=all']);
    expect(container.querySelector('[aria-label="Board"] [data-status]')?.textContent).toBe('Builder · committing · 12 min');
    expect(container.querySelector('[data-running]')?.textContent).toBe('3 tasks running');
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('reads the whole board at once when the card stops running, and only once for it', async () => {
    const fetchMock = vi.fn(async () => answer({ running: 0, cards: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await draw();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(router.refresh).toHaveBeenCalledTimes(1);
    // The same news again before the whole board is back asks nothing more.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('polls nothing while nothing on the board runs', async () => {
    const fetchMock = vi.fn(async () => answer({ running: 0, cards: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const still: Board = { ...BOARD, running: 0, columns: BOARD.columns.map((column) => ({ ...column, cards: [] })) };
    const { BoardView } = await import('./board-view');
    const { headerData } = await import('@/lib/header');
    const header = headerData({ repos: ['openadlc'], crew: [BUILDER], budget: null, needsYou: 0 });
    await act(async () => root.render(<BoardView board={still} crew={[BUILDER]} repo="all" header={header} attention={[]} now={NOW} />));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(activityCalls(fetchMock)).toEqual([]);
  });
});
