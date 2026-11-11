import type { AttentionItem, BoardCard, BoardColumn } from './api';
import { groupOf, waiting } from './attention-card';
import type { HeldApproval } from './card-status';
import { REFRESH_EVERY_MS } from './live-refresh';
import { money } from './when';

/**
 * The board by state: the cards the board by stage draws, grouped by what a
 * person does about them rather than by where the work is. Worked out here,
 * from the board and Needs you the page already reads; the bridge sends no
 * state, and nothing is stored (ADR 0027).
 */

export type BoardState = 'needs_you' | 'working' | 'waiting' | 'done_today';

/** The four columns, in the order a card is fitted to them. */
export const STATES: readonly { state: BoardState; title: string; empty: string }[] = [
  { state: 'needs_you', title: 'Needs you', empty: 'Nothing waits on you' },
  { state: 'working', title: 'Working', empty: 'Nothing running' },
  { state: 'waiting', title: 'Waiting', empty: 'Nothing waiting' },
  { state: 'done_today', title: 'Done today', empty: 'Nothing shipped today' },
];

export interface StateContext {
  /** Everything waiting on the person, as Needs you has it. */
  attention: readonly AttentionItem[];
  /** Approved plan changes waiting for other work, by card ref (`heldApprovalsOf`). */
  heldApprovals: ReadonlyMap<string, HeldApproval>;
  /** When the page was read; Done today is counted from midnight before it, in the browser's time zone. */
  now: string;
}

/**
 * The refs a Needs-you item can name a card by, of the items that wait on the
 * person about work: the ones the header's badge and the strip count, so the
 * column and the badge cannot disagree. Not a plan change approved and
 * waiting for other work, which has nothing to answer on its face.
 * `Board.waitingOnYou` is not this: it counts open gates, and a merge held for
 * a person, a stalled review and a failed task are not gates.
 */
function namedByNeedsYou(attention: readonly AttentionItem[]): ReadonlySet<string> {
  const named = new Set<string>();
  for (const item of waiting(attention)) {
    if (groupOf(item) !== 'work' || item.kind === 'plan_change_waiting') continue;
    if (item.subject.ref) named.add(item.subject.ref);
    if (item.subject.item) named.add(item.subject.item);
  }
  return named;
}

/** Each name a card goes by in a Needs-you item: its ref, its work item's key, its pull request. */
function namesOf(card: BoardCard): string[] {
  return [card.ref, card.item?.key, card.prNumber ? `${card.repo}#${card.prNumber}` : null].filter((name): name is string => Boolean(name));
}

/** Midnight before `now`, in the browser's time zone. */
function midnightBefore(now: string): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

function stateWith(card: BoardCard, stage: string, named: ReadonlySet<string>, context: StateContext, midnight: number): BoardState | null {
  // A gate open on the card is a question unless it is an approval that only
  // waits for other work to let go of its paths; it also covers a bridge too
  // old to send Needs-you items.
  const gate = card.gateOpen && !(context.heldApprovals.get(card.ref)?.blockedBy.length ?? 0);
  if (gate || namesOf(card).some((name) => named.has(name))) return 'needs_you';
  if ((card.active ?? []).some((task) => task.state === 'running')) return 'working';
  // Queued, paused after an answer, idle, held: each says why on its own line.
  if (stage !== 'done') return 'waiting';
  // The timestamp Done itself sorts and keeps its week by.
  const at = Date.parse(card.shippedAt ?? card.updatedAt);
  // Before today it is left out: By state is about now, and the week is in By stage.
  return Number.isFinite(at) && at >= midnight ? 'done_today' : null;
}

/**
 * The column a card goes in: the first that fits, Needs you, Working, Waiting,
 * Done today. Null for a Done card from before today's midnight. `stage` is
 * the column the board draws it in, which a move still pending has changed.
 */
export function stateOf(card: BoardCard, context: StateContext, stage: string = card.stage): BoardState | null {
  return stateWith(card, stage, namedByNeedsYou(context.attention), context, midnightBefore(context.now));
}

export interface StateColumn {
  state: BoardState;
  title: string;
  empty: string;
  /** Each card with the stage column it is drawn from, which its move list starts from. */
  cards: { card: BoardCard; stage: string }[];
}

/**
 * The four columns from the columns By stage draws: filtered, with moves in
 * flight, and Done cut to its week and newest first. Each card keeps the
 * order it had there, stage by stage.
 */
