import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseQuestion, parseYamlFile } from '@fleetadlc/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeEngine } from './claude.js';
import { CodexEngine, GET_ON_WITH_IT } from './codex.js';
import { GrokEngine } from './grok.js';
import { MockEngine } from './mock.js';
import {
  costOf,
  exactCost,
  loadModelPrices,
  MODEL_PRICES_ENV,
  modelPrice,
  modelPricesEnv,
  readModelPrices,
  resetModelPrices,
  setModelPrice,
} from './pricing.js';
import { isShellAllowed, loadToolsPolicy, resolveWriteScope, TOOLS_POLICY_ENV, toolsPolicyEnv } from './tools.js';
import type { Engine, EngineEvent, EngineRunInput, EngineUsage, ToolsPolicy } from './types.js';

const CONFIG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'config');

const policy: ToolsPolicy = {
  allow: {
    shell: ['make', 'git', 'gh'],
    git: { pushBranchPrefix: 'agent/', forcePush: false },
    files: { writeWithin: ['<declared_paths>', 'tests/**'] },
  },
  deny: { shell: ['curl', 'sudo'], github: ['pr review', 'api'] },
};

describe('tools policy', () => {
  it('allows only the binaries the skill lists', () => {
    expect(isShellAllowed(policy, 'make ci')).toBe(true);
    expect(isShellAllowed(policy, 'curl https://example.com')).toBe(false);
    expect(isShellAllowed(policy, 'docker run x')).toBe(false);
  });

  it('expands the declared paths of the lease into the write scope', () => {
    expect(resolveWriteScope(policy, ['src/billing/**'])).toEqual(['src/billing/**', 'tests/**']);
  });
});

describe('pricing', () => {
  it('prices a known model per million tokens', () => {
    // 1M in at $2/Mtok plus 100k out at $10/Mtok.
    expect(costOf('claude-sonnet-5', 1_000_000, 100_000)).toBeCloseTo(3, 4);
  });

  it('matches an unknown id to its family rather than the fallback rate', () => {
    // A dated snapshot of an older model, or one added after this table was
    // written. Not a licence to configure dated ids — a current model's id is
    // complete as it stands.
    expect(costOf('claude-sonnet-5-20260101', 1_000_000, 0)).toBeCloseTo(2, 4);
  });

  it('takes the longest matching family, not the first', () => {
    expect(costOf('claude-haiku-4-5-20251001', 1_000_000, 0)).toBeCloseTo(1, 4);
  });

  /**
   * These were wrong in the direction that matters. Opus was charged at $15/$75
   * — three times its real price — so a task tripped the per-task cap at a third
   * of the spend the cap was meant to allow, and every ledger row and budget
   * reading was wrong by the same multiple.
   */
  it('prices the current models at what they actually cost', () => {
    expect(costOf('claude-opus-5', 1_000_000, 0)).toBeCloseTo(5, 4);
    expect(costOf('claude-opus-5', 0, 1_000_000)).toBeCloseTo(25, 4);
    expect(costOf('claude-sonnet-5', 1_000_000, 0)).toBeCloseTo(2, 4);
    expect(costOf('claude-sonnet-5', 0, 1_000_000)).toBeCloseTo(10, 4);
    expect(costOf('claude-haiku-4-5', 1_000_000, 0)).toBeCloseTo(1, 4);
    expect(costOf('claude-haiku-4-5', 0, 1_000_000)).toBeCloseTo(5, 4);
    // Checked 2026-09-23; the sources are on the rows in pricing.ts.
    expect(costOf('gpt-5-codex', 1_000_000, 0)).toBeCloseTo(1.25, 4);
    expect(costOf('gpt-5-codex', 0, 1_000_000)).toBeCloseTo(10, 4);
    expect(costOf('grok-4', 1_000_000, 0)).toBeCloseTo(1.25, 4);
    expect(costOf('grok-4', 0, 1_000_000)).toBeCloseTo(2.5, 4);
    expect(costOf('grok-4.3', 1_000_000, 0)).toBeCloseTo(1.25, 4);
    // What a SuperGrok subscription offers (`grok models`), checked 2026-09-24.
    for (const model of ['grok-4.7', 'grok-4.6', 'grok-4.5']) {
      expect(costOf(model, 1_000_000, 0)).toBeCloseTo(2, 4);
      expect(costOf(model, 0, 1_000_000)).toBeCloseTo(6, 4);
    }
    // Not on xAI's page; a variant of 4.7, priced as 4.7.
    expect(modelPrice('grok-4.7-build-fast')).toEqual(modelPrice('grok-4.7'));
  });

  it('prices the Claude models an account lists, at Anthropic’s published rates', () => {
    // Checked 2026-09-24. A bot can now be given any model its account lists,
    // and each of these was priced by a rule that got it wrong: Opus 5.5 as a
    // snapshot of Opus 5, the rest at the fallback rate.
    const table: [string, number, number][] = [
      ['claude-opus-5-5', 4, 20],
      ['claude-fable-5-1', 10, 50],
      ['claude-fable-5', 10, 50],
      ['claude-opus-4-8', 5, 25],
      ['claude-opus-4-7', 5, 25],
      ['claude-opus-4-6', 5, 25],
      ['claude-sonnet-4-6', 3, 15],
    ];
    for (const [model, input, output] of table) {
      expect(modelPrice(model), model).toEqual({ inPerMtok: input, outPerMtok: output });
      expect(costOf(model, 1_000_000, 1_000_000), model).toBeCloseTo(input + output, 4);
    }
    // The rows that were already right stay as they were.
    expect(modelPrice('claude-opus-5')).toEqual({ inPerMtok: 5, outPerMtok: 25 });
    // A dated snapshot of the point release is still the point release.
    expect(modelPrice('claude-opus-5-5-20260901')).toEqual(modelPrice('claude-opus-5-5'));
  });

  it('does not price a later version at an earlier one\'s rate', () => {
    // grok-4 is the cheapest grok. A version this table has not met — 4.9 —
    // that borrowed its rate would reach the per-task cap late. The fallback
    // is a guess (dearer than any grok today), and it is warned about.
    expect(modelPrice('grok-4.9')).toEqual({ inPerMtok: 5, outPerMtok: 20 });
    // A dated snapshot is still the model it snapshots.
    expect(modelPrice('grok-4-0709')).toEqual(modelPrice('grok-4'));
  });

  it('configures no dated model id, because a current id is complete', () => {
    const config = parseYamlFile(join(CONFIG_ROOT, 'bots.yaml')) as {
      bots: { name: string; model: string }[];
    };
    const dated = config.bots.filter((bot) => /-20\d{6}$/.test(bot.model));

    expect(dated.map((bot) => `${bot.name}: ${bot.model}`)).toEqual([]);
  });

  it('prices every model the crew is configured with', () => {
    // The point of the issue: the identifiers in config/bots.yaml were names no
    // provider serves. This does not prove a provider serves them — nothing here
    // can — but it does prove the platform can price what it is told to run, so
    // a new bot cannot be added at the fallback rate without anyone noticing.
    const config = parseYamlFile(join(CONFIG_ROOT, 'bots.yaml')) as {
      bots: { name: string; model: string }[];
    };
    const configured = config.bots.map((bot) => bot.model).filter((model) => model !== 'none');
    expect(configured.length).toBeGreaterThan(0);

    const fallback = { inPerMtok: 5, outPerMtok: 20 };
    // A `newest:` family is never priced itself: the ledger records the id it
    // resolved to and called. What can be held to is that the family has
    // priced members. That does not make the seat priced: `newest:codex`
    // resolves to an id such as `gpt-5.3-codex`, which no row names, so it is
    // charged at the fallback, with a warning, until a dated row is added.
    // `newest:codex` is left out here rather than listed as `gpt-5-codex`,
    // which is not the id that runs.
    const members: Record<string, string[]> = {
      'newest:fable': ['claude-fable-5-1'],
      'newest:opus': ['claude-opus-5', 'claude-opus-5-5'],
      'newest:sonnet': ['claude-sonnet-5'],
      'newest:haiku': ['claude-haiku-4-5'],
      'newest:grok': ['grok-4.7'],
      'newest:codex': [],
    };
    for (const model of configured) {
      for (const id of members[model] ?? [model]) {
        expect(modelPrice(id), `${model} (${id}) priced at the fallback rate`).not.toEqual(fallback);
      }
    }
  });

  it('warns once for a model the table does not price', () => {
    // An id `newest:codex` resolves to, priced by the $5 / $20 guess with no
    // word to the operator, was under- or over-charged in silence.
    resetModelPrices();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(modelPrice('gpt-5.3-codex')).toEqual({ inPerMtok: 5, outPerMtok: 20 });
      costOf('gpt-5.3-codex', 1000, 1000);
      modelPrice('gpt-5.3-codex');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/gpt-5\.3-codex.*config\/models\.yaml/);

      // A known id, a snapshot of one, and one an install priced never warn.
      setModelPrice('house-model', { inPerMtok: 1, outPerMtok: 2 });
      for (const id of ['claude-opus-5', 'grok-4-0709', 'house-model']) modelPrice(id);
      expect(warn).toHaveBeenCalledTimes(1);

      // A reset forgets which ids were warned about, so each test stands alone.
      resetModelPrices();
      modelPrice('gpt-5.3-codex');
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
      resetModelPrices();
    }
  });

  it('prices Claude\'s cache reads and writes at Anthropic\'s rates, and any other model\'s at its input rate', () => {
    const million = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    expect(exactCost('claude-opus-5', { ...million, cacheRead: 1_000_000 })).toBeCloseTo(0.5, 6);
    expect(exactCost('claude-opus-5', { ...million, cacheWrite: 1_000_000 })).toBeCloseTo(6.25, 6);
    expect(exactCost('grok-4.7', { ...million, cacheRead: 1_000_000 })).toBeCloseTo(2, 6);
    expect(exactCost('grok-4.7', { ...million, cacheWrite: 1_000_000 })).toBeCloseTo(2, 6);
    setModelPrice('claude-house', { inPerMtok: 10, outPerMtok: 10, cachedInPerMtok: 3, cacheWritePerMtok: 7 });
    expect(exactCost('claude-house', { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 0 })).toBeCloseTo(20, 6);
  });

  it('honours an install override', () => {
    setModelPrice('house-model', { inPerMtok: 1, outPerMtok: 2 });
    expect(costOf('house-model', 1_000_000, 1_000_000)).toBeCloseTo(3, 4);
  });

  it('prices cached input at its own rate, and as input where none is known', () => {
    // Codex counts cached input inside its input. All of it at the full rate
    // overstated a long review several times over, and tripped its cap early.
    expect(costOf('gpt-5-codex', 1_000_000, 0, 800_000)).toBeCloseTo(0.2 * 1.25 + 0.8 * 0.125, 4);
    expect(costOf('grok-4', 1_000_000, 0, 800_000)).toBeCloseTo(1.25, 4);
    // Anthropic's cache-read rate is a tenth of input, unless an install says.
    expect(costOf('claude-opus-5', 1_000_000, 0, 800_000)).toBeCloseTo(0.2 * 5 + 0.8 * 0.5, 4);
    // More cached than sent is the input, not a negative charge.
    expect(costOf('gpt-5-codex', 1_000_000, 0, 5_000_000)).toBeCloseTo(0.125, 4);
  });
});

