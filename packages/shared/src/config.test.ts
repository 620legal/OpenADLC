import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  botsFileSchema,
  costsFileSchema,
  leadReviewer,
  loadYamlFile,
  repoConfigSchema,
  reposFileSchema,
  reviewRulesSchema,
} from './config.js';
import { DEFAULT_DELIVERY_RULES, deliveryRulesFrom, parseDeliveryRules } from './delivery-rules.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('review rules', () => {
  // The shape every install's config/review.yaml had before reviewers were a list.
  const older = {
    lead: 'lead-reviewer',
    second: 'second-reviewer',
    security: { bot: 'security-reviewer', labels: ['touches:security', 'deps'], paths: ['packages/github/'], samplePercent: 10 },
    workflows: { bot: 'sre', paths: ['.github/workflows/', 'infra/'] },
    maxRounds: 4,
  };

  it('reads an older review.yaml as the reviewers it meant, so fleetadlc up does not fail on it', () => {
    const rules = reviewRulesSchema.parse(older);
    expect(rules.reviewers).toEqual([
      { seat: 'lead-reviewer', lens: 'lead', lead: true, blocking: false, trigger: 'always' },
      { seat: 'second-reviewer', lens: 'second', lead: false, blocking: false, trigger: 'always' },
      {
        seat: 'security-reviewer',
        lens: 'security',
        lead: false,
        blocking: false,
        trigger: { labels: ['touches:security', 'deps'], paths: ['packages/github/'], samplePercent: 10 },
      },
      { seat: 'sre', lens: 'workflows', lead: false, blocking: false, trigger: { labels: [], paths: ['.github/workflows/', 'infra/'], samplePercent: 0 } },
    ]);
    expect(rules.maxRounds).toBe(4);
    expect(rules.sendBack).toEqual({ maxPerEdge: 2, maxPerIssue: 6 });
    expect(leadReviewer(rules).seat).toBe('lead-reviewer');
  });

  it('keeps one entry for a seat the older file named twice, asked whenever either asked it', () => {
    const rules = reviewRulesSchema.parse({ ...older, workflows: { bot: 'security-reviewer', paths: ['infra/'] } });
    expect(rules.reviewers.map((seat) => seat.seat)).toEqual(['lead-reviewer', 'second-reviewer', 'security-reviewer']);
    expect(rules.reviewers[2]?.trigger).toEqual({ labels: ['touches:security', 'deps'], paths: ['packages/github/', 'infra/'], samplePercent: 10 });
  });

  it('holds exactly one lead, and each seat once', () => {
    const seat = (name: string, lead = false) => ({ seat: name, lens: name, lead });
    expect(() => reviewRulesSchema.parse({ reviewers: [seat('a'), seat('b')] })).toThrow(/exactly one reviewer is the lead/);
    expect(() => reviewRulesSchema.parse({ reviewers: [seat('a', true), seat('b', true)] })).toThrow(/exactly one reviewer is the lead/);
    expect(() => reviewRulesSchema.parse({ reviewers: [seat('a', true), seat('a')] })).toThrow(/listed once/);
    expect(reviewRulesSchema.parse({ reviewers: [seat('a', true)] }).reviewers[0]).toMatchObject({ trigger: 'always', blocking: false });
  });

  it('parses the review.yaml this repository ships', () => {
    const rules = reviewRulesSchema.parse(parseYaml(readFileSync(join(repoRoot, 'config', 'review.yaml'), 'utf8')));
    expect(leadReviewer(rules).seat).toBe('lead-reviewer');
  });
});

