import type { EngineUpdatesView } from '@/components/engine-updates';
import type { InstallSettings } from '@/components/install-settings';
import type { InstallationsView } from './app-reach';
import type { BackupInventory } from './backup';
import type { RepoAccess } from './crew-access';
import { cache } from 'react';
import { bridgeAnswered } from './bridge-answered';
import { identityHeaders } from './identity';
export const BRIDGE_URL = process.env.FLEETADLC_BRIDGE_URL ?? 'http://127.0.0.1:47311';

/** A task as a card carries it: who, doing what, since when. */
export interface CardTask {
  bot: string;
  kind: string;
  state: string;
  round: number;
  startedAt: string | null;
  endedAt: string | null;
  exitReason: string | null;
}

export interface BoardCard {
  repo: string;
  ref: string;
  title: string;
  stage: string;
  /** Every bot on the card now, on the issue or its pull request. */
  assignees: string[];
  gateOpen: boolean;
  url: string | null;
  labels: string[];
  updatedAt: string;
  /*
   * What the work on it is, from its tasks. Absent from a bridge older than
   * the redesigned board, which the card reads as nothing known.
   */
  number?: number;
  prNumber?: number | null;
  /** Spent on it so far: its own tasks, its pull request's and the request it came from. */
  costUsd?: number;
  /** Queued, running or paused, newest first. */
  active?: CardTask[];
  /** The newest task that ended. */
  last?: CardTask | null;
  reviewRound?: number | null;
  /** How many rounds the review loop ran before it stopped without agreeing, while it is still stopped. */
  stalledAfterRounds?: number | null;
  /** How many times its work was sent back to an earlier stage. Absent from an older bridge. */
  sentBack?: number;
  /** Whether a reviewer's last review of its pull request failed, with nothing since. Absent from an older bridge. */
  reviewFailed?: boolean;
  /** Whether the question open on it is a stage waiting for an OK. */
  approval?: boolean;
  shippedAt?: string | null;
  /** What a blocked card waits on, by issue number. Absent from an older bridge. */
  waitingOn?: number[];
  /**
   * A console request intake is still asking about or writing up: not an issue
   * yet, so it has no number and nowhere to be moved. Its ref is `request:<id8>`.
   */
  request?: boolean;
  /** Where a request is. Absent from an older bridge. */
  requestState?: 'queued' | 'working' | 'waiting' | 'filed';
  /** A queued request's place in line, 1 being next. */
  queuePosition?: number | null;
  /** The issue a filed request became. */
  issueNumber?: number | null;
  /** A person holding this issue: the step it is on finishes and nothing new starts. Absent from an older bridge. */
  held?: { by: string; at: string; why: string | null } | null;
  /** Put first in its repository's queue by a person. Absent from an older bridge. */
  next?: boolean;
}

export interface BoardColumn {
  stage: string;
  title: string;
  mode: string;
  /** On Ship: every repository in view deploys nothing, so merging ships it and the stage is skipped. */
  shipsByMerging?: boolean;
  bots: { name: string; displayName: string; working: boolean; waiting?: boolean }[];
  cards: BoardCard[];
}

/** A pull request's place in the line, and what the bridge is doing with it. */
export interface MergeLineEntry {
  repo: string;
  ref: string;
  position: number;
  state: string;
  detail: string | null;
  /** Why only a person can land it, when it is waiting for one at the front. Absent from an older bridge. */
  heldFor?: string | null;
}

export interface Board {
  repo: string;
  repos: string[];
  /** Each repository with its colour. Absent from a bridge older than colours. */
  repositories?: { name: string; fullName: string | null; color: string | null }[];
  columns: BoardColumn[];
  mergeLine: MergeLineEntry[];
  waitingOnYou: number;
  working: number;
  idle: number;
}

export interface BotSession {
  id: string;
  name: string;
  cmd: string;
  state: 'working' | 'idle' | 'paused' | 'stopped';
  pid: number | null;
  observedAt: string;
}

