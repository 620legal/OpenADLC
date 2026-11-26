import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const BIN = join(import.meta.dirname, '..', 'bin');
const SHIM = join(BIN, 'git');

// The decision is plain JavaScript run by the bot's own Node; its parts are tested as a module.
const check = (await import(join(BIN, 'git-check.mjs'))) as {
  readGlobals: (args: string[]) => { globals?: string[]; at?: number; refusal?: string };
  guardedEnv: (env: Record<string, string>) => Record<string, string>;
  splitAlias: (value: string) => string[];
  longOption: (arg: string, known: string[], refused: string[]) => string | null;
  withoutForce: (args: string[]) => string[];
  withoutQuiet: (args: string[]) => string[];
  dryRunRefusal: (args: string[], known?: string[]) => string | null;
  porcelainDone: (stdout: string) => boolean;
  readOnlyGlobalsRefusal: (args: string[]) => string | null;
  readOnlyEnvRefusal: (env: Record<string, string>) => string | null;
  readOnlyEnv: (env: Record<string, string>) => Record<string, string>;
  readOnlyCommandRefusal: (command: string, rest: string[]) => string | null;
  porcelainRefs: (stdout: string) => Array<{ flag: string; from: string; to: string }>;
  pushRefusal: (refs: Array<{ flag: string; to: string }>, policy: unknown) => string | null;
  localCiPushRefusal: (
    refs: Array<{ flag: string; from: string; to: string }>,
    policy: unknown,
    resolve: (ref: string) => string | null,
    passed: (sha: string) => Promise<boolean | null>,
  ) => Promise<string | null>;
};

const BUILDER = { pushBranchPrefix: 'agent/', forcePush: false, denyGithub: [] };
const REVIEWER = { pushBranchPrefix: null, forcePush: false, denyGithub: ['pr merge', 'push'] };
/** What `toolsPolicyEnv` writes for a skill that writes nothing but scratch and ADRs. */
const READ_ONLY = { ...REVIEWER, readOnly: true };

