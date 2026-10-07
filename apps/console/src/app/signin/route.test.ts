import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE, signInToken, validSession } from '@/lib/sign-in';
import { GET } from './route';

const SECRET = 'e'.repeat(64);

afterEach(() => {
  vi.unstubAllEnvs();
});

function signIn(query: string, headers: Record<string, string> = {}, base = 'http://127.0.0.1:47300') {
  return GET(new Request(`${base}/signin${query}`, { headers }));
}

describe('the sign-in link', () => {
  it('sets the session cookie and sends the browser to the board', async () => {
    vi.stubEnv('FLEETADLC_CONSOLE_SECRET', SECRET);
    const response = await signIn(`?token=${await signInToken(SECRET)}`);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/');

    const cookie = response.headers.get('set-cookie') ?? '';
    const value = /^fleetadlc_session=([^;]+)/.exec(cookie)?.[1] ?? '';
    expect(await validSession(SECRET, value)).toBe(true);
    expect(cookie).toContain('HttpOnly');
    // Lax, so GitHub's return from creating the app still carries it.
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Secure');
  });

  it('marks the cookie Secure when the request came over https', async () => {
    vi.stubEnv('FLEETADLC_CONSOLE_SECRET', SECRET);
    const token = await signInToken(SECRET);
    expect((await signIn(`?token=${token}`, {}, 'https://fleetadlc.example')).headers.get('set-cookie')).toContain('Secure');
    expect((await signIn(`?token=${token}`, { 'x-forwarded-proto': 'https' })).headers.get('set-cookie')).toContain('Secure');
  });

  it('answers a page saying how to get a link, and no cookie, without a valid token', async () => {
    vi.stubEnv('FLEETADLC_CONSOLE_SECRET', SECRET);
    const expired = await signInToken(SECRET, Math.floor(Date.now() / 1000) - 7200);
    const elsewhere = await signInToken('f'.repeat(64));
    for (const query of ['', '?token=', '?token=nonsense', `?token=${expired}`, `?token=${elsewhere}`]) {
      const response = await signIn(query);
      expect(response.status, query).toBe(200);
      expect(response.headers.get('set-cookie'), query).toBeNull();
      expect(await response.text()).toContain('fleetadlc console-link');
    }
  });

  it('signs nobody in when the console has no secret', async () => {
    vi.stubEnv('FLEETADLC_CONSOLE_SECRET', '');
    const response = await signIn(`?token=${await signInToken('f'.repeat(64))}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('is the cookie the middleware reads', () => {
    expect(SESSION_COOKIE).toBe('fleetadlc_session');
  });
});
