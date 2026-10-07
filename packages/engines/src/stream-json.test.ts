import { describe, expect, it } from 'vitest';
import { costOf, exactCost } from './pricing.js';
import { StreamJsonParser } from './stream-json.js';
import type { EngineEvent } from './types.js';

function read(parser: StreamJsonParser, lines: unknown[]): EngineEvent[] {
  return lines.flatMap((line) => parser.parse(JSON.stringify(line)));
}

/** Claude Code's stream, whose output counts are as each message began. */
function claude(model = 'claude-sonnet-5'): StreamJsonParser {
  return new StreamJsonParser(model, { growingOutput: true });
}

function recorded(events: EngineEvent[]): { tokensIn: number; tokensOut: number; costUsd: number } {
  return events.reduce(
    (total, event) =>
      event.type === 'usage'
        ? {
            tokensIn: total.tokensIn + event.tokensIn,
            tokensOut: total.tokensOut + event.tokensOut,
            costUsd: total.costUsd + event.costUsd,
          }
        : total,
    { tokensIn: 0, tokensOut: 0, costUsd: 0 },
  );
}

/**
 * The shape Claude Code writes: one assistant line per content block, each
 * carrying the whole message's usage as it stood when the message began, and a
 * `result` with the run's totals and what the run cost.
 */
function claudeAssistant(id: string, usage: { input_tokens: number; output_tokens: number }, block: unknown) {
  return {
    type: 'assistant',
    message: {
      model: 'claude-sonnet-5',
      id,
      type: 'message',
      role: 'assistant',
      content: [block],
      stop_reason: null,
      stop_sequence: null,
      usage: { ...usage, cache_creation_input_tokens: 2048, cache_read_input_tokens: 14_000, service_tier: 'standard' },
    },
    parent_tool_use_id: null,
    session_id: 'session-1',
  };
}

const CLAUDE_RUN = [
  { type: 'system', subtype: 'init', cwd: '/work/repo', model: 'claude-sonnet-5', permissionMode: 'acceptEdits' },
  claudeAssistant('msg_01', { input_tokens: 3, output_tokens: 2 }, { type: 'text', text: 'Reading the issue first.' }),
  claudeAssistant(
    'msg_01',
    { input_tokens: 3, output_tokens: 2 },
    { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: '/work/repo/src/billing.ts' } },
  ),
  {
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: 'toolu_01', type: 'tool_result', content: 'export …' }] },
    parent_tool_use_id: null,
  },
  claudeAssistant(
    'msg_02',
    { input_tokens: 1, output_tokens: 1 },
    {
      type: 'tool_use',
      id: 'toolu_02',
      name: 'Edit',
      input: { file_path: '/work/repo/src/billing.ts', old_string: 'a', new_string: 'b' },
    },
  ),
  {
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: 'toolu_02', type: 'tool_result', content: 'ok' }] },
    parent_tool_use_id: null,
  },
  claudeAssistant('msg_03', { input_tokens: 2, output_tokens: 3 }, { type: 'text', text: 'Done; opened the PR.' }),
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 3,
    result: 'Done; opened the PR.',
    total_cost_usd: 0.1234,
    usage: { input_tokens: 6, cache_creation_input_tokens: 6144, cache_read_input_tokens: 42_000, output_tokens: 950 },
  },
];

