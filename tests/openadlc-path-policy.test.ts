import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  allShared,
  DEFAULT_EXCLUSIVE_PATHS,
  DEFAULT_SHARED_PATHS,
  parseDeliveryRules,
  policyMatches,
  resolutionPolicy,
  type DeliveryRules,
} from '@openadlc/shared';
import { describe, expect, it } from 'vitest';

/**
 * This repository's own `.github/openadlc.yml` (docs/adr/0098).
 *
 * It shares `docs/**` so two builds that name the same docs page stop waiting
 * on each other: #374 and #385 were held back by docs/architecture.md and
 * docs/troubleshooting.md until a person took the paths out by hand. Two
 * things make the file easy to get wrong in silence. Its `shared` list
 * replaces the default rather than adding to it, so a default added later and
 * not repeated here would stop being shared for this repository only. And the
 * file wins over the stored rules, so without `testing.on: release` a merged
 * card would go to Done instead of waiting for a release.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const text = readFileSync(join(ROOT, '.github', 'openadlc.yml'), 'utf8');

function rulesOf(source: string): DeliveryRules {
  const parsed = parseDeliveryRules(source);
  if ('error' in parsed) throw new Error(`delivery rules do not parse: ${parsed.error}`);
  return parsed.rules;
}

describe("this repository's .github/openadlc.yml", () => {
  it('parses as delivery rules', () => {
    const parsed = parseDeliveryRules(text);
    expect('error' in parsed ? parsed.error : null).toBeNull();
  });

  it('ships as the repository did before the file: by release, with the default production rules', () => {
    const { paths: _paths, ...rules } = rulesOf(text);
    const { paths: _defaults, ...before } = rulesOf('version: 1\ntesting:\n  on: release\n');
    expect(rules).toEqual(before);
    expect(rules.testing.on).toBe('release');
  });

  it('shares every default plus docs/**, and keeps the default exclusive paths', () => {
    const rules = rulesOf(text);
    expect(rules.paths.shared).toEqual([...DEFAULT_SHARED_PATHS, 'docs/**']);
    expect(rules.paths.exclusive).toEqual([...DEFAULT_EXCLUSIVE_PATHS]);
  });

  it('gives a conflict round the same lists, with stacking on', () => {
    const policy = resolutionPolicy(text);
    expect(policy.paths.shared).toEqual([...DEFAULT_SHARED_PATHS, 'docs/**']);
    expect(policy.paths.exclusive).toEqual([...DEFAULT_EXCLUSIVE_PATHS]);
    expect(policy.stacking).toBe(true);
  });

  it('treats docs pages as shared, at any depth', () => {
    const policy = resolutionPolicy(text);
    expect(allShared(['docs/architecture.md', 'docs/troubleshooting.md'], policy)).toBe(true);
    expect(allShared(['docs/runbooks/compare-implement-input-tokens.md'], policy)).toBe(true);
  });

  it('does not share a migration, which stays exclusive, or code', () => {
    const policy = resolutionPolicy(text);
    const migration = 'packages/db/migrations/0176_x.sql';
    expect(allShared([migration], policy)).toBe(false);
    expect(policy.paths.exclusive.some((pattern) => policyMatches(migration, pattern))).toBe(true);
    expect(allShared(['apps/bridge/src/gates.ts'], policy)).toBe(false);
  });

  it('is described where docs/development.md explains what runs together', () => {
    const doc = readFileSync(join(ROOT, 'docs', 'development.md'), 'utf8');
    const start = doc.indexOf('## Expected paths decide what runs together');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = doc.indexOf('\n## ', start + 1);
    const section = doc.slice(start, end === -1 ? undefined : end);
    expect(section).toContain('docs/**');
    expect(section).toContain('.github/openadlc.yml');
  });
});
