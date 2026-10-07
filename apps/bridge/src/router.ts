import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Identity } from './identity.js';
import type { Role } from '@fleetadlc/db';

/**
 * Whether the person behind a `/v1` request may make it, and as what: their
 * role, or an `HttpFailure` refusing them. `roles.ts` is the one `main.ts`
 * passes; the method and path are the route's, as it was registered.
 */
export type Access = (method: string, path: string, identity: string) => Promise<Role>;

export interface RequestContext {
  params: Record<string, string>;
  query: URLSearchParams;
  /** The JSON body, read up to `JSON_BODY_MAX` unless the route names its own limit. */
  body: <T>(options?: { limit?: number }) => Promise<T>;
  /**
   * The person behind the request: a verified IAP claim in the cloud, a header
   * locally. Never a header in the cloud — see `identity.ts`. A route that
   * does not act for a person (`needsPerson`) gets a fixed name instead,
   * `github` or `internal`, never one read from the request.
   */
  identity: string;
  /**
   * What that person may do here, looked up by the bridge before the handler
   * ran: a route that needs an admin never runs for a user. `admin` on a
   * router built without roles, which is what a test of one handler is.
   */
  role: Role;
  raw: IncomingMessage;
  /** For a handler that writes the response itself; see `STREAMING`. */
  res: ServerResponse;
}

export type Handler = (context: RequestContext) => Promise<unknown>;

interface Route {
  method: string;
  /** As registered, `/v1/bots/:name`: what a route's role is looked up by. */
  path: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

/**
 * The path and query of a request, or null if the target is unparseable. An
 * absolute-form target (`GET http://host/path`, which a proxy may send) can
 * carry its own broken authority, so this is tried rather than trusted.
 */
function parseTarget(target: string | undefined): URL | null {
  try {
    return new URL(target ?? '/', 'http://fleetadlc.invalid');
  } catch {
    return null;
  }
}

function compile(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = [];
  const pattern = path
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment;
      keys.push(segment.slice(1));
      return '([^/]+)';
    })
    .join('/');
  return { pattern: new RegExp(`^${pattern}$`), keys };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** How many refused names are said, each once, before the bridge stops saying them. */
const REFUSED_HOSTS_SAID = 100;

/**
 * Several `Origin` values is not a browser. Treating it as absent would allow
 * the request, and absent is exactly what a non-browser looks like.
 */
const REJECT_HEADER = Symbol('reject-header');

export class Router {
  private readonly routes: Route[] = [];
  private readonly allowedOrigins: readonly string[];
  private readonly allowedHosts: HostRule;
  /** Names a request was refused under, each said once. */
  private readonly refusedHosts = new Set<string>();

  /**
   * Without a resolver the bridge falls back to the local header path, which is
   * what an install with no cloud configuration is. `main.ts` builds one from
   * the config so a cloud install cannot get here by omission.
   *
   * `allowedOrigins` is the console. A browser calling from anywhere else is
   * refused; a request with no `Origin` is not a browser. The default is the
   * configured console, so a router built without one still refuses a page.
   *
   * `allowedHosts` is the names the install is served under (`configuredHosts`).
   *
   * `access` decides what each person may do (`roles.ts`). Without it every
   * person may do everything, which is what the bridge was before roles.
   */
  constructor(
    private readonly identity?: Identity,
    allowedOrigins?: readonly string[],
    allowedHosts?: HostRule,
    private readonly access?: Access,
  ) {
    this.allowedOrigins = allowedOrigins ?? configuredConsoleOrigins();
    this.allowedHosts = allowedHosts ?? configuredHosts();
  }

  add(method: string, path: string, handler: Handler): this {
    const { pattern, keys } = compile(path);
    this.routes.push({ method, path, pattern, keys, handler });
    return this;
  }

  /** Every route registered, by method and path: what `roles.test.ts` checks is classified. */
  table(): { method: string; path: string }[] {
    return this.routes.map(({ method, path }) => ({ method, path }));
  }

  get(path: string, handler: Handler): this {
    return this.add('GET', path, handler);
  }

