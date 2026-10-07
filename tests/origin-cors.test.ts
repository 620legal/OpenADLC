import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { AttachTokens } from '../apps/hostd/src/attach-tokens.ts';
import {
  ATTACH_SUBPROTOCOL_PREFIX,
  TerminalGateway,
  configuredConsoleOrigins as gatewayConsoleOrigins,
  consoleOrigins as gatewayOrigins,
  upgradeOriginAllowed,
} from '../apps/hostd/src/terminal-gateway.ts';
import {
  Router,
  configuredConsoleOrigins as bridgeConsoleOrigins,
  configuredHosts as bridgeHosts,
  consoleOrigins as bridgeOrigins,
  hostAllowed as bridgeHostAllowed,
  rejectsBrowser,
} from '../apps/bridge/src/router.ts';
import {
  config as consoleMiddlewareConfig,
  configuredHosts as consoleHosts,
  hostAllowed as consoleHostAllowed,
  middleware as consoleMiddleware,
  rejectsBrowser as consoleRejectsBrowser,
} from '../apps/console/src/middleware.ts';
import { SESSION_COOKIE, sessionValue } from '../apps/console/src/lib/sign-in.ts';

// The gateway writes an audit row once a socket is up. Nothing here has a database.
vi.mock('@fleetadlc/db', () => ({
  audit: vi.fn(async () => undefined),
}));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONSOLE = 'http://127.0.0.1:47300';
const TOKEN = 'minted-attach-token';

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
  vi.unstubAllEnvs();
});

function expectNoCors(headers: Headers): void {
  expect(headers.get('access-control-allow-origin')).toBeNull();
  expect(headers.get('access-control-allow-headers')).toBeNull();
  expect(headers.get('access-control-allow-private-network')).toBeNull();
}

