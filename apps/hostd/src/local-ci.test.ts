import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bridgeReporter, LOCAL_CI_COMMAND, LocalCi, LocalCiRefused, type LocalCiRun, type LocalCiTarget } from './local-ci.js';

/**
 * The repository's checks as hostd runs them on a task's head. A pass is
 * recorded for a commit, so a run on anything that is not one — changes left
 * uncommitted, a HEAD that moved while it ran, a tree it changed — is refused
 * and never reported.
 */

const TARGET: LocalCiTarget = {
  bot: 'builder',
  computer: { taskId: 'task-1', bot: 'builder', container: 'task-task1', databaseUrl: null, slotDir: '/work/slots/task-1', cacheDir: null } as never,
  worktree: '/work/builder/wt/task-1',
  branch: 'agent/builder/7-issue-7',
  env: { DATABASE_URL: 'postgres://bot/repo_api', FLEETADLC_REPO_HOME: '/work/builder/homes/api' },
};

/**
 * What an honest worktree answers to hostd's proof that it is the commit's own
 * tree (`LocalCi.unproven`); null for any other command.
 */
function proof(command: string[], worktree = TARGET.worktree) {
  if (command[0] === 'sh' && command.at(-1) === worktree) return { code: 0, stdout: `${worktree}\n`, stderr: '' };
  if (command.includes('--show-toplevel')) return { code: 0, stdout: `${worktree}\n${worktree}/.git\n`, stderr: '' };
  if (command.includes('--get-regexp')) return { code: 1, stdout: '', stderr: '' };
  if (command.includes('for-each-ref')) return { code: 0, stdout: '', stderr: '' };
  if (command.includes('ls-files')) return { code: 0, stdout: 'H Makefile\nH src/a.ts\n', stderr: '' };
  return null;
}

function driver(script: { heads: string[]; statuses?: string[]; ci?: { code: number; stdout: string; stderr?: string } }) {
  const heads = [...script.heads];
  const statuses = [...(script.statuses ?? ['', ''])];
  const exec = vi.fn(async (_target: unknown, command: string[], _options?: { cwd?: string; env?: Record<string, string> }) => {
    const proved = proof(command);
    if (proved) return proved;
    if (command.includes('rev-parse')) return { code: 0, stdout: `${heads.shift() ?? ''}\n`, stderr: '' };
    if (command.includes('status')) return { code: 0, stdout: statuses.shift() ?? '', stderr: '' };
    return { code: script.ci?.code ?? 0, stdout: script.ci?.stdout ?? 'ci: green\n', stderr: script.ci?.stderr ?? '' };
  });
  return { exec };
}

async function run(exec: ReturnType<typeof driver>, target: LocalCiTarget | null = TARGET) {
  const reported: LocalCiRun[] = [];
  const ci = new LocalCi(exec, () => target, async (one) => void reported.push(one));
  const started = ci.start('task-1');
  const finished = await ci.settled(started.id);
  return { ci, started, finished, reported };
}

