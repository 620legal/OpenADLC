import { createECDH, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addDevice,
  devicesView,
  forgetDevices,
  MAX_DEVICES,
  memoryPushStore,
  redactEndpoint,
  removeDevice,
  sendToDevice,
  sendToDevices,
  SUBSCRIPTION_UNREADABLE,
  sweepOrphans,
  TOO_MANY_DEVICES,
} from './push-devices.js';

/**
 * A subscription is a credential: whoever holds its endpoint and keys can
 * push to that browser as the install. So it is kept only in the secret
 * store, and nothing the bridge logs, records or answers carries it.
 */

const CONSOLE = { consoleUrl: 'https://openadlc.example.com' };

function browser(endpoint = `https://fcm.googleapis.com/fcm/send/${randomBytes(12).toString('base64url')}`) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}

function answering(...statuses: number[]) {
  let call = 0;
  return vi.fn(async () => new Response(null, { status: statuses[Math.min(call++, statuses.length - 1)] }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('adding a device', () => {
  it('keeps the subscription only in the secret store, and the same browser again keeps its id', async () => {
    const store = memoryPushStore();
    const sub = browser();
    const first = await addDevice(store, 'p1', { subscription: sub, name: 'Mac · Chrome' });
    expect(first.ok).toBe(true);
    const id = first.ok ? first.device.id : '';
    expect(store.secrets[`push-device:p1:${id}`]).toBe(JSON.stringify(sub));
    expect(JSON.stringify(store.rows)).not.toContain(sub.endpoint);
    expect(JSON.stringify(store.rows)).not.toContain(sub.keys.auth);

    const again = await addDevice(store, 'p1', { subscription: { ...sub, keys: browser().keys }, name: 'Mac · Chrome (again)' });
    expect(again.ok && again.device.id).toBe(id);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.name).toBe('Mac · Chrome (again)');
  });

  it('refuses an endpoint off the four push services, with a port, or over http, in words', async () => {
    const store = memoryPushStore();
    for (const endpoint of ['https://169.254.169.254/x', 'https://fcm.googleapis.com:444/x', 'http://fcm.googleapis.com/x']) {
      const added = await addDevice(store, 'p1', { subscription: { ...browser(), endpoint }, name: 'x' });
      expect(added).toEqual({ ok: false, error: expect.stringContaining('use Chrome, Edge, Firefox or Safari') });
    }
    expect(await addDevice(store, 'p1', { subscription: { endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'AA', auth: 'AA' } }, name: 'x' })).toMatchObject({ ok: false });
    expect(store.rows).toEqual([]);
    expect(store.secrets).toEqual({});
  });

  it(`stops at ${MAX_DEVICES} devices a person`, async () => {
    const store = memoryPushStore();
    for (let i = 0; i < MAX_DEVICES; i += 1) expect((await addDevice(store, 'p1', { subscription: browser(), name: `d${i}` })).ok).toBe(true);
    expect(await addDevice(store, 'p1', { subscription: browser(), name: 'one more' })).toEqual({ ok: false, error: TOO_MANY_DEVICES });
    expect((await addDevice(store, 'p2', { subscription: browser(), name: 'someone else' })).ok).toBe(true);
  });

  it('takes the secret out again when the row cannot be written', async () => {
    const store = memoryPushStore();
    store.addRow = async () => {
      throw new Error('database down');
    };
    await expect(addDevice(store, 'p1', { subscription: browser(), name: 'x' })).rejects.toThrow('database down');
    expect(store.secrets).toEqual({});
  });
});

describe('removing devices', () => {
  it('removes only the caller’s own device, row and secret', async () => {
    const store = memoryPushStore();
    const mine = await addDevice(store, 'p1', { subscription: browser(), name: 'mine' });
    const id = mine.ok ? mine.device.id : '';
    expect(await removeDevice(store, 'p2', id)).toBeNull();
    expect(store.rows).toHaveLength(1);
    expect(await removeDevice(store, 'p1', id)).toMatchObject({ id, name: 'mine' });
    expect(store.rows).toEqual([]);
    expect(store.secrets[`push-device:p1:${id}`]).toBeUndefined();
  });

  it('forgets every device of a removed person, and leaves no secret of theirs', async () => {
    const store = memoryPushStore();
    await addDevice(store, 'p1', { subscription: browser(), name: 'a' });
    await addDevice(store, 'p1', { subscription: browser(), name: 'b' });
    await addDevice(store, 'p2', { subscription: browser(), name: 'c' });
    await forgetDevices(store, 'p1');
    expect(Object.keys(store.secrets).filter((ref) => ref.startsWith('push-device:p1:'))).toEqual([]);
    expect(store.rows.map((row) => row.personId)).toEqual(['p2']);
  });

  it('sweeps only the secrets whose device has no row', async () => {
    const store = memoryPushStore();
    const kept = await addDevice(store, 'p1', { subscription: browser(), name: 'a' });
    store.secrets['push-device:p1:orphan'] = '{}';
    store.secrets['push-device:gone:other'] = '{}';
    store.secrets['notify-target:person:p1'] = 'topic';
    expect(await sweepOrphans(store)).toBe(2);
    expect(Object.keys(store.secrets).sort()).toEqual(['notify-target:person:p1', `push-device:p1:${kept.ok ? kept.device.id : ''}`]);
  });
});

describe('sending to devices', () => {
  it('sends to every device of the people at once, each to its own endpoint, never following a redirect', async () => {
    const store = memoryPushStore();
    const a = browser();
    const b = browser('https://web.push.apple.com/QH8-abc');
    await addDevice(store, 'p1', { subscription: a, name: 'a' });
    await addDevice(store, 'p2', { subscription: b, name: 'b' });
    await addDevice(store, 'p3', { subscription: browser(), name: 'not asked' });
    const fetch = answering(201);
    const results = await sendToDevices(store, ['p1', 'p2', 'p1'], { event: 'gate_opened', text: 'q', link: 'l' }, { ...CONSOLE, fetch });
    expect(results.map((one) => one.ok)).toEqual([true, true]);
    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url]) => url).sort()).toEqual([a.endpoint, b.endpoint].sort());
    for (const [, init] of calls) {
      expect(init.redirect).toBe('error');
      expect(init.signal).toBeDefined();
    }
  });

  it.each([410, 404])('drops a device whose push service answers %i, and records it', async (status) => {
    const store = memoryPushStore();
    const added = await addDevice(store, 'p1', { subscription: browser(), name: 'Old phone' });
    const id = added.ok ? added.device.id : '';
    const [result] = await sendToDevices(store, ['p1'], { event: 'gate_opened', text: 'q', link: 'l' }, { ...CONSOLE, fetch: answering(status) });
    expect(result).toMatchObject({ ok: false, status });
    expect(store.rows).toEqual([]);
    expect(store.secrets[`push-device:p1:${id}`]).toBeUndefined();
    expect(store.log.find((event) => event.type === 'notify.device_dropped')?.payload).toEqual({ person: 'p1', device: id, name: 'Old phone', status });
  });

  it('keeps a device whose push service fails some other way', async () => {
    const store = memoryPushStore();
    await addDevice(store, 'p1', { subscription: browser(), name: 'a' });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const [result] = await sendToDevices(store, ['p1'], { event: 'gate_opened', text: 'q', link: 'l' }, { ...CONSOLE, fetch: answering(500) });
    expect(result).toMatchObject({ ok: false, status: 500 });
    expect(store.rows).toHaveLength(1);
    expect(store.log.some((event) => event.type === 'notify.device_dropped')).toBe(false);
  });

  it('drops a device whose secret is gone, since nothing can be sent to it', async () => {
    const store = memoryPushStore();
    const added = await addDevice(store, 'p1', { subscription: browser(), name: 'a' });
    delete store.secrets[`push-device:p1:${added.ok ? added.device.id : ''}`];
    const fetch = answering(201);
    await sendToDevices(store, ['p1'], { event: 'gate_opened', text: 'q', link: 'l' }, { ...CONSOLE, fetch });
    expect(fetch).not.toHaveBeenCalled();
    expect(store.rows).toEqual([]);
  });

  it('keeps a device whose secret cannot be read, and records a failed delivery', async () => {
    const store = memoryPushStore();
    const sub = browser();
    const added = await addDevice(store, 'p1', { subscription: sub, name: 'a' });
    const id = added.ok ? added.device.id : '';
    store.secret = async () => {
      throw new Error('Secret Manager: deadline exceeded');
    };
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetch = answering(201);
    const [result] = await sendToDevices(store, ['p1'], { event: 'gate_opened', text: 'q', link: 'l' }, { ...CONSOLE, fetch });
    expect(result).toMatchObject({ ok: false, status: null, error: SUBSCRIPTION_UNREADABLE });
    expect(fetch).not.toHaveBeenCalled();
    expect(store.rows.map((row) => row.id)).toEqual([id]);
    expect(store.secrets[`push-device:p1:${id}`]).toBe(JSON.stringify(sub));
    expect(store.log.some((event) => event.type === 'notify.device_dropped')).toBe(false);
    expect(store.log.find((event) => event.type === 'notify.delivery')?.payload).toMatchObject({ device: id, ok: false, error: SUBSCRIPTION_UNREADABLE });
  });

  it('drops a device whose secret holds no subscription', async () => {
    const store = memoryPushStore();
    const added = await addDevice(store, 'p1', { subscription: browser(), name: 'a' });
    store.secrets[`push-device:p1:${added.ok ? added.device.id : ''}`] = 'not json';
    await sendToDevices(store, ['p1'], { event: 'gate_opened', text: 'q', link: 'l' }, { ...CONSOLE, fetch: answering(201) });
    expect(store.rows).toEqual([]);
    expect(store.log.some((event) => event.type === 'notify.device_dropped')).toBe(true);
  });

  it('reads the admins and the key once a send, not once a device', async () => {
    const store = memoryPushStore();
    for (const name of ['a', 'b', 'c']) await addDevice(store, 'p1', { subscription: browser(), name });
    const admins = vi.spyOn(store, 'admins');
    await sendToDevices(store, ['p1'], { event: 'gate_opened', text: 'q', link: 'l' }, { ...CONSOLE, fetch: answering(201) });
    expect(admins).toHaveBeenCalledTimes(1);
  });

  it('records each send with the device, never its endpoint or keys', async () => {
    const store = memoryPushStore();
    const sub = browser();
    const added = await addDevice(store, 'p1', { subscription: sub, name: 'a' });
    const device = (await store.devices(['p1']))[0]!;
    await sendToDevice(store, device, { event: 'gate_opened', text: 'q', link: 'l' }, { ...CONSOLE, fetch: answering(201) });
    const [delivery] = store.log.filter((event) => event.type === 'notify.delivery');
    expect(delivery?.payload).toEqual({
      event: 'gate_opened',
      transport: 'push',
      source: 'device',
      person: 'p1',
      device: added.ok ? added.device.id : '',
      setAt: device.addedAt,
      ok: true,
      status: 201,
      error: null,
    });
  });
});

