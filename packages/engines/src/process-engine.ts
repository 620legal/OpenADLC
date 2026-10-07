import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { EngineEvent } from './types.js';

export interface SpawnJsonLinesInput {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  signal?: AbortSignal;
  /** Translates one line of engine output into zero or more OpenADLC events. */
  parse: (line: string) => EngineEvent[];
}

/**
 * How much of what an engine said may be copied into `exit_reason`.
 * A runaway transcript has to stay a sentence, not become the row.
 */
const REASON_LIMIT = 400;

/** Past this, a single line is a transcript. Quote its tail instead of parsing it. */
const PARSE_LIMIT = 512 * 1024;

/**
 * A reason at or above this rank is the engine saying it failed. Below it is
 * only what the stream happened to end on — a normal `result`, or a
 * `terminal_reason` like `completed` — and stderr says more than that.
 */
const FAILURE_RANK = 2;

interface RankedReason {
  /** Higher wins. A later line of equal rank replaces an earlier one. */
  rank: number;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clipStart(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= REASON_LIMIT ? trimmed : trimmed.slice(0, REASON_LIMIT);
}

function clipEnd(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= REASON_LIMIT ? trimmed : trimmed.slice(-REASON_LIMIT);
}

function prefer(best: RankedReason | null, rank: number, text: unknown): RankedReason | null {
  if (typeof text !== 'string') return best;
  const clipped = clipStart(text);
  if (!clipped) return best;
  if (!best || rank >= best.rank) return { rank, text: clipped };
  return best;
}

/**
 * Pull the sentence a person can act on out of one JSON object.
 *
 * Claude puts that sentence on `result` when `is_error` is set, and a short
 * code in `error`. Codex puts it on `error.message` or on a top-level `error`
 * event. The code is a worse reason than the sentence, so it ranks lower.
 */
function reasonFromRecord(event: Record<string, unknown>, best: RankedReason | null): RankedReason | null {
  const failed = event.is_error === true;
  if (failed) best = prefer(best, 4, event.result);

  if (isRecord(event.error)) best = prefer(best, 3, event.error.message);
  if (event.type === 'error' || event.type === 'turn.failed') best = prefer(best, 3, event.message);

  const carrier = event.message;
  if ((failed || event.error !== undefined) && isRecord(carrier) && Array.isArray(carrier.content)) {
    for (const block of carrier.content) {
      if (isRecord(block) && block.type === 'text') best = prefer(best, 3, block.text);
    }
  }

  if (typeof event.error === 'string') {
    // `authentication_failed` is a code. A string with a space is the sentence.
    best = prefer(best, /\s/.test(event.error) ? 3 : 2, event.error);
  }
  if (!failed && typeof event.result === 'string') best = prefer(best, 1, event.result);
  if (typeof event.terminal_reason === 'string') best = prefer(best, 0, event.terminal_reason);

  return best;
}

function reasonFromValue(value: unknown, best: RankedReason | null): RankedReason | null {
  if (!isRecord(value)) return best;
  best = reasonFromRecord(value, best);
  // Codex has used both `{ msg: { type: 'error', message } }` and `{ item }`.
  if (isRecord(value.msg)) best = reasonFromRecord(value.msg, best);
  if (isRecord(value.item)) best = reasonFromRecord(value.item, best);
  return best;
}

function noteStdout(
  line: string,
  ranked: RankedReason | null,
  plainTail: string,
): { ranked: RankedReason | null; plainTail: string } {
  const trimmed = line.trim();
  if (trimmed.length > PARSE_LIMIT) {
    return { ranked, plainTail: clipEnd(`${plainTail}\n${trimmed.slice(-REASON_LIMIT)}`) };
  }
  try {
    return { ranked: reasonFromValue(JSON.parse(trimmed) as unknown, ranked), plainTail };
  } catch {
    return { ranked, plainTail: clipEnd(`${plainTail}\n${trimmed}`) };
  }
}

function formatExit(how: string, detail: string): string {
  const trimmed = detail.trim();
  if (!trimmed) return `engine ${how}`;
  return `engine ${how}: ${trimmed}`;
}

/**
 * Runs an engine CLI and turns its line-delimited output into OpenADLC events.
 * Adapters differ only in their arguments and their parse function.
 */
export async function* spawnJsonLines(input: SpawnJsonLinesInput): AsyncIterable<EngineEvent> {
  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: { ...process.env, ...input.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // The SIGTERM a cancel sends is the one signal the engine was asked to die
  // of; any other is a failure, and so is this one when nobody cancelled.
  let aborted = false;
  const abort = () => {
    aborted = true;
    child.kill('SIGTERM');
  };
  input.signal?.addEventListener('abort', abort, { once: true });

  // An engine that exits before reading its prompt (a refused flag, a failed
  // start) closes the pipe under a write too big for its buffer. Unheard,
  // that EPIPE was an uncaught exception: it killed the skill runner, the
  // bridge was never told the task failed, and the engine's own stderr was
  // lost. The 'close' handler below says why it exited.
  child.stdin.on('error', () => {});
  if (input.stdin !== undefined) {
    child.stdin.write(input.stdin);
  }
  child.stdin.end();

  const stderr: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr.push(chunk);
    if (stderr.length > 200) stderr.shift();
  });

