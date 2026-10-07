import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ BRIDGE_URL: 'http://bridge.test', readMe: async () => null }));
vi.mock('@/lib/identity', () => ({ identityHeaders: async () => ({}) }));

afterEach(() => {
  vi.unstubAllGlobals();
});

async function page(): Promise<string> {
  const { default: OnboardingPage } = await import('./page');
  return renderToStaticMarkup(await OnboardingPage({ searchParams: Promise.resolve({}) })).replace(/<!-- -->/g, '');
}

/**
 * The walkthrough's first read, when it fails: a bridge that answered with an
 * error is not one that cannot be reached.
 */
describe('the walkthrough when its first read fails', () => {
  it('says what the bridge answered, and where to look, rather than to start a running stack', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'no identity assertion reached the bridge' }), { status: 401 })),
    );
    const html = await page();
    expect(html).toContain('The bridge answered with an error');
    expect(html).toContain('the bridge answered 401 to /v1/onboarding: no identity assertion reached the bridge');
    expect(html).not.toContain('cannot reach the bridge');
  });

  it('says it cannot reach the bridge when nothing answered', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const html = await page();
    expect(html).toContain('The console cannot reach the bridge');
    expect(html).toContain('fleetadlc up');
  });
});
