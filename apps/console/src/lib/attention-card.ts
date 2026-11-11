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
  // A held Human-review approval draws Approve, Reject and Discuss from its
  // decision, each with what it does next; the face keeps only the way to
  // GitHub beside them.
  if (item.decision) return item.actions.filter((action) => !isDecisionAction(action)).slice(0, 1);
  // A held merge draws Merge, Leave it and Discuss from its decision; the face
  // keeps only the way to GitHub, after them.
  if (item.heldMerge) return item.actions.filter((action) => !isHeldDecisionAction(action)).slice(0, 1);
  // A choice between three, none of them the obvious one: all on the card.
  if (item.kind === 'unowned_issues') return item.actions;
  // Release it, or stop holding promotes for a person at all: both on the
  // card. Keep holding and Discuss are the decision's, each with what it does next.
  if (item.kind === 'promote_held') return item.actions.filter((action) => !isHeldDecisionAction(action));
  // Drop the dependency, or reopen what it waits on: either settles it.
  if (item.kind === 'dependency_abandoned') return item.actions;
  // Approved already, and waiting: what it waits on, and nothing that answers
  // it. A card that still offered the choices was approved three times.
  if (item.kind === 'plan_change_waiting') return item.actions.filter((action) => action.kind !== 'answer_gate').slice(0, 1);
  // A signing key OpenADLC did not register: revoke it, or say it is used
  // elsewhere — both on the card for the first key; more keys and the undos
  // are in the sheet.
  const revoke = item.actions.find((action) => action.kind === 'signing_key_revoke');
  const dismissKey = item.actions.find((action) => action.kind === 'signing_key_dismiss');
  if (revoke || dismissKey) return [revoke, dismissKey].filter((action): action is AttentionAction => Boolean(action));
  const dismiss = item.actions.find((action) => action.kind === 'acknowledge' || action.kind === 'dismiss_notice');
  const incident = item.actions.find((action) => action.kind === 'incident');
  const question = item.kind === 'question' && (item.question?.options.length ?? 0) > 0;
  // A plan change's other ways to settle it sit beside Approve and Refuse:
  // approving the rest of the work's requests, or asking the designer.
  const settle = question ? item.actions.filter((action) => action.kind === 'approve_all' || action.kind === 'ask_designer') : [];
  const first = question ? null : (item.actions.find((action) => action !== dismiss && action !== incident) ?? null);
  return [...settle, dismiss, first, incident].filter((action): action is AttentionAction => Boolean(action));
}

/**
 * Whether a card has more than its face shows, and so a Show more: a detail
 * longer than two lines, the raw reason, members of a folded cause, a
 * question's other choices, a held approval's reviews in full, or any button
 * besides the first.
 */
export function hasMore(item: AttentionItem): boolean {
  if ((item.members?.length ?? 0) > 1) return true;
  if (item.incident) return true;
  if (item.raw) return true;
  // A question's context is shown cut short on the card, and whole in the sheet.
  if (item.context) return true;
  // A held approval's reviews are cut to three lines on the card, and whole
  // only in the sheet: without this a short one had no way to read them.
  if (item.decision?.reviews?.some((review) => review.summary)) return true;
  const detail = plainDetail(item.detail);
  if (detail.length > DETAIL_ON_CARD || /\n\s*\n/.test(item.detail.trim())) return true;
  if (item.kind === 'question') {
    const choices = item.question?.options.length ?? 0;
    if (choices > CHOICES_ON_CARD) return true;
    // Beside the choices only "Something else…" is on the card.
    return item.actions.some((action) => action.kind !== 'answer');
  }
  return item.actions.filter((action) => !isDecisionAction(action) && !isHeldDecisionAction(action)).length > faceActions(item).length;
}

// ---------------------------------------------------------------- a held Human-review approval

/** A held Human-review approval's own buttons, which its decision draws, never `ActionButton`. */
export function isDecisionAction(action: AttentionAction): action is Extract<AttentionAction, { kind: 'human_review_approve' | 'human_review_reject' | 'human_review_discuss' }> {
  return action.kind === 'human_review_approve' || action.kind === 'human_review_reject' || action.kind === 'human_review_discuss';
}

export type DecisionButton = 'approve' | 'reject' | 'discuss';

/**
 * The buttons a viewer gets on a held Human-review approval, in the bridge's
 * order: all three for the person it waits on, as the bridge says from their
 * linked account (`decision.yours`), and Discuss alone for anyone else. The
 * bridge refuses Approve and Reject from anyone else too; this only keeps a
 * button off a card it would refuse.
 */
export function decisionButtons(item: Pick<AttentionItem, 'decision' | 'actions'>): DecisionButton[] {
  if (!item.decision) return [];
  const offered = item.actions.filter(isDecisionAction).map((action): DecisionButton => (action.kind === 'human_review_approve' ? 'approve' : action.kind === 'human_review_reject' ? 'reject' : 'discuss'));
  return item.decision.yours === true ? offered : offered.filter((button) => button === 'discuss');
}

