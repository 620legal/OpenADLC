import { describe, expect, it } from 'vitest';
import { fingerprintOf } from './client.js';

/**
 * What the fingerprint has to get right is one case: merging the base into a
 * branch moves the head and leaves the work identical. A three-dot compare
 * returns the same files with the same blobs, so the fingerprints match and the
 * approval stands.
 */
describe('fingerprinting what a head proposes', () => {
  const file = (
    filename: string,
    sha: string,
    status = 'modified',
    baseSha: string | null = status === 'added' ? null : 'base',
    more: { previousFilename?: string | null; mode?: string } = {},
  ) => ({ filename, previousFilename: more.previousFilename ?? null, status, mode: more.mode ?? '100644', sha, baseSha });

  it('is the same for the same set of changes', () => {
    const before = [file('src/a.ts', 'aaa'), file('src/b.ts', 'bbb')];
    const after = [file('src/a.ts', 'aaa'), file('src/b.ts', 'bbb')];

    expect(fingerprintOf(before)).toBe(fingerprintOf(after));
  });

  it('does not depend on the order GitHub happens to list files in', () => {
    expect(fingerprintOf([file('src/a.ts', 'aaa'), file('src/b.ts', 'bbb')])).toBe(
      fingerprintOf([file('src/b.ts', 'bbb'), file('src/a.ts', 'aaa')]),
    );
  });

  it('changes when a file content changes', () => {
    expect(fingerprintOf([file('src/a.ts', 'aaa')])).not.toBe(fingerprintOf([file('src/a.ts', 'zzz')]));
  });

  it('changes when a file is added or dropped', () => {
    const one = [file('src/a.ts', 'aaa')];
    expect(fingerprintOf(one)).not.toBe(fingerprintOf([...one, file('src/b.ts', 'bbb')]));
  });

  it('changes when the same blob is added rather than modified', () => {
    // Status is part of it, so a file that arrives by a different route is not
    // silently the same change.
    expect(fingerprintOf([file('src/a.ts', 'aaa', 'added')])).not.toBe(
      fingerprintOf([file('src/a.ts', 'aaa', 'modified')]),
    );
  });

  it('changes when a file is renamed to the same content', () => {
    expect(fingerprintOf([file('src/a.ts', 'aaa')])).not.toBe(fingerprintOf([file('src/moved.ts', 'aaa')]));
  });

  it('changes when a file was something else at the merge base, though the head side is the same', () => {
    // A push that merged the base but kept the pull request's own version of a
    // file the base also changed (`git checkout --ours`): the head blob is the
    // one that was approved, and the merge would undo the base's change.
    expect(fingerprintOf([file('src/a.ts', 'aaa', 'modified', 'before-the-fix')])).not.toBe(
      fingerprintOf([file('src/a.ts', 'aaa', 'modified', 'with-the-fix')]),
    );
  });

  it('changes when a rename to the same file comes from a different one', () => {
    // An approved rename of config/staging.yaml, and a later push that deletes
    // config/prod.yaml and adds the same stage.yaml, which git reports as a
    // rename from prod.yaml: the same destination, blob and base blob.
    const from = (previousFilename: string) => [file('config/stage.yaml', 'same', 'renamed', 'was', { previousFilename })];
    expect(fingerprintOf(from('config/staging.yaml'))).not.toBe(fingerprintOf(from('config/prod.yaml')));
  });

  it('changes when the same blob has a different mode', () => {
    // A reviewed file made executable, or turned into a symlink to the same bytes.
    const as = (mode: string) => fingerprintOf([file('bin/run', 'same', 'modified', 'base', { mode })]);
    expect(new Set([as('100644'), as('100755'), as('120000')]).size).toBe(3);
  });

  it('is stable for a pull request that changes nothing', () => {
    expect(fingerprintOf([])).toBe(fingerprintOf([]));
  });
});