describe('local CI on a task’s head', () => {
  it('runs make ci in the worktree with the task’s database and home, and reports a pass for that commit', async () => {
    const exec = driver({ heads: ['abc123', 'abc123'] });
    const { started, finished, reported } = await run(exec);

    expect(started.state).toBe('running');
    expect(finished).toMatchObject({ state: 'passed', headSha: 'abc123', exitCode: 0, branch: 'agent/builder/7-issue-7' });
    expect(exec.exec).toHaveBeenCalledWith(TARGET.computer, LOCAL_CI_COMMAND, { cwd: TARGET.worktree, env: TARGET.env, timeoutMs: 60 * 60_000 });
    expect(reported).toEqual([expect.objectContaining({ state: 'passed', headSha: 'abc123' })]);
  });

  it('reports a failure with the end of what it printed', async () => {
    const { finished, reported } = await run(driver({ heads: ['abc123', 'abc123'], ci: { code: 2, stdout: 'FAIL src/a.test.ts\n' } }));

    expect(finished).toMatchObject({ state: 'failed', exitCode: 2 });
    expect(finished?.logTail).toContain('FAIL src/a.test.ts');
    expect(reported).toHaveLength(1);
  });

  it('refuses changes left uncommitted, before running anything, and reports nothing', async () => {
    const exec = driver({ heads: ['abc123'], statuses: [' M src/a.ts\n?? notes.txt\n'] });
    const { finished, reported } = await run(exec);

    expect(finished).toMatchObject({ state: 'refused' });
    expect(finished?.reason).toMatch(/not committed \(src\/a\.ts, notes\.txt\): commit them/);
    expect(exec.exec).not.toHaveBeenCalledWith(TARGET.computer, LOCAL_CI_COMMAND, expect.anything());
    expect(reported).toEqual([]);
  });

  it('refuses a run whose HEAD moved while it ran: what passed is not the commit', async () => {
    const { finished, reported } = await run(driver({ heads: ['abc123', 'def456'] }));

    expect(finished).toMatchObject({ state: 'refused' });
    expect(finished?.reason).toMatch(/HEAD moved from abc123 to def456/);
    expect(reported).toEqual([]);
  });

  it('refuses a run that changed the tree', async () => {
    const { finished, reported } = await run(driver({ heads: ['abc123', 'abc123'], statuses: ['', ' M dist/index.js\n'] }));

    expect(finished?.reason).toMatch(/make ci changed the worktree \(dist\/index\.js\)/);
    expect(reported).toEqual([]);
  });

  it('answers the run already going rather than starting a second in the same worktree', async () => {
    let release: () => void = () => undefined;
    const exec = vi.fn(async (_target: unknown, command: string[]) => {
      const proved = proof(command);
      if (proved) return proved;
      if (command.includes('rev-parse')) return { code: 0, stdout: 'abc123\n', stderr: '' };
      if (command.includes('status')) return { code: 0, stdout: '', stderr: '' };
      await new Promise<void>((resolve) => (release = resolve));
      return { code: 0, stdout: '', stderr: '' };
    });
    const ci = new LocalCi({ exec }, () => TARGET, async () => undefined);

    const first = ci.start('task-1');
    const second = ci.start('task-1');
    expect(second.id).toBe(first.id);
    await vi.waitFor(() => expect(exec).toHaveBeenCalledWith(TARGET.computer, LOCAL_CI_COMMAND, expect.anything()));
    release();
    expect((await ci.settled(first.id))?.state).toBe('passed');
    expect(ci.get('task-2', first.id)).toBeNull();
  });

  it('refuses a task that is not running on this host', () => {
    const ci = new LocalCi(driver({ heads: [] }), () => null, async () => undefined);
    expect(() => ci.start('task-9')).toThrow(LocalCiRefused);
  });
});

/**
 * `make ci` had no limit. A suite that hung stayed "running" until the task's
 * computer went away, every later `fleetadlc-ci` joined it, and the builder
 * could never record a pass.
 */
describe('a make ci that does not finish', () => {
  it('is stopped at its limit and fails, saying so, on the commit it ran on', async () => {
    const exec = vi.fn(async (_target: unknown, command: string[], _options?: { timeoutMs?: number }) => {
      const proved = proof(command);
      if (proved) return proved;
      if (command.includes('rev-parse')) return { code: 0, stdout: 'abc123\n', stderr: '' };
      if (command.includes('status')) return { code: 0, stdout: '', stderr: '' };
      return { code: 124, stdout: 'still waiting on port 5432\n', stderr: '', timedOut: true };
    });
    const reported: LocalCiRun[] = [];
    const ci = new LocalCi({ exec }, () => TARGET, async (one) => void reported.push(one), Date.now, 45 * 60_000);

    const finished = await ci.settled(ci.start('task-1').id);

    expect(exec).toHaveBeenCalledWith(TARGET.computer, LOCAL_CI_COMMAND, expect.objectContaining({ timeoutMs: 45 * 60_000 }));
    expect(finished).toMatchObject({ state: 'failed', headSha: 'abc123', exitCode: 124 });
    expect(finished?.reason).toMatch(/^make ci did not finish within 45 minutes/);
    expect(finished?.logTail).toContain('still waiting on port 5432');
    expect(reported).toEqual([expect.objectContaining({ state: 'failed' })]);
  });

  it('is joined only while it is within its deadline; past it, the next start is a new run', async () => {
    let clock = Date.parse('2026-10-04T10:00:00.000Z');
    const exec = vi.fn(async (_target: unknown, command: string[]) => {
      const proved = proof(command);
      if (proved) return proved;
      if (command.includes('rev-parse')) return { code: 0, stdout: 'abc123\n', stderr: '' };
      if (command.includes('status')) return { code: 0, stdout: '', stderr: '' };
      return new Promise<never>(() => undefined);
    });
    const ci = new LocalCi({ exec }, () => TARGET, async () => undefined, () => clock, 60 * 60_000);

    const first = ci.start('task-1');
    clock += 30 * 60_000;
    expect(ci.start('task-1').id).toBe(first.id);
    clock += 31 * 60_000 + 30_000;
    expect(ci.start('task-1').id).not.toBe(first.id);
  });
});

