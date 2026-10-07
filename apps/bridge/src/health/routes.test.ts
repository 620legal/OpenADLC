import type { HealthRow } from '@fleetadlc/db';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Router } from '../router.js';
import { HealthRegistry, type HealthStore } from './registry.js';
import { registerHealthRoutes } from './routes.js';
import type { CheckResult, HealthCheck } from './types.js';

/**
 * "Check again" on a health card: one check asked now, by the person who has
 * just fixed what it said, rather than on its own schedule.
 */

function memory(): HealthStore {
  const rows = new Map<string, HealthRow>();
  return {
    list: async () => [...rows.values()],
    save: async (row) => void rows.set(row.id, row),
    remove: async (ids) => {
      for (const id of ids) rows.delete(id);
    },
    dismiss: async () => false,
  };
}

function scripted(id: string, answer: CheckResult[]): HealthCheck & { runs: number } {
  const check = {
    id,
    proves: `${id} works`,
    how: 'by asking',
    everyMinutes: 10,
    steps: [] as const,
    runs: 0,
    async run() {
      check.runs += 1;
      return answer;
    },
  };
  return check;
}

let server: Server;
let url: string;
let permissions: ReturnType<typeof scripted>;
let webhook: ReturnType<typeof scripted>;
let unsigned: ReturnType<typeof scripted>;
let acknowledged: [string, string, string, readonly string[]][];
let audited: { action: string; target: string }[];

beforeEach(async () => {
  permissions = scripted('app-permissions', [
    {
      ok: false,
      severity: 'blocking',
      title: 'The OpenADLC app does not have “Deployments”',
      detail: 'Add it.',
      action: { label: 'Open the app’s permissions', url: 'https://github.com/settings/apps/fleetadlc-janedoe/permissions' },
    },
  ]);
  webhook = scripted('webhook', [{ ok: true }]);
  unsigned = scripted('unattributed-post', [
    {
      ok: false,
      severity: 'warning',
      title: 'A post by irisexampleco in janedoe/api is not signed by OpenADLC',
      detail: 'The latest, a comment: it has no signature.',
      action: { label: 'Open the post', url: 'https://github.com/janedoe/api/issues/3#issuecomment-1' },
      facts: { occurrence: 'post:41', occurrences: ['post:41', 'post:40'] },
    },
  ]);
  acknowledged = [];
  audited = [];
  const registry = new HealthRegistry({
    checks: [permissions, webhook, unsigned],
    store: memory(),
    consoleUrl: 'http://127.0.0.1:47300',
    log: () => undefined,
  });
  const router = new Router();
  registerHealthRoutes(router, registry, {
    acknowledge: async (id, occurrence, by, covers) => void acknowledged.push([id, occurrence, by, covers]),
    audit: async (entry) => void audited.push(entry),
  });
  server = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('asking one health check again', () => {
  it('runs that check alone, now, and answers with what the checks say afterwards', async () => {
    const response = await fetch(`${url}/v1/health/checks/app-permissions/run`, { method: 'POST' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { checks: unknown[] };

    expect(permissions.runs).toBe(1);
    expect(webhook.runs).toBe(0);
    expect(JSON.stringify(body.checks)).toContain('The OpenADLC app does not have “Deployments”');
  });

  it('refuses a check that does not exist, rather than running every one', async () => {
    const response = await fetch(`${url}/v1/health/checks/no-such-check/run`, { method: 'POST' });
    expect(response.status).toBe(404);
    expect(permissions.runs).toBe(0);
    expect(webhook.runs).toBe(0);
  });
});

describe('dismissing a notice with nothing to fix', () => {
  const acknowledge = (id: string, body: unknown) =>
    fetch(`${url}/v1/health/${id}/acknowledge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  beforeEach(async () => {
    await fetch(`${url}/v1/health/run`, { method: 'POST' });
  });

  it('keeps the occurrence the card showed, by who, and audits it', async () => {
    const response = await acknowledge('unattributed-post', { occurrence: 'post:41' });
    expect(response.status).toBe(200);
    // Every post the card was showing, not only the one it led with.
    expect(acknowledged).toEqual([['unattributed-post', 'post:41', expect.any(String), ['post:41', 'post:40']]]);
    expect(audited).toMatchObject([{ action: 'notice.acknowledged', target: 'unattributed-post' }]);
  });

  it('covers only the occurrence named when the card has moved on since it was shown', async () => {
    const response = await acknowledge('unattributed-post', { occurrence: 'post:39' });
    expect(response.status).toBe(200);
    expect(acknowledged).toEqual([['unattributed-post', 'post:39', expect.any(String), ['post:39']]]);
  });

  it('refuses a card that has something to fix, and one with no occurrence named', async () => {
    const fixable = await acknowledge('app-permissions', { occurrence: 'x' });
    expect(fixable.status).toBe(409);
    const unnamed = await acknowledge('unattributed-post', {});
    expect(unnamed.status).toBe(400);
    expect(acknowledged).toEqual([]);
  });
});