async function startBridge(): Promise<{ url: string; seen: string[] }> {
  const seen: string[] = [];
  const router = new Router(undefined, bridgeOrigins(CONSOLE));
  router.post('/v1/terminal/:bot/:session/token', async () => {
    seen.push('mint');
    return { token: TOKEN, expiresInSeconds: 60 };
  });
  router.post('/v1/gates/:id/answer', async () => {
    seen.push('answer');
    return { ok: true };
  });
  router.patch('/v1/repos/:name', async () => {
    seen.push('patch');
    return { ok: true };
  });

  const server = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

async function call(
  url: string,
  path: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; text: string; headers: Headers }> {
  const response = await fetch(`${url}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
  return { status: response.status, text: await response.text(), headers: response.headers };
}

describe('another origin cannot read an attach token or answer a gate', () => {
  it('mints for the console server, and the response is not readable cross-origin', async () => {
    const bridge = await startBridge();
    const minted = await call(bridge.url, '/v1/terminal/atlas/shell/token', 'POST', {});
    expect(minted.status).toBe(200);
    expect(minted.text).toContain(TOKEN);
    expectNoCors(minted.headers);
    expect(bridge.seen).toEqual(['mint']);
  });

  it('refuses the page that posts for a token, and does not mint one', async () => {
    const bridge = await startBridge();
    const stolen = await call(bridge.url, '/v1/terminal/atlas/shell/token', 'POST', {
      origin: 'https://evil.example',
    });
    expect(stolen.status).toBe(403);
    expect(stolen.text).not.toContain(TOKEN);
    expectNoCors(stolen.headers);
    expect(bridge.seen).toEqual([]);
  });

  it('refuses a text/plain answer from another origin before the gate is touched', async () => {
    const bridge = await startBridge();
    const answered = await call(
      bridge.url,
      '/v1/gates/gate-1/answer',
      'POST',
      { origin: 'https://evil.example', 'content-type': 'text/plain', 'sec-fetch-site': 'cross-site' },
      JSON.stringify({ answer: 'approve' }),
    );
    expect(answered.status).toBe(403);
    expectNoCors(answered.headers);
    expect(bridge.seen).toEqual([]);
  });

  it('refuses another port on this machine, which is same-site and still another origin', async () => {
    const bridge = await startBridge();
    const local = await call(bridge.url, '/v1/terminal/atlas/shell/token', 'POST', {
      origin: 'http://127.0.0.1:8080',
      'sec-fetch-site': 'same-site',
    });
    expect(local.status).toBe(403);
    expect(bridge.seen).toEqual([]);
  });

  it('accepts the console under either loopback name', async () => {
    const bridge = await startBridge();
    for (const origin of ['http://127.0.0.1:47300', 'http://localhost:47300', 'http://[::1]:47300']) {
      const response = await call(bridge.url, '/v1/repos/fleetadlc', 'PATCH', {
        origin,
        'sec-fetch-site': 'same-site',
        'content-type': 'application/json',
      }, '{}');
      expect(response.status, origin).toBe(200);
      expectNoCors(response.headers);
    }
    expect(bridge.seen).toEqual(['patch', 'patch', 'patch']);
  });

  it('refuses an opaque origin and a duplicated Origin header', () => {
    const allowed = bridgeOrigins(CONSOLE);
    expect(rejectsBrowser('POST', { origin: 'null' }, allowed)).toBe(true);
    // Node types Origin as one string; the guard still refuses an array of two.
    const twice = { origin: ['https://a.example', 'https://b.example'] } as unknown as IncomingHttpHeaders;
    expect(rejectsBrowser('POST', twice, allowed)).toBe(true);
    expect(rejectsBrowser('POST', {}, allowed)).toBe(false);
    expect(rejectsBrowser('GET', { origin: 'https://evil.example' }, allowed)).toBe(false);
  });

  it('does not advertise CORS on an error or a preflight', async () => {
    const bridge = await startBridge();
    const missing = await call(bridge.url, '/v1/no-such', 'GET', { origin: 'https://evil.example' });
    expect(missing.status).toBe(404);
    expectNoCors(missing.headers);

    const preflight = await call(bridge.url, '/v1/terminal/atlas/shell/token', 'OPTIONS', {
      origin: 'https://evil.example',
      'access-control-request-method': 'POST',
    });
    expect(preflight.status).toBe(204);
    expectNoCors(preflight.headers);
    expect(bridge.seen).toEqual([]);
  });
});

/**
 * The console serves a local browser only once it has signed in, so the
 * requests below carry the session a sign-in link sets: what is under test
 * here is the name and the origin.
 */
const CONSOLE_SECRET = 'e'.repeat(64);

async function signedIn(): Promise<string> {
  vi.stubEnv('FLEETADLC_CONSOLE_SECRET', CONSOLE_SECRET);
  vi.stubEnv('FLEETADLC_IDENTITY_MODE_EXPECTED', '');
  return `${SESSION_COOKIE}=${await sessionValue(CONSOLE_SECRET)}`;
}

describe('another origin cannot post through the console', () => {
  const HOST = '127.0.0.1:47300';

  async function post(headers: Record<string, string>): Promise<Response | undefined> {
    const cookie = await signedIn();
    return consoleMiddleware(
      new Request(`http://${HOST}/api/model-accounts`, { method: 'POST', headers: { host: HOST, cookie, ...headers }, body: '{}' }),
    );
  }

  it('refuses a page elsewhere before the route forwards it to the bridge', async () => {
    // The route handler calls the bridge from the console's server, with no
    // Origin on that hop, so this is the only place the page is visible.
    const refused = await post({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' });
    expect(refused?.status).toBe(403);
    expect((await post({ origin: 'http://127.0.0.1:8080', 'sec-fetch-site': 'same-site' }))?.status).toBe(403);
    expect((await post({ origin: 'null' }))?.status).toBe(403);
  });

  it('serves the console under whatever name it was opened, and a caller that is not a browser', async () => {
    expect(await post({ origin: `http://${HOST}`, 'sec-fetch-site': 'same-origin' })).toBeUndefined();
    expect(
      await post({ host: '192.168.1.20:47300', origin: 'http://192.168.1.20:47300', 'sec-fetch-site': 'same-origin' }),
    ).toBeUndefined();
    // Behind a proxy, the name the browser used arrives as X-Forwarded-Host.
    // A cloud console's domain is its configured one.
    vi.stubEnv('K_SERVICE', 'fleetadlc-console');
    vi.stubEnv('NEXT_PUBLIC_FLEETADLC_TERMINAL_URL', 'wss://fleetadlc.example');
    expect(
      await post({ host: 'fleetadlc-console.run.app', 'x-forwarded-host': 'fleetadlc.example', origin: 'https://fleetadlc.example' }),
    ).toBeUndefined();
    vi.unstubAllEnvs();
    expect(await post({})).toBeUndefined();
  });

  it('leaves reads, and server actions, to Next', async () => {
    const cookie = await signedIn();
    const read = new Request(`http://${HOST}/api/engines`, { headers: { host: HOST, cookie, origin: 'https://evil.example' } });
    expect(await consoleMiddleware(read)).toBeUndefined();
    // A server action posts to a page path, where Next checks the origin itself.
    const action = new Request(`http://${HOST}/board`, {
      method: 'POST',
      headers: { host: HOST, cookie, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      body: '{}',
    });
    expect(await consoleMiddleware(action)).toBeUndefined();
  });

  it('refuses what the bridge refuses', () => {
    const cases: [string, Record<string, string>][] = [
      ['POST', {}],
      ['POST', { origin: 'https://evil.example' }],
      ['POST', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }],
      ['POST', { origin: 'http://127.0.0.1:8080', 'sec-fetch-site': 'same-site' }],
      ['POST', { 'sec-fetch-site': 'cross-site' }],
      ['POST', { 'sec-fetch-site': 'same-origin' }],
      ['POST', { origin: 'null' }],
      ['PATCH', { origin: CONSOLE, 'sec-fetch-site': 'same-origin' }],
      ['GET', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }],
    ];
    for (const [method, headers] of cases) {
      expect(consoleRejectsBrowser(method, new Headers({ host: HOST, ...headers })), `${method} ${JSON.stringify(headers)}`)
        .toBe(rejectsBrowser(method, headers, bridgeOrigins(CONSOLE)));
    }
  });
});

