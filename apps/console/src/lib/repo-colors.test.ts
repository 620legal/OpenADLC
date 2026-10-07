import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REPO_COLORS, colorMapOf, repoColorName, repoEdge, repoFill, repoOfRef } from './repo-colors';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('the colours a repository can have', () => {
  it('are the ones the bridge stores, in the order it hands them out', () => {
    // Two copies of one list: the console does not depend on @fleetadlc/shared, so
    // this is where the two are held together.
    const shared = /REPO_COLORS = \[([^\]]+)\]/.exec(read('../../../../packages/shared/src/repo-colors.ts'))?.[1];
    expect(shared?.split(',').map((entry) => entry.trim().replace(/'/g, ''))).toEqual([...REPO_COLORS]);
  });

  it('each have a dot, a card edge and a name, written out whole so Tailwind generates them', () => {
    const source = read('./repo-colors.ts');
    for (const color of REPO_COLORS) {
      expect(repoFill(color)).toBe(`bg-repo-${color}`);
      expect(repoEdge(color)).toBe(`border-l-repo-${color}`);
      expect(source).toContain(`'bg-repo-${color}'`);
      expect(source).toContain(`'border-l-repo-${color}'`);
      expect(repoColorName(color)).toMatch(/^[A-Z][a-z]+$/);
    }
  });

  it('fall back to a quiet dot for a colour the console does not know, rather than none', () => {
    expect(repoFill('chartreuse')).toBe('bg-dim');
    expect(repoFill(null)).toBe('bg-dim');
    expect(repoEdge(undefined)).toBe('border-l-edge-strong');
  });
});

describe('which repository a subject is in', () => {
  it('is read from its address', () => {
    expect(repoOfRef('api#12')).toBe('api');
    expect(repoOfRef('fleetadlc-testbed@3f2c1a9')).toBe('fleetadlc-testbed');
    expect(repoOfRef('request:a4b02784')).toBeNull();
    expect(repoOfRef('')).toBeNull();
  });

  it('is coloured from the repositories the page read', () => {
    expect(colorMapOf([{ name: 'api', color: 'teal' }, { name: 'web', color: null }])).toEqual({ api: 'teal' });
  });
});
