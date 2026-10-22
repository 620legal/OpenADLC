import type { Board, CardTask } from './api';

/**
 * Keeping a running card's line current between reads of the whole board.
 *
 * The page is read again every fifteen seconds (`LiveRefresh`), and a card's
 * line, "Builder · running tests · 12 min", said a step for most of that
 * after the bot had moved on. Reading the whole page every five seconds while
 * anything ran read the board, the crew, the costs and what needs you for
 * every person looking, nearly all the time on a busy install. So while a card
 * on the board runs, the board asks the bridge for its running cards alone
 * (`GET /v1/board/activity`) and changes their tasks in place. A card that
 * started, paused or ended is said from what only the whole board has, so
 * then it is read again at once. The poll is `BoardActivityPoll`.
 */

/** How often the running cards are read. hostd looks at each session every ten seconds; sooner would read the same step again. */
export const ACTIVITY_EVERY_MS = 5_000;

/** What the bridge says of the running cards: each with every task going on it now, and the install's count. */
export interface BoardActivity {
  running: number;
  cards: { ref: string; active: CardTask[] }[];
}

const cardsOf = (board: Board) => board.columns.flatMap((column) => column.cards);

/** The cards on the board with a task running on them, by ref, in order. */
export function runningRefs(board: Board): string[] {
  return cardsOf(board)
    .filter((card) => (card.active ?? []).some((task) => task.state === 'running'))
    .map((card) => card.ref)
    .sort();
}

/**
 * Whether the poll says what the board as drawn cannot: a card on it started
 * running, or stopped. A running card the board does not show is not news.
 */
export function needsFullRead(board: Board, activity: BoardActivity): boolean {
  const shown = new Set(cardsOf(board).map((card) => card.ref));
  const now = activity.cards.map((card) => card.ref).filter((ref) => shown.has(ref)).sort();
  return now.join('\n') !== runningRefs(board).join('\n');
}

/** The board with each running card's tasks as the poll said them, and the poll's count. */
export function withActivity(board: Board, activity: BoardActivity): Board {
  const byRef = new Map(activity.cards.map((card) => [card.ref, card.active]));
  return {
    ...board,
    running: activity.running,
    columns: board.columns.map((column) => ({
      ...column,
      cards: column.cards.map((card) => {
        const active = byRef.get(card.ref);
        return active ? { ...card, active } : card;
      }),
    })),
  };
}