describe('delivery rules', () => {
  it('fills what a short file leaves out with deploy-on-merge and production after a soak, with nobody asked', () => {
    expect(parseDeliveryRules('version: 1\n')).toEqual({ rules: DEFAULT_DELIVERY_RULES });
    expect(DEFAULT_DELIVERY_RULES).toMatchObject({
      testing: { on: 'merge', workflow: 'deploy-testing', smoke: 'smoke-testing' },
      production: { on: 'after-testing', approval: 'auto', soakMinutes: 30, workflow: 'promote-production', rollback: 'rollback-production' },
    });
  });

  it('fills an approval or soak the rules leave out from the repository’s recorded choice, before the default', () => {
    // A repository that was there before the default changed: the migration recorded `reviewers` and no soak.
    const recorded = { approval: 'reviewers' as const, soakMinutes: 0 };
    expect(parseDeliveryRules('version: 1\n', recorded)).toMatchObject({ rules: { production: { approval: 'reviewers', soakMinutes: 0 } } });
    expect(deliveryRulesFrom('version: 1\n', null, recorded).production).toMatchObject({ approval: 'reviewers', soakMinutes: 0 });
    // Stored rules that say nothing of it, and none at all, take it too.
    expect(deliveryRulesFrom(null, { version: 1, testing: { on: 'merge' } }, recorded).production.approval).toBe('reviewers');
    expect(deliveryRulesFrom(null, null, recorded).production.approval).toBe('reviewers');
    // What the file says wins over the choice, field by field.
    expect(parseDeliveryRules('version: 1\nproduction:\n  approval: auto\n', recorded)).toMatchObject({ rules: { production: { approval: 'auto', soakMinutes: 0 } } });
    // No choice recorded: the default.
    expect(parseDeliveryRules('version: 1\n', { approval: null, soakMinutes: null })).toEqual({ rules: DEFAULT_DELIVERY_RULES });
  });

  it('reads a soak with no reviewers', () => {
    const parsed = parseDeliveryRules('version: 1\ntesting:\n  url: https://testing.example.com\nproduction:\n  approval: auto\n  soakMinutes: 30\n');
    expect(parsed).toMatchObject({ rules: { testing: { url: 'https://testing.example.com' }, production: { approval: 'auto', soakMinutes: 30 } } });
  });

  it('holds back as little as it can when a file says nothing about paths: shared files never, exclusive ones through review', () => {
    expect(DEFAULT_DELIVERY_RULES.paths.shared).toEqual(expect.arrayContaining(['Makefile', 'README*', 'package.json']));
    expect(DEFAULT_DELIVERY_RULES.paths.exclusive).toEqual(expect.arrayContaining(['**/migrations/**', 'pnpm-lock.yaml']));
    const parsed = parseDeliveryRules('version: 1\npaths:\n  shared: [Makefile]\n  exclusive: [schema/**]\n');
    expect(parsed).toMatchObject({ rules: { paths: { shared: ['Makefile'], exclusive: ['schema/**'] } } });
    // One list given, the other keeps its default.
    expect(parseDeliveryRules('version: 1\npaths:\n  shared: [Makefile]\n')).toMatchObject({
      rules: { paths: { shared: ['Makefile'], exclusive: expect.arrayContaining(['**/migrations/**']) } },
    });
  });

  it('says what is wrong with a file rather than reading it as the defaults', () => {
    expect(parseDeliveryRules('version: 1\nproduction:\n  approval: nobody\n')).toMatchObject({ error: expect.stringMatching(/production\.approval/) });
    expect(parseDeliveryRules('version: 2\n')).toMatchObject({ error: expect.stringMatching(/version/) });
    expect(parseDeliveryRules('testing: [')).toMatchObject({ error: expect.stringMatching(/not YAML/) });
  });

  it('takes testing.url only as an http(s) address, as the console does', () => {
    // The file's value wins over the console's, which refused these.
    expect(parseDeliveryRules('version: 1\ntesting:\n  url: file:///etc/passwd\n')).toMatchObject({ error: expect.stringMatching(/testing\.url/) });
    expect(parseDeliveryRules('version: 1\ntesting:\n  url: javascript:alert(1)\n')).toMatchObject({ error: expect.stringMatching(/testing\.url/) });
    expect(parseDeliveryRules('version: 1\ntesting:\n  url: http://testing.example.com\n')).toMatchObject({ rules: { testing: { url: 'http://testing.example.com' } } });
  });
});

