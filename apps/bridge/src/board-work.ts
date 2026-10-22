import { listEventsOfType, stageMoves, tasks as taskStore } from '@openadlc/db';
import type { Gate } from '@openadlc/shared';
import {
  asCardTask,
  cardWork,
  isActive,
  REVIEW_STALLED,
  stageOfTask,
  standingStalls,
  subjectsOf,
  type CardTask,
  type CardWork,
  type IssueFacts,
  type TaskFacts,
} from './work.js';
import { stillTried } from './request-queue.js';

/**
 * What the board needs beyond the issues: for each card, what it has cost and
 * who is on it now; for each bot, whether it is working or waiting on a person.
 *
 * The card used to know only that some task was open on it and whether a gate
 * was, so it could say "a question is waiting on you" and nothing else — not
 * that the builder had been writing for twelve minutes, that the review was in
 * its second round, or that the loop had given up.
 */

/** How far back a stopped review loop is looked for. Older than this, the card has moved or been left. */
const STALL_WINDOW_DAYS = 30;

export interface CardExtras extends CardWork {
  /** A question open on its work; set for a pull request's, the store says an issue's (`boardCards`). */
  gateOpen?: boolean;
  /** Every bot on the card now, on the issue or its pull request. */
  assignees: string[];
  /** How many times its work was sent back to an earlier stage; the card says "sent back ×N". */
  sentBack: number;
}

/**
 * A console request intake is still working on, as a card in Intake.
 *
 * The column counted issues labelled `adlc:intake`, and a request is not an
 * issue until intake files it — straight into Build, usually. So while intake
 * asked its questions and wrote the issue, the column said "Nothing waiting for
 * intake", and the only sign of the work was a dot on the intake bot's face.
 */
export interface RequestCard {
  /** The repository named for it, or empty when nobody has named one yet. */
  repo: string;
  /** `request:<id8>`, the subject its triage runs on. */
  ref: string;
  title: string;
  stage: 'intake';
  assignees: string[];
  gateOpen: boolean;
  /** The issue it became, once filed; nothing before. */
  url: string | null;
  labels: string[];
  updatedAt: string;
  /** Not an issue yet: no number, and nothing to move. */
  request: true;
  /**
   * Where it is: waiting its turn for intake, intake working on it,
   * waiting on a person's answer, or filed as an issue.
   */
  requestState: RequestCardState;
  /** Its place in line while `queued`, 1 being next. */
  queuePosition: number | null;
  /** The issue it became, once `filed`. */
  issueNumber: number | null;
  costUsd: number;
  active: CardTask[];
  last: CardTask | null;
}

export type RequestCardState = 'queued' | 'working' | 'waiting' | 'filed';

/**
 * How long a filed request may stay in Intake while its issue is not on the
 * board yet: the moment between filing and the issue's first read. Once the
 * issue's card is there, it is the one card for the work.
 *
 * Minutes, not a day: an issue closed before it was ever on the board — #3,
 * superseded by #7 an hour after it was filed — never arrives, and with a
 * day its request sat in Intake as work that was not going to happen.
 */
export const FILED_SHOWN_MS = 10 * 60 * 1000;

export interface BoardWork {
  byRef: Map<string, CardExtras>;
  /** Requests intake is working on, newest first. */
  requests: RequestCard[];
  /** Bots with a task running. */
  running: Set<string>;
  /** Bots whose task is paused behind a question a person has not answered. */
  waiting: Set<string>;
}

