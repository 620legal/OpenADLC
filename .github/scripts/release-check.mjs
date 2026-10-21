#!/usr/bin/env node
/**
 * What release-build.yml checks before it builds a release, and what ci.yml
 * reads to skip the tests on a push to main that a pull request already ran.
 *
 * `check`: release-build.yml runs main's copy of this file (`git show
 * refs/remotes/origin/main:…`, never the tagged commit's checkout) for the push
 * of a version tag. It refuses, saying why, unless:
 *
 * - the run is the push of a version tag, from this repository's release.yml,
 *   onto the commit the run is for;
 * - the tag is on one of main's first parents;
 * - the person who pushed it, or re-ran it, is one of RELEASERS, which
 *   release-build.yml itself names, a file a person must approve;
 * - the version is above every release this workflow made (immutable, and
 *   passing the same attestation check an install makes), and the newest of
 *   those is among the tagged commit's first parents; a release anyone else
 *   created, `v999.0.0` say, is passed over rather than counted;
 * - the tag has no release yet;
 * - ci.yml's own run for the push of that commit to main passed, having run the
 *   tests itself, or having skipped them for a pull request's run into main
 *   that `vouchedRun` accepts and that ran them.
 *
 * `vouched`: ci.yml's push to main asks whether a pull request's run already
 * tested this exact tree. Only a run of ci.yml for a pull request of this
 * repository into main, whose base never changed, that passed with its tests
 * run, counts. A pull request into another branch runs that branch's ci.yml,
 * which anyone who can push could have written, and could vouch for anything.
 *
 * Runs with the workflow's read-only token and no secrets. Its git and GitHub
 * are passed in (`tools`), so tests/release-check.test.ts can run each refusal.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export class Refusal extends Error {}

export const VERSION = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function versionOf(tag) {
  const match = VERSION.exec(tag);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** The logins RELEASERS names: comma- or space-separated, case as GitHub ignores it. */
export function releasersOf(value) {
  return String(value ?? '')
    .split(/[\s,]+/)
    .map((login) => login.replace(/^@/, '').trim().toLowerCase())
    .filter(Boolean);
}

/** The run itself: a version tag's push, from this repository's release.yml. */
export function checkRun(ctx) {
  if (ctx.event !== 'push' || ctx.refType !== 'tag' || ctx.ref !== `refs/tags/${ctx.tag}`) {
    throw new Refusal(`release-build runs only for the push of a version tag, not for a ${ctx.event} of ${ctx.ref}`);
  }
  if (!VERSION.test(ctx.tag)) throw new Refusal(`${ctx.tag} is not a version tag: v and three numbers without leading zeros, such as v0.2.0`);
  const caller = `${ctx.repo}/.github/workflows/release.yml@refs/tags/${ctx.tag}`;
  if (ctx.caller !== caller) throw new Refusal(`release-build was called by ${ctx.caller}, not by ${caller}`);
}

/** Whoever pushed the tag, or re-ran the run, is a releaser. */
export function checkReleaser(ctx) {
  const releasers = releasersOf(ctx.releasers);
  if (!releasers.includes(String(ctx.actor ?? '').toLowerCase())) {
    throw new Refusal(`${ctx.actor} is not one of RELEASERS in release-build.yml (${releasers.join(', ') || 'nobody'}), so cannot release`);
  }
}

/** The tag's commit: the one pushed, and one of main's first parents. */
export function checkCommit(ctx, tools) {
  const sha = tools.git(['rev-parse', `refs/tags/${ctx.tag}^{commit}`]);
  if (sha !== tools.git(['rev-parse', `${ctx.pushed}^{commit}`])) {
    throw new Refusal(`${ctx.tag} points at ${sha} now, not at ${ctx.pushed}, which is what this run is for; push the tag again`);
  }
  // First parents: a commit a merge brought in is not a state of main. The
  // earlier commits of a rebased pull request are first parents, but have no
  // run of ci on main of their own, which `checkCi` refuses.
  if (!tools.git(['rev-list', '--first-parent', 'refs/remotes/origin/main']).split('\n').includes(sha)) {
    throw new Refusal(`${ctx.tag} is on ${sha}, which is not one of main's first parents; delete the tag and tag a commit of main`);
  }
  return { sha, tree: tools.git(['rev-parse', `${sha}^{tree}`]) };
}

/**
 * Versions only go up, along main, counted from the releases this workflow
 * made: each immutable release, newest first, until one passes the
 * attestation check an install makes.
 */
