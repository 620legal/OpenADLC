import {
  bots as botStore,
  issues as issueStore,
  listEventsOfType,
  repos as repoStore,
  requests as requestStore,
  sessions as sessionStore,
  stageMoves,
  tasks as taskStore,
  workItems as workItemStore,
} from '@openadlc/db';
import type { Gate, Session } from '@openadlc/shared';
import {
  asCardTask,
  cardWork,
  ignoredSubjects,
  isActive,
  REVIEW_STALLED,
  shownIssues,
  stageOfTask,
  standingStalls,
  parseRef,
  subjectsOf,
  type CardTask,
  type CardWork,
  type IssueFacts,
  type TaskFacts,
} from './work.js';
import { stillTried } from './request-queue.js';
import { buildCandidates, readWaitingContext, waitingCards, waitingOf, type CardWaiting, type BuildHold, type WaitingContext, type WaitingReads } from './waiting.js';

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

/**
 * How long Done keeps a card, in days, as the console shows it: what the
 * board reads work items' links for, beside the work still open (`boardLinks`).
 */
export const DONE_SHOWN_DAYS = 7;

/**
 * How many of a running task's latest lines of output are read for the step
 * it is on. A long command is three or four rows of the pane (`PANE_WIDTH`);
 * twenty finds its first one behind whatever printed after it.
 */
const STEP_LINES = 20;

/**
 * The width of a task's pane: hostd starts each session detached and never
 * sets one, so tmux gives it its default, 80 columns, and a longer line goes
 * on in the row below.
 */
const PANE_WIDTH = 80;

/**
 * A task on a card, and for one running, what it is doing now in a few words
 * of the board's own: "running tests", "reading the diff". Null when it is
 * not running, or has not printed a step yet, and the card says its kind of
 * work instead.
 *
 * The card's line used to come from the task's kind and nothing else, so it
 * said "Writing the change · 12 min" for twelve minutes and a person could not
 * tell a builder running the tests from one stuck since its first minute.
 */
export interface BoardTask extends CardTask {
  activity: string | null;
  /**
   * When a running task last began running: its start, or the answer that
   * resumed it after a question (`tasks.runningSince`). A card counted from
   * the start, so a task answered a day after it asked read "1 day". Null
   * when it is not running, or resumed at a time nothing records.
   */
  since: string | null;
  /**
   * For a build paused on a question, the repository build it takes while
   * other builds wait for one (`waitingOf`). Absent when it holds nobody
   * up, and from a read that works out no waiting.
   */
  holds?: BuildHold | null;
}

export interface CardExtras extends CardWork {
  /** A question open on its work; set for a pull request's, the store says an issue's (`boardCards`). */
  gateOpen?: boolean;
  /** Queued, running or paused, newest first; each running one with its step. */
  active: BoardTask[];
  /** Every bot on the card now, on the issue or its pull request. */
  assignees: string[];
  /** How many times its work was sent back to an earlier stage; the card says "sent back ×N". */
  sentBack: number;
  /**
   * With nothing going on it, why it waits, since when, and on what
   * (`waitingOf`); null when it does not wait for a seat — work is going, or
   * its stage is one review or shipping starts. Absent from a read that
   * works out no waiting: the activity poll's.
   */
  waiting?: CardWaiting | null;
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
  active: BoardTask[];
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
  /** Tasks running across the install, on a card or not, whatever repository the board shows. */
  runningTasks: number;
}

interface BoardWorkInput {
  issues: readonly IssueFacts[];
  /** Tasks on the cards' subjects, and every task still going anywhere. */
  tasks: readonly TaskFacts[];
  /** With each seat's role and tasks at once, for what a card waits on; a bot read without them staffs nothing. */
  bots: readonly { id: string; name: string; role?: string; maxTasks?: number | null }[];
  repos: readonly {
    id: string;
    name: string;
    fullName?: string;
    stageModes: Partial<Record<string, string>>;
    /** How many builds it runs at once; absent, as many as there are builders. */
    concurrency?: number;
    defaultBranch?: string;
  }[];
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
  /**
   * Numbered, the requests each issue's card carries, from its work item's
   * links (`requestsOnCards`). An issue not in it, in a repository whose
   * history is not numbered yet, carries the requests filed as it, as before
   * work items. Joined by `issue_number`, a request unlinked from its issue
   * still put its triage on that issue's card.
   */
  itemRequests?: ReadonlyMap<string, readonly string[]>;
  /** Each running task's latest lines of output, oldest first, by its id: where its step is read from. */
  steps?: ReadonlyMap<string, readonly string[]>;
  /** When each running task last began running, by its id (`tasks.runningSince`); its start for one not in it. */
  since?: ReadonlyMap<string, string | null>;
  /** Tasks running across the install, counted by the database; counted from `tasks` when absent. */
  runningTasks?: number;
  /**
   * What a card with nothing going on it waits on beyond its tasks: the
   * pauses, the cap, the checks, the next sweep (`readWaitingContext`).
   * Absent, no card says why it waits, as the activity poll's do not.
   */
  waiting?: WaitingContext;
}

