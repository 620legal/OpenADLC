import { describe, expect, it, vi } from 'vitest';
import { LocalDriver } from './local.js';

/**
 * The session naming is what ties a session to a bot, and bot names are not
 * unique prefixes of each other: `builder` and `builder-2` are two containers.
 */
describe('session names are unambiguous', () => {
  const driver = new LocalDriver('tmux', '/tmp/fleetadlc-work', '/tmp/fleetadlc-logins');

  const nameOf = (bot: string, session: string): string =>
    // The attach command carries the session name the driver computed.
    driver.attachCommand(bot, session).at(-1) ?? '';

  it('names a session for its bot and skill', () => {
    expect(nameOf('fleetadlc-atlas-janedoe', 'implement')).toBe('=fleetadlc__fleetadlc-atlas-janedoe__implement');
  });

  it('does not let one bot claim another bot whose name it prefixes', () => {
    const first = nameOf('builder', 'shell');
    const second = nameOf('builder-2', 'shell');

    expect(first).not.toBe(second);
    // `builder-2`'s session must not look like a session of `builder`.
    expect(second.startsWith('=fleetadlc__builder__')).toBe(false);
  });

  it('keeps the bot and the session distinguishable when both contain hyphens', () => {
    expect(nameOf('lead-reviewer', 'pr-review')).toBe('=fleetadlc__lead-reviewer__pr-review');
  });
});

describe('where a subscription login is, for a session on the host', () => {
  const driver = new LocalDriver('tmux', '/tmp/fleetadlc-work', '/tmp/fleetadlc-logins');

  it('is the account’s sign-in directory under the login root, where Codex finds auth.json in its home', () => {
    expect(driver.loginPath('550e8400-e29b-41d4-a716-446655440000')).toBe(
      '/tmp/fleetadlc-logins/550e8400-e29b-41d4-a716-446655440000/sign-in',
    );
  });

  it('is never a path built from something that is not an account id', () => {
    expect(() => driver.loginPath('../../etc')).toThrow(/not a model account id/);
  });
});

