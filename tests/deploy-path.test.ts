import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isShellAllowed, loadToolsPolicy } from '@fleetadlc/engines';
import { parseYamlFile, policyPathMatches } from '@fleetadlc/shared';
import { describe, expect, it } from 'vitest';
import { SHIFT_STEP, SMOKE_STEP } from '../apps/bridge/src/deploy-pipeline.ts';

/**
 * The deploy path's workflows, checked against what the rest of the platform
 * assumes about them.
 *
 * None of this proves a deploy happened — there is no testing environment to
 * deploy to from a development machine, and a workflow that "ran" in a test is
 * a workflow nobody ran. What it does prove is the part that silently rots:
 * the bridge matches a workflow by name, the deploy skill tells the deploy
 * seat to dispatch workflows by name, and the workflows call `make` targets
 * that have to exist. Rename any one of those three and nothing fails until a
 * merge does.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const WORKFLOWS = join(ROOT, '.github', 'workflows');

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  id?: string;
  shell?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface Defaults {
  run?: { shell?: string };
}

interface Job {
  name?: string;
  if?: string;
  environment?: { name?: string; url?: string } | string;
  defaults?: Defaults;
  steps?: Step[];
}

interface Workflow {
  name?: string;
  'run-name'?: string;
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  defaults?: Defaults;
  jobs?: Record<string, Job>;
}

function workflow(file: string): Workflow {
  return parseYamlFile(join(WORKFLOWS, `${file}.yml`)) as Workflow;
}

function onlyJob(file: string): Job {
  const jobs = Object.values(workflow(file).jobs ?? {});
  expect(jobs).toHaveLength(1);
  return jobs[0] as Job;
}

const DEPLOY_PATH = ['deploy-testing', 'smoke-testing', 'promote-production', 'rollback-production'];

describe('the workflows the deploy path is made of', () => {
  it('parses, and each one is a single job named after its workflow', () => {
    // A check's published context is the job's name, and the bridge matches
    // `workflow_run.name`, which is the workflow's. Keeping the two identical
    // means the match holds whichever of them an event carries — and a single
    // job is what makes that possible at all.
    for (const file of DEPLOY_PATH) {
      const parsed = workflow(file);
      expect(parsed.name, file).toBe(file);
      expect(Object.keys(parsed.jobs ?? {}), file).toEqual([file]);
      expect(onlyJob(file).name, file).toBe(file);
    }
  });

  it('holds no write access beyond the deployment the environment creates', () => {
    // Everything the platform does to GitHub is done by a bot's own account
    // through the bridge. A workflow that could label or comment would be a
    // second, unattributable actor — and one whose actions fire no events.
    // The promote also reads the smoke's runs, for its testing check.
    for (const file of DEPLOY_PATH) {
      const permissions = workflow(file).permissions ?? {};
      expect(Object.keys(permissions).sort(), file).toEqual(
        file.startsWith('rollback') || file.startsWith('smoke')
          ? ['contents']
          : file === 'promote-production'
            ? ['actions', 'contents', 'deployments']
            : ['contents', 'deployments'],
      );
      expect(permissions.contents, file).toBe('read');
      if (file === 'promote-production') expect(permissions.actions).toBe('read');
    }
  });
});

describe('a merge reaches testing once, by the bridge’s dispatch', () => {
  it('is started by OpenADLC with the merged commit, and not by a push as well', () => {
    // It ran on every push to main, and the bridge dispatched it on every
    // merge too: each merge deployed and smoked twice.
    const on = workflow('deploy-testing').on as { push?: unknown; workflow_dispatch?: { inputs?: { sha?: { required?: boolean } } } };
    expect(Object.keys(on)).toEqual(['workflow_dispatch']);
    expect(on.workflow_dispatch?.inputs?.sha?.required).toBe(true);
  });

  it('carries the testing environment, so a deployment exists to act on', () => {
    const environment = onlyJob('deploy-testing').environment as { name?: string; url?: string };
    expect(environment.name).toBe('testing');
    // The URL is what arrives as `deployment_status.environment_url` and ends up
    // on the pull request. Without it a builder is told to verify against
    // nothing.
    expect(environment.url).toContain('revision-url');
  });

  it('does not deploy when there is no target, rather than deploying nothing', () => {
    // A green deploy of nothing would put `deployed:testing` on a pull request
    // that is live nowhere, and `dependencyIsSatisfied` reads that label to
    // release other work. Skipped is not failed, so it starts no revert either.
    expect(onlyJob('deploy-testing').if).toContain('FLEETADLC_DEPLOY_TESTING');
  });

  it('refuses a commit that is not on the default branch', () => {
    // The one thing the deploy role may never do, as a check rather than a rule.
    const run = (onlyJob('deploy-testing').steps ?? []).map((step) => step.run ?? '').join('\n');
    expect(run).toContain('merge-base --is-ancestor');
  });
});

describe('what a step did not write itself', () => {
  it.each(DEPLOY_PATH)('%s reaches the script through the environment, not pasted into it', (file) => {
    // A dispatch input is free text and a deploy's output is whatever `make`
    // printed last; `${{ }}` in a script is substituted before bash reads it,
    // so a backtick in either runs as a command.
    for (const step of onlyJob(file).steps ?? []) {
      expect(step.run ?? '', step.name).not.toMatch(/\$\{\{\s*(inputs|steps)\./);
    }
  });
});

describe('a step that pipes make into tee', () => {
  it.each(DEPLOY_PATH)('%s fails when make does, not when tee does', (file) => {
    // GitHub runs a step with no `shell:` as `bash -e`, without pipefail, so
    // the step's status is tee's: a failed smoke read green and was promoted,
    // and a failed rollback read as done. `shell: bash` adds pipefail.
    const job = onlyJob(file);
    for (const step of job.steps ?? []) {
      if (!/make [^|\n]*\|\s*tee/.test(step.run ?? '')) continue;
      const shell = step.shell ?? job.defaults?.run?.shell ?? workflow(file).defaults?.run?.shell;
      const pipefail = /^\s*set -[a-z]*o pipefail\b/m.test(step.run ?? '') || shell === 'bash';
      expect(pipefail, step.name).toBe(true);
    }
  });
});

describe('the smoke is a separate run against what was deployed', () => {
  it('follows the deploy rather than being part of it', () => {
    const on = workflow('smoke-testing').on as { workflow_run?: { workflows?: string[]; types?: string[] } };
    expect(on.workflow_run?.workflows).toEqual(['deploy-testing']);
    expect(on.workflow_run?.types).toEqual(['completed']);
  });

  it('only smokes a deploy that succeeded', () => {
    // A deploy skipped for want of a target deployed nothing, and a deploy that
    // failed never reached testing (it becomes an issue, not a revert). Smoking
    // either would report a failure about the previous revision.
    expect(onlyJob('smoke-testing').if).toContain("workflow_run.conclusion == 'success'");
  });

  it('checks out the commit that was deployed, not the branch head', () => {
    // A `workflow_run` workflow always runs the default branch's copy of
    // itself, so without this it would smoke whatever landed since. And the
    // deploy's own run is at the tip it was dispatched at, another merge's
    // once two land close together: the commit it deployed is in its name.
    const steps = onlyJob('smoke-testing').steps ?? [];
    const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout'));
    expect(checkout?.with?.ref).toBe('${{ steps.deployed.outputs.sha }}');
    const deployed = steps.find((step) => step.id === 'deployed')?.run ?? '';
    const A = '0123456789abcdef0123456789abcdef01234567';
    const B = 'fedcba9876543210fedcba9876543210fedcba98';
    const smoked = (title: string): string => {
      const dir = mkdtempSync(join(tmpdir(), 'fleetadlc-smoke-'));
      try {
        const output = join(dir, 'output');
        writeFileSync(output, '');
        spawnSync('bash', ['-e', '-c', deployed], { env: { PATH: process.env.PATH, TITLE: title, AT: B, GITHUB_OUTPUT: output } });
        return readFileSync(output, 'utf8').trim();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    expect(smoked(`deploy-testing ${A}`)).toBe(`sha=${A}`);
    for (const title of ['deploy-testing', '', `deploy-testing ${A}; true`]) expect(smoked(title), title).toBe(`sha=${B}`);
  });

  it('names its run for the deploy run, which names the commit, so the bridge reads what was smoked', () => {
    expect(workflow('deploy-testing')['run-name']).toBe('deploy-testing ${{ inputs.sha || github.sha }}');
    expect(workflow('smoke-testing')['run-name']).toBe(
      "${{ github.event.workflow_run && format('smoke-testing of {0}', github.event.workflow_run.display_title) || 'smoke-testing' }}",
    );
    // Refused before checkout: the name has to carry a commit id.
    const steps = onlyJob('deploy-testing').steps ?? [];
    const check = steps.findIndex((step) => step.name === 'the commit is a commit id');
    expect(check).toBeGreaterThanOrEqual(0);
    expect(check).toBeLessThan(steps.findIndex((step) => step.uses?.startsWith('actions/checkout')));
  });

  it('smokes only main’s own deploy-testing, not one a fork or another branch named so', () => {
    // `workflow_run` matches by name: a fork's pull request could add a
    // workflow called deploy-testing, and this job ran that commit's Makefile
    // with main's cache and token, its result read as main's smoke. The
    // repository check is the one that holds, since a fork can call its branch
    // `main`.
    const on = workflow('smoke-testing').on as { workflow_run?: { branches?: string[] } };
    expect(on.workflow_run?.branches).toEqual(['main']);
    const guard = onlyJob('smoke-testing').if ?? '';
    expect(guard).toContain("vars.FLEETADLC_DEPLOY_TESTING == 'true'");
    expect(guard).toContain("github.event_name == 'workflow_dispatch'");
    expect(guard).toContain("github.event.workflow_run.event == 'push'");
    expect(guard).toContain("github.event.workflow_run.event == 'workflow_dispatch'");
    expect(guard).toContain('github.event.workflow_run.head_repository.full_name == github.repository');
    expect(guard).toContain('github.event.workflow_run.head_branch == github.event.repository.default_branch');
  });

  it('keeps no token in the checkout and writes nothing to main’s pnpm cache', () => {
    // The deploy and the promote restore that cache; a smoke runs a commit's
    // own install, which should not be able to leave anything in it.
    const steps = onlyJob('smoke-testing').steps as Array<Step & { with?: Record<string, unknown> }>;
    const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout'));
    expect(checkout?.with?.['persist-credentials']).toBe(false);
    for (const step of steps) expect(step.with?.cache, step.uses).toBeUndefined();
  });
});

describe('production is one approval over the whole promote', () => {
  it('names the production environment on the job a person approves', () => {
    const environment = onlyJob('promote-production').environment as { name?: string };
    expect(environment.name).toBe('production');
  });

  it('is started by hand against a named candidate, never by a push', () => {
    const on = workflow('promote-production').on as Record<string, unknown>;
    expect(Object.keys(on)).toEqual(['workflow_dispatch']);
    expect(JSON.stringify(on)).toContain('candidate');
  });

  it('puts build, migrate, deploy, smoke and the traffic shift in that one job', () => {
    // An environment approval is granted to a job, so five jobs would be five
    // approvals — and a person asked to approve the same change five times
    // stops reading. The order matters as much as the count: traffic moves last,
    // so everything before it is undone by doing nothing.
    const steps = (onlyJob('promote-production').steps ?? [])
      .map((step) => step.run ?? '')
      .filter((run) => run.includes('make '));

    // Deduplicated: a step's own comment may name the target it is about to
    // run, and what is being checked here is the order of the phases.
    const targets = steps.flatMap((run) => [...run.matchAll(/make ([a-z-]+)/g)].map((match) => match[1] as string));
    expect([...new Set(targets)]).toEqual([
      'build',
      'migrate',
      'deploy-production',
      'smoke-production',
      'shift-traffic',
    ]);
  });

  it('refuses a candidate that is not a full commit id, before checking it out', () => {
    // checkout takes only a full id as a commit and looks a short one up as a
    // branch, which failed after the approval and read as a failed promote.
    const steps = onlyJob('promote-production').steps ?? [];
    const check = steps.findIndex((step) => step.name === 'the candidate is a commit id');
    expect(check).toBeGreaterThanOrEqual(0);
    expect(check).toBeLessThan(steps.findIndex((step) => step.uses?.startsWith('actions/checkout')));
    const accepts = (candidate: string) =>
      spawnSync('bash', ['-e', '-c', steps[check]?.run ?? ''], { env: { PATH: process.env.PATH, CANDIDATE: candidate } }).status === 0;
    expect(accepts('0123456789abcdef0123456789abcdef01234567')).toBe(true);
    expect(accepts('0123456')).toBe(false);
    expect(accepts('main')).toBe(false);
    expect(steps[check]?.run).toContain('40-character');
  });

  it('names its smoke and its traffic shift as the bridge finds them in a failed run', () => {
    // A failed promote is rolled back only when its traffic shift failed, and
    // sent back to build when its smoke did; the bridge tells them apart by
    // the steps' names. Renamed, every failure would go to a person instead.
    const steps = onlyJob('promote-production').steps ?? [];
    const shift = steps.find((step) => step.run?.includes('make shift-traffic'));
    const smoke = steps.find((step) => step.run?.includes('make smoke-production'));
    expect(shift?.name).toMatch(SHIFT_STEP);
    expect(smoke?.name).toMatch(SMOKE_STEP);
    expect(shift?.name).not.toMatch(SMOKE_STEP);
  });

  it('smokes the new revision by its tag rather than whatever is serving', () => {
    const smoke = (onlyJob('promote-production').steps ?? []).find((step) => step.run?.includes('smoke-production'));
    expect(JSON.stringify(smoke)).toContain('FLEETADLC_REVISION_TAG');
  });
});

/**
 * The promote's testing check, run with bash against a fake `gh` that answers
 * from fixtures through the real `jq`, as `gh api --jq` would. The bridge
 * dispatches only a smoked commit; this is what holds a promote anyone else
 * dispatched — a person, or a crew token, which holds `actions: write`.
 */
