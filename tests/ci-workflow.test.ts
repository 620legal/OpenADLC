import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYamlFile } from '@openadlc/shared';
import { describe, expect, it } from 'vitest';
import { evaluate, holds } from './actions-expression.ts';

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
    EARLIER: 'skipped',
    COPY: '',
    COPIED: '',
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

  it('report the earlier ci on a run that copies it, before anything else they read', () => {
    // Every other job is skipped on such a run: the verdict stands on the copy alone.
    const skipped = { CHANGES: 'skipped', SECRETS: 'skipped', CHECK: 'skipped', INTEGRATION: 'skipped', DOCS: 'skipped', CLOUD: 'skipped', CODE: '', INFRA: '', TESTED: '', EARLIER: 'success' };
    expect(verdictOf({ ...skipped, COPY: 'success' })).toBe(0);
    expect(verdictOf({ ...skipped, COPY: 'failure' })).toBe(1);
    expect(verdictOf({ ...skipped, COPY: 'timeout' })).toBe(1);
    // Nothing copied is today's verdict, whatever the lookup did.
    expect(verdictOf({ ...skipped, COPY: '' })).toBe(1);
    expect(verdictOf({ CHECK: 'success', INTEGRATION: 'success', COPY: '', EARLIER: 'skipped' })).toBe(0);
    expect(verdictOf({ CHECK: 'success', INTEGRATION: 'failure', COPY: '', EARLIER: 'skipped' })).toBe(1);
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

/** An event as the workflow's expressions read it: a pull request of acme/openadlc unless it says otherwise. */
interface Event {
  event?: string;
  action?: string;
  label?: string;
  changes?: Record<string, unknown>;
  draft?: boolean;
  crew?: boolean;
  labels?: string[];
}

function github(event: Event): Record<string, unknown> {
  const repository = 'acme/openadlc';
  const name = event.event ?? 'pull_request';
  return {
    event_name: name,
    repository,
    head_ref: name === 'pull_request' ? (event.crew ? 'agent/builder/7-x' : 'feature') : '',
    event:
      name === 'pull_request'
        ? {
            action: event.action ?? 'synchronize',
            label: event.label ? { name: event.label } : null,
            changes: event.changes ?? null,
            pull_request: { draft: event.draft ?? false, head: { repo: { full_name: repository, id: 42 } }, labels: (event.labels ?? []).map((label) => ({ name: label })) },
          }
        : {},
  };
}

const context = (event: Event, copy: string | null = '') => ({ github: github(event), needs: { earlier: { outputs: { copy } } } });

describe('a run of ci.yml that runs nothing', () => {
  // The bug: a green pull request had `needs-human` taken off. The run that
  // label started skipped everything, its `ci (after approval)` became the
  // newest run of ci on the head, and GitHub held the pull request on a `ci`
  // it said was expected.
  const copies: [string, Event][] = [
    ['needs-human taken off a person’s pull request', { action: 'unlabeled', label: 'needs-human' }],
    ['needs-human put on', { action: 'labeled', label: 'needs-human' }],
    ['a title edited alone', { action: 'edited', changes: { title: { from: 'old' } } }],
    ['a label taken off a crew pull request that carries adlc:ci', { action: 'unlabeled', label: 'needs-human', crew: true, labels: ['adlc:ci'] }],
    ['a label taken off a crew pull request before adlc:ci', { action: 'unlabeled', label: 'needs-human', crew: true }],
  ];
  const runs: [string, Event][] = [
    ['adlc:ci put on a crew pull request', { action: 'labeled', label: 'adlc:ci', crew: true, labels: ['adlc:ci'] }],
    ['scope:cross-cutting put on', { action: 'labeled', label: 'scope:cross-cutting' }],
    ['a body edited', { action: 'edited', changes: { body: { from: 'old' } } }],
    ['a push to main', { event: 'push' }],
    ['a new head', { action: 'synchronize' }],
  ];

  it.each(copies)('copies the head’s earlier ci on %s, and runs none of the checks', (_what, event) => {
    expect(holds(jobs.earlier!.if, context(event))).toBe(true);
    expect(holds(jobs.changes!.if, context(event))).toBe(false);
    // `ci` is there, and named `ci`, only when there was something to copy.
    expect(holds(jobs.ci!.if, context(event, 'success'))).toBe(true);
    expect(evaluate(jobs.ci!.name!, context(event, 'success'))).toBe('ci');
    expect(evaluate(jobs.ci!.name!, context(event, 'failure'))).toBe('ci');
    for (const nothing of ['', null]) {
      expect(holds(jobs.ci!.if, context(event, nothing))).toBe(false);
      expect(evaluate(jobs.ci!.name!, context(event, nothing))).toBe('ci (after approval)');
    }
  });

  it.each(runs)('runs the checks, and copies nothing, on %s', (_what, event) => {
    expect(holds(jobs.earlier!.if, context(event))).toBe(false);
    expect(holds(jobs.changes!.if, context(event))).toBe(true);
    expect(holds(jobs.ci!.if, context(event))).toBe(true);
    expect(evaluate(jobs.ci!.name!, context(event))).toBe('ci');
  });

  it('leaves a draft alone, whose last job is ci (draft), and a retarget, whose earlier ci was against another base', () => {
    for (const event of [
      { action: 'labeled', label: 'needs-human', draft: true },
      { action: 'edited', changes: { title: { from: 'old' } }, draft: true },
      { action: 'edited', changes: { base: { ref: { from: 'other' } } } },
    ]) {
      expect(holds(jobs.earlier!.if, context(event))).toBe(false);
    }
    expect(evaluate(jobs.ci!.name!, context({ draft: true }))).toBe('ci (draft)');
  });

  it('still defers a crew pull request’s ci until adlc:ci, when there is nothing to copy', () => {
    const deferred = { action: 'synchronize', crew: true };
    expect(holds(jobs.earlier!.if, context(deferred))).toBe(false);
    expect(holds(jobs.ci!.if, context(deferred))).toBe(false);
    expect(evaluate(jobs.ci!.name!, context(deferred))).toBe('ci (after approval)');
  });

  it('reports nothing from a cancelled run, a copy included', () => {
    expect(holds(jobs.ci!.if, context({ action: 'labeled', label: 'needs-human' }, 'success'), { cancelled: true })).toBe(false);
  });

  it('reads the earlier result with this repository’s script, from a checkout of the scripts alone', () => {
    const steps = jobs.earlier!.steps;
    expect(steps[0]?.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
    expect(steps[0]?.with?.['sparse-checkout']).toBe('.github/scripts');
    expect(steps.at(-1)?.run?.trim()).toBe('node .github/scripts/release-check.mjs earlier');
    expect(readFileSync(join(ROOT, '.github', 'scripts', 'release-check.mjs'), 'utf8')).toContain("command === 'earlier'");
  });
});
