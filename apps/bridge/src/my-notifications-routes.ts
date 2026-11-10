import { audit, people as peopleStore, users as usersStore } from '@openadlc/db';
import type { IdentityMode } from './identity.js';
import {
  personalNotificationView,
  savePersonalNotification,
  type Notifier,
  type PersonalNotificationInput,
} from './notify.js';
import { HttpFailure, type Router } from './router.js';

/**
 * Your channel, in Settings → Notifications: where the bridge tells one
 * person about the Needs-you items routed to them (ADR 0035). Each route acts
 * only on the caller's own person, found by the email they signed in with,
 * so nobody reads or changes anyone else's. The target is a credential, kept
 * in the secret store and shown masked, as the install's is.
 */

export const LOCAL_REFUSAL = 'A local install has one person: its channel is the install’s, in Settings → Notifications';

export interface MyNotificationsDeps {
  identityMode: IdentityMode;
  notifier: Notifier | null;
  /** The person in People who signed in as this identity, or null. */
  personOf(identity: string): Promise<{ id: string } | null>;
  /** Writes the audit entry of a save: never the target. */
  audit?(entry: { actor: string; action: string; target: string; payload: Record<string, unknown> }): Promise<void>;
}

export function liveMyNotificationsDeps(identityMode: IdentityMode, notifier: Notifier | null): MyNotificationsDeps {
  return {
    identityMode,
    notifier,
    personOf: (identity) => peopleStore.personByEmail(usersStore.normalizeEmail(identity)),
    audit: async (entry) => {
      await audit(entry);
    },
  };
}

// Any string goes on to the save, which refuses a webhook or an unknown kind in words a person can act on.
function kindIn(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  throw new HttpFailure(400, 'kind is ntfy, slack, or null to stop');
}

export function registerMyNotificationsRoutes(router: Router, deps: MyNotificationsDeps): void {
  const mine = async (identity: string): Promise<{ notifier: Notifier; personId: string }> => {
    if (deps.identityMode === 'local') throw new HttpFailure(400, LOCAL_REFUSAL, { code: 'local' });
    if (!deps.notifier) throw new HttpFailure(503, 'this bridge sends no notifications: it was started without a notifier');
    const person = await deps.personOf(identity);
    if (!person) throw new HttpFailure(403, 'You are not a person in People: ask an admin to add you under Settings → People', { code: 'not-a-person' });
    return { notifier: deps.notifier, personId: person.id };
  };

  router.get('/v1/me/notifications', async ({ identity }) => {
    const { notifier, personId } = await mine(identity);
    return personalNotificationView(notifier, personId);
  });

  router.add('PUT', '/v1/me/notifications', async ({ body, identity }) => {
    const { notifier, personId } = await mine(identity);
    const raw = await body<Record<string, unknown> | null>();
    if (!raw || typeof raw !== 'object' || !('kind' in raw)) throw new HttpFailure(400, 'send {kind, target?}; kind null stops your channel');
    const input: PersonalNotificationInput = {
      kind: kindIn(raw.kind),
      ...(typeof raw.server === 'string' ? { server: raw.server } : {}),
      ...(typeof raw.target === 'string' ? { target: raw.target } : {}),
    };
    const saved = await savePersonalNotification(notifier.store, personId, input, identity);
    if (!saved.ok) throw new HttpFailure(400, saved.error);
    await deps.audit?.({
      actor: identity,
      action: 'notify.personal_configured',
      target: `person:${personId}`,
      payload: { person: personId, kind: saved.change.kind, targetChanged: saved.change.targetChanged },
    });
    return personalNotificationView(notifier, personId);
  });

  router.post('/v1/me/notifications/test', async ({ identity }) => {
    const { notifier, personId } = await mine(identity);
    const result = await notifier.testPerson(personId);
    if (!result) throw new HttpFailure(400, 'Nothing to test: choose where to notify you first');
    return result;
  });
}
