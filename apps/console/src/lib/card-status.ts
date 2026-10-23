import type { AttentionItem, BoardCard, BoardColumn, CardTask, MergeLineEntry } from './api';
import { ago, duration, ordinal } from './when';

/**
 * What a card says about itself, in a line a person reads without knowing how
 * OpenADLC works: "Writing the change · 12 min", "Reviewing · round 2", "Waiting
 * for your answer", "Stopped after 3 rounds · needs you".
 *
 * The line is made from live state — the tasks on the card, the question open
 * on it, where its pull request is in the line to merge — and never from a
 * setting. What needs the person comes first, then what is happening, then
 * why nothing is.
 */

export type StatusTone = 'signal' | 'attention' | 'alarm' | 'muted';

/**
 * A card in Done because its issue was closed without merging: the bridge's
 * `openadlc:abandoned`. Done takes it out of the columns work is in; nothing
 * of it shipped, so it has no tick and is not counted with what did.
 */
export function abandoned(card: Pick<BoardCard, 'stage' | 'labels'>): boolean {
  return card.stage === 'done' && card.labels.includes('openadlc:abandoned');
}

export interface CardStatus {
  text: string;
  tone: StatusTone;
  /** A tick for a card that shipped; a dot for one being worked. */
  mark: 'dot' | 'check' | null;
  /**
   * A task is running on the card now: its dot pulses, and reads as
   * "working". Only then — a card waiting on a person, in the queue or in the
   * line to merge keeps a still dot, so the board moves only where work does.
   */
  live?: boolean;
  /** Where the line goes, when it names something that can be opened: the issue a request became. */
  href?: string;
}

/**
 * What a request's card says, by where the request is; null from an
 * older bridge, which said none. A request for a repository a person paused
 * waits in the queue, and one intake filed into a paused repository is an
 * issue nothing leases until it is resumed: the card says which.
 */
export function requestStatus(card: BoardCard, pausedRepos: readonly string[] = []): CardStatus | null {
  const paused = Boolean(card.repo) && pausedRepos.includes(card.repo);
  switch (card.requestState) {
    case 'queued':
      if (paused) return { text: `Queued · waits until ${card.repo} is resumed`, tone: 'muted', mark: null };
      return { text: card.queuePosition ? `Queued (#${card.queuePosition})` : 'Queued', tone: 'muted', mark: null };
    case 'working':
      return { text: 'Intake working', tone: 'signal', mark: 'dot' };
    case 'waiting':
      return { text: 'Waiting for you', tone: 'attention', mark: 'dot' };
    case 'filed':
      return {
        text: `${card.issueNumber ? `Filed #${card.issueNumber}` : 'Filed'}${paused ? ` · waits until ${card.repo} is resumed` : ''}`,
        tone: 'muted',
        mark: 'check',
        ...(card.url ? { href: card.url } : {}),
      };
    default:
      return null;
  }
}

export interface CardContext {
  now: string;
  /** A bot's name as a person reads it: its handle, or its role before it connects. */
  said: (bot: string) => string;
  /** A bot's role in words, `builder` or `lead reviewer`, which a running card's line starts with; empty for one the crew does not know. */
  role?: (bot: string) => string;
  /** The line to merge, for a card whose pull request is in it. */
  mergeLine?: readonly MergeLineEntry[];
  /** The repositories a person paused on their own, by name. */
  pausedRepos?: readonly string[];
  /**
   * For a Build card nothing is working on: whether it is the one the builder
   * takes next, and who that builder is and whether it is busy.
   */
  queue?: { next: boolean; builder: string | null; builderBusy: boolean };
  /**
   * False when the bridge runs no dispatcher, so nothing leases a ready card
   * however long it waits. Absent is read as dispatching.
   */
  dispatching?: boolean;
  /** A plan change approved on the card that waits for other work to let go of its paths, as Needs you has it (`heldApprovalsOf`). */
  heldApproval?: HeldApproval | null;
}

export interface HeldApproval {
  /** The issues holding its paths. */
  blockedBy: readonly number[];
  paths: readonly string[];
}

