import { exactCost, type TokenCounts } from './pricing.js';
import { spawnJsonLines, type SpawnJsonLinesInput } from './process-engine.js';
import type { EngineEvent, EngineUsage } from './types.js';

/**
 * The stream Claude Code writes with `--output-format stream-json` and Grok
 * Build writes with `--output-format streaming-messages-json`. They are the
 * same wire format: a `system` line, `assistant` messages whose content is text
 * and tool calls, `user` messages carrying the tool results, and one `result`
 * at the end with the run's totals.
 *
 * Usage is the part that went wrong when each adapter read it for itself. The
 * Claude adapter recorded the usage on every assistant line and then the
 * `result` line's usage and cost again, which are the totals of the same run —
 * and Claude repeats a message's usage on each line that carries one of its
 * content blocks. A task's tokens and cost reached the ledger about twice.
 *
 * Here each message is counted once, as the run goes, so the cap trips
 * between turns rather than after a runaway. That needs the whole message:
 * its cached input, read and written, which is most of what a long run costs,
 * and its output as it grows. Priced on its uncached input and its starting
 * output alone, each message came to about $0, and a run that cost $47 was
 * recorded at $0 until its last line. Tokens in count all input the model
 * processed, cached included, as Codex's do. The `result` totals are the
 * authoritative figures, so they only top up what was already recorded: one
 * last usage event for the difference, never a negative one.
 */

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface StreamLine {
  type?: string;
  is_error?: boolean;
  parent_tool_use_id?: string | null;
  message?: { id?: string; content?: unknown; usage?: TokenUsage };
  usage?: TokenUsage;
  total_cost_usd?: number;
  result?: unknown;
  errors?: unknown;
}

/**
 * The tools that write a file, and the input that names it. Claude's are the
 * first four. Grok Build 1.0.41 writes with `search_replace` and `write` in its
 * standard tool set and `hashline_edit` in the hashline one (`[toolset]
 * file_toolset`); all three name the file in `file_path`. Read off the tool
 * definitions the CLI sends with a request, not guessed from its docs, which
 * disagree with each other about the names.
 */
const FILE_WRITERS: Readonly<Record<string, string>> = {
  Edit: 'file_path',
  Write: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
  search_replace: 'file_path',
  write: 'file_path',
  hashline_edit: 'file_path',
};

/** What a tool call is about, for the log: the file it touches, or the command it runs. */
const SUMMARY_KEYS = ['file_path', 'notebook_path', 'target_file', 'command'] as const;

