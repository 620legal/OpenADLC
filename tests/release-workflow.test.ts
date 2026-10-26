import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  attestationCheckArgs,
  imageAttestationCheckArgs,
  imageAttestationsUrl,
  parseYamlFile,
  RELEASE_CHECKSUMS,
  RELEASE_MANIFEST,
  RELEASE_TAG,
  RELEASE_SIGNER,
  RELEASE_SIGNER_REF,
  RELEASE_TAG_FILTER,
  RELEASE_WORKFLOW,
  RELEASE_IMAGE_PLATFORM,
  RELEASE_IMAGES,
  RELEASE_IMAGE_DIGESTS,
  recordedImageDigests,
  releaseAssets,
  releaseImageName,
  releaseImageRef,
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
 * when release.yml does anything else, when the job that signs or the job
 * that pushes the images runs anything from the repository or from what the
 * builds made, and when any workflow writes more than it is listed for here.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = join(ROOT, '.github', 'workflows');

type Permissions = Record<string, string> | string | null | undefined;

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  shell?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  'working-directory'?: string;
}

interface Job {
  permissions?: Permissions;
  env?: Record<string, string>;
  defaults?: unknown;
  container?: unknown;
  services?: unknown;
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
  defaults?: unknown;
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
  // Its one write, the tag, is the releaser's own token's (tests/cut-release.test.ts).
  'cut-release.yml': [],
  'deploy-testing.yml': ['deployments'],
  'promote-production.yml': ['deployments'],
  'rollback-production.yml': [],
  'smoke-testing.yml': [],
  'release.yml': ['contents', 'id-token', 'attestations', 'packages'],
  'release-build.yml': ['contents', 'id-token', 'attestations', 'packages'],
};

/** Whether a step runs the repository's own code: a checkout, its scripts, its install or its build. */
function runsTheRepository(step: Step): boolean {
  if (step.uses?.startsWith('actions/checkout@')) return true;
  return /\b(pnpm|npm|npx|node|make)\b/.test(step.run ?? '');
}

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'for', 'break', 'continue', '!', '{', '}']);

/**
 * A simple command's words, the keywords, assignments and redirections
 * before it dropped (`done < <(…)`); empty for `for name in words`, whose
 * words are not commands.
 */
function commandWords(piece: string): string[] {
  const words = piece.trim().split(/\s+/).filter(Boolean);
  if (words[0] === 'for') return [];
  for (;;) {
    if (KEYWORDS.has(words[0]!) || /^\w+=/.test(words[0] ?? '')) words.shift();
    // `< file`, or `<<<"$text"` with its target attached.
    else if (/^\d*(<|>|<<<|>>)$/.test(words[0] ?? '')) words.splice(0, 2);
    else if (/^\d*(<<<|>>|<|>)\S/.test(words[0] ?? '')) words.shift();
    else return words;
  }
}

/**
 * The simple commands a shell script runs, each as its words, quoted text
 * left out. A command substitution inside double quotes runs all the same
 * (`"$(bash out/x)"`), so each `$(…)`, `<(…)` and backquote is read again
 * on its own, up to its first `)`: the commands of a pipe inside one count,
 * and a quote left open there ends it.
 */
