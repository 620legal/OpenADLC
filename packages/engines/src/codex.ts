import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseMarkers, type EngineName } from '@fleetadlc/shared';
import { costOf } from './pricing.js';
import { commandExists, spawnJsonLines } from './process-engine.js';
import { toolsPolicyEnv } from './tools.js';
import type { Engine, EngineEvent, EngineRunInput, EngineUsage } from './types.js';

/**
 * One line of `codex exec --json`.
 *
 * Codex has written two shapes. The old one put every event under `msg`; the
 * one it writes now (0.155 does) says `thread.started`, `turn.completed` and
 * `item.started` / `item.completed`, each item carrying one message, command
 * or file change. The adapter knew only the old one, so everything a Codex
 * reviewer said was dropped: its task read "done", with nothing in its thread
 * and no review on the pull request, when it had said why it could not review.
 */
interface CodexEvent {
  type?: string;
  msg?: { type?: string; message?: string; text?: string; command?: string[] };
  item?: CodexItem;
  /** `input_tokens` includes `cached_input_tokens`. */
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
  /** On `thread.started`: the session, which `codex exec resume` takes back up. */
  thread_id?: string;
}

/** What one Codex session has done so far, read off its stream. */
interface Turn {
  thread: string | null;
  /** Ran a command or changed a file. */
  acted: boolean;
  /** Said anywhere in the turn that the work is someone else's now (`HANDS_OVER`). */
  handedOver: boolean;
}

/**
 * The markers that end a turn the way it should: a question or a plan change
 * for a person, or the work sent back to the stage before. Only the last
 * thing said was read, and only for a question, so a turn that sent its work
 * back was resumed and told to run the commands, after the bridge had moved
 * the card and released the lease.
 */
const HANDS_OVER = new Set(['question', 'plan_change', 'send_back']);

/**
 * How hard Codex thinks. Left unset, gpt-5.3-codex spent no reasoning at all,
 * and a review came back as one sentence of what it was about to do — marked
 * as its final answer, with nothing run.
 */
const REASONING_EFFORT = 'medium';

/** What a session that ended having only announced its plan is told, once. */
export const GET_ON_WITH_IT =
  'You ended your turn after saying what you would do, and did none of it. Do it now: run the commands and ' +
  'finish the task the way your instructions say. If something stops you, say exactly what it is.';

interface CodexItem {
  type?: string;
  /** An `agent_message`'s words. */
  text?: string;
  /** A `command_execution`'s command line. */
  command?: string;
  /** A `file_change`'s files. */
  changes?: { path?: string }[];
}

export interface CodexOptions {
  /**
   * The session runs in the bot's own container, which is its sandbox.
   *
   * Codex sandboxes each command itself, and on Linux it does that with
   * bubblewrap, which needs a user namespace an unprivileged container cannot
   * make. Every command a reviewer ran there failed with "bwrap: No permissions
   * to create a new namespace", and it gave up without reviewing. In a
   * container Codex runs without a sandbox of its own; beside hostd it keeps
   * it. Read from `FLEETADLC_CONTAINED`, which the container's session sets.
   */
  contained?: boolean;
}

const EFFORT = ['-c', `model_reasoning_effort="${REASONING_EFFORT}"`];

/**
 * Codex's usage analytics and its feedback upload, off unless the operator
 * opted back in: hostd sets `FLEETADLC_ENGINE_TELEMETRY=on` in the session
 * then, and the vendors' environment opt-outs otherwise
 * (`TELEMETRY_OPT_OUTS` in hostd's base-env.ts). Codex reads none of those
 * variables; these are its own config keys. Measured in the bot image, codex
 * 0.155.1: both are booleans its config loader checks (a string there is
 * refused with "expected a boolean"), and `[analytics] enabled = false` is
 * the opt-out its own help text names.
 */
export function telemetryOverrides(env: Record<string, string | undefined> = {}): string[] {
  const setting = env.FLEETADLC_ENGINE_TELEMETRY ?? process.env.FLEETADLC_ENGINE_TELEMETRY;
  return setting === 'on' ? [] : ['-c', 'analytics.enabled=false', '-c', 'feedback.enabled=false'];
}

