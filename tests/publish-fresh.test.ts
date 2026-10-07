import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `infra/publish/publish-fresh.sh` makes the public repository's first commit
 * from a reviewed tree. A push cannot be taken back, so what it makes is
 * checked here against a tiny repository: one commit, by the maintainer's
 * noreply identity, none of the source's history, and nothing pushed.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'infra', 'publish', 'publish-fresh.sh');
const IDENTITY = 'orzelig <2146989+orzelig@users.noreply.github.com>';

let work: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'publish-fresh-'));
  // An ssh that records being called: a push, or anything else that reaches
  // for the remote, would run it.
  const ssh = join(work, 'ssh');
  writeFileSync(ssh, `#!/bin/sh\necho "$@" >> "${join(work, 'ssh-called')}"\nexit 1\n`);
  chmodSync(ssh, 0o755);
  env = {
    PATH: process.env.PATH,
    HOME: work,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(work, 'gitconfig'),
    GIT_SSH_COMMAND: ssh,
    GIT_TERMINAL_PROMPT: '0',
  };
  writeFileSync(env.GIT_CONFIG_GLOBAL!, '');
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

/** A source repository with history and an author who is not the maintainer. */
function source(files: Record<string, string>): string {
  const repo = join(work, 'source');
  mkdirSync(repo);
  git(repo, 'init', '--quiet', '--initial-branch=main');
  git(repo, 'config', 'user.name', 'Somebody Else');
  git(repo, 'config', 'user.email', 'somebody@example.com');
  writeFileSync(join(repo, 'package.json'), '{\n  "name": "fleetadlc",\n  "version": "0.1.0"\n}\n');
  git(repo, 'add', '--all');
  git(repo, 'commit', '--quiet', '-m', 'The first of the history');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, name)), { recursive: true });
    writeFileSync(join(repo, name), text);
  }
  git(repo, 'add', '--all');
  git(repo, 'commit', '--quiet', '-m', 'The reviewed tree\n\nClaude-Session: https://example.com/session');
  git(repo, 'branch', 'side');
  return repo;
}

/** A denylist kept outside the source repository. The patterns are the test's, not an install's. */
function denylist(pattern: string): string {
  const file = join(work, 'denylist');
  writeFileSync(file, `${pattern}\n`);
  return file;
}

const publish = (repo: string, target: string, ...extra: string[]) =>
  spawnSync('bash', [SCRIPT, '--repo', repo, '--denylist', denylist('not-in-this-tree'), ...extra, 'main', target], { env, encoding: 'utf8' });

describe('publishing from one fresh commit', () => {
  it('makes one commit of the reviewed tree, by the noreply identity, with the remote added and nothing pushed', () => {
    const repo = source({ 'README.md': '# OpenADLC\n', 'apps/bridge/index.ts': 'export {};\n' });
    const target = join(work, 'public');

    const run = publish(repo, target);

    expect(run.status, run.stderr).toBe(0);
    expect(git(target, 'rev-list', '--all', '--count')).toBe('1');
    expect(git(target, 'log', '--format=%an <%ae>|%cn <%ce>')).toBe(`${IDENTITY}|${IDENTITY}`);
    expect(git(target, 'log', '--format=%B')).toBe('OpenADLC 0.1.0');
    expect(git(target, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/main');
    expect(git(target, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').sort()).toEqual(['README.md', 'apps/bridge/index.ts', 'package.json']);
    expect(git(target, 'remote', 'get-url', 'origin')).toBe('git@github.com:620legal/OpenADLC.git');
    // Not pushed: nothing reached for the remote, and there is no remote-tracking ref.
    expect(existsSync(join(work, 'ssh-called'))).toBe(false);
    expect(git(target, 'for-each-ref', 'refs/remotes')).toBe('');
    expect(run.stdout).toContain('push origin main');
    expect(run.stdout).not.toMatch(/--all|--mirror/);
  });

  it('adds no sign-off unless asked, and the message it is given', () => {
    const repo = source({ 'README.md': '# OpenADLC\n' });
    const target = join(work, 'public');

    const run = publish(repo, target, '--message', 'OpenADLC, first public release', '--signoff');

    expect(run.status, run.stderr).toBe(0);
    expect(git(target, 'log', '--format=%B')).toBe(`OpenADLC, first public release\n\nSigned-off-by: ${IDENTITY}`);
  });

  it('reads one pattern per line, so a later line still refuses the tree', () => {
    // Joined into one expression, the two lines match nothing and the tree
    // is published with the name still in it.
    const repo = source({ 'docs/notes.md': 'Kept the second-name in a comment.\n' });
    const file = join(work, 'names');
    writeFileSync(file, '\nfirst-name\nsecond-name\n\n');
    const target = join(work, 'public');

    const run = spawnSync('bash', [SCRIPT, '--repo', repo, '--denylist', file, 'main', target], { env, encoding: 'utf8' });

    expect(run.status, run.stderr).toBe(1);
    expect(run.stderr).toContain('docs/notes.md');
    expect(existsSync(target)).toBe(false);
  });

  it('refuses a tree that matches the denylist, and writes nothing', () => {
    const leftover = ['fleet', 'testbed'].join('-');
    const repo = source({ 'docs/notes.md': `Tried on ${leftover}-2.\n` });
    const target = join(work, 'public');

    const run = spawnSync('bash', [SCRIPT, '--repo', repo, '--denylist', denylist(leftover), 'main', target], { env, encoding: 'utf8' });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('docs/notes.md');
    expect(existsSync(target)).toBe(false);
  });

  it('refuses to run without a denylist, or with one inside the repository', () => {
    const repo = source({ 'README.md': '# OpenADLC\n' });
    const target = join(work, 'public');

    const missing = spawnSync('bash', [SCRIPT, '--repo', repo, 'main', target], { env, encoding: 'utf8' });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('--denylist');
    expect(existsSync(target)).toBe(false);

    const inside = join(repo, 'private-names');
    writeFileSync(inside, 'somewhere\n');
    const nested = spawnSync('bash', [SCRIPT, '--repo', repo, '--denylist', inside, 'main', target], { env, encoding: 'utf8' });
    expect(nested.status).toBe(1);
    expect(nested.stderr).toContain('inside the repository');
    expect(existsSync(join(target, '.git'))).toBe(false);
  });

  it('refuses a denylist inside the repository that is reached through a symlink outside it', () => {
    const repo = source({ 'README.md': '# OpenADLC\n' });
    const target = join(work, 'public');
    writeFileSync(join(repo, 'private-names'), 'somewhere\n');

    // A link to the file, and a link to the repository with the file under it.
    const toFile = join(work, 'names-link');
    symlinkSync(join(repo, 'private-names'), toFile);
    const toRepo = join(work, 'repo-link');
    symlinkSync(repo, toRepo);

    for (const file of [toFile, join(toRepo, 'private-names')]) {
      const run = spawnSync('bash', [SCRIPT, '--repo', repo, '--denylist', file, 'main', target], { env, encoding: 'utf8' });
      expect(run.status, file).toBe(1);
      expect(run.stderr).toContain('inside the repository');
      expect(existsSync(join(target, '.git'))).toBe(false);
    }
  });

  it('refuses a target directory that already holds something', () => {
    const repo = source({ 'README.md': '# OpenADLC\n' });
    const target = join(work, 'public');
    mkdirSync(target);
    writeFileSync(join(target, 'stray.txt'), 'not reviewed\n');

    const run = publish(repo, target);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('is not empty');
    expect(existsSync(join(target, '.git'))).toBe(false);
  });
});