describe('a task’s computer on the host', () => {
  it('is its own directory, given back with its sessions when the task ends, once', async () => {
    const { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'fleetadlc-fake-tmux-'));
    const log = join(dir, 'calls');
    const bin = join(dir, 'tmux');
    // A tmux that has no sessions and writes down what it is asked.
    writeFileSync(bin, ['#!/bin/sh', `echo "$*" >> ${JSON.stringify(log)}`, 'case "$1" in has-session) exit 1 ;; esac', ''].join('\n'));
    chmodSync(bin, 0o755);
    const work = join(dir, 'work');
    const driver = new LocalDriver(bin, work, join(dir, 'logins'));
    const spec = {
      taskId: '550e8400-e29b-41d4-a716-446655440000',
      bot: 'atlas',
      repoKey: 'acme__widgets',
      slotDir: join(work, 'slots', '550e8400-e29b-41d4-a716-446655440000'),
      login: null,
      cpus: 2,
      memoryGb: 4,
      database: true,
    };

    try {
      const computer = await driver.acquire(spec);
      // No container, and no database: a task here never gets the platform's.
      // Its repository's cache is a folder on the host, as `/cache` is in a container.
      expect(computer).toEqual({
        taskId: spec.taskId,
        bot: 'atlas',
        container: null,
        databaseUrl: null,
        slotDir: spec.slotDir,
        cacheDir: join(work, 'cache', 'acme__widgets'),
      });
      expect(existsSync(spec.slotDir)).toBe(true);
      expect(driver.computerOf(spec.taskId)).toBe(computer);
      await driver.startSession({ computer, name: 'implement-550e8400', cwd: join(spec.slotDir, 'wt'), command: ['true'], env: {} });

      await driver.release(spec.taskId, 'done');
      await driver.release(spec.taskId, 'done again');

      expect(existsSync(spec.slotDir)).toBe(false);
      expect(driver.computerOf(spec.taskId)).toBeNull();
      const kills = readFileSync(log, 'utf8').split('\n').filter((line) => line.startsWith('kill-session'));
      expect(kills).toEqual(['kill-session -t =fleetadlc__atlas__implement-550e8400']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never removes a directory outside the work root, whatever it was given', async () => {
    const { existsSync, mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const outside = mkdtempSync(join(tmpdir(), 'fleetadlc-outside-'));
    const driver = new LocalDriver('tmux', join(outside, 'work'), join(outside, 'logins'));
    try {
      await driver.acquire({ taskId: 't1', bot: 'atlas', repoKey: null, slotDir: outside, login: null, cpus: 1, memoryGb: 1, database: false });
      await driver.release('t1', 'done');
      expect(existsSync(outside)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('taking a bot’s sessions down, to rename it', () => {
  it('kills every session of that bot, its shell included, and no other bot’s', async () => {
    // A stand-in tmux that lists what a host would have and writes down what
    // it is asked to kill. `atlas-2` shares a prefix with `atlas` in every
    // naming but the double underscore.
    const { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'fleetadlc-fake-tmux-'));
    const log = join(dir, 'killed');
    const bin = join(dir, 'tmux');
    writeFileSync(
      bin,
      [
        '#!/bin/sh',
        'case "$1" in',
        `  list-sessions) printf 'fleetadlc__atlas__shell|0\\nfleetadlc__atlas__implement|1\\nfleetadlc__atlas-2__shell|0\\nfleetadlc__intake__shell|0\\n' ;;`,
        `  kill-session) echo "$3" >> ${JSON.stringify(log)} ;;`,
        'esac',
        '',
      ].join('\n'),
    );
    chmodSync(bin, 0o755);

    try {
      await new LocalDriver(bin, join(dir, 'work'), join(dir, 'logins')).removeBot('atlas');
      expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['=fleetadlc__atlas__shell', '=fleetadlc__atlas__implement']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sessions from before the rename', () => {
  it('kills an idle fleet__ shell, leaves one running a task and says how to stop it, and touches nothing of its own', async () => {
    // Every list, kill and attach looks for `fleetadlc__`, so a `fleet__`
    // session a task was running in through the upgrade was invisible.
    const { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'fleetadlc-fake-tmux-'));
    const log = join(dir, 'killed');
    const bin = join(dir, 'tmux');
    writeFileSync(
      bin,
      [
        '#!/bin/sh',
        'case "$1" in',
        `  list-sessions) printf 'fleet__atlas__shell|0\\nfleet__atlas__implement-3f2a9c1e|0\\nfleetadlc__atlas__shell|0\\n' ;;`,
        '  list-panes) case "$3" in',
        `    *implement*) printf '4242|node|0\\n' ;;`,
        `    *) printf '4241|bash|0\\n' ;;`,
        '  esac ;;',
        `  kill-session) echo "$3" >> ${JSON.stringify(log)} ;;`,
        'esac',
        '',
      ].join('\n'),
    );
    chmodSync(bin, 0o755);
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const result = await new LocalDriver(bin, join(dir, 'work'), join(dir, 'logins')).retireLegacySessions();

      expect(result).toEqual({ retired: ['fleet__atlas__shell'], kept: ['fleet__atlas__implement-3f2a9c1e'] });
      expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['=fleet__atlas__shell']);
      expect(String(warned.mock.calls[0]?.[0])).toContain("tmux kill-session -t '=fleet__atlas__implement-3f2a9c1e'");
    } finally {
      vi.restoreAllMocks();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * A command run with a deadline on the host is killed with everything it
 * started. A Mac has no coreutils `timeout`, so the driver does it itself.
 */
describe('a command past its deadline on the host', () => {
  it('is killed, and the result says it timed out', async () => {
    const driver = new LocalDriver('tmux', '/tmp', '/tmp/fleetadlc-logins');
    const started = Date.now();

    const result = await driver.exec({ bot: 'atlas' }, ['sleep', '30'], { cwd: '/tmp', timeoutMs: 300 });

    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('takes what the command started with it', async () => {
    const { execWithDeadline } = await import('./local.js');
    const { existsSync, mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'fleetadlc-deadline-'));
    const marker = join(dir, 'outlived');
    try {
      // A shell whose child would write the marker after the deadline.
      const result = await execWithDeadline('sh', ['-c', `(sleep 1; touch ${JSON.stringify(marker)}) & wait`], { cwd: dir, env: { PATH: process.env.PATH ?? '' }, timeoutMs: 200, killAfterMs: 5_000 });
      expect(result.timedOut).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs as before with no deadline', async () => {
    const driver = new LocalDriver('tmux', '/tmp', '/tmp/fleetadlc-logins');
    expect(await driver.exec({ bot: 'atlas' }, ['sh', '-c', 'echo hi'], { cwd: '/tmp' })).toEqual({ code: 0, stdout: 'hi\n', stderr: '' });
  });
});

/**
 * Nothing fills a shared pnpm store on the host, and a folder every task can
 * write is the store one task could plant code in for the next: each task
 * installs into a store of its own, in its home, gone with it.
 */
describe('the pnpm store a task on the host installs into', () => {
  it('is its own, in its home, never the repository’s cache', async () => {
    const driver = new LocalDriver('tmux', '/tmp', '/tmp/fleetadlc-logins');
    expect('fillPnpmStore' in driver).toBe(false);

    const result = await driver.exec({ bot: 'atlas' }, ['sh', '-c', 'echo "$PNPM_STORE_DIR $npm_config_store_dir $npm_config_cache"'], {
      cwd: '/tmp',
      env: { FLEETADLC_REPO_HOME: '/work/slots/t1/home', FLEETADLC_CACHE_DIR: '/work/cache/acme__widgets' },
    });

    expect(result.stdout.trim()).toBe('/work/slots/t1/home/.pnpm-store /work/slots/t1/home/.pnpm-store /work/cache/acme__widgets/npm');
  });
});
