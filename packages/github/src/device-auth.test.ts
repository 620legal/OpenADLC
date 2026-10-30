import { describe, expect, it, vi, afterEach } from 'vitest';
import { DeviceAuthError, pollForUserToken, refreshUserToken, requestDeviceCode, revokeUserToken } from './device-auth.js';

function mockFetch(responses: unknown[]): void {
  const queue = [...responses];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const body = queue.shift() ?? {};
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a form posted to github.com', () => {
  it('carries a time limit, so a stalled refresh does not hold the broker’s lock for minutes', async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        seen.push(init?.signal);
        return new Response(JSON.stringify({ access_token: 'ghu_x', expires_in: 28800, refresh_token: 'ghr_y' }), { status: 200 });
      }),
    );

    await refreshUserToken({ clientId: 'Iv1.client', refreshToken: 'ghr_old' });

    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });
});

describe('device flow', () => {
  it('returns the code a person types at github.com/login/device', async () => {
    mockFetch([
      {
        device_code: 'dc-123',
        user_code: 'WDJB-MJHT',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      },
    ]);

    const code = await requestDeviceCode({ clientId: 'Iv1.client' });

    expect(code.userCode).toBe('WDJB-MJHT');
    expect(code.verificationUri).toBe('https://github.com/login/device');
    expect(code.interval).toBe(5);
  });

  it('surfaces a disabled device flow as an actionable error', async () => {
    mockFetch([{ error: 'device_flow_disabled' }]);

    await expect(requestDeviceCode({ clientId: 'Iv1.client' })).rejects.toThrow(/device flow is not enabled/);
  });

  it('waits through authorization_pending and returns the user token', async () => {
    mockFetch([
      { error: 'authorization_pending' },
      {
        access_token: 'ghu_token',
        expires_in: 28800,
        refresh_token: 'ghr_refresh',
        refresh_token_expires_in: 15897600,
        token_type: 'bearer',
      },
    ]);

    const token = await pollForUserToken({
      clientId: 'Iv1.client',
      deviceCode: 'dc-123',
      intervalSeconds: 1,
      expiresInSeconds: 60,
      sleep: async () => {},
      now: () => new Date('2026-01-01T00:00:00Z'),
    });

    expect(token.accessToken).toBe('ghu_token');
    expect(token.refreshToken).toBe('ghr_refresh');
    expect(token.expiresAt?.toISOString()).toBe('2026-01-01T08:00:00.000Z');
  });

  it('backs off when GitHub says slow_down', async () => {
    mockFetch([{ error: 'slow_down', interval: '10' }, { access_token: 'ghu_token' }]);
    const sleeps: number[] = [];

    await pollForUserToken({
      clientId: 'Iv1.client',
      deviceCode: 'dc-123',
      intervalSeconds: 5,
      expiresInSeconds: 600,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(sleeps).toEqual([5000, 10000]);
  });

  it('stops when the person cancels in the browser', async () => {
    mockFetch([{ error: 'access_denied' }]);

    await expect(
      pollForUserToken({
        clientId: 'Iv1.client',
        deviceCode: 'dc-123',
        intervalSeconds: 1,
        expiresInSeconds: 10,
        sleep: async () => {},
      }),
    ).rejects.toBeInstanceOf(DeviceAuthError);
  });

  it('refreshes without a client secret and returns the rotated refresh token', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: 'ghu_new',
            expires_in: 28800,
            refresh_token: 'ghr_rotated',
            refresh_token_expires_in: 15897600,
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const token = await refreshUserToken({ clientId: 'Iv1.client', refreshToken: 'ghr_old' });

    expect(token.accessToken).toBe('ghu_new');
    expect(token.refreshToken).toBe('ghr_rotated');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sentBody = String(init.body ?? '');
    expect(sentBody).toContain('grant_type=refresh_token');
    expect(sentBody).not.toContain('client_secret');
  });
});

describe('revoking a token held for one post', () => {
  it('asks GitHub to delete it with the app’s client id and secret, and says whether it is gone', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    expect(await revokeUserToken({ clientId: 'Iv1.client', clientSecret: 'shh', accessToken: 'ghu_once', fetchImpl })).toBe(true);
    expect(calls[0]!.url).toBe('https://api.github.com/applications/Iv1.client/token');
    expect(calls[0]!.init.method).toBe('DELETE');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('Iv1.client:shh').toString('base64')}`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ access_token: 'ghu_once' });
  });

  it('never throws, and never with the token: a refusal or a network failure is false', async () => {
    const refused = vi.fn(async () => new Response('{"message":"Not Found"}', { status: 404 })) as unknown as typeof fetch;
    expect(await revokeUserToken({ clientId: 'Iv1.client', clientSecret: 'shh', accessToken: 'ghu_once', fetchImpl: refused })).toBe(false);
    const broken = vi.fn(async () => {
      throw new Error('socket hang up ghu_once');
    }) as unknown as typeof fetch;
    expect(await revokeUserToken({ clientId: 'Iv1.client', clientSecret: 'shh', accessToken: 'ghu_once', fetchImpl: broken })).toBe(false);
  });
});