describe('a bots.yaml written before teams were removed', () => {
  it('still loads, and the key is dropped', () => {
    // Every install's config/bots.yaml had `teams:` on each seat. Refusing it,
    // as the schema refuses any other key it does not read, would stop
    // `fleetadlc up` on all of them.
    const parsed = botsFileSchema.parse({
      bots: [{ slot: 'builder', displayName: 'Builder', role: 'implement', engine: 'claude', model: 'claude-sonnet-5', teams: ['owners-fleetadlc'] }],
    });

    expect(parsed.bots[0]).toMatchObject({ slot: 'builder', role: 'implement' });
    expect(parsed.bots[0]).not.toHaveProperty('teams');
  });
});

describe('a repository’s stage modes', () => {
  const base = { name: 'api', fullName: 'acme/api', owner: 'builder' };

  it.each(['build', 'review', 'merged', 'done'])('refuses untouched for %s, and says how to stop its bots instead', (stage) => {
    const parsed = repoConfigSchema.safeParse({ ...base, stageModes: { [stage]: 'untouched' } });
    expect(parsed.success).toBe(false);
    const message = parsed.success ? '' : parsed.error.issues.map((issue) => issue.message).join('\n');
    expect(message).toContain(`${stage} cannot be untouched`);
    expect(message).toContain('Remove the line');
    expect(message).toContain('pause the repository');
  });

  it('takes untouched for intake and spec, where it means no bot staffs the stage', () => {
    expect(repoConfigSchema.parse({ ...base, stageModes: { intake: 'untouched', spec: 'untouched' } }).stageModes).toEqual({
      intake: 'untouched',
      spec: 'untouched',
    });
  });
});

describe('a repository in repos.yaml', () => {
  it('leaves out what the file leaves out, so the seed keeps the row’s value rather than a default', () => {
    // Defaults filled in here were written over the row at every start: a
    // stage set to untouched in the console went back to autonomous.
    const parsed = reposFileSchema.parse({ repos: [{ name: 'api', fullName: 'acme/api', owner: 'builder' }] }).repos[0]!;
    expect(parsed).toEqual({ name: 'api', fullName: 'acme/api', owner: 'builder' });
    for (const field of ['concurrency', 'defaultBranch', 'stageModes', 'specRequiredLabels', 'humanReviewPaths']) {
      expect(parsed).not.toHaveProperty(field);
    }
  });

  it('keeps what the file writes', () => {
    const parsed = reposFileSchema.parse({
      repos: [{ name: 'api', fullName: 'acme/api', owner: 'builder', concurrency: 2, stageModes: { spec: 'untouched' } }],
    }).repos[0]!;
    expect(parsed).toMatchObject({ concurrency: 2, stageModes: { spec: 'untouched' } });
  });
});

describe('the repos.yaml organization', () => {
  it('may be left out: nothing reads it, and its comment said so while the schema refused a file without it', () => {
    expect(reposFileSchema.parse({ repos: [] })).toEqual({ repos: [] });
  });
});

