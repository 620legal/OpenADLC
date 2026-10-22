import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A backup sealed at `TEST_KEY_COST` (packages/backup/src/archive.ts) costs
 * whoever has the file 128 times less per guess at its passphrase than one
 * sealed at a backup's own cost. The tests seal at it because the real cost
 * timed them out under load; nothing else may. `encryptBackup` and
 * `decryptBackup` refuse a cost below a backup's unless they are handed that
 * very object, so the one way past the refusal is to name it — and this fails
 * when a file that is not a test does.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFINED_IN = join('packages', 'backup', 'src', 'archive.ts');
const SKIPPED = new Set(['node_modules', 'dist', '.next', 'coverage']);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (SKIPPED.has(entry)) return [];
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry) ? [path] : [];
  });
}

/** A test, or a module only tests import: `*.test.ts`, or `test-fixtures.ts` and its like. */
const isTest = (path: string): boolean => /\.test\.[cm]?[jt]sx?$/.test(path) || basename(path).startsWith('test-');

describe('the tests’ backup key cost', () => {
  const naming = [...sources(join(ROOT, 'apps')), ...sources(join(ROOT, 'packages'))]
    .filter((path) => readFileSync(path, 'utf8').includes('TEST_KEY_COST'))
    .map((path) => relative(ROOT, path));

  it('is named by tests alone, so no backup outside them is sealed or opened at it', () => {
    expect(naming.filter((path) => path !== DEFINED_IN && !isTest(path))).toEqual([]);
  });

  it('is found where the tests do name it, so the search reads the files it should', () => {
    expect(naming).toContain(DEFINED_IN);
    expect(naming).toContain(join('packages', 'backup', 'src', 'test-fixtures.ts'));
    expect(naming).toContain(join('apps', 'cli', 'src', 'commands', 'backup.test.ts'));
  });
});
