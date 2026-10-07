import type { EngineName } from '@fleetadlc/shared';
import { ClaudeEngine } from './claude.js';
import { CodexEngine } from './codex.js';
import { GrokEngine } from './grok.js';
import { commandExists } from './process-engine.js';

/**
 * Whether a bot could actually think, asked before it is given work.
 *
 * Nothing in setup ever mentioned this. An install could finish every step of
 * the walkthrough, report itself complete, and have no engine at all — and the
 * first sign of it was a task failing with "engine claude is not available on
 * this host" after somebody had filed a request and gone to watch the board.
 *
 * It is answered per bot rather than per engine because each bot may use a
 * different credential. `session-env.ts` reads the bot's model account and
 * puts that key in the task's environment as the variable the provider reads.
 * A bot with no account still falls back to `engineKeyRef(bot)`, kept for
 * installs that stored a per-bot key before model accounts existed. A
 * subscription has no key to store; whether its CLI is signed in is only
 * known when a task runs.
 *
 * What it can and cannot know is stated rather than glossed. A key is either
 * stored or it is not. A CLI's `commandExists` proves a binary is on the PATH
 * and nothing about whether it is signed in — so an engine behind a CLI with no
 * key is reported as exactly that, and a key is what turns it into an answer.
 */

export type Confidence = 'certain' | 'binary-only';

/** Where a key for this engine comes from, for a page that offers to take one. */
export interface KeySource {
  /** The variable the engine reads, which is what `session-env.ts` sets. */
  envVar: string;
  /** Where to get one. */
  url: string;
  label: string;
}

export interface EngineReadiness {
  engine: EngineName;
  ready: boolean;
  confidence: Confidence;
  detail: string;
  remedy: string;
  /** Null for an engine that takes no key. */
  keySource: KeySource | null;
  /** Whether a key is stored for this bot. */
  hasKey: boolean;
  /** Whether the engine's command is on the host, for engines that need one. */
  needsCommand: string | null;
  hasCommand: boolean;
}

const KEY_SOURCES: Partial<Record<EngineName, KeySource>> = {
  claude: {
    envVar: 'ANTHROPIC_API_KEY',
    url: 'https://console.anthropic.com/settings/keys',
    label: 'Anthropic Console',
  },
  codex: {
    envVar: 'OPENAI_API_KEY',
    url: 'https://platform.openai.com/api-keys',
    label: 'OpenAI platform',
  },
  grok: { envVar: 'XAI_API_KEY', url: 'https://console.x.ai/', label: 'xAI Console' },
};

/** Engines that run a command on the host. */
const COMMANDS: Partial<Record<EngineName, string>> = { claude: 'claude', codex: 'codex', grok: 'grok' };

export interface ReadinessInput {
  engine: EngineName;
  /** Whether a key is stored for this bot: its model account, or the per-bot fallback. */
  hasKey: boolean;
  /**
   * How to ask whether a command exists, because *where* to ask depends on
   * where the task will run.
   *
   * Under the local driver a bot is a process beside hostd and shares its PATH,
   * so asking hostd's own filesystem is right. Under the docker driver the bot
   * is a container built from the bot image, and hostd's image is a plain node
   * base with no engine CLI in it at all — so the default probe answers about
   * the wrong filesystem and reports every bot as unable to run while their
   * containers would have run fine.
   */
  hasCommand?: (command: string) => Promise<boolean>;
}

export async function engineReadiness(input: ReadinessInput): Promise<EngineReadiness> {
  const { engine } = input;

  if (engine === 'none') {
    return {
      engine,
      ready: true,
      confidence: 'certain',
      detail: 'this bot does not run a model',
      remedy: '',
      keySource: null,
      hasKey: false,
      needsCommand: null,
      hasCommand: true,
    };
  }

  const keySource = KEY_SOURCES[engine] ?? null;
  const command = COMMANDS[engine] ?? null;
  const probe = input.hasCommand ?? ((name: string) => commandExists(name));
  const hasCommand = command ? await probe(command).catch(() => false) : true;
  // Either the bot's own stored key, or the one hostd was started with.
  const hasKey = input.hasKey || Boolean(process.env[keySource?.envVar ?? '']);

  const base = { engine, keySource, hasKey, needsCommand: command, hasCommand };

  if (command && !hasCommand) {
    // Grok was once reported ready here on a key alone, as a chat completion
    // with no tools. No skill can work like that: a review is posted with
    // `gh`, so every task on the seat spent tokens and ended with nothing done.
    return {
      ...base,
      ready: false,
      confidence: 'certain',
      detail: `the \`${command}\` command is not on this host`,
      remedy:
        `install ${command} on the host, or under the docker driver rebuild the bot image ` +
        '(infra/local/build-bot-image.sh) — a key alone will not do, this engine runs as a command',
    };
  }

  if (hasKey) {
    // The whole answer: the command is here and it has a credential to use.
    return {
      ...base,
      ready: true,
      confidence: 'certain',
      detail: command ? `\`${command}\` is here and has a key` : 'a key is stored',
      remedy: '',
    };
  }

  if (!command) {
    return {
      ...base,
      ready: false,
      confidence: 'certain',
      detail: `no ${keySource?.envVar ?? 'key'} for this bot`,
      remedy: `paste a key from ${keySource?.label ?? 'the provider'}`,
    };
  }

  // A binary, no key. It may be signed in from a shell somebody ran once, and
  // it may not — which is the way this fails that looks most like working.
  return {
    ...base,
    ready: true,
    confidence: 'binary-only',
    detail: `\`${command}\` is here, but no key is stored — whether it is signed in is only known when a task runs`,
    remedy: `paste a key from ${keySource?.label ?? 'the provider'} to make this certain`,
  };
}

/** One answer per bot, because the key is per bot. */
export async function readinessFor(
  bots: { bot: string; engine: EngineName }[],
  hasKey: (bot: string) => Promise<boolean>,
  hasCommand?: (command: string) => Promise<boolean>,
): Promise<{ bot: string; readiness: EngineReadiness }[]> {
  return Promise.all(
    bots.map(async (one) => ({
      bot: one.bot,
      readiness: await engineReadiness({
        engine: one.engine,
        hasKey: await hasKey(one.bot),
        hasCommand,
      }),
    })),
  );
}

/**
 * Asks the bot image rather than this filesystem, and remembers the answer.
 *
 * One `docker run` per command, not per bot: nine bots on the same engine is
 * one question. The image does not change while hostd is up — and if it does,
 * hostd is restarted to pick it up, which clears this with it.
 */
export function commandInImage(
  image: string,
  run: (command: string, args: string[]) => Promise<boolean>,
): (command: string) => Promise<boolean> {
  const asked = new Map<string, Promise<boolean>>();

  return (command: string) => {
    const seen = asked.get(command);
    if (seen) return seen;

    const answer = run('docker', [
      'run',
      '--rm',
      '--entrypoint',
      'sh',
      image,
      '-c',
      `command -v ${command}`,
    ]).catch(() => false);

    asked.set(command, answer);
    return answer;
  };
}