describe('a key no schema reads', () => {
  const bot = { slot: 'builder', displayName: 'Builder', role: 'implement', engine: 'claude', model: 'claude-sonnet-5' };
  const repo = { name: 'widgets', fullName: 'exampleco/widgets', owner: 'builder' };
  const lead = { seat: 'lead-reviewer', lens: 'lead', lead: true };

  // Each of these parsed, and fell back to a default with nothing said.
  it.each([
    ['a monthly cap spelt monthlyCapUSD', () => costsFileSchema.parse({ monthlyCapUSD: 100 })],
    ['a key under onCap', () => costsFileSchema.parse({ onCap: { stopLeasng: false } })],
    ['a reviewer that is blocked rather than blocking', () => reviewRulesSchema.parse({ reviewers: [lead, { seat: 'security-reviewer', lens: 'security', blocked: true }] })],
    ['a reviewer with triggers rather than a trigger', () => reviewRulesSchema.parse({ reviewers: [lead, { seat: 'sre', lens: 'workflows', triggers: { labels: ['infra'] } }] })],
    ['a key in a trigger', () => reviewRulesSchema.parse({ reviewers: [lead, { seat: 'sre', lens: 'workflows', trigger: { label: ['infra'] } }] })],
    ['a key under sendBack', () => reviewRulesSchema.parse({ reviewers: [lead], sendBack: { maxPerEdges: 1 } })],
    ['a bot given memoryGB', () => botsFileSchema.parse({ bots: [{ ...bot, memoryGB: 16 }] })],
    ['a bot given max_tasks', () => botsFileSchema.parse({ bots: [{ ...bot, max_tasks: 4 }] })],
    ['a repository given concurency', () => reposFileSchema.parse({ repos: [{ ...repo, concurency: 4 }] })],
    ['a key beside bots', () => botsFileSchema.parse({ bots: [bot], crew: [] })],
  ])('is refused: %s', (_what, parse) => {
    expect(parse).toThrow(/[Uu]nrecognized key/);
  });

  it('refuses conditional on any stage but spec', () => {
    expect(() => repoConfigSchema.parse({ ...repo, stageModes: { build: 'conditional' } })).toThrow(/conditional is for the spec stage alone/);
    expect(() => repoConfigSchema.parse({ ...repo, stageModes: { merged: 'conditional' } })).toThrow(/spec stage alone/);
    expect(repoConfigSchema.parse({ ...repo, stageModes: { spec: 'conditional' } }).stageModes).toEqual({ spec: 'conditional' });
  });

  it('is named, with its file, when a file is loaded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleetadlc-config-'));
    try {
      const costs = join(dir, 'costs.yaml');
      writeFileSync(costs, 'monthlyCapUSD: 100\nonCap:\n  stopLeasng: false\n');
      expect(() => loadYamlFile(costs, costsFileSchema)).toThrow(`${costs}: monthlyCapUSD is not a setting OpenADLC reads`);
      expect(() => loadYamlFile(costs, costsFileSchema)).toThrow(`${costs}: onCap.stopLeasng is not a setting OpenADLC reads`);

      const repos = join(dir, 'repos.yaml');
      writeFileSync(repos, 'repos:\n  - name: widgets\n    fullName: exampleco/widgets\n    owner: builder\n    stageModes: {build: conditional}\n');
      expect(() => loadYamlFile(repos, reposFileSchema)).toThrow(`${repos}: repos.0.stageModes.build: conditional is for the spec stage alone`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is not what an older file’s retired keys are: they are taken off first', () => {
    const parsed = botsFileSchema.parse({ bots: [{ ...bot, slot: undefined, name: 'atlas', teams: ['flow'], githubLogin: 'fleetadlc-atlas' }] });
    expect(parsed.bots[0]).toMatchObject({ slot: 'builder' });
    expect(parsed.bots[0]).not.toHaveProperty('name');
  });
});

describe('the config files this repository ships', () => {
  const read = (name: string) => parseYaml(readFileSync(join(repoRoot, 'config', name), 'utf8'));

  it('present no key that nothing reads as if it were a setting', () => {
    // onCap.pauseReviewsAt and onCap.notify, and a seat's skills, are read and
    // not used. Shipped with values, they read as reviews that pause and an
    // owner who is told.
    expect(read('costs.yaml').onCap).toEqual({ stopLeasing: true });
    for (const seat of read('bots.yaml').bots) expect(seat).not.toHaveProperty('skills');
  });

  it('still load', () => {
    expect(costsFileSchema.parse(read('costs.yaml')).onCap.stopLeasing).toBe(true);
    expect(botsFileSchema.parse(read('bots.yaml')).bots.length).toBeGreaterThan(0);
    expect(reposFileSchema.parse(read('repos.yaml')).repos).toEqual([]);
  });

  it('each load through its schema, every one of them, now that an unknown key is refused', () => {
    const schemas: Record<string, z.ZodTypeAny> = {
      'bots.yaml': botsFileSchema,
      'repos.yaml': reposFileSchema,
      'costs.yaml': costsFileSchema,
      'review.yaml': reviewRulesSchema,
    };
    // models.example.yaml is the engines' price list, read by their own parser.
    const others = ['models.example.yaml'];
    const shipped = readdirSync(join(repoRoot, 'config')).filter((name) => /\.ya?ml$/.test(name));
    expect(shipped.filter((name) => !others.includes(name)).sort()).toEqual(Object.keys(schemas).sort());
    for (const [name, schema] of Object.entries(schemas)) {
      expect(() => loadYamlFile(join(repoRoot, 'config', name), schema), name).not.toThrow();
    }
  });
});
