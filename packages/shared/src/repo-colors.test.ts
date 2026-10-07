import { describe, expect, it } from 'vitest';
import { REPO_COLORS, isRepoColor, nextRepoColor } from './repo-colors.js';

describe('the colour a repository is given when it is added', () => {
  it('is the next one in the order added, starting from the first', () => {
    expect(nextRepoColor([])).toBe('blue');
    expect(nextRepoColor(['blue'])).toBe('amber');
    expect(nextRepoColor(['blue', 'amber'])).toBe('pink');
  });

  it('is one nobody has, after a repository in the middle was removed and gave its colour back', () => {
    expect(nextRepoColor(['blue', 'pink', 'teal'])).toBe('amber');
  });

  it('never repeats while a colour is free, whatever was chosen by hand', () => {
    // Somebody picked amber for the first repository in settings.
    expect(nextRepoColor(['amber'])).toBe('blue');
    const handed: string[] = [];
    for (let index = 0; index < REPO_COLORS.length; index += 1) handed.push(nextRepoColor(handed));
    expect(new Set(handed).size).toBe(REPO_COLORS.length);
  });

  it('is the least shared once every one is taken, the earlier on a tie', () => {
    expect(nextRepoColor([...REPO_COLORS])).toBe('blue');
    expect(nextRepoColor([...REPO_COLORS, 'blue', 'amber'])).toBe('pink');
  });

  it('ignores a colour it does not know, rather than counting it', () => {
    expect(nextRepoColor(['chartreuse'])).toBe('blue');
  });
});

describe('a colour', () => {
  it('is a name from the list, never a value', () => {
    expect(isRepoColor('teal')).toBe(true);
    expect(isRepoColor('#0f766e')).toBe(false);
    expect(isRepoColor('var(--color-alarm)')).toBe(false);
    expect(isRepoColor(undefined)).toBe(false);
  });
});
