import type { PnpmFill } from '../pnpm-store.js';

export interface SessionHandle {
  bot: string;
  name: string;
  pid: number | null;
  cmd: string;
}

export interface ObservedSession extends SessionHandle {
  state: 'working' | 'idle' | 'paused' | 'stopped';
  lastLine: string | null;
  pane: string[];
}

/**
 * What a task's computer has to be: asked of the driver once per task start
 * (`ExecDriver.acquire`).
 */
export interface TaskComputerSpec {
  taskId: string;
  /** The seat the task runs as; its GitHub identity, never its computer. */
  bot: string;
  /** The repository's key (`repoKeyOf`), for its database and its caches; null for a task on no repository. */
  repoKey: string | null;
  /**
   * Where the task's own directory should be: its clone (`wt/`), its
   * briefing (`context/`) and its home (`home/`). A driver may hand back
   * another (`TaskComputer.slotDir`); the one it hands back is the one used.
   */
  slotDir: string;
  /**
   * The subscription login its account needs: the account, when the seat is on
   * an OpenAI or xAI subscription, and null when it is on anything else and
   * should hold none.
   */
  login: { accountId: string; provider: 'openai' | 'xai' } | null;
  cpus: number;
  memoryGb: number;
  /** Whether the task gets a database of its own (`bots.sidecar_db`). */
  database: boolean;
}

/** A task's computer, as the driver made it. */
export interface TaskComputer {
  taskId: string;
  bot: string;
  /** The container it is, under a driver that makes one; null on the host. */
  container: string | null;
  /** Its own database, emptied, or null when it has none. */
  databaseUrl: string | null;
  /** The task's directory, at the same absolute path inside its computer as on the host. */
  slotDir: string;
  /**
   * Its repository's cache, shared by that repository's tasks on this host —
   * `/cache` in a container, a folder under the work root on the host — or
   * null for a task on no repository. Only npm's cache is kept there, which
   * checks what it holds against the lockfile's hash (`withRepoHome`).
   */
  cacheDir?: string | null;
  /** The repository it was made for (`repoKeyOf`), whose pnpm store it reads; null for none. */
  repoKey?: string | null;
}

/** A computer found on the host, whatever hostd remembers of it; what the reaper decides about. */
export interface FoundComputer {
  /** Its container's name, or its directory's under the local driver. */
  name: string;
  /** `warm`: made ahead of any task and not claimed yet. */
  kind: 'task' | 'warm';
  /** The task and seat its slot file names, or null for a warm one or one that says nothing. */
  taskId: string | null;
  bot: string | null;
  slotDir: string | null;
  running: boolean;
  /** The image id it runs, under docker. */
  image: string | null;
  repoKey: string | null;
}

/**
 * The one place that knows how a task's computer is reached. `docker` gives a
 * task a container; `local` runs the same tmux sessions on the host so a
 * development install needs no Docker. Everything above this interface —
 * tasks, sessions, the terminal, the console — is identical either way.
 *
 * A computer is per task: `acquire` makes it when a task starts and
 * `release` takes it down when the task ends. Sessions are still named and
 * listed per bot, because a seat is what the console shows; the driver keeps
 * which computer each of a bot's sessions is in.
 */
export interface ExecDriver {
  readonly kind: 'docker' | 'local';
  /**
   * A task's computer: made, or under the docker driver taken from what is
   * already running, with its database emptied and its directory in place.
   */
  acquire(spec: TaskComputerSpec): Promise<TaskComputer>;
  /**
   * Takes a task's computer down: its sessions, its database, its container
   * under docker, and its directory. Safe to call for a task that has none,
   * or twice. Whatever the task committed is the caller's to keep first.
   */
  release(taskId: string, reason: string): Promise<void>;
  /** The computer a task holds on this host, or null. */
  computerOf(taskId: string): TaskComputer | null;
  /** Every computer of this install's on the host, held or not; what the reaper walks. */
  computers?(): Promise<FoundComputer[]>;
  /** Takes a found computer back after hostd restarted, so its task is held again. */
  adopt?(found: FoundComputer): Promise<TaskComputer | null>;
  /** Removes a found computer nothing holds and no task needs. */
  discard?(name: string): Promise<void>;
  /** Whether a container is a warm computer the pool holds, unclaimed (`WarmPool`). */
  isWarm?(name: string): boolean;
  /** Brings the warm pool to its targets, where there is one. */
  refreshWarm?(): Promise<void>;
  /**
   * A bot's standing computer, where it has one: the local driver's idle
   * shell, so there is something to take over between tasks. Under docker a
   * bot has no computer of its own between tasks.
   */
  ensureBot(bot: string): Promise<void>;
  /**
   * Takes everything of a bot's down: every task computer it holds and every
   * session it has. Its work folder is left where it is. Used when a bot is
   * renamed, since sessions are named after the bot. Something already absent
   * is not a failure.
   */
  removeBot(bot: string): Promise<void>;
  /**
   * Where a session on this driver finds an account's login: the task's own
   * home inside a container, or the account's sign-in directory on the host.
   * What `CODEX_HOME` or `GROK_HOME` is set to.
   */
  loginPath(accountId: string): string;
  /**
   * An ssh-agent holding the bot's signing key, where the task's sessions can
   * reach it: inside its computer under docker, on the host otherwise. Git in
   * a session signs through `SSH_AUTH_SOCK`, and a socket is only reachable
   * from the machine it was made on — an agent started beside hostd was a path
   * that did not exist inside the container, and every signed commit failed.
   * Absent: the host's own agent is used, which is right for `local`.
   */
  startSigningAgent?(computer: TaskComputer, privateKey: string): Promise<SigningAgent | null>;
  startSession(input: {
    computer: TaskComputer;
    name: string;
    cwd: string;
    command: string[];
    env: Record<string, string>;
  }): Promise<SessionHandle>;
  /** Every session a bot has, across every computer it holds. */
  listSessions(bot: string): Promise<ObservedSession[]>;
  capturePane(bot: string, session: string, lines: number): Promise<string[]>;
  killSession(bot: string, session: string): Promise<void>;
  /** The command a terminal gateway runs to hand a person the keyboard. */
  attachCommand(bot: string, session: string): string[];
  /**
   * The repository's pnpm store filled from the lockfile in `worktree`, for
   * this computer to read; see `PnpmStore`. A driver without one gives each
   * task a store of its own, in its home.
   */
  fillPnpmStore?(computer: TaskComputer, worktree: string): Promise<PnpmFill>;
  /**
   * A command in a task's computer, or in a bot's standing one. With
   * `timeoutMs` the command, and whatever it started, is killed once that
   * has passed, and the result says it timed out.
   */
  exec(
    target: TaskComputer | { bot: string },
    command: string[],
    options?: ExecOptions,
  ): Promise<ExecResult>;
}

/** A running ssh-agent holding one bot's signing key, as its sessions reach it. */
export interface SigningAgent {
  /** `SSH_AUTH_SOCK`, as a session sees it. */
  socket: string;
  /** The key's public half, which git names as the signing key. */
  publicKey: string;
  /** The `ssh-keygen` a session should sign with, when one is known. */
  signer: string | null;
  stop(): Promise<void>;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** How long the command may run; see `KILL_AFTER_MS` for what follows. */
  timeoutMs?: number;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** It ran past its `timeoutMs` and was killed. */
  timedOut?: boolean;
}

/**
 * How long a command past its deadline has to stop after it is asked to,
 * before it is killed outright. A `make ci` that hangs on an open handle stops
 * at the first; one that ignores it does not stop at all.
 */
export const KILL_AFTER_MS = 30_000;
