import { createECDH, randomBytes } from 'node:crypto';
import { settings } from '@openadlc/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addDevice, memoryPushStore } from './push-devices.js';
import {
  isNotifiable,
  itemLink,
  memoryNotifyStore,
  NOTIFIABLE,
  NOTIFY_SWITCHES,
  notificationSettingsView,
  Notifier,
  RETIRED_CHANNEL_REFUSAL,
  RETIRED_SETTING_KEYS,
  retireOldChannels,
  saveNotificationSettings,
} from './notify.js';

/**
 * A few things are worth interrupting someone for and, just as deliberately,
 * nothing else. That second half is the part worth pinning: a
 * platform that notifies on everything is one whose notifications are ignored,
 * including the ones that mattered. A failing health check is sent once and
 * again a day later, and its all-clear to whoever was told; a pull request
 * waiting on a person and a review that stopped are read from Needs you.
 *
 * Each goes as push to the console app and nowhere else (ADR 0049).
 */
const CONFIG = { consoleUrl: 'http://127.0.0.1:47300' } as never;

function answering(status: number) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status }));
}

const browserKeys = () => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
};

async function withDevices(owners: string[], admins: string[]) {
  const push = memoryPushStore({ admins: admins.map((id) => ({ id, email: `${id}@example.com` })) });
  for (const owner of owners) {
    const added = await addDevice(push, owner, { subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/${owner}-secret`, keys: browserKeys() }, name: owner });
    expect(added.ok).toBe(true);
  }
  return push;
}

const pushedTo = (spy: ReturnType<typeof answering>) =>
  spy.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.startsWith('https://fcm.googleapis.com/'))
    .map((url) => url.split('/').at(-1)!.replace(/-secret$/, ''))
    .sort();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('only a few things are worth a notification', () => {
  it('is a gate, the spending warning, a waiting promote or merge, a stopped review, and a check a person has to act on', () => {
    expect([...NOTIFIABLE].sort()).toEqual([
      'cap_warning',
      'check_failing',
      'check_fixed',
      'gate_opened',
      'merge_waiting',
      'promote_waiting',
      'review_stalled',
    ]);
  });

  it('refuses anything else, rather than quietly sending it', () => {
    expect(isNotifiable('task_started')).toBe(false);
    expect(isNotifiable('pr_opened')).toBe(false);
    expect(isNotifiable('gate_answered')).toBe(false);
  });

  it('will not send an event it does not recognise even when asked directly', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const push = await withDevices(['p-admin'], ['p-admin']);
    const notifier = new Notifier(CONFIG, memoryNotifyStore({ push }));

    const outcome = await notifier.send({ event: 'gate_answered' as never, to: 'janedoe', text: 'answered', link: 'http://127.0.0.1:47300/' });

    expect(outcome).toBe('refused');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('an install with no device carries on', () => {
  it('logs the intent rather than failing', async () => {
    const notifier = new Notifier(CONFIG, memoryNotifyStore({ push: memoryPushStore() }));
    const outcome = await notifier.send({ event: 'gate_opened', to: 'janedoe', text: 'waiting on an answer', link: 'http://127.0.0.1:47300/?bot=mira' });

    // Logged, not sent and not refused: the path stays exercised in development
    // rather than lying dormant until the day somebody turns on a device.
    expect(outcome).toBe('logged');
  });

  it('does not fail the caller when the push service is down', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));
    const push = await withDevices(['p-admin'], ['p-admin']);
    const notifier = new Notifier(CONFIG, memoryNotifyStore({ push }));

    // The gate is already on GitHub and on the board. A push service that is
    // down must not take the platform with it.
    await expect(notifier.send({ event: 'gate_opened', to: null, text: 'x', link: 'y' })).resolves.toBe('logged');
  });
});

describe('push to the console app is the only channel (ADR 0049)', () => {
  it('sends a routed item to its people’s devices, and calls nothing but their push services', async () => {
    const spy = answering(201);
    const push = await withDevices(['p-a', 'p-b', 'p-admin'], ['p-admin']);
    const store = memoryNotifyStore({ push });
    await expect(new Notifier(CONFIG, store).send({ event: 'gate_opened', to: null, text: 'q', link: 'l', people: ['p-a'] })).resolves.toBe('sent');
    expect(pushedTo(spy)).toEqual(['p-a']);
    expect(spy.mock.calls.every((call) => String(call[0]).startsWith('https://fcm.googleapis.com/'))).toBe(true);
    expect(push.log.filter((event) => event.type === 'notify.delivery').map((event) => event.payload)).toEqual([
      expect.objectContaining({ transport: 'push', source: 'device', person: 'p-a', ok: true, status: 201 }),
    ]);
  });

  it('sends an item for everyone to every admin’s devices and to no user’s, and calls nothing else', async () => {
    const spy = answering(201);
    const push = await withDevices(['p-a', 'p-admin', 'p-admin2'], ['p-admin', 'p-admin2']);
    await expect(new Notifier(CONFIG, memoryNotifyStore({ push })).send({ event: 'cap_warning', to: null, text: 'spend', link: 'l' })).resolves.toBe('sent');
    expect(pushedTo(spy)).toEqual(['p-admin', 'p-admin2']);
    expect(spy.mock.calls.every((call) => String(call[0]).startsWith('https://fcm.googleapis.com/'))).toBe(true);
  });

  it('ignores OPENADLC_NOTIFY_WEBHOOK: an item for everyone goes only to admins’ devices', async () => {
    vi.stubEnv('OPENADLC_NOTIFY_WEBHOOK', 'https://hooks.example.invalid/x');
    const spy = answering(201);
    const push = await withDevices(['p-admin'], ['p-admin']);
    await expect(new Notifier(CONFIG, memoryNotifyStore({ push })).send({ event: 'check_failing', to: null, text: 'x', link: 'l' })).resolves.toBe('sent');
    expect(spy.mock.calls.map((call) => String(call[0]))).not.toContain('https://hooks.example.invalid/x');
    expect(pushedTo(spy)).toEqual(['p-admin']);
  });

  it('logs a routed item whose people have no device, and does not send it to admins instead', async () => {
    const spy = answering(201);
    const push = await withDevices(['p-admin'], ['p-admin']);
    await expect(new Notifier(CONFIG, memoryNotifyStore({ push })).send({ event: 'gate_opened', to: null, text: 'q', link: 'l', people: ['p-a'] })).resolves.toBe('logged');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('each kind can be switched off', () => {
  it('lists a switch for each kind, a failing check and its all-clear as one', () => {
    expect([...NOTIFY_SWITCHES].sort()).toEqual(['cap_warning', 'check_failing', 'gate_opened', 'merge_waiting', 'promote_waiting', 'review_stalled']);
  });

  it('does not send a kind that is off to any device, and records that it was', async () => {
    const spy = answering(201);
    const push = await withDevices(['p-a', 'p-admin'], ['p-admin']);
    const store = memoryNotifyStore({ settings: { notifyKinds: JSON.stringify({ gate_opened: false, cap_warning: false }) }, push });
    const notifier = new Notifier(CONFIG, store);
    await expect(notifier.send({ event: 'gate_opened', to: null, text: 'q', link: 'l', people: ['p-a'] })).resolves.toBe('off');
    await expect(notifier.send({ event: 'cap_warning', to: null, text: 'q', link: 'l' })).resolves.toBe('off');
    expect(spy).not.toHaveBeenCalled();
    expect(store.events.map((event) => event.payload.off)).toEqual([true, true]);
  });

  it('holds back a check’s all-clear with its failure', async () => {
    const spy = answering(201);
    const push = await withDevices(['p-admin'], ['p-admin']);
    const notifier = new Notifier(CONFIG, memoryNotifyStore({ settings: { notifyKinds: JSON.stringify({ check_failing: false }) }, push }));
    await expect(notifier.send({ event: 'check_fixed', to: null, text: 'x', link: 'y' })).resolves.toBe('off');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('Settings → Notifications keeps the switches and nothing else', () => {
  it('shows only the switches', async () => {
    const notifier = new Notifier(CONFIG, memoryNotifyStore({ settings: { notifyKinds: JSON.stringify({ cap_warning: false }) } }));
    const view = await notificationSettingsView(notifier);
    expect(Object.keys(view)).toEqual(['switches']);
    expect(view.switches.cap_warning).toBe(false);
    expect(view.switches.gate_opened).toBe(true);
  });

  it('saves the switches, and says what changed', async () => {
    const store = memoryNotifyStore();
    const saved = await saveNotificationSettings(store, { switches: { cap_warning: false } }, 'janedoe');
    expect(saved).toEqual({ ok: true, change: { switches: expect.objectContaining({ cap_warning: false, gate_opened: true }) } });
    expect(store.settings.notifyKinds).toBe(JSON.stringify({ cap_warning: false }));
  });

  it('refuses a body that still names a channel, in words, and writes nothing', async () => {
    for (const body of [{ kind: 'ntfy' }, { server: 'https://ntfy.sh' }, { target: 'https://hooks.slack.com/x', switches: { cap_warning: false } }]) {
      const store = memoryNotifyStore();
      await expect(saveNotificationSettings(store, body as never, 'janedoe')).resolves.toEqual({ ok: false, error: RETIRED_CHANNEL_REFUSAL });
      expect(store.settings).toEqual({});
    }
  });

  it('refuses a kind it does not know', async () => {
    await expect(saveNotificationSettings(memoryNotifyStore(), { switches: { nope: true } as never }, 'janedoe')).resolves.toMatchObject({ ok: false });
  });
});

describe('the retired channels’ settings', () => {
  it('are no setting any more, so PATCH and a restore never write one', () => {
    for (const key of RETIRED_SETTING_KEYS) expect(settings.isSettingKey(key), key).toBe(false);
    expect(settings.isSettingKey('notifyKinds')).toBe(true);
  });
});

describe('the retired channels’ targets', () => {
  const secretStore = (refs: Record<string, string>) => ({
    refs: { ...refs },
    async list(prefix?: string) {
      return Object.keys(this.refs).filter((ref) => !prefix || ref.startsWith(prefix));
    },
    async delete(ref: string) {
      delete this.refs[ref];
    },
  });

  it('are deleted at start, the install’s and each person’s, and nothing beside them; a second start deletes none', async () => {
    const secrets = secretStore({
      'notify-target': 'zzz-topic-zzz',
      'notify-target:person:p1': 'https://hooks.slack.com/services/zzz1',
      'notify-target:person:p2': 'zzz-p2-topic-zzz',
      'push-vapid-key': 'zzz-vapid-zzz',
    });
    const recorded: { type: string; payload: Record<string, unknown> }[] = [];
    const record = async (type: string, payload: Record<string, unknown>) => void recorded.push({ type, payload });

    await expect(retireOldChannels(secrets, record)).resolves.toBe(3);
    expect(Object.keys(secrets.refs)).toEqual(['push-vapid-key']);
    expect(recorded).toEqual([{ type: 'notify.channels_retired', payload: { count: 3 } }]);
    expect(JSON.stringify(recorded)).not.toContain('zzz');

    await expect(retireOldChannels(secrets, record)).resolves.toBe(0);
    expect(recorded).toHaveLength(1);
  });
});

describe('a link about a piece of work opens its item', () => {
  it('names the subject, which any member of the item resolves from', () => {
    // A question about a request opened the intake bot's panel, with every
    // other request intake had worked on in it. Each request is its own conversation.
    expect(itemLink('http://127.0.0.1:47300/', 'openadlc#12')).toBe('http://127.0.0.1:47300/?item=openadlc%2312');
    expect(itemLink('http://127.0.0.1:47300', 'request:a4b02784')).toBe('http://127.0.0.1:47300/?item=request%3Aa4b02784');
  });
});

describe('whether an admin can be reached, as the health check reads it', () => {
  it('counts the admins’ devices, and not a user’s', async () => {
    const push = await withDevices(['p-a', 'p-admin'], ['p-admin']);
    await expect(new Notifier(CONFIG, memoryNotifyStore({ push })).adminPush()).resolves.toEqual({ admins: 1, devices: 1, receiving: 1 });
  });

  it('counts a device whose newest push failed as not receiving', async () => {
    answering(500);
    const push = await withDevices(['p-admin'], ['p-admin']);
    const notifier = new Notifier(CONFIG, memoryNotifyStore({ push }));
    await notifier.send({ event: 'cap_warning', to: null, text: 'x', link: 'l' });
    await expect(notifier.adminPush()).resolves.toEqual({ admins: 1, devices: 1, receiving: 0 });
  });
});
