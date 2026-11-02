import { answerOf } from '../attach.js';
import { bridgeHeaders } from '../console-link.js';
import type { InstallConfig } from '../install.js';

/**
 * `openadlc ls`: the tasks queued, running or paused, read from the bridge's
 * `GET /v1/board/tasks`. It never opens the database, so it works wherever the
 * bridge answers, and a person's own script can read `--json`.
 */

/** A live task as the bridge answers it (`apps/bridge/src/board-events.ts`). */
export interface LiveTask {
  id: string;
  bot: string | null;
  kind: string;
  item: { ref: string; repo: string | null; url: string | null };
  state: 'queued' | 'running' | 'paused';
  since: string | null;
  costUsd: number;
  capUsd: number;
}

/** Where a command's lines go: data to stdout, what went wrong to stderr, so `--json` stays parseable. */
export interface Output {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const terminal: Output = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`  ✗ ${line}\n`),
};

export interface BridgeReach {
  fetch: typeof fetch;
  headers: () => Promise<Record<string, string>>;
}

export const liveBridge: BridgeReach = { fetch: (input, init) => fetch(input, init), headers: () => bridgeHeaders() };

/** How long, the way the board says it: `45s`, `12m`, `3h 05m`, `2d 4h`. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** An item as a line names it: `620legal/OpenADLC#227`, or `request ab12cd34 (620legal/OpenADLC)`. */
export function itemLabel(item: LiveTask['item']): string {
  const issue = /^(.+)#(\d+)$/.exec(item.ref);
  if (issue) return `${item.repo ?? issue[1]}#${issue[2]}`;
  const request = /^request:(.+)$/.exec(item.ref);
  if (request) return `request ${request[1]}${item.repo ? ` (${item.repo})` : ''}`;
  return item.ref || '-';
}

function dollars(amount: number): string {
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}

/** A task's columns, before they are padded to line up. Queued prints as waiting; `--json` keeps the stored state. */
export function taskColumns(task: LiveTask, now: number): string[] {
  const state = task.state === 'queued' ? 'waiting' : task.state;
  const since = task.since ? formatDuration(now - Date.parse(task.since)) : '-';
  return [task.id, task.bot ?? '-', itemLabel(task.item), `${state} ${since}`, `$${task.costUsd.toFixed(2)} / ${dollars(task.capUsd)}`];
}

/** One line per task, its columns padded to line up. */
export function formatTaskLines(tasks: readonly LiveTask[], now: number): string[] {
  const rows = tasks.map((task) => taskColumns(task, now));
  const widths = rows.reduce<number[]>((max, row) => row.map((cell, index) => Math.max(max[index] ?? 0, cell.length)), []);
  return rows.map((row) => row.map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0))).join('  '));
}

/** The bridge's live tasks, printed. Answers the exit code. */
export async function ls(config: Pick<InstallConfig, 'ports'>, options: { json: boolean }, output: Output = terminal, bridge: BridgeReach = liveBridge): Promise<number> {
  const where = `127.0.0.1:${config.ports.bridge}`;
  let response: Response;
  try {
    response = await bridge.fetch(`http://${where}/v1/board/tasks`, { headers: await bridge.headers(), signal: AbortSignal.timeout(10_000) });
  } catch {
    output.err(`the bridge is not answering on ${where}. Run: openadlc up`);
    return 1;
  }
  if (!response.ok) {
    const answer = await answerOf(response);
    output.err(`the bridge refused the task list (${answer.status}${answer.error ? `: ${answer.error}` : ''})`);
    return 1;
  }
  const { tasks } = (await response.json()) as { tasks: LiveTask[] };
  if (options.json) {
    output.out(JSON.stringify(tasks));
    return 0;
  }
  if (tasks.length === 0) {
    output.out('No tasks running, paused or waiting.');
    return 0;
  }
  for (const line of formatTaskLines(tasks, Date.now())) output.out(line);
  return 0;
}
