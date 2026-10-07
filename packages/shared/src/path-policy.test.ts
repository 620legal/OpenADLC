import { describe, expect, it } from 'vitest';
import { allShared, policyMatches, resolutionPolicy, resolutionPolicyStrict } from './path-policy.js';

describe('the shared paths and stacking a repository declares', () => {
  it('are the defaults when it says nothing, or nothing readable', () => {
    for (const text of [null, '', 'version: 1\n', ': not yaml [']) {
      const policy = resolutionPolicy(text);
      expect(policy.stacking).toBe(true);
      expect(policy.paths.shared).toContain('Makefile');
      expect(policy.paths.shared).toContain('AGENTS.md');
    }
  });

  it('are what it wrote, each on its own', () => {
    const policy = resolutionPolicy('version: 1\npaths:\n  shared: [Justfile]\nstacking: false\n');
    expect(policy.paths.shared).toEqual(['Justfile']);
    expect(policy.paths.exclusive).toContain('pnpm-lock.yaml');
    expect(policy.stacking).toBe(false);
  });
});

describe('a conflict in shared files only', () => {
  const policy = resolutionPolicy(null);

  it('is one in the files nearly every change adds to', () => {
    expect(allShared(['Makefile', 'README.md', 'docs/index.md', 'docs/guide/index.md', 'apps/web/package.json'], policy)).toBe(true);
  });

  it('is not one with any other file in it, or with none', () => {
    expect(allShared(['Makefile', 'src/cart.ts'], policy)).toBe(false);
    expect(allShared([], policy)).toBe(false);
  });

  it('reads patterns as the dispatcher does: a bare name at any depth, a path from the root', () => {
    expect(policyMatches('apps/web/README.md', 'README*')).toBe(true);
    expect(policyMatches('docs/a/b/index.md', 'docs/**/index*')).toBe(true);
    expect(policyMatches('src/docs/index.md', 'docs/**/index*')).toBe(false);
    expect(policyMatches('db/migrations/001.sql', 'db/')).toBe(true);
  });
});

describe('the policy a conflict resolution goes by', () => {
  it('is the defaults for a file that is not there, and the file’s own when it parses', () => {
    expect(resolutionPolicyStrict(null)).toEqual(resolutionPolicy(null));
    expect(resolutionPolicyStrict('version: 1\npaths:\n  shared: [docs/**]\n')?.paths.shared).toEqual(['docs/**']);
  });

  it('is nothing for a file that is there and does not parse, where the tolerant reading gives the defaults', () => {
    for (const text of ['paths: [unclosed\n', '- a list\n- not rules\n', 'just words']) {
      expect(resolutionPolicyStrict(text)).toBeNull();
    }
    expect(resolutionPolicy('paths: [unclosed\n')).toEqual(resolutionPolicy(null));
  });
});
