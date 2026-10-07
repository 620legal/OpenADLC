import { FORMATTED_LIMIT } from '@/components/markdown';
import type { AttentionAction, AttentionItem } from './api';
import { withoutComments } from './comments';

/**
 * What a Needs-you card shows on its face, and what waits in its sheet.
 *
 * A card used to carry everything: the whole markdown detail, the raw reason,
 * every member of a folded cause with its own buttons. Seven bots that could
 * not sign in were a card dozens of rows tall, and it pushed the board out of
 * sight. A card now shows its headline, two lines of what happened and the
 * one thing to press. The rest is a Show more away, in a sheet beside it.
 */

/** How many of a question's choices answer it from the card; the rest are in the sheet. */
export const CHOICES_ON_CARD = 3;

/** Past this many characters, two lines of detail on the narrowest card are not all of it. */
const DETAIL_ON_CARD = 140;

/**
 * The detail as the card's two lines say it: markdown taken out, so a clamp
 * cuts a sentence rather than a list or a code block. Only as much as the
 * Markdown component formats is read: the card shows two lines of it, and
 * eighty thousand characters of `[` and line breaks took seconds to read.
 */
export function plainDetail(detail: string): string {
  return withoutComments(detail.slice(0, FORMATTED_LIMIT))
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\[\]\n]+)\]\([^)\s]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_match, a: string | undefined, b: string | undefined) => a ?? b ?? '')
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)]|#{1,6})\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The buttons a card offers on its face: Dismiss when it has one ("This was
 * me" on an unsigned post), since a notice with nothing to fix is dismissed
 * from where it is read; its first other action, which the bridge orders as
 * the one to do; and What to do for an incident, which opens its steps. A
 * question's first is its choices, so it has none of its own; "Something
 * else…" goes with the choices.
 */
export function faceActions(item: AttentionItem): AttentionAction[] {
  // A choice between three, none of them the obvious one: all on the card.
  if (item.kind === 'unowned_issues') return item.actions;
  // Release it, or stop holding promotes for a person at all: both on the card.
  if (item.kind === 'promote_held') return item.actions;
  const dismiss = item.actions.find((action) => action.kind === 'acknowledge');
  const incident = item.actions.find((action) => action.kind === 'incident');
  const question = item.kind === 'question' && (item.question?.options.length ?? 0) > 0;
  const first = question ? null : (item.actions.find((action) => action !== dismiss && action !== incident) ?? null);
  return [dismiss, first, incident].filter((action): action is AttentionAction => Boolean(action));
}

/**
 * Whether a card has more than its face shows, and so a Show more: a detail
 * longer than two lines, the raw reason, members of a folded cause, a
 * question's other choices, or any button besides the first.
 */
export function hasMore(item: AttentionItem): boolean {
  if ((item.members?.length ?? 0) > 1) return true;
  if (item.incident) return true;
  if (item.raw) return true;
  // A question's context is shown cut short on the card, and whole in the sheet.
  if (item.context) return true;
  const detail = plainDetail(item.detail);
  if (detail.length > DETAIL_ON_CARD || /\n\s*\n/.test(item.detail.trim())) return true;
  if (item.kind === 'question') {
    const choices = item.question?.options.length ?? 0;
    if (choices > CHOICES_ON_CARD) return true;
    // Beside the choices only "Something else…" is on the card.
    return item.actions.some((action) => action.kind !== 'answer');
  }
  return item.actions.length > faceActions(item).length;
}

// ---------------------------------------------------------------- work and system

/** Whose an item is: the bridge says (`group`); an older bridge's is read from its kind. */
export type AttentionGroup = 'work' | 'system';

/** Every kind, classified, as the bridge's `groupOf` has it: a new kind does not compile until it is given a group. */
const GROUP: Record<AttentionItem['kind'], AttentionGroup> = {
  question: 'work',
  // An older bridge's; the bridge sends none now.
  approval: 'work',
  review_stalled: 'work',
  send_back_held: 'work',
  task_failed: 'work',
  triage_failed: 'work',
  check_failed: 'system',
  check_fixed: 'system',
  engine_update_failed: 'system',
  merge_waiting: 'work',
  unowned_issues: 'work',
  promote_held: 'work',
  design_memory_superseded: 'work',
};

export function groupOf(item: Pick<AttentionItem, 'kind' | 'group'>): AttentionGroup {
  return item.group ?? GROUP[item.kind] ?? 'work';
}

const ALARMING = new Set<AttentionItem['kind']>(['review_stalled', 'task_failed', 'triage_failed', 'engine_update_failed']);

/** Red for what stops work; a check that only costs something is amber, like a question. */
export function alarming(item: Pick<AttentionItem, 'kind' | 'severity'>): boolean {
  if (item.kind === 'check_failed') return item.severity !== 'warning';
  return ALARMING.has(item.kind);
}

/** What waits on a person: a notice that something was fixed does not. */
export function waiting<T extends Pick<AttentionItem, 'kind'>>(items: readonly T[]): T[] {
  return items.filter((item) => item.kind !== 'check_fixed');
}

/** How many wait in each group, for the page's tabs and the header's badge. */
export function groupCounts(items: readonly AttentionItem[]): Record<AttentionGroup, number> {
  const counts = { work: 0, system: 0 };
  for (const item of waiting(items)) counts[groupOf(item)] += 1;
  return counts;
}

/** How many the board's strip shows; the rest are on `/needs-you`. */
export const STRIP_LIMIT = 3;

/**
 * The few the board shows: what stops work before what only asks, then work
 * before system, and the newest first after that. Work before system at the
 * same urgency, however old, is deliberate: a question a bot is
 * waiting on comes before a newer amber check.
 */
export function stripItems(items: readonly AttentionItem[], limit = STRIP_LIMIT): AttentionItem[] {
  return [...waiting(items)]
    .sort(
      (a, b) =>
        Number(alarming(b)) - Number(alarming(a)) ||
        Number(groupOf(a) === 'system') - Number(groupOf(b) === 'system') ||
        Date.parse(b.since) - Date.parse(a.since),
    )
    .slice(0, limit);
}