/** A bot's task as the crew reads it. */
export interface TaskSummary {
  /** Absent from an older bridge. */
  id?: string;
  /** Whether a person stopped it from the console, which is no failure to act on. */
  stoppedByAPerson?: boolean;
  /** A build that ended `done` without opening its pull request, which Try again goes on with. Absent from an older bridge. */
  endedWithoutPullRequest?: boolean;
  kind: string;
  state: string;
  subjectRef: string;
  /** The repository the work is in. Absent from an older bridge. */
  repo?: string | null;
  /** The issue it is about, as the board numbers it. Null for a request, or a deploy of a commit. */
  issue: { repo: string; number: number; title: string } | null;
  startedAt: string | null;
  endedAt: string | null;
  /** A review's round, or the round a fix answers. */
  round: number | null;
  /** How many rounds a review runs before it stops and asks. Absent from an older bridge. */
  maxRounds?: number | null;
  /** Paused behind a question nobody has answered yet. */
  waitingOnYou: boolean;
  /** What it waits for is an OK, from a stage in `assist`. Absent from an older bridge. */
  approval?: boolean;
  /** What this task alone has cost so far. Absent from an older bridge. */
  costUsd?: number;
}

export interface CrewMember {
  /** The handle of its account once one is connected; the seat it fills until then. */
  name: string;
  /** The seat, `second-reviewer`. Absent from a bridge older than seats. */
  slot?: string | null;
  displayName: string;
  role: string;
  engine: string;
  model: string;
  status: string;
  container: string;
  githubLogin: string | null;
  authorization: string;
  tokenExpiresAt: string | null;
  now: string;
  paused: boolean;
  sessions: BotSession[];
  /** The model account it thinks with, when one is assigned. */
  modelAccountId?: string | null;
  /** What it is doing now, from its tasks. Absent from an older bridge. */
  task?: TaskSummary | null;
  /** The last thing it finished, or failed at. */
  lastTask?: TaskSummary | null;
  /** What the health checks say is wrong with it: its sign-in, its signing key, its account. Absent from an older bridge. */
  checks?: { id: string; title: string; severity: string }[];
  /** The color a person chose for its avatar, a name from `CREW_COLORS`, or null for its role's tint. Absent from an older bridge. */
  color?: string | null;
  /** The avatar a person chose, a name from `AVATARS`, or null for its engine's mark. Absent from an older bridge. */
  avatar?: string | null;
  /** How many tasks it runs at once, each in a computer of its own. Absent from an older bridge, which ran one. */
  maxTasks?: number;
  /** Whether a person stopped it taking new work, who, when and why; null when it takes work. Absent from an older bridge. */
  seatPaused?: SeatPause | null;
  /** What it has on: running, waiting on a person, queued, and the next thing it will take. Absent from an older bridge. */
  queue?: SeatQueue;
  /** What it finished lately, newest first. Absent from an older bridge. */
  recent?: SeatResult[];
  /** Whether it can work: its sign-in, its account, its access, with what fixes each. Absent from an older bridge. */
  health?: SeatHealth;
}

export interface SeatPause {
  by: string;
  at: string;
  why: string | null;
}

export interface SeatQueue {
  running: number;
  waiting: number;
  queued: number;
  next: { ref: string; title: string | null } | null;
}

export type SeatOutcome = 'done' | 'sent_back' | 'failed' | 'stopped';

export interface SeatResult {
  ref: string;
  title: string | null;
  kind: string;
  outcome: SeatOutcome;
  at: string;
  /** The work item it was part of, as the board opens it; null for a task about nothing. */
  item: string | null;
  /** What it cost, when the bridge says. */
  costUsd?: number | null;
}

export interface SeatHealth {
  state: 'ok' | 'warning' | 'failing';
  reasons: { title: string; action: { label: string; href?: string; url?: string } | null }[];
}

/** Whether OpenADLC can sign in as a GitHub account. */
export type GitHubSignIn = 'signed-in' | 'needs-reconnecting' | 'not-signed-in';

/**
 * The GitHub accounts OpenADLC holds, the seats on each, and which account each
 * seat may use — with the bridge's reason where it may not, so the page never
 * works the rules out for itself. See `apps/bridge/src/github-identities.ts`.
 */
