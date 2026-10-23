#!/usr/bin/env node
/**
 * What cut-release.yml checks before its `tag` job, the one that can push a
 * version tag as the releaser, may start. It runs in a job with the
 * workflow's read-only token and no secrets, and refuses, saying why, unless:
 *
 * - the run was started by hand, on main, from this repository's
 *   cut-release.yml there;
 * - whoever started it, and whoever re-ran it, is one of RELEASERS, as
 *   release-build.yml names them at main: the one list, a person-reviewed line;
 * - the `release` environment is set up as docs/development.md says: a
 *   required reviewer, every one a releaser, who may approve a run they
 *   started, and deployments from the branch main alone. A job that names an
 *   environment that does not exist makes one, with no protection at all;
 * - the version, the one given or the next patch after the newest release,
 *   is `v` and three numbers, has no tag or release yet, and passes
 *   release-build's own version check (`checkVersion`) on the commit to tag;
 * - that commit, main's head, passes release-build's own ci check
 *   (`checkCi`). A commit whose ci passed running only the docs job, because
 *   it changed only docs, built nothing, and release-build refuses it; the
 *   release's files are the build's, which docs do not change, so the commit
 *   before it is tagged in its place, and so on back, never as far as the
 *   newest release's own commit.
 *
 * None of this is what keeps the token from anyone else. A run on another
 * branch runs that branch's copy of the workflow and of this file, which can
 * skip all of it; the environment keeps its secret from every run not on
 * main, and from a run on main until its reviewer approves. What this does is
 * stop a run that release-build would refuse before it asks for that
 * approval, and say why, with release-build's own checks.
 *
 * Its git and GitHub are passed in (`tools`), as release-check.mjs's are, so
 * tests/cut-release.test.ts runs each refusal.
 */
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkCi, checkReleaser, checkVersion, newestRelease, realTools, Refusal, releasersOf, VERSION } from './release-check.mjs';

export const WORKFLOW = '.github/workflows/cut-release.yml';
export const ENVIRONMENT = 'release';
const SETUP = 'docs/development.md#the-cut-release-button';

/**
 * RELEASERS as a workflow's top-level `env` names it, as release-build.yml's
 * does. Read as text: the job runs no install, so there is no YAML parser,
 * and tests/cut-release.test.ts holds this to the YAML of release-build.yml.
 */
