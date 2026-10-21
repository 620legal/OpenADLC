import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  attestationCheckArgs,
  parseYamlFile,
  RELEASE_CHECKSUMS,
  RELEASE_MANIFEST,
  RELEASE_TAG,
  RELEASE_SIGNER,
  RELEASE_SIGNER_REF,
  RELEASE_TAG_FILTER,
  RELEASE_WORKFLOW,
  releaseAssets,
  releaseSignerIdentity,
} from '@openadlc/shared';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain script with no types; release-build.yml and ci.yml run it directly.
import { realTools, VERSION as CHECKED_TAG } from '../.github/scripts/release-check.mjs';

/**
 * Who may write, among this repository's workflows, and how a release is
 * made.
 *
 * `ci.yml` runs on every pull request, a fork's among them, and on every crew
 * branch: its token is read-only, and its header says why ("Workflows hold no
 * secrets and can write nothing"). Publishing a release needs `contents:
 * write`, `id-token: write` and `attestations: write`; in ci.yml, any pull
 * request's run could have published one, or signed what every install's
 * self-update trusts.
 *
 * A tag push runs the `release.yml` of the commit it tags, which can be any
 * commit anyone could push. So `release.yml` does nothing but call
 * `release-build.yml` at main, and only that reusable workflow, always main's,
 * checks, builds and signs: its identity is what installs verify. These fail
 * when release.yml does anything else, when the job that signs runs anything
 * from the repository or from what the build made, and when any workflow
 * writes more than it is listed for here.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = join(ROOT, '.github', 'workflows');

type Permissions = Record<string, string> | string | null | undefined;

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}

interface Job {
  permissions?: Permissions;
  outputs?: Record<string, string>;
  steps?: Step[];
  needs?: string | string[];
  uses?: string;
  with?: unknown;
  secrets?: unknown;
}

interface Workflow {
  on: Record<string, unknown>;
  permissions?: Permissions;
  env?: Record<string, string>;
  jobs: Record<string, Job>;
}

function workflow(name: string): Workflow {
  return parseYamlFile(join(WORKFLOWS, name)) as Workflow;
}

const FILES = readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name));

/** Every scope a permissions block writes, `write-all` included. */
function writes(permissions: Permissions): string[] {
  if (permissions === undefined || permissions === null) return [];
  if (typeof permissions === 'string') return permissions === 'write-all' ? ['write-all'] : [];
  return Object.entries(permissions)
    .filter(([, level]) => level === 'write')
    .map(([scope]) => scope);
}

/** What each workflow may write, all its jobs together. Anything else is a new decision, made here. */
const ALLOWED_WRITES: Record<string, string[]> = {
  'ci.yml': [],
  'deploy-testing.yml': ['deployments'],
  'promote-production.yml': ['deployments'],
  'rollback-production.yml': [],
  'smoke-testing.yml': [],
  'release.yml': ['contents', 'id-token', 'attestations'],
  'release-build.yml': ['contents', 'id-token', 'attestations'],
};

/** Whether a step runs the repository's own code: a checkout, its scripts, its install or its build. */
function runsTheRepository(step: Step): boolean {
  if (step.uses?.startsWith('actions/checkout@')) return true;
  return /\b(pnpm|npm|npx|node|make)\b/.test(step.run ?? '');
}

