import { describe, expect, it } from 'vitest';
import { actsFor, hasAccess } from './access.js';

/**
 * On a public repository anybody can open an issue, comment, or open a pull
 * request from a fork. OpenADLC acts only for people with access, and its crew.
 */

describe('who has access', () => {
  it('is an owner, a member of the owning organization, or a collaborator', () => {
    expect(['OWNER', 'MEMBER', 'COLLABORATOR', 'collaborator'].map(hasAccess)).toEqual([true, true, true, true]);
  });

  it('is not a contributor from a fork, a first-timer, anybody else, or an author GitHub did not describe', () => {
    expect(['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN', 'NONE', '', null, undefined].map(hasAccess)).toEqual([
      false, false, false, false, false, false, false, false,
    ]);
  });
});

describe('who OpenADLC acts for', () => {
  const crew = [{ githubLogin: 'ottoexampleco' }, { githubLogin: null }];

  it('is somebody with access, or one of the crew whatever GitHub calls it', () => {
    expect(actsFor({ login: 'someone', association: 'MEMBER' }, crew)).toBe(true);
    expect(actsFor({ login: 'Ottoexampleco', association: 'NONE' }, crew)).toBe(true);
  });

  it('is not a stranger, nor a login the crew has no account for', () => {
    expect(actsFor({ login: 'stranger', association: 'NONE' }, crew)).toBe(false);
    expect(actsFor({ login: null, association: 'FIRST_TIME_CONTRIBUTOR' }, crew)).toBe(false);
  });
});