describe('config/models.yaml', () => {
  // The comment in pricing.ts described this file for as long as nothing read
  // it, so an install that wrote one was billed at the defaults and told nothing.
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleetadlc-models-'));
    resetModelPrices();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env[MODEL_PRICES_ENV];
    resetModelPrices();
  });

  /** As an install's prices reach a session: read by hostd, handed over in the session's environment. */
  function loadInstallPrices(configRoot: string): void {
    Object.assign(process.env, modelPricesEnv(readModelPrices(configRoot)));
    loadModelPrices();
  }

  it('overrides a default price', () => {
    writeFileSync(join(dir, 'models.yaml'), 'models:\n  claude-opus-5:\n    inPerMtok: 1\n    outPerMtok: 2\n');
    loadInstallPrices(dir);
    expect(costOf('claude-opus-5', 1_000_000, 1_000_000)).toBeCloseTo(3, 4);
  });

  it('leaves the defaults standing when there is no file', () => {
    // The normal case, and it must not throw.
    loadInstallPrices(dir);
    expect(costOf('claude-opus-5', 1_000_000, 0)).toBeCloseTo(5, 4);
  });

  it('refuses a price it cannot read rather than billing at the default', () => {
    // An install that wrote a price and silently got the old one would learn
    // about it from the invoice.
    writeFileSync(join(dir, 'models.yaml'), 'models:\n  claude-opus-5:\n    inPerMtok: cheap\n');
    expect(() => readModelPrices(dir)).toThrow(/inPerMtok/);
  });

  it('reads a cached input price', () => {
    writeFileSync(
      join(dir, 'models.yaml'),
      'models:\n  house-model:\n    inPerMtok: 1\n    cachedInPerMtok: 0.1\n    outPerMtok: 2\n',
    );
    loadInstallPrices(dir);
    expect(costOf('house-model', 1_000_000, 0, 1_000_000)).toBeCloseTo(0.1, 4);
  });

  it('refuses a cached input price it cannot read', () => {
    writeFileSync(
      join(dir, 'models.yaml'),
      'models:\n  house-model:\n    inPerMtok: 1\n    cachedInPerMtok: tenth\n    outPerMtok: 2\n',
    );
    expect(() => readModelPrices(dir)).toThrow(/cachedInPerMtok/);
  });

  it('reads a cache write price, and refuses one it cannot read', () => {
    writeFileSync(
      join(dir, 'models.yaml'),
      'models:\n  claude-house:\n    inPerMtok: 1\n    cacheWritePerMtok: 3\n    outPerMtok: 2\n',
    );
    loadInstallPrices(dir);
    expect(exactCost('claude-house', { input: 0, cacheRead: 0, cacheWrite: 1_000_000, output: 0 })).toBeCloseTo(3, 4);

    writeFileSync(
      join(dir, 'models.yaml'),
      'models:\n  claude-house:\n    inPerMtok: 1\n    cacheWritePerMtok: dear\n    outPerMtok: 2\n',
    );
    expect(() => readModelPrices(dir)).toThrow(/claude-house's cacheWritePerMtok/);
  });

  it('refuses a file with no models map', () => {
    writeFileSync(join(dir, 'models.yaml'), 'prices:\n  claude-opus-5: 1\n');
    expect(() => readModelPrices(dir)).toThrow(/models:/);
  });
});

/**
 * A stand-in for an engine CLI. It writes the given stdout lines, optional
 * stderr, and exits. Reading stdin matters: Claude is fed the prompt that way,
 * and a script that never consumes it can stall the pipe.
 */
function scriptEngine(dir: string, name: string, lines: string[], stderr = '', exitCode = 1): string {
  const path = join(dir, name);
  const source = [
    '#!/usr/bin/env node',
    'process.stdin.on("data", () => {});',
    'process.stdin.on("end", () => {',
    `  const lines = ${JSON.stringify(lines)};`,
    '  if (lines.length > 0) process.stdout.write(lines.join("\\n") + "\\n");',
    `  const stderrText = ${JSON.stringify(stderr)};`,
    '  if (stderrText) process.stderr.write(stderrText);',
    `  process.exit(${exitCode});`,
    '});',
    '',
  ].join('\n');
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  return path;
}

async function errorEvents(engine: Engine, workdir: string): Promise<string[]> {
  const errors: string[] = [];
  for await (const event of engine.run({
    contextFiles: [],
    prompt: 'implement the issue',
    workdir,
    env: {},
    model: 'claude-sonnet-5',
    tools: policy,
    costHeadroomUsd: 15,
  })) {
    if (event.type === 'error') errors.push(event.message);
  }
  return errors;
}

async function failureOf(engine: Engine, workdir: string): Promise<string> {
  const errors = await errorEvents(engine, workdir);
  expect(errors).toHaveLength(1);
  const reason = errors[0];
  if (reason === undefined) throw new Error('missing failure reason');
  return reason;
}

describe('why an engine failed', () => {
  // The first real task exited 1 with an empty reason. The engine had already
  // said, on stdout, that the OAuth session was expired. stderr was empty, and
  // the board recorded `engine exited 1:`.
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleetadlc-engine-fail-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const authSentence = 'Failed to authenticate: OAuth session expired and could not be refreshed';

  it('quotes the Claude stream instead of the empty stderr', async () => {
    const binary = scriptEngine(
      dir,
      'claude',
      [
        JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'none' }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: authSentence }] },
          error: 'authentication_failed',
        }),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: true,
          result: authSentence,
          terminal_reason: 'api_error',
        }),
      ],
      'segmentation fault',
    );

    const reason = await failureOf(new ClaudeEngine(binary), dir);

    expect(reason).toContain(authSentence);
    // The code and the stderr crash are both worse than the sentence.
    expect(reason).not.toContain('authentication_failed');
    expect(reason).not.toContain('segmentation fault');
  });

  it('does not paste a Claude transcript into the reason', async () => {
    const tail = 'TRANSCRIPT_TAIL';
    const huge = `${authSentence} ${'x'.repeat(20_000)} ${tail}`;
    const binary = scriptEngine(
      dir,
      'claude',
      [JSON.stringify({ type: 'result', is_error: true, result: huge })],
      'IGNORE_STDERR',
    );

    const reason = await failureOf(new ClaudeEngine(binary), dir);

    expect(reason).toContain(authSentence);
    expect(reason).not.toContain(tail);
    expect(reason).not.toContain('IGNORE_STDERR');
    // `engine exited N: ` plus the 400-character cap.
    expect(reason.length).toBeLessThanOrEqual('engine exited 1: '.length + 400);
  });

  it('prefers stderr to a stream that ended on an ordinary result', async () => {
    // A hook failed after the model had finished. The stream's last word is a
    // success, which is not why the process exited 1.
    const binary = scriptEngine(
      dir,
      'claude',
      [
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'I implemented the feature and opened the PR.',
          terminal_reason: 'completed',
        }),
      ],
      'Error: hook failed: EACCES',
    );

    const reason = await failureOf(new ClaudeEngine(binary), dir);

    expect(reason).toContain('hook failed: EACCES');
    expect(reason).not.toContain('opened the PR');
  });

  it('quotes a Codex turn.failed error instead of stderr', async () => {
    const sentence = 'unexpected status 401 Unauthorized: run codex login';
    const binary = scriptEngine(
      dir,
      'codex',
      [
        JSON.stringify({ type: 'thread.started', thread_id: 'thr_test' }),
        JSON.stringify({ type: 'turn.started' }),
        JSON.stringify({ type: 'turn.failed', error: { message: sentence } }),
      ],
      'codex panicked',
    );

    const reason = await failureOf(new CodexEngine(binary), dir);

    expect(reason).toContain(sentence);
    expect(reason).not.toContain('codex panicked');
  });

  it('quotes a Codex error event carried on msg', async () => {
    // The adapter already understands this older shape. A failure has to, too.
    const sentence = 'stream disconnected before completion: authentication failed';
    const binary = scriptEngine(dir, 'codex', [
      JSON.stringify({ id: '0', msg: { type: 'error', message: sentence } }),
    ]);

    const reason = await failureOf(new CodexEngine(binary), dir);

    expect(reason).toContain(sentence);
  });

  it('names the exit code when the engine says nothing', async () => {
    // Whitespace on stderr is still nothing. The old text was `engine exited 1:`.
    const binary = scriptEngine(dir, 'claude', [], '  \n');

    const reason = await failureOf(new ClaudeEngine(binary), dir);

    expect(reason).toBe('engine exited 1');
  });

  it('uses plain stdout when the engine did not write JSON', async () => {
    // A non-JSON line is reported as unparsable output first, and the skill
    // runner records the first error it sees. Both have to quote what the
    // engine printed, so whichever is recorded names the cause.
    const binary = scriptEngine(dir, 'claude', ['credentials missing']);

    const errors = await errorEvents(new ClaudeEngine(binary), dir);

    expect(errors[0]).toContain('credentials missing');
    expect(errors.at(-1)).toBe('engine exited 1: credentials missing');
  });

  it('keeps a stderr reason when stdout never says what failed', async () => {
    const binary = scriptEngine(
      dir,
      'claude',
      [JSON.stringify({ type: 'system', subtype: 'init' })],
      'permission denied',
    );

    const reason = await failureOf(new ClaudeEngine(binary), dir);

    expect(reason).toBe('engine exited 1: permission denied');
  });

  it('does not invent a failure when the engine exits 0', async () => {
    const binary = scriptEngine(dir, 'claude', [JSON.stringify({ type: 'result', result: 'done' })], '', 0);

    const errors = await errorEvents(new ClaudeEngine(binary), dir);

    expect(errors).toEqual([]);
  });
});