export function releasersIn(text) {
  let inEnv = false;
  const found = [];
  for (const line of String(text).split('\n')) {
    if (/^\s*(#|$)/.test(line)) continue;
    if (/^\S/.test(line)) inEnv = /^env:\s*(#.*)?$/.test(line);
    else if (inEnv) {
      const match = /^ {2}RELEASERS:\s*(.*?)\s*$/.exec(line);
      if (match) found.push(match[1].replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2'));
    }
  }
  if (found.length !== 1) throw new Refusal(`release-build.yml at main names RELEASERS ${found.length} times in its env, not once, so who may release cannot be told`);
  return releasersOf(found[0]);
}

/** The run: started by hand, on main, from this repository's cut-release.yml there. */
export function checkRun(ctx) {
  if (ctx.event !== 'workflow_dispatch') throw new Refusal(`cut-release runs only when started by hand, not for a ${ctx.event}`);
  if (ctx.ref !== 'refs/heads/main') throw new Refusal(`cut-release was run on ${ctx.ref}, not on main: run it again from main`);
  const workflow = `${ctx.repo}/${WORKFLOW}@refs/heads/main`;
  if (ctx.workflowRef !== workflow) throw new Refusal(`this run is of ${ctx.workflowRef}, not of ${workflow}`);
}

/** Whoever started the run, and whoever re-ran it, each one of RELEASERS. */
export function checkPeople(ctx, releasers) {
  for (const actor of new Set([ctx.actor, ctx.triggeringActor])) checkReleaser({ actor, releasers: releasers.join(',') });
}

/** Who may deploy to the environment, in words, from what GitHub says of its branch policy. */
function deployers(ctx, tools, policy) {
  if (!policy) return 'any branch or tag';
  if (policy.protected_branches) return 'any protected branch';
  const named = tools.api(`repos/${ctx.repo}/environments/${ENVIRONMENT}/deployment-branch-policies?per_page=100`).branch_policies ?? [];
  if (named.length === 1 && named[0].name === 'main' && (named[0].type ?? 'branch') === 'branch') return null;
  return named.map((one) => `the ${one.type ?? 'branch'} ${one.name}`).join(', ') || 'nothing';
}

/**
 * The environment the tag job runs in, as it must be for the token in it:
 * approved by a releaser, who may approve their own run, and for main alone.
 */
export function checkEnvironment(ctx, tools, releasers) {
  let environment;
  try {
    environment = tools.api(`repos/${ctx.repo}/environments/${ENVIRONMENT}`);
  } catch {
    throw new Refusal(`this repository has no ${ENVIRONMENT} environment, and the tag job would make one with no reviewer and no secret: set it up as ${SETUP} says`);
  }
  const review = (environment?.protection_rules ?? []).find((rule) => rule.type === 'required_reviewers');
  const reviewers = review?.reviewers ?? [];
  if (reviewers.length === 0) throw new Refusal(`the ${ENVIRONMENT} environment has no required reviewer, so its token would push a tag nobody approved: add one as ${SETUP} says`);
  for (const { type, reviewer } of reviewers) {
    if (type !== 'User' || !releasers.includes(String(reviewer?.login ?? '').toLowerCase())) {
      const who = type === 'User' ? reviewer?.login : `the team ${reviewer?.slug ?? reviewer?.name}`;
      throw new Refusal(`the ${ENVIRONMENT} environment's reviewers include ${who}, who is not one of RELEASERS but could approve a release: make its reviewers releasers alone`);
    }
  }
  if (review.prevent_self_review === true) throw new Refusal(`the ${ENVIRONMENT} environment prevents self-review, so ${ctx.triggeringActor} could not approve this run: turn Prevent self-review off`);
  const others = deployers(ctx, tools, environment.deployment_branch_policy);
  if (others) throw new Refusal(`the ${ENVIRONMENT} environment lets ${others} deploy, not the branch main alone, so another branch's workflow could read its token: set it as ${SETUP} says`);
}

/** The tag to push: the version given, with its `v`, or the next patch after the newest release. */
export function tagFor(version, newest) {
  const given = String(version ?? '').trim();
  if (!given) {
    if (!newest) throw new Refusal('there is no release yet to count the next patch from: run it again with the version to release, such as 0.1.0');
    const [major, minor, patch] = VERSION.exec(newest.tag).slice(1).map(Number);
    return `v${major}.${minor}.${patch + 1}`;
  }
  const tag = given.startsWith('v') ? given : `v${given}`;
  // Quoted: an input is anyone's text, and a line of it could read as a workflow command.
  if (!VERSION.test(tag)) throw new Refusal(`${JSON.stringify(given)} is not a version: three numbers without leading zeros or a suffix, such as 0.2.0`);
  return tag;
}

/** The version is new: no release, and no tag, a refused one included. */
export function checkUnused(ctx, tools, tag, releases) {
  if (releases.some((release) => release.tag_name === tag)) throw new Refusal(`${tag} already has a release, which is never replaced: give a higher version`);
  const refs = tools.api(`repos/${ctx.repo}/git/matching-refs/tags/${tag}`) ?? [];
  if (refs.some((ref) => ref.ref === `refs/tags/${tag}`)) {
    throw new Refusal(`${tag} is a tag already, with no release (a refused one): delete it (git push origin :refs/tags/${tag}), or give another version`);
  }
}

/**
 * Whether main's run of ci.yml for a commit passed having run the docs job in
 * place of the tests: its `changes` found nothing but docs changed. Only ever
 * a reason to try the commit before; the one tagged passes `checkCi`.
 */
export function changedOnlyDocs(ctx, tools, sha) {
  const run = (tools.api(`repos/${ctx.repo}/actions/runs?head_sha=${sha}&event=push&branch=main&per_page=100`).workflow_runs ?? [])
    .filter((one) => one.path === '.github/workflows/ci.yml' && String(one.head_repository?.id) === String(ctx.repoId) && one.head_sha === sha)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .at(-1);
  if (!run || run.status !== 'completed') return false;
  const jobs = tools.api(`repos/${ctx.repo}/actions/runs/${run.id}/jobs?per_page=100`).jobs ?? [];
  const verdict = (name) => jobs.filter((job) => job.name === name).at(-1)?.conclusion;
  return verdict('ci') === 'success' && verdict('docs') === 'success' && verdict('check') === 'skipped';
}

/** The commit to tag: main's head, or the newest commit before it that changed more than docs. */
export function commitToTag(ctx, tools, newest) {
  let sha = ctx.head;
  for (;;) {
    if (newest && sha === newest.commit) {
      throw new Refusal(
        sha === ctx.head
          ? `main's head ${sha} is ${newest.tag} already: there is nothing new to release`
          : `main has changed only docs since ${newest.tag} (${sha}): there is nothing new to release`,
      );
    }
    try {
      return { sha, ci: checkCi(ctx, tools, sha, tools.git(['rev-parse', `${sha}^{tree}`])) };
    } catch (error) {
      if (!(error instanceof Refusal) || !changedOnlyDocs(ctx, tools, sha)) throw error;
    }
    const before = tools.git(['rev-parse', `${sha}^1`]);
    tools.say(`${sha} changed only docs, so its ci built nothing and release-build would refuse it; the commit before it, ${before}, has the same build`);
    sha = before;
  }
}

/** Every check, in order; what the tag job reads. */
export function checkCut(ctx, tools) {
  checkRun(ctx);
  const releasers = releasersIn(tools.git(['show', 'refs/remotes/origin/main:.github/workflows/release-build.yml']));
  checkPeople(ctx, releasers);
  checkEnvironment(ctx, tools, releasers);
  const releases = tools.api(`repos/${ctx.repo}/releases?per_page=100`, { paginate: true });
  // Quiet: checkVersion below says which releases it passed over.
  const newest = newestRelease(ctx, { ...tools, say: () => undefined }, releases);
  const tag = tagFor(ctx.version, newest);
  checkUnused(ctx, tools, tag, releases);
  const { sha, ci } = commitToTag(ctx, tools, newest);
  checkVersion({ ...ctx, tag }, tools, sha);
  tools.say(`${tag} is to be ${sha}, after ${newest ? newest.tag : 'no release yet'}; ci passed in main's run ${ci.run} (tests in run ${ci.tested}). Approve the ${ENVIRONMENT} environment's job to push it`);
  return { tag, sha, actor: ctx.triggeringActor };
}

function contextFrom(env) {
  return {
    event: env.EVENT,
    ref: env.REF,
    workflowRef: env.WORKFLOW_REF,
    repo: env.REPO,
    repoId: env.REPO_ID,
    head: env.MAIN_HEAD,
    actor: env.ACTOR,
    triggeringActor: env.TRIGGERING_ACTOR,
    version: env.VERSION,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const env = process.env;
  const said = [];
  const tools = { ...realTools(env), say: (line) => void (said.push(line), console.log(line)) };
  // The run's page shows its summary, which is what a phone has room for.
  const summary = (lines) => env.GITHUB_STEP_SUMMARY && appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n\n')}\n`);
  try {
    const cut = checkCut(contextFrom(env), tools);
    const lines = Object.entries(cut).map(([key, value]) => `${key}=${value}\n`).join('');
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, lines);
    else process.stdout.write(lines);
    summary(said);
  } catch (error) {
    const why = `${error instanceof Error ? error.message : error}. Nothing is tagged`;
    console.error(why);
    summary([...said, `**Refused:** ${why}`]);
    process.exit(1);
  }
}