export interface GitHubAccountsView {
  accounts: {
    login: string;
    url: string;
    group: 'crew' | 'reviewers' | 'mixed' | null;
    signIn: GitHubSignIn;
    /** `approves`: whether a merge needs the seat's approval (the lead, or a blocking seat); absent from an older bridge. */
    seats: { name: string; slot: string; role: string; roleLabel: string; approves?: boolean }[];
    /** When it was first connected; absent from an older bridge. */
    connectedAt?: string | null;
  }[];
  bots: {
    name: string;
    slot: string;
    role: string;
    roleLabel: string;
    group: 'crew' | 'reviewers';
    login: string | null;
    choices: { login: string; refusal: string | null }[];
  }[];
}

/** What a person can do about something waiting on them. See `apps/bridge/src/attention.ts`. */
export type AttentionAction =
  | { kind: 'answer'; label: string; bot: string }
  | { kind: 'approve'; label: string; gateId: string; answer: string }
  | { kind: 'open_thread'; label: string; bot: string }
  | { kind: 'retry_triage'; label: string; requestId: string }
  /** Ends a request for good: its triage stops and nothing starts it again. */
  | { kind: 'abandon_request'; label: string; requestId: string }
  | { kind: 'retry_task'; label: string; taskId: string }
  /**
   * Stops a failed or stopped task for good: its lease and its card go with it.
   * A card folding several tasks carries each in `taskIds`, all stopped.
   */
  | { kind: 'stop_task'; label: string; taskId: string; taskIds?: string[] }
  /** Takes a failed task's card off until a task on it ends again; `occurrence` is when each ended. */
  | { kind: 'dismiss_task'; label: string; tasks: { taskId: string; occurrence: string }[] }
  | { kind: 'open_url'; label: string; url: string }
  | { kind: 'open_page'; label: string; href: string }
  | { kind: 'run_command'; label: string; command: string }
  | { kind: 'dismiss'; label: string; checkId: string }
  /** Dismisses a notice with nothing to fix until a newer occurrence arrives. */
  | { kind: 'acknowledge'; label: string; checkId: string; occurrence: string }
  /** Opens the steps for the item's `incident`: what to do about a post OpenADLC did not sign. */
  | { kind: 'incident'; label: string }
  | { kind: 'recheck'; label: string; checkId: string }
  /** A person's decision about issues OpenADLC will not take on its own: to intake, ignored, or closed. */
  | { kind: 'unowned_intake' | 'unowned_ignore' | 'unowned_close'; label: string; repo: string; numbers: number[] }
  /** A promote held for a person: released to production, or its repository switched to automatic delivery. */
  | { kind: 'promote_release' | 'promote_automatic'; label: string; repo: string; sha: string };

export type AttentionKind =
  | 'question'
  | 'approval'
  | 'review_stalled'
  /** Work sent back that waits for a person: past a send-back limit, or sent to a stage nobody staffs. */
  | 'send_back_held'
  | 'task_failed'
  | 'triage_failed'
  | 'engine_update_failed'
  /** A health check failing: something only a person can do. */
  | 'check_failed'
  /** Something that was failing passes again, or OpenADLC fixed it itself; said once. */
  | 'check_fixed'
  /** Approved and green at the front of the merge line, and only a person can land it. */
  | 'merge_waiting'
  /** Open unlabeled issues OpenADLC will not take on its own, one per repository. */
  | 'unowned_issues'
  /** A production promote OpenADLC holds for a person, where GitHub's plan cannot hold a reviewer. */
  | 'promote_held'
  /** A design took an accepted design memory entry out of effect: a notice, revertible in Settings. */
  | 'design_memory_superseded';

/** One thing waiting on a person, as `GET /v1/attention` says it. */
export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  /** Work, what the crew needs to go on, or system, what the install needs. Absent from an older bridge. */
  group?: 'work' | 'system';
  headline: string;
  /** `item` is the work item it is part of (a request's too, whose `ref` is null). Absent from an older bridge. */
  subject: { repo: string | null; number: number | null; title: string | null; ref: string | null; url: string | null; item?: string | null };
  bot: { name: string; slot: string | null; role: string; roleLabel: string; githubLogin: string | null } | null;
  since: string;
  detail: string;
  actions: AttentionAction[];
  /** A question's gate and its choices, the likely answer first; none for an open question. Absent from an older bridge. */
  question?: { gateId: string; options: string[] };
  /** What a question is about: the bot's message just before it. Absent from an older bridge. */
  context?: string;
  /** A failing check's: `blocking` stops work, `warning` lets it go on. */
  severity?: 'blocking' | 'warning';
  /** The reason exactly as it arrived, behind "Details", when `detail` says it in other words. */
  raw?: string;
  /**
   * Every item this one stands for, newest first, when more than one share the
   * same cause — the same check, or the same task kind failing the same way.
   * Absent, or a single entry, when it stands alone. Absent from an older bridge.
   */
  members?: AttentionMember[];
  /** An unsigned crew post, for the steps in its sheet. Absent from an older bridge. */
  incident?: UnsignedIncident;
}

