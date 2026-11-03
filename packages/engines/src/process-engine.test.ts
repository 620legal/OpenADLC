import { describe, expect, it } from 'vitest';
import { spawnJsonLines, type StdinWriter } from './process-engine.js';
import type { EngineEvent } from './types.js';

async function eventsOf(input: Parameters<typeof spawnJsonLines>[0]): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of spawnJsonLines(input)) events.push(event);
  return events;
}

describe('a line the adapter cannot read', () => {
  it('says why it could not, beside what the engine wrote', async () => {
    // The parse error was caught and thrown away, so the event said only that
    // a line was unparsable, never whether it was not JSON or a shape the
    // adapter does not know.
    const events = await eventsOf({
      command: 'sh',
      args: ['-c', 'echo "{\\"type\\":\\"surprise\\"}"'],
      cwd: process.cwd(),
      env: {},
      parse: () => {
        throw new Error('no handler for surprise');
      },
    });

    expect(events).toEqual([
      { type: 'error', message: 'unparsable engine output (no handler for surprise): {"type":"surprise"}' },
    ]);
  });
});

describe('an engine that exits before reading its prompt', () => {
  it('reports its exit and its stderr, rather than crashing on the unread prompt', async () => {
    // Over the pipe's 64 KiB buffer, the write failed with EPIPE once the
    // engine had gone. Nothing listened for it, so it killed the skill runner.
    const events = await eventsOf({
      command: 'sh',
      args: ['-c', 'echo refused >&2; exit 3'],
      cwd: process.cwd(),
      env: {},
      stdin: 'x'.repeat(1024 * 1024),
      parse: () => [],
    });

    expect(events).toEqual([{ type: 'error', message: 'engine exited 3: refused' }]);
  });
});

describe('an engine that reads more input as it runs', () => {
  it('keeps stdin open after the prompt, for what is written later, until it is ended', async () => {
    let writer: StdinWriter | null = null;
    const events: EngineEvent[] = [];
    // `cat` answers each line as it comes, and exits only once stdin ends.
    for await (const event of spawnJsonLines({
      command: 'cat',
      args: [],
      cwd: process.cwd(),
      env: {},
      stdin: '"first"\n',
      holdStdin: (stdin) => {
        writer = stdin;
      },
      parse: (line) => [{ type: 'text', text: JSON.parse(line) as string }],
    })) {
      events.push(event);
      const held = writer as StdinWriter | null;
      if (event.type === 'text' && event.text === 'first') held?.write('"second"\n');
      if (event.type === 'text' && event.text === 'second') held?.end();
    }

    expect(events).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ]);
  });
});