describe('a run\'s usage', () => {
  it('records a multi-turn Claude run\'s totals exactly once', () => {
    // The adapter used to add up every assistant line and then the result on
    // top: here that was 15 tokens in, 958 out, and the run's cost plus its
    // per-line estimates. The totals are 950 out and $0.1234, and tokens in
    // count the cached input too: 6 uncached, 6144 written to the cache and
    // 42000 read from it.
    const events = read(claude(), CLAUDE_RUN);

    const total = recorded(events);
    expect(total.tokensIn).toBe(6 + 6144 + 42_000);
    expect(total.tokensOut).toBe(950);
    expect(total.costUsd).toBeCloseTo(0.1234, 4);
    // The difference the result made up is the run's last usage, and says so.
    const usage = events.filter((event) => event.type === 'usage');
    expect(usage.at(-1)).toMatchObject({ final: true });
    expect(usage.slice(0, -1).some((event) => event.final)).toBe(false);
  });

  it('counts as the run goes, so a cap can trip before the run ends', () => {
    const parser = claude();
    const first = CLAUDE_RUN[1];

    // Its cached input as well: 3 uncached tokens and 2 out alone round to $0.
    const [usage, ...rest] = read(parser, [first]).filter((event) => event.type === 'usage');
    expect(rest).toEqual([]);
    expect(usage).toMatchObject({ tokensIn: 3 + 2048 + 14_000 });
    expect(usage?.costUsd).toBeGreaterThan(0);
    expect(usage?.costUsd).toBeCloseTo(
      exactCost('claude-sonnet-5', { input: 3, cacheRead: 14_000, cacheWrite: 2048, output: usage?.tokensOut ?? 0 }),
      4,
    );
    // The same message again, carrying its next block, is not a second
    // message: only the output it wrote is new.
    const again = read(parser, [CLAUDE_RUN[2]]).filter((event) => event.type === 'usage');
    expect(again.every((event) => event.tokensIn === 0)).toBe(true);
  });

  it('counts only the growth when a message is repeated with more output', () => {
    const parser = claude();
    const block = { type: 'text', text: 'working' };

    const events = read(parser, [
      claudeAssistant('msg_01', { input_tokens: 10, output_tokens: 1 }, block),
      claudeAssistant('msg_01', { input_tokens: 10, output_tokens: 40 }, block),
    ]);

    expect(recorded(events)).toMatchObject({ tokensIn: 10 + 2048 + 14_000, tokensOut: 40 });
  });

  it('prices a long cache-heavy run as it goes, at what its tokens cost', () => {
    // 200 messages shaped like Claude's: almost all of each message's input
    // read from or written to the cache, and an output count of 1 to 3.
    const parser = claude();
    const lines = Array.from({ length: 200 }, (_, index) =>
      claudeAssistant(`msg_${index}`, { input_tokens: 3, output_tokens: 1 + (index % 3) }, { type: 'text', text: 'ok' }),
    );

    const total = recorded(read(parser, lines));

    const real = 200 * exactCost('claude-sonnet-5', { input: 3, cacheRead: 14_000, cacheWrite: 2048, output: 2 });
    expect(total.costUsd).toBeGreaterThan(real * 0.9);
    expect(total.costUsd).toBeLessThan(real * 1.1);
  });

  it('passes a $15 cap before the result of a long Opus run, not after it', () => {
    // An audit's run: 200 turns that cost over $20 recorded $0.02 until the
    // result, so the cap stopped nothing.
    const parser = claude('claude-opus-5');
    const lines = Array.from({ length: 200 }, (_, index) => ({
      type: 'assistant',
      message: {
        id: `msg_${index}`,
        content: [{ type: 'text', text: 'Next.' }],
        usage: {
          input_tokens: 4,
          cache_creation_input_tokens: 3000,
          cache_read_input_tokens: 20_000 + Math.round((300_000 * index) / 199),
          output_tokens: 2,
        },
      },
      parent_tool_use_id: null,
    }));

    const before = recorded(read(parser, lines));
    expect(before.costUsd).toBeGreaterThan(15);

    // The result still has the last word on the total.
    const after = recorded(
      read(parser, [{ type: 'result', is_error: false, total_cost_usd: 22.83, usage: { input_tokens: 800, output_tokens: 400 } }]),
    );
    expect(before.costUsd + after.costUsd).toBeCloseTo(22.83, 2);
  });

  it('counts the output a message writes, when its count stays where it began', () => {
    // Claude puts the output count as the message began on each of its
    // lines: 1, for a message that went on to write 4000 characters.
    const parser = claude();
    const events = read(parser, [
      claudeAssistant('msg_01', { input_tokens: 3, output_tokens: 1 }, { type: 'text', text: 'x'.repeat(2000) }),
      claudeAssistant(
        'msg_01',
        { input_tokens: 3, output_tokens: 1 },
        { type: 'tool_use', id: 'toolu_01', name: 'Write', input: { file_path: 'a.ts', content: 'y'.repeat(1970) } },
      ),
    ]);

    expect(recorded(events).tokensOut).toBeGreaterThan(950);
    expect(recorded(events).tokensOut).toBeLessThan(1050);
  });

  it('adds up messages too small to record one at a time', () => {
    // $0.00004 each, rounded to the four places the ledger keeps, was $0 a
    // thousand times over.
    const parser = new StreamJsonParser('claude-sonnet-5');
    const lines = Array.from({ length: 1000 }, (_, index) => ({
      type: 'assistant',
      message: { id: `msg_${index}`, content: [], usage: { input_tokens: 20, output_tokens: 0 } },
    }));

    expect(costOf('claude-sonnet-5', 20, 0)).toBe(0);
    expect(recorded(read(parser, lines)).costUsd).toBeCloseTo(0.04, 4);
  });

  it('records the totals of a stream that has only a result', () => {
    const events = read(new StreamJsonParser('claude-sonnet-5'), [
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'nothing to do',
        total_cost_usd: 0.042,
        usage: { input_tokens: 1200, output_tokens: 300 },
      },
    ]);

    expect(events).toEqual([
      { type: 'usage', tokensIn: 1200, tokensOut: 300, costUsd: 0.042, final: true },
      { type: 'done', reason: 'complete' },
    ]);
  });

  it('prices the difference itself when the result says the cost is 0', () => {
    // Grok writes 0 when it does not know the cost, as on a subscription.
    // Zero is not free, and a ledger that read it as free would never cap.
    const events = read(new StreamJsonParser('grok-4'), [
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        total_cost_usd: 0.0,
        usage: { input_tokens: 4000, output_tokens: 1000 },
      },
    ]);

    expect(recorded(events).costUsd).toBeCloseTo(costOf('grok-4', 4000, 1000), 4);
    expect(recorded(events).costUsd).toBeGreaterThan(0);
  });

  it('never records a negative difference', () => {
    // A result below what was already counted leaves the count where it is.
    const events = read(new StreamJsonParser('grok-4'), [
      {
        type: 'assistant',
        message: { id: 'msg_0', content: [], usage: { input_tokens: 500, output_tokens: 50 } },
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        total_cost_usd: 0.0,
        usage: { input_tokens: 100, output_tokens: 10 },
      },
    ]);

    expect(events.filter((event) => event.type === 'usage')).toHaveLength(1);
    expect(recorded(events)).toMatchObject({ tokensIn: 500, tokensOut: 50 });
  });
});