  post(path: string, handler: Handler): this {
    return this.add('POST', path, handler);
  }

  patch(path: string, handler: Handler): this {
    return this.add('PATCH', path, handler);
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // The base is a constant, not the Host header. Node passes a syntactically
    // invalid authority (`]`, a space, an out-of-range port) straight through,
    // and `new URL` throws on it — which here, ahead of routing and of every
    // authentication check, took the whole process down. Only the path and the
    // query are read, so the base never needed to come from the request.
    const url = parseTarget(request.url);
    if (!url) {
      writeJson(response, 400, { error: 'the request target is not a valid URL' });
      return;
    }
    const method = request.method ?? 'GET';

    // DNS rebinding: a name somebody else controls, pointed at this machine, is
    // the same origin as the console to the browser, so neither origin check
    // stops a page on it from reading a bot's screen off `GET` routes. The
    // `Host` it sends is its own name, which is what gives it away. Only the
    // routes that act for a person are held to this: a webhook is signed and
    // arrives under whatever name GitHub was pointed at, `/internal/*` needs
    // the install's secret, and `/healthz` is asked by whatever checks health.
    if (needsPerson(url.pathname) && !hostAllowed(request.headers.host, this.allowedHosts)) {
      request.resume();
      this.sayRefusedHost(request.headers.host ?? '');
      // 421: this server is not the one for that name. No body, because the
      // page asking is the one that must learn nothing.
      response.writeHead(421);
      response.end();
      return;
    }

    // Before routing, so a refused origin never reaches a handler. Minting a
    // token and answering a gate are both POST, and both used to run for any
    // page that could reach the port.
    if (rejectsBrowser(method, request.headers, this.allowedOrigins)) {
      request.resume();
      writeJson(response, 403, { error: 'this origin may not call the bridge' });
      return;
    }

    if (method === 'OPTIONS') {
      // No CORS headers. The console does not call the bridge from the browser,
      // so there is no origin to allow, and answering a preflight with `*` is
      // what made a token readable to another page.
      response.writeHead(204);
      response.end();
      return;
    }

    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = route.pattern.exec(url.pathname);
      if (!match) continue;

      try {
        // Inside the try: `%E0%A4%A` throws, and outside it that was a 500
        // logged as the bridge failing, for what is the caller's mistake.
        const params: Record<string, string> = {};
        route.keys.forEach((key, index) => {
          params[key] = decodedSegment(match[index + 1] ?? '');
        });

        // Resolving identity can refuse the request, so it happens inside the
        // same try that turns an HttpFailure into its status.
        const identity = !this.identity
          ? identityOf(request)
          : needsPerson(url.pathname)
            ? await this.identity.resolve(request)
            : callerOf(url.pathname);
        // Every console route, before its handler: a user's request for an
        // admin's route never runs, whatever the console showed them.
        const role: Role =
          this.access && url.pathname.startsWith('/v1/') ? await this.access(method, route.path, identity) : 'admin';

        const result = await route.handler({
          params,
          query: url.searchParams,
          body: async <T>(options?: { limit?: number }) => readJson<T>(request, options?.limit),
          identity,
          role,
          raw: request,
          res: response,
        });
        // A server-sent-events handler holds the response open for as long as
        // the client is listening, so it writes its own head and body and says
        // so. Everything else gets the usual one-shot JSON.
        if (result === STREAMING) return;
        if (result instanceof WithStatus) {
          writeJson(response, result.status, result.body);
          return;
        }
        writeJson(response, 200, result ?? { ok: true });
      } catch (error) {
        const status = statusOf(error);
        const message = error instanceof Error ? error.message : String(error);
        if (status >= 500) console.error(`[bridge] ${method} ${url.pathname} failed:`, message);
        writeJson(response, status, { ...(error instanceof HttpFailure ? error.details : {}), error: message });
      }
      return;
    }

