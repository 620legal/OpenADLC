import type { Notifier } from '../../notify.js';
import type { CheckResult, HealthCheck } from '../types.js';

export type NotificationsReader = Pick<Notifier, 'adminPush'>;

export const NOTIFICATIONS_CHECK = 'notifications';

const ACTION = { label: 'Open Settings → Notifications', href: '/settings/notifications' };

export const NO_ADMIN_PUSH = 'No admin has a device that receives push';

export const INSTALL_THE_APP =
  'ntfy, Slack and the webhook are retired: OpenADLC notifies only as push to the console app. Install the console as an app (on a phone, Share → Add to Home Screen; on a computer, the browser’s Install button), open it, and press Turn on notifications on this device in Settings → Notifications.';

export const NONE_GOT_THROUGH =
  'The last notification to each admin’s device did not get through. Press Send a test beside a device, or turn notifications on again there.';

/**
 * An unrouted notification — a gate for everyone, the spend warning, a check
 * that stopped work — reaches an admin, as push to the console app (ADR 0049).
 *
 * It passes while an admin has a device whose newest push got through, or that
 * has not been sent one yet. With none, it is the notice the upgrade that
 * retired ntfy, Slack and the webhook gives admins, once: their old channel is
 * gone, so it cannot be a notification. It clears itself when one turns
 * notifications on.
 *
 * A warning, never blocking, and it sends nothing: the registry sends a
 * lasting blocking failure through the notifier, which would be "nobody gets
 * notifications" pushed to nobody, and a check that sent its own test would
 * buzz a phone every five minutes.
 */
export function notificationsCheck(reader: NotificationsReader): HealthCheck {
  return {
    id: NOTIFICATIONS_CHECK,
    proves: 'An admin has a device that receives push',
    how: 'reads the admins’ devices and whether the newest push to each got through; sends nothing itself',
    everyMinutes: 5,
    steps: [],
    async run(): Promise<CheckResult[]> {
      const { devices, receiving } = await reader.adminPush();
      if (devices === 0) return [{ ok: false, severity: 'warning', title: NO_ADMIN_PUSH, detail: INSTALL_THE_APP, action: ACTION }];
      if (receiving === 0) return [{ ok: false, severity: 'warning', title: NO_ADMIN_PUSH, detail: NONE_GOT_THROUGH, action: ACTION, facts: { devices } }];
      return [{ ok: true, fixed: 'An admin’s device receives push again', facts: { devices, receiving } }];
    },
  };
}