/** The programs a shell script runs: the first word of each simple command, quoted text left out. */
function commandsOf(script: string): string[] {
  const text = script
    .replace(/(^|\s)#[^\n]*/g, '$1')
    .replace(/\\\n/g, ' ')
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const keywords = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'for', '!', '{', '}']);
  const commands: string[] = [];
  for (const piece of text.split(/\n|;|&&|\|\||\||\$\(|<\(|\(|\)|`/)) {
    const words = piece.trim().split(/\s+/).filter(Boolean);
    // `for name in words`: the words are not commands.
    if (words[0] === 'for') continue;
    while (words.length > 0 && (keywords.has(words[0]!) || /^\w+=/.test(words[0]!))) words.shift();
    if (words[0]) commands.push(words[0]);
  }
  return commands;
}

/**
 * The programs the job that signs may run. The archive and the bundle are
 * only hashed, copied, signed and uploaded: anything else, an interpreter, a
 * shell given a script, or a file of the artifact run by its path, would run
 * what the build made with the power to sign it.
 */
const PUBLISH_COMMANDS = new Set(['[', 'cp', 'echo', 'exit', 'gh', 'printf', 'read', 'sha256sum', 'tr', 'wc']);

function runsTheArtifact(step: Step): boolean {
  return commandsOf(step.run ?? '').some((command) => !PUBLISH_COMMANDS.has(command));
}

/** What is wrong with a workflow's permissions: none said, or a write it is not listed for. */
function permissionProblems(file: string, found: Workflow): string[] {
  const problems: string[] = [];
  if (found.permissions === undefined) problems.push(`${file} has no permissions block, so it gets the repository's default token`);
  const allowed = ALLOWED_WRITES[file];
  if (!allowed) problems.push(`${file} is not in ALLOWED_WRITES`);
  const scopes = new Set([found.permissions, ...Object.values(found.jobs).map((job) => job.permissions)].flatMap(writes));
  for (const scope of scopes) if (!allowed?.includes(scope)) problems.push(`${file} writes ${scope}`);
  return problems;
}

describe('every workflow', () => {
  it.each(FILES)('%s says what it may do, and writes nothing it is not listed for', (file) => {
    expect(permissionProblems(file, workflow(file))).toEqual([]);
  });

  it('is caught with no permissions block, or a write it is not listed for', () => {
    // The check above, on altered copies: a check that cannot fail checks nothing.
    const ci = workflow('ci.yml');
    const { permissions: _dropped, ...bare } = ci;
    expect(permissionProblems('ci.yml', bare as Workflow)).toEqual(["ci.yml has no permissions block, so it gets the repository's default token"]);
    expect(permissionProblems('ci.yml', { ...ci, permissions: { ...(ci.permissions as Record<string, string>), packages: 'write' } })).toEqual(['ci.yml writes packages']);
    const release = workflow('release-build.yml');
    const publish = release.jobs.publish!;
    expect(
      permissionProblems('release-build.yml', { ...release, jobs: { ...release.jobs, publish: { ...publish, permissions: { ...(publish.permissions as Record<string, string>), packages: 'write' } } } }),
    ).toEqual(['release-build.yml writes packages']);
    expect(permissionProblems('new.yml', { on: {}, permissions: {}, jobs: {} })).toEqual(['new.yml is not in ALLOWED_WRITES']);
  });
});

describe('ci.yml', () => {
  const ci = workflow('ci.yml');

  it('reads the contents and writes nothing', () => {
    expect(ci.permissions).toMatchObject({ contents: 'read' });
    expect(writes(ci.permissions)).toEqual([]);
  });

  it('gives no job a permission of its own, so the read-only token is every job’s', () => {
    for (const [name, job] of Object.entries(ci.jobs)) expect(job.permissions, name).toBeUndefined();
  });

  it('skips the tests on a push to main only for a tree a pull request’s run into main vouches for', () => {
    // `vouchedRun` in .github/scripts/release-check.mjs, tested in tests/release-check.test.ts.
    const tested = (ci.jobs.changes?.steps ?? []).find((step) => step.name === 'already passed on its pull request');
    expect(tested?.run?.trim()).toBe('node .github/scripts/release-check.mjs vouched');
  });
});

describe('release.yml', () => {
  const release = workflow('release.yml');

  it('runs only when a version tag is pushed: no branch, no pull request, nothing started by hand', () => {
    expect(Object.keys(release.on)).toEqual(['push']);
    expect(release.on.push).toEqual({ tags: ['v[0-9]+.[0-9]+.[0-9]+'] });
  });

  it('does nothing but call release-build.yml at main, passing it nothing', () => {
    expect(release.permissions).toEqual({});
    expect(Object.keys(release.jobs)).toEqual(['release']);
    const job = release.jobs.release!;
    expect(job.uses).toBe('620legal/OpenADLC/.github/workflows/release-build.yml@main');
    expect(job.steps).toBeUndefined();
    expect(job.with).toBeUndefined();
    expect(job.secrets).toBeUndefined();
    expect(job.permissions).toEqual({ contents: 'write', actions: 'read', 'pull-requests': 'read', issues: 'read', 'id-token': 'write', attestations: 'write' });
  });
});

describe('release-build.yml', () => {
  const build = workflow('release-build.yml');

  it('is only ever called, and takes no inputs and no secrets', () => {
    expect(Object.keys(build.on)).toEqual(['workflow_call']);
    expect(build.on.workflow_call ?? {}).toEqual({});
  });

  it('gives nothing by default, and each job only what it names', () => {
    expect(build.permissions).toEqual({});
    for (const [name, job] of Object.entries(build.jobs)) expect(job.permissions, name).toBeTypeOf('object');
  });

  it('writes and signs only from publish, which runs nothing from the repository or the build', () => {
    const writing = Object.entries(build.jobs)
      .filter(([, job]) => writes(job.permissions).length > 0)
      .map(([name]) => name);
    expect(writing).toEqual(['publish']);
    expect(build.jobs.publish?.permissions).toEqual({ contents: 'write', 'id-token': 'write', attestations: 'write' });
    const steps = build.jobs.publish?.steps ?? [];
    expect(steps.filter(runsTheRepository)).toEqual([]);
    expect(steps.filter(runsTheArtifact)).toEqual([]);
  });

  it('is caught when publish would run what the build made', () => {
    for (const run of ['bash out/post.sh', 'cd out && ./post.sh', 'sh -c "$(cat out/x)"', 'out/post.sh', '. out/env', 'node out/x.js', 'tar -xzf out/a.tar.gz']) {
      expect(runsTheArtifact({ run }), run).toBe(true);
    }
    for (const run of ['sha256sum -c SHA256SUMS', 'cp "$BUNDLE" "out/x.sigstore.json"', 'gh release create "$TAG" out/SHA256SUMS']) {
      expect(runsTheArtifact({ run }), run).toBe(false);
    }
    // And it reads publish's own scripts, rather than finding nothing in them.
    const publish = (workflow('release-build.yml').jobs.publish?.steps ?? []).map((step) => step.run ?? '').join('\n');
    expect(new Set(commandsOf(publish))).toEqual(new Set(['[', 'echo', 'exit', 'printf', 'tr', 'sha256sum', 'cp', 'gh', 'read']));
  });

  it('builds with a read-only token, once the tag is checked', () => {
    expect(build.jobs.check?.permissions).toEqual({ contents: 'read', actions: 'read', 'pull-requests': 'read', issues: 'read' });
    expect(build.jobs.build?.permissions).toEqual({ contents: 'read' });
    expect(build.jobs.build?.needs).toBe('check');
    expect(build.jobs.publish?.needs).toEqual(['check', 'build']);
  });

  it('leaves no credential in a checkout, and builds without a cache', () => {
    for (const [name, job] of Object.entries(build.jobs)) {
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith('actions/checkout@')) expect(step.with?.['persist-credentials'], name).toBe(false);
        if (step.uses?.startsWith('actions/setup-node@')) {
          expect(step.with?.['package-manager-cache'], name).toBe(false);
          expect(step.with?.cache, name).toBeUndefined();
        }
      }
    }
  });

  it('runs main’s copy of the checks, with the run’s own context, before anything is built', () => {
    const steps = build.jobs.check?.steps ?? [];
    const check = steps.find((step) => step.run?.includes('release-check.mjs'));
    expect(check?.run).toBe(
      'git show refs/remotes/origin/main:.github/scripts/release-check.mjs > "$RUNNER_TEMP/release-check.mjs"\nnode "$RUNNER_TEMP/release-check.mjs" check\n',
    );
    expect(check?.env).toEqual({
      EVENT: '${{ github.event_name }}',
      REF: '${{ github.ref }}',
      REF_TYPE: '${{ github.ref_type }}',
      TAG: '${{ github.ref_name }}',
      CALLER: '${{ github.workflow_ref }}',
      REPO: '${{ github.repository }}',
      REPO_ID: '${{ github.repository_id }}',
      PUSHED: '${{ github.sha }}',
      ACTOR: '${{ github.triggering_actor }}',
      GH_TOKEN: '${{ github.token }}',
    });
    // The releasers are named here, in a reviewed file, and nothing reads CODEOWNERS.
    expect(build.env?.RELEASERS).toBe('orzelig');
    expect(readFileSync(join(WORKFLOWS, 'release-build.yml'), 'utf8')).not.toMatch(/CODEOWNERS/);
    expect(build.jobs.check?.outputs).toMatchObject({ actor: '${{ steps.check.outputs.actor }}' });
  });

  it('runs one release at a time, whatever the tag', () => {
    expect((workflow('release.yml') as unknown as { concurrency: unknown }).concurrency).toEqual({ group: 'release', 'cancel-in-progress': false });
  });
});

/**
 * The steps of `build` and `publish` that refuse, run as GitHub runs them
 * (bash -eo pipefail) with a stand-in `gh` that answers from the
 * environment and writes down what it was asked.
 */
describe('publish and build, run', () => {
  const build = workflow('release-build.yml');
  const step = (job: string, name: string) => {
    const found = (build.jobs[job]?.steps ?? []).find((one) => one.name === name);
    if (!found?.run) throw new Error(`${job} has no step ${name}`);
    return found.run;
  };

  function run(script: string, env: Record<string, string>): { status: number | null; asked: string } {
    const bin = mkdtempSync(join(tmpdir(), 'release-steps-'));
    try {
      const gh = join(bin, 'gh');
      writeFileSync(
        gh,
        [
          '#!/bin/bash',
          'echo "$*" >> "$GH_LOG"',
          'case "$1 $2" in',
          '  "api repos/acme/openadlc/git/ref/tags/v0.2.0") echo "$TAG_OBJECT" ;;',
          '  "api repos/acme/openadlc/releases/tags/v0.2.0") echo "$IMMUTABLE" ;;',
          'esac',
          'exit 0',
        ].join('\n'),
      );
      chmodSync(gh, 0o755);
      const log = join(bin, 'asked');
      writeFileSync(log, '');
      const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
        env: { PATH: `${bin}:${process.env.PATH}`, GH_LOG: log, REPO: 'acme/openadlc', TAG: 'v0.2.0', SHA: 'a'.repeat(40), RELEASERS: build.env?.RELEASERS ?? '', ...env },
        encoding: 'utf8',
      });
      return { status: result.status, asked: readFileSync(log, 'utf8') };
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  }

  it.each([
    ['build', 'the run is still the releaser’s'.replace('’', "'")],
    ['publish', "the run is still a releaser's"],
  ])('%s refuses a re-run by anyone but the releaser check let through', (job, name) => {
    const script = step(job, name);
    expect(run(script, { ACTOR: 'orzelig', CHECKED: 'orzelig' }).status).toBe(0);
    expect(run(script, { ACTOR: 'openadlc-atlas-orzelig', CHECKED: 'orzelig' }).status).not.toBe(0);
    expect(run(script, { ACTOR: 'orzelig', CHECKED: '' }).status).not.toBe(0);
  });

  it('publish asks the releasers again, so a re-run of it alone cannot sign for another', () => {
    const script = step('publish', "the run is still a releaser's");
    expect(run(script, { ACTOR: 'OrZelig', CHECKED: 'OrZelig' }).status).toBe(0);
    expect(run(script, { ACTOR: 'someone', CHECKED: 'someone' }).status).not.toBe(0);
  });

  it('publish refuses a tag that moved since it was checked', () => {
    const script = step('publish', 'the tag is still on the commit that was checked');
    expect(run(script, { TAG_OBJECT: `commit ${'a'.repeat(40)}` }).status).toBe(0);
    expect(run(script, { TAG_OBJECT: `commit ${'b'.repeat(40)}` }).status).not.toBe(0);
  });

  it('publish deletes a release that came out mutable, and fails', () => {
    const script = step('publish', 'the release');
    const kept = run(script, { IMMUTABLE: 'true' });
    expect(kept.status).toBe(0);
    expect(kept.asked).toContain('release create v0.2.0 --repo acme/openadlc --verify-tag');
    expect(kept.asked).not.toContain('release delete');
    const mutable = run(script, { IMMUTABLE: 'false' });
    expect(mutable.status).not.toBe(0);
    expect(mutable.asked).toContain('release delete v0.2.0 --repo acme/openadlc --yes');
  });
});

