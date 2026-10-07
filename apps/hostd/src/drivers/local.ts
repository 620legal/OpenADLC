import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { signInDir } from '@fleetadlc/backup';
import { loginDir } from '../logins.js';
import { readSlotTask, removeSlot, writeSlotTask } from '../worktree.js';
import { hostBaseEnv, withRepoHome } from './base-env.js';
import { FROM_ENV_FILE, sessionEnvFile } from './credential-env.js';
import { Tmux } from './tmux.js';
import { KILL_AFTER_MS } from './types.js';
import type { ExecDriver, ExecOptions, ExecResult, FoundComputer, ObservedSession, SessionHandle, TaskComputer, TaskComputerSpec } from './types.js';

const run = promisify(execFile);

const SESSION_PREFIX = 'fleetadlc__';
const SESSION_SEPARATOR = '__';
/** What sessions were named after before the rename; see `retireLegacySessions`. */
const LEGACY_SESSION_PREFIX = 'fleet__';

/**
 * The development driver: the same tmux sessions, on the host, with a per-bot
 * session-name prefix instead of a container boundary. It exists so `fleetadlc up`
 * works on a laptop with no Docker; it gives no isolation, which is why a
 * production install uses the docker driver.
 */
export class LocalDriver implements ExecDriver {
  readonly kind = 'local' as const;
  private readonly tmux: Tmux;
  /** Each task's computer — here only its directory — and the sessions started in it. */
  private readonly held = new Map<string, { computer: TaskComputer; sessions: Set<string> }>();

  constructor(
    private readonly tmuxBin: string,
    private readonly workRoot: string,
    private readonly loginRoot: string,
  ) {
    this.tmux = new Tmux(tmuxBin);
  }

  /**
   * The account's sign-in directory itself, as the CLI's home: Codex reads
   * `auth.json` from its home and has no other place to name. There is no
   * container to mount it into, so there is nothing to keep one bot from
   * reading another account's login either — which is what this driver
   * already says about everything else.
   */
  loginPath(accountId: string): string {
    return signInDir(loginDir(this.loginRoot, accountId));
  }

  /**
   * A bot name can contain a hyphen (`builder-2` is the second builder, and a
   * GitHub handle can have several), so the separator here must be something a
   * bot name cannot contain — and no login has two underscores. With a single
   * hyphen, `builder-2`'s shell appeared as a session named `2-shell` belonging
   * to `builder`, and take-over would attach to the wrong bot's session.
   */
  private sessionName(bot: string, name: string): string {
    return `${SESSION_PREFIX}${bot}${SESSION_SEPARATOR}${name}`;
  }

  private sessionPrefix(bot: string): string {
    return `${SESSION_PREFIX}${bot}${SESSION_SEPARATOR}`;
  }

  /**
   * A task's computer here is its directory and nothing else: there is no
   * container to make, and no database either. A task gets no `DATABASE_URL`
   * at all rather than the platform's — a bot that could reach `fleetadlc_db`
   * could rewrite its own ledger.
   */
  async acquire(spec: TaskComputerSpec): Promise<TaskComputer> {
    mkdirSync(spec.slotDir, { recursive: true });
    // Whose it is, for hostd after a restart: tmux on the host outlives it.
    writeSlotTask(spec.slotDir, { taskId: spec.taskId, bot: spec.bot });
    // The repository's cache on the host, as `/cache` is in a container.
    const cacheDir = spec.repoKey ? join(this.workRoot, 'cache', spec.repoKey) : null;
    if (cacheDir) mkdirSync(cacheDir, { recursive: true });
    const computer: TaskComputer = {
      taskId: spec.taskId,
      bot: spec.bot,
      container: null,
      databaseUrl: null,
      slotDir: spec.slotDir,
      cacheDir,
    };
    this.held.set(spec.taskId, { computer, sessions: new Set() });
    return computer;
  }

  /** The task directories under the work root that say whose they are. */
  async computers(): Promise<FoundComputer[]> {
    const root = join(this.workRoot, 'slots');
    if (!existsSync(root)) return [];
    const found: FoundComputer[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const slotDir = join(root, entry.name);
      const record = readSlotTask(slotDir);
      if (!record) continue;
      found.push({ name: entry.name, kind: 'task', taskId: record.taskId, bot: record.bot, slotDir, running: true, image: null, repoKey: null });
    }
    return found;
  }

  /** A task directory found after hostd restarted, held again with the sessions its task still has. */
  async adopt(found: FoundComputer): Promise<TaskComputer | null> {
    if (!found.taskId || !found.bot || !found.slotDir) return null;
    const existing = this.held.get(found.taskId);
    if (existing) return existing.computer;
    const computer: TaskComputer = { taskId: found.taskId, bot: found.bot, container: null, databaseUrl: null, slotDir: found.slotDir };
    const id8 = found.taskId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
    const prefix = this.sessionPrefix(found.bot);
    const sessions = new Set<string>();
    for (const session of await this.sessionsOrNone()) {
      if (session.name.startsWith(prefix) && session.name.endsWith(`-${id8}`)) sessions.add(session.name.slice(prefix.length));
    }
    this.held.set(found.taskId, { computer, sessions });
    return computer;
  }

