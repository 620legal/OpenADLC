import type { BoardColumn } from './api';

/**
 * Moving a card between columns, and what the board shows while the bridge has
 * not answered yet.
 *
 * The bridge is the authority on whether a move is allowed, and GitHub's label
 * is what actually changes, so the console does not keep its own copy of the
 * rules: it shows the move immediately, and puts the card back with the
 * bridge's own sentence when the answer is no. A card that silently returned to
 * its old column would look like a bug in the drag rather than a refusal.
 *
 * A person may move a card anywhere; a move back takes a reason, which the
 * stage it goes to works from (`movesBack` only decides when to ask for one).
 */

/** Where a card was dropped, and where it was before that. */
export interface PendingMove {
  from: string;
  to: string;
}

export interface MoveState {
  /** Card ref to the move the board is showing ahead of the bridge. */
  pending: Record<string, PendingMove>;
  /** Card ref to why the bridge refused, kept until that card is moved again. */
  refused: Record<string, string>;
}

export const NO_MOVES: MoveState = { pending: {}, refused: {} };

export interface MoveResult {
  ok: boolean;
  error?: string;
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

/**
 * Runs one move: shows it at once, then keeps it or puts the card back.
 *
 * `commit` is the server action, passed in rather than imported, so the two
 * answers it can give can be asked of this without a bridge.
 */
export async function attemptMove(
  card: { ref: string; from: string; to: string },
  commit: (to: string) => Promise<MoveResult>,
  update: (change: (state: MoveState) => MoveState) => void,
): Promise<MoveResult> {
  // Dropping a card back where it came from is not a request; sending it would
  // put a `board.move` in the audit trail for a gesture that changed nothing.
  if (card.to === card.from) return { ok: true };

  update((state) => ({
    pending: { ...state.pending, [card.ref]: { from: card.from, to: card.to } },
    refused: without(state.refused, card.ref),
  }));

  const result = await commit(card.to).catch(
    (error: unknown): MoveResult => ({
      ok: false,
      error: error instanceof Error ? error.message : 'the move did not reach the bridge',
    }),
  );

  if (!result.ok) {
    update((state) => ({
      pending: without(state.pending, card.ref),
      refused: { ...state.refused, [card.ref]: result.error ?? 'that move was refused' },
    }));
  }

  // On success the override stays until the re-read board agrees, so the card
  // does not flick back to its old column in the gap.
  return result;
}

/**
 * Drops the overrides the board has caught up with.
 *
 * An override covers the gap between the drop and the next read of the board,
 * and nothing longer. Once the board stops showing the card where it was
 * dragged from, the board is the record — including when it disagrees with
 * where the card was dropped, which is what somebody else moving the same card
 * looks like from here.
 */
export function reconcile(state: MoveState, columns: BoardColumn[]): MoveState {
  const stages = new Map<string, string>();
  for (const column of columns) {
    for (const card of column.cards) stages.set(card.ref, column.stage);
  }

  const pending: Record<string, PendingMove> = {};
  for (const [ref, move] of Object.entries(state.pending)) {
    if (stages.get(ref) === move.from) pending[ref] = move;
  }

  // The same object back when nothing was stale, because this runs on every
  // board the poll delivers and a new object every time would never settle.
  return Object.keys(pending).length === Object.keys(state.pending).length
    ? state
    : { pending, refused: state.refused };
}

/** The columns as the person sees them: the board, plus the moves in flight. */
export function columnsWithMoves(columns: BoardColumn[], state: MoveState): BoardColumn[] {
  if (Object.keys(state.pending).length === 0) return columns;

  const moving = new Map<string, { to: string; card: BoardColumn['cards'][number] }>();
  for (const column of columns) {
    for (const card of column.cards) {
      const move = state.pending[card.ref];
      if (move && move.from === column.stage) moving.set(card.ref, { to: move.to, card });
    }
  }
  if (moving.size === 0) return columns;

  return columns.map((column) => ({
    ...column,
    cards: [
      ...column.cards.filter((card) => !moving.has(card.ref)),
      // Appended rather than sorted in: where it belongs in the column is the
      // board's answer, and the board is about to give it.
      ...[...moving.values()].filter((entry) => entry.to === column.stage).map((entry) => entry.card),
    ],
  }));
}

/**
 * Whether a move goes to an earlier column: a person sending the work back,
 * which the bridge takes only with a reason, since the stage it goes to works
 * from it. By the columns' order, which is the pipeline's.
 */
export function movesBack(from: string, to: string, columns: readonly Pick<BoardColumn, 'stage'>[]): boolean {
  const order = columns.map((column) => column.stage);
  const at = order.indexOf(from);
  const target = order.indexOf(to);
  return at >= 0 && target >= 0 && target < at;
}
