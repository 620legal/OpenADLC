import { dirname } from 'node:path';
import type { EngineName } from '@openadlc/shared';
import { commandExists } from './process-engine.js';
import { addUsage, runStreamJson } from './stream-json.js';
import { resolveWriteScope, toolsPolicyEnv } from './tools.js';
import type { Engine, EngineEvent, EngineRunInput, EngineUsage } from './types.js';

/**
 * A task's shell commands as Claude Code permission rules, one per command.
 *
 * They were written as one rule, `Bash(make,pnpm,git,…)`, which Claude Code
 * reads as the single literal command "make,pnpm,git,…". Nothing a bot ran
 * ever matched it, so every shell call needed approval, and a headless run
 * refuses what needs approval: no `make ci`, no commit, no pull request.
 * Measured in the bot image on 2026-09-24 with claude 2.1.278: `git --version`
 * came back "This command requires approval" under the old rule and ran under
 * `Bash(git:*)`. The deny list had the same shape, and so denied nothing.
 */
export function shellRules(commands: readonly string[]): string[] {
  return commands.map((command) => `Bash(${command}:*)`);
}

/**
 * How long Claude Code's shell gives a command, by default and at most: ten
 * minutes, its own ceiling. Its default is two. On #22 that default sent a
 * builder's `openadlc-ci` to the background mid-run; the builder ended its
 * turn to wait for it, the headless session exited, and hostd took the task's
 * computer down with `make ci` still running. `openadlc-ci` waits in steps of
 * eight minutes, which fit inside this whether or not the model asks for a
 * timeout. Set over the session's environment and the runner's, though
 * neither sets them today: a session starts under `env -i` with a fixed list
 * (`apps/hostd/src/drivers/base-env.ts`), so a person's own never reaches it.
 * A lower value handed to a session later would bring the same failure back.
 */
const SHELL_TIMEOUT_ENV: Readonly<Record<string, string>> = {
  BASH_DEFAULT_TIMEOUT_MS: '600000',
  BASH_MAX_TIMEOUT_MS: '600000',
};

/** The folders a run's attachments are in, each once. */
export function attachmentDirs(input: Pick<EngineRunInput, 'attachments'>): string[] {
  return [...new Set((input.attachments ?? []).map((path) => dirname(path)))];
}

/**
 * Claude Code, driven headless. By default (config/bots.yaml) intake, the
 * system engineer, builders, SRE and QA; any seat on an Anthropic account.
 */
export class ClaudeEngine implements Engine {
  readonly name: EngineName = 'claude';
  private totals: EngineUsage = { tokensIn: 0, tokensOut: 0, costUsd: 0 };

  constructor(private readonly binary = 'claude') {}

  async available(): Promise<boolean> {
    return commandExists(this.binary);
  }

  usage(): EngineUsage {
    return { ...this.totals };
  }

  private args(input: EngineRunInput): string[] {
    const writes = resolveWriteScope(input.tools, []).length > 0;
    const allowed = ['Read', 'Grep', 'Glob', ...shellRules(input.tools.allow.shell), ...(writes ? ['Edit', 'Write'] : [])];
    // Left off the allowed list is not refused: every run is in `acceptEdits`,
    // the mode that accepts a file edit without asking, so a skill with no
    // write scope could still edit. Refused outright, as Grok's `--deny` does.
    const disallowed = [...shellRules(input.tools.deny.shell), ...(writes ? [] : ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])];

    return [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      input.model,
      '--permission-mode',
      'acceptEdits',
      // Settings from the task's own home only, and no MCP server but the
      // ones passed here (none). Without these Claude Code loaded the
      // worktree's own configuration: a SessionStart or PreToolUse hook in
      // `.claude/settings.json` ran with the session's GitHub token and model
      // key, servers in `.mcp.json` were spawned, and `CLAUDE.md` was read as
      // instructions, so a builder that committed one to its branch ran it in
      // the next Claude session there, outside the skill's tools.yaml. AGENTS.md
      // still reaches the session, as a context file hostd hands over.
      // `--bare` would also stop them, and never reads OAuth, so it breaks a
      // seat on a Claude subscription; `--restricted` takes Bash away. Nothing
      // is deleted from the worktree either: a builder's `git add -A` would
      // commit the deletion of a repository's own configuration.
      '--setting-sources',
      'user',
      '--strict-mcp-config',
      '--allowedTools',
      allowed.join(' '),
      ...(disallowed.length > 0 ? ['--disallowedTools', disallowed.join(' ')] : []),
      // The files given with the work live beside the task's context, outside
      // the worktree, where Read would ask for a permission a headless run
      // cannot be given. Their folder is added, and nothing else.
      ...attachmentDirs(input).flatMap((dir) => ['--add-dir', dir]),
    ];
  }

  run(input: EngineRunInput): AsyncIterable<EngineEvent> {
    return runStreamJson({
      command: this.binary,
      args: this.args(input),
      cwd: input.workdir,
      // Claude Code updates itself unless told not to, into a prefix the bot
      // can write, and a bot whose engine changed under it is a change nobody
      // made. The image sets this too; a session is where it has to hold.
      env: { ...input.env, ...toolsPolicyEnv(input.tools), ...SHELL_TIMEOUT_ENV, DISABLE_AUTOUPDATER: '1' },
      stdin: input.prompt,
      signal: input.signal,
      model: input.model,
      growingOutput: true,
      onUsage: (usage) => {
        this.totals = addUsage(this.totals, usage);
      },
    });
  }
}
