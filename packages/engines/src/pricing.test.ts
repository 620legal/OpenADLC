import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { costOf, loadModelPrices, MODEL_PRICES_ENV, modelPricesEnv, readModelPrices, resetModelPrices } from './pricing.js';

/**
 * Where a session's prices come from. A session runs in the task's clone of a
 * managed repository, and it used to read `config/models.yaml` from there: a
 * pull request that carried one with a price of 0 or below priced its own
 * review, and a repository with an unrelated `config/models.yaml` failed every
 * task on its first usage line.
 */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleetadlc-pricing-'));
  delete process.env[MODEL_PRICES_ENV];
  delete process.env.FLEETADLC_CONFIG_ROOT;
  resetModelPrices();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  delete process.env[MODEL_PRICES_ENV];
  resetModelPrices();
});

function models(root: string, yaml: string): string {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'models.yaml'), yaml);
  return root;
}

describe('a session’s prices', () => {
  const repositoryFiles: [string, string][] = [
    ['free', 'models:\n  claude-opus-5:\n    inPerMtok: 0\n    outPerMtok: 0\n'],
    ['negative', 'models:\n  claude-opus-5:\n    inPerMtok: -400000\n    outPerMtok: 25\n'],
    ['unrelated', 'models:\n  - name: resnet50\n    layers: 50\n'],
  ];

  for (const [name, yaml] of repositoryFiles) {
    it(`never come from the working directory's config/models.yaml (${name})`, () => {
      models(join(dir, 'config'), yaml);
      vi.spyOn(process, 'cwd').mockReturnValue(dir);

      loadModelPrices();

      expect(costOf('claude-opus-5', 1_000_000, 0)).toBeCloseTo(5, 4);
    });
  }

  it('come from what hostd handed the session, the install’s own file', () => {
    process.env[MODEL_PRICES_ENV] = JSON.stringify({ 'claude-opus-5': { inPerMtok: 250, outPerMtok: 25 } });
    models(join(dir, 'config'), repositoryFiles[0]?.[1] ?? '');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);

    loadModelPrices();

    expect(costOf('claude-opus-5', 1_000_000, 0)).toBeCloseTo(250, 4);
  });

  it('refuse a negative price handed over, and are not half taken when they do', () => {
    process.env[MODEL_PRICES_ENV] = JSON.stringify({
      'claude-opus-5': { inPerMtok: 1, outPerMtok: 1 },
      'claude-sonnet-5': { inPerMtok: -1, outPerMtok: 1 },
    });

    expect(() => loadModelPrices()).toThrow(/claude-sonnet-5's inPerMtok/);
    // The good row before the bad one was not taken on its own.
    delete process.env[MODEL_PRICES_ENV];
    loadModelPrices();
    expect(costOf('claude-opus-5', 1_000_000, 0)).toBeCloseTo(5, 4);
  });
});

describe('the install’s models.yaml', () => {
  it('is nothing when there is no file', () => {
    expect(readModelPrices(dir)).toEqual({});
    expect(modelPricesEnv({})).toEqual({});
  });

  it('is handed to a session as JSON that reads back the same', () => {
    const table = readModelPrices(models(dir, 'models:\n  gpt-5-codex:\n    inPerMtok: 250\n    outPerMtok: 10\n'));

    expect(table).toEqual({ 'gpt-5-codex': { inPerMtok: 250, outPerMtok: 10 } });
    expect(JSON.parse(modelPricesEnv(table)[MODEL_PRICES_ENV] ?? '')).toEqual(table);
  });

  const refused: [string, string, RegExp][] = [
    ['no models map', 'prices:\n  claude-opus-5: 1\n', /has no `models:` map/],
    ['a list, not a map', 'models:\n  - name: resnet50\n', /has no `models:` map/],
    ['a missing price', 'models:\n  claude-opus-5:\n    inPerMtok: 5\n', /claude-opus-5's outPerMtok/],
    ['a negative price', 'models:\n  claude-opus-5:\n    inPerMtok: -1\n    outPerMtok: 25\n', /claude-opus-5's inPerMtok/],
    ['an infinite price', 'models:\n  claude-opus-5:\n    inPerMtok: .inf\n    outPerMtok: 25\n', /claude-opus-5's inPerMtok/],
    ['a price that is not a number', 'models:\n  claude-opus-5:\n    inPerMtok: .nan\n    outPerMtok: 25\n', /claude-opus-5's inPerMtok/],
  ];

  for (const [name, yaml, reason] of refused) {
    it(`is refused, naming the file, for ${name}`, () => {
      models(dir, yaml);

      expect(() => readModelPrices(dir)).toThrow(reason);
      expect(() => readModelPrices(dir)).toThrow(join(dir, 'models.yaml'));
    });
  }

  it('takes a price of 0, which the scripted engine is charged', () => {
    expect(readModelPrices(models(dir, 'models:\n  mock:\n    inPerMtok: 0\n    outPerMtok: 0\n'))).toEqual({
      mock: { inPerMtok: 0, outPerMtok: 0 },
    });
  });
});