/** The same cap `spawnJsonLines` puts on a quoted reason: a sentence, not a transcript. */
const REASON_LIMIT = 400;

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function roundCost(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

const NONE: TokenCounts = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

function countsOf(usage: TokenUsage | undefined): TokenCounts {
  return {
    input: count(usage?.input_tokens),
    cacheRead: count(usage?.cache_read_input_tokens),
    cacheWrite: count(usage?.cache_creation_input_tokens),
    output: count(usage?.output_tokens),
  };
}

function inputOf(tokens: TokenCounts): number {
  return tokens.input + tokens.cacheRead + tokens.cacheWrite;
}

/** Roughly four characters to a token: what a message has written, as output. */
const CHARS_PER_TOKEN = 4;

/** What a block of a message wrote: its text, or the input of its tool call. */
function charsOf(block: ContentBlock): number {
  if (block.type === 'text' && block.text) return block.text.length;
  if (block.type === 'tool_use' && block.input) return JSON.stringify(block.input).length;
  return 0;
}

function oneLine(text: string, limit = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

function summaryOf(block: ContentBlock): string {
  for (const key of SUMMARY_KEYS) {
    const value = block.input?.[key];
    if (typeof value === 'string' && value.trim()) return oneLine(value);
  }
  return block.name ?? 'tool';
}

/** The sentence a failed `result` gives: Grok's `errors`, or Claude's `result`. */
function failureOf(line: StreamLine): string {
  const errors = Array.isArray(line.errors)
    ? line.errors.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
  const text = errors.length > 0 ? errors.join('; ') : typeof line.result === 'string' ? line.result : '';
  const trimmed = text.trim();
  if (!trimmed) return 'no reason given';
  return trimmed.length <= REASON_LIMIT ? trimmed : trimmed.slice(0, REASON_LIMIT);
}

/** Adds a usage event to a running total, to the four decimal places `costOf` keeps. */
export function addUsage(total: EngineUsage, usage: EngineUsage): EngineUsage {
  return {
    tokensIn: total.tokensIn + usage.tokensIn,
    tokensOut: total.tokensOut + usage.tokensOut,
    costUsd: roundCost(total.costUsd + usage.costUsd),
  };
}

export interface StreamJsonOptions {
  /**
   * The engine writes a message's output count as it stood when the message
   * began, and repeats it on each of the message's lines: Claude Code does,
   * with 1 to 3 on a message that went on to write thousands of characters.
   * Its output is then counted from what the message wrote as well. Grok
   * Build writes each response's whole count, and one response over two
   * lines, so it is taken as written.
   */
  growingOutput?: boolean;
}

/** Reads one run's stream. A parser holds that run's count, so it is not reused. */
export class StreamJsonParser {
  /** What each message has been counted for so far, by its id, and the characters it has written. */
  private readonly counted = new Map<string, { tokens: TokenCounts; chars: number }>();
  /** Every message's tokens added up, by kind, for the `result` to be compared with. */
  private seen: TokenCounts = { ...NONE };
  private recorded: EngineUsage = { tokensIn: 0, tokensOut: 0, costUsd: 0 };
  /**
   * What the run has cost so far, unrounded. Each event records the change
   * in this, rounded, rather than each message rounded on its own: a message
   * costing $0.00004 rounded to $0 every time, and a thousand of them were
   * never recorded.
   */
  private exact = 0;
  private failed: string | null = null;

  constructor(
    private readonly model: string,
    private readonly options: StreamJsonOptions = {},
  ) {}

  /** The reason the run's `result` said it failed, or null when it did not. */
  failure(): string | null {
    return this.failed;
  }

  parse(line: string): EngineEvent[] {
    const event = JSON.parse(line) as StreamLine;
    const events: EngineEvent[] = [];

    if (event.type === 'assistant' && event.message) {
      const content = Array.isArray(event.message.content) ? (event.message.content as ContentBlock[]) : [];
      let chars = 0;
      for (const block of content) {
        chars += charsOf(block);
        if (block.type === 'text' && block.text) {
          events.push({ type: 'text', text: block.text });
        }
        if (block.type === 'tool_use' && block.name) {
          events.push({ type: 'tool_call', name: block.name, summary: summaryOf(block) });
          const key = FILE_WRITERS[block.name];
          const target = key ? block.input?.[key] : undefined;
          if (typeof target === 'string' && target) {
            events.push({ type: 'file_change', path: target });
          }
        }
      }
      if (event.message.usage) {
        events.push(...this.countMessage(event, event.message.usage, chars));
      }
    }

    if (event.type === 'result') {
      events.push(...this.reconcile(event));
      this.failed = event.is_error === true ? failureOf(event) : null;
      // A failed run is reported as an error, by `runStreamJson` or by the
      // exit code. It is not also `done`.
      if (event.is_error !== true) events.push({ type: 'done', reason: 'complete' });
    }

    return events;
  }

  /**
   * A message's usage, less what that message was already counted for. Claude
   * repeats the usage on each line of a message, so the highest seen of each
   * count is the message's and only the growth is new: its input, cached
   * input included, is priced the first time the message is seen, and its
   * output as it grows. A message with no id is counted as it stands.
   */
  private countMessage(event: StreamLine, usage: TokenUsage, chars: number): EngineEvent[] {
    const id = event.message?.id;
    const key = id ? `${event.parent_tool_use_id ?? ''}:${id}` : null;
    const before = (key ? this.counted.get(key) : undefined) ?? { tokens: NONE, chars: 0 };
    const reported = countsOf(usage);
    const written = before.chars + chars;
    const estimated = this.options.growingOutput ? Math.ceil(written / CHARS_PER_TOKEN) : 0;
    const after: TokenCounts = {
      input: Math.max(before.tokens.input, reported.input),
      cacheRead: Math.max(before.tokens.cacheRead, reported.cacheRead),
      cacheWrite: Math.max(before.tokens.cacheWrite, reported.cacheWrite),
      output: Math.max(before.tokens.output, reported.output, estimated),
    };
    if (key) this.counted.set(key, { tokens: after, chars: written });

    const delta: TokenCounts = {
      input: after.input - before.tokens.input,
      cacheRead: after.cacheRead - before.tokens.cacheRead,
      cacheWrite: after.cacheWrite - before.tokens.cacheWrite,
      output: after.output - before.tokens.output,
    };
    this.seen = {
      input: this.seen.input + delta.input,
      cacheRead: this.seen.cacheRead + delta.cacheRead,
      cacheWrite: this.seen.cacheWrite + delta.cacheWrite,
      output: this.seen.output + delta.output,
    };
    return this.record(inputOf(delta), delta.output, exactCost(this.model, delta));
  }

  /**
   * Tops the run up to the `result` totals, which are the authoritative
   * figures. Counting per message can still leave things out — output the
   * stream never showed, a message it did not carry — so the totals can be
   * more than was counted, and the difference is recorded once, marked as the
   * run's last. Each kind of token is compared with its own total, cached
   * input with cached input. Grok writes a cost of 0 when it does not know one
   * (a subscription, a count it could not finish), so a zero is an unknown and
   * the difference is priced here instead.
   */
  private reconcile(event: StreamLine): EngineEvent[] {
    const totals = countsOf(event.usage);
    const missing: TokenCounts = {
      input: Math.max(0, totals.input - this.seen.input),
      cacheRead: Math.max(0, totals.cacheRead - this.seen.cacheRead),
      cacheWrite: Math.max(0, totals.cacheWrite - this.seen.cacheWrite),
      output: Math.max(0, totals.output - this.seen.output),
    };
    const reported = count(event.total_cost_usd);
    const cost = reported > 0 ? Math.max(0, reported - this.exact) : exactCost(this.model, missing);
    return this.record(inputOf(missing), missing.output, cost, true);
  }

  private record(tokensIn: number, tokensOut: number, cost: number, final = false): EngineEvent[] {
    this.exact += cost;
    const costUsd = Math.max(0, roundCost(roundCost(this.exact) - this.recorded.costUsd));
    if (tokensIn <= 0 && tokensOut <= 0 && costUsd <= 0) return [];
    this.recorded = addUsage(this.recorded, { tokensIn, tokensOut, costUsd });
    return [{ type: 'usage', tokensIn, tokensOut, costUsd, ...(final ? { final: true } : {}) }];
  }
}

export interface StreamJsonRunInput extends Omit<SpawnJsonLinesInput, 'parse'>, StreamJsonOptions {
  /** The model the run is priced at when the stream does not say what it cost. */
  model: string;
  /** Each usage event as it is yielded, for the engine's running total. */
  onUsage: (usage: EngineUsage) => void;
}

/**
 * Runs an engine CLI that writes this stream.
 *
 * A non-zero exit is `spawnJsonLines`' to report, with the reason the stream
 * gave. What it cannot see is a run that failed and exited 0 anyway: Grok
 * Build does that when it cancels a run part-way (`is_error`, `errors:
 * ["cancelled"]`), and a task that stopped half-done must not be recorded as
 * complete. That failure is reported here, and only when nothing else already
 * reported one, so a failure is never reported twice.
 */
export async function* runStreamJson(input: StreamJsonRunInput): AsyncIterable<EngineEvent> {
  const { model, onUsage, growingOutput, ...spawn } = input;
  const parser = new StreamJsonParser(model, { growingOutput });
  let reported = false;

  for await (const event of spawnJsonLines({ ...spawn, parse: (line) => parser.parse(line) })) {
    if (event.type === 'usage') onUsage(event);
    if (event.type === 'error') reported = true;
    yield event;
  }

  const failure = parser.failure();
  if (failure !== null && !reported) {
    yield { type: 'error', message: `engine reported a failure: ${failure}` };
  }
}
