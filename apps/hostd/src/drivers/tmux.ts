import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isCredentialEnv } from './credential-env.js';

const run = promisify(execFile);

/**
 * Separates the fields of a `-F` format. It is not a tab: tmux rewrites control
 * characters in format output to '_', so a tab-separated format comes back as
 * one run-together field — `#{session_name}\t#{session_attached}` reads as
 * `fleetadlc__mira__shell_0`, a session name that does not exist, and every attach
 * fails with "can't find session". Any printable character is safe; this one
 * appears in no session name and no process name.
 */
const FIELD = '|';

/**
 * How long one tmux command may take before it is killed. Each answers at once
 * when tmux is well; the observer runs them every ten seconds, and with no
 * limit a tmux server that stopped answering parked every tick on its first call.
 */
export const TMUX_TIMEOUT_MS = 30_000;

/** What tmux says when there is no server to list, which is no sessions rather than a failure. */
const NO_SERVER = /no server running on|error connecting to .*\(No such file or directory\)/;

export interface TmuxResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * tmux is how a bot's work stays attachable: hostd starts the session, the
 * console's terminal panel attaches to it, and detaching never kills anything.
 * Session names cannot contain ':' or '.', so the console displays `bot/skill`.
 */
export class Tmux {
  constructor(
    private readonly bin: string,
    /** Wraps the tmux call when the session lives inside a container. */
    private readonly wrap: (args: string[]) => { command: string; args: string[] } = (args) => ({
      command: 'tmux',
      args,
    }),
    /**
     * Runs the wrapped command, when the caller has its own way to: the
     * docker driver's, which a test answers for.
     */
    private readonly runner?: (command: string, args: string[]) => Promise<TmuxResult>,
    /** How long tmux may take when run here rather than by `runner`; see TMUX_TIMEOUT_MS. */
    private readonly timeoutMs = TMUX_TIMEOUT_MS,
  ) {}

  private invoke(args: string[]): Promise<TmuxResult> {
    const wrapped = this.wrap(args);
    const command = wrapped.command === 'tmux' ? this.bin : wrapped.command;
    if (this.runner) return this.runner(command, wrapped.args);
    return run(command, wrapped.args, { maxBuffer: 8 * 1024 * 1024, timeout: this.timeoutMs, killSignal: 'SIGKILL' })
      .then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }))
      .catch((error: NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string; killed?: boolean; signal?: string }) => ({
        code: typeof error.code === 'number' ? error.code : 1,
        stdout: error.stdout ?? '',
        stderr:
          error.killed && error.signal === 'SIGKILL'
            ? `${command} did not answer within ${this.timeoutMs / 1000} s`
            : (error.stderr ?? error.message),
      }));
  }

  async hasSession(name: string): Promise<boolean> {
    const result = await this.invoke(['has-session', '-t', `=${name}`]);
    return result.code === 0;
  }

  /**
   * The session runs under `env -i`, so it starts from the environment hostd
   * assembled for it and nothing else. tmux's own `-e` adds variables to a
   * session but cannot take away the ones the tmux server inherited when it
   * started, and hostd's environment holds the platform's database URL — which
   * a bot must never see, because `fleetadlc_db` is where its ledger and its audit
   * trail live.
   *
   * `env` is on tmux's command line, which every process can read, so it
   * refuses a credential: a session's own environment goes in a file it
   * reads instead (`FROM_ENV_FILE`).
   */
  async newSession(input: {
    name: string;
    cwd: string;
    command: string[];
    env: Record<string, string>;
  }): Promise<void> {
    const credential = Object.keys(input.env).find(isCredentialEnv);
    if (credential) throw new Error(`${credential} is a credential, and tmux's command line is not the place for it: hand it to the session in a file`);
    const assignments = Object.entries(input.env).map(([key, value]) => `${key}=${value}`);
    const result = await this.invoke([
      'new-session',
      '-d',
      '-s',
      input.name,
      '-c',
      input.cwd,
      '/usr/bin/env',
      '-i',
      ...assignments,
      ...input.command,
    ]);
    if (result.code !== 0) throw new Error(`tmux new-session failed: ${result.stderr.trim()}`);
  }

  /**
   * The sessions tmux has, none when no tmux server is running. Any other
   * failure throws: it read as "every session is gone", and the observer
   * stopped each running task and removed its computer over one failed
   * `docker exec`. tmux 3.3a also exits 1 for `error connecting to …
   * (Permission denied)` while its server is alive, so only a missing server
   * or socket counts as none.
   */
  async listSessions(): Promise<{ name: string; attached: boolean }[]> {
    const result = await this.invoke(['list-sessions', '-F', `#{session_name}${FIELD}#{session_attached}`]);
    if (result.code !== 0) {
      if (NO_SERVER.test(result.stderr)) return [];
      throw new Error(`tmux list-sessions failed: ${result.stderr.trim() || `exit ${result.code}`}`);
    }
    return result.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        // A session name cannot hold the delimiter, but read from the right
        // anyway: the trailing field is the fixed one.
        const cut = line.lastIndexOf(FIELD);
        if (cut < 0) return { name: line, attached: false };
        return { name: line.slice(0, cut), attached: line.slice(cut + FIELD.length) !== '0' };
      });
  }

  async paneInfo(session: string): Promise<{ pid: number | null; cmd: string; dead: boolean } | null> {
    const result = await this.invoke([
      'list-panes',
      '-t',
      `=${session}`,
      '-F',
      `#{pane_pid}${FIELD}#{pane_current_command}${FIELD}#{pane_dead}`,
    ]);
    if (result.code !== 0) return null;
    const line = result.stdout.split('\n').find(Boolean);
    if (!line) return null;
    // The command is the free-form field, so bound it by the two fixed ones
    // rather than splitting: a command holding the delimiter must not shift
    // `dead` out of place and report a live pane as dead.
    const first = line.indexOf(FIELD);
    const last = line.lastIndexOf(FIELD);
    if (first < 0 || last === first) return null;
    const pid = line.slice(0, first);
    const cmd = line.slice(first + FIELD.length, last);
    const dead = line.slice(last + FIELD.length);
    return { pid: Number(pid) || null, cmd, dead: dead === '1' };
  }

  async capturePane(session: string, lines: number): Promise<string[]> {
    // A pane, named by its session: `=name` alone is a session target, which
    // capture-pane refuses ("can't find pane"), so every pane read came back
    // empty and the Computer tab said "nothing running" over a working
    // session. `=name:` is that session's current window and pane.
    const result = await this.invoke(['capture-pane', '-p', '-t', `=${session}:`, '-S', `-${lines}`]);
    if (result.code !== 0) return [];
    return result.stdout.split('\n');
  }

  async killSession(session: string): Promise<void> {
    await this.invoke(['kill-session', '-t', `=${session}`]);
  }
}