  /**
   * Its sessions killed and its directory removed, once. Only a directory
   * under the work root is ever removed: the path came from hostd, but a
   * release is the one place here that deletes a tree.
   */
  async release(taskId: string, reason?: string): Promise<void> {
    void reason;
    const held = this.held.get(taskId);
    if (!held) return;
    this.held.delete(taskId);
    for (const name of held.sessions) await this.tmux.killSession(this.sessionName(held.computer.bot, name));
    const root = resolve(this.workRoot);
    const dir = resolve(held.computer.slotDir);
    if (dir.startsWith(`${root}${sep}`)) removeSlot(dir);
  }

  computerOf(taskId: string): TaskComputer | null {
    return this.held.get(taskId)?.computer ?? null;
  }

  /** The bot's folder, and an idle shell in it under the bot's name. */
  async ensureBot(bot: string): Promise<void> {
    const home = `${this.workRoot}/${bot}`;
    mkdirSync(home, { recursive: true });

    // Every bot keeps one idle shell, so there is always something to take over
    // even when the bot is doing nothing. A bot with only a shell is still a
    // working bot.
    const shell = this.sessionName(bot, 'shell');
    if (!(await this.tmux.hasSession(shell))) {
      await this.tmux
        .newSession({
          name: shell,
          cwd: home,
          command: ['bash', '-l'],
          env: { ...hostBaseEnv(), FLEETADLC_BOT: bot },
        })
        .catch(() => undefined);
    }
  }

  /**
   * Every session with this bot's prefix, the idle shell included, and every
   * task computer it holds. There is no container to remove here, and the
   * folder is the caller's to move.
   */
  async removeBot(bot: string): Promise<void> {
    for (const [taskId, held] of [...this.held]) {
      if (held.computer.bot === bot) await this.release(taskId);
    }
    const prefix = this.sessionPrefix(bot);
    for (const session of await this.sessionsOrNone()) {
      if (session.name.startsWith(prefix)) await this.tmux.killSession(session.name);
    }
  }

  /**
   * Sessions from before the rename, `fleet__<bot>__<name>`, at hostd's start.
   * Every list, kill and attach here looks for `fleetadlc__`, and `fleetadlc
   * down` leaves tmux running, so a task in flight through the upgrade went on
   * spending and pushing where Stop, the session list and the Terminal could
   * not see it. An idle shell is killed; one still running something is left
   * to finish, and said, with how to stop it.
   */
  async retireLegacySessions(): Promise<{ retired: string[]; kept: string[] }> {
    const result = { retired: [] as string[], kept: [] as string[] };
    for (const session of await this.sessionsOrNone()) {
      if (!session.name.startsWith(LEGACY_SESSION_PREFIX)) continue;
      const info = await this.tmux.paneInfo(session.name);
      const lastLine = (await this.tmux.capturePane(session.name, 50)).filter((line) => line.trim().length > 0).at(-1) ?? null;
      const state = stateFromPane(info?.cmd ?? '', lastLine, info?.dead ?? false);
      if (state === 'idle' || state === 'stopped') {
        await this.tmux.killSession(session.name);
        result.retired.push(session.name);
      } else {
        result.kept.push(session.name);
      }
    }
    for (const name of result.retired) console.log(`[hostd] removed ${name}, an idle session from before the rename`);
    for (const name of result.kept) {
      console.warn(
        `[hostd] ${name} is from before the rename and is still running a task; OpenADLC cannot see or stop it. ` +
          `Let it finish, or stop it: tmux kill-session -t '=${name}'`,
      );
    }
    return result;
  }

  async startSession(input: {
    computer: TaskComputer;
    name: string;
    cwd: string;
    command: string[];
    env: Record<string, string>;
  }): Promise<SessionHandle> {
    const bot = input.computer.bot;
    const session = this.sessionName(bot, input.name);
    this.held.get(input.computer.taskId)?.sessions.add(input.name);
    if (await this.tmux.hasSession(session)) {
      await this.tmux.killSession(session);
    }
    mkdirSync(input.cwd, { recursive: true });
    // The session's environment holds its GitHub token and its model key. On
    // the `tmux new-session … env -i K=V` command line they were in the
    // host's process list, so they go into a file only hostd's user can read,
    // which the session's shell reads, removes, and then runs the command
    // with nothing else, as the docker driver's does.
    const envFile = join(tmpdir(), `fleetadlc-env-${randomBytes(8).toString('hex')}`);
    writeFileSync(envFile, sessionEnvFile(withRepoHome(hostBaseEnv(), input.env)), { mode: 0o600, flag: 'wx' });
    try {
      await this.tmux.newSession({
        name: session,
        cwd: input.cwd,
        command: [...FROM_ENV_FILE, envFile, ...input.command],
        env: {},
      });
    } catch (error) {
      rmSync(envFile, { force: true });
      throw error;
    }
    const info = await this.tmux.paneInfo(session);
    return { bot, name: input.name, pid: info?.pid ?? null, cmd: input.command.join(' ') };
  }