/** `#11`, `#11 and #15`, `#11, #15 and #20`. */
function numbersInWords(numbers: readonly number[]): string {
  const said = numbers.map((number) => `#${number}`);
  return said.length > 1 ? `${said.slice(0, -1).join(', ')} and ${said[said.length - 1]}` : (said[0] ?? '');
}

/**
 * Each card's approved plan change that waits for other work, by the card's
 * ref, from what Needs you says of it: the card and Needs you then say the
 * same. A card with a question of its own open is left out, since that one
 * is waiting for the person's answer.
 */
export function heldApprovalsOf(attention: readonly AttentionItem[]): ReadonlyMap<string, HeldApproval> {
  const refsOf = (item: AttentionItem): string[] => [...new Set([item.subject.ref, item.subject.item].filter((ref): ref is string => Boolean(ref)))];
  const asking = new Set(attention.filter((item) => item.kind === 'question').flatMap(refsOf));
  const held = new Map<string, HeldApproval>();
  for (const item of attention) {
    if (item.kind !== 'plan_change_waiting' || !item.heldApproval || item.heldApproval.blockedBy.length === 0) continue;
    for (const ref of refsOf(item)) {
      if (asking.has(ref)) continue;
      const was = held.get(ref);
      held.set(ref, {
        blockedBy: [...new Set([...(was?.blockedBy ?? []), ...item.heldApproval.blockedBy])].sort((a, b) => a - b),
        paths: [...new Set([...(was?.paths ?? []), ...item.heldApproval.paths])],
      });
    }
  }
  return held;
}

/** What a running task is doing, by its kind, for one that has not said a step yet. */
const WORKING: Record<string, string> = {
  intake: 'shaping the issue',
  request: 'reading the request',
  spec: 'writing the design',
  implement: 'writing the change',
  patch: 'fixing what the reviewers found',
  review: 'reviewing',
  deploy: 'deploying',
  qa: 'checking it on testing',
};

/**
 * Since when a task has been running: from its last resume, as the bridge
 * says it, or its start from an older bridge. Counted from the start, a task
 * answered a day after it asked read "1 day" the moment it went on.
 */
function runningSince(task: CardTask): string | null {
  return task.since !== undefined ? task.since : task.startedAt;
}

/** The newest running task, or failing that the newest of any that is going. */
function leading(active: readonly CardTask[]): CardTask | undefined {
  return active.find((task) => task.state === 'running') ?? active[0];
}

/**
 * A running card's line: who, doing what, and for how long — "Builder ·
 * running tests · 12 min", "Lead reviewer · reading the diff · round 2 ·
 * 6 min". It used to be the kind of work and the time alone, so it read the
 * same for twelve minutes whatever the builder was doing, or not doing.
 */
function runningLine(card: BoardCard, task: CardTask, active: readonly CardTask[], context: CardContext): CardStatus {
  const round = task.kind === 'review' && card.reviewRound ? `round ${card.reviewRound}` : null;
  const reviews = active.filter((one) => one.kind === 'review' && one.state === 'running');
  let parts: (string | null)[];
  if (task.kind === 'review' && reviews.length > 1) {
    // Each reviewer's step is in the item view; the card says how many are at it, since the first began.
    const first = reviews.map(runningSince).filter((at): at is string => Boolean(at)).sort()[0] ?? null;
    parts = [`${reviews.length} reviewers reviewing`, round, duration(first, context.now)];
  } else {
    // The role starts the sentence; a handle, for a bot the crew does not know, is left as it is written.
    const role = context.role?.(task.bot);
    const who = role ? `${role.charAt(0).toUpperCase()}${role.slice(1)}` : task.bot;
    parts = [who, task.activity || WORKING[task.kind] || 'working', round, duration(runningSince(task), context.now)];
  }
  return { text: parts.filter(Boolean).join(' · '), tone: 'signal', mark: 'dot', live: true };
}

