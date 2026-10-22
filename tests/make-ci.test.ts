import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `make ci` runs every package's typecheck and tests at once (#65). Run here,
 * with this repository's Makefile, on a workspace of two packages whose
 * scripts stand in for tsc and vitest, for what openadlc-ci and a person rely
 * on: that both really run at once, that a failure of either fails make ci
 * with the failure at the end of its output, and that nothing it started is
 * left running.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_MANAGER = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { packageManager: string }).packageManager;
// All of make ci's output that openadlc-ci keeps for the lead reviewer and a person.
const LOG_TAIL_BYTES = Number(/const LOG_TAIL_BYTES = ([\d_]+);/.exec(readFileSync(join(ROOT, 'apps/hostd/src/local-ci.ts'), 'utf8'))![1]!.replace(/_/g, ''));

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A workspace whose packages' typecheck and test are the shell given. */
function workspace(packages: Record<string, { typecheck: string; test: string; dependencies?: Record<string, string> }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'openadlc-make-ci-'));
  dirs.push(dir);
  // The same pnpm as this repository's, so nothing is fetched to run it.
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', private: true, packageManager: PACKAGE_MANAGER }));
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
  for (const [name, scripts] of Object.entries(packages)) {
    mkdirSync(join(dir, 'packages', name), { recursive: true });
    const { dependencies, ...rest } = scripts;
    writeFileSync(join(dir, 'packages', name, 'package.json'), JSON.stringify({ name, private: true, dependencies, scripts: rest }));
  }
  return dir;
}

function makeCi(dir: string) {
  // This test runs inside a make ci of this repository, whose make and pnpm
  // would otherwise hand theirs on: MAKEFLAGS and pnpm's npm_config_*.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(MAKEFLAGS|MAKELEVEL|MFLAGS|npm_|PNPM_SCRIPT_|VITEST)/.test(name)),
  );
  const started = Date.now();
  // Two at a time, what make ci runs on two CPUs, whatever this computer has.
  // GNU make 4 says where -C took it, around everything else.
  const result = spawnSync('make', ['--no-print-directory', '-f', join(ROOT, 'Makefile'), '-C', dir, 'ci', 'CI_JOBS=2', 'CI_WORKERS=1'], {
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}`, ms: Date.now() - started };
}

/** Waits for the file `name` in the workspace root, for up to ten seconds. */
const waitFor = (name: string) =>
  `i=0; while [ ! -e ../../${name} ]; do i=$((i+1)); if [ $i -gt 100 ]; then echo "${name} never appeared"; exit 1; fi; sleep 0.1; done`;

describe('make ci', () => {
  it('runs the typecheck and the tests at once, not in dependency order, and says so only when both passed', () => {
    // a's typecheck waits for a's tests, which wait for it: one after the
    // other, the first waits for good. It also waits for the tests of b,
    // which depends on a: in dependency order, nothing of b starts before
    // all of a has ended. Two at a time is enough.
    const dir = workspace({
      a: { typecheck: `touch ../../a-typecheck; ${waitFor('a-test')}; ${waitFor('b-test')}`, test: `touch ../../a-test; ${waitFor('a-typecheck')}` },
      b: { dependencies: { a: 'workspace:*' }, typecheck: 'true', test: 'touch ../../b-test' },
    });

    const { status, output } = makeCi(dir);

    // A script that waited for good gave up after ten seconds, and failed.
    expect(status, output).toBe(0);
    expect(output.trim().split('\n').at(-1)).toBe('ci: green');
    // pnpm also exits 0 when no script matches the pattern: these say the
    // scripts ran.
    for (const ran of ['a-typecheck', 'a-test', 'b-test']) expect(existsSync(join(dir, ran)), `${ran} never ran`).toBe(true);
  });

  it.each([
    ['the typecheck', 'typecheck', "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'."],
    ['a test', 'test', 'AssertionError: expected 1 to be 2'],
  ])('fails when %s fails, with the failure in the end openadlc-ci keeps, and ends the rest', async (_what, script, failure) => {
    // b's tests print far more than openadlc-ci keeps, before and after a
    // fails: had make ci waited for them, they would have pushed the failure
    // out of what is kept. Then they would run on for half a minute. a fails
    // a second after they start.
    const lines = `i=0; while [ $i -lt 400 ]; do echo "b's tests are still running, line $i of 400, ${'.'.repeat(60)}"; i=$((i+1)); sleep 0.01; done`;
    const dir = workspace({
      a: { typecheck: 'true', test: 'true', [script]: `${waitFor('b-test.pid')}; sleep 1; echo "${failure}"; exit 2` },
      b: { typecheck: 'true', test: `echo $$ > ../../b-test.pid; ${lines}; sleep 30` },
    });

    const { status, output, ms } = makeCi(dir);

    expect(status, output).toBe(2);
    expect(output).not.toContain('ci: green');
    const kept = output.slice(-LOG_TAIL_BYTES);
    expect(kept).toContain(failure);
    expect(kept).toMatch(new RegExp(`ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL.*a@ ${script}`));
    expect(ms).toBeLessThan(15_000);
    const pid = Number(readFileSync(join(dir, 'b-test.pid'), 'utf8'));
    expect(await endsWithin(pid, 2_000), `b's tests (pid ${pid}) were left running`).toBe(true);
  });
});

async function endsWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}