interface BoardWorkInput {
  issues: readonly IssueFacts[];
  /** Tasks on the cards' subjects, and every task still going anywhere. */
  tasks: readonly TaskFacts[];
  bots: readonly { id: string; name: string }[];
  repos: readonly { id: string; name: string; fullName?: string; stageModes: Partial<Record<string, string>> }[];
  gates: readonly Pick<Gate, 'taskId'>[];
  stallEvents: readonly { at: string; payload: unknown }[];
  /**
   * Console requests: one that became an issue, so the triage it took counts
   * toward the card, and one still in intake, which is a card of its own.
   */
  requests: readonly {
    id: string;
    repoId: string | null;
    issueNumber: number | null;
    text: string;
    state: string;
    createdAt: string;
    /** When it last changed: for a filed one, when it was filed. */
    updatedAt?: string;
    /** Its place in line while queued, as the queue gives it (`withPositions`). */
    queuePosition?: number | null;
    /** Starts the queue was refused; one it gave up on is in Needs you, not on the board (`stillTried`). */
    queueAttempts?: number;
  }[];
  /** Now, for how long a filed request stays; the time of the read. */
  now?: Date;
  /** Send-backs per issue, by `repoId#number` (`stageMoves.sendBackCounts`). */
  sendBacks?: ReadonlyMap<string, number>;
  /**
   * Pull requests no issue on the board has as its own (`loosePulls`), by
   * subject: a card of their own, or one more link of an item whose card
   * sums them in (`itemCards`).
   */
  pulls?: readonly { ref: string; number: number }[];
}

/** The first line of what was asked, as a card's title. */
function requestTitle(text: string): string {
  const line = text.split('\n').map((one) => one.trim()).find(Boolean) ?? 'A request';
  return line.length > 140 ? `${line.slice(0, 139).trimEnd()}…` : line;
}

export function boardWork(input: BoardWorkInput): BoardWork {
  const botName = (id: string): string => input.bots.find((bot) => bot.id === id)?.name ?? 'a bot';
  const gated = new Set(input.gates.map((gate) => gate.taskId).filter((id): id is string => Boolean(id)));
  const stalls = standingStalls(input.stallEvents, input.issues, input.tasks);

  const byRef = new Map<string, CardExtras>();
  for (const issue of input.issues) {
    const requestSubjects = input.requests
      .filter((request) => request.repoId === issue.repoId && request.issueNumber === issue.number)
      .map((request) => `request:${request.id.slice(0, 8)}`);
    const work = cardWork(issue, { tasks: input.tasks, botName, stalls, requestSubjects });
    byRef.set(`${issue.repoName}#${issue.number}`, {
      ...work,
      assignees: [...new Set(work.active.map((task) => task.bot))],
      sentBack: input.sendBacks?.get(`${issue.repoId}#${issue.number}`) ?? 0,
    });
  }
  // A pull request with no issue has no issue row for `cardWork`: its own
  // tasks, a review's or a deploy's, are all its card has.
  for (const pull of input.pulls ?? []) {
    const mine = input.tasks.filter((task) => task.subjectRef === pull.ref).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const active = mine.filter(isActive).map((task) => asCardTask(task, botName));
    const ended = mine.find((task) => !isActive(task));
    byRef.set(pull.ref, {
      gateOpen: mine.some((task) => isActive(task) && gated.has(task.id)),
      number: pull.number,
      prNumber: pull.number,
      costUsd: Math.round(mine.reduce((total, task) => total + task.costUsd, 0) * 10_000) / 10_000,
      active,
      last: ended ? asCardTask(ended, botName) : null,
      reviewRound: null,
      stalledAfterRounds: null,
      reviewFailed: false,
      shippedAt: null,
      waitingOn: [],
      assignees: [...new Set(active.map((task) => task.bot))],
      sentBack: 0,
    });
  }

  // A request is on the board from when it is sent: waiting its turn
  // for intake, and while intake asks and writes it up. Once filed, its issue's
  // card is the work's one card, and it moves from column to column: the
  // request stayed in Intake for a day saying "Filed #N" beside that card, so
  // every piece of work was on the board twice. It stays only until its issue
  // is on the board. One whose triage ended without filing is in the intake
  // bot's thread, which says why.
  const onBoard = new Set(input.issues.map((issue) => `${issue.repoId}#${issue.number}`));
  const now = (input.now ?? new Date()).getTime();
  const requests: RequestCard[] = [];
  for (const request of input.requests) {
    const subject = `request:${request.id.slice(0, 8)}`;
    const mine = input.tasks.filter((task) => task.subjectRef === subject).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const active = mine.filter(isActive);
    const ended = mine.filter((task) => !isActive(task));
    const repo = input.repos.find((one) => one.id === request.repoId);
    let state: RequestCardState;
    if (request.state === 'queued') {
      // Given up on, it is a card in Needs you with Try again: said here as
      // queued it looked like it would start on its own.
      if (!stillTried(request)) continue;
      state = 'queued';
    }
    else if ((request.state === 'draft' || request.state === 'questions') && active.length > 0) {
      state = active.some((task) => gated.has(task.id)) ? 'waiting' : 'working';
    } else if (
      request.state === 'filed' &&
      request.issueNumber !== null &&
      !onBoard.has(`${request.repoId}#${request.issueNumber}`) &&
      now - Date.parse(request.updatedAt ?? request.createdAt) < FILED_SHOWN_MS
    ) {
      state = 'filed';
    } else continue;
    requests.push({
      repo: repo?.name ?? '',
      ref: subject,
      title: requestTitle(request.text),
      stage: 'intake',
      assignees: [...new Set(active.map((task) => botName(task.botId)))],
      gateOpen: state === 'waiting',
      url: state === 'filed' && repo?.fullName ? `https://github.com/${repo.fullName}/issues/${request.issueNumber}` : null,
      labels: [],
      updatedAt: mine[0]?.createdAt ?? request.updatedAt ?? request.createdAt,
      request: true,
      requestState: state,
      queuePosition: state === 'queued' ? (request.queuePosition ?? null) : null,
      issueNumber: state === 'filed' ? request.issueNumber : null,
      costUsd: Math.round(mine.reduce((total, task) => total + task.costUsd, 0) * 10_000) / 10_000,
      active: active.map((task) => asCardTask(task, botName)),
      last: ended[0] ? asCardTask(ended[0], botName) : null,
    });
  }
  // What needs the person first, then what intake is on, then the line in
  // its order, then what was filed.
  const RANK: Record<RequestCardState, number> = { waiting: 0, working: 1, queued: 2, filed: 3 };
  requests.sort(
    (a, b) =>
      RANK[a.requestState] - RANK[b.requestState] ||
      (a.queuePosition ?? 0) - (b.queuePosition ?? 0) ||
      Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );

  const running = new Set<string>();
  const waiting = new Set<string>();
  for (const task of input.tasks) {
    if (task.state === 'running') running.add(task.botId);
    if (task.state === 'paused' && gated.has(task.id)) waiting.add(task.botId);
  }

  return { byRef, requests, running, waiting };
}

