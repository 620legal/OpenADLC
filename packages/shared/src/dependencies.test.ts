import { describe, expect, it } from 'vitest';
import { dependencyIsSatisfied, formatDependencyRef, namesRepository, parseDependencyRefs } from './dependencies.js';

const own = (...numbers: number[]) => numbers.map((number) => ({ repo: null, number }));

const BODY = `### Outcome

Something needs doing.

### Dependencies

- #42
- #51 — the token service has to land first
- #42

### Expected paths

- src/thing.ts
`;

describe('what an issue says it is waiting for', () => {
  it('reads the numbers in the order written, without repeats', () => {
    expect(parseDependencyRefs(BODY)).toEqual(own(42, 51));
  });

  it('stops at the next heading, so a later section is not a dependency', () => {
    // `#99` under Expected paths would otherwise block the issue on something
    // nobody declared.
    expect(parseDependencyRefs('### Dependencies\n\n- #1\n\n### Notes\n\n- see #99\n')).toEqual(own(1));
  });

  it('reads a reference in a sentence as prose, not a dependency', () => {
    // Intake wrote this on an issue with no dependencies, and the issue waited
    // for #3 — closed as superseded, never to ship — without a word.
    expect(parseDependencyRefs('## Dependencies\n\nNone. This supersedes #3, which is closed as superseded; it is not a dependency.\n')).toEqual(own());
    expect(parseDependencyRefs('## Dependencies\n\n#4\n1. #5 first\n* #6\nSee #7 for context.\n')).toEqual(own(4, 5, 6));
  });

  it('takes one dependency per line, not every number on it', () => {
    // The text after the number is for a person; reading it as a second
    // dependency blocks on something that was never declared.
    expect(parseDependencyRefs('### Dependencies\n\n- #7 — also touches #8 and #9\n')).toEqual(own(7));
  });

  it('is nothing when the issue names none', () => {
    expect(parseDependencyRefs('### Outcome\n\nNo dependencies here.\n')).toEqual(own());
    expect(parseDependencyRefs('')).toEqual(own());
    expect(parseDependencyRefs(null)).toEqual(own());
  });

  it('accepts a bare reference and any heading level', () => {
    expect(parseDependencyRefs('## DEPENDENCIES\n\n#3\n')).toEqual(own(3));
  });

  it('reads a reference to another repository, as GitHub writes one', () => {
    // An issue waiting on work in another managed repository was given
    // `start:now` and built before that work shipped: the line was skipped.
    expect(parseDependencyRefs('## Dependencies\n\n- a/b#3\nA/B#3\n1. c/d.e#4 first\n#5\nSee x/y#6.\n- #7 — also x/y#8')).toEqual([
      { repo: 'a/b', number: 3 },
      { repo: 'c/d.e', number: 4 },
      { repo: null, number: 5 },
      { repo: null, number: 7 },
    ]);
  });

  it('writes a reference back as it was given', () => {
    expect(formatDependencyRef({ repo: null, number: 5 })).toBe('#5');
    expect(formatDependencyRef({ repo: 'a/b', number: 3 })).toBe('a/b#3');
  });

  it('names a repository in any case, and its own when it names none', () => {
    expect(namesRepository({ repo: 'A/B', number: 1 }, 'a/b')).toBe(true);
    expect(namesRepository({ repo: null, number: 1 }, 'a/b')).toBe(true);
    expect(namesRepository({ repo: 'a/c', number: 1 }, 'a/b')).toBe(false);
  });
});

describe('whether a dependency has shipped far enough', () => {
  const dep = (stage: string, labels: string[] = []) => ({ stage, labels });

  it('is satisfied once it is merged and on testing', () => {
    expect(dependencyIsSatisfied(dep('merged', ['deployed:testing']))).toBe(true);
    expect(dependencyIsSatisfied(dep('done', ['deployed:testing']))).toBe(true);
  });

  it('is satisfied by Done with no deploy label, which is how a repository that deploys nothing ships', () => {
    // openadlc-testbed deploys nothing, so a merge moves its card straight to
    // Done and no deploy ever labels it: #3 would have waited on #1 for good.
    expect(dependencyIsSatisfied(dep('done', []))).toBe(true);
  });

  it('is not satisfied by Done reached by closing it without a merge', () => {
    // Abandoned work is in Done so it leaves the board's working columns, and
    // nothing of it shipped: what waits on it stays blocked for a person.
    expect(dependencyIsSatisfied(dep('done', ['adlc:done', 'openadlc:abandoned']))).toBe(false);
    expect(dependencyIsSatisfied(dep('done', ['adlc:done']))).toBe(true);
  });

  it('is not satisfied by a merge alone', () => {
    // A merge is not a release. An issue waiting on a behaviour is waiting for
    // it to be somewhere it can be seen.
    expect(dependencyIsSatisfied(dep('merged', []))).toBe(false);
  });

  it('is not satisfied while the work is still in flight', () => {
    expect(dependencyIsSatisfied(dep('build', ['deployed:testing']))).toBe(false);
    expect(dependencyIsSatisfied(dep('review', ['deployed:testing']))).toBe(false);
  });

  it('is not satisfied by a dependency the platform has never seen', () => {
    // An issue that names something unknown is not unblocked by its absence;
    // somebody has to look.
    expect(dependencyIsSatisfied(null)).toBe(false);
  });
});