function simpleCommandsOf(script: string): string[][] {
  const plain = script.replace(/(^|\s)#[^\n]*/g, '$1').replace(/\\\n/g, ' ');
  const unquote = (text: string) => text.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const commands = unquote(plain)
    .split(/\n|;|&&|\|\||\||\$\(|<\(|\(|\)|`/)
    .map(commandWords)
    .filter((words) => words.length > 0);
  for (const [, inner] of plain.matchAll(/(?:\$\(|<\(|`)([^)`]*)/g)) {
    const flat = inner!
      .replace(/'[^']*'/g, ' Q ')
      .replace(/"(?:[^"\\]|\\.)*"/g, ' Q ')
      .replace(/['"][\s\S]*$/, '');
    for (const piece of flat.split(/\n|;|&&|\|\||\|/)) {
      const words = commandWords(piece);
      if (words.length > 0) commands.push(words);
    }
  }
  return commands;
}

/** The programs a shell script runs: the first word of each simple command. */
function commandsOf(script: string): string[] {
  return simpleCommandsOf(script).map((words) => words[0]!);
}

/**
 * The programs the jobs on the signing side, `push` and `publish`, may run.
 * The archive, the bundle and the images are only hashed, copied, loaded as
 * data, signed and uploaded or pushed: anything else, an interpreter, a shell
 * given a script, or a file of the artifact run by its path, would run what
 * the builds made with the power to push or sign. `curl` only asks ghcr.io
 * whether an image can be pulled without signing in, and GitHub's API for an
 * image's attestations without a token (`SIGNING_CURL`); `jq` reads what gh,
 * the registry and the API answered; `sleep` waits for the API to catch up.
 */
const SIGNING_COMMANDS = new Set(['[', '[[', 'cp', 'curl', 'docker', 'echo', 'exit', 'gh', 'jq', 'printf', 'read', 'sha256sum', 'sleep', 'tr', 'wc']);

/**
 * The only addresses `curl` may be given, as the scripts write them, and the
 * one credential each may carry: ghcr.io's pull token, asked for with none;
 * an image's manifest, with the anonymous pull token ghcr.io just handed out;
 * and an image's attestations from GitHub's API (imageAttestationsUrl), with
 * the job's token under a name gh does not read, only so that a shared
 * runner address is not throttled. Nothing is sent, and nothing is written
 * anywhere but /dev/null or the pipe.
 */
const SIGNING_CURL: [RegExp, string | null][] = [
  [/^https:\/\/ghcr\.io\/token\?scope=repository:\$repository:pull&service=ghcr\.io$/, null],
  [/^https:\/\/ghcr\.io\/v2\/\$repository\/manifests\/\$\{subject#\*@\}$/, 'Authorization: Bearer $token'],
  [/^https:\/\/api\.github\.com\/repos\/\$REPO\/attestations\/sha256%3A\$\{digest#sha256:\}$/, 'Authorization: Bearer $ATTESTATIONS_TOKEN'],
];

/** Each `curl` in a script, as its words, quotes taken off: what it is asked for, and how. */
function curls(script: string): string[][] {
  const plain = script.replace(/(^|\s)#[^\n]*/g, '$1').replace(/\\\n/g, ' ');
  return [...plain.matchAll(/(?:^|[\s;&|(])curl((?:\s+(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&|)"']+))*)/g)].map(([, args]) =>
    (args!.match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) ?? []).map((word) => word.replace(/^["']|["']$/g, '')),
  );
}

/** What a `curl` does beyond reading one of `SIGNING_CURL`'s addresses, empty when nothing. */
function curlProblems(words: string[]): string[] {
  const problems: string[] = [];
  const urls: string[] = [];
  const credentials: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (word === '--output') {
      const to = words[(index += 1)];
      if (to !== '/dev/null') problems.push(`curl writes to ${to}`);
    } else if (word === '--header') {
      const header = words[(index += 1)] ?? '';
      if (/^authorization:/i.test(header)) credentials.push(header);
    } else if (word === '-fsS' || word === '--head') {
      // Fail on an HTTP error, quietly but saying why; ask for the headers only.
    } else if (word.startsWith('-')) problems.push(`curl ${word}`);
    else urls.push(word);
  }
  const address = urls.length === 1 ? SIGNING_CURL.find(([allowed]) => allowed.test(urls[0]!)) : undefined;
  if (!address) problems.push(`curl asks for ${urls.join(' ') || 'nothing'}`);
  else for (const credential of credentials) if (credential !== address[1]) problems.push(`curl sends ${credential} to ${urls[0]}`);
  return problems;
}

/**
 * What each of them may ask docker to do. `push` reads the build's images in
 * as data, looks at them, signs in, pushes them and reads back what the
 * registry holds; `publish` only signs in and out, for the attest action,
 * and never reads an image's files. `docker run`, `exec`, `build` or
 * `compose` would run what the build made with a token that can push
 * packages or an OIDC token that can sign.
 */
const SIGNING_DOCKER: Record<string, string[]> = {
  push: ['load', 'image inspect', 'login', 'push', 'buildx imagetools inspect'],
  publish: ['login', 'logout'],
};

/** What gh may be asked: GitHub's API, read only, the attestation check, and the release. Not `gh extension`, `gh alias` or anything else that runs a program someone chose. */
const SIGNING_GH = ['api', 'attestation verify', 'release create', 'release delete'];

/** The options that turn `gh api` from a read into a write. */
const GH_API_WRITES = /^(-X|--method|-f|-F|--field|--raw-field|--input)(=|$)/;

/** The only actions they may use: fetching the builds' files, and signing. Not a local action (`./…`), nor a container (`docker://…`). */
const SIGNING_USES = /^actions\/(download-artifact|attest-build-provenance)@[0-9a-f]{40}$/;

/** Environment that makes a shell, Node (the actions are Node) or the loader run a file before the step's own code. */
const STARTUP_ENV = new Set(['BASH_ENV', 'ENV', 'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'PATH']);

/** Where each `cp` in a script copies to, and whether it was given an option (`-t dir` names the destination first). */
function copies(script: string): { destination: string; options: boolean }[] {
  const plain = script.replace(/(^|\s)#[^\n]*/g, '$1').replace(/\\\n/g, ' ');
  return [...plain.matchAll(/(?:^|[\s;&|(])cp\s+([^\n;&|]*)/g)].map(([, args]) => {
    const words = (args!.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((word) => word.replace(/^["']|["']$/g, ''));
    return { destination: words.at(-1) ?? '', options: words.some((word) => word.startsWith('-')) };
  });
}

/**
 * What a step of `push` or `publish` does that could run the builds' files,
 * empty when nothing: an action other than the two, a shell of its own, an
 * environment that runs a file first, a write to the next steps' PATH or
 * environment, a program or a docker or gh command beyond the lists above,
 * or a `cp` anywhere but into `out/`, where the release's files are.
 */
function stepProblems(step: Step, docker: string[]): string[] {
  const label = step.name ?? step.uses ?? 'a step';
  const problems: string[] = [];
  if (step.uses !== undefined && !SIGNING_USES.test(step.uses)) problems.push(`${label}: uses ${step.uses}`);
  if (step.shell !== undefined) problems.push(`${label}: runs under its own shell, ${step.shell}`);
  for (const name of Object.keys(step.env ?? {})) if (STARTUP_ENV.has(name)) problems.push(`${label}: sets ${name}`);
  const script = step.run ?? '';
  if (/GITHUB_PATH|GITHUB_ENV/.test(script)) problems.push(`${label}: writes the next steps' PATH or environment`);
  const allowed = (list: string[], asked: string) => list.some((one) => asked === one || asked.startsWith(`${one} `));
  for (const [command, ...rest] of simpleCommandsOf(script)) {
    const asked = rest.join(' ');
    if (!SIGNING_COMMANDS.has(command!)) problems.push(`${label}: runs ${command}`);
    else if (command === 'docker' && !allowed(docker, asked)) problems.push(`${label}: runs docker ${asked}`);
    else if (command === 'gh' && !allowed(SIGNING_GH, asked)) problems.push(`${label}: runs gh ${asked}`);
    else if (command === 'gh' && rest[0] === 'api' && rest.some((word) => GH_API_WRITES.test(word))) problems.push(`${label}: writes with gh ${asked}`);
  }
  for (const { destination, options } of copies(script)) {
    if (options || !/^out\/[^/]/.test(destination) || destination.split('/').includes('..')) problems.push(`${label}: copies to ${destination}`);
  }
  for (const words of curls(script)) problems.push(...curlProblems(words).map((problem) => `${label}: ${problem}`));
  return problems;
}

/** The same for a whole job: its steps, and what its own settings could run first. */
function jobProblems(job: Job, docker: string[]): string[] {
  const problems = (job.steps ?? []).flatMap((step) => stepProblems(step, docker));
  for (const name of Object.keys(job.env ?? {})) if (STARTUP_ENV.has(name)) problems.push(`the job sets ${name}`);
  if (job.defaults !== undefined) problems.push('the job names defaults for its steps');
  if (job.container !== undefined) problems.push('the job runs in a container');
  if (job.services !== undefined) problems.push('the job starts services');
  return problems;
}

function runsTheArtifact(step: Step, docker: string[] = SIGNING_DOCKER.push!): boolean {
  return stepProblems(step, docker).length > 0;
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
      permissionProblems('release-build.yml', { ...release, jobs: { ...release.jobs, publish: { ...publish, permissions: { ...(publish.permissions as Record<string, string>), deployments: 'write' } } } }),
    ).toEqual(['release-build.yml writes deployments']);
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
    // `packages: write` too, for the release's images: a called workflow's job
    // gets at most what its caller grants, so without it here publish could
    // not push them, and the run would fail before any job started.
    expect(job.permissions).toEqual({
      contents: 'write',
      actions: 'read',
      'pull-requests': 'read',
      issues: 'read',
      'id-token': 'write',
      attestations: 'write',
      packages: 'write',
    });
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

  it('signs only from publish, and pushes packages only from push and publish, neither running anything from the repository or the builds', () => {
    const writing = Object.entries(build.jobs)
      .filter(([, job]) => writes(job.permissions).length > 0)
      .map(([name]) => name);
    expect(writing).toEqual(['push', 'publish']);
    // push holds what any branch's workflow could ask for, and nothing that signs or releases.
    expect(build.jobs.push?.permissions).toEqual({ contents: 'read', packages: 'write' });
    expect(build.jobs.publish?.permissions).toEqual({ contents: 'write', 'id-token': 'write', attestations: 'write', packages: 'write' });
    for (const job of ['push', 'publish']) {
      const steps = build.jobs[job]?.steps ?? [];
      expect(steps.filter(runsTheRepository), job).toEqual([]);
      expect(jobProblems(build.jobs[job]!, SIGNING_DOCKER[job]!), job).toEqual([]);
    }
    expect(build.defaults).toBeUndefined();
  });

  it('reads the images’ files only in push, never in the job that signs', () => {
    const fetched = (job: string) => (build.jobs[job]?.steps ?? []).filter((one) => one.uses?.startsWith('actions/download-artifact@')).map((one) => one.with?.name);
    expect(fetched('push')).toEqual(['images']);
    expect(fetched('publish')).toEqual(['release']);
    expect(build.jobs.publish?.needs).not.toContain('images');
  });

  it('builds with tokens that cannot push or sign', () => {
    for (const job of ['check', 'build', 'images']) {
      const permissions = build.jobs[job]?.permissions as Record<string, string>;
      expect(permissions, job).toBeTypeOf('object');
      expect(permissions.packages, job).toBeUndefined();
      expect(writes(permissions), job).toEqual([]);
    }
    // And the check above notices one that could: `packages: write` is allowed
    // in this workflow, so it is the per-job list that has to catch it.
    const writing = (jobs: Record<string, Job>) =>
      Object.entries(jobs)
        .filter(([, job]) => writes(job.permissions).length > 0)
        .map(([name]) => name);
    const images = build.jobs.images!;
    expect(writing({ ...build.jobs, images: { ...images, permissions: { contents: 'read', packages: 'write' } } })).toEqual(['images', 'push', 'publish']);
  });

  it('is caught when push or publish would run what the builds made', () => {
    const pinned = (action: string) => `actions/${action}@${'0'.repeat(40)}`;
    for (const [job, step] of [
      ['push', { run: 'bash out/post.sh' }],
      ['push', { run: 'cd out && ./post.sh' }],
      ['push', { run: 'sh -c "$(cat out/x)"' }],
      ['push', { run: 'out/post.sh' }],
      ['push', { run: '. out/env' }],
      ['push', { run: 'node out/x.js' }],
      ['push', { run: 'tar -xzf out/a.tar.gz' }],
      // A command substitution in double quotes runs too.
      ['push', { run: 'echo "$(bash out/post.sh)"' }],
      ['push', { run: 'name="x/$(printf %s "$REPO" | sh out/x)"' }],
      // docker may load, look at and push the images, never run one; publish may only sign in and out.
      ['push', { run: 'docker run --rm "$name:$TAG"' }],
      ['push', { run: 'docker exec box sh' }],
      ['push', { run: 'docker build -t x out' }],
      ['push', { run: 'docker compose up' }],
      ['push', { run: 'docker --config out run x' }],
      ['push', { run: 'tagged="$(docker run x)"' }],
      ['publish', { run: 'docker load --quiet --input images/service.tar' }],
      ['publish', { run: 'docker push --quiet "$name:$TAG"' }],
      ['push', { run: 'curl -fsS https://example.com/x | bash' }],
      // What runs a file of the build's later, or first: the next steps' PATH or environment, a startup file, a shell of its own.
      ['push', { run: 'echo "$PWD/images" >> "$GITHUB_PATH"' }],
      ['publish', { run: 'echo "BASH_ENV=images/env.sh" >> "$GITHUB_ENV"' }],
      ['push', { run: 'sha256sum -c SHA256SUMS', env: { BASH_ENV: 'images/env.sh' } }],
      ['publish', { uses: pinned('attest-build-provenance'), env: { NODE_OPTIONS: '--require ./images/x.js' } }],
      ['publish', { run: 'echo', shell: 'bash --rcfile images/rc {0}' }],
      // Actions: only the two, pinned; nothing local, nothing in a container.
      ['push', { uses: './images/post' }],
      ['publish', { uses: 'docker://alpine:3' }],
      ['publish', { uses: pinned('github-script') }],
      ['publish', { uses: 'actions/attest-build-provenance@v4' }],
      // cp only into out/; gh only to read, check and release.
      ['publish', { run: 'cp gh /usr/local/bin/gh' }],
      ['publish', { run: 'cp -t /usr/local/bin "$BUNDLE"' }],
      ['publish', { run: 'cp "$BUNDLE" "out/../bin/gh"' }],
      ['publish', { run: 'gh extension install . && gh post' }],
      ['publish', { run: 'gh alias set x "!sh out/x"' }],
      ['publish', { run: 'gh api -X DELETE "repos/$REPO/git/refs/tags/$TAG"' }],
      ['publish', { run: 'gh api "repos/$REPO/git/refs" -f ref=refs/tags/x' }],
      // curl only reads its three addresses, sends nothing, writes nowhere, and takes a credential to none but ghcr.io's manifest.
      ['publish', { run: 'curl -fsS https://example.com/post.sh > out/post.sh' }],
      ['publish', { run: 'curl -fsS -X POST "https://api.github.com/repos/$REPO/attestations/sha256%3A${digest#sha256:}"' }],
      ['publish', { run: 'curl -fsS --data @out/x "https://api.github.com/repos/$REPO/attestations/sha256%3A${digest#sha256:}"' }],
      ['publish', { run: 'curl -fsS -o images/x "https://api.github.com/repos/$REPO/attestations/sha256%3A${digest#sha256:}"' }],
      ['publish', { run: 'curl -fsS --output out/x.sh "https://ghcr.io/v2/$repository/manifests/${subject#*@}"' }],
      ['publish', { run: 'curl -K images/curlrc "https://ghcr.io/token?scope=repository:$repository:pull&service=ghcr.io"' }],
      ['publish', { run: 'curl -fsS --header "Authorization: Bearer $GH_TOKEN" "https://api.github.com/repos/$REPO/attestations/sha256%3A${digest#sha256:}"' }],
      ['publish', { run: 'curl -fsS --header "Authorization: Bearer $ATTESTATIONS_TOKEN" "https://ghcr.io/v2/$repository/manifests/${subject#*@}"' }],
      ['publish', { run: 'curl -fsS --header "Authorization: Bearer $ATTESTATIONS_TOKEN" "https://ghcr.io/token?scope=repository:$repository:pull&service=ghcr.io"' }],
      ['publish', { run: 'curl -fsS --header "Authorization: Bearer $token" "https://api.github.com/repos/$REPO/attestations/sha256%3A${digest#sha256:}"' }],
      ['publish', { run: 'curl -fsS "https://api.github.com/repos/$REPO/attestations/sha256%3A${digest#sha256:}" https://example.com/x' }],
      ['publish', { run: 'sleep 10 && curl -fsS https://ghcr.io/v2/someone/else/manifests/latest' }],
    ] as [string, Step][]) {
      expect(runsTheArtifact(step, SIGNING_DOCKER[job]), `${job}: ${JSON.stringify(step)}`).toBe(true);
    }
    for (const [job, step] of [
      ['publish', { run: 'sha256sum -c SHA256SUMS' }],
      ['publish', { run: 'cp "$BUNDLE" "out/x.sigstore.json"' }],
      ['publish', { run: 'gh release create "$TAG" out/SHA256SUMS' }],
      ['publish', { run: `gh api "repos/$REPO/releases/tags/$TAG" --jq '.immutable'` }],
      ['publish', { run: 'printf \'%s\' "$GH_TOKEN" | docker login ghcr.io --username "$GITHUB_ACTOR" --password-stdin' }],
      ['publish', { run: 'docker logout ghcr.io' }],
      ['publish', { uses: pinned('attest-build-provenance'), with: { 'subject-path': 'out/a.tar.gz' } }],
      ['publish', { run: 'echo "service-digest=$digest" >> "$GITHUB_OUTPUT"' }],
      ['push', { run: 'loaded=$(docker load --quiet --input "$image.tar")' }],
      ['push', { run: 'docker push --quiet "$name:$TAG"' }],
      ['push', { run: `platform=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$name:$TAG")` }],
      ['push', { run: `tagged=$(docker buildx imagetools inspect "$name:$TAG" --format '{{json .Manifest}}' | jq -r .digest)` }],
      ['push', { run: 'prefix="ghcr.io/$(printf \'%s\' "$REPO" | tr \'[:upper:]\' \'[:lower:]\')"' }],
      ['push', { uses: pinned('download-artifact'), with: { name: 'images', path: 'images' } }],
      ['publish', { run: 'token=$(curl -fsS "https://ghcr.io/token?scope=repository:$repository:pull&service=ghcr.io" | jq -er .token)' }],
      ['publish', { run: 'curl -fsS --head --output /dev/null --header "Authorization: Bearer $token" "https://ghcr.io/v2/$repository/manifests/${subject#*@}"' }],
      ['publish', { run: `curl -fsS "https://api.github.com/repos/$REPO/attestations/sha256%3A\${digest#sha256:}" | jq -c '.attestations[].bundle' > "$bundle"` }],
      ['publish', { run: 'curl -fsS --header "Authorization: Bearer $ATTESTATIONS_TOKEN" "https://api.github.com/repos/$REPO/attestations/sha256%3A${digest#sha256:}"' }],
    ] as [string, Step][]) {
      expect(runsTheArtifact(step, SIGNING_DOCKER[job]), `${job}: ${JSON.stringify(step)}`).toBe(false);
    }
    // A job's own settings: a startup file, a container, defaults for every step.
    const publish = build.jobs.publish!;
    expect(jobProblems({ ...publish, env: { ...publish.env, BASH_ENV: 'images/env.sh' } }, SIGNING_DOCKER.publish!)).toEqual(['the job sets BASH_ENV']);
    expect(jobProblems({ ...publish, container: 'node:22' }, SIGNING_DOCKER.publish!)).toEqual(['the job runs in a container']);
    expect(jobProblems({ ...publish, defaults: { run: { shell: 'bash --rcfile images/rc {0}' } } }, SIGNING_DOCKER.publish!)).toEqual(['the job names defaults for its steps']);
    // And it reads the jobs' own scripts, rather than finding nothing in them.
    const scripts = (job: string) => (build.jobs[job]?.steps ?? []).map((step) => step.run ?? '').join('\n');
    expect(new Set(commandsOf(scripts('push')))).toEqual(new Set(['[', '[[', 'echo', 'exit', 'printf', 'tr', 'sha256sum', 'gh', 'read', 'docker', 'jq']));
    expect(new Set(commandsOf(scripts('publish')))).toEqual(new Set(['[', '[[', 'echo', 'exit', 'printf', 'tr', 'sha256sum', 'wc', 'cp', 'gh', 'read', 'docker', 'jq', 'curl', 'sleep']));
    // And it finds every curl in them, each to one of its addresses.
    expect(curls(scripts('publish')).map((words) => words.find((word) => word.startsWith('https://')))).toEqual([
      'https://ghcr.io/token?scope=repository:$repository:pull&service=ghcr.io',
      'https://ghcr.io/v2/$repository/manifests/${subject#*@}',
      'https://api.github.com/repos/$REPO/attestations/sha256%3A${digest#sha256:}',
    ]);
  });

  it('builds with a read-only token, once the tag is checked', () => {
    expect(build.jobs.check?.permissions).toEqual({ contents: 'read', actions: 'read', 'pull-requests': 'read', issues: 'read' });
    expect(build.jobs.build?.permissions).toEqual({ contents: 'read' });
    expect(build.jobs.images?.permissions).toEqual({ contents: 'read' });
    expect(build.jobs.build?.needs).toBe('check');
    expect(build.jobs.images?.needs).toBe('check');
    expect(build.jobs.push?.needs).toEqual(['check', 'images']);
    expect(build.jobs.publish?.needs).toEqual(['check', 'build', 'push']);
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

  /**
   * Runs a step's script as GitHub runs it, in a directory of its own holding
   * `files`, with stand-ins for the programs in `stubs` (gh's by default).
   * Each stand-in writes down what it was asked, `<program> <arguments>`, one
   * line a call, then runs its body. `outputs` is what the step wrote to
   * GITHUB_OUTPUT, and `said` what it printed.
   */
  function run(
    script: string,
    env: Record<string, string>,
    options: { stubs?: Record<string, string>; files?: Record<string, string> } = {},
  ): { status: number | null; asked: string; said: string; outputs: string } {
    const bin = mkdtempSync(join(tmpdir(), 'release-steps-'));
    const cwd = mkdtempSync(join(tmpdir(), 'release-step-cwd-'));
    try {
      const stubs: Record<string, string> = {
        gh: [
          'case "$1 $2" in',
          '  "api repos/acme/openadlc/git/ref/tags/v0.2.0") echo "$TAG_OBJECT" ;;',
          '  "api repos/acme/openadlc/releases/tags/v0.2.0") echo "$IMMUTABLE" ;;',
          'esac',
        ].join('\n'),
        ...options.stubs,
      };
      for (const [name, body] of Object.entries(stubs)) {
        writeFileSync(join(bin, name), `#!/bin/bash\necho "${name} $*" >> "$GH_LOG"\n${body}\nexit 0\n`);
        chmodSync(join(bin, name), 0o755);
      }
      for (const [path, content] of Object.entries(options.files ?? {})) {
        mkdirSync(dirname(join(cwd, path)), { recursive: true });
        writeFileSync(join(cwd, path), content);
        chmodSync(join(cwd, path), 0o755);
      }
      const log = join(bin, 'asked');
      const outputs = join(bin, 'outputs');
      writeFileSync(log, '');
      writeFileSync(outputs, '');
      const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
        cwd,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          GH_LOG: log,
          GITHUB_OUTPUT: outputs,
          REPO: 'acme/openadlc',
          TAG: 'v0.2.0',
          SHA: 'a'.repeat(40),
          RELEASERS: build.env?.RELEASERS ?? '',
          ...env,
        },
        encoding: 'utf8',
      });
      return { status: result.status, asked: readFileSync(log, 'utf8'), said: `${result.stdout}${result.stderr}`, outputs: readFileSync(outputs, 'utf8') };
    } finally {
      rmSync(bin, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  it.each([
    ['build', 'the run is still the releaser’s'.replace('’', "'")],
    ['images', "the run is still the releaser's"],
    ['push', "the run is still a releaser's"],
    ['publish', "the run is still a releaser's"],
  ])('%s refuses a re-run by anyone but the releaser check let through', (job, name) => {
    const script = step(job, name);
    expect(run(script, { ACTOR: 'orzelig', CHECKED: 'orzelig' }).status).toBe(0);
    expect(run(script, { ACTOR: 'openadlc-atlas-janedoe', CHECKED: 'orzelig' }).status).not.toBe(0);
    expect(run(script, { ACTOR: 'orzelig', CHECKED: '' }).status).not.toBe(0);
  });

  it.each(['push', 'publish'])('%s asks the releasers again, so a re-run of it alone cannot push or sign for another', (job) => {
    const script = step(job, "the run is still a releaser's");
    expect(run(script, { ACTOR: 'OrZelig', CHECKED: 'OrZelig' }).status).toBe(0);
    expect(run(script, { ACTOR: 'someone', CHECKED: 'someone' }).status).not.toBe(0);
  });

  it.each(['push', 'publish'])('%s refuses a tag that moved since it was checked', (job) => {
    const script = step(job, 'the tag is still on the commit that was checked');
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

  /**
   * The images, from `images` saving them to `publish` pushing, attesting and
   * checking them, under the names self-update takes them by
   * (`releaseImageName`, `releaseImageRef`): a workflow that pushed them
   * anywhere else, or attested another digest, would publish releases every
   * cloud install refused.
   */
  const REPO = '620legal/OpenADLC';
  const SHA = 'a'.repeat(40);
  const DIGESTS = { service: `sha256:${'1'.repeat(64)}`, console: `sha256:${'2'.repeat(64)}` } as const;
  const stepNamed = (job: string, name: string) => {
    const found = (build.jobs[job]?.steps ?? []).find((one) => one.name === name);
    if (!found) throw new Error(`${job} has no step ${name}`);
    return found;
  };

  it('images builds the two images from the checked commit, under the names self-update reads, for the one platform', () => {
    const images = build.jobs.images!;
    expect(images.env?.DOCKER_DEFAULT_PLATFORM).toBe(RELEASE_IMAGE_PLATFORM);
    const script = step('images', 'the images');
    const env = { ...images.env, REPO, TAG: 'v0.2.0', SHA };
    const docker = [
      'case "$1" in',
      '  image) echo "${PLATFORM:-linux/amd64}" ;;',
      '  save) : > "$3" ;;',
      // A Dockerfile given on stdin is written down after the call.
      '  build) if [ "$3" = - ]; then cat >> "$GH_LOG"; fi ;;',
      'esac',
    ].join('\n');
    const stubs = { docker, git: 'echo "${HEAD:-$SHA}"' };
    const notices = '#!/bin/bash\necho "third-party-notices.sh $*" >> "$GH_LOG"\n[ -z "$NO_NOTICES" ] || exit 1\necho notices > "$2"\n';
    const files = { 'infra/local/third-party-notices.sh': notices };
    const built = run(script, env, { stubs, files });
    expect(built.status, built.said).toBe(0);
    const asked = built.asked.split('\n');
    expect(asked.filter((line) => /^(docker build|third-party-notices|FROM|COPY)/.test(line))).toEqual([
      // Both from the repository's root before anything is written into it.
      ...RELEASE_IMAGES.map((image) => `docker build -f infra/local/Dockerfile.${image} -t openadlc-release/${image}:built .`),
      ...RELEASE_IMAGES.flatMap((image) => [
        // The licences of what it installs, read from the image as built, then put inside it.
        `third-party-notices.sh openadlc-release/${image}:built notices/${image}/THIRD_PARTY_NOTICES`,
        `docker build -f - -t ${releaseImageRef(REPO, image, 'v0.2.0')} notices/${image}`,
        `FROM openadlc-release/${image}:built`,
        'COPY THIRD_PARTY_NOTICES /usr/share/doc/openadlc/THIRD_PARTY_NOTICES',
      ]),
    ]);
    expect(asked.filter((line) => line.startsWith('docker save'))).toEqual(
      RELEASE_IMAGES.map((image) => `docker save --output images/${image}.tar ${releaseImageRef(REPO, image, 'v0.2.0')}`),
    );
    expect(run(script, { ...env, PLATFORM: 'linux/arm64' }, { stubs, files }).status).not.toBe(0);
    expect(run(script, { ...env, HEAD: 'b'.repeat(40) }, { stubs, files }).status).not.toBe(0);
    // An image whose notices cannot be read is not published without them.
    expect(run(script, { ...env, NO_NOTICES: '1' }, { stubs, files }).status).not.toBe(0);
  });

  it('publishes no bot image: it holds Claude Code, which an install may run but a release may not redistribute', () => {
    expect(RELEASE_IMAGES).not.toContain('bot');
    const scripts = ['images', 'push', 'publish'].flatMap((job) => (build.jobs[job]?.steps ?? []).map((one) => `${one.run ?? ''}\n${JSON.stringify(one.with ?? {})}`)).join('\n');
    expect(scripts).not.toMatch(/\bbot\b|build-bot-image/);
  });

  it('images hands its images to push only as files, kept a day', () => {
    const upload = (build.jobs.images?.steps ?? []).find((one) => one.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.with).toMatchObject({ name: 'images', path: 'images/', 'if-no-files-found': 'error', 'retention-days': 1 });
    const download = (build.jobs.push?.steps ?? []).find((one) => one.uses?.startsWith('actions/download-artifact@') && one.with?.name === 'images');
    expect(download?.with).toEqual({ name: 'images', path: 'images' });
  });

  it('push loads only the two images the build saved, each by the name it pushes, for the one platform', () => {
    const found = stepNamed('push', 'the images are the ones the build made');
    expect(found['working-directory']).toBe('images');
    const sumsOf = (files: Record<string, string>) =>
      Object.entries(files)
        .map(([name, content]) => `${createHash('sha256').update(content).digest('hex')}  ${name}\n`)
        .join('');
    const tarballs = { 'service.tar': 'service', 'console.tar': 'console' };
    const files = { ...tarballs, SHA256SUMS: sumsOf(tarballs) };
    const docker = [
      'case "$1" in',
      '  load) echo "Loaded image: ${LOADED:-ghcr.io/620legal/openadlc}/$(basename "$4" .tar):v0.2.0" ;;',
      '  image) echo "${PLATFORM:-linux/amd64}" ;;',
      'esac',
    ].join('\n');
    const env = { REPO, TAG: 'v0.2.0' };
    const loaded = run(found.run!, env, { stubs: { docker }, files });
    expect(loaded.status, loaded.said).toBe(0);
    expect(loaded.asked.split('\n').filter((line) => line.startsWith('docker load'))).toEqual(RELEASE_IMAGES.map((image) => `docker load --quiet --input ${image}.tar`));
    // A tarball that holds another image than the one its name says, one for another platform, or one changed on the way.
    expect(run(found.run!, { ...env, LOADED: 'ghcr.io/someone/else' }, { stubs: { docker }, files }).status).not.toBe(0);
    expect(run(found.run!, { ...env, PLATFORM: 'linux/arm64' }, { stubs: { docker }, files }).status).not.toBe(0);
    expect(run(found.run!, env, { stubs: { docker }, files: { ...files, 'console.tar': 'another' } }).status).not.toBe(0);
    // Or a third image beside them.
    const third = { ...tarballs, 'bot.tar': 'bot' };
    expect(run(found.run!, env, { stubs: { docker }, files: { ...third, SHA256SUMS: sumsOf(third) } }).status).not.toBe(0);
  });

  it('push refuses, before it pushes, a tag that already has a release', () => {
    const script = step('push', 'the tag has no release yet');
    const gh = 'case "$1 $2" in "api --paginate") [ -z "$API_DOWN" ] || exit 1; printf "%s\\n" $RELEASED ;; esac';
    const fresh = run(script, { RELEASED: 'v0.1.0 v0.1.1' }, { stubs: { gh } });
    expect(fresh.status, fresh.said).toBe(0);
    expect(fresh.asked).toContain('gh api --paginate repos/acme/openadlc/releases?per_page=100');
    const released = run(script, { RELEASED: 'v0.1.0 v0.2.0' }, { stubs: { gh } });
    expect(released.status).not.toBe(0);
    expect(released.said).toContain('v0.2.0 already has a release');
    // GitHub not answering is not "no release".
    expect(run(script, { RELEASED: '', API_DOWN: '1' }, { stubs: { gh } }).status).not.toBe(0);
  });

  it('push pushes each image under its name and the tag, and hands on the digest the registry has for the tag', () => {
    const found = stepNamed('push', 'push the images');
    expect(found.id).toBe('push');
    expect(build.jobs.push?.outputs).toEqual(Object.fromEntries(RELEASE_IMAGES.map((image) => [`${image}-digest`, `\${{ steps.push.outputs.${image}-digest }}`])));
    const docker = [
      'for arg; do case "$arg" in ghcr.io/*) ref=$arg ;; esac; done',
      'name=${ref%:*}',
      'case "${name##*/}" in service) digest=$DIGEST_SERVICE ;; console) digest=$DIGEST_CONSOLE ;; esac',
      'case "$1 $2" in',
      `  "image inspect") [ -n "$NO_DIGEST" ] || printf '%s@%s\\n' "$name" "$digest" ;;`,
      `  "buildx imagetools") printf '{"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"%s","size":1}\\n' "\${TAGGED:-$digest}" ;;`,
      'esac',
    ].join('\n');
    const env = { REPO, TAG: 'v0.2.0', DIGEST_SERVICE: DIGESTS.service, DIGEST_CONSOLE: DIGESTS.console };
    const pushed = run(found.run!, env, { stubs: { docker } });
    expect(pushed.status, pushed.said).toBe(0);
    expect(pushed.asked.split('\n').filter((line) => line.startsWith('docker push'))).toEqual(
      RELEASE_IMAGES.map((image) => `docker push --quiet ${releaseImageRef(REPO, image, 'v0.2.0')}`),
    );
    expect(pushed.outputs.trim().split('\n')).toEqual(RELEASE_IMAGES.map((image) => `${image}-digest=${DIGESTS[image]}`));
    // The registry answering another digest for the tag than the push made, or a push that recorded none.
    expect(run(found.run!, { ...env, TAGGED: `sha256:${'9'.repeat(64)}` }, { stubs: { docker } }).status).not.toBe(0);
    expect(run(found.run!, { ...env, NO_DIGEST: '1' }, { stubs: { docker } }).status).not.toBe(0);
  });

  it('publish names the images itself, and takes from push only what has the form of a digest', () => {
    const found = stepNamed('publish', 'the digests push made');
    expect(found.id).toBe('images');
    expect(found.env).toEqual({ SERVICE_DIGEST: '${{ needs.push.outputs.service-digest }}', CONSOLE_DIGEST: '${{ needs.push.outputs.console-digest }}' });
    const env = { REPO, SERVICE_DIGEST: DIGESTS.service, CONSOLE_DIGEST: DIGESTS.console };
    const named = run(found.run!, env);
    expect(named.status, named.said).toBe(0);
    expect(named.outputs.trim().split('\n')).toEqual(RELEASE_IMAGES.flatMap((image) => [`${image}-name=${releaseImageName(REPO, image)}`, `${image}-digest=${DIGESTS[image]}`]));
    for (const digest of ['', 'latest', `sha256:${'a'.repeat(63)}`, `sha256:${'A'.repeat(64)}`, `${DIGESTS.console} x`, `sha256:${'a'.repeat(64)}; echo`]) {
      expect(run(found.run!, { ...env, CONSOLE_DIGEST: digest }).status, digest).not.toBe(0);
    }
  });

  it('publish attests each image by the digest push made, in the registry beside it, with the archive’s action', () => {
    const steps = build.jobs.publish?.steps ?? [];
    const archive = steps.find((one) => one.with?.['subject-path']);
    expect(archive?.uses).toMatch(/^actions\/attest-build-provenance@/);
    const images = steps.filter((one) => one.uses === archive?.uses && one.with?.['subject-digest']);
    expect(images.map((one) => one.with)).toEqual(
      RELEASE_IMAGES.map((image) => ({
        'subject-name': `\${{ steps.images.outputs.${image}-name }}`,
        'subject-digest': `\${{ steps.images.outputs.${image}-digest }}`,
        'push-to-registry': true,
        'create-storage-record': false,
      })),
    );
  });

  const subject = (image: string) => `\${{ steps.images.outputs.${image}-name }}@\${{ steps.images.outputs.${image}-digest }}`;
  const subjects = { SERVICE: `${releaseImageName(REPO, 'service')}@${DIGESTS.service}`, CONSOLE: `${releaseImageName(REPO, 'console')}@${DIGESTS.console}` };
  const certified = (fields: Record<string, string> = {}) => ({
    verificationResult: { signature: { certificate: { buildTrigger: 'push', buildConfigURI: `https://github.com/${REPO}/.github/workflows/release.yml@refs/tags/v0.2.0`, ...fields } } },
  });

  /** Answers GitHub's attestations API from ATTESTATIONS, with none for the first EMPTY_TIMES asks, or not at all when API_DOWN. */
  const attestationsApi = [
    'case "$*" in',
    '  *api.github.com*)',
    '    asked=$(( $(cat "$GH_LOG.count" 2>/dev/null || echo 0) + 1 )); echo "$asked" > "$GH_LOG.count"',
    '    [ -z "$API_DOWN" ] || exit 22',
    `    if [ "$asked" -le "\${EMPTY_TIMES:-0}" ]; then echo '{"attestations":[]}'; else echo "$ATTESTATIONS"; fi ;;`,
    'esac',
  ].join('\n');
  /** Writes down each bundle file it is given, a line a bundle, then answers VERIFIED. */
  const verifyingGh = [
    'prev=""; for arg; do if [ "$prev" = --bundle ]; then sed "s/^/bundle /" "$arg" >> "$GH_LOG"; fi; prev=$arg; done',
    '[ -z "$REFUSE" ] || exit 1',
    'case "$1 $2" in "attestation verify") echo "$VERIFIED" ;; esac',
  ].join('\n');
  const bundles = [{ mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json', n: 1 }, { mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json', n: 2 }];
  const verifyEnv = { ...subjects, REPO, TAG: 'v0.2.0', SHA, RUNNER_TEMP: '.', ATTESTATIONS_TOKEN: 'the-job-token', ATTESTATIONS: JSON.stringify({ attestations: bundles.map((bundle) => ({ bundle, repository_id: 1 })) }) };
  const stubs = { curl: attestationsApi, gh: verifyingGh, sleep: '' };

  it('publish checks each image as an install will, signed in nowhere, and reads back that the tag’s push through release.yml made it', () => {
    const found = stepNamed('publish', "each image's attestation passes the check every install makes");
    // For gh, no token, no login and no registry login: the path an install takes. The job's
    // token is for the API's rate limit alone, under a name gh does not read.
    expect(found.env).toEqual({
      ATTESTATIONS_TOKEN: '${{ github.token }}',
      GH_CONFIG_DIR: '${{ runner.temp }}/no-gh-login',
      DOCKER_CONFIG: '${{ runner.temp }}/no-registry-login',
      SERVICE: subject('service'),
      CONSOLE: subject('console'),
    });
    expect(found.run).not.toMatch(/GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN/);
    expect(found.run?.match(/ATTESTATIONS_TOKEN/g)).toHaveLength(1);
    const passed = run(found.run!, { ...verifyEnv, VERIFIED: JSON.stringify([certified()]) }, { stubs });
    expect(passed.status, passed.said).toBe(0);
    // The bundles from imageAttestationsUrl, a line each, checked with imageAttestationCheckArgs
    // and `--format json`, word for word, as self-update runs it.
    expect(passed.asked.trim().split('\n').filter((line) => /^(curl|gh|bundle) /.test(line))).toEqual(
      RELEASE_IMAGES.flatMap((image) => [
        `curl -fsS --header Authorization: Bearer the-job-token ${imageAttestationsUrl(REPO, DIGESTS[image])}`,
        ['gh', ...imageAttestationCheckArgs({ repo: REPO, image, digest: DIGESTS[image], tag: 'v0.2.0', commit: SHA, bundle: `./${image}.sigstore.jsonl` }), '--format', 'json'].join(' '),
        ...bundles.map((bundle) => `bundle ${JSON.stringify(bundle)}`),
      ]),
    );
    for (const verified of [
      [certified({ buildTrigger: 'workflow_dispatch' })],
      [certified({ buildConfigURI: `https://github.com/${REPO}/.github/workflows/release.yml@refs/heads/main` })],
      // Every attestation must hold, not one of them.
      [certified(), certified({ buildTrigger: 'workflow_dispatch' })],
      [certified({ buildConfigURI: 'https://github.com/someone/else/.github/workflows/release.yml@refs/tags/v0.2.0' }), certified()],
      [],
    ]) {
      expect(run(found.run!, { ...verifyEnv, VERIFIED: JSON.stringify(verified) }, { stubs }).status, JSON.stringify(verified)).not.toBe(0);
    }
    expect(run(found.run!, { ...verifyEnv, VERIFIED: 'not json' }, { stubs }).status).not.toBe(0);
    expect(run(found.run!, { ...verifyEnv, VERIFIED: JSON.stringify([certified()]), REFUSE: '1' }, { stubs }).status).not.toBe(0);
  });

  it('publish records the digests it attested and checked in images.json, which SHA256SUMS lists beside the archive, as an install reads them', () => {
    const found = stepNamed('publish', "the release records each image's digest");
    // The digests are the ones `the digests push made` took in the form of a digest, and the steps since attested and checked.
    expect(found['working-directory']).toBe('out');
    expect(found.env).toEqual({ SERVICE_DIGEST: '${{ steps.images.outputs.service-digest }}', CONSOLE_DIGEST: '${{ steps.images.outputs.console-digest }}' });
    const archive = 'the archive the build made';
    const sums = `${createHash('sha256').update(archive).digest('hex')}  ${releaseAssets('v0.2.0').archive}\n`;
    const shown = `${found.run!}\necho "=== ${RELEASE_IMAGE_DIGESTS}"; cat ${RELEASE_IMAGE_DIGESTS}; echo "=== ${RELEASE_CHECKSUMS}"; cat ${RELEASE_CHECKSUMS}\n`;
    const recorded = run(shown, { SERVICE_DIGEST: DIGESTS.service, CONSOLE_DIGEST: DIGESTS.console }, { stubs: {}, files: { [releaseAssets('v0.2.0').archive]: archive, [RELEASE_CHECKSUMS]: sums } });
    expect(recorded.status, recorded.said).toBe(0);
    const [, file = '', after = ''] = recorded.said.split(new RegExp(`=== (?:${RELEASE_IMAGE_DIGESTS}|${RELEASE_CHECKSUMS})\\n`));
    // What self-update and `openadlc cloud update` read back: the archive's line kept first, and the record's own.
    expect(after.startsWith(sums)).toBe(true);
    expect(recordedImageDigests({ tag: 'v0.2.0', commit: SHA, sums: after, file: Buffer.from(file) })).toEqual({ images: DIGESTS });
    // And the whole file checks out, as a person's `sha256sum -c` will on the release's files.
    expect(recorded.said).toContain(`${RELEASE_IMAGE_DIGESTS}: OK`);
  });

  it('publish waits a little for the API to show an attestation just made, and no longer', () => {
    const found = stepNamed('publish', "each image's attestation passes the check every install makes");
    const env = { ...verifyEnv, VERIFIED: JSON.stringify([certified()]) };
    const late = run(found.run!, { ...env, EMPTY_TIMES: '2' }, { stubs });
    expect(late.status, late.said).toBe(0);
    expect(late.asked.split('\n').filter((line) => line.startsWith('curl '))).toHaveLength(4);
    expect(late.asked.split('\n').filter((line) => line.startsWith('sleep '))).toEqual(['sleep 10', 'sleep 10']);
    const never = run(found.run!, { ...env, EMPTY_TIMES: '99' }, { stubs });
    expect(never.status).not.toBe(0);
    expect(never.said).toContain('the attestations API of GitHub gives no attestation of');
    expect(never.asked.split('\n').filter((line) => line.startsWith('curl '))).toHaveLength(6);
    expect(never.asked).not.toContain('gh attestation verify');
    expect(run(found.run!, { ...env, API_DOWN: '1' }, { stubs }).status).not.toBe(0);
  });

  it('publish fails, saying what to do, while service or console cannot be pulled without signing in', () => {
    const found = stepNamed('publish', 'service and console can be pulled without signing in');
    expect(found.env).toEqual({ SERVICE: subject('service'), CONSOLE: subject('console') });
    const curl = [
      'case "$*" in',
      `  *ghcr.io/token*) [ "$PUBLIC" = yes ] || exit 22; echo '{"token":"anonymous"}' ;;`,
      '  */manifests/*) [ "$FOUND" = yes ] || exit 22 ;;',
      'esac',
    ].join('\n');
    const env = { REPO, ...subjects };
    const pulled = run(found.run!, { ...env, PUBLIC: 'yes', FOUND: 'yes' }, { stubs: { curl } });
    expect(pulled.status, pulled.said).toBe(0);
    for (const image of RELEASE_IMAGES) {
      const path = releaseImageName(REPO, image).replace('ghcr.io/', '');
      expect(pulled.asked).toContain(`https://ghcr.io/token?scope=repository:${path}:pull&service=ghcr.io`);
      expect(pulled.asked).toContain(`https://ghcr.io/v2/${path}/manifests/${DIGESTS[image]}`);
    }
    const hidden = run(found.run!, { ...env, PUBLIC: 'no', FOUND: 'yes' }, { stubs: { curl } });
    expect(hidden.status).not.toBe(0);
    expect(hidden.said).toContain(`https://github.com/${REPO}/pkgs/container/openadlc%2Fservice`);
    expect(hidden.said).toContain('public');
    expect(run(found.run!, { ...env, PUBLIC: 'yes', FOUND: 'no' }, { stubs: { curl } }).status).not.toBe(0);
  });

  it('reads the tag again just before the push and just before the release, and the release once more before the push', () => {
    const order = (job: string) => {
      const steps = build.jobs[job]?.steps ?? [];
      return (name: string) => {
        const index = steps.findIndex((one) => one.name === name);
        expect(index, `${job}: ${name}`).toBeGreaterThan(-1);
        return index;
      };
    };
    const tagCheck = 'the tag is still on the commit that was checked';
    expect(step('push', tagCheck)).toBe(step('publish', tagCheck));
    const push = order('push');
    // The build's images are read in before the job holds a registry credential.
    expect(push('the images are the ones the build made')).toBeLessThan(push(tagCheck));
    expect(push(tagCheck)).toBe(push('the tag has no release yet') - 1);
    expect(push('the tag has no release yet')).toBe(push('sign in to ghcr.io') - 1);
    expect(push('sign in to ghcr.io')).toBe(push('push the images') - 1);
    const publish = order('publish');
    const steps = build.jobs.publish?.steps ?? [];
    const attested = steps.flatMap((one, index) => (one.with?.['subject-digest'] ? [index] : []));
    expect(publish('the digests push made')).toBeLessThan(publish('sign in to ghcr.io'));
    expect(publish('sign in to ghcr.io')).toBeLessThan(Math.min(...attested));
    // Signed out before anything reads what the registry hands back.
    expect(publish('sign out of ghcr.io')).toBe(Math.max(...attested) + 1);
    expect(publish('service and console can be pulled without signing in')).toBe(publish('sign out of ghcr.io') + 1);
    expect(publish("each image's attestation passes the check every install makes")).toBe(publish('service and console can be pulled without signing in') + 1);
    // Only digests that passed the check are recorded, and the tag is read last of all.
    expect(publish("the release records each image's digest")).toBe(publish("each image's attestation passes the check every install makes") + 1);
    expect(publish(tagCheck)).toBe(publish("the release records each image's digest") + 1);
    expect(publish(tagCheck)).toBe(publish('the release') - 1);
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
  it('never sign an attestation, or push a package', () => {
    for (const file of FILES.filter((name) => name !== 'release.yml' && name !== 'release-build.yml')) {
      const found = workflow(file);
      const scopes = [found.permissions, ...Object.values(found.jobs).map((job) => job.permissions)].flatMap(writes);
      expect(scopes, file).not.toContain('attestations');
      expect(scopes, file).not.toContain('id-token');
      expect(scopes, file).not.toContain('packages');
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
      `gh release create "$TAG" --repo "$REPO" --verify-tag --title "$TAG" --generate-notes \\\n  "out/${names.archive}" "out/${names.bundle}" out/${RELEASE_CHECKSUMS} out/${RELEASE_IMAGE_DIGESTS}`,
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

  it('names the images and checks one with the very command self-update runs, in the docs a person reads', () => {
    const docs = readFileSync(join(ROOT, 'docs', 'self-hosting.md'), 'utf8');
    for (const image of RELEASE_IMAGES) expect(docs).toContain(`\`${releaseImageRef('620legal/OpenADLC', image, '<tag>')}\``);
    const start = docs.indexOf('gh attestation verify "oci://');
    expect(start).toBeGreaterThan(-1);
    const command = docs.slice(start, docs.indexOf('\n', docs.indexOf('--predicate-type', start)));
    for (const image of RELEASE_IMAGES) {
      expect(words(command.replaceAll('$image', image)).slice(1)).toEqual(
        imageAttestationCheckArgs({ repo: '620legal/OpenADLC', image, digest: '$digest', tag: '$tag', commit: '$commit', bundle: `${image}.sigstore.jsonl` }),
      );
    }
    // The bundles from imageAttestationsUrl, a line each, into the file the check reads.
    const fetched = /curl -fsS "([^"]+)" \\\n\s+\| jq -c '\.attestations\[\]\.bundle' > "\$image\.sigstore\.jsonl"/.exec(docs);
    expect(fetched).not.toBeNull();
    const hex = 'a'.repeat(64);
    expect(fetched![1]!.replace('${digest#sha256:}', hex)).toBe(imageAttestationsUrl('620legal/OpenADLC', `sha256:${hex}`));
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
