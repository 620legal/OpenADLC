import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineName } from '@fleetadlc/shared';
import { shellRules } from './claude.js';
import { commandExists } from './process-engine.js';
import { addUsage, runStreamJson } from './stream-json.js';
import { resolveWriteScope, toolsPolicyEnv } from './tools.js';
import type { Engine, EngineEvent, EngineRunInput, EngineUsage, ToolsPolicy } from './types.js';

/**
 * The commands a task may not run: the skill's deny list, and `kubectl`
 * unless the skill lists it. Grok runs a fixed set of read-only commands
 * without asking, whatever the rules say (`ls`, `cat`, `head`, `git log`,
 * `rg`, …). Those read files and print facts about the machine, which a task
 * may do anyway, except `kubectl get`, `logs` and `describe`, which read a
 * cluster with whatever credentials the host has.
 */
function deniedCommands(tools: ToolsPolicy): string[] {
  const denied = [...tools.deny.shell];
  if (!tools.allow.shell.includes('kubectl') && !denied.includes('kubectl')) denied.push('kubectl');
  return denied;
}

/**
 * A shell startup file for the run's home that hands the shell the real home
 * back, then reads the first of `files` there, as the shell would have — and
 * then puts the run's own PATH in front again.
 *
 * grok runs its commands in a login shell, and a login shell reads
 * /etc/profile first, which in the bot image sets Debian's PATH. That dropped
 * /opt/fleetadlc/bin, where OpenADLC's gh and git are: a grok reviewer's
 * `gh pr review` went to the real gh, unsigned and without its header, and,
 * on an account three seats share, the bridge could not tell whose review it
 * was, so the lead was never asked. Claude and Codex do not start login shells.
 */
function startupShim(realHome: string, files: readonly string[], runPath: string | null): string {
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  return [
    '# OpenADLC: this home only carries the permission settings of one grok run.',
    `export HOME=${quote(realHome)}`,
    ...files.map((file, index) => `${index === 0 ? 'if' : 'elif'} [ -f "$HOME/${file}" ]; then . "$HOME/${file}"`),
    'fi',
    ...(runPath ? [`export PATH=${quote(runPath)}":$PATH"`] : []),
    '',
  ].join('\n');
}

/**
 * The home grok runs with: a directory of the run's own, holding the one
 * setting that makes the task's policy deny-by-default, and the startup files
 * that give the shell the real home back. Returns its path.
 */