/**
 * A line the skill runner prints for each step (`skill-runner.ts`): a tool it
 * called, a file it wrote, or a line of its own — starting, its briefing, a
 * question, finishing.
 */
const STEP_HEAD = /^\s*\[(tool|wrote|skill)\] /;

/** Longer than any step the runner prints (a summary is at most 200 characters), so other output glued on stays out. */
const STEP_MAX = 260;

/**
 * The newest step in a session's output, with the rows tmux wrapped it onto
 * joined back: the pane is read without joining, so the last row of a long
 * command was its end, and the tool's name was a row above it.
 *
 * A row is the step going on only when the one above it filled the pane's
 * width. tmux trims the trailing space of a row, so one a column short ended
 * in a space and is joined with one. Any other row is the next thing the
 * session printed, and gluing it on read "vitest" in a test runner's own
 * output as the command.
 */
function latestStep(lines: readonly string[]): string | null {
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    let row = lines[at] ?? '';
    if (!STEP_HEAD.test(row)) continue;
    let step = row;
    for (let next = at + 1; next < lines.length && row.length >= PANE_WIDTH - 1 && step.length < STEP_MAX; next += 1) {
      const gap = row.length === PANE_WIDTH - 1 ? ' ' : '';
      row = lines[next] ?? '';
      step = `${step}${gap}${row}`;
    }
    return step.trim().slice(0, STEP_MAX);
  }
  return null;
}

/** A tool by its name, as Claude, Codex and Grok call it, and what the card says it is doing. */
const TOOLS: readonly [RegExp, string][] = [
  [/^(read|read_?file|view|view_?file|notebook_?read|cat)$/, 'reading the code'],
  [/^(grep|glob|ls|search|find|list_?dir|list_?files|codebase_?search|grep_?search|file_?search)$/, 'searching the code'],
  [/^(edit|write|multi_?edit|notebook_?edit|search_?replace|hashline_?edit|apply_?patch|str_?replace\w*|create_?file|write_?file|edit_?file)$/, 'editing files'],
  [/^(web_?fetch|web_?search|fetch)$/, 'reading the web'],
  [/^(todo_?write|update_?plan)$/, 'planning the work'],
];

const SHELLS = /^(bash|shell|sh|exec|terminal|run_?terminal_?cmd|run_?command|execute)$/;

/** A shell a command is handed to whole, as Codex runs each one: `bash -lc "make ci"`, `/bin/sh -c '…'`. */
const SHELL_WRAPPER = /^\s*(?:\S*\/)?(?:ba|z)?sh\s+-(?:lc|cl|c)\s+/;

/**
 * The command a shell was handed, without the shell and its quotes: the
 * patterns below look for a command where one starts, and `bash -lc "make ci"`
 * has none there. A summary cut short has lost its closing quote.
 */
function unwrapped(command: string): string {
  const wrapper = SHELL_WRAPPER.exec(command);
  if (!wrapper) return command;
  const inner = command.slice(wrapper[0].length).trim();
  const quote = inner.charAt(0);
  if (quote !== '"' && quote !== "'") return inner;
  return inner.length > 1 && inner.endsWith(quote) ? inner.slice(1, -1) : inner.slice(1);
}

/** Where a command starts in a line: at its beginning, or after `&&`, `;` or a pipe, not inside a quoted message. */
const AT_COMMAND = String.raw`(?:^|&&|;|\|)\s*`;

/**
 * A command, by what it is for. First match wins, so a commit whose message
 * says "test" is committing, and `pnpm build && pnpm test` is the tests.
 */