/** What an unsigned crew post was, where, and whether it counted; `health/checks/attribution.ts` in the bridge. */
export interface UnsignedIncident {
  repo: string;
  login: string;
  seat: string | null;
  did: string;
  postUrl: string | null;
  target: { kind: 'pr' | 'issue'; number: number; url: string } | null;
  counted: boolean;
  mode: 'audit' | 'enforce';
}

/** One of several items folded into a card by the bridge's `foldCauses`, keeping what is its own rather than the cause's. */
export interface AttentionMember {
  id: string;
  headline: string;
  detail: string;
  /** `item` is the work item it is part of (a request's too, whose `ref` is null). Absent from an older bridge. */
  subject: { repo: string | null; number: number | null; title: string | null; ref: string | null; url: string | null; item?: string | null };
  bot: { name: string; slot: string | null; role: string; roleLabel: string; githubLogin: string | null } | null;
  since: string;
  actions: AttentionAction[];
  severity?: 'blocking' | 'warning';
  raw?: string;
}

/** How many items wait on a person: a notice that something was fixed does not. */
export function waitingCount(items: readonly Pick<AttentionItem, 'kind'>[]): number {
  return items.filter((item) => item.kind !== 'check_fixed').length;
}

/** A model account as the crew page names it. */
export interface ModelAccountRef {
  id: string;
  provider: string;
  kind: string;
  label: string;
}

export interface RepoRef {
  name: string;
  fullName: string | null;
}

export interface ThreadMessage {
  id: string;
  kind: 'sys' | 'bot' | 'you' | 'gate' | 'procs' | 'draft';
  author: string;
  text: string;
  note: string | null;
  payload: Record<string, unknown> | null;
  githubUrl: string | null;
  at: string;
  /** The subject it is about. Absent from an older bridge. */
  subjectRef?: string;
}

/** One subject a bot's thread is about, as `GET /v1/threads/:bot` names it. See `apps/bridge/src/thread-view.ts`. */
export interface ThreadTopic {
  ref: string;
  /** On GitHub (`issue`, `pull_request`), a console request, or anything else. */
  kind: 'issue' | 'pull_request' | 'request' | 'other';
  /** The repository it is in. Absent from an older bridge. */
  repo?: string | null;
  /** The issue's title: its own, or the one the pull request closes. */
  title: string | null;
  issue: { number: number; url: string | null } | null;
  pullRequest: { number: number; url: string | null } | null;
  /** What a console request asked for, and the issue it became once filed. */
  request: { text: string; issueNumber: number | null; state: string } | null;
  /** The work item it is part of: a request, its issue and its pull request are one. Absent from an older bridge. */
  item?: string | null;
}

export interface Gate {
  id: string;
  question: string;
  options: string[];
  addressedTo: string | null;
  githubCommentUrl: string | null;
}

export interface ThreadView {
  bot: {
    name: string;
    slot?: string | null;
    displayName: string;
    role: string;
    engine: string;
    container: string;
    status: string;
    /** The color a person chose for its avatar, or null for its role's tint. Absent from an older bridge. */
    color?: string | null;
    /** The avatar a person chose, or null for its engine's mark. Absent from an older bridge. */
    avatar?: string | null;
  };
  subjects: string[];
  /** Each subject named, newest first. Absent from an older bridge. */
  topics?: ThreadTopic[];
  messages: ThreadMessage[];
  openGate: Gate | null;
  /** Every question the bot has open, on any subject, with that subject. Absent from an older bridge. */
  openGates?: (Gate & { subjectRef: string | null })[];
}

/** A seat on a work item: which bot, which seat, which account, and whether other seats post as it too. */
export interface ItemSeat {
  bot: string;
  slot: string;
  githubLogin: string | null;
  sharedAccount: boolean;
}

