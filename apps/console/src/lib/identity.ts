import { cookies, headers } from 'next/headers';
import { SESSION_COOKIE, sessionRefusal } from './sign-in';

/*
 * What the console puts on a call to the bridge so the bridge knows who is
 * asking.
 *
 * Every console call is a server-side proxy, so the person's credential has to
 * be carried across deliberately. It used to send a constant — `'console'` — and
 * drop the IAP assertion entirely, which meant the bridge's verified identity
 * path could never succeed and every gate answer, kill, restart and attach was
 * audited as the string `console`. The assertion is the only part that proves
 * anything, so it is the part that must survive the hop.
 *
 * The two `x-goog-*` headers are set by Identity-Aware Proxy on the request
 * reaching the console; behind IAP nothing the browser sends can reach here as
 * one, because IAP strips and re-signs them. Without IAP in front, they are
 * whatever the browser sent, so a local console never forwards them.
 * `x-fleetadlc-identity` is the local path and the bridge ignores it when the
 * install verifies; locally the bridge believes it only beside the console
 * secret, which this server holds and a browser never sees.
 */

const ASSERTION = 'x-goog-iap-jwt-assertion';
// What the bridge reads it as: Google strips `x-goog-*` on the way into a
// run.app service, so the original name does not survive the hop.
const FORWARDED_ASSERTION = 'x-fleetadlc-iap-assertion';
const EMAIL = 'x-goog-authenticated-user-email';
const LOCAL = 'x-fleetadlc-identity';
const CONSOLE_SECRET = 'x-fleetadlc-console-secret';

/** Whether the missing assertion has been reported in this process yet. */
let reportedMissing = false;

/**
 * Names only, never values, and once per process. The first cloud console had
 * IAP in front of it and still reached the bridge with no assertion, and
 * nothing said which headers had arrived in its place.
 */
function reportMissing(incoming: Headers): void {
  if (reportedMissing || process.env.FLEETADLC_IDENTITY_MODE_EXPECTED !== 'iap') return;
  reportedMissing = true;
  const names = [...incoming.keys()].filter((name) => name.startsWith('x-')).sort();
  console.warn(`[console] no ${ASSERTION} on a request; x- headers present: ${names.join(', ') || '(none)'}`);
}

function build(incoming: Headers): Record<string, string> {
  const forwarded: Record<string, string> = {};
  const secret = process.env.FLEETADLC_CONSOLE_SECRET;
  if (secret) forwarded[CONSOLE_SECRET] = secret;

  if (process.env.FLEETADLC_IDENTITY_MODE_EXPECTED !== 'iap') {
    forwarded[LOCAL] = process.env.FLEETADLC_IDENTITY ?? 'console';
    return forwarded;
  }

  const get = (name: string) => incoming.get(name);

  const assertion = get(ASSERTION);
  if (assertion) {
    forwarded[ASSERTION] = assertion;
    forwarded[FORWARDED_ASSERTION] = assertion;
  }
  else reportMissing(incoming);

  const email = process.env.FLEETADLC_IDENTITY_MODE_EXPECTED === 'iap' ? get(EMAIL) : null;
  if (email) forwarded[EMAIL] = email;

  // Only a fallback: an install that verifies does not accept this, which is the
  // point. Naming the console rather than a person is honest about what it is.
  // `||`, not `??`: a blank email from a proxy named nobody, and the bridge
  // then took the caller for its own "local operator".
  forwarded[LOCAL] = email?.replace(/^accounts\.google\.com:/, '') || process.env.FLEETADLC_IDENTITY || 'console';

  return forwarded;
}

/**
 * A local console speaks for the operator only after a session cookie checks.
 *
 * A server action can be posted to a path the middleware matcher does not
 * run on. Next still runs it, and it accepts the post with no `Origin`.
 * The action used to call the bridge with the console secret anyway, so
 * anybody who reached the port was an admin. The cookie is checked again
 * here, where the action runs, before that secret is attached.
 */
export async function requireLocalSession(): Promise<void> {
  const refusal = await sessionRefusal(async () => (await cookies()).get(SESSION_COOKIE)?.value);
  if (refusal) throw new Error(refusal.message);
}

/** For a route handler, which is handed the request. The middleware has already required the session. */
export function identityHeadersFrom(request: Request): Record<string, string> {
  return build(request.headers);
}

/** For a server component or a server action, which reads the incoming request. */
export async function identityHeaders(): Promise<Record<string, string>> {
  await requireLocalSession();
  return build(new Headers(await headers()));
}