function usageOf(events: EngineEvent[]): EngineUsage {
  const total: EngineUsage = { tokensIn: 0, tokensOut: 0, costUsd: 0 };
  for (const event of events) {
    if (event.type !== 'usage') continue;
    total.tokensIn += event.tokensIn;
    total.tokensOut += event.tokensOut;
    total.costUsd += event.costUsd;
  }
  return total;
}

async function runAll(engine: Engine, input: Partial<EngineRunInput> & { workdir: string }): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of engine.run({
    contextFiles: [],
    prompt: 'implement the issue',
    env: {},
    model: 'claude-sonnet-5',
    tools: policy,
    costHeadroomUsd: 15,
    ...input,
  })) {
    events.push(event);
  }
  return events;
}

describe('what a Claude run cost', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleetadlc-engine-usage-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is recorded once, reconciled to the totals on its result', async () => {
    // Claude writes each content block of a message on a line of its own with
    // the message's usage on it, and the run's totals and cost on `result`.
    // Adding every one of them up recorded this run as 15 tokens in, 817 out
    // and $0.0931 plus the per-line estimates: about twice what it cost.
    const usage = { input_tokens: 3, cache_read_input_tokens: 14_000, output_tokens: 2 };
    const binary = scriptEngine(
      dir,
      'claude',
      [
        { type: 'system', subtype: 'init', model: 'claude-sonnet-5', permissionMode: 'acceptEdits' },
        {
          type: 'assistant',
          message: { id: 'msg_01', content: [{ type: 'text', text: 'Reading the issue.' }], usage },
          parent_tool_use_id: null,
        },
        {
          type: 'assistant',
          message: {
            id: 'msg_01',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_01',
                name: 'Edit',
                input: { file_path: '/work/repo/src/billing.ts', old_string: 'a', new_string: 'b' },
              },
            ],
            usage,
          },
          parent_tool_use_id: null,
        },
        {
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'ok' }] },
          parent_tool_use_id: null,
        },
        {
          type: 'assistant',
          message: {
            id: 'msg_02',
            content: [{ type: 'text', text: 'Done.' }],
            usage: { input_tokens: 3, cache_read_input_tokens: 16_000, output_tokens: 1 },
          },
          parent_tool_use_id: null,
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'Done.',
          total_cost_usd: 0.0931,
          usage: { input_tokens: 6, cache_read_input_tokens: 30_000, output_tokens: 812 },
        },
      ].map((line) => JSON.stringify(line)),
      '',
      0,
    );
    const engine = new ClaudeEngine(binary);

    const events = await runAll(engine, { workdir: dir });

    // Tokens in count the cached input: 6 uncached and 30000 read from the cache.
    const recorded = usageOf(events);
    expect(recorded.tokensIn).toBe(30_006);
    expect(recorded.tokensOut).toBe(812);
    expect(recorded.costUsd).toBeCloseTo(0.0931, 4);
    expect(engine.usage()).toEqual({ tokensIn: 30_006, tokensOut: 812, costUsd: 0.0931 });
    expect(events.filter((event) => event.type === 'file_change')).toEqual([
      { type: 'file_change', path: '/work/repo/src/billing.ts' },
    ]);
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'complete' });
  });

  it('passes the cap while the run goes, before its result line', async () => {
    // A long Opus run is almost all cached input. Priced without it, 200
    // turns recorded $0.02 before the result said $22.83, and the cap, which
    // only acts on usage as it is posted, never stopped it.
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
    const binary = scriptEngine(
      dir,
      'claude',
      [
        ...lines,
        { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 22.83, usage: { input_tokens: 800, output_tokens: 400 } },
      ].map((line) => JSON.stringify(line)),
      '',
      0,
    );

    const events = await runAll(new ClaudeEngine(binary), { workdir: dir, model: 'claude-opus-5' });

    const usage = events.filter((event) => event.type === 'usage');
    const beforeResult = usage.filter((event) => !event.final).reduce((sum, event) => sum + event.costUsd, 0);
    expect(beforeResult).toBeGreaterThan(15);
    expect(usageOf(events).costUsd).toBeCloseTo(22.83, 2);
  });
});

/**
 * A stand-in engine that writes the given lines and stderr, then kills itself
 * with `signal`, as the OOM killer or a V8 abort would; or, with no signal,
 * waits to be stopped. Each call is appended to `calls`.
 */