export function checkVersion(ctx, tools, sha) {
  const releases = tools.api(`repos/${ctx.repo}/releases?per_page=100`, { paginate: true });
  if (releases.some((release) => release.tag_name === ctx.tag)) {
    throw new Refusal(`${ctx.tag} already has a release, which is never replaced; tag the next version`);
  }
  const counted = releases
    .filter((release) => !release.draft && !release.prerelease && release.immutable === true && versionOf(release.tag_name))
    .sort((a, b) => compareVersions(versionOf(b.tag_name), versionOf(a.tag_name)));
  const passedOver = releases.filter((release) => !counted.includes(release) && versionOf(release.tag_name)).map((release) => release.tag_name);
  let newest = null;
  for (const release of counted) {
    let commit;
    try {
      commit = tools.git(['rev-parse', '-q', '--verify', `refs/tags/${release.tag_name}^{commit}`]);
    } catch {
      passedOver.push(release.tag_name);
      continue;
    }
    if (tools.verifyRelease({ tag: release.tag_name, commit })) {
      newest = { tag: release.tag_name, commit };
      break;
    }
    passedOver.push(release.tag_name);
  }
  if (passedOver.length > 0) tools.say(`not counted, as releases this workflow did not make: ${passedOver.join(', ')}`);
  if (!newest) return null;
  if (compareVersions(versionOf(ctx.tag), versionOf(newest.tag)) <= 0) {
    throw new Refusal(`${ctx.tag} is not above ${newest.tag}, the newest release; tag a higher version`);
  }
  if (!tools.git(['rev-list', '--first-parent', sha]).split('\n').includes(newest.commit)) {
    throw new Refusal(`${newest.tag} (${newest.commit}) is not one of ${ctx.tag}'s first parents on main`);
  }
  return newest;
}

function ranTheTests(ctx, tools, runId) {
  const jobs = tools.api(`repos/${ctx.repo}/actions/runs/${runId}/jobs?per_page=100`).jobs ?? [];
  return jobs.filter((job) => job.name === 'check').at(-1)?.conclusion ?? null;
}

/**
 * A pull request's run of ci.yml that tested this tree, into main, with its
 * tests run; null when there is none.
 *
 * Nothing in a run names the pull request it ran for once that has merged (its
 * `pull_requests` is empty then), and a pull request into another branch runs
 * that branch's ci.yml, which anyone who can push can write. Two pull requests
 * can share a head: one into a branch whose fake ci.yml uploads the tree's
 * artifact, and one into main. So the run is tied to its pull request by its
 * head branch as well as its head commit, and every pull request ever opened
 * from that branch must be into main, and none of them may have had its base
 * changed: otherwise the run may have been the other one's.
 */
export function vouchedRun(ctx, tools, tree) {
  const artifacts = tools.api(`repos/${ctx.repo}/actions/artifacts?name=tested-tree-${tree}&per_page=100`).artifacts ?? [];
  for (const artifact of artifacts) {
    const runId = artifact.workflow_run?.id;
    if (!runId || String(artifact.workflow_run?.head_repository_id) !== String(ctx.repoId)) continue;
    const run = tools.api(`repos/${ctx.repo}/actions/runs/${runId}`);
    if (run.event !== 'pull_request' || run.conclusion !== 'success' || run.path !== '.github/workflows/ci.yml') continue;
    if (String(run.head_repository?.id) !== String(ctx.repoId)) continue;
    if (tools.api(`repos/${ctx.repo}/git/commits/${run.head_sha}`).tree?.sha !== tree) continue;
    if (!run.head_branch) continue;
    const intoMain = (pull) => pull.base?.ref === 'main' && String(pull.base?.repo?.id) === String(ctx.repoId);
    const ofThisRun = tools
      .api(`repos/${ctx.repo}/commits/${run.head_sha}/pulls`)
      .filter((pull) => pull.head?.sha === run.head_sha && pull.head?.ref === run.head_branch && String(pull.head?.repo?.id) === String(ctx.repoId));
    if (ofThisRun.length === 0 || !ofThisRun.every(intoMain)) continue;
    const owner = ctx.repo.split('/')[0];
    const fromBranch = tools.api(`repos/${ctx.repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${run.head_branch}`)}&per_page=100`, { paginate: true });
    if (fromBranch.length === 0 || !fromBranch.every(intoMain)) continue;
    const moved = fromBranch.some((pull) =>
      tools.api(`repos/${ctx.repo}/issues/${pull.number}/events?per_page=100`, { paginate: true }).some((event) => event.event === 'base_ref_changed'),
    );
    if (moved) continue;
    if (ranTheTests(ctx, tools, runId) !== 'success') continue;
    return runId;
  }
  return null;
}

/**
 * ci.yml's own run for the push of this commit to main, passed, with its
 * tests run there or in a pull request's run `vouchedRun` accepts. A tag
 * pushed straight after its merge comes before that run has ended, so this
 * waits for it.
 */
export function checkCi(ctx, tools, sha, tree) {
  let state = 'missing';
  for (let attempt = 0; attempt < (ctx.ciAttempts ?? 60); attempt += 1) {
    if (attempt > 0) tools.sleep(ctx.ciWaitMs ?? 30_000);
    const runs = (tools.api(`repos/${ctx.repo}/actions/runs?head_sha=${sha}&event=push&branch=main&per_page=100`).workflow_runs ?? [])
      .filter((run) => run.path === '.github/workflows/ci.yml' && String(run.head_repository?.id) === String(ctx.repoId) && run.head_sha === sha)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const run = runs.at(-1);
    if (!run) {
      state = 'missing';
      continue;
    }
    if (run.status !== 'completed') {
      state = 'running';
      continue;
    }
    // The next push to main cancels a run still going, so a commit merged just
    // before another can have none that finished.
    if (run.conclusion === 'cancelled') throw new Refusal(`main's ci for ${sha} was cancelled (run ${run.id}): re-run it, then push the tag again`);
    const jobs = tools.api(`repos/${ctx.repo}/actions/runs/${run.id}/jobs?per_page=100`).jobs ?? [];
    const verdict = jobs.filter((job) => job.name === 'ci').at(-1)?.conclusion ?? 'without a ci job';
    if (verdict !== 'success') throw new Refusal(`ci ended ${verdict} on ${sha} in main's run ${run.id}`);
    const tests = jobs.filter((job) => job.name === 'check').at(-1)?.conclusion ?? null;
    if (tests === 'success') return { run: run.id, tested: run.id };
    if (tests === 'skipped') {
      const vouched = vouchedRun(ctx, tools, tree);
      if (vouched) return { run: run.id, tested: vouched };
      throw new Refusal(`main's run ${run.id} of ci on ${sha} skipped the tests, and no pull request's run into main that ran them vouches for its tree`);
    }
    throw new Refusal(`main's run ${run.id} of ci on ${sha} did not run the tests (check: ${tests ?? 'none'}); tag a commit whose ci built and tested it`);
  }
  throw new Refusal(`ci has not passed on ${sha} in a run on main (it is ${state}); re-run this workflow once it has`);
}