const COMMANDS: readonly [RegExp, string][] = [
  [new RegExp(String.raw`${AT_COMMAND}(?:openadlc-ci|make\s+ci)\b`), 'running CI locally'],
  [/\bgh\s+pr\s+create\b/, 'opening the pull request'],
  [/\bgh\s+pr\s+review\b/, 'writing the review'],
  [/\bgh\s+pr\s+diff\b|\bgit\s+diff\b/, 'reading the diff'],
  [/\bgh\s+(?:pr|issue)\s+comment\b/, 'writing a comment'],
  [/\bgit\s+commit\b/, 'committing'],
  [/\bgit\s+push\b/, 'pushing the branch'],
  [/\bgit\s+(?:fetch|pull|rebase|merge)\b/, 'updating the branch'],
  [
    /\b(?:vitest|jest|pytest|mocha|rspec|phpunit|playwright|cypress)\b|\b(?:go|cargo|dotnet|mix|deno|bun)\s+test\b|\b(?:npm|pnpm|yarn)\b[^;&|]*\btest\b|\bmake\s+test\b|\bnode\s+--test\b/,
    'running tests',
  ],
  [/\btsc\b|\btypecheck\b|\bmypy\b|\bpyright\b/, 'type-checking'],
  [/\b(?:eslint|lint|prettier|biome|ruff|rubocop|clippy)\b/, 'linting'],
  [/\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|ci)\b|\bpip3?\s+install\b|\bbundle\s+install\b|\bgo\s+mod\s+download\b/, 'installing dependencies'],
  [new RegExp(String.raw`\b(?:npm|pnpm|yarn|bun)\b[^;&|]*\bbuild\b|\b(?:cargo|go|dotnet)\s+build\b|${AT_COMMAND}make\b`), 'building'],
  [/\bgh\s+(?:pr|issue|run|api|repo|release)\b/, 'reading GitHub'],
  [/\bgit\s+(?:log|show|blame)\b/, 'reading the history'],
  [/\bgit\b/, 'working with git'],
  [new RegExp(String.raw`${AT_COMMAND}(?:rg|grep|find|fd|ag|ls|tree)\b`), 'searching the code'],
  [new RegExp(String.raw`${AT_COMMAND}(?:cat|head|tail|sed\s+-n|less|wc|nl|bat)\b`), 'reading the code'],
  [/\b(?:curl|wget)\b/, 'reading the web'],
];

/**
 * What a running task is doing now, in the board's own words, from its
 * latest output; null when its last step is not a tool (it is starting, or
 * says something of its own) or is one these words do not know.
 *
 * Never any of the output itself: a session's screen is an admin's
 * (`sessionsFor` in api.ts), and a command line can hold a token, a path or
 * a person's words. The board is read by every user, so it carries only one
 * of the phrases here.
 */
