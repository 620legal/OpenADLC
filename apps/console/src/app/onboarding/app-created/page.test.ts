import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/** The exchange, and what the walkthrough reads for where the install's apps are listed. */
const fetchMock = vi.fn(async (url: string) =>
  url.endsWith('/v1/onboarding')
    ? new Response(JSON.stringify({ links: { yourApps: 'https://github.com/organizations/exampleco/settings/apps' } }), { status: 200 })
    : new Response(JSON.stringify({ slug: 'fleetadlc-example' }), { status: 200 }),
);
vi.stubGlobal('fetch', fetchMock);
// Behind IAP, where the console reads IAP's email at all.
vi.stubEnv('FLEETADLC_IDENTITY_MODE_EXPECTED', 'iap');
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-goog-iap-jwt-assertion': 'signed.by.iap', 'x-goog-authenticated-user-email': 'accounts.google.com:ada@example.com' }),
  // identityHeaders reads the session cookie when this file is not behind IAP.
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock('@/lib/api', () => ({ BRIDGE_URL: 'http://bridge.test' }));

const STATE = 'a1'.repeat(32);

async function comeBack(params: { code?: string; state?: string }): Promise<string> {
  const { default: AppCreated } = await import('./page');
  return renderToStaticMarkup(await AppCreated({ searchParams: Promise.resolve(params) })).replace(/<!-- -->/g, '');
}

describe('coming back from GitHub with a new app', () => {
  it('exchanges the code as the person, so a bridge that verifies IAP accepts it', async () => {
    // Behind IAP: a local console never forwards x-goog-* a browser could have sent.
    vi.stubEnv('FLEETADLC_IDENTITY_MODE_EXPECTED', 'iap');
    await expect(comeBack({ code: 'one-time', state: STATE })).rejects.toThrow('redirect:/onboarding?app=created&slug=fleetadlc-example');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://bridge.test/v1/app-manifest/exchange');
    expect(JSON.parse(String(init.body))).toEqual({ code: 'one-time', state: STATE });
    const sent = new Headers(init.headers);
    // The assertion under both names: Google strips x-goog-* on the way into run.app.
    expect(sent.get('x-fleetadlc-iap-assertion')).toBe('signed.by.iap');
    expect(sent.get('x-fleetadlc-identity')).toBe('ada@example.com');
  });

  it('says that the bridge did not answer, rather than failing the page', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const html = await comeBack({ code: 'one-time', state: STATE });
    expect(html).toContain('OpenADLC could not collect the app’s keys: the bridge did not answer: fetch failed.');
  });

  it('says the bridge’s reason on this page, as text, and puts none of it in an address', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'that registration code is expired or already used; <b>start</b> the app again' }), { status: 400 }),
    );
    const html = await comeBack({ code: 'one-time', state: STATE });
    expect(html).toContain('GitHub did not hand over the new app');
    expect(html).toContain('that registration code is expired or already used; &lt;b&gt;start&lt;/b&gt; the app again');
    expect(html).not.toContain('<b>start</b>');
    expect(html).toContain('href="https://github.com/organizations/exampleco/settings/apps"');
    expect(html).toContain('reuse it on the app step');
    expect(html).toContain('href="/onboarding?step=app"');
  });

  it('says the status when the answer is not the bridge’s JSON', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>Bad gateway</html>', { status: 502 }));
    expect(await comeBack({ code: 'one-time', state: STATE })).toContain('could not collect the app’s keys: the bridge answered 502.');
  });

  it('says GitHub sent no code back, with the same advice', async () => {
    const html = await comeBack({});
    expect(html).toContain('GitHub sent no code back');
    expect(html).toContain('otherwise create it again there');
  });

  it('does not ask the bridge at all for a code that came back with no state', async () => {
    // A link anyone can send: a code from an app of their own, and no state.
    fetchMock.mockClear();
    const html = await comeBack({ code: 'attackers-code' });
    expect(html).toContain('GitHub sent back no state');
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/v1/app-manifest/exchange'))).toBe(false);
  });
});
