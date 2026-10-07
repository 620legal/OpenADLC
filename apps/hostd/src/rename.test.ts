import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecDriver } from './drivers/types.js';
import { clearTaskDebris, moveBotHome, RenameRefused, renameBotComputer, type HeldTasks } from './rename.js';

/**
 * Renaming a bot's computer against a real filesystem and real git: the folder
 * a bot's mirrors and worktrees live in is what has to survive the move, and a
 * worktree is exactly the thing that breaks when its path changes.
 */

let workRoot: string;

beforeEach(() => {
  workRoot = mkdtempSync(join(tmpdir(), 'fleetadlc-rename-'));
});

afterEach(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
}

/**
 * A bot's folder as hostd leaves it: a bare mirror of a repository, and a
 * worktree off it holding a task's branch, the way `Worktrees.create` makes
 * them.
 */
function botWithWork(bot: string): { mirror: string; branch: string } {
  // Inside the work root, so it goes with it even when a step below throws.
  const origin = join(workRoot, '.origins', `${bot}-${Date.now()}`);
  mkdirSync(origin, { recursive: true });
  git(['init', '-q', '-b', 'main'], origin);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'first'], origin);

  const home = join(workRoot, bot);
  const mirror = join(home, 'repos', 'janedoe__testbed.git');
  mkdirSync(join(home, 'repos'), { recursive: true });
  git(['clone', '-q', '--bare', origin, mirror], home);

  const branch = `agent/${bot}/12-issue-12`;
  const worktree = join(home, 'wt', 'task-1');
  mkdirSync(join(home, 'wt'), { recursive: true });
  git(['worktree', 'add', '-q', '--detach', worktree, 'refs/heads/main'], mirror);
  git(['checkout', '-q', '-B', branch], worktree);
  mkdirSync(join(home, 'context', 'task-1'), { recursive: true });
  writeFileSync(join(home, 'context', 'task-1', 'issue.md'), 'the brief');
  rmSync(origin, { recursive: true, force: true });
  return { mirror, branch };
}

function fakeDriver() {
  const calls: string[] = [];
  const driver = {
    kind: 'docker',
    removeBot: vi.fn(async (bot: string) => void calls.push(`remove ${bot}`)),
    ensureBot: vi.fn(async (bot: string) => {
      calls.push(`ensure ${bot}`);
      mkdirSync(join(workRoot, bot), { recursive: true });
    }),
  } as unknown as ExecDriver;
  return { driver, calls };
}

function holding(tasks: Record<string, string>): HeldTasks & { ended: string[] } {
  const ended: string[] = [];
  return {
    ended,
    activeTaskIds: () => Object.keys(tasks).filter((id) => !ended.includes(id)),
    sessionOf: (id) => (id in tasks ? { bot: tasks[id] ?? '' } : null),
    end: async (id) => void ended.push(id),
  };
}

describe('moving a bot’s folder', () => {
  it('carries everything in it to the new name', () => {
    const { mirror } = botWithWork('atlas');

    expect(moveBotHome(workRoot, 'atlas', 'fleetadlc-atlas-janedoe')).toBe('moved');

    expect(existsSync(join(workRoot, 'atlas'))).toBe(false);
    expect(existsSync(mirror.replace('/atlas/', '/fleetadlc-atlas-janedoe/'))).toBe(true);
  });

  it('refuses to put one bot’s work over another’s, and touches neither', () => {
    botWithWork('atlas');
    mkdirSync(join(workRoot, 'fleetadlc-atlas-janedoe', 'repos'), { recursive: true });

    expect(() => moveBotHome(workRoot, 'atlas', 'fleetadlc-atlas-janedoe')).toThrow(RenameRefused);
    expect(existsSync(join(workRoot, 'atlas', 'repos'))).toBe(true);
    expect(existsSync(join(workRoot, 'fleetadlc-atlas-janedoe', 'repos'))).toBe(true);
  });

  it('finishes a move that already happened, dropping the empty folder a restart made', () => {
    // hostd's start makes a folder for every bot the database names. If the
    // bridge stopped before it renamed the row, that is an empty `atlas` next
    // to the moved one — and the move has to be repeatable over it.
    botWithWork('fleetadlc-atlas-janedoe');
    mkdirSync(join(workRoot, 'atlas'));

    expect(moveBotHome(workRoot, 'atlas', 'fleetadlc-atlas-janedoe')).toBe('already moved');
    expect(existsSync(join(workRoot, 'atlas'))).toBe(false);
    expect(existsSync(join(workRoot, 'fleetadlc-atlas-janedoe', 'repos'))).toBe(true);
  });

  it('replaces an empty folder under the new name, and has nothing to do for a bot that never worked', () => {
    botWithWork('atlas');
    mkdirSync(join(workRoot, 'fleetadlc-atlas-janedoe'));
    expect(moveBotHome(workRoot, 'atlas', 'fleetadlc-atlas-janedoe')).toBe('moved');

    expect(moveBotHome(workRoot, 'nova', 'system-engineer')).toBe('nothing to move');
  });
});

