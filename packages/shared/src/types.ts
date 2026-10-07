import type { StageKey } from './stages.js';

export const BOT_ROLES = [
  'intake',
  'spec',
  'implement',
  'review_lead',
  'review_second',
  'review_security',
  'deploy',
  'qa',
  'automation',
] as const;
export type BotRole = (typeof BOT_ROLES)[number];

export const ENGINES = ['claude', 'grok', 'codex', 'none'] as const;
export type EngineName = (typeof ENGINES)[number];

export const TASK_KINDS = [
  'intake',
  'spec',
  'implement',
  'patch',
  'review',
  'deploy',
  'qa',
  'request',
] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const TASK_STATES = ['queued', 'running', 'paused', 'stopped', 'done', 'failed'] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const SESSION_STATES = ['working', 'idle', 'paused', 'stopped'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const LEASE_STATES = ['leased', 'in_task', 'paused', 'released', 'expired'] as const;
export type LeaseState = (typeof LEASE_STATES)[number];

/**
 * What a stage may do without asking. `assist` was one, and nothing ever did
 * it differently from `autonomous`; it is read as `autonomous`
 * (`normaliseStageMode`, `packages/shared/src/stages.ts`).
 */
export const STAGE_MODES = ['autonomous', 'untouched', 'conditional'] as const;
export type StageMode = (typeof STAGE_MODES)[number];

export const MESSAGE_KINDS = ['sys', 'bot', 'you', 'gate', 'procs', 'draft'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/**
 * A piece of the world a task has to read before it can do its work: the issue
 * it is implementing, the review that asked for a change, the repository's
 * notes to agents. The bridge gathers what only it can see from GitHub and
 * hands it over; hostd writes it where the session can read it.
 */
export interface ContextDocument {
  /** File name inside the task's context directory, e.g. `issue.md`. */
  name: string;
  /** What this is, shown to the engine above the content. */
  title: string;
  content: string;
}

export interface Bot {
  id: string;
  /**
   * Who the bot is: the connected account's login, lowercased, or its seat
   * while no account is connected. Its container, work folder, secrets and
   * sessions are named after it, and they move with it.
   */
  name: string;
  /**
   * The seat it was seeded into from `config/bots.yaml` — `builder`,
   * `lead-reviewer` — which never changes. Configuration refers to a bot by it.
   */
  slot: string;
  displayName: string;
  role: BotRole;
  engine: EngineName;
  model: string;
  /** The bot's own GitHub user account, connected by the OAuth device flow. */
  githubLogin: string | null;
  hostId: string | null;
  container: string;
  status: 'running' | 'stopped' | 'restarting';
  skills: string[];
  /** Whether this bot runs its checks against a database of its own. */
  sidecarDb: boolean;
  /**
   * The model account whose credential this bot uses, when one is assigned.
   * Null while the bot still has a per-bot engine key.
   */
  modelAccountId: string | null;
  /**
   * When the model was chosen in the console. Null when it came from
   * config/bots.yaml, which is what lets `fleetadlc up` apply a YAML edit to a bot
   * nobody has assigned and leave an assigned one alone.
   */
  modelSetAt: string | null;
  /**
   * The color a person chose for its avatar, a name from `CREW_COLORS`, or
   * null for its role's tint. Optional because a bot built by hand, in a test
   * or an older component, has none, which reads the same as null.
   */
  color?: string | null;
  /**
   * The avatar a person chose, a name from `AVATARS`, or null for its engine's.
   * Optional for the same reason as `color`.
   */
  avatar?: string | null;
  /**
   * How many tasks this seat runs at once, each in a computer of its own, all
   * as its one GitHub identity: Crew → "tasks at once", 1 to 16. Optional
   * for the same reason as `color`; absent reads as 1 (`maxTasksOf`).
   */
  maxTasks?: number;
  /**
   * What each of its tasks' computers is given: CPUs and memory, from
   * config/bots.yaml. Absent reads as the driver's default, two and 4 GB.
   */
  cpus?: number;
  memoryGb?: number;
}

/** How many tasks a seat runs at once; one for a bot read from somewhere that does not say. */
export function maxTasksOf(bot: { maxTasks?: number | null }): number {
  const value = bot.maxTasks ?? 1;
  return Number.isInteger(value) && value >= 1 ? Math.min(value, MAX_TASKS_PER_SEAT) : 1;
}

/**
 * The most tasks one seat may run at once. Each is a container with the
 * seat's CPUs and memory, so the host's own capacity is the real limit; this
 * keeps a typo from asking for a hundred.
 */
export const MAX_TASKS_PER_SEAT = 16;

/**
 * A model credential, added once and referenced by many bots.
 *
 * The credential is never part of this shape. An API key, and the token a
 * Claude subscription is given by `claude setup-token`, live in the secret
 * store; an OpenAI or xAI subscription's login lives in a directory on the
 * host, written by the CLI itself when it is signed in from the console.
 */
export interface ModelAccount {
  id: string;
  provider: 'anthropic' | 'openai' | 'xai';
  kind: 'key' | 'subscription';
  label: string;
  createdAt: string;
  /**
   * When the account was last checked by running its CLI with a one-line
   * prompt, whatever the answer was. Null when it never has been. The store
   * always reads it; it is optional so a shape built by hand — a fixture, an
   * account from before checks were kept — still is one, and reads as never.
   */
  verifiedAt?: string | null;
  /**
   * What the CLI said when that check failed, scrubbed of any secret. Null
   * when it answered, so a time with no error is a pass.
   */
  verifyError?: string | null;
}

/** One run of an account's CLI with a one-line prompt, as hostd reports it. */
export interface AccountCheck {
  ok: boolean;
  /** The CLI's own words when it failed; what it answered when it did not. */
  message: string;
  checkedAt: string;
}

/**
 * Where an OpenAI or xAI subscription's sign-in stands.
 *
 * `waiting` carries the only part of a sign-in that is ever shown: the link
 * and the one-time code, for the operator to enter in their own browser.
 */
export type SubscriptionLogin =
  | { state: 'waiting'; url: string; code: string; startedAt: string }
  | { state: 'signed-in' }
  | { state: 'failed'; message: string }
  | { state: 'signed-out' };

export interface Repo {
  id: string;
  name: string;
  fullName: string;
  ownerBotId: string | null;
  concurrency: number;
  stageModes: Record<StageKey, StageMode>;
  specRequiredLabels: string[];
  defaultBranch: string;
}

export interface Lease {
  id: string;
  repoId: string;
  issueNumber: number;
  botId: string;
  declaredPaths: string[];
  state: LeaseState;
  expiresAt: string | null;
  prNumber: number | null;
  /**
   * When the lease last changed state: leased, handed to its task, paused.
   * Optional so a lease built by hand is still one; the store always reads it.
   */
  updatedAt?: string;
}

export interface Task {
  id: string;
  botId: string;
  repoId: string | null;
  kind: TaskKind;
  subjectType: 'issue' | 'pr' | 'merge' | 'request';
  subjectRef: string;
  leaseId: string | null;
  state: TaskState;
  worktree: string | null;
  branch: string | null;
  tmuxSession: string | null;
  startedAt: string | null;
  endedAt: string | null;
  exitReason: string | null;
  costUsd: number;
  round: number;
}

export interface Session {
  id: string;
  botId: string;
  taskId: string | null;
  name: string;
  cmd: string;
  state: SessionState;
  pid: number | null;
  lastLine: string | null;
  observedAt: string;
}

export interface Gate {
  id: string;
  taskId: string | null;
  threadId: string | null;
  question: string;
  options: string[];
  state: 'open' | 'answered' | 'expired';
  answer: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
  githubCommentUrl: string | null;
  addressedTo: string | null;
  /** When it was asked: how long a person has been waited on. Absent from an older bridge. */
  createdAt?: string;
  /**
   * What the bot said just before asking, in the same conversation: what the
   * question is about. "Here's what I'll file. OK?" asked about a draft only
   * that message held, and its card showed the question alone. Read with the
   * open gates; absent elsewhere.
   */
  context?: string | null;
}

export interface Message {
  id: string;
  threadId: string;
  kind: MessageKind;
  author: string;
  text: string;
  note: string | null;
  payload: Record<string, unknown> | null;
  githubUrl: string | null;
  at: string;
}

export interface LedgerEntry {
  id: number;
  taskId: string | null;
  botId: string;
  engine: EngineName;
  /** The id that was called. Never an alias. */
  model: string;
  /** The configured alias, when the bot was set to one. Null for a pinned id. */
  modelAlias: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  at: string;
}

export interface BudgetState {
  period: string;
  capUsd: number;
  spentUsd: number;
  state: 'ok' | 'warning' | 'stopped';
}

export interface BoardCard {
  repo: string;
  ref: string;
  title: string;
  stage: StageKey;
  assignees: string[];
  gateOpen: boolean;
  url: string | null;
  labels: string[];
  updatedAt: string;
}