/** Every check, in order; what release-build.yml's later jobs read. */
export function checkRelease(ctx, tools) {
  checkRun(ctx);
  checkReleaser(ctx);
  const { sha, tree } = checkCommit(ctx, tools);
  const newest = checkVersion(ctx, tools, sha);
  const ci = checkCi(ctx, tools, sha, tree);
  tools.say(`${ctx.tag} is ${sha}, after ${newest ? newest.tag : 'no release yet'}; ci passed in main's run ${ci.run} (tests in run ${ci.tested})`);
  return { sha, tree, actor: ctx.actor };
}

/** The real tools: git in the checkout, gh with the workflow's token. */
export function realTools(env = process.env, exec = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env })) {
  const run = (command, args) => String(exec(command, args)).trim();
  return {
    git: (args) => run('git', args),
    api: (path, { paginate = false } = {}) => {
      const out = JSON.parse(run('gh', ['api', ...(paginate ? ['--paginate', '--slurp'] : []), path]) || 'null');
      return paginate ? out.flat() : out;
    },
    verifyRelease: ({ tag, commit }) => {
      const dir = mkdtempSync(join(tmpdir(), 'release-'));
      try {
        const archive = `openadlc-${tag}.tar.gz`;
        run('gh', ['release', 'download', tag, '--repo', env.REPO, '--dir', dir, '--pattern', archive, '--pattern', `${archive}.sigstore.json`]);
        run('gh', [
          'attestation', 'verify', join(dir, archive),
          '--bundle', join(dir, `${archive}.sigstore.json`),
          '--repo', env.REPO,
          '--cert-identity', `https://github.com/${env.REPO}/.github/workflows/release-build.yml@refs/heads/main`,
          '--source-ref', `refs/tags/${tag}`,
          '--source-digest', commit,
          '--deny-self-hosted-runners',
          '--predicate-type', 'https://slsa.dev/provenance/v1',
        ]);
        return true;
      } catch {
        return false;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
    say: (line) => console.log(line),
  };
}

function contextFrom(env) {
  return {
    event: env.EVENT,
    ref: env.REF,
    refType: env.REF_TYPE,
    tag: env.TAG,
    caller: env.CALLER,
    repo: env.REPO,
    repoId: env.REPO_ID,
    pushed: env.PUSHED,
    actor: env.ACTOR,
    releasers: env.RELEASERS,
  };
}

function output(env, values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join('');
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, lines);
  else process.stdout.write(lines);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const env = process.env;
  const command = process.argv[2];
  if (command === 'check') {
    try {
      output(env, checkRelease(contextFrom(env), realTools(env)));
    } catch (error) {
      console.error(`${error instanceof Error ? error.message : error}. Nothing is published`);
      process.exit(1);
    }
  } else if (command === 'vouched') {
    // Never fails ci: a lookup that cannot be made runs the tests.
    let tested = false;
    try {
      const run = vouchedRun({ repo: env.REPO, repoId: env.REPO_ID }, realTools(env), env.TREE);
      tested = run !== null;
      if (tested) console.log(`tree ${env.TREE} passed in full in pull request run ${run} into main; nothing to run again`);
    } catch (error) {
      console.log(`could not tell whether a pull request already tested ${env.TREE} (${error instanceof Error ? error.message : error}); running the tests`);
    }
    output(env, { tested });
  } else {
    console.error('usage: release-check.mjs check | vouched');
    process.exit(2);
  }
}
