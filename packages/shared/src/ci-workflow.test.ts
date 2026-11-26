import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { coveredByLocalCi, jobOfRun, makeCallsIn, makeTargetsReached, noMakefileReach, parseCiWorkflow, type CiWorkflowJob } from './ci-workflow.js';

const OWN_CI = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const OWN_MAKEFILE = readFileSync(new URL('../../../Makefile', import.meta.url), 'utf8');
const TEMPLATE_MAKEFILE = readFileSync(new URL('../../../crew/templates/repo/Makefile', import.meta.url), 'utf8');

function jobsOf(text: string): CiWorkflowJob[] {
  const parsed = parseCiWorkflow(text);
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed.jobs;
}

describe('parseCiWorkflow', () => {
  it("reads this repository's own ci workflow in file order, the expression-named ci job by its key", () => {
    const jobs = jobsOf(OWN_CI);
    expect(jobs.map((job) => job.key)).toEqual(['earlier', 'changes', 'secrets', 'check', 'integration', 'docs', 'cloud-module', 'ci']);
    expect(jobs[0]).toMatchObject({ key: 'earlier', name: 'ci lookup', nameIsExpression: false });
    expect(jobs.at(-1)).toMatchObject({ key: 'ci', name: 'ci', nameIsExpression: true });
    expect(jobs.find((job) => job.key === 'check')!.runs.some((run) => run.includes('make ci'))).toBe(true);
  });

  it('keeps a reusable workflow call with no runs', () => {
    const jobs = jobsOf('jobs:\n  shared:\n    uses: org/repo/.github/workflows/x.yml@main\n');
    expect(jobs).toEqual([{ key: 'shared', name: 'shared', nameIsExpression: false, runs: [], usesWorkflow: 'org/repo/.github/workflows/x.yml@main' }]);
  });

  it('says a YAML error with its line, and a document with no jobs map', () => {
    const broken = parseCiWorkflow('name: ci\njobs:\n  a:\n    steps: [\n      - run: x\n');
    expect('error' in broken).toBe(true);
    if ('error' in broken) expect(broken.line).toBeGreaterThan(0);
    expect(parseCiWorkflow('name: ci\non: push\n')).toEqual({ error: 'the file has no jobs: map', line: null });
  });
});

describe('makeTargetsReached', () => {
  it("reaches only ci itself in this repository's Makefile", () => {
    const reach = makeTargetsReached(OWN_MAKEFILE);
    expect([...reach.targets]).toEqual(['ci']);
    expect(reach.first).toBe('setup');
  });

  it("reaches the template's prerequisites", () => {
    const reach = makeTargetsReached(TEMPLATE_MAKEFILE);
    expect(reach.targets.has('typecheck')).toBe(true);
    expect(reach.targets.has('test')).toBe(true);
    expect(reach.targets.has('migrate')).toBe(false);
  });

  it('follows $(MAKE), ${MAKE} and make calls in a recipe to the closure, and skips special targets and assignments', () => {
    const makefile = [
      '.PHONY: ci lint',
      'JOBS ?= 4',
      'X := a:b',
      'ci: build',
      '\t$(MAKE) lint',
      '\tcd sub && ${MAKE} -j4 fmt',
      '\tmake -C other deploy',
      'lint:',
      '\t@make vet',
      'vet:',
      '\techo vet',
      'fmt: ; gofmt',
      'build:',
      'deploy:',
    ].join('\n');
    const reach = makeTargetsReached(makefile);
    expect([...reach.targets].sort()).toEqual(['build', 'ci', 'fmt', 'lint', 'vet']);
  });
});

describe('makeCallsIn', () => {
  it('finds make as a command word only', () => {
    expect(makeCallsIn('pnpm install && make ci')).toEqual([['ci']]);
    expect(makeCallsIn('CI_JOBS=2 make -j4 typecheck test CI_WORKERS=1')).toEqual([['typecheck', 'test']]);
    expect(makeCallsIn("printf 'Run make ci before opening'")).toEqual([]);
    expect(makeCallsIn('make')).toEqual([[]]);
    expect(makeCallsIn('make -C docs html')).toEqual([]);
  });
});

describe('coveredByLocalCi', () => {
  const ownReach = makeTargetsReached(OWN_MAKEFILE);
  it("covers this repository's check job, which runs make ci, and nothing that never reaches it", () => {
    const jobs = jobsOf(OWN_CI);
    const covered = jobs.filter((job) => coveredByLocalCi(job, ownReach)).map((job) => job.key);
    expect(covered).toEqual(['check']);
  });

  it('covers a target ci reaches, and not one it does not', () => {
    const reach = makeTargetsReached(TEMPLATE_MAKEFILE);
    expect(coveredByLocalCi({ runs: ['make typecheck'] }, reach)).toBe(true);
    expect(coveredByLocalCi({ runs: ['make migrate'] }, reach)).toBe(false);
    expect(coveredByLocalCi({ runs: ['node tests/x.mjs', 'pnpm build'] }, reach)).toBe(false);
    expect(coveredByLocalCi({ runs: [] }, reach)).toBe(false);
  });

  it('counts a bare make as the first target, and with no Makefile only make ci', () => {
    expect(coveredByLocalCi({ runs: ['make'] }, makeTargetsReached('ci: test\ntest:\n'))).toBe(true);
    expect(coveredByLocalCi({ runs: ['make'] }, makeTargetsReached('setup:\nci:\n'))).toBe(false);
    expect(coveredByLocalCi({ runs: ['make ci'] }, noMakefileReach())).toBe(true);
    expect(coveredByLocalCi({ runs: ['make test'] }, noMakefileReach())).toBe(false);
  });
});

describe('jobOfRun', () => {
  const jobs = jobsOf(OWN_CI);
  it('maps a run job to its workflow row by name, a matrix suffix, or the key behind an expression', () => {
    expect(jobOfRun('ci lookup', jobs)?.key).toBe('earlier');
    expect(jobOfRun('ci', jobs)?.key).toBe('ci');
    expect(jobOfRun('ci (after approval)', jobs)?.key).toBe('ci');
    expect(jobOfRun('ci (draft)', jobs)?.key).toBe('ci');
    expect(jobOfRun('cloud module', jobs)?.key).toBe('cloud-module');
    expect(jobOfRun('somebody else', jobs)).toBeNull();
    const matrix = jobsOf('jobs:\n  test:\n    strategy: {matrix: {node: [20, 22]}}\n    steps: [{run: make ci}]\n');
    expect(jobOfRun('test (node 20)', matrix)?.key).toBe('test');
  });
});
