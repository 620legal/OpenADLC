import type { EngineName } from '@fleetadlc/shared';

export interface ToolsPolicy {
  allow: {
    shell: string[];
    /**
     * `localCi`: a pushed commit, and the head a pull request opens or is
     * readied on, needs a local CI pass recorded for it (`fleetadlc-ci`).
     */
    git?: { pushBranchPrefix?: string; forcePush?: boolean; localCi?: boolean };
    files?: { writeWithin?: string[] };
  };
  deny: {
    shell: string[];
    /**
     * The `gh` commands OpenADLC's gh refuses for this skill
     * (`apps/hostd/bin/gh`), matched on their leading words. Every shipped
     * skill lists `pr merge`, and that gh refuses every merge, through `api`
     * and GraphQL too, whatever the list says. Every skill but deploy, which
     * runs rollback-production, lists `workflow run`. Dismissing a review is
     * not a gh command: a skill that denies `api` cannot do it through gh, and
     * when a bot does it anyway, the bridge's pull_request_review webhook asks
     * for the review again and holds `review-gate`.
     */
    github: string[];
  };
}

export interface EngineRunInput {
  contextFiles: string[];
  /**
   * Images and PDFs given with the work, by path, from `FLEETADLC_ATTACHMENTS`.
   * Not text, so never read into the prompt; each engine is given them the
   * way it takes a file (Claude a directory it may read, Codex an image flag),
   * and every engine has them listed in `attachments.md` besides.
   */
  attachments?: string[];
  prompt: string;
  workdir: string;
  env: Record<string, string>;
  model: string;
  tools: ToolsPolicy;
  costHeadroomUsd: number;
  signal?: AbortSignal;
}

export type EngineEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; name: string; summary: string }
  | { type: 'file_change'; path: string }
  /** A decision the engine cannot make: the skill turns this into a gate. */
  | { type: 'question'; question: string; options: string[] }
  /**
   * `cachedTokensIn`, when the engine reports it, is the part of `tokensIn`
   * served from the provider's cache. `final` marks the top-up to a finished
   * run's own totals: the run is over, so reaching the cap there stops
   * nothing, and the next run's headroom check is what asks.
   */
  | { type: 'usage'; tokensIn: number; tokensOut: number; costUsd: number; cachedTokensIn?: number; final?: boolean }
  | { type: 'done'; reason: 'complete' | 'cap' | 'cancelled' }
  | { type: 'error'; message: string };

export interface EngineUsage {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface Engine {
  readonly name: EngineName;
  /** True when the engine's CLI or API key is actually available in this install. */
  available(): Promise<boolean>;
  run(input: EngineRunInput): AsyncIterable<EngineEvent>;
  usage(): EngineUsage;
}
