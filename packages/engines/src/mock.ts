import { renderMarker, type EngineName } from '@fleetadlc/shared';
import type { Engine, EngineEvent, EngineRunInput, EngineUsage } from './types.js';

export interface MockScript {
  /** Lines the bot "says", streamed one at a time. */
  say: string[];
  touch?: string[];
  ask?: { question: string; options: string[] };
  /**
   * A request to widen the lease, said the way a real engine says it: a
   * message ending in the `plan_change` marker, which the runner reads as a
   * question. There is no event of its own for it to be.
   */
  planChange?: { paths: string[]; reason: string };
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
}

/**
 * A deterministic engine used by the integration suites, the skill dry-run harness and
 * the tests. It lets a fresh install exercise the whole pipeline (task, session,
 * gate, ledger, board) before any engine API key exists.
 */
export class MockEngine implements Engine {
  readonly name: EngineName = 'none';
  private totals: EngineUsage = { tokensIn: 0, tokensOut: 0, costUsd: 0 };

  constructor(private readonly script: MockScript) {}

  async available(): Promise<boolean> {
    return true;
  }

  usage(): EngineUsage {
    return { ...this.totals };
  }

  run(input: EngineRunInput): AsyncIterable<EngineEvent> {
    const script = this.script;
    const self = this;

    async function* generate(): AsyncIterable<EngineEvent> {
      for (const line of script.say) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        yield { type: 'text', text: line };
      }
      for (const path of script.touch ?? []) {
        yield { type: 'tool_call', name: 'Write', summary: path };
        yield { type: 'file_change', path };
      }

      const tokensIn = script.tokensIn ?? 1200;
      const tokensOut = script.tokensOut ?? 400;
      const costUsd = script.costUsd ?? 0.02;
      self.totals = {
        tokensIn: self.totals.tokensIn + tokensIn,
        tokensOut: self.totals.tokensOut + tokensOut,
        costUsd: Math.round((self.totals.costUsd + costUsd) * 10_000) / 10_000,
      };
      yield { type: 'usage', tokensIn, tokensOut, costUsd };

      if (script.ask) {
        yield { type: 'question', question: script.ask.question, options: script.ask.options };
        yield { type: 'done', reason: 'complete' };
        return;
      }

      if (script.planChange) {
        yield { type: 'text', text: renderMarker({ event: 'plan_change', paths: script.planChange.paths, reason: script.planChange.reason }) };
        yield { type: 'done', reason: 'complete' };
        return;
      }

      if (self.totals.costUsd > input.costHeadroomUsd) {
        yield { type: 'done', reason: 'cap' };
        return;
      }

      yield { type: 'done', reason: 'complete' };
    }

    return generate();
  }
}