  /**
   * tmux's sessions, or none when they could not be read, for the callers that
   * always read a failure that way. `listSessions` does not: the observer stops
   * a task whose session it cannot see, so a failure there has to say so.
   */
  private sessionsOrNone(): Promise<{ name: string; attached: boolean }[]> {
    return this.tmux.listSessions().catch(() => []);
  }

  async listSessions(bot: string): Promise<ObservedSession[]> {
    const prefix = this.sessionPrefix(bot);
    const sessions = await this.tmux.listSessions();
    const observed: ObservedSession[] = [];

    for (const session of sessions) {
      if (!session.name.startsWith(prefix)) continue;
      const name = session.name.slice(prefix.length);
      const info = await this.tmux.paneInfo(session.name);
      const pane = (await this.tmux.capturePane(session.name, 200)).filter((line) => line.trim().length > 0);
      const lastLine = pane.at(-1) ?? null;

      observed.push({
        bot,
        name,
        pid: info?.pid ?? null,
        cmd: info?.cmd ?? '',
        state: stateFromPane(info?.cmd ?? '', lastLine, info?.dead ?? false),
        lastLine,
        pane,
      });
    }

    return observed;
  }

  async capturePane(bot: string, session: string, lines: number): Promise<string[]> {
    return (await this.tmux.capturePane(this.sessionName(bot, session), lines)).filter(
      (line) => line.trim().length > 0,
    );
  }

  async killSession(bot: string, session: string): Promise<void> {
    await this.tmux.killSession(this.sessionName(bot, session));
  }

  attachCommand(bot: string, session: string): string[] {
    // The same binary the sessions were created with: a different tmux on PATH
    // has a different server and would report "no sessions".
    return [this.tmuxBin, 'attach', '-t', `=${this.sessionName(bot, session)}`];
  }

  async exec(
    target: TaskComputer | { bot: string },
    command: string[],
    options: ExecOptions = {},
  ): Promise<ExecResult> {
    void target;
    const [binary, ...args] = command;
    if (!binary) throw new Error('empty command');
    const cwd = options.cwd ?? this.workRoot;
    // The same rule as a session: the base environment and what was asked
    // for, never hostd's own, which holds the platform's database.
    const env = withRepoHome(hostBaseEnv(), options.env ?? {});
    if (options.timeoutMs) return execWithDeadline(binary, args, { cwd, env, timeoutMs: options.timeoutMs, killAfterMs: KILL_AFTER_MS });
    try {
      const { stdout, stderr } = await run(binary, args, { cwd, env, maxBuffer: EXEC_MAX_BUFFER });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
      return {
        code: typeof failure.code === 'number' ? failure.code : 1,
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? failure.message,
      };
    }
  }
}

/** What a command may print before the rest is dropped. */
const EXEC_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * A command that is killed, with everything it started, once its deadline
 * has passed: SIGTERM to its process group, then SIGKILL `killAfterMs` later.
 * Its own group, so `make ci`'s test runner and its workers go with it;
 * killing only `make` left them running. Not coreutils `timeout`, which a
 * Mac does not have.
 */
export function execWithDeadline(
  binary: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number; killAfterMs: number },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killer: NodeJS.Timeout | null = null;
    const keep = (text: string, chunk: Buffer) => (text.length < EXEC_MAX_BUFFER ? (text + chunk.toString()).slice(0, EXEC_MAX_BUFFER) : text);
    child.stdout.on('data', (chunk: Buffer) => (stdout = keep(stdout, chunk)));
    child.stderr.on('data', (chunk: Buffer) => (stderr = keep(stderr, chunk)));
    const signal = (name: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, name);
      } catch {
        // Already gone.
      }
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      signal('SIGTERM');
      killer = setTimeout(() => {
        signal('SIGKILL');
        // Something that left the group may still hold its output open.
        setTimeout(() => settle({ code: 137, stdout, stderr }), 1000).unref();
      }, options.killAfterMs);
    }, options.timeoutMs);
    const settle = (result: ExecResult) => {
      clearTimeout(deadline);
      if (killer) clearTimeout(killer);
      resolve(timedOut ? { ...result, timedOut: true } : result);
    };
    child.on('error', (error) => settle({ code: 1, stdout, stderr: stderr || error.message }));
    child.on('close', (code, signalName) => settle({ code: code ?? (signalName ? 128 + (signalName === 'SIGKILL' ? 9 : 15) : 1), stdout, stderr }));
  });
}

/** A pane holding a shell prompt is idle; one running a skill is working. */
export function stateFromPane(
  cmd: string,
  lastLine: string | null,
  dead: boolean,
): ObservedSession['state'] {
  if (dead) return 'stopped';
  if (lastLine && /waiting on a person|paused at the \$?\d+ cap|gate opened/i.test(lastLine)) return 'paused';
  if (['bash', 'sh', 'zsh', 'fish', 'tmux'].includes(cmd)) return 'idle';
  return 'working';
}
