/**
 * Signing in to a local install's console, without a store.
 *
 * A local install takes the person's name from a header, and the console's
 * server holds the secret that makes the bridge believe it. Without a sign-in
 * of its own the console was that secret's proxy for anybody who reached port
 * 47300: a host on the LAN, or code in a task's container, was an admin
 * through it. So a browser signs in once, with a link `fleetadlc up` and
 * `fleetadlc console-link` print, and the console serves nothing else to a
 * browser that has not.
 *
 * Both the link's token and the session cookie are `<exp>.<hex HMAC-SHA256>`
 * under the console secret, `exp` in seconds since the epoch. They are signed
 * under different labels, so a link token is never a valid cookie, and a link
 * expires within the hour while a session lasts thirty days. The CLI mints the
 * same token with node:crypto (`apps/cli/src/console-link.ts`); both tests
 * check one fixed vector, so the two cannot drift.
 *
 * Web Crypto only, never node:crypto: the middleware that checks the cookie
 * runs in Next's edge runtime.
 */

export const SESSION_COOKIE = 'fleetadlc_session';
export const SIGN_IN_LABEL = 'fleetadlc-console-sign-in:';
export const SESSION_LABEL = 'fleetadlc-console-session:';
export const SIGN_IN_LIFETIME_SECONDS = 60 * 60;
export const SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

const encoder = new TextEncoder();

async function keyFor(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** `<exp>.<hex HMAC-SHA256(secret, label + exp)>`. */
export async function mint(secret: string, label: string, exp: number): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', await keyFor(secret), encoder.encode(`${label}${exp}`));
  return `${exp}.${hex(signature)}`;
}

/** Whether `value` was minted under `secret` and `label`, and has not expired by `nowSeconds`. */
export async function verify(secret: string, label: string, value: string, nowSeconds: number): Promise<boolean> {
  if (!secret) return false;
  const match = /^(\d{1,12})\.([0-9a-f]{64})$/.exec(value.trim());
  if (!match) return false;
  const exp = Number(match[1]);
  if (exp <= nowSeconds) return false;
  const signature = new Uint8Array((match[2] ?? '').match(/../g)!.map((pair) => parseInt(pair, 16)));
  // subtle.verify compares in constant time, so a near miss takes no longer to refuse.
  return crypto.subtle.verify('HMAC', await keyFor(secret), signature, encoder.encode(`${label}${match[1]}`));
}

const nowInSeconds = () => Math.floor(Date.now() / 1000);

export function signInToken(secret: string, now = nowInSeconds()): Promise<string> {
  return mint(secret, SIGN_IN_LABEL, now + SIGN_IN_LIFETIME_SECONDS);
}

export function validSignInToken(secret: string, token: string, now = nowInSeconds()): Promise<boolean> {
  return verify(secret, SIGN_IN_LABEL, token, now);
}

export function sessionValue(secret: string, now = nowInSeconds()): Promise<string> {
  return mint(secret, SESSION_LABEL, now + SESSION_LIFETIME_SECONDS);
}

export function validSession(secret: string, value: string, now = nowInSeconds()): Promise<boolean> {
  return verify(secret, SESSION_LABEL, value, now);
}

/** One cookie's value from a `Cookie` header, or '' when it is not there. */
export function cookieFrom(header: string | null, name: string): string {
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return '';
}

/** What the console tells a browser that has not signed in, as words for a page or a JSON error. */
export const SIGN_IN_ADVICE =
  'Sign in to this console first: on the machine OpenADLC runs on, run `fleetadlc console-link` and open the link it prints.';

/** What the console says on every path when it was started without its secret. */
export const NO_SECRET_ADVICE =
  'This console was started without its secret (FLEETADLC_CONSOLE_SECRET). Start it with `fleetadlc up`.';

/**
 * Why a request may not speak for the operator, or undefined when it may: the
 * one rule the middleware and a server action both apply. Behind IAP there is
 * nothing to check, because IAP signs people in, and the cookie is not read.
 * A console started without its secret cannot sign anybody in, and its calls
 * to the bridge would all be refused, so it says that whatever the cookie.
 */
export async function sessionRefusal(
  readCookie: () => string | undefined | Promise<string | undefined>,
): Promise<{ status: 401 | 503; message: string } | undefined> {
  if (process.env.FLEETADLC_IDENTITY_MODE_EXPECTED === 'iap') return undefined;
  const secret = process.env.FLEETADLC_CONSOLE_SECRET ?? '';
  if (!secret) return { status: 503, message: NO_SECRET_ADVICE };
  if (await validSession(secret, (await readCookie()) ?? '')) return undefined;
  return { status: 401, message: SIGN_IN_ADVICE };
}