/**
 * The worktree named untrusted, for this invocation only, so Codex loads
 * nothing from its `.codex/`.
 *
 * Codex reads a project's `.codex/config.toml` when it trusts the project, and
 * `codex exec` with a sandbox that may write trusts it on its own, writing
 * `trust_level = "trusted"` into the config home. Every session that runs
 * commands then spawned the `mcp_servers` a repository listed there, before
 * the first model call and with the session's GitHub token in its
 * environment: a builder could commit one to its branch for the reviewer that
 * came next. Marked untrusted, the project's layer is skipped whatever the
 * config home says, which leaves the home's settings and OpenADLC's flags.
 * Measured in the bot image, codex 0.155.1, on `exec` and `exec resume`. The
 * sandbox and approval policy are unchanged: `exec` holds approvals at
 * `never` either way. One inline table, since a dotted `-c projects."<path>"`
 * key is not read as one. The path as given and as resolved, since Codex
 * keys trust by the path it resolves.
 */
export function untrustedWorktree(workdir: string): string[] {
  const paths = new Set([resolve(workdir)]);
  try {
    paths.add(realpathSync(workdir));
  } catch {
    // A worktree that is not there yet has no `.codex/` to read either.
  }
  const entries = [...paths].map((path) => `${JSON.stringify(path)}={trust_level="untrusted"}`);
  return ['-c', `projects={${entries.join(',')}}`];
}

/** The attachments Codex takes as images, by extension (hostd names each by its type). */
const IMAGE = /\.(?:png|jpe?g|gif|webp)$/i;

/**
 * OpenAI Codex, non-interactive. By default the lead and security reviewers; any seat on an OpenAI account.
 *
 * What it takes from the worktree is the repository's AGENTS.md, which hostd
 * hands every engine anyway. Its `.codex/` (MCP servers, settings) does not
 * apply: the worktree is named untrusted on every invocation
 * (`untrustedWorktree`). The config home is never the worktree's: it is the
 * account's login directory (`CODEX_HOME`, which hostd makes) on a
 * subscription, and otherwise `.codex` in the task's own home, which hostd
 * makes outside the worktree. See docs/security.md.
 */
export class CodexEngine implements Engine {
  readonly name: EngineName = 'codex';
  private totals: EngineUsage = { tokensIn: 0, tokensOut: 0, costUsd: 0 };
  private readonly contained: boolean;

  constructor(
    private readonly binary = 'codex',
    options: CodexOptions = {},
  ) {
    this.contained = options.contained ?? process.env.FLEETADLC_CONTAINED === '1';
  }

  async available(): Promise<boolean> {
    return commandExists(this.binary);
  }

  usage(): EngineUsage {
    return { ...this.totals };
  }

  run(input: EngineRunInput): AsyncIterable<EngineEvent> {
    return this.runUntilItActs(input);
  }

  /**
   * One run, and one more in the same session when the first did nothing.
   *
   * A Codex turn can end on its plan: "I'll run `make ci`, then review the
   * diff", marked as the final answer, with no command run. The task then
   * ended with no review, and only a second try from the board got one. The
   * session is taken back up once and told to do it — it keeps everything it
   * read — unless it asked a person something or sent the work back, which is
   * its turn ending the way it should. What it says then is what the task
   * ends on.
   */
  private async *runUntilItActs(input: EngineRunInput): AsyncIterable<EngineEvent> {
    const turn: Turn = { thread: null, acted: false, handedOver: false };
    // An image given with the work is attached to the turn, which is how
    // Codex sees one; a PDF it reads with its tools from `attachments.md`. Not
    // on the resumed turn, which already has them. One `--image=a,b` token and
    // ahead of another flag: the option takes several values, and as `-i a`
    // before the prompt it would take the prompt for an image too. hostd's
    // file names have no commas (`safeFileName`).
    //
    // The prompt goes on stdin, named by `-`. As the last argument it met
    // Linux's 128 KiB cap on one argument: a review with a long thread or a
    // large attachment in its context failed with "spawn E2BIG" on every try.
    const images = (input.attachments ?? []).filter((path) => IMAGE.test(path));
    const exec = [
      'exec',
      '--json',
      '--model',
      input.model,
      ...this.sandboxArgs(input),
      ...EFFORT,
      ...telemetryOverrides(input.env),
      ...untrustedWorktree(input.workdir),
      ...(images.length > 0 ? [`--image=${images.join(',')}`] : []),
      '--skip-git-repo-check',
      '-',
    ];

    let finished: EngineEvent | null = null;
    for await (const event of this.spawn(input, exec, turn, input.prompt)) {
      if (event.type === 'done') {
        finished = event;
        continue;
      }
      yield event;
      if (event.type === 'error') return;
    }

    const idle = !turn.acted && turn.thread !== null && input.tools.allow.shell.length > 0;
    if (!idle || turn.handedOver || !turn.thread) {
      if (finished) yield finished;
      return;
    }

    const resume = [
      'exec',
      'resume',
      '--json',
      '--model',
      input.model,
      ...this.sandboxConfig(input),
      ...EFFORT,
      ...telemetryOverrides(input.env),
      ...untrustedWorktree(input.workdir),
      '--skip-git-repo-check',
      turn.thread,
      GET_ON_WITH_IT,
    ];
    yield* this.spawn(input, resume, turn);
  }

