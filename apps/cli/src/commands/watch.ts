import { answerOf } from '../attach.js';
import type { InstallConfig } from '../install.js';
import { itemLabel, liveBridge, terminal, type BridgeReach, type Output } from './ls.js';

/**
 * `openadlc watch`: the board's events as they happen, read from the bridge's
 * `GET /v1/board/events` stream until Ctrl-C. It starts from now; the board is
 * where history is.
 */

/**
 * How long the stream may say nothing at all before it counts as gone. The
 * bridge pings every 25 s, so a minute of silence is a socket left half open
 * — a bridge killed without closing it, a laptop that slept — which would
 * otherwise hang here saying nothing.
 */
export const QUIET_MS = 60_000;

/** A board event, as the bridge sends it (`apps/bridge/src/board-events.ts`). */
export interface BoardEvent {
  id: string;
  type: string;
  at: string;
  bot: string | null;
  item: { ref: string; repo: string | null; url: string | null };
  text: string;
}

export interface SseFrame {
  event: string;
  id: string | null;
  data: string;
}

/**
 * Splits what has arrived into whole frames and what is left of one still
 * arriving. A frame ends at a blank line; a comment (`: ping`) and a frame
 * with no data carry nothing.
 */
export function parseSse(buffer: string): { frames: SseFrame[]; rest: string } {
  const normalized = buffer.replace(/\r\n?/g, '\n');
  const blocks = normalized.split('\n\n');
  const rest = blocks.pop() ?? '';
  const frames: SseFrame[] = [];
  for (const block of blocks) {
    let event = 'message';
    let id: string | null = null;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'id') id = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length > 0) frames.push({ event, id, data: data.join('\n') });
  }
  return { frames, rest };
}

const TYPE_WIDTH = 'pull_request.held'.length;

/** `HH:MM:SS  <type>  <bot or ->  <item>  <text>`, the time in the terminal's zone. */
export function formatEventLine(event: BoardEvent): string {
  const at = new Date(event.at);
  const time = Number.isNaN(at.getTime()) ? '--:--:--' : [at.getHours(), at.getMinutes(), at.getSeconds()].map((part) => String(part).padStart(2, '0')).join(':');
  return [time, event.type.padEnd(TYPE_WIDTH), event.bot ?? '-', itemLabel(event.item), event.text].join('  ');
}

/** Prints each event until `signal` aborts (exit 0), or the stream fails (exit 1). Answers the exit code. */
export async function watch(
  config: Pick<InstallConfig, 'ports'>,
  options: { json: boolean },
  signal?: AbortSignal,
  output: Output = terminal,
  bridge: BridgeReach = liveBridge,
  quietMs = QUIET_MS,
): Promise<number> {
  const where = `127.0.0.1:${config.ports.bridge}`;
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  if (signal?.aborted) return 0;
  signal?.addEventListener('abort', stop, { once: true });

  let quiet = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      quiet = true;
      controller.abort();
    }, quietMs);
  };
  const failed = (said: string): number => {
    output.err(said);
    return 1;
  };
  const ended = (): number | null => {
    if (signal?.aborted) return 0;
    if (quiet) return failed(`the event stream went quiet for ${Math.round(quietMs / 1000)}s (the bridge pings every 25s). Run: openadlc up`);
    return null;
  };

  try {
    arm();
    let response: Response;
    try {
      response = await bridge.fetch(`http://${where}/v1/board/events`, { headers: await bridge.headers(), signal: controller.signal });
    } catch {
      return ended() ?? failed(`the bridge is not answering on ${where}. Run: openadlc up`);
    }
    if (!response.ok || !response.body) {
      const answer = await answerOf(response);
      return failed(`the bridge refused the event stream (${answer.status}${answer.error ? `: ${answer.error}` : ''})`);
    }

    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        arm();
        buffer += decoder.decode(chunk, { stream: true });
        const { frames, rest } = parseSse(buffer);
        buffer = rest;
        for (const frame of frames) {
          if (frame.event !== 'board') continue;
          let event: BoardEvent;
          try {
            event = JSON.parse(frame.data) as BoardEvent;
          } catch {
            continue;
          }
          output.out(options.json ? JSON.stringify(event) : formatEventLine(event));
        }
      }
    } catch {
      // Aborted, or the connection broke: which one is said below.
    }
    return ended() ?? failed('the bridge closed the event stream. Run: openadlc up');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}