export function stateColumns(columns: readonly Pick<BoardColumn, 'stage' | 'cards'>[], context: StateContext): StateColumn[] {
  const named = namedByNeedsYou(context.attention);
  const midnight = midnightBefore(context.now);
  const grouped = new Map<BoardState, StateColumn['cards']>(STATES.map((one) => [one.state, []]));
  for (const column of columns) {
    for (const card of column.cards) {
      const state = stateWith(card, column.stage, named, context, midnight);
      if (state) grouped.get(state)!.push({ card, stage: column.stage });
    }
  }
  return STATES.map((one) => ({ ...one, cards: grouped.get(one.state)! }));
}

/**
 * A Working card's spend against the cap one task stops at: "$4.10 of $15".
 * The spend is the card's whole, every task on its work item, as a person
 * asked for, though the cap is one task's. The spend alone where the bridge
 * sends no cap, or none worth saying; nothing where it sends no spend.
 */
export function spendLine(card: Pick<BoardCard, 'costUsd'>, capUsd: number | null | undefined): string | null {
  if (typeof card.costUsd !== 'number' || !Number.isFinite(card.costUsd)) return null;
  const spent = money(card.costUsd);
  if (typeof capUsd !== 'number' || !Number.isFinite(capUsd) || capUsd <= 0) return spent;
  return `${spent} of ${money(capUsd, { whole: Number.isInteger(capUsd) })}`;
}

// ---------------------------------------------------------------- the view

export type ViewName = 'stage' | 'state';

export const VIEW_KEY = 'openadlc.board.view';

/** The two views in words, as Settings → Appearance names them. */
export const VIEW_WORDS: Record<ViewName, string> = { stage: 'By stage', state: 'By state' };

/**
 * What `saveView` announces in the page. The view is chosen in Appearance or
 * with ⌘K, not on the board (ADR 0055), and ⌘K run on the board pushes to the
 * route it is already on: the board does not remount, so a read on mount alone
 * left it drawn as it was.
 */
export const VIEW_EVENT = 'openadlc:board-view';

function viewOf(value: string | null | undefined): ViewName {
  return value === 'state' ? 'state' : 'stage';
}

/**
 * The view this browser chose, or By stage: on a first visit, for a value it
 * does not know, and where storage throws. Storage is reached inside the
 * `try`: in a browser with site data blocked, reading `localStorage` at all
 * throws.
 */
export function storedView(): ViewName {
  try {
    return viewOf(globalThis.localStorage?.getItem(VIEW_KEY));
  } catch {
    return 'stage';
  }
}

/**
 * Remembers the choice in this browser and tells the page. Where storage
 * throws, the page is told all the same, so the board in front of the person
 * still follows for as long as it is open.
 */
export function saveView(view: ViewName): void {
  try {
    globalThis.localStorage?.setItem(VIEW_KEY, view);
  } catch {
    // A private window, or site data blocked.
  }
  try {
    globalThis.dispatchEvent?.(new CustomEvent<ViewName>(VIEW_EVENT, { detail: view }));
  } catch {
    // Somewhere with no events to send: nothing in the page to tell.
  }
}

/**
 * Calls `listener` with the view each time it is chosen: in this page
 * (`saveView`), or in another tab of this browser (its `storage` event).
 * Returns the unsubscribe.
 */
export function onViewChange(listener: (view: ViewName) => void): () => void {
  const target = globalThis as typeof globalThis & Partial<Pick<Window, 'addEventListener' | 'removeEventListener'>>;
  if (typeof target.addEventListener !== 'function' || typeof target.removeEventListener !== 'function') return () => {};
  const onView = (event: Event) => listener(viewOf((event as CustomEvent<unknown>).detail as string | undefined));
  const onStorage = (event: StorageEvent) => {
    if (event.key === VIEW_KEY) listener(viewOf(event.newValue));
  };
  target.addEventListener(VIEW_EVENT, onView);
  target.addEventListener('storage', onStorage);
  return () => {
    target.removeEventListener!(VIEW_EVENT, onView);
    target.removeEventListener!('storage', onStorage);
  };
}

// ---------------------------------------------------------------- the Live dot

/**
 * When the dot turns stale: one refresh missed, and five seconds for the read
 * itself, or it would go stale for a moment before every refresh landed.
 */
export const STALE_AFTER_MS = REFRESH_EVERY_MS + 5_000;

/** "Live · 4s ago", "Live · 2 min ago"; "Not updated · 1 min ago" once a refresh is missed. */
export function liveLine(updatedAt: number, nowMs: number): { text: string; stale: boolean } {
  const elapsed = Math.max(0, nowMs - updatedAt);
  const seconds = Math.floor(elapsed / 1000);
  const minutes = Math.floor(seconds / 60);
  const age = seconds < 60 ? `${seconds}s ago` : minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`;
  const stale = elapsed > STALE_AFTER_MS;
  return { text: `${stale ? 'Not updated' : 'Live'} · ${age}`, stale };
}