  private spawn(input: EngineRunInput, args: string[], turn: Turn, stdin?: string): AsyncIterable<EngineEvent> {
    return spawnJsonLines({
      command: this.binary,
      args,
      stdin,
      cwd: input.workdir,
      env: { ...input.env, ...toolsPolicyEnv(input.tools) },
      signal: input.signal,
      parse: (line) => {
        const events = this.parseLine(line, input.model, turn);
        for (const event of events) {
          if (event.type === 'tool_call' || event.type === 'file_change') turn.acted = true;
          if (event.type === 'text' && parseMarkers(event.text).some((marker) => HANDS_OVER.has(marker.event))) {
            turn.handedOver = true;
          }
        }
        return events;
      },
    });
  }

  /** `sandboxArgs` as `resume` takes it, which has no `--sandbox` of its own. */
  private sandboxConfig(input: EngineRunInput): string[] {
    const [, mode, ...rest] = this.sandboxArgs(input);
    return ['-c', `sandbox_mode="${mode}"`, ...rest];
  }

  /**
   * What Codex may do with the commands it runs. A skill that allows no shell
   * gets a read-only sandbox. One that does gets the worktree, and the network
   * — every skill that runs commands reaches GitHub with `gh` or `git push`,
   * and Codex's workspace sandbox keeps the network closed unless told. In a
   * container, no sandbox of Codex's own: see `CodexOptions.contained`.
   */
  private sandboxArgs(input: EngineRunInput): string[] {
    if (input.tools.allow.shell.length === 0) return ['--sandbox', 'read-only'];
    if (this.contained) return ['--sandbox', 'danger-full-access'];
    return ['--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true'];
  }

  private parseLine(line: string, model: string, turn?: Turn): EngineEvent[] {
    const event = JSON.parse(line) as CodexEvent;
    const events: EngineEvent[] = [];
    const kind = event.msg?.type ?? event.type;

    if (kind === 'thread.started' && typeof event.thread_id === 'string' && turn) turn.thread = event.thread_id;

    if (kind === 'agent_message' && event.msg?.message) {
      events.push({ type: 'text', text: event.msg.message });
    }
    if (kind === 'exec_command_begin' && event.msg?.command) {
      const command = event.msg.command.join(' ');
      events.push({ type: 'tool_call', name: 'shell', summary: command });
    }

    // The shape Codex writes now: one item per event.
    const item = event.item;
    if (kind === 'item.started' && item?.type === 'command_execution' && item.command) {
      events.push({ type: 'tool_call', name: 'shell', summary: item.command });
    }
    if (kind === 'item.completed' && item?.type === 'agent_message' && item.text) {
      events.push({ type: 'text', text: item.text });
    }
    if (kind === 'item.completed' && item?.type === 'file_change') {
      for (const change of item.changes ?? []) {
        if (change.path) events.push({ type: 'file_change', path: change.path });
      }
    }

    if (event.usage?.input_tokens || event.usage?.output_tokens) {
      const tokensIn = event.usage.input_tokens ?? 0;
      const tokensOut = event.usage.output_tokens ?? 0;
      const cachedTokensIn = event.usage.cached_input_tokens ?? 0;
      const costUsd = costOf(model, tokensIn, tokensOut, cachedTokensIn);
      this.totals = {
        tokensIn: this.totals.tokensIn + tokensIn,
        tokensOut: this.totals.tokensOut + tokensOut,
        costUsd: Math.round((this.totals.costUsd + costUsd) * 10_000) / 10_000,
      };
      events.push({ type: 'usage', tokensIn, tokensOut, costUsd, ...(cachedTokensIn > 0 ? { cachedTokensIn } : {}) });
    }
    if (kind === 'task_complete' || kind === 'turn_complete' || kind === 'turn.completed') {
      events.push({ type: 'done', reason: 'complete' });
    }

    return events;
  }
}
