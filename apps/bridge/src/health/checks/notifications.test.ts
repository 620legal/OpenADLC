import { createECDH, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryNotifyStore, Notifier } from '../../notify.js';
import { addDevice, memoryPushStore } from '../../push-devices.js';
import { INSTALL_THE_APP, NO_ADMIN_PUSH, NONE_GOT_THROUGH, notificationsCheck } from './notifications.js';

/**
 * The check reads the admins' devices and their last push, and never sends:
 * a check that sent its own test every five minutes would buzz a phone all
 * day. With no admin device it is the one notice the upgrade that retired
 * ntfy, Slack and the webhook gives (ADR 0049).
 */
const browserKeys = () => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
};

async function setUp(owners: string[], admins: string[] = ['p-admin']) {
  const push = memoryPushStore({ admins: admins.map((id) => ({ id, email: `${id}@example.com` })) });
  const ids: Record<string, string> = {};
  for (const owner of owners) {
    const added = await addDevice(push, owner, { subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/${owner}`, keys: browserKeys() }, name: owner });
    if (!added.ok) throw new Error(added.error);
    ids[owner] = added.device.id;
  }
  const notifier = new Notifier({ consoleUrl: 'http://127.0.0.1:47300' } as never, memoryNotifyStore({ push }));
  const delivered = async (owner: string, ok: boolean) =>
    push.record('notify.delivery', { event: 'cap_warning', transport: 'push', source: 'device', person: owner, device: ids[owner], ok, status: ok ? 201 : 500, error: null });
  return { push, delivered, check: notificationsCheck(notifier) };
}

const fetchSpy = vi.spyOn(globalThis, 'fetch');
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
});

describe('whether an admin has a device that receives push', () => {
  it('fails while no admin has a device, and says to install the app and turn on notifications', async () => {
    const [result] = await (await setUp([])).check.run(new Date());
    expect(result).toMatchObject({ ok: false, severity: 'warning', title: NO_ADMIN_PUSH, detail: INSTALL_THE_APP, action: { href: '/settings/notifications' } });
    expect(INSTALL_THE_APP).toMatch(/Install the console as an app/);
    expect(INSTALL_THE_APP).toMatch(/Turn on notifications/);
  });

  it('fails when only a user has a device', async () => {
    const [result] = await (await setUp(['p-user'])).check.run(new Date());
    expect(result).toMatchObject({ ok: false, title: NO_ADMIN_PUSH, detail: INSTALL_THE_APP });
  });

  it('fails when the install has no admin at all', async () => {
    const [result] = await (await setUp(['p-user'], [])).check.run(new Date());
    expect(result).toMatchObject({ ok: false, title: NO_ADMIN_PUSH });
  });

  it('passes once an admin has a device that has not been sent anything yet', async () => {
    const [result] = await (await setUp(['p-admin'])).check.run(new Date());
    expect(result).toMatchObject({ ok: true });
  });

  it('fails when the newest push to every admin device failed', async () => {
    const { check, delivered } = await setUp(['p-admin', 'p-admin2'], ['p-admin', 'p-admin2']);
    await delivered('p-admin', true);
    await delivered('p-admin', false);
    await delivered('p-admin2', false);
    const [result] = await check.run(new Date());
    expect(result).toMatchObject({ ok: false, title: NO_ADMIN_PUSH, detail: NONE_GOT_THROUGH });
  });

  it('passes, with its all-clear, while one admin device took its newest push', async () => {
    const { check, delivered } = await setUp(['p-admin', 'p-admin2'], ['p-admin', 'p-admin2']);
    await delivered('p-admin', false);
    await delivered('p-admin2', true);
    const [result] = await check.run(new Date());
    expect(result).toMatchObject({ ok: true, fixed: 'An admin’s device receives push again' });
  });
});