    writeJson(response, 404, { error: `no route for ${method} ${url.pathname}` });
  }

  private sayRefusedHost(host: string): void {
    const name = host.trim().toLowerCase();
    if (this.refusedHosts.has(name) || this.refusedHosts.size > REFUSED_HOSTS_SAID) return;
    this.refusedHosts.add(name);
    // Anything on the network can send a new name with every request, so what
    // is remembered, and said, stops somewhere.
    if (this.refusedHosts.size > REFUSED_HOSTS_SAID) {
      console.warn(`[bridge] refused ${REFUSED_HOSTS_SAID} names already; further refused names are not logged`);
      return;
    }
    console.warn(
      `[bridge] refusing requests for Host ${JSON.stringify(name)}: not a name this install is served under. ` +
        'If people do reach OpenADLC under it, add it to FLEETADLC_ALLOWED_HOSTS and restart.',
    );
  }
}

/**
 * What a handler returns when it has taken over the response.
 *
 * The router writes JSON for every route, which is right for all but one: a
 * stream stays open and sends many messages, so it cannot be a return value.
 */
export const STREAMING = Symbol('streaming');

/**
 * An answer with a status other than 200, for a route whose success is not
 * "done": a request accepted to wait its turn is 202, not an error.
 */
export class WithStatus {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}

export class HttpFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Said beside `error`, for a caller that can act on more than a sentence: what a refusal needs done. */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'HttpFailure';
  }
}

/**
 * Services carry their own status when the answer is not "the server broke":
 * a busy bot is a conflict a caller can act on, not a failure.
 */
function statusOf(error: unknown): number {
  if (error instanceof HttpFailure) return error.status;
  const candidate = (error as { status?: unknown } | null)?.status;
  return typeof candidate === 'number' && candidate >= 400 && candidate <= 599 ? candidate : 500;
}

/**
 * The body exactly as it arrived. A signature is over these bytes; decoding
 * first replaces an invalid UTF-8 sequence, and the HMAC of that is not the one
 * the sender computed.
 */
export async function readBytes(request: IncomingMessage, options: { limit?: number } = {}): Promise<Buffer> {
  const limit = options.limit ?? Infinity;
  const declared = Number(request.headers['content-length'] ?? NaN);
  // A body said to be too large is refused before a byte of it is held: an
  // upload is the one body here that can be megabytes, and reading one past
  // its limit only to refuse it was memory spent on nothing.
  if (Number.isFinite(declared) && declared > limit) {
    request.resume();
    throw new HttpFailure(413, `that is ${Math.ceil(declared / (1024 * 1024))} MB; the most this takes is ${Math.floor(limit / (1024 * 1024))} MB`);
  }
  // Events rather than `for await`: leaving that loop early destroys the
  // request, and with it the socket the 413 has to be written to. A body past
  // the limit is refused as it arrives, and the rest is read and dropped.
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    request.on('data', (chunk: Buffer) => {
      if (refused) return;
      size += chunk.length;
      if (size > limit) {
        refused = true;
        chunks.length = 0;
        reject(new HttpFailure(413, `that is more than ${Math.floor(limit / (1024 * 1024))} MB, the most this takes`));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!refused) resolve(Buffer.concat(chunks));
    });
    request.on('error', reject);
  });
}

function decodedSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpFailure(400, 'the path is not valid percent-encoding');
  }
}

/**
 * The most a JSON route reads unless it says otherwise. Every body used to be
 * read whole with no ceiling, so anyone who could reach the port could stream
 * gigabytes on a few connections and run the bridge out of memory. Nothing a
 * route takes as JSON comes near this; a restore names its own, larger limit.
 */
export const JSON_BODY_MAX = 4 * 1024 * 1024;

async function readJson<T>(request: IncomingMessage, limit: number = JSON_BODY_MAX): Promise<T> {
  const raw = (await readBytes(request, { limit })).toString('utf8');
  if (!raw) return {} as T;
  // A body that does not parse is the caller's to fix, not a 500.
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpFailure(400, 'the body is not JSON');
  }
}