describe('a promote of a commit that was not proven on testing', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567';
  const CHECK = 'the candidate is live and smoked on testing';
  const FILES = {
    'this repository': join(WORKFLOWS, 'promote-production.yml'),
    'the template': join(ROOT, 'crew', 'templates', 'repo', '.github', 'workflows', 'promote-production.yml'),
  };
  const RUN = 'https://github.com/exampleco/app/actions/runs/9';
  const smokeRun = (conclusion: string, extra: Record<string, unknown> = {}) => ({
    conclusion,
    display_title: `smoke-testing of deploy-testing ${SHA}`,
    event: 'workflow_run',
    head_branch: 'main',
    ...extra,
  });
  const GREEN = {
    deployments: [{ id: 41, sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', environment: 'testing' }],
    statuses: [{ state: 'success', log_url: RUN }],
    deployRuns: {
      workflow_runs: [
        {
          id: 9,
          conclusion: 'success',
          display_title: `deploy-testing ${SHA}`,
          head_branch: 'main',
          event: 'workflow_dispatch',
          head_repository: { full_name: 'exampleco/app' },
        },
      ],
    },
    runs: { workflow_runs: [smokeRun('success')] },
  };

  /** A fake `gh`: logs each call, and answers `gh api <path> --jq <filter>` from the fixture its path names. */
  const FAKE_GH = `#!/bin/bash
set -euo pipefail
[ "$1" = api ] || { echo "fake gh: only api, not $1" >&2; exit 2; }
path="$2"; shift 2
filter=.
while [ $# -gt 0 ]; do
  case "$1" in --jq) filter="$2"; shift 2 ;; *) shift ;; esac
done
echo "$path" >> "$FAKE/calls"
case "$path" in
  */deployments/*/statuses*) fixture=statuses ;;
  */deployments\?*) fixture=deployments ;;
  */actions/workflows/deploy-testing.yml/runs\?*) fixture=deploy-runs ;;
  */actions/workflows/*/runs\?*) fixture=runs ;;
  */collaborators/*/permission) fixture=permission ;;
  *) echo "fake gh: nothing for $path" >&2; exit 2 ;;
esac
jq -r "$filter" "$FAKE/$fixture.json"
`;

  function steps(file: string): Step[] {
    const parsed = parseYamlFile(file) as Workflow;
    return Object.values(parsed.jobs ?? {})[0]?.steps ?? [];
  }

  function promote(
    file: string,
    fixtures: { deployments?: unknown; statuses?: unknown; runs?: unknown; deployRuns?: unknown; role?: string },
    dispatch: { actor?: string; reason?: string } = {},
  ): { ok: boolean; out: string; summary: string; calls: string[] } {
    const step = steps(file).find((candidate) => candidate.name === CHECK);
    const dir = mkdtempSync(join(tmpdir(), 'fleetadlc-promote-'));
    try {
      mkdirSync(join(dir, 'bin'));
      writeFileSync(join(dir, 'bin', 'gh'), FAKE_GH);
      // The checkout is the candidate's: HEAD is the commit, in full.
      writeFileSync(join(dir, 'bin', 'git'), `#!/bin/bash
[ "$*" = "rev-parse HEAD" ] && echo ${SHA} && exit 0
exit 2
`);
      chmodSync(join(dir, 'bin', 'gh'), 0o755);
      chmodSync(join(dir, 'bin', 'git'), 0o755);
      writeFileSync(join(dir, 'deployments.json'), JSON.stringify(fixtures.deployments ?? []));
      writeFileSync(join(dir, 'statuses.json'), JSON.stringify(fixtures.statuses ?? []));
      writeFileSync(join(dir, 'runs.json'), JSON.stringify(fixtures.runs ?? { workflow_runs: [] }));
      writeFileSync(join(dir, 'deploy-runs.json'), JSON.stringify(fixtures.deployRuns ?? { workflow_runs: [] }));
      writeFileSync(join(dir, 'permission.json'), JSON.stringify({ role_name: fixtures.role ?? 'read' }));
      writeFileSync(join(dir, 'summary.md'), '');
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', step?.run ?? 'exit 3'], {
        encoding: 'utf8',
        env: {
          PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
          FAKE: dir,
          GITHUB_REPOSITORY: 'exampleco/app',
          GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
          GH_TOKEN: 'token',
          ACTOR: dispatch.actor ?? 'ada',
          REASON: dispatch.reason ?? '',
          SMOKE_WORKFLOW: step?.env?.SMOKE_WORKFLOW ?? '',
          DEFAULT_BRANCH: 'main',
        },
      });
      const calls = existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n') : [];
      return { ok: result.status === 0, out: `${result.stdout}${result.stderr}`, summary: readFileSync(join(dir, 'summary.md'), 'utf8'), calls };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  describe.each(Object.entries(FILES))('in %s', (_where, file) => {
    it('checks before anything is built, migrated or deployed, after the candidate is known to be on the default branch', () => {
      const all = steps(file);
      const check = all.findIndex((step) => step.name === CHECK);
      expect(check).toBeGreaterThan(all.findIndex((step) => step.name === 'the candidate is on the default branch'));
      const firstWork = all.findIndex((step) => /\bmake |pnpm install/.test(step.run ?? '') || step.uses?.startsWith('pnpm/'));
      expect(firstWork).toBeGreaterThan(check);
    });

    it('promotes a commit with a green testing deployment and a green smoke', () => {
      const result = promote(file, GREEN);
      expect(result.out).toContain('is live on testing');
      expect(result.ok).toBe(true);
      // Asked about this exact commit, on testing, by the smoke the rules name.
      expect(result.calls).toContain(
        'repos/exampleco/app/actions/workflows/deploy-testing.yml/runs?event=workflow_dispatch&status=success&per_page=100',
      );
      expect(result.calls).toContain('repos/exampleco/app/deployments?environment=testing&per_page=20');
      expect(result.calls).toContain('repos/exampleco/app/deployments/41/statuses?per_page=20');
      expect(result.calls).toContain(
        'repos/exampleco/app/actions/workflows/smoke-testing.yml/runs?event=workflow_run&status=completed&per_page=100',
      );
      expect(result.calls.some((call) => call.includes('head_sha=') || call.includes('deployments?environment=testing&sha='))).toBe(false);
    });

    it('accepts a deployment recorded at the branch tip once a newer one has marked it inactive', () => {
      const result = promote(file, {
        ...GREEN,
        statuses: [
          { state: 'inactive', log_url: RUN },
          { state: 'success', log_url: RUN },
        ],
      });
      expect(result.ok).toBe(true);
      // Proven, but no longer serving: the step does not say it is live.
      expect(result.out).toContain('a newer deploy has since replaced it there');
      expect(result.out).not.toContain('is live on testing');
    });

    it('refuses a candidate with no successful deploy-testing run', () => {
      const result = promote(file, { ...GREEN, deployRuns: { workflow_runs: [] } });
      expect(result.ok).toBe(false);
      expect(result.out).toContain(`${SHA} has no successful deploy-testing run on main titled "deploy-testing ${SHA}"`);
    });

    it('refuses a deploy run titled for another commit, or dispatched on another branch', () => {
      // Its deployment and smoke are green: only the deploy run says whose they are.
      const [run] = GREEN.deployRuns.workflow_runs;
      const other = promote(file, { ...GREEN, deployRuns: { workflow_runs: [{ ...run, display_title: `deploy-testing ${'f'.repeat(40)}` }] } });
      expect(other.ok).toBe(false);
      expect(other.out).toContain('has no successful deploy-testing run');
      const branch = promote(file, { ...GREEN, deployRuns: { workflow_runs: [{ ...run, head_branch: 'feature' }] } });
      expect(branch.ok).toBe(false);
      expect(branch.out).toContain('has no successful deploy-testing run');
    });

    it('refuses a testing deployment whose log_url names another run', () => {
      // Run 90's deployment is not run 9's, though one id begins the other.
      const result = promote(file, { ...GREEN, statuses: [{ state: 'success', log_url: `${RUN}0` }] });
      expect(result.ok).toBe(false);
      expect(result.out).toContain('deploy-testing run 9 has no testing deployment');
      expect(promote(file, { ...GREEN, statuses: [{ state: 'success', log_url: `${RUN}/job/3` }] }).ok).toBe(true);
    });

    it('refuses a smoke dispatched by hand, even one whose commit is the candidate', () => {
      const result = promote(file, {
        ...GREEN,
        runs: {
          workflow_runs: [smokeRun('success', { display_title: 'smoke-testing', event: 'workflow_dispatch', head_sha: SHA })],
        },
      });
      expect(result.ok).toBe(false);
      expect(result.out).toContain('its latest is none');
    });

    it('refuses a candidate whose latest smoke failed', () => {
      // Its revert still in review: the green smoke before it is not the word.
      const result = promote(file, { ...GREEN, runs: { workflow_runs: [smokeRun('failure'), smokeRun('success')] } });
      expect(result.ok).toBe(false);
      expect(result.out).toContain(`${SHA} has no green smoke-testing run titled "smoke-testing of deploy-testing ${SHA}" (its latest is failure)`);
    });

    it('refuses a candidate that was never smoked, and reads past a smoke that did not run', () => {
      expect(promote(file, { ...GREEN, runs: { workflow_runs: [] } }).ok).toBe(false);
      expect(promote(file, { ...GREEN, runs: { workflow_runs: [smokeRun('skipped')] } }).ok).toBe(false);
      expect(promote(file, { ...GREEN, runs: { workflow_runs: [smokeRun('cancelled'), smokeRun('success')] } }).ok).toBe(true);
    });

    it('refuses a candidate with no testing deployment from its deploy run', () => {
      const result = promote(file, { ...GREEN, deployments: [] });
      expect(result.ok).toBe(false);
      expect(result.out).toContain(`deploy-testing run 9 has no testing deployment`);
    });

    it('refuses a testing deployment whose latest status is not success', () => {
      const failed = promote(file, {
        ...GREEN,
        statuses: [
          { state: 'failure', log_url: RUN },
          { state: 'success', log_url: RUN },
        ],
      });
      expect(failed.ok).toBe(false);
      expect(failed.out).toContain('testing deployment is failure, not success');
      expect(promote(file, { ...GREEN, statuses: [{ state: 'in_progress', log_url: RUN }] }).ok).toBe(false);
      expect(promote(file, { ...GREEN, statuses: [] }).ok).toBe(false);
    });

    it('refuses the override from a bot', () => {
      // The app dispatches as `<name>[bot]`; it is refused before GitHub is asked.
      const result = promote(file, { role: 'admin' }, { actor: 'fleetadlc-exampleco[bot]', reason: 'urgent' });
      expect(result.ok).toBe(false);
      expect(result.out).toContain('is a bot');
      expect(result.calls).toEqual([]);
    });

    it('refuses the override from an account that can only write, as a crew seat can', () => {
      const result = promote(file, { role: 'write' }, { actor: 'exampleco-builder', reason: 'urgent' });
      expect(result.ok).toBe(false);
      expect(result.out).toContain('emergency_override takes admin or maintain');
      expect(result.calls).toEqual(['repos/exampleco/app/collaborators/exampleco-builder/permission']);
    });

    it('lets an admin past the testing check with a reason, and records who and why', () => {
      const reason = 'testing is down; this reverts the outage `$(whoami)`';
      const result = promote(file, { role: 'admin' }, { actor: 'ada', reason });
      expect(result.ok).toBe(true);
      expect(result.summary).toContain('emergency override');
      expect(result.summary).toContain(SHA);
      expect(result.summary).toContain('by ada (admin)');
      // The reason as written: it reaches the script as data, never as code.
      expect(result.summary).toContain(`reason: ${reason}`);
      expect(result.calls).toEqual(['repos/exampleco/app/collaborators/ada/permission']);
      expect(promote(file, { role: 'maintain' }, { actor: 'ada', reason }).ok).toBe(true);
    });

    it('takes the override only through the environment, never pasted into the script', () => {
      const step = steps(file).find((candidate) => candidate.name === CHECK);
      expect(step?.run).not.toMatch(/\$\{\{[^}]*inputs\.emergency_override/);
      expect(step?.env?.REASON).toBe('${{ inputs.emergency_override }}');
      expect(step?.env?.ACTOR).toBe('${{ github.triggering_actor }}');
    });

    it('names an override run as one, which is how the bridge knows to record it', () => {
      const text = readFileSync(file, 'utf8');
      expect(text).toMatch(/^run-name: promote-production \$\{\{ inputs\.candidate \}\}\$\{\{ inputs\.emergency_override != '' && ' \(emergency override\)' \|\| '' \}\}$/m);
      const input = ((parseYamlFile(file) as Workflow).on?.workflow_dispatch as { inputs?: Record<string, { type?: string; default?: string; required?: boolean }> })
        ?.inputs?.emergency_override;
      expect(input).toMatchObject({ type: 'string', default: '', required: false });
    });
  });
});

describe('a rollback does not wait for anyone', () => {
  it('runs in an environment of its own, apart from the promote’s', () => {
    // An environment is not an approval: `production-rollback` has no
    // reviewer and no wait timer. It is there for its branch policy and its
    // secrets, so the traffic-shift credential is not a repository secret
    // any branch's workflow can read.
    const environmentName = (job: Job) => (typeof job.environment === 'string' ? job.environment : job.environment?.name);
    expect(environmentName(onlyJob('rollback-production'))).toBe('production-rollback');
    expect(environmentName(onlyJob('promote-production'))).toBe('production');
  });

  it('runs only from the default branch, and only to a revision tag', () => {
    const job = onlyJob('rollback-production');
    expect(job.if).toBe("github.ref == format('refs/heads/{0}', github.event.repository.default_branch)");
    const steps = job.steps ?? [];
    const check = steps.findIndex((step) => step.run?.includes('[A-Za-z0-9._-]'));
    const rollback = steps.findIndex((step) => step.run?.includes('make rollback-production'));
    expect(check).toBeGreaterThanOrEqual(0);
    expect(check).toBeLessThan(rollback);
  });

  it('pastes no input into a script', () => {
    // `to` is free text; an expression in `run:` is pasted in before bash reads it.
    for (const step of onlyJob('rollback-production').steps ?? []) expect(step.run ?? '', step.name).not.toMatch(/\$\{\{\s*inputs\./);
  });

  it('cannot run while a promote is shifting traffic', () => {
    // Traffic has one shape at a time, and two workflows deciding it at once is
    // the worst minute of an incident. Sharing the group is safe because the
    // bridge cancels the promotes GitHub has not started before it dispatches
    // a rollback, and dispatches no promote until the rollback has succeeded
    // (`DeployPipeline.dispatchRollback`, `promote`): a pending rollback is
    // never left behind a promote's approval, nor cancelled by a new promote.
    expect(workflow('rollback-production').concurrency?.group).toBe(
      workflow('promote-production').concurrency?.group,
    );
  });

  it('moves traffic and nothing else', () => {
    // Migrations are forward-only, so a rollback is a traffic decision. A
    // rollback that migrated would be undoing something it cannot undo.
    const run = (onlyJob('rollback-production').steps ?? []).map((step) => step.run ?? '').join('\n');
    expect(run).toContain('make rollback-production');
    expect(run).not.toContain('make migrate');
  });
});

describe('the workflows and the repository agree on what to call', () => {
  it('every make target a workflow runs is one the Makefile declares', () => {
    // The deploy path is a contract between the platform and the repository it
    // works in, in exactly the way `make ci` already is. A workflow calling a
    // target nobody wrote fails at the worst moment: after a merge.
    const makefile = readFileSync(join(ROOT, 'Makefile'), 'utf8');
    const declared = new Set(
      makefile
        .split('\n')
        .map((line) => /^([a-z][a-z-]*):/.exec(line)?.[1])
        .filter((name): name is string => Boolean(name)),
    );

    const called = new Set<string>();
    for (const file of DEPLOY_PATH) {
      for (const job of Object.values(workflow(file).jobs ?? {})) {
        for (const step of job.steps ?? []) {
          for (const match of (step.run ?? '').matchAll(/make ([a-z-]+)/g)) called.add(match[1] as string);
        }
      }
    }

    expect(called.size).toBeGreaterThan(0);
    expect([...called].filter((target) => !declared.has(target))).toEqual([]);
  });

  it('the deploy skill dispatches the workflows that exist', () => {
    // The deploy seat's skill named workflows that did not exist, before the deploy path was built.
    // Naming one that stops existing is the same failure the other way round.
    const skill = readFileSync(join(ROOT, 'crew', 'skills', 'deploy', 'SKILL.md'), 'utf8');
    for (const file of DEPLOY_PATH) {
      expect(skill, file).toContain(file);
    }
  });
});

/**
 * The revert, from the pull request's side. The bridge's `workflow_run` handler
 * opens the revert task on the deploy bot, on a `system/revert-<sha>` branch
 * (`tests/pipeline.mjs` drives that through a delivery), and hostd gives the
 * session that bot's own token (`apps/hostd/src/task-runner.test.ts`), so what
 * the session opens is authored by the deploy seat. What is left is whether the
 * pull request is one the fast path recognises and lands: that hangs on the
 * skill naming the `revert` label, which puts it at the front of the merge
 * line, leaving auto-merge off, and on its tools letting it push that branch
 * and open the pull request.
 */
describe('a red smoke comes back out as the deploy bot’s revert pull request', () => {
  const skill = readFileSync(join(ROOT, 'crew', 'skills', 'deploy', 'SKILL.md'), 'utf8');
  const policy = loadToolsPolicy(join(ROOT, 'crew', 'skills', 'deploy', 'tools.yaml'));

  it('opens it from the revert branch with the `revert` label, and leaves landing it to the merge line', () => {
    // The label is the whole difference between the fast path and waiting in
    // line behind every other change while testing stays broken. The merge
    // line lands it once the lead approved and CI passed; auto-merge would
    // race CI, which runs only after the approval.
    // The task starts on its `system/revert-<sha8>` branch, so the pull request
    // is opened from the branch it is on.
    expect(skill).toContain('git push origin HEAD');
    expect(skill).toMatch(/gh pr create --label revert\b/);
    expect(skill).not.toContain('--auto');
    const labels = JSON.parse(readFileSync(join(ROOT, 'config', 'labels.json'), 'utf8')) as { name: string }[];
    expect(labels.map((label) => label.name)).toContain('revert');
  });

  // The declared policy only. `isShellAllowed` reads the first word. `pr merge`
  // is in `deny.github`, which OpenADLC's gh enforces, and `mergeRefusal` refuses
  // every merge besides (gh-shim.test.ts).
  it('declares the revert branch pushable, git and gh runnable, and `gh pr merge` denied', () => {
    const prefix = policy.allow.git?.pushBranchPrefix;
    expect(prefix && 'system/revert-a1b2c3d4'.startsWith(prefix)).toBe(true);
    expect(policy.allow.git?.forcePush).toBe(false);
    expect(isShellAllowed(policy, 'git push origin system/revert-a1b2c3d4')).toBe(true);
    expect(isShellAllowed(policy, 'gh pr create --head system/revert-a1b2c3d4 --label revert')).toBe(true);
    expect(policy.deny.github).toContain('pr merge');
  });

  // A promote is OpenADLC's to dispatch: on a plan where GitHub holds no
  // production reviewer, one a session started ran with nobody approving.
  it('denies starting a promote, by either name, and still allows the rollback', () => {
    expect(policy.deny.github).toEqual(expect.arrayContaining(['workflow run promote-production', 'workflow run promote-production.yml']));
    // The shim denies an entry whose words the command's leading words are.
    const denies = (command: string) => policy.deny.github.some((entry) => entry.split(' ').every((word, i) => command.split(' ')[i] === word));
    expect(denies('workflow run promote-production --ref main -f candidate=abc1234')).toBe(true);
    expect(denies('workflow run promote-production.yml --ref main')).toBe(true);
    expect(denies('workflow run rollback-production --ref main')).toBe(false);
  });
});

/**
 * A failed testing deploy, from the SRE's side. The bridge files an issue and
 * starts the deploy bot on it (`reportDeployFailure`); the skill is what tells
 * it the three things that can have broken it, and its tools are what let it
 * fix the one that is a file in the repository.
 */
describe('a failed testing deploy is the SRE’s to diagnose, and a broken deploy workflow its to fix', () => {
  const skill = readFileSync(join(ROOT, 'crew', 'skills', 'deploy', 'SKILL.md'), 'utf8');
  const policy = loadToolsPolicy(join(ROOT, 'crew', 'skills', 'deploy', 'tools.yaml'));
  const section = (heading: string) => skill.split(/^## /m).find((part) => part.startsWith(`${heading}\n`)) ?? '';

  it('has one rule for it, and the smoke’s section points there', () => {
    // The smoke's section said "fix the deploy path" while the one written for
    // a failed deploy said it was a person's: an SRE could follow either.
    expect(skill).not.toContain('fix the deploy path');
    expect(section('When the smoke fails on testing')).toContain('"When a deploy failed"');
    expect(skill).toContain('do not revert a commit that never');
    const failed = section('When a deploy failed');
    expect(failed).toContain('**The change broke it**');
    expect(failed).toContain('"event":"send_back","to":"build"');
    expect(failed).toContain('**A deploy workflow file broke it**');
    expect(failed).toContain('**What no file fixes broke it**');
  });

  it('fixes a deploy workflow by a ready pull request with a recorded local CI pass, closing the bridge’s issue', () => {
    const failed = section('When a deploy failed');
    const steps = ['git commit -am', 'fleetadlc-ci', 'git push origin system/deploy-path-<sha>', 'gh pr create'];
    for (const step of steps) expect(failed, step).toContain(step);
    const at = steps.map((step) => failed.indexOf(step));
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(failed).toContain("Closes #<the bridge's issue>");
    expect(failed).not.toContain('--draft');
    expect(failed).toContain('security reviewer');
  });

  it('may write the deploy workflows and no other, run fleetadlc-ci, and push its system/ branch', () => {
    const scope = policy.allow.files?.writeWithin ?? [];
    const writable = (path: string) => scope.some((pattern) => policyPathMatches(path, pattern));
    expect(writable('.github/workflows/deploy-testing.yml')).toBe(true);
    expect(writable('.github/workflows/ci.yml')).toBe(false);
    expect(writable('.github/workflows/promote-production.yml')).toBe(false);
    expect(writable('.github/workflows/rollback-production.yml')).toBe(false);
    expect(isShellAllowed(policy, 'fleetadlc-ci')).toBe(true);
    expect('system/deploy-path-a1b2c3d4'.startsWith(policy.allow.git?.pushBranchPrefix ?? '-')).toBe(true);
    // A revert is pushed from a branch hostd's local CI does not run on.
    expect(policy.allow.git?.localCi).toBeFalsy();
  });
});