/**
 * The attestation check is written three times: in publish, which runs it on
 * the release's own bundle before creating it; in the docs, for a person; and
 * in release-check.mjs, which counts only releases that pass it. They must be
 * the same check.
 */
describe('the attestation check, everywhere it is written', () => {
  /** A shell command's words: continuation lines joined, quotes taken off. */
  const words = (command: string) => command.replace(/\\\n/g, ' ').split(/\s+/).filter(Boolean).map((word) => word.replace(/^"|"$/g, ''));
  const flags = (args: string[]) => args.slice(args.indexOf('--bundle') + 2);

  it('is the same flags in publish, in the docs, and in the version count', () => {
    const publish = (workflow('release-build.yml').jobs.publish?.steps ?? []).map((one) => one.run ?? '').join('\n');
    const inPublish = words(publish.slice(publish.indexOf('gh attestation verify'), publish.indexOf('\n', publish.indexOf('--predicate-type'))));
    const docs = readFileSync(join(ROOT, 'docs', 'self-hosting.md'), 'utf8');
    const start = docs.indexOf('gh attestation verify "openadlc-$tag.tar.gz"');
    expect(start).toBeGreaterThan(-1);
    const inDocs = words(docs.slice(start, docs.indexOf('\n', docs.indexOf('--predicate-type', start))));
    const asked: string[][] = [];
    realTools({ REPO: '$REPO' }, (command: string, args: string[]) => {
      asked.push([command, ...args]);
      return '';
    }).verifyRelease({ tag: '$TAG', commit: '$SHA' });
    const inCount = asked.find((args) => args[1] === 'attestation') ?? [];
    const placeholders = (args: string[]) =>
      args.map((word) => word.replace('620legal/OpenADLC', '$REPO').replace(/\$tag/g, '$TAG').replace('$commit', '$SHA'));
    expect(flags(inPublish)).toEqual([
      '--repo',
      '$REPO',
      '--cert-identity',
      'https://github.com/$REPO/.github/workflows/release-build.yml@refs/heads/main',
      '--source-ref',
      'refs/tags/$TAG',
      '--source-digest',
      '$SHA',
      '--deny-self-hosted-runners',
      '--predicate-type',
      'https://slsa.dev/provenance/v1',
    ]);
    expect(placeholders(flags(inDocs))).toEqual(flags(inPublish));
    expect(flags(inCount)).toEqual(flags(inPublish));
  });
});

