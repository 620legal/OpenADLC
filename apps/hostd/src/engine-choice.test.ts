import { createEngine } from '@fleetadlc/engines';
import { describe, expect, it } from 'vitest';
import { chooseEngine } from './engine-choice.js';

/**
 * Every engine a test needs is supplied, so the result does not depend on
 * which engine CLIs the host has: `codex` on the PATH turned the refusals
 * below into passes.
 */
const base = { skill: 'implement', subjectRef: 'fleetadlc#145', scripted: false } as const;

/** An engine that is not on this host. */
const missing = () => ({
  name: 'codex' as const,
  available: async () => false,
  run: () => (async function* () {})(),
  usage: () => ({ tokensIn: 0, tokensOut: 0, costUsd: 0 }),
});

describe('choosing the engine a task runs on', () => {
  it('refuses when the engine is not on this host, instead of improvising', async () => {
    // The fallback this replaces produced a branch, a pull request and a review
    // out of a scripted stub, and the only sign was one line in a task log.
    await expect(chooseEngine({ ...base, engine: 'codex' }, missing)).rejects.toThrow(
      /engine codex is not available on this host/,
    );
  });

  it('says which skill could not run and where to change it', async () => {
    // `engine exited 1:` with nothing after the colon cost an afternoon. A
    // refusal that does not say what to do is only marginally better than one
    // that lies.
    await expect(chooseEngine({ ...base, engine: 'codex' }, missing)).rejects.toThrow(/config\/bots\.yaml/);
  });

  it('returns the real engine when it is installed', async () => {
    // The engine is supplied rather than looked for: CI has no engine CLI and
    // should not, so asking the host whether `claude` exists tested the runner
    // and not this function. It passed on a laptop and failed everywhere else.
    const installed = {
      name: 'claude' as const,
      available: async () => true,
      run: () => (async function* () {})(),
      usage: () => ({ tokensIn: 0, tokensOut: 0, costUsd: 0 }),
    };

    const engine = await chooseEngine({ ...base, engine: 'claude' }, () => installed);

    expect(engine.name).toBe('claude');
  });

  it('refuses when the engine is there but reports itself unavailable', async () => {
    // The other half, and the one that matters: a binary on the PATH that
    // cannot authenticate is not an engine a task can run on.
    const absent = {
      name: 'claude' as const,
      available: async () => false,
      run: () => (async function* () {})(),
      usage: () => ({ tokensIn: 0, tokensOut: 0, costUsd: 0 }),
    };

    await expect(chooseEngine({ ...base, engine: 'claude' }, () => absent)).rejects.toThrow(
      /not available on this host/,
    );
  });

  it('refuses a bot whose engine is none rather than running the mock engine', async () => {
    // The mock engine always reports itself available, so the availability
    // check alone let a task on the automation seat produce made-up work.
    await expect(chooseEngine({ ...base, engine: 'none' })).rejects.toThrow(
      /has no engine \(engine: none\), so implement cannot run.*config\/bots\.yaml/,
    );
  });

  it('refuses none even when the engine factory would hand one out', async () => {
    // The refusal is this function's, not the factory's: a factory that returns
    // a ready mock engine must not be enough to run a real task on it.
    const mock = {
      name: 'none' as const,
      available: async () => true,
      run: () => (async function* () {})(),
      usage: () => ({ tokensIn: 0, tokensOut: 0, costUsd: 0 }),
    };

    await expect(chooseEngine({ ...base, engine: 'none' }, () => mock)).rejects.toThrow(
      /engine: none/,
    );
  });

  it('does not build the mock engine without a script to run', () => {
    // A default script once answered every task with "the scripted demo path".
    expect(() => createEngine('none')).toThrow(/engine none does no real work/);
  });

  it('gives the integration suites their scripted engine when they ask', async () => {
    // The one remaining way to get fabricated work, and it is reachable only by
    // exporting FLEETADLC_SCRIPTED_ENGINES by hand.
    const engine = await chooseEngine({ ...base, engine: 'claude', scripted: true });
    expect(engine.name).toBe('none');
  });
});
