import { acknowledgements, bots, issues, listEventsOfType, mergeLines, modelAccounts, repos, requests, tasks, threads, type HealthRow } from '@fleetadlc/db';
import { rulesFileEditUrl } from './deploy-routes.js';
import { heldForPerson } from './merge-line.js';
import { readUnowned } from './unowned-issues.js';
import { INTAKE_STALLED } from './intake-events.js';
import { DESIGN_MEMORY_SUPERSEDED } from './design-memory.js';
import { botInWords, hasIgnoreLabel, roleLabel, STAGE_COLUMN_TITLES, STAGE_KEYS, type StageKey, type BotRole, type Gate, type HealthAction, type HealthSeverity, type TaskKind } from '@fleetadlc/shared';
import { botSaid } from './bot-said.js';
import { NO_PULL_REQUEST, openPullRequestUrl } from './build-left.js';
import type { GitHubClient } from '@fleetadlc/github';
import type { EngineUpdateAttention } from './engine-updates.js';
import { NO_REASON, explainFailure } from './failure-words.js';
import { endsWithSubject, subjectClosed, wasRefused } from './gates.js';
import { failingIds, isWaiting, showsNotice, unconfirmedOf } from './health/state.js';
import { itemOf, requestSubject } from './items.js';
import { stillTried } from './request-queue.js';
import { ACCOUNTS_STEP, RECONNECT } from './health/words.js';
import type { Router } from './router.js';
import type { SubjectTitle } from './subject-titles.js';
import {
  ignoredSubjects,
  issueForSubject,
  parseRef,
  REVIEW_STALLED,
  SEND_BACK_STALLED,
  SEND_BACK_TO_PERSON,
  stageOfTask,
  stallFrom,
  standingStalls,
  type IssueFacts,
  type TaskFacts,
} from './work.js';

/**
 * Everything that is waiting on a person, newest first.
 *
 * The board used to count open gates and say "waiting on you" beside the
 * number, which left somebody to find out what they were — and a failed task, a
 * triage that never ran or a review loop that gave up waited on a person just as
 * much and were not counted at all. Each of those already has a row or an event;
 * this reads them together and says, for each, what happened in a sentence and
 * what can be done about it from here.
 *
 * Built from what exists: open gates (questions — a console request's triage
 * asking what is missing among them), review loops that stopped without
 * agreeing, tasks that failed or were stopped and were not tried again,
 * console requests whose triage failed, a
 * weekly engine update that did not go in, and every health check that is
 * failing — a webhook GitHub is not sending from, a permission the app lacks,
 * a signing key GitHub does not know. See `health/`.
 */

/** How far back a failure is still news. A week-old failure nobody retried is a decision, not a surprise. */
export const ATTENTION_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How long work that landed after it failed is said under "recovered", as a check that passes again is. */
const RECOVERED_FOR_MS = DAY_MS;

export type AttentionKind =
  | 'question'
  | 'review_stalled'
  /** Work sent back that waits for a person: past a send-back limit, or sent to a stage nobody staffs. */
  | 'send_back_held'
  | 'task_failed'
  | 'triage_failed'
  | 'engine_update_failed'
  /** A health check failing: something only a person can do was not done, or has come undone. */
  | 'check_failed'
  /** A check that was failing passes, or OpenADLC fixed something itself: said once, until dismissed. */
  | 'check_fixed'
  /** A pull request green and at the front of the merge line that only a person can land. */
  | 'merge_waiting'
  /** Open unlabeled issues OpenADLC will not take on its own, one item per repository. */
  | 'unowned_issues'
  /** A production promote the bridge holds for a person, where GitHub's plan cannot hold a reviewer. */
  | 'promote_held'
  /** A design took an accepted design memory entry out of effect: a notice, holding nothing, revertible in Settings. */
  | 'design_memory_superseded';

/**
 * What a person can do about an item. The first is the one the console offers
 * first.
 *
 * - `answer` opens the bot's thread ready for an answer in the person's own
 *   words: "Something else…" beside a question's choices, "Answer" for a
 *   question that has none.
 * - `open_thread` opens the bot's thread.
 * - `retry_triage` starts the intake bot on a request again.
 * - `abandon_request` ends a request for good: its triage stops and it is
 *   never started again (`POST /v1/requests/:id/abandon`).
 * - `stop_task` stops a failed or stopped task for good: its session, its
 *   lease and its card go (`POST /v1/tasks/:id/stop`).
 * - `retry_task` runs a failed or stopped task again: the same work, by the
 *   same bot, on the same subject.
 * - `open_url` is GitHub: the pull request, the issue, the question's comment.
 * - `open_page` is a place in the console, such as the engine updates in settings.
 * - `run_command` is the one thing only a shell on OpenADLC's machine can do.
 * - `dismiss` stops the board saying something was fixed.
 * - `dismiss_task` takes a failed task's card off without trying it again.
 * - `recheck` asks a failing health check again now, rather than on its schedule
 *   (`POST /v1/health/checks/:checkId/run`): for a person who has just fixed it.
 */
export type AttentionAction =
  | { kind: 'answer'; label: string; bot: string }
  | { kind: 'open_thread'; label: string; bot: string }
  | { kind: 'retry_triage'; label: string; requestId: string }
  | { kind: 'abandon_request'; label: string; requestId: string }
  | { kind: 'retry_task'; label: string; taskId: string }
  /**
   * Stops a task for good (`POST /v1/tasks/:id/stop`). On a folded card,
   * `taskIds` is every task it stands for, each stopped in turn, and
   * `taskId` the newest of them for a console that reads only that.
   */
  | { kind: 'stop_task'; label: string; taskId: string; taskIds?: string[] }
  | { kind: 'open_url'; label: string; url: string }
  | { kind: 'open_page'; label: string; href: string }
  | { kind: 'run_command'; label: string; command: string }
  | { kind: 'dismiss'; label: string; checkId: string }
  /**
   * Takes a failed or stopped task's card off without running it again, for
   * each task on the card (`POST /v1/tasks/:id/dismiss`). It stays away until
   * a task on it ends again: `occurrence` is when it ended.
   */
  | { kind: 'dismiss_task'; label: string; tasks: { taskId: string; occurrence: string }[] }
  /** Dismisses a notice with nothing to fix until a newer occurrence arrives. */
  | { kind: 'acknowledge'; label: string; checkId: string; occurrence: string }
  /** Opens the steps for an incident the item carries (`incident`): what to do about a post OpenADLC did not sign. */
  | { kind: 'incident'; label: string }
  | { kind: 'recheck'; label: string; checkId: string }
  /**
   * A person's decision about issues OpenADLC will not take on its own
   * (`unowned-issues.ts`): send them to intake, mark them to ignore, or close
   * them. `repo` is the repository's name.
   */
  | { kind: 'unowned_intake' | 'unowned_ignore' | 'unowned_close'; label: string; repo: string; numbers: number[] }
  /**
   * A promote held for a person (`deploy-routes.ts`): release this commit to
   * production, or switch the repository to automatic delivery. `repo` is the
   * repository's name.
   */
  | { kind: 'promote_release' | 'promote_automatic'; label: string; repo: string; sha: string };

export interface HeldPromote {
  repo: string;
  sha: string;
  since: string;
  fileGoverned: boolean;
  /**
   * Why this promote is held, from `deploy_runs.detail`: a sentence of its
   * own, capitalised and ended. The plan is one reason; an unreadable
   * environment is another.
   */
  reason: string;
}

export interface AttentionBot {
  /** The name every address uses: the handle once connected, the seat until then. */
  name: string;
  slot: string | null;
  role: string;
  /** The role in words, `second reviewer`. */
  roleLabel: string;
  githubLogin: string | null;
}

export interface AttentionSubject {
  repo: string | null;
  /** The issue's number, as the board shows it. Null for a request that is not an issue yet. */
  number: number | null;
  title: string | null;
  /** `repo#12`, or null for a request. */
  ref: string | null;
  url: string | null;
  /**
   * The work item it is part of (`items.ts`): `repo#12`, or `request:<id8>`
   * for a request that is not an issue yet, whose `ref` is null. The console
   * opens a work card's item, not the panel of the bot that asked, which held
   * every other subject that bot had worked on. Null for what is about no
   * piece of work — a check on the install, an engine update.
   */
  item?: string | null;
}

/**
 * Whose the item is. `work` is what the crew needs from a person to
 * go on with the issues — a question, a task that failed or stopped, a
 * review that stalled, a request whose triage failed. `system` is what the
 * install needs — a health check, which covers the app's configuration and
 * permissions, sign-ins, repository rules, signing and attribution, and an
 * engine update. Decided here so the console never guesses from a kind.
 */
export type AttentionGroup = 'work' | 'system';

