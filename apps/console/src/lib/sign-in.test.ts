import { describe, expect, it } from 'vitest';
import {
  SESSION_LABEL,
  SIGN_IN_LABEL,
  cookieFrom,
  mint,
  sessionValue,
  signInToken,
  validSession,
  validSignInToken,
} from './sign-in';

const SECRET = '0123456789abcdef'.repeat(4);
const NOW = 1_800_000_000;

/**
 * The same vector `apps/cli/src/console-link.test.ts` checks against
 * node:crypto: a link the CLI prints is one the console accepts.
 */
const LINK_VECTOR = '1800003600.55e64a713ef5fed11eac66d38c157758eb45f2473d58705e088827f7e12b4835';
const SESSION_VECTOR = '1802592000.dd0209927f2607e8cf7d446dc89513edb0e8f7a59ffcfd634e83e4fa3c678925';

describe('a sign-in link', () => {
  it('is the fixed vector the CLI mints, valid for an hour', async () => {
    expect(await signInToken(SECRET, NOW)).toBe(LINK_VECTOR);
    expect(await validSignInToken(SECRET, LINK_VECTOR, NOW)).toBe(true);
    expect(await validSignInToken(SECRET, LINK_VECTOR, NOW + 3599)).toBe(true);
    expect(await validSignInToken(SECRET, LINK_VECTOR, NOW + 3600)).toBe(false);
  });

  it('is refused under another secret, edited, or malformed', async () => {
    expect(await validSignInToken('f'.repeat(64), LINK_VECTOR, NOW)).toBe(false);
    expect(await validSignInToken('', LINK_VECTOR, NOW)).toBe(false);
    // A later expiry with the old signature.
    expect(await validSignInToken(SECRET, LINK_VECTOR.replace('1800003600', '1900003600'), NOW)).toBe(false);
    for (const nonsense of ['', '1800003600', '1800003600.', 'abc.def', `${LINK_VECTOR}0`]) {
      expect(await validSignInToken(SECRET, nonsense, NOW), nonsense).toBe(false);
    }
  });

  it('is never a session, and a session is never a link', async () => {
    // Different labels: the link is in a URL and a shell's history; the cookie lasts a month.
    expect(await validSession(SECRET, LINK_VECTOR, NOW)).toBe(false);
    expect(await validSignInToken(SECRET, SESSION_VECTOR, NOW)).toBe(false);
  });
});

describe('a session', () => {
  it('lasts thirty days', async () => {
    expect(await sessionValue(SECRET, NOW)).toBe(SESSION_VECTOR);
    expect(await mint(SECRET, SESSION_LABEL, 1_802_592_000)).toBe(SESSION_VECTOR);
    expect(await validSession(SECRET, SESSION_VECTOR, NOW + 30 * 86400 - 1)).toBe(true);
    expect(await validSession(SECRET, SESSION_VECTOR, NOW + 30 * 86400)).toBe(false);
  });

  it('is signed under its own label', async () => {
    expect(SESSION_LABEL).not.toBe(SIGN_IN_LABEL);
  });
});

describe('the cookie header', () => {
  it('gives the one cookie asked for', () => {
    expect(cookieFrom('theme=dark; fleetadlc_session=1.ab; other=x', 'fleetadlc_session')).toBe('1.ab');
    expect(cookieFrom('not_fleetadlc_session=1.ab', 'fleetadlc_session')).toBe('');
    expect(cookieFrom(null, 'fleetadlc_session')).toBe('');
  });
});
