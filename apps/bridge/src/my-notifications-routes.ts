import { audit, people as peopleStore, users as usersStore } from '@openadlc/db';
import type { IdentityMode } from './identity.js';
import { RETIRED_CHANNEL_REFUSAL, type Notifier } from './notify.js';
import { addDevice, devicesView, removeDevice, type PushStore } from './push-devices.js';
import { HttpFailure, type Router } from './router.js';

/**
 * A person's own devices, in Settings → Notifications: where the bridge
 * pushes the Needs-you items routed to them (ADR 0048), and, for an admin,
 * the ones for everyone. Each route acts only on the caller's own person,
 * found by the email they signed in with, so nobody reads or changes anyone
 * else's.
 *
 * Their own ntfy or Slack channel, `/v1/me/notifications`, is retired (ADR
 * 0049): its routes stay, read and write nothing, and say what to do instead.
 */

export interface MyNotificationsDeps {
  identityMode: IdentityMode;
  notifier: Notifier | null;
  /** The person in People who signed in as this identity, or null. */
  personOf(identity: string): Promise<{ id: string } | null>;
  /** On a local install every identity is the operator, whose devices these are. */
  operator?(): Promise<{ id: string } | null>;
  /** Writes the audit entry of a save: never the subscription. */
  audit?(entry: { actor: string; action: string; target: string; payload: Record<string, unknown> }): Promise<void>;
  /** A device was added or removed: the `notifications` check reads whether an admin has one now, not in five minutes. */
  devicesChanged?(): void;
}

export function liveMyNotificationsDeps(identityMode: IdentityMode, notifier: Notifier | null, devicesChanged?: () => void): MyNotificationsDeps {
  return {
    identityMode,
    notifier,
    ...(devicesChanged ? { devicesChanged } : {}),
    personOf: (identity) => peopleStore.personByEmail(usersStore.normalizeEmail(identity)),
    operator: () => peopleStore.operator(),
    audit: async (entry) => {
      await audit(entry);
    },
  };
}

export function registerMyNotificationsRoutes(router: Router, deps: MyNotificationsDeps): void {
  const retired = async (): Promise<never> => {
    throw new HttpFailure(410, RETIRED_CHANNEL_REFUSAL, { code: 'retired' });
  };
  router.get('/v1/me/notifications', retired);
  router.add('PUT', '/v1/me/notifications', retired);
  router.post('/v1/me/notifications/test', retired);

  // ---------------------------------------------------------------- this device (ADR 0048)
  //
  // Push to each device the person turned notifications on in. A local
  // install has these too: its one person is the operator,
  // and the computer the console runs on can take push over 127.0.0.1. The
  // subscription goes to the secret store; only the device's name, when it
  // was added and its push service's host come back or reach the audit log.
  const myDevices = async (identity: string): Promise<{ notifier: Notifier; push: PushStore; personId: string }> => {
    if (!deps.notifier?.push) throw new HttpFailure(503, 'this bridge sends no notifications: it was started without a notifier');
    const person = deps.identityMode === 'local' ? await (deps.operator ?? (async () => null))() : await deps.personOf(identity);
    if (!person) throw new HttpFailure(403, 'You are not a person in People: ask an admin to add you under Settings → People', { code: 'not-a-person' });
    return { notifier: deps.notifier, push: deps.notifier.push, personId: person.id };
  };

  router.get('/v1/me/push', async ({ identity }) => {
    const { push, personId } = await myDevices(identity);
    return devicesView(push, personId);
  });

  router.post('/v1/me/push/devices', async ({ body, identity }) => {
    const { push, personId } = await myDevices(identity);
    const raw = await body<Record<string, unknown> | null>();
    if (!raw || typeof raw !== 'object') throw new HttpFailure(400, 'send {subscription: {endpoint, keys: {p256dh, auth}}, name}');
    const added = await addDevice(push, personId, { subscription: raw.subscription, name: raw.name });
    if (!added.ok) throw new HttpFailure(400, added.error);
    await deps.audit?.({
      actor: identity,
      action: 'notify.device_added',
      target: `person:${personId}`,
      payload: { person: personId, device: added.device.id, name: added.device.name, service: added.service },
    });
    deps.devicesChanged?.();
    return added.device;
  });

  router.add('DELETE', '/v1/me/push/devices/:id', async ({ params, identity }) => {
    const { push, personId } = await myDevices(identity);
    const removed = await removeDevice(push, personId, params.id ?? '');
    if (!removed) throw new HttpFailure(404, 'You have no device by that id: it may have been removed already');
    await deps.audit?.({
      actor: identity,
      action: 'notify.device_removed',
      target: `person:${personId}`,
      payload: { person: personId, device: removed.id, name: removed.name, service: removed.service },
    });
    deps.devicesChanged?.();
    return { removed: removed.id };
  });

  // Every one of the caller's devices at once, through the path a real
  // notification takes; never anyone else's, since the person is the caller's.
  router.post('/v1/me/push/test', async ({ identity }) => {
    const { notifier, personId } = await myDevices(identity);
    return notifier.testDevices(personId);
  });

  router.post('/v1/me/push/devices/:id/test', async ({ params, identity }) => {
    const { notifier, personId } = await myDevices(identity);
    const result = await notifier.testDevice(personId, params.id ?? '');
    if (!result) throw new HttpFailure(404, 'You have no device by that id: turn notifications on there again');
    return result;
  });
}