/** Every kind, classified: a new kind does not compile until it is given a group. */
const GROUP: Record<AttentionKind, AttentionGroup> = {
  question: 'work',
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

export function groupOf(kind: AttentionKind): AttentionGroup {
  return GROUP[kind];
}

export interface AttentionItem {
  /**
   * Stable across reads, by kind: `gate:…`, `merge:repo#pr`, `promote:repo@sha`,
   * `unowned:repo`, `stall:repo#pr`, `sendback:repo#n`, `design-memory:…`,
   * `intake-stalled:repo#n`, `task:…`, `landed:…`, `request:…`,
   * `engine-update`, `check:…`, `fixed:…`, or `task-group:…`,
   * `triage-group:…` and `check-group:…` for a folded card.
   */
  id: string;
  kind: AttentionKind;
  /** Work or system; set on every item `attentionItems` returns. */
  group?: AttentionGroup;
  /** What happened, in a line: "The intake bot (ottoexampleco) has a question". */
  headline: string;
  subject: AttentionSubject;
  bot: AttentionBot | null;
  /** When it started waiting. */
  since: string;
  /** One sentence: the question, the reason it stopped. */
  detail: string;
  actions: AttentionAction[];
  /**
   * A question's gate and its choices, the likely answer first, which the
   * console offers as buttons that answer it from the card. No choices is an
   * open question, answered in the person's own words in the bot's thread.
   */
  question?: { gateId: string; options: string[] };
  /**
   * What a question is about: the bot's message just before it, such as the
   * issue intake drafted before "Here's what I'll file. OK?". The card asked
   * to approve a draft it never showed.
   */
  context?: string;
  /** A failing check's: `blocking` stops work, `warning` costs something and lets it go on. */
  severity?: HealthSeverity;
  /**
   * The reason exactly as it arrived — an engine's output, hostd's refusal —
   * behind "Details", when `detail` says it in other words.
   */
  raw?: string;
  /**
   * Every item this one stands for, newest first, when more than one share the
   * same cause — the same check, or the same task kind failing the same way.
   * Absent when it stands alone, so a card with one thing to say is not told
   * to list itself.
   */
  members?: readonly AttentionMember[];
  /**
   * An unsigned crew post, for the steps its sheet walks through: what it
   * was, where, and whether it counted. See `health/checks/attribution.ts`.
   */
  incident?: Record<string, unknown>;
}

/** One of several items folded into a card by `foldCauses`, keeping what is its own rather than the cause's. */
export interface AttentionMember {
  id: string;
  headline: string;
  detail: string;
  subject: AttentionSubject;
  bot: AttentionBot | null;
  since: string;
  actions: AttentionAction[];
  severity?: HealthSeverity;
  raw?: string;
}

interface BotRow {
  id: string;
  name: string;
  slot?: string | null;
  role: string;
  githubLogin: string | null;
  /** The model account it thinks with, which a failure's words name. */
  modelAccountId?: string | null;
}

/** A model account, as the words for a failure on it name it. */
interface AccountRow {
  id: string;
  label: string;
  provider: 'anthropic' | 'openai' | 'xai';
  kind: 'key' | 'subscription';
}

interface RepoRow {
  id: string;
  name: string;
  fullName: string;
  stageModes: Partial<Record<string, string>>;
  /** What a pull request from a build's branch would go into. */
  defaultBranch?: string;
}

interface RequestRow {
  id: string;
  text: string;
  repoId: string | null;
  state: string;
  createdAt: string;
  /** The issue it was filed as, which makes it part of that issue's work item. */
  issueNumber?: number | null;
  /** While queued: how many starts the queue was refused, and why the last one was (`request-queue.ts`). */
  queueAttempts?: number;
  queueReason?: string | null;
  /** When it last changed: for one the queue gave up on, its last refusal. */
  updatedAt?: string;
}

type GateRow = Pick<Gate, 'id' | 'taskId' | 'question' | 'options' | 'githubCommentUrl' | 'createdAt' | 'context'>;
type AskedGate = Pick<Gate, 'id' | 'taskId' | 'answer' | 'answeredAt' | 'createdAt'>;

export interface AttentionInput {
  now: Date;
  gates: readonly GateRow[];
  /** With a build's branch, which a build that ended without its pull request is opened from. */
  tasks: readonly (TaskFacts & { branch?: string | null })[];
  bots: readonly BotRow[];
  repos: readonly RepoRow[];
  issues: readonly IssueFacts[];
  requests: readonly RequestRow[];
  stallEvents: readonly { at: string; payload: unknown }[];
  /** Send-backs refused at a limit, or sent to a stage nobody staffs (`send-back.ts`). Absent, none. */
  sendBackEvents?: readonly { at: string; type: string; payload: unknown }[];
  /** Design memory entries a design superseded (`design-memory.ts`), in the window. Absent, none. */
  designMemoryEvents?: readonly { at: string; payload: unknown }[];
  /** Issues intake stopped trying, newest first (`StageHandoff.intakeGaveUp`). Absent, none. */
  intakeStalls?: readonly { at: string; payload: unknown }[];
  /** The last weekly engine update, when it failed. */
  engineUpdate?: EngineUpdateAttention | null;
  /**
   * Pull requests the merge line holds for a person, and why (`heldForPerson`).
   * The board called one "Merging" and Needs you said nothing, so an approved,
   * green pull request waited with nobody told.
   */
  heldMerges?: readonly { repo: string; prNumber: number; reason: string; since: string }[];
  /**
   * Open unlabeled issues OpenADLC will not take on its own, by repository
   * name (`unowned-issues.ts`): skipped in silence, they sat unbuilt and in the
   * way of every request that touched their files.
   */
  unowned?: Readonly<Record<string, readonly { number: number; title: string; url: string; author: string | null }[]>>;
  /**
   * Promotes the bridge holds for a person (`DeployPipeline`): the rules say a
   * person approves production, and GitHub is not holding a reviewer.
   * `reason` is why this one is held. `fileGoverned` when
   * `.github/fleetadlc.yml` sets the rules, which only an edit of that file
   * changes.
   */
  heldPromotes?: readonly HeldPromote[];
  /** What the health checks last said. See `health/`. */
  health?: readonly HealthRow[];
  /**
   * What a person has dismissed, by health row id, or `task:<id>` for a
   * dismissed task card: every occurrence covered so far.
   */
  acknowledged?: ReadonlyMap<string, ReadonlySet<string>>;
  /** The model accounts, so a failure on one names it. */
  accounts?: readonly AccountRow[];
  /**
   * The issues and pull requests GitHub says are closed, by ref: a merged
   * pull request is one. A failed task on one of them holds nothing up.
   */
  closed?: ReadonlySet<string>;
  /**
   * Whether this install deploys merged work to testing (the deprecated
   * `FLEETADLC_TESTING_URL` is set), for a task with no repository only:
   * a task on a repository goes by `shipsByMerging`. The variable is empty on
   * an install whose repositories declare their own testing deploy, and read
   * first it folded every failed QA on a merged pull request into a notice.
   * Absent is read as yes, so its cards stay.
   */
  testingDeploy?: boolean;
  /**
   * The repositories, by id, where merging is shipping: no testing deploy in
   * `.github/fleetadlc.yml` or Settings, or Automatic with no `deploy-testing`
   * workflow (see `deploys.ts`). A deploy or QA task there has nothing to
   * reach once its pull request merged. A repository that could not be told
   * is left out, so its cards stay.
   */
  shipsByMerging?: ReadonlySet<string>;
  /**
   * The questions the ended tasks asked, answered or not, so an end that followed a
   * person's "stop here" is read as theirs.
   */
  asked?: readonly AskedGate[];
  /**
   * Titles of issues and pull requests the board has no row for — a pull
   * request whose issue it does not know — read from GitHub, by ref.
   */
  titles?: ReadonlyMap<string, SubjectTitle>;
  /**
   * The repositories removed from OpenADLC. Nothing in one is a person's to act
   * on any more, so none of its questions, failures or stalls is an item.
   */
  removed?: readonly { id: string; name: string }[];
}

/**
 * The input without anything in a repository removed from OpenADLC. Removing
 * one stops its work and closes its questions, and a task stopped that way
 * would otherwise be a "was stopped before finishing" card about a
 * repository that is gone; so would a question whose task could not be
 * stopped, and a stall on one of its pull requests.
 */
function withoutRemoved(input: AttentionInput): AttentionInput {
  if (!input.removed || input.removed.length === 0) return input;
  const ids = new Set(input.removed.map((repo) => repo.id));
  const names = new Set(input.removed.map((repo) => repo.name));
  const requestsGone = new Set(input.requests.filter((one) => one.repoId && ids.has(one.repoId)).map((one) => `request:${one.id.slice(0, 8)}`));
  const gone = (task: TaskFacts): boolean =>
    (task.repoId !== null && ids.has(task.repoId)) ||
    names.has(parseRef(task.subjectRef)?.repo ?? '') ||
    requestsGone.has(task.subjectRef);
  const goneTasks = new Set(input.tasks.filter(gone).map((task) => task.id));
  return {
    ...input,
    tasks: input.tasks.filter((task) => !goneTasks.has(task.id)),
    gates: input.gates.filter((gate) => !gate.taskId || !goneTasks.has(gate.taskId)),
    issues: input.issues.filter((issue) => !ids.has(issue.repoId)),
    requests: input.requests.filter((one) => !one.repoId || !ids.has(one.repoId)),
    stallEvents: input.stallEvents.filter((event) => !names.has(stallFrom(event)?.repo ?? '')),
    // Its webhooks are ignored once it is removed, so the line never hears the
    // pull request merge or close, and the card had no button to act on it.
    heldMerges: input.heldMerges?.filter((held) => !names.has(held.repo)),
  };
}

/**
 * The input without the issues labelled `fleetadlc:ignore`, their pull
 * requests, the requests they were filed from, and the tasks and questions on
 * any of them (`ignoredSubjects`). Taken out before anything is folded, so a
 * folded card never counts one; whatever else names one of their subjects is
 * left out of the items at the end.
 */
function withoutIgnored(input: AttentionInput): { input: AttentionInput; ignored: ReadonlySet<string> } {
  const ignored = ignoredSubjects(input.issues);
  if (ignored.size === 0) return { input, ignored };
  const repoNames = new Map(input.repos.map((repo) => [repo.id, repo.name]));
  const filedAsIgnored = (request: RequestRow): boolean =>
    request.issueNumber != null && request.repoId !== null && ignored.has(`${repoNames.get(request.repoId) ?? ''}#${request.issueNumber}`);
  const requestsGone = new Set(input.requests.filter(filedAsIgnored).map((one) => `request:${one.id.slice(0, 8)}`));
  const goneTasks = new Set(input.tasks.filter((task) => ignored.has(task.subjectRef) || requestsGone.has(task.subjectRef)).map((task) => task.id));
  return {
    ignored,
    input: {
      ...input,
      tasks: input.tasks.filter((task) => !goneTasks.has(task.id)),
      gates: input.gates.filter((gate) => !gate.taskId || !goneTasks.has(gate.taskId)),
      issues: input.issues.filter((issue) => !ignored.has(`${issue.repoName}#${issue.number}`)),
      requests: input.requests.filter((one) => !filedAsIgnored(one)),
      heldMerges: input.heldMerges?.filter((held) => !ignored.has(`${held.repo}#${held.prNumber}`)),
    },
  };
}

function asAttentionBot(bot: BotRow | undefined): AttentionBot | null {
  if (!bot) return null;
  return {
    name: bot.name,
    slot: bot.slot ?? null,
    role: bot.role,
    roleLabel: roleLabel(bot.role as BotRole) ?? bot.role,
    githubLogin: bot.githubLogin,
  };
}

/** What a task of each kind was doing, for "could not finish …". */
const WORK: Record<TaskKind, string> = {
  intake: 'triage',
  request: 'triage',
  spec: 'the design',
  implement: 'the change',
  patch: 'the fix',
  review: 'its review',
  deploy: 'the deploy',
  qa: 'the checks',
};

/**
 * A task's reason for stopping, as one sentence a person reads: the first
 * sentence of it, without the plumbing it arrived through.
 */
export function shortReason(reason: string | null | undefined): string {
  const text = (reason ?? '').trim().replace(/^hostd refused:\s*/i, '');
  if (!text) return NO_REASON;
  const sentence = /^([\s\S]+?[.!?])(?:\s|$)/.exec(text)?.[1] ?? text;
  const capped = sentence.length > 180 ? `${sentence.slice(0, 177).trimEnd()}…` : sentence;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}

function firstLine(text: string, max = 90): string {
  const line = (text.split('\n')[0] ?? '').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function sentenceCase(text: string): string {
  const trimmed = text.trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

const STAGE_ORDER: readonly string[] = STAGE_KEYS;

/**
 * Tasks that ended without finishing: failed, or stopped under them by OpenADLC
 * — a restart, a container that went. Nothing runs either again on its own.
 */
const ENDED_UNFINISHED: readonly TaskFacts['state'][] = ['failed', 'stopped'];

/**
 * What the exit reason of a task a person stopped from the console starts
 * with (`POST /v1/tasks/:id/stop`). A person decided that work is over, so it
 * is no card: one saying it "was stopped before finishing", offering to try
 * again, is what lingered after the stop it records.
 *
 * It begins with `STOPPED_BY_PERSON` in `@fleetadlc/db`'s task store, "stopped by a
 * person", so the deploy sweep (`stoppedOnPurpose`) does not start again a
 * deploy a person stopped here either.
 */
export const STOPPED_BY_A_PERSON = 'stopped by a person from the console';

/**
 * Whether a person ended the task: they stopped it, from its card or its
 * thread, or an answer of theirs ended it (a refused plan change, abandoning
 * it at its cost cap, an answer on work that had already landed).
 *
 * Every stop a person made starts with `tasks.STOPPED_BY_PERSON`. The Stop in
 * a bot's thread kills its session, and hostd writes `stopped by a person
 * (who): its session was killed`. Only the card's own Stop was read as a
 * person's, so stopping the second reviewer on a merged issue from its thread
 * left a "was stopped before finishing" card.
 */
function stoppedByAPerson(task: Pick<TaskFacts, 'state' | 'exitReason'>): boolean {
  return task.state === 'stopped' && (Boolean(task.exitReason?.startsWith(tasks.STOPPED_BY_PERSON)) || wasRefused(task.exitReason));
}

/** A model account's spending limit at the provider, as its refusal says it. */
const SPEND_LIMIT = /\bspend(?:ing)? limit\b|\busage limit\b|credit balance is too low/i;

/**
 * What a failure was about, when it is about something outside the work that
 * a later task shows is fixed: the model account the bot thinks with (its
 * spending limit, its sign-in, its key), or the bot's own GitHub sign-in.
 * Null for a failure of the work itself.
 */
function causeOutside(reason: string | null, action: { href?: string } | null): 'account' | 'bot' | null {
  if (SPEND_LIMIT.test(reason ?? '') || action?.href === ACCOUNTS_STEP) return 'account';
  if (action?.href === RECONNECT) return 'bot';
  return null;
}

/**
 * An answer that tells a bot to stop where it is: "stop", "no, stop here",
 * "leave it unposted", "leave this merge undeployed", "cancel", "abandon",
 * "don't post". An SRE told to stop on five merged issues in a row had its
 * session end under it each time, and each end came back as "was stopped
 * before finishing".
 *
 * Only at the start of the answer, after a "yes,", "no," or the option's
 * number: "Go on, but stop before production" tells it to go on. Matched
 * anywhere, "Leave it held" read as a stop.
 */
// One run of spaces and punctuation after the "yes", not two side by side: two
// unbounded runs made a long answer that did not match backtrack for seconds,
// on every read of Needs you, with the bridge's event loop held.
const STOP_ANSWER = new RegExp(
  String.raw`^\s*(?:(?:yes|no|ok(?:ay)?|\d+)\b[\s,.:;—–-]*)?(?:please\s+)?` +
    String.raw`(?:stop\b|cancel\b|abandon\b|leave (?:it|this|that|them)\b[^.;]*?\bun[a-z]+ed\b|(?:don[’']?t|do not) (?:post|deploy|merge|continue|go on)\b)`,
  'i',
);

/** An answer that goes on, however it starts: "Don't stop", "Cancel the old run and try again". */
const GO_ON_ANSWER = /\b(?:don[’']?t|do not|not|never) stop\b|\bkeep going\b|\bcarry on\b|\btry (?:it )?again\b|\bretry\b/i;

/**
 * How hostd's observer ends a task whose session went away under it
 * (`apps/hostd/src/observer.ts`). The session a stop answer ended is one; a
 * task that failed on its own error is not, and keeps its card.
 */
const SESSION_KILLED = 'the session was killed';

/** How long after a person's answer an end is still the one it asked for, rather than something later. */
const ANSWER_ENDS_WITHIN_MS = 60 * 60 * 1000;

/**
 * Whether the last question a task asked was answered with a stop, shortly
 * before the task ended: the person ended it, whatever the session's end
 * says. A later question the task asked, answered or not, is a turn the
 * answer did not end.
 */
function endedByAnswer(task: TaskFacts, ended: number, asked: readonly AskedGate[]): boolean {
  // A failure is news whatever the answer said: one "stop without posting"
  // was followed by hostd refusing the resume, a fault of OpenADLC's.
  if (!endedBySessionKill(task)) return false;
  const own = asked.filter((gate) => gate.taskId === task.id);
  const last = own.reduce<AskedGate | null>(
    (latest, gate) => (!latest || Date.parse(gate.createdAt ?? '') > Date.parse(latest.createdAt ?? '') ? gate : latest),
    null,
  );
  if (!last?.answer || !last.answeredAt || !STOP_ANSWER.test(last.answer) || GO_ON_ANSWER.test(last.answer)) return false;
  const at = Date.parse(last.answeredAt);
  return at <= ended && ended - at <= ANSWER_ENDS_WITHIN_MS;
}

/** Stopped because its session went away, which is how a session a stop answer ended looks. */
function endedBySessionKill(task: Pick<TaskFacts, 'state' | 'exitReason'>): boolean {
  return task.state === 'stopped' && Boolean(task.exitReason?.startsWith(SESSION_KILLED));
}

const EMPTY_SUBJECT: AttentionSubject = { repo: null, number: null, title: null, ref: null, url: null };

/**
 * A failure's sentence with the one bot it names taken out, so the same cause
 * on two bots reads the same and folds into one card. Without this, "GitHub no
 * longer accepts ottoexampleco's sign-in" and the same sentence about a
 * second bot never match, and a card repeats itself once per bot it happened to.
 */
function causeOf(sentence: string, bot: BotRow | undefined): string {
  let text = sentence;
  for (const name of [botSaid(bot), botInWords(bot), bot?.name].filter((value): value is string => Boolean(value))) {
    text = text.split(name).join('\u0000');
  }
  return text;
}

/**
 * A fold key for a failure with a sentence: two failures with the same key
 * are the same cause. `NO_REASON` says nothing about why, so an
 * unknown cause is not treated as a shared one — each keeps `ownId`, which
 * keeps it off every other unexplained failure's card.
 */
function causeKey(prefix: string, sentence: string, bot: BotRow | undefined, ownId: string): string {
  const cause = causeOf(sentence, bot);
  return sentence === NO_REASON ? `${prefix}:${cause}:${ownId}` : `${prefix}:${cause}`;
}

/**
 * Whether a failure's action names the one bot it is for — "Reconnect
 * irisexampleco" — rather than something that clears every bot with the same
 * cause at once — "Sign in again", "Run fleetadlc up". Only the second kind is
 * worth lifting to a card that speaks for several bots; the first has to stay
 * with the bot it is about, or the card would offer to fix one and call it done.
 */
function namesBot(action: AttentionAction, bot: BotRow | undefined): boolean {
  if (!('label' in action)) return false;
  return [botSaid(bot), botInWords(bot), bot?.name].filter((value): value is string => Boolean(value)).some((name) => action.label.includes(name));
}

/** One thing to fold several items under one cause: its own words, and the fix it shares with the rest, if any. */
interface CauseCandidate {
  /** Items with the same key are the same cause: found the same way, said the same way once the one bot in it is taken out. */
  key: string;
  /** A fix that clears every member at once — a sign-in, a permission — rather than one of theirs alone. Null when there is none. */
  sharedAction: AttentionAction | null;
  /**
   * The way to ask the cause again once somebody has dealt with it, offered
   * once on the card after its fixes: the members of a folded card share it,
   * so it is not repeated under each of them.
   */
  recheck?: AttentionAction;
  member: AttentionMember;
}

/** When a task ended, or the nearest thing to it it has. */
function taskEndedAt(task: TaskFacts): number {
  return Date.parse(task.endedAt ?? task.startedAt ?? task.createdAt);
}

/** Which end of a task a dismissal was for. */
function taskOccurrence(task: TaskFacts): string {
  return new Date(taskEndedAt(task)).toISOString();
}

/**
 * The tasks that failed, or that OpenADLC stopped under them, that may still
 * be a card: in the window, not stopped by a person or by their answer, not
 * tried again, not past their stage, not dismissed. Whether each one's subject
 * has closed is what decides the rest, and GitHub is asked that only for these.
 */
export function failedTaskCandidates(input: AttentionInput): AttentionInput['tasks'] {
  const windowStart = input.now.getTime() - ATTENTION_WINDOW_DAYS * DAY_MS;
  return input.tasks.filter((task) => {
    if (!ENDED_UNFINISHED.includes(task.state) || taskEndedAt(task) < windowStart) return false;
    if (stoppedByAPerson(task)) return false;
    if (endedByAnswer(task, taskEndedAt(task), input.asked ?? [])) return false;
    // A request's triage is its own item below, with a way to try again.
    if (task.subjectRef.startsWith('request:')) return false;
    if (triedAgain(task, input.tasks)) return false;
    const issue = issueForSubject(task.subjectRef, input.issues);
    // The card has moved past the stage this work was for: whatever failed no
    // longer holds anything up.
    if (issue && STAGE_ORDER.indexOf(issue.stage) > STAGE_ORDER.indexOf(stageOfTask(task.kind))) return false;
    return !(input.acknowledged?.get(`task:${task.id}`)?.has(taskOccurrence(task)) ?? false);
  });
}

/**
 * Items that share a cause, folded into one card that lists every one of them.
 * A cause with a single member is unchanged — its own id, headline and
 * actions — so nothing already reading one bot's card notices the difference.
 * A cause with more than one keeps the newest member's words, says how many
 * more there are, and offers the shared fix, if the cause has one, instead of
 * a button for a member the card no longer shows on its own.
 */
function foldCauses(kind: AttentionKind, groupPrefix: string, candidates: readonly CauseCandidate[]): AttentionItem[] {
  const byKey = new Map<string, CauseCandidate[]>();
  for (const candidate of candidates) {
    const group = byKey.get(candidate.key) ?? [];
    group.push(candidate);
    byKey.set(candidate.key, group);
  }

  const items: AttentionItem[] = [];
  for (const group of byKey.values()) {
    const members = group
      .map((candidate) => candidate.member)
      .sort((a, b) => Date.parse(b.since) - Date.parse(a.since) || a.id.localeCompare(b.id));
    const newest = members[0]!;
    const base = {
      kind,
      subject: newest.subject,
      bot: newest.bot,
      since: newest.since,
      detail: newest.detail,
      ...(newest.severity ? { severity: newest.severity } : {}),
      ...(newest.raw ? { raw: newest.raw } : {}),
    };

    if (members.length === 1) {
      const sharedAction = group[0]!.sharedAction;
      const recheck = group[0]!.recheck;
      items.push({
        id: newest.id,
        headline: newest.headline,
        actions: [...(sharedAction ? [sharedAction] : []), ...newest.actions, ...(recheck ? [recheck] : [])],
        ...base,
      });
      continue;
    }

    const sharedAction = group.find((candidate) => candidate.sharedAction)?.sharedAction ?? null;
    const recheck = group.find((candidate) => candidate.recheck)?.recheck;
    items.push({
      id: `${groupPrefix}:${members.map((member) => member.id).join(',')}`,
      headline: `${newest.headline} (+${members.length - 1} more)`,
      actions: [...(sharedAction ? [sharedAction] : []), ...(recheck ? [recheck] : [])],
      members,
      ...base,
    });
  }
  return items;
}

export function attentionItems(given: AttentionInput): AttentionItem[] {
  const { input, ignored } = withoutIgnored(withoutRemoved(given));
  const botsById = new Map(input.bots.map((bot) => [bot.id, bot]));
  const reposById = new Map(input.repos.map((repo) => [repo.id, repo]));
  const reposByName = new Map(input.repos.map((repo) => [repo.name, repo]));
  const tasksById = new Map(input.tasks.map((task) => [task.id, task]));
  const pullUrl = (repoName: string, number: number | null): string | null => {
    const repo = reposByName.get(repoName);
    return repo && number ? `https://github.com/${repo.fullName}/pull/${number}` : null;
  };

  const itemFacts = {
    issues: input.issues,
    repos: input.repos,
    requests: input.requests.map((one) => ({ ...one, issueNumber: one.issueNumber ?? null })),
  };
  /** The work item a subject is part of; the subject itself when no item names it. */
  const itemFor = (subjectRef: string): string | null => itemOf(subjectRef, itemFacts)?.key ?? (subjectRef || null);

  /** The issue a subject is about, as the card that shows it would name it. */
  const subjectOf = (subjectRef: string): { subject: AttentionSubject; prUrl: string | null } => {
    const { subject, prUrl } = subjectWithoutItem(subjectRef);
    return { subject: { ...subject, item: itemFor(subjectRef) }, prUrl };
  };
  const subjectWithoutItem = (subjectRef: string): { subject: AttentionSubject; prUrl: string | null } => {
    if (subjectRef.startsWith('request:')) {
      const prefix = subjectRef.slice('request:'.length);
      // A prefix two requests share names neither: say nothing of which it is.
      const matches = input.requests.filter((one) => one.id.startsWith(prefix));
      const request = matches.length === 1 ? matches[0] : undefined;
      const repo = request?.repoId ? reposById.get(request.repoId) : undefined;
      return {
        subject: { repo: repo?.name ?? null, number: null, title: request ? firstLine(request.text) : null, ref: null, url: null },
        prUrl: null,
      };
    }
    const issue = issueForSubject(subjectRef, input.issues);
    if (issue) {
      return {
        subject: {
          repo: issue.repoName,
          number: issue.number,
          title: issue.title,
          ref: `${issue.repoName}#${issue.number}`,
          url: issue.url,
        },
        prUrl: pullUrl(issue.repoName, issue.prNumber),
      };
    }
    const parsed = parseRef(subjectRef);
    const repo = parsed ? reposByName.get(parsed.repo) : undefined;
    // A pull request whose issue the board does not know is named by its own
    // title, read from GitHub, rather than left a bare number.
    const read = input.titles?.get(subjectRef);
    return {
      subject: {
        repo: parsed?.repo ?? null,
        number: parsed?.number ?? null,
        title: read?.title ?? null,
        ref: subjectRef,
        // GitHub sends /issues/N on to /pull/N when N is a pull request.
        url: read?.url ?? (repo && parsed ? `https://github.com/${repo.fullName}/issues/${parsed.number}` : null),
      },
      prUrl: read?.pullRequest ? (read.url ?? null) : null,
    };
  };

  const accountOf = (bot: BotRow | undefined): AccountRow | null =>
    (bot?.modelAccountId ? input.accounts?.find((one) => one.id === bot.modelAccountId) : undefined) ?? null;
  // Where the app's permissions are added, which a refusal naming one links to.
  const permissionsUrl =
    (input.health ?? [])
      .map((row) => row.facts.permissionsUrl)
      .find((url): url is string => typeof url === 'string') ?? null;

  const items: AttentionItem[] = [];

  // Open gates: a bot's question.
  for (const gate of input.gates) {
    const task = gate.taskId ? tasksById.get(gate.taskId) : undefined;
    const bot = task ? botsById.get(task.botId) : undefined;
    const { subject } = task ? subjectOf(task.subjectRef) : { subject: EMPTY_SUBJECT };
    const since = gate.createdAt ?? task?.startedAt ?? task?.createdAt ?? input.now.toISOString();

    // A choice answers from the card; anything else is said in the thread.
    const actions: AttentionAction[] = [];
    if (bot) actions.push({ kind: 'answer', label: gate.options.length > 0 ? 'Something else…' : 'Answer', bot: bot.name });
    if (gate.githubCommentUrl) actions.push({ kind: 'open_url', label: 'On GitHub', url: gate.githubCommentUrl });
    items.push({
      id: `gate:${gate.id}`,
      kind: 'question',
      headline: `${botSaid(bot)} has a question`,
      subject,
      bot: asAttentionBot(bot),
      since,
      detail: gate.question,
      actions,
      question: { gateId: gate.id, options: gate.options },
      ...(gate.context?.trim() ? { context: gate.context.trim() } : {}),
    });
  }

  // Approved and green, at the front of the line, and only a person can land it.
  for (const held of input.heldMerges ?? []) {
    const { subject } = subjectOf(`${held.repo}#${held.prNumber}`);
    const fullName = reposByName.get(held.repo)?.fullName ?? null;
    const url = fullName ? `https://github.com/${fullName}/pull/${held.prNumber}` : null;
    items.push({
      id: `merge:${held.repo}#${held.prNumber}`,
      kind: 'merge_waiting',
      headline: `Pull request #${held.prNumber} is ready, and waits for you to merge it`,
      subject: { ...subject, url: subject.url ?? url },
      bot: null,
      since: held.since,
      detail: `Its reviews passed and CI is green. OpenADLC did not merge it, because ${held.reason}.`,
      actions: url ? [{ kind: 'open_url', label: 'Merge it on GitHub', url }] : [],
    });
  }

  // Promotes held for a person where GitHub cannot hold a production reviewer.
  for (const held of input.heldPromotes ?? []) {
    const repo = reposByName.get(held.repo);
    if (!repo) continue;
    const short = held.sha.slice(0, 7);
    const actions: AttentionAction[] = [{ kind: 'promote_release', label: 'Release to production', repo: held.repo, sha: held.sha }];
    actions.push(
      held.fileGoverned
        ? { kind: 'open_url', label: 'Switch to automatic in .github/fleetadlc.yml', url: rulesFileEditUrl({ fullName: repo.fullName, defaultBranch: repo.defaultBranch ?? 'main' }) }
        : { kind: 'promote_automatic', label: 'Switch to automatic delivery', repo: held.repo, sha: held.sha },
    );
    items.push({
      id: `promote:${held.repo}@${held.sha}`,
      kind: 'promote_held',
      headline: `${held.repo}@${short} waits for you to release it to production`,
      subject: { repo: held.repo, number: null, title: null, ref: null, url: `https://github.com/${repo.fullName}/commit/${held.sha}` },
      bot: null,
      since: held.since,
      detail:
        `Its smoke passed on testing. ${held.repo}'s delivery rules say a person approves each production deploy. ` +
        `${held.reason || 'Why this one is held was not recorded.'} ` +
        'OpenADLC holds the promote until you release it. Or switch the repository to automatic ' +
        'delivery: a soak on testing, the smoke, and an automatic rollback if production fails.',
      actions,
    });
  }

  // Issues nobody labelled whose author OpenADLC does not act for: a person
  // decides, since the sweep will not on its own. One item per repository.
  for (const [repoName, list] of Object.entries(input.unowned ?? {})) {
    if (list.length === 0 || !reposByName.has(repoName)) continue;
    const numbers = list.map((one) => one.number);
    const authors = [...new Set(list.map((one) => one.author).filter((one): one is string => Boolean(one)))];
    const named = list.map((one) => `#${one.number} ${one.title}`).join('; ');
    items.push({
      id: `unowned:${repoName}`,
      kind: 'unowned_issues',
      headline: `${repoName}: ${list.length === 1 ? '1 issue' : `${list.length} issues`} OpenADLC won’t take on its own`,
      subject: { repo: repoName, number: null, title: null, ref: null, url: null },
      bot: null,
      since: input.now.toISOString(),
      detail:
        `${named}. ${list.length === 1 ? 'Its author' : 'Their authors'}${authors.length > 0 ? ` (${authors.map((one) => `@${one}`).join(', ')})` : ''} ` +
        `${list.length === 1 && authors.length <= 1 ? 'has' : 'have'} no access to the repository, so OpenADLC does not send ${list.length === 1 ? 'it' : 'them'} to intake on its own, ` +
        `and leaves ${list.length === 1 ? 'it' : 'them'} out of the overlap check until you decide.`,
      actions: [
        { kind: 'unowned_intake', label: 'Send to intake', repo: repoName, numbers },
        { kind: 'unowned_ignore', label: 'Ignore', repo: repoName, numbers },
        { kind: 'unowned_close', label: 'Close', repo: repoName, numbers },
      ],
    });
  }

  // Review loops that stopped without the reviewers agreeing.
  for (const [key, stall] of standingStalls(input.stallEvents, input.issues, input.tasks)) {
    const bot =
      (stall.botId ? botsById.get(stall.botId) : undefined) ??
      input.bots.find((one) => one.name === stall.bot || one.slot === stall.bot);
    const { subject } = subjectOf(stall.issue ? `${stall.repo}#${stall.issue}` : key);
    const prUrl = pullUrl(stall.repo, stall.pr);
    const actions: AttentionAction[] = [];
    if (prUrl) actions.push({ kind: 'open_url', label: 'Decide on GitHub', url: prUrl });
    if (bot) actions.push({ kind: 'open_thread', label: 'Open thread', bot: bot.name });
    const held = stall.heldBy.length > 0 ? stall.heldBy.join(' and ') : null;
    items.push({
      id: `stall:${key}`,
      kind: 'review_stalled',
      headline: held
        ? `Review stopped: ${held} still ${stall.heldBy.length === 1 ? 'asks' : 'ask'} for changes`
        : stall.rounds > 0
          ? `Review stopped after ${stall.rounds} ${stall.rounds === 1 ? 'round' : 'rounds'}`
          : 'Review stopped without agreeing',
      subject,
      bot: asAttentionBot(bot),
      since: stall.at,
      detail: held
        ? `${held} ${stall.heldBy.length === 1 ? 'is' : 'are'} blocking and still ${stall.heldBy.length === 1 ? 'asks' : 'ask'} for changes; the lead approved. ` +
          'Nothing sends the work back, so it waits for you: answer its findings, ask it to review again, or dismiss its review on GitHub.'
        : stall.reason
          ? `It was sent back to build, but nothing could take it: ${stall.reason}. Fix it on the branch, dismiss the review on GitHub, or move the card.`
          : 'The reviewers still ask for changes. Merge it anyway, send it back to design, or take the branch yourself.',
      actions,
    });
  }

  // Work sent back that a person has to take: refused at a send-back limit,
  // or gone back to a stage nobody staffs. Both put `needs-human` on the
  // issue, and the card stands while it is there, the newest one per issue.
  // Every question puts needs-human on too, so the label alone brought back a
  // send-back a person had dealt with days before, telling them to take off
  // the label that now held the open question. The card also needs the issue
  // still where the send-back left it, and no question asked on it since.
  const held = new Map<string, { at: string; stalled: boolean; payload: Record<string, unknown> }>();
  for (const event of input.sendBackEvents ?? []) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (typeof payload.repo !== 'string' || typeof payload.issue !== 'number') continue;
    const key = `${payload.repo}#${payload.issue}`;
    const seen = held.get(key);
    if (!seen || Date.parse(event.at) > Date.parse(seen.at)) held.set(key, { at: event.at, stalled: event.type === SEND_BACK_STALLED, payload });
  }
  for (const [key, one] of held) {
    const issue = input.issues.find((entry) => `${entry.repoName}#${entry.number}` === key);
    if (!issue || !issue.labels.includes('needs-human')) continue;
    // Refused, it stays where it was; sent to a stage nobody staffs, it went there.
    const leftIn = one.stalled ? one.payload.from : one.payload.to;
    if (typeof leftIn === 'string' && issue.stage !== leftIn) continue;
    const onIt = new Set([key, ...(issue.prNumber ? [`${issue.repoName}#${issue.prNumber}`] : [])]);
    const askedSince = input.gates.some((gate) => {
      const task = gate.taskId ? tasksById.get(gate.taskId) : undefined;
      return task !== undefined && onIt.has(task.subjectRef) && Date.parse(gate.createdAt ?? '') > Date.parse(one.at);
    });
    if (askedSince) continue;
    const to = typeof one.payload.to === 'string' ? one.payload.to : '';
    const by = typeof one.payload.by === 'string' ? one.payload.by : 'a bot';
    const bot = input.bots.find((entry) => entry.name === by || entry.slot === by);
    const actions: AttentionAction[] = [];
    if (issue.url) actions.push({ kind: 'open_url', label: 'Decide on GitHub', url: issue.url });
    if (bot) actions.push({ kind: 'open_thread', label: 'Open thread', bot: bot.name });
    items.push({
      id: `sendback:${key}`,
      kind: 'send_back_held',
      headline: one.stalled ? 'Sent back too many times' : `Sent back to ${STAGE_COLUMN_TITLES[to as StageKey] ?? to}, which nobody staffs`,
      subject: subjectOf(key).subject,
      bot: asAttentionBot(bot),
      since: one.at,
      // The reason is the bot's free text: a full stop of its own would be doubled.
      detail: `${by}: ${typeof one.payload.reason === 'string' ? (one.payload.reason.split('\n')[0] ?? '').replace(/[.!?]+\s*$/, '') : 'no reason given'}. ${
        one.stalled ? 'Decide where it goes, then take needs-human off.' : 'Take it from here, then take needs-human off.'
      }`,
      actions,
    });
  }

  // A design superseded what the repository had decided. Accepted with nobody
  // asked, so it is said here as well as on the issue, with where to revert
  // it. A notice: it holds nothing, and leaves with the window.
  for (const event of input.designMemoryEvents ?? []) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (typeof payload.repo !== 'string' || typeof payload.issue !== 'number') continue;
    const key = `${payload.repo}#${payload.issue}`;
    const replaced = (Array.isArray(payload.replaced) ? payload.replaced : []) as { title?: unknown; byTitle?: unknown }[];
    const said = replaced
      .filter((one) => typeof one.title === 'string')
      .map((one) => (typeof one.byTitle === 'string' ? `“${one.byTitle}” replaces “${one.title}”` : `“${one.title}” was replaced`));
    const actions: AttentionAction[] = [];
    if (typeof payload.commentUrl === 'string' && payload.commentUrl) actions.push({ kind: 'open_url', label: 'On GitHub', url: payload.commentUrl });
    actions.push({ kind: 'open_page', label: 'Design memory', href: `/settings/repositories/${encodeURIComponent(payload.repo)}#${payload.repo}-memory` });
    items.push({
      id: `design-memory:${key}:${event.at}`,
      kind: 'design_memory_superseded',
      headline: `The design memory of ${payload.repo} changed`,
      subject: subjectOf(key).subject,
      bot: null,
      since: event.at,
      detail: `${said.join('; ') || 'An entry was replaced'}${typeof payload.by === 'string' ? `, as ${payload.by}` : ''}. Nothing waits on this; revert it in Settings if it is wrong.`,
      actions,
    });
  }

  // Issues intake stopped trying (`StageHandoff.intakeGaveUp`), while they are
  // still in intake: the sweep would have triaged them every hour for good.
  const stalledIntake = new Map<string, { at: string; tries: number }>();
  for (const event of input.intakeStalls ?? []) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (typeof payload.subjectRef !== 'string' || stalledIntake.has(payload.subjectRef)) continue;
    stalledIntake.set(payload.subjectRef, { at: event.at, tries: typeof payload.tries === 'number' ? payload.tries : 2 });
  }
  for (const [key, one] of stalledIntake) {
    const issue = input.issues.find((entry) => `${entry.repoName}#${entry.number}` === key);
    if (!issue || issue.stage !== 'intake' || hasIgnoreLabel(issue.labels)) continue;
    items.push({
      id: `intake-stalled:${key}`,
      kind: 'triage_failed',
      headline: `Intake could not shape ${key}`,
      subject: subjectOf(key).subject,
      bot: null,
      since: one.at,
      detail: `It ran ${one.tries} times and left the issue in intake each time, so it stopped trying. Answer what it asked on the issue, move it on the board yourself, or label it fleetadlc:ignore.`,
      actions: issue.url ? [{ kind: 'open_url', label: 'Open the issue', url: issue.url }] : [],
    });
  }

  const windowStart = input.now.getTime() - ATTENTION_WINDOW_DAYS * DAY_MS;
  const endedAt = taskEndedAt;
  const occurrenceOf = taskOccurrence;

  /**
   * Whether a task after this one, on the same model account (or by the same
   * bot, for its GitHub sign-in), got going without failing the same way:
   * whatever stopped this one has been dealt with. A spend limit hit at
   * night stood on the board all day after work resumed.
   */
  const causeGone = (failed: TaskFacts, cause: 'account' | 'bot'): boolean => {
    const account = cause === 'account' ? (botsById.get(failed.botId)?.modelAccountId ?? null) : null;
    const sameCause = (other: TaskFacts): boolean =>
      other.botId === failed.botId || (account !== null && botsById.get(other.botId)?.modelAccountId === account);
    return input.tasks.some((other) => {
      if (other.id === failed.id || !other.startedAt || Date.parse(other.startedAt) <= endedAt(failed) || !sameCause(other)) return false;
      if (!ENDED_UNFINISHED.includes(other.state)) return true;
      const otherBot = botsById.get(other.botId);
      const again = explainFailure(other.exitReason, { bot: botInWords(otherBot), account: accountOf(otherBot), permissionsUrl });
      return causeOutside(other.exitReason, again.action as { href?: string } | null) !== cause;
    });
  };

  /** Whether a task on the same subject started after this one ended: the work was taken up again. */
  const movedOn = (failed: TaskFacts): boolean =>
    input.tasks.some(
      (other) => other.id !== failed.id && other.subjectRef === failed.subjectRef && Boolean(other.startedAt) && Date.parse(other.startedAt!) > endedAt(failed),
    );

  /**
   * Why a deploy or QA task that did not finish no longer matters, or null:
   * for a deploy, a later deploy of the same repository finished, which
   * shipped what this one would have; for either, its pull request is closed
   * and nothing deploys it to testing — its repository ships by merging, or,
   * for a task with no repository, the install has no testing URL. A later deploy does not check again what
   * QA failed on, so it leaves a QA card. SRE cards on a run of merged issues otherwise stood for as long
   * as the repository never reached Done.
   */
  const shipped = (task: TaskFacts, landed: boolean): string | null => {
    if (task.kind !== 'deploy' && task.kind !== 'qa') return null;
    const later =
      task.kind === 'deploy' &&
      input.tasks.some(
        (other) =>
          other.kind === 'deploy' &&
          other.state === 'done' &&
          other.id !== task.id &&
          other.repoId === task.repoId &&
          Date.parse(other.createdAt) > Date.parse(task.createdAt),
      );
    const ref = subjectOf(task.subjectRef).subject.ref ?? task.subjectRef;
    if (later) return `A later deploy finished, so ${ref} no longer waits on ${WORK[task.kind]} that stopped`;
    const deploysNowhere = task.repoId !== null ? (input.shipsByMerging?.has(task.repoId) ?? false) : input.testingDeploy === false;
    if (landed && deploysNowhere) return `${ref} is closed and nothing deploys it to testing, so there is no need for ${WORK[task.kind]}`;
    return null;
  };

  // Tasks that failed, or that OpenADLC stopped under them, and that nothing has
  // tried again. Each says why in words a person acts on, with the thing to
  // press for it, and can be run again from here. More than one bot stopped
  // the same way — the same account signed out, the same permission missing —
  // is one card listing them, rather than one telling the same story per bot.
  const taskCandidates: CauseCandidate[] = [];
  for (const task of failedTaskCandidates(input)) {
    const bot = botsById.get(task.botId);
    const { subject } = subjectOf(task.subjectRef);

    // Its issue or pull request has closed: the work landed, or a person
    // closed it. The stage label does not say so for a pull request opened
    // outside the crew, or an issue closed by hand, and reviewer cards on
    // merged pull requests stood for a week. A deploy or QA task's
    // work starts at the merge, so it is over only as `shipped` says. Said
    // once under "recovered", for a day, rather than as a card.
    const landed = input.closed?.has(task.subjectRef) ?? false;
    const resolved =
      endsWithSubject(task) && landed
        ? `${subject.ref ?? task.subjectRef} landed or was closed, so ${botInWords(bot)} no longer has to finish ${WORK[task.kind]}`
        : shipped(task, landed);
    if (resolved) {
      if (input.now.getTime() - endedAt(task) <= RECOVERED_FOR_MS) {
        items.push({
          id: `landed:${task.id}`,
          kind: 'check_fixed',
          headline: resolved,
          subject,
          bot: asAttentionBot(bot),
          since: occurrenceOf(task),
          detail: '',
          actions: [{ kind: 'dismiss_task', label: 'Dismiss', tasks: [{ taskId: task.id, occurrence: occurrenceOf(task) }] }],
        });
      }
      continue;
    }

    const words = explainFailure(task.exitReason, { bot: botInWords(bot), account: accountOf(bot), permissionsUrl });
    // A spend limit or a sign-in that has been fixed since clears the card
    // only once the work moved on too: its subject closed, or a later task on
    // it started. Nothing runs a model-account failure again by itself
    // (`retryAfterRecovery` leaves it to a person), so an implement task that
    // hit the limit on an open issue would otherwise stall it unseen. Until
    // then the card says it can be tried again.
    const outside = causeOutside(task.exitReason, words.action as { href?: string } | null);
    const fixed = outside !== null && causeGone(task, outside);
    if (fixed && (landed || movedOn(task))) continue;
    // Named for this bot — "Reconnect X" — stays with it; a fix that clears
    // every bot with this cause is the one a merged card can offer once.
    const ownFix = words.action && namesBot(words.action, bot) ? words.action : null;
    const sharedFix = words.action && !ownFix ? words.action : null;
    // A build that pushed its work and, continued once, still ended without
    // its pull request: the person can open it from the branch, or
    // have the builder go on from there again.
    const withoutPullRequest = task.kind === 'implement' && Boolean(task.branch) && Boolean(task.exitReason?.startsWith(NO_PULL_REQUEST));
    const repo = withoutPullRequest ? input.repos.find((entry) => entry.id === task.repoId) : undefined;
    const openPullRequest: AttentionAction[] =
      repo && task.branch ? [{ kind: 'open_url', label: 'Open pull request', url: openPullRequestUrl(repo.fullName, task.branch, repo.defaultBranch) }] : [];
    const memberActions: AttentionAction[] = [
      ...(ownFix ? [ownFix] : []),
      ...openPullRequest,
      { kind: 'retry_task', label: 'Try again', taskId: task.id },
      { kind: 'stop_task', label: 'Stop', taskId: task.id },
      { kind: 'dismiss_task', label: 'Dismiss', tasks: [{ taskId: task.id, occurrence: occurrenceOf(task) }] },
    ];
    if (bot) memberActions.push({ kind: 'open_thread', label: 'Open thread', bot: bot.name });
    if (subject.url) memberActions.push({ kind: 'open_url', label: 'On GitHub', url: subject.url });
    const ended =
      task.state === 'stopped'
        ? `${botSaid(bot)} was stopped before finishing ${WORK[task.kind]}`
        : withoutPullRequest
          ? `${botSaid(bot)} finished without opening a pull request`
          : `${botSaid(bot)} could not finish ${WORK[task.kind]}`;
    const headline = fixed ? `${ended}; ${outside === 'bot' ? 'its GitHub sign-in' : 'its model account'} has worked since, so it can be tried again` : ended;
    taskCandidates.push({
      key: causeKey(`${task.kind}:${task.state}${fixed ? ':fixed' : ''}`, words.sentence, bot, task.id),
      sharedAction: sharedFix,
      member: {
        id: `task:${task.id}`,
        headline,
        detail: words.sentence,
        subject,
        bot: asAttentionBot(bot),
        since: new Date(endedAt(task)).toISOString(),
        actions: memberActions,
        ...(words.raw ? { raw: words.raw } : {}),
      },
    });
  }
  // A card that stands for several tasks is stopped, or dismissed, for all
  // of them at once: each member's own buttons are in the sheet, one at a
  // time. A Stop that reached only the newest left the others to come back
  // as a card of their own.
  items.push(
    ...foldCauses('task_failed', 'task-group', taskCandidates).map((item) => {
      if (!item.members) return item;
      const every = item.members.flatMap((member) =>
        member.actions.flatMap((action) => (action.kind === 'dismiss_task' ? action.tasks : [])),
      );
      const stops = item.members.flatMap((member) =>
        member.actions.flatMap((action) => (action.kind === 'stop_task' ? [action.taskId] : [])),
      );
      const actions: AttentionAction[] = [...item.actions];
      if (stops.length > 0) actions.push({ kind: 'stop_task', label: 'Stop all', taskId: stops[0]!, taskIds: stops });
      actions.push({ kind: 'dismiss_task', label: 'Dismiss all', tasks: every });
      return { ...item, actions };
    }),
  );

  // Console requests whose triage failed before anything was filed: a draft,
  // or one whose questions were answered and whose triage then failed. A filed
  // or abandoned request is finished, and the triage route refuses it.
  const triageCandidates: CauseCandidate[] = [];
  for (const request of input.requests) {
    if (request.state === 'filed' || request.state === 'abandoned') continue;
    const subjectRef = `request:${request.id.slice(0, 8)}`;
    // Queued and still tried, it waits its turn: an earlier triage's failure
    // is not news, and its Try again would only queue it again.
    if (request.state === 'queued' && stillTried(request)) continue;
    // One the queue stopped trying waits for a person, and has no task to fail
    // when its start was refused before one was written (intake's
    // prerequisites, say): nothing said so, and it sat in line for good. Shown
    // whatever its age, since it waits until somebody presses Try again.
    if (request.state === 'queued') {
      const repo = request.repoId ? reposById.get(request.repoId) : undefined;
      const why = request.queueReason?.trim() || 'it gave no reason';
      triageCandidates.push({
        key: causeKey('intake-queue', why, undefined, request.id),
        sharedAction: null,
        member: {
          id: `request:${request.id}`,
          headline: 'Your request could not start its triage',
          detail: `The queue tried ${request.queueAttempts ?? 0} times and stopped: ${why}. Put that right, then Try again.`,
          subject: { repo: repo?.name ?? null, number: null, title: firstLine(request.text), ref: null, url: null, item: itemFor(requestSubject(request.id)) },
          bot: null,
          since: request.updatedAt ?? request.createdAt,
          actions: [{ kind: 'retry_triage', label: 'Try again', requestId: request.id }],
        },
      });
      continue;
    }
    const latest = input.tasks
      .filter((task) => task.subjectRef === subjectRef && task.kind === 'intake')
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (!latest || !ENDED_UNFINISHED.includes(latest.state) || endedAt(latest) < windowStart) continue;
    if (stoppedByAPerson(latest)) continue;
    // Dismissed, as a task's card is: it stays away until a newer triage ends.
    if (input.acknowledged?.get(`task:${latest.id}`)?.has(occurrenceOf(latest))) continue;

    const bot = botsById.get(latest.botId);
    const repo = request.repoId ? reposById.get(request.repoId) : undefined;
    const words = explainFailure(latest.exitReason, { bot: botInWords(bot), account: accountOf(bot), permissionsUrl });
    const ownFix = words.action && namesBot(words.action, bot) ? words.action : null;
    const sharedFix = words.action && !ownFix ? words.action : null;
    // Nothing else let a person drop a request they no longer want: it stood
    // here for the whole week, and Try again was the only way off.
    const memberActions: AttentionAction[] = [
      ...(ownFix ? [ownFix] : []),
      { kind: 'retry_triage', label: 'Try again', requestId: request.id },
      { kind: 'dismiss_task', label: 'Dismiss', tasks: [{ taskId: latest.id, occurrence: occurrenceOf(latest) }] },
      { kind: 'abandon_request', label: 'Abandon', requestId: request.id },
    ];
    if (bot) memberActions.push({ kind: 'open_thread', label: 'Open thread', bot: bot.name });
    triageCandidates.push({
      key: causeKey('intake', words.sentence, bot, request.id),
      sharedAction: sharedFix,
      member: {
        id: `request:${request.id}`,
        headline: `${botSaid(bot)} could not triage your request`,
        detail: words.sentence,
        subject: { repo: repo?.name ?? null, number: null, title: firstLine(request.text), ref: null, url: null, item: itemFor(requestSubject(request.id)) },
        bot: asAttentionBot(bot),
        since: new Date(endedAt(latest)).toISOString(),
        actions: memberActions,
        ...(words.raw ? { raw: words.raw } : {}),
      },
    });
  }
  // A folded card is dismissed for every request on it at once, as a task
  // card is; abandoning stays one request at a time, from the sheet.
  items.push(
    ...foldCauses('triage_failed', 'triage-group', triageCandidates).map((item) => {
      if (!item.members) return item;
      const every = item.members.flatMap((member) => member.actions.flatMap((action) => (action.kind === 'dismiss_task' ? action.tasks : [])));
      return every.length > 0 ? { ...item, actions: [...item.actions, { kind: 'dismiss_task' as const, label: 'Dismiss all', tasks: every }] } : item;
    }),
  );

  // The weekly engine update. The bots are still on the engines they had, so
  // nothing is broken — but the reason is usually a credential or a model a
  // person has to look at, and it stays until a later run goes in.
  if (input.engineUpdate) {
    items.push({
      id: 'engine-update',
      kind: 'engine_update_failed',
      headline: 'The engine update did not go in',
      subject: { repo: null, number: null, title: 'The bots are still on the engines they had', ref: null, url: null },
      bot: null,
      since: input.engineUpdate.at,
      detail: shortReason(input.engineUpdate.detail),
      actions: [{ kind: 'open_page', label: 'See the engine updates', href: input.engineUpdate.href }],
    });
  }

  items.push(...healthItems(input.health ?? [], input.bots, input.now, input.acknowledged));

  return items
    .filter((item) => !(item.subject.ref && ignored.has(item.subject.ref)) && !(item.subject.item && ignored.has(item.subject.item)))
    .map((item) => ({ ...item, group: groupOf(item.kind) }))
    .sort((a, b) => Date.parse(b.since) - Date.parse(a.since) || a.id.localeCompare(b.id));
}

/**
 * Whether a failed task was tried again: a later task of the same kind on the
 * same subject. For a review, by the same reviewer — the reviewers of a pull
 * request are opened one after another, so another reviewer's later task is
 * not a second attempt at this one.
 */
export function triedAgain(failed: TaskFacts, all: readonly TaskFacts[]): boolean {
  return all.some(
    (other) =>
      other.id !== failed.id &&
      other.subjectRef === failed.subjectRef &&
      other.kind === failed.kind &&
      (failed.kind !== 'review' || other.botId === failed.botId) &&
      Date.parse(other.createdAt) > Date.parse(failed.createdAt),
  );
}

/** Said first on a failing card whose check has had no answer since; see `nextRow`. */
function unconfirmedNote(row: HealthRow): string {
  const unconfirmed = unconfirmedOf(row);
  if (!unconfirmed) return '';
  const reason = unconfirmed.reason.replace(/\.$/, '');
  return `OpenADLC couldn’t confirm this is still the case — since ${unconfirmed.since.slice(0, 16).replace('T', ' ')} UTC its check has had no answer: ${reason}. If you fixed it, press Check again.\n\n`;
}

/**
 * A failing health check as a card: what is wrong, what to do, and the one
 * button for it. A card whose fix waits for another's — a bot's signing key
 * behind the app's permission to register one — waits with it, so the person
 * is sent to the first thing to do rather than to both at once. A check that
 * passes again, or something OpenADLC put right itself, is said once, until
 * dismissed.
 */
export function healthItems(
  rows: readonly HealthRow[],
  crew: readonly BotRow[],
  now: Date,
  acknowledged: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): AttentionItem[] {
  const failing = failingIds(rows);
  const botOf = (row: HealthRow): BotRow | undefined => {
    const botId = typeof row.facts.botId === 'string' ? row.facts.botId : null;
    return botId ? crew.find((bot) => bot.id === botId) : undefined;
  };
  const subjectOf = (row: HealthRow): AttentionSubject => {
    const told = row.facts.subject as Partial<AttentionSubject> | undefined;
    if (!told || typeof told !== 'object') return EMPTY_SUBJECT;
    return {
      repo: told.repo ?? null,
      number: told.number ?? null,
      title: told.title ?? null,
      ref: told.ref ?? null,
      url: told.url ?? null,
      item: told.item ?? null,
    };
  };

  const notices: AttentionItem[] = [];
  // Failing rows for the same check are the same cause even when they name
  // different bots or repositories — the crew's own access check fails once
  // per bot it is not let into — so they fold into one card by `checkId`.
  // Severity is part of the key: `repo-rules` and `signing-key` emit both
  // `blocking` and `warning` rows under one check, and folding those together
  // took the newest row's severity, so a card that stops every build could
  // read amber because a warning elsewhere happened to be more recent.
  const candidates: CauseCandidate[] = [];
  for (const row of rows) {
    if (row.state === 'failing' && row.title && !isWaiting(row, failing)) {
      // A notice with nothing to fix names what it is about now; one a person
      // dismissed stays away until that changes.
      const history = row.facts.history === true;
      const occurrence =
        typeof row.facts.occurrence === 'string' ? row.facts.occurrence : history ? `since:${row.failingSince ?? row.checkedAt}` : null;
      // Covered when everything on it was dismissed: a newer post brings it
      // back, a resolved one never does.
      const onCard = Array.isArray(row.facts.occurrences)
        ? row.facts.occurrences.filter((one): one is string => typeof one === 'string')
        : occurrence
          ? [occurrence]
          : [];
      const seen = acknowledged.get(row.id);
      if (occurrence && seen && onCard.length > 0 && onCard.every((one) => seen.has(one))) continue;
      // More than one thing to do, where a check says so: its first action is `action`.
      const more = Array.isArray(row.facts.actions) ? (row.facts.actions as HealthAction[]).filter(isHealthAction) : [];
      const severity = row.severity ?? 'blocking';
      candidates.push({
        key: `${row.checkId}:${severity}`,
        sharedAction: null,
        // A health card clears itself on the check's next run; this is for the
        // person who has just fixed it and would otherwise wait up to its interval.
        // Not on a card about history: nothing done makes it pass sooner.
        recheck: history ? undefined : { kind: 'recheck', label: 'Check again', checkId: row.checkId },
        member: {
          id: `check:${row.id}`,
          headline: row.title,
          detail: unconfirmedNote(row) + (row.detail ?? ''),
          subject: subjectOf(row),
          bot: asAttentionBot(botOf(row)),
          since: row.failingSince ?? row.checkedAt,
          actions: [
            ...(occurrence
              ? [{ kind: 'acknowledge' as const, label: typeof row.facts.dismissLabel === 'string' ? row.facts.dismissLabel : 'Dismiss', checkId: row.id, occurrence }]
              : []),
            ...(row.action ? [attentionAction(row.action)] : []),
            ...more.map(attentionAction),
            ...(row.facts.incident ? [{ kind: 'incident' as const, label: 'What to do' }] : []),
          ],
          severity,
        },
      });
      continue;
    }
    if (showsNotice(row, now)) {
      notices.push({
        id: `fixed:${row.id}`,
        kind: 'check_fixed',
        headline: row.fixedTitle ?? 'Fixed',
        subject: EMPTY_SUBJECT,
        bot: asAttentionBot(botOf(row)),
        since: row.fixedAt ?? row.checkedAt,
        detail: '',
        actions: [{ kind: 'dismiss', label: 'Dismiss', checkId: row.id }],
      });
    }
  }
  // An incident rides on its card, for the sheet's steps.
  const incidents = new Map(
    rows.filter((row) => row.facts.incident && typeof row.facts.incident === 'object').map((row) => [`check:${row.id}`, row.facts.incident as Record<string, unknown>]),
  );
  const cards = foldCauses('check_failed', 'check-group', candidates).map((item) =>
    incidents.has(item.id) ? { ...item, incident: incidents.get(item.id)! } : item,
  );
  return [...cards, ...notices];
}

/** Whether something a check put in its facts is a button a card can draw. */
function isHealthAction(value: unknown): value is HealthAction {
  if (!value || typeof value !== 'object') return false;
  const action = value as Record<string, unknown>;
  return typeof action.label === 'string' && ['url', 'href', 'command'].some((key) => typeof action[key] === 'string');
}

/** A check's action as a card's button. */
export function attentionAction(action: HealthAction): AttentionAction {
  if ('url' in action) return { kind: 'open_url', label: action.label, url: action.url };
  if ('command' in action) return { kind: 'run_command', label: action.label, command: action.command };
  return { kind: 'open_page', label: action.label, href: action.href };
}

/** How many items wait on a person: a notice that something was fixed does not. */
export function waitingCount(items: readonly Pick<AttentionItem, 'kind'>[]): number {
  return items.filter((item) => item.kind !== 'check_fixed').length;
}

/**
 * Where the attention list reads a failed engine update from (see
 * `engine-updates.ts`), what the health checks last said (they are run by
 * their registry, never by a read of this list), and the titles of subjects
 * the board has no row for (see `subject-titles.ts`).
 */
export interface AttentionDeps {
  engineUpdates?: { attention(): Promise<EngineUpdateAttention | null> };
  /** What the health checks last said; see `health/registry.ts`. */
  health?: { rows(): Promise<HealthRow[]> };
  titles?: (refs: readonly string[]) => Promise<ReadonlyMap<string, SubjectTitle>>;
  /** Which of these issues and pull requests are closed on GitHub; see `ClosedSubjects`. */
  closed?: (refs: readonly string[]) => Promise<ReadonlySet<string>>;
  /** Whether the install deploys merged work to testing, for a task with no repository; see `AttentionInput.testingDeploy`. */
  testingDeploy?: boolean;
  /**
   * Whether merging is shipping in one repository, or null when that could
   * not be told; see `AttentionInput.shipsByMerging`.
   */
  shipsByMerging?: (repo: { name: string; fullName: string }) => Promise<boolean | null>;
  /** Every question the given tasks asked, in one read; `threads.listGatesForTasks` unless a test says otherwise. */
  gatesFor?: (taskIds: readonly string[]) => Promise<readonly AskedGate[]>;
  /** The promotes held for a person; see `AttentionInput.heldPromotes`. Absent, none. */
  heldPromotes?: () => Promise<readonly HeldPromote[]>;
}

/**
 * A closed issue is seldom reopened, but one that is must bring its card
 * back: kept an hour, a reopened issue's failure stayed hidden that long.
 * Ten minutes is at most two GitHub reads a subject in that time. One still
 * open is kept as long: asked again every two minutes, each card's subject
 * cost thirty reads an hour on the automation account's token.
 */
const CLOSED_KEPT_MS = 10 * 60 * 1000;
const OPEN_KEPT_MS = 10 * 60 * 1000;
/** At most this many are read from GitHub on one read of the list, side by side; the rest are read on the next. */
const CLOSED_PER_READ = 20;
/** At most this many answers are kept; the oldest go first. Failed work is read for a week, not for ever. */
const CLOSED_KEPT_MAX = 1000;

export interface ClosedSubjectsDeps {
  /** A client to read GitHub with — the automation account's — or null when there is none. */
  client: () => Promise<Pick<GitHubClient, 'getIssue'> | null>;
  /** A managed repository's `owner/name`, by its short name. */
  fullName: (repoName: string) => Promise<string | null>;
  now?: () => number;
}

/**
 * Which of the subjects of failed tasks have closed on GitHub. The bridge
 * keeps an issue's stage, not whether it is closed, and a pull request
 * opened outside the crew has no row at all; GitHub says both in one read,
 * kept a while since the board reads what needs you every fifteen seconds.
 * A read that fails is open: a card stays rather than vanish on a guess.
 */
export class ClosedSubjects {
  private readonly cache = new Map<string, { at: number; closed: boolean }>();

  constructor(private readonly deps: ClosedSubjectsDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  async lookup(refs: readonly string[]): Promise<Set<string>> {
    const closed = new Set<string>();
    const toRead: string[] = [];
    for (const ref of new Set(refs)) {
      const kept = this.cache.get(ref);
      if (kept && this.now() - kept.at < (kept.closed ? CLOSED_KEPT_MS : OPEN_KEPT_MS)) {
        if (kept.closed) closed.add(ref);
      } else if (parseRef(ref)) {
        toRead.push(ref);
      }
    }
    if (toRead.length === 0) return closed;

    const client = await this.deps.client().catch(() => null);
    if (!client) return closed;
    const names = new Map<string, Promise<string | null>>();
    const fullName = (repo: string): Promise<string | null> => {
      const known = names.get(repo) ?? this.deps.fullName(repo).catch(() => null);
      names.set(repo, known);
      return known;
    };
    await Promise.all(
      toRead.slice(0, CLOSED_PER_READ).map(async (ref) => {
        const parsed = parseRef(ref)!;
        const name = await fullName(parsed.repo);
        const isClosed = name ? await subjectClosed(client, name, parsed.number) : false;
        this.keep(ref, isClosed);
        if (isClosed) closed.add(ref);
      }),
    );
    return closed;
  }

  /** Kept in the order they were read, so the oldest is the first to go past the bound. */
  private keep(ref: string, closed: boolean): void {
    this.cache.delete(ref);
    this.cache.set(ref, { at: this.now(), closed });
    for (const oldest of this.cache.keys()) {
      if (this.cache.size <= CLOSED_KEPT_MAX) break;
      this.cache.delete(oldest);
    }
  }
}

/** The rows `attentionItems` reads, from the store. */
export async function readAttention(now: Date, deps: AttentionDeps = {}): Promise<AttentionInput> {
  const since = new Date(now.getTime() - ATTENTION_WINDOW_DAYS * DAY_MS);
  const [gates, recent, crew, everyRepo, issueList, requestList, stallEvents, engineUpdate, checks, accounts, seen, sendBackEvents] = await Promise.all([
    threads.listOpenGates(),
    tasks.listTasksSince(since),
    bots.listBots(),
    // The removed ones too, so what is left of their work is left out.
    repos.listRepos({ includeRemoved: true }),
    issues.listIssues(),
    requests.listRequests(100),
    listEventsOfType(REVIEW_STALLED, since),
    // Read from settings alone. A record that cannot be read is not a failed
    // update, and must not take the rest of the list down with it.
    deps.engineUpdates ? deps.engineUpdates.attention().catch(() => null) : Promise.resolve(null),
    // Neither is a table that is not there yet — an install whose migration
    // has not run — a reason to lose the rest.
    (async () => (deps.health ? deps.health.rows() : []))().catch(() => [] as HealthRow[]),
    (async () => modelAccounts.list())().catch(() => []),
    // What a person dismissed; a table not there yet dismissed nothing.
    (async () => acknowledgements.listAcknowledgements())().catch(() => new Map()),
    (async () => {
      const [stalled, toPerson] = await Promise.all([listEventsOfType(SEND_BACK_STALLED, since), listEventsOfType(SEND_BACK_TO_PERSON, since)]);
      return [...stalled.map((event) => ({ ...event, type: SEND_BACK_STALLED })), ...toPerson.map((event) => ({ ...event, type: SEND_BACK_TO_PERSON }))];
    })().catch(() => []),
  ]);
  const intakeStalls = await (async () => listEventsOfType(INTAKE_STALLED, since))().catch(() => []);
  const designMemoryEvents = await (async () => listEventsOfType(DESIGN_MEMORY_SUPERSEDED, since))().catch(() => []);

  // A gate can be older than the window. Its task is paused, which the read
  // above includes, unless it ended some other way with the question open.
  const known = new Set(recent.map((task) => task.id));
  const missing = gates.map((gate) => gate.taskId).filter((id): id is string => Boolean(id) && !known.has(id!));
  const extra = (await Promise.all(missing.map((id) => tasks.getTask(id)))).filter(
    (task): task is NonNullable<typeof task> => task !== null,
  );
  const all = [...recent, ...extra];
  const repoList = everyRepo.filter((repo) => !repo.removedAt);
  const removed = everyRepo.filter((repo) => repo.removedAt).map((repo) => ({ id: repo.id, name: repo.name }));

  // The subjects of what failed that the board has no row for, by title.
  const unnamed = [
    ...new Set(
      all
        .filter((task) => ENDED_UNFINISHED.includes(task.state) && parseRef(task.subjectRef))
        .map((task) => task.subjectRef)
        .filter((ref) => !issueForSubject(ref, issueList)),
    ),
  ];
  const titles = deps.titles && unnamed.length > 0 ? await deps.titles(unnamed).catch(() => new Map()) : new Map();

  const ended = all.filter((task) => ENDED_UNFINISHED.includes(task.state) && parseRef(task.subjectRef));

  // What the tasks whose session went away asked, so an end a person's
  // "stop here" asked for is theirs: one read for all of them, since the
  // board reads this every fifteen seconds. A read that fails asks nothing,
  // and the card stays.
  const gatesFor = deps.gatesFor ?? ((ids: readonly string[]) => threads.listGatesForTasks(ids));
  const killed = all.filter((task) => endedBySessionKill(task)).map((task) => task.id);
  const asked = killed.length > 0 ? await gatesFor(killed).catch((): readonly AskedGate[] => []) : [];

  // What the intake sweep would not take on its own; settings that cannot be read hold nothing here.
  const unowned = await readUnowned().catch(() => ({}));
  // A table that cannot be read holds nothing here; the deploy sweep still does.
  const heldPromotes = deps.heldPromotes ? await deps.heldPromotes().catch(() => []) : [];
  // What the merge line holds for a person; a line that cannot be read holds nothing here.
  const heldMerges = (await (async () => mergeLines.line())().catch(() => []))
    .map((entry) => ({ entry, reason: heldForPerson(entry) }))
    .filter((one): one is { entry: (typeof one)['entry']; reason: string } => one.reason !== null)
    .map(({ entry, reason }) => ({ repo: entry.repoName, prNumber: entry.prNumber, reason, since: entry.enteredAt }));

  // Which repositories of a deploy or QA task that did not finish ship by
  // merging. Asked only for those, and an answer that could not be had keeps
  // the card, as the deploy path does.
  const shipRepos = new Set(ended.filter((task) => task.kind === 'deploy' || task.kind === 'qa').map((task) => task.repoId));
  const byMerging = deps.shipsByMerging;
  const shipsByMerging = new Set<string>();
  if (byMerging) {
    await Promise.all(
      repoList
        .filter((repo) => shipRepos.has(repo.id))
        .map(async (repo) => {
          if ((await byMerging(repo).catch(() => null)) === true) shipsByMerging.add(repo.id);
        }),
    );
  }

  const read: AttentionInput = {
    now,
    gates,
    tasks: all,
    bots: crew,
    repos: repoList,
    issues: issueList,
    requests: requestList,
    stallEvents,
    sendBackEvents,
    intakeStalls,
    designMemoryEvents,
    engineUpdate,
    heldMerges,
    unowned,
    heldPromotes,
    health: checks,
    acknowledged: new Map([...seen.values()].map((one) => [one.id, new Set([one.occurrence, ...(one.covers ?? [])])])),
    accounts,
    titles,
    asked,
    removed,
    ...(deps.testingDeploy !== undefined ? { testingDeploy: deps.testingDeploy } : {}),
    shipsByMerging,
  };

  // Whether the subjects of what failed have closed, asked of GitHub only for
  // the tasks that could still be a card. Asked for every failed or stopped
  // task of the week — stopped by a person, tried again, dismissed — each
  // open one cost a read every two minutes on the automation account's token.
  const endable = [...new Set(failedTaskCandidates(withoutRemoved(read)).map((task) => task.subjectRef).filter((ref) => parseRef(ref)))];
  const closed = deps.closed && endable.length > 0 ? await deps.closed(endable).catch(() => new Set<string>()) : new Set<string>();
  return { ...read, closed };
}

export function registerAttentionRoutes(router: Router, deps: AttentionDeps = {}): void {
  router.get('/v1/attention', async () => ({ items: attentionItems(await readAttention(new Date(), deps)) }));
}
