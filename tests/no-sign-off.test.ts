import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Nothing a person or a bot reads tells them to sign off a commit.
 *
 * OpenADLC takes contributions under Apache-2.0 on GitHub's inbound=outbound
 * terms, with no DCO. The crew does what AGENTS.md and its skills say, so while
 * they said `git commit -s` the bots added sign-off lines: a personal
 * certification a bot cannot make, in a history that the rule it claimed to
 * follow did not hold for anyway. Only these files are scanned, so a historical
 * mention in a design record does not trip it.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Built from parts so this file does not hold what it looks for.
const FORBIDDEN: RegExp[] = [
  new RegExp(['commit', '-s\\b'].join('\\s+(?:[^\\n`]*\\s)?')),
  new RegExp(['--sign', 'off'].join('')),
  new RegExp(['signed', 'off', 'by'].join('-'), 'i'),
  new RegExp(['developer', 'certificate', 'of', 'origin'].join('\\s+'), 'i'),
];

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const files = [
  join(ROOT, 'AGENTS.md'),
  join(ROOT, '.github', 'CONTRIBUTING.md'),
  join(ROOT, 'docs', 'development.md'),
  ...walk(join(ROOT, 'crew', 'skills')),
  ...walk(join(ROOT, 'crew', 'templates')),
];

describe('no sign-off', () => {
  it('finds the skills and templates', () => {
    // Guards the walk: with nothing found, every check below passes.
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files.map((file) => [file.slice(ROOT.length + 1), file]))('%s asks for no sign-off', (_name, file) => {
    const text = readFileSync(file, 'utf8');
    const found = FORBIDDEN.filter((pattern) => pattern.test(text)).map(String);
    expect(found).toEqual([]);
  });

  it('catches the old instructions', () => {
    for (const line of [
      'git commit -s -m "Revert <sha>: the smoke failed on testing"',
      'git commit --no-edit -s',
      ['git commit --sign', 'off'].join(''),
      ['Signed', 'off', 'by: builder <builder@example.com>'].join('-'),
      ['## Developer', 'Certificate of Origin'].join(' '),
    ]) {
      expect(FORBIDDEN.some((pattern) => pattern.test(line)), line).toBe(true);
    }
  });
});