describe('what Settings shows of a person’s devices', () => {
  it('says when none of them took the last notification, and not while one did', async () => {
    const store = memoryPushStore();
    await addDevice(store, 'p1', { subscription: browser(), name: 'a' });
    await addDevice(store, 'p1', { subscription: browser(), name: 'b' });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const message = { event: 'gate_opened', text: 'q', link: 'l' };
    expect((await devicesView(store, 'p1')).allFailing).toBe(false);
    await sendToDevices(store, ['p1'], message, { ...CONSOLE, fetch: answering(500, 201) });
    expect((await devicesView(store, 'p1')).allFailing).toBe(false);
    await sendToDevices(store, ['p1'], message, { ...CONSOLE, fetch: answering(500) });
    const view = await devicesView(store, 'p1');
    expect(view.allFailing).toBe(true);
    expect(view.devices.map((device) => device.last?.status)).toEqual([500, 500]);
    expect(Object.keys(view.devices[0]!).sort()).toEqual(['addedAt', 'id', 'last', 'name']);
  });

  it('lists a device dropped since the newest was added, and forgets it once one is added again', async () => {
    const store = memoryPushStore();
    await addDevice(store, 'p1', { subscription: browser(), name: 'Old phone' });
    await sendToDevices(store, ['p1'], { event: 'gate_opened', text: 'q', link: 'l' }, { ...CONSOLE, fetch: answering(410) });
    const now = new Date(Date.UTC(2026, 10, 11));
    expect((await devicesView(store, 'p1', now)).dropped).toEqual([{ name: 'Old phone', at: expect.any(String), status: 410 }]);
    await addDevice(store, 'p1', { subscription: browser(), name: 'New phone' });
    expect((await devicesView(store, 'p1', now)).dropped).toEqual([]);
  });

  it('gives the install’s public key, the same each time', async () => {
    const store = memoryPushStore();
    const one = await devicesView(store, 'p1');
    expect((await devicesView(store, 'p1')).key).toBe(one.key);
    expect(Buffer.from(one.key, 'base64url')).toHaveLength(65);
  });
});

