import { afterEach, describe, expect, it, vi } from 'vitest';
import { modifyRouteRegex } from 'next/dist/lib/redirect-status';
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';
import config from '../../next.config';
import { CONSOLE_HEADERS, attachmentPolicy } from './security-headers';

vi.mock('@/lib/api', () => ({ BRIDGE_URL: 'http://bridge.test' }));
vi.mock('@/lib/identity', () => ({ identityHeadersFrom: () => ({}) }));

/**
 * Any page the operator had open could frame the console and line a click up
 * with a gate's answer or Stop. Every response now says it may not be framed,
 * and a file served by the console keeps its sandbox.
 */

/** The headers a path is given, matched as Next matches a `headers()` source, a later rule winning. */
function headersFor(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of CONSOLE_HEADERS) {
    const match = getPathMatch(rule.source, { strict: true, removeUnnamedParams: true, regexModifier: (regex: string) => modifyRouteRegex(regex) });
    if (match(path) === false) continue;
    for (const { key, value } of rule.headers) out[key] = value;
  }
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the console’s frame headers', () => {
  it('are the exact names and values a browser reads', () => {
    expect(CONSOLE_HEADERS).toEqual([
      { source: '/:path*', headers: [{ key: 'X-Frame-Options', value: 'DENY' }] },
      { source: '/:path((?!api/attachments/[^/]+$|api/brand/logo$).*)', headers: [{ key: 'Content-Security-Policy', value: "frame-ancestors 'none'" }] },
    ]);
  });

  it('are what next.config.ts serves', async () => {
    expect(await config.headers?.()).toEqual(CONSOLE_HEADERS);
  });

  it.each(['/', '/needs-you', '/items/api%2312', '/api/restore', '/api/attachments', '/api/brand', '/api/brand/logo/x', '/_next/static/chunks/main.js'])('cover %s', (path) => {
    expect(headersFor(path)).toEqual({ 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" });
  });

  it('leave a file’s policy to its route, where it would otherwise replace the sandbox', () => {
    expect(headersFor('/api/attachments/att-1')).toEqual({ 'X-Frame-Options': 'DENY' });
    expect(headersFor('/api/brand/logo')).toEqual({ 'X-Frame-Options': 'DENY' });
  });
});

describe('a file served by the console', () => {
  it('keeps the bridge’s sandbox and adds frame-ancestors to it', () => {
    expect(attachmentPolicy("sandbox; default-src 'none'")).toBe("sandbox; default-src 'none'; frame-ancestors 'none'");
    expect(attachmentPolicy(null)).toBe("sandbox; frame-ancestors 'none'");
    expect(attachmentPolicy("default-src 'none'; frame-ancestors *")).toBe("sandbox; default-src 'none'; frame-ancestors 'none'");
  });

  it('is served with both directives in one header', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('png', { headers: { 'content-type': 'image/png', 'content-security-policy': "sandbox; default-src 'none'" } })),
    );
    const { GET } = await import('@/app/api/attachments/[id]/route');
    const response = await GET(new Request('http://console.test/api/attachments/att-1'), { params: Promise.resolve({ id: 'att-1' }) });
    expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'; frame-ancestors 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('the console’s logo, served by the console', () => {
  it('keeps the bridge’s type, nosniff and sandbox, and is not to be framed', async () => {
    const fetched = vi.fn(async (_url: string) =>
      new Response('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', {
        headers: {
          'content-type': 'image/svg+xml',
          'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
          'cache-control': 'private, max-age=300',
        },
      }),
    );
    vi.stubGlobal('fetch', fetched);
    const { GET } = await import('@/app/api/brand/logo/route');
    const response = await GET(new Request('http://console.test/api/brand/logo?v=0123456789ab'));
    expect(String(fetched.mock.calls[0]?.[0])).toBe('http://bridge.test/v1/brand/logo');
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('private, max-age=300');
    const policy = response.headers.get('content-security-policy') ?? '';
    expect(policy).toBe("sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'");
    expect(policy).not.toContain('script-src');
  });

  it('is sandboxed even when the bridge sent no policy, and passes on a 404 when there is no logo', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } })));
    const { GET } = await import('@/app/api/brand/logo/route');
    expect((await GET(new Request('http://console.test/api/brand/logo'))).headers.get('content-security-policy')).toBe("sandbox; frame-ancestors 'none'");

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'no logo is set' }), { status: 404 })));
    const missing = await GET(new Request('http://console.test/api/brand/logo'));
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-security-policy')).toContain('sandbox');
  });
});
