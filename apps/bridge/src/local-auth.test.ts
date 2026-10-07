import { createHmac } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TASK_TOKEN_HEADER, taskTokenFor } from '@fleetadlc/github';

/**
 * Who a local install's bridge serves `/v1` to.
 *
 * A default install runs in `local` mode and listens on every interface, and
 * it used to believe whatever name `x-fleetadlc-identity` gave, making any
 * name it did not know an admin. A host on the LAN, or code in a task's
 * container through `host.docker.internal`, downloaded a backup of every
 * credential with one POST. Now only a caller holding the console secret is
 * served, and the routes that are not a person's — a task's own, GitHub's,
 * the health check — answer as they did. The router, the identity check and
 * the internal routes are the real ones; the store is a fake.
 */
vi.mock('@fleetadlc/db', () => ({
  spendingLimits: {
    SPENDING_PROVIDERS: ['anthropic', 'openai', 'xai'],
    GLOBAL_SCOPE: 'global',
    seedGlobal: vi.fn(async () => false),
    effectiveTaskCap: vi.fn(async (_repoId: string | null, fallback: number) => fallback),
    amountOf: vi.fn(async () => null),
    refusal: vi.fn(async () => null),
    listLimits: vi.fn(async () => []),
    setLimit: vi.fn(async () => undefined),
    dollars: (amount: number) => (Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`),
    botKind: (id: string) => `month_bot:${id}`,
    providerKind: (provider: string) => `month_provider:${provider}`,
    repoScope: (id: string) => `repo:${id}`,
    repoIdOf: (scope: string) => (scope.startsWith('repo:') ? scope.slice(5) : null),
  },
  audit: vi.fn(async () => undefined),
  bots: {},
  costs: {},
  credentials: {},
  issues: {},
  leases: {},
  listAudit: vi.fn(),
  mergeLines: {},
  recordEvent: vi.fn(),
  repos: {},
  requests: {},
  sessions: {},
  settings: { allSettings: vi.fn(async () => ({})) },
  // A task token speaks only for a task that is running; see internal-api.ts.
  tasks: { getTask: vi.fn(async (id: string) => ({ id, state: 'running' })) },
  threads: {},
}));

const CONSOLE_SECRET = 'c'.repeat(64);
const INTERNAL_SECRET = 'install-secret-for-the-test';
const WEBHOOK_SECRET = 'webhook-secret-for-the-test';

let bridge: Server;
let port: number;
/** Every `/v1` handler that ran, and as whom. */
let served: { path: string; identity: string }[];
let delivered: string[];

beforeEach(async () => {
  const { registerInternalApi } = await import('./internal-api.js');
  const { Router } = await import('./router.js');
  const { identityFromConfig } = await import('./identity.js');

  served = [];
  delivered = [];
  // Every name is an admin here, as an unknown name is on a local install:
  // what is under test is that nobody without the secret reaches this.
  const router = new Router(identityFromConfig('local', '', CONSOLE_SECRET), undefined, undefined, async () => 'admin');
  router.post('/v1/backup', async ({ identity }) => {
    served.push({ path: '/v1/backup', identity });
    return { archive: 'every credential' };
  });
  router.post('/v1/terminal/:bot/:session/token', async ({ identity }) => {
    served.push({ path: '/v1/terminal', identity });
    return { token: 'attach' };
  });
  router.get('/v1/status', async ({ identity }) => {
    served.push({ path: '/v1/status', identity });
    return { ok: true };
  });
  registerInternalApi(router, {
    config: { webhookSecret: WEBHOOK_SECRET, publicUrl: '', organization: 'exampleco', gitHubClientId: '', automationBot: 'atlas', humans: [] } as never,
    webhooks: { receive: async (event: string) => void delivered.push(event) } as never,
    scheduler: {} as never,
    stages: {} as never,
    internalSecret: INTERNAL_SECRET,
    alertsSecret: '',
    hostd: { health: async () => ({ ok: true }) } as never,
    actors: { asBot: async () => null, configured: true } as never,
    automation: {} as never,
    gates: {} as never,
    taskService: { headroom: async (taskId: string, estimate: number) => ({ taskId, estimate, ok: true }) } as never,
    onboarding: {} as never,
    invitations: {} as never,
    threadStream: {} as never,
    webhookSetup: {} as never,
    repoSetup: {} as never,
  });

  bridge = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  port = (bridge.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => bridge.close(() => resolve()));
});

/**
 * node:http rather than fetch, so the request carries exactly these headers:
 * the Host a LAN caller or a container sends, and no Origin, as a script has none.
 */
function call(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      { host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', ...headers } },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (text += chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} }));
      },
    );
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

const BACKUP = JSON.stringify({ passphrase: 'x', selection: { install: true } });

describe('a person route without the console secret', () => {
  it('is refused from a host on the LAN, and its handler never runs', async () => {
    const answer = await call('POST', '/v1/backup', { host: `192.168.1.50:${port}` }, BACKUP);
    expect(answer.status).toBe(401);
    expect(String(answer.body.error)).toContain('only to its console and the fleetadlc CLI');
    expect(served).toEqual([]);
  });

  it('is refused from a task container, which reaches the host as host.docker.internal', async () => {
    const answer = await call('POST', '/v1/terminal/lead-reviewer/review-1/token', { host: `host.docker.internal:${port}` }, '{}');
    expect(answer.status).toBe(401);
    expect(served).toEqual([]);
  });

  it('is refused with no Origin, which is what a script sends', async () => {
    const answer = await call('GET', '/v1/status', { host: `127.0.0.1:${port}` });
    expect(answer.status).toBe(401);
    expect(served).toEqual([]);
  });

  it('is refused when it names a known admin', async () => {
    const answer = await call('POST', '/v1/backup', { host: `192.168.1.50:${port}`, 'x-fleetadlc-identity': 'owner@example.com' }, BACKUP);
    expect(answer.status).toBe(401);
    expect(served).toEqual([]);
  });

  it('is refused with a wrong secret, and the refusal does not repeat it', async () => {
    const wrong = 'd'.repeat(64);
    const answer = await call('POST', '/v1/backup', { host: `127.0.0.1:${port}`, 'x-fleetadlc-console-secret': wrong }, BACKUP);
    expect(answer.status).toBe(401);
    expect(JSON.stringify(answer.body)).not.toContain(wrong);
    expect(served).toEqual([]);
  });
});

describe('a person route with the console secret', () => {
  it('is served as the person the header names', async () => {
    const answer = await call(
      'POST',
      '/v1/backup',
      { host: `127.0.0.1:${port}`, 'x-fleetadlc-console-secret': CONSOLE_SECRET, 'x-fleetadlc-identity': 'janedoe' },
      BACKUP,
    );
    expect(answer.status).toBe(200);
    expect(served).toEqual([{ path: '/v1/backup', identity: 'janedoe' }]);
  });

  it('is served as the local operator when no name is given', async () => {
    const answer = await call('GET', '/v1/status', { host: `127.0.0.1:${port}`, 'x-fleetadlc-console-secret': CONSOLE_SECRET });
    expect(answer.status).toBe(200);
    expect(served).toEqual([{ path: '/v1/status', identity: 'local operator' }]);
  });

  it('does not take the IAP email header as the name', async () => {
    await call('GET', '/v1/status', {
      host: `127.0.0.1:${port}`,
      'x-fleetadlc-console-secret': CONSOLE_SECRET,
      'x-goog-authenticated-user-email': 'accounts.google.com:attacker@example.com',
    });
    expect(served).toEqual([{ path: '/v1/status', identity: 'local operator' }]);
  });
});

describe('the routes that are not a person’s answer as before', () => {
  it('serves a task its own route with its task token, from a container', async () => {
    const answer = await call(
      'POST',
      '/internal/tasks/task-1/headroom',
      { host: `host.docker.internal:${port}`, [TASK_TOKEN_HEADER]: taskTokenFor('task-1', INTERNAL_SECRET) },
      JSON.stringify({ estimateUsd: 2 }),
    );
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ taskId: 'task-1', estimate: 2, ok: true });
  });

  it('still refuses a task route without a task token', async () => {
    const answer = await call('POST', '/internal/tasks/task-1/headroom', { host: `host.docker.internal:${port}` }, '{}');
    expect(answer.status).toBe(401);
  });

  it('takes a GitHub delivery that carries its signature', async () => {
    const payload = JSON.stringify({ action: 'opened' });
    const signature = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex')}`;
    const answer = await call(
      'POST',
      '/webhooks/github',
      { host: 'hooks.example.com', 'x-github-event': 'issues', 'x-hub-signature-256': signature },
      payload,
    );
    expect(answer.status).toBe(200);
    expect(delivered).toEqual(['issues']);
  });

  it('still refuses a delivery whose signature does not verify', async () => {
    const answer = await call('POST', '/webhooks/github', { host: 'hooks.example.com', 'x-github-event': 'issues', 'x-hub-signature-256': 'sha256=00' }, '{}');
    expect(answer.status).toBe(401);
    expect(delivered).toEqual([]);
  });

  it('answers the health check with no credential at all', async () => {
    const answer = await call('GET', '/healthz', { host: `192.168.1.50:${port}` });
    expect(answer.status).toBe(200);
    expect(answer.body.ok).toBe(true);
  });
});