describe('what the moved folder’s tasks left behind', () => {
  it('goes, and the mirror forgets it, so the branch can be checked out again', async () => {
    const { branch } = botWithWork('atlas');
    moveBotHome(workRoot, 'atlas', 'fleetadlc-atlas-janedoe');
    const home = join(workRoot, 'fleetadlc-atlas-janedoe');
    const mirror = join(home, 'repos', 'janedoe__testbed.git');

    // Moved as it is, the worktree still claims its branch from a path that
    // is gone: checking the branch out again is refused.
    expect(() =>
      git(['worktree', 'add', '-q', join(home, 'wt', 'task-2'), branch], mirror),
    ).toThrow();

    await clearTaskDebris(home);

    expect(existsSync(join(home, 'wt'))).toBe(false);
    expect(existsSync(join(home, 'context'))).toBe(false);
    expect(git(['worktree', 'list', '--porcelain'], mirror)).not.toContain('task-1');
    git(['worktree', 'add', '-q', join(home, 'wt', 'task-2'), branch], mirror);
    expect(readFileSync(join(home, 'wt', 'task-2', '.git'), 'utf8')).toContain(mirror);
  });
});

describe('renaming a bot’s computer', () => {
  it('takes the old one down, carries the folder, and asks the driver for the bot under its new name', async () => {
    botWithWork('atlas');
    const { driver, calls } = fakeDriver();

    const renamed = await renameBotComputer({
      from: 'atlas',
      to: 'fleetadlc-atlas-janedoe',
      driver,
      runner: holding({}),
      workRoot,
      taskState: async () => null,
    });

    expect(renamed).toEqual({ from: 'atlas', to: 'fleetadlc-atlas-janedoe', folder: 'moved' });
    expect(calls).toEqual(['remove atlas', 'ensure fleetadlc-atlas-janedoe']);
    expect(existsSync(join(workRoot, 'fleetadlc-atlas-janedoe', 'repos', 'janedoe__testbed.git'))).toBe(true);
    expect(existsSync(join(workRoot, 'fleetadlc-atlas-janedoe', 'wt'))).toBe(false);
  });

  it('refuses while the bot is working, and leaves everything as it was', async () => {
    botWithWork('atlas');
    const { driver, calls } = fakeDriver();

    await expect(
      renameBotComputer({
        from: 'atlas',
        to: 'fleetadlc-atlas-janedoe',
        driver,
        runner: holding({ 'task-9': 'atlas' }),
        workRoot,
        taskState: async () => 'running',
      }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining('running task task-9') });
    expect(calls).toEqual([]);
    expect(existsSync(join(workRoot, 'atlas', 'wt', 'task-1'))).toBe(true);
  });

  it('ends a task it still holds that is paused, rather than leaving its session in a container that is gone', async () => {
    const { driver } = fakeDriver();
    const runner = holding({ 'task-paused': 'atlas', 'task-other': 'intake' });

    await renameBotComputer({
      from: 'atlas',
      to: 'fleetadlc-atlas-janedoe',
      driver,
      runner,
      workRoot,
      taskState: async (id) => (id === 'task-paused' ? 'paused' : 'running'),
    });

    expect(runner.ended).toEqual(['task-paused']);
  });

  it('refuses a folder conflict before it takes anything down', async () => {
    botWithWork('atlas');
    botWithWork('fleetadlc-atlas-janedoe');
    const { driver, calls } = fakeDriver();

    await expect(
      renameBotComputer({
        from: 'atlas',
        to: 'fleetadlc-atlas-janedoe',
        driver,
        runner: holding({}),
        workRoot,
        taskState: async () => null,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(calls).toEqual([]);
  });

  it('can be run again after it has finished, which is how an interrupted rename is completed', async () => {
    botWithWork('atlas');
    const { driver, calls } = fakeDriver();
    const input = {
      from: 'atlas',
      to: 'fleetadlc-atlas-janedoe',
      driver,
      runner: holding({}),
      workRoot,
      taskState: async () => null,
    };

    await renameBotComputer(input);
    // hostd restarted in between and made `atlas` again from the row.
    mkdirSync(join(workRoot, 'atlas'));
    const again = await renameBotComputer(input);

    expect(again.folder).toBe('already moved');
    expect(calls.filter((call) => call.startsWith('ensure fleetadlc-atlas-janedoe'))).toHaveLength(2);
    expect(existsSync(join(workRoot, 'fleetadlc-atlas-janedoe', 'repos', 'janedoe__testbed.git'))).toBe(true);
  });

  it('refuses a new name no bot could have, and an old one that is not a path segment', async () => {
    const { driver, calls } = fakeDriver();
    const base = { driver, runner: holding({}), workRoot, taskState: async () => null };

    await expect(renameBotComputer({ ...base, from: 'atlas', to: 'FleetADLC-Atlas' })).rejects.toMatchObject({ status: 400 });
    await expect(renameBotComputer({ ...base, from: 'atlas', to: 'a__b' })).rejects.toMatchObject({ status: 400 });
    await expect(renameBotComputer({ ...base, from: '../etc', to: 'builder' })).rejects.toMatchObject({ status: 400 });
    expect(calls).toEqual([]);
  });
});