// ---------------------------------------------------------------- a held merge and a held promote

/** The buttons a held merge's or a held promote's panel draws itself, never `ActionButton`. */
export function isHeldDecisionAction(
  action: AttentionAction,
): action is Extract<AttentionAction, { kind: 'held_merge_merge' | 'held_merge_leave' | 'held_merge_discuss' | 'promote_keep_holding' | 'promote_discuss' }> {
  return (
    action.kind === 'held_merge_merge' ||
    action.kind === 'held_merge_leave' ||
    action.kind === 'held_merge_discuss' ||
    action.kind === 'promote_keep_holding' ||
    action.kind === 'promote_discuss'
  );
}

export type HeldMergeButton = 'merge' | 'leave' | 'discuss';

/**
 * The buttons a viewer gets on a held merge, in the bridge's order: Merge only
 * when the bridge offers it on this hold and says the viewer may press it
 * (`heldMerge.yours`), Leave it and Discuss for anyone it is shown to. The
 * bridge refuses a Merge it would not offer, from anyone; this only keeps a
 * button off a card it would refuse.
 */
export function heldMergeButtons(item: Pick<AttentionItem, 'heldMerge' | 'actions'>): HeldMergeButton[] {
  const held = item.heldMerge;
  if (!held) return [];
  const mayMerge = held.merge.merge && held.yours === true;
  return item.actions.flatMap((action): HeldMergeButton[] => {
    if (action.kind === 'held_merge_merge') return mayMerge ? ['merge'] : [];
    if (action.kind === 'held_merge_leave') return ['leave'];
    if (action.kind === 'held_merge_discuss') return ['discuss'];
    return [];
  });
}

/** Why the viewer has no Merge on a held merge, or null when they have one. */
export function noMergeReason(held: NonNullable<AttentionItem['heldMerge']>): string | null {
  if (!held.merge.merge) return held.merge.why;
  if (held.yours !== true) return held.whyNot ?? 'OpenADLC did not say whether you can merge it; reload in a moment.';
  return null;
}

/** Whether a Reject can be sent: its reason is the builder's finding, and never empty. */
export function rejectReady(reason: string): boolean {
  return reason.trim().length > 0;
}

/** How a crew review on a held approval's card is named: its seat, else its account. */
export function reviewerName(review: { login: string; seat: string | null }): string {
  return review.seat ?? `@${review.login}`;
}

/** A review's verdict in words. */
export function reviewVerdict(state: string): string {
  if (state === 'approved') return 'approved';
  if (state === 'changes_requested') return 'asked for changes';
  if (state === 'dismissed') return 'was dismissed';
  return 'commented';
}

/** The cards waiting behind an item, as its card names them: `#207` in the item's own repository, `web#12` in another. */
export interface Unblocked {
  /** "4 items wait on this". */
  lead: string;
  items: { ref: string; label: string; title: string }[];
}

/**
 * What doing an item lets go on (`unblocks`, the cards whose wait the bridge
 * followed to it), or null when nothing waits behind it. On 2026-10-30 four
 * cards waited on one approval, and its card said nothing of them.
 */
export function unblockedOf(item: Pick<AttentionItem, 'unblocks' | 'subject'>): Unblocked | null {
  const behind = item.unblocks?.items ?? [];
  if (behind.length === 0) return null;
  const count = item.unblocks?.count ?? behind.length;
  return {
    lead: count === 1 ? '1 item waits on this' : `${count} items wait on this`,
    items: behind.map((one) => ({ ref: one.ref, label: one.repo === item.subject.repo ? `#${one.number}` : `${one.repo}#${one.number}`, title: one.title })),
  };
}

/** "4 items wait on this: #207, #217, #216, #214.", or null when none does. */
export function unblocksLine(item: Pick<AttentionItem, 'unblocks' | 'subject'>): string | null {
  const unblocked = unblockedOf(item);
  return unblocked ? `${unblocked.lead}: ${unblocked.items.map((one) => one.label).join(', ')}.` : null;
}

// ---------------------------------------------------------------- work and system

/**
 * Whom an item is for, in the line under its headline (ADR 0035): its role,
 * the approvers, the admins, or you; or everyone, with why, when it came to
 * nobody. Null on a local install, where everything is the one person's.
 */
export function audienceLine(item: Pick<AttentionItem, 'audience'>): string | null {
  const audience = item.audience;
  if (!audience) return null;
  switch (audience.for) {
    case 'everyone':
      return audience.why ? `For everyone: ${audience.why}` : null;
    case 'person':
      return 'For you';
    case 'approvers':
      return 'For approvers';
    case 'admins':
      return 'For admins';
    case 'role':
      return `For ${audience.name}`;
  }
}

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
  // A notice: nothing waits on a person, and a week of them was counted as work.
  design_memory_superseded: 'system',
  dependency_abandoned: 'work',
  resume_waiting: 'work',
  plan_change_waiting: 'work',
  // Nothing about the work is wrong: what starts it did not come round.
  work_stuck: 'system',
  stack_held: 'work',
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