/** A role present on a work item, with the seats that spoke or worked in it. */
export interface ItemRole {
  role: string;
  label: string;
  seats: ItemSeat[];
}

/**
 * Where a message written on an item would go, as the bridge routes it
 * (`messageRoutes` in apps/bridge/src/items.ts): the seat, the account it
 * posts as, and the place — or why it would be refused.
 */
export type ItemRoute =
  | {
      kind: 'post';
      bot: string;
      role: string;
      handle: string | null;
      subject: string;
      on: 'issue' | 'pull_request' | 'request' | 'fleetadlc';
      number: number | null;
    }
  | { kind: 'refused'; error: string };

export type ItemMessage = ThreadMessage & { subjectRef: string; role: string | null; seat: string | null; bot: string | null };
export type ItemGate = Gate & { subjectRef: string | null; role: string | null; seat: string | null; bot: string | null; createdAt?: string };

export interface ItemTask {
  id: string;
  bot: string;
  seat: string | null;
  role: string | null;
  kind: string;
  state: string;
  round: number;
  subjectRef: string;
  startedAt: string | null;
  endedAt: string | null;
  exitReason: string | null;
  tmuxSession: string | null;
  branch: string | null;
  costUsd: number;
}

/** A file a person gave with a request or a message, as the bridge describes it. */
export interface ItemAttachment {
  id: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  subjectRef: string | null;
  source: 'console' | 'github';
  uploadedBy: string;
  createdAt: string;
}