describe('the proof that a worktree is its commit’s own tree', () => {
  it('asks git with the system and global config, replace objects, fsmonitor and the untracked cache off', async () => {
    const exec = driver({ heads: ['abc123', 'abc123'] });
    await run(exec);

    const gits = exec.exec.mock.calls.filter(([, command]) => command[0] === 'git');
    expect(gits.length).toBeGreaterThan(4);
    for (const [, command, options] of gits) {
      expect(command.slice(0, 7)).toEqual(['git', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'status.showUntrackedFiles=all']);
      expect(options?.env).toEqual({ GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
    }
    expect(gits.map(([, command]) => command.slice(9).join(' '))).toEqual(
      expect.arrayContaining(['rev-parse HEAD', 'status --porcelain=v1 --untracked-files=all', 'for-each-ref refs/replace/', 'ls-files -v']),
    );
  });
});

/**
 * The same with a real repository and real git, `make` and `sh`, run as the
 * local driver runs them. The worktree's `.git` is the session's to change,
 * and a skip-worktree entry hid a changed file from `git status`: a commit
 * whose `make ci` fails was recorded as passing.
 */
describe('a worktree whose .git is not the commit’s own', () => {
  let slot: string;
  let worktree: string;

  const sh = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();

  /** The local driver's exec, near enough: the command, its directory and its environment. */
  const exec = vi.fn(async (_computer: unknown, command: string[], options: { cwd?: string; env?: Record<string, string> } = {}) => {
    const [binary, ...args] = command;
    const result = spawnSync(binary ?? '', args, { cwd: options.cwd, env: { PATH: process.env.PATH ?? '', HOME: slot, ...options.env }, encoding: 'utf8' });
    return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  });

  function repository(committed: 'good' | 'bad', init: (slot: string) => string[] = () => []): void {
    slot = mkdtempSync(join(tmpdir(), 'fleetadlc-local-ci-'));
    worktree = join(slot, 'wt');
    mkdirSync(worktree);
    sh(worktree, 'init', '-q', '-b', 'main', ...init(slot));
    writeFileSync(join(worktree, 'Makefile'), 'setup:\n\t@true\nci:\n\t@test "$$(cat value)" = good\n');
    writeFileSync(join(worktree, 'value'), `${committed}\n`);
    sh(worktree, 'add', 'Makefile', 'value');
    sh(worktree, 'commit', '-qm', 'the commit');
  }

  async function ciRun() {
    exec.mockClear();
    const target: LocalCiTarget = { ...TARGET, worktree, env: {}, computer: { ...TARGET.computer, slotDir: slot } };
    const reported: LocalCiRun[] = [];
    const ci = new LocalCi({ exec }, () => target, async (one) => void reported.push(one));
    const finished = await ci.settled(ci.start('task-1').id);
    const ranIn = exec.mock.calls.filter(([, command]) => command === LOCAL_CI_COMMAND).map(([, , options]) => options?.cwd);
    return { finished, reported, ranIn };
  }

  afterEach(() => {
    rmSync(slot, { recursive: true, force: true });
  });

  it('runs an honest worktree in place, git’s sample hooks and all', async () => {
    repository('good');
    const { finished, ranIn } = await ciRun();
    expect(finished).toMatchObject({ state: 'passed' });
    expect(ranIn).toEqual([worktree]);
    expect(finished?.logTail).not.toContain('clean checkout');
  });

  it('records a failing commit as failed when skip-worktree hid the file that made it pass', async () => {
    repository('bad');
    const head = sh(worktree, 'rev-parse', 'HEAD');
    sh(worktree, 'update-index', '--skip-worktree', 'value');
    writeFileSync(join(worktree, 'value'), 'good\n');
    expect(sh(worktree, 'status', '--porcelain')).toBe('');

    const { finished, reported, ranIn } = await ciRun();

    expect(finished).toMatchObject({ state: 'failed', headSha: head });
    expect(reported).toEqual([expect.objectContaining({ state: 'failed', headSha: head })]);
    expect(ranIn).toEqual([join(slot, `ci-${finished?.id}`)]);
    expect(finished?.logTail.split('\n')[0]).toBe(`ran in a clean checkout of ${head.slice(0, 7)}: the worktree has skip-worktree entries`);
    // Gone after the run.
    expect(readdirSync(slot).filter((name) => name.startsWith('ci-'))).toEqual([]);
  });

  it.each<[string, string, () => void]>([
    ['assume-unchanged entries', 'has assume-unchanged entries', () => sh(worktree, 'update-index', '--assume-unchanged', 'value')],
    [
      'an alternate object store',
      'has an alternate object store',
      () => {
        const other = join(slot, 'other');
        mkdirSync(other);
        sh(other, 'init', '-q');
        writeFileSync(join(worktree, '.git', 'objects', 'info', 'alternates'), `${join(other, '.git', 'objects')}\n`);
      },
    ],
    ['a grafts file', 'has a grafts file', () => writeFileSync(join(worktree, '.git', 'info', 'grafts'), `${sh(worktree, 'rev-parse', 'HEAD')}\n`)],
    [
      'a replace ref',
      'has replace refs',
      () => {
        const other = sh(worktree, 'commit-tree', 'HEAD^{tree}', '-m', 'another');
        sh(worktree, 'replace', 'HEAD', other);
      },
    ],
    ['core.hooksPath', 'sets core.hookspath', () => sh(worktree, 'config', 'core.hooksPath', '.githooks')],
    [
      'a hook',
      'has hooks',
      () => {
        writeFileSync(join(worktree, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\nexit 0\n');
        chmodSync(join(worktree, '.git', 'hooks', 'post-checkout'), 0o755);
      },
    ],
    ['core.worktree', 'sets core.worktree', () => sh(worktree, 'config', 'core.worktree', worktree)],
  ])('goes to a clean checkout for %s', async (_name, why, change) => {
    repository('good');
    change();
    const { finished, ranIn } = await ciRun();
    expect(finished).toMatchObject({ state: 'passed' });
    expect(ranIn).toEqual([join(slot, `ci-${finished?.id}`)]);
    expect(finished?.logTail.split('\n')[0]).toContain(why);
    expect(existsSync(join(slot, `ci-${finished?.id}`))).toBe(false);
  });

  it('goes to a clean checkout for a .git that is a file naming a repository elsewhere', async () => {
    repository('good', (dir) => ['--separate-git-dir', join(dir, 'elsewhere.git')]);
    const { finished, ranIn } = await ciRun();
    expect(finished).toMatchObject({ state: 'passed' });
    expect(ranIn).toEqual([join(slot, `ci-${finished?.id}`)]);
    expect(finished?.logTail.split('\n')[0]).toContain('has a .git that is not a directory of its own');
  });

  it('still refuses changes the builder can see, before anything runs', async () => {
    repository('good');
    writeFileSync(join(worktree, 'value'), 'changed\n');
    const { finished, ranIn } = await ciRun();
    expect(finished?.reason).toMatch(/not committed \(value\): commit them, then run fleetadlc-ci again/);
    expect(ranIn).toEqual([]);
  });
});

describe('reporting a run before the bridge has written the install’s secret', () => {
  it('says to start the bridge, not only that the secret is missing', async () => {
    const empty = { get: async () => null, set: async () => undefined, delete: async () => undefined, list: async () => [] };
    await expect(bridgeReporter('http://127.0.0.1:9', empty)({} as LocalCiRun)).rejects.toThrow(
      /no internal secret yet.*Start the bridge, which generates it, then retry: fleetadlc up/,
    );
  });
});
