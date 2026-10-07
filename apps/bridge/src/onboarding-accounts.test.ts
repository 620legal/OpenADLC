import { describe, expect, it } from 'vitest';
import { accountHolder, holdsCredential, provenSignIn } from './onboarding.js';

const crew = [
  {
    id: 'b-builder',
    name: 'fleetadlc-atlas-janedoe',
    role: 'implement' as const,
    githubLogin: 'fleetadlc-atlas-janedoe',
    connected: true,
  },
  // Named by config/bots.yaml from an earlier install; nothing stored.
  { id: 'b-lead', name: 'sydney', role: 'review_lead' as const, githubLogin: 'noraexampleco', connected: false },
  { id: 'b-se', name: 'nova', role: 'spec' as const, githubLogin: 'fleetadlc-nova', connected: false },
];

describe('whose account an authorization is', () => {
  it('is another bot’s when that bot is connected as it', () => {
    expect(accountHolder('FleetADLC-Atlas-Janedoe', 'b-se', crew)?.id).toBe('b-builder');
  });

  it('is nobody’s when another row only names it', () => {
    // The system engineer's connect was approved as noraexampleco, which the
    // lead reviewer's row named from a file an earlier install left behind.
    // That row holds nothing, so the account is free to connect.
    expect(accountHolder('noraexampleco', 'b-se', crew)).toBeNull();
  });

  it('does not count the bot being connected, or an account nobody has', () => {
    expect(accountHolder('fleetadlc-nova', 'b-se', crew)).toBeNull();
    expect(accountHolder('someone-new', 'b-se', crew)).toBeNull();
  });

  it('names the connected holder when an account is on two rows', () => {
    const twice = [...crew, { id: 'b-qa', name: 'qa-handle', role: 'qa' as const, githubLogin: 'noraexampleco', connected: true }];
    expect(accountHolder('noraexampleco', 'b-se', twice)?.id).toBe('b-qa');
  });
});

describe('who is connected', () => {
  it('is a bot holding a token or an active credential, the same rule the walkthrough counts', () => {
    expect(holdsCredential('refresh', null)).toBe(true);
    expect(holdsCredential(null, { status: 'active' })).toBe(true);
    expect(holdsCredential(null, { status: 'revoked' })).toBe(false);
    expect(holdsCredential(null, null)).toBe(false);
  });
});

describe('what the sign-in check proved, as the accounts card reads it', () => {
  const at = (checkedAt: string, state: 'ok' | 'failing', facts: Record<string, unknown> = {}) => ({ checkedAt, state, facts });

  it('believes a check made since the seat last signed in', () => {
    expect(provenSignIn(at('2026-09-28T12:05:00Z', 'ok'), '2026-09-28T12:00:00Z')).toBe(true);
    expect(provenSignIn(at('2026-09-28T12:05:00Z', 'failing', { refused: true }), '2026-09-28T12:00:00Z')).toBe(false);
  });

  it('ignores a failing check from before a reconnect, so the stored status decides', () => {
    // Reconnected at 12:10; the check that failed at 12:05 has not run again yet.
    expect(provenSignIn(at('2026-09-28T12:05:00Z', 'failing', { refused: true }), '2026-09-28T12:10:00Z')).toBeNull();
  });

  it('reads a seat with no account yet as no verdict on the account it was just given', () => {
    expect(provenSignIn(at('2026-09-28T12:05:00Z', 'failing'), null)).toBeNull();
    expect(provenSignIn(undefined, null)).toBeNull();
  });
});
