import { describe, expect, it, vi } from 'vitest';
import { clientSecretAccepted, createScopedToken, ScopedTokenError } from './scoped-token.js';

/** GitHub's answer to one call, and what it was asked. */
function github(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('a token scoped to one repository', () => {
  it('is asked of GitHub with the app’s client id and secret, for the owner and that repository alone', async () => {
    const { fetchImpl, calls } = github(200, { token: 'ghu_scoped', expires_at: '2026-10-04T20:00:00Z' });

    const scoped = await createScopedToken({
      clientId: 'Iv1.client',
      clientSecret: 'shh',
      accessToken: 'ghu_parent',
      repository: 'exampleco/widgets',
      fetchImpl,
    });

    expect(scoped).toEqual({ token: 'ghu_scoped', expiresAt: new Date('2026-10-04T20:00:00Z') });
    expect(calls[0]?.url).toBe('https://api.github.com/applications/Iv1.client/token/scoped');
    expect(calls[0]?.init.method).toBe('POST');
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('Iv1.client:shh').toString('base64')}`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ access_token: 'ghu_parent', target: 'exampleco', repositories: ['widgets'] });
  });

  it('has no expiry of its own when GitHub gives none', async () => {
    const { fetchImpl } = github(200, { token: 'ghu_scoped' });
    const scoped = await createScopedToken({ clientId: 'c', clientSecret: 's', accessToken: 't', repository: 'exampleco/widgets', fetchImpl });
    expect(scoped.expiresAt).toBeNull();
  });

  it('says when GitHub refused the client secret, apart from any other refusal, and never carries a token', async () => {
    const refused = await createScopedToken({
      clientId: 'c',
      clientSecret: 'wrong',
      accessToken: 'ghu_parent',
      repository: 'exampleco/widgets',
      fetchImpl: github(401, { message: 'Bad credentials' }).fetchImpl,
    }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ScopedTokenError);
    expect(refused).toMatchObject({ secretRefused: true, message: 'GitHub refused the app’s client secret' });

    const other = await createScopedToken({
      clientId: 'c',
      clientSecret: 's',
      accessToken: 'ghu_parent',
      repository: 'exampleco/widgets',
      fetchImpl: github(422, { message: 'Validation failed' }).fetchImpl,
    }).catch((error: unknown) => error);
    expect(other).toMatchObject({ secretRefused: false, message: 'GitHub would not scope the token to exampleco/widgets (422)' });
    expect(String((other as Error).message)).not.toContain('ghu_parent');
  });
});

describe('checking the app’s client secret', () => {
  it('is yes when GitHub checks a bot’s token with it, and no when GitHub refuses it', async () => {
    const accepted = github(200, { token: 'ghu_parent' });
    expect(await clientSecretAccepted({ clientId: 'c', clientSecret: 's', accessToken: 'ghu_parent', fetchImpl: accepted.fetchImpl })).toBe(true);
    expect(accepted.calls[0]?.url).toBe('https://api.github.com/applications/c/token');

    expect(await clientSecretAccepted({ clientId: 'c', clientSecret: 's', accessToken: 't', fetchImpl: github(404, {}).fetchImpl })).toBe(false);
    await expect(clientSecretAccepted({ clientId: 'c', clientSecret: 's', accessToken: 't', fetchImpl: github(502, {}).fetchImpl })).rejects.toThrow(/502/);
  });
});