/**
 * Whether this route acts for a person reaching the console.
 *
 * GitHub is not a person and neither is hostd, so demanding a verified IAP
 * assertion on `/webhooks/*` would refuse the delivery GitHub makes, and on
 * `/internal/*` would refuse the dispatcher and the skill runner. Neither
 * handler reads the console `identity`.
 *
 * That is not a claim that `/webhooks/github` does not act as a person. It
 * does: an `issue_comment` delivery answers a gate as `comment.user.login`,
 * taken from the body. Skipping the console's person check is still right —
 * GitHub cannot present an assertion — and it is safe only because the
 * signature check on that route is unconditional. An install with no webhook
 * secret refuses the delivery rather than trusting the body. `/internal/*` is
 * authenticated separately, by the install's shared secret, where the route
 * is registered.
 */
function needsPerson(pathname: string): boolean {
  return !pathname.startsWith('/webhooks/') && !pathname.startsWith('/internal/') && pathname !== '/healthz';
}

/**
 * Who a route that does not act for a person is called by, on a router with a
 * resolver. Fixed rather than read: these routes skip the resolver, so a
 * header here would have been taken at its word, in the cloud too.
 */
function callerOf(pathname: string): string {
  return pathname.startsWith('/webhooks/') ? 'github' : 'internal';
}

/**
 * The local-mode reading of who is calling, kept for a router built without a
 * resolver (a test of one handler). It trusts a header, which is why a cloud
 * install must not use it: `Identity` in `iap` mode is the path that verifies.
 */
function identityOf(request: IncomingMessage): string {
  const iap = request.headers['x-goog-authenticated-user-email'];
  if (typeof iap === 'string' && iap.length > 0) return iap.replace(/^accounts\.google\.com:/, '');
  const local = request.headers['x-fleetadlc-identity'];
  if (typeof local === 'string' && local.length > 0) return local;
  return 'local operator';
}

/**
 * Origins a browser may call the bridge from.
 *
 * The console is the only one. On a loopback install the operator opens it as
 * `127.0.0.1`, `localhost` or `::1` interchangeably, so those three names of
 * the same port are one console. Any other host — a LAN address, another port
 * — is a different origin and is not added. A cloud console is whatever
 * `FLEETADLC_CONSOLE_URL` says, and nothing else.
 */
export function consoleOrigins(consoleUrl: string): string[] {
  let url: URL;
  try {
    url = new URL(consoleUrl);
  } catch {
    return [];
  }
  const origins = new Set<string>([url.origin]);
  const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (loopback.has(url.hostname)) {
    for (const host of loopback) {
      if (host === url.hostname) continue;
      const alias = new URL(url.origin);
      alias.hostname = host;
      origins.add(alias.origin);
    }
  }
  return [...origins];
}

/** The console this process was configured with. An unparseable URL allows no browser. */
export function configuredConsoleOrigins(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const configured = env.FLEETADLC_CONSOLE_URL;
  const port = env.FLEETADLC_CONSOLE_PORT && env.FLEETADLC_CONSOLE_PORT.length > 0 ? env.FLEETADLC_CONSOLE_PORT : '47300';
  const url = configured && configured.length > 0 ? configured : `http://127.0.0.1:${port}`;
  return consoleOrigins(url);
}

/**
 * The names the bridge and the console answer a person's request under.
 *
 * `any` is the operator's `FLEETADLC_ALLOWED_HOSTS=*`. `suffixes` is `.run.app` on
 * Cloud Run (`K_SERVICE` is set there): a service does not know its own run.app
 * address to list it, and the console's server and hostd call the bridge by
 * exactly that address. Nobody but Google can point a run.app name anywhere,
 * so it cannot be rebound.
 */
export interface HostRule {
  any: boolean;
  names: ReadonlySet<string>;
  suffixes: readonly string[];
}

/**
 * Names that cannot be rebound: a browser resolves `localhost` itself, and a
 * container's name for the machine it runs on is resolved in the container.
 */
const FIXED_HOSTS = ['localhost', 'host.docker.internal', 'host.containers.internal'];

