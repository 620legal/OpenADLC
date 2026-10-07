import { describe, expect, it } from 'vitest';
import { dependencyIsSatisfied, parseDependencies } from './dependencies.js';

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
    expect(parseDependencies(BODY)).toEqual([42, 51]);
  });

  it('stops at the next heading, so a later section is not a dependency', () => {
    // `#99` under Expected paths would otherwise block the issue on something
    // nobody declared.
    expect(parseDependencies('### Dependencies\n\n- #1\n\n### Notes\n\n- see #99\n')).toEqual([1]);
  });

  it('reads a reference in a sentence as prose, not a dependency', () => {
    // Intake wrote this on an issue with no dependencies, and the issue waited
    // for #3 — closed as superseded, never to ship — without a word.
    expect(parseDependencies('## Dependencies\n\nNone. This supersedes #3, which is closed as superseded; it is not a dependency.\n')).toEqual([]);
    expect(parseDependencies('## Dependencies\n\n#4\n1. #5 first\n* #6\nSee #7 for context.\n')).toEqual([4, 5, 6]);
  });

  it('takes one dependency per line, not every number on it', () => {
    // The text after the number is for a person; reading it as a second
    // dependency blocks on something that was never declared.
    expect(parseDependencies('### Dependencies\n\n- #7 — also touches #8 and #9\n')).toEqual([7]);
  });

  it('is nothing when the issue names none', () => {
    expect(parseDependencies('### Outcome\n\nNo dependencies here.\n')).toEqual([]);
    expect(parseDependencies('')).toEqual([]);
    expect(parseDependencies(null)).toEqual([]);
  });

  it('accepts a bare reference and any heading level', () => {
    expect(parseDependencies('## DEPENDENCIES\n\n#3\n')).toEqual([3]);
  });
});

describe('whether a dependency has shipped far enough', () => {
  const dep = (stage: string, labels: string[] = []) => ({ stage, labels });

  it('is satisfied once it is merged and on testing', () => {
    expect(dependencyIsSatisfied(dep('merged', ['deployed:testing']))).toBe(true);
    expect(dependencyIsSatisfied(dep('done', ['deployed:testing']))).toBe(true);
  });

  it('is satisfied by Done with no deploy label, which is how a repository that deploys nothing ships', () => {
    // fleetadlc-testbed deploys nothing, so a merge moves its card straight to
    // Done and no deploy ever labels it: #3 would have waited on #1 for good.
    expect(dependencyIsSatisfied(dep('done', []))).toBe(true);
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
