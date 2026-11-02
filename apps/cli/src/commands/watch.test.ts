import { readFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Output } from './ls.js';
import { formatEventLine, parseSse, watch, type BoardEvent } from './watch.js';

/**
 * `openadlc watch`, against a bridge that streams: a line per event, a JSON
 * object per line with --json, and a non-zero exit with the fix whenever the
 * stream is gone, rather than a terminal that waits forever.
 */

const EVENT: BoardEvent = {
  id: 'question.asked:g1',
  type: 'question.asked',
  at: '2026-11-02T00:05:27.000Z',
  bot: 'system-engineer',
  item: { ref: 'OpenADLC#227', repo: '620legal/OpenADLC', url: 'https://github.com/620legal/OpenADLC/issues/227' },
  text: 'system-engineer asked: How should openadlc watch get its events?',
};

function captured(): Output & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (line) => void stdout.push(line), err: (line) => void stderr.push(line) };
}

const noHeaders = async (): Promise<Record<string, string>> => ({});

let server: Server | undefined;
afterEach(async () => {
  vi.useRealTimers();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

/** A bridge whose event stream `send` drives. */
async function streaming(send: (response: ServerResponse) => void): Promise<number> {
  server = createServer((request, response) => {
    if (request.url !== '/v1/board/events') return void response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('retry: 1000\n\n');
    send(response);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

const frame = (event: BoardEvent): string => `event: board\nid: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;

describe('reading the stream', () => {
  it('takes whole frames, skips comments, and keeps what is still arriving', () => {
    const { frames, rest } = parseSse(`: ping\n\n${frame(EVENT)}event: board\ndata: {"id"`);
    expect(frames).toEqual([{ event: 'board', id: EVENT.id, data: JSON.stringify(EVENT) }]);
    expect(rest).toBe('event: board\ndata: {"id"');
  });

  it('joins a frame’s data lines', () => {
    expect(parseSse('data: one\ndata: two\n\n').frames).toEqual([{ event: 'message', id: null, data: 'one\ntwo' }]);
  });

  it('prints an event as time, type, seat, item and text', () => {
    const at = new Date(EVENT.at);
    const time = [at.getHours(), at.getMinutes(), at.getSeconds()].map((part) => String(part).padStart(2, '0')).join(':');
    expect(formatEventLine(EVENT)).toBe(`${time}  question.asked     system-engineer  620legal/OpenADLC#227  ${EVENT.text}`);
    expect(formatEventLine({ ...EVENT, bot: null })).toContain('  -  ');
  });
});

describe('openadlc watch', () => {
  it('prints a line per event, and nothing for a ping, until stopped; stopping exits 0', async () => {
    const stop = new AbortController();
    const output = captured();
    const port = await streaming((response) => {
      response.write(': ping\n\n');
      response.write(frame(EVENT));
      response.write(frame({ ...EVENT, id: 'task.started:t1', type: 'task.started', text: 'builder started implement on 620legal/OpenADLC#227' }));
    });
    const done = watch({ ports: { bridge: port } as never }, { json: false }, stop.signal, output, { fetch, headers: noHeaders });
    await vi.waitFor(() => expect(output.stdout).toHaveLength(2));
    stop.abort();
    expect(await done).toBe(0);
    expect(output.stdout[0]).toContain(EVENT.text);
    expect(output.stdout[1]).toContain('task.started');
    expect(output.stderr).toEqual([]);
  });

  it('prints one JSON object per line with --json, equal to what the bridge sent', async () => {
    const stop = new AbortController();
    const output = captured();
    const port = await streaming((response) => response.write(frame(EVENT)));
    const done = watch({ ports: { bridge: port } as never }, { json: true }, stop.signal, output, { fetch, headers: noHeaders });
    await vi.waitFor(() => expect(output.stdout).toHaveLength(1));
    stop.abort();
    await done;
    expect(JSON.parse(output.stdout[0]!)).toEqual(EVENT);
  });

  it('exits 1 with the fix when the bridge ends the stream', async () => {
    const output = captured();
    const port = await streaming((response) => response.end());
    expect(await watch({ ports: { bridge: port } as never }, { json: false }, undefined, output, { fetch, headers: noHeaders })).toBe(1);
    expect(output.stderr.join('\n')).toBe('the bridge closed the event stream. Run: openadlc up');
  });

  it('exits 1 with the fix when nothing answers', async () => {
    const port = await streaming(() => undefined);
    server!.close();
    server!.closeAllConnections();
    server = undefined;
    const output = captured();
    expect(await watch({ ports: { bridge: port } as never }, { json: false }, undefined, output, { fetch, headers: noHeaders })).toBe(1);
    expect(output.stderr.join('\n')).toBe(`the bridge is not answering on 127.0.0.1:${port}. Run: openadlc up`);
  });

  it('exits 1 when the bridge refuses the stream', async () => {
    const port = await streaming(() => undefined);
    const output = captured();
    const refusing = (async () => new Response('{"error":"needs a user"}', { status: 403 })) as typeof fetch;
    expect(await watch({ ports: { bridge: port } as never }, { json: false }, undefined, output, { fetch: refusing, headers: noHeaders })).toBe(1);
    expect(output.stderr.join('\n')).toBe('the bridge refused the event stream (403: needs a user)');
  });

  it('exits 1 when the stream says nothing, not even a ping, for 60 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const output = captured();
    let opened = false;
    const port = await streaming(() => void (opened = true));
    const done = watch({ ports: { bridge: port } as never }, { json: false }, undefined, output, { fetch, headers: noHeaders });
    // The stream is open, and its `retry` line has come and gone: silence from here.
    await vi.waitFor(() => expect(opened).toBe(true));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    vi.advanceTimersByTime(59_000);
    expect(output.stderr).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(await done).toBe(1);
    expect(output.stderr.join('\n')).toContain('went quiet for 60s');
    expect(output.stderr.join('\n')).toContain('Run: openadlc up');
  });

  it('exits 0 at once for a signal already aborted', async () => {
    const stop = new AbortController();
    stop.abort();
    expect(await watch({ ports: { bridge: 1 } as never }, { json: false }, stop.signal, captured(), { fetch, headers: noHeaders })).toBe(0);
  });

  it('never opens the database', () => {
    expect(readFileSync(new URL('./watch.ts', import.meta.url), 'utf8')).not.toContain('@openadlc/db');
  });
});
