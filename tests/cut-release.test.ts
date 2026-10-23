import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYamlFile } from '@openadlc/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error — a plain script with no types; cut-release.yml runs it directly.
import { checkCut, releasersIn } from '../.github/scripts/cut-release-check.mjs';
// @ts-expect-error — a plain script with no types; release-build.yml and ci.yml run it directly.
import { releasersOf } from '../.github/scripts/release-check.mjs';

/**
 * The release button, .github/workflows/cut-release.yml: who may press it,
 * what it checks before it asks for the `release` environment's approval,
 * and the one step that holds the releaser's token.
 *
 * Its token pushes a version tag as the releaser, and release-build.yml takes
 * any tag of his on a commit of main whose ci passed. So the token is read in
 * one step of the one job in that environment, which GitHub releases only to
 * a run on main and only once a releaser approves; the checks before it are
 * release-build's own, run against a real repository and a stand-in for
 * GitHub's API, as tests/release-check.test.ts runs them; and the step is run
 * as GitHub runs it, with stand-ins for gh and git, to see the token goes
 * nowhere but into git's environment.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const REPO = 'acme/openadlc';
const REPO_ID = '42';
const RELEASE_BUILD = readFileSync(join(WORKFLOWS, 'release-build.yml'), 'utf8');
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}

interface Job {
  name?: string;
  needs?: string | string[];
  environment?: string | { name?: string };
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  secrets?: unknown;
  steps?: Step[];
}

interface Workflow {
  on: Record<string, { inputs?: Record<string, Record<string, unknown>> } | null>;
  permissions?: unknown;
  concurrency?: unknown;
  env?: Record<string, string>;
  jobs: Record<string, Job>;
}

const workflow = parseYamlFile(join(WORKFLOWS, 'cut-release.yml')) as Workflow;
const text = readFileSync(join(WORKFLOWS, 'cut-release.yml'), 'utf8');
const tagJob = workflow.jobs.tag!;
const tagStep = (name: string) => {
  const found = (tagJob.steps ?? []).find((one) => one.name === name);
  if (!found?.run) throw new Error(`tag has no step ${name}`);
  return found;
};
const PUSH = 'push the tag as the releaser';

describe('cut-release.yml', () => {
  it('is started only by hand, with a version or none', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    const inputs = workflow.on.workflow_dispatch?.inputs ?? {};
    expect(Object.keys(inputs)).toEqual(['version']);
    expect(inputs.version).toMatchObject({ required: false, type: 'string', default: '' });
  });

  it('grants nothing by default, writes nothing with the run’s token, and each job reads only what it needs', () => {
    expect(workflow.permissions).toEqual({});
    expect(Object.keys(workflow.jobs)).toEqual(['check', 'tag']);
    expect(workflow.jobs.check?.permissions).toEqual({ contents: 'read', actions: 'read', 'pull-requests': 'read', issues: 'read' });
    expect(tagJob.permissions).toEqual({ contents: 'read', actions: 'read' });
  });

  it('runs one at a time, so two cannot count the same next patch', () => {
    expect(workflow.concurrency).toEqual({ group: 'cut-release', 'cancel-in-progress': false });
  });

  it('checks before the environment’s job, which needs the check and alone names the environment', () => {
    expect(workflow.jobs.check?.environment).toBeUndefined();
    expect(tagJob.needs).toBe('check');
    expect(tagJob.environment).toBe('release');
    const check = (workflow.jobs.check?.steps ?? []).find((step) => step.id === 'check');
    expect(check?.run?.trim()).toBe('node .github/scripts/cut-release-check.mjs');
    // The run's own context, each value through the environment and none pasted into the script.
    expect(check?.env).toEqual({
      EVENT: '${{ github.event_name }}',
      REF: '${{ github.ref }}',
      WORKFLOW_REF: '${{ github.workflow_ref }}',
      REPO: '${{ github.repository }}',
      REPO_ID: '${{ github.repository_id }}',
      MAIN_HEAD: '${{ github.sha }}',
      ACTOR: '${{ github.actor }}',
      TRIGGERING_ACTOR: '${{ github.triggering_actor }}',
      VERSION: '${{ inputs.version }}',
      GH_TOKEN: '${{ github.token }}',
    });
    expect(workflow.jobs.check?.outputs).toEqual({
      tag: '${{ steps.check.outputs.tag }}',
      sha: '${{ steps.check.outputs.sha }}',
      actor: '${{ steps.check.outputs.actor }}',
    });
    expect(text).not.toMatch(/run:.*\$\{\{\s*inputs\./);
  });

  it('reads the token in one step of the tag job, which runs no action and passes it to nothing else', () => {
    // The whole file names one secret, once.
    expect([...text.matchAll(/secrets\./g)]).toHaveLength(1);
    expect([...text.matchAll(/RELEASE_TAG_TOKEN/g)].length).toBeGreaterThan(1);
    const push = tagStep(PUSH);
    expect(push.env?.RELEASE_TAG_TOKEN).toBe('${{ secrets.RELEASE_TAG_TOKEN }}');
    expect(push.uses).toBeUndefined();
    expect(push.with).toBeUndefined();
    // The checkout is the commit to tag: nothing in it runs beside the token.
    expect(push.run).not.toMatch(/\b(node|pnpm|npm|npx|make|bash|sh|source|python3?|curl)\b|(^|\s)\.\/|(^|\s)\.\s/m);
    for (const [name, job] of Object.entries(workflow.jobs)) {
      expect(job.secrets, name).toBeUndefined();
      expect(JSON.stringify(job.env ?? {}), name).not.toMatch(/secrets|RELEASE_TAG_TOKEN/);
      for (const step of job.steps ?? []) {
        if (step === push) continue;
        expect(JSON.stringify(step), `${name}: ${step.name ?? step.uses}`).not.toMatch(/secrets|RELEASE_TAG_TOKEN/);
      }
    }
  });

  it('asks again that the run is the releaser’s, before it checks out the commit, with no credential left in either checkout', () => {
    const steps = tagJob.steps ?? [];
    expect(steps.map((step) => step.name ?? step.uses?.split('@')[0])).toEqual([
      "the run is still the releaser's",
      'actions/checkout',
      PUSH,
      'link the release run',
    ]);
    expect(steps[1]?.with).toEqual({ ref: '${{ needs.check.outputs.sha }}', 'persist-credentials': false });
    expect(tagJob.env).toEqual({ TAG: '${{ needs.check.outputs.tag }}', SHA: '${{ needs.check.outputs.sha }}', REPO: '${{ github.repository }}' });
    const checkout = (workflow.jobs.check?.steps ?? [])[0];
    expect(checkout?.with).toEqual({ 'fetch-depth': 0, 'persist-credentials': false });
  });
});

/**
 * Steps of the tag job, run as GitHub runs them (bash -eo pipefail), with
 * stand-ins for the programs in `stubs`. Each writes down what it was asked,
 * `<program> <arguments>`, one line a call, then runs its body. `credential`
 * is what the stand-in git was handed, when it was.
 */