export function activityOf(lines: readonly string[]): string | null {
  const step = latestStep(lines);
  if (!step) return null;
  if (step.startsWith('[wrote] ')) return 'editing files';
  const tool = /^\[tool\] ([^:]+):\s?(.*)$/.exec(step);
  if (!tool) return null;
  const name = (tool[1] ?? '').trim().toLowerCase();
  if (SHELLS.test(name)) {
    const command = unwrapped(tool[2] ?? '');
    return COMMANDS.find(([pattern]) => pattern.test(command))?.[1] ?? 'running a command';
  }
  return TOOLS.find(([pattern]) => pattern.test(name))?.[1] ?? null;
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
  const newestFirst = (a: TaskFacts, b: TaskFacts): number => Date.parse(b.createdAt) - Date.parse(a.createdAt);
  const stepOf = (task: Pick<TaskFacts, 'id'>) => activityOf(input.steps?.get(task.id) ?? []);
  const requestSubjectsOf = (issue: IssueFacts): readonly string[] =>
    input.itemRequests?.get(`${issue.repoName}#${issue.number}`) ??
    input.requests
      .filter((request) => request.repoId === issue.repoId && request.issueNumber === issue.number)
      .map((request) => `request:${request.id.slice(0, 8)}`);
  // What each card with nothing going on it waits on: the cards the board
  // shows, in the order the crew takes them, against every task going.
  const waits = input.waiting
    ? waitingOf({
        ...input.waiting,
        now: input.now ?? new Date(),
        cards: waitingCards(onTheBoard(input.issues, input.repos), input.tasks, requestSubjectsOf),
        issues: input.issues,
        live: input.tasks.filter(isActive),
        bots: input.bots,
        repos: input.repos,
        gated,
        activity: (id) => stepOf({ id }),
      })
    : null;
  const onCard = (task: TaskFacts): BoardTask => {
    const running = task.state === 'running';
    const holds = waits?.holds.get(task.id);
    return {
      ...asCardTask(task, botName),
      activity: running ? stepOf(task) : null,
      since: !running ? null : input.since?.has(task.id) ? (input.since.get(task.id) ?? null) : task.startedAt,
      ...(holds ? { holds } : {}),
    };
  };

  const byRef = new Map<string, CardExtras>();
  for (const issue of input.issues) {
    const requestSubjects = requestSubjectsOf(issue);
    const work = cardWork(issue, { tasks: input.tasks, botName, stalls, requestSubjects });
    // `cardWork`'s own active tasks, chosen and ordered as it chooses them,
    // with each running one's step: a card task carries no id to find it by.
    const subjects = new Set([...subjectsOf(issue), ...requestSubjects]);
    const active = input.tasks.filter((task) => subjects.has(task.subjectRef) && isActive(task)).sort(newestFirst).map(onCard);
    byRef.set(`${issue.repoName}#${issue.number}`, {
      ...work,
      active,
      assignees: [...new Set(active.map((task) => task.bot))],
      sentBack: input.sendBacks?.get(`${issue.repoId}#${issue.number}`) ?? 0,
      ...(waits ? { waiting: waits.cards.get(`${issue.repoName}#${issue.number}`) ?? null } : {}),
    });
  }
  // A pull request with no issue has no issue row for `cardWork`: its own
  // tasks, a review's or a deploy's, are all its card has.
  for (const pull of input.pulls ?? []) {
    const mine = input.tasks.filter((task) => task.subjectRef === pull.ref).sort(newestFirst);
    const active = mine.filter(isActive).map(onCard);
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
    const mine = input.tasks.filter((task) => task.subjectRef === subject).sort(newestFirst);
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
      active: active.map(onCard),
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
  let runningTasks = 0;
  for (const task of input.tasks) {
    if (task.state === 'running') {
      running.add(task.botId);
      runningTasks += 1;
    }
    if (task.state === 'paused' && gated.has(task.id)) waiting.add(task.botId);
  }

  return { byRef, requests, running, waiting, runningTasks: input.runningTasks ?? runningTasks };
}

type SessionFacts = Pick<Session, 'id' | 'taskId'>;

/**
 * The issues whose cards the board shows, as the board route has them: in a
 * repository OpenADLC works in, and not left out by `openadlc:ignore`.
 */
function onTheBoard(issues: readonly IssueFacts[], repos: BoardWorkInput['repos']): IssueFacts[] {
  const workedIn = new Set(repos.map((repo) => repo.id));
  return shownIssues(issues).filter((issue) => workedIn.has(issue.repoId));
}

const subjectOfRequest = (request: { id: string }): string => `request:${request.id.slice(0, 8)}`;

/** The running tasks on the cards shown: on an issue or its pull request, a request's triage, or a pull request a work item links (`loosePulls`). */
function runningOn(tasks: readonly TaskFacts[], shown: readonly IssueFacts[], requests: readonly { id: string }[], pulls: readonly { ref: string }[] = []): TaskFacts[] {
  const subjects = new Set([...shown.flatMap(subjectsOf), ...requests.map(subjectOfRequest), ...pulls.map((pull) => pull.ref)]);
  return tasks.filter((task) => task.state === 'running' && subjects.has(task.subjectRef));
}

/**
 * What the board says of each running task it shows: its step, from the
 * latest lines hostd already stored from its session's pane (`session_log`),
 * and since when it has run. One query for each, however many cards run, and
 * none for a task on no card shown; nothing asks hostd or GitHub. A read that
 * fails is a card with no step, or timed from its start, not a board that
 * fails.
 */
async function readLive(
  running: readonly TaskFacts[],
  sessions: readonly SessionFacts[],
): Promise<{ steps: Map<string, string[]>; since: Map<string, string | null> }> {
  const ids = new Set(running.map((task) => task.id));
  const watched = sessions.filter((session) => session.taskId !== null && ids.has(session.taskId));
  const [lines, since] = await Promise.all([
    watched.length === 0
      ? new Map<string, string[]>()
      : (async () => sessionStore.recentLines(watched.map((session) => session.id), STEP_LINES))().catch(() => new Map<string, string[]>()),
    ids.size === 0 ? new Map<string, string | null>() : (async () => taskStore.runningSince([...ids]))().catch(() => new Map<string, string | null>()),
  ]);
  return { steps: new Map(watched.map((session) => [session.taskId!, lines.get(session.id) ?? []] as const)), since };
}

/** Every running task in the install, by a count; null when it could not be read, and the board counts what it listed. */
function countRunning(): Promise<number | null> {
  return (async () => taskStore.countRunning())().catch(() => null);
}

/** Reads what `boardWork` needs beyond what the board route already has. */
export async function readBoardWork(
  input: Omit<BoardWorkInput, 'tasks' | 'stallEvents' | 'steps' | 'waiting'> & {
    /** The sessions the route read, each with the task it runs: where a running task's step is. */
    sessions?: readonly Pick<Session, 'id' | 'taskId'>[];
    /** Where what a waiting card waits on is read from; absent, no card says why it waits. */
    waiting?: WaitingReads;
  },
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
  const linkedRequests = [...(input.itemRequests?.values() ?? [])].flat();
  const [onCards, going, stallEvents, sendBacks, count] = await Promise.all([
    taskStore.listTasksOnSubjects([...new Set([...subjects, ...requestSubjects, ...intakeSubjects, ...pullSubjects, ...linkedRequests])]),
    taskStore.listTasks({ states: ['queued', 'running', 'paused'], limit: 200 }),
    listEventsOfType(REVIEW_STALLED, since),
    // A table not there yet is no send-backs, not a board that fails.
    (async () => stageMoves.sendBackCounts())().catch(() => new Map<string, number>()),
    countRunning(),
  ]);

  const seen = new Set(onCards.map((task) => task.id));
  const tasks = [...onCards, ...going.filter((task) => isActive(task) && !seen.has(task.id))];
  const shown = onTheBoard(input.issues, input.repos);
  // A build's work in flight is read only for a repository with a build
  // that could start, one read each.
  const candidates = input.waiting ? buildCandidates(waitingCards(shown, tasks)) : new Set<string>();
  const buildRepos = input.repos.filter((repo) => candidates.has(repo.name)).map((repo) => ({ id: repo.id, name: repo.name, fullName: repo.fullName ?? repo.name, defaultBranch: repo.defaultBranch ?? 'main' }));
  const [live, waiting] = await Promise.all([
    readLive(runningOn(tasks, shown, input.requests, input.pulls), input.sessions ?? []),
    input.waiting ? readWaitingContext(input.waiting, { buildRepos }) : Promise.resolve(undefined),
  ]);
  const { sessions: _sessions, waiting: _reads, ...facts } = input;
  return boardWork({ ...facts, tasks, stallEvents, now, sendBacks, ...live, runningTasks: count ?? undefined, ...(waiting ? { waiting } : {}) });
}

/** What the board polls for every few seconds while a card it shows is running. */
export interface BoardActivity {
  /** Tasks running across the install. */
  running: number;
  /** Each card shown with a task running on it, by its ref, with every task going on it now. */
  cards: { ref: string; active: BoardTask[] }[];
}

/**
 * The running cards of the board for a repository, or of all of them, and
 * nothing else: what the console reads every few seconds while any card it
 * shows runs, to keep their lines current without reading the whole page.
 * A full read of the board, with what needs you, the crew and the costs, was
 * every five seconds, and dozens of queries for each person looking.
 *
 * The console reads the whole board again when the cards here are not the
 * ones it shows running: one started, paused or ended.
 */
export async function readBoardActivity(repoName: string | undefined, now = new Date()): Promise<BoardActivity> {
  const [runningNow, count] = await Promise.all([taskStore.listTasks({ states: ['running'], limit: 200 }), countRunning()]);
  const running = count ?? runningNow.length;
  // Nothing running anywhere is no card running, and nothing else is read.
  // The poll read every link and every repository's issues before finding
  // that, every five seconds for each person looking.
  if (runningNow.length === 0) return { running, cards: [] };

  // Numbered, the board's cards are work items' (`itemCards`), read across
  // every repository and filtered after grouping; the poll says them the same
  // way. Said by their own refs, a second issue's or a linked pull's running
  // task named a card the board does not show, and the console read the
  // whole board again every five seconds.
  const numbered = await (async () => workItemStore.isNumbered())().catch(() => false);
  const [crew, repoList, requestList, sessionList] = await Promise.all([
    botStore.listBots(),
    repoStore.listRepos(),
    requestStore.listRequests(200),
    sessionStore.listSessions(),
  ]);
  const { links, listed } = numbered
    ? await liveItems(runningNow, repoList, requestList)
    : { links: [] as BoardLink[], listed: await issueStore.listIssues(repoName) };
  const issueList = withItemPulls(listed, links, repoList);
  // A request's card is on its repository's board, or on the board of all of them.
  const requests = repoName ? requestList.filter((request) => repoList.find((repo) => repo.id === request.repoId)?.name === repoName) : requestList;
  const shown = onTheBoard(issueList, repoList);
  const ignored = ignoredSubjects(issueList);
  const loose = loosePulls(links, repoList, issueList).filter((pull) => !ignored.has(pull.ref));
  const live = runningOn(runningNow, shown, requests, loose);
  if (live.length === 0) return { running, cards: [] };

  const liveSubjects = new Set(live.map((task) => task.subjectRef));
  let issuesLive = shown.filter((issue) => subjectsOf(issue).some((subject) => liveSubjects.has(subject)));
  let pullsLive = loose.filter((pull) => liveSubjects.has(pull.ref));
  let requestsLive = requests.filter((request) => liveSubjects.has(subjectOfRequest(request)));
  const itemOf = itemsByRef(links, repoList);
  if (numbered) {
    // Every card of an item with work running, so its card is the one the
    // board shows, carrying every task on the item. A triage still running
    // on its request once the issue is filed is the issue's card's: said as
    // the request's, it named a card the board had dropped.
    const items = new Set(
      [...issuesLive.map((issue) => `${issue.repoName}#${issue.number}`), ...pullsLive.map((pull) => pull.ref), ...requestsLive.map(subjectOfRequest)].map((ref) => itemOf.get(ref)),
    );
    const ofLiveItem = (ref: string) => {
      const id = itemOf.get(ref);
      return id !== undefined && items.has(id);
    };
    issuesLive = shown.filter((issue) => issuesLive.includes(issue) || ofLiveItem(`${issue.repoName}#${issue.number}`));
    pullsLive = loose.filter((pull) => pullsLive.includes(pull) || ofLiveItem(pull.ref));
    requestsLive = requests.filter((request) => requestsLive.includes(request) || ofLiveItem(subjectOfRequest(request)));
  }
  const itemRequests = numbered ? requestsOnCards(links, repoList, issuesLive) : undefined;
  const [onCards, { steps, since }] = await Promise.all([
    taskStore.listTasksOnSubjects([
      ...new Set([
        ...issuesLive.flatMap(subjectsOf),
        ...requestsLive.map(subjectOfRequest),
        ...pullsLive.map((pull) => pull.ref),
        ...[...(itemRequests?.values() ?? [])].flat(),
      ]),
    ]),
    readLive(live, sessionList),
  ]);
  const work = boardWork({ issues: issuesLive, tasks: onCards, bots: crew, repos: repoList, gates: [], stallEvents: [], requests: requestsLive, now, steps, since, pulls: pullsLive, itemRequests });
  let cards: { ref: string; active: BoardTask[] }[];
  if (!numbered) {
    cards = [
      ...[...work.byRef].map(([ref, card]) => ({ ref, active: card.active })),
      ...work.requests.map((card) => ({ ref: card.ref, active: card.active })),
    ];
  } else {
    const lone = new Set(lonePulls(links, repoList).map((pull) => pull.ref));
    const entry = (ref: string) => ({ ref, repo: ref.slice(0, ref.lastIndexOf('#')), assignees: [] as string[], gateOpen: false, active: work.byRef.get(ref)?.active ?? [] });
    const grouped = itemCards({
      cards: [...issuesLive.map((issue) => entry(`${issue.repoName}#${issue.number}`)), ...pullsLive.filter((pull) => lone.has(pull.ref)).map((pull) => entry(pull.ref))],
      members: pullsLive.filter((pull) => !lone.has(pull.ref)).map((pull) => entry(pull.ref)),
      requests: work.requests.map((card) => ({ ref: card.ref, repo: card.repo, active: card.active })),
      links,
      repos: repoList,
      keyOf: String,
    });
    const shownHere = (card: { repo: string; repos: string[] }) => !repoName || card.repo === repoName || card.repos.includes(repoName);
    cards = [
      ...grouped.cards.filter(shownHere).map((card) => ({ ref: card.ref, active: card.active as BoardTask[] })),
      ...grouped.requests.map((card) => ({ ref: card.ref, active: card.active })),
    ];
  }
  return {
    running,
    cards: cards.filter((card) => card.active.some((task) => task.state === 'running')).sort((a, b) => a.ref.localeCompare(b.ref)),
  };
}

/**
 * The items with work running, for the poll: every link of each item a
 * running task's subject is linked to (`linksOfItemsHolding`), and the rows
 * of their issues, read one by one. A running subject with no link, in a
 * repository whose history is not numbered yet, has its repository's issues
 * read, to find the issue whose pull request it is, as before work items.
 */
async function liveItems(
  runningNow: readonly TaskFacts[],
  repos: readonly { id: string; name: string }[],
  requests: readonly { id: string }[],
): Promise<{ links: BoardLink[]; listed: IssueFacts[] }> {
  const things: workItemStore.ThingRef[] = [];
  for (const task of runningNow) {
    const parsed = parseRef(task.subjectRef);
    const repo = parsed ? repos.find((one) => one.name === parsed.repo) : undefined;
    if (parsed && repo) things.push({ repoId: repo.id, number: parsed.number });
    const request = task.subjectRef.startsWith('request:') ? requests.find((one) => subjectOfRequest(one) === task.subjectRef) : undefined;
    if (request) things.push({ requestId: request.id });
  }
  const links = await (async () => workItemStore.linksOfItemsHolding(things))().catch(() => [] as BoardLink[]);
  const linked = itemsByRef(links, repos);
  const unlinkedRepos = new Set(
    runningNow.flatMap((task) => {
      const parsed = parseRef(task.subjectRef);
      return parsed && !linked.has(task.subjectRef) && repos.some((one) => one.name === parsed.repo) ? [parsed.repo] : [];
    }),
  );
  const [rows, unlinked] = await Promise.all([
    Promise.all(
      links
        .filter((link) => link.kind === 'issue' && link.repoId && link.number !== null)
        .map((link) => (async () => issueStore.getIssue(link.repoId!, link.number!))().catch(() => null)),
    ),
    Promise.all([...unlinkedRepos].map((name) => issueStore.listIssues(name))),
  ]);
  const listed = new Map<string, IssueFacts>();
  for (const issue of [...rows.filter((row): row is issueStore.IssueRecord => Boolean(row)), ...unlinked.flat()]) listed.set(`${issue.repoId}#${issue.number}`, issue);
  return { links, listed: [...listed.values()] };
}

/** The work item each linked subject is on, by `repo#n` and `request:<id8>`. */
function itemsByRef(links: readonly BoardLink[], repos: readonly { id: string; name: string }[]): Map<string, string> {
  const repoName = (id: string | null) => repos.find((repo) => repo.id === id)?.name ?? null;
  const out = new Map<string, string>();
  for (const link of links) {
    const ref = subjectOfLink(link, repoName);
    if (ref) out.set(ref, link.itemId);
  }
  return out;
}

/** A work item's link as the board groups by it (`workItems.boardLinks`, `workItems.linksOfItemsHolding`). */
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
  /** When it was last seen to close or merge; null while open, or for history nobody saw close. */
  closedAt?: string | null;
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
  /**
   * In Done, when its last pull closed, which the Done column counts its
   * week from as an issue's card counts from when it shipped; null when none
   * was seen to close, and the card falls back to when it opened.
   */
  closedAt: string | null;
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
 * whole, and a pull merged after a month open left the board the day it
 * merged. The board reads only those closed in the week Done shows
 * (`boardLinks`), not every one closed since the install began.
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
    const closes = members.flatMap((link) => (link.closedAt ? [link.closedAt] : [])).sort();
    out.push({
      ref: `${repo}#${first.number}`,
      repo,
      number: first.number,
      title: first.title,
      url: first.url,
      stage: open ? 'review' : 'done',
      openedAt: first.openedAt,
      closedAt: open ? null : (closes.at(-1) ?? null),
    });
  }
  return out;
}

