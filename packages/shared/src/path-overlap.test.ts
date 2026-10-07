import { describe, expect, it } from 'vitest';
import { globMatch, pathMatches, pathsOverlap } from './path-overlap.js';

describe('two declared globs in one segment', () => {
  it('overlap when one name can match both', () => {
    // Read as pattern against the other's text, stars and all, these were
    // disjoint, and two builds could be sent at scheduler.test.ts.
    expect(pathsOverlap(['apps/bridge/src/scheduler*'], ['apps/bridge/src/*.test.ts'])).toBe(true);
    expect(pathsOverlap(['src/*gate*'], ['src/web*.ts'])).toBe(true);
  });

  it('stay apart when their starts or their ends cannot agree', () => {
    expect(pathsOverlap(['src/a*.ts'], ['src/b*.ts'])).toBe(false);
    expect(pathsOverlap(['src/*.ts'], ['src/*.md'])).toBe(false);
  });

  it('do not change how a policy pattern names a path', () => {
    expect(pathMatches('READ*', 'README*')).toBe(false);
  });
});

describe('a star in a name', () => {
  it('is any run of characters, and nothing else is a wildcard', () => {
    expect(globMatch('scheduler*', 'scheduler.test.ts')).toBe(true);
    expect(globMatch('0012_*', '0012_init.sql')).toBe(true);
    expect(globMatch('*.test.ts', 'gates.test.ts')).toBe(true);
    expect(globMatch('a*b*c', 'axxbyyc')).toBe(true);
    expect(globMatch('a*b*c', 'axxbyy')).toBe(false);
    expect(globMatch('*', '')).toBe(true);
    expect(globMatch('a.b', 'axb')).toBe(false);
    expect(globMatch('a?[b]', 'a?[b]')).toBe(true);
    expect(globMatch('a?', 'ab')).toBe(false);
  });

  it('is matched in linear time, so one starred path cannot stall the dispatcher', () => {
    // A RegExp of `.*` per star took eight seconds on twelve stars here, in
    // the bridge's own process.
    const started = performance.now();
    expect(pathsOverlap(['apps/bridge/src/' + '*'.repeat(30) + 'Q'], ['apps/bridge/src/deploy-pipeline.test.ts'])).toBe(false);
    expect(globMatch('a*'.repeat(30) + 'b', 'a'.repeat(60))).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
