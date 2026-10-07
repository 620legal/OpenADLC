import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Tmux } from './tmux.js';

/**
 * These go through the real tmux on purpose. The bug they pin was not in the
 * parsing — splitting `name\tattached` on a tab is correct — it was that tmux
 * never emits the tab: it rewrites control characters in `-F` output to '_', so
 * `#{session_name}\t#{session_attached}` arrives as `fleetadlc__atlas__shell_0`.
 * A fixture asserting `name|attached` parses would have passed throughout, while
 * every attach in the console failed with "can't find session". Only asking the
 * tmux on this machine what it actually prints can catch that, so the round trip
 * is the test.
 */
const available = ((): boolean => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// A name no install would collide with, so a stray run cannot kill real work.
const SESSION = `fleetadlc__tmuxtest__${process.pid}`;
const tmux = new Tmux('tmux');

afterAll(async () => {
  if (available) await tmux.killSession(SESSION);
});

describe.runIf(available)('a session survives the round trip through tmux -F', () => {
  it('reports the name it was created with, not a mangled one', async () => {
    await tmux.newSession({ name: SESSION, cwd: process.cwd(), command: ['bash'], env: {} });

    const names = (await tmux.listSessions()).map((session) => session.name);

    // The whole bug in one assertion: before the fix this was `${SESSION}_0`,
    // which is a session that does not exist and cannot be attached to.
    expect(names).toContain(SESSION);
    expect(await tmux.hasSession(SESSION)).toBe(true);
  });

  it('separates the pane fields instead of running them together', async () => {
    const info = await tmux.paneInfo(SESSION);

    // Before the fix all three arrived as one string, so the pid did not parse
    // and the command was empty — which is what made every bot read "working"
    // with nothing running.
    expect(info).not.toBeNull();
    expect(info?.pid).toBeTypeOf('number');
    expect(info?.pid).toBeGreaterThan(0);
    expect(info?.cmd).not.toBe('');
    expect(info?.dead).toBe(false);
  });

  it('reads attached as its own field', async () => {
    const session = (await tmux.listSessions()).find((entry) => entry.name === SESSION);

    // Nothing is attached to a session made with -d. When the delimiter is lost
    // this flag is the character that gets glued onto the name instead.
    expect(session?.attached).toBe(false);
  });

  it('reads what the session prints', async () => {
    // `capture-pane -t =name` is refused — "can't find pane" — since `=name`
    // is a session, not a pane, so the Computer tab read nothing from any
    // session and said "nothing running" over one that was working.
    const printing = `${SESSION}_print`;
    await tmux.newSession({ name: printing, cwd: process.cwd(), command: ['bash', '-c', 'echo pane-says-hello; sleep 20'], env: {} });
    let lines: string[] = [];
    for (let attempt = 0; attempt < 20 && !lines.some((line) => line.includes('pane-says-hello')); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      lines = await tmux.capturePane(printing, 20);
    }
    await tmux.killSession(printing);
    expect(lines.some((line) => line.includes('pane-says-hello'))).toBe(true);
  });
});

describe('a listing tmux could not give', () => {
  const answering = (result: { code: number; stdout?: string; stderr?: string }) =>
    new Tmux('tmux', undefined, async () => ({ stdout: '', stderr: '', ...result }));

  it('is no sessions when no tmux server is running', async () => {
    expect(await answering({ code: 1, stderr: 'no server running on /tmp/tmux-1000/default\n' }).listSessions()).toEqual([]);
    expect(await answering({ code: 1, stderr: 'error connecting to /tmp/tmux-1000/default (No such file or directory)\n' }).listSessions()).toEqual([]);
  });

  it('throws, with what tmux said, on any other failure, which is not "every session is gone"', async () => {
    // tmux 3.3a exits 1 here while its server is alive and its sessions run.
    await expect(answering({ code: 1, stderr: 'error connecting to /tmp/tmux-1000/default (Permission denied)\n' }).listSessions()).rejects.toThrow(
      /tmux list-sessions failed: .*Permission denied/,
    );
    await expect(answering({ code: 126, stderr: 'OCI runtime exec failed: exec failed: unable to start container process' }).listSessions()).rejects.toThrow(
      /OCI runtime exec failed/,
    );
  });
});

describe('a tmux that does not answer', () => {
  it('is killed after its timeout, and the listing fails rather than hanging', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleetadlc-tmux-hung-'));
    try {
      const hung = join(dir, 'tmux');
      writeFileSync(hung, '#!/bin/sh\nexec sleep 30\n');
      chmodSync(hung, 0o755);
      const started = Date.now();

      await expect(new Tmux(hung, undefined, undefined, 200).listSessions()).rejects.toThrow(/did not answer within 0\.2 s/);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
