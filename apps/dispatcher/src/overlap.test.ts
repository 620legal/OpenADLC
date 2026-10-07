import { describe, expect, it } from 'vitest';
import { DEFAULT_PATH_POLICY } from '@fleetadlc/shared';
import { overlapKind, pathMatches, pathsOverlap } from './overlap.js';

describe('declared path overlap', () => {
  it('finds a collision on the same directory', () => {
    expect(pathsOverlap(['src/leases/**'], ['src/leases/expiry.ts'])).toBe(true);
  });

  it('lets unrelated directories run at once', () => {
    expect(pathsOverlap(['src/leases/**'], ['src/console/board.tsx'])).toBe(false);
  });

  it('treats a double star as covering everything below it', () => {
    expect(pathsOverlap(['**'], ['anything/at/all.ts'])).toBe(true);
  });

  it('matches a wildcard inside a segment', () => {
    expect(pathsOverlap(['src/*.ts'], ['src/main.ts'])).toBe(true);
    expect(pathsOverlap(['src/*.ts'], ['docs/main.ts'])).toBe(false);
  });

  it('treats a shorter prefix as containing the longer path', () => {
    expect(pathsOverlap(['apps/bridge'], ['apps/bridge/src/api.ts'])).toBe(true);
  });

  it('reports no overlap when nothing is declared', () => {
    expect(pathsOverlap([], ['src/anything.ts'])).toBe(false);
  });
});

describe('a path policy pattern', () => {
  it('names a file at any depth when it has no slash, and a path from the root when it has one', () => {
    expect(pathMatches('Makefile', 'Makefile')).toBe(true);
    expect(pathMatches('apps/web/package-lock.json', '*lock*.json')).toBe(true);
    expect(pathMatches('README.md', 'README*')).toBe(true);
    expect(pathMatches('db/migrations/0002_add.sql', '**/migrations/**')).toBe(true);
    expect(pathMatches('db/migrations/', '**/migrations/**')).toBe(true);
    expect(pathMatches('docs/guide/index.md', 'docs/**/index*')).toBe(true);
    expect(pathMatches('src/docs/index.md', 'docs/**/index*')).toBe(false);
    expect(pathMatches('src/app.ts', '**/migrations/**')).toBe(false);
  });
});

describe('how two overlapping paths are treated by default', () => {
  it('waves shared files through, holds exclusive ones, and calls the rest ordinary', () => {
    expect(overlapKind('Makefile', 'Makefile', DEFAULT_PATH_POLICY)).toBe('shared');
    expect(overlapKind('README.md', 'README.md', DEFAULT_PATH_POLICY)).toBe('shared');
    expect(overlapKind('db/migrations/0002.sql', 'db/migrations/', DEFAULT_PATH_POLICY)).toBe('exclusive');
    expect(overlapKind('pnpm-lock.yaml', 'pnpm-lock.yaml', DEFAULT_PATH_POLICY)).toBe('exclusive');
    expect(overlapKind('src/app.ts', 'src/', DEFAULT_PATH_POLICY)).toBe('ordinary');
    // A folder against a shared file in it is not waved through: the folder is more than that file.
    expect(overlapKind('docs/', 'docs/guide/index.md', DEFAULT_PATH_POLICY)).toBe('ordinary');
  });
});

describe('a policy pattern that names a folder', () => {
  it('is that folder and everything in it, as the merge line’s conflict round reads it', () => {
    // `exclusive: [db/]`, read as the one path `db`, held none of the
    // migrations under it, while the conflict round held all of them.
    expect(pathMatches('db/migrations/001.sql', 'db/')).toBe(true);
    expect(pathMatches('db', 'db/')).toBe(true);
    expect(pathMatches('src/db/x.ts', 'db/')).toBe(false);
    expect(overlapKind('db/migrations/002.sql', 'db/migrations/002.sql', { shared: [], exclusive: ['db/'] })).toBe('exclusive');
  });
});