describe('a name rebound to this machine', () => {
  // DNS rebinding: evil.example resolves to the attacker, serves a page, then
  // resolves to 127.0.0.1. To the browser the page and the bridge or console
  // are then one origin, so the origin checks let it read; its Host does not.
  const LOCAL: NodeJS.ProcessEnv = { FLEETADLC_BRIDGE_URL: 'http://127.0.0.1:47311' };

  async function startGuarded(env: NodeJS.ProcessEnv): Promise<{ port: number; seen: string[] }> {
    const seen: string[] = [];
    const router = new Router(undefined, bridgeOrigins(CONSOLE), bridgeHosts(env));
    router.get('/v1/sessions/:bot/:session/pane', async () => {
      seen.push('pane');
      return { lines: ['a bot’s screen'] };
    });
    router.post('/webhooks/github', async () => {
      seen.push('webhook');
      return { ok: true };
    });
    router.get('/healthz', async () => {
      seen.push('healthz');
      return { ok: true };
    });
    router.post('/internal/events', async () => {
      seen.push('internal');
      return { ok: true };
    });
    const server = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise((resolve) => server.close(() => resolve())));
    return { port: (server.address() as AddressInfo).port, seen };
  }

  function asHost(port: number, host: string, path: string, method = 'GET'): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const sent = httpRequest({ host: '127.0.0.1', port, path, method, headers: { host } }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (body += chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      });
      sent.on('error', reject);
      sent.end();
    });
  }

  it('cannot read the bridge: a Host the install is not served under gets 421 and no body', async () => {
    const bridge = await startGuarded(LOCAL);

    const refused = await asHost(bridge.port, 'attacker.example:47311', '/v1/sessions/builder/main/pane');

    expect(refused).toEqual({ status: 421, body: '' });
    expect(bridge.seen).toEqual([]);
  });

  it('is not needed to reach the bridge by its own names', async () => {
    const bridge = await startGuarded(LOCAL);
    for (const host of ['127.0.0.1:47311', 'localhost:47311', '[::1]:47311', '192.168.1.20:47311', 'host.docker.internal:47311']) {
      expect((await asHost(bridge.port, host, '/v1/sessions/builder/main/pane')).status, host).toBe(200);
    }
  });

  it('leaves GitHub’s deliveries, the internal API and health checks alone, under any name', async () => {
    // A delivery arrives under whatever name GitHub was pointed at, a tunnel's
    // included; it is signed. The internal API needs the install's secret.
    const bridge = await startGuarded(LOCAL);

    expect((await asHost(bridge.port, 'abc.trycloudflare.com', '/webhooks/github', 'POST')).status).toBe(200);
    expect((await asHost(bridge.port, 'attacker.example', '/healthz')).status).toBe(200);
    expect((await asHost(bridge.port, 'attacker.example', '/internal/events', 'POST')).status).toBe(200);
    expect(bridge.seen).toEqual(['webhook', 'healthz', 'internal']);
  });

  it('serves a cloud install under its console domain, and on Cloud Run under a run.app name', async () => {
    const cloud = bridgeHosts({ FLEETADLC_CONSOLE_URL: 'https://fleetadlc.example', FLEETADLC_PUBLIC_URL: 'https://fleetadlc.example' });
    expect(bridgeHostAllowed('fleetadlc.example', cloud)).toBe(true);
    expect(bridgeHostAllowed('attacker.example', cloud)).toBe(false);
    expect(bridgeHostAllowed('fleetadlc-bridge-123456789.us-central1.run.app', cloud)).toBe(false);

    const onCloudRun = bridgeHosts({ K_SERVICE: 'fleetadlc-bridge', FLEETADLC_CONSOLE_URL: 'https://fleetadlc.example' });
    expect(bridgeHostAllowed('fleetadlc-bridge-123456789.us-central1.run.app', onCloudRun)).toBe(true);
    expect(bridgeHostAllowed('fleetadlc.example', onCloudRun)).toBe(true);
    expect(bridgeHostAllowed('attacker.example', onCloudRun)).toBe(false);
    expect(bridgeHostAllowed('run.app.attacker.example', onCloudRun)).toBe(false);

    // A cloud console is behind IAP, which signs people in.
    vi.stubEnv('FLEETADLC_IDENTITY_MODE_EXPECTED', 'iap');
    vi.stubEnv('K_SERVICE', 'fleetadlc-console');
    vi.stubEnv('NEXT_PUBLIC_FLEETADLC_TERMINAL_URL', 'wss://fleetadlc.example');
    expect(await consoleMiddleware(new Request('https://fleetadlc.example/', { headers: { host: 'fleetadlc.example' } }))).toBeUndefined();
    expect((await consoleMiddleware(new Request('https://attacker.example/', { headers: { host: 'attacker.example' } })))?.status).toBe(421);
  });

  it('serves the compose install, whose console calls the bridge by its service name', async () => {
    // Read from the compose file, so the file losing the setting fails here.
    const compose = readFileSync(join(ROOT, 'infra', 'local', 'docker-compose.yml'), 'utf8');
    const environmentOf = (service: string): NodeJS.ProcessEnv => {
      const block = new RegExp(`^  ${service}:\\n([\\s\\S]*?)(?=^  \\S|^\\S)`, 'm').exec(compose)?.[1] ?? '';
      const environment = /^    environment:\n((?:^      .*\n)+)/m.exec(block)?.[1] ?? '';
      return Object.fromEntries(
        [...environment.matchAll(/^      (\w+): '?([^'\n]*)'?$/gm)].map((match) => [match[1], match[2]]),
      );
    };
    const consoleCalls = new URL(environmentOf('console').FLEETADLC_BRIDGE_URL ?? '').host;
    expect(consoleCalls).toBe('bridge:47311');

    const bridge = await startGuarded(environmentOf('bridge'));
    expect((await asHost(bridge.port, consoleCalls, '/v1/sessions/builder/main/pane')).status).toBe(200);
  });

  it('takes the names FLEETADLC_ALLOWED_HOSTS adds, or every name for `*`', () => {
    const listed = bridgeHosts({ FLEETADLC_ALLOWED_HOSTS: 'mybox.lan, fleetadlc.tailnet.ts.net:47300, http://studio.lan:47300/' });
    expect(bridgeHostAllowed('studio.lan:47300', listed)).toBe(true);
    expect(consoleHostAllowed('studio.lan', consoleHosts({ FLEETADLC_ALLOWED_HOSTS: 'http://studio.lan:47300/' }))).toBe(true);
    expect(bridgeHostAllowed('mybox.lan:47300', listed)).toBe(true);
    expect(bridgeHostAllowed('fleetadlc.tailnet.ts.net', listed)).toBe(true);
    expect(bridgeHostAllowed('attacker.example', listed)).toBe(false);
    expect(bridgeHostAllowed('attacker.example', bridgeHosts({ FLEETADLC_ALLOWED_HOSTS: '*' }))).toBe(true);
  });

  it('cannot use the console: any path, under a name it is not served under, gets 421 and no body', async () => {
    vi.stubEnv('K_SERVICE', '');
    vi.stubEnv('FLEETADLC_ALLOWED_HOSTS', '');
    vi.stubEnv('NEXT_PUBLIC_FLEETADLC_TERMINAL_URL', '');
    for (const request of [
      new Request('http://attacker.example:47300/', { headers: { host: 'attacker.example:47300' } }),
      new Request('http://attacker.example:47300/board', { method: 'POST', headers: { host: 'attacker.example:47300' }, body: '{}' }),
      new Request('http://127.0.0.1:47300/api/engines', { headers: { host: '127.0.0.1:47300', 'x-forwarded-host': 'attacker.example' } }),
    ]) {
      const refused = await consoleMiddleware(request);
      expect(refused?.status, request.url).toBe(421);
      expect(await refused?.text()).toBe('');
    }
    const cookie = await signedIn();
    expect(await consoleMiddleware(new Request('http://127.0.0.1:47300/', { headers: { host: '127.0.0.1:47300', cookie } }))).toBeUndefined();
    expect(await consoleMiddleware(new Request('http://localhost:47300/', { headers: { host: 'localhost:47300', cookie } }))).toBeUndefined();
    expect(consoleMiddlewareConfig.matcher).toBe('/((?!_next/static/|_next/image$|favicon\\.ico$).*)');
  });

  it('is decided the same way by the bridge and the console', () => {
    const envs: NodeJS.ProcessEnv[] = [
      {},
      { FLEETADLC_CONSOLE_URL: 'https://fleetadlc.example' },
      { FLEETADLC_PUBLIC_URL: 'https://hooks.example/' },
      { FLEETADLC_ALLOWED_HOSTS: 'mybox.lan' },
      { FLEETADLC_ALLOWED_HOSTS: 'http://mybox.lan:47300, not a host' },
      { FLEETADLC_ALLOWED_HOSTS: '*' },
      { K_SERVICE: 'fleetadlc-console' },
    ];
    const hosts = [
      '127.0.0.1:47300', 'localhost', 'LOCALHOST.', 'fleetadlc.localhost:47300', '[::1]:47300', '10.0.0.4',
      'fleetadlc.example', 'hooks.example', 'mybox.lan:47300', 'attacker.example', '127.0.0.1.attacker.example',
      '', 'a b', 'fleetadlc.example:99999999', 'fleetadlc-1.us-central1.run.app', 'run.app.attacker.example',
    ];
    for (const env of envs) {
      for (const host of hosts) {
        expect(consoleHostAllowed(host, consoleHosts(env)), `${JSON.stringify(env)} ${host}`).toBe(
          bridgeHostAllowed(host, bridgeHosts(env)),
        );
      }
    }
  });
});

