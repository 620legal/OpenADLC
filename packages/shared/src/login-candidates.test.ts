import { describe, expect, it } from 'vitest';
import { loginCandidates } from './onboarding.js';

/**
 * Bot names such as `fleetadlc-flow` live in GitHub's global namespace, and a
 * suggested name has been found already taken by a stranger. An install that adopts one of them
 * works for a stranger, so the owner's name goes into every proposed name.
 */
describe('names to try for a bot account', () => {
  it('puts the owner in the name, so it is nobody else’s', () => {
    expect(loginCandidates('atlas', 'janedoe')[0]).toBe('fleetadlc-atlas-janedoe');
  });

  it('offers the bare name last, because it is the one most likely to be taken', () => {
    const candidates = loginCandidates('flow', 'janedoe');
    expect(candidates.at(-1)).toBe('fleetadlc-flow');
    expect(candidates[0]).not.toBe('fleetadlc-flow');
  });

  it('falls back to the bare name when there is no owner yet', () => {
    expect(loginCandidates('atlas', null)).toEqual(['fleetadlc-atlas']);
  });

  it('produces something GitHub will accept from an awkward owner name', () => {
    // A form that suggests a name GitHub rejects has wasted the whole sign-up.
    for (const candidate of loginCandidates('atlas', 'Acme Corp. Ltd!')) {
      expect(candidate).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
      expect(candidate.length).toBeLessThanOrEqual(39);
    }
  });

  it('never ends in a hyphen after truncating a long owner', () => {
    // 39 characters is GitHub's limit, and a cut that lands on a hyphen makes
    // an invalid name out of a valid one.
    const long = 'a'.repeat(60);
    for (const candidate of loginCandidates('atlas', long)) {
      expect(candidate.endsWith('-')).toBe(false);
      expect(candidate.length).toBeLessThanOrEqual(39);
    }
  });

  it('does not offer the same name twice', () => {
    const candidates = loginCandidates('atlas', 'janedoe');
    expect(new Set(candidates).size).toBe(candidates.length);
  });
});