function inLine(card: BoardCard, mergeLine: readonly MergeLineEntry[] | undefined): CardStatus | null {
  if (!card.prNumber || !mergeLine) return null;
  const ref = `${card.repo}#${card.prNumber}`;
  const line = mergeLine.filter((entry) => entry.repo === card.repo);
  const index = line.findIndex((entry) => entry.ref === ref);
  const entry = line[index];
  if (!entry) return null;
  // Green at the front, and only a person can land it: "Merging" said it was
  // happening, and it sat there with nobody told. Needs you has it too.
  if (entry.heldFor) return { text: 'Approved · waiting for you to merge it', tone: 'attention', mark: 'dot' };
  switch (entry.state) {
    case 'merging':
      return { text: 'Merging', tone: 'signal', mark: 'dot' };
    case 'updating':
      return { text: 'Catching up with main before it merges', tone: 'signal', mark: 'dot' };
    case 'testing':
      return { text: 'Checks running before it merges', tone: 'signal', mark: 'dot' };
    default:
      return { text: index === 0 ? 'Approved · next to merge' : `Approved · ${ordinal(index + 1)} in line to merge`, tone: 'muted', mark: null };
  }
}

export function cardStatus(card: BoardCard, context: CardContext): CardStatus {
  const active = card.active ?? [];
  // A request intake is on says what its triage is doing, as any card does;
  // "Intake working" is for a bridge that sends no tasks with it.
  const byTasks = card.requestState === 'working' && active.length > 0;
  const request = card.request && !byTasks ? requestStatus(card, context.pausedRepos) : null;
  if (request) return request;

  if (card.stalledAfterRounds) {
    return { text: `Stopped after ${card.stalledAfterRounds} rounds · needs you`, tone: 'alarm', mark: 'dot' };
  }

  if (card.gateOpen) {
    // A plan change approved while other work holds its paths keeps its
    // question open, though nobody is asked anything: it goes on by itself.
    // The card said "Waiting for your answer" while Needs you said the
    // builder waited for #44 to let go of the approved path.
    const held = context.heldApproval;
    if (held && held.blockedBy.length > 0) {
      return {
        text: `Approved · waits for ${numbersInWords(held.blockedBy)} to let go of the ${held.paths.length === 1 ? 'path' : 'paths'}`,
        tone: 'muted',
        mark: null,
      };
    }
    return { text: 'Waiting for your answer', tone: 'attention', mark: 'dot' };
  }

  // A reviewer's review failed and nothing has run it again: nothing is
  // waiting for the reviewers, the person is — whatever another reviewer is doing.
  if (card.reviewFailed && card.stage === 'review') {
    return { text: 'Review failed · needs you', tone: 'alarm', mark: 'dot' };
  }

  const task = leading(active);
  if (task?.state === 'running') return runningLine(card, task, active, context);
  if (task?.state === 'queued') return { text: 'Queued', tone: 'muted', mark: null };
  // Paused with no question open: answered, and not started again yet.
  if (task?.state === 'paused') return { text: 'Paused', tone: 'muted', mark: null };

  if (card.last?.state === 'failed' && card.stage !== 'done') {
    return { text: 'Could not finish · needs you', tone: 'alarm', mark: 'dot' };
  }

  switch (card.stage) {
    case 'done': {
      const when = ago(card.shippedAt ?? card.updatedAt, context.now);
      if (abandoned(card)) return { text: when ? `Abandoned ${when}` : 'Abandoned', tone: 'muted', mark: null };
      return { text: when ? `Shipped ${when}` : 'Shipped', tone: 'muted', mark: 'check' };
    }
    case 'merged':
      if (card.labels.includes('deployed:testing')) return { text: 'Live on testing · waiting for production', tone: 'muted', mark: null };
      // No pull request recorded, so no deploy will ever carry it: "waiting
      // to deploy" sat on such a card for good, with nobody told.
      if (card.noMerge) return { text: 'No merge to deploy · move it to Done by hand', tone: 'attention', mark: 'dot' };
      return { text: 'Merged · waiting to deploy', tone: 'muted', mark: null };
    case 'review':
      return inLine(card, context.mergeLine) ?? { text: 'Waiting for the reviewers', tone: 'muted', mark: null };
    case 'build': {
      if (card.labels.includes('blocked')) {
        const on = (card.waitingOn ?? []).map((number) => `#${number}`);
        const which = on.length > 1 ? `${on.slice(0, -1).join(', ')} and ${on[on.length - 1]}` : on[0];
        return { text: which ? `Waiting on ${which}` : 'Blocked by another issue', tone: 'muted', mark: null };
      }
      if (card.labels.includes('needs-triage')) return { text: 'Waiting for triage', tone: 'muted', mark: null };
      if (!card.labels.includes('start:now')) return { text: 'Not ready to build yet', tone: 'muted', mark: null };
      // Ready, and held: nothing is leased in a paused repository.
      if (context.pausedRepos?.includes(card.repo)) return { text: `Waiting until ${card.repo} is resumed`, tone: 'muted', mark: null };
      // Not its turn, nor next: nothing is leasing at all, which "Next up"
      // said for a day on a bridge started without the dispatcher.
      if (context.dispatching === false) return { text: 'Waiting: the dispatcher isn’t running', tone: 'attention', mark: null };
      const queue = context.queue;
      if (queue?.next) {
        return queue.builder && queue.builderBusy
          ? { text: `Next up, when ${context.said(queue.builder)} is free`, tone: 'muted', mark: null }
          : { text: 'Next up', tone: 'muted', mark: null };
      }
      return { text: 'Waiting its turn', tone: 'muted', mark: null };
    }
    case 'spec':
      return { text: 'Waiting for a design pass', tone: 'muted', mark: null };
    default:
      return { text: 'Waiting for intake', tone: 'muted', mark: null };
  }
}