/**
 * The hosts this process was configured with: the fixed names above, the hosts
 * of `FLEETADLC_CONSOLE_URL`, `FLEETADLC_PUBLIC_URL` and `FLEETADLC_BRIDGE_URL`, and
 * `FLEETADLC_ALLOWED_HOSTS`, comma-separated, for a name none of those says — a
 * LAN hostname, a tunnel to the console. `FLEETADLC_ALLOWED_HOSTS=*` takes any.
 */
export function configuredHosts(env: NodeJS.ProcessEnv = process.env): HostRule {
  const extra = (env.FLEETADLC_ALLOWED_HOSTS ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  const names = new Set<string>(FIXED_HOSTS);
  for (const value of [env.FLEETADLC_CONSOLE_URL, env.FLEETADLC_PUBLIC_URL, env.FLEETADLC_BRIDGE_URL]) {
    if (!value) continue;
    try {
      names.add(new URL(value).hostname.toLowerCase().replace(/\.$/, ''));
    } catch {
      // Not a URL, so not a name anybody reaches the install under.
    }
  }
  for (const entry of extra) {
    const name = allowedEntry(entry);
    if (name) names.add(name);
    else if (entry !== '*') console.warn(`[bridge] FLEETADLC_ALLOWED_HOSTS: ${JSON.stringify(entry)} is not a host name or a URL, so it admits nothing`);
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


/** The name in a `Host` value, without its port, or null when it is not one. */
function hostnameOf(host: string): string | null {
  const match = /^(\[[0-9a-f:.]+\]|[^:[\]\s/]+)(?::\d{1,5})?$/.exec(host.trim().toLowerCase());
  return match?.[1] ? match[1].replace(/\.$/, '') : null;
}

/**
 * Whether a request's `Host` is one the install is served under.
 *
 * An address is always one: rebinding needs a name to rebind, and a page whose
 * own address is this machine's was served from this machine. That is also
 * what keeps a console opened on a LAN address working with nothing to
 * configure. `*.localhost` is resolved by the browser to loopback. A request
 * with no `Host` is not from a browser, which always sends one.
 */
export function hostAllowed(host: string | undefined, rule: HostRule): boolean {
  if (rule.any || host === undefined) return true;
  const name = hostnameOf(host);
  if (!name) return false;
  if (name.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return true;
  return name.endsWith('.localhost') || rule.names.has(name) || rule.suffixes.some((suffix) => name.endsWith(suffix));
}

function singleHeader(value: string | string[] | undefined): string | typeof REJECT_HEADER | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.length === 1 ? value[0] : REJECT_HEADER;
  return value;
}

/**
 * Whether a state-changing request is a browser calling from somewhere other
 * than the console.
 *
 * A browser sends `Origin` on POST and PATCH, and `Sec-Fetch-Site`. `same-site`
 * is the case that matters here: another port on `127.0.0.1` is a different
 * origin and is still same-site, so refusing only `cross-site` would not stop
 * a page served from this machine. Neither header means the caller is not a
 * browser — the console's own server, the CLI, hostd, GitHub — and those are
 * served as before.
 *
 * `text/plain` is a simple content type, so that request never preflights, and
 * the body is parsed as JSON anyway. The origin is what refuses it. Hiding the
 * response would be too late: the gate would already have been answered.
 */
export function rejectsBrowser(
  method: string,
  headers: IncomingMessage['headers'],
  allowed: readonly string[],
): boolean {
  if (SAFE_METHODS.has(method)) return false;

  const originHeader = singleHeader(headers.origin);
  const siteHeader = singleHeader(headers['sec-fetch-site']);
  if (originHeader === REJECT_HEADER || siteHeader === REJECT_HEADER) return true;

  const origin = typeof originHeader === 'string' ? originHeader.trim() : undefined;
  const site = typeof siteHeader === 'string' ? siteHeader.trim().toLowerCase() : undefined;

  if (!origin && !site) return false;
  if (origin === 'null') return true;
  if (origin && allowed.includes(origin)) return false;
  if (site === 'cross-site' || site === 'same-site') return true;
  return Boolean(origin);
}

export function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body, null, 2));
}
