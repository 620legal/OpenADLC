import { createEngine, type Engine } from '@fleetadlc/engines';
import type { EngineName } from '@fleetadlc/shared';
import { scriptedRunFor } from './scripted-runs.js';

/**
 * The engine a task will run on, or a refusal.
 *
 * Its own module because `skill-runner.ts` calls `main()` at import: the choice
 * is the part worth testing, and it cannot be reached without running a task.
 *
 * There used to be a fallback here. An engine that was not installed quietly
 * became the scripted one, announced by a single `console.log` in a task log
 * nobody reads, and the task went on to produce fabricated work that reached a
 * real branch, a real pull request and a real review. One missing binary turned
 * the whole crew into theatre, and nothing on the board said so.
 *
 * A bot that cannot think has to fail. A failed task is visible; a fabricated
 * one is indistinguishable from real work until somebody reads it closely.
 */
export async function chooseEngine(
  input: {
    engine: EngineName;
    skill: string;
    subjectRef: string;
    /** Set only by the integration suites, via `FLEETADLC_SCRIPTED_ENGINES`. */
    scripted: boolean;
  },
  /**
   * How an engine is built, injected so a test can say what is installed.
   *
   * Without this the only way to test the success path was to run it on a
   * machine that happened to have the engine's CLI — which passed on a laptop
   * and failed in CI, where no engine is installed and none should be. A test
   * whose result depends on the host is not testing this function.
   */
  make: (name: EngineName) => Engine = (name) => createEngine(name),
): Promise<Engine> {
  if (input.scripted) {
    return createEngine('none', { mockScript: scriptedRunFor(input.skill, input.subjectRef) });
  }

  // `none` is the automation seat's engine: that account writes labels and
  // statuses and was never meant to think. Built without a script, it is the
  // mock engine, which always says it is available, so the check below would
  // have let a task on it produce made-up work. Only the dispatcher's choice of
  // owners kept one from being started; a bot whose engine was set to `none` by
  // mistake, or a task started by hand, went straight through.
  if (input.engine === 'none') {
    throw new Error(
      `this bot has no engine (engine: none), so ${input.skill} cannot run on it. ` +
        `Give the task to a bot with a real engine, or set this bot's engine in config/bots.yaml.`,
    );
  }

  const engine = make(input.engine);
  if (await engine.available()) return engine;

  throw new Error(
    `engine ${input.engine} is not available on this host, so ${input.skill} cannot run. ` +
      `Install it, or change this bot's engine in config/bots.yaml.`,
  );
}
