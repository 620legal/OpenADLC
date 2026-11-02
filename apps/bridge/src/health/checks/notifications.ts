import type { DeliveryRecord, Transport, TransportKind } from '../../notify.js';
import type { CheckResult, HealthCheck } from '../types.js';

export interface NotificationsReader {
  /** Where notifications go now, as the notifier resolves it; null for nowhere. */
  transport(): Promise<Transport | null>;
  /** The newest delivery that counts for it (`Notifier.lastDelivery`). */
  lastDelivery(transport: Transport): Promise<DeliveryRecord | null>;
}

export const NOTIFICATIONS_CHECK = 'notifications';

const ACTION = { label: 'Open Settings → Notifications', href: '/settings/notifications' };

const WHERE: Record<TransportKind, string> = { ntfy: 'ntfy', slack: 'Slack', webhook: 'your webhook' };

/**
 * Notifications reach the person who set them up, proved by the last send.
 *
 * Nothing proved a transport worked: an `OPENADLC_NOTIFY_WEBHOOK` that
 * answered 404 failed every notification into a log line nobody read. A check
 * that sent its own test would buzz a phone every few minutes, so this one
 * sends nothing: it reads the newest `notify.delivery` since the transport was
 * set — Send a test, or a real notification — and passes while it got
 * through.
 *
 * A warning, never blocking: the registry sends a lasting blocking failure
 * through the notifier, which would be "notifications are broken" posted to
 * the transport that is broken. With nothing set, notifications are optional
 * and it passes; with only the environment's webhook and nothing sent yet it
 * has no answer, since a card after every restart would be noise.
 */
export function notificationsCheck(reader: NotificationsReader): HealthCheck {
  return {
    id: NOTIFICATIONS_CHECK,
    proves: 'Notifications reach the person who set them up',
    how: 'reads whether the most recent notification or test since the transport was set reached it; sends nothing itself',
    everyMinutes: 5,
    steps: [],
    async run(): Promise<CheckResult[]> {
      const transport = await reader.transport();
      if (!transport) return [{ ok: true, says: 'No notifications are set up' }];
      const last = await reader.lastDelivery(transport);
      if (!last) {
        if (transport.source === 'env') return [{ ok: null, reason: 'nothing has been sent through OPENADLC_NOTIFY_WEBHOOK since the bridge started keeping a record' }];
        return [
          {
            ok: false,
            severity: 'warning',
            title: 'Notifications are set up but have not been proved',
            detail: `Press Send a test to make sure ${WHERE[transport.kind]} gets them. Until a send gets through, nothing says a question or a waiting merge will reach you.`,
            action: ACTION,
          },
        ];
      }
      if (last.ok) return [{ ok: true, fixed: 'Notifications are reaching you again', facts: { at: last.at, event: last.event } }];
      const why = [last.status === null ? null : `it answered ${last.status}`, last.error].filter(Boolean).join(': ');
      return [
        {
          ok: false,
          severity: 'warning',
          title: `The last notification did not reach ${WHERE[transport.kind]}`,
          detail: `${why ? `${why[0]!.toUpperCase()}${why.slice(1)}. ` : ''}Check where notifications go and press Send a test. Until one gets through, a question or a waiting merge may not reach you.`,
          action: ACTION,
          facts: { at: last.at, event: last.event, status: last.status },
        },
      ];
    },
  };
}
