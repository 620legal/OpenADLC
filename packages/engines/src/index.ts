import type { EngineName } from '@fleetadlc/shared';
import { ClaudeEngine } from './claude.js';
import { CodexEngine } from './codex.js';
import { GrokEngine } from './grok.js';
import { MockEngine, type MockScript } from './mock.js';
import type { Engine } from './types.js';

export * from './types.js';
export * from './pricing.js';
export * from './tools.js';
export { ClaudeEngine } from './claude.js';
export { CodexEngine } from './codex.js';
export { GrokEngine } from './grok.js';
export { MockEngine } from './mock.js';
export type { MockScript } from './mock.js';
export * from './readiness.js';
export * from './model-choice.js';
export * from './model-catalog.js';
export * from './provider-models.js';

export interface CreateEngineOptions {
  mockScript?: MockScript;
}

/** Skills never invoke an engine CLI; they ask for an adapter by name. */
export function createEngine(name: EngineName, options: CreateEngineOptions = {}): Engine {
  switch (name) {
    case 'claude':
      return new ClaudeEngine();
    case 'codex':
      return new CodexEngine();
    case 'grok':
      return new GrokEngine();
    case 'none':
      // Only a caller that brings a script gets the mock engine. A default
      // script here once meant a bot with no engine answered every task with
      // "the scripted demo path", reported itself available, and its output was
      // treated as work.
      if (!options.mockScript) {
        throw new Error(
          'engine none does no real work: it runs only a script the integration suites supply. ' +
            "Set this bot's engine to claude, codex or grok in config/bots.yaml.",
        );
      }
      return new MockEngine(options.mockScript);
    default: {
      const exhaustive: never = name;
      throw new Error(`unknown engine ${String(exhaustive)}`);
    }
  }
}