describe('a subscription never leaves the secret store', () => {
  it('reaches no log, no event and no answer, through add, send, failure, drop, test and remove', async () => {
    const said: string[] = [];
    for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        said.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
      });
    }
    const store = memoryPushStore();
    const sub = browser();
    const answers: unknown[] = [];
    answers.push(await addDevice(store, 'p1', { subscription: sub, name: 'a' }));
    const message = { event: 'gate_opened', text: 'q', link: 'l' };
    // undici names the URL it could not reach, which is the endpoint.
    const failing = vi.fn(async () => {
      throw new TypeError(`fetch failed: connect ECONNREFUSED ${sub.endpoint}`);
    });
    answers.push(await sendToDevices(store, ['p1'], message, { ...CONSOLE, fetch: failing }));
    answers.push(await sendToDevices(store, ['p1'], message, { ...CONSOLE, fetch: answering(500) }));
    answers.push(await devicesView(store, 'p1'));
    answers.push(await sendToDevices(store, ['p1'], message, { ...CONSOLE, fetch: answering(410) }));
    answers.push(await addDevice(store, 'p1', { subscription: sub, name: 'a' }));
    answers.push(await removeDevice(store, 'p1', store.rows[0]!.id));

    const seen = [said.join('\n'), JSON.stringify(store.log), JSON.stringify(store.rows), JSON.stringify(answers)].join('\n');
    const path = new URL(sub.endpoint).pathname;
    for (const secret of [sub.endpoint, path, sub.keys.p256dh, sub.keys.auth]) expect(seen).not.toContain(secret);
    expect(store.log.some((event) => String(event.payload.error ?? '').includes('ECONNREFUSED'))).toBe(true);
  });

  it('takes the endpoint out of an error, whole or by its path', () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc123';
    expect(redactEndpoint(`could not reach ${endpoint}`, endpoint)).toBe('could not reach …');
    expect(redactEndpoint('POST /fcm/send/abc123 refused', endpoint)).toBe('POST … refused');
  });
});