  const queue: EngineEvent[] = [];
  let resolveNext: (() => void) | null = null;
  let finished = false;
  let exitError: string | null = null;
  // The best sentence found in the JSON stream, and any non-JSON stdout.
  // Both stay capped: the stream itself can be the whole transcript.
  let ranked: RankedReason | null = null;
  let plainTail = '';

  const push = (event: EngineEvent) => {
    queue.push(event);
    resolveNext?.();
    resolveNext = null;
  };

  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    const noted = noteStdout(line, ranked, plainTail);
    ranked = noted.ranked;
    plainTail = noted.plainTail;
    try {
      for (const event of input.parse(line)) push(event);
    } catch (error) {
      // Which parse failed says whether the engine wrote something else or
      // the adapter met a shape it does not know.
      const why = error instanceof Error ? error.message : String(error);
      push({ type: 'error', message: `unparsable engine output (${why}): ${line.slice(0, 200)}` });
    }
  });

  child.on('error', (error) => {
    exitError = error.message;
    finished = true;
    resolveNext?.();
    resolveNext = null;
  });

  child.on('close', (code, signal) => {
    // An engine killed by a signal closes with no exit code: the OOM killer in
    // a task container's memory limit, a V8 abort. That used to count as no
    // error at all, and a stage that never finished was handed on as done.
    const killed = code === null && signal !== null && !aborted;
    if ((code !== 0 && code !== null) || killed) {
      // stdout carries the structured failure (`is_error`, `error`). stderr is
      // what is left when the engine never said why in the stream — and it
      // beats a stream that ended on an ordinary result, which is not a
      // reason. An engine that said nothing at all still names the exit code;
      // an empty string after the colon is not a reason.
      const stderrText = clipEnd(stderr.join(''));
      const failure = ranked && ranked.rank >= FAILURE_RANK ? ranked.text : '';
      const detail = failure || plainTail || stderrText || ranked?.text || '';
      exitError = formatExit(killed ? `was killed by ${signal}` : `exited ${code}`, detail);
    }
    finished = true;
    resolveNext?.();
    resolveNext = null;
  });

  try {
    while (true) {
      while (queue.length > 0) {
        yield queue.shift() as EngineEvent;
      }
      if (finished) break;
      await new Promise<void>((resolve) => {
        resolveNext = resolve;
      });
    }

    if (exitError) {
      yield { type: 'error', message: exitError };
    }
  } finally {
    input.signal?.removeEventListener('abort', abort);
    if (child.exitCode === null) child.kill('SIGTERM');
  }
}

export async function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}
