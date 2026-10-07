import { SESSION_COOKIE, cookieFrom, sessionRefusal } from './lib/sign-in';

/**
 * A page elsewhere may not change anything through the console's own API.
 *
 * Every `/api/*` route handler forwards its body to the bridge from the
 * console's server. That hop carries no `Origin`, so the bridge's own check
 * sees a server and serves it, and Next checks the origin of a server action
 * but not of a route handler. Without this, any page the operator had open
 * could `POST` here with `mode: 'no-cors'` — store a model account's key, accept an
 * invitation, change the install — as them. It could not read the answer, and
 * did not need to.
 *
 * The rule is the bridge's (`apps/bridge/src/router.ts`). What counts as the
 * console is not: here it is the host the request was sent to, which is the
 * comparison Next makes for a server action. A console opened under a LAN
 * address, or under a name `FLEETADLC_ALLOWED_HOSTS` lists, works here exactly when
 * its server actions do. Like Next's check, this does not stop a name
 * rebound to this machine; to the browser, that page and this host are one
 * origin.
 *
 * What stops that is the name itself, checked first and on every path: a page
 * on a rebound name sends its own name as `Host`, and could otherwise read the
 * board, a bot's screen, and use every page's server actions. The rule is the
 * bridge's (`hostAllowed` in `apps/bridge/src/router.ts`).
 *
 * Then, on a local install, the browser must have signed in (`lib/sign-in.ts`):
 * the console's server holds the secret the bridge serves `/v1` for, so
 * without this anybody who reached the port was an admin through it.
 */
export async function middleware(request: Request): Promise<Response | undefined> {
  const refused = refusedName(request.headers);
  if (refused !== null) {
    sayRefusedHost(refused);
    // No body: the page asking is the one that must learn nothing. The log is
    // where the person running the install learns what to set.
    return new Response(null, { status: 421 });
  }
  const path = new URL(request.url).pathname;
  const signIn = await signInRefusal(request, path);
  if (signIn) return signIn;
  if (!path.startsWith('/api/')) return undefined;
  if (!rejectsBrowser(request.method, request.headers)) return undefined;
  return Response.json({ error: 'this origin may not call the console' }, { status: 403 });
}

/**
 * A browser that has not signed in gets nothing but `/signin`: no page, no
 * server action (they post to page paths), no `/api` route. The rule is
 * `sessionRefusal`'s; a console without its secret says so on `/signin` too.
 */
async function signInRefusal(request: Request, path: string): Promise<Response | undefined> {
  const refusal = await sessionRefusal(() => cookieFrom(request.headers.get('cookie'), SESSION_COOKIE));
  if (!refusal || (refusal.status === 401 && path === '/signin')) return undefined;
  const { status, message } = refusal;
  return path.startsWith('/api/') ? Response.json({ error: message }, { status }) : text(message, status);
}

