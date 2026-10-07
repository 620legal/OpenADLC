import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionValue, signInToken } from './lib/sign-in';
import { middleware, middlewareCovers } from './middleware';

/**
 * A local console serves nothing but `/signin` to a browser that has not
 * signed in. Its server holds the secret the bridge serves `/v1` for, so
 * before this a host on the LAN, or a task's container, was an admin through
 * it: `POST /api/backup` from 192.168.1.50 passed.
 */
const SECRET = 'e'.repeat(64);

beforeEach(() => {
  vi.stubEnv('FLEETADLC_CONSOLE_SECRET', SECRET);
  vi.stubEnv('FLEETADLC_IDENTITY_MODE_EXPECTED', '');
  vi.stubEnv('FLEETADLC_ALLOWED_HOSTS', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function at(path: string, init: { method?: string; host?: string; cookie?: string } = {}) {
  const host = init.host ?? '127.0.0.1:47300';
  const headers: Record<string, string> = { host };
  if (init.cookie !== undefined) headers.cookie = init.cookie;
  return middleware(
    new Request(`http://${host}${path}`, { method: init.method ?? 'GET', headers, body: init.method === 'POST' ? '{}' : undefined }),
  );
}

describe('a browser that has not signed in', () => {
  it('gets 401 on every page and every /api route, from any address', async () => {
    for (const host of ['127.0.0.1:47300', '192.168.1.50:47300', 'host.docker.internal:47300', '172.17.0.1:47300']) {
      for (const [method, path] of [['GET', '/'], ['POST', '/board'], ['POST', '/api/backup'], ['GET', '/api/engines']] as const) {
        const refused = await at(path, { method, host });
        expect(refused?.status, `${method} ${host}${path}`).toBe(401);
      }
    }
  });

  it('is told how to sign in: JSON for /api, text for a page', async () => {
    const api = await at('/api/backup', { method: 'POST' });
    expect(api?.headers.get('content-type')).toContain('application/json');
    expect(((await api?.json()) as { error: string }).error).toContain('fleetadlc console-link');

    const page = await at('/');
    expect(page?.headers.get('content-type')).toContain('text/plain');
    expect(await page?.text()).toContain('fleetadlc console-link');
  });

  it('is refused with a sign-in link in place of a session, or a session from another install', async () => {
    expect((await at('/', { cookie: `fleetadlc_session=${await signInToken(SECRET)}` }))?.status).toBe(401);
    expect((await at('/', { cookie: `fleetadlc_session=${await sessionValue('f'.repeat(64))}` }))?.status).toBe(401);
    expect((await at('/', { cookie: 'fleetadlc_session=' }))?.status).toBe(401);
  });

  it('can still reach /signin', async () => {
    expect(await at('/signin')).toBeUndefined();
    expect(await at('/signin?token=nonsense')).toBeUndefined();
  });

  it('still gets 421 first, under a name the console is not served under', async () => {
    expect((await at('/', { host: 'attacker.example:47300' }))?.status).toBe(421);
  });

  it('logs a refused name once, quoted, with the setting that admits it, and keeps the 421 empty', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const refused = await at('/', { host: 'mybox.lan:47300' });
      await at('/board', { host: 'mybox.lan:47300' });
      expect(refused?.status).toBe(421);
      expect(await refused?.text()).toBe('');
      const said = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('mybox.lan'));
      expect(said).toEqual([expect.stringContaining('[console] refusing requests for Host "mybox.lan:47300"')]);
      expect(said[0]).toContain('"allowedHosts" in install.json (FLEETADLC_ALLOWED_HOSTS)');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('paths the matcher must still sign in', () => {
  it('covers a path that only starts like a static file', () => {
    for (const path of ['/', '/board', '/api/backup', '/favicon.ico/x', '/faviconXico', '/_next/staticX', '/_next/image/foo', '/_next/static']) {
      expect(middlewareCovers(path), path).toBe(true);
    }
    for (const path of ['/favicon.ico', '/_next/image', '/_next/static/chunks/app.js']) {
      expect(middlewareCovers(path), path).toBe(false);
    }
  });

  it('still requires a session on the paths that used to skip the middleware', async () => {
    for (const path of ['/faviconXico', '/_next/staticX', '/favicon.ico/x', '/_next/static']) {
      expect(middlewareCovers(path), path).toBe(true);
      expect((await at(path, { method: 'POST' }))?.status, path).toBe(401);
    }
  });
});

describe('a browser that has signed in', () => {
  it('is served every page and /api route', async () => {
    const cookie = `theme=dark; fleetadlc_session=${await sessionValue(SECRET)}`;
    expect(await at('/', { cookie })).toBeUndefined();
    expect(await at('/api/backup', { method: 'POST', cookie })).toBeUndefined();
  });
});

describe('a console with nothing to check against', () => {
  it('answers 503 on every path when it was started without its secret', async () => {
    vi.stubEnv('FLEETADLC_CONSOLE_SECRET', '');
    for (const path of ['/', '/signin', '/api/backup']) {
      const refused = await at(path);
      expect(refused?.status, path).toBe(503);
      const said = path.startsWith('/api/') ? ((await refused?.json()) as { error: string }).error : await refused?.text();
      expect(said).toContain('without its secret');
    }
  });

  it('leaves signing in to IAP behind it', async () => {
    vi.stubEnv('FLEETADLC_IDENTITY_MODE_EXPECTED', 'iap');
    vi.stubEnv('FLEETADLC_CONSOLE_SECRET', '');
    expect(await at('/')).toBeUndefined();
    expect(await at('/api/engines')).toBeUndefined();
  });
});
