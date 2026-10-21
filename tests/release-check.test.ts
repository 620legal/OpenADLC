import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error — a plain script with no types; release-build.yml and ci.yml run it directly.
import { checkRelease, releasersOf, vouchedRun } from '../.github/scripts/release-check.mjs';

/**
 * Each thing release-build.yml refuses before it builds, run against a real
 * repository and a stand-in for GitHub's API: a check that is disabled, or
 * reads the wrong field, fails one of these.
 */
const REPO = 'acme/openadlc';
const REPO_ID = '42';
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

let dir: string;
let commits: { first: string; side: string; release: string };
let api: Record<string, unknown>;
let verified: Set<string>;
let said: string[];

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function commit(name: string): string {
  writeFileSync(join(dir, `${name}.md`), `${name}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', name);
  return git('rev-parse', 'HEAD');
}

/** ci.yml's push run of a commit on main, passed, with the jobs it ran. */
function ciRun(id: number, sha: string, jobs: Record<string, string>, extra: Record<string, unknown> = {}): void {
  api[`repos/${REPO}/actions/runs?head_sha=${sha}&event=push&branch=main&per_page=100`] = {
    workflow_runs: [{ id, path: '.github/workflows/ci.yml', head_repository: { id: 42 }, head_sha: sha, status: 'completed', created_at: '2026-10-21T10:00:00Z', ...extra }],
  };
  api[`repos/${REPO}/actions/runs/${id}/jobs?per_page=100`] = { jobs: Object.entries(jobs).map(([name, conclusion]) => ({ name, conclusion })) };
}

interface Pull {
  number: number;
  head: { sha: string; ref: string; repo: { id: number } };
  base: { ref: string; repo: { id: number } };
}

/** What GitHub says about a pull request's run of ci.yml, piece by piece, for a test to change one. */
interface PullRequestRun {
  artifact: { name: string; workflow_run: { id: number; head_repository_id: number; head_sha: string } };
  run: Record<string, unknown>;
  headTree: string;
  /** `commits/<head>/pulls`: the pull requests with that head. */
  withHead: Pull[];
  /** `pulls?state=all&head=acme:<branch>`: every pull request ever opened from the run's branch. */
  fromBranch: Pull[];
  events: Record<number, { event: string }[]>;
  check: string;
}

/** A pull request's run of ci.yml that tested `tree`, from branch `x` into main unless `change` says otherwise. */
function pullRequestRun(tree: string, head: string, change: (found: PullRequestRun) => void = () => undefined): void {
  const pull: Pull = { number: 31, head: { sha: head, ref: 'x', repo: { id: 42 } }, base: { ref: 'main', repo: { id: 42 } } };
  const found: PullRequestRun = {
    artifact: { name: `tested-tree-${tree}`, workflow_run: { id: 900, head_repository_id: 42, head_sha: head } },
    run: { id: 900, event: 'pull_request', conclusion: 'success', path: '.github/workflows/ci.yml', head_sha: head, head_branch: 'x', head_repository: { id: 42 } },
    headTree: tree,
    withHead: [pull],
    fromBranch: [pull],
    events: { 31: [{ event: 'labeled' }] },
    check: 'success',
  };
  change(found);
  const branch = String(found.run.head_branch);
  api[`repos/${REPO}/actions/artifacts?name=tested-tree-${tree}&per_page=100`] = { artifacts: [found.artifact] };
  api[`repos/${REPO}/actions/runs/900`] = found.run;
  api[`repos/${REPO}/git/commits/${head}`] = { tree: { sha: found.headTree } };
  api[`repos/${REPO}/commits/${head}/pulls`] = found.withHead;
  api[`repos/${REPO}/pulls?state=all&head=${encodeURIComponent(`acme:${branch}`)}&per_page=100`] = found.fromBranch;
  for (const [number, events] of Object.entries(found.events)) api[`repos/${REPO}/issues/${number}/events?per_page=100`] = events;
  api[`repos/${REPO}/actions/runs/900/jobs?per_page=100`] = { jobs: [{ name: 'check', conclusion: found.check }, { name: 'ci', conclusion: 'success' }] };
}

const tools = () => ({
  git: (args: string[]) => git(...args),
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
    event: 'push',
    ref: 'refs/tags/v0.2.0',
    refType: 'tag',
    tag: 'v0.2.0',
    caller: `${REPO}/.github/workflows/release.yml@refs/tags/v0.2.0`,
    repo: REPO,
    repoId: REPO_ID,
    pushed: commits.release,
    actor: 'orzelig',
    releasers: 'orzelig',
    ciAttempts: 2,
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'release-check-'));
  git('init', '-q', '-b', 'main');
  const first = commit('first');
  git('tag', 'v0.1.0', first);
  // A branch merged in: its commit is an ancestor of main, never a first parent.
  git('checkout', '-q', '-b', 'side');
  const side = commit('side');
  git('checkout', '-q', 'main');
  git('merge', '-q', '--no-ff', '-m', 'Merge side', 'side');
  commits = { first, side, release: commit('release') };
  git('tag', 'v0.2.0', commits.release);
  git('update-ref', 'refs/remotes/origin/main', 'main');
  api = { [`repos/${REPO}/releases?per_page=100`]: [{ tag_name: 'v0.1.0', draft: false, prerelease: false, immutable: true }] };
  verified = new Set(['v0.1.0']);
  said = [];
  ciRun(7, commits.release, { check: 'success', ci: 'success' });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('a release the checks let through', () => {
  it('is a releaser’s next version on main, whose ci ran the tests and passed', () => {
    expect(checkRelease(ctx(), tools())).toEqual({ sha: commits.release, tree: git('rev-parse', `${commits.release}^{tree}`), actor: 'orzelig' });
    expect(said.at(-1)).toMatch(/after v0\.1\.0; ci passed in main's run 7/);
  });

  it('may be the first, and names releasers in any case', () => {
    api[`repos/${REPO}/releases?per_page=100`] = [];
    expect(checkRelease(ctx({ actor: 'OrZelig', releasers: '@orzelig, someone' }), tools()).sha).toBe(commits.release);
    expect(releasersOf('a, @B  c')).toEqual(['a', 'b', 'c']);
  });
});

describe('the run', () => {
  it.each([
    ['started by hand', { event: 'workflow_dispatch' }, /only for the push of a version tag, not for a workflow_dispatch/],
    ['a branch push', { refType: 'branch', ref: 'refs/heads/main' }, /only for the push of a version tag/],
    ['for a tag with leading zeros', { tag: 'v01.2.0', ref: 'refs/tags/v01.2.0' }, /not a version tag/],
    ['called by another workflow', { caller: `${REPO}/.github/workflows/sneaky.yml@refs/tags/v0.2.0` }, /was called by .*sneaky\.yml/],
    ['called from another repository', { caller: 'evil/fork/.github/workflows/release.yml@refs/tags/v0.2.0' }, /was called by evil\/fork/],
  ])('is refused when %s', (_what, overrides, reason) => {
    expect(() => checkRelease(ctx(overrides), tools())).toThrow(reason);
  });

  it('is refused for anyone but a releaser, the crew’s accounts among them', () => {
    expect(() => checkRelease(ctx({ actor: 'openadlc-atlas-orzelig' }), tools())).toThrow(/openadlc-atlas-orzelig is not one of RELEASERS in release-build\.yml \(orzelig\)/);
    expect(() => checkRelease(ctx({ releasers: '' }), tools())).toThrow(/\(nobody\)/);
  });
});

describe('the commit', () => {
  it('is refused when the tag moved after the push', () => {
    expect(() => checkRelease(ctx({ pushed: commits.first }), tools())).toThrow(/points at .* now, not at/);
  });

  it('is refused when it is not one of main’s first parents, as a merged branch’s commit is not', () => {
    git('tag', '-f', 'v0.2.0', commits.side);
    expect(() => checkRelease(ctx({ pushed: commits.side }), tools())).toThrow(/is not one of main's first parents/);
  });
});

describe('the version', () => {
  it('is refused when it is not above the newest release', () => {
    api[`repos/${REPO}/releases?per_page=100`] = [{ tag_name: 'v0.3.0', draft: false, prerelease: false, immutable: true }];
    git('tag', 'v0.3.0', commits.first);
    verified.add('v0.3.0');
    expect(() => checkRelease(ctx(), tools())).toThrow(/v0\.2\.0 is not above v0\.3\.0, the newest release/);
  });

  it('passes over a release this workflow did not make, rather than being blocked by it', () => {
    api[`repos/${REPO}/releases?per_page=100`] = [
      { tag_name: 'v999.0.0', draft: false, prerelease: false, immutable: true },
      { tag_name: 'v500.0.0', draft: false, prerelease: false, immutable: false },
      { tag_name: 'v0.1.0', draft: false, prerelease: false, immutable: true },
    ];
    git('tag', 'v999.0.0', commits.first);
    expect(checkRelease(ctx(), tools()).sha).toBe(commits.release);
    expect(said[0]).toMatch(/not counted, as releases this workflow did not make: .*v500\.0\.0.*v999\.0\.0|v999\.0\.0.*v500\.0\.0/);
  });

  it('is refused when the newest release is not behind it on main', () => {
    git('tag', '-f', 'v0.1.0', commits.side);
    expect(() => checkRelease(ctx(), tools())).toThrow(/v0\.1\.0 \(.*\) is not one of v0\.2\.0's first parents on main/);
  });

  it('is refused when the tag already has a release, whoever made it', () => {
    api[`repos/${REPO}/releases?per_page=100`] = [{ tag_name: 'v0.2.0', draft: false, prerelease: false, immutable: false }];
    expect(() => checkRelease(ctx(), tools())).toThrow(/v0\.2\.0 already has a release/);
  });
});

describe('ci', () => {
  it('is refused when main’s run of it failed, or has not run', () => {
    ciRun(7, commits.release, { check: 'failure', ci: 'failure' });
    expect(() => checkRelease(ctx(), tools())).toThrow(/ci ended failure on .* in main's run 7/);
    api[`repos/${REPO}/actions/runs?head_sha=${commits.release}&event=push&branch=main&per_page=100`] = { workflow_runs: [] };
    expect(() => checkRelease(ctx(), tools())).toThrow(/ci has not passed on .* in a run on main \(it is missing\)/);
  });

  it('waits for a run still going, then is refused', () => {
    ciRun(7, commits.release, { ci: 'success' }, { status: 'in_progress' });
    expect(() => checkRelease(ctx(), tools())).toThrow(/\(it is running\)/);
  });

  it('counts only ci.yml’s own run on main, not another workflow’s check named ci', () => {
    ciRun(7, commits.release, { check: 'success', ci: 'success' }, { path: '.github/workflows/other.yml' });
    expect(() => checkRelease(ctx(), tools())).toThrow(/\(it is missing\)/);
  });

  it('accepts a run that skipped the tests for a pull request’s run into main that ran them', () => {
    const tree = git('rev-parse', `${commits.release}^{tree}`);
    ciRun(7, commits.release, { check: 'skipped', docs: 'skipped', ci: 'success' });
    pullRequestRun(tree, 'f'.repeat(40));
    expect(said).toEqual([]);
    expect(checkRelease(ctx(), tools()).sha).toBe(commits.release);
    expect(said.at(-1)).toMatch(/tests in run 900/);
  });

  it('refuses one that skipped the tests for a pull request’s run into another branch', () => {
    const tree = git('rev-parse', `${commits.release}^{tree}`);
    ciRun(7, commits.release, { check: 'skipped', ci: 'success' });
    pullRequestRun(tree, 'f'.repeat(40), (found) => (found.withHead[0]!.base.ref = 'agent/y'));
    expect(() => checkRelease(ctx(), tools())).toThrow(/skipped the tests, and no pull request's run into main that ran them vouches for its tree/);
  });

  it('says plainly when main’s run was cancelled by the next push', () => {
    ciRun(7, commits.release, { ci: 'cancelled' }, { conclusion: 'cancelled' });
    expect(() => checkRelease(ctx(), tools())).toThrow(/main's ci for .* was cancelled \(run 7\): re-run it, then push the tag again/);
  });
});

describe('what ci.yml’s push to main reads', () => {
  const tree = 'a'.repeat(40);
  const head = 'f'.repeat(40);
  const vouched = () => vouchedRun({ repo: REPO, repoId: REPO_ID }, tools(), tree);

  it('is a pull request’s run into main that tested the tree and ran the tests', () => {
    pullRequestRun(tree, head);
    expect(vouched()).toBe(900);
  });

  // Each thing it reads, changed one at a time: each must refuse on its own.
  it.each<[string, (found: PullRequestRun) => void]>([
    ['a run that did not pass', (found) => (found.run.conclusion = 'failure')],
    ['a run that was not a pull request’s', (found) => (found.run.event = 'push')],
    ['a run of another workflow', (found) => (found.run.path = '.github/workflows/other.yml')],
    ['a run from a fork', (found) => (found.run.head_repository = { id: 7 })],
    ['an artifact a fork’s run uploaded', (found) => (found.artifact.workflow_run.head_repository_id = 7)],
    ['a run on another tree', (found) => (found.headTree = 'b'.repeat(40))],
    ['a run that skipped the tests', (found) => (found.check = 'skipped')],
    ['a run with no branch', (found) => (found.run.head_branch = null)],
    ['a pull request into another branch', (found) => (found.withHead[0]!.base.ref = 'agent/y')],
    ['a pull request into another repository', (found) => (found.withHead[0]!.base.repo.id = 7)],
    ['a pull request from a fork', (found) => (found.withHead[0]!.head.repo.id = 7)],
    ['a pull request with another head', (found) => (found.withHead[0]!.head.sha = 'e'.repeat(40))],
    ['a pull request from another branch', (found) => (found.withHead[0]!.head.ref = 'y')],
    ['a pull request whose base changed', (found) => (found.events[31] = [{ event: 'base_ref_changed' }])],
    ['no pull request at all', (found) => ((found.withHead = []), (found.fromBranch = []))],
  ])('refuses %s', (_what, change) => {
    pullRequestRun(tree, head, change);
    expect(vouched()).toBeNull();
  });

  it('refuses a run of a branch that also has a pull request into another branch, which ran that branch’s ci.yml', () => {
    // Branch x at one head, two pull requests: #30 into foo, whose fake
    // ci.yml uploaded the tree's artifact from run 900, and #31 into main.
    // Nothing in run 900 says which it was, so the branch's other pull request refuses it.
    pullRequestRun(tree, head, (found) => {
      const intoFoo: Pull = { number: 30, head: { sha: head, ref: 'x', repo: { id: 42 } }, base: { ref: 'foo', repo: { id: 42 } } };
      found.withHead = [intoFoo, ...found.withHead];
      found.fromBranch = [intoFoo, ...found.fromBranch];
      found.events[30] = [];
    });
    expect(vouched()).toBeNull();
  });

  it('refuses a run of a branch that ever had a pull request into another branch, even one GitHub no longer lists with that head', () => {
    // Its head moved on, or GitHub's commit-to-pull-request answer left it out:
    // the branch's own list still has it.
    pullRequestRun(tree, head, (found) => {
      const intoFoo: Pull = { number: 30, head: { sha: 'd'.repeat(40), ref: 'x', repo: { id: 42 } }, base: { ref: 'foo', repo: { id: 42 } } };
      found.fromBranch = [intoFoo, ...found.fromBranch];
      found.events[30] = [];
    });
    expect(vouched()).toBeNull();
  });

  it('refuses a run of a branch one of whose other pull requests had its base changed', () => {
    pullRequestRun(tree, head, (found) => {
      const earlier: Pull = { number: 29, head: { sha: 'd'.repeat(40), ref: 'x', repo: { id: 42 } }, base: { ref: 'main', repo: { id: 42 } } };
      found.fromBranch = [earlier, ...found.fromBranch];
      found.events[29] = [{ event: 'base_ref_changed' }];
    });
    expect(vouched()).toBeNull();
  });
});
