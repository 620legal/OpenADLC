import { describe, expect, it } from 'vitest';
import { accountLine, ownerOf, visibilityLine } from './app-reach';

describe('an account the app is, or is not, installed on', () => {
  it('says what kind of account it is and what the app has of it', () => {
    const installed = (selection: 'all' | 'selected', suspended = false) => ({ id: 1, selection, settingsUrl: null, suspended });
    expect(accountLine({ type: 'User', installation: installed('all') })).toBe('personal · all repositories');
    expect(accountLine({ type: 'Organization', installation: installed('selected') })).toBe('organization · chosen repositories');
    expect(accountLine({ type: 'Organization', installation: installed('all', true) })).toBe('organization · suspended');
    expect(accountLine({ type: 'Organization', installation: null })).toBe('organization · not installed');
    // GitHub did not say what it is: only what the app has of it.
    expect(accountLine({ type: null, installation: null })).toBe('not installed');
  });

  it('is the owner part of a repository’s name', () => {
    expect(ownerOf('exampleco/infra')).toBe('exampleco');
  });
});

describe('who can install the app', () => {
  const owner = { login: 'janedoe', type: 'User' as const };

  it('says a private app installs only on its owner', () => {
    expect(visibilityLine({ visibility: 'private', owner })).toBe('Private: only janedoe can install it.');
  });

  it('says a public app installs anywhere, and where OpenADLC acts', () => {
    expect(visibilityLine({ visibility: 'public', owner })).toBe('Public: any account can install it. OpenADLC acts only where it works in a repository.');
  });

  it('does not guess when GitHub did not say', () => {
    expect(visibilityLine({ visibility: 'unknown', owner })).toContain('did not say whether it is public');
  });
});