/**
 * The issues as their work items have them: a linked issue has the pull
 * request its row records only while that pull is linked to the same item.
 * `cardWork` follows `prNumber`, so the issue's card kept counting the review
 * on a pull unlinked from it, and the pull's own card, left out of
 * `loosePulls` as the issue's, counted nothing. Only the links read are
 * known (`boardLinks`): a pull on an item the board no longer reads is not
 * this issue's either. An issue with no link, in a repository whose history
 * is not numbered yet, keeps what its row says.
 */
export function withItemPulls<I extends { repoName: string; number: number; prNumber: number | null }>(
  issues: readonly I[],
  links: readonly BoardLink[],
  repos: readonly { id: string; name: string }[],
): I[] {
  if (links.length === 0) return [...issues];
  const itemOf = itemsByRef(links, repos);
  return issues.map((issue) => {
    if (!issue.prNumber) return issue;
    const mine = itemOf.get(`${issue.repoName}#${issue.number}`);
    const pulls = itemOf.get(`${issue.repoName}#${issue.prNumber}`);
    return mine !== undefined && mine !== pulls ? { ...issue, prNumber: null } : issue;
  });
}

/**
 * The requests each linked issue's card carries: its item's request links,
 * on the card of the item's first-linked issue among `issues` (the card
 * `itemCards` keeps), and none on any other issue of it. An issue with no
 * link is not in it, and `boardWork` joins it to the requests filed as it.
 */
