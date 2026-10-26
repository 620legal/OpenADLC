// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttentionItem, Board, CrewMember } from '@/lib/api';

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

/**
 * The count above the columns, over a board with no card running: "1 task
 * running" while intake triaged a console request, and nothing said what.
 */
describe('the running count over a board whose cards do not run', () => {
  const answer = (body: unknown) => ({ ok: true, json: async () => body });
  const activityCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/board/activity'));
  const triage = {
    id: 'task-triage', bot: 'intake', kind: 'intake', skill: null, round: 0, subject: 'request:b4378305', repo: null,
    title: 'Open the running count into a list', opens: 'request:b4378305', since: '2026-09-24T11:55:00.000Z',
  };
  // Nothing in the columns this week, and something in Done before it: a quiet board, not the first run's.
  const quiet: Board = { ...BOARD, running: 1, runningTasks: [triage], doneBefore: true, columns: BOARD.columns.map((column) => ({ ...column, cards: [] })) };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    router.refresh.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function drawQuiet(): Promise<void> {
    const { BoardView } = await import('./board-view');
    const { headerData } = await import('@/lib/header');
    const header = headerData({ repos: ['openadlc'], crew: [BUILDER], budget: null, needsYou: 0 });
    await act(async () => root.render(<BoardView board={quiet} crew={[BUILDER]} repo="all" header={header} attention={[]} now={NOW} />));
  }

  it('opens into the task running, whose row opens its request in the item sheet', async () => {
    // The item sheet's own read is left pending: this is about which sheet opens, not what it says.
    vi.stubGlobal('fetch', vi.fn((url: string) => (String(url).startsWith('/api/board/activity') ? Promise.resolve(answer({ running: 1, runningTasks: [triage], cards: [] })) : new Promise(() => undefined))));
    await drawQuiet();
    const count = container.querySelector('[role="status"][data-running] button') as HTMLButtonElement;
    expect(count.textContent).toBe('1 task running');
    await act(async () => count.click());
    const row = container.querySelector('[aria-label="Tasks running"] a') as HTMLAnchorElement;
    expect(row.textContent).toContain('Open the running count into a list');
    expect(row.textContent).toContain('triage');
    expect(row.textContent).toContain('5 min');
    expect(row.getAttribute('href')).toBe('/?item=request%3Ab4378305');
    expect(container.querySelector('aside[aria-label="A piece of work"]')).toBeNull();
    await act(async () => row.click());
    expect(container.querySelector('aside[aria-label="A piece of work"]')).not.toBeNull();
  });

  it('polls while the list is open though no card runs, and lists what the poll says, without reading the whole page', async () => {
    const fetchMock = vi.fn(async () => answer({ running: 1, runningTasks: [{ ...triage, title: 'Retitled in the meantime' }], cards: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await drawQuiet();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    // Closed, nothing on the board runs, and nothing is polled.
    expect(activityCalls(fetchMock)).toEqual([]);

    await act(async () => (container.querySelector('[data-running] button') as HTMLButtonElement).click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(activityCalls(fetchMock).length).toBeGreaterThan(0);
    expect(container.querySelector('[aria-label="Tasks running"] a')?.textContent).toContain('Retitled in the meantime');
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

/**
 * A plan change approved while other work holds its paths keeps its question
 * open. The card said "Waiting for your answer" while Needs you said the
 * builder waited for #44 to let go of the approved path (#100).
 */
describe('a card whose approved plan change waits on other work', () => {
  const asking: Board = {
    ...BOARD,
    running: 0,
    columns: BOARD.columns.map((column) => ({
      ...column,
      cards: column.cards.map((card) => ({
        ...card,
        ref: 'openadlc#60',
        number: 60,
        gateOpen: true,
        active: [{ ...card.active![0]!, state: 'paused' as const, activity: null }],
      })),
    })),
  };
  const waiting: AttentionItem = {
    id: 'plan-change:gate-60',
    kind: 'plan_change_waiting',
    headline: 'The builder (openadlc-atlas-janedoe) waits for #44 to let go of the approved path',
    subject: { repo: 'openadlc', number: 60, title: 'Let the board filter by label', ref: 'openadlc#60', url: null, item: 'openadlc#60' },
    bot: null,
    since: NOW,
    detail: 'janedoe approved adding `apps/probe60-more/util.ts`.',
    actions: [{ kind: 'answer_gate', label: 'Refuse', gateId: 'gate-60', answer: 'Refuse' }],
    heldApproval: { blockedBy: [44], paths: ['apps/probe60-more/util.ts'] },
  };
  const question: AttentionItem = {
    ...waiting,
    id: 'gate:gate-61',
    kind: 'question',
    headline: 'The builder has a question',
    question: { gateId: 'gate-61', options: ['p1', 'p2'] },
    actions: [],
  };
  const statusWith = async (attention: AttentionItem[]): Promise<string | null | undefined> => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ running: 0, cards: [] }) })));
    const { BoardView } = await import('./board-view');
    const { headerData } = await import('@/lib/header');
    const header = headerData({ repos: ['openadlc'], crew: [BUILDER], budget: null, needsYou: attention.length });
    await act(async () => root.render(<BoardView board={asking} crew={[BUILDER]} repo="all" header={header} attention={attention} now={NOW} />));
    return container.querySelector('[aria-label="Board"] [data-status]')?.textContent;
  };

  it('says it waits for that work, as Needs you does, not for the person’s answer', async () => {
    expect(await statusWith([waiting])).toBe('Approved · waits for #44 to let go of the path');
  });

  it('still waits for the person when a question of its own is open beside it', async () => {
    expect(await statusWith([waiting, question])).toBe('Waiting for your answer');
    expect(await statusWith([])).toBe('Waiting for your answer');
  });
});

/**
 * A card with nothing going on it, drawn: why it waits, on what and for how
 * long, and a stuck one looks stuck, with a mark that never moves and words
 * a screen reader reads (#144). #141 said "Waiting for a design pass" for
 * half an hour, and nobody could tell whether anything was happening.
 */
describe('a card waiting with nothing going on it', () => {
  const DESIGNER = { name: 'system-engineer', role: 'spec', maxTasks: 1 };
  const waitingCard = (number: number, waiting: NonNullable<Board['columns'][number]['cards'][number]['waiting']>, extra: Partial<Board['columns'][number]['cards'][number]> = {}) => ({
    repo: 'openadlc',
    ref: `openadlc#${number}`,
    title: `Issue ${number}`,
    stage: 'spec',
    assignees: [],
    gateOpen: false,
    url: null,
    labels: ['adlc:spec'],
    updatedAt: NOW,
    number,
    active: [],
    last: null,
    waiting,
    ...extra,
  });
  const since = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
  const boardOf = (cards: Board['columns'][number]['cards']): Board => ({
    ...BOARD,
    running: 0,
    columns: BOARD.columns.map((column) => ({ ...column, cards: column.stage === 'spec' ? cards : [] })),
  });
  async function drawn(board: Board): Promise<Element[]> {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ running: 0, cards: [] }) })));
    const { BoardView } = await import('./board-view');
    const { headerData } = await import('@/lib/header');
    const header = headerData({ repos: ['openadlc'], crew: [BUILDER], budget: null, needsYou: 0 });
    await act(async () => root.render(<BoardView board={board} crew={[BUILDER]} repo="all" header={header} attention={[]} now={NOW} />));
    return [...container.querySelectorAll('[aria-label="Board"] article')];
  }
  const line = (card: Element) => card.querySelector('[data-status]')?.textContent;

  it('says the seat it waits for and the task on it', async () => {
    const [waiting] = await drawn(
      boardOf([
        waitingCard(141, {
          reason: { kind: 'seat', seat: DESIGNER, seats: 1, holders: [{ ref: 'openadlc#137', number: 137, kind: 'spec', state: 'running', waitingOnYou: false }] },
          since: since(32),
          stuck: false,
        }),
      ]),
    );
    expect(line(waiting!)).toBe('Waiting for the system engineer · busy with #137 · 32 min');
    expect(waiting!.querySelector('[data-stuck]')).toBeNull();
  });

  it('says a build waits for its repository’s build slot, held by a build waiting for your answer, and that build says it holds it', async () => {
    const board = boardOf([]);
    const waiting = waitingCard(
      160,
      { reason: { kind: 'concurrency', limit: 1, holders: [{ ref: 'openadlc#40', number: 40, kind: 'implement', state: 'paused', waitingOnYou: true }] }, since: since(32), stuck: false },
      { stage: 'build', labels: ['adlc:build', 'start:now'] },
    );
    const holding = waitingCard(40, null as never, {
      stage: 'build',
      labels: ['adlc:build', 'start:now'],
      waiting: null,
      gateOpen: true,
      active: [{ bot: 'openadlc-atlas-janedoe', kind: 'implement', state: 'paused', round: 0, startedAt: since(200), endedAt: null, exitReason: null, holds: { repo: 'openadlc', limit: 1, waiting: 1 } }],
    });
    board.columns = board.columns.map((column) => (column.stage === 'build' ? { ...column, cards: [waiting, holding] } : column));
    const [behind, asking] = await drawn(board);
    expect(line(behind!)).toBe('Waiting: openadlc builds 1 at a time · busy with #40 (waiting for your answer) · 32 min');
    expect(line(asking!)).toBe('Waiting for your answer · holds openadlc’s build slot');
  });

  it('says what starts a card whose seat is free, and when', async () => {
    const [card] = await drawn(
      boardOf([waitingCard(141, { reason: { kind: 'free', seat: DESIGNER, by: 'sweep', nextAt: new Date(Date.parse(NOW) + 24 * 60_000).toISOString() }, since: since(2), stuck: false })]),
    );
    expect(line(card!)).toBe('Not started · the system engineer is free · next sweep in 24 min · 2 min');
    expect(card!.querySelector('[data-stuck]')).toBeNull();
  });

  it('says what the issue it depends on is doing', async () => {
    const board = boardOf([]);
    const blocked = waitingCard(
      137,
      { reason: { kind: 'dependency', on: [{ number: 141, stage: 'spec', abandoned: false, task: null, waits: { kind: 'seat', seat: 'system-engineer' } }] }, since: since(32), stuck: false },
      { stage: 'build', labels: ['adlc:build', 'blocked'] },
    );
    // In Build, where a blocked card stands.
    board.columns = board.columns.map((column) => (column.stage === 'build' ? { ...column, cards: [blocked] } : column));
    const [card] = await drawn(board);
    expect(line(card!)).toBe('Waiting on #141 (waiting for the system engineer) · 32 min');
  });

  it('draws each other reason as a line of its own, with how long', async () => {
    const reasons = [
      [{ kind: 'turn', seat: DESIGNER, after: ['openadlc#141'] }, 'Waiting its turn, after #141 · 32 min'],
      [{ kind: 'lease', on: [44], paths: ['apps/bridge/src/api.ts'] }, 'Waiting for #44 to let go of apps/bridge/src/api.ts · 32 min'],
      [{ kind: 'paused', words: 'work is paused' }, 'Waiting until work is resumed · 32 min'],
      [{ kind: 'seat_paused', seat: DESIGNER, words: 'paused' }, 'Waiting for the system engineer · paused on Crew · 32 min'],
      [{ kind: 'blocked', seat: DESIGNER, why: 'system-engineer cannot sign in to GitHub', instruction: '' }, 'Waiting: system-engineer cannot sign in to GitHub · 32 min'],
      [{ kind: 'cap', words: 'at the cap' }, 'Held at the spending cap · 32 min'],
      [{ kind: 'no_seat', role: 'spec' }, 'Nobody staffs Design · add a seat on Crew · 32 min'],
      [{ kind: 'not_staffed' }, 'Design is left to a person in openadlc · move it on by hand · 32 min'],
    ] as const;
    const cards = await drawn(boardOf(reasons.map(([reason], index) => waitingCard(200 + index, { reason: reason as never, since: since(32), stuck: false }))));
    expect(cards.map(line)).toEqual(reasons.map(([, text]) => text));
  });

  it('says what a Build card’s own lease waits for, and when only a host’s room holds a card, with no stuck mark (#153)', async () => {
    const board = boardOf([]);
    const build = { stage: 'build', labels: ['adlc:build', 'start:now'] };
    const leased = (number: number, state: string, pr: number | null, merged: boolean) =>
      waitingCard(number, { reason: { kind: 'leased', bot: 'openadlc-atlas-janedoe', state, pr, merged }, since: since(32), stuck: false }, build);
    board.columns = board.columns.map((column) =>
      column.stage === 'build'
        ? {
            ...column,
            cards: [
              leased(160, 'leased', null, false),
              leased(161, 'paused', null, false),
              leased(162, 'in_task', 57, true),
              waitingCard(163, { reason: { kind: 'host', running: 4, capacity: 4 }, since: since(32), stuck: false }, build),
            ],
          }
        : column,
    );
    const cards = await drawn(board);
    expect(cards.map(line)).toEqual([
      'Leased to the builder (openadlc-atlas-janedoe) · its build hasn’t started · 32 min',
      'Leased to the builder (openadlc-atlas-janedoe) · paused after its task ended · 32 min',
      'Leased to the builder (openadlc-atlas-janedoe) · held by merged #57 until its verification ends · 32 min',
      'Waiting for a host with room (4 of 4 running) · 32 min',
    ]);
    for (const card of cards) expect(card.querySelector('[data-stuck]')).toBeNull();
  });

  describe('a stuck card', () => {
    const stuck = () =>
      boardOf([
        waitingCard(141, { reason: { kind: 'free', seat: DESIGNER, by: 'runner' }, since: since(41), stuck: true }),
      ]);

    it('looks stuck: its line says so, in the alarm colour, its border too, and its mark is still', async () => {
      const [card] = await drawn(stuck());
      expect(line(card!)).toBe('Stuck · the system engineer is free and nothing started it · starts within a minute · 41 min');
      expect(card!.querySelector('[data-status]')?.className).toContain('text-alarm');
      expect(card!.className).toContain('border-alarm/40');
      const mark = card!.querySelector('[data-stuck]')!;
      expect(mark.classList.contains('bg-alarm')).toBe(true);
      expect(mark.classList.contains('working-dot')).toBe(false);
      // Its words carry it to a screen reader; the mark is not read twice, nor as working.
      expect(mark.getAttribute('aria-hidden')).toBe('true');
      expect(card!.querySelector('[aria-label="working"]')).toBeNull();
    });

    it('is the same under prefers-reduced-motion: nothing on it moves either way', async () => {
      reduced = true;
      const [card] = await drawn(stuck());
      expect(card!.querySelector('[data-stuck]')?.classList.contains('bg-alarm')).toBe(true);
      expect(card!.innerHTML).not.toContain('working-dot');
      expect(line(card!)).toContain('Stuck');
    });
  });
});
