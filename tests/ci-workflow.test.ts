import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYamlFile } from '@openadlc/shared';
import { describe, expect, it } from 'vitest';

/**
 * The shape of ci.yml that its verdict, the merge line and release-check.mjs
 * rely on. The unit tests and the integration suites were one job, `check`,
 * and are two that run side by side (#65): `check`, and `integration`, which
 * builds everything and drives an install. A job the verdict does not read
 * passes whatever it does, so the graph is pinned here.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

interface Step {
  name?: string;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}

interface Job {
  name?: string;
  needs?: string | string[];
  if?: string;
  services?: Record<string, unknown>;
  steps: Step[];
}

const workflow = parseYamlFile(join(ROOT, '.github', 'workflows', 'ci.yml')) as { jobs: Record<string, Job> };
const { jobs } = workflow;
const needsOf = (job: Job) => (Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : []);
const verdict = jobs.ci!.steps.find((step) => step.name === 'verdict')!;
const DRAFT = '!github.event.pull_request.draft';
const SUITES = ['pipeline', 'terminal', 'kill-and-restart', 'concurrency', 'onboarding'];

/** The verdict step's script, run as GitHub runs it, with the results given. */
function verdictOf(results: Record<string, string>): number | null {
  const env = {
    PATH: process.env.PATH ?? '',
    CHANGES: 'success',
    SECRETS: 'success',
    CHECK: 'skipped',
    INTEGRATION: 'skipped',
    DOCS: 'skipped',
    CLOUD: 'skipped',
    CODE: 'true',
    INFRA: 'false',
    TESTED: 'false',
    ...results,
  };
  return spawnSync('bash', ['-e', '-c', verdict.run!], { env, encoding: 'utf8' }).status;
}

describe("ci.yml's jobs", () => {
  it('are each read by the verdict', () => {
    for (const name of Object.keys(jobs).filter((name) => name !== 'ci')) {
      expect(needsOf(jobs.ci!), name).toContain(name);
      expect(Object.values(verdict.env ?? {}), name).toContain(`\${{ needs.${name}.result }}`);
    }
  });

  it('fail the verdict when either the unit tests or the integration suites did not pass', () => {
    const code = { CHECK: 'success', INTEGRATION: 'success' };
    expect(verdictOf(code)).toBe(0);
    expect(verdictOf({ ...code, INTEGRATION: 'failure' })).toBe(1);
    // Skipped when the change needed it is not a pass.
    expect(verdictOf({ ...code, INTEGRATION: 'skipped' })).toBe(1);
    expect(verdictOf({ ...code, CHECK: 'failure' })).toBe(1);
    expect(verdictOf({ ...code, SECRETS: 'failure' })).toBe(1);
    // Docs alone, and a tree a pull request already passed, need neither.
    expect(verdictOf({ CODE: 'false', DOCS: 'success' })).toBe(0);
    expect(verdictOf({ TESTED: 'true', SECRETS: 'skipped' })).toBe(0);
  });

  it('run the unit tests and the integration suites for the same changes, side by side', () => {
    expect(jobs.integration!.if).toBe(jobs.check!.if);
    expect(needsOf(jobs.check!)).toEqual(['changes']);
    expect(needsOf(jobs.integration!)).toEqual(['changes']);
  });

  it('keep the name release-check.mjs reads for "ran the tests"', () => {
    expect(jobs.check!.name).toBe('check');
    expect(readFileSync(join(ROOT, '.github', 'scripts', 'release-check.mjs'), 'utf8')).toContain("job.name === 'check'");
  });

  it('run in check what a builder runs, once what the apps import is built', () => {
    const runs = jobs.check!.steps.map((step) => step.run?.trim());
    const built = runs.indexOf('pnpm build:imported');
    expect(built).toBeGreaterThanOrEqual(0);
    expect(runs.indexOf('make ci')).toBeGreaterThan(built);
    // Nothing in check is left to a draft's say.
    expect(jobs.check!.steps.filter((step) => step.if?.includes('draft'))).toEqual([]);
  });

  it('build everything, migrate and seed in integration on a draft too, and skip only the suites', () => {
    const steps = jobs.integration!.steps;
    for (const run of ['pnpm build', 'pnpm db:migrate', 'pnpm db:seed']) {
      const step = steps.find((one) => one.run?.trim() === run);
      expect(step, run).toBeDefined();
      expect(step!.if, run).toBeUndefined();
    }
    for (const suite of SUITES) {
      const step = steps.find((one) => one.run?.trim() === `node tests/${suite}.mjs`);
      expect(step, suite).toBeDefined();
      expect(step!.if).toBe(`\${{ ${DRAFT} }}`);
    }
    expect(Object.keys(jobs.integration!.services ?? {})).toEqual(['postgres']);
  });

  it("install from pnpm's store, which setup-node keeps keyed by the lockfile", () => {
    for (const [name, job] of Object.entries(jobs)) {
      const installs = job.steps.filter((step) => step.run?.includes('pnpm install'));
      if (installs.length === 0) continue;
      for (const install of installs) expect(install.run?.trim(), name).toBe('pnpm install --frozen-lockfile');
      const node = job.steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
      expect(node?.with?.cache, name).toBe('pnpm');
    }
  });
});