export function requestsOnCards(
  links: readonly BoardLink[],
  repos: readonly { id: string; name: string }[],
  issues: readonly { repoName: string; number: number }[],
): Map<string, string[]> {
  const repoName = (id: string | null) => repos.find((repo) => repo.id === id)?.name ?? null;
  const onBoard = new Set(issues.map((issue) => `${issue.repoName}#${issue.number}`));
  const byItem = new Map<string, BoardLink[]>();
  for (const link of links) byItem.set(link.itemId, [...(byItem.get(link.itemId) ?? []), link]);
  const out = new Map<string, string[]>();
  for (const members of byItem.values()) {
    const refs = (kind: BoardLink['kind']) =>
      [...members]
        .sort((a, b) => a.id - b.id)
        .filter((link) => link.kind === kind)
        .flatMap((link) => subjectOfLink(link, repoName) ?? []);
    const issueRefs = refs('issue');
    const card = issueRefs.find((ref) => onBoard.has(ref));
    for (const ref of issueRefs) out.set(ref, ref === card ? refs('request') : []);
  }
  return out;
}

/** The first day of the week the board's Done column shows (`DONE_DAYS` in the console's board-view.tsx). */
export function doneSince(now: Date): Date {
  return new Date(now.getTime() - DONE_SHOWN_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * The board's issues, the live ones and the week's (`issues.boardIssues`),
 * with the row of every other issue of an item the board reads the links of
 * (`boardLinks`): one that went to Done before the week. An item's card is
 * its first issue's, in that issue's column (`itemCards`), and its pull
 * requests and requests are that issue's (`withItemPulls`,
 * `requestsOnCards`). Without the row, an item whose first issue shipped a
 * month ago had its second issue's card in Build, while the poll, which
 * reads its items' issues by row, said the first one's, and the console
 * read the whole board again on every poll.
 */
export async function withItemIssues(listed: readonly issueStore.IssueRecord[], links: readonly BoardLink[]): Promise<issueStore.IssueRecord[]> {
  const read = new Set(listed.map((issue) => `${issue.repoId}#${issue.number}`));
  const missing = links.flatMap((link) =>
    link.kind === 'issue' && link.repoId && link.number !== null && !read.has(`${link.repoId}#${link.number}`) ? [{ repoId: link.repoId, number: link.number }] : [],
  );
  if (missing.length === 0) return [...listed];
  return [...listed, ...(await issueStore.getIssues(missing))].sort(issueStore.byNextFirst);
}

/**
 * Every linked pull request whose work no issue's card already counts: not
 * the pull request of an issue on the board (`cardWork` counts that one).
 * Given issues read through `withItemPulls`, so that is an issue of the
 * pull's own item.
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
export function itemCards<C extends GroupableCard, R extends { ref: string; repo: string } & Partial<GroupableCard>>(input: {
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
    cards.push(summed({ ...first, ...fields(itemId, first.repo) }, [...rest, ...(extra.get(itemId) ?? []).filter((member) => !members.some((card) => card.ref === member.ref))]));
  }

  const onBoard = new Set(groups.keys());
  const requests: (R & ItemCardFields)[] = [];
  for (const card of input.requests) {
    const itemId = itemByRef.get(card.ref);
    if (itemId && onBoard.has(itemId)) continue;
    if (!itemId) {
      requests.push({ ...card, item: null, repos: card.repo ? [card.repo] : [] });
      continue;
    }
    // A pull linked onto an item that is still only a request: its review
    // was on no card, as the request's card was built without it.
    requests.push(summed({ ...card, ...fields(itemId, card.repo) }, extra.get(itemId) ?? []));
  }
  return { cards, requests };
}

/** A card with the cost, people, tasks and open question of its item's other cards and links added in. */
function summed<C extends Partial<GroupableCard>>(card: C, others: readonly GroupableCard[]): C {
  if (others.length === 0) return card;
  const all = [card, ...others];
  const merged: C = { ...card };
  merged.assignees = [...new Set(all.flatMap((one) => one.assignees ?? []))];
  merged.gateOpen = all.some((one) => one.gateOpen);
  if (all.some((one) => one.costUsd !== undefined)) {
    merged.costUsd = Math.round(all.reduce((total, one) => total + (one.costUsd ?? 0), 0) * 10_000) / 10_000;
  }
  if (all.some((one) => one.active)) merged.active = all.flatMap((one) => one.active ?? []);
  return merged;
}
