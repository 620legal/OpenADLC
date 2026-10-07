import { describe, expect, it } from 'vitest';
import { AppManifestStates, STATE_TTL_MS } from './app-manifest-state.js';

describe('the state a create of the app carries', () => {
  it('is 32 random bytes, a new one each time', () => {
    const states = new AppManifestStates();
    const one = states.issue(null);
    const two = states.issue(null);
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(two).not.toBe(one);
  });

  it('is good once, with the owner it was issued for', () => {
    const states = new AppManifestStates();
    const state = states.issue('exampleco');
    expect(states.consume(state)).toEqual({ expectedOwner: 'exampleco' });
    expect(states.consume(state)).toBeNull();
  });

  it('is nothing when missing, unknown or expired', () => {
    let now = 0;
    const states = new AppManifestStates(() => now);
    const state = states.issue(null);
    expect(states.consume(undefined)).toBeNull();
    expect(states.consume('f'.repeat(64))).toBeNull();
    now = STATE_TTL_MS + 1;
    expect(states.consume(state)).toBeNull();
  });

  it('keeps at most fifty waiting, the oldest let go first', () => {
    const states = new AppManifestStates();
    const first = states.issue(null);
    const later = Array.from({ length: 50 }, () => states.issue(null));
    expect(states.consume(first)).toBeNull();
    expect(states.consume(later.at(-1))).toEqual({ expectedOwner: null });
  });
});
