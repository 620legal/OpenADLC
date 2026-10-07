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
      { source: '/:path((?!api/attachments/[^/]+$).*)', headers: [{ key: 'Content-Security-Policy', value: "frame-ancestors 'none'" }] },
    ]);
  });

  it('are what next.config.ts serves', async () => {
    expect(await config.headers?.()).toEqual(CONSOLE_HEADERS);
  });

  it.each(['/', '/needs-you', '/items/api%2312', '/api/restore', '/api/attachments', '/_next/static/chunks/main.js'])('cover %s', (path) => {
    expect(headersFor(path)).toEqual({ 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" });
  });

  it('leave a file’s policy to its route, where it would otherwise replace the sandbox', () => {
    expect(headersFor('/api/attachments/att-1')).toEqual({ 'X-Frame-Options': 'DENY' });
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
