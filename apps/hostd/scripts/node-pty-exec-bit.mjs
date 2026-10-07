#!/usr/bin/env node
/**
 * Puts the execute bit back on node-pty's `spawn-helper`.
 *
 * node-pty ships prebuilt binaries for macOS and Windows only, and installing
 * it through pnpm lands them without the execute bit. On Linux there is no
 * prebuild: the module is compiled at install (python3, make and g++), and
 * there is nothing here to fix. Nothing notices until somebody attaches to a bot's
 * terminal, which is the one thing hostd needs it for, and the failure reads as
 * `posix_spawnp failed` — a message that points at nothing.
 *
 * It happens on every clean install, so it is fixed on every clean install
 * rather than written down somewhere for a person to remember.
 *
 * Runs from `postinstall`. Never fails an install: a missing node-pty is
 * normal for a filtered install, and a refused chmod is worth a line rather
 * than a broken `pnpm install`.
 */
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where pnpm puts the package, and where npm would. Both are checked. */
function prebuildRoots(root) {
  const roots = [];
  const pnpmStore = join(root, 'node_modules', '.pnpm');

  if (existsSync(pnpmStore)) {
    for (const entry of readdirSync(pnpmStore)) {
      if (!entry.startsWith('node-pty@')) continue;
      roots.push(join(pnpmStore, entry, 'node_modules', 'node-pty', 'prebuilds'));
    }
  }

  roots.push(join(root, 'node_modules', 'node-pty', 'prebuilds'));
  return roots.filter((path) => existsSync(path));
}

/**
 * Every `spawn-helper` under the prebuild directories, whatever the platform
 * folder is called — naming a platform here would mean this stops working on
 * the next one.
 */
function spawnHelpers(prebuilds) {
  const found = [];
  for (const platform of readdirSync(prebuilds)) {
    const helper = join(prebuilds, platform, 'spawn-helper');
    if (existsSync(helper)) found.push(helper);
  }
  return found;
}

export function restoreExecBits(root) {
  const fixed = [];

  for (const prebuilds of prebuildRoots(root)) {
    for (const helper of spawnHelpers(prebuilds)) {
      const mode = statSync(helper).mode;
      // Already executable by its owner: leave it alone and say nothing.
      if (mode & 0o100) continue;

      // Execute wherever read is already allowed, which is what `chmod +x`
      // means. Forcing 0o755 would widen a mode somebody had narrowed — this
      // is a binary in node_modules rather than a secret, but a fix for one
      // problem should not quietly change something else.
      const executable = mode | ((mode & 0o444) >> 2);
      chmodSync(helper, executable);
      fixed.push(helper);
    }
  }

  return fixed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // The repository root, three levels up from this file (apps/hostd/scripts).
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  try {
    const fixed = restoreExecBits(root);
    if (fixed.length > 0) {
      console.log(
        `[postinstall] restored the execute bit on ${fixed.length} node-pty spawn-helper ${fixed.length === 1 ? 'binary' : 'binaries'}`,
      );
    }
  } catch (error) {
    // Reported, never fatal: a failed install is worse than a broken attach,
    // and this says which one happened.
    console.warn(
      `[postinstall] could not restore node-pty's execute bit: ${error instanceof Error ? error.message : error}`,
    );
    console.warn(
      "[postinstall] the console's terminal (take-over) may fail with posix_spawnp; run chmod +x on node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/*/spawn-helper",
    );
  }
}