function writeRunHome(dir: string, realHome: string, runPath: string | null): string {
  const home = join(dir, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true, mode: 0o700 });
  const settings = { permissions: { defaultMode: 'dontAsk' }, env: { HOME: realHome } };
  writeFileSync(join(home, '.claude', 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  // bash reads the first of these as a login shell, which is how grok takes
  // its snapshot of the environment; zsh reads `.zshenv` before anything.
  writeFileSync(join(home, '.bash_profile'), startupShim(realHome, ['.bash_profile', '.bash_login', '.profile'], runPath), {
    mode: 0o600,
  });
  writeFileSync(join(home, '.bashrc'), startupShim(realHome, ['.bashrc'], runPath), { mode: 0o600 });
  writeFileSync(join(home, '.zshenv'), startupShim(realHome, ['.zshenv'], runPath), { mode: 0o600 });
  return home;
}

export interface GrokEngineOptions {
  /** The Grok Build CLI. */
  binary?: string;
}

/**
 * Grok, driven through xAI's Grok Build CLI (`@xai-official/grok`, pinned in
 * the bot image) the way Claude Code and Codex are: headless, in the task's
 * worktree, under the task's tool policy, editing files and running commands.
 * `grok --output-format streaming-messages-json` writes the lines Claude
 * Code's `stream-json` does, so `stream-json.ts` reads both.
 *
 * The CLI signs in whichever way hostd set the task up: `XAI_API_KEY` for an
 * xAI key account, or `GROK_HOME` pointing at a shared `grok login` for a
 * SuperGrok subscription. Both arrive in the task's environment and are passed
 * through untouched.
 */
export class GrokEngine implements Engine {
  readonly name: EngineName = 'grok';
  private totals: EngineUsage = { tokensIn: 0, tokensOut: 0, costUsd: 0 };

  constructor(private readonly options: GrokEngineOptions = {}) {}

  private get binary(): string {
    return this.options.binary ?? 'grok';
  }

  async available(): Promise<boolean> {
    return commandExists(this.binary);
  }

  usage(): EngineUsage {
    return { ...this.totals };
  }

  run(input: EngineRunInput): AsyncIterable<EngineEvent> {
    return this.runCli(input);
  }

  // ------------------------------------------------------------------- the CLI

  /**
   * The task's tool policy, as Grok Build's permission rules, enforced as a
   * closed list: what the skill allows runs, and anything else is refused
   * while the run goes on, the way Claude Code's `-p` refuses it.
   *
   * What closes the list is `permissions.defaultMode: "dontAsk"` in the
   * `~/.claude/settings.json` of the home grok runs with, which `writeRunHome`
   * puts in the run's own directory. Read from there, grok 1.0.41 refuses a
   * call no rule allows with "denied by prompt policy (tool not
   * pre-approved)" and hands the refusal to the model. Asked for any other way
   * — `--permission-mode dontAsk`, `GROK_DEFAULT_PERMISSION_MODE`, or the same
   * file in the worktree (which headless grok does not read) or in grok's own
   * cwd — the call goes to an approval prompt, which a headless run answers
   * itself with "User cancelled", ending the whole run on `errors:
   * ["cancelled"]` with exit 0; a client that rejects it over ACP ends the
   * turn the same way. That is why this used to run under
   * `bypassPermissions`, where a command neither listed nor denied simply ran.
   *
   * The settings' `env.HOME` and the startup files beside them give the
   * commands grok runs the real home back, so their environment is what it
   * was, and the run's home keeps the host's own `~/.claude`, whose allow
   * rules would widen a bot's, out of it.
   *
   * On top of that:
   * - each allowed command is `Bash(git:*)`: git with any arguments, not
   *   `gitk`. A chain runs only when every part is allowed, and `$(…)`,
   *   subshells, loops and `bash -c` are refused whole;
   * - each denied command, and `kubectl` unless the skill lists it (see
   *   `deniedCommands`), is denied as `Bash(curl:*)`; a skill that allows no
   *   shell denies `Bash` outright, grok's read-only commands included;
   * - a skill with a write scope may edit inside the worktree, `Edit(./**)`,
   *   and one without denies `Edit` and `Write`, which grok also applies to a
   *   command that writes a file (`>`, `touch`, `sed -i`);
   * - `--permission-mode default` holds against an always-approve in the
   *   shared login's `config.toml`, which would reopen every command.
   * Reads are always allowed. Other tools that are not read-only — image
   * generation, the scheduler, subagents — are refused too; under
   * `bypassPermissions` a subagent started despite `--no-subagents`.
   *
   * Measured on 2026-09-24 with grok 1.0.41: first against a stand-in model
   * endpoint, then through this engine in the bot image with a subscription
   * login and grok-4.7, four runs. The builder's `git --version` ran, `uname
   * -a` was refused by the prompt policy, `curl --version` by its deny rule,
   * `git status && uname` whole, a write inside the worktree landed and one
   * to /tmp was refused. The second reviewer's policy ran git and refused
   * `nc -h` and a write; one with no shell and no write scope refused both.
   * Every run ended with `is_error: false` and exit 0.
   *
   * Web search and fetch are off because no skill grants the network, and
   * subagents and plan mode are off because a task is one agent doing the
   * work, not one planning it for approval.
   */
  private args(input: EngineRunInput, promptFile: string, leaderSocket: string): string[] {
    const { allow } = input.tools;
    const writes = resolveWriteScope(input.tools, []).length > 0;
    const allowed = [...shellRules(allow.shell), ...(writes ? ['Edit(./**)', 'Write(./**)'] : [])];
    const denied = [
      ...(allow.shell.length === 0 ? ['Bash'] : shellRules(deniedCommands(input.tools))),
      ...(writes ? [] : ['Edit', 'Write']),
    ];

    return [
      '--prompt-file',
      promptFile,
      '--output-format',
      'streaming-messages-json',
      '--model',
      input.model,
      '--leader-socket',
      leaderSocket,
      '--permission-mode',
      'default',
      ...allowed.flatMap((rule) => ['--allow', rule]),
      ...denied.flatMap((rule) => ['--deny', rule]),
      '--disable-web-search',
      '--no-subagents',
      '--no-plan',
      // Never `--trust`. Grok loads a folder's own hooks, MCP servers and
      // instructions only once the folder is trusted, and the worktree is a
      // managed repository's checkout that a builder can commit to: trusted,
      // a hook committed there would run in the next session on that branch,
      // outside the skill's tools.yaml.
    ];
  }

  private runCli(input: EngineRunInput): AsyncIterable<EngineEvent> {
    const self = this;

    async function* generate(): AsyncIterable<EngineEvent> {
      // Grok serves sessions from a background leader it finds at
      // `leader.sock` in its home unless told otherwise. Bots on one
      // subscription share one GROK_HOME for its login, and must not share a
      // leader, so each run gets a socket of its own in a directory of its own
      // under the OS temp dir, which goes when the run does.
      //
      // The prompt goes beside it. Headless grok does not read a prompt from
      // stdin, and in argv it would meet the kernel's cap on one argument
      // (128 KiB on Linux) — the skill runner's prompt carries whole context
      // files. mkdtemp makes the directory 0700; the file is 0600 as well.
      //
      // So does the home grok runs with (see `args`). GROK_HOME is named
      // outright, so that a run signed in with a key keeps the `~/.grok` it
      // always had instead of starting one in that home; a subscription's
      // shared login arrives in it already.
      const dir = mkdtempSync(join(tmpdir(), 'fleetadlc-grok-'));
      try {
        const promptFile = join(dir, 'prompt.md');
        writeFileSync(promptFile, input.prompt, { mode: 0o600 });
        const realHome = input.env.HOME || process.env.HOME || homedir();
        const grokHome = input.env.GROK_HOME || process.env.GROK_HOME || join(realHome, '.grok');

        yield* runStreamJson({
          command: self.binary,
          args: self.args(input, promptFile, join(dir, 'leader.sock')),
          cwd: input.workdir,
          env: {
            ...input.env,
            ...toolsPolicyEnv(input.tools),
            HOME: writeRunHome(dir, realHome, input.env.PATH ?? process.env.PATH ?? null),
            GROK_HOME: grokHome,
            // The image sets this too; a host without the image may not. A CLI
            // that updates itself mid-task is a version nobody pinned.
            GROK_DISABLE_AUTOUPDATER: '1',
            // Unset, grok uploads session traces (the whole prompt, tool
            // output with file contents, snapshots of the codebase) whenever
            // the account opted into sharing coding data, or xAI's remote
            // settings say so. Every bot on a subscription shares its login, so
            // one opt-in made anywhere would send a private repository to xAI.
            GROK_TELEMETRY_TRACE_UPLOAD: '0',
            GROK_FEEDBACK_ENABLED: '0',
          },
          signal: input.signal,
          model: input.model,
          onUsage: (usage) => {
            self.totals = addUsage(self.totals, usage);
          },
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    return generate();
  }
}