function run(script: string, env: Record<string, string>, stubs: Record<string, string> = {}): { status: number | null; asked: string; said: string; summary: string; credential: string } {
  const bin = mkdtempSync(join(tmpdir(), 'cut-release-steps-'));
  try {
    for (const [name, body] of Object.entries(stubs)) {
      writeFileSync(join(bin, name), `#!/bin/bash\necho "${name} $*" >> "$ASKED"\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    }
    const asked = join(bin, 'asked');
    const summary = join(bin, 'summary');
    writeFileSync(asked, '');
    writeFileSync(summary, '');
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
      cwd: bin,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        ASKED: asked,
        BIN: bin,
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_SERVER_URL: 'https://github.com',
        REPO,
        TAG: 'v0.2.0',
        SHA: 'a'.repeat(40),
        ...env,
      },
      encoding: 'utf8',
    });
    const credential = join(bin, 'credential');
    return {
      status: result.status,
      asked: readFileSync(asked, 'utf8'),
      said: `${result.stdout}${result.stderr}`,
      summary: readFileSync(summary, 'utf8'),
      credential: existsSync(credential) ? readFileSync(credential, 'utf8') : '',
    };
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

describe('the tag job, run', () => {
  const TOKEN = 'github_pat_11AAAAAAA0secretvalue0123456789';
  const BASIC = Buffer.from(`orzelig:${TOKEN}`).toString('base64');
  /** gh answers whose the token is, when it is the token; git writes down the credential it was handed, where the test can read it. */
  const stubs = (owner = 'orzelig 2146989', push = 0) => ({
    gh: `if [ "$GH_TOKEN" = "${TOKEN}" ]; then echo "${owner}"; else echo "HTTP 401: Bad credentials" >&2; exit 1; fi`,
    git: [
      'if [ "$1" = push ]; then',
      '  printf "%s\\n" "$GIT_CONFIG_COUNT" "$GIT_CONFIG_KEY_0" "$GIT_CONFIG_VALUE_0" "$GIT_TERMINAL_PROMPT" > "$BIN/credential"',
      `  exit ${push}`,
      'fi',
    ].join('\n'),
  });
  const pushEnv = { RELEASE_TAG_TOKEN: TOKEN, ACTOR: 'orzelig', RUN_URL: 'https://github.com/acme/openadlc/actions/runs/7' };

  it('refuses a re-run by anyone but the releaser check let through', () => {
    const script = tagStep("the run is still the releaser's").run!;
    expect(run(script, { ACTOR: 'orzelig', CHECKED: 'orzelig' }).status).toBe(0);
    expect(run(script, { ACTOR: 'openadlc-atlas-orzelig', CHECKED: 'orzelig' }).status).not.toBe(0);
    expect(run(script, { ACTOR: 'orzelig', CHECKED: '' }).status).not.toBe(0);
  });

  it('makes an annotated tag by the token’s owner, and pushes it with the credential in git’s environment alone', () => {
    const pushed = run(tagStep(PUSH).run!, pushEnv, stubs());
    expect(pushed.status, pushed.said).toBe(0);
    expect(pushed.asked.trim().split('\n')).toEqual([
      'gh api user --jq "\\(.login) \\(.id)"',
      `git -c user.name=orzelig -c user.email=2146989+orzelig@users.noreply.github.com tag -a v0.2.0 ${'a'.repeat(40)} -m v0.2.0 -m Cut by orzelig with https://github.com/acme/openadlc/actions/runs/7`,
      'git push origin refs/tags/v0.2.0:refs/tags/v0.2.0',
    ]);
    expect(pushed.credential.split('\n').slice(0, 4)).toEqual(['1', 'http.https://github.com/.extraheader', `AUTHORIZATION: basic ${BASIC}`, '0']);
    // Never on a command line, and never in the log.
    for (const secret of [TOKEN, BASIC]) {
      expect(pushed.asked).not.toContain(secret);
      expect(pushed.said).not.toContain(secret);
    }
    expect(pushed.said).toContain(`pushed v0.2.0 on ${'a'.repeat(40)} as orzelig`);
  });

  it.each<[string, Record<string, string>, ReturnType<typeof stubs>, RegExp]>([
    ['there is no token', { ...pushEnv, RELEASE_TAG_TOKEN: '' }, stubs(), /no secret RELEASE_TAG_TOKEN/],
    ['GitHub does not take the token', { ...pushEnv, RELEASE_TAG_TOKEN: 'github_pat_expired' }, stubs(), /expired or been revoked/],
    ['the token is someone else’s', pushEnv, stubs('someone 7'), /RELEASE_TAG_TOKEN is someone's, not orzelig's/],
  ])('pushes nothing, and makes no tag, when %s', (_what, env, programs, reason) => {
    const refused = run(tagStep(PUSH).run!, env, programs);
    expect(refused.status).not.toBe(0);
    expect(refused.said).toMatch(reason);
    expect(refused.said).toMatch(/Nothing is tagged/);
    expect(refused.asked).not.toMatch(/^git /m);
    expect(refused.said).not.toContain(TOKEN);
  });

  it('takes the token’s owner in any case, as GitHub does a login', () => {
    expect(run(tagStep(PUSH).run!, { ...pushEnv, ACTOR: 'OrZelig' }, stubs()).status).toBe(0);
  });

  it('fails, saying so, when GitHub refuses the push, and the token is still nowhere in the log', () => {
    const refused = run(tagStep(PUSH).run!, pushEnv, stubs('orzelig 2146989', 1));
    expect(refused.status).not.toBe(0);
    expect(refused.said).toMatch(/GitHub refused the push of v0\.2\.0 as orzelig/);
    for (const secret of [TOKEN, BASIC]) expect(refused.said).not.toContain(secret);
  });

  it('links the run of release.yml the push started, and fails when none appears', () => {
    const script = tagStep('link the release run').run!;
    const found = run(script, {}, { gh: 'echo https://github.com/acme/openadlc/actions/runs/8', sleep: '' });
    expect(found.status).toBe(0);
    expect(found.asked.trim()).toBe('gh api repos/acme/openadlc/actions/workflows/release.yml/runs?event=push&branch=v0.2.0&per_page=1 --jq .workflow_runs[0].html_url // empty');
    expect(found.summary).toContain('https://github.com/acme/openadlc/actions/runs/8');
    const none = run(script, {}, { gh: '', sleep: '' });
    expect(none.status).not.toBe(0);
    expect(none.asked.split('\n').filter((line) => line.startsWith('gh '))).toHaveLength(12);
    expect(none.asked.split('\n').filter((line) => line.startsWith('sleep '))).toHaveLength(11);
    expect(none.said).toMatch(/v0\.2\.0 is pushed, but no run of release\.yml for it appeared/);
  });
});

