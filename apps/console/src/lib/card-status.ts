import type { BoardCard, BoardColumn, CardTask, MergeLineEntry } from './api';
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

export interface CardStatus {
  text: string;
  tone: StatusTone;
  /** A tick for a card that shipped; a dot for one being worked. */
  mark: 'dot' | 'check' | null;
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
}

const WORKING: Record<string, string> = {
  intake: 'Shaping the issue',
  request: 'Reading the request',
  spec: 'Writing the design',
  implement: 'Writing the change',
  patch: 'Fixing what the reviewers found',
  deploy: 'Deploying',
  qa: 'Checking it on testing',
};

function withTime(text: string, since: string | null, now: string): string {
  const took = duration(since, now);
  return took ? `${text} · ${took}` : text;
}

/** The newest running task, or failing that the newest of any that is going. */
function leading(active: readonly CardTask[]): CardTask | undefined {
  return active.find((task) => task.state === 'running') ?? active[0];
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
  const request = card.request ? requestStatus(card, context.pausedRepos) : null;
  if (request) return request;

  if (card.stalledAfterRounds) {
    return { text: `Stopped after ${card.stalledAfterRounds} rounds · needs you`, tone: 'alarm', mark: 'dot' };
  }

  if (card.gateOpen) {
    return { text: 'Waiting for your answer', tone: 'attention', mark: 'dot' };
  }

  // A reviewer's review failed and nothing has run it again: nothing is
  // waiting for the reviewers, the person is — whatever another reviewer is doing.
  if (card.reviewFailed && card.stage === 'review') {
    return { text: 'Review failed · needs you', tone: 'alarm', mark: 'dot' };
  }

  const task = leading(active);
  if (task?.state === 'running') {
    if (task.kind === 'review') {
      const reviewing = active.filter((one) => one.kind === 'review' && one.state === 'running').length;
      const who = reviewing > 1 ? `${reviewing} reviewers reviewing` : 'Reviewing';
      return { text: card.reviewRound ? `${who} · round ${card.reviewRound}` : who, tone: 'signal', mark: 'dot' };
    }
    return { text: withTime(WORKING[task.kind] ?? 'Working', task.startedAt, context.now), tone: 'signal', mark: 'dot' };
  }
  if (task?.state === 'queued') return { text: 'About to start', tone: 'muted', mark: null };
  if (task?.state === 'paused') return { text: 'Paused', tone: 'muted', mark: null };

  if (card.last?.state === 'failed' && card.stage !== 'done') {
    return { text: 'Could not finish · needs you', tone: 'alarm', mark: 'dot' };
  }

  switch (card.stage) {
    case 'done': {
      const when = ago(card.shippedAt ?? card.updatedAt, context.now);
      return { text: when ? `Shipped ${when}` : 'Shipped', tone: 'muted', mark: 'check' };
    }
    case 'merged':
      return card.labels.includes('deployed:testing')
        ? { text: 'Live on testing · waiting for production', tone: 'muted', mark: null }
        : { text: 'Merged · waiting to deploy', tone: 'muted', mark: null };
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
 * (`fleetadlc:paused`), one for a person (`do:human`) or one it ignores, and
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
    !card.labels.includes('fleetadlc:paused') &&
    !card.labels.includes('do:human') &&
    !card.labels.some((label) => label === 'fleetadlc:ignore' || label === 'fleet:ignore')
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