function dyingEngine(dir: string, name: string, lines: unknown[], signal: string | null, calls: string): string {
  const path = join(dir, name);
  const source = [
    '#!/usr/bin/env node',
    `require("node:fs").appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
    'process.stdin.on("data", () => {});',
    'process.stdin.on("end", () => {',
    `  const lines = ${JSON.stringify(lines.map((line) => JSON.stringify(line)))};`,
    '  if (lines.length > 0) process.stdout.write(lines.join("\\n") + "\\n");',
    '  process.stderr.write("out of memory\\n", () => {',
    signal ? `    setTimeout(() => process.kill(process.pid, ${JSON.stringify(signal)}), 50);` : '    setInterval(() => {}, 1000);',
    '  });',
    '});',
    '',
  ].join('\n');
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  return path;
}

describe('an engine killed by a signal', () => {
  // A process killed by a signal closes with no exit code. That counted as no
  // error, so a stage the engine never finished was handed on as done, and a
  // Codex run killed before it acted was resumed as if it had only planned.
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleetadlc-engine-killed-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is a failure that names the signal, with the end of its stderr', async () => {
    const binary = dyingEngine(dir, 'claude', [{ type: 'system', subtype: 'init' }], 'SIGKILL', join(dir, 'calls'));

    const events = await runAll(new ClaudeEngine(binary), { workdir: dir });

    expect(events.filter((event) => event.type === 'error')).toEqual([
      { type: 'error', message: 'engine was killed by SIGKILL: out of memory' },
    ]);
    expect(events.some((event) => event.type === 'done')).toBe(false);
  });

  it('is not a failure when it is the SIGTERM a cancel sent', async () => {
    const calls = join(dir, 'calls');
    const binary = dyingEngine(dir, 'claude', [{ type: 'system', subtype: 'init' }], null, calls);
    const cancel = new AbortController();

    const events: EngineEvent[] = [];
    const running = (async () => {
      for await (const event of new ClaudeEngine(binary).run({
        contextFiles: [],
        prompt: 'implement the issue',
        workdir: dir,
        env: {},
        model: 'claude-sonnet-5',
        tools: policy,
        costHeadroomUsd: 15,
        signal: cancel.signal,
      })) {
        events.push(event);
      }
    })();
    for (let waited = 0; !existsSync(calls) && waited < 10_000; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    cancel.abort();
    await running;

    expect(events.filter((event) => event.type === 'error')).toEqual([]);
  });

  it('ends a Codex run once, with the failure, and does not resume it', async () => {
    const calls = join(dir, 'calls');
    const binary = dyingEngine(
      dir,
      'codex',
      [{ type: 'thread.started', thread_id: '01a0d8b2-9868-76b3-ac56-079495723d57' }, { type: 'turn.started' }],
      'SIGKILL',
      calls,
    );

    const events = await runAll(new CodexEngine(binary, { contained: true }), { workdir: dir, model: 'gpt-5.3-codex' });

    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'error')).toEqual([
      { type: 'error', message: 'engine was killed by SIGKILL: out of memory' },
    ]);
  });
});

/**
 * A `codex` that writes what it is given as Codex's JSON stream, and records
 * the arguments it was called with where `FAKE_CODEX_RECORD` says, and what
 * it read on stdin where `FAKE_CODEX_STDIN` says.
 */
function fakeCodex(dir: string, lines: unknown[]): string {
  const path = join(dir, 'codex');
  const source = [
    '#!/usr/bin/env node',
    'const { writeFileSync } = require("node:fs");',
    'if (process.env.FAKE_CODEX_RECORD) writeFileSync(process.env.FAKE_CODEX_RECORD, JSON.stringify(process.argv.slice(2)));',
    'const stdin = [];',
    'process.stdin.on("data", (chunk) => stdin.push(chunk));',
    'process.stdin.on("end", () => {',
    '  if (process.env.FAKE_CODEX_STDIN) writeFileSync(process.env.FAKE_CODEX_STDIN, Buffer.concat(stdin));',
    `  const lines = ${JSON.stringify(lines.map((line) => JSON.stringify(line)))};`,
    '  if (lines.length > 0) process.stdout.write(lines.join("\\n") + "\\n");',
    '  process.exit(0);',
    '});',
    '',
  ].join('\n');
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  return path;
}

describe('the codex engine', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleetadlc-codex-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  const argsOf = async (engine: CodexEngine, tools: ToolsPolicy = policy): Promise<string[]> => {
    const record = join(dir, 'args.json');
    await runAll(engine, { workdir: dir, model: 'gpt-5.5', tools, env: { FAKE_CODEX_RECORD: record } });
    return JSON.parse(readFileSync(record, 'utf8')) as string[];
  };

  it('says what Codex says, in the stream Codex writes now', async () => {
    // Codex 0.155 writes items, not `msg` events. Everything a reviewer said
    // was dropped: the task read "done" with an empty thread, when it had said
    // it could not run a single command.
    const binary = fakeCodex(dir, [
      { type: 'thread.started', thread_id: 'thr_1' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'I’ll run `make ci`, then review the diff.' } },
      { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc "make ci"', aggregated_output: '', exit_code: null, status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc "make ci"', aggregated_output: 'ci: green', exit_code: 0, status: 'completed' } },
      { type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: 'README.md', kind: 'update' }], status: 'completed' } },
      { type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: 'Posted the review.' } },
      { type: 'turn.completed', usage: { input_tokens: 27_688, cached_input_tokens: 13_696, output_tokens: 200 } },
    ]);

    const events = await runAll(new CodexEngine(binary), { workdir: dir, model: 'gpt-5.5' });

    expect(events.filter((event) => event.type === 'text')).toEqual([
      { type: 'text', text: 'I’ll run `make ci`, then review the diff.' },
      { type: 'text', text: 'Posted the review.' },
    ]);
    expect(events.filter((event) => event.type === 'tool_call')).toEqual([{ type: 'tool_call', name: 'shell', summary: 'bash -lc "make ci"' }]);
    expect(events.filter((event) => event.type === 'file_change')).toEqual([{ type: 'file_change', path: 'README.md' }]);
    expect(usageOf(events)).toMatchObject({ tokensIn: 27_688, tokensOut: 200 });
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'complete' });
  });

  it('prices the input Codex served from its cache at the cached rate', async () => {
    const binary = fakeCodex(dir, [
      { type: 'thread.started', thread_id: 'thr_1' },
      { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'make ci' } },
      { type: 'turn.completed', usage: { input_tokens: 27_688, cached_input_tokens: 13_696, output_tokens: 200 } },
    ]);

    const events = await runAll(new CodexEngine(binary), { workdir: dir, model: 'gpt-5-codex' });

    const usage = events.filter((event) => event.type === 'usage');
    expect(usage).toEqual([
      {
        type: 'usage',
        tokensIn: 27_688,
        tokensOut: 200,
        cachedTokensIn: 13_696,
        costUsd: costOf('gpt-5-codex', 27_688, 200, 13_696),
      },
    ]);
    expect(costOf('gpt-5-codex', 27_688, 200, 13_696)).toBeLessThan(costOf('gpt-5-codex', 27_688, 200));
  });

  it('runs without a sandbox of its own in the bot’s container, where bubblewrap cannot start', async () => {
    const args = await argsOf(new CodexEngine(fakeCodex(dir, []), { contained: true }));
    expect(flagValue(args, '--sandbox')).toBe('danger-full-access');
  });

  it('knows it is in the container from the session the container starts', async () => {
    vi.stubEnv('FLEETADLC_CONTAINED', '1');
    expect(flagValue(await argsOf(new CodexEngine(fakeCodex(dir, []))), '--sandbox')).toBe('danger-full-access');
  });

  it('keeps its sandbox beside hostd, with the network open for gh and git push', async () => {
    const args = await argsOf(new CodexEngine(fakeCodex(dir, []), { contained: false }));
    expect(flagValue(args, '--sandbox')).toBe('workspace-write');
    expect(flagValue(args, '-c')).toBe('sandbox_workspace_write.network_access=true');
  });

  it('gives a skill that allows no shell a read-only sandbox, in a container too', async () => {
    const none: ToolsPolicy = { ...policy, allow: { ...policy.allow, shell: [] } };
    const args = await argsOf(new CodexEngine(fakeCodex(dir, []), { contained: true }), none);
    expect(flagValue(args, '--sandbox')).toBe('read-only');
    expect(args).not.toContain('sandbox_workspace_write.network_access=true');
  });

  it('thinks at a stated effort, not none', async () => {
    // Unset, gpt-5.3-codex spent no reasoning at all, and a review came back
    // as one sentence of what it was about to do.
    const args = await argsOf(new CodexEngine(fakeCodex(dir, []), { contained: true }));
    expect(args).toContain('model_reasoning_effort="medium"');
  });

  it('turns Codex’s analytics and feedback off, unless the operator opted telemetry back in', async () => {
    const off = await argsOf(new CodexEngine(fakeCodex(dir, []), { contained: true }));
    expect(off.join(' ')).toContain('-c analytics.enabled=false -c feedback.enabled=false');

    vi.stubEnv('FLEETADLC_ENGINE_TELEMETRY', 'on');
    const on = await argsOf(new CodexEngine(fakeCodex(dir, []), { contained: true }));
    expect(on).not.toContain('analytics.enabled=false');
    expect(on).not.toContain('feedback.enabled=false');
  });

  it('names the worktree untrusted, so Codex loads nothing from its .codex/', async () => {
    // With a sandbox that may write, Codex trusted the project on its own and
    // spawned the MCP servers the repository listed in `.codex/config.toml`.
    const args = await argsOf(new CodexEngine(fakeCodex(dir, []), { contained: true }));
    const projects = args.find((arg) => arg.startsWith('projects='));
    // The path as given and as resolved: on macOS a temporary folder is both
    // `/var/…` and `/private/var/…`.
    const paths = [...new Set([dir, realpathSync(dir)])];
    expect(projects).toBe(`projects={${paths.map((path) => `${JSON.stringify(path)}={trust_level="untrusted"}`).join(',')}}`);
    expect(args[args.indexOf(projects ?? '') - 1]).toBe('-c');
  });

  const codexOnPath = spawnSync('sh', ['-c', 'command -v codex'], { stdio: 'ignore' }).status === 0;

  it.skipIf(!codexOnPath)('spawns no MCP server from the worktree, with the real codex', async () => {
    // Never with real credentials: a config home of its own, a dummy key, and
    // an API address nothing answers. Codex starts a project's MCP servers
    // before its first call, so the call failing is expected; only the marker
    // says what ran.
    const home = join(dir, 'codex-home');
    const worktree = join(dir, 'repo');
    const marker = join(dir, 'mcp-ran');
    mkdirSync(home, { recursive: true });
    mkdirSync(join(worktree, '.codex'), { recursive: true });
    spawnSync('git', ['init', '-q', worktree]);
    writeFileSync(
      join(worktree, '.codex', 'config.toml'),
      `[mcp_servers.planted]\ncommand = "sh"\nargs = ["-c", ${JSON.stringify(`touch ${JSON.stringify(marker)}; sleep 30`)}]\n`,
    );
    const record = join(dir, 'args.json');
    await runAll(new CodexEngine(fakeCodex(dir, []), { contained: true }), {
      workdir: worktree,
      model: 'gpt-5.5',
      tools: policy,
      env: { FAKE_CODEX_RECORD: record },
    });
    const args = JSON.parse(readFileSync(record, 'utf8')) as string[];
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: home,
      CODEX_HOME: home,
      OPENAI_API_KEY: 'sk-dummy-not-a-key',
      OPENAI_BASE_URL: 'http://127.0.0.1:9',
    };
    const codex = (withArgs: string[]) => {
      rmSync(marker, { force: true });
      spawnSync('codex', withArgs, { cwd: worktree, env, input: 'say hi', timeout: 20_000, stdio: ['pipe', 'ignore', 'ignore'] });
      return existsSync(marker);
    };

    expect(codex(args)).toBe(false);

    // The same run without the override starts the server, so this proves it.
    const at = args.findIndex((arg) => arg.startsWith('projects='));
    expect(codex(args.filter((_arg, index) => index !== at && index !== at - 1))).toBe(true);
  }, 90_000);

  it('gives Codex its prompt on stdin, so a long one is not refused as too big for one argument', async () => {
    // Linux caps one argument at 128 KiB. A review whose context carried a
    // long thread or a large attachment failed with "spawn E2BIG" every time.
    const prompt = `review this\n${'x'.repeat(200 * 1024)}\nend of prompt`;
    const record = join(dir, 'args.json');
    const stdin = join(dir, 'stdin.txt');
    const binary = fakeCodex(dir, [
      { type: 'thread.started', thread_id: 'thr_1' },
      { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'make ci' } },
      { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 1 } },
    ]);

    const events = await runAll(new CodexEngine(binary, { contained: true }), {
      workdir: dir,
      model: 'gpt-5.5',
      prompt,
      env: { FAKE_CODEX_RECORD: record, FAKE_CODEX_STDIN: stdin },
    });

    expect(events.filter((event) => event.type === 'error')).toEqual([]);
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'complete' });
    const args = JSON.parse(readFileSync(record, 'utf8')) as string[];
    expect(args.at(-1)).toBe('-');
    expect(args.join(' ')).not.toContain('review this');
    expect(readFileSync(stdin, 'utf8')).toBe(prompt);
  });
});

/**
 * A `codex` with a session: the first call ends as `first` says, and
 * `codex exec resume` goes on as `resumed` says. Every call's arguments are
 * appended to `FAKE_CODEX_CALLS`, one JSON array per line.
 */
function fakeCodexSession(dir: string, first: unknown[], resumed: unknown[]): string {
  const path = join(dir, 'codex');
  const source = [
    '#!/usr/bin/env node',
    'const { appendFileSync } = require("node:fs");',
    'const args = process.argv.slice(2);',
    'appendFileSync(process.env.FAKE_CODEX_CALLS, JSON.stringify(args) + "\\n");',
    'process.stdin.on("data", () => {});',
    'process.stdin.on("end", () => {',
    `  const lines = args[1] === "resume" ? ${JSON.stringify(resumed.map((line) => JSON.stringify(line)))} : ${JSON.stringify(first.map((line) => JSON.stringify(line)))};`,
    '  if (lines.length > 0) process.stdout.write(lines.join("\\n") + "\\n");',
    '  process.exit(0);',
    '});',
    '',
  ].join('\n');
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  return path;
}

describe('a Codex turn that ends on its plan', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleetadlc-codex-session-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const PLAN = [
    { type: 'thread.started', thread_id: '01a0d8b2-9868-76b3-ac56-079495723d57' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'I’ll run `make setup` and `make ci`, then review the diff.' } },
    { type: 'turn.completed', usage: { input_tokens: 13_777, cached_input_tokens: 0, output_tokens: 43 } },
  ];
  const WORK = [
    { type: 'turn.started' },
    { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc "make ci"', status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'Posted the review.' } },
    { type: 'turn.completed', usage: { input_tokens: 30_000, cached_input_tokens: 13_000, output_tokens: 900 } },
  ];

  const run = async (first: unknown[], resumed: unknown[] = WORK) => {
    const calls = join(dir, 'calls.jsonl');
    const events = await runAll(new CodexEngine(fakeCodexSession(dir, first, resumed), { contained: true }), {
      workdir: dir,
      model: 'gpt-5.3-codex',
      env: { FAKE_CODEX_CALLS: calls },
    });
    const made = readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
    return { events, made };
  };

  it('is taken back up once, in the same session, and told to do it', async () => {
    const { events, made } = await run(PLAN);

    expect(made).toHaveLength(2);
    const resume = made[1] ?? [];
    expect(resume.slice(0, 3)).toEqual(['exec', 'resume', '--json']);
    expect(resume).toContain('01a0d8b2-9868-76b3-ac56-079495723d57');
    expect(resume.at(-1)).toBe(GET_ON_WITH_IT);
    // The same sandbox, said the way `resume` takes it.
    expect(resume).toContain('sandbox_mode="danger-full-access"');
    // A resumed run reads its config again, so the worktree is untrusted there too.
    expect(resume.some((arg) => arg.startsWith('projects=') && arg.includes('trust_level="untrusted"'))).toBe(true);
    expect(events.filter((event) => event.type === 'text').map((event) => (event as { text: string }).text)).toEqual([
      'I’ll run `make setup` and `make ci`, then review the diff.',
      'Posted the review.',
    ]);
    expect(events.filter((event) => event.type === 'tool_call')).toHaveLength(1);
    // One end, after the work: the plan's end is not the task's.
    expect(events.filter((event) => event.type === 'done')).toEqual([{ type: 'done', reason: 'complete' }]);
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'complete' });
  });

  it('is not asked twice: what it says the second time is what the task ends on', async () => {
    const { events, made } = await run(PLAN, [
      { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'I cannot reach GitHub from here.' } },
      { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 10 } },
    ]);

    expect(made).toHaveLength(2);
    expect(events.filter((event) => event.type === 'text').at(-1)).toEqual({ type: 'text', text: 'I cannot reach GitHub from here.' });
  });

  it('is left alone when it worked', async () => {
    const { made } = await run([PLAN[0], ...WORK]);
    expect(made).toHaveLength(1);
  });

  it('is left alone when it asked a person, which is its turn ending the way it should', async () => {
    const asked = {
      type: 'item.completed',
      item: {
        id: 'item_0',
        type: 'agent_message',
        text: 'The issue does not say which page.\n<!-- fleetadlc:{"event":"question","question":"Which page?","options":["index.html","a new page"]} -->',
      },
    };
    const { made } = await run([PLAN[0], asked, PLAN[3]]);
    expect(made).toHaveLength(1);
  });

  it('is left alone when it sent the work back, even with more said after it', async () => {
    // Only the last thing said was read, and only for a question. A turn that
    // sent its work back was resumed and told to run the commands, after the
    // bridge had already moved the card and released the lease.
    const sentBack = {
      type: 'item.completed',
      item: {
        id: 'item_0',
        type: 'agent_message',
        text: 'The design names no migration.\n<!-- fleetadlc:{"event":"send_back","to":"spec","reason":"no migration for the new column"} -->',
      },
    };
    const after = { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Handed back to spec.' } };
    const { made } = await run([PLAN[0], sentBack, after, PLAN[3]]);
    expect(made).toHaveLength(1);
  });
});

describe('what Claude may run', () => {
  it('gives each allowed and each denied command a rule of its own', async () => {
    // One rule for the whole list read as one literal command, so Claude asked
    // for approval on every shell call and a headless run refused them all.
    const dir = mkdtempSync(join(tmpdir(), 'fleetadlc-claude-rules-'));
    try {
      const record = join(dir, 'call.json');
      const result = { type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: {}, total_cost_usd: 0 };
      const binary = fakeGrok(dir, [JSON.stringify(result)]);
      const events = new ClaudeEngine(binary).run({
        contextFiles: [],
        prompt: 'run the checks',
        workdir: dir,
        env: { FAKE_GROK_RECORD: record },
        model: 'claude-haiku-4-5',
        tools: {
          allow: { shell: ['make', 'git'], files: { writeWithin: ['src/'] } },
          deny: { shell: ['curl', 'sudo'], github: [] },
        },
        costHeadroomUsd: 1,
      });
      for await (const event of events) void event;

      const { args } = readCall(record);
      expect(flagValue(args, '--allowedTools').split(' ')).toEqual([
        'Read',
        'Grep',
        'Glob',
        'Bash(make:*)',
        'Bash(git:*)',
        'Edit',
        'Write',
      ]);
      expect(flagValue(args, '--disallowedTools')).toBe('Bash(curl:*) Bash(sudo:*)');
      // No files given, no folder added.
      expect(args).not.toContain('--add-dir');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses the file tools to a skill with no write scope, since every run accepts edits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleetadlc-claude-nowrite-'));
    try {
      const record = join(dir, 'call.json');
      const result = { type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: {}, total_cost_usd: 0 };
      const events = new ClaudeEngine(fakeGrok(dir, [JSON.stringify(result)])).run({
        contextFiles: [],
        prompt: 'review it',
        workdir: dir,
        env: { FAKE_GROK_RECORD: record },
        model: 'claude-haiku-4-5',
        tools: {
          allow: { shell: ['git'], files: { writeWithin: ['<declared_paths>'] } },
          deny: { shell: ['curl'], github: [] },
        },
        costHeadroomUsd: 1,
      });
      for await (const event of events) void event;

      const { args } = readCall(record);
      expect(flagValue(args, '--permission-mode')).toBe('acceptEdits');
      expect(flagValue(args, '--allowedTools').split(' ')).not.toContain('Edit');
      expect(flagValue(args, '--disallowedTools').split(' ')).toEqual(['Bash(curl:*)', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads no settings, MCP servers or CLAUDE.md from the worktree', async () => {
    // A worktree's `.claude/settings.json` hooks ran with the session's
    // GitHub token, its `.mcp.json` servers were spawned, and its CLAUDE.md
    // was sent as instructions.
    const dir = mkdtempSync(join(tmpdir(), 'fleetadlc-claude-sources-'));
    try {
      const record = join(dir, 'call.json');
      const result = { type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: {}, total_cost_usd: 0 };
      await runAll(new ClaudeEngine(fakeGrok(dir, [JSON.stringify(result)])), { workdir: dir, env: { FAKE_GROK_RECORD: record } });

      const { args } = readCall(record);
      expect(flagValue(args, '--setting-sources')).toBe('user');
      expect(args).toContain('--strict-mcp-config');
      expect(args).not.toContain('--mcp-config');
      expect(args).not.toContain('--bare');
      expect(args).not.toContain('--restricted');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const claudeOnPath = spawnSync('sh', ['-c', 'command -v claude'], { stdio: 'ignore' }).status === 0;

  it.skipIf(!claudeOnPath)('runs no hook from the worktree, with the real claude', async () => {
    // Never with real credentials: a home of its own, a dummy key, and an API
    // address nothing answers. A SessionStart hook runs before any call, so
    // the call failing is expected; only the marker says what ran.
    const dir = mkdtempSync(join(tmpdir(), 'fleetadlc-claude-hooks-'));
    try {
      const home = join(dir, 'home');
      const worktree = join(dir, 'repo');
      const marker = join(dir, 'hook-ran');
      mkdirSync(home, { recursive: true });
      mkdirSync(join(worktree, '.claude'), { recursive: true });
      writeFileSync(
        join(worktree, '.claude', 'settings.json'),
        JSON.stringify({
          hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${JSON.stringify(marker)}` }] }] },
        }),
      );
      const env = {
        PATH: process.env.PATH ?? '',
        HOME: home,
        ANTHROPIC_API_KEY: 'sk-ant-dummy-not-a-key',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
        DISABLE_AUTOUPDATER: '1',
      };
      const record = join(dir, 'call.json');
      const result = { type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: {}, total_cost_usd: 0 };
      await runAll(new ClaudeEngine(fakeGrok(dir, [JSON.stringify(result)])), {
        workdir: worktree,
        env: { FAKE_GROK_RECORD: record },
      });
      const args = readCall(record).args;
      const claude = (withArgs: string[]) =>
        spawnSync('claude', withArgs, { cwd: worktree, env, input: 'say hi', timeout: 60_000, stdio: ['pipe', 'ignore', 'ignore'] });

      claude(args);
      expect(existsSync(marker)).toBe(false);

      // The same run without the two flags runs the hook, so this proves them.
      const without = args.filter((arg, index) => arg !== '--strict-mcp-config' && arg !== '--setting-sources' && args[index - 1] !== '--setting-sources');
      claude(without);
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 150_000);

  it('turns its self-updater off, whatever the session was handed', async () => {
    // It updated itself inside a task's computer, into a prefix the bot can
    // write: the pin is the version, and a new one is a rebuild.
    const dir = mkdtempSync(join(tmpdir(), 'fleetadlc-claude-updater-'));
    try {
      const record = join(dir, 'call.json');
      const result = { type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: {}, total_cost_usd: 0 };
      await runAll(new ClaudeEngine(fakeGrok(dir, [JSON.stringify(result)])), {
        workdir: dir,
        env: { FAKE_GROK_RECORD: record, DISABLE_AUTOUPDATER: '' },
      });
      expect(readCall(record).env.DISABLE_AUTOUPDATER).toBe('1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the files given with the work', () => {
  const PATHS = ['/work/builder/context/task-1/attachments/mockup.png', '/work/builder/context/task-1/attachments/spec.pdf'];

  it('are a folder Claude may read, once, since they sit outside the worktree its Read is held to', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleetadlc-claude-files-'));
    try {
      const record = join(dir, 'call.json');
      const result = { type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: {}, total_cost_usd: 0 };
      await runAll(new ClaudeEngine(fakeGrok(dir, [JSON.stringify(result)])), { workdir: dir, attachments: PATHS, env: { FAKE_GROK_RECORD: record } });
      const { args } = readCall(record);
      expect(args.filter((arg, index) => args[index - 1] === '--add-dir')).toEqual(['/work/builder/context/task-1/attachments']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('give Codex the images on its first turn, as one token the prompt cannot be taken into', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleetadlc-codex-files-'));
    try {
      const record = join(dir, 'args.json');
      await runAll(new CodexEngine(fakeCodex(dir, []), { contained: true }), { workdir: dir, model: 'gpt-5.5', attachments: PATHS, env: { FAKE_CODEX_RECORD: record } });
      const args = JSON.parse(readFileSync(record, 'utf8')) as string[];
      expect(args).toContain('--image=/work/builder/context/task-1/attachments/mockup.png');
      // The PDF is not an image: Codex reads it with its tools, from attachments.md.
      expect(args.join(' ')).not.toContain('spec.pdf');
      // The prompt is read from stdin, named by `-`, which the image list cannot take.
      expect(args.at(-1)).toBe('-');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('change nothing on Grok’s command line, which reads them from the list in its context', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleetadlc-grok-files-'));
    try {
      vi.stubEnv('HOME', dir);
      const record = join(dir, 'call.json');
      await runAll(new GrokEngine({ binary: fakeGrok(dir, GROK_RUN) }), { workdir: dir, model: 'grok-4', attachments: PATHS, env: { FAKE_GROK_RECORD: record } });
      expect(readCall(record).args.join(' ')).not.toContain('attachments');
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * A stand-in for the `grok` CLI, like `scriptEngine`, that also writes down how
 * it was called when `FAKE_GROK_RECORD` names a file: its arguments, the
 * environment it was handed, where it ran, the prompt file and leader socket
 * directory it was pointed at, and the home it was given, as they were while
 * it ran. It looks into that home only when it is the run's own, beside the
 * leader socket. With `FAKE_GROK_SHIMS` set it also sources each shell
 * startup file there, as grok's shell would, and notes the home and the
 * `FROM_REAL_HOME` marker each one ends with.
 */
function fakeGrok(dir: string, lines: string[], stderr = '', exitCode = 0): string {
  // `.cjs`, so `require` works whatever package the temp dir sits under.
  const path = join(dir, 'grok.cjs');
  const source = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const { execFileSync } = require('node:child_process');",
    'const args = process.argv.slice(2);',
    'const after = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);',
    "const promptFile = after('--prompt-file');",
    "const socket = after('--leader-socket');",
    'const home = process.env.HOME;',
    "const runHome = socket && home === path.join(path.dirname(socket), 'home') ? home : null;",
    "const settingsFile = runHome ? path.join(runHome, '.claude', 'settings.json') : null;",
    'const sourced = (file) => {',
    '  try {',
    "    const script = '. \"$HOME/$0\"; printf \"%s|%s\" \"$HOME\" \"${FROM_REAL_HOME-}\"';",
    "    return execFileSync('sh', ['-c', script, file], { env: process.env, encoding: 'utf8' });",
    '  } catch (error) {',
    '    return `failed: ${error.message}`;',
    '  }',
    '};',
    'if (process.env.FAKE_GROK_RECORD) {',
    '  fs.writeFileSync(process.env.FAKE_GROK_RECORD, JSON.stringify({',
    '    args,',
    '    cwd: process.cwd(),',
    '    env: {',
    '      DISABLE_AUTOUPDATER: process.env.DISABLE_AUTOUPDATER,',
    '      GROK_DISABLE_AUTOUPDATER: process.env.GROK_DISABLE_AUTOUPDATER,',
    '      GROK_FEEDBACK_ENABLED: process.env.GROK_FEEDBACK_ENABLED,',
    '      GROK_HOME: process.env.GROK_HOME,',
    '      GROK_TELEMETRY_TRACE_UPLOAD: process.env.GROK_TELEMETRY_TRACE_UPLOAD,',
    '      HOME: home,',
    '      XAI_API_KEY: process.env.XAI_API_KEY,',
    '    },',
    "    prompt: promptFile ? fs.readFileSync(promptFile, 'utf8') : null,",
    '    promptMode: promptFile ? fs.statSync(promptFile).mode & 0o777 : null,',
    '    socketDirMode: socket ? fs.statSync(path.dirname(socket)).mode & 0o777 : null,',
    '    homeFiles: runHome ? fs.readdirSync(runHome).sort() : [],',
    '    homeMode: runHome ? fs.statSync(runHome).mode & 0o777 : null,',
    "    settings: settingsFile && fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : null,",
    '    settingsMode: settingsFile && fs.existsSync(settingsFile) ? fs.statSync(settingsFile).mode & 0o777 : null,',
    '    paths: runHome && process.env.FAKE_GROK_SHIMS',
    "      ? Object.fromEntries(['.bash_profile', '.bashrc', '.zshenv'].map((file) => [file, execFileSync('sh', ['-c', 'PATH=/usr/bin:/bin; . \"$HOME/$0\"; printf %s \"$PATH\"', file], { env: process.env, encoding: 'utf8' })]))",
    '      : null,',
    '    shells: runHome && process.env.FAKE_GROK_SHIMS',
    "      ? Object.fromEntries(['.bash_profile', '.bashrc', '.zshenv'].map((file) => [file, sourced(file)]))",
    '      : null,',
    '  }));',
    '}',
    'process.stdin.on("data", () => {});',
    'process.stdin.on("end", () => {',
    `  const lines = ${JSON.stringify(lines)};`,
    '  if (lines.length > 0) process.stdout.write(lines.join("\\n") + "\\n");',
    `  const stderrText = ${JSON.stringify(stderr)};`,
    '  if (stderrText) process.stderr.write(stderrText);',
    `  process.exit(${exitCode});`,
    '});',
    '',
  ].join('\n');
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  return path;
}

interface GrokCall {
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  prompt: string | null;
  promptMode: number | null;
  socketDirMode: number | null;
  homeFiles: string[];
  homeMode: number | null;
  settings: unknown;
  settingsMode: number | null;
  shells: Record<string, string> | null;
}

function readCall(record: string): GrokCall {
  return JSON.parse(readFileSync(record, 'utf8')) as GrokCall;
}

function flagValue(args: string[], flag: string): string {
  const at = args.indexOf(flag);
  const value = at >= 0 ? args[at + 1] : undefined;
  if (value === undefined) throw new Error(`the engine was not given ${flag}: ${JSON.stringify(args)}`);
  return value;
}

function rulesFor(flag: '--allow' | '--deny', args: string[]): string[] {
  return args.flatMap((arg, at) => (arg === flag ? [args[at + 1] ?? ''] : []));
}

function denyRules(args: string[]): string[] {
  return rulesFor('--deny', args);
}

function allowRules(args: string[]): string[] {
  return rulesFor('--allow', args);
}

function grokAssistant(id: string, content: unknown[], inputTokens: number, outputTokens: number) {
  return {
    type: 'assistant',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: 'grok-4',
      content,
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
    parent_tool_use_id: null,
    session_id: '01a0d1dd',
  };
}

function grokToolResults(results: { id: string; content: string; isError?: boolean }[]) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: results.map((result) => ({
        type: 'tool_result',
        tool_use_id: result.id,
        content: result.content,
        is_error: result.isError ?? false,
      })),
    },
    parent_tool_use_id: null,
    session_id: '01a0d1dd',
  };
}

const GROK_INIT = {
  type: 'system',
  subtype: 'init',
  session_id: '01a0d1dd',
  apiKeySource: 'user',
  model: 'grok-4',
  cwd: '/work/repo',
  permissionMode: 'bypassPermissions',
  tools: ['run_terminal_command', 'read_file', 'search_replace', 'list_dir', 'grep', 'write'],
  slash_commands: [],
  mcp_servers: [],
  skills: [],
};

/**
 * What grok 1.0.41 wrote for a run that created a file, edited it and ran
 * three commands, one of them refused. Captured with the CLI pointed at a
 * stand-in model endpoint, so ids and paths are shortened and the tool results
 * trimmed. The three commands came back as one response split over two
 * assistant lines, the second with no usage, which is how grok writes one.
 * The result's cost is what grok stamps on API-key traffic; a subscription's
 * is 0.
 */
const GROK_RUN = [
  GROK_INIT,
  grokAssistant(
    'msg_0',
    [
      { type: 'text', text: 'Creating the file.' },
      {
        type: 'tool_use',
        id: 'call_1_0',
        name: 'write',
        input: { file_path: '/work/repo/notes/hello.txt', content: 'hello\n' },
      },
    ],
    1000,
    50,
  ),
  grokToolResults([{ id: 'call_1_0', content: '{"type":"SearchReplace","EditsApplied":{"old_string":""}}' }]),
  grokAssistant(
    'msg_1',
    [
      { type: 'text', text: 'Editing it.' },
      {
        type: 'tool_use',
        id: 'call_2_0',
        name: 'search_replace',
        input: { file_path: 'notes/hello.txt', old_string: 'hello', new_string: 'hello world' },
      },
    ],
    1100,
    40,
  ),
  grokToolResults([{ id: 'call_2_0', content: '{"type":"SearchReplace","EditsApplied":{"old_string":"hello"}}' }]),
  grokAssistant(
    'msg_2',
    [
      {
        type: 'tool_use',
        id: 'call_3_0',
        name: 'run_terminal_command',
        input: { command: 'make --version', description: 'allowed' },
      },
      {
        type: 'tool_use',
        id: 'call_3_1',
        name: 'run_terminal_command',
        input: { command: 'curl -sS https://example.com', description: 'denied' },
      },
    ],
    1200,
    30,
  ),
  grokToolResults([
    {
      id: 'call_3_1',
      content:
        'Tool `run_terminal_command` was not executed: Denied by permission policy: deny rule on bash matching "curl*"',
      isError: true,
    },
  ]),
  grokAssistant(
    'msg_3',
    [
      {
        type: 'tool_use',
        id: 'call_3_2',
        name: 'run_terminal_command',
        input: { command: 'git status --short', description: 'listed' },
      },
    ],
    0,
    0,
  ),
  grokToolResults([
    { id: 'call_3_0', content: '{"type":"Bash","output_for_prompt":"exit: 0\\nGNU Make 4.3\\n","exit_code":0}' },
    { id: 'call_3_2', content: '{"type":"Bash","output_for_prompt":"exit: 0\\n","exit_code":0}' },
  ]),
  grokAssistant('msg_4', [{ type: 'text', text: 'All done.' }], 1300, 20),
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 130,
    duration_api_ms: 9,
    num_turns: 4,
    result: 'All done.',
    stop_reason: 'end_turn',
    total_cost_usd: 0.0125,
    usage: {
      input_tokens: 4600,
      output_tokens: 140,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      server_tool_use: { web_search_requests: 0 },
    },
    modelUsage: {},
    session_id: '01a0d1dd',
  },
].map((line) => JSON.stringify(line));

/** What grok 1.0.41 writes, on stdout and again on stderr, when nothing signed it in. */
const NOT_SIGNED_IN =
  'Not signed in. To authenticate without a browser, run:\n  grok login --device-code\n\n' +
  'Alternatively, set the XAI_API_KEY environment variable or run `grok login` on a machine with a browser.';

/** A second reviewer's policy: a shell, the network denied, and nowhere to write. */
const reviewPolicy: ToolsPolicy = {
  allow: { shell: ['make', 'git', 'gh', 'rg'], files: { writeWithin: [] } },
  deny: { shell: ['curl', 'sudo'], github: ['pr merge'] },
};

/** A policy that lists kubectl, which grok's read-only built-ins would otherwise let through unlisted. */
const clusterPolicy: ToolsPolicy = {
  allow: { shell: ['git', 'kubectl'], files: { writeWithin: [] } },
  deny: { shell: ['curl'], github: [] },
};

/** The one setting that makes grok refuse, rather than ask about, a call no rule allows. */
function closedList(realHome: string) {
  return { permissions: { defaultMode: 'dontAsk' }, env: { HOME: realHome } };
}

describe('the grok engine', () => {
  let dir: string;
  // The home of whoever runs the engine. Stubbed, so no test reads the real one.
  let realHome: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleetadlc-grok-test-'));
    realHome = join(dir, 'real-home');
    mkdirSync(realHome);
    vi.stubEnv('HOME', realHome);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  const callWith = async (tools: ToolsPolicy): Promise<GrokCall> => {
    const record = join(dir, 'call.json');
    await runAll(new GrokEngine({ binary: fakeGrok(dir, GROK_RUN) }), {
      workdir: dir,
      model: 'grok-4',
      tools,
      env: { FAKE_GROK_RECORD: record },
    });
    return readCall(record);
  };

  it('runs Grok Build headless in the worktree, with the prompt in a file only it can read', async () => {
    const binary = fakeGrok(dir, GROK_RUN);
    const record = join(dir, 'call.json');
    const workdir = mkdtempSync(join(dir, 'worktree-'));
    // Longer than Linux lets one argument be, as a prompt with context files is.
    const prompt = `review the pull request\n${'context '.repeat(20_000)}`;
    const engine = new GrokEngine({ binary });

    const events = await runAll(engine, {
      workdir,
      prompt,
      model: 'grok-4',
      tools: reviewPolicy,
      env: {
        FAKE_GROK_RECORD: record,
        XAI_API_KEY: 'xai-account-key',
        GROK_DISABLE_AUTOUPDATER: '0',
        GROK_TELEMETRY_TRACE_UPLOAD: '1',
        GROK_FEEDBACK_ENABLED: '1',
      },
    });

    expect(events.filter((event) => event.type === 'error')).toEqual([]);
    const call = readCall(record);
    expect(call.cwd).toBe(realpathSync(workdir));
    expect(call.prompt).toBe(prompt);
    expect(call.promptMode).toBe(0o600);
    expect(call.args.join(' ')).not.toContain('review the pull request');
    expect(flagValue(call.args, '--output-format')).toBe('streaming-messages-json');
    expect(flagValue(call.args, '--model')).toBe('grok-4');
    // The task's environment is passed through; the self-updater, trace
    // upload and feedback stay off whatever it says, and a key account keeps
    // the `~/.grok` it always had.
    expect(call.env).toEqual({
      GROK_DISABLE_AUTOUPDATER: '1',
      GROK_FEEDBACK_ENABLED: '0',
      GROK_HOME: join(realHome, '.grok'),
      GROK_TELEMETRY_TRACE_UPLOAD: '0',
      HOME: join(dirname(flagValue(call.args, '--leader-socket')), 'home'),
      XAI_API_KEY: 'xai-account-key',
    });
  });

  it('refuses a call no rule allows instead of asking, which would end the run', async () => {
    // A headless grok answers its own approval prompt with "User cancelled",
    // ends the run and exits 0. Under `bypassPermissions` nothing asked, but
    // the allowlist was not enforced: a command neither listed nor denied ran.
    // The run's settings are what make grok refuse the call and carry on.
    for (const tools of [policy, reviewPolicy]) {
      const call = await callWith(tools);
      expect(call.settings).toEqual(closedList(realHome));
      expect(call.settingsMode).toBe(0o600);
      // The mode on the command line holds against an always-approve in the
      // shared login's config.toml, which would open every command again.
      expect(flagValue(call.args, '--permission-mode')).toBe('default');
      expect(call.args).not.toContain('bypassPermissions');
      expect(call.args).toEqual(expect.arrayContaining(['--disable-web-search', '--no-subagents', '--no-plan']));
    }
  });

  it('never gives grok --trust', async () => {
    // A trusted folder's own hooks, MCP servers and instructions load, and
    // the worktree is a checkout a builder can commit to.
    for (const tools of [policy, reviewPolicy, clusterPolicy]) {
      expect((await callWith(tools)).args).not.toContain('--trust');
    }
  });

  it("gives a builder the skill's commands and the worktree to edit, and nothing else", async () => {
    const builder = await callWith(policy);

    // One rule per command, as Claude's: `Bash(git:*)` is git and its
    // arguments, and a chain runs only when every part of it is allowed.
    expect(allowRules(builder.args)).toEqual(['Bash(make:*)', 'Bash(git:*)', 'Bash(gh:*)', 'Edit(./**)', 'Write(./**)']);
    expect(denyRules(builder.args)).toEqual(['Bash(curl:*)', 'Bash(sudo:*)', 'Bash(kubectl:*)']);
  });

  it("gives a reviewer the skill's commands and nowhere to write", async () => {
    const review = await callWith(reviewPolicy);

    expect(allowRules(review.args)).toEqual(['Bash(make:*)', 'Bash(git:*)', 'Bash(gh:*)', 'Bash(rg:*)']);
    // `Edit` and `Write` also stop a command that writes a file.
    expect(denyRules(review.args)).toEqual(['Bash(curl:*)', 'Bash(sudo:*)', 'Bash(kubectl:*)', 'Edit', 'Write']);
  });

  it("gives a skill that allows no shell none at all, grok's read-only commands included", async () => {
    const noShell: ToolsPolicy = { allow: { shell: [], files: { writeWithin: [] } }, deny: { shell: [], github: [] } };

    const readOnly = await callWith(noShell);

    expect(allowRules(readOnly.args)).toEqual([]);
    expect(denyRules(readOnly.args)).toEqual(['Bash', 'Edit', 'Write']);
    expect(readOnly.settings).toEqual(closedList(realHome));
  });

  it('denies what the skill denies, and kubectl unless the skill lists it', async () => {
    // Grok runs `kubectl get`, `logs` and `describe` without asking, as
    // read-only, whatever the rules say; they read a cluster.
    const unlisted = await callWith({ allow: { shell: ['git'] }, deny: { shell: [], github: [] } });
    expect(denyRules(unlisted.args)).toEqual(['Bash(kubectl:*)', 'Edit', 'Write']);

    const listed = await callWith(clusterPolicy);
    expect(allowRules(listed.args)).toEqual(['Bash(git:*)', 'Bash(kubectl:*)']);
    expect(denyRules(listed.args)).toEqual(['Bash(curl:*)', 'Edit', 'Write']);

    // Already denied, it is denied once.
    const denied = await callWith({ allow: { shell: ['git'] }, deny: { shell: ['kubectl'], github: [] } });
    expect(denyRules(denied.args)).toEqual(['Bash(kubectl:*)', 'Edit', 'Write']);
  });

  it('runs grok with a home of its own, which gives the shell the real one back', async () => {
    // The settings grok reads its mode from live in `~/.claude`, which is the
    // host's own Claude Code configuration; the run's home keeps them apart.
    // Commands must still see the real home, and the shell startup it runs.
    const home = join(dir, "o'brien home");
    mkdirSync(home);
    writeFileSync(join(home, '.profile'), 'export FROM_REAL_HOME=profile\n');
    writeFileSync(join(home, '.bashrc'), 'export FROM_REAL_HOME=bashrc\n');
    writeFileSync(join(home, '.zshenv'), 'export FROM_REAL_HOME=zshenv\n');
    const record = join(dir, 'call.json');

    await runAll(new GrokEngine({ binary: fakeGrok(dir, GROK_RUN) }), {
      workdir: dir,
      model: 'grok-4',
      env: { FAKE_GROK_RECORD: record, FAKE_GROK_SHIMS: '1', HOME: home, PATH: `/opt/fleetadlc/bin:${process.env.PATH}` },
    });

    const call = readCall(record);
    const runDir = dirname(flagValue(call.args, '--leader-socket'));
    // A login shell's /etc/profile resets PATH first; each startup file puts
    // the run's back in front, OpenADLC's gh and git first. Without it a grok
    // reviewer's `gh pr review` went to the real gh, unsigned.
    for (const after of Object.values((call as unknown as { paths: Record<string, string> }).paths)) {
      expect(after.startsWith('/opt/fleetadlc/bin:')).toBe(true);
    }
    expect(call.env.HOME).toBe(join(runDir, 'home'));
    expect(call.homeMode).toBe(0o700);
    expect(call.homeFiles).toEqual(['.bash_profile', '.bashrc', '.claude', '.zshenv']);
    expect(call.settings).toEqual(closedList(home));
    // bash as a login shell, grok's `source ~/.bashrc`, and zsh: each ends in
    // the real home, having read the file it would have read there.
    expect(call.shells).toEqual({
      '.bash_profile': `${home}|profile`,
      '.bashrc': `${home}|bashrc`,
      '.zshenv': `${home}|zshenv`,
    });
    expect(call.env.GROK_HOME).toBe(join(home, '.grok'));
    // Gone with the run, and nothing written to the real home.
    expect(existsSync(runDir)).toBe(false);
    expect(readdirSync(home).sort()).toEqual(['.bashrc', '.profile', '.zshenv']);
  });

  it('gives every run a leader socket of its own, outside GROK_HOME, and removes it', async () => {
    // Bots on one subscription share its GROK_HOME, whose default socket
    // would give them one leader between them.
    const binary = fakeGrok(dir, GROK_RUN);
    const grokHome = join(dir, 'shared-login');
    const calls: GrokCall[] = [];
    for (const run of ['first', 'second']) {
      const record = join(dir, `${run}.json`);
      await runAll(new GrokEngine({ binary }), {
        workdir: dir,
        model: 'grok-4',
        env: { FAKE_GROK_RECORD: record, GROK_HOME: grokHome },
      });
      calls.push(readCall(record));
    }

    const sockets = calls.map((call) => flagValue(call.args, '--leader-socket'));
    expect(new Set(sockets).size).toBe(2);
    for (const [index, socket] of sockets.entries()) {
      expect(socket.startsWith(tmpdir())).toBe(true);
      expect(socket.startsWith(grokHome)).toBe(false);
      expect(calls[index]?.env.GROK_HOME).toBe(grokHome);
      // Private while grok ran, and gone once the run was over.
      expect(calls[index]?.socketDirMode).toBe(0o700);
      expect(existsSync(dirname(socket))).toBe(false);
    }
  });

  it('reads the stream: text, tool calls, file changes, usage once, and done', async () => {
    const engine = new GrokEngine({ binary: fakeGrok(dir, GROK_RUN) });

    const events = await runAll(engine, { workdir: dir, model: 'grok-4', tools: policy });

    expect(events.filter((event) => event.type === 'text').map((event) => event.text)).toEqual([
      'Creating the file.',
      'Editing it.',
      'All done.',
    ]);
    expect(events.filter((event) => event.type === 'tool_call')).toEqual([
      { type: 'tool_call', name: 'write', summary: '/work/repo/notes/hello.txt' },
      { type: 'tool_call', name: 'search_replace', summary: 'notes/hello.txt' },
      { type: 'tool_call', name: 'run_terminal_command', summary: 'make --version' },
      { type: 'tool_call', name: 'run_terminal_command', summary: 'curl -sS https://example.com' },
      { type: 'tool_call', name: 'run_terminal_command', summary: 'git status --short' },
    ]);
    expect(events.filter((event) => event.type === 'file_change')).toEqual([
      { type: 'file_change', path: '/work/repo/notes/hello.txt' },
      { type: 'file_change', path: 'notes/hello.txt' },
    ]);
    // Four model responses as they came, then the rest of the stamped cost.
    const recorded = usageOf(events);
    expect(recorded.tokensIn).toBe(4600);
    expect(recorded.tokensOut).toBe(140);
    expect(recorded.costUsd).toBeCloseTo(0.0125, 4);
    expect(engine.usage()).toEqual({ tokensIn: 4600, tokensOut: 140, costUsd: 0.0125 });
    expect(events.filter((event) => event.type === 'error')).toEqual([]);
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'complete' });
  });

  it('says why when grok is not signed in', async () => {
    const binary = fakeGrok(
      dir,
      [
        JSON.stringify({ ...GROK_INIT, session_id: '', model: 'unknown', cwd: '', tools: [] }),
        JSON.stringify({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          duration_ms: 0,
          num_turns: 0,
          stop_reason: null,
          total_cost_usd: 0.0,
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          modelUsage: {},
          errors: [NOT_SIGNED_IN],
          session_id: '',
        }),
      ],
      `Error: ${NOT_SIGNED_IN}\n`,
      1,
    );

    const reason = await failureOf(new GrokEngine({ binary }), dir);

    expect(reason).toContain('engine exited 1');
    expect(reason).toContain('Not signed in');
  });

  it('reports a run grok cancelled part-way, although it exits 0', async () => {
    // What grok 1.0.41 writes when a call waits on an approval a headless run
    // cannot give. It exits 0, and a task that stopped half-done would
    // otherwise be recorded as complete.
    const binary = fakeGrok(dir, [
      JSON.stringify(GROK_INIT),
      JSON.stringify(
        grokAssistant(
          'msg_0',
          [{ type: 'tool_use', id: 'call_1_1', name: 'run_terminal_command', input: { command: 'node -e 1' } }],
          100,
          10,
        ),
      ),
      JSON.stringify(
        grokToolResults([
          { id: 'call_1_1', content: 'User cancelled the execution for tool `run_terminal_command`', isError: true },
        ]),
      ),
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        num_turns: 1,
        total_cost_usd: 0.0,
        usage: { input_tokens: 100, output_tokens: 10 },
        errors: ['cancelled'],
      }),
    ]);

    const events = await runAll(new GrokEngine({ binary }), { workdir: dir, model: 'grok-4' });

    expect(events.filter((event) => event.type === 'error')).toEqual([
      { type: 'error', message: 'engine reported a failure: cancelled' },
    ]);
    expect(events.some((event) => event.type === 'done')).toBe(false);
    // What it spent before it stopped is still spent.
    expect(usageOf(events)).toMatchObject({ tokensIn: 100, tokensOut: 10 });
  });

  it('is not available without its command, even with a key', async () => {
    // A key once made it available, and the task ran as a single chat
    // completion with no tools, which no skill can work in: it spent tokens
    // and posted nothing.
    vi.stubEnv('XAI_API_KEY', 'xai-test-key');

    expect(await new GrokEngine({ binary: join(dir, 'no-grok-here') }).available()).toBe(false);
  });

  it('is available with its command and no key, but not without either', async () => {
    vi.stubEnv('XAI_API_KEY', '');

    expect(await new GrokEngine({ binary: fakeGrok(dir, []) }).available()).toBe(true);
    expect(await new GrokEngine({ binary: join(dir, 'no-grok-here') }).available()).toBe(false);
  });
});

describe('mock engine', () => {
  it('streams text, records usage and reports a question as a gate', async () => {
    const engine = new MockEngine({
      say: ['reading the issue'],
      ask: { question: 'which table owns the join?', options: ['matters', 'documents'] },
    });

    const events = [];
    for await (const event of engine.run({
      contextFiles: [],
      prompt: 'go',
      workdir: '/tmp',
      env: {},
      model: 'mock',
      tools: policy,
      costHeadroomUsd: 15,
    })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(['text', 'usage', 'question', 'done']);
    expect(engine.usage().tokensIn).toBeGreaterThan(0);
  });

  it('asks to widen its paths with the plan_change marker, which the runner reads as a question', async () => {
    const engine = new MockEngine({
      say: ['the fix needs config/bots.yaml'],
      planChange: { paths: ['config/bots.yaml'], reason: 'The seat is defined there.' },
    });

    const events: EngineEvent[] = [];
    for await (const event of engine.run({ contextFiles: [], prompt: 'go', workdir: '/tmp', env: {}, model: 'mock', tools: policy, costHeadroomUsd: 15 })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(['text', 'usage', 'text', 'done']);
    const asked = parseQuestion(events[2]?.type === 'text' ? events[2].text : '');
    expect(asked?.planChange).toEqual({ paths: ['config/bots.yaml'], reason: 'The seat is defined there.' });
  });
});

describe('the git and GitHub rules every engine carries', () => {
  // No engine has a permission for "push only to agent/" or "no `gh pr
  // review`", so they are applied by OpenADLC's own git and gh, which read them
  // from the environment of what the engine runs. An engine that did not pass
  // them on ran its commands under no rules at all.
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleetadlc-tools-env-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  /** A CLI that writes down the rules it was started with, and nothing else. */
  function recorder(name: string): string {
    const path = join(dir, name);
    writeFileSync(
      path,
      [
        '#!/usr/bin/env node',
        'require("node:fs").writeFileSync(process.env.FAKE_RECORD, process.env.FLEETADLC_TOOLS_POLICY ?? "");',
        'process.stdin.resume();',
        'process.stdin.on("end", () => process.exit(0));',
        'setTimeout(() => process.exit(0), 200);',
        '',
      ].join('\n'),
    );
    chmodSync(path, 0o755);
    return path;
  }

  const engines: Array<[string, () => Engine]> = [
    ['claude', () => new ClaudeEngine(recorder('claude'))],
    ['codex', () => new CodexEngine(recorder('codex'), { contained: true })],
    ['grok', () => new GrokEngine({ binary: recorder('grok') })],
  ];

  for (const [name, make] of engines) {
    it(`${name} passes the skill's push prefix, force rule and denied gh commands to what it runs`, async () => {
      vi.stubEnv('HOME', dir);
      const record = join(dir, `${name}.policy`);
      // A task's own environment cannot lift them.
      await runAll(make(), { workdir: dir, env: { FAKE_RECORD: record, FLEETADLC_TOOLS_POLICY: '{}' } });

      expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual({
        pushBranchPrefix: 'agent/',
        forcePush: false,
        localCi: false,
        denyGithub: ['pr review', 'api'],
      });
    });
  }

  it('says a skill with no git rules pushes nowhere', () => {
    const review: ToolsPolicy = { allow: { shell: ['git'] }, deny: { shell: [], github: ['pr merge'] } };
    expect(JSON.parse(toolsPolicyEnv(review)[TOOLS_POLICY_ENV] ?? '')).toEqual({
      pushBranchPrefix: null,
      forcePush: false,
      localCi: false,
      denyGithub: ['pr merge'],
    });
  });

  it('carries the build skill’s local CI rule to what it runs', () => {
    const build = loadToolsPolicy(join(import.meta.dirname, '..', '..', '..', 'crew', 'skills', 'implement', 'tools.yaml'));
    expect(JSON.parse(toolsPolicyEnv(build)[TOOLS_POLICY_ENV] ?? '')).toMatchObject({ pushBranchPrefix: 'agent/', localCi: true });
    expect(build.allow.shell).toContain('fleetadlc-ci');
    expect(build.deny.github).toContain('pr merge');
  });
});
