import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { formatDuration, formatTaskLines, ls, type LiveTask, type Output } from './ls.js';

/**
 * `openadlc ls`, as a person reads it and as a script does: one line per live
 * task, or one JSON array and nothing else on stdout.
 */

const NOW = Date.parse('2026-11-02T00:22:00.000Z');

const TASK: LiveTask = {
  id: '6f0c1d2e-0000-4000-8000-000000000001',
  bot: 'builder',
  kind: 'implement',
  item: { ref: 'OpenADLC#227', repo: '620legal/OpenADLC', url: 'https://github.com/620legal/OpenADLC/issues/227' },
  state: 'running',
  since: '2026-11-02T00:10:00.000Z',
  costUsd: 1.2,
  capUsd: 15,
};

function captured(): Output & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (line) => void stdout.push(line), err: (line) => void stderr.push(line) };
}

const noHeaders = async (): Promise<Record<string, string>> => ({});

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

/** A bridge that answers `/v1/board/tasks` with these tasks. */
async function bridgeWith(tasks: LiveTask[]): Promise<number> {
  server = createServer((request, response) => {
    if (request.url !== '/v1/board/tasks') return void response.writeHead(404).end();
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ tasks }));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

describe('a live task’s line', () => {
  it('has its id, seat, item with its repository, state, time in it and spend against its cap', () => {
    const [line] = formatTaskLines([TASK], NOW);
    for (const part of [TASK.id, 'builder', '620legal/OpenADLC#227', 'running 12m', '$1.20 / $15']) expect(line).toContain(part);
  });

  it('says waiting for a queued task, and names a request with its repository', () => {
    const [line] = formatTaskLines([{ ...TASK, state: 'queued', item: { ref: 'request:ab12cd34', repo: '620legal/OpenADLC', url: null } }], NOW);
    expect(line).toContain('waiting 12m');
    expect(line).toContain('request ab12cd34 (620legal/OpenADLC)');
  });

  it('lines the columns up', () => {
    const lines = formatTaskLines([TASK, { ...TASK, id: 'short', bot: 'security-reviewer' }], NOW);
    expect(lines[0]!.indexOf('620legal')).toBe(lines[1]!.indexOf('620legal'));
  });

  it('says how long the way the board does', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(12 * 60_000)).toBe('12m');
    expect(formatDuration((3 * 60 + 5) * 60_000)).toBe('3h 05m');
    expect(formatDuration((52 * 60 + 1) * 60_000)).toBe('2d 4h');
  });
});

describe('openadlc ls', () => {
  it('prints a line per task from the bridge', async () => {
    const port = await bridgeWith([TASK]);
    const output = captured();
    expect(await ls({ ports: { bridge: port } as never }, { json: false }, output, { fetch, headers: noHeaders })).toBe(0);
    expect(output.stdout).toHaveLength(1);
    expect(output.stdout[0]).toContain('620legal/OpenADLC#227');
  });

  it('says so with no live tasks, and exits 0', async () => {
    const port = await bridgeWith([]);
    const output = captured();
    expect(await ls({ ports: { bridge: port } as never }, { json: false }, output, { fetch, headers: noHeaders })).toBe(0);
    expect(output.stdout).toEqual(['No tasks running, paused or waiting.']);
  });

  it('prints one JSON array equal to the route’s tasks, and nothing else, with --json', async () => {
    const port = await bridgeWith([TASK, { ...TASK, id: 'q', state: 'queued' }]);
    const output = captured();
    expect(await ls({ ports: { bridge: port } as never }, { json: true }, output, { fetch, headers: noHeaders })).toBe(0);
    expect(output.stdout).toHaveLength(1);
    // The stored state, not the word a person reads.
    expect(JSON.parse(output.stdout[0]!)).toEqual([TASK, { ...TASK, id: 'q', state: 'queued' }]);
    expect(output.stderr).toEqual([]);
  });

  it('exits 1 with the fix when the bridge is not answering', async () => {
    const port = await bridgeWith([]);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    const output = captured();
    expect(await ls({ ports: { bridge: port } as never }, { json: true }, output, { fetch, headers: noHeaders })).toBe(1);
    expect(output.stdout).toEqual([]);
    expect(output.stderr.join('\n')).toContain('Run: openadlc up');
  });

  it('never opens the database', () => {
    expect(readFileSync(new URL('./ls.ts', import.meta.url), 'utf8')).not.toContain('@openadlc/db');
  });
});
