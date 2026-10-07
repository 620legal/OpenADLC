import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandInImage, engineReadiness, readinessFor } from './readiness.js';

/**
 * Asking early what `chooseEngine` asks late, and per bot, because each bot
 * may use a different credential: its model account's key, or for a bot with
 * no account the per-bot key (`engineKeyRef(bot)`) an install stored before
 * model accounts existed.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('grok, which runs Grok Build', () => {
  /**
   * Grok used to be a chat completion, so a key was the whole answer. It is
   * now a command like the other two — in the bot image under the docker
   * driver — and nothing else: without the command it cannot run.
   */
  const installed = async () => true;
  const missing = async () => false;

  it('asks for the `grok` command, where the task will run', async () => {
    const asked: string[] = [];

    const readiness = await engineReadiness({
      engine: 'grok',
      hasKey: false,
      hasCommand: async (command) => {
        asked.push(command);
        return true;
      },
    });

    expect(asked).toEqual(['grok']);
    expect(readiness.needsCommand).toBe('grok');
  });

  it('is certain with its command and a key', async () => {
    const readiness = await engineReadiness({ engine: 'grok', hasKey: true, hasCommand: installed });

    expect(readiness.ready).toBe(true);
    expect(readiness.confidence).toBe('certain');
  });

  it('is only binary-deep with its command and no key, as a subscription is', async () => {
    // A SuperGrok login has no key to store; whether it is signed in is only
    // known when a task runs, the same as a Claude subscription.
    vi.stubEnv('XAI_API_KEY', '');

    const readiness = await engineReadiness({ engine: 'grok', hasKey: false, hasCommand: installed });

    expect(readiness.ready).toBe(true);
    expect(readiness.confidence).toBe('binary-only');
    expect(readiness.remedy).toMatch(/paste a key/);
  });

  it('is not ready on a key without its command', async () => {
    // It was reported ready, and fell back to a chat completion with no tools. No
    // skill can work like that — a review is posted with `gh` — so every task
    // on the seat spent tokens and ended without posting anything.
    vi.stubEnv('XAI_API_KEY', '');

    const readiness = await engineReadiness({ engine: 'grok', hasKey: true, hasCommand: missing });

    expect(readiness.ready).toBe(false);
    expect(readiness.confidence).toBe('certain');
    expect(readiness.hasCommand).toBe(false);
    expect(readiness.detail).toBe('the `grok` command is not on this host');
    expect(readiness.remedy).toMatch(/install grok on the host/);
    expect(readiness.remedy).toMatch(/rebuild the bot image/);
    expect(readiness.remedy).not.toMatch(/paste a key|xAI Console|API call/);
  });

  it('is not ready on the key hostd was started with either', async () => {
    vi.stubEnv('XAI_API_KEY', 'xai-from-the-environment');

    expect((await engineReadiness({ engine: 'grok', hasKey: false, hasCommand: missing })).ready).toBe(false);
  });

  it('accepts the key hostd was started with, beside its command', async () => {
    vi.stubEnv('XAI_API_KEY', 'xai-from-the-environment');

    const readiness = await engineReadiness({ engine: 'grok', hasKey: false, hasCommand: installed });

    expect(readiness.confidence).toBe('certain');
    expect(readiness.keySource?.envVar).toBe('XAI_API_KEY');
  });
});