describe('the console origins the bridge and the gateway agree on', () => {
  it('treats the three loopback names of one port as the console, and no other host', () => {
    const expected = ['http://127.0.0.1:47300', 'http://localhost:47300', 'http://[::1]:47300'].sort();
    expect(bridgeOrigins(CONSOLE).sort()).toEqual(expected);
    expect(gatewayOrigins(CONSOLE).sort()).toEqual(expected);
    expect(bridgeOrigins('https://fleetadlc.example')).toEqual(['https://fleetadlc.example']);
    expect(gatewayOrigins('https://fleetadlc.example')).toEqual(['https://fleetadlc.example']);
    expect(bridgeOrigins('http://192.168.1.20:47300')).toEqual(['http://192.168.1.20:47300']);
    expect(bridgeOrigins('not a url')).toEqual([]);
  });

  it('reads the configured console, and defaults to the local one', () => {
    expect(bridgeConsoleOrigins({})).toEqual(gatewayConsoleOrigins({}));
    expect(bridgeConsoleOrigins({})).toContain('http://127.0.0.1:47300');
    expect(bridgeConsoleOrigins({ FLEETADLC_CONSOLE_PORT: '48000' })).toContain('http://127.0.0.1:48000');
    expect(bridgeConsoleOrigins({ FLEETADLC_CONSOLE_URL: 'https://fleetadlc.example' })).toEqual(['https://fleetadlc.example']);
    expect(gatewayConsoleOrigins({ FLEETADLC_CONSOLE_URL: 'https://fleetadlc.example/' })).toEqual(['https://fleetadlc.example']);
  });
});

