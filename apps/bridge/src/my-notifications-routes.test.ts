import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@openadlc/db', () => ({ audit: vi.fn(), people: {}, users: {} }));

import { LOCAL_REFUSAL, registerMyNotificationsRoutes, type MyNotificationsDeps } from './my-notifications-routes.js';
import { memoryNotifyStore, Notifier, PERSONAL_KIND_REFUSAL, PERSONAL_SERVER_REFUSAL } from './notify.js';
import { Router } from './router.js';

/**
 * Your channel: each person reads and writes only their own, found by the
 * email they signed in with, and the target never comes back whole or reaches
 * the audit log.
 */
const TOPIC = 'alice-own-topic-9z8y';

let bridge: Server | null = null;

afterEach(async () => {
  if (bridge) await new Promise<void>((resolve) => bridge?.close(() => resolve()));
  bridge = null;
});

async function start(overrides: Partial<MyNotificationsDeps> = {}) {
  const store = memoryNotifyStore();
  const audited: Record<string, unknown>[] = [];
  const router = new Router();
  registerMyNotificationsRoutes(router, {
    identityMode: 'iap',
    notifier: new Notifier({ notifyWebhook: '', consoleUrl: 'http://127.0.0.1:47300' } as never, store),
    personOf: async (identity) => ({ 'a@example.com': { id: 'p-a' }, 'b@example.com': { id: 'p-b' } })[identity] ?? null,
    audit: async (entry) => {
      audited.push(entry);
    },
    ...overrides,
  });
  bridge = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>((resolve) => bridge?.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, as: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: { 'x-openadlc-identity': as, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { store, audited, call };
}

describe('Your channel', () => {
  it('saves the caller’s own channel, shows it masked, and audits it without the target', async () => {
    const { store, audited, call } = await start();
    const saved = await call('PUT', '/v1/me/notifications', 'a@example.com', { kind: 'ntfy', target: TOPIC });
    expect(saved).toMatchObject({ status: 200, body: { kind: 'ntfy', server: 'https://ntfy.sh', target: '…9z8y' } });
    expect(store.personSecrets).toEqual({ 'p-a': TOPIC });
    expect(JSON.parse(store.settings.personNotify ?? '{}').people['p-a']).toMatchObject({ kind: 'ntfy' });
    expect(audited).toEqual([
      { actor: 'a@example.com', action: 'notify.personal_configured', target: 'person:p-a', payload: { person: 'p-a', kind: 'ntfy', targetChanged: true } },
    ]);
    expect(JSON.stringify(audited)).not.toContain(TOPIC);
    expect((await call('GET', '/v1/me/notifications', 'a@example.com')).body).toMatchObject({ kind: 'ntfy', target: '…9z8y' });
  });

  it('never shows or changes one person’s channel to another', async () => {
    const { store, call } = await start();
    await call('PUT', '/v1/me/notifications', 'a@example.com', { kind: 'ntfy', target: TOPIC });
    expect((await call('GET', '/v1/me/notifications', 'b@example.com')).body).toMatchObject({ kind: null, target: null });
    await call('PUT', '/v1/me/notifications', 'b@example.com', { kind: null });
    expect(store.personSecrets).toEqual({ 'p-a': TOPIC });
  });

  it('refuses on a local install, for someone not in People, and a kind it does not know', async () => {
    const local = await start({ identityMode: 'local' });
    expect(await local.call('GET', '/v1/me/notifications', 'local operator')).toMatchObject({ status: 400, body: { error: LOCAL_REFUSAL } });
    await new Promise<void>((resolve) => bridge?.close(() => resolve()));

    const cloud = await start();
    expect((await cloud.call('GET', '/v1/me/notifications', 'stranger@example.com')).status).toBe(403);
    expect((await cloud.call('PUT', '/v1/me/notifications', 'a@example.com', { kind: 'pager' })).status).toBe(400);
    expect(await cloud.call('PUT', '/v1/me/notifications', 'a@example.com', { kind: 'slack', target: 'https://example.com' })).toMatchObject({
      status: 400,
      body: { error: expect.stringContaining('hooks.slack.com') },
    });
  });

  it('refuses a webhook and an ntfy server of the caller’s own, and saves neither', async () => {
    const { store, audited, call } = await start();
    expect(await call('PUT', '/v1/me/notifications', 'a@example.com', { kind: 'webhook', target: 'http://169.254.169.254/latest' })).toMatchObject({
      status: 400,
      body: { error: PERSONAL_KIND_REFUSAL },
    });
    expect(await call('PUT', '/v1/me/notifications', 'a@example.com', { kind: 'ntfy', target: TOPIC, server: 'http://10.0.0.5' })).toMatchObject({
      status: 400,
      body: { error: PERSONAL_SERVER_REFUSAL },
    });
    expect(store.personSecrets).toEqual({});
    expect(store.settings.personNotify).toBeUndefined();
    expect(audited).toEqual([]);
  });

  it('says there is nothing to test before a channel is saved', async () => {
    const { call } = await start();
    expect((await call('POST', '/v1/me/notifications/test', 'a@example.com')).status).toBe(400);
  });
});
