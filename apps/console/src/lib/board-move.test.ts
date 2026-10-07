import { describe, expect, it } from 'vitest';
import type { BoardColumn } from './api';
import { attemptMove, columnsWithMoves, movesBack, NO_MOVES, reconcile, type MoveState } from './board-move';

/** What the bridge answers a move it will not make. Its words, not the console's. */
const REFUSAL = 'local operator tried to move janedoe/FleetADLC#121 from review back to build';

function column(stage: string, refs: string[]): BoardColumn {
  return {
    stage,
    title: stage,
    mode: 'autonomous',
    bots: [],
    cards: refs.map((ref) => ({
      repo: 'janedoe/FleetADLC',
      ref,
      title: `the work behind ${ref}`,
      stage,
      assignees: [],
      gateOpen: false,
      url: null,
      labels: [],
      updatedAt: '2026-09-18T00:00:00.000Z',
    })),
  };
}

/** Every state the board passed through, because a revert is only correct in order. */
function recorder() {
  const states: MoveState[] = [];
  let current: MoveState = NO_MOVES;
  return {
    states,
    update(change: (state: MoveState) => MoveState): void {
      current = change(current);
      states.push(current);
    },
    latest: (): MoveState => current,
  };
}

const whereIs = (columns: BoardColumn[], ref: string): string | undefined =>
  columns.find((entry) => entry.cards.some((card) => card.ref === ref))?.stage;

describe('moving a card between columns', () => {
  it('shows the card in the column it was dropped in before the bridge answers', async () => {
    const board = recorder();
    let answer: (result: { ok: boolean }) => void = () => {};
    const inFlight = new Promise<{ ok: boolean }>((resolve) => {
      answer = resolve;
    });

    const move = attemptMove(
      { ref: 'janedoe/FleetADLC#121', from: 'spec', to: 'build' },
      () => inFlight,
      board.update,
    );

    expect(
      whereIs(columnsWithMoves([column('spec', ['janedoe/FleetADLC#121']), column('build', [])], board.latest()), 'janedoe/FleetADLC#121'),
    ).toBe('build');

    answer({ ok: true });
    await move;
  });

  it('puts the card back when the bridge refuses the move', async () => {
    // A backwards move is the one a person will try first, because dragging left
    // is the obvious way to say "this is not ready". The bridge refuses it, and
    // the card has to end up where it started.
    const board = recorder();

    await attemptMove(
      { ref: 'janedoe/FleetADLC#121', from: 'review', to: 'build' },
      async () => ({ ok: false, error: REFUSAL }),
      board.update,
    );

    const columns = [column('build', []), column('review', ['janedoe/FleetADLC#121'])];
    expect(whereIs(columnsWithMoves(columns, board.latest()), 'janedoe/FleetADLC#121')).toBe('review');
    // In that order: shown in Build first, then back. A card that never
    // moved would be a drag that did nothing, which reads as a broken affordance.
    expect(whereIs(columnsWithMoves(columns, board.states[0]!), 'janedoe/FleetADLC#121')).toBe('build');
  });

  it('says why, in the bridge’s own words, rather than only sliding the card back', async () => {
    const board = recorder();

    await attemptMove(
      { ref: 'janedoe/FleetADLC#121', from: 'review', to: 'build' },
      async () => ({ ok: false, error: REFUSAL }),
      board.update,
    );

    expect(board.latest().refused['janedoe/FleetADLC#121']).toBe(REFUSAL);
  });

  it('counts a request that never arrived as a refusal, not as a move that worked', async () => {
    // The console is offline or the bridge is down. Leaving the card in its new
    // column until a reload is the failure mode this exists to prevent.
    const board = recorder();

    const result = await attemptMove(
      { ref: 'janedoe/FleetADLC#121', from: 'spec', to: 'build' },
      async () => {
        throw new Error('fetch failed');
      },
      board.update,
    );

    expect(result.ok).toBe(false);
    expect(board.latest().pending).toEqual({});
    expect(board.latest().refused['janedoe/FleetADLC#121']).toBe('fetch failed');
  });

  it('clears the last refusal when the card is moved again', async () => {
    const board = recorder();
    const card = { ref: 'janedoe/FleetADLC#121', from: 'review' };

    await attemptMove({ ...card, to: 'build' }, async () => ({ ok: false, error: REFUSAL }), board.update);
    await attemptMove({ ...card, to: 'merged' }, async () => ({ ok: true }), board.update);

    expect(board.latest().refused).toEqual({});
  });

  it('asks the bridge nothing when a card is dropped in the column it is already in', async () => {
    // Otherwise every mis-aimed drag is a `board.move` in the audit trail.
    const board = recorder();
    let asked = 0;

    await attemptMove(
      { ref: 'janedoe/FleetADLC#121', from: 'build', to: 'build' },
      async () => {
        asked += 1;
        return { ok: true };
      },
      board.update,
    );

    expect(asked).toBe(0);
    expect(board.states).toEqual([]);
  });
});

describe('the board catching up with a move', () => {
  const moved: MoveState = {
    pending: { 'janedoe/FleetADLC#121': { from: 'spec', to: 'build' } },
    refused: {},
  };

  it('keeps showing the move while the board still has the card where it was', () => {
    const stale = [column('spec', ['janedoe/FleetADLC#121']), column('build', [])];

    expect(reconcile(moved, stale)).toBe(moved);
  });

  it('stops overriding once the board agrees, so the board is what is on screen', () => {
    const fresh = [column('spec', []), column('build', ['janedoe/FleetADLC#121'])];

    expect(reconcile(moved, fresh).pending).toEqual({});
  });

  it('gives way when somebody else moves the same card somewhere else', () => {
    // Two people on one board, or a bot finishing the stage mid-drag. Pinning
    // the card to where this browser put it would hide what actually happened.
    const elsewhere = [column('spec', []), column('build', []), column('review', ['janedoe/FleetADLC#121'])];

    expect(reconcile(moved, elsewhere).pending).toEqual({});
  });

  it('gives way when the card leaves the board entirely', () => {
    // A closed issue is forgotten from the read model, and an override for a
    // card nothing shows would never be retired.
    expect(reconcile(moved, [column('spec', []), column('build', [])]).pending).toEqual({});
  });

  it('keeps the refusal, which is not something the board can answer', () => {
    const refused: MoveState = { ...moved, refused: { 'janedoe/FleetADLC#121': REFUSAL } };
    const fresh = [column('spec', []), column('build', ['janedoe/FleetADLC#121'])];

    expect(reconcile(refused, fresh).refused).toEqual({ 'janedoe/FleetADLC#121': REFUSAL });
  });
});

describe('a move back', () => {
  const columns = ['intake', 'spec', 'build', 'review', 'merged', 'done'].map((stage) => ({ stage }));

  it('is a move to an earlier column, which the board asks a reason for', () => {
    expect(movesBack('review', 'build', columns)).toBe(true);
    expect(movesBack('build', 'intake', columns)).toBe(true);
    expect(movesBack('build', 'review', columns)).toBe(false);
    expect(movesBack('build', 'done', columns)).toBe(false);
    expect(movesBack('build', 'nowhere', columns)).toBe(false);
  });
});