interface Handshake {
  status?: number;
  protocol?: string;
}

function openSocket(
  port: number,
  token: string,
  options: { origin?: string; query?: boolean; protocols?: string[] } = {},
): Promise<Handshake> {
  const url = options.query
    ? `ws://127.0.0.1:${port}/terminal?token=${encodeURIComponent(token)}`
    : `ws://127.0.0.1:${port}/terminal`;
  const protocols = options.query ? [] : (options.protocols ?? [`${ATTACH_SUBPROTOCOL_PREFIX}${token}`]);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols, {
      handshakeTimeout: 2000,
      ...(options.origin ? { origin: options.origin } : {}),
    });
    let settled = false;
    const finish = (result: Handshake): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ws.readyState === WebSocket.OPEN) ws.close();
      resolve(result);
    };
    const timer = setTimeout(() => {
      ws.terminate();
      if (!settled) {
        settled = true;
        reject(new Error('the handshake timed out'));
      }
    }, 2500);
    ws.once('open', () => finish({ protocol: ws.protocol }));
    ws.once('unexpected-response', (_request, response) => {
      response.resume();
      finish({ status: response.statusCode });
    });
    ws.once('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}

async function startGateway(): Promise<{ port: number; tokens: AttachTokens }> {
  const tokens = new AttachTokens();
  const server = createServer((_request, response) => {
    response.writeHead(200);
    response.end('ok');
  });
  // A command that will not be reached: the assertions are about the handshake.
  const gateway = new TerminalGateway({ attachCommand: () => ['/bin/true'] } as never, (token) => tokens.redeem(token), bridgeOrigins(CONSOLE));
  gateway.attachTo(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(
    () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  );
  return { port: (server.address() as AddressInfo).port, tokens };
}

describe('the terminal upgrade', () => {
  it('accepts the console origin and echoes the subprotocol', async () => {
    const gateway = await startGateway();
    const minted = gateway.tokens.mint({ bot: 'atlas', session: 'shell', identity: 'operator' });
    const opened = await openSocket(gateway.port, minted.token, { origin: CONSOLE });
    expect(opened.status).toBeUndefined();
    expect(opened.protocol).toBe(`${ATTACH_SUBPROTOCOL_PREFIX}${minted.token}`);
    expect(gateway.tokens.outstanding).toBe(0);
  });

  it('accepts a non-browser client, which is how the terminal suite connects', async () => {
    const gateway = await startGateway();
    const minted = gateway.tokens.mint({ bot: 'atlas', session: 'shell', identity: 'operator' });
    const opened = await openSocket(gateway.port, minted.token);
    expect(opened.protocol).toBe(`${ATTACH_SUBPROTOCOL_PREFIX}${minted.token}`);
  });

  it('refuses another origin without spending the token', async () => {
    const gateway = await startGateway();
    const minted = gateway.tokens.mint({ bot: 'atlas', session: 'shell', identity: 'operator' });
    const refused = await openSocket(gateway.port, minted.token, { origin: 'https://evil.example' });
    expect(refused.status).toBe(403);
    expect(gateway.tokens.outstanding).toBe(1);

    const opaque = await openSocket(gateway.port, minted.token, { origin: 'null' });
    expect(opaque.status).toBe(403);
    const otherPort = await openSocket(gateway.port, minted.token, { origin: 'http://127.0.0.1:8080' });
    expect(otherPort.status).toBe(403);
    expect(gateway.tokens.outstanding).toBe(1);

    const opened = await openSocket(gateway.port, minted.token, { origin: 'http://localhost:47300' });
    expect(opened.protocol).toBe(`${ATTACH_SUBPROTOCOL_PREFIX}${minted.token}`);
  });

  it('refuses a token carried in the query string, and does not redeem it', async () => {
    const gateway = await startGateway();
    const minted = gateway.tokens.mint({ bot: 'atlas', session: 'shell', identity: 'operator' });
    const refused = await openSocket(gateway.port, minted.token, { query: true, origin: CONSOLE });
    expect(refused.status).toBe(401);
    expect(gateway.tokens.outstanding).toBe(1);

    const opened = await openSocket(gateway.port, minted.token, { origin: CONSOLE });
    expect(opened.protocol).toBe(`${ATTACH_SUBPROTOCOL_PREFIX}${minted.token}`);
  });

  it('refuses a page whose origin is only the host the socket was reached on', async () => {
    // What a rebound name looks like: attacker.example resolves to this
    // machine, so a page of theirs on the gateway's port sends an Origin that
    // equals the Host it connected to. Matching the two admitted it.
    const gateway = await startGateway();
    const minted = gateway.tokens.mint({ bot: 'atlas', session: 'shell', identity: 'operator' });
    const rebound = await openSocket(gateway.port, minted.token, { origin: `http://127.0.0.1:${gateway.port}` });
    expect(rebound.status).toBe(403);
    expect(gateway.tokens.outstanding).toBe(1);
  });

  it('admits a cloud console by configuration, and nothing else by its name', () => {
    const cloud = gatewayConsoleOrigins({ FLEETADLC_CONSOLE_URL: 'https://fleetadlc.example' });
    expect(upgradeOriginAllowed('https://fleetadlc.example', cloud)).toBe(true);
    expect(upgradeOriginAllowed('https://evil.example', cloud)).toBe(false);
    expect(upgradeOriginAllowed('https://fleetadlc.example', gatewayConsoleOrigins({}))).toBe(false);
    expect(upgradeOriginAllowed(undefined, cloud)).toBe(true);
    expect(upgradeOriginAllowed('null', cloud)).toBe(false);
  });

  it('echoes the subprotocol whose token it redeemed', async () => {
    const gateway = await startGateway();
    const minted = gateway.tokens.mint({ bot: 'atlas', session: 'shell', identity: 'operator' });
    const valid = `${ATTACH_SUBPROTOCOL_PREFIX}${minted.token}`;
    // A legal subprotocol, but not a token: `~` is outside the alphabet.
    const opened = await openSocket(gateway.port, minted.token, {
      origin: CONSOLE,
      protocols: [`${ATTACH_SUBPROTOCOL_PREFIX}not~a~token`, valid],
    });
    expect(opened.protocol).toBe(valid);
    expect(gateway.tokens.outstanding).toBe(0);
  });

  it('does not spend the token on a handshake ws refuses', async () => {
    const gateway = await startGateway();
    const minted = gateway.tokens.mint({ bot: 'atlas', session: 'shell', identity: 'operator' });
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const sent = httpRequest({
        host: '127.0.0.1',
        port: gateway.port,
        path: '/terminal',
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          origin: CONSOLE,
          'sec-websocket-key': 'not a key',
          'sec-websocket-version': '13',
          'sec-websocket-protocol': `${ATTACH_SUBPROTOCOL_PREFIX}${minted.token}`,
        },
      });
      sent.once('response', (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      sent.once('upgrade', () => reject(new Error('the gateway upgraded a malformed handshake')));
      sent.once('error', reject);
      sent.end();
    });
    expect(status).toBe(400);
    expect(gateway.tokens.outstanding).toBe(1);
  });
});

describe('what is stated for an operator', () => {
  const security = readFileSync(join(ROOT, 'docs', 'security.md'), 'utf8');
  const consoleSource = readFileSync(join(ROOT, 'apps', 'console', 'src', 'components', 'terminal.tsx'), 'utf8');
  const terminalUrlSource = readFileSync(join(ROOT, 'apps', 'console', 'src', 'lib', 'terminal-url.ts'), 'utf8');

  it('says only an admin may attach, to any bot', () => {
    expect(security).toMatch(/Only an admin may mint\s+one/);
    expect(security).toMatch(/for any bot and any session/);
    expect(security).toMatch(/no\s+per-bot grant/i);
  });

  it('says the token is not on the request line, and the console does not put it there', () => {
    expect(security).toMatch(/does not travel in the query string/);
    expect(security).toContain(ATTACH_SUBPROTOCOL_PREFIX);
    expect(consoleSource).toContain(`[\`${ATTACH_SUBPROTOCOL_PREFIX}\${grant.token}\`]`);
    expect(consoleSource).not.toContain('?token=');

    // The bridge is what the console's server calls. It must not hand back a
    // path that puts the token on a URL, even if hostd still suggests one.
    const api = readFileSync(join(ROOT, 'apps', 'bridge', 'src', 'api.ts'), 'utf8');
    const route = api.slice(api.indexOf("'/v1/terminal/:bot/:session/token'"));
    const handler = route.slice(0, route.indexOf('router.post', 10));
    expect(handler).toContain('expiresInSeconds: minted.expiresInSeconds');
    expect(handler).not.toContain('websocketPath');
    expect(handler).not.toContain('return minted');

    // Nor does hostd suggest one: the gateway refuses a `?token=`.
    const hostd = readFileSync(join(ROOT, 'apps', 'hostd', 'src', 'server.ts'), 'utf8');
    const mint = hostd.slice(hostd.indexOf("path === '/terminal/tokens'"), hostd.indexOf("path === '/terminal/redeem'"));
    expect(mint).toContain('websocketPath');
    expect(mint).not.toContain('?token=');
  });

  it('names the setting when the console is opened under a name the gateway refuses', () => {
    // The browser hides the handshake's status, so the page has to say it.
    // Worded in lib/terminal-url.ts, beside the address the socket tried.
    expect(terminalUrlSource).toMatch(/FLEETADLC_CONSOLE_URL names; if that is not \$\{origin\}/);
    expect(consoleSource).toContain('socketFailure(address, window.location.origin)');
    expect(security).toMatch(/cannot open the terminal until\s+`FLEETADLC_CONSOLE_URL` names it for hostd/);
  });
});
