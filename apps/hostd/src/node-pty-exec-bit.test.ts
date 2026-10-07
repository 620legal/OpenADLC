import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error — a plain .mjs script with no types; it runs from postinstall.
import { restoreExecBits } from '../scripts/node-pty-exec-bit.mjs';

/**
 * node-pty's prebuilt `spawn-helper` arrives without its execute bit, and
 * nothing notices until somebody attaches to a bot's terminal — where it fails
 * as `posix_spawnp failed`, which points at nothing. It happens on every clean
 * install, so `postinstall` fixes it on every clean install.
 */

const made: string[] = [];

afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** A tree shaped like the one pnpm builds, with the helper's mode as given. */
function fakeInstall(mode: number, layout: 'pnpm' | 'plain' = 'pnpm'): string {
  const root = mkdtempSync(join(tmpdir(), 'fleetadlc-nodepty-'));
  made.push(root);

  const prebuilds =
    layout === 'pnpm'
      ? join(root, 'node_modules', '.pnpm', 'node-pty@1.1.0', 'node_modules', 'node-pty', 'prebuilds')
      : join(root, 'node_modules', 'node-pty', 'prebuilds');

  const platform = join(prebuilds, 'darwin-arm64');
  mkdirSync(platform, { recursive: true });
  const helper = join(platform, 'spawn-helper');
  writeFileSync(helper, 'binary');
  chmodSync(helper, mode);
  return root;
}

function modeOf(root: string, layout: 'pnpm' | 'plain' = 'pnpm'): number {
  const helper =
    layout === 'pnpm'
      ? join(root, 'node_modules', '.pnpm', 'node-pty@1.1.0', 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper')
      : join(root, 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper');
  return statSync(helper).mode & 0o777;
}

describe('putting the execute bit back', () => {
  it('fixes a helper that arrived without it', () => {
    const root = fakeInstall(0o644);

    const fixed = restoreExecBits(root);

    expect(fixed).toHaveLength(1);
    expect(modeOf(root) & 0o100).toBeTruthy();
  });

  it('leaves one that is already executable alone', () => {
    // Idempotent, because it runs after every install and most of them are fine.
    const root = fakeInstall(0o755);

    expect(restoreExecBits(root)).toEqual([]);
    expect(modeOf(root)).toBe(0o755);
  });

  it('finds it under a plain node_modules too, not only pnpm’s store', () => {
    const root = fakeInstall(0o644, 'plain');

    expect(restoreExecBits(root)).toHaveLength(1);
    expect(modeOf(root, 'plain') & 0o100).toBeTruthy();
  });

  it('does nothing, quietly, when node-pty is not installed', () => {
    // A filtered install has no node-pty, and that is not a fault to report.
    const root = mkdtempSync(join(tmpdir(), 'fleetadlc-nodepty-'));
    made.push(root);

    expect(() => restoreExecBits(root)).not.toThrow();
    expect(restoreExecBits(root)).toEqual([]);
  });

  it('adds execute where read is allowed, and nowhere else', () => {
    // `chmod +x`, not `chmod 755`. A helper only its owner may read should not
    // come back readable by everyone: this is a binary rather than a secret,
    // but a fix for one problem should not quietly widen something else.
    const root = fakeInstall(0o600);

    restoreExecBits(root);

    expect(modeOf(root)).toBe(0o700);
  });

  it('leaves a world-readable helper world-executable, as chmod +x would', () => {
    const root = fakeInstall(0o644);

    restoreExecBits(root);

    expect(modeOf(root)).toBe(0o755);
  });
});
