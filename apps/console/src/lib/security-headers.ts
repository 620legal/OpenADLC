/**
 * What tells a browser the console may not be framed, by any site, itself
 * included.
 *
 * Without it, any page the operator had open could load the console — a
 * local install's `/needs-you` needs no sign-in — in an invisible frame, and
 * line up a decoy so a click landed on Stop, Hold or a gate's answer. A server
 * action fired inside that frame is same-origin, so neither Next's origin
 * check nor the middleware's refused it. The console has no frame of its own,
 * so `'none'` breaks nothing.
 *
 * No `script-src` here: layout.tsx's inline theme and early-click scripts
 * would need a nonce, which is separate work.
 */

export const FRAME_ANCESTORS = "frame-ancestors 'none'";

export const X_FRAME_OPTIONS = { key: 'X-Frame-Options', value: 'DENY' } as const;
export const FRAME_POLICY = { key: 'Content-Security-Policy', value: FRAME_ANCESTORS } as const;

/**
 * Every path but one file's, `/api/attachments/:id`, which sets a policy of
 * its own (`attachmentPolicy`). Next keeps a header the config set and drops
 * the route's, so a policy set here on that path would have taken away the
 * bridge's `sandbox`, and a file could run as a console page.
 */
const ALL_BUT_A_FILE = '/:path((?!api/attachments/[^/]+$).*)';

/** The routes next.config.ts gives `headers()`. */
export const CONSOLE_HEADERS = [
  { source: '/:path*', headers: [X_FRAME_OPTIONS] },
  { source: ALL_BUT_A_FILE, headers: [FRAME_POLICY] },
];

/**
 * A file's policy: the bridge's (`sandbox; default-src 'none'`), sandboxed
 * even when the bridge sent none, and not to be framed either.
 */
export function attachmentPolicy(fromBridge: string | null): string {
  const directives = (fromBridge ?? '')
    .split(';')
    .map((one) => one.trim())
    .filter((one) => one && !/^frame-ancestors\b/i.test(one));
  if (!directives.some((one) => /^sandbox\b/i.test(one))) directives.unshift('sandbox');
  return [...directives, FRAME_ANCESTORS].join('; ');
}