describe('what a run did', () => {
  it('turns an edit into a file change, for Claude and for Grok', () => {
    const edits = [
      { name: 'Edit', input: { file_path: '/work/repo/a.ts', old_string: 'x', new_string: 'y' } },
      { name: 'Write', input: { file_path: '/work/repo/b.ts', content: 'z' } },
      { name: 'MultiEdit', input: { file_path: '/work/repo/c.ts', edits: [] } },
      { name: 'search_replace', input: { file_path: 'd.ts', old_string: '', new_string: 'new' } },
      { name: 'write', input: { file_path: '/work/repo/e.ts', content: 'e' } },
      { name: 'hashline_edit', input: { file_path: 'f.ts', edits: [] } },
    ];

    const events = read(
      new StreamJsonParser('grok-4'),
      edits.map((edit, index) => ({
        type: 'assistant',
        message: { id: `msg_${index}`, content: [{ type: 'tool_use', id: `call_${index}`, ...edit }] },
      })),
    );

    expect(events.filter((event) => event.type === 'file_change')).toEqual([
      { type: 'file_change', path: '/work/repo/a.ts' },
      { type: 'file_change', path: '/work/repo/b.ts' },
      { type: 'file_change', path: '/work/repo/c.ts' },
      { type: 'file_change', path: 'd.ts' },
      { type: 'file_change', path: '/work/repo/e.ts' },
      { type: 'file_change', path: 'f.ts' },
    ]);
  });

  it('does not take a read or a command for a file change', () => {
    const events = read(new StreamJsonParser('grok-4'), [
      {
        type: 'assistant',
        message: {
          id: 'msg_0',
          content: [
            { type: 'tool_use', id: 'call_0', name: 'read_file', input: { target_file: 'src/main.ts' } },
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'run_terminal_command',
              input: { command: 'make ci', description: 'checks' },
            },
          ],
        },
      },
    ]);

    expect(events).toEqual([
      { type: 'tool_call', name: 'read_file', summary: 'src/main.ts' },
      { type: 'tool_call', name: 'run_terminal_command', summary: 'make ci' },
    ]);
  });

  it('says a failed run failed, and does not call it done', () => {
    // What grok 1.0.41 writes when it has no credential.
    const parser = new StreamJsonParser('grok-4');
    const events = read(parser, [
      { type: 'system', subtype: 'init', session_id: '', apiKeySource: 'user', model: 'unknown', tools: [] },
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        num_turns: 0,
        total_cost_usd: 0.0,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        modelUsage: {},
        errors: ['Not signed in. To authenticate without a browser, run:\n  grok login --device-code'],
      },
    ]);

    expect(events).toEqual([]);
    expect(parser.failure()).toContain('Not signed in');
  });
});