describe('the other workflows', () => {
  it('never sign an attestation', () => {
    for (const file of FILES.filter((name) => name !== 'release.yml' && name !== 'release-build.yml')) {
      const found = workflow(file);
      const scopes = [found.permissions, ...Object.values(found.jobs).map((job) => job.permissions)].flatMap(writes);
      expect(scopes, file).not.toContain('attestations');
      expect(scopes, file).not.toContain('id-token');
    }
  });

  it('call no workflow of this repository but release-build.yml, and only from release.yml', () => {
    for (const file of FILES) {
      const text = readFileSync(join(WORKFLOWS, file), 'utf8');
      const calls = [...text.matchAll(/^\s*uses:\s*(620legal\/OpenADLC\/\S+)/gm)].map((match) => match[1]);
      expect(calls, file).toEqual(file === 'release.yml' ? ['620legal/OpenADLC/.github/workflows/release-build.yml@main'] : []);
    }
  });
});

/**
 * The contract between release-build.yml and self-update
 * (docs/self-hosting.md#what-a-release-holds), read from both. Self-update
 * takes its names from `packages/shared/src/self-update.ts`; a workflow that
 * renamed a file, or checked the attestation another way, would publish
 * releases every install refused, and say nothing.
 */
describe('a release, as release-build.yml makes it and self-update takes it', () => {
  const release = workflow('release.yml');
  const build = workflow('release-build.yml');
  const scripts = (job: string) => (build.jobs[job]?.steps ?? []).map((step) => step.run ?? '').join('\n');
  /** A shell command's words: continuation lines joined, quotes taken off. */
  const words = (command: string) => command.replace(/\\\n/g, ' ').split(/\s+/).filter(Boolean).map((word) => word.replace(/^"|"$/g, ''));

  it('is signed by the workflow whose identity an install trusts, for the tags it takes', () => {
    expect(FILES).toContain(RELEASE_WORKFLOW.split('/').at(-1));
    expect(FILES).toContain(RELEASE_SIGNER.split('/').at(-1));
    expect(release.jobs.release?.uses).toBe(`620legal/OpenADLC/${RELEASE_SIGNER}@${RELEASE_SIGNER_REF.replace('refs/heads/', '')}`);
    expect(release.on.push).toEqual({ tags: [RELEASE_TAG_FILTER] });
    // The tags the workflow's checks accept are the ones self-update takes.
    for (const tag of ['v0.2.0', 'v10.0.1', 'v01.2.0', 'v0.2.0-rc.1', 'v0.2', '0.2.0']) expect(CHECKED_TAG.test(tag), tag).toBe(RELEASE_TAG.test(tag));
  });

  it('names its files and its manifest as self-update reads them', () => {
    const names = releaseAssets('$TAG');
    const made = scripts('build');
    expect(made).toContain(`"out/${names.archive}"`);
    expect(made).toContain(`> ${RELEASE_CHECKSUMS}`);
    expect(made).toContain(`'{"format":1,"tag":"%s","commit":"%s","tree":"%s"}\\n' "$TAG" "$SHA" "$TREE" > ${RELEASE_MANIFEST}`);
    expect(made).toContain(`-czf "out/${names.archive}" ${RELEASE_MANIFEST} $roots`);
    expect(scripts('publish')).toContain(
      `gh release create "$TAG" --repo "$REPO" --verify-tag --title "$TAG" --generate-notes \\\n  "out/${names.archive}" "out/${names.bundle}" out/${RELEASE_CHECKSUMS}`,
    );
  });

  it('checks the attestation with the very command self-update runs, before it publishes', () => {
    const publish = scripts('publish');
    const command = publish.slice(publish.indexOf('gh attestation verify'), publish.indexOf('\n', publish.indexOf('--predicate-type')));
    const names = releaseAssets('$TAG');
    expect(words(command).slice(1)).toEqual(
      attestationCheckArgs({ archive: `out/${names.archive}`, bundle: `out/${names.bundle}`, repo: '$REPO', tag: '$TAG', commit: '$SHA' }),
    );
    expect(releaseSignerIdentity('$REPO')).toBe('https://github.com/$REPO/.github/workflows/release-build.yml@refs/heads/main');
  });

  it('is the command the docs give a person', () => {
    const docs = readFileSync(join(ROOT, 'docs', 'self-hosting.md'), 'utf8');
    const start = docs.indexOf('gh attestation verify "openadlc-$tag.tar.gz"');
    expect(start).toBeGreaterThan(-1);
    const command = docs.slice(start, docs.indexOf('\n', docs.indexOf('--predicate-type', start)));
    expect(words(command).slice(1)).toEqual(
      attestationCheckArgs({ archive: 'openadlc-$tag.tar.gz', bundle: 'openadlc-$tag.tar.gz.sigstore.json', repo: '620legal/OpenADLC', tag: '$tag', commit: '$commit' }),
    );
  });
});