describe('RELEASERS, as the check reads them', () => {
  it('is release-build.yml’s own list, read as GitHub reads its YAML', () => {
    const env = (parseYamlFile(join(WORKFLOWS, 'release-build.yml')) as Workflow).env ?? {};
    expect(releasersIn(RELEASE_BUILD)).toEqual(releasersOf(env.RELEASERS));
    expect(releasersIn(RELEASE_BUILD)).toEqual(['orzelig']);
  });

  it('is only the top-level env’s, once', () => {
    expect(releasersIn('on:\n  workflow_call:\n# a note\nenv:\n  # who\n  RELEASERS: "a, @B" # two\njobs: {}\n')).toEqual(['a', 'b']);
    expect(() => releasersIn('jobs:\n  check:\n    env:\n      RELEASERS: orzelig\n')).toThrow(/names RELEASERS 0 times/);
    expect(() => releasersIn('env:\n  RELEASERS: a\njobs:\n  x: {}\nenv:\n  RELEASERS: b\n')).toThrow(/names RELEASERS 2 times/);
  });
});

/**
 * Each thing the check refuses before the tag job may ask for its approval,
 * against a real repository and a stand-in for GitHub's API.
 */
let dir: string;
let commits: { first: string; side: string; release: string };
let api: Record<string, unknown>;
let verified: Set<string>;
let said: string[];
let releaseBuild: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function commit(name: string): string {
  writeFileSync(join(dir, `${name}.md`), `${name}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', name);
  return git('rev-parse', 'HEAD');
}

/** ci.yml's push run of a commit on main, completed, with the jobs it ran. */
function ciRun(id: number, sha: string, jobs: Record<string, string>, extra: Record<string, unknown> = {}): void {
  api[`repos/${REPO}/actions/runs?head_sha=${sha}&event=push&branch=main&per_page=100`] = {
    workflow_runs: [{ id, path: '.github/workflows/ci.yml', head_repository: { id: 42 }, head_sha: sha, status: 'completed', created_at: '2026-10-21T10:00:00Z', ...extra }],
  };
  api[`repos/${REPO}/actions/runs/${id}/jobs?per_page=100`] = { jobs: Object.entries(jobs).map(([name, conclusion]) => ({ name, conclusion })) };
}

/** A commit that changed only docs, on top of main, whose ci passed running the docs job alone. */
function docsCommit(name: string, id: number, verdict = 'success'): string {
  const sha = commit(name);
  git('update-ref', 'refs/remotes/origin/main', 'main');
  ciRun(id, sha, { changes: 'success', check: 'skipped', integration: 'skipped', docs: verdict, ci: verdict });
  // No pull request's run tested its tree: one that changes only docs uploads no verdict.
  api[`repos/${REPO}/actions/artifacts?name=tested-tree-${git('rev-parse', `${sha}^{tree}`)}&per_page=100`] = { artifacts: [] };
  return sha;
}

const tools = () => ({
  git: (args: string[]) => (args[0] === 'show' && args[1] === 'refs/remotes/origin/main:.github/workflows/release-build.yml' ? releaseBuild : git(...args)),
  api: (path: string) => {
    if (!(path in api)) throw new Error(`no fixture for ${path}`);
    return api[path];
  },
  verifyRelease: ({ tag }: { tag: string }) => verified.has(tag),
  sleep: () => undefined,
  say: (line: string) => void said.push(line),
});

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    event: 'workflow_dispatch',
    ref: 'refs/heads/main',
    workflowRef: `${REPO}/.github/workflows/cut-release.yml@refs/heads/main`,
    repo: REPO,
    repoId: REPO_ID,
    head: git('rev-parse', 'main'),
    actor: 'orzelig',
    triggeringActor: 'orzelig',
    version: '',
    ciAttempts: 2,
    ...overrides,
  };
}

const cut = (overrides: Record<string, unknown> = {}) => checkCut(ctx(overrides), tools());

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cut-release-'));
  git('init', '-q', '-b', 'main');
  const first = commit('first');
  git('tag', 'v0.1.0', first);
  git('checkout', '-q', '-b', 'side');
  const side = commit('side');
  git('checkout', '-q', 'main');
  git('merge', '-q', '--no-ff', '-m', 'Merge side', 'side');
  commits = { first, side, release: commit('release') };
  git('update-ref', 'refs/remotes/origin/main', 'main');
  releaseBuild = RELEASE_BUILD;
  api = {
    [`repos/${REPO}/environments/release`]: {
      name: 'release',
      protection_rules: [
        { type: 'required_reviewers', prevent_self_review: false, reviewers: [{ type: 'User', reviewer: { login: 'orzelig' } }] },
        { type: 'branch_policy' },
      ],
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    },
    [`repos/${REPO}/environments/release/deployment-branch-policies?per_page=100`]: { total_count: 1, branch_policies: [{ name: 'main', type: 'branch' }] },
    [`repos/${REPO}/releases?per_page=100`]: [{ tag_name: 'v0.1.0', draft: false, prerelease: false, immutable: true }],
    [`repos/${REPO}/git/matching-refs/tags/v0.1.1`]: [],
    [`repos/${REPO}/git/matching-refs/tags/v0.3.0`]: [{ ref: 'refs/tags/v0.3.0.1' }],
  };
  verified = new Set(['v0.1.0']);
  said = [];
  ciRun(7, commits.release, { changes: 'success', check: 'success', integration: 'success', docs: 'skipped', ci: 'success' });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('a cut the check lets through', () => {
  it('is a releaser’s run on main, the next patch after the newest release, on main’s head whose ci passed', () => {
    expect(cut()).toEqual({ tag: 'v0.1.1', sha: commits.release, actor: 'orzelig' });
    expect(said.at(-1)).toMatch(/v0\.1\.1 is to be .*, after v0\.1\.0; ci passed in main's run 7 .*Approve the release environment's job/);
  });

  it('takes the version given, with its v or without', () => {
    expect(cut({ version: '0.3.0' }).tag).toBe('v0.3.0');
    expect(cut({ version: ' v0.3.0 ' }).tag).toBe('v0.3.0');
  });

  it('may be the first release, given its version', () => {
    api[`repos/${REPO}/releases?per_page=100`] = [];
    expect(cut({ version: '0.3.0' })).toMatchObject({ tag: 'v0.3.0', sha: commits.release });
    expect(() => cut()).toThrow(/no release yet to count the next patch from: run it again with the version/);
  });

  it('tags the commit before a head that changed only docs, which builds the same, and says so', () => {
    const docs = docsCommit('docs', 8);
    expect(cut()).toMatchObject({ tag: 'v0.1.1', sha: commits.release });
    expect(said.join('\n')).toContain(`${docs} changed only docs, so its ci built nothing and release-build would refuse it; the commit before it, ${commits.release}, has the same build`);
    // And on back, past each commit that changed only docs.
    docsCommit('more-docs', 9);
    expect(cut().sha).toBe(commits.release);
  });

  it('counts releases as release-build does, passing over one it did not make', () => {
    api[`repos/${REPO}/releases?per_page=100`] = [
      { tag_name: 'v999.0.0', draft: false, prerelease: false, immutable: true },
      { tag_name: 'v0.1.0', draft: false, prerelease: false, immutable: true },
    ];
    git('tag', 'v999.0.0', commits.first);
    expect(cut().tag).toBe('v0.1.1');
    expect(said.filter((line) => line.startsWith('not counted'))).toEqual(['not counted, as releases this workflow did not make: v999.0.0']);
  });
});

describe('the run', () => {
  it.each([
    ['started by anything but a person’s hand', { event: 'push' }, /only when started by hand, not for a push/],
    ['on another branch', { ref: 'refs/heads/agent/x' }, /was run on refs\/heads\/agent\/x, not on main/],
    ['on a tag', { ref: 'refs/tags/v0.1.0' }, /was run on refs\/tags\/v0\.1\.0, not on main/],
    ['of another workflow', { workflowRef: `${REPO}/.github/workflows/other.yml@refs/heads/main` }, /this run is of .*other\.yml/],
    ['of another repository’s', { workflowRef: 'evil/fork/.github/workflows/cut-release.yml@refs/heads/main' }, /this run is of evil\/fork/],
  ])('is refused when %s', (_what, overrides, reason) => {
    expect(() => cut(overrides)).toThrow(reason);
  });

  it('is refused when started, or re-run, by anyone but one of RELEASERS', () => {
    expect(() => cut({ actor: 'openadlc-atlas-orzelig' })).toThrow(/openadlc-atlas-orzelig is not one of RELEASERS in release-build\.yml \(orzelig\)/);
    expect(() => cut({ triggeringActor: 'someone' })).toThrow(/someone is not one of RELEASERS/);
    expect(cut({ actor: 'OrZelig', triggeringActor: 'ORZELIG' }).actor).toBe('ORZELIG');
  });

  it('reads RELEASERS from release-build.yml as main has it', () => {
    releaseBuild = RELEASE_BUILD.replace(/^ {2}RELEASERS: .*$/m, '  RELEASERS: someone');
    expect(() => cut()).toThrow(/orzelig is not one of RELEASERS in release-build\.yml \(someone\)/);
    releaseBuild = RELEASE_BUILD.replace(/^ {2}RELEASERS: .*$/m, '');
    expect(() => cut()).toThrow(/names RELEASERS 0 times/);
  });
});

describe('the release environment', () => {
  const environment = () => api[`repos/${REPO}/environments/release`] as { protection_rules: Record<string, unknown>[]; deployment_branch_policy: unknown };
  const review = () => environment().protection_rules[0] as { prevent_self_review: boolean; reviewers: unknown[] };

  it('is refused when it does not exist, since the tag job would make one with no protection', () => {
    delete api[`repos/${REPO}/environments/release`];
    expect(() => cut()).toThrow(/no release environment, and the tag job would make one with no reviewer/);
  });

  it.each<[string, () => void, RegExp]>([
    ['it has no required reviewer', () => environment().protection_rules.splice(0, 1), /has no required reviewer/],
    ['its reviewers are empty', () => (review().reviewers = []), /has no required reviewer/],
    ['a reviewer is not a releaser', () => review().reviewers.push({ type: 'User', reviewer: { login: 'openadlc-atlas' } }), /reviewers include openadlc-atlas, who is not one of RELEASERS/],
    ['a reviewer is a team', () => (review().reviewers = [{ type: 'Team', reviewer: { slug: 'crew' } }]), /reviewers include the team crew/],
    ['the releaser cannot approve his own run', () => (review().prevent_self_review = true), /prevents self-review, so orzelig could not approve this run/],
    ['any branch may deploy', () => (environment().deployment_branch_policy = null), /lets any branch or tag deploy/],
    ['any protected branch may deploy', () => (environment().deployment_branch_policy = { protected_branches: true, custom_branch_policies: false }), /lets any protected branch deploy/],
    [
      'another branch may deploy',
      () => (api[`repos/${REPO}/environments/release/deployment-branch-policies?per_page=100`] = { branch_policies: [{ name: 'main', type: 'branch' }, { name: 'agent/*', type: 'branch' }] }),
      /lets the branch main, the branch agent\/\* deploy/,
    ],
    ['a tag named main may deploy', () => (api[`repos/${REPO}/environments/release/deployment-branch-policies?per_page=100`] = { branch_policies: [{ name: 'main', type: 'tag' }] }), /lets the tag main deploy/],
  ])('is refused when %s', (_what, change, reason) => {
    change();
    expect(() => cut()).toThrow(reason);
  });
});

describe('the version', () => {
  it.each(['01.2.0', '1.2', '1.2.3-rc.1', 'latest', 'v1.2.3\n::error::x'])('is refused when given as %j', (version) => {
    expect(() => cut({ version })).toThrow(/is not a version: three numbers/);
  });

  it('is refused when it is not above the newest release', () => {
    api[`repos/${REPO}/git/matching-refs/tags/v0.0.9`] = [];
    expect(() => cut({ version: '0.0.9' })).toThrow(/v0\.0\.9 is not above v0\.1\.0, the newest release/);
  });

  it('is refused when it already has a release, or a tag', () => {
    expect(() => cut({ version: '0.1.0' })).toThrow(/v0\.1\.0 already has a release, which is never replaced/);
    api[`repos/${REPO}/git/matching-refs/tags/v0.1.1`] = [{ ref: 'refs/tags/v0.1.1' }];
    expect(() => cut()).toThrow(/v0\.1\.1 is a tag already, with no release .*git push origin :refs\/tags\/v0\.1\.1/);
    // A longer tag that begins with it is another version.
    expect(cut({ version: '0.3.0' }).tag).toBe('v0.3.0');
  });
});

describe('ci', () => {
  it('is refused when main’s run of it failed, or has not run', () => {
    ciRun(7, commits.release, { check: 'failure', ci: 'failure' });
    expect(() => cut()).toThrow(/ci ended failure on .* in main's run 7/);
    api[`repos/${REPO}/actions/runs?head_sha=${commits.release}&event=push&branch=main&per_page=100`] = { workflow_runs: [] };
    expect(() => cut()).toThrow(/ci has not passed on .* in a run on main \(it is missing\)/);
  });

  it('does not step back past a commit that changed only docs but whose ci failed', () => {
    docsCommit('broken-docs', 8, 'failure');
    expect(() => cut()).toThrow(/ci ended failure on .* in main's run 8/);
  });

  it('does not step back past a commit whose tests were skipped for another reason', () => {
    const head = commit('vouched');
    git('update-ref', 'refs/remotes/origin/main', 'main');
    ciRun(8, head, { changes: 'success', check: 'skipped', docs: 'skipped', ci: 'success' });
    api[`repos/${REPO}/actions/artifacts?name=tested-tree-${git('rev-parse', `${head}^{tree}`)}&per_page=100`] = { artifacts: [] };
    expect(() => cut()).toThrow(/skipped the tests, and no pull request's run into main that ran them vouches for its tree/);
  });

  it('is refused when nothing but docs changed since the newest release, or nothing at all', () => {
    api[`repos/${REPO}/releases?per_page=100`] = [{ tag_name: 'v0.1.0', draft: false, prerelease: false, immutable: true }];
    git('tag', '-f', 'v0.1.0', commits.release);
    expect(() => cut()).toThrow(new RegExp(`main's head ${commits.release} is v0\\.1\\.0 already: there is nothing new to release`));
    docsCommit('docs', 8);
    expect(() => cut()).toThrow(new RegExp(`main has changed only docs since v0\\.1\\.0 \\(${commits.release}\\): there is nothing new to release`));
  });
});
