import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The program the suites and people run against an install. Both refusals
 * come before it reaches the database, so these need none.
 */
const APP = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('the dispatcher run as a program', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'fleetadlc-dispatcher-main-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const run = (args: string[]) =>
    spawnSync(join(APP, 'node_modules', '.bin', 'tsx'), ['src/main.ts', ...args], {
      cwd: APP,
      encoding: 'utf8',
      // An empty home: no secret, and a database nobody listens on.
      env: { ...process.env, FLEETADLC_HOME: home, FLEETADLC_SECRET_STORE: 'file', DATABASE_URL: 'postgres://127.0.0.1:1/none' },
      timeout: 30_000,
    });

  it('refuses an option it does not read', () => {
    // The `dev` script's `--watch-interval 60` was read by nothing, so it ran
    // every 300s instead of every 60.
    const result = run(['--watch-interval', '60']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--watch-interval 60 is not an option');
  }, 40_000);

  it('refuses to start without the install’s internal secret', () => {
    // It ran with an empty secret, the bridge refused every call, and each
    // refused lease counted as an attempt on its issue.
    const result = run(['--once', '--dry-run']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`no internal secret in the secret store for this FLEETADLC_HOME (${home})`);
  }, 40_000);
});