/** Reads what `boardWork` needs beyond what the board route already has. */
export async function readBoardWork(
  input: Omit<BoardWorkInput, 'tasks' | 'stallEvents'>,
  now = new Date(),
): Promise<BoardWork> {
  const subjects = input.issues.flatMap(subjectsOf);
  const requestSubjects = input.requests
    .filter((request) => request.issueNumber !== null)
    .map((request) => `request:${request.id.slice(0, 8)}`);
  const since = new Date(now.getTime() - STALL_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // A request still in intake, or filed in the last few minutes, is a card of its own, on its triage's tasks.
  const intakeSubjects = input.requests
    .filter((request) => request.state !== 'abandoned')
    .filter((request) => request.issueNumber === null || now.getTime() - Date.parse(request.updatedAt ?? request.createdAt) < FILED_SHOWN_MS)
    .map((request) => `request:${request.id.slice(0, 8)}`);
  const pullSubjects = (input.pulls ?? []).map((pull) => pull.ref);
  const [onCards, going, stallEvents, sendBacks] = await Promise.all([
    taskStore.listTasksOnSubjects([...new Set([...subjects, ...requestSubjects, ...intakeSubjects, ...pullSubjects])]),
    taskStore.listTasks({ states: ['queued', 'running', 'paused'], limit: 200 }),
    listEventsOfType(REVIEW_STALLED, since),
    // A table not there yet is no send-backs, not a board that fails.
    (async () => stageMoves.sendBackCounts())().catch(() => new Map<string, number>()),
  ]);

  const seen = new Set(onCards.map((task) => task.id));
  const tasks = [...onCards, ...going.filter((task) => isActive(task) && !seen.has(task.id))];
  return boardWork({ ...input, tasks, stallEvents, now, sendBacks });
}

/** A work item's link as the board groups by it (`workItems.allLinks`). */
export interface BoardLink {
  id: number;
  itemId: string;
  itemNumber?: number;
  kind: 'issue' | 'pull' | 'request';
  repoId: string | null;
  number: number | null;
  requestId: string | null;
  title: string;
  state: 'open' | 'closed' | 'merged';
  url: string | null;
  openedAt: string;
}

/** What a card says of its work item: the key, and every repository it has a link in. */
export interface ItemCardFields {
  item: { number: number; key: string } | null;
  repos: string[];
}

/** A pull request alone on its work item, as a card of its own. */
export interface LonePull {
  ref: string;
  repo: string;
  number: number;
  title: string;
  url: string | null;
  stage: 'review' | 'done';
  openedAt: string;
}

function subjectOfLink(link: BoardLink, repoName: (id: string | null) => string | null): string | null {
  if (link.kind === 'request') return link.requestId ? `request:${link.requestId.slice(0, 8).toLowerCase()}` : null;
  const repo = repoName(link.repoId);
  return repo && link.number !== null ? `${repo}#${link.number}` : null;
}

/**
 * The pull requests that are a card of their own: their work item holds no
 * issue and no request, as a person's pull request that closes nothing. In
 * Review while open, and in Done once merged or closed (closed unmerged
 * reads as abandoned), as long as an issue's card is: history is numbered
 * whole, and a pull merged after a month open left the board the day it merged.
 */
export function lonePulls(links: readonly BoardLink[], repos: readonly { id: string; name: string }[]): LonePull[] {
  const repoName = (id: string | null) => repos.find((repo) => repo.id === id)?.name ?? null;
  const byItem = new Map<string, BoardLink[]>();
  for (const link of links) byItem.set(link.itemId, [...(byItem.get(link.itemId) ?? []), link]);
  const out: LonePull[] = [];
  for (const members of byItem.values()) {
    if (members.some((link) => link.kind !== 'pull')) continue;
    const first = [...members].sort((a, b) => a.id - b.id).find((link) => repoName(link.repoId));
    const repo = first ? repoName(first.repoId) : null;
    if (!first || !repo || first.number === null) continue;
    const open = members.some((link) => link.state === 'open');
    out.push({ ref: `${repo}#${first.number}`, repo, number: first.number, title: first.title, url: first.url, stage: open ? 'review' : 'done', openedAt: first.openedAt });
  }
  return out;
}

/**
 * Every linked pull request whose work no issue's card already counts: not
 * the pull request of an issue on the board (`cardWork` counts that one).
 * A pull linked by hand beside an issue, or a second pull on an item with
 * none, had its review's cost and people left off the item's card.
 */
export function loosePulls(
  links: readonly BoardLink[],
  repos: readonly { id: string; name: string }[],
  issues: readonly { repoName: string; prNumber: number | null }[],
): { ref: string; number: number }[] {
  const repoName = (id: string | null) => repos.find((repo) => repo.id === id)?.name ?? null;
  const owned = new Set(issues.filter((issue) => issue.prNumber !== null).map((issue) => `${issue.repoName}#${issue.prNumber}`));
  return links.flatMap((link) => {
    const repo = repoName(link.repoId);
    if (link.kind !== 'pull' || !repo || link.number === null) return [];
    const ref = `${repo}#${link.number}`;
    return owned.has(ref) ? [] : [{ ref, number: link.number }];
  });
}

type GroupableCard = { ref: string; repo: string; assignees: string[]; gateOpen: boolean; costUsd?: number; active?: CardTask[] };

/**
 * One card per work item (docs/adr/0009-work-items.md).
 *
 * An item's card is its first issue's: the issue linked earliest that is on
 * the board, so it stands in that issue's column and a move acts on it, even
 * when a later issue or pull request stands elsewhere. Its cost, who is on
 * it, its tasks and whether a question is open are summed over every card
 * of the item. A request still in intake carries its item's key, and goes
 * once its item has an issue on the board. A card whose subject has no link
 * (an install not numbered yet) stays as it is, with no key.
 */
export function itemCards<C extends GroupableCard, R extends { ref: string; repo: string }>(input: {
  cards: readonly C[];
  /**
   * Work on an item's other links that is no card of its own: a pull linked
   * beside an issue, a second pull on an item with none. Summed into the
   * item's card, never shown alone.
   */
  members?: readonly GroupableCard[];
  requests: readonly R[];
  links: readonly BoardLink[];
  repos: readonly { id: string; name: string }[];
  /** The key of a number, as the install shows it. */
  keyOf: (number: number) => string;
}): { cards: (C & ItemCardFields)[]; requests: (R & ItemCardFields)[] } {
  const repoName = (id: string | null) => input.repos.find((repo) => repo.id === id)?.name ?? null;
  const itemByRef = new Map<string, string>();
  const order = new Map<string, number>();
  const linksOf = new Map<string, BoardLink[]>();
  for (const link of input.links) {
    const ref = subjectOfLink(link, repoName);
    if (ref) {
      itemByRef.set(ref, link.itemId);
      order.set(ref, link.kind === 'issue' ? link.id : Number.MAX_SAFE_INTEGER - 1);
    }
    linksOf.set(link.itemId, [...(linksOf.get(link.itemId) ?? []), link]);
  }
  const fields = (itemId: string, own: string): ItemCardFields => {
    const links = linksOf.get(itemId) ?? [];
    const number = links[0]?.itemNumber;
    const names = links.map((link) => repoName(link.repoId)).filter((name): name is string => Boolean(name));
    return { item: number !== undefined ? { number, key: input.keyOf(number) } : null, repos: [...new Set([own, ...names].filter(Boolean))] };
  };

  const groups = new Map<string, C[]>();
  const cards: (C & ItemCardFields)[] = [];
  for (const card of input.cards) {
    const itemId = itemByRef.get(card.ref);
    if (!itemId) {
      cards.push({ ...card, item: null, repos: card.repo ? [card.repo] : [] });
      continue;
    }
    groups.set(itemId, [...(groups.get(itemId) ?? []), card]);
  }
  const extra = new Map<string, GroupableCard[]>();
  for (const member of input.members ?? []) {
    const itemId = itemByRef.get(member.ref);
    if (itemId) extra.set(itemId, [...(extra.get(itemId) ?? []), member]);
  }
  for (const [itemId, members] of groups) {
    const rank = (card: C) => order.get(card.ref) ?? Number.MAX_SAFE_INTEGER;
    const [first, ...rest] = [...members].sort((a, b) => rank(a) - rank(b));
    if (!first) continue;
    const all: GroupableCard[] = [first, ...rest, ...(extra.get(itemId) ?? []).filter((member) => !members.some((card) => card.ref === member.ref))];
    const merged: C & ItemCardFields = { ...first, ...fields(itemId, first.repo) };
    if (all.length > 1) {
      merged.assignees = [...new Set(all.flatMap((card) => card.assignees))];
      merged.gateOpen = all.some((card) => card.gateOpen);
      if (all.some((card) => card.costUsd !== undefined)) {
        merged.costUsd = Math.round(all.reduce((total, card) => total + (card.costUsd ?? 0), 0) * 10_000) / 10_000;
      }
      if (all.some((card) => card.active)) merged.active = all.flatMap((card) => card.active ?? []);
    }
    cards.push(merged);
  }

  const onBoard = new Set(groups.keys());
  const requests: (R & ItemCardFields)[] = [];
  for (const card of input.requests) {
    const itemId = itemByRef.get(card.ref);
    if (itemId && onBoard.has(itemId)) continue;
    requests.push({ ...card, ...(itemId ? fields(itemId, card.repo) : { item: null, repos: card.repo ? [card.repo] : [] }) });
  }
  return { cards, requests };
}
