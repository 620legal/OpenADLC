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
  /** Each running task's latest lines of output, oldest first, by its id: where its step is read from. */
  steps?: ReadonlyMap<string, readonly string[]>;
  /** When each running task last began running, by its id (`tasks.runningSince`); its start for one not in it. */
  since?: ReadonlyMap<string, string | null>;
  /** Tasks running across the install, counted by the database; counted from `tasks` when absent. */
  runningTasks?: number;
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
  const onCard = (task: TaskFacts): BoardTask => {
    const running = task.state === 'running';
    return {
      ...asCardTask(task, botName),
      activity: running ? activityOf(input.steps?.get(task.id) ?? []) : null,
      since: !running ? null : input.since?.has(task.id) ? (input.since.get(task.id) ?? null) : task.startedAt,
    };
  };

  const byRef = new Map<string, CardExtras>();
  for (const issue of input.issues) {
    const requestSubjects = input.requests
      .filter((request) => request.repoId === issue.repoId && request.issueNumber === issue.number)
      .map((request) => `request:${request.id.slice(0, 8)}`);
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
  input: Omit<BoardWorkInput, 'tasks' | 'stallEvents' | 'steps'> & {
    /** The sessions the route read, each with the task it runs: where a running task's step is. */
    sessions?: readonly Pick<Session, 'id' | 'taskId'>[];
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
  const [onCards, going, stallEvents, sendBacks, count] = await Promise.all([
    taskStore.listTasksOnSubjects([...new Set([...subjects, ...requestSubjects, ...intakeSubjects, ...pullSubjects])]),
    taskStore.listTasks({ states: ['queued', 'running', 'paused'], limit: 200 }),
    listEventsOfType(REVIEW_STALLED, since),
    // A table not there yet is no send-backs, not a board that fails.
    (async () => stageMoves.sendBackCounts())().catch(() => new Map<string, number>()),
    countRunning(),
  ]);

  const seen = new Set(onCards.map((task) => task.id));
  const tasks = [...onCards, ...going.filter((task) => isActive(task) && !seen.has(task.id))];
  const live = await readLive(runningOn(tasks, onTheBoard(input.issues, input.repos), input.requests, input.pulls), input.sessions ?? []);
  const { sessions: _sessions, ...facts } = input;
  return boardWork({ ...facts, tasks, stallEvents, now, sendBacks, ...live, runningTasks: count ?? undefined });
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
  // Numbered, the board's cards are work items' (`itemCards`), read across
  // every repository and filtered after grouping; the poll says them the same
  // way. Said by their own refs, a second issue's or a linked pull's running
  // task named a card the board does not show, and the console read the
  // whole board again every five seconds.
  const numbered = await (async () => workItemStore.isNumbered())().catch(() => false);
  const [issueList, crew, repoList, requestList, runningNow, sessionList, count, links] = await Promise.all([
    issueStore.listIssues(numbered ? undefined : repoName),
    botStore.listBots(),
    repoStore.listRepos(),
    requestStore.listRequests(200),
    taskStore.listTasks({ states: ['running'], limit: 200 }),
    sessionStore.listSessions(),
    countRunning(),
    numbered ? (async () => workItemStore.allLinks())().catch(() => [] as BoardLink[]) : Promise.resolve([] as BoardLink[]),
  ]);
  const running = count ?? runningNow.length;
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
  const requestsLive = requests.filter((request) => liveSubjects.has(subjectOfRequest(request)));
  const itemOf = itemsByRef(links, repoList);
  if (numbered) {
    // Every card of an item with work running, so its card is the one the
    // board shows, carrying every task on the item.
    const items = new Set([...issuesLive.map((issue) => `${issue.repoName}#${issue.number}`), ...pullsLive.map((pull) => pull.ref)].map((ref) => itemOf.get(ref)));
    const ofLiveItem = (ref: string) => {
      const id = itemOf.get(ref);
      return id !== undefined && items.has(id);
    };
    issuesLive = shown.filter((issue) => issuesLive.includes(issue) || ofLiveItem(`${issue.repoName}#${issue.number}`));
    pullsLive = loose.filter((pull) => pullsLive.includes(pull) || ofLiveItem(pull.ref));
  }
  const [onCards, { steps, since }] = await Promise.all([
    taskStore.listTasksOnSubjects([...new Set([...issuesLive.flatMap(subjectsOf), ...requestsLive.map(subjectOfRequest), ...pullsLive.map((pull) => pull.ref)])]),
    readLive(live, sessionList),
  ]);
  const work = boardWork({ issues: issuesLive, tasks: onCards, bots: crew, repos: repoList, gates: [], stallEvents: [], requests: requestsLive, now, steps, since, pulls: pullsLive });
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
