import { listEventsOfType, stageMoves, tasks as taskStore } from '@fleetadlc/db';
import type { Gate } from '@fleetadlc/shared';
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
  const [onCards, going, stallEvents, sendBacks] = await Promise.all([
    taskStore.listTasksOnSubjects([...new Set([...subjects, ...requestSubjects, ...intakeSubjects])]),
    taskStore.listTasks({ states: ['queued', 'running', 'paused'], limit: 200 }),
    listEventsOfType(REVIEW_STALLED, since),
    // A table not there yet is no send-backs, not a board that fails.
    (async () => stageMoves.sendBackCounts())().catch(() => new Map<string, number>()),
  ]);

  const seen = new Set(onCards.map((task) => task.id));
  const tasks = [...onCards, ...going.filter((task) => isActive(task) && !seen.has(task.id))];
  return boardWork({ ...input, tasks, stallEvents, now, sendBacks });
}
