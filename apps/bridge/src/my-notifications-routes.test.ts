import { createECDH, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@openadlc/db', () => ({ audit: vi.fn(), people: {}, users: {} }));

import { liveMyNotificationsDeps, registerMyNotificationsRoutes, type MyNotificationsDeps } from './my-notifications-routes.js';
import { memoryNotifyStore, Notifier, RETIRED_CHANNEL_REFUSAL } from './notify.js';
import { memoryPushStore } from './push-devices.js';
import { Router } from './router.js';

/**
 * A person's own devices: each person reads and writes only their own, found
 * by the email they signed in with, and the subscription never comes back or
 * reaches the audit log. Their own ntfy or Slack channel is retired (ADR 0049).
 */

let bridge: Server | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  if (bridge) await new Promise<void>((resolve) => bridge?.close(() => resolve()));
  bridge = null;
});

async function start(overrides: Partial<MyNotificationsDeps> = {}) {
  const store = memoryNotifyStore();
  const audited: Record<string, unknown>[] = [];
  const router = new Router();
  registerMyNotificationsRoutes(router, {
    identityMode: 'iap',
    notifier: new Notifier({ consoleUrl: 'http://127.0.0.1:47300' } as never, store),
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

describe('Your channel, retired (ADR 0049)', () => {
  it('answers each of its routes 410 with what to do instead, and reads and writes nothing', async () => {
    const { store, audited, call } = await start();
    for (const [method, path, body] of [
      ['GET', '/v1/me/notifications', undefined],
      ['PUT', '/v1/me/notifications', { kind: 'ntfy', target: 'alice-own-topic-9z8y' }],
      ['POST', '/v1/me/notifications/test', undefined],
    ] as const) {
      expect(await call(method, path, 'a@example.com', body)).toMatchObject({ status: 410, body: { error: RETIRED_CHANNEL_REFUSAL, code: 'retired' } });
    }
    expect(store.settings).toEqual({});
    expect(store.events).toEqual([]);
    expect(audited).toEqual([]);
  });
});

describe('this device: push to each device a person turned notifications on in', () => {
  const browser = () => {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    return {
      endpoint: `https://fcm.googleapis.com/fcm/send/${randomBytes(12).toString('base64url')}`,
      keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
    };
  };

  async function withPush(overrides: Partial<MyNotificationsDeps> = {}) {
    const push = memoryPushStore();
    const store = memoryNotifyStore({ push });
    const started = await start({
      notifier: new Notifier({ consoleUrl: 'https://openadlc.example.com' } as never, store),
      ...overrides,
    });
    // The push service, and only it: the test's own calls reach the bridge.
    const real = globalThis.fetch;
    const pushed: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith('http://127.0.0.1')) return real(input, init);
      pushed.push(url);
      return new Response(null, { status: url.includes('gone') ? 410 : 201 });
    });
    return { ...started, push, pushed };
  }

  it('adds the caller’s device, lists it by name and date, sends it a test and removes it, auditing no subscription', async () => {
    const { call, push, audited, pushed } = await withPush();
    const sub = browser();
    const added = await call('POST', '/v1/me/push/devices', 'a@example.com', { subscription: sub, name: 'iPhone · Safari' });
    expect(added.status).toBe(200);
    expect(Object.keys(added.body).sort()).toEqual(['addedAt', 'id', 'name']);
    const id = String(added.body.id);

    const listed = await call('GET', '/v1/me/push', 'a@example.com');
    expect(listed.body).toMatchObject({ devices: [{ id, name: 'iPhone · Safari', last: null }], allFailing: false, dropped: [] });
    expect(typeof listed.body.key).toBe('string');
    expect((await call('GET', '/v1/me/push', 'b@example.com')).body.devices).toEqual([]);

    expect(await call('POST', `/v1/me/push/devices/${id}/test`, 'a@example.com')).toMatchObject({ status: 200, body: { ok: true, status: 201 } });
    expect(pushed).toEqual([sub.endpoint]);
    expect((await call('POST', `/v1/me/push/devices/${id}/test`, 'b@example.com')).status).toBe(404);
    expect((await call('DELETE', `/v1/me/push/devices/${id}`, 'b@example.com')).status).toBe(404);
    expect(await call('DELETE', `/v1/me/push/devices/${id}`, 'a@example.com')).toMatchObject({ status: 200, body: { removed: id } });
    expect(push.rows).toEqual([]);
    expect(push.secrets[`push-device:p-a:${id}`]).toBeUndefined();

    expect(audited.map((entry) => entry.action)).toEqual(['notify.device_added', 'notify.device_removed']);
    expect(audited[0]).toEqual({
      actor: 'a@example.com',
      action: 'notify.device_added',
      target: 'person:p-a',
      payload: { person: 'p-a', device: id, name: 'iPhone · Safari', service: 'fcm.googleapis.com' },
    });
    const seen = JSON.stringify([audited, push.log, listed.body]);
    for (const secret of [sub.endpoint, new URL(sub.endpoint).pathname, sub.keys.p256dh, sub.keys.auth]) expect(seen).not.toContain(secret);
  });

  it('runs the notifications check again when a device is added or removed, so its card clears at once', async () => {
    const devicesChanged = vi.fn();
    const { call } = await withPush({ devicesChanged });
    const added = await call('POST', '/v1/me/push/devices', 'a@example.com', { subscription: browser(), name: 'Mac · Chrome' });
    expect(devicesChanged).toHaveBeenCalledTimes(1);
    await call('DELETE', `/v1/me/push/devices/${String(added.body.id)}`, 'a@example.com');
    expect(devicesChanged).toHaveBeenCalledTimes(2);
    await call('POST', '/v1/me/push/devices', 'a@example.com', { subscription: { ...browser(), endpoint: 'https://10.0.0.5/x' }, name: 'x' });
    expect(devicesChanged).toHaveBeenCalledTimes(2);
  });

  it('refuses an endpoint that is not a push service, and says so', async () => {
    const { call, push, audited } = await withPush();
    const refused = await call('POST', '/v1/me/push/devices', 'a@example.com', { subscription: { ...browser(), endpoint: 'https://10.0.0.5/x' }, name: 'x' });
    expect(refused).toMatchObject({ status: 400, body: { error: expect.stringContaining('use Chrome, Edge, Firefox or Safari') } });
    expect(push.rows).toEqual([]);
    expect(audited).toEqual([]);
  });

  it('takes a local install’s devices as the operator’s', async () => {
    const { call, push } = await withPush({ identityMode: 'local', operator: async () => ({ id: 'p-operator' }) });
    expect((await call('POST', '/v1/me/push/devices', 'local', { subscription: browser(), name: 'Mac · Chrome' })).status).toBe(200);
    expect(push.rows.map((row) => row.personId)).toEqual(['p-operator']);
  });

  it('answers someone not in People with how to be added', async () => {
    const { call } = await withPush();
    expect(await call('GET', '/v1/me/push', 'stranger@example.com')).toMatchObject({ status: 403, body: { code: 'not-a-person' } });
  });

  it('hands nothing that holds a subscription a GitHub client', async () => {
    const { push } = await withPush();
    const deps = liveMyNotificationsDeps('iap', new Notifier({ consoleUrl: 'x' } as never, memoryNotifyStore({ push })));
    const names = (value: object) => Object.keys(value).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(value)));
    for (const holder of [deps, push]) expect(names(holder).join(' ')).not.toMatch(/github|octokit|client/i);
  });
});