/**
 * Whether a Build card is one the builder could take: labelled to start, and
 * nothing holding it. The dispatcher never leases one a person holds
 * (`openadlc:paused`), one for a person (`do:human`) or one it ignores, and
 * "Next up" sat on a held card while the one it would lease said "Waiting
 * its turn".
 */
export function routable(card: BoardCard): boolean {
  return (
    card.labels.includes('start:now') &&
    !card.labels.includes('blocked') &&
    !card.labels.includes('needs-human') &&
    !card.labels.includes('needs-triage') &&
    !card.held &&
    !card.labels.includes('openadlc:paused') &&
    !card.labels.includes('do:human') &&
    !card.labels.some((label) => label === 'openadlc:ignore' || label === 'fleet:ignore')
  );
}

/**
 * The Build card the builder takes next in each repository: the first
 * routable one nothing is on, in the column's own order — which is the
 * dispatcher's order, priority then age. By repository, because each has its
 * own queue: the board of every repository showed one "Next up" among them all.
 */
export function nextUp(column: Pick<BoardColumn, 'stage' | 'cards'>): ReadonlyMap<string, string> {
  const next = new Map<string, string>();
  if (column.stage !== 'build') return next;
  for (const card of column.cards) {
    if (next.has(card.repo)) continue;
    if ((card.active ?? []).length === 0 && !card.gateOpen && routable(card)) next.set(card.repo, card.ref);
  }
  return next;
}

/**
 * "$0.84 so far" while a bot is spending on it, "$1.74" once none is — a card
 * waiting on the person is not running up a bill; nothing when nothing was spent.
 */
export function cardCost(card: BoardCard, format: (usd: number) => string): string | null {
  if (!card.costUsd || card.costUsd <= 0) return null;
  const spending = (card.active ?? []).some((task) => task.state === 'running' || task.state === 'queued');
  return spending && card.stage !== 'done' ? `${format(card.costUsd)} so far` : format(card.costUsd);
}

/**
 * The bot a card opens: whoever is on it now, else whoever last was. Null for a
 * card no bot has touched, which opens on GitHub instead.
 */
export function cardBot(card: BoardCard): string | null {
  return leading(card.active ?? [])?.bot ?? card.last?.bot ?? null;
}
