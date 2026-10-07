import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(await check.localCiPushRefusal(refs, LOCAL_CI, () => sha, passed(false))).toMatch(/bbbbbbb \(refs\/heads\/agent\/12\) has no recorded local CI pass: run fleetadlc-ci/);
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
    ...(policy ? { FLEETADLC_TOOLS_POLICY: JSON.stringify(policy) } : { FLEETADLC_TOOLS_POLICY: '' }),
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
    dir = mkdtempSync(join(tmpdir(), 'fleetadlc-git-shim-'));
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
  // A builder that skipped `fleetadlc-ci` pushed and opened its pull request,
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
    dir = mkdtempSync(join(tmpdir(), 'fleetadlc-git-ci-'));
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
      FLEETADLC_TOOLS_POLICY: JSON.stringify({ ...BUILDER, localCi: true }),
      FLEETADLC_BRIDGE_URL: `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`,
      FLEETADLC_TASK_ID: 'task-1',
    };
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim();

    const refused = await run(['push', '-q', 'origin', 'agent/12'], env);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/has no recorded local CI pass: run fleetadlc-ci/);

    const unread = await run(['push', '--no-porcelain', 'origin', 'HEAD:refs/heads/agent/x'], env);
    expect(unread.status).toBe(1);
    expect(unread.stderr).toMatch(/not running — .*dry run/);

    passes.add(head);
    const pushed = await run(['push', '-q', 'origin', 'agent/12'], env);
    expect(pushed.stderr).toBe('');
    expect(pushed.status).toBe(0);
  });
});