/** One entry of a repository's design memory; see `apps/bridge/src/design-memory.ts`. */
export interface DesignMemoryEntry {
  id: string;
  repoId: string;
  kind: 'decision' | 'constraint' | 'convention' | 'glossary';
  title: string;
  body: string;
  state: 'proposed' | 'accepted' | 'superseded' | 'retired';
  supersedes: string | null;
  sourceSubject: string | null;
  /** The design comment it was proposed in. */
  sourceUrl: string | null;
  /** The design task whose signed comment proposed it; absent from an older bridge. */
  sourceTask?: string | null;
  adrPath: string | null;
  /** The design's seat. */
  proposedBy: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A work item, as `GET /v1/items/:subject` returns it: the request, the issue
 * it became and that issue's pull request, read as one conversation. See
 * `apps/bridge/src/items.ts`.
 */
export interface ItemView {
  key: string;
  subjects: string[];
  title: string;
  repo: string | null;
  stage: string | null;
  costUsd: number;
  request: { id: string; subject: string; text: string; context: string | null; requestedBy: string | null; state: string; createdAt: string | null } | null;
  issue: { number: number; title: string; url: string | null; stage: string } | null;
  pullRequest: { number: number; url: string | null } | null;
  roles: ItemRole[];
  timeline: ItemMessage[];
  openGates: ItemGate[];
  tasks: ItemTask[];
  attachments: ItemAttachment[];
  /** What its design proposed the repository remember. Absent from an older bridge. */
  designMemory?: DesignMemoryEntry[];
  /** A person holding its issue. Absent from an older bridge. */
  held?: { by: string; at: string; why: string | null } | null;
  /** Its issue put first in its repository's queue. Absent from an older bridge. */
  next?: boolean;
  /** Where a message goes from each tab: `''` for the conversation, else by role. Absent from an older bridge. */
  routes?: Record<string, ItemRoute>;
}

export interface WorktreeEntry {
  name: string;
  kind: 'file' | 'directory' | 'other';
  size: number | null;
}

/**
 * One read of the task's worktree. `task` is null when the bot is between
 * tasks — a worktree exists while its task does — and that is an empty state
 * rather than an error. There is no writing counterpart to this on purpose.
 */
export type WorktreeView =
  | { task: null }
  | ({ task: { id: string; subjectRef: string; branch: string | null } } & (
      | { kind: 'directory'; path: string; entries: WorktreeEntry[]; truncated: boolean }
      | { kind: 'file'; path: string; size: number; bytes: number; truncated: boolean; content: string }
    ));

export interface SpendingFigure {
  amountUsd: number | null;
  /** Null on a per-task cap, which is not a month's spend. */
  spentUsd: number | null;
  /** On a repository row, the global cap a blank field uses. */
  globalUsd?: number | null;
}

export interface SpendingBotFigure extends SpendingFigure {
  botId: string;
  name: string;
}

export interface SpendingProviderFigure extends SpendingFigure {
  provider: 'anthropic' | 'openai' | 'xai';
}

export interface SpendingScope {
  monthTotal: SpendingFigure;
  task: SpendingFigure;
  bots: SpendingBotFigure[];
  providers: SpendingProviderFigure[];
}

export interface SpendingLimitsView {
  period: string;
  global: SpendingScope;
  repos: (SpendingScope & { repoId: string; name: string; fullName: string })[];
}

export interface SpendingChange {
  scope: string;
  kind: string;
  amountUsd: number | null;
}

export interface SpendingUpdate {
  limits: SpendingLimitsView;
  lowered: { repo: string; kind: string; from: number; to: number }[];
  leasingStopped: boolean;
  notice: string | null;
}

/** One window's numbers, overall or for a repository; `GET /v1/insights` (the bridge's `insights.ts`). */
export interface InsightSummary {
  merged: number;
  perDay: number;
  cycleMs: number | null;
  stages: { intake: number | null; design: number | null; build: number | null; review: number | null; mergeLine: number | null };
  overlap: {
    waits: number;
    byKind: { exclusive: number; building: number };
    totalWaitMs: number;
    medianWaitMs: number | null;
    hotFiles: { path: string; waits: number; waitedMs: number }[];
  };
  conflicts: { resolvedLeadOnly: number; resolvedFull: number; sentBack: number; resolving: number };
  sendBacks: Record<string, number>;
  parallel: { max: number; average: number };
}

export interface InsightsView {
  days: number;
  since: string;
  overall: InsightSummary;
  repos: ({ repo: string } & InsightSummary)[];
  suggestions: { repo: string; path: string; waits: number; text: string }[];
}

export interface CostsView {
  period: string;
  budget: { period: string; capUsd: number; spentUsd: number; state: string };
  perTaskCapUsd: number;
  byBot: { bot: string; costUsd: number; tasks: number }[];
  byRepo: { repo: string; costUsd: number }[];
  byDay: { day: string; costUsd: number }[];
  ledger: {
    id: number;
    botId: string;
    engine: string;
    model: string;
    modelAlias?: string | null;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    at: string;
  }[];
  stoppedAtCap: { id: string; subjectRef: string; costUsd: number }[];
  /** GitHub Actions minutes this month; absent from a bridge that does not count them. */
  ci?: CiMinutesView;
}

/** The bridge's `CiSummary` (`apps/bridge/src/ci-usage.ts`). */
export interface CiMinutesView {
  since: string;
  minutes: number;
  billedMinutes: number;
  estimatedUsd: number;
  runs: number;
  byRepo: { repo: string; minutes: number; billedMinutes: number; runs: number }[];
  byPullRequest: { repo: string; prNumber: number; minutes: number; runs: number }[];
  cap: number | null;
  capReached: string | null;
}

/** What a person may do in the console; the bridge enforces it (`roles.ts`). */
export type Role = 'admin' | 'user';

/**
 * How the bridge knows who is asking: `local` takes the one identity the
 * console sends (FLEETADLC_IDENTITY, or `console`), `iap` the person IAP signed in.
 */
export type IdentityMode = 'local' | 'iap';

/** A person in Settings → Users. */
export interface ConsoleUser {
  email: string;
  role: Role;
  addedBy: string;
  /** `added` by an admin, or one of the first admins, and from where. */
  addedHow: 'added' | 'first' | 'admin-emails' | 'console-members';
  addedAt: string;
}

/**
 * How long the layout waits to learn who is asking. Not `SECTION_READ_MS`,
 * which is for sections that call GitHub: a bridge slower than that on /v1/me
 * (Postgres, or Google's keys behind IAP, which it gives five seconds) was
 * read as no answer, and the layout drew a `user`'s page with admin controls.
 */
const ME_READ_MS = 10_000;

/**
 * Who is asking, as the bridge says: a role, or someone this install does not
 * know, with the admins they can ask. Null when the bridge could not be asked,
 * which each page already says in its own way. Once per request however many
 * parts of the page ask: the layout and Settings both do.
 */
export type Me =
  | { known: true; email: string; role: Role; identityMode: IdentityMode }
  | { known: false; email: string; admins: string[]; noAdmin?: boolean };

export const readMe = cache(async (): Promise<Me | null> => {
  try {
    const response = await fetch(`${BRIDGE_URL}/v1/me`, { cache: 'no-store', headers: await identityHeaders(), signal: AbortSignal.timeout(ME_READ_MS) });
    const body = (await response.json().catch(() => null)) as {
      email?: string;
      role?: Role;
      identityMode?: IdentityMode;
      code?: string;
      admins?: string[];
    } | null;
    // A bridge older than this console does not say its mode: read as local, the default install.
    if (response.ok && body?.role)
      return { known: true, email: body.email ?? '', role: body.role, identityMode: body.identityMode === 'iap' ? 'iap' : 'local' };
    if (response.status === 403 && body?.code === 'not-a-user') return { known: false, email: body.email ?? '', admins: body.admins ?? [] };
    // A cloud install that named no admin: everyone is refused until one is.
    if (response.status === 403 && body?.code === 'no-admin') return { known: false, email: body.email ?? '', admins: [], noAdmin: true };
    return null;
  } catch {
    return null;
  }
});

async function get<T>(path: string, init: { signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(`${BRIDGE_URL}${path}`, {
    cache: 'no-store',
    headers: await identityHeaders(),
    ...(init.signal ? { signal: init.signal } : {}),
  });
  if (!response.ok) throw await bridgeAnswered(path, response);
  return (await response.json()) as T;
}

/** How long settings waits for a section it could also leave to read its own. */
export const SECTION_READ_MS = 1_500;

export const api = {
  board: (repo: string) => get<Board>(`/v1/board?repo=${encodeURIComponent(repo)}`),
  crew: () => get<{ bots: CrewMember[] }>('/v1/bots'),
  item: (subject: string) => get<ItemView>(`/v1/items/${encodeURIComponent(subject)}`),
  designMemory: (repo: string) =>
    get<{ entries: DesignMemoryEntry[] }>(`/v1/repos/${encodeURIComponent(repo)}/design-memory`).then((body) => body.entries),
  costs: () => get<CostsView>('/v1/costs'),
  insights: (options: { repo?: string | null; days: 7 | 30 }) =>
    get<InsightsView>(`/v1/insights?days=${options.days}${options.repo ? `&repo=${encodeURIComponent(options.repo)}` : ''}`),
  spendingLimits: () => get<SpendingLimitsView>('/v1/spending/limits'),
  attention: () => get<{ items: AttentionItem[] }>('/v1/attention'),
  modelAccounts: () => get<{ accounts: ModelAccountRef[] }>('/v1/model-accounts'),
  githubAccounts: () => get<GitHubAccountsView>('/v1/github/identities'),
  /*
   * What settings' self-loading sections read, asked on the server too so the
   * page is drawn at its full height; see `SettingsPage`. Each gives up after
   * `SECTION_READ_MS`: the installations are several calls to GitHub, and a
   * GitHub that is slow must not hold up the page a person opens to fix
   * things. A section whose read gave up reads its own, as before.
   */
  installations: () => get<InstallationsView>('/v1/github/installations', { signal: AbortSignal.timeout(SECTION_READ_MS) }),
  install: () => get<InstallSettings>('/v1/install', { signal: AbortSignal.timeout(SECTION_READ_MS) }),
  engineUpdates: () => get<EngineUpdatesView>('/v1/engines/updates', { signal: AbortSignal.timeout(SECTION_READ_MS) }),
  backup: () => get<BackupInventory>('/v1/backup', { signal: AbortSignal.timeout(SECTION_READ_MS) }),
  users: () => get<{ users: ConsoleUser[] }>('/v1/users').then((body) => body.users),
  /** Whether a person has paused new work from Settings; see `pause-work.ts` in the bridge. */
  workPauses: () =>
    get<{ paused: WorkPause | null; repos?: Record<string, WorkPause>; dispatching?: boolean }>('/v1/work/pause').then((body): WorkPauses => ({
      paused: body.paused ?? null,
      // Absent from a bridge older than per-repository pauses.
      repos: body.repos ?? {},
      // Absent from a bridge older than the `dispatching` flag, which is read as dispatching:
      // it shows nothing new rather than a warning it cannot back.
      dispatching: body.dispatching !== false,
    })),
  repos: () =>
    get<{
      repos: {
        name: string;
        fullName?: string;
        concurrency: number;
        stageModes: Record<string, string>;
        owner: string | null;
        specRequiredLabels?: string[];
        /** A name from the palette. Absent from a bridge older than colours. */
        color?: string | null;
        /** Whether the crew can work there, as the last look found. Absent from an older bridge. */
        access?: RepoAccess | null;
        /**
         * Whether this repository has a testing deploy. Absent from a bridge
         * older than the choice, which the page reads as automatic.
         */
        testingDeploy?: 'automatic' | 'has' | 'none';
        /** What the choice resolved to. Null when GitHub could not be asked. */
        shipsByMerging?: boolean | null;
        /** How it ships, by its rules, and where they came from. Absent from an older bridge. */
        delivery?: RepoDelivery | null;
      }[];
      /** How many rounds a review runs before it stops and asks. Absent from an older bridge. */
      maxReviewRounds?: number | null;
    }>('/v1/repos'),
};

/** How a repository ships, as the bridge read its rules (`.github/fleetadlc.yml`). */
export interface RepoDelivery {
  source: 'file' | 'repository' | 'setting';
  rules: {
    testing: { on: 'merge' | 'none'; url?: string; workflow: string; smoke: string };
    production: { on: 'after-testing' | 'none'; approval: 'reviewers' | 'auto'; soakMinutes: number; workflow: string; rollback: string };
  };
  testingUrl: string | null;
  fileError: string | null;
}

/** A person's pause of new work, across the install or in one repository. */
export interface WorkPause {
  by: string;
  at: string;
  reason: string | null;
}

/** What is paused: the whole install, and each repository paused on its own, by name. */
export interface WorkPauses {
  paused: WorkPause | null;
  repos: Record<string, WorkPause>;
  /**
   * Whether anything leases an issue to a builder. False on a bridge
   * started without the dispatcher, where nothing new builds whatever the
   * pause says; absent is read as true.
   */
  dispatching?: boolean;
}

/** What finishes a step a removal could not do: removing again, or a page on GitHub. */
export type RemovalAction = { label: string; retry: true } | { label: string; url: string };

/** One thing removing a repository did not do, why, and what finishes it. */
export interface RemovalLeftover {
  step: 'task' | 'question' | 'lease' | 'collaborator' | 'invitation' | 'label' | 'app';
  what: string;
  why: string;
  action: RemovalAction;
}

/** Where the app stands with a repository once OpenADLC has left it. */
export interface AppStanding {
  allRepositories: boolean | null;
  settingsUrl: string | null;
  reason: string | null;
}

/** What removing a repository from OpenADLC would do, as the bridge reads it now (`GET /v1/repos/:name/removal`). */
export interface RemovalPreview {
  repository: string;
  removedAt: string | null;
  tasks: { id: string; subject: string; kind: string; state: string; bot: string | null; question: string | null }[];
  questions: { id: string; subject: string | null; question: string }[];
  leases: { id: string; issue: number; bot: string | null; state: string }[];
  crew: { known: boolean; reason: string | null; accounts: { bots: string[]; login: string; state: 'collaborator' | 'invited' }[] };
  /** OpenADLC's labels there, and apart from them those that may be the repository's own. */
  labels: { known: boolean; reason: string | null; names: string[]; maybeTheirs?: string[] };
  app: AppStanding;
  leftAlone: string;
}

/** What the review step chose. */
export interface RemovalChoices {
  crewAccess: boolean;
  labels: boolean;
  /** Delete, too, the labels that may be the repository's own. */
  maybeTheirs?: boolean;
}

/** What a removal did, and what it could not (`POST /v1/repos/:name/remove`). */
export interface RemovalReport {
  options: RemovalChoices;
  stopped: { task: string; subject: string; was: string }[];
  questionsClosed: number;
  leasesReleased: number[];
  collaboratorsRemoved: string[];
  invitationsCancelled: string[];
  labelsRemoved: string[];
  app: AppStanding;
  notDone: RemovalLeftover[];
}
