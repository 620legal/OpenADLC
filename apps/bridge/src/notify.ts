import { recordEvent } from '@fleetadlc/db';
import type { BridgeConfig } from './config.js';

/**
 * Tells a person that a bot is waiting on them.
 *
 * Nothing notified anyone: a gate was a GitHub comment and a console row, so a
 * task could sit paused until somebody happened to look at the board. Three
 * things are worth interrupting someone for — a gate opened (`gate_opened`),
 * the month's spend reached its warning (`cap_warning`), a promote waits for
 * its approval (`promote_waiting`) — and, just as deliberately, nothing else:
 * a platform that notifies on everything is one whose notifications are
 * ignored, including the ones that mattered.
 *
 * And one more, with the same restraint: something only a person can do has
 * gone undone, and it stops work (`check_failing`, from the health checks) —
 * sent when it has lasted five minutes, and again only if it is still there a
 * day later. Its all-clear (`check_fixed`) goes only to somebody who was told
 * it was broken.
 */
export const NOTIFIABLE = [
  'gate_opened',
  'cap_warning',
  'promote_waiting',
  'check_failing',
  'check_fixed',
] as const;
export type NotifiableEvent = (typeof NOTIFIABLE)[number];

export interface Notification {
  event: NotifiableEvent;
  /** Who it is for: a GitHub login, or null for the install's owner. */
  to: string | null;
  text: string;
  /** Where to go to act on it. */
  link: string;
}

/**
 * Whether this is one of those. Everything else is on the board, which is
 * where a person chooses to look rather than being made to.
 */
export function isNotifiable(event: string): event is NotifiableEvent {
  return (NOTIFIABLE as readonly string[]).includes(event);
}

/**
 * A link that opens the work item a notification is about — its request,
 * issue and pull request as one conversation — rather than the panel of the
 * bot that asked, which held every other subject that bot had worked on. Any
 * member's subject opens the same item.
 */
export function itemLink(consoleUrl: string, subject: string): string {
  const base = consoleUrl.replace(/\/+$/, '');
  return `${base}/?${new URLSearchParams({ item: subject }).toString()}`;
}

export class Notifier {
  constructor(private readonly config: BridgeConfig) {}

  /**
   * Sends one, or says what it would have sent.
   *
   * The transport is optional on purpose: a development install has none, and
   * logging the intent keeps the path exercised rather than dormant until the
   * day someone configures it.
   */
  async send(notification: Notification): Promise<'sent' | 'logged' | 'refused'> {
    if (!isNotifiable(notification.event)) {
      console.warn(`[bridge] refusing to notify on ${notification.event}: not one of the things worth interrupting somebody for`);
      return 'refused';
    }

    const to = notification.to ? `@${notification.to}` : 'the owner';

    // Recorded whether or not it is delivered. A notification is a thing the
    // platform decided to do, so it belongs in the event log next to everything
    // else it decided — and that is what makes "one notification, and none on
    // answering" checkable without reading a log file whose path depends on how
    // the install was started.
    await recordEvent({
      source: 'platform',
      type: `notify.${notification.event}`,
      payload: { to: notification.to, link: notification.link, text: notification.text },
    }).catch(() => undefined);

    if (!this.config.notifyWebhook) {
      console.log(`[bridge] would notify ${to}: ${notification.text} — ${notification.link}`);
      return 'logged';
    }

    const body = JSON.stringify({
      text: `${to}: ${notification.text}`,
      link: notification.link,
      event: notification.event,
    });

    return fetch(this.config.notifyWebhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(5000),
    })
      .then((response) => {
        if (response.ok) return 'sent' as const;
        console.warn(`[bridge] the notification transport answered ${response.status}`);
        return 'logged' as const;
      })
      .catch((error: unknown) => {
        // A transport that is down must not stop the platform. The gate is
        // already on GitHub and on the board; the notification is the extra.
        console.warn(`[bridge] could not notify: ${error instanceof Error ? error.message : error}`);
        return 'logged' as const;
      });
  }
}
