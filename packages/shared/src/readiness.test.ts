import { describe, expect, it } from 'vitest';
import { missingForRouting, onlyExpectedPathsUnreadable, tooManyAttempts } from './readiness.js';

const BODY = `### Outcome

Something.

### Acceptance criteria

- It works.

### Expected paths

- src/thing.ts

### Verification

Run the tests.
`;

const ready = {
  labels: ['adlc:build', 'start:now', 'priority:p1', 'area:bridge', 'do:ai'],
  declaredPaths: ['src/thing.ts'],
  body: BODY,
};

describe('an issue has to say enough to be worked on', () => {
  it('is ready when it does', () => {
    expect(missingForRouting(ready)).toEqual([]);
  });

  it('is not ready without declared paths', () => {
    // The one with teeth: declared paths are what the lease claims and what the
    // overlap check compares, so without them two bots can be sent at one file.
    expect(missingForRouting({ ...ready, declaredPaths: [] })).toContain('at least one expected path');
  });

  it('needs a priority, so the board can order it', () => {
    const labels = ready.labels.filter((label) => !label.startsWith('priority:'));
    expect(missingForRouting({ ...ready, labels })).toContain('a priority label');
  });

  it('needs an area, so it can be routed', () => {
    const labels = ready.labels.filter((label) => !label.startsWith('area:'));
    expect(missingForRouting({ ...ready, labels })).toContain('an area label');
  });

  it('needs exactly one do:, not none', () => {
    const labels = ready.labels.filter((label) => !label.startsWith('do:'));
    expect(missingForRouting({ ...ready, labels })).toContain('a do: label');
  });

  it('needs exactly one do:, not two', () => {
    // Two is a disagreement about who acts, and nothing downstream resolves it.
    const missing = missingForRouting({ ...ready, labels: [...ready.labels, 'do:human'] });
    expect(missing.some((entry) => entry.startsWith('one do: label, not 2'))).toBe(true);
  });

  it('names every missing section rather than the first', () => {
    // A person fixing this should need one round, not four.
    const missing = missingForRouting({ ...ready, body: '### Outcome\n\nOnly this.\n' });
    expect(missing).toContain('an Acceptance criteria section');
    expect(missing).toContain('an Expected paths section');
    expect(missing).toContain('a Verification section');
  });

  it('reads a section at any heading level and any case', () => {
    const body = BODY.replace('### Outcome', '## OUTCOME');
    expect(missingForRouting({ ...ready, body })).toEqual([]);
  });

  it('lists everything wrong with an empty issue', () => {
    const missing = missingForRouting({ labels: [], declaredPaths: [], body: '' });
    expect(missing.length).toBeGreaterThanOrEqual(7);
  });
});

describe('an Expected paths line that is not a path', () => {
  const body = BODY.replace('- src/thing.ts', '- src/thing.ts and its test\n- the docs page');

  it('is named, line by line, as what is missing', () => {
    // It was declared as a path: the lease claimed a sentence and missed the files.
    expect(missingForRouting({ ...ready, body, declaredPaths: ['src/thing.ts'] })).toEqual([
      'an Expected paths line that is not a path: src/thing.ts and its test',
      'an Expected paths line that is not a path: the docs page',
    ]);
  });

  it('is all that is missing only when nothing else is', () => {
    expect(onlyExpectedPathsUnreadable(missingForRouting({ ...ready, body, declaredPaths: ['src/thing.ts'] }))).toBe(true);
    const unread = BODY.replace('- src/thing.ts', '- the thing module');
    expect(onlyExpectedPathsUnreadable(missingForRouting({ ...ready, body: unread, declaredPaths: [] }))).toBe(true);
    // Something a person has to say as well, or no line there at all, is triage's.
    expect(onlyExpectedPathsUnreadable(missingForRouting({ ...ready, body, labels: ['adlc:build'], declaredPaths: ['src/thing.ts'] }))).toBe(false);
    expect(onlyExpectedPathsUnreadable(missingForRouting({ ...ready, declaredPaths: [] }))).toBe(false);
    expect(onlyExpectedPathsUnreadable([])).toBe(false);
  });
});

describe('an issue that keeps coming back with nothing', () => {
  it('goes to triage on the third attempt', () => {
    // Three failures to produce a pull request is the issue failing to say what
    // it wants. A fourth attempt is how a loop is made.
    expect(tooManyAttempts(0)).toBe(false);
    expect(tooManyAttempts(2)).toBe(false);
    expect(tooManyAttempts(3)).toBe(true);
    expect(tooManyAttempts(9)).toBe(true);
  });
});