describe('reading a git command before it runs', () => {
  it('finds the command past the options git takes before it, the valued ones included', () => {
    expect(check.readGlobals(['-C', '/work/wt', '-c', 'core.x=1', '--no-pager', 'push', 'origin'])).toMatchObject({ at: 5 });
    // `--attr-source` takes a value: read as a flag, `HEAD` was taken for the command.
    expect(check.readGlobals(['--attr-source', 'HEAD', 'push', 'origin'])).toMatchObject({ at: 2 });
    expect(check.readGlobals(['commit', '-m', 'push'])).toMatchObject({ at: 0 });
  });

  it('refuses a global option it does not know, rather than guessing what it takes', () => {
    expect(check.readGlobals(['--frobnicate', 'HEAD', 'push']).refusal).toMatch(/--frobnicate is not one OpenADLC's git knows/);
  });

  it('refuses an alias or a push setting given on the command line', () => {
    expect(check.readGlobals(['-c', 'alias.p=push', 'p']).refusal).toMatch(/does not set alias\.p/);
    expect(check.readGlobals(['--config-env=alias.p=P', 'p']).refusal).toMatch(/alias\.p/);
    expect(check.readGlobals(['-c', 'remote.origin.push=+HEAD:main', 'push']).refusal).toMatch(/remote\.origin\.push/);
    expect(check.readGlobals(['-c', 'user.name=Jane Doe', 'commit'])).toMatchObject({ at: 2 });
  });

  it('drops aliases and push settings from GIT_CONFIG_*, keeps the rest, and turns autocorrect off', () => {
    const env = check.guardedEnv({
      PATH: '/bin',
      GIT_CONFIG_PARAMETERS: "'alias.p'='push'",
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'commit.gpgsign',
      GIT_CONFIG_VALUE_0: 'true',
      GIT_CONFIG_KEY_1: 'alias.p',
      GIT_CONFIG_VALUE_1: 'push',
      GIT_CONFIG_KEY_2: 'url.https://evil.example/.pushInsteadOf',
      GIT_CONFIG_VALUE_2: 'https://github.com/',
    });
    expect(env).toEqual({
      PATH: '/bin',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'commit.gpgsign',
      GIT_CONFIG_VALUE_0: 'true',
      GIT_CONFIG_KEY_1: 'help.autocorrect',
      GIT_CONFIG_VALUE_1: '0',
    });
  });

  it('reads an abbreviated long option as the option git would take it for', () => {
    const rebase = ['--onto', '--empty', '--edit-todo', '--exec'];
    expect(check.longOption('--exe', rebase, ['--exec'])).toBe('--exec');
    expect(check.longOption('--ex=make', rebase, ['--exec'])).toBe('--exec');
    expect(check.longOption('--e', rebase, ['--exec'])).toBeNull(); // ambiguous: git refuses it too
    expect(check.longOption('--onto', rebase, ['--exec'])).toBe('--onto');
    // Where git would not list its options, a prefix of a refused one counts as it.
    expect(check.longOption('--exe', [], ['--exec'])).toBe('--exec');
    expect(check.longOption('--onto', [], ['--exec'])).toBeNull();
    // Git leaves some options out of its own list; a refused one is still found.
    expect(check.longOption('--open', ['--cached', '--ignore-case'], ['--open-files-in-pager'])).toBe('--open-files-in-pager');
  });

  it('splits an alias the way git does', () => {
    expect(check.splitAlias(`push origin "HEAD:refs/heads/main" 'a b'`)).toEqual(['push', 'origin', 'HEAD:refs/heads/main', 'a b']);
  });

  it('takes every way of forcing out of a push that may not force', () => {
    // The dry run saw a fast forward, but the remote can move before the real
    // push: a `--force` left in would then rewrite what the dry run never saw.
    expect(check.withoutForce(['--force', '-uf', 'origin', '+agent/12', '--force-with-lease=agent/12', '-o', 'ci.skip'])).toEqual([
      '-u',
      'origin',
      'agent/12',
      '-o',
      'ci.skip',
    ]);
    expect(check.withoutForce(['-f', '--', 'origin', '+agent/12'])).toEqual(['--', 'origin', 'agent/12']);
  });
});

describe('what a push would change, as git says it', () => {

  it('reads each ref and how it would change from --porcelain', () => {
    const out = 'To github.com:exampleco/app.git\n+\trefs/heads/agent/7:refs/heads/main\tabc...def (forced update)\n-\t:refs/heads/old\t[deleted]\n=\trefs/heads/x:refs/heads/x\t[up to date]\nDone\n';
    expect(check.porcelainRefs(out)).toEqual([
      { flag: '+', from: 'refs/heads/agent/7', to: 'refs/heads/main' },
      { flag: '-', from: '', to: 'refs/heads/old' },
      { flag: '=', from: 'refs/heads/x', to: 'refs/heads/x' },
    ]);
  });

  it('asks its dry run loudly: a quiet one names no refs, and the push read as changing nothing', () => {
    expect(check.withoutQuiet(['-q', 'origin', 'main'])).toEqual(['origin', 'main']);
    expect(check.withoutQuiet(['--quiet', '-qf', '-o', '-q', 'origin'])).toEqual(['-f', '-o', '-q', 'origin']);
  });

  it('refuses the arguments that would turn off its dry run or porcelain output, abbreviated too', () => {
    const known = ['--dry-run', '--porcelain', '--no-dry-run', '--no-porcelain', '--no-progress', '--no-prune', '--no-push-option'];
    for (const arg of ['--no-dry-run', '--no-dry', '--no-porcelain', '--no-porc']) {
      expect(check.dryRunRefusal(['origin', arg, 'HEAD:main'], known)).toMatch(/turn off the dry run/);
    }
    // Where git will not list its options, the refused names are still caught.
    expect(check.dryRunRefusal(['--no-porc', 'origin'])).toMatch(/turn off the dry run/);
    expect(check.dryRunRefusal(['--no-progress', '-o', '--no-dry-run', 'origin', '--', '--no-porcelain'], known)).toBeNull();
  });

  it('reads a dry run as porcelain only when git finished it with Done', () => {
    expect(check.porcelainDone('To ../remote.git\n=\tHEAD:refs/heads/main\t[up to date]\nDone\n')).toBe(true);
    expect(check.porcelainDone('Done\n')).toBe(true);
    expect(check.porcelainDone('')).toBe(false);
    expect(check.porcelainDone('To ../remote.git\n')).toBe(false);
  });

  it('needs a recorded local CI pass for each commit a builder’s push would put on a branch', async () => {
    const LOCAL_CI = { ...BUILDER, localCi: true };
    const sha = 'b'.repeat(40);
    const refs = [
      { flag: '*', from: 'refs/heads/agent/12', to: 'refs/heads/agent/12' },
      { flag: '=', from: 'refs/heads/agent/9', to: 'refs/heads/agent/9' },
      { flag: '-', from: '', to: 'refs/heads/agent/old' },
    ];
    const asked: string[] = [];
    const passed = (answer: boolean | null) => async (commit: string) => (asked.push(commit), answer);

    expect(await check.localCiPushRefusal(refs, LOCAL_CI, () => sha, passed(true))).toBeNull();
    // Only the commit the push would add: one already there, or a deletion, asks nothing.
    expect(asked).toEqual([sha]);
    expect(await check.localCiPushRefusal(refs, LOCAL_CI, () => sha, passed(false))).toMatch(/bbbbbbb \(refs\/heads\/agent\/12\) has no recorded local CI pass: run openadlc-ci/);
    expect(await check.localCiPushRefusal(refs, LOCAL_CI, () => sha, passed(null))).toMatch(/could not ask the bridge/);
    expect(await check.localCiPushRefusal(refs, BUILDER, () => sha, passed(false))).toBeNull();
  });

  it('lets a builder push its own branch and nothing else', () => {
    expect(check.pushRefusal([{ flag: '*', to: 'refs/heads/agent/builder/12' }], BUILDER)).toBeNull();
    expect(check.pushRefusal([{ flag: ' ', to: 'refs/heads/main' }], BUILDER)).toMatch(/only to branches starting with agent\/.*refs\/heads\/main/);
    expect(check.pushRefusal([{ flag: '*', to: 'refs/tags/v1' }], BUILDER)).toMatch(/refs\/tags\/v1/);
  });

  it('refuses a forced update unless the skill allows one', () => {
    expect(check.pushRefusal([{ flag: '+', to: 'refs/heads/agent/12' }], BUILDER)).toMatch(/forced update/);
    expect(check.pushRefusal([{ flag: '+', to: 'refs/heads/agent/12' }], { ...BUILDER, forcePush: true })).toBeNull();
  });

  it('refuses every push from a skill with no push prefix', () => {
    expect(check.pushRefusal([{ flag: '*', to: 'refs/heads/agent/12' }], REVIEWER)).toMatch(/does not push/);
  });
});

describe('OpenADLC’s git beside another copy of itself', () => {
  it('runs the real git, not the other copy, which it once exec’d back and forth with for good', () => {
    // A task's container has the install's copy at /opt/openadlc/bin, first on
    // PATH, and these tests put the worktree's before it: `make ci` hung on
    // the first `git add` here in every task, and no build could finish.
    const other = mkdtempSync(join(tmpdir(), 'openadlc-other-shims-'));
    try {
      cpSync(BIN, other, { recursive: true });
      const ran = spawnSync(SHIM, ['--version'], {
        env: { ...process.env, PATH: `${BIN}:${other}:${process.env.PATH ?? ''}`, OPENADLC_TOOLS_POLICY: '' },
        encoding: 'utf8',
        timeout: 10_000,
        killSignal: 'SIGKILL',
      });
      expect(ran.error).toBeUndefined();
      expect(ran.status).toBe(0);
      expect(ran.stdout).toMatch(/^git version /);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('OpenADLC’s git behind a stand-in git that runs it', () => {
  // hostd's worktree tests put a git that writes down what it was asked first
  // on PATH, and have it run the git they found there before: in a task's
  // container, this one. This took theirs for the real git and the two exec'd
  // each other for good, so those tests timed out in every task's `make ci`;
  // with a skill's rules set, each pass started one more git-check.mjs until
  // the container could start no process, the builder's engine with it. The
  // stand-in here gives up after a few runs, so a loop fails at once rather
  // than filling the machine.
  it.each([
    ['with no rules', ''],
    ['with a skill’s rules set', JSON.stringify(BUILDER)],
  ])('runs the git after it on PATH, not the stand-in before it, %s', (_name, policy) => {
    const dir = mkdtempSync(join(tmpdir(), 'openadlc-stand-in-git-'));
    try {
      const runs = join(dir, 'runs');
      writeFileSync(
        join(dir, 'git'),
        [
          '#!/bin/sh',
          `[ -f '${runs}' ] && [ "$(wc -l < '${runs}')" -ge 5 ] && { echo 'the stand-in was run again' >&2; exit 97; }`,
          `echo "$*" >> '${runs}'`,
          `exec '${SHIM}' "$@"`,
          '',
        ].join('\n'),
      );
      chmodSync(join(dir, 'git'), 0o755);
      const ran = spawnSync(join(dir, 'git'), ['version'], {
        env: { ...process.env, PATH: `${dir}:${BIN}:${process.env.PATH ?? ''}`, OPENADLC_TOOLS_POLICY: policy },
        encoding: 'utf8',
        timeout: 20_000,
        killSignal: 'SIGKILL',
      });
      expect(ran.error).toBeUndefined();
      expect(ran.stderr).toBe('');
      expect(ran.status).toBe(0);
      expect(ran.stdout).toMatch(/^git version /);
      expect(readFileSync(runs, 'utf8')).toBe('version\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says there is no git after it on PATH, rather than that git is not installed, when one is only before it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openadlc-stand-in-git-'));
    try {
      const [stand, tools] = [join(dir, 'stand-in'), join(dir, 'tools')];
      mkdirSync(stand);
      mkdirSync(tools);
      writeFileSync(join(stand, 'git'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(stand, 'git'), 0o755);
      // What the wrapper itself runs, and no git.
      symlinkSync(execFileSync('sh', ['-c', 'command -v dirname'], { encoding: 'utf8' }).trim(), join(tools, 'dirname'));
      const ran = spawnSync(SHIM, ['version'], { env: { PATH: [stand, BIN, tools].join(':'), OPENADLC_TOOLS_POLICY: '' }, encoding: 'utf8', timeout: 10_000 });
      expect(ran.status).toBe(127);
      expect(ran.stderr).toBe(`git: no git after OpenADLC's (${BIN}) on PATH; put the real git's directory after it\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('OpenADLC’s git, pushing to a real remote', () => {
  let dir: string;
  let work: string;
  let remote: string;

  const env = (policy: unknown) => ({
    ...process.env,
    PATH: `${BIN}:${process.env.PATH ?? ''}`,
    GIT_AUTHOR_NAME: 'Jane Doe',
    GIT_AUTHOR_EMAIL: 'janedoe@example.com',
    GIT_COMMITTER_NAME: 'Jane Doe',
    GIT_COMMITTER_EMAIL: 'janedoe@example.com',
    ...(policy ? { OPENADLC_TOOLS_POLICY: JSON.stringify(policy) } : { OPENADLC_TOOLS_POLICY: '' }),
  });
  const git = (args: string[], policy: unknown = null) =>
    spawnSync(SHIM, args, { cwd: work, env: env(policy), encoding: 'utf8' });
  const remoteHas = (branch: string) =>
    spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: remote }).status === 0;
  const commit = (file: string) => {
    writeFileSync(join(work, file), file);
    expect(git(['add', file]).status).toBe(0);
    expect(git(['commit', '-q', '-m', `add ${file}`]).status).toBe(0);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openadlc-git-shim-'));
    remote = join(dir, 'remote.git');
    work = join(dir, 'work');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    execFileSync('git', ['init', '-q', '-b', 'main', work]);
    commit('README.md');
    expect(git(['remote', 'add', 'origin', remote]).status).toBe(0);
    expect(git(['push', '-q', 'origin', 'main']).status).toBe(0);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('pushes a builder’s own branch', () => {
    expect(git(['switch', '-q', '-c', 'agent/12']).status).toBe(0);
    commit('change.ts');

    const pushed = git(['push', '-q', 'origin', 'HEAD'], BUILDER);

    expect(pushed.stderr).toBe('');
    expect(pushed.status).toBe(0);
    expect(remoteHas('agent/12')).toBe(true);
  });

  it('refuses a builder’s push to main, however it is spelled', () => {
    commit('change.ts');
    for (const args of [['push', 'origin', 'main'], ['push', '-q', 'origin', 'main'], ['push', 'origin', 'HEAD:refs/heads/main'], ['-C', work, 'push', '--all', 'origin']]) {
      const pushed = git(args, BUILDER);
      expect(pushed.status).toBe(1);
      expect(pushed.stderr).toMatch(/not running — .*agent\//);
    }
    expect(spawnSync('git', ['rev-parse', 'main'], { cwd: remote, encoding: 'utf8' }).stdout).not.toBe(
      spawnSync('git', ['rev-parse', 'main'], { cwd: work, encoding: 'utf8' }).stdout,
    );
  });

  it('refuses a push that would turn off its dry run, before anything is pushed', () => {
    commit('change.ts');
    const before = spawnSync('git', ['rev-parse', 'main'], { cwd: remote, encoding: 'utf8' }).stdout;
    for (const flag of ['--no-porcelain', '--no-porc', '--no-dry-run', '--no-dry']) {
      const pushed = git(['push', flag, 'origin', 'HEAD:refs/heads/main'], BUILDER);
      expect(pushed.status).toBe(1);
      expect(pushed.stderr).toMatch(/git: not running — .*dry run/);
      expect(spawnSync('git', ['rev-parse', 'main'], { cwd: remote, encoding: 'utf8' }).stdout).toBe(before);
    }
  });

  it('refuses a push whose dry run printed nothing it could read', () => {
    // A git whose dry run exits 0 and says nothing: no refs is not the same as no change.
    const fake = join(dir, 'fake-git');
    writeFileSync(fake, '#!/bin/sh\ncase " $* " in *" --dry-run "*) exit 0 ;; esac\necho pushed >&2\nexit 0\n');
    chmodSync(fake, 0o755);
    const pushed = spawnSync('node', [join(BIN, 'git-check.mjs'), fake, 'push', 'origin', 'HEAD:refs/heads/main'], {
      cwd: work,
      env: env(BUILDER),
      encoding: 'utf8',
    });
    expect(pushed.status).toBe(1);
    expect(pushed.stderr).toMatch(/not running — the dry run's output could not be read/);
    expect(pushed.stderr).not.toMatch(/pushed/);
  });

  it('refuses a forced update of the builder’s own branch', () => {
    expect(git(['switch', '-q', '-c', 'agent/12']).status).toBe(0);
    commit('one.ts');
    expect(git(['push', '-q', 'origin', 'agent/12'], BUILDER).status).toBe(0);
    expect(git(['reset', '-q', '--hard', 'HEAD~1']).status).toBe(0);
    commit('two.ts');

    for (const args of [['push', '--force', 'origin', 'agent/12'], ['push', 'origin', '+agent/12']]) {
      const pushed = git(args, BUILDER);
      expect(pushed.status).toBe(1);
      expect(pushed.stderr).toMatch(/forced update/);
    }
  });

  it('refuses any push from a reviewer', () => {
    expect(git(['switch', '-q', '-c', 'agent/12']).status).toBe(0);
    commit('change.ts');

    const pushed = git(['push', 'origin', 'agent/12'], REVIEWER);

    expect(pushed.status).toBe(1);
    expect(pushed.stderr).toMatch(/does not push/);
    expect(remoteHas('agent/12')).toBe(false);
  });

  describe('the ways past a guard that read only `push`', () => {
    // A reviewer took each of these to main against the first version, with no
    // full path to the real git.
    const mainOnRemote = () => spawnSync('git', ['rev-parse', 'main'], { cwd: remote, encoding: 'utf8' }).stdout.trim();

    it('an alias on the command line', () => {
      commit('change.ts');
      const before = mainOnRemote();

      const pushed = git(['-c', 'alias.p=push', 'p', 'origin', 'HEAD:main'], BUILDER);

      expect(pushed.status).toBe(1);
      expect(pushed.stderr).toMatch(/does not set alias\.p/);
      expect(mainOnRemote()).toBe(before);
    });

    it('an alias in GIT_CONFIG_*, which is dropped before git reads it', () => {
      commit('change.ts');
      const before = mainOnRemote();

      const pushed = spawnSync(SHIM, ['p', 'origin', 'HEAD:main'], {
        cwd: work,
        encoding: 'utf8',
        env: { ...env(BUILDER), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'alias.p', GIT_CONFIG_VALUE_0: 'push' },
      });

      expect(pushed.status).not.toBe(0);
      expect(mainOnRemote()).toBe(before);
    });

    it('an alias in the repository’s own configuration, which is read as git would read it', () => {
      commit('change.ts');
      const before = mainOnRemote();
      expect(git(['config', 'alias.p', 'push origin'], BUILDER).status).toBe(0);
      expect(git(['config', 'alias.sh', '!git push origin HEAD:main'], BUILDER).status).toBe(0);

      const viaAlias = git(['p', 'HEAD:main'], BUILDER);
      expect(viaAlias.status).toBe(1);
      expect(viaAlias.stderr).toMatch(/only to branches starting with agent\//);
      const viaShell = git(['sh'], BUILDER);
      expect(viaShell.status).toBe(1);
      expect(viaShell.stderr).toMatch(/runs a shell command/);
      expect(mainOnRemote()).toBe(before);
    });

    it('send-pack, which pushes without being push', () => {
      commit('change.ts');
      const before = mainOnRemote();

      const pushed = git(['send-pack', remote, 'HEAD:refs/heads/main'], BUILDER);

      expect(pushed.status).toBe(1);
      expect(pushed.stderr).toMatch(/send-pack updates a remote's refs/);
      expect(mainOnRemote()).toBe(before);
    });

    it('a global option that takes a value, read as the command', () => {
      commit('change.ts');
      const before = mainOnRemote();

      const pushed = git(['--attr-source', 'HEAD', 'push', 'origin', 'HEAD:main'], BUILDER);

      // Held on every git. One that does not know the option (Debian 12's
      // 2.39, which the bot image has) stops at its own usage error, 129,
      // before the shim's refusal is reached.
      expect(pushed.status).not.toBe(0);
      expect(mainOnRemote()).toBe(before);
      if (spawnSync('git', ['--attr-source', 'HEAD', 'version']).status === 0) {
        expect(pushed.status).toBe(1);
        expect(pushed.stderr).toMatch(/only to branches starting with agent\//);
      }
    });

    it('commands that run a command of their own, whose git is not this one', () => {
      commit('change.ts');
      const before = mainOnRemote();
      const push = 'git push origin HEAD:main';

      for (const [args, refusal] of [
        [['rebase', '--exec', push, 'HEAD~1'], /git rebase \S+ runs a command/],
        [['rebase', `--exec=${push}`, 'HEAD~1'], /git rebase \S+ runs a command/],
        [['rebase', '-x', push, 'HEAD~1'], /git rebase \S+ runs a command/],
        [['rebase', '-ix', push, 'HEAD~1'], /git rebase \S+ runs a command/],
        // Git takes a unique prefix of a long option as the option.
        [['rebase', '--exe', push, 'HEAD~1'], /git rebase --exe runs a command/],
        [['rebase', `--ex=${push}`, 'HEAD~1'], /git rebase --ex runs a command/],
        [['difftool', '--extc', push, 'HEAD~1'], /git difftool --extc runs a command/],
        [['difftool', '-x', push, 'HEAD~1'], /git difftool -x runs a command/],
        [['fetch', `--upload-p=${push}`, 'origin'], /git fetch --upload-p runs a command/],
        [['filter-branch', '--tree-filter', push], /filter-branch/],
        [['archive', `--remote=${remote}`, `--exec=${push}`, 'HEAD'], /git archive --exec runs a command/],
        [['archive', `--remote=${remote}`, '--exe', push, 'HEAD'], /git archive --exe runs a command/],
        [['fetch-pack', `--upload-pack=${push}`, remote], /git fetch-pack --upload-pack runs a command/],
        [['fetch-pack', `--exec=${push}`, remote], /git fetch-pack --exec runs a command/],
        [['grep', '-O', 'x'], /git grep -O runs a command/],
        [['grep', `-O${push}`, 'x'], /git grep -O/],
        [['grep', '-iO', 'x'], /git grep -iO runs a command/],
        [['grep', `--open-files-in-pager=${push}`, 'x'], /git grep --open-files-in-pager runs a command/],
        [['grep', '--open', 'x'], /git grep --open runs a command/],
        [['bisect', 'run', 'sh', '-c', push], /bisect run/],
        [['submodule', 'foreach', push], /submodule foreach/],
        [['submodule', '--quiet', 'foreach', push], /submodule foreach/],
      ] as const) {
        const ran = git([...args], BUILDER);
        expect(ran.status, args.join(' ')).toBe(1);
        expect(ran.stderr).toMatch(refusal);
      }
      expect(mainOnRemote()).toBe(before);
    });

    it('still runs a rebase, a bisect and a submodule command that run nothing', () => {
      commit('two.ts');
      expect(git(['rebase', '-q', '-Xours', 'HEAD~1'], BUILDER).status).toBe(0);
      expect(git(['submodule', 'status'], BUILDER).status).toBe(0);
      expect(git(['bisect', 'log'], BUILDER).stderr).not.toMatch(/not running/);
      expect(git(['grep', '-n', '-i', 'two', 'HEAD'], BUILDER).stdout).toContain('two.ts');
      expect(git(['archive', '--format=tar', '-o', join(dir, 'out.tar'), 'HEAD'], BUILDER).status).toBe(0);
    });

    it('still runs an ordinary alias and everything that pushes nothing', () => {
      expect(git(['config', 'alias.st', 'status --short'], BUILDER).status).toBe(0);
      writeFileSync(join(work, 'new.ts'), 'x');
      expect(git(['st'], BUILDER).stdout).toContain('?? new.ts');
      expect(git(['-C', work, '--no-pager', 'log', '-1', '--format=%s'], BUILDER).stdout.trim()).toBe('add README.md');
    });
  });

  it('leaves a person’s shell, with no rules, alone', () => {
    commit('change.ts');
    expect(git(['push', '-q', 'origin', 'main']).status).toBe(0);
  });

  it('runs every other command as git would, `push` in a message included', () => {
    writeFileSync(join(work, 'x.ts'), 'x');
    expect(git(['add', 'x.ts'], BUILDER).status).toBe(0);
    expect(git(['commit', '-q', '-m', 'push'], BUILDER).status).toBe(0);
    expect(git(['log', '-1', '--format=%s'], BUILDER).stdout.trim()).toBe('push');
  });
});

describe('OpenADLC’s git, pushing a commit local CI has not passed', () => {
  // A builder that skipped `openadlc-ci` pushed and opened its pull request,
  // and GitHub's CI — which now runs only after the lead approves — was the
  // first thing to run the checks.
  let dir: string;
  let work: string;
  let bridge: Server;
  let passes: Set<string>;

  const run = (args: string[], env: Record<string, string>) =>
    new Promise<{ status: number | null; stderr: string }>((resolve) => {
      const child = spawn(SHIM, args, { cwd: work, env: { ...process.env, PATH: `${BIN}:${process.env.PATH ?? ''}`, ...env } });
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('close', (status) => resolve({ status, stderr }));
    });

  beforeEach(async () => {
    passes = new Set();
    bridge = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        const sha = (JSON.parse(body || '{}') as { sha?: string }).sha ?? '';
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ passed: passes.has(sha) }));
      });
    });
    await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
    dir = mkdtempSync(join(tmpdir(), 'openadlc-git-ci-'));
    const remote = join(dir, 'remote.git');
    work = join(dir, 'work');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    execFileSync('git', ['init', '-q', '-b', 'agent/12', work]);
    execFileSync('git', ['-c', 'user.name=Jane', '-c', 'user.email=j@example.com', 'commit', '-q', '--allow-empty', '-m', 'work'], { cwd: work });
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: work });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => bridge.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('is refused until the bridge has a pass recorded for that commit', async () => {
    const env = {
      OPENADLC_TOOLS_POLICY: JSON.stringify({ ...BUILDER, localCi: true }),
      OPENADLC_BRIDGE_URL: `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`,
      OPENADLC_TASK_ID: 'task-1',
    };
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim();

    const refused = await run(['push', '-q', 'origin', 'agent/12'], env);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/has no recorded local CI pass: run openadlc-ci/);

    const unread = await run(['push', '--no-porcelain', 'origin', 'HEAD:refs/heads/agent/x'], env);
    expect(unread.status).toBe(1);
    expect(unread.stderr).toMatch(/not running — .*dry run/);

    passes.add(head);
    const pushed = await run(['push', '-q', 'origin', 'agent/12'], env);
    expect(pushed.stderr).toBe('');
    expect(pushed.status).toBe(0);
  });
});

describe('OpenADLC’s git, for a skill that writes nothing', () => {
  // A read-only skill could still write a file or start a program through the
  // read commands it is allowed — `git log --output=x`, `git -c
  // diff.external=x diff` — and no engine rule sees those arguments.
  it('refuses every -c and --config-env, and the options that move the repository or git’s programs', () => {
    for (const args of [
      ['-c', 'core.pager=sh x', 'log'],
      ['-c', 'core.editor=./x', 'commit'],
      ['-c', 'diff.external=./x', 'diff'],
      ['-c', 'diff.x.textconv=./x', 'diff'],
      ['-c', 'diff.x.command=./x', 'diff'],
      ['-c', 'core.fsmonitor=./x', 'status'],
      ['-c', 'core.sshCommand=./x', 'fetch'],
      ['-c', 'core.hooksPath=.', 'log'],
      ['-c', 'core.askPass=./x', 'fetch'],
      ['-c', 'credential.helper=!./x', 'fetch'],
      ['-c', 'filter.x.smudge=./x', 'checkout'],
      ['-c', 'pager.log=./x', 'log'],
      ['-c', 'include.path=../x', 'log'],
      ['-c', 'user.name=x', 'log'],
      ['-C', '/w', '--config-env', 'core.pager=PAGER_CMD', 'log'],
      ['--config-env=core.pager=PAGER_CMD', 'log'],
    ]) {
      expect(check.readOnlyGlobalsRefusal(args), args.join(' ')).toMatch(
        /does not set git configuration on the command line \((-c|--config-env) [\w.]+=…\): a setting can name a program to run/,
      );
    }
    for (const args of [['--work-tree', '.git/hooks', 'checkout'], ['--work-tree=.git/hooks', 'checkout'], ['--git-dir', 'x', 'log'], ['--git-dir=x', 'log']]) {
      expect(check.readOnlyGlobalsRefusal(args), args.join(' ')).toMatch(/does not point git at another repository or work tree/);
    }
    expect(check.readOnlyGlobalsRefusal(['--exec-path=/tmp/x', 'log'])).toMatch(/--exec-path/);
    // What a read-only skill does run.
    expect(check.readOnlyGlobalsRefusal(['-C', '/w', '--no-pager', 'log', '-c'])).toBeNull();
    expect(check.readOnlyGlobalsRefusal(['--exec-path'])).toBeNull();
    expect(check.readOnlyGlobalsRefusal(['log', '--git-dir=x'])).toBeNull();
  });

  const HOSTD_CONFIG = {
    GIT_CONFIG_COUNT: '5',
    GIT_CONFIG_KEY_0: 'gpg.format',
    GIT_CONFIG_VALUE_0: 'ssh',
    GIT_CONFIG_KEY_1: 'user.signingkey',
    GIT_CONFIG_VALUE_1: 'key::ssh-ed25519 AAAA',
    GIT_CONFIG_KEY_2: 'commit.gpgsign',
    GIT_CONFIG_VALUE_2: 'true',
    GIT_CONFIG_KEY_3: 'gpg.ssh.program',
    GIT_CONFIG_VALUE_3: '/usr/bin/ssh-keygen',
    GIT_CONFIG_KEY_4: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_4: '!gh auth git-credential',
  };

  it('lets through the GIT_CONFIG_* entries hostd gives every session, and refuses any other', () => {
    expect(check.readOnlyEnvRefusal({})).toBeNull();
    expect(check.readOnlyEnvRefusal(HOSTD_CONFIG)).toBeNull();
    // Section and name compare as git compares them; the subsection keeps its case.
    expect(
      check.readOnlyEnvRefusal({
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'GPG.Format',
        GIT_CONFIG_VALUE_0: 'ssh',
        GIT_CONFIG_KEY_1: 'Credential.https://github.com.Helper',
        GIT_CONFIG_VALUE_1: '!gh auth git-credential',
      }),
    ).toBeNull();
    // What guardedEnv adds, as a git that this git runs sees it.
    expect(check.readOnlyEnvRefusal({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'help.autocorrect', GIT_CONFIG_VALUE_0: '0' })).toBeNull();

    const one = (key: string, value: string) => ({ ...HOSTD_CONFIG, GIT_CONFIG_COUNT: '6', GIT_CONFIG_KEY_5: key, GIT_CONFIG_VALUE_5: value });
    for (const key of ['core.pager', 'diff.external', 'diff.x.textconv', 'core.fsmonitor', 'credential.helper', 'alias.l', 'user.name']) {
      expect(check.readOnlyEnvRefusal(one(key, './x')), key).toMatch(new RegExp(`does not set ${key.replace(/\./g, '\\.')} through GIT_CONFIG_KEY_5`));
    }
    expect(check.readOnlyEnvRefusal({ ...HOSTD_CONFIG, GIT_CONFIG_VALUE_4: '!sh ./x' })).toMatch(
      /does not change credential\.https:\/\/github\.com\.helper from the value hostd gives it/,
    );
    expect(check.readOnlyEnvRefusal({ ...HOSTD_CONFIG, GIT_CONFIG_VALUE_3: './ssh-keygen' })).toMatch(/gpg\.ssh\.program/);
    expect(check.readOnlyEnvRefusal({ ...HOSTD_CONFIG, GIT_CONFIG_VALUE_3: '/tmp/x' })).toMatch(/gpg\.ssh\.program/);
    expect(check.readOnlyEnvRefusal({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'help.autocorrect', GIT_CONFIG_VALUE_0: 'immediate' })).toMatch(/help\.autocorrect/);
  });

  it('runs git with every variable that names a program set to one that does nothing, or taken out', () => {
    const env = check.readOnlyEnv({
      PATH: '/bin',
      GIT_PAGER: 'sh x',
      PAGER: 'sh x',
      GIT_EDITOR: 'sh x',
      GIT_SEQUENCE_EDITOR: 'sh x',
      GIT_EXTERNAL_DIFF: 'x',
      GIT_SSH: 'x',
      GIT_SSH_COMMAND: 'x',
      GIT_ASKPASS: 'x',
      SSH_ASKPASS: 'x',
      GIT_EXEC_PATH: '/tmp',
    });
    expect(env).toEqual({ PATH: '/bin', GIT_PAGER: 'cat', PAGER: 'cat', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' });
  });

  it('refuses the options that write a file, abbreviated too, and the commands that run a tool', () => {
    for (const command of ['log', 'show', 'diff', 'format-patch', 'diff-tree', 'range-diff', 'archive']) {
      for (const rest of [['--output=x'], ['--output', 'x'], ['-1', '--outp=x'], ['--ou', 'x']]) {
        expect(check.readOnlyCommandRefusal(command, rest), `${command} ${rest.join(' ')}`).toMatch(new RegExp(`git ${command} --o\\w* writes a file`));
      }
    }
    for (const rest of [['-o', 'd'], ['-od'], ['-ko', 'd'], ['--output-directory', 'd'], ['--output-dir=d']]) {
      expect(check.readOnlyCommandRefusal('format-patch', rest), rest.join(' ')).toMatch(/git format-patch -\S+ writes a file/);
    }
    expect(check.readOnlyCommandRefusal('archive', ['-o', 'x.tar', 'HEAD'])).toMatch(/git archive -o writes a file/);
    for (const command of ['difftool', 'mergetool', 'instaweb']) {
      expect(check.readOnlyCommandRefusal(command, [])).toMatch(new RegExp(`git ${command} runs a tool program`));
    }
    // What a read-only skill does run.
    expect(check.readOnlyCommandRefusal('diff', ['--output-indicator-new=+'])).toBeNull();
    expect(check.readOnlyCommandRefusal('log', ['--oneline', '-5'])).toBeNull();
    expect(check.readOnlyCommandRefusal('log', ['--', '--output=x'])).toBeNull();
    expect(check.readOnlyCommandRefusal('grep', ['-o', 'x'])).toBeNull();
    expect(check.readOnlyCommandRefusal('ls-files', ['-o'])).toBeNull();
    expect(check.readOnlyCommandRefusal('format-patch', ['-1', '--stdout'])).toBeNull();
  });

  it('lets git config read and refuses it writing or opening an editor', () => {
    for (const rest of [
      ['core.pager', 'sh x'],
      ['--global', 'core.pager', 'sh x'],
      ['--file', '.git/config', 'core.pager', 'x'],
      ['-e'],
      ['--edit'],
      ['--ed'],
      ['--add', 'core.pager', 'x'],
      ['--ad', 'core.pager', 'x'],
      ['--unset', 'core.pager'],
      ['--unset-all', 'core.pager'],
      ['--replace-all', 'core.pager', 'x'],
      ['--rename-section', 'a', 'b'],
      ['--remove-section', 'a'],
      ['set', 'core.pager', 'x'],
      ['unset', 'core.pager'],
      ['edit'],
      [],
    ]) {
      expect(check.readOnlyCommandRefusal('config', rest), rest.join(' ')).toMatch(/only reads git configuration/);
    }
    for (const rest of [
      ['--get', 'user.name'],
      ['--get-all', 'remote.origin.fetch'],
      ['--get-regexp', '^remote\\.', 'x'],
      ['--list'],
      ['-l'],
      ['--show-origin', '--list'],
      ['get', 'user.name'],
      ['list'],
      ['user.name'],
      ['--file', '.gitmodules', '--get-regexp', 'path'],
      ['-f', '.gitmodules', 'submodule.x.path'],
    ]) {
      expect(check.readOnlyCommandRefusal('config', rest), rest.join(' ')).toBeNull();
    }
  });
});

describe('OpenADLC’s git, for a skill that writes nothing, in a real repository', () => {
  let dir: string;
  let work: string;
  let recorder: string;
  let record: string;

  const git = (args: string[], policy: unknown, extra: Record<string, string> = {}) =>
    spawnSync(SHIM, args, {
      cwd: work,
      env: { ...process.env, PATH: `${BIN}:${process.env.PATH ?? ''}`, OPENADLC_TOOLS_POLICY: policy ? JSON.stringify(policy) : '', ...extra },
      encoding: 'utf8',
    });
  const ran = () => existsSync(record);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openadlc-git-read-only-'));
    work = join(dir, 'work');
    record = join(dir, 'ran');
    recorder = join(dir, 'recorder.sh');
    writeFileSync(recorder, `#!/bin/sh\necho "$*" >> '${record}'\n`);
    chmodSync(recorder, 0o755);
    execFileSync('git', ['init', '-q', '-b', 'main', work]);
    writeFileSync(join(work, 'a.txt'), 'one\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: work });
    execFileSync('git', ['-c', 'user.name=Jane', '-c', 'user.email=j@example.com', 'commit', '-q', '-m', 'one'], { cwd: work });
    writeFileSync(join(work, 'a.txt'), 'two\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writesAFile = (out: string) => [
    ['log', `--output=${out}`],
    ['log', '--output', out],
    ['show', `--output=${out}`],
    ['show', '--output', out],
    ['diff', `--output=${out}`],
    ['diff', '--output', out],
    ['format-patch', '-1', `--output=${out}`],
    ['format-patch', '-1', '--output', out],
    ['format-patch', '-1', '-o', out],
    ['format-patch', '-1', `-o${out}`],
  ];

  it('refuses --output and format-patch -o, and writes no file', () => {
    const out = join(dir, 'out');
    // An abbreviation is refused too, though the git here does not take one.
    for (const args of [...writesAFile(out), ['log', `--outp=${out}`]]) {
      const refused = git(args, READ_ONLY);
      expect(refused.status, args.join(' ')).toBe(1);
      expect(refused.stderr).toMatch(/^git: not running — git (log|show|diff|format-patch) -[-\w]* writes a file, and a task that writes nothing writes none\n$/);
      expect(existsSync(out), args.join(' ')).toBe(false);
    }
  });

  it('writes the file for a skill with a write scope, and for a policy written before readOnly', () => {
    const out = join(dir, 'out');
    for (const policy of [BUILDER, REVIEWER, { ...REVIEWER, readOnly: false }]) {
      for (const args of writesAFile(out)) {
        const ran = git(args, policy);
        expect(ran.stderr, `${JSON.stringify(policy)} ${args.join(' ')}`).not.toMatch(/not running/);
        expect(ran.status).toBe(0);
        expect(existsSync(out)).toBe(true);
        rmSync(out, { recursive: true, force: true });
      }
    }
  });

  it('starts no program named in -c, --config-env or GIT_CONFIG_*', () => {
    const refusals: Array<[string[], Record<string, string>]> = [
      [['-c', `diff.external=${recorder}`, 'diff'], {}],
      [['-c', `core.pager=${recorder}`, '-p', 'log'], {}],
      [['-c', `core.fsmonitor=${recorder}`, 'status'], {}],
      [['--config-env', 'diff.external=RECORDER', 'diff'], { RECORDER: recorder }],
      [['--config-env=diff.external=RECORDER', 'diff'], { RECORDER: recorder }],
      [['diff'], { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.external', GIT_CONFIG_VALUE_0: recorder }],
      [['status'], { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: recorder }],
    ];
    for (const [args, extra] of refusals) {
      const refused = git(args, READ_ONLY, extra);
      expect(refused.status, args.join(' ')).toBe(1);
      expect(refused.stderr).toMatch(/^git: not running — a task that writes nothing does not set /);
      expect(ran(), args.join(' ')).toBe(false);
    }
    // The same for a builder starts the program, so the refusal is what stopped it.
    expect(git(['-c', `diff.external=${recorder}`, 'diff'], BUILDER).status).toBe(0);
    expect(ran()).toBe(true);
    rmSync(record);
    expect(git(['diff'], BUILDER, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.external', GIT_CONFIG_VALUE_0: recorder }).status).toBe(0);
    expect(ran()).toBe(true);
  });

  it('runs a diff with GIT_EXTERNAL_DIFF taken out, so the program it names never starts', () => {
    const diffed = git(['diff'], READ_ONLY, { GIT_EXTERNAL_DIFF: recorder });
    expect(diffed.status).toBe(0);
    expect(diffed.stdout).toContain('+two');
    expect(ran()).toBe(false);

    expect(git(['diff'], BUILDER, { GIT_EXTERNAL_DIFF: recorder }).status).toBe(0);
    expect(ran()).toBe(true);
  });

  it('refuses a config write, leaving the configuration as it was', () => {
    for (const args of [['config', 'core.pager', recorder], ['config', '--add', 'core.pager', recorder], ['config', '-e']]) {
      const refused = git(args, READ_ONLY, { EDITOR: recorder });
      expect(refused.status, args.join(' ')).toBe(1);
      expect(refused.stderr).toMatch(/only reads git configuration/);
    }
    expect(spawnSync('git', ['config', '--get', 'core.pager'], { cwd: work }).status).toBe(1);
    expect(ran()).toBe(false);
  });

  it('refuses --work-tree, --git-dir, difftool and mergetool', () => {
    for (const [args, refusal] of [
      [['--work-tree=.git/hooks', 'checkout', 'HEAD', '--', 'a.txt'], /another repository or work tree \(--work-tree\)/],
      [['--git-dir', '.git', 'log'], /another repository or work tree \(--git-dir\)/],
      [['difftool', '-y', `--extcmd=${recorder}`], /git difftool runs a tool program/],
      [['mergetool'], /git mergetool runs a tool program/],
    ] as const) {
      const refused = git([...args], READ_ONLY);
      expect(refused.status, args.join(' ')).toBe(1);
      expect(refused.stderr).toMatch(refusal);
    }
    expect(existsSync(join(work, '.git', 'hooks', 'a.txt'))).toBe(false);
    expect(ran()).toBe(false);
  });

  it('runs what a read-only skill reads, with hostd’s own settings in its environment', () => {
    const hostd = {
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'gpg.format',
      GIT_CONFIG_VALUE_0: 'ssh',
      GIT_CONFIG_KEY_1: 'commit.gpgsign',
      GIT_CONFIG_VALUE_1: 'true',
      GIT_CONFIG_KEY_2: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_2: '!gh auth git-credential',
    };
    expect(git(['log', '--format=%s'], READ_ONLY, hostd).stdout).toBe('one\n');
    expect(git(['diff', '--output-indicator-new=>'], READ_ONLY, hostd).stdout).toContain('>two');
    expect(git(['grep', '-o', 'tw'], READ_ONLY, hostd).stdout).toBe('a.txt:tw\n');
    expect(git(['--no-pager', 'log', '--oneline', '-1'], READ_ONLY, hostd).status).toBe(0);
    execFileSync('git', ['config', 'user.name', 'Jane'], { cwd: work });
    expect(git(['config', '--get', 'user.name'], READ_ONLY, hostd).stdout).toBe('Jane\n');
    expect(git(['config', 'user.name'], READ_ONLY, hostd).stdout).toBe('Jane\n');
  });
});