describe('an engine that runs a command', () => {
  // The probe is given, not the host's PATH: asked of the machine running the
  // tests, each of these asserted only where the CLI happened to be installed
  // (or missing), and passed having checked nothing everywhere else.
  const installed = async () => true;
  const missing = async () => false;

  it('is not fixed by a key when the command is missing', async () => {
    // The honest half. Pasting a key does not install a binary, and offering it
    // as though it would is how somebody pastes a key and stays broken.
    const readiness = await engineReadiness({ engine: 'codex', hasKey: true, hasCommand: missing });

    expect(readiness.ready).toBe(false);
    expect(readiness.remedy).toMatch(/a key alone will not do/);
  });

  it('is only binary-deep without a key', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const readiness = await engineReadiness({ engine: 'claude', hasKey: false, hasCommand: installed });

    // `commandExists` proves a binary, not a session.
    expect(readiness.confidence).toBe('binary-only');
    expect(readiness.remedy).toMatch(/paste a key/);
  });

  it('becomes certain once a key is stored for that bot', async () => {
    // The point of the whole change: a tilde becomes a tick, because the task's
    // environment now carries a credential rather than hoping for a login.
    const readiness = await engineReadiness({ engine: 'claude', hasKey: true, hasCommand: installed });

    expect(readiness.ready).toBe(true);
    expect(readiness.confidence).toBe('certain');
    expect(readiness.remedy).toBe('');
  });

  it('names the variable the task environment will carry', async () => {
    const readiness = await engineReadiness({ engine: 'claude', hasKey: false, hasCommand: installed });
    expect(readiness.keySource?.envVar).toBe('ANTHROPIC_API_KEY');
  });
});

describe('a bot with no model', () => {
  it('is ready, because there is nothing to set up', async () => {
    const readiness = await engineReadiness({ engine: 'none', hasKey: false });

    expect(readiness.ready).toBe(true);
    expect(readiness.keySource).toBeNull();
    expect(readiness.remedy).toBe('');
  });
});

describe('a crew of nine', () => {
  it('asks about each bot, because one may have a key and another not', async () => {
    const keyed = new Set(['sydney']);

    const answers = await readinessFor(
      [
        { bot: 'sydney', engine: 'claude' },
        { bot: 'nova', engine: 'claude' },
      ],
      async (bot) => keyed.has(bot),
    );

    expect(answers.find((one) => one.bot === 'sydney')?.readiness.hasKey).toBe(true);
    expect(answers.find((one) => one.bot === 'nova')?.readiness.hasKey).toBe(false);
  });
});

describe('where the engine command is looked for', () => {
  /**
   * Under the docker driver a bot is a container built from the bot image, and
   * hostd's own image is a plain node base with no engine CLI in it. Asking
   * hostd's filesystem answers about the wrong machine: it would report every
   * bot as unable to run while their containers would have run fine.
   */
  it('asks the probe it is given rather than this filesystem', async () => {
    const asked: string[] = [];

    const readiness = await engineReadiness({
      engine: 'claude',
      hasKey: false,
      hasCommand: async (command) => {
        asked.push(command);
        return true;
      },
    });

    expect(asked).toEqual(['claude']);
    expect(readiness.hasCommand).toBe(true);
  });

  it('reports a command the image lacks as missing, whatever this host has', async () => {
    const readiness = await engineReadiness({
      engine: 'claude',
      hasKey: true,
      hasCommand: async () => false,
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.remedy).toMatch(/a key alone will not do/);
  });

  it('asks the image once per command, not once per bot', async () => {
    // Nine bots on one engine is one `docker run`, not nine.
    let runs = 0;
    const probe = commandInImage('fleetadlc-bot:latest', async () => {
      runs += 1;
      return true;
    });

    await readinessFor(
      [
        { bot: 'atlas', engine: 'claude' },
        { bot: 'nova', engine: 'claude' },
        { bot: 'vega', engine: 'claude' },
      ],
      async () => false,
      probe,
    );

    expect(runs).toBe(1);
  });

  it('asks the named image, as the bot user would find it', async () => {
    let seen: string[] = [];
    const probe = commandInImage('registry.example/fleetadlc/bot:pinned', async (_cmd, args) => {
      seen = args;
      return true;
    });

    await probe('codex');

    expect(seen).toContain('registry.example/fleetadlc/bot:pinned');
    expect(seen.join(' ')).toContain('command -v codex');
  });

  it('treats a probe that throws as "not there" rather than failing the report', async () => {
    // Docker not running is not the same as an engine being broken, but a
    // readiness call that throws takes the whole page with it.
    const probe = commandInImage('fleetadlc-bot:latest', async () => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    const readiness = await engineReadiness({ engine: 'claude', hasKey: true, hasCommand: probe });

    expect(readiness.ready).toBe(false);
    expect(readiness.hasCommand).toBe(false);
  });
});