function text(body: string, status: number): Response {
  return new Response(`${body}\n`, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/** As the bridge's: after this many names, refused names are no longer said. */
const REFUSED_HOSTS_SAID = 100;
/** Names a request was refused under, each said once. */
const refusedHosts = new Set<string>();

/**
 * Says a refused name once, with the setting that admits it. An empty 421 on
 * every path was a blank page for someone who opened the console under a LAN
 * name, and the console's log said nothing either. The name comes from the
 * client, so it is quoted, and anything on the network can send a new one with
 * every request, so what is remembered stops somewhere.
 */
function sayRefusedHost(host: string): void {
  const name = host.trim().toLowerCase();
  if (refusedHosts.has(name) || refusedHosts.size > REFUSED_HOSTS_SAID) return;
  refusedHosts.add(name);
  if (refusedHosts.size > REFUSED_HOSTS_SAID) {
    console.warn(`[console] refused ${REFUSED_HOSTS_SAID} names already; further refused names are not logged`);
    return;
  }
  console.warn(
    `[console] refusing requests for Host ${JSON.stringify(name)}: not a name this install is served under. ` +
      'If people do open the console under it, add it to "allowedHosts" in install.json (FLEETADLC_ALLOWED_HOSTS) and restart.',
  );
}

/**
 * Every path but Next's own static files, which are the same for everybody.
 * Server actions post to page paths and keep Next's own origin check.
 *
 * The exclusions are exact. Next compiles the group as a regular expression,
 * so an unescaped `.` is any character and a lookahead that is not anchored
 * matches a path that only *starts* like a static file. `/faviconXico`,
 * `/favicon.ico/anything` and `/_next/staticX` then skipped the middleware,
 * resolved to the not-found page, and still ran every server action — with
 * the console secret, and with no session cookie.
 *
 * Next reads `config` as source. A name here is "Unknown identifier", the
 * build drops the matcher, and those paths skip the middleware again.
 */
export const config = { matcher: '/((?!_next/static/|_next/image$|favicon\\.ico$).*)' };

// Read from `config`, so a test of it tests the matcher Next is given. Next
// compiles it as `^<matcher>$` with an optional `/_next/data/<id>` before it and
// `.rsc`-style suffixes after; neither changes what the exclusions skip.
const covered = new RegExp(`^${config.matcher}$`);

/** Whether the matcher runs the middleware for this pathname. */
export function middlewareCovers(pathname: string): boolean {
  return covered.test(pathname);
}

/**
 * The name a request was sent under that the console is not served under, or
 * null when it is served under them all. `X-Forwarded-Host` is checked as well
 * as `Host`: a page on the same origin sets it without a preflight, and the
 * origin check above reads it.
 */
function refusedName(headers: Headers): string | null {
  const rule = configuredHosts();
  const host = headers.get('host') ?? undefined;
  if (!hostAllowed(host, rule)) return host ?? '';
  const forwarded = headers.get('x-forwarded-host')?.split(',')[0];
  if (forwarded !== undefined && !hostAllowed(forwarded, rule)) return forwarded;
  return null;
}

/** As the bridge's `HostRule`: every name, or these names and names ending in these suffixes. */
export interface HostRule {
  any: boolean;
  names: ReadonlySet<string>;
  suffixes: readonly string[];
}

/** Names that cannot be rebound: a browser resolves `localhost` itself. */
const FIXED_HOSTS = ['localhost', 'host.docker.internal', 'host.containers.internal'];

/**
 * The hosts the console is served under, from the same settings the bridge
 * reads, and the host of `NEXT_PUBLIC_FLEETADLC_TERMINAL_URL`, which a cloud
 * install points at the console's own domain. On Cloud Run (`K_SERVICE`) a
 * run.app name is taken too, as the bridge takes it. `FLEETADLC_ALLOWED_HOSTS=*`
 * takes any name.
 */
export function configuredHosts(env: Record<string, string | undefined> = process.env): HostRule {
  const extra = (env.FLEETADLC_ALLOWED_HOSTS ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  const names = new Set<string>(FIXED_HOSTS);
  // The terminal URL is read here at run time, through `env`, and must stay
  // that way. Written as `process.env.NEXT_PUBLIC_FLEETADLC_TERMINAL_URL`, Next
  // inlines the value the image was built with, and a cloud console is built
  // without it (it is set on the service): its own domain would then get 421
  // until `FLEETADLC_CONSOLE_URL` reached the service too.
  for (const value of [env.FLEETADLC_CONSOLE_URL, env.FLEETADLC_PUBLIC_URL, env['NEXT_PUBLIC_FLEETADLC_TERMINAL_URL']]) {
    if (!value) continue;
    try {
      names.add(new URL(value).hostname.toLowerCase().replace(/\.$/, ''));
    } catch {
      // Not a URL, so not a name anybody reaches the console under.
    }
  }
  for (const entry of extra) {
    const name = allowedEntry(entry);
    if (name) names.add(name);
  }
  return { any: extra.includes('*'), names, suffixes: env.K_SERVICE ? ['.run.app'] : [] };
}

/**
 * An entry of `FLEETADLC_ALLOWED_HOSTS` as a name: `mybox.lan`, `mybox.lan:47300`,
 * or the URL the console is opened at, `http://mybox.lan:47300`.
 */
function allowedEntry(entry: string): string | null {
  if (entry.includes('://')) {
    try {
      return new URL(entry).hostname.toLowerCase().replace(/\.$/, '') || null;
    } catch {
      return null;
    }
  }
  return hostnameOf(entry);
}


function hostnameOf(host: string): string | null {
  const match = /^(\[[0-9a-f:.]+\]|[^:[\]\s/]+)(?::\d{1,5})?$/.exec(host.trim().toLowerCase());
  return match?.[1] ? match[1].replace(/\.$/, '') : null;
}

/**
 * Whether a `Host` is one the console is served under. An address always is:
 * rebinding needs a name, and a console opened on a LAN address keeps working.
 */
export function hostAllowed(host: string | undefined, rule: HostRule): boolean {
  if (rule.any || host === undefined) return true;
  const name = hostnameOf(host);
  if (!name) return false;
  if (name.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return true;
  return name.endsWith('.localhost') || rule.names.has(name) || rule.suffixes.some((suffix) => name.endsWith(suffix));
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Whether a state-changing request is a browser calling from a page that is
 * not this console. Neither `Origin` nor `Sec-Fetch-Site` means the caller is
 * not a browser — the CLI, a script — and it is served as before. `same-site`
 * is refused as well as `cross-site`: another port on `127.0.0.1` is a
 * different origin and is still same-site.
 */
export function rejectsBrowser(method: string, headers: Headers): boolean {
  if (SAFE_METHODS.has(method)) return false;

  const origin = headers.get('origin')?.trim();
  const site = headers.get('sec-fetch-site')?.trim().toLowerCase();

  if (!origin && !site) return false;
  if (origin === 'null') return true;
  if (origin && isOwnHost(origin, headers)) return false;
  if (site === 'cross-site' || site === 'same-site') return true;
  return Boolean(origin);
}

/**
 * Whether `origin` names the host this request was sent to: the first
 * `X-Forwarded-Host`, or `Host`, as Next reads them for a server action. The
 * scheme is left out, because TLS usually ends at a proxy in front of the
 * console. Two `Origin` headers arrive joined by a comma, do not parse, and
 * are refused.
 */
function isOwnHost(origin: string, headers: Headers): boolean {
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const forwarded = headers.get('x-forwarded-host')?.split(',')[0]?.trim().toLowerCase();
  return host === forwarded || host === headers.get('host')?.trim().toLowerCase();
}
